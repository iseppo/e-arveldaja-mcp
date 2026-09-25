import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readStatementBalances,
  appendStatementBalance,
  getStatementBalanceIdentityWarning,
  resetStatementBalanceCache,
  type StatementBalanceRecord,
} from "./statement-balance-store.js";
import { initAccountingRulesConnection } from "./accounting-rules.js";
import { MAX_JSON_INPUT_SIZE } from "./tools/crud/shared.js";

const pathMocks = vi.hoisted(() => ({ projectRoot: "" }));
vi.mock("./paths.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return { ...actual, getProjectRoot: () => pathMocks.projectRoot || actual.getProjectRoot() };
});

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

describe("statement-balance store — connection identity in a shared bundle (M3)", () => {
  const useConnection = (stableIdentity: string, connectionCount: number) =>
    initAccountingRulesConnection(() => ({ name: stableIdentity, stableIdentity, connectionCount }));
  afterEach(() => initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" })));

  it("returns only the active connection's records from a shared file and warns about the rest", () => {
    useConnection("fingerprint-company-a", 2);
    appendStatementBalance(RECORD);
    useConnection("fingerprint-company-b", 2);
    appendStatementBalance({ ...RECORD, closingBalance: 999.99 });

    const raw = JSON.parse(readFileSync(join(dir, "statement-balances.json"), "utf8"));
    expect(raw.map((r: { connectionIdentity: string }) => r.connectionIdentity))
      .toEqual(["fingerprint-company-a", "fingerprint-company-b"]);

    resetStatementBalanceCache();
    expect(readStatementBalances()).toEqual([{ ...RECORD, closingBalance: 999.99 }]);
    expect(getStatementBalanceIdentityWarning()).toMatch(/different connection/);

    useConnection("fingerprint-company-a", 2);
    expect(readStatementBalances()).toEqual([RECORD]);
  });

  it("accepts legacy records without identity only when exactly one connection is configured", () => {
    writeFileSync(join(dir, "statement-balances.json"), JSON.stringify([RECORD]), "utf8");
    useConnection("fingerprint-company-a", 1);
    resetStatementBalanceCache();
    expect(readStatementBalances()).toEqual([RECORD]);

    useConnection("fingerprint-company-a", 3);
    resetStatementBalanceCache();
    expect(readStatementBalances()).toEqual([]);
    expect(getStatementBalanceIdentityWarning()).toMatch(/predate per-connection identity/);
  });
  describe("default per-connection hashed bundle dir", () => {
    let configDir: string;
    let projectRoot: string;
    beforeEach(() => {
      delete process.env.EARVELDAJA_RULES_DIR;
      configDir = mkdtempSync(join(tmpdir(), "sb-store-cfg-"));
      projectRoot = mkdtempSync(join(tmpdir(), "sb-store-project-"));
      process.env.EARVELDAJA_CONFIG_DIR = configDir;
      pathMocks.projectRoot = projectRoot;
      resetStatementBalanceCache();
    });
    afterEach(() => {
      delete process.env.EARVELDAJA_CONFIG_DIR;
      pathMocks.projectRoot = "";
      rmSync(configDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    });

    it("applies legacy unstamped records on a multi-connection server (the dir is private to the connection)", () => {
      const hashedDir = join(configDir, "accounting-rules",
        createHash("sha256").update("fingerprint-company-a").digest("hex"));
      mkdirSync(hashedDir, { recursive: true });
      writeFileSync(join(hashedDir, "statement-balances.json"), JSON.stringify([RECORD]), "utf8");

      useConnection("fingerprint-company-a", 3);
      resetStatementBalanceCache();
      expect(readStatementBalances()).toEqual([RECORD]);
      expect(getStatementBalanceIdentityWarning()).toBeNull();
    });
  });
});

describe("statement-balance store — atomic private write and bounded read (L5)", () => {
  it("writes 0600 via temp+rename, leaving no temp file behind", () => {
    appendStatementBalance(RECORD);
    expect(statSync(join(dir, "statement-balances.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter(f => f.includes(".tmp-"))).toEqual([]);
  });

  it("refuses to read (or append to) a file larger than MAX_JSON_INPUT_SIZE", () => {
    writeFileSync(join(dir, "statement-balances.json"), `["${"x".repeat(MAX_JSON_INPUT_SIZE)}"]`, "utf8");
    resetStatementBalanceCache();
    expect(() => readStatementBalances()).toThrow(/maximum size/);
    expect(() => appendStatementBalance(RECORD)).toThrow(/maximum size/);
  });
});
