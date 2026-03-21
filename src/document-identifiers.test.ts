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
