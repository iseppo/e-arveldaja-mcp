import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../../mcp-json.js";
import { desandboxAllStrings, renderExternalEntity } from "../../external-text-renderer.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { toolResponse } from "../../tool-response.js";
import { HttpError } from "../../http-client.js";
import { applyListView, viewParam } from "../../list-views.js";
import { withOpeningBalanceStatus } from "../../opening-balance-limitations.js";
import { readOpeningBalances } from "../../opening-balance-store.js";
import { validatePostingDimensions } from "../../account-validation.js";
import {
  findDuplicateBankPostings,
  formatDuplicatePostingWarnings,
  resolveBankDimensions,
  type BankDimensionInfo,
  type DuplicatePostingCandidate,
  type DuplicatePostingScanResult,
} from "../../bank-posting-duplicate-guard.js";
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
    "List journal entries. Paginated. Brief view omits postings; use view='full' for headers or get_journal for postings.",
    {
      ...pageParam.shape,
      ...viewParam,
      date_from: isoDateString("Only journals with effective_date >= this (YYYY-MM-DD). Filters by effective_date; narrowed server-side.").optional(),
      date_to: isoDateString("Only journals with effective_date <= this (YYYY-MM-DD). Filters by effective_date; narrowed server-side.").optional(),
      registered: z.boolean().optional().describe("Only registered (true) or unregistered (false) journals"),
      operation_type: z.string().optional().describe("Filter by operation_type (e.g. ENTRY, TRANSACTION, SALE_INVOICE, PURCHASE_INVOICE)"),
      document_number_contains: z.string().optional().describe("Case-insensitive substring match on document_number"),
      clients_id: z.number().int().positive().optional().describe("Filter by clients_id"),
      per_page: z.number().int().min(1).max(500).optional().describe("Items per page when filtering (default 100, max 500)"),
    },
    { ...readOnly, title: "List Journals" },
    async (params) => {
      const hasFilter = params.date_from !== undefined
        || params.date_to !== undefined
        || params.registered !== undefined
        || params.operation_type !== undefined
        || params.document_number_contains !== undefined
        || params.clients_id !== undefined;
      if (!hasFilter) {
        const result = await api.journals.list(params);
        const stripped = result.items.map(({ postings: _postings, ...rest }) => rest);
        // Always emit the same superset shape as the client-side path so callers
        // get a stable envelope regardless of which filter route was taken.
        const perPage = params.per_page ?? result.items.length;
        const compact = {
          ...result,
          current_page: result.current_page,
          total_pages: result.total_pages,
          total_items: (result as { total_items?: number }).total_items
            ?? result.items.length,
          per_page: (result as { per_page?: number }).per_page ?? perPage,
          items: renderExternalEntity("journal", applyListView("journal", stripped, params.view)),
          filtered_client_side: false,
          out_of_range: false,
          warnings: withOpeningBalanceStatus([], { captured: readOpeningBalances() !== null }),
        };
        return { content: [{ type: "text", text: toMcpJson(compact) }] };
      }
      // The /journals endpoint supports only a server-side effective-date range
      // (no status / client filter); registered / operation_type / clients_id /
      // document_number are applied client-side below over the narrowed set.
      const hasServerFilter = params.modified_since !== undefined
        || params.date_from !== undefined
        || params.date_to !== undefined;
      const all = hasServerFilter
        ? await api.journals.listAll({
            modified_since: params.modified_since,
            start_date: params.date_from,
            end_date: params.date_to,
          })
        : await api.journals.listAllCached();
      const docContains = params.document_number_contains?.toLowerCase();
      const filtered = all.filter((j) => {
        if (params.date_from && (!j.effective_date || j.effective_date < params.date_from)) return false;
        if (params.date_to && (!j.effective_date || j.effective_date > params.date_to)) return false;
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
      const items = renderExternalEntity("journal", applyListView("journal", stripped, params.view));
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
            warnings: withOpeningBalanceStatus([], { captured: readOpeningBalances() !== null }),
          }),
        }],
      };
    });

  registerTool(server, "get_journal", "Get a journal entry by ID (includes postings)", idParam.shape, { ...readOnly, title: "Get Journal" }, async ({ id }) => {
    const result = await api.journals.get(id);
    return { content: [{ type: "text", text: toMcpJson(renderExternalEntity("journal", result)) }] };
  });

  registerTool(server, "create_journal", "Create a journal entry with postings", {
    title: z.string().optional().describe("Journal entry title"),
    effective_date: isoDateString("Entry date (YYYY-MM-DD)"),
    clients_id: z.number().optional().describe("Related client ID"),
    document_number: z.string().optional().describe("Document number"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    postings: jsonObjectArrayInput.describe(
      "Postings [{accounts_id, type: 'D'|'C', amount, accounts_dimensions_id?, base_amount?, projects_project_id?, projects_location_id?, projects_person_id?}]. " +
      "accounts_dimensions_id is REQUIRED when accounts_id has sub-accounts. " +
      "base_amount = EUR equivalent for non-EUR entries. " +
      "projects_* fields link the posting to project tracking dimensions."
    ),
    block_on_duplicate: z.boolean().optional().describe("Refuse creation when a bank posting looks like an already-booked duplicate (default false: warn only)."),
  }, { ...create, title: "Create Journal" }, async (rawParams) => {
    const params = desandboxAllStrings(rawParams);
    const postings = parsePostings(params.postings);
    const [accounts, accountDimensions] = await Promise.all([
      api.readonly.getAccounts(),
      api.readonly.getAccountDimensions(),
    ]);
    const postingErrors = validatePostingDimensions(postings, accounts, accountDimensions);
    if (postingErrors.length > 0) {
      return toolError({ error: "Account validation failed", details: postingErrors });
    }

    // Cross-mechanism duplicate guard (Task 5): consult only when at least one
    // posting touches a known bank-account dimension — the exact shape of the
    // incident this guard exists for (a manual journal crediting a bank
    // dimension directly, later re-booked by a reconcile). Fast-pathed: a
    // journal with no bank-dimension posting never triggers a journals scan.
    const bankDims = await resolveBankDimensions(api);
    const bankDimById = new Map(bankDims.map(d => [d.dimensionId, d]));
    const postingScans: Array<{
      dim: BankDimensionInfo;
      candidate: DuplicatePostingCandidate;
      scan: DuplicatePostingScanResult;
    }> = [];
    for (const posting of postings) {
      if (posting.accounts_dimensions_id == null) continue;
      const dim = bankDimById.get(posting.accounts_dimensions_id);
      if (!dim) continue;
      const candidate: DuplicatePostingCandidate = {
        accountId: dim.accountId,
        dimensionId: dim.dimensionId,
        amount: posting.base_amount ?? posting.amount,
        direction: posting.type === "D" ? "D" : "C",
        date: params.effective_date,
      };
      const scan = await findDuplicateBankPostings(api, candidate);
      postingScans.push({ dim, candidate, scan });
    }

    if (params.block_on_duplicate === true) {
      const conflicting = new Map<number, { journal_id: number; journal_title: string; date: string; amount: number }>();
      for (const ps of postingScans) {
        if (!ps.scan.scan_available) continue;
        for (const suspect of ps.scan.suspects) {
          if (conflicting.has(suspect.journal_id)) continue;
          conflicting.set(suspect.journal_id, {
            journal_id: suspect.journal_id,
            journal_title: wrapUntrustedOcr(suspect.journal_title) ?? "",
            date: suspect.date,
            amount: suspect.amount,
          });
        }
      }
      if (conflicting.size > 0) {
        const journalIds = [...conflicting.keys()];
        return toolError({
          error: "Possible duplicate bank posting",
          category: "possible_duplicate_posting",
          conflicting_journal_ids: journalIds,
          details: [...conflicting.values()],
          next_action: `Verify journal(s) ${journalIds.join(", ")} before creating this journal, or retry without block_on_duplicate to proceed with an advisory warning.`,
        });
      }
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

    // Collect advisory warnings across all bank-dimension postings, deduped by
    // journal_id so a journal that shows up as a suspect against more than one
    // posting (e.g. an inter-account transfer touching two bank dimensions) is
    // only reported once.
    const seenJournalIds = new Set<number>();
    let scanUnavailableNoteAdded = false;
    const warnings: string[] = [];
    const possibleDuplicatePostings: Array<{
      accounts_id: number;
      accounts_dimensions_id: number;
      amount: number;
      direction: "D" | "C";
      suspects: Array<Record<string, unknown>>;
    }> = [];
    for (const ps of postingScans) {
      const newSuspects = ps.scan.suspects.filter(s => !seenJournalIds.has(s.journal_id));
      newSuspects.forEach(s => seenJournalIds.add(s.journal_id));
      const filteredScan: DuplicatePostingScanResult = { ...ps.scan, suspects: newSuspects };
      const lines = formatDuplicatePostingWarnings(filteredScan, ps.candidate, t => wrapUntrustedOcr(t) ?? "");
      for (const line of lines) {
        if (!ps.scan.scan_available && ps.scan.scan_note && line === ps.scan.scan_note) {
          if (scanUnavailableNoteAdded) continue;
          scanUnavailableNoteAdded = true;
        }
        warnings.push(line);
      }
      if (newSuspects.length > 0) {
        possibleDuplicatePostings.push({
          accounts_id: ps.dim.accountId,
          accounts_dimensions_id: ps.dim.dimensionId,
          amount: ps.candidate.amount,
          direction: ps.candidate.direction,
          suspects: newSuspects.map(s => ({ ...s, journal_title: wrapUntrustedOcr(s.journal_title) ?? "" })),
        });
      }
    }

    return toolResponse({
      action: "created",
      entity: "journal",
      id: result.created_object_id,
      message: `Created journal${params.title ? ` "${params.title}"` : ""} on ${params.effective_date}.`,
      raw: result,
      ...(warnings.length > 0
        ? {
            warnings,
            ...(possibleDuplicatePostings.length > 0
              ? { extra: { possible_duplicate_postings: possibleDuplicatePostings } }
              : {}),
          }
        : {}),
    });
  });

  registerTool(server, "update_journal", "Update draft journal fields. Server-managed fields are rejected; registered effective_date requires invalidate_journal first.", {
    id: coerceId.describe("Journal ID"),
    data: jsonObjectInput.describe("Object with fields to update."),
  }, { ...mutate, title: "Update Journal" }, async ({ id, data }) => {
    const parsed = desandboxAllStrings(parseJsonObject(data, "data"));
    const current = await api.journals.get(id);
    const isConfirmed = current.registered === true;
    const updateErrors = validateUpdateFields(parsed, "journal", { isConfirmed });
    if (updateErrors.length > 0) {
      if (isConfirmed && Object.keys(parsed).length > 0) {
        return toolError({
          category: "confirmed_record_immutable",
          error: "Confirmed journal update contains ledger-bearing fields",
          details: updateErrors,
          next_action: "invalidate_journal, fetch the draft, update it, then explicitly re-confirm",
        });
      }
      return toolError({ error: "Invalid update fields", details: updateErrors });
    }
    const result = await api.journals.update(id, parsed);
    logAudit({
      tool: "update_journal", action: "UPDATED", entity_type: "journal", entity_id: id,
      summary: `Updated journal ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return toolResponse({
      action: "updated",
      entity: "journal",
      id,
      message: `Updated journal ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "delete_journal", "Delete a journal entry", idParam.shape, { ...destructive, title: "Delete Journal" }, async ({ id }) => {
    const result = await api.journals.delete(id);
    logAudit({
      tool: "delete_journal", action: "DELETED", entity_type: "journal", entity_id: id,
      summary: `Deleted journal ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "journal",
      id,
      message: `Deleted journal ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "confirm_journal", "Confirm/register a journal entry. IRREVERSIBLE — use invalidate_journal to reverse if needed.", idParam.shape, { ...destructive, title: "Confirm Journal" }, async ({ id }) => {
    const result = await api.journals.confirm(id);
    logAudit({
      tool: "confirm_journal", action: "CONFIRMED", entity_type: "journal", entity_id: id,
      summary: `Confirmed journal ${id}`,
      details: {},
    });
    return toolResponse({
      action: "confirmed",
      entity: "journal",
      id,
      message: `Confirmed journal ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "batch_confirm_journals",
    "Confirm/register multiple journals. IRREVERSIBLE per success; already-registered rows are skipped and failures are reported per ID.",
    {
      ids: z.array(z.number().int().positive()).min(1).max(500).describe("Journal IDs (positive integers, 1-500 entries)"),
      reason: z.string().min(1).max(500).describe("Short audit note for the batch confirmation. Required, max 500 chars."),
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
    "Invalidate (reverse) a confirmed journal entry. Returns it to unconfirmed status for editing or deletion. RPS § 10: corrections must stay traceable — tell the user to record why the entry was reversed and what replaces it.",
    idParam.shape, { ...mutate, title: "Invalidate Journal" }, async ({ id }) => {
      const result = await api.journals.invalidate(id);
      logAudit({
        tool: "invalidate_journal", action: "INVALIDATED", entity_type: "journal", entity_id: id,
        summary: `Invalidated journal ${id}`,
        details: {},
      });
      return toolResponse({
        action: "invalidated",
        entity: "journal",
        id,
        message: `Invalidated journal ${id}.`,
        raw: result,
      });
    });
}
