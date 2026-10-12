import type { PurchaseInvoice, Transaction } from "./types/api.js";
import { isInvalidatedPurchaseInvoice } from "./purchase-invoice-status.js";
import {
  detectCurrencyEquivalentAmbiguity,
  scoreTransactionToInvoice,
  type CurrencyEquivalentAmbiguity,
} from "./tools/receipt-extraction.js";
import { POSSIBLE_MATCH_THRESHOLD } from "./tools/receipt-inbox-matching.js";

// F-CURRENCY-EQUIVALENT: advisory out-of-band cross-check for a document whose
// text names EUR and one supported foreign currency. "Currency USD … Summa
// eurodes 100.00 EUR" (a USD invoice printing its EUR equivalent) and "Card
// conversion: USD 110 … TOTAL 100 EUR" (a EUR charge) read the same, so the
// extractor's pick is checked against the supplier's booking history and any
// candidate payment. It never changes the extracted currency: a contradiction
// only produces a warning that routes the item to review.

export const CURRENCY_EQUIVALENT_AMBIGUITY_CODE = "currency_equivalent_ambiguity";

/** Last N live invoices of the supplier considered for its currency habit. */
export const SUPPLIER_HISTORY_WINDOW = 10;
/** A habit needs at least this many invoices… */
export const SUPPLIER_HISTORY_MIN_INVOICES = 3;
/** …and this share of them in one currency. */
export const SUPPLIER_HISTORY_MIN_SHARE = 0.8;

export interface CurrencyEquivalentCheckInput {
  rawText: string | undefined;
  /** The extractor's currency, as returned (never modified here). */
  extractedCurrency: string | undefined;
  extractedGross?: number;
  invoiceDate?: string;
  supplierClientId?: number;
  /** Used only for payment counterparty scoring; never emitted. */
  supplierName?: string;
  /** Called only for an ambiguous document. A failure drops the signal. */
  loadPurchaseInvoices?: () => Promise<readonly PurchaseInvoice[]>;
  /** Called only for an ambiguous document. A failure drops the signal. */
  loadTransactions?: () => Promise<readonly Transaction[]>;
}

export interface CurrencyEquivalentSupplierSignal {
  suggested_currency: string;
  invoices_considered: number;
  invoices_in_currency: number;
}

export interface CurrencyEquivalentPaymentSignal {
  suggested_currency: string;
  transaction_ids: number[];
}

export interface CurrencyEquivalentWarning {
  code: typeof CURRENCY_EQUIVALENT_AMBIGUITY_CODE;
  message: string;
  extracted_currency: string;
  foreign_currency: string;
  supplier_history?: CurrencyEquivalentSupplierSignal;
  payment?: CurrencyEquivalentPaymentSignal;
}

function normalizeCurrency(code: string | null | undefined): string | undefined {
  const upper = code?.trim().toUpperCase();
  return upper && /^[A-Z]{3}$/.test(upper) ? upper : undefined;
}

export function supplierCurrencySignal(
  invoices: readonly PurchaseInvoice[],
  supplierClientId: number,
): CurrencyEquivalentSupplierSignal | undefined {
  const recent = invoices
    .filter(invoice => invoice.clients_id === supplierClientId && !isInvalidatedPurchaseInvoice(invoice))
    .map(invoice => ({ date: invoice.create_date ?? "", currency: normalizeCurrency(invoice.cl_currencies_id) }))
    .filter((entry): entry is { date: string; currency: string } => entry.currency !== undefined)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, SUPPLIER_HISTORY_WINDOW);
  if (recent.length < SUPPLIER_HISTORY_MIN_INVOICES) return undefined;
  const counts = new Map<string, number>();
  for (const entry of recent) counts.set(entry.currency, (counts.get(entry.currency) ?? 0) + 1);
  const [currency, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (count < SUPPLIER_HISTORY_MIN_INVOICES || count / recent.length < SUPPLIER_HISTORY_MIN_SHARE) return undefined;
  return { suggested_currency: currency, invoices_considered: recent.length, invoices_in_currency: count };
}

// Wise rows carry the other side of a conversion in the description:
// "WISE:{id} Merchant [110 USD @ 1.1] [source_direction=OUT]".
const WISE_OPPOSITE_SIDE_RE = /^WISE:\S+[^\n]*?\[(\d+(?:\.\d+)?) ([A-Z]{3}) @ [^\]\n]{1,40}\]/;

function wiseOppositeSide(transaction: Transaction): { amount: number; currency: string } | undefined {
  const match = (transaction.description ?? "").match(WISE_OPPOSITE_SIDE_RE);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? { amount, currency: match[2]! } : undefined;
}

export function paymentCurrencySignal(
  transactions: readonly Transaction[],
  ambiguity: CurrencyEquivalentAmbiguity,
  figures: { eur?: number; foreign?: number },
  counterparty: { clientId?: number; name?: string; invoiceDate?: string },
): CurrencyEquivalentPaymentSignal | undefined {
  const matches = (candidate: Transaction, currency: string, amount: number | undefined): boolean => {
    if (amount === undefined) return false;
    const { confidence, reasons } = scoreTransactionToInvoice(candidate, {
      clients_id: counterparty.clientId,
      client_name: counterparty.name,
      cl_currencies_id: currency,
      create_date: counterparty.invoiceDate,
      gross_price: amount,
    });
    return reasons.includes("exact_amount") && confidence >= POSSIBLE_MATCH_THRESHOLD;
  };
  const supported = new Map<string, number[]>();
  const support = (currency: string, id: number) => supported.set(currency, [...(supported.get(currency) ?? []), id]);
  for (const transaction of transactions) {
    if (transaction.id === undefined || transaction.is_deleted) continue;
    const txCurrency = normalizeCurrency(transaction.cl_currencies_id) ?? "EUR";
    const wise = wiseOppositeSide(transaction);
    if (txCurrency === ambiguity.foreign_currency && matches(transaction, txCurrency, figures.foreign)) {
      support(ambiguity.foreign_currency, transaction.id);
    } else if (
      wise?.currency === ambiguity.foreign_currency &&
      matches({ ...transaction, amount: wise.amount, cl_currencies_id: wise.currency }, wise.currency, figures.foreign)
    ) {
      support(ambiguity.foreign_currency, transaction.id);
    } else if (txCurrency === "EUR" && wise?.currency !== ambiguity.foreign_currency && matches(transaction, "EUR", figures.eur)) {
      support("EUR", transaction.id);
    }
  }
  if (supported.size !== 1) return undefined;
  const [currency, ids] = [...supported.entries()][0]!;
  return { suggested_currency: currency, transaction_ids: ids };
}

/**
 * Run the cross-check. Returns a warning only when the document is
 * currency-ambiguous AND at least one out-of-band signal suggests the other
 * currency than the extractor picked; otherwise undefined (no lookup at all for
 * a non-ambiguous document). Fail-safe: a loader error drops that signal.
 */
export async function checkCurrencyEquivalent(input: CurrencyEquivalentCheckInput): Promise<CurrencyEquivalentWarning | undefined> {
  const extracted = normalizeCurrency(input.extractedCurrency);
  if (extracted === undefined) return undefined;
  const ambiguity = detectCurrencyEquivalentAmbiguity(input.rawText);
  if (!ambiguity) return undefined;
  const foreign = ambiguity.foreign_currency;
  if (extracted !== "EUR" && extracted !== foreign) return undefined;

  let supplierHistory: CurrencyEquivalentSupplierSignal | undefined;
  if (input.supplierClientId !== undefined && input.loadPurchaseInvoices) {
    try {
      supplierHistory = supplierCurrencySignal(await input.loadPurchaseInvoices(), input.supplierClientId);
    } catch {
      supplierHistory = undefined;
    }
  }

  let payment: CurrencyEquivalentPaymentSignal | undefined;
  if (input.loadTransactions && input.invoiceDate) {
    // The extracted gross is the figure in the extracted currency; the other
    // currency's figure is its largest marked amount on the document.
    const figures = {
      eur: extracted === "EUR" ? input.extractedGross ?? ambiguity.eur_amount : ambiguity.eur_amount,
      foreign: extracted === foreign ? input.extractedGross ?? ambiguity.foreign_amount : ambiguity.foreign_amount,
    };
    try {
      payment = paymentCurrencySignal(await input.loadTransactions(), ambiguity, figures, {
        clientId: input.supplierClientId,
        name: input.supplierName,
        invoiceDate: input.invoiceDate,
      });
    } catch {
      payment = undefined;
    }
  }

  const supplierContradicts = supplierHistory !== undefined &&
    (supplierHistory.suggested_currency === "EUR" || supplierHistory.suggested_currency === foreign) &&
    supplierHistory.suggested_currency !== extracted;
  const paymentContradicts = payment !== undefined && payment.suggested_currency !== extracted;
  if (!supplierContradicts && !paymentContradicts) return undefined;

  const reasons: string[] = [];
  if (supplierContradicts) {
    reasons.push(
      `the supplier's last ${supplierHistory!.invoices_considered} purchase invoices are ` +
        `${supplierHistory!.invoices_in_currency === supplierHistory!.invoices_considered ? "all" : `${supplierHistory!.invoices_in_currency} of them`} ` +
        `in ${supplierHistory!.suggested_currency}`,
    );
  }
  if (paymentContradicts) {
    reasons.push(
      `candidate payment transaction(s) ${payment!.transaction_ids.join(", ")} match the ${payment!.suggested_currency} figure`,
    );
  }
  const suggested = supplierContradicts ? supplierHistory!.suggested_currency : payment!.suggested_currency;
  const message =
    `The document shows amounts in both EUR and ${foreign}; extraction picked ${extracted}, but ${reasons.join(" and ")}, ` +
    `which suggests ${suggested}. It may be ${extracted === "EUR" ? `a ${foreign} invoice printing its EUR equivalent` : `a EUR charge printing its ${foreign} conversion`}. ` +
    "Verify the invoice currency before booking; the extracted currency was not changed.";

  return {
    code: CURRENCY_EQUIVALENT_AMBIGUITY_CODE,
    message,
    extracted_currency: extracted,
    foreign_currency: foreign,
    ...(supplierContradicts ? { supplier_history: supplierHistory } : {}),
    ...(paymentContradicts ? { payment } : {}),
  };
}
