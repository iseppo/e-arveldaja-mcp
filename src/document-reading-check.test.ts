import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDIT_WORDS,
  FOREIGN_VAT_RATES,
  FOREIGN_VAT_RATES_SOURCE,
  FOREIGN_VAT_RATES_VERIFIED_AT,
  HEURISTIC_PICK_REPLACED_BY,
  HOLD_CODES,
  LOW_SIGNAL_PRODUCERS,
  READING_BOOKING_SIDE_SIGNALS,
  READING_HAZARD_SIGNALS,
  READING_HEURISTIC_PICK_SIGNALS,
  READING_SIGNAL_CLASS,
  READING_UNATTENDED_GATE_SIGNALS,
  type SignalName,
} from "./document-reading-check.js";
import { CREATION_GATING_EXTRACTION_SIGNALS } from "./invoice-extraction-fallback.js";
import { detectReverseChargeFromText } from "./tools/receipt-extraction.js";
import { BASE_LINES, holdCodes, holdKeys, runCase, type CaseInput } from "./__fixtures__/document-reading/invoice.js";

const withLines = (edits: Record<number, string>, extra: string[] = []) =>
  [...BASE_LINES.map((line, index) => edits[index + 1] ?? line), ...extra];

const expectAccept = (input: CaseInput = {}) => {
  const result = runCase(input);
  expect(holdKeys(result)).toEqual([]);
  expect(result.verdict).toBe("accept");
  return result;
};
const keysOf = (input: CaseInput) => holdKeys(runCase(input));
const codesOf = (input: CaseInput) => holdCodes(runCase(input));

describe("checkReading: base case", () => {
  it("T-CK-base: the clean synthetic invoice is accepted with its values", () => {
    const result = expectAccept();
    expect(result.accepted).toMatchObject({ invoice_number: "A-17", gross: 124, net: 100, vat: 24, currency: "EUR" });
    expect(result.vat_zero_note_proven).toBe(false);
  });

  it("T-CK-schema-stop: a schema failure holds and stops", () => {
    const result = runCase({ extra: { notes: "x" } });
    expect(holdCodes(result)).toEqual(["reading_schema_invalid"]);
    expect(holdCodes(runCase({ answers: { gross: { verdict: "maybe" } } }))).toEqual(["proof_schema_invalid"]);
  });

  it("T-CK-packet-holds: packet holds are taken over", () => {
    expect(codesOf({ pageMeta: { fullPageImage: true } })).toContain("ocr_document");
  });
});

describe("checkReading: H1/H2 per field", () => {
  it("T-H1-other-line: a quote printed on another line holds quote_not_printed", () => {
    expect(keysOf({ evidence: { gross: { line: "p1:006", quote: "Kokku EUR 124,00" } } })).toContain("quote_not_printed:gross");
    expect(keysOf({ evidence: { gross: undefined } })).toContain("missing_evidence:gross");
    expect(keysOf({ evidence: { gross: { line: "p1:099", quote: "Kokku" } } })).toContain("unknown_line:gross");
  });

  it("T-H2-cut-quote: the cut-short quote `EE102809963` on `KMKR EE1028099631` holds", () => {
    const keys = keysOf({
      lines: withLines({ 2: "Reg. nr 10000018    KMKR EE1028099631" }),
      values: { supplier_vat: "EE102809963" },
      evidence: { supplier_vat: { line: "p1:002", quote: "EE102809963" } },
    });
    expect(keys).toContain("value_not_complete_token:supplier_vat");
  });

  it("T-H2-cut-number: `AB1` on a line `AB1.234` and `INV 2024` from `INV 2024 001` hold", () => {
    expect(keysOf({
      lines: withLines({ 1: "Näidis OÜ    Arve nr AB1.234" }),
      values: { invoice_number: "AB1" },
      evidence: { invoice_number: { line: "p1:001", quote: "AB1" } },
    })).toContain("value_not_complete_token:invoice_number");
    expect(keysOf({
      lines: withLines({ 1: "Näidis OÜ    Arve nr INV 2024 001" }),
      values: { invoice_number: "INV 2024" },
      evidence: { invoice_number: { line: "p1:001", quote: "INV 2024" } },
    })).toContain("value_not_complete_token:invoice_number");
  });

  it("T-H2-spaced-number: a spaced number bounded by a separator passes", () => {
    expectAccept({
      lines: withLines({ 1: "Näidis OÜ    Arve nr: INV 2024" }),
      values: { invoice_number: "INV 2024" },
      evidence: { invoice_number: { line: "p1:001", quote: "Arve nr: INV 2024" } },
    });
  });

  it("T-H2-amount-cut: amount quote `1 234,56` on a line `21 234,56` holds", () => {
    expect(keysOf({
      lines: withLines({}, ["Muu 21 234,56"]),
      values: { gross: 1234.56 },
      evidence: { gross: { line: "p1:008", quote: "1 234,56" } },
    })).toContain("value_not_complete_token:gross");
  });

  it("T-H2-name-subrun: a name sub-run `Telia Eesti` of a cell `Telia Eesti AS` holds", () => {
    expect(keysOf({
      lines: withLines({ 1: "Telia Eesti AS    Arve nr A-17" }),
      values: { supplier_name: "Telia Eesti" },
      evidence: { supplier_name: { line: "p1:001", quote: "Telia Eesti" } },
    })).toContain("value_not_complete_token:supplier_name");
  });

  it("T-H2-comma-name: `Anthropic, PBC` and `OpenAI OpCo, LLC` pass as whole names", () => {
    for (const name of ["Anthropic, PBC", "OpenAI OpCo, LLC"]) {
      expectAccept({
        lines: withLines({ 1: `${name}    Arve nr A-17` }),
        values: { supplier_name: name },
        evidence: { supplier_name: { line: "p1:001", quote: name } },
      });
    }
  });

  it("T-H2-separator-name: `Tele2 Eesti AS` from `Tele2 Eesti AS: Reg. nr …` passes; without a separator it holds", () => {
    expectAccept({
      lines: withLines({ 1: "Tele2 Eesti AS: Reg. nr 10000018    Arve nr A-17", 2: "KMKR EE100000007" }),
      values: { supplier_name: "Tele2 Eesti AS" },
      evidence: {
        supplier_name: { line: "p1:001", quote: "Tele2 Eesti AS" },
        supplier_reg: { line: "p1:001", quote: "Reg. nr 10000018" },
        supplier_vat: { line: "p1:002", quote: "KMKR EE100000007" },
      },
    });
    expect(keysOf({
      lines: withLines({ 1: "Tele2 Eesti AS Reg. nr 10000018    Arve nr A-17", 2: "KMKR EE100000007" }),
      values: { supplier_name: "Tele2 Eesti AS" },
      evidence: {
        supplier_name: { line: "p1:001", quote: "Tele2 Eesti AS" },
        supplier_reg: { line: "p1:001", quote: "Reg. nr 10000018" },
        supplier_vat: { line: "p1:002", quote: "KMKR EE100000007" },
      },
    })).toContain("value_not_complete_token:supplier_name");
  });

  it("T-H2-iban: a grouped IBAN passes", () => {
    expectAccept({
      lines: withLines({}, ["IBAN EE59 1000 0018 2345 6789"]),
      values: { supplier_iban: "EE591000001823456789" },
      evidence: { supplier_iban: { line: "p1:008", quote: "IBAN EE59 1000 0018 2345 6789" } },
    });
  });

  it("T-H2-ambiguous-amount: an ambiguous amount and a whole-cell join hold ambiguous_amount_token", () => {
    expect(keysOf({
      lines: withLines({}, ["Muu 6,000"]),
      values: { gross: 6000 },
      evidence: { gross: { line: "p1:008", quote: "6,000" } },
    })).toContain("ambiguous_amount_token:gross");
    expect(keysOf({
      lines: withLines({}, ["Kokku    3 082,64"]),
      values: { gross: 3082.64 },
      evidence: { gross: { line: "p1:008", quote: "3 082,64" } },
    })).toContain("ambiguous_amount_token:gross");
  });

  it("T-H2-slash: an ambiguous slash date holds ambiguous_slash_date", () => {
    expect(keysOf({
      lines: withLines({ 4: "Date 03/04/2026" }),
      values: { invoice_date: "2026-04-03" },
      evidence: { invoice_date: { line: "p1:004", quote: "Date 03/04/2026" } },
    })).toContain("ambiguous_slash_date:invoice_date");
  });

  it("T-H2-currency: a non-EUR currency is not a complete token", () => {
    expect(keysOf({ values: { currency: "USD" } })).toContain("value_not_complete_token:currency");
  });
});

describe("checkReading: H3, required, strong id", () => {
  it("T-H3-doctype: any computed entry, incl. doc_type, holds computed_field", () => {
    expect(codesOf({ extra: { computed: ["doc_type"] } })).toEqual(["computed_field"]);
  });

  it("T-REQ-missing: each required field missing holds required_field_missing", () => {
    for (const field of ["invoice_number", "invoice_date", "currency", "gross"]) {
      expect(keysOf({ values: { [field]: null } }), field).toContain(`required_field_missing:${field}`);
    }
  });

  it("T-REQ-strong-id: no supplier reg and no VAT holds supplier_id_missing", () => {
    expect(codesOf({ values: { supplier_reg: null, supplier_vat: null } })).toContain("supplier_id_missing");
  });
});

describe("checkReading: H5 arithmetic", () => {
  const ZERO_LINES = ["Näidis OÜ    Arve nr A-17", "Reg. nr 10000018    KMKR EE100000007", "Ostja: Ostja AS    Reg. nr 10000024",
    "Kuupäev 15.03.2026", "Summa 100,00", "KM 0,00", "Kokku EUR 100,00"];
  const zero = (lines: string[], ctx?: CaseInput["ctx"]) => runCase({
    lines,
    values: { net: 100, vat: 0, gross: 100 },
    evidence: {
      net: { line: "p1:005", quote: "Summa 100,00" },
      vat: { line: "p1:006", quote: lines[5]! },
      gross: { line: "p1:007", quote: "Kokku EUR 100,00" },
      currency: { line: "p1:007", quote: "Kokku EUR 100,00" },
    },
    ctx,
  });

  it("T-H5-sum: a sum off by 0.02 holds arithmetic_mismatch", () => {
    expect(codesOf({ values: { gross: 124.02 }, lines: withLines({ 7: "Kokku EUR 124,02" }) })).toContain("arithmetic_mismatch");
  });

  it("T-H5-vat0: VAT 0 needs a printed 0% or the reverse-charge note", () => {
    expect(holdKeys(zero(ZERO_LINES))).toContain("zero_vat_unproven:vat");
    const withPercent = zero(ZERO_LINES.map((line, i) => (i === 5 ? "KM 0% 0,00" : line)));
    expect(holdKeys(withPercent)).toEqual([]);
    expect(withPercent.vat_zero_note_proven).toBe(true);
    const withNote = zero([...ZERO_LINES, "Reverse charge"], { isReverseChargeText: detectReverseChargeFromText });
    expect(holdKeys(withNote)).toEqual([]);
    expect(withNote.vat_zero_note_proven).toBe(true);
    expect(withNote.reverse_charge_note_present).toBe(true);
  });
});

describe("checkReading: H6 rate", () => {
  const rateCase = (date: string, printed: string, vat: number, gross: number, today: string, net: number | null = 100) => keysOf({
    lines: withLines({ 4: `Kuupäev ${printed}`, 6: `KM ${vat},00`, 7: `Kokku EUR ${gross},00` }),
    values: { invoice_date: date, vat, gross, net },
    evidence: { vat: { line: "p1:006", quote: `KM ${vat},00` }, gross: { line: "p1:007", quote: `Kokku EUR ${gross},00` }, ...(net === null ? { net: undefined } : {}) },
    ctx: { today },
  });

  it("T-H6-2026: 24% snaps on 2026-07-01 and 22% holds", () => {
    expect(rateCase("2026-07-01", "01.07.2026", 24, 124, "2026-08-01")).not.toContain("vat_rate_not_snapped:vat");
    expect(rateCase("2026-07-01", "01.07.2026", 22, 122, "2026-08-01")).toContain("vat_rate_not_snapped:vat");
  });

  it("T-H6-2024: 22% snaps on 2024-03-01", () => {
    expect(rateCase("2024-03-01", "01.03.2024", 22, 122, "2025-08-01")).not.toContain("vat_rate_not_snapped:vat");
  });

  it("T-H6-net-null: with net null the base is gross − VAT", () => {
    expect(rateCase("2026-03-15", "15.03.2026", 24, 124, "2026-04-01", null)).not.toContain("vat_rate_not_snapped:vat");
    expect(rateCase("2026-03-15", "15.03.2026", 22, 122, "2026-04-01", null)).toContain("vat_rate_not_snapped:vat");
  });
});

describe("checkReading: H7 identifiers", () => {
  it("T-H7-each: each validator negative holds identifier_invalid", () => {
    expect(keysOf({ values: { supplier_reg: "10000019" } })).toContain("identifier_invalid:supplier_reg");
    expect(keysOf({ values: { supplier_vat: "EE100000008" } })).toContain("identifier_invalid:supplier_vat");
    expect(keysOf({ values: { supplier_vat: "QQ12345678" } })).toContain("identifier_invalid:supplier_vat");
  });

  it("T-H7-iban: an invalid IBAN holds identifier_invalid", () => {
    expect(keysOf({
      lines: withLines({}, ["IBAN EE59 1000 0018 2345 6788"]),
      values: { supplier_iban: "EE591000001823456788" },
      evidence: { supplier_iban: { line: "p1:008", quote: "IBAN EE59 1000 0018 2345 6788" } },
    })).toContain("identifier_invalid:supplier_iban");
  });
});

describe("checkReading: H8 parties", () => {
  it("T-H8-buyer: an invoice needs an own buyer id", () => {
    expect(codesOf({ values: { buyer_reg: null } })).toContain("buyer_id_missing");
    expect(codesOf({ values: { buyer_reg: null }, extra: { doc_type: "receipt" } })).not.toContain("buyer_id_missing");
    expect(codesOf({ ctx: { own: { reg: "10000030" } } })).toContain("buyer_not_own");
  });

  it("T-H8-own: own identity unavailable holds own_identity_unavailable", () => {
    expect(codesOf({ ctx: { own: "unavailable" } })).toContain("own_identity_unavailable");
    expect(codesOf({ ctx: { own: {} } })).toContain("own_identity_unavailable");
  });

  it("T-H8-self: a supplier id equal to an own id holds supplier_is_own", () => {
    expect(codesOf({ ctx: { own: { reg: "10000018" } } })).toContain("supplier_is_own");
  });

  it("T-H8-third-party: an unaccounted grouped third-party VAT holds unaccounted_identifier", () => {
    expect(codesOf({ lines: withLines({}, ["Projektpartner: Kolmas OÜ    EE 100 000 023"]) })).toContain("unaccounted_identifier");
  });

  it("T-H8-iban-bic: IBAN and BIC lines account nothing", () => {
    expectAccept({ lines: withLines({}, ["IBAN EE59 1000 0018 2345 6789    BIC DEUTDEFF500"]) });
  });

  it("T-H8-r4M2: a third party's bare registry code cited as invoice_number on a receipt holds unaccounted_identifier", () => {
    const codes = codesOf({
      lines: withLines({ 1: "Näidis OÜ    Arve nr 10000030" }),
      values: { invoice_number: "10000030", buyer_reg: null, buyer_name: null },
      evidence: { invoice_number: { line: "p1:001", quote: "Arve nr 10000030" } },
      extra: { doc_type: "receipt" },
    });
    expect(codes).toContain("unaccounted_identifier");
  });
});

describe("checkReading: H9 number is not an id", () => {
  it("T-H9-case: a number equal to a printed EE VAT in another case holds", () => {
    expect(keysOf({
      lines: withLines({ 1: "Näidis OÜ    Arve nr ee100000007" }),
      values: { invoice_number: "ee100000007" },
      evidence: { invoice_number: { line: "p1:001", quote: "Arve nr ee100000007" } },
    })).toContain("invoice_number_is_identifier:invoice_number");
  });

  it("T-H9-reg: a number that is itself a valid registry code holds", () => {
    expect(keysOf({
      lines: withLines({ 1: "Näidis OÜ    Arve nr 10000030" }),
      values: { invoice_number: "10000030" },
      evidence: { invoice_number: { line: "p1:001", quote: "Arve nr 10000030" } },
    })).toContain("invoice_number_is_identifier:invoice_number");
  });

  it("T-H9-ordinary: an ordinary number passes", () => {
    expect(keysOf({})).not.toContain("invoice_number_is_identifier:invoice_number");
  });
});

describe("checkReading: H10 date window", () => {
  const dated = (date: string, printed: string) => keysOf({
    lines: withLines({ 4: `Kuupäev ${printed}` }),
    values: { invoice_date: date },
    evidence: { invoice_date: { line: "p1:004", quote: `Kuupäev ${printed}` } },
  });

  it("T-H10-future: tomorrow holds", () => {
    expect(dated("2026-04-02", "02.04.2026")).toContain("invoice_date_out_of_window:invoice_date");
  });

  it("T-H10-prevyear: 1 January of the previous year passes, 31 December two years back holds", () => {
    expect(dated("2025-01-01", "01.01.2025")).not.toContain("invoice_date_out_of_window:invoice_date");
    expect(dated("2024-12-31", "31.12.2024")).toContain("invoice_date_out_of_window:invoice_date");
  });
});

describe("checkReading: A1 competitor completeness", () => {
  it("T-A1-omitted: a larger value not cited as a gross competitor holds", () => {
    expect(keysOf({ lines: withLines({}, ["Ettemaks 200,00"]) })).toContain("competitor_omitted:gross");
  });

  it("T-A1-two-amount: a two-amount line quote covers both values", () => {
    expectAccept({
      lines: withLines({}, ["Ettemaks 200,00    Jääk 300,00"]),
      answers: { gross: { label_quote: "Kokku", competitors: [{ line: "p1:008", quote: "Ettemaks 200,00 ¦ Jääk 300,00" }], why_this_one: "", verdict: "confirm" } },
    });
  });

  it("T-A1-ambig: an ambiguous token covers all its readings", () => {
    expectAccept({
      lines: withLines({}, ["Kogus 6,000"]),
      answers: { gross: { label_quote: "Kokku", competitors: [{ line: "p1:008", quote: "6,000" }], why_this_one: "", verdict: "confirm" } },
    });
  });

  it("T-A1-limit: more than 32 larger values holds competitor_limit_exceeded", () => {
    const extra = Array.from({ length: 33 }, (_, i) => `Rida ${200 + i},00`);
    expect(keysOf({ lines: withLines({}, extra) })).toContain("competitor_limit_exceeded:gross");
  });

  it("T-A1-cut: a competitor quote cut mid-token does not cover", () => {
    expect(keysOf({
      lines: withLines({}, ["Ettemaks 200,00"]),
      answers: { gross: { label_quote: "Kokku", competitors: [{ line: "p1:008", quote: "Ettemaks 200,0" }], why_this_one: "", verdict: "confirm" } },
    })).toContain("competitor_omitted:gross");
  });
});

describe("checkReading: A2 competing trio", () => {
  const CONTRACT = ["Lepingu maksumus 1000,00", "Lepingu KM 240,00", "Lepingu kokku 1240,00"];

  it("T-A2-forward: a contract trio next to the accepted invoice trio holds", () => {
    expect(codesOf({ lines: withLines({}, CONTRACT) })).toContain("competing_consistent_total");
  });

  it("T-A2-reverse: accepting the contract trio holds because of the invoice trio", () => {
    expect(codesOf({
      lines: withLines({}, CONTRACT),
      values: { net: 1000, vat: 240, gross: 1240 },
      evidence: {
        net: { line: "p1:008", quote: "Lepingu maksumus 1000,00" },
        vat: { line: "p1:009", quote: "Lepingu KM 240,00" },
        gross: { line: "p1:010", quote: "Lepingu kokku 1240,00" },
      },
      labels: { gross: "Lepingu kokku" },
    })).toContain("competing_consistent_total");
  });

  it("T-A2-repeat: a repeated identical trio passes", () => {
    expectAccept({ lines: withLines({}, ["Neto 100,00", "Käibemaks 24,00", "Tasuda 124,00"]) });
  });
});

describe("checkReading: A3 mixed rate", () => {
  it("T-A3-two-rates: 9% and 24% lines hold", () => {
    expect(codesOf({ lines: withLines({}, ["KM 9% 0,90"]) })).toContain("mixed_vat_rate");
  });

  it("T-A3-lines: `KM 10% 1,00` / `KM 20% 2,00` / `Kokku EUR 20,00` holds", () => {
    expect(codesOf({ lines: withLines({}, ["KM 10% 1,00", "KM 20% 2,00", "Kokku EUR 20,00"]) })).toContain("mixed_vat_rate");
  });

  it("T-A3-header: the header layout `KM 10% ¦ KM 20%` / `1,00 ¦ 2,00` holds", () => {
    expect(codesOf({ lines: withLines({}, ["KM 10%    KM 20%", "1,00    2,00", "Kokku EUR 20,00"]) })).toContain("mixed_vat_rate");
  });

  it("T-A3-value-eq: `24%` and `24 %` alone do not hold", () => {
    expectAccept({ lines: withLines({}, ["Käibemaks 24 %"]) });
  });

  it("T-A3-disjoint: a small trio matching both 23% and 24% does not count as two rates", () => {
    expect(codesOf({ lines: withLines({}, ["Pakend 2,02", "Pakendi KM 0,48", "Pakend kokku 2,50"]) })).not.toContain("mixed_vat_rate");
  });
});

describe("checkReading: A4 trio required", () => {
  const grossOnly = (lines: string[], gross: number, quote: string, line: string) => codesOf({
    lines,
    values: { net: null, vat: null, gross },
    evidence: { net: undefined, vat: undefined, gross: { line, quote } },
  });

  it("T-A4-vertical: a gross-only reading of a (vertical) trio document holds", () => {
    expect(grossOnly(BASE_LINES, 124, "Kokku EUR 124,00", "p1:007")).toContain("trio_not_read");
  });

  it("T-A4-no-trio: a gross-only reading without a trio passes", () => {
    const lines = withLines({ 5: "Teenus", 6: "Märkus" });
    expect(grossOnly(lines, 124, "Kokku EUR 124,00", "p1:007")).toEqual([]);
  });

  it("T-A4-eur5: `EUR 5` / `1,20` / `6,20` / `10,00` with a gross-only 10 holds", () => {
    const lines = withLines({ 5: "Teenus EUR 5", 6: "KM 24% 1,20", 7: "Vahesumma 6,20" }, ["Tasuda EUR 10,00"]);
    expect(grossOnly(lines, 10, "Tasuda EUR 10,00", "p1:008")).toContain("trio_not_read");
  });
});

describe("checkReading: A5 signed amount", () => {
  it("T-A5-endash: each signed form holds, incl. the en dash", () => {
    for (const line of ["Allahindlus -26,00", "Allahindlus – 26,00", "Allahindlus 26,00-", "Allahindlus (26,00)", "Allahindlus −26,00"]) {
      expect(codesOf({ lines: withLines({}, [line]) }), line).toContain("signed_amount_present");
    }
  });
});

describe("checkReading: foreign-rate trio", () => {
  it("T-FT-swedish: a 25% trio without an EE rate holds", () => {
    expect(codesOf({ lines: withLines({}, ["Netto 1 000,00", "Moms 250,00", "Att betala 1 250,00"]) })).toContain("foreign_rate_trio");
  });

  it("T-FT-multi-rate: a trio matching 25 and 25.5 but no EE rate holds", () => {
    expect(codesOf({ lines: withLines({}, ["Osa 4,00", "Osa KM 1,01", "Osa kokku 5,01"]) })).toContain("foreign_rate_trio");
  });

  it("T-FT-small-ee: a small trio matching EE 24% does not hold", () => {
    expect(codesOf({ lines: withLines({}, ["Pakend 2,02", "Pakendi KM 0,48", "Pakend kokku 2,50"]) })).not.toContain("foreign_rate_trio");
  });

  it("T-FT-line-sum: `10 + 14 = 24` is not a trio", () => {
    expect(codesOf({ lines: withLines({}, ["Rida 10,00", "Rida 14,00", "Rida 24,00"]) })).not.toContain("foreign_rate_trio");
  });
});

describe("checkReading: document-level holds", () => {
  it("T-DT-bookable: doc_type other than invoice/receipt holds", () => {
    for (const docType of ["credit_note", "multiple_documents", "other"]) {
      expect(codesOf({ extra: { doc_type: docType } })).toContain("doc_type_not_bookable");
    }
  });

  it("T-CR-entries: every credit entry holds, in any casing and with a dash variant", () => {
    for (const entry of CREDIT_WORDS) {
      expect(codesOf({ lines: withLines({}, [entry.toUpperCase()]) }), entry).toContain("credit_word_present");
    }
    expect(codesOf({ lines: withLines({}, ["Credit–Note"]) })).toContain("credit_word_present");
  });

  it("T-CR-nonrefundable: `non-refundable`, `kreeditarvele` and `refunded` do not hold", () => {
    expectAccept({ lines: withLines({}, ["Ticket non-refundable", "Viide kreeditarvele", "Amount refunded"]) });
  });

  it("T-CU-codes: SEK, ALL next to money and `kr` next to money hold; ALL alone does not", () => {
    expect(codesOf({ lines: withLines({}, ["Summa SEK"]) })).toContain("foreign_currency_marker");
    expect(codesOf({ lines: withLines({}, ["ALL items included"]) })).not.toContain("foreign_currency_marker");
    expect(codesOf({ lines: withLines({}, ["Hind ALL 50,00"]) })).toContain("foreign_currency_marker");
    expect(codesOf({ lines: withLines({}, ["Att betala 50,00 kr"]) })).toContain("foreign_currency_marker");
    expect(keysOf({ values: { currency: "SEK" } })).toContain("non_eur_currency:currency");
  });

  it("T-CU-dollar: any currency symbol other than € holds", () => {
    expect(codesOf({ lines: withLines({}, ["Paid with $ card"]) })).toContain("foreign_currency_marker");
    expect(codesOf({ lines: withLines({}, ["Hind £"]) })).toContain("foreign_currency_marker");
  });

  it("T-CU-not-stated: no EUR/€ token anywhere holds currency_not_stated; € anywhere states it", () => {
    const lines = withLines({ 7: "Kokku 124,00" });
    expect(codesOf({ lines, values: { currency: null }, evidence: { currency: undefined, gross: { line: "p1:007", quote: "Kokku 124,00" } } }))
      .toContain("currency_not_stated");
    expect(codesOf({ lines: [...lines, "Hinnad €"], values: { currency: null }, evidence: { currency: undefined, gross: { line: "p1:007", quote: "Kokku 124,00" } } }))
      .not.toContain("currency_not_stated");
  });
});

describe("checkReading: heuristic signals", () => {
  it("T-SIG-hazard: a hazard signal holds with its own name; picks and unattended gates do not", () => {
    const heuristic = (signals: string[]) => ({ heuristic: { signals, confidence: "low" as const, labelled: {} } });
    expect(holdCodes(runCase({ ctx: heuristic(["zero_total_stated", "raw_text_missing"]) }))).toEqual(["zero_total_stated", "raw_text_missing"]);
    expect(holdCodes(runCase({ ctx: heuristic(["gross_unlabelled", "confidence_low", "improbable_fixed_asset", "vat_rate_implausible"]) }))).toEqual([]);
  });
});

describe("signal classes (§1.4)", () => {
  const fallbackSource = readFileSync(join(process.cwd(), "src/invoice-extraction-fallback.ts"), "utf8");
  const inboxSource = readFileSync(join(process.cwd(), "src/tools/receipt-inbox.ts"), "utf8");
  const pushedLiterals = (source: string, list: string) =>
    [...source.matchAll(new RegExp(`${list}\\.push\\(\\s*"([a-z_]+)"\\s*\\)`, "g"))].map((m) => m[1]!);
  const gateFn = inboxSource.slice(inboxSource.indexOf("export function shouldGateCreation"), inboxSource.indexOf("export function shouldGateCreation") + 4000);
  const gateLiterals = [...gateFn.matchAll(/confidence_signals\.includes\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);

  const classed = (signal: string) => (READING_SIGNAL_CLASS as Record<string, string>)[signal];
  const replaced = (signal: string) => {
    const codes = HEURISTIC_PICK_REPLACED_BY[signal as SignalName];
    return codes !== undefined && codes.every((code) => code in HOLD_CODES);
  };

  it("T-SIG-source-parse: LOW_SIGNAL_PRODUCERS equals the lowSignals.push literals of the source", () => {
    expect(new Set(pushedLiterals(fallbackSource, "lowSignals"))).toEqual(new Set(LOW_SIGNAL_PRODUCERS));
    expect(gateLiterals.length).toBeGreaterThanOrEqual(5);
  });

  it("T-SIG-gated: every signal that gates in every mode is hazard, booking_side or a replaced heuristic pick", () => {
    const gated = new Set<string>([...CREATION_GATING_EXTRACTION_SIGNALS, ...gateLiterals, ...LOW_SIGNAL_PRODUCERS, "confidence_low"]);
    for (const signal of gated) {
      const cls = classed(signal);
      const ok = cls === "hazard" || cls === "booking_side" || (cls === "heuristic_pick" && replaced(signal));
      expect(ok, `${signal} (${cls})`).toBe(true);
    }
    for (const pick of READING_HEURISTIC_PICK_SIGNALS) {
      if (pick !== "confidence_low") expect(HEURISTIC_PICK_REPLACED_BY[pick]?.length, pick).toBeGreaterThan(0);
    }
    expect(classed("duplicate_invoice_in_batch")).toBe("hazard");
  });

  it("T-SIG-confirm-gated: every signal that gates only in create_and_confirm is unattended_gate or stronger", () => {
    const confirmGated = new Set<string>([...pushedLiterals(fallbackSource, "mediumSignals"), ...CREATION_GATING_EXTRACTION_SIGNALS, "booking_from_history"]);
    for (const signal of confirmGated) {
      const cls = classed(signal);
      const ok = cls === "unattended_gate" || cls === "hazard" || cls === "booking_side" || (cls === "heuristic_pick" && replaced(signal));
      expect(ok, `${signal} (${cls})`).toBe(true);
    }
  });

  it("T-SIG-disjoint: the four derived lists are disjoint and cover the map", () => {
    const all = [...READING_HAZARD_SIGNALS, ...READING_HEURISTIC_PICK_SIGNALS, ...READING_BOOKING_SIDE_SIGNALS, ...READING_UNATTENDED_GATE_SIGNALS];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(Object.keys(READING_SIGNAL_CLASS).length);
    expect(READING_HAZARD_SIGNALS).toHaveLength(15);
    for (const hazard of READING_HAZARD_SIGNALS) expect(hazard in HOLD_CODES, hazard).toBe(true);
    expect("supplier_ambiguous" in READING_SIGNAL_CLASS).toBe(false);
  });
});

describe("FOREIGN_VAT_RATES", () => {
  it("T-FVR-pinned: pins spot values and the verification stamp", () => {
    expect(FOREIGN_VAT_RATES).toContain(25);
    expect(FOREIGN_VAT_RATES).toContain(25.5);
    expect(FOREIGN_VAT_RATES).toContain(8.1);
    expect(FOREIGN_VAT_RATES).not.toContain(0);
    expect(FOREIGN_VAT_RATES_VERIFIED_AT).toBe("2026-10-17");
    expect(FOREIGN_VAT_RATES_SOURCE).toContain("europa.eu");
  });
});

describe("reverseChargeText (T-RC-text)", () => {
  const note = (lines: string[]) => runCase({ lines: withLines({}, lines), ctx: { isReverseChargeText: detectReverseChargeFromText } }).reverse_charge_note_present;

  it("T-RC-text: whole-text detection across lines, line-bounded negation, column marks", () => {
    expect(note(["VAT to be paid by the", "recipient"])).toBe(true);
    expect(note(["Not subject to reverse charge"])).toBe(false);
    expect(note(["Reverse    charge"])).toBe(true);
    expect(note(["Reverse charge", "Not applicable fees: none"])).toBe(true);
    expect(note(["Teenus"])).toBe(false);
  });
});

describe("§3.3 walk-throughs (k)", () => {
  it("T-WT-debt: a gross-only 174 over a printed 100/24/124 trio holds trio_not_read", () => {
    const lines = withLines({ 5: "Summa 100,00", 6: "sh KM 24% 24,00", 7: "Kokku EUR 124,00" }, ["võlg 50,00", "Tasuda 174,00"]);
    expect(codesOf({ lines, values: { net: null, vat: null, gross: 174 }, evidence: { net: undefined, vat: undefined, gross: { line: "p1:009", quote: "Tasuda 174,00" } } }))
      .toContain("trio_not_read");
  });

  it("T-WT-discount: a pre-discount trio with `Allahindlus -26,00` holds signed_amount_present", () => {
    expect(codesOf({ lines: withLines({}, ["Allahindlus -26,00"]) })).toContain("signed_amount_present");
  });

  it("T-WT-contract: a contract trio holds competing_consistent_total", () => {
    expect(codesOf({ lines: withLines({}, ["Leping 1000,00", "Lepingu KM 240,00", "Leping kokku 1240,00"]) })).toContain("competing_consistent_total");
  });

  it("T-WT-swedish: `Moms 25% 250,00` / `Att betala 1 250,00 kr` read as EUR 1250 holds three ways", () => {
    const lines = ["Butik AB    Kvitto nr A-17", "Reg. nr 10000018    KMKR EE100000007", "Ostja: Ostja AS    Reg. nr 10000024",
      "Kuupäev 15.03.2026", "Netto 1 000,00", "Moms 25% 250,00", "Att betala 1 250,00 kr"];
    const codes = codesOf({
      lines,
      values: { supplier_name: "Butik AB", net: 1000, vat: 250, gross: 1250, currency: "EUR" },
      evidence: {
        supplier_name: { line: "p1:001", quote: "Butik AB" },
        invoice_number: { line: "p1:001", quote: "Kvitto nr A-17" },
        net: { line: "p1:005", quote: "Netto 1 000,00" },
        vat: { line: "p1:006", quote: "Moms 25% 250,00" },
        gross: { line: "p1:007", quote: "Att betala 1 250,00 kr" },
        currency: { line: "p1:007", quote: "Att betala 1 250,00 kr" },
      },
    });
    expect(codes).toEqual(expect.arrayContaining(["currency_not_stated", "foreign_currency_marker", "foreign_rate_trio"]));
  });

  it("T-WT-unsigned-discount: the unsigned discount 124 reading is accepted (asserted residual)", () => {
    expectAccept({
      lines: withLines({}, ["Hind enne allahindlust 130,00", "Allahindlus 6,00"]),
      answers: { gross: { label_quote: "Kokku", competitors: [{ line: "p1:008", quote: "130,00" }], why_this_one: "", verdict: "confirm" } },
    });
  });
});
