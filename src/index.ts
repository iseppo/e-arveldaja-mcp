import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { HttpClient } from "./http-client.js";
import { ClientsApi } from "./api/clients.api.js";
import { ProductsApi } from "./api/products.api.js";
import { JournalsApi } from "./api/journals.api.js";
import { TransactionsApi } from "./api/transactions.api.js";
import { SaleInvoicesApi } from "./api/sale-invoices.api.js";
import { PurchaseInvoicesApi } from "./api/purchase-invoices.api.js";
import { ReadonlyApi } from "./api/readonly.api.js";
import { registerCrudTools, type ApiContext } from "./tools/crud-tools.js";
import { registerAccountBalanceTools } from "./tools/account-balance.js";
import { registerPdfWorkflowTools } from "./tools/pdf-workflow.js";
import { registerBankReconciliationTools } from "./tools/bank-reconciliation.js";
import { registerFinancialStatementTools } from "./tools/financial-statements.js";
import { registerVatReportTools } from "./tools/vat-reports.js";
import { registerAgingTools } from "./tools/aging-analysis.js";
import { registerRecurringInvoiceTools } from "./tools/recurring-invoices.js";
import { registerEstonianTaxTools } from "./tools/estonian-tax.js";
import { registerDocumentAuditTools } from "./tools/document-audit.js";
import { registerLightyearTools } from "./tools/lightyear-investments.js";
import { registerResources } from "./resources/static-resources.js";

async function main() {
  const config = loadConfig();
  const httpClient = new HttpClient(config);

  const api: ApiContext = {
    clients: new ClientsApi(httpClient),
    products: new ProductsApi(httpClient),
    journals: new JournalsApi(httpClient),
    transactions: new TransactionsApi(httpClient),
    saleInvoices: new SaleInvoicesApi(httpClient),
    purchaseInvoices: new PurchaseInvoicesApi(httpClient),
    readonly: new ReadonlyApi(httpClient),
  };

  const server = new McpServer({
    name: "e-arveldaja",
    version: "1.0.0",
    description: "MCP server for Estonian e-arveldaja (e-Financials) API. " +
      "Provides full CRUD for clients, products, journals, transactions, " +
      "sale/purchase invoices. Includes account balance computation (D/C logic), " +
      "PDF invoice extraction, supplier resolution with business registry lookup, " +
      "and smart booking suggestions based on past invoices.",
  });

  // Register all tools
  registerCrudTools(server, api);
  registerAccountBalanceTools(server, api);
  registerPdfWorkflowTools(server, api);
  registerBankReconciliationTools(server, api);
  registerFinancialStatementTools(server, api);
  registerVatReportTools(server, api);
  registerAgingTools(server, api);
  registerRecurringInvoiceTools(server, api);
  registerEstonianTaxTools(server, api);
  registerDocumentAuditTools(server, api);
  registerLightyearTools(server, api);

  // Register resources
  registerResources(server, api);

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("e-arveldaja MCP server started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
