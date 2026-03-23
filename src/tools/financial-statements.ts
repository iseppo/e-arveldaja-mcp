import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import type { ApiContext } from "./crud-tools.js";
import type { Account, Journal, SaleInvoice, PurchaseInvoice } from "../types/api.js";
import { roundMoney, effectiveGross } from "../money.js";
import { readOnly } from "../annotations.js";
import { isProjectTransaction } from "../transaction-status.js";

export interface AccountBalance {
  account_id: number;
  name_est: string;
  name_eng: string;
  balance_type: string;
  account_type_est: string;
  debit_total: number;
  credit_total: number;
  balance: number;
}

export async function computeAllBalances(
  api: ApiContext,
  dateFrom?: string,
  dateTo?: string,
  options?: {
    preloadedAccounts?: Account[];
    preloadedJournals?: Journal[];
    journalFilter?: (journal: Journal) => boolean;
  },
): Promise<AccountBalance[]> {
  const accounts = options?.preloadedAccounts ?? await api.readonly.getAccounts();
  const allJournals = options?.preloadedJournals ?? await api.journals.listAllWithPostings();
  const journalFilter = options?.journalFilter;

  const balances = new Map<number, { debit: number; credit: number }>();

  for (const journal of allJournals) {
    if (journal.is_deleted) continue;
    if (!journal.registered) continue;
    if (dateFrom && journal.effective_date < dateFrom) continue;
    if (dateTo && journal.effective_date > dateTo) continue;
    if (journalFilter && !journalFilter(journal)) continue;

    if (!journal.postings) continue;

    for (const posting of journal.postings) {
      if (posting.is_deleted) continue;
      if (posting.type !== "D" && posting.type !== "C") continue;

      const amount = posting.base_amount ?? posting.amount;
      const entry = balances.get(posting.accounts_id) ?? { debit: 0, credit: 0 };

      if (posting.type === "D") entry.debit = roundMoney(entry.debit + amount);
      else entry.credit = roundMoney(entry.credit + amount);

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
      debit_total: roundMoney(entry.debit),
      credit_total: roundMoney(entry.credit),
      balance: roundMoney(balance),
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
  return roundMoney(total);
}

function getMonthLastDay(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
}

const monthRegex = /^\d{4}-\d{2}$/;

export function registerFinancialStatementTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "compute_trial_balance",
    "Compute trial balance (käibeandmik/proovibilanss) from journal postings. " +
    "Shows debit/credit totals and balance for each account.",
    {
      date_from: z.string().optional().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Period end (YYYY-MM-DD)"),
    },
    { ...readOnly, title: "Compute Trial Balance" },
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
              debit: roundMoney(totalDebit),
              credit: roundMoney(totalCredit),
              difference: roundMoney(totalDebit - totalCredit),
            },
            account_count: balances.length,
          }, null, 2),
        }],
      };
    }
  );

  registerTool(server, "compute_balance_sheet",
    "Compute balance sheet (bilanss) from journal postings. " +
    "Groups accounts into Varad (Assets) and Kohustused+Omakapital (Liabilities+Equity).",
    {
      date_to: z.string().optional().describe("Balance sheet date (YYYY-MM-DD, default: today)"),
    },
    { ...readOnly, title: "Compute Balance Sheet" },
    async ({ date_to }) => {
      const balances = await computeAllBalances(api, undefined, date_to);

      const assets = balances.filter(b => b.account_type_est === "Varad");
      const liabilities = balances.filter(b => b.account_type_est === "Kohustused");
      const equity = balances.filter(b => b.account_type_est === "Omakapital");

      const totalAssets = sumCategory(assets, "D");
      const totalLiabilities = sumCategory(liabilities, "C");
      const totalEquity = sumCategory(equity, "C");

      // Current-year P&L is included in equity total for in-year balance sheet checks.
      const revenue = balances.filter(b => b.account_type_est === "Tulud");
      const expenses = balances.filter(b => b.account_type_est === "Kulud");
      const totalRevenue = sumCategory(revenue, "C");
      const totalExpenses = sumCategory(expenses, "D");
      const currentYearPL = totalRevenue - totalExpenses;
      const totalEquityWithCurrentYearPL = totalEquity + currentYearPL;

      const warnings: string[] = [];
      if (Math.abs(currentYearPL) > 0.01) {
        warnings.push(
          `Open P&L accounts show ${roundMoney(currentYearPL)} EUR net profit. ` +
          `This amount is included in equity for the balance check and should normally be closed into equity at year-end.`
        );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: date_to ?? "current",
            assets: {
              items: assets.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })),
              total: roundMoney(totalAssets),
            },
            liabilities: {
              items: liabilities.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })),
              total: roundMoney(totalLiabilities),
            },
            equity: {
              items: equity.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })),
              total: roundMoney(totalEquityWithCurrentYearPL),
            },
            current_year_pl: {
              revenue: roundMoney(totalRevenue),
              expenses: roundMoney(totalExpenses),
              net_profit: roundMoney(currentYearPL),
              note: "Included in equity total and balance check.",
            },
            check: {
              assets: roundMoney(totalAssets),
              liabilities_plus_equity: roundMoney(totalLiabilities + totalEquityWithCurrentYearPL),
              balanced: Math.abs(totalAssets - totalLiabilities - totalEquityWithCurrentYearPL) < 0.01,
            },
            ...(warnings.length > 0 && { warnings }),
          }, null, 2),
        }],
      };
    }
  );

  registerTool(server, "compute_profit_and_loss",
    "Compute profit and loss statement (kasumiaruanne) for a period. " +
    "Shows revenue minus expenses.",
    {
      date_from: z.string().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().describe("Period end (YYYY-MM-DD)"),
    },
    { ...readOnly, title: "Compute Profit and Loss" },
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
              total: roundMoney(totalRevenue),
            },
            expenses: {
              items: expenses.map(a => ({ id: a.account_id, name: a.name_est, amount: a.balance })),
              total: roundMoney(totalExpenses),
            },
            net_profit: roundMoney(totalRevenue - totalExpenses),
          }, null, 2),
        }],
      };
    }
  );

  registerTool(server, "month_end_close_checklist",
    "Generate month-end close checklist: unconfirmed journals/invoices, " +
    "unreconciled bank transactions, overdue receivables/payables.",
    {
      month: z.string().regex(monthRegex, "Expected YYYY-MM").describe("Month to check (YYYY-MM, e.g. 2026-02)"),
    },
    { ...readOnly, title: "Month-End Close Checklist" },
    async ({ month }) => {
      const dateFrom = `${month}-01`;
      const lastDay = getMonthLastDay(month);
      const dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;

      const [allJournals, allTx, allSales, allPurchases] = await Promise.all([
        api.journals.listAll(),
        api.transactions.listAll(),
        api.saleInvoices.listAll(),
        api.purchaseInvoices.listAll(),
      ]);

      const unconfirmedJournals = allJournals.filter(j =>
        !j.is_deleted && !j.registered &&
        j.effective_date >= dateFrom && j.effective_date <= dateTo
      );

      const unconfirmedTx = allTx.filter(tx =>
        isProjectTransaction(tx) &&
        tx.date >= dateFrom && tx.date <= dateTo
      );

      const unconfirmedSales = allSales.filter((inv: SaleInvoice) =>
        inv.status === "PROJECT" &&
        inv.journal_date >= dateFrom && inv.journal_date <= dateTo
      );

      const unconfirmedPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.status === "PROJECT" &&
        inv.journal_date >= dateFrom && inv.journal_date <= dateTo
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

      const partiallyPaidReceivables = overdueReceivables.filter((inv: SaleInvoice) => inv.payment_status === "PARTIALLY_PAID").length;
      const partiallyPaidPayables = overduePayables.filter((inv: PurchaseInvoice) => inv.payment_status === "PARTIALLY_PAID").length;
      const warnings: string[] = [
        "Month-end due-date checks use UTC calendar dates. Borderline local-midnight cases may need manual review.",
      ];
      if (partiallyPaidReceivables > 0) {
        warnings.push(`${partiallyPaidReceivables} overdue receivable(s) are PARTIALLY_PAID and shown at full invoice amount; remaining balance may be lower.`);
      }
      if (partiallyPaidPayables > 0) {
        warnings.push(`${partiallyPaidPayables} overdue payable(s) are PARTIALLY_PAID and shown at full invoice amount; remaining balance may be lower.`);
      }

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
              items: unconfirmedSales.map((inv: SaleInvoice) => ({
                id: inv.id,
                number: inv.number,
                client: inv.client_name,
                gross: effectiveGross(inv),
                payment_status: inv.payment_status ?? "NOT_PAID",
              })),
            },
            unconfirmed_purchase_invoices: {
              count: unconfirmedPurchases.length,
              items: unconfirmedPurchases.map((inv: PurchaseInvoice) => ({
                id: inv.id,
                number: inv.number,
                client: inv.client_name,
                gross: effectiveGross(inv),
                payment_status: inv.payment_status ?? "NOT_PAID",
              })),
            },
            overdue_receivables: {
              count: overdueReceivables.length,
              total: roundMoney(overdueReceivables.reduce((s: number, inv: SaleInvoice) => s + effectiveGross(inv), 0)),
              items: overdueReceivables.slice(0, 10).map((inv: SaleInvoice) => ({
                id: inv.id,
                number: inv.number,
                client: inv.client_name,
                gross: effectiveGross(inv),
                payment_status: inv.payment_status ?? "NOT_PAID",
              })),
            },
            overdue_payables: {
              count: overduePayables.length,
              total: roundMoney(overduePayables.reduce((s: number, inv: PurchaseInvoice) => s + effectiveGross(inv), 0)),
              items: overduePayables.slice(0, 10).map((inv: PurchaseInvoice) => ({
                id: inv.id,
                number: inv.number,
                client: inv.client_name,
                gross: effectiveGross(inv),
                payment_status: inv.payment_status ?? "NOT_PAID",
              })),
            },
            summary: {
              issues_found: unconfirmedJournals.length + unconfirmedTx.length +
                unconfirmedSales.length + unconfirmedPurchases.length +
                overdueReceivables.length + overduePayables.length,
              ready_to_close: unconfirmedJournals.length === 0 && unconfirmedTx.length === 0 &&
                unconfirmedSales.length === 0 && unconfirmedPurchases.length === 0,
            },
            warnings,
          }, null, 2),
        }],
      };
    }
  );
}
