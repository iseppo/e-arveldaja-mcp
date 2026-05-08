import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { readOnly, create, mutate } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { toolResponse } from "../../tool-response.js";
import { applyListView, viewParam } from "../../list-views.js";
import type { ApiContext } from "./shared.js";
import {
  coerceId,
  idParam,
  jsonObjectInput,
  pageParam,
  parseJsonObject,
  validateUpdateFields,
} from "./shared.js";

export function registerClientTools(server: McpServer, api: ApiContext): void {
  // =====================
  // CLIENTS
  // =====================

  registerTool(server, "list_clients",
    "List all clients (buyers/suppliers). Paginated. Returns brief view (id, name, code, email, vat_no, is_client/is_supplier flags) by default; pass view='full' or call get_client for full detail.",
    { ...pageParam.shape, ...viewParam },
    { ...readOnly, title: "List Clients" }, async (params) => {
    const result = await api.clients.list(params);
    const compact = { ...result, items: applyListView("client", result.items, params.view) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_client", "Get a single client by ID", idParam.shape, { ...readOnly, title: "Get Client" }, async ({ id }) => {
    const result = await api.clients.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_client", "Create a new client (buyer/supplier)", {
    name: z.string().describe("Client name"),
    code: z.string().optional().describe("Business registry code or personal ID"),
    is_client: z.boolean().describe("Is a buyer"),
    is_supplier: z.boolean().describe("Is a supplier"),
    cl_code_country: z.string().optional().describe("Country code (default EST)"),
    is_physical_entity: z.boolean().optional().describe("Natural person (true) or legal entity (false)"),
    is_juridical_entity: z.boolean().optional().describe("Legal entity"),
    email: z.string().optional().describe("Contact email"),
    telephone: z.string().optional().describe("Phone"),
    address_text: z.string().optional().describe("Address"),
    bank_account_no: z.string().optional().describe("Bank account (IBAN)"),
    invoice_vat_no: z.string().optional().describe("VAT number"),
    notes: z.string().optional().describe("Notes"),
  }, { ...create, title: "Create Client" }, async (params) => {
    const result = await api.clients.create({
      ...params,
      cl_code_country: params.cl_code_country ?? "EST",
      is_member: false,
      send_invoice_to_email: false,
      send_invoice_to_accounting_email: false,
    });
    logAudit({
      tool: "create_client", action: "CREATED", entity_type: "client",
      entity_id: result.created_object_id,
      summary: `Created client "${params.name}"`,
      details: { name: params.name, code: params.code, is_client: params.is_client, is_supplier: params.is_supplier },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "update_client", "Update an existing client. Server-managed fields (id, is_active, deactivated_date) are rejected — use the dedicated deactivate/restore tools.", {
    id: coerceId.describe("Client ID"),
    data: jsonObjectInput.describe("Object with fields to update. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Client" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const updateErrors = validateUpdateFields(parsed, "client");
    if (updateErrors.length > 0) {
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    const result = await api.clients.update(id, parsed);
    logAudit({
      tool: "update_client", action: "UPDATED", entity_type: "client", entity_id: id,
      summary: `Updated client ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return toolResponse({
      action: "updated",
      entity: "client",
      id,
      message: `Updated client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "deactivate_client", "Deactivate a client (can be restored with restore_client)", idParam.shape, { ...mutate, title: "Deactivate Client" }, async ({ id }) => {
    const result = await api.clients.deactivate(id);
    logAudit({
      tool: "deactivate_client", action: "DELETED", entity_type: "client", entity_id: id,
      summary: `Deactivated client ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "restore_client", "Reactivate a deactivated client", idParam.shape, { ...mutate, title: "Restore Client" }, async ({ id }) => {
    const result = await api.clients.restore(id);
    logAudit({
      tool: "restore_client", action: "UPDATED", entity_type: "client", entity_id: id,
      summary: `Restored client ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "search_client", "Search clients by name (fuzzy match)", {
    name: z.string().describe("Name to search for"),
  }, { ...readOnly, title: "Search Clients" }, async ({ name }) => {
    const results = await api.clients.findByName(name);
    return { content: [{ type: "text", text: toMcpJson(results) }] };
  });

  registerTool(server, "find_client_by_code", "Find a client by business registry code or personal ID", {
    code: z.string().describe("Business registry code or personal ID"),
  }, { ...readOnly, title: "Find Client by Registry Code" }, async ({ code }) => {
    const result = await api.clients.findByCode(code);
    return result
      ? toolResponse({
        action: "found",
        entity: "client",
        id: result.id,
        found: true,
        message: `Found client for registry code ${code}.`,
        raw: result,
      })
      : toolResponse({
        ok: false,
        action: "found",
        entity: "client",
        found: false,
        message: `No client found for registry code ${code}.`,
        raw: null,
      });
  });
}
