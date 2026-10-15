import type { ApiContext } from "../tools/crud/shared.js";
import type { PurchaseInvoice } from "../types/api.js";
import type { ImportRejectedField } from "../camt/preflight.js";

// --- Parsed Wise rows --------------------------------------------------------

export interface WiseRow {
  rowIndex: number;
  id: string;
  status: string;
  direction: string;
  createdOn: string;
  finishedOn: string;
  sourceFeeAmount: number;
  sourceFeeCurrency: string;
  targetFeeAmount: number;
  targetFeeCurrency: string;
  sourceName: string;
  sourceAmount: number;
  sourceCurrency: string;
  targetName: string;
  targetAmount: number;
  targetCurrency: string;
  exchangeRate: number;
  reference: string;
  category: string;
  note: string;
}

export type WiseTransferOwnershipBasis = "verified_endpoints" | "operator_approved";

/** How a transfer row's counterpart bank account was determined: own-account
 * evidence on that bank, the explicit inter_account_dimension_id, or the
 * company's only other bank account. */
export type WiseCounterpartBasis = "evidence" | "explicit" | "only_other_bank";

export interface WiseTransferReview {
  wise_id: string;
  code:
    | "wise_transfer_dimensions_unverified"
    | "wise_transfer_ownership_unverified"
    | "wise_transfer_cross_currency"
    | "wise_transfer_journal_ambiguous"
    | "wise_transfer_journal_inconsistent"
    | "wise_transfer_already_imported"
    | "wise_legacy_leg_ambiguous"
    | "wise_transfer_mapping_rejected"
    | "unused_mapping"
    | "unused_acknowledgement"
    | "wise_untagged_ledger_match"
    | "wise_transfer_counterpart_conflict"
    | "wise_transfer_journal_existing_elsewhere";
  reason: string;
  source_verified: boolean;
  target_verified: boolean;
  approval_required: boolean;
  /** wise_transfer_journal_ambiguous: the same-key (±1 day) journals the row
   * could not be told apart from; wise_transfer_journal_inconsistent: the
   * journals labelled with the row's Wise ID. */
  candidate_journal_ids?: number[];
  candidates?: WiseTransferJournalCandidate[];
  /** wise_transfer_mapping_rejected / unused_mapping: the mapped journal. */
  journal_id?: number;
  /** wise_transfer_journal_ambiguous / _inconsistent: candidate journals that already book the
   * row's fee, so the fee row is held out of the plan with the review. */
  fee_held_journal_ids?: number[];
  /** wise_untagged_ledger_match: the stored untagged rows that look like this one. */
  ledger_transaction_ids?: number[];
  /** Counterpart holds: the own bank account dimensions the evidence points to
   * (conflict), or every other configured bank account (unresolved). */
  counterpart_candidate_dimension_ids?: number[];
  /** Counterpart holds: the other banks' stored transactions behind the hold. */
  evidence_transaction_ids?: number[];
  /** Releasable Wise-side journal holds (wise_transfer_journal_ambiguous /
   * _existing_elsewhere): every journal acknowledged_journal_holds must list
   * to release the row (all pending legs, certain and uncertain evidence, and
   * the ambiguous candidates). */
  required_acknowledgement_ids?: number[];
  /** Journals that may move this row's amount on the Wise account but cannot
   * be shown to (composite journal, or no shared currency). */
  uncertain_journal_ids?: number[];
  /** Journals that may book this row's fee leg. */
  fee_leg_journal_ids?: number[];
  /** A short acknowledged_journal_holds entry: the required journals it did not list. */
  unacknowledged_journal_ids?: number[];
}

/** One owner acknowledgement (acknowledged_journal_holds): the listed journals
 * do not book this Wise transfer. Releases a held row only when it lists every
 * required_acknowledgement_ids journal. */
export interface WiseAcknowledgedJournalHold {
  wise_id: string;
  journal_ids: number[];
}

/** One operator-reviewed journalized_transfer_ids entry. */
export interface WiseJournalizedTransferMapping {
  wise_id: string;
  journal_id: number;
}

export interface WiseTransferJournalCandidate {
  journal_id: number;
  /** The journal's source bank transaction, when it is a live row on another
   * own bank dimension. */
  counterpart_transaction_id?: number;
  /** "counterpart_bank_ref" when the journal's document_number is that bank
   * row's bank_ref_number. Informational only: it tells where the label came
   * from, not which Wise movement the journal books. */
  label_source: "counterpart_bank_ref" | "other";
}

export interface WiseTransferDecision {
  targetDimensionId?: number;
  /** Set when targetDimensionId came from the per-row counterpart resolution. */
  counterpartBasis?: WiseCounterpartBasis;
  /** The row's counterpart cannot be determined, or evidence contradicts the
   * selected one: a hard hold, its only review; the row is not imported. */
  counterpartHold?: WiseTransferReview;
  sourceVerified: boolean;
  targetVerified: boolean;
  ownershipBasis?: WiseTransferOwnershipBasis;
  review?: WiseTransferReview;
}

// --- M05: strict Wise row validation -----------------------------------------

// One rejected-field shape for both importers (the CAMT definition).
export type { ImportRejectedField } from "../camt/preflight.js";

export type WisePreflightResult =
  | { ok: true; source: "wise"; rows: WiseRow[] }
  | { ok: false; source: "wise"; rejected_fields: ImportRejectedField[] };

/**
 * Fields whose VALUE is derived by validation. `id`, `status`, and `direction`
 * are deliberately absent: they are validated but stored raw, because their
 * stored bytes decide filtering eligibility and M04 identity.
 */
export interface ValidatedWiseFields {
  createdOn: string; finishedOn: string;
  sourceAmount: number; targetAmount: number;
  sourceCurrency: string; targetCurrency: string;
  sourceFeeAmount: number; targetFeeAmount: number;
  exchangeRate: number;
}

// --- Compiled commands -------------------------------------------------------

// v4 dropped the constant/always-null command fields (mutation_mode, and the
// inter-account existing_journal_id / current_journal_state /
// current_client_state): a v3 plan's digest never matches a v4 rebuild.
export const WISE_COMMAND_VERSION = "wise_import_command_v4";

export type TransactionCreatePayload = Parameters<ApiContext["transactions"]["create"]>[0];
export type TransactionConfirmPayload = Parameters<ApiContext["transactions"]["confirm"]>[1];

export interface WiseCommandBase {
  version: typeof WISE_COMMAND_VERSION;
  row_index: number;
  row_key: string;
  identity_hash: string;
  wise_id: string;
  date: string;
  transaction_type: "C" | "D";
  source_direction: "IN" | "OUT";
  booked_amount: number;
  booked_currency: string;
  source_amount: number;
  source_currency: string;
  target_amount: number;
  target_currency: string;
  exchange_rate: number;
  exchange_rate_orientation: "source_to_target";
  wise_dimension_id: number;
  depends_on: string | null;
}

export interface MainCreateCommand extends WiseCommandBase {
  action: "main_create";
  create_payload: TransactionCreatePayload;
}

export interface FeeCreateCommand extends WiseCommandBase {
  action: "fee_create_and_confirm";
  posting_account_id: number;
  posting_dimension_id: number;
  create_payload: TransactionCreatePayload;
  confirmation_distribution: TransactionConfirmPayload;
  wise_client_id: number;
}

export interface InterAccountCommand extends WiseCommandBase {
  action: "inter_account";
  counterpart_dimension_id: number;
  flow_source_dimension_id: number;
  flow_target_dimension_id: number;
  posting_account_id: number;
  posting_dimension_id: number;
  ownership_basis: WiseTransferOwnershipBasis;
  client_update: { clients_id: number } | null;
  confirmation_distribution: TransactionConfirmPayload | null;
}

export type WiseImportCommand = MainCreateCommand | FeeCreateCommand | InterAccountCommand;

/** An approved own transfer an existing journal already books. Not a command:
 * nothing is written for it. The plan digest binds it, and execute re-checks
 * the journal once after all writes. */
export interface WiseAlreadyJournalizedAssertion {
  row_index: number;
  row_key: string;
  wise_id: string;
  date: string;
  booked_amount: number;
  booked_currency: string;
  source_direction: "IN" | "OUT";
  ownership_basis: WiseTransferOwnershipBasis;
  existing_journal_id: number;
  current_journal_state: unknown;
}

// --- Preview / execution accumulators ----------------------------------------

export interface WiseCreatedEntry {
  wise_id: string;
  date: string;
  type: string;
  source_direction: "IN" | "OUT";
  amount: number;
  description: string;
  status: string;
  api_id?: number;
  source_row?: WiseRow;
  /** Transfer rows: the counterpart bank account dimension and how it was found. */
  counterpart_dimension_id?: number;
  counterpart_basis?: WiseCounterpartBasis;
  /** Currency this row is booked in, for entries that carry no `source_row`
   * (fee rows are synthesised, not lifted from a CSV line). Presentation only —
   * the amount is already the booked figure. */
  booked_currency?: string;
}

export interface WiseSkippedEntry {
  wise_id: string;
  reason: string;
  /** Set when an automatic match (not the row's own WISE: tag) kept the row
   * out of the plan: names the stored transaction or journal it was matched
   * to, so a wrong match can be undone by correcting that record. */
  auto_match?: {
    code: "wise_untagged_ledger_unique" | "wise_transfer_journal_unique_legacy";
    transaction_id?: number;
    journal_id?: number;
  };
}

export interface WiseSkippedJarRow {
  wise_id: string;
  reason: string;
  amount: number;
  date: string;
}

export interface WiseInterAccountResult {
  /** Absent for an already-journalized transfer: no Wise bank row is created. */
  api_id?: number;
  wise_id: string;
  amount: number;
  status: string;
  ownership_basis: WiseTransferOwnershipBasis;
  journal_id?: number;
  orphan_project_transaction_id?: number;
  orphan_action_hint?: string;
}

export interface WiseInvoiceFixCandidate {
  row_index: number;
  wise_id: string;
  date: string;
  supplier_name: string;
  target_amount: number;
  target_currency: string;
  source_amount_eur: number;
  wise_currency_rate: number;
  invoice_id: number;
  invoice_number: string;
  invoice_currency: string;
  invoice_gross: number;
  current_base_gross?: number;
  current_currency_rate?: number;
  category: "foreign_currency_lock" | "eur_legacy_autofix";
  proposed_action: string;
  /** The correction the operator may apply by hand. Advisory only: the Wise
   * import never modifies a confirmed purchase invoice. */
  proposed_correction: { currency_rate: number; base_gross_price: number } | { gross_price: number };
  result?: "advisory" | "ambiguous_skipped";
  current_object_state: PurchaseInvoice;
}

export type { PurchaseInvoice };
