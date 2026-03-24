import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { registerResource } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";

export function registerResources(server: McpServer, api: ApiContext): void {

  registerResource(server, 
    "accounts",
    "earveldaja://accounts",
    { description: "Chart of accounts (kontoplaan) - all available accounts with their types and balance directions", mimeType: "application/json" },
    async (uri) => {
      const accounts = await api.readonly.getAccounts();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(accounts),
        }],
      };
    }
  );

  registerResource(server, 
    "sale_articles",
    "earveldaja://sale_articles",
    { description: "Sales articles (müügiartiklid) - account mappings for sales", mimeType: "application/json" },
    async (uri) => {
      const articles = await api.readonly.getSaleArticles();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(articles),
        }],
      };
    }
  );

  registerResource(server, 
    "purchase_articles",
    "earveldaja://purchase_articles",
    { description: "Purchase articles (ostuartiklid) - account mappings for purchases", mimeType: "application/json" },
    async (uri) => {
      const articles = await api.readonly.getPurchaseArticles();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(articles),
        }],
      };
    }
  );

  registerResource(server, 
    "templates",
    "earveldaja://templates",
    { description: "Sales invoice templates", mimeType: "application/json" },
    async (uri) => {
      const templates = await api.readonly.getTemplates();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(templates),
        }],
      };
    }
  );

  registerResource(server, 
    "vat_info",
    "earveldaja://vat_info",
    { description: "Company VAT information (KMKR number)", mimeType: "application/json" },
    async (uri) => {
      const info = await api.readonly.getVatInfo();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(info),
        }],
      };
    }
  );

  registerResource(server, 
    "invoice_info",
    "earveldaja://invoice_info",
    { description: "Company invoice settings (address, email, templates)", mimeType: "application/json" },
    async (uri) => {
      const info = await api.readonly.getInvoiceInfo();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: toMcpJson(info),
        }],
      };
    }
  );
}
