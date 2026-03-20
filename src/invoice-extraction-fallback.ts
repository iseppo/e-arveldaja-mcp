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
  raw_text?: string;
}

export interface InvoiceExtractionFallback {
  raw_text_available: boolean;
  recommended: boolean;
  reason: string;
  missing_required_fields: string[];
  missing_optional_fields: string[];
  guidance: string;
}

export interface IdentifierHintFallback {
  recommended: boolean;
  missing_identifier_hints: string[];
  guidance: string;
}

const AUTO_INVOICE_NUMBER_PREFIX = "AUTO-";

export function hasConfidentInvoiceNumber(value?: string): boolean {
  const normalized = value?.trim();
  return Boolean(normalized) && !normalized!.startsWith(AUTO_INVOICE_NUMBER_PREFIX);
}

export function summarizeIdentifierHintFallback(hints: Pick<InvoiceExtractionSnapshot, "supplier_reg_code" | "supplier_vat_no" | "supplier_iban" | "ref_number">): IdentifierHintFallback {
  const missingIdentifierHints = [
    hints.supplier_reg_code ? undefined : "supplier_reg_code",
    hints.supplier_vat_no ? undefined : "supplier_vat_no",
    hints.supplier_iban ? undefined : "supplier_iban",
    hints.ref_number ? undefined : "ref_number",
  ].filter((value): value is string => value !== undefined);

  return {
    recommended: missingIdentifierHints.length > 0,
    missing_identifier_hints: missingIdentifierHints,
    guidance: missingIdentifierHints.length > 0
      ? "Regex identifiers are only hints. Continue from hints.raw_text and extract missing values manually instead of assuming they are absent."
      : "Identifier hints look complete. Still use hints.raw_text as the source of truth for the full invoice."
  };
}

export function summarizeInvoiceExtraction(snapshot: InvoiceExtractionSnapshot): InvoiceExtractionFallback {
  const missingRequiredFields = [
    snapshot.supplier_name ? undefined : "supplier_name",
    hasConfidentInvoiceNumber(snapshot.invoice_number) ? undefined : "invoice_number",
    snapshot.invoice_date ? undefined : "invoice_date",
    snapshot.total_gross !== undefined ? undefined : "total_gross",
  ].filter((value): value is string => value !== undefined);

  const missingOptionalFields = [
    snapshot.due_date ? undefined : "due_date",
    snapshot.total_net !== undefined ? undefined : "total_net",
    snapshot.total_vat !== undefined ? undefined : "total_vat",
    snapshot.supplier_reg_code ? undefined : "supplier_reg_code",
    snapshot.supplier_vat_no ? undefined : "supplier_vat_no",
    snapshot.supplier_iban ? undefined : "supplier_iban",
    snapshot.ref_number ? undefined : "ref_number",
  ].filter((value): value is string => value !== undefined);

  const rawTextAvailable = Boolean(snapshot.raw_text?.trim());
  const recommended = !rawTextAvailable || missingRequiredFields.length > 0;

  const reason = !rawTextAvailable
    ? "No OCR/raw text is available for semantic fallback."
    : missingRequiredFields.length > 0
      ? "Deterministic extraction left required invoice fields unresolved."
      : "Deterministic extraction found the minimum fields needed for invoice review.";

  const guidance = !rawTextAvailable
    ? "Keep the document in review. Without raw_text, the model cannot safely recover the missing fields."
    : recommended
      ? "Use extracted.raw_text as the source of truth. Extract the missing required fields manually with the model, then validate totals before booking. If the document still does not contain them, keep the result in review instead of guessing."
      : "Raw OCR text is available for verification. Use it to confirm ambiguous fields before executing any booking."
  ;

  return {
    raw_text_available: rawTextAvailable,
    recommended,
    reason,
    missing_required_fields: missingRequiredFields,
    missing_optional_fields: missingOptionalFields,
    guidance,
  };
}
