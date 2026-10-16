import { describe, it, expect } from "vitest";
import {
  extractRegistryCode,
  extractVatNumber,
  extractIban,
  extractReferenceNumber,
  isValidEeRegistryCode,
  isValidEeVatNumber,
  extractIdentifiers,
  buildIdentifierMarkers,
  type LayoutTextItem,
} from "./document-identifiers.js";

describe("extractRegistryCode", () => {
  it("extracts a valid 8-digit Estonian registry code with 'Reg. nr' prefix", () => {
    expect(extractRegistryCode("Reg. nr: 12345678")).toBe("12345678");
  });

  it("extracts with 'Registrikood' prefix", () => {
    expect(extractRegistryCode("Registrikood: 17133416")).toBe("17133416");
  });

  it("extracts with 'Registry code' prefix", () => {
    expect(extractRegistryCode("Registry code 12345678")).toBe("12345678");
  });

  it("extracts with 'Reg kood' prefix (no dot)", () => {
    expect(extractRegistryCode("Reg kood: 10170660")).toBe("10170660");
  });

  it("extracts with 'Rg-kood' prefix (abbreviated, real invoice variant)", () => {
    expect(extractRegistryCode("Rg-kood 17487472")).toBe("17487472");
  });

  it("extracts with 'Rg-kood:' prefix (with colon)", () => {
    expect(extractRegistryCode("Rg-kood: 17487472")).toBe("17487472");
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

  it("does not resolve a 9-digit labeled number to its 8-digit prefix", () => {
    // "171334169" is 9 digits; the 8-digit prefix "17133416" is checksum-valid,
    // so without a trailing digit boundary the labeled regex used to wrongly
    // resolve it. A longer digit run must not match.
    expect(extractRegistryCode("Registrikood: 171334169")).toBeUndefined();
  });
});

describe("extractVatNumber", () => {
  it("does not take a letters-only word as a foreign VAT (live: Anthropic invoice)", () => {
    expect(extractVatNumber("VAT Registration EU VAT: IE4276970QH")).toBe("IE4276970QH");
    expect(extractVatNumber("VAT Registration pending")).toBeUndefined();
  });

  it("extracts an Estonian VAT number (EE prefix)", () => {
    expect(extractVatNumber("KMKR: EE100594102")).toBe("EE100594102");
  });

  it("extracts with 'VAT nr' prefix", () => {
    expect(extractVatNumber("VAT nr: DE123456789")).toBe("DE123456789");
  });

  it("extracts with 'VAT number' prefix", () => {
    expect(extractVatNumber("VAT number: FR12345678901")).toBe("FR12345678901");
  });

  it("extracts with 'KM nr' prefix", () => {
    expect(extractVatNumber("KM nr: EE102809963")).toBe("EE102809963");
  });

  it("extracts with 'KMKR nr' prefix (real invoice variant, with space)", () => {
    expect(extractVatNumber("KMKR nr EE102977811")).toBe("EE102977811");
  });

  it("extracts with 'KMKR nr.' prefix (with trailing dot)", () => {
    expect(extractVatNumber("KMKR nr. EE102977811")).toBe("EE102977811");
  });

  it("extracts with 'KM Reg. Nr.' prefix (Jysk variant)", () => {
    expect(extractVatNumber("KM Reg. Nr. EE100731910")).toBe("EE100731910");
  });

  it("extracts and normalizes a whitespace-grouped labeled EE VAT", () => {
    expect(extractVatNumber("KMKR: EE 102 809 963")).toBe("EE102809963");
  });

  it("returns the supplier-side VAT number when a buyer section marker is present", () => {
    const text =
      "Müüja KMKR: EE100594102\nArve saaja\nKMKR: EE102809963";
    expect(extractVatNumber(text)).toBe("EE100594102");
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
  it("skips the buyer's own account on a debit-mandate or buyer line and returns the supplier IBAN", () => {
    expect(extractIban("The amount will be debited from your account EE38 2200 2210 2014 5685 BIC HABAEE2X\nIBAN DE89 3704 0044 0532 0130 00"))
      .toBe("DE89370400440532013000");
    expect(extractIban("Summa debiteeritakse kontolt EE382200221020145685\nIBAN DE89370400440532013000")).toBe("DE89370400440532013000");
    expect(extractIban("Maksja: Minu OÜ, EE382200221020145685\nIBAN DE89370400440532013000")).toBe("DE89370400440532013000");
    expect(extractIban("The amount will be debited from your account EE382200221020145685")).toBeUndefined();
  });

  it("skips only the IBAN a debit phrase grammatically governs", () => {
    const own = "EE382200221020145685";
    const sup = "DE89370400440532013000";
    expect(extractIban(`Makseviis: otsekorraldus   IBAN: ${sup}`)).toBe(sup);
    expect(extractIban(`Direct debit available. Our bank account: ${sup}`)).toBe(sup);
    expect(extractIban(`Summa debiteeritakse teie kontolt ${own} ja kantakse saaja kontole ${sup}`)).toBe(sup);
    expect(extractIban(`Amount will be debited from ${own}; payee account ${sup}`)).toBe(sup);
    // Hetzner-style own-account debit line stays excluded.
    expect(extractIban(`The amount will be debited from your account ${own} BIC HABAEE2X`)).toBeUndefined();
  });

  it("does not treat payee words as a buyer label before an IBAN", () => {
    const sup = "DE89370400440532013000";
    const other = "EE382200221020145685";
    expect(extractIban(`Payment recipient: Supplier Ltd IBAN ${sup}\nYour account ${other}`)).toBe(sup);
    expect(extractIban(`Saaja: Supplier OÜ, konto ${sup}\nKonto ${other}`)).toBe(sup);
    expect(extractIban(`Beneficiary: Supplier Ltd ${sup}\n${other}`)).toBe(sup);
    // A real buyer label still demotes its IBAN to the fallback.
    expect(extractIban(`Buyer account ${other}\nIBAN ${sup}`)).toBe(sup);
  });

  it("excludes the company's own IBANs", () => {
    expect(extractIban("IBAN EE38 2200 2210 2014 5685\nIBAN DE89370400440532013000", { exclude: ["EE38 2200 2210 2014 5685"] }))
      .toBe("DE89370400440532013000");
    expect(extractIban("IBAN EE382200221020145685", { exclude: "EE382200221020145685" })).toBeUndefined();
  });

  it("extracts IBANs grouped with no-break spaces from PDF text", () => {
    expect(extractIban("IBAN EE38\u00A02200\u00A02210\u00A02014\u00A05685 BIC HABAEE2X")).toBe("EE382200221020145685");
    expect(extractIban("FR76\u202F3000\u202F6000\u202F0112\u202F3456\u202F7890\u202F189")).toBe("FR7630006000011234567890189");
  });

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

  it("continues from an invalid first IBAN to a later valid IBAN", () => {
    // The first candidate has invalid check digits; extraction must not stop
    // at it and return undefined — it must keep scanning to the valid one.
    expect(extractIban("IBAN EE001234567890123456 then EE471000001020145685")).toBe("EE471000001020145685");
  });

  it("extracts an IBAN with no space between a punctuation label and the value", () => {
    // Real invoices print "IBAN:EE..." with no separating space, and enclose the
    // value in brackets or trail it with ";BIC:...". The extractor must still
    // find the IBAN in each — a whitespace-only split would miss all three.
    expect(extractIban("IBAN:EE382200221020145685")).toBe("EE382200221020145685");
    expect(extractIban("IBAN:(EE382200221020145685)")).toBe("EE382200221020145685");
    expect(extractIban("EE382200221020145685;BIC:HABAEE2X")).toBe("EE382200221020145685");
  });

  it("extracts a lowercase/mixed-case IBAN (OCR normalisation)", () => {
    expect(extractIban("iban: ee38 2200 2210 2014 5685")).toBe("EE382200221020145685");
  });

  it("does not bridge an IBAN into the following BIC, date, amount or digits", () => {
    // The regex allows spaces between groups, so the trailing token used to be
    // glued onto the IBAN and the whole candidate failed mod-97. Candidates are
    // trimmed to the country's registered IBAN length (EE = 20).
    expect(extractIban("EE38 2200 2210 2014 5685 BIC HABAEE2X")).toBe("EE382200221020145685");
    expect(extractIban("EE382200221020145685 BIC HABAEE2X")).toBe("EE382200221020145685");
    expect(extractIban("IBAN EE38 2200 2210 2014 5685 SWIFT HABAEE2X")).toBe("EE382200221020145685");
    expect(extractIban("IBAN: EE382200221020145685 12.05.2026")).toBe("EE382200221020145685");
    expect(extractIban("EE38 2200 2210 2014 5685 1234")).toBe("EE382200221020145685");
    expect(extractIban("EE38 2200 2210 2014 5685 Summa 120.00")).toBe("EE382200221020145685");
    expect(extractIban("EE38 2200 2210 2014 5685 Viitenumber 1234567")).toBe("EE382200221020145685");
  });

  it("trims bridged candidates to the registered length for other countries", () => {
    expect(extractIban("FI21 1234 5600 0007 85 BIC NDEAFIHH")).toBe("FI2112345600000785");
    expect(extractIban("DE89 3704 0044 0532 0130 00 COBADEFFXXX")).toBe("DE89370400440532013000");
    expect(extractIban("GB29 NWBK 6016 1331 9268 19 1234")).toBe("GB29NWBK60161331926819");
    expect(extractIban("LV80 BANK 0000 4351 9500 1 HABALV22")).toBe("LV80BANK0000435195001");
    expect(extractIban("LT12 1000 0111 0100 1000 HABALT22")).toBe("LT121000011101001000");
  });

  it("rejects a known-country candidate shorter than the registered length", () => {
    // EE61220022102014568 passes mod-97 but is 19 characters; an EE IBAN is
    // exactly 20, so it must not be accepted.
    expect(extractIban("EE61 2200 2210 2014 568")).toBeUndefined();
  });

  it("keeps punctuation-delimited IBANs working alongside bridge trimming", () => {
    expect(extractIban("IBAN:EE382200221020145685 BIC HABAEE2X")).toBe("EE382200221020145685");
    expect(extractIban("(EE38 2200 2210 2014 5685) 12.05.2026")).toBe("EE382200221020145685");
    expect(extractIban("EE38 2200 2210 2014 5685;BIC:HABAEE2X")).toBe("EE382200221020145685");
  });

  it("only trims at a group boundary, so an OCR-truncated IBAN is not completed from the next token", () => {
    // EE22 2200 2210 2014 568 is one digit short; its first 20 characters with
    // the "2" of "2024" happen to pass mod-97 (EE222200221020145682).
    expect(extractIban("EE22 2200 2210 2014 568 2024")).toBeUndefined();
    // The same IBAN written in full and followed by a date is still accepted.
    expect(extractIban("EE22 2200 2210 2014 5682 2024")).toBe("EE222200221020145682");
  });

  it("rejects an IBAN welded to the following token without a separator", () => {
    // Deliberate: without whitespace or punctuation there is no group boundary
    // at the registered length, so "...5685BIC" is treated like any other
    // over-long token rather than guessed apart.
    expect(extractIban("EE382200221020145685BIC HABAEE2X")).toBeUndefined();
    expect(extractIban("EE382200221020145685BIC")).toBeUndefined();
  });

  it("resumes scanning after a preceding token swallows the IBAN", () => {
    expect(extractIban("KMKR EE100931558 EE382200221020145685")).toBe("EE382200221020145685");
    expect(extractIban("KMKR EE100931558 EE38 2200 2210 2014 5685 BIC HABAEE2X")).toBe("EE382200221020145685");
  });

  it("resumes scanning after an invalid spaced IBAN that bridged into a valid one", () => {
    expect(extractIban("EE00 1234 5678 9012 3456 EE47 1000 0010 2014 5685")).toBe("EE471000001020145685");
  });

  it("extracts the first of two IBANs on one line separated by a space", () => {
    expect(extractIban("EE382200221020145685 EE471000001020145685")).toBe("EE382200221020145685");
    expect(extractIban("EE471000001020145685 EE382200221020145685")).toBe("EE471000001020145685");
    expect(extractIban("EE38 2200 2210 2014 5685 EE47 1000 0010 2014 5685")).toBe("EE382200221020145685");
    expect(extractIban("EE47 1000 0010 2014 5685 EE38 2200 2210 2014 5685")).toBe("EE471000001020145685");
  });

  it("trims bridged candidates for non-European registry countries", () => {
    expect(extractIban("KZ86 125K ZT50 0410 0100 BIC KZKOKZKX")).toBe("KZ86125KZT5004100100");
    expect(extractIban("BH67 BMAG 0000 1299 1234 56 12.05.2026")).toBe("BH67BMAG00001299123456");
    expect(extractIban("QA58 DOHB 0000 1234 5678 90AB CDEF G 1234")).toBe("QA58DOHB00001234567890ABCDEFG");
    expect(extractIban("LC55 HEMM 0001 0001 0012 0012 0002 3015 BIC")).toBe("LC55HEMM000100010012001200023015");
    expect(extractIban("BR18 0036 0305 0000 1000 9795 493C 1 Summa")).toBe("BR1800360305000010009795493C1");
  });

  it("rejects a country code that is not in the IBAN registry", () => {
    // XX042200221020145685 passes mod-97 but XX is not an IBAN country.
    expect(extractIban("XX042200221020145685")).toBeUndefined();
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

describe("isValidEeRegistryCode", () => {
  it("accepts a checksum-valid code from the stdnum docs (12345678)", () => {
    expect(isValidEeRegistryCode("12345678")).toBe(true);
  });

  it("accepts a real Estonian company code (Seppo AI OÜ 17133416)", () => {
    expect(isValidEeRegistryCode("17133416")).toBe(true);
  });

  it("rejects a wrong-checksum code (12345679)", () => {
    expect(isValidEeRegistryCode("12345679")).toBe(false);
  });

  it("rejects wrong length (7 digits)", () => {
    expect(isValidEeRegistryCode("1234567")).toBe(false);
  });

  it("rejects non-digit input", () => {
    expect(isValidEeRegistryCode("1234567a")).toBe(false);
  });

  it("rejects a leading 2 (not in 1/7/8/9 domain)", () => {
    // 2234567X would never be a valid Estonian registrikood regardless of checksum
    expect(isValidEeRegistryCode("22345674")).toBe(false);
  });

  it("rejects undefined and empty", () => {
    expect(isValidEeRegistryCode(undefined)).toBe(false);
    expect(isValidEeRegistryCode("")).toBe(false);
  });

  it("strips whitespace before validating", () => {
    expect(isValidEeRegistryCode(" 17133416 ")).toBe(true);
  });
});

describe("isValidEeVatNumber", () => {
  it("accepts a checksum-valid EE VAT (100594102 from stdnum docs)", () => {
    expect(isValidEeVatNumber("EE100594102")).toBe(true);
  });

  it("accepts the real Seppo AI OÜ VAT (EE102809963)", () => {
    expect(isValidEeVatNumber("EE102809963")).toBe(true);
  });

  it("accepts a bare 9-digit form (no EE prefix)", () => {
    expect(isValidEeVatNumber("100594102")).toBe(true);
  });

  it("rejects a wrong-checksum VAT (EE100594103)", () => {
    expect(isValidEeVatNumber("EE100594103")).toBe(false);
  });

  it("rejects a foreign VAT (DE123456789)", () => {
    expect(isValidEeVatNumber("DE123456789")).toBe(false);
  });

  it("rejects wrong length (EE + 8 digits)", () => {
    expect(isValidEeVatNumber("EE12345678")).toBe(false);
  });

  it("rejects undefined and empty", () => {
    expect(isValidEeVatNumber(undefined)).toBe(false);
    expect(isValidEeVatNumber("")).toBe(false);
  });

  it("strips whitespace and lowercases the EE prefix", () => {
    expect(isValidEeVatNumber(" ee 102 809 963 ")).toBe(true);
  });
});

describe("extractRegistryCode — prefix-less recovery (tier 2)", () => {
  it("recovers a bare 8-digit code with no label near the top of the document", () => {
    const text = [
      "Acme OÜ",
      "17133416",
      "Tallinn",
      "",
      "Invoice 123",
      "Total 100.00",
    ].join("\n");
    expect(extractRegistryCode(text)).toBe("17133416");
  });

  it("does not recover a bare 8-digit number on a buyer-section line", () => {
    const text = [
      "Acme OÜ",
      "Tallinn",
      "",
      "Bill to",
      "17133416",
    ].join("\n");
    expect(extractRegistryCode(text)).toBeUndefined();
  });

  it("does not recover a bare 8-digit number with a wrong checksum", () => {
    const text = [
      "Acme OÜ",
      "12345679",
      "Tallinn",
    ].join("\n");
    expect(extractRegistryCode(text)).toBeUndefined();
  });

  it("prefers the labeled match over a bare candidate when both are present", () => {
    const text = [
      "Acme OÜ",
      "17133416",
      "Tallinn",
      "Registrikood: 12345678",
    ].join("\n");
    expect(extractRegistryCode(text)).toBe("12345678");
  });

  it("excludes the own-company reg code passed via excludeRegCode", () => {
    const text = [
      "Acme OÜ",
      "17133416",
      "Tallinn",
    ].join("\n");
    expect(extractRegistryCode(text, { excludeRegCode: "17133416" })).toBeUndefined();
  });

  it("recovers the supplier reg code in a two-column layout where all candidates are after the buyer anchor", () => {
    // Mirrors the Printimiskeskus layout: buyer block on the left, supplier
    // block on the right, "Arve saaja" at the top. Both reg codes land after
    // the anchor in the text stream. The earliest (supplier-side in OCR
    // reading order) should be picked.
    const text = [
      "Arve saaja",
      "Innukas Digital OÜ                            Arve nr 137290",
      "Rg-kood 17487472                                                    Printimiskeskus OÜ",
      "KMKR nr EE102977811",
      "             Rg-kood 12176678",
      "             KMKR nr EE101493286",
    ].join("\n");
    // Tier 1 matches the labeled "Rg-kood 17487472" (first in text).
    expect(extractRegistryCode(text)).toBe("17487472");
  });

  it("uses later labeled reg matches after filtering an excluded buyer-side match", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 17487472",
      "Müüja",
      "Supplier OÜ",
      "Rg-kood 12176678",
    ].join("\n");

    const ids = extractIdentifiers(text, { excludeRegCode: "17487472" });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("buyer_section_only");
  });
});

describe("extractVatNumber — prefix-less recovery (tier 2)", () => {
  it("recovers a bare EE+9 VAT with no label", () => {
    const text = [
      "Acme OÜ",
      "EE100594102",
      "Tallinn",
    ].join("\n");
    expect(extractVatNumber(text)).toBe("EE100594102");
  });

  it("recovers and normalizes a whitespace-grouped bare EE VAT", () => {
    const text = [
      "Acme OÜ",
      "EE 100 594 102",
      "Tallinn",
    ].join("\n");
    expect(extractVatNumber(text)).toBe("EE100594102");
  });

  it("does not recover a bare EE+9 with a wrong checksum", () => {
    const text = [
      "Acme OÜ",
      "EE100594103",
      "Tallinn",
    ].join("\n");
    expect(extractVatNumber(text)).toBeUndefined();
  });

  it("does not recover a foreign bare VAT (DE+9) — tier 2 is EE-only", () => {
    const text = [
      "Acme GmbH",
      "DE123456789",
      "Berlin",
    ].join("\n");
    expect(extractVatNumber(text)).toBeUndefined();
  });

  it("prefers the labeled match over a bare candidate when both are present", () => {
    const text = [
      "Acme OÜ",
      "EE100594102",
      "Tallinn",
      "KMKR: EE102809963",
    ].join("\n");
    expect(extractVatNumber(text)).toBe("EE102809963");
  });

  it("excludes the own-company VAT passed via exclude", () => {
    const text = [
      "Acme OÜ",
      "EE100594102",
      "Tallinn",
    ].join("\n");
    expect(extractVatNumber(text, { exclude: "EE100594102" })).toBeUndefined();
  });
});

describe("extractIdentifiers", () => {
  it("returns all_vat_candidates including buyer-side tokens", () => {
    const text = [
      "KMKR: EE111111111",
      "Arve saaja",
      "KMKR: EE222222222",
    ].join("\n");
    const ids = extractIdentifiers(text);
    expect(ids.all_vat_candidates).toEqual(
      expect.arrayContaining(["EE111111111", "EE222222222"]),
    );
  });

  it("populates rejected_candidates for bad-checksum tokens", () => {
    const text = "KMKR: EE100594103";
    const ids = extractIdentifiers(text);
    expect(ids.rejected_candidates.some(r => r.kind === "vat_no" && r.reason === "checksum_failed")).toBe(true);
  });

  it("sets reg_code_rationale to 'labeled' for a prefixed match", () => {
    const ids = extractIdentifiers("Registrikood: 17133416");
    expect(ids.reg_code_rationale).toBe("labeled");
  });

  it("sets vat_no_rationale to 'excluded_self' when only the own VAT is on the page", () => {
    const ids = extractIdentifiers("VAT: EE102809963", { excludeVat: "EE102809963" });
    expect(ids.vat_no_rationale).toBe("excluded_self");
    expect(ids.vat_no).toBeUndefined();
  });

  it("returns all_reg_code_candidates populated with checksum-valid tokens", () => {
    const text = [
      "Acme OÜ",
      "17133416",
      "Tallinn",
      "12345678",
    ].join("\n");
    const ids = extractIdentifiers(text);
    expect(ids.all_reg_code_candidates).toEqual(
      expect.arrayContaining(["17133416", "12345678"]),
    );
  });
});

describe("buildIdentifierMarkers — split Makse/saaja guard (#11)", () => {
  function ti(text: string, x: number, y: number, w = 50, h = 10): LayoutTextItem {
    return { text, x, y, width: w, height: h };
  }

  it("does not treat a lone 'saaja' preceded on the same row by 'Makse' as a buyer marker", () => {
    // "Makse" and "saaja" split into two layout items on the same row — the
    // (?<!makse\s) lookbehind cannot see across items, so a naive test would
    // classify the bare "saaja" as buyer. It is a payee (supplier-side), so it
    // must not be emitted as a buyer marker.
    const markers = buildIdentifierMarkers([
      ti("Makse", 50, 100),
      ti("saaja", 90, 100),
    ]);
    expect(markers.some(m => m.side === "buyer")).toBe(false);
  });

  it("still treats a lone 'saaja' as a buyer marker when the preceding same-row item is 'Arve'", () => {
    const markers = buildIdentifierMarkers([
      ti("Arve", 50, 100),
      ti("saaja", 90, 100),
    ]);
    expect(markers.some(m => m.side === "buyer" && m.text.toLowerCase() === "saaja")).toBe(true);
  });

  it("still treats a lone 'saaja' as a buyer marker when 'Makse' is on a different row", () => {
    const markers = buildIdentifierMarkers([
      ti("Makse", 50, 40),
      ti("saaja", 50, 100),
    ]);
    expect(markers.some(m => m.side === "buyer" && m.text.toLowerCase() === "saaja")).toBe(true);
  });

  // PASS3 #7a: a trailing colon on the split "saaja" ("Makse | saaja:") must
  // still be recognised as the payee half and suppressed.
  it("suppresses a 'saaja:' (trailing colon) preceded on the same row by 'Makse'", () => {
    const markers = buildIdentifierMarkers([
      ti("Makse", 50, 100),
      ti("saaja:", 90, 100),
    ]);
    expect(markers.some(m => m.side === "buyer")).toBe(false);
  });

  // PASS3 #7b: a payment-method label "Makseviis" must NOT suppress a genuine
  // buyer "saaja" — only an exact "Makse" neighbour is the payee prefix.
  it("still treats 'saaja' as a buyer marker when the left neighbour is 'Makseviis'", () => {
    const markers = buildIdentifierMarkers([
      ti("Makseviis", 50, 100),
      ti("saaja", 120, 100),
    ]);
    expect(markers.some(m => m.side === "buyer" && m.text.toLowerCase() === "saaja")).toBe(true);
  });
});

describe("extractIdentifiers — coordinate-based classification (Option C)", () => {
  function ti(text: string, x: number, y: number, w = 50, h = 10): LayoutTextItem {
    return { text, x, y, width: w, height: h };
  }

  it("picks the supplier-side reg code in a two-column layout (Printimiskeskus pattern)", () => {
    // Buyer block at x=52 (Arve saaja + buyer reg/VAT), supplier block at
    // x=475 (Müüja + supplier reg/VAT). The text stream puts the
    // buyer reg first (x=52, y=190) and the supplier reg later (x=485, y=275).
    // Without coordinates, the text heuristic picks the first one (buyer's).
    // With coordinates, the buyer marker at x=52 classifies the x=52 reg as
    // buyer-side, and the x=485 reg is in a different column → supplier-side.
    const text = [
      "Arve saaja",
      "Innukas Digital OÜ                            Arve nr 137290",
      "Rg-kood 17487472                                                    Müüja Printimiskeskus OÜ",
      "KMKR nr EE102977811",
      "                                                                      Rg-kood 12176678",
      "                                                                   KMKR nr EE101493286",
    ].join("\n");

    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("Innukas Digital OÜ", 52, 109),
      ti("Rg-kood 17487472", 52, 190),
      ti("Müüja Printimiskeskus OÜ", 475, 190),
      ti("KMKR nr EE102977811", 52, 202),
      ti("Rg-kood 12176678", 485, 275),
      ti("KMKR nr EE101493286", 468, 287),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("coordinate_confirmed");
    expect(ids.vat_no).toBe("EE101493286");
    expect(ids.vat_no_rationale).toBe("coordinate_confirmed");
  });

  it("keeps the supplier-side reg code when a supplier marker (Tarnija) is above it", () => {
    // Single-column layout (Jysk pattern): Tarnija at x=57, reg code below
    // at x=119. Saaja (buyer) further below. The supplier marker classifies
    // the reg code as supplier-side.
    const text = [
      "Tarnija:    Jysk OÜ",
      "Reg. Nr     10170660",
      "KM Reg. Nr. EE100731910",
      "Saaja:      Buyer OÜ",
    ].join("\n");

    const textItems: LayoutTextItem[] = [
      ti("Tarnija:", 57, 98),
      ti("Jysk OÜ", 119, 99),
      ti("Reg. Nr", 57, 112),
      ti("10170660", 119, 112),
      ti("KM Reg. Nr.", 57, 126),
      ti("EE100731910", 119, 126),
      ti("Saaja:", 57, 199),
      ti("Buyer OÜ", 119, 199),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("10170660");
    expect(ids.vat_no).toBe("EE100731910");
  });

  it("rejects a buyer-side reg code when no supplier-side alternative exists", () => {
    const text = "Arve saaja\nRg-kood 17487472";
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("Rg-kood 17487472", 52, 190),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBeUndefined();
    expect(ids.reg_code_rationale).toBe("coordinate_rejected");
  });

  it("falls back to text-stream heuristic when no textItems are provided", () => {
    const text = "Rg-kood 17487472\nRg-kood 12176678";
    const ids = extractIdentifiers(text);
    // No textItems → coordinate classification doesn't run → tier 1 picks
    // the first labeled match.
    expect(ids.reg_code).toBe("17487472");
    expect(ids.reg_code_rationale).toBe("labeled");
  });

  it("falls back to text heuristic when textItems don't contain markers", () => {
    const text = "Rg-kood 17487472\nRg-kood 12176678";
    const textItems: LayoutTextItem[] = [
      ti("Rg-kood 17487472", 52, 190),
      ti("Rg-kood 12176678", 485, 275),
    ];

    const ids = extractIdentifiers(text, { textItems });
    // No buyer/supplier markers in textItems → classification returns
    // "unknown" for all → the text heuristic result stands.
    expect(ids.reg_code).toBe("17487472");
  });

  it("does not reclassify a labeled match that is confirmed as supplier-side by coordinates", () => {
    const text = "Tarnija: Acme OÜ\nReg. Nr 10170660\nSaaja: Buyer OÜ";
    const textItems: LayoutTextItem[] = [
      ti("Tarnija:", 57, 98),
      ti("Reg. Nr", 57, 112),
      ti("10170660", 119, 112),
      ti("Saaja:", 57, 199),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("10170660");
    // Labeled match confirmed by coordinates (nearest marker is Tarnija =
    // supplier), but rationale stays "labeled" since the text heuristic
    // already chose it correctly.
    expect(ids.reg_code_rationale).toBe("labeled");
  });

  it("does not treat a nearest marker in another column as authoritative", () => {
    const text = "Arve saaja\nRg-kood 17487472\nMüüja";
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("Müüja", 475, 180),
      ti("Rg-kood 17487472", 52, 190),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBeUndefined();
    expect(ids.reg_code_rationale).toBe("coordinate_rejected");
  });

  it("does not use a buyer marker from page 2 to reject a page 1 supplier candidate", () => {
    const text = [
      "Supplier OÜ",
      "12176678",
      "Arve saaja",
      "Buyer OÜ",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      { text: "Supplier OÜ", x: 52, y: 90, width: 80, height: 10, pageNum: 1 },
      { text: "12176678", x: 52, y: 120, width: 55, height: 10, pageNum: 1 },
      { text: "Arve saaja", x: 52, y: 90, width: 70, height: 10, pageNum: 2 },
      { text: "Buyer OÜ", x: 52, y: 110, width: 60, height: 10, pageNum: 2 },
    ];

    const ids = extractIdentifiers(text, { textItems });

    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("bare_structural");
  });

  it("keeps a supplier-side reg code echoed in the buyer block when text-stream order differs from geometric order (#10)", () => {
    // Two-column, same page: supplier block on the right (x=400), buyer block on
    // the left (x=50), both on the same rows. The SAME reg code 12176678 is
    // printed under the supplier's Müüja marker AND echoed as a reference in the
    // buyer block. The raw text stream serialises the buyer occurrence FIRST
    // (top-down, left column first) while the geometric (page,y,x) order places
    // the same-row supplier occurrence differently — the mismatch #10 is about.
    // The supplier-side occurrence must win: 12176678 is the supplier's code.
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 12176678",
      "Müüja",
      "Supplier OÜ",
      "Rg-kood 12176678",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 50, 100),
      ti("Müüja", 400, 100),
      ti("Buyer OÜ", 50, 115),
      ti("Supplier OÜ", 400, 115),
      ti("Rg-kood 12176678", 50, 130, 90),
      ti("Rg-kood 12176678", 400, 130, 90),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).not.toBe("coordinate_rejected");
  });

  // PASS3 #2: the echo-rescue keep path must carry a DISTINCT rationale
  // (coordinate_confirmed_echo), not the firm coordinate_confirmed — the value
  // was buyer-selected and only kept because it also echoes a supplier column,
  // so downstream must not mistake it for a confidently confirmed supplier code.
  it("marks an echo-rescued reg code as coordinate_confirmed_echo, not coordinate_confirmed (#2)", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 12176678",
      "Müüja",
      "Supplier OÜ",
      "Rg-kood 12176678",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 50, 100),
      ti("Müüja", 400, 100),
      ti("Buyer OÜ", 50, 115),
      ti("Supplier OÜ", 400, 115),
      ti("Rg-kood 12176678", 50, 130, 90),
      ti("Rg-kood 12176678", 400, 130, 90),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("coordinate_confirmed_echo");
  });

  it("does not rescue a buyer-side code from a supplier occurrence on another page", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 17487472",
      "Müüja",
      "Supplier OÜ",
      "Viide 17487472",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 50, 100, 80, 10),
      ti("Buyer OÜ", 50, 115, 70, 10),
      ti("Rg-kood 17487472", 50, 130, 100, 10),
      { ...ti("Müüja", 400, 100), pageNum: 2 },
      { ...ti("Supplier OÜ", 400, 115, 90), pageNum: 2 },
      { ...ti("Viide 17487472", 400, 130, 100), pageNum: 2 },
    ];

    const ids = extractIdentifiers(text, { textItems });

    expect(ids.reg_code).toBeUndefined();
    expect(ids.reg_code_rationale).toBe("coordinate_rejected");
  });

  it("treats a distant same-row Makse as unrelated to a buyer Saaja marker", () => {
    const text = [
      "Saaja",
      "Acme OÜ",
      "Rg-kood 17487472",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Makse", 50, 100),
      ti("Saaja", 450, 100),
      ti("Acme OÜ", 450, 115, 70),
      ti("Rg-kood 17487472", 450, 130, 100),
    ];

    const ids = extractIdentifiers(text, { textItems });

    expect(ids.reg_code).toBeUndefined();
    expect(ids.reg_code_rationale).toBe("coordinate_rejected");
  });

  it("keeps the raw-text supplier occurrence when geometric order puts the buyer first", () => {
    const text = [
      "Müüja",
      "Supplier OÜ",
      "Rg-kood 12176678",
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 12176678",
    ].join("\n");
    // Parser/source order follows the raw text, but geometric (page, y, x)
    // sorting would put the buyer's left column before the supplier's right one.
    const textItems: LayoutTextItem[] = [
      ti("Müüja", 400, 100),
      ti("Supplier OÜ", 400, 115, 90),
      ti("Rg-kood 12176678", 400, 130, 100),
      ti("Arve saaja", 50, 100, 80),
      ti("Buyer OÜ", 50, 115, 70),
      ti("Rg-kood 12176678", 50, 130, 100),
    ];

    const ids = extractIdentifiers(text, { textItems });

    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("labeled");
    expect(ids.reg_code_rationale).not.toBe("coordinate_confirmed_echo");
  });

  // PASS4 #1: a buyer VAT echoed in a supplier-column reference line must NOT be
  // silently emitted as a firmly coordinate-confirmed supplier VAT. It is kept
  // (so a real supplier id is never lost — #10) but carries the weaker
  // coordinate_confirmed_echo rationale, which the receipt flow turns into an
  // "unconfirmed / needs-review" signal so the operator verifies the supplier.
  it("marks a buyer VAT echoed in a supplier-column reference line as echo, not trusted coordinate_confirmed (#1)", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "KMKR: EE102809963",
      "Müüja",
      "Supplier OÜ",
      "Viide EE102809963",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 50, 100),
      ti("Müüja", 400, 100),
      ti("Buyer OÜ", 50, 115),
      ti("Supplier OÜ", 400, 115),
      ti("KMKR: EE102809963", 50, 130, 120),
      ti("Viide EE102809963", 400, 130, 120),
    ];

    const ids = extractIdentifiers(text, { textItems });
    // Value is kept (not dropped), but flagged echo — never trusted as firm.
    expect(ids.vat_no).toBe("EE102809963");
    expect(ids.vat_no_rationale).toBe("coordinate_confirmed_echo");
    expect(ids.vat_no_rationale).not.toBe("coordinate_confirmed");
  });

  it("keeps duplicate selected reg-code occurrence page-aware when page 2 has a lower y", () => {
    const text = [
      "Müüja Supplier OÜ",
      "Rg-kood 12176678",
      "Arve saaja Buyer OÜ",
      "Rg-kood 12176678",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      { text: "Müüja Supplier OÜ", x: 52, y: 150, width: 100, height: 10, pageNum: 1 },
      { text: "Rg-kood 12176678", x: 52, y: 180, width: 90, height: 10, pageNum: 1 },
      { text: "Arve saaja Buyer OÜ", x: 52, y: 20, width: 120, height: 10, pageNum: 2 },
      { text: "Rg-kood 12176678", x: 52, y: 40, width: 90, height: 10, pageNum: 2 },
    ];

    const ids = extractIdentifiers(text, { textItems });

    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("labeled");
  });

  // PASS4 #7: the selected value's position is a CHARACTER fraction of the raw
  // text. A long OCR item (a wrapped address line) printed just before the
  // supplier reg code inflates the value's char position; a bare ORDINAL mapping
  // back onto the geometric items would then land on the LATER (buyer) duplicate
  // occurrence and misclassify the supplier code as buyer. Character-weighting
  // the item positions keeps the selection on the real supplier occurrence.
  it("selects the supplier occurrence of a duplicated reg code despite a long preceding OCR item (#7)", () => {
    const longAddressLine =
      "Registreeritud aadress: Pikk tänav 12, Kesklinna linnaosa, Tallinn 10123, Harjumaa, Eesti Vabariik";
    const text = [
      "Müüja",
      "Supplier OÜ",
      longAddressLine,
      "Rg-kood 12176678",
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 12176678",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Müüja", 50, 10),
      ti("Supplier OÜ", 50, 20, 90),
      ti(longAddressLine, 50, 30, 400),
      ti("Rg-kood 12176678", 50, 40, 90),
      ti("Arve saaja", 50, 50, 80),
      ti("Buyer OÜ", 50, 60, 70),
      ti("Rg-kood 12176678", 50, 70, 90),
    ];

    const ids = extractIdentifiers(text, { textItems });
    // The value is kept and classified on the SUPPLIER side (not buyer/rejected).
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).not.toBe("coordinate_rejected");
    expect(ids.reg_code_rationale).not.toBe("coordinate_confirmed_echo");
  });
});

describe("extractIdentifiers — second-review regression tests", () => {
  function ti(text: string, x: number, y: number, w = 50, h = 10): LayoutTextItem {
    return { text, x, y, width: w, height: h };
  }

  it("HIGH 1: buyer-section-only labeled reg does not block tier 2 bare recovery", () => {
    const text = [
      "Supplier OÜ",
      "12176678",
      "Tallinn",
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 17487472",
    ].join("\n");
    const ids = extractIdentifiers(text);
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("bare_structural");
  });

  it("HIGH 1: buyer-section-only labeled VAT does not block tier 2 bare recovery", () => {
    const text = [
      "Supplier OÜ",
      "EE100594102",
      "Tallinn",
      "Arve saaja",
      "Buyer OÜ",
      "KMKR: EE102977811",
    ].join("\n");
    const ids = extractIdentifiers(text);
    expect(ids.vat_no).toBe("EE100594102");
    expect(ids.vat_no_rationale).toBe("bare_structural");
  });

  it("HIGH 1: buyer-section-only labeled reg used as fallback when tier 2 finds nothing", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 17487472",
    ].join("\n");
    const ids = extractIdentifiers(text);
    expect(ids.reg_code).toBe("17487472");
    expect(ids.reg_code_rationale).toBe("buyer_section_only");
  });

  it("HIGH 2: coordinate recovery works with excludeRegCode set", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "17487472",
      "Müüja Supplier OÜ",
      "12176678",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("Buyer OÜ", 52, 109),
      ti("17487472", 52, 190),
      ti("Müüja Supplier OÜ", 475, 190),
      ti("12176678", 485, 275),
    ];
    const ids = extractIdentifiers(text, { excludeRegCode: "17487472", textItems });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("coordinate_confirmed");
  });

  it("MEDIUM 1: classifyByPosition handles split label/value with marker width", () => {
    const text = [
      "Tarnija:    Jysk OÜ",
      "Reg. Nr     10170660",
      "Saaja:      Buyer OÜ",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Tarnija:", 57, 98, 60, 12),
      ti("Jysk OÜ", 119, 99),
      ti("Reg. Nr", 57, 112),
      ti("10170660", 119, 112),
      ti("Saaja:", 57, 199, 50, 12),
      ti("Buyer OÜ", 119, 199),
    ];
    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("10170660");
  });

  it("MEDIUM 3: checksum-failing labeled EE VAT appears in rejected_candidates", () => {
    const text = "KMKR: EE100594103";
    const ids = extractIdentifiers(text);
    expect(ids.rejected_candidates.some(r => r.kind === "vat_no" && r.value === "EE100594103" && r.reason === "checksum_failed")).toBe(true);
  });

  it("MEDIUM 3: checksum-failing labeled reg code appears in rejected_candidates", () => {
    const text = "Registrikood: 12345679";
    const ids = extractIdentifiers(text);
    expect(ids.rejected_candidates.some(r => r.kind === "reg_code" && r.value === "12345679" && r.reason === "checksum_failed")).toBe(true);
  });
});

describe("extractIdentifiers — third-review regression tests", () => {
  function ti(text: string, x: number, y: number, w = 50, h = 10): LayoutTextItem {
    return { text, x, y, width: w, height: h };
  }

  it("HIGH 1: classifies the selected reg-code occurrence instead of any matching supplier-side occurrence", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "Rg-kood 17487472",
      "Müüja Supplier OÜ",
      "Viide koodile 17487472",
      "Rg-kood 12176678",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("Buyer OÜ", 52, 109),
      ti("Rg-kood 17487472", 52, 190),
      ti("Müüja Supplier OÜ", 475, 190),
      ti("Viide koodile 17487472", 475, 220),
      ti("Rg-kood 12176678", 485, 275),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("coordinate_confirmed");
  });

  it("HIGH 1: classifies the selected VAT occurrence instead of any matching supplier-side occurrence", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "KMKR EE102809963",
      "Müüja Supplier OÜ",
      "Viide KMKR EE102809963",
      "KMKR EE100594102",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("Buyer OÜ", 52, 109),
      ti("KMKR EE102809963", 52, 190),
      ti("Müüja Supplier OÜ", 475, 190),
      ti("Viide KMKR EE102809963", 475, 220),
      ti("KMKR EE100594102", 485, 275),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.vat_no).toBe("EE100594102");
    expect(ids.vat_no_rationale).toBe("coordinate_confirmed");
  });

  it("HIGH 2: skips a checksum-failing labeled EE reg code and recovers a valid bare alternative", () => {
    const ids = extractIdentifiers([
      "Registrikood: 12345679",
      "Supplier OÜ",
      "17133416",
    ].join("\n"));

    expect(ids.reg_code).toBe("17133416");
    expect(ids.all_reg_code_candidates).toEqual(expect.arrayContaining(["12345679", "17133416"]));
    expect(ids.rejected_candidates).toContainEqual({
      kind: "reg_code",
      value: "12345679",
      reason: "checksum_failed",
    });
  });

  it("HIGH 2: skips a checksum-failing labeled EE VAT and recovers a valid bare alternative", () => {
    const ids = extractIdentifiers([
      "KMKR: EE100594103",
      "Supplier OÜ",
      "EE100594102",
    ].join("\n"));

    expect(ids.vat_no).toBe("EE100594102");
    expect(ids.all_vat_candidates).toEqual(expect.arrayContaining(["EE100594103", "EE100594102"]));
    expect(ids.rejected_candidates).toContainEqual({
      kind: "vat_no",
      value: "EE100594103",
      reason: "checksum_failed",
    });
  });

  it("MEDIUM 1: caps marker width so a wide buyer label does not capture a neighboring column", () => {
    const text = [
      "Arve saaja",
      "Reg. Nr 10170660",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93, 200),
      ti("Reg. Nr 10170660", 250, 112),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("10170660");
    expect(ids.reg_code_rationale).toBe("buyer_section_only");
  });

  it("MEDIUM 2: coordinate classification can recover a single bare candidate after a buyer-section marker", () => {
    const text = [
      "Arve saaja",
      "Müüja Supplier OÜ",
      "12176678",
    ].join("\n");
    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("Müüja Supplier OÜ", 475, 190),
      ti("12176678", 485, 220),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("coordinate_confirmed");
  });

  it("LOW 2: reports each all_reg_code_candidates value only once", () => {
    const ids = extractIdentifiers([
      "Registrikood: 17133416",
      "17133416",
      "12345678",
      "12345678",
    ].join("\n"));

    expect(ids.all_reg_code_candidates).toEqual(["17133416", "12345678"]);
  });

  it("MEDIUM 1: reports each all_vat_candidates value only once", () => {
    const ids = extractIdentifiers([
      "KMKR: EE100594102",
      "KMKR: EE100594102",
      "KMKR: EE102809963",
      "KMKR: EE102809963",
    ].join("\n"));

    expect(ids.all_vat_candidates).toEqual(["EE100594102", "EE102809963"]);
  });

  it("Codex review 4 - HIGH: coordinate fallback does not resurrect checksum-failing reg code", () => {
    const text = [
      "Arve saaja",
      "KMKR EE100594102",
      "Müüja Supplier OÜ",
      "Reg. nr 12345679",
    ].join("\n");

    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("KMKR EE100594102", 52, 110),
      ti("Müüja Supplier OÜ", 475, 110),
      ti("Reg. nr 12345679", 475, 130),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBeUndefined();
    expect(ids.rejected_candidates.some(r => r.value === "12345679" && r.reason === "checksum_failed")).toBe(true);
  });

  it("Codex review 4 - HIGH: coordinate fallback does not resurrect checksum-failing VAT", () => {
    const text = [
      "Arve saaja",
      "KMKR EE999999999",
      "Müüja Supplier OÜ",
      "KMKR EE100594102",
    ].join("\n");

    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 93),
      ti("KMKR EE999999999", 52, 110),
      ti("Müüja Supplier OÜ", 475, 110),
      ti("KMKR EE100594102", 475, 130),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.vat_no).toBe("EE100594102");
    expect(ids.rejected_candidates.some(r => r.value === "EE999999999")).toBe(true);
  });

  it("Codex review 4 - MEDIUM: tier-1 rejects malformed EE VAT (non-digit in EE number)", () => {
    const ids = extractIdentifiers("KMKR EE10X594103");
    expect(ids.vat_no).toBeUndefined();
    expect(ids.rejected_candidates.some(r => r.value === "EE10X594103" && r.reason === "invalid_shape")).toBe(true);
  });

  it("Codex review 4 - MEDIUM: tier-1 rejects EE VAT with too few digits", () => {
    const ids = extractIdentifiers("KMKR EE10059410");
    expect(ids.vat_no).toBeUndefined();
    expect(ids.rejected_candidates.some(r => r.value === "EE10059410" && r.reason === "invalid_shape")).toBe(true);
  });

  it("Codex review 5 - HIGH: tier-1 rejects EE VAT with too many digits", () => {
    const ids = extractIdentifiers("KMKR EE100594102999");
    expect(ids.vat_no).toBeUndefined();
    expect(ids.rejected_candidates).toContainEqual({
      kind: "vat_no",
      value: "EE100594102999",
      reason: "invalid_shape",
    });
  });

  it("Codex review 4 - MEDIUM: `makse saaja` is not classified as buyer-side", () => {
    const text = [
      "Makse saaja",
      "Supplier OÜ",
      "Reg. nr 10170660",
      "KMKR EE100731910",
      "Arve saaja",
      "Buyer OÜ",
    ].join("\n");

    const textItems: LayoutTextItem[] = [
      ti("Makse saaja", 50, 90),
      ti("Supplier OÜ", 50, 105),
      ti("Reg. nr 10170660", 50, 120),
      ti("KMKR EE100731910", 50, 135),
      ti("Arve saaja", 400, 90),
      ti("Buyer OÜ", 400, 105),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.reg_code).toBe("10170660");
    expect(ids.vat_no).toBe("EE100731910");
  });

  it("Codex review 4 - LOW: coordinate classification finds VAT split across multiple text items", () => {
    const text = [
      "Arve saaja",
      "Buyer OÜ",
      "KMKR EE100594102",
      "Müüja Supplier OÜ",
      "KMKR EE 102 809 963",
    ].join("\n");

    const textItems: LayoutTextItem[] = [
      ti("Arve saaja", 52, 90),
      ti("Buyer OÜ", 52, 105),
      ti("KMKR EE100594102", 52, 120),
      ti("Müüja Supplier OÜ", 475, 90),
      ti("KMKR", 475, 120),
      ti("EE", 510, 120),
      ti("102", 530, 120),
      ti("809", 550, 120),
      ti("963", 570, 120),
    ];

    const ids = extractIdentifiers(text, { textItems });
    expect(ids.vat_no).toBe("EE102809963");
    expect(ids.vat_no_rationale).toBe("coordinate_confirmed");
  });
});

describe("extractIdentifiers — competing labelled supplier ids (supplier_identifier_ambiguous, corpus #30 Piletilevi)", () => {
  // Checksum-valid synthetic ids: A = 12345603 / EE123456007, B = 12345610 / EE123456010.
  // Entity names avoid buyer-section words ("Ostja", "Klient", "Client"): such a
  // word anchors a buyer section and changes the rationales.
  const contest = [
    "Arve nr 4003479",
    "Alfa Ehitus OÜ",
    "Kuupäev: 30.09.2025",
    "Rg-kood: 12345603",
    "KMKR: EE123456007",
    "Vahesumma: 100,00",
    "Käibemaks (24%): 24,00",
    "Kokku (EUR): 124,00",
    "Beeta Teenused AS",
    "Rg-kood: 12345610",
    "KMKR: EE123456010",
  ];
  function ti(text: string, x: number, y: number, w = 120, h = 10): LayoutTextItem {
    return { text, x, y, width: w, height: h };
  }

  it("holds two labelled id pairs of other entities without changing the chosen value", () => {
    const ids = extractIdentifiers(contest.join("\n"));
    expect(ids.reg_code).toBe("12345603");
    expect(ids.vat_no).toBe("EE123456007");
    expect(ids.reg_code_rationale).toBe("labeled");
    expect(ids.supplier_identifier_ambiguous).toBe(true);
    // Own ids that are not on the page change nothing.
    const unrelatedOwn = extractIdentifiers(contest.join("\n"), { excludeRegCode: "10195631", excludeVat: "EE100449794" });
    expect(unrelatedOwn.reg_code).toBe("12345603");
    expect(unrelatedOwn.supplier_identifier_ambiguous).toBe(true);
  });

  it("does not hold once the own pair is excluded, or when only one pair is printed", () => {
    const own = extractIdentifiers(contest.join("\n"), { excludeRegCode: "12345603", excludeVat: "EE123456007" });
    expect(own.reg_code).toBe("12345610");
    expect(own.vat_no).toBe("EE123456010");
    expect(own.reg_code_rationale).toBe("labeled");
    expect(own.supplier_identifier_ambiguous).toBeUndefined();
    expect(extractIdentifiers(contest.slice(8).join("\n")).supplier_identifier_ambiguous).toBeUndefined();
  });

  it("checks each kind on its own (registry-only and VAT-only contests)", () => {
    const regOnly = extractIdentifiers("Alfa Ehitus OÜ\nRg-kood: 12345603\nBeeta Teenused AS\nRg-kood: 12345610");
    expect(regOnly.vat_no).toBeUndefined();
    expect(regOnly.supplier_identifier_ambiguous).toBe(true);
    const vatOnly = extractIdentifiers("Alfa Ehitus OÜ\nKMKR: EE123456007\nBeeta Teenused AS\nKMKR: EE123456010");
    expect(vatOnly.reg_code).toBeUndefined();
    expect(vatOnly.supplier_identifier_ambiguous).toBe(true);
    // Only the own registry code excluded: the VAT contest alone still holds.
    const ownRegOnly = extractIdentifiers(contest.join("\n"), { excludeRegCode: "12345603" });
    expect(ownRegOnly.reg_code).toBe("12345610");
    expect(ownRegOnly.vat_no).toBe("EE123456007");
    expect(ownRegOnly.supplier_identifier_ambiguous).toBe(true);
  });

  it("does not count a repeated, checksum-invalid or excluded candidate as a competitor", () => {
    expect(extractIdentifiers(
      "Alfa Ehitus OÜ\nRg-kood: 12345603\nKMKR: EE123456007\nRg-kood: 12345603\nKMKR: EE 123456007",
    ).supplier_identifier_ambiguous).toBeUndefined();
    expect(extractIdentifiers(
      "Alfa Ehitus OÜ\nRg-kood: 12345603\nKMKR: EE123456007\nRg-kood: 12345604\nKMKR: EE123456008",
    ).supplier_identifier_ambiguous).toBeUndefined();
    const excluded = extractIdentifiers("Alfa Ehitus OÜ\nRg-kood: 12345603\nBeeta Teenused AS\nRg-kood: 12345610", { excludeRegCode: "12345603" });
    expect(excluded.reg_code).toBe("12345610");
    expect(excluded.supplier_identifier_ambiguous).toBeUndefined();
  });

  it("does not hold when no value was chosen (coordinate_rejected)", () => {
    const items = [ti("Saaja:", 50, 40), ti("Rg-kood: 12345603", 50, 55), ti("Rg-kood: 12345610", 50, 70)];
    const ids = extractIdentifiers(items.map(item => item.text).join("\n"), { textItems: items });
    expect(ids.reg_code).toBeUndefined();
    expect(ids.reg_code_rationale).toBe("coordinate_rejected");
    expect(ids.supplier_identifier_ambiguous).toBeUndefined();
  });

  it("(E1) does not hold a coordinate_confirmed choice", () => {
    const items = [
      ti("Arve nr 4003479", 50, 20),
      ti("Saaja:", 50, 40), ti("Alfa Ehitus OÜ", 50, 55), ti("Rg-kood: 12345603", 50, 70), ti("KMKR: EE123456007", 50, 85),
      ti("Müüja:", 400, 40), ti("Beeta Teenused AS", 400, 55), ti("Rg-kood: 12345610", 400, 70), ti("KMKR: EE123456010", 400, 85),
    ];
    const ids = extractIdentifiers(items.map(item => item.text).join("\n"), { textItems: items });
    expect(ids.reg_code).toBe("12345610");
    expect(ids.reg_code_rationale).toBe("coordinate_confirmed");
    expect(ids.vat_no_rationale).toBe("coordinate_confirmed");
    expect(ids.supplier_identifier_ambiguous).toBeUndefined();
  });

  it("(E2) leaves a coordinate_confirmed_echo choice to its own echo signal", () => {
    const items = [
      ti("Arve saaja", 50, 100), ti("Müüja", 400, 100),
      ti("Buyer OÜ", 50, 115), ti("Supplier OÜ", 400, 115),
      ti("Rg-kood 12176678", 50, 130, 90), ti("Rg-kood 12176678", 400, 130, 90),
      ti("Rg-kood 12345603", 50, 145, 90),
    ];
    const ids = extractIdentifiers(items.map(item => item.text).join("\n"), { textItems: items });
    expect(ids.reg_code).toBe("12176678");
    expect(ids.reg_code_rationale).toBe("coordinate_confirmed_echo");
    expect(ids.supplier_identifier_ambiguous).toBeUndefined();
  });

  it("(E3) does not hold a labelled choice whose occurrence sits on the supplier side", () => {
    const items = [
      ti("Tarnija:", 50, 20), ti("Alfa Ehitus OÜ", 50, 35), ti("Rg-kood: 12345603", 50, 50), ti("KMKR: EE123456007", 50, 65),
      ti("Beeta Teenused AS", 400, 300), ti("Rg-kood: 12345610", 400, 315), ti("KMKR: EE123456010", 400, 330),
    ];
    const ids = extractIdentifiers(items.map(item => item.text).join("\n"), { textItems: items });
    expect(ids.reg_code).toBe("12345603");
    expect(ids.reg_code_rationale).toBe("labeled");
    expect(ids.supplier_identifier_ambiguous).toBeUndefined();
  });

  it("(E4) a buyer-section anchor narrows the competitors to the labelled ids before it", () => {
    const anchored = [
      "Müüja: Alfa Ehitus OÜ", "Rg-kood: 12345603", "KMKR: EE123456007",
      "Ostja: Beeta Teenused AS", "Rg-kood: 12345610", "KMKR: EE123456010",
    ].join("\n");
    // The active company's own registry code is unknown (inferred from the clients list).
    const ids = extractIdentifiers(anchored, { excludeVat: "EE123456010" });
    expect(ids.reg_code).toBe("12345603");
    expect(ids.reg_code_rationale).toBe("labeled");
    expect(ids.supplier_identifier_ambiguous).toBeUndefined();
  });

  it("(E4) never bypasses the check: two distinct ids before the anchor still hold", () => {
    const reg = extractIdentifiers(
      "Müüja: Alfa Ehitus OÜ\nRg-kood: 12345603\nRg-kood: 12345626\nOstja: Beeta Teenused AS\nRg-kood: 12345610",
    );
    expect(reg.reg_code).toBe("12345603");
    expect(reg.supplier_identifier_ambiguous).toBe(true);
    const vat = extractIdentifiers(
      "Müüja: Alfa Ehitus OÜ\nKMKR: EE123456007\nKMKR: EE123456023\nOstja: Beeta Teenused AS\nKMKR: EE123456010",
    );
    expect(vat.vat_no).toBe("EE123456007");
    expect(vat.supplier_identifier_ambiguous).toBe(true);
  });
});
