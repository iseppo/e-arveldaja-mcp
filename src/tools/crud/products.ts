import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { desandboxAllStrings, renderExternalEntity } from "../../external-text-renderer.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { toolResponse } from "../../tool-response.js";
import { lifecycleHandler } from "./lifecycle-handler.js";
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

// Writable Products properties from the API schema. Account IDs are computed
// from articles and are deliberately absent from the PATCH allowlist.
const productFields = {
  name: z.string().max(1000),
  code: z.string().max(20),
  cl_sale_articles_id: coerceId.nullable().optional(),
  sale_accounts_dimensions_id: coerceId.nullable().optional(),
  cl_purchase_articles_id: coerceId.nullable().optional(),
  purchase_accounts_dimensions_id: coerceId.nullable().optional(),
  foreign_names: z.record(z.string(), z.string()).optional(),
  translations: z.record(z.string(), z.string()).optional(),
  description: z.string().max(10000).nullable().optional(),
  sales_price: z.number().max(1e12).nullable().optional(),
  net_price: z.number().max(1e12).nullable().optional(),
  price_currency: z.string().length(3).optional(),
  notes: z.string().max(10000).nullable().optional(),
  activity_text: z.string().max(10000).nullable().optional(),
  emtak_code: z.string().max(10000).nullable().optional(),
  emtak_version: z.string().max(10000).nullable().optional(),
  unit: z.string().max(10).nullable().optional(),
  amount: z.number().max(1e7).nullable().optional(),
};
const productUpdateSchema = z.object(productFields).partial().strict();
const productSelectors = ["cl_sale_articles_id", "sale_accounts_dimensions_id", "cl_purchase_articles_id", "purchase_accounts_dimensions_id"] as const;

function articleRequired() {
  return toolError({
    category: "product_article_required",
    error: "Products require a sales or purchase article; account IDs are read-only API fields.",
    next_action: "Use list_sale_articles or list_purchase_articles and provide cl_sale_articles_id or cl_purchase_articles_id (plus the matching dimension where applicable). Do not use sale_accounts_id or purchase_accounts_id.",
  });
}

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

  registerTool(server, "create_product", "Create a product/service with a sales or purchase article. Account IDs are read-only; use article IDs from list_sale_articles/list_purchase_articles.", {
    name: z.string().max(1000).describe("Product name (max 1000 characters)"),
    code: z.string().max(20).describe("Product code (max 20 characters)"),
    cl_sale_articles_id: coerceId.optional().describe("Sales article ID"),
    sale_accounts_id: coerceId.optional().describe("Unsupported read-only field; provide cl_sale_articles_id instead"),
    cl_sale_accounts_dimensions_id: coerceId.optional().describe("Legacy alias for sale_accounts_dimensions_id; supply only one value"),
    sale_accounts_dimensions_id: coerceId.optional().describe("Sales account dimension ID"),
    cl_purchase_articles_id: coerceId.optional().describe("Purchase article ID"),
    purchase_accounts_id: coerceId.optional().describe("Unsupported read-only field; provide cl_purchase_articles_id instead"),
    purchase_accounts_dimensions_id: coerceId.optional().describe("Purchase account dimension ID"),
    sales_price: z.coerce.number().optional().describe("Sales price"),
    unit: z.string().max(10).optional().describe("Unit (e.g. tk, h, km; max 10 characters)"),
  }, { ...create, title: "Create Product" }, async (rawParams) => {
    const params = desandboxAllStrings(rawParams);
    if (params.sale_accounts_id !== undefined || params.purchase_accounts_id !== undefined ||
        (params.cl_sale_articles_id == null && params.cl_purchase_articles_id == null)) return articleRequired();
    const { sale_accounts_id: _sale, purchase_accounts_id: _purchase, cl_sale_accounts_dimensions_id: alias, ...writable } = params;
    if (alias !== undefined) {
      if (writable.sale_accounts_dimensions_id !== undefined && writable.sale_accounts_dimensions_id !== alias) {
        return toolError({ error: "Conflicting sales dimension aliases", next_action: "Provide only sale_accounts_dimensions_id." });
      }
      writable.sale_accounts_dimensions_id = alias;
    }
    const result = await api.products.create(writable);
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
    const validated = productUpdateSchema.safeParse(parsed);
    if (!validated.success) return toolError({ error: "Invalid product update fields", details: validated.error.issues });
    // The API requires article selectors even on a metadata-only PATCH. Fetch
    // them fresh and copy only writable selectors, never the GET response body.
    api.products.invalidateListCache();
    const current = await api.products.get(id);
    for (const side of ["sale", "purchase"] as const) {
      const article = `cl_${side}_articles_id` as const;
      const dimension = `${side}_accounts_dimensions_id` as const;
      if (validated.data[article] !== undefined && validated.data[article] !== current[article] &&
          current[dimension] != null && validated.data[dimension] === undefined) {
        return toolError({
          category: "product_dimension_required",
          error: `Changing ${article} cannot reuse the previous article's dimension automatically.`,
          next_action: `Provide ${dimension} for the new article's account, or explicit null to clear the previous dimension.`,
        });
      }
    }
    const payload: Record<string, unknown> = {};
    for (const field of productSelectors) {
      if (current[field] !== undefined) payload[field] = current[field];
    }
    Object.assign(payload, validated.data);
    if (payload.cl_sale_articles_id == null && payload.cl_purchase_articles_id == null) return articleRequired();
    const result = await api.products.update(id, payload);
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

  registerTool(server, "deactivate_product", "Deactivate a product (can be restored with reactivate_product)", idParam.shape, { ...mutate, title: "Deactivate Product" }, lifecycleHandler("deactivate_product", "Deactivated", "product", (id) => api.products.deactivate(id)));

  registerTool(server, "reactivate_product", "Reactivate a deactivated product", idParam.shape, { ...mutate, title: "Reactivate Product" }, lifecycleHandler("reactivate_product", "Reactivated", "product", (id) => api.products.restore(id)));

  registerTool(server, "delete_product",
    "Permanently delete a product/service. Fails if the product is referenced by invoices or other accounting records — use deactivate_product to hide an in-use product instead. Intended for removing mistakenly-created master data with no history.",
    idParam.shape, { ...destructive, title: "Delete Product" }, lifecycleHandler("delete_product", "Deleted", "product", (id) => api.products.delete(id)));
}
