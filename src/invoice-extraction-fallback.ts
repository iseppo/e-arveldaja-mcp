export interface InvoiceExtractionSnapshot {
  supplier_name?: string;
  supplier_reg_code?: string;
  supplier_vat_no?: string;
  supplier_iban?: string;
  ref_number?: string;
  invoice_number?: string;
  invoice_date?: string;
  due_date?: string;
  total_net?: number;
  total_vat?: number;
  total_gross?: number;
  /** ISO 4217 currency code; undefined when extraction couldn't bind a symbol or code to the amount line. */
  currency?: string;
  raw_text?: string;
}

export type ExtractionConfidence = "low" | "medium" | "high";

/**
 * External signals that contribute to the confidence score (issue #20).
 * `summarizeInvoiceExtraction` only sees the deterministic snapshot; the
 * caller decides whether the supplier resolved, whether the booking
 * suggestion came from history, etc., and passes those flags in.
 */
export interface ExtractionConfidenceSignals {
  /** Buyer's own VAT was the only VAT on the page (#14). */
  self_vat_detected?: boolean;
  /** Supplier resolution did not return a concrete client. */
  supplier_resolution_failed?: boolean;
  /** Booking suggestion came from supplier history (clients_id), not a keyword fallback. */
  booking_from_history?: boolean;
  /** Same supplier-side invoice number appears twice in the same batch. */
  duplicate_invoice_in_batch?: boolean;
  /** OCR text contained reverse-charge phrasing but the booking suggestion did not set reversed_vat_id. */
  reverse_charge_phrase_unhandled?: boolean;
  /** Booking suggestion proposes a fixed-asset account for an implausibly small invoice. */
  improbable_fixed_asset?: boolean;
  /**
   * Reverse-charge was set via the foreign-supplier default (#18) — i.e.
   * not by an explicit phrase in the document and not by supplier history.
   * The default is convenient for the SaaS/service common case but wrong
   * for goods imports, so the row is downgraded to medium confidence and
   * routed to review rather than auto-confirmed. (Codex MEDIUM follow-up.)
   */
  foreign_reverse_charge_default_unverified?: boolean;
}

export interface InvoiceExtractionFallback {
  raw_text_available: boolean;
  /**
   * Backwards-compatibility derived alias (#20).
   * `recommended === true` when raw text is missing OR confidence is not high.
   * Pre-#20 callers can keep using this without change; new callers should
   * branch on `confidence`.
   */
  recommended: boolean;
  confidence: ExtractionConfidence;
  /** Names of the signals that triggered a downgrade — empty on `high`. */
  confidence_signals: string[];
  reason: string;
  missing_required_fields: string[];
  missing_optional_fields: string[];
  guidance: string;
}

const AUTO_INVOICE_NUMBER_PREFIX = "AUTO-";

export function hasConfidentInvoiceNumber(value?: string): boolean {
  const normalized = value?.trim();
  return Boolean(normalized) && !normalized!.startsWith(AUTO_INVOICE_NUMBER_PREFIX);
}

export function summarizeInvoiceExtraction(
  snapshot: InvoiceExtractionSnapshot,
  signals?: ExtractionConfidenceSignals,
): InvoiceExtractionFallback {
  // Currency is conditionally required: only when there's a numeric total to
  // attach units to. Without it, booking the gross at face value silently
  // assumes EUR — which is wrong for USD-denominated invoices like the
  // OpenAI Estonian-language receipts (issue #16).
  const currencyRequired = snapshot.total_gross !== undefined;
  const missingRequiredFields = [
    snapshot.supplier_name ? undefined : "supplier_name",
    hasConfidentInvoiceNumber(snapshot.invoice_number) ? undefined : "invoice_number",
    snapshot.invoice_date ? undefined : "invoice_date",
    snapshot.total_gross !== undefined ? undefined : "total_gross",
    currencyRequired && !snapshot.currency ? "currency" : undefined,
  ].filter((value): value is string => value !== undefined);

  const missingOptionalFields = [
    snapshot.due_date ? undefined : "due_date",
    snapshot.total_net !== undefined ? undefined : "total_net",
    snapshot.total_vat !== undefined ? undefined : "total_vat",
    snapshot.supplier_reg_code ? undefined : "supplier_reg_code",
    snapshot.supplier_vat_no ? undefined : "supplier_vat_no",
    snapshot.supplier_iban ? undefined : "supplier_iban",
    snapshot.ref_number ? undefined : "ref_number",
    !currencyRequired && !snapshot.currency ? "currency" : undefined,
  ].filter((value): value is string => value !== undefined);

  const rawTextAvailable = Boolean(snapshot.raw_text?.trim());
  const currencyDefaulted = currencyRequired && !snapshot.currency;

  // Confidence ladder (#20): plausibility check, not just field presence.
  // Low signals: any one is enough to drop to low.
  //   - missing required fields, currency defaulted, self-VAT on page,
  //     duplicate invoice number in the same batch, reverse-charge phrase
  //     present but the booking suggestion did not flag it.
  // Medium signals (only relevant if not already low):
  //   - supplier resolution failed, booking suggestion proposes an
  //     implausible fixed-asset.
  // High requires raw text AND no missing required fields AND no
  // medium-or-low signals.
  const lowSignals: string[] = [];
  const mediumSignals: string[] = [];

  if (!rawTextAvailable) lowSignals.push("raw_text_missing");
  if (missingRequiredFields.length > 0) lowSignals.push("missing_required_fields");
  if (currencyDefaulted) lowSignals.push("currency_defaulted");
  if (signals?.self_vat_detected) lowSignals.push("self_vat_detected");
  if (signals?.duplicate_invoice_in_batch) lowSignals.push("duplicate_invoice_in_batch");
  if (signals?.reverse_charge_phrase_unhandled) lowSignals.push("reverse_charge_phrase_unhandled");

  if (signals?.supplier_resolution_failed) mediumSignals.push("supplier_resolution_failed");
  if (signals?.improbable_fixed_asset) mediumSignals.push("improbable_fixed_asset");
  if (signals?.foreign_reverse_charge_default_unverified) mediumSignals.push("foreign_reverse_charge_default_unverified");
  // Booking from a keyword/fallback path is fine for low-stakes review,
  // but it's a soft signal that we did NOT find a confirming history. Only
  // downgrade to medium when paired with another medium-or-low signal —
  // here, only when the booking source is unknown AND we're already not
  // boosting confidence to high.
  const confidence: ExtractionConfidence = lowSignals.length > 0
    ? "low"
    : mediumSignals.length > 0 || signals?.booking_from_history === false
      ? "medium"
      : "high";

  const confidenceSignals: string[] = [...lowSignals, ...mediumSignals];
  if (confidence === "medium" && signals?.booking_from_history === false && !confidenceSignals.includes("booking_not_from_history")) {
    confidenceSignals.push("booking_not_from_history");
  }

  // `recommended` was: "fallback to LLM/manual review needed". Preserve the
  // original semantics by deriving it from confidence: any non-high
  // outcome should still surface the recommendation.
  const recommended = confidence !== "high";

  const reason = !rawTextAvailable
    ? "No OCR/raw text is available for semantic fallback."
    : missingRequiredFields.length > 0
      ? "Deterministic extraction left required invoice fields unresolved."
      : confidence === "high"
        ? "Deterministic extraction found the minimum fields needed for invoice review."
        : `Deterministic extraction completed but confidence is ${confidence} due to: ${confidenceSignals.join(", ")}.`;

  const guidance = !rawTextAvailable
    ? "Keep the document in review. Without raw_text, the model cannot safely recover the missing fields."
    : recommended
      ? "Use extracted.raw_text as the source of truth. Extract the missing required fields manually with the model, then validate totals before booking. If the document still does not contain them, keep the result in review instead of guessing."
      : "Raw OCR text is available for verification. Use it to confirm ambiguous fields before executing any booking."
  ;

  return {
    raw_text_available: rawTextAvailable,
    recommended,
    confidence,
    confidence_signals: confidenceSignals,
    reason,
    missing_required_fields: missingRequiredFields,
    missing_optional_fields: missingOptionalFields,
    guidance,
  };
}
