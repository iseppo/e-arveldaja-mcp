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

// Matches a single well-formed sandbox wrapper produced by wrapUntrustedOcr:
// the start/end nonces must be identical (\1 back-reference).
const UNTRUSTED_OCR_WRAPPER_RE =
  /^<<UNTRUSTED_OCR_START:([0-9a-f]+)>>\n([\s\S]*)\n<<UNTRUSTED_OCR_END:\1>>$/;

/**
 * Reverse wrapUntrustedOcr: if `text` is exactly one well-formed sandbox
 * wrapper, return the inner content; otherwise return `text` unchanged.
 *
 * Needed at mutation boundaries: a wrapped value (e.g. a CAMT
 * `suggested_patch_missing_fields` entry) round-trips through the LLM as a
 * review item and is later written back to the ledger. The sandbox delimiters
 * are a display-only guard and must be stripped before the value is persisted,
 * otherwise the literal `<<UNTRUSTED_OCR_START:…>>` markers land in the field.
 */
export function unwrapUntrustedOcr(text: string): string {
  const m = UNTRUSTED_OCR_WRAPPER_RE.exec(text);
  return m ? m[2]! : text;
}

/**
 * Default character budget for OCR-derived free text inlined into an MCP
 * response. Booking decisions use the structured `extracted` fields, not the
 * raw blob — so a generous cap that still bounds a pathological or maliciously
 * oversized document (which could otherwise flood the consuming LLM's context)
 * is the right trade-off. ~20k chars covers a multi-page invoice.
 */
export const MAX_UNTRUSTED_TEXT_CHARS = 20_000;

/**
 * Cap OCR-derived free text to a fixed character budget before it is wrapped
 * and emitted. Returns the (possibly truncated) text plus whether truncation
 * happened and the original length; callers wrap `.text` with wrapUntrustedOcr
 * and surface `.truncated` / `.original_length` as sibling fields so a consumer
 * knows the blob was cut and can open the document directly for the remainder.
 */
export function capUntrustedText(
  text: string | undefined | null,
  maxChars: number = MAX_UNTRUSTED_TEXT_CHARS,
): { text: string | undefined; truncated: boolean; original_length: number } {
  if (text === undefined || text === null) {
    return { text: undefined, truncated: false, original_length: 0 };
  }
  if (text.length <= maxChars) {
    return { text, truncated: false, original_length: text.length };
  }
  return { text: text.slice(0, maxChars), truncated: true, original_length: text.length };
}

export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      jsonDeepEqual(leftRecord[key], rightRecord[key]));
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
    const decoded = decode(encoded);
    return jsonDeepEqual(decoded, stripped) ? encoded : json;
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
  // toMcpJson emits TOON, or falls back to a raw JSON string when TOON would
  // round-trip lossily (see the catch in toMcpJson). Critically, TOON's decode()
  // does NOT throw on JSON input — it silently returns a garbled object — so we
  // cannot simply "try decode, then JSON". TOON never emits a leading '{', '['
  // or '"' for its object/array/string encodings, so a JSON-shaped prefix
  // unambiguously marks the JSON fallback path; try JSON there first.
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
    try {
      return JSON.parse(text);
    } catch {
      // Not valid JSON after all (e.g. a TOON tabular array `[3]{...}`); fall
      // through to the TOON decoder below.
    }
  }
  try {
    return decode(text);
  } catch {
    return JSON.parse(text);
  }
}
