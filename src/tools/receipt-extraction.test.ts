import { describe, it, expect } from "vitest";
import type { Account } from "../types/api.js";
import type { LayoutTextItem } from "../document-identifiers.js";
import {
  normalizeDate,
  extractDates,
  extractInvoiceNumber,
  extractPaymentReferences,
  toIsoDate,
  extractAmountsWithMetadata,
  buildKeywordSuggestion,
  computeMinOcrConfidence,
  computeTermDays,
  detectReverseChargeFromText,
  extractPdfIdentifiers,
  findAccountByKeywords,
  isExpenseBookableAccount,
  findPurchaseArticleByKeywords,
  hasRecurringSimilarAmounts,
  normalizeCounterpartyName,
  looksLikePersonCounterparty,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  getAutoBookedVatConfig,
  extractReceiptFieldsFromText,
  inferSupplierCountry,
  extractSupplierNameWithNotes,
  classifyLayoutAmountLabel,
  extractAmountsFromLine,
  extractAmountsFromLayout,
  mergeLayoutAmounts,
  suggestBookingInternal,
  categorizeTransactionGroup,
  classifyReceiptDocument,
  detectReceiptCurrency,
  amountConsistencyIssues,
} from "./receipt-extraction.js";
import type { ExtractedAmountsWithMetadata } from "./receipt-extraction.js";
import { summarizeInvoiceExtraction } from "../invoice-extraction-fallback.js";

function extractAmounts(text: string): Omit<ExtractedAmountsWithMetadata, "provenance"> {
  const { provenance: _provenance, ...amounts } = extractAmountsWithMetadata(text);
  return amounts;
}

function extractSupplierName(text: string, fallbackFileName: string, textItems?: readonly LayoutTextItem[]): string | undefined {
  return extractSupplierNameWithNotes(text, fallbackFileName, textItems).name;
}

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
  it.each([
    ["passes through ISO dates unchanged", "2024-03-15", "2024-03-15"],
    ["parses DD.MM.YYYY", "15.03.2024", "2024-03-15"],
    ["parses single-digit day and month DD.MM.YYYY", "5.3.2024", "2024-03-05"],
    ["parses DD/MM/YYYY", "15/03/2024", "2024-03-15"],
    ["parses single-digit DD/MM/YYYY", "5/3/2024", "2024-03-05"],
    ["parses 2-digit year (00-69 → 2000s)", "15.03.24", "2024-03-15"],
    ["parses 2-digit year (70-99 → 1900s)", "15.03.99", "1999-03-15"],
    // The Unicode-aware pattern requires "15. märts 2024" (with dot)
    ["parses Estonian textual month with dot separator (day-first)", "15. märts 2024", "2024-03-15"],
    ["parses English textual month (day-first)", "15 March 2024", "2024-03-15"],
    ["parses English textual month (month-first)", "March 15 2024", "2024-03-15"],
    ["parses English textual month with comma", "March 15, 2024", "2024-03-15"],
    ["strips weekday prefix before parsing", "monday, 15.03.2024", "2024-03-15"],
    ["strips Estonian weekday prefix before parsing", "esmaspäev, 15.03.2024", "2024-03-15"],
    ["handles Estonian month abbreviation 'jaan'", "5 jaan 2024", "2024-01-05"],
    ["handles Estonian month 'detsember'", "31 detsember 2023", "2023-12-31"],
    ["trims surrounding whitespace", "  2024-03-15  ", "2024-03-15"],
    // ISO-format but not a real calendar day — must not pass through.
    ["rejects impossible ISO dates (Feb 30)", "2026-02-30", undefined],
    ["rejects impossible ISO dates (month 13)", "2026-13-01", undefined],
    ["returns undefined for empty string", "", undefined],
    ["returns undefined for invalid date", "not-a-date", undefined],
    ["returns undefined for out-of-range date (Feb 30)", "30.02.2024", undefined],
    ["rejects impossible ISO dates (Feb 31)", "2026-02-31", undefined],
    ["rejects Feb 29 on a non-leap year", "29.02.2026", undefined],
    ["accepts Feb 29 on a leap year", "29.02.2024", "2024-02-29"],
    ["treats a pre-1900 year as an OCR misread (no date)", "0050-03-01", undefined],
    ["treats a pre-1900 year as an OCR misread (dmy)", "01.03.1899", undefined],
    ["accepts the 1900 floor", "01.03.1900", "1900-03-01"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it("toIsoDate yields no date (undefined) for impossible dates and pre-1900 years", () => {
    expect(toIsoDate(2026, 2, 31)).toBeUndefined();
    expect(toIsoDate(2026, 2, 29)).toBeUndefined();
    expect(toIsoDate(2024, 2, 29)).toBe("2024-02-29");
    expect(toIsoDate(50, 3, 1)).toBeUndefined();
    expect(toIsoDate(1899, 12, 31)).toBeUndefined();
    expect(toIsoDate(1900, 1, 1)).toBe("1900-01-01");
    expect(toIsoDate(50, 2, 29)).toBeUndefined();
  });

  it("extractDates ignores an impossible ISO invoice date", () => {
    expect(extractDates("Invoice date: 2026-02-30")).toEqual({});
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

  // Google Cloud EMEA Estonian 0% invoice layout (live 2026-09/10). The billing
  // period row "Kokkuvõte - 1. sept 2026 - 30. sept 2026" was taken as the
  // total ("kokku" inside "kokkuvõte"), and "Kogusumma" was not a total label,
  // so gross became the day number 30 and VAT was derived as 30 - net.
  it("does not read a 'Kokkuvõte' billing-period row as the gross total", () => {
    const text = [
      "Arve kuupäev     ....................      Kogusumma (EUR)                                               1,87 €",
      "Konto ID         ....................      Kokkuvõte - 1. sept 2026 - 30. sept 2026",
      "                                           Vahesumma (EUR)                                               1,87 €",
      "                                           Käibemaks (0%)                                                0,00 €",
      "                                           Kogusumma (EUR)                                               1,87 €",
      "Google Cloudi tasu - september 2026                         1,87",
    ].join("\n");
    expect(extractAmounts(text)).toMatchObject({ total_net: 1.87, total_vat: 0, total_gross: 1.87 });
  });

  it("treats 'Kogusumma' as a gross total label", () => {
    expect(extractAmounts("Kogusumma (EUR) 13,60 €").total_gross).toBe(13.6);
  });

  it("does not take the day number of a textual date on a total line as an amount", () => {
    expect(extractAmounts("Kokku perioodil 1. sept 2026 - 30. sept 2026").total_gross).toBeUndefined();
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

describe("automatic VAT fallback default", () => {
  it("defaults unmatched auto-bookings to no VAT and keeps gross as net", () => {
    const vatConfig = getAutoBookedVatConfig();
    expect(vatConfig).toEqual({ vat_rate_dropdown: "-" });
    expect(deriveAutoBookedNetAmount(100, vatConfig)).toBe(100);
    expect(deriveAutoBookedVatPrice(100, vatConfig)).toBe(0);
  });
});

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

describe("buildKeywordSuggestion — expense accounts only (live smoke 0.29.2)", () => {
  // Live chart: purchase article "Arvutitarkvara" is bound to 1972
  // "Arvutitarkvara akumuleeritud kulum" — a Varad contra-asset that is NOT
  // flagged is_fixed_asset — and won the SaaS keyword match for an Anthropic receipt.
  const contra = makeAccount({ id: 1972, name_est: "Arvutitarkvara akumuleeritud kulum", account_type_est: "Varad", account_type_eng: "Assets", balance_type: "C" });
  const software = makeAccount({ id: 4800, name_est: "Tarkvara ja litsentsid", account_type_est: "Kulud", account_type_eng: "Expenses" });
  const other = makeAccount({ id: 5990, name_est: "Muud mitmesugused tegevuskulud", account_type_est: "Kulud", account_type_eng: "Expenses" });
  const assetArticle = { id: 14, name_est: "Arvutitarkvara", name_eng: "Computer software", accounts_id: 1972 };
  const expenseArticle = { id: 31, name_est: "Tarkvara kulu", name_eng: "Software expense", accounts_id: 4800 };
  const otherArticle = { id: 99, name_est: "Muu kulu", name_eng: "Other expense", accounts_id: 5990 };

  it("prefers an expense-bound article over an asset article for a SaaS hint", () => {
    const result = buildKeywordSuggestion([assetArticle, expenseArticle, otherArticle], [contra, software, other], "Anthropic, PBC Claude Max subscription software");
    expect(result?.suggested_account?.id).toBe(4800);
    expect(result?.suggested_purchase_article?.id).toBe(31);
    expect(result?.item.purchase_accounts_id).toBe(4800);
  });

  it("never suggests the contra-asset account, even when only the asset article matches", () => {
    const result = buildKeywordSuggestion([assetArticle, otherArticle], [contra, software, other], "Anthropic Claude subscription software");
    expect(result?.suggested_account?.id).not.toBe(1972);
    expect(result?.suggested_account?.account_type_est).toBe("Kulud");
    expect(result?.item.purchase_accounts_id).toBe(result?.suggested_account?.id);
  });

  it("returns undefined when no expense account exists", () => {
    const result = buildKeywordSuggestion([assetArticle], [contra], "Anthropic Claude subscription software");
    expect(result).toBeUndefined();
  });

  it("isExpenseBookableAccount: Kulud yes; Varad, fixed assets no; untyped allowed", () => {
    expect(isExpenseBookableAccount(software)).toBe(true);
    expect(isExpenseBookableAccount(contra)).toBe(false);
    expect(isExpenseBookableAccount(makeAccount({ id: 2310, name_est: "Võlad tarnijatele", account_type_est: "Kohustused" }))).toBe(false);
    expect(isExpenseBookableAccount(makeAccount({ id: 1810, name_est: "Ehitised", is_fixed_asset: true }))).toBe(false);
    expect(isExpenseBookableAccount(makeAccount({ id: 5000, name_est: "Kulu" }))).toBe(true);
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

// ---------------------------------------------------------------------------
// Finding 1 — gross must never be picked from a net-total line
// ---------------------------------------------------------------------------

describe("gross total excludes net-labelled total lines", () => {
  it("picks the real gross, not 'Kokku km-ta', when a VAT line follows the net line", () => {
    const amounts = extractAmounts(["Arve nr 12", "Kokku km-ta 50,00", "KM 24% 12,00", "Kokku 62,00"].join("\n"));
    expect(amounts.total_gross).toBe(62);
    expect(amounts.total_net).toBe(50);
    expect(amounts.total_vat).toBe(12);
  });

  it.each([
    ["Total excl. VAT 50.00"],
    ["Total excluding VAT 50.00"],
    ["Total ex VAT 50.00"],
    ["Kokku ilma KM 50,00"],
    ["Net total 50.00"],
  ])("treats %s as a net line, not a gross candidate", (netLine) => {
    const amounts = extractAmounts(["Invoice 12", netLine, "VAT 24% 12.00", "Total 62.00"].join("\n"));
    expect(amounts.total_gross).toBe(62);
    expect(amounts.total_net).toBe(50);
  });

  it("does not let the NEXT line's VAT word lift a preceding partial total over the payable total", () => {
    const amounts = extractAmounts(["Arve nr 12", "Kokku 50,00", "KM 24% 12,00", "Tasuda 62,00"].join("\n"));
    expect(amounts.total_gross).toBe(62);
  });

  it("classifies 'Kokku km-ta' / 'Total excl. VAT' layout labels as net", () => {
    expect(classifyLayoutAmountLabel("Kokku km-ta")).toBe("total_net");
    expect(classifyLayoutAmountLabel("Total excl. VAT")).toBe("total_net");
    expect(classifyLayoutAmountLabel("Kokku km-ga")).toBe("total_gross");
  });

  it("flags total_gross_conflict when layout and text gross disagree", () => {
    const layout: ExtractedAmountsWithMetadata = { total_gross: 999, provenance: [] };
    const text: ExtractedAmountsWithMetadata = { total_gross: 124, provenance: [] };
    expect(mergeLayoutAmounts(layout, text).total_gross_conflict).toBe(true);
    const agree: ExtractedAmountsWithMetadata = { total_gross: 124, provenance: [] };
    expect(mergeLayoutAmounts(agree, text).total_gross_conflict).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Findings 10/11 — invoice number and invoice date labels
// ---------------------------------------------------------------------------

describe("extractInvoiceNumber hardening (finding 10)", () => {
  it("does not capture a label-only line's next-line text across a newline", () => {
    const number = extractInvoiceNumber("Invoice number:\nPO12345\nTotal 10.00", "scan.pdf");
    expect(number).toMatch(/^AUTO-/);
  });

  it("requires a digit in the captured number", () => {
    expect(extractInvoiceNumber("Invoice No: PENDING", "scan.pdf")).toMatch(/^AUTO-/);
  });

  it("rejects a date-shaped capture", () => {
    expect(extractInvoiceNumber("Receipt no. 12/03/2024", "scan.pdf")).toMatch(/^AUTO-/);
  });

  it("rejects real calendar dates in ISO, dotted and slashed layouts", () => {
    expect(extractInvoiceNumber("Invoice no: 2024-03-12", "scan.pdf")).toMatch(/^AUTO-/);
    expect(extractInvoiceNumber("Receipt no. 12/03/24", "scan.pdf")).toMatch(/^AUTO-/);
    expect(extractInvoiceNumber("Dokument no. 12.03.2024", "scan.pdf")).toMatch(/^AUTO-/);
  });

  it("keeps date-shaped invoice numbers that are not real calendar dates", () => {
    expect(extractInvoiceNumber("Arve nr: 2025-09-012", "scan.pdf")).toBe("2025-09-012");
    expect(extractInvoiceNumber("Invoice no: 2024-12-0005", "scan.pdf")).toBe("2024-12-0005");
    expect(extractInvoiceNumber("Arve nr: 25-10-100", "scan.pdf")).toBe("25-10-100");
    expect(extractInvoiceNumber("Invoice no: 2025-02-31", "scan.pdf")).toBe("2025-02-31");
  });

  it("never changes the captured number, but holds one that looks cut short as invoice_number_ambiguous (Codex review)", () => {
    const fields = (line: string) => extractReceiptFieldsFromText(["Näidis OÜ", line, "Kokku 10.00"].join("\n"), "x.pdf");
    for (const [line, number] of [
      ["Arve nr AB1.234", "AB1"],
      ["Arve nr AB1,234", "AB1"],
      ["Arve nr INV-0042.Date: 20.03.2026", "INV-0042"],
      ["Invoice AB1.234", "AB1"],
      ["Dokument no. AB1.234", "AB1"],
      // A clean capture of the same value does not hide the cut-short one (Codex round 3).
      ["Arve nr AB1\nArve nr AB1.234", "AB1"],
      ["Arve nr AB1.234\nArve nr AB1", "AB1"],
      ["Arve nr AB1\nTellimuse number ORD1.55", "AB1"],
    ] as const) {
      expect(fields(line).invoice_number).toBe(number);
      expect(fields(line).invoice_number_ambiguous).toBe(true);
    }
    for (const [line, number] of [
      ["Arve nr INV-0042", "INV-0042"],
      ["Arve nr INV-0042.", "INV-0042"],
      ["Invoice no: 2024/001", "2024/001"],
      ["Arve nr AB1234, kuupäev 20.03.2026", "AB1234"],
    ] as const) {
      expect(fields(line).invoice_number).toBe(number);
      expect(fields(line).invoice_number_ambiguous).toBeUndefined();
    }
  });

  it("ranks an invoice/arve label over an earlier order/booking label", () => {
    const text = "Order number: ORD-555001\nArve nr: 2024-117\nTotal 10.00";
    expect(extractInvoiceNumber(text, "scan.pdf")).toBe("2024-117");
  });

  it("skips reference / account / phone lines in the generic fallback", () => {
    const text = ["Viitenumber nr 1234567", "Konto nr EE123456789012345678", "Tel nr 5551234", "Dokument no. 88123"].join("\n");
    expect(extractInvoiceNumber(text, "scan.pdf")).toBe("88123");
  });

  it("uses a word boundary in the fallback (no 'no' inside another word)", () => {
    expect(extractInvoiceNumber("Casino 12345 Tallinn", "scan.pdf")).toMatch(/^AUTO-/);
  });

  it("does not read a tax / VAT number label as the invoice number (corpus #25, Twilio)", () => {
    const twilio = [
      "Näidis Ireland Limited",
      "VAT Registration Number: IE1234567AB",
      "RECEIPT",
      "Tax Number: EE123456007",
      "Date 01 September - 06 September, 2026",
      "Total Paid $20.00",
    ].join("\n");
    expect(extractInvoiceNumber(twilio, "receipt.pdf")).toMatch(/^AUTO-/);
    for (const line of ["KM-number: EE123456007", "KM nr EE123456007", "Tax No. EE123456007", "KM reg nr EE123456007"]) {
      expect(extractInvoiceNumber(line, "receipt.pdf")).toMatch(/^AUTO-/);
    }
    // Regression pins: Tax ID stays excluded, a plain "Number:" is still read.
    expect(extractInvoiceNumber("Tax ID: EE123456007", "receipt.pdf")).toMatch(/^AUTO-/);
    expect(extractInvoiceNumber("Number: 12345", "receipt.pdf")).toBe("12345");

    const fields = extractReceiptFieldsFromText(twilio, "receipt.pdf");
    expect(fields.invoice_number).toMatch(/^AUTO-/);
    expect(summarizeInvoiceExtraction(fields).missing_required_fields).toContain("invoice_number");
  });

  it("skips only the tax-labelled match, so a mixed-column line keeps its cut-short evidence (Codex P0 review)", () => {
    for (const text of [
      "Invoice nr AB1\nNumber: AB1.234    Tax number: EE123456007",
      "Invoice nr AB1\nTax number: EE123456007    Number: AB1.234",
    ]) {
      expect(extractInvoiceNumber(text, "x.pdf")).toBe("AB1");
      const fields = extractReceiptFieldsFromText(text, "x.pdf");
      expect(fields.invoice_number).toBe("AB1");
      expect(fields.invoice_number_ambiguous).toBe(true);
    }
    // The non-tax column of a mixed line is still the fallback number.
    expect(extractInvoiceNumber("Tax number: EE123456007    Number: 12345", "x.pdf")).toBe("12345");
  });

  it("keeps every cut-short capture on a tax-labelled line as evidence, not only the selected one (Codex P0 code review)", () => {
    for (const text of [
      // A later cut-short column behind a clean one.
      "Invoice nr AB1\nTax number: EE123456007.X    Number: AB1    Number: AB1.X",
      "Invoice nr AB1\nTax number: EE123456007    Number: AB1    Number: AB1.X",
      // The tax capture itself continuing past a delimiter held before the skip too.
      "Invoice nr AB1\nTax number: EE123456007.X",
    ]) {
      expect(extractInvoiceNumber(text, "x.pdf")).toBe("AB1");
      const fields = extractReceiptFieldsFromText(text, "x.pdf");
      expect(fields.invoice_number).toBe("AB1");
      expect(fields.invoice_number_ambiguous).toBe(true);
    }
    // The selected fallback number is unchanged: the first non-tax column.
    expect(extractInvoiceNumber("Tax number: EE123456007    Number: 12345    Number: 67890", "x.pdf")).toBe("12345");
  });
});

describe("extractDates invoice-date label precedence (finding 11)", () => {
  it("prefers an explicit invoice-date label over an earlier generic/delivery date", () => {
    const text = "Delivery date: 2024-03-01\nInvoice date: 2024-03-05\nDue date: 2024-03-19";
    expect(extractDates(text)).toEqual({ invoice_date: "2024-03-05", due_date: "2024-03-19" });
  });

  it("does not take a generic 'date' that is the tail of a due/order/payment label", () => {
    const text = "Payment date 2024-04-10\nOrder date 2024-03-28\nDate: 2024-04-01\nDue date 2024-04-15";
    expect(extractDates(text).invoice_date).toBe("2024-04-01");
  });

  it("does not treat 'Tarne kuupäev' as the invoice date", () => {
    const text = "Tarne kuupäev 01.03.2024\nKuupäev 05.03.2024";
    expect(extractDates(text).invoice_date).toBe("2024-03-05");
  });
});

describe("extractDates unlabelled fallback is flagged, never re-picked (corpus #11, Google)", () => {
  it("flags the first-dates fallback and keeps its values", () => {
    expect(extractDates("Kokkuvõte – 1. juuli 2026 - 31. juuli 2026")).toEqual({
      invoice_date: "2026-07-01",
      due_date: "2026-07-31",
      invoice_date_unlabelled: true,
    });
    // The Google shape: the label survives, its value is lost to dots.
    const google = extractDates("Arve kuupäev     ....................\nKokkuvõte - 1. juuli 2026 - 31. juuli 2026");
    expect(google.invoice_date).toBe("2026-07-01");
    expect(google.invoice_date_unlabelled).toBe(true);
  });

  it("does not flag a labelled invoice or due date, nor a page with no date", () => {
    expect(extractDates("Arve kuupäev 31.07.2026")).toEqual({ invoice_date: "2026-07-31", due_date: undefined });
    const dueOnly = extractDates("Maksetähtaeg 14.08.2026");
    expect(dueOnly.invoice_date).toBeUndefined();
    expect(dueOnly.invoice_date_unlabelled).toBeUndefined();
    expect(extractDates("Invoice date: 2026-02-30")).toEqual({});
  });

  it("carries the flag into the extracted fields and holds them as a creation-gating signal", () => {
    const fields = extractReceiptFieldsFromText(
      ["Näidis OÜ", "Arve nr INV-1", "Kokkuvõte - 1. juuli 2026 - 31. juuli 2026", "Kokku 10.00"].join("\n"),
      "x.pdf",
    );
    expect(fields.invoice_date).toBe("2026-07-01");
    expect(fields.invoice_date_unlabelled).toBe(true);
    expect(extractReceiptFieldsFromText("Näidis OÜ\nArve nr INV-1\nArve kuupäev 31.07.2026\nKokku 10.00", "x.pdf").invoice_date_unlabelled)
      .toBeUndefined();
  });
});

describe("categorizeTransactionGroup — mixed directions (bank-review MAJOR-2)", () => {
  it("routes a group mixing incoming and outgoing rows to review instead of reading transactions[0]", () => {
    const classification = categorizeTransactionGroup({
      normalized_counterparty: "openai",
      transactions: [
        { type: "C", amount: 25, date: "2026-03-01", description: "WISE:charge OpenAI [source_direction=OUT]", bank_subtype: null },
        { type: "D", amount: 25, date: "2026-03-05", description: "WISE:refund OpenAI refund [source_direction=IN]", bank_subtype: null },
      ],
    });
    expect(classification.apply_mode).toBe("review_only");
    expect(classification.reasons).toContain("mixed_transaction_directions");
  });
});

describe("detectReverseChargeFromText — negated phrases (MINOR)", () => {
  it.each([
    "This supply is not subject to reverse charge.",
    "No reverse charge.",
    "Reverse charge: not applicable",
    "Käive ei kuulu pöördmaksustamisele",
  ])("ignores a negated phrase: %s", (text) => {
    expect(detectReverseChargeFromText(text)).toBe(false);
  });

  it.each([
    "VAT not charged – reverse charge applies (Art. 196)",
    "Reverse charge: VAT to be accounted for by the recipient",
    "Pöördmaksustamine KMS § 41^1",
  ])("still detects an affirmative phrase: %s", (text) => {
    expect(detectReverseChargeFromText(text)).toBe(true);
  });
});

describe("computeTermDays — due date before invoice date (MINOR)", () => {
  it("clamps a due date before the invoice date to 0 instead of a positive term", () => {
    expect(computeTermDays("2026-08-10", "2026-08-01")).toBe(0);
    expect(computeTermDays("2026-08-01", "2026-08-15")).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// F-GROSSPICKER — dual-display card receipts
// ---------------------------------------------------------------------------

describe("dual-display card receipt pairs gross with its own currency (F-GROSSPICKER)", () => {
  // The company is the cardholder: its cardholder-currency (EUR) figure is what
  // the bank charged and is a valid gross. The defect is only the MISPAIRING —
  // the converted EUR figure booked under the merchant's foreign currency.
  const extract = (lines: string[]) => {
    const fields = extractReceiptFieldsFromText(lines.join("\n"), "receipt.pdf");
    return { gross: fields.total_gross, currency: fields.currency };
  };

  it.each([
    ["USD purchase smaller than the EUR figure", ["NYC Shop", "Purchase amount USD 80.00", "Cardholder amount EUR 90.00"], 80, "USD"],
    ["USD purchase larger than the EUR figure", ["NYC Shop", "Purchase amount USD 100.00", "Cardholder amount EUR 90.00"], 100, "USD"],
    ["GBP symbol purchase", ["Pub", "Amount £20.00", "Cardholder amount EUR 23.40"], 20, "GBP"],
    ["GBP slip with a rate line", ["Hotel London", "Transaction amount: GBP 100.00", "Exchange rate: 1 GBP = 1.1600 EUR", "Cardholder amount: EUR 116.00"], 100, "GBP"],
    ["Estonian cardholder label", ["Pood", "Ostusumma USD 80.00", "Kaardiomaniku summa EUR 90.00"], 80, "USD"],
    ["cardholder line with a total word", ["NYC Shop", "Purchase amount USD 80.00", "Total cardholder amount EUR 90.00"], 80, "USD"],
    // An exchange-rate figure is never the gross, even with its currency mark.
    ["Fexco slip, rate line, unmarked amounts", ["Hotel London", "Transaction currency: GBP", "Transaction amount: 100.00", "Exchange rate: 1 GBP = 1.1600 EUR", "Cardholder amount: EUR 116.00"], 100, "GBP"],
    ["Fexco slip, separate cardholder currency line", ["Hotel London", "Transaction currency: GBP", "Transaction amount: 100.00", "Exchange rate: 1 GBP = 1.1600 EUR", "Cardholder currency: EUR", "Cardholder amount: 116.00"], 100, "GBP"],
    ["abbreviated rate label", ["Restaurant NYC", "Amount 100.00", "Exch. rate 1 USD = 0.9000 EUR", "Cardholder amount EUR 90.00"], 100, "USD"],
    ["rate line with a margin line", ["Pub London", "Purchase amount 20.00", "Exchange rate 1 GBP = 1.1700 EUR", "Margin 3.5%", "Cardholder amount EUR 23.40"], 20, "GBP"],
    ["rate given as a pair", ["Hotel NYC", "Purchase 100.00", "Exchange rate USD/EUR 0.9000", "Cardholder amount EUR 90.00"], 100, "USD"],
  ])("books the merchant amount in its currency: %s", (_label, lines, gross, currency) => {
    expect(extract(lines)).toEqual({ gross, currency });
  });

  it.each([
    ["unmarked purchase amount", ["Shop OÜ", "Purchase amount 100.00", "Cardholder amount EUR 90.00"], 90],
    ["unmarked purchase amount, larger EUR figure", ["Shop OÜ", "Purchase amount 100.00", "Card holder amount EUR 110.00"], 110],
    ["rate line on the slip", ["Hotel London", "Purchase amount 100.00", "Cardholder amount EUR 116.00", "Exchange rate 1 GBP = 1.1600 EUR"], 116],
    ["DCC fee line on the slip", ["Pub", "Purchase amount 20.00", "DCC fee EUR 0.70", "Cardholder amount EUR 23.40"], 23.4],
    ["unsupported merchant currency with a rate line", ["Bangkok", "Transaction amount: THB 3,500.00", "Exchange rate: 1 THB = 0.0257 EUR", "Cardholder amount: EUR 90.00"], 90],
    ["cardholder figure among stray unlabelled numbers", ["Kohvik OÜ", "Laud 12", "Cardholder amount EUR 9.00"], 9],
    ["unsupported merchant currency with a reverse rate line", ["Prague", "Amount CZK 250.00", "Cardholder amount EUR 10.10", "Rate 1 EUR = 24.75 CZK"], 10.1],
  ])("keeps the cardholder EUR figure on a EUR document: %s", (_label, lines, gross) => {
    expect(extract(lines)).toEqual({ gross, currency: "EUR" });
  });

  it.each([
    ["CARDHOLDER COPY", ["Kohvik OÜ", "Cappuccino 3.80", "Kook 4.20", "EUR 8.00   CARDHOLDER COPY"]],
    ["CARDHOLDER RECEIPT", ["CARDHOLDER RECEIPT EUR 8.00", "Cappuccino 3.80", "Kook 4.20"]],
  ])("does not treat a %s heading as a cardholder amount", (_label, lines) => {
    expect(extract(lines)).toEqual({ gross: 8, currency: "EUR" });
  });

  it("drops only the rate numbers, not the rest of the line", () => {
    expect(extract(["Shop OÜ", "Total 100.00 EUR (1 EUR = 1.08 USD)"])).toEqual({ gross: 100, currency: "EUR" });
  });

  it("takes the line's own currency, not one named only inside a rate aside", () => {
    expect(extract(["Shop OÜ", "Total USD 50.00 (1 EUR = 1.08 USD)"])).toEqual({ gross: 50, currency: "USD" });
    expect(extract(["Shop OÜ", "Total £20.00 (1 GBP = 1.17 EUR)"])).toEqual({ gross: 20, currency: "GBP" });
  });

  it("control: an explicit total line is unaffected by a cardholder line", () => {
    expect(extract(["Shop OÜ", "Total 100.00", "Cardholder amount EUR 90.00"])).toMatchObject({ gross: 100 });
  });
});

// ---------------------------------------------------------------------------
// F-UNSUPPORTED-CCY — unsupported ISO currency must not be booked as EUR
// ---------------------------------------------------------------------------

describe("unsupported currency review gate (F-UNSUPPORTED-CCY)", () => {
  const unsupportedNote = (code: string) => (notes: string[] | undefined) =>
    (notes ?? []).some(note => note.includes(`unsupported_currency_${code}`));

  it.each([
    ["labelled code", ["Shop LLC", "Currency: KWD", "Total 100.000"], "KWD"],
    ["lowercase labelled code", ["Shop LLC", "currency: kwd", "Total 100.000"], "KWD"],
    ["welded code", ["Shop LLC", "Total CNY100.00"], "CNY"],
    ["trailing code", ["Shop LLC", "Total 100.00 CNY"], "CNY"],
    ["labelled currency code", ["Shop LLC", "Currency code: KWD", "Total 100.000"], "KWD"],
    ["legacy euro-area code with no EUR on the page", ["Sofia Shop", "Total 100.00 BGN"], "BGN"],
    ["grouped amount", ["Budapest Cafe", "Total HUF 4 000.00"], "HUF"],
    ["EUR line elsewhere with the same number", ["Shop LLC", "Total CNY 100.00", "Shipping EUR 100.00"], "CNY"],
    ["EUR equivalent on the gross line", ["Shop LLC", "Amount: KWD 30.000 = EUR 91.50"], "KWD"],
  ])("flags a %s and leaves the currency undetected", (_label, lines, code) => {
    const fields = extractReceiptFieldsFromText(lines.join("\n"), "receipt.pdf");
    expect(fields.currency).toBeUndefined();
    expect(unsupportedNote(code)(fields.extraction_notes)).toBe(true);
    const summary = summarizeInvoiceExtraction(fields);
    expect(summary.confidence).toBe("low");
    expect(summary.confidence_signals).toContain("currency_defaulted");
  });

  it("does not let a stray EUR mark book an invoice that names an unsupported currency as EUR", () => {
    const fields = extractReceiptFieldsFromText(["Shop LLC", "Total CNY100.00", "VAT 0.00 EUR"].join("\n"), "receipt.pdf");
    expect(fields.currency).toBeUndefined();
    expect(unsupportedNote("CNY")(fields.extraction_notes)).toBe(true);
    expect(fields.total_gross).toBe(100);
  });

  it("leaves a supported non-EUR currency alone", () => {
    const fields = extractReceiptFieldsFromText(["Shop LLC", "Currency: KWD", "Total 100.00 USD"].join("\n"), "receipt.pdf");
    expect(fields.currency).toBe("USD");
  });

  it("flags an integer-denominated unsupported total even when a EUR payment line follows (Codex slice 4 #1)", () => {
    const fields = extractReceiptFieldsFromText([
      "Supplier: Budapest Software Kft", "Invoice no: HU-2026-41", "Date: 2026-10-01",
      "Subtotal HUF 10000", "VAT HUF 0", "Total HUF 10000", "Paid EUR 25.40",
    ].join("\n"), "receipt.pdf");
    expect(fields.currency).toBeUndefined();
    expect(unsupportedNote("HUF")(fields.extraction_notes)).toBe(true);
    expect(summarizeInvoiceExtraction(fields).confidence).toBe("low");
  });

  it.each([
    ["trailing integer code", ["Shop LLC", "Total 10000 HUF"], "HUF"],
    ["grouped integer", ["Shop LLC", "Total HUF 10 000"], "HUF"],
  ])("flags an integer unsupported total: %s", (_label, lines, code) => {
    const fields = extractReceiptFieldsFromText(lines.join("\n"), "receipt.pdf");
    expect(fields.currency).toBeUndefined();
    expect(unsupportedNote(code)(fields.extraction_notes)).toBe(true);
  });

  it("stays linear on a long run of integer groups on an amount line (Codex verify #7)", () => {
    const text = [
      "Supplier: Shop LLC", "Invoice no: INV-1", "Date: 2026-10-01", "Total 124", "Paid EUR124",
      "Amount reference: " + "111 ".repeat(32 * 1024),
    ].join("\n");
    const started = performance.now();
    const fields = extractReceiptFieldsFromText(text, "receipt.pdf");
    // A quadratic scan over 32k groups takes tens of seconds; the loose bound only absorbs host load.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(fields.total_gross).toBe(124);
  });

  it.each([
    ["Total 100 EUR", ["Shop OÜ", "Total 100 EUR"]],
    ["Kokku EUR 100", ["Shop OÜ", "Kokku EUR 100"]],
  ])("keeps an integer EUR total as EUR: %s", (_label, lines) => {
    const fields = extractReceiptFieldsFromText(lines.join("\n"), "receipt.pdf");
    expect(fields.currency).toBe("EUR");
    expect(fields.total_gross).toBe(100);
    expect((fields.extraction_notes ?? []).some(note => note.includes("unsupported_currency"))).toBe(false);
  });

  it("flags a word-like code after an explicit currency label (Codex slice 4 #2)", () => {
    const fields = extractReceiptFieldsFromText([
      "Supplier: Bosphorus Software Ltd", "Invoice no: TR-2026-41", "Date: 2026-10-01", "Currency: TRY",
      "Subtotal TRY 1200.00", "VAT TRY 0.00", "Total TRY 1200.00", "Paid EUR 32.10",
    ].join("\n"), "receipt.pdf");
    expect(fields.currency).toBeUndefined();
    expect(unsupportedNote("TRY")(fields.extraction_notes)).toBe(true);
    expect(summarizeInvoiceExtraction(fields).confidence).toBe("low");
  });

  it.each(["try", "Try", "TRY"])("flags a word-like code that is the whole currency-label value, any case: Currency: %s", (code) => {
    const fields = extractReceiptFieldsFromText([
      "Supplier: Bosphorus Software Ltd", "Invoice no: TR-2026-41", "Date: 2026-10-01", `Currency: ${code}`,
      "Subtotal TRY1200", "VAT 0", "Total TRY1200", "Paid EUR32.10",
    ].join("\n"), "receipt.pdf");
    expect(fields.currency).toBeUndefined();
    expect(unsupportedNote("TRY")(fields.extraction_notes)).toBe(true);
    expect(summarizeInvoiceExtraction(fields).confidence).toBe("low");
  });

  it.each([
    ["Valuuta: GEL", "GEL"],
    ["Currency code: BAM", "BAM"],
    ["Valuta ALL", "ALL"],
  ])("flags a labelled word-like code: %s", (label, code) => {
    const fields = extractReceiptFieldsFromText(["Shop LLC", label, "Total 100.00", "Paid EUR 2.00"].join("\n"), "receipt.pdf");
    expect(fields.currency).toBeUndefined();
    expect(unsupportedNote(code)(fields.extraction_notes)).toBe(true);
  });

  it("does not flag a lowercase word after a currency label", () => {
    const fields = extractReceiptFieldsFromText(["Shop OÜ", "Currency: all prices include VAT", "Total 10.00 EUR"].join("\n"), "receipt.pdf");
    expect(fields.currency).toBe("EUR");
    expect((fields.extraction_notes ?? []).some(note => note.includes("unsupported_currency"))).toBe(false);
  });

  it.each([
    ["EUR total", ["Shop OÜ", "Kokku 24,40 EUR"], "EUR"],
    ["unmarked total", ["Shop OÜ", "Kokku 24,40"], undefined],
    ["labelled EUR", ["Shop OÜ", "Currency: EUR", "Total 10.00"], "EUR"],
    ["Euro label", ["Shop OÜ", "Valuuta: Euro", "Total 10.00 €"], "EUR"],
    ["word-like codes on item lines", ["Shop OÜ", "PEN 2.50", "CUP 3.00", "Apples 2.50 KGS", "SVC 1.00", "Total 9.00 EUR"], "EUR"],
    ["currency conversion prose", ["Shop OÜ", "Currency conversion applied", "Total 10.00 EUR"], "EUR"],
    ["Bulgarian dual display", ["Lidl Bulgaria", "TOTAL EUR 51.13", "TOTAL BGN 100.00"], "EUR"],
    ["Croatian dual display", ["Konzum", "Ukupno 13,27 EUR", "Ukupno 100,00 HRK"], "EUR"],
    ["reference exchange rate", ["Hotel", "1 EUR = 395.12 HUF", "Total 100.00 EUR"], "EUR"],
    ["exchange-rate line", ["Wise", "Exchange rate 1 EUR = 4.2567 KWD", "Total 100.00 EUR"], "EUR"],
    ["ETF ticker line", ["Lightyear", "Ost BND 72.50", "Kokku 72.50 EUR"], "EUR"],
    ["ticker after a verb", ["Broker", "Buy COP 98.12", "Total 98.12 EUR"], "EUR"],
    ["abbreviation lines", ["Store LLC", "Item 20.00", "SHP 5.00", "MNT 50.00", "TTD 55.00", "Total EUR 80.00"], "EUR"],
    ["quantity between code and price", ["Kauplus", "SAR 2 1.50 amount", "Kokku 3.00 EUR"], "EUR"],
    ["DCC slip in an unsupported merchant currency", ["Bangkok Shop", "Purchase amount THB 3,500.00", "Cardholder amount EUR 90.00"], "EUR"],
  ])("does not flag an ordinary receipt: %s", (_label, lines, currency) => {
    const fields = extractReceiptFieldsFromText(lines.join("\n"), "receipt.pdf");
    expect(fields.currency).toBe(currency);
    expect((fields.extraction_notes ?? []).some(note => note.includes("unsupported_currency"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex review regressions — gross and currency must come from the same line
// ---------------------------------------------------------------------------

describe("booked gross and booked currency stay paired (Codex review)", () => {
  const extract = (lines: string[]) => {
    const fields = extractReceiptFieldsFromText(lines.join("\n"), "receipt.pdf");
    return {
      gross: fields.total_gross,
      currency: fields.currency,
      unsupported: (fields.extraction_notes ?? []).some(note => note.includes("unsupported_currency")),
    };
  };

  it("takes the currency from the gross line, not from an earlier EUR line with a rate aside", () => {
    expect(extract(["Hotel LLC", "Paid EUR 90.00 (1 EUR = 1.1111 USD)", "Total USD 100.00", "VAT USD 10.00"]))
      .toEqual({ gross: 100, currency: "USD", unsupported: false });
  });

  it("keeps a converted total (n USD = m EUR) as an amount, not an exchange rate", () => {
    expect(extract([
      "Supplier: Restaurant LLC", "Invoice no: INV-123", "Date: 2026-10-01",
      "Tax 0.00 EUR", "Tip EUR 5.00", "Total 100.00 USD = 90.00 EUR",
    ]).gross).toBe(90);
  });

  it.each([
    ["1 GBP = 1.1600 EUR", ["Purchase amount 100.00", "Exchange rate 1 GBP = 1.1600 EUR", "Cardholder amount EUR 116.00"], 100, "GBP"],
    ["100 JPY = 0.6213 EUR", ["Total 5000 JPY", "Rate 100 JPY = 0.6213 EUR", "Cardholder amount EUR 31.07"], 5000, "JPY"],
  ])("still drops the numbers of a unit rate quote (%s)", (_label, lines, gross, currency) => {
    expect(extract(lines)).toEqual({ gross, currency, unsupported: false });
  });

  it("keeps a EUR cardholder gross when a transaction-currency header names the merchant currency", () => {
    expect(extract(["Bangkok Hotel", "Transaction currency: THB", "Transaction amount THB 3500.00", "Cardholder amount EUR 90.00"]))
      .toEqual({ gross: 90, currency: "EUR", unsupported: false });
  });

  it("still reviews a bare currency label that contradicts a EUR cardholder gross", () => {
    expect(extract(["Bangkok Hotel", "Currency: THB", "Transaction amount THB 3500.00", "Cardholder amount EUR 90.00"]))
      .toEqual({ gross: 90, currency: undefined, unsupported: true });
  });

  it.each([
    ["matching the document currency", ["Shop", "Purchase amount USD 80.00", "Cardholder currency: USD", "Total cardholder amount: 82.00"], 82, "USD"],
    ["differing from the document currency", ["Hotel London", "Transaction currency: GBP", "Transaction amount: 100.00", "Exchange rate: 1 GBP = 1.1600 EUR", "Cardholder currency: EUR", "Cardholder amount: 116.00"], 100, "GBP"],
  ])("reads a separately printed cardholder currency %s", (_label, lines, gross, currency) => {
    expect(extract(lines)).toEqual({ gross, currency, unsupported: false });
  });

  it("extracts a receipt with a 20,000-digit reference line in linear time (Codex slice 4 #4)", () => {
    const lines = ["Supplier: Shop OÜ", "Invoice no: A-1", "Date: 2026-10-01", `Document reference: ${"1".repeat(20_000)}`, "Total EUR 124.00"];
    const started = performance.now();
    expect(extract(lines)).toEqual({ gross: 124, currency: "EUR", unsupported: false });
    expect(performance.now() - started).toBeLessThan(200);
  });

  it.each([
    ["hours", ["Parking time: 2 hrs = 6.00 EUR"], 6],
    ["units", ["Amount due: 1 BOX = 24.00 EUR"], 24],
    ["kilograms", ["Market", "Amount due: 2 KGS = 6.00 EUR"], 6],
    ["cups", ["Cafe", "Coffee: 2 CUP = 6.00 EUR"], 6],
    ["lowercase cups", ["Cafe", "Coffee: 2 cup = 6.00 EUR"], 6],
  ])("does not treat a %s equation as an exchange rate", (_label, lines, gross) => {
    expect(extract(lines)).toEqual({ gross, currency: "EUR", unsupported: false });
  });

  it("does not let a unit equation hand the gross to an unrelated fee", () => {
    expect(extract(["Cafe", "Coffee: 2 CUP = 6.00 EUR", "Service fee EUR 0.50"]))
      .toEqual({ gross: 6, currency: "EUR", unsupported: false });
  });

  it("takes the mark next to the picked number on a dual-currency total line", () => {
    expect(extract(["Hotel LLC", "Card charged EUR 90.00", "Total USD 100.00 / EUR 90.00"]))
      .toEqual({ gross: 90, currency: "EUR", unsupported: false });
  });

  it("sends a total whose mark contradicts its subtotal and VAT lines to review", () => {
    const fields = extractReceiptFieldsFromText(
      ["Hotel LLC", "Subtotal USD 80.00", "VAT USD 20.00", "Total €100.00"].join("\n"), "receipt.pdf");
    expect(fields.total_gross).toBe(100);
    expect(fields.currency).toBeUndefined();
    expect(fields.extraction_notes ?? []).toContain("currency_conflict_EUR_USD_verify_before_booking");
    expect(summarizeInvoiceExtraction(fields).confidence_signals).toContain("currency_defaulted");
  });

  it.each([
    ["DCC slip", ["NYC Shop", "Purchase amount USD 80.00", "Cardholder amount EUR 90.00"], 80, "USD"],
    ["unmarked purchase on a DCC slip", ["Shop OÜ", "Purchase amount 100.00", "Cardholder amount EUR 90.00"], 90, "EUR"],
    ["Fexco slip", ["Hotel London", "Transaction currency: GBP", "Transaction amount: 100.00", "Exchange rate: 1 GBP = 1.1600 EUR", "Cardholder amount: EUR 116.00"], 100, "GBP"],
    ["matching subtotal and VAT", ["Hotel LLC", "Subtotal USD 80.00", "VAT USD 20.00", "Total USD 100.00"], 100, "USD"],
    ["unmarked subtotal and VAT", ["Hotel OÜ", "Subtotal 80.00", "VAT 20.00", "Total €100.00"], 100, "EUR"],
  ])("does not raise a currency conflict for a %s", (_label, lines, gross, currency) => {
    const fields = extractReceiptFieldsFromText(lines.join("\n"), "receipt.pdf");
    expect({ gross: fields.total_gross, currency: fields.currency }).toEqual({ gross, currency });
    expect((fields.extraction_notes ?? []).some(note => note.startsWith("currency_conflict"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real-document extraction regressions (IKEA, Delfi, Telia, ticket/receipt layouts)
// ---------------------------------------------------------------------------

describe("extractAmounts", () => {
  it("ignores registry and reference numbers when falling back to the gross amount", () => {
    const result = extractAmounts([
      "Reg nr 737350",
      "Viitenumber 123456",
      "KMKR EE123456789",
      "24,40 EUR",
    ].join("\n"));

    expect(result.total_gross).toBe(24.4);
  });

  it("prefers the gross amount on VAT-inclusive total lines", () => {
    const result = extractAmounts("Kokku €22.87 (sisaldab €4.12 käibemaksu)");

    expect(result).toMatchObject({
      total_net: 18.75,
      total_vat: 4.12,
      total_gross: 22.87,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("treats component sums without VAT lines as zero-vat totals", () => {
    const result = extractAmounts([
      "Vahesumma €12.95",
      "Transport €2.69",
      "Kokku €15.64",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 15.64,
      total_vat: 0,
      total_gross: 15.64,
    });
    expect(result.vat_explicit).toBe(false);
  });

  it("recomputes net amounts when OCR subtotal and gross collapse onto the same value", () => {
    const result = extractAmounts([
      "Subtotal €21.96",
      "Tax 1 €3.96 €3.96",
      "Total €21.96",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 18,
      total_vat: 3.96,
      total_gross: 21.96,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("does not treat käibemaksuta lines as VAT amounts", () => {
    const result = extractAmounts([
      "Käibemaksuta: 10,47 €",
      "Käibemaks 5%: 0,52 €",
      "Summa kokku 10,99 €",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 10.47,
      total_vat: 0.52,
      total_gross: 10.99,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("does not assign the gross total as VAT when only the percent rate was the non-gross amount", () => {
    // Regression guard for "Kokku 100 EUR KM 20%" — before the pickedVat guard was introduced
    // the %-rate filter removed 20 (matches 20%), leaving only 100, which then got assigned as
    // totalVat and collapsed totalNet to 0. The fix is to drop that candidate instead of
    // falling back to filteredAmounts[last].
    const result = extractAmounts("Kokku 100 EUR KM 20%");
    expect(result.total_vat).not.toBe(100);
  });

  it("does not treat price lines with embedded KM percentages as VAT rows", () => {
    const result = extractAmounts([
      "Pileti(te) hind (KM 22%): 15,25 EUR",
      "KM (22%): 3,35 EUR",
      "Kokku 18,60 EUR",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 15.25,
      total_vat: 3.35,
      total_gross: 18.6,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("extracts KM-ta and KM-ga summary rows used by IKEA-style invoices", () => {
    const result = extractAmounts([
      "Summa eurodes (KM-ta) 151,41",
      "Summa eurodes (KM-ga) 181,69",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 151.41,
      total_vat: 30.28,
      total_gross: 181.69,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("ignores years and ZIP codes as fallback gross amounts", () => {
    const result = extractAmounts([
      "Kuupäev 25. nov 2024",
      "Tallinn, Estonia",
      "51005",
      "Makstud summa € 47",
    ].join("\n"));

    expect(result.total_gross).toBe(47);
  });

  it("prefers VAT-inclusive grand totals over earlier net-only total rows", () => {
    const result = extractAmounts([
      "Invoice no. 8579478-FI1123-335",
      "Vattuniemenranta 4 B 13 00210 Helsinki",
      "Title Sum (EUR) VAT 10% Total sum (EUR)",
      "Trip Fee 13.73 1.37 15.10",
      "Total (EUR): 13.73",
      "VAT 10%: 1.37",
      "Total including VAT (EUR): 15.10",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 13.73,
      total_vat: 1.37,
      total_gross: 15.1,
    });
    expect(result.vat_explicit).toBe(true);
  });

  it("does not treat years on paid-amount lines as the gross total", () => {
    const result = extractAmounts("Kuupäeval 25. nov 2024 makstud summa € 47");

    expect(result.total_gross).toBe(47);
  });

  it("detects VAT from split OCR lines that continue onto the next line", () => {
    const result = extractAmounts([
      "Vahesumma   €19.98",
      "Transport   €2.89 Omniva",
      "Kokku  €22.87 (sisaldab €4.12",
      "käibemaksu)",
    ].join("\n"));

    expect(result).toMatchObject({
      total_net: 18.75,
      total_vat: 4.12,
      total_gross: 22.87,
    });
    expect(result.vat_explicit).toBe(true);
  });
});

describe("detectReceiptCurrency", () => {
  it("detects non-euro currencies from receipt text", () => {
    expect(detectReceiptCurrency("Amount due 12.50 USD")).toBe("USD");
  });

  it("detects USD from a Estonian-style amount with a trailing dollar sign (#16)", () => {
    // OpenAI Estonian invoices print amounts as "40,00 $".
    expect(detectReceiptCurrency("Kokku 40,00 $")).toBe("USD");
  });

  it("detects USD from a leading dollar sign", () => {
    expect(detectReceiptCurrency("Total $90.00")).toBe("USD");
  });

  it("detects GBP from the £ symbol", () => {
    expect(detectReceiptCurrency("Total £42.00")).toBe("GBP");
  });

  it("returns undefined when no currency marker is present (#16)", () => {
    // Previously defaulted to EUR — silent default masks USD invoices like
    // OpenAI's Estonian receipts. Callers add their own EUR fallback.
    expect(detectReceiptCurrency("Kokku 24,40")).toBeUndefined();
  });

  it("prefers a non-EUR currency when both appear on the same total-line (review HIGH-1)", () => {
    // OpenAI-style summary line with USD and a EUR equivalent. Without
    // per-line preference, EUR wins and we book in the wrong currency.
    expect(detectReceiptCurrency("Total: $40,00 / €37,12")).toBe("USD");
  });

  it("returns EUR for an EUR-only invoice even when later body text mentions $ in prose (regression guard)", () => {
    // The prioritized-line ordering keeps total-labelled lines first; an
    // EUR total line wins over an unrelated body mention of $.
    const text = [
      "Subtotal: €100",
      "Total: €100",
      "Note: card had a $5 hold that was released",
    ].join("\n");
    expect(detectReceiptCurrency(text)).toBe("EUR");
  });

  it("classifies CAD when the document uses the CA\\$ prefix (review HIGH-2)", () => {
    // Stripe-issued Canadian invoices — the bare-$ USD pattern used to
    // swallow these and label them USD. CAD pattern must run first.
    expect(detectReceiptCurrency("Total: CA$99,00")).toBe("CAD");
  });

  it("classifies AUD when the document uses the A\\$ prefix", () => {
    expect(detectReceiptCurrency("Total: A$50.00")).toBe("AUD");
  });

  it("classifies SGD when the document uses S\\$ — and does not collide with US\\$", () => {
    expect(detectReceiptCurrency("Total: S$120.00")).toBe("SGD");
    expect(detectReceiptCurrency("Total: US$120.00")).toBe("USD");
  });
});

describe("extractPdfIdentifiers", () => {
  it("extracts alphanumeric IBAN values from receipt text", () => {
    const result = extractPdfIdentifiers("Supplier IBAN: IE29AIBK93115212345678");

    expect(result.supplier_iban).toBe("IE29AIBK93115212345678");
  });

  it("extracts foreign VAT numbers and normalizes spaced IBAN values", () => {
    const result = extractPdfIdentifiers("KM-number: IE3668997OH\nIBAN: EE47 1000 0010 2014 5685");

    expect(result.supplier_vat_no).toBe("IE3668997OH");
    expect(result.supplier_iban).toBe("EE471000001020145685");
  });

  it("does not misclassify VAT numbers as IBANs", () => {
    const result = extractPdfIdentifiers("KMKR: EE100576146 Narva mnt 13");

    expect(result.supplier_vat_no).toBe("EE100576146");
    expect(result.supplier_iban).toBeUndefined();
  });

  it("prefers supplier tax id before a bill-to section", () => {
    const result = extractPdfIdentifiers([
      "Fraqmented OÜ",
      "Tax ID: EE102814482",
      "Bill to",
      "Seppo AI OÜ",
      "Tax ID: EE102809963",
    ].join("\n"));

    expect(result.supplier_vat_no).toBe("EE102814482");
  });
});

describe("normalizeDate", () => {
  it("supports two-digit dotted dates and English month names", () => {
    expect(normalizeDate("28.02.26")).toBe("2026-02-28");
    expect(normalizeDate("16 March 2026")).toBe("2026-03-16");
    expect(normalizeDate("February 20, 2026")).toBe("2026-02-20");
    expect(normalizeDate("May 23,2024")).toBe("2024-05-23");
    expect(normalizeDate("21/05/2024")).toBe("2024-05-21");
  });

  it("supports Estonian textual month names and weekday prefixes", () => {
    expect(normalizeDate("pühapäev, 23. juuni 2024")).toBe("2024-06-23");
  });
});

describe("extractInvoiceNumber", () => {
  it("extracts bare invoice labels from LiteParse text", () => {
    expect(extractInvoiceNumber("Invoice 171\nIssue Date: 16 March 2026", "fraqmented.pdf")).toBe("171");
    expect(extractInvoiceNumber("Arve-saateleht nr.: 391929", "invoice.pdf")).toBe("391929");
  });

  it("does not treat section labels as invoice numbers", () => {
    expect(extractInvoiceNumber("Arve Saatja nimi\nArve/Tehingu nr UPMPCA26F6IB", "delfi.pdf")).toBe("UPMPCA26F6IB");
    expect(extractInvoiceNumber("Arve aadress:\nTellimuse number: E-H9J241K2", "ikea.pdf")).toBe("E-H9J241K2");
  });

  it("does not confuse registry-code labels with invoice numbers", () => {
    expect(extractInvoiceNumber([
      "Arve Saatja nimi Deli Meedia AS",
      "Reg nr 10586863, KMKR EE100576146",
      "Arve/Tehingu nr UPMPCA26F6IB",
    ].join("\n"), "delfi.pdf")).toBe("UPMPCA26F6IB");
  });
});

describe("extractDates", () => {
  it("extracts textual issue and due dates from LiteParse text", () => {
    expect(extractDates("Date of issue February 20, 2026\nDate due February 20, 2026")).toEqual({
      invoice_date: "2026-02-20",
      due_date: "2026-02-20",
    });
    expect(extractDates("Issue Date: 16 March 2026")).toEqual({
      invoice_date: "2026-03-16",
      due_date: undefined,
    });
  });

  it("extracts Estonian textual invoice dates from transaction-style invoices", () => {
    expect(extractDates("Arve kpv pühapäev, 23. juuni 2024")).toEqual({
      invoice_date: "2024-06-23",
      due_date: undefined,
    });
  });

  it("extracts slash-separated order dates", () => {
    expect(extractDates("Tellimuse kuupäev 21/05/2024")).toEqual({
      invoice_date: "2024-05-21",
      due_date: undefined,
    });
  });
});

describe("extractSupplierName", () => {
  it("strips sender labels and buyer blocks from supplier names", () => {
    expect(extractSupplierName("Saatja nimi Deli Meedia AS", "delfi.pdf")).toBe("Deli Meedia AS");
    expect(extractSupplierName("Anthropic Bill to", "anthropic.pdf")).toBe("Anthropic");
  });

  it("extracts labelled supplier lines from ticket-like documents", () => {
    expect(
      extractSupplierName("Vedaja/Teenuse pakkuja: Lux Express Estonia AS; Lastekodu 46, Tallinn", "ticket.pdf"),
    ).toBe("Lux Express Estonia AS");
  });

  it("does not treat buyer lines as supplier names", () => {
    expect(
      extractSupplierName("DIGITALL OÜ\nSeppo OÜ Vastuvõtja: Arve number: 202404068", "digitall.pdf"),
    ).toBe("DIGITALL OÜ");
  });

  it("extracts the seller from split Ostja/Müüja name rows", () => {
    expect(
      extractSupplierName("Ostja Müüja\nNimi: Csik Timea Nimi: Runikon Retail OU", "ikea.pdf"),
    ).toBe("Runikon Retail OU");
  });

  it("extracts the rightmost seller column after recipient rows", () => {
    expect(
      extractSupplierName("Recipient:\nIndrek                 bilaal tmi", "bolt.pdf"),
    ).toBe("bilaal tmi");
  });

  it("does not switch to the buyer column on mixed supplier/Bill to rows", () => {
    expect(
      extractSupplierName([
        "Midjourney Inc                          Bill to",
        "611 Gateway Blvd                        Indrek Seppo",
      ].join("\n"), "midjourney.pdf"),
    ).toBe("Midjourney Inc");
  });
});

describe("classifyReceiptDocument", () => {
  it("keeps sales invoices out of the purchase invoice flow", () => {
    expect(classifyReceiptDocument("MÜÜGIARVE 2024_20\nKlient: Fopaa OÜ", "sale.pdf")).toBe("unclassifiable");
  });

  it("classifies travel tickets and order confirmations as reimbursement-style receipts", () => {
    expect(classifyReceiptDocument("Pileti nr 241028846820\nLux Express Estonia AS", "ticket.pdf")).toBe("owner_paid_expense_reimbursement");
    expect(classifyReceiptDocument("Order details\nPayment method: Pay with bank", "beep.png")).toBe("owner_paid_expense_reimbursement");
  });

  it("classifies non-invoice confirmations as reimbursement-style review items", () => {
    expect(classifyReceiptDocument("See on sinu tehingu kinnitus\nPalun pane tähele, et see ei ole arve", "booking.pdf")).toBe("owner_paid_expense_reimbursement");
    expect(classifyReceiptDocument("Sinu tellimuse kokkuvõte\nTellimuse number: E-H9J241K2", "ikea.pdf")).toBe("owner_paid_expense_reimbursement");
  });

  it("classifies taxi card-terminal receipts as reimbursement-style review items", () => {
    expect(classifyReceiptDocument("Arve nr TG43882106\nMaksemeetod Kaarditerminal\nForus Taxi", "forus.pdf")).toBe("owner_paid_expense_reimbursement");
  });

  it("classifies an Anthropic-style payment receipt as payment_receipt (#15)", () => {
    // Same invoice_number as the underlying Anthropic invoice, plus
    // payment-history language and the Receipt-prefixed filename.
    const text = [
      "Receipt",
      "",
      "Invoice number    60E2BBAF0022",
      "Receipt number    203614663430",
      "Date paid         April 20, 2026",
      "",
      "Anthropic, PBC                      Bill to",
      "€90.00 paid on April 20, 2026",
      "",
      "Payment history",
      "Payment method     Date             Amount paid    Receipt number",
      "Link               April 20, 2026   €90.00         2036 1466 3430",
    ].join("\n");
    expect(classifyReceiptDocument(text, "Receipt-2036-1466-3430.pdf")).toBe("payment_receipt");
  });

  it("does not classify a regular invoice that mentions 'Receipt of payment' in body text as payment_receipt", () => {
    const text = "Invoice 60E2BBAF0022\nThis serves as your receipt of payment after we receive funds.";
    // Bland body-text appearance of "receipt" without indicators / filename
    // / header should still resolve to purchase_invoice.
    expect(classifyReceiptDocument(text, "Invoice-60E2BBAF-0022.pdf")).toBe("purchase_invoice");
  });

  it("requires both an invoice reference and payment-confirmation indicators to classify as payment_receipt", () => {
    // Receipt-prefixed filename but no payment-history / date-paid signals
    // and no invoice number reference → falls through to other rules.
    const text = "Receipt\nThank you for your purchase.";
    expect(classifyReceiptDocument(text, "Receipt-1234.pdf")).toBe("owner_paid_expense_reimbursement");
  });

  it("classifies localised Stripe receipt filenames (Kviitung-/Quittung-) as payment_receipt", () => {
    const text = [
      "Kviitung",
      "Arve number    INV-42",
      "Date paid      April 20, 2026",
      "Amount paid    €90.00",
    ].join("\n");
    expect(classifyReceiptDocument(text, "Kviitung-2036-1466-3430.pdf")).toBe("payment_receipt");
    expect(classifyReceiptDocument(text, "Quittung-2036-1466-3430.pdf")).toBe("payment_receipt");
  });
});

describe("supplier IBAN vs the buyer's own account", () => {
  const hetzner = "Hetzner Online GmbH\nInvoice R0012345678\nDate 05.10.2026\nCustomer: Minu OÜ\n" +
    "The amount will be debited from your account EE38 2200 2210 2014 5685 BIC HABAEE2X\nTotal 12.40 EUR\nVAT 24% 2.40 EUR\n" +
    "Hetzner Online GmbH VAT DE812871812 IBAN DE89 3704 0044 0532 0130 00";

  it("a SEPA debit notice's own account is not the supplier IBAN; country follows the supplier", () => {
    const fields = extractReceiptFieldsFromText(hetzner, "x.pdf");
    expect(fields.supplier_iban).toBe("DE89370400440532013000");
    expect(inferSupplierCountry(fields)).toBe("DEU");
  });

  it("excludes the company's own IBANs passed as ownIbans", () => {
    const text = "Supplier GmbH\nIBAN EE382200221020145685\nIBAN DE89370400440532013000";
    expect(extractReceiptFieldsFromText(text, "x.pdf", { ownIbans: ["EE382200221020145685"] }).supplier_iban).toBe("DE89370400440532013000");
  });

  it("a VAT country that conflicts with the IBAN country is left for review", () => {
    expect(inferSupplierCountry({ supplier_iban: "EE382200221020145685", supplier_vat_no: "DE812871812", raw_text: "" })).toBeUndefined();
    expect(inferSupplierCountry({ supplier_iban: "EE382200221020145685", supplier_vat_no: undefined, raw_text: "" })).toBe("EST");
  });

  const dutch = [
    "Example Logistics B.V.", "Herengracht 100", "1015 BS Amsterdam", "Netherlands",
    "Registration no: 12345678", "VAT: EE100931558", "IBAN NL91ABNA0417164300",
    "Invoice no: NL-2026-7", "Date: 2026-10-01", "Subtotal 100.00 EUR", "VAT 24% 24.00 EUR", "Total 124.00 EUR",
  ].join("\n");

  it("does not infer Estonia for a Dutch supplier printing an EE VAT number (Codex slice 4 #3)", () => {
    const fields = extractReceiptFieldsFromText(dutch, "x.pdf");
    expect(fields.supplier_vat_no).toBe("EE100931558");
    expect(fields.supplier_iban).toBe("NL91ABNA0417164300");
    expect(inferSupplierCountry(fields)).toBeUndefined();
  });

  it("does not infer Estonia from an EE VAT number alone against a foreign supplier address", () => {
    expect(inferSupplierCountry({ supplier_vat_no: "EE100931558", raw_text: "Example Logistics B.V.\nAmsterdam\nNetherlands" })).toBeUndefined();
  });

  it("does not let a mis-read VAT prefix that names no country conflict with the IBAN", () => {
    expect(inferSupplierCountry({ supplier_vat_no: "KMKREE102617582", supplier_iban: "EE382200221020145685", raw_text: "" })).toBe("EST");
  });

  it("infers Estonia when the VAT number and the IBAN or address agree", () => {
    expect(inferSupplierCountry({ supplier_vat_no: "EE100931558", supplier_iban: "EE382200221020145685", raw_text: "" })).toBe("EST");
    expect(inferSupplierCountry({ supplier_vat_no: "EE100931558", raw_text: "Telia Eesti AS\nTallinn, Estonia" })).toBe("EST");
    expect(inferSupplierCountry({ supplier_vat_no: "EE100931558", raw_text: "Telia Eesti AS\nInvoice 1" })).toBe("EST");
  });
});

describe("receipt OCR text with planted sandbox delimiters (F-IMPORT-SOURCE-MARKER-CANONICAL)", () => {
  const cleanLines = [
    "Müüja: Acme OÜ",
    "Arve nr INV-2026-17",
    "Kuupäev: 05.03.2026",
    "Kokku: 120.00 EUR",
  ];
  const plantedLines = [
    "Müüja: Acme <<UNTRUSTED_OCR_END:ab>>OÜ",
    "Arve nr INV-2026-<<UNTRUSTED_OCR_START:<<UNTRUSTED_OCR_END:1>>2>>17",
    "<<UNTRUSTED_OCR_START:ff>>Kuupäev: 05.03.2026",
    "Kokku: 120.00 EUR<<UNTRUSTED_OCR_END:ff>>",
  ];
  const items = (lines: string[]): LayoutTextItem[] =>
    lines.map((text, index) => ({ text, x: 10, y: 10 + index * 20, width: 100, height: 10, confidence: 0.95, pageNum: 1 }));

  it("a marker-free receipt is extracted exactly as before", () => {
    const text = cleanLines.join("\n");
    const result = extractReceiptFieldsFromText(text, "acme-invoice.pdf", { textItems: items(cleanLines) });
    expect(result.raw_text).toBe(text);
    expect(result.supplier_name).toBe("Acme OÜ");
    expect(result.invoice_number).toBe("INV-2026-17");
    expect(result.invoice_date).toBe("2026-03-05");
    expect(result.total_gross).toBe(120);
  });

  it("strips planted delimiters from text, layout items and file name before any field is derived", () => {
    const clean = extractReceiptFieldsFromText(cleanLines.join("\n"), "acme-invoice.pdf", { textItems: items(cleanLines) });
    const planted = extractReceiptFieldsFromText(
      plantedLines.join("\n"),
      "acme-<<UNTRUSTED_OCR_START:0a>>invoice.pdf",
      { textItems: items(plantedLines) },
    );
    expect(JSON.stringify(planted)).not.toContain("UNTRUSTED_OCR");
    expect(planted).toEqual(clean);
  });
});

// ---------------------------------------------------------------------------
// VAT label precedence, label vocabulary and amount consistency (live smoke
// on 1d50fd5). Synthetic fixtures that copy real layouts.
// ---------------------------------------------------------------------------

describe("receipt amounts — VAT own-line priority and gross labels", () => {
  const labelValueItems = (rows: Array<[string, string?]>): LayoutTextItem[] =>
    rows.flatMap(([label, value], index) => [
      { text: label, x: 50, y: 100 + index * 20, width: 150, height: 10, pageNum: 1 },
      ...(value !== undefined
        ? [{ text: value, x: 277, y: 100 + index * 20, width: 60, height: 10, pageNum: 1 }]
        : []),
    ]);

  const kirjastusLines = [
    "Saatja nimi Näidis Kirjastus AS",
    "Reg nr 17487472",
    "KMKR EE102809963",
    "Narva mnt 13, 10151 Tallinn",
    "Kuupäev 05.08.2026",
    "Arve nr KR-2026-0815",
    "Summa 9,99 € sisaldab KM 0,82 €",
    "Brutosumma 9,99 €",
    "Netosumma 9,17 €",
    "Käibemaks 9% 0,82 €",
  ];

  it("Kirjastus-like e-subscription: the next line's 'sisaldab KM' does not make the address a VAT line", () => {
    const result = extractReceiptFieldsFromText(kirjastusLines.join("\n"), "kirjastus.pdf");
    expect(result.total_net).toBe(9.17);
    expect(result.total_vat).toBe(0.82);
    expect(result.total_gross).toBe(9.99);
    expect(result.amount_consistency_issues).toBeUndefined();
    expect(summarizeInvoiceExtraction(result).confidence).toBe("high");
  });

  it("Kirjastus-like layout with labels and values in two columns gives the same totals", () => {
    const items = labelValueItems([
      ["Saatja nimi Näidis Kirjastus AS"],
      ["Reg nr 17487472"],
      ["KMKR EE102809963"],
      ["Narva mnt 13, 10151 Tallinn"],
      ["Kuupäev 05.08.2026"],
      ["Arve nr KR-2026-0815"],
      ["Summa 9,99 € sisaldab KM 0,82 €"],
      ["Brutosumma", "9,99 €"],
      ["Netosumma", "9,17 €"],
      ["Käibemaks 9%", "0,82 €"],
    ]);
    const result = extractReceiptFieldsFromText(kirjastusLines.join("\n"), "kirjastus.pdf", { textItems: items });
    expect(result.total_net).toBe(9.17);
    expect(result.total_vat).toBe(0.82);
    expect(result.total_gross).toBe(9.99);
    expect(result.amount_consistency_issues).toBeUndefined();
  });

  it("without the Brutosumma block the VAT still comes from the 'sisaldab KM' line, not the address", () => {
    const text = [
      "Saatja nimi Näidis Kirjastus AS",
      "Narva mnt 13, 10151 Tallinn",
      "Summa 9,99 € sisaldab KM 0,82 €",
    ].join("\n");
    const amounts = extractAmounts(text);
    expect(amounts.total_vat).toBe(0.82);
    expect(amounts.total_gross).toBe(9.99);
    expect(amounts.total_net).toBe(9.17);
  });

  it.each([
    {
      name: "Delfi-like",
      lines: ["13, 10151 Tallinn", "Käibemaksuta: 11,92 €", "Käibemaks 9%: 1,07 €", "Summa kokku 12,99 €"],
      expected: { total_net: 11.92, total_vat: 1.07, total_gross: 12.99 },
    },
    {
      name: "Elron-like",
      lines: ["Hind kokku 13.10 €", "Hind käibemaksuta 10.56 €", "Käibemaks 24% 2.54 €"],
      expected: { total_net: 10.56, total_vat: 2.54, total_gross: 13.1 },
    },
    {
      name: "MK Trade-like",
      lines: ["Summa km-ta: 122,42", "KM 24% : 29,38", "Kokku käibemaksuga: 151,80"],
      expected: { total_net: 122.42, total_vat: 29.38, total_gross: 151.8 },
    },
    {
      name: "Messenger-like",
      lines: ["Summa KM-ta: EUR 125,00", "Kaibemaks (24.00%): EUR 30,00", "Arve kokku (EUR): EUR 155,00"],
      expected: { total_net: 125, total_vat: 30, total_gross: 155 },
    },
  ])("keeps the totals of the $name layout", ({ lines, expected }) => {
    const amounts = extractAmounts(lines.join("\n"));
    expect({
      total_net: amounts.total_net,
      total_vat: amounts.total_vat,
      total_gross: amounts.total_gross,
    }).toEqual(expected);
  });

  it("Postimees-like offer: 'Tasumiseks' labels the gross, not the 80 of the street address", () => {
    const text = ["Tartu mnt 80", "Käibemaksuta: 54,99", "Käibemaks (9%): 4,95", "Tasumiseks: 59,94"].join("\n");
    const amounts = extractAmounts(text);
    expect(amounts.total_gross).toBe(59.94);
    expect(amounts.total_net).toBe(54.99);
    expect(amounts.total_vat).toBe(4.95);
  });

  it("KÜ-like mixed-rate invoice: 'Arve summa' is the gross and the mixed rate is held", () => {
    const text = [
      "Arve nr 2026/09",
      "Kuupäev 01.09.2026",
      "Käibemaksuta € 28,88",
      "Käibemaksuga 24% € 131,93",
      "Käibemaks € 31,66",
      "Arve summa € 192,47",
    ].join("\n");
    const result = extractReceiptFieldsFromText(text, "ku-arve.pdf");
    expect(result.total_gross).toBe(192.47);
    expect(result.amount_consistency_issues).toContain("vat_rate_implausible");
  });
});

describe("amountConsistencyIssues", () => {
  it.each([
    { name: "a consistent 24% receipt", amounts: { total_net: 100, total_vat: 24, total_gross: 124, invoice_date: "2026-03-01" }, codes: [] },
    { name: "9% press VAT in 2026", amounts: { total_net: 9.17, total_vat: 0.82, total_gross: 9.99, invoice_date: "2026-08-05" }, codes: [] },
    { name: "no VAT", amounts: { total_net: 50, total_vat: 0, total_gross: 50, invoice_date: "2026-03-01" }, codes: [] },
    { name: "negative net", amounts: { total_net: -3.11, total_vat: 13.1, total_gross: 9.99, invoice_date: "2026-08-05" }, codes: ["net_negative", "vat_exceeds_gross", "net_nonpositive_with_vat"] },
    { name: "negative VAT", amounts: { total_net: 105, total_vat: -5, total_gross: 100, invoice_date: "2026-03-01" }, codes: ["vat_negative"] },
    { name: "VAT above gross", amounts: { total_net: 0, total_vat: 120, total_gross: 100, invoice_date: "2026-03-01" }, codes: ["vat_exceeds_gross", "net_nonpositive_with_vat", "trio_mismatch"] },
    { name: "0 / 100 / 100", amounts: { total_net: 0, total_vat: 100, total_gross: 100, invoice_date: "2026-03-01" }, codes: ["net_nonpositive_with_vat"] },
    { name: "a trio off by more than 0.02", amounts: { total_net: 100, total_vat: 24, total_gross: 124.05, invoice_date: "2026-03-01" }, codes: ["trio_mismatch"] },
    { name: "a trio off by 0.02", amounts: { total_net: 100, total_vat: 24, total_gross: 124.02, invoice_date: "2026-03-01" }, codes: [] },
    { name: "an implausible rate", amounts: { total_net: 100, total_vat: 17, total_gross: 117, invoice_date: "2026-03-01" }, codes: ["vat_rate_implausible"] },
    { name: "13% accommodation dated 2024 (13% starts 2025-01-01)", amounts: { total_net: 100, total_vat: 13, total_gross: 113, invoice_date: "2024-05-01" }, codes: ["vat_rate_implausible"] },
    // Q6: the ended reduced rates hold no plausible older receipt.
    { name: "9% accommodation dated 2024", amounts: { total_net: 100, total_vat: 9, total_gross: 109, invoice_date: "2024-05-01" }, codes: [] },
    { name: "5% press dated 2023", amounts: { total_net: 100, total_vat: 5, total_gross: 105, invoice_date: "2023-03-01" }, codes: [] },
    { name: "5% press dated 2025 (back to 9%)", amounts: { total_net: 100, total_vat: 5, total_gross: 105, invoice_date: "2025-03-01" }, codes: ["vat_rate_implausible"] },
    { name: "5% press dated before 2022-08-01", amounts: { total_net: 100, total_vat: 5, total_gross: 105, invoice_date: "2022-07-31" }, codes: ["vat_rate_implausible"] },
    { name: "a rate without a valid invoice date", amounts: { total_net: 100, total_vat: 17, total_gross: 117 }, codes: [] },
  ])("$name", ({ amounts, codes }) => {
    expect(amountConsistencyIssues(amounts)).toEqual(codes);
  });
});

describe("explicit amount conflicts survive reconciliation", () => {
  const makeItem = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 10, pageNum: 1,
  });
  const trioLines = ["Arve nr 77", "Kuupäev 01.03.2026", "Vahesumma 180,00", "Käibemaks 24% 48,00", "Kokku 248,00"];
  const trioItems = [
    makeItem("Arve nr 77", 0, 10, 100),
    makeItem("Kuupäev 01.03.2026", 0, 25, 150),
    makeItem("Vahesumma", 0, 40, 100),
    makeItem("180,00", 200, 40, 50),
    makeItem("Käibemaks 24%", 0, 60, 110),
    makeItem("48,00", 200, 60, 50),
    makeItem("Kokku", 0, 80, 60),
    makeItem("248,00", 200, 80, 55),
  ];

  it("text path: 180 / 48 / 248 is flagged although the final 200 / 48 / 248 passes the 24% check", () => {
    const result = extractReceiptFieldsFromText(trioLines.join("\n"), "trio.pdf");
    expect(result.total_net).toBe(200);
    expect(result.amount_consistency_issues).toEqual(
      expect.arrayContaining(["explicit_trio_mismatch", "explicit_net_overridden"]),
    );
    expect(result.amount_consistency_issues).not.toContain("vat_rate_implausible");
  });

  it("layout path: the same codes come from reconcileLayoutAmounts and survive the merge", () => {
    const layout = extractAmountsFromLayout(trioItems);
    expect(layout?.explicit_amount_conflicts).toEqual(
      expect.arrayContaining(["explicit_trio_mismatch", "explicit_net_overridden"]),
    );
    const result = extractReceiptFieldsFromText(trioLines.join("\n"), "trio.pdf", { textItems: trioItems });
    expect(result.amount_consistency_issues).toEqual(
      expect.arrayContaining(["explicit_trio_mismatch", "explicit_net_overridden"]),
    );
  });

  it("the merge keeps the layout conflict when it keeps the text values", () => {
    const layout: ExtractedAmountsWithMetadata = {
      total_net: 200, total_vat: 48, total_gross: 248, provenance: [],
      explicit_amount_conflicts: ["explicit_trio_mismatch"],
    };
    const text: ExtractedAmountsWithMetadata = {
      total_net: 100, total_vat: 24, total_gross: 124, vat_explicit: true, provenance: [],
    };
    const merged = mergeLayoutAmounts(layout, text);
    expect(merged.total_gross).toBe(124);
    expect(merged.explicit_amount_conflicts).toEqual(["explicit_trio_mismatch"]);
  });

  it("a VAT labelled only by the next line is discarded without a conflict", () => {
    const text = [
      "Narva mnt 13, 10151 Tallinn",
      "Summa 9,99 € sisaldab KM 0,82 €",
      "Brutosumma 9,99 €",
      "Netosumma 9,17 €",
    ].join("\n");
    const amounts = extractAmountsWithMetadata(text);
    expect(amounts.total_vat).toBe(0.82);
    expect(amounts.explicit_amount_conflicts).toBeUndefined();
  });

  it("H11: an explicit VAT 0.00 contradicted by explicit net and gross keeps today's values and holds", () => {
    const text = ["Subtotal 100.00", "VAT 0.00", "Total 124.00"].join("\n");
    const amounts = extractAmountsWithMetadata(text);
    expect(amounts.total_net).toBe(100);
    expect(amounts.total_vat).toBe(24);
    expect(amounts.total_gross).toBe(124);
    expect(amounts.explicit_amount_conflicts).toEqual(
      expect.arrayContaining(["explicit_vat_overridden"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Field misreads from the live smoke on 1d50fd5 (synthetic fixtures).
// ---------------------------------------------------------------------------

describe("receipt fields — invoice number, supplier and document type misreads", () => {
  const FIXTURE_IBAN = "EE231700017001234567";

  it("Messenger-like: the two-line Arve / Nr. header wins over the bank account and the order number", () => {
    const text = [
      "Saatja:    Saaja:",
      "Näidis Kuller Group OÜ    Proovi OÜ",
      "Arve",
      "Nr. NX2026001",
      "Tellimuse number: 7777123",
      `Arveldusarve nr: ${FIXTURE_IBAN}`,
      "Kuupäev 01.09.2026",
      "Summa KM-ta: EUR 125,00",
      "Kaibemaks (24.00%): EUR 30,00",
      "Arve kokku (EUR): EUR 155,00",
    ].join("\n");
    const result = extractReceiptFieldsFromText(text, "messenger.jpeg", { ownCompanyName: "Proovi OÜ" });
    expect(result.invoice_number).toBe("NX2026001");
    expect(result.supplier_name).toBe("Näidis Kuller Group OÜ");
  });

  it("never takes a valid IBAN behind 'Arveldusarve nr' as the invoice number", () => {
    const number = extractInvoiceNumber([`Arveldusarve nr: ${FIXTURE_IBAN}`, "Kuupäev 01.09.2026"].join("\n"), "x.pdf");
    expect(number).not.toBe(FIXTURE_IBAN);
    expect(number.startsWith("AUTO-")).toBe(true);
  });

  it("keeps compound invoice labels (Müügiarve nr / Sularahaarve nr)", () => {
    expect(extractInvoiceNumber("Müügiarve nr 2026-117", "x.pdf")).toBe("2026-117");
    expect(extractInvoiceNumber("Sularahaarve nr 1633", "x.pdf")).toBe("1633");
  });

  it("cash-invoice-like: 'Sularahaarve 1633' is the invoice number, never the supplier or the buyer", () => {
    const text = [
      "R9 Näidisstuudio OÜ",
      "Arve saaja",
      "Proovi OÜ        Sularahaarve 1633",
      "Kuupäev 05.09.2026",
      "Kokku 50,00 EUR",
    ].join("\n");
    const result = extractReceiptFieldsFromText(text, "duo_r9_1633.pdf", { ownCompanyName: "Proovi OÜ" });
    expect(result.invoice_number).toBe("1633");
    expect(result.supplier_name).not.toBe("Sularahaarve 1633");
    expect(result.supplier_name).not.toBe("Proovi OÜ");
    expect(result.supplier_name).toBe("R9 Näidisstuudio OÜ");
  });

  it("RDE-like layout: a 'Dokumendi number' label is never the supplier", () => {
    const text = [
      "Müüja",
      "Dokumendi number",
      "OÜ Näidis Trade Baltic",
      "Reg. nr 17487472",
      "Kokku käibemaksuga: 151,80",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      { text: "Müüja", x: 50, y: 25, width: 50, height: 10, pageNum: 1 },
      { text: "Dokumendi number", x: 50, y: 40, width: 120, height: 14, pageNum: 1 },
      { text: "OÜ Näidis Trade Baltic", x: 50, y: 60, width: 160, height: 10, pageNum: 1 },
      { text: "Reg. nr 17487472", x: 50, y: 80, width: 120, height: 10, pageNum: 1 },
      { text: "Kokku käibemaksuga: 151,80", x: 50, y: 200, width: 200, height: 10, pageNum: 1 },
    ];
    const result = extractReceiptFieldsFromText(text, "RDE.EE-1.pdf", { textItems });
    expect(result.supplier_name).not.toBe("Dokumendi number");
    expect(result.supplier_name).toBe("OÜ Näidis Trade Baltic");
  });

  it("MTU-like: a supplier label in the right column takes the same column of the next line", () => {
    const text = [
      "Proovi OÜ        Makse saaja:",
      "Pärnu mnt 1, Tallinn        MTÜ NÄIDIS",
      "Arve nr MA2600091",
      "Kuupäev 01.02.2026",
      "liikmemaks 350.00",
      "Tasumisele kuulub 350.00",
    ].join("\n");
    expect(extractReceiptFieldsFromText(text, "MTU_NAIDIS_PROOVI_OU_MA2600091.pdf").supplier_name).toBe("MTÜ NÄIDIS");
    expect(extractReceiptFieldsFromText(text, "MTU_NAIDIS_PROOVI_OU_MA2600091.pdf", { ownCompanyName: "Proovi OÜ" }).supplier_name)
      .toBe("MTÜ NÄIDIS");
  });

  it("a top line 'Seller OÜ   Buyer OÜ' gives the seller when the buyer is the own company", () => {
    const text = ["Näidis Kaubandus OÜ   Proovi OÜ", "Arve nr 5", "Kokku 10,00 EUR"].join("\n");
    expect(extractReceiptFieldsFromText(text, "x.pdf", { ownCompanyName: "Proovi OÜ" }).supplier_name).toBe("Näidis Kaubandus OÜ");
    expect(extractReceiptFieldsFromText("Proovi OÜ\nArve nr 5\nKokku 10,00 EUR", "x.pdf", { ownCompanyName: "Proovi OÜ" }).supplier_name)
      .not.toBe("Proovi OÜ");
  });

  it("offer-like: a sales-offer heading is unclassifiable", () => {
    const text = ["Meeldetuletus/müügipakkumine nr. 82045101", "Tartu mnt 80", "Käibemaksuta: 54,99", "Tasumiseks: 59,94"].join("\n");
    expect(classifyReceiptDocument(text, "ARVE425.pdf")).toBe("unclassifiable");
  });

  it("an invoice that mentions its prepayment invoice stays a purchase invoice", () => {
    const text = ["Arve nr 55", "Ettemaksuarve nr 54 on tasutud", "Kokku 155,00 EUR"].join("\n");
    expect(classifyReceiptDocument(text, "arve.pdf")).toBe("purchase_invoice");
  });

  it("an invoice that references a quotation in its body stays a purchase invoice", () => {
    const text = ["Arve nr 123", "Vastavalt hinnapakkumisele nr 5", "Quotation ref Q-7", "Kokku 10,00 EUR"].join("\n");
    expect(classifyReceiptDocument(text, "arve.pdf")).toBe("purchase_invoice");
  });

  it.each(["PROFORMA INVOICE", "Proforma-arve nr 7"])("a proforma heading (%s) is unclassifiable", heading => {
    expect(classifyReceiptDocument([heading, "Kokku 10,00 EUR"].join("\n"), "doc.pdf")).toBe("unclassifiable");
  });
});

describe("disagreeing layout candidates keep the receipt held (live smoke f8818bd, Codex review)", () => {
  // False holds are acceptable, false creates are not: none of these layouts may
  // be "cleaned up" by dropping a disagreeing candidate. The first is the real
  // geometry of a consistent 93.19 / 12.11 / 105.30 cash invoice that stays held
  // (its layout pass reads the footer BIC and the quantity column); do not
  // "fix" it by discarding candidates.
  const item = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 12, pageNum: 1,
  });
  const isHeld = (result: ReturnType<typeof extractReceiptFieldsFromText>) =>
    result.total_gross_conflict === true || (result.amount_consistency_issues ?? []).length > 0;
  const trioItems = [
    item("Summa km-ta", 52, 100, 60),
    item("100,00", 300, 100, 30),
    item("Käibemaks 20%", 52, 116, 70),
    item("20,00", 300, 116, 30),
    item("Tasuda", 52, 132, 40),
    item("120,00", 300, 132, 30),
  ];
  const trioText = ["Summa km-ta 100,00", "Käibemaks 20% 20,00", "Tasuda 120,00"];

  it("a consistent cash invoice whose layout misreads its table stays held", () => {
    const items = [
      item("Sularahaarve 1633", 432, 106, 83),
      item("Kuupäev", 385, 129, 37),
      item("02.08.2026", 517, 129, 46),
      item("Rg-kood 17487472", 485, 275, 78),
      item("KMKR nr EE102809963", 443, 287, 120),
      item("Kirjeldus", 52, 314, 36),
      item("Kogus Ühik", 301, 314, 49),
      item("Hind km-ga", 392, 314, 48),
      item("Hind km-ta Summa km-ta", 451, 314, 112),
      item("Majutus 02-04.08.26", 54, 330, 85),
      item("1", 322, 330, 5),
      item("105,30", 412, 330, 28),
      item("93,19", 475, 330, 23),
      item("93,19", 540, 330, 23),
      item("Summa km-ta 13% 93,19", 451, 362, 112),
      item("Käibemaks 13%", 464, 379, 66),
      item("12,11", 540, 379, 23),
      item("Arve kokku (EUR) 105,30", 450, 395, 113),
      item("Tasutud 105,30", 496, 411, 67),
      item("Jäänud tasuda", 464, 427, 65),
      item("0,00", 545, 427, 18),
      item("IBAN EE231700017001234567", 430, 774, 134),
      item("SWIFT LHVBEE22", 498, 785, 65),
    ];
    const text = [
      "Sularahaarve 1633",
      "Kuupäev 02.08.2026",
      "Rg-kood 17487472",
      "KMKR nr EE102809963",
      "Kirjeldus Kogus Ühik Hind km-ga Hind km-ta Summa km-ta",
      "Majutus 02-04.08.26 1 105,30 93,19 93,19",
      "Summa km-ta 13% 93,19",
      "Käibemaks 13% 12,11",
      "Arve kokku (EUR) 105,30",
      "Tasutud 105,30",
      "Jäänud tasuda 0,00",
      "IBAN EE231700017001234567",
      "SWIFT LHVBEE22",
    ].join("\n");
    const result = extractReceiptFieldsFromText(text, "invoice-1633.pdf", { textItems: items });
    expect(result).toMatchObject({ total_net: 93.19, total_vat: 12.11, total_gross: 105.3 });
    expect(isHeld(result)).toBe(true);
  });

  it("a plausible total far below its own label column holds", () => {
    const items = [...trioItems, item("Kokku", 450, 150, 30), item("124,00", 450, 230, 30)];
    const result = extractReceiptFieldsFromText([...trioText, "Kokku", "124,00"].join("\n"), "far.pdf", { textItems: items });
    expect(isHeld(result)).toBe(true);
  });

  it("a total glued to its label (\"Kokku124\") holds", () => {
    const items = [...trioItems, item("Kokku124", 52, 148, 50)];
    const result = extractReceiptFieldsFromText([...trioText, "Kokku124"].join("\n"), "glued.pdf", { textItems: items });
    expect(isHeld(result)).toBe(true);
  });

  it("a total under a header split across columns (\"Summa\" | \"koos KM\") holds", () => {
    const items = [...trioItems, item("Summa", 400, 150, 35), item("koos KM", 470, 150, 45), item("124,00", 400, 166, 30)];
    const result = extractReceiptFieldsFromText([...trioText, "Summa koos KM", "124,00"].join("\n"), "split.pdf", { textItems: items });
    expect(isHeld(result)).toBe(true);
  });
});

describe("document-scope and amount-evidence holds (WP1)", () => {
  const item = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 12, pageNum: 1,
  });

  describe("G1 multiple_documents_in_file", () => {
    it("two distinct ticket numbers in one file hold", () => {
      const text = [
        "Lux Express Estonia AS",
        "Pileti nr 900000000001", "Hind 12,50 EUR",
        "Pileti nr 900000000002", "Hind 12,50 EUR",
        "Kokku 25,00 EUR",
      ].join("\n");
      expect(extractReceiptFieldsFromText(text, "tickets.pdf").multiple_documents_in_file).toBe(true);
    });

    it("one ticket number printed twice does not", () => {
      const text = ["Lux Express Estonia AS", "Pileti nr 900000000001", "Pileti nr 900000000001", "Kokku 12,50 EUR"].join("\n");
      expect(extractReceiptFieldsFromText(text, "ticket.pdf").multiple_documents_in_file).toBeUndefined();
    });

    it("an invoice citing another invoice number is one document", () => {
      const text = [
        "Näidis OÜ",
        "Arve Nr.: TEST0002",
        "Tasaarveldatud ettemaksuarve Nr.: TEST0001 kuupäevaga 01.08.2026",
        "Kokku 155,00 EUR",
      ].join("\n");
      expect(extractReceiptFieldsFromText(text, "arve.pdf").multiple_documents_in_file).toBeUndefined();
    });
  });

  describe("G2 buyer block", () => {
    const own = { ownCompanyName: "Testfirma OÜ", ownCompanyRegistryCode: "87654321", ownCompanyVat: "EE100000001" };
    const extractWithBuyerBlock = (block: string[], options: Parameters<typeof extractReceiptFieldsFromText>[2] = own) => {
      const items = [
        item("Kauplus Näide AS", 52, 40, 90),
        item("Arve nr 2026-15", 400, 40, 90),
        item("Arve saaja:", 52, 100, 60),
        ...block.map((line, index) => item(line, 52, 114 + index * 14, 120)),
        item("Summa km-ta 100,00", 400, 300, 110),
        item("Käibemaks 24,00", 400, 316, 90),
        item("Kokku 124,00", 400, 332, 80),
        // The active company named outside the buyer block never clears it.
        item("Täname, et valisite Testfirma OÜ partneri", 52, 700, 220),
      ];
      return extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { ...options, textItems: items });
    };

    it("another legal entity as buyer, the active company only in the footer, holds", () => {
      const result = extractWithBuyerBlock(["Näidis Kaubandus OÜ", "Reg nr 12345678"]);
      expect(result.buyer_not_active_company).toBe(true);
      expect(result.buyer_ambiguous).toBeUndefined();
    });

    it("the active company and another legal entity in the block hold as ambiguous", () => {
      expect(extractWithBuyerBlock(["Näidis Kaubandus OÜ", "Testfirma OÜ"]).buyer_ambiguous).toBe(true);
      expect(extractWithBuyerBlock(["Näidis Kaubandus OÜ", "Reg nr 87654321"]).buyer_ambiguous).toBe(true);
    });

    it("the active company as buyer raises nothing", () => {
      const result = extractWithBuyerBlock(["Testfirma OÜ", "Reg nr 87654321"]);
      expect(result.buyer_not_active_company).toBeUndefined();
      expect(result.buyer_ambiguous).toBeUndefined();
    });

    it("a person as buyer raises nothing", () => {
      const result = extractWithBuyerBlock(["Mari Maasikas", "Tartu mnt 1"]);
      expect(result.buyer_not_active_company).toBeUndefined();
      expect(result.buyer_ambiguous).toBeUndefined();
    });

    // Codex review: an unknown own identity must not disable the check.
    it("a legal-entity buyer with no known own identifier holds as ownership unverified", () => {
      const result = extractWithBuyerBlock(["Näidis Kaubandus OÜ"], {});
      expect(result.buyer_ownership_unverified).toBe(true);
      expect(result.buyer_not_active_company).toBeUndefined();
    });

    it("a person as buyer with no known own identifier raises nothing", () => {
      expect(extractWithBuyerBlock(["Mari Maasikas"], {}).buyer_ownership_unverified).toBeUndefined();
    });

    // Codex review: every entity on a buyer line counts, not only the first.
    it("the active company and another legal entity on one line hold as ambiguous", () => {
      const result = extractWithBuyerBlock(["Testfirma OÜ / Other OÜ"], { ownCompanyName: "Testfirma OÜ" });
      expect(result.buyer_ambiguous).toBe(true);
      expect(extractWithBuyerBlock(["Other OÜ / Testfirma OÜ"], { ownCompanyName: "Testfirma OÜ" }).buyer_ambiguous).toBe(true);
      expect(extractWithBuyerBlock(["Testfirma OÜ / Osaühing Näidis"], { ownCompanyName: "Testfirma OÜ" }).buyer_ambiguous).toBe(true);
    });

    it("the active company alone on a line with its address raises nothing", () => {
      const result = extractWithBuyerBlock(["Testfirma OÜ, Tartu mnt 1"], { ownCompanyName: "Testfirma OÜ" });
      expect(result.buyer_ambiguous).toBeUndefined();
      expect(result.buyer_not_active_company).toBeUndefined();
    });

    describe("labelled identifiers below a single-column buyer", () => {
      const extract = (buyer: string[], metadata: string[], options: Parameters<typeof extractReceiptFieldsFromText>[2] = {
        ownCompanyName: "Seppo OÜ", ownCompanyRegistryCode: "14417608",
      }) => {
        const lines = [
          "Delfi Meedia AS", "Müüja: Delfi Meedia AS", "Müüja registrikood: 10586863", "Müüja KMKR: EE100576146",
          "Ostja:", ...buyer, ...metadata, "Arve kuupäev: 2026-10-18", "Valuuta: EUR",
          "Summa ilma KM-ta: 11,92 EUR", "Käibemaks 9%: 1,07 EUR", "Kokku: 12,99 EUR",
        ];
        const textItems = lines.map((text, index) => item(text, 52, 40 + index * 14, 240));
        return extractReceiptFieldsFromText(lines.join("\n"), "01-base.pdf", { ...options, textItems });
      };

      it.each(["Arve nr LIVE-OU-A17", "Invoice no LIVE-OU-A17"])("%s is the unchanged invoice identifier, not a second buyer", metadata => {
        const result = extract(["Seppo OÜ", "Ostja registrikood: 14417608"], [metadata]);
        expect(result.invoice_number).toBe("LIVE-OU-A17");
        expect(result.buyer_ambiguous).toBeUndefined();
        expect(result.buyer_not_active_company).toBeUndefined();
        expect(result.supplier_reg_code).toBe("10586863");
      });

      it("a reference identifier containing AS is not a legal entity", () => {
        const result = extract(["Seppo OÜ"], ["Arve nr LIVE-X-A17", "Reference: ABC-AS-123"]);
        expect(result.buyer_ambiguous).toBeUndefined();
        expect(result.invoice_number).toBe("LIVE-X-A17");
      });

      it("metadata does not turn a different buyer into the active company", () => {
        const result = extract(["Teine OÜ"], ["Arve nr LIVE-OU-A17"]);
        expect(result.buyer_not_active_company).toBe(true);
        expect(result.buyer_ambiguous).toBeUndefined();
      });

      it.each([
        ["Seppo OÜ", "Teine OÜ"],
        ["Seppo OÜ / Teine OÜ"],
        ["Seppo OÜ / Osaühing Näidis"],
        ["Seppo OÜ", "Studio 54 OÜ"],
      ])("genuine additional buyer names remain ambiguous: %j", (...buyer) => {
        expect(extract(buyer, ["Arve nr LIVE-OU-A17"]).buyer_ambiguous).toBe(true);
      });

      it.each([
        "Arve nr LIVE-OU-A17 / Teine OÜ",
        "Arve nr LIVE-OU-A17 Teine OÜ",
        "Arve nr LIVE-OU-A17 Studio 54 OÜ",
      ])("preserves a real company after metadata: %s", metadata => {
        expect(extract(["Seppo OÜ"], [metadata]).buyer_ambiguous).toBe(true);
      });

      it.each(["LIVE-OU-A17", "Arve nr ÄLIVE-OU-A17", "Arve nr LIVE-OU-A17Ä", "Arve nr LIVE-OU-A17\u0301"])("unproven or Unicode-extended token stays conservative: %s", metadata => {
        expect(extract(["Seppo OÜ"], [metadata]).buyer_ambiguous).toBe(true);
      });

      it("an identifier filter cannot verify a legal buyer when own identity is unknown", () => {
        expect(extract(["Seppo OÜ"], ["Arve nr LIVE-OU-A17"], {}).buyer_ownership_unverified).toBe(true);
      });
    });
  });

  describe("G3 gross_unlabelled", () => {
    it("a gross picked as the largest unlabelled amount holds, and the currency mark binds to its own amount", () => {
      const result = extractReceiptFieldsFromText(["Paddle.com", "Your order", "50,000 tokens 1 US$50.00"].join("\n"), "order.pdf");
      expect(result.total_gross).toBe(50);
      expect(result.gross_unlabelled).toBe(true);
    });

    it("a labelled total does not", () => {
      const result = extractReceiptFieldsFromText(["Paddle.com", "Your order", "50,000 tokens 1", "Total US$50.00"].join("\n"), "order.pdf");
      expect(result.total_gross).toBe(50);
      expect(result.gross_unlabelled).toBeUndefined();
    });

    it("EUR \"Teenus 1 200,00\" with \"VAT €0.00\" holds", () => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Teenus 1 200,00", "VAT €0.00"].join("\n"), "arve.pdf");
      expect(result.gross_unlabelled).toBe(true);
    });

    it("a labelled net and a labelled VAT adding up to the unlabelled gross corroborate it", () => {
      const corroborated = extractReceiptFieldsFromText(["Näidis OÜ", "Summa km-ta 100,00", "Käibemaks 24,00", "124,00"].join("\n"), "arve.pdf");
      expect(corroborated).toMatchObject({ total_net: 100, total_vat: 24, total_gross: 124 });
      expect(corroborated.gross_unlabelled).toBeUndefined();
      const contradicted = extractReceiptFieldsFromText(["Näidis OÜ", "Summa km-ta 100,00", "Käibemaks 20,00", "124,00"].join("\n"), "arve.pdf");
      expect(contradicted.gross_unlabelled).toBe(true);
    });
  });

  describe("G4 labelled_amount_over_max", () => {
    it("a four-token Kokku run merged past the maximum holds", () => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Kokku 100.00 24.00 124.00 248.00"].join("\n"), "arve.pdf");
      expect(result.labelled_amount_over_max).toBe(true);
    });

    it("a labelled total above the maximum holds", () => {
      expect(extractReceiptFieldsFromText(["Näidis OÜ", "Kokku 60 000,00 EUR"].join("\n"), "arve.pdf").labelled_amount_over_max).toBe(true);
    });

    it("an over-maximum value a total label picks without a money format holds", () => {
      // The labelled gross pick has no maximum check, so the flag must survive.
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Kokku tellimus 123456789"].join("\n"), "arve.pdf");
      expect(result.labelled_amount_over_max).toBe(true);
    });

    it("a net label whose over-maximum value the line filter drops holds", () => {
      const result = extractReceiptFieldsFromText(
        ["Näidis OÜ", "Summa km-ta 100,00", "Käibemaks 24,00", "Kokku 124,00 EUR", "Summa km-ta 60 000,00"].join("\n"),
        "arve.pdf",
      );
      expect(result.total_gross).toBe(124);
      expect(result.labelled_amount_over_max).toBe(true);
    });

    it("a layout label whose only candidate is over the maximum holds", () => {
      const items = [item("Näidis OÜ", 52, 40, 60), item("Kokku", 52, 200, 40), item("60 000,00", 300, 200, 50)];
      const result = extractReceiptFieldsFromText("Näidis OÜ\nKokku\n60 000,00", "arve.pdf", { textItems: items });
      expect(result.labelled_amount_over_max).toBe(true);
    });

    it("identifiers on or below a labelled line are not amount evidence", () => {
      expect(extractReceiptFieldsFromText(["Näidis OÜ", "Viitenumber 123456789012", "Kokku 10,00 EUR"].join("\n"), "arve.pdf").labelled_amount_over_max)
        .toBeUndefined();
      const items = [
        item("Näidis OÜ", 52, 40, 60),
        item("Kokku", 300, 200, 40), item("10,00", 400, 200, 30),
        item("Jäänud tasuda", 300, 220, 70),
        item("IBAN EE107700771005782542", 300, 260, 140),
        item("Reg nr: 80305937", 300, 280, 90),
      ];
      const result = extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { textItems: items });
      expect(result.labelled_amount_over_max).toBeUndefined();
    });

    // Codex review: a label-bound integer over the maximum is evidence too;
    // only a positively identified identifier is not.
    describe("an integer cell a layout label binds", () => {
      const cleanTrio = [
        item("Näidis OÜ", 52, 40, 60),
        item("Summa km-ta", 52, 100, 60), item("100.00", 400, 100, 30),
        item("Käibemaks 0%", 52, 116, 70), item("0.00", 400, 116, 30),
        item("Kokku", 52, 132, 30), item("100.00", 400, 132, 30),
        item("Grand total", 400, 200, 60),
      ];
      const extractWith = (below: LayoutTextItem[]) => {
        const items = [...cleanTrio, ...below];
        return extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { textItems: items });
      };

      it.each([
        ["a bare integer", [item("60000", 400, 216, 30)]],
        ["an integer with a currency code", [item("60000 EUR", 400, 216, 50)]],
        // Round 3: an amount word in the label span proves no identifier.
        ["beside an amount-worded number label", [item("Summa nr:", 330, 216, 50), item("12345678", 400, 216, 40)]],
      ])("%s over the maximum holds", (_name, below) => {
        expect(extractWith(below).labelled_amount_over_max).toBe(true);
      });

      it.each([
        ["under a registry-code heading", [item("Registrikood", 400, 216, 60), item("12345678", 400, 232, 40)]],
        ["beside a number label", [item("Nr:", 340, 216, 20), item("12345678", 400, 216, 40)]],
        ["inside an address", [item("Tartu 51013", 400, 216, 60)]],
        ["as a phone number", [item("+37251234567", 400, 216, 60)]],
        ["as an IBAN", [item("EE107700771005782542", 400, 216, 100)]],
        // "tasumisel" (when paying) names no amount (seen live: ARVE425).
        ["beside a payment reference label", [item("Palun kasutage tasumisel viitenumbrit:", 200, 216, 190), item("10106820451011", 400, 216, 70)]],
      ])("an identifier %s is not evidence", (_name, below) => {
        expect(extractWith(below).labelled_amount_over_max).toBeUndefined();
      });

      // Codex review round 3: a reference / IBAN excludes only its own span.
      it.each([
        "Grand total 60000    Reference PO-555",
        "Grand total 60000    IBAN EE107700771005782542",
        "Grand total 60000 IBAN EE107700771005782542",
        "Viitenumber 123    Grand total 60000",
        // Round 4: a column gap between the label and its value.
        "Grand total    60000    Reference PO-555",
        "Grand total\t60000\tReference PO-555",
        "Grand total    60000    IBAN EE10 7700 7710 0578 2542",
        "Viitenumber 123    Grand total    60000",
      ])("text: an amount-labelled value beside a reference span holds: %s", (line) => {
        const result = extractReceiptFieldsFromText(["Näidis OÜ", "Summa km-ta 100.00", "Käibemaks 0% 0.00", "Kokku 100.00", line].join("\n"), "arve.pdf");
        expect(result.total_gross).toBe(100);
        expect(result.labelled_amount_over_max).toBe(true);
      });

      it.each([
        "Viitenumber 123456789012    Tellimus 123456789    Kokku 10,00 EUR",
        "Kokku 10,00 EUR    IBAN EE10 7700 7710 0578 2542",
      ])("text: a reference beside a normal total is not evidence: %s", (line) => {
        const result = extractReceiptFieldsFromText(["Näidis OÜ", line].join("\n"), "arve.pdf");
        expect(result.labelled_amount_over_max).toBeUndefined();
      });

      it("layout: an amount-labelled value beside a reference item holds", () => {
        const items = [
          ...cleanTrio.slice(0, -1),
          item("Grand total", 52, 200, 60), item("60000", 200, 200, 30), item("Reference PO-555", 400, 200, 80),
        ];
        const result = extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { textItems: items });
        expect(result.labelled_amount_over_max).toBe(true);
      });

      // Codex review round 2: a value an amount label binds on its own row is
      // that label's amount, even under an identifier heading.
      it.each(["Arve nr", "Konto"])("a value bound on the label's own row under a \"%s\" heading holds", (heading) => {
        const items = [
          ...cleanTrio.slice(0, -1),
          item(heading, 400, 180, 40),
          item("Grand total", 300, 200, 60), item("60000", 400, 200, 30),
        ];
        const result = extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { textItems: items });
        expect(result.labelled_amount_over_max).toBe(true);
      });
    });
  });

  describe("G5 zero_total_stated", () => {
    it("a zero net / VAT / total trio holds", () => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Summa km-ta 0,00", "Käibemaks 24% 0,00", "Kogusumma 0,00"].join("\n"), "arve.pdf");
      expect(result.zero_total_stated).toBe(true);
    });

    it("a prepaid invoice stating \"Arve kokku 0,00\" holds", () => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Teenus 120,00", "Ettemaks −120,00", "Arve kokku 0,00"].join("\n"), "arve.pdf");
      expect(result.zero_total_stated).toBe(true);
    });

    it("a zero remaining balance under a stated total does not", () => {
      const result = extractReceiptFieldsFromText(
        ["Näidis OÜ", "Summa km-ta 100,00", "Käibemaks 24% 24,00", "Kokku 124,00", "Tasutud 124,00", "Jäänud tasuda 0,00"].join("\n"),
        "arve.pdf",
      );
      expect(result.zero_total_stated).toBeUndefined();
      expect(result.total_gross).toBe(124);
    });

    it("a zero \"PAYABLE AMOUNT\" under a stated total does not", () => {
      const result = extractReceiptFieldsFromText(
        ["Example Ltd", "Subtotal 100.00 EUR", "VAT 24% 24.00 EUR", "Total 124.00 EUR", "Paid 124.00 EUR", "PAYABLE AMOUNT 0.00 EUR"].join("\n"),
        "invoice.pdf",
      );
      expect(result.zero_total_stated).toBeUndefined();
      expect(result.total_gross).toBe(124);
    });

    it("a zero invoice total still holds beside a zero \"PAYABLE AMOUNT\"", () => {
      const result = extractReceiptFieldsFromText(
        ["Example Ltd", "Service 120.00 EUR", "Prepayment -120.00 EUR", "Invoice total 0.00 EUR", "PAYABLE AMOUNT 0.00 EUR"].join("\n"),
        "invoice.pdf",
      );
      expect(result.zero_total_stated).toBe(true);
    });

    it("a zero \"Payable amount\" row in the layout under a stated total does not", () => {
      const items = [
        item("Example Ltd", 52, 40, 60),
        item("Total", 300, 180, 40), item("124.00", 420, 180, 30),
        item("Payable amount", 300, 200, 80), item("0.00", 420, 200, 20),
      ];
      const result = extractReceiptFieldsFromText("Example Ltd\nTotal\n124.00\nPayable amount\n0.00", "invoice.pdf", { textItems: items });
      expect(result.zero_total_stated).toBeUndefined();
    });

    // Codex review: an adjacent other amount must not hide the stated zero.
    it("a zero total beside another amount on the same line holds", () => {
      const result = extractReceiptFieldsFromText(
        ["Näidis OÜ", "Summa km-ta 100.00", "Käibemaks 24% 24.00", "Kokku 124.00", "Kogusumma 0.00    Ettemaks 100.00"].join("\n"),
        "arve.pdf",
      );
      expect(result.zero_total_stated).toBe(true);
    });

    it("a zero total beside another amount on the same layout row holds", () => {
      const layout = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Summa km-ta", 52, 100, 60), item("100.00", 400, 100, 30),
        item("Käibemaks 24%", 52, 116, 70), item("24.00", 400, 116, 30),
        item("Kokku", 52, 132, 30), item("124.00", 400, 132, 30),
        item("Kogusumma", 52, 200, 60), item("0.00", 150, 200, 20), item("Ettemaks", 250, 200, 50), item("100.00", 400, 200, 30),
      ]);
      expect(layout?.zero_total_stated).toBe(true);
    });

    it("a zero bound to a remaining-balance label or to no label on a total line does not", () => {
      expect(extractReceiptFieldsFromText(["Näidis OÜ", "Kokku 124,00    Jäänud tasuda 0,00"].join("\n"), "arve.pdf").zero_total_stated)
        .toBeUndefined();
      expect(extractReceiptFieldsFromText(["Näidis OÜ", "Kokku 124,00 0,00"].join("\n"), "arve.pdf").zero_total_stated)
        .toBeUndefined();
    });

    it("a zero total row in the layout holds", () => {
      const items = [item("Näidis OÜ", 52, 40, 60), item("Kogusumma (EUR)", 300, 200, 80), item("0,00", 420, 200, 20)];
      const result = extractReceiptFieldsFromText("Näidis OÜ\nKogusumma (EUR)\n0,00", "arve.pdf", { textItems: items });
      expect(result.zero_total_stated).toBe(true);
    });
  });
});

describe("row triples and layout amount tokens (WP2)", () => {
  const item = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 12, pageNum: 1,
  });
  const extractLayout = (items: LayoutTextItem[]) =>
    extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { textItems: items });

  describe("R4 / R6 total row triple", () => {
    it("a merged three-amount total row splits and binds its sum as the gross", () => {
      expect(extractAmountsFromLine("Kokku € 483.07 115.93 599.00")).toEqual([483.07, 115.93, 599]);
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Kokku € 483.07 115.93 599.00"].join("\n"), "arve.pdf");
      expect(result.total_gross).toBe(599);
      expect(result.labelled_amount_over_max).toBeUndefined();
    });

    it("a total row's gross is the triple's sum wherever it is printed", () => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Kokku 599.00 483.07 115.93"].join("\n"), "arve.pdf");
      expect(result.total_gross).toBe(599);
    });

    it("a layout total label with three amount cells binds the sum, not the nearest", () => {
      const result = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Kokku €", 52, 200, 40),
        item("483.07", 300, 200, 30), item("115.93", 360, 200, 30), item("599.00", 420, 200, 30),
      ]);
      expect(result?.total_gross).toBe(599);
    });

    it("a fourth token keeps the run merged and held", () => {
      expect(extractAmountsFromLine("Kokku € 483.07 115.93 599.00 12.00")).toHaveLength(1);
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Kokku € 483.07 115.93 599.00 12.00"].join("\n"), "arve.pdf");
      expect(result.labelled_amount_over_max).toBe(true);
    });

    it("three tokens without a sum stay merged", () => {
      expect(extractAmountsFromLine("Kokku 483.07 115.93 600.00")).toHaveLength(1);
    });

    it("two valid triples on one row stay merged and held", () => {
      expect(extractAmountsFromLine("Kokku 5.00 10.00 15.00 / 5.00 10.00 15.00")).not.toContain(15);
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Kokku 5.00 10.00 15.00 / 5.00 10.00 15.00"].join("\n"), "arve.pdf");
      expect(result.labelled_amount_over_max).toBe(true);
    });

    // Codex review: a fourth amount elsewhere on the row is disagreeing
    // evidence; labelled net 100 / VAT 24 must not end clean 100 / 24 / 124.
    it("another amount on the text row keeps the triple merged and held", () => {
      expect(extractAmountsFromLine("Kokku 248.00 / 100.00 24.00 124.00")).toHaveLength(2);
      const result = extractReceiptFieldsFromText(
        ["Näidis OÜ", "Summa km-ta 100.00", "Käibemaks 24% 24.00", "Kokku 248.00 / 100.00 24.00 124.00"].join("\n"),
        "arve.pdf",
      );
      expect(result.labelled_amount_over_max).toBe(true);
    });

    it("a proven invoice number on the row is not a fourth amount", () => {
      const line = "Arve nr MA2600009 kokku: 350.00 84.00 434.00";
      expect(extractAmountsFromLine(line)).toEqual([2600009, 350, 84, 434]);
      expect(extractReceiptFieldsFromText(["Näidis OÜ", line].join("\n"), "arve.pdf").total_gross).toBe(434);
      const layout = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Kokku", 52, 200, 40), item("Leping nr LP2600009", 120, 200, 90),
        item("350.00", 300, 200, 30), item("84.00", 360, 200, 30), item("434.00", 420, 200, 30),
      ]);
      expect(layout?.total_gross).toBe(434);
    });

    // Codex review round 2: a money-shaped token glued to a label or a
    // currency code is a competing amount, not an identifier.
    it.each([
      "Kokku248.00 / 100.00 24.00 124.00",
      "EUR248.00 Kokku 100.00 24.00 124.00",
      // A money decimal part wins over an identifier label before it.
      "Kokku nr 248.00 / 100.00 24.00 124.00",
    ])("a glued money token keeps the triple merged and held: %s", (line) => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Summa km-ta 100.00", "Käibemaks 24% 24.00", line].join("\n"), "arve.pdf");
      expect(result.labelled_amount_over_max).toBe(true);
    });

    // Codex review round 3: an identifier word inside an amount label span
    // ("Summa nr", "Kokku kood") proves nothing; the number competes.
    it.each([
      "Summa nr 248 / Kokku 100.00 24.00 124.00 EUR",
      "Kokku kood 248 / Kokku 100.00 24.00 124.00 EUR",
    ])("a number under an amount-worded identifier label keeps the triple merged and held: %s", (line) => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Summa km-ta 100.00", "Käibemaks 24% 24.00", line].join("\n"), "arve.pdf");
      expect(result.labelled_amount_over_max).toBe(true);
    });

    it("a number under an amount-worded identifier label on the layout row keeps the triple unbound", () => {
      const layout = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Kokku", 52, 200, 40), item("Summa nr 248", 120, 200, 80),
        item("350.00", 300, 200, 30), item("84.00", 360, 200, 30), item("434.00", 420, 200, 30),
      ]);
      expect(layout?.total_gross).not.toBe(434);
    });

    it("an unproven glued integer on the layout row keeps the triple unbound", () => {
      const layout = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Kokku", 52, 200, 40), item("Leping LP2600009", 120, 200, 80),
        item("350.00", 300, 200, 30), item("84.00", 360, 200, 30), item("434.00", 420, 200, 30),
      ]);
      expect(layout?.total_gross).not.toBe(434);
    });

    it("a glued money token left of the layout total label keeps the triple unbound", () => {
      const layout = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Summa km-ta", 52, 100, 60), item("100.00", 400, 100, 30),
        item("Käibemaks 24%", 52, 116, 70), item("24.00", 400, 116, 30),
        item("EUR248.00", 52, 132, 40), item("Kokku", 200, 132, 30),
        item("100.00", 300, 132, 30), item("24.00", 350, 132, 30), item("124.00", 400, 132, 30),
      ]);
      expect(layout?.explicit_amount_conflicts ?? []).not.toHaveLength(0);
    });

    it("an amount left of the layout total label keeps the row out of the triple binding", () => {
      const result = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Summa km-ta", 52, 100, 60), item("100.00", 400, 100, 30),
        item("Käibemaks 24%", 52, 116, 70), item("24.00", 400, 116, 30),
        item("248.00", 52, 132, 30), item("Kokku", 200, 132, 30),
        item("100.00", 300, 132, 30), item("24.00", 350, 132, 30), item("124.00", 400, 132, 30),
      ]);
      expect(result?.explicit_amount_conflicts ?? []).not.toHaveLength(0);
    });
  });

  describe("R5 VAT-rate row triple", () => {
    it("binds the part equal to the stated rate × the other part", () => {
      const result = extractReceiptFieldsFromText(
        ["Näidis OÜ", "Arve nr 5", "Kuupäev 01.08.2026", "Käibemaks 24% 350.00 84.00 434.00", "Arve kokku: 350.00 84.00 434.00"].join("\n"),
        "arve.pdf",
      );
      expect(result).toMatchObject({ total_net: 350, total_vat: 84, total_gross: 434 });
      const layout = extractAmountsFromLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Käibemaks 24%", 52, 200, 70),
        item("350.00", 300, 200, 30), item("84.00", 360, 200, 30), item("434.00", 420, 200, 30),
        item("Kokku", 52, 216, 40), item("434.00", 420, 216, 30),
      ]);
      expect(layout).toMatchObject({ total_net: 350, total_vat: 84, total_gross: 434 });
    });

    it("a triple whose ratio mismatches the stated rate stays held", () => {
      const result = extractReceiptFieldsFromText(
        ["Näidis OÜ", "Arve nr 5", "Kuupäev 01.08.2026", "Käibemaks 24% 350.00 80.00 430.00"].join("\n"),
        "arve.pdf",
      );
      expect(result.total_vat).not.toBe(80);
      expect((result.amount_consistency_issues ?? []).length).toBeGreaterThan(0);
    });

    it("two components with identical 24.00 VAT are not cleaned to 100 / 24 / 124", () => {
      const result = extractLayout([
        item("Näidis OÜ", 52, 40, 60),
        item("Teenus A", 52, 100, 60), item("100,00", 300, 100, 30),
        item("Käibemaks 24%", 52, 116, 70), item("24,00", 300, 116, 30),
        item("Teenus B", 52, 132, 60), item("100,00", 300, 132, 30),
        item("Käibemaks 24%", 52, 148, 70), item("24,00", 300, 148, 30),
        item("Kokku", 52, 164, 40), item("248,00", 300, 164, 30),
      ]);
      expect(result).toMatchObject({ total_net: 200, total_vat: 48, total_gross: 248 });
    });
  });

  describe("R8 layout percent sign", () => {
    const rateRow = (gap: number) => [
      item("Näidis OÜ", 52, 40, 60),
      item("Summa km-ta", 52, 100, 60), item("50,00", 300, 100, 30),
      item("Käibemaks", 52, 116, 60), item("24,0", 200, 116, 20), item("%", 220 + gap, 116, 8), item("12,00", 300, 116, 30),
      item("Kokku", 52, 132, 40), item("62,00", 300, 132, 30),
    ];

    it("a number followed by an adjacent \"%\" item is a rate, not an amount", () => {
      expect(extractLayout(rateRow(0))).toMatchObject({ total_net: 50, total_vat: 12, total_gross: 62 });
    });

    it("a \"%\" item beyond the gap threshold leaves the number counted (held)", () => {
      const result = extractLayout(rateRow(30));
      expect(result.total_vat).toBe(24);
      expect((result.amount_consistency_issues ?? []).length).toBeGreaterThan(0);
    });
  });

  describe("R9 footnote marker", () => {
    it("a complete standalone \"[1]\" is not an amount", () => {
      expect(extractAmountsFromLine("Tax [1] 0.00")).toEqual([]);
      expect(extractAmountsFromLine("[12] Tax 3.00")).toEqual([3]);
    });

    it("\"[123]\" and \"x[1]\" are not skipped", () => {
      expect(extractAmountsFromLine("Tax [123] 0.00")).toEqual([123]);
      expect(extractAmountsFromLine("Tax x[1] 0.00")).toEqual([1]);
    });
  });
});

describe("header spans led by a non-amount column (WP3)", () => {
  const item = (text: string, x: number, y: number, width: number, pageNum = 1): LayoutTextItem => ({
    text, x, y, width, height: 12, pageNum,
  });
  const extractLayout = (items: LayoutTextItem[]) =>
    extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { textItems: items });

  it("a \"Kirjeldus Periood Kokku\" header does not read the description column's footer as the total", () => {
    const result = extractLayout([
      item("Näidis Meedia OÜ", 52, 40, 80),
      item("Kirjeldus", 52, 200, 50), item("Periood", 200, 200, 40), item("Kokku", 400, 200, 30),
      item("Domeeni teenus", 52, 216, 60), item("1 aasta", 200, 216, 40), item("6,00", 400, 216, 20),
      item("Summa km-ta", 300, 260, 60), item("6,00", 400, 260, 20),
      item("Käibemaks 24%", 300, 276, 70), item("1,44", 400, 276, 20),
      item("Kokku", 300, 292, 30), item("7,44", 400, 292, 20),
      item("Lõõtsa 5", 52, 700, 40),
    ]);
    expect(result).toMatchObject({ total_net: 6, total_vat: 1.44, total_gross: 7.44 });
    expect(result.total_gross_conflict).toBeUndefined();
    expect(result.amount_consistency_issues).toBeUndefined();
  });

  it("pin: a three-page zero-total invoice stays held", () => {
    const result = extractLayout([
      item("Näidis Pilv Ltd", 52, 40, 80), item("Arve nr 5713900000", 300, 40, 90),
      item("Kogusumma (EUR)", 52, 200, 80), item("0,00", 400, 200, 20),
      item("Teenus", 52, 100, 40, 2), item("11,94", 400, 100, 30, 2),
      item("Kokku", 52, 116, 40, 2), item("11,94", 400, 116, 30, 2),
      item("Ettemaks rakendatud", 52, 100, 90, 3), item("−11,94", 400, 100, 30, 3),
    ]);
    expect(result.zero_total_stated).toBe(true);
  });

  it.each([
    ["Kogusumma", "total_gross"],
    ["Summa kokku", "total_gross"],
    ["Kokku KM-ta", "total_net"],
  ] as const)("pin: a \"%s\" header span is still a label", (header, field) => {
    const [first, ...rest] = header.split(" ");
    const items = [
      item("Näidis OÜ", 52, 40, 60),
      item(first!, 300, 200, 40),
      ...rest.map((word, index) => item(word, 345 + index * 45, 200, 40)),
      item("50,00", 300, 216, 30),
    ];
    expect(extractAmountsFromLayout(items)?.provenance.some(entry => entry.field === field && entry.value === 50)).toBe(true);
  });

  it("pin: a split \"Kokku\" | \"KM-ta\" net header whose value disagrees with the labelled net holds", () => {
    const result = extractLayout([
      item("Näidis OÜ", 52, 40, 60),
      item("Kokku", 300, 200, 30), item("KM-ta", 340, 200, 30),
      item("90,00", 300, 216, 30),
      item("Summa km-ta 100,00", 52, 260, 100), item("Käibemaks 24,00", 52, 276, 90), item("Kokku 124,00", 52, 292, 80),
    ]);
    expect(result.total_gross_conflict === true || (result.amount_consistency_issues ?? []).length > 0).toBe(true);
  });
});

describe("a label's own-row value stops the below-column search (WP4)", () => {
  const item = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 12, pageNum: 1,
  });
  const extractLayout = (items: LayoutTextItem[]) =>
    extractReceiptFieldsFromText(items.map(entry => entry.text).join("\n"), "arve.pdf", { textItems: items });
  const isHeld = (result: ReturnType<typeof extractReceiptFieldsFromText>) =>
    result.total_gross_conflict === true || (result.amount_consistency_issues ?? []).length > 0 ||
    result.zero_total_stated === true || result.labelled_amount_over_max === true;
  const trio = [
    item("Summa km-ta", 52, 100, 60), item("100,00", 300, 100, 30),
    item("Käibemaks 24%", 52, 116, 70), item("24,00", 300, 116, 30),
    item("Kokku", 52, 132, 40), item("124,00", 300, 132, 30),
  ];

  it("a zero remaining balance does not bind a footer bank code below it", () => {
    const result = extractLayout([
      item("Näidis OÜ", 52, 40, 60),
      ...trio,
      item("Jäänud tasuda", 400, 148, 65), item("0,00", 480, 148, 18),
      item("SWIFT LHVBEE22", 400, 700, 65),
    ]);
    expect(result).toMatchObject({ total_net: 100, total_vat: 24, total_gross: 124 });
    expect(isHeld(result)).toBe(false);
  });

  it("a zero invoice total keeps searching and is held", () => {
    const result = extractLayout([
      item("Näidis OÜ", 52, 40, 60),
      ...trio,
      item("Arve kokku", 400, 148, 50), item("0,00", 480, 148, 18),
      item("SWIFT LHVBEE22", 400, 700, 65),
    ]);
    expect(result.zero_total_stated).toBe(true);
    expect(isHeld(result)).toBe(true);
  });

  it("a zero total label still searches the column below it", () => {
    const items = [
      item("Näidis OÜ", 52, 40, 60),
      item("Kogusumma (EUR)", 300, 100, 80), item("0,00", 400, 100, 20),
      item("11,94", 300, 300, 30),
    ];
    expect(extractAmountsFromLayout(items)).toMatchObject({ total_gross: 11.94, zero_total_stated: true });
  });

  it("a percentage beside \"Tasuda\" is no own value: a conflicting value below holds", () => {
    const items = [
      item("Näidis OÜ", 52, 40, 60),
      ...trio,
      item("Tasuda (24%)", 400, 148, 60),
      item("150,00", 400, 700, 30),
    ];
    // The layout still searches below the label and binds the conflicting value.
    expect(extractAmountsFromLayout(items)?.total_gross).toBe(150);
    expect(isHeld(extractLayout(items))).toBe(true);
  });

  it("an own value over the maximum stops the search and holds", () => {
    const items = [
      item("Näidis OÜ", 52, 40, 60),
      item("Kokku", 52, 132, 40), item("60 000,00", 300, 132, 50),
      item("124,00", 52, 700, 30),
    ];
    expect(extractAmountsFromLayout(items)).toMatchObject({ labelled_amount_over_max: true });
    expect(extractAmountsFromLayout(items)?.total_gross).toBeUndefined();
    expect(extractLayout(items).labelled_amount_over_max).toBe(true);
  });

  it("an own-row value over the maximum holds even when a nearer value binds", () => {
    const items = [
      item("Näidis OÜ", 52, 40, 60),
      item("Kokku", 52, 132, 40), item("124,00", 200, 132, 30), item("60 000,00", 300, 132, 50),
    ];
    expect(extractAmountsFromLayout(items)).toMatchObject({ total_gross: 124, labelled_amount_over_max: true });
  });
});

describe("supplier names and invoice numbers (WP5)", () => {
  const item = (text: string, x: number, y: number, width: number): LayoutTextItem => ({
    text, x, y, width, height: 12, pageNum: 1,
  });

  describe("A1 label-shaped supplier markers", () => {
    it("warranty prose \"Müüja vastutus 24 kuud\" is not the supplier name", () => {
      expect(extractSupplierName(["Arve nr 5", "Garantii", "Müüja vastutus 24 kuud", "Näidis Side AS      Reg. nr 10000001"].join("\n"), "doc.pdf"))
        .toBe("Näidis Side AS");
      const items = [
        item("Arve nr 5", 52, 40, 60),
        item("Müüja vastutus 24 kuud", 300, 200, 120), item("Kauba garantii kehtib", 300, 214, 100),
        item("Näidis Side AS", 52, 700, 80), item("Registrikood 10000001", 52, 714, 100),
      ];
      expect(extractSupplierName(items.map(entry => entry.text).join("\n"), "doc.pdf", items)).toBe("Näidis Side AS");
    });

    it("\"Müüja:\" and \"Müüja <legal entity>\" stay labels", () => {
      expect(extractSupplierName(["Müüja: Näidis Side AS", "Arve nr 5"].join("\n"), "doc.pdf")).toBe("Näidis Side AS");
      expect(extractSupplierName(["Arveldus: Näidispank AS", "Müüja Näidis Side AS"].join("\n"), "doc.pdf")).toBe("Näidis Side AS");
      const items = [
        item("Müüja:", 52, 100, 40), item("Näidis Side AS", 52, 114, 80),
        item("Arve saaja:", 300, 100, 60), item("Testfirma OÜ", 300, 114, 80),
      ];
      expect(extractSupplierName(items.map(entry => entry.text).join("\n"), "doc.pdf", items)).toBe("Näidis Side AS");
    });
  });

  describe("A2 column bleed", () => {
    it("a line spanning two columns is trimmed to the column holding the legal form", () => {
      expect(extractSupplierName(["Näidis    Näidis Pilv Limited", "Arve nr 5"].join("\n"), "doc.pdf")).toBe("Näidis Pilv Limited");
      expect(extractSupplierName(["Arve nr 5", "Näidis Meedia OÜ            Klienditeenindus           Arveldus"].join("\n"), "doc.pdf"))
        .toBe("Näidis Meedia OÜ");
    });

    it("a column holding only the legal form keeps the whole name", () => {
      const text = ["Arve", "Saatja:     Saaja:", "    Näidis Grupp     OÜ            Testfirma ou", "Arve nr 5"].join("\n");
      expect(extractSupplierNameWithNotes(text, "doc.pdf", undefined, "Testfirma OÜ").name).toBe("Näidis Grupp OÜ");
    });
  });

  describe("A3 left of a bare buyer label", () => {
    it("\"Näidis    Arve saaja\" names the supplier", () => {
      expect(extractSupplierName(["Arve", "Näidis                Arve saaja", "Tänav 1               Testfirma OÜ"].join("\n"), "doc.pdf"))
        .toBe("Näidis");
    });

    it("a supplier label left of the buyer label is not a name", () => {
      expect(extractSupplierName(["Arve", "Saatja:                Saaja:", "Näidis Grupp OÜ        Testfirma OÜ"].join("\n"), "doc.pdf"))
        .toBe("Näidis Grupp OÜ");
    });
  });

  it("A4 \"Teenuse pakkuja:\" is a supplier label", () => {
    expect(extractSupplierName(["Arve nr 5", "Teenuse pakkuja: Mari Maasikas", "Kokku 10,00"].join("\n"), "doc.pdf")).toBe("Mari Maasikas");
  });

  describe("A6 invoice numbers", () => {
    it("\"Company Number: 01234567\" is not an invoice number", () => {
      expect(extractInvoiceNumber(["Näidis Ltd", "Company Number: 01234567", "Total 10.00"].join("\n"), "x.pdf")).toMatch(/^AUTO-/);
    });

    it("\"Invoice: #…\" and \"Arve: …\" with at least five digits are invoice numbers", () => {
      expect(extractInvoiceNumber(["Näidis Ltd", "Company Number: 01234567", "Order Number / Invoice: #12345678-123456789"].join("\n"), "x.pdf"))
        .toBe("12345678-123456789");
      expect(extractInvoiceNumber(["Restoran", "Arve:    10000479"].join("\n"), "x.pdf")).toBe("10000479");
      expect(extractInvoiceNumber(["Restoran", "Arve:    1234"].join("\n"), "x.pdf")).toMatch(/^AUTO-/);
    });

    // Codex review: a label span citing another document is not chosen over
    // the current one, but two different numbers still hold (round 2).
    it.each([
      ["before", ["Näidis Ltd", "Previous invoice: #12345", "Invoice: #67890", "Total 10.00"]],
      ["after", ["Näidis Ltd", "Invoice: #67890", "Previous invoice: #12345", "Total 10.00"]],
      ["with a correction label", ["Näidis Ltd", "Corrected invoice: #67890", "Previous invoice no. 12345", "Total 10.00"]],
    ])("a cited invoice number %s the current one is not chosen, and the pair holds", (_name, lines) => {
      const result = extractReceiptFieldsFromText(lines.join("\n"), "x.pdf");
      expect(result.invoice_number).toBe("67890");
      expect(result.invoice_number_ambiguous).toBe(true);
    });

    it("a citation word in another span of the line does not touch the invoice label", () => {
      const result = extractReceiptFieldsFromText(["Näidis Ltd", "Invoice: #67890    Order reference: PO-555", "Total 10.00"].join("\n"), "x.pdf");
      expect(result.invoice_number).toBe("67890");
      expect(result.invoice_number_ambiguous).toBeUndefined();
      const withCitation = extractReceiptFieldsFromText(
        ["Näidis Ltd", "Previous invoice no. 12345", "Invoice: #67890    Order reference: PO-555", "Total 10.00"].join("\n"),
        "x.pdf",
      );
      expect(withCitation.invoice_number).toBe("67890");
      expect(withCitation.invoice_number_ambiguous).toBe(true);
      // Round 3: the original column gap, not a collapsed single space, ends
      // the citation's span.
      const citationFirst = extractReceiptFieldsFromText(
        ["Näidis Ltd", "Previous invoice no. 12345", "Order reference: PO-555    Invoice: #67890", "Total 10.00"].join("\n"),
        "x.pdf",
      );
      expect(citationFirst.invoice_number).toBe("67890");
      expect(citationFirst.invoice_number_ambiguous).toBe(true);
      expect(extractInvoiceNumber(["Näidis OÜ", "Arve nr      INV-77", "Kokku 10,00"].join("\n"), "x.pdf")).toBe("INV-77");
      const estonian = extractReceiptFieldsFromText(["Näidis OÜ", "Viide arvele: 12345", "Arve: 67890", "Kokku 10,00"].join("\n"), "x.pdf");
      expect(estonian.invoice_number).toBe("67890");
    });

    it("two different invoice numbers hold as ambiguous", () => {
      const result = extractReceiptFieldsFromText(["Näidis Ltd", "Invoice no. 11111", "Invoice no. 22222", "Total 10.00"].join("\n"), "x.pdf");
      expect(result.invoice_number_ambiguous).toBe(true);
      const sameLine = extractReceiptFieldsFromText(["Näidis Ltd", "Invoice no. 11111    Invoice no. 22222", "Total 10.00"].join("\n"), "x.pdf");
      expect(sameLine.invoice_number_ambiguous).toBe(true);
    });

    it("the same invoice number printed twice is not ambiguous", () => {
      const result = extractReceiptFieldsFromText(["Näidis OÜ", "Arve nr 2026-15", "Kokku 10,00", "Palume tasuda arve nr 2026-15"].join("\n"), "x.pdf");
      expect(result.invoice_number).toBe("2026-15");
      expect(result.invoice_number_ambiguous).toBeUndefined();
    });

    // F-NR-EQUALS-ID: a number equal to a labelled id, or to the company's own
    // id, is held; the captured number itself is never changed.
    it.each([
      ["a labelled registry code", ["Näidis OÜ", "Reg. nr 10234957", "Arve nr 10234957", "Kokku 10,00"], {}, "10234957"],
      ["a labelled VAT number", ["Näidis OÜ", "KMKR EE102809963", "Arve nr EE102809963", "Kokku 10,00"], {}, "EE102809963"],
      ["a labelled VAT's digits", ["Näidis OÜ", "KMKR EE102809963", "Arve nr 102809963", "Kokku 10,00"], {}, "102809963"],
      ["a labelled foreign VAT", ["Näidis GmbH", "VAT DE123456789", "Invoice no. DE123456789", "Total 10.00"], {}, "DE123456789"],
      ["the own registry code", ["Näidis OÜ", "Arve nr 12345678", "Kokku 10,00"], { ownCompanyRegistryCode: "12345678" }, "12345678"],
      ["the own VAT number", ["Näidis OÜ", "Arve nr EE100000007", "Kokku 10,00"], { ownCompanyVat: "EE100000007" }, "EE100000007"],
    ])("an invoice number equal to %s holds as ambiguous", (_name, lines, options, number) => {
      const result = extractReceiptFieldsFromText(lines.join("\n"), "x.pdf", options);
      expect(result.invoice_number).toBe(number);
      expect(result.invoice_number_ambiguous).toBe(true);
    });

    it("an invoice number different from every id is not held", () => {
      const result = extractReceiptFieldsFromText(
        ["Näidis OÜ", "Reg. nr 10234957", "KMKR EE102809963", "Arve nr 10234958", "Kokku 10,00"].join("\n"),
        "x.pdf",
        { ownCompanyRegistryCode: "12345678", ownCompanyVat: "EE100000007" },
      );
      expect(result.invoice_number).toBe("10234958");
      expect(result.invoice_number_ambiguous).toBeUndefined();
      // An unlabelled number elsewhere on the page is not an id.
      const unlabelled = extractReceiptFieldsFromText(["Näidis OÜ", "Tellimus 10234957", "Arve nr 10234957", "Kokku 10,00"].join("\n"), "x.pdf");
      expect(unlabelled.invoice_number_ambiguous).toBeUndefined();
    });
  });
});

describe("supplier identity from a page-column identity block (Telia footer live miss)", () => {
  // Synthetic mirror of a live invoice: logo text without a legal form, the
  // buyer under "Arve saaja" / "Klient" with its own VAT, no supplier label,
  // and the supplier's identity only in a multi-column page footer.
  const own = { ownCompanyName: "Testfirma OÜ", ownCompanyVat: "EE100000023", ownCompanyRegistryCode: "12000005" };
  const item = (text: string, x: number, y: number, width: number, height = 12): LayoutTextItem => ({
    text, x, y, width, height, pageNum: 1,
  });
  const footer = (lines: string[], y = 776): LayoutTextItem[] =>
    lines.map((line, index) => item(line, 28, y + index * 12, 90, 9));
  const page = (footerItems: LayoutTextItem[], letterhead = "Näidis"): LayoutTextItem[] => [
    item(letterhead, 65, 38, 48, 18),
    item("Tänav 1, Tallinn 10111", 28, 70, 95, 9),
    item("Arve saaja", 28, 104, 52, 13),
    item("Testfirma OÜ", 28, 118, 53),
    item("Pikk tn 1", 28, 129, 81),
    item("Klient", 28, 203, 29, 13),
    item("Arve", 316, 201, 23, 13),
    item("NS0001234", 499, 201, 63, 13),
    item("Testfirma OÜ", 28, 217, 53),
    item("Kuupäev", 316, 215, 36),
    item("16.09.2026", 517, 215, 45),
    item("Pikk tn 1", 28, 228, 81),
    item("KMKR number: EE100000023", 28, 255, 121),
    item("Maksumus käibemaksuta", 316, 524, 125, 13),
    item("100,00", 529, 524, 33, 13),
    item("24 % käibemaks", 316, 537, 66, 13),
    item("24,00", 529, 537, 33, 13),
    item("Arve summa", 316, 550, 61, 13),
    item("124,00", 529, 550, 33, 13),
    item("Pank", 206, 776, 40, 9),
    item("EE162200001234567890 SWIFT: TESTEE2X", 276, 776, 145, 9),
    ...footerItems,
  ];
  // Raw text as the parser lays it out: one line per row, columns spaced apart.
  const extract = (items: LayoutTextItem[], options: Parameters<typeof extractReceiptFieldsFromText>[2] = own) => {
    const rows = new Map<number, LayoutTextItem[]>();
    for (const entry of items) rows.set(entry.y, [...(rows.get(entry.y) ?? []), entry]);
    const text = [...rows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, row]) => row.sort((a, b) => a.x - b.x).map(entry => entry.text).join("    "))
      .join("\n");
    return extractReceiptFieldsFromText(text, "Arve_NS0001234.pdf", { ...options, textItems: items });
  };
  const supplierFooter = ["Näidis Side AS", "Tänav 1, 10111 Tallinn", "Registrikood 10000018", "KMKR number EE100000010"];

  it("takes the footer legal entity with its registry code and VAT", () => {
    const result = extract(page(footer(supplierFooter)));
    expect(result.supplier_name).toBe("Näidis Side AS");
    expect(result.supplier_reg_code).toBe("10000018");
    expect(result.supplier_vat_no).toBe("EE100000010");
    expect(result.reg_code_rationale).toBe("identity_block");
    expect(result.vat_no_rationale).toBe("identity_block");
    expect(result.supplier_from_footer_block).toBe(true);
    expect(result.field_provenance?.find(entry => entry.field === "supplier_name")).toMatchObject({
      source: "coordinate", rationale: "identity_block", bbox: { x: 28, y: 776 },
    });
  });

  it("without the footer block the supplier stays unresolved (the live miss)", () => {
    const result = extract(page([]));
    expect(result.supplier_name).toBe("ARVE NS0001234");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("the active company's own block is not taken", () => {
    const ownBlock = extract(page(footer(["Testfirma OÜ", "Pikk tn 1", "Registrikood 12000005", "KMKR number EE100000023"])));
    expect(ownBlock.supplier_name).toBe("ARVE NS0001234");
    expect(ownBlock.supplier_reg_code).toBeUndefined();
    // Each own identifier alone disqualifies the block, the name even when the
    // buyer block does not print it and the letterhead names it.
    const ownName = extract(page(footer(["Testfirma OÜ", "Registrikood 10000018"]), "Testfirma").filter(entry => entry.y > 300 || entry.text !== "Testfirma OÜ"));
    expect(ownName.supplier_reg_code).toBeUndefined();
    const ownRegistryCode = extract(page(footer(["Näidis Side AS", "Registrikood 12000005"])));
    expect(ownRegistryCode.supplier_reg_code).toBeUndefined();
    const ownVat = extract(page(footer(["Näidis Side AS", "KMKR number EE100000023"])).filter(entry => entry.y !== 255));
    expect(ownVat.supplier_vat_no).toBeUndefined();
    expect(ownVat.supplier_name).toBe("ARVE NS0001234");
  });

  it("a block inside the buyer block is not taken", () => {
    // The name sits a line below the label and the letterhead names it, so only
    // the buyer-block check stops it.
    // The label is "Klient", which is no role word, so the role-word band does not stop it either.
    const items = page([], "Testfirma").filter(entry => entry.y !== 104 && entry.y !== 118 && entry.y !== 129);
    items.push(item("Klient", 28, 104, 52, 13), item("Testfirma OÜ", 28, 128, 53), item("Registrikood 10000024", 28, 140, 81));
    const result = extract(items, { ownCompanyVat: own.ownCompanyVat });
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.reg_code_rationale).not.toBe("identity_block");
  });

  it("two different qualifying blocks are not taken", () => {
    const result = extract(page([
      ...footer(supplierFooter),
      ...footer(["Teine Firma OÜ", "Registrikood 10000024"], 650),
      item("EE162200001234567890 SWIFT: TESTEE2X", 276, 650, 145, 9),
    ]));
    expect(result.supplier_name).toBe("ARVE NS0001234");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("the same block repeated on another page is one block", () => {
    const secondPage = footer(supplierFooter).map(entry => ({ ...entry, pageNum: 2 }));
    const result = extract([...page(footer(supplierFooter)), ...secondPage]);
    expect(result.supplier_reg_code).toBe("10000018");
  });

  it("a registry code failing its checksum disqualifies the block", () => {
    const result = extract(page(footer(["Näidis Side AS", "Tänav 1, 10111 Tallinn", "Registrikood 10000019", "KMKR number EE100000010"])));
    expect(result.supplier_name).toBe("ARVE NS0001234");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("a name line without a legal form is not taken", () => {
    const result = extract(page(footer(["Näidis Side", "Registrikood 10000018"])));
    expect(result.supplier_name).toBe("ARVE NS0001234");
    expect(result.supplier_reg_code).toBeUndefined();
  });

  it("identifiers in another column than the name are not taken", () => {
    const result = extract(page([
      item("Näidis Side AS", 500, 776, 60, 9),
      ...footer(["Registrikood 10000018", "KMKR number EE100000010"], 788),
    ]));
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("a supplier identifier the extractor already found is kept", () => {
    const items = page(footer(supplierFooter));
    items.push(item("Registrikood 10000024", 446, 650, 90, 9));
    const result = extract(items);
    expect(result.supplier_reg_code).toBe("10000024");
    expect(result.reg_code_rationale).not.toBe("identity_block");
  });

  it("identifiers more than four lines below the name are not taken", () => {
    const result = extract(page(footer(["Näidis Side AS", "Tänav 1", "10111 Tallinn", "Eesti", "info@example.com", "Registrikood 10000018"])));
    expect(result.supplier_reg_code).toBeUndefined();
  });

  it("an unlabelled code under the name is not taken", () => {
    const result = extract(page(footer(["Näidis Side AS", "Tänav 1, 10111 Tallinn", "10000018"])));
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_name).toBe("ARVE NS0001234");
  });

  it("a payment agent's block with a role label above its name is not taken (Codex scenario 1)", () => {
    const result = extract(page(footer(["Maksete vahendaja", "Maksekeskus AS", "Tänav 1", "Registrikood 10000018", "KMKR number EE100000010"])));
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
    expect(result.reg_code_rationale).not.toBe("identity_block");
  });

  it("another entity's codes inside the supplier's block are not attached to it (Codex scenario 2)", () => {
    const items = page(footer(["Näidis Side AS", "Tänav 1", "Arve väljastaja: Teine Firma OÜ", "Registrikood 10000024", "KMKR number EE100000036"]));
    items.push(item("Makse saaja:", 316, 104, 50), item("Näidis Side AS", 316, 118, 60));
    const result = extract(items);
    expect(result.supplier_name).toBe("Näidis Side AS");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
    // Without the other entity's line the same block fills the agreed supplier's codes.
    const clean = page(footer(supplierFooter));
    clean.push(item("Makse saaja:", 316, 104, 50), item("Näidis Side AS", 316, 118, 60));
    expect(extract(clean).supplier_reg_code).toBe("10000018");
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("a label line directly above the name disqualifies the block", () => {
    // "Kontakt" is no role word, so only the label-above check stops it.
    const result = extract(page(footer(["Kontakt", "Näidis Side AS", "Registrikood 10000018"])));
    expect(result.supplier_reg_code).toBeUndefined();
  });

  it("a label left of the name on its row disqualifies the block", () => {
    const block = [
      item("Näidis Side AS", 75, 776, 60, 9),
      item("Registrikood 10000018", 75, 788, 72, 9),
      item("KMKR number EE100000010", 75, 800, 92, 9),
    ];
    expect(extract(page(block)).supplier_reg_code).toBe("10000018");
    expect(extract(page([item("Partner", 28, 776, 40, 9), ...block])).supplier_reg_code).toBeUndefined();
  });

  it("a role word glued into the name line disqualifies the block", () => {
    // The letterhead corroborates the name, so only the role-word check stops it.
    const result = extract(page(footer(["Maksete vahendaja Maksekeskus AS", "Registrikood 10000018"]), "Maksete"));
    expect(result.supplier_reg_code).toBeUndefined();
  });

  it("a second legal-entity name inside the block disqualifies it", () => {
    const result = extract(page(footer(["Näidis Side AS", "Teine Firma OÜ", "Registrikood 10000018"])));
    expect(result.supplier_reg_code).toBeUndefined();
    // Also when it is printed with an address.
    const withAddress = extract(page([
      ...footer(["Näidis Side AS", "Teine Firma OÜ, Tänav 2", "Registrikood 10000018"]),
      item("EE162200001234567890 SWIFT: TESTEE2X", 276, 788, 145, 9),
    ]));
    expect(withAddress.supplier_reg_code).toBeUndefined();
  });

  it("a bank line inside the block disqualifies it", () => {
    const result = extract(page(footer(["Näidis Side AS", "Swedbank EE162200001234567890", "Registrikood 10000018"])));
    expect(result.supplier_reg_code).toBeUndefined();
  });

  it("an unknown labelled line inside the block disqualifies it", () => {
    const result = extract(page(footer(["Näidis Side AS", "Tänav 1", "Kontaktisik: Mari Maasikas", "Registrikood 10000018"])));
    expect(result.supplier_reg_code).toBeUndefined();
  });

  it("address, contact and country lines keep the block", () => {
    const result = extract(page(footer([
      "Näidis Side AS", "Aadress: Tänav 1-2", "Registrikood 10000018", "KMKR nr: EE100000010", "10111 Tallinn", "Eesti Vabariik",
      "Tel: +372 5555 5555", "info@example.com", "www.example.com",
    ])));
    expect(result.supplier_reg_code).toBe("10000018");
    expect(result.supplier_vat_no).toBe("EE100000010");
  });

  it("a disqualified block with codes still competes with a qualifying one", () => {
    const result = extract(page([
      ...footer(supplierFooter),
      ...footer(["Maksete vahendaja", "Maksekeskus AS", "Registrikood 10000024"], 640),
      item("EE162200001234567890 SWIFT: TESTEE2X", 276, 652, 145, 9),
    ]));
    expect(result.supplier_reg_code).toBeUndefined();
  });

  // Codex round 2: role-label placements the block geometry does not see. The
  // agent's name is not corroborated by the letterhead, so nothing is taken.
  const agentBlock = footer(["Maksekeskus AS", "Tänav 1", "Registrikood 10000018", "KMKR number EE100000010"], 788);
  const agentPlacements = [
    { placement: "right of the name on its row, larger font", label: item("Maksete vahendaja", 125, 787, 80, 12) },
    { placement: "same column 24 pt above", label: item("Maksete vahendaja", 28, 764, 80, 9) },
    { placement: "previous row, offset column", label: item("Maksete vahendaja", 145, 776, 80, 9) },
  ];

  it.each(agentPlacements)("a payment agent's block with its label $placement is not taken", ({ label }) => {
    const result = extract(page([...agentBlock, label]));
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
    expect(result.reg_code_rationale).not.toBe("identity_block");
  });

  it.each(agentPlacements)("a marker-named supplier never gets the agent's codes (label $placement)", ({ label }) => {
    const items = page([...agentBlock, label]);
    items.push(item("Müüja: Näidis Side AS", 316, 104, 120));
    const result = extract(items);
    expect(result.supplier_name).toBe("Näidis Side AS");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("a marker-named supplier gets the codes of its own block, not flagged as footer-derived", () => {
    const items = page(footer(["Näidis Side AS", "Registrikood 10000018", "KMKR number EE100000010"]), "Muu Logo");
    items.push(item("Müüja: Näidis Side AS", 316, 104, 120));
    const result = extract(items);
    expect(result.supplier_name).toBe("Näidis Side AS");
    expect(result.supplier_reg_code).toBe("10000018");
    expect(result.supplier_from_footer_block).toBeUndefined();
  });

  it("a letterhead-named supplier (Tech Tatami shape: \"Makse saaja:\" + own footer block) is not flagged", () => {
    const items = page(footer(["Näidis Side AS", "Reg nr: 10000018", "KMKR nr: EE100000010", "Aadress: Tänav 1-2", "Eesti Vabariik"]), "Näidis Side AS");
    items.push(item("Makse saaja:", 316, 104, 50), item("Näidis Side AS", 316, 118, 60));
    const result = extract(items);
    expect(result.supplier_name).toBe("Näidis Side AS");
    expect(result.supplier_reg_code).toBe("10000018");
    expect(result.supplier_vat_no).toBe("EE100000010");
    expect(result.supplier_from_footer_block).toBeUndefined();
  });

  it("a name found only by the legal-form line scan does not corroborate its block", () => {
    const result = extract(page(footer(supplierFooter, 640), "Muu Logo"));
    expect(result.supplier_name).toBe("Näidis Side AS");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("a document issued by the agent itself (letterhead names it, no role label) takes its block", () => {
    const result = extract(page(agentBlock, "Maksekeskus"));
    expect(result.supplier_name).toBe("Maksekeskus AS");
    expect(result.supplier_reg_code).toBe("10000018");
    // The name line stands on its own row here, so the name was found before the
    // block and the letterhead corroborates it: not footer-derived.
    expect(result.supplier_from_footer_block).toBeUndefined();
  });

  // Codex round 3: a role label attached to the block excludes it even when the
  // letterhead or a supplier marker names the same entity.
  it.each(agentPlacements)("a role label $placement excludes the block even when the letterhead names it", ({ label }) => {
    const result = extract(page([...agentBlock, label], "Maksekeskus"));
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
    expect(result.supplier_from_footer_block).toBeUndefined();
  });

  it.each(agentPlacements)("a role label $placement excludes the block even when a supplier marker names it", ({ label }) => {
    const items = page([...agentBlock, label], "Muu Logo");
    items.push(item("Müüja: Maksekeskus AS", 316, 104, 120));
    const result = extract(items);
    expect(result.supplier_name).toBe("Maksekeskus AS");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_from_footer_block).toBeUndefined();
  });

  it.each(["Eesti", "Group", "Baltic Holding", "Näi"])("a generic or short letterhead %s corroborates nothing", letterhead => {
    const block = footer([`${letterhead} Side AS`, "Registrikood 10000018", "KMKR number EE100000010"]);
    expect(extract(page(block, letterhead)).supplier_reg_code).toBeUndefined();
  });

  it("a letterhead word that is not the name's leading word corroborates nothing", () => {
    const block = footer(["Teine Näidis AS", "Registrikood 10000018", "KMKR number EE100000010"]);
    expect(extract(page(block, "Näidis")).supplier_reg_code).toBeUndefined();
  });

  it("a distinctive letterhead word still corroborates", () => {
    const block = footer(["Näidis Side AS", "Registrikood 10000018", "KMKR number EE100000010"]);
    expect(extract(page(block, "Näidis Side")).supplier_reg_code).toBe("10000018");
  });

  it("a footer block the letterhead does not name is not taken", () => {
    const result = extract(page(footer(supplierFooter), "Muu Logo"));
    expect(result.supplier_name).toBe("ARVE NS0001234");
    expect(result.supplier_reg_code).toBeUndefined();
    expect(result.supplier_vat_no).toBeUndefined();
  });

  it("a supplier already named as a different company keeps the current result", () => {
    const items = page(footer(supplierFooter));
    items.push(item("Müüja: Kolmas Firma OÜ", 316, 104, 120));
    const result = extract(items);
    expect(result.supplier_name).toBe("Kolmas Firma OÜ");
    expect(result.reg_code_rationale).not.toBe("identity_block");
    expect(result.vat_no_rationale).not.toBe("identity_block");
  });
});

describe("extractPaymentReferences (F-PREPAY-REF)", () => {
  it.each([
    ["Ettemaksuarve nr EMSS70002960", ["EMSS70002960"]],
    ["Ettemaks: EMSS70002960    Summa 155,00", ["EMSS70002960"]],
    ["Prepayment invoice no. PP-2026-0042", ["PP-2026-0042"]],
    ["Makse viide: 70002960", ["70002960"]],
    ["Payment reference PR-778899", ["PR-778899"]],
    ["Viitenumber 1234567890", ["1234567890"]],
  ])("reads the label-anchored reference in %s", (line, expected) => {
    expect(extractPaymentReferences(["Näidis OÜ", line, "Kokku 155,00"].join("\n"))).toEqual(expected);
  });

  it.each([
    ["an amount after a prepayment label", "Ettemaks 150.00"],
    ["an amount with a comma decimal", "Ettemaks 123456,00"],
    ["an unlabelled identifier", "EMSS70002960"],
    ["a label on another line", "Ettemaksuarve\nEMSS70002960"],
    ["a date", "Viide 2026-09-23"],
    ["an IBAN", "Reference EE382200221020145685"],
    ["a digit-less word", "Reference ABCDEF"],
    ["a cited invoice behind a word", "Viide arvele: 4411"],
  ])("never reads %s", (_name, line) => {
    expect(extractPaymentReferences(["Näidis OÜ", line, "Kokku 155,00"].join("\n"))).toEqual([]);
  });
});
