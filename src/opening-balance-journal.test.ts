import { describe, it, expect } from "vitest";
import { buildOpeningBalanceJournal } from "./opening-balance-journal.js";
import type { Account } from "./types/api.js";
import type { StoredOpeningBalances } from "./opening-balance-store.js";

const ACCOUNTS = [
  { id: 1020, code: 1020, name_est: "Pank", balance_type: "D" },
  { id: 2900, code: 2900, name_est: "Kapital", balance_type: "C" },
] as unknown as Account[];

const STORED: StoredOpeningBalances = {
  openingDate: "2024-12-12",
  accounts: [{ code: "1020", name: "Pank", debit: 1000, credit: 0 },
             { code: "2900", name: "Kapital", debit: 0, credit: 1000 }],
  totals: { debit: 1000, credit: 1000 },
  rawText: "…", parsedAt: "2026-07-19T00:00:00Z", source: "algbilanss_paste",
};

describe("buildOpeningBalanceJournal", () => {
  it("returns null when nothing is stored", () => {
    expect(buildOpeningBalanceJournal(ACCOUNTS, null)).toBeNull();
  });
  it("emits a registered synthetic journal with D/C postings at the opening date", () => {
    const r = buildOpeningBalanceJournal(ACCOUNTS, STORED)!;
    expect(r.journal.effective_date).toBe("2024-12-12");
    expect(r.journal.registered).toBe(true);
    expect(r.journal.is_deleted).toBe(false);
    expect(r.journal.postings).toEqual([
      expect.objectContaining({ accounts_id: 1020, type: "D", amount: 1000, base_amount: 1000 }),
      expect.objectContaining({ accounts_id: 2900, type: "C", amount: 1000, base_amount: 1000 }),
    ]);
    expect(r.unmappedCodes).toEqual([]);
  });
  it("collects codes missing from the chart instead of dropping them silently", () => {
    const stored = { ...STORED, accounts: [...STORED.accounts, { code: "9999", name: "Ghost", debit: 0, credit: 5 }] };
    const r = buildOpeningBalanceJournal(ACCOUNTS, stored)!;
    expect(r.unmappedCodes).toEqual(["9999"]);
    expect(r.journal.postings.some(p => p.accounts_id === 9999)).toBe(false);
  });
});
