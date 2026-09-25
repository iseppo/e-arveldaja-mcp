import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getOpeningBalanceIdentityWarning,
  readOpeningBalances,
  resetOpeningBalanceCache,
  writeOpeningBalances,
} from "./opening-balance-store.js";
import { initAccountingRulesConnection } from "./accounting-rules.js";
import { OPENING_BALANCE_ACTIONABLE_WARNING, withOpeningBalanceStatus } from "./opening-balance-limitations.js";
import { MAX_JSON_INPUT_SIZE } from "./tools/crud/shared.js";
import type { ParsedOpeningBalances } from "./opening-balance-parse.js";

const pathMocks = vi.hoisted(() => ({ projectRoot: "" }));
vi.mock("./paths.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return { ...actual, getProjectRoot: () => pathMocks.projectRoot || actual.getProjectRoot() };
});

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

describe("opening-balance store — single-file EARVELDAJA_RULES_FILE mode", () => {
  let fileDir: string;
  beforeEach(() => {
    fileDir = mkdtempSync(join(tmpdir(), "ob-store-file-"));
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(fileDir, "accounting-rules.md");
    resetOpeningBalanceCache();
  });
  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_FILE;
    rmSync(fileDir, { recursive: true, force: true });
  });

  it("readOpeningBalances returns null and writeOpeningBalances throws (bundle storage required)", () => {
    expect(readOpeningBalances()).toBeNull();
    expect(() => writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z")).toThrow(/bundle storage/i);
  });
});

describe("opening-balance store — connection identity in a shared bundle (M3)", () => {
  const useConnection = (stableIdentity: string, connectionCount: number) =>
    initAccountingRulesConnection(() => ({ name: stableIdentity, stableIdentity, connectionCount }));
  afterEach(() => initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" })));

  it("stamps the active connection and refuses the record on another connection, with a surfaced warning", () => {
    useConnection("fingerprint-company-a", 2);
    const stored = writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z");
    expect(stored.connectionIdentity).toBe("fingerprint-company-a");
    expect(JSON.parse(readFileSync(join(dir, "opening-balances.json"), "utf8")).connectionIdentity)
      .toBe("fingerprint-company-a");

    useConnection("fingerprint-company-b", 2);
    resetOpeningBalanceCache();
    expect(readOpeningBalances()).toBeNull();
    expect(getOpeningBalanceIdentityWarning()).toMatch(/different connection/);
    const warnings = withOpeningBalanceStatus([], { captured: false });
    expect(warnings).toContain(OPENING_BALANCE_ACTIONABLE_WARNING);
    expect(warnings.some(w => /different connection/.test(w))).toBe(true);

    // Same bundle, back on company A: the record applies again (cache keyed by identity).
    useConnection("fingerprint-company-a", 2);
    expect(readOpeningBalances()?.openingDate).toBe("2024-12-12");
    expect(getOpeningBalanceIdentityWarning()).toBeNull();
  });

  it("accepts a legacy record without identity only when exactly one connection is configured", () => {
    const legacy = { ...PARSED, parsedAt: "2026-07-19T00:00:00.000Z", source: "algbilanss_paste" }; // no connectionIdentity
    writeFileSync(join(dir, "opening-balances.json"), JSON.stringify(legacy), "utf8");

    useConnection("fingerprint-company-a", 1);
    resetOpeningBalanceCache();
    expect(readOpeningBalances()?.openingDate).toBe("2024-12-12");

    useConnection("fingerprint-company-a", 2);
    resetOpeningBalanceCache();
    expect(readOpeningBalances()).toBeNull();
    expect(getOpeningBalanceIdentityWarning()).toMatch(/predate per-connection identity/);
  });

  it("mismatch warning mentions re-import after an API key rotation", () => {
    useConnection("fingerprint-company-a", 2);
    writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z");
    useConnection("fingerprint-company-a-rotated", 2);
    resetOpeningBalanceCache();
    expect(readOpeningBalances()).toBeNull();
    expect(getOpeningBalanceIdentityWarning()).toMatch(/API key rotation/);
  });

  describe("default per-connection hashed bundle dir", () => {
    let configDir: string;
    let projectRoot: string;
    beforeEach(() => {
      delete process.env.EARVELDAJA_RULES_DIR;
      configDir = mkdtempSync(join(tmpdir(), "ob-store-cfg-"));
      projectRoot = mkdtempSync(join(tmpdir(), "ob-store-project-"));
      process.env.EARVELDAJA_CONFIG_DIR = configDir;
      pathMocks.projectRoot = projectRoot;
      resetOpeningBalanceCache();
    });
    afterEach(() => {
      delete process.env.EARVELDAJA_CONFIG_DIR;
      pathMocks.projectRoot = "";
      rmSync(configDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    });

    it("applies a legacy unstamped record on a multi-connection server (the dir is private to the connection)", () => {
      const hashedDir = join(configDir, "accounting-rules",
        createHash("sha256").update("fingerprint-company-a").digest("hex"));
      mkdirSync(hashedDir, { recursive: true });
      const legacy = { ...PARSED, parsedAt: "2026-07-19T00:00:00.000Z", source: "algbilanss_paste" };
      writeFileSync(join(hashedDir, "opening-balances.json"), JSON.stringify(legacy), "utf8");

      useConnection("fingerprint-company-a", 2);
      resetOpeningBalanceCache();
      expect(readOpeningBalances()?.openingDate).toBe("2024-12-12");
      expect(getOpeningBalanceIdentityWarning()).toBeNull();
    });
  });
});

describe("opening-balance store — atomic private write and bounded read (L5)", () => {
  it("writes 0600 via temp+rename, leaving no temp file behind", () => {
    writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z");
    expect(statSync(join(dir, "opening-balances.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter(f => f.includes(".tmp-"))).toEqual([]);
  });

  it("refuses to read a file larger than MAX_JSON_INPUT_SIZE", () => {
    writeFileSync(join(dir, "opening-balances.json"), `{"pad":"${"x".repeat(MAX_JSON_INPUT_SIZE)}"}`, "utf8");
    resetOpeningBalanceCache();
    expect(() => readOpeningBalances()).toThrow(/maximum size/);
  });
});
