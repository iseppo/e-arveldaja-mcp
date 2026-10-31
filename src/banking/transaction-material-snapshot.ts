import type { PurchaseInvoice, SaleInvoice, Transaction } from "../types/api.js";
import { stripSandboxMarkers } from "../sandbox-markers.js";
import { extractCamtDescriptionMetadata, isTrustedCamtDescriptionMetadata } from "../camt/duplicate-identity.js";
import { orderReferencesFromNotes } from "../order-reference-note.js";

export type InvoiceTable = "sale_invoices" | "purchase_invoices";
export interface MaterialInvalid { readonly field: string; readonly reason: string; readonly value_repr: string }
export interface MaterialItem {
  readonly accounts_id: number | null; readonly accounts_dimensions_id: number | null;
  readonly relation_table: string | null; readonly relation_id: number | null;
  readonly amount: number | null; readonly base_amount: number | null;
  readonly currency_rate: number | null; readonly cl_currencies_id: string | null;
  readonly clients_id: number | null; readonly item_number: string | null;
  readonly item_type: string | null; readonly item_date: string | null; readonly item_sum: number | null;
}
export interface BankDirectionProof {
  readonly source: "camt_checksum" | "wise_importer_marker" | "none";
  readonly marker_present: boolean; readonly verified: boolean; readonly poisoned: boolean;
  readonly source_direction: "CRDT" | "DBIT" | "IN" | "OUT" | null;
  readonly bank_reference: string | null; readonly bank_reference_hash: string | null;
  readonly counterparty_iban: string | null; readonly instruction_id: string | null;
  readonly signature: string | null; readonly iban_omitted: boolean; readonly wise_source_id: string | null;
}
export interface BankTransactionMaterialSnapshot {
  readonly contract: "bank_transaction_material_v1";
  readonly id: number | null; readonly date: string | null;
  readonly accounts_id: number | null; readonly accounts_dimensions_id: number | null;
  readonly bank_accounts_id: number | null; readonly clients_id: number | null;
  readonly amount: number | null; readonly base_amount: number | null; readonly currency_rate: number | null;
  readonly cl_currencies_id: string | null; readonly bank_code: string | null; readonly bank_subtype: string | null;
  readonly bank_account_no: string | null; readonly bank_account_name: string | null;
  readonly ref_number: string | null; readonly bank_ref_number: string | null;
  readonly description: string | null; readonly operation_type: string | null;
  readonly status: string | null; readonly is_deleted: boolean;
  readonly items: readonly MaterialItem[];
  readonly trusted_direction: "incoming" | "outgoing" | "unknown";
  readonly direction_proof: BankDirectionProof;
  readonly invalid: readonly MaterialInvalid[];
}
export interface LinkedInvoiceMaterialSnapshot {
  readonly contract: "linked_invoice_material_v1"; readonly table: InvoiceTable; readonly id: number;
  readonly clients_id: number | null; readonly client_name: string | null;
  readonly number: string | null; readonly number_prefix: string | null; readonly number_suffix: string | null;
  readonly bank_ref_number: string | null; readonly bank_account_no: string | null;
  readonly create_date: string | null; readonly journal_date: string | null;
  readonly status: string | null; readonly payment_status: string | null;
  readonly gross_price: number | null; readonly base_gross_price: number | null;
  readonly cl_currencies_id: string | null; readonly currency_rate: number | null;
  readonly ledger_accounts_id: number | null; readonly ledger_accounts_dimensions_id: number | null;
  readonly sale_invoice_type: string | null; readonly credit_sale_invoices_id: number | null;
  readonly credit_invoice_payment_type: string | null; readonly payment_type: string | null;
  readonly paid_in_cash: boolean | null;
  /** Purchases: the sorted distinct canonical order / cart references in the
   * notes (`[]` when none), which the document-reference confirm rule relies
   * on. Sales: null. Always present, so an added reference is a change. */
  readonly order_references: readonly string[] | null;
  readonly invalid: readonly MaterialInvalid[];
}
export type ExpectedLinkedInvoices = Readonly<Partial<Record<`${InvoiceTable}:${number}`, LinkedInvoiceMaterialSnapshot>>>;
export interface BankMaterialTransitions {
  readonly client?: { readonly from: number | null; readonly to: number };
  readonly status?: { readonly from: string; readonly to: string };
  readonly items?: { readonly from: readonly MaterialItem[]; readonly to: readonly MaterialItem[] };
}
export type BankMaterialComparison = { readonly ok: true; readonly snapshot: BankTransactionMaterialSnapshot }
  | { readonly ok: false; readonly changedFields: readonly string[]; readonly reason: string };

// Normalize only known transport decoration. Absent material is compared as
// absent, never as a wildcard or an invented account/currency default.
function normalizer(invalid: MaterialInvalid[]) {
  function bad(field: string, value: unknown, reason: string): null {
    invalid.push({ field, reason, value_repr: typeof value === "number" ? String(value) : typeof value });
    return null;
  }
  function text(value: unknown, field: string): string | null {
    if (value == null) return null;
    return typeof value === "string" ? stripSandboxMarkers(value) : bad(field, value, "wrong_type");
  }
  function number(value: unknown, field: string, id = false): number | null {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) return bad(field, value, "nonfinite_or_wrong_type");
    return id && (!Number.isSafeInteger(value) || value <= 0) ? bad(field, value, "invalid_id") : value;
  }
  function currency(value: unknown, field: string): string | null {
    const raw = text(value, field);
    if (raw === null) return null;
    const normalized = raw.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(normalized) ? normalized : bad(field, value, "invalid_currency");
  }
  function date(value: unknown, field: string): string | null {
    const raw = text(value, field);
    if (raw === null) return null;
    const time = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw) ? Date.parse(raw) : NaN;
    if (!Number.isFinite(time)) return bad(field, value, "invalid_date");
    const day = new Date(time).toISOString().slice(0, 10);
    if (raw.length === 10 && raw !== day) return bad(field, value, "invalid_date");
    return day;
  }
  function boolean(value: unknown, field: string): boolean | null {
    if (value == null) return null;
    return typeof value === "boolean" ? value : bad(field, value, "wrong_type");
  }
  return { bad, text, number, currency, date, boolean };
}

export function snapshotBankTransaction(tx: Transaction): BankTransactionMaterialSnapshot {
  const invalid: MaterialInvalid[] = [];
  const n = normalizer(invalid);
  const description = n.text(tx.description, "description");
  const cleanTx = { ...tx, description };
  const marker = extractCamtDescriptionMetadata(description);
  const camtPresent = /(?:^|\n)\[e-arveldaja-mcp:camt\s/i.test((description ?? "").replace(/&#(?:10|x0*a);/gi, "\n"));
  const verified = camtPresent && isTrustedCamtDescriptionMetadata(cleanTx, marker);
  if (camtPresent && !verified) n.bad("direction_proof", description, "unverified_camt_marker");
  for (const field of ["amount", "base_amount", "currency_rate"] as const) {
    if (tx[field] != null && (typeof tx[field] !== "number" || !Number.isFinite(tx[field]) || tx[field] <= 0)) n.bad(field, tx[field], "nonpositive_or_invalid");
  }
  const wise = !camtPresent ? (description ?? "").match(/^WISE:((?:FEE:)?\S+)[\s\S]*\[source_direction=(IN|OUT)\]\s*$/i) : null;
  const direction = verified && marker.source_direction
    ? marker.source_direction === "CRDT" ? "incoming" : "outgoing"
    : wise ? wise[2]!.toUpperCase() === "IN" ? "incoming" : "outgoing" : "unknown";
  const items: MaterialItem[] = [];
  if (tx.items != null && !Array.isArray(tx.items)) n.bad("items", tx.items, "wrong_type");
  for (const [index, row] of (Array.isArray(tx.items) ? tx.items : []).entries()) {
    if (row == null || typeof row !== "object") { n.bad(`items.${index}`, row, "wrong_type"); continue; }
    const prefix = `items.${index}.`;
    items.push({
      accounts_id: n.number(row.accounts_id, prefix + "accounts_id", true),
      accounts_dimensions_id: n.number(row.accounts_dimensions_id, prefix + "accounts_dimensions_id", true),
      relation_table: n.text(row.relation_table, prefix + "relation_table"), relation_id: n.number(row.relation_id, prefix + "relation_id", true),
      amount: n.number(row.amount, prefix + "amount"), base_amount: n.number(row.base_amount, prefix + "base_amount"),
      currency_rate: n.number(row.currency_rate, prefix + "currency_rate"), cl_currencies_id: n.currency(row.cl_currencies_id, prefix + "cl_currencies_id"),
      clients_id: n.number(row.clients_id, prefix + "clients_id", true), item_number: n.text(row.item_number, prefix + "item_number"),
      item_type: n.text(row.item_type, prefix + "item_type"), item_date: n.date(row.item_date, prefix + "item_date"), item_sum: n.number(row.item_sum, prefix + "item_sum"),
    });
  }
  items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    contract: "bank_transaction_material_v1", id: n.number(tx.id, "id", true), date: n.date(tx.date, "date"),
    accounts_id: n.number(tx.accounts_id, "accounts_id", true), accounts_dimensions_id: n.number(tx.accounts_dimensions_id, "accounts_dimensions_id", true),
    bank_accounts_id: n.number(tx.bank_accounts_id, "bank_accounts_id", true), clients_id: n.number(tx.clients_id, "clients_id", true),
    amount: n.number(tx.amount, "amount"), base_amount: n.number(tx.base_amount, "base_amount"), currency_rate: n.number(tx.currency_rate, "currency_rate"),
    cl_currencies_id: n.currency(tx.cl_currencies_id, "cl_currencies_id"), bank_code: n.text(tx.bank_code, "bank_code"), bank_subtype: n.text(tx.bank_subtype, "bank_subtype"),
    bank_account_no: n.text(tx.bank_account_no, "bank_account_no"), bank_account_name: n.text(tx.bank_account_name, "bank_account_name"),
    ref_number: n.text(tx.ref_number, "ref_number"), bank_ref_number: n.text(tx.bank_ref_number, "bank_ref_number"),
    description, operation_type: n.text(tx.operation_type, "operation_type"), status: n.text(tx.status, "status"), is_deleted: n.boolean(tx.is_deleted, "is_deleted") ?? false,
    items, trusted_direction: direction,
    direction_proof: { source: camtPresent ? "camt_checksum" : wise ? "wise_importer_marker" : "none",
      marker_present: camtPresent || !!wise, verified, poisoned: marker.poisoned === true,
      source_direction: marker.source_direction ?? (wise?.[2]?.toUpperCase() as "IN" | "OUT" | undefined) ?? null,
      bank_reference: marker.bank_ref_number ?? null, bank_reference_hash: marker.bank_ref_hash ?? null,
      counterparty_iban: marker.bank_account_no ?? null, instruction_id: marker.instruction_id ?? null,
      signature: marker.entry_sig ?? null, iban_omitted: marker.iban_omitted === true, wise_source_id: wise?.[1] ?? null },
    invalid,
  };
}

export function compareBankTransactionMaterial(approved: BankTransactionMaterialSnapshot, fresh: Transaction, allowed: BankMaterialTransitions = {}): BankMaterialComparison {
  const snapshot = snapshotBankTransaction(fresh);
  const expected = { ...approved };
  if (allowed.client && approved.clients_id === allowed.client.from) expected.clients_id = allowed.client.to;
  if (allowed.status && approved.status === allowed.status.from) expected.status = allowed.status.to;
  if (allowed.items && JSON.stringify(approved.items) === JSON.stringify(allowed.items.from)) expected.items = allowed.items.to;
  const changedFields = (Object.keys(expected) as Array<keyof BankTransactionMaterialSnapshot>)
    .filter(key => JSON.stringify(expected[key]) !== JSON.stringify(snapshot[key]));
  if (approved.invalid.length || snapshot.invalid.length) changedFields.push("invalid");
  return changedFields.length ? { ok: false, changedFields: [...new Set(changedFields)], reason: "transaction_material_changed" } : { ok: true, snapshot };
}

export function snapshotLinkedInvoice(table: InvoiceTable, invoice: SaleInvoice | PurchaseInvoice): LinkedInvoiceMaterialSnapshot {
  const invalid: MaterialInvalid[] = [];
  const n = normalizer(invalid);
  const row = invoice as unknown as Record<string, unknown>;
  const sale = table === "sale_invoices";
  return {
    contract: "linked_invoice_material_v1", table, id: n.number(invoice.id, "id", true) ?? 0,
    clients_id: n.number(invoice.clients_id, "clients_id", true), client_name: n.text(invoice.client_name, "client_name"),
    number: n.text(row.number, "number"), number_prefix: n.text(sale ? row.number_prefix : null, "number_prefix"), number_suffix: n.text(sale ? row.number_suffix : null, "number_suffix"),
    bank_ref_number: n.text(invoice.bank_ref_number, "bank_ref_number"), bank_account_no: n.text(sale ? null : row.bank_account_no, "bank_account_no"),
    create_date: n.date(invoice.create_date, "create_date"), journal_date: n.date(invoice.journal_date, "journal_date"),
    status: n.text(invoice.status, "status"), payment_status: n.text(invoice.payment_status, "payment_status"),
    gross_price: n.number(invoice.gross_price, "gross_price"), base_gross_price: n.number(invoice.base_gross_price, "base_gross_price"),
    cl_currencies_id: n.currency(invoice.cl_currencies_id, "cl_currencies_id"), currency_rate: n.number(invoice.currency_rate, "currency_rate"),
    ledger_accounts_id: n.number(row[sale ? "receivable_accounts_id" : "liability_accounts_id"], "ledger_accounts_id", true),
    ledger_accounts_dimensions_id: n.number(row[sale ? "receivable_accounts_dimensions_id" : "liability_accounts_dimensions_id"], "ledger_accounts_dimensions_id", true),
    sale_invoice_type: n.text(sale ? row.sale_invoice_type : null, "sale_invoice_type"), credit_sale_invoices_id: n.number(sale ? row.credit_sale_invoices_id : null, "credit_sale_invoices_id", true),
    credit_invoice_payment_type: n.text(sale ? row.credit_invoice_payment_type : null, "credit_invoice_payment_type"), payment_type: n.text(sale ? null : row.payment_type, "payment_type"),
    paid_in_cash: n.boolean(invoice.paid_in_cash, "paid_in_cash"),
    order_references: sale ? null : [...new Set(orderReferencesFromNotes(n.text(row.notes, "notes")))].sort(),
    invalid,
  };
}

export function changedLinkedInvoiceFields(expected: LinkedInvoiceMaterialSnapshot, fresh: SaleInvoice | PurchaseInvoice): string[] {
  const actual = snapshotLinkedInvoice(expected.table, fresh);
  const fields = (Object.keys(expected) as Array<keyof LinkedInvoiceMaterialSnapshot>).filter(key => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]));
  if (expected.invalid.length || actual.invalid.length || expected.id <= 0) fields.push("invalid");
  return [...new Set(fields)];
}

/** A deterministic refusal BEFORE register; a prior own client write may remain. */
export class TransactionMaterialDriftError extends Error {
  readonly category = "transaction_material_drift";
  readonly register_attempted = false;
  readonly automatic_retry_forbidden = true;
  readonly fresh_preview_required = true;
  readonly mutation_occurred: boolean;
  readonly mutation_may_have_occurred: boolean;
  readonly known_objects: readonly { entity_type: "transaction"; entity_id: number; outcome: "updated" }[];
  readonly client_update: { from: number | null; to: number; outcome: "updated" } | null;
  constructor(readonly transaction_id: number, readonly changed_fields: readonly string[], readonly invoice_key: `${InvoiceTable}:${number}` | null = null, transition?: { from: number | null; to: number }) {
    super(`Transaction ${transaction_id} material changed before registration; obtain a fresh review.`);
    this.name = "TransactionMaterialDriftError";
    this.mutation_occurred = this.mutation_may_have_occurred = transition !== undefined;
    this.known_objects = transition ? [{ entity_type: "transaction", entity_id: transaction_id, outcome: "updated" }] : [];
    this.client_update = transition ? { ...transition, outcome: "updated" } : null;
  }
}
