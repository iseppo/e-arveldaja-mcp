import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../../accounting-defaults.js";
import { applyListView, viewParam } from "../../list-views.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "../purchase-vat-defaults.js";
import { validateItemDimensions } from "../../account-validation.js";
import type { CreatePurchaseInvoiceData } from "../../types/api.js";
import type { ApiContext } from "./shared.js";
import {
  coerceId,
  idParam,
  isoDateString,
  isCompanyVatRegistered,
  jsonObjectArrayInput,
  jsonObjectInput,
  pageParam,
  parseJsonObject,
  parsePurchaseInvoiceItems,
  tagNotes,
  validateUpdateFields,
} from "./shared.js";

export function registerPurchaseInvoiceTools(server: McpServer, api: ApiContext): void {
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
    "Create a draft purchase invoice with line items. Requires cl_purchase_articles_id (use list_purchase_articles). Pass EXACT vat_price and gross_price from the original invoice. " +
    "For non-EUR invoices pass cl_currencies_id and currency_rate (EUR per 1 foreign unit). " +
    "Optionally pass base_net_price/base_vat_price/base_gross_price to lock the EUR settlement values to the actual payment (e.g. Wise card-payment exchange) and avoid PARTIALLY_PAID rounding.",
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
      currency_rate: z.number().positive().optional().describe("Exchange rate as EUR per 1 foreign currency unit. Required when cl_currencies_id != EUR. For Wise card payments use Source amount (after fees) / Target amount."),
      base_net_price: z.number().optional().describe("EUR equivalent of net_price (foreign-currency invoices). Auto-derived from currency_rate when omitted."),
      base_vat_price: z.number().optional().describe("EUR equivalent of vat_price (foreign-currency invoices). Auto-derived from currency_rate when omitted."),
      base_gross_price: z.number().optional().describe("EUR equivalent of gross_price (foreign-currency invoices). Pass the actual settled EUR amount (Wise Source amount after fees) to avoid PARTIALLY_PAID jääk. Auto-derived from currency_rate when omitted."),
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

      const currencyCode = (params.cl_currencies_id ?? "EUR").toUpperCase();
      if (currencyCode !== "EUR" && (params.currency_rate === undefined || params.currency_rate === null)) {
        return toolError({
          error: `currency_rate is required when cl_currencies_id="${currencyCode}". Pass EUR per 1 ${currencyCode} (Wise: Source amount / Target amount).`,
        });
      }

      const invoiceData: CreatePurchaseInvoiceData = {
        clients_id: params.clients_id,
        client_name: params.client_name,
        number: params.number,
        create_date: params.create_date,
        journal_date: params.journal_date,
        term_days: params.term_days,
        cl_currencies_id: currencyCode,
        currency_rate: params.currency_rate,
        base_net_price: params.base_net_price,
        base_vat_price: params.base_vat_price,
        base_gross_price: params.base_gross_price,
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
}
