import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLeaderOverlayPdf } from "../__fixtures__/document-reading/leader-overlay-pdf.js";
import { bandTop, fakeSeam, lostValueParse, ocrRow, pagePng, placedOcr, PLAIN_PDF, rowY } from "../__fixtures__/document-reading/lost-value.js";
import { buildReadingPacket } from "../document-reading-packet.js";
import { packetInputFromParse, readingPacketOf } from "../tools/document-text-hazards.js";
import type { ParsedDocument } from "../document-parser.js";
import { pngSize } from "../png-crop.js";
import { blankLeaderLines, buildLostValueCrops, lostValueRects, ocrLostValueLine } from "./lost-value-ocr.js";

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

describe("blankLeaderLines", () => {
  // Row 1 "Invoice date" (y 54), row 2 "Allkiri" (y 68); labels at x 48, leaders 175.77–235.86.
  const SIGNED = ["Seller OÜ", { label: "Invoice date" }, { label: "Allkiri" }, "Total 12,40"];
  const parsed = lostValueParse(SIGNED);
  const packet = packetOf(parsed);
  const dateBand = placedOcr(bandTop(1), ["Invoice date", 48, rowY(1), 48], ["31.07.2026", 180, rowY(1)]);
  const signBand = placedOcr(bandTop(2), ["Invoice date", 48, rowY(1), 48], ["Allkiri", 48, rowY(2), 28], ["uues", 180, rowY(2) + 8, 50, 1, 0.3]);
  // OCR answers per band in line order: the date row shows a date, the signature row only a dot smudge.
  const bands = () => {
    const answers = [dateBand, signBand];
    let call = 0;
    return fakeSeam({ ocr: (png) => answers[call++]!(png) });
  };

  it("proves the signature row blank from its full-width band, and not the date row", async () => {
    const path = file(PLAIN_PDF);
    const seam = bands();
    expect(await blankLeaderLines(path, parsed, packet, seam)).toEqual(["p1:003"]);
    expect(seam.render).toHaveBeenCalledTimes(1);
    expect(seam.ocr).toHaveBeenCalledTimes(2);
    // Full width, from two leader heights above the row (48.72) to 0.4·h below it (81.50), rounded outward (72 dpi).
    expect(pngSize(seam.ocr.mock.calls[1]![0])).toEqual({ width: 595, height: 82 - 48 });
  });

  it("proves nothing when OCR gives no extent, skipped the label, or read a value above the rule", async () => {
    const path = file(PLAIN_PDF);
    const noSize = fakeSeam({ ocr: async (png) => { const answer = await signBand(png); return answer.ok ? { ok: true, items: answer.items } : answer; } });
    expect(await blankLeaderLines(path, parsed, packet, noSize)).toEqual([]);
    const skipped = fakeSeam({ ocr: placedOcr(bandTop(2), ["Invoice date", 48, rowY(1), 48]) });
    expect(await blankLeaderLines(path, parsed, packet, skipped)).toEqual([]);
    const above = fakeSeam({ ocr: placedOcr(bandTop(2), ["Allkiri", 48, rowY(2), 28], ["MART", 190, rowY(2) - 9]) });
    expect(await blankLeaderLines(path, parsed, packet, above)).toEqual([]);
  });

  it("proves nothing without OCR, for a non-PDF, a refused page box or a failed render", async () => {
    const path = file(PLAIN_PDF);
    expect(await blankLeaderLines(path, parsed, packet, fakeSeam({ available: false }))).toEqual([]);
    expect(await blankLeaderLines(path, parsed, packet, fakeSeam())).toEqual([]);
    expect(await blankLeaderLines(file("not a pdf", "invoice.jpg"), parsed, packet, bands())).toEqual([]);
    const rotated = file(PLAIN_PDF.replace("/MediaBox [0 0 595 842]", "/MediaBox [0 0 595 842] /Rotate 90"));
    expect(await blankLeaderLines(rotated, parsed, packet, bands())).toEqual([]);
    const failing = bands();
    failing.render.mockRejectedValue(new Error("render failed"));
    expect(await blankLeaderLines(path, parsed, packet, failing)).toEqual([]);
    const throwing = fakeSeam({ ocr: async () => { throw new Error("tessdata download failed"); } });
    expect(await blankLeaderLines(path, parsed, packet, throwing)).toEqual([]);
  });

  it("proves nothing for more than six lost lines, and renders nothing", async () => {
    const seven = lostValueParse(Array.from({ length: 7 }, (_, index) => ({ label: `Allkiri ${index + 1}x` })));
    const seam = fakeSeam({ ocr: placedOcr(bandTop(0), ["Allkiri", 48, rowY(0), 28]) });
    expect(await blankLeaderLines(file(PLAIN_PDF), seven, packetOf(seven), seam)).toEqual([]);
    expect(seam.render).not.toHaveBeenCalled();
  });

  it("proves nothing for lost lines on more than two pages, and renders nothing", async () => {
    const one = lostValueParse([{ label: "Allkiri" }]);
    const page = one.result.pages[0]!;
    const pages = [1, 2, 3].map((pageNum) => ({ ...page, pageNum }));
    const three = { ...one, pageCount: 3, result: { ...one.result, totalPages: 3, pages } } as unknown as ParsedDocument;
    const threePacket = packetOf(three);
    expect(new Set(threePacket.lines.map((line) => line.page)).size).toBe(3);
    const seam = fakeSeam({ ocr: placedOcr(bandTop(0), ["Allkiri", 48, rowY(0), 28]) });
    expect(await blankLeaderLines(file(PLAIN_PDF), three, threePacket, seam)).toEqual([]);
    expect(seam.render).not.toHaveBeenCalled();
  });

  it("readingPacketOf never runs the proof (no render, no OCR) on a packet without the hold", async () => {
    const proof = vi.fn(async () => ["p1:001"]);
    const plain = lostValueParse(["Seller OÜ", "Invoice date 31.07.2026", "Total 12,40"]);
    const built = await readingPacketOf(plain, file(PLAIN_PDF), "a".repeat(64), "test", proof);
    expect(proof).not.toHaveBeenCalled();
    expect(built).toEqual(packetOf(plain));
  });

  it("readingPacketOf keeps the date row lost and drops only the proven signature row", async () => {
    const path = file(PLAIN_PDF);
    const built = await readingPacketOf(parsed, path, "a".repeat(64), "test", (source, doc, raw) => blankLeaderLines(source, doc, raw, bands()));
    expect(built.blank_leader_lines).toEqual(["p1:003"]);
    expect(built.holds.map((hold) => hold.code)).toContain("text_layer_value_lost");
    expect(built.packet_digest).toBe(packet.packet_digest);
    const signatureOnly = lostValueParse(["Seller OÜ", "Invoice date 31.07.2026", { label: "Allkiri" }]);
    const answer = fakeSeam({ ocr: placedOcr(bandTop(2), ["Allkiri", 48, rowY(2), 28]) });
    const cleared = await readingPacketOf(signatureOnly, path, "a".repeat(64), "test", (source, doc, raw) => blankLeaderLines(source, doc, raw, answer));
    expect(cleared.holds.map((hold) => hold.code)).not.toContain("text_layer_value_lost");
    const unproven = await readingPacketOf(signatureOnly, path, "a".repeat(64), "test", async () => { throw new Error("boom"); });
    expect(unproven.holds.map((hold) => hold.code)).toContain("text_layer_value_lost");
    const thrown = await readingPacketOf(signatureOnly, path, "a".repeat(64), "test", () => { throw new Error("sync boom"); });
    expect(thrown.holds.map((hold) => hold.code)).toContain("text_layer_value_lost");
  });
});
