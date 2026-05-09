import { wrapUntrustedOcr } from "../mcp-json.js";
import type { PurchaseInvoice, Transaction } from "../types/api.js";
import type { InvoiceSummaryForMatching } from "./receipt-extraction.js";
import { scoreTransactionToInvoice } from "./receipt-extraction.js";
import type { InvoiceDuplicateMatch, TransactionMatchCandidate } from "./receipt-inbox-types.js";

const POSSIBLE_MATCH_THRESHOLD = 70;

export function findBestTransactionMatch(
  transactions: Transaction[],
  invoice: InvoiceSummaryForMatching,
  consumedTransactionIds: Set<number>,
): TransactionMatchCandidate | undefined {
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

  return candidates[0];
}

export function findDuplicateInvoice(
  invoices: PurchaseInvoice[],
  clientsId: number,
  invoiceNumber: string,
  createDate: string,
  grossPrice: number,
): InvoiceDuplicateMatch | undefined {
  const normalizedNumber = invoiceNumber.trim().toLowerCase();

  const sameNumber = invoices.find(invoice =>
    invoice.clients_id === clientsId &&
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.number.trim().toLowerCase() === normalizedNumber
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
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.create_date === createDate &&
    Math.abs((invoice.gross_price ?? 0) - grossPrice) < 0.01
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
