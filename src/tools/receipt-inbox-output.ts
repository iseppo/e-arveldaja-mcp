import { wrapUntrustedOcr } from "../mcp-json.js";
import type { ReceiptBatchFileResult } from "./receipt-inbox-types.js";

// Wrap free-form OCR-derived fields with untrusted-OCR delimiters at MCP
// output time so a downstream LLM cannot be tricked into executing
// instructions embedded in a scanned receipt.
export function sanitizeReceiptResultForOutput(result: ReceiptBatchFileResult): ReceiptBatchFileResult {
  let next = result;

  if (next.extracted) {
    const { raw_text, description, supplier_name } = next.extracted;
    if (raw_text !== undefined || description !== undefined || supplier_name !== undefined) {
      next = {
        ...next,
        extracted: {
          ...next.extracted,
          ...(raw_text !== undefined && { raw_text: wrapUntrustedOcr(raw_text) }),
          ...(description !== undefined && { description: wrapUntrustedOcr(description) }),
          ...(supplier_name !== undefined && { supplier_name: wrapUntrustedOcr(supplier_name) }),
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
  if (next.notes.length > 0) {
    next = {
      ...next,
      notes: next.notes.map(note => wrapUntrustedOcr(note) ?? note),
    };
  }

  return next;
}
