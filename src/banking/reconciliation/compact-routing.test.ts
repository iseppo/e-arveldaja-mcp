import { describe, it, expect, vi } from "vitest";
import { registerBankReconciliationTools } from "../../tools/bank-reconciliation.js";
import { parseMcpResponse } from "../../mcp-json.js";
import { runWithToolProfile } from "../../tool-profile.js";
import { createTestRuntimeSafetyContext } from "../../__fixtures__/runtime-safety.js";

vi.mock("../../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../audit-log.js", () => ({ logAudit: vi.fn() }));

const EXPOSE_GRANULAR = {
  enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true,
  enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true,
} as const;

const BANK_DIMENSION_ID = 100;
const BANK_ACCOUNT_ID = 1020;

const matchingTx = {
  id: 1, status: "PROJECT", is_deleted: false, type: "D", amount: 100, date: "2026-03-20",
  accounts_dimensions_id: BANK_DIMENSION_ID, cl_currencies_id: "EUR",
  bank_account_name: "Acme OU", ref_number: "RF123", description: "Payment from Acme",
};
const matchingSale = {
  id: 10, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-10",
  clients_id: 20, client_name: "Acme OU", gross_price: 100, bank_ref_number: "RF123",
};

function setup() {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue([matchingTx]),
      get: vi.fn().mockResolvedValue({ ...matchingTx }),
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: { listAll: vi.fn().mockResolvedValue([matchingSale]) },
    purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([{ id: 1, accounts_dimensions_id: BANK_DIMENSION_ID }]),
      getAccountDimensions: vi.fn().mockResolvedValue([
        { id: BANK_DIMENSION_ID, accounts_id: BANK_ACCOUNT_ID, is_deleted: false, title_est: "LHV" },
      ]),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Test OÜ" }),
    },
    journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
    clients: { findByName: vi.fn().mockResolvedValue([]) },
  } as any;
  registerBankReconciliationTools(server, api, createTestRuntimeSafetyContext(), EXPOSE_GRANULAR);
  const handler = (name: string) => {
    const registration = server.registerTool.mock.calls.find(([n]: [string]) => n === name);
    if (!registration) throw new Error(`Tool not registered: ${name}`);
    return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };
  return { api, handler };
}

async function call(handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>, args: Record<string, unknown>) {
  return parseMcpResponse((await handler(args)).content[0]!.text) as any;
}

describe("reconciliation compact profile routing", () => {
  it("standard profile keeps the full envelope (no compact summary)", async () => {
    const { handler } = setup();
    const payload = await call(handler("reconcile_bank_transactions"), { mode: "suggest" });
    // Full merged envelope, not the compact operation_summary_v1.
    expect(payload.recommended_entry_point).toBe("reconcile_bank_transactions");
    expect(payload.result.matches).toBeDefined();
    expect(payload.summary).toBeUndefined();
  });

  it("guided suggest returns the compact operation summary (no per-row matches array)", async () => {
    const { handler } = setup();
    await runWithToolProfile("guided", async () => {
      const payload = await call(handler("reconcile_bank_transactions"), { mode: "suggest" });
      expect(payload.summary.contract).toBe("operation_summary_v1");
      expect(payload.summary.status).toBe("needs_review");
      expect(payload.summary.counts.matched).toBe(1);
      expect(payload.summary.next_action.tool).toBe("reconcile_bank_transactions");
      // No unbounded per-row matches array leaks into the compact surface.
      expect(payload.result).toBeUndefined();
      expect(payload.matches).toBeUndefined();
    });
  });

  it("guided dry_run_auto_confirm returns a compact summary with a plan handle", async () => {
    const { handler } = setup();
    await runWithToolProfile("guided", async () => {
      const payload = await call(handler("reconcile_bank_transactions"), { mode: "dry_run_auto_confirm", min_confidence: 50 });
      expect(payload.summary.contract).toBe("operation_summary_v1");
      expect(payload.summary.status).toBe("ready_for_approval");
      expect(typeof payload.summary.plan_handle).toBe("string");
      expect(payload.summary.counts.would_confirm).toBe(1);
      expect(Number(payload.summary.totals.EUR)).toBeGreaterThan(0);
    });
  });

  it("guided execute_auto_confirm completes and references get_operation_result_page", async () => {
    const { handler, api } = setup();
    await runWithToolProfile("guided", async () => {
      const dry = await call(handler("reconcile_bank_transactions"), { mode: "dry_run_auto_confirm", min_confidence: 50 });
      const planHandle = dry.summary.plan_handle as string;
      const exec = await call(handler("reconcile_bank_transactions"), { mode: "execute_auto_confirm", min_confidence: 50, plan_handle: planHandle });
      expect(exec.summary.contract).toBe("operation_summary_v1");
      expect(exec.summary.status).toBe("completed");
      expect(exec.summary.details.tool).toBe("get_operation_result_page");
      expect(typeof exec.summary.details.args.operation_handle).toBe("string");
      expect(api.transactions.confirm).toHaveBeenCalled();
    });
  });
});
