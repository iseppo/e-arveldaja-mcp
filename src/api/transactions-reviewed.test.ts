import { beforeEach, expect, it, vi } from "vitest";
import { TransactionsApi, TransactionMaterialDriftError } from "./transactions.api.js";
import { cache } from "./base-resource.js";
import { snapshotBankTransaction, snapshotLinkedInvoice } from "../banking/transaction-material-snapshot.js";
import type { Transaction } from "../types/api.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => cache.invalidate());

function fixture() {
  let tx: Transaction = { id: 1, status: "PROJECT", type: "C", amount: 108, base_amount: 100,
    currency_rate: 1.08, cl_currencies_id: "USD", date: "2026-10-18", clients_id: 7,
    accounts_id: 1020, accounts_dimensions_id: 9, ref_number: "REF1" };
  let invoice: any = { id: 51, clients_id: 42, gross_price: 100, cl_currencies_id: "EUR", bank_ref_number: "REF1" };
  let invoiceReads = 0;
  const afterInvoiceRead = vi.fn();
  const afterClientWrite = vi.fn();
  const http: any = { cacheNamespace: "reviewed-test",
    get: vi.fn(async (path: string) => {
      if (path === "/transactions/1") return { ...tx };
      if (path === "/purchase_invoices/51") {
        afterInvoiceRead(++invoiceReads);
        return { ...invoice };
      }
      throw new Error("Unexpected offline read " + path);
    }),
    patch: vi.fn(async (path: string, body: any) => {
      if (path === "/transactions/1") { tx = { ...tx, clients_id: body.clients_id }; afterClientWrite(); }
      else expect(path).toBe("/transactions/1/register");
      return { code: 200 };
    }),
  };
  const options = { expectedTransaction: snapshotBankTransaction(tx),
    expectedLinkedInvoices: { "purchase_invoices:51": snapshotLinkedInvoice("purchase_invoices", invoice) },
    reassignClientToInvoice: true, approvedClientTransition: { from: 7, to: 42 } };
  const api = new TransactionsApi(http);
  const run = () => api.confirm(1, [{ related_table: "purchase_invoices", related_id: 51, amount: 100 }], options);
  return { api, http, options, run, afterInvoiceRead, afterClientWrite,
    changeTx: (patch: Partial<Transaction>) => { tx = { ...tx, ...patch }; },
    changeInvoice: (patch: any) => { invoice = { ...invoice, ...patch }; } };
}

it("reviewed confirm preserves nominal/base FX and the exact approved reassignment", async () => {
  const f = fixture();
  await f.run();
  expect(f.http.patch.mock.calls.map((call: any[]) => call[0])).toEqual(["/transactions/1", "/transactions/1/register"]);
  expect(f.http.patch.mock.calls[0][1]).toEqual({ clients_id: 42 });
});

it.each([{ clients_id: 99 }, { bank_ref_number: "OTHER" }, { gross_price: 999 }, { notes: "Ostukorvi/tellimuse nr: 261018825247" }])("refuses awaited invoice material drift before any write: %j", patch => {
  const f = fixture();
  f.afterInvoiceRead.mockImplementation(() => f.changeInvoice(patch));
  return expect(f.run()).rejects.toMatchObject({ category: "transaction_material_drift", invoice_key: "purchase_invoices:51",
    mutation_occurred: false, register_attempted: false }).then(() => expect(f.http.patch).not.toHaveBeenCalled());
});

it("retains actual own client update when material drifts on readback", async () => {
  const f = fixture();
  f.afterClientWrite.mockImplementation(() => f.changeTx({ ref_number: "CORRECTED" }));
  await expect(f.run()).rejects.toMatchObject({ category: "transaction_material_drift", mutation_occurred: true,
    mutation_may_have_occurred: true, register_attempted: false, automatic_retry_forbidden: true,
    known_objects: [{ entity_type: "transaction", entity_id: 1, outcome: "updated" }],
    client_update: { from: 7, to: 42, outcome: "updated" } });
  expect(f.http.patch.mock.calls.map((call: any[]) => call[0])).toEqual(["/transactions/1"]);
});

// Sol review MINOR 2: the final invoice reread after the client update.
it("refuses registration when the invoice's order references change after the client update, reporting the update", async () => {
  const f = fixture();
  f.afterClientWrite.mockImplementation(() => f.changeInvoice({ notes: "Ostukorvi/tellimuse nr: 261018825247" }));
  await expect(f.run()).rejects.toMatchObject({ category: "transaction_material_drift", invoice_key: "purchase_invoices:51",
    mutation_occurred: true, register_attempted: false,
    known_objects: [{ entity_type: "transaction", entity_id: 1, outcome: "updated" }],
    client_update: { from: 7, to: 42, outcome: "updated" } });
  expect(f.http.patch.mock.calls.map((call: unknown[]) => call[0])).toEqual(["/transactions/1"]);
});

it("refuses registration when the invoice drifts on its second read without a client update", async () => {
  const f = fixture();
  f.changeTx({ clients_id: 42 });
  f.options.expectedTransaction = snapshotBankTransaction({ id: 1, status: "PROJECT", type: "C", amount: 108,
    base_amount: 100, currency_rate: 1.08, cl_currencies_id: "USD", date: "2026-10-18", clients_id: 42,
    accounts_id: 1020, accounts_dimensions_id: 9, ref_number: "REF1" });
  f.afterInvoiceRead.mockImplementation((read: number) => {
    if (read === 2) f.changeInvoice({ notes: "Ostukorvi/tellimuse nr: 261018825247" });
  });
  await expect(f.run()).rejects.toMatchObject({ category: "transaction_material_drift", invoice_key: "purchase_invoices:51",
    mutation_occurred: false, register_attempted: false });
  expect(f.afterInvoiceRead).toHaveBeenCalledTimes(2);
  expect(f.http.patch).not.toHaveBeenCalled();
});

it("constrains missing-client auto-fill to the reviewed target too", async () => {
  const f = fixture();
  f.changeTx({ clients_id: null });
  f.options.expectedTransaction = snapshotBankTransaction({ id: 1, status: "PROJECT", type: "C", amount: 108,
    base_amount: 100, currency_rate: 1.08, cl_currencies_id: "USD", date: "2026-10-18", clients_id: null,
    accounts_id: 1020, accounts_dimensions_id: 9, ref_number: "REF1" });
  await expect(f.run()).rejects.toBeInstanceOf(TransactionMaterialDriftError);
  expect(f.http.patch).not.toHaveBeenCalled();
});

it("refuses tx drift occurring while awaiting an unchanged linked invoice", async () => {
  const f = fixture();
  f.afterInvoiceRead.mockImplementation(() => f.changeTx({ date: "2026-10-19" }));
  await expect(f.run()).rejects.toMatchObject({ category: "transaction_material_drift", mutation_occurred: false });
  expect(f.http.patch).not.toHaveBeenCalled();
});

it("allows an exact null-to-reviewed-client fill then unchanged final confirmation",async()=>{
  const f=fixture();f.changeTx({clients_id:null});
  f.options.expectedTransaction={...f.options.expectedTransaction,clients_id:null};
  f.options.approvedClientTransition={from:null as any,to:42};
  await f.run();
  expect(f.http.patch.mock.calls.map((call:any[])=>call[0])).toEqual(["/transactions/1","/transactions/1/register"]);
  expect(f.http.patch.mock.calls[0]![1]).toEqual({clients_id:42});
});
it("does not treat completed client fill as exemption for later external reassignment",async()=>{
  const f=fixture();f.afterClientWrite.mockImplementation(()=>f.changeTx({clients_id:99}));
  await expect(f.run()).rejects.toMatchObject({category:"transaction_material_drift",mutation_occurred:true,register_attempted:false,client_update:{from:7,to:42,outcome:"updated"}});
  expect(f.http.patch.mock.calls.map((call:any[])=>call[0])).toEqual(["/transactions/1"]);
});
