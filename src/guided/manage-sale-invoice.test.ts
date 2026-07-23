import { describe, expect, it, vi } from "vitest";
import { registerManageSaleInvoiceTool } from "./manage-sale-invoice.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseMcpResponse } from "../mcp-json.js";
import type { ApiContext } from "../tools/crud-tools.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function makeApi(over: Record<string, unknown> = {}): ApiContext {
  return {
    saleInvoices: {
      list: vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [] }),
      get: vi.fn().mockResolvedValue({ id: 1, status: "PROJECT" }),
      delete: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
      invalidate: vi.fn().mockResolvedValue({}),
      sendEinvoice: vi.fn().mockResolvedValue({ delivered: true }),
      ...over,
    },
    readonly: { getAccounts: vi.fn().mockResolvedValue([]), getAccountDimensions: vi.fn().mockResolvedValue([]) },
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
    const prepared = parse(await handler({ mode: "prepare", action: "send", id: 9 }));
    expect(prepared.status).toBe("ready_for_approval");
    expect(prepared.mutation_occurred).toBe(false);
    expect(typeof prepared.plan_handle).toBe("string");
    expect(send).not.toHaveBeenCalled();
    const executed = parse(await handler({ mode: "execute", action: "send", id: 9, plan_handle: prepared.plan_handle, payload: { send_einvoice: true } }));
    expect(executed.mutation_occurred).toBe(true);
    expect(send).toHaveBeenCalledWith(9, expect.objectContaining({ send_einvoice: true }));
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
