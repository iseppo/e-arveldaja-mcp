import { wrapUntrustedOcr } from "../mcp-json.js";
import type { PurchaseInvoice, Transaction } from "../types/api.js";
import { isInvalidatedPurchaseInvoice, normalizeInvoiceNumberForComparison } from "../purchase-invoice-status.js";
import type { InvoiceSummaryForMatching } from "./receipt-extraction.js";
import { scoreTransactionToInvoice } from "./receipt-extraction.js";
import { detectDuplicatePurchaseInvoice } from "./document-audit.js";
import type { ExtractedReceiptFields } from "./receipt-extraction.js";
import type { AlreadyBookedCandidate, InvoiceDuplicateMatch, InvoiceNumberCandidate, TransactionMatchCandidate } from "./receipt-inbox-types.js";

const POSSIBLE_MATCH_THRESHOLD = 70;

interface TransactionMatchResult {
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

  // Same supplier + gross + date window with a DIFFERENT non-blank number (a
  // phone photo read as INV-1023 of the e-mailed INV-1O23): the reading path's
  // rule (detectDuplicatePurchaseInvoice), so every intake surface agrees. A
  // review hint only — callers never skip on it.
  const otherNumber = otherNumberAmountDateMatches(invoices, clientsId, invoiceNumber, grossPrice, createDate)[0];
  if (otherNumber?.id) {
    return {
      reason: "supplier_amount_date_other_number",
      invoice_id: otherNumber.id,
      invoice_number: otherNumber.number,
      create_date: otherNumber.create_date,
      gross_price: otherNumber.gross_price,
    };
  }

  return undefined;
}

/**
 * Live invoices of the supplier with the same gross and a nearby date
 * (detectDuplicatePurchaseInvoice's candidate_same_amount_date_matches) whose
 * non-blank number differs from a non-blank, non-placeholder `invoiceNumber`.
 * AUTO- numbers are extractor/auto-booking placeholders and never match, on
 * either side.
 */
export function otherNumberAmountDateMatches(
  invoices: PurchaseInvoice[],
  clientsId: number,
  invoiceNumber: string,
  grossPrice: number,
  invoiceDate: string,
): PurchaseInvoice[] {
  const normalizedNumber = normalizeInvoiceNumberForComparison(invoiceNumber);
  if (!normalizedNumber || invoiceNumber.trim().toUpperCase().startsWith("AUTO-")) return [];
  const found = detectDuplicatePurchaseInvoice(invoices, { clients_id: clientsId, gross_price: grossPrice, invoice_date: invoiceDate }) as
    { candidate_same_amount_date_matches: { items: Array<{ id?: number }> } };
  const ids = new Set(found.candidate_same_amount_date_matches.items.map(item => item.id));
  return invoices.filter(invoice => {
    const number = normalizeInvoiceNumberForComparison(invoice.number);
    return invoice.id !== undefined && ids.has(invoice.id) && number.length > 0 && number !== normalizedNumber &&
      !(invoice.number ?? "").trim().toUpperCase().startsWith("AUTO-");
  });
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

/**
 * Existing purchase invoices a receipt may already be booked as: with a
 * resolved supplier client and complete fields, the supplier-scoped duplicate
 * lookup; otherwise live invoices of any supplier with the same number. A hint
 * for review only — it never changes a receipt's status.
 */
export function findAlreadyBookedCandidates(
  invoices: PurchaseInvoice[],
  extracted: Partial<Pick<ExtractedReceiptFields, "invoice_number" | "invoice_date" | "total_gross">>,
  resolvedClientId: number | undefined,
): AlreadyBookedCandidate[] {
  const { invoice_number: invoiceNumber, invoice_date: invoiceDate, total_gross: gross } = extracted;
  if (resolvedClientId !== undefined && invoiceNumber && invoiceDate && gross !== undefined) {
    const match = findDuplicateInvoice(invoices, resolvedClientId, invoiceNumber, invoiceDate, gross);
    if (match) {
      return [{ invoice_id: match.invoice_id, reason: match.reason, ...(match.gross_price !== undefined ? { gross_price: match.gross_price } : {}) }];
    }
  }
  if (!invoiceNumber) return [];
  return findInvoiceNumberMatchesAnySupplier(invoices, invoiceNumber).map(candidate => ({
    invoice_id: candidate.invoice_id,
    reason: "invoice_number_any_supplier" as const,
    ...(candidate.gross_price !== undefined ? { gross_price: candidate.gross_price } : {}),
  }));
}
