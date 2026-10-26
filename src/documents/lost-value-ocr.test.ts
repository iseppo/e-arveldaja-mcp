import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLeaderOverlayPdf } from "../__fixtures__/document-reading/leader-overlay-pdf.js";
import { fakeSeam, lostValueParse, ocrRow, pagePng, PLAIN_PDF } from "../__fixtures__/document-reading/lost-value.js";
import { buildReadingPacket } from "../document-reading-packet.js";
import { packetInputFromParse } from "../tools/document-text-hazards.js";
import type { ParsedDocument } from "../document-parser.js";
import { pngSize } from "../png-crop.js";
import { buildLostValueCrops, lostValueRects, ocrLostValueLine } from "./lost-value-ocr.js";

function file(contents: string | Buffer, name = "invoice.pdf"): string {
  const path = join(mkdtempSync(join(tmpdir(), "lost-value-")), name);
  writeFileSync(path, contents);
  return path;
}

function packetOf(parsed: ParsedDocument) {
  return buildReadingPacket(packetInputFromParse(parsed, "a".repeat(64), "test"));
}

const ROWS = ["Seller OÜ", { label: "Invoice number" }, { label: "Invoice date" }, "Total 12,40"];

describe("buildLostValueCrops", () => {
  it("crops every lost row, in packet order, rendering the page once", async () => {
    const parsed = lostValueParse(ROWS);
    const seam = fakeSeam();
    const result = await buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), seam);
    expect("images" in result && result.images.map((image) => image.line)).toEqual(["p1:002", "p1:003"]);
    expect(seam.render).toHaveBeenCalledTimes(1);
    expect(seam.render).toHaveBeenCalledWith(expect.any(String), 1);
    expect(seam.ocr).not.toHaveBeenCalled();
    const first = (result as { images: Array<{ png: Buffer }> }).images[0]!;
    // label left − 10 pt to the page edge; band ± 0.4·h of the 9.64 pt leader (72 dpi render).
    expect(pngSize(first.png)).toEqual({ width: 595 - 38, height: 18 });
  });

  it("sends nothing when the seam is unavailable (OCR off or the kill switch)", async () => {
    const parsed = lostValueParse(ROWS);
    const seam = fakeSeam({ available: false });
    expect(await buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), seam)).toEqual({ images: [] });
    expect(seam.render).not.toHaveBeenCalled();
  });

  it("sends nothing for a file that is not a PDF or whose page boxes are refused", async () => {
    const parsed = lostValueParse(ROWS);
    for (const contents of [Buffer.from("\x89PNG not a pdf"), buildLeaderOverlayPdf({ rotate: 90 }), buildLeaderOverlayPdf({ mediaBox: [10, 10, 605, 852] })]) {
      const seam = fakeSeam();
      expect(await buildLostValueCrops(file(contents), parsed, packetOf(parsed), seam)).toEqual({ images: [] });
      expect(seam.render).not.toHaveBeenCalled();
    }
  });

  it("never renders a page whose 300-dpi image would exceed the crop's 40 Mpx input cap", async () => {
    const parsed = lostValueParse(ROWS);
    const seam = fakeSeam();
    const page = parsed.result.pages[0]!;
    // 1600 × 1700 pt → 6667 × 7084 px ≈ 47 Mpx at 300 dpi (A4 is ≈ 8.7 Mpx).
    Object.assign(page, { width: 1600, height: 1700 });
    expect(await buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), seam)).toEqual({ images: [] });
    expect(seam.render).not.toHaveBeenCalled();
  });

  it("skips the rows of a page that cannot be rendered", async () => {
    const parsed = lostValueParse(ROWS);
    const seam = fakeSeam();
    seam.render.mockRejectedValueOnce(new Error("render failed"));
    expect(await buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), seam)).toEqual({ images: [] });
  });

  it("omits every image when more than six rows were lost", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ label: `Field ${String.fromCharCode(65 + i)}` }));
    const parsed = lostValueParse(seven);
    expect(await buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), fakeSeam())).toEqual({ omitted: "over_budget" });
    const six = lostValueParse(seven.slice(0, 6));
    const result = await buildLostValueCrops(file(PLAIN_PDF), six, packetOf(six), fakeSeam());
    expect("images" in result && result.images).toHaveLength(6);
  });

  it("omits every image when one crop is over 64 KB", async () => {
    const parsed = lostValueParse(ROWS);
    const seam = fakeSeam({ png: pagePng(1190, 1684, "noise") });
    seam.render.mockResolvedValue({ png: pagePng(1190, 1684, "noise"), width: 1190, height: 1684 });
    expect(await buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), seam)).toEqual({ omitted: "over_budget" });
  });

  it("omits every image when the crops add up to more than 256 KB", async () => {
    const noisy = async (rows: number) => {
      const parsed = lostValueParse(Array.from({ length: rows }, (_, i) => ({ label: `Field ${String.fromCharCode(65 + i)}` })));
      const seam = fakeSeam();
      seam.render.mockResolvedValue({ png: pagePng(714, 1010, "noise"), width: 714, height: 1010 });
      return buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), seam);
    };
    const four = await noisy(4);
    expect("images" in four && four.images).toHaveLength(4);
    expect(await noisy(5)).toEqual({ omitted: "over_budget" });
  });

  // Review MINOR-a: every page's full 300-dpi render was kept until the end, on any number of pages.
  it("renders each page once, in page order, and sends none when lost rows span more than two pages", async () => {
    const pages = (count: number) => {
      const parsed = lostValueParse(ROWS);
      const first = parsed.result.pages[0]!;
      const all = Array.from({ length: count }, (_, i) => ({ ...first, pageNum: i + 1 }));
      const text = all.map((page) => page.text).join("\n\f");
      return { ...parsed, text, pageCount: count, result: { ...parsed.result, text, totalPages: count, pages: all } } as ParsedDocument;
    };
    const two = pages(2);
    const seam = fakeSeam();
    const result = await buildLostValueCrops(file(PLAIN_PDF), two, packetOf(two), seam);
    expect("images" in result && result.images.map((image) => image.line)).toEqual(["p1:002", "p1:003", "p2:002", "p2:003"]);
    expect(seam.render.mock.calls.map((call) => (call as unknown[])[1])).toEqual([1, 2]);

    const three = pages(3);
    const capped = fakeSeam();
    expect(await buildLostValueCrops(file(PLAIN_PDF), three, packetOf(three), capped)).toEqual({ omitted: "over_budget" });
    expect(capped.render).not.toHaveBeenCalled();
  });

  it("finds no rect for a page whose axes scale differently", async () => {
    const parsed = lostValueParse(ROWS);
    const seam = fakeSeam();
    seam.render.mockResolvedValue({ png: pagePng(595, 900), width: 595, height: 900 });
    expect(await buildLostValueCrops(file(PLAIN_PDF), parsed, packetOf(parsed), seam)).toEqual({ images: [] });
  });
});

describe("ocrLostValueLine", () => {
  const parsed = lostValueParse(ROWS);
  const packet = packetOf(parsed);

  it("OCRs the re-made crop of the cited line and returns the items with the label anchor", async () => {
    const path = file(PLAIN_PDF);
    const rects = await lostValueRects(path, parsed, packet);
    const items = ocrRow(["Invoice date"], ["31.07.2026"]);
    const seam = fakeSeam({ ocr: async () => ({ ok: true, items }) });
    expect(await ocrLostValueLine(path, parsed, rects, "p1:003", seam)).toEqual({ ok: true, items, anchor: "Invoice date" });
    const [png] = seam.ocr.mock.calls[0]!;
    expect(pngSize(png)).toEqual({ width: 557, height: 18 });
  });

  it("is crop_unavailable for a line with no rect or a page that cannot be rendered", async () => {
    const path = file(PLAIN_PDF);
    const rects = await lostValueRects(path, parsed, packet);
    expect(await ocrLostValueLine(path, parsed, rects, "p1:001", fakeSeam())).toEqual({ ok: false, reason: "crop_unavailable" });
    const seam = fakeSeam();
    seam.render.mockRejectedValue(new Error("render failed"));
    expect(await ocrLostValueLine(path, parsed, rects, "p1:003", seam)).toEqual({ ok: false, reason: "crop_unavailable" });
    expect(seam.ocr).not.toHaveBeenCalled();
  });

  it("is ocr_unavailable when OCR fails, times out or throws", async () => {
    const path = file(PLAIN_PDF);
    const rects = await lostValueRects(path, parsed, packet);
    expect(await ocrLostValueLine(path, parsed, rects, "p1:003", fakeSeam())).toEqual({ ok: false, reason: "ocr_unavailable" });
    const throwing = fakeSeam({ ocr: async () => { throw new Error("tessdata download failed"); } });
    expect(await ocrLostValueLine(path, parsed, rects, "p1:003", throwing)).toEqual({ ok: false, reason: "ocr_unavailable" });
  });
});
