import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { readOnly } from "../annotations.js";
import { renderExternalEntity, type ExternalEntity } from "../external-text-renderer.js";
import { coerceId } from "../tools/crud-tools.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { ToolExposureConfig } from "../config.js";
import { createRecordOperations } from "../records/operations.js";
import { RECORD_ENTITIES, type RecordEntity } from "../records/types.js";

// GUIDED FAÇADE. `inspect_accounting_record` fetches ONE persisted record by
// {entity, id} over the typed RecordOperations (fixed api.<entity>.get). Trusted
// CRUD read — import-origin free-text is rendered with renderExternalEntity, not
// wrapUntrustedOcr. Calls NO MCP handler, surfaces no delegated tool name.

const ENTITY_SINGULAR: Record<RecordEntity, ExternalEntity> = {
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

interface InspectArgs { entity?: string; id?: number }

export function registerInspectAccountingRecordTool(
  server: McpServer,
  api: ApiContext,
  toolExposure: Pick<ToolExposureConfig, "enableSales" | "enableProducts">,
): void {
  const operations = createRecordOperations(api, {
    enableSales: toolExposure.enableSales !== false,
    enableProducts: toolExposure.enableProducts !== false,
  });

  registerTool(server,
    "inspect_accounting_record",
    "Fetch one persisted accounting record by entity + id. entity ∈ journals|transactions|clients|purchase_invoices|sale_invoices|products. Use search_accounting_records to find the id first.",
    {
      entity: z.enum(RECORD_ENTITIES).describe("Which record set to read from."),
      id: coerceId.describe("Record ID."),
    },
    { ...readOnly, title: "Inspect Accounting Record" },
    async (args: InspectArgs) => {
      const outcome = await operations.inspect({ entity: args.entity as RecordEntity, id: args.id as number });
      if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code }, true);
      const singular = ENTITY_SINGULAR[outcome.value.entity];
      return textResult({
        entity: outcome.value.entity,
        record: renderExternalEntity(singular, outcome.value.record),
      });
    },
  );
}
