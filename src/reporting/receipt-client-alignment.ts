import type { Journal, Transaction, TransactionItem } from "../types/api.js";
import { findRegistrationJournal } from "../banking/receipt-ledger-check.js";

// READ-ONLY AUDIT CORE. A confirmed bank receipt carries the payer in
// `transaction.clients_id`, and the registration journal copies ITS client from
// the transaction — a journal has exactly one client and postings have none. So
// when a third party pays someone else's invoice, the 1210/2310 leg of the
// registration journal lands in the PAYER's sub-ledger while the invoice it
// settles belongs to another client, and the invoice client's receivable is
// never cleared. This module finds those transactions by comparing the payer
// against the client of each invoice linked through `transaction.items[]`.
//
// Pure and side-effect-free: it takes already-fetched records, mutates nothing,
// and knows no API. The typed reporting operation (src/reporting/operations.ts)
// does the reads; the guided façade (src/guided/run-accounting-report.ts) is
// the sole untrusted-text wrapping site, so every name/label here is UNWRAPPED.

/** `transaction.items[].relation_table` values that denote a linked invoice. */
const INVOICE_RELATION_TABLES = {
  sale_invoices: "sale_invoice",
  purchase_invoices: "purchase_invoice",
} as const;

export type InvoiceRelationTable = keyof typeof INVOICE_RELATION_TABLES;
export type ReceiptInvoiceType = (typeof INVOICE_RELATION_TABLES)[InvoiceRelationTable];

export function invoiceTypeOfRelation(relationTable: string | undefined): ReceiptInvoiceType | undefined {
  if (relationTable === undefined) return undefined;
  return INVOICE_RELATION_TABLES[relationTable as InvoiceRelationTable];
}

/** Payer or invoice client. `name` is UNWRAPPED external text — the façade wraps it. */
export interface ReceiptClientRef {
  readonly id: number | null;
  readonly name: string | null;
}

export interface ReceiptClientMismatchRow {
  readonly transaction_id: number;
  readonly date: string;
  readonly amount: number;
  readonly currency: string;
  readonly invoice_type: ReceiptInvoiceType;
  readonly invoice_id: number | null;
  readonly invoice_number: string | null;
  /** Registration journal carrying the wrongly-keyed receivable/payable leg. */
  readonly journal_id: number | null;
  /** Present only when no registration journal could be located for the tx. */
  readonly registration_journal_not_found?: true;
  /** UNWRAPPED payer bank-account name from the statement — the façade wraps it. */
  readonly bank_account_name: string | null;
  readonly transaction_client: ReceiptClientRef;
  readonly invoice_client: ReceiptClientRef;
  readonly next_action: string;
}

export interface ReceiptClientAlignmentCore {
  /** Confirmed, non-deleted transactions examined. */
  readonly scanned: number;
  /** Of those, how many settle at least one invoice. */
  readonly invoice_linked: number;
  /**
   * One row per misaligned (transaction, invoice item) link — a transaction
   * settling two invoices for a different client produces two rows.
   */
  readonly mismatches: readonly ReceiptClientMismatchRow[];
  /** Invoice links whose payer and invoice client are both known and equal. */
  readonly aligned_count: number;
  /** Invoice links whose invoice carries no client, so nothing can be compared. */
  readonly invoice_client_missing: number;
  /** Transaction ids of mismatches whose registration journal was not found. */
  readonly journal_not_found: readonly number[];
  readonly warnings: readonly string[];
}

export interface ComputeReceiptClientAlignmentInput {
  readonly transactions: readonly Transaction[];
  readonly journals: readonly Journal[];
  /** Client id → name, for the payer side (the invoice side carries its own). */
  readonly clientNames?: ReadonlyMap<number, string>;
  /**
   * Whether the sales side is registered. A purchase-only deployment has no
   * sale-invoice tools to repair with, so sale-invoice links are skipped and
   * the guidance names only the purchase tool — same gating as aging/month_end.
   */
  readonly enableSales?: boolean;
}

function repairAction(transactionId: number): string {
  return `invalidate_transaction ${transactionId}; then confirm_transaction ${transactionId} with the same distributions and reassign_client_to_invoice: true`;
}

function invoiceItems(tx: Transaction, enableSales: boolean): ReadonlyArray<{ item: TransactionItem; invoiceType: ReceiptInvoiceType }> {
  const links: Array<{ item: TransactionItem; invoiceType: ReceiptInvoiceType }> = [];
  for (const item of tx.items ?? []) {
    const invoiceType = invoiceTypeOfRelation(item.relation_table);
    if (invoiceType === undefined) continue;
    if (invoiceType === "sale_invoice" && !enableSales) continue;
    links.push({ item, invoiceType });
  }
  return links;
}

export function computeReceiptClientAlignment(
  input: ComputeReceiptClientAlignmentInput,
): ReceiptClientAlignmentCore {
  const enableSales = input.enableSales !== false;
  const mismatches: ReceiptClientMismatchRow[] = [];
  const journalNotFound: number[] = [];
  let scanned = 0;
  let invoiceLinked = 0;
  let alignedCount = 0;
  let invoiceClientMissing = 0;

  for (const tx of input.transactions) {
    // Only a CONFIRMED transaction has a registration journal, and only a
    // registered journal can put the leg in the wrong sub-ledger. A deleted row
    // is not in the ledger at all.
    if (tx.status !== "CONFIRMED" || tx.is_deleted) continue;
    scanned += 1;
    const links = invoiceItems(tx, enableSales);
    if (links.length === 0) continue;
    invoiceLinked += 1;

    const payerId = tx.clients_id ?? null;
    let journalLookedUp = false;
    let journalId: number | null = null;

    for (const { item, invoiceType } of links) {
      const invoiceClientId = item.clients_id ?? null;
      if (invoiceClientId === null) invoiceClientMissing += 1;
      if (invoiceClientId === null || payerId === null) continue;
      if (invoiceClientId === payerId) {
        alignedCount += 1;
        continue;
      }

      if (!journalLookedUp) {
        journalLookedUp = true;
        // Shared locator (src/banking/receipt-ledger-check.ts): the register
        // call returns no journal id, so the operation-shape match is the only
        // reliable link. Reused so the rule lives in exactly one place.
        journalId = findRegistrationJournal(input.journals, tx.id!)[0]?.id ?? null;
        if (journalId === null) journalNotFound.push(tx.id!);
      }

      mismatches.push({
        transaction_id: tx.id!,
        date: tx.date,
        amount: tx.amount,
        currency: tx.cl_currencies_id,
        invoice_type: invoiceType,
        invoice_id: item.relation_id ?? null,
        invoice_number: item.item_number ?? null,
        journal_id: journalId,
        ...(journalId === null ? { registration_journal_not_found: true as const } : {}),
        bank_account_name: tx.bank_account_name ?? null,
        transaction_client: { id: payerId, name: input.clientNames?.get(payerId) ?? null },
        invoice_client: { id: invoiceClientId, name: item.client_name ?? null },
        next_action: repairAction(tx.id!),
      });
    }
  }

  const warnings: string[] = [];
  if (invoiceClientMissing > 0) {
    const repairTools = enableSales ? "update_sale_invoice / update_purchase_invoice" : "update_purchase_invoice";
    warnings.push(`${invoiceClientMissing} invoice link(s) have no client on the invoice, so the receipt cannot be checked against a client sub-ledger. Set the client on the invoice (${repairTools}) and re-run.`);
  }

  return {
    scanned,
    invoice_linked: invoiceLinked,
    mismatches,
    aligned_count: alignedCount,
    invoice_client_missing: invoiceClientMissing,
    journal_not_found: journalNotFound,
    warnings,
  };
}
