import { describe, expect, it, vi } from "vitest";
import { registerBankReconciliationTools } from "./bank-reconciliation.js";

function setupReconciliationTool(options: {
  transactions?: unknown[];
  sales?: unknown[];
  purchases?: unknown[];
} = {}) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactions ?? []),
      confirm: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.sales ?? []),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.purchases ?? []),
    },
  } as any;

  registerBankReconciliationTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === "reconcile_transactions");
  if (!registration) {
    throw new Error("Tool was not registered");
  }

  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("reconcile_transactions", () => {
  it("does not provide a ready-to-use distribution for partially paid invoices", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 1,
        status: "PROJECT",
        is_deleted: false,
        type: "D",
        amount: 100,
        date: "2026-03-20",
        description: "Incoming payment",
        bank_account_name: "Acme OU",
      }],
      sales: [{
        id: 10,
        status: "CONFIRMED",
        payment_status: "PARTIALLY_PAID",
        number: "ARV-10",
        clients_id: 20,
        client_name: "Acme OU",
        gross_price: 100,
      }],
    });

    const result = await handler({ min_confidence: 0 });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.best_match.partially_paid_warning).toBe(true);
    expect(payload.matches[0]!.distribution_ready).toBe(false);
    expect(payload.matches[0]!.distribution).toBeUndefined();
    expect(payload.matches[0]!.manual_review_required).toContain("remaining open balance");
  });

  it("keeps the ready-to-use distribution for non-partially-paid matches", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 2,
        status: "PROJECT",
        is_deleted: false,
        type: "D",
        amount: 250,
        date: "2026-03-20",
        description: "Incoming payment",
        bank_account_name: "Beta OU",
      }],
      sales: [{
        id: 11,
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        number: "ARV-11",
        clients_id: 21,
        client_name: "Beta OU",
        gross_price: 250,
      }],
    });

    const result = await handler({ min_confidence: 0 });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.distribution_ready).toBe(true);
    expect(payload.matches[0]!.distribution).toEqual({
      related_table: "sale_invoices",
      related_id: 11,
      amount: 250,
    });
    expect(payload.matches[0]!.manual_review_required).toBeUndefined();
  });
});
