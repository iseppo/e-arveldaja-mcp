import { describe, it, expect } from "vitest";
import {
  extractRegistryCode,
  extractVatNumber,
  extractIban,
  extractReferenceNumber,
} from "./document-identifiers.js";

describe("extractRegistryCode", () => {
  it("extracts a valid 8-digit Estonian registry code with 'Reg. nr' prefix", () => {
    expect(extractRegistryCode("Reg. nr: 12345678")).toBe("12345678");
  });

  it("extracts with 'Registrikood' prefix", () => {
    expect(extractRegistryCode("Registrikood: 10000000")).toBe("10000000");
  });

  it("extracts with 'Registry code' prefix", () => {
    expect(extractRegistryCode("Registry code 87654321")).toBe("87654321");
  });

  it("extracts with 'Reg kood' prefix (no dot)", () => {
    expect(extractRegistryCode("Reg kood: 11223344")).toBe("11223344");
  });

  it("extracts a code embedded in surrounding text", () => {
    expect(
      extractRegistryCode("Müüja: Acme OÜ, Registrikood: 12345678, aadress: Tallinn")
    ).toBe("12345678");
  });

  it("returns undefined when no registry code is present", () => {
    expect(extractRegistryCode("No code here")).toBeUndefined();
  });

  it("returns undefined for empty text", () => {
    expect(extractRegistryCode("")).toBeUndefined();
  });

  it("does not match fewer than 8 digits", () => {
    expect(extractRegistryCode("Reg. nr: 1234567")).toBeUndefined();
  });
});

describe("extractVatNumber", () => {
  it("extracts an Estonian VAT number (EE prefix)", () => {
    expect(extractVatNumber("KMKR: EE123456789")).toBe("EE123456789");
  });

  it("extracts with 'VAT nr' prefix", () => {
    expect(extractVatNumber("VAT nr: DE123456789")).toBe("DE123456789");
  });

  it("extracts with 'VAT number' prefix", () => {
    expect(extractVatNumber("VAT number: FR12345678901")).toBe("FR12345678901");
  });

  it("extracts with 'KM nr' prefix", () => {
    expect(extractVatNumber("KM nr: EE987654321")).toBe("EE987654321");
  });

  it("returns the supplier-side VAT number when a buyer section marker is present", () => {
    const text =
      "Müüja KMKR: EE111111111\nArve saaja\nKMKR: EE222222222";
    expect(extractVatNumber(text)).toBe("EE111111111");
  });

  it("returns undefined when no VAT number is present", () => {
    expect(extractVatNumber("No VAT here")).toBeUndefined();
  });

  it("returns undefined for empty text", () => {
    expect(extractVatNumber("")).toBeUndefined();
  });

  it("excludes a VAT number listed in options.exclude (own-company VAT guard)", () => {
    expect(extractVatNumber("VAT: EE102809963", { exclude: "EE102809963" })).toBeUndefined();
  });

  it("normalizes exclude entries (whitespace and case) when filtering", () => {
    expect(extractVatNumber("VAT: ee 102 809 963", { exclude: " EE102809963 " })).toBeUndefined();
  });

  it("returns the next non-excluded match when one matches the exclude list", () => {
    const text = "VAT: EU372041333\nKMKR: EE102809963";
    expect(extractVatNumber(text, { exclude: "EE102809963" })).toBe("EU372041333");
  });

  it("falls back to undefined when only the buyer's own VAT is on the page", () => {
    // Mirrors the Anthropic case from issue #14: supplier prints no VAT,
    // only the buyer's EE-VAT next to "Bill to". Without an exclude list,
    // the extractor would happily return the buyer VAT as supplier.
    const text = [
      "Anthropic, PBC                      Bill to",
      "548 Market Street                   Indrek Seppo",
      "United States                       Estonia",
      "                                    EE VAT EE102809963",
    ].join("\n");
    expect(extractVatNumber(text)).toBe("EE102809963");
    expect(extractVatNumber(text, { exclude: "EE102809963" })).toBeUndefined();
  });

  it("accepts an array of VATs to exclude", () => {
    const text = "VAT: EE111111111";
    expect(extractVatNumber(text, { exclude: ["EE111111111", "EE222222222"] })).toBeUndefined();
  });

  it("still applies the buyer-section heuristic to the remaining matches after excluding own VAT", () => {
    // OCR collapse case: our own VAT lands above 'Bill to' (would normally
    // win the buyer-section heuristic) and the supplier's VAT lands below.
    // Excluding own VAT removes the structurally-preferred candidate; the
    // remaining match must still come back rather than the function
    // bailing out, even though the surviving VAT is on the buyer side of
    // the anchor.
    const text = [
      "VAT: EE102809963",                  // own VAT (excluded)
      "Some prose mentioning bill to here",
      "Supplier VAT: EU372041333",         // remaining match
    ].join("\n");
    expect(
      extractVatNumber(text, { exclude: "EE102809963" }),
    ).toBe("EU372041333");
  });
});

describe("extractIban", () => {
  it("extracts a valid Estonian IBAN", () => {
    // EE382200221020145685 is a well-known test IBAN with correct checksum
    expect(extractIban("IBAN: EE382200221020145685")).toBe("EE382200221020145685");
  });

  it("extracts an IBAN with spaces and normalises it", () => {
    expect(extractIban("EE38 2200 2210 2014 5685")).toBe("EE382200221020145685");
  });

  it("rejects an IBAN with an invalid checksum", () => {
    // Flip the check digits to make checksum wrong
    expect(extractIban("EE992200221020145685")).toBeUndefined();
  });

  it("returns undefined when no IBAN-like string is present", () => {
    expect(extractIban("No bank account here")).toBeUndefined();
  });

  it("returns undefined for empty text", () => {
    expect(extractIban("")).toBeUndefined();
  });
});

describe("extractReferenceNumber", () => {
  it("extracts with 'Viitenumber' prefix", () => {
    expect(extractReferenceNumber("Viitenumber: 1234567890")).toBe("1234567890");
  });

  it("extracts with 'Ref. nr' prefix", () => {
    expect(extractReferenceNumber("Ref. nr: 98765")).toBe("98765");
  });

  it("extracts with 'Reference' prefix", () => {
    expect(extractReferenceNumber("Reference: 111213")).toBe("111213");
  });

  it("extracts a reference number embedded in surrounding text", () => {
    expect(
      extractReferenceNumber("Palun tasuda. Viitenumber: 55555 tähtajaks 31.12.2025.")
    ).toBe("55555");
  });

  it("returns undefined when no reference number is present", () => {
    expect(extractReferenceNumber("No reference here")).toBeUndefined();
  });

  it("returns undefined for empty text", () => {
    expect(extractReferenceNumber("")).toBeUndefined();
  });
});
