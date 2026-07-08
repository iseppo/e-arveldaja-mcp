import { wrapUntrustedOcr, capUntrustedText } from "../mcp-json.js";
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
          ...(description !== undefined && { description: wrapUntrustedOcr(description) }),
          ...(supplier_name !== undefined && { supplier_name: wrapUntrustedOcr(supplier_name) }),
          ...(hasExtractionNotes && {
            extraction_notes: extraction_notes!.map(entry => wrapUntrustedOcr(entry) ?? entry),
          }),
          ...(hasProvenance && {
            field_provenance: field_provenance!.map(entry => ({
              ...entry,
              value: typeof entry.value === "string" ? wrapUntrustedOcr(entry.value) ?? entry.value : entry.value,
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

  if (next.error !== undefined) {
    next = { ...next, error: wrapUntrustedOcr(next.error) ?? next.error };
  }

  return next;
}
