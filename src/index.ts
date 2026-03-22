#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerTool } from "./mcp-compat.js";
import { loadDotenvFiles, loadAllConfigs, type NamedConfig } from "./config.js";
import { toolExtraStorage } from "./progress.js";
import { HttpClient } from "./http-client.js";
import { ClientsApi } from "./api/clients.api.js";
import { ProductsApi } from "./api/products.api.js";
import { JournalsApi } from "./api/journals.api.js";
import { TransactionsApi } from "./api/transactions.api.js";
import { SaleInvoicesApi } from "./api/sale-invoices.api.js";
import { PurchaseInvoicesApi } from "./api/purchase-invoices.api.js";
import { ReferenceDataApi, readonlyCache } from "./api/readonly.api.js";
import { cache } from "./api/base-resource.js";
import { clearVatWarnings } from "./tools/purchase-vat-defaults.js";
import { registerCrudTools, type ApiContext } from "./tools/crud-tools.js";
import { registerAccountBalanceTools } from "./tools/account-balance.js";
import { registerPdfWorkflowTools } from "./tools/pdf-workflow.js";
import { registerBankReconciliationTools } from "./tools/bank-reconciliation.js";
import { registerFinancialStatementTools } from "./tools/financial-statements.js";
import { registerAgingTools } from "./tools/aging-analysis.js";
import { registerRecurringInvoiceTools } from "./tools/recurring-invoices.js";
import { registerEstonianTaxTools } from "./tools/estonian-tax.js";
import { registerAnnualReportTools } from "./tools/annual-report.js";
import { registerDocumentAuditTools } from "./tools/document-audit.js";
import { registerReceiptInboxTools } from "./tools/receipt-inbox.js";
import { registerLightyearTools } from "./tools/lightyear-investments.js";
import { registerWiseImportTools } from "./tools/wise-import.js";
import { registerCamtImportTools } from "./tools/camt-import.js";
import { registerResources } from "./resources/static-resources.js";
import { registerDynamicResources } from "./resources/dynamic-resources.js";
import { registerPrompts } from "./prompts.js";
import { toolError } from "./tool-error.js";
import { setLogger, log } from "./logger.js";
import { readOnly, mutate } from "./annotations.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

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
    readonly: new ReferenceDataApi(httpClient),
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
  clearVatWarnings();
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
  loadDotenvFiles();
  const allConfigs = loadAllConfigs();
  const connectionState: ConnectionState = { activeIndex: 0, generation: 0 };
  const invocationStorage = new AsyncLocalStorage<ConnectionSnapshot>();
  const connectionContexts = allConfigs.map((namedConfig, index) =>
    buildApiContext(new HttpClient(namedConfig.config, `connection:${index}`))
  );
  const api = createScopedApiContext(connectionState, connectionContexts, invocationStorage);

  const server = new McpServer({
    name: "e-arveldaja",
    version: PKG_VERSION,
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
- Resolve the supplier first, then check duplicate risk before creating.
- If there is no existing supplier match yet, still run duplicate detection using invoice_number + gross_price + invoice_date filters.
- Pass original vat_price and gross_price exactly — do not recalculate.
- Use suggest_booking with clients_id to reuse past purchase article/account/VAT settings; use list_purchase_articles only when history is not sufficient.
- For non-Estonian suppliers, check if reverse charge applies (reversed_vat_id=1).
- Document flow (PDF/image): extract_pdf_invoice → validate_invoice_data → resolve_supplier → detect_duplicate_purchase_invoice → suggest_booking → create_purchase_invoice_from_pdf → upload_invoice_document → confirm_purchase_invoice.
- If document extraction returns raw_text plus llm_fallback, use raw_text as the source of truth for any missing fields instead of guessing from partial regex hints.
- process_receipt_batch OCR-parses PDFs and images; when deterministic extraction is incomplete, inspect extracted.raw_text + llm_fallback before deciding whether the result can be booked or must stay in review.

Bank reconciliation:
- Run reconcile_transactions first, then auto_confirm_exact_matches with execute=false before executing.
- For inter-account transfers (Wise↔LHV etc.): use reconcile_inter_account_transfers. It checks existing journals to prevent double-booking when the other side was already confirmed (e.g. from CAMT import). Always dry-run first.
- Do NOT confirm Wise-side transfer transactions if the same transfer was already confirmed from the LHV CAMT side — this creates duplicate journal entries.

Reporting:
- Confirm all journals/invoices/transactions first for accurate financial reports.
- list_connections / switch_connection for multi-company; switching clears caches.
- Many batch tools support dry_run/execute preview flows — read each tool description before executing.
- Amounts are EUR unless cl_currencies_id specifies otherwise.`,
  });

  // --- Multi-account tools ---

  registerTool(server, "list_connections",
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

  registerTool(server, "switch_connection",
    "Switch to a different e-arveldaja connection (company). " +
    "Clears cached data atomically. Use list_connections to see available indices. " +
    "In-flight tool calls will fail fast and should be retried on the intended connection.",
    {
      index: z.number().describe("Connection index from list_connections"),
    },
    { ...mutate, title: "Switch Connection" },
    async ({ index }) => {
      if (index < 0 || index >= allConfigs.length) {
        return toolError({
          error: `Invalid index ${index}. Valid range: 0-${allConfigs.length - 1}`,
        });
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

  function wrapToolHandler<T extends (...args: any[]) => any>(handler: T): T {
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
        log("error", `Tool handler error: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
          log("debug", error.stack);
        }
        return toolError(error);
      }
    }) as unknown as T;
  }

  function wrapResourceHandler<T extends (...args: any[]) => any>(handler: T): T {
    return (async (...args: unknown[]) => {
      const snapshot = captureSnapshot(connectionState);
      return invocationStorage.run(snapshot, async () => {
        const result = await handler(...args);
        assertSnapshotCurrent(connectionState, snapshot);
        return result;
      });
    }) as unknown as T;
  }

  // Create a proxy that pins tool and resource handlers to a connection snapshot.
  const scopedServer = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (...toolArgs: unknown[]) => {
          const lastIdx = toolArgs.length - 1;
          if (lastIdx >= 0 && typeof toolArgs[lastIdx] === "function") {
            toolArgs[lastIdx] = wrapToolHandler(toolArgs[lastIdx] as any);
          }
          return (target.registerTool as any)(...toolArgs);
        };
      }

      if (prop === "registerResource") {
        return (...resourceArgs: unknown[]) => {
          const lastIdx = resourceArgs.length - 1;
          if (lastIdx >= 0 && typeof resourceArgs[lastIdx] === "function") {
            resourceArgs[lastIdx] = wrapResourceHandler(resourceArgs[lastIdx] as any);
          }
          return (target.registerResource as any)(...resourceArgs);
        };
      }

      return Reflect.get(target, prop, receiver);
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
  registerAnnualReportTools(scopedServer, api);
  registerDocumentAuditTools(scopedServer, api);
  registerReceiptInboxTools(scopedServer, api);
  registerLightyearTools(scopedServer, api);
  registerWiseImportTools(scopedServer, api);
  registerCamtImportTools(scopedServer, api);

  // Register resources via scopedServer so reads stay pinned to the selected connection
  registerResources(scopedServer, api);
  registerDynamicResources(scopedServer, api);

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
