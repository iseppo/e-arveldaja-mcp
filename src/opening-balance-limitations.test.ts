import { describe, it, expect } from "vitest";
import { withOpeningBalanceStatus, OPENING_BALANCE_API_LIMITATION_WARNING } from "./opening-balance-limitations.js";

describe("withOpeningBalanceStatus", () => {
  it("appends an actionable warning when not captured", () => {
    const w = withOpeningBalanceStatus([], { captured: false });
    expect(w.some(x => /import_opening_balances/.test(x))).toBe(true);
    expect(w).not.toContain(OPENING_BALANCE_API_LIMITATION_WARNING); // superseded by the actionable form
  });
  it("appends an applied note and no limitation warning when captured", () => {
    const w = withOpeningBalanceStatus([], { captured: true, openingDate: "2024-12-12" });
    expect(w.some(x => /applied.*2024-12-12/i.test(x))).toBe(true);
    expect(w.some(x => /import_opening_balances/.test(x))).toBe(false);
  });
  it("flags unmapped codes when captured", () => {
    const w = withOpeningBalanceStatus([], { captured: true, openingDate: "2024-12-12", unmappedCodes: ["9999"] });
    expect(w.some(x => /9999/.test(x) && /not in the chart/i.test(x))).toBe(true);
  });
});
