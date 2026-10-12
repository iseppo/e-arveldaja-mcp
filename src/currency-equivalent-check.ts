import type { PurchaseInvoice, Transaction } from "./types/api.js";
import { isInvalidatedPurchaseInvoice } from "./purchase-invoice-status.js";
import {
  detectCurrencyEquivalentAmbiguity,
  scoreTransactionToInvoice,
  type CurrencyEquivalentAmbiguity,
} from "./tools/receipt-extraction.js";
import { signedBankTransactionDirection } from "./bank-transaction-direction.js";

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
  /** Used only to link a payment to this document; never emitted. */
  invoiceNumber?: string;
  /** Used only to link a payment to this document; never emitted. */
  refNumber?: string;
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
// "WISE:{id} Merchant [100 EUR @ 0.909] [source_direction=OUT]". On an outgoing
// row the booked amount is the funding (source) side and the bracket is the
// target — what the merchant was paid.
const WISE_OPPOSITE_SIDE_RE = /^WISE:\S+[^\n]*?\[(\d+(?:\.\d+)?) ([A-Z]{3}) @ [^\]\n]{1,40}\]/;

function wiseOppositeSide(transaction: Transaction): { amount: number; currency: string } | undefined {
  const match = (transaction.description ?? "").match(WISE_OPPOSITE_SIDE_RE);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? { amount, currency: match[2]! } : undefined;
}

function compactKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// IBAN-shaped tokens ("EE38 2200 2210 2014 5685") are removed before looking
// for an invoice number, so a numeric id never matches inside an account number.
const IBAN_TOKEN_RE = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/giu;

/**
 * The complete invoice identifier as a token: not preceded or followed by a
 * letter/digit, so INV-1001 never matches inside INV-10010. Separators between
 * its parts and at letter/digit transitions are optional ("INV-1001",
 * "INV 1001", "INV1001" all match). Undefined for an identifier under 4 chars.
 */
function invoiceIdentifierRe(invoiceNumber: string | undefined): RegExp | undefined {
  if (compactKey(invoiceNumber).length < 4) return undefined;
  const parts = (invoiceNumber ?? "").toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? [];
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("[\\s\\-_/.#]?")}(?![\\p{L}\\p{N}])`, "iu");
}

export interface PaymentCounterparty {
  clientId?: number;
  name?: string;
  invoiceDate?: string;
  /** Supplier invoice number; a payment quoting it is linked to this document. */
  invoiceNumber?: string;
  /** Payment reference printed on the document. */
  refNumber?: string;
}

export function paymentCurrencySignal(
  transactions: readonly Transaction[],
  ambiguity: CurrencyEquivalentAmbiguity,
  figures: { eur?: number; foreign?: number },
  counterparty: PaymentCounterparty,
): CurrencyEquivalentPaymentSignal | undefined {
  const foreign = ambiguity.foreign_currency;
  const invoiceRe = invoiceIdentifierRe(counterparty.invoiceNumber);
  // A candidate must be linked to THIS supplier/document, not just share an
  // amount and a date: same client id, the supplier's name, the document's
  // payment reference, or its invoice number quoted on the row. A row naming
  // another client is never a candidate.
  const linked = (candidate: Transaction): boolean => {
    if (counterparty.clientId !== undefined && candidate.clients_id != null && candidate.clients_id !== counterparty.clientId) {
      return false;
    }
    const { reasons } = scoreTransactionToInvoice(candidate, {
      clients_id: counterparty.clientId,
      client_name: counterparty.name,
      create_date: counterparty.invoiceDate,
      bank_ref_number: counterparty.refNumber,
    });
    if (!reasons.includes("date_within_3_days") && !reasons.includes("date_within_10_days")) return false;
    if (reasons.includes("client_id") || reasons.includes("counterparty_name") || reasons.includes("reference_number")) return true;
    return invoiceRe !== undefined &&
      [candidate.ref_number, candidate.bank_ref_number, candidate.description]
        .some(field => invoiceRe.test((field ?? "").replace(IBAN_TOKEN_RE, " ")));
  };
  // Which document figure (if any) an amount in `currency` equals.
  const figureCurrency = (currency: string, amount: number): string | undefined => {
    const figure = currency === "EUR" ? figures.eur : currency === foreign ? figures.foreign : undefined;
    return figure !== undefined && Math.abs(Math.abs(amount) - figure) < 0.01 ? currency : undefined;
  };
  const supported = new Map<string, number[]>();
  for (const transaction of transactions) {
    if (transaction.id === undefined || transaction.is_deleted) continue;
    const bookedCurrency = normalizeCurrency(transaction.cl_currencies_id) ?? "EUR";
    const wise = wiseOppositeSide(transaction);
    let currency: string | undefined;
    if (wise) {
      // Only an outgoing Wise row has a known target side.
      if (signedBankTransactionDirection(transaction) !== "outgoing") continue;
      const target = figureCurrency(wise.currency, wise.amount);
      const source = figureCurrency(bookedCurrency, transaction.amount);
      // The merchant-paid (target) currency is the signal; when the funding
      // side matches the other figure the row supports both, so neither.
      currency = target !== undefined && (source === undefined || source === target) ? target : undefined;
    } else {
      currency = figureCurrency(bookedCurrency, transaction.amount);
    }
    if (currency === undefined || !linked(transaction)) continue;
    supported.set(currency, [...(supported.get(currency) ?? []), transaction.id]);
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
        invoiceNumber: input.invoiceNumber,
        refNumber: input.refNumber,
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
