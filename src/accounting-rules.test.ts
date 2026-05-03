import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAutoBookingRule,
  getCashFlowCategoryRule,
  getAccountingRulesPath,
  getCurrentYearProfitAccountRule,
  getDefaultOwnerExpenseVatDeductionMode,
  getDefaultOwnerExpenseVatDeductionRatio,
  getLiabilityClassificationRule,
  getOwnerExpenseVatDeductionModeForAccount,
  getOwnerExpenseVatDeductionRatioForAccount,
  resetAccountingRulesCache,
  saveAutoBookingRule,
} from "./accounting-rules.js";

const ORIGINAL_RULES_FILE = process.env.EARVELDAJA_RULES_FILE;

afterEach(() => {
  if (ORIGINAL_RULES_FILE === undefined) {
    delete process.env.EARVELDAJA_RULES_FILE;
  } else {
    process.env.EARVELDAJA_RULES_FILE = ORIGINAL_RULES_FILE;
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
