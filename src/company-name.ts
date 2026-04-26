// Legal-form suffixes stripped during matching/comparison. Ordered loosely
// from local Estonian forms outward to common US/UK/EU forms. The set is
// inclusive on purpose — false positives only matter if a real company
// name *equals* one of these tokens, which is vanishingly rare in
// invoice data. Keeping the list complete prevents downstream matchers
// (#14 supplier resolution, bank reconciliation, CAMT import) from
// missing a known supplier when the document spells out the corporate
// form (e.g. "Anthropic, PBC" → matches the existing "Anthropic" client).
// "company" is intentionally NOT in this list: a real supplier may legally be
// named "Foo Company OÜ" and stripping "company" would lose information.
// Single-letter / 2-letter codes ("co") rely on \b boundaries so they only
// match when standalone, never when embedded in a longer word.
const LEGAL_SUFFIXES = /\b(ou|o(?:̈|ü)u|as|mtu|mt(?:̈|ü)u|fie|tu|tmi|pank|uab|sia|llc|ltd|inc|corp|corporation|co|lp|llp|plc|pbc|pllc|gmbh|oy|ab|ag|sa|sas|sarl|srl|spa|nv|bv)\b/gu;

export interface NormalizeCompanyNameOptions {
  /** Strip punctuation before suffix removal as well (for grouping/deduplication). */
  stripNonAlphanumeric?: boolean;
}

/**
 * Normalize a company name for matching/comparison.
 * Strips diacritics (via NFKD), legal suffixes (Estonian + international),
 * and collapses whitespace. Punctuation is stripped for matching; callers can
 * request the stripping to happen before suffix removal as well.
 *
 * Dotted abbreviations between single letters are collapsed first so that
 * `N.V.`, `B.V.`, `S.A.`, `S.r.l.` etc. reduce to their bare-letter forms
 * (`nv`, `bv`, `sa`, `srl`) before suffix matching runs. Without this,
 * the dot acts as a word boundary and `\b(nv)\b` fails to match `n.v.`.
 */
export function normalizeCompanyName(name?: string | null, options?: NormalizeCompanyNameOptions): string {
  let result = (name ?? "").trim().toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

  // Collapse dotted single-letter abbreviations: "n.v." → "nv", "s.a.s." → "sas".
  // Runs iteratively because each pass collapses one boundary; up to 3 passes
  // covers the longest abbreviations we care about (S.A.S., S.r.l.).
  for (let i = 0; i < 3; i++) {
    const before = result;
    result = result.replace(/(\b[a-z])\.\s*(?=[a-z]\b)/g, "$1");
    if (result === before) break;
  }

  if (options?.stripNonAlphanumeric) {
    result = result.replace(/[^\p{L}\p{N}\s]/gu, " ");
  }

  return result
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
