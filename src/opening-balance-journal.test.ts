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
    expect(buildOpeningBalanceJournal(ACCOUNTS, [], null)).toBeNull();
  });
  it("emits a registered synthetic journal with D/C postings at the opening date", () => {
    const r = buildOpeningBalanceJournal(ACCOUNTS, [], STORED)!;
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
    const r = buildOpeningBalanceJournal(ACCOUNTS, [], stored)!;
    expect(r.unmappedCodes).toEqual(["9999"]);
    expect(r.journal.postings.some(p => p.accounts_id === 9999)).toBe(false);
  });
  it("emits both a D and a C posting for an account with nonzero debit and credit", () => {
    const stored = { ...STORED, accounts: [{ code: "1020", name: "Pank", debit: 400, credit: 150 }] };
    const r = buildOpeningBalanceJournal(ACCOUNTS, [], stored)!;
    expect(r.journal.postings).toEqual([
      expect.objectContaining({ accounts_id: 1020, type: "D", amount: 400, base_amount: 400 }),
      expect.objectContaining({ accounts_id: 1020, type: "C", amount: 150, base_amount: 150 }),
    ]);
  });

  const acc = (id: number) => ({ id, balance_type: "D", name_est: "", name_eng: "" } as any);
  const dim = (id: number, accounts_id: number, title_est: string) => ({ id, accounts_id, title_est } as any);
  const stored = (accounts: any[]) => ({ openingDate: "2024-12-31", accounts, totals: { debit: 0, credit: 0 }, rawText: "", parsedAt: "", source: "algbilanss_paste" } as any);

  it("attributes the sole dimension automatically", () => {
    const r = buildOpeningBalanceJournal([acc(1010)], [dim(12637391, 1010, "Sularaha kassas")],
      stored([{ code: "1010", name: "", debit: 100, credit: 0, dimension: [] }]))!;
    expect(r.journal.postings!.every(p => p.accounts_dimensions_id === 12637391)).toBe(true);
    expect(r.unmappedDimensions).toEqual([]);
  });

  it("matches a multi-dimension label exactly", () => {
    const dims = [dim(12637392, 1020, "AS LHV Pank EE637700771011212909"), dim(13172505, 1020, "WISE BE08905767222113")];
    const r = buildOpeningBalanceJournal([acc(1020)], dims,
      stored([{ code: "1020", name: "AS LHV Pank EE637700771011212909", debit: 1000, credit: 0, dimension: ["AS LHV Pank EE637700771011212909"] }]))!;
    const d = r.journal.postings!.find(p => p.type === "D")!;
    expect(d.accounts_dimensions_id).toBe(12637392);
    expect(r.unmappedDimensions).toEqual([]);
  });

  it("books without a dimension and warns when a multi-dimension label does not match", () => {
    const dims = [dim(12637392, 1020, "AS LHV Pank EE637700771011212909"), dim(13172505, 1020, "WISE BE08905767222113")];
    const r = buildOpeningBalanceJournal([acc(1020)], dims,
      stored([{ code: "1020", name: "Arvelduskontod", debit: 1000, credit: 0, dimension: ["Arvelduskontod"] }]))!;
    const d = r.journal.postings!.find(p => p.type === "D")!;
    expect(d.accounts_dimensions_id ?? null).toBeNull();
    expect(r.unmappedDimensions).toHaveLength(1);
  });

  it("does not silently first-pick when two active dims share an identical title (exact-match ambiguity)", () => {
    const dims = [dim(12637392, 1020, "Arvelduskonto"), dim(13172505, 1020, "Arvelduskonto")];
    const r = buildOpeningBalanceJournal([acc(1020)], dims,
      stored([{ code: "1020", name: "Arvelduskonto", debit: 1000, credit: 0, dimension: ["Arvelduskonto"] }]))!;
    const d = r.journal.postings!.find(p => p.type === "D")!;
    expect(d.accounts_dimensions_id ?? null).toBeNull();
    expect(r.unmappedDimensions).toHaveLength(1);
  });

  it("loads legacy stored data without a dimension field (single-dim resolves, multi-dim warns)", () => {
    const dims = [dim(12637392, 1020, "AS LHV Pank EE637700771011212909"), dim(13172505, 1020, "WISE BE08905767222113")];
    const r = buildOpeningBalanceJournal([acc(1020)], dims,
      stored([{ code: "1020", name: "", debit: 1000, credit: 0 } as any]))!;
    expect(r.journal.postings!.find(p => p.type === "D")!.accounts_dimensions_id ?? null).toBeNull();
    expect(r.unmappedDimensions).toHaveLength(1);
  });
});
