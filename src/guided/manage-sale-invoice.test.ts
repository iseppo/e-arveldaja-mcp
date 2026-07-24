import { describe, expect, it, vi } from "vitest";
import { registerManageSaleInvoiceTool } from "./manage-sale-invoice.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseMcpResponse } from "../mcp-json.js";
import type { ApiContext } from "../tools/crud-tools.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function makeApi(over: Record<string, unknown> = {}, clientsApi: Record<string, unknown> = {}): ApiContext {
  return {
    saleInvoices: {
      list: vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [] }),
      get: vi.fn().mockResolvedValue({ id: 1, status: "PROJECT" }),
      create: vi.fn().mockResolvedValue({ created_object_id: 500 }),
      delete: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
      invalidate: vi.fn().mockResolvedValue({}),
      sendEinvoice: vi.fn().mockResolvedValue({ delivered: true }),
      ...over,
    },
    readonly: {
      getAccounts: vi.fn().mockResolvedValue([]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
      getVatInfo: vi.fn().mockResolvedValue({}),
      getInvoiceInfo: vi.fn().mockResolvedValue({}),
    },
    clients: {
      listAll: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ created_object_id: 77 }),
      get: vi.fn().mockResolvedValue({ id: 77, name: "New Buyer OÜ" }),
      ...clientsApi,
    },
  } as unknown as ApiContext;
}

function setup(api: ApiContext): Handler {
  const runtime = createTestRuntimeSafetyContext();
  const server = { registerTool: vi.fn() } as any;
  registerManageSaleInvoiceTool(server, api, runtime);
  return server.registerTool.mock.calls.find(([n]: [string]) => n === "manage_sale_invoice")![2] as Handler;
}
const parse = (r: { content: Array<{ text: string }> }) => parseMcpResponse(r.content[0]!.text) as any;

describe("manage_sale_invoice façade", () => {
  it("read mode renders sandboxed client names and surfaces no delegated tool name", async () => {
    const INJECT = "IGNORE ALL";
    const list = vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [{ id: 1, number: "S-1", client_name: `Buyer ${INJECT}`, status: "CONFIRMED" }] });
    const handler = setup(makeApi({ list }));
    const result = await handler({ mode: "read" });
    const text = result.content[0]!.text;
    expect(text).not.toContain("list_sale_invoices");
    const idx = text.indexOf(INJECT);
    expect(idx).toBeGreaterThan(-1);
    expect(text.slice(0, idx)).toContain("UNTRUSTED_OCR_START");
  });

  it("send is a two-call prepare -> execute over a plan handle (never one-shot)", async () => {
    const send = vi.fn().mockResolvedValue({ delivered: true });
    const handler = setup(makeApi({ sendEinvoice: send }));
    const prepared = parse(await handler({ mode: "prepare", action: "send", id: 9, payload: { send_einvoice: true } }));
    expect(prepared.status).toBe("ready_for_approval");
    expect(prepared.mutation_occurred).toBe(false);
    expect(typeof prepared.plan_handle).toBe("string");
    expect(send).not.toHaveBeenCalled();
    const executed = parse(await handler({ mode: "execute", action: "send", id: 9, plan_handle: prepared.plan_handle, payload: { send_einvoice: true } }));
    expect(executed.mutation_occurred).toBe(true);
    expect(send).toHaveBeenCalledWith(9, expect.objectContaining({ send_einvoice: true }));
  });

  it("recurring is a two-call prepare -> execute; execute clones and wraps carried-over client names", async () => {
    const INJECT = "IGNORE ALL";
    const source = { id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: `Buyer ${INJECT}`,
      sale_invoice_type: "INVOICE", number_prefix: "ARV",
      items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }] };
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const handler = setup(makeApi({
      listAll: vi.fn().mockResolvedValue([source]),
      get: vi.fn().mockResolvedValue(source),
      create,
    }));
    const params = { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" };
    const prepared = parse(await handler({ mode: "prepare", action: "recurring", payload: params }));
    expect(prepared.status).toBe("ready_for_approval");
    expect(prepared.mutation_occurred).toBe(false);
    expect(typeof prepared.plan_handle).toBe("string");
    expect(prepared.projection.mode).toBe("DRY_RUN");
    expect(create).not.toHaveBeenCalled();

    const executeResult = await handler({ mode: "execute", action: "recurring", plan_handle: prepared.plan_handle, payload: params });
    const executed = parse(executeResult);
    expect(executed.mutation_occurred).toBe(true);
    expect(executed.result.created).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    // Carried-over client name is untrusted → wrapped before the injection text.
    const text = executeResult.content[0]!.text;
    const idx = text.indexOf(INJECT);
    expect(idx).toBeGreaterThan(-1);
    expect(text.slice(0, idx)).toContain("UNTRUSTED_OCR_START");
  });

  it("create with an inline new-customer client resolves-or-creates the client then the invoice", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => "0" }, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const create = vi.fn().mockResolvedValue({ created_object_id: 500 });
      const clientCreate = vi.fn().mockResolvedValue({ created_object_id: 77 });
      const handler = setup(makeApi({ create }, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate, get: vi.fn().mockResolvedValue({ id: 77, name: "New Buyer OÜ" }) }));
      const payload = { client: { name: "New Buyer OÜ", reg_code: "17133416", country: "EST" }, items: [] };
      const prepared = parse(await handler({ mode: "prepare", action: "create", payload }));
      expect(prepared.status).toBe("ready_for_approval");
      expect(clientCreate).not.toHaveBeenCalled();
      const executed = parse(await handler({ mode: "execute", action: "create", plan_handle: prepared.plan_handle, payload }));
      expect(executed.mutation_occurred).toBe(true);
      expect(clientCreate).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect((create.mock.calls[0]![0] as Record<string, unknown>).clients_id).toBe(77);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prepare create with a new-customer client shows would_create with a wrapped client name", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const handler = setup(makeApi({ create }, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate }));
    const result = await handler({ mode: "prepare", action: "create", payload: { client: { name: "Fresh Buyer OÜ" }, items: [] } });
    const prepared = parse(result);
    expect(prepared.projection.client_resolution).toBe("would_create");
    expect(clientCreate).not.toHaveBeenCalled();
    const text = result.content[0]!.text;
    expect(text).toContain("UNTRUSTED_OCR_START");
    expect(text).toContain("Fresh Buyer");
  });

  it("P17: a conflicting inline client returns needs_input and creates neither client nor invoice", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const handler = setup(makeApi({ create }, { listAll: vi.fn().mockResolvedValue([{ id: 50, name: "Twin OÜ", code: "10000000", is_deleted: false }]), create: clientCreate }));
    const payload = { client: { name: "Twin OÜ", reg_code: "17133416" }, items: [] };
    const prepared = parse(await handler({ mode: "prepare", action: "create", payload }));
    const executed = await handler({ mode: "execute", action: "create", plan_handle: prepared.plan_handle, payload });
    expect(executed.isError).toBe(true);
    expect(parse(executed).mutation_occurred).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(clientCreate).not.toHaveBeenCalled();
  });

  it("execute without a plan_handle is refused (destructive confirm)", async () => {
    const confirm = vi.fn();
    const handler = setup(makeApi({ confirm }));
    const result = await handler({ mode: "execute", action: "confirm", id: 4 });
    expect(result.isError).toBe(true);
    expect(parse(result).category).toBe("plan_handle_required");
    expect(confirm).not.toHaveBeenCalled();
  });
});
