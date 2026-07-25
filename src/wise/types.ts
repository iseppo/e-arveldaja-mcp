import type { ApiContext } from "../tools/crud/shared.js";
import type { PurchaseInvoice } from "../types/api.js";

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

export interface WiseTransferReview {
  wise_id: string;
  code: "wise_transfer_dimensions_unverified" | "wise_transfer_ownership_unverified";
  reason: string;
  source_verified: boolean;
  target_verified: boolean;
  approval_required: boolean;
}

export interface WiseTransferDecision {
  targetDimensionId?: number;
  sourceVerified: boolean;
  targetVerified: boolean;
  ownershipBasis?: WiseTransferOwnershipBasis;
  review?: WiseTransferReview;
}

// --- M05: strict Wise row validation -----------------------------------------

export interface ImportRejectedField {
  source_row_id: string;
  field: string;
  value: string;
  reason: string;
}

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

export const WISE_COMMAND_VERSION = "wise_import_command_v2";

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
  mutation_mode: "create";
  create_payload: TransactionCreatePayload;
}

export interface FeeCreateCommand extends WiseCommandBase {
  action: "fee_create_and_confirm";
  mutation_mode: "create_then_confirm";
  posting_account_id: number;
  posting_dimension_id: number;
  create_payload: TransactionCreatePayload;
  confirmation_distribution: TransactionConfirmPayload;
  wise_client_id: number;
}

export interface InterAccountCommand extends WiseCommandBase {
  action: "inter_account";
  mutation_mode: "create_then_confirm" | "create_only_already_journalized";
  counterpart_dimension_id: number;
  flow_source_dimension_id: number;
  flow_target_dimension_id: number;
  posting_account_id: number;
  posting_dimension_id: number;
  ownership_basis: WiseTransferOwnershipBasis;
  existing_journal_id: number | null;
  client_update: { clients_id: number } | null;
  confirmation_distribution: TransactionConfirmPayload | null;
  current_journal_state: unknown;
  current_client_state: unknown;
}

export interface PurchaseInvoiceUpdateCommand extends WiseCommandBase {
  action: "purchase_invoice_update";
  mutation_mode: "update_existing";
  existing_object_id: number;
  update_payload: Partial<PurchaseInvoice>;
  category: "foreign_currency_lock" | "eur_legacy_autofix";
  current_object_state: PurchaseInvoice;
}

export type WiseImportCommand = MainCreateCommand | FeeCreateCommand | InterAccountCommand | PurchaseInvoiceUpdateCommand;

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
  /** Currency this row is booked in, for entries that carry no `source_row`
   * (fee rows are synthesised, not lifted from a CSV line). Presentation only —
   * the amount is already the booked figure. */
  booked_currency?: string;
}

export interface WiseSkippedEntry {
  wise_id: string;
  reason: string;
}

export interface WiseSkippedJarRow {
  wise_id: string;
  reason: string;
  amount: number;
  date: string;
}

export interface WiseInterAccountResult {
  api_id: number;
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
  result?: "would_update" | "updated" | "error" | "ambiguous_skipped" | "already_matches";
  error?: string;
  current_object_state: PurchaseInvoice;
}

export type { PurchaseInvoice };
