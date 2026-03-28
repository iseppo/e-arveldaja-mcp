import { describe, it, expect } from "vitest";
import {
  normalizeDate,
  extractAmounts,
  computeTermDays,
  hasRecurringSimilarAmounts,
  normalizeCounterpartyName,
  looksLikePersonCounterparty,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
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
