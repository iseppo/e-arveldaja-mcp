import { plainFailureOutcome as fail, plainSuccessOutcome as ok, type OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { isCompanyVatRegistered, safeJsonParse, tagNotes } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { ExecutionPlanInput, PlanData, PlanRecord } from "../plan-store.js";
import { canonicalPlanJson, stripUndefinedDeep } from "../tools/camt-plan.js";
import type { Client, CreatePurchaseInvoiceData, PurchaseInvoice, PurchaseInvoiceItem, Transaction } from "../types/api.js";
import { roundMoney } from "../money.js";
import { snapshotBankTransaction, compareBankTransactionMaterial, snapshotLinkedInvoice, TransactionMaterialDriftError } from "../banking/transaction-material-snapshot.js";
import { withPurchaseInvoiceLock, scanPurchaseIntakeDuplicates } from "../documents/purchase-invoice-lock.js";
import { draftFingerprint, draftReadbackMismatches } from "../documents/purchase-draft-verification.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";
import { reportProgress } from "../progress.js";
import { logAudit } from "../audit-log.js";
import { isProjectTransaction } from "../transaction-status.js";
import { signedBankTransactionDirection } from "../bank-transaction-direction.js";
import { isNotFoundHttpError } from "../http-client.js";
import type { AccountDimension, BankAccount, Journal } from "../types/api.js";
import { BookingGuard } from "../booking-guard.js";
import { normalizeCompanyName } from "../company-name.js";
import { buildBankAccountLookups } from "../tools/inter-account-utils.js";
import {
  bankReferenceLookupKey,
  extractCamtDescriptionMetadata,
  legacyTruncatedCamtMarkerHint,
  storedBankReferenceLookupKey,
} from "../camt/duplicate-identity.js";
import { buildCamtJournalCoverageContext, classifyCamtJournalCoverage, type CamtJournalCoverage } from "../camt/journal-coverage.js";
import type { ParsedCamtEntry } from "../camt/types.js";
import {
  counterpartyIbanOf,
  isCamtCounterpartyIbanOmitted,
  hasUnverifiableCamtMarker,
  inferOneSidedTransfer,
  type OneSidedInference,
} from "../banking/reconciliation/inter-account-matcher.js";
import {
  buildCounterpartyBookingHistory,
  lookupCounterpartyHistory,
  type CounterpartyBookingHistory,
  type CounterpartyHistorySuggestion,
} from "./counterparty-booking-history.js";
// canonicalBusinessText strips the display sandbox to recover the EXECUTABLE
// business value (M10). It is NOT wrapUntrustedOcr — the operation never wraps
// for output; the presenter owns all output-time sandboxing. Where the mutation
// loop must embed an untrusted fragment (a remitter-controlled counterparty, an
// upstream error body) into a note, it sandboxes just that span through the
// injected `wrapUntrustedText`, so this module never imports wrapUntrustedOcr.
// Note prose is otherwise server-authored and stays unfenced — a new notes.push
// that interpolates untrusted text must wrap that span itself.
import { canonicalBusinessText } from "../mcp-json.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "../tools/purchase-vat-defaults.js";
import {
  type TransactionClassificationCategory,
  categorizeTransactionGroup,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  getAutoBookedVatConfig,
  getBookingSuggestionVatConfig,
} from "../tools/receipt-extraction.js";
import { buildClassificationReviewGuidance } from "../estonian-accounting-guidance.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
// Shared classify helpers stay in receipt-inbox.ts (several are exported for the
// pure-unit tests). Importing them here forms the same runtime-safe body-only
// import cycle that batch-operations.ts already relies on: every cross-reference
// is used only inside function bodies, never at module-evaluation time.
import {
  type ClassifiedTransactionGroupResult,
  type ClassifiedTransactionSuggestion,
  type PartialClassificationMutation,
  type PartialClassificationStatus,
  type TransactionGroup,
  buildOwnerCounterpartySet,
  existingInvoiceMatch,
  extractClassificationGroups,
  groupTransactionsByCounterparty,
  invoiceClassificationStatus,
  isAmbiguousPostCreateFailure,
  resolveClassificationSuggestion,
  resolveSupplierFromTransaction,
  shouldProcessExpenseAsPurchaseInvoice,
  transactionClassificationStatus,
} from "../tools/receipt-inbox.js";

// Typed classification operations. The interface references NO MCP types — inputs
// and results are plain typed data and the operation returns UNWRAPPED domain
// data. The presenter (./classification-presenter.js) owns ALL wrapUntrustedOcr
// (the analyze double-wrap of counterparty/description and the compact surface)
// plus the workflow / batch-execution envelope builders.
//
// The critical invariants are preserved EXACTLY: classifications_json is a
// pass-through frozen projection (no digest/plan binding); apply re-fetches each
// transaction by id and re-resolves the suggestion server-side; M10 de-sandboxes
// counterparty text with canonicalBusinessText BEFORE it drives rule-matching /
// audit; the three staged mutations (create+set-totals, confirm invoice, confirm
// transaction) stay distinct and guarded; an ambiguous post-create failure is
// surfaced as mutation_indeterminate and NEVER retried; a 404 skips while a
// transient 503/timeout/network is rethrown → group failed.

// P0-2: the execution-plan domain that binds a reviewed dry_run_apply preview to
// its execute_apply. A consumed handle is scope-bound (connection/company/profile)
// and consume-once; the fingerprint below proves the FRESH executable effect
// (which transactions, in which category/apply_mode, resolved to which supplier +
// booking) equals the reviewed one before the first API write.
export const BANK_CLASSIFICATION_PLAN_DOMAIN = "bank_classification";

/** Injected at the MCP boundary so this module never imports wrapUntrustedOcr.
 * Used only to sandbox an OCR-origin error message embedded in a note. */
export type WrapUntrustedText = (text: string | undefined | null) => string | undefined;

export interface UnmatchedAnalysisInput {
  accountsDimensionsId: number;
  dateFrom?: string;
  dateTo?: string;
}

/** A row the ledger context took out of classification. `counterparty` is raw
 * bank-statement text — the presenter wraps it. */
interface PartitionedRowBase {
  transaction_id: number;
  date: string;
  amount: number;
  counterparty?: string;
  next_action: string;
}

/** A journal books this row's bank reference: the PROJECT row is redundant. */
export interface AlreadyBookedRow extends PartitionedRowBase {
  journal_ids: number[];
  strength: "reference";
}

/** A transfer between own accounts; never classified or booked here. */
export interface OwnTransferRow extends PartitionedRowBase {
  /** null: no single own target (shared own IBAN, or a name-only match). */
  target_dimension_id: number | null;
  candidate_dimension_ids?: number[];
  confidence: number;
  reasons: string[];
}

/** Something in the ledger may already book this row; compare before acting. */
export interface PossibleDuplicateRow extends PartitionedRowBase {
  journal_ids: number[];
  code: string;
}

/** UNWRAPPED analysis result. `groups[].{normalized_counterparty,
 * display_counterparty}` and `transactions[].{description,bank_account_name}`
 * carry raw bank-statement text — the presenter wraps them. */
export interface UnmatchedAnalysisResult {
  accountsDimensionsId: number;
  dateFrom?: string;
  dateTo?: string;
  totalUnconfirmed: number;
  /** Rows classified into `groups` (the partitioned rows below are not counted). */
  totalUnmatched: number;
  categoryCounts: Record<string, number>;
  groups: ClassifiedTransactionGroupResult[];
  alreadyBooked: AlreadyBookedRow[];
  ownTransfers: OwnTransferRow[];
  possibleDuplicates: PossibleDuplicateRow[];
  /** alreadyBooked + ownTransfers + possibleDuplicates. */
  totalPartitionedOut: number;
  /** Set when journals/bank accounts could not be read: no partition and no history ran. */
  ledgerContextUnavailable?: string;
}

export interface ApplyClassificationsInput {
  /** The pass-through frozen projection — a string or already-parsed object,
   * exactly as `apply_transaction_classifications` receives it. It is a
   * SELECTION/proposal only: at execute the server re-derives the canonical
   * effect and rejects any material difference vs the reviewed plan as drift. */
  classificationsJson: unknown;
  execute?: boolean;
  /** REQUIRED for execute (execute===true). The consume-once handle minted by
   * the matching dry_run_apply. A missing/replayed/out-of-scope/expired handle
   * fails closed BEFORE any API write. Ignored on dry run. */
  planHandle?: string;
}

export interface ApplyClassificationGroupResult {
  category: TransactionClassificationCategory;
  counterparty: string;
  status: "applied" | "skipped" | "dry_run_preview" | "failed";
  notes: string[];
  transactions: number[];
  created_invoice_ids?: number[];
  linked_transaction_ids?: number[];
  partial_mutations?: PartialClassificationMutation[];
}

export interface ApplyClassificationsResult {
  mode: "DRY_RUN" | "EXECUTED";
  dryRun: boolean;
  summary: { applied: number; skipped: number; dry_run_preview: number; failed: number };
  results: ApplyClassificationGroupResult[];
  /** Minted on dry run only: the consume-once handle the caller must present to
   * execute_apply. Undefined after an execute. */
  planHandle?: string;
}

export interface ClassificationOperations {
  analyzeUnmatched(input: UnmatchedAnalysisInput): Promise<OperationOutcome<UnmatchedAnalysisResult>>;
  applyClassifications(input: ApplyClassificationsInput): Promise<OperationOutcome<ApplyClassificationsResult>>;
}

/** The outcome of the single per-transaction fetch done in the fingerprint pass,
 * reused by the mutation loop so a bookable transaction is fetched exactly once
 * before the post-create freshness re-read. */
type GatherOutcome =
  | { readonly kind: "ok"; readonly transaction: Transaction }
  | { readonly kind: "gone" }
  | { readonly kind: "deleted" }
  | { readonly kind: "confirmed" }
  | { readonly kind: "non_project"; readonly status?: string }
  | { readonly kind: "error"; readonly error: unknown };

// --- F6 ledger context --------------------------------------------------------

interface LedgerContext {
  readonly journals: Journal[];
  readonly bankAccounts: BankAccount[];
  readonly accountDimensions: AccountDimension[];
  readonly companyLegalName: string;
}

interface LedgerPartition {
  alreadyBooked: AlreadyBookedRow[];
  ownTransfers: OwnTransferRow[];
  possibleDuplicates: PossibleDuplicateRow[];
  remaining: Transaction[];
  history: CounterpartyBookingHistory;
}

async function loadLedgerContext(api: ApiContext): Promise<LedgerContext | undefined> {
  try {
    const [journals, bankAccounts, accountDimensions, invoiceInfo] = await Promise.all([
      api.journals.listAllWithPostings(),
      api.readonly.getBankAccounts(),
      api.readonly.getAccountDimensions(),
      api.readonly.getInvoiceInfo(),
    ]);
    return { journals, bankAccounts, accountDimensions, companyLegalName: invoiceInfo.invoice_company_name ?? "" };
  } catch {
    return undefined;
  }
}

/** The direction a row proves: a signed marker whose checksum (when it has one) verifies. */
function trustedDirection(transaction: Transaction): "incoming" | "outgoing" | undefined {
  return hasUnverifiableCamtMarker(transaction) ? undefined : signedBankTransactionDirection(transaction);
}

/** The stored row as a CAMT entry, so WP1's journal-coverage predicate judges it. */
function coverageEntry(transaction: Transaction, direction: ParsedCamtEntry["direction"]): ParsedCamtEntry {
  // The raw reference whose key is the row's stored (checksum-verified) key.
  const key = storedBankReferenceLookupKey(transaction);
  const reference = key === undefined
    ? undefined
    : [transaction.bank_ref_number ?? undefined, extractCamtDescriptionMetadata(transaction.description).bank_ref_number]
      .find(candidate => bankReferenceLookupKey(candidate) === key);
  return {
    date: transaction.date,
    amount: transaction.amount,
    currency: transaction.cl_currencies_id || "EUR",
    direction,
    counterparty_iban: counterpartyIbanOf(transaction) || undefined,
    bank_reference: reference,
    duplicate: false,
    duplicate_transaction_ids: [],
  };
}

function compareAction(journalIds: number[]): string {
  const target = journalIds.length > 0 ? `journal ${journalIds.join(", ")}` : "the own-account transfer journals of this date and amount";
  return `compare with ${target}; if it books this movement, delete the PROJECT row after explicit owner approval; otherwise classify normally`;
}

/**
 * Take out of classification every row the ledger already explains: a journal
 * that books its bank reference (alreadyBooked), any weaker journal hit
 * (possibleDuplicates), and transfers between own accounts (ownTransfers).
 * Returns a reason string when the bank account cannot be resolved.
 */
function partitionByLedgerContext(
  api: ApiContext,
  rows: Transaction[],
  ledgerTransactions: Transaction[],
  ledger: LedgerContext,
  dimensionId: number,
): LedgerPartition | string {
  const accountId: unknown = ledger.accountDimensions.find(dimension => dimension.id === dimensionId && !dimension.is_deleted)?.accounts_id;
  if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId <= 0) {
    return `The bank account of dimension ${dimensionId} could not be resolved, so journals, own transfers and booking history were not checked.`;
  }
  const lookups = buildBankAccountLookups(ledger.bankAccounts, ledger.accountDimensions);
  const toCamt = (direction: "incoming" | "outgoing") => direction === "incoming" ? "CRDT" as const : "DBIT" as const;
  // An unproven direction is checked both ways and can only reach review.
  const entriesFor = (transaction: Transaction): ParsedCamtEntry[] => {
    const direction = trustedDirection(transaction);
    return direction ? [coverageEntry(transaction, toCamt(direction))] : [coverageEntry(transaction, "CRDT"), coverageEntry(transaction, "DBIT")];
  };
  // Exclusivity (one journal books one movement) is judged over every PROJECT
  // row of the dimension, not only the date-filtered selection being classified.
  const selectedIds = new Set(rows.map(transaction => transaction.id));
  const competing = [
    ...rows,
    ...ledgerTransactions.filter(transaction => transaction.accounts_dimensions_id === dimensionId &&
      isProjectTransaction(transaction) && !selectedIds.has(transaction.id)),
  ];
  const hashOnlyKey = (transaction: Transaction) => coverageEntry(transaction, "CRDT").bank_reference === undefined
    ? storedBankReferenceLookupKey(transaction)
    : undefined;
  const coverageContext = buildCamtJournalCoverageContext({
    snapshot: {
      journals: ledger.journals,
      accountId,
      bankAccounts: ledger.bankAccounts,
      accountDimensions: ledger.accountDimensions,
      interAccountResolver: (journals, ownDimensionIds) => BookingGuard.fromSnapshot(api, journals, ownDimensionIds),
    },
    dimensionId,
    entries: competing.map(transaction => entriesFor(transaction)[0]!),
    entryReferenceKeys: competing.map(hashOnlyKey),
    ledgerTransactions,
  });
  const inferenceLookups = {
    ownIbanToDimension: lookups.ownIbanToDimension,
    dimensionToIban: lookups.dimensionToIban,
    ownIbansWithoutDimension: lookups.ownIbansWithoutDimension,
    companyName: normalizeCompanyName(ledger.companyLegalName),
    companyLegalName: ledger.companyLegalName,
    targetAccountsDimensionsId: undefined,
  };
  const inferenceCache = new Map<number, OneSidedInference>();

  const partition: LedgerPartition = {
    alreadyBooked: [],
    ownTransfers: [],
    possibleDuplicates: [],
    remaining: [],
    history: buildCounterpartyBookingHistory({
      transactions: ledgerTransactions,
      journals: ledger.journals,
      ownBankDimensionIds: lookups.ownDimensionIds,
    }),
  };
  const storedKeyCounts = new Map<string, number>();
  for (const transaction of competing) {
    const key = storedBankReferenceLookupKey(transaction);
    if (key !== undefined) storedKeyCounts.set(key, (storedKeyCounts.get(key) ?? 0) + 1);
  }
  for (const transaction of rows) {
    if (transaction.id === undefined) {
      partition.remaining.push(transaction);
      continue;
    }
    const base = {
      transaction_id: transaction.id,
      date: transaction.date,
      amount: transaction.amount,
      ...(transaction.bank_account_name ? { counterparty: transaction.bank_account_name } : {}),
    };

    // A marker that kept only the reference hash still carries the identity key.
    const storedKey = hashOnlyKey(transaction);
    const hits = entriesFor(transaction)
      .map(entry => classifyCamtJournalCoverage(entry, coverageContext, storedKey))
      .filter((coverage): coverage is Exclude<CamtJournalCoverage, { kind: "none" }> => coverage.kind !== "none")
      // A repeated hash-only key cannot prove which row a journal books.
      .map(coverage => storedKey !== undefined && coverage.kind === "identity" && (storedKeyCounts.get(storedKey) ?? 0) > 1
        ? { kind: "review" as const, code: "camt_journal_conflict" as const, journal_ids: coverage.journal_ids }
        : coverage);
    if (hits.length === 1 && hits[0]!.kind === "identity" && trustedDirection(transaction)) {
      partition.alreadyBooked.push({
        ...base,
        journal_ids: hits[0]!.journal_ids,
        strength: "reference",
        next_action: `verify that journal ${hits[0]!.journal_ids.join(", ")} books this movement, then delete_transaction ${transaction.id} (the PROJECT row) after explicit owner approval`,
      });
      continue;
    }
    if (hits.length > 0) {
      const journalIds = [...new Set(hits.flatMap(hit => hit.journal_ids))].sort((left, right) => left - right);
      partition.possibleDuplicates.push({
        ...base,
        journal_ids: journalIds,
        code: hits[0]!.kind === "review" ? hits[0]!.code : `journal_${hits[0]!.kind}`,
        next_action: compareAction(journalIds),
      });
      continue;
    }

    // An unverifiable CAMT marker proves neither IBAN nor direction (a flipped
    // dir= turns refunds into payments): never classified or booked, always review.
    if (hasUnverifiableCamtMarker(transaction)) {
      partition.possibleDuplicates.push({
        ...base,
        journal_ids: [],
        code: "camt_marker_unverified",
        next_action: legacyTruncatedCamtMarkerHint(transaction) ??
          "check the row against the bank statement: its CAMT marker checksum does not verify, so neither its direction nor its counterparty account is proven; correct or re-import the row, then classify again",
      });
      continue;
    }

    const inference = inferOneSidedTransfer({ ...transaction, bank_account_no: counterpartyIbanOf(transaction) }, inferenceLookups, inferenceCache);
    const candidates = inference.ambiguousTargetDimensions ?? [];
    if (inference.unbookableOwnIban) {
      // Own money to an own account that cannot be booked: never left to expense
      // classification or an auto-booking rule.
      partition.ownTransfers.push({
        ...base,
        target_dimension_id: null,
        confidence: inference.confidence,
        reasons: inference.reasons,
        next_action: `give the own bank account ${inference.unbookableOwnIban} an accounting dimension in e-arveldaja, then reconcile_bank_transactions mode="inter_account_dry_run"`,
      });
      continue;
    }
    if (inference.confidence >= 50 || candidates.length > 0) {
      const target = inference.confidence >= 50 ? inference.targetDimension ?? null : null;
      partition.ownTransfers.push({
        ...base,
        target_dimension_id: target,
        ...(candidates.length > 0 ? { candidate_dimension_ids: [...candidates].sort((left, right) => left - right) } : {}),
        confidence: inference.confidence,
        reasons: inference.reasons,
        next_action: target !== null
          ? `reconcile_bank_transactions mode="inter_account_dry_run" (target dimension ${target})`
          : `reconcile_bank_transactions mode="inter_account_dry_run" with target_accounts_dimensions_id chosen by the operator${candidates.length > 0 ? ` from ${candidates.join(", ")}` : ""}`,
      });
      continue;
    }
    partition.remaining.push(transaction);
  }
  return partition;
}

/**
 * A6: grouping strips legal forms ("Näide OÜ" and "Näide AS" share a group) and
 * the suggestion is resolved from the group, so a history hint must hold for
 * every member. Members with a different (or no) history get their own group.
 */
function splitGroupByHistory(
  group: TransactionGroup,
  historyOf: (transaction: Transaction) => CounterpartyHistorySuggestion | undefined,
): Array<{ group: TransactionGroup; history?: CounterpartyHistorySuggestion }> {
  const parts = new Map<string, { rows: Transaction[]; history?: CounterpartyHistorySuggestion }>();
  for (const transaction of group.transactions) {
    const history = historyOf(transaction);
    const key = history ? JSON.stringify([history.account_id, history.dimension_id, history.streak, history.history_total, history.identity ?? ""]) : "";
    const part = parts.get(key) ?? { rows: [], history };
    part.rows.push(transaction);
    parts.set(key, part);
  }
  if (parts.size === 1) return [{ group, history: [...parts.values()][0]!.history }];
  return [...parts.values()].map(part => ({ group: groupTransactionsByCounterparty(part.rows)[0]!, history: part.history }));
}

function historyBookingSuggestion(
  history: CounterpartyHistorySuggestion,
  accounts: Array<{ id?: number; name_est?: string }>,
): ClassifiedTransactionSuggestion {
  const account = accounts.find(candidate => candidate.id === history.account_id);
  const dimension = history.dimension_id !== null ? ` dimension ${history.dimension_id}` : "";
  const nameOnly = history.identity === "name_only"
    ? " The counterparty is matched by its name only (no IBAN or legal form on these rows), so check it is the same party."
    : "";
  const ownBank = history.own_bank_account
    ? " That is another own bank account: book it this way only if that account has no imported row of the same payment; if it has one, reconcile the two as an inter-account transfer instead."
    : "";
  return {
    purchase_account_id: history.account_id,
    purchase_account_name: account ? `${history.account_id} ${account.name_est}` : undefined,
    ...(history.dimension_id !== null ? { purchase_account_dimensions_id: history.dimension_id } : {}),
    source: "transaction_history",
    reason: `The last ${history.streak} confirmed bank rows of this counterparty in this direction (of ${history.history_total}) were booked to account ${history.account_id}${dimension}.${nameOnly}${ownBank} Review-only: confirm the substance before booking. suggested_distribution carries no amount: book each transaction separately, adding amount = that transaction's own amount.`,
    transaction_history: history,
    suggested_distribution: {
      related_table: "accounts",
      related_id: history.account_id,
      ...(history.dimension_id !== null ? { related_sub_id: history.dimension_id } : {}),
    },
  };
}

class ClassificationOperationsImpl implements ClassificationOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
    private readonly wrapUntrustedText: WrapUntrustedText,
  ) {}

  /**
   * P0-2 drift fingerprint. Re-derives — READ-ONLY (execute=false, no supplier
   * creation, no invoice write) — the exact canonical effect that execute_apply
   * would produce from the SAME caller-supplied groups + the current live state,
   * and returns it as a stable canonical record. Bound into the plan at
   * dry_run_apply and recomputed fresh at execute_apply; any material difference
   * (added/removed transaction, changed category/apply_mode, a transaction whose
   * status/amount/currency/date/dimension/client moved, a re-resolved supplier or
   * booking article/account/dimension/VAT/total) makes canonicalPlanJson differ
   * and is rejected as plan_drift before the first API write. The caller JSON is
   * a SELECTION only — it can match the reviewed plan or drift, never re-authorize
   * a different effect. Both passes call resolveSupplierFromTransaction /
   * resolveClassificationSuggestion with execute=false so the read-only supplier
   * identity and server-resolved booking agree across preview and execute.
   */
  private async computeApplyFingerprint(
    groups: ClassifiedTransactionGroupResult[],
    context: { clients: Client[]; purchaseInvoices: unknown[]; openPurchases: PurchaseInvoice[]; purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>; accounts: unknown[]; isVatRegistered: boolean },
    cache: Map<number, GatherOutcome>,
  ): Promise<PlanRecord> {
    const api = this.api;
    const groupFingerprints: PlanData[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const bookable = group.apply_mode === "purchase_invoice"
        && shouldProcessExpenseAsPurchaseInvoice(group.category)
        && group.suggested_booking?.purchase_article_id !== undefined;
      const txFingerprints: PlanData[] = [];
      for (const stub of group.transactions) {
        if (stub.id === undefined) {
          txFingerprints.push({ id: null, present: false });
          continue;
        }
        // Fetch each transaction exactly ONCE here (the read-only pass); the
        // mutation loop below reuses this cache instead of re-fetching, so
        // execute's api.transactions.get count stays the same as before the plan
        // gate (this pass + the post-create freshness re-read).
        let transaction: Transaction | undefined;
        try {
          transaction = await api.transactions.get(stub.id);
        } catch (error) {
          // A confirmed 404 → the transaction is genuinely gone (bind absence so
          // it drifts from a plan that reviewed it as present). A transient
          // 503/timeout is NOT swallowed as "gone": it is captured and re-thrown
          // in the mutation loop so the affected GROUP fails (never a benign
          // skip), while the fingerprint marks it as an unresolved read so preview
          // and execute agree deterministically.
          if (isNotFoundHttpError(error)) {
            cache.set(stub.id, { kind: "gone" });
            txFingerprints.push({ id: stub.id, present: false });
            continue;
          }
          cache.set(stub.id, { kind: "error", error });
          txFingerprints.push({ id: stub.id, present: false, read_error: true });
          continue;
        }
        if (!transaction || transaction.is_deleted) {
          cache.set(stub.id, { kind: "deleted" });
          txFingerprints.push({ id: stub.id, present: false, deleted: transaction?.is_deleted === true });
          continue;
        }
        // Fresh live-state binding — a change to any of these between preview and
        // execute drifts the whole command (invariant: the reviewed aggregate
        // effect cannot silently change).
        const liveState: PlanData = {
          material: stripUndefinedDeep(snapshotBankTransaction(transaction)) as unknown as PlanData,
          id: transaction.id ?? stub.id,
          status: transaction.status ?? null,
          amount: transaction.amount ?? null,
          base_amount: transaction.base_amount ?? null,
          currency: (transaction.cl_currencies_id ?? "EUR").toUpperCase(),
          currency_rate: transaction.currency_rate ?? null,
          date: transaction.date ?? null,
          accounts_dimensions_id: transaction.accounts_dimensions_id ?? null,
          clients_id: transaction.clients_id ?? null,
          // An open invoice appearing after the preview must drift the plan.
          matches_open_invoice: existingInvoiceMatch(transaction, [], context.openPurchases),
        };
        if (transaction.status === "CONFIRMED") {
          cache.set(stub.id, { kind: "confirmed" });
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null });
          continue;
        }
        if (transaction.status !== "PROJECT") {
          cache.set(stub.id, { kind: "non_project", status: transaction.status ?? undefined });
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null });
          continue;
        }
        cache.set(stub.id, { kind: "ok", transaction });
        if (!bookable) {
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null });
          continue;
        }
        // Server-resolved supplier IDENTITY (read-only — no creation) and booking
        // projection, mirroring the mutation loop's resolution exactly.
        const supplierResolution = await resolveSupplierFromTransaction(api, context.clients, transaction, false, group.category);
        const supplier = supplierResolution.client;
        const grossAmount = roundMoney(Math.abs(transaction.amount));
        const transactionGroup: TransactionGroup = {
          normalized_counterparty: canonicalBusinessText(group.normalized_counterparty),
          display_counterparty: canonicalBusinessText(group.display_counterparty),
          transactions: [transaction],
        };
        const resolved = await resolveClassificationSuggestion(api, {
          purchaseInvoices: context.purchaseInvoices,
          purchaseArticlesWithVat: context.purchaseArticlesWithVat,
          accounts: context.accounts,
        } as never, context.clients, transactionGroup, {
          category: group.category,
          apply_mode: group.apply_mode,
          recurring: group.recurring,
          similar_amounts: group.similar_amounts,
          reasons: group.reasons,
        });
        if (resolved.applyMode !== "purchase_invoice") {
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null, apply_mode_resolved: resolved.applyMode });
          continue;
        }
        const article = context.purchaseArticlesWithVat.find(item => item.id === resolved.suggestion.purchase_article_id);
        const vatConfig = getBookingSuggestionVatConfig({
          item: {
            vat_rate_dropdown: resolved.suggestion.vat_rate_dropdown,
            reversed_vat_id: resolved.suggestion.reversed_vat_id,
          } as PurchaseInvoiceItem,
        }) ?? getAutoBookedVatConfig();
        const netAmount = deriveAutoBookedNetAmount(grossAmount, vatConfig);
        const purchaseItem = applyPurchaseVatDefaults(
          context.purchaseArticlesWithVat,
          {
            cl_purchase_articles_id: resolved.suggestion.purchase_article_id,
            purchase_accounts_id: resolved.suggestion.purchase_account_id ?? article?.accounts_id,
            purchase_accounts_dimensions_id: resolved.suggestion.purchase_account_dimensions_id,
            custom_title: transaction.description ?? `Auto-booked ${group.category}`,
            unit_net_price: netAmount,
            total_net_price: netAmount,
            amount: 1,
            ...vatConfig,
          },
          context.isVatRegistered,
        );
        txFingerprints.push({
          ...(liveState as Record<string, PlanData>),
          booking: stripUndefinedDeep({
            supplier_client_id: supplier?.id ?? null,
            supplier_name: supplier?.name !== undefined ? canonicalBusinessText(supplier.name) : null,
            invoice_number: `AUTO-TX-${transaction.id}`,
            purchase_article_id: resolved.suggestion.purchase_article_id ?? null,
            purchase_account_id: purchaseItem.purchase_accounts_id ?? null,
            purchase_account_dimensions_id: purchaseItem.purchase_accounts_dimensions_id ?? null,
            liability_account_id: resolved.suggestion.liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
            vat_rate_dropdown: purchaseItem.vat_rate_dropdown ?? null,
            vat_accounts_id: purchaseItem.vat_accounts_id ?? null,
            cl_vat_articles_id: purchaseItem.cl_vat_articles_id ?? null,
            reversed_vat_id: purchaseItem.reversed_vat_id ?? null,
            net_amount: netAmount,
            gross_amount: grossAmount,
            vat_price: deriveAutoBookedVatPrice(grossAmount, vatConfig),
          }),
        });
      }
      groupFingerprints.push({
        category: group.category,
        apply_mode: group.apply_mode,
        bookable,
        transactions: txFingerprints,
      });
    }
    return stripUndefinedDeep({
      schema: "bank_classification_apply_v1",
      stop_policy: "stop_group_on_drift",
      commands: ["purchase_invoice_create", "purchase_invoice_confirm", "transaction_confirm_link"],
      groups: groupFingerprints,
    }) as PlanRecord;
  }

  async analyzeUnmatched(input: UnmatchedAnalysisInput): Promise<OperationOutcome<UnmatchedAnalysisResult>> {
    const api = this.api;
    const { accountsDimensionsId, dateFrom, dateTo } = input;
    const [transactions, saleInvoices, purchaseInvoices, clients, purchaseArticlesWithVat, accounts, ledger] = await Promise.all([
      api.transactions.listAll(),
      api.saleInvoices.listAll(),
      api.purchaseInvoices.listAll(),
      api.clients.listAll(),
      getPurchaseArticlesWithVat(api),
      api.readonly.getAccounts(),
      loadLedgerContext(api),
    ]);

    const openSales = saleInvoices.filter(invoice =>
      invoice.status === "CONFIRMED" && invoice.payment_status !== "PAID",
    );
    const openPurchases = purchaseInvoices.filter(invoice =>
      invoice.status === "CONFIRMED" && invoice.payment_status !== "PAID",
    );
    const ownerCounterparties = buildOwnerCounterpartySet(clients);

    const unconfirmed = transactions.filter(transaction =>
      transaction.accounts_dimensions_id === accountsDimensionsId &&
      isProjectTransaction(transaction) &&
      (!dateFrom || transaction.date >= dateFrom) &&
      (!dateTo || transaction.date <= dateTo),
    );

    const unmatched = unconfirmed.filter(transaction => !existingInvoiceMatch(transaction, openSales, openPurchases));
    const partition = ledger
      ? partitionByLedgerContext(api, unmatched, transactions, ledger, accountsDimensionsId)
      : "The journals or bank accounts could not be read, so already-booked rows, own transfers and booking history were not checked.";
    const ledgerContextUnavailable = typeof partition === "string" ? partition : undefined;
    const classifiable = typeof partition === "string" ? unmatched : partition.remaining;
    const historyOf = (transaction: Transaction) => typeof partition === "string"
      ? undefined
      : lookupCounterpartyHistory(partition.history, {
          name: transaction.bank_account_name,
          iban: counterpartyIbanOf(transaction) || undefined,
          iban_omitted: isCamtCounterpartyIbanOmitted(transaction),
          accounts_dimensions_id: transaction.accounts_dimensions_id,
          direction: trustedDirection(transaction) ?? "unknown",
          // Only rows the ledger partition left over reach classification: the
          // inter-account matcher found no own-transfer target for them.
          allow_own_bank_contra: true,
        }).suggestion;
    const groups = groupTransactionsByCounterparty(classifiable).flatMap(group => splitGroupByHistory(group, historyOf));
    const context = {
      purchaseInvoices,
      purchaseArticlesWithVat,
      accounts,
    };
    const classifiedGroups: ClassifiedTransactionGroupResult[] = [];

    for (const { group, history } of groups) {
      const classification = categorizeTransactionGroup({
        normalized_counterparty: group.normalized_counterparty,
        display_counterparty: group.display_counterparty,
        transactions: group.transactions,
        owner_counterparties: ownerCounterparties,
      });
      const resolved = await resolveClassificationSuggestion(api, context, clients, group, classification);
      let applyMode = resolved.applyMode;
      let suggestion = resolved.suggestion;
      // Precedence: statutory category > saved rule > transaction history >
      // supplier-invoice history > keyword. History is review-only, never a rule.
      const fixedBySource = suggestion.source === "category_default" || suggestion.source === "local_rules";
      if (!fixedBySource && history) {
        suggestion = historyBookingSuggestion(history, accounts);
        applyMode = "review_only";
      } else if (
        !fixedBySource &&
        (suggestion.source === "keyword_match" || suggestion.source === "fallback") &&
        (classification.category === "revenue_without_invoice" || classification.category === "unknown")
      ) {
        // A keyword purchase-article guess (e.g. a sales-transport or fixed-asset
        // account) for an incoming or unknown row is noise, not a suggestion. So is
        // the purchase-invoice payable (2310): a bank fee or a receipt read it as
        // the account to book to.
        suggestion = {
          source: "fallback",
          reason: "No booking history or saved rule names a contra account for this counterparty; choose it from the transaction's substance.",
        };
      }
      const historyHint = suggestion.source === "transaction_history" ? history : undefined;
      const guidance = applyMode !== "purchase_invoice"
        ? buildClassificationReviewGuidance({
            category: classification.category,
            displayCounterparty: group.display_counterparty,
            ...(historyHint
              ? { history: { accountId: historyHint.account_id, dimensionId: historyHint.dimension_id, streak: historyHint.streak, historyTotal: historyHint.history_total } }
              : {}),
          })
        : undefined;
      // A name-only history match says so in the guidance too (A4).
      const reviewGuidance = guidance && historyHint?.identity === "name_only"
        ? { ...guidance, recommendation: `${guidance.recommendation} NB: osapool on tuvastatud ainult nime järgi (IBAN ja õiguslik vorm puuduvad), kontrolli, et see on sama osapool.` }
        : guidance;
      // Build the RAW classified group (no wrapping). The presenter reproduces
      // the double-wrap of transaction description/bank_account_name and the
      // single-wrap of counterparty fields. Key order matches the former
      // toClassifiedResult output so the wrapped envelope stays byte-identical.
      classifiedGroups.push({
        category: classification.category,
        apply_mode: applyMode,
        normalized_counterparty: group.normalized_counterparty,
        display_counterparty: group.display_counterparty,
        recurring: classification.recurring,
        similar_amounts: classification.similar_amounts,
        total_amount: roundMoney(group.transactions.reduce((sum, transaction) => sum + transaction.amount, 0)),
        suggested_booking: suggestion,
        reasons: classification.reasons,
        review_guidance: reviewGuidance,
        transactions: group.transactions.map(transaction => ({
          id: transaction.id,
          type: transaction.type,
          amount: transaction.amount,
          date: transaction.date,
          description: transaction.description ?? undefined,
          bank_account_name: transaction.bank_account_name ?? undefined,
          bank_subtype: transaction.bank_subtype,
          accounts_dimensions_id: transaction.accounts_dimensions_id,
          clients_id: transaction.clients_id,
        })),
      });
    }

    const categoryCounts = classifiedGroups.reduce<Record<string, number>>((counts, group) => {
      counts[group.category] = (counts[group.category] ?? 0) + group.transactions.length;
      return counts;
    }, {});

    return ok({
      accountsDimensionsId,
      ...(dateFrom !== undefined ? { dateFrom } : {}),
      ...(dateTo !== undefined ? { dateTo } : {}),
      totalUnconfirmed: unconfirmed.length,
      totalUnmatched: classifiable.length,
      categoryCounts,
      groups: classifiedGroups,
      alreadyBooked: typeof partition === "string" ? [] : partition.alreadyBooked,
      ownTransfers: typeof partition === "string" ? [] : partition.ownTransfers,
      possibleDuplicates: typeof partition === "string" ? [] : partition.possibleDuplicates,
      totalPartitionedOut: unmatched.length - classifiable.length,
      ...(ledgerContextUnavailable !== undefined ? { ledgerContextUnavailable } : {}),
    });
  }

  async applyClassifications(input: ApplyClassificationsInput): Promise<OperationOutcome<ApplyClassificationsResult>> {
    const api = this.api;
    const wrapUntrustedText = this.wrapUntrustedText;
    const dryRun = input.execute !== true;
    const parsed = typeof input.classificationsJson === "string"
      ? safeJsonParse(input.classificationsJson, "classifications_json")
      : input.classificationsJson;
    const groups = extractClassificationGroups(parsed);

    if (!dryRun) {
      // execute_apply gates writes on these reads (transaction still PROJECT,
      // existing supplier, duplicate invoice): bypass the 120 s cache so state
      // changed elsewhere since dry_run_apply is seen. Also drops cached
      // transaction gets, so the fingerprint pass below reads each one live.
      api.clients.invalidateListCache();
      api.purchaseInvoices.invalidateListCache();
      api.transactions.invalidateListCache();
    }
    const [clients, purchaseArticlesWithVat, purchaseInvoices, accounts] = await Promise.all([
      api.clients.listAll(),
      getPurchaseArticlesWithVat(api),
      api.purchaseInvoices.listAll(),
      api.readonly.getAccounts(),
    ]);
    const isVatRegistered = await isCompanyVatRegistered(api);
    const openPurchases = purchaseInvoices.filter(invoice =>
      invoice.status === "CONFIRMED" && invoice.payment_status !== "PAID",
    );
    const fingerprintContext = { clients, purchaseInvoices, openPurchases, purchaseArticlesWithVat, accounts, isVatRegistered };

    // Single read-only pass: fetch every transaction ONCE, build the canonical
    // fingerprint, and cache each fetch so the mutation loop reuses it (no
    // re-fetch). Both dry_run_apply (mint the plan from this) and execute_apply
    // (drift-check against the reviewed plan) share this exact computation.
    const gatherCache = new Map<number, GatherOutcome>();
    const liveFingerprint = await this.computeApplyFingerprint(groups, fingerprintContext, gatherCache);

    // Re-run classification's ledger partition for every row this apply could
    // book: a journal, own transfer or duplicate that appeared after the preview
    // drifts the plan, and a blocked row is skipped. Unreadable ledger fails closed.
    const ledgerBlocks = new Map<number, { code: string; next_action: string }>();
    let ledgerCheck: Record<string, string> | "unavailable" | null = null;
    const bookableRows = groups
      .filter(group => group.apply_mode === "purchase_invoice" && shouldProcessExpenseAsPurchaseInvoice(group.category))
      .flatMap(group => group.transactions.map(stub => stub.id === undefined ? undefined : gatherCache.get(stub.id)))
      .flatMap(outcome => outcome?.kind === "ok" ? [outcome.transaction] : []);
    if (bookableRows.length > 0) {
      if (!dryRun) api.journals.invalidateListCache();
      const ledger = await loadLedgerContext(api);
      const ledgerTransactions = ledger ? await api.transactions.listAll().catch(() => undefined) : undefined;
      if (!ledger || !ledgerTransactions) {
        ledgerCheck = "unavailable";
      } else {
        ledgerCheck = {};
        const fresh = new Map(bookableRows.map(transaction => [transaction.id!, transaction]));
        for (const dimensionId of [...new Set(bookableRows.map(transaction => transaction.accounts_dimensions_id))]) {
          const targets = bookableRows.filter(transaction => transaction.accounts_dimensions_id === dimensionId);
          const rows = [
            ...ledgerTransactions.filter(transaction => transaction.accounts_dimensions_id === dimensionId &&
              isProjectTransaction(transaction) && !fresh.has(transaction.id!)),
            ...targets,
          ];
          const partition = typeof dimensionId === "number"
            ? partitionByLedgerContext(api, rows, ledgerTransactions, ledger, dimensionId)
            : "The transaction has no bank dimension.";
          const blocked = typeof partition === "string"
            ? targets.map(transaction => ({ transaction_id: transaction.id!, code: "ledger_unavailable", next_action: partition }))
            : [
              ...partition.alreadyBooked.map(row => ({ ...row, code: `already_booked:${row.journal_ids.join(",")}` })),
              ...partition.ownTransfers.map(row => ({ ...row, code: "own_transfer" })),
              ...partition.possibleDuplicates.map(row => ({ ...row, code: `possible_duplicate:${row.code}:${row.journal_ids.join(",")}` })),
            ];
          for (const row of blocked) {
            if (!fresh.has(row.transaction_id)) continue;
            ledgerCheck[String(row.transaction_id)] = row.code;
            ledgerBlocks.set(row.transaction_id, { code: row.code, next_action: row.next_action });
          }
        }
      }
    }
    const fingerprint: PlanRecord = { ...liveFingerprint, ledger_check: ledgerCheck };

    // P0-2 execute gate: consume the reviewed plan (consume-once, scope-bound)
    // and compare the FRESH canonical effect. Any material difference vs the
    // reviewed plan — including a caller who edited classifications_json, or live
    // state that moved since the preview — is rejected as plan_drift with ZERO
    // API writes, BEFORE the first mutation. The caller's classifications_json is
    // never the executable authority; it can only match the plan or drift.
    if (!dryRun) {
      if (input.planHandle === undefined) {
        return fail("plan_handle_required", "execute_apply requires the plan_handle returned by dry_run_apply.");
      }
      let storedPlan;
      try {
        storedPlan = this.runtimeSafetyContext.planStore.consume(input.planHandle, BANK_CLASSIFICATION_PLAN_DOMAIN);
      } catch (error) {
        const code = (error as { code?: string }).code ?? "plan_handle_invalid";
        return fail(code, "The reviewed classification plan could not be consumed.");
      }
      if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(fingerprint)) {
        return fail("plan_drift", "The classifications no longer match the reviewed dry_run_apply plan (transactions, category, apply_mode, supplier, booking, or live transaction state changed). Re-run dry_run_apply and review again.");
      }
    }

    const results: ApplyClassificationGroupResult[] = [];

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      await reportProgress(index, groups.length);
      const notes: string[] = [];
      const transactionIds = group.transactions.map(transaction => transaction.id).filter((id): id is number => id !== undefined);
      const createdInvoiceIds: number[] = [];
      const linkedTransactionIds: number[] = [];
      const partialMutations: PartialClassificationMutation[] = [];
      let wouldCreateCount = 0;
      let attemptedCreateCount = 0;

      try {
        const freshTransactions: Transaction[] = [];
        for (const transactionStub of group.transactions) {
          if (!transactionStub.id) {
            notes.push("Skipped a transaction without ID.");
            continue;
          }
          // Reuse the fingerprint pass's single fetch (no re-fetch here). The
          // outcome reproduces the exact skip notes; a captured non-404 read error
          // is re-thrown so the affected GROUP fails (never a benign skip).
          const outcome = gatherCache.get(transactionStub.id);
          if (outcome === undefined || outcome.kind === "gone") {
            notes.push(`Transaction ${transactionStub.id} no longer exists.`);
            continue;
          }
          if (outcome.kind === "deleted") {
            notes.push(`Transaction ${transactionStub.id} was deleted since classification; skipped.`);
            continue;
          }
          if (outcome.kind === "confirmed") {
            notes.push(`Transaction ${transactionStub.id} was confirmed since classification; skipped.`);
            continue;
          }
          if (outcome.kind === "non_project") {
            notes.push(`Transaction ${transactionStub.id} is no longer bookable (status ${outcome.status ?? "UNKNOWN"}); skipped.`);
            continue;
          }
          if (outcome.kind === "error") {
            throw outcome.error;
          }
          freshTransactions.push(outcome.transaction);
        }

        if (freshTransactions.length === 0) {
          notes.push("No unconfirmed transactions remain in this classification group.");
          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status: "skipped",
            notes,
            transactions: transactionIds,
          });
          continue;
        }

        if (group.apply_mode !== "purchase_invoice" || !shouldProcessExpenseAsPurchaseInvoice(group.category)) {
          notes.push(`Category ${group.category} is review-only and is not auto-booked as a purchase invoice.`);
          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status: "skipped",
            notes,
            transactions: transactionIds,
          });
          continue;
        }

        if (!group.suggested_booking.purchase_article_id) {
          notes.push("Missing suggested purchase article ID. Re-run classification after maintaining purchase articles.");
          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status: "skipped",
            notes,
            transactions: transactionIds,
          });
          continue;
        }

        for (const transaction of freshTransactions) {
          // A classification group may still carry an incoming row (refund,
          // chargeback) — never book it as a purchase invoice and confirm it.
          // Only a checksum-verified marker proves the direction (a flipped dir=).
          const approvedSnapshot = snapshotBankTransaction(transaction);
          const direction = approvedSnapshot.trusted_direction;
          if (direction !== "outgoing") {
            notes.push(`Transaction ${transaction.id} is not an outgoing payment (direction: ${direction}); skipped — only outgoing payments are booked as purchase invoices.`);
            continue;
          }
          if (ledgerCheck === "unavailable") {
            notes.push(`Transaction ${transaction.id} skipped — journals could not be read, so it cannot be checked for an existing booking. Retry later.`);
            continue;
          }
          const ledgerBlock = ledgerBlocks.get(transaction.id!);
          if (ledgerBlock) {
            notes.push(`Transaction ${transaction.id} is already booked or needs ledger review (${ledgerBlock.code}); skipped — ${ledgerBlock.next_action}.`);
            continue;
          }
          // The payment settles an existing open purchase invoice — booking a
          // new expense invoice for it would double the expense/payable.
          if (existingInvoiceMatch(transaction, [], openPurchases)) {
            notes.push(`Transaction ${transaction.id} matches an open purchase invoice; skipped — reconcile instead.`);
            continue;
          }
          const supplierResolution = await resolveSupplierFromTransaction(api, clients, transaction, !dryRun, group.category);
          const supplier = supplierResolution.client;
          const supplierId = supplier?.id;
          const grossAmount = roundMoney(Math.abs(transaction.amount));
          const transactionCurrency = (transaction.cl_currencies_id ?? "EUR").toUpperCase();
          const transactionCurrencyRate = transaction.currency_rate;
          // M10: the caller echoes classify output back in classifications_json,
          // where counterparty fields were sandbox-wrapped for display. Strip
          // the markers to the canonical business value BEFORE it drives rule
          // matching (findAutoBookingRule), booking suggestions, or is written
          // into the audit summary below — nothing persisted/matched may carry
          // a sandbox marker. The response still re-wraps counterparty text.
          const transactionGroup: TransactionGroup = {
            normalized_counterparty: canonicalBusinessText(group.normalized_counterparty),
            display_counterparty: canonicalBusinessText(group.display_counterparty),
            transactions: [transaction],
          };
          const resolved = await resolveClassificationSuggestion(api, {
            purchaseInvoices,
            purchaseArticlesWithVat,
            accounts,
          }, clients, transactionGroup, {
            category: group.category,
            apply_mode: group.apply_mode,
            recurring: group.recurring,
            similar_amounts: group.similar_amounts,
            reasons: group.reasons,
          });
          if (!supplier?.id && dryRun) {
            // display_counterparty is remitter-controlled bank-statement text
            // (bank_account_name, falling back to description) and this is the
            // only note that puts it into prose. The full apply envelope emitted
            // the sentence verbatim. Uses the injected wrapper — the same
            // mechanism the invalidation note below relies on — so this module
            // still never imports wrapUntrustedOcr, and the surrounding
            // server-authored text stays free of sandbox markers.
            notes.push(`Dry run: transaction ${transaction.id} would require creating a supplier for ${wrapUntrustedText(group.display_counterparty) ?? group.display_counterparty}.`);
          }
          if (!supplier?.id && !dryRun) {
            notes.push(`Transaction ${transaction.id} could not resolve a supplier client.`);
            continue;
          }

          if (resolved.applyMode !== "purchase_invoice") {
            notes.push(`Transaction ${transaction.id} requires manual review before booking. ${resolved.suggestion.reason}`);
            continue;
          }

          if (
            transactionCurrency !== "EUR" &&
            (!Number.isFinite(transactionCurrencyRate) || (transactionCurrencyRate ?? 0) <= 0)
          ) {
            notes.push(
              `Non-EUR transaction ${transaction.id} uses ${transactionCurrency} but has no currency_rate. Review manually or retry after the transaction exposes a valid EUR conversion rate.`
            );
            continue;
          }

          const article = purchaseArticlesWithVat.find(item => item.id === resolved.suggestion.purchase_article_id);
          const vatConfig = getBookingSuggestionVatConfig({
            item: {
              vat_rate_dropdown: resolved.suggestion.vat_rate_dropdown,
              reversed_vat_id: resolved.suggestion.reversed_vat_id,
            } as PurchaseInvoiceItem,
          }) ?? getAutoBookedVatConfig();
          const netAmount = deriveAutoBookedNetAmount(grossAmount, vatConfig);
          const purchaseItem = applyPurchaseVatDefaults(
            purchaseArticlesWithVat,
            {
              cl_purchase_articles_id: resolved.suggestion.purchase_article_id,
              purchase_accounts_id: resolved.suggestion.purchase_account_id ?? article?.accounts_id,
              purchase_accounts_dimensions_id: resolved.suggestion.purchase_account_dimensions_id,
              custom_title: transaction.description ?? `Auto-booked ${group.category}`,
              unit_net_price: netAmount,
              total_net_price: netAmount,
              amount: 1,
              ...vatConfig,
            },
            isVatRegistered,
          );

          if (dryRun) {
            wouldCreateCount += 1;
            notes.push(`Dry run: would create purchase invoice for transaction ${transaction.id}.`);
            continue;
          }

          if (!supplier || !supplierId) {
            notes.push(`Transaction ${transaction.id} could not resolve a supplier client.`);
            continue;
          }

          const invoiceModel: CreatePurchaseInvoiceData = {
            clients_id: supplierId, client_name: supplier.name, number: `AUTO-TX-${transaction.id}`,
            create_date: transaction.date, journal_date: transaction.date, term_days: 0,
            cl_currencies_id: transactionCurrency,
            ...(transactionCurrency !== "EUR" ? { currency_rate: transactionCurrencyRate } : {}),
            liability_accounts_id: resolved.suggestion.liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
            notes: tagNotes(`Auto-created from classified bank transaction ${transaction.id}`), items: [purchaseItem],
          };
          const invoice = await withPurchaseInvoiceLock(api, async () => {
            const duplicates = await scanPurchaseIntakeDuplicates(api, { supplierClientId: supplierId,
              invoiceNumber: `AUTO-TX-${transaction.id}`, grossPrice: grossAmount, invoiceDate: transaction.date, currency: transactionCurrency });
            if (duplicates.invoiceIds.length) {
              notes.push(`Transaction ${transaction.id} held: existing purchase invoice(s) ${duplicates.invoiceIds.join(", ")}; reuse the existing invoice.`);
              return undefined;
            }
            api.journals.invalidateListCache();
            api.transactions.invalidateListCache();
            const ledger = await loadLedgerContext(api);
            const ledgerRows = ledger ? await api.transactions.listAll() : undefined;
            if (!ledger || !ledgerRows || typeof transaction.accounts_dimensions_id !== "number") {
              notes.push(`Transaction ${transaction.id} held: fresh ledger scan unavailable after waiting.`);
              return undefined;
            }
            const partition = partitionByLedgerContext(api, [transaction], ledgerRows, ledger, transaction.accounts_dimensions_id);
            if (typeof partition === "string" || partition.alreadyBooked.length || partition.ownTransfers.length || partition.possibleDuplicates.length) {
              notes.push(`Transaction ${transaction.id} held by fresh ledger coverage scan after waiting.`);
              return undefined;
            }
            return api.purchaseInvoices.createAndSetTotals(
            invoiceModel,
            deriveAutoBookedVatPrice(grossAmount, vatConfig),
            grossAmount,
            isVatRegistered,
            );
          });
          if (!invoice) continue;
          const invoiceId = invoice.id;
          if (!invoiceId) {
            throw new Error("createAndSetTotals resolved without a purchase invoice ID");
          }
          attemptedCreateCount += 1;
          createdInvoiceIds.push(invoiceId);
          let observedInvoiceStatus = invoiceClassificationStatus(invoice.status);
          const intendedInvoiceFingerprint = draftFingerprint(invoice);
          const approvedClientTransition = approvedSnapshot.clients_id !== supplierId ? { from: approvedSnapshot.clients_id, to: supplierId } : undefined;
          logAudit({
            tool: "apply_transaction_classifications", action: "CREATED", entity_type: "purchase_invoice",
            entity_id: invoiceId,
            summary: `Auto-booked purchase invoice from transaction ${transaction.id} (${transactionGroup.display_counterparty})`,
            details: { supplier_name: supplier.name, invoice_number: `AUTO-TX-${transaction.id}`, date: transaction.date, total_gross: grossAmount },
          });

          const recordPostCreateFailure = (
            error: unknown,
            failedStage: PartialClassificationMutation["failed_stage"],
            createdInvoiceStatus: PartialClassificationStatus,
            transactionStatus: PartialClassificationStatus,
          ): void => {
            const ambiguous = isAmbiguousPostCreateFailure(error);
            const nextAction = failedStage === "transaction_reread"
              ? `Use existing purchase invoice ${invoiceId}. Freshly read transaction ${transaction.id}, then continue only after explicit approval.`
              : failedStage === "invoice_invalidation"
                ? `Freshly read existing purchase invoice ${invoiceId} before any further action, then continue only after explicit approval.`
                : failedStage === "invoice_confirmation"
                  ? `Use existing purchase invoice ${invoiceId}. Freshly read that invoice and transaction ${transaction.id}, then continue only after explicit approval.`
                  : `Use existing ${createdInvoiceStatus === "CONFIRMED" ? "confirmed " : ""}purchase invoice ${invoiceId} (status ${createdInvoiceStatus}). Freshly read transaction ${transaction.id}, then continue only after explicit approval.`;
            partialMutations.push({
              ...(error instanceof MutationIndeterminateError && error.entity === "transaction" && error.operation === "update" ? { bank_partial: {
                transaction_id: transaction.id!, category: "mutation_indeterminate" as const, register_attempted: false as const,
                mutation_occurred: false, mutation_may_have_occurred: true as const, changed_fields: ["clients_id"], known_objects: [], client_update: null,
                automatic_retry_forbidden: true as const, fresh_preview_required: true as const,
              } } : {}),
              ...(error instanceof TransactionMaterialDriftError ? { changed_fields: error.changed_fields, bank_partial: {
                transaction_id: error.transaction_id, category: error.category, register_attempted: false as const,
                mutation_occurred: error.mutation_occurred, changed_fields: error.changed_fields,
                known_objects: error.known_objects, client_update: error.client_update,
                automatic_retry_forbidden: true as const, fresh_preview_required: true as const,
              } } : {}),
              category: ambiguous ? "mutation_indeterminate" : "mutation_failed",
              mutation_may_have_occurred: true,
              failed_stage: failedStage,
              created_invoice_id: invoiceId,
              created_invoice_status: createdInvoiceStatus,
              attempted_transaction_id: transaction.id!,
              transaction_status: transactionStatus,
              next_action: nextAction,
            });
            notes.push(nextAction);
          };

          let freshTransaction: Transaction;
          try {
            // Uncached: the fingerprint pass fetched this transaction moments
            // ago; the post-create re-read must see a confirm made since.
            api.transactions.invalidateListCache();
            freshTransaction = await api.transactions.get(transaction.id!);
          } catch (error) {
            recordPostCreateFailure(error, "transaction_reread", observedInvoiceStatus, "UNKNOWN");
            continue;
          }

          const comparison = compareBankTransactionMaterial(approvedSnapshot, freshTransaction);
          if (!comparison.ok || !isProjectTransaction(freshTransaction) || comparison.snapshot.trusted_direction !== "outgoing") {
            recordPostCreateFailure(new TransactionMaterialDriftError(transaction.id!, comparison.ok ? ["trusted_direction", "status"] : comparison.changedFields),
              "transaction_drift", observedInvoiceStatus, transactionClassificationStatus(freshTransaction));
            continue;
          }

          try {
            const freshDraft = await api.purchaseInvoices.get(invoiceId);
            observedInvoiceStatus = invoiceClassificationStatus(freshDraft.status);
            const mismatches = draftReadbackMismatches(freshDraft, invoiceModel, { vatPrice: deriveAutoBookedVatPrice(grossAmount, vatConfig), grossPrice: grossAmount }, isVatRegistered, accounts);
            if (freshDraft.status !== "PROJECT" || draftFingerprint(freshDraft) !== intendedInvoiceFingerprint || mismatches.length) {
              throw new TransactionMaterialDriftError(transaction.id!, ["purchase_invoice_material", ...mismatches]);
            }
            api.transactions.invalidateListCache();
            const beforeInvoiceConfirm = await api.transactions.get(transaction.id!);
            const beforeComparison = compareBankTransactionMaterial(approvedSnapshot, beforeInvoiceConfirm);
            if (!beforeComparison.ok || !isProjectTransaction(beforeInvoiceConfirm) || beforeComparison.snapshot.trusted_direction !== "outgoing") {
              throw new TransactionMaterialDriftError(transaction.id!, beforeComparison.ok ? ["trusted_direction", "status"] : beforeComparison.changedFields);
            }
            await api.purchaseInvoices.confirmWithTotals(invoiceId, isVatRegistered);
            observedInvoiceStatus = "CONFIRMED";
            logAudit({
              tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "purchase_invoice",
              entity_id: invoiceId,
              summary: `Auto-confirmed purchase invoice ${invoiceId} for transaction ${transaction.id}`,
              details: { invoice_id: invoiceId, transaction_id: transaction.id },
            });
          } catch (error) {
            recordPostCreateFailure(
              error,
              error instanceof TransactionMaterialDriftError ? "transaction_drift" : "invoice_confirmation",
              isAmbiguousPostCreateFailure(error) ? "UNKNOWN" : observedInvoiceStatus,
              "PROJECT",
            );
            continue;
          }

          // The invoice was just created for the rule-resolved supplier, while the
          // transaction's client came from CAMT counterparty resolution. The
          // supplier owns the payable sub-ledger, so this plan-approved flow
          // moves the transaction to it rather than refusing the confirm.
          const clientReassignedToInvoice =
            freshTransaction.clients_id != null && freshTransaction.clients_id !== supplierId;
          try {
            api.transactions.invalidateListCache();
            freshTransaction = await api.transactions.get(transaction.id!);
            const finalComparison = compareBankTransactionMaterial(approvedSnapshot, freshTransaction);
            if (!finalComparison.ok || !isProjectTransaction(freshTransaction) || finalComparison.snapshot.trusted_direction !== "outgoing") {
              throw new TransactionMaterialDriftError(transaction.id!, finalComparison.ok ? ["trusted_direction", "status"] : finalComparison.changedFields);
            }
            const freshInvoice = await api.purchaseInvoices.get(invoiceId);
            observedInvoiceStatus = invoiceClassificationStatus(freshInvoice.status);
            if (freshInvoice.status !== "CONFIRMED" || draftFingerprint(freshInvoice) !== intendedInvoiceFingerprint) {
              throw new TransactionMaterialDriftError(transaction.id!, ["purchase_invoice_material"]);
            }
            await api.transactions.confirm(transaction.id!, [{
              related_table: "purchase_invoices",
              related_id: invoiceId,
              amount: transaction.amount,
            }], { reassignClientToInvoice: approvedClientTransition !== undefined, approvedClientTransition,
              expectedTransaction: approvedSnapshot,
              expectedLinkedInvoices: { [`purchase_invoices:${invoiceId}`]: snapshotLinkedInvoice("purchase_invoices", freshInvoice) } });
            logAudit({
              tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "transaction",
              entity_id: transaction.id!,
              summary: `Auto-confirmed transaction ${transaction.id} against invoice ${invoiceId}`,
              details: {
                amount: transaction.amount,
                invoice_id: invoiceId,
                ...(clientReassignedToInvoice ? { client_reassigned_to_invoice: true } : {}),
              },
            });
          } catch (error) {
            recordPostCreateFailure(
              error,
              error instanceof TransactionMaterialDriftError ? "transaction_drift" : "transaction_confirmation",
              observedInvoiceStatus,
              isAmbiguousPostCreateFailure(error) ? "UNKNOWN" : "PROJECT",
            );
            continue;
          }

          if (clientReassignedToInvoice) {
            notes.push(
              `Transaction ${transaction.id}: payer client ${freshTransaction.clients_id} replaced by supplier client ${supplierId} `
              + `so the payable is booked under the invoice's supplier (bank payer name kept).`
            );
          }
          linkedTransactionIds.push(transaction.id!);
        }

        const status = dryRun
          ? (wouldCreateCount > 0 ? "dry_run_preview" : "skipped")
          : partialMutations.length > 0
            ? "failed"
            : attemptedCreateCount > 0 && linkedTransactionIds.length === attemptedCreateCount
              ? "applied"
              : attemptedCreateCount > 0
                ? "failed"
                : "skipped";

        if (status === "failed" && linkedTransactionIds.length > 0) {
          notes.push(
            `Group reported as failed; the following transactions were already booked successfully and were left in place: ${linkedTransactionIds.join(", ")}.`
          );
        }

        results.push({
          category: group.category,
          counterparty: group.display_counterparty,
          status,
          notes,
          transactions: transactionIds,
          created_invoice_ids: dryRun ? undefined : createdInvoiceIds,
          linked_transaction_ids: dryRun ? undefined : linkedTransactionIds,
          partial_mutations: partialMutations.length > 0 ? partialMutations : undefined,
        });
      } catch (error) {
        // Upstream error bodies are untrusted: this loop calls create/resolve
        // with values derived from display_counterparty, so a backend validation
        // error can echo remitter-controlled text back. Same treatment as the
        // invalidation note above.
        const message = error instanceof Error ? error.message : String(error);
        notes.push(wrapUntrustedText(message) ?? message);
        results.push({
          category: group.category,
          counterparty: group.display_counterparty,
          status: "failed",
          notes,
          transactions: transactionIds,
          created_invoice_ids: dryRun ? undefined : createdInvoiceIds,
          linked_transaction_ids: dryRun ? undefined : linkedTransactionIds,
          partial_mutations: partialMutations.length > 0 ? partialMutations : undefined,
        });
      }
    }

    const summary = {
      applied: results.filter(result => result.status === "applied").length,
      skipped: results.filter(result => result.status === "skipped").length,
      dry_run_preview: results.filter(result => result.status === "dry_run_preview").length,
      failed: results.filter(result => result.status === "failed").length,
    };
    const mode = dryRun ? "DRY_RUN" : "EXECUTED";

    // P0-2 dry_run_apply: mint the consume-once handle bound to the FRESH
    // canonical effect. execute_apply must present it and recompute an identical
    // fingerprint. The preview `results` above are the operator's review surface;
    // the plan fingerprint is the machine-checked binding of that same effect.
    let planHandle: string | undefined;
    if (dryRun) {
      const planInput: ExecutionPlanInput = {
        normalizedArgs: fingerprint,
        sourceIdentities: [],
        liveSnapshot: {
          groups: groups.length,
          bookable_groups: (fingerprint.groups as PlanData[] | undefined)?.filter(
            group => typeof group === "object" && group !== null && !Array.isArray(group) && (group as Record<string, PlanData>).bookable === true,
          ).length ?? 0,
        },
        commands: [{ id: "bank-classification-apply", category: "bank_classification_apply", reviewProjection: { groups: groups.length } }],
        counts: { groups: groups.length },
        totals: {},
        exclusions: [],
        reviews: [],
        privatePayload: { schema: "bank_classification_apply_v1" },
      };
      planHandle = this.runtimeSafetyContext.planStore.issue(BANK_CLASSIFICATION_PLAN_DOMAIN, planInput);
    }

    return ok({ mode, dryRun, summary, results, ...(planHandle !== undefined ? { planHandle } : {}) });
  }
}

export function createClassificationOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  wrapUntrustedText: WrapUntrustedText,
): ClassificationOperations {
  return new ClassificationOperationsImpl(api, runtimeSafetyContext, wrapUntrustedText);
}
