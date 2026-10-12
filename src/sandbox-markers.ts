// PURE leaf module (no imports): the single definition of a literal OCR /
// untrusted-text sandbox delimiter token and the canonical routine that removes
// such tokens. Shared by the write-side desandbox helpers (mcp-json,
// external-text-renderer) and by the source-file importers (CAMT, Wise,
// Lightyear, receipt OCR), which must stay free of mcp-json imports.

// A single sandbox delimiter token (start or end) with its nonce. Never occurs
// in genuine business text, so it is safe to strip wholesale.
const SANDBOX_MARKER_RE = /<<UNTRUSTED_OCR_(?:START|END):[0-9a-f]*>>/g;

/**
 * Remove every literal sandbox delimiter token from `text`, looping to a
 * FIXPOINT: a single pass over a nested token such as
 * `<<UNTRUSTED_OCR_<<UNTRUSTED_OCR_START:ab>>START:cd>>` would splice the
 * outer halves back into a well-formed marker. Internal whitespace is left
 * untouched, and text without a marker is returned unchanged (same string), so
 * identity keys derived from ordinary source text stay byte-identical.
 */
export function stripSandboxMarkers(text: string): string {
  let out = text;
  for (let stripped = out.replace(SANDBOX_MARKER_RE, ""); stripped !== out; stripped = out.replace(SANDBOX_MARKER_RE, "")) {
    out = stripped;
  }
  return out;
}
