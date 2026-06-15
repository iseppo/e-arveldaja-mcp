import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
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

    expect(storage.dir).toBe(join(globalDir, "accounting-rules"));
    expect(storage.legacyFile).toBe(join(globalDir, "accounting-rules.md"));

    rmSync(root, { recursive: true, force: true });
  });
});
