import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../../mcp-compat.js";
import { toMcpJson } from "../../mcp-json.js";
import { readOnly, create, mutate, destructive } from "../../annotations.js";
import { logAudit } from "../../audit-log.js";
import { toolError } from "../../tool-error.js";
import { HttpError } from "../../http-client.js";
import { applyListView, viewParam } from "../../list-views.js";
import { validateTransactionDistributionDimensions } from "../../account-validation.js";
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
    "List bank transactions. Paginated. Returns brief view (id, date, amount, currency, status, type, clients_id, accounts_dimensions_id, bank_ref_number, description) by default; pass view='full' or call get_transaction for full detail (including items). " +
    "Optional filters are applied client-side after listAll() when any filter is provided, so callers don't need to paginate through dozens of pages to find matching rows.",
    {
      ...pageParam.shape,
      ...viewParam,
      date_from: z.string().optional().describe("Only transactions with date >= this (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Only transactions with date <= this (YYYY-MM-DD)"),
      status: z.string().optional().describe("Filter by status: PROJECT, CONFIRMED, or VOID"),
      accounts_dimensions_id: z.number().int().positive().optional().describe("Filter by bank account dimension ID"),
      amount_min: z.number().optional().describe("Only transactions whose EUR-equivalent amount (base_amount ?? amount) >= this"),
      amount_max: z.number().optional().describe("Only transactions whose EUR-equivalent amount (base_amount ?? amount) <= this"),
      has_bank_ref: z.boolean().optional().describe("true = only transactions with a bank_ref_number; false = only without"),
      bank_ref_contains: z.string().optional().describe("Case-insensitive substring match on bank_ref_number"),
      clients_id: z.number().int().positive().optional().describe("Filter by clients_id"),
      per_page: z.number().int().min(1).max(500).optional().describe("Items per page when filtering (default 100, max 500)"),
    },
    { ...readOnly, title: "List Transactions" },
    async (params) => {
      const hasFilter = params.date_from !== undefined
        || params.date_to !== undefined
        || params.status !== undefined
        || params.accounts_dimensions_id !== undefined
        || params.amount_min !== undefined
        || params.amount_max !== undefined
        || params.has_bank_ref !== undefined
        || params.bank_ref_contains !== undefined
        || params.clients_id !== undefined;
      if (!hasFilter) {
        const result = await api.transactions.list(params);
        const compact = { ...result, items: applyListView("transaction", result.items, params.view) };
        return { content: [{ type: "text", text: toMcpJson(compact) }] };
      }
      const all = await api.transactions.listAllCached();
      const bankRefContains = params.bank_ref_contains?.toLowerCase();
      const filtered = all.filter((tx) => {
        if (params.date_from && (!tx.date || tx.date < params.date_from)) return false;
        if (params.date_to && (!tx.date || tx.date > params.date_to)) return false;
        if (params.status && tx.status !== params.status) return false;
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
      const items = applyListView("transaction", filtered.slice(start, start + perPage), params.view);
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
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "create_transaction", "Create a bank transaction", {
    accounts_dimensions_id: coerceId.describe("Bank account dimension ID"),
    type: z.string().describe("Transaction type: D (incoming) or C (outgoing)"),
    amount: z.number().describe("Transaction amount"),
    cl_currencies_id: z.string().optional().describe("Currency (default EUR)"),
    date: isoDateString("Transaction date (YYYY-MM-DD)"),
    description: z.string().optional().describe("Description"),
    clients_id: z.number().optional().describe("Related client ID"),
    bank_account_name: z.string().optional().describe("Remitter/beneficiary name"),
    ref_number: z.string().optional().describe("Reference number"),
  }, { ...create, title: "Create Transaction" }, async (params) => {
    const result = await api.transactions.create({
      ...params,
      cl_currencies_id: params.cl_currencies_id ?? "EUR",
    });
    logAudit({
      tool: "create_transaction", action: "CREATED", entity_type: "transaction",
      entity_id: result.created_object_id,
      summary: `Created transaction ${params.amount} ${params.cl_currencies_id ?? "EUR"} on ${params.date}`,
      details: { date: params.date, amount: params.amount, type: params.type, description: params.description, accounts_dimensions_id: params.accounts_dimensions_id },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "confirm_transaction",
    "Confirm a bank transaction by providing distribution rows. " +
    "If the transaction has no clients_id (common for CAMT imports), pass clients_id to set it before confirming — " +
    "otherwise the API rejects with 'buyer or supplier is missing'. " +
    "For invoice distributions, clients_id is auto-resolved from the invoice.",
    {
    id: coerceId.describe("Transaction ID"),
      distributions: jsonObjectArrayInput.optional().describe(
        "Array of distribution rows: [{related_table, related_id, related_sub_id?, amount}]. Legacy callers may still pass a JSON array string. " +
      "related_table values: 'accounts' (book to a GL account), 'purchase_invoices', 'sale_invoices'. " +
      "related_id is REQUIRED for all three related_table values (the account ID, purchase-invoice ID, or sale-invoice ID). " +
      "related_sub_id is REQUIRED when related_table='accounts' and the account has dimensions — " +
      "pass the dimension ID there (e.g. 1360 'Arveldused aruandvate isikutega' with sub-account per person). " +
      "Without related_sub_id the API rejects with 'Entry cannot be made directly to the account ... since it has dimensions'. " +
      "Use list_account_dimensions to look up dimension IDs for an account."
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
      if (clientsIdWasSet) {
        try {
          await api.transactions.update(id, { clients_id: null } as Partial<Transaction>);
        } catch { /* best effort rollback */ }
      }
      throw error;
    }
    logAudit({
      tool: "confirm_transaction", action: "CONFIRMED", entity_type: "transaction", entity_id: id,
      summary: `Confirmed transaction ${id}`,
      details: { distributions: dist?.map(d => ({ related_table: d.related_table, related_id: d.related_id, related_sub_id: d.related_sub_id, amount: d.amount })) },
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "update_transaction", "Update transaction metadata fields such as bank reference, counterparty name, bank account number, description, or payment reference.", {
    id: coerceId.describe("Transaction ID"),
    data: jsonObjectInput.describe("Object with allowed metadata fields only: bank_ref_number, bank_account_name, bank_account_no, description, ref_number. Legacy callers may still pass a JSON object string."),
  }, { ...mutate, title: "Update Transaction" }, async ({ id, data }) => {
    const parsed = parseJsonObject(data, "data");
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
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "invalidate_transaction",
    "Invalidate (unconfirm) a confirmed transaction. Returns it to unconfirmed status for editing or deletion.",
    idParam.shape, { ...mutate, title: "Invalidate Transaction" }, async ({ id }) => {
      const result = await api.transactions.invalidate(id);
      logAudit({
        tool: "invalidate_transaction", action: "INVALIDATED", entity_type: "transaction", entity_id: id,
        summary: `Invalidated transaction ${id}`,
        details: {},
      });
      return { content: [{ type: "text", text: toMcpJson(result) }] };
    });

  registerTool(server, "delete_transaction", "Delete a transaction", idParam.shape, { ...destructive, title: "Delete Transaction" }, async ({ id }) => {
    const result = await api.transactions.delete(id);
    logAudit({
      tool: "delete_transaction", action: "DELETED", entity_type: "transaction", entity_id: id,
      summary: `Deleted transaction ${id}`,
      details: {},
    });
    return { content: [{ type: "text", text: toMcpJson(result) }] };
  });

  registerTool(server, "batch_delete_transactions",
    "Delete multiple unconfirmed (PROJECT) transactions in one call. IRREVERSIBLE. " +
    "Runs sequentially; CONFIRMED transactions are skipped with a clear reason (they must be invalidated first). " +
    "Transient API errors on the pre-delete lookup are surfaced as `lookup_failed` so they can be retried, " +
    "distinct from `skipped_missing` (the transaction no longer exists).",
    {
      ids: z.array(z.number().int().positive()).min(1).max(500).describe("Transaction IDs (positive integers, 1-500 entries)"),
      reason: z.string().min(1).max(500).describe("Short audit note explaining why this batch is being deleted (e.g. 're-import duplicates of confirmed journals'). Required — max 500 chars."),
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
