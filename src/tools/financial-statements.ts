import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiContext } from "./crud-tools.js";
import type { Account, SaleInvoice, PurchaseInvoice } from "../types/api.js";

interface AccountBalance {
  account_id: number;
  name_est: string;
  name_eng: string;
  balance_type: string;
  account_type_est: string;
  debit_total: number;
  credit_total: number;
  balance: number;
}

async function computeAllBalances(
  api: ApiContext,
  dateFrom?: string,
  dateTo?: string
): Promise<AccountBalance[]> {
  const accounts = await api.readonly.getAccounts();
  const allJournals = await api.journals.listAllWithPostings();

  const balances = new Map<number, { debit: number; credit: number }>();

  for (const journal of allJournals) {
    if (journal.is_deleted) continue;
    if (!journal.registered) continue;
    if (dateFrom && journal.effective_date < dateFrom) continue;
    if (dateTo && journal.effective_date > dateTo) continue;

    if (!journal.postings) continue;

    for (const posting of journal.postings) {
      if (posting.is_deleted) continue;
      if (posting.type !== "D" && posting.type !== "C") continue;

      const amount = posting.base_amount ?? posting.amount;
      const entry = balances.get(posting.accounts_id) ?? { debit: 0, credit: 0 };

      if (posting.type === "D") entry.debit += amount;
      else entry.credit += amount;

      balances.set(posting.accounts_id, entry);
    }
  }

  const result: AccountBalance[] = [];
  for (const account of accounts) {
    const entry = balances.get(account.id);
    if (!entry) continue;

    const balance = account.balance_type === "D"
      ? entry.debit - entry.credit
      : entry.credit - entry.debit;

    if (Math.abs(balance) < 0.005 && entry.debit === 0 && entry.credit === 0) continue;

    result.push({
      account_id: account.id,
      name_est: account.name_est,
      name_eng: account.name_eng,
      balance_type: account.balance_type,
      account_type_est: account.account_type_est,
      debit_total: Math.round(entry.debit * 100) / 100,
      credit_total: Math.round(entry.credit * 100) / 100,
      balance: Math.round(balance * 100) / 100,
    });
  }

  result.sort((a, b) => a.account_id - b.account_id);
  return result;
}

/**
 * Sum balances for a category, accounting for contra-accounts.
 * "D" categories (Varad, Kulud): D-type adds, C-type subtracts (contra-accounts).
 * "C" categories (Kohustused, Omakapital, Tulud): C-type adds, D-type subtracts.
 */
function sumCategory(accounts: AccountBalance[], normalType: "D" | "C"): number {
  let total = 0;
  for (const a of accounts) {
    if (a.balance_type === normalType) {
      total += a.balance;
    } else {
      total -= a.balance; // contra-account
    }
  }
  return total;
}

export function registerFinancialStatementTools(server: McpServer, api: ApiContext): void {

  server.tool("compute_trial_balance",
    "Compute trial balance (käibeandmik/proovibilanss) from journal postings. " +
    "Shows debit/credit totals and balance for each account.",
    {
      date_from: z.string().optional().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Period end (YYYY-MM-DD)"),
    },
    async ({ date_from, date_to }) => {
      const balances = await computeAllBalances(api, date_from, date_to);

      const totalDebit = balances.reduce((s, b) => s + b.debit_total, 0);
      const totalCredit = balances.reduce((s, b) => s + b.credit_total, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: { from: date_from ?? "inception", to: date_to ?? "now" },
            accounts: balances,
            totals: {
              debit: Math.round(totalDebit * 100) / 100,
              credit: Math.round(totalCredit * 100) / 100,
              difference: Math.round((totalDebit - totalCredit) * 100) / 100,
            },
            account_count: balances.length,
          }, null, 2),
        }],
      };
    }
  );

  server.tool("compute_balance_sheet",
    "Compute balance sheet (bilanss) from journal postings. " +
    "Groups accounts into Varad (Assets) and Kohustused+Omakapital (Liabilities+Equity).",
    {
      date_to: z.string().optional().describe("Balance sheet date (YYYY-MM-DD, default: today)"),
    },
    async ({ date_to }) => {
      const balances = await computeAllBalances(api, undefined, date_to);

      const assets = balances.filter(b => b.account_type_est === "Varad");
      const liabilities = balances.filter(b => b.account_type_est === "Kohustused");
      const equity = balances.filter(b => b.account_type_est === "Omakapital");

      const totalAssets = sumCategory(assets, "D");
      const totalLiabilities = sumCategory(liabilities, "C");
      const totalEquity = sumCategory(equity, "C");

      // Current-year P&L (informational, NOT added to equity total to avoid
      // double-counting when year-end closing entries have moved profit into equity)
      const revenue = balances.filter(b => b.account_type_est === "Tulud");
      const expenses = balances.filter(b => b.account_type_est === "Kulud");
      const totalRevenue = sumCategory(revenue, "C");
      const totalExpenses = sumCategory(expenses, "D");
      const currentYearPL = totalRevenue - totalExpenses;

      const warnings: string[] = [];
      if (Math.abs(currentYearPL) > 0.01) {
        warnings.push(
          `Open P&L accounts show ${Math.round(currentYearPL * 100) / 100} EUR net profit. ` +
          `If year-end closing entries have NOT been posted, add this to equity for the true balance.`
        );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: date_to ?? "current",
            assets: {
              items: assets.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })),
              total: Math.round(totalAssets * 100) / 100,
            },
            liabilities: {
              items: liabilities.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })),
              total: Math.round(totalLiabilities * 100) / 100,
            },
            equity: {
              items: equity.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })),
              total: Math.round(totalEquity * 100) / 100,
            },
            current_year_pl: {
              revenue: Math.round(totalRevenue * 100) / 100,
              expenses: Math.round(totalExpenses * 100) / 100,
              net_profit: Math.round(currentYearPL * 100) / 100,
              note: "Not included in equity total. Add manually if closing entries have not been posted.",
            },
            check: {
              assets: Math.round(totalAssets * 100) / 100,
              liabilities_plus_equity: Math.round((totalLiabilities + totalEquity) * 100) / 100,
              balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01,
              balanced_with_pl: Math.abs(totalAssets - totalLiabilities - totalEquity - currentYearPL) < 0.01,
            },
            ...(warnings.length > 0 && { warnings }),
          }, null, 2),
        }],
      };
    }
  );

  server.tool("compute_profit_and_loss",
    "Compute profit and loss statement (kasumiaruanne) for a period. " +
    "Shows revenue minus expenses.",
    {
      date_from: z.string().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().describe("Period end (YYYY-MM-DD)"),
    },
    async ({ date_from, date_to }) => {
      const balances = await computeAllBalances(api, date_from, date_to);

      const revenue = balances.filter(b => b.account_type_est === "Tulud");
      const expenses = balances.filter(b => b.account_type_est === "Kulud");

      const totalRevenue = sumCategory(revenue, "C");
      const totalExpenses = sumCategory(expenses, "D");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: { from: date_from, to: date_to },
            revenue: {
              items: revenue.map(a => ({ id: a.account_id, name: a.name_est, amount: a.balance })),
              total: Math.round(totalRevenue * 100) / 100,
            },
            expenses: {
              items: expenses.map(a => ({ id: a.account_id, name: a.name_est, amount: a.balance })),
              total: Math.round(totalExpenses * 100) / 100,
            },
            net_profit: Math.round((totalRevenue - totalExpenses) * 100) / 100,
          }, null, 2),
        }],
      };
    }
  );

  server.tool("month_end_close_checklist",
    "Generate month-end close checklist: unconfirmed journals/invoices, " +
    "unreconciled bank transactions, overdue receivables/payables.",
    {
      month: z.string().describe("Month to check (YYYY-MM, e.g. 2026-02)"),
    },
    async ({ month }) => {
      const dateFrom = `${month}-01`;
      const lastDay = new Date(parseInt(month.split("-")[0]!), parseInt(month.split("-")[1]!), 0).getDate();
      const dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;

      // Unconfirmed journals
      const allJournals = await api.journals.listAll();
      const unconfirmedJournals = allJournals.filter(j =>
        !j.is_deleted && !j.registered &&
        j.effective_date >= dateFrom && j.effective_date <= dateTo
      );

      // Unconfirmed transactions
      const allTx = await api.transactions.listAll();
      const unconfirmedTx = allTx.filter(tx =>
        !tx.is_deleted && tx.status !== "CONFIRMED" &&
        tx.date >= dateFrom && tx.date <= dateTo
      );

      // Unconfirmed invoices
      const allSales = await api.saleInvoices.listAll();
      const unconfirmedSales = allSales.filter((inv: SaleInvoice) =>
        inv.status === "PROJECT" &&
        inv.create_date >= dateFrom && inv.create_date <= dateTo
      );

      const allPurchases = await api.purchaseInvoices.listAll();
      const unconfirmedPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.status === "PROJECT" &&
        inv.create_date >= dateFrom && inv.create_date <= dateTo
      );

      // Overdue receivables (compare to month-end date for reproducibility)
      const overdueReceivables = allSales.filter((inv: SaleInvoice) => {
        if (inv.payment_status === "PAID" || inv.status !== "CONFIRMED") return false;
        const d = new Date(inv.create_date + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + inv.term_days);
        return d.toISOString().split("T")[0]! < dateTo;
      });

      const overduePayables = allPurchases.filter((inv: PurchaseInvoice) => {
        if (inv.payment_status === "PAID" || inv.status !== "CONFIRMED") return false;
        const d = new Date(inv.create_date + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + inv.term_days);
        return d.toISOString().split("T")[0]! < dateTo;
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            month,
            unconfirmed_journals: {
              count: unconfirmedJournals.length,
              items: unconfirmedJournals.map(j => ({ id: j.id, date: j.effective_date, title: j.title })),
            },
            unconfirmed_transactions: {
              count: unconfirmedTx.length,
              items: unconfirmedTx.map(tx => ({ id: tx.id, date: tx.date, amount: tx.amount, description: tx.description })),
            },
            unconfirmed_sale_invoices: {
              count: unconfirmedSales.length,
              items: unconfirmedSales.map((inv: SaleInvoice) => ({ id: inv.id, number: inv.number, client: inv.client_name, gross: inv.gross_price })),
            },
            unconfirmed_purchase_invoices: {
              count: unconfirmedPurchases.length,
              items: unconfirmedPurchases.map((inv: PurchaseInvoice) => ({ id: inv.id, number: inv.number, client: inv.client_name, gross: inv.gross_price })),
            },
            overdue_receivables: {
              count: overdueReceivables.length,
              total: Math.round(overdueReceivables.reduce((s: number, inv: SaleInvoice) => s + (inv.gross_price ?? 0), 0) * 100) / 100,
              items: overdueReceivables.slice(0, 10).map((inv: SaleInvoice) => ({ id: inv.id, number: inv.number, client: inv.client_name, gross: inv.gross_price })),
            },
            overdue_payables: {
              count: overduePayables.length,
              total: Math.round(overduePayables.reduce((s: number, inv: PurchaseInvoice) => s + (inv.gross_price ?? 0), 0) * 100) / 100,
              items: overduePayables.slice(0, 10).map((inv: PurchaseInvoice) => ({ id: inv.id, number: inv.number, client: inv.client_name, gross: inv.gross_price })),
            },
            summary: {
              issues_found: unconfirmedJournals.length + unconfirmedTx.length +
                unconfirmedSales.length + unconfirmedPurchases.length +
                overdueReceivables.length + overduePayables.length,
              ready_to_close: unconfirmedJournals.length === 0 && unconfirmedTx.length === 0 &&
                unconfirmedSales.length === 0 && unconfirmedPurchases.length === 0,
            },
          }, null, 2),
        }],
      };
    }
  );
}
