import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAllConfigs, type NamedConfig } from "./config.js";
import { HttpClient } from "./http-client.js";
import { ClientsApi } from "./api/clients.api.js";
import { ProductsApi } from "./api/products.api.js";
import { JournalsApi } from "./api/journals.api.js";
import { TransactionsApi } from "./api/transactions.api.js";
import { SaleInvoicesApi } from "./api/sale-invoices.api.js";
import { PurchaseInvoicesApi } from "./api/purchase-invoices.api.js";
import { ReadonlyApi, readonlyCache } from "./api/readonly.api.js";
import { cache } from "./api/base-resource.js";
import { registerCrudTools, type ApiContext } from "./tools/crud-tools.js";
import { registerAccountBalanceTools } from "./tools/account-balance.js";
import { registerPdfWorkflowTools } from "./tools/pdf-workflow.js";
import { registerBankReconciliationTools } from "./tools/bank-reconciliation.js";
import { registerFinancialStatementTools } from "./tools/financial-statements.js";
import { registerAgingTools } from "./tools/aging-analysis.js";
import { registerRecurringInvoiceTools } from "./tools/recurring-invoices.js";
import { registerEstonianTaxTools } from "./tools/estonian-tax.js";
import { registerDocumentAuditTools } from "./tools/document-audit.js";
import { registerLightyearTools } from "./tools/lightyear-investments.js";
import { registerResources } from "./resources/static-resources.js";

function buildApiContext(httpClient: HttpClient): ApiContext {
  return {
    clients: new ClientsApi(httpClient),
    products: new ProductsApi(httpClient),
    journals: new JournalsApi(httpClient),
    transactions: new TransactionsApi(httpClient),
    saleInvoices: new SaleInvoicesApi(httpClient),
    purchaseInvoices: new PurchaseInvoicesApi(httpClient),
    readonly: new ReadonlyApi(httpClient),
  };
}

function switchApi(api: ApiContext, newApi: ApiContext): void {
  api.clients = newApi.clients;
  api.products = newApi.products;
  api.journals = newApi.journals;
  api.transactions = newApi.transactions;
  api.saleInvoices = newApi.saleInvoices;
  api.purchaseInvoices = newApi.purchaseInvoices;
  api.readonly = newApi.readonly;
}

async function main() {
  const allConfigs = loadAllConfigs();
  let activeIndex = 0;

  const httpClient = new HttpClient(allConfigs[0]!.config);
  const api: ApiContext = buildApiContext(httpClient);

  const server = new McpServer({
    name: "e-arveldaja",
    version: "1.0.0",
    description: "EXPERIMENTAL, UNOFFICIAL MCP server for the Estonian e-arveldaja (e-Financials) API. " +
      "NOT affiliated with or endorsed by RIK. Use entirely at your own risk — " +
      "this software interacts with live financial data and can create, modify, and delete accounting records. " +
      "Provides CRUD for clients, products, journals, transactions, " +
      "sale/purchase invoices. Includes account balance computation (D/C logic), " +
      "PDF invoice extraction, supplier resolution with business registry lookup, " +
      "and smart booking suggestions based on past invoices.",
  });

  // --- Multi-account tools ---

  server.tool("list_connections",
    "List all available e-arveldaja connections (API key files). " +
    "Shows which connection is currently active.",
    {},
    async () => {
      const connections = allConfigs.map((nc: NamedConfig, i: number) => ({
        index: i,
        name: nc.name,
        active: i === activeIndex,
        server: nc.config.baseUrl.includes("demo") ? "demo" : "live",
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            connections,
            active: activeIndex,
            total: allConfigs.length,
            hint: "Use switch_connection with the index to switch between accounts.",
          }, null, 2),
        }],
      };
    }
  );

  server.tool("switch_connection",
    "Switch to a different e-arveldaja connection (company). " +
    "Clears all cached data. Use list_connections to see available indices. " +
    "WARNING: Do not switch while another tool call is in progress.",
    {
      index: z.number().describe("Connection index from list_connections"),
    },
    async ({ index }) => {
      if (index < 0 || index >= allConfigs.length) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Invalid index ${index}. Valid range: 0-${allConfigs.length - 1}`,
            }),
          }],
        };
      }

      if (index === activeIndex) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: `Already connected to "${allConfigs[index]!.name}"`,
            }),
          }],
        };
      }

      const target = allConfigs[index]!;

      // Clear all cached data from previous connection
      cache.invalidate();
      readonlyCache.invalidate();

      // Build new API context and swap into the shared object
      const newHttpClient = new HttpClient(target.config);
      const newApi = buildApiContext(newHttpClient);
      switchApi(api, newApi);
      activeIndex = index;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            message: `Switched to "${target.name}"`,
            server: target.config.baseUrl.includes("demo") ? "demo" : "live",
            note: "Cache cleared. All tools now use the new connection.",
          }, null, 2),
        }],
      };
    }
  );

  // Register all tools
  registerCrudTools(server, api);
  registerAccountBalanceTools(server, api);
  registerPdfWorkflowTools(server, api);
  registerBankReconciliationTools(server, api);
  registerFinancialStatementTools(server, api);
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

  const names = allConfigs.map(c => c.name).join(", ");
  console.error(`e-arveldaja MCP server started (${allConfigs.length} connection(s): ${names})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
