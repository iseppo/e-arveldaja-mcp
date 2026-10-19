import { describe, expect, it, vi } from "vitest";
import { prepareExactConfirm, runInterAccountMatching } from "./executor.js";
import { createTestRuntimeSafetyContext } from "../../__fixtures__/runtime-safety.js";
import { withSignedCamtMarker } from "../../__fixtures__/camt-marker.js";

vi.mock("../../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../progress.js", () => ({ reportProgress: vi.fn() }));

function setup(rows: any[], details = rows) {
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue(rows), invalidateListCache: vi.fn(),
      get: vi.fn(async (id: number) => details.find(row => row.id === id)),
    },
    saleInvoices: { listAll: vi.fn().mockResolvedValue([]), get: vi.fn(), invalidateListCache: vi.fn() },
    purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]), get: vi.fn(), invalidateListCache: vi.fn() },
    journals: { listAll: vi.fn().mockResolvedValue([]), listAllWithPostings: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
    clients: { findByName: vi.fn().mockResolvedValue([]) },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Example OÜ" }),
    },
  };
  return api as any;
}

describe("bank preview work selection", () => {
  it("issues an empty exact-match plan without reading historical invoices", async () => {
    const api = setup([{ id: 1, status: "CONFIRMED" }, { id: 2, status: "VOID" }]);
    const result = await prepareExactConfirm(api, createTestRuntimeSafetyContext(), {} as any);
    expect(result.projection.totalUnconfirmed).toBe(0);
    expect(result.projection.confirms).toEqual([]);
    expect(result.planHandle).toEqual(expect.any(String));
    expect(api.transactions.get).not.toHaveBeenCalled();
    expect(api.saleInvoices.listAll).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.listAll).not.toHaveBeenCalled();
    expect(api.journals.listAllWithPostings).not.toHaveBeenCalled();
    expect(api.journals.listAll).not.toHaveBeenCalled();
  });

  it("returns a complete empty inter-account preview without transaction or journal history details", async () => {
    const api = setup(Array.from({ length: 1000 }, (_, id) => ({ id: id + 1, status: "CONFIRMED" })));
    const result = await runInterAccountMatching(api, {} as any);
    expect(result).toMatchObject({ totalUnconfirmed: 0, confirmActions: [], matchedPairs: [], companyClientsId: null });
    expect(result.fingerprint).toEqual(expect.any(String));
    expect(api.transactions.get).not.toHaveBeenCalled();
    expect(api.journals.listAllWithPostings).not.toHaveBeenCalled();
    expect(api.journals.listAll).not.toHaveBeenCalled();
    expect(api.clients.findByName).not.toHaveBeenCalled();
  });

  it.each([undefined, "UNKNOWN"])("resolves list status %s by detail before declaring no pending work", async status => {
    const row = { id: 1, status: "PROJECT", amount: 1, type: "C", date: "2026-01-01", accounts_dimensions_id: 9, cl_currencies_id: "EUR" };
    const api = setup([{ id: 1, status }, { id: 2, status: "CONFIRMED" }], [row]);
    const result = await runInterAccountMatching(api, {} as any);
    expect(result.totalUnconfirmed).toBe(1);
    expect(api.transactions.get.mock.calls).toEqual([[1]]);
    expect(api.journals.listAll).toHaveBeenCalled();
  });

  it("rejects unresolved detail status instead of claiming an empty queue", async () => {
    const api = setup([{ id: 1 }], [{ id: 1, status: "UNKNOWN" }]);
    await expect(runInterAccountMatching(api, {} as any)).rejects.toThrow(/status/i);
    await expect(prepareExactConfirm(api, createTestRuntimeSafetyContext(), {} as any)).rejects.toThrow(/status/i);
  });

  it("rechecks draft eligibility after a detail read reports confirmation", async () => {
    const api = setup([{ id: 1, status: "PROJECT" }], [{ id: 1, status: "CONFIRMED" }]);
    const result = await prepareExactConfirm(api, createTestRuntimeSafetyContext(), {} as any);
    expect(result.projection.totalUnconfirmed).toBe(0);
    expect(api.saleInvoices.listAll).not.toHaveBeenCalled();
  });

  it("refreshes list status before deciding there is no pending work", async () => {
    const api = setup([]);
    await runInterAccountMatching(api, {} as any);
    expect(api.transactions.invalidateListCache.mock.invocationCallOrder[0])
      .toBeLessThan(api.transactions.listAll.mock.invocationCallOrder[0]);
  });

  it("reads only the confirmed counterpart needed for a matched journal mirror proof", async () => {
    const sourceIban = "EE123456789012345678";
    const targetIban = "BE08905767222113";
    const draft = withSignedCamtMarker({ id: 2, status: "PROJECT", type: "C", amount: 100,
      date: "2026-01-01", cl_currencies_id: "EUR", accounts_dimensions_id: 10,
      bank_account_no: targetIban, bank_account_name: "Example OÜ" }, "DBIT");
    const confirmed = { id: 1, status: "CONFIRMED", type: "D", amount: 100,
      date: draft.date, cl_currencies_id: "EUR", accounts_dimensions_id: 20,
      description: "WISE:TRANSFER-1 [source_direction=IN]" };
    const api = setup([confirmed, draft, { id: 3, status: "CONFIRMED" }]);
    api.readonly.getBankAccounts.mockResolvedValue([
      { id: 1, iban_code: sourceIban, accounts_dimensions_id: 10 },
      { id: 2, iban_code: targetIban, accounts_dimensions_id: 20 },
    ]);
    api.journals.listAllWithPostings.mockResolvedValue([{
      id: 50, effective_date: draft.date, registered: true, operation_type: "TRANSACTION", operations_id: 1,
      postings: [
        { accounts_id: 1020, accounts_dimensions_id: 10, type: "C", amount: 100, base_amount: 100 },
        { accounts_id: 1020, accounts_dimensions_id: 20, type: "D", amount: 100, base_amount: 100 },
      ],
    }]);
    const result = await runInterAccountMatching(api, {} as any);
    expect(result.skippedAlreadyHandled[0]?.mirror_proposal?.counterpart_transaction_id).toBe(1);
    expect(api.transactions.get.mock.calls).toEqual([[2], [1]]);
    expect(result.confirmActions).toEqual([]);
  });
});
