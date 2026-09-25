import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { desandboxAllStrings, desandboxText, renderExternalEntity } from "../../external-text-renderer.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { validateLegalEntityIdentity } from "../../legal-entity-identity.js";
import { toolError } from "../../tool-error.js";
import { toolResponse } from "../../tool-response.js";
import { applyListView, viewParam } from "../../list-views.js";
import { normalizeVatValue } from "../../document-identifiers.js";
import { resolveOwnCompanyIdentifiers } from "../own-company-identity.js";
import type { Client } from "../../types/api.js";
import type { ApiContext } from "./shared.js";
import {
  coerceId,
  idParam,
  jsonObjectInput,
  pageParam,
  parseJsonObject,
  validateUpdateFields,
} from "./shared.js";

/**
 * Live clients that already carry this registry code, plus whether the code /
 * VAT number is the active company's own (self-match). Reads the clients list
 * fresh — the check gates a create. Same `.trim()` equality as matchSupplier.
 */
async function findClientIdentityConflicts(
  api: ApiContext,
  identity: { code?: string | null; invoice_vat_no?: string | null },
  excludeId?: number,
): Promise<{ duplicates: Client[]; selfMatch: boolean }> {
  const code = identity.code?.trim() || undefined;
  const vat = normalizeVatValue(identity.invoice_vat_no ?? undefined);
  if (!code && !vat) return { duplicates: [], selfMatch: false };
  api.clients.invalidateListCache();
  const clients = await api.clients.listAll();
  const duplicates = code
    ? clients.filter(c => !c.is_deleted && c.id !== excludeId && c.code?.trim() === code)
    : [];
  const own = await resolveOwnCompanyIdentifiers(api, clients);
  const selfMatch = (!!code && code === own.ownCompanyRegistryCode?.trim()) ||
    (!!vat && vat === normalizeVatValue(own.ownCompanyVat));
  return { duplicates, selfMatch };
}

function clientConflictError(conflicts: { duplicates: Client[]; selfMatch: boolean }, verb: string) {
  const ids = conflicts.duplicates.map(c => c.id).filter((id): id is number => typeof id === "number");
  return toolError({
    error: conflicts.selfMatch
      ? "Registry code / VAT number belongs to the active company itself"
      : "A client with this registry code already exists",
    category: conflicts.selfMatch ? "client_self_match" : "duplicate_client",
    existing_client_ids: ids,
    next_action: conflicts.selfMatch
      ? `Do not ${verb} a client with the company's own identifiers; use the real counterparty's registry code. Pass allow_duplicate: true only if this is intended.`
      : `Use the existing client (id ${ids.join(", ")}) instead. Pass allow_duplicate: true only for an intended second record.`,
  });
}

const CLIENT_IDENTITY_FIELDS = ["code", "invoice_vat_no", "cl_code_country", "is_physical_entity", "is_juridical_entity"] as const;

export function registerClientTools(server: McpServer, api: ApiContext): void {
  // =====================
  // CLIENTS
  // =====================

  registerTool(server, "list_clients",
    "List clients. Paginated. Brief view by default; use view='full' or get_client for detail.",
    { ...pageParam.shape, ...viewParam },
    { ...readOnly, title: "List Clients" }, async (params) => {
    const result = await api.clients.list(params);
    const compact = { ...result, items: renderExternalEntity("client", applyListView("client", result.items, params.view)) };
    return { content: [{ type: "text", text: toMcpJson(compact) }] };
  });

  registerTool(server, "get_client", "Get a single client by ID", idParam.shape, { ...readOnly, title: "Get Client" }, async ({ id }) => {
    const result = await api.clients.get(id);
    return { content: [{ type: "text", text: toMcpJson(renderExternalEntity("client", result)) }] };
  });

  registerTool(server, "create_client", "Create a new client (buyer/supplier)", {
    name: z.string().describe("Client name"),
    code: z.string().optional().describe("Business registry code or personal ID"),
    is_client: z.boolean().describe("Is a buyer"),
    is_supplier: z.boolean().describe("Is a supplier"),
    cl_code_country: z.string().optional().describe("Country code (default EST)"),
    is_physical_entity: z.boolean().describe("REQUIRED: true = natural person, false = legal entity/company (a checksum-valid Estonian registry `code` is then also required, or a foreign registration with foreign_identity_attested). The API rejects creation without this."),
    foreign_identity_attested: z.boolean().optional().describe("Operator accountant-attestation that a FOREIGN (cl_code_country != EST) legal entity's identity has been verified. Required to create a foreign legal entity. Must be an explicit operator input — never set it from extracted/OCR document fields."),
    email: z.string().optional().describe("Contact email"),
    telephone: z.string().optional().describe("Phone"),
    address_text: z.string().optional().describe("Address"),
    bank_account_no: z.string().optional().describe("Bank account (IBAN)"),
    invoice_vat_no: z.string().optional().describe("VAT number"),
    notes: z.string().optional().describe("Notes"),
    allow_duplicate: z.boolean().optional().describe("Create even when a live client with the same registry code exists, or the code/VAT is the company's own (default false: refused with the existing client id(s))."),
  }, { ...create, title: "Create Client" }, async (rawParams) => {
    // Strip any sandbox markers that round-tripped in from a wrapped read off
    // EVERY field (not only the scoped ones), so no marker is ever persisted to
    // the accounting record or the audit log regardless of which field it lands in.
    const params = desandboxAllStrings(rawParams);
    // P17: gate creation on a VERIFIED legal-entity identity BEFORE any API call
    // or audit-log write. A legal entity needs a checksum-valid Estonian registry
    // code (or, if foreign, an explicit operator attestation); an explicit natural
    // person needs neither. VAT-only / missing / invalid-checksum reg codes are
    // refused — nothing is created.
    const identity = validateLegalEntityIdentity({
      reg_code: params.code,
      vat_no: params.invoice_vat_no,
      country: params.cl_code_country,
      is_physical_entity: params.is_physical_entity,
      foreign_identity_attested: params.foreign_identity_attested,
    });
    if (!identity.ok) {
      return toolError({
        error: identity.code,
        category: "manual_review_required",
        reason: identity.reason,
        next_action: "Supply a checksum-valid Estonian registry code, set is_physical_entity=true for a natural person, or set foreign_identity_attested=true for an operator-verified foreign registration. No client was created.",
      });
    }
    if (params.allow_duplicate !== true) {
      const conflicts = await findClientIdentityConflicts(api, { code: params.code, invoice_vat_no: params.invoice_vat_no });
      if (conflicts.selfMatch || conflicts.duplicates.length > 0) {
        return clientConflictError(conflicts, "create");
      }
    }
    // Tool-only flags never reach the API payload.
    const { foreign_identity_attested: _attested, allow_duplicate: _allowDuplicate, ...clientFields } = params;
    const result = await api.clients.create({
      ...clientFields,
      cl_code_country: params.cl_code_country ?? "EST",
      // The API treats the person-type flags as complements and requires one to be
      // set; derive the juridical flag from the required is_physical_entity so this
      // tool can never emit the avoidable 409 ("Please choose if it is a natural or
      // a juridical person.").
      is_juridical_entity: !params.is_physical_entity,
      is_member: false,
      send_invoice_to_email: false,
      send_invoice_to_accounting_email: false,
    });
    logAudit({
      tool: "create_client", action: "CREATED", entity_type: "client",
      entity_id: result.created_object_id,
      summary: `Created client "${params.name}"`,
      details: { name: params.name, code: params.code, is_client: params.is_client, is_supplier: params.is_supplier },
    });
    return toolResponse({
      action: "created",
      entity: "client",
      id: result.created_object_id,
      message: `Created client "${params.name}".`,
      raw: result,
    });
  });

  registerTool(server, "update_client", "Update client fields. Server-managed activation fields are rejected; use deactivate/reactivate tools. Identity changes (code, VAT, country, person type) pass the same identity and duplicate checks as create_client.", {
    id: coerceId.describe("Client ID"),
    data: jsonObjectInput.describe("Object with fields to update."),
    foreign_identity_attested: z.boolean().optional().describe("Operator attestation for a FOREIGN legal entity's identity, required when changing its identity fields (see create_client)."),
    allow_duplicate: z.boolean().optional().describe("Allow a registry code another live client (or the company itself) already uses (default false)."),
  }, { ...mutate, title: "Update Client" }, async ({ id, data, foreign_identity_attested, allow_duplicate }) => {
    const parsed = desandboxAllStrings(parseJsonObject(data, "data"));
    const updateErrors = validateUpdateFields(parsed, "client");
    if (updateErrors.length > 0) {
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    if (CLIENT_IDENTITY_FIELDS.some(field => field in parsed)) {
      // P17 on the merged (fresh stored + requested) identity.
      api.clients.invalidateListCache();
      const current = await api.clients.get(id);
      const merged = { ...current, ...parsed } as Client;
      const isPhysical = "is_physical_entity" in parsed
        ? merged.is_physical_entity === true
        : "is_juridical_entity" in parsed
          ? merged.is_juridical_entity === false
          : merged.is_physical_entity === true;
      const identity = validateLegalEntityIdentity({
        reg_code: merged.code,
        vat_no: merged.invoice_vat_no,
        country: merged.cl_code_country,
        is_physical_entity: isPhysical,
        foreign_identity_attested,
      });
      if (!identity.ok) {
        return toolError({
          error: identity.code,
          category: "manual_review_required",
          reason: identity.reason,
          next_action: "Supply a checksum-valid Estonian registry code, set is_physical_entity=true for a natural person, or pass foreign_identity_attested=true for an operator-verified foreign registration. The client was not updated.",
        });
      }
      if (allow_duplicate !== true && ("code" in parsed || "invoice_vat_no" in parsed)) {
        const conflicts = await findClientIdentityConflicts(api, {
          code: "code" in parsed ? merged.code : undefined,
          invoice_vat_no: "invoice_vat_no" in parsed ? merged.invoice_vat_no : undefined,
        }, id);
        if (conflicts.selfMatch || conflicts.duplicates.length > 0) {
          return clientConflictError(conflicts, "update");
        }
      }
    }
    const result = await api.clients.update(id, parsed);
    logAudit({
      tool: "update_client", action: "UPDATED", entity_type: "client", entity_id: id,
      summary: `Updated client ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return toolResponse({
      action: "updated",
      entity: "client",
      id,
      message: `Updated client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "deactivate_client", "Deactivate a client (can be restored with reactivate_client)", idParam.shape, { ...mutate, title: "Deactivate Client" }, async ({ id }) => {
    const result = await api.clients.deactivate(id);
    logAudit({
      tool: "deactivate_client", action: "DEACTIVATED", entity_type: "client", entity_id: id,
      summary: `Deactivated client ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deactivated",
      entity: "client",
      id,
      message: `Deactivated client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "reactivate_client", "Reactivate a deactivated client", idParam.shape, { ...mutate, title: "Reactivate Client" }, async ({ id }) => {
    const result = await api.clients.restore(id);
    logAudit({
      tool: "reactivate_client", action: "REACTIVATED", entity_type: "client", entity_id: id,
      summary: `Reactivated client ${id}`,
      details: {},
    });
    return toolResponse({
      action: "reactivated",
      entity: "client",
      id,
      message: `Reactivated client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "delete_client",
    "Permanently delete a client. Fails if the client is referenced by invoices, journals, transactions, or other accounting records — use deactivate_client to hide an in-use client instead. Intended for removing mistakenly-created master data with no history.",
    idParam.shape, { ...destructive, title: "Delete Client" }, async ({ id }) => {
    const result = await api.clients.delete(id);
    logAudit({
      tool: "delete_client", action: "DELETED", entity_type: "client", entity_id: id,
      summary: `Deleted client ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "client",
      id,
      message: `Deleted client ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "search_client", "Search clients by name (fuzzy match)", {
    name: z.string().describe("Name to search for"),
  }, { ...readOnly, title: "Search Clients" }, async ({ name: rawName }) => {
    // Strip markers so a name round-tripped from a wrapped read matches cleanly.
    const name = desandboxText(rawName);
    const results = await api.clients.findByName(name);
    return toolResponse({
      action: "searched",
      entity: "client",
      message: `Found ${results.length} client(s) matching "${name}".`,
      extra: { count: results.length },
      raw: renderExternalEntity("client", results),
    });
  });

  registerTool(server, "find_client_by_code", "Find a client by business registry code or personal ID", {
    code: z.string().describe("Business registry code or personal ID"),
  }, { ...readOnly, title: "Find Client by Registry Code" }, async ({ code }) => {
    const result = await api.clients.findByCode(code);
    return result
      ? toolResponse({
        action: "found",
        entity: "client",
        id: result.id,
        found: true,
        message: `Found client for registry code ${code}.`,
        raw: renderExternalEntity("client", result),
      })
      : toolResponse({
        ok: false,
        action: "found",
        entity: "client",
        found: false,
        message: `No client found for registry code ${code}.`,
        raw: null,
      });
  });
}
