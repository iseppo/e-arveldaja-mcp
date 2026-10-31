import { describe, it, expect, vi } from "vitest";
import { registerBankReconciliationTools } from "../../tools/bank-reconciliation.js";
import { parseToolPayload } from "../../__fixtures__/mcp-response.js";
import type { ReconCompactPayload, ReconSuggestPayload } from "./presenter.js";
import type { ReconcileBankTransactionsPayload } from "../../tools/bank-reconciliation.js";
import { runWithToolProfile } from "../../tool-profile.js";
import { createTestRuntimeSafetyContext } from "../../__fixtures__/runtime-safety.js";
import { withSignedCamtMarker } from "../../__fixtures__/camt-marker.js";

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
  accounts_id:BANK_ACCOUNT_ID,
  bank_account_name: "Acme OU", ref_number: "RF123", description: "Payment from Acme",
};
const matchingSale = {
  id: 10, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-10",
  clients_id: 20, client_name: "Acme OU", gross_price: 100, bank_ref_number: "RF123", cl_currencies_id: "EUR",
  sale_invoice_type:"INVOICE", receivable_accounts_id:1210,
};

function setup() {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    transactions: {
      invalidateListCache: vi.fn(),
      listAll: vi.fn().mockResolvedValue([matchingTx]),
      get: vi.fn().mockResolvedValue({ ...matchingTx }),
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([matchingSale]) },
    purchaseInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([]) },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([{ id: 1, accounts_dimensions_id: BANK_DIMENSION_ID }]),
      getAccountDimensions: vi.fn().mockResolvedValue([
        { id: BANK_DIMENSION_ID, accounts_id: BANK_ACCOUNT_ID, is_deleted: false, title_est: "LHV" },
      ]),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Test OÜ" }),
    },
    journals: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([]), listAllWithPostings: vi.fn().mockResolvedValue([]) },
    clients: { findByName: vi.fn().mockResolvedValue([]) },
  } as any;
  api.saleInvoices.get = vi.fn(async (id: number) => (await api.saleInvoices.listAll()).find((row: any) => row.id === id));
  api.purchaseInvoices.get = vi.fn(async (id: number) => (await api.purchaseInvoices.listAll()).find((row: any) => row.id === id));
  api.transactions.update.mockImplementation(async (_id: number, body: any) => {
    api.transactions.get.mockResolvedValue({...matchingTx, ...body});
    return {};
  });
  api.transactions.confirm.mockImplementation(async()=>{
    api.transactions.get.mockResolvedValue({...matchingTx,clients_id:20,status:"CONFIRMED",items:[{relation_table:"sale_invoices",relation_id:10,amount:100,base_amount:100}]});
    api.journals.listAllWithPostings.mockResolvedValue([{id:901,operation_type:"TRANSACTION",operations_id:1,registered:true,clients_id:20,postings:[
      {accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:"D",amount:100},
      {accounts_id:1210,type:"C",amount:100},
    ]}]);
    return{};
  });
  registerBankReconciliationTools(server, api, createTestRuntimeSafetyContext(), EXPOSE_GRANULAR);
  const handler = (name: string) => {
    const registration = server.registerTool.mock.calls.find(([n]: [string]) => n === name);
    if (!registration) throw new Error(`Tool not registered: ${name}`);
    return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };
  return { api, handler };
}

async function call<T = ReconCompactPayload>(handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>, args: Record<string, unknown>): Promise<T> {
  return parseToolPayload<T>((await handler(args)).content[0]!.text);
}

describe("reconciliation compact profile routing", () => {
  it("standard profile keeps the full envelope (no compact summary)", async () => {
    const { handler } = setup();
    const payload = await call<ReconcileBankTransactionsPayload<ReconSuggestPayload>>(handler("reconcile_bank_transactions"), { mode: "suggest" });
    // Full merged envelope, not the compact operation_summary_v1.
    expect(payload.recommended_entry_point).toBe("reconcile_bank_transactions");
    expect(payload.result.matches).toBeDefined();
    expect(payload).not.toHaveProperty("summary");
  });

  it("guided suggest returns the compact operation summary (no per-row matches array)", async () => {
    const { handler } = setup();
    await runWithToolProfile("guided", async () => {
      const payload = await call(handler("reconcile_bank_transactions"), { mode: "suggest" });
      expect(payload.summary.contract).toBe("operation_summary_v1");
      expect(payload.summary.status).toBe("needs_review");
      expect(payload.summary.counts!.matched).toBe(1);
      expect(payload.summary.next_action!.tool).toBe("reconcile_bank_transactions");
      // No unbounded per-row matches array leaks into the compact surface.
      expect(payload).not.toHaveProperty("result");
      expect(payload).not.toHaveProperty("matches");
    });
  });

  it("guided dry_run_auto_confirm returns a compact summary with a plan handle", async () => {
    const { handler } = setup();
    await runWithToolProfile("guided", async () => {
      const payload = await call(handler("reconcile_bank_transactions"), { mode: "dry_run_auto_confirm", min_confidence: 50 });
      expect(payload.summary.contract).toBe("operation_summary_v1");
      expect(payload.summary.status).toBe("ready_for_approval");
      expect(typeof payload.summary.plan_handle).toBe("string");
      expect(payload.summary.counts!.would_confirm).toBe(1);
      expect(Number(payload.summary.totals!.EUR)).toBeGreaterThan(0);
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
      expect(exec.summary.details!.tool).toBe("get_operation_result_page");
      expect(typeof exec.summary.details!.args.operation_handle).toBe("string");
      expect(api.transactions.confirm).toHaveBeenCalled();
    });
  });

  it("guided dry_run_auto_confirm emits a ready-to-send execute next_action and it runs", async () => {
    const { handler, api } = setup();
    await runWithToolProfile("guided", async () => {
      const raw = (await handler("reconcile_bank_transactions")({ mode: "dry_run_auto_confirm", min_confidence: 50, block_on_duplicate: true })).content[0]!.text;
      expect(raw).not.toContain("auto_confirm_exact_matches");
      const dry = parseToolPayload<ReconCompactPayload>(raw);
      const next = dry.summary.next_action!;
      expect(next.tool).toBe("reconcile_bank_transactions");
      expect(next.args).toEqual({
        mode: "execute_auto_confirm", plan_handle: dry.summary.plan_handle, min_confidence: 50, block_on_duplicate: true,
      });
      expect(next.approval_required).toBe(true);
      // Sending next.args verbatim must not plan_drift against the reviewed dry run.
      const exec = await call(handler("reconcile_bank_transactions"), next.args);
      expect(exec.summary.contract).toBe("operation_summary_v1");
      expect(exec.summary.status).toBe("completed");
      expect(api.transactions.confirm).toHaveBeenCalled();
    });
  });

  it("guided execute_auto_confirm with block_on_duplicate keeps a blocked row to its blocked-duplicate warning", async () => {
    const { handler, api } = setup();
    // A registered journal already debits the bank dimension 100 EUR the same day.
    api.journals.listAllWithPostings.mockResolvedValue([{
      id: 555, registered: true, is_deleted: false, effective_date: "2026-03-20", title: "Manual receipt",
      postings: [{ accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 100, base_amount: 100, is_deleted: false }],
    }]);
    await runWithToolProfile("guided", async () => {
      const dry = await call(handler("reconcile_bank_transactions"), { mode: "dry_run_auto_confirm", min_confidence: 50, block_on_duplicate: true });
      const exec = await call(handler("reconcile_bank_transactions"), {
        mode: "execute_auto_confirm", plan_handle: dry.summary.plan_handle, min_confidence: 50, block_on_duplicate: true,
      });
      const codes = (exec.summary.warnings ?? []).map(w => w.code);
      expect(codes).toContain("blocked_duplicate_suspect");
      expect((exec.summary.warnings ?? []).some(w => w.code === "possible_duplicate" && w.message.startsWith("POSSIBLE duplicate"))).toBe(false);
      expect(api.transactions.confirm).not.toHaveBeenCalled();
    });
  });

  it("guided dry run → next_action → execute confirms a document_reference_exact row at the default threshold", async () => {
    const { handler, api } = setup();
    // Outgoing EUR 25.20 card payment naming the order number of the one open
    // purchase invoice: exact_amount 40 + client_name_partial 10 = 50 < 90.
    const docTx = withSignedCamtMarker({
      id: 1, status: "PROJECT", is_deleted: false, type: "C", amount: 25.2, date: "2026-10-18",
      accounts_dimensions_id: BANK_DIMENSION_ID, accounts_id: BANK_ACCOUNT_ID, cl_currencies_id: "EUR",
      bank_account_name: "Lux Express", ref_number: null, clients_id: null, description: "Lux Express 261018825247",
    }, "DBIT");
    const docInvoice = {
      id: 5577728, status: "CONFIRMED", payment_status: "", number: "PI-28", clients_id: 4100, client_name: "Lux Express",
      gross_price: 25.2, cl_currencies_id: "EUR", notes: "Ostukorvi/tellimuse nr: 261018825247", liability_accounts_id: 2310,
    };
    api.transactions.listAll.mockResolvedValue([docTx]);
    api.transactions.get.mockResolvedValue({ ...docTx });
    api.saleInvoices.listAll.mockResolvedValue([]);
    api.purchaseInvoices.listAll.mockResolvedValue([docInvoice]);
    api.transactions.update.mockImplementation(async (_id: number, body: Record<string, unknown>) => {
      api.transactions.get.mockResolvedValue({ ...docTx, ...body });
      return {};
    });
    api.transactions.confirm.mockImplementation(async () => {
      api.transactions.get.mockResolvedValue({ ...docTx, clients_id: 4100, status: "CONFIRMED",
        items: [{ relation_table: "purchase_invoices", relation_id: 5577728, amount: 25.2, base_amount: 25.2 }] });
      api.journals.listAllWithPostings.mockResolvedValue([{ id: 902, operation_type: "TRANSACTION", operations_id: 1, registered: true, clients_id: 4100, postings: [
        { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "C", amount: 25.2 },
        { accounts_id: 2310, type: "D", amount: 25.2 },
      ] }]);
      return {};
    });
    await runWithToolProfile("guided", async () => {
      const dry = await call(handler("reconcile_bank_transactions"), { mode: "dry_run_auto_confirm" });
      expect(dry.summary.status).toBe("ready_for_approval");
      expect(dry.summary.counts).toMatchObject({ would_confirm: 1, document_reference_exact: 1, skipped: 0 });
      expect((dry.summary.warnings ?? []).map(w => [w.code, w.item_id])).toContainEqual(["document_reference_exact", "1"]);
      const next = dry.summary.next_action!;
      expect(next.args).toEqual({ mode: "execute_auto_confirm", plan_handle: dry.summary.plan_handle });
      expect(next.approval_required).toBe(true);
      expect(api.transactions.confirm).not.toHaveBeenCalled();

      const exec = await call(handler("reconcile_bank_transactions"), next.args);
      expect(exec.summary.status).toBe("completed");
      expect(api.transactions.update).toHaveBeenCalledWith(1, { clients_id: 4100 });
      expect(api.transactions.confirm.mock.calls.map((c: unknown[]) => [c[0], c[1]])).toEqual([
        [1, [{ related_table: "purchase_invoices", related_id: 5577728, amount: 25.2 }]],
      ]);
    });
  });

  it("guided inter_account_dry_run names only the guided execute route and it runs", async () => {
    const { handler } = setup();
    await runWithToolProfile("guided", async () => {
      const raw = (await handler("reconcile_bank_transactions")({ mode: "inter_account_dry_run", max_date_gap: 2 })).content[0]!.text;
      expect(raw).not.toContain("reconcile_inter_account_transfers");
      const dry = parseToolPayload<ReconCompactPayload>(raw);
      expect(dry.summary.contract).toBe("operation_summary_v1");
      const next = dry.summary.next_action!;
      expect(next.tool).toBe("reconcile_bank_transactions");
      expect(next.args).toEqual({ mode: "execute_inter_account", plan_handle: dry.summary.plan_handle, max_date_gap: 2 });
      expect(next.approval_required).toBe(true);
      const exec = await call(handler("reconcile_bank_transactions"), next.args);
      expect(exec.summary.contract).toBe("operation_summary_v1");
      expect(exec.summary.status).toBe("completed");
    });
  });
});
