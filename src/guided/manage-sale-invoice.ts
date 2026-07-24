import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { batch } from "../annotations.js";
import { renderExternalEntity } from "../external-text-renderer.js";
import { applyListView } from "../list-views.js";
import { coerceId, jsonObjectInput, parseJsonObject } from "../tools/crud-tools.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { createSaleInvoiceOperations } from "../sales/invoice-operations.js";
import type {
  SaleInvoiceMutationAction,
  SaleInvoiceReadAction,
  SaleInvoiceReadResult,
} from "../sales/invoice-types.js";

// GUIDED-SALES FAÇADE. `manage_sale_invoice` absorbs all 11 granular
// sale-invoice tools behind read/prepare/execute modes over the typed
// SaleInvoiceOperations. mode='read' (list/get/document/xml/delivery_options)
// replaces list_/get_sale_invoice in the guided-sales surface. EVERY mutation,
// destructive action AND send is a two-call prepare -> execute over a plan
// handle — a real e-invoice send is never one-shot. This name does NOT match the
// directDestructiveCrud regex, so destructive-via-mode+plan-handle is allowed in
// guided-sales. Calls NO MCP handler, surfaces no delegated tool name. Read
// echoes go through renderExternalEntity (trusted CRUD, not OCR-wrapping).

const READ_ACTIONS = new Set<SaleInvoiceReadAction>(["list", "get", "document", "xml", "delivery_options"]);
const MUTATION_ACTIONS = new Set<SaleInvoiceMutationAction>(["create", "update", "delete", "confirm", "invalidate", "send", "recurring"]);

function textResult(payload: Record<string, unknown>, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: toMcpJson(payload) }] };
}

function renderRead(value: SaleInvoiceReadResult): Record<string, unknown> {
  if (value.action === "list") {
    const page = value.data as { current_page?: number; total_pages?: number; items?: unknown[] };
    const items = renderExternalEntity("sale_invoice", applyListView("sale_invoice", page.items ?? [], undefined));
    return { mode: "read", action: "list", page: page.current_page, total_pages: page.total_pages, items };
  }
  if (value.action === "get") {
    return { mode: "read", action: "get", record: renderExternalEntity("sale_invoice", value.data) };
  }
  return { mode: "read", action: value.action, data: value.data };
}

interface ManageArgs {
  mode?: "read" | "prepare" | "execute";
  action?: string;
  id?: number;
  plan_handle?: string;
  payload?: unknown;
  view?: "brief" | "full";
  page?: number;
  date_from?: string;
  date_to?: string;
  status?: string;
  payment_status?: string;
  clients_id?: number;
}

export function registerManageSaleInvoiceTool(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const operations = createSaleInvoiceOperations(api, runtimeSafetyContext);

  registerTool(server,
    "manage_sale_invoice",
    "Unified sale-invoice entry point. mode='read' (action list/get/document/xml/delivery_options) reads invoices. Mutations use the two-call gate: mode='prepare' (action create/update/delete/confirm/invalidate/send/recurring) returns a plan_handle; after explicit approval mode='execute' with that plan_handle runs it. send dispatches a REAL e-invoice and is never one-shot. recurring clones previous-month confirmed invoices into DRAFT recurring invoices (params in payload).",
    {
      mode: z.enum(["read", "prepare", "execute"]).optional().describe("read (default), prepare (mint plan handle), or execute (consume it)."),
      action: z.string().optional().describe("read: list|get|document|xml|delivery_options. prepare/execute: create|update|delete|confirm|invalidate|send|recurring."),
      id: coerceId.optional().describe("Invoice ID (required for everything except list/create/recurring)."),
      plan_handle: z.string().optional().describe("Execution-plan handle from mode='prepare'. Required for mode='execute'."),
      payload: jsonObjectInput.optional().describe("create/update fields, send request ({send_einvoice, send_email, email_addresses, ...}), or recurring params ({source_month:YYYY-MM, target_date:YYYY-MM-DD, target_journal_date:YYYY-MM-DD, invoice_ids?, auto_confirm?}). For create, pass EITHER clients_id OR an inline client to resolve-or-create a customer ({name, reg_code?, vat_no?, iban?, country?}); on any identity conflict the create is refused and neither the client nor the invoice is created."),
      view: z.enum(["brief", "full"]).optional().describe("read=list: brief (default) or full."),
      page: z.number().int().positive().optional().describe("read=list: page number."),
      date_from: z.string().optional().describe("read=list: revenue date on/after (YYYY-MM-DD)."),
      date_to: z.string().optional().describe("read=list: revenue date on/before (YYYY-MM-DD)."),
      status: z.string().optional().describe("read=list: PROJECT|CONFIRMED."),
      payment_status: z.string().optional().describe("read=list: PAID|PARTIALLY_PAID|NOT_PAID."),
      clients_id: z.number().int().positive().optional().describe("read=list: filter by customer."),
    },
    { ...batch, title: "Manage Sale Invoice" },
    async (args: ManageArgs) => {
      const mode = args.mode ?? "read";

      if (mode === "read") {
        const action = (args.action as SaleInvoiceReadAction | undefined) ?? (args.id !== undefined ? "get" : "list");
        if (!READ_ACTIONS.has(action)) return textResult({ error: `Unknown read action "${action}"`, category: "invalid_read_action" }, true);
        const outcome = await operations.run({
          mode: "read",
          action,
          ...(args.id !== undefined ? { id: args.id } : {}),
          ...(args.view !== undefined ? { view: args.view } : {}),
          filters: {
            ...(args.page !== undefined ? { page: args.page } : {}),
            ...(args.date_from !== undefined ? { date_from: args.date_from } : {}),
            ...(args.date_to !== undefined ? { date_to: args.date_to } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.payment_status !== undefined ? { payment_status: args.payment_status } : {}),
            ...(args.clients_id !== undefined ? { clients_id: args.clients_id } : {}),
          },
        });
        if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code }, true);
        if (outcome.value.mode !== "read") return textResult({ error: "unexpected", category: "internal" }, true);
        return textResult(renderRead(outcome.value));
      }

      const action = args.action as SaleInvoiceMutationAction | undefined;
      if (action === undefined || !MUTATION_ACTIONS.has(action)) {
        return textResult({ error: "action is required for prepare/execute (create|update|delete|confirm|invalidate|send)", category: "missing_action" }, true);
      }
      const payload = args.payload !== undefined ? parseJsonObject(args.payload, "payload") : undefined;

      if (mode === "prepare") {
        const outcome = await operations.run({ mode: "prepare", action, ...(args.id !== undefined ? { id: args.id } : {}), ...(payload !== undefined ? { payload } : {}) });
        if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code }, true);
        if (outcome.value.mode !== "prepare") return textResult({ error: "unexpected", category: "internal" }, true);
        return textResult({
          status: "ready_for_approval",
          mode: "prepare",
          action,
          plan_handle: outcome.value.planHandle,
          projection: outcome.value.projection,
          next_step: `After explicit approval, call manage_sale_invoice mode='execute' action='${action}' with this plan_handle.`,
          mutation_occurred: false,
        });
      }

      // mode === "execute"
      const outcome = await operations.run({
        mode: "execute",
        action,
        ...(args.id !== undefined ? { id: args.id } : {}),
        planHandle: args.plan_handle,
        ...(payload !== undefined ? { payload } : {}),
      });
      if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code, mutation_occurred: false }, true);
      if (outcome.value.mode !== "execute") return textResult({ error: "unexpected", category: "internal" }, true);
      return textResult({ mode: "execute", action, ...(outcome.value.id !== undefined ? { id: outcome.value.id } : {}), result: outcome.value.result, mutation_occurred: true });
    },
  );
}
