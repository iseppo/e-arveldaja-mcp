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
  PROOF_QUESTIONS,
  JSON_OUTPUT_FORMAT,
  READING_INSTRUCTIONS,
  READING_BOOKING_SIDE_SIGNALS,
  READING_HAZARD_SIGNALS,
  READING_HEURISTIC_PICK_SIGNALS,
  READING_SIGNAL_CLASS,
  READING_UNATTENDED_GATE_SIGNALS,
  checkReading,
  labelledHeuristicValues,
  uniqueClosingTrio,
  type SignalName,
} from "./document-reading-check.js";
import { READING_FIELDS } from "./document-reading-schemas.js";
import { CREATION_GATING_EXTRACTION_SIGNALS } from "./invoice-extraction-fallback.js";
import { detectReverseChargeFromText, extractReceiptFieldsFromText } from "./tools/receipt-extraction.js";
import { BASE_LINES, buildCase, holdCodes, holdKeys, runCase, type CaseInput } from "./__fixtures__/document-reading/invoice.js";
import { N1_CASES, N2_CASES, N3_PINS, type NarrowingCase } from "./__fixtures__/document-reading/narrowings.js";

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
      lines: withLines({}, ["IBAN EE86 1000 0018 2345 6788"]),
      values: { supplier_iban: "EE861000001823456788" },
      evidence: { supplier_iban: { line: "p1:008", quote: "IBAN EE86 1000 0018 2345 6788" } },
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
  // Every quote is the line it cites, so a positive case is a full acceptance (Codex P1 MINOR).
  const rateCase = (date: string, printed: string, vat: number, gross: number, today: string, net: number | null = 100) => keysOf({
    // with net null the net line is not printed either, so A4 sees no trio
    lines: withLines({ 4: `Kuupäev ${printed}`, ...(net === null ? { 5: "Teenus" } : {}), 6: `KM ${vat},00`, 7: `Kokku EUR ${gross},00` } as Record<number, string>),
    values: { invoice_date: date, vat, gross, net },
    evidence: {
      invoice_date: { line: "p1:004", quote: `Kuupäev ${printed}` },
      vat: { line: "p1:006", quote: `KM ${vat},00` },
      currency: { line: "p1:007", quote: `Kokku EUR ${gross},00` },
      gross: { line: "p1:007", quote: `Kokku EUR ${gross},00` },
      ...(net === null ? { net: undefined } : {}),
    },
    ctx: { today },
  });
  const snapped: string[] = [];

  it("T-H6-2026: 24% snaps on 2026-07-01 and 22% holds", () => {
    expect(rateCase("2026-07-01", "01.07.2026", 24, 124, "2026-08-01")).toEqual(snapped);
    expect(rateCase("2026-07-01", "01.07.2026", 22, 122, "2026-08-01")).toContain("vat_rate_not_snapped:vat");
  });

  it("T-H6-2024: 22% snaps on 2024-03-01", () => {
    expect(rateCase("2024-03-01", "01.03.2024", 22, 122, "2025-08-01")).toEqual(snapped);
  });

  it("T-H6-net-null: with net null the base is gross − VAT", () => {
    expect(rateCase("2026-03-15", "15.03.2026", 24, 124, "2026-04-01", null)).toEqual(snapped);
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

  it("T-H8-each-alternative: an accepted id never exempts an overlapping unaccounted alternative", () => {
    const supplierDe = {
      lines: withLines({ 2: "Reg. nr 10000018    VAT DE123456" }),
      values: { supplier_vat: "DE123456" },
      evidence: { supplier_vat: { line: "p1:002", quote: "VAT DE123456" } },
      labels: { supplier_vat: "VAT" },
    };
    expectAccept(supplierDe);
    expect(codesOf({ ...supplierDe, lines: withLines({ 2: "Reg. nr 10000018    VAT DE123456" }, ["Partner    DE 123 456 789"]) }))
      .toContain("unaccounted_identifier");
  });

  it("T-H8-alv-glued: a third-party VAT glued to a label word (`ALV40003032949`) holds unaccounted_identifier", () => {
    expect(codesOf({ lines: withLines({}, ["ALV40003032949"]) })).toContain("unaccounted_identifier");
  });

  // F-ACCOUNTING-PREFIX-GAPS: a Greek VAT printed with GR and a punctuated Swiss UID are identifiers too.
  it.each([
    "Partner: Kolmas AE    VAT GR123456789",
    "Partner: Kolmas AG    CHE-123.456.789 MWST",
  ])("T-H8-gr-che: an unaccounted third-party %s holds unaccounted_identifier", (line) => {
    expect(codesOf({ lines: withLines({}, [line]) })).toContain("unaccounted_identifier");
  });

  it("T-H8-iban-bic: IBAN and BIC lines account nothing", () => {
    expectAccept({ lines: withLines({}, ["IBAN EE86 1000 0018 2345 6788    BIC DEUTDEFF500"]) });
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

  it.each([
    ["GR123456789", "Näidis OÜ    Arve nr GR123456789"],
    ["CHE-123.456.789", "Näidis OÜ    Arve nr CHE-123.456.789"],
  ])("T-H9-gr-che: a number that is itself a foreign VAT %s holds", (number, line) => {
    expect(keysOf({
      lines: withLines({ 1: line }),
      values: { invoice_number: number },
      evidence: { invoice_number: { line: "p1:001", quote: `Arve nr ${number}` } },
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

describe("checkReading: purchase-date label (okt 2026 finding 2)", () => {
  it("T-H10-ostetud: a printed `Ostetud:` date on a two-column row passes and agrees with the labelled heuristic date", () => {
    const lines = withLines({ 4: "Ostetud:    15.03.2026 12:26    Hind (KM 24%):    100,00 EUR" });
    const heuristic = extractReceiptFieldsFromText(lines.join("\n"), "ticket.pdf");
    expect(heuristic.invoice_date).toBe("2026-03-15");
    expect(heuristic.invoice_date_unlabelled).toBeUndefined();
    expectAccept({
      lines,
      evidence: { invoice_date: { line: "p1:004", quote: "Ostetud: ¦ 15.03.2026" } },
      labels: { invoice_date: "Ostetud:" },
      ctx: { heuristic: { signals: [], confidence: "high" as const, labelled: labelledHeuristicValues(heuristic.field_provenance ?? []) } },
    });
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

describe("checkReading: whole-token currency", () => {
  it("T-CUR-glued: `EUR123` is neither currency evidence nor a stated EUR", () => {
    const glued = "Kokku 124,00 EUR123";
    const keys = keysOf({
      lines: withLines({ 7: glued }),
      evidence: { currency: { line: "p1:007", quote: glued }, gross: { line: "p1:007", quote: glued } },
    });
    expect(keys).toEqual(["value_not_complete_token:currency", "currency_not_stated"]);
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

  it("T-A4-join-split: the split `1` of `EUR 1 234,56` forms the trio 1 + 0,24 = 1,24 a gross-only reading must not skip", () => {
    const lines = withLines({ 5: "Teenus EUR 1 234,56", 6: "KM 24% 0,24", 7: "Vahesumma 1,24" }, ["Tasuda EUR 2000,00"]);
    expect(grossOnly(lines, 2000, "Tasuda EUR 2000,00", "p1:008")).toContain("trio_not_read");
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

describe("checkReading: discount trio (live 2026-10-28, Lux ticket)", () => {
  // Hind 11,00 − Soodustus 1,10 = Summa 9,90 reads as a 9,90 + 1,10 = 11,00 trio at "11 %" (RO), disjoint from 24 %.
  const luxTotal = (discountLabel: string) => ["Hind:    11,00", `${discountLabel}:    1,10`, "Summa:    9,90"];
  const luxReading = {
    values: { net: 7.98, vat: 1.92, gross: 9.9 },
    evidence: { net: { line: "p1:005", quote: "Neto 7,98" }, vat: { line: "p1:006", quote: "KM 24% 1,92" }, gross: { line: "p1:007", quote: "Kokku EUR 9,90" }, currency: { line: "p1:007", quote: "Kokku EUR 9,90" } },
    answers: { gross: { label_quote: "Kokku", competitors: [{ line: "p1:008", quote: "11,00" }], why_this_one: "", verdict: "confirm" } },
  };
  const luxLines = (discountLabel: string) => withLines({ 5: "Neto 7,98", 6: "KM 24% 1,92", 7: "Kokku EUR 9,90" }, luxTotal(discountLabel));

  it("T-DISC-gross: an unsigned discount on the accepted gross is not a VAT trio", () => {
    const codes = codesOf({ ...luxReading, lines: luxLines("Soodustus") });
    expect(codes).not.toContain("mixed_vat_rate");
    expect(codes).not.toContain("foreign_rate_trio");
    expectAccept({ ...luxReading, lines: luxLines("Soodustus") });
  });

  it("T-DISC-labels: allahindlus / discount / rabatt / alennus count, case-insensitively", () => {
    for (const label of ["Allahindlus", "DISCOUNT", "Rabatt", "alennus"]) {
      expect(codesOf({ ...luxReading, lines: luxLines(label) }), label).not.toContain("foreign_rate_trio");
    }
  });

  it("T-DISC-net: a pre-VAT discount on the accepted net is not a VAT trio", () => {
    const lines = withLines({ 5: "Neto 9,00", 6: "KM 24% 2,16", 7: "Kokku EUR 11,16" }, ["Hind:    10,00", "Soodustus:    1,00", "Summa:    9,00"]);
    expectAccept({
      lines,
      values: { net: 9, vat: 2.16, gross: 11.16 },
      evidence: { net: { line: "p1:005", quote: "Neto 9,00" }, vat: { line: "p1:006", quote: "KM 24% 2,16" }, gross: { line: "p1:007", quote: "Kokku EUR 11,16" }, currency: { line: "p1:007", quote: "Kokku EUR 11,16" } },
    });
  });

  it("T-DISC-other-label: the same figures under `Lisatasu` keep both holds", () => {
    const codes = codesOf({ ...luxReading, lines: luxLines("Lisatasu") });
    expect(codes).toEqual(expect.arrayContaining(["mixed_vat_rate", "foreign_rate_trio"]));
  });

  it("T-DISC-glued-label: a discount word glued to letters is no label", () => {
    expect(codesOf({ ...luxReading, lines: luxLines("Ebasoodustus") })).toContain("foreign_rate_trio");
  });

  it("T-DISC-not-total: a discount trio whose net is neither the read net nor the read gross keeps both holds", () => {
    const codes = codesOf({
      lines: withLines({ 5: "Neto 16,13", 6: "KM 24% 3,87", 7: "Kokku EUR 20,00" }, luxTotal("Soodustus")),
      values: { net: 16.13, vat: 3.87, gross: 20 },
      evidence: { net: { line: "p1:005", quote: "Neto 16,13" }, vat: { line: "p1:006", quote: "KM 24% 3,87" }, gross: { line: "p1:007", quote: "Kokku EUR 20,00" }, currency: { line: "p1:007", quote: "Kokku EUR 20,00" } },
    });
    expect(codes).toEqual(expect.arrayContaining(["mixed_vat_rate", "foreign_rate_trio"]));
  });

  it("T-DISC-read-trio: the read trio itself is never exempt (a 25 % reading labelled as a discount still holds)", () => {
    const lines = ["Butik AB    Kvitto nr A-17", "Reg. nr 10000018    KMKR EE100000007", "Ostja: Ostja AS    Reg. nr 10000024",
      "Kuupäev 15.03.2026", "Netto 1 000,00", "Soodustus 250,00", "Kokku EUR 1 250,00"];
    const codes = codesOf({
      lines,
      values: { net: 1000, vat: 250, gross: 1250 },
      evidence: { net: { line: "p1:005", quote: "Netto 1 000,00" }, vat: { line: "p1:006", quote: "Soodustus 250,00" }, gross: { line: "p1:007", quote: "Kokku EUR 1 250,00" }, currency: { line: "p1:007", quote: "Kokku EUR 1 250,00" } },
    });
    expect(codes).toContain("foreign_rate_trio");
  });

  it("T-DISC-signed: a signed discount is still signed_amount_present", () => {
    expect(codesOf({ ...luxReading, lines: withLines({ 5: "Neto 7,98", 6: "KM 24% 1,92", 7: "Kokku EUR 9,90" }, ["Hind:    11,00", "Soodustus:    -1,10", "Summa:    9,90"]) })).toContain("signed_amount_present");
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
    expect(codesOf({ lines: withLines({}, ["Kaart XXX"]) })).toContain("foreign_currency_marker");
    expect(codesOf({ lines: withLines({}, ["Kood XTS"]) })).toContain("foreign_currency_marker");
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

describe("checkReading: self_vat_detected accounted for by the reading (live 2026-10-28, Royal Apartments)", () => {
  // Supplier "Registrikood: 17190329", "Ei ole käibemaksukohustuslane"; buyer "KMKR EE100000010" (our VAT).
  const lines = withLines({ 2: "Registrikood: 10000018    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    KMKR EE100000010", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" });
  const base: CaseInput = {
    lines,
    values: { supplier_vat: null, buyer_reg: null, buyer_vat: "EE100000010", net: 124, vat: 0, gross: 124 },
    evidence: { supplier_reg: { line: "p1:002", quote: "Registrikood: 10000018" }, supplier_vat: undefined, buyer_reg: undefined, buyer_vat: { line: "p1:003", quote: "KMKR EE100000010" }, net: { line: "p1:005", quote: "Summa 124,00" }, vat: undefined },
    labels: { supplier_vat: null },
    ctx: { heuristic: { signals: ["self_vat_detected"], confidence: "high", labelled: {} } },
  };

  it("T-SELFVAT-accounted: a supplier reg that is not ours, no supplier VAT and our VAT as the buyer's does not hold", () => {
    const codes = codesOf(base);
    expect(codes).not.toContain("reading_schema_invalid");
    expect(codes).not.toContain("self_vat_detected");
    expect(codes).not.toContain("supplier_is_own");
  });

  it("T-SELFVAT-own-reg-printed: our own registry code printed anywhere on the page keeps the hold (a role-swapped own sale invoice)", () => {
    const printed = withLines({ 2: "Registrikood: 10000018    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    Reg. nr 10000024    KMKR EE100000010", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" });
    expect(codesOf({ ...base, lines: printed })).toContain("self_vat_detected");
    const spaced = withLines({ 2: "Registrikood: 10000018    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    KMKR EE100000010", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" }, ["Reg 1000 0024"]);
    expect(codesOf({ ...base, lines: spaced })).toContain("self_vat_detected");
    // Review 2026-10-28 (a210ae8): our code followed by another number on the same line still counts.
    const followed = withLines({ 2: "Registrikood: 10000018    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    KMKR EE100000010", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" }, ["Reg 10000024 17.07.2026"]);
    expect(codesOf({ ...base, lines: followed })).toContain("self_vat_detected");
    for (const extra of ["Reg 1000 0024 17.07.2026", "Reg 1000  0024", "Tellimus 9 10000024"]) {
      const shaped = withLines({ 2: "Registrikood: 10000018    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    KMKR EE100000010", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" }, [extra]);
      expect(codesOf({ ...base, lines: shaped }), extra).toContain("self_vat_detected");
    }
    // A longer number containing our code is not our code.
    const inside = withLines({ 2: "Registrikood: 10000018    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    KMKR EE100000010", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" }, ["Tellimus 910000024"]);
    expect(codesOf({ ...base, lines: inside })).not.toContain("self_vat_detected");
  });

  it("T-SELFVAT-buyer-missing: without the buyer VAT read, the own VAT is unaccounted and holds", () => {
    expect(codesOf({ ...base, values: { ...base.values, buyer_vat: null }, evidence: { ...base.evidence, buyer_vat: undefined } })).toContain("self_vat_detected");
  });

  it("T-SELFVAT-reg-missing: without a supplier registry code it holds, with supplier_id_missing", () => {
    const codes = codesOf({ ...base, values: { ...base.values, supplier_reg: null }, evidence: { ...base.evidence, supplier_reg: undefined }, labels: { ...base.labels, supplier_reg: null } });
    expect(codes).toEqual(expect.arrayContaining(["self_vat_detected", "supplier_id_missing"]));
  });

  it("T-SELFVAT-own-reg: a supplier registry code equal to ours holds supplier_is_own and self_vat_detected", () => {
    const codes = codesOf({ ...base, lines: withLines({ 2: "Registrikood: 10000024    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    KMKR EE100000010", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" }),
      values: { ...base.values, supplier_reg: "10000024" }, evidence: { ...base.evidence, supplier_reg: { line: "p1:002", quote: "Registrikood: 10000024" } } });
    expect(codes).toEqual(expect.arrayContaining(["supplier_is_own", "self_vat_detected"]));
  });

  it("T-SELFVAT-own-vat-as-supplier: our VAT read as the supplier's holds supplier_is_own and self_vat_detected", () => {
    const codes = codesOf({ ...base, lines: withLines({ 2: "Registrikood: 10000018    KMKR EE100000010", 3: "Ostja: Ostja AS", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" }),
      values: { ...base.values, supplier_vat: "EE100000010", buyer_vat: null },
      evidence: { ...base.evidence, supplier_vat: { line: "p1:002", quote: "KMKR EE100000010" }, buyer_vat: undefined }, labels: {} });
    expect(codes).toEqual(expect.arrayContaining(["supplier_is_own", "self_vat_detected"]));
  });

  it("T-SELFVAT-other-buyer-vat: a buyer VAT that is not ours leaves the own VAT unaccounted", () => {
    expect(codesOf({ ...base, lines: withLines({ 2: "Registrikood: 10000018    Ei ole käibemaksukohustuslane", 3: "Ostja: Ostja AS    KMKR EE100000099", 5: "Summa 124,00", 6: "Käibemaksu ei lisandu" }),
      values: { ...base.values, buyer_vat: "EE100000099" }, evidence: { ...base.evidence, buyer_vat: { line: "p1:003", quote: "KMKR EE100000099" } } })).toContain("self_vat_detected");
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
    expect(READING_HAZARD_SIGNALS).toHaveLength(19);
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
    for (const url of ["https://www.skatteetaten.no/en/rates/value-added-tax/", "https://www.estv.admin.ch/en/vat-rates-switzerland", "https://www.gov.uk/vat-rates"]) {
      expect(FOREIGN_VAT_RATES_SOURCE).toContain(url);
    }
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

describe("checkReading: proof checks (§2.5)", () => {
  const gross = (extra: Record<string, unknown>) => ({ gross: { label_quote: "Kokku", competitors: [], why_this_one: "", verdict: "confirm", ...extra } });

  it("T-PR-digest: a stale digest in the reading or the proof holds packet_changed", () => {
    const { packet, reading, proof, ctx } = buildCase();
    expect(holdCodes(checkReading(packet, { ...reading, packet_digest: "e".repeat(64) }, proof, ctx))).toEqual(["packet_changed"]);
    expect(holdCodes(checkReading(packet, reading, { ...proof, source_sha256: "e".repeat(64) }, ctx))).toEqual(["packet_changed"]);
  });

  it("T-PR-problem: any `problem` verdict holds proof_problem", () => {
    expect(keysOf({ answers: gross({ verdict: "problem" }) })).toEqual(["proof_problem:gross"]);
    expect(keysOf({ answers: { due_date: { label_quote: null, competitors: [], why_this_one: "", verdict: "problem" } } })).toEqual(["proof_problem:due_date"]);
  });

  it("T-PR-label-missing: a null label on invoice_date, invoice_number, gross or a non-null supplier id holds", () => {
    for (const field of ["invoice_date", "invoice_number", "gross", "supplier_reg", "supplier_vat"]) {
      expect(keysOf({ labels: { [field]: null } }), field).toEqual([`label_quote_missing:${field}`]);
    }
    expect(keysOf({
      lines: withLines({ 2: "Reg. nr 10000018" }),
      labels: { supplier_vat: null },
      values: { supplier_vat: null },
      evidence: { supplier_vat: undefined },
    })).toEqual([]);
  });

  it("T-PR-null-fields: answers for null fields are still required", () => {
    const { packet, reading, proof, ctx } = buildCase();
    const answers = { ...(proof.answers as Record<string, unknown>) };
    delete answers.due_date;
    expect(holdCodes(checkReading(packet, reading, { ...proof, answers }, ctx))).toEqual(["proof_schema_invalid"]);
  });

  it("T-PR-label-printed: a label must be printed and carry a letter", () => {
    expect(keysOf({ labels: { gross: "Grand total" } })).toEqual(["label_quote_not_printed:gross"]);
    expect(keysOf({ labels: { vat: "24%" } })).toEqual(["label_quote_no_letter:vat"]);
  });

  it("T-PR-overlap: a label that only overlaps the value token holds; another occurrence elsewhere passes", () => {
    expect(keysOf({ labels: { gross: "Kokku EUR 124,00" } })).toEqual(["label_quote_overlaps_value:gross"]);
    expect(keysOf({ labels: { gross: "EUR 124" } })).toEqual(["label_quote_overlaps_value:gross"]);
    expectAccept({ lines: withLines({}, ["Kokku EUR 124,00 tasutud"]), labels: { gross: "Kokku EUR 124,00" } });
  });

  const notesOf = (input: CaseInput) => (runCase(input).notes ?? []).map((entry) => `${entry.code}:${entry.field}`);

  it("T-PR-competitor: a competitor must be printed on its line", () => {
    expect(keysOf({ answers: gross({ competitors: [{ line: "p1:006", quote: "Kokku" }] }) })).toEqual(["competitor_not_printed:gross"]);
    expect(keysOf({ answers: gross({ competitors: [{ line: "p1:099", quote: "Kokku" }] }) })).toEqual(["competitor_not_printed:gross"]);
  });

  it("T-PR-competitor-same-value: another occurrence of the accepted value is ignored with a note, never held", () => {
    // owner 2026-10-17, pilot: same-value occurrences are not competitors.
    const same = (input: CaseInput, field: string) => {
      const result = expectAccept(input);
      expect((result.notes ?? []).map((entry) => `${entry.code}:${entry.field}`)).toEqual([`competitor_same_value_ignored:${field}`]);
    };
    same({ answers: gross({ competitors: [{ line: "p1:007", quote: "Kokku EUR 124,00" }] }) }, "gross");
    same({ answers: { invoice_date: { label_quote: "Kuupäev", competitors: [{ line: "p1:004", quote: "15.03.2026" }], why_this_one: "", verdict: "confirm" } } }, "invoice_date");
    same({ answers: { supplier_reg: { label_quote: "Reg. nr", competitors: [{ line: "p1:002", quote: "10000018" }], why_this_one: "", verdict: "confirm" } } }, "supplier_reg");
    expect(expectAccept().notes).toBeUndefined();
  });

  it("T-PR-competitor-same-value-A1: a same-value entry never satisfies A1 when a larger value is omitted", () => {
    const lines = withLines({}, ["Vahesumma 124,00    Ettemaks 200,00"]);
    const input = (quote: string): CaseInput => ({ lines, answers: gross({ competitors: [{ line: "p1:008", quote }] }) });
    // The entry covers the larger 200,00 too, but it is a same-value occurrence: dropped, so 200,00 is omitted.
    expect(keysOf(input("Vahesumma 124,00 ¦ Ettemaks 200,00"))).toEqual(["competitor_omitted:gross"]);
    expect(notesOf(input("Vahesumma 124,00 ¦ Ettemaks 200,00"))).toEqual(["competitor_same_value_ignored:gross"]);
    // Listing the larger value on its own satisfies A1.
    expectAccept(input("Ettemaks 200,00"));
  });

  it("T-PR-competitor-cut: a competitor cut mid-token is not equal to the value", () => {
    const result = expectAccept({ answers: gross({ competitors: [{ line: "p1:007", quote: "124,0" }] }) });
    expect(result.notes).toBeUndefined();
  });

  it("T-PR-competitor-ambiguous-date: a repeat that also reads as another date holds competitor_ambiguous", () => {
    // Codex review of e273703: 03/02/2026 is 3 February or 2 March; it is not an unambiguous repetition.
    const input: CaseInput = {
      lines: withLines({ 4: "Kuupäev 03.02.2026" }, ["Arve kuupäev 03/02/2026"]),
      values: { invoice_date: "2026-02-03" },
      evidence: { invoice_date: { line: "p1:004", quote: "Kuupäev 03.02.2026" } },
      answers: { invoice_date: { label_quote: "Kuupäev", competitors: [{ line: "p1:008", quote: "03/02/2026" }], why_this_one: "", verdict: "confirm" } },
    };
    const result = runCase(input);
    expect(result.verdict).toBe("hold");
    expect(holdKeys(result)).toEqual(["competitor_ambiguous:invoice_date"]);
    expect(result.notes).toBeUndefined();
  });

  it("T-PR-competitor-ambiguous-amount: a repeat that also reads as another amount holds competitor_ambiguous", () => {
    // 24,000 reads as 24 or 24000; the larger reading is listed as a gross competitor, so A1 is satisfied.
    const input: CaseInput = {
      lines: withLines({}, ["Maks 24,000"]),
      answers: {
        vat: { label_quote: "KM", competitors: [{ line: "p1:008", quote: "24,000" }], why_this_one: "", verdict: "confirm" },
        gross: { label_quote: "Kokku", competitors: [{ line: "p1:008", quote: "24,000" }], why_this_one: "", verdict: "confirm" },
      },
    };
    const result = runCase(input);
    expect(result.verdict).toBe("hold");
    expect(holdKeys(result)).toEqual(["competitor_ambiguous:vat"]);
    expect(result.notes).toBeUndefined();
  });
});

describe("checkReading: heuristic cross-check (§2.5)", () => {
  const view = (labelled: Record<string, unknown>) => ({ heuristic: { signals: [], confidence: "high" as const, labelled } });

  it("T-HX-conflict: a labelled heuristic value that differs holds reading_heuristic_conflict", () => {
    expect(keysOf({ ctx: view({ gross: 125 }) })).toEqual(["reading_heuristic_conflict:gross"]);
    expect(keysOf({ ctx: view({ supplier_vat: "EE100000023" }) })).toEqual(["reading_heuristic_conflict:supplier_vat"]);
    expect(keysOf({ ctx: view({ invoice_date: "2026-03-16" }) })).toEqual(["reading_heuristic_conflict:invoice_date"]);
    expect(keysOf({ ctx: view({ due_date: undefined, net: 100, vat: "24,00", invoice_number: "a 17", supplier_reg: "1000 0018" }) })).toEqual([]);
    expect(keysOf({ ctx: view({ net: 100 }), values: { net: null }, evidence: { net: undefined } })).toContain("reading_heuristic_conflict:net");
  });

  it("T-HX-regex-ignored: only label / coordinate provenance enters the cross-check", () => {
    const labelled = labelledHeuristicValues([
      { field: "total_gross", value: 999, source: "regex" },
      { field: "invoice_number", value: "X-1", source: "fallback" },
      { field: "total_vat", value: 24, source: "coordinate" },
      { field: "supplier_vat_no", value: "EE100000007", source: "label" },
    ]);
    expect(labelled).toEqual({ vat: 24, supplier_vat: "EE100000007" });
    expectAccept({ ctx: view(labelled) });
  });
});

describe("hold objects carry no values", () => {
  it("T-HOLD-no-values: every hold has only code, field and class keys", () => {
    const cases: CaseInput[] = [
      { lines: withLines({}, ["Ettemaks 200,00", "Allahindlus -26,00", "Summa SEK", "KM 9% 0,90", "Projektpartner: Kolmas OÜ    EE 100 000 023"]) },
      { values: { gross: 125, supplier_reg: "10000019", invoice_number: null } },
      { answers: { gross: { label_quote: "Kokku EUR 124,00", competitors: [{ line: "p1:007", quote: "Kokku EUR 124,00" }], why_this_one: "", verdict: "problem" } } },
      { ctx: { own: "unavailable", heuristic: { signals: ["zero_total_stated"], confidence: "low", labelled: { gross: 1 } } }, pageMeta: { fullPageImage: true } },
    ];
    let seen = 0;
    for (const input of cases) {
      for (const hold of runCase(input).holds) {
        seen += 1;
        expect(Object.keys(hold).every((key) => ["code", "field", "class"].includes(key)), JSON.stringify(hold)).toBe(true);
        expect(hold.code in HOLD_CODES).toBe(true);
        expect(hold.class).toBe(HOLD_CODES[hold.code].class);
      }
    }
    expect(seen).toBeGreaterThan(15);
  });
});

describe("reader text", () => {
  it("T-TXT-questions: the proof questions name all 15 fields and the untrusted-data rule", () => {
    for (const field of READING_FIELDS) expect(PROOF_QUESTIONS).toContain(field);
    expect(PROOF_QUESTIONS).toContain("untrusted");
    expect(READING_INSTRUCTIONS).toContain("untrusted");
    expect(READING_INSTRUCTIONS).toContain("evidence");
  });

  it("T-TXT-throughput: the reader text carries the throughput-round format rules (plan p1-throughput-round §2)", () => {
    expect(READING_INSTRUCTIONS).toContain("net, vat and gross are JSON numbers (12.34), never strings");
    expect(READING_INSTRUCTIONS).toContain("evidence has only field keys (no source_sha256 or packet_digest inside it)");
    expect(READING_INSTRUCTIONS).toContain("without a label or a leading \"#\"");
    // Generic examples only: no corpus value is a prompt cue (Codex review of 4bf9ac8).
    for (const corpusValue of ["80832991", "118,395", "6,000", "15.92"]) expect(`${READING_INSTRUCTIONS}\n${PROOF_QUESTIONS}\n${JSON_OUTPUT_FORMAT}`).not.toContain(corpusValue);
    // step5c: haiku N-S returned a complete object plus one trailing "}"; the format line forbids trailing characters.
    expect(JSON_OUTPUT_FORMAT).toBe("Output exactly one JSON object and nothing else: no code fence, no prose, and no characters after the final closing brace.");
    expect(READING_INSTRUCTIONS).toContain("currency: EUR when the document prints EUR, euro, eurot or €");
    expect(READING_INSTRUCTIONS).toContain("if the supplier prints several of its own accounts, give the first one printed");
    expect(PROOF_QUESTIONS).toContain("copied from ONE line, and not containing the value itself");
    expect(PROOF_QUESTIONS).toContain("each quote copied from the line whose id you give");
    expect(PROOF_QUESTIONS).toContain("Several bank accounts that all belong to the supplier are not a problem.");
    expect(PROOF_QUESTIONS).toContain("larger only when its comma or point is read as a thousands separator (1,500; 250,750)");
    expect(PROOF_QUESTIONS).toContain(`answers has exactly these 15 keys: ${READING_FIELDS.join(", ")}.`);
  });

  it("T-TXT-schema-strict: the A1 targets stay schema holds (the checker is not loosened)", () => {
    expect(codesOf({ values: { gross: "124.00" } })).toEqual(["reading_schema_invalid"]);
    expect(codesOf({ values: { net: "100", vat: "24" } })).toEqual(["reading_schema_invalid"]);
    const { packet } = buildCase();
    expect(codesOf({ evidence: { source_sha256: { line: "p1:001", quote: packet.source_sha256 } } })).toEqual(["reading_schema_invalid"]);
    const { reading, proof, ctx } = buildCase();
    expect(holdCodes(checkReading(packet, reading, { proof }, ctx))).toEqual(["proof_schema_invalid"]);
  });
});

describe("rejected relaxations stay held (plan p1-throughput-round §4 D1/D2 kill tests)", () => {
  it("T-KILL-D1-billing: an XXX billing currency beside a EUR comparison currency holds foreign_currency_marker", () => {
    expect(codesOf({ lines: withLines({}, ["Arveldusvaluuta AMOUNT10XXX", "Võrdlusvaluuta EUR"]) })).toContain("foreign_currency_marker");
  });

  // The OCR item is the internal fragment `7` of the cited A-17 (not a separator-bounded part of it), so a
  // separator-boundary relaxation would accept both cases; today's substring rule holds them.
  const ocrFragmentItems = (native: string[]) => [
    { text: "Näidis OÜ", ocr: false },
    { text: "Arve nr", ocr: false },
    ...native.map((text) => ({ text, ocr: false })),
    { text: "7", ocr: true },
    ...BASE_LINES.slice(1).map((text) => ({ text, ocr: false })),
  ];

  it("T-KILL-D2-split: an OCR fragment 7 of A-17 beside a native A-1 holds ocr_cited_text", () => {
    expect(keysOf({ pageMeta: { items: ocrFragmentItems(["A-1"]) } })).toContain("ocr_cited_text:invoice_number");
  });

  it("T-KILL-D2-longer: an OCR fragment 7 of A-17 beside a native A-170 holds ocr_cited_text", () => {
    expect(keysOf({ pageMeta: { items: ocrFragmentItems(["A-170"]) } })).toContain("ocr_cited_text:invoice_number");
  });
});

describe("C2/C3 deferred: their counterexamples stay held (plan p2 §0, §3 kill tests)", () => {
  it("T-KILL-C2-pair: `Arve nr 10000018/EE100000007` read as supplier reg/VAT holds", () => {
    const keys = keysOf({
      lines: withLines({ 1: "Näidis OÜ    Arve nr 10000018/EE100000007", 2: "Aadress Tallinn" }),
      values: { invoice_number: null },
      evidence: {
        invoice_number: undefined,
        supplier_reg: { line: "p1:001", quote: "Arve nr 10000018/EE100000007" },
        supplier_vat: { line: "p1:001", quote: "Arve nr 10000018/EE100000007" },
      },
      labels: { invoice_number: null, supplier_reg: null, supplier_vat: null },
    });
    expect(keys).toContain("value_not_complete_token:supplier_reg");
    expect(keys).toContain("value_not_complete_token:supplier_vat");
  });

  it("T-KILL-C2-glued: `Arve nr.10000018` read as supplier reg holds", () => {
    expect(keysOf({
      lines: withLines({ 1: "Näidis OÜ    Arve nr.10000018", 2: "KMKR EE100000007" }),
      values: { invoice_number: null },
      evidence: { invoice_number: undefined, supplier_reg: { line: "p1:001", quote: "Arve nr.10000018" } },
      labels: { invoice_number: null, supplier_reg: null },
    })).toContain("value_not_complete_token:supplier_reg");
  });

  it("T-KILL-C3-order: `Tellimuse nr.A-17` read as the invoice number holds", () => {
    expect(keysOf({
      lines: withLines({ 1: "Näidis OÜ    Tellimuse nr.A-17" }),
      evidence: { invoice_number: { line: "p1:001", quote: "Tellimuse nr.A-17" } },
      labels: { invoice_number: "Tellimuse" },
    })).toEqual(["value_not_complete_token:invoice_number"]);
  });
});

describe("C7: packet holds survive a schema failure (plan p2 §3 C7)", () => {
  // h21 shape: an oversize packet whose proof fails its schema.
  const oversizeLines = [...BASE_LINES, ...Array.from({ length: 1500 }, (_, index) => `Rida ${index + 1}`)];

  it("T-C7-proof: an invalid proof on an oversize packet holds proof_schema_invalid and packet_oversize", () => {
    expect(codesOf({ lines: oversizeLines, answers: { gross: { verdict: "maybe" } } }).sort())
      .toEqual(["packet_oversize", "proof_schema_invalid"]);
  });

  it("T-C7-reading: an invalid reading on an oversize packet holds reading_schema_invalid and packet_oversize", () => {
    expect(codesOf({ lines: oversizeLines, values: { gross: "124.00" } }).sort())
      .toEqual(["packet_oversize", "reading_schema_invalid"]);
  });
});

describe("C1: a value lost under a dot leader holds (plan p2 §3 C1)", () => {
  // Google-invoice shape (#11 / h25): the date cell is only a leader; the period line prints other dates.
  const googleLines = withLines({ 4: "Arve kuupäev    ....................    Kogusumma (EUR)    124,00 €" }, [
    "Domeeni nimi    ....................    Kokkuvõte - 1. märts 2026 - 15.03.2026",
  ]);

  it("T-KILL-C1: a reading citing the period-line date holds text_layer_value_lost", () => {
    const result = runCase({
      lines: googleLines,
      evidence: { invoice_date: { line: "p1:008", quote: "15.03.2026" } },
      labels: { invoice_date: "Kokkuvõte" },
    });
    // Every other check passes: without C1 this wrong date would be accepted.
    expect(holdCodes(result)).toEqual(["text_layer_value_lost"]);
    expect(result.verdict).toBe("hold");
  });

  it("T-KILL-C1-spaced: single-space label leaders (Codex r4) hold the same wrong date", () => {
    const result = runCase({
      lines: withLines({ 4: "Arve kuupäev ....................    Kogusumma (EUR)    124,00 €" }, [
        "Domeeni nimi ....................    Kokkuvõte - 1. märts 2026 - 15.03.2026",
      ]),
      evidence: { invoice_date: { line: "p1:008", quote: "15.03.2026" } },
      labels: { invoice_date: "Kokkuvõte" },
    });
    expect(holdCodes(result)).toEqual(["text_layer_value_lost"]);
  });

  it("T-C1-control: the base invoice without a leader cell does not hold text_layer_value_lost", () => {
    expect(codesOf({})).not.toContain("text_layer_value_lost");
  });
});

describe("Step 0: the rate rules wait for a date lost under a leader (lost-value plan rev 3 NEW-1)", () => {
  // The date cell is only a leader; the reading leaves the date null and the owner types it on the card.
  const LOST = withLines({ 4: "Kuupäev ...................." });
  const lostDate: CaseInput = { lines: LOST, values: { invoice_date: null }, evidence: { invoice_date: undefined }, labels: { invoice_date: null } };
  /** A second consistent 24 % trio printed beside the read one. */
  const PREVIOUS = "Eelmine arve 50,00    12,00    62,00";

  it("T-S0-defer: a VAT>0 reading with the date lost holds only the typed-date codes, not H6 or the foreign-rate trio", () => {
    expect(holdKeys(runCase(lostDate)).sort()).toEqual(["label_quote_missing:invoice_date", "required_field_missing:invoice_date", "text_layer_value_lost"]);
  });

  it("T-S0-defer-A2: a competing trio waits for the date too", () => {
    expect(codesOf({ ...lostDate, lines: [...LOST, PREVIOUS] })).not.toContain("competing_consistent_total");
  });

  it("T-S0-narrow-hold: a null date without the lost-value hold still fails the rate rules", () => {
    const codes = codesOf({ values: { invoice_date: null }, evidence: { invoice_date: undefined }, labels: { invoice_date: null } });
    expect(codes).toContain("vat_rate_not_snapped");
    expect(codes).toContain("foreign_rate_trio");
  });

  it("T-S0-narrow-date: under the lost-value hold a read date runs every rate rule", () => {
    const dated = (date: string, printed: string, extra: string[] = []): CaseInput => ({
      lines: withLines({ 4: `Kuupäev ${printed}` }, ["Tarne ....................", ...extra]),
      values: { invoice_date: date },
      evidence: { invoice_date: { line: "p1:004", quote: `Kuupäev ${printed}` } },
    });
    // 24 % on a date when 22 % was in force.
    expect(codesOf(dated("2025-03-15", "15.03.2025"))).toEqual(expect.arrayContaining(["text_layer_value_lost", "vat_rate_not_snapped", "foreign_rate_trio"]));
    expect(codesOf(dated("2026-03-15", "15.03.2026", [PREVIOUS]))).toEqual(expect.arrayContaining(["text_layer_value_lost", "competing_consistent_total"]));
  });
});

const expectNarrowing = (entry: NarrowingCase) => {
  const result = runCase(entry.input);
  expect(holdKeys(result).sort(), entry.name).toEqual(entry.holds);
  expect(result.verdict, entry.name).toBe(entry.holds.length === 0 ? "accept" : "hold");
};

describe("N1: a label-bound BIC branch code XXX is not a currency (plan p1-throughput-round §10)", () => {
  for (const entry of N1_CASES) it(`T-N1 ${entry.name} (${entry.violates}): exact holds ${JSON.stringify(entry.holds)}`, () => expectNarrowing(entry));
});

describe("N2: a decimal-thousands ambiguity resolved by a unique, exact closing trio (plan p1-throughput-round §10)", () => {
  for (const entry of N2_CASES) it(`T-N2 ${entry.name} (${entry.violates}): exact holds ${JSON.stringify(entry.holds)}`, () => expectNarrowing(entry));

  // Q3 at helper level: with Q1's anchor a second closing scale needs a near-zero term, so no checker case reaches it.
  it("T-N2 Q3: two closing scales resolve nothing; one closing scale is returned", () => {
    expect(uniqueClosingTrio([1, 1000], [0.24, 240], [1.24, 1240], [24])).toBeNull();
    expect(uniqueClosingTrio([1, 1000], [0.24, 240], [1.24], [24])).toEqual([1, 0.24, 1.24]);
    expect(uniqueClosingTrio([1, 1000], [0.5, 500], [1.5], [24])).toBeNull();
  });
});

describe("N3 rejected: third-party identifiers keep holding unaccounted_identifier (plan p1-throughput-round §10)", () => {
  for (const entry of N3_PINS) it(`T-${entry.name}: exact holds ${JSON.stringify(entry.holds)}`, () => expectNarrowing(entry));
});
