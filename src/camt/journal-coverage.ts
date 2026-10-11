import { findDuplicatePostingsInJournals } from "../bank-posting-duplicate-guard.js";
import type { InterAccountQuery, InterAccountResolution } from "../booking-guard.js";
import { buildBankAccountLookups, toUtcDay } from "../tools/inter-account-utils.js";
import type { AccountDimension, BankAccount, Journal } from "../types/api.js";
import {
  bankReferenceLookupKey,
  findRepeatedBankReferences,
  journalDocumentReferenceKeys,
  normalizeOptionalReference,
  storedBankReferenceLookupKey,
} from "./duplicate-identity.js";
import type { ParsedCamtEntry, Transaction } from "./types.js";

// PURE: decides whether an existing journal already books a CAMT entry's cash
// movement on the statement's bank dimension. The journals, bank accounts and
// dimensions are injected as data; Lane B runs on a resolver the caller builds
// over the snapshot (BookingGuard.fromSnapshot).

const IDENTITY_WINDOW_DAYS = 3;
const LANE_B_WINDOW_DAYS = 1;
const POSTING_SCAN_WINDOW_DAYS = 1;

export type CamtJournalReviewCode =
  | "camt_journal_conflict"
  | "camt_journal_posting_review"
  | "camt_journal_inconsistent_amounts"
  | "camt_journal_identity_stale";

export type CamtJournalCoverage =
  | { readonly kind: "none" }
  | { readonly kind: "identity" | "inter_account"; readonly journal_ids: number[] }
  | { readonly kind: "review"; readonly code: CamtJournalReviewCode; readonly journal_ids: number[] };

export interface InterAccountResolver {
  resolveInterAccount(q: InterAccountQuery): InterAccountResolution;
  hasOtherLabelledInterAccount(q: InterAccountQuery): boolean;
}

export interface CamtJournalSnapshot {
  readonly journals: readonly Journal[];
  /** The statement dimension's resolved `accounts_id` (never assumed to be 1020). */
  readonly accountId: number;
  readonly bankAccounts: readonly BankAccount[];
  readonly accountDimensions: readonly AccountDimension[];
  readonly interAccountResolver: (journals: Journal[], ownDimensionIds: Set<number>) => InterAccountResolver;
}

export interface CamtJournalCoverageInput {
  readonly snapshot: CamtJournalSnapshot;
  readonly dimensionId: number;
  /** Every statement entry, already enriched with its transaction duplicates. */
  readonly entries: readonly ParsedCamtEntry[];
  readonly ledgerTransactions: readonly Transaction[];
  /** Per entry: the stored lookup key when its marker kept only the reference hash. */
  readonly entryReferenceKeys?: ReadonlyArray<string | undefined>;
}

export interface CamtJournalCoverageContext {
  readonly accountId: number;
  readonly dimensionId: number;
  readonly journals: Journal[];
  readonly journalsById: Map<number, Journal>;
  readonly sameDimensionTransactions: Map<number, Transaction>;
  readonly repeatedBankReferences: Set<string>;
  /** Journal id → distinct statement reference keys its document number matches. */
  readonly identityClaims: Map<number, Set<string>>;
  readonly ownIbanToDimension: Map<string, Set<number>>;
  readonly laneB: InterAccountResolver;
}

const REVIEW_PRIORITY: CamtJournalReviewCode[] = [
  "camt_journal_inconsistent_amounts",
  "camt_journal_identity_stale",
  "camt_journal_conflict",
];

const cents = (value: number) => Math.round(value * 100);

export function buildCamtJournalCoverageContext(input: CamtJournalCoverageInput): CamtJournalCoverageContext {
  const { snapshot, dimensionId, entries, ledgerTransactions, entryReferenceKeys } = input;
  // A same-dimension TRANSACTION journal books a statement entry the
  // transaction dedup already matched; only those are excluded. Any other
  // same-dimension transaction journal stays in the scan.
  // A journal whose document reference is not the matched entry's own is
  // kept, so the identity channel can report the contradiction.
  const matchedEntryKeys = new Map<number, Set<string | undefined>>();
  for (const entry of entries) {
    for (const id of entry.duplicate_transaction_ids) {
      const keys = matchedEntryKeys.get(id) ?? new Set<string | undefined>();
      keys.add(bankReferenceLookupKey(entry.bank_reference));
      matchedEntryKeys.set(id, keys);
    }
  }
  const journals = snapshot.journals.filter((journal) => {
    if (journal.id == null || journal.is_deleted) return false;
    const matchedKeys = journal.operation_type === "TRANSACTION" && journal.operations_id != null
      ? matchedEntryKeys.get(journal.operations_id)
      : undefined;
    if (!matchedKeys) return true;
    const documentKeys = journalDocumentReferenceKeys(journal.document_number);
    return documentKeys.length > 0 && !documentKeys.some((key) => matchedKeys.has(key));
  });
  const statementReferenceKeys = new Set(entries
    .map((entry) => bankReferenceLookupKey(entry.bank_reference))
    .filter((key): key is string => key !== undefined));
  // One journal books one movement: a journal whose document reference
  // aliases two different statement references can cover neither.
  const identityClaims = new Map<number, Set<string>>();
  for (const journal of journals) {
    const documentKeys = journalDocumentReferenceKeys(journal.document_number);
    for (const [index, entry] of entries.entries()) {
      // Distinct references have distinct keys, so a hash-only entry competes too.
      const key = bankReferenceLookupKey(entry.bank_reference) ?? entryReferenceKeys?.[index];
      if (!key || !documentKeys.includes(key)) continue;
      const claims = identityClaims.get(journal.id!) ?? new Set<string>();
      claims.add(key);
      identityClaims.set(journal.id!, claims);
    }
  }
  // A journal labelled with a statement reference is judged by the identity
  // channel; Lane B would only see it as some other labelled transfer.
  const laneBJournals = journals.filter((journal) =>
    !journalDocumentReferenceKeys(journal.document_number).some((key) => statementReferenceKeys.has(key)));
  const lookups = buildBankAccountLookups([...snapshot.bankAccounts], [...snapshot.accountDimensions]);
  return {
    accountId: snapshot.accountId,
    dimensionId,
    journals,
    journalsById: new Map(journals.map((journal) => [journal.id!, journal])),
    sameDimensionTransactions: new Map(ledgerTransactions
      .filter((transaction) => transaction.accounts_dimensions_id === dimensionId && transaction.id)
      .map((transaction) => [transaction.id!, transaction])),
    repeatedBankReferences: findRepeatedBankReferences([...entries]),
    identityClaims,
    ownIbanToDimension: lookups.ownIbanToDimension,
    laneB: snapshot.interAccountResolver(laneBJournals, lookups.ownDimensionIds),
  };
}

/** Signed EUR net (cents) the journal posts on the bank account + dimension, or undefined when inconsistent. */
function bankNetCents(journal: Journal, context: CamtJournalCoverageContext): number | undefined {
  let net = 0;
  for (const posting of journal.postings ?? []) {
    if (posting.is_deleted || posting.accounts_id !== context.accountId || posting.accounts_dimensions_id !== context.dimensionId) continue;
    const base = posting.base_amount ?? posting.amount;
    if ((posting.cl_currencies_id ?? "EUR") !== "EUR" || cents(base) !== cents(posting.amount)) return undefined;
    if (posting.type === "D") net += cents(base);
    else if (posting.type === "C") net -= cents(base);
    else return undefined;
  }
  return net;
}

/** A same-dimension transaction journal whose source transaction carries another bank reference. */
function contradictsSourceTransaction(journal: Journal, entryKey: string | undefined, context: CamtJournalCoverageContext): boolean {
  if (!entryKey || journal.operation_type !== "TRANSACTION" || journal.operations_id == null) return false;
  const source = context.sameDimensionTransactions.get(journal.operations_id);
  const sourceKey = source ? storedBankReferenceLookupKey(source) : undefined;
  return sourceKey !== undefined && sourceKey !== entryKey;
}

export function classifyCamtJournalCoverage(
  entry: ParsedCamtEntry,
  context: CamtJournalCoverageContext,
  /** Stored lookup key for a row whose marker kept only the reference hash. */
  referenceKey?: string,
): CamtJournalCoverage {
  if ((entry.currency || "EUR") !== "EUR") return { kind: "none" };
  const expectedNet = (entry.direction === "CRDT" ? 1 : -1) * cents(entry.amount);
  const entryKey = bankReferenceLookupKey(entry.bank_reference) ?? referenceKey;
  const covering = new Map<number, "identity" | "inter_account">();
  const reviews = new Map<CamtJournalReviewCode, Set<number>>();
  const review = (code: CamtJournalReviewCode, journalId?: number) => {
    const ids = reviews.get(code) ?? new Set<number>();
    if (journalId !== undefined && journalId > 0) ids.add(journalId);
    reviews.set(code, ids);
  };
  const covers = (journal: Journal) => bankNetCents(journal, context) === expectedNet &&
    !contradictsSourceTransaction(journal, entryKey, context);

  // a) Identity: the journal's document number carries this entry's bank reference.
  if (entryKey) {
    const reference = normalizeOptionalReference(entry.bank_reference)!;
    for (const journal of context.journals) {
      if (!journalDocumentReferenceKeys(journal.document_number).includes(entryKey)) continue;
      const id = journal.id!;
      if (
        context.repeatedBankReferences.has(reference) ||
        (context.identityClaims.get(id)?.size ?? 0) > 1 ||
        journal.registered !== true
      ) review("camt_journal_conflict", id);
      else if (bankNetCents(journal, context) === undefined) review("camt_journal_inconsistent_amounts", id);
      else if (Math.abs(toUtcDay(journal.effective_date) - toUtcDay(entry.date)) > IDENTITY_WINDOW_DAYS * 86_400_000) {
        review("camt_journal_identity_stale", id);
      } else if (!covers(journal)) review("camt_journal_conflict", id);
      else covering.set(id, "identity");
    }
  }

  // b) Lane B: an own transfer to/from exactly one other own bank dimension.
  const iban = entry.counterparty_iban?.replace(/\s+/g, "").toUpperCase();
  const otherDimensions = [...(iban ? context.ownIbanToDimension.get(iban) ?? [] : [])]
    .filter((dimension) => dimension !== context.dimensionId);
  if (otherDimensions.length === 1) {
    const query: InterAccountQuery = {
      sourceDim: context.dimensionId,
      targetDim: otherDimensions[0]!,
      amount: entry.amount,
      date: entry.date,
      maxGapDays: LANE_B_WINDOW_DAYS,
      reference: entry.bank_reference ?? null,
    };
    const resolution = context.laneB.resolveInterAccount(query);
    if (resolution.status === "matched") {
      const journal = context.journalsById.get(resolution.journal_id);
      if (journal && bankNetCents(journal, context) === undefined) review("camt_journal_inconsistent_amounts", resolution.journal_id);
      else if (journal && covers(journal)) covering.set(resolution.journal_id, covering.get(resolution.journal_id) ?? "inter_account");
      else review("camt_journal_conflict", resolution.journal_id);
    } else if (resolution.status === "ambiguous_refless" || context.laneB.hasOtherLabelledInterAccount(query)) {
      review("camt_journal_conflict");
    }
  }

  // c) Posting scan: any other same-direction, same-amount posting on this dimension.
  const known = new Set([...covering.keys(), ...[...reviews.values()].flatMap((ids) => [...ids])]);
  const scanIds = [...new Set(findDuplicatePostingsInJournals(context.journals, {
    accountId: context.accountId,
    dimensionId: context.dimensionId,
    amount: entry.amount,
    direction: entry.direction === "CRDT" ? "D" : "C",
    date: entry.date,
    excludeJournalIds: known,
  }, { windowDays: POSTING_SCAN_WINDOW_DAYS }).map((suspect) => suspect.journal_id))];

  const journalIds = [...new Set([...known, ...scanIds])].sort((left, right) => left - right);
  const reviewCode = REVIEW_PRIORITY.find((code) => reviews.has(code));
  if (reviewCode) return { kind: "review", code: reviewCode, journal_ids: journalIds };
  if (covering.size > 1 || (covering.size === 1 && scanIds.length > 0)) {
    return { kind: "review", code: "camt_journal_conflict", journal_ids: journalIds };
  }
  const [only] = [...covering];
  if (only) return { kind: only[1], journal_ids: [only[0]] };
  if (scanIds.length > 0) return { kind: "review", code: "camt_journal_posting_review", journal_ids: journalIds };
  return { kind: "none" };
}
