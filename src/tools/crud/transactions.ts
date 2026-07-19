import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { desandboxAllStrings, renderExternalEntity } from "../../external-text-renderer.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { toolResponse } from "../../tool-response.js";
import { HttpError } from "../../http-client.js";
import { MutationIndeterminateError, isMutationIndeterminate } from "../../mutation-outcome.js";
import { getNormalizedNetworkCause } from "../../api/transactions.api.js";
import { applyListView, viewParam } from "../../list-views.js";
import { validateTransactionDistributionDimensions } from "../../account-validation.js";
import { createBankTransaction } from "../../bank-transaction-create.js";
import type { Transaction } from "../../types/api.js";
import type { ApiContext } from "./shared.js";
import {
  coerceId,
  idParam,
  isoDateString,
  jsonObjectArrayInput,
  jsonObjectInput,
  pageParam,
  parseJsonObject,
  parseTransactionDistributions,
  validateTransactionUpdateData,
} from "./shared.js";

export function registerTransactionTools(server: McpServer, api: ApiContext): void {
  // =====================
  // TRANSACTIONS
  // =====================

  registerTool(server, "list_transactions",
    "List bank transactions. Paginated. Returns brief view by default; pass view='full' or call get_transaction for full detail.",
    {
      ...pageParam.shape,
      ...viewParam,
      date_from: isoDateString("Only transactions with date >= this (YYYY-MM-DD). Narrowed server-side.").optional(),
      date_to: isoDateString("Only transactions with date <= this (YYYY-MM-DD). Narrowed server-side.").optional(),
      status: z.enum(["PROJECT", "CONFIRMED", "VOID"]).optional().describe("Filter by status: PROJECT, CONFIRMED, or VOID. Narrowed server-side."),
      type: z.enum(["C", "D"]).optional().describe("Filter by transaction type: C or D. Narrowed server-side."),
      accounts_dimensions_id: z.number().int().positive().optional().describe("Filter by bank account dimension ID (client-side)"),
      amount_min: z.number().optional().describe("Only transactions whose EUR-equivalent amount (base_amount ?? amount) >= this"),
      amount_max: z.number().optional().describe("Only transactions whose EUR-equivalent amount (base_amount ?? amount) <= this"),
      has_bank_ref: z.boolean().optional().describe("true = only transactions with a bank_ref_number; false = only without"),
      bank_ref_contains: z.string().optional().describe("Case-insensitive substring match on bank_ref_number (client-side)"),
      clients_id: z.number().int().positive().optional().describe("Filter by clients_id. Narrowed server-side."),
      per_page: z.number().int().min(1).max(500).optional().describe("Items per page (default 100, max 500); applies only when a client-side filter (amount/bank-ref/dimension) is active."),
    },
    { ...readOnly, title: "List Transactions" },
    async (params) => {
      // Split filters: the API natively supports date range / status / type /
      // client (narrowed server-side); amount, bank-ref and account-dimension
      // have no API equivalent and are applied client-side over the narrowed set.
      const hasClientOnlyFilter = params.accounts_dimensions_id !== undefined
        || params.amount_min !== undefined
        || params.amount_max !== undefined
        || params.has_bank_ref !== undefined
        || params.bank_ref_contains !== undefined;
      const serverFilter = {
        modified_since: params.modified_since,
        start_date: params.date_from,
        end_date: params.date_to,
        status: params.status,
        type: params.type,
        clients_id: params.clients_id,
      };
      const hasServerFilter = params.modified_since !== undefined
        || params.date_from !== undefined
        || params.date_to !== undefined
        || params.status !== undefined
        || params.type !== undefined
        || params.clients_id !== undefined;
      if (!hasClientOnlyFilter) {
        // The API filters AND paginates — no client-side page-walking needed.
        const result = await api.transactions.list({ page: params.page, ...serverFilter });
        const items = renderExternalEntity("transaction", applyListView("transaction", result.items, params.view));
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
          items,
          filtered_client_side: false,
          out_of_range: false,
        };
        return { content: [{ type: "text", text: toMcpJson(compact) }] };
      }
      // A client-side filter is active, so we need the full set. Narrow it
      // server-side first when any API-native filter is present; otherwise fall
      // back to the cached full walk.
      const all = hasServerFilter
        ? await api.transactions.listAll(serverFilter)
        : await api.transactions.listAllCached();
      const bankRefContains = params.bank_ref_contains?.toLowerCase();
      const filtered = all.filter((tx) => {
        if (params.date_from && (!tx.date || tx.date < params.date_from)) return false;
        if (params.date_to && (!tx.date || tx.date > params.date_to)) return false;
        if (params.status && tx.status !== params.status) return false;
        if (params.type && tx.type !== params.type) return false;
        if (params.accounts_dimensions_id !== undefined && tx.accounts_dimensions_id !== params.accounts_dimensions_id) return false;
        // Mirror the rest of the codebase (analyze-unconfirmed, reconciliation):
        // EUR-equivalent comparison, not nominal — otherwise a USD 1000 / 920-EUR
        // tx would match amount_min=950 inconsistently with the rest of the tools.
        const comparableAmount = (tx.base_amount ?? tx.amount) as number;
        if (params.amount_min !== undefined && comparableAmount < params.amount_min) return false;
        if (params.amount_max !== undefined && comparableAmount > params.amount_max) return false;
        if (params.clients_id !== undefined && tx.clients_id !== params.clients_id) return false;
        const normalizedRef = (tx.bank_ref_number ?? "").trim();
        if (params.has_bank_ref === true && !normalizedRef) return false;
        if (params.has_bank_ref === false && normalizedRef) return false;
        if (bankRefContains && !normalizedRef.toLowerCase().includes(bankRefContains)) return false;
        return true;
      });
      const perPage = params.per_page ?? 100;
      const requestedPage = Math.max(1, Math.floor(params.page ?? 1));
      const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
      const outOfRange = requestedPage > totalPages;
      const start = (requestedPage - 1) * perPage;
      const items = renderExternalEntity("transaction", applyListView("transaction", filtered.slice(start, start + perPage), params.view));
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
          }),
        }],
      };
    });

  registerTool(server, "get_transaction", "Get a transaction by ID", idParam.shape, { ...readOnly, title: "Get Transaction" }, async ({ id }) => {
    const result = await api.transactions.get(id);
    return { content: [{ type: "text", text: toMcpJson(renderExternalEntity("transaction", result)) }] };
  });

  registerTool(server, "create_transaction", "Create a bank transaction", {
    accounts_dimensions_id: coerceId.describe("Bank account dimension ID"),
    type: z.string().optional().describe("Deprecated and ignored. Newly created bank transactions always use API type C; preserve statement direction separately as source metadata."),
    amount: z.number().describe("Transaction amount"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    date: isoDateString("Transaction date (YYYY-MM-DD)"),
    description: z.string().optional().describe("Description"),
    clients_id: z.number().optional().describe("Related client ID"),
    bank_account_name: z.string().optional().describe("Remitter/beneficiary name"),
    ref_number: z.string().optional().describe("Reference number"),
  }, { ...create, title: "Create Transaction" }, async (rawParams) => {
    const params = desandboxAllStrings(rawParams);
    const result = await createBankTransaction(api, {
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
    });
    logAudit({
      tool: "create_transaction", action: "CREATED", entity_type: "transaction",
      entity_id: result.created_object_id,
      summary: `Created transaction ${params.amount} ${params.cl_currencies_id ?? "EUR"} on ${params.date}`,
      details: {
        date: params.date,
        amount: params.amount,
        type: "C",
        ...(params.type !== undefined ? { ignored_deprecated_type: params.type } : {}),
        description: params.description,
        accounts_dimensions_id: params.accounts_dimensions_id,
      },
    });
    return toolResponse({
      action: "created",
      entity: "transaction",
      id: result.created_object_id,
      message: `Created transaction ${params.amount} ${params.cl_currencies_id ?? "EUR"} on ${params.date}.`,
      raw: result,
    });
  });

  registerTool(server, "confirm_transaction",
    "Confirm a bank transaction by providing distribution rows. " +
    "If the transaction has no clients_id (common for CAMT imports), pass clients_id — " +
    "otherwise the API rejects with 'buyer or supplier is missing'. " +
    "For invoice distributions, clients_id is auto-resolved from the invoice.",
    {
    id: coerceId.describe("Transaction ID"),
      distributions: jsonObjectArrayInput.optional().describe(
        "Array of distribution rows: [{related_table: 'accounts'|'purchase_invoices'|'sale_invoices', related_id, related_sub_id?, amount}]. " +
      "related_id is always REQUIRED (the account or invoice DB ID). " +
      "related_sub_id is REQUIRED when related_table='accounts' and the account has dimensions — " +
      "pass the dimension ID (e.g. 1360 has one sub-account per person); the API rejects dimensioned postings without it."
    ),
    clients_id: coerceId.optional().describe("Client ID to set on the transaction before confirming (required when transaction has no clients_id and distribution is against accounts, not invoices)"),
  }, { ...destructive, title: "Confirm Transaction" }, async ({ id, distributions, clients_id }) => {
    const dist = distributions ? parseTransactionDistributions(distributions) : undefined;
    if (dist && dist.some(d => d.related_table === "accounts")) {
      const [accounts, accountDimensions] = await Promise.all([
        api.readonly.getAccounts(),
        api.readonly.getAccountDimensions(),
      ]);
      const dimensionErrors = validateTransactionDistributionDimensions(dist, accounts, accountDimensions);
      if (dimensionErrors.length > 0) {
        return toolError({ error: "Account validation failed", details: dimensionErrors });
      }
    }

    let clientsIdWasSet = false;
    if (clients_id) {
      const tx = await api.transactions.get(id);
      if (!tx.clients_id) {
        await api.transactions.update(id, { clients_id } as Partial<Transaction>);
        clientsIdWasSet = true;
      }
    }

    let result: Awaited<ReturnType<typeof api.transactions.confirm>>;
    try {
      result = await api.transactions.confirm(id, dist);
    } catch (error) {
      if (clientsIdWasSet && !isMutationIndeterminate(error)) {
        try {
          await api.transactions.update(id, { clients_id: null } as Partial<Transaction>);
        } catch (cleanupError) {
          const normalizedNetworkCause = getNormalizedNetworkCause(cleanupError);
          if (normalizedNetworkCause) {
            api.transactions.invalidateTransactionsAfterAmbiguousCleanup();
            throw new MutationIndeterminateError({
              operation: "rollback",
              entity: "transaction",
              entityId: id,
              businessKey: "transaction:" + id,
              affectedCaches: ["/transactions"],
              cause: normalizedNetworkCause,
              nextAction: "Freshly read transaction " + id +
                "; clients_id cleanup may or may not have committed.",
            });
          }
          if (
            cleanupError instanceof HttpError &&
            cleanupError.status === "network"
          ) {
            api.transactions.invalidateTransactionsAfterAmbiguousCleanup();
            throw new MutationIndeterminateError({
              operation: "rollback",
              entity: "transaction",
              entityId: id,
              businessKey: "transaction:" + id,
              affectedCaches: ["/transactions"],
              cause: cleanupError,
              nextAction: "Freshly read transaction " + id +
                "; clients_id cleanup may or may not have committed.",
            });
          }
          throw cleanupError;
        }
      }
      throw error;
    }
    logAudit({
      tool: "confirm_transaction", action: "CONFIRMED", entity_type: "transaction", entity_id: id,
      summary: `Confirmed transaction ${id}`,
      details: { distributions: dist?.map(d => ({ related_table: d.related_table, related_id: d.related_id, related_sub_id: d.related_sub_id, amount: d.amount })) },
    });
    return toolResponse({
      action: "confirmed",
      entity: "transaction",
      id,
      message: `Confirmed transaction ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "update_transaction", "Update transaction metadata fields such as bank reference, counterparty name, bank account number, description, or payment reference.", {
    id: coerceId.describe("Transaction ID"),
    data: jsonObjectInput.describe("Object with allowed metadata fields only: bank_ref_number, bank_account_name, bank_account_no, description, ref_number."),
  }, { ...mutate, title: "Update Transaction" }, async ({ id, data }) => {
    const parsed = desandboxAllStrings(parseJsonObject(data, "data"));
    const validationErrors = validateTransactionUpdateData(parsed);
    if (validationErrors.length > 0) {
      return toolError({ error: "Transaction metadata validation failed", details: validationErrors });
    }
    const result = await api.transactions.update(id, parsed as Partial<Transaction>);
    logAudit({
      tool: "update_transaction", action: "UPDATED", entity_type: "transaction", entity_id: id,
      summary: `Updated transaction ${id}`,
      details: { fields_changed: Object.keys(parsed) },
    });
    return toolResponse({
      action: "updated",
      entity: "transaction",
      id,
      message: `Updated transaction ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "invalidate_transaction",
    "Invalidate (unconfirm) a confirmed transaction. Returns it to unconfirmed status for editing or deletion. RPS § 10: corrections must stay traceable — record why and what replaces it.",
    idParam.shape, { ...mutate, title: "Invalidate Transaction" }, async ({ id }) => {
      const result = await api.transactions.invalidate(id);
      logAudit({
        tool: "invalidate_transaction", action: "INVALIDATED", entity_type: "transaction", entity_id: id,
        summary: `Invalidated transaction ${id}`,
        details: {},
      });
      return toolResponse({
        action: "invalidated",
        entity: "transaction",
        id,
        message: `Invalidated transaction ${id}.`,
        raw: result,
      });
    });

  registerTool(server, "delete_transaction", "Delete a transaction", idParam.shape, { ...destructive, title: "Delete Transaction" }, async ({ id }) => {
    const result = await api.transactions.delete(id);
    logAudit({
      tool: "delete_transaction", action: "DELETED", entity_type: "transaction", entity_id: id,
      summary: `Deleted transaction ${id}`,
      details: {},
    });
    return toolResponse({
      action: "deleted",
      entity: "transaction",
      id,
      message: `Deleted transaction ${id}.`,
      raw: result,
    });
  });

  registerTool(server, "batch_delete_transactions",
    "Delete multiple PROJECT transactions. IRREVERSIBLE. CONFIRMED rows are skipped; lookup failures are reported per ID.",
    {
      ids: z.array(z.number().int().positive()).min(1).max(500).describe("Transaction IDs (positive integers, 1-500 entries)"),
      reason: z.string().min(1).max(500).describe("Short audit note for the batch delete. Required, max 500 chars."),
    },
    { ...destructive, title: "Batch Delete Transactions" },
    async ({ ids, reason }) => {
      const unique = [...new Set(ids)];
      const results: Array<{
        id: number;
        status: "deleted" | "skipped_confirmed" | "skipped_missing" | "lookup_failed" | "failed";
        error?: string;
      }> = [];
      for (const id of unique) {
        let existing: Transaction | undefined;
        try {
          existing = await api.transactions.get(id);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          // Split 404-from-API vs anything else: 404 genuinely means the row is
          // gone (skip and move on); transient errors (500/timeout/auth drop)
          // shouldn't be treated as "gone" because the caller may drop the ID
          // from reconciliation decisions.
          const isNotFound = error instanceof HttpError && error.status === 404;
          results.push({
            id,
            status: isNotFound ? "skipped_missing" : "lookup_failed",
            error: message,
          });
          continue;
        }
        if (existing.status === "CONFIRMED") {
          results.push({
            id,
            status: "skipped_confirmed",
            error: "Transaction is CONFIRMED — call invalidate_transaction first, then batch_delete_transactions.",
          });
          continue;
        }
        try {
          await api.transactions.delete(id);
          // Capture a full snapshot so the audit log alone is enough to
          // reconstruct the transaction if the deletion turns out to be wrong.
          logAudit({
            tool: "batch_delete_transactions", action: "DELETED", entity_type: "transaction", entity_id: id,
            summary: `Deleted transaction ${id}: ${reason}`,
            details: {
              reason,
              snapshot: {
                accounts_dimensions_id: existing.accounts_dimensions_id,
                accounts_id: existing.accounts_id,
                type: existing.type,
                amount: existing.amount,
                base_amount: existing.base_amount,
                cl_currencies_id: existing.cl_currencies_id,
                date: existing.date,
                description: existing.description,
                bank_ref_number: existing.bank_ref_number,
                bank_account_no: existing.bank_account_no,
                bank_account_name: existing.bank_account_name,
                clients_id: existing.clients_id,
                ref_number: existing.ref_number,
                status: existing.status,
              },
            },
          });
          results.push({ id, status: "deleted" });
        } catch (error: unknown) {
          results.push({ id, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
      const deleted = results.filter(r => r.status === "deleted").length;
      const skipped = results.filter(r => r.status === "skipped_confirmed" || r.status === "skipped_missing").length;
      const lookupFailed = results.filter(r => r.status === "lookup_failed").length;
      const failed = results.filter(r => r.status === "failed").length;
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            requested: unique.length,
            deleted_count: deleted,
            skipped_count: skipped,
            lookup_failed_count: lookupFailed,
            failed_count: failed,
            reason,
            results,
          }),
        }],
      };
    });
}
