// PURE module (P1 reading checker): builds the numbered reading packet from an
// already-parsed document, computes its digest, and provides the line-matching
// primitives the checker uses. No IO: the caller passes the parse result in.
// Plan: .omc/plans/p1-reading-checker.md §1.2.

import { createHash } from "node:crypto";
import { stripSandboxMarkers } from "./sandbox-markers.js";
import type { ReadingField } from "./document-reading-schemas.js";
import { COLUMN_MARK, lostValueLeaders } from "./document-reading-tokens.js";

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

export interface PacketSourceItem { text: string; ocr: boolean }
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
}
export interface PacketLine { id: string; page: number; n: number; text: string }
export interface PageOrigin { page: number; native: string; ocr: string[] }
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

function nonEmptyItemTexts(items: readonly PacketSourceItem[], ocr: boolean): string[] {
  return items.filter((item) => item.ocr === ocr).map((item) => compact(item.text)).filter((text) => text.length > 0);
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
    origin.push({
      page: page.pageNum,
      native: nonEmptyItemTexts(page.items, false).join(""),
      ocr: nonEmptyItemTexts(page.items, true),
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
  if (lostValueLeaders(lines).length > 0) hold("text_layer_value_lost");

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
  };
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
  if (pageOrigin.ocr.some((ocrText) => token.includes(ocrText) || ocrText.includes(token))) holds.push("ocr_cited_text");
  if (!pageOrigin.native.includes(token)) holds.push("cited_origin_unestablished");
  return holds;
}
