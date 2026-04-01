import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAutoBookingRule,
  getCashFlowCategoryRule,
  getDefaultOwnerExpenseVatDeductionMode,
  getDefaultOwnerExpenseVatDeductionRatio,
  getLiabilityClassificationRule,
  getOwnerExpenseVatDeductionModeForAccount,
  getOwnerExpenseVatDeductionRatioForAccount,
  resetAccountingRulesCache,
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
    expect(getLiabilityClassificationRule(2100)).toBe("non_current");
    expect(getCashFlowCategoryRule(2100)).toBe("financing");

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
});
