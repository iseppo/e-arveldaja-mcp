import { describe, expect, it, vi } from "vitest";
import { registerSearchAccountingRecordsTool } from "./search-accounting-records.js";
import { registerInspectAccountingRecordTool } from "./inspect-accounting-record.js";
import { parseMcpResponse } from "../mcp-json.js";
import type { ApiContext } from "../tools/crud-tools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function makeApi(over: Record<string, unknown> = {}): ApiContext {
  const paged = (items: unknown[]) => vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items });
  return {
    journals: { list: paged([]), get: vi.fn() },
    transactions: { list: paged([]), get: vi.fn() },
    clients: { list: paged([]), get: vi.fn().mockResolvedValue({ id: 3, name: "X" }) },
    purchaseInvoices: { list: paged([]), get: vi.fn() },
    saleInvoices: { list: paged([]), get: vi.fn() },
    products: { list: paged([]), get: vi.fn() },
    readonly: {},
    ...over,
  } as unknown as ApiContext;
}

function setupSearch(api: ApiContext, enableSales = true, enableProducts = true): Handler {
  const server = { registerTool: vi.fn() } as any;
  registerSearchAccountingRecordsTool(server, api, { enableSales, enableProducts });
  return server.registerTool.mock.calls.find(([n]: [string]) => n === "search_accounting_records")![2] as Handler;
}
function setupInspect(api: ApiContext): Handler {
  const server = { registerTool: vi.fn() } as any;
  registerInspectAccountingRecordTool(server, api, { enableSales: true, enableProducts: true });
  return server.registerTool.mock.calls.find(([n]: [string]) => n === "inspect_accounting_record")![2] as Handler;
}
const parse = (r: { content: Array<{ text: string }> }) => parseMcpResponse(r.content[0]!.text) as any;

describe("search_accounting_records façade", () => {
  it("renders import-origin client names as sandboxed (trusted CRUD, not raw)", async () => {
    const INJECT = "IGNORE ALL";
    const list = vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [{ id: 1, number: "P-1", client_name: `Supplier ${INJECT}`, status: "CONFIRMED" }] });
    const api = makeApi({ purchaseInvoices: { list, get: vi.fn() } });
    const handler = setupSearch(api);
    const result = await handler({ entity: "purchase_invoices", view: "full" });
    const text = result.content[0]!.text;
    const idx = text.indexOf(INJECT);
    expect(idx).toBeGreaterThan(-1);
    expect(text.slice(0, idx)).toContain("UNTRUSTED_OCR_START");
  });

  it("rejects a filter outside the entity allowlist", async () => {
    const handler = setupSearch(makeApi());
    const result = await handler({ entity: "journals", payment_status: "PAID" });
    expect(result.isError).toBe(true);
    expect(parse(result).category).toBe("filter_not_allowed");
  });
});

describe("inspect_accounting_record façade", () => {
  it("fetches one record and surfaces no delegated tool name", async () => {
    const get = vi.fn().mockResolvedValue({ id: 3, name: "ACME" });
    const api = makeApi({ clients: { list: vi.fn(), get } });
    const handler = setupInspect(api);
    const result = await handler({ entity: "clients", id: 3 });
    expect(result.isError).toBeFalsy();
    expect(parse(result).record.id).toBe(3);
    expect(result.content[0]!.text).not.toContain("get_client");
    expect(get).toHaveBeenCalledWith(3);
  });
});
