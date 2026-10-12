import type { Transaction } from "../../types/api.js";
import { roundMoney } from "../../money.js";
import { type Cents, centsEqual, toCents } from "../../money-cents.js";
import { normalizeCompanyName } from "../../company-name.js";
import { bankTransactionDirection, signedBankTransactionDirection } from "../../bank-transaction-direction.js";
import { getComparableBaseInvoiceAmount } from "./invoice-index.js";

// ---------------------------------------------------------------------------
// Candidate scoring / ranking. PURE: imports only ../../money,
// ../../company-name, ../../bank-transaction-direction, and the sibling
// invoice-index module. No MCP/HTTP/fs/audit/env.
// ---------------------------------------------------------------------------

export interface MatchCandidate {
  type: "sale_invoice" | "purchase_invoice";
  id: number;
  number: string;
  client_name: string;
  clients_id: number;
  gross_price: number;
  payment_status: string;
  partially_paid_warning: boolean;
  ref_number?: string | null;
  confidence: number;
  match_reasons: string[];
  /** Set when the candidate is admitted to the exact-confirm set by the
   * ref-number + exact-amount rule rather than by its score. */
  auto_confirm_rule?: "ref_number_exact";
}

export function buildSuggestedDistribution(
  type: MatchCandidate["type"],
  id: number,
  amount: number,
  partiallyPaidWarning: boolean,
): { related_table: string; related_id: number; amount: number } | undefined {
  if (partiallyPaidWarning) return undefined;

  return {
    related_table: type === "sale_invoice" ? "sale_invoices" : "purchase_invoices",
    related_id: id,
    amount,
  };
}

export function comparableTransactionAmount(tx: Transaction): number {
  return roundMoney(tx.base_amount ?? tx.amount);
}

// Scoring compares amounts in exact integer cents, never by float subtraction:
// `Math.abs(a - b) < 0.01` is inconsistent across magnitudes because the
// subtraction itself carries representation error (10.00 vs 10.01 differs by
// 0.00999…, so it passed as "equal" and scored exact_amount; 100.00 vs 100.01
// differs by 0.01000…, so it did not). A cent off is a real discrepancy at every
// magnitude, and combined with a ref/client match it could cross the 90-point
// auto-confirm threshold and settle an invoice against the wrong figure.
//
// A non-finite amount cannot participate in a match: `toCents` would throw, and
// scoring must never be the reason a whole reconcile run dies. Such an amount
// simply never compares equal, so the candidate scores no amount points.
function amountCents(value: number): Cents | undefined {
  return Number.isFinite(value) ? toCents(value) : undefined;
}

function sameCents(a: Cents | undefined, b: Cents | undefined): boolean {
  return a !== undefined && b !== undefined && centsEqual(a, b);
}

/** True when two euro amounts are the SAME to the cent (not "within a cent"). */
export function sameAmountToTheCent(a: number, b: number): boolean {
  return sameCents(amountCents(a), amountCents(b));
}

/**
 * Amount reason for an explicit-EUR payment equal to a foreign-currency
 * invoice's structured `base_gross_price` (never the gross × rate fallback).
 * Capped at TIER_A_CONFIDENCE_CAP, and a top-score tie involving it is ambiguous.
 */
export const EXACT_INVOICE_BASE_AMOUNT = "exact_invoice_base_amount";

/**
 * The live API reports an unpaid confirmed invoice as `payment_status: ""` (or
 * null), never "NOT_PAID" (verified live 2026-10), so a strict "NOT_PAID" check
 * never matched real data. PAID, PARTIALLY_PAID, any unknown value and a missing
 * field stay excluded.
 */
export function isUnpaidPaymentStatus(status: string | null | undefined): boolean {
  return status === null || status === "" || status === "NOT_PAID";
}
const TIER_A_CONFIDENCE_CAP = 85;

/**
 * True when a candidate set cannot pick one invoice because Tier A is involved:
 * a top-score tie in which any candidate is Tier A (whatever the other's
 * reason), or a Tier A top candidate while another Tier A candidate exists.
 * A unique non-Tier-A winner is not affected. Callers route an ambiguous set
 * to review with no distribution.
 */
export function isAmbiguousForeignInvoiceBase(candidates: ReadonlyArray<{ confidence: number; reasons: readonly string[] }>): boolean {
  const isTierA = (c: { reasons: readonly string[] }) => c.reasons.includes(EXACT_INVOICE_BASE_AMOUNT);
  const top = Math.max(...candidates.map(c => c.confidence));
  const tied = candidates.filter(c => c.confidence === top);
  return tied.some(isTierA) && (tied.length >= 2 || candidates.filter(isTierA).length >= 2);
}

export function matchScore(
  tx: Transaction,
  invoice: { gross_price?: number; base_gross_price?: number; currency_rate?: number | null; cl_currencies_id?: string | null; bank_ref_number?: string | null; clients_id?: number; client_name?: string; payment_status?: string | null },
  txAmount: number
): { confidence: number; reasons: string[]; partiallyPaidWarning: boolean } {
  let confidence = 0;
  const reasons: string[] = [];

  // Amount match (check both local and base currency amounts)
  const invoiceAmount = invoice.gross_price ?? 0;
  const baseAmount = tx.base_amount ?? txAmount;
  const baseInvoiceAmount = getComparableBaseInvoiceAmount(invoice) ?? invoiceAmount;
  // A coincidental cross-currency nominal match (e.g. tx 100 USD / base 90 EUR
  // vs invoice gross 100 EUR / base 100 EUR) would otherwise score "exact_amount"
  // and bypass the cross-currency distribution guard, booking the wrong figure.
  // When the nominal amounts match but the base amounts meaningfully conflict,
  // flag it so the guard routes it to manual review instead.
  const txCents = amountCents(txAmount);
  const invoiceCents = amountCents(invoiceAmount);
  const baseCents = amountCents(baseAmount);
  const baseInvoiceCents = amountCents(baseInvoiceAmount);
  const nominalMatch = sameCents(txCents, invoiceCents);
  const baseMatch = sameCents(baseCents, baseInvoiceCents);
  const txHasMeaningfulBase = !sameCents(baseCents, txCents);
  const invoiceHasMeaningfulBase = !sameCents(baseInvoiceCents, invoiceCents);
  const conflictingBase = nominalMatch && !baseMatch && (txHasMeaningfulBase || invoiceHasMeaningfulBase);
  // Tier A: structured fields only. Currency read inline (amount-resolution
  // imports this module). Only an unpaid invoice: paying the full base on a
  // partially paid one would overpay. Checked BEFORE the nominal branch: a
  // foreign invoice whose gross equals its base (rate 1) nominally equals the
  // EUR row too, and must still get the Tier A cap and tie rules.
  const tierA =
    tx.cl_currencies_id === "EUR" &&
    typeof invoice.cl_currencies_id === "string" &&
    /^[A-Z]{3}$/.test(invoice.cl_currencies_id) &&
    invoice.cl_currencies_id !== "EUR" &&
    invoice.base_gross_price != null &&
    !txHasMeaningfulBase &&
    isUnpaidPaymentStatus(invoice.payment_status) &&
    sameCents(txCents, amountCents(invoice.base_gross_price));
  if (tierA) {
    confidence += 40;
    reasons.push(EXACT_INVOICE_BASE_AMOUNT);
  } else if (conflictingBase) {
    confidence += 40;
    reasons.push("cross_currency_conflict");
  } else if (nominalMatch) {
    confidence += 40;
    reasons.push("exact_amount");
  } else if (baseMatch && txHasMeaningfulBase) {
    confidence += 40;
    reasons.push("exact_base_amount");
  } else if (
    txCents !== undefined && invoiceCents !== undefined &&
    // "Close" is a genuine tolerance (under 1.00 EUR), not an equality test, and
    // stays exclusive: exactly 1.00 EUR apart is not close.
    Math.abs((txCents as number) - (invoiceCents as number)) < 100
  ) {
    confidence += 20;
    reasons.push("close_amount");
  }

  // Reference number match
  if (tx.ref_number && invoice.bank_ref_number && tx.ref_number === invoice.bank_ref_number) {
    confidence += 40;
    reasons.push("ref_number");
  }

  // Client match
  if (tx.clients_id && invoice.clients_id && tx.clients_id === invoice.clients_id) {
    confidence += 15;
    reasons.push("client_id");
  } else if (tx.bank_account_name && invoice.client_name) {
    const nameLower = normalizeCompanyName(tx.bank_account_name);
    const clientLower = normalizeCompanyName(invoice.client_name);
    if (nameLower.length >= 4 && clientLower.length >= 4 && (nameLower.includes(clientLower) || clientLower.includes(nameLower))) {
      confidence += 10;
      reasons.push("client_name_partial");
    }
  }

  const partiallyPaidWarning = invoice.payment_status === "PARTIALLY_PAID";
  if (partiallyPaidWarning) {
    confidence = Math.max(0, confidence - 15);
    reasons.push("partially_paid_warning");
  }

  if (reasons.includes(EXACT_INVOICE_BASE_AMOUNT)) {
    confidence = Math.min(confidence, TIER_A_CONFIDENCE_CAP);
  }

  return { confidence: Math.min(confidence, 100), reasons, partiallyPaidWarning };
}

export function getInvoiceMatchEligibility(
  tx: Pick<Transaction, "type" | "description">,
): { allowSaleInvoices: boolean; allowPurchaseInvoices: boolean } {
  if (bankTransactionDirection(tx) === "incoming") {
    return {
      allowSaleInvoices: true,
      allowPurchaseInvoices: false,
    };
  }

  // A signed importer marker (CAMT DBIT / Wise OUT) proves the cash left the
  // account, so it can only settle a payable — never a receivable. The
  // sale-invoice fallback below exists only for legacy rows whose stored `C`
  // may be the 0.22.0 forced-`C` artefact rather than a real outgoing payment.
  if (signedBankTransactionDirection(tx) === "outgoing") {
    return {
      allowSaleInvoices: false,
      allowPurchaseInvoices: true,
    };
  }

  return {
    allowSaleInvoices: true,
    allowPurchaseInvoices: true,
  };
}
