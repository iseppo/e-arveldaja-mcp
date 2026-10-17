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
