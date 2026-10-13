import { canonicalRefNumber } from "../ref-number.js";
import { summarizeEntries } from "./parser.js";
import {
  buildBatchDuplicateKey,
  buildCamtDescriptionWithMetadata,
  buildDuplicateLookup,
  buildPossibleDuplicateLookup,
  findDuplicateTransactionIds,
  findExactKeyOccurrences,
  findPartialLegacyEntries,
  findPossibleDuplicateMatches,
  findRepeatedBankReferences,
  normalizeOptionalReference,
} from "./duplicate-identity.js";
import {
  buildCamtJournalCoverageContext,
  checkCamtDuplicateRegistration,
  classifyCamtJournalCoverage,
  findCamtNativeImportMatch,
  type CamtJournalCoverage,
  type CamtJournalSnapshot,
} from "./journal-coverage.js";
import type {
  CamtCreateDescriptor,
  CamtImportProjection,
  CamtParseResult,
  CamtSkippedRow,
  ClientResolution,
  ClientResolutionCache,
  CreateTransactionPayload,
  ParsedCamtEntry,
  Transaction,
} from "./types.js";

// PURE projection. The ledger transactions are injected as DATA; client
// resolution and progress reporting are injected as narrow ports so the I/O
// (api.transactions.listAll, client lookups, progress) lives in the
// operation/adapter layer, never here. No MCP, HTTP, filesystem, audit, or
// environment module is imported.

export function enrichWithDuplicates(
  parsed: CamtParseResult,
  ledgerTransactions: Transaction[],
  selectedDimensionId: number,
): CamtParseResult {
  const duplicateLookup = buildDuplicateLookup(ledgerTransactions, selectedDimensionId);
  const repeatedBankReferences = findRepeatedBankReferences(parsed.entries);
  const exactKeyOccurrences = findExactKeyOccurrences(parsed.entries, selectedDimensionId);
  const entries = parsed.entries.map(entry => {
    const duplicateIds = findDuplicateTransactionIds(
      entry,
      duplicateLookup,
      repeatedBankReferences,
      selectedDimensionId,
      exactKeyOccurrences.get(buildBatchDuplicateKey(entry)),
    );
    return {
      ...entry,
      duplicate: duplicateIds.length > 0,
      duplicate_transaction_ids: duplicateIds,
    };
  });

  return {
    ...parsed,
    entries,
    summary: summarizeEntries(entries),
  };
}

const CAMT_DUPLICATE_JOURNAL_CONFLICT = "camt_duplicate_journal_conflict";
const CAMT_NATIVE_IMPORT_MATCH = "camt_native_import_match";
const CAMT_PARTIAL_LEGACY_REASON = "Partially imported by a previous release; needs review";

function journalCoverageSkip(entry: ParsedCamtEntry, coverage: Exclude<CamtJournalCoverage, { kind: "none" }>): CamtSkippedRow {
  const ids = coverage.journal_ids.join(", ");
  const base = {
    date: entry.date,
    amount: entry.amount,
    bank_reference: entry.bank_reference,
    duplicate_transaction_ids: [],
    journal_ids: coverage.journal_ids,
  };
  if (coverage.kind !== "review") {
    return { ...base, reason: `Already booked by journal ${ids}` };
  }
  if (coverage.code === "camt_journal_direction_conflict") {
    // Not "may already book it": the stored row's journal books the opposite
    // direction, so the ledger is wrong now and needs correcting.
    return {
      ...base,
      reason: "An existing confirmed transaction's journal books this movement in the opposite direction; needs correction",
      review_code: coverage.code,
      review_note: `The ${entry.amount} ${entry.currency} ${entry.direction} row on ${entry.date} matches a confirmed transaction whose registration ` +
        `journal${coverage.journal_ids.length === 1 ? "" : "s"} ${ids} book${coverage.journal_ids.length === 1 ? "s" : ""} it in the opposite direction ` +
        `(${coverage.code}): that row is booked wrongly. It was not created; correct the existing transaction: invalidate it, ` +
        "delete it and re-import this statement entry (re-confirming the old row can book the wrong direction again), after the owner approves.",
    };
  }
  return {
    ...base,
    reason: "An existing journal may already book this movement; needs review",
    review_code: coverage.code,
    review_note: `The ${entry.amount} ${entry.currency} ${entry.direction} row on ${entry.date} may already be booked by ` +
      `journal${coverage.journal_ids.length === 1 ? "" : "s"} ${ids || "(unidentified own transfer)"} (${coverage.code}). ` +
      "It was not created; check the journal and create the transaction manually only if the movement is not booked yet.",
  };
}

/**
 * A skipped row left unimported because an existing journal may already book
 * it (or books it wrongly). The single definition every CAMT summary counts by.
 */
export function isCamtJournalReviewRow(row: CamtSkippedRow): boolean {
  return row.review_code !== undefined;
}

export interface CamtProjectionInput {
  readonly loaded: CamtParseResult;
  readonly accountsDimensionsId: number;
  readonly dateFrom: string | undefined;
  readonly dateTo: string | undefined;
  /** Non-void ledger transactions, already fetched by the operation layer. */
  readonly ledgerTransactions: Transaction[];
  /** Journals that may already book a statement entry. Required: an
   * unavailable snapshot refuses the import upstream, never reads as empty. */
  readonly journalCoverage: CamtJournalSnapshot;
  /** Injected client resolver; the api + cache live in the operation layer. */
  readonly resolveClient: (entry: ParsedCamtEntry, cache: ClientResolutionCache) => Promise<ClientResolution>;
  /** Injected progress reporter; the transport lives in the operation layer. */
  readonly reportProgress: (index: number, total: number) => Promise<void>;
}

export async function computeCamtImportProjection(input: CamtProjectionInput): Promise<CamtImportProjection> {
  const { loaded, accountsDimensionsId, dateFrom, dateTo, ledgerTransactions, resolveClient, reportProgress } = input;
  const parsed = enrichWithDuplicates(loaded, ledgerTransactions, accountsDimensionsId);
  const journalCoverage = buildCamtJournalCoverageContext({
    snapshot: input.journalCoverage,
    dimensionId: accountsDimensionsId,
    entries: parsed.entries,
    ledgerTransactions,
  });
  const existingTransactions = ledgerTransactions;
  const filteredEntries = parsed.entries.filter(entry => {
    if (dateFrom && entry.date < dateFrom) return false;
    if (dateTo && entry.date > dateTo) return false;
    return true;
  });
  const repeatedBankReferences = findRepeatedBankReferences(parsed.entries);
  const seenBatchDuplicateKeys = new Set(
    filteredEntries.filter(entry => entry.duplicate).map(entry => buildBatchDuplicateKey(entry)),
  );
  const refLessOccurrences = new Map<string, number>();
  const clientCache: ClientResolutionCache = { byCode: new Map(), byName: new Map() };
  const possibleDuplicateLookup = buildPossibleDuplicateLookup(existingTransactions, accountsDimensionsId);
  const partialLegacyEntries = findPartialLegacyEntries(
    parsed.entries,
    buildDuplicateLookup(existingTransactions, accountsDimensionsId),
    accountsDimensionsId,
  );
  const descriptors: CamtCreateDescriptor[] = [];
  const skipped: CamtSkippedRow[] = [];

  for (let index = 0; index < filteredEntries.length; index++) {
    const entry = filteredEntries[index]!;
    await reportProgress(index, filteredEntries.length);
    const batchDuplicateKey = buildBatchDuplicateKey(entry);

    if (partialLegacyEntries.has(entry)) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: entry.duplicate_transaction_ids,
        reason: CAMT_PARTIAL_LEGACY_REASON,
        review_note: `The ${entry.amount} ${entry.currency} ${entry.direction} row on ${entry.date} belongs to a statement entry a previous release imported only in part: some of its old per-leg rows are in the ledger, others are not. It was not created; compare the ledger with the statement entry and book the missing amount manually.`,
      });
      continue;
    }
    if (entry.duplicate) {
      // A matched confirmed row is a plain duplicate only when its registration
      // journal books this movement; otherwise surface it, never create it.
      const registration = checkCamtDuplicateRegistration(entry, journalCoverage);
      if (registration.kind === "conflict") {
        const ids = registration.journal_ids.join(", ");
        const rows = entry.duplicate_transaction_ids.join(", ");
        skipped.push({
          date: entry.date,
          amount: entry.amount,
          bank_reference: entry.bank_reference,
          duplicate_transaction_ids: entry.duplicate_transaction_ids,
          journal_ids: registration.journal_ids,
          reason: "Existing transaction matched, but its registration journal does not book this movement; needs review",
          review_code: CAMT_DUPLICATE_JOURNAL_CONFLICT,
          review_note: `The ${entry.amount} ${entry.currency} ${entry.direction} row on ${entry.date} is already in the ledger as ` +
            `transaction ${rows}, but ` +
            (registration.missing_transaction_ids.length > 0
              ? `transaction ${registration.missing_transaction_ids.join(", ")} has no registered journal${ids ? ` and journal ${ids} does not match` : ""}. `
              : `its registration journal ${ids} does not book ${entry.amount} ${entry.currency} ${entry.direction === "CRDT" ? "into" : "out of"} this bank account (wrong direction or amount). `) +
            "It was not created again; correct the existing transaction: invalidate it, delete it and re-import this statement entry " +
            "(re-confirming the old row can book the wrong direction again), after the owner approves.",
        });
        continue;
      }
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: entry.duplicate_transaction_ids,
        reason: "Existing transaction matched by bank reference",
      });
      continue;
    }
    // An entry WITH a bank reference (AcctSvcrRef) repeated in the file is the
    // same bank entry listed twice. A ref-less entry has no identity beyond its
    // content, so two identical ones are two genuine payments until proven
    // otherwise: count them (cardinality) instead of collapsing them, and let
    // the ledger comparison below decide which copies are possible duplicates.
    const hasBankReference = normalizeOptionalReference(entry.bank_reference) !== undefined;
    let refLessOccurrence = 1;
    if (!hasBankReference) {
      refLessOccurrence = (refLessOccurrences.get(batchDuplicateKey) ?? 0) + 1;
      refLessOccurrences.set(batchDuplicateKey, refLessOccurrence);
    }
    if (hasBankReference && seenBatchDuplicateKeys.has(batchDuplicateKey)) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: [],
        reason: "Duplicate CAMT entry inside current import batch",
      });
      continue;
    }
    const coverage = classifyCamtJournalCoverage(entry, journalCoverage);
    // A row e-arveldaja's own bank import created reads back with no bank
    // reference; its registration journal is then the only scan hit.
    const nativeMatch = findCamtNativeImportMatch(entry, coverage, journalCoverage);
    if (nativeMatch) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: [nativeMatch.transaction_id],
        journal_ids: [nativeMatch.journal_id],
        reason: `Already imported by e-arveldaja's bank import as transaction ${nativeMatch.transaction_id} (${CAMT_NATIVE_IMPORT_MATCH})`,
        skip_code: CAMT_NATIVE_IMPORT_MATCH,
      });
      continue;
    }
    if (coverage.kind !== "none") {
      skipped.push(journalCoverageSkip(entry, coverage));
      continue;
    }

    const clientResolution = await resolveClient(entry, clientCache);
    const storedDescription = buildCamtDescriptionWithMetadata(entry.description, entry);
    const ledgerMatches = findPossibleDuplicateMatches(entry, possibleDuplicateLookup);
    // Cardinality: k matching ledger rows can already account for at most the
    // first k in-file copies of a ref-less entry; copies beyond that are new.
    const possibleDuplicateMatches = refLessOccurrence <= ledgerMatches.length
      ? ledgerMatches
      : [];
    const payload: CreateTransactionPayload = {
      accounts_dimensions_id: accountsDimensionsId,
      // API type drives the cash-account leg at confirmation: incoming (CRDT) →
      // "D" (cash debited, "Laekumine"), outgoing (DBIT) → "C" ("Tasumine").
      type: entry.direction === "CRDT" ? "D" : "C",
      amount: entry.amount,
      cl_currencies_id: entry.currency || "EUR",
      date: entry.date,
      description: storedDescription,
      bank_account_name: entry.counterparty_name,
      bank_account_no: entry.counterparty_iban,
      clients_id: clientResolution.clients_id,
      // Canonicalize the reference at source so the write boundary is a no-op
      // (ref already ≤ cap → not truncated → not woven into the description),
      // keeping build-time and verify-time CAMT identities symmetric.
      ref_number: canonicalRefNumber(entry.reference_number).value,
      bank_ref_number: entry.bank_reference,
    };
    descriptors.push({ entry, payload, storedDescription, clientResolution, possibleDuplicateMatches, batchDuplicateKey });
    seenBatchDuplicateKeys.add(batchDuplicateKey);
  }

  return {
    parsed,
    statementMetadata: parsed.statement_metadata,
    descriptors,
    skipped,
    repeatedBankReferences,
    totalStatementEntries: parsed.entries.length,
    eligibleEntries: filteredEntries.length,
    filteredOut: parsed.entries.length - filteredEntries.length,
  };
}
