import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { create, readOnly } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import type { ApiContext } from "./crud-tools.js";

export function registerReferenceDataTools(server: McpServer, api: ApiContext): void {
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

  registerTool(server, "get_vat_info", "Get company VAT information (KMKR)", {}, { ...readOnly, title: "Get VAT Info" }, async () => {
    const result = await api.readonly.getVatInfo();
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

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
