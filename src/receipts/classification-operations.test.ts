import { describe, expect, it } from "vitest";
import {
  BANK_CLASSIFICATION_PLAN_DOMAIN,
  createClassificationOperations,
} from "./classification-operations.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import {
  createAccountingWorkflowApi,
  type AccountingWorkflowApiOptions,
} from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";

function makeOperations(apiOptions: AccountingWorkflowApiOptions = {}) {
  const api = createAccountingWorkflowApi(apiOptions);
  const ctx = createTestRuntimeSafetyContext();
  const operations = createClassificationOperations(api, ctx, wrapUntrustedOcr);
  return { api, operations, ctx };
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

// ---------------------------------------------------------------------------
// P0-2: execute_apply must not trust caller classifications_json. Every negative
// case asserts the create / confirm / link API writes were NEVER called.
// ---------------------------------------------------------------------------

const SAAS_TX = {
  id: 42,
  status: "PROJECT",
  is_deleted: false,
  type: "C",
  amount: 25,
  date: "2026-03-22",
  accounts_dimensions_id: 100,
  bank_account_name: "OpenAI",
  clients_id: 7,
  cl_currencies_id: "EUR",
};

const SAAS_CLIENT = {
  id: 7,
  name: "OpenAI Ireland Limited",
  is_supplier: true,
  is_client: false,
  cl_code_country: "IE",
  is_member: false,
  send_invoice_to_email: false,
  send_invoice_to_accounting_email: false,
  is_deleted: false,
};

const SAAS_ARTICLES = [{
  id: 501,
  name_est: "Software",
  name_eng: "Software",
  accounts_id: 5230,
  vat_accounts_id: 1510,
  cl_vat_articles_id: 1,
  is_disabled: false,
  priority: 1,
}];

const SAAS_ACCOUNTS = [{
  id: 5230,
  name_est: "Software expense",
  name_eng: "Software expense",
  account_type_est: "Kulud",
  account_type_eng: "Expenses",
}];

function saasGroup(overrides: Record<string, unknown> = {}) {
  return {
    category: "saas_subscriptions",
    apply_mode: "purchase_invoice",
    normalized_counterparty: "openai",
    display_counterparty: "OpenAI",
    recurring: true,
    similar_amounts: true,
    total_amount: 25,
    suggested_booking: {
      purchase_article_id: 501,
      purchase_account_id: 5230,
      liability_account_id: 2310,
      reason: "Recurring SaaS",
    },
    reasons: ["keyword"],
    transactions: [SAAS_TX],
    ...overrides,
  };
}

// A CONFIRMED+PAID supplier-history invoice for client 7 so suggestBookingInternal
// resolves a supplier_history booking and the saas group is actually auto-bookable
// (without it, saas_subscriptions downgrades to review_only).
const SAAS_HISTORY_ROWS = [{
  id: 88,
  status: "CONFIRMED",
  payment_status: "PAID",
  clients_id: 7,
  client_name: "OpenAI Ireland Limited",
  create_date: "2026-02-22",
}];
const SAAS_HISTORY_DETAILS = {
  88: {
    id: 88,
    number: "OLD-88",
    liability_accounts_id: 2310,
    items: [{
      custom_title: "Subscription",
      cl_purchase_articles_id: 501,
      purchase_accounts_id: 5230,
      vat_rate_dropdown: "24",
      vat_accounts_id: 1510,
    }],
  },
};

function makeSaasOperations(txDetail: Record<string, unknown> = SAAS_TX, extra: AccountingWorkflowApiOptions = {}) {
  return makeOperations({
    transactionRows: [txDetail],
    transactionDetails: { 42: txDetail },
    clientRows: [SAAS_CLIENT],
    purchaseArticles: SAAS_ARTICLES,
    accounts: SAAS_ACCOUNTS,
    purchaseInvoiceRows: SAAS_HISTORY_ROWS,
    purchaseInvoiceDetails: SAAS_HISTORY_DETAILS,
    ...extra,
  });
}

function expectNoWrites(api: ReturnType<typeof createAccountingWorkflowApi>): void {
  expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
  expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
  expect(api.transactions.confirm).not.toHaveBeenCalled();
}

async function dryRunHandle(operations: ReturnType<typeof makeOperations>["operations"], groups: unknown[]): Promise<string> {
  const outcome = await operations.applyClassifications({ classificationsJson: { groups } });
  if (!outcome.ok) throw new Error(`dry run failed: ${outcome.error.code}`);
  const handle = outcome.value.planHandle;
  if (handle === undefined) throw new Error("dry run did not mint a plan handle");
  return handle;
}

describe("classification operations — P0-2 plan binding", () => {
  it("dry_run_apply mints a consume-once plan handle", async () => {
    const { operations } = makeSaasOperations();
    const outcome = await operations.applyClassifications({ classificationsJson: { groups: [saasGroup()] } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.planHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(outcome.value.results[0]!.status).toBe("dry_run_preview");
  });

  it("execute_apply books using the REAL dry-run plan handle (happy path)", async () => {
    const { operations, api } = makeSaasOperations();
    const handle = await dryRunHandle(operations, [saasGroup()]);
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mode).toBe("EXECUTED");
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(outcome.value.results[0]!.status).toBe("applied");
  });

  it("execute_apply without a plan handle is refused with zero writes", async () => {
    const { operations, api } = makeSaasOperations();
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_handle_required");
    expectNoWrites(api);
  });

  it("blocks a swapped transaction id (101 reviewed, 202 executed) as plan_drift", async () => {
    const { operations, api } = makeSaasOperations();
    const handle = await dryRunHandle(operations, [saasGroup()]);
    const swapped = saasGroup({ transactions: [{ ...SAAS_TX, id: 999 }] });
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [swapped] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expectNoWrites(api);
  });

  it("blocks flipping a review-only category to an auto-bookable apply_mode", async () => {
    const { operations, api } = makeSaasOperations();
    // Reviewed as review-only (apply_mode not purchase_invoice) → not bookable.
    const reviewed = saasGroup({ apply_mode: "review", category: "unknown" });
    const handle = await dryRunHandle(operations, [reviewed]);
    const flipped = saasGroup({ category: "unknown" }); // apply_mode back to purchase_invoice
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [flipped] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expectNoWrites(api);
  });

  it("blocks a changed apply_mode as plan_drift", async () => {
    const { operations, api } = makeSaasOperations();
    const handle = await dryRunHandle(operations, [saasGroup()]);
    const changed = saasGroup({ apply_mode: "manual_review" });
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [changed] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expectNoWrites(api);
  });

  it("blocks when the live transaction amount moves after the preview", async () => {
    const liveDetail = { ...SAAS_TX };
    const { operations, api } = makeSaasOperations(liveDetail);
    const handle = await dryRunHandle(operations, [saasGroup()]);
    liveDetail.amount = 30; // live state drifts between preview and execute
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expectNoWrites(api);
  });

  it("stops the whole command when a grouped transaction is confirmed meanwhile", async () => {
    const liveDetail = { ...SAAS_TX };
    const { operations, api } = makeSaasOperations(liveDetail);
    const handle = await dryRunHandle(operations, [saasGroup()]);
    liveDetail.status = "CONFIRMED"; // confirmed by someone else after the preview
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expectNoWrites(api);
  });

  it("is consume-once: a replay of a burned handle is refused with zero writes", async () => {
    const { operations, api } = makeSaasOperations();
    const handle = await dryRunHandle(operations, [saasGroup()]);
    // First execute drifts (wrong id) — this still BURNS the handle.
    const first = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup({ transactions: [{ ...SAAS_TX, id: 999 }] })] },
      execute: true,
      planHandle: handle,
    });
    expect(first.ok).toBe(false);
    // Replay with the correct payload + same handle → consumed.
    const replay = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
      planHandle: handle,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toBe("plan_handle_consumed");
    expectNoWrites(api);
  });

  it("rejects a scope-mismatched handle with zero writes", async () => {
    const { operations, api, ctx } = makeSaasOperations();
    const handle = await dryRunHandle(operations, [saasGroup()]);
    ctx.setScope({ verifiedCompanyIdentity: "a-different-company" });
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_scope_mismatch");
    expectNoWrites(api);
  });

  it("rejects an expired handle with zero writes", async () => {
    const { operations, api, ctx } = makeSaasOperations();
    const handle = await dryRunHandle(operations, [saasGroup()]);
    ctx.advanceTime(601_000);
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
      planHandle: handle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_handle_expired");
    expectNoWrites(api);
  });

  it("rejects a wrong-domain handle with zero writes", async () => {
    const { operations, api, ctx } = makeSaasOperations();
    const foreignHandle = ctx.planStore.issue("some_other_domain", {
      normalizedArgs: { unrelated: true },
      sourceIdentities: [],
      liveSnapshot: {},
      commands: [],
      counts: {},
      totals: {},
      exclusions: [],
      reviews: [],
      privatePayload: {},
    });
    const outcome = await operations.applyClassifications({
      classificationsJson: { groups: [saasGroup()] },
      execute: true,
      planHandle: foreignHandle,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_domain_mismatch");
    expectNoWrites(api);
  });

  it("exposes the plan domain used for classification apply binding", () => {
    expect(BANK_CLASSIFICATION_PLAN_DOMAIN).toBe("bank_classification");
  });
});
