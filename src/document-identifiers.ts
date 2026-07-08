// ---------------------------------------------------------------------------
// Structural validators (Estonia-specific)
// ---------------------------------------------------------------------------
// Algorithms verified against python-stdnum (arthurdejong/python-stdnum):
//   - registrikood: same check digit as isikukood; weights (i%9)+1 = [1..7],
//     second pass [3..9] when mod11==10, first digit must be 1/7/8/9.
//   - kmkr (EE VAT): weights (3,7,1,3,7,1,3,7,1) over all 9 digits, sum mod 10 == 0.

/**
 * Validate an Estonian business registry code (registrikood, 8 digits).
 * Verifies length, digit-only, first-digit domain (1/7/8/9), and the
 * mod-11 check digit. Returns false for any non-EE input.
 */
export function isValidEeRegistryCode(value: string | null | undefined): boolean {
  if (!value) return false;
  const code = value.replace(/\s+/g, "");
  if (!/^\d{8}$/.test(code)) return false;
  if (!"1789".includes(code[0]!)) return false;
  const digits = code.split("").map(Number);
  const weights1 = [1, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += digits[i]! * weights1[i]!;
  let check = sum % 11;
  if (check === 10) {
    const weights2 = [3, 4, 5, 6, 7, 8, 9];
    sum = 0;
    for (let i = 0; i < 7; i++) sum += digits[i]! * weights2[i]!;
    check = sum % 11;
  }
  if (check === 10) check = 0;
  return check === digits[7];
}

/**
 * Validate an Estonian VAT number (käibemaksukohustuslase number, KMKR).
 * Accepts `EE` + 9 digits or bare 9 digits; normalizes to EE+9 form.
 * Verifies the mod-10 checksum (weights 3,7,1,3,7,1,3,7,1). EE-only by
 * design; foreign VATs return false.
 */
export function isValidEeVatNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  let n = value.replace(/\s+/g, "").toUpperCase();
  if (n.startsWith("EE")) n = n.slice(2);
  if (!/^\d{9}$/.test(n)) return false;
  const digits = n.split("").map(Number);
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += digits[i]! * weights[i]!;
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// IBAN validation (structural, ISO 7064 mod-97)
// ---------------------------------------------------------------------------

function isValidIban(value: string): boolean {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;

  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Buyer-section anchor used by both extractors to prefer supplier-side matches. */
const BUYER_SECTION_RE = /\b(bill to|invoice to|arve saaja|klient|client|ostja)\b/i;

function normalizeVatForCompare(value: string | readonly string[] | undefined): Set<string> {
  if (!value) return new Set();
  const list = typeof value === "string" ? [value] : value;
  const set = new Set<string>();
  for (const entry of list) {
    const normalized = entry?.replace(/\s+/g, "").toUpperCase();
    if (normalized) set.add(normalized);
  }
  return set;
}

/** Normalize a reg-code string for comparison (whitespace-stripped). */
function normalizeRegCode(value: string | readonly string[] | undefined): Set<string> {
  if (!value) return new Set();
  const list = typeof value === "string" ? [value] : value;
  const set = new Set<string>();
  for (const entry of list) {
    const normalized = entry?.trim();
    if (normalized) set.add(normalized);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Structured extraction result
// ---------------------------------------------------------------------------

export interface RejectedCandidate {
  kind: "reg_code" | "vat_no";
  value: string;
  reason: string;
}

export type RegCodeRationale = "labeled" | "bare_structural" | "excluded_self" | "buyer_section_only" | "coordinate_confirmed" | "coordinate_rejected";
export type VatNoRationale = "labeled" | "bare_structural" | "excluded_self" | "buyer_section_only" | "coordinate_confirmed" | "coordinate_rejected";

export interface ExtractedIdentifiers {
  reg_code?: string;
  vat_no?: string;
  iban?: string;
  ref_number?: string;
  /** All VAT-like tokens found on the page (supplier + buyer side), normalized. */
  all_vat_candidates: string[];
  /** All 8-digit registrikood candidates found on the page, normalized and deduplicated. */
  all_reg_code_candidates: string[];
  /** Why the chosen reg_code was picked / why others were rejected. */
  reg_code_rationale?: RegCodeRationale;
  vat_no_rationale?: VatNoRationale;
  /** Candidates rejected by validation (checksum/length) — for reviewer visibility. */
  rejected_candidates: RejectedCandidate[];
}

export interface ExtractIdentifiersOptions {
  excludeVat?: string | readonly string[];
  excludeRegCode?: string | readonly string[];
  /**
   * Text items with 2-D coordinates from the PDF parser. When provided,
   * identifier candidates are reclassified as supplier-side or buyer-side
   * based on their spatial proximity to buyer/supplier markers, overriding
   * the text-stream-position heuristic. This solves the two-column layout
   * problem where both supplier and buyer blocks appear after the buyer
   * anchor in the text stream but are in different x-columns.
   */
  textItems?: readonly LayoutTextItem[];
}

export interface LayoutTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Single-value extractors (kept for backwards compatibility)
// ---------------------------------------------------------------------------

export interface ExtractVatNumberOptions {
  /**
   * VAT number(s) that must NOT be returned. Used to keep the company's own
   * VAT from being resolved as a supplier when an invoice prints only the
   * buyer's VAT (e.g. foreign suppliers without an EE registration).
   * See issue #14.
   */
  exclude?: string | readonly string[];
  /** Layout text items for coordinate-based column classification. */
  textItems?: readonly LayoutTextItem[];
}

// Estonian reg-code label variants seen on real invoices:
//   "Reg. nr", "Reg. Nr", "Reg kood", "Registrikood", "Registry code",
//   "Rg-kood" (abbreviated, Printimiskeskus), "Rg-kood:" with colon
const REG_CODE_LABEL_RE = /(?:Reg\.?\s*(?:nr|kood|code)|Registrikood|Registry\s*code|Rg[-\s]?kood)\.?[:\s]*(\d{8})/gi;

// Estonian VAT label variants seen on real invoices:
//   "KMKR", "KMKR nr", "KMKR nr.", "KM nr", "KM-number", "KM Reg. Nr.",
//   "VAT nr", "VAT number", "VAT no.", "Tax ID"
// "KMKR" alone matches with no suffix; "KMKR nr" needs the optional \s*(nr|...)
// group. "KM Reg. Nr." is the Jysk variant — KM + Reg + Nr.
const VAT_LABEL_RE = /(?:KMKR(?:\s*(?:nr|number|no\.?))?|VAT(?:\s*(?:nr|number|no\.?))?|KM(?:\s*(?:Reg\.?\s*)?(?:nr|number|no\.?))?|KM-number|Tax\s*ID)\.?[:\s]*((?:EE[ \t]*\d(?:[ \t]*\d){8}(?![0-9A-Z]))|(?:[A-Z]{2}[0-9A-Z]{6,}))/gi;

function normalizeVatCandidate(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * Extract an Estonian registry code (registrikood, 8 digits) from text.
 *
 * Two tiers:
 *  1. Labeled match (`Reg. nr:`, `Registrikood`, `Registry code`, `Reg kood`).
 *     EE values that fail the checksum are rejected from tier 1 and recorded
 *     in `rejected_candidates` — they do not become canonical `reg_code`.
 *  2. Prefix-less structural recovery: bare 8-digit tokens validated by
 *     `isValidEeRegistryCode`, top-of-document preference, buyer-line
 *     rejection, and `excludeRegCode` filtering.
 */
export function extractRegistryCode(text: string, options?: ExtractIdentifiersOptions): string | undefined {
  return extractIdentifiers(text, options).reg_code;
}

/**
 * Extract a VAT number from text. Two tiers:
 *  1. Labeled match (`KMKR`, `VAT nr`, `KM nr`, `Tax ID`). Applies the
 *     buyer-section heuristic and `exclude` filter. EE values that fail the
 *     checksum are rejected from tier 1 and recorded in `rejected_candidates`.
 *  2. Prefix-less structural recovery for bare `EE` + 9 digits, validated
 *     by `isValidEeVatNumber`, with the same buyer-section heuristic and
 *     `exclude` filtering.
 */
export function extractVatNumber(text: string, options?: ExtractVatNumberOptions): string | undefined {
  const ids = extractIdentifiers(text, {
    excludeVat: options?.exclude,
    textItems: options?.textItems,
  });
  return ids.vat_no;
}

export function extractIban(text: string): string | undefined {
  const match = text.match(/\b([A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]){11,30})\b/i);
  const normalized = match?.[1]?.replace(/\s+/g, "").toUpperCase();
  if (!normalized) return undefined;
  return isValidIban(normalized) ? normalized : undefined;
}

export function extractReferenceNumber(text: string): string | undefined {
  return text.match(/(?:Viitenumber|Viitenr|Ref\.?\s*(?:nr|number)|Reference|viitenumbrit)[:\s]*(\d+)/i)?.[1];
}

// ---------------------------------------------------------------------------
// Coordinate-based layout classification (Option C hybrid)
// ---------------------------------------------------------------------------

const SUPPLIER_MARKER_RE = /\b(tarnija|m[üu][üu]ja|seller|müüja)\b/i;
// `saaja` alone is buyer-side (e.g. "arve saaja"), but `makse saaja` (payee)
// is supplier-side. Use a negative lookbehind to exclude `makse saaja`.
const BUYER_MARKER_RE = /(?<!makse\s)\b(saaja|maksja|arve\s*saaja|bill\s*to|invoice\s*to|ostja|klient|client|buyer|recipient|vastuv[õo]tja|receiver)\b/i;

const COLUMN_PROXIMITY_THRESHOLD = 50;

interface MarkerPosition {
  text: string;
  x: number;
  y: number;
  width: number;
  side: "supplier" | "buyer";
}

interface CandidatePosition {
  value: string;
  kind: "reg_code" | "vat_no";
  x: number;
  y: number;
}

/**
 * For a candidate at (x, y), walk markers above it from nearest to farthest.
 * The first marker in the same x-column classifies the candidate. Markers in
 * other columns are ignored; if none are in-column, the side is unknown.
 *
 * Returns "supplier" | "buyer" | "unknown".
 */
function classifyByPosition(candidate: CandidatePosition, markers: MarkerPosition[]): "supplier" | "buyer" | "unknown" {
  if (markers.length === 0) return "unknown";

  const markersAbove = markers
    .filter(marker => marker.y <= candidate.y + 5)
    .map(marker => ({ marker, yDistance: Math.max(0, candidate.y - marker.y) }))
    .sort((a, b) => a.yDistance - b.yDistance);

  for (const { marker } of markersAbove) {
    const markerRight = marker.x + Math.min(marker.width, COLUMN_PROXIMITY_THRESHOLD);
    const xDiff = Math.abs(candidate.x - marker.x);
    if (xDiff <= COLUMN_PROXIMITY_THRESHOLD) return marker.side;
    if (candidate.x >= marker.x && candidate.x <= markerRight + COLUMN_PROXIMITY_THRESHOLD) return marker.side;
  }

  return "unknown";
}

function findAllItemsForCandidate(textItems: readonly LayoutTextItem[], value: string): LayoutTextItem[] {
  const target = value.replace(/\s+/g, "").toUpperCase();
  if (!target) return [];
  const matches: LayoutTextItem[] = [];

  for (const item of textItems) {
    const itemNorm = item.text.replace(/\s+/g, "").toUpperCase();
    if (itemNorm.includes(target)) {
      matches.push(item);
    }
  }

  if (matches.length > 0) {
    return matches.sort((a, b) => a.y - b.y);
  }

  const lineGroups = new Map<number, LayoutTextItem[]>();
  for (const item of textItems) {
    const lineKey = Math.round(item.y);
    const group = lineGroups.get(lineKey);
    if (group) {
      group.push(item);
    } else {
      lineGroups.set(lineKey, [item]);
    }
  }

  for (const group of lineGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.x - b.x);

    let combinedNorm = "";
    const itemByCharIndex: LayoutTextItem[] = [];
    for (const item of group) {
      for (const char of item.text) {
        if (/\s/.test(char)) continue;
        combinedNorm += char.toUpperCase();
        itemByCharIndex.push(item);
      }
    }

    let searchFrom = 0;
    while (searchFrom <= combinedNorm.length - target.length) {
      const matchIndex = combinedNorm.indexOf(target, searchFrom);
      if (matchIndex === -1) break;
      const sourceItem = itemByCharIndex[matchIndex];
      if (sourceItem) {
        matches.push(sourceItem);
      }
      searchFrom = matchIndex + 1;
    }
  }

  return matches.sort((a, b) => a.y - b.y);
}

function normalizedTextWithIndex(text: string): Array<{ char: string; index: number }> {
  const chars: Array<{ char: string; index: number }> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!/\s/.test(char)) {
      chars.push({ char: char.toUpperCase(), index: i });
    }
  }
  return chars;
}

const normalizedTextCache = new Map<string, Array<{ char: string; index: number }>>();

function getNormalizedTextWithIndex(text: string): Array<{ char: string; index: number }> {
  let cached = normalizedTextCache.get(text);
  if (!cached) {
    cached = normalizedTextWithIndex(text);
    normalizedTextCache.set(text, cached);
  }
  return cached;
}

function candidateOccurrenceIndex(text: string, value: string, valueIndex: number): number | undefined {
  const target = value.replace(/\s+/g, "").toUpperCase();
  if (!target) return undefined;

  const normalized = getNormalizedTextWithIndex(text);
  let occurrenceIndex = 0;
  for (let i = 0; i <= normalized.length - target.length; i++) {
    let matches = true;
    for (let j = 0; j < target.length; j++) {
      if (normalized[i + j]?.char !== target[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const originalIndex = normalized[i]!.index;
    if (originalIndex >= valueIndex) return occurrenceIndex;
    occurrenceIndex++;
  }

  return undefined;
}

function matchValueIndex(text: string, match: RegExpMatchArray, value: string): number {
  const matchIndex = match.index ?? 0;
  const directIndex = text.indexOf(value, matchIndex);
  if (directIndex >= 0) return directIndex;
  const rawValue = match[1];
  return rawValue ? text.indexOf(rawValue, matchIndex) : matchIndex;
}

function classifyCandidateOccurrence(
  textItems: readonly LayoutTextItem[],
  value: string,
  kind: CandidatePosition["kind"],
  markers: MarkerPosition[],
  selectedOccurrenceIndex?: number,
): "supplier" | "buyer" | "unknown" {
  const items = findAllItemsForCandidate(textItems, value);
  const sides = items.map(item =>
    classifyByPosition({ value, kind, x: item.x, y: item.y }, markers),
  );
  const selectedSide = selectedOccurrenceIndex === undefined ? sides[0] : sides[selectedOccurrenceIndex];

  if (selectedSide === "supplier" || selectedSide === "buyer") return selectedSide;
  if (sides.includes("buyer")) return "buyer";
  if (sides.includes("supplier")) return "supplier";
  return "unknown";
}

function hasUnambiguousSupplierOccurrence(
  textItems: readonly LayoutTextItem[],
  value: string,
  kind: CandidatePosition["kind"],
  markers: MarkerPosition[],
): boolean {
  const sides = findAllItemsForCandidate(textItems, value).map(item =>
    classifyByPosition({ value, kind, x: item.x, y: item.y }, markers),
  );
  return sides.includes("supplier") && !sides.includes("buyer");
}

/**
 * Run all four identifier extractors and return a structured result with
 * all candidates, rationales, and rejected entries. This is the canonical
 * entry point for new callers; the single-value shims (`extractRegistryCode`,
 * `extractVatNumber`, `extractIban`, `extractReferenceNumber`) delegate here
 * and keep their existing signatures for backwards compatibility.
 */
export function extractIdentifiers(text: string, options?: ExtractIdentifiersOptions): ExtractedIdentifiers {
  normalizedTextCache.clear();
  const excludeVat = normalizeVatForCompare(options?.excludeVat);
  const excludeReg = normalizeRegCode(options?.excludeRegCode);
  const rejectedCandidates: RejectedCandidate[] = [];
  const allVatCandidates: string[] = [];
  const allVatCandidateSet = new Set<string>();
  const allRegCodeCandidates: string[] = [];
  const allRegCodeCandidateSet = new Set<string>();
  const buyerSectionIndex = text.search(BUYER_SECTION_RE);

  const pushAllRegCodeCandidate = (value: string) => {
    if (allRegCodeCandidateSet.has(value)) return;
    allRegCodeCandidateSet.add(value);
    allRegCodeCandidates.push(value);
  };

  const pushAllVatCandidate = (value: string) => {
    if (allVatCandidateSet.has(value)) return;
    allVatCandidateSet.add(value);
    allVatCandidates.push(value);
  };

  // --- IBAN + reference (unchanged single-pass) ---
  const iban = extractIban(text);
  const ref_number = extractReferenceNumber(text);

  // --- Reg code ---
  let reg_code: string | undefined;
  let reg_code_rationale: RegCodeRationale | undefined;
  let regCodeSelectedOccurrenceIndex: number | undefined;

  // Tier 1: labeled match.
  const labeledRegMatches = [...text.matchAll(REG_CODE_LABEL_RE)];
  const labeledRegFiltered = labeledRegMatches.filter(match => {
    const candidate = match[1];
    if (!candidate) return false;
    pushAllRegCodeCandidate(candidate);
    if (excludeReg.has(candidate)) return false;
    if (/^\d{8}$/.test(candidate) && !isValidEeRegistryCode(candidate)) {
      rejectedCandidates.push({ kind: "reg_code", value: candidate, reason: "checksum_failed" });
      return false;
    }
    return true;
  });

  // Buyer-section-only labeled matches are a last-resort fallback — stored
  // here and applied only if tier 2 (bare structural) and coordinate
  // classification both fail to find a supplier-side candidate. This prevents
  // a buyer-block label from blocking supplier-side recovery.
  let regCodeBuyerSectionFallback: string | undefined;

  if (labeledRegFiltered.length > 0) {
    if (buyerSectionIndex >= 0) {
      const supplierSide = labeledRegFiltered.find(m => (m.index ?? Number.MAX_SAFE_INTEGER) < buyerSectionIndex);
      if (supplierSide?.[1]) {
        reg_code = supplierSide[1];
        regCodeSelectedOccurrenceIndex = candidateOccurrenceIndex(text, reg_code, matchValueIndex(text, supplierSide, reg_code));
        reg_code_rationale = "labeled";
      } else {
        // All labeled matches are on the buyer side — save as fallback.
        regCodeBuyerSectionFallback = labeledRegFiltered[0]?.[1];
      }
    } else {
      reg_code = labeledRegFiltered[0]?.[1];
      if (reg_code) {
        regCodeSelectedOccurrenceIndex = candidateOccurrenceIndex(text, reg_code, matchValueIndex(text, labeledRegFiltered[0]!, reg_code));
      }
      reg_code_rationale = "labeled";
    }
  } else if (labeledRegMatches.length > 0 && excludeReg.size > 0) {
    reg_code_rationale = "excluded_self";
  }

  // Collect all 8-digit bare tokens (tier 2 candidate pool), regardless of
  // whether tier 1 returned — we want `all_reg_code_candidates` populated.
  const bareRegMatches = [...text.matchAll(/(?<!\d)(\d{8})(?!\d)/g)];
  const textLength = text.length || 1;
  const topThirdCutoff = textLength / 3;

  const bareValidCandidates: Array<{ value: string; index: number }> = [];
  const bareValidBuyerSideCandidates: Array<{ value: string; index: number }> = [];
  for (const match of bareRegMatches) {
    const value = match[1]!;
    const idx = match.index ?? 0;
    if (!isValidEeRegistryCode(value)) {
      // Only record as rejected if it looks like a reg-code candidate (8 digits
      // with a valid first-digit domain) — otherwise it is just a random
      // 8-digit number (date, amount, etc.) and we don't pollute rejected_candidates.
      if (value[0] && "1789".includes(value[0])) {
        rejectedCandidates.push({ kind: "reg_code", value, reason: "checksum_failed" });
      }
      continue;
    }
    pushAllRegCodeCandidate(value);
    if (excludeReg.has(value)) continue;
    // Two-column layouts (e.g. Printimiskeskus) put the supplier block to the
    // RIGHT of the buyer block, not above it. The buyer-section anchor marks
    // the start of the buyer block, but the supplier block runs in parallel.
    // When ALL valid candidates are at or after the anchor, we can't tell
    // supplier from buyer by position alone — keep them as a fallback and
    // let the topmost-preference logic pick the earliest one (supplier codes
    // typically appear first in OCR reading order in these layouts).
    if (buyerSectionIndex >= 0 && idx >= buyerSectionIndex) {
      bareValidBuyerSideCandidates.push({ value, index: idx });
      continue;
    }
    bareValidCandidates.push({ value, index: idx });
  }

  // Tier 2 fires only when tier 1 did not return a supplier-side value.
  if (!reg_code) {
    const useBuyerSide = bareValidCandidates.length === 0 && bareValidBuyerSideCandidates.length >= 2;
    const pool = useBuyerSide ? bareValidBuyerSideCandidates : bareValidCandidates;
    if (pool.length > 0) {
      const inTopThird = pool.filter(c => c.index < topThirdCutoff);
      const finalPool = inTopThird.length > 0 ? inTopThird : pool;
      finalPool.sort((a, b) => a.index - b.index);
      reg_code = finalPool[0]!.value;
      regCodeSelectedOccurrenceIndex = candidateOccurrenceIndex(text, reg_code, finalPool[0]!.index);
      reg_code_rationale = "bare_structural";
    }
  }

  // Apply buyer-section-only labeled fallback only if tier 2 also failed.
  if (!reg_code && regCodeBuyerSectionFallback) {
    reg_code = regCodeBuyerSectionFallback;
    const fallbackMatch = labeledRegFiltered.find(match => match[1] === regCodeBuyerSectionFallback);
    if (fallbackMatch) {
      regCodeSelectedOccurrenceIndex = candidateOccurrenceIndex(text, reg_code, matchValueIndex(text, fallbackMatch, reg_code));
    }
    reg_code_rationale = "buyer_section_only";
  }

  // --- VAT ---
  let vat_no: string | undefined;
  let vat_no_rationale: VatNoRationale | undefined;
  let vatNoSelectedOccurrenceIndex: number | undefined;

  // Tier 1: labeled matches.
  const labeledVatMatches = [...text.matchAll(VAT_LABEL_RE)];
  const labeledVatFiltered = labeledVatMatches.filter(match => {
    const candidate = match[1] ? normalizeVatCandidate(match[1]) : undefined;
    if (!candidate) return false;
    pushAllVatCandidate(candidate);
    if (excludeVat.has(candidate)) return false;
    if (candidate.startsWith("EE") && !isValidEeVatNumber(candidate)) {
      const reason = /^EE\d{9}$/.test(candidate) ? "checksum_failed" : "invalid_shape";
      rejectedCandidates.push({ kind: "vat_no", value: candidate, reason });
      return false;
    }
    return true;
  });

  // Buyer-section-only labeled VAT fallback — applied after tier 2.
  let vatNoBuyerSectionFallback: string | undefined;

  if (labeledVatFiltered.length > 0) {
    if (buyerSectionIndex >= 0) {
      const supplierSide = labeledVatFiltered.find(m => (m.index ?? Number.MAX_SAFE_INTEGER) < buyerSectionIndex);
      if (supplierSide?.[1]) {
        vat_no = normalizeVatCandidate(supplierSide[1]);
        vatNoSelectedOccurrenceIndex = candidateOccurrenceIndex(text, vat_no, matchValueIndex(text, supplierSide, supplierSide[1]));
        vat_no_rationale = "labeled";
      } else {
        vatNoBuyerSectionFallback = normalizeVatCandidate(labeledVatFiltered[0]![1]!);
      }
    } else {
      const first = labeledVatFiltered[0];
      if (first?.[1]) {
        vat_no = normalizeVatCandidate(first[1]);
        vatNoSelectedOccurrenceIndex = candidateOccurrenceIndex(text, vat_no, matchValueIndex(text, first, first[1]));
        vat_no_rationale = "labeled";
      }
    }
  }

  // Tier 2: bare EE + 9 digits, checksum-valid, not already captured by tier 1.
  const bareVatMatches = [...text.matchAll(/\b(EE[ \t]*\d(?:[ \t]*\d){8})\b/gi)];
  const bareVatCandidates: Array<{ value: string; index: number }> = [];
  const bareVatBuyerSideCandidates: Array<{ value: string; index: number }> = [];
  for (const match of bareVatMatches) {
    const full = match[1]!;
    const normalized = normalizeVatCandidate(full);
    if (!isValidEeVatNumber(normalized)) {
      rejectedCandidates.push({ kind: "vat_no", value: normalized, reason: "checksum_failed" });
      continue;
    }
    if (allVatCandidateSet.has(normalized)) continue; // already seen via tier 1
    pushAllVatCandidate(normalized);
    if (excludeVat.has(normalized)) continue;
    const idx = match.index ?? 0;
    // Two-column layout fallback: see reg-code tier 2 comment above.
    if (buyerSectionIndex >= 0 && idx >= buyerSectionIndex) {
      bareVatBuyerSideCandidates.push({ value: normalized, index: idx });
      continue;
    }
    bareVatCandidates.push({ value: normalized, index: idx });
  }

  if (!vat_no) {
    const useBuyerSide = bareVatCandidates.length === 0 && bareVatBuyerSideCandidates.length >= 2;
    const pool = useBuyerSide ? bareVatBuyerSideCandidates : bareVatCandidates;
    if (pool.length > 0) {
      if (buyerSectionIndex >= 0 && bareVatCandidates.length === 0) {
        vat_no = pool[0]!.value;
        vatNoSelectedOccurrenceIndex = candidateOccurrenceIndex(text, vat_no, pool[0]!.index);
        vat_no_rationale = "buyer_section_only";
      } else {
        const supplierSide = pool.find(c => c.index < buyerSectionIndex);
        vat_no = supplierSide ? supplierSide.value : pool[0]!.value;
        vatNoSelectedOccurrenceIndex = candidateOccurrenceIndex(text, vat_no, supplierSide ? supplierSide.index : pool[0]!.index);
        vat_no_rationale = "bare_structural";
      }
    }
  }

  if (!vat_no && vatNoBuyerSectionFallback) {
    vat_no = vatNoBuyerSectionFallback;
    const fallbackMatch = labeledVatFiltered.find(match => normalizeVatCandidate(match[1]!) === vatNoBuyerSectionFallback);
    if (fallbackMatch?.[1]) {
      vatNoSelectedOccurrenceIndex = candidateOccurrenceIndex(text, vat_no, matchValueIndex(text, fallbackMatch, fallbackMatch[1]));
    }
    vat_no_rationale = "buyer_section_only";
  }

  // If the only thing left after exclusion is the own VAT, flag it.
  if (!vat_no && excludeVat.size > 0) {
    // Did we reject every candidate because of exclusion?
    const anyLabeledOrBare = labeledVatMatches.length > 0 || bareVatMatches.length > 0;
    if (anyLabeledOrBare) {
      // At least one candidate existed but all were excluded — set the
      // rationale so callers can surface "self-VAT only".
      vat_no_rationale = "excluded_self";
    }
  }

  // --- Coordinate-based reclassification (Option C hybrid) ---
  // When textItems are available, reclassify the chosen reg_code and vat_no
  // using their 2-D position relative to buyer/supplier markers. This
  // overrides the text-stream heuristic when it misclassified a two-column
  // layout (supplier block beside the buyer block, not above it).
  if (options?.textItems && options.textItems.length > 0) {
    const textItems = options.textItems;
    const markers: MarkerPosition[] = [];
    for (const item of textItems) {
      if (BUYER_MARKER_RE.test(item.text)) {
        markers.push({ text: item.text, x: item.x, y: item.y, width: item.width, side: "buyer" });
      } else if (SUPPLIER_MARKER_RE.test(item.text)) {
        markers.push({ text: item.text, x: item.x, y: item.y, width: item.width, side: "supplier" });
      }
    }

    if (markers.length > 0) {
      if (reg_code) {
        const regCodeValue = reg_code;
        const side = classifyCandidateOccurrence(textItems, regCodeValue, "reg_code", markers, regCodeSelectedOccurrenceIndex);
        if (side === "buyer") {
          const supplierAlt = allRegCodeCandidates.find(candidate => {
            if (candidate === regCodeValue) return false;
            if (excludeReg.has(candidate)) return false;
            if (!isValidEeRegistryCode(candidate)) return false;
            return hasUnambiguousSupplierOccurrence(textItems, candidate, "reg_code", markers);
          });
          if (supplierAlt) {
            reg_code = supplierAlt;
            reg_code_rationale = "coordinate_confirmed";
          } else {
            reg_code = undefined;
            reg_code_rationale = "coordinate_rejected";
          }
        } else if (side === "supplier" && reg_code_rationale !== "labeled") {
          reg_code_rationale = "coordinate_confirmed";
        }
      } else if (allRegCodeCandidates.length > 0) {
        const supplierCandidate = allRegCodeCandidates.find(candidate => {
          if (excludeReg.has(candidate)) return false;
          if (!isValidEeRegistryCode(candidate)) return false;
          return hasUnambiguousSupplierOccurrence(textItems, candidate, "reg_code", markers);
        });
        if (supplierCandidate) {
          reg_code = supplierCandidate;
          reg_code_rationale = "coordinate_confirmed";
        }
      }

      if (vat_no) {
        const vatNoValue = vat_no;
        const side = classifyCandidateOccurrence(textItems, vatNoValue, "vat_no", markers, vatNoSelectedOccurrenceIndex);
        if (side === "buyer") {
          const supplierAlt = allVatCandidates.find(candidate => {
            if (candidate === vatNoValue) return false;
            if (excludeVat.has(candidate)) return false;
            if (!isValidEeVatNumber(candidate)) return false;
            return hasUnambiguousSupplierOccurrence(textItems, candidate, "vat_no", markers);
          });
          if (supplierAlt) {
            vat_no = supplierAlt;
            vat_no_rationale = "coordinate_confirmed";
          } else {
            vat_no = undefined;
            vat_no_rationale = "coordinate_rejected";
          }
        } else if (side === "supplier" && vat_no_rationale !== "labeled") {
          vat_no_rationale = "coordinate_confirmed";
        }
      } else if (allVatCandidates.length > 0) {
        const supplierCandidate = allVatCandidates.find(candidate => {
          if (excludeVat.has(candidate)) return false;
          if (!isValidEeVatNumber(candidate)) return false;
          return hasUnambiguousSupplierOccurrence(textItems, candidate, "vat_no", markers);
        });
        if (supplierCandidate) {
          vat_no = supplierCandidate;
          vat_no_rationale = "coordinate_confirmed";
        }
      }
    }
  }

  return {
    reg_code,
    vat_no,
    iban,
    ref_number,
    all_vat_candidates: allVatCandidates,
    all_reg_code_candidates: allRegCodeCandidates,
    ...(reg_code_rationale ? { reg_code_rationale } : {}),
    ...(vat_no_rationale ? { vat_no_rationale } : {}),
    rejected_candidates: rejectedCandidates,
  };
}
