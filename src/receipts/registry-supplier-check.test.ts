import { afterEach, describe, expect, it, vi } from "vitest";
import { ARIREGISTER_AUTOCOMPLETE_TELIA } from "../__fixtures__/ariregister-autocomplete.js";
import { buildExtractionConfidenceSignals } from "../tools/receipt-inbox.js";
import type { ExtractedReceiptFields } from "../tools/receipt-extraction.js";
import { clearRegistryNameCache } from "./registry-name-cache.js";
import {
  companyNamesAgree,
  crossCheckSupplierWithRegistry,
  registryNamePrinted,
} from "./registry-supplier-check.js";

// A two-column cash receipt: the buyer block left, the supplier block right,
// the bank's name in the footer (the R9studio shape, synthetic names).
const RAW_TEXT = [
  "Arve saaja",
  "Proovi OÜ                         Sularahaarve 1633",
  "Pargi 1, Tallinn                  Kuupäev 02.08.2026",
  "Rg-kood 12000005                                   Näidis Stuudio OÜ",
  "                                                   Rg-kood 10000018",
  "Majutus                    105,30",
  "Arve kokku (EUR) 105,30",
  "Näidis Finants AS IBAN EE471000001020145685",
].join("\n");

const fields = (overrides: Partial<ExtractedReceiptFields> = {}): ExtractedReceiptFields => ({
  supplier_name: "Näidis Finants AS",
  supplier_reg_code: "10000018",
  raw_text: RAW_TEXT,
  field_provenance: [{ field: "supplier_name", value: "Näidis Finants AS", source: "ocr", rationale: "top_line", pageNum: 1 }],
  ...overrides,
});

const registry = (name: string | null) => vi.fn(async () => (name === null ? null : { name }));

afterEach(() => {
  vi.unstubAllGlobals();
  clearRegistryNameCache();
});

describe("crossCheckSupplierWithRegistry", () => {
  it("takes the register's name when it is printed on the page and the read name is another company", async () => {
    const lookup = registry("Näidis Stuudio OÜ");
    const result = await crossCheckSupplierWithRegistry(fields(), { lookup, ownCompanyRegistryCode: "12000005", ownCompanyName: "Proovi OÜ" });
    expect(lookup).toHaveBeenCalledWith("10000018");
    expect(result.supplier_name).toBe("Näidis Stuudio OÜ");
    expect(result.field_provenance).toEqual([
      { field: "supplier_name", value: "Näidis Stuudio OÜ", source: "registry", rationale: "registry_name_on_page" },
    ]);
    expect(result.extraction_notes?.join(" ")).toMatch(/business register for registry code 10000018/);
    expect(buildExtractionConfidenceSignals(result, {})).toEqual({});
  });

  it("holds instead of renaming a labelled supplier to the company the code belongs to", async () => {
    // A misread bank code: the labelled supplier is right; the code's owner (the bank) is also printed.
    const input: ExtractedReceiptFields = {
      supplier_name: "Õige Stuudio OÜ",
      supplier_reg_code: "10000018",
      raw_text: "Müüja: Õige Stuudio OÜ\nTeenindav pank: Näidis Finants AS\nReg-kood 10000018",
      field_provenance: [{ field: "supplier_name", value: "Õige Stuudio OÜ", source: "label", rationale: "labeled" }],
    };
    const result = await crossCheckSupplierWithRegistry(input, { lookup: registry("Näidis Finants AS") });
    expect(result.supplier_name).toBe("Õige Stuudio OÜ");
    expect(result.supplier_identifier_ambiguous).toBe(true);
    expect(result.extraction_notes?.join(" ")).toMatch(/also printed on the document \(the supplier name is labelled\)/);
    expect(buildExtractionConfidenceSignals(result, {}).supplier_identifier_ambiguous).toBe(true);
  });

  it("holds a labelled supplier even when the code's owner is printed without any label", async () => {
    const input: ExtractedReceiptFields = {
      supplier_name: "Õige Stuudio OÜ",
      supplier_reg_code: "10000018",
      raw_text: "Müüja: Õige Stuudio OÜ\nArve nr INV-731\nKuupäev 01.10.2026\nNäidis Finants AS\nReg-kood 10000018",
      field_provenance: [{ field: "supplier_name", value: "Õige Stuudio OÜ", source: "label", rationale: "labeled" }],
    };
    const result = await crossCheckSupplierWithRegistry(input, { lookup: registry("Näidis Finants AS") });
    expect(result.supplier_name).toBe("Õige Stuudio OÜ");
    expect(result.supplier_identifier_ambiguous).toBe(true);
  });

  it("holds instead of renaming the supplier to a company printed under a bank label", async () => {
    const result = await crossCheckSupplierWithRegistry(
      fields({ raw_text: `${RAW_TEXT}\nPanga andmed:\nHoopis Teine OÜ` }),
      { lookup: registry("Hoopis Teine OÜ") },
    );
    expect(result.supplier_name).toBe("Näidis Finants AS");
    expect(result.supplier_identifier_ambiguous).toBe(true);
  });

  it("only notes it when the register's company for the code is not named on the page", async () => {
    const result = await crossCheckSupplierWithRegistry(fields(), { lookup: registry("Hoopis Teine OÜ") });
    expect(result.supplier_name).toBe("Näidis Finants AS");
    expect(result.field_provenance).toEqual(fields().field_provenance);
    expect(result.extraction_notes?.join(" ")).toMatch(/Registry code 10000018 belongs to another company/);
    expect(buildExtractionConfidenceSignals(result, {})).toEqual({});
  });

  it.each([
    ["the same name in capitals without the legal form", "NÄIDIS FINANTS"],
    ["a one-glyph misread", "Näidis Flnants AS"],
    ["the register's longer legal name", "Näidis Finants Eesti AS"],
  ])("leaves an agreeing name untouched (%s)", async (_label, registryName) => {
    const input = fields();
    expect(await crossCheckSupplierWithRegistry(input, { lookup: registry(registryName) })).toBe(input);
  });

  it("leaves the extraction untouched when the register gives no name or cannot be reached", async () => {
    const input = fields();
    expect(await crossCheckSupplierWithRegistry(input, { lookup: registry(null) })).toBe(input);
    expect(await crossCheckSupplierWithRegistry(input, { lookup: vi.fn(async () => { throw new Error("offline"); }) })).toBe(input);
  });

  it("does not look up an own, invalid or foreign code, or a document without a supplier name", async () => {
    const lookup = registry("Hoopis Teine OÜ");
    for (const input of [
      fields({ supplier_reg_code: "12000005" }),
      fields({ supplier_reg_code: "10000019" }),
      fields({ supplier_vat_no: "FI12345671", raw_text: `${RAW_TEXT}\nY-tunnus 1234567-1` }),
      fields({ supplier_name: undefined }),
    ]) {
      expect(await crossCheckSupplierWithRegistry(input, { lookup, ownCompanyRegistryCode: "12000005" })).toBe(input);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never renames the supplier to the active company", async () => {
    const input = fields();
    expect(await crossCheckSupplierWithRegistry(input, { lookup: registry("Proovi OÜ"), ownCompanyName: "Proovi OÜ" })).toBe(input);
  });

  it("reads the register through its public autocomplete endpoint once per code", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ...ARIREGISTER_AUTOCOMPLETE_TELIA,
      data: [{ ...ARIREGISTER_AUTOCOMPLETE_TELIA.data[0], reg_code: 10000018, name: "Näidis Stuudio OÜ" }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const first = await crossCheckSupplierWithRegistry(fields());
    const second = await crossCheckSupplierWithRegistry(fields());
    expect(first.supplier_name).toBe("Näidis Stuudio OÜ");
    expect(second.supplier_name).toBe("Näidis Stuudio OÜ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://ariregister.rik.ee/est/api/autocomplete?q=10000018");
  });
});

describe("registry name helpers", () => {
  it("finds the register's name as a line, a whitespace column or a labelled value", () => {
    const free = { under_other_party: false };
    expect(registryNamePrinted("Näidis Stuudio OÜ", "Näidis Stuudio OÜ")).toEqual(free);
    expect(registryNamePrinted("Rg-kood 1      NÄIDIS STUUDIO OU", "Näidis Stuudio OÜ")).toEqual(free);
    expect(registryNamePrinted("Müüja: Näidis Stuudio OÜ", "Näidis Stuudio OÜ")).toEqual(free);
    expect(registryNamePrinted("Näidis Stuudio Grupp OÜ", "Näidis Stuudio OÜ")).toBeUndefined();
    expect(registryNamePrinted("Stuudio", "Näidis Stuudio OÜ")).toBeUndefined();
  });

  it.each([
    ["on the label's line", "Teenindav pank: Näidis Finants AS"],
    ["one line under a bank heading", "Panga andmed:\nNäidis Finants AS"],
    ["two lines under a buyer label, in a column", "Ostja:\nPargi 1                Kuupäev 01.10.2026\nNäidis Finants AS      Arve 7"],
  ])("marks the register's name under another party's label (%s)", (_label, text) => {
    expect(registryNamePrinted(text, "Näidis Finants AS")).toEqual({ under_other_party: true });
  });

  it("takes a brand name that starts the register's name as agreeing, never a different name", () => {
    expect(companyNamesAgree("Näidis OÜ", "Näidis Stuudio OÜ")).toBe(true);
    expect(companyNamesAgree("Näidis Finants AS", "Hoopis Teine OÜ")).toBe(false);
    expect(companyNamesAgree("Abc OÜ", "Abc Ehitus OÜ")).toBe(false);
  });
});
