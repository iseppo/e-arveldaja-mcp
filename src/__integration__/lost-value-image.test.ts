import { describe, it, expect, beforeAll } from "vitest";
import { LiteParse, type ParsedPage, type TextItem } from "@llamaindex/liteparse";
import {
  buildLeaderOverlayPdf,
  LEADER_ROWS,
  type LeaderOverlayOptions,
} from "../__fixtures__/document-reading/leader-overlay-pdf.js";
import { cropPng } from "../png-crop.js";

// Real liteparse + Tesseract on generated PDFs (F-LITEPARSE-LEADER-OVERLAY,
// plan lost-value-image-ocr Step 1). First use downloads the eng+est
// traineddata (~31 MB); CI caches it. A download failure fails the suite —
// nothing here is skipped.
const SLOW = 180_000;
const DPI = 300;
/** Crop geometry fixed by Step 1: label left − 10 pt, leader band ± 0.4·h. */
const LABEL_PAD_PT = 10;
const BAND_PAD = 0.4;
const LEADER_TAIL = /^\.{4,}$/;

const textParser = new LiteParse({ ocrEnabled: false, outputFormat: "text", preserveVerySmallText: true, quiet: true });
const renderer = new LiteParse({ ocrEnabled: false, dpi: DPI, quiet: true });
const ocrParser = new LiteParse({ ocrEnabled: true, ocrLanguage: "eng+est", dpi: DPI, quiet: true, ocrFailureFatal: true });

async function firstPage(options: LeaderOverlayOptions): Promise<ParsedPage> {
  const result = await textParser.parse(buildLeaderOverlayPdf(options));
  return result.pages[0]!;
}

function rowItems(page: ParsedPage, label: string): { label: TextItem; leader: TextItem } {
  const labelItem = page.textItems.find(item => item.text === label);
  if (!labelItem) throw new Error(`no label item ${label}`);
  const leader = page.textItems.find(item => LEADER_TAIL.test(item.text) && Math.abs(item.y - labelItem.y) < 0.5);
  if (!leader) throw new Error(`no leader item on ${label}`);
  return { label: labelItem, leader };
}

describe("lost-value image path: liteparse tripwire and crop OCR", () => {
  let full: ParsedPage;

  beforeAll(async () => {
    full = await firstPage({ variant: "full" });
  }, SLOW);

  it("drops every leader-row value in full and no_label, keeps them in short_leader", async () => {
    const noLabel = await firstPage({ variant: "no_label" });
    const short = await firstPage({ variant: "short_leader" });
    for (const row of LEADER_ROWS) {
      expect(full.text).not.toContain(row.value);
      expect(noLabel.text).not.toContain(row.value);
      expect(short.text).toContain(row.value);
    }
    // The surviving leader tail sits on the label's row (the hold's source).
    for (const row of LEADER_ROWS) expect(() => rowItems(full, row.label)).not.toThrow();
  }, SLOW);

  it("places items and pixels the same on a page whose MediaBox origin is not zero", async () => {
    const offsetOptions: LeaderOverlayOptions = { mediaBox: [100, 200, 695, 1042] };
    const offset = await firstPage(offsetOptions);
    const round = (n: number) => Math.round(n * 100) / 100;
    const strip = (page: ParsedPage) => page.textItems.map(({ text, x, y, width, height }) =>
      ({ text, x: round(x), y: round(y), width: round(width), height: round(height) }));
    expect(strip(offset)).toEqual(strip(full));
    const [a] = await renderer.screenshot(buildLeaderOverlayPdf({ variant: "full" }), [1]);
    const [b] = await renderer.screenshot(buildLeaderOverlayPdf(offsetOptions), [1]);
    const band = { x: 0, y: 1000, width: a!.width, height: 400 };
    expect((await cropPng(b!.imageBuffer, band)).equals(await cropPng(a!.imageBuffer, band))).toBe(true);
  }, SLOW);

  it("recovers the lost date and number from a 300-dpi row crop OCR'd from a Buffer", async () => {
    const [shot] = await renderer.screenshot(buildLeaderOverlayPdf({ variant: "full" }), [1]);
    expect(shot!.width / full.width).toBeCloseTo(DPI / 72, 2);
    expect(shot!.height / full.height).toBeCloseTo(DPI / 72, 2);
    const scale = shot!.width / full.width;
    const expected: Array<[string, string]> = [["Invoice number", "1234567890"], ["Invoice date", "31. juuli 2026"]];
    for (const [label, value] of expected) {
      const { label: labelItem, leader } = rowItems(full, label);
      const pad = BAND_PAD * leader.height;
      const x0 = labelItem.x - LABEL_PAD_PT;
      const crop = await cropPng(shot!.imageBuffer, {
        x: x0 * scale,
        y: (leader.y - pad) * scale,
        width: (full.width - x0) * scale,
        height: (leader.height + 2 * pad) * scale,
      });
      const result = await ocrParser.parse(crop);
      const items = result.pages[0]?.textItems ?? [];
      const text = items.map(item => item.text).join(" ");
      expect(text).toContain(value);
      expect(text.replace(/\.{2,}/g, " ").replace(/\s+/g, "")).toContain(label.replace(/\s+/g, ""));
      const valueItem = items.find(item => item.text.includes(value));
      expect(valueItem?.confidence ?? 0).toBeGreaterThanOrEqual(0.6);
    }
  }, SLOW);
});
