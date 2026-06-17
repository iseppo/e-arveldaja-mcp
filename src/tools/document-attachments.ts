import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { readOnly, mutate, destructive } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { coerceId } from "./crud/shared.js";
import type { ApiContext } from "./crud/shared.js";
import { prepareInvoiceDocumentUpload } from "./pdf-workflow.js";
import type { BaseResource } from "../api/base-resource.js";

/**
 * The RIK e-Financials `document_user` endpoint (GET/PUT/DELETE
 * /{entity}/{id}/document_user) holds the single user-uploaded source document
 * for an accounting record. It is supported on these four resources; the audit
 * log uses the same singular labels.
 */
const DOCUMENT_ENTITIES = {
  purchase_invoice: { pick: (api: ApiContext) => api.purchaseInvoices, audit: "purchase_invoice" },
  sale_invoice: { pick: (api: ApiContext) => api.saleInvoices, audit: "sale_invoice" },
  journal: { pick: (api: ApiContext) => api.journals, audit: "journal" },
  transaction: { pick: (api: ApiContext) => api.transactions, audit: "transaction" },
} as const;

type DocumentEntityType = keyof typeof DOCUMENT_ENTITIES;

/**
 * Cap on the (decoded) document size `get_document` will inline into an MCP
 * response. Uploaded scans/images can be tens of MB (the API allows up to
 * 50 MB), and a 50 MB file becomes ~67 MB of base64 response text that can
 * overwhelm the MCP transport / client context. Above this, only metadata is
 * returned.
 */
const MAX_INLINE_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Approximate the decoded byte size of a base64 string without allocating it. */
function decodedByteEstimate(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

const entityTypeParam = z
  .enum(["purchase_invoice", "sale_invoice", "journal", "transaction"])
  .describe("Which record the source document belongs to.");

function resolveDocumentResource(api: ApiContext, entityType: DocumentEntityType): BaseResource<unknown> {
  return DOCUMENT_ENTITIES[entityType].pick(api) as unknown as BaseResource<unknown>;
}

export function registerDocumentAttachmentTools(server: McpServer, api: ApiContext): void {
  registerTool(server, "attach_document",
    "Attach (upload/replace) a source document (PDF/JPG/PNG) on a purchase invoice, sale invoice, journal, or bank transaction. RPS requires a source document on every accounting entry; manual journals and directly-booked transactions need one too.",
    {
      entity_type: entityTypeParam,
      id: coerceId.describe("ID of the record to attach the document to."),
      file_path: z.string().describe("Absolute path to the source document (PDF/JPG/PNG)."),
    },
    { ...mutate, openWorldHint: true, title: "Attach Source Document" },
    async ({ entity_type, id, file_path }) => {
      const resource = resolveDocumentResource(api, entity_type);
      const upload = await prepareInvoiceDocumentUpload(file_path);
      try {
        const result = await resource.uploadDocument(id, upload.fileName, upload.contentsBase64);
        logAudit({
          tool: "attach_document", action: "UPLOADED", entity_type: DOCUMENT_ENTITIES[entity_type].audit,
          entity_id: id,
          summary: `Attached document "${upload.fileName}" to ${entity_type} ${id}`,
          details: { file_name: upload.fileName },
        });
        return { content: [{ type: "text", text: toMcpJson(result) }] };
      } finally {
        if (upload.cleanup) await upload.cleanup();
      }
    }
  );

  registerTool(server, "get_document",
    "Download the source document (base64) attached to a purchase invoice, sale invoice, journal, or bank transaction. Documents larger than ~5 MB, or when metadata_only=true, return name and size only (the base64 payload is omitted to protect the MCP transport).",
    {
      entity_type: entityTypeParam,
      id: coerceId.describe("ID of the record whose document to download."),
      metadata_only: z.boolean().optional().describe("Return only the filename and size, not the (potentially large) base64 contents."),
    },
    { ...readOnly, openWorldHint: true, title: "Download Source Document" },
    async ({ entity_type, id, metadata_only }) => {
      const resource = resolveDocumentResource(api, entity_type);
      const file = await resource.getDocument(id);
      const sizeBytes = decodedByteEstimate(file.contents ?? "");
      const tooLarge = sizeBytes > MAX_INLINE_DOCUMENT_BYTES;
      // The stored filename originates from the uploaded document and is
      // attacker-controllable — wrap it so it is never echoed as trusted text.
      if (metadata_only || tooLarge) {
        return { content: [{ type: "text", text: toMcpJson({
          name: wrapUntrustedOcr(file.name),
          size_bytes: sizeBytes,
          contents_included: false,
          note: metadata_only
            ? "metadata_only requested — base64 contents omitted."
            : `Document is ~${sizeBytes} bytes, above the inline limit — base64 contents omitted to protect the MCP transport. Open it directly in e-arveldaja if you need the file.`,
        }) }] };
      }
      return { content: [{ type: "text", text: toMcpJson({ ...file, name: wrapUntrustedOcr(file.name) }) }] };
    }
  );

  registerTool(server, "delete_document",
    "Delete the source document attached to a purchase invoice, sale invoice, journal, or bank transaction.",
    {
      entity_type: entityTypeParam,
      id: coerceId.describe("ID of the record whose document to delete."),
    },
    { ...destructive, openWorldHint: true, title: "Delete Source Document" },
    async ({ entity_type, id }) => {
      const resource = resolveDocumentResource(api, entity_type);
      const result = await resource.deleteDocument(id);
      logAudit({
        tool: "delete_document", action: "DELETED", entity_type: DOCUMENT_ENTITIES[entity_type].audit,
        entity_id: id,
        summary: `Deleted source document from ${entity_type} ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    }
  );
}
