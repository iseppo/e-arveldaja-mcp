// Synthetic fixtures for the lost-value image path (no corpus text): a parse whose
// lost rows carry liteparse-like geometry (a label item and a surviving leader
// tail on one row), PNG pages for a mocked render, and a mocked render/OCR seam.
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { vi } from "vitest";
import type { OcrTextItem, ParsedDocument } from "../../document-parser.js";
import type { LostValueSeam } from "../../documents/lost-value-ocr.js";
import { crc32 } from "../../png-crop.js";

export const LOST_DOTS = "....................";

/** A row whose value the text layer lost: the label, then the surviving leader tail. */
export interface LostRow { label: string }

const PAGE_W = 595;
const PAGE_H = 842;

/** The page text lines of `lostValueParse(rows)` (for packetFor / readingFor). */
export function lostValueLines(rows: ReadonlyArray<string | LostRow>): string[] {
  return rows.map((row) => (typeof row === "string" ? row : `${row.label}     ${LOST_DOTS}`));
}

/**
 * A one-page parse: a plain string is one text item on its own row; a LostRow is
 * a label item at x=48 and a leader item at x=175.77 on the same row, and the
 * page text prints them apart (so the packet line is "label ¦ ....").
 */
export function lostValueParse(rows: ReadonlyArray<string | LostRow>): ParsedDocument {
  const textLines: string[] = [];
  const textItems: Array<Record<string, unknown>> = [];
  rows.forEach((row, index) => {
    const y = 40 + 14 * index;
    if (typeof row === "string") {
      textLines.push(row);
      textItems.push({ text: row, x: 40, y, width: 200, height: 9.64 });
    } else {
      textLines.push(`${row.label}     ${LOST_DOTS}`);
      textItems.push({ text: row.label, x: 48, y, width: row.label.length * 4, height: 9.64 });
      textItems.push({ text: LOST_DOTS, x: 175.77, y, width: 60.09, height: 9.64 });
    }
  });
  const text = textLines.join("\n");
  return {
    text,
    pageCount: 1,
    ocrPartialFailure: false,
    result: {
      text,
      totalPages: 1,
      pageErrors: [],
      pages: [{ pageNum: 1, width: PAGE_W, height: PAGE_H, text, textItems }],
    },
  } as unknown as ParsedDocument;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(typeBytes, data), 8 + data.length);
  return out;
}

/** An 8-bit RGBA PNG: white, or random pixels (incompressible, to breach the size caps). */
export function pagePng(width = PAGE_W, height = PAGE_H, fill: "white" | "noise" = "white"): Buffer {
  const stride = width * 4;
  const raw = fill === "white" ? Buffer.alloc(height * (stride + 1), 0xff) : randomBytes(height * (stride + 1));
  for (let y = 0; y < height; y++) raw[y * (stride + 1)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Minimal PDF bytes whose page boxes pass pdfPageBoxRefusal. */
export const PLAIN_PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [0 0 595 842] >>\nendobj\n%%EOF\n";

/** OCR items as liteparse returns them for a one-row crop: left to right on one line. */
export function ocrRow(...parts: Array<[string, number?]>): OcrTextItem[] {
  let x = 4;
  return parts.map(([text, confidence = 0.95]) => {
    const item = { text, x, y: 12, width: text.length * 7, height: 13, confidence };
    x += item.width + 10;
    return item;
  });
}

/** A mocked seam: available, renders a white page at 72 dpi, OCR answers `ocr` (default: unavailable). */
export function fakeSeam(options: {
  available?: boolean;
  png?: Buffer;
  ocr?: (png: Buffer) => Promise<{ ok: true; items: OcrTextItem[] } | { ok: false }>;
} = {}) {
  const png = options.png ?? pagePng();
  return {
    available: vi.fn(() => options.available ?? true),
    render: vi.fn(async () => ({ png, width: PAGE_W, height: PAGE_H })),
    ocr: vi.fn(options.ocr ?? (async () => ({ ok: false as const }))),
  } satisfies LostValueSeam;
}
