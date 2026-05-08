import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { readOnly, create, mutate, destructive, send } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { applyListView, viewParam } from "../../list-views.js";
import { validateSaleInvoiceItemDimensions } from "../../account-validation.js";
import type { ApiContext } from "./shared.js";
import {
  coerceId,
  idParam,
  isoDateString,
  jsonObjectArrayInput,
  jsonObjectInput,
  pageParam,
  parseJsonObject,
  parseSaleInvoiceItems,
  tagNotes,
  validateUpdateFields,
} from "./shared.js";

export function registerSaleInvoiceTools(server: McpServer, api: ApiContext): void {
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
}
