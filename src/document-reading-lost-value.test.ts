import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import {
  locateLostValueRects,
  matchLostValue,
  normalizeLostValueText,
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
  const google = (header: string) => lines(header, `Arve number ¦ ${DOTS}`, `Arve kuupäev ¦ ${DOTS} ¦ Kogusumma (EUR) ¦ 13,60 €`);

  it("is true for the value printed right after a lost cell's own label on a line that is not lost", () => {
    expect(printedUnderLostLabel(google("Arve number: 5528682310"), "p1:001", "5528682310")).toBe(true);
    expect(printedUnderLostLabel(google("Arve number # 5528682310 ¦ Ireland"), "p1:001", "5528682310")).toBe(true);
    expect(printedUnderLostLabel(lines("Invoice number: 77", `Invoice number: ¦ ${DOTS}`), "p1:001", "77")).toBe(true);
  });

  it("is false under another label, on a lost line, or with no lost line", () => {
    // The whole line prefix is the label: a split cell or a one-word label does not count.
    expect(printedUnderLostLabel(google("Originaal ¦ Arve number: 5528682310"), "p1:001", "5528682310")).toBe(false);
    expect(printedUnderLostLabel(lines("Tellimus ¦ Nr 98765", `Nr ¦ ${DOTS}`), "p1:001", "98765")).toBe(false);
    expect(printedUnderLostLabel(lines("Nr 98765", `Nr ¦ ${DOTS}`), "p1:001", "98765")).toBe(false);
    expect(printedUnderLostLabel(google("Originaalarve number: 5528682310"), "p1:001", "5528682310")).toBe(false);
    expect(printedUnderLostLabel(google("Tellimuse number: 5528682310"), "p1:001", "5528682310")).toBe(false);
    expect(printedUnderLostLabel(google("Arve number: 5528682310"), "p1:001", "552868231")).toBe(false);
    expect(printedUnderLostLabel(google("Arve number: 5528682310"), "p1:002", "5528682310")).toBe(false);
    expect(printedUnderLostLabel(lines("Arve number: 5528682310"), "p1:001", "5528682310")).toBe(false);
  });
});
