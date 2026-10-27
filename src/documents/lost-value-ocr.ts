// IO seam of the lost-value image path: renders the pages of a held document,
// crops the rows whose value the text layer lost, and OCRs a crop at verify.
// Every failure is an absent crop or an unavailable OCR; the caller holds.
// Plan: .omc/plans/lost-value-image-ocr.md Step 3.

import { readFile } from "node:fs/promises";
import {
  lostValueImagesAvailable,
  ocrPng,
  renderPagePng,
  type OcrPngResult,
  type ParsedDocument,
} from "../document-parser.js";
import { packetLostLeaders, type ReadingPacket } from "../document-reading-packet.js";
import {
  LOST_VALUE_RENDER_DPI,
  leaderRowBand,
  leaderRowIsBlank,
  locateLostValueRects,
  ocrItemsOnPage,
  pdfPageBoxRefusal,
  rectToPixels,
  type LostValuePage,
  type LostValueRect,
  type OcrItem,
} from "../document-reading-lost-value.js";
import { croppedPixels, cropPng, PNG_CROP_MAX_INPUT_PIXELS, PngCropError } from "../png-crop.js";

export const LOST_VALUE_MAX_CROPS = 6;
export const LOST_VALUE_MAX_TOTAL_BYTES = 256 * 1024;
/** Distinct pages rendered per read: lost rows on more pages send none (`over_budget`). */
export const LOST_VALUE_MAX_PAGES = 2;

/** Injectable render/OCR (tests); the default goes to liteparse. Calls resolve lazily so a mocked parser module stays inert. */
export interface LostValueSeam {
  available(): boolean;
  render(filePath: string, page: number): Promise<{ png: Buffer; width: number; height: number }>;
  ocr(png: Buffer): Promise<OcrPngResult>;
}

export const defaultLostValueSeam: LostValueSeam = {
  available: () => lostValueImagesAvailable(),
  render: (filePath, page) => renderPagePng(filePath, page),
  ocr: (png) => ocrPng(png),
};

function pagesOf(parsed: ParsedDocument): LostValuePage[] {
  return (parsed.result?.pages ?? []).map((page) => ({
    pageNum: page.pageNum,
    width: page.width,
    height: page.height,
    items: (page.textItems ?? []).map(({ text, x, y, width, height, rotation, confidence }) =>
      ({ text, x, y, width, height, ...(rotation !== undefined ? { rotation } : {}), ...(confidence !== undefined ? { ocr: true } : {}) })),
  }));
}

/** The crop rectangle of every locatable lost line; none for a non-PDF or a PDF whose page boxes are refused. */
export async function lostValueRects(
  filePath: string,
  parsed: ParsedDocument,
  packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">,
): Promise<Map<string, LostValueRect>> {
  const bytes = await readFile(filePath);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return new Map();
  return locateLostValueRects(packet, pagesOf(parsed), await pdfPageBoxRefusal(bytes));
}

async function cropOf(
  filePath: string,
  parsed: ParsedDocument,
  rect: LostValueRect,
  seam: LostValueSeam,
  rendered: Map<number, Promise<{ png: Buffer; width: number; height: number }>>,
): Promise<Buffer> {
  const page = parsed.result.pages.find((candidate) => candidate.pageNum === rect.page);
  if (!page) throw new PngCropError("page missing");
  // Refuse before rendering: a large page at 300 dpi would allocate far past the crop's input cap.
  const scale = LOST_VALUE_RENDER_DPI / 72;
  if (!(Math.ceil(page.width * scale) * Math.ceil(page.height * scale) <= PNG_CROP_MAX_INPUT_PIXELS)) {
    throw new PngCropError("page too large");
  }
  if (!rendered.has(rect.page)) rendered.set(rect.page, seam.render(filePath, rect.page));
  const shot = await rendered.get(rect.page)!;
  const pixels = rectToPixels(rect, page, shot);
  if (!pixels) throw new PngCropError("page and image scale differ");
  return cropPng(shot.png, pixels);
}

/** `cropOf`, and the page rectangle the crop really covers (`croppedPixels`: cropPng rounds outward and clamps). */
async function cropWithRect(
  filePath: string,
  parsed: ParsedDocument,
  rect: LostValueRect,
  seam: LostValueSeam,
  rendered: Map<number, Promise<{ png: Buffer; width: number; height: number }>>,
): Promise<{ png: Buffer; covered: Pick<LostValueRect, "x" | "y" | "width" | "height"> }> {
  const png = await cropOf(filePath, parsed, rect, seam, rendered);
  const shot = await rendered.get(rect.page)!;
  const page = parsed.result.pages.find((candidate) => candidate.pageNum === rect.page)!;
  const sx = shot.width / page.width;
  const sy = shot.height / page.height;
  // cropOf succeeded, so rectToPixels gave this same rectangle.
  const cut = croppedPixels(rectToPixels(rect, page, shot)!, shot);
  return { png, covered: { x: cut.x / sx, y: cut.y / sy, width: cut.width / sx, height: cut.height / sy } };
}

export type LostValueCrops =
  | { images: Array<{ line: string; png: Buffer }> }
  | { omitted: "over_budget" };

/**
 * mode='read': one PNG crop per locatable lost line, in packet order. More than
 * six lines or two pages, a crop over 64 KB or more than 256 KB in all sends none
 * (`over_budget`). A line whose page cannot be rendered or cropped gets no image.
 * Pages are cropped one at a time; a page's render is dropped before the next.
 */
export async function buildLostValueCrops(
  filePath: string,
  parsed: ParsedDocument,
  packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">,
  seam: LostValueSeam = defaultLostValueSeam,
): Promise<LostValueCrops> {
  if (!seam.available()) return { images: [] };
  const rects = await lostValueRects(filePath, parsed, packet);
  if (rects.size > LOST_VALUE_MAX_CROPS) return { omitted: "over_budget" };
  const byPage = new Map<number, Array<{ index: number; rect: LostValueRect }>>();
  packet.lines.forEach((line, index) => {
    const rect = rects.get(line.id);
    if (rect) byPage.set(rect.page, [...(byPage.get(rect.page) ?? []), { index, rect }]);
  });
  if (byPage.size > LOST_VALUE_MAX_PAGES) return { omitted: "over_budget" };
  const images: Array<{ index: number; line: string; png: Buffer }> = [];
  let total = 0;
  for (const entries of byPage.values()) {
    // Scoped to this page, so its full 300-dpi render is released before the next page renders.
    const rendered = new Map<number, Promise<{ png: Buffer; width: number; height: number }>>();
    for (const { index, rect } of entries) {
      let png: Buffer;
      try {
        png = await cropOf(filePath, parsed, rect, seam, rendered);
      } catch (error) {
        if (error instanceof PngCropError && error.message === "crop too large") return { omitted: "over_budget" };
        continue;
      }
      total += png.length;
      if (total > LOST_VALUE_MAX_TOTAL_BYTES) return { omitted: "over_budget" };
      images.push({ index, line: rect.line, png });
    }
  }
  return { images: images.sort((a, b) => a.index - b.index).map(({ line, png }) => ({ line, png })) };
}

export type LostValueOcr =
  | { ok: true; items: OcrItem[]; anchor: string }
  | { ok: false; reason: "crop_unavailable" | "ocr_unavailable" };

/**
 * mode='verify': re-renders and re-crops the cited line exactly as read did,
 * then OCRs the crop. The OCR items go only to the matcher, never to the client.
 */
export async function ocrLostValueLine(
  filePath: string,
  parsed: ParsedDocument,
  rects: Map<string, LostValueRect>,
  line: string,
  seam: LostValueSeam = defaultLostValueSeam,
  rendered = new Map<number, Promise<{ png: Buffer; width: number; height: number }>>(),
): Promise<LostValueOcr> {
  const rect = rects.get(line);
  if (!rect) return { ok: false, reason: "crop_unavailable" };
  let png: Buffer;
  try {
    png = await cropOf(filePath, parsed, rect, seam, rendered);
  } catch {
    return { ok: false, reason: "crop_unavailable" };
  }
  let result: OcrPngResult;
  try {
    result = await seam.ocr(png);
  } catch {
    return { ok: false, reason: "ocr_unavailable" };
  }
  if (!result.ok) return { ok: false, reason: "ocr_unavailable" };
  return { ok: true, items: result.items, anchor: rect.anchor };
}

/** Proves lost-leader lines blank from the page image; `blankLeaderLines` on a seam, or a stub in tests. */
export type BlankLeaderProof = (
  filePath: string, parsed: ParsedDocument, packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">,
) => Promise<string[]>;

/**
 * The lost-leader lines the page image proves blank (signature and receipt lines, plan p2 C1-SIG): each line's
 * full-width band is rendered and OCR'd, mapped back to page points, and `leaderRowIsBlank` decides. Any failure (no
 * OCR, a refused page box, a page or crop over its cap, more than six lines or two pages, no OCR extent) proves
 * nothing, and the line stays lost. Pages are rendered one at a time.
 */
export async function blankLeaderLines(
  filePath: string,
  parsed: ParsedDocument,
  packet: Pick<ReadingPacket, "lines" | "blank_leader_lines">,
  seam: LostValueSeam = defaultLostValueSeam,
): Promise<string[]> {
  if (!seam.available()) return [];
  const lineIds = [...new Set(packetLostLeaders(packet).map((hit) => hit.line))];
  if (lineIds.length === 0 || lineIds.length > LOST_VALUE_MAX_CROPS) return [];
  const byPage = new Map<number, string[]>();
  for (const lineId of lineIds) {
    const page = packet.lines.find((entry) => entry.id === lineId)!.page;
    byPage.set(page, [...(byPage.get(page) ?? []), lineId]);
  }
  if (byPage.size > LOST_VALUE_MAX_PAGES) return [];
  const bytes = await readFile(filePath);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-" || await pdfPageBoxRefusal(bytes) !== null) return [];
  const pages = pagesOf(parsed);
  const blank: string[] = [];
  for (const [pageNum, ids] of byPage) {
    const page = pages.find((candidate) => candidate.pageNum === pageNum);
    if (!page) continue;
    // Scoped to this page, so its full 300-dpi render is released before the next page renders.
    const rendered = new Map<number, Promise<{ png: Buffer; width: number; height: number }>>();
    for (const lineId of ids) {
      const band = leaderRowBand(packet, lineId, page);
      if (!band) continue;
      const rect: LostValueRect = { line: lineId, page: pageNum, x: 0, y: band.y0, width: page.width, height: band.y1 - band.y0, anchor: "" };
      let crop: Awaited<ReturnType<typeof cropWithRect>>;
      try {
        crop = await cropWithRect(filePath, parsed, rect, seam, rendered);
      } catch {
        continue;
      }
      const result = await seam.ocr(crop.png).catch((): OcrPngResult => ({ ok: false }));
      const items = result.ok ? ocrItemsOnPage(result.items, result.size, crop.covered) : undefined;
      if (items && leaderRowIsBlank(items, band)) blank.push(lineId);
    }
  }
  return blank;
}
