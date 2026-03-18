#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAllConfigs, type NamedConfig } from "./config.js";
import { toolExtraStorage } from "./progress.js";
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
import { registerDynamicResources } from "./resources/dynamic-resources.js";
import { registerPrompts } from "./prompts.js";
import { toolError } from "./tool-error.js";
import { setLogger } from "./logger.js";
import { readOnly, mutate } from "./annotations.js";

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
    version: "0.4.0",
    description: "EXPERIMENTAL, UNOFFICIAL MCP server for the Estonian e-arveldaja (e-Financials) API. " +
      "NOT affiliated with or endorsed by RIK. Use entirely at your own risk — " +
      "this software interacts with live financial data and can create, modify, and delete accounting records. " +
      "Provides CRUD for clients, products, journals, transactions, " +
      "sale/purchase invoices. Includes account balance computation (D/C logic), " +
      "PDF invoice extraction, supplier resolution with business registry lookup, " +
      "and smart booking suggestions based on past invoices.",
  }, {
    instructions: `Purchase invoices:
- Before booking, call get_vat_info to check VAT registration status.
- Before creating, call detect_duplicate_purchase_invoice.
- Pass original vat_price and gross_price exactly — do not recalculate.
- Use list_purchase_articles to resolve cl_purchase_articles_id.
- For non-Estonian suppliers, check if reverse charge applies (reversed_vat_id=1).
- PDF flow: extract_pdf_invoice → validate_invoice_data → resolve_supplier → suggest_booking → create_purchase_invoice_from_pdf → upload_invoice_document → confirm_purchase_invoice.

Bank reconciliation:
- Run reconcile_transactions first, then auto_confirm_exact_matches with dry_run before executing.

Reporting:
- Confirm all journals/invoices/transactions first for accurate financial reports.
- list_connections / switch_connection for multi-company; switching clears caches.
- Batch tools default to dry_run — preview before execute=true.
- Amounts are EUR unless cl_currencies_id specifies otherwise.`,
  });

  // --- Multi-account tools ---

  server.tool("list_connections",
    "List all available e-arveldaja connections (API key files). " +
    "Shows which connection is currently active.",
    {},
    { ...readOnly, title: "List Connections" },
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
    { ...mutate, title: "Switch Connection" },
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

      connectionState.generation += 1;
      connectionState.activeIndex = index;
      clearAllCaches(previousIndex);
      clearAllCaches(index);

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

  // Wrap server.tool to pin each handler to a connection snapshot via AsyncLocalStorage.
  // The wrapper captures the active connection at invocation time, runs the handler
  // inside that snapshot, and asserts the connection hasn't changed on return.
  function wrapHandler<T extends (...args: any[]) => any>(handler: T): T {
    return (async (...args: unknown[]) => {
      const snapshot = captureSnapshot(connectionState);
      const extra = args.length >= 2 ? args[1] as any : undefined;
      try {
        return await invocationStorage.run(snapshot, async () => {
          const runInExtra = extra
            ? () => toolExtraStorage.run(extra, () => handler(...args))
            : () => handler(...args);
          const result = await runInExtra();
          assertSnapshotCurrent(connectionState, snapshot);
          return result;
        });
      } catch (error) {
        process.stderr.write(`Tool handler error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        return toolError(error);
      }
    }) as unknown as T;
  }

  // Create a proxy that intercepts server.tool() calls and wraps the last function argument.
  // This is forward-compatible with any overload signature the SDK may add.
  const scopedServer = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") return Reflect.get(target, prop, receiver);
      return (...toolArgs: unknown[]) => {
        // The handler is always the last argument and always a function
        const lastIdx = toolArgs.length - 1;
        if (lastIdx >= 0 && typeof toolArgs[lastIdx] === "function") {
          toolArgs[lastIdx] = wrapHandler(toolArgs[lastIdx] as any);
        }
        return (target.tool as any)(...toolArgs);
      };
    },
  }) as McpServer;

  // Register all tools (via scopedServer so handlers get connection-pinned)
  registerCrudTools(scopedServer, api);
  registerAccountBalanceTools(scopedServer, api);
  registerPdfWorkflowTools(scopedServer, api);
  registerBankReconciliationTools(scopedServer, api);
  registerFinancialStatementTools(scopedServer, api);
  registerAgingTools(scopedServer, api);
  registerRecurringInvoiceTools(scopedServer, api);
  registerEstonianTaxTools(scopedServer, api);
  registerDocumentAuditTools(scopedServer, api);
  registerLightyearTools(scopedServer, api);
  registerWiseImportTools(scopedServer, api);

  // Register resources
  registerResources(server, api);
  registerDynamicResources(server, api);

  // Register prompts
  registerPrompts(server);

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Route log output through MCP logging protocol
  setLogger((level, message) => {
    server.sendLoggingMessage({ level, data: message });
  });

  const names = allConfigs.map(c => c.name).join(", ");
  process.stderr.write(`e-arveldaja MCP server started (${allConfigs.length} connection(s): ${names})\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
