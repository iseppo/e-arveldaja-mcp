import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { Account, Journal, SaleInvoice, PurchaseInvoice, Transaction } from "../types/api.js";
import { roundMoney, effectiveGross, eurGross } from "../money.js";
import { readOnly } from "../annotations.js";
import { isProjectTransaction } from "../transaction-status.js";
import { withOpeningBalanceStatusInRange } from "../opening-balance-limitations.js";
import { loadOpeningBalanceJournal, type OpeningBalanceJournal } from "../opening-balance-journal.js";
import { cacheClearMetadata, clearRuntimeCaches } from "../cache-control.js";
import type { ToolExposureConfig } from "../config.js";
import { todayInTallinn } from "../local-date.js";
import { validateOptionalStrictDate, validateOptionalStrictDateRange } from "../strict-date.js";
import { toolError } from "../tool-error.js";
import { isYearEndClosingJournal } from "../year-end-closing-journal.js";
import { resolveCalculatedResultAccount } from "../account-resolution.js";
import type {
  BalanceSheetResult,
  MonthEndDueList,
  MonthEndDueInvoiceRow,
  ProfitAndLossResult,
  TrialBalanceResult,
} from "../reporting/types.js";

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

/**
 * `computeAllBalances`'s return value: the per-account balances array, plus
 * the RAW (pre-rounding) debit/credit grand totals rounded once, attached as
 * extra properties on the array. Summing the already-rounded per-account
 * `debit_total`/`credit_total` fields instead (independent per-account
 * rounding × N accounts) can drift the trial-balance check by more than a
 * cent even though the underlying ledger is perfectly balanced — see
 * `totalDebit`/`totalCredit` usage in `compute_trial_balance`.
 */
export type AccountBalancesResult = AccountBalance[] & { totalDebit: number; totalCredit: number };

export async function computeAllBalances(
  api: ApiContext,
  dateFrom?: string,
  dateTo?: string,
  options?: {
    preloadedAccounts?: Account[];
    preloadedJournals?: Journal[];
    journalFilter?: (journal: Journal) => boolean;
  },
): Promise<AccountBalancesResult> {
  const accounts = options?.preloadedAccounts ?? await api.readonly.getAccounts();
  const allJournals = options?.preloadedJournals ?? await api.journals.listAllWithPostings();
  const journalFilter = options?.journalFilter;

  const balances = new Map<number, { debit: number; credit: number }>();
  let totalDebitRaw = 0;
  let totalCreditRaw = 0;

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

      // Accumulate unrounded; the output mapping below rounds once. Rounding
      // on every posting drifts 0.005 EUR per entry, producing false trial-
      // balance mismatches on high-volume accounts. The grand totals below
      // are accumulated from these same raw amounts (not from the per-account
      // rounded fields) so the trial-balance check rounds once too.
      if (posting.type === "D") {
        entry.debit += amount;
        totalDebitRaw += amount;
      } else {
        entry.credit += amount;
        totalCreditRaw += amount;
      }

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

  const withTotals = result as AccountBalancesResult;
  withTotals.totalDebit = roundMoney(totalDebitRaw);
  withTotals.totalCredit = roundMoney(totalCreditRaw);
  return withTotals;
}

/**
 * Sum balances for a category, accounting for contra-accounts.
 * "D" categories (Varad, Kulud): D-type adds, C-type subtracts (contra-accounts).
 * "C" categories (Kohustused, Omakapital, Tulud): C-type adds, D-type subtracts.
 *
 * Accumulates unrounded and rounds once at the end — matches the pattern used
 * by `computeAllBalances` / `computeAccountBalance`, so tools that share this
 * helper (balance sheet, P&L, §157 net-assets check) agree bit-identically on
 * the same ledger.
 */
export function sumCategory(accounts: AccountBalance[], normalType: "D" | "C"): number {
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

// Shared report cores: compute_trial_balance / compute_balance_sheet /
// compute_profit_and_loss and the run_accounting_report ops both route through
// these, so journal loading, the opening-balance (algbilanss) fold + status
// warnings, date defaults and the year-end-close exclusion cannot drift.
async function loadLedgerJournals(api: ApiContext): Promise<{ journals: Journal[]; opening: OpeningBalanceJournal | null }> {
  const [opening, journalsFromApi] = await Promise.all([
    loadOpeningBalanceJournal(api),
    api.journals.listAllWithPostings(),
  ]);
  return { journals: [...(opening ? [opening.journal] : []), ...journalsFromApi], opening };
}

function openingBalanceWarnings(
  warnings: string[],
  opening: OpeningBalanceJournal | null,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): string[] {
  return withOpeningBalanceStatusInRange(warnings, {
    captured: opening !== null,
    openingDate: opening?.openingDate,
    unmappedCodes: opening?.unmappedCodes,
    unmappedDimensions: opening?.unmappedDimensions,
    dateFrom,
    dateTo,
  });
}

/** Trial balance. With no `dateTo` every posting counts, future-dated ones included (labelled "unbounded"). */
export async function computeTrialBalanceReport(
  api: ApiContext,
  dateFrom?: string,
  dateTo?: string,
): Promise<Omit<TrialBalanceResult, "report">> {
  const { journals, opening } = await loadLedgerJournals(api);
  const balances = await computeAllBalances(api, dateFrom, dateTo, { preloadedJournals: journals });
  // Use the raw-accumulated grand totals from computeAllBalances, not a sum of
  // the already-rounded per-account debit_total/credit_total — summing N
  // independently-rounded per-account fields can drift the trial-balance
  // check even though the ledger is perfectly balanced.
  return {
    period: { from: dateFrom ?? "inception", to: dateTo ?? "unbounded" },
    accounts: balances,
    account_count: balances.length,
    totals: {
      debit: roundMoney(balances.totalDebit),
      credit: roundMoney(balances.totalCredit),
      difference: roundMoney(balances.totalDebit - balances.totalCredit),
    },
    warnings: openingBalanceWarnings([], opening, dateFrom, dateTo),
  };
}

/** Balance sheet as of `dateTo`, defaulting to today (Europe/Tallinn) so future-dated journals stay out. */
export async function computeBalanceSheetReport(
  api: ApiContext,
  dateTo?: string,
): Promise<Omit<BalanceSheetResult, "report">> {
  const date = dateTo ?? todayInTallinn();
  const { journals, opening } = await loadLedgerJournals(api);
  // The year-end closing journal stays in: for the balance sheet it is a real
  // posting that moves the year's result into equity.
  const balances = await computeAllBalances(api, undefined, date, { preloadedJournals: journals });

  const assets = balances.filter(b => b.account_type_est === "Varad");
  const liabilities = balances.filter(b => b.account_type_est === "Kohustused");
  const equity = balances.filter(b => b.account_type_est === "Omakapital");

  const totalAssets = sumCategory(assets, "D");
  const totalLiabilities = sumCategory(liabilities, "C");
  const totalEquity = sumCategory(equity, "C");

  // Current-year P&L is included in equity total for in-year balance sheet checks.
  const totalRevenue = sumCategory(balances.filter(b => b.account_type_est === "Tulud"), "C");
  const totalExpenses = sumCategory(balances.filter(b => b.account_type_est === "Kulud"), "D");
  const currentYearPL = totalRevenue - totalExpenses;
  const totalEquityWithCurrentYearPL = totalEquity + currentYearPL;

  const warnings: string[] = [];
  if (Math.abs(currentYearPL) > 0.01) {
    warnings.push(
      `Open P&L accounts show ${roundMoney(currentYearPL)} EUR net profit. ` +
      `This amount is included in equity for the balance check and should normally be closed into equity at year-end.`
    );
  }

  const items = (list: AccountBalance[]) => list.map(a => ({ id: a.account_id, name: a.name_est, balance: a.balance }));
  return {
    date,
    assets: { items: items(assets), total: roundMoney(totalAssets) },
    liabilities: { items: items(liabilities), total: roundMoney(totalLiabilities) },
    equity: { items: items(equity), total: roundMoney(totalEquityWithCurrentYearPL) },
    current_year_pl: {
      revenue: roundMoney(totalRevenue),
      expenses: roundMoney(totalExpenses),
      net_profit: roundMoney(currentYearPL),
    },
    check: {
      assets: roundMoney(totalAssets),
      liabilities_plus_equity: roundMoney(totalLiabilities + totalEquityWithCurrentYearPL),
      balanced: Math.abs(totalAssets - totalLiabilities - totalEquityWithCurrentYearPL) < 0.01,
    },
    warnings: openingBalanceWarnings(warnings, opening, undefined, date),
  };
}

/**
 * Profit and loss for a period. The calculated-result account 9000
 * ("Arvestuslik koondtulemus", name-resolved) is excluded: under RIK's
 * e-arveldaja year-end method it is the counter-account of the result entry
 * (profit D 9000 / K 2970), not revenue or expense. Legacy year-end closing
 * journals (YECL-YYYY on YYYY-12-31) are excluded too: they zero every
 * Tulud/Kulud account into equity, so including them would report 0 revenue,
 * 0 expenses and 0 profit for any period that contains a legacy-closed year.
 */
export async function computeProfitAndLossReport(
  api: ApiContext,
  dateFrom: string,
  dateTo: string,
): Promise<Omit<ProfitAndLossResult, "report">> {
  const [{ journals, opening }, accounts] = await Promise.all([loadLedgerJournals(api), api.readonly.getAccounts()]);
  const calculatedResultAccount = resolveCalculatedResultAccount(accounts);
  const excludedClosing = new Set<number | undefined>();
  const allBalances = await computeAllBalances(api, dateFrom, dateTo, {
    preloadedAccounts: accounts,
    preloadedJournals: journals,
    journalFilter: journal => {
      if (!isYearEndClosingJournal(journal)) return true;
      excludedClosing.add(journal.id);
      return false;
    },
  });

  const calculatedResult = allBalances.find(b => b.account_id === calculatedResultAccount);
  const balances = allBalances.filter(b => b.account_id !== calculatedResultAccount);
  const revenue = balances.filter(b => b.account_type_est === "Tulud");
  const expenses = balances.filter(b => b.account_type_est === "Kulud");
  const totalRevenue = sumCategory(revenue, "C");
  const totalExpenses = sumCategory(expenses, "D");

  const warnings: string[] = [];
  if (calculatedResult && Math.abs(calculatedResult.balance) >= 0.01) {
    warnings.push(
      `Account ${calculatedResultAccount} (${calculatedResult.name_est}) balance ${calculatedResult.balance} EUR (${calculatedResult.balance_type}) excluded: ` +
      "it is the counter-account of the RIK year-end result entry (D 9000 / K 2970), not revenue or expense.",
    );
  }
  if (excludedClosing.size > 0) {
    warnings.push(`${excludedClosing.size} year-end closing journal(s) excluded so revenue and expenses show the period's activity rather than the post-close zero balances.`);
  }

  const items = (list: AccountBalance[]) => list.map(a => ({ id: a.account_id, name: a.name_est, amount: a.balance }));
  return {
    period: { from: dateFrom, to: dateTo },
    revenue: { items: items(revenue), total: roundMoney(totalRevenue) },
    expenses: { items: items(expenses), total: roundMoney(totalExpenses) },
    net_profit: roundMoney(totalRevenue - totalExpenses),
    warnings: openingBalanceWarnings(warnings, opening, dateFrom, dateTo),
  };
}

function getMonthLastDay(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
}

const monthRegex = /^\d{4}-\d{2}$/;

// Raw month-end gather scan — the single source of the unconfirmed/overdue
// filtering (journal registered/deleted gate, PROJECT status, journal_date and
// term-based overdue math). Callers (month_end_close_checklist and the
// run_accounting_report month_end op) add their own output shape/warnings/
// OCR-wrapping so the accounting logic can never drift between copies.
export interface MonthEndScanInput {
  readonly journals: readonly Journal[];
  readonly transactions: readonly Transaction[];
  readonly saleInvoices: readonly SaleInvoice[];
  readonly purchaseInvoices: readonly PurchaseInvoice[];
  readonly dateFrom: string;
  readonly dateTo: string;
  /** Actual current date; when before dateTo the month is still open. Omit for pure month-end evaluation. */
  readonly today?: string;
}

export interface MonthEndScan {
  unconfirmedJournals: Journal[];
  unconfirmedTransactions: Transaction[];
  unconfirmedSales: SaleInvoice[];
  unconfirmedPurchases: PurchaseInvoice[];
  overdueReceivables: SaleInvoice[];
  overduePayables: PurchaseInvoice[];
  /** Open month only: not yet due today, but due before month-end. Empty for a closed month. */
  dueBeforeMonthEndReceivables: SaleInvoice[];
  dueBeforeMonthEndPayables: PurchaseInvoice[];
  /** Date the overdue lists were evaluated against: min(today, month-end). */
  overdueAsOf: string;
  monthOpen: boolean;
  /** Due date computed for an open (unpaid, confirmed) invoice from the input. */
  dueDate: (inv: SaleInvoice | PurchaseInvoice) => string;
  missingTermDays: Array<{ entity: "sale_invoice" | "purchase_invoice"; id: number | undefined; number: string }>;
  /** Open invoices with no create_date: due date falls back to overdue_as_of + term_days. */
  missingCreateDateCount: number;
  /** PARTIALLY_PAID invoices across the overdue_* and due_before_month_end_* lists. */
  partiallyPaidReceivables: number;
  partiallyPaidPayables: number;
  /** Unpaid confirmed CREDIT_INVOICE sale invoices: money owed TO the customer, left out of the receivables lists. */
  excludedCreditInvoices: number;
}

export function gatherMonthEndScan(input: MonthEndScanInput): MonthEndScan {
  const { journals, transactions, saleInvoices, purchaseInvoices, dateFrom, dateTo } = input;

  const unconfirmedJournals = journals.filter(j =>
    !j.is_deleted && !j.registered &&
    j.effective_date >= dateFrom && j.effective_date <= dateTo
  );

  const unconfirmedTransactions = transactions.filter(tx =>
    isProjectTransaction(tx) &&
    tx.date >= dateFrom && tx.date <= dateTo
  );

  const unconfirmedSales = saleInvoices.filter(inv =>
    inv.status === "PROJECT" &&
    inv.journal_date >= dateFrom && inv.journal_date <= dateTo
  );

  const unconfirmedPurchases = purchaseInvoices.filter(inv =>
    inv.status === "PROJECT" &&
    inv.journal_date >= dateFrom && inv.journal_date <= dateTo
  );

  // Overdue is evaluated as of month-end for reproducibility — unless the month
  // is still open, in which case "overdue" means already past due today and the
  // invoices falling due between today and month-end are reported separately
  // (listing them as overdue mid-month misled callers into chasing invoices
  // that were not yet due).
  // term_days is typed as required but the upstream API occasionally serves it
  // as null/undefined; treat missing as 0 so the invoice is still evaluated
  // rather than silently dropped via NaN comparison.
  const overdueAsOf = input.today !== undefined && input.today < dateTo ? input.today : dateTo;
  const missingTermDays: Array<{ entity: "sale_invoice" | "purchase_invoice"; id: number | undefined; number: string }> = [];
  let missingCreateDateCount = 0;
  const dueDates = new Map<SaleInvoice | PurchaseInvoice, string>();
  const dueDateOf = (
    entity: "sale_invoice" | "purchase_invoice",
    inv: SaleInvoice | PurchaseInvoice,
  ): string => {
    const term = inv.term_days;
    if (term === undefined || term === null) {
      missingTermDays.push({ entity, id: inv.id, number: inv.number ?? "" });
    }
    // A missing/empty create_date would make an Invalid Date and abort the
    // whole checklist with a RangeError; fall back like the aging core does.
    if (!inv.create_date) missingCreateDateCount++;
    const d = new Date((inv.create_date || overdueAsOf) + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + (term ?? 0));
    const due = d.toISOString().split("T")[0]!;
    dueDates.set(inv, due);
    return due;
  };

  // An unpaid credit invoice is money owed TO the customer, not a receivable:
  // listing it (at positive gross) as overdue would inflate what is owed to us.
  const openSalesAll = saleInvoices.filter(inv => inv.payment_status !== "PAID" && inv.status === "CONFIRMED");
  const openSales = openSalesAll
    .filter(inv => inv.sale_invoice_type !== "CREDIT_INVOICE")
    .map(inv => ({ inv, due: dueDateOf("sale_invoice", inv) }));
  const openPurchases = purchaseInvoices
    .filter(inv => inv.payment_status !== "PAID" && inv.status === "CONFIRMED")
    .map(inv => ({ inv, due: dueDateOf("purchase_invoice", inv) }));

  const overdueReceivables = openSales.filter(r => r.due < overdueAsOf).map(r => r.inv);
  const overduePayables = openPurchases.filter(r => r.due < overdueAsOf).map(r => r.inv);
  const dueBeforeMonthEndReceivables = openSales.filter(r => r.due >= overdueAsOf && r.due < dateTo).map(r => r.inv);
  const dueBeforeMonthEndPayables = openPurchases.filter(r => r.due >= overdueAsOf && r.due < dateTo).map(r => r.inv);

  const isPartiallyPaid = (inv: SaleInvoice | PurchaseInvoice) => inv.payment_status === "PARTIALLY_PAID";
  const partiallyPaidReceivables = [...overdueReceivables, ...dueBeforeMonthEndReceivables].filter(isPartiallyPaid).length;
  const partiallyPaidPayables = [...overduePayables, ...dueBeforeMonthEndPayables].filter(isPartiallyPaid).length;

  return {
    unconfirmedJournals,
    unconfirmedTransactions,
    unconfirmedSales,
    unconfirmedPurchases,
    overdueReceivables,
    overduePayables,
    dueBeforeMonthEndReceivables,
    dueBeforeMonthEndPayables,
    overdueAsOf,
    monthOpen: overdueAsOf < dateTo,
    dueDate: inv => dueDates.get(inv)!,
    missingTermDays,
    missingCreateDateCount,
    partiallyPaidReceivables,
    partiallyPaidPayables,
    excludedCreditInvoices: openSalesAll.length - openSales.length,
  };
}

/** Whole days from `dueDate` to `asOf` (both YYYY-MM-DD); positive when past due. */
export function daysPastDue(dueDate: string, asOf: string): number {
  return Math.round((Date.parse(asOf + "T12:00:00Z") - Date.parse(dueDate + "T12:00:00Z")) / 86_400_000);
}

export function monthOpenWarning(month: string, today: string, dateTo: string): string {
  return `Month ${month} has not ended yet (today ${today}); overdue_* lists only invoices already past due today. ` +
    `Invoices falling due before month-end ${dateTo} are listed under due_before_month_end_* and are not yet overdue.`;
}



/**
 * One overdue_* / due_before_month_end_* list with EVERY row (callers cap for
 * output). client is UNWRAPPED — output sites wrap it. A foreign-currency
 * invoice with no base_gross_price keeps its row (gross in its own currency,
 * flagged) but is left out of the EUR `total`.
 */
export function buildMonthEndDueList(
  invs: ReadonlyArray<SaleInvoice | PurchaseInvoice>,
  scan: Pick<MonthEndScan, "dueDate" | "overdueAsOf">,
  withDaysOverdue: boolean,
): MonthEndDueList {
  let total = 0;
  const items = invs.map((inv): MonthEndDueInvoiceRow => {
    const eur = eurGross(inv);
    if (eur !== undefined) total += eur;
    const due = scan.dueDate(inv);
    return {
      id: inv.id!,
      number: inv.number ?? "",
      client: inv.client_name ?? "",
      gross: eur ?? inv.gross_price ?? 0,
      ...(eur === undefined ? { currency: (inv.cl_currencies_id ?? "").toUpperCase(), excluded_from_eur_totals: true as const } : {}),
      payment_status: inv.payment_status ?? "NOT_PAID",
      due_date: due,
      ...(withDaysOverdue ? { days_overdue: daysPastDue(due, scan.overdueAsOf) } : {}),
    };
  });
  return { count: invs.length, total: roundMoney(total), items };
}

/** Warnings shared by month_end_close_checklist and the run_accounting_report month_end op. */
export function monthEndWarnings(scan: MonthEndScan, month: string, dateTo: string): string[] {
  const warnings: string[] = [];
  if (scan.partiallyPaidReceivables > 0) {
    warnings.push(`${scan.partiallyPaidReceivables} listed receivable(s) are PARTIALLY_PAID and shown at full invoice amount; remaining balance may be lower.`);
  }
  if (scan.partiallyPaidPayables > 0) {
    warnings.push(`${scan.partiallyPaidPayables} listed payable(s) are PARTIALLY_PAID and shown at full invoice amount; remaining balance may be lower.`);
  }
  if (scan.missingTermDays.length > 0) {
    warnings.push(
      `${scan.missingTermDays.length} invoice(s) had no term_days; treated as 0-day terms for the overdue check. Affected: ` +
      scan.missingTermDays.slice(0, 5).map(item => `${item.entity}#${item.id ?? "?"} (${item.number})`).join(", ") +
      (scan.missingTermDays.length > 5 ? `, +${scan.missingTermDays.length - 5} more` : "")
    );
  }
  if (scan.missingCreateDateCount > 0) {
    warnings.push(`${scan.missingCreateDateCount} open invoice(s) have no create_date; their due date was computed from ${scan.overdueAsOf}, so they are not reported as overdue. Check them in e-arveldaja.`);
  }
  if (scan.excludedCreditInvoices > 0) {
    warnings.push(`${scan.excludedCreditInvoices} unpaid credit invoice(s) excluded from the receivables lists — they are amounts owed to customers, not receivables.`);
  }
  const noEur = [
    ...scan.overdueReceivables, ...scan.overduePayables,
    ...scan.dueBeforeMonthEndReceivables, ...scan.dueBeforeMonthEndPayables,
  ].filter(inv => eurGross(inv) === undefined);
  if (noEur.length > 0) {
    warnings.push(
      `${noEur.length} listed foreign-currency invoice(s) have no base_gross_price (EUR amount) and are EXCLUDED from the EUR totals; ` +
      `their rows show gross in the invoice currency (excluded_from_eur_totals). Affected: ` +
      noEur.slice(0, 5).map(inv => `#${inv.id ?? "?"} (${inv.gross_price ?? 0} ${inv.cl_currencies_id})`).join(", ") +
      (noEur.length > 5 ? `, +${noEur.length - 5} more` : "")
    );
  }
  if (scan.monthOpen) warnings.push(monthOpenWarning(month, scan.overdueAsOf, dateTo));
  return warnings;
}

export function registerFinancialStatementTools(
  server: McpServer,
  api: ApiContext,
  toolExposure?: Pick<ToolExposureConfig, "enableSales">,
): void {
  const enableSales = toolExposure?.enableSales !== false;

  registerTool(server, "compute_trial_balance",
    "Compute trial balance (käibeandmik/proovibilanss) from journal postings. " +
    "Shows debit/credit totals and balance for each account. " +
    "Without date_to every posting counts, including future-dated ones (period.to = \"unbounded\").",
    {
      date_from: z.string().optional().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Period end (YYYY-MM-DD)"),
      fresh: z.boolean().optional().describe("Clear cached API/reference data before computing this report (use after web UI changes)."),
    },
    { ...readOnly, title: "Compute Trial Balance" },
    async ({ date_from, date_to, fresh }) => {
      const dateError = validateOptionalStrictDateRange("date_from", date_from, "date_to", date_to);
      if (dateError) return toolError({ error: dateError, category: "invalid_date" });
      const cacheClear = fresh ? clearRuntimeCaches() : undefined;
      const report = await computeTrialBalanceReport(api, date_from, date_to);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            period: report.period,
            accounts: report.accounts,
            totals: report.totals,
            account_count: report.account_count,
            ...cacheClearMetadata(cacheClear),
            warnings: report.warnings,
          }),
        }],
      };
    }
  );

  registerTool(server, "compute_balance_sheet",
    "Compute balance sheet (bilanss) from journal postings. " +
    "Groups accounts into Varad (Assets) and Kohustused+Omakapital (Liabilities+Equity).",
    {
      date_to: z.string().optional().describe("Balance sheet date (YYYY-MM-DD, default: today)"),
      fresh: z.boolean().optional().describe("Clear cached API/reference data before computing this report (use after web UI changes)."),
    },
    { ...readOnly, title: "Compute Balance Sheet" },
    async ({ date_to, fresh }) => {
      const dateError = validateOptionalStrictDate("date_to", date_to);
      if (dateError) return toolError({ error: dateError, category: "invalid_date" });
      const cacheClear = fresh ? clearRuntimeCaches() : undefined;
      const report = await computeBalanceSheetReport(api, date_to);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            date: report.date,
            assets: report.assets,
            liabilities: report.liabilities,
            equity: report.equity,
            current_year_pl: { ...report.current_year_pl, note: "Included in equity total and balance check." },
            check: report.check,
            ...cacheClearMetadata(cacheClear),
            warnings: report.warnings,
          }),
        }],
      };
    }
  );

  registerTool(server, "compute_profit_and_loss",
    "Compute profit and loss statement (kasumiaruanne) for a period. " +
    "Shows revenue minus expenses; account 9000 (Arvestuslik koondtulemus, the RIK year-end close counter-account) and legacy YECL closing journals are excluded.",
    {
      date_from: z.string().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().describe("Period end (YYYY-MM-DD)"),
      fresh: z.boolean().optional().describe("Clear cached API/reference data before computing this report (use after web UI changes)."),
    },
    { ...readOnly, title: "Compute Profit and Loss" },
    async ({ date_from, date_to, fresh }) => {
      const dateError = validateOptionalStrictDateRange("date_from", date_from, "date_to", date_to);
      if (dateError) return toolError({ error: dateError, category: "invalid_date" });
      const cacheClear = fresh ? clearRuntimeCaches() : undefined;
      const report = await computeProfitAndLossReport(api, date_from, date_to);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            period: report.period,
            revenue: report.revenue,
            expenses: report.expenses,
            net_profit: report.net_profit,
            ...cacheClearMetadata(cacheClear),
            warnings: report.warnings,
          }),
        }],
      };
    }
  );

  registerTool(server, "month_end_close_checklist",
    enableSales
      ? "Generate month-end checklist: unconfirmed journals/invoices, unreconciled bank transactions, and overdue receivables/payables. Overdue = due date before overdue_as_of (the month's last day, or today while the month is still open; invoices falling due between today and month-end are listed separately under due_before_month_end_*)."
      : "Generate a purchase-side month-end checklist: unconfirmed journals/purchase invoices, unreconciled bank transactions, and overdue payables. Overdue = due date before overdue_as_of (the month's last day, or today while the month is still open; invoices falling due between today and month-end are listed separately under due_before_month_end_payables).",
    {
      month: z.string().regex(monthRegex, "Expected YYYY-MM").describe("Month to check (YYYY-MM, e.g. 2026-02)"),
      fresh: z.boolean().optional().describe("Clear cached API/reference data before running the checklist (use after web UI changes)."),
    },
    { ...readOnly, title: "Month-End Close Checklist" },
    async ({ month, fresh }) => {
      const cacheClear = fresh ? clearRuntimeCaches() : undefined;
      const dateFrom = `${month}-01`;
      const lastDay = getMonthLastDay(month);
      const dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;

      const [allJournals, allTx, allSales, allPurchases] = await Promise.all([
        api.journals.listAll(),
        api.transactions.listAll(),
        enableSales ? api.saleInvoices.listAll() : Promise.resolve([]),
        api.purchaseInvoices.listAll(),
      ]);

      const scan = gatherMonthEndScan({
        journals: allJournals,
        transactions: allTx,
        saleInvoices: allSales,
        purchaseInvoices: allPurchases,
        dateFrom,
        dateTo,
        today: todayInTallinn(),
      });
      const {
        unconfirmedJournals,
        unconfirmedTransactions: unconfirmedTx,
        unconfirmedSales,
        unconfirmedPurchases,
        overdueReceivables,
        overduePayables,
        dueBeforeMonthEndReceivables,
        dueBeforeMonthEndPayables,
        overdueAsOf,
        monthOpen,
      } = scan;

      // Output-size cap for this standalone tool; `count`/`total` cover every
      // row and `truncated` marks a capped list (run_accounting_report with
      // detail='full' returns them all).
      const DUE_LIST_CAP = 10;
      const dueList = (invs: Array<SaleInvoice | PurchaseInvoice>, withDaysOverdue: boolean) => {
        const list = buildMonthEndDueList(invs, scan, withDaysOverdue);
        return {
          count: list.count,
          total: list.total,
          items: list.items.slice(0, DUE_LIST_CAP).map(row => ({ ...row, client: wrapUntrustedOcr(row.client || undefined) })),
          ...(list.items.length > DUE_LIST_CAP && { truncated: true }),
        };
      };

      const warnings = monthEndWarnings(scan, month, dateTo);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            month,
            unconfirmed_journals: {
              count: unconfirmedJournals.length,
              items: unconfirmedJournals.map(j => ({ id: j.id, date: j.effective_date, title: wrapUntrustedOcr(j.title) })),
            },
            unconfirmed_transactions: {
              count: unconfirmedTx.length,
              items: unconfirmedTx.map(tx => ({ id: tx.id, date: tx.date, amount: tx.amount, description: wrapUntrustedOcr(tx.description ?? undefined) })),
            },
            ...(enableSales && {
              unconfirmed_sale_invoices: {
                count: unconfirmedSales.length,
                items: unconfirmedSales.map((inv: SaleInvoice) => ({
                  id: inv.id,
                  number: inv.number,
                  client: wrapUntrustedOcr(inv.client_name ?? undefined),
                  gross: effectiveGross(inv),
                  payment_status: inv.payment_status ?? "NOT_PAID",
                })),
              },
            }),
            unconfirmed_purchase_invoices: {
              count: unconfirmedPurchases.length,
              items: unconfirmedPurchases.map((inv: PurchaseInvoice) => ({
                id: inv.id,
                number: inv.number,
                client: wrapUntrustedOcr(inv.client_name ?? undefined),
                gross: effectiveGross(inv),
                payment_status: inv.payment_status ?? "NOT_PAID",
              })),
            },
            overdue_as_of: overdueAsOf,
            ...(enableSales && { overdue_receivables: dueList(overdueReceivables, true) }),
            overdue_payables: dueList(overduePayables, true),
            ...(monthOpen && {
              ...(enableSales && { due_before_month_end_receivables: dueList(dueBeforeMonthEndReceivables, false) }),
              due_before_month_end_payables: dueList(dueBeforeMonthEndPayables, false),
            }),
            summary: {
              issues_found: unconfirmedJournals.length + unconfirmedTx.length +
                unconfirmedSales.length + unconfirmedPurchases.length +
                overdueReceivables.length + overduePayables.length,
              ready_to_close: unconfirmedJournals.length === 0 && unconfirmedTx.length === 0 &&
                unconfirmedSales.length === 0 && unconfirmedPurchases.length === 0,
            },
            ...cacheClearMetadata(cacheClear),
            ...(warnings.length > 0 && { warnings }),
          }),
        }],
      };
    }
  );
}
