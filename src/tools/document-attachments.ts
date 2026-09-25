import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute } from "path";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { readOnly, destructive } from "../annotations.js";
import { AUDIT_ENTITY_TYPES, logAudit } from "../audit-log.js";
import { coerceId } from "./crud/shared.js";
import type { ApiContext } from "./crud/shared.js";
import { prepareInvoiceDocumentUpload } from "./pdf-workflow.js";
import type { BaseResource } from "../api/base-resource.js";
import { HttpError } from "../http-client.js";
import { toolError } from "../tool-error.js";

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

// Derive the document-entity enum from the shared audit vocabulary so the two
// stay consistent: only the four record types that own a `document_user`
// endpoint (everything except client/product master data).
const DOCUMENT_ENTITY_TYPES = AUDIT_ENTITY_TYPES.filter(
  (entity): entity is DocumentEntityType => entity in DOCUMENT_ENTITIES,
);

const entityTypeParam = z
  .enum(DOCUMENT_ENTITY_TYPES)
  .describe("Which record the source document belongs to.");

function resolveDocumentResource(api: ApiContext, entityType: DocumentEntityType): BaseResource<unknown> {
  return DOCUMENT_ENTITIES[entityType].pick(api) as unknown as BaseResource<unknown>;
}

/**
 * Name of the document already attached to the record, or undefined when there
 * is none. "None" is accepted both as a 404 and as an empty file body; any other
 * read failure propagates, so an unknown state never falls through to a
 * silent replace.
 */
async function existingDocumentName(resource: BaseResource<unknown>, id: number): Promise<string | undefined> {
  let file: { name?: string; contents?: string } | undefined;
  try {
    file = await resource.getDocument(id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
  if (!file || (!file.name && !file.contents)) return undefined;
  return file.name || "(unnamed)";
}

export function registerDocumentAttachmentTools(server: McpServer, api: ApiContext): void {
  registerTool(server, "attach_document",
    "Attach a source document (PDF/JPG/PNG) to a purchase invoice, sale invoice, journal, or bank transaction. A record holds one document: an existing one is refused (document_exists) unless replace_existing=true, which overwrites it. RPS requires a source document on every accounting entry; manual journals and directly-booked transactions need one too.",
    {
      entity_type: entityTypeParam,
      id: coerceId.describe("ID of the record to attach the document to."),
      file_path: z.string().describe("Absolute path to the source document (PDF/JPG/PNG), or inline content as base64:<data> or base64:<ext>:<data>."),
      file_name: z.string().optional().describe("Name for the uploaded document; defaults to the source file's name. The file's extension is kept."),
      replace_existing: z.boolean().optional().describe("Overwrite a document already attached to the record (the old file is lost). Default false: refuse with document_exists."),
    },
    { ...destructive, openWorldHint: true, title: "Attach Source Document" },
    async ({ entity_type, id, file_path, file_name, replace_existing }) => {
      if (!file_path.toLowerCase().startsWith("base64:") && !isAbsolute(file_path)) {
        return toolError({ category: "invalid_file_path", error: "file_path must be an absolute path or base64:[<ext>:]<data>." });
      }
      const resource = resolveDocumentResource(api, entity_type);
      const target = { entity_type, id };
      const existingName = await existingDocumentName(resource, id);
      if (existingName !== undefined && replace_existing !== true) {
        return toolError({
          category: "document_exists",
          error: `${entity_type} ${id} already has a source document. Pass replace_existing=true to overwrite it.`,
          target,
          existing_document_name: wrapUntrustedOcr(existingName),
        });
      }
      const upload = await prepareInvoiceDocumentUpload(file_path, undefined, file_name);
      try {
        const result = await resource.uploadDocument(id, upload.fileName, upload.contentsBase64);
        logAudit({
          tool: "attach_document", action: "UPLOADED", entity_type: DOCUMENT_ENTITIES[entity_type].audit,
          entity_id: id,
          summary: existingName !== undefined
            ? `Replaced document "${existingName}" with "${upload.fileName}" on ${entity_type} ${id}`
            : `Attached document "${upload.fileName}" to ${entity_type} ${id}`,
          details: { file_name: upload.fileName, ...(existingName !== undefined ? { replaced_file_name: existingName } : {}) },
        });
        return { content: [{ type: "text", text: toMcpJson({
          ...result,
          target,
          file_name: wrapUntrustedOcr(upload.fileName),
          ...(existingName !== undefined ? { replaced_document_name: wrapUntrustedOcr(existingName) } : {}),
        }) }] };
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
