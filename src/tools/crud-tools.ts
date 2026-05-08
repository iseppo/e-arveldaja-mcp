import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReferenceDataTools } from "./reference-data-tools.js";
import { registerClientTools } from "./crud/clients.js";
import { registerProductTools } from "./crud/products.js";
import { registerJournalTools } from "./crud/journals.js";
import { registerTransactionTools } from "./crud/transactions.js";
import { registerSaleInvoiceTools } from "./crud/sale-invoices.js";
import { registerPurchaseInvoiceTools } from "./crud/purchase-invoices.js";
import type { ApiContext } from "./crud/shared.js";

export * from "./crud/shared.js";

export function registerCrudTools(server: McpServer, api: ApiContext): void {
  registerClientTools(server, api);
  registerProductTools(server, api);
  registerJournalTools(server, api);
  registerTransactionTools(server, api);
  registerSaleInvoiceTools(server, api);
  registerPurchaseInvoiceTools(server, api);
  registerReferenceDataTools(server, api);
}
