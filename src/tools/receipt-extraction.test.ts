import { describe, it, expect } from "vitest";
import type { Account } from "../types/api.js";
import type { LayoutTextItem } from "../document-identifiers.js";
import {
  normalizeDate,
  extractDates,
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
  classifyLayoutAmountLabel,
  extractAmountsFromLine,
  extractAmountsFromLayout,
  mergeLayoutAmounts,
  suggestBookingInternal,
  categorizeTransactionGroup,
} from "./receipt-extraction.js";
import type { ExtractedAmountsWithMetadata } from "./receipt-extraction.js";

describe("bank transaction source direction classification", () => {
  it("classifies API type C with signed incoming metadata as revenue, not an expense", () => {
    const classification = categorizeTransactionGroup({
      normalized_counterparty: "customer ou",
      transactions: [{
        type: "C",
        amount: 100,
        date: "2026-07-19",
        description: "WISE:incoming Customer [source_direction=IN]",
        bank_subtype: null,
      }],
    });

    expect(classification.category).toBe("revenue_without_invoice");
  });
});

// ---------------------------------------------------------------------------
// normalizeDate
// ---------------------------------------------------------------------------

describe("normalizeDate", () => {
  it("passes through ISO dates unchanged", () => {
    expect(normalizeDate("2024-03-15")).toBe("2024-03-15");
  });

  it("rejects impossible ISO dates (calendar round-trip)", () => {
    // ISO-format but not a real calendar day — must not pass through.
    expect(normalizeDate("2026-02-30")).toBeUndefined();
    expect(normalizeDate("2026-13-01")).toBeUndefined();
  });

  it("extractDates ignores an impossible ISO invoice date", () => {
    expect(extractDates("Invoice date: 2026-02-30")).toEqual({});
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

  // H11. An explicit "VAT 0.00" is a STATEMENT that tax is zero, not a missing
  // value, and the two are not interchangeable downstream: 0 with vat_explicit
  // says the supplier charged none — a zero-rated, exempt, or reverse-charge
  // receipt — whereas undefined makes VAT a missing field, which drops it from
  // the audit line and sends the receipt to needs_review rather than booking.
  // (It does NOT cause a 24% rate to be derived out of the gross: that path
  // needs net and gross bound with VAT absent, which cannot occur, since VAT is
  // then derived as gross - net.) The zero was being dropped by
  // extractAmountsFromLine's blanket `value !== 0` filter before the line could
  // ever be classified as the VAT line.
  it("H11 keeps an explicit zero VAT authoritative when no net line is present", () => {
    // The reduced case: gross + an explicit zero VAT and nothing else. Today
    // this yields {total_gross: 100, vat_explicit: false} — the statement is
    // silently discarded and total_vat is undefined.
    const result = extractAmounts("Total 100.00 EUR\nVAT 0.00 EUR");
    expect(result).toMatchObject({
      total_net: 100, total_vat: 0, total_gross: 100, vat_explicit: true,
    });
  });

  it("H11 keeps an explicit zero VAT authoritative when the label is Estonian", () => {
    // The same statement in the language this server is actually used in.
    // "KM" is the Estonian VAT label; without this row the fix could be wired
    // to an English-only label path and every Estonian receipt would regress.
    const result = extractAmounts("Summa 100.00 EUR\nKM 0.00 EUR");
    expect(result).toMatchObject({
      total_net: 100, total_vat: 0, total_gross: 100, vat_explicit: true,
    });
  });

  // Declared CONTROL, not a RED: the task's own mandated repro already passes,
  // because gross(100) - net(100) derives VAT 0 through the fallback and the
  // explicit "Subtotal" line sets vat_explicit. It is kept as a control so the
  // fix cannot regress the path that made the plan's example work by accident.
  it("H11 control: explicit zero VAT with a subtotal line stays correct", () => {
    const result = extractAmounts("Subtotal 100.00 EUR\nVAT 0.00 EUR\nTotal 100.00 EUR");
    expect(result).toMatchObject({
      total_net: 100, total_vat: 0, total_gross: 100, vat_explicit: true,
    });
  });

  // Declared CONTROL: zero must stay filtered for UNLABELLED amounts, or page
  // numbers and empty cells become totals. This is the constraint that makes
  // the fix label-scoped rather than a blanket removal of the zero filter.
  // NOTE: this calls extractAmountsFromLine directly, so it pins the FUNCTION
  // DEFAULT only. The call-site wiring is pinned by the regression below.
  it("H11 control: an unlabelled zero is still not an amount", () => {
    expect(extractAmountsFromLine("Page 0 of 3")).not.toContain(0);
    expect(extractAmountsFromLine("Reference 0")).not.toContain(0);
  });

  // H11 regression. An "incl. VAT" line describes a COMPONENT that contains
  // tax; it does not state the document's VAT. Retaining its zero let the
  // assignment loop's first-wins guard (`totalVat === undefined &&`) lock
  // total_vat to 0 before the real "VAT 24.00" line was read — destroying a
  // deductible 24.00, corrupting net 100 -> 124, and flagging it authoritative.
  // Free shipping on an invoice is routine, so this is a live-money path.
  //
  // This is also the ONLY test that pins the call-site's zero scoping: the
  // control above exercises extractAmountsFromLine's default, so with this
  // absent the call site could pass `includeZero: true` (or the wider
  // hasVatAmountLabel) and the whole suite would still pass.
  it("H11 does not let an 'incl. VAT' component zero override the real VAT line", () => {
    const result = extractAmounts(
      "Subtotal 100.00 EUR\nShipping incl. VAT 0.00 EUR\nVAT 24.00 EUR\nTotal 124.00 EUR",
    );
    expect(result).toMatchObject({
      total_net: 100, total_vat: 24, total_gross: 124, vat_explicit: true,
    });
  });

  // H11 regression, second mechanism. Here the zero IS on a real VAT-subject
  // line, so the label scoping above cannot help: a multi-rate table states
  // both a zero-rated and a standard-rated figure. The operative VAT is the
  // non-zero one, and there is no "%" token for the rate filter to catch, so
  // strict first-wins would lock 0 and silently destroy the 24.00 deduction.
  // A zero is authoritative only as the document's ONLY VAT statement.
  it("H11 lets a later non-zero VAT supersede a zero-rated line in a multi-rate table", () => {
    const result = extractAmounts("VAT zero rated 0.00\nVAT standard 24.00\nTotal 124.00");
    expect(result).toMatchObject({
      total_net: 100, total_vat: 24, total_gross: 124, vat_explicit: true,
    });
  });

  // The converse: the upgrade must NOT let a stray zero-VAT line demote a real
  // one, and the ONLY-statement zero must still survive. Ordering is the whole
  // point, so both directions are pinned.
  it("H11 keeps a non-zero VAT when a zero-rated line follows it", () => {
    const result = extractAmounts("VAT standard 24.00\nVAT zero rated 0.00\nTotal 124.00");
    expect(result).toMatchObject({ total_vat: 24, vat_explicit: true });
  });

  // Pins the zero retention to the line's OWN subject. Here a component says it
  // includes VAT and the document states NO VAT of its own, so there is nothing
  // to be authoritative about: claiming total_vat 0 / vat_explicit true would
  // invent a fact the receipt never stated (and rewrite net out of the gross).
  // Widening the call site to hasVatAmountLabel — whose "incl. VAT" branch
  // matches this line, and which reads the NEXT line too — makes exactly that
  // claim, and no other test distinguishes the two predicates.
  it("H11 does not invent a VAT figure from an 'incl. VAT' component alone", () => {
    const result = extractAmounts("Shipping incl. VAT 0.00 EUR\nTotal 124.00 EUR");
    expect(result.total_vat).toBeUndefined();
    expect(result.vat_explicit).toBe(false);
    expect(result.total_gross).toBe(124);
  });

  // The zero must NOT win when the document contradicts it. Subtotal 100 + VAT
  // 0 != Total 124, and on OCR text that is most often "24.00" misread with its
  // digits lost. Trusting the zero would rewrite the explicit net (100 -> 124),
  // discarding a stated amount to keep a contradicted one; deriving keeps both.
  // This is the pre-H11 result, and 32 shapes regressed on it before the
  // reconciliation was added — none of the other tests cover it.
  it("H11 does not let a contradicted zero VAT override an explicit net", () => {
    const result = extractAmounts("Subtotal 100.00 EUR\nVAT 0.00 EUR\nTotal 124.00 EUR");
    expect(result).toMatchObject({
      total_net: 100, total_vat: 24, total_gross: 124,
    });
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
  it("uses coordinates to pick the supplier column when text order favors the buyer", () => {
    const text = [
      "Ostja Müüja",
      "Buyer Wrong OÜ Correct Vendor OÜ",
      "Kokku 12.00",
    ].join("\n");
    const textItems = [
      { text: "Ostja", x: 20, y: 20, width: 35, height: 10, fontSize: 10 },
      { text: "Müüja", x: 300, y: 20, width: 40, height: 10, fontSize: 10 },
      { text: "Buyer Wrong OÜ", x: 20, y: 42, width: 110, height: 12, fontSize: 12 },
      { text: "Correct Vendor OÜ", x: 300, y: 42, width: 150, height: 12, fontSize: 12 },
      { text: "Kokku 12.00", x: 300, y: 220, width: 70, height: 10, fontSize: 10 },
    ] satisfies readonly LayoutTextItem[];

    expect(extractSupplierName(text, "invoice.pdf", textItems)).toBe("Correct Vendor OÜ");
  });

  it("extracts the supplier name below a müüja label in a multi-column layout", () => {
    const text = [
      "Saaja Müüja",
      "Buyer OÜ",
      "Tark Tarnija OÜ",
      "Invoice INV-1",
      "Kokku 12.00",
    ].join("\n");
    const textItems = [
      { text: "Saaja", x: 310, y: 34, width: 40, height: 10, fontSize: 10 },
      { text: "Müüja:", x: 24, y: 34, width: 42, height: 10, fontSize: 10 },
      { text: "Buyer OÜ", x: 310, y: 54, width: 68, height: 10, fontSize: 10 },
      { text: "Tark Tarnija OÜ", x: 24, y: 58, width: 120, height: 12, fontSize: 12 },
      { text: "Invoice INV-1", x: 24, y: 120, width: 90, height: 10, fontSize: 10 },
      { text: "Kokku 12.00", x: 320, y: 220, width: 72, height: 10, fontSize: 10 },
    ] satisfies readonly LayoutTextItem[];

    const result = extractReceiptFieldsFromText(text, "invoice.pdf", { textItems });

    expect(result.supplier_name).toBe("Tark Tarnija OÜ");
  });

  it("falls back to line heuristics when no text items are provided", () => {
    const text = "Müüja: Fallback Tarnija OÜ\nOstja: Buyer OÜ\nKokku 12.00";

    expect(extractSupplierName(text, "invoice.pdf")).toBe("Fallback Tarnija OÜ");
  });

  it("uses the largest font header in the supplier region", () => {
    const text = [
      "Müüja",
      "Tiny Services OÜ",
      "Dominant Header OÜ",
      "Ostja",
      "Buyer OÜ",
    ].join("\n");
    const textItems = [
      { text: "Müüja", x: 24, y: 20, width: 42, height: 10, fontSize: 10 },
      { text: "Tiny Services OÜ", x: 24, y: 44, width: 120, height: 9, fontSize: 9 },
      { text: "Dominant Header OÜ", x: 24, y: 66, width: 180, height: 18, fontSize: 18 },
      { text: "Ostja", x: 310, y: 20, width: 35, height: 10, fontSize: 10 },
      { text: "Buyer OÜ", x: 310, y: 44, width: 66, height: 10, fontSize: 10 },
    ] satisfies readonly LayoutTextItem[];

    expect(extractSupplierName(text, "invoice.pdf", textItems)).toBe("Dominant Header OÜ");
  });

  it("picks supplier name above the müüja marker within the above-window", () => {
    const text = [
      "Header Corp OÜ",
      "Müüja",
      "Kokku 12.00",
    ].join("\n");
    const textItems = [
      { text: "Header Corp OÜ", x: 24, y: 30, width: 130, height: 14, fontSize: 14 },
      { text: "Müüja", x: 24, y: 70, width: 42, height: 10, fontSize: 10 },
      { text: "Kokku 12.00", x: 24, y: 120, width: 70, height: 10, fontSize: 10 },
    ] satisfies readonly LayoutTextItem[];

    expect(extractSupplierName(text, "invoice.pdf", textItems)).toBe("Header Corp OÜ");
  });

  it("surfaces extraction_notes when layout and text supplier names disagree", () => {
    const text = [
      "Müüja: Text Vendor OÜ",
      "Ostja: Buyer OÜ",
      "Kokku 12.00",
    ].join("\n");
    const textItems = [
      { text: "Müüja:", x: 24, y: 34, width: 42, height: 10, fontSize: 10 },
      { text: "Layout Vendor OÜ", x: 24, y: 54, width: 120, height: 12, fontSize: 12 },
      { text: "Ostja:", x: 310, y: 34, width: 35, height: 10, fontSize: 10 },
      { text: "Buyer OÜ", x: 310, y: 54, width: 68, height: 10, fontSize: 10 },
      { text: "Kokku 12.00", x: 24, y: 120, width: 70, height: 10, fontSize: 10 },
    ] satisfies readonly LayoutTextItem[];

    const result = extractReceiptFieldsFromText(text, "invoice.pdf", { textItems });

    expect(result.supplier_name).toBe("Layout Vendor OÜ");
    expect(result.extraction_notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Supplier name conflict"),
    ]));
  });

  it("wraps supplier names inside layout conflict extraction notes", () => {
    const text = [
      "Müüja: Text Vendor OÜ",
      "Ostja: Buyer OÜ",
      "Kokku 12.00",
    ].join("\n");
    const textItems = [
      { text: "Müüja:", x: 24, y: 34, width: 42, height: 10, fontSize: 10 },
      { text: "Layout Vendor OÜ", x: 24, y: 54, width: 120, height: 12, fontSize: 12 },
      { text: "Ostja:", x: 310, y: 34, width: 35, height: 10, fontSize: 10 },
      { text: "Buyer OÜ", x: 310, y: 54, width: 68, height: 10, fontSize: 10 },
      { text: "Kokku 12.00", x: 24, y: 120, width: 70, height: 10, fontSize: 10 },
    ] satisfies readonly LayoutTextItem[];

    const result = extractReceiptFieldsFromText(text, "invoice.pdf", { textItems });
    const note = result.extraction_notes?.find(entry => entry.includes("Supplier name conflict"));

    expect(note).toContain("layout=\"<<UNTRUSTED_OCR_START:");
    expect(note).toContain("Layout Vendor OÜ");
    expect(note).toContain("text=\"<<UNTRUSTED_OCR_START:");
    expect(note).toContain("Text Vendor OÜ");
  });

  it("records coordinate provenance when supplier name comes from layout", () => {
    const text = [
      "Müüja: Text Vendor OÜ",
      "Ostja: Buyer OÜ",
      "Kokku 12.00",
    ].join("\n");
    const textItems = [
      { text: "Müüja:", x: 24, y: 34, width: 42, height: 10, fontSize: 10, pageNum: 1 },
      { text: "Layout Vendor OÜ", x: 24, y: 54, width: 120, height: 12, fontSize: 12, pageNum: 1 },
      { text: "Ostja:", x: 310, y: 34, width: 35, height: 10, fontSize: 10, pageNum: 1 },
      { text: "Buyer OÜ", x: 310, y: 54, width: 68, height: 10, fontSize: 10, pageNum: 1 },
      { text: "Kokku 12.00", x: 24, y: 120, width: 70, height: 10, fontSize: 10, pageNum: 1 },
    ] satisfies readonly LayoutTextItem[];

    const result = extractReceiptFieldsFromText(text, "invoice.pdf", { textItems });

    expect(result.field_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "supplier_name",
        value: "Layout Vendor OÜ",
        source: "coordinate",
        rationale: "layout_marker",
        pageNum: 1,
        bbox: { x: 24, y: 54, width: 120, height: 12 },
      }),
    ]));
  });

  it("prefers supplier candidate above buyer marker via beforeBuyerScore", () => {
    const text = [
      "Top Supplier OÜ",
      "Müüja",
      "Ostja",
      "Wrong Buyer OÜ",
    ].join("\n");
    const textItems = [
      { text: "Top Supplier OÜ", x: 24, y: 80, width: 130, height: 12, fontSize: 12 },
      { text: "Müüja", x: 24, y: 100, width: 42, height: 10, fontSize: 10 },
      { text: "Ostja", x: 24, y: 140, width: 35, height: 10, fontSize: 10 },
      { text: "Wrong Buyer OÜ", x: 24, y: 160, width: 100, height: 10, fontSize: 10 },
    ] satisfies readonly LayoutTextItem[];

    expect(extractSupplierName(text, "invoice.pdf", textItems)).toBe("Top Supplier OÜ");
  });

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
  it("treats a single-digit integer + one 3-digit group (1,234) as decimal 1.23 in Estonian context", () => {
    // A bare "1,234" (single leading digit, one 3-digit group, no dot) is
    // structurally identical to a 3-decimal Estonian unit price. Estonian uses
    // the comma as the decimal separator, so it must be read as 1.234 (rounded
    // to 1.23 cents), NOT as a thousands-grouped 1234. Multi-digit integers and
    // multi-group values below still keep the thousands interpretation.
    const text = "Kokku: 1,234 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(1.23);
  });

  it("treats 12,345 as 12345 (multi-digit integer keeps thousands interpretation)", () => {
    const text = "Kokku: 12,345 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(12345);
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

  it("handles negative single-digit + one group (-1,234) as decimal -1.23 in Estonian context", () => {
    // Mirrors the positive single-digit-group case: comma is decimal, so this
    // is -1.234 (rounded -1.23), not thousands-grouped -1234.
    const text = "Kokku: -1,234 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(-1.23);
  });

  it("reads a 3-decimal unit price 1,899 as ~1.9, not 1899 (Estonian fuel price)", () => {
    // "1,899 EUR" is an Estonian 3-decimal unit price (1.899 rounded to 1.90),
    // NOT a thousands-grouped 1899. Regression for the fuel-price misread.
    const text = "Kokku: 1,899 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(1.9);
    expect(result.total_gross).not.toBe(1899);
  });

  // PASS3 #3: comma-only vs dot-decimal context disambiguation for "N,NNN".
  it("reads a comma-only '1,899 EUR/l' as a 3-decimal ~1.9 (Estonian)", () => {
    expect(extractAmountsFromLine("1,899 EUR/l")).toContain(1.9);
  });

  it("reads '1,500' as English thousands 1500 when a dot-decimal sibling is on the line", () => {
    // A sibling "0.00" dot-decimal signals English formatting, so the bare
    // "1,500" is a thousands-grouped 1500, not a 3-decimal 1.5.
    const amounts = extractAmountsFromLine("Total 1,500 VAT 0.00");
    expect(amounts).toContain(1500);
    expect(amounts).not.toContain(1.5);
  });

  it("leaves '1,234.56' as 1234.56 regardless of context", () => {
    expect(extractAmountsFromLine("1,234.56")).toContain(1234.56);
  });

  // PASS4 #2: document-level (cross-line) locale detection. A bare "1,234" on
  // its own line must read the dot-/comma-decimal siblings on OTHER lines to
  // pick the right locale, not just its own line.
  it("reads a bare '1,234' as English thousands 1234 when a dot-decimal sibling is on ANOTHER line", () => {
    const text = "Subtotal 10.00 EUR\nTotal 1,234 EUR";
    const result = extractAmounts(text);
    expect(result.total_gross).toBe(1234);
  });

  it("keeps a bare '1,899 EUR/l' as ~1.9 when a comma-decimal sibling '12,50' is on ANOTHER line (Estonian)", () => {
    const amounts = extractAmountsFromLine("1,899 EUR/l", "Kütus 1,899 EUR/l\nKokku 12,50 €");
    expect(amounts).toContain(1.9);
    expect(amounts).not.toContain(1899);
  });

  it("does not treat an Estonian date as dot-decimal evidence for a bare comma total", () => {
    const result = extractAmounts("Kuupäev 15.03.2026\nKokku 1,899 EUR");

    expect(result.total_gross).toBe(1.9);
    expect(result.total_gross).not.toBe(1899);
  });

  it("does not treat an Estonian clock time as dot-decimal evidence for a bare comma total", () => {
    const result = extractAmounts("Kell 12.30\nKokku 1,899 EUR");

    expect(result.total_gross).toBe(1.9);
    expect(result.total_gross).not.toBe(1899);
  });

  it("reads '1,234.56' as 1234.56 even with a wide English document context", () => {
    const amounts = extractAmountsFromLine("1,234.56", "Subtotal 10.00\n1,234.56");
    expect(amounts).toContain(1234.56);
  });

  it("treats an accounting-style parenthesised '(124.00)' as -124", () => {
    expect(extractAmountsFromLine("Total (124.00) EUR")).toContain(-124);
  });

  it("keeps a normal '124.00' positive", () => {
    const amounts = extractAmountsFromLine("Total 124.00 EUR");
    expect(amounts).toContain(124);
    expect(amounts).not.toContain(-124);
  });

  it("does not negate a number embedded in prose parentheses like '(see note 3)'", () => {
    // The parenthesised content is not itself a number, so the 3 must not be
    // turned into a negative amount.
    expect(extractAmountsFromLine("(see note 3)")).not.toContain(-3);
  });
});

// ---------------------------------------------------------------------------
// extractAmountsFromLine — leading-minus discipline (Codex review #7)
// ---------------------------------------------------------------------------

describe("extractAmountsFromLine — leading minus (Codex review #7)", () => {
  it("does not manufacture negative amounts from a date like 2024-01-15", () => {
    const result = extractAmountsFromLine("2024-01-15");
    expect(result.some(value => value < 0)).toBe(false);
  });

  it("does not manufacture a negative from a numeric range 10-20", () => {
    const result = extractAmountsFromLine("10-20");
    expect(result.some(value => value < 0)).toBe(false);
    expect(result).toContain(10);
    expect(result).toContain(20);
  });

  it("honors a genuine leading minus at start of line", () => {
    expect(extractAmountsFromLine("-123.45")).toContain(-123.45);
  });

  it("honors a minus after whitespace", () => {
    expect(extractAmountsFromLine("Balance -50.00")).toContain(-50);
  });
});

// ---------------------------------------------------------------------------
// classifyLayoutAmountLabel — VAT before TOTAL (Codex review #1a)
// ---------------------------------------------------------------------------

describe("classifyLayoutAmountLabel (Codex review #1a)", () => {
  it("classifies 'Käibemaks kokku' as total_vat, not total_gross", () => {
    expect(classifyLayoutAmountLabel("Käibemaks kokku")).toBe("total_vat");
  });

  it("classifies a bare 'Käibemaks' as total_vat", () => {
    expect(classifyLayoutAmountLabel("Käibemaks")).toBe("total_vat");
  });

  it("keeps a 'with VAT' gross indicator 'Summa (km-ga)' as total_gross", () => {
    expect(classifyLayoutAmountLabel("Summa (km-ga)")).toBe("total_gross");
  });

  it("classifies a net 'Summa km-ta' label as total_net", () => {
    expect(classifyLayoutAmountLabel("Summa km-ta")).toBe("total_net");
  });

  it("classifies a plain 'Kokku' total as total_gross", () => {
    expect(classifyLayoutAmountLabel("Kokku")).toBe("total_gross");
  });

  it("classifies an English 'Total' as total_gross", () => {
    expect(classifyLayoutAmountLabel("Total")).toBe("total_gross");
  });

  // PASS3 #1: widened "includes VAT" guard — Estonian "sisaldab/sis. KM" and
  // English "VAT included/including VAT" name the gross, not the VAT.
  it("classifies 'Tasuda (sis. KM)' as total_gross", () => {
    expect(classifyLayoutAmountLabel("Tasuda (sis. KM)")).toBe("total_gross");
  });

  it("classifies 'Total (VAT included)' as total_gross", () => {
    expect(classifyLayoutAmountLabel("Total (VAT included)")).toBe("total_gross");
  });

  it("classifies 'Total including VAT' as total_gross", () => {
    expect(classifyLayoutAmountLabel("Total including VAT")).toBe("total_gross");
  });

  it("classifies 'Kokku (sisaldab KM 24%)' as total_gross", () => {
    expect(classifyLayoutAmountLabel("Kokku (sisaldab KM 24%)")).toBe("total_gross");
  });

  // PASS3 #5: a "with VAT" gross indicator with no TOTAL word must still win
  // over the trailing VAT fallback, not be misread as total_vat.
  it("classifies 'Hind käibemaksuga' (no TOTAL word) as total_gross", () => {
    expect(classifyLayoutAmountLabel("Hind käibemaksuga")).toBe("total_gross");
  });
});

// ---------------------------------------------------------------------------
// extractAmountsFromLayout — bottom-most VAT binding (Codex review #1b)
// ---------------------------------------------------------------------------

describe("extractAmountsFromLayout — bottom-most VAT binding (Codex review #1b)", () => {
  const makeItem = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 10, pageNum: 1,
  });

  it("binds total_vat to the bottom summary line, not a top per-line VAT value", () => {
    const items: LayoutTextItem[] = [
      // Top per-line VAT column value — must NOT lock the VAT binding.
      makeItem("Käibemaks", 0, 10, 80),
      makeItem("0.50", 200, 10, 40),
      // Net summary.
      makeItem("Summa km-ta", 0, 40, 100),
      makeItem("100.00", 200, 40, 50),
      // Bottom VAT summary — the authoritative total VAT.
      makeItem("Käibemaks kokku", 0, 70, 130),
      makeItem("21.00", 200, 70, 50),
      // Gross total.
      makeItem("Kokku", 0, 100, 60),
      makeItem("121.00", 200, 100, 60),
    ];

    const result = extractAmountsFromLayout(items);
    expect(result?.total_gross).toBe(121);
    expect(result?.total_vat).toBe(21);
    expect(result?.total_net).toBe(100);
  });

  it("drops a negative VAT from layout extraction before it can derive an inflated net", () => {
    const items: LayoutTextItem[] = [
      makeItem("Käibemaks", 0, 40, 90),
      makeItem("-5.00", 200, 40, 45),
      makeItem("Kokku", 0, 70, 60),
      makeItem("100.00", 200, 70, 55),
    ];

    const result = extractAmountsFromLayout(items);

    expect(result?.total_gross).toBe(100);
    expect(result?.total_vat).toBeUndefined();
    expect(result?.total_net).not.toBe(105);
  });

  it("binds a combined VAT and total summary row to the VAT column", () => {
    const items: LayoutTextItem[] = [
      makeItem("Käibemaks kokku", 0, 40, 130),
      makeItem("20.00", 150, 40, 45),
      makeItem("Kokku", 230, 40, 60),
      makeItem("120.00", 330, 40, 55),
    ];

    const result = extractAmountsFromLayout(items);

    expect(result?.total_vat).toBe(20);
    expect(result?.total_vat).not.toBe(120);
    expect(result?.total_net).toBe(100);
    expect(result?.total_gross).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// extractAmountsFromLayout — multi-rate VAT summation (PASS3 #6)
// ---------------------------------------------------------------------------

describe("extractAmountsFromLayout — multi-rate VAT with no summary (PASS3 #6)", () => {
  const makeItem = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 10, pageNum: 1,
  });

  it("sums distinct per-rate VAT rows instead of taking the bottom-most row", () => {
    const items: LayoutTextItem[] = [
      // Two per-rate VAT rows, no "kokku" VAT summary line. The bottom-most row
      // (KM 20% -> 1.90) must NOT shadow the whole VAT charged.
      makeItem("KM 24%", 0, 10, 60),
      makeItem("2.38", 200, 10, 40),
      makeItem("KM 20%", 0, 25, 60),
      makeItem("1.90", 200, 25, 40),
      makeItem("Kokku", 0, 40, 60),
      makeItem("24.28", 200, 40, 50),
    ];

    const result = extractAmountsFromLayout(items);
    expect(result?.total_gross).toBe(24.28);
    expect(result?.total_vat).toBe(4.28);
  });

  it("keeps the finding's KM 24% row when a KM 0% row contributes nothing", () => {
    const items: LayoutTextItem[] = [
      makeItem("KM 24%", 0, 10, 60),
      makeItem("2.38", 200, 10, 40),
      makeItem("KM 0%", 0, 25, 60),
      makeItem("0.00", 200, 25, 40),
      makeItem("Kokku", 0, 40, 60),
      makeItem("12.38", 200, 40, 50),
    ];

    const result = extractAmountsFromLayout(items);
    expect(result?.total_gross).toBe(12.38);
    expect(result?.total_vat).toBe(2.38);
  });

  it("defers to the 'kokku' VAT summary line when one exists (no summation)", () => {
    const items: LayoutTextItem[] = [
      makeItem("KM 24%", 0, 10, 60),
      makeItem("2.38", 200, 10, 40),
      makeItem("KM 20%", 0, 25, 60),
      makeItem("1.90", 200, 25, 40),
      makeItem("Käibemaks kokku", 0, 40, 130),
      makeItem("4.28", 200, 40, 40),
      makeItem("Kokku", 0, 55, 60),
      makeItem("24.28", 200, 55, 50),
    ];

    const result = extractAmountsFromLayout(items);
    expect(result?.total_gross).toBe(24.28);
    expect(result?.total_vat).toBe(4.28);
  });

  // PASS4 #3: breakdown rows with BOTH a taxable-base column AND a VAT column
  // "KM 24% | 10.00 | 2.40". The nearest right-side amount is the base (10.00);
  // total_vat must bind to the RIGHTMOST amount (the VAT column) so the sum is
  // the VAT charged (2.40), not a sum of bases (15.00).
  it("binds a multi-rate VAT row to the rightmost (VAT) column, not the base column", () => {
    const items: LayoutTextItem[] = [
      makeItem("KM 24%", 0, 10, 60),
      makeItem("10.00", 150, 10, 45),
      makeItem("2.40", 260, 10, 40),
      makeItem("KM 0%", 0, 25, 60),
      makeItem("5.00", 150, 25, 45),
      makeItem("0.00", 260, 25, 40),
      makeItem("Kokku", 0, 40, 60),
      makeItem("17.40", 260, 40, 50),
    ];

    const result = extractAmountsFromLayout(items);
    expect(result?.total_gross).toBe(17.4);
    expect(result?.total_vat).toBe(2.4);
    expect(result?.total_vat).not.toBe(15);
  });

  it("keeps the single-amount 'KM 24% 2.38' + 'KM 0% 0.00' case at 2.38 (rightmost = only amount)", () => {
    const items: LayoutTextItem[] = [
      makeItem("KM 24%", 0, 10, 60),
      makeItem("2.38", 200, 10, 40),
      makeItem("KM 0%", 0, 25, 60),
      makeItem("0.00", 200, 25, 40),
      makeItem("Kokku", 0, 40, 60),
      makeItem("12.38", 200, 40, 50),
    ];

    const result = extractAmountsFromLayout(items);
    expect(result?.total_vat).toBe(2.38);
  });
});

// ---------------------------------------------------------------------------
// mergeLayoutAmounts — VAT conflict + net re-derivation (Codex review #1c/#2)
// ---------------------------------------------------------------------------

describe("mergeLayoutAmounts (Codex review #1c/#2)", () => {
  it("prefers a correct explicit text VAT over a wrong layout VAT and re-derives net (#1c)", () => {
    const layoutAmounts: ExtractedAmountsWithMetadata = {
      total_net: 115,
      total_vat: 5,
      total_gross: 120,
      vat_explicit: true,
      provenance: [
        { field: "total_net", value: 115, source: "coordinate", rationale: "layout_label_binding" },
        { field: "total_vat", value: 5, source: "coordinate", rationale: "layout_label_binding" },
        { field: "total_gross", value: 120, source: "coordinate", rationale: "layout_label_binding" },
      ],
    };
    const textAmounts: ExtractedAmountsWithMetadata = {
      total_net: 100,
      total_vat: 20,
      total_gross: 120,
      vat_explicit: true,
      provenance: [
        { field: "total_vat", value: 20, source: "label", rationale: "explicit_vat_line" },
      ],
    };

    const result = mergeLayoutAmounts(layoutAmounts, textAmounts);
    expect(result.total_gross).toBe(120);
    expect(result.total_vat).toBe(20);
    expect(result.total_net).toBe(100);
  });

  it("re-derives net after preferring the text gross so net + vat = gross (#2)", () => {
    const layoutAmounts: ExtractedAmountsWithMetadata = {
      total_net: 100,
      total_vat: 20,
      total_gross: 120,
      vat_explicit: true,
      provenance: [
        { field: "total_net", value: 100, source: "coordinate", rationale: "layout_label_binding" },
        { field: "total_vat", value: 20, source: "coordinate", rationale: "layout_label_binding" },
        { field: "total_gross", value: 120, source: "coordinate", rationale: "layout_label_binding" },
      ],
    };
    const textAmounts: ExtractedAmountsWithMetadata = {
      total_gross: 150,
      vat_explicit: false,
      provenance: [
        { field: "total_gross", value: 150, source: "label", rationale: "explicit_total_line" },
      ],
    };

    const result = mergeLayoutAmounts(layoutAmounts, textAmounts);
    expect(result.total_gross).toBe(150);
    expect(result.total_vat).toBe(20);
    expect(result.total_net).toBe(130);
  });

  // PASS3 #4: when the trio-drop branch clears total_vat and no text fallback
  // qualifies, vat_explicit must be false — not a leaked stale layout flag.
  it("reports vat_explicit false when the trio-drop clears total_vat (#4)", () => {
    const layoutAmounts: ExtractedAmountsWithMetadata = {
      total_vat: 150,
      total_gross: 100,
      vat_explicit: true,
      provenance: [
        { field: "total_vat", value: 150, source: "coordinate", rationale: "layout_label_binding" },
        { field: "total_gross", value: 100, source: "coordinate", rationale: "layout_label_binding" },
      ],
    };
    const textAmounts: ExtractedAmountsWithMetadata = {
      vat_explicit: false,
      provenance: [],
    };

    const result = mergeLayoutAmounts(layoutAmounts, textAmounts);
    expect(result.total_vat).toBeUndefined();
    expect(result.vat_explicit).toBe(false);
  });

  // PASS4 #5: a negative layout VAT must never re-derive net (that would keep
  // the bad VAT and inflate net); it is dropped so text fallbacks supply
  // consistent values.
  it("drops a negative layout VAT instead of re-deriving net from it (#5)", () => {
    const layoutAmounts: ExtractedAmountsWithMetadata = {
      total_net: 100,
      total_vat: -5,
      total_gross: 100,
      vat_explicit: true,
      provenance: [
        { field: "total_net", value: 100, source: "coordinate", rationale: "layout_label_binding" },
        { field: "total_vat", value: -5, source: "coordinate", rationale: "layout_label_binding" },
        { field: "total_gross", value: 100, source: "coordinate", rationale: "layout_label_binding" },
      ],
    };
    const textAmounts: ExtractedAmountsWithMetadata = {
      vat_explicit: false,
      provenance: [],
    };

    const result = mergeLayoutAmounts(layoutAmounts, textAmounts);
    expect(result.total_gross).toBe(100);
    expect(result.total_vat).toBeUndefined();
    expect(result.total_vat).not.toBe(-5);
    expect(result.total_net).not.toBe(105);
    expect(result.vat_explicit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildKeywordSuggestion — transport-before-bank ordering (Codex review #3)
// ---------------------------------------------------------------------------

describe("buildKeywordSuggestion — transport before bank (Codex review #3)", () => {
  const accounts = [
    makeAccount({ id: 5100, name_est: "Transpordikulud", name_eng: "Transport costs" }),
    makeAccount({ id: 5200, name_est: "Pangateenustasud", name_eng: "Bank service fees" }),
    makeAccount({ id: 5300, name_est: "Toitlustuskulud", name_eng: "Food and restaurant" }),
    makeAccount({ id: 5990, name_est: "Muud tegevuskulud", name_eng: "Other expenses" }),
  ];
  const articles = [
    { id: 20, name_est: "Transpordikulu", name_eng: "Transport expense", accounts_id: 5100 },
    { id: 30, name_est: "Pangateenustasu", name_eng: "Bank service fee", accounts_id: 5200 },
    { id: 40, name_est: "Toitlustus", name_eng: "Food and restaurant", accounts_id: 5300 },
    { id: 99, name_est: "Muu kulu", name_eng: "Other expense", accounts_id: 5990 },
  ];

  it("routes 'Bolt teenustasu' to transport, not bank fees", () => {
    const result = buildKeywordSuggestion(articles, accounts, "Bolt teenustasu");
    expect(result?.suggested_purchase_article?.id).toBe(20);
    expect(result?.suggested_purchase_article?.id).not.toBe(30);
  });

  it("routes 'parking fee' to transport, not bank fees", () => {
    const result = buildKeywordSuggestion(articles, accounts, "parking fee");
    expect(result?.suggested_purchase_article?.id).toBe(20);
  });

  it("routes 'Wolt service charge' to food/representation, not bank fees", () => {
    const result = buildKeywordSuggestion(articles, accounts, "Wolt service charge");
    expect(result?.suggested_purchase_article?.id).toBe(40);
    expect(result?.suggested_purchase_article?.id).not.toBe(30);
  });

  it("still routes a genuine bank fee to bank fees", () => {
    const result = buildKeywordSuggestion(articles, accounts, "Bank haldustasu");
    expect(result?.suggested_purchase_article?.id).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// suggestBookingInternal — tolerates transient GET failures (Codex review #5)
// ---------------------------------------------------------------------------

describe("suggestBookingInternal — allSettled tolerance (Codex review #5)", () => {
  it("skips an invoice whose GET rejects and still uses a later fulfilled invoice", async () => {
    const api = {
      purchaseInvoices: {
        get: async (id: number) => {
          if (id === 1) throw new Error("transient 503");
          return {
            id: 2,
            number: "INV-2",
            liability_accounts_id: 2110,
            items: [
              { custom_title: "Cloud hosting", cl_purchase_articles_id: 10, purchase_accounts_id: 4920 },
            ],
          };
        },
      },
    };
    const context = {
      purchaseInvoices: [
        { id: 1, clients_id: 7, status: "CONFIRMED", create_date: "2024-02-01" },
        { id: 2, clients_id: 7, status: "CONFIRMED", create_date: "2024-01-01" },
      ],
      purchaseArticlesWithVat: [
        { id: 10, name_est: "Serverikulu", name_eng: "Hosting", accounts_id: 4920 },
      ],
      accounts: [makeAccount({ id: 4920, name_est: "Serveriteenus" })],
    };

    const result = await suggestBookingInternal(api, context, 7, "hosting");
    expect(result?.source).toBe("supplier_history");
    expect(result?.matched_invoice_id).toBe(2);
    expect(result?.suggested_purchase_article?.id).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// computeMinOcrConfidence — small-sample robust minimum (Codex review #6)
// ---------------------------------------------------------------------------

describe("computeMinOcrConfidence — small-sample robust minimum (Codex review #6)", () => {
  it("ignores a <3-char noise item's low confidence in the small-sample branch", () => {
    const items = [
      { text: "Total 12.00", x: 0, y: 0, width: 80, height: 10, confidence: 0.90 },
      { text: "Acme OÜ", x: 0, y: 20, width: 60, height: 10, confidence: 0.85 },
      { text: ".", x: 0, y: 40, width: 5, height: 10, confidence: 0.10 },
    ];
    // Only 2 robust (>=3 char) items -> small-sample branch, but the min must be
    // taken over robust values (0.85), NOT the unfiltered min (0.10 noise).
    expect(computeMinOcrConfidence(items)).toBe(0.85);
  });
});
