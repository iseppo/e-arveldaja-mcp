#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
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
import { registerWiseImportTools } from "./tools/wise-import.js";
import { registerResources } from "./resources/static-resources.js";

interface ConnectionState {
  activeIndex: number;
  generation: number;
}

interface ConnectionSnapshot {
  index: number;
  generation: number;
}

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

function captureSnapshot(state: ConnectionState): ConnectionSnapshot {
  return {
    index: state.activeIndex,
    generation: state.generation,
  };
}

function assertSnapshotCurrent(state: ConnectionState, snapshot: ConnectionSnapshot): void {
  if (snapshot.generation !== state.generation) {
    throw new Error("Active connection changed during tool execution. Retry the tool on the intended connection.");
  }
}

function clearAllCaches(connectionIndex: number): void {
  const connectionPrefix = `connection:${connectionIndex}:`;
  cache.invalidate(connectionPrefix);
  readonlyCache.invalidate(connectionPrefix);
}

function createScopedApiContext(
  state: ConnectionState,
  contexts: ApiContext[],
  invocationStorage: AsyncLocalStorage<ConnectionSnapshot>,
): ApiContext {
  const api = {} as ApiContext;
  const keys: Array<keyof ApiContext> = [
    "clients",
    "products",
    "journals",
    "transactions",
    "saleInvoices",
    "purchaseInvoices",
    "readonly",
  ];

  for (const key of keys) {
    Object.defineProperty(api, key, {
      enumerable: true,
      configurable: false,
      get() {
        const snapshot = invocationStorage.getStore();
        if (snapshot) {
          assertSnapshotCurrent(state, snapshot);
          return contexts[snapshot.index]![key];
        }
        return contexts[state.activeIndex]![key];
      },
    });
  }

  return api;
}

async function main() {
  const allConfigs = loadAllConfigs();
  const connectionState: ConnectionState = { activeIndex: 0, generation: 0 };
  const invocationStorage = new AsyncLocalStorage<ConnectionSnapshot>();
  const connectionContexts = allConfigs.map((namedConfig, index) =>
    buildApiContext(new HttpClient(namedConfig.config, `connection:${index}`))
  );
  const api = createScopedApiContext(connectionState, connectionContexts, invocationStorage);

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
        active: i === connectionState.activeIndex,
        server: nc.config.baseUrl.includes("demo") ? "demo" : "live",
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            connections,
            active: connectionState.activeIndex,
            total: allConfigs.length,
            hint: "Use switch_connection with the index to switch between accounts.",
          }, null, 2),
        }],
      };
    }
  );

  server.tool("switch_connection",
    "Switch to a different e-arveldaja connection (company). " +
    "Clears cached data atomically. Use list_connections to see available indices. " +
    "In-flight tool calls will fail fast and should be retried on the intended connection.",
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

      if (index === connectionState.activeIndex) {
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
      const previousIndex = connectionState.activeIndex;

      clearAllCaches(previousIndex);
      connectionState.activeIndex = index;
      connectionState.generation += 1;

      const snapshot = captureSnapshot(connectionState);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            message: `Switched to "${target.name}"`,
            server: target.config.baseUrl.includes("demo") ? "demo" : "live",
            generation: snapshot.generation,
            note: "Caches cleared atomically. New tool calls use the new connection; in-flight calls must be retried.",
          }, null, 2),
        }],
      };
    }
  );

  const originalTool = server.tool.bind(server) as any;
  const wrapToolHandler = (handler: unknown) => {
    if (typeof handler !== "function") {
      return handler;
    }

    return async (...handlerArgs: unknown[]) => {
      const snapshot = captureSnapshot(connectionState);
      return invocationStorage.run(snapshot, async () => {
        const result = await (handler as (...args: unknown[]) => Promise<unknown> | unknown)(...handlerArgs);
        assertSnapshotCurrent(connectionState, snapshot);
        return result;
      });
    };
  };

  (server as McpServer & { tool: typeof server.tool }).tool = ((...toolArgs: unknown[]) => {
    if (toolArgs.length === 4) {
      const [name, descriptionOrParamsSchema, paramsSchemaOrAnnotations, handler] = toolArgs;
      return originalTool(
        name,
        descriptionOrParamsSchema,
        paramsSchemaOrAnnotations,
        wrapToolHandler(handler),
      );
    }

    if (toolArgs.length === 3) {
      const [name, descriptionOrParamsSchema, handler] = toolArgs;
      return originalTool(
        name,
        descriptionOrParamsSchema,
        wrapToolHandler(handler),
      );
    }

    if (toolArgs.length === 5) {
      const [name, description, paramsSchema, annotations, handler] = toolArgs;
      return originalTool(
        name,
        description,
        paramsSchema,
        annotations,
        wrapToolHandler(handler),
      );
    }

    if (toolArgs.length === 2) {
      const [name, handler] = toolArgs;
      return originalTool(
        name,
        wrapToolHandler(handler),
      );
    }

    return originalTool(...toolArgs);
  }) as typeof server.tool;

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
  registerWiseImportTools(server, api);

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
