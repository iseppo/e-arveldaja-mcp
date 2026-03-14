import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClientsApi } from "../api/clients.api.js";
import type { ProductsApi } from "../api/products.api.js";
import type { JournalsApi } from "../api/journals.api.js";
import type { TransactionsApi } from "../api/transactions.api.js";
import type { SaleInvoicesApi } from "../api/sale-invoices.api.js";
import type { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import type { ReadonlyApi } from "../api/readonly.api.js";
import type { Posting, TransactionDistribution, SaleInvoiceItem, PurchaseInvoiceItem } from "../types/api.js";

export interface ApiContext {
  clients: ClientsApi;
  products: ProductsApi;
  journals: JournalsApi;
  transactions: TransactionsApi;
  saleInvoices: SaleInvoicesApi;
  purchaseInvoices: PurchaseInvoicesApi;
  readonly: ReadonlyApi;
}

const MAX_JSON_INPUT_SIZE = 1024 * 1024; // 1 MB

function safeJsonParse(input: string, label: string): unknown {
  if (input.length > MAX_JSON_INPUT_SIZE) {
    throw new Error(`JSON input for "${label}" exceeds maximum size of ${MAX_JSON_INPUT_SIZE} bytes`);
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
}

const pageParam = z.object({
  page: z.number().optional().describe("Page number (default 1)"),
  modified_since: z.string().optional().describe("Return only objects modified since this timestamp (ISO 8601)"),
});

const idParam = z.object({ id: z.number().describe("Object ID") });

export function registerCrudTools(server: McpServer, api: ApiContext): void {
  // =====================
  // CLIENTS
  // =====================

  server.tool("list_clients", "List all clients (buyers/suppliers). Paginated.", pageParam.shape, async (params) => {
    const result = await api.clients.list(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_client", "Get a single client by ID", idParam.shape, async ({ id }) => {
    const result = await api.clients.get(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_client", "Create a new client (buyer/supplier)", {
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
  }, async (params) => {
    const result = await api.clients.create({
      ...params,
      cl_code_country: params.cl_code_country ?? "EST",
      is_member: false,
      send_invoice_to_email: false,
      send_invoice_to_accounting_email: false,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("update_client", "Update an existing client", {
    id: z.number().describe("Client ID"),
    data: z.string().describe("JSON object with fields to update"),
  }, async ({ id, data }) => {
    const result = await api.clients.update(id, safeJsonParse(data, "data") as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("delete_client", "Soft-delete a client", idParam.shape, async ({ id }) => {
    const result = await api.clients.delete(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("restore_client", "Reactivate a deleted client", idParam.shape, async ({ id }) => {
    const result = await api.clients.restore(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("search_client", "Search clients by name (fuzzy match)", {
    name: z.string().describe("Name to search for"),
  }, async ({ name }) => {
    const results = await api.clients.findByName(name);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("find_client_by_code", "Find client by registry code", {
    code: z.string().describe("Business registry code or personal ID"),
  }, async ({ code }) => {
    const result = await api.clients.findByCode(code);
    return { content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "Not found" }] };
  });

  // =====================
  // PRODUCTS
  // =====================

  server.tool("list_products", "List all products/services. Paginated.", pageParam.shape, async (params) => {
    const result = await api.products.list(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_product", "Get a single product by ID", idParam.shape, async ({ id }) => {
    const result = await api.products.get(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_product", "Create a new product/service", {
    name: z.string().describe("Product name"),
    code: z.string().describe("Product code"),
    cl_sale_articles_id: z.number().optional().describe("Sales article ID"),
    cl_purchase_articles_id: z.number().optional().describe("Purchase article ID"),
    sales_price: z.number().optional().describe("Sales price"),
    unit: z.string().optional().describe("Unit (e.g. tk, h, km)"),
  }, async (params) => {
    const result = await api.products.create(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("update_product", "Update a product", {
    id: z.number().describe("Product ID"),
    data: z.string().describe("JSON object with fields to update"),
  }, async ({ id, data }) => {
    const result = await api.products.update(id, safeJsonParse(data, "data") as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("delete_product", "Soft-delete a product", idParam.shape, async ({ id }) => {
    const result = await api.products.delete(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("restore_product", "Reactivate a deleted product", idParam.shape, async ({ id }) => {
    const result = await api.products.restore(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // =====================
  // JOURNALS
  // =====================

  server.tool("list_journals", "List journal entries. Paginated.", pageParam.shape, async (params) => {
    const result = await api.journals.list(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_journal", "Get a journal entry by ID (includes postings)", idParam.shape, async ({ id }) => {
    const result = await api.journals.get(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_journal", "Create a journal entry with postings", {
    title: z.string().optional().describe("Journal entry title"),
    effective_date: z.string().describe("Entry date (YYYY-MM-DD)"),
    clients_id: z.number().optional().describe("Related client ID"),
    document_number: z.string().optional().describe("Document number"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    postings: z.string().describe("JSON array of postings: [{accounts_id, type: 'D'|'C', amount, accounts_dimensions_id?, ...}]"),
  }, async (params) => {
    const result = await api.journals.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
      postings: safeJsonParse(params.postings, "postings") as Posting[],
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("update_journal", "Update a journal entry", {
    id: z.number().describe("Journal ID"),
    data: z.string().describe("JSON object with fields to update"),
  }, async ({ id, data }) => {
    const result = await api.journals.update(id, safeJsonParse(data, "data") as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("delete_journal", "Delete a journal entry", idParam.shape, async ({ id }) => {
    const result = await api.journals.delete(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("confirm_journal", "Confirm/register a journal entry", idParam.shape, async ({ id }) => {
    const result = await api.journals.confirm(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // =====================
  // TRANSACTIONS
  // =====================

  server.tool("list_transactions", "List bank transactions. Paginated.", pageParam.shape, async (params) => {
    const result = await api.transactions.list(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_transaction", "Get a transaction by ID", idParam.shape, async ({ id }) => {
    const result = await api.transactions.get(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_transaction", "Create a bank transaction", {
    accounts_dimensions_id: z.number().describe("Bank account dimension ID"),
    type: z.string().describe("Transaction type: D (incoming) or C (outgoing)"),
    amount: z.number().describe("Transaction amount"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    date: z.string().describe("Transaction date (YYYY-MM-DD)"),
    description: z.string().optional().describe("Description"),
    clients_id: z.number().optional().describe("Related client ID"),
    bank_account_name: z.string().optional().describe("Remitter/beneficiary name"),
    ref_number: z.string().optional().describe("Reference number"),
  }, async (params) => {
    const result = await api.transactions.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("confirm_transaction", "Confirm a transaction with distribution rows", {
    id: z.number().describe("Transaction ID"),
    distributions: z.string().optional().describe("JSON array of distribution rows: [{related_table, related_id?, amount}]"),
  }, async ({ id, distributions }) => {
    const dist = distributions ? safeJsonParse(distributions, "distributions") as TransactionDistribution[] : undefined;
    const result = await api.transactions.confirm(id, dist);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("delete_transaction", "Delete a transaction", idParam.shape, async ({ id }) => {
    const result = await api.transactions.delete(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // =====================
  // SALE INVOICES
  // =====================

  server.tool("list_sale_invoices", "List sales invoices. Paginated.", pageParam.shape, async (params) => {
    const result = await api.saleInvoices.list(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_sale_invoice", "Get a sales invoice by ID (includes items, deliveries)", idParam.shape, async ({ id }) => {
    const result = await api.saleInvoices.get(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_sale_invoice", "Create a sales invoice", {
    clients_id: z.number().describe("Buyer client ID"),
    cl_templates_id: z.number().describe("Invoice template ID"),
    number_suffix: z.string().describe("Invoice number (suffix)"),
    create_date: z.string().describe("Invoice date (YYYY-MM-DD)"),
    journal_date: z.string().describe("Turnover date (YYYY-MM-DD)"),
    term_days: z.number().describe("Payment term in days"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    cl_countries_id: z.string().optional().describe("Country (default EST)"),
    sale_invoice_type: z.string().optional().describe("Type: INVOICE or CREDIT_INVOICE"),
    show_client_balance: z.boolean().optional().describe("Show client balance on invoice"),
    items: z.string().describe("JSON array of invoice items: [{products_id, custom_title, amount, unit_net_price, ...}]"),
    notes: z.string().optional().describe("Internal notes"),
  }, async (params) => {
    const result = await api.saleInvoices.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
      cl_countries_id: params.cl_countries_id ?? "EST",
      sale_invoice_type: params.sale_invoice_type ?? "INVOICE",
      show_client_balance: params.show_client_balance ?? false,
      items: safeJsonParse(params.items, "items") as SaleInvoiceItem[],
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("update_sale_invoice", "Update a sales invoice", {
    id: z.number().describe("Invoice ID"),
    data: z.string().describe("JSON with fields to update"),
  }, async ({ id, data }) => {
    const result = await api.saleInvoices.update(id, safeJsonParse(data, "data") as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("delete_sale_invoice", "Delete a sales invoice", idParam.shape, async ({ id }) => {
    const result = await api.saleInvoices.delete(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("confirm_sale_invoice", "Confirm a sales invoice", idParam.shape, async ({ id }) => {
    const result = await api.saleInvoices.confirm(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_sale_invoice_delivery_options", "Get delivery options for a sales invoice", idParam.shape, async ({ id }) => {
    const result = await api.saleInvoices.getDeliveryOptions(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("send_sale_invoice", "Send a sales invoice via e-invoice or email", {
    id: z.number().describe("Invoice ID"),
    send_einvoice: z.boolean().optional().describe("Send as e-invoice (machine-readable XML)"),
    send_email: z.boolean().optional().describe("Send as email (PDF)"),
    email_addresses: z.string().optional().describe("Email addresses"),
    email_subject: z.string().optional().describe("Email subject"),
    email_body: z.string().optional().describe("Email body"),
  }, async ({ id, ...request }) => {
    const result = await api.saleInvoices.sendEinvoice(id, request);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_sale_invoice_document", "Download sales invoice PDF (base64)", idParam.shape, async ({ id }) => {
    const result = await api.saleInvoices.getDocument(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // =====================
  // PURCHASE INVOICES
  // =====================

  server.tool("list_purchase_invoices", "List purchase invoices. Paginated.", pageParam.shape, async (params) => {
    const result = await api.purchaseInvoices.list(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_purchase_invoice", "Get a purchase invoice by ID", idParam.shape, async ({ id }) => {
    const result = await api.purchaseInvoices.get(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_purchase_invoice", "Create a purchase invoice", {
    clients_id: z.number().describe("Supplier client ID"),
    client_name: z.string().describe("Supplier name"),
    number: z.string().describe("Invoice number"),
    create_date: z.string().describe("Invoice date (YYYY-MM-DD)"),
    journal_date: z.string().describe("Turnover date (YYYY-MM-DD)"),
    term_days: z.number().describe("Payment term in days"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    liability_accounts_id: z.number().optional().describe("Liability account (default 2310)"),
    gross_price: z.number().optional().describe("Total gross amount"),
    items: z.string().describe("JSON array of items: [{custom_title, cl_purchase_articles_id?, total_net_price?, amount?, ...}]"),
    notes: z.string().optional().describe("Notes"),
  }, async (params) => {
    const result = await api.purchaseInvoices.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
      liability_accounts_id: params.liability_accounts_id ?? 2310,
      items: safeJsonParse(params.items, "items") as PurchaseInvoiceItem[],
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("update_purchase_invoice", "Update a purchase invoice", {
    id: z.number().describe("Invoice ID"),
    data: z.string().describe("JSON with fields to update"),
  }, async ({ id, data }) => {
    const result = await api.purchaseInvoices.update(id, safeJsonParse(data, "data") as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("delete_purchase_invoice", "Delete a purchase invoice", idParam.shape, async ({ id }) => {
    const result = await api.purchaseInvoices.delete(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("confirm_purchase_invoice", "Confirm a purchase invoice", idParam.shape, async ({ id }) => {
    const result = await api.purchaseInvoices.confirm(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // =====================
  // REFERENCE DATA (read-only)
  // =====================

  server.tool("list_accounts", "Get chart of accounts (kontoplaani kontod)", {}, async () => {
    const result = await api.readonly.getAccounts();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("list_account_dimensions", "Get account dimensions (alamkontod)", {}, async () => {
    const result = await api.readonly.getAccountDimensions();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("list_currencies", "Get available currencies", {}, async () => {
    const result = await api.readonly.getCurrencies();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("list_sale_articles", "Get sales articles (müügiartiklid)", {}, async () => {
    const result = await api.readonly.getSaleArticles();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("list_purchase_articles", "Get purchase articles (ostuartiklid)", {}, async () => {
    const result = await api.readonly.getPurchaseArticles();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("list_templates", "Get sales invoice templates", {}, async () => {
    const result = await api.readonly.getTemplates();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("list_projects", "Get cost/profit centers (projektid)", {}, async () => {
    const result = await api.readonly.getProjects();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_invoice_info", "Get company invoice settings", {}, async () => {
    const result = await api.readonly.getInvoiceInfo();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get_vat_info", "Get company VAT information (KMKR)", {}, async () => {
    const result = await api.readonly.getVatInfo();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // Invoice series CRUD
  server.tool("list_invoice_series", "Get invoice numbering series", {}, async () => {
    const result = await api.readonly.getInvoiceSeries();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_invoice_series", "Create an invoice series", {
    number_prefix: z.string().describe("Invoice number prefix"),
    number_start_value: z.number().describe("Starting number"),
    term_days: z.number().describe("Default payment term"),
    is_active: z.boolean().describe("Is active"),
    is_default: z.boolean().describe("Is default series"),
    overdue_charge: z.number().optional().describe("Delinquency charge per day"),
  }, async (params) => {
    const result = await api.readonly.createInvoiceSeries(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // Bank accounts CRUD
  server.tool("list_bank_accounts", "Get company bank accounts", {}, async () => {
    const result = await api.readonly.getBankAccounts();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("create_bank_account", "Create a bank account", {
    account_name_est: z.string().describe("Account name"),
    account_no: z.string().describe("Account number (IBAN)"),
    cl_banks_id: z.number().optional().describe("Bank ID"),
    swift_code: z.string().optional().describe("SWIFT/BIC code"),
    show_in_sale_invoices: z.boolean().optional().describe("Show on invoices"),
  }, async (params) => {
    const result = await api.readonly.createBankAccount(params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
