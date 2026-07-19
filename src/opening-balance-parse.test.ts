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
});
