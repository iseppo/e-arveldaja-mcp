import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readStatementBalances,
  appendStatementBalance,
  resetStatementBalanceCache,
  type StatementBalanceRecord,
} from "./statement-balance-store.js";

const RECORD: StatementBalanceRecord = {
  dimensionId: 101,
  date: "2026-02-28",
  closingBalance: 170.03,
  currency: "EUR",
  source: "camt",
  recordedAt: "2026-07-20T00:00:00.000Z",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-store-"));
  process.env.EARVELDAJA_RULES_DIR = dir;
  resetStatementBalanceCache();
});
afterEach(() => { delete process.env.EARVELDAJA_RULES_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("statement-balance store", () => {
  it("returns an empty list when nothing is captured in bundle mode", () => {
    expect(readStatementBalances()).toEqual([]);
  });

  it("round-trips an appended record", () => {
    appendStatementBalance(RECORD);
    resetStatementBalanceCache();
    expect(readStatementBalances()).toEqual([RECORD]);
  });

  it("appends multiple records under the bundle lock, preserving order", () => {
    appendStatementBalance(RECORD);
    appendStatementBalance({ ...RECORD, date: "2026-03-31", closingBalance: 8.68, source: "wise" });
    resetStatementBalanceCache();
    const stored = readStatementBalances();
    expect(stored).toHaveLength(2);
    expect(stored?.[0]?.date).toBe("2026-02-28");
    expect(stored?.[1]).toMatchObject({ date: "2026-03-31", source: "wise", closingBalance: 8.68 });
    // Persisted to statement-balances.json in the bundle dir
    const raw = JSON.parse(readFileSync(join(dir, "statement-balances.json"), "utf8"));
    expect(raw).toHaveLength(2);
  });

  it("reports a corrupt file rather than throwing raw", () => {
    appendStatementBalance(RECORD);
    writeFileSync(join(dir, "statement-balances.json"), "{ not json", "utf8");
    resetStatementBalanceCache();
    expect(() => readStatementBalances()).toThrow(/statement-balances\.json/i);
  });
});

describe("statement-balance store — single-file EARVELDAJA_RULES_FILE mode", () => {
  let fileDir: string;
  beforeEach(() => {
    fileDir = mkdtempSync(join(tmpdir(), "sb-store-file-"));
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(fileDir, "accounting-rules.md");
    resetStatementBalanceCache();
  });
  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_FILE;
    rmSync(fileDir, { recursive: true, force: true });
  });

  it("readStatementBalances returns null and appendStatementBalance throws (bundle storage required)", () => {
    expect(readStatementBalances()).toBeNull();
    expect(() => appendStatementBalance(RECORD)).toThrow(/bundle storage/i);
  });
});
