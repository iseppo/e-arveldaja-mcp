import { describe, expect, it } from "vitest";
import { createClassificationOperations } from "./classification-operations.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import {
  createAccountingWorkflowApi,
  type AccountingWorkflowApiOptions,
} from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";

function makeOperations(apiOptions: AccountingWorkflowApiOptions = {}) {
  const api = createAccountingWorkflowApi(apiOptions);
  const operations = createClassificationOperations(
    api,
    createTestRuntimeSafetyContext(),
    wrapUntrustedOcr,
  );
  return { api, operations };
}

const BANK_FEE_TX = {
  id: 1,
  status: "PROJECT",
  is_deleted: false,
  type: "C",
  amount: 15,
  date: "2026-03-20",
  accounts_dimensions_id: 100,
  bank_account_name: "LHV Bank",
  description: "Bank monthly fee",
};

const PURCHASE_ARTICLES = [{
  id: 501,
  name_est: "Bank fee",
  accounts_id: 5230,
  is_disabled: false,
  priority: 1,
}];

const ACCOUNTS = [{
  id: 5230,
  name_est: "Bank fees",
  account_type_est: "Kulud",
}];

describe("classification operations — analyzeUnmatched", () => {
  it("returns RAW (unwrapped) groups with category counts", async () => {
    const { operations } = makeOperations({
      transactionRows: [BANK_FEE_TX],
      clientRows: [],
      purchaseArticles: PURCHASE_ARTICLES,
      accounts: ACCOUNTS,
    });

    const outcome = await operations.analyzeUnmatched({ accountsDimensionsId: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.value;

    expect(result.totalUnconfirmed).toBe(1);
    expect(result.totalUnmatched).toBe(1);
    expect(result.categoryCounts.bank_fees).toBe(1);
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0]!;
    expect(group.category).toBe("bank_fees");
    // The operation returns UNWRAPPED domain data; wrapping is the presenter's
    // job, so no OCR sandbox markers may appear on the raw group.
    expect(group.normalized_counterparty).not.toContain("UNTRUSTED_OCR_START");
    expect(group.display_counterparty).not.toContain("UNTRUSTED_OCR_START");
    expect(group.transactions[0]!.description).toBe("Bank monthly fee");
  });
});

describe("classification operations — applyClassifications", () => {
  it("dry-runs (default) without creating any invoice", async () => {
    const classification = {
      category: "bank_fees",
      apply_mode: "purchase_invoice",
      normalized_counterparty: "lhv bank",
      display_counterparty: "LHV Bank",
      recurring: false,
      similar_amounts: false,
      total_amount: 15,
      suggested_booking: {
        purchase_article_id: 501,
        purchase_account_id: 5230,
        liability_account_id: 2310,
        reason: "Bank fees",
      },
      reasons: ["fee"],
      transactions: [BANK_FEE_TX],
    };
    const { operations, api } = makeOperations({
      transactionRows: [BANK_FEE_TX],
      transactionDetails: { 1: BANK_FEE_TX },
      clientRows: [],
      purchaseArticles: PURCHASE_ARTICLES,
      accounts: ACCOUNTS,
    });

    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [classification] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.value;

    expect(result.mode).toBe("DRY_RUN");
    expect(result.dryRun).toBe(true);
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    expect(["dry_run_preview", "skipped"]).toContain(result.results[0]!.status);
  });
});
