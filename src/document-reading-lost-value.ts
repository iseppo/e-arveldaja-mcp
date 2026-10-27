// PURE module (lost-value image path): where the value a dot leader lost sits on
// the page, the client's `lost_value_reading` schema, and the agree/disagree
// match between the client's transcription and server OCR of the same crop.
// OCR never supplies a value: it can only agree with the client's or hold.
// Plan: .omc/plans/lost-value-image-ocr.md §3-§4, rev 2 MAJOR-1/MAJOR-3, rev 3 NEW-2.

import { inflate as inflateCallback } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { packetLostLeaders, type ReadingPacket } from "./document-reading-packet.js";
import { containsSandboxMarker, decodeJsonObjectInput, type ParseOutcome } from "./document-reading-schemas.js";
import { COLUMN_MARK, DASHES, LEADER_GLYPHS, LEADER_RUN_RE, lineCells, lineTokens, lostLeaderRunIndex } from "./document-reading-tokens.js";

const inflate = promisify(inflateCallback);

export const LOST_VALUE_FIELDS = ["invoice_date", "invoice_number"] as const;
export type LostValueField = typeof LOST_VALUE_FIELDS[number];

/** Crop geometry fixed by Step 1 (synthetic fixtures + dev corpus): label left − 10 pt, leader band ± 0.4·h. */
export const LOST_VALUE_LABEL_PAD_PT = 10;
/** The page render resolution of the crops (document-parser renders at it). */
export const LOST_VALUE_RENDER_DPI = 300;
export const LOST_VALUE_BAND_PAD = 0.4;
/** Blank proof: the band reaches this many row heights above the row (a value may sit on the rule). */
export const LEADER_BAND_ABOVE = 2;
/** Blank proof: an OCR centre may sit this many row heights outside its text-layer item (not a word with a digit). */
export const LEADER_HOST_PAD = 0.15;
/** Blank proof: an OCR item lower than this many row heights, under the confidence below, is a smudge (a dot row). */
export const LEADER_SMUDGE_MAX = 0.2;
export const LEADER_SMUDGE_MAX_CONFIDENCE = 0.5;
/** Blank proof: the band crop's two axis scales (page pt per OCR unit) may differ by this share. */
export const LEADER_BAND_MAX_SCALE_SKEW = 0.03;
export const LOST_VALUE_RIGHT_GAP_PT = 2;
/** LOW_OCR_CONFIDENCE_THRESHOLD (tools/receipt-extraction.ts), pinned here to keep this module pure. */
export const LOST_VALUE_MIN_CONFIDENCE = 0.6;
/** Image px per page pt must agree between the axes within this fraction. */
export const LOST_VALUE_MAX_AXIS_RATIO_SKEW = 0.01;

/** Why a submitted field did not agree (diagnostics, not hold codes). */
export type LostValueReason =
  | "reading_value_present"
  | "field_has_other_holds"
  | "line_not_lost"
  | "line_reused"
  | "value_form_invalid"
  | "crop_unavailable"
  | "ocr_unavailable"
  | "ocr_no_match"
  | "ocr_ambiguous"
  | "ocr_low_confidence"
  | "ocr_row_mismatch";

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const LEADER_RUN_ANY_RE = new RegExp(LEADER_RUN_RE.source, "gu");
const DASH_RE = new RegExp(`[${DASHES.replace("-", "\\-")}]`, "gu");

/** N(s): NFKC; dashes → "-"; leader runs → space; the column mark glyph → space; collapse whitespace; trim. */
export function normalizeLostValueText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(DASH_RE, "-")
    .replace(LEADER_RUN_ANY_RE, " ")
    .replace(/¦/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Anchor comparison form: N(), whitespace removed, casefolded. No diacritic folding (Step 1 decision). */
function anchorForm(text: string): string {
  return normalizeLostValueText(text).replace(/\s+/g, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Page geometry
// ---------------------------------------------------------------------------

/** A text item in liteparse viewport space (top-left origin, 72 dpi). */
export interface GeometryItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  /** True for an item liteparse OCR'd (it has a confidence): not text-layer evidence. */
  ocr?: boolean;
}

export interface LostValuePage {
  pageNum: number;
  width: number;
  height: number;
  items: ReadonlyArray<GeometryItem>;
}

/** A crop rectangle in page points, with the label text the OCR must show. */
export interface LostValueRect {
  line: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The lost cell's label text (the anchor). */
  anchor: string;
}

const PURE_LEADER_RE = new RegExp(`^(?:${LEADER_RUN_RE.source})$`, "u");
const LETTER_RE = /\p{L}/u;
const LEADER_STRIP_RE = new RegExp(LEADER_RUN_RE.source, "gu");

function isPureLeader(item: GeometryItem): boolean {
  return PURE_LEADER_RE.test(item.text.trim());
}

function compactNfc(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, "");
}

function rowOf(page: LostValuePage, leader: GeometryItem): GeometryItem[] {
  return page.items
    .filter((item) => {
      const centre = item.y + item.height / 2;
      return centre >= leader.y && centre <= leader.y + leader.height;
    })
    .slice()
    .sort((a, b) => a.x - b.x);
}

/** The lost cell's label: its own non-leader text, else the cell to its left. */
function lostCellLabel(lineText: string, cellIndex: number): string {
  const cells = lineCells(lineText);
  const own = (cells[cellIndex]?.text ?? "").replace(LEADER_STRIP_RE, " ").trim();
  if (own.length > 0) return own;
  return (cells[cellIndex - 1]?.text ?? "").trim();
}

/**
 * One crop per lost-leader packet line, or none for that line. A line gets a crop
 * only when, on its page: exactly one row of items has its signature, that row
 * holds exactly one pure-leader item, the item immediately left of the leader is
 * a letter-bearing label equal to the lost cell's label, and no row item is
 * rotated. `boxRefusal` (from `pdfPageBoxRefusal`) refuses every line.
 */
export function locateLostValueRects(
  packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">,
  pages: ReadonlyArray<LostValuePage>,
  boxRefusal: string | null,
): Map<string, LostValueRect> {
  const out = new Map<string, LostValueRect>();
  if (boxRefusal !== null) return out;
  const hits = packetLostLeaders(packet);
  for (const hit of hits) {
    const line = packet.lines.find((candidate) => candidate.id === hit.line);
    if (!line || out.has(line.id)) continue;
    const page = pages.find((candidate) => candidate.pageNum === line.page);
    if (!page || !(page.width > 0) || !(page.height > 0)) continue;
    const signature = compactNfc(line.text.split(COLUMN_MARK).join(" "));
    const sameText = packet.lines.filter((other) =>
      other.page === line.page && compactNfc(other.text.split(COLUMN_MARK).join(" ")) === signature);
    if (sameText.length !== 1) continue;

    const rows = page.items
      .filter(isPureLeader)
      .map((leader) => ({ leader, row: rowOf(page, leader) }))
      .filter(({ row }) => compactNfc(row.map((item) => item.text).join("")) === signature);
    if (rows.length !== 1) continue;
    const { leader, row } = rows[0]!;
    if (row.filter(isPureLeader).length !== 1) continue;
    if (row.some((item) => (item.rotation ?? 0) !== 0)) continue;

    const left = row.filter((item) => item !== leader && item.x + item.width <= leader.x + 0.5);
    const label = left[left.length - 1];
    if (!label || !LETTER_RE.test(label.text)) continue;
    const anchor = lostCellLabel(line.text, hit.cell);
    if (anchor.length === 0 || anchorForm(anchor) !== anchorForm(label.text)) continue;

    const right = row.find((item) => item !== leader && item.x >= leader.x + leader.width - 0.5);
    const pad = LOST_VALUE_BAND_PAD * leader.height;
    const x0 = Math.max(0, label.x - LOST_VALUE_LABEL_PAD_PT);
    const x1 = right ? right.x - LOST_VALUE_RIGHT_GAP_PT : page.width;
    const y0 = Math.max(0, leader.y - pad);
    const y1 = Math.min(page.height, leader.y + leader.height + pad);
    if (!(x1 > x0) || !(y1 > y0)) continue;
    out.set(line.id, { line: line.id, page: page.pageNum, x: x0, y: y0, width: x1 - x0, height: y1 - y0, anchor });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blank leaders (signature lines)
// ---------------------------------------------------------------------------

/** A text-layer item meeting a blank-proof band, in page points. */
export interface BandNative {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Its words in word form (of a leader item, only the text before its first leader run). */
  words: string[];
  /**
   * True for an item holding a leader run. Where its label text ends and the run starts is unknown, so the whole box
   * counts as leader: only its label words may be read on it.
   */
  leader?: true;
}

/** One lost cell's evidence: the last word of its label, which OCR must read on the label's own text-layer item. */
export interface LeaderLabel {
  word: string;
  /** Index into `natives`. */
  native: number;
}

/** A full-width page band around a lost leader's row (and up to two row heights above it, where a value may sit). */
export interface LeaderRowBand {
  line: string;
  page: number;
  y0: number;
  y1: number;
  /** The row's height (its tallest text-layer item), and the top and bottom of its items. */
  height: number;
  rowTop: number;
  rowBottom: number;
  /** Text-layer (non-OCR) items whose box meets the band. */
  natives: BandNative[];
  labels: LeaderLabel[];
}

/**
 * Word form: NFD without marks, casefolded, `|` as `l`. A word with a digit keeps its sign and inner punctuation
 * (`-12,40` is not `12,40` nor `1240`); any other word keeps only letters and digits. Leader runs and bare punctuation
 * give no word.
 */
function wordForm(token: string): string {
  const folded = token.normalize("NFD").replace(/\p{M}+/gu, "").toLocaleLowerCase("et").replace(/\|/g, "l");
  if (/\p{N}/u.test(folded)) return folded.replace(/^[^\p{L}\p{N}+\-−]+|[^\p{L}\p{N}]+$/gu, "");
  return folded.replace(/[^\p{L}\p{N}]+/gu, "");
}
const bareWords = (text: string) => text.split(/\s+/).map(wordForm).filter((word) => word.length > 0);
/** Comparison form of a word: OCR confuses i, I and l, so they compare equal. */
const sameGlyphs = (word: string) => word.replace(/i/g, "l");

/**
 * The band of one lost-leader line, or undefined. The line's text must be unique on its page, its leaders must sit in
 * text-layer items whose text is part of the line and that share one row (centres within one item height), the row's
 * items must hold the line's leader runs one for one, and every lost cell needs the label item of its own run: the
 * run's item when label text precedes it (its first run only), else the row item right before it (without a run),
 * whose last word (two characters or more) is the cell label's last word.
 */
export function leaderRowBand(
  packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">, lineId: string, page: LostValuePage,
): LeaderRowBand | undefined {
  const line = packet.lines.find((entry) => entry.id === lineId);
  if (!line || line.page !== page.pageNum) return undefined;
  const signature = compactNfc(line.text.split(COLUMN_MARK).join(" "));
  const sameText = packet.lines.filter((other) => other.page === line.page && compactNfc(other.text.split(COLUMN_MARK).join(" ")) === signature);
  if (sameText.length !== 1) return undefined;
  const leaderRun = (text: string) => new RegExp(LEADER_RUN_RE.source, "u").exec(text);
  // The row is the items around a leader-bearing item whose joined text is exactly the line (as for the crops).
  const rows = page.items
    .filter((item) => !item.ocr && leaderRun(item.text))
    .map((item) => rowOf(page, item).filter((member) => !member.ocr))
    .filter((row) => compactNfc(row.map((item) => item.text).join("")) === signature);
  const distinct = [...new Map(rows.map((row) => [row.map((item) => page.items.indexOf(item)).join(","), row])).values()];
  if (distinct.length !== 1) return undefined;
  const row = distinct[0]!;
  if (row.some((item) => (item.rotation ?? 0) !== 0)) return undefined;
  const height = Math.max(...row.map((item) => item.height));
  if (!(height > 0)) return undefined;
  const rowTop = Math.min(...row.map((item) => item.y));
  const rowBottom = Math.max(...row.map((item) => item.y + item.height));
  const y0 = Math.max(0, rowTop - LEADER_BAND_ABOVE * height);
  const y1 = Math.min(page.height, rowBottom + LOST_VALUE_BAND_PAD * height);
  const sources = page.items.filter((item) => !item.ocr && (item.rotation ?? 0) === 0 && item.y < y1 && item.y + item.height > y0);
  const natives = sources.map((item): BandNative => {
    const run = leaderRun(item.text);
    const box = { x0: item.x, x1: item.x + item.width, y0: item.y, y1: item.y + item.height };
    if (!run) return { ...box, words: bareWords(item.text) };
    return { ...box, words: bareWords(item.text.slice(0, run.index)), leader: true };
  });
  // The row's leader runs left to right, each with the row index of its item and whether it is that item's first run.
  const runs = row.flatMap((item, index) => [...item.text.matchAll(LEADER_RUN_RE)].map((_, nth) => ({ index, first: nth === 0 })));
  if (runs.length !== [...line.text.matchAll(LEADER_RUN_RE)].length) return undefined;
  const labels: LeaderLabel[] = [];
  for (const hit of packetLostLeaders(packet).filter((entry) => entry.line === lineId)) {
    const word = bareWords(lostCellLabel(line.text, hit.cell)).at(-1);
    const at = lostLeaderRunIndex(line.text, hit.cell);
    const run = at === undefined ? undefined : runs[at];
    if (word === undefined || word.length < 2 || !run?.first) return undefined;
    const own = row[run.index]!;
    const labelItem = natives[sources.indexOf(own)]!.words.length > 0 ? own : row[run.index - 1];
    if (!labelItem || (labelItem !== own && leaderRun(labelItem.text))) return undefined;
    const native = sources.indexOf(labelItem);
    if (natives[native]!.words.at(-1) !== word) return undefined;
    labels.push({ word, native });
  }
  return labels.length > 0 ? { line: lineId, page: page.pageNum, y0, y1, height, rowTop, rowBottom, natives, labels } : undefined;
}

// A word made only of glyphs that read as digits (O/0, l/1, S/5, B/8, Z/2, G/6, q/9, D/0) may be a misread number.
const DIGIT_LOOKALIKE_WORD_RE = /^[oilsbzgqd]+$/;
const mayBeValue = (word: string) => /\p{N}/u.test(word) || DIGIT_LOOKALIKE_WORD_RE.test(word);
const LEADER_ONLY_RE = new RegExp(`^[\\s${LEADER_GLYPHS}]*$`, "u");

/**
 * OCR items of a band crop in page points. `size` is the OCR's coordinate extent of the whole crop, `rect` the page
 * rectangle the crop covers; a missing size or axis scales differing by more than 3% map nothing (undefined).
 */
export function ocrItemsOnPage(
  items: ReadonlyArray<OcrItem>, size: { width: number; height: number } | undefined, rect: Pick<LostValueRect, "x" | "y" | "width" | "height">,
): OcrItem[] | undefined {
  if (!size || !(size.width > 0) || !(size.height > 0)) return undefined;
  const kx = rect.width / size.width;
  const ky = rect.height / size.height;
  if (!(kx > 0) || !(ky > 0) || Math.abs(kx / ky - 1) > LEADER_BAND_MAX_SCALE_SKEW) return undefined;
  return items.map((item) => ({
    ...item, x: rect.x + item.x * kx, y: rect.y + item.y * ky, width: item.width * kx, height: item.height * ky,
  }));
}

/**
 * Positive evidence that a leader row carries no value (plan p2 C1-SIG), from the band's OCR items in page points.
 * An OCR item's host is the text-layer item its centre lies on (a word with a digit: inside it, no slack). An item
 * hosted on a leader item, reaching into a leader item's box (its box, not its centre) or with no host is "on the
 * leader". Then:
 * - a smudge (lower than 0.2 row heights, confidence under 0.5, no digit) is noise: a dot row OCR read as letters;
 * - an item of only punctuation is fine when it is only leader glyphs, or is not on the leader;
 * - on the leader, a word with a digit always holds, and any other word must be one of the host's words (counted; of
 *   a leader item, its label words);
 * - off the leader, a word must be one of the host's words, or have no digit and not be only digit look-alikes (a
 *   script-font name or a scribble on printed text).
 * And OCR must have read each lost cell's last label word on that cell's own label item (a row item).
 */
export function leaderRowIsBlank(ocrItems: ReadonlyArray<OcrItem>, band: Pick<LeaderRowBand, "natives" | "labels" | "height">): boolean {
  const remaining = band.natives.map((native) => native.words.map(sameGlyphs));
  const read: Array<{ native: number; word: string }> = [];
  const slack = LEADER_HOST_PAD * band.height;
  const inside = (native: BandNative, x: number, y: number, pad: number) =>
    x >= native.x0 - pad && x <= native.x1 + pad && y >= native.y0 - pad && y <= native.y1 + pad;
  for (const item of ocrItems) {
    const words = bareWords(item.text).map(sameGlyphs);
    const hasDigit = words.some((word) => /\p{N}/u.test(word));
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    const host = band.natives.findIndex((native) => inside(native, cx, cy, hasDigit ? 0 : slack));
    const onLeader = host < 0 || band.natives[host]!.leader === true || band.natives.some((native) => native.leader &&
      Math.min(item.x + item.width, native.x1) - Math.max(item.x, native.x0) > slack &&
      Math.min(item.y + item.height, native.y1) > Math.max(item.y, native.y0));
    if (item.height < LEADER_SMUDGE_MAX * band.height && (item.confidence ?? 1) < LEADER_SMUDGE_MAX_CONFIDENCE && !hasDigit) continue;
    if (words.length === 0) {
      if (LEADER_ONLY_RE.test(item.text) || !onLeader) continue;
      return false;
    }
    if (onLeader && hasDigit) return false;
    for (const word of words) {
      const at = host < 0 ? -1 : remaining[host]!.indexOf(word);
      if (at >= 0) remaining[host]!.splice(at, 1);
      else if (onLeader || mayBeValue(word)) return false;
      if (host >= 0) read.push({ native: host, word });
    }
  }
  return band.labels.every((label) => {
    const at = read.findIndex((entry) => entry.native === label.native && entry.word === sameGlyphs(label.word));
    if (at < 0) return false;
    read.splice(at, 1);
    return true;
  });
}

const LABEL_TAIL_RE = /[\s:#№.]+$/u;
const labelForm = (text: string) => anchorForm(text.replace(LABEL_TAIL_RE, ""));

/**
 * True when `value` is printed as a whole word on line `lineId`, which is not a lost line, and the text before it on
 * that line is exactly the label of a lost cell, at least two words long: the text layer kept the value under the
 * same label elsewhere (Google prints "Arve number: …" in the header and loses the same number in the leader table).
 * The whole line prefix is compared, so a split cell ("Originaal ¦ Arve number: …") or a one-word label ("Nr") does
 * not match.
 */
export function printedUnderLostLabel(packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">, lineId: string, value: string): boolean {
  const { lines } = packet;
  const hits = packetLostLeaders(packet);
  const line = lines.find((entry) => entry.id === lineId);
  if (!line || hits.some((hit) => hit.line === lineId)) return false;
  const labels = new Set(hits.map((hit) => lostCellLabel(lines.find((entry) => entry.id === hit.line)!.text, hit.cell))
    .filter((label) => label.split(/\s+/).filter((word) => LETTER_RE.test(word)).length >= 2)
    .map(labelForm));
  const words = line.text.split(/[\s¦]+/).filter(Boolean);
  const at = words.findIndex((word) => word.replace(/^[(#:]+/, "").replace(/[,;:)]+$/, "") === value);
  return at > 0 && labels.has(labelForm(words.slice(0, at).join(" ")));
}

/** Page points → image pixels, or null when the axes scale differently (> 1%). */
export function rectToPixels(
  rect: Pick<LostValueRect, "x" | "y" | "width" | "height">,
  page: { width: number; height: number },
  image: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const sx = image.width / page.width;
  const sy = image.height / page.height;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return null;
  if (Math.abs(sx / sy - 1) > LOST_VALUE_MAX_AXIS_RATIO_SKEW) return null;
  return { x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}

// ---------------------------------------------------------------------------
// PDF page boxes
// ---------------------------------------------------------------------------

const OBJ_STM_MAX_BYTES = 16 * 1024 * 1024;
/** All object streams together (inflated) and their number: past either, the scan refuses (a typed row). */
const OBJ_STM_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const OBJ_STM_MAX_COUNT = 256;
/** Bytes before a `stream` keyword searched for its ` obj`, and `stream` keywords scanned at all: past either, refused. */
const STREAM_DICT_MAX_BYTES = 4096;
const STREAM_KEYWORD_MAX_COUNT = 4096;
const NUM = "-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const BOX_RE = new RegExp(`^\\s*\\[\\s*(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s*\\]`);

function boxesAt(text: string, name: string): Array<number[] | null> {
  const out: Array<number[] | null> = [];
  const re = new RegExp(`/${name}(?![A-Za-z0-9])`, "g");
  for (const match of text.matchAll(re)) {
    const box = BOX_RE.exec(text.slice(match.index! + match[0].length, match.index! + match[0].length + 200));
    out.push(box ? box.slice(1, 5).map(Number) : null);
  }
  return out;
}

/** PDF name escapes (`/Rot#61te`) decoded, so the name regexes see what a viewer sees. */
function decodeNameEscapes(text: string): string {
  return text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

async function objectStreamTexts(pdf: Buffer, text: string): Promise<string[] | string> {
  const texts: string[] = [];
  let budget = OBJ_STM_TOTAL_MAX_BYTES;
  let keywords = 0;
  // Bounded per keyword and in count: an unbounded look-back per `stream` made a crafted file quadratic.
  for (const match of text.matchAll(/(?<!end)stream(?:\r\n|\r|\n)/g)) {
    if (++keywords > STREAM_KEYWORD_MAX_COUNT) return "object_stream_unreadable";
    const windowStart = Math.max(0, match.index! - STREAM_DICT_MAX_BYTES);
    const window = text.slice(windowStart, match.index!);
    let objAt = -1;
    for (const header of window.matchAll(/\sobj(?![A-Za-z0-9])/g)) objAt = header.index!;
    // No `obj` header close before the keyword: a dictionary this long could hide an object stream, so refuse.
    if (objAt < 0) return "object_stream_unreadable";
    // An `obj` inside a string literal like `(x obj)` can cut the dict short, so the type is also looked for
    // in everything since the previous stream's end; a false match only inflates or refuses.
    const lastEnd = window.lastIndexOf("endstream");
    const dict = decodeNameEscapes(window.slice(Math.min(objAt, lastEnd < 0 ? 0 : lastEnd + 9)));
    // An object stream by its type, or by the /N and /First every object stream carries (a viewer ignores /Type).
    if (!/\/Type\s*\/ObjStm(?![A-Za-z0-9])/.test(dict) &&
      !(/\/N(?![A-Za-z0-9])/.test(dict) && /\/First(?![A-Za-z0-9])/.test(dict))) continue;
    if (texts.length >= OBJ_STM_MAX_COUNT || budget <= 0) return "object_stream_unreadable";
    if (!/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dict) || /\/DecodeParms/.test(dict)) {
      return "object_stream_unreadable";
    }
    const start = match.index! + match[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) return "object_stream_unreadable";
    try {
      // Past the per-stream or the total budget zlib throws: refused, never truncated.
      const inflated = await inflate(pdf.subarray(start, end), { maxOutputLength: Math.min(OBJ_STM_MAX_BYTES, budget) });
      budget -= inflated.length;
      texts.push(inflated.toString("latin1"));
    } catch {
      // A trailing EOL before `endstream` is not part of the data; zlib stops at
      // the stream end anyway, so only a truly unreadable stream lands here.
      return "object_stream_unreadable";
    }
  }
  return texts;
}

/**
 * Conservative scan of the raw PDF (plus its Flate object streams) for page
 * geometry the crop cannot trust: a non-zero /Rotate, any /UserUnit, a /MediaBox
 * with a non-zero origin, a /CropBox that is not a /MediaBox, an indirect box or
 * rotation, encryption, or an object stream it cannot read. Returns the reason,
 * or null when nothing was found. A false refusal only means a typed row.
 */
export async function pdfPageBoxRefusal(pdf: Buffer): Promise<string | null> {
  const raw = pdf.toString("latin1");
  if (/\/Encrypt(?![A-Za-z0-9])/.test(raw)) return "encrypted";
  const streams = await objectStreamTexts(pdf, raw);
  if (typeof streams === "string") return streams;
  const text = decodeNameEscapes([raw, ...streams].join("\n"));
  if (/\/UserUnit(?![A-Za-z0-9])/.test(text)) return "user_unit";
  for (const match of text.matchAll(/\/Rotate(?![A-Za-z0-9])\s*(-?\d+)?(\s+\d+\s+R)?/g)) {
    if (match[1] === undefined || match[2] !== undefined) return "rotate_unreadable";
    if (Number(match[1]) % 360 !== 0) return "rotated_page";
  }
  const media = boxesAt(text, "MediaBox");
  if (media.length === 0 || media.some((box) => box === null)) return "media_box_unreadable";
  if (media.some((box) => box![0] !== 0 || box![1] !== 0)) return "box_origin_not_zero";
  // Boxes compared on a 0.001 pt grid through a Set (linear); a value straddling a grid line refuses, never passes.
  const boxKey = (box: number[]) => box.map((value) => Math.round(value * 1000)).join(" ");
  const mediaKeys = new Set(media.map((box) => boxKey(box!)));
  for (const crop of boxesAt(text, "CropBox")) {
    if (crop === null) return "crop_box_unreadable";
    if (!mediaKeys.has(boxKey(crop))) return "crop_box_differs";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The client's lost_value_reading
// ---------------------------------------------------------------------------

const LOST_VALUE_READING_MAX_BYTES = 2048;
const lineRef = z.string().regex(/^p\d{1,3}:\d{3,4}$/);
// eslint-disable-next-line no-control-regex
const printed = z.string().min(1).max(64).refine((value) => !/[\u0000-\u001F\u007F-\u009F]/.test(value));
const LostValueEntrySchema = z.object({ line: lineRef, printed }).strict();

export const LostValueReadingSchema = z.object({
  invoice_date: LostValueEntrySchema.optional(),
  invoice_number: LostValueEntrySchema.optional(),
}).strict();
export type LostValueReading = z.infer<typeof LostValueReadingSchema>;

/** Decode (object or JSON string), refuse any sandbox marker left after the caller's desandbox, then parse strictly. */
export function parseLostValueReading(input: unknown): ParseOutcome<LostValueReading, "lost_value_reading_invalid"> {
  const decoded = decodeJsonObjectInput(input, LOST_VALUE_READING_MAX_BYTES);
  if (!decoded || containsSandboxMarker(decoded)) return { ok: false, code: "lost_value_reading_invalid" };
  const parsed = LostValueReadingSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, code: "lost_value_reading_invalid" };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** An OCR text item in crop-image coordinates. */
export interface OcrItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
}

interface Placed { start: number; end: number; confidence: number }
/** The joined text, its items' spans, and each OCR row's span in it (rows never share a character). */
interface OcrLine { text: string; placed: Placed[]; rows: Array<{ start: number; end: number }> }

/** Items bucketed into rows by vertical overlap, rows top to bottom, items left to right, joined by one space. */
function ocrLine(items: ReadonlyArray<OcrItem>): OcrLine {
  const rows: Array<{ top: number; bottom: number; items: OcrItem[] }> = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const bottom = item.y + item.height;
    const row = rows.find((candidate) =>
      Math.min(candidate.bottom, bottom) - Math.max(candidate.top, item.y) > 0.5 * Math.min(candidate.bottom - candidate.top, item.height));
    if (row) {
      row.items.push(item);
      row.top = Math.min(row.top, item.y);
      row.bottom = Math.max(row.bottom, bottom);
    } else {
      rows.push({ top: item.y, bottom, items: [item] });
    }
  }
  const placed: Placed[] = [];
  const spans: OcrLine["rows"] = [];
  let text = "";
  for (const row of rows.sort((a, b) => a.top - b.top)) {
    let rowStart: number | undefined;
    for (const item of row.items.sort((a, b) => a.x - b.x)) {
      const part = normalizeLostValueText(item.text);
      if (part.length === 0) continue;
      if (text.length > 0) text += " ";
      rowStart ??= text.length;
      // liteparse confidence is 0–1; anything else (NaN, a 0–100 scale from a remote server) counts as none.
      const confidence = typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : 0;
      placed.push({ start: text.length, end: text.length + part.length, confidence });
      text += part;
    }
    if (rowStart !== undefined) spans.push({ start: rowStart, end: text.length });
  }
  return { text, placed, rows: spans };
}

/** `text` keeps every trailing character a number may hold (`.` `-` `/` `_`); `bareEnd` also drops a trailing `.`. */
interface Candidate { text: string; start: number; end: number; bareEnd: number }

/** Whitespace tokens with leading `#:` and trailing `,;:` stripped (never number characters); candidates hold ≥ 1 digit. */
function candidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const lead = /^[#:]*/.exec(match[0])![0].length;
    const core = match[0].slice(lead).replace(/[,;:]+$/, "");
    if (!/\d/.test(core)) continue;
    const start = match.index! + lead;
    out.push({ text: core, start, end: start + core.length, bareEnd: start + core.replace(/[.,;:]+$/, "").length });
  }
  return out;
}

const NUMBER_TRAILING_PUNCT_RE = /[.\-/_]+$/;

function minConfidence(line: OcrLine, start: number, end: number): number {
  const covering = line.placed.filter((part) => part.start < end && part.end > start);
  return covering.length === 0 ? 0 : Math.min(...covering.map((part) => part.confidence));
}

const RESIDUE_ALLOWED_RE = new RegExp(`[${LEADER_GLYPHS}#:.,;\\-–—]`, "gu");

/**
 * The label must sit on the candidate's own OCR row (a label on a neighbouring row proves nothing), and beside
 * the label and the candidate that row holds only leader glyphs and punctuation: a letter-only part left over
 * (`INV 0042` read as `0042`) means the candidate may be a cut-short value.
 */
function anchorCheck(line: OcrLine, start: number, end: number, anchor: string): "ok" | "ocr_row_mismatch" | "ocr_ambiguous" {
  const row = line.rows.find((span) => span.start <= start && end <= span.end);
  if (!row) return "ocr_row_mismatch";
  const remainder = anchorForm(line.text.slice(row.start, start) + " " + line.text.slice(end, row.end));
  const label = anchorForm(anchor);
  const at = remainder.indexOf(label);
  if (at < 0) return "ocr_row_mismatch";
  const residue = (remainder.slice(0, at) + remainder.slice(at + label.length)).replace(RESIDUE_ALLOWED_RE, "");
  return residue.length === 0 ? "ok" : "ocr_ambiguous";
}

const NUMBER_FORM_RE = /^[A-Za-z0-9][A-Za-z0-9\-/._]{0,63}$/;

export type LostValueMatch =
  | { status: "image_ocr_agreed"; value: string }
  | { status: Extract<LostValueReason, "value_form_invalid" | "ocr_no_match" | "ocr_ambiguous" | "ocr_low_confidence" | "ocr_row_mismatch"> };

/**
 * Accepts the client's `printed` only when the crop's OCR holds exactly one
 * candidate equal to it, at confidence ≥ 0.6, and the rest of the OCR line still
 * shows the cited cell's label. The returned value is the client's, never OCR's.
 */
export function matchLostValue(
  field: LostValueField,
  printedValue: string,
  ocrItems: ReadonlyArray<OcrItem>,
  anchor: string,
): LostValueMatch {
  const line = ocrLine(ocrItems);
  if (field === "invoice_number") {
    if (printedValue !== normalizeLostValueText(printedValue) || !NUMBER_FORM_RE.test(printedValue) ||
      !/\d/.test(printedValue)) {
      return { status: "value_form_invalid" };
    }
    const found = candidates(line.text);
    if (found.length === 0) return { status: "ocr_no_match" };
    if (found.length > 1) return { status: "ocr_ambiguous" };
    const only = found[0]!;
    if (only.text !== printedValue) {
      // A trailing `.` `-` `/` `_` may be the number's or the sentence's: never dropped on agreement, held instead.
      return only.text.replace(NUMBER_TRAILING_PUNCT_RE, "") === printedValue.replace(NUMBER_TRAILING_PUNCT_RE, "")
        ? { status: "ocr_ambiguous" }
        : { status: "ocr_no_match" };
    }
    if (minConfidence(line, only.start, only.end) < LOST_VALUE_MIN_CONFIDENCE) return { status: "ocr_low_confidence" };
    const anchored = anchorCheck(line, only.start, only.end, anchor);
    if (anchored !== "ok") return { status: anchored };
    return { status: "image_ocr_agreed", value: printedValue };
  }

  const normalized = normalizeLostValueText(printedValue);
  const own = lineTokens({ id: "x", text: normalized }).dates;
  const ownDate = own.length === 1 ? own[0]! : undefined;
  if (!ownDate || ownDate.start !== 0 || ownDate.end !== normalized.length ||
    ownDate.ambiguousSlash || ownDate.values.length !== 1) {
    return { status: "value_form_invalid" };
  }
  const iso = ownDate.values[0]!;
  const dates = lineTokens({ id: "ocr", text: line.text }).dates;
  if (dates.length === 0) return { status: "ocr_no_match" };
  if (dates.length > 1) return { status: "ocr_ambiguous" };
  const date = dates[0]!;
  if (date.ambiguousSlash || date.values.length !== 1) return { status: "ocr_ambiguous" };
  // Letter diacritics fold (OCR reads "märts" as "marts"); the ISO date above already fixes every digit.
  const form = (text: string) => text.normalize("NFD").replace(/\p{M}+/gu, "").replace(/\s+/g, "");
  if (date.values[0] !== iso || form(date.text) !== form(normalized)) {
    return { status: "ocr_no_match" };
  }
  if (candidates(line.text).some((candidate) => candidate.start < date.start || candidate.bareEnd > date.end)) {
    return { status: "ocr_ambiguous" };
  }
  if (minConfidence(line, date.start, date.end) < LOST_VALUE_MIN_CONFIDENCE) return { status: "ocr_low_confidence" };
  const anchored = anchorCheck(line, date.start, date.end, anchor);
  if (anchored !== "ok") return { status: anchored };
  return { status: "image_ocr_agreed", value: iso };
}
