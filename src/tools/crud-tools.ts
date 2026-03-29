import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import type { ClientsApi } from "../api/clients.api.js";
import type { ProductsApi } from "../api/products.api.js";
import type { JournalsApi } from "../api/journals.api.js";
import type { TransactionsApi } from "../api/transactions.api.js";
import type { SaleInvoicesApi } from "../api/sale-invoices.api.js";
import type { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import type { ReferenceDataApi } from "../api/readonly.api.js";
import type { Posting, TransactionDistribution, SaleInvoiceItem, PurchaseInvoiceItem, CreatePurchaseInvoiceData } from "../types/api.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "./purchase-vat-defaults.js";
import { validateItemDimensions } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { readOnly, create, mutate, destructive, send } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";

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
  if (input.length > MAX_JSON_INPUT_SIZE) {
    throw new Error(`JSON input for "${label}" exceeds maximum size of ${MAX_JSON_INPUT_SIZE} bytes`);
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(input: string, label: string): Record<string, unknown> {
  const parsed = safeJsonParse(input, label);
  if (!isRecord(parsed)) {
    throw new Error(`"${label}" must be a JSON object`);
  }
  return parsed;
}

export function parseJsonObjectArray(input: string, label: string): Record<string, unknown>[] {
  const parsed = safeJsonParse(input, label);
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

/** Coerce string-typed numbers to actual numbers (LLMs often quote numbers in JSON). */
export function coerceNumericFields(items: Record<string, unknown>[], fields: string[]): void {
  for (const item of items) {
    for (const field of fields) {
      if (field in item && typeof item[field] === "string") {
        const parsed = Number(item[field]);
        if (Number.isFinite(parsed)) {
          item[field] = parsed;
        }
      }
    }
  }
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

function parsePostings(input: string): Posting[] {
  const postings = parseJsonObjectArray(input, "postings");
  requireFields(postings, "postings", ["accounts_id", "type", "amount"]);
  requireNumericFields(postings, "postings", ["accounts_id", "amount", "accounts_dimensions_id", "projects_project_id", "base_amount"]);

  postings.forEach((posting, index) => {
    if (posting.type !== "D" && posting.type !== "C") {
      throw new Error(`"postings" item ${index + 1} has invalid type "${String(posting.type)}" (expected "D" or "C")`);
    }
  });

  return postings as unknown as Posting[];
}

function parseTransactionDistributions(input: string): TransactionDistribution[] {
  const distributions = parseJsonObjectArray(input, "distributions");
  requireFields(distributions, "distributions", ["related_table", "amount"]);
  requireNumericFields(distributions, "distributions", ["amount", "related_id", "related_sub_id"]);
  return distributions as unknown as TransactionDistribution[];
}

export function parseSaleInvoiceItems(input: string): SaleInvoiceItem[] {
  const items = parseJsonObjectArray(input, "items");
  requireFields(items, "items", ["products_id", "custom_title", "amount"]);
  requireNumericFields(items, "items", ["products_id", "amount", "unit_net_price", "vat_accounts_id", "discount_percent"]);
  return items as unknown as SaleInvoiceItem[];
}

export function parsePurchaseInvoiceItems(input: string): PurchaseInvoiceItem[] {
  const items = parseJsonObjectArray(input, "items");
  requireFields(items, "items", ["cl_purchase_articles_id", "custom_title"]);
  requireNumericFields(items, "items", [
    "cl_purchase_articles_id", "total_net_price", "unit_net_price", "amount",
    "vat_accounts_id", "purchase_accounts_id", "purchase_accounts_dimensions_id",
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

const MCP_TAG = "e-arveldaja-mcp";

/** Append "(e-arveldaja-mcp)" to notes when EARVELDAJA_TAG_NOTES=true. */
export function tagNotes(notes?: string): string | undefined {
  if (process.env.EARVELDAJA_TAG_NOTES !== "true") return notes;
  return notes ? `${notes} (${MCP_TAG})` : `(${MCP_TAG})`;
}
const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const isoDateString = (description: string) =>
  z.string().regex(isoDateRegex, "Expected YYYY-MM-DD").describe(description);

export function registerCrudTools(server: McpServer, api: ApiContext): void {
  // =====================
  // CLIENTS
  // =====================

  registerTool(server, "list_clients", "List all clients (buyers/suppliers). Paginated.", pageParam.shape, { ...readOnly, title: "List Clients" }, async (params) => {
    const result = await api.clients.list(params);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
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

  registerTool(server, "update_client", "Update an existing client", {
    id: coerceId.describe("Client ID"),
    data: z.string().describe("JSON object with fields to update"),
  }, { ...mutate, title: "Update Client" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const result = await api.clients.update(id, parsed);
    logAudit({
      tool: "update_client", action: "UPDATED", entity_type: "client", entity_id: id,
      summary: `Updated client ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
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
    return { content: [{ type: "text", text: result ? toMcpJson(result) : "Not found" }] };
  });

  // =====================
  // PRODUCTS
  // =====================

  registerTool(server, "list_products", "List all products/services. Paginated.", pageParam.shape, { ...readOnly, title: "List Products" }, async (params) => {
    const result = await api.products.list(params);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "get_product", "Get a single product by ID", idParam.shape, { ...readOnly, title: "Get Product" }, async ({ id }) => {
    const result = await api.products.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_product", "Create a new product/service", {
    name: z.string().describe("Product name"),
    code: z.string().describe("Product code"),
    cl_sale_articles_id: z.number().optional().describe("Sales article ID"),
    cl_purchase_articles_id: z.number().optional().describe("Purchase article ID"),
    sales_price: z.number().optional().describe("Sales price"),
    unit: z.string().optional().describe("Unit (e.g. tk, h, km)"),
  }, { ...create, title: "Create Product" }, async (params) => {
    const result = await api.products.create(params);
    logAudit({
      tool: "create_product", action: "CREATED", entity_type: "product",
      entity_id: result.created_object_id,
      summary: `Created product "${params.name}" (${params.code})`,
      details: { name: params.name, code: params.code, sales_price: params.sales_price },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "update_product", "Update a product", {
    id: coerceId.describe("Product ID"),
    data: z.string().describe("JSON object with fields to update"),
  }, { ...mutate, title: "Update Product" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
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

  registerTool(server, "list_journals", "List journal entries. Paginated. Postings omitted — use get_journal for full details.", pageParam.shape, { ...readOnly, title: "List Journals" }, async (params) => {
    const result = await api.journals.list(params);
    const compact = {
      ...result,
      items: result.items.map(({ postings: _postings, ...rest }) => rest),
    };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
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
    postings: z.string().describe("JSON array of postings: [{accounts_id, type: 'D'|'C', amount, accounts_dimensions_id?, ...}]"),
  }, { ...create, title: "Create Journal" }, async (params) => {
    const postings = parsePostings(params.postings);
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
        postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount, accounts_dimensions_id: p.accounts_dimensions_id })),
      },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "update_journal", "Update a journal entry", {
    id: coerceId.describe("Journal ID"),
    data: z.string().describe("JSON object with fields to update"),
  }, { ...mutate, title: "Update Journal" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
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

  registerTool(server, "list_transactions", "List bank transactions. Paginated.", pageParam.shape, { ...readOnly, title: "List Transactions" }, async (params) => {
    const result = await api.transactions.list(params);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
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

  registerTool(server, "confirm_transaction", "Confirm a bank transaction by providing distribution rows", {
    id: coerceId.describe("Transaction ID"),
    distributions: z.string().optional().describe("JSON array of distribution rows: [{related_table, related_id?, amount}]"),
  }, { ...destructive, title: "Confirm Transaction" }, async ({ id, distributions }) => {
    const dist = distributions ? parseTransactionDistributions(distributions) : undefined;
    const result = await api.transactions.confirm(id, dist);
    logAudit({
      tool: "confirm_transaction", action: "CONFIRMED", entity_type: "transaction", entity_id: id,
      summary: `Confirmed transaction ${id}`,
      details: { distributions: dist?.map(d => ({ related_table: d.related_table, related_id: d.related_id, amount: d.amount })) },
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

  // =====================
  // SALE INVOICES
  // =====================

  registerTool(server, "list_sale_invoices", "List sales invoices. Paginated.", pageParam.shape, { ...readOnly, title: "List Sale Invoices" }, async (params) => {
    const result = await api.saleInvoices.list(params);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
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
    items: z.string().describe("JSON array of invoice items: [{products_id, custom_title, amount, unit_net_price, ...}]"),
    notes: z.string().optional().describe("Internal notes"),
  }, { ...create, title: "Create Sale Invoice" }, async (params) => {
    const items = parseSaleInvoiceItems(params.items);
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

  registerTool(server, "update_sale_invoice", "Update a sales invoice", {
    id: coerceId.describe("Invoice ID"),
    data: z.string().describe("JSON with fields to update"),
  }, { ...mutate, title: "Update Sale Invoice" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
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

  registerTool(server, "confirm_sale_invoice", "Confirm a sales invoice. IRREVERSIBLE — locks the invoice for editing.", idParam.shape, { ...destructive, title: "Confirm Sale Invoice" }, async ({ id }) => {
    const result = await api.saleInvoices.confirm(id);
    logAudit({
      tool: "confirm_sale_invoice", action: "CONFIRMED", entity_type: "sale_invoice", entity_id: id,
      summary: `Confirmed sale invoice ${id}`,
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

  registerTool(server, "list_purchase_invoices", "List purchase invoices. Paginated.", pageParam.shape, { ...readOnly, title: "List Purchase Invoices" }, async (params) => {
    const result = await api.purchaseInvoices.list(params);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
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
      vat_price: z.number().optional().describe("Total VAT amount from original invoice (EXACT, for payment matching)"),
      gross_price: z.number().optional().describe("Total gross amount from original invoice (EXACT, for payment matching)"),
      cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
      liability_accounts_id: z.number().optional().describe("Liability account (default 2310)"),
      items: z.string().describe("JSON array of items: [{custom_title, cl_purchase_articles_id, purchase_accounts_id, purchase_accounts_dimensions_id?, total_net_price, amount, vat_rate_dropdown?, vat_accounts_id?, ...}]. purchase_accounts_dimensions_id is REQUIRED when the expense account has dimensions (sub-accounts)."),
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
        return toolError({ error: "Account dimension validation failed", details: dimErrors });
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

  registerTool(server, "update_purchase_invoice", "Update a purchase invoice", {
    id: coerceId.describe("Invoice ID"),
    data: z.string().describe("JSON with fields to update"),
  }, { ...mutate, title: "Update Purchase Invoice" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
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

  // =====================
  // REFERENCE DATA (read-only)
  // =====================

  registerTool(server, "list_accounts", "Get chart of accounts (kontoplaani kontod)", {}, { ...readOnly, title: "List Accounts" }, async () => {
    const result = await api.readonly.getAccounts();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "list_account_dimensions", "Get account dimensions (alamkontod)", {}, { ...readOnly, title: "List Account Dimensions" }, async () => {
    const result = await api.readonly.getAccountDimensions();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "list_currencies", "Get available currencies", {}, { ...readOnly, title: "List Currencies" }, async () => {
    const result = await api.readonly.getCurrencies();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "list_sale_articles", "Get sales articles (müügiartiklid)", {}, { ...readOnly, title: "List Sale Articles" }, async () => {
    const result = await api.readonly.getSaleArticles();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "list_purchase_articles", "Get purchase articles (ostuartiklid)", {}, { ...readOnly, title: "List Purchase Articles" }, async () => {
    const result = await api.readonly.getPurchaseArticles();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "list_templates", "Get sales invoice templates", {}, { ...readOnly, title: "List Invoice Templates" }, async () => {
    const result = await api.readonly.getTemplates();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "list_projects", "Get cost/profit centers (projektid)", {}, { ...readOnly, title: "List Projects" }, async () => {
    const result = await api.readonly.getProjects();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "get_invoice_info", "Get company invoice settings", {}, { ...readOnly, title: "Get Invoice Settings" }, async () => {
    const result = await api.readonly.getInvoiceInfo();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "get_vat_info", "Get company VAT information (KMKR)", {}, { ...readOnly, title: "Get VAT Info" }, async () => {
    const result = await api.readonly.getVatInfo();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  // Invoice series CRUD
  registerTool(server, "list_invoice_series", "Get invoice numbering series", {}, { ...readOnly, title: "List Invoice Series" }, async () => {
    const result = await api.readonly.getInvoiceSeries();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_invoice_series", "Create an invoice series", {
    number_prefix: z.string().describe("Invoice number prefix"),
    number_start_value: z.number().describe("Starting number"),
    term_days: z.number().describe("Default payment term"),
    is_active: z.boolean().describe("Is active"),
    is_default: z.boolean().describe("Is default series"),
    overdue_charge: z.number().optional().describe("Delinquency charge per day"),
  }, { ...create, title: "Create Invoice Series" }, async (params) => {
    const result = await api.readonly.createInvoiceSeries(params);
    logAudit({
      tool: "create_invoice_series", action: "CREATED", entity_type: "invoice_series",
      entity_id: result.created_object_id,
      summary: `Created invoice series "${params.number_prefix}"`,
      details: { number_prefix: params.number_prefix, number_start_value: params.number_start_value },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  // Bank accounts CRUD
  registerTool(server, "list_bank_accounts", "Get company bank accounts", {}, { ...readOnly, title: "List Bank Accounts" }, async () => {
    const result = await api.readonly.getBankAccounts();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_bank_account", "Create a bank account", {
    account_name_est: z.string().describe("Account name"),
    account_no: z.string().describe("Account number (IBAN)"),
    cl_banks_id: z.number().optional().describe("Bank ID"),
    swift_code: z.string().optional().describe("SWIFT/BIC code"),
    show_in_sale_invoices: z.boolean().optional().describe("Show on invoices"),
  }, { ...create, title: "Create Bank Account" }, async (params) => {
    const result = await api.readonly.createBankAccount(params);
    logAudit({
      tool: "create_bank_account", action: "CREATED", entity_type: "bank_account",
      entity_id: result.created_object_id,
      summary: `Created bank account "${params.account_name_est}" (${params.account_no})`,
      details: { account_name: params.account_name_est, account_no: params.account_no },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });
}
