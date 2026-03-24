import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { registerResource } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";

function parseResourceId(id: string): number {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid resource ID: "${id}"`);
  }
  return parsed;
}

export function registerDynamicResources(server: McpServer, api: ApiContext): void {

  registerResource(server, 
    "client",
    new ResourceTemplate("earveldaja://clients/{id}", { list: undefined }),
    { description: "Single client (buyer or supplier) by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const client = await api.clients.get(parseResourceId(id as string));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(client),
        }],
      };
    }
  );

  registerResource(server, 
    "product",
    new ResourceTemplate("earveldaja://products/{id}", { list: undefined }),
    { description: "Single product or service by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const product = await api.products.get(parseResourceId(id as string));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(product),
        }],
      };
    }
  );

  registerResource(server, 
    "journal",
    new ResourceTemplate("earveldaja://journals/{id}", { list: undefined }),
    { description: "Single journal entry with postings by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const journal = await api.journals.get(parseResourceId(id as string));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(journal),
        }],
      };
    }
  );

  registerResource(server, 
    "sale_invoice",
    new ResourceTemplate("earveldaja://sale_invoices/{id}", { list: undefined }),
    { description: "Single sale invoice with line items by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const invoice = await api.saleInvoices.get(parseResourceId(id as string));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(invoice),
        }],
      };
    }
  );

  registerResource(server, 
    "purchase_invoice",
    new ResourceTemplate("earveldaja://purchase_invoices/{id}", { list: undefined }),
    { description: "Single purchase invoice with line items by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const invoice = await api.purchaseInvoices.get(parseResourceId(id as string));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(invoice),
        }],
      };
    }
  );

  registerResource(server, 
    "transaction",
    new ResourceTemplate("earveldaja://transactions/{id}", { list: undefined }),
    { description: "Single bank transaction by ID", mimeType: "application/json" },
    async (uri, { id }) => {
      const transaction = await api.transactions.get(parseResourceId(id as string));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(transaction),
        }],
      };
    }
  );
}
