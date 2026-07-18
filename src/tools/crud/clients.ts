import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { desandboxAllStrings, desandboxText, renderExternalEntity } from "../../external-text-renderer.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
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
    "List clients. Paginated. Brief view by default; use view='full' or get_client for detail.",
    { ...pageParam.shape, ...viewParam },
    { ...readOnly, title: "List Clients" }, async (params) => {
    const result = await api.clients.list(params);
    const compact = { ...result, items: renderExternalEntity("client", applyListView("client", result.items, params.view)) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_client", "Get a single client by ID", idParam.shape, { ...readOnly, title: "Get Client" }, async ({ id }) => {
    const result = await api.clients.get(id);
    return { content: [{ type: "text", text: toMcpJson(renderExternalEntity("client", result)) }] };
  });

  registerTool(server, "create_client", "Create a new client (buyer/supplier)", {
    name: z.string().describe("Client name"),
    code: z.string().optional().describe("Business registry code or personal ID"),
    is_client: z.boolean().describe("Is a buyer"),
    is_supplier: z.boolean().describe("Is a supplier"),
    cl_code_country: z.string().optional().describe("Country code (default EST)"),
    is_physical_entity: z.boolean().describe("REQUIRED: true = natural person, false = legal entity/company (registry `code` then also required). The API rejects creation without this."),
    email: z.string().optional().describe("Contact email"),
    telephone: z.string().optional().describe("Phone"),
    address_text: z.string().optional().describe("Address"),
    bank_account_no: z.string().optional().describe("Bank account (IBAN)"),
    invoice_vat_no: z.string().optional().describe("VAT number"),
    notes: z.string().optional().describe("Notes"),
  }, { ...create, title: "Create Client" }, async (rawParams) => {
    // Strip any sandbox markers that round-tripped in from a wrapped read off
    // EVERY field (not only the scoped ones), so no marker is ever persisted to
    // the accounting record or the audit log regardless of which field it lands in.
    const params = desandboxAllStrings(rawParams);
    const result = await api.clients.create({
      ...params,
      cl_code_country: params.cl_code_country ?? "EST",
      // The API treats the person-type flags as complements and requires one to be
      // set; derive the juridical flag from the required is_physical_entity so this
      // tool can never emit the avoidable 409 ("Please choose if it is a natural or
      // a juridical person.").
      is_juridical_entity: !params.is_physical_entity,
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
    return toolResponse({
      action: "created",
      entity: "client",
      id: result.created_object_id,
      message: `Created client "${params.name}".`,
      raw: result,
    });
  });

  registerTool(server, "update_client", "Update client fields. Server-managed activation fields are rejected; use deactivate/reactivate tools.", {
    id: coerceId.describe("Client ID"),
    data: jsonObjectInput.describe("Object with fields to update."),
  }, { ...mutate, title: "Update Client" }, async ({ id, data }) => {
    const parsed = desandboxAllStrings(parseJsonObject(data, "data"));
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

  registerTool(server, "deactivate_client", "Deactivate a client (can be restored with reactivate_client)", idParam.shape, { ...mutate, title: "Deactivate Client" }, async ({ id }) => {
    const result = await api.clients.deactivate(id);
    logAudit({
      tool: "deactivate_client", action: "DELETED", entity_type: "client", entity_id: id,
      summary: `Deactivated client ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deactivated",
      entity: "client",
      id,
      message: `Deactivated client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "reactivate_client", "Reactivate a deactivated client", idParam.shape, { ...mutate, title: "Reactivate Client" }, async ({ id }) => {
    const result = await api.clients.restore(id);
    logAudit({
      tool: "reactivate_client", action: "UPDATED", entity_type: "client", entity_id: id,
      summary: `Reactivated client ${id}`,
      details: {},
    });
    return toolResponse({
      action: "reactivated",
      entity: "client",
      id,
      message: `Reactivated client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "delete_client",
    "Permanently delete a client. Fails if the client is referenced by invoices, journals, transactions, or other accounting records — use deactivate_client to hide an in-use client instead. Intended for removing mistakenly-created master data with no history.",
    idParam.shape, { ...destructive, title: "Delete Client" }, async ({ id }) => {
    const result = await api.clients.delete(id);
    logAudit({
      tool: "delete_client", action: "DELETED", entity_type: "client", entity_id: id,
      summary: `Deleted client ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "client",
      id,
      message: `Deleted client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "search_client", "Search clients by name (fuzzy match)", {
    name: z.string().describe("Name to search for"),
  }, { ...readOnly, title: "Search Clients" }, async ({ name: rawName }) => {
    // Strip markers so a name round-tripped from a wrapped read matches cleanly.
    const name = desandboxText(rawName);
    const results = await api.clients.findByName(name);
    return toolResponse({
      action: "searched",
      entity: "client",
      message: `Found ${results.length} client(s) matching "${name}".`,
      extra: { count: results.length },
      raw: renderExternalEntity("client", results),
    });
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
        raw: renderExternalEntity("client", result),
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
