// Synthetic parse results, one per text hazard (P2 E0 parity tests). No corpus text.
import type { ParsedDocument } from "../../document-parser.js";
import type { ExtractionConfidenceSignals } from "../../invoice-extraction-fallback.js";

export type TextHazardFixture = "credit_word" | "signed_amount" | "foreign_marker";

const LINES: Record<TextHazardFixture, string[]> = {
  credit_word: ["Näidis OÜ", "Kreeditarve nr K-17", "Kuupäev 03.03.2026", "Kokku 10,00 €"],
  signed_amount: ["Näidis OÜ", "Arve nr A-17", "Kuupäev 03.03.2026", "Allahindlus -5,00 €", "Kokku 10,00 €"],
  foreign_marker: ["Exempel AB", "Faktura nr F-17", "Datum 03.03.2026", "Att betala 1 250,00 kr"],
};

/** The signal set each fixture must raise, on every intake path. */
export const TEXT_HAZARD_EXPECTED: Record<TextHazardFixture, ExtractionConfidenceSignals> = {
  credit_word: { credit_word_present: true },
  signed_amount: { signed_amount_present: true },
  foreign_marker: { foreign_currency_marker: true },
};

export function textHazardParse(kind: TextHazardFixture): ParsedDocument {
  const lines = LINES[kind];
  const text = lines.join("\n");
  return {
    text,
    pageCount: 1,
    ocrPartialFailure: false,
    result: {
      text,
      totalPages: 1,
      pageErrors: [],
      pages: [{
        pageNum: 1,
        width: 595,
        height: 842,
        text,
        textItems: lines.map((line, index) => ({ text: line, x: 40, y: 40 + 20 * index, width: 200, height: 12 })),
      }],
    },
  } as unknown as ParsedDocument;
}
