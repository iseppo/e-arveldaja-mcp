import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { toolResponse } from "../../tool-response.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../../accounting-defaults.js";
import { applyListView, viewParam } from "../../list-views.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "../purchase-vat-defaults.js";
import { validateItemDimensions } from "../../account-validation.js";
import type { CreatePurchaseInvoiceData } from "../../types/api.js";
import type { ApiContext } from "./shared.js";
import {
  coerceId,
  idParam,
  invoiceListFilterParams,
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
    "List purchase invoices. Paginated, with server-side filters (date range, status, payment status, supplier) applied by the API. Brief view by default; use view='full' or get_purchase_invoice for detail.",
    { ...pageParam.shape, ...viewParam, ...invoiceListFilterParams({ dateLabel: "invoice date", clientLabel: "supplier" }) },
    { ...readOnly, title: "List Purchase Invoices" }, async ({ view, date_from, date_to, ...listParams }) => {
    // Public params are canonical date_from/date_to; the API expects start_date/end_date.
    const result = await api.purchaseInvoices.list({
      ...listParams,
      ...(date_from !== undefined && { start_date: date_from }),
      ...(date_to !== undefined && { end_date: date_to }),
    });
    const compact = { ...result, items: applyListView("purchase_invoice", result.items, view) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_purchase_invoice", "Get a purchase invoice by ID", idParam.shape, { ...readOnly, title: "Get Purchase Invoice" }, async ({ id }) => {
    const result = await api.purchaseInvoices.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_purchase_invoice",
    "Create a draft purchase invoice. Direct-call contract: pass exact invoice vat_price/gross_price; non-EUR requires cl_currencies_id + currency_rate (EUR per 1 foreign unit); base_* may lock actual EUR settlement.",
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
      currency_rate: z.number().positive().optional().describe("Exchange rate as EUR per 1 foreign currency unit. Required when cl_currencies_id != EUR."),
      base_net_price: z.number().optional().describe("EUR equivalent of net_price; auto-derived from currency_rate when omitted."),
      base_vat_price: z.number().optional().describe("EUR equivalent of vat_price; auto-derived from currency_rate when omitted."),
      base_gross_price: z.number().optional().describe("Actual settled EUR gross total; auto-derived from currency_rate when omitted."),
      liability_accounts_id: z.number().optional().describe("Liability account (default 2310)"),
      items: jsonObjectArrayInput.describe(
        "Items [{custom_title, cl_purchase_articles_id, purchase_accounts_id, purchase_accounts_dimensions_id?, total_net_price, amount, vat_rate_dropdown?, vat_accounts_id?, vat_accounts_dimensions_id?, cl_vat_articles_id?, project_no_vat_gross_price?, cl_fringe_benefits_id?}]. purchase_accounts_dimensions_id is REQUIRED when the expense account has dimensions; same for vat_accounts_dimensions_id on dimensioned VAT accounts."
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
      return toolResponse({
        action: "created",
        entity: "purchase_invoice",
        id: result.id,
        message: `Created purchase invoice "${params.number}" from ${params.client_name}.`,
        raw: result,
      });
    });

  registerTool(server, "update_purchase_invoice", "Update draft purchase-invoice fields. Server-managed fields are rejected; confirmed invoice dates require invalidate_purchase_invoice first.", {
    id: coerceId.describe("Invoice ID"),
    data: jsonObjectInput.describe("Object with fields to update."),
  }, { ...mutate, title: "Update Purchase Invoice" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const current = await api.purchaseInvoices.get(id);
    const isConfirmed = current.status === "CONFIRMED";
    const updateErrors = validateUpdateFields(parsed, "purchase_invoice", { isConfirmed });
    if (updateErrors.length > 0) {
      if (isConfirmed && Object.keys(parsed).length > 0) {
        return toolError({
          category: "confirmed_record_immutable",
          error: "Confirmed purchase_invoice update contains ledger-bearing fields",
          details: updateErrors,
          next_action: "invalidate_purchase_invoice, fetch the draft, update it, then explicitly re-confirm",
        });
      }
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    // The API rejects a metadata-only PATCH with "Products/services are
    // missing" — every update must carry the full item list. When the caller
    // changes header fields (notes, dates, bank refs) and omits items, re-send
    // the existing lines so the update succeeds. Mirrors confirmAndSetTotals,
    // which PATCHes with the fetched invoice.items. A caller that supplies
    // items to change the lines keeps theirs.
    if (parsed.items === undefined && current.items !== undefined) {
      parsed.items = current.items.map(item => ({ ...item }));
    }
    const result = await api.purchaseInvoices.update(id, parsed);
    logAudit({
      tool: "update_purchase_invoice", action: "UPDATED", entity_type: "purchase_invoice", entity_id: id,
      summary: `Updated purchase invoice ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return toolResponse({
      action: "updated",
      entity: "purchase_invoice",
      id,
      message: `Updated purchase invoice ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "delete_purchase_invoice", "Delete a purchase invoice", idParam.shape, { ...destructive, title: "Delete Purchase Invoice" }, async ({ id }) => {
    const result = await api.purchaseInvoices.delete(id);
    logAudit({
      tool: "delete_purchase_invoice", action: "DELETED", entity_type: "purchase_invoice", entity_id: id,
      summary: `Deleted purchase invoice ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "purchase_invoice",
      id,
      message: `Deleted purchase invoice ${id}.`,
      raw: result,
    });
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
      return toolResponse({
        action: "confirmed",
        entity: "purchase_invoice",
        id,
        message: `Confirmed purchase invoice ${id}.`,
        raw: result,
      });
    });

  registerTool(server, "invalidate_purchase_invoice",
    "Return a confirmed purchase invoice to draft status for editing. RPS § 10: corrections must stay traceable — record why and what replaces it.",
    idParam.shape, { ...mutate, title: "Invalidate Purchase Invoice" }, async ({ id }) => {
      const result = await api.purchaseInvoices.invalidate(id);
      logAudit({
        tool: "invalidate_purchase_invoice", action: "INVALIDATED", entity_type: "purchase_invoice", entity_id: id,
        summary: `Invalidated purchase invoice ${id}`,
        details: {},
      });
      return toolResponse({
        action: "invalidated",
        entity: "purchase_invoice",
        id,
        message: `Invalidated purchase invoice ${id}.`,
        raw: result,
      });
    });
}
