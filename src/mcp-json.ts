import { encode, decode } from "@toon-format/toon";

/**
 * Wrap untrusted OCR / external text with explicit delimiters so that downstream
 * LLMs reading the MCP tool output treat the content as data rather than
 * instructions. Any tool that surfaces raw OCR output, supplier-entered fields,
 * or free-form bank descriptions to the caller should wrap the value with this
 * helper before serialization.
 */
export const UNTRUSTED_OCR_START = "<<UNTRUSTED_OCR_START>>";
export const UNTRUSTED_OCR_END = "<<UNTRUSTED_OCR_END>>";

export function wrapUntrustedOcr(text: string | undefined | null): string | undefined {
  if (text === undefined || text === null) return undefined;
  if (text === "") return text;
  return `${UNTRUSTED_OCR_START}\n${text}\n${UNTRUSTED_OCR_END}`;
}

/** Strip null/undefined fields recursively, then encode as TOON for minimal token usage. */
export function toMcpJson(obj: unknown): string {
  let stripped: unknown;
  try {
    stripped = JSON.parse(JSON.stringify(obj, (_key, val) =>
      (val === null || val === undefined) ? undefined : val
    ));
  } catch (e) {
    throw new Error(`Failed to serialize MCP response: ${e instanceof Error ? e.message : String(e)}`);
  }
  return encode(stripped);
}

/** Parse a TOON-encoded MCP response back into an object. For use in tests. */
export function parseMcpResponse(text: string): unknown {
  return decode(text);
}
