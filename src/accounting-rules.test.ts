import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsInspectionMock = vi.hoisted(() => ({
  readdirSyncEaccesPath: undefined as string | undefined,
  readdirSyncEaccesHits: 0,
  legacyReadEaccesPath: undefined as string | undefined,
  legacyReadEaccesHits: 0,
}));

vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: ((...args: any[]) => {
      if (String(args[0]) === fsInspectionMock.legacyReadEaccesPath) {
        return false;
      }
      return (actual.existsSync as (...values: any[]) => any)(...args);
    }) as typeof actual.existsSync,
    readdirSync: ((...args: any[]) => {
      if (String(args[0]) === fsInspectionMock.readdirSyncEaccesPath) {
        fsInspectionMock.readdirSyncEaccesHits += 1;
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(args[0])}'`), {
          code: "EACCES",
        });
      }
      return (actual.readdirSync as (...values: any[]) => any)(...args);
    }) as typeof actual.readdirSync,
    readFileSync: ((...args: any[]) => {
      if (String(args[0]) === fsInspectionMock.legacyReadEaccesPath) {
        fsInspectionMock.legacyReadEaccesHits += 1;
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(args[0])}'`), {
          code: "EACCES",
        });
      }
      return (actual.readFileSync as (...values: any[]) => any)(...args);
    }) as typeof actual.readFileSync,
  };
});

import * as accountingRules from "./accounting-rules.js";
import type { AccountingAutoBookingRule } from "./accounting-rules.js";
import {
  chooseDefaultBundleStorage,
  findAutoBookingRule,
  getAccountingKnowledgeOverview,
  getCashFlowCategoryRule,
  getAccountingRulesPath,
  getCurrentYearProfitAccountRule,
  getDefaultOwnerExpenseVatDeductionMode,
  getDefaultOwnerExpenseVatDeductionRatio,
  getLiabilityClassificationRule,
  getOwnerExpenseVatDeductionModeForAccount,
  getOwnerExpenseVatDeductionRatioForAccount,
  lockHolderAlive,
  migrateLegacyRulesToBundle,
  readAccountingKnowledgeConcept,
  resetAccountingRulesCache,
  saveAutoBookingRule,
  withBundleLock,
} from "./accounting-rules.js";

const ORIGINAL_RULES_FILE = process.env.EARVELDAJA_RULES_FILE;
const ORIGINAL_RULES_DIR = process.env.EARVELDAJA_RULES_DIR;
const ORIGINAL_CONFIG_DIR = process.env.EARVELDAJA_CONFIG_DIR;

function legacyAutoBookingRules(rows: string[]): string {
  return `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
${rows.join("\n")}
`;
}

function snapshotTree(root: string): Array<[string, "dir" | string]> {
  if (!existsSync(root)) return [];
  const entries: Array<[string, "dir" | string]> = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      const file = join(path, name);
      const rel = relative(root, file).replace(/\\/g, "/");
      if (statSync(file).isDirectory()) {
        entries.push([rel, "dir"]);
        visit(file);
      } else {
        entries.push([rel, readFileSync(file).toString("base64")]);
      }
    }
  };
  visit(root);
  return entries;
}

function captureErrorMessage(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

afterEach(() => {
  fsInspectionMock.readdirSyncEaccesPath = undefined;
  fsInspectionMock.readdirSyncEaccesHits = 0;
  fsInspectionMock.legacyReadEaccesPath = undefined;
  fsInspectionMock.legacyReadEaccesHits = 0;
  if (ORIGINAL_RULES_FILE === undefined) {
    delete process.env.EARVELDAJA_RULES_FILE;
  } else {
    process.env.EARVELDAJA_RULES_FILE = ORIGINAL_RULES_FILE;
  }
  if (ORIGINAL_RULES_DIR === undefined) {
    delete process.env.EARVELDAJA_RULES_DIR;
  } else {
    process.env.EARVELDAJA_RULES_DIR = ORIGINAL_RULES_DIR;
  }
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.EARVELDAJA_CONFIG_DIR;
  } else {
    process.env.EARVELDAJA_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  }
  const initConnection = (accountingRules as any).initAccountingRulesConnection;
  if (typeof initConnection === "function") {
    initConnection(() => ({ name: "default", stableIdentity: "default" }));
  }
  resetAccountingRulesCache();
});

describe("accounting-rules markdown parsing", () => {
  it("loads markdown table rules from a custom file", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id | purchase_account_id | liability_account_id | vat_rate_dropdown | reversed_vat_id | reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| openai | saas_subscriptions | 501 | 5230 | 2310 | 24 | 1 | Reuse OpenAI treatment |

## Owner Expense Reimbursement
Default VAT deduction mode: partial ratio 0.5
| expense_account | vat_deduction_mode | vat_deduction_ratio |
| --- | --- | --- |
| 5230 | none | |
| 5250 | partial | 0.25 |

## Annual Report
Current year profit account: 2999

## Liability Classification
| account_id | classification |
| --- | --- |
| 2100 | non_current |

## Cash Flow Category
| account_id | category |
| --- | --- |
| 2100 | financing |
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
      reversed_vat_id: 1,
    });
    expect(getDefaultOwnerExpenseVatDeductionMode()).toBe("partial");
    expect(getDefaultOwnerExpenseVatDeductionRatio()).toBe(0.5);
    expect(getOwnerExpenseVatDeductionModeForAccount(5230)).toBe("none");
    expect(getOwnerExpenseVatDeductionModeForAccount(5250)).toBe("partial");
    expect(getOwnerExpenseVatDeductionRatioForAccount(5250)).toBe(0.25);
    expect(getCurrentYearProfitAccountRule()).toBe(2999);
    expect(getLiabilityClassificationRule(2100)).toBe("non_current");
    expect(getCashFlowCategoryRule(2100)).toBe("financing");

    rmSync(dir, { recursive: true, force: true });
  });

  it("matches counterparty rules against normalized company names", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Auto Booking
| match | purchase_article_id |
| --- | --- |
| Fraqmented OÜ | 501 |
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("fraqmented", undefined)).toMatchObject({
      purchase_article_id: 501,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers category-specific counterparty rules over generic supplier rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| openai |  | 100 |
| openai | saas_subscriptions | 501 |
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
    });
    expect(findAutoBookingRule("openai ireland limited", "unknown")).toMatchObject({
      purchase_article_id: 100,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not return category-scoped rules from supplier-only lookups", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| wise | bank_fees | 8610 |
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("wise europe sa", undefined)).toBeUndefined();
    expect(findAutoBookingRule("wise europe sa", "bank_fees")).toMatchObject({
      purchase_article_id: 8610,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("reloads rules after the markdown file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");

    writeFileSync(filePath, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| openai | saas_subscriptions | 501 |
`, "utf-8");
    utimesSync(filePath, new Date("2026-03-20T10:00:00.000Z"), new Date("2026-03-20T10:00:00.000Z"));

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
    });

    writeFileSync(filePath, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| anthropic | saas_subscriptions | 777 |
`, "utf-8");
    utimesSync(filePath, new Date("2026-03-20T10:00:02.000Z"), new Date("2026-03-20T10:00:02.000Z"));

    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toBeUndefined();
    expect(findAutoBookingRule("anthropic pbc", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 777,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores documented examples unless a plain-text default line is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Owner Expense Reimbursement
- \`Default VAT deduction mode: full\`
- \`Default VAT deduction mode: partial ratio 0.5\`
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(getDefaultOwnerExpenseVatDeductionMode()).toBeUndefined();
    expect(getDefaultOwnerExpenseVatDeductionRatio()).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts an auto-booking rule into accounting-rules.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Auto Booking

| match | category | purchase_article_id | purchase_account_id | purchase_account_dimensions_id | liability_account_id | vat_rate_dropdown | reversed_vat_id | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openai | saas_subscriptions | 1 | 2 |  | 2310 | - | 1 | old |
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    const result = saveAutoBookingRule({
      match: "openai",
      category: "saas_subscriptions",
      purchase_article_id: 501,
      purchase_account_id: 5230,
      liability_account_id: 2315,
      vat_rate_dropdown: "-",
      reversed_vat_id: 1,
      reason: "Updated default",
    });

    expect(result).toMatchObject({
      path: filePath,
      action: "updated",
      match: "openai",
      category: "saas_subscriptions",
    });
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
      purchase_account_id: 5230,
      liability_account_id: 2315,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("canonicalizes sandbox-wrapped match and reason before persisting (F-RULE-SAVE-CANONICAL)", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    const nonce = "deadbeef";
    // Real wrapper framing (newlines around the content), so the test exercises
    // the whole-value unwrap loop, not just residual-token removal.
    const wrap = (s: string) => `<<UNTRUSTED_OCR_START:${nonce}>>\n${s}\n<<UNTRUSTED_OCR_END:${nonce}>>`;
    const result = saveAutoBookingRule({
      match: wrap("Stripe Payments OÜ"),
      category: "saas_subscriptions",
      purchase_article_id: 501,
      purchase_account_id: 5230,
      liability_account_id: 2315,
      vat_rate_dropdown: wrap("24"),
      reason: wrap("auto-detected"),
    });

    // The returned key and the persisted store carry no sandbox marker — across
    // match, reason, AND vat_rate_dropdown (all free-text rule fields).
    expect(result.match).toBe("Stripe Payments OÜ");
    const persisted = readFileSync(filePath, "utf-8");
    expect(persisted).not.toContain("UNTRUSTED_OCR");
    expect(persisted).toContain("Stripe Payments OÜ");
    expect(persisted).toContain("auto-detected");
    // The persisted rule resolves on the clean stem, not the marker text.
    expect(findAutoBookingRule("stripe payments oü", "saas_subscriptions")).toMatchObject({
      purchase_account_id: 5230,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a direct saveAutoBookingRule call whose only action field is a marker-only vat_rate_dropdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    const nonce = "deadbeef";
    const wrap = (s: string) => `<<UNTRUSTED_OCR_START:${nonce}>>\n${s}\n<<UNTRUSTED_OCR_END:${nonce}>>`;

    // The authoritative boundary maps the canonicalized-empty VAT to undefined, so
    // the schema's "at least one concrete field" refinement rejects the call even
    // though it bypasses the tool-handler / prepare-path guards.
    expect(() => saveAutoBookingRule({
      match: "openai",
      category: "saas_subscriptions",
      vat_rate_dropdown: wrap("   "),
    })).toThrow(/at least one concrete/i);

    rmSync(dir, { recursive: true, force: true });
  });

  it("updates an existing rule when the saved match normalizes to the same counterparty stem", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Auto Booking

| match | category | purchase_article_id | purchase_account_id | purchase_account_dimensions_id | liability_account_id | vat_rate_dropdown | reversed_vat_id | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fraqmented | saas_subscriptions | 1 | 2 |  | 2310 | - | 1 | old |
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    const result = saveAutoBookingRule({
      match: "Fraqmented OÜ",
      category: "saas_subscriptions",
      purchase_article_id: 501,
      purchase_account_id: 5230,
      liability_account_id: 2315,
      vat_rate_dropdown: "-",
      reversed_vat_id: 1,
      reason: "Normalized update",
    });

    const saved = readFileSync(filePath, "utf8");

    expect(result.action).toBe("updated");
    expect(saved).toContain("| Fraqmented OÜ | saas_subscriptions | 501 | 5230 |  | 2315 | - | 1 | Normalized update |");
    expect(saved).not.toContain("| Fraqmented | saas_subscriptions | 1 | 2 |  | 2310 | - | 1 | old |");
    expect(findAutoBookingRule("fraqmented ou", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
      purchase_account_id: 5230,
      liability_account_id: 2315,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores reason-only auto-booking rows because they do not encode a booking decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, `# Accounting Rules

## Auto Booking
| match | category | reason |
| --- | --- | --- |
| openai | saas_subscriptions | informational note only |
`, "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects saving an auto-booking rule without any booking fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "accounting-rules.md");
    writeFileSync(filePath, "# Accounting Rules\n\n## Auto Booking\n", "utf-8");

    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    expect(() => saveAutoBookingRule({
      match: "openai",
      category: "saas_subscriptions",
      reason: "note only",
    })).toThrow(/at least one concrete booking field/i);

    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the default rules file when saving a rule into a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const filePath = join(dir, "missing-rules.md");
    process.env.EARVELDAJA_RULES_FILE = filePath;
    resetAccountingRulesCache();

    const result = saveAutoBookingRule({
      match: "wise",
      category: "bank_fees",
      purchase_account_id: 8610,
      reason: "Wise bank fee default",
    });

    expect(result.action).toBe("inserted");
    expect(getAccountingRulesPath()).toBe(filePath);
    expect(findAutoBookingRule("wise europe sa", "bank_fees")).toMatchObject({
      purchase_account_id: 8610,
    });

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("accounting-rules OKF bundle storage", () => {
  it("saves an auto-booking rule as an OKF concept file and upserts in place", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-bundle-"));
    const bundleDir = join(root, "bundle");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    const result = saveAutoBookingRule({
      match: "OpenAI",
      category: "saas_subscriptions",
      purchase_article_id: 501,
      purchase_account_id: 5230,
      reversed_vat_id: 1,
      reason: "Reverse-charge SaaS",
    });

    expect(result.action).toBe("inserted");
    expect(result.path).toContain(join("bundle", "auto-booking"));
    const concept = readFileSync(result.path, "utf8");
    expect(concept).toContain("type: SupplierBookingRule");
    expect(concept).toContain("purchase_article_id: 501");
    expect(concept).toContain("reversed_vat_id: 1");

    expect(getAccountingRulesPath()).toBe(bundleDir);
    expect(existsSync(join(bundleDir, "index.md"))).toBe(true);
    expect(existsSync(join(bundleDir, "log.md"))).toBe(true);
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
      reversed_vat_id: 1,
    });

    const second = saveAutoBookingRule({
      match: "OpenAI",
      category: "saas_subscriptions",
      purchase_article_id: 502,
      purchase_account_id: 5230,
    });
    expect(second.action).toBe("updated");
    expect(second.path).toBe(result.path);
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 502,
    });

    rmSync(root, { recursive: true, force: true });
  });

  it("reads a hand-written OKF concept file with frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-bundle-"));
    const bundleDir = join(root, "bundle");
    mkdirSync(join(bundleDir, "auto-booking"), { recursive: true });
    writeFileSync(join(bundleDir, "auto-booking", "wise.md"), `---
type: SupplierBookingRule
title: Wise bank fees
match: wise
category: bank_fees
purchase_account_id: 8610
---
Wise transfer fee.
`, "utf-8");

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("wise europe sa", "bank_fees")).toMatchObject({
      purchase_account_id: 8610,
    });
    expect(findAutoBookingRule("wise europe sa", undefined)).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("reloads bundle rules after a concept file changes", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-bundle-"));
    const bundleDir = join(root, "bundle");
    const conceptDir = join(bundleDir, "auto-booking");
    mkdirSync(conceptDir, { recursive: true });
    const conceptFile = join(conceptDir, "openai--saas_subscriptions.md");

    writeFileSync(conceptFile, `---
type: SupplierBookingRule
match: openai
category: saas_subscriptions
purchase_article_id: 501
---
`, "utf-8");
    utimesSync(conceptFile, new Date("2026-03-20T10:00:00.000Z"), new Date("2026-03-20T10:00:00.000Z"));

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
    });

    writeFileSync(conceptFile, `---
type: SupplierBookingRule
match: openai
category: saas_subscriptions
purchase_article_id: 777
---
`, "utf-8");
    utimesSync(conceptFile, new Date("2026-03-20T10:00:02.000Z"), new Date("2026-03-20T10:00:02.000Z"));

    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 777,
    });

    rmSync(root, { recursive: true, force: true });
  });

  it("migrates a legacy accounting-rules.md into the bundle on first save", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-bundle-"));
    const legacyFile = join(root, "accounting-rules.md");
    const bundleDir = join(root, "bundle");
    writeFileSync(legacyFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id | purchase_account_id |
| --- | --- | --- | --- |
| openai | saas_subscriptions | 501 | 5230 |

## Owner Expense Reimbursement
Default VAT deduction mode: partial ratio 0.5
| expense_account | vat_deduction_mode | vat_deduction_ratio |
| --- | --- | --- |
| 5250 | partial | 0.25 |

## Annual Report
Current year profit account: 2999

## Liability Classification
| account_id | classification |
| --- | --- |
| 2100 | non_current |

## Cash Flow Category
| account_id | category |
| --- | --- |
| 2100 | financing |
`, "utf-8");

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    const result = saveAutoBookingRule({
      match: "anthropic",
      category: "saas_subscriptions",
      purchase_article_id: 777,
      purchase_account_id: 5230,
    });

    expect(result.action).toBe("inserted");
    // Legacy file is archived, never silently left to diverge.
    expect(existsSync(legacyFile)).toBe(false);
    expect(existsSync(`${legacyFile}.migrated`)).toBe(true);
    // Migrated rule and the freshly saved rule both resolve.
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
    });
    expect(findAutoBookingRule("anthropic pbc", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 777,
    });
    // Every legacy rule family survived migration.
    expect(getDefaultOwnerExpenseVatDeductionMode()).toBe("partial");
    expect(getDefaultOwnerExpenseVatDeductionRatio()).toBe(0.5);
    expect(getOwnerExpenseVatDeductionRatioForAccount(5250)).toBe(0.25);
    expect(getCurrentYearProfitAccountRule()).toBe(2999);
    expect(getLiabilityClassificationRule(2100)).toBe("non_current");
    expect(getCashFlowCategoryRule(2100)).toBe("financing");
    // OKF scaffolding exists and the log records the migration.
    expect(existsSync(join(bundleDir, "index.md"))).toBe(true);
    expect(readFileSync(join(bundleDir, "log.md"), "utf8")).toMatch(/migrated/);

    rmSync(root, { recursive: true, force: true });
  });

  it("migrateLegacyRulesToBundle reports what it converted", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-bundle-"));
    const legacyFile = join(root, "accounting-rules.md");
    const bundleDir = join(root, "bundle");
    writeFileSync(legacyFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| openai | saas_subscriptions | 501 |
| wise | bank_fees | 8610 |
`, "utf-8");

    const summary = migrateLegacyRulesToBundle(legacyFile, bundleDir);

    expect(summary.migrated).toBe(true);
    expect(summary.counterparties).toBe(2);
    expect(summary.files.length).toBe(2);
    expect(existsSync(`${legacyFile}.migrated`)).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("accounting-rules knowledge surface (MCP resources)", () => {
  it("lists bundle concepts and reads a concept by relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-know-"));
    const bundleDir = join(root, "bundle");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    const saved = saveAutoBookingRule({
      match: "OpenAI",
      category: "saas_subscriptions",
      purchase_article_id: 501,
      purchase_account_id: 5230,
    });

    const overview = getAccountingKnowledgeOverview();
    expect(overview.mode).toBe("bundle");
    expect(overview.root).toBe(bundleDir);
    expect(overview.indexMarkdown).toContain("okf_version");
    const autoBooking = overview.concepts.find(c => c.type === "SupplierBookingRule");
    expect(autoBooking).toBeDefined();
    expect(autoBooking!.uri).toBe(`earveldaja://accounting_knowledge/${autoBooking!.rel}`);
    expect(overview.concepts.some(c => c.rel === "log.md")).toBe(true);

    const concept = readAccountingKnowledgeConcept(autoBooking!.rel);
    expect(concept?.text).toContain("type: SupplierBookingRule");
    expect(concept?.text).toContain("purchase_article_id: 501");
    // Bundle-rooted link form (leading slash) also resolves.
    expect(readAccountingKnowledgeConcept(`/${autoBooking!.rel}`)?.text).toContain("type: SupplierBookingRule");

    expect(saved.action).toBe("inserted");
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses path traversal and non-markdown reads", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-know-"));
    const bundleDir = join(root, "bundle");
    mkdirSync(join(bundleDir, "auto-booking"), { recursive: true });
    writeFileSync(join(bundleDir, "auto-booking", "openai.md"), `---
type: SupplierBookingRule
match: openai
purchase_article_id: 501
---
`, "utf-8");
    // A secret sitting outside the bundle directory.
    writeFileSync(join(root, "secret.md"), "TOP SECRET", "utf-8");

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    expect(readAccountingKnowledgeConcept("../secret.md")).toBeUndefined();
    expect(readAccountingKnowledgeConcept("auto-booking/../../secret.md")).toBeUndefined();
    expect(readAccountingKnowledgeConcept("auto-booking/missing.md")).toBeUndefined();
    expect(readAccountingKnowledgeConcept("auto-booking/openai.txt")).toBeUndefined();
    // The legitimate concept still reads.
    expect(readAccountingKnowledgeConcept("auto-booking/openai.md")?.text).toContain("match: openai");

    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to the legacy file as the index when no bundle exists", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-know-"));
    const filePath = join(root, "rules.md");
    writeFileSync(filePath, "# Accounting Rules\n\n## Auto Booking\n", "utf-8");
    process.env.EARVELDAJA_RULES_FILE = filePath;
    delete process.env.EARVELDAJA_RULES_DIR;
    resetAccountingRulesCache();

    const overview = getAccountingKnowledgeOverview();
    expect(overview.mode).toBe("legacy-file");
    expect(overview.root).toBe(filePath);
    expect(overview.indexMarkdown).toContain("Accounting Rules");
    expect(overview.concepts).toHaveLength(0);
    // No bundle, so concept reads are unavailable.
    expect(readAccountingKnowledgeConcept("auto-booking/anything.md")).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("reports an empty knowledge surface when nothing has been written", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-know-"));
    const bundleDir = join(root, "bundle");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    const overview = getAccountingKnowledgeOverview();
    expect(overview.mode).toBe("empty");
    expect(overview.concepts).toHaveLength(0);
    expect(overview.indexMarkdown).toContain("No company-specific accounting knowledge");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("accounting-rules OKF hardening (code-review follow-ups)", () => {
  it("prefers the most specific (longest) match regardless of file ordering", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-prec-"));
    const bundleDir = join(root, "bundle");
    const dir = join(bundleDir, "auto-booking");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(bundleDir, "index.md"), "---\nokf_version: \"0.1\"\n---\n", "utf-8");
    // Alphabetical filename order puts the generic "acme" before "acmewidgets".
    writeFileSync(join(dir, "acme.md"), `---
type: SupplierBookingRule
match: acme
category: saas_subscriptions
purchase_article_id: 100
---
`, "utf-8");
    writeFileSync(join(dir, "acmewidgets.md"), `---
type: SupplierBookingRule
match: acmewidgets
category: saas_subscriptions
purchase_article_id: 501
---
`, "utf-8");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    expect(findAutoBookingRule("acmewidgets", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
    });
    // The generic rule still wins for a counterparty that only matches it.
    expect(findAutoBookingRule("acme", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 100,
    });

    rmSync(root, { recursive: true, force: true });
  });

  it("sanitizes newlines in saved rule fields so the concept round-trips", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-nl-"));
    const bundleDir = join(root, "bundle");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    const result = saveAutoBookingRule({
      match: "OpenAI",
      category: "saas_subscriptions",
      purchase_article_id: 501,
      purchase_account_id: 5230,
      reason: "line one\n---\nmalicious: true\nline two",
    });

    const text = readFileSync(result.path, "utf8");
    // Exactly the opening and closing frontmatter fences — the injected `---`
    // line did not create a third standalone fence.
    expect(text.split("\n").filter(line => line.trim() === "---").length).toBe(2);

    resetAccountingRulesCache();
    const rule = findAutoBookingRule("openai", "saas_subscriptions");
    expect(rule?.purchase_article_id).toBe(501);
    expect(rule?.reason).toBe("line one --- malicious: true line two");

    rmSync(root, { recursive: true, force: true });
  });

  it("does not let an empty/uninitialized bundle dir shadow legacy rules", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-shadow-"));
    const legacyFile = join(root, "accounting-rules.md");
    const bundleDir = join(root, "accounting-rules-bundle");
    // An empty directory exists where the bundle would go, but it has no index.md.
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(legacyFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| openai | saas_subscriptions | 501 |
`, "utf-8");
    // Make the legacy file the sibling the bundle resolves to.
    const siblingLegacy = join(root, "accounting-rules.md");
    expect(siblingLegacy).toBe(legacyFile);

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    // Legacy rule is still read despite the empty bundle directory existing.
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
    });

    // First write migrates the legacy file into the existing (uninitialized) dir.
    saveAutoBookingRule({ match: "anthropic", category: "saas_subscriptions", purchase_article_id: 777 });
    expect(existsSync(join(bundleDir, "index.md"))).toBe(true);
    expect(existsSync(`${legacyFile}.migrated`)).toBe(true);
    expect(findAutoBookingRule("anthropic pbc", "saas_subscriptions")).toMatchObject({ purchase_article_id: 777 });
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({ purchase_article_id: 501 });

    rmSync(root, { recursive: true, force: true });
  });

  it("migrates atomically and leaves no staging directory behind", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-atomic-"));
    const legacyFile = join(root, "accounting-rules.md");
    const bundleDir = join(root, "bundle");
    writeFileSync(legacyFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| openai | saas_subscriptions | 501 |
`, "utf-8");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    saveAutoBookingRule({ match: "anthropic", category: "saas_subscriptions", purchase_article_id: 777 });

    expect(existsSync(`${bundleDir}.migrating`)).toBe(false);
    expect(existsSync(join(bundleDir, "index.md"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("guards concept reads against null bytes and percent-encodes URIs for spaced filenames", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-uri-"));
    const bundleDir = join(root, "bundle");
    mkdirSync(join(bundleDir, "auto-booking"), { recursive: true });
    writeFileSync(join(bundleDir, "index.md"), "---\nokf_version: \"0.1\"\n---\n", "utf-8");
    writeFileSync(join(bundleDir, "auto-booking", "my rule.md"), `---
type: SupplierBookingRule
title: Spaced rule
match: openai
purchase_article_id: 501
---
`, "utf-8");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    const overview = getAccountingKnowledgeOverview();
    const spaced = overview.concepts.find(c => c.rel === "auto-booking/my rule.md");
    expect(spaced).toBeDefined();
    expect(spaced!.uri).toBe("earveldaja://accounting_knowledge/auto-booking/my%20rule.md");
    // The decoded relative path reads back.
    expect(readAccountingKnowledgeConcept("auto-booking/my rule.md")?.text).toContain("title: Spaced rule");
    // Null byte is rejected, not thrown.
    expect(readAccountingKnowledgeConcept("auto-booking/openai\0.md")).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("does not let a reserved-file-only bundle (index/log) shadow legacy rules", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-reserved-"));
    const legacyFile = join(root, "accounting-rules.md");
    const bundleDir = join(root, "accounting-rules");
    // A bundle dir exists but holds ONLY reserved files — no real concepts.
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "index.md"), "---\nokf_version: \"0.1\"\n---\n", "utf-8");
    writeFileSync(join(bundleDir, "log.md"), "# Log\n", "utf-8");
    writeFileSync(legacyFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| openai | saas_subscriptions | 501 |
`, "utf-8");

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    // The reserved-only bundle must NOT shadow the legacy rule.
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({
      purchase_article_id: 501,
    });

    // First write migrates the legacy rule into the existing bundle dir.
    saveAutoBookingRule({ match: "anthropic", category: "saas_subscriptions", purchase_article_id: 777 });
    expect(existsSync(`${legacyFile}.migrated`)).toBe(true);
    resetAccountingRulesCache();
    expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({ purchase_article_id: 501 });
    expect(findAutoBookingRule("anthropic pbc", "saas_subscriptions")).toMatchObject({ purchase_article_id: 777 });

    rmSync(root, { recursive: true, force: true });
  });

  it("knowledge overview reflects the legacy source, not a reserved-only bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-reserved-overview-"));
    const legacyFile = join(root, "accounting-rules.md");
    const bundleDir = join(root, "accounting-rules");
    // A bundle dir with ONLY reserved files (index/log) sitting next to a legacy
    // file that still holds the rules the booking logic reads.
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "index.md"), "---\nokf_version: \"0.1\"\n---\n", "utf-8");
    writeFileSync(join(bundleDir, "log.md"), "# Log\n", "utf-8");
    writeFileSync(legacyFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| openai | saas_subscriptions | 501 |
`, "utf-8");

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    // The browse surface must agree with the booking source (the legacy file),
    // not surface the empty reserved-only bundle.
    const overview = getAccountingKnowledgeOverview();
    expect(overview.mode).toBe("legacy-file");
    expect(overview.root).toBe(legacyFile);
    expect(overview.indexMarkdown).toContain("Auto Booking");
    // Concept reads stay unavailable until a real bundle exists.
    expect(readAccountingKnowledgeConcept("auto-booking/openai.md")).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("migrating into an already-authoritative bundle merges, never wipes existing concepts", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-merge-"));
    const legacyFile = join(root, "accounting-rules.md");
    const bundleDir = join(root, "accounting-rules");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    // An authoritative bundle with a real concept already exists.
    saveAutoBookingRule({ match: "stripe", category: "saas_subscriptions", purchase_article_id: 111 });
    expect(findAutoBookingRule("stripe inc", "saas_subscriptions")).toMatchObject({ purchase_article_id: 111 });

    // A legacy file with a different rule is migrated directly (as tooling might).
    writeFileSync(legacyFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id |
| --- | --- | --- |
| wise | bank_fees | 222 |
`, "utf-8");
    migrateLegacyRulesToBundle(legacyFile, bundleDir);
    resetAccountingRulesCache();

    // The pre-existing concept survives and the legacy rule is merged in.
    expect(findAutoBookingRule("stripe inc", "saas_subscriptions")).toMatchObject({ purchase_article_id: 111 });
    expect(findAutoBookingRule("wise europe sa", "bank_fees")).toMatchObject({ purchase_article_id: 222 });

    rmSync(root, { recursive: true, force: true });
  });

  it("refuses to write (and never archives) when a legacy source cannot be read/parsed", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-badlegacy-"));
    const bundleDir = join(root, "accounting-rules");
    // Make the legacy path a DIRECTORY so reading it throws (EISDIR).
    mkdirSync(join(root, "accounting-rules.md"), { recursive: true });

    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    // The write is refused loudly rather than silently building a bundle that
    // would shadow (and strand) the unreadable legacy source.
    expect(() =>
      saveAutoBookingRule({ match: "wise", category: "bank_fees", purchase_account_id: 8610 }),
    ).toThrow(/could not be read or parsed/i);

    // The legacy path is left intact, is NOT archived away, and no shadowing
    // bundle was created.
    expect(existsSync(join(root, "accounting-rules.md"))).toBe(true);
    expect(existsSync(join(root, "accounting-rules.md.migrated"))).toBe(false);
    expect(existsSync(bundleDir)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("quotes YAML-ambiguous string fields so external consumers keep them as strings", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-yaml-"));
    const bundleDir = join(root, "bundle");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    const result = saveAutoBookingRule({
      match: "123",
      category: "saas_subscriptions",
      purchase_article_id: 5,
      vat_rate_dropdown: "true",
    });

    const text = readFileSync(result.path, "utf8");
    expect(text).toContain('match: "123"');
    expect(text).toContain('vat_rate_dropdown: "true"');
    // Numeric fields stay bare.
    expect(text).toContain("purchase_article_id: 5");
    // Round-trips as strings.
    resetAccountingRulesCache();
    expect(findAutoBookingRule("acme 123 ltd", "saas_subscriptions")).toMatchObject({
      match: "123",
      vat_rate_dropdown: "true",
    });

    rmSync(root, { recursive: true, force: true });
  });
});

describe("M22 accounting-rule migration collisions", () => {
  const collisionMessage =
    'Normalized rule collision: auto-booking/acme--saas-subscriptions.md <= ["ACME OÜ", "acme ou"]. ' +
    "Resolve duplicate legacy rows so every normalized auto-booking target is unique before retrying migration.";

  it("M22 reports every normalized target collision deterministically", () => {
    const helper = (accountingRules as any).findRuleMigrationConflicts;
    expect(helper).toBeTypeOf("function");
    const rules: AccountingAutoBookingRule[] = [
      { match: "beta ou", category: "bank_fees", purchase_article_id: 4 },
      { match: "ACME OÜ", category: "saas_subscriptions", purchase_article_id: 1 },
      { match: "wise", category: "bank_fees", purchase_article_id: 5 },
      { match: "acme ou", category: "saas_subscriptions", purchase_article_id: 2 },
      { match: "Beta OÜ", category: "bank_fees", purchase_article_id: 3 },
      { match: "acme ou", category: "saas_subscriptions", purchase_article_id: 6 },
    ];
    const before = structuredClone(rules);

    expect(helper(rules)).toEqual([
      {
        canonicalKey: "auto-booking/acme--saas-subscriptions.md",
        sourceMatches: ["ACME OÜ", "acme ou", "acme ou"],
      },
      {
        canonicalKey: "auto-booking/beta--bank-fees.md",
        sourceMatches: ["Beta OÜ", "beta ou"],
      },
    ]);
    expect(rules).toEqual(before);
  });

  it("M22 refuses a normalized duplicate before creating a new bundle or lock parent", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m22-new-"));
    try {
      const legacyFile = join(root, "accounting-rules.md");
      const bundleDir = join(root, "missing-parent", "bundle");
      const legacy = legacyAutoBookingRules([
        "| ACME OÜ | saas_subscriptions | 1 |",
        "| acme ou | saas_subscriptions | 2 |",
      ]);
      writeFileSync(legacyFile, legacy, "utf8");

      expect(() => migrateLegacyRulesToBundle(legacyFile, bundleDir)).toThrow(collisionMessage);
      expect(readFileSync(legacyFile, "utf8")).toBe(legacy);
      expect(existsSync(`${legacyFile}.migrated`)).toBe(false);
      expect(existsSync(join(root, "missing-parent"))).toBe(false);
      for (const path of [bundleDir, `${bundleDir}.lock`, `${bundleDir}.migrating`, `${bundleDir}.replacing`]) {
        expect(existsSync(path), path).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M22 preserves an authoritative bundle byte-for-byte on collision", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m22-authoritative-"));
    try {
      const legacyFile = join(root, "accounting-rules.md");
      const bundleDir = join(root, "bundle");
      mkdirSync(join(bundleDir, "auto-booking"), { recursive: true });
      writeFileSync(join(bundleDir, "auto-booking", "stripe--saas-subscriptions.md"), "existing concept\n", "utf8");
      writeFileSync(join(bundleDir, "index.md"), "existing index\n", "utf8");
      writeFileSync(join(bundleDir, "log.md"), "existing log\n", "utf8");
      const legacy = legacyAutoBookingRules([
        "| ACME OÜ | saas_subscriptions | 1 |",
        "| acme ou | saas_subscriptions | 2 |",
      ]);
      writeFileSync(legacyFile, legacy, "utf8");
      const before = snapshotTree(bundleDir);

      expect(() => migrateLegacyRulesToBundle(legacyFile, bundleDir)).toThrow(collisionMessage);
      expect(snapshotTree(bundleDir)).toEqual(before);
      expect(readFileSync(legacyFile, "utf8")).toBe(legacy);
      expect(existsSync(`${legacyFile}.migrated`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M22 preserves reserved and stale migration state on collision", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m22-stale-"));
    try {
      const legacyFile = join(root, "accounting-rules.md");
      const bundleDir = join(root, "bundle");
      mkdirSync(bundleDir);
      mkdirSync(`${bundleDir}.migrating`);
      mkdirSync(`${bundleDir}.replacing`);
      writeFileSync(join(bundleDir, "index.md"), "reserved index\n", "utf8");
      writeFileSync(join(bundleDir, "log.md"), "reserved log\n", "utf8");
      writeFileSync(join(`${bundleDir}.migrating`, "marker.bin"), Buffer.from([0, 1, 2]));
      writeFileSync(join(`${bundleDir}.replacing`, "marker.bin"), Buffer.from([3, 4, 5]));
      writeFileSync(legacyFile, legacyAutoBookingRules([
        "| ACME OÜ | saas_subscriptions | 1 |",
        "| acme ou | saas_subscriptions | 2 |",
      ]), "utf8");
      const before = [bundleDir, `${bundleDir}.migrating`, `${bundleDir}.replacing`].map(snapshotTree);

      expect(() => migrateLegacyRulesToBundle(legacyFile, bundleDir)).toThrow(collisionMessage);
      expect([bundleDir, `${bundleDir}.migrating`, `${bundleDir}.replacing`].map(snapshotTree)).toEqual(before);
      expect(existsSync(`${legacyFile}.migrated`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M22 collision errors are independent of legacy row order", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m22-order-"));
    try {
      const rows = [
        "| Zeta OÜ | bank_fees | 1 |",
        "| zeta ou | bank_fees | 2 |",
        "| ACME OÜ | saas_subscriptions | 3 |",
        "| acme ou | saas_subscriptions | 4 |",
      ];
      const rules: AccountingAutoBookingRule[] = [
        { match: "Zeta OÜ", category: "bank_fees", purchase_article_id: 1 },
        { match: "zeta ou", category: "bank_fees", purchase_article_id: 2 },
        { match: "ACME OÜ", category: "saas_subscriptions", purchase_article_id: 3 },
        { match: "acme ou", category: "saas_subscriptions", purchase_article_id: 4 },
      ];
      const helper = (accountingRules as any).findRuleMigrationConflicts;
      const helperForward = typeof helper === "function" ? helper(rules) : undefined;
      const helperReverse = typeof helper === "function" ? helper([...rules].reverse()) : undefined;
      const messages = [rows, [...rows].reverse()].map((orderedRows, index) => {
        const caseRoot = join(root, String(index));
        mkdirSync(caseRoot);
        const legacyFile = join(caseRoot, "accounting-rules.md");
        writeFileSync(legacyFile, legacyAutoBookingRules(orderedRows), "utf8");
        return captureErrorMessage(() => migrateLegacyRulesToBundle(legacyFile, join(caseRoot, "bundle")));
      });

      expect.soft(helper).toBeTypeOf("function");
      expect.soft(helperForward).toEqual(helperReverse);
      expect.soft(messages[0]).not.toBe("NO_ERROR");
      expect.soft(messages[0]).toBe(messages[1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M22 rejects repeated identical source rows instead of silently updating", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m22-identical-"));
    try {
      const legacyFile = join(root, "accounting-rules.md");
      const bundleDir = join(root, "bundle");
      const legacy = legacyAutoBookingRules([
        "| ACME OÜ | saas_subscriptions | 1 |",
        "| ACME OÜ | saas_subscriptions | 1 |",
      ]);
      writeFileSync(legacyFile, legacy, "utf8");

      expect(() => migrateLegacyRulesToBundle(legacyFile, bundleDir)).toThrow(
        'Normalized rule collision: auto-booking/acme--saas-subscriptions.md <= ["ACME OÜ", "ACME OÜ"]',
      );
      expect(readFileSync(legacyFile, "utf8")).toBe(legacy);
      expect(existsSync(`${legacyFile}.migrated`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M22 allows the same normalized match in different categories", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m22-categories-"));
    try {
      const legacyFile = join(root, "accounting-rules.md");
      const bundleDir = join(root, "bundle");
      writeFileSync(legacyFile, legacyAutoBookingRules([
        "| ACME OÜ | saas_subscriptions | 1 |",
        "| acme ou | bank_fees | 2 |",
      ]), "utf8");

      const result = migrateLegacyRulesToBundle(legacyFile, bundleDir);

      expect(result.counterparties).toBe(2);
      expect(result.files).toEqual([
        "auto-booking/acme--saas-subscriptions.md",
        "auto-booking/acme--bank-fees.md",
      ]);
      expect(existsSync(join(bundleDir, "auto-booking", "acme--saas-subscriptions.md"))).toBe(true);
      expect(existsSync(join(bundleDir, "auto-booking", "acme--bank-fees.md"))).toBe(true);
      expect(existsSync(`${legacyFile}.migrated`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M22 still migrates distinct normalized targets", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m22-distinct-"));
    try {
      const legacyFile = join(root, "accounting-rules.md");
      const bundleDir = join(root, "bundle");
      writeFileSync(legacyFile, legacyAutoBookingRules([
        "| OpenAI | saas_subscriptions | 501 |",
        "| Wise | bank_fees | 861 |",
      ]), "utf8");
      process.env.EARVELDAJA_RULES_DIR = bundleDir;
      delete process.env.EARVELDAJA_RULES_FILE;

      const result = migrateLegacyRulesToBundle(legacyFile, bundleDir);
      resetAccountingRulesCache();

      expect(result).toMatchObject({ migrated: true, source: legacyFile, bundle: bundleDir, counterparties: 2 });
      expect(result.files).toEqual([
        "auto-booking/openai--saas-subscriptions.md",
        "auto-booking/wise--bank-fees.md",
      ]);
      expect(existsSync(`${legacyFile}.migrated`)).toBe(true);
      expect(findAutoBookingRule("openai ireland limited", "saas_subscriptions")).toMatchObject({ purchase_article_id: 501 });
      expect(findAutoBookingRule("wise europe sa", "bank_fees")).toMatchObject({ purchase_article_id: 861 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cross-process bundle write lock (withBundleLock)", () => {
  it("runs the body and removes the lock file afterward", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-lock-"));
    const dir = join(root, "bundle");
    const lockPath = `${dir}.lock`;

    let ranWhileLocked = false;
    const out = withBundleLock(dir, () => {
      // The lock file exists for the duration of the critical section.
      ranWhileLocked = existsSync(lockPath);
      return 7;
    });

    expect(out).toBe(7);
    expect(ranWhileLocked).toBe(true);
    expect(existsSync(lockPath)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("is re-entrant within one process (nested calls do not deadlock)", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-lock-"));
    const dir = join(root, "bundle");

    const result = withBundleLock(dir, () => withBundleLock(dir, () => "inner"));

    expect(result).toBe("inner");
    expect(existsSync(`${dir}.lock`)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("reclaims a lock whose holder process is dead", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-lock-"));
    const dir = join(root, "bundle");
    const lockPath = `${dir}.lock`;

    // Simulate a crashed holder: a lock owned by a pid that is not running.
    // 2147483646 is well above any live pid, so process.kill(pid, 0) → ESRCH.
    writeFileSync(lockPath, "2147483646:crashed-holder\n");

    let ran = false;
    withBundleLock(dir, () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("lockHolderAlive: live pid alive, dead pid dead, unparseable treated as alive", () => {
    expect(lockHolderAlive(`${process.pid}:self`)).toBe(true);
    expect(lockHolderAlive("2147483646:dead")).toBe(false);
    // A token we cannot parse must NOT be reclaimed (treated as alive).
    expect(lockHolderAlive("not-a-pid")).toBe(true);
  });

  it("leaves no lock file behind after a real bundle save", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-lock-"));
    const bundleDir = join(root, "bundle");
    delete process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_DIR = bundleDir;
    resetAccountingRulesCache();

    saveAutoBookingRule({
      match: "Acme",
      category: "saas_subscriptions",
      purchase_article_id: 5,
      purchase_account_id: 5230,
    });

    expect(existsSync(`${bundleDir}.lock`)).toBe(false);
    expect(existsSync(join(bundleDir, "index.md"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("default bundle storage location (chooseDefaultBundleStorage)", () => {
  it("keeps an initialized project-root bundle in place (backward compatible)", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-default-"));
    const projectRoot = join(root, "project");
    const globalDir = join(root, "global");
    mkdirSync(join(projectRoot, "accounting-rules"), { recursive: true });
    writeFileSync(join(projectRoot, "accounting-rules", "index.md"), "# Index\n");

    const storage = chooseDefaultBundleStorage(projectRoot, globalDir);

    expect(storage.dir).toBe(join(projectRoot, "accounting-rules"));
    expect(storage.legacyFile).toBe(join(projectRoot, "accounting-rules.md"));

    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a project-root legacy accounting-rules.md in place (backward compatible)", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-default-"));
    const projectRoot = join(root, "project");
    const globalDir = join(root, "global");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "accounting-rules.md"), "# Accounting Rules\n");

    const storage = chooseDefaultBundleStorage(projectRoot, globalDir);

    expect(storage.dir).toBe(join(projectRoot, "accounting-rules"));
    expect(storage.legacyFile).toBe(join(projectRoot, "accounting-rules.md"));

    rmSync(root, { recursive: true, force: true });
  });

  it("defaults to the global config dir on a fresh install", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-default-"));
    const projectRoot = join(root, "project");
    const globalDir = join(root, "global");
    // Nothing exists at the project root — a packaged/fresh install.

    const storage = chooseDefaultBundleStorage(projectRoot, globalDir);
    const scope = (accountingRules as any).buildAccountingRulesConnectionScope("default", "default");

    expect(storage.dir).toBe(join(globalDir, "accounting-rules", scope));
    expect(storage.legacyFile).toBe(join(globalDir, scope, "accounting-rules.md"));

    rmSync(root, { recursive: true, force: true });
  });
});

describe("M23 connection-scoped accounting-rule storage", () => {
  it("M23 canonical scope is the full identity digest and survives label changes", () => {
    const buildScope = (accountingRules as any).buildAccountingRulesConnectionScope;
    const identity = "sha256:stable-non-secret-company-identity";
    const expected = createHash("sha256").update(identity).digest("hex");

    expect(buildScope("Acme OÜ", identity)).toBe(expected);
    expect(buildScope("Renamed Company", identity)).toBe(expected);
    expect(buildScope("Acme OÜ", `${identity}-other`)).not.toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("M23 live getter failures and blank identities fail closed while overrides and setup remain explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-getter-"));
    try {
      const initConnection = (accountingRules as any).initAccountingRulesConnection;
      const getterError = new Error("connection state unavailable");
      process.env.EARVELDAJA_CONFIG_DIR = join(root, "global");
      delete process.env.EARVELDAJA_RULES_FILE;
      delete process.env.EARVELDAJA_RULES_DIR;

      initConnection(() => { throw getterError; });
      expect.soft(() => getAccountingRulesPath()).toThrow(/accounting rules connection identity.*unavailable/i);

      initConnection(() => ({ name: "Acme", stableIdentity: "   " }));
      expect.soft(() => getAccountingRulesPath()).toThrow(/stable identity.*blank/i);

      initConnection(() => { throw getterError; });
      const explicitFile = join(root, "explicit.md");
      process.env.EARVELDAJA_RULES_FILE = explicitFile;
      expect(getAccountingRulesPath()).toBe(explicitFile);
      delete process.env.EARVELDAJA_RULES_FILE;
      const explicitDir = join(root, "explicit-bundle");
      process.env.EARVELDAJA_RULES_DIR = explicitDir;
      expect(getAccountingRulesPath()).toBe(explicitDir);

      delete process.env.EARVELDAJA_RULES_DIR;
      initConnection(() => ({ name: "setup", stableIdentity: "setup" }));
      expect(getAccountingRulesPath()).toBe(join(
        root,
        "global",
        "accounting-rules",
        createHash("sha256").update("setup").digest("hex"),
      ));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 rejects a blank identity before initialized project or global compatibility returns", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-blank-compat-"));
    try {
      const projectRoot = join(root, "project");
      const projectBundle = join(projectRoot, "accounting-rules");
      const globalDir = join(root, "global");
      const globalBundle = join(globalDir, "accounting-rules");
      mkdirSync(projectBundle, { recursive: true });
      mkdirSync(globalBundle, { recursive: true });
      writeFileSync(join(projectBundle, "index.md"), "# Project rules\n", "utf8");
      writeFileSync(join(globalBundle, "log.md"), "# Global rules\n", "utf8");

      expect.soft(() => chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "   "))
        .toThrow(/stable identity.*blank/i);
      expect.soft(() => chooseDefaultBundleStorage(join(root, "fresh-project"), globalDir, "Acme", ""))
        .toThrow(/stable identity.*blank/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 pins project and global roots when exact root directory inspection is denied", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-root-eacces-"));
    try {
      const projectRoot = join(root, "project");
      const projectBundle = join(projectRoot, "accounting-rules");
      const globalDir = join(root, "global");
      const globalBundle = join(globalDir, "accounting-rules");
      mkdirSync(projectBundle, { recursive: true });
      mkdirSync(globalBundle, { recursive: true });
      fsInspectionMock.readdirSyncEaccesPath = projectBundle;

      expect.soft(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
        dir: projectBundle,
        legacyFile: join(projectRoot, "accounting-rules.md"),
      });
      expect.soft(fsInspectionMock.readdirSyncEaccesHits).toBe(1);

      fsInspectionMock.readdirSyncEaccesPath = globalBundle;
      fsInspectionMock.readdirSyncEaccesHits = 0;
      expect.soft(chooseDefaultBundleStorage(join(root, "fresh-project"), globalDir, "Acme", "company-a")).toMatchObject({
        dir: globalBundle,
        legacyFile: join(globalDir, "accounting-rules.md"),
      });
      expect.soft(fsInspectionMock.readdirSyncEaccesHits).toBe(1);
    } finally {
      fsInspectionMock.readdirSyncEaccesPath = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 pins project and global roots when an exact legacy path cannot be inspected", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-legacy-eacces-"));
    try {
      const projectRoot = join(root, "project");
      const projectLegacy = join(projectRoot, "accounting-rules.md");
      const globalDir = join(root, "global");
      const globalLegacy = join(globalDir, "accounting-rules.md");

      fsInspectionMock.legacyReadEaccesPath = projectLegacy;
      expect.soft(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
        dir: join(projectRoot, "accounting-rules"),
        legacyFile: projectLegacy,
      });
      expect.soft(fsInspectionMock.legacyReadEaccesHits).toBe(1);

      fsInspectionMock.legacyReadEaccesPath = globalLegacy;
      fsInspectionMock.legacyReadEaccesHits = 0;
      expect.soft(chooseDefaultBundleStorage(join(root, "fresh-project"), globalDir, "Acme", "company-a")).toMatchObject({
        dir: join(globalDir, "accounting-rules"),
        legacyFile: globalLegacy,
      });
      expect.soft(fsInspectionMock.legacyReadEaccesHits).toBe(1);
    } finally {
      fsInspectionMock.legacyReadEaccesPath = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 ignores only exact well-typed scoped lifecycle artifacts at the global root", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-scoped-artifacts-"));
    try {
      const existingScope = createHash("sha256").update("company-a").digest("hex");
      const nextIdentity = "company-b";
      const nextScope = createHash("sha256").update(nextIdentity).digest("hex");
      const globalDir = join(root, "valid", "global");
      const globalRules = join(globalDir, "accounting-rules");
      mkdirSync(join(globalRules, existingScope), { recursive: true });
      writeFileSync(join(globalRules, `${existingScope}.lock`), "lock\n", "utf8");
      writeFileSync(join(globalRules, `${existingScope}.lock.reclaim`), "reclaim\n", "utf8");
      mkdirSync(join(globalRules, `${existingScope}.migrating`));
      mkdirSync(join(globalRules, `${existingScope}.replacing`));

      expect.soft(chooseDefaultBundleStorage(join(root, "valid", "project"), globalDir, "Other", nextIdentity))
        .toMatchObject({
          dir: join(globalRules, nextScope),
          legacyFile: join(globalDir, nextScope, "accounting-rules.md"),
        });

      const invalidEntries: Array<{ name: string; type: "file" | "dir" }> = [
        { name: existingScope, type: "file" },
        { name: `${existingScope}.lock`, type: "dir" },
        { name: `${existingScope}.lock.reclaim`, type: "dir" },
        { name: `${existingScope}.migrating`, type: "file" },
        { name: `${existingScope}.replacing`, type: "file" },
        { name: existingScope.toUpperCase(), type: "dir" },
        { name: existingScope.slice(0, -1), type: "dir" },
        { name: `prefix-${existingScope}.lock`, type: "file" },
        { name: `${existingScope}.lock.trailing`, type: "file" },
      ];
      invalidEntries.forEach(({ name, type }, index) => {
        const isolatedGlobal = join(root, `invalid-${index}`, "global");
        const isolatedRules = join(isolatedGlobal, "accounting-rules");
        mkdirSync(isolatedRules, { recursive: true });
        const entry = join(isolatedRules, name);
        if (type === "dir") mkdirSync(entry);
        else writeFileSync(entry, "unexpected\n", "utf8");

        expect.soft(chooseDefaultBundleStorage(join(root, `invalid-${index}`, "project"), isolatedGlobal, "Other", nextIdentity))
          .toMatchObject({
            dir: isolatedRules,
            legacyFile: join(isolatedGlobal, "accounting-rules.md"),
          });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 pins the project root when bundle inspection cannot prove absence", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-project-probe-"));
    try {
      const projectRoot = join(root, "project");
      const projectBundle = join(projectRoot, "accounting-rules");
      const globalDir = join(root, "global");
      mkdirSync(projectBundle, { recursive: true });
      writeFileSync(join(projectBundle, "auto-booking"), "not a directory\n", "utf8");

      expect(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
        dir: projectBundle,
        legacyFile: join(projectRoot, "accounting-rules.md"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 pins the global root on inspection failure and documents opaque label-stable scope", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-global-probe-"));
    try {
      const projectRoot = join(root, "project");
      const globalDir = join(root, "global");
      const globalBundle = join(globalDir, "accounting-rules");
      mkdirSync(globalBundle, { recursive: true });
      writeFileSync(join(globalBundle, "auto-booking"), "not a directory\n", "utf8");

      expect.soft(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
        dir: globalBundle,
        legacyFile: join(globalDir, "accounting-rules.md"),
      });
      const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
      expect.soft(readme).toContain("opaque identity scope");
      expect.soft(readme).toContain("Changing a connection label does not move its accounting-rule store");
      expect.soft(readme).not.toContain("<connection>--<identity>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 scopes a fresh global bundle and legacy fallback by connection", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-fresh-"));
    try {
      const projectRoot = join(root, "project");
      const globalDir = join(root, "global");
      const buildScope = (accountingRules as any).buildAccountingRulesConnectionScope;
      expect(buildScope).toBeTypeOf("function");
      const scope = buildScope("Acme OÜ", "sha256:non-secret-company-a");

      expect(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme OÜ", "sha256:non-secret-company-a")).toEqual({
        mode: "bundle",
        dir: join(globalDir, "accounting-rules", scope),
        legacyFile: join(globalDir, scope, "accounting-rules.md"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 sanitizes connection names without path escape or identity collision", () => {
    const sanitize = (accountingRules as any).sanitizeAccountingRulesConnectionName;
    const buildScope = (accountingRules as any).buildAccountingRulesConnectionScope;
    expect(sanitize).toBeTypeOf("function");
    expect(buildScope).toBeTypeOf("function");

    expect(sanitize("Åcme ÕÜ")).toBe("acme-ou");
    expect(sanitize(" ../Acme\\Corp/\u0000 ")).toBe("acme-corp");
    expect(sanitize("   ")).toBe("default");
    expect(sanitize("CON")).toBe("connection-con");
    expect(sanitize("x".repeat(500)).length).toBeLessThanOrEqual(54);
    expect(sanitize("A/B")).toBe(sanitize("A B"));
    expect(sanitize(".." as string)).not.toMatch(/^\.{1,2}$/);
    expect(sanitize("safe")).not.toMatch(/[/\\\u0000-\u001f]/);

    const first = buildScope("A/B", "fingerprint-one");
    const same = buildScope("A B", "fingerprint-one");
    const otherIdentity = buildScope("A/B", "fingerprint-two");
    expect(first).toBe(same);
    expect(otherIdentity).not.toBe(first);
    expect(buildScope("Duplicate", "company-a")).not.toBe(buildScope("Duplicate", "company-b"));
    expect(first.length).toBeLessThanOrEqual(64);
    expect(buildScope("A/B", "fingerprint-one")).toBe(first);
  });

  it("M23 ignores the untouched shipped project template when selecting storage", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-template-"));
    try {
      const globalDir = join(root, "global");
      const storage = chooseDefaultBundleStorage(process.cwd(), globalDir, "Acme OÜ", "company-a");
      const scope = (accountingRules as any).buildAccountingRulesConnectionScope("Acme OÜ", "company-a");

      expect(storage.dir).toBe(join(globalDir, "accounting-rules", scope));
      expect(storage.legacyFile).toBe(join(globalDir, scope, "accounting-rules.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 keeps a modified or data-bearing project legacy in place", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-project-legacy-"));
    try {
      const template = readFileSync(join(process.cwd(), "accounting-rules.md"), "utf8");
      for (const [name, contents] of [
        ["note", `${template}\nCompany note: keep this treatment.\n`],
        ["data", legacyAutoBookingRules(["| OpenAI | saas_subscriptions | 501 |"])],
      ] as const) {
        const projectRoot = join(root, name);
        const globalDir = join(root, `global-${name}`);
        mkdirSync(projectRoot);
        writeFileSync(join(projectRoot, "accounting-rules.md"), contents, "utf8");

        expect(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
          dir: join(projectRoot, "accounting-rules"),
          legacyFile: join(projectRoot, "accounting-rules.md"),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 keeps an initialized project bundle in place", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-project-bundle-"));
    try {
      const projectRoot = join(root, "project");
      const globalDir = join(root, "global");
      mkdirSync(join(projectRoot, "accounting-rules"), { recursive: true });
      writeFileSync(join(projectRoot, "accounting-rules", "index.md"), "# Existing bundle\n", "utf8");

      expect(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
        dir: join(projectRoot, "accounting-rules"),
        legacyFile: join(projectRoot, "accounting-rules.md"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 keeps an existing root-marked unscoped global bundle in place", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-global-bundle-"));
    try {
      const projectRoot = join(root, "project");
      const globalDir = join(root, "global");
      mkdirSync(join(globalDir, "accounting-rules"), { recursive: true });
      writeFileSync(join(globalDir, "accounting-rules", "index.md"), "# Existing global bundle\n", "utf8");

      expect(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
        dir: join(globalDir, "accounting-rules"),
        legacyFile: join(globalDir, "accounting-rules.md"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 keeps an existing non-template unscoped global legacy in place", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-global-legacy-"));
    try {
      const projectRoot = join(root, "project");
      const globalDir = join(root, "global");
      mkdirSync(globalDir);
      writeFileSync(join(globalDir, "accounting-rules.md"), "# Accounting Rules\n\nCompany data.\n", "utf8");

      expect(chooseDefaultBundleStorage(projectRoot, globalDir, "Acme", "company-a")).toMatchObject({
        dir: join(globalDir, "accounting-rules"),
        legacyFile: join(globalDir, "accounting-rules.md"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 active connection getter changes the real resolved path without cache bleed", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-switch-"));
    try {
      const initConnection = (accountingRules as any).initAccountingRulesConnection;
      expect(initConnection).toBeTypeOf("function");
      process.env.EARVELDAJA_CONFIG_DIR = join(root, "global");
      delete process.env.EARVELDAJA_RULES_FILE;
      delete process.env.EARVELDAJA_RULES_DIR;
      let active = { name: "env-file", stableIdentity: "fingerprint-env" };
      initConnection(() => active);

      const envSave = saveAutoBookingRule({ match: "OpenAI", category: "saas_subscriptions", purchase_article_id: 501 });
      const envRulesPath = getAccountingRulesPath();
      active = { name: "renamed-env-file", stableIdentity: "fingerprint-env" };
      expect(getAccountingRulesPath()).toBe(envRulesPath);
      expect(findAutoBookingRule("openai ireland", "saas_subscriptions")).toMatchObject({ purchase_article_id: 501 });

      active = { name: "demo", stableIdentity: "fingerprint-demo" };
      const demoSave = saveAutoBookingRule({ match: "Wise", category: "bank_fees", purchase_article_id: 861 });
      expect(demoSave.path).not.toBe(envSave.path);
      expect(demoSave.path).toContain(join(root, "global", "accounting-rules"));
      expect(findAutoBookingRule("wise europe", "bank_fees")).toMatchObject({ purchase_article_id: 861 });
      expect(findAutoBookingRule("openai ireland", "saas_subscriptions")).toBeUndefined();

      active = { name: "env-file", stableIdentity: "fingerprint-env" };
      expect(getAccountingRulesPath()).toBe(envRulesPath);
      expect(findAutoBookingRule("openai ireland", "saas_subscriptions")).toMatchObject({ purchase_article_id: 501 });
      expect(findAutoBookingRule("wise europe", "bank_fees")).toBeUndefined();

      active = { name: "Åcme OÜ", stableIdentity: "fingerprint-acme-one" };
      const firstCollision = saveAutoBookingRule({ match: "Stripe", category: "saas_subscriptions", purchase_article_id: 111 });
      active = { name: "acme ou", stableIdentity: "fingerprint-acme-two" };
      const secondCollision = saveAutoBookingRule({ match: "Anthropic", category: "saas_subscriptions", purchase_article_id: 222 });
      expect(secondCollision.path).not.toBe(firstCollision.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 explicit rules environment overrides remain unscoped", () => {
    const root = mkdtempSync(join(tmpdir(), "earv-m23-overrides-"));
    try {
      const file = join(root, "explicit.md");
      process.env.EARVELDAJA_RULES_FILE = file;
      delete process.env.EARVELDAJA_RULES_DIR;
      expect(getAccountingRulesPath()).toBe(file);

      delete process.env.EARVELDAJA_RULES_FILE;
      const dir = join(root, "explicit-bundle");
      process.env.EARVELDAJA_RULES_DIR = dir;
      expect(getAccountingRulesPath()).toBe(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("M23 index initializes accounting rules from the live connection state", () => {
    const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(source).toContain('initAccountingRulesConnection');
    const call = source.match(/initAccountingRulesConnection\(\(\) => \(\{[\s\S]*?\}\)\);/)?.[0] ?? "";
    expect(call).toContain('allConfigs[connectionState.activeIndex]?.name ?? "setup"');
    expect(call).toContain('buildConnectionFingerprint(allConfigs[connectionState.activeIndex]!.config)');
    expect(call).toContain(': "setup"');
    expect(call).not.toContain("connectionFingerprints[");
  });

  it("M23 tracked template exactly matches the source default and contains no company data", () => {
    const isDefaultTemplate = (accountingRules as any).isDefaultAccountingRulesTemplate;
    expect(isDefaultTemplate).toBeTypeOf("function");
    const template = readFileSync(join(process.cwd(), "accounting-rules.md"), "utf8");

    expect(isDefaultTemplate(template)).toBe(true);
    expect(isDefaultTemplate(template.replace(/\n?$/, "\nCompany note.\n"))).toBe(false);
    expect(template).not.toMatch(/\|\s*[^-\s][^|]*\|\s*(?:saas_subscriptions|bank_fees)\s*\|/i);
  });

  it("M23 generated project bundle path is ignored", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toContain(
      "# Generated connection-specific accounting rules (templates remain tracked elsewhere)\naccounting-rules/\n",
    );
  });
});
