import { unwrapUntrustedOcr, wrapUntrustedOcr } from "./mcp-json.js";

// A single sandbox delimiter token (start or end) with its nonce. Never occurs
// in genuine business text, so it is safe to strip wholesale on the write side.
const SANDBOX_MARKER_RE = /<<UNTRUSTED_OCR_(?:START|END):[0-9a-f]*>>/g;

/**
 * Sandbox a single external-origin string for a READ response so a downstream
 * LLM treats it as data, not instructions. ALWAYS wraps with a fresh,
 * unpredictable nonce — it never trusts a wrapper already present in the value,
 * because the wrapper syntax is public and an attacker can forge a
 * matching-nonce pair inside imported text (e.g. a CAMT description). Wrapping
 * with a fresh outer nonce keeps any forged inner marker inside the authentic
 * sandbox (the forged close marker cannot match the fresh nonce), so it cannot
 * break out. null / undefined / "" pass through untouched.
 */
export function sandboxExternalText(text: string): string;
export function sandboxExternalText(text: string | null | undefined): string | null | undefined;
export function sandboxExternalText(text: string | null | undefined): string | null | undefined {
  if (text === undefined || text === null || text === "") return text;
  return wrapUntrustedOcr(text) ?? text;
}

/**
 * Inverse of sandboxExternalText for the WRITE side: strip every sandbox marker
 * so nothing that could re-open or close a sandbox is ever sent to the
 * accounting API, written to the audit log, or used as a match key. A wrapped
 * value read back via a CRUD read can round-trip through the LLM into a
 * create/update/search, so scoped fields are desandboxed at the mutation
 * boundary. Every whole-value wrapper layer is removed first, then any residual
 * (partial or forged) delimiter token — WITHOUT collapsing internal whitespace,
 * so legitimate multi-line content is preserved byte-for-byte apart from the
 * markers. null / undefined / "" pass through untouched.
 */
export function desandboxText(text: string): string;
export function desandboxText(text: string | null | undefined): string | null | undefined;
export function desandboxText(text: string | null | undefined): string | null | undefined {
  if (text === undefined || text === null || text === "") return text;
  let out = text;
  for (let stripped = unwrapUntrustedOcr(out); stripped !== out; stripped = unwrapUntrustedOcr(out)) {
    out = stripped;
  }
  return out.replace(SANDBOX_MARKER_RE, "");
}

interface TextPolicy {
  strings?: readonly string[];
  arrays?: Readonly<Record<string, TextPolicy>>;
}

/**
 * Import-origin free-text fields per read entity: the fields that CAN be
 * auto-created from imported documents (receipt/PDF OCR, CAMT bank statements,
 * broker CSV) and are therefore persisted without character-by-character
 * operator review. When such a record is READ BACK later via a CRUD read or a
 * dynamic resource, these fields re-enter the LLM's context and must be
 * sandboxed to close the stored (second-order) prompt-injection vector. The
 * same map drives the symmetric write-side strip so a round-tripped wrapped
 * value never persists a marker.
 *
 * Deliberately scoped: operator-configured reference data (chart of accounts,
 * currencies, articles, templates, bank config, VAT/invoice settings) is NOT
 * import-origin, so it stays raw per the documented trust-at-import decision.
 * Lightyear parse outputs and receipt/PDF extraction are already wrapped at
 * import time and are not re-listed here.
 */
export const EXTERNAL_TEXT_POLICY = {
  client: { strings: ["name"] },
  product: { strings: ["name"] },
  journal: { strings: ["title"] },
  transaction: { strings: ["description", "bank_account_name"] },
  purchase_invoice: { strings: ["client_name"], arrays: { items: { strings: ["custom_title"] } } },
  sale_invoice: { strings: ["client_name"], arrays: { items: { strings: ["custom_title"] } } },
} as const satisfies Record<string, TextPolicy>;

export type ExternalEntity = keyof typeof EXTERNAL_TEXT_POLICY;

type TextTransform = (text: string) => string;

function applyPolicy(value: unknown, policy: TextPolicy, transform: TextTransform): unknown {
  if (Array.isArray(value)) return value.map(item => applyPolicy(item, policy, transform));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = { ...source };
  for (const key of policy.strings ?? []) {
    if (typeof source[key] === "string") output[key] = transform(source[key] as string);
  }
  for (const [key, child] of Object.entries(policy.arrays ?? {})) {
    if (Array.isArray(source[key])) {
      output[key] = (source[key] as unknown[]).map(item => applyPolicy(item, child, transform));
    }
  }
  return output;
}

/**
 * Return a copy of `value` (a read-entity object, or an array of them) with
 * every import-origin free-text field sandbox-wrapped for a READ response. The
 * input is never mutated — only the returned response copy carries markers.
 */
export function renderExternalEntity<T>(entity: ExternalEntity, value: T): T {
  return applyPolicy(value, EXTERNAL_TEXT_POLICY[entity], sandboxExternalText as TextTransform) as T;
}

/**
 * Return a copy of `value` with every import-origin free-text field stripped of
 * sandbox markers for a WRITE (create/update) or match. The input is never
 * mutated. Use before sending scoped fields to the API, the audit log, or a
 * lookup, so a wrapped value read back and round-tripped never persists a
 * marker.
 */
export function desandboxExternalEntity<T>(entity: ExternalEntity, value: T): T {
  return applyPolicy(value, EXTERNAL_TEXT_POLICY[entity], desandboxText as TextTransform) as T;
}
