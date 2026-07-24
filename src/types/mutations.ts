// Operation-specific mutation REQUEST types for the four high-risk API
// boundaries (bank transactions, journals, purchase invoices, sale invoices).
//
// These replace `Partial<Model>` at each create/update signature. Their whole
// point is OMISSION: a request type lists only caller-settable fields and drops
// server-managed / read-only ones (id, status, payment_status, timestamps,
// computed totals, journal/settlement back-references, …). An object literal
// that tries to set an omitted field fails the excess-property check at compile
// time — that is the hardening. They do NOT change the tool surface or any
// response bytes; this is internal type-safety only.

import type {
  CreatePurchaseInvoiceData,
  Journal,
  PurchaseInvoice,
  SaleInvoice,
  Transaction,
} from "./api.js";

// Lightweight nominal aliases — deliberately NOT validated at runtime and with
// no validation-library dependency. The optional brand keeps them structurally
// assignable from a plain `string`, so every existing caller that passes a raw
// currency code / ISO date string keeps compiling; the alias documents intent
// and gives a future tightening hook without a happy-path behaviour change.
export type CurrencyCode = string & { readonly __brand?: "CurrencyCode" };
export type IsoDate = string & { readonly __brand?: "IsoDate" };

// === Bank transactions ======================================================

// Verbatim from the plan. OMITS every server-managed / read-only field:
// `id`, `status`, `type` (the D/C cash-leg discriminator — derived from the
// statement direction, never caller-settable), `base_amount`, `currency_rate`,
// `bank_accounts_id`, `operation_type`, `is_deleted`, `items`, `uploaded_files_id`,
// `transactions_files_id`, `export_format`, `bank_code`, `bank_subtype`,
// `accounts_id`.
export interface CreateBankTransactionRequest {
  accounts_dimensions_id: number;
  amount: number;
  cl_currencies_id: CurrencyCode;
  date: IsoDate;
  description?: string;
  clients_id?: number;
  bank_account_name?: string;
  bank_account_no?: string;
  ref_number?: string;
  bank_ref_number?: string;
}

// The actual write payload sent to `transactions.create`. `type` is the
// server-semantic cash-leg direction, set ONLY by `createBankTransaction` at the
// single write boundary (derived from the explicit direction / signed
// source_direction). It is optional here because nothing else may set it, and it
// is intentionally absent from the caller-facing `CreateBankTransactionRequest`.
export type CreateBankTransactionPayload = CreateBankTransactionRequest & {
  type?: string;
};

// `update_transaction` is deliberately metadata-scoped (bank-reference /
// description fields only — never amounts, postings, or distributions). The one
// non-metadata field allowed is `clients_id`: the confirm auto-fix sets it and
// its rollback clears it back to null (transactions.api.ts:81/140), so the type
// must permit `number | null`.
export type UpdateBankTransactionRequest = Partial<
  Pick<
    Transaction,
    "bank_ref_number" | "bank_account_name" | "bank_account_no" | "description" | "ref_number"
  >
> & {
  clients_id?: number | null;
};

// === Journals ===============================================================

// Server-managed / read-only journal fields the caller must not set.
type JournalServerManagedFields =
  | "id"
  | "number"
  | "amendment_number"
  | "registered"
  | "operations_id"
  | "operation_type"
  | "insert_date"
  | "register_date"
  | "is_deleted"
  | "is_xls_imported";

// Fields stay optional (not required like the bank-transaction request) so the
// legitimate `Partial<Journal>`-building callers (BookingGuard.createJournalOnce)
// keep compiling; the value of the type is the OMISSION of the server fields.
export type CreateJournalRequest = Partial<Omit<Journal, JournalServerManagedFields>>;
export type UpdateJournalRequest = CreateJournalRequest;

// === Purchase invoices ======================================================

// The create boundary already had a dedicated caller-field type; reuse it.
export type CreatePurchaseInvoiceRequest = CreatePurchaseInvoiceData;

type PurchaseInvoiceServerManagedFields =
  | "id"
  | "status"
  | "payment_status"
  | "is_deleted"
  | "journals"
  | "settlements"
  | "transactions"
  | "is_xls_imported";

export type UpdatePurchaseInvoiceRequest = Partial<
  Omit<PurchaseInvoice, PurchaseInvoiceServerManagedFields>
>;

// === Sale invoices ==========================================================

type SaleInvoiceServerManagedFields =
  | "id"
  | "number"
  | "status"
  | "payment_status"
  | "is_deleted"
  | "files_id"
  | "journals"
  | "settlements"
  | "transactions"
  | "credit_invoices"
  | "deliveries"
  | "is_xls_imported";

export type CreateSaleInvoiceRequest = Partial<Omit<SaleInvoice, SaleInvoiceServerManagedFields>>;
export type UpdateSaleInvoiceRequest = CreateSaleInvoiceRequest;
