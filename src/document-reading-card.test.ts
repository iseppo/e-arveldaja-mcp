import { describe, expect, it } from "vitest";
import {
  ALL_CARD_HOLD_CODES,
  DISPOSITION,
  PAYLOAD_FIELDS,
  applyOwnerAnswers,
  buildReadingCard,
  recheckFinalValues,
  type CardHold,
  type CardInput,
  type ReadingCard,
} from "./document-reading-card.js";
import { HOLD_CODES, type AcceptedValues } from "./document-reading-check.js";
import { makePacket } from "./__fixtures__/document-reading/make-packet.js";
import { BASE_EVIDENCE, BASE_LINES, BASE_VALUES } from "./__fixtures__/document-reading/invoice.js";

const VALUES = BASE_VALUES as unknown as AcceptedValues;

function input(holds: CardHold[], overrides: Partial<CardInput> = {}): CardInput {
  return {
    packet: makePacket(BASE_LINES),
    values: VALUES,
    evidence: BASE_EVIDENCE,
    holds,
    noteCount: 0,
    heuristic: { labelled: {} },
    supplier: { clientId: 4242, name: "Näidis OÜ" },
    company: { name: "Ostja AS", reg: "10000024", vat: "EE100000010" },
    ...overrides,
  };
}

function cardOf(holds: CardHold[], overrides: Partial<CardInput> = {}): ReadingCard {
  const outcome = buildReadingCard(input(holds, overrides));
  if (outcome.blocked) throw new Error(`blocked: ${JSON.stringify(outcome.blockHolds)}`);
  return outcome.card;
}

const codesOf = (disposition: string) => ALL_CARD_HOLD_CODES.filter((code) => DISPOSITION[code] === disposition);

describe("DISPOSITION", () => {
  it("covers every checker hold code and the reading path's own codes, and nothing else", () => {
    expect(new Set(Object.keys(DISPOSITION))).toEqual(new Set([...Object.keys(HOLD_CODES), "buyer_attestation_mismatch", "reading_create_indeterminate"]));
  });

  it("pins the released codes (§5.4); every other code blocks", () => {
    expect(codesOf("question").sort()).toEqual(["ambiguous_amount_token", "ambiguous_slash_date", "buyer_id_missing", "reading_heuristic_conflict"]);
    expect(codesOf("typed").sort()).toEqual(["required_field_missing", "text_layer_value_lost"]);
    expect(codesOf("field_review").sort()).toEqual([
      "cited_origin_unestablished", "competitor_ambiguous", "competitor_not_printed", "label_quote_missing", "label_quote_no_letter",
      "label_quote_not_printed", "label_quote_overlaps_value", "missing_evidence", "ocr_cited_text", "proof_problem",
      "quote_not_printed", "unknown_line", "value_not_complete_token",
    ]);
  });

  it.each(codesOf("block"))("block code %s stops the card (no owner rows can release it)", (code) => {
    for (const field of [undefined, "gross", "invoice_number"]) {
      const outcome = buildReadingCard(input([{ code, ...(field ? { field } : {}) }]));
      expect(outcome.blocked).toBe(true);
    }
  });
});

describe("buildReadingCard", () => {
  it("a clean reading has no rows, but always shows the gross and the supplier with their printed lines", () => {
    const card = cardOf([]);
    expect(card.rows).toEqual([]);
    expect(card.look_here.gross).toEqual({ value: 124, line: "Kokku EUR 124,00" });
    expect(card.look_here.supplier).toEqual({ client_id: 4242, name: "Näidis OÜ", line: "Reg. nr 10000018 ¦ KMKR EE100000007" });
  });

  it.each(codesOf("field_review"))("field-review code %s on every payload field gives that field a mandatory row", (code) => {
    for (const field of PAYLOAD_FIELDS) {
      const card = cardOf([{ code, field }]);
      const row = card.rows.find((entry) => "field" in entry && entry.field === field);
      expect(row, `${code} on ${field}`).toBeDefined();
      expect(["field_review", "typed"]).toContain(row!.kind);
      expect(card.minor_notes).toBe(0);
    }
  });

  it("a review row shows the exact printed token; with none found the owner can only type the value", () => {
    const card = cardOf([{ code: "quote_not_printed", field: "invoice_number" }, { code: "proof_problem", field: "supplier_iban" }]);
    expect(card.rows).toEqual([
      { id: "r:invoice_number", kind: "field_review", field: "invoice_number", codes: ["quote_not_printed"], value: "A-17", printed_token: "A-17", line: "Näidis OÜ ¦ Arve nr A-17" },
      { id: "t:supplier_iban", kind: "typed", field: "supplier_iban", reason: "no_printed_token" },
    ]);
  });

  it("a value that is not a complete printed token is never offered for confirmation", () => {
    const card = cardOf([{ code: "value_not_complete_token", field: "invoice_number" }]);
    expect(card.rows).toEqual([{ id: "t:invoice_number", kind: "typed", field: "invoice_number", reason: "no_printed_token" }]);
  });

  it("notes on non-payload fields collapse into one count; a buyer id note stops the card", () => {
    const card = cardOf([{ code: "quote_not_printed", field: "supplier_name" }, { code: "label_quote_missing", field: "currency" }], { noteCount: 1 });
    expect(card.rows).toEqual([]);
    expect(card.minor_notes).toBe(3);
    expect(buildReadingCard(input([{ code: "quote_not_printed", field: "buyer_reg" }])).blocked).toBe(true);
    expect(buildReadingCard(input([{ code: "proof_problem" }])).blocked).toBe(true);
  });

  it("buyer_id_missing is one question naming the active company, with the printed addressee lines", () => {
    const card = cardOf([{ code: "buyer_id_missing" }]);
    expect(card.rows).toEqual([{
      id: "buyer", kind: "buyer_question", company: { name: "Ostja AS", reg: "10000024", vat: "EE100000010" },
      lines: ["Ostja: Ostja AS ¦ Reg. nr 10000024"], options: [{ id: "yes" }, { id: "no", stop: true }],
    }]);
  });

  it("an ambiguous amount token asks which reading is printed, with no default and a stop option", () => {
    const lines = [...BASE_LINES.slice(0, 6), "Kokku EUR 1.950"];
    const card = cardOf([{ code: "ambiguous_amount_token", field: "gross" }], {
      packet: makePacket(lines), values: { ...VALUES, gross: 1950 }, evidence: { ...BASE_EVIDENCE, gross: { line: "p1:007", quote: "Kokku EUR 1.950" } },
    });
    expect(card.rows).toEqual([{
      id: "q:gross", kind: "question", code: "ambiguous_amount_token", field: "gross", line: "Kokku EUR 1.950",
      options: [{ id: "option_1", value: 1.95 }, { id: "option_2", value: 1950 }, { id: "neither", stop: true }],
    }]);
  });

  it("an ambiguous slash date asks which date is printed", () => {
    const lines = [...BASE_LINES.slice(0, 3), "Kuupäev 03/04/2026", ...BASE_LINES.slice(4)];
    const card = cardOf([{ code: "ambiguous_slash_date", field: "invoice_date" }], {
      packet: makePacket(lines), values: { ...VALUES, invoice_date: "2026-03-04" }, evidence: { ...BASE_EVIDENCE, invoice_date: { line: "p1:004", quote: "Kuupäev 03/04/2026" } },
    });
    expect(card.rows[0]).toMatchObject({ id: "q:invoice_date", options: [{ value: "2026-04-03" }, { value: "2026-03-04" }, { id: "neither", stop: true }] });
  });

  it("a heuristic conflict offers the reader's and the parser's value; without a parser value the owner types it", () => {
    const card = cardOf([{ code: "reading_heuristic_conflict", field: "invoice_number" }], { heuristic: { labelled: { invoice_number: "A-71" } } });
    expect(card.rows[0]).toMatchObject({ id: "q:invoice_number", options: [{ id: "reader", value: "A-17" }, { id: "parser", value: "A-71" }, { id: "neither", stop: true }] });
    expect(cardOf([{ code: "reading_heuristic_conflict", field: "invoice_number" }]).rows[0]).toMatchObject({ id: "t:invoice_number", reason: "unresolved_question" });
  });

  it("a question on a field whose evidence also failed is typed instead", () => {
    const card = cardOf([{ code: "reading_heuristic_conflict", field: "invoice_number" }, { code: "quote_not_printed", field: "invoice_number" }], { heuristic: { labelled: { invoice_number: "A-71" } } });
    expect(card.rows).toEqual([{ id: "t:invoice_number", kind: "typed", field: "invoice_number", reason: "unresolved_question" }]);
  });

  it("required_field_missing is a typed row; a lost text layer always types the date and the number", () => {
    expect(cardOf([{ code: "required_field_missing", field: "gross" }], { values: { ...VALUES, gross: null } }).rows)
      .toEqual([{ id: "t:gross", kind: "typed", field: "gross", reason: "required_field_missing" }]);
    expect(cardOf([{ code: "text_layer_value_lost" }]).rows.map((row) => row.id)).toEqual(["t:invoice_date", "t:invoice_number"]);
  });
});

describe("applyOwnerAnswers", () => {
  const reviewCard = () => cardOf([{ code: "quote_not_printed", field: "invoice_number" }, { code: "buyer_id_missing" }]);

  it("every row needs an answer, and unknown rows are refused", () => {
    expect(applyOwnerAnswers(reviewCard(), VALUES, {})).toEqual({ ok: false, code: "owner_answer_missing", rows: ["buyer", "r:invoice_number"] });
    expect(applyOwnerAnswers(reviewCard(), VALUES, { buyer: { choice: "yes" }, "r:invoice_number": { confirm: true }, extra: { value: 1 } }))
      .toMatchObject({ ok: false, code: "owner_answer_invalid", rows: ["extra"] });
  });

  it("a confirmed printed token keeps the reading's value; a yes on the buyer question is an attestation", () => {
    expect(applyOwnerAnswers(reviewCard(), VALUES, { buyer: { choice: "yes" }, "r:invoice_number": { confirm: true } }))
      .toEqual({ ok: true, values: VALUES, correctedFields: [], buyerAttested: true, textLayerTyped: false });
  });

  it("'no' or 'neither' stops; 'yes' alone or an unknown option is not an answer", () => {
    expect(applyOwnerAnswers(reviewCard(), VALUES, { buyer: { choice: "no" }, "r:invoice_number": { confirm: true } })).toMatchObject({ ok: false, code: "owner_declined" });
    expect(applyOwnerAnswers(reviewCard(), VALUES, { buyer: { choice: "yes" }, "r:invoice_number": { confirm: false } })).toMatchObject({ ok: false, code: "owner_declined" });
    expect(applyOwnerAnswers(reviewCard(), VALUES, { buyer: { confirm: true }, "r:invoice_number": { confirm: true } })).toMatchObject({ ok: false, code: "owner_answer_invalid", rows: ["buyer"] });
    expect(applyOwnerAnswers(reviewCard(), VALUES, { buyer: { choice: "maybe" }, "r:invoice_number": { confirm: true } })).toMatchObject({ ok: false, code: "owner_answer_invalid" });
  });

  it("a typed value replaces the reading's value, is format-checked, and is recorded as corrected", () => {
    const card = cardOf([{ code: "text_layer_value_lost" }, { code: "quote_not_printed", field: "gross" }]);
    const answers = { "t:invoice_date": { value: "2026-03-14" }, "t:invoice_number": { value: "A-17" }, "r:gross": { value: 124 } };
    expect(applyOwnerAnswers(card, VALUES, answers)).toEqual({
      ok: true, values: { ...VALUES, invoice_date: "2026-03-14" }, correctedFields: ["gross", "invoice_date", "invoice_number"], buyerAttested: false, textLayerTyped: true,
    });
    expect(applyOwnerAnswers(card, VALUES, { ...answers, "t:invoice_date": { value: "14.03.2026" } })).toMatchObject({ ok: false, code: "owner_answer_invalid", rows: ["t:invoice_date"] });
    expect(applyOwnerAnswers(card, VALUES, { ...answers, "r:gross": { value: 124.001 } })).toMatchObject({ ok: false, code: "owner_answer_invalid", rows: ["r:gross"] });
    expect(applyOwnerAnswers(card, VALUES, { ...answers, "r:gross": { value: "124" } })).toMatchObject({ ok: false, code: "owner_answer_invalid" });
  });

  it("a forced choice other than the reading's value is a corrected field", () => {
    const card = cardOf([{ code: "reading_heuristic_conflict", field: "invoice_number" }], { heuristic: { labelled: { invoice_number: "A-71" } } });
    expect(applyOwnerAnswers(card, VALUES, { "q:invoice_number": { choice: "parser" } }))
      .toMatchObject({ ok: true, values: { invoice_number: "A-71" }, correctedFields: ["invoice_number"] });
    expect(applyOwnerAnswers(card, VALUES, { "q:invoice_number": { choice: "neither" } })).toMatchObject({ ok: false, code: "owner_declined" });
  });
});

describe("recheckFinalValues", () => {
  const ctx = { today: "2026-04-01", vatZeroNoteProven: false, original: VALUES };
  const codes = (values: Partial<AcceptedValues>) => recheckFinalValues({ ...VALUES, ...values }, ctx).map((hold) => hold.code);

  it("the reading's own values pass", () => {
    expect(codes({})).toEqual([]);
  });

  it("an owner-typed gross re-runs the arithmetic and the rate", () => {
    expect(codes({ gross: 125 })).toContain("arithmetic_mismatch");
    expect(codes({ net: 100, vat: 30, gross: 130 })).toContain("vat_rate_not_snapped");
    expect(codes({ net: 124, vat: 0, gross: 124 })).toContain("zero_vat_unproven");
  });

  it("an owner-typed date re-runs the date window; a due date before the invoice date holds", () => {
    expect(codes({ invoice_date: "2026-05-01" })).toContain("invoice_date_out_of_window");
    expect(codes({ invoice_date: "2024-12-31" })).toContain("invoice_date_out_of_window");
    expect(codes({ due_date: "2026-03-01" })).toContain("invoice_date_out_of_window");
  });

  it("an owner-typed identifier must validate; a missing required field holds", () => {
    expect(codes({ supplier_reg: "10000019" })).toContain("identifier_invalid");
    expect(codes({ supplier_iban: "EE00 1234" })).toContain("identifier_invalid");
    expect(codes({ invoice_number: null })).toContain("required_field_missing");
  });
});
