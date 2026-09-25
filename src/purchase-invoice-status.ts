/**
 * Purchase-invoice liveness + number identity shared by the duplicate checks
 * (document audit, receipt inbox matching, payment-receipt cross-reference).
 *
 * Status: the RIK API documents only PROJECT/CONFIRMED as purchase-invoice
 * status filters, and invalidated transactions read back as "VOID"; older code
 * assumed "INVALIDATED"/"DELETED". Treat all three (and an `is_deleted` flag)
 * as not live so a duplicate check neither misses a live invoice nor blocks on
 * a voided one, whichever spelling the API returns.
 */
const NON_LIVE_PURCHASE_INVOICE_STATUSES: ReadonlySet<string> = new Set(["VOID", "INVALIDATED", "DELETED"]);

export function isInvalidatedPurchaseInvoice(invoice: { status?: string | null; is_deleted?: boolean | null }): boolean {
  return invoice.is_deleted === true ||
    (typeof invoice.status === "string" && NON_LIVE_PURCHASE_INVOICE_STATUSES.has(invoice.status.toUpperCase()));
}

/** Duplicate-comparison key for an invoice number: case-folded, spaces and dashes removed ("INV 2024-01" = "inv202401"). */
export function normalizeInvoiceNumberForComparison(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[\s\-‐‑‒–—]/g, "");
}
