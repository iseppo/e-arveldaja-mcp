import { describe, expect, it } from "vitest";
import { documentTextHazards } from "../document-reading-check.js";
import { BASE_LINES, holdCodes, runCase } from "../__fixtures__/document-reading/invoice.js";
import { makePacket } from "../__fixtures__/document-reading/make-packet.js";
import { TEXT_HAZARD_EXPECTED, textHazardParse, type TextHazardFixture } from "../__fixtures__/document-reading/text-hazard-parses.js";
import { packetInputFromParse, textHazardSignals } from "./document-text-hazards.js";

const FIXTURES = Object.keys(TEXT_HAZARD_EXPECTED) as TextHazardFixture[];

describe("documentTextHazards (P2 E0 shared producer)", () => {
  it("raises each hazard from the packet lines", async () => {
    expect(documentTextHazards(makePacket(["Kreeditarve K-1", "Kokku 10,00 €"]).lines)).toMatchObject({ credit_word_present: true, signed_amount_present: false, foreign_currency_marker: false, eur_stated: true });
    expect(documentTextHazards(makePacket(["Allahindlus -5,00 €"]).lines)).toMatchObject({ credit_word_present: false, signed_amount_present: true });
    expect(documentTextHazards(makePacket(["Att betala 1 250,00 kr"]).lines)).toMatchObject({ foreign_currency_marker: true, eur_stated: false });
    expect(documentTextHazards(makePacket(["Non-refundable fee 10,00 EUR"]).lines)).toEqual({
      credit_word_present: false, signed_amount_present: false, foreign_currency_marker: false, eur_stated: true,
    });
  });

  it("is the producer the checker holds on: the same hazard codes on the same line", async () => {
    const hazardLine: Record<TextHazardFixture, string> = {
      credit_word: "Kreeditarve K-17",
      signed_amount: "Allahindlus -5,00",
      foreign_marker: "Tasuda 1 250,00 kr",
    };
    const HAZARD_CODES = ["credit_word_present", "signed_amount_present", "foreign_currency_marker"];
    expect(holdCodes(runCase()).filter((code) => HAZARD_CODES.includes(code))).toEqual([]);
    for (const kind of FIXTURES) {
      const lines = [...BASE_LINES, hazardLine[kind]];
      const fromProducer = Object.entries(documentTextHazards(makePacket(lines).lines))
        .filter(([key, raised]) => raised && key !== "eur_stated").map(([key]) => key);
      expect(fromProducer, kind).toEqual(Object.keys(TEXT_HAZARD_EXPECTED[kind]));
      expect(holdCodes(runCase({ lines })).filter((code) => HAZARD_CODES.includes(code)), kind).toEqual(fromProducer);
    }
  });
});

describe("textHazardSignals (tool-side adapter)", () => {
  it.each(FIXTURES)("maps the %s fixture to exactly its signal", async (kind) => {
    expect(await textHazardSignals(textHazardParse(kind), undefined, "/nonexistent.pdf")).toEqual(TEXT_HAZARD_EXPECTED[kind]);
  });

  it("P2 E3: a foreign-currency marker counts only on a reading that is, or defaults to, EUR", async () => {
    const parsed = textHazardParse("foreign_marker");
    expect(await textHazardSignals(parsed, "EUR", "/nonexistent.pdf")).toEqual({ foreign_currency_marker: true });
    expect(await textHazardSignals(parsed, "eur", "/nonexistent.pdf")).toEqual({ foreign_currency_marker: true });
    expect(await textHazardSignals(parsed, undefined, "/nonexistent.pdf")).toEqual({ foreign_currency_marker: true });
    expect(await textHazardSignals(parsed, "SEK", "/nonexistent.pdf")).toEqual({});
  });

  it("P2 E2: a leader-only table cell raises text_layer_value_lost; a leader inside a text cell does not", async () => {
    const page = (text: string) => ({ text, pageCount: 1, result: { pages: [{ pageNum: 1, text, width: 600, height: 800, textItems: [] }], totalPages: 1 } }) as never;
    expect(await textHazardSignals(page("Arve kuupäev    ....................    Kogusumma (EUR)    1,87 €"), "EUR", "/nonexistent.pdf")).toEqual({ text_layer_value_lost: true });
    expect(await textHazardSignals(page("Total ........ 13,60"), "EUR", "/nonexistent.pdf")).toEqual({});
  });

  it("raises nothing on a parse with no pages", async () => {
    expect(await textHazardSignals({ text: "Kreeditarve", pageCount: 0 } as never, undefined, "/nonexistent.pdf")).toEqual({});
  });

  it("builds the packet from the parse pages exactly as the reading harness does", async () => {
    const parsed = textHazardParse("credit_word");
    const input = packetInputFromParse(parsed, "b".repeat(64), "liteparse@x");
    expect(input).toMatchObject({ sourceSha256: "b".repeat(64), parserVersion: "liteparse@x", totalPages: 1, pageErrors: [] });
    expect(input.pages[0]).toMatchObject({ pageNum: 1, text: parsed.result.pages[0]!.text, fullPageImage: false, reasons: [], isGarbled: false });
    expect(input.pages[0]!.items.every((item) => item.ocr === false)).toBe(true);
  });
});
