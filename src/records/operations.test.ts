import { describe, expect, it, vi } from "vitest";
import { createRecordOperations } from "./operations.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
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

describe("RecordOperations.search — clients query name filter", () => {
  it("filters clients by name via the SAME matcher search_client uses (api.clients.findByName)", async () => {
    const findByName = vi.fn().mockResolvedValue([{ id: 7, name: "Bolt Operations OÜ" }]);
    const list = vi.fn();
    const api = makeApi({ clients: list });
    (api.clients as unknown as { findByName: typeof findByName }).findByName = findByName;
    const ops = createRecordOperations(api, exposure);
    const outcome = await ops.search({ entity: "clients", filters: { query: "bolt" } });
    expect(outcome.ok).toBe(true);
    expect(findByName).toHaveBeenCalledWith("bolt");
    expect(list).not.toHaveBeenCalled();
    if (!outcome.ok) return;
    expect(outcome.value.items).toEqual([{ id: 7, name: "Bolt Operations OÜ" }]);
    expect(outcome.value.total_items).toBe(1);
    expect(outcome.value.page).toBe(1);
    expect(outcome.value.total_pages).toBe(1);
  });

  it("strips sandbox markers from a wrapped query before matching (round-trip parity with search_client)", async () => {
    // A client name read back from any records output is wrapUntrustedOcr-wrapped.
    // An agent passing that wrapped string straight back as `query` must still
    // match — search_client strips markers via desandboxText, and so must this.
    const findByName = vi.fn().mockResolvedValue([{ id: 9, name: "Bolt Operations OÜ" }]);
    const api = makeApi({ clients: vi.fn() });
    (api.clients as unknown as { findByName: typeof findByName }).findByName = findByName;
    const ops = createRecordOperations(api, exposure);
    const wrapped = wrapUntrustedOcr("Bolt Operations OÜ")!;
    expect(wrapped).toContain("UNTRUSTED_OCR_START");
    const outcome = await ops.search({ entity: "clients", filters: { query: wrapped } });
    expect(outcome.ok).toBe(true);
    // findByName receives the CLEAN, desandboxed name — NOT the wrapped string.
    expect(findByName).toHaveBeenCalledWith("Bolt Operations OÜ");
    expect(findByName).not.toHaveBeenCalledWith(wrapped);
  });

  it("gives results identical to search_client for the same input (both delegate to findByName)", async () => {
    const rows = [{ id: 1, name: "ACME AS" }, { id: 2, name: "ACME Retail OÜ" }];
    const findByName = vi.fn().mockResolvedValue(rows);
    const api = makeApi({ clients: vi.fn() });
    (api.clients as unknown as { findByName: typeof findByName }).findByName = findByName;
    const ops = createRecordOperations(api, exposure);
    // search_client's own behavior is `api.clients.findByName(name)`; the façade
    // must return exactly that set for the same query — parity by shared source.
    const viaSearchClient = await api.clients.findByName("acme");
    findByName.mockClear();
    findByName.mockResolvedValue(rows);
    const outcome = await ops.search({ entity: "clients", filters: { query: "acme" } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.items).toEqual(viaSearchClient);
  });

  it("rejects query on a non-clients entity — bounded allowlist stays intact (filter_not_allowed)", async () => {
    const list = vi.fn();
    const api = makeApi({ transactions: list });
    const ops = createRecordOperations(api, exposure);
    const outcome = await ops.search({ entity: "transactions", filters: { query: "bolt" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("filter_not_allowed");
    expect(list).not.toHaveBeenCalled();
  });

  it("clients without a query still uses the paged list (query is optional)", async () => {
    const list = vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [{ id: 1 }] });
    const findByName = vi.fn();
    const api = makeApi({ clients: list });
    (api.clients as unknown as { findByName: typeof findByName }).findByName = findByName;
    const ops = createRecordOperations(api, exposure);
    const outcome = await ops.search({ entity: "clients", filters: { page: 1 } });
    expect(outcome.ok).toBe(true);
    expect(list).toHaveBeenCalled();
    expect(findByName).not.toHaveBeenCalled();
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
