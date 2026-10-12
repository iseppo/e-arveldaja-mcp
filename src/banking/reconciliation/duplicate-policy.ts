import type { Transaction, SaleInvoice, PurchaseInvoice } from "../../types/api.js";
import { bankPostingSideForInvoiceMatch, bankTransactionDirection } from "../../bank-transaction-direction.js";
import { buildInvoiceIndex, getIndexedCandidates, type InvoiceIndex } from "./invoice-index.js";
import {
  matchScore,
  getInvoiceMatchEligibility,
  EXACT_INVOICE_BASE_AMOUNT,
  isAmbiguousForeignInvoiceBase,
  isUnpaidPaymentStatus,
  sameAmountToTheCent,
  type MatchCandidate,
} from "./match-score.js";
import { transactionCurrency } from "./amount-resolution.js";
import { normalizeCompanyName } from "../../company-name.js";
import { extractCamtDescriptionMetadata, isTrustedCamtDescriptionMetadata, legacyTruncatedCamtMarkerHint } from "../../camt/duplicate-identity.js";
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
 * The statement direction of a row whose CAMT marker passes its checksum
 * (`isTrustedCamtDescriptionMetadata`), else `undefined`. The marker's shape
 * alone (what `bankTransactionDirection` reads) is not proof: flipping
 * `dir=DBIT` to `dir=CRDT` breaks the `sig` but keeps the shape. A Wise
 * `[source_direction=…]` marker carries no checksum at all, so it never counts
 * as proven here.
 */
function verifiedCamtDirection(tx: Transaction): "incoming" | "outgoing" | undefined {
  const metadata = extractCamtDescriptionMetadata(tx.description);
  if (metadata.source_direction === undefined || !isTrustedCamtDescriptionMetadata(tx, metadata)) return undefined;
  const direction = metadata.source_direction === "CRDT" ? "incoming" : "outgoing";
  return bankTransactionDirection(tx) === direction ? direction : undefined;
}

function hasProvenDirectionFor(tx: Transaction, type: MatchCandidate["type"]): boolean {
  return verifiedCamtDirection(tx) === (type === "sale_invoice" ? "incoming" : "outgoing");
}

/** A signed CAMT marker (it carries a `sig`) whose checksum does not verify. */
function camtMarkerFailsChecksum(tx: Transaction): boolean {
  const metadata = extractCamtDescriptionMetadata(tx.description);
  return metadata.entry_sig !== undefined && !isTrustedCamtDescriptionMetadata(tx, metadata);
}

/** `reason`, followed by why the marker cannot verify when the row has the legacy truncated shape. */
function withLegacyTruncationHint(tx: Transaction, reason: string): string {
  const hint = legacyTruncatedCamtMarkerHint(tx);
  return hint ? `${reason} ${hint}` : reason;
}

/** An explicitly stated ISO currency code, else `undefined` (missing, null, blank or malformed). */
function explicitCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/**
 * Why a single exact match lacks the currency evidence an automatic confirm
 * needs, or `undefined` when it has it. The scorer compares bare numbers, so
 * a row with no currency, or a USD row without a base amount, nominally equals
 * a EUR invoice and scores `exact_amount`. Admitted only:
 * - both currencies explicit and equal, cents-exact (`exact_amount`);
 * - an explicit EUR row vs a foreign invoice's structured EUR base (Tier A,
 *   `exact_invoice_base_amount`);
 * - a foreign row whose finite `base_amount` equals a EUR invoice to the cent.
 */
function currencyEvidenceGap(tx: Transaction, inv: SaleInvoice | PurchaseInvoice | undefined, reasons: readonly string[]): string | undefined {
  const txCurrency = explicitCurrency(tx.cl_currencies_id);
  if (txCurrency === undefined) return "the transaction carries no explicit currency";
  const invoiceCurrency = explicitCurrency(inv?.cl_currencies_id);
  if (invoiceCurrency === undefined) return "the invoice carries no explicit currency";
  if (txCurrency === invoiceCurrency) {
    return reasons.includes("exact_amount") ? undefined : `${txCurrency} amounts are not cents-exact`;
  }
  if (reasons.includes(EXACT_INVOICE_BASE_AMOUNT)) return undefined;
  const baseMatchesEurInvoice = invoiceCurrency === "EUR" &&
    typeof tx.base_amount === "number" && Number.isFinite(tx.base_amount) &&
    sameAmountToTheCent(tx.base_amount, inv?.gross_price ?? Number.NaN);
  return baseMatchesEurInvoice
    ? undefined
    : `a ${txCurrency} transaction without an equal EUR base amount against a ${invoiceCurrency} invoice`;
}

/**
 * The ref-number rule: a payment carrying an invoice's structured reference
 * number at the exact EUR amount scores only 80 (exact_amount + ref_number) and
 * reaches the default 90 only with a matching clients_id, which live CAMT/Wise
 * rows rarely carry. It is admitted at thresholds up to the default only when
 * every piece of evidence is present:
 * - an explicit EUR row (a missing currency is not proof; no differing base)
 *   vs EUR invoice, cents-exact (`exact_amount`, never Tier A or a
 *   cross-currency reason);
 * - a checksum-verified CAMT direction matching the invoice kind (incoming ↔
 *   sale, outgoing ↔ purchase); an unsigned, Wise-only or tampered row never
 *   qualifies;
 * - the reference names exactly one open invoice of either kind;
 * - the invoice is CONFIRMED and unpaid ("", null, NOT_PAID).
 * The caller still requires a single candidate, consumes the invoice key and
 * applies the third-party-payer partition. A match that fails ONLY because the
 * row's CAMT marker checksum does not verify is reported to
 * `unverifiedMarkerMatches`, so the owner is told why it was not admitted.
 */
function isRefNumberExactMatch(
  tx: Transaction,
  inv: SaleInvoice | PurchaseInvoice,
  type: MatchCandidate["type"],
  reasons: readonly string[],
  saleIndex: InvoiceIndex<SaleInvoice>,
  purchaseIndex: InvoiceIndex<PurchaseInvoice>,
  unverifiedMarkerMatches?: string[],
): boolean {
  if (!reasons.includes("exact_amount") || !reasons.includes("ref_number")) return false;
  if (explicitCurrency(tx.cl_currencies_id) !== "EUR" || explicitCurrency(inv.cl_currencies_id) !== "EUR") return false;
  if (tx.base_amount != null && !sameAmountToTheCent(tx.base_amount, tx.amount)) return false;
  if (inv.status !== "CONFIRMED" || !isUnpaidPaymentStatus(inv.payment_status)) return false;
  const ref = tx.ref_number ?? "";
  if ((saleIndex.byRef.get(ref)?.length ?? 0) + (purchaseIndex.byRef.get(ref)?.length ?? 0) !== 1) return false;
  if (!hasProvenDirectionFor(tx, type)) {
    if (camtMarkerFailsChecksum(tx)) unverifiedMarkerMatches?.push(`${type} #${inv.id}`);
    return false;
  }
  return true;
}

export function collectExactMatchCandidates(
  tx: Transaction,
  saleIndex: InvoiceIndex<SaleInvoice>,
  purchaseIndex: InvoiceIndex<PurchaseInvoice>,
  threshold: number,
  consumedInvoiceKeys: Set<string>,
  unverifiedMarkerMatches?: string[],
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
        isRefNumberExactMatch(tx, inv, "sale_invoice", reasons, saleIndex, purchaseIndex, unverifiedMarkerMatches);
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
        isRefNumberExactMatch(tx, inv, "purchase_invoice", reasons, saleIndex, purchaseIndex, unverifiedMarkerMatches);
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
  const salesById = new Map(openSales.map(inv => [inv.id, inv]));
  const purchasesById = new Map(openPurchases.map(inv => [inv.id, inv]));

  for (const tx of unconfirmed) {
    const unverifiedMarkerMatches: string[] = [];
    const candidates = collectExactMatchCandidates(tx, saleIndex, purchaseIndex, threshold, consumedInvoiceKeys, unverifiedMarkerMatches);
    if (candidates.length === 0 && unverifiedMarkerMatches.length > 0) {
      skipped.push({
        transaction_id: tx.id,
        reason: withLegacyTruncationHint(tx, `direction_unproven: CAMT marker checksum does not verify; ${unverifiedMarkerMatches.join(", ")} would match by reference number and exact amount; confirm manually.`),
      });
      continue;
    }
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

    // Every automatic confirm needs explicit, compatible currency evidence.
    const invoice = match.type === "sale_invoice" ? salesById.get(match.id) : purchasesById.get(match.id);
    const currencyGap = currencyEvidenceGap(tx, invoice, match.match_reasons);
    if (currencyGap !== undefined) {
      skipped.push({
        transaction_id: tx.id,
        reason: `currency_unproven: ${match.type} #${match.id} matches but ${currencyGap}; confirm manually.`,
      });
      continue;
    }

    // Without a verified direction the row may be money going the other way.
    // Only the invoice's own counterparty is evidence that does not depend on
    // the direction: an equal clients_id, or a payer name equal to the invoice
    // client's once normalised (e-arveldaja's native bank import carries the
    // name but no client or marker). A substring name match never is:
    // "Vendor Logistics" paying out must not settle a sale invoice for
    // "Vendor" at exact_amount + ref_number + client_name_partial.
    const sameCounterparty = match.match_reasons.includes("client_id") || (
      match.match_reasons.includes("client_name_partial") &&
      normalizeCompanyName(tx.bank_account_name ?? "") === normalizeCompanyName(match.client_name)
    );
    if (!sameCounterparty && !hasProvenDirectionFor(tx, match.type)) {
      skipped.push({
        transaction_id: tx.id,
        reason: camtMarkerFailsChecksum(tx)
          ? withLegacyTruncationHint(tx, `direction_unproven: CAMT marker checksum does not verify; ${match.type} #${match.id} matches without a checksum-verified CAMT direction or the invoice's own client; confirm manually.`)
          : `direction_unproven: ${match.type} #${match.id} matches without a checksum-verified CAMT direction or the invoice's own client; confirm manually.`,
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
