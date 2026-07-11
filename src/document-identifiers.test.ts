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
