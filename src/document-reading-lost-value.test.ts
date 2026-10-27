import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import {
  leaderRowBand,
  leaderRowIsBlank,
  locateLostValueRects,
  matchLostValue,
  normalizeLostValueText,
  ocrItemsOnPage,
  parseLostValueReading,
  pdfPageBoxRefusal,
  printedUnderLostLabel,
  rectToPixels,
  LOST_VALUE_LABEL_PAD_PT,
  type GeometryItem,
  type LostValuePage,
  type OcrItem,
} from "./document-reading-lost-value.js";
import { buildLeaderOverlayPdf } from "./__fixtures__/document-reading/leader-overlay-pdf.js";
import type { PacketLine } from "./document-reading-packet.js";

const DOTS = "....................";

function ocr(...parts: Array<[string, number?]>): OcrItem[] {
  let x = 0;
  return parts.map(([text, confidence = 0.95]) => {
    const item = { text, x, y: 10, width: text.length * 6, height: 12, confidence };
    x += item.width + 8;
    return item;
  });
}

describe("normalizeLostValueText", () => {
  it("applies NFKC, folds dashes, turns leader runs and the column glyph into spaces, collapses whitespace", () => {
    expect(normalizeLostValueText("  Invoice number.......1234–5678 ¦ x ")).toBe("Invoice number 1234-5678 x");
    expect(normalizeLostValueText("ＡＢ１２")).toBe("AB12");
  });
});

describe("matchLostValue: invoice_number", () => {
  const anchor = "Invoice number";
  const cases: Array<[string, string, OcrItem[], string]> = [
    ["accepts the single equal candidate", "1234567890", ocr(["Invoice number"], [DOTS, 0.5], ["1234567890"]), "image_ocr_agreed"],
    ["accepts a value glued to the leader dots", "1234567890", ocr(["Invoice number.......................1234567890", 0.93]), "image_ocr_agreed"],
    ["accepts a leading # and a trailing comma", "XY-2026-77", ocr(["Invoice number"], ["#XY-2026-77,"]), "image_ocr_agreed"],
    // Review MAJOR-2: a trailing `.` `-` `/` `_` is a valid number character, never stripped on agreement.
    ["holds a trailing period OCR saw and the client did not", "2345", ocr(["Invoice number"], ["2345."]), "ocr_ambiguous"],
    ["holds a trailing dash OCR saw and the client did not", "XY-2026-77", ocr(["Invoice number"], ["#XY-2026-77-"]), "ocr_ambiguous"],
    ["holds a trailing slash the client added", "2345/", ocr(["Invoice number"], ["2345"]), "ocr_ambiguous"],
    ["accepts a trailing period both read", "2345.", ocr(["Invoice number"], ["2345."]), "image_ocr_agreed"],
    ["holds when OCR read the dash as =", "1234-5678", ocr(["Invoice number"], ["1234=5678"]), "ocr_no_match"],
    ["holds on two candidates", "1234567890", ocr(["Invoice number"], ["1234567890"], ["9876543210"]), "ocr_ambiguous"],
    ["holds on a stray digit", "1234567890", ocr(["Invoice number"], ["1234567890"], ["4", 0.31]), "ocr_ambiguous"],
    ["holds on no candidate", "1234567890", ocr(["Invoice number"], [DOTS]), "ocr_no_match"],
    ["holds on a case difference", "ax-23", ocr(["Invoice number"], ["AX-23"]), "ocr_no_match"],
    ["holds at confidence 0.59", "1234567890", ocr(["Invoice number"], ["1234567890", 0.59]), "ocr_low_confidence"],
    ["accepts at confidence 0.60", "1234567890", ocr(["Invoice number"], ["1234567890", 0.6]), "image_ocr_agreed"],
    ["holds when the label is missing from OCR", "1234567890", ocr(["Invoice"], ["1234567890"]), "ocr_row_mismatch"],
    ["holds a non-canonical dash in printed", "1234–5678", ocr(["Invoice number"], ["1234-5678"]), "value_form_invalid"],
    ["holds a value with no digit", "ABCDEF", ocr(["Invoice number"], ["ABCDEF"]), "value_form_invalid"],
    ["holds a value with a space", "1234 5678", ocr(["Invoice number"], ["1234 5678"]), "value_form_invalid"],
    // Owner decision 2026-10-26: look-alike glyphs are not held; OCR must still read the same value.
    ["accepts look-alike glyphs both readers agree on", "A23l5", ocr(["Invoice number"], ["A23l5"]), "image_ocr_agreed"],
  ];
  it.each(cases)("%s", (_name, printed, items, status) => {
    expect(matchLostValue("invoice_number", printed, items, anchor).status).toBe(status);
  });

  it("returns the client's value, never OCR's", () => {
    expect(matchLostValue("invoice_number", "1234567890", ocr(["Invoice number"], ["1234567890"]), anchor))
      .toEqual({ status: "image_ocr_agreed", value: "1234567890" });
  });

  it("reads items in rows by vertical overlap, then left to right", () => {
    const items: OcrItem[] = [
      { text: "1234567890", x: 300, y: 11, width: 60, height: 12, confidence: 0.9 },
      { text: "number", x: 60, y: 9, width: 40, height: 14, confidence: 0.9 },
      { text: "Invoice", x: 5, y: 10, width: 40, height: 12, confidence: 0.9 },
    ];
    expect(matchLostValue("invoice_number", "1234567890", items, "Invoice number").status).toBe("image_ocr_agreed");
  });
});

describe("matchLostValue: invoice_date", () => {
  const anchor = "Invoice date";
  const cases: Array<[string, string, OcrItem[], string]> = [
    ["accepts the single equal date", "31. juuli 2026", ocr(["Invoice date"], [DOTS, 0.58], ["31. juuli 2026", 0.9]), "image_ocr_agreed"],
    ["accepts a numeric date", "31.07.2026", ocr(["Invoice date"], ["31.07.2026"]), "image_ocr_agreed"],
    ["holds when OCR read 31 as 3l", "31. juuli 2026", ocr(["Invoice date"], ["3l. juuli 2026"]), "ocr_no_match"],
    ["holds a different spelling of the same date", "31.07.2026", ocr(["Invoice date"], ["31. juuli 2026"]), "ocr_no_match"],
    ["holds a different date", "31. juuli 2026", ocr(["Invoice date"], ["30. juuli 2026"]), "ocr_no_match"],
    ["holds two dates", "31. juuli 2026", ocr(["Invoice date"], ["31. juuli 2026"], ["01.01.2020"]), "ocr_ambiguous"],
    ["holds a digit outside the date", "31. juuli 2026", ocr(["Invoice date"], ["31. juuli 2026"], ["7"]), "ocr_ambiguous"],
    ["holds no date", "31. juuli 2026", ocr(["Invoice date"], [DOTS]), "ocr_no_match"],
    ["holds a low-confidence date part", "31. juuli 2026", ocr(["Invoice date"], ["31."], ["juuli", 0.59], ["2026"]), "ocr_low_confidence"],
    ["holds when the label is missing", "31. juuli 2026", ocr([DOTS], ["31. juuli 2026"]), "ocr_row_mismatch"],
    ["holds an ambiguous slash date in printed", "01/02/2026", ocr(["Invoice date"], ["01/02/2026"]), "value_form_invalid"],
    ["holds a printed value that is not only a date", "31. juuli 2026 x", ocr(["Invoice date"], ["31. juuli 2026"]), "value_form_invalid"],
    ["holds an impossible date", "31.02.2026", ocr(["Invoice date"], ["31.02.2026"]), "value_form_invalid"],
    // Live 2026-10-26, Google invoices: Estonian month abbreviations, and OCR dropping the "ä" of "märts".
    ["accepts an abbreviated Estonian month", "28. veebr 2025", ocr(["Invoice date"], ["28. veebr 2025"]), "image_ocr_agreed"],
    ["accepts okt and dets", "31. dets 2025", ocr(["Invoice date"], ["31. dets 2025"]), "image_ocr_agreed"],
    ["accepts märts read by OCR as marts", "31. märts 2025", ocr(["Invoice date"], ["31. marts 2025"]), "image_ocr_agreed"],
    ["still holds marts on another day", "31. märts 2025", ocr(["Invoice date"], ["30. marts 2025"]), "ocr_no_match"],
    ["still holds another month whose letters differ", "31. märts 2025", ocr(["Invoice date"], ["31. mai 2025"]), "ocr_no_match"],
  ];
  it.each(cases)("%s", (_name, printed, items, status) => {
    expect(matchLostValue("invoice_date", printed, items, anchor).status).toBe(status);
  });

  it("reads the Estonian abbreviations as their months", () => {
    expect(matchLostValue("invoice_date", "31. okt 2025", ocr(["Arve kuupäev"], ["31. okt 2025"]), "Arve kuupäev")).toEqual({ status: "image_ocr_agreed", value: "2025-10-31" });
    expect(matchLostValue("invoice_date", "31. märts 2026", ocr(["Arve kuupäev"], ["31. marts 2026"]), "Arve kuupäev")).toEqual({ status: "image_ocr_agreed", value: "2026-03-31" });
  });

  it("returns the ISO value of the client's date", () => {
    expect(matchLostValue("invoice_date", "31. juuli 2026", ocr(["Invoice date"], ["31. juuli 2026"]), anchor))
      .toEqual({ status: "image_ocr_agreed", value: "2026-07-31" });
  });

  it("holds a candidate whose row keeps a letter-only part beside it (a cut-short value)", () => {
    expect(matchLostValue("invoice_number", "0042", ocr(["Invoice number"], ["INV"], ["0042"]), "Invoice number").status).toBe("ocr_ambiguous");
    expect(matchLostValue("invoice_number", "0042", ocr(["Invoice number"], ["0042"], ["B"]), "Invoice number").status).toBe("ocr_ambiguous");
    expect(matchLostValue("invoice_date", "31.07.2026", ocr(["Invoice date"], ["31.07.2026"], ["approx"]), "Invoice date").status).toBe("ocr_ambiguous");
    // Leaders and punctuation around the label and the value are fine.
    expect(matchLostValue("invoice_number", "0042", ocr(["Invoice number:"], [DOTS, 0.4], ["#0042;"]), "Invoice number").status).toBe("image_ocr_agreed");
  });

  it("counts a confidence outside 0–1 (NaN, a 0–100 scale) as none", () => {
    for (const confidence of [Number.NaN, 95, -1]) {
      expect(matchLostValue("invoice_number", "1234567890", ocr(["Invoice number"], ["1234567890", confidence]), "Invoice number").status)
        .toBe("ocr_low_confidence");
    }
  });

  it("holds when the label is on another OCR row than the value", () => {
    const label = { text: "Invoice date", x: 4, y: 0, width: 72, height: 12, confidence: 0.95 };
    const value = (y: number) => ({ text: "31.07.2026", x: 90, y, width: 60, height: 12, confidence: 0.95 });
    expect(matchLostValue("invoice_date", "31.07.2026", [label, value(20)], "Invoice date").status).toBe("ocr_row_mismatch");
    expect(matchLostValue("invoice_number", "1234567890", [label, { ...value(20), text: "1234567890" }], "Invoice date").status).toBe("ocr_row_mismatch");
    expect(matchLostValue("invoice_date", "31.07.2026", [label, value(2)], "Invoice date").status).toBe("image_ocr_agreed");
  });

  it("does not fold diacritics in the label anchor", () => {
    const items = ocr(["Arve kuupaev"], ["31. juuli 2026"]);
    expect(matchLostValue("invoice_date", "31. juuli 2026", items, "Arve kuupäev").status).toBe("ocr_row_mismatch");
    expect(matchLostValue("invoice_date", "31. juuli 2026", ocr(["Arve kuupäev"], ["31. juuli 2026"]), "Arve kuupäev").status)
      .toBe("image_ocr_agreed");
  });
});

describe("parseLostValueReading", () => {
  it("accepts one or both fields as an object or a JSON string", () => {
    const value = { invoice_date: { line: "p1:011", printed: "31. juuli 2026" } };
    expect(parseLostValueReading(value)).toEqual({ ok: true, value });
    expect(parseLostValueReading(JSON.stringify(value))).toEqual({ ok: true, value });
  });

  it.each([
    ["an unknown field", { gross: { line: "p1:001", printed: "1" } }],
    ["an extra key", { invoice_number: { line: "p1:001", printed: "1", why: "x" } }],
    ["a bad line ref", { invoice_number: { line: "1", printed: "1" } }],
    ["an empty printed", { invoice_number: { line: "p1:001", printed: "" } }],
    ["a printed over 64 chars", { invoice_number: { line: "p1:001", printed: "1".repeat(65) } }],
    ["a control character", { invoice_number: { line: "p1:001", printed: "12\n34" } }],
    ["a sandbox marker", { invoice_number: { line: "p1:001", printed: "<<UNTRUSTED_OCR_START:ab>>12" } }],
    ["the packet_digest rev 1 had", { packet_digest: "a".repeat(64) }],
    ["not an object", "[1]"],
  ])("refuses %s", (_name, input) => {
    expect(parseLostValueReading(input)).toEqual({ ok: false, code: "lost_value_reading_invalid" });
  });
});

// Geometry of the synthetic `full` fixture as liteparse reports it.
function fullPage(extra: GeometryItem[] = []): LostValuePage {
  const rows: Array<[string, number]> = [["Invoice number", 274.2], ["Invoice date", 287.7], ["Billing ID", 301.2]];
  const items: GeometryItem[] = [];
  for (const [label, y] of rows) {
    items.push({ text: label, x: 48, y, width: label.length * 4, height: 9.64 });
    items.push({ text: DOTS, x: 175.77, y, width: 60.09, height: 9.64 });
  }
  return { pageNum: 1, width: 595, height: 842, items: [...items, ...extra] };
}

function lines(...texts: string[]): PacketLine[] {
  return texts.map((text, i) => ({ id: `p1:${String(i + 1).padStart(3, "0")}`, page: 1, n: i + 1, text }));
}

const FULL_LINES = lines("Synthetic", `Invoice number ¦ ${DOTS}`, `Invoice date ¦ ${DOTS}`, `Billing ID ¦ ${DOTS}`);

describe("locateLostValueRects", () => {
  it("crops each lost row from the label's left edge to the page edge, band ± 0.4·h", () => {
    const rects = locateLostValueRects({ lines: FULL_LINES }, [fullPage()], null);
    expect([...rects.keys()]).toEqual(["p1:002", "p1:003", "p1:004"]);
    const date = rects.get("p1:003")!;
    expect(date.anchor).toBe("Invoice date");
    expect(date.x).toBeCloseTo(48 - LOST_VALUE_LABEL_PAD_PT, 5);
    expect(date.x + date.width).toBeCloseTo(595, 5);
    expect(date.y).toBeCloseTo(287.7 - 0.4 * 9.64, 5);
    expect(date.height).toBeCloseTo(9.64 * 1.8, 5);
  });

  it("stops the crop 2 pt before the next item right of the leader", () => {
    const page = fullPage([{ text: "Total", x: 400, y: 287.7, width: 20, height: 9.64 }]);
    const rects = locateLostValueRects({ lines: lines(`Invoice date ¦ ${DOTS} ¦ Total`) }, [page], null);
    const rect = rects.get("p1:001")!;
    expect(rect.x + rect.width).toBeCloseTo(398, 5);
  });

  it("refuses every line when the PDF boxes are refused", () => {
    expect(locateLostValueRects({ lines: FULL_LINES }, [fullPage()], "rotated_page").size).toBe(0);
  });

  it("refuses a row with no label (no_label)", () => {
    const page = fullPage();
    const noLabel = { ...page, items: page.items.filter((item) => item.text === DOTS) };
    expect(locateLostValueRects({ lines: lines(DOTS, DOTS, DOTS) }, [noLabel], null).size).toBe(0);
  });

  it("refuses a label with no letter", () => {
    const page: LostValuePage = { pageNum: 1, width: 595, height: 842, items: [
      { text: "12", x: 48, y: 100, width: 10, height: 9 },
      { text: DOTS, x: 175, y: 100, width: 60, height: 9 },
    ] };
    expect(locateLostValueRects({ lines: lines(`12 ¦ ${DOTS}`) }, [page], null).size).toBe(0);
  });

  it("refuses a row with two pure-leader items", () => {
    // Same band: both leaders yield the row. Offset band: only the first leader's row matches the line.
    for (const second of [{ y: 287.7, height: 9.64 }, { y: 284, height: 8 }]) {
      const page = fullPage([{ text: DOTS, x: 300, width: 60, ...second }]);
      const rects = locateLostValueRects({ lines: lines(`Invoice date ¦ ${DOTS} ¦ ${DOTS}`) }, [page], null);
      expect(rects.size).toBe(0);
    }
  });

  it("refuses a line whose text appears twice on the page", () => {
    const rects = locateLostValueRects({ lines: lines(`Invoice date ¦ ${DOTS}`, `Invoice date ¦ ${DOTS}`) }, [fullPage()], null);
    expect(rects.size).toBe(0);
  });

  it("refuses a rotated row", () => {
    const page = fullPage();
    const rotated = { ...page, items: page.items.map((item) => ({ ...item, rotation: 90 })) };
    expect(locateLostValueRects({ lines: FULL_LINES }, [rotated], null).size).toBe(0);
  });

  it("refuses when the packet line does not match a row signature", () => {
    expect(locateLostValueRects({ lines: lines(`Invoice dates ¦ ${DOTS}`) }, [fullPage()], null).size).toBe(0);
  });

  it("refuses a missing page", () => {
    expect(locateLostValueRects({ lines: FULL_LINES }, [], null).size).toBe(0);
  });
});

describe("rectToPixels", () => {
  it("scales by the image/page ratio", () => {
    const px = rectToPixels({ x: 72, y: 36, width: 144, height: 72 }, { width: 595, height: 842 }, { width: 2479, height: 3508 })!;
    expect(px.x).toBeCloseTo(72 * 2479 / 595, 6);
    expect(px.y).toBeCloseTo(36 * 3508 / 842, 6);
    expect(px.width).toBeCloseTo(144 * 2479 / 595, 6);
    expect(px.height).toBeCloseTo(72 * 3508 / 842, 6);
  });

  it("refuses axes that scale more than 1% apart", () => {
    expect(rectToPixels({ x: 0, y: 0, width: 1, height: 1 }, { width: 100, height: 100 }, { width: 100, height: 102 })).toBeNull();
    expect(rectToPixels({ x: 0, y: 0, width: 1, height: 1 }, { width: 100, height: 100 }, { width: 100, height: 100.9 })).not.toBeNull();
    expect(rectToPixels({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 100 }, { width: 100, height: 100 })).toBeNull();
  });
});

function rawPdf(page: string, extra = ""): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page ${page} >>\nendobj\n${extra}%%EOF\n`, "latin1");
}

function objStmPdf(body: string, filter = "/FlateDecode"): Buffer {
  const data = filter === "/FlateDecode" ? deflateSync(Buffer.from(body, "latin1")) : Buffer.from(body, "latin1");
  return Buffer.concat([
    Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter ${filter} /Length ${data.length} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

describe("pdfPageBoxRefusal", () => {
  it("passes the generated fixture and refuses its offset and rotated forms", async () => {
    expect(await pdfPageBoxRefusal(buildLeaderOverlayPdf({ variant: "full" }))).toBeNull();
    expect(await pdfPageBoxRefusal(buildLeaderOverlayPdf({ mediaBox: [100, 200, 695, 1042] }))).toBe("box_origin_not_zero");
    expect(await pdfPageBoxRefusal(buildLeaderOverlayPdf({ rotate: 90 }))).toBe("rotated_page");
    expect(await pdfPageBoxRefusal(buildLeaderOverlayPdf({ rotate: 360 }))).toBeNull();
  });

  it.each([
    ["a CropBox equal to the MediaBox", "/MediaBox [0 0 595 842] /CropBox [0 0 595.0 842]", null],
    ["a CropBox that differs", "/MediaBox [0 0 595 842] /CropBox [10 10 585 832]", "crop_box_differs"],
    ["an indirect CropBox", "/MediaBox [0 0 595 842] /CropBox 7 0 R", "crop_box_unreadable"],
    ["an indirect MediaBox", "/MediaBox 7 0 R", "media_box_unreadable"],
    ["no MediaBox", "/Contents 5 0 R", "media_box_unreadable"],
    ["a UserUnit", "/MediaBox [0 0 595 842] /UserUnit 2", "user_unit"],
    ["an indirect Rotate", "/MediaBox [0 0 595 842] /Rotate 9 0 R", "rotate_unreadable"],
    ["a negative Rotate", "/MediaBox [0 0 595 842] /Rotate -90", "rotated_page"],
  ])("handles %s", async (_name, page, reason) => {
    expect(await pdfPageBoxRefusal(rawPdf(page))).toBe(reason);
  });

  it("refuses an encrypted PDF", async () => {
    expect(await pdfPageBoxRefusal(rawPdf("/MediaBox [0 0 595 842]", "trailer << /Encrypt 9 0 R >>\n"))).toBe("encrypted");
  });

  it("reads page dictionaries inside Flate object streams", async () => {
    expect(await pdfPageBoxRefusal(objStmPdf("3 0 << /Type /Page /MediaBox [0 0 595 842] >>"))).toBeNull();
    expect(await pdfPageBoxRefusal(objStmPdf("3 0 << /Type /Page /MediaBox [0 0 595 842] /Rotate 90 >>"))).toBe("rotated_page");
  });

  it("refuses an object stream it cannot read", async () => {
    expect(await pdfPageBoxRefusal(objStmPdf("3 0 << /MediaBox [0 0 595 842] >>", "/LZWDecode"))).toBe("object_stream_unreadable");
  });

  const stream = (dict: string, body: Buffer) => Buffer.concat([
    Buffer.from(`1 0 obj\n<< ${dict} /Filter /FlateDecode /Length ${body.length} >>\nstream\n`, "latin1"), body, Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);

  it("decodes name escapes before matching", async () => {
    expect(await pdfPageBoxRefusal(rawPdf("/MediaBox [0 0 595 842] /Rot#61te 90"))).toBe("rotated_page");
    expect(await pdfPageBoxRefusal(rawPdf("/MediaBox [0 0 595 842] /Crop#42ox [10 10 585 832]"))).toBe("crop_box_differs");
    const escapedType = stream("/Type /Obj#53tm /N 1 /First 4", deflateSync(Buffer.from("3 0 << /MediaBox [0 0 595 842] /Rotate 90 >>", "latin1")));
    expect(await pdfPageBoxRefusal(Buffer.concat([Buffer.from("%PDF-1.5\n"), escapedType, Buffer.from("%%EOF\n")]))).toBe("rotated_page");
  });

  it("reads an object stream by its /N and /First even without its /Type", async () => {
    const untyped = stream("/N 1 /First 4", deflateSync(Buffer.from("3 0 << /MediaBox [0 0 595 842] /Rotate 90 >>", "latin1")));
    expect(await pdfPageBoxRefusal(Buffer.concat([Buffer.from("%PDF-1.5\n"), untyped, Buffer.from("%%EOF\n")]))).toBe("rotated_page");
  });

  it("still sees an object stream whose dictionary hides an ` obj` inside a string", async () => {
    const tricked = stream("/Type /ObjStm /N 1 /First 4 /X (x obj)", deflateSync(Buffer.from("3 0 << /MediaBox [0 0 595 842] /Rotate 90 >>", "latin1")));
    expect(await pdfPageBoxRefusal(Buffer.concat([Buffer.from("%PDF-1.5\n"), tricked, Buffer.from("%%EOF\n")]))).toBe("rotated_page");
  });

  it("refuses past 256 object streams or 32 MB of them inflated, instead of holding them all", async () => {
    const small = stream("/Type /ObjStm /N 1 /First 4", deflateSync(Buffer.from("3 0 << /MediaBox [0 0 595 842] >>", "latin1")));
    const many = (count: number, part: Buffer) => Buffer.concat([Buffer.from("%PDF-1.5\n"), ...Array.from({ length: count }, () => part), Buffer.from("%%EOF\n")]);
    expect(await pdfPageBoxRefusal(many(256, small))).toBeNull();
    expect(await pdfPageBoxRefusal(many(257, small))).toBe("object_stream_unreadable");
    const big = stream("/Type /ObjStm /N 1 /First 4", deflateSync(Buffer.alloc(12 * 1024 * 1024, 0x20)));
    expect(await pdfPageBoxRefusal(Buffer.concat([many(2, big), Buffer.from("1 0 obj << /MediaBox [0 0 595 842] >> endobj\n")]))).toBeNull();
    expect(await pdfPageBoxRefusal(many(3, big))).toBe("object_stream_unreadable");
  });

  // Review MAJOR-1: every `stream` keyword looked back unbounded for ` obj` (322 KB took 11 s, synchronously).
  it("stays linear on many `stream` keywords far from any object header, and refuses them", async () => {
    const body = "%PDF-1.4\n1 0 obj\n<< /MediaBox [0 0 595 842] >>\nendobj\n%" + "x".repeat(2000) + "\n" + "%stream\n".repeat(40_000);
    const started = Date.now();
    expect(await pdfPageBoxRefusal(Buffer.from(body, "latin1"))).toBe("object_stream_unreadable");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("refuses past 4096 `stream` keywords even when none is an object stream", async () => {
    const plain = (count: number) => Buffer.from("%PDF-1.4\n1 0 obj\n<< /MediaBox [0 0 595 842] >>\nendobj\n" +
      Array.from({ length: count }, (_, i) => `${i + 2} 0 obj\n<< /Length 1 >>\nstream\nx\nendstream\nendobj\n`).join(""), "latin1");
    expect(await pdfPageBoxRefusal(plain(4096))).toBeNull();
    expect(await pdfPageBoxRefusal(plain(4097))).toBe("object_stream_unreadable");
  });

  it("reads an object stream whose `stream` keyword ends in a lone CR", async () => {
    const data = deflateSync(Buffer.from("3 0 << /MediaBox [0 0 595 842] /Rotate 90 >>", "latin1"));
    const pdf = Buffer.concat([
      Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${data.length} >>\nstream\r`, "latin1"),
      data,
      Buffer.from("\nendstream\nendobj\n2 0 obj << /MediaBox [0 0 595 842] >> endobj\n%%EOF\n", "latin1"),
    ]);
    expect(await pdfPageBoxRefusal(pdf)).toBe("rotated_page");
  });

  it("compares many CropBoxes with many MediaBoxes in linear time", async () => {
    const n = 20_000;
    const boxes = Array.from({ length: n }, (_, i) => `/MediaBox [0 0 ${i + 1} 842]`).join("\n") + "\n" + `/CropBox [0 0 ${n} 842]\n`.repeat(n);
    const started = Date.now();
    expect(await pdfPageBoxRefusal(Buffer.from(`%PDF-1.4\n${boxes}`, "latin1"))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe("printedUnderLostLabel", () => {
  const under = (packetLines: PacketLine[], id: string, value: string) => printedUnderLostLabel({ lines: packetLines }, id, value);
  const google = (header: string) => lines(header, `Arve number ¦ ${DOTS}`, `Arve kuupäev ¦ ${DOTS} ¦ Kogusumma (EUR) ¦ 13,60 €`);

  it("is true for the value printed right after a lost cell's own label on a line that is not lost", () => {
    expect(under(google("Arve number: 5528682310"), "p1:001", "5528682310")).toBe(true);
    expect(under(google("Arve number # 5528682310 ¦ Ireland"), "p1:001", "5528682310")).toBe(true);
    expect(under(lines("Invoice number: 77", `Invoice number: ¦ ${DOTS}`), "p1:001", "77")).toBe(true);
  });

  it("is false under another label, on a lost line, or with no lost line", () => {
    // The whole line prefix is the label: a split cell or a one-word label does not count.
    expect(under(google("Originaal ¦ Arve number: 5528682310"), "p1:001", "5528682310")).toBe(false);
    expect(under(lines("Tellimus ¦ Nr 98765", `Nr ¦ ${DOTS}`), "p1:001", "98765")).toBe(false);
    expect(under(lines("Nr 98765", `Nr ¦ ${DOTS}`), "p1:001", "98765")).toBe(false);
    expect(under(google("Originaalarve number: 5528682310"), "p1:001", "5528682310")).toBe(false);
    expect(under(google("Tellimuse number: 5528682310"), "p1:001", "5528682310")).toBe(false);
    expect(under(google("Arve number: 5528682310"), "p1:001", "552868231")).toBe(false);
    expect(under(google("Arve number: 5528682310"), "p1:002", "5528682310")).toBe(false);
    expect(under(lines("Arve number: 5528682310"), "p1:001", "5528682310")).toBe(false);
  });
});

describe("leaderRowBand", () => {
  // A signature block: "Allkiri" and its leader on one row, the name printed to the right.
  const signPage = (extra: GeometryItem[] = []): LostValuePage => ({ pageNum: 1, width: 595, height: 842, items: [
    { text: "Allkiri", x: 48, y: 700, width: 28, height: 10 },
    { text: DOTS, x: 90, y: 700, width: 60, height: 10 },
    { text: "Mari Maasikas", x: 300, y: 701, width: 52, height: 10 },
    ...extra,
  ] });
  const SIGN_LINES = lines("Synthetic", `Allkiri ¦ ${DOTS} ¦ Mari Maasikas`);

  it("spans the page width from two row heights above the row to 0.4·h below, with the text-layer items and each cell's label item", () => {
    const band = leaderRowBand({ lines: SIGN_LINES }, "p1:002", signPage([
      { text: "IlnAdArab", x: 95, y: 698, width: 40, height: 14, ocr: true },
      { text: "Viitenumber 12345", x: 48, y: 650, width: 80, height: 10 },
    ]))!;
    expect(band).toMatchObject({ line: "p1:002", page: 1, height: 10, rowTop: 700, rowBottom: 711, labels: [{ word: "allkiri", native: 0 }] });
    expect(band.y0).toBeCloseTo(680, 5);
    expect(band.y1).toBeCloseTo(715, 5);
    expect(band.natives).toEqual([
      { x0: 48, x1: 76, y0: 700, y1: 710, words: ["allkiri"] },
      { x0: 90, x1: 150, y0: 700, y1: 710, words: [], leader: true },
      { x0: 300, x1: 352, y0: 701, y1: 711, words: ["mari", "maasikas"] },
    ]);
  });

  it("takes the row height from its tallest item, so short leader glyphs still reach a value above the rule", () => {
    const page: LostValuePage = { pageNum: 1, width: 595, height: 842, items: [
      { text: "Kuupäev", x: 48, y: 96, width: 40, height: 10 },
      { text: "____________", x: 100, y: 100, width: 80, height: 3 },
    ] };
    const band = leaderRowBand({ lines: lines(`Kuupäev ¦ ____________`) }, "p1:001", page)!;
    expect(band).toMatchObject({ height: 10, rowTop: 96, rowBottom: 106 });
    expect(band.y0).toBeCloseTo(76, 5);
  });

  it("splits a leader item at its leader run: only the text before it is label words", () => {
    const page = (text: string): LostValuePage => ({ pageNum: 1, width: 595, height: 842, items: [{ text, x: 260, y: 362, width: 136, height: 9 }] });
    const band = leaderRowBand({ lines: lines(`Võttis vastu: ${DOTS}`) }, "p1:001", page(`Võttis vastu: ${DOTS}`))!;
    expect(band.natives).toEqual([{ x0: 260, x1: 396, y0: 362, y1: 371, words: ["vottis", "vastu"], leader: true }]);
    expect(band.labels).toEqual([{ word: "vastu", native: 0 }]);
    // Text after the run is no label word: the cell's label ("… Tähtaeg") then ends in a word its label item lacks.
    const after = `Võttis vastu: ${DOTS} Tähtaeg`;
    expect(leaderRowBand({ lines: lines(after) }, "p1:001", page(after))).toBeUndefined();
  });

  it("binds each lost cell to the label item right before its own leader, never a later word that ends the same", () => {
    const page: LostValuePage = { pageNum: 1, width: 595, height: 842, items: [
      { text: "Allkiri", x: 48, y: 700, width: 28, height: 10 },
      { text: DOTS, x: 90, y: 700, width: 60, height: 10 },
      { text: "Kuupäev", x: 160, y: 700, width: 30, height: 10 },
      { text: DOTS, x: 200, y: 700, width: 60, height: 10 },
      { text: "Trüki kuupäev", x: 300, y: 700, width: 50, height: 10 },
    ] };
    const band = leaderRowBand({ lines: lines(`Allkiri ¦ ${DOTS} ¦ Kuupäev ¦ ${DOTS} ¦ Trüki kuupäev`) }, "p1:001", page)!;
    expect(band.labels).toEqual([{ word: "allkiri", native: 0 }, { word: "kuupaev", native: 2 }]);
  });

  it("binds a lost cell to its own leader run, not an earlier leader whose label ends in the same word", () => {
    // Only the second leader is lost (the first is followed by a date); its label is "Kuupäev", never "Trüki kuupäev".
    const page: LostValuePage = { pageNum: 1, width: 595, height: 842, items: [
      { text: `Trüki kuupäev ${DOTS} 12.03.2026`, x: 48, y: 700, width: 180, height: 10 },
      { text: "Kuupäev", x: 240, y: 700, width: 30, height: 10 },
      { text: DOTS, x: 280, y: 700, width: 60, height: 10 },
    ] };
    const text = `Trüki kuupäev ${DOTS} 12.03.2026 ¦ Kuupäev ¦ ${DOTS}`;
    const band = leaderRowBand({ lines: lines(text) }, "p1:001", page)!;
    expect(band.labels).toEqual([{ word: "kuupaev", native: 1 }]);
    expect(leaderRowIsBlank([{ text: "Trüki kuupäev", x: 48, y: 700, width: 50, height: 10, confidence: 0.9 }], band)).toBe(false);
  });

  it("refuses a lost run that is not its item's first: the item's label text belongs to the earlier run", () => {
    const text = `Kuupäev ${DOTS} 12,40 Kuupäev ${DOTS}`;
    const page: LostValuePage = { pageNum: 1, width: 595, height: 842, items: [{ text, x: 48, y: 700, width: 300, height: 10 }] };
    expect(leaderRowBand({ lines: lines(text) }, "p1:001", page)).toBeUndefined();
  });

  it("refuses a row whose items do not hold the line's leader runs one for one", () => {
    // One run in the line split over two items: which item holds the lost run is unknown.
    const page: LostValuePage = { pageNum: 1, width: 595, height: 842, items: [
      { text: `Kuupäev ${DOTS}`, x: 48, y: 700, width: 90, height: 10 },
      { text: DOTS, x: 138, y: 700, width: 60, height: 10 },
    ] };
    expect(leaderRowBand({ lines: lines(`Kuupäev ${DOTS}${DOTS}`) }, "p1:001", page)).toBeUndefined();
  });

  it("refuses a line printed twice on the page, a rotated row, a missing row, another page and two rows of the same text", () => {
    expect(leaderRowBand({ lines: lines(`Allkiri ¦ ${DOTS} ¦ Mari Maasikas`, `Allkiri ¦ ${DOTS} ¦ Mari Maasikas`) }, "p1:001", signPage())).toBeUndefined();
    const page = signPage();
    expect(leaderRowBand({ lines: SIGN_LINES }, "p1:002", { ...page, items: page.items.map((item) => ({ ...item, rotation: 90 })) })).toBeUndefined();
    expect(leaderRowBand({ lines: lines(`Kuupäev ¦ ${DOTS}`) }, "p1:001", page)).toBeUndefined();
    expect(leaderRowBand({ lines: SIGN_LINES }, "p1:002", { ...page, pageNum: 2 })).toBeUndefined();
    // The same row printed again lower down, with one packet line: which row is which is unknown.
    const twice = signPage([
      { text: "Allkiri", x: 48, y: 760, width: 28, height: 10 },
      { text: DOTS, x: 90, y: 760, width: 60, height: 10 },
      { text: "Mari Maasikas", x: 300, y: 761, width: 52, height: 10 },
    ]);
    expect(leaderRowBand({ lines: SIGN_LINES }, "p1:002", twice)).toBeUndefined();
  });

  it("refuses a lost cell whose label has no word of two characters, or no label item before its leader", () => {
    const page = (label: string): LostValuePage => ({ pageNum: 1, width: 595, height: 842, items: [
      { text: label, x: 48, y: 700, width: 8, height: 10 },
      { text: DOTS, x: 90, y: 700, width: 60, height: 10 },
    ] });
    expect(leaderRowBand({ lines: lines(`A: ¦ ${DOTS}`) }, "p1:001", page("A:"))).toBeUndefined();
    // The label is to the right of the leader: no item precedes it.
    const after: LostValuePage = { pageNum: 1, width: 595, height: 842, items: [
      { text: DOTS, x: 48, y: 700, width: 60, height: 10 },
      { text: "Allkiri", x: 120, y: 700, width: 28, height: 10 },
    ] };
    expect(leaderRowBand({ lines: lines(`${DOTS} ¦ Allkiri`) }, "p1:001", after)).toBeUndefined();
  });

  it("does not take OCR items as the row", () => {
    const page = signPage();
    expect(leaderRowBand({ lines: SIGN_LINES }, "p1:002", { ...page, items: page.items.map((item) => ({ ...item, ocr: true })) })).toBeUndefined();
  });
});

describe("leaderRowIsBlank", () => {
  // Page points. Row: "Allkiri" 48–76, leader 90–150, name 300–352, y 700–710; a due date printed at 400–440.
  const native = (x0: number, x1: number, words: string[], extra: { leader?: true; y0?: number } = {}) =>
    ({ x0, x1, y0: extra.y0 ?? 700, y1: (extra.y0 ?? 700) + 10, words, ...(extra.leader ? { leader: extra.leader } : {}) });
  const band = {
    height: 10,
    rowTop: 700,
    rowBottom: 710,
    labels: [{ word: "allkiri", native: 0 }],
    natives: [native(48, 76, ["allkiri"]), native(90, 150, [], { leader: true }), native(300, 352, ["mari", "maasikas"]), native(400, 440, ["12.03.2026"])],
  };
  const at = (text: string, x: number, y = 700, width = 30, height = 10, confidence = 0.9): OcrItem => ({ text, x, y, width, height, confidence });
  const label = at("Allkiri", 48, 700, 28);

  it("is true when OCR read the label and only text-layer words, marks on printed text, and dot smudges", () => {
    expect(leaderRowIsBlank([label, at("Mari", 300, 701, 20), at("Maasikas", 322, 701, 30)], band)).toBe(true);
    // A script-font name or scribble on the printed name; the dot row read as a flat, unsure word; leader glyphs only.
    expect(leaderRowIsBlank([label, at("IlnAdArab", 310, 704, 30, 4)], band)).toBe(true);
    expect(leaderRowIsBlank([label, at("uues", 92, 708, 56, 1.5, 0.3), at(DOTS, 90, 706, 60, 3), at("—", 330, 703, 4)], band)).toBe(true);
    expect(leaderRowIsBlank([at("ALLKIRI:", 48, 700, 28)], band)).toBe(true);
    // `I` and `|` compare as `l`.
    expect(leaderRowIsBlank([at("AlIKiri", 48, 700, 28)], band)).toBe(true);
    expect(leaderRowIsBlank([label, at("12.03.2026", 400)], band)).toBe(true);
  });

  it("is false when OCR did not read the label word on its own label item on the row", () => {
    expect(leaderRowIsBlank([at("Mari", 300, 701, 20)], band)).toBe(false);
    expect(leaderRowIsBlank([], band)).toBe(false);
    // "Allkiri" read only above the row (another line) is no evidence for this row.
    const above = { ...band, natives: [...band.natives, native(48, 76, ["allkiri"], { y0: 682 })] };
    expect(leaderRowIsBlank([at("Allkiri", 48, 682, 28)], above)).toBe(false);
  });

  it("needs each lost cell's own label: a read label, or the same word elsewhere, does not clear another leader", () => {
    const two = {
      height: 10,
      rowTop: 700,
      rowBottom: 710,
      labels: [{ word: "allkiri", native: 0 }, { word: "kuupaev", native: 2 }],
      natives: [native(48, 76, ["allkiri"]), native(90, 150, [], { leader: true }), native(160, 190, ["kuupaev"]), native(200, 260, [], { leader: true }),
        native(300, 350, ["truki", "kuupaev"])],
    };
    expect(leaderRowIsBlank([label], two)).toBe(false);
    expect(leaderRowIsBlank([label, at("Trüki kuupäev", 300, 700, 50)], two)).toBe(false);
    expect(leaderRowIsBlank([label, at("Kuupäev", 160, 700, 30)], two)).toBe(true);
  });

  it("is false for a value over the leader, above the rule or over nothing, digit-free look-alikes and punctuation included", () => {
    for (const value of ["15.03.2026", "A-17", "13,60", "l0", "OO", "lSB", "AIO", "TT", "numberlO", "Mart", "]", "!!", "/", "%"]) {
      expect(leaderRowIsBlank([label, at(value, 95)], band), `${value} over the leader`).toBe(false);
      expect(leaderRowIsBlank([label, at(value, 95, 686)], band), `${value} above the rule`).toBe(false);
      expect(leaderRowIsBlank([label, at(value, 200)], band), `${value} over nothing`).toBe(false);
    }
  });

  it("is false for a flat item over the leader that is sure of itself or has a digit", () => {
    expect(leaderRowIsBlank([label, at("AIO", 95, 707, 30, 1.5, 0.9)], band)).toBe(false);
    expect(leaderRowIsBlank([label, at("AIO", 95, 707, 30, 3, 0.3)], band)).toBe(false);
    expect(leaderRowIsBlank([label, at("10", 95, 707, 30, 1.5, 0.3)], band)).toBe(false);
  });

  it("is false when a value merges into the label's OCR item or reaches the leader from beside it", () => {
    // "Allkiri AIO" centred on the label, its box running onto the leader.
    expect(leaderRowIsBlank([at("Allkiri AIO", 48, 700, 80)], band)).toBe(false);
    // Centred within the label's slack, box over the leader.
    expect(leaderRowIsBlank([label, at("TT", 72, 700, 12)], band)).toBe(false);
    // A value just above the leader, the leader's x-span but not its rows: off the leader, judged as text by its host.
    const name = { ...band, natives: [...band.natives, native(90, 150, ["mari"], { y0: 688 })] };
    expect(leaderRowIsBlank([label, at("IlnAdArab", 95, 688, 50, 9)], name)).toBe(true);
    // A label and its leader in one item: where the run starts is unknown, so only its label words may be read on it.
    const combined = { ...band, labels: [{ word: "nr", native: 0 }], natives: [native(48, 88, ["nr"], { leader: true })] };
    expect(leaderRowIsBlank([at("Nr:", 48, 700, 16)], combined)).toBe(true);
    expect(leaderRowIsBlank([at("Nr:", 48, 700, 16), at("AIO", 64, 700, 4)], combined)).toBe(false);
    expect(leaderRowIsBlank([at("Nr:", 48, 700, 16), at("/", 64, 700, 4)], combined)).toBe(false);
    // Narrower than the slack, so no box overlap: being hosted on the leader item is enough.
    expect(leaderRowIsBlank([at("Nr:", 48, 700, 16), at("AIO", 66, 700, 1)], combined)).toBe(false);
  });

  it("is false for a digit word on printed text that is not that text's own word", () => {
    for (const value of ["15.03.2026", "l0", "OO"]) {
      expect(leaderRowIsBlank([label, at(value, 310, 704, 30, 4)], band), value).toBe(false);
    }
  });

  it("matches text-layer words by position, count and punctuation", () => {
    // A printed due date does not explain the same date on the leader, nor a second read of it.
    expect(leaderRowIsBlank([label, at("12.03.2026", 400), at("12.03.2026", 95)], band)).toBe(false);
    expect(leaderRowIsBlank([label, at("12.03.2026", 400), at("12.03.2026", 405)], band)).toBe(false);
    const amount = { ...band, natives: [...band.natives.slice(0, 3), native(400, 440, ["1240"])] };
    expect(leaderRowIsBlank([label, at("12,40", 95)], amount)).toBe(false);
    expect(leaderRowIsBlank([label, at("12,40", 400)], amount)).toBe(false);
    // A previous row's printed number: a digit word just under it (within the slack) is not that number.
    const previous = { ...band, natives: [...band.natives, native(90, 150, ["1240"], { y0: 688 })] };
    expect(leaderRowIsBlank([label, at("1240", 100, 694, 30, 10)], previous)).toBe(false);
    expect(leaderRowIsBlank([label, at("1240", 100, 688, 30, 10)], previous)).toBe(true);
    // A number matching the previous row's item under its centre, its box reaching into the leader, holds; so does a sign.
    const above = { ...band, natives: [...band.natives, native(100, 140, ["12,40"], { y0: 688 })] };
    expect(leaderRowIsBlank([label, at("12,40", 102, 692, 35, 10)], above)).toBe(false);
    expect(leaderRowIsBlank([label, at("-12,40", 102, 692, 35, 10)], above)).toBe(false);
    expect(leaderRowIsBlank([label, at("12,40", 102, 688, 35, 10)], above)).toBe(true);
    const signed = { ...band, natives: [...band.natives.slice(0, 3), native(400, 440, ["12,40"])] };
    expect(leaderRowIsBlank([label, at("-12,40", 405)], signed)).toBe(false);
    // Off the leader too: a number's centre must lie inside its host, without the slack a word gets.
    const offLeader = { ...band, natives: [...band.natives, native(460, 500, ["1240"], { y0: 688 })] };
    expect(leaderRowIsBlank([label, at("1240", 465, 694, 30, 10)], offLeader)).toBe(false);
    expect(leaderRowIsBlank([label, at("1240", 465, 688, 30, 10)], offLeader)).toBe(true);
  });
});

describe("ocrItemsOnPage", () => {
  const rect = { x: 0, y: 680, width: 595, height: 34 };

  it("maps OCR units to page points by the crop's extent", () => {
    expect(ocrItemsOnPage([{ text: "Allkiri", x: 96, y: 40, width: 56, height: 20, confidence: 0.9 }], { width: 1190, height: 68 }, rect))
      .toEqual([{ text: "Allkiri", x: 48, y: 700, width: 28, height: 10, confidence: 0.9 }]);
  });

  it("maps nothing without an extent or when the axis scales differ by more than 3%", () => {
    expect(ocrItemsOnPage([], undefined, rect)).toBeUndefined();
    expect(ocrItemsOnPage([], { width: 0, height: 68 }, rect)).toBeUndefined();
    expect(ocrItemsOnPage([], { width: 1190, height: 64 }, rect)).toBeUndefined();
    expect(ocrItemsOnPage([], { width: 1190, height: 67 }, rect)).toEqual([]);
  });
});
