import type { Transaction } from "../../types/api.js";
import { roundMoney } from "../../money.js";
import { normalizeCompanyName } from "../../company-name.js";
import { bankTransactionDirection } from "../../bank-transaction-direction.js";
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

export function matchScore(
  tx: Transaction,
  invoice: { gross_price?: number; base_gross_price?: number; currency_rate?: number | null; bank_ref_number?: string | null; clients_id?: number; client_name?: string; payment_status?: string },
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
  const nominalMatch = Math.abs(txAmount - invoiceAmount) < 0.01;
  const baseMatch = Math.abs(baseAmount - baseInvoiceAmount) < 0.01;
  const txHasMeaningfulBase = Math.abs(baseAmount - txAmount) >= 0.01;
  const invoiceHasMeaningfulBase = Math.abs(baseInvoiceAmount - invoiceAmount) >= 0.01;
  const conflictingBase = nominalMatch && !baseMatch && (txHasMeaningfulBase || invoiceHasMeaningfulBase);
  if (conflictingBase) {
    confidence += 40;
    reasons.push("cross_currency_conflict");
  } else if (nominalMatch) {
    confidence += 40;
    reasons.push("exact_amount");
  } else if (Math.abs(baseAmount - baseInvoiceAmount) < 0.01 && baseAmount !== txAmount) {
    confidence += 40;
    reasons.push("exact_base_amount");
  } else if (Math.abs(txAmount - invoiceAmount) < 1) {
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

  return {
    allowSaleInvoices: true,
    allowPurchaseInvoices: true,
  };
}
