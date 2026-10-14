import { wrapUntrustedOcr } from "../mcp-json.js";
import type { PurchaseInvoice, Transaction } from "../types/api.js";
import { isInvalidatedPurchaseInvoice, normalizeInvoiceNumberForComparison } from "../purchase-invoice-status.js";
import type { InvoiceSummaryForMatching } from "./receipt-extraction.js";
import { scoreTransactionToInvoice } from "./receipt-extraction.js";
import type { InvoiceDuplicateMatch, InvoiceNumberCandidate, TransactionMatchCandidate } from "./receipt-inbox-types.js";

const POSSIBLE_MATCH_THRESHOLD = 70;

export interface TransactionMatchResult {
  candidate?: TransactionMatchCandidate;
  ambiguous: boolean;
  topConfidence?: number;
  tiedCount: number;
}

export function findBestTransactionMatch(
  transactions: Transaction[],
  invoice: InvoiceSummaryForMatching,
  consumedTransactionIds: Set<number>,
): TransactionMatchResult {
  const candidates = transactions
    .filter(transaction => transaction.id !== undefined && !consumedTransactionIds.has(transaction.id))
    .map(transaction => {
      const { confidence, reasons } = scoreTransactionToInvoice(transaction, invoice);
      return {
        transaction_id: transaction.id!,
        amount: transaction.amount,
        date: transaction.date,
        bank_account_name: wrapUntrustedOcr(transaction.bank_account_name ?? undefined),
        description: wrapUntrustedOcr(transaction.description ?? undefined),
        confidence,
        reasons,
      };
    })
    .filter(candidate => candidate.confidence >= POSSIBLE_MATCH_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);

  const best = candidates[0];
  if (!best) {
    return { ambiguous: false, tiedCount: 0 };
  }

  const tiedTopCandidates = candidates.filter(candidate => candidate.confidence === best.confidence);
  if (tiedTopCandidates.length > 1) {
    return { ambiguous: true, topConfidence: best.confidence, tiedCount: tiedTopCandidates.length };
  }

  return { candidate: best, ambiguous: false, topConfidence: best.confidence, tiedCount: 1 };
}

export function findDuplicateInvoice(
  invoices: PurchaseInvoice[],
  clientsId: number,
  invoiceNumber: string,
  createDate: string,
  grossPrice: number,
): InvoiceDuplicateMatch | undefined {
  const normalizedNumber = normalizeInvoiceNumberForComparison(invoiceNumber);

  const sameNumber = invoices.find(invoice =>
    invoice.clients_id === clientsId &&
    !isInvalidatedPurchaseInvoice(invoice) &&
    normalizeInvoiceNumberForComparison(invoice.number) === normalizedNumber
  );
  if (sameNumber?.id) {
    return {
      reason: "supplier_invoice_number",
      invoice_id: sameNumber.id,
      invoice_number: sameNumber.number,
      create_date: sameNumber.create_date,
      gross_price: sameNumber.gross_price,
    };
  }

  const sameAmountDate = invoices.find(invoice =>
    invoice.clients_id === clientsId &&
    !isInvalidatedPurchaseInvoice(invoice) &&
    invoice.create_date === createDate &&
    Math.abs((invoice.gross_price ?? 0) - grossPrice) < 0.01 &&
    (!invoice.number?.trim() || !normalizedNumber)
  );
  if (sameAmountDate?.id) {
    return {
      reason: "supplier_amount_date",
      invoice_id: sameAmountDate.id,
      invoice_number: sameAmountDate.number,
      create_date: sameAmountDate.create_date,
      gross_price: sameAmountDate.gross_price,
    };
  }

  return undefined;
}

/**
 * Live purchase invoices of ANY supplier carrying the receipt's invoice number.
 * Used when the receipt's supplier could not be resolved to an existing client:
 * the supplier-scoped `findDuplicateInvoice` cannot run, yet an already-booked
 * invoice may sit under a differently named client. A bare number is not unique
 * across suppliers (#23), so callers route a match to review, never skip it.
 * AUTO- numbers are extractor placeholders and never match.
 */
export function findInvoiceNumberMatchesAnySupplier(
  invoices: PurchaseInvoice[],
  invoiceNumber: string,
): InvoiceNumberCandidate[] {
  if (invoiceNumber.trim().toUpperCase().startsWith("AUTO-")) return [];
  const normalizedNumber = normalizeInvoiceNumberForComparison(invoiceNumber);
  if (!normalizedNumber) return [];
  return invoices
    .filter(invoice =>
      invoice.id !== undefined &&
      !isInvalidatedPurchaseInvoice(invoice) &&
      normalizeInvoiceNumberForComparison(invoice.number) === normalizedNumber)
    .map(invoice => ({
      invoice_id: invoice.id!,
      invoice_number: invoice.number,
      client_id: invoice.clients_id,
      ...(invoice.client_name ? { client_name: invoice.client_name } : {}),
      ...(invoice.gross_price !== undefined ? { gross_price: invoice.gross_price } : {}),
      create_date: invoice.create_date,
    }));
}
