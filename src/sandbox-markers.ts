// PURE leaf module (no imports): the single definition of a literal OCR /
// untrusted-text sandbox delimiter token and the canonical routine that removes
// such tokens. Shared by the write-side desandbox helpers (mcp-json,
// external-text-renderer) and by the source-file importers (CAMT, Wise,
// Lightyear, receipt OCR), which must stay free of mcp-json imports.

// A single sandbox delimiter token (start or end) with its nonce. Never occurs
// in genuine business text, so it is safe to strip wholesale.
const SANDBOX_MARKER_RE = /<<UNTRUSTED_OCR_(?:START|END):[0-9a-f]*>>/g;

// Fixpoint passes allowed before a nested token is neutralised instead. Each
// pass is linear, so the bound keeps adversarial nesting (thousands of levels
// in one CSV cell) from costing quadratic time.
const MAX_STRIP_PASSES = 4;

/**
 * Remove every literal sandbox delimiter token from `text`, looping to a
 * FIXPOINT: a single pass over a nested token such as
 * `<<UNTRUSTED_OCR_<<UNTRUSTED_OCR_START:ab>>START:cd>>` would splice the
 * outer halves back into a well-formed marker. Internal whitespace is left
 * untouched, and text without a marker is returned unchanged (same string), so
 * identity keys derived from ordinary source text stay byte-identical.
 *
 * Nesting deeper than MAX_STRIP_PASSES is adversarial: the remaining
 * `UNTRUSTED_OCR_` names are rewritten to `UNTRUSTED-OCR_` in one pass, which
 * cannot splice a new token (no rewritten character can be part of one), so
 * no delimiter survives and the work stays linear.
 */
export function stripSandboxMarkers(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass += 1) {
    const stripped = out.replace(SANDBOX_MARKER_RE, "");
    if (stripped === out) return out;
    out = stripped;
  }
  SANDBOX_MARKER_RE.lastIndex = 0;
  return SANDBOX_MARKER_RE.test(out) ? out.replace(/UNTRUSTED_OCR_/g, "UNTRUSTED-OCR_") : out;
}
