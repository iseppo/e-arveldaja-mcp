import { describe, expect, it, vi } from "vitest";
import { createReportingOperations } from "./operations.js";
import type { ApiContext } from "../tools/crud/shared.js";

function makeApi(overrides: Record<string, unknown> = {}): ApiContext {
  const base = {
    journals: {
      listAll: vi.fn().mockResolvedValue([]),
      listAllWithPostings: vi.fn().mockResolvedValue([]),
    },
    transactions: { listAll: vi.fn().mockResolvedValue([]) },
    saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
    purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
    readonly: { getAccounts: vi.fn().mockResolvedValue([]) },
  };
  return { ...base, ...overrides } as unknown as ApiContext;
}

const account = (o: Record<string, unknown>) => ({
  balance_type: "D", account_type_est: "Varad", name_eng: "x", ...o,
});
const journal = (o: Record<string, unknown>) => ({
  is_deleted: false, registered: true, effective_date: "2026-06-15", postings: [], ...o,
});

describe("ReportingOperations.run", () => {
  it("trial_balance reuses computeAllBalances grand totals (raw, not per-account resum)", async () => {
    const api = makeApi({
      readonly: { getAccounts: vi.fn().mockResolvedValue([account({ id: 1020, name_est: "Pank" }), account({ id: 5000, name_est: "Kulu", account_type_est: "Kulud" })]) },
      journals: {
        listAll: vi.fn(),
        listAllWithPostings: vi.fn().mockResolvedValue([journal({
          id: 1,
          postings: [
            { accounts_id: 1020, type: "D", amount: 100, is_deleted: false },
            { accounts_id: 5000, type: "C", amount: 100, is_deleted: false },
          ],
        })]),
      },
    });
    const ops = createReportingOperations(api, true);
    const outcome = await ops.run({ report: "trial_balance", period: {} });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.report).toBe("trial_balance");
    if (outcome.value.report !== "trial_balance") return;
    expect(outcome.value.totals.debit).toBe(100);
    expect(outcome.value.totals.credit).toBe(100);
    expect(outcome.value.totals.difference).toBe(0);
    expect(outcome.value.account_count).toBe(2);
  });

  it("profit_and_loss fails closed without a period (never returns partial data)", async () => {
    const ops = createReportingOperations(makeApi(), true);
    const outcome = await ops.run({ report: "profit_and_loss", period: {} });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("period_required");
  });

  it("aging omits receivables when sales is disabled but still returns payables", async () => {
    const api = makeApi({
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([
        { id: 9, number: "P-1", client_name: "Supplier", clients_id: 3, create_date: "2026-01-01", term_days: 0, status: "CONFIRMED", payment_status: "NOT_PAID", gross_price: 50 },
      ]) },
      saleInvoices: { listAll: vi.fn().mockRejectedValue(new Error("sales disabled must not be called")) },
    });
    const ops = createReportingOperations(api, false);
    const outcome = await ops.run({ report: "aging", asOfDate: "2026-06-15" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.report !== "aging") return;
    expect(outcome.value.receivables).toBeUndefined();
    expect(outcome.value.payables.total_invoices).toBe(1);
    expect(outcome.value.payables.aging_buckets[0]!.invoices[0]!.client).toBe("Supplier");
  });

  it("month_end requires a valid month", async () => {
    const ops = createReportingOperations(makeApi(), true);
    const outcome = await ops.run({ report: "month_end" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("month_required");
  });

  it("month_end returns UNWRAPPED journal titles and tx descriptions (façade wraps)", async () => {
    const api = makeApi({
      journals: {
        listAll: vi.fn().mockResolvedValue([journal({ id: 5, registered: false, title: "Draft <inject>" })]),
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      transactions: { listAll: vi.fn().mockResolvedValue([
        { id: 7, date: "2026-06-10", amount: 12, description: "PAYME <inject>", status: "PROJECT", is_deleted: false },
      ]) },
    });
    const ops = createReportingOperations(api, true);
    const outcome = await ops.run({ report: "month_end", month: "2026-06" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.report !== "month_end") return;
    expect(outcome.value.unconfirmed_journals.items[0]!.title).toBe("Draft <inject>");
    expect(outcome.value.unconfirmed_transactions.items[0]!.description).toBe("PAYME <inject>");
    expect(outcome.value.summary.ready_to_close).toBe(false);
  });
});
