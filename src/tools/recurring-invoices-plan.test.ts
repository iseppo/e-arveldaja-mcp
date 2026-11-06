import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice } from "../types/api.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import { registerRecurringInvoiceTools, type RecurringInvoicePayload } from "./recurring-invoices.js";

const params = { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01", auto_confirm: true };

function setup() {
  const first = {
    id: 1, number: "SI-1", status: "CONFIRMED", sale_invoice_type: "INVOICE", create_date: "2026-01-15",
    clients_id: 20, cl_currencies_id: "EUR", receivable_accounts_id: 1200, gross_price: 124,
    items: [{ amount: 1, unit_net_price: 100, total_net_price: 100, vat_rate: 24, sale_accounts_id: 3000 }],
  } as SaleInvoice;
  const listAll = vi.fn().mockResolvedValue([first]);
  const get = vi.fn().mockResolvedValue(first);
  const create = vi.fn().mockResolvedValue({ created_object_id: 321 });
  const confirm = vi.fn().mockResolvedValue({});
  const api = { saleInvoices: { listAll, get, create, confirm, invalidateListCache: vi.fn() } } as unknown as ApiContext;
  const registerTool = vi.fn();
  const runtime = createTestRuntimeSafetyContext();
  registerRecurringInvoiceTools({ registerTool } as unknown as McpServer, api, runtime);
  const handler = registerTool.mock.calls[0]![2] as (args: Record<string, unknown>) => Promise<CallToolResult>;
  const call = async (args: Record<string, unknown>) => {
    const result = await handler(args);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("Expected text payload");
    return parseToolPayload<RecurringInvoicePayload>(content.text);
  };
  return { first, listAll, get, create, confirm, call, runtime };
}

describe("standalone recurring approval binding", () => {
  it("rejects newly confirmed sources absent from the reviewed batch before any write", async () => {
    const env = setup();
    const preview = await env.call(params);
    const second = { ...env.first, id: 2, number: "SI-2" };
    env.listAll.mockResolvedValue([env.first, second]);
    env.get.mockImplementation(async (id: number) => id === 2 ? second : env.first);

    const result = await env.call({ ...params, dry_run: false, plan_handle: preview.plan_handle });

    expect(result.error_code).toBe("plan_drift");
    expect(result.note).toBe("Nothing was written.");
    expect(env.create).not.toHaveBeenCalled();
    expect(env.confirm).not.toHaveBeenCalled();
  });

  it("requires a preview handle before any API read or write", async () => {
    const env = setup();
    const result = await env.call({ ...params, dry_run: false });
    expect(result.error_code).toBe("plan_handle_required");
    expect(env.listAll).not.toHaveBeenCalled();
    expect(env.create).not.toHaveBeenCalled();
  });

  it.each([
    { target_date: "2026-02-02" },
    { auto_confirm: false },
    { invoice_ids: "1" },
  ])("rejects material input changes %j", async change => {
    const env = setup();
    const preview = await env.call(params);
    const result = await env.call({ ...params, ...change, dry_run: false, plan_handle: preview.plan_handle });
    expect(result.error_code).toBe("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
    expect(env.confirm).not.toHaveBeenCalled();
  });

  it("rejects changed clone payloads even when the gross and source IDs stay the same", async () => {
    const env = setup();
    const preview = await env.call(params);
    env.get.mockResolvedValue({ ...env.first, clients_id: 99 });
    const result = await env.call({ ...params, dry_run: false, plan_handle: preview.plan_handle });
    expect(result.error_code).toBe("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("executes an unchanged reviewed batch once and refuses replay", async () => {
    const env = setup();
    const preview = await env.call(params);
    expect(preview.plan_handle).toEqual(expect.any(String));
    const executeArgs = { ...params, dry_run: false, plan_handle: preview.plan_handle };
    const result = await env.call(executeArgs);
    expect(result.created).toBe(1);
    expect(result.confirmed).toBe(1);
    const replay = await env.call(executeArgs);
    expect(replay.error_code).toBe("plan_handle_consumed");
    expect(env.create).toHaveBeenCalledTimes(1);
    expect(env.confirm).toHaveBeenCalledTimes(1);
  });

  it("rejects another connection's handle", async () => {
    const env = setup();
    const preview = await env.call(params);
    env.runtime.setScope({ connectionIndex: 1, connectionGeneration: 1 });
    const result = await env.call({ ...params, dry_run: false, plan_handle: preview.plan_handle });
    expect(result.error_code).toBe("plan_scope_mismatch");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("refuses a transient source-read failure during drift validation without writing", async () => {
    const env = setup();
    const preview = await env.call(params);
    env.get.mockRejectedValue(new Error("upstream 503"));
    const result = await env.call({ ...params, dry_run: false, plan_handle: preview.plan_handle });
    expect(result.error_code).toBe("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
  });
});
