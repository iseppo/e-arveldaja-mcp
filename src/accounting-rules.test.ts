import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAutoBookingRule,
  getCashFlowCategoryRule,
  getDefaultOwnerExpenseVatDeductionMode,
  getLiabilityClassificationRule,
  getOwnerExpenseVatDeductionModeForAccount,
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
Default VAT deduction mode: full
| expense_account | vat_deduction_mode |
| --- | --- |
| 5230 | none |

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
    expect(getDefaultOwnerExpenseVatDeductionMode()).toBe("full");
    expect(getOwnerExpenseVatDeductionModeForAccount(5230)).toBe("none");
    expect(getLiabilityClassificationRule(2100)).toBe("non_current");
    expect(getCashFlowCategoryRule(2100)).toBe("financing");

    rmSync(dir, { recursive: true, force: true });
  });
});
