import { encode, decode } from "@toon-format/toon";
import { randomBytes } from "crypto";

// Wrap untrusted OCR / external text with per-call nonce delimiters so a
// downstream LLM treats the content as data, not instructions. A fixed
// delimiter could be spoofed by text that includes the closing marker; the
// nonce makes the sandbox boundary unguessable per call.
export const UNTRUSTED_OCR_START_PREFIX = "<<UNTRUSTED_OCR_START:";
export const UNTRUSTED_OCR_END_PREFIX = "<<UNTRUSTED_OCR_END:";

export function wrapUntrustedOcr(text: string | undefined | null): string | undefined {
  if (text === undefined || text === null) return undefined;
  if (text === "") return text;
  const nonce = randomBytes(8).toString("hex");
  return `${UNTRUSTED_OCR_START_PREFIX}${nonce}>>\n${text}\n${UNTRUSTED_OCR_END_PREFIX}${nonce}>>`;
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
