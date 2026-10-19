import type { ApiContext } from "../tools/crud-tools.js";
import { detectDuplicatePurchaseInvoice } from "../tools/document-audit.js";
import { normalizeInvoiceNumberForComparison } from "../purchase-invoice-status.js";
import { isStrictDate } from "../strict-date.js";

// Cooperating intake writers in this process and credential/base-URL scope.
// RIK UI, other processes and other credentials remain outside this FIFO.
const tails = new Map<string, Promise<void>>();

export async function withPurchaseInvoiceLock<T>(
  api: Pick<ApiContext, "purchaseInvoices">,
  run: () => Promise<T>,
): Promise<T> {
  const key = api.purchaseInvoices.connectionFingerprint || "__unscoped_purchase_intake__";
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(key, tail);
  try { return await result; }
  finally { if (tails.get(key) === tail) tails.delete(key); }
}

/** Run inside the intake FIFO, after waiting, immediately before create. */
export async function scanPurchaseIntakeDuplicates(
  api: Pick<ApiContext, "purchaseInvoices">,
  candidate: { supplierClientId: number; invoiceNumber: string; grossPrice?: number; invoiceDate?: string; currency?: string },
): Promise<{ kind: "number" | "amount_date"; invoiceIds: number[]; comparisonUnavailable?: Array<"gross_price" | "invoice_date"> }> {
  const numbered = normalizeInvoiceNumberForComparison(candidate.invoiceNumber).length > 0;
  if (!numbered) {
    const unavailable: Array<"gross_price" | "invoice_date"> = [];
    if (typeof candidate.grossPrice !== "number" || !Number.isFinite(candidate.grossPrice) || candidate.grossPrice <= 0) unavailable.push("gross_price");
    if (typeof candidate.invoiceDate !== "string" || !isStrictDate(candidate.invoiceDate)) unavailable.push("invoice_date");
    // Item predictors cannot replace supplied document comparison values.
    // An unavailable comparison is a hold, never a successful empty scan.
    if (unavailable.length) return { kind: "amount_date", invoiceIds: [], comparisonUnavailable: unavailable };
  }
  api.purchaseInvoices.invalidateListCache();
  const rows = await api.purchaseInvoices.listAll();
  // An absent number has no exact-number match. Keep the existing amount/date
  // window and currency, rather than inventing a number or comparing FX sums.
  const eligible = numbered ? rows : rows.filter(row => (row.cl_currencies_id ?? "EUR") === (candidate.currency ?? "EUR"));
  const result = detectDuplicatePurchaseInvoice(eligible, {
    clients_id: candidate.supplierClientId,
    ...(numbered ? { invoice_number: candidate.invoiceNumber } : {
      ...(Number.isFinite(candidate.grossPrice) ? { gross_price: candidate.grossPrice } : {}),
      ...(candidate.invoiceDate ? { invoice_date: candidate.invoiceDate } : {}),
    }),
  });
  const matches = result[numbered ? "candidate_invoice_number_matches" : "candidate_same_amount_date_matches"] as { items: Array<{ id?: number }> };
  return { kind: numbered ? "number" : "amount_date", invoiceIds: matches.items.flatMap(row => row.id === undefined ? [] : [row.id]) };
}
