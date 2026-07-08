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

export function normalizeVatValue(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, "").toUpperCase();
  return normalized || undefined;
}

function normalizeVatForCompare(value: string | readonly string[] | undefined): Set<string> {
  if (!value) return new Set();
  const list = typeof value === "string" ? [value] : value;
  const set = new Set<string>();
  for (const entry of list) {
    const normalized = normalizeVatValue(entry);
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
  pageNum?: number;
  confidence?: number;
  fontSize?: number;
  fontName?: string;
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

export const SUPPLIER_MARKER_RE = /\b(tarnija|m[üu][üu]ja|seller|müüja)\b/i;
// `saaja` alone is buyer-side (e.g. "arve saaja"), but `makse saaja` (payee)
// is supplier-side. Use a negative lookbehind to exclude `makse saaja`.
export const BUYER_MARKER_RE = /(?<!makse\s)\b(saaja|maksja|arve\s*saaja|bill\s*to|invoice\s*to|ostja|klient|client|buyer|recipient|vastuv[õo]tja|receiver)\b/i;

const COLUMN_PROXIMITY_THRESHOLD = 50;

export interface MarkerPosition {
  text: string;
  x: number;
  y: number;
  width: number;
  pageNum?: number;
  side: "supplier" | "buyer";
}

interface CandidatePosition {
  value: string;
  kind: "reg_code" | "vat_no";
  x: number;
  y: number;
  pageNum?: number;
}

/**
 * For a candidate at (x, y), walk markers above it from nearest to farthest.
 * The first marker in the same x-column classifies the candidate. Markers in
 * other columns are ignored; if none are in-column, the side is unknown.
 *
 * Returns "supplier" | "buyer" | "unknown".
 */
export function classifyByPosition(
  candidate: Pick<CandidatePosition, "x" | "y" | "pageNum">,
  markers: readonly MarkerPosition[],
): "supplier" | "buyer" | "unknown" {
  if (markers.length === 0) return "unknown";
  const candidatePageNum = candidate.pageNum ?? 1;

  const markersAbove = markers
    .filter(marker => (marker.pageNum ?? 1) === candidatePageNum && marker.y <= candidate.y + 5)
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

function getNormalizedTextWithIndex(text: string, cache: Map<string, Array<{ char: string; index: number }>>): Array<{ char: string; index: number }> {
  let cached = cache.get(text);
  if (!cached) {
    cached = normalizedTextWithIndex(text);
    cache.set(text, cached);
  }
  return cached;
}

function candidateOccurrenceIndex(text: string, value: string, valueIndex: number, cache: Map<string, Array<{ char: string; index: number }>>): number | undefined {
  const target = value.replace(/\s+/g, "").toUpperCase();
  if (!target) return undefined;

  const normalized = getNormalizedTextWithIndex(text, cache);
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
    classifyByPosition({ x: item.x, y: item.y, pageNum: item.pageNum }, markers),
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
    classifyByPosition({ x: item.x, y: item.y, pageNum: item.pageNum }, markers),
  );
  return sides.includes("supplier") && !sides.includes("buyer");
}

type NormalizedTextCache = Map<string, Array<{ char: string; index: number }>>;

interface IdentifierResolutionCache {
  normalizedTextCache: NormalizedTextCache;
}

interface IdentifierResolutionResult<Rationale extends RegCodeRationale | VatNoRationale> {
  value?: string;
  rationale?: Rationale;
  occurrenceIndex?: number;
  candidates: string[];
  rejected: RejectedCandidate[];
}

function resolveRegCode(
  text: string,
  options: ExtractIdentifiersOptions | undefined,
  cache: IdentifierResolutionCache,
): IdentifierResolutionResult<RegCodeRationale> {
  const excludeReg = normalizeRegCode(options?.excludeRegCode);
  const rejected: RejectedCandidate[] = [];
  const candidates: string[] = [];
  const candidateSet = new Set<string>();
  const buyerSectionIndex = text.search(BUYER_SECTION_RE);

  const pushCandidate = (value: string) => {
    if (candidateSet.has(value)) return;
    candidateSet.add(value);
    candidates.push(value);
  };

  let value: string | undefined;
  let rationale: RegCodeRationale | undefined;
  let occurrenceIndex: number | undefined;

  // Tier 1: labeled match.
  const labeledRegMatches = [...text.matchAll(REG_CODE_LABEL_RE)];
  const labeledRegFiltered = labeledRegMatches.filter(match => {
    const candidate = match[1];
    if (!candidate) return false;
    pushCandidate(candidate);
    if (excludeReg.has(candidate)) return false;
    if (/^\d{8}$/.test(candidate) && !isValidEeRegistryCode(candidate)) {
      rejected.push({ kind: "reg_code", value: candidate, reason: "checksum_failed" });
      return false;
    }
    return true;
  });

  let buyerSectionFallback: string | undefined;

  if (labeledRegFiltered.length > 0) {
    if (buyerSectionIndex >= 0) {
      const supplierSide = labeledRegFiltered.find(m => (m.index ?? Number.MAX_SAFE_INTEGER) < buyerSectionIndex);
      if (supplierSide?.[1]) {
        value = supplierSide[1];
        occurrenceIndex = candidateOccurrenceIndex(text, value, matchValueIndex(text, supplierSide, value), cache.normalizedTextCache);
        rationale = "labeled";
      } else {
        buyerSectionFallback = labeledRegFiltered[0]?.[1];
      }
    } else {
      value = labeledRegFiltered[0]?.[1];
      if (value) {
        occurrenceIndex = candidateOccurrenceIndex(text, value, matchValueIndex(text, labeledRegFiltered[0]!, value), cache.normalizedTextCache);
      }
      rationale = "labeled";
    }
  } else if (labeledRegMatches.length > 0 && excludeReg.size > 0) {
    rationale = "excluded_self";
  }

  const bareRegMatches = [...text.matchAll(/(?<!\d)(\d{8})(?!\d)/g)];
  const textLength = text.length || 1;
  const topThirdCutoff = textLength / 3;

  const bareValidCandidates: Array<{ value: string; index: number }> = [];
  const bareValidBuyerSideCandidates: Array<{ value: string; index: number }> = [];
  for (const match of bareRegMatches) {
    const candidate = match[1]!;
    const idx = match.index ?? 0;
    if (!isValidEeRegistryCode(candidate)) {
      if (candidate[0] && "1789".includes(candidate[0])) {
        rejected.push({ kind: "reg_code", value: candidate, reason: "checksum_failed" });
      }
      continue;
    }
    pushCandidate(candidate);
    if (excludeReg.has(candidate)) continue;
    if (buyerSectionIndex >= 0 && idx >= buyerSectionIndex) {
      bareValidBuyerSideCandidates.push({ value: candidate, index: idx });
      continue;
    }
    bareValidCandidates.push({ value: candidate, index: idx });
  }

  if (!value) {
    const useBuyerSide = bareValidCandidates.length === 0 && bareValidBuyerSideCandidates.length >= 2;
    const pool = useBuyerSide ? bareValidBuyerSideCandidates : bareValidCandidates;
    if (pool.length > 0) {
      const inTopThird = pool.filter(c => c.index < topThirdCutoff);
      const finalPool = inTopThird.length > 0 ? inTopThird : pool;
      finalPool.sort((a, b) => a.index - b.index);
      value = finalPool[0]!.value;
      occurrenceIndex = candidateOccurrenceIndex(text, value, finalPool[0]!.index, cache.normalizedTextCache);
      rationale = "bare_structural";
    }
  }

  if (!value && buyerSectionFallback) {
    value = buyerSectionFallback;
    const fallbackMatch = labeledRegFiltered.find(match => match[1] === buyerSectionFallback);
    if (fallbackMatch) {
      occurrenceIndex = candidateOccurrenceIndex(text, value, matchValueIndex(text, fallbackMatch, value), cache.normalizedTextCache);
    }
    rationale = "buyer_section_only";
  }

  return { value, rationale, occurrenceIndex, candidates, rejected };
}

function resolveVatNo(
  text: string,
  options: ExtractIdentifiersOptions | undefined,
  cache: IdentifierResolutionCache,
): IdentifierResolutionResult<VatNoRationale> {
  const excludeVat = normalizeVatForCompare(options?.excludeVat);
  const rejected: RejectedCandidate[] = [];
  const candidates: string[] = [];
  const candidateSet = new Set<string>();
  const buyerSectionIndex = text.search(BUYER_SECTION_RE);

  const pushCandidate = (value: string) => {
    if (candidateSet.has(value)) return;
    candidateSet.add(value);
    candidates.push(value);
  };

  let value: string | undefined;
  let rationale: VatNoRationale | undefined;
  let occurrenceIndex: number | undefined;

  // Tier 1: labeled matches.
  const labeledVatMatches = [...text.matchAll(VAT_LABEL_RE)];
  const labeledVatFiltered = labeledVatMatches.filter(match => {
    const candidate = match[1] ? normalizeVatCandidate(match[1]) : undefined;
    if (!candidate) return false;
    pushCandidate(candidate);
    if (excludeVat.has(candidate)) return false;
    if (candidate.startsWith("EE") && !isValidEeVatNumber(candidate)) {
      const reason = /^EE\d{9}$/.test(candidate) ? "checksum_failed" : "invalid_shape";
      rejected.push({ kind: "vat_no", value: candidate, reason });
      return false;
    }
    return true;
  });

  let buyerSectionFallback: string | undefined;

  if (labeledVatFiltered.length > 0) {
    if (buyerSectionIndex >= 0) {
      const supplierSide = labeledVatFiltered.find(m => (m.index ?? Number.MAX_SAFE_INTEGER) < buyerSectionIndex);
      if (supplierSide?.[1]) {
        value = normalizeVatCandidate(supplierSide[1]);
        occurrenceIndex = candidateOccurrenceIndex(text, value, matchValueIndex(text, supplierSide, supplierSide[1]), cache.normalizedTextCache);
        rationale = "labeled";
      } else {
        buyerSectionFallback = normalizeVatCandidate(labeledVatFiltered[0]![1]!);
      }
    } else {
      const first = labeledVatFiltered[0];
      if (first?.[1]) {
        value = normalizeVatCandidate(first[1]);
        occurrenceIndex = candidateOccurrenceIndex(text, value, matchValueIndex(text, first, first[1]), cache.normalizedTextCache);
        rationale = "labeled";
      }
    }
  }

  const bareVatMatches = [...text.matchAll(/\b(EE[ \t]*\d(?:[ \t]*\d){8})\b/gi)];
  const bareVatCandidates: Array<{ value: string; index: number }> = [];
  const bareVatBuyerSideCandidates: Array<{ value: string; index: number }> = [];
  for (const match of bareVatMatches) {
    const full = match[1]!;
    const normalized = normalizeVatCandidate(full);
    if (!isValidEeVatNumber(normalized)) {
      rejected.push({ kind: "vat_no", value: normalized, reason: "checksum_failed" });
      continue;
    }
    if (candidateSet.has(normalized)) continue;
    pushCandidate(normalized);
    if (excludeVat.has(normalized)) continue;
    const idx = match.index ?? 0;
    if (buyerSectionIndex >= 0 && idx >= buyerSectionIndex) {
      bareVatBuyerSideCandidates.push({ value: normalized, index: idx });
      continue;
    }
    bareVatCandidates.push({ value: normalized, index: idx });
  }

  if (!value) {
    const useBuyerSide = bareVatCandidates.length === 0 && bareVatBuyerSideCandidates.length >= 2;
    const pool = useBuyerSide ? bareVatBuyerSideCandidates : bareVatCandidates;
    if (pool.length > 0) {
      if (buyerSectionIndex >= 0 && bareVatCandidates.length === 0) {
        value = pool[0]!.value;
        occurrenceIndex = candidateOccurrenceIndex(text, value, pool[0]!.index, cache.normalizedTextCache);
        rationale = "buyer_section_only";
      } else {
        const supplierSide = pool.find(c => c.index < buyerSectionIndex);
        value = supplierSide ? supplierSide.value : pool[0]!.value;
        occurrenceIndex = candidateOccurrenceIndex(text, value, supplierSide ? supplierSide.index : pool[0]!.index, cache.normalizedTextCache);
        rationale = "bare_structural";
      }
    }
  }

  if (!value && buyerSectionFallback) {
    value = buyerSectionFallback;
    const fallbackMatch = labeledVatFiltered.find(match => normalizeVatCandidate(match[1]!) === buyerSectionFallback);
    if (fallbackMatch?.[1]) {
      occurrenceIndex = candidateOccurrenceIndex(text, value, matchValueIndex(text, fallbackMatch, fallbackMatch[1]), cache.normalizedTextCache);
    }
    rationale = "buyer_section_only";
  }

  if (!value && excludeVat.size > 0) {
    const anyLabeledOrBare = labeledVatMatches.length > 0 || bareVatMatches.length > 0;
    if (anyLabeledOrBare) {
      rationale = "excluded_self";
    }
  }

  return { value, rationale, occurrenceIndex, candidates, rejected };
}

export function buildIdentifierMarkers(textItems: readonly LayoutTextItem[]): MarkerPosition[] {
  const markers: MarkerPosition[] = [];
  for (const item of textItems) {
    if (BUYER_MARKER_RE.test(item.text)) {
      markers.push({ text: item.text, x: item.x, y: item.y, width: item.width, pageNum: item.pageNum, side: "buyer" });
    } else if (SUPPLIER_MARKER_RE.test(item.text)) {
      markers.push({ text: item.text, x: item.x, y: item.y, width: item.width, pageNum: item.pageNum, side: "supplier" });
    }
  }
  return markers;
}

function reclassifyByCoordinates<Rationale extends RegCodeRationale | VatNoRationale>(
  kind: CandidatePosition["kind"],
  value: string | undefined,
  rationale: Rationale | undefined,
  occurrenceIndex: number | undefined,
  candidates: string[],
  textItems: readonly LayoutTextItem[],
  markers: MarkerPosition[],
  exclude: Set<string>,
): { value?: string; rationale?: Rationale } {
  const isValid = kind === "reg_code" ? isValidEeRegistryCode : isValidEeVatNumber;
  const confirmed = "coordinate_confirmed" as Rationale;
  const rejected = "coordinate_rejected" as Rationale;

  if (value) {
    const side = classifyCandidateOccurrence(textItems, value, kind, markers, occurrenceIndex);
    if (side === "buyer") {
      const supplierAlt = candidates.find(candidate => {
        if (candidate === value) return false;
        if (exclude.has(candidate)) return false;
        if (!isValid(candidate)) return false;
        return hasUnambiguousSupplierOccurrence(textItems, candidate, kind, markers);
      });
      if (supplierAlt) {
        return { value: supplierAlt, rationale: confirmed };
      }
      return { rationale: rejected };
    }
    if (side === "supplier" && rationale !== "labeled") {
      return { value, rationale: confirmed };
    }
    return { value, rationale };
  }

  if (candidates.length > 0) {
    const supplierCandidate = candidates.find(candidate => {
      if (exclude.has(candidate)) return false;
      if (!isValid(candidate)) return false;
      return hasUnambiguousSupplierOccurrence(textItems, candidate, kind, markers);
    });
    if (supplierCandidate) {
      return { value: supplierCandidate, rationale: confirmed };
    }
  }

  return { value, rationale };
}

/**
 * Run all four identifier extractors and return a structured result with
 * all candidates, rationales, and rejected entries. This is the canonical
 * entry point for new callers; the single-value shims (`extractRegistryCode`,
 * `extractVatNumber`, `extractIban`, `extractReferenceNumber`) delegate here
 * and keep their existing signatures for backwards compatibility.
 */
export function extractIdentifiers(text: string, options?: ExtractIdentifiersOptions): ExtractedIdentifiers {
  const cache: IdentifierResolutionCache = { normalizedTextCache: new Map() };
  const excludeVat = normalizeVatForCompare(options?.excludeVat);
  const excludeReg = normalizeRegCode(options?.excludeRegCode);
  const iban = extractIban(text);
  const ref_number = extractReferenceNumber(text);
  const regCode = resolveRegCode(text, options, cache);
  const vatNo = resolveVatNo(text, options, cache);
  const rejectedCandidates = [...regCode.rejected, ...vatNo.rejected];

  let reg_code = regCode.value;
  let reg_code_rationale = regCode.rationale;
  let vat_no = vatNo.value;
  let vat_no_rationale = vatNo.rationale;

  if (options?.textItems && options.textItems.length > 0) {
    const textItems = options.textItems;
    const markers = buildIdentifierMarkers(textItems);

    if (markers.length > 0) {
      const reclassifiedRegCode = reclassifyByCoordinates(
        "reg_code",
        reg_code,
        reg_code_rationale,
        regCode.occurrenceIndex,
        regCode.candidates,
        textItems,
        markers,
        excludeReg,
      );
      reg_code = reclassifiedRegCode.value;
      reg_code_rationale = reclassifiedRegCode.rationale;

      const reclassifiedVatNo = reclassifyByCoordinates(
        "vat_no",
        vat_no,
        vat_no_rationale,
        vatNo.occurrenceIndex,
        vatNo.candidates,
        textItems,
        markers,
        excludeVat,
      );
      vat_no = reclassifiedVatNo.value;
      vat_no_rationale = reclassifiedVatNo.rationale;
    }
  }

  return {
    reg_code,
    vat_no,
    iban,
    ref_number,
    all_vat_candidates: vatNo.candidates,
    all_reg_code_candidates: regCode.candidates,
    ...(reg_code_rationale ? { reg_code_rationale } : {}),
    ...(vat_no_rationale ? { vat_no_rationale } : {}),
    rejected_candidates: rejectedCandidates,
  };
}
