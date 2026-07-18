import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { create, readOnly, mutate, destructive } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { desandboxAllStrings } from "../external-text-renderer.js";
import { toolError } from "../tool-error.js";
import { toolResponse } from "../tool-response.js";
import { coerceId } from "./crud/shared.js";
import type { ApiContext } from "./crud-tools.js";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";

/** Drop keys whose value is undefined, leaving only the fields the caller set. */
function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function registerReferenceDataTools(
  server: McpServer,
  api: ApiContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): void {
  // Config-mutation reference-admin tools (create/update/delete bank accounts &
  // invoice series, update_invoice_info, single-record get_*) are gated behind
  // `enableReferenceAdmin`. The list_*/get_invoice_info/get_vat_info reads below
  // are always registered so the agent can still inspect the configuration.
  const exposeReferenceAdmin = exposure.enableReferenceAdmin;

  registerTool(server, "list_accounts", "Get chart of accounts (kontoplaani kontod)", {}, { ...readOnly, title: "List Accounts" }, async () => {
    const result = await api.readonly.getAccounts();
    const compact = result.map(a => ({
      id: a.id,
      balance_type: a.balance_type,
      account_type_est: a.account_type_est,
      name_est: a.name_est,
      name_eng: a.name_eng,
      is_valid: a.is_valid,
      allows_dimensions: a.allows_dimensions,
      is_vat_account: a.is_vat_account,
      is_fixed_asset: a.is_fixed_asset,
      transaction_in_bindable: a.transaction_in_bindable,
      transaction_out_bindable: a.transaction_out_bindable,
      cl_account_groups: a.cl_account_groups,
    }));
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
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

  if (exposeReferenceAdmin) registerTool(server, "update_invoice_info", "Update company invoice settings (contact details, default template, invoice/balance email text, footer). Pass only the fields to change.", {
    address: z.string().optional().describe("Company address shown on invoices"),
    email: z.string().optional().describe("Contact email"),
    phone: z.string().optional().describe("Contact phone"),
    fax: z.string().optional().describe("Contact fax"),
    webpage: z.string().optional().describe("Company web page"),
    cl_templates_id: z.number().optional().describe("Default sale-invoice template ID"),
    invoice_company_name: z.string().nullable().optional().describe("Company name shown on invoices (pass null to clear)"),
    invoice_email_subject: z.string().optional().describe("Default subject for invoice emails"),
    invoice_email_body: z.string().optional().describe("Default body for invoice emails"),
    balance_email_subject: z.string().optional().describe("Default subject for balance-reminder emails"),
    balance_email_body: z.string().optional().describe("Default body for balance-reminder emails"),
    balance_document_footer: z.string().optional().describe("Footer text on balance documents"),
  }, { ...mutate, title: "Update Invoice Settings" }, async (fields) => {
    // Strip sandbox markers off every field before persisting: an LLM could
    // compose email subject/body/footer text from a wrapped read.
    const patch = desandboxAllStrings(pruneUndefined(fields));
    if (Object.keys(patch).length === 0) {
      return toolError({ error: "Provide at least one invoice-settings field to update." });
    }
    const result = await api.readonly.updateInvoiceInfo(patch);
    logAudit({
      tool: "update_invoice_info", action: "UPDATED", entity_type: "invoice_info",
      summary: "Updated company invoice settings",
      details: { fields: Object.keys(patch) },
    });
    return toolResponse({
      action: "updated",
      entity: "invoice_info",
      message: "Updated company invoice settings.",
      raw: result,
    });
  });

  registerTool(server, "get_vat_info", "Get company VAT information (KMKR)", {}, { ...readOnly, title: "Get VAT Info" }, async () => {
    const result = await api.readonly.getVatInfo();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "list_invoice_series", "Get invoice numbering series", {}, { ...readOnly, title: "List Invoice Series" }, async () => {
    const result = await api.readonly.getInvoiceSeries();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  if (exposeReferenceAdmin) registerTool(server, "get_invoice_series", "Get a single invoice numbering series by ID", {
    id: coerceId.describe("Invoice series ID"),
  }, { ...readOnly, title: "Get Invoice Series" }, async ({ id }) => {
    const result = await api.readonly.getInvoiceSeriesOne(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  if (exposeReferenceAdmin) registerTool(server, "create_invoice_series", "Create an invoice series", {
    number_prefix: z.string().describe("Invoice number prefix"),
    number_start_value: z.number().describe("Starting number"),
    term_days: z.number().describe("Default payment term"),
    is_active: z.boolean().describe("Is active"),
    is_default: z.boolean().describe("Is default series"),
    overdue_charge: z.number().optional().describe("Delinquency charge per day"),
  }, { ...create, title: "Create Invoice Series" }, async (rawParams) => {
    const params = desandboxAllStrings(rawParams);
    const result = await api.readonly.createInvoiceSeries(params);
    logAudit({
      tool: "create_invoice_series", action: "CREATED", entity_type: "invoice_series",
      entity_id: result.created_object_id,
      summary: `Created invoice series "${params.number_prefix}"`,
      details: { number_prefix: params.number_prefix, number_start_value: params.number_start_value },
    });
    return toolResponse({
      action: "created",
      entity: "invoice_series",
      id: result.created_object_id,
      message: `Created invoice series "${params.number_prefix}".`,
      raw: result,
    });
  });

  if (exposeReferenceAdmin) registerTool(server, "update_invoice_series", "Update an invoice numbering series (fix the prefix, start value, payment term, overdue charge, or the active/default flags). Pass only the fields to change.", {
    id: coerceId.describe("Invoice series ID"),
    number_prefix: z.string().optional().describe("Invoice number prefix"),
    number_start_value: z.number().optional().describe("Starting number"),
    term_days: z.number().optional().describe("Default payment term (days)"),
    is_active: z.boolean().optional().describe("Is active"),
    is_default: z.boolean().optional().describe("Is the default series"),
    overdue_charge: z.number().optional().describe("Delinquency charge per day"),
  }, { ...mutate, title: "Update Invoice Series" }, async ({ id, ...fields }) => {
    const patch = desandboxAllStrings(pruneUndefined(fields));
    if (Object.keys(patch).length === 0) {
      return toolError({ error: "Provide at least one invoice-series field to update." });
    }
    const result = await api.readonly.updateInvoiceSeries(id, patch);
    logAudit({
      tool: "update_invoice_series", action: "UPDATED", entity_type: "invoice_series",
      entity_id: id,
      summary: `Updated invoice series ${id}`,
      details: { fields: Object.keys(patch) },
    });
    return toolResponse({
      action: "updated",
      entity: "invoice_series",
      id,
      message: `Updated invoice series ${id}.`,
      raw: result,
    });
  });

  if (exposeReferenceAdmin) registerTool(server, "delete_invoice_series", "Delete an invoice numbering series. Fails if the series is already in use.", {
    id: coerceId.describe("Invoice series ID"),
  }, { ...destructive, title: "Delete Invoice Series" }, async ({ id }) => {
    const result = await api.readonly.deleteInvoiceSeries(id);
    logAudit({
      tool: "delete_invoice_series", action: "DELETED", entity_type: "invoice_series",
      entity_id: id,
      summary: `Deleted invoice series ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "invoice_series",
      id,
      message: `Deleted invoice series ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "list_bank_accounts", "Get company bank accounts", {}, { ...readOnly, title: "List Bank Accounts" }, async () => {
    const result = await api.readonly.getBankAccounts();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  if (exposeReferenceAdmin) registerTool(server, "get_bank_account", "Get a single company bank account by ID", {
    id: coerceId.describe("Bank account ID"),
  }, { ...readOnly, title: "Get Bank Account" }, async ({ id }) => {
    const result = await api.readonly.getBankAccount(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  if (exposeReferenceAdmin) registerTool(server, "create_bank_account", "Create a bank account", {
    account_name_est: z.string().describe("Account name"),
    account_no: z.string().describe("Account number (IBAN)"),
    cl_banks_id: z.number().optional().describe("Bank ID"),
    swift_code: z.string().optional().describe("SWIFT/BIC code"),
    show_in_sale_invoices: z.boolean().optional().describe("Show on invoices"),
  }, { ...create, title: "Create Bank Account" }, async (rawParams) => {
    const params = desandboxAllStrings(rawParams);
    const result = await api.readonly.createBankAccount(params);
    logAudit({
      tool: "create_bank_account", action: "CREATED", entity_type: "bank_account",
      entity_id: result.created_object_id,
      summary: `Created bank account "${params.account_name_est}" (${params.account_no})`,
      details: { account_name: params.account_name_est, account_no: params.account_no },
    });
    return toolResponse({
      action: "created",
      entity: "bank_account",
      id: result.created_object_id,
      message: `Created bank account "${params.account_name_est}" (${params.account_no}).`,
      raw: result,
    });
  });

  if (exposeReferenceAdmin) registerTool(server, "update_bank_account", "Update a company bank account (rename it, fix the account number/SWIFT/bank, or toggle whether it shows on sale invoices). Pass only the fields to change.", {
    id: coerceId.describe("Bank account ID"),
    account_name_est: z.string().optional().describe("Account name"),
    account_no: z.string().optional().describe("Account number (IBAN)"),
    cl_banks_id: z.number().optional().describe("Bank ID"),
    swift_code: z.string().optional().describe("SWIFT/BIC code"),
    show_in_sale_invoices: z.boolean().optional().describe("Show on invoices"),
  }, { ...mutate, title: "Update Bank Account" }, async ({ id, ...fields }) => {
    const patch = desandboxAllStrings(pruneUndefined(fields));
    if (Object.keys(patch).length === 0) {
      return toolError({ error: "Provide at least one bank-account field to update." });
    }
    const result = await api.readonly.updateBankAccount(id, patch);
    logAudit({
      tool: "update_bank_account", action: "UPDATED", entity_type: "bank_account",
      entity_id: id,
      summary: `Updated bank account ${id}`,
      details: { fields: Object.keys(patch) },
    });
    return toolResponse({
      action: "updated",
      entity: "bank_account",
      id,
      message: `Updated bank account ${id}.`,
      raw: result,
    });
  });

  if (exposeReferenceAdmin) registerTool(server, "delete_bank_account", "Delete a company bank account. Fails if the account is referenced by existing transactions.", {
    id: coerceId.describe("Bank account ID"),
  }, { ...destructive, title: "Delete Bank Account" }, async ({ id }) => {
    const result = await api.readonly.deleteBankAccount(id);
    logAudit({
      tool: "delete_bank_account", action: "DELETED", entity_type: "bank_account",
      entity_id: id,
      summary: `Deleted bank account ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "bank_account",
      id,
      message: `Deleted bank account ${id}.`,
      raw: result,
    });
  });
}
