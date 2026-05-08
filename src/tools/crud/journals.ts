import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { toolResponse } from "../../tool-response.js";
import { HttpError } from "../../http-client.js";
import { applyListView, viewParam } from "../../list-views.js";
import { withOpeningBalanceApiLimitation } from "../../opening-balance-limitations.js";
import { validatePostingDimensions } from "../../account-validation.js";
import type { ApiContext } from "./shared.js";
import {
  coerceId,
  idParam,
  isoDateString,
  jsonObjectArrayInput,
  jsonObjectInput,
  pageParam,
  parseJsonObject,
  parsePostings,
  validateUpdateFields,
} from "./shared.js";

export function registerJournalTools(server: McpServer, api: ApiContext): void {
  // =====================
  // JOURNALS
  // =====================

  registerTool(server, "list_journals",
    "List journal entries. Paginated. Returns brief view (id, effective_date, number, title, document_number, registered, clients_id, operation_type) by default — postings always omitted at this surface; pass view='full' for the remaining header fields, or call get_journal for postings. " +
    "Optional filters are applied client-side after listAll() when any filter is provided, which avoids repeated page-by-page walks.",
    {
      ...pageParam.shape,
      ...viewParam,
      effective_date_from: z.string().optional().describe("Only journals with effective_date >= this (YYYY-MM-DD)"),
      effective_date_to: z.string().optional().describe("Only journals with effective_date <= this (YYYY-MM-DD)"),
      registered: z.boolean().optional().describe("Only registered (true) or unregistered (false) journals"),
      operation_type: z.string().optional().describe("Filter by operation_type (e.g. ENTRY, TRANSACTION, SALE_INVOICE, PURCHASE_INVOICE)"),
      document_number_contains: z.string().optional().describe("Case-insensitive substring match on document_number"),
      clients_id: z.number().int().positive().optional().describe("Filter by clients_id"),
      per_page: z.number().int().min(1).max(500).optional().describe("Items per page when filtering (default 100, max 500)"),
    },
    { ...readOnly, title: "List Journals" },
    async (params) => {
      const hasFilter = params.effective_date_from !== undefined
        || params.effective_date_to !== undefined
        || params.registered !== undefined
        || params.operation_type !== undefined
        || params.document_number_contains !== undefined
        || params.clients_id !== undefined;
      if (!hasFilter) {
        const result = await api.journals.list(params);
        const stripped = result.items.map(({ postings: _postings, ...rest }) => rest);
        const compact = {
          ...result,
          items: applyListView("journal", stripped, params.view),
          warnings: withOpeningBalanceApiLimitation(),
        };
        return { content: [{ type: "text", text: toMcpJson(compact) }] };
      }
      const all = await api.journals.listAllCached();
      const docContains = params.document_number_contains?.toLowerCase();
      const filtered = all.filter((j) => {
        if (params.effective_date_from && (!j.effective_date || j.effective_date < params.effective_date_from)) return false;
        if (params.effective_date_to && (!j.effective_date || j.effective_date > params.effective_date_to)) return false;
        if (params.registered !== undefined && j.registered !== params.registered) return false;
        if (params.operation_type && j.operation_type !== params.operation_type) return false;
        if (params.clients_id !== undefined && j.clients_id !== params.clients_id) return false;
        if (docContains && !(j.document_number ?? "").toLowerCase().includes(docContains)) return false;
        return true;
      });
      const perPage = params.per_page ?? 100;
      // pageParam doesn't constrain `page` to positive integers, so defensively
      // floor + clamp here.
      const requestedPage = Math.max(1, Math.floor(params.page ?? 1));
      const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
      // out_of_range is surfaced so an LLM caller that over-paginates doesn't
      // mistake "past the end" for "legitimately empty page" silently.
      const outOfRange = requestedPage > totalPages;
      const start = (requestedPage - 1) * perPage;
      const stripped = filtered.slice(start, start + perPage)
        .map(({ postings: _postings, ...rest }) => rest);
      const items = applyListView("journal", stripped, params.view);
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            current_page: requestedPage,
            total_pages: totalPages,
            total_items: filtered.length,
            per_page: perPage,
            filtered_client_side: true,
            out_of_range: outOfRange,
            items,
            warnings: withOpeningBalanceApiLimitation(),
          }),
        }],
      };
    });

  registerTool(server, "get_journal", "Get a journal entry by ID (includes postings)", idParam.shape, { ...readOnly, title: "Get Journal" }, async ({ id }) => {
    const result = await api.journals.get(id);
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_journal", "Create a journal entry with postings", {
    title: z.string().optional().describe("Journal entry title"),
    effective_date: isoDateString("Entry date (YYYY-MM-DD)"),
    clients_id: z.number().optional().describe("Related client ID"),
    document_number: z.string().optional().describe("Document number"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    postings: jsonObjectArrayInput.describe(
      "Array of postings: [{accounts_id, type: 'D'|'C', amount, accounts_dimensions_id?, base_amount?, projects_project_id?, projects_location_id?, projects_person_id?}]. Legacy callers may still pass a JSON array string. " +
      "accounts_dimensions_id is REQUIRED when accounts_id refers to an account with sub-accounts (use list_account_dimensions to look it up). " +
      "base_amount is the EUR equivalent for multi-currency entries (when cl_currencies_id is not EUR). " +
      "projects_project_id / projects_location_id / projects_person_id link the posting to project tracking dimensions."
    ),
  }, { ...create, title: "Create Journal" }, async (params) => {
    const postings = parsePostings(params.postings);
    const [accounts, accountDimensions] = await Promise.all([
      api.readonly.getAccounts(),
      api.readonly.getAccountDimensions(),
    ]);
    const postingErrors = validatePostingDimensions(postings, accounts, accountDimensions);
    if (postingErrors.length > 0) {
      return toolError({ error: "Account validation failed", details: postingErrors });
    }
    const result = await api.journals.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
      postings,
    });
    logAudit({
      tool: "create_journal", action: "CREATED", entity_type: "journal",
      entity_id: result.created_object_id,
      summary: `Created journal "${params.title ?? ""}" on ${params.effective_date}`,
      details: {
        effective_date: params.effective_date, title: params.title,
        document_number: params.document_number,
        postings: postings.map(p => ({
          accounts_id: p.accounts_id,
          type: p.type,
          amount: p.amount,
          accounts_dimensions_id: p.accounts_dimensions_id,
          base_amount: p.base_amount,
          projects_project_id: p.projects_project_id,
          projects_location_id: p.projects_location_id,
          projects_person_id: p.projects_person_id,
        })),
      },
    });
    return toolResponse({
      action: "created",
      entity: "journal",
      id: result.created_object_id,
      message: `Created journal${params.title ? ` "${params.title}"` : ""} on ${params.effective_date}.`,
      raw: result,
    });
  });

  registerTool(server, "update_journal", "Update a journal entry. Server-managed fields (id, registered, register_date, status) are rejected — use the dedicated confirm/invalidate tools. Once the journal is registered, effective_date is audit-locked; invalidate_journal first to edit it.", {
    id: coerceId.describe("Journal ID"),
    data: jsonObjectInput.describe("Object with fields to update. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Journal" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
    const current = await api.journals.get(id);
    const updateErrors = validateUpdateFields(parsed, "journal", { isConfirmed: current.registered === true });
    if (updateErrors.length > 0) {
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    const result = await api.journals.update(id, parsed);
    logAudit({
      tool: "update_journal", action: "UPDATED", entity_type: "journal", entity_id: id,
      summary: `Updated journal ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "delete_journal", "Delete a journal entry", idParam.shape, { ...destructive, title: "Delete Journal" }, async ({ id }) => {
    const result = await api.journals.delete(id);
    logAudit({
      tool: "delete_journal", action: "DELETED", entity_type: "journal", entity_id: id,
      summary: `Deleted journal ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "confirm_journal", "Confirm/register a journal entry. IRREVERSIBLE — use invalidate_journal to reverse if needed.", idParam.shape, { ...destructive, title: "Confirm Journal" }, async ({ id }) => {
    const result = await api.journals.confirm(id);
    logAudit({
      tool: "confirm_journal", action: "CONFIRMED", entity_type: "journal", entity_id: id,
      summary: `Confirmed journal ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "batch_confirm_journals",
    "Confirm/register multiple journal entries in one call. IRREVERSIBLE for each success. " +
    "Runs sequentially; already-registered journals are skipped (checked up-front via /journals/:id); " +
    "continues past individual failures and returns per-ID results so partial progress is visible.",
    {
      ids: z.array(z.number().int().positive()).min(1).max(500).describe("Journal IDs (positive integers, 1-500 entries)"),
      reason: z.string().min(1).max(500).describe("Short audit note explaining why this batch is being confirmed (e.g. 'Lightyear trades batch — Q1 2026'). Required — max 500 chars."),
    },
    { ...destructive, title: "Batch Confirm Journals" },
    async ({ ids, reason }) => {
      const unique = [...new Set(ids)];
      // Bulk pre-fetch via listAllCached so a 500-ID batch doesn't make 500 serial
      // GET calls (~50s at 10 req/sec). Falls back to per-ID lookup for IDs not
      // present in the aggregate (e.g. brand-new journals created after the
      // cache was populated).
      const allJournals = await api.journals.listAllCached();
      const byId = new Map(allJournals.filter(j => j.id != null).map(j => [j.id!, j]));
      const results: Array<{
        id: number;
        status: "confirmed" | "skipped_already_confirmed" | "skipped_missing" | "lookup_failed" | "failed";
        error?: string;
      }> = [];
      for (const id of unique) {
        // Pre-check lets us categorize already-registered journals (which the API
        // rejects) separately from real failures, matching the delete-batch shape.
        let alreadyRegistered = false;
        const cachedJournal = byId.get(id);
        if (cachedJournal) {
          alreadyRegistered = cachedJournal.registered === true;
        } else {
          try {
            const existing = await api.journals.get(id);
            alreadyRegistered = existing.registered === true;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const isNotFound = error instanceof HttpError && error.status === 404;
            results.push({
              id,
              status: isNotFound ? "skipped_missing" : "lookup_failed",
              error: message,
            });
            continue;
          }
        }
        if (alreadyRegistered) {
          results.push({
            id,
            status: "skipped_already_confirmed",
            error: "Journal is already registered — nothing to confirm.",
          });
          continue;
        }
        try {
          await api.journals.confirm(id);
          logAudit({
            tool: "batch_confirm_journals", action: "CONFIRMED", entity_type: "journal", entity_id: id,
            summary: `Confirmed journal ${id}: ${reason}`,
            details: { reason },
          });
          results.push({ id, status: "confirmed" });
        } catch (error: unknown) {
          results.push({ id, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
      const confirmed = results.filter(r => r.status === "confirmed").length;
      const skipped = results.filter(r =>
        r.status === "skipped_already_confirmed" || r.status === "skipped_missing",
      ).length;
      const lookupFailed = results.filter(r => r.status === "lookup_failed").length;
      const failed = results.filter(r => r.status === "failed").length;
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            requested: unique.length,
            confirmed_count: confirmed,
            skipped_count: skipped,
            lookup_failed_count: lookupFailed,
            failed_count: failed,
            reason,
            results,
          }),
        }],
      };
    });

  registerTool(server, "invalidate_journal",
    "Invalidate (reverse) a confirmed journal entry. Returns it to unconfirmed status for editing or deletion.",
    idParam.shape, { ...mutate, title: "Invalidate Journal" }, async ({ id }) => {
      const result = await api.journals.invalidate(id);
      logAudit({
        tool: "invalidate_journal", action: "INVALIDATED", entity_type: "journal", entity_id: id,
        summary: `Invalidated journal ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });
}
