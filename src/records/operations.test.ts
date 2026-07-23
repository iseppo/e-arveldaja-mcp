import { describe, expect, it, vi } from "vitest";
import { createRecordOperations } from "./operations.js";
import type { ApiContext } from "../tools/crud/shared.js";

function makeApi(listImpls: Record<string, ReturnType<typeof vi.fn>> = {}, getImpls: Record<string, ReturnType<typeof vi.fn>> = {}): ApiContext {
  const mk = (name: string) => ({
    list: listImpls[name] ?? vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [] }),
    get: getImpls[name] ?? vi.fn().mockResolvedValue({ id: 1 }),
  });
  return {
    journals: mk("journals"),
    transactions: mk("transactions"),
    clients: mk("clients"),
    purchaseInvoices: mk("purchase_invoices"),
    saleInvoices: mk("sale_invoices"),
    products: mk("products"),
    readonly: {},
  } as unknown as ApiContext;
}

const exposure = { enableSales: true, enableProducts: true };

describe("RecordOperations.search — bounded entity + filter allowlist", () => {
  it("maps date_from/date_to to the API start_date/end_date for an allowed entity", async () => {
    const list = vi.fn().mockResolvedValue({ current_page: 1, total_pages: 3, items: [{ id: 42 }] });
    const api = makeApi({ purchase_invoices: list });
    const ops = createRecordOperations(api, exposure);
    const outcome = await ops.search({ entity: "purchase_invoices", filters: { date_from: "2026-01-01", date_to: "2026-06-30", page: 1 } });
    expect(outcome.ok).toBe(true);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ start_date: "2026-01-01", end_date: "2026-06-30", page: 1 }));
    if (!outcome.ok) return;
    expect(outcome.value.total_pages).toBe(3);
    expect(outcome.value.items).toEqual([{ id: 42 }]);
  });

  it("rejects a filter outside the entity allowlist (journals do not accept payment_status)", async () => {
    const list = vi.fn();
    const api = makeApi({ journals: list });
    const ops = createRecordOperations(api, exposure);
    const outcome = await ops.search({ entity: "journals", filters: { payment_status: "PAID" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("filter_not_allowed");
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects an un-enumerated entity (no universal executor)", async () => {
    const ops = createRecordOperations(makeApi(), exposure);
    const outcome = await ops.search({ entity: "accounts" as never });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_entity");
  });

  it("gates sale_invoices when sales is disabled", async () => {
    const list = vi.fn();
    const api = makeApi({ sale_invoices: list });
    const ops = createRecordOperations(api, { enableSales: false, enableProducts: true });
    const outcome = await ops.search({ entity: "sale_invoices" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("entity_unavailable");
    expect(list).not.toHaveBeenCalled();
  });
});

describe("RecordOperations.inspect", () => {
  it("fetches one record by id via the fixed api.<entity>.get", async () => {
    const get = vi.fn().mockResolvedValue({ id: 99, client_name: "X" });
    const api = makeApi({}, { clients: get });
    const ops = createRecordOperations(api, exposure);
    const outcome = await ops.inspect({ entity: "clients", id: 99 });
    expect(outcome.ok).toBe(true);
    expect(get).toHaveBeenCalledWith(99);
    if (!outcome.ok) return;
    expect(outcome.value.record).toEqual({ id: 99, client_name: "X" });
  });

  it("rejects a non-positive id without touching the API", async () => {
    const get = vi.fn();
    const api = makeApi({}, { clients: get });
    const ops = createRecordOperations(api, exposure);
    const outcome = await ops.inspect({ entity: "clients", id: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_id");
    expect(get).not.toHaveBeenCalled();
  });
});
