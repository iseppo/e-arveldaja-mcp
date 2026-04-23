import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import { logAudit } from "../audit-log.js";
import type { Account, Client, Journal, PurchaseInvoice, SaleInvoice, Transaction } from "../types/api.js";
import { computeAllBalances, type AccountBalance } from "./financial-statements.js";
import { roundMoney, effectiveGross } from "../money.js";
import { readOnly, batch } from "../annotations.js";
import { isProjectTransaction } from "../transaction-status.js";
import { validateAccounts } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { CURRENT_YEAR_PROFIT_ACCOUNT } from "../accounting-defaults.js";
import { getCashFlowCategoryRule, getLiabilityClassificationRule } from "../accounting-rules.js";

type PostingType = "D" | "C";
type CashFlowClass = "operating" | "investing" | "financing" | "unclassified";
type LiabilityClass = "current" | "non_current" | "manual_review";

interface PostingPreview {
  accounts_id: number;
  account_name: string;
  type: PostingType;
  amount: number;
  description?: string;
}

interface JournalProposal {
  source: "closing" | "accrual";
  auto_executable: boolean;
  dry_run: boolean;
  title: string;
  effective_date: string;
  document_number: string;
  rationale: string;
  postings: PostingPreview[];
  totals: {
    debit: number;
    credit: number;
    difference: number;
  };
  warnings?: string[];
}

interface StatementLine {
  label: string;
  amount: number;
  source_accounts: Array<{
    account_id: number;
    name: string;
    amount: number;
  }>;
}

interface UnresolvedItems {
  unconfirmed_journals: {
    count: number;
    items: Array<{ id: number; date: string; title: string | undefined }>;
  };
  unconfirmed_transactions: {
    count: number;
    items: Array<{ id: number; date: string; amount: number; description: string | null | undefined }>;
  };
  unconfirmed_sale_invoices: {
    count: number;
    items: Array<{ id: number; number: string; client: string; gross: number }>;
  };
  unconfirmed_purchase_invoices: {
    count: number;
    items: Array<{ id: number; number: string; client: string; gross: number }>;
  };
  total_issues: number;
}

interface YearEndCloseAnalysis {
  year: number;
  period: {
    from: string;
    to: string;
  };
  dry_run: boolean;
  current_year_result: {
    revenue: number;
    expenses: number;
    net_profit: number;
  };
  balance_sheet_check: {
    assets: number;
    liabilities: number;
    equity_including_current_year_result: number;
    difference: number;
    balanced: boolean;
  };
  unresolved_items: UnresolvedItems;
  accrual_review: {
    automatic_entries: JournalProposal[];
    prepaid_expense_review: Array<{
      account_id: number;
      account_name: string;
      balance: number;
      reason: string;
    }>;
    accrued_liability_review: Array<{
      account_id: number;
      account_name: string;
      balance: number;
      reason: string;
    }>;
    limitations: string[];
  };
  proposed_journal_entries: JournalProposal[];
  existing_year_end_close_journals: Array<{
    id: number;
    date: string;
    title: string | undefined;
    document_number: string | null | undefined;
    registered: boolean;
  }>;
  execution_status: {
    can_execute: boolean;
    recommended_to_execute: boolean;
    reason: string;
  };
  warnings: string[];
}

const yearShape = {
  year: z.number().int().min(2000).max(2200).describe("Fiscal year (YYYY)"),
};

function getYearBounds(year: number): { from: string; to: string; priorTo: string } {
  const priorYear = year - 1;
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    priorTo: `${priorYear}-12-31`,
  };
}

function hasPrefix(accountId: number, prefix: string): boolean {
  return String(accountId).startsWith(prefix);
}

function inRange(accountId: number, start: number, end: number): boolean {
  return accountId >= start && accountId <= end;
}

function roundRatio(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (Math.abs(denominator) < 0.005) return null;
  return roundRatio(numerator / denominator);
}

function statementAmount(balance: AccountBalance): number {
  switch (balance.account_type_est) {
    case "Varad":
    case "Kulud":
      return balance.balance_type === "D" ? balance.balance : -balance.balance;
    case "Kohustused":
    case "Omakapital":
    case "Tulud":
      return balance.balance_type === "C" ? balance.balance : -balance.balance;
    default:
      return balance.balance;
  }
}

function sumStatementBalances(
  balances: AccountBalance[],
  predicate: (balance: AccountBalance) => boolean,
): number {
  return roundMoney(
    balances
      .filter(predicate)
      .reduce((sum, balance) => sum + statementAmount(balance), 0),
  );
}

function buildStatementLine(
  label: string,
  balances: AccountBalance[],
  predicate: (balance: AccountBalance) => boolean,
): StatementLine {
  const sourceAccounts = balances
    .filter(predicate)
    .map((balance) => ({
      account_id: balance.account_id,
      name: balance.name_est,
      amount: roundMoney(statementAmount(balance)),
    }))
    .filter((account) => Math.abs(account.amount) >= 0.01);

  return {
    label,
    amount: roundMoney(sourceAccounts.reduce((sum, account) => sum + account.amount, 0)),
    source_accounts: sourceAccounts,
  };
}

function getActualNetSideAmount(balance: AccountBalance): number {
  return roundMoney(balance.debit_total - balance.credit_total);
}

function sumPostingAmounts(postings: PostingPreview[], type: PostingType): number {
  return roundMoney(postings.filter((posting) => posting.type === type).reduce((sum, posting) => sum + posting.amount, 0));
}

function buildOffsettingPosting(balance: AccountBalance): PostingPreview | null {
  const netAmount = getActualNetSideAmount(balance);
  if (Math.abs(netAmount) < 0.005) return null;

  return {
    accounts_id: balance.account_id,
    account_name: balance.name_est,
    type: netAmount > 0 ? "C" : "D",
    amount: roundMoney(Math.abs(netAmount)),
    description: `Sulgemine: ${balance.name_est}`,
  };
}

function hasExplicitCurrentLiabilityMarker(name: string): boolean {
  const hasCurrentPortionMarker = /\bcurrent\b.*\bportion\b/.test(name) && !/\bnon[-\s]+current\b.*\bportion\b/.test(name);
  return (
    name.includes("lühiajal") ||
    /\bshort\b/.test(name) ||
    hasCurrentPortionMarker
  );
}

function hasExplicitNonCurrentLiabilityMarker(name: string): boolean {
  return (
    name.includes("pikaajal") ||
    /\bnon(?:-|\s)?current\b/.test(name) ||
    /\blong\b/.test(name)
  );
}

// TODO: Replace this heuristic classifier with an explicit liability mapping layer.
// Prefer account-id/account-range rules as the primary signal, then keep a narrow
// override table for known naming patterns such as "current portion of long-term loan".
function classifyLiabilitySection(balance: AccountBalance): LiabilityClass {
  const name = `${balance.name_est} ${balance.name_eng}`.toLowerCase();
  const configured = getLiabilityClassificationRule(balance.account_id);
  if (configured) return configured;
  if (hasExplicitNonCurrentLiabilityMarker(name) && !hasExplicitCurrentLiabilityMarker(name)) return "non_current";
  if (hasExplicitCurrentLiabilityMarker(name)) return "current";
  if (inRange(balance.account_id, 2300, 2399)) return "current";
  if (inRange(balance.account_id, 2500, 2599)) return "current";
  return "manual_review";
}

function buildUnresolvedItems(
  dateFrom: string,
  dateTo: string,
  allJournals: Journal[],
  allTransactions: Transaction[],
  allSales: SaleInvoice[],
  allPurchases: PurchaseInvoice[],
): UnresolvedItems {
  const unconfirmedJournals = allJournals.filter((journal) =>
    !journal.is_deleted &&
    !journal.registered &&
    journal.effective_date >= dateFrom &&
    journal.effective_date <= dateTo,
  );

  const unconfirmedTransactions = allTransactions.filter((transaction) =>
    isProjectTransaction(transaction) &&
    transaction.date >= dateFrom &&
    transaction.date <= dateTo,
  );

  const unconfirmedSales = allSales.filter((invoice) =>
    invoice.status === "PROJECT" &&
    invoice.journal_date >= dateFrom &&
    invoice.journal_date <= dateTo,
  );

  const unconfirmedPurchases = allPurchases.filter((invoice) =>
    invoice.status === "PROJECT" &&
    invoice.journal_date >= dateFrom &&
    invoice.journal_date <= dateTo,
  );

  return {
    unconfirmed_journals: {
      count: unconfirmedJournals.length,
      items: unconfirmedJournals.slice(0, 20).map((journal) => ({
        id: journal.id!,
        date: journal.effective_date,
        title: journal.title,
      })),
    },
    unconfirmed_transactions: {
      count: unconfirmedTransactions.length,
      items: unconfirmedTransactions.slice(0, 20).map((transaction) => ({
        id: transaction.id!,
        date: transaction.date,
        amount: transaction.base_amount ?? transaction.amount,
        description: wrapUntrustedOcr(transaction.description ?? undefined),
      })),
    },
    unconfirmed_sale_invoices: {
      count: unconfirmedSales.length,
      items: unconfirmedSales.slice(0, 20).map((invoice) => ({
        id: invoice.id!,
        number: invoice.number ?? `${invoice.number_prefix ?? ""}${invoice.number_suffix}`,
        client: invoice.client_name ?? "",
        gross: effectiveGross(invoice),
      })),
    },
    unconfirmed_purchase_invoices: {
      count: unconfirmedPurchases.length,
      items: unconfirmedPurchases.slice(0, 20).map((invoice) => ({
        id: invoice.id!,
        number: invoice.number,
        client: invoice.client_name,
        gross: effectiveGross(invoice),
      })),
    },
    total_issues:
      unconfirmedJournals.length +
      unconfirmedTransactions.length +
      unconfirmedSales.length +
      unconfirmedPurchases.length,
  };
}

function isYearEndClosingJournal(journal: Pick<Journal, "document_number">): boolean {
  return journal.document_number?.startsWith("YECL-") ?? false;
}

function findExistingYearEndCloseJournals(allJournals: Journal[], year: number): Journal[] {
  const documentNumber = `YECL-${year}`;
  const yearEndDate = `${year}-12-31`;
  const titleNeedles = [`aasta lõppkanne ${year}`, `year-end close ${year}`];

  return allJournals.filter((journal) => {
    if (journal.is_deleted || journal.effective_date !== yearEndDate) return false;
    if (journal.document_number === documentNumber) return true;
    const title = journal.title?.toLowerCase() ?? "";
    return titleNeedles.some((needle) => title.includes(needle));
  });
}

function buildBalanceLine(balance: AccountBalance): StatementLine {
  const amount = roundMoney(statementAmount(balance));
  return {
    label: balance.name_est,
    amount,
    source_accounts: [{
      account_id: balance.account_id,
      name: balance.name_est,
      amount,
    }],
  };
}

function buildClosingProposal(
  year: number,
  yearProfitAndLossBalances: AccountBalance[],
  accountsById: Map<number, Account>,
): JournalProposal | null {
  const profitAndLossAccounts = yearProfitAndLossBalances
    .filter((balance) => balance.account_type_est === "Tulud" || balance.account_type_est === "Kulud")
    .map((balance) => buildOffsettingPosting(balance))
    .filter((posting): posting is PostingPreview => posting !== null)
    .sort((a, b) => a.accounts_id - b.accounts_id);

  if (profitAndLossAccounts.length === 0) return null;

  const totalRevenue = sumStatementBalances(yearProfitAndLossBalances, (balance) => balance.account_type_est === "Tulud");
  const totalExpenses = sumStatementBalances(yearProfitAndLossBalances, (balance) => balance.account_type_est === "Kulud");
  const netProfit = roundMoney(totalRevenue - totalExpenses);
  const currentYearProfitAccount = accountsById.get(CURRENT_YEAR_PROFIT_ACCOUNT);

  if (Math.abs(netProfit) >= 0.005) {
    profitAndLossAccounts.push({
      accounts_id: CURRENT_YEAR_PROFIT_ACCOUNT,
      account_name: currentYearProfitAccount?.name_est ?? "Aruandeaasta kasum",
      type: netProfit > 0 ? "C" : "D",
      amount: roundMoney(Math.abs(netProfit)),
      description: netProfit > 0 ? "Aruandeaasta kasum" : "Aruandeaasta kahjum",
    });
  }

  const debit = sumPostingAmounts(profitAndLossAccounts, "D");
  const credit = sumPostingAmounts(profitAndLossAccounts, "C");

  return {
    source: "closing",
    auto_executable: true,
    dry_run: true,
    title: `Aasta lõppkanne ${year}`,
    effective_date: `${year}-12-31`,
    document_number: `YECL-${year}`,
    rationale: "Closes all revenue and expense accounts into account 3310 (current year profit/loss).",
    postings: profitAndLossAccounts,
    totals: {
      debit,
      credit,
      difference: roundMoney(debit - credit),
    },
    warnings: Math.abs(debit - credit) >= 0.01
      ? ["Draft closing journal is not perfectly balanced after rounding and should be reviewed before execution."]
      : undefined,
  };
}

function buildAccrualReview(
  yearEndBalances: AccountBalance[],
  accountsById: Map<number, Account>,
  unresolvedItems: UnresolvedItems,
): YearEndCloseAnalysis["accrual_review"] {
  const prepaidExpenseReview = yearEndBalances
    .filter((balance) => inRange(balance.account_id, 1500, 1599))
    .filter((balance) => !accountsById.get(balance.account_id)?.is_vat_account)
    .map((balance) => ({
      account_id: balance.account_id,
      account_name: balance.name_est,
      balance: roundMoney(statementAmount(balance)),
      reason: "Non-VAT 15xx balance at year-end suggests a prepaid expense or cut-off item that should be reviewed.",
    }))
    .filter((item) => Math.abs(item.balance) >= 0.01);

  const accruedLiabilityReview = yearEndBalances
    .filter((balance) =>
      inRange(balance.account_id, 2900, 2999) ||
      (inRange(balance.account_id, 2300, 2399) &&
        /accr|viit|intress|puhkus|reserv|provis/i.test(`${balance.name_est} ${balance.name_eng}`)),
    )
    .map((balance) => ({
      account_id: balance.account_id,
      account_name: balance.name_est,
      balance: roundMoney(statementAmount(balance)),
      reason: "Year-end liability/provision balance looks accrual-related and should be tied to supporting calculations.",
    }))
    .filter((item) => Math.abs(item.balance) >= 0.01);

  const limitations = [
    "The e-arveldaja API does not expose enough structured service-period data to derive prepaid expense and accrued liability journals reliably.",
    "Automatic accrual entries are therefore limited to high-confidence review flags; ambiguous cut-off items should be assessed manually.",
  ];

  if (unresolvedItems.unconfirmed_purchase_invoices.count > 0 || unresolvedItems.unconfirmed_journals.count > 0) {
    limitations.push(
      "Unconfirmed purchase invoices or journals inside the fiscal year may indicate missing expense accruals; resolve those documents before finalizing closing entries.",
    );
  }

  return {
    automatic_entries: [],
    prepaid_expense_review: prepaidExpenseReview,
    accrued_liability_review: accruedLiabilityReview,
    limitations,
  };
}

async function analyzeYearEndClose(api: ApiContext, year: number): Promise<YearEndCloseAnalysis | { error: string; details: string[] }> {
  const { from, to } = getYearBounds(year);

  const [accounts, allJournals, allTransactions, allSales, allPurchases] = await Promise.all([
    api.readonly.getAccounts(),
    api.journals.listAllWithPostings(),
    api.transactions.listAll(),
    api.saleInvoices.listAll(),
    api.purchaseInvoices.listAll(),
  ]);
  const [yearEndBalances, yearProfitAndLossBalances] = await Promise.all([
    computeAllBalances(api, undefined, to, { preloadedAccounts: accounts, preloadedJournals: allJournals }),
    computeAllBalances(api, from, to, { preloadedAccounts: accounts, preloadedJournals: allJournals }),
  ]);

  const accountErrors = validateAccounts(accounts, [{ id: CURRENT_YEAR_PROFIT_ACCOUNT, label: "Current year profit account" }]);
  if (accountErrors.length > 0) {
    return {
      error: "Account validation failed",
      details: accountErrors,
    };
  }

  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const unresolvedItems = buildUnresolvedItems(from, to, allJournals, allTransactions, allSales, allPurchases);
  const existingYearEndCloseJournals = findExistingYearEndCloseJournals(allJournals, year);

  const assets = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Varad");
  const liabilities = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Kohustused");
  const equity = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Omakapital");
  const revenue = sumStatementBalances(yearProfitAndLossBalances, (balance) => balance.account_type_est === "Tulud");
  const expenses = sumStatementBalances(yearProfitAndLossBalances, (balance) => balance.account_type_est === "Kulud");
  const netProfit = roundMoney(revenue - expenses);
  const equityIncludingCurrentYearResult = roundMoney(equity + netProfit);
  const balanceDifference = roundMoney(assets - liabilities - equityIncludingCurrentYearResult);

  const closingProposal = buildClosingProposal(year, yearProfitAndLossBalances, accountsById);
  const accrualReview = buildAccrualReview(yearEndBalances, accountsById, unresolvedItems);

  const warnings: string[] = [];
  if (!closingProposal) {
    warnings.push("No open revenue or expense balances were found for the selected year. The year may already be closed or there was no P&L activity.");
  }
  if (existingYearEndCloseJournals.length > 0) {
    warnings.push(`A year-end closing journal for ${year} already exists. Execution is blocked to avoid duplicates.`);
  }
  if (Math.abs(balanceDifference) >= 0.01) {
    warnings.push(`Balance sheet does not balance at ${to}. Difference: ${balanceDifference} EUR.`);
  }
  const currentYearProfitBalance = yearEndBalances.find((balance) => balance.account_id === CURRENT_YEAR_PROFIT_ACCOUNT);
  if (currentYearProfitBalance && Math.abs(statementAmount(currentYearProfitBalance)) >= 0.01 && closingProposal) {
    warnings.push(
      `Account 3310 already has a balance of ${roundMoney(statementAmount(currentYearProfitBalance))} EUR while P&L accounts are still open. Verify there is no partial close.`,
    );
  }
  if (closingProposal && Math.abs(closingProposal.totals.difference) >= 0.01) {
    warnings.push("Closing proposal has a non-zero debit/credit difference after rounding and should be reviewed manually.");
  }

  const proposedJournalEntries = [
    ...accrualReview.automatic_entries,
    ...(closingProposal ? [closingProposal] : []),
  ];

  const canExecute = existingYearEndCloseJournals.length === 0 &&
    proposedJournalEntries.some((proposal) => proposal.auto_executable && Math.abs(proposal.totals.difference) < 0.01);

  const recommendedToExecute = canExecute &&
    unresolvedItems.total_issues === 0 &&
    Math.abs(balanceDifference) < 0.01;

  return {
    year,
    period: { from, to },
    dry_run: true,
    current_year_result: {
      revenue,
      expenses,
      net_profit: netProfit,
    },
    balance_sheet_check: {
      assets,
      liabilities,
      equity_including_current_year_result: equityIncludingCurrentYearResult,
      difference: balanceDifference,
      balanced: Math.abs(balanceDifference) < 0.01,
    },
    unresolved_items: unresolvedItems,
    accrual_review: accrualReview,
    proposed_journal_entries: proposedJournalEntries,
    existing_year_end_close_journals: existingYearEndCloseJournals.map((journal) => ({
      id: journal.id!,
      date: journal.effective_date,
      title: journal.title,
      document_number: journal.document_number,
      registered: journal.registered === true,
    })),
    execution_status: {
      can_execute: canExecute,
      recommended_to_execute: recommendedToExecute,
      reason: !canExecute
        ? "No executable closing draft was generated, or a duplicate year-end close already exists."
        : !recommendedToExecute
          ? "Execution is technically possible, but unresolved documents or balance-sheet issues should be fixed first."
          : "Ready to execute.",
    },
    warnings,
  };
}

function getMappedAccountIds(lines: StatementLine[]): Set<number> {
  return new Set(lines.flatMap((line) => line.source_accounts.map((account) => account.account_id)));
}

function getRelatedPartyFlags(client: Client): string[] {
  return [
    client.is_related_party ? "related_party" : null,
    client.is_associate_company ? "associate_company" : null,
    client.is_parent_company_group ? "group_company" : null,
  ].filter((flag): flag is string => flag !== null);
}

function classifyCashFlowCategory(account: Account | undefined): CashFlowClass {
  if (!account) return "unclassified";
  const configured = getCashFlowCategoryRule(account.id);
  if (configured) return configured;
  if (inRange(account.id, 1300, 1399) && account.account_type_est === "Varad") return "investing";
  if ((account.is_fixed_asset || inRange(account.id, 1700, 1999)) && account.account_type_est === "Varad") return "investing";
  if (account.account_type_est === "Omakapital") return "financing";
  if (account.account_type_est === "Kohustused" && inRange(account.id, 2000, 2199)) return "financing";
  return "operating";
}

function computeCashFlowClassification(
  allJournals: Journal[],
  accountsById: Map<number, Account>,
  dateFrom: string,
  dateTo: string,
): Record<CashFlowClass, number> {
  const totals: Record<CashFlowClass, number> = {
    operating: 0,
    investing: 0,
    financing: 0,
    unclassified: 0,
  };

  for (const journal of allJournals) {
    if (journal.is_deleted || !journal.registered) continue;
    if (journal.effective_date < dateFrom || journal.effective_date > dateTo) continue;
    if (!journal.postings || journal.postings.length === 0) continue;

    const activePostings = journal.postings.filter((posting) =>
      !posting.is_deleted &&
      (posting.type === "D" || posting.type === "C"),
    );

    if (activePostings.length === 0) continue;

    const cashPostings = activePostings.filter((posting) => hasPrefix(posting.accounts_id, "10"));
    if (cashPostings.length === 0) continue;

    const netCash = roundMoney(cashPostings.reduce((sum, posting) => {
      const amount = posting.base_amount ?? posting.amount;
      return sum + (posting.type === "D" ? amount : -amount);
    }, 0));

    if (Math.abs(netCash) < 0.005) continue;

    const counterpartPostings = activePostings.filter((posting) => !hasPrefix(posting.accounts_id, "10"));
    if (counterpartPostings.length === 0) {
      totals.unclassified = roundMoney(totals.unclassified + netCash);
      continue;
    }

    const categories = new Set(counterpartPostings.map((posting) => classifyCashFlowCategory(accountsById.get(posting.accounts_id))));
    if (categories.size === 1 && !categories.has("unclassified")) {
      const [category] = [...categories];
      totals[category!] = roundMoney(totals[category!] + netCash);
      continue;
    }

    totals.unclassified = roundMoney(totals.unclassified + netCash);
  }

  return totals;
}

export async function buildAnnualReportData(api: ApiContext, year: number): Promise<Record<string, unknown>> {
  const { from, to, priorTo } = getYearBounds(year);

  const [accounts, invoiceInfo, vatInfo, allClients, allSales, allPurchases, allJournals] = await Promise.all([
    api.readonly.getAccounts(),
    api.readonly.getInvoiceInfo(),
    api.readonly.getVatInfo(),
    api.clients.listAll(),
    api.saleInvoices.listAll(),
    api.purchaseInvoices.listAll(),
    api.journals.listAllWithPostings(),
  ]);

  const preloaded = { preloadedAccounts: accounts, preloadedJournals: allJournals };
  const [yearEndBalances, priorYearEndBalances, yearProfitAndLossBalances] = await Promise.all([
    computeAllBalances(api, undefined, to, preloaded),
    computeAllBalances(api, undefined, priorTo, preloaded),
    computeAllBalances(api, from, to, {
      ...preloaded,
      journalFilter: (journal) => !isYearEndClosingJournal(journal),
    }),
  ]);

  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const warnings: string[] = [];

  const currentAssets = buildStatementLine("Käibevara", yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" &&
    (hasPrefix(balance.account_id, "10") || hasPrefix(balance.account_id, "12") || hasPrefix(balance.account_id, "13") || hasPrefix(balance.account_id, "14") || hasPrefix(balance.account_id, "15") || hasPrefix(balance.account_id, "16")),
  );
  const nonCurrentAssets = buildStatementLine("Põhivara", yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" &&
    (hasPrefix(balance.account_id, "17") || hasPrefix(balance.account_id, "18") || hasPrefix(balance.account_id, "19")),
  );
  const totalAssets = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Varad");

  const currentLiabilities = buildStatementLine("Lühiajalised kohustused", yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" &&
    classifyLiabilitySection(balance) === "current",
  );
  const nonCurrentLiabilities = buildStatementLine("Pikaajalised kohustused", yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" &&
    classifyLiabilitySection(balance) === "non_current",
  );
  const manualReviewLiabilities = buildStatementLine("Klassifitseerimata kohustused", yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" &&
    classifyLiabilitySection(balance) === "manual_review",
  );
  const totalLiabilities = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Kohustused");

  const equityAccountLines = yearEndBalances
    .filter((balance) => balance.account_type_est === "Omakapital" && balance.account_id !== CURRENT_YEAR_PROFIT_ACCOUNT)
    .map((balance) => buildBalanceLine(balance))
    .filter((line) => Math.abs(line.amount) >= 0.01);
  const currentYearProfitAccountLine = buildStatementLine("Aruandeaasta kasum", yearEndBalances, (balance) =>
    balance.account_type_est === "Omakapital" && balance.account_id === CURRENT_YEAR_PROFIT_ACCOUNT,
  );

  const revenueLine = buildStatementLine("Müügitulu", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Tulud" && inRange(balance.account_id, 3000, 3099),
  );
  const otherOperatingIncomeLine = buildStatementLine("Muud äritulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Tulud" && inRange(balance.account_id, 3800, 3899),
  );
  const cogsLine = buildStatementLine("Kaubad, toore, materjal ja teenused", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 4000, 4499),
  );
  const operatingExpensesLine = buildStatementLine("Mitmesugused tegevuskulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 5000, 5999),
  );
  const staffCostsLine = buildStatementLine("Tööjõukulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 6000, 6999),
  );
  const depreciationLine = buildStatementLine("Põhivara kulum ja väärtuse langus", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 4800, 4899),
  );
  const otherOperatingExpensesLine = buildStatementLine("Muud ärikulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 7800, 7899),
  );
  const financialIncomeExpenseLine = buildStatementLine("Finantstulud ja -kulud", yearProfitAndLossBalances, (balance) =>
    inRange(balance.account_id, 7200, 7699) &&
    (balance.account_type_est === "Tulud" || balance.account_type_est === "Kulud"),
  );
  const incomeTaxLine = buildStatementLine("Tulumaks", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 8900, 8999),
  );

  const operatingProfit = roundMoney(
    revenueLine.amount +
    otherOperatingIncomeLine.amount -
    cogsLine.amount -
    operatingExpensesLine.amount -
    staffCostsLine.amount -
    depreciationLine.amount -
    otherOperatingExpensesLine.amount,
  );
  const profitBeforeTax = roundMoney(operatingProfit + financialIncomeExpenseLine.amount);
  const netProfit = roundMoney(profitBeforeTax - incomeTaxLine.amount);

  const totalEquityFromAccounts = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Omakapital");
  const totalEquity = roundMoney(totalEquityFromAccounts - currentYearProfitAccountLine.amount + netProfit);
  const balanceDifference = roundMoney(totalAssets - totalLiabilities - totalEquity);

  const mappedProfitAndLossAccounts = getMappedAccountIds([
    revenueLine,
    otherOperatingIncomeLine,
    cogsLine,
    operatingExpensesLine,
    staffCostsLine,
    depreciationLine,
    otherOperatingExpensesLine,
    financialIncomeExpenseLine,
    incomeTaxLine,
  ]);
  const unmappedProfitAndLossAccounts = yearProfitAndLossBalances
    .filter((balance) => balance.account_type_est === "Tulud" || balance.account_type_est === "Kulud")
    .filter((balance) => !mappedProfitAndLossAccounts.has(balance.account_id))
    .map((balance) => ({
      account_id: balance.account_id,
      name: balance.name_est,
      amount: roundMoney(statementAmount(balance)),
    }))
    .filter((account) => Math.abs(account.amount) >= 0.01);

  if (unmappedProfitAndLossAccounts.length > 0) {
    warnings.push("Some revenue/expense accounts fall outside the RTJ Schema 1 mapping rules and should be reviewed manually.");
  }
  if (Math.abs(balanceDifference) >= 0.01) {
    warnings.push(`Mapped balance sheet lines do not fully balance. Difference: ${balanceDifference} EUR.`);
  }
  if (
    Math.abs(currentYearProfitAccountLine.amount) >= 0.01 &&
    Math.abs(currentYearProfitAccountLine.amount - netProfit) >= 0.01
  ) {
    warnings.push(
      `Account 3310 balance (${currentYearProfitAccountLine.amount} EUR) differs from computed current-year result ` +
      `(${netProfit} EUR). YECL-* journals were excluded from the income statement, so review whether a partial close was posted.`,
    );
  }
  if (Math.abs(manualReviewLiabilities.amount) >= 0.01) {
    warnings.push("Some liabilities could not be classified as current or non-current from ledger data alone. Review klassifitseerimata_kohustused or define account overrides in accounting-rules.md.");
  }

  const openingCash = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "10"),
  );
  const closingCash = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "10"),
  );
  const cashChange = roundMoney(closingCash - openingCash);

  const openingReceivables = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "12"),
  );
  const closingReceivables = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "12"),
  );
  const openingInventories = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "16"),
  );
  const closingInventories = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "16"),
  );
  const openingPrepayments = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "15"),
  );
  const closingPrepayments = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "15"),
  );
  const openingPayables = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && hasPrefix(balance.account_id, "23"),
  );
  const closingPayables = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && hasPrefix(balance.account_id, "23"),
  );
  const openingTaxLiabilities = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && hasPrefix(balance.account_id, "25"),
  );
  const closingTaxLiabilities = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && hasPrefix(balance.account_id, "25"),
  );
  const openingOtherReceivables = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "14"),
  );
  const closingOtherReceivables = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "14"),
  );
  const openingShortTermInvestments = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "13"),
  );
  const closingShortTermInvestments = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "13"),
  );
  const openingShortTermLiabilities = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && (hasPrefix(balance.account_id, "20") || hasPrefix(balance.account_id, "21")),
  );
  const closingShortTermLiabilities = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && (hasPrefix(balance.account_id, "20") || hasPrefix(balance.account_id, "21")),
  );
  const openingAccruedLiabilities = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && hasPrefix(balance.account_id, "29"),
  );
  const closingAccruedLiabilities = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && hasPrefix(balance.account_id, "29"),
  );

  const receivablesAdjustment = roundMoney(openingReceivables - closingReceivables);
  const inventoriesAdjustment = roundMoney(openingInventories - closingInventories);
  const prepaymentsAdjustment = roundMoney(openingPrepayments - closingPrepayments);
  const payablesAdjustment = roundMoney(closingPayables - openingPayables);
  const taxLiabilitiesAdjustment = roundMoney(closingTaxLiabilities - openingTaxLiabilities);
  const otherReceivablesAdjustment = roundMoney(openingOtherReceivables - closingOtherReceivables);
  const accruedLiabilitiesAdjustment = roundMoney(closingAccruedLiabilities - openingAccruedLiabilities);
  const shortTermInvestmentsAdjustment = roundMoney(openingShortTermInvestments - closingShortTermInvestments);
  const shortTermLiabilitiesAdjustment = roundMoney(closingShortTermLiabilities - openingShortTermLiabilities);
  const netCashFromOperatingActivities = roundMoney(
    netProfit +
    depreciationLine.amount +
    receivablesAdjustment +
    inventoriesAdjustment +
    prepaymentsAdjustment +
    payablesAdjustment +
    taxLiabilitiesAdjustment +
    otherReceivablesAdjustment +
    accruedLiabilitiesAdjustment,
  );

  const cashFlowClassification = computeCashFlowClassification(allJournals, accountsById, from, to);
  const netCashFromInvestingActivities = roundMoney(cashFlowClassification.investing);
  const netCashFromFinancingActivities = roundMoney(cashFlowClassification.financing);
  const statementCashChange = roundMoney(
    netCashFromOperatingActivities +
    netCashFromInvestingActivities +
    netCashFromFinancingActivities,
  );
  const statementCashChangeWithUnclassified = roundMoney(statementCashChange + cashFlowClassification.unclassified);
  if (Math.abs(shortTermInvestmentsAdjustment) >= 0.01) {
    warnings.push("Changes in short-term investments were excluded from operating cash flow and should be reviewed in investing activities.");
  }
  if (Math.abs(shortTermLiabilitiesAdjustment) >= 0.01) {
    warnings.push("Changes in financing liabilities were excluded from operating cash flow and should be reviewed in financing activities.");
  }
  if (Math.abs(cashFlowClassification.unclassified) >= 0.01) {
    warnings.push("Some cash journals touched multiple non-cash categories and were left unclassified instead of being proportionally allocated. Review accounting-rules.md cash_flow_category overrides if needed.");
  }

  const relatedPartyClients = allClients.filter((client) => !client.is_deleted && getRelatedPartyFlags(client).length > 0);
  const relatedPartyIds = new Set(relatedPartyClients.map((client) => client.id));
  const relatedSales = allSales.filter((invoice) =>
    relatedPartyIds.has(invoice.clients_id) &&
    invoice.journal_date >= from &&
    invoice.journal_date <= to &&
    invoice.status === "CONFIRMED",
  );
  const relatedPurchases = allPurchases.filter((invoice) =>
    relatedPartyIds.has(invoice.clients_id) &&
    invoice.journal_date >= from &&
    invoice.journal_date <= to &&
    invoice.status === "CONFIRMED",
  );
  const relatedJournals = allJournals.filter((journal) =>
    !journal.is_deleted &&
    journal.registered &&
    journal.clients_id !== undefined &&
    journal.clients_id !== null &&
    relatedPartyIds.has(journal.clients_id) &&
    journal.effective_date >= from &&
    journal.effective_date <= to,
  );

  const staffClients = allClients.filter((client) => !client.is_deleted && client.is_staff === true);
  if (staffClients.length === 0 && staffCostsLine.amount > 0) {
    warnings.push("Staff costs exist, but no `is_staff=true` client records were found. Employee count note likely needs manual completion.");
  }

  const openingEquity = roundMoney(
    sumStatementBalances(priorYearEndBalances, (balance) => balance.account_type_est === "Omakapital"),
  );
  const closingEquity = totalEquity;
  const averageEquity = roundMoney((openingEquity + closingEquity) / 2);

  return {
    year,
    fiscal_period: { from, to },
    framework: {
      accounting_standard: "Estonian GAAP (RTJ)",
      entity_size: "micro_or_small",
      income_statement_schema: "schema_1_by_nature",
      cash_flow_method: "indirect",
    },
    company: {
      name: invoiceInfo.invoice_company_name ?? null,
      address: invoiceInfo.address ?? null,
      email: invoiceInfo.email ?? null,
      phone: invoiceInfo.phone ?? null,
      webpage: invoiceInfo.webpage ?? null,
      vat_number: vatInfo.vat_number ?? null,
    },
    balance_sheet: {
      assets: {
        kaibevara: currentAssets,
        pohivara: nonCurrentAssets,
        total_assets: totalAssets,
      },
      liabilities: {
        luhiajalised_kohustused: currentLiabilities,
        pikaajalised_kohustused: nonCurrentLiabilities,
        klassifitseerimata_kohustused: manualReviewLiabilities,
        total_liabilities: totalLiabilities,
      },
      equity: {
        accounts: equityAccountLines,
        current_year_result: {
          label: "Aruandeaasta kasum",
          amount: netProfit,
          source_accounts: currentYearProfitAccountLine.source_accounts,
        },
        total_equity: totalEquity,
      },
      check: {
        assets: totalAssets,
        liabilities_plus_equity: roundMoney(totalLiabilities + totalEquity),
        difference: balanceDifference,
        balanced: Math.abs(balanceDifference) < 0.01,
      },
    },
    income_statement_schema_1: {
      muugitulu: revenueLine,
      muud_aritulud: otherOperatingIncomeLine,
      kaubad_toore_materjal_ja_teenused: cogsLine,
      mitmesugused_tegevuskulud: operatingExpensesLine,
      toojoukulud: staffCostsLine,
      pohivara_kulum_ja_vaartuse_langus: depreciationLine,
      muud_arikulud: otherOperatingExpensesLine,
      arikasum: {
        label: "Ärikasum",
        amount: operatingProfit,
        source_accounts: [] as StatementLine["source_accounts"],
      },
      finantstulud_ja_kulud: financialIncomeExpenseLine,
      kasum_enne_tulumaksustamist: {
        label: "Kasum enne tulumaksustamist",
        amount: profitBeforeTax,
        source_accounts: [] as StatementLine["source_accounts"],
      },
      tulumaks: incomeTaxLine,
      aruandeaasta_puhaskasum: {
        label: "Aruandeaasta puhaskasum",
        amount: netProfit,
        source_accounts: [] as StatementLine["source_accounts"],
      },
      unmapped_accounts: unmappedProfitAndLossAccounts,
    },
    cash_flow_statement: {
      method: "indirect",
      opening_cash: openingCash,
      closing_cash: closingCash,
      net_change_in_cash: cashChange,
      operating_activities: {
        net_profit: netProfit,
        depreciation_and_impairment: depreciationLine.amount,
        change_in_receivables: receivablesAdjustment,
        change_in_other_receivables: otherReceivablesAdjustment,
        change_in_inventories: inventoriesAdjustment,
        change_in_prepayments: prepaymentsAdjustment,
        change_in_payables: payablesAdjustment,
        change_in_tax_liabilities: taxLiabilitiesAdjustment,
        change_in_accrued_liabilities: accruedLiabilitiesAdjustment,
        net_cash_from_operating_activities: netCashFromOperatingActivities,
        excluded_from_operating_adjustments: {
          change_in_short_term_investments: shortTermInvestmentsAdjustment,
          change_in_short_term_financing_liabilities: shortTermLiabilitiesAdjustment,
        },
      },
      investing_activities: {
        net_cash_from_investing_activities: netCashFromInvestingActivities,
      },
      financing_activities: {
        net_cash_from_financing_activities: netCashFromFinancingActivities,
      },
      cash_journal_classification: {
        operating: roundMoney(cashFlowClassification.operating),
        investing: roundMoney(cashFlowClassification.investing),
        financing: roundMoney(cashFlowClassification.financing),
        unclassified: roundMoney(cashFlowClassification.unclassified),
      },
      reconciliation: {
        cash_change_from_balance_sheet: cashChange,
        cash_change_from_statement: statementCashChange,
        difference: roundMoney(cashChange - statementCashChange),
        cash_change_including_unclassified_cash_journals: statementCashChangeWithUnclassified,
        difference_including_unclassified: roundMoney(cashChange - statementCashChangeWithUnclassified),
      },
    },
    key_ratios: {
      current_ratio: Math.abs(manualReviewLiabilities.amount) >= 0.01
        ? null
        : safeRatio(currentAssets.amount, currentLiabilities.amount),
      debt_ratio: safeRatio(totalLiabilities, totalAssets),
      roe: safeRatio(netProfit, averageEquity),
      profit_margin: safeRatio(netProfit, revenueLine.amount),
    },
    notes: {
      accounting_policies: {
        basis_of_preparation: "Prepared under Estonian GAAP (RTJ) on an accrual basis.",
        presentation_currency: "EUR",
        income_statement_schema: "Schema 1 (kulude liigitus iseloomu järgi)",
        cash_flow_method: "Indirect",
        vat_registered: Boolean(vatInfo.vat_number),
        assumptions: [
          "Line mapping is based on the standard Estonian chart-of-accounts ranges supplied for this tool.",
          "Company-specific accounting policy wording should be reviewed before filing.",
        ],
      },
      employee_count: {
        registered_staff_count: staffClients.length,
        source: "clients.is_staff",
        sample_staff_records: staffClients.slice(0, 10).map((client) => ({
          id: client.id,
          name: client.name,
        })),
      },
      related_party_transactions: {
        related_party_count: relatedPartyClients.length,
        related_parties: relatedPartyClients.map((client) => ({
          id: client.id,
          name: client.name,
          flags: getRelatedPartyFlags(client),
        })),
        sale_invoices_net_total: roundMoney(relatedSales.reduce((sum, invoice) => sum + (invoice.base_net_price ?? invoice.net_price ?? 0), 0)),
        purchase_invoices_net_total: roundMoney(relatedPurchases.reduce((sum, invoice) => sum + (invoice.base_net_price ?? invoice.net_price ?? 0), 0)),
        sale_invoice_count: relatedSales.length,
        purchase_invoice_count: relatedPurchases.length,
        related_journal_count: relatedJournals.length,
        note: "Journal count may overlap with invoice-generated journals and should be used as a disclosure review aid, not as a final transaction amount.",
      },
    },
    warnings,
  };
}

export function registerAnnualReportTools(server: McpServer, api: ApiContext): void {
  registerTool(server, "prepare_year_end_close",
    "Analyze the fiscal year and prepare a dry-run year-end close package: unresolved items, accrual review, balance check, and draft P&L closing entries.",
    yearShape,
    { ...readOnly, title: "Prepare Year-End Close" },
    async ({ year }) => {
      const analysis = await analyzeYearEndClose(api, year);
      if ("error" in analysis) {
        return toolError(analysis);
      }
      return {
        content: [{
          type: "text",
          text: toMcpJson(analysis),
        }],
      };
    },
  );

  registerTool(server, "generate_annual_report_data",
    "Generate structured annual report data for the Estonian RTJ micro/small-entity format: balance sheet, income statement (Schema 1), cash-flow data, ratios, and note inputs.",
    yearShape,
    { ...readOnly, title: "Generate Annual Report Data" },
    async ({ year }) => {
      const reportData = await buildAnnualReportData(api, year);
      return {
        content: [{
          type: "text",
          text: toMcpJson(reportData),
        }],
      };
    },
  );

  registerTool(server, "execute_year_end_close",
    "Create the executable closing journal entries proposed by prepare_year_end_close. Requires confirm=true. Creates draft journals only; review and register them separately.",
    {
      ...yearShape,
      confirm: z.boolean().describe("Must be true to create the closing journal entries"),
    },
    { ...batch, title: "Execute Year-End Close" },
    async ({ year, confirm }) => {
      if (confirm !== true) {
        return toolError({
          error: "Explicit confirmation required",
          hint: "Re-run execute_year_end_close with confirm=true to create the closing journal entries.",
        });
      }

      const analysis = await analyzeYearEndClose(api, year);
      if ("error" in analysis) {
        return toolError(analysis);
      }

      if (analysis.existing_year_end_close_journals.length > 0) {
        return toolError({
          error: "Year-end close already exists",
          existing_year_end_close_journals: analysis.existing_year_end_close_journals,
          hint: "Delete or invalidate the existing close manually if you need to recreate it.",
        });
      }

      const executableProposals = analysis.proposed_journal_entries
        .filter((proposal) => proposal.auto_executable)
        .filter((proposal) => Math.abs(proposal.totals.difference) < 0.01);

      if (executableProposals.length === 0) {
        return {
          content: [{
            type: "text",
            text: toMcpJson({
              message: "No executable year-end close entries were generated.",
              analysis,
            }),
          }],
        };
      }

      const created = [];
      for (const proposal of executableProposals) {
        const result = await api.journals.create({
          title: proposal.title,
          effective_date: proposal.effective_date,
          document_number: proposal.document_number,
          cl_currencies_id: "EUR",
          postings: proposal.postings.map((posting) => ({
            accounts_id: posting.accounts_id,
            type: posting.type,
            amount: posting.amount,
          })),
        });
        logAudit({
          tool: "create_annual_closing_entries", action: "CREATED", entity_type: "journal",
          entity_id: result.created_object_id,
          summary: `Created year-end closing journal "${proposal.title}" for ${proposal.effective_date}`,
          details: {
            effective_date: proposal.effective_date,
            document_number: proposal.document_number,
            postings: proposal.postings,
          },
        });

        created.push({
          title: proposal.title,
          effective_date: proposal.effective_date,
          document_number: proposal.document_number,
          api_response: result,
          postings: proposal.postings,
        });
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            year,
            created_journals: created,
            preflight: {
              execution_status: analysis.execution_status,
              unresolved_items: analysis.unresolved_items,
              balance_sheet_check: analysis.balance_sheet_check,
              warnings: analysis.warnings,
            },
            note: "Closing journals were created as drafts. Review and confirm them separately.",
          }),
        }],
      };
    },
  );
}
