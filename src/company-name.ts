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

/**
 * Drop tokens that START with "@" — a social handle printed next to the name
 * on an invoice ("Anthropic, PBC @anthropic"). Emails ("info@foo.ee") are
 * untouched: their "@" does not start a token. Deliberately NOT part of
 * {@link normalizeCompanyName}: that key also names persisted auto-booking
 * rule files and feeds {@link sameCompanyIdentity}, where a handle such as
 * "@tamm.ou" must not change the result. Use only on OCR supplier names
 * before supplier matching.
 */
export function stripSocialHandles(name: string): string {
  return name.replace(/(^|\s)@\S*/gu, "$1").replace(/\s+/g, " ").trim();
}

// Spelled-out Estonian legal forms, folded to their abbreviation so
// "Osaühing Foo" and "Foo OÜ" compare equal. Applied after diacritic stripping.
const SPELLED_OUT_LEGAL_FORMS: Array<[RegExp, string]> = [
  [/\bosauhing\b/g, "ou"],
  [/\baktsiaselts\b/g, "as"],
  [/\bmittetulundusuhing\b/g, "mtu"],
  [/\btaisuhing\b/g, "tu"],
  [/\bfuusilisest isikust ettevotja\b/g, "fie"],
];

function legalIdentityKey(name?: string | null): { base: string; form: string } {
  let folded = (name ?? "").trim().toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  for (let i = 0; i < 3; i++) {
    const before = folded;
    folded = folded.replace(/(\b[a-z])\.\s*(?=[a-z]\b)/g, "$1");
    if (folded === before) break;
  }
  for (const [pattern, abbreviation] of SPELLED_OUT_LEGAL_FORMS) folded = folded.replace(pattern, abbreviation);
  const forms = [...new Set(folded.match(LEGAL_SUFFIXES) ?? [])].sort();
  return { base: normalizeCompanyName(folded), form: forms.join(" ") };
}

/**
 * Strict "same legal person" name comparison for decisions that move money
 * (transfer-mirror deletion, one-sided own-transfer inference). Unlike
 * {@link normalizeCompanyName} equality, the legal form must also agree
 * ("Foo AS" is not "Foo OÜ"), and a name carrying no legal form at all — a
 * natural person such as "JAAN TAMM" vs the company "Jaan Tamm OÜ" — never
 * matches.
 */
export function sameCompanyIdentity(a?: string | null, b?: string | null): boolean {
  const left = legalIdentityKey(a);
  const right = legalIdentityKey(b);
  return left.base !== "" && left.form !== "" && left.base === right.base && left.form === right.form;
}
