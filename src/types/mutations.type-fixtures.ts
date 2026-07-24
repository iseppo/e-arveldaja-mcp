// Compile-time-only fixtures for the mutation request types.
//
// This file has NO runtime behaviour — every value is discarded. It lives in the
// build (NOT under **/*.test.ts, which tsc excludes) precisely so `npm run build`
// type-checks it: each `@ts-expect-error` below is a REAL negative fixture that
// fails to compile without the directive. If a request type ever stopped omitting
// a server-managed field, the corresponding directive would become unused and
// tsc would fail with "Unused '@ts-expect-error' directive" — turning a silent
// regression into a build break.
//
// The positive fixtures assert the accepted caller fields DO compile.

import type {
  CreateBankTransactionRequest,
  CreateJournalRequest,
  CreatePurchaseInvoiceRequest,
  CreateSaleInvoiceRequest,
  UpdateBankTransactionRequest,
  UpdateJournalRequest,
  UpdatePurchaseInvoiceRequest,
  UpdateSaleInvoiceRequest,
} from "./mutations.js";

// --- Bank transactions ------------------------------------------------------

// Positive: the accepted caller-settable fields compile.
export const validBankTxCreate: CreateBankTransactionRequest = {
  accounts_dimensions_id: 12345,
  amount: 100.5,
  cl_currencies_id: "EUR",
  date: "2026-07-24",
  description: "Office supplies",
  clients_id: 42,
  bank_account_name: "Acme OÜ",
  bank_account_no: "EE001234567890",
  ref_number: "REF-1",
  bank_ref_number: "2026070100001",
};

// Negative: the raw API `type` cash-leg discriminator is NOT caller-settable —
// it is derived from the statement direction in createBankTransaction. This is
// the load-bearing direction-trust guarantee.
export const bankTxCreateRejectsType: CreateBankTransactionRequest = {
  accounts_dimensions_id: 1,
  amount: 1,
  cl_currencies_id: "EUR",
  date: "2026-07-24",
  // @ts-expect-error `type` is server-derived, not caller-settable.
  type: "C",
};

// Negative: server-managed id.
export const bankTxCreateRejectsId: CreateBankTransactionRequest = {
  accounts_dimensions_id: 1,
  amount: 1,
  cl_currencies_id: "EUR",
  date: "2026-07-24",
  // @ts-expect-error `id` is server-assigned.
  id: 99,
};

// Negative: server-managed status.
export const bankTxCreateRejectsStatus: CreateBankTransactionRequest = {
  accounts_dimensions_id: 1,
  amount: 1,
  cl_currencies_id: "EUR",
  date: "2026-07-24",
  // @ts-expect-error `status` is server-managed (PROJECT/CONFIRMED/VOID).
  status: "CONFIRMED",
};

// Positive: metadata-scoped update with the legitimate null-clear of clients_id.
export const validBankTxUpdate: UpdateBankTransactionRequest = {
  bank_ref_number: "2026070100002",
  description: "corrected",
  clients_id: null,
};

// Negative: amount is never metadata-updatable.
export const bankTxUpdateRejectsAmount: UpdateBankTransactionRequest = {
  // @ts-expect-error `amount` is a ledger field, not metadata.
  amount: 5,
};

// --- Journals ---------------------------------------------------------------

export const validJournalCreate: CreateJournalRequest = {
  title: "Manual entry",
  effective_date: "2026-07-24",
  document_number: "BANK:stmt-1",
  cl_currencies_id: "EUR",
  postings: [{ accounts_id: 1020, type: "D", amount: 10 }],
};

export const journalCreateRejectsRegistered: CreateJournalRequest = {
  effective_date: "2026-07-24",
  postings: [{ accounts_id: 1020, type: "D", amount: 10 }],
  // @ts-expect-error `registered` is server-managed (set by confirm).
  registered: true,
};

export const journalCreateRejectsNumber: CreateJournalRequest = {
  effective_date: "2026-07-24",
  postings: [],
  // @ts-expect-error `number` is server-assigned.
  number: 500,
};

export const validJournalUpdate: UpdateJournalRequest = { title: "renamed" };

// --- Purchase invoices ------------------------------------------------------

export const validPurchaseUpdate: UpdatePurchaseInvoiceRequest = {
  vat_price: 20,
  gross_price: 120,
  notes: "note",
};

export const purchaseUpdateRejectsStatus: UpdatePurchaseInvoiceRequest = {
  // @ts-expect-error `status` is server-managed.
  status: "CONFIRMED",
};

export const purchaseUpdateRejectsPaymentStatus: UpdatePurchaseInvoiceRequest = {
  // @ts-expect-error `payment_status` is server-managed.
  payment_status: "PAID",
};

// Positive: the create request is the caller-field data type (items + header).
export const validPurchaseCreate: CreatePurchaseInvoiceRequest = {
  clients_id: 1,
  client_name: "Supplier OÜ",
  number: "INV-1",
  create_date: "2026-07-24",
  journal_date: "2026-07-24",
  term_days: 14,
  cl_currencies_id: "EUR",
  items: [],
};

// --- Sale invoices ----------------------------------------------------------

export const validSaleCreate: CreateSaleInvoiceRequest = {
  clients_id: 1,
  cl_templates_id: 2,
  sale_invoice_type: "INVOICE",
  create_date: "2026-07-24",
  journal_date: "2026-07-24",
  term_days: 14,
  cl_currencies_id: "EUR",
  show_client_balance: false,
};

export const saleCreateRejectsNumber: CreateSaleInvoiceRequest = {
  clients_id: 1,
  cl_templates_id: 2,
  // @ts-expect-error `number` is server-assigned from the invoice series.
  number: "2026-100",
};

export const saleUpdateRejectsPaymentStatus: UpdateSaleInvoiceRequest = {
  // @ts-expect-error `payment_status` is server-managed.
  payment_status: "PAID",
};
