import { describe, it, expect } from "vitest";
import { parseOpeningBalances, OpeningBalanceParseError } from "./opening-balance-parse.js";

const SAMPLE = [
  "Algbilansi kanded",
  "Nr\tKuupäev\tKonto\tDeebet\tKreedit\tDokNr\tTehingu sisu\tTulemusüksus",
  "10003.\t12.12.2024\t1020 AS LHV Pank EE637700771011212909\t1 000.00 €\t\t\tAlgbilansi seadistamine\t",
  "\t\t2900 Osakapital või aktsiakapital nimiväärtuses\t\t1 000.00 €\t\t\t",
].join("\n");

describe("parseOpeningBalances", () => {
  it("parses paired debit/credit lines into per-account sums", () => {
    const r = parseOpeningBalances(SAMPLE);
    expect(r.openingDate).toBe("2024-12-12");
    expect(r.accounts).toEqual([
      { code: "1020", name: "AS LHV Pank EE637700771011212909", debit: 1000, credit: 0 },
      { code: "2900", name: "Osakapital või aktsiakapital nimiväärtuses", debit: 0, credit: 1000 },
    ]);
    expect(r.totals).toEqual({ debit: 1000, credit: 1000 });
    expect(r.rawText).toBe(SAMPLE);
  });

  it("tolerates space-run separators instead of tabs", () => {
    const spaced = [
      "Algbilansi kanded",
      "Nr    Kuupäev    Konto    Deebet    Kreedit    DokNr    Tehingu sisu    Tulemusüksus",
      "10003.    12.12.2024    1020 AS LHV Pank    1 000.00 €",
      "          2900 Osakapital    1 000.00 €",
    ].join("\n");
    const r = parseOpeningBalances(spaced);
    expect(r.accounts.map(a => a.code)).toEqual(["1020", "2900"]);
    expect(r.accounts[1]).toMatchObject({ debit: 0, credit: 1000 });
  });

  it("aggregates repeated account codes", () => {
    const dup = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.\t01.01.2025\t1020 Pank\t500.00 €\t",
      "2.\t01.01.2025\t1020 Pank\t250.00 €\t",
      "\t\t2900 Kapital\t\t750.00 €",
    ].join("\n");
    const r = parseOpeningBalances(dup);
    expect(r.accounts.find(a => a.code === "1020")).toMatchObject({ debit: 750, credit: 0 });
  });

  it("rejects an unbalanced algbilanss", () => {
    const bad = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.\t01.01.2025\t1020 Pank\t1 000.00 €\t",
      "\t\t2900 Kapital\t\t900.00 €",
    ].join("\n");
    expect(() => parseOpeningBalances(bad)).toThrow(OpeningBalanceParseError);
    expect(() => parseOpeningBalances(bad)).toThrow(/does not balance/i);
  });

  it("rejects a paste with no data rows", () => {
    expect(() => parseOpeningBalances("just some text\nnothing here")).toThrow(OpeningBalanceParseError);
  });

  it("rounds per-account debit/credit sums to 2 decimals, avoiding float noise", () => {
    const fractional = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.\t01.01.2025\t1020 Pank\t0.10 €\t",
      "2.\t01.01.2025\t1020 Pank\t0.20 €\t",
      "\t\t2900 Kapital\t\t0.30 €",
    ].join("\n");
    const r = parseOpeningBalances(fractional);
    const acc1020 = r.accounts.find(a => a.code === "1020");
    expect(acc1020?.debit).toBe(0.3);
    expect(acc1020?.credit).toBe(0);
  });

  it("drops a phantom row that resolves to debit==0 and credit==0", () => {
    const withStray = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.\t01.01.2025\t1020 Pank\t1 000.00 €\t",
      "\t\t2900 Kapital\t\t1 000.00 €",
      "\t\t3000 Extra",
    ].join("\n");
    const r = parseOpeningBalances(withStray);
    expect(r.accounts.map(a => a.code)).not.toContain("3000");
  });

  it("returns an empty openingDate when no dd.mm.yyyy token appears on any data row", () => {
    const noDate = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.\t\t1020 Pank\t1 000.00 €\t",
      "\t\t2900 Kapital\t\t1 000.00 €",
    ].join("\n");
    const r = parseOpeningBalances(noDate);
    expect(r.openingDate).toBe("");
  });

  it("parses positionally (debit, credit) when a space-run line carries both amounts", () => {
    const mixed = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.    01.01.2025    4000 Konto A    300.00 €    100.00 €",
      "\t\t5000 Konto B\t\t200.00 €",
    ].join("\n");
    const r = parseOpeningBalances(mixed);
    expect(r.accounts.find(a => a.code === "4000")).toMatchObject({ debit: 300, credit: 100 });
    expect(r.totals).toEqual({ debit: 300, credit: 300 });
  });
});
