import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOpeningBalances, writeOpeningBalances, resetOpeningBalanceCache } from "./opening-balance-store.js";
import type { ParsedOpeningBalances } from "./opening-balance-parse.js";

const PARSED: ParsedOpeningBalances = {
  openingDate: "2024-12-12",
  accounts: [{ code: "1020", name: "Pank", debit: 1000, credit: 0 },
             { code: "2900", name: "Kapital", debit: 0, credit: 1000 }],
  totals: { debit: 1000, credit: 1000 },
  rawText: "…",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ob-store-"));
  process.env.EARVELDAJA_RULES_DIR = dir;
  resetOpeningBalanceCache();
});
afterEach(() => { delete process.env.EARVELDAJA_RULES_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("opening-balance store", () => {
  it("returns null when nothing is captured", () => {
    expect(readOpeningBalances()).toBeNull();
  });
  it("round-trips a write", () => {
    const stored = writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z");
    expect(stored.source).toBe("algbilanss_paste");
    resetOpeningBalanceCache();
    expect(readOpeningBalances()).toMatchObject({ openingDate: "2024-12-12", source: "algbilanss_paste" });
  });
  it("replaces on re-import", () => {
    writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z");
    writeOpeningBalances({ ...PARSED, openingDate: "2025-01-01" }, "2026-07-19T01:00:00.000Z");
    resetOpeningBalanceCache();
    expect(readOpeningBalances()?.openingDate).toBe("2025-01-01");
  });
  it("reports a corrupt file rather than throwing raw", () => {
    writeFileSync(join(dir, "opening-balances.json"), "{ not json", "utf8");
    resetOpeningBalanceCache();
    expect(() => readOpeningBalances()).toThrow(/opening-balances\.json/i);
  });
});
