import type { Transaction, SaleInvoice, PurchaseInvoice } from "../../types/api.js";
import { bankTransactionDirection } from "../../bank-transaction-direction.js";
import { buildInvoiceIndex, getIndexedCandidates, type InvoiceIndex } from "./invoice-index.js";
import { matchScore, getInvoiceMatchEligibility, type MatchCandidate } from "./match-score.js";
import { transactionCurrency } from "./amount-resolution.js";
import type {
  ExactConfirmClientResolution,
  ExactConfirmDescriptor,
  ExactMatchProjection,
  ThirdPartyPayerReview,
  ThirdPartyPayerReviewReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// Exact-match duplicate detection / policy. PURE: deterministic projection of
// the eligible high-confidence single matches. The cross-mechanism duplicate
// SCAN (api reads + wrapUntrustedOcr) lives in the executor and injects its
// results as data; the projection/partition logic here stays pure.
// ---------------------------------------------------------------------------

/**
 * The one operator instruction a third-party-payer row carries.
 *
 * `journal.clients_id` is copied from the transaction, so confirming as-is
 * files the receivable/payable leg under the payer instead of the invoice
 * client. `reassign_client_to_invoice` moves the transaction to the invoice's
 * client first; `bank_account_name` (the real payer) is never touched.
 */
export const THIRD_PARTY_PAYER_NEXT_ACTION =
  "Review the payer: if the payment settles this invoice, run confirm_transaction <id> with distributions "
  + "[{related_table, related_id, amount}] and reassign_client_to_invoice: true (books the receipt under the "
  + "invoice's client; the bank payer name is kept). Otherwise match manually.";

export const INVOICE_CLIENT_MISSING_NEXT_ACTION =
  "The matched invoice has no client, so the receipt cannot be pinned to a client sub-ledger: set the client on "
  + "the invoice first (update_sale_invoice / update_purchase_invoice), then confirm_transaction <id> with "
  + "distributions [{related_table, related_id, amount}].";

/**
 * Why a unique exact match must NOT be auto-confirmed, or `undefined` when the
 * payer and the invoice client are reconcilable.
 *
 * A missing invoice client is checked first: it also covers a transaction with
 * no client of its own, where there is simply nothing to file the receipt under.
 */
export function thirdPartyPayerReviewReason(
  transactionClientsId: number | null,
  invoiceClientsId: number | null,
): ThirdPartyPayerReviewReason | undefined {
  if (invoiceClientsId == null) return "invoice_client_missing";
  if (transactionClientsId != null && transactionClientsId !== invoiceClientsId) return "third_party_payer";
  return undefined;
}

export function collectExactMatchCandidates(
  tx: Transaction,
  saleIndex: InvoiceIndex<SaleInvoice>,
  purchaseIndex: InvoiceIndex<PurchaseInvoice>,
  threshold: number,
  consumedInvoiceKeys: Set<string>,
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  const { allowSaleInvoices, allowPurchaseInvoices } = getInvoiceMatchEligibility(tx);

  if (allowSaleInvoices) {
    for (const inv of getIndexedCandidates(saleIndex, tx.ref_number, tx.amount, tx.base_amount)) {
      if (inv.payment_status === "PARTIALLY_PAID") continue;
      if (consumedInvoiceKeys.has(`sale:${inv.id!}`)) continue;
      const { confidence, reasons } = matchScore(tx, inv, tx.amount);
      if (confidence >= threshold) {
        candidates.push({
          type: "sale_invoice", id: inv.id!, number: inv.number ?? "",
          client_name: inv.client_name ?? "", clients_id: inv.clients_id,
          gross_price: inv.gross_price ?? 0, payment_status: inv.payment_status ?? "NOT_PAID",
          partially_paid_warning: false, confidence, match_reasons: reasons,
        });
      }
    }
  }
  if (allowPurchaseInvoices) {
    for (const inv of getIndexedCandidates(purchaseIndex, tx.ref_number, tx.amount, tx.base_amount)) {
      if (inv.payment_status === "PARTIALLY_PAID") continue;
      if (consumedInvoiceKeys.has(`purchase:${inv.id!}`)) continue;
      const { confidence, reasons } = matchScore(tx, inv, tx.amount);
      if (confidence >= threshold) {
        candidates.push({
          type: "purchase_invoice", id: inv.id!, number: inv.number ?? "",
          client_name: inv.client_name ?? "", clients_id: inv.clients_id,
          gross_price: inv.gross_price ?? 0, payment_status: inv.payment_status ?? "NOT_PAID",
          partially_paid_warning: false, confidence, match_reasons: reasons,
        });
      }
    }
  }
  return candidates;
}

export function computeExactMatchProjection(
  unconfirmed: Transaction[],
  openSales: SaleInvoice[],
  openPurchases: PurchaseInvoice[],
  threshold: number,
): ExactMatchProjection {
  const saleIndex = buildInvoiceIndex(openSales);
  const purchaseIndex = buildInvoiceIndex(openPurchases);
  const confirms: ExactConfirmDescriptor[] = [];
  const skipped: Array<{ transaction_id?: number; reason: string }> = [];
  const thirdPartyPayerReviews: ThirdPartyPayerReview[] = [];
  const consumedInvoiceKeys = new Set<string>();

  for (const tx of unconfirmed) {
    const candidates = collectExactMatchCandidates(tx, saleIndex, purchaseIndex, threshold, consumedInvoiceKeys);
    if (candidates.length !== 1) continue;
    const match = candidates[0]!;

    const crossCurrency =
      (match.match_reasons.includes("exact_base_amount") ||
        match.match_reasons.includes("cross_currency_conflict")) &&
      !match.match_reasons.includes("exact_amount");
    if (crossCurrency) {
      skipped.push({
        transaction_id: tx.id,
        reason: `Cross-currency match (base-amount only) against ${match.type} #${match.id}; compute the correct distribution amount manually before confirming.`,
      });
      continue;
    }

    consumedInvoiceKeys.add(`${match.type.replace("_invoice", "")}:${match.id}`);
    const clientsId = tx.clients_id ?? null;
    const invoiceClientsId = match.clients_id ?? null;

    // The invoice key is consumed above BEFORE this partition, so a reviewed
    // row still blocks a second transaction from claiming the same invoice.
    const reviewReason = thirdPartyPayerReviewReason(clientsId, invoiceClientsId);
    if (reviewReason !== undefined) {
      thirdPartyPayerReviews.push({
        transaction_id: tx.id!,
        ...(tx.date !== undefined ? { date: tx.date } : {}),
        amount: tx.amount,
        currency: transactionCurrency(tx),
        invoice_type: match.type,
        invoice_id: match.id,
        invoice_number: match.number,
        transaction_clients_id: clientsId,
        invoice_clients_id: invoiceClientsId,
        confidence: match.confidence,
        reason: reviewReason,
        next_action: reviewReason === "invoice_client_missing" ? INVOICE_CLIENT_MISSING_NEXT_ACTION : THIRD_PARTY_PAYER_NEXT_ACTION,
      });
      continue;
    }

    const clientResolution: ExactConfirmClientResolution = clientsId == null ? "set_missing" : "unchanged";
    confirms.push({
      transactionId: tx.id!,
      date: tx.date,
      amount: tx.amount,
      baseAmount: tx.base_amount ?? tx.amount,
      currency: transactionCurrency(tx),
      clientsId,
      invoiceType: match.type,
      invoiceTable: match.type === "sale_invoice" ? "sale_invoices" : "purchase_invoices",
      invoiceId: match.id,
      invoiceNumber: match.number,
      invoiceClientsId,
      confidence: match.confidence,
      clientResolution,
      needsClientUpdate: clientResolution === "set_missing",
      accountsDimensionsId: tx.accounts_dimensions_id,
      direction: bankTransactionDirection(tx) === "incoming" ? "D" : "C",
    });
  }

  return {
    totalUnconfirmed: unconfirmed.length,
    confirms,
    skipped,
    thirdPartyPayerReviews,
    blockedDuplicateSuspects: [],
  };
}
