import { wrapUntrustedOcr, capUntrustedText, MAX_UNTRUSTED_TEXT_CHARS } from "../mcp-json.js";

// Cap an OCR-derived string to the untrusted-text budget before it is wrapped,
// so a pathological (e.g. 30k-char) supplier name or note cannot flood the
// consuming LLM's context the way the raw_text blob is already capped.
function capThenWrap(value: string | undefined): string | undefined {
  return wrapUntrustedOcr(capUntrustedText(value, MAX_UNTRUSTED_TEXT_CHARS).text);
}
import type { ReceiptBatchFileResult } from "./receipt-inbox-types.js";

// Wrap free-form OCR-derived fields with untrusted-OCR delimiters at MCP
// output time so a downstream LLM cannot be tricked into executing
// instructions embedded in a scanned receipt.
export function sanitizeReceiptResultForOutput(result: ReceiptBatchFileResult): ReceiptBatchFileResult {
  let next = result;

  if (next.extracted) {
    const { raw_text, description, supplier_name, field_provenance, extraction_notes } = next.extracted;
    const hasProvenance = field_provenance !== undefined && field_provenance.length > 0;
    const hasExtractionNotes = extraction_notes !== undefined && extraction_notes.length > 0;
    if (raw_text !== undefined || description !== undefined || supplier_name !== undefined || hasProvenance || hasExtractionNotes) {
      // Cap the OCR blob before wrapping so an oversized/pathological document
      // cannot flood the consuming LLM's context; mark when it was truncated.
      const cappedRaw = capUntrustedText(raw_text);
      next = {
        ...next,
        extracted: {
          ...next.extracted,
          ...(raw_text !== undefined && { raw_text: wrapUntrustedOcr(cappedRaw.text) }),
          ...(cappedRaw.truncated && { raw_text_truncated: true, raw_text_length: cappedRaw.original_length }),
          // Cap the other OCR-derived strings too before wrapping (#4) — only
          // raw_text was capped previously, so a pathological supplier name /
          // note / provenance value could still flood the consuming LLM.
          ...(description !== undefined && { description: capThenWrap(description) }),
          ...(supplier_name !== undefined && { supplier_name: capThenWrap(supplier_name) }),
          ...(hasExtractionNotes && {
            extraction_notes: extraction_notes!.map(entry => capThenWrap(entry) ?? entry),
          }),
          ...(hasProvenance && {
            field_provenance: field_provenance!.map(entry => ({
              ...entry,
              value: typeof entry.value === "string" ? capThenWrap(entry.value) ?? entry.value : entry.value,
            })),
          }),
        },
      };
    }
  }

  if (next.supplier_resolution?.preview_client?.name !== undefined) {
    next = {
      ...next,
      supplier_resolution: {
        ...next.supplier_resolution,
        preview_client: {
          ...next.supplier_resolution.preview_client,
          name: wrapUntrustedOcr(next.supplier_resolution.preview_client.name),
        },
      },
    };
  }

  if (next.booking_suggestion?.item?.custom_title !== undefined) {
    next = {
      ...next,
      booking_suggestion: {
        ...next.booking_suggestion,
        item: {
          ...next.booking_suggestion.item,
          custom_title: wrapUntrustedOcr(next.booking_suggestion.item.custom_title) ?? next.booking_suggestion.item.custom_title,
        },
      },
    };
  }

  // The payment-receipt NOTE already wraps the invoice number, but the
  // structured `referenced_invoice.invoice_number` is OCR-derived too — wrap it
  // at the output-sanitization site with the same helper so a downstream LLM
  // cannot be tricked by an invoice number smuggled from a scanned receipt (#4).
  if (next.referenced_invoice?.invoice_number !== undefined) {
    next = {
      ...next,
      referenced_invoice: {
        ...next.referenced_invoice,
        invoice_number: wrapUntrustedOcr(next.referenced_invoice.invoice_number) ?? next.referenced_invoice.invoice_number,
      },
    };
  }

  // created_invoice.number echoes extracted.invoice_number (OCR-derived), so it
  // must be wrapped at output too (#3) — otherwise an invoice number smuggled
  // from a scanned receipt reaches the LLM unwrapped via this field.
  if (next.created_invoice?.number !== undefined) {
    next = {
      ...next,
      created_invoice: {
        ...next.created_invoice,
        number: wrapUntrustedOcr(next.created_invoice.number) ?? next.created_invoice.number,
      },
    };
  }

  if (next.error !== undefined) {
    next = { ...next, error: wrapUntrustedOcr(next.error) ?? next.error };
  }

  return next;
}
