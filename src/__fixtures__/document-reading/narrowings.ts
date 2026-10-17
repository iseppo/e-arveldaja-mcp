// Synthetic kill and positive cases for the throughput-round checker narrowings (plan p1-throughput-round §10).
// Each case names the predicate it violates and its EXACT hold set (holdKeys, sorted). Shared by the vitest
// suite (checker) and scripts/reading-p1/selftest.ts (pipeline on a synthetic snapshot). No corpus text.
import { BASE_LINES, type CaseInput } from "./invoice.js";

export interface NarrowingCase {
  name: string;
  /** The predicate the case violates ("positive" for an accept case). */
  violates: string;
  input: CaseInput;
  /** Exact hold keys (`code:field` or `code`), sorted; [] for an accept. */
  holds: string[];
}

const withExtra = (extra: string[], edits: Record<number, string> = {}) => [...BASE_LINES.map((line, index) => edits[index + 1] ?? line), ...extra];
/** Amounts printed without a currency; EUR cited from a separate `Võrdlusvaluuta EUR` line (p1:008). */
const COMPARISON_EUR = {
  lines: (extra: string[]) => withExtra(["Võrdlusvaluuta EUR", ...extra], { 7: "Kokku 124,00" }),
  evidence: { currency: { line: "p1:008", quote: "Võrdlusvaluuta EUR" }, gross: { line: "p1:007", quote: "Kokku 124,00" } },
};

export const N1_CASES: NarrowingCase[] = [
  { name: "N1-positive-14-shape", violates: "positive", input: { lines: withExtra(["BIC: TRWIBEB1XXX", "Swift/BIC: TRWIBEB1XXX"]) }, holds: [] },
  { name: "N1-positive-cell-pair", violates: "positive", input: { lines: withExtra(["BIC    TRWIBEB1XXX"]) }, holds: [] },
  { name: "N1-P3-adjacent-cell", violates: "P3",
    input: { lines: COMPARISON_EUR.lines(["BIC: TRWIBEB1XXX    Arveldusvaluuta AMOUNT10XXX"]), evidence: COMPARISON_EUR.evidence }, holds: ["foreign_currency_marker"] },
  { name: "N1-P3-intervening-text", violates: "P3", input: { lines: withExtra(["BIC: Arveldusvaluuta AMOUNT10XXX"]) }, holds: ["foreign_currency_marker"] },
  { name: "N1-P3-trailing-text", violates: "P3", input: { lines: withExtra(["BIC: TRWIBEB1XXX Arveldusvaluuta"]) }, holds: ["foreign_currency_marker"] },
  { name: "N1-P3-codex-d1", violates: "P3",
    input: { lines: COMPARISON_EUR.lines(["Arveldusvaluuta AMOUNT10XXX"]), evidence: COMPARISON_EUR.evidence }, holds: ["foreign_currency_marker"] },
  { name: "N1-P3-label-not-label-only", violates: "P3", input: { lines: withExtra(["IBAN BE27 9051 9325 0073 BIC    TRWIBEB1XXX"]) }, holds: ["foreign_currency_marker"] },
  { name: "N1-P3-label-other-line", violates: "P3", input: { lines: withExtra(["BIC:", "TRWIBEB1XXX"]) }, holds: ["foreign_currency_marker"] },
  { name: "N1-P1-usd-branch", violates: "P1", input: { lines: withExtra(["BIC: TRWIBEB1USD"]) }, holds: ["foreign_currency_marker"] },
  { name: "N1-P2-12-characters", violates: "P2", input: { lines: withExtra(["BIC: TRWIQQ123XXX"]) }, holds: ["foreign_currency_marker"] },
  { name: "N1-P2-short-run", violates: "P2", input: { lines: withExtra(["BIC: 1XXX"]) }, holds: ["foreign_currency_marker"] },
  { name: "N1-P4-no-eur", violates: "P4",
    input: { lines: withExtra(["BIC: TRWIBEB1XXX", "Swift/BIC: TRWIBEB1XXX"], { 7: "Kokku 124,00" }), values: { currency: null },
      evidence: { currency: undefined, gross: { line: "p1:007", quote: "Kokku 124,00" } } },
    holds: ["currency_not_stated", "foreign_currency_marker", "required_field_missing:currency"] },
  { name: "N1-P5-other-marker", violates: "P5", input: { lines: withExtra(["BIC: TRWIBEB1XXX", "Summa 10,00 USD"]) }, holds: ["foreign_currency_marker"] },
];

/**
 * An N2 trio: net, vat and gross printed (and cited) on p1:005-007 as `<label>: ¦ <token> €`; extra lines from
 * p1:008. `values` is the reading (default: the printed decimals read as cents).
 */
const trio = (printed: [string, string, string], reading: [number, number, number], extra: string[] = [],
  answers: CaseInput["answers"] = {}): CaseInput => {
  const [net, vat, gross] = [`Summa käibemaksuta:    ${printed[0]} €`, `Käibemaks 24%:    ${printed[1]} €`, `Arve summa:    ${printed[2]} €`];
  const quote = (line: string) => line.replace("    ", " ¦ ");
  return {
    lines: withExtra(extra, { 5: net, 6: vat, 7: gross }),
    values: { net: reading[0], vat: reading[1], gross: reading[2] },
    evidence: {
      net: { line: "p1:005", quote: quote(net) }, vat: { line: "p1:006", quote: quote(vat) },
      gross: { line: "p1:007", quote: quote(gross) }, currency: { line: "p1:007", quote: quote(gross) },
    },
    labels: { gross: "Arve summa" },
    answers,
  };
};
const grossCompetitors = (...quotes: Array<[string, string]>) =>
  ({ gross: { label_quote: "Arve summa", competitors: quotes.map(([line, quote]) => ({ line, quote })), why_this_one: "", verdict: "confirm" } });
const netCompetitors = (...quotes: Array<[string, string]>) =>
  ({ net: { label_quote: null, competitors: quotes.map(([line, quote]) => ({ line, quote })), why_this_one: "", verdict: "confirm" } });
/** The #10 shape: `6,000` printed twice; 6000 and 1440 listed as gross competitors. */
const N10_COMPETITORS = grossCompetitors(["p1:008", "6,000 €"], ["p1:006", "1,440 €"]);

/** Gross competitors: the other-scale readings of the printed net and vat tokens (A1/A2 run over all readings). */
const scaleCompetitors = (printed: [string, string, string]) => grossCompetitors(["p1:005", `${printed[0]} €`], ["p1:006", `${printed[1]} €`]);
const listed = (printed: [string, string, string], reading: [number, number, number], extra: string[] = [], answers: CaseInput["answers"] = {}) =>
  trio(printed, reading, extra, { ...scaleCompetitors(printed), ...answers });

export const N2_CASES: NarrowingCase[] = [
  { name: "N2-positive-10-shape", violates: "positive", input: trio(["6,000", "1,440", "7,44"], [6, 1.44, 7.44], ["6,000 €"], N10_COMPETITORS), holds: [] },
  { name: "N2-Q4-codex-6,004", violates: "Q4", input: listed(["6,004", "1,440", "7,44"], [6, 1.44, 7.44]), holds: ["ambiguous_amount_token:net", "ambiguous_amount_token:vat"] },
  { name: "N2-Q4-vat-1,445", violates: "Q4", input: listed(["6,000", "1,445", "7,44"], [6, 1.45, 7.44]), holds: ["ambiguous_amount_token:net", "ambiguous_amount_token:vat"] },
  { name: "N2-Q4-1,005-0,241", violates: "Q4", input: listed(["1,005", "0,241", "1,25"], [1, 0.24, 1.25]), holds: ["ambiguous_amount_token:net", "ambiguous_amount_token:vat"] },
  { name: "N2-Q4-vat-1,442", violates: "Q4", input: listed(["6,010", "1,442", "7,45"], [6.01, 1.44, 7.45]), holds: ["ambiguous_amount_token:net", "ambiguous_amount_token:vat"] },
  { name: "N2-Q4-not-cent", violates: "Q4 (schema: cents only)", input: listed(["6,000", "1,445", "7,445"], [6, 1.445, 7.445]), holds: ["reading_schema_invalid"] },
  { name: "N2-Q1-no-anchor", violates: "Q1", input: listed(["0,300", "0,080", "0,380"], [0.3, 0.08, 0.38], ["380,00 €"],
    grossCompetitors(["p1:005", "0,300 €"], ["p1:006", "0,080 €"], ["p1:008", "380,00 €"])), holds: ["ambiguous_amount_token:gross", "ambiguous_amount_token:net", "ambiguous_amount_token:vat"] },
  { name: "N2-Q5-two-rates", violates: "Q5", input: listed(["0,100", "0,02", "0,12"], [0.1, 0.02, 0.12]), holds: ["ambiguous_amount_token:net", "vat_rate_not_snapped:vat"] },
  { name: "N2-Q2-ambiguous-join", violates: "Q2", input: trio(["3 082,64", "739,83", "3822,47"], [3082.64, 739.83, 3822.47]), holds: ["ambiguous_amount_token:net"] },
  { name: "N2-Q7-clean-net", violates: "Q7", input: trio(["6,00", "1,44", "7,44"], [6, 1.44, 7.44], ["6,000 €"], { ...grossCompetitors(["p1:008", "6,000 €"]), ...netCompetitors(["p1:008", "6,000 €"]) }), holds: ["competitor_ambiguous:net"] },
  { name: "N2-Q7-unresolved-field", violates: "Q7", input: listed(["0,100", "0,02", "0,12"], [0.1, 0.02, 0.12], ["0,100 €"], netCompetitors(["p1:008", "0,100 €"])), holds: ["ambiguous_amount_token:net", "competitor_ambiguous:net", "vat_rate_not_snapped:vat"] },
  { name: "N2-Q7-different-set", violates: "Q7", input: trio(["6,000", "1,440", "7,44"], [6, 1.44, 7.44], ["6,000 €", "1 006,00 €"],
    { ...grossCompetitors(["p1:008", "6,000 €"], ["p1:006", "1,440 €"], ["p1:009", "1 006,00 €"]), ...netCompetitors(["p1:009", "1 006,00 €"]) }), holds: ["competitor_ambiguous:net"] },
];

/** We are under Ship to; another company is under Bill to, with the third-party identifier on the next line. */
const shipToBillTo = (identifier: string): CaseInput => ({
  lines: [...BASE_LINES.map((line, index) => (index === 2 ? "Ship to: Ostja AS    Reg. nr 10000024" : line)), "Bill to: Muu Firma GmbH", identifier],
  evidence: { buyer_name: { line: "p1:003", quote: "Ship to: Ostja AS" }, buyer_reg: { line: "p1:003", quote: "Reg. nr 10000024" } },
});

/**
 * N3 was rejected (rev. 3.1): a format rejection cannot prove another party is absent. These pins keep today's
 * `unaccounted_identifier` hold on Codex's three third-party identifiers and the #21 / #28 / KMKR-glued shapes.
 */
export const N3_PINS: NarrowingCase[] = [
  "DE1234S6789", "CH E123456789MWST", "Registration NO200312345A", "AENO ASC0002", "3 70449888", "KMKRDE123456789",
].map((identifier) => ({ name: `N3-pin ${identifier}`, violates: "N3 (rejected)", input: shipToBillTo(identifier), holds: ["unaccounted_identifier"] }));
