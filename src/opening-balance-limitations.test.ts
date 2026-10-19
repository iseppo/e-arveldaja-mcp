import { describe, expect, it } from "vitest";
import { withOpeningBalanceJournalStatus } from "./opening-balance-limitations.js";
import type { OpeningBalanceJournal } from "./opening-balance-journal.js";

const opening: OpeningBalanceJournal = { source: "api", openingDate: "2025-01-01", journal: {
  id: 88, operation_type: "INITIAL", effective_date: "2025-01-01", registered: true, is_deleted: false,
  postings: [{ accounts_id: 1020, type: "D", amount: 200 }],
} };
describe("API opening disclosure", () => {
  it("treats no INITIAL as normal and preserves unrelated warnings", () => {
    expect(withOpeningBalanceJournalStatus(["unrelated"], null, undefined, undefined)).toEqual(["unrelated"]);
  });
  it("identifies an API opening applied within the date range", () => {
    const warnings = withOpeningBalanceJournalStatus(["unrelated"], opening, "2025-01-01", "2025-12-31");
    expect(warnings[0]).toBe("unrelated");
    expect(warnings[1]).toMatch(/applied from API INITIAL.*2025-01-01/);
  });
  it.each([["2025-01-02", undefined], [undefined, "2024-12-31"]])("preserves exclusions from %s through %s", (from, to) => {
    const warnings = withOpeningBalanceJournalStatus([], opening, from, to);
    expect(warnings.join(" ")).toMatch(/outside this date range/);
    expect(warnings.join(" ")).not.toMatch(/applied|import_opening|local|fallback/i);
  });
  it.each([
    { registered: false, is_deleted: false, postings: opening.journal.postings, reason: "unregistered" },
    { registered: true, is_deleted: true, postings: opening.journal.postings, reason: "deleted" },
    { registered: true, is_deleted: false, postings: [], reason: "without active postings" },
  ])("does not claim an incomplete opening was applied: $reason", ({ reason, ...state }) => {
    const warnings = withOpeningBalanceJournalStatus([], { ...opening, journal: { ...opening.journal, ...state } }, undefined, "2025-12-31");
    expect(warnings.join(" ")).toContain(reason);
    expect(warnings.join(" ")).not.toMatch(/applied|re-import|import_opening|local|fallback/i);
  });
});
