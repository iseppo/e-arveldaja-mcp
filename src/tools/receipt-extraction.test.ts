import { describe, it, expect } from "vitest";
import type { Account } from "../types/api.js";
import {
  normalizeDate,
  extractAmounts,
  buildKeywordSuggestion,
  computeMinOcrConfidence,
  computeTermDays,
  detectReverseChargeFromText,
  extractPdfIdentifiers,
  findAccountByKeywords,
  findPurchaseArticleByKeywords,
  hasRecurringSimilarAmounts,
  normalizeCounterpartyName,
  looksLikePersonCounterparty,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  extractReceiptFieldsFromText,
  extractSupplierName,
} from "./receipt-extraction.js";

// ---------------------------------------------------------------------------
// normalizeDate
// ---------------------------------------------------------------------------

describe("normalizeDate", () => {
  it("passes through ISO dates unchanged", () => {
    expect(normalizeDate("2024-03-15")).toBe("2024-03-15");
  });

  it("parses DD.MM.YYYY", () => {
    expect(normalizeDate("15.03.2024")).toBe("2024-03-15");
  });

  it("parses single-digit day and month DD.MM.YYYY", () => {
    expect(normalizeDate("5.3.2024")).toBe("2024-03-05");
  });

  it("parses DD/MM/YYYY", () => {
    expect(normalizeDate("15/03/2024")).toBe("2024-03-15");
  });

  it("parses single-digit DD/MM/YYYY", () => {
    expect(normalizeDate("5/3/2024")).toBe("2024-03-05");
  });

  it("parses 2-digit year (00-69 → 2000s)", () => {
    expect(normalizeDate("15.03.24")).toBe("2024-03-15");
  });

  it("parses 2-digit year (70-99 → 1900s)", () => {
    expect(normalizeDate("15.03.99")).toBe("1999-03-15");
  });

  it("parses Estonian textual month with dot separator (day-first)", () => {
    // The Unicode-aware pattern requires "15. märts 2024" (with dot)
    expect(normalizeDate("15. märts 2024")).toBe("2024-03-15");
  });

  it("parses English textual month (day-first)", () => {
    expect(normalizeDate("15 March 2024")).toBe("2024-03-15");
  });

  it("parses English textual month (month-first)", () => {
    expect(normalizeDate("March 15 2024")).toBe("2024-03-15");
  });

  it("parses English textual month with comma", () => {
    expect(normalizeDate("March 15, 2024")).toBe("2024-03-15");
  });

  it("strips weekday prefix before parsing", () => {
    expect(normalizeDate("monday, 15.03.2024")).toBe("2024-03-15");
  });

  it("strips Estonian weekday prefix before parsing", () => {
    expect(normalizeDate("esmaspäev, 15.03.2024")).toBe("2024-03-15");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeDate("")).toBeUndefined();
  });

  it("returns undefined for invalid date", () => {
    expect(normalizeDate("not-a-date")).toBeUndefined();
  });

  it("returns undefined for out-of-range date (Feb 30)", () => {
    expect(normalizeDate("30.02.2024")).toBeUndefined();
  });

  it("handles Estonian month abbreviation 'jaan'", () => {
    expect(normalizeDate("5 jaan 2024")).toBe("2024-01-05");
  });

  it("handles Estonian month 'detsember'", () => {
    expect(normalizeDate("31 detsember 2023")).toBe("2023-12-31");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDate("  2024-03-15  ")).toBe("2024-03-15");
  });
});

describe("extractReceiptFieldsFromText parser quality metadata", () => {
  it("records the minimum OCR confidence from text items", () => {
    const result = extractReceiptFieldsFromText("Acme OÜ\nInvoice INV-1\nTotal 12.00 EUR", "invoice.pdf", {
      textItems: [
        { text: "Acme OÜ", x: 0, y: 0, width: 50, height: 10, confidence: 0.91 },
        { text: "Total 12.00 EUR", x: 0, y: 20, width: 80, height: 10, confidence: 0.52 },
        { text: "native", x: 0, y: 40, width: 40, height: 10 },
      ],
    });

    expect(result.min_ocr_confidence).toBe(0.52);
  });

  it("preserves partial OCR failure metadata from parser options", () => {
    const result = extractReceiptFieldsFromText("Acme OÜ\nInvoice INV-1\nTotal 12.00 EUR", "invoice.pdf", {
      partialOcrFailure: true,
    });

    expect(result.partial_ocr_failure).toBe(true);
  });

  it("records field provenance for labeled VAT, labeled registry code, and labeled total", () => {
    const result = extractReceiptFieldsFromText(
      [
        "Müüja: Acme OÜ",
        "Reg. nr 17487472",
        "KMKR: EE102809963",
        "Kokku: 120.00 EUR",
      ].join("\n"),
      "invoice.pdf",
      {
        textItems: [
          { text: "Müüja: Acme OÜ", x: 10, y: 10, width: 90, height: 10, confidence: 0.95, pageNum: 1 },
          { text: "Reg. nr 17487472", x: 10, y: 30, width: 80, height: 10, confidence: 0.93, pageNum: 1 },
          { text: "KMKR: EE102809963", x: 10, y: 50, width: 90, height: 10, confidence: 0.91, pageNum: 1 },
          { text: "Kokku: 120.00 EUR", x: 10, y: 70, width: 100, height: 10, confidence: 0.90, pageNum: 1 },
        ],
      },
    );

    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "supplier_reg_code",
        value: "17487472",
        source: "label",
        pageNum: 1,
        bbox: { x: 10, y: 30, width: 80, height: 10 },
        confidence: 0.93,
        rationale: "labeled",
      }),
      expect.objectContaining({
        field: "supplier_vat_no",
        value: "EE102809963",
        source: "label",
        pageNum: 1,
        bbox: { x: 10, y: 50, width: 90, height: 10 },
        confidence: 0.91,
        rationale: "labeled",
      }),
      expect.objectContaining({
        field: "total_gross",
        value: 120,
        source: "label",
        pageNum: 1,
        bbox: { x: 10, y: 70, width: 100, height: 10 },
        confidence: 0.90,
        rationale: "line_score",
      }),
    ]));
  });

  it("records fallback amount provenance", () => {
    const result = extractReceiptFieldsFromText(
      [
        "ACME OÜ",
        "Consulting 12.00",
        "Hosting 18.50",
      ].join("\n"),
      "receipt.pdf",
    );

    expect(result.total_gross).toBe(18.5);
    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "total_gross",
        value: 18.5,
        source: "fallback",
        rationale: "fallback_largest",
      }),
    ]));
  });

  it("records OCR provenance for supplier name from document text", () => {
    const result = extractReceiptFieldsFromText(
      [
        "ACME OÜ",
        "Reg. nr 17487472",
        "Invoice INV-1",
        "Total 12.00 EUR",
      ].join("\n"),
      "invoice.pdf",
      {
        textItems: [
          { text: "ACME OÜ", x: 12, y: 14, width: 45, height: 10, confidence: 0.88, pageNum: 2 },
          { text: "Reg. nr 17487472", x: 12, y: 24, width: 70, height: 10, confidence: 0.87, pageNum: 2 },
          { text: "Invoice INV-1", x: 12, y: 34, width: 70, height: 10, confidence: 0.86, pageNum: 2 },
          { text: "Total 12.00 EUR", x: 12, y: 54, width: 85, height: 10, confidence: 0.85, pageNum: 2 },
        ],
      },
    );

    expect(result.supplier_name).toBe("ACME OÜ");
    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "supplier_name",
        value: "ACME OÜ",
        source: "ocr",
        pageNum: 2,
        bbox: { x: 12, y: 14, width: 45, height: 10 },
        confidence: 0.88,
      }),
    ]));
  });

  it("uses layout rows when flattened invoice text would bind the wrong total", () => {
    const text = [
      "ACME OÜ",
      "Invoice INV-1",
      "Kokku 144.00 12.00",
    ].join("\n");
    const result = extractReceiptFieldsFromText(text, "invoice.pdf", {
      textItems: [
        { text: "ACME OÜ", x: 10, y: 10, width: 45, height: 10, pageNum: 1 },
        { text: "Invoice INV-1", x: 10, y: 30, width: 70, height: 10, pageNum: 1 },
        { text: "Kokku", x: 20, y: 120, width: 40, height: 10, pageNum: 1 },
        { text: "144.00", x: 86, y: 120, width: 45, height: 10, pageNum: 1 },
        { text: "12.00", x: 420, y: 120, width: 35, height: 10, pageNum: 1 },
      ],
    });

    expect(result.total_gross).toBe(144);
  });

  it("extracts net and VAT from separate columns in the same visual row", () => {
    const text = [
      "ACME OÜ",
      "Invoice INV-1",
      "Summa km-ta Käibemaks",
      "Kokku 124.00",
    ].join("\n");
    const result = extractReceiptFieldsFromText(text, "invoice.pdf", {
      textItems: [
        { text: "ACME OÜ", x: 10, y: 10, width: 45, height: 10, pageNum: 1 },
        { text: "Invoice INV-1", x: 10, y: 30, width: 70, height: 10, pageNum: 1 },
        { text: "Summa km-ta", x: 20, y: 100, width: 70, height: 10, pageNum: 1 },
        { text: "100.00", x: 105, y: 100, width: 45, height: 10, pageNum: 1 },
        { text: "Käibemaks", x: 260, y: 100, width: 65, height: 10, pageNum: 1 },
        { text: "24.00", x: 340, y: 100, width: 38, height: 10, pageNum: 1 },
        { text: "Kokku", x: 260, y: 130, width: 40, height: 10, pageNum: 1 },
        { text: "124.00", x: 340, y: 130, width: 45, height: 10, pageNum: 1 },
      ],
    });

    expect(result.total_net).toBe(100);
    expect(result.total_vat).toBe(24);
    expect(result.total_gross).toBe(124);
    expect(result.vat_explicit).toBe(true);
  });

  it("combines split layout label tokens before classifying amount fields", () => {
    const result = extractReceiptFieldsFromText("ACME OÜ\nInvoice INV-1\nTotal net 100.00\nKokku 124.00", "invoice.pdf", {
      textItems: [
        { text: "ACME OÜ", x: 10, y: 10, width: 45, height: 10, pageNum: 1 },
        { text: "Invoice INV-1", x: 10, y: 30, width: 70, height: 10, pageNum: 1 },
        { text: "Total", x: 20, y: 100, width: 34, height: 10, pageNum: 1 },
        { text: "net", x: 60, y: 100, width: 22, height: 10, pageNum: 1 },
        { text: "100.00", x: 105, y: 100, width: 45, height: 10, pageNum: 1 },
        { text: "Kokku", x: 260, y: 130, width: 40, height: 10, pageNum: 1 },
        { text: "124.00", x: 340, y: 130, width: 45, height: 10, pageNum: 1 },
      ],
    });

    expect(result.total_net).toBe(100);
    expect(result.total_vat).toBe(24);
    expect(result.total_gross).toBe(124);
    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "total_net",
        value: 100,
        source: "coordinate",
        bbox: { x: 105, y: 100, width: 45, height: 10 },
      }),
    ]));
  });

  it("uses same-column values below layout labels when the label row has no numbers", () => {
    const result = extractReceiptFieldsFromText("ACME OÜ\nInvoice INV-1\nSumma km-ta Käibemaks Kokku\n100.00 24.00 124.00", "invoice.pdf", {
      textItems: [
        { text: "ACME OÜ", x: 10, y: 10, width: 45, height: 10, pageNum: 1 },
        { text: "Invoice INV-1", x: 10, y: 30, width: 70, height: 10, pageNum: 1 },
        { text: "Summa km-ta", x: 80, y: 100, width: 70, height: 10, pageNum: 1 },
        { text: "Käibemaks", x: 220, y: 100, width: 65, height: 10, pageNum: 1 },
        { text: "Kokku", x: 360, y: 100, width: 40, height: 10, pageNum: 1 },
        { text: "100.00", x: 92, y: 122, width: 45, height: 10, pageNum: 1 },
        { text: "24.00", x: 232, y: 122, width: 38, height: 10, pageNum: 1 },
        { text: "124.00", x: 360, y: 122, width: 45, height: 10, pageNum: 1 },
      ],
    });

    expect(result.total_net).toBe(100);
    expect(result.total_vat).toBe(24);
    expect(result.total_gross).toBe(124);
    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "total_net",
        value: 100,
        source: "coordinate",
        bbox: { x: 92, y: 122, width: 45, height: 10 },
      }),
      expect.objectContaining({
        field: "total_vat",
        value: 24,
        source: "coordinate",
        bbox: { x: 232, y: 122, width: 38, height: 10 },
      }),
      expect.objectContaining({
        field: "total_gross",
        value: 124,
        source: "coordinate",
        bbox: { x: 360, y: 122, width: 45, height: 10 },
      }),
    ]));
  });

  it("keeps text gross when a later page layout total disagrees", () => {
    const text = [
      "ACME OÜ",
      "Invoice INV-1",
      "Amount due 124.00 EUR",
      "Page 2 summary",
      "Total 999.00",
    ].join("\n");
    const result = extractReceiptFieldsFromText(text, "invoice.pdf", {
      textItems: [
        { text: "ACME OÜ", x: 10, y: 10, width: 45, height: 10, pageNum: 1 },
        { text: "Invoice INV-1", x: 10, y: 30, width: 70, height: 10, pageNum: 1 },
        { text: "Amount due", x: 20, y: 120, width: 70, height: 10, pageNum: 1 },
        { text: "124.00", x: 110, y: 120, width: 45, height: 10, pageNum: 1 },
        { text: "Page 2 summary", x: 10, y: 10, width: 90, height: 10, pageNum: 2 },
        { text: "Total", x: 20, y: 120, width: 38, height: 10, pageNum: 2 },
        { text: "999.00", x: 90, y: 120, width: 45, height: 10, pageNum: 2 },
      ],
    });

    expect(result.total_gross).toBe(124);
    expect(result.extraction_notes).toEqual([
      "layout_total_gross_999_disagreed_with_text_total_gross_124_text_preferred",
    ]);
    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "total_gross",
        value: 124,
        source: "label",
      }),
    ]));
  });

  it("binds same-row layout labels to right-side amounts before left-side amounts", () => {
    const result = extractReceiptFieldsFromText("ACME OÜ\nInvoice INV-1\n100.00 Käibemaks 24.00\nKokku 124.00", "invoice.pdf", {
      textItems: [
        { text: "ACME OÜ", x: 10, y: 10, width: 45, height: 10, pageNum: 1 },
        { text: "Invoice INV-1", x: 10, y: 30, width: 70, height: 10, pageNum: 1 },
        { text: "100.00", x: 70, y: 100, width: 45, height: 10, pageNum: 1 },
        { text: "Käibemaks", x: 120, y: 100, width: 65, height: 10, pageNum: 1 },
        { text: "24.00", x: 195, y: 100, width: 38, height: 10, pageNum: 1 },
        { text: "Kokku", x: 120, y: 130, width: 40, height: 10, pageNum: 1 },
        { text: "124.00", x: 195, y: 130, width: 45, height: 10, pageNum: 1 },
      ],
    });

    expect(result.total_vat).toBe(24);
    expect(result.total_net).toBe(100);
    expect(result.total_gross).toBe(124);
  });

  it("falls back to flattened text amount extraction when no layout items are present", () => {
    const result = extractReceiptFieldsFromText(
      [
        "ACME OÜ",
        "Invoice INV-1",
        "Summa km-ta 100.00",
        "Käibemaks 24.00",
        "Kokku 124.00",
      ].join("\n"),
      "invoice.pdf",
    );

    expect(result.total_net).toBe(100);
    expect(result.total_vat).toBe(24);
    expect(result.total_gross).toBe(124);
    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "total_gross",
        value: 124,
        source: "label",
      }),
    ]));
  });

  it("falls back to flattened text amount extraction when layout items are empty", () => {
    const result = extractReceiptFieldsFromText(
      [
        "ACME OÜ",
        "Invoice INV-1",
        "Summa km-ta 100.00",
        "Käibemaks 24.00",
        "Kokku 124.00",
      ].join("\n"),
      "invoice.pdf",
      { textItems: [] },
    );

    expect(result.total_net).toBe(100);
    expect(result.total_vat).toBe(24);
    expect(result.total_gross).toBe(124);
  });

  it("records coordinate provenance for layout-extracted amounts", () => {
    const result = extractReceiptFieldsFromText("ACME OÜ\nInvoice INV-1\nKokku 144.00 12.00", "invoice.pdf", {
      textItems: [
        { text: "ACME OÜ", x: 10, y: 10, width: 45, height: 10, pageNum: 2 },
        { text: "Invoice INV-1", x: 10, y: 30, width: 70, height: 10, pageNum: 2 },
        { text: "Kokku", x: 20, y: 120, width: 40, height: 10, pageNum: 2 },
        { text: "144.00", x: 86, y: 120, width: 45, height: 10, pageNum: 2, confidence: 0.88 },
        { text: "12.00", x: 420, y: 120, width: 35, height: 10, pageNum: 2 },
      ],
    });

    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "total_gross",
        value: 144,
        source: "coordinate",
        pageNum: 2,
        bbox: { x: 86, y: 120, width: 45, height: 10 },
        confidence: 0.88,
      }),
    ]));
  });

  it("attributes supplier identifiers to page 1, not page 2 buyer block, across a multi-page PDF", () => {
    // Page 1: supplier block. Page 2: buyer block with its own reg/VAT/IBAN
    // at the SAME in-page y coordinates as page 1's supplier block. The
    // merged textItems feed coordinate-based classification; a page-blind
    // classifier could let the page-2 buyer markers "win" the page-1 supplier
    // candidates (or vice versa). Provenance must keep supplier IDs on page 1.
    const text = [
      "Müüja: Acme OÜ",
      "Reg. nr 17487472",
      "KMKR: EE102809963",
      "IBAN: EE471000001020145685",
      "Kokku: 120.00 EUR",
      "Arve saaja: Buyer OÜ",
      "Reg. nr 12345678",
      "KMKR: EE123412342",
      "IBAN: EE927700771006313596",
    ].join("\n");
    const textItems = [
      { text: "Müüja: Acme OÜ", x: 10, y: 30, width: 110, height: 10, confidence: 0.95, pageNum: 1 },
      { text: "Reg. nr 17487472", x: 10, y: 50, width: 90, height: 10, confidence: 0.93, pageNum: 1 },
      { text: "KMKR: EE102809963", x: 10, y: 70, width: 110, height: 10, confidence: 0.91, pageNum: 1 },
      { text: "IBAN: EE471000001020145685", x: 10, y: 90, width: 180, height: 10, confidence: 0.92, pageNum: 1 },
      { text: "Kokku: 120.00 EUR", x: 10, y: 200, width: 120, height: 10, confidence: 0.90, pageNum: 1 },
      { text: "Arve saaja: Buyer OÜ", x: 10, y: 30, width: 130, height: 10, confidence: 0.94, pageNum: 2 },
      { text: "Reg. nr 12345678", x: 10, y: 50, width: 90, height: 10, confidence: 0.92, pageNum: 2 },
      { text: "KMKR: EE123412342", x: 10, y: 70, width: 110, height: 10, confidence: 0.90, pageNum: 2 },
      { text: "IBAN: EE927700771006313596", x: 10, y: 90, width: 180, height: 10, confidence: 0.91, pageNum: 2 },
    ];

    const result = extractReceiptFieldsFromText(text, "invoice.pdf", { textItems });

    // Supplier fields must be the page-1 supplier's, never the page-2 buyer's.
    expect(result.supplier_reg_code).toBe("17487472");
    expect(result.supplier_vat_no).toBe("EE102809963");
    expect(result.supplier_iban).toBe("EE471000001020145685");

    const regProvenance = result.field_provenance?.find(p => p.field === "supplier_reg_code");
    expect(regProvenance).toBeDefined();
    expect(regProvenance!.pageNum).toBe(1);
    expect(regProvenance!.bbox).toEqual({ x: 10, y: 50, width: 90, height: 10 });

    const vatProvenance = result.field_provenance?.find(p => p.field === "supplier_vat_no");
    expect(vatProvenance).toBeDefined();
    expect(vatProvenance!.pageNum).toBe(1);
    expect(vatProvenance!.bbox).toEqual({ x: 10, y: 70, width: 110, height: 10 });

    const ibanProvenance = result.field_provenance?.find(p => p.field === "iban");
    expect(ibanProvenance).toBeDefined();
    expect(ibanProvenance!.pageNum).toBe(1);
    expect(ibanProvenance!.bbox).toEqual({ x: 10, y: 90, width: 180, height: 10 });
  });
});

describe("computeMinOcrConfidence robust heuristic", () => {
  it("returns undefined for undefined text items", () => {
    expect(computeMinOcrConfidence(undefined)).toBeUndefined();
  });

  it("returns undefined when no items have confidence values", () => {
    expect(computeMinOcrConfidence([
      { text: "hello", x: 0, y: 0, width: 50, height: 10 },
    ])).toBeUndefined();
  });

  it("uses minimum when fewer than 5 items have confidence (not enough for percentile)", () => {
    const items = [
      { text: "Invoice text", x: 0, y: 0, width: 50, height: 10, confidence: 0.95 },
      { text: "Total 12.00", x: 0, y: 20, width: 80, height: 10, confidence: 0.30 },
      { text: "Date 2024", x: 0, y: 40, width: 40, height: 10, confidence: 0.88 },
    ];
    expect(computeMinOcrConfidence(items)).toBe(0.30);
  });

  it("filters out short text items (< 3 chars) before computing percentile", () => {
    const items = [
      { text: "Invoice number 12345", x: 0, y: 0, width: 50, height: 10, confidence: 0.95 },
      { text: "Total 120.00 EUR", x: 0, y: 20, width: 80, height: 10, confidence: 0.92 },
      { text: "Date 2024-01-15", x: 0, y: 40, width: 40, height: 10, confidence: 0.90 },
      { text: "Acme OÜ supplier", x: 0, y: 60, width: 40, height: 10, confidence: 0.88 },
      { text: "Reg nr 12345678", x: 0, y: 80, width: 40, height: 10, confidence: 0.91 },
      { text: ".", x: 0, y: 100, width: 5, height: 10, confidence: 0.10 },
    ];
    // 5 robust items (1-char "." filtered): sorted [0.88, 0.90, 0.91, 0.92, 0.95]
    // 10th percentile index = floor(5 * 0.1) = 0 -> 0.88
    expect(computeMinOcrConfidence(items)).toBe(0.88);
  });

  it("uses 10th percentile ignoring short noise items that would otherwise dominate", () => {
    const items = [
      { text: "Invoice number 12345", x: 0, y: 0, width: 50, height: 10, confidence: 0.95 },
      { text: "Total 120.00 EUR", x: 0, y: 20, width: 80, height: 10, confidence: 0.92 },
      { text: "Date 2024-01-15", x: 0, y: 40, width: 40, height: 10, confidence: 0.90 },
      { text: "Acme OÜ supplier", x: 0, y: 60, width: 40, height: 10, confidence: 0.88 },
      { text: "Reg nr 12345678", x: 0, y: 80, width: 40, height: 10, confidence: 0.91 },
      { text: "VAT EE102809963", x: 0, y: 100, width: 40, height: 10, confidence: 0.89 },
      { text: "IBAN EE4710000", x: 0, y: 120, width: 40, height: 10, confidence: 0.93 },
      { text: "x", x: 0, y: 140, width: 5, height: 10, confidence: 0.05 },
    ];
    // 7 robust items (1-char "x" filtered): sorted [0.88, 0.89, 0.90, 0.91, 0.92, 0.93, 0.95]
    // 10th percentile index = floor(7 * 0.1) = 0 -> 0.88
    expect(computeMinOcrConfidence(items)).toBe(0.88);
  });
});

// ---------------------------------------------------------------------------
// extractAmounts
// ---------------------------------------------------------------------------

describe("extractAmounts", () => {
  it("returns empty object for empty text", () => {
    const result = extractAmounts("");
    expect(result.total_gross).toBeUndefined();
    expect(result.total_net).toBeUndefined();
    expect(result.total_vat).toBeUndefined();
  });

  it("extracts gross from a 'Kokku' label line", () => {
    const text = "Kokku: 120.00 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(120);
  });

  it("extracts gross from Estonian 'SUMMA KÄIBEMAKSUGA' pattern", () => {
    const text = "SUMMA KÄIBEMAKSUGA 120,00";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(120);
  });

  it("extracts VAT and derives net from gross and VAT", () => {
    const text = [
      "Käibemaks 22.58 EUR",
      "Kokku: 120.00 EUR",
    ].join("\n");
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(120);
    expect(result.total_vat).toBe(22.58);
    expect(result.total_net).toBe(97.42);
  });

  it("extracts net from 'neto' label", () => {
    const text = [
      "Neto: 100.00",
      "Käibemaks: 20.00",
      "Kokku: 120.00",
    ].join("\n");
    const result = extractAmounts(text);
    expect(result.total_net).toBe(100);
    expect(result.total_vat).toBe(20);
    expect(result.total_gross).toBe(120);
  });

  it("derives VAT when gross and net are present but VAT is missing", () => {
    const text = [
      "Summa km-ta: 100.00",
      "Tasuda: 120.00",
    ].join("\n");
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(120);
    expect(result.total_net).toBe(100);
    expect(result.total_vat).toBe(20);
  });

  it("handles comma as decimal separator", () => {
    const text = "Kokku: 99,99 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(99.99);
  });

  it("prefers 'grand total' line over other amounts", () => {
    const text = [
      "Subtotal 100.00",
      "Grand total 124.00",
    ].join("\n");
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(124);
  });

  it("does not mistake reference number lines as amounts", () => {
    const text = [
      "IBAN EE382200221020145685",
      "Kokku: 50.00 EUR",
    ].join("\n");
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(50);
  });

  it("handles 'amount due' label", () => {
    const text = "Amount due: 250.00 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(250);
  });

  it("handles 'total' label", () => {
    const text = "Total 75.50 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(75.5);
  });
});

// ---------------------------------------------------------------------------
// computeTermDays
// ---------------------------------------------------------------------------

describe("computeTermDays", () => {
  it("returns 0 when both dates are the same", () => {
    expect(computeTermDays("2024-03-15", "2024-03-15")).toBe(0);
  });

  it("returns correct days for a 30-day term", () => {
    expect(computeTermDays("2024-03-01", "2024-03-31")).toBe(30);
  });

  it("returns 0 for missing invoiceDate", () => {
    expect(computeTermDays(undefined, "2024-03-31")).toBe(0);
  });

  it("returns 0 for missing dueDate", () => {
    expect(computeTermDays("2024-03-01", undefined)).toBe(0);
  });

  it("returns 0 when both dates are missing", () => {
    expect(computeTermDays(undefined, undefined)).toBe(0);
  });

  it("returns absolute value (no negatives) when dates are reversed", () => {
    // dueDate before invoiceDate — returns absolute diff, not negative
    const result = computeTermDays("2024-03-31", "2024-03-01");
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("handles end-of-month crossing", () => {
    expect(computeTermDays("2024-01-31", "2024-03-01")).toBe(30);
  });

  it("handles year boundary", () => {
    expect(computeTermDays("2023-12-01", "2024-01-01")).toBe(31);
  });
});

// ---------------------------------------------------------------------------
// hasRecurringSimilarAmounts
// ---------------------------------------------------------------------------

describe("hasRecurringSimilarAmounts", () => {
  it("returns false for a single amount", () => {
    expect(hasRecurringSimilarAmounts([100])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasRecurringSimilarAmounts([])).toBe(false);
  });

  it("returns true for identical amounts", () => {
    expect(hasRecurringSimilarAmounts([99, 99, 99])).toBe(true);
  });

  it("returns true for amounts within 2 EUR absolute tolerance", () => {
    // avg=100, 5% of avg=5, threshold=max(2,5)=5; diff=1.50 < 5
    expect(hasRecurringSimilarAmounts([99, 100.5])).toBe(true);
  });

  it("returns true for amounts within 5% of average", () => {
    // avg=1000, 5%=50, diff=40 < 50
    expect(hasRecurringSimilarAmounts([980, 1020])).toBe(true);
  });

  it("returns false for amounts that differ more than 5% of average", () => {
    // avg=100, 5%=5, threshold=5; diff=20 > 5
    expect(hasRecurringSimilarAmounts([90, 110])).toBe(false);
  });

  it("returns false for very different amounts", () => {
    expect(hasRecurringSimilarAmounts([10, 500])).toBe(false);
  });

  it("returns true for two amounts within absolute 2 EUR", () => {
    // avg=1, 5% of avg=0.05, threshold=max(2,0.05)=2; diff=1 < 2
    expect(hasRecurringSimilarAmounts([1, 2])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeCounterpartyName
// ---------------------------------------------------------------------------

describe("normalizeCounterpartyName", () => {
  it("lowercases and strips legal suffixes", () => {
    expect(normalizeCounterpartyName("Acme OÜ")).toBe("acme");
  });

  it("handles AS suffix", () => {
    expect(normalizeCounterpartyName("Swedbank AS")).toBe("swedbank");
  });

  it("strips diacritics via NFKD normalization", () => {
    // ü -> u after NFKD + diacritic removal
    const result = normalizeCounterpartyName("Mägi OÜ");
    expect(result).toBe("magi");
  });

  it("handles null input", () => {
    expect(normalizeCounterpartyName(null)).toBe("");
  });

  it("handles undefined input", () => {
    expect(normalizeCounterpartyName(undefined)).toBe("");
  });

  it("handles empty string", () => {
    expect(normalizeCounterpartyName("")).toBe("");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeCounterpartyName("Big  Company OÜ")).toBe("big company");
  });

  it("strips non-alphanumeric characters", () => {
    // The wrapper passes stripNonAlphanumeric: true
    const result = normalizeCounterpartyName("Company, Ltd.");
    expect(result).not.toContain(",");
    expect(result).not.toContain(".");
  });
});

// ---------------------------------------------------------------------------
// looksLikePersonCounterparty
// ---------------------------------------------------------------------------

describe("looksLikePersonCounterparty", () => {
  it("returns true for a two-word name", () => {
    expect(looksLikePersonCounterparty("john smith")).toBe(true);
  });

  it("returns true for a three-word name", () => {
    expect(looksLikePersonCounterparty("jaan mägi tamm")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(looksLikePersonCounterparty("")).toBe(false);
  });

  it("returns false for a single word", () => {
    expect(looksLikePersonCounterparty("google")).toBe(false);
  });

  it("returns false for five or more words", () => {
    expect(looksLikePersonCounterparty("a b c d e")).toBe(false);
  });

  it("returns false when normalized name contains company word like 'solutions'", () => {
    expect(looksLikePersonCounterparty("acme solutions")).toBe(false);
  });

  it("returns false when normalized name contains 'ltd'", () => {
    expect(looksLikePersonCounterparty("john ltd")).toBe(false);
  });

  it("returns false when rawCounterparty has all-caps word", () => {
    // All-caps word signals a company abbreviation
    expect(looksLikePersonCounterparty("acme ou", "ACME OÜ")).toBe(false);
  });

  it("returns true for Estonian two-word person name", () => {
    expect(looksLikePersonCounterparty("jaan tamm")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveAutoBookedNetAmount
// ---------------------------------------------------------------------------

describe("deriveAutoBookedNetAmount", () => {
  it("returns gross rounded to 2 decimals when VAT rate is '-' (exempt)", () => {
    expect(deriveAutoBookedNetAmount(120, { vat_rate_dropdown: "-" })).toBe(120);
  });

  it("returns gross as-is when no vat_rate_dropdown", () => {
    expect(deriveAutoBookedNetAmount(120, {})).toBe(120);
  });

  it("divides gross by 1.24 for 24% VAT", () => {
    const net = deriveAutoBookedNetAmount(124, { vat_rate_dropdown: "24" });
    // 124 / 1.24 = 100 exactly
    expect(net).toBeCloseTo(100, 5);
  });

  it("returns gross when reversed_vat_id is set (reverse charge)", () => {
    const net = deriveAutoBookedNetAmount(100, { vat_rate_dropdown: "24", reversed_vat_id: 1 });
    expect(net).toBe(100);
  });

  it("computes net with high precision (6 decimal places)", () => {
    // 59.94 / 1.24 = 48.338709677...
    const net = deriveAutoBookedNetAmount(59.94, { vat_rate_dropdown: "24" });
    expect(net).toBeCloseTo(48.338710, 5);
  });
});

// ---------------------------------------------------------------------------
// deriveAutoBookedVatPrice
// ---------------------------------------------------------------------------

describe("deriveAutoBookedVatPrice", () => {
  it("returns 0 when reversed_vat_id is set", () => {
    expect(deriveAutoBookedVatPrice(120, { vat_rate_dropdown: "24", reversed_vat_id: 1 })).toBe(0);
  });

  it("returns 0 when no VAT rate", () => {
    expect(deriveAutoBookedVatPrice(120, { vat_rate_dropdown: "-" })).toBe(0);
  });

  it("returns 0 when vat_rate_dropdown is absent", () => {
    expect(deriveAutoBookedVatPrice(120, {})).toBe(0);
  });

  it("computes VAT for 24% rate on 124 EUR gross", () => {
    // gross=124, net=100, vat=24
    expect(deriveAutoBookedVatPrice(124, { vat_rate_dropdown: "24" })).toBeCloseTo(24, 2);
  });

  it("computes VAT for 24% rate on 59.94 EUR gross", () => {
    // gross - net = 59.94 - 48.338710 ≈ 11.60 rounded to cents
    const vat = deriveAutoBookedVatPrice(59.94, { vat_rate_dropdown: "24" });
    expect(vat).toBeCloseTo(11.6, 1);
  });
});

// ---------------------------------------------------------------------------
// extractSupplierName
// ---------------------------------------------------------------------------

describe("extractSupplierName", () => {
  it("extracts company name with OÜ suffix", () => {
    const text = "ACME OÜ\nReg. nr: 12345678\nInvoice: 001";
    const result = extractSupplierName(text, "invoice.pdf");
    expect(result).toBe("ACME OÜ");
  });

  it("extracts company name with AS suffix", () => {
    const text = "SWEDBANK AS\nIBAN EE123456789\nKokku: 50.00";
    const result = extractSupplierName(text, "receipt.pdf");
    expect(result).toMatch(/SWEDBANK AS/i);
  });

  it("extracts company from 'müüja' label line", () => {
    const text = "Müüja: Tarkvara OÜ\nOstja: Test Firma OÜ";
    const result = extractSupplierName(text, "arve.pdf");
    expect(result).toBe("Tarkvara OÜ");
  });

  it("falls back to filename token when no company found", () => {
    const text = "No company here\nJust some text";
    const result = extractSupplierName(text, "mycompany.pdf");
    // Should use normalized filename token
    expect(result).toBeDefined();
    expect(result!.toUpperCase()).toContain("MYCOMPANY");
  });

  it("returns undefined for generic filename when no company found", () => {
    const text = "Some random text without a company name";
    const result = extractSupplierName(text, "invoice.pdf");
    // "INVOICE" is a blocked generic token
    expect(result).toBeUndefined();
  });

  it("extracts from 'seller' label line", () => {
    const text = "Seller: Tech Solutions OÜ\nBill to: My Company";
    const result = extractSupplierName(text, "doc.pdf");
    expect(result).toContain("Tech Solutions");
  });

  it("does not return buyer section as supplier", () => {
    // "Müüja:" label is stripped, leaving the company name after it
    const text = [
      "Müüja: Tartu Firma OÜ",
      "Reg 12345678",
      "Bill to: Buyer OÜ",
    ].join("\n");
    const result = extractSupplierName(text, "invoice.pdf");
    // Should pick the seller (müüja), not the buyer
    expect(result).toMatch(/Tartu Firma/i);
  });
});

// ---------------------------------------------------------------------------
// extractPdfIdentifiers — own-VAT exclusion (#14)
// ---------------------------------------------------------------------------

describe("extractPdfIdentifiers", () => {
  it("clears supplier_vat_no when the only VAT on the page is the buyer's own", () => {
    // Mirrors the Anthropic case: supplier prints no VAT, the only VAT line
    // belongs to the buyer (Seppo AI OÜ EE102809963).
    const text = [
      "Anthropic, PBC                      Bill to",
      "548 Market Street                   Indrek Seppo",
      "United States                       Estonia",
      "                                    EE VAT EE102809963",
    ].join("\n");

    expect(extractPdfIdentifiers(text).supplier_vat_no).toBe("EE102809963");
    expect(
      extractPdfIdentifiers(text, { ownCompanyVat: "EE102809963" }).supplier_vat_no,
    ).toBeUndefined();
  });

  it("returns structured all_vat_candidates and rejected_candidates from extractIdentifiers", () => {
    const text = "KMKR: EE100594103\nKMKR: EE102809963";
    const ids = extractPdfIdentifiers(text);
    expect(ids.all_vat_candidates).toEqual(
      expect.arrayContaining(["EE100594103", "EE102809963"]),
    );
    // The bad-checksum value is in rejected_candidates.
    expect(ids.rejected_candidates?.some(r => r.kind === "vat_no" && r.value === "EE100594103")).toBe(true);
    // The checksum-failing labeled value is not canonical when a valid alternative exists.
    expect(ids.supplier_vat_no).toBe("EE102809963");
  });

  it("recovers a bare reg code via tier 2 when no label is present", () => {
    const text = ["Acme OÜ", "17133416", "Tallinn"].join("\n");
    expect(extractPdfIdentifiers(text).supplier_reg_code).toBe("17133416");
  });

  it("threads ownCompanyRegistryCode through to excludeRegCode", () => {
    const text = ["Acme OÜ", "17133416", "Tallinn"].join("\n");
    expect(
      extractPdfIdentifiers(text, { ownCompanyRegistryCode: "17133416" }).supplier_reg_code,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findAccountByKeywords — substring bug + fixed-asset guard (#17)
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> & { id: number; name_est: string }): Account {
  return {
    id: overrides.id,
    name_est: overrides.name_est,
    name_eng: overrides.name_eng ?? "",
    account_type_est: overrides.account_type_est ?? "",
    account_type_eng: overrides.account_type_eng ?? "",
    balance_type: overrides.balance_type ?? "D",
    is_valid: overrides.is_valid ?? true,
    allows_deactivation: overrides.allows_deactivation ?? true,
    is_vat_account: overrides.is_vat_account ?? false,
    is_fixed_asset: overrides.is_fixed_asset ?? false,
    transaction_in_bindable: true,
    transaction_out_bindable: true,
    cl_account_groups: [],
    default_disabled: false,
    transaction_in_user_bindable: true,
    transaction_out_user_bindable: true,
    is_product_account: false,
  } as Account;
}

describe("findAccountByKeywords (#17)", () => {
  it("does not match the keyword 'it' inside 'Ehitised' (the original Buildings miscoding bug)", () => {
    // The substring bug: text.includes("it") was true for "ehitised",
    // routing OpenAI/ChatGPT receipts to id=1810 Ehitised (Buildings).
    const accounts = [
      makeAccount({ id: 1810, name_est: "Ehitised", is_fixed_asset: true }),
      makeAccount({ id: 4920, name_est: "Internet ja sideteenused" }),
    ];
    const result = findAccountByKeywords(accounts, ["it"]);
    expect(result?.id).not.toBe(1810);
  });

  it("filters out fixed-asset accounts even when the keyword matches their name", () => {
    // Defense in depth: even if a keyword does match a fixed-asset name
    // exactly, refuse it. SaaS/services are categorically not fixed assets.
    const accounts = [
      makeAccount({ id: 1830, name_est: "Muu materiaalne põhivara", is_fixed_asset: true }),
      makeAccount({ id: 5990, name_est: "Muud mitmesugused tegevuskulud" }),
    ];
    const result = findAccountByKeywords(accounts, ["muu"]);
    expect(result?.id).toBe(5990);
    expect(result?.is_fixed_asset).toBe(false);
  });

  it("matches whole-word keywords correctly (positive case)", () => {
    const accounts = [
      makeAccount({ id: 4920, name_est: "Internet ja sideteenused" }),
    ];
    const result = findAccountByKeywords(accounts, ["internet"]);
    expect(result?.id).toBe(4920);
  });

  it("treats Estonian non-ASCII letters as part of a word (õ does not break a boundary)", () => {
    const accounts = [
      makeAccount({ id: 5310, name_est: "Sõidukikulud" }),
    ];
    // "auto" must not match — `auto` is not a prefix of any word in
    // `sõidukikulud`, and the matcher requires a leading word boundary.
    expect(findAccountByKeywords(accounts, ["auto"])?.id).toBeUndefined();
    // "sõiduk" DOES match `sõidukikulud` — the matcher is prefix-at-word-
    // boundary by design (so Estonian suffixes like `muud` / `muude`
    // still match a `muu` keyword). Pin that behaviour here so a future
    // tweak that tightens the regex to require a trailing boundary
    // doesn't silently drop legitimate inflected matches.
    expect(findAccountByKeywords(accounts, ["sõiduk"])?.id).toBe(5310);
  });
});

describe("findPurchaseArticleByKeywords (#17)", () => {
  it("matches by whole word, not substring", () => {
    // "office" must not match by being a substring of an unrelated word
    // and must match standalone tokens cleanly.
    const articles = [
      { id: 1, name_est: "Officeruumi rent", name_eng: "Office space rent" },
      { id: 2, name_est: "Materjalid", name_eng: "Materials" },
    ];
    const result = findPurchaseArticleByKeywords(articles, ["office"]);
    expect(result?.id).toBe(1);
  });
});

describe("buildKeywordSuggestion (#17)", () => {
  const baseAccounts = [
    makeAccount({ id: 1810, name_est: "Ehitised", is_fixed_asset: true }),
    makeAccount({ id: 1830, name_est: "Muu materiaalne põhivara", is_fixed_asset: true }),
    makeAccount({ id: 4920, name_est: "Internet ja sideteenused" }),
    makeAccount({ id: 5990, name_est: "Muud mitmesugused tegevuskulud" }),
  ];
  const baseArticles = [
    { id: 10, name_est: "Internetikulu", name_eng: "Internet expense", accounts_id: 4920 },
    { id: 99, name_est: "Muu kulu", name_eng: "Other expense", accounts_id: 5990 },
  ];

  it("does not pick a fixed-asset account for an OpenAI/ChatGPT-style hint (#17 regression)", () => {
    const result = buildKeywordSuggestion(baseArticles, baseAccounts, "OpenAI ChatGPT subscription");
    expect(result?.suggested_account?.is_fixed_asset).toBe(false);
    expect(result?.suggested_account?.id).toBe(4920);
    expect(result?.source).toBe("keyword_match");
  });

  it("does not pick a fixed-asset account for an Anthropic/Claude hint", () => {
    const result = buildKeywordSuggestion(baseArticles, baseAccounts, "Anthropic Claude Max subscription");
    expect(result?.suggested_account?.is_fixed_asset).toBe(false);
    expect(result?.suggested_account?.id).toBe(4920);
  });

  it("falls back to a non-fixed-asset account when the keyword tier finds no specific match", () => {
    // Hint matches no specific tier → drops to the muu/general fallback.
    // Even there, must not return a fixed-asset account.
    const result = buildKeywordSuggestion(baseArticles, baseAccounts, "Random unmatched supplier");
    expect(result?.suggested_account?.is_fixed_asset).toBe(false);
  });

  it("refuses to return an article-bound account when that account is a fixed asset (article misconfiguration guard)", () => {
    // Article points at fixed-asset Ehitised — the back-door route to the
    // original miscoding. Resolution must override and use a keyword-found
    // non-fixed-asset account instead.
    const articles = [
      { id: 1, name_est: "Tarkvara litsents", name_eng: "Software license", accounts_id: 1810 },
    ];
    const result = buildKeywordSuggestion(articles, baseAccounts, "OpenAI subscription");
    expect(result?.suggested_account?.id).not.toBe(1810);
    expect(result?.suggested_account?.is_fixed_asset).toBe(false);
  });

  it("returns undefined when the article maps to fixed-asset AND no non-fixed replacement exists", () => {
    // Even with the fixed-asset article account refused, item.purchase_accounts_id
    // used to fall back to article.accounts_id when keyword search failed —
    // re-opening the back door. Refuse to emit a suggestion at all so the
    // caller routes the row to needs_review.
    const articles = [
      { id: 1, name_est: "Tarkvara litsents", name_eng: "Software license", accounts_id: 1810 },
    ];
    const accountsWithOnlyFixed = [
      makeAccount({ id: 1810, name_est: "Ehitised", is_fixed_asset: true }),
      makeAccount({ id: 1830, name_est: "Muu materiaalne põhivara", is_fixed_asset: true }),
    ];
    const result = buildKeywordSuggestion(articles, accountsWithOnlyFixed, "OpenAI subscription");
    expect(result).toBeUndefined();
  });

  it("does not propagate article.accounts_id into the item when the article account is fixed-asset", () => {
    // Even when keyword fallback finds a replacement account, the item
    // must not surface the original article.accounts_id (1810) as a
    // backup — the suggested account is the only safe value to write.
    const articles = [
      { id: 1, name_est: "Tarkvara litsents", name_eng: "Software license", accounts_id: 1810 },
    ];
    const result = buildKeywordSuggestion(articles, baseAccounts, "OpenAI subscription");
    expect(result?.item.purchase_accounts_id).not.toBe(1810);
    expect(result?.item.purchase_accounts_id).toBe(result?.suggested_account?.id);
  });
});

describe("detectReverseChargeFromText (#18)", () => {
  it("matches Estonian phrase 'pöördmaksustamise alusel'", () => {
    expect(detectReverseChargeFromText("Pöördmaksustamise alusel makstav maks")).toBe(true);
  });

  it("matches English 'reverse charge'", () => {
    expect(detectReverseChargeFromText("Subject to reverse charge")).toBe(true);
  });

  it("matches German 'Steuerschuldnerschaft des Leistungsempfängers'", () => {
    expect(detectReverseChargeFromText("Steuerschuldnerschaft des Leistungsempfängers")).toBe(true);
  });

  it("matches French 'autoliquidation'", () => {
    expect(detectReverseChargeFromText("Autoliquidation de la TVA")).toBe(true);
  });

  it("returns false for plain invoice text without reverse-charge phrasing", () => {
    expect(detectReverseChargeFromText("VAT 20% included")).toBe(false);
  });

  it("returns false for empty/undefined input", () => {
    expect(detectReverseChargeFromText(undefined)).toBe(false);
    expect(detectReverseChargeFromText("")).toBe(false);
  });
});

describe("parseAmount — comma thousands and negative signs (Codex review 6)", () => {
  it("treats 1,234 as 1234 (comma thousands separator, not decimal)", () => {
    const text = "Kokku: 1,234 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(1234);
  });

  it("treats 1,234.56 as 1234.56 (comma thousands, dot decimal)", () => {
    const text = "Total: 1,234.56 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(1234.56);
  });

  it("treats 1.234,56 as 1234.56 (dot thousands, comma decimal)", () => {
    const text = "Kokku: 1.234,56 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(1234.56);
  });

  it("preserves negative sign in amount", () => {
    const text = "Kokku: -123.45 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(-123.45);
  });

  it("handles negative amount with comma thousands separator (Oracle review)", () => {
    const text = "Kokku: -1,234 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(-1234);
  });
});
