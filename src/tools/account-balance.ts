import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import type { Journal } from "../types/api.js";
import { roundMoney } from "../money.js";
import { readOnly } from "../annotations.js";
import { DEFAULT_DEBT_CHECK_ACCOUNTS } from "../accounting-defaults.js";

interface BalanceDetail {
  journal_id: number;
  date: string;
  title: string;
  type: "D" | "C";
  amount: number;
  client_id?: number | null;
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
        client_id: journal.clients_id,
      });
    }
  }

  debitTotal = roundMoney(debitTotal);
  creditTotal = roundMoney(creditTotal);

  const balanceType = account?.balance_type ?? "D";

  // For D-type accounts (assets, expenses): balance = debit - credit
  // For C-type accounts (liabilities, equity, income): balance = credit - debit
  const balance = balanceType === "D"
    ? debitTotal - creditTotal
    : creditTotal - debitTotal;

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
    "Compute an account balance from journal postings, with optional client and date filters. Applies the account's debit/credit direction automatically.",
    {
      account_id: z.number().describe("Account number (e.g. 2110 for short-term loans)"),
      client_id: z.number().optional().describe("Filter by client ID"),
      date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
      include_entries: z.boolean().optional().describe("Include individual entries in response (default false)"),
    },
    { ...readOnly, title: "Compute Account Balance" },
    async ({ account_id, client_id, date_from, date_to, include_entries }) => {
      const result = await computeAccountBalance(api, account_id, client_id, date_from, date_to);

      const summary = {
        account_id,
        account_name: result.account ? `${result.account.name_est} / ${result.account.name_eng}` : "Unknown",
        balance_type: result.account?.balance_type ?? "?",
        balance: roundMoney(result.balance),
        debit_total: roundMoney(result.debitTotal),
        credit_total: roundMoney(result.creditTotal),
        entry_count: result.entries.length,
        ...(client_id !== undefined && { client_id }),
        ...(date_from && { date_from }),
        ...(date_to && { date_to }),
        // Journal titles are operator-entered and may echo OCR-seeded
        // supplier / client names — wrap at MCP output, keep internal
        // entries[] plain for in-process computation.
        ...(include_entries && {
          entries: result.entries.map(e => ({ ...e, title: wrapUntrustedOcr(e.title) ?? e.title })),
        }),
      };

      return { content: [{ type: "text", text: toMcpJson(summary) }] };
    }
  );

  registerTool(server, "compute_client_debt",
    "Compute how much the company owes the client and vice versa across selected accounts (default: 2110, 2310, 1210). Uses journal D/C postings.",
    {
      client_id: coerceId.describe("Client ID"),
      account_ids: z.string().optional().describe("Comma-separated account IDs to check (default: 2110,2310,1210)"),
    },
    { ...readOnly, title: "Compute Client Net Position" },
    async ({ client_id, account_ids }) => {
      const ids = account_ids
        ? account_ids.split(",").map(s => parseInt(s.trim(), 10))
        : DEFAULT_DEBT_CHECK_ACCOUNTS;

      // Load journals once, share across all account balance computations
      const allJournals = await api.journals.listAllWithPostings();

      const results = [];
      for (const accountId of ids) {
        const r = await computeAccountBalance(
          api, accountId, client_id, undefined, undefined, allJournals
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
        .reduce((sum, r) => roundMoney(sum + r.balance), 0);

      const totalReceivable = results
        .filter(r => r.balance_type === "D") // asset accounts
        .reduce((sum, r) => roundMoney(sum + r.balance), 0);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            client_id,
            accounts: results,
            summary: {
              total_debt_to_client: roundMoney(totalDebt),
              total_receivable_from_client: roundMoney(totalReceivable),
              net_position: roundMoney(totalReceivable - totalDebt),
            },
          }),
        }],
      };
    }
  );
}
