import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { readOnly } from "../annotations.js";
import { renderExternalEntity, type ExternalEntity } from "../external-text-renderer.js";
import { applyListView, type BriefEntity, type ListView } from "../list-views.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { ToolExposureConfig } from "../config.js";
import { createRecordOperations } from "../records/operations.js";
import { RECORD_ENTITIES, type RecordEntity } from "../records/types.js";

// GUIDED FAÇADE. `search_accounting_records` is the bounded record-search entry
// point over the typed RecordOperations. NO universal API executor: an explicit
// entity enum + bounded per-entity filters. Reads are trusted CRUD, so import-
// origin free-text fields are rendered with renderExternalEntity (NOT
// wrapUntrustedOcr), exactly like the granular list_* handlers. Calls NO MCP
// handler and surfaces no delegated tool name.

// The records enum is plural (endpoint-shaped); the render/view helpers key on
// the singular entity name. accounts/account_dimensions have no import-origin
// text and are not record entities here.
const ENTITY_SINGULAR: Record<RecordEntity, BriefEntity & ExternalEntity> = {
  journals: "journal",
  transactions: "transaction",
  clients: "client",
  purchase_invoices: "purchase_invoice",
  sale_invoices: "sale_invoice",
  products: "product",
};

function textResult(payload: Record<string, unknown>, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: toMcpJson(payload) }] };
}

interface SearchArgs {
  entity?: string;
  page?: number;
  date_from?: string;
  date_to?: string;
  status?: string;
  payment_status?: string;
  clients_id?: number;
  view?: ListView;
}

export function registerSearchAccountingRecordsTool(
  server: McpServer,
  api: ApiContext,
  toolExposure: Pick<ToolExposureConfig, "enableSales" | "enableProducts">,
): void {
  const operations = createRecordOperations(api, {
    enableSales: toolExposure.enableSales !== false,
    enableProducts: toolExposure.enableProducts !== false,
  });

  registerTool(server,
    "search_accounting_records",
    "Search persisted accounting records by a bounded entity + filters. entity ∈ journals|transactions|clients|purchase_invoices|sale_invoices|products. Filters are per-entity (page, date_from/date_to, status, payment_status, clients_id). Brief view by default; view='full' returns every field. Use inspect_accounting_record for one record's detail.",
    {
      entity: z.enum(RECORD_ENTITIES).describe("Which record set to search."),
      page: z.number().int().positive().optional().describe("Page number (default 1)."),
      date_from: z.string().optional().describe("Only records on or after this date (YYYY-MM-DD), where the entity supports it."),
      date_to: z.string().optional().describe("Only records on or before this date (YYYY-MM-DD), where the entity supports it."),
      status: z.string().optional().describe("Filter by status (invoices/transactions)."),
      payment_status: z.string().optional().describe("Filter by payment status (invoices)."),
      clients_id: z.number().int().positive().optional().describe("Filter by counterparty (invoices/transactions)."),
      view: z.enum(["brief", "full"]).optional().describe("brief (default) triage fields; full every field."),
    },
    { ...readOnly, title: "Search Accounting Records" },
    async (args: SearchArgs) => {
      const outcome = await operations.search({
        entity: args.entity as RecordEntity,
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
      const singular = ENTITY_SINGULAR[outcome.value.entity];
      const viewed = applyListView(singular, outcome.value.items as unknown[], args.view);
      const items = renderExternalEntity(singular, viewed);
      return textResult({
        entity: outcome.value.entity,
        page: outcome.value.page,
        total_pages: outcome.value.total_pages,
        items,
      });
    },
  );
}
