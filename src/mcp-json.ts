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
  // 128-bit nonce: a fresh random per-call value that an attacker embedding
  // text in the untrusted content cannot predict. Each call gets its own
  // nonce so delimiters can never collide across fields in the same response.
  const nonce = randomBytes(16).toString("hex");
  return `${UNTRUSTED_OCR_START_PREFIX}${nonce}>>\n${text}\n${UNTRUSTED_OCR_END_PREFIX}${nonce}>>`;
}

/** Strip undefined fields recursively, then encode as TOON when it round-trips losslessly. */
export function toMcpJson(obj: unknown): string {
  let stripped: unknown;
  let json: string;
  try {
    json = JSON.stringify(obj, (_key, val) =>
      val === undefined ? undefined : val
    );
    stripped = JSON.parse(json);
  } catch (e) {
    throw new Error(`Failed to serialize MCP response: ${e instanceof Error ? e.message : String(e)}`);
  }

  const encoded = encode(stripped);
  try {
    decode(encoded);
    return encoded;
  } catch {
    // TOON is an optimization for LLM-facing responses, not the source of truth.
    // If the encoder produces text that its current decoder rejects (notably some
    // multiline strings containing bracket-like lines), fall back to JSON so MCP
    // responses remain parseable and untrusted OCR can still be sandboxed verbatim.
    return json;
  }
}

/** Parse a TOON- or JSON-encoded MCP response back into an object. For use in tests and wrappers. */
export function parseMcpResponse(text: string): unknown {
  try {
    return decode(text);
  } catch {
    return JSON.parse(text);
  }
}
