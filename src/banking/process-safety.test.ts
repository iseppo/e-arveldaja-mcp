import { beforeEach, expect, it, vi } from "vitest";
import { registerBankReconciliationTools } from "../tools/bank-reconciliation.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { withSignedCamtMarker } from "../__fixtures__/camt-marker.js";
import { parseMcpResponse } from "../mcp-json.js";
import { TransactionsApi } from "../api/transactions.api.js";
import { cache } from "../api/base-resource.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => cache.invalidate());

function publicBank(api: any) {
  const server = { registerTool: vi.fn() } as any;
  registerBankReconciliationTools(server, api, createTestRuntimeSafetyContext());
  const handler = server.registerTool.mock.calls.find((args: any) => args[0] === "reconcile_bank_transactions")![2];
  return async (args: Record<string, unknown>) => parseMcpResponse((await handler(args)).content[0].text) as any;
}

const sale = { id: 501, number: "INV-501", clients_id: 42, gross_price: 100, base_gross_price: 100,
  bank_ref_number: "REF1", payment_status: "NOT_PAID", status: "CONFIRMED", client_name: "Acme",
  cl_currencies_id: "EUR", receivable_accounts_id: 1210, sale_invoice_type: "INVOICE" };
const incoming = () => withSignedCamtMarker({ id: 1, status: "PROJECT", is_deleted: false, type: "C",
  amount: 100, base_amount: 100, ref_number: "REF1", clients_id: 42, date: "2026-01-10",
  accounts_dimensions_id: 9, accounts_id: 1020, cl_currencies_id: "EUR" }, "CRDT");

function exactApi() {
  let current: any = incoming();
  let currentSale: any = {...sale};
  let registered = false;
  const journal: any = { id: 801, operation_type: "TRANSACTION", operations_id: 1, registered: true,
    is_deleted: false, clients_id: 42, effective_date: current.date, postings: [
      { accounts_id: 1020, accounts_dimensions_id: 9, type: "D", amount: 100 },
      { accounts_id: 1210, type: "C", amount: 100 },
    ] };
  const api: any = {
    transactions: { invalidateListCache: vi.fn(), listAll: vi.fn(async () => [current]),
      get: vi.fn(async () => ({ ...current, status: registered ? "CONFIRMED" : "PROJECT",
        ...(registered ? { items: [{ relation_table: "sale_invoices", relation_id: 501, amount: 100, base_amount: 100 }] } : {}) })),
      confirm: vi.fn(async () => { registered = true; return {}; }) },
    saleInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn(async () => [currentSale]), get: vi.fn(async () => currentSale) },
    purchaseInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn(async () => []) },
    journals: { invalidateListCache: vi.fn(), listAllWithPostings: vi.fn(async () => registered ? [journal] : []) },
    readonly: { getBankAccounts: vi.fn(async () => [{ accounts_dimensions_id: 9 }, { accounts_dimensions_id: 10 }]),
      getAccountDimensions: vi.fn(async () => [{ id: 9, accounts_id: 1020 }, { id: 10, accounts_id: 1020 }]) },
  };
  return { api, journal, change: (row: any) => { current = row; }, changeInvoice:(patch:any)=>{currentSale={...currentSale,...patch};} };
}

it.each([{date:"2026-01-11"},{accounts_dimensions_id:10},{accounts_id:1021},{base_amount:99},{currency_rate:1.01},{ref_number:"CHANGED"},{bank_account_name:"Changed payer"},{clients_id:99}])("M6 final command GET refuses material drift after unchanged initial re-projection: %j",async patch=>{
  const {api}=exactApi();const run=publicBank(api);const dry=await run({mode:"dry_run_auto_confirm"});
  const get=api.transactions.get.getMockImplementation();let reads=0;
  api.transactions.get.mockImplementation(async()=>++reads===1?get():withSignedCamtMarker({...incoming(),...patch},"CRDT"));
  const result=await run({mode:"execute_auto_confirm",plan_handle:dry.result.plan_handle});
  expect(api.transactions.confirm).not.toHaveBeenCalled();expect(JSON.stringify(result)).toContain("transaction_material_drift");
});
it.each([{bank_ref_number:"OTHER"},{number:"CHANGED"},{gross_price:101},{receivable_accounts_id:1211},{client_name:"Changed"}])("M6 reviewed invoice identity drift refuses despite unchanged invoice/client key: %j",async patch=>{
  const {api,changeInvoice}=exactApi();const run=publicBank(api);const dry=await run({mode:"dry_run_auto_confirm"});changeInvoice(patch);
  const result=await run({mode:"execute_auto_confirm",plan_handle:dry.result.plan_handle});
  expect(api.transactions.confirm).not.toHaveBeenCalled();expect(JSON.stringify(result)).toContain("plan_drift");
});
it("M6 unchanged EUR incoming sale completes and verifies actual bank D / receivable C",async()=>{
  const {api}=exactApi();const run=publicBank(api);const dry=await run({mode:"dry_run_auto_confirm"});
  const result=await run({mode:"execute_auto_confirm",plan_handle:dry.result.plan_handle});
  expect(api.transactions.confirm).toHaveBeenCalledTimes(1);expect(result.result.ledger_checks).toMatchObject({checked:1,ok:1,failures:[]});
});
it.each(["foreign_missing_base","negative"])("B1 public aggregation preserves committed IDs and refuses verified OK for %s",async scenario=>{
  const {api,journal}=exactApi();
  journal.cl_currencies_id=scenario==="negative"?"EUR":"USD";
  journal.postings=journal.postings.map((row:any)=>({...row,amount:scenario==="negative"?-100:100,cl_currencies_id:journal.cl_currencies_id}));
  const run=publicBank(api);const dry=await run({mode:"dry_run_auto_confirm"});
  const result=await run({mode:"execute_auto_confirm",plan_handle:dry.result.plan_handle});
  expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
  expect(result.result.ledger_checks).toMatchObject({checked:1,ok:0,failures:[expect.objectContaining({transaction_id:1,journal_id:801,code:"ledger_posting_mismatch"})]});
  expect(result.result).toMatchObject({accounting_status:"needs_review",mutation_occurred:true,automatic_retry_forbidden:true});
  expect(result.result.execution.execution_report.known_object_ids).toContainEqual(expect.objectContaining({entity_id:1,outcome:"confirmed"}));
});

it("M6 public plan refuses date and bank dimension drift even with a newly valid signature", async () => {
  const { api, change } = exactApi();
  const run = publicBank(api);
  const dry = await run({ mode: "dry_run_auto_confirm" });
  change(withSignedCamtMarker({ ...incoming(), date: "2026-01-11", accounts_dimensions_id: 10 }, "CRDT"));
  const result = await run({ mode: "execute_auto_confirm", plan_handle: dry.result.plan_handle });
  expect(api.transactions.confirm).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).toContain("plan_drift");
});

it("M5 public execution retains a mirror changed during the preceding source confirmation", async () => {
  const out = withSignedCamtMarker({ id: 1, status: "PROJECT", is_deleted: false, type: "C", amount: 100,
    base_amount: 100, cl_currencies_id: "EUR", date: "2026-10-01", accounts_dimensions_id: 100,
    accounts_id: 1020, clients_id: 99, bank_account_name: "Test OÜ", bank_account_no: "BE08905767222113" }, "DBIT");
  const mirror = withSignedCamtMarker({ ...out, id: 2, accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" }, "CRDT");
  let source: any = out;
  let currentMirror: any = mirror;
  const journal = { id: 811, operation_type: "TRANSACTION", operations_id: 1, registered: true,
    is_deleted: false, effective_date: out.date, postings: [
      { accounts_id: 1020, accounts_dimensions_id: 100, type: "C", amount: 100 },
      { accounts_id: 1020, accounts_dimensions_id: 200, type: "D", amount: 100 },
    ] };
  const api: any = {
    transactions: { invalidateListCache: vi.fn(), listAll: vi.fn(async () => [out, mirror]),
      get: vi.fn(async (id: number) => id === 1 ? source : currentMirror), update: vi.fn(),
      confirm: vi.fn(async () => {
        source = { ...out, status: "CONFIRMED", items: [{ accounts_id: 1020, accounts_dimensions_id: 200, amount: 100, base_amount: 100, cl_currencies_id: "EUR" }] };
        currentMirror = { ...mirror, amount: 999, base_amount: 999, bank_account_name: "External supplier", bank_account_no: "DE89370400440532013000" };
        return {};
      }), delete: vi.fn() },
    journals: { invalidateListCache: vi.fn(), listAllWithPostings: vi.fn(async () => source.status === "CONFIRMED" ? [journal] : []) },
    clients: { findByName: vi.fn(async () => [{ id: 99, name: "Test OÜ" }]) },
    readonly: { getBankAccounts: vi.fn(async () => [
      { accounts_dimensions_id: 100, iban_code: "EE123456789012345678", account_name_est: "LHV" },
      { accounts_dimensions_id: 200, iban_code: "BE08905767222113", account_name_est: "Wise" }]),
      getAccountDimensions: vi.fn(async () => [{ id: 100, accounts_id: 1020 }, { id: 200, accounts_id: 1020 }]),
      getInvoiceInfo: vi.fn(async () => ({ invoice_company_name: "Test OÜ" })) },
  };
  const run = publicBank(api);
  const dry = await run({ mode: "inter_account_dry_run" });
  const result = await run({ mode: "execute_inter_account", plan_handle: dry.result.plan_handle });
  expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
  expect(api.transactions.delete).not.toHaveBeenCalled();
  expect(currentMirror.amount).toBe(999);
  expect(result.result.execution.execution_report).toMatchObject({ status: "partial_execution", automatic_retry_forbidden: true });
  expect(result.result.execution.execution_report.known_object_ids).toContainEqual(expect.objectContaining({ entity_type: "transaction", entity_id: 1, outcome: "confirmed" }));
});

it("M7 public real API adapter reports committed opposite cash direction with actual IDs and no retry", async () => {
  let registered = false;
  const tx = withSignedCamtMarker({ ...incoming(), id: 71 }, "CRDT", "HISTORICAL71");
  const journal = { id: 871, operation_type: "TRANSACTION", operations_id: 71, registered: true,
    is_deleted: false, effective_date: tx.date, clients_id: 42, postings: [
      { accounts_id: 1020, accounts_dimensions_id: 9, type: "C", amount: 100 },
      { accounts_id: 1210, type: "D", amount: 100 },
    ] };
  const http: any = { connectionFingerprint: "process-safety", cacheNamespace: "process-safety",
    get: vi.fn(async (path: string) => {
      if (path === "/transactions/71") return { ...tx, status: registered ? "CONFIRMED" : "PROJECT",
        ...(registered ? { items: [{ relation_table: "sale_invoices", relation_id: 501, amount: 100, base_amount: 100 }] } : {}) };
      if (path === "/sale_invoices/501") return sale;
      throw new Error("Unexpected offline GET " + path);
    }), patch: vi.fn(async (path: string) => {
      expect(path).toBe("/transactions/71/register"); registered = true; return { code: 200 };
    }) };
  const transactions = new TransactionsApi(http);
  transactions.listAll = vi.fn(async () => [tx]);
  const { api } = exactApi();
  api.transactions = transactions;
  api.journals.listAllWithPostings = vi.fn(async () => registered ? [journal] : []);
  const run = publicBank(api);
  const dry = await run({ mode: "dry_run_auto_confirm" });
  const result = await run({ mode: "execute_auto_confirm", plan_handle: dry.result.plan_handle });
  expect(http.patch, JSON.stringify(result)).toHaveBeenCalledTimes(1);
  expect(result.result.ledger_checks.ok).toBe(0);
  expect(result.result.ledger_checks.failures).toContainEqual(expect.objectContaining({ transaction_id: 71, journal_id: 871, code: "ledger_posting_mismatch" }));
  expect(result.result.summary.error_count).toBeGreaterThan(0);
});
