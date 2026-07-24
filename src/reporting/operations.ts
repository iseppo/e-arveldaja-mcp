import type { OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { PurchaseInvoice, SaleInvoice } from "../types/api.js";
import { roundMoney, effectiveGross } from "../money.js";
import { loadOpeningBalanceJournal } from "../opening-balance-journal.js";
import { computeAllBalances, sumCategory, gatherMonthEndScan } from "../tools/financial-statements.js";
import { computeAgingBuckets, type AgingInvoiceInput } from "../tools/aging-analysis.js";
import { computeMissingDocuments } from "../tools/document-audit.js";
import type {
  AccountingReportResult,
  AgingSide,
  MonthEndInvoiceRow,
  ReportingOperations,
  RunAccountingReportInput,
} from "./types.js";

function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}
function fail<T>(code: string, message: string): OperationOutcome<T> {
  return { ok: false, error: { code, message, retry: "never" }, blockers: [] };
}

// Thin formatter over the shared pure aging core (src/tools/aging-analysis.ts).
// The bucketing math lives in ONE place (computeAgingBuckets) so the typed op
// can never drift from the compute_*_aging granular handlers; here we only add
// the op's own warnings and AgingSide shape.
function computeAgingSide(invoices: readonly AgingInvoiceInput[], today: string, party: "client" | "supplier"): AgingSide {
  const c = computeAgingBuckets(invoices, today);
  const warnings: string[] = [];
  if (c.partially_paid_count > 0) {
    warnings.push(`${c.partially_paid_count} partially paid invoice(s) shown at full face value — actual outstanding balance is lower. The API does not expose remaining balance.`);
  }
  if (c.missing_term_days_count > 0) {
    warnings.push(`${c.missing_term_days_count} invoice(s) have no term_days set — treated as due on the issue date (term_days=0) for aging purposes.`);
  }
  if (c.unmatched.count > 0) {
    warnings.push(`${c.unmatched.count} invoice(s) have no clients_id (totaling ${roundMoney(c.unmatched.total)} EUR). Investigate and link to a ${party} for accurate reports.`);
  }

  return {
    total_unpaid_face_value: c.total_unpaid_face_value,
    total_invoices: c.total_invoices,
    partially_paid_count: c.partially_paid_count,
    aging_buckets: c.aging_buckets,
    top_parties: c.top_parties,
    ...(c.unmatched.count > 0 ? { unmatched: c.unmatched } : {}),
    warnings,
  };
}

function getMonthLastDay(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
}

class ReportingOperationsImpl implements ReportingOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly enableSales: boolean,
  ) {}

  async run(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    switch (input.report) {
      case "trial_balance": return this.trialBalance(input);
      case "balance_sheet": return this.balanceSheet(input);
      case "profit_and_loss": return this.profitAndLoss(input);
      case "aging": return this.aging(input);
      case "month_end": return this.monthEnd(input);
      case "missing_documents": return this.missingDocuments(input);
      default:
        return fail("invalid_report", `Unknown report "${String((input as { report?: unknown }).report)}".`);
    }
  }

  private async loadJournals() {
    const [opening, journalsFromApi] = await Promise.all([
      loadOpeningBalanceJournal(this.api),
      this.api.journals.listAllWithPostings(),
    ]);
    return [...(opening ? [opening.journal] : []), ...journalsFromApi];
  }

  private async trialBalance(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const from = input.period?.from;
    const to = input.period?.to;
    const allJournals = await this.loadJournals();
    const balances = await computeAllBalances(this.api, from, to, { preloadedJournals: allJournals });
    return ok({
      report: "trial_balance",
      period: { from: from ?? "inception", to: to ?? "now" },
      accounts: balances,
      account_count: balances.length,
      totals: {
        debit: roundMoney(balances.totalDebit),
        credit: roundMoney(balances.totalCredit),
        difference: roundMoney(balances.totalDebit - balances.totalCredit),
      },
      warnings: [],
    });
  }

  private async balanceSheet(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const to = input.period?.to;
    const allJournals = await this.loadJournals();
    const balances = await computeAllBalances(this.api, undefined, to, { preloadedJournals: allJournals });

    const assets = balances.filter(b => b.account_type_est === "Varad");
    const liabilities = balances.filter(b => b.account_type_est === "Kohustused");
    const equity = balances.filter(b => b.account_type_est === "Omakapital");
    const revenue = balances.filter(b => b.account_type_est === "Tulud");
    const expenses = balances.filter(b => b.account_type_est === "Kulud");

    const totalAssets = sumCategory(assets, "D");
    const totalLiabilities = sumCategory(liabilities, "C");
    const totalEquity = sumCategory(equity, "C");
    const totalRevenue = sumCategory(revenue, "C");
    const totalExpenses = sumCategory(expenses, "D");
    const currentYearPL = totalRevenue - totalExpenses;
    const totalEquityWithPL = totalEquity + currentYearPL;

    const warnings: string[] = [];
    if (Math.abs(currentYearPL) > 0.01) {
      warnings.push(`Open P&L accounts show ${roundMoney(currentYearPL)} EUR net profit, included in equity for the balance check and normally closed into equity at year-end.`);
    }

    return ok({
      report: "balance_sheet",
      date: to ?? "current",
      assets: { items: assets.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })), total: roundMoney(totalAssets) },
      liabilities: { items: liabilities.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })), total: roundMoney(totalLiabilities) },
      equity: { items: equity.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance })), total: roundMoney(totalEquityWithPL) },
      current_year_pl: { revenue: roundMoney(totalRevenue), expenses: roundMoney(totalExpenses), net_profit: roundMoney(currentYearPL) },
      check: {
        assets: roundMoney(totalAssets),
        liabilities_plus_equity: roundMoney(totalLiabilities + totalEquityWithPL),
        balanced: Math.abs(totalAssets - totalLiabilities - totalEquityWithPL) < 0.01,
      },
      warnings,
    });
  }

  private async profitAndLoss(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const from = input.period?.from;
    const to = input.period?.to;
    if (from === undefined || to === undefined) {
      return fail("period_required", "profit_and_loss requires period.from and period.to (YYYY-MM-DD).");
    }
    const allJournals = await this.loadJournals();
    const balances = await computeAllBalances(this.api, from, to, { preloadedJournals: allJournals });
    const revenue = balances.filter(b => b.account_type_est === "Tulud");
    const expenses = balances.filter(b => b.account_type_est === "Kulud");
    const totalRevenue = sumCategory(revenue, "C");
    const totalExpenses = sumCategory(expenses, "D");
    return ok({
      report: "profit_and_loss",
      period: { from, to },
      revenue: { items: revenue.map(a => ({ id: a.account_id, name: a.name_est, amount: a.balance })), total: roundMoney(totalRevenue) },
      expenses: { items: expenses.map(a => ({ id: a.account_id, name: a.name_est, amount: a.balance })), total: roundMoney(totalExpenses) },
      net_profit: roundMoney(totalRevenue - totalExpenses),
      warnings: [],
    });
  }

  private async aging(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const actualToday = new Date().toISOString().split("T")[0]!;
    const today = input.asOfDate ?? actualToday;
    const [allSales, allPurchases] = await Promise.all([
      this.enableSales ? this.api.saleInvoices.listAll() : Promise.resolve([] as SaleInvoice[]),
      this.api.purchaseInvoices.listAll(),
    ]);
    const payables = computeAgingSide(allPurchases as AgingInvoiceInput[], today, "supplier");
    const receivables = this.enableSales ? computeAgingSide(allSales as AgingInvoiceInput[], today, "client") : undefined;
    return ok({
      report: "aging",
      as_of_date: today,
      ...(receivables ? { receivables } : {}),
      payables,
    });
  }

  private async monthEnd(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const month = input.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return fail("month_required", "month_end requires month in YYYY-MM format.");
    }
    const dateFrom = `${month}-01`;
    const lastDay = getMonthLastDay(month);
    const dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;

    const [allJournals, allTx, allSales, allPurchases] = await Promise.all([
      this.api.journals.listAll(),
      this.api.transactions.listAll(),
      this.enableSales ? this.api.saleInvoices.listAll() : Promise.resolve([] as SaleInvoice[]),
      this.api.purchaseInvoices.listAll(),
    ]);

    const {
      unconfirmedJournals,
      unconfirmedTransactions: unconfirmedTx,
      unconfirmedSales,
      unconfirmedPurchases,
      overdueReceivables,
      overduePayables,
      missingTermDays,
      partiallyPaidReceivables,
      partiallyPaidPayables,
    } = gatherMonthEndScan({
      journals: allJournals,
      transactions: allTx,
      saleInvoices: allSales,
      purchaseInvoices: allPurchases,
      dateFrom,
      dateTo,
    });

    const invRow = (inv: SaleInvoice | PurchaseInvoice): MonthEndInvoiceRow => ({
      id: inv.id!,
      number: inv.number ?? "",
      client: inv.client_name ?? "",
      gross: effectiveGross(inv),
      payment_status: inv.payment_status ?? "NOT_PAID",
    });

    const warnings: string[] = [];
    if (partiallyPaidReceivables > 0) warnings.push(`${partiallyPaidReceivables} overdue receivable(s) are PARTIALLY_PAID and shown at full invoice amount; remaining balance may be lower.`);
    if (partiallyPaidPayables > 0) warnings.push(`${partiallyPaidPayables} overdue payable(s) are PARTIALLY_PAID and shown at full invoice amount; remaining balance may be lower.`);
    if (missingTermDays.length > 0) warnings.push(`${missingTermDays.length} invoice(s) had no term_days; treated as 0-day terms for the overdue check.`);

    const issuesFound = unconfirmedJournals.length + unconfirmedTx.length + unconfirmedSales.length + unconfirmedPurchases.length + overdueReceivables.length + overduePayables.length;

    return ok({
      report: "month_end",
      month,
      unconfirmed_journals: { count: unconfirmedJournals.length, items: unconfirmedJournals.map(j => ({ id: j.id!, date: j.effective_date, title: j.title ?? "" })) },
      unconfirmed_transactions: { count: unconfirmedTx.length, items: unconfirmedTx.map(tx => ({ id: tx.id!, date: tx.date, amount: tx.amount, description: tx.description ?? "" })) },
      ...(this.enableSales ? { unconfirmed_sale_invoices: { count: unconfirmedSales.length, items: unconfirmedSales.map(invRow) } } : {}),
      unconfirmed_purchase_invoices: { count: unconfirmedPurchases.length, items: unconfirmedPurchases.map(invRow) },
      ...(this.enableSales ? { overdue_receivables: { count: overdueReceivables.length, total: roundMoney(overdueReceivables.reduce((s: number, inv: SaleInvoice) => s + effectiveGross(inv), 0)), items: overdueReceivables.slice(0, 10).map(invRow) } } : {}),
      overdue_payables: { count: overduePayables.length, total: roundMoney(overduePayables.reduce((s: number, inv: PurchaseInvoice) => s + effectiveGross(inv), 0)), items: overduePayables.slice(0, 10).map(invRow) },
      summary: {
        issues_found: issuesFound,
        ready_to_close: unconfirmedJournals.length === 0 && unconfirmedTx.length === 0 && unconfirmedSales.length === 0 && unconfirmedPurchases.length === 0,
      },
      warnings,
    });
  }

  private async missingDocuments(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const core = await computeMissingDocuments(this.api, {
      ...(input.period?.from !== undefined ? { date_from: input.period.from } : {}),
      ...(input.period?.to !== undefined ? { date_to: input.period.to } : {}),
    });
    return ok({ report: "missing_documents", ...core });
  }
}

export function createReportingOperations(api: ApiContext, enableSales: boolean): ReportingOperations {
  return new ReportingOperationsImpl(api, enableSales);
}
