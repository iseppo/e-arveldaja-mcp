const LEGAL_SUFFIXES = /\b(ou|o(?:\u0308|ü)u|as|mtu|mt(?:\u0308|ü)u|fie|uab|sia|llc|ltd|inc|gmbh|oy|ab|tmi|pank|sa|tu)\b/gu;

export interface NormalizeCompanyNameOptions {
  /** Strip all non-alphanumeric characters (for grouping/deduplication). Default: false. */
  stripNonAlphanumeric?: boolean;
}

/**
 * Normalize a company name for matching/comparison.
 * Strips diacritics (via NFKD), legal suffixes (Estonian + international),
 * and collapses whitespace. Optionally strips all non-alphanumeric characters.
 */
export function normalizeCompanyName(name?: string | null, options?: NormalizeCompanyNameOptions): string {
  let result = (name ?? "").trim().toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  if (options?.stripNonAlphanumeric) {
    result = result.replace(/[^\p{L}\p{N}\s]/gu, " ");
  }

  return result
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}
