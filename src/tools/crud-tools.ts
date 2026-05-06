import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { isRecord } from "../record-utils.js";
import type { ClientsApi } from "../api/clients.api.js";
import type { ProductsApi } from "../api/products.api.js";
import type { JournalsApi } from "../api/journals.api.js";
import type { TransactionsApi } from "../api/transactions.api.js";
import type { SaleInvoicesApi } from "../api/sale-invoices.api.js";
import type { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import type { ReferenceDataApi } from "../api/readonly.api.js";
import type { Posting, Transaction, TransactionDistribution, SaleInvoiceItem, PurchaseInvoiceItem, CreatePurchaseInvoiceData } from "../types/api.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "./purchase-vat-defaults.js";
import {
  validateItemDimensions,
  validatePostingDimensions,
  validateSaleInvoiceItemDimensions,
  validateTransactionDistributionDimensions,
} from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { readOnly, create, mutate, destructive, send } from "../annotations.js";
import { HttpError } from "../http-client.js";
import { logAudit } from "../audit-log.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { toolResponse } from "../tool-response.js";
import { applyListView, viewParam } from "../list-views.js";
import { withOpeningBalanceApiLimitation } from "../opening-balance-limitations.js";
import { registerReferenceDataTools } from "./reference-data-tools.js";

export interface ApiContext {
  clients: ClientsApi;
  products: ProductsApi;
  journals: JournalsApi;
  transactions: TransactionsApi;
  saleInvoices: SaleInvoicesApi;
  purchaseInvoices: PurchaseInvoicesApi;
  readonly: ReferenceDataApi;
}

/** Check if company is VAT-registered via /vat_info */
export async function isCompanyVatRegistered(api: ApiContext): Promise<boolean> {
  const vatInfo = await api.readonly.getVatInfo();
  return !!vatInfo.vat_number;
}

export const MAX_JSON_INPUT_SIZE = 1024 * 1024; // 1 MB

export function safeJsonParse(input: string, label: string): unknown {
  if (Buffer.byteLength(input, "utf-8") > MAX_JSON_INPUT_SIZE) {
    throw new Error(`JSON input for "${label}" exceeds maximum size of ${MAX_JSON_INPUT_SIZE} bytes`);
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
}

export function parseJsonObject(input: unknown, label: string): Record<string, unknown> {
  const parsed = typeof input === "string" ? safeJsonParse(input, label) : input;
  if (!isRecord(parsed)) {
    throw new Error(`"${label}" must be a JSON object`);
  }
  return parsed;
}

export function parseJsonObjectArray(input: unknown, label: string): Record<string, unknown>[] {
  const parsed = typeof input === "string" ? safeJsonParse(input, label) : input;
  if (!Array.isArray(parsed)) {
    throw new Error(`"${label}" must be a JSON array`);
  }

  parsed.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`"${label}" item ${index + 1} must be a JSON object`);
    }
  });

  return parsed;
}

export function requireFields(items: Record<string, unknown>[], label: string, fields: string[]): void {
  items.forEach((item, index) => {
    for (const field of fields) {
      if (!(field in item) || item[field] === null || item[field] === undefined || item[field] === "") {
        throw new Error(`"${label}" item ${index + 1} is missing required field "${field}"`);
      }
    }
  });
}

/**
 * Coerce string-typed numbers to actual numbers (LLMs often quote numbers in JSON).
 * Rejects empty/whitespace strings: `Number("") === 0` would silently turn a
 * pasted empty CSV cell into a 0-EUR line, which is a bug factory. Callers who
 * want "absent" must omit the field or pass null.
 */
export function coerceNumericFields(items: Record<string, unknown>[], fields: string[]): void {
  items.forEach((item, index) => {
    for (const field of fields) {
      if (field in item && typeof item[field] === "string") {
        const raw = item[field] as string;
        if (raw.trim() === "") {
          throw new Error(
            `Numeric field "${field}" at item ${index + 1} cannot be an empty string. Omit the field or pass null to leave it unset.`
          );
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
          item[field] = parsed;
        }
      }
    }
  });
}

export function requireNumericFields(items: Record<string, unknown>[], label: string, fields: string[]): void {
  coerceNumericFields(items, fields);
  items.forEach((item, index) => {
    for (const field of fields) {
      if (field in item && item[field] !== null && item[field] !== undefined) {
        if (typeof item[field] !== "number" || !Number.isFinite(item[field] as number)) {
          throw new Error(`"${label}" item ${index + 1} field "${field}" must be a finite number, got ${typeof item[field]}`);
        }
      }
    }
  });
}

function parsePostings(input: unknown): Posting[] {
  const postings = parseJsonObjectArray(input, "postings");
  requireFields(postings, "postings", ["accounts_id", "type", "amount"]);
  requireNumericFields(postings, "postings", [
    "accounts_id", "amount", "accounts_dimensions_id",
    "projects_project_id", "projects_location_id", "projects_person_id",
    "base_amount",
  ]);

  postings.forEach((posting, index) => {
    if (posting.type !== "D" && posting.type !== "C") {
      throw new Error(`"postings" item ${index + 1} has invalid type "${String(posting.type)}" (expected "D" or "C")`);
    }
  });

  return postings as unknown as Posting[];
}

function parseTransactionDistributions(input: unknown): TransactionDistribution[] {
  const distributions = parseJsonObjectArray(input, "distributions");
  requireFields(distributions, "distributions", ["related_table", "amount"]);
  requireNumericFields(distributions, "distributions", ["amount", "related_id", "related_sub_id"]);

  const allowedRelatedTables = new Set(["accounts", "purchase_invoices", "sale_invoices"]);
  distributions.forEach((distribution, index) => {
    const relatedTable = distribution.related_table;
    if (typeof relatedTable !== "string" || !allowedRelatedTables.has(relatedTable)) {
      throw new Error(
        `"distributions" item ${index + 1} field "related_table" must be one of: accounts, purchase_invoices, sale_invoices`
      );
    }

    if (
      (relatedTable === "accounts" || relatedTable === "purchase_invoices" || relatedTable === "sale_invoices") &&
      (!Number.isInteger(distribution.related_id) || (distribution.related_id as number) <= 0)
    ) {
      throw new Error(
        `"distributions" item ${index + 1} field "related_id" must be a positive number when related_table="${relatedTable}"`
      );
    }
  });

  return distributions as unknown as TransactionDistribution[];
}

export function parseSaleInvoiceItems(input: unknown): SaleInvoiceItem[] {
  const items = parseJsonObjectArray(input, "items");
  requireFields(items, "items", ["products_id", "custom_title", "amount"]);
  requireNumericFields(items, "items", [
    "products_id", "amount", "unit_net_price", "discount_percent",
    "vat_accounts_id",
    "sale_accounts_id", "sale_accounts_dimensions_id",
    "cl_sale_articles_id",
    "projects_project_id", "projects_location_id", "projects_person_id",
  ]);
  return items as unknown as SaleInvoiceItem[];
}

export function parsePurchaseInvoiceItems(input: unknown): PurchaseInvoiceItem[] {
  const items = parseJsonObjectArray(input, "items");
  requireFields(items, "items", ["cl_purchase_articles_id", "custom_title"]);
  requireNumericFields(items, "items", [
    "cl_purchase_articles_id", "total_net_price", "unit_net_price", "amount",
    "vat_accounts_id", "vat_accounts_dimensions_id",
    "purchase_accounts_id", "purchase_accounts_dimensions_id",
    "cl_vat_articles_id", "project_no_vat_gross_price", "cl_fringe_benefits_id",
  ]);
  return items as unknown as PurchaseInvoiceItem[];
}

const pageParam = z.object({
  page: z.number().optional().describe("Page number (default 1)"),
  modified_since: z.string().optional().describe("Return only objects modified since this timestamp (ISO 8601)"),
});

export const coerceId = z.coerce.number().int().positive();
const idParam = z.object({ id: coerceId.describe("Object ID") });
export const jsonObjectInput = z.union([
  z.record(z.unknown()),
  z.string(),
]);
export const jsonObjectArrayInput = z.union([
  z.array(z.record(z.unknown())),
  z.string(),
]);
export const jsonObjectOrArrayInput = z.union([
  z.record(z.unknown()),
  z.array(z.record(z.unknown())),
  z.string(),
]);

const MCP_TAG = "e-arveldaja-mcp";

/** Append "(e-arveldaja-mcp)" to notes when EARVELDAJA_TAG_NOTES=true. */
export function tagNotes(notes?: string): string | undefined {
  if (process.env.EARVELDAJA_TAG_NOTES !== "true") return notes;
  return notes ? `${notes} (${MCP_TAG})` : `(${MCP_TAG})`;
}
const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const isoDateString = (description: string) =>
  z.string().regex(isoDateRegex, "Expected YYYY-MM-DD").describe(description);

const TRANSACTION_METADATA_FIELDS = new Set([
  "bank_ref_number",
  "bank_account_name",
  "bank_account_no",
  "description",
  "ref_number",
]);

function validateTransactionUpdateData(data: Record<string, unknown>): string[] {
  const fields = Object.keys(data);
  const allowedFields = Array.from(TRANSACTION_METADATA_FIELDS).join(", ");
  const errors: string[] = [];

  if (fields.length === 0) {
    return [`Provide at least one transaction metadata field to update. Allowed fields: ${allowedFields}.`];
  }

  for (const field of fields) {
    if (!TRANSACTION_METADATA_FIELDS.has(field)) {
      errors.push(
        `Field "${field}" is not supported by update_transaction. Allowed fields: ${allowedFields}.`
      );
      continue;
    }

    const value = data[field];
    if (value !== null && typeof value !== "string") {
      errors.push(`Field "${field}" must be a string or null.`);
    }
  }

  return errors;
}

/**
 * Per-entity denylist of fields that must never be set via the generic
 * `update_*` tools because they are either server-managed, state-flipping,
 * or have dedicated action tools (confirm/invalidate/deactivate/restore).
 *
 * Mirrors the pattern `update_transaction` uses with `TRANSACTION_METADATA_FIELDS`,
 * but denylist-style so we don't have to track every legitimately-updatable
 * field as the API surface grows.
 */
const UPDATE_BLOCKED_FIELDS: Record<string, { fields: string[]; alt: string; post_confirm_fields?: string[] }> = {
  client:           { fields: ["id", "is_active", "deactivated_date"],
                       alt: "use deactivate_client / restore_client to change activation state" },
  product:          { fields: ["id", "is_active", "deactivated_date"],
                       alt: "use deactivate_product / restore_product to change activation state" },
  journal:          { fields: ["id", "registered", "register_date", "status"],
                       alt: "use confirm_journal / invalidate_journal to change registration state",
                       post_confirm_fields: ["effective_date"] },
  sale_invoice:     { fields: ["id", "status", "registered", "register_date"],
                       alt: "use confirm_sale_invoice / invalidate_sale_invoice to change registration state",
                       post_confirm_fields: ["create_date", "journal_date"] },
  purchase_invoice: { fields: ["id", "status", "registered", "register_date", "payment_status"],
                       alt: "use confirm_purchase_invoice / invalidate_purchase_invoice to change registration state",
                       post_confirm_fields: ["create_date", "journal_date"] },
};

function validateUpdateFields(
  data: Record<string, unknown>,
  entity: keyof typeof UPDATE_BLOCKED_FIELDS,
  opts?: { isConfirmed?: boolean },
): string[] {
  const errors: string[] = [];
  if (Object.keys(data).length === 0) {
    errors.push(`update_${entity}: provide at least one field to update.`);
    return errors;
  }
  const entry = UPDATE_BLOCKED_FIELDS[entity]!;
  for (const field of entry.fields) {
    if (field in data) {
      errors.push(`Field "${field}" cannot be set via update_${entity} — ${entry.alt}.`);
    }
  }
  // Post-confirmation audit-trail protection: once a journal is registered or
  // an invoice is CONFIRMED, certain fields (dates) are audit-locked. Edits
  // must go through invalidate → edit → re-confirm so the audit trail
  // records the reversal explicitly.
  if (opts?.isConfirmed && entry.post_confirm_fields) {
    for (const field of entry.post_confirm_fields) {
      if (field in data) {
        errors.push(
          `Field "${field}" cannot be edited on a CONFIRMED ${entity} — ` +
          `invalidate_${entity} first, then edit, then re-confirm. Preserves the audit trail.`
        );
      }
    }
  }
  return errors;
}

export function registerCrudTools(server: McpServer, api: ApiContext): void {
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

  // =====================
  // PRODUCTS
  // =====================

  registerTool(server, "list_products",
    "List all products/services. Paginated. Returns brief view (id, name, code, sales_price, unit) by default; pass view='full' or call get_product for full detail.",
    { ...pageParam.shape, ...viewParam },
    { ...readOnly, title: "List Products" }, async (params) => {
    const result = await api.products.list(params);
    const compact = { ...result, items: applyListView("product", result.items, params.view) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_product", "Get a single product by ID", idParam.shape, { ...readOnly, title: "Get Product" }, async ({ id }) => {
    const result = await api.products.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_product", "Create a new product/service", {
    name: z.string().describe("Product name"),
    code: z.string().describe("Product code"),
    cl_sale_articles_id: coerceId.optional().describe("Sales article ID"),
    sale_accounts_id: coerceId.optional().describe("Sales account ID"),
    cl_sale_accounts_dimensions_id: coerceId.optional().describe("Sales account dimension ID (use list_account_dimensions to find valid IDs)"),
    sale_accounts_dimensions_id: coerceId.optional().describe("Sales account dimension ID"),
    cl_purchase_articles_id: coerceId.optional().describe("Purchase article ID"),
    purchase_accounts_id: coerceId.optional().describe("Purchase account ID"),
    purchase_accounts_dimensions_id: coerceId.optional().describe("Purchase account dimension ID"),
    sales_price: z.coerce.number().optional().describe("Sales price"),
    unit: z.string().optional().describe("Unit (e.g. tk, h, km)"),
  }, { ...create, title: "Create Product" }, async (params) => {
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

  registerTool(server, "update_product", "Update a product. Server-managed fields (id, is_active, deactivated_date) are rejected — use the dedicated deactivate/restore tools.", {
    id: coerceId.describe("Product ID"),
    data: jsonObjectInput.describe("Object with fields to update. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Product" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
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
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "deactivate_product", "Deactivate a product (can be restored with restore_product)", idParam.shape, { ...mutate, title: "Deactivate Product" }, async ({ id }) => {
    const result = await api.products.deactivate(id);
    logAudit({
      tool: "deactivate_product", action: "DELETED", entity_type: "product", entity_id: id,
      summary: `Deactivated product ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "restore_product", "Reactivate a deactivated product", idParam.shape, { ...mutate, title: "Restore Product" }, async ({ id }) => {
    const result = await api.products.restore(id);
    logAudit({
      tool: "restore_product", action: "UPDATED", entity_type: "product", entity_id: id,
      summary: `Restored product ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  // =====================
  // JOURNALS
  // =====================

  registerTool(server, "list_journals",
    "List journal entries. Paginated. Returns brief view (id, effective_date, number, title, document_number, registered, clients_id, operation_type) by default — postings always omitted at this surface; pass view='full' for the remaining header fields, or call get_journal for postings. " +
    "Optional filters are applied client-side after listAll() when any filter is provided, which avoids repeated page-by-page walks.",
    {
      ...pageParam.shape,
      ...viewParam,
      effective_date_from: z.string().optional().describe("Only journals with effective_date >= this (YYYY-MM-DD)"),
      effective_date_to: z.string().optional().describe("Only journals with effective_date <= this (YYYY-MM-DD)"),
      registered: z.boolean().optional().describe("Only registered (true) or unregistered (false) journals"),
      operation_type: z.string().optional().describe("Filter by operation_type (e.g. ENTRY, TRANSACTION, SALE_INVOICE, PURCHASE_INVOICE)"),
      document_number_contains: z.string().optional().describe("Case-insensitive substring match on document_number"),
      clients_id: z.number().int().positive().optional().describe("Filter by clients_id"),
      per_page: z.number().int().min(1).max(500).optional().describe("Items per page when filtering (default 100, max 500)"),
    },
    { ...readOnly, title: "List Journals" },
    async (params) => {
      const hasFilter = params.effective_date_from !== undefined
        || params.effective_date_to !== undefined
        || params.registered !== undefined
        || params.operation_type !== undefined
        || params.document_number_contains !== undefined
        || params.clients_id !== undefined;
      if (!hasFilter) {
        const result = await api.journals.list(params);
        const stripped = result.items.map(({ postings: _postings, ...rest }) => rest);
        const compact = {
          ...result,
          items: applyListView("journal", stripped, params.view),
          warnings: withOpeningBalanceApiLimitation(),
        };
        return { content: [{ type: "text", text: toMcpJson(compact) }] };
      }
      const all = await api.journals.listAllCached();
      const docContains = params.document_number_contains?.toLowerCase();
      const filtered = all.filter((j) => {
        if (params.effective_date_from && (!j.effective_date || j.effective_date < params.effective_date_from)) return false;
        if (params.effective_date_to && (!j.effective_date || j.effective_date > params.effective_date_to)) return false;
        if (params.registered !== undefined && j.registered !== params.registered) return false;
        if (params.operation_type && j.operation_type !== params.operation_type) return false;
        if (params.clients_id !== undefined && j.clients_id !== params.clients_id) return false;
        if (docContains && !(j.document_number ?? "").toLowerCase().includes(docContains)) return false;
        return true;
      });
      const perPage = params.per_page ?? 100;
      // pageParam doesn't constrain `page` to positive integers, so defensively
      // floor + clamp here.
      const requestedPage = Math.max(1, Math.floor(params.page ?? 1));
      const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
      // out_of_range is surfaced so an LLM caller that over-paginates doesn't
      // mistake "past the end" for "legitimately empty page" silently.
      const outOfRange = requestedPage > totalPages;
      const start = (requestedPage - 1) * perPage;
      const stripped = filtered.slice(start, start + perPage)
        .map(({ postings: _postings, ...rest }) => rest);
      const items = applyListView("journal", stripped, params.view);
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            current_page: requestedPage,
            total_pages: totalPages,
            total_items: filtered.length,
            per_page: perPage,
            filtered_client_side: true,
            out_of_range: outOfRange,
            items,
            warnings: withOpeningBalanceApiLimitation(),
          }),
        }],
      };
    });

  registerTool(server, "get_journal", "Get a journal entry by ID (includes postings)", idParam.shape, { ...readOnly, title: "Get Journal" }, async ({ id }) => {
    const result = await api.journals.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_journal", "Create a journal entry with postings", {
    title: z.string().optional().describe("Journal entry title"),
    effective_date: isoDateString("Entry date (YYYY-MM-DD)"),
    clients_id: z.number().optional().describe("Related client ID"),
    document_number: z.string().optional().describe("Document number"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    postings: jsonObjectArrayInput.describe(
      "Array of postings: [{accounts_id, type: 'D'|'C', amount, accounts_dimensions_id?, base_amount?, projects_project_id?, projects_location_id?, projects_person_id?}]. Legacy callers may still pass a JSON array string. " +
      "accounts_dimensions_id is REQUIRED when accounts_id refers to an account with sub-accounts (use list_account_dimensions to look it up). " +
      "base_amount is the EUR equivalent for multi-currency entries (when cl_currencies_id is not EUR). " +
      "projects_project_id / projects_location_id / projects_person_id link the posting to project tracking dimensions."
    ),
  }, { ...create, title: "Create Journal" }, async (params) => {
    const postings = parsePostings(params.postings);
    const [accounts, accountDimensions] = await Promise.all([
      api.readonly.getAccounts(),
      api.readonly.getAccountDimensions(),
    ]);
    const postingErrors = validatePostingDimensions(postings, accounts, accountDimensions);
    if (postingErrors.length > 0) {
      return toolError({ error: "Account validation failed", details: postingErrors });
    }
    const result = await api.journals.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
      postings,
    });
    logAudit({
      tool: "create_journal", action: "CREATED", entity_type: "journal",
      entity_id: result.created_object_id,
      summary: `Created journal "${params.title ?? ""}" on ${params.effective_date}`,
      details: {
        effective_date: params.effective_date, title: params.title,
        document_number: params.document_number,
        postings: postings.map(p => ({
          accounts_id: p.accounts_id,
          type: p.type,
          amount: p.amount,
          accounts_dimensions_id: p.accounts_dimensions_id,
          base_amount: p.base_amount,
          projects_project_id: p.projects_project_id,
          projects_location_id: p.projects_location_id,
          projects_person_id: p.projects_person_id,
        })),
      },
    });
    return toolResponse({
      action: "created",
      entity: "journal",
      id: result.created_object_id,
      message: `Created journal${params.title ? ` "${params.title}"` : ""} on ${params.effective_date}.`,
      raw: result,
    });
  });

  registerTool(server, "update_journal", "Update a journal entry. Server-managed fields (id, registered, register_date, status) are rejected — use the dedicated confirm/invalidate tools. Once the journal is registered, effective_date is audit-locked; invalidate_journal first to edit it.", {
    id: coerceId.describe("Journal ID"),
    data: jsonObjectInput.describe("Object with fields to update. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Journal" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const current = await api.journals.get(id);
    const updateErrors = validateUpdateFields(parsed, "journal", { isConfirmed: current.registered === true });
    if (updateErrors.length > 0) {
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    const result = await api.journals.update(id, parsed);
    logAudit({
      tool: "update_journal", action: "UPDATED", entity_type: "journal", entity_id: id,
      summary: `Updated journal ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "delete_journal", "Delete a journal entry", idParam.shape, { ...destructive, title: "Delete Journal" }, async ({ id }) => {
    const result = await api.journals.delete(id);
    logAudit({
      tool: "delete_journal", action: "DELETED", entity_type: "journal", entity_id: id,
      summary: `Deleted journal ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "confirm_journal", "Confirm/register a journal entry. IRREVERSIBLE — use invalidate_journal to reverse if needed.", idParam.shape, { ...destructive, title: "Confirm Journal" }, async ({ id }) => {
    const result = await api.journals.confirm(id);
    logAudit({
      tool: "confirm_journal", action: "CONFIRMED", entity_type: "journal", entity_id: id,
      summary: `Confirmed journal ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "batch_confirm_journals",
    "Confirm/register multiple journal entries in one call. IRREVERSIBLE for each success. " +
    "Runs sequentially; already-registered journals are skipped (checked up-front via /journals/:id); " +
    "continues past individual failures and returns per-ID results so partial progress is visible.",
    {
      ids: z.array(z.number().int().positive()).min(1).max(500).describe("Journal IDs (positive integers, 1-500 entries)"),
      reason: z.string().min(1).max(500).describe("Short audit note explaining why this batch is being confirmed (e.g. 'Lightyear trades batch — Q1 2026'). Required — max 500 chars."),
    },
    { ...destructive, title: "Batch Confirm Journals" },
    async ({ ids, reason }) => {
      const unique = [...new Set(ids)];
      // Bulk pre-fetch via listAllCached so a 500-ID batch doesn't make 500 serial
      // GET calls (~50s at 10 req/sec). Falls back to per-ID lookup for IDs not
      // present in the aggregate (e.g. brand-new journals created after the
      // cache was populated).
      const allJournals = await api.journals.listAllCached();
      const byId = new Map(allJournals.filter(j => j.id != null).map(j => [j.id!, j]));
      const results: Array<{
        id: number;
        status: "confirmed" | "skipped_already_confirmed" | "skipped_missing" | "lookup_failed" | "failed";
        error?: string;
      }> = [];
      for (const id of unique) {
        // Pre-check lets us categorize already-registered journals (which the API
        // rejects) separately from real failures, matching the delete-batch shape.
        let alreadyRegistered = false;
        const cachedJournal = byId.get(id);
        if (cachedJournal) {
          alreadyRegistered = cachedJournal.registered === true;
        } else {
          try {
            const existing = await api.journals.get(id);
            alreadyRegistered = existing.registered === true;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const isNotFound = error instanceof HttpError && error.status === 404;
            results.push({
              id,
              status: isNotFound ? "skipped_missing" : "lookup_failed",
              error: message,
            });
            continue;
          }
        }
        if (alreadyRegistered) {
          results.push({
            id,
            status: "skipped_already_confirmed",
            error: "Journal is already registered — nothing to confirm.",
          });
          continue;
        }
        try {
          await api.journals.confirm(id);
          logAudit({
            tool: "batch_confirm_journals", action: "CONFIRMED", entity_type: "journal", entity_id: id,
            summary: `Confirmed journal ${id}: ${reason}`,
            details: { reason },
          });
          results.push({ id, status: "confirmed" });
        } catch (error: unknown) {
          results.push({ id, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
      const confirmed = results.filter(r => r.status === "confirmed").length;
      const skipped = results.filter(r =>
        r.status === "skipped_already_confirmed" || r.status === "skipped_missing",
      ).length;
      const lookupFailed = results.filter(r => r.status === "lookup_failed").length;
      const failed = results.filter(r => r.status === "failed").length;
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            requested: unique.length,
            confirmed_count: confirmed,
            skipped_count: skipped,
            lookup_failed_count: lookupFailed,
            failed_count: failed,
            reason,
            results,
          }),
        }],
      };
    });

  registerTool(server, "invalidate_journal",
    "Invalidate (reverse) a confirmed journal entry. Returns it to unconfirmed status for editing or deletion.",
    idParam.shape, { ...mutate, title: "Invalidate Journal" }, async ({ id }) => {
      const result = await api.journals.invalidate(id);
      logAudit({
        tool: "invalidate_journal", action: "INVALIDATED", entity_type: "journal", entity_id: id,
        summary: `Invalidated journal ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });

  // =====================
  // TRANSACTIONS
  // =====================

  registerTool(server, "list_transactions",
    "List bank transactions. Paginated. Returns brief view (id, date, amount, currency, status, type, clients_id, accounts_dimensions_id, bank_ref_number, description) by default; pass view='full' or call get_transaction for full detail (including items). " +
    "Optional filters are applied client-side after listAll() when any filter is provided, so callers don't need to paginate through dozens of pages to find matching rows.",
    {
      ...pageParam.shape,
      ...viewParam,
      date_from: z.string().optional().describe("Only transactions with date >= this (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Only transactions with date <= this (YYYY-MM-DD)"),
      status: z.string().optional().describe("Filter by status: PROJECT, CONFIRMED, or VOID"),
      accounts_dimensions_id: z.number().int().positive().optional().describe("Filter by bank account dimension ID"),
      amount_min: z.number().optional().describe("Only transactions whose EUR-equivalent amount (base_amount ?? amount) >= this"),
      amount_max: z.number().optional().describe("Only transactions whose EUR-equivalent amount (base_amount ?? amount) <= this"),
      has_bank_ref: z.boolean().optional().describe("true = only transactions with a bank_ref_number; false = only without"),
      bank_ref_contains: z.string().optional().describe("Case-insensitive substring match on bank_ref_number"),
      clients_id: z.number().int().positive().optional().describe("Filter by clients_id"),
      per_page: z.number().int().min(1).max(500).optional().describe("Items per page when filtering (default 100, max 500)"),
    },
    { ...readOnly, title: "List Transactions" },
    async (params) => {
      const hasFilter = params.date_from !== undefined
        || params.date_to !== undefined
        || params.status !== undefined
        || params.accounts_dimensions_id !== undefined
        || params.amount_min !== undefined
        || params.amount_max !== undefined
        || params.has_bank_ref !== undefined
        || params.bank_ref_contains !== undefined
        || params.clients_id !== undefined;
      if (!hasFilter) {
        const result = await api.transactions.list(params);
        const compact = { ...result, items: applyListView("transaction", result.items, params.view) };
        return { content: [{ type: "text", text: toMcpJson(compact) }] };
      }
      const all = await api.transactions.listAllCached();
      const bankRefContains = params.bank_ref_contains?.toLowerCase();
      const filtered = all.filter((tx) => {
        if (params.date_from && (!tx.date || tx.date < params.date_from)) return false;
        if (params.date_to && (!tx.date || tx.date > params.date_to)) return false;
        if (params.status && tx.status !== params.status) return false;
        if (params.accounts_dimensions_id !== undefined && tx.accounts_dimensions_id !== params.accounts_dimensions_id) return false;
        // Mirror the rest of the codebase (analyze-unconfirmed, reconciliation):
        // EUR-equivalent comparison, not nominal — otherwise a USD 1000 / 920-EUR
        // tx would match amount_min=950 inconsistently with the rest of the tools.
        const comparableAmount = (tx.base_amount ?? tx.amount) as number;
        if (params.amount_min !== undefined && comparableAmount < params.amount_min) return false;
        if (params.amount_max !== undefined && comparableAmount > params.amount_max) return false;
        if (params.clients_id !== undefined && tx.clients_id !== params.clients_id) return false;
        const normalizedRef = (tx.bank_ref_number ?? "").trim();
        if (params.has_bank_ref === true && !normalizedRef) return false;
        if (params.has_bank_ref === false && normalizedRef) return false;
        if (bankRefContains && !normalizedRef.toLowerCase().includes(bankRefContains)) return false;
        return true;
      });
      const perPage = params.per_page ?? 100;
      const requestedPage = Math.max(1, Math.floor(params.page ?? 1));
      const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
      const outOfRange = requestedPage > totalPages;
      const start = (requestedPage - 1) * perPage;
      const items = applyListView("transaction", filtered.slice(start, start + perPage), params.view);
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            current_page: requestedPage,
            total_pages: totalPages,
            total_items: filtered.length,
            per_page: perPage,
            filtered_client_side: true,
            out_of_range: outOfRange,
            items,
          }),
        }],
      };
    });

  registerTool(server, "get_transaction", "Get a transaction by ID", idParam.shape, { ...readOnly, title: "Get Transaction" }, async ({ id }) => {
    const result = await api.transactions.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_transaction", "Create a bank transaction", {
    accounts_dimensions_id: coerceId.describe("Bank account dimension ID"),
    type: z.string().describe("Transaction type: D (incoming) or C (outgoing)"),
    amount: z.number().describe("Transaction amount"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    date: isoDateString("Transaction date (YYYY-MM-DD)"),
    description: z.string().optional().describe("Description"),
    clients_id: z.number().optional().describe("Related client ID"),
    bank_account_name: z.string().optional().describe("Remitter/beneficiary name"),
    ref_number: z.string().optional().describe("Reference number"),
  }, { ...create, title: "Create Transaction" }, async (params) => {
    const result = await api.transactions.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
    });
    logAudit({
      tool: "create_transaction", action: "CREATED", entity_type: "transaction",
      entity_id: result.created_object_id,
      summary: `Created transaction ${params.amount} ${params.cl_currencies_id ?? "EUR"} on ${params.date}`,
      details: { date: params.date, amount: params.amount, type: params.type, description: params.description, accounts_dimensions_id: params.accounts_dimensions_id },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "confirm_transaction",
    "Confirm a bank transaction by providing distribution rows. " +
    "If the transaction has no clients_id (common for CAMT imports), pass clients_id to set it before confirming — " +
    "otherwise the API rejects with 'buyer or supplier is missing'. " +
    "For invoice distributions, clients_id is auto-resolved from the invoice.",
    {
    id: coerceId.describe("Transaction ID"),
      distributions: jsonObjectArrayInput.optional().describe(
        "Array of distribution rows: [{related_table, related_id, related_sub_id?, amount}]. Legacy callers may still pass a JSON array string. " +
      "related_table values: 'accounts' (book to a GL account), 'purchase_invoices', 'sale_invoices'. " +
      "related_id is REQUIRED for all three related_table values (the account ID, purchase-invoice ID, or sale-invoice ID). " +
      "related_sub_id is REQUIRED when related_table='accounts' and the account has dimensions — " +
      "pass the dimension ID there (e.g. 1360 'Arveldused aruandvate isikutega' with sub-account per person). " +
      "Without related_sub_id the API rejects with 'Entry cannot be made directly to the account ... since it has dimensions'. " +
      "Use list_account_dimensions to look up dimension IDs for an account."
    ),
    clients_id: coerceId.optional().describe("Client ID to set on the transaction before confirming (required when transaction has no clients_id and distribution is against accounts, not invoices)"),
  }, { ...destructive, title: "Confirm Transaction" }, async ({ id, distributions, clients_id }) => {
    const dist = distributions ? parseTransactionDistributions(distributions) : undefined;
    if (dist && dist.some(d => d.related_table === "accounts")) {
      const [accounts, accountDimensions] = await Promise.all([
        api.readonly.getAccounts(),
        api.readonly.getAccountDimensions(),
      ]);
      const dimensionErrors = validateTransactionDistributionDimensions(dist, accounts, accountDimensions);
      if (dimensionErrors.length > 0) {
        return toolError({ error: "Account validation failed", details: dimensionErrors });
      }
    }

    let clientsIdWasSet = false;
    if (clients_id) {
      const tx = await api.transactions.get(id);
      if (!tx.clients_id) {
        await api.transactions.update(id, { clients_id } as Partial<Transaction>);
        clientsIdWasSet = true;
      }
    }

    let result: Awaited<ReturnType<typeof api.transactions.confirm>>;
    try {
      result = await api.transactions.confirm(id, dist);
    } catch (error) {
      if (clientsIdWasSet) {
        try {
          await api.transactions.update(id, { clients_id: null } as Partial<Transaction>);
        } catch { /* best effort rollback */ }
      }
      throw error;
    }
    logAudit({
      tool: "confirm_transaction", action: "CONFIRMED", entity_type: "transaction", entity_id: id,
      summary: `Confirmed transaction ${id}`,
      details: { distributions: dist?.map(d => ({ related_table: d.related_table, related_id: d.related_id, related_sub_id: d.related_sub_id, amount: d.amount })) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "update_transaction", "Update transaction metadata fields such as bank reference, counterparty name, bank account number, description, or payment reference.", {
    id: coerceId.describe("Transaction ID"),
    data: jsonObjectInput.describe("Object with allowed metadata fields only: bank_ref_number, bank_account_name, bank_account_no, description, ref_number. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Transaction" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const validationErrors = validateTransactionUpdateData(parsed);
    if (validationErrors.length > 0) {
      return toolError({ error: "Transaction metadata validation failed", details: validationErrors });
    }
    const result = await api.transactions.update(id, parsed as Partial<Transaction>);
    logAudit({
      tool: "update_transaction", action: "UPDATED", entity_type: "transaction", entity_id: id,
      summary: `Updated transaction ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "invalidate_transaction",
    "Invalidate (unconfirm) a confirmed transaction. Returns it to unconfirmed status for editing or deletion.",
    idParam.shape, { ...mutate, title: "Invalidate Transaction" }, async ({ id }) => {
      const result = await api.transactions.invalidate(id);
      logAudit({
        tool: "invalidate_transaction", action: "INVALIDATED", entity_type: "transaction", entity_id: id,
        summary: `Invalidated transaction ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });

  registerTool(server, "delete_transaction", "Delete a transaction", idParam.shape, { ...destructive, title: "Delete Transaction" }, async ({ id }) => {
    const result = await api.transactions.delete(id);
    logAudit({
      tool: "delete_transaction", action: "DELETED", entity_type: "transaction", entity_id: id,
      summary: `Deleted transaction ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "batch_delete_transactions",
    "Delete multiple unconfirmed (PROJECT) transactions in one call. IRREVERSIBLE. " +
    "Runs sequentially; CONFIRMED transactions are skipped with a clear reason (they must be invalidated first). " +
    "Transient API errors on the pre-delete lookup are surfaced as `lookup_failed` so they can be retried, " +
    "distinct from `skipped_missing` (the transaction no longer exists).",
    {
      ids: z.array(z.number().int().positive()).min(1).max(500).describe("Transaction IDs (positive integers, 1-500 entries)"),
      reason: z.string().min(1).max(500).describe("Short audit note explaining why this batch is being deleted (e.g. 're-import duplicates of confirmed journals'). Required — max 500 chars."),
    },
    { ...destructive, title: "Batch Delete Transactions" },
    async ({ ids, reason }) => {
      const unique = [...new Set(ids)];
      const results: Array<{
        id: number;
        status: "deleted" | "skipped_confirmed" | "skipped_missing" | "lookup_failed" | "failed";
        error?: string;
      }> = [];
      for (const id of unique) {
        let existing: Transaction | undefined;
        try {
          existing = await api.transactions.get(id);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          // Split 404-from-API vs anything else: 404 genuinely means the row is
          // gone (skip and move on); transient errors (500/timeout/auth drop)
          // shouldn't be treated as "gone" because the caller may drop the ID
          // from reconciliation decisions.
          const isNotFound = error instanceof HttpError && error.status === 404;
          results.push({
            id,
            status: isNotFound ? "skipped_missing" : "lookup_failed",
            error: message,
          });
          continue;
        }
        if (existing.status === "CONFIRMED") {
          results.push({
            id,
            status: "skipped_confirmed",
            error: "Transaction is CONFIRMED — call invalidate_transaction first, then batch_delete_transactions.",
          });
          continue;
        }
        try {
          await api.transactions.delete(id);
          // Capture a full snapshot so the audit log alone is enough to
          // reconstruct the transaction if the deletion turns out to be wrong.
          logAudit({
            tool: "batch_delete_transactions", action: "DELETED", entity_type: "transaction", entity_id: id,
            summary: `Deleted transaction ${id}: ${reason}`,
            details: {
              reason,
              snapshot: {
                accounts_dimensions_id: existing.accounts_dimensions_id,
                accounts_id: existing.accounts_id,
                type: existing.type,
                amount: existing.amount,
                base_amount: existing.base_amount,
                cl_currencies_id: existing.cl_currencies_id,
                date: existing.date,
                description: existing.description,
                bank_ref_number: existing.bank_ref_number,
                bank_account_no: existing.bank_account_no,
                bank_account_name: existing.bank_account_name,
                clients_id: existing.clients_id,
                ref_number: existing.ref_number,
                status: existing.status,
              },
            },
          });
          results.push({ id, status: "deleted" });
        } catch (error: unknown) {
          results.push({ id, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
      const deleted = results.filter(r => r.status === "deleted").length;
      const skipped = results.filter(r => r.status === "skipped_confirmed" || r.status === "skipped_missing").length;
      const lookupFailed = results.filter(r => r.status === "lookup_failed").length;
      const failed = results.filter(r => r.status === "failed").length;
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            requested: unique.length,
            deleted_count: deleted,
            skipped_count: skipped,
            lookup_failed_count: lookupFailed,
            failed_count: failed,
            reason,
            results,
          }),
        }],
      };
    });

  // =====================
  // SALE INVOICES
  // =====================

  registerTool(server, "list_sale_invoices",
    "List sales invoices. Paginated. Returns brief view (id, number, clients_id, client_name, dates, status/payment_status, gross/net price, currency, term_days) by default; pass view='full' or call get_sale_invoice for items, deliveries, and remaining detail.",
    { ...pageParam.shape, ...viewParam },
    { ...readOnly, title: "List Sale Invoices" }, async (params) => {
    const result = await api.saleInvoices.list(params);
    const compact = { ...result, items: applyListView("sale_invoice", result.items, params.view) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_sale_invoice", "Get a sales invoice by ID (includes items, deliveries)", idParam.shape, { ...readOnly, title: "Get Sale Invoice" }, async ({ id }) => {
    const result = await api.saleInvoices.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_sale_invoice", "Create a sales invoice", {
    clients_id: coerceId.describe("Buyer client ID"),
    cl_templates_id: coerceId.describe("Invoice template ID"),
    number_suffix: z.string().optional().describe("Invoice number suffix (omit or empty string for auto-assign from invoice series)"),
    create_date: isoDateString("Invoice date (YYYY-MM-DD)"),
    journal_date: isoDateString("Turnover date (YYYY-MM-DD)"),
    term_days: z.number().describe("Payment term in days"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    cl_countries_id: z.string().optional().describe("Country (default EST)"),
    sale_invoice_type: z.string().optional().describe("Type: INVOICE or CREDIT_INVOICE"),
    show_client_balance: z.boolean().optional().describe("Show client balance on invoice"),
      items: jsonObjectArrayInput.describe(
        "Array of invoice items: [{products_id, custom_title, amount, unit_net_price, sale_accounts_id?, sale_accounts_dimensions_id?, vat_accounts_id?, cl_sale_articles_id?, discount_percent?, projects_project_id?, projects_location_id?, projects_person_id?}]. Legacy callers may still pass a JSON array string. " +
      "sale_accounts_dimensions_id is REQUIRED when the revenue account has dimensions (sub-accounts). Use list_account_dimensions to look up dimension IDs. " +
      "Note: SaleInvoicesItems schema has no vat_accounts_dimensions_id field — only the purchase side does."
    ),
    notes: z.string().optional().describe("Internal notes"),
  }, { ...create, title: "Create Sale Invoice" }, async (params) => {
    const items = parseSaleInvoiceItems(params.items);
    const [accounts, accountDimensions] = await Promise.all([
      api.readonly.getAccounts(),
      api.readonly.getAccountDimensions(),
    ]);
    const dimErrors = validateSaleInvoiceItemDimensions(items, accounts, accountDimensions);
    if (dimErrors.length > 0) {
      return toolError({ error: "Account validation failed", details: dimErrors });
    }
    const result = await api.saleInvoices.create({
      ...params,
      number_suffix: params.number_suffix ?? "",
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
      cl_countries_id: params.cl_countries_id ?? "EST",
      sale_invoice_type: params.sale_invoice_type ?? "INVOICE",
      show_client_balance: params.show_client_balance ?? false,
      notes: tagNotes(params.notes),
      items,
    });
    logAudit({
      tool: "create_sale_invoice", action: "CREATED", entity_type: "sale_invoice",
      entity_id: result.created_object_id,
      summary: `Created sale invoice for client ${params.clients_id} on ${params.create_date}`,
      details: { clients_id: params.clients_id, date: params.create_date, items: items.map(i => ({ title: i.custom_title, amount: i.amount })) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "update_sale_invoice", "Update a sales invoice. Server-managed fields (id, status, registered, register_date) are rejected — use the dedicated confirm/invalidate tools. Once CONFIRMED, create_date and journal_date are audit-locked; invalidate_sale_invoice first to edit them.", {
    id: coerceId.describe("Invoice ID"),
    data: jsonObjectInput.describe("Object with fields to update. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Sale Invoice" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const current = await api.saleInvoices.get(id);
    const updateErrors = validateUpdateFields(parsed, "sale_invoice", { isConfirmed: current.status === "CONFIRMED" });
    if (updateErrors.length > 0) {
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    const result = await api.saleInvoices.update(id, parsed);
    logAudit({
      tool: "update_sale_invoice", action: "UPDATED", entity_type: "sale_invoice", entity_id: id,
      summary: `Updated sale invoice ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "delete_sale_invoice", "Delete a sales invoice", idParam.shape, { ...destructive, title: "Delete Sale Invoice" }, async ({ id }) => {
    const result = await api.saleInvoices.delete(id);
    logAudit({
      tool: "delete_sale_invoice", action: "DELETED", entity_type: "sale_invoice", entity_id: id,
      summary: `Deleted sale invoice ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "confirm_sale_invoice", "Confirm a sales invoice. Locks the invoice for editing. Reversible via invalidate_sale_invoice.", idParam.shape, { ...destructive, title: "Confirm Sale Invoice" }, async ({ id }) => {
    const result = await api.saleInvoices.confirm(id);
    logAudit({
      tool: "confirm_sale_invoice", action: "CONFIRMED", entity_type: "sale_invoice", entity_id: id,
      summary: `Confirmed sale invoice ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "invalidate_sale_invoice",
    "Return a confirmed sale invoice to draft status for editing. Required before delete_sale_invoice against a CONFIRMED invoice.",
    idParam.shape, { ...mutate, title: "Invalidate Sale Invoice" }, async ({ id }) => {
      const result = await api.saleInvoices.invalidate(id);
      logAudit({
        tool: "invalidate_sale_invoice", action: "INVALIDATED", entity_type: "sale_invoice", entity_id: id,
        summary: `Invalidated sale invoice ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });

  registerTool(server, "get_sale_invoice_delivery_options", "Get available delivery methods for a sales invoice (e-invoice or email)", idParam.shape, { ...readOnly, title: "Get Sale Invoice Delivery Options" }, async ({ id }) => {
    const result = await api.saleInvoices.getDeliveryOptions(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "send_sale_invoice", "Send a sales invoice via e-invoice or email. DESTRUCTIVE — sends real documents to recipients.", {
    id: coerceId.describe("Invoice ID"),
    send_einvoice: z.boolean().optional().describe("Send as e-invoice (machine-readable XML)"),
    send_email: z.boolean().optional().describe("Send as email (PDF)"),
    email_addresses: z.string().optional().describe("Email addresses"),
    email_subject: z.string().optional().describe("Email subject"),
    email_body: z.string().optional().describe("Email body"),
  }, { ...send, title: "Send Sale Invoice" }, async ({ id, ...request }) => {
    const result = await api.saleInvoices.sendEinvoice(id, request);
    logAudit({
      tool: "send_sale_invoice", action: "SENT", entity_type: "sale_invoice", entity_id: id,
      summary: `Sent sale invoice ${id}`,
      details: { send_einvoice: request.send_einvoice, send_email: request.send_email },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "get_sale_invoice_document", "Download sales invoice PDF (base64)", idParam.shape, { ...readOnly, title: "Download Invoice PDF" }, async ({ id }) => {
    const result = await api.saleInvoices.getSystemPdf(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  // =====================
  // PURCHASE INVOICES
  // =====================

  registerTool(server, "list_purchase_invoices",
    "List purchase invoices. Paginated. Returns brief view (id, number, clients_id, client_name, dates, status/payment_status, gross/net/vat price, currency, term_days, bank_ref_number) by default; pass view='full' or call get_purchase_invoice for items and remaining detail.",
    { ...pageParam.shape, ...viewParam },
    { ...readOnly, title: "List Purchase Invoices" }, async (params) => {
    const result = await api.purchaseInvoices.list(params);
    const compact = { ...result, items: applyListView("purchase_invoice", result.items, params.view) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_purchase_invoice", "Get a purchase invoice by ID", idParam.shape, { ...readOnly, title: "Get Purchase Invoice" }, async ({ id }) => {
    const result = await api.purchaseInvoices.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_purchase_invoice",
    "Create a draft purchase invoice with line items. Requires cl_purchase_articles_id (use list_purchase_articles). Pass EXACT vat_price and gross_price from the original invoice.",
    {
      clients_id: coerceId.describe("Supplier client ID"),
      client_name: z.string().describe("Supplier name"),
      number: z.string().describe("Invoice number"),
      create_date: isoDateString("Invoice date (YYYY-MM-DD)"),
      journal_date: isoDateString("Turnover date (YYYY-MM-DD)"),
      term_days: z.number().describe("Payment term in days"),
      vat_price: z.number().describe("Total VAT amount from original invoice (EXACT, for payment matching). Required — confirm_purchase_invoice fails without it."),
      gross_price: z.number().describe("Total gross amount from original invoice (EXACT, for payment matching). Required — confirm_purchase_invoice fails without it."),
      cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
      liability_accounts_id: z.number().optional().describe("Liability account (default 2310)"),
      items: jsonObjectArrayInput.describe(
        "Array of items: [{custom_title, cl_purchase_articles_id, purchase_accounts_id, purchase_accounts_dimensions_id?, total_net_price, amount, vat_rate_dropdown?, vat_accounts_id?, vat_accounts_dimensions_id?, cl_vat_articles_id?, project_no_vat_gross_price?, cl_fringe_benefits_id?}]. Legacy callers may still pass a JSON array string. " +
        "purchase_accounts_dimensions_id is REQUIRED when the expense account has dimensions (sub-accounts). Same rule applies to vat_accounts_dimensions_id when the VAT account has dimensions. Use list_account_dimensions to look up dimension IDs."
      ),
      notes: z.string().optional().describe("Notes"),
      bank_ref_number: z.string().optional().describe("Payment reference number"),
      bank_account_no: z.string().optional().describe("Supplier bank account"),
    }, { ...create, title: "Create Purchase Invoice" }, async (params) => {
      const isVatReg = await isCompanyVatRegistered(api);
      const purchaseArticles = await getPurchaseArticlesWithVat(api);
      const rawItems = parsePurchaseInvoiceItems(params.items);
      const items = rawItems.map(item => applyPurchaseVatDefaults(purchaseArticles, item, isVatReg));

      // Validate dimension requirements before hitting the API
      const [accounts, accountDimensions] = await Promise.all([
        api.readonly.getAccounts(),
        api.readonly.getAccountDimensions(),
      ]);
      const dimErrors = validateItemDimensions(items, accounts, accountDimensions);
      if (dimErrors.length > 0) {
        return toolError({ error: "Account validation failed", details: dimErrors });
      }

      const invoiceData: CreatePurchaseInvoiceData = {
        clients_id: params.clients_id,
        client_name: params.client_name,
        number: params.number,
        create_date: params.create_date,
        journal_date: params.journal_date,
        term_days: params.term_days,
        cl_currencies_id: params.cl_currencies_id ?? "EUR",
        liability_accounts_id: params.liability_accounts_id ?? DEFAULT_LIABILITY_ACCOUNT,
        bank_ref_number: params.bank_ref_number,
        bank_account_no: params.bank_account_no,
        notes: tagNotes(params.notes),
        items,
      };
      const result = await api.purchaseInvoices.createAndSetTotals(
        invoiceData,
        params.vat_price,
        params.gross_price,
        isVatReg,
      );
      logAudit({
        tool: "create_purchase_invoice", action: "CREATED", entity_type: "purchase_invoice",
        entity_id: result.id,
        summary: `Created purchase invoice "${params.number}" from ${params.client_name}`,
        details: {
          supplier_name: params.client_name, invoice_number: params.number,
          invoice_date: params.create_date, total_vat: params.vat_price, total_gross: params.gross_price,
          items: items.map(i => ({ title: i.custom_title, cl_purchase_articles_id: i.cl_purchase_articles_id, total_net_price: i.total_net_price })),
        },
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });

  registerTool(server, "update_purchase_invoice", "Update a purchase invoice. Server-managed fields (id, status, registered, register_date, payment_status) are rejected — use the dedicated confirm/invalidate tools. Once CONFIRMED, create_date and journal_date are audit-locked; invalidate_purchase_invoice first to edit them.", {
    id: coerceId.describe("Invoice ID"),
    data: jsonObjectInput.describe("Object with fields to update. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Purchase Invoice" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const current = await api.purchaseInvoices.get(id);
    const updateErrors = validateUpdateFields(parsed, "purchase_invoice", { isConfirmed: current.status === "CONFIRMED" });
    if (updateErrors.length > 0) {
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    const result = await api.purchaseInvoices.update(id, parsed);
    logAudit({
      tool: "update_purchase_invoice", action: "UPDATED", entity_type: "purchase_invoice", entity_id: id,
      summary: `Updated purchase invoice ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "delete_purchase_invoice", "Delete a purchase invoice", idParam.shape, { ...destructive, title: "Delete Purchase Invoice" }, async ({ id }) => {
    const result = await api.purchaseInvoices.delete(id);
    logAudit({
      tool: "delete_purchase_invoice", action: "DELETED", entity_type: "purchase_invoice", entity_id: id,
      summary: `Deleted purchase invoice ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "confirm_purchase_invoice",
    "Confirm and lock a purchase invoice. Automatically fixes vat_price/gross_price if missing or inconsistent with item totals.",
    idParam.shape, { ...destructive, title: "Confirm Purchase Invoice" }, async ({ id }) => {
      const isVatReg = await isCompanyVatRegistered(api);
      const result = await api.purchaseInvoices.confirmWithTotals(id, isVatReg);
      logAudit({
        tool: "confirm_purchase_invoice", action: "CONFIRMED", entity_type: "purchase_invoice", entity_id: id,
        summary: `Confirmed purchase invoice ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });

  registerTool(server, "invalidate_purchase_invoice",
    "Return a confirmed purchase invoice to draft status for editing.",
    idParam.shape, { ...mutate, title: "Invalidate Purchase Invoice" }, async ({ id }) => {
      const result = await api.purchaseInvoices.invalidate(id);
      logAudit({
        tool: "invalidate_purchase_invoice", action: "INVALIDATED", entity_type: "purchase_invoice", entity_id: id,
        summary: `Invalidated purchase invoice ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });

  registerReferenceDataTools(server, api);
}
