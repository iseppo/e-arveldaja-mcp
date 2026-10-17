import { describe, expect, it } from "vitest";
import {
  creditWordHits,
  currencyScan,
  ibanScan,
  identifierScan,
  lineTokens,
  percentTokens,
  type MoneyToken,
} from "./document-reading-tokens.js";
import { makePacket } from "./__fixtures__/document-reading/make-packet.js";

/** Tokens of the first packet line built from one raw source line (column gaps become ` ¦ `). */
function tokensOf(raw: string) {
  const line = makePacket([raw]).lines[0]!;
  return { line, tokens: lineTokens(line) };
}
const moneyOf = (raw: string): MoneyToken[] => tokensOf(raw).tokens.money;
const valuesOf = (raw: string) => moneyOf(raw).map((token) => token.values);
const linesOf = (...raw: string[]) => makePacket(raw).lines;

describe("document-reading tokens: money shapes", () => {
  it("T-TOK-shapes: reads each single-word shape", () => {
    expect(valuesOf("Kokku 1234,56")).toEqual([[1234.56]]);
    expect(valuesOf("Kokku 1234.56")).toEqual([[1234.56]]);
    expect(valuesOf("Kokku 1.234,56")).toEqual([[1234.56]]);
    expect(valuesOf("Total 1,234.56")).toEqual([[1234.56]]);
    expect(moneyOf("Kokku 44,70.")[0]).toMatchObject({ kind: "decimal", values: [44.7], text: "44,70" });
  });

  it("T-TOK-ambiguous: `6,000` and `6.000` carry both readings", () => {
    expect(moneyOf("Summa 6,000")[0]).toMatchObject({ kind: "ambiguous", values: [6, 6000] });
    expect(moneyOf("Summa 6.000")[0]).toMatchObject({ kind: "ambiguous", values: [6, 6000] });
  });

  it("T-TOK-eur5: a single-digit integer is money only with currency adjacency", () => {
    expect(moneyOf("Kokku EUR 5")[0]).toMatchObject({ kind: "integer", values: [5] });
    expect(valuesOf("Kokku 5 €")).toEqual([[5]]);
    expect(valuesOf("Kokku 50€")).toEqual([[50]]);
    expect(valuesOf("Kokku €50")).toEqual([[50]]);
    expect(valuesOf("Kogus 5")).toEqual([]);
  });

  it("T-TOK-cell-boundary: `1 ¦ 483,07` yields 483.07 only (never joined across a column gap)", () => {
    const { line, tokens } = tokensOf("1    483,07");
    expect(line.text).toBe("1 ¦ 483,07");
    expect(tokens.money.map((token) => token.values)).toEqual([[483.07]]);
    expect(tokens.money[0]!.kind).toBe("decimal");
  });

  it("T-TOK-join: an in-cell `1 483,07` is ambiguous_join {1483.07, 483.07}", () => {
    expect(moneyOf("Teenus 1 483,07")[0]).toMatchObject({ kind: "ambiguous_join", values: [1483.07, 483.07], text: "1 483,07" });
  });

  it("T-TOK-wholecell: a whole cell `3 082,64` is still ambiguous_join", () => {
    const { tokens } = tokensOf("Kokku     3 082,64");
    expect(tokens.money).toHaveLength(1);
    expect(tokens.money[0]).toMatchObject({ kind: "ambiguous_join", text: "3 082,64" });
    expect(tokens.money[0]!.values).toContain(3082.64);
  });

  it("T-TOK-join-integer: `1 234 €` joins with currency adjacency", () => {
    const token = moneyOf("Hind 1 234 €")[0]!;
    expect(token.kind).toBe("ambiguous_join");
    expect(token.values).toContain(1234);
    expect(valuesOf("Kogus 1 234")).toEqual([]);
  });

  it("T-TOK-date-adjacent: a date next to an amount leaves the amount (column and in-cell)", () => {
    expect(valuesOf("15.03.26    125,00")).toEqual([[125]]);
    expect(valuesOf("15.03.26 125,00")).toEqual([[125]]);
  });

  it("T-TOK-exclusions: dates, percentages, IBAN digits and 7+ digit runs are not money", () => {
    expect(valuesOf("Kuupäev 15.03.2026")).toEqual([]);
    expect(valuesOf("KM 24%")).toEqual([]);
    expect(valuesOf("KM 24 %")).toEqual([]);
    expect(valuesOf("KM 9,50%")).toEqual([]);
    expect(valuesOf("IBAN EE59 1000 0018 2345 6789 EUR")).toEqual([]);
    expect(valuesOf("Konto 6789 EUR")).toEqual([[6789]]);
    expect(valuesOf("Viide EUR 1234567")).toEqual([]);
    expect(valuesOf("EUR 123456")).toEqual([[123456]]);
    expect(valuesOf("Kood 12,50EUR")).toEqual([]);
  });

  it("T-TOK-signed: dash before (with one space), dash after, and parentheses mark a token signed", () => {
    for (const raw of ["Allahindlus -26,00", "Allahindlus – 26,00", "Allahindlus 26,00-", "Allahindlus ( 26,00 )", "Allahindlus (26,00)", "Allahindlus −26,00"]) {
      expect(moneyOf(raw).map((token) => [token.values[0], token.signed]), raw).toEqual([[26, true]]);
    }
    expect(moneyOf("Allahindlus 26,00").map((token) => token.signed)).toEqual([false]);
  });

  it("T-TOK-signed-range: `10-20,00` is signed (documented false hold)", () => {
    expect(moneyOf("Periood 10-20,00").map((token) => [token.values[0], token.signed])).toEqual([[20, true]]);
  });
});

describe("document-reading tokens: dates", () => {
  const datesOf = (raw: string) => tokensOf(raw).tokens.dates.map((date) => [date.values, date.ambiguousSlash]);

  it("T-TOK-date-formats: reads each numeric format", () => {
    expect(datesOf("Kuupäev 15.03.2026")).toEqual([[["2026-03-15"], false]]);
    expect(datesOf("Kuupäev 5.3.2026")).toEqual([[["2026-03-05"], false]]);
    expect(datesOf("Kuupäev 15.03.26")).toEqual([[["2026-03-15"], false]]);
    expect(datesOf("Date 2026-03-15")).toEqual([[["2026-03-15"], false]]);
    expect(datesOf("Date 25/03/2026")).toEqual([[["2026-03-25"], false]]);
    expect(datesOf("Date 03/25/2026")).toEqual([[["2026-03-25"], false]]);
  });

  it("T-TOK-slash: `03/04/2026` is ambiguous_slash with both readings", () => {
    expect(datesOf("Date 03/04/2026")).toEqual([[["2026-04-03", "2026-03-04"], true]]);
    expect(datesOf("Date 04/04/2026")).toEqual([[["2026-04-04"], false]]);
  });

  it("T-TOK-months: reads Estonian and English textual months", () => {
    expect(datesOf("31. juuli 2026")).toEqual([[["2026-07-31"], false]]);
    expect(datesOf("14 August 2026")).toEqual([[["2026-08-14"], false]]);
    expect(datesOf("22nd February 2021")).toEqual([[["2021-02-22"], false]]);
    expect(datesOf("06 September, 2026")).toEqual([[["2026-09-06"], false]]);
    expect(datesOf("05 Jul 2026")).toEqual([[["2026-07-05"], false]]);
    expect(datesOf("July 20, 2026")).toEqual([[["2026-07-20"], false]]);
    expect(datesOf("3. märts 2026")).toEqual([[["2026-03-03"], false]]);
  });

  it("T-TOK-date-invalid: an impossible date is dropped", () => {
    expect(datesOf("Kuupäev 31.02.2026")).toEqual([]);
    expect(datesOf("Kuupäev 12 Foo 2026")).toEqual([]);
  });
});

describe("document-reading tokens: word tokens", () => {
  it("T-TOK-word: a delimiter joins alphanumerics, so `AB1.234` is one token", () => {
    expect(tokensOf("Arve AB1.234").tokens.wordTokens.map((token) => token.text)).toEqual(["Arve", "AB1.234"]);
    expect(tokensOf("INV-0042.Date x").tokens.wordTokens.map((token) => token.text)).toEqual(["INV-0042.Date", "x"]);
  });
});

describe("document-reading tokens: identifierScan / ibanScan", () => {
  const scan = (raw: string, mode: "strict" | "accounting") =>
    identifierScan(linesOf(raw), mode).map((hit) => [hit.kind, hit.values]);

  it("T-ID-grouped-vat: finds a grouped EE VAT in both modes", () => {
    expect(scan("KMKR EE 102 809 963", "strict")).toEqual([["ee_vat", ["EE102809963"]]]);
    expect(scan("KMKR EE 102 809 963", "accounting")).toEqual([["ee_vat", ["EE102809963"]]]);
  });

  it("T-ID-grouped-reg: finds a grouped registry code", () => {
    expect(scan("Reg 102 349 57", "strict")).toEqual([["ee_reg", ["10234957"]]]);
  });

  it("T-ID-foreign: finds a grouped foreign VAT", () => {
    expect(scan("USt-IdNr DE 123 456 789", "strict")).toEqual([["foreign_vat", ["DE123456789"]]]);
  });

  it("T-ID-phone: an 11-digit grouped phone is not a strict registry code", () => {
    expect(scan("Tel 102 349 57 123", "strict")).toEqual([]);
  });

  it("T-ID-bare9: a bare 9-digit run is never a VAT number", () => {
    expect(scan("Kood 102809963", "strict")).toEqual([]);
    expect(scan("Kood 102809963", "accounting")).toEqual([]);
  });

  it("T-ID-iban-bic: digits inside a validated IBAN or a BIC shape are excluded", () => {
    expect(scan("IBAN EE59 1000 0018 2345 6789", "accounting")).toEqual([]);
    expect(scan("IBAN EE591000001823456789", "accounting")).toEqual([]);
    expect(scan("BIC DEUTDEFF500", "accounting")).toEqual([]);
    // without the IBAN the same group sequence is a registry code
    expect(scan("Kood 1000 0018", "accounting")).toEqual([["ee_reg", ["10000018"]]]);
  });

  it("T-ID-strict-left / T-ID-strict-right: glued letters or connectors give no strict id", () => {
    expect(scan("KMKR XEE102809963", "strict")).toEqual([]);
    expect(scan("KMKR EE102809963A", "strict")).toEqual([]);
    expect(scan("Reg AB-10234957", "strict")).toEqual([]);
    expect(scan("KMKR EE1028099631", "strict")).toEqual([]);
  });

  it("T-ID-accounting-glued: the same glued forms are found in accounting mode", () => {
    expect(scan("KMKR XEE102809963", "accounting")).toEqual([["ee_vat", ["EE102809963"]]]);
    expect(scan("KMKR EE102809963A", "accounting")).toEqual([["ee_vat", ["EE102809963"]]]);
    expect(scan("Reg AB-10234957", "accounting")).toEqual([["ee_reg", ["10234957"]]]);
  });

  it("T-ID-subseq: `3 70449888` yields 70449888 in accounting mode and nothing in strict mode", () => {
    expect(scan("Kood 3 70449888", "accounting")).toEqual([["ee_reg", ["70449888"]]]);
    expect(scan("Kood 3 70449888", "strict")).toEqual([]);
  });

  it("T-ID-foreign-prefixes: accounting keeps every validating group prefix of a foreign VAT", () => {
    expect(scan("VAT DE 123 456 789", "accounting")).toEqual([["foreign_vat", ["DE123456", "DE123456789"]]]);
  });

  it("T-ID-label-not-prefix: a VAT label never glues onto the id as a foreign prefix", () => {
    expect(scan("VAT EE102809963", "accounting")).toEqual([["ee_vat", ["EE102809963"]]]);
    expect(scan("EU VAT IE4276970QH", "accounting")).toEqual([["foreign_vat", ["IE4276970QH"]]]);
    expect(scan("USt-IdNr DE 123 456 789 GMBH", "strict")).toEqual([["foreign_vat", ["DE123456789"]]]);
    expect(scan("XDE123456789", "accounting")).toEqual([["foreign_vat", ["DE123456789"]]]);
    expect(scan("ALV FI12345678", "accounting").filter(([kind]) => kind === "foreign_vat")).toEqual([["foreign_vat", ["FI12345678"]]]);
  });

  it("T-ID-foreign-glued-left: accounting finds a prefix glued to a non-label letter, strict does not", () => {
    expect(scan("XDE 123456789", "accounting")).toEqual([["foreign_vat", ["DE123456789"]]]);
    expect(scan("XDE 123456789", "strict")).toEqual([]);
  });

  it("T-ID-foreign-fr-key: a French alphanumeric key group is read in both modes", () => {
    expect(scan("VAT FR AB 123456789", "accounting")).toEqual([["foreign_vat", ["FRAB123456789"]]]);
    expect(scan("VAT FR AB 123456789", "strict")).toEqual([["foreign_vat", ["FRAB123456789"]]]);
    // only FR's first group may be letters: `DE AB 123456789` is not a German VAT
    expect(scan("Kood DE AB 123456789", "accounting")).toEqual([]);
  });

  it("T-ID-iban-scan: finds grouped and compact IBANs with strict boundaries", () => {
    expect(ibanScan(linesOf("IBAN EE38 2200 2210 2014 5685")).map((hit) => hit.value)).toEqual(["EE382200221020145685"]);
    expect(ibanScan(linesOf("IBAN EE382200221020145685")).map((hit) => hit.value)).toEqual(["EE382200221020145685"]);
    expect(ibanScan(linesOf("IBAN XEE382200221020145685"))).toEqual([]);
    expect(ibanScan(linesOf("IBAN EE38 2200 2210 2014 5684"))).toEqual([]);
  });
});

describe("document-reading tokens: document-level scanners", () => {
  it("T-TOK-credit: matches whole letter-token runs only", () => {
    const entries = ["credit note", "refund", "kreeditarve"];
    expect(creditWordHits(linesOf("CREDIT–NOTE 12"), entries)).toEqual(["credit note"]);
    expect(creditWordHits(linesOf("non-refundable", "kreeditarvele", "refunded"), entries)).toEqual([]);
  });

  it("T-TOK-currency: ISO codes, symbols, letter symbols and the EUR statement", () => {
    const lists = { isoCodes: ["SEK", "ALL", "USD"], wordLikeCodes: ["ALL"], letterSymbols: ["kr", "kr."] };
    expect(currencyScan(linesOf("Summa SEK"), lists).hits.map((hit) => hit.kind)).toEqual(["iso"]);
    expect(currencyScan(linesOf("ALL items included"), lists).hits).toEqual([]);
    expect(currencyScan(linesOf("Summa ALL 50,00"), lists).hits.map((hit) => hit.text)).toEqual(["ALL"]);
    expect(currencyScan(linesOf("Summa $ 5"), lists).hits.map((hit) => hit.text)).toEqual(["$"]);
    expect(currencyScan(linesOf("Att betala 1 250,00 kr"), lists).hits.map((hit) => hit.text)).toEqual(["kr"]);
    expect(currencyScan(linesOf("kr    1 250,00"), lists).hits).toEqual([]);
    expect(currencyScan(linesOf("Kokku 5,00"), lists).eurStated).toBe(false);
    expect(currencyScan(linesOf("Kokku 5,00 eurot"), lists).eurStated).toBe(true);
    expect(currencyScan(linesOf("x", "€"), lists).eurStated).toBe(true);
  });

  it("T-TOK-percent: percent tokens compare by value", () => {
    expect(percentTokens(linesOf("KM 24%", "KM 24 %", "KM 9,5 %", "100%")).map((token) => token.value)).toEqual([24, 24, 9.5]);
  });
});
