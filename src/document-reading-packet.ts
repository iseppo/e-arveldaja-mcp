// PURE module (P1 reading checker): builds the numbered reading packet from an
// already-parsed document, computes its digest, and provides the line-matching
// primitives the checker uses. No IO: the caller passes the parse result in.
// Plan: .omc/plans/p1-reading-checker.md §1.2.

import { createHash } from "node:crypto";
import { stripSandboxMarkers } from "./sandbox-markers.js";
import type { ReadingField } from "./document-reading-schemas.js";
import { COLUMN_MARK, isWholeToken, lostValueLeaders } from "./document-reading-tokens.js";

export { COLUMN_MARK };

export const PACKET_BUILDER_VERSION = "1";
/** RESPONSE_BUDGETS.detail.target (response-budget.ts), pinned here to keep this module pure. */
export const PACKET_MAX_TEXT_BYTES = 24576;
export const PACKET_MAX_LINES = 1500;

export const PACKET_HOLD_CODES = [
  "partial_parse_config",
  "page_count_mismatch",
  "page_extraction_failed",
  "packet_oversize",
  "ocr_document",
  "text_layer_value_lost",
] as const;
export type PacketHoldCode = typeof PACKET_HOLD_CODES[number];
export interface PacketHold { code: PacketHoldCode; class: "non_content" }

export type OriginHoldCode = "ocr_cited_text" | "cited_origin_unestablished";

/** A text item's box on the page (liteparse x/y/width/height, page points). Absent when the parser gave none. */
export interface ItemBox { x: number; y: number; width: number; height: number }
export interface PacketSourceItem { text: string; ocr: boolean; box?: ItemBox }
export interface PacketSourcePage {
  pageNum: number;
  text: string;
  items: PacketSourceItem[];
  fullPageImage: boolean;
  reasons: string[];
  isGarbled: boolean;
}
export interface PacketBuildInput {
  sourceSha256: string;
  parserVersion: string;
  pages: PacketSourcePage[];
  totalPages: number;
  pageErrors: ReadonlyArray<{ pageNum: number }>;
  parseConfig: { maxPagesSet: boolean; targetPagesSet: boolean };
  /** Lost-leader lines the server proved blank from the page image (src/documents/lost-value-ocr.ts). */
  blankLeaderLines?: readonly string[];
}
export interface PacketLine { id: string; page: number; n: number; text: string }
/** `text` is compacted (no whitespace); `raw` keeps the item's own text for whole-token matching. */
export interface OriginItem { text: string; raw: string; box?: ItemBox }
/** `native` and `ocr` are the compacted texts (digest-free, text only); the `*_items` keep each item's box for the origin check. */
export interface PageOrigin { page: number; native: string; ocr: string[]; native_items: OriginItem[]; ocr_items: OriginItem[] }
export interface ReadingPacket {
  version: 1;
  source_sha256: string;
  parser_version: string;
  builder_version: string;
  packet_digest: string;
  lines: PacketLine[];
  text: string;
  text_bytes: number;
  holds: PacketHold[];
  origin: PageOrigin[];
  /** Leader lines proven blank (signature lines): not lost values. Absent when none. */
  blank_leader_lines?: string[];
}

// C0 and C1 control characters (tab and newline included; lines are already split).
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

function normalizeSourceLine(raw: string): string | undefined {
  const cleaned = stripSandboxMarkers(raw).replace(CONTROL_CHARS_RE, " ").normalize("NFC");
  if (/^\s*$/.test(cleaned)) return undefined;
  return cleaned
    .trim()
    .replace(/\s{2,}/g, COLUMN_MARK)
    .replace(/\s/g, (ch) => (ch === " " ? ch : " "));
}

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

export function lineId(page: number, n: number): string {
  return `p${page}:${String(n).padStart(3, "0")}`;
}

export function renderPacketLine(line: PacketLine): string {
  return `${line.id} │ ${line.text}`;
}

export function computePacketDigest(input: {
  sourceSha256: string;
  parserVersion: string;
  builderVersion: string;
  text: string;
}): string {
  const hash = createHash("sha256");
  hash.update(input.sourceSha256, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(input.parserVersion, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(input.builderVersion, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(input.text, "utf8");
  return hash.digest("hex");
}

function nonEmptyItems(items: readonly PacketSourceItem[], ocr: boolean): OriginItem[] {
  return items.filter((item) => item.ocr === ocr)
    .map((item) => ({ text: compact(item.text), raw: item.text.normalize("NFC"), ...(item.box ? { box: item.box } : {}) }))
    .filter((item) => item.text.length > 0);
}

function nonEmptyItemTexts(items: readonly PacketSourceItem[], ocr: boolean): string[] {
  return nonEmptyItems(items, ocr).map((item) => item.text);
}

function isOcrPage(page: PacketSourcePage): boolean {
  const ocrCount = nonEmptyItemTexts(page.items, true).length;
  const nativeCount = nonEmptyItemTexts(page.items, false).length;
  return page.fullPageImage ||
    page.reasons.includes("scanned") ||
    page.isGarbled ||
    (ocrCount >= nativeCount && ocrCount > 0);
}

export function buildReadingPacket(input: PacketBuildInput): ReadingPacket {
  const lines: PacketLine[] = [];
  const origin: PageOrigin[] = [];
  for (const page of input.pages) {
    let n = 0;
    for (const raw of page.text.split("\n")) {
      const text = normalizeSourceLine(raw);
      if (text === undefined) continue;
      n += 1;
      lines.push({ id: lineId(page.pageNum, n), page: page.pageNum, n, text });
    }
    const nativeItems = nonEmptyItems(page.items, false);
    const ocrItems = nonEmptyItems(page.items, true);
    origin.push({
      page: page.pageNum,
      native: nativeItems.map((item) => item.text).join(""),
      ocr: ocrItems.map((item) => item.text),
      native_items: nativeItems,
      ocr_items: ocrItems,
    });
  }
  const text = lines.map(renderPacketLine).join("\n");
  const textBytes = Buffer.byteLength(text, "utf8");

  const holds: PacketHold[] = [];
  const hold = (code: PacketHoldCode) => holds.push({ code, class: "non_content" });
  if (input.parseConfig.maxPagesSet || input.parseConfig.targetPagesSet) hold("partial_parse_config");
  if (input.totalPages !== input.pages.length) hold("page_count_mismatch");
  if (input.pageErrors.length > 0) hold("page_extraction_failed");
  if (textBytes > PACKET_MAX_TEXT_BYTES || lines.length > PACKET_MAX_LINES) hold("packet_oversize");
  if (input.pages.some(isOcrPage)) hold("ocr_document");
  const blank = [...new Set(input.blankLeaderLines ?? [])].filter((id) => lines.some((line) => line.id === id)).sort();
  if (packetLostLeaders({ lines, blank_leader_lines: blank }).length > 0) hold("text_layer_value_lost");

  return {
    version: 1,
    source_sha256: input.sourceSha256,
    parser_version: input.parserVersion,
    builder_version: PACKET_BUILDER_VERSION,
    packet_digest: computePacketDigest({
      sourceSha256: input.sourceSha256,
      parserVersion: input.parserVersion,
      builderVersion: PACKET_BUILDER_VERSION,
      text,
    }),
    lines,
    text,
    text_bytes: textBytes,
    holds,
    origin,
    ...(blank.length > 0 ? { blank_leader_lines: blank } : {}),
  };
}

/** The lost-value leaders of a packet: every leader cell, minus the lines the server proved blank. */
export function packetLostLeaders(packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">): Array<{ line: string; cell: number }> {
  const blank = new Set(packet.blank_leader_lines ?? []);
  return lostValueLeaders(packet.lines).filter((hit) => !blank.has(hit.line));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// The column mark, a bare `¦`, NBSP, U+202F and any whitespace run become one space.
const MATCH_COLLAPSE_RE = /[\s¦]+/g;

export function normalizeForMatch(text: string): string {
  return text.normalize("NFC").replace(MATCH_COLLAPSE_RE, " ").trim();
}

export interface TextSpan { start: number; end: number }

/** normalizeForMatch with a map from each normalized character back to its span in the source. */
function normalizeWithMap(source: string): { norm: string; starts: number[]; ends: number[] } {
  const text = source.normalize("NFC");
  let norm = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const collapse = /[\s¦]/;
  let i = 0;
  while (i < text.length) {
    if (collapse.test(text[i]!)) {
      let j = i;
      while (j < text.length && collapse.test(text[j]!)) j += 1;
      norm += " ";
      starts.push(i);
      ends.push(j);
      i = j;
    } else {
      norm += text[i];
      starts.push(i);
      ends.push(i + 1);
      i += 1;
    }
  }
  // trim
  let from = 0;
  let to = norm.length;
  while (from < to && norm[from] === " ") from += 1;
  while (to > from && norm[to - 1] === " ") to -= 1;
  return { norm: norm.slice(from, to), starts: starts.slice(from, to), ends: ends.slice(from, to) };
}

/**
 * Every occurrence of normalizeForMatch(quote) in normalizeForMatch(line.text), as spans of
 * line.text (which the packet builder has already NFC-normalised).
 */
export function matchOffsets(quote: string, line: { text: string }): TextSpan[] {
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return [];
  const { norm, starts, ends } = normalizeWithMap(line.text);
  const spans: TextSpan[] = [];
  let from = 0;
  for (;;) {
    const at = norm.indexOf(needle, from);
    if (at < 0) break;
    spans.push({ start: starts[at]!, end: ends[at + needle.length - 1]! });
    from = at + 1;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Whole-document text for the reverse-charge note detector
// ---------------------------------------------------------------------------

/**
 * Per page, the packet lines in order with ` ¦ ` replaced by one space and normalizeForMatch
 * applied, joined with "\n"; pages joined with "\n". The injected detector runs once over it.
 */
export function reverseChargeText(packet: ReadingPacket): string {
  const pages: string[] = [];
  let current: number | undefined;
  let buffer: string[] = [];
  for (const line of packet.lines) {
    if (current !== undefined && line.page !== current) {
      pages.push(buffer.join("\n"));
      buffer = [];
    }
    current = line.page;
    buffer.push(normalizeForMatch(line.text.split(COLUMN_MARK).join(" ")));
  }
  if (buffer.length > 0) pages.push(buffer.join("\n"));
  return pages.join("\n");
}

// ---------------------------------------------------------------------------
// Cited-token origin (payload fields only)
// ---------------------------------------------------------------------------

/** Names are never written by the booking (design §3.5), so logo OCR cannot hold them. */
const ORIGIN_EXEMPT_FIELDS: ReadonlySet<ReadingField> = new Set(["supplier_name", "buyer_name"]);

export function citedTokenOriginHolds(
  packet: ReadingPacket,
  page: number,
  tokenText: string,
  field: ReadingField,
): OriginHoldCode[] {
  if (ORIGIN_EXEMPT_FIELDS.has(field)) return [];
  const token = compact(tokenText);
  if (token.length === 0) return [];
  const pageOrigin = packet.origin.find((entry) => entry.page === page);
  if (!pageOrigin) return ["cited_origin_unestablished"];
  const holds: OriginHoldCode[] = [];
  const related = (text: string) => token.includes(text) || text.includes(token);
  // Live 2026-10-28 (Tele2 logo OCR "9"/"EE", Anthropic logo "A"): a substring hit is released only by place — the OCR
  // item is a strict fragment of the token, it has a box, a native item prints the token as a whole token, and the OCR
  // box touches no native item at all (a stray logo glyph, not a character completing a native prefix such as "A-1"
  // + OCR "7" while "Tellimus A-17" is printed elsewhere); a native item without a box may touch it, so it holds. Nor
  // may it touch another OCR fragment of the same value (OCR "A-1" + "7"; Tele2's logo pieces touch each other but not
  // two of one value). An OCR item containing the whole value is always held
  // ("Tasuda 59,00" read by OCR while the text layer prints only "Eelmine saldo 159,00"). Without geometry on either
  // side the substring rule stands (the rejected separator-boundary relaxation stays rejected).
  const printing = pageOrigin.native_items.filter((item) => item.box !== undefined && printsWholeToken(item.raw, tokenText));
  const ocrHit = pageOrigin.ocr_items.some((item) => related(item.text)
    && !(item.box !== undefined && token.includes(item.text) && item.text !== token && printing.length > 0
      && !pageOrigin.native_items.some((native) => native.box === undefined || boxesTouch(item.box!, native.box))
      && !pageOrigin.ocr_items.some((other) => other !== item && related(other.text)
        && (other.box === undefined || boxesTouch(item.box!, other.box)))));
  if (ocrHit) holds.push("ocr_cited_text");
  if (!pageOrigin.native.includes(token)) holds.push("cited_origin_unestablished");
  return holds;
}

/** Whether `raw` prints `tokenText` as a whole token (whitespace-tolerant match, letters/digits on neither side). */
function printsWholeToken(raw: string, tokenText: string): boolean {
  return matchOffsets(tokenText, { text: raw }).some((span) => isWholeToken(raw, span.start, span.end - span.start));
}

/** Whether the OCR box intersects the native box widened by 0.25 of the native item's height on every side. */
function boxesTouch(ocr: ItemBox, native: ItemBox): boolean {
  const slack = 0.25 * native.height;
  return ocr.x < native.x + native.width + slack && native.x - slack < ocr.x + ocr.width
    && ocr.y < native.y + native.height + slack && native.y - slack < ocr.y + ocr.height;
}
