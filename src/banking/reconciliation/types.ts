import type { Transaction } from "../../types/api.js";
import type { PlanExecutionReport } from "../../plan-execution.js";
import type {
  DuplicatePostingCandidate,
  DuplicatePostingScanResult,
  DuplicatePostingSuspect,
} from "../../bank-posting-duplicate-guard.js";
import type { OperationOutcome } from "../../operation-outcome.js";
import type { OneSidedEurAmountErrorCode } from "./amount-resolution.js";
import type {
  ReceiptLedgerFailureCode,
  ReceiptLedgerFailureDetails,
} from "../receipt-ledger-check.js";

// ---------------------------------------------------------------------------
// Interfaces for the reconciliation typed operations. PURE type-only module.
// ---------------------------------------------------------------------------

// --- Exact-match confirm projection ------------------------------------------

export type ExactConfirmClientResolution = "unchanged" | "set_missing";

export type ThirdPartyPayerReviewReason = "third_party_payer" | "invoice_client_missing";

/** A unique exact match whose payer client cannot be reconciled with the
 * invoice's client, so it is reviewed instead of confirmed. `invoice_number` is
 * RAW domain text — the presenter is the sole sandbox site. */
export interface ThirdPartyPayerReview {
  transaction_id: number;
  date?: string;
  amount: number;
  currency: string;
  invoice_type: "sale_invoice" | "purchase_invoice";
  invoice_id: number;
  invoice_number: string;
  transaction_clients_id: number | null;
  invoice_clients_id: number | null;
  confidence: number;
  reason: ThirdPartyPayerReviewReason;
  next_action: string;
}

/** One failed post-confirm receipt-ledger invariant. The confirm ALREADY
 * mutated, so this is reported as an execution error, never as a skip. */
export interface ExactConfirmLedgerCheckFailure {
  transaction_id: number;
  journal_id?: number;
  code: ReceiptLedgerFailureCode;
  details: ReceiptLedgerFailureDetails;
}

export interface ExactConfirmLedgerChecks {
  checked: number;
  ok: number;
  failures: ExactConfirmLedgerCheckFailure[];
  /** The ledger re-read itself failed (e.g. network). Advisory — a check that
   * could not run never turns a completed confirm into a failure. */
  warnings?: string[];
}

export interface ExactConfirmDescriptor {
  transactionId: number;
  date?: string;
  amount: number;
  currency: string;
  clientsId: number | null;
  invoiceType: "sale_invoice" | "purchase_invoice";
  invoiceTable: "sale_invoices" | "purchase_invoices";
  invoiceId: number;
  invoiceNumber: string;
  invoiceClientsId: number | null;
  confidence: number;
  /** How the confirm reconciles the transaction's client with the invoice's.
   * "set_missing": the transaction carries no client, so the invoice's is
   * copied onto it before registering. "unchanged": it already carries the
   * invoice's client. A DIFFERING payer is never auto-confirmed — it leaves
   * `confirms` entirely and becomes a ThirdPartyPayerReview, because
   * journal.clients_id is copied from the transaction and would file the
   * receivable/payable leg in the payer's sub-ledger. */
  clientResolution: ExactConfirmClientResolution;
  /** Derived view of `clientResolution` === "set_missing". */
  needsClientUpdate: boolean;
  // Cash-leg identity for the cross-mechanism duplicate guard (Task 3). The
  // dimension resolves to a bank account via resolveBankDimensions; direction
  // mirrors createBankTransaction (incoming -> D, else C).
  accountsDimensionsId: number | undefined;
  direction: "D" | "C";
  // EUR-equivalent of `amount` (base_amount ?? amount). The cross-mechanism
  // duplicate scan compares against journal postings' EUR base_amount, so the
  // scan candidate must use this, not the nominal `amount` (which stays nominal
  // for the actual confirm distribution).
  baseAmount: number;
  possibleDuplicatePostings?: DuplicatePostingSuspect[];
}

export interface BlockedDuplicateSuspect {
  transaction_id: number;
  reason: string;
  conflicting_journal_ids: number[];
  suspects: DuplicatePostingSuspect[];
}

export interface ExactMatchProjection {
  totalUnconfirmed: number;
  confirms: ExactConfirmDescriptor[];
  skipped: Array<{ transaction_id?: number; reason: string }>;
  /** Unique exact matches partitioned OUT of `confirms` because the payer is
   * not the invoice client (or the invoice has no client). The invoice key is
   * still consumed, so no second transaction can claim the same invoice. */
  thirdPartyPayerReviews: ThirdPartyPayerReview[];
  // Populated by enrichExactMatchProjectionWithDuplicateGuard (Task 3).
  blockedDuplicateSuspects: BlockedDuplicateSuspect[];
  duplicateScanNote?: string;
  // RAW scan inputs for the POSSIBLE-duplicate warning lines. Clean domain data:
  // the presenter (the sole sandbox site) formats them, wrapping the untrusted
  // journal title with wrapUntrustedOcr. NEVER part of the byte-stable digest.
  duplicateWarningInputs?: Array<{ scan: DuplicatePostingScanResult; candidate: DuplicatePostingCandidate }>;
}

// --- Suggest render rows -----------------------------------------------------

// Free-text fields (description/bank_account_name/ref_number, best_match.number/
// client_name/ref_number, possible_duplicate_postings) carry RAW domain text;
// the presenter is the sole sandbox site (wrapUntrustedOcr) for both the full
// and compact renders.
export interface SuggestMatchRow {
  transaction_id: number | undefined;
  date: string | undefined;
  amount: number;
  description?: string;
  bank_account_name?: string;
  ref_number?: string;
  best_match: Record<string, unknown>;
  other_candidate_count: number;
  distribution?: { related_table: string; related_id: number; amount: number };
  possible_duplicate_postings?: Array<Record<string, unknown>>;
  duplicate_blocked?: true;
  manual_review_required?: string;
}

/** Compact-only aggregates for the guided surface. The FULL envelope ignores
 * these, so standard/full output stays byte-identical. */
export interface ReconciliationSuggestCompact {
  matchedTotalsByCurrency: Record<string, number>;
  accountLabels: string[];
  dateFrom?: string;
  dateTo?: string;
}

export interface ReconciliationSuggestions {
  totalUnconfirmed: number;
  matched: number;
  unmatched: number;
  // RAW match rows (see SuggestMatchRow) — the presenter wraps free-text.
  matches: Array<Record<string, unknown>>;
  duplicateScanNote?: string;
  compact?: ReconciliationSuggestCompact;
}

// --- Inter-account row shapes ------------------------------------------------

export interface PairResult {
  outgoing_transaction_id: number;
  incoming_transaction_id: number;
  amount: number;
  date_out: string;
  date_in: string;
  from_account: string;
  to_account: string;
  from_dimension_id: number;
  to_dimension_id: number;
  // RAW transaction descriptions — the presenter wraps them (wrapUntrustedOcr).
  description_out?: string | null;
  description_in?: string | null;
  confidence: number;
  match_reasons: string[];
  status: string;
  incoming_action?: "deleted" | "orphan" | "would_delete_duplicate";
  incoming_note?: string;
}

export interface AmbiguousPairResult {
  outgoing_transaction_id: number;
  amount: number;
  date_out: string;
  from_dimension_id: number;
  candidate_incoming_transaction_ids: number[];
  candidate_incoming_dimension_ids: number[];
  confidence: number;
  reason: string;
}

export interface OneSidedResult {
  transaction_id: number;
  type: string;
  amount: number;
  currency: string;
  amount_eur: number;
  date: string;
  source_account: string;
  source_dimension_id: number;
  target_account: string;
  target_dimension_id: number;
  // RAW transaction free-text — the presenter wraps it (wrapUntrustedOcr).
  description?: string | null;
  counterparty_name?: string | null;
  confidence: number;
  match_reasons: string[];
  status: string;
}

export interface SkippedAlreadyHandledRow {
  transaction_id: number; amount: number; date: string;
  currency?: string; amount_eur?: number;
  source_account: string; source_dimension_id?: number;
  target_account?: string; target_dimension_id?: number;
  existing_journal_id: number; reason: string;
}

export interface AmbiguousReflessRow {
  transaction_ids: number[]; amount: number; date: string;
  currency?: string; amount_eur?: number;
  source_account: string; target_account: string; reason: string;
}

export interface CrossCurrencyRow {
  transaction_ids: number[]; amount_out: number; amount_in: number; date: string;
  source_account: string; target_account: string; reason: string;
}

export interface InterAccountErrorRow {
  transaction_ids: number[]; code?: OneSidedEurAmountErrorCode; reason: string;
}

/** Intended confirm/delete/client-update actions collected during matching. */
export interface InterAccountConfirmAction {
  confirmedTxId: number;
  confirmedClientsId: number | null;
  confirmedNominalAmount: number;
  confirmedCurrency: string;
  targetDimensionId: number;
  distributionAmount: number;
  deleteTxId?: number;
  auditSummary: string;
  auditDetails: Record<string, unknown>;
  deleteAuditSummary?: string;
  deleteAuditDetails?: Record<string, unknown>;
}

/** The read-only matching projection shared by inter-account dry run + execute. */
export interface InterAccountMatchResult {
  totalUnconfirmed: number;
  invoiceInfo: { invoice_company_name?: string | null };
  dimensionToIban: Map<number, string>;
  dimensionToTitle: Map<number, string>;
  /** Dimension → accounts_id, needed only by the execute-path distribution build. */
  dimensionToAccountsId: Map<number, number>;
  matchedPairs: PairResult[];
  matchedOneSided: OneSidedResult[];
  ambiguousPairs: AmbiguousPairResult[];
  skippedAlreadyHandled: SkippedAlreadyHandledRow[];
  ambiguousRefless: AmbiguousReflessRow[];
  crossCurrencyPairs: CrossCurrencyRow[];
  errors: InterAccountErrorRow[];
  confirmActions: InterAccountConfirmAction[];
  companyClientsId: number | null;
  normalizedArgs: Record<string, unknown>;
  fingerprint: string;
}

// --- Operation input / output ------------------------------------------------

export interface SuggestMatchesInput {
  readonly minConfidence: number | undefined;
  readonly blockOnDuplicate: boolean | undefined;
}

export interface ExactConfirmInput {
  readonly minConfidence: number | undefined;
  readonly blockOnDuplicate: boolean | undefined;
}

export interface ExactConfirmExecutionInput extends ExactConfirmInput {
  readonly planHandle: string | undefined;
}

export interface ExactConfirmPreview {
  projection: ExactMatchProjection;
  planHandle: string;
  threshold: number;
}

export interface ExactConfirmExecution {
  projection: ExactMatchProjection;
  executionReport: PlanExecutionReport;
  threshold: number;
  ledgerChecks: ExactConfirmLedgerChecks;
}

export interface InterAccountInput {
  readonly maxDateGap: number | undefined;
  readonly targetAccountsDimensionsId: number | undefined;
}

export interface InterAccountExecutionInput extends InterAccountInput {
  readonly planHandle: string | undefined;
}

export interface InterAccountPreview {
  match: InterAccountMatchResult;
  planHandle: string;
}

export interface InterAccountExecution {
  match: InterAccountMatchResult;
  executionReport: PlanExecutionReport;
}

export interface BankReconciliationOperations {
  suggestMatches(input: SuggestMatchesInput): Promise<OperationOutcome<ReconciliationSuggestions>>;
  prepareExactConfirm(input: ExactConfirmInput): Promise<OperationOutcome<ExactConfirmPreview>>;
  executeExactConfirm(input: ExactConfirmExecutionInput): Promise<OperationOutcome<ExactConfirmExecution>>;
  prepareInterAccount(input: InterAccountInput): Promise<OperationOutcome<InterAccountPreview>>;
  executeInterAccount(input: InterAccountExecutionInput): Promise<OperationOutcome<InterAccountExecution>>;
}
