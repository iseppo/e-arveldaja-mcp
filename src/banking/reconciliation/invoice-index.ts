import { roundMoney } from "../../money.js";

// ---------------------------------------------------------------------------
// Invoice index for O(1) candidate narrowing by ref_number and amount.
// PURE: imports only ../../money. No MCP/HTTP/fs/audit/env.
// ---------------------------------------------------------------------------

export interface InvoiceIndex<T> {
  byRef: Map<string, T[]>;
  byAmount: Map<number, T[]>; // keyed by Math.round of comparable local/base amounts
}

export type MatchableInvoiceAmounts = {
  gross_price?: number | null;
  base_gross_price?: number | null;
  currency_rate?: number | null;
};

export function getComparableBaseInvoiceAmount(invoice: MatchableInvoiceAmounts): number | undefined {
  if (invoice.base_gross_price != null) return invoice.base_gross_price;
  if (invoice.gross_price == null) return undefined;
  if (invoice.currency_rate != null) {
    return roundMoney(invoice.gross_price * invoice.currency_rate);
  }
  return invoice.gross_price;
}

function getComparableInvoiceAmountBuckets(invoice: MatchableInvoiceAmounts): number[] {
  const buckets = new Set<number>();
  if (invoice.gross_price != null) {
    buckets.add(Math.round(invoice.gross_price));
  }
  const baseAmount = getComparableBaseInvoiceAmount(invoice);
  if (baseAmount != null) {
    buckets.add(Math.round(baseAmount));
  }
  return [...buckets];
}

export function buildInvoiceIndex<T extends MatchableInvoiceAmounts & { bank_ref_number?: string | null }>(
  invoices: T[],
): InvoiceIndex<T> {
  const byRef = new Map<string, T[]>();
  const byAmount = new Map<number, T[]>();

  for (const inv of invoices) {
    if (inv.bank_ref_number) {
      let list = byRef.get(inv.bank_ref_number);
      if (!list) { list = []; byRef.set(inv.bank_ref_number, list); }
      list.push(inv);
    }
    for (const key of getComparableInvoiceAmountBuckets(inv)) {
      let list = byAmount.get(key);
      if (!list) { list = []; byAmount.set(key, list); }
      list.push(inv);
    }
  }

  return { byRef, byAmount };
}

/**
 * Collect candidate invoices that could match a transaction on amount or ref_number.
 * Safe to skip invoices not in any index bucket: client-only matches (max 15 pts)
 * can never reach the minimum practical threshold (50), so they would be filtered anyway.
 */
export function getIndexedCandidates<T>(
  index: InvoiceIndex<T>,
  refNumber: string | null | undefined,
  amount: number,
  baseAmount?: number,
): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  const add = (inv: T) => { if (!seen.has(inv)) { seen.add(inv); result.push(inv); } };

  if (refNumber) {
    for (const inv of index.byRef.get(refNumber) ?? []) add(inv);
  }

  // Check ±1 integer buckets to cover close_amount matches (within 1.0)
  const key = Math.round(amount);
  for (let offset = -1; offset <= 1; offset++) {
    for (const inv of index.byAmount.get(key + offset) ?? []) add(inv);
  }

  // Also check base_amount buckets if different from local amount
  if (baseAmount != null && Math.round(baseAmount) !== key) {
    const baseKey = Math.round(baseAmount);
    for (let offset = -1; offset <= 1; offset++) {
      for (const inv of index.byAmount.get(baseKey + offset) ?? []) add(inv);
    }
  }

  return result;
}
