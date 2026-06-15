import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResource } from "../mcp-compat.js";
import {
  ACCOUNTING_KNOWLEDGE_URI_BASE,
  getAccountingKnowledgeOverview,
  readAccountingKnowledgeConcept,
} from "../accounting-rules.js";

/**
 * Exposes the accounting-knowledge bundle (Open Knowledge Format v0.1) as
 * browsable MCP resources:
 *
 * - `earveldaja://accounting_knowledge` — the bundle index / table of contents.
 * - `earveldaja://accounting_knowledge/{+path}` — a single concept file by its
 *   bundle-relative path (e.g. `auto-booking/openai--saas-subscriptions.md`).
 *   The `list` callback enumerates the current concept set on every
 *   `resources/list`, so newly saved rules show up without restarting.
 *
 * Trust boundary: like `static-resources.ts`, these expose operator-curated
 * configuration (booking rules, VAT policy, report overrides), not imported
 * OCR/CAMT/CSV content. Rules only enter the bundle through the approval-gated
 * `save_auto_booking_rule` path, so the output is treated as trusted reference
 * data and is intentionally NOT wrapped in the untrusted-OCR sandbox.
 */
export function registerAccountingKnowledgeResources(server: McpServer): void {
  registerResource(server,
    "accounting_knowledge",
    ACCOUNTING_KNOWLEDGE_URI_BASE,
    {
      description:
        "Accounting knowledge bundle (Open Knowledge Format) — company-specific booking rules, owner-expense VAT policy and annual-report overrides the ledger cannot prove by itself. This is the index/table of contents; read an individual concept at earveldaja://accounting_knowledge/{path}.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const overview = getAccountingKnowledgeOverview();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: overview.indexMarkdown,
        }],
      };
    }
  );

  registerResource(server,
    "accounting_knowledge_concept",
    new ResourceTemplate(`${ACCOUNTING_KNOWLEDGE_URI_BASE}/{+path}`, {
      list: async () => {
        const overview = getAccountingKnowledgeOverview();
        return {
          resources: overview.concepts.map((concept) => ({
            uri: concept.uri,
            name: concept.title,
            description: `${concept.type} — ${concept.description}`,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    {
      description:
        "A single accounting-knowledge concept (markdown with YAML frontmatter) from the OKF bundle, addressed by its bundle-relative path.",
      mimeType: "text/markdown",
    },
    async (uri, params) => {
      const raw = typeof params.path === "string" ? params.path : "";
      let rel = raw;
      try {
        rel = decodeURIComponent(raw);
      } catch {
        rel = raw;
      }
      const concept = readAccountingKnowledgeConcept(rel);
      if (!concept) {
        throw new Error(`Accounting-knowledge concept not found: ${rel || "(empty path)"}`);
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: concept.text,
        }],
      };
    }
  );
}
