import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { registerResource } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { buildTaxRulesReference } from "../estonian-tax-rules.js";

export function registerResources(server: McpServer, api: ApiContext): void {

  registerResource(server, 
    "accounts",
    "earveldaja://accounts",
    { description: "Chart of accounts (kontoplaan) - all available accounts with their types and balance directions", mimeType: "text/plain" },
    async (uri) => {
      const accounts = await api.readonly.getAccounts();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: toMcpJson(accounts),
        }],
      };
    }
  );

  registerResource(server, 
    "sale_articles",
    "earveldaja://sale_articles",
    { description: "Sales articles (müügiartiklid) - account mappings for sales", mimeType: "text/plain" },
    async (uri) => {
      const articles = await api.readonly.getSaleArticles();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: toMcpJson(articles),
        }],
      };
    }
  );

  registerResource(server, 
    "purchase_articles",
    "earveldaja://purchase_articles",
    { description: "Purchase articles (ostuartiklid) - account mappings for purchases", mimeType: "text/plain" },
    async (uri) => {
      const articles = await api.readonly.getPurchaseArticles();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: toMcpJson(articles),
        }],
      };
    }
  );

  registerResource(server, 
    "templates",
    "earveldaja://templates",
    { description: "Sales invoice templates", mimeType: "text/plain" },
    async (uri) => {
      const templates = await api.readonly.getTemplates();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: toMcpJson(templates),
        }],
      };
    }
  );

  registerResource(server, 
    "vat_info",
    "earveldaja://vat_info",
    { description: "Company VAT information (KMKR number)", mimeType: "text/plain" },
    async (uri) => {
      const info = await api.readonly.getVatInfo();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: toMcpJson(info),
        }],
      };
    }
  );

  registerResource(server, 
    "invoice_info",
    "earveldaja://invoice_info",
    { description: "Company invoice settings (address, email, templates)", mimeType: "text/plain" },
    async (uri) => {
      const info = await api.readonly.getInvoiceInfo();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: toMcpJson(info),
        }],
      };
    }
  );

  // Server-authored statutory reference (trusted operator data, not OCR) — the
  // standard VAT-rate timeline, current reduced rates, and the deduction /
  // tax-free-limit rules the booking flow draws its tax_notes from.
  registerResource(server,
    "tax_rules",
    "earveldaja://tax_rules",
    { description: "Estonian VAT / income-tax / accounting reference: standard VAT-rate and dividend-CIT timelines, reduced rates, input-VAT deduction & tax-free-limit rules (KMS § 30, § 30 lg 4; TuMS § 48–49), profit-distribution rules (ÄS § 157; TuMS § 50), and RPS process rules (corrections, inventory, retention)", mimeType: "text/plain" },
    async (uri) => {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: toMcpJson(buildTaxRulesReference()),
        }],
      };
    }
  );
}
