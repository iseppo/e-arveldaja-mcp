import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiContext } from "./crud-tools.js";
import type { Journal, Posting } from "../types/api.js";

interface BalanceDetail {
  journal_id: number;
  date: string;
  title: string;
  type: "D" | "C";
  amount: number;
  client_id?: number | null;
}

async function computeAccountBalance(
  api: ApiContext,
  accountId: number,
  clientId?: number,
  dateFrom?: string,
  dateTo?: string
): Promise<{ balance: number; debitTotal: number; creditTotal: number; entries: BalanceDetail[] }> {
  // Fetch all journals (list may not include postings)
  const allJournals = await api.journals.listAll();

  let debitTotal = 0;
  let creditTotal = 0;
  const entries: BalanceDetail[] = [];

  for (const journal of allJournals) {
    if (journal.is_deleted) continue;
    if (!journal.registered) continue; // Only include registered/confirmed journals

    // Date filters
    if (dateFrom && journal.effective_date < dateFrom) continue;
    if (dateTo && journal.effective_date > dateTo) continue;

    // Client filter
    if (clientId !== undefined && journal.clients_id !== clientId) continue;

    // If list response doesn't include postings, fetch individual journal
    let postings = journal.postings;
    if (!postings || postings.length === 0) {
      const detailed = await api.journals.get(journal.id!);
      postings = detailed.postings;
    }
    if (!postings) continue;

    for (const posting of postings) {
      if (posting.accounts_id !== accountId) continue;
      if (posting.is_deleted) continue;

      const type = posting.type;
      if (type !== "D" && type !== "C") continue; // skip malformed postings

      // Use base_amount (EUR) for multi-currency safety, fall back to amount
      const amount = posting.base_amount ?? posting.amount;

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

  // Get account to determine balance type
  const account = await api.readonly.getAccount(accountId);
  const balanceType = account?.balance_type ?? "D";

  // For D-type accounts (assets, expenses): balance = debit - credit
  // For C-type accounts (liabilities, equity, income): balance = credit - debit
  const balance = balanceType === "D"
    ? debitTotal - creditTotal
    : creditTotal - debitTotal;

  // Sort by date
  entries.sort((a, b) => a.date.localeCompare(b.date));

  return { balance, debitTotal, creditTotal, entries };
}

export function registerAccountBalanceTools(server: McpServer, api: ApiContext): void {

  server.tool("compute_account_balance",
    "Compute account balance from journal postings (D/C logic). " +
    "For liability accounts (C-type): balance = credits - debits. " +
    "For asset accounts (D-type): balance = debits - credits. " +
    "Can filter by client and date range.",
    {
      account_id: z.number().describe("Account number (e.g. 2110 for short-term loans)"),
      client_id: z.number().optional().describe("Filter by client ID"),
      date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
      include_entries: z.boolean().optional().describe("Include individual entries in response (default false)"),
    },
    async ({ account_id, client_id, date_from, date_to, include_entries }) => {
      const result = await computeAccountBalance(api, account_id, client_id, date_from, date_to);

      const account = await api.readonly.getAccount(account_id);
      const summary = {
        account_id,
        account_name: account ? `${account.name_est} / ${account.name_eng}` : "Unknown",
        balance_type: account?.balance_type ?? "?",
        balance: Math.round(result.balance * 100) / 100,
        debit_total: Math.round(result.debitTotal * 100) / 100,
        credit_total: Math.round(result.creditTotal * 100) / 100,
        entry_count: result.entries.length,
        ...(client_id !== undefined && { client_id }),
        ...(date_from && { date_from }),
        ...(date_to && { date_to }),
        ...(include_entries && { entries: result.entries }),
      };

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool("compute_client_debt",
    "Compute how much the company owes to a specific client (or vice versa). " +
    "Checks accounts 2110 (short-term loans), 2310 (accounts payable), 1210 (accounts receivable) by default. " +
    "Override account_ids for other accounts. Uses journal D/C postings.",
    {
      client_id: z.number().describe("Client ID"),
      account_ids: z.string().optional().describe("Comma-separated account IDs to check (default: 2110,2310,1210)"),
    },
    async ({ client_id, account_ids }) => {
      const ids = account_ids
        ? account_ids.split(",").map(s => parseInt(s.trim()))
        : [2110, 2310, 1210]; // short-term loans, accounts payable, accounts receivable

      const results = [];
      for (const accountId of ids) {
        const { balance, debitTotal, creditTotal, entries } = await computeAccountBalance(
          api, accountId, client_id
        );
        const account = await api.readonly.getAccount(accountId);
        results.push({
          account_id: accountId,
          account_name: account ? account.name_est : "Unknown",
          balance_type: account?.balance_type,
          balance: Math.round(balance * 100) / 100,
          debit_total: Math.round(debitTotal * 100) / 100,
          credit_total: Math.round(creditTotal * 100) / 100,
          entry_count: entries.length,
        });
      }

      const totalDebt = results
        .filter(r => r.balance_type === "C") // liability accounts
        .reduce((sum, r) => sum + r.balance, 0);

      const totalReceivable = results
        .filter(r => r.balance_type === "D") // asset accounts
        .reduce((sum, r) => sum + r.balance, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            client_id,
            accounts: results,
            summary: {
              total_debt_to_client: Math.round(totalDebt * 100) / 100,
              total_receivable_from_client: Math.round(totalReceivable * 100) / 100,
              net_position: Math.round((totalReceivable - totalDebt) * 100) / 100,
            },
          }, null, 2),
        }],
      };
    }
  );
}
