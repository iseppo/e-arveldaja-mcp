import { canonicalRefNumber } from "../ref-number.js";
import { normalizeIban } from "../resolution/bank-account-resolution.js";
import { summarizeEntries } from "./parser.js";
import {
  buildBatchDuplicateKey,
  buildDuplicateLookup,
  buildPossibleDuplicateLookup,
  camtMovementIdentity,
  findDuplicateTransactionIds,
  findExactKeyOccurrences,
  findLossyIdentityConflicts,
  findPartialLegacyEntries,
  findPoisonedMarkerHolds,
  findPossibleDuplicateMatches,
  findRepeatedBankReferences,
  normalizeOptionalReference,
  renderCamtDescriptionDetailed,
} from "./duplicate-identity.js";
import { camtIbanOmissionEvidence, isCamtIbanOmissionEligible } from "./iban-omission.js";
import {
  buildCamtJournalCoverageContext,
  checkCamtDuplicateRegistration,
  classifyCamtJournalCoverage,
  findCamtNativeImportMatch,
  journalBooksEntryExactly,
  type CamtJournalCoverage,
  type CamtJournalSnapshot,
} from "./journal-coverage.js";
import {
  CAMT_REVIEW_ACKNOWLEDGED,
  camtReviewAcknowledgementKey,
  findClaimingAcknowledgement,
  isAcknowledgeableCamtReviewCode,
  type CamtAckRefusalCode,
  type CamtReviewAcknowledgementRecord,
} from "./review-acknowledgement.js";
import type {
  CamtCreateDescriptor,
  CamtImportProjection,
  CamtInterAccountTransferTag,
  CamtParseResult,
  CamtSkipInterAccountLegs,
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

function enrichWithDuplicates(
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
export const CAMT_MARKER_IDENTITY_UNFIT = "camt_marker_identity_unfit";
export const CAMT_MARKER_CONFLICT_REVIEW = "camt_marker_conflict_review";
export const CAMT_LOSSY_IDENTITY_AMBIGUOUS = "camt_lossy_identity_ambiguous";
/** Skip codes of rows held for review: neither created nor skipped as duplicates. */
export const CAMT_HOLD_SKIP_CODES: readonly string[] = [
  CAMT_MARKER_IDENTITY_UNFIT,
  CAMT_MARKER_CONFLICT_REVIEW,
  CAMT_LOSSY_IDENTITY_AMBIGUOUS,
];

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
      movement_identity: camtMovementIdentity(entry),
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
    movement_identity: camtMovementIdentity(entry),
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

interface CamtProjectionInput {
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
  /** This connection's stored journal-review acknowledgements (#10b), read by the operation layer. */
  readonly reviewAcknowledgements?: readonly CamtReviewAcknowledgementRecord[];
  /** #11: leave out own-account transfer legs of this direction (default "none"). */
  readonly skipInterAccountLegs?: CamtSkipInterAccountLegs;
  /**
   * B3b: occurrences of a movement identity in the OTHER statements an inbox
   * scan retained for this connection. Absent when no scan in this process
   * retained this statement: then no acknowledgement applies (fail closed).
   */
  readonly otherStatementOccurrences?: (movementIdentity: string) => number;
  /** SHA-256 of the statement file; bound into each acknowledgement candidate. */
  readonly statementDigest?: string;
}

export const CAMT_INTER_ACCOUNT_OTHER_SIDE_KEPT = "inter_account_other_side_kept";

/** The one other own bank dimension the counterparty IBAN belongs to, if exactly one. */
function interAccountTransferTag(
  entry: ParsedCamtEntry,
  ownIbanToDimension: ReadonlyMap<string, ReadonlySet<number>>,
  dimensionId: number,
): CamtInterAccountTransferTag | undefined {
  const iban = normalizeIban(entry.counterparty_iban);
  const others = [...(iban ? ownIbanToDimension.get(iban) ?? [] : [])].filter(dimension => dimension !== dimensionId);
  return others.length === 1 ? { counterparty_dimension_id: others[0]! } : undefined;
}

/**
 * #10(b): give each acknowledgeable journal review its acknowledgement
 * candidate, and quiet the ones whose full key a stored acknowledgement
 * matches. The statement must have been retained by an inbox scan in this
 * process and a movement must occur once in it and the other retained
 * statements of the inbox (B3b), the review must name
 * exactly one journal that moves exactly the row's signed EUR cents, and no
 * other row (or another movement's acknowledgement) may name that journal;
 * otherwise the candidate is refused and any stored acknowledgement ignored.
 */
function applyReviewAcknowledgements(
  skipped: CamtSkippedRow[],
  pending: ReadonlyMap<CamtSkippedRow, { entry: ParsedCamtEntry; booksExactly: boolean }>,
  entries: readonly ParsedCamtEntry[],
  accountsDimensionsId: number,
  records: readonly CamtReviewAcknowledgementRecord[],
  otherStatementOccurrences: ((movementIdentity: string) => number) | undefined,
  statementDigest: string | undefined,
): void {
  const occurrences = new Map<string, number>();
  for (const entry of entries) {
    const identity = camtMovementIdentity(entry);
    occurrences.set(identity, (occurrences.get(identity) ?? 0) + 1);
  }
  const journalRows = new Map<number, number>();
  for (const row of skipped) {
    for (const id of new Set(row.journal_ids ?? [])) journalRows.set(id, (journalRows.get(id) ?? 0) + 1);
  }
  const stored = new Set(records.map(camtReviewAcknowledgementKey));
  skipped.forEach((row, index) => {
    const source = pending.get(row);
    if (!source || !isAcknowledgeableCamtReviewCode(row.review_code) || row.movement_identity === undefined) return;
    const journalIds = [...row.journal_ids ?? []].sort((left, right) => left - right);
    const key = { accounts_dimensions_id: accountsDimensionsId, movement_identity: row.movement_identity, review_code: row.review_code, journal_ids: journalIds };
    let refused: CamtAckRefusalCode | undefined;
    if (journalIds.length !== 1) refused = "camt_ack_multiple_candidates";
    else if (occurrences.get(row.movement_identity) !== 1 || (otherStatementOccurrences?.(row.movement_identity) ?? 0) > 0) refused = "camt_ack_nonunique_movement";
    else if (!source.booksExactly) refused = "camt_ack_journal_mismatch";
    else if ((journalRows.get(journalIds[0]!) ?? 0) > 1 || findClaimingAcknowledgement(records, key)) refused = "camt_ack_journal_already_claimed";
    else if (otherStatementOccurrences === undefined) refused = "camt_ack_needs_inbox_scan";
    if (refused === undefined && stored.has(camtReviewAcknowledgementKey(key))) {
      skipped[index] = {
        date: row.date,
        amount: row.amount,
        bank_reference: row.bank_reference,
        duplicate_transaction_ids: [],
        journal_ids: journalIds,
        reason: `Checked earlier: journal ${journalIds[0]} books this movement (acknowledged ${row.review_code})`,
        skip_code: CAMT_REVIEW_ACKNOWLEDGED,
        movement_identity: row.movement_identity,
        acknowledged_review: { review_code: row.review_code, journal_ids: journalIds },
      };
      return;
    }
    if (refused === "camt_ack_needs_inbox_scan" && stored.has(camtReviewAcknowledgementKey(key))) {
      row.reason = `${row.reason} — checked earlier, but that check applies only after an inbox scan has compared this statement with the other statements; run an inbox scan first`;
    }
    row.acknowledgement = {
      ...key,
      date: source.entry.date,
      amount: source.entry.amount,
      direction: source.entry.direction,
      ...(statementDigest !== undefined ? { statement_digest: statementDigest } : {}),
      ...(refused !== undefined ? { refused } : {}),
    };
  });
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
  const duplicateLookup = buildDuplicateLookup(existingTransactions, accountsDimensionsId);
  const partialLegacyEntries = findPartialLegacyEntries(parsed.entries, duplicateLookup, accountsDimensionsId);
  const lossyIdentityConflicts = findLossyIdentityConflicts(parsed.entries, duplicateLookup, accountsDimensionsId);
  // Computed once per import: may a counterparty IBAN be left out of the marker?
  const ibanOmissionEvidence = camtIbanOmissionEvidence(input.journalCoverage.bankAccounts, parsed.statement_metadata.iban);
  const descriptors: CamtCreateDescriptor[] = [];
  const skipped: CamtSkippedRow[] = [];
  const acknowledgeable = new Map<CamtSkippedRow, { entry: ParsedCamtEntry; booksExactly: boolean }>();

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
        movement_identity: camtMovementIdentity(entry),
        review_note: `The ${entry.amount} ${entry.currency} ${entry.direction} row on ${entry.date} belongs to a statement entry a previous release imported only in part: some of its old per-leg rows are in the ledger, others are not. It was not created; compare the ledger with the statement entry and book the missing amount manually.`,
      });
      continue;
    }
    // Before the duplicate check: a lossy key shared by competing entries is
    // no evidence either way.
    if (lossyIdentityConflicts.has(batchDuplicateKey)) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: [],
        reason: "A stored row with a shortened description, a left-out IBAN or a left-out counterparty name cannot be told apart from another statement entry; " +
          "not created and not skipped as a duplicate. Compare the ledger with the bank statement and create the row manually only if it is missing.",
        skip_code: CAMT_LOSSY_IDENTITY_AMBIGUOUS,
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
          movement_identity: camtMovementIdentity(entry),
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
    // A stored row whose CAMT marker contradicts itself is never duplicate
    // evidence; when it may be this entry, hold instead of creating.
    const poisonedHolds = findPoisonedMarkerHolds(entry, duplicateLookup);
    if (poisonedHolds.length > 0) {
      const ids = poisonedHolds.map(row => row.id!).sort((left, right) => left - right);
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: ids,
        reason: `Existing transaction ${ids.join(", ")} carries a contradictory CAMT marker and may be this entry; not created. ` +
          "Check it against the bank statement, correct or delete it (after owner approval), then re-run the preview.",
        skip_code: CAMT_MARKER_CONFLICT_REVIEW,
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
      const row = journalCoverageSkip(entry, coverage);
      if (coverage.kind === "review" && isAcknowledgeableCamtReviewCode(coverage.code)) {
        acknowledgeable.set(row, {
          entry,
          booksExactly: coverage.journal_ids.length === 1 && journalBooksEntryExactly(coverage.journal_ids[0]!, entry, journalCoverage),
        });
      }
      skipped.push(row);
      continue;
    }

    // #11: the other account's statement books this own transfer; leave this leg out.
    const interAccountTransfer = interAccountTransferTag(entry, journalCoverage.ownIbanToDimension, accountsDimensionsId);
    const skipLegs = input.skipInterAccountLegs ?? "none";
    if (interAccountTransfer && skipLegs !== "none" && (entry.direction === "DBIT") === (skipLegs === "outgoing")) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: [],
        reason: `Own-account transfer ${entry.direction === "DBIT" ? "out to" : "in from"} bank dimension ${interAccountTransfer.counterparty_dimension_id} left out: ` +
          "the other account's statement books it (skip_inter_account_legs). Import that statement too, or the transfer stays unbooked.",
        skip_code: CAMT_INTER_ACCOUNT_OTHER_SIDE_KEPT,
        inter_account_transfer: interAccountTransfer,
      });
      continue;
    }

    const rendering = renderCamtDescriptionDetailed(entry.description, entry, {
      omitCounterpartyIban: isCamtIbanOmissionEligible(ibanOmissionEvidence, entry.counterparty_iban),
    });
    if (rendering.held) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: [],
        reason: "The bank reference and counterparty account are too long to store with a verifiable import marker; not created. " +
          "Book this payment by hand from the bank statement.",
        skip_code: CAMT_MARKER_IDENTITY_UNFIT,
      });
      continue;
    }
    const clientResolution = await resolveClient(entry, clientCache);
    const storedDescription = rendering.description;
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
    descriptors.push({
      entry, payload, storedDescription, clientResolution, possibleDuplicateMatches, batchDuplicateKey,
      ...(rendering.truncated ? { description_truncated: rendering.truncated } : {}),
      ...(rendering.ibanOmitted ? { counterparty_iban_omitted: true as const } : {}),
      ...(interAccountTransfer ? { inter_account_transfer: interAccountTransfer } : {}),
    });
    seenBatchDuplicateKeys.add(batchDuplicateKey);
  }

  applyReviewAcknowledgements(skipped, acknowledgeable, parsed.entries, accountsDimensionsId, input.reviewAcknowledgements ?? [], input.otherStatementOccurrences, input.statementDigest);

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
