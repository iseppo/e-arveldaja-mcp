import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { desandboxAllStrings, renderExternalEntity } from "../../external-text-renderer.js";
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

export function registerProductTools(server: McpServer, api: ApiContext): void {
  // =====================
  // PRODUCTS
  // =====================

  registerTool(server, "list_products",
    "List products/services. Paginated. Brief view by default; use view='full' or get_product for detail.",
    { ...pageParam.shape, ...viewParam },
    { ...readOnly, title: "List Products" }, async (params) => {
    const result = await api.products.list(params);
    const compact = { ...result, items: renderExternalEntity("product", applyListView("product", result.items, params.view)) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_product", "Get a single product by ID", idParam.shape, { ...readOnly, title: "Get Product" }, async ({ id }) => {
    const result = await api.products.get(id);
    return { content: [{ type: "text", text: toMcpJson(renderExternalEntity("product", result)) }] };
  });

  registerTool(server, "create_product", "Create a new product/service", {
    name: z.string().describe("Product name"),
    code: z.string().describe("Product code"),
    cl_sale_articles_id: coerceId.optional().describe("Sales article ID"),
    sale_accounts_id: coerceId.optional().describe("Sales account ID"),
    cl_sale_accounts_dimensions_id: coerceId.optional().describe("Sales account dimension ID"),
    sale_accounts_dimensions_id: coerceId.optional().describe("Sales account dimension ID"),
    cl_purchase_articles_id: coerceId.optional().describe("Purchase article ID"),
    purchase_accounts_id: coerceId.optional().describe("Purchase account ID"),
    purchase_accounts_dimensions_id: coerceId.optional().describe("Purchase account dimension ID"),
    sales_price: z.coerce.number().optional().describe("Sales price"),
    unit: z.string().optional().describe("Unit (e.g. tk, h, km)"),
  }, { ...create, title: "Create Product" }, async (rawParams) => {
    const params = desandboxAllStrings(rawParams);
    const result = await api.products.create(params);
    logAudit({
      tool: "create_product", action: "CREATED", entity_type: "product",
      entity_id: result.created_object_id,
      summary: `Created product "${params.name}" (${params.code})`,
      details: { name: params.name, code: params.code, sales_price: params.sales_price },
    });
    return toolResponse({
      action: "created",
      entity: "product",
      id: result.created_object_id,
      message: `Created product "${params.name}" (${params.code}).`,
      raw: result,
    });
  });

  registerTool(server, "update_product", "Update product fields. Server-managed activation fields are rejected; use deactivate/reactivate tools.", {
    id: coerceId.describe("Product ID"),
    data: jsonObjectInput.describe("Object with fields to update."),
  }, { ...mutate, title: "Update Product" }, async ({ id, data }) => {
    const parsed = desandboxAllStrings(parseJsonObject(data, "data"));
    const updateErrors = validateUpdateFields(parsed, "product");
    if (updateErrors.length > 0) {
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    const result = await api.products.update(id, parsed);
    logAudit({
      tool: "update_product", action: "UPDATED", entity_type: "product", entity_id: id,
      summary: `Updated product ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return toolResponse({
      action: "updated",
      entity: "product",
      id,
      message: `Updated product ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "deactivate_product", "Deactivate a product (can be restored with reactivate_product)", idParam.shape, { ...mutate, title: "Deactivate Product" }, async ({ id }) => {
    const result = await api.products.deactivate(id);
    logAudit({
      tool: "deactivate_product", action: "DELETED", entity_type: "product", entity_id: id,
      summary: `Deactivated product ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deactivated",
      entity: "product",
      id,
      message: `Deactivated product ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "reactivate_product", "Reactivate a deactivated product", idParam.shape, { ...mutate, title: "Reactivate Product" }, async ({ id }) => {
    const result = await api.products.restore(id);
    logAudit({
      tool: "reactivate_product", action: "UPDATED", entity_type: "product", entity_id: id,
      summary: `Reactivated product ${id}`,
      details: {},
    });
    return toolResponse({
      action: "reactivated",
      entity: "product",
      id,
      message: `Reactivated product ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "delete_product",
    "Permanently delete a product/service. Fails if the product is referenced by invoices or other accounting records — use deactivate_product to hide an in-use product instead. Intended for removing mistakenly-created master data with no history.",
    idParam.shape, { ...destructive, title: "Delete Product" }, async ({ id }) => {
    const result = await api.products.delete(id);
    logAudit({
      tool: "delete_product", action: "DELETED", entity_type: "product", entity_id: id,
      summary: `Deleted product ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "product",
      id,
      message: `Deleted product ${id}.`,
      raw: result,
    });
  });
}
