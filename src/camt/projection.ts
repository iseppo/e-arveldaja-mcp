import { canonicalRefNumber } from "../ref-number.js";
import { summarizeEntries } from "./parser.js";
import {
  buildBatchDuplicateKey,
  buildCamtDescriptionWithMetadata,
  buildDuplicateLookup,
  buildPossibleDuplicateLookup,
  findDuplicateTransactionIds,
  findPossibleDuplicateMatches,
  findRepeatedBankReferences,
} from "./duplicate-identity.js";
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
  const entries = parsed.entries.map(entry => {
    const duplicateIds = findDuplicateTransactionIds(
      entry,
      duplicateLookup,
      repeatedBankReferences,
      selectedDimensionId,
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

export interface CamtProjectionInput {
  readonly loaded: CamtParseResult;
  readonly accountsDimensionsId: number;
  readonly dateFrom: string | undefined;
  readonly dateTo: string | undefined;
  /** Non-void ledger transactions, already fetched by the operation layer. */
  readonly ledgerTransactions: Transaction[];
  /** Injected client resolver; the api + cache live in the operation layer. */
  readonly resolveClient: (entry: ParsedCamtEntry, cache: ClientResolutionCache) => Promise<ClientResolution>;
  /** Injected progress reporter; the transport lives in the operation layer. */
  readonly reportProgress: (index: number, total: number) => Promise<void>;
}

export async function computeCamtImportProjection(input: CamtProjectionInput): Promise<CamtImportProjection> {
  const { loaded, accountsDimensionsId, dateFrom, dateTo, ledgerTransactions, resolveClient, reportProgress } = input;
  const parsed = enrichWithDuplicates(loaded, ledgerTransactions, accountsDimensionsId);
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
  const clientCache: ClientResolutionCache = { byCode: new Map(), byName: new Map() };
  const possibleDuplicateLookup = buildPossibleDuplicateLookup(existingTransactions, accountsDimensionsId);
  const descriptors: CamtCreateDescriptor[] = [];
  const skipped: CamtSkippedRow[] = [];

  for (let index = 0; index < filteredEntries.length; index++) {
    const entry = filteredEntries[index]!;
    await reportProgress(index, filteredEntries.length);
    const batchDuplicateKey = buildBatchDuplicateKey(entry);

    if (entry.duplicate) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: entry.duplicate_transaction_ids,
        reason: "Existing transaction matched by bank reference",
      });
      continue;
    }
    if (seenBatchDuplicateKeys.has(batchDuplicateKey)) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: [],
        reason: "Duplicate CAMT entry inside current import batch",
      });
      continue;
    }

    const clientResolution = await resolveClient(entry, clientCache);
    const storedDescription = buildCamtDescriptionWithMetadata(entry.description, entry);
    const possibleDuplicateMatches = findPossibleDuplicateMatches(entry, possibleDuplicateLookup);
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
