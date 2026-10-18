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
  /** Buyer's own registry code was the only reg code on the page (#22). */
  self_reg_code_detected?: boolean;
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
   * routed to review rather than auto-confirmed.
   */
  foreign_reverse_charge_default_unverified?: boolean;
  /**
   * EST-supplier invoice (country inferred) but no supplier VAT recovered —
   * KMS § 37 compliance risk. Medium signal: routes to review, but a
   * non-VAT-registered Estonian supplier legitimately has no KMKR.
   */
  missing_supplier_vat_on_est_invoice?: boolean;
  /** Parser reported OCR text likely missing for an OCR-needed page. */
  partial_ocr_failure?: boolean;
  /** OCR text item confidence fell below the review threshold. */
  low_ocr_confidence?: boolean;
  /**
   * The supplier reg code / VAT number was only kept because the buyer-selected
   * value ALSO appears at a supplier coordinate (rationale
   * `coordinate_confirmed_echo`). Coordinate data alone cannot tell a supplier's
   * own id echoed in the buyer block (legit) from a buyer's id echoed in a
   * supplier-column reference line (false accept), so the value is UNCONFIRMED —
   * routed to review so the operator verifies the supplier before booking (#1).
   * Medium signal: the value is kept (not dropped, so a real supplier id is not
   * lost), but not trusted as firmly coordinate-confirmed.
   */
  supplier_identifier_echo_unconfirmed?: boolean;
  /**
   * Layout (coordinate) and text extraction produced different gross totals.
   * Whichever one was kept, the payable amount is unverified — routed to review
   * and gated from automatic creation in every mode.
   */
  total_gross_conflict?: boolean;
  /**
   * F-CURRENCY-EQUIVALENT: the document shows EUR and one foreign currency, and
   * supplier history or a candidate payment suggests the other currency than the
   * one extracted. The extracted currency is kept; routed to review and gated
   * from automatic creation in every mode.
   */
  currency_equivalent_ambiguity?: boolean;
  /**
   * The extracted amounts are internally inconsistent (any
   * `amount_consistency_issues` code except `vat_rate_implausible`): labelled
   * amounts contradict each other, a negative / oversized VAT, or a net that
   * does not carry the VAT. Low signal.
   */
  amounts_inconsistent?: boolean;
  /**
   * The extracted VAT / net matches no VAT rate in force on the invoice date
   * (mixed-rate documents included). Medium signal, gated from automatic
   * creation in every mode.
   */
  vat_rate_implausible?: boolean;
  /**
   * The file holds several documents (two or more distinct ticket numbers);
   * one extracted gross cannot book them. Medium signal, gated from automatic
   * creation in every mode.
   */
  multiple_documents_in_file?: boolean;
  /**
   * The document's buyer block names another legal entity and none of the
   * active company's identifiers: the document belongs to another company.
   * Medium signal, gated from automatic creation in every mode.
   */
  buyer_not_active_company?: boolean;
  /**
   * The buyer block names the active company AND another legal entity. Medium
   * signal, gated from automatic creation in every mode.
   */
  buyer_ambiguous?: boolean;
  /**
   * The buyer block names a legal entity, but no own-company name, registry
   * code or VAT number is known, so the document's ownership cannot be
   * verified. Medium signal, gated from automatic creation in every mode.
   */
  buyer_ownership_unverified?: boolean;
  /**
   * The invoice-number labels offer two or more different numbers; a wrong
   * number can skip a real invoice as a duplicate. Medium signal, gated from
   * automatic creation in every mode.
   */
  invoice_number_ambiguous?: boolean;
  /**
   * The gross is the largest unlabelled amount, not corroborated by a labelled
   * net + labelled VAT. Medium signal, gated from automatic creation in every mode.
   */
  gross_unlabelled?: boolean;
  /**
   * A labelled net / VAT / gross amount exceeds the receipt amount maximum,
   * whether it was kept or dropped. Medium signal, gated from automatic
   * creation in every mode.
   */
  labelled_amount_over_max?: boolean;
  /**
   * A total (not a remaining-balance) label states a zero amount (credit note,
   * fully prepaid or zero invoice). Medium signal, gated from automatic
   * creation in every mode.
   */
  zero_total_stated?: boolean;
  /**
   * The supplier identity came from a page-column identity block (a footer):
   * a suggestion only. Gated from automatic creation (and client creation) in
   * every mode; receipt_batch may only skip it as a duplicate on the same
   * invoice number AND gross.
   */
  supplier_from_footer_block?: boolean;
  /**
   * Two or more different labelled supplier registry codes or VAT numbers
   * compete and the chosen one has no positional proof (one may be the
   * buyer's). Gated from automatic creation (and client creation) in every
   * mode; receipt_batch never skips it as a duplicate.
   */
  supplier_identifier_ambiguous?: boolean;
  /**
   * No invoice-date label was found: the date is the first date on the page.
   * Medium signal, gated from automatic creation in every mode.
   */
  invoice_date_unlabelled?: boolean;
  /**
   * Text hazards (documentTextHazards, shared with the reading checker; P2 E0),
   * computed on the caller's own parse by textHazardSignals.
   * A credit or refund word appears as whole tokens.
   */
  credit_word_present?: boolean;
  /** An amount is printed with a minus sign or in parentheses. */
  signed_amount_present?: boolean;
  /**
   * A non-EUR ISO code, a non-€ symbol or a letter symbol next to an amount
   * appears in the text of a document read (or defaulted) as EUR (P2 E3).
   * Gated from automatic creation in every mode.
   */
  foreign_currency_marker?: boolean;
}

/**
 * Extraction signals that gate automatic creation in every mode, not only in
 * create_and_confirm: the amount or the document's ownership is unverified.
 */
export const CREATION_GATING_EXTRACTION_SIGNALS = [
  "multiple_documents_in_file",
  "buyer_not_active_company",
  "buyer_ambiguous",
  "buyer_ownership_unverified",
  "invoice_number_ambiguous",
  "gross_unlabelled",
  "labelled_amount_over_max",
  "zero_total_stated",
  "supplier_from_footer_block",
  "supplier_identifier_ambiguous",
  "invoice_date_unlabelled",
  "foreign_currency_marker",
] as const satisfies ReadonlyArray<keyof ExtractionConfidenceSignals>;

/** Operator-facing review warning per creation-gating extraction signal. */
export const CREATION_GATING_SIGNAL_WARNINGS: Record<typeof CREATION_GATING_EXTRACTION_SIGNALS[number], string> = {
  multiple_documents_in_file: "The file holds several documents (distinct ticket numbers); book each document separately.",
  buyer_not_active_company: "The buyer block names another legal entity, not the active company; verify the document belongs to this company.",
  buyer_ambiguous: "The buyer block names the active company and another legal entity; verify the buyer before booking.",
  buyer_ownership_unverified: "The buyer block names a company, but the active company's own name, registry code and VAT number are unknown; verify the document belongs to this company.",
  invoice_number_ambiguous: "The document labels two or more different invoice numbers, or the number looks cut short; verify which is this invoice's number before booking.",
  gross_unlabelled: "The gross is the largest unlabelled amount; verify the payable amount before booking.",
  labelled_amount_over_max: "A labelled amount exceeds the receipt amount maximum; verify the totals before booking.",
  zero_total_stated: "The document states a zero total (credit note, prepaid or zero invoice); verify before booking.",
  supplier_from_footer_block: "The supplier was read only from a footer identity block (name, registry code, VAT); it is a suggestion — verify the supplier before booking.",
  supplier_identifier_ambiguous: "The document labels two or more different supplier registry codes or VAT numbers (one may be the buyer's); verify the supplier before booking.",
  invoice_date_unlabelled: "No invoice-date label was found; the date is the first date on the page. Verify the invoice date before booking.",
  foreign_currency_marker: "The document is read as EUR but prints another currency's code or symbol next to an amount; verify the currency before booking.",
};

/**
 * Text hazards that are advisory for now (P2 E0): listed in every intake
 * caller's warnings/notes and in `confidence_signals`, but they neither lower
 * the confidence nor gate creation (E4 decides that).
 */
export const ADVISORY_TEXT_HAZARD_SIGNALS = ["credit_word_present", "signed_amount_present"] as const satisfies ReadonlyArray<keyof ExtractionConfidenceSignals>;

export const ADVISORY_TEXT_HAZARD_WARNINGS: Record<typeof ADVISORY_TEXT_HAZARD_SIGNALS[number], string> = {
  credit_word_present: "The document contains a credit-note or refund word; verify it is a purchase invoice, not a credit note or refund, before booking.",
  signed_amount_present: "The document prints an amount with a minus sign or in parentheses; verify the totals are not a credit or refund before booking.",
};

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

/** Guidance for a low-confidence extraction, naming where the OCR text lives. */
export function rawTextFallbackGuidance(rawTextField: string): string {
  return `Use ${rawTextField} as the source of truth. Extract the missing required fields manually with the model, then validate totals before booking. If the document still does not contain them, keep the result in review instead of guessing.`;
}

export function summarizeInvoiceExtraction(
  snapshot: InvoiceExtractionSnapshot,
  signals?: ExtractionConfidenceSignals,
  // Response path where the caller exposes the full OCR text, named in the
  // guidance so a consumer is pointed at a field that actually exists. Defaults
  // to `extracted.raw_text` (the receipt-batch flow); `extract_pdf_invoice`
  // carries the text once as `hints.raw_text` and passes that instead.
  rawTextField: string = "extracted.raw_text",
  // Inferred supplier country (ISO 3-letter e-arveldaja code, e.g. "EST").
  // When EST and no supplier_vat_no is recovered, a KMS § 37 compliance
  // signal is emitted (medium). Optional/backwards-compatible.
  supplierCountry?: string,
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
  if (signals?.self_reg_code_detected) lowSignals.push("self_reg_code_detected");
  if (signals?.duplicate_invoice_in_batch) lowSignals.push("duplicate_invoice_in_batch");
  if (signals?.reverse_charge_phrase_unhandled) lowSignals.push("reverse_charge_phrase_unhandled");
  if (signals?.amounts_inconsistent) lowSignals.push("amounts_inconsistent");

  if (signals?.supplier_resolution_failed) mediumSignals.push("supplier_resolution_failed");
  if (signals?.improbable_fixed_asset) mediumSignals.push("improbable_fixed_asset");
  if (signals?.foreign_reverse_charge_default_unverified) mediumSignals.push("foreign_reverse_charge_default_unverified");
  if (signals?.missing_supplier_vat_on_est_invoice) mediumSignals.push("missing_supplier_vat_on_est_invoice");
  if (signals?.partial_ocr_failure) mediumSignals.push("partial_ocr_failure");
  if (signals?.low_ocr_confidence) mediumSignals.push("low_ocr_confidence");
  if (signals?.supplier_identifier_echo_unconfirmed) mediumSignals.push("supplier_identifier_echo_unconfirmed");
  if (signals?.total_gross_conflict) mediumSignals.push("total_gross_conflict");
  if (signals?.currency_equivalent_ambiguity) mediumSignals.push("currency_equivalent_ambiguity");
  if (signals?.vat_rate_implausible) mediumSignals.push("vat_rate_implausible");
  for (const signal of CREATION_GATING_EXTRACTION_SIGNALS) {
    if (signals?.[signal]) mediumSignals.push(signal);
  }
  // Auto-derive the EST-missing-VAT signal when the caller passes supplierCountry
  // but did not set the signal explicitly. Non-VAT-registered Estonian suppliers
  // legitimately have no KMKR, so this is a medium (review) signal, not low.
  if (!signals?.missing_supplier_vat_on_est_invoice &&
      supplierCountry === "EST" &&
      !snapshot.supplier_vat_no &&
      !mediumSignals.includes("missing_supplier_vat_on_est_invoice")) {
    mediumSignals.push("missing_supplier_vat_on_est_invoice");
  }
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

  // Advisory text hazards are listed but never change the confidence (P2 E0).
  const advisorySignals = ADVISORY_TEXT_HAZARD_SIGNALS.filter(signal => signals?.[signal]);
  const confidenceSignals: string[] = [...lowSignals, ...mediumSignals, ...advisorySignals];
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
      ? rawTextFallbackGuidance(rawTextField)
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
