import type { Transaction, SaleInvoice, PurchaseInvoice } from "../../types/api.js";
import { bankPostingSideForInvoiceMatch, bankTransactionDirection } from "../../bank-transaction-direction.js";
import { buildInvoiceIndex, getIndexedCandidates, type InvoiceIndex } from "./invoice-index.js";
import {
  matchScore,
  getInvoiceMatchEligibility,
  isAmbiguousForeignInvoiceBase,
  isUnpaidPaymentStatus,
  sameAmountToTheCent,
  type MatchCandidate,
} from "./match-score.js";
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

/** auto_confirm_exact_matches' default min_confidence. */
export const EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE = 90;

/**
 * The ref-number rule: a payment carrying an invoice's structured reference
 * number at the exact EUR amount scores only 80 (exact_amount + ref_number) and
 * reaches the default 90 only with a matching clients_id, which live CAMT/Wise
 * rows rarely carry. It is admitted at thresholds up to the default only when
 * every piece of evidence is present:
 * - EUR row (no differing base) vs EUR invoice, cents-exact (`exact_amount`,
 *   never Tier A or a cross-currency reason);
 * - a signed direction marker matching the invoice kind (incoming ↔ sale,
 *   outgoing ↔ purchase); an unsigned row is "unknown" and never qualifies;
 * - the reference names exactly one open invoice of either kind;
 * - the invoice is CONFIRMED and unpaid ("", null, NOT_PAID).
 * The caller still requires a single candidate, consumes the invoice key and
 * applies the third-party-payer partition.
 */
function isRefNumberExactMatch(
  tx: Transaction,
  inv: SaleInvoice | PurchaseInvoice,
  type: MatchCandidate["type"],
  reasons: readonly string[],
  saleIndex: InvoiceIndex<SaleInvoice>,
  purchaseIndex: InvoiceIndex<PurchaseInvoice>,
): boolean {
  if (!reasons.includes("exact_amount") || !reasons.includes("ref_number")) return false;
  if (transactionCurrency(tx) !== "EUR") return false;
  if (typeof inv.cl_currencies_id !== "string" || inv.cl_currencies_id.trim().toUpperCase() !== "EUR") return false;
  if (tx.base_amount != null && !sameAmountToTheCent(tx.base_amount, tx.amount)) return false;
  if (bankTransactionDirection(tx) !== (type === "sale_invoice" ? "incoming" : "outgoing")) return false;
  if (inv.status !== "CONFIRMED" || !isUnpaidPaymentStatus(inv.payment_status)) return false;
  const ref = tx.ref_number ?? "";
  return (saleIndex.byRef.get(ref)?.length ?? 0) + (purchaseIndex.byRef.get(ref)?.length ?? 0) === 1;
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
  // An explicit min_confidence above the default opts out of the rule.
  const refRuleApplies = threshold <= EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE;

  if (allowSaleInvoices) {
    for (const inv of getIndexedCandidates(saleIndex, tx.ref_number, tx.amount, tx.base_amount)) {
      if (inv.payment_status === "PARTIALLY_PAID") continue;
      if (consumedInvoiceKeys.has(`sale:${inv.id!}`)) continue;
      const { confidence, reasons } = matchScore(tx, inv, tx.amount);
      const byRule = confidence < threshold && refRuleApplies &&
        isRefNumberExactMatch(tx, inv, "sale_invoice", reasons, saleIndex, purchaseIndex);
      if (confidence >= threshold || byRule) {
        candidates.push({
          type: "sale_invoice", id: inv.id!, number: inv.number ?? "",
          client_name: inv.client_name ?? "", clients_id: inv.clients_id,
          gross_price: inv.gross_price ?? 0, payment_status: inv.payment_status ?? "NOT_PAID",
          partially_paid_warning: false, confidence, match_reasons: reasons,
          ...(byRule ? { auto_confirm_rule: "ref_number_exact" as const } : {}),
        });
      }
    }
  }
  if (allowPurchaseInvoices) {
    for (const inv of getIndexedCandidates(purchaseIndex, tx.ref_number, tx.amount, tx.base_amount)) {
      if (inv.payment_status === "PARTIALLY_PAID") continue;
      if (consumedInvoiceKeys.has(`purchase:${inv.id!}`)) continue;
      const { confidence, reasons } = matchScore(tx, inv, tx.amount);
      const byRule = confidence < threshold && refRuleApplies &&
        isRefNumberExactMatch(tx, inv, "purchase_invoice", reasons, saleIndex, purchaseIndex);
      if (confidence >= threshold || byRule) {
        candidates.push({
          type: "purchase_invoice", id: inv.id!, number: inv.number ?? "",
          client_name: inv.client_name ?? "", clients_id: inv.clients_id,
          gross_price: inv.gross_price ?? 0, payment_status: inv.payment_status ?? "NOT_PAID",
          partially_paid_warning: false, confidence, match_reasons: reasons,
          ...(byRule ? { auto_confirm_rule: "ref_number_exact" as const } : {}),
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
    if (candidates.length > 1 && isAmbiguousForeignInvoiceBase(candidates.map(c => ({ confidence: c.confidence, reasons: c.match_reasons })))) {
      skipped.push({
        transaction_id: tx.id,
        reason: `ambiguous_foreign_invoice_base: ${candidates.map(c => `${c.type} #${c.id}`).join(", ")} compete on a foreign-currency invoice base amount; match manually.`,
      });
      continue;
    }
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
      ...(match.auto_confirm_rule !== undefined ? { autoConfirmRule: match.auto_confirm_rule } : {}),
      clientResolution,
      needsClientUpdate: clientResolution === "set_missing",
      accountsDimensionsId: tx.accounts_dimensions_id,
      direction: bankPostingSideForInvoiceMatch(tx, match.type),
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
