import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { registerResource } from "../mcp-compat.js";

export function registerDynamicResources(server: McpServer, api: ApiContext): void {

  registerResource(server, 
    "client",
    new ResourceTemplate("earveldaja://clients/{id}", { list: undefined }),
    { description: "Single client (buyer or supplier) by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const client = await api.clients.get(Number(id));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(client, null, 2),
        }],
      };
    }
  );

  registerResource(server, 
    "product",
    new ResourceTemplate("earveldaja://products/{id}", { list: undefined }),
    { description: "Single product or service by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const product = await api.products.get(Number(id));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(product, null, 2),
        }],
      };
    }
  );

  registerResource(server, 
    "journal",
    new ResourceTemplate("earveldaja://journals/{id}", { list: undefined }),
    { description: "Single journal entry with postings by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const journal = await api.journals.get(Number(id));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(journal, null, 2),
        }],
      };
    }
  );

  registerResource(server, 
    "sale_invoice",
    new ResourceTemplate("earveldaja://sale_invoices/{id}", { list: undefined }),
    { description: "Single sale invoice with line items by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const invoice = await api.saleInvoices.get(Number(id));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(invoice, null, 2),
        }],
      };
    }
  );

  registerResource(server, 
    "purchase_invoice",
    new ResourceTemplate("earveldaja://purchase_invoices/{id}", { list: undefined }),
    { description: "Single purchase invoice with line items by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const invoice = await api.purchaseInvoices.get(Number(id));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(invoice, null, 2),
        }],
      };
    }
  );

  registerResource(server, 
    "transaction",
    new ResourceTemplate("earveldaja://transactions/{id}", { list: undefined }),
    { description: "Single bank transaction by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const transaction = await api.transactions.get(Number(id));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(transaction, null, 2),
        }],
      };
    }
  );
}
