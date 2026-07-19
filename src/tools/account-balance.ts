import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import type { Journal } from "../types/api.js";
import { roundMoney } from "../money.js";
import { readOnly } from "../annotations.js";
import { DEFAULT_DEBT_CHECK_ACCOUNTS } from "../accounting-defaults.js";
import { withOpeningBalanceStatus } from "../opening-balance-limitations.js";
import { loadOpeningBalanceJournal } from "../opening-balance-journal.js";
import { cacheClearMetadata, clearRuntimeCaches } from "../cache-control.js";

interface BalanceDetail {
  journal_id: number;
  date: string;
  title: string;
  type: "D" | "C";
  amount: number;
  clients_id?: number | null;
}

interface AccountBalanceResult {
  account?: { id: number; name_est: string; name_eng: string; balance_type: string };
  balance: number;
  debitTotal: number;
  creditTotal: number;
  entries: BalanceDetail[];
}

export async function computeAccountBalance(
  api: ApiContext,
  accountId: number,
  clientId?: number,
  dateFrom?: string,
  dateTo?: string,
  preloadedJournals?: Journal[]
): Promise<AccountBalanceResult> {
  const [allJournals, account] = await Promise.all([
    preloadedJournals ?? api.journals.listAllWithPostings(),
    api.readonly.getAccount(accountId),
  ]);

  let debitTotal = 0;
  let creditTotal = 0;
  const entries: BalanceDetail[] = [];

  for (const journal of allJournals) {
    if (journal.is_deleted) continue;
    if (!journal.registered) continue;

    if (dateFrom && journal.effective_date < dateFrom) continue;
    if (dateTo && journal.effective_date > dateTo) continue;

    if (clientId !== undefined && journal.clients_id !== clientId) continue;

    if (!journal.postings) continue;

    for (const posting of journal.postings) {
      if (posting.accounts_id !== accountId) continue;
      if (posting.is_deleted) continue;

      const type = posting.type;
      if (type !== "D" && type !== "C") continue;

      const amount = posting.base_amount ?? posting.amount;

      // Accumulate unrounded; round once at the end. Rounding per-posting
      // drifts up to 0.005 EUR × N postings, so a busy account can show a
      // trial-balance mismatch for no real reason.
      if (type === "D") debitTotal += amount;
      else creditTotal += amount;

      entries.push({
        journal_id: journal.id!,
        date: journal.effective_date,
        title: journal.title ?? "",
        type: type as "D" | "C",
        amount,
        clients_id: journal.clients_id,
      });
    }
  }

  const balanceType = account?.balance_type ?? "D";

  // For D-type accounts (assets, expenses): balance = debit - credit
  // For C-type accounts (liabilities, equity, income): balance = credit - debit
  // Compute the balance from the RAW (unrounded) summed debits/credits and
  // round ONCE at the end. Rounding debitTotal/creditTotal independently
  // before subtracting them can introduce up to ±0.01 EUR of drift vs. the
  // true single-rounded net (e.g. raw D 1.005 / C 0.004 would wrongly report
  // 1.01 instead of the correct 1.00) — this balance is compared directly
  // against other rounded figures, e.g. the §157 retained-earnings check
  // against the gross dividend.
  const balance = roundMoney(
    balanceType === "D" ? debitTotal - creditTotal : creditTotal - debitTotal,
  );

  // Round debitTotal/creditTotal now, for display only — `balance` above was
  // already derived from the raw (pre-rounding) sums.
  debitTotal = roundMoney(debitTotal);
  creditTotal = roundMoney(creditTotal);

  // Sort by date
  entries.sort((a, b) => a.date.localeCompare(b.date));

  return {
    account: account ? { id: account.id, name_est: account.name_est, name_eng: account.name_eng, balance_type: account.balance_type } : undefined,
    balance,
    debitTotal,
    creditTotal,
    entries,
  };
}

export function registerAccountBalanceTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "compute_account_balance",
    "Compute account balance from journal postings with optional client/date filters.",
    {
      account_id: coerceId.describe("Account id from list_accounts. In the RIK chart the id is the account number itself (e.g. 2110, 8900)."),
      clients_id: z.number().optional().describe("Filter by client ID"),
      date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
      include_entries: z.boolean().optional().describe("Include individual entries in response (default false)"),
      fresh: z.boolean().optional().describe("Clear cached API/reference data first."),
    },
    { ...readOnly, title: "Compute Account Balance" },
    async ({ account_id, clients_id, date_from, date_to, include_entries, fresh }) => {
      const cacheClear = fresh ? clearRuntimeCaches() : undefined;
      const opening = await loadOpeningBalanceJournal(api);
      const journalsFromApi = await api.journals.listAllWithPostings();
      const allJournals = [...(opening ? [opening.journal] : []), ...journalsFromApi];
      const result = await computeAccountBalance(api, account_id, clients_id, date_from, date_to, allJournals);

      const summary = {
        account_id,
        account_name: result.account ? `${result.account.name_est} / ${result.account.name_eng}` : "Unknown",
        balance_type: result.account?.balance_type ?? "?",
        balance: roundMoney(result.balance),
        debit_total: roundMoney(result.debitTotal),
        credit_total: roundMoney(result.creditTotal),
        entry_count: result.entries.length,
        ...(clients_id !== undefined && { clients_id }),
        ...(date_from && { date_from }),
        ...(date_to && { date_to }),
        ...cacheClearMetadata(cacheClear),
        // Journal titles are operator-entered and may echo OCR-seeded
        // supplier / client names — wrap at MCP output, keep internal
        // entries[] plain for in-process computation.
        ...(include_entries && {
          entries: result.entries.map(e => ({ ...e, title: wrapUntrustedOcr(e.title) ?? e.title })),
        }),
        warnings: withOpeningBalanceStatus([], {
          captured: opening !== null,
          openingDate: opening?.openingDate,
          unmappedCodes: opening?.unmappedCodes,
        }),
      };

      return { content: [{ type: "text", text: toMcpJson(summary) }] };
    }
  );

  registerTool(server, "compute_client_debt",
    "Compute net position against a client across selected accounts.",
    {
      clients_id: coerceId.describe("Client ID"),
      account_ids: z.string().optional().describe(`Comma-separated account IDs to check (default: ${DEFAULT_DEBT_CHECK_ACCOUNTS.join(",")})`),
      fresh: z.boolean().optional().describe("Clear cached API/reference data first."),
    },
    { ...readOnly, title: "Compute Client Net Position" },
    async ({ clients_id, account_ids, fresh }) => {
      const cacheClear = fresh ? clearRuntimeCaches() : undefined;
      const ids = account_ids
        ? account_ids.split(",").map(s => parseInt(s.trim(), 10))
        : DEFAULT_DEBT_CHECK_ACCOUNTS;

      // Load journals once, share across all account balance computations
      const opening = await loadOpeningBalanceJournal(api);
      const journalsFromApi = await api.journals.listAllWithPostings();
      const allJournals = [...(opening ? [opening.journal] : []), ...journalsFromApi];

      const results = [];
      for (const accountId of ids) {
        const r = await computeAccountBalance(
          api, accountId, clients_id, undefined, undefined, allJournals
        );
        results.push({
          account_id: accountId,
          account_name: r.account?.name_est ?? "Unknown",
          balance_type: r.account?.balance_type,
          balance: roundMoney(r.balance),
          debit_total: roundMoney(r.debitTotal),
          credit_total: roundMoney(r.creditTotal),
          entry_count: r.entries.length,
        });
      }

      const totalDebt = results
        .filter(r => r.balance_type === "C") // liability accounts
        .reduce((sum, r) => sum + r.balance, 0);

      const totalReceivable = results
        .filter(r => r.balance_type === "D") // asset accounts
        .reduce((sum, r) => sum + r.balance, 0);

      const openingBalanceCaptured = opening !== null;
      const openingBalanceWarnings = withOpeningBalanceStatus([], {
        captured: openingBalanceCaptured,
        openingDate: opening?.openingDate,
        unmappedCodes: opening?.unmappedCodes,
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            clients_id,
            accounts: results,
            summary: {
              total_debt_to_client: roundMoney(totalDebt),
              total_receivable_from_client: roundMoney(totalReceivable),
              net_position: roundMoney(totalReceivable - totalDebt),
            },
            opening_balance_status: openingBalanceCaptured
              ? "complete"
              : "api_incomplete",
            balance_scope: openingBalanceCaptured
              ? "complete_balance"
              : "journal_api_visible_entries_only",
            warnings: openingBalanceWarnings,
            ...cacheClearMetadata(cacheClear),
          }),
        }],
      };
    }
  );
}
