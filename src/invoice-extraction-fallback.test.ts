import { describe, it, expect } from "vitest";
import { hasConfidentInvoiceNumber, summarizeInvoiceExtraction } from "./invoice-extraction-fallback.js";

describe("hasConfidentInvoiceNumber", () => {
  it("returns false for undefined", () => {
    expect(hasConfidentInvoiceNumber(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasConfidentInvoiceNumber("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(hasConfidentInvoiceNumber("   ")).toBe(false);
  });

  it("returns false for AUTO- prefix", () => {
    expect(hasConfidentInvoiceNumber("AUTO-12345")).toBe(false);
  });

  it("returns false for AUTO- prefix with surrounding whitespace", () => {
    expect(hasConfidentInvoiceNumber("  AUTO-12345  ")).toBe(false);
  });

  it("returns true for a plain invoice number", () => {
    expect(hasConfidentInvoiceNumber("INV-2024-001")).toBe(true);
  });

  it("returns true for a numeric invoice number", () => {
    expect(hasConfidentInvoiceNumber("12345")).toBe(true);
  });

  it("returns true for invoice number with leading/trailing whitespace (non-AUTO)", () => {
    expect(hasConfidentInvoiceNumber("  INV-001  ")).toBe(true);
  });
});

describe("summarizeInvoiceExtraction", () => {
  const fullSnapshot = {
    supplier_name: "Acme OÜ",
    invoice_number: "INV-2024-001",
    invoice_date: "2024-01-15",
    total_gross: 121.0,
    currency: "EUR",
    due_date: "2024-02-15",
    total_net: 100.0,
    total_vat: 21.0,
    supplier_reg_code: "12345678",
    supplier_vat_no: "EE123456789",
    supplier_iban: "EE123456789012345678",
    ref_number: "12345",
    raw_text: "Invoice content here",
  };

  describe("recommended flag", () => {
    it("is false when raw_text is present and all required fields are present", () => {
      const result = summarizeInvoiceExtraction(fullSnapshot);
      expect(result.recommended).toBe(false);
    });

    it("is true when raw_text is absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, raw_text: undefined });
      expect(result.recommended).toBe(true);
    });

    it("is true when raw_text is empty string", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, raw_text: "" });
      expect(result.recommended).toBe(true);
    });

    it("is true when raw_text is whitespace only", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, raw_text: "   " });
      expect(result.recommended).toBe(true);
    });

    it("is true when a required field is missing even with raw_text present", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, supplier_name: undefined });
      expect(result.recommended).toBe(true);
    });

    it("is true when invoice_number is AUTO-prefixed", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, invoice_number: "AUTO-9999" });
      expect(result.recommended).toBe(true);
    });

    it("is true when invoice_date is missing", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, invoice_date: undefined });
      expect(result.recommended).toBe(true);
    });

    it("is true when total_gross is missing", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, total_gross: undefined });
      expect(result.recommended).toBe(true);
    });
  });

  describe("missing_required_fields", () => {
    it("is empty when all required fields are present and confident", () => {
      const result = summarizeInvoiceExtraction(fullSnapshot);
      expect(result.missing_required_fields).toEqual([]);
    });

    it("includes supplier_name when absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, supplier_name: undefined });
      expect(result.missing_required_fields).toContain("supplier_name");
    });

    it("includes invoice_number when absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, invoice_number: undefined });
      expect(result.missing_required_fields).toContain("invoice_number");
    });

    it("includes invoice_number when AUTO-prefixed", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, invoice_number: "AUTO-0001" });
      expect(result.missing_required_fields).toContain("invoice_number");
    });

    it("includes invoice_date when absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, invoice_date: undefined });
      expect(result.missing_required_fields).toContain("invoice_date");
    });

    it("includes total_gross when absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, total_gross: undefined });
      expect(result.missing_required_fields).toContain("total_gross");
    });

    it("does not include total_gross when value is 0", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, total_gross: 0 });
      expect(result.missing_required_fields).not.toContain("total_gross");
    });

    it("lists all four required fields when snapshot is empty", () => {
      const result = summarizeInvoiceExtraction({});
      expect(result.missing_required_fields).toEqual([
        "supplier_name",
        "invoice_number",
        "invoice_date",
        "total_gross",
      ]);
    });
  });

  describe("raw_text_available", () => {
    it("is true when raw_text has content", () => {
      const result = summarizeInvoiceExtraction(fullSnapshot);
      expect(result.raw_text_available).toBe(true);
    });

    it("is false when raw_text is absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, raw_text: undefined });
      expect(result.raw_text_available).toBe(false);
    });

    it("is false when raw_text is blank", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, raw_text: "  " });
      expect(result.raw_text_available).toBe(false);
    });
  });

  describe("reason", () => {
    it("reports no raw text available when raw_text is absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, raw_text: undefined });
      expect(result.reason).toBe("No OCR/raw text is available for semantic fallback.");
    });

    it("reports unresolved required fields when raw_text present but fields missing", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, supplier_name: undefined });
      expect(result.reason).toBe("Deterministic extraction left required invoice fields unresolved.");
    });

    it("reports minimum fields found when everything is present", () => {
      const result = summarizeInvoiceExtraction(fullSnapshot);
      expect(result.reason).toBe(
        "Deterministic extraction found the minimum fields needed for invoice review."
      );
    });
  });

  describe("missing_optional_fields", () => {
    it("is empty when all optional fields are present", () => {
      const result = summarizeInvoiceExtraction(fullSnapshot);
      expect(result.missing_optional_fields).toEqual([]);
    });

    it("includes due_date when absent", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, due_date: undefined });
      expect(result.missing_optional_fields).toContain("due_date");
    });

    it("includes total_net and total_vat when absent", () => {
      const result = summarizeInvoiceExtraction({
        ...fullSnapshot,
        total_net: undefined,
        total_vat: undefined,
      });
      expect(result.missing_optional_fields).toContain("total_net");
      expect(result.missing_optional_fields).toContain("total_vat");
    });

    it("does not include total_net when value is 0", () => {
      const result = summarizeInvoiceExtraction({ ...fullSnapshot, total_net: 0 });
      expect(result.missing_optional_fields).not.toContain("total_net");
    });

    it("lists all optional fields when snapshot is empty", () => {
      const result = summarizeInvoiceExtraction({});
      expect(result.missing_optional_fields).toEqual([
        "due_date",
        "total_net",
        "total_vat",
        "supplier_reg_code",
        "supplier_vat_no",
        "supplier_iban",
        "ref_number",
        "currency",
      ]);
    });
  });

  describe("currency requirement (#16)", () => {
    const baseWithGross = {
      supplier_name: "Acme OÜ",
      invoice_number: "INV-2024-001",
      invoice_date: "2024-01-15",
      total_gross: 100.0,
      raw_text: "Invoice content",
    };

    it("treats currency as required when total_gross is present but currency is missing", () => {
      const result = summarizeInvoiceExtraction(baseWithGross);
      expect(result.missing_required_fields).toContain("currency");
      expect(result.recommended).toBe(true);
    });

    it("treats currency as optional when total_gross is also missing", () => {
      const result = summarizeInvoiceExtraction({
        ...baseWithGross,
        total_gross: undefined,
      });
      expect(result.missing_required_fields).not.toContain("currency");
      expect(result.missing_optional_fields).toContain("currency");
    });

    it("does not flag currency when both total_gross and currency are present", () => {
      const result = summarizeInvoiceExtraction({
        ...baseWithGross,
        currency: "USD",
      });
      expect(result.missing_required_fields).not.toContain("currency");
      expect(result.missing_optional_fields).not.toContain("currency");
    });
  });
});
