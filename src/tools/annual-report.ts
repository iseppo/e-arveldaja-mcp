import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import { logAudit } from "../audit-log.js";
import type { Account, Client, Journal, Posting, PurchaseInvoice, SaleInvoice, Transaction } from "../types/api.js";
import { computeAllBalances, type AccountBalance } from "./financial-statements.js";
import { roundMoney, effectiveGross } from "../money.js";
import { readOnly, batch } from "../annotations.js";
import { isProjectTransaction } from "../transaction-status.js";
import { validateAccounts, validatePostingDimensions } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { isMutationIndeterminate } from "../mutation-outcome.js";
import { getCashFlowCategoryRule, getCurrentYearProfitAccountRule, getLiabilityClassificationRule } from "../accounting-rules.js";
import {
  resolveCalculatedResultAccount,
  resolveCurrentYearProfitAccount,
  resolveReserveCapitalAccount,
  resolveRestrictedReserveAccounts,
  resolveRetainedEarningsAccount,
} from "../account-resolution.js";
import { withOpeningBalanceStatusInRange } from "../opening-balance-limitations.js";
import { loadOpeningBalanceJournal } from "../opening-balance-journal.js";
import {
  isYearEndClosingJournal,
  isResultEntryShape,
  isRetainedTransferShape,
  isYearEndResultEntry,
  isYearEndTransferEntry,
  yearEndResultDocumentNumber,
  yearEndTransferDocumentNumber,
} from "../year-end-closing-journal.js";

type PostingType = "D" | "C";
type CashFlowClass = "operating" | "investing" | "financing" | "unclassified";
type LiabilityClass = "current" | "non_current" | "manual_review";

interface PostingPreview {
  accounts_id: number;
  accounts_dimensions_id?: number;
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

interface BlockedCloseEntry {
  document_number: string;
  reason: string;
  resolution: "allow_additional_transfer" | "correct_result_entry" | "manual_review";
}

interface YearEndCloseAnalysis {
  year: number;
  period: {
    from: string;
    to: string;
  };
  dry_run: boolean;
  method: string;
  accounts: {
    calculated_result: number;
    current_year_profit: number;
    retained_earnings: number;
    reserve_capital?: number;
  };
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
  close_status: {
    status: "open" | "partially_closed" | "closed" | "nothing_to_close";
    result_entry: "proposed" | "exists" | "legacy_yecl" | "mismatch" | "not_needed";
    retained_transfer_entry: "proposed" | "exists" | "mismatch" | "ambiguous" | "blocked" | "not_needed";
  };
  proposed_journal_entries: JournalProposal[];
  blocked_entries: BlockedCloseEntry[];
  existing_year_end_close_journals: Array<{
    id: number;
    kind: "legacy_yecl" | "result_entry" | "retained_transfer";
    date: string;
    title: string | undefined;
    document_number: string | null | undefined;
    registered: boolean;
  }>;
  statutory_reminders: string[];
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

const closeOptionsShape = {
  reserve_capital_amount: z.number().positive().optional()
    .describe("Part of a profit to credit to reserve capital (default account: name-resolved Kohustuslik reservkapital, 2940) instead of retained earnings in the 1 January entry"),
  reserve_capital_account: z.number().int().optional()
    .describe("Reserve capital account override for reserve_capital_amount"),
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

// Signed P&L line: income (Tulud) adds, expense (Kulud) subtracts — used for
// net lines (financial result, unmapped remainder) that combine both types.
function buildSignedProfitAndLossLine(
  label: string,
  balances: AccountBalance[],
  predicate: (balance: AccountBalance) => boolean,
): StatementLine {
  const sourceAccounts = balances
    .filter(predicate)
    .map((balance) => ({
      account_id: balance.account_id,
      name: balance.name_est,
      amount: roundMoney(balance.account_type_est === "Kulud" ? -statementAmount(balance) : statementAmount(balance)),
    }))
    .filter((account) => Math.abs(account.amount) >= 0.01);

  return {
    label,
    amount: roundMoney(sourceAccounts.reduce((sum, account) => sum + account.amount, 0)),
    source_accounts: sourceAccounts,
  };
}

function sumPostingAmounts(postings: PostingPreview[], type: PostingType): number {
  return roundMoney(postings.filter((posting) => posting.type === type).reduce((sum, posting) => sum + posting.amount, 0));
}

function hasExplicitCurrentLiabilityMarker(name: string): boolean {
  const hasCurrentPortionMarker = /\bcurrent\b.*\bportion\b/.test(name) && !/\bnon[-\s]+current\b.*\bportion\b/.test(name);
  return (
    name.includes("lühiajal") ||
    name.includes("järgmisel perioodil") ||
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

// Standard chart: 21xx-27xx Kohustused are current (short-term loans, current
// portions of long-term debt, customer prepayments, payables, taxes, payroll,
// accruals, short-term provisions/grants) and 28xx are non-current. An
// explicit current-portion marker wins first (2120 "Pikaajalise võlakohustuse
// tagasimaksed järgmisel perioodil" is current despite "pikaajal"); a
// long-term name marker still diverts a custom 21xx-27xx account; configured
// overrides in accounting-rules.md take precedence over everything.
function classifyLiabilitySection(balance: AccountBalance): LiabilityClass {
  const name = `${balance.name_est} ${balance.name_eng}`.toLowerCase();
  const configured = getLiabilityClassificationRule(balance.account_id);
  if (configured) return configured;
  if (hasExplicitCurrentLiabilityMarker(name)) return "current";
  if (hasExplicitNonCurrentLiabilityMarker(name)) return "non_current";
  if (inRange(balance.account_id, 2100, 2799)) return "current";
  if (inRange(balance.account_id, 2800, 2899)) return "non_current";
  return "manual_review";
}

// Balance-sheet asset classification by account-number prefix. Current assets
// (Käibevara) span 10–16 — cash (10), short-term financial investments / broker
// cash (11), trade receivables (12), other receivables (13–14), tax prepayments /
// prepaid expenses (15), inventories (16); non-current assets (Põhivara) span 17–19.
// Extracted so the same predicates drive both the displayed lines and the
// unclassified-asset safety net (an asset outside both ranges would otherwise
// vanish from the asset lines while still counting toward total assets — the
// liabilities side already has this via the "Klassifitseerimata kohustused" line).
function isCurrentAssetAccount(balance: AccountBalance): boolean {
  return balance.account_type_est === "Varad" &&
    (hasPrefix(balance.account_id, "10") || hasPrefix(balance.account_id, "11") ||
      hasPrefix(balance.account_id, "12") || hasPrefix(balance.account_id, "13") ||
      hasPrefix(balance.account_id, "14") || hasPrefix(balance.account_id, "15") ||
      hasPrefix(balance.account_id, "16"));
}

function isNonCurrentAssetAccount(balance: AccountBalance): boolean {
  return balance.account_type_est === "Varad" &&
    (hasPrefix(balance.account_id, "17") || hasPrefix(balance.account_id, "18") ||
      hasPrefix(balance.account_id, "19"));
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
        title: wrapUntrustedOcr(journal.title),
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
        client: wrapUntrustedOcr(invoice.client_name ?? undefined) ?? "",
        gross: effectiveGross(invoice),
      })),
    },
    unconfirmed_purchase_invoices: {
      count: unconfirmedPurchases.length,
      items: unconfirmedPurchases.slice(0, 20).map((invoice) => ({
        id: invoice.id!,
        number: wrapUntrustedOcr(invoice.number) ?? "",
        client: wrapUntrustedOcr(invoice.client_name ?? undefined) ?? "",
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

// Re-exported: callers and tests import the detector from here.
export { isYearEndClosingJournal };

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

interface CloseAccounts {
  calculatedResult: number;
  currentYearProfit: number;
  retainedEarnings: number;
  reserve: number;
  reserves: number[];
}

// Chart accounts of the RIK close, name-resolved against the company chart with
// the standard numbers (9000 / 2970 / 2960 / 2940) as fallback. The
// accounting-rules "current year profit account" stays an explicit override.
function resolveCloseAccounts(accounts: Account[], reserveOverride?: number): CloseAccounts {
  const reserve = resolveReserveCapitalAccount(accounts, reserveOverride);
  return {
    calculatedResult: resolveCalculatedResultAccount(accounts),
    currentYearProfit: resolveCurrentYearProfitAccount(accounts, getCurrentYearProfitAccountRule()),
    retainedEarnings: resolveRetainedEarningsAccount(accounts),
    reserve,
    reserves: [...new Set([reserve, ...resolveRestrictedReserveAccounts(accounts)])],
  };
}

type ExistingCloseKind = "legacy_yecl" | "result_entry" | "retained_transfer";

interface ExistingCloseJournals {
  legacy: Journal[];
  result: Journal[];
  transfer: Journal[];
}

// Live (not deleted; registered OR draft) closing journals for `year`. The
// synthetic opening-balance journal (id -1) is never a close.
function findExistingCloseJournals(allJournals: Journal[], year: number, ids: CloseAccounts): ExistingCloseJournals {
  const live = allJournals.filter((journal) => !journal.is_deleted && journal.id !== -1);
  // A legacy close zeroed P&L INTO 2970 — a title-only look-alike that never
  // touches 2970 is not a close (it stays excluded from the P&L, though).
  const legacy = live.filter((journal) => isYearEndClosingJournal(journal, year) &&
    (journal.postings ?? []).some((posting) => !posting.is_deleted && posting.accounts_id === ids.currentYearProfit));
  return {
    legacy,
    result: live.filter((journal) => !legacy.includes(journal) && isYearEndResultEntry(journal, year, ids)),
    transfer: live.filter((journal) => isYearEndTransferEntry(journal, year, {
      currentYearProfit: ids.currentYearProfit,
      retainedEarnings: ids.retainedEarnings,
      reserves: ids.reserves,
    })),
  };
}

// Net credit − debit on one account across the given journals' live postings.
function netCredit(journals: Journal[], accountId: number): number {
  let total = 0;
  for (const journal of journals) {
    for (const posting of journal.postings ?? []) {
      if (posting.is_deleted || posting.accounts_id !== accountId) continue;
      const amount = posting.base_amount ?? posting.amount;
      if (posting.type === "C") total += amount;
      else if (posting.type === "D") total -= amount;
    }
  }
  return roundMoney(total);
}

// Net debit − credit on one account (a profit transfer debits 2970).
function netDebit(journals: Journal[], accountId: number): number {
  return roundMoney(-netCredit(journals, accountId));
}

/**
 * Warnings for the calculated-result account (9000). Posting to it IS the
 * standard RIK close (entry A), so only postings OUTSIDE a closing entry, or a
 * closing entry whose amount differs from the year's result, are flagged.
 */
function buildCalculatedResultWarnings(
  allJournals: Journal[],
  year: number,
  ids: CloseAccounts,
  netProfit: number,
): string[] {
  const { from, to } = getYearBounds(year);
  const warnings: string[] = [];
  const outside = allJournals.filter((journal) =>
    !journal.is_deleted && journal.registered &&
    journal.effective_date >= from && journal.effective_date <= to &&
    !isYearEndResultEntry(journal, year, ids),
  );
  const outsideAmount = roundMoney(-netCredit(outside, ids.calculatedResult));
  if (Math.abs(outsideAmount) >= 0.01) {
    warnings.push(
      `Account ${ids.calculatedResult} (Arvestuslik koondtulemus) carries ${outsideAmount} EUR (debit − credit) from postings outside ` +
      `the RIK year-end result entry (${year}-12-31, ${ids.calculatedResult} ↔ ${ids.currentYearProfit}). It is excluded from the ` +
      "income statement; review and move those postings to the correct revenue/expense accounts.",
    );
  }
  const resultEntries = allJournals.filter((journal) =>
    !journal.is_deleted && journal.id !== -1 && isYearEndResultEntry(journal, year, ids),
  );
  if (resultEntries.length > 0) {
    const booked = netCredit(resultEntries, ids.currentYearProfit);
    if (Math.abs(booked - netProfit) >= 0.01) {
      warnings.push(
        `The ${year} year-end result entry (journal ${resultEntries.map((journal) => journal.id).join(", ")}) books ${booked} EUR to ` +
        `${ids.currentYearProfit}, but the ${year} result is ${netProfit} EUR. Revenue/expense postings may have changed after the close — ` +
        "correct the result entry.",
      );
    }
  }
  return warnings;
}

function makeProposal(
  title: string,
  effectiveDate: string,
  documentNumber: string,
  rationale: string,
  postings: PostingPreview[],
): JournalProposal {
  const debit = sumPostingAmounts(postings, "D");
  const credit = sumPostingAmounts(postings, "C");
  return {
    source: "closing",
    auto_executable: true,
    dry_run: true,
    title,
    effective_date: effectiveDate,
    document_number: documentNumber,
    rationale,
    postings,
    totals: { debit, credit, difference: roundMoney(debit - credit) },
  };
}

// Entry A (last day of the year): profit D 9000 / K 2970, loss D 2970 / K 9000.
function buildResultEntryProposal(
  year: number,
  netProfit: number,
  ids: CloseAccounts,
  accountsById: Map<number, Account>,
): JournalProposal {
  const amount = roundMoney(Math.abs(netProfit));
  const profit = netProfit > 0;
  const calculatedName = accountsById.get(ids.calculatedResult)?.name_est ?? "Arvestuslik koondtulemus";
  const currentName = accountsById.get(ids.currentYearProfit)?.name_est ?? "Aruandeaasta kasum (kahjum)";
  return makeProposal(
    `Majandusaasta lõpetamine ${year}`,
    `${year}-12-31`,
    yearEndResultDocumentNumber(year),
    `RIK e-arveldaja year-end close, entry 1: moves the ${year} ${profit ? "profit" : "loss"} (${netProfit} EUR = revenue − expenses, ` +
    `excluding ${ids.calculatedResult}) from ${ids.calculatedResult} to ${ids.currentYearProfit}. Revenue and expense accounts are NOT zeroed.`,
    [
      { accounts_id: ids.calculatedResult, account_name: calculatedName, type: profit ? "D" : "C", amount, description: `Aruandeaasta ${profit ? "kasum" : "kahjum"} ${year}` },
      { accounts_id: ids.currentYearProfit, account_name: currentName, type: profit ? "C" : "D", amount, description: `Aruandeaasta ${profit ? "kasum" : "kahjum"} ${year}` },
    ],
  );
}

// Entry B (first day of the next year): profit D 2970 / K 2960 (part optionally
// K 2940), loss D 2960 / K 2970.
function buildTransferEntryProposal(
  year: number,
  result: number,
  reserveAmount: number,
  ids: CloseAccounts,
  accountsById: Map<number, Account>,
): JournalProposal {
  const amount = roundMoney(Math.abs(result));
  const profit = result > 0;
  const name = (id: number, fallback: string) => accountsById.get(id)?.name_est ?? fallback;
  const description = `Aruandeaasta ${year} ${profit ? "kasum" : "kahjum"}`;
  const postings: PostingPreview[] = profit
    ? [
      { accounts_id: ids.currentYearProfit, account_name: name(ids.currentYearProfit, "Aruandeaasta kasum (kahjum)"), type: "D", amount, description },
      ...(amount - reserveAmount >= 0.005
        ? [{ accounts_id: ids.retainedEarnings, account_name: name(ids.retainedEarnings, "Eelmiste perioodide jaotamata kasum (kahjum)"), type: "C" as const, amount: roundMoney(amount - reserveAmount), description }]
        : []),
      ...(reserveAmount >= 0.005
        ? [{ accounts_id: ids.reserve, account_name: name(ids.reserve, "Kohustuslik reservkapital"), type: "C" as const, amount: reserveAmount, description: `Reservkapitali eraldis ${year}` }]
        : []),
    ]
    : [
      { accounts_id: ids.retainedEarnings, account_name: name(ids.retainedEarnings, "Eelmiste perioodide jaotamata kasum (kahjum)"), type: "D", amount, description },
      { accounts_id: ids.currentYearProfit, account_name: name(ids.currentYearProfit, "Aruandeaasta kasum (kahjum)"), type: "C", amount, description },
    ];
  return makeProposal(
    `Aruandeaasta ${year} tulemuse kandmine eelmiste perioodide jaotamata kasumisse`,
    `${year + 1}-01-01`,
    yearEndTransferDocumentNumber(year),
    `RIK e-arveldaja year-end close, entry 2: transfers the ${year} result (${result} EUR) from ${ids.currentYearProfit} to ` +
    `${ids.retainedEarnings}${reserveAmount >= 0.005 ? `, of which ${reserveAmount} EUR to reserve capital ${ids.reserve}` : ""}.`,
    postings,
  );
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

  // Standard chart: 26xx payroll/dividend/interest payables and accruals
  // (2612 puhkusereserv, 2690 muud viitvõlad), 27xx short-term provisions and
  // grants. 29xx is Omakapital, not a liability.
  const accruedLiabilityReview = yearEndBalances
    .filter((balance) => balance.account_type_est === "Kohustused" && (
      inRange(balance.account_id, 2600, 2799) ||
      (inRange(balance.account_id, 2300, 2399) &&
        /accr|viit|intress|puhkus|reserv|provis/i.test(`${balance.name_est} ${balance.name_eng}`))
    ))
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

interface YearEndCloseOptions {
  reserveCapitalAmount?: number;
  reserveCapitalAccount?: number;
  allowAdditionalTransfer?: boolean;
}

async function analyzeYearEndClose(
  api: ApiContext,
  year: number,
  options: YearEndCloseOptions = {},
): Promise<YearEndCloseAnalysis | { error: string; details: string[] }> {
  const { from, to } = getYearBounds(year);

  const [accounts, opening, journalsFromApi, allTransactions, allSales, allPurchases] = await Promise.all([
    api.readonly.getAccounts(),
    loadOpeningBalanceJournal(api),
    api.journals.listAllWithPostings(),
    api.transactions.listAll(),
    api.saleInvoices.listAll(),
    api.purchaseInvoices.listAll(),
  ]);
  const allJournals = [...(opening ? [opening.journal] : []), ...journalsFromApi];
  const [yearEndBalances, yearProfitAndLossBalances] = await Promise.all([
    computeAllBalances(api, undefined, to, { preloadedAccounts: accounts, preloadedJournals: allJournals }),
    computeAllBalances(api, from, to, {
      preloadedAccounts: accounts,
      preloadedJournals: allJournals,
      journalFilter: (journal) => !isYearEndClosingJournal(journal, year),
    }),
  ]);

  const ids = resolveCloseAccounts(accounts, options.reserveCapitalAccount);
  const reserveAmount = roundMoney(options.reserveCapitalAmount ?? 0);
  const accountErrors = validateAccounts(accounts, [
    { id: ids.calculatedResult, label: "Calculated result account (Arvestuslik koondtulemus)" },
    { id: ids.currentYearProfit, label: "Current year profit account" },
    { id: ids.retainedEarnings, label: "Retained earnings account" },
    ...(reserveAmount > 0 ? [{ id: ids.reserve, label: "Reserve capital account" }] : []),
  ]);
  if (accountErrors.length > 0) {
    return {
      error: "Account validation failed",
      details: accountErrors,
    };
  }

  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const unresolvedItems = buildUnresolvedItems(from, to, allJournals, allTransactions, allSales, allPurchases);
  const existing = findExistingCloseJournals(allJournals, year, ids);

  const isIncomeStatementAccount = (balance: AccountBalance) => balance.account_id !== ids.calculatedResult;
  const assets = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Varad");
  const liabilities = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Kohustused");
  const equity = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Omakapital");
  // Open P&L across ALL periods up to year-end, 9000 included — exactly the
  // amount compute_balance_sheet folds into equity. After entry A the year's
  // P&L and the 9000 debit cancel here while the result sits in 2970.
  const openProfitAndLoss = roundMoney(
    sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Tulud") -
    sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Kulud"),
  );
  const revenue = sumStatementBalances(yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Tulud" && isIncomeStatementAccount(balance));
  const expenses = sumStatementBalances(yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && isIncomeStatementAccount(balance));
  const netProfit = roundMoney(revenue - expenses);
  const equityIncludingCurrentYearResult = roundMoney(equity + openProfitAndLoss);
  const balanceDifference = roundMoney(assets - liabilities - equityIncludingCurrentYearResult);

  const warnings: string[] = [];
  const blockedEntries: BlockedCloseEntry[] = [];
  const transferDocumentNumber = yearEndTransferDocumentNumber(year);

  // Entry A: an existing result entry (or legacy YECL) must move exactly the
  // year's result in the right direction (profit → credit 2970). Anything else
  // is not a close — and entry B must never be derived from it.
  const resultJournals = [...existing.result, ...existing.legacy];
  const resultEntryBooked = resultJournals.length > 0;
  const bookedResult = netCredit(resultJournals, ids.currentYearProfit);
  // A YEC-RESULT-YYYY found by number alone must still post only 9000 ↔ 2970;
  // e.g. an edited D 2960 / K 2970 draft moves the right amount but is no close.
  const malformedResultJournals = existing.result.filter((journal) => !isResultEntryShape(journal, ids));
  const resultEntryMismatch = resultEntryBooked &&
    (Math.abs(bookedResult - netProfit) >= 0.01 || malformedResultJournals.length > 0);
  // What entry A put (or will put) on 2970 is what entry B must move on.
  const expectedTransfer = resultEntryBooked ? bookedResult : netProfit;
  const matchesExpected = (amount: number) => Math.abs(amount - expectedTransfer) < 0.01;

  // Same reconciliation generate_annual_report_data uses: 2970 + open P&L
  // (9000 included) at year-end minus this year's result is what earlier years
  // left unclosed or untransferred.
  const currentYearProfitBalance = sumStatementBalances(yearEndBalances, (balance) => balance.account_id === ids.currentYearProfit);
  const priorYearResidual = roundMoney(currentYearProfitBalance + openProfitAndLoss - netProfit);

  // Entry B: the Jan 1 entries are matched structurally; operators also book
  // the transfer by hand on any other date of the next year (live practice:
  // 1 December), so those count when their 2970 debit equals the result.
  const transferAccounts = { currentYearProfit: ids.currentYearProfit, retainedEarnings: ids.retainedEarnings, reserves: ids.reserves };
  const onDateBooked = netDebit(existing.transfer, ids.currentYearProfit);
  // Same for YEC-RETAINED-YYYY found by number alone: it must post only
  // 2970 ↔ 2960 (+ reserve), or it is no transfer and needs manual review.
  const malformedTransferJournals = existing.transfer.filter((journal) => !isRetainedTransferShape(journal, transferAccounts));
  const offDateCandidates = allJournals.filter((journal) =>
    !journal.is_deleted && journal.id !== -1 &&
    journal.effective_date.startsWith(`${year + 1}-`) && journal.effective_date !== `${year + 1}-01-01` &&
    isRetainedTransferShape(journal, transferAccounts));
  const offDateMatches = malformedTransferJournals.length > 0 || (existing.transfer.length > 0 && matchesExpected(onDateBooked))
    ? []
    : offDateCandidates.filter((journal) => matchesExpected(onDateBooked + netDebit([journal], ids.currentYearProfit)));
  // A matching off-date entry may equally be an earlier year's late transfer
  // when that earlier result is still sitting untransferred on 2970.
  const offDateAmbiguous = offDateMatches.length > 1 || (offDateMatches.length === 1 && Math.abs(priorYearResidual) >= 0.01 &&
    Math.abs(netDebit(offDateMatches, ids.currentYearProfit) - priorYearResidual) < 0.01);
  const describeJournals = (journals: Journal[]) =>
    journals.map((journal) => `${journal.id} (${journal.effective_date}: ${netDebit([journal], ids.currentYearProfit)} EUR)`).join(", ");

  let transferState: YearEndCloseAnalysis["close_status"]["retained_transfer_entry"];
  let transferJournals = existing.transfer;
  let transferAmount = 0;
  let transferNeedsAcknowledgement = false;
  if (existing.transfer.length === 0 && offDateCandidates.length === 0) {
    transferState = Math.abs(expectedTransfer) >= 0.01 ? "proposed" : "not_needed";
    transferAmount = expectedTransfer;
  } else if (existing.transfer.length > 0 && malformedTransferJournals.length === 0 && matchesExpected(onDateBooked) &&
    offDateCandidates.length === 0) {
    transferState = "exists";
  } else if (offDateMatches.length === 1 && offDateCandidates.length === 1 && !offDateAmbiguous) {
    transferState = "exists";
    transferJournals = [...existing.transfer, offDateMatches[0]!];
  } else {
    const remainder = roundMoney(expectedTransfer - onDateBooked);
    // Only a same-direction remainder that does not exceed the result can be
    // proposed; an over-transfer or a reversed transfer needs manual review.
    // Off-date transfers cannot be attributed to this year with certainty, so
    // any of them makes the remainder unknowable — manual review as well.
    // A further next-year transfer beside a complete one is a possible
    // duplicate (or another year's) — also manual review, never "closed".
    const remainderIsSafe = offDateCandidates.length === 0 && malformedTransferJournals.length === 0 && Math.abs(remainder) >= 0.01 && Math.sign(remainder) === Math.sign(expectedTransfer) &&
      Math.abs(remainder) <= Math.abs(expectedTransfer) + 0.005;
    transferState = offDateAmbiguous ? "ambiguous" : "mismatch";
    const found = [...existing.transfer, ...offDateCandidates];
    warnings.push(
      `Journal(s) ${describeJournals(found)} transfer between ${ids.currentYearProfit} and ${ids.retainedEarnings} for ${year} ` +
      `(net ${ids.currentYearProfit} debit shown), but the ${year} result to transfer is ${expectedTransfer} EUR` +
      (offDateAmbiguous
        ? ` and it cannot be told which year each belongs to (an earlier year's ${priorYearResidual} EUR is still untransferred on ${ids.currentYearProfit}).`
        : `; booked on 1 January: ${onDateBooked} EUR.`) +
      (malformedTransferJournals.length > 0
        ? ` Journal(s) ${malformedTransferJournals.map((journal) => journal.id).join(", ")} carry ${transferDocumentNumber} but also post outside ` +
          `${ids.currentYearProfit}/${ids.retainedEarnings}/reserves.`
        : "") +
      (remainderIsSafe
        ? ` Only the remaining ${remainder} EUR is proposed, and ${transferDocumentNumber} is booked only with allow_additional_transfer=true.`
        : ` No further transfer is proposed — correct the existing transfer(s) by hand.`),
    );
    if (remainderIsSafe) {
      transferAmount = remainder;
      transferNeedsAcknowledgement = !options.allowAdditionalTransfer;
      if (transferNeedsAcknowledgement) {
        blockedEntries.push({
          document_number: transferDocumentNumber,
          reason: `An existing ${year} transfer (${describeJournals(found)}) differs from the result to transfer (${expectedTransfer} EUR) or is ambiguous.`,
          resolution: "allow_additional_transfer",
        });
      }
    } else {
      blockedEntries.push({
        document_number: transferDocumentNumber,
        reason: `The existing ${year} transfer (${describeJournals(found)}) exceeds, reverses or duplicates the result to transfer (${expectedTransfer} EUR).`,
        resolution: "manual_review",
      });
    }
  }
  if (resultEntryMismatch && Math.abs(transferAmount) >= 0.01) {
    // Never derive entry B from a wrong entry A (reversed or stale amount).
    transferAmount = 0;
    transferNeedsAcknowledgement = false;
    if (transferState === "proposed") transferState = "blocked";
    const staleBlocker = blockedEntries.findIndex((entry) => entry.document_number === transferDocumentNumber);
    if (staleBlocker >= 0) blockedEntries.splice(staleBlocker, 1);
    blockedEntries.push({
      document_number: transferDocumentNumber,
      reason: `The ${year} result entry (journal ${resultJournals.map((journal) => journal.id).join(", ")}) books ${bookedResult} EUR to ` +
        `${ids.currentYearProfit}, but the ${year} result is ${netProfit} EUR` +
        (malformedResultJournals.length > 0
          ? `, and journal(s) ${malformedResultJournals.map((journal) => journal.id).join(", ")} do not post only ${ids.calculatedResult} ↔ ${ids.currentYearProfit}.`
          : "."),
      resolution: "correct_result_entry",
    });
  }

  if (reserveAmount > 0 && Math.abs(transferAmount) >= 0.01) {
    if (transferAmount <= 0) {
      return {
        error: "Invalid reserve_capital_amount",
        details: [`reserve_capital_amount can only split a profit; the ${year} result to transfer is ${transferAmount} EUR.`],
      };
    }
    if (reserveAmount > transferAmount) {
      return {
        error: "Invalid reserve_capital_amount",
        details: [`reserve_capital_amount ${reserveAmount} EUR exceeds the ${year} profit to transfer (${transferAmount} EUR).`],
      };
    }
  }

  const resultProposal = !resultEntryBooked && Math.abs(netProfit) >= 0.01
    ? buildResultEntryProposal(year, netProfit, ids, accountsById)
    : null;
  const transferProposal = Math.abs(transferAmount) >= 0.01
    ? buildTransferEntryProposal(year, transferAmount, reserveAmount, ids, accountsById)
    : null;
  if (transferProposal && transferNeedsAcknowledgement) {
    transferProposal.auto_executable = false;
    transferProposal.warnings = [
      `Not booked by execute_year_end_close unless allow_additional_transfer=true: a smaller ${year} transfer already exists on 1 January; only the remainder is proposed.`,
    ];
  }
  const accrualReview = buildAccrualReview(yearEndBalances, accountsById, unresolvedItems);

  const resultState: YearEndCloseAnalysis["close_status"]["result_entry"] = resultEntryMismatch
    ? "mismatch"
    : existing.legacy.length > 0 ? "legacy_yecl" : existing.result.length > 0 ? "exists" : resultProposal ? "proposed" : "not_needed";
  const anythingBooked = resultEntryBooked || transferJournals.length > 0 || offDateCandidates.length > 0;
  const complete = (resultState === "exists" || resultState === "legacy_yecl" || resultState === "not_needed") &&
    (transferState === "exists" || transferState === "not_needed");
  const closeStatus: YearEndCloseAnalysis["close_status"]["status"] = !anythingBooked
    ? (resultProposal || transferProposal ? "open" : "nothing_to_close")
    : complete ? "closed" : "partially_closed";

  if (existing.legacy.length > 0) {
    warnings.push(
      `A legacy YECL-${year} closing journal (${existing.legacy.map((journal) => journal.id).join(", ")}) zeroes the revenue/expense accounts into ` +
      `${ids.currentYearProfit}. It is treated as entry 1 (never booked twice), but it breaks e-arveldaja's own income statement: ` +
      `RIK's method keeps revenue/expense balances and posts only ${ids.calculatedResult} ↔ ${ids.currentYearProfit}. If it is still a draft, ` +
      "delete it and re-run prepare_year_end_close.",
    );
  }
  if (closeStatus === "closed") {
    warnings.push(`The ${year} year-end close already exists (both RIK entries found). Nothing is booked twice.`);
  } else if (closeStatus === "partially_closed") {
    warnings.push(blockedEntries.length > 0
      ? `The ${year} year-end close is partially booked and needs correction; see blocked_entries.`
      : `The ${year} year-end close is partially booked; only the missing entry is proposed.`);
  } else if (closeStatus === "nothing_to_close") {
    warnings.push(`The ${year} result is zero; no year-end closing entries are needed.`);
  }
  if (resultEntryMismatch) {
    const expectedSide = netProfit >= 0 ? `D ${ids.calculatedResult} / K ${ids.currentYearProfit}` : `D ${ids.currentYearProfit} / K ${ids.calculatedResult}`;
    warnings.push(
      `The ${year} result entry (journal ${resultJournals.map((journal) => journal.id).join(", ")}) moves ${bookedResult} EUR to ` +
      `${ids.currentYearProfit} (booked), but the ${year} result is ${netProfit} EUR (expected ${expectedSide} ${roundMoney(Math.abs(netProfit))} EUR). ` +
      (malformedResultJournals.length > 0
        ? `Journal(s) ${malformedResultJournals.map((journal) => journal.id).join(", ")} carry ${yearEndResultDocumentNumber(year)} but do not post only ` +
          `${ids.calculatedResult} ↔ ${ids.currentYearProfit}. `
        : "") +
      `It is not treated as the close: correct it before ${transferDocumentNumber} is booked.`,
    );
  }
  warnings.push(...buildCalculatedResultWarnings(allJournals, year, ids, netProfit));
  if (Math.abs(priorYearResidual) >= 0.01) {
    warnings.push(
      `Aruandeaasta kasum (${ids.currentYearProfit}: ${currentYearProfitBalance} EUR) + sulgemata tulem (${openProfitAndLoss} EUR) at ${to} ` +
      `differs from the ${year} result (${netProfit} EUR) by ${priorYearResidual} EUR: an earlier year is not closed (RIK entry ` +
      `${ids.calculatedResult} ↔ ${ids.currentYearProfit}) or its result is not yet transferred ${ids.currentYearProfit} → ${ids.retainedEarnings}. ` +
      "Run prepare_year_end_close for the earlier year(s) first.",
    );
  }
  if (Math.abs(balanceDifference) >= 0.01) {
    warnings.push(`Balance sheet does not balance at ${to}. Difference: ${balanceDifference} EUR.`);
  }

  const proposedJournalEntries = [
    ...accrualReview.automatic_entries,
    ...(resultProposal ? [resultProposal] : []),
    ...(transferProposal ? [transferProposal] : []),
  ];

  const canExecute = proposedJournalEntries.some((proposal) => proposal.auto_executable && Math.abs(proposal.totals.difference) < 0.01);

  const recommendedToExecute = canExecute &&
    blockedEntries.length === 0 &&
    unresolvedItems.total_issues === 0 &&
    Math.abs(balanceDifference) < 0.01;

  const describeExisting = (journal: Journal, kind: ExistingCloseKind) => ({
    id: journal.id!,
    kind,
    date: journal.effective_date,
    title: wrapUntrustedOcr(journal.title),
    document_number: wrapUntrustedOcr(journal.document_number) ?? journal.document_number,
    registered: journal.registered === true,
  });

  return {
    year,
    period: { from, to },
    dry_run: true,
    method: "RIK e-arveldaja year-end close (Äriühingu majandusaasta lõpetamiskanded): " +
      `entry 1 on ${to} ${ids.calculatedResult} ↔ ${ids.currentYearProfit}, entry 2 on ${year + 1}-01-01 ` +
      `${ids.currentYearProfit} → ${ids.retainedEarnings}. Revenue/expense accounts are not zeroed.`,
    accounts: {
      calculated_result: ids.calculatedResult,
      current_year_profit: ids.currentYearProfit,
      retained_earnings: ids.retainedEarnings,
      ...(reserveAmount > 0 ? { reserve_capital: ids.reserve } : {}),
    },
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
    close_status: {
      status: closeStatus,
      result_entry: resultState,
      retained_transfer_entry: transferState,
    },
    proposed_journal_entries: proposedJournalEntries,
    blocked_entries: blockedEntries,
    existing_year_end_close_journals: [
      ...existing.legacy.map((journal) => describeExisting(journal, "legacy_yecl")),
      ...existing.result.map((journal) => describeExisting(journal, "result_entry")),
      ...transferJournals.map((journal) => describeExisting(journal, "retained_transfer")),
    ],
    execution_status: {
      can_execute: canExecute,
      recommended_to_execute: recommendedToExecute,
      reason: !canExecute
        ? (blockedEntries.length > 0
          ? "Nothing can be booked automatically: see blocked_entries."
          : "Nothing to book: the year-end close already exists, or the year's result is zero.")
        : blockedEntries.length > 0
          ? "Some closing entries are blocked (see blocked_entries); execute_year_end_close books only the others."
          : !recommendedToExecute
          ? "Execution is technically possible, but unresolved documents or balance-sheet issues should be fixed first."
          : "Ready to execute.",
    },
    // Statutory duties the ledger cannot verify — surface them so the operator
    // confirms each before treating the year as closed.
    statutory_reminders: [
      "RPS § 15: inventeeri aastaaruande koostamisel varade ja kohustiste saldod (pangasaldod, nõuded/kohustused saldokinnitustega, laoseis, põhivara olemasolu ja väärtus).",
      `ÄS § 179: kinnitatud majandusaasta aruanne tuleb esitada äriregistrile 6 kuu jooksul majandusaasta lõpust (${year} → ${year + 1}-06-30 tavapärase kalendriaasta puhul).`,
      "RPS § 12: algdokumente säilitatakse 7 aastat majandusaasta lõpust — kontrolli, et kanded kannavad alusdokumente (find_missing_documents).",
    ],
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
  if (inRange(account.id, 1100, 1199) && account.account_type_est === "Varad") return "investing";
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

  const [accounts, opening, invoiceInfo, vatInfo, allClients, allSales, allPurchases, journalsFromApi] = await Promise.all([
    api.readonly.getAccounts(),
    loadOpeningBalanceJournal(api),
    api.readonly.getInvoiceInfo(),
    api.readonly.getVatInfo(),
    api.clients.listAll(),
    api.saleInvoices.listAll(),
    api.purchaseInvoices.listAll(),
    api.journals.listAllWithPostings(),
  ]);
  const allJournals = [...(opening ? [opening.journal] : []), ...journalsFromApi];

  const preloaded = { preloadedAccounts: accounts, preloadedJournals: allJournals };
  // Start-of-period position for the cash flow's working-capital deltas and
  // opening equity (ROE). Normally the balances at the prior year-end; but when
  // the stored algbilanss is dated INSIDE the report year (first year on
  // e-arveldaja, e.g. opening date = 1 January), that synthetic opening journal
  // (sentinel id -1) IS the starting position — without it opening cash/equity
  // read as zero and the whole opening position shows up as a period movement.
  const openingInsideYear = opening !== null && opening.openingDate >= from && opening.openingDate <= to;
  const [yearEndBalances, priorYearEndBalances, yearProfitAndLossBalances] = await Promise.all([
    computeAllBalances(api, undefined, to, preloaded),
    openingInsideYear
      ? computeAllBalances(api, undefined, to, {
        ...preloaded,
        journalFilter: (journal) => journal.effective_date <= priorTo || journal.id === -1,
      })
      : computeAllBalances(api, undefined, priorTo, preloaded),
    computeAllBalances(api, from, to, {
      ...preloaded,
      journalFilter: (journal) => !isYearEndClosingJournal(journal, year),
    }),
  ]);

  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const closeAccounts = resolveCloseAccounts(accounts);
  const currentYearProfitAccountId = closeAccounts.currentYearProfit;
  const calculatedResultAccountId = closeAccounts.calculatedResult;
  const warnings: string[] = [];

  const currentAssets = buildStatementLine("Käibevara", yearEndBalances, isCurrentAssetAccount);
  const nonCurrentAssets = buildStatementLine("Põhivara", yearEndBalances, isNonCurrentAssetAccount);
  const totalAssets = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Varad");
  // Safety net mirroring the liabilities' "Klassifitseerimata kohustused": any
  // asset account outside both prefix ranges is counted in totalAssets but shows
  // in neither line, so the asset lines would silently fail to reconcile. Surface
  // it as a warning instead of dropping it invisibly.
  const unclassifiedAssets = yearEndBalances.filter((balance) =>
    balance.account_type_est === "Varad" &&
    !isCurrentAssetAccount(balance) &&
    !isNonCurrentAssetAccount(balance) &&
    Math.abs(statementAmount(balance)) >= 0.01,
  );

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
    .filter((balance) => balance.account_type_est === "Omakapital" && balance.account_id !== currentYearProfitAccountId)
    .map((balance) => buildBalanceLine(balance))
    .filter((line) => Math.abs(line.amount) >= 0.01);
  const currentYearProfitAccountLine = buildStatementLine("Aruandeaasta kasum", yearEndBalances, (balance) =>
    balance.account_type_est === "Omakapital" && balance.account_id === currentYearProfitAccountId,
  );

  // RTJ Schema 1 (kulude liigitus iseloomu järgi) line mapping for the
  // e-arveldaja standard chart of accounts (verified against the real
  // kontoplaan export). Number ranges are the primary key, always combined with
  // account_type_est so that non-P&L accounts inside these ranges (e.g. 8888
  // "Tasaarveldused", 9100/9500 — all Varad) never leak into the income
  // statement, and a Tulud/Kulud account sitting in the "wrong" block falls
  // through to the explicit unmapped line instead of flipping sign:
  //   3000       Põhivara müügi vahekonto (clearing)       → unmapped + warning
  //   3100-3799  Müügitulu (goods/services, EU, export)
  //   3800-3999  Muud äritulud (3820 fixed-asset gain, 3840 FX gain, 3850 rent,
  //              3860 fines, 3870 grants, 3900 dividends, 3990 muud äritulud)
  //   4000-4999  Kaubad, toore, materjal ja teenused
  //   5000-5999  Mitmesugused tegevuskulud
  //   6000-6999  Tööjõukulud
  //   7000-7099  Põhivara kulum ja väärtuse langus (7010-7074)
  //   7100-7999  Muud ärikulud (fixed-asset losses, non-business, gifts,
  //              7310 FX loss, land tax, fines, 7910 muud ärikulud, 7920 rounding)
  //   8000-8899  Finantstulud ja -kulud, net (incl. 8500 FX, 8700/8800 extraordinary)
  //   8900-8999  Tulumaks
  //   9000       Arvestuslik koondtulemus → NOT an income-statement account: it is
  //              the counter-account of RIK's year-end result entry (profit
  //              D 9000 / K 2970). Excluded here and disclosed separately.
  const isLedgerProfitAndLossAccount = (balance: AccountBalance) =>
    balance.account_type_est === "Tulud" || balance.account_type_est === "Kulud";
  const isProfitAndLossAccount = (balance: AccountBalance) =>
    isLedgerProfitAndLossAccount(balance) && balance.account_id !== calculatedResultAccountId;
  const revenueLine = buildStatementLine("Müügitulu", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Tulud" && inRange(balance.account_id, 3100, 3799),
  );
  const otherOperatingIncomeLine = buildStatementLine("Muud äritulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Tulud" && inRange(balance.account_id, 3800, 3999),
  );
  const cogsLine = buildStatementLine("Kaubad, toore, materjal ja teenused", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 4000, 4999),
  );
  const operatingExpensesLine = buildStatementLine("Mitmesugused tegevuskulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 5000, 5999),
  );
  const staffCostsLine = buildStatementLine("Tööjõukulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 6000, 6999),
  );
  const depreciationLine = buildStatementLine("Põhivara kulum ja väärtuse langus", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 7000, 7099),
  );
  const otherOperatingExpensesLine = buildStatementLine("Muud ärikulud", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 7100, 7999),
  );
  // "Finantstulud ja -kulud" is a NET line added to operating profit
  // (profitBeforeTax = operatingProfit + amount), so financial EXPENSES must
  // reduce it. statementAmount() returns a positive figure for both income
  // (Tulud) and expense (Kulud) accounts, so build this line with signed
  // contributions — otherwise a booked interest or other financial expense
  // (8411/8413/8610) would *increase* reported profit.
  const financialIncomeExpenseLine = buildSignedProfitAndLossLine("Finantstulud ja -kulud", yearProfitAndLossBalances, (balance) =>
    isProfitAndLossAccount(balance) && inRange(balance.account_id, 8000, 8899),
  );
  const incomeTaxLine = buildStatementLine("Tulumaks", yearProfitAndLossBalances, (balance) =>
    balance.account_type_est === "Kulud" && inRange(balance.account_id, 8900, 8999),
  );

  // Every Tulud/Kulud account not claimed by a named line above (3000
  // clearing, custom accounts outside the standard blocks, a Tulud account in
  // an expense block or vice versa) lands here with a signed contribution. It
  // is part of net profit, so net profit always equals total Tulud − total
  // Kulud excluding 9000 (same as compute_profit_and_loss and the
  // prepare_year_end_close result entry) — never silently dropped.
  const namedProfitAndLossAccountIds = getMappedAccountIds([
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
  const unmappedProfitAndLossLine = buildSignedProfitAndLossLine(
    "Kaardistamata tulud ja kulud (vajab ülevaatust)",
    yearProfitAndLossBalances,
    (balance) => isProfitAndLossAccount(balance) && !namedProfitAndLossAccountIds.has(balance.account_id),
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
  const profitBeforeTax = roundMoney(
    operatingProfit + financialIncomeExpenseLine.amount + unmappedProfitAndLossLine.amount,
  );
  const netProfit = roundMoney(profitBeforeTax - incomeTaxLine.amount);

  // Equity = Omakapital accounts (2970 shown as "Aruandeaasta kasum") + the
  // open P&L remainder across ALL periods up to year-end, 9000 included — the
  // same total compute_balance_sheet reports. Before the close the year's
  // result is open P&L; after RIK entry 1 it sits in 2970 and the P&L + 9000
  // net to zero; after entry 2 (1 January) it is in 2960.
  const totalEquityFromAccounts = sumStatementBalances(yearEndBalances, (balance) => balance.account_type_est === "Omakapital");
  const openProfitAndLossLine = buildSignedProfitAndLossLine(
    "Sulgemata tulem (tulu- ja kulukontode saldo, sh 9000)",
    yearEndBalances,
    isLedgerProfitAndLossAccount,
  );
  const totalEquity = roundMoney(totalEquityFromAccounts + openProfitAndLossLine.amount);
  const balanceDifference = roundMoney(totalAssets - totalLiabilities - totalEquity);
  const resultReconciliationDifference = roundMoney(
    currentYearProfitAccountLine.amount + openProfitAndLossLine.amount - netProfit,
  );
  const calculatedResultBalance = yearProfitAndLossBalances.find((balance) => balance.account_id === calculatedResultAccountId);

  const unmappedProfitAndLossAccounts = yearProfitAndLossBalances
    .filter((balance) => isProfitAndLossAccount(balance) && !namedProfitAndLossAccountIds.has(balance.account_id))
    .map((balance) => ({
      account_id: balance.account_id,
      name: balance.name_est,
      amount: roundMoney(statementAmount(balance)),
    }))
    .filter((account) => Math.abs(account.amount) >= 0.01);

  if (unmappedProfitAndLossAccounts.length > 0) {
    warnings.push(
      `Some revenue/expense accounts fall outside the RTJ Schema 1 line mapping (${unmappedProfitAndLossAccounts.map((account) => account.account_id).join(", ")}). ` +
      "They are included in net profit via kaardistamata_tulud_ja_kulud and should be reviewed manually.",
    );
  }
  const clearingAccount = unmappedProfitAndLossAccounts.find((account) => account.account_id === 3000);
  if (clearingAccount) {
    warnings.push(
      `Account 3000 (fixed-asset sale clearing) carries ${clearingAccount.amount} EUR. It should net to zero once the ` +
      "disposal is booked to 3820/7100; review the fixed-asset sale entries.",
    );
  }
  warnings.push(...buildCalculatedResultWarnings(allJournals, year, closeAccounts, netProfit));
  if (unclassifiedAssets.length > 0) {
    warnings.push(
      `Some asset accounts fall outside the current (10–16) / non-current (17–19) balance-sheet ranges, ` +
      `so they count toward total assets but appear in neither asset line: ` +
      `${unclassifiedAssets.map((balance) => balance.account_id).join(", ")}. Review their classification.`,
    );
  }
  if (Math.abs(balanceDifference) >= 0.01) {
    warnings.push(`Mapped balance sheet lines do not fully balance. Difference: ${balanceDifference} EUR.`);
  }
  if (Math.abs(resultReconciliationDifference) >= 0.01) {
    warnings.push(
      `Aruandeaasta kasum (${currentYearProfitAccountId}: ${currentYearProfitAccountLine.amount} EUR) + sulgemata tulem ` +
      `(${openProfitAndLossLine.amount} EUR) differs from the ${year} result (${netProfit} EUR) by ${resultReconciliationDifference} EUR: ` +
      `a prior year is not closed (RIK entry ${calculatedResultAccountId} ↔ ${currentYearProfitAccountId}) or its result is not yet ` +
      `transferred ${currentYearProfitAccountId} → ${closeAccounts.retainedEarnings}. Run prepare_year_end_close for the earlier year(s).`,
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
  // Standard chart: 13xx are receivables (1330 owners, 1340 other, 1360
  // accountable persons) and 14xx loan/interest/dividend receivables and
  // accrued income — both working capital. Short-term investments are 11xx
  // (1100 Lühiajalised finantsinvesteeringud).
  const openingOtherReceivables = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && (hasPrefix(balance.account_id, "13") || hasPrefix(balance.account_id, "14")),
  );
  const closingOtherReceivables = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && (hasPrefix(balance.account_id, "13") || hasPrefix(balance.account_id, "14")),
  );
  const openingShortTermInvestments = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "11"),
  );
  const closingShortTermInvestments = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Varad" && hasPrefix(balance.account_id, "11"),
  );
  const openingShortTermLiabilities = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && (hasPrefix(balance.account_id, "20") || hasPrefix(balance.account_id, "21")),
  );
  const closingShortTermLiabilities = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && (hasPrefix(balance.account_id, "20") || hasPrefix(balance.account_id, "21")),
  );
  const openingAccruedLiabilities = sumStatementBalances(priorYearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && inRange(balance.account_id, 2600, 2799),
  );
  const closingAccruedLiabilities = sumStatementBalances(yearEndBalances, (balance) =>
    balance.account_type_est === "Kohustused" && inRange(balance.account_id, 2600, 2799),
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

  // Opening balances are a starting position captured as of the opening
  // date, not a current-period cash flow — exclude the synthetic opening
  // journal (sentinel id -1) from cash-flow classification specifically.
  // Balance-sheet / P&L / §157 sections above still see it via `allJournals`;
  // only the cash-flow statement, which is period-movement based, must not.
  const cashFlowJournals = allJournals.filter((journal) => journal.id !== -1);
  const cashFlowClassification = computeCashFlowClassification(cashFlowJournals, accountsById, from, to);
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
  const cashFlowReconciliationDifference = roundMoney(cashChange - statementCashChange);
  if (Math.abs(cashFlowReconciliationDifference) >= 0.01) {
    warnings.push(
      `Cash-flow statement does not reconcile to the balance-sheet cash change: difference ${cashFlowReconciliationDifference} EUR ` +
      `(balance sheet ${cashChange} EUR, statement ${statementCashChange} EUR). Review cash_journal_classification and the excluded operating adjustments.`,
    );
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

  // Same basis as closing equity: Omakapital + open P&L (incl. 9000).
  const openingEquity = roundMoney(
    sumStatementBalances(priorYearEndBalances, (balance) => balance.account_type_est === "Omakapital") +
    buildSignedProfitAndLossLine("", priorYearEndBalances, isLedgerProfitAndLossAccount).amount,
  );
  const closingEquity = totalEquity;
  const averageEquity = roundMoney((openingEquity + closingEquity) / 2);
  const openingBalanceApiIncomplete = opening === null;
  const finalWarnings = withOpeningBalanceStatusInRange(warnings, {
    captured: opening !== null,
    openingDate: opening?.openingDate,
    unmappedCodes: opening?.unmappedCodes,
    unmappedDimensions: opening?.unmappedDimensions,
    dateTo: to,
  });

  return {
    year,
    fiscal_period: { from, to },
    opening_balance_status: openingBalanceApiIncomplete
      ? "api_incomplete"
      : "complete",
    balance_scope: openingBalanceApiIncomplete
      ? "journal_api_visible_entries_only"
      : "complete_balance",
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
          amount: currentYearProfitAccountLine.amount,
          source_accounts: currentYearProfitAccountLine.source_accounts,
        },
        sulgemata_tulem: openProfitAndLossLine,
        total_equity: totalEquity,
        result_reconciliation: {
          year_net_profit: netProfit,
          current_year_profit_account: currentYearProfitAccountLine.amount,
          open_profit_and_loss: openProfitAndLossLine.amount,
          difference: resultReconciliationDifference,
          note: `Before the RIK close the ${year} result is in sulgemata_tulem; after entry 1 (${calculatedResultAccountId} ↔ ` +
            `${currentYearProfitAccountId}) it is in current_year_result. total_equity = accounts + current_year_result + sulgemata_tulem.`,
        },
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
      kaardistamata_tulud_ja_kulud: unmappedProfitAndLossLine,
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
      excluded_from_income_statement: calculatedResultBalance && Math.abs(statementAmount(calculatedResultBalance)) >= 0.01
        ? [{
          account_id: calculatedResultAccountId,
          name: calculatedResultBalance.name_est,
          amount: roundMoney(statementAmount(calculatedResultBalance)),
          reason: "Arvestuslik koondtulemus is the counter-account of the RIK year-end result entry, not revenue or expense.",
        }]
        : [],
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
        difference: cashFlowReconciliationDifference,
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
          "Line mapping follows the e-arveldaja standard chart-of-accounts ranges; accounts outside them are listed under kaardistamata_tulud_ja_kulud.",
          "Company-specific accounting policy wording should be reviewed before filing.",
        ],
      },
      employee_count: {
        registered_staff_count: staffClients.length,
        source: "clients.is_staff",
        sample_staff_records: staffClients.slice(0, 10).map((client) => ({
          id: client.id,
          name: wrapUntrustedOcr(client.name) ?? "",
        })),
      },
      related_party_transactions: {
        related_party_count: relatedPartyClients.length,
        related_parties: relatedPartyClients.map((client) => ({
          id: client.id,
          name: wrapUntrustedOcr(client.name) ?? "",
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
    warnings: finalWarnings,
  };
}

export function registerAnnualReportTools(server: McpServer, api: ApiContext): void {
  registerTool(server, "prepare_year_end_close",
    "Dry-run calendar-year close per RIK's e-arveldaja method: unresolved items, balance check, existing-close detection, and " +
    "the two drafts — Dec 31 result entry (profit D 9000 / K 2970) and Jan 1 transfer (D 2970 / K 2960). Revenue/expense accounts are not zeroed.",
    { ...yearShape, ...closeOptionsShape },
    { ...readOnly, title: "Prepare Year-End Close" },
    async ({ year, reserve_capital_amount, reserve_capital_account }) => {
      const analysis = await analyzeYearEndClose(api, year, {
        reserveCapitalAmount: reserve_capital_amount,
        reserveCapitalAccount: reserve_capital_account,
      });
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
    "Generate Estonian RTJ micro/small-entity annual-report data: statements, cash-flow data, ratios, and notes.",
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
    "Create the missing RIK year-end closing entries from prepare_year_end_close as draft journals (never books an existing entry twice). " +
    "Requires confirm=true; review/register separately.",
    {
      ...yearShape,
      ...closeOptionsShape,
      confirm: z.boolean().describe("Must be true to create the closing journal entries"),
      allow_additional_transfer: z.boolean().optional()
        .describe("Acknowledge that a smaller same-direction 2970 → 2960 transfer for the year already exists on 1 January and book the proposed remainder anyway (transfers on other dates or ambiguous ones always need manual review)"),
    },
    { ...batch, title: "Execute Year-End Close" },
    async ({ year, confirm, reserve_capital_amount, reserve_capital_account, allow_additional_transfer }) => {
      if (confirm !== true) {
        return toolError({
          error: "Explicit confirmation required",
          hint: "Re-run execute_year_end_close with confirm=true to create the closing journal entries.",
        });
      }

      // Uncached: existing-close detection (and the closing amounts) come from
      // the journals — a close booked elsewhere within the 120 s cache window
      // must be seen, or it would be booked twice.
      api.journals.invalidateListCache();
      const analysis = await analyzeYearEndClose(api, year, {
        reserveCapitalAmount: reserve_capital_amount,
        reserveCapitalAccount: reserve_capital_account,
        allowAdditionalTransfer: allow_additional_transfer === true,
      });
      if ("error" in analysis) {
        return toolError(analysis);
      }

      const executableProposals = analysis.proposed_journal_entries
        .filter((proposal) => proposal.auto_executable)
        .filter((proposal) => Math.abs(proposal.totals.difference) < 0.01);

      if (executableProposals.length === 0 && analysis.blocked_entries.length > 0) {
        return toolError({
          error: "Year-end close entry blocked",
          close_status: analysis.close_status,
          blocked_entries: analysis.blocked_entries,
          existing_year_end_close_journals: analysis.existing_year_end_close_journals,
          warnings: analysis.warnings,
          hint: "No journals were created. Correct the existing closing entries (or, for resolution allow_additional_transfer, " +
            "re-run with allow_additional_transfer=true after checking the existing transfer) and re-run execute_year_end_close.",
        });
      }

      if (executableProposals.length === 0 && analysis.existing_year_end_close_journals.length > 0) {
        return toolError({
          error: "Year-end close already exists",
          close_status: analysis.close_status,
          existing_year_end_close_journals: analysis.existing_year_end_close_journals,
          hint: "Delete or invalidate the existing close manually if you need to recreate it.",
        });
      }

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

      // Validate every posting's dimension before the first create: 9000/2970/
      // 2960/2940 may carry dimensions in some charts, and a dimensioned account
      // needs accounts_dimensions_id (auto-filled when it has exactly one) or the
      // API rejects the journal part-way through the close.
      const [validationAccounts, accountDimensions] = await Promise.all([
        api.readonly.getAccounts(),
        api.readonly.getAccountDimensions(),
      ]);
      const postingsByProposal = executableProposals.map((proposal) => proposal.postings.map((posting): Posting => ({
        accounts_id: posting.accounts_id,
        ...(posting.accounts_dimensions_id !== undefined ? { accounts_dimensions_id: posting.accounts_dimensions_id } : {}),
        type: posting.type,
        amount: posting.amount,
      })));
      const dimensionErrors = postingsByProposal.flatMap((postings, index) =>
        validatePostingDimensions(postings, validationAccounts, accountDimensions)
          .map((message) => `${executableProposals[index]!.document_number}: ${message}`),
      );
      if (dimensionErrors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: dimensionErrors,
          hint: "No journals were created. Fix the account dimensions (sub-accounts) and re-run execute_year_end_close.",
        });
      }

      // Partial mutation must be VISIBLE (invariant 9): a failure after the
      // first created journal returns a structured `partial` result naming the
      // already-created journal IDs and the concrete next action — never a
      // generic error that hides the committed drafts.
      const created = [];
      for (const [proposalIndex, proposal] of executableProposals.entries()) {
        let result;
        try {
          result = await api.journals.create({
            title: proposal.title,
            effective_date: proposal.effective_date,
            document_number: proposal.document_number,
            cl_currencies_id: "EUR",
            postings: postingsByProposal[proposalIndex]!,
          });
        } catch (error: unknown) {
          const outcomeUnknown = isMutationIndeterminate(error);
          const createdIds = created
            .map((entry) => entry.api_response.created_object_id)
            .filter((id): id is number => id !== undefined);
          return toolError({
            error: "Year-end close stopped part-way: a closing journal failed to create.",
            status: "partial",
            failed_proposal: { title: proposal.title, effective_date: proposal.effective_date, document_number: proposal.document_number },
            failure: error instanceof Error ? error.message : String(error),
            created_journals: created.map((entry) => ({
              journal_id: entry.api_response.created_object_id,
              title: entry.title,
              effective_date: entry.effective_date,
              document_number: entry.document_number,
            })),
            remaining_proposals: executableProposals.slice(created.length + 1).length,
            ...(outcomeUnknown ? { outcome_unknown: true } : {}),
            next_action: outcomeUnknown
              ? `The create request for ${proposal.document_number} may have reached e-arveldaja before the connection failed. ` +
                `Check for a ${proposal.document_number} draft journal dated ${proposal.effective_date} (list_journals) before doing anything else` +
                (createdIds.length > 0 ? `; draft closing journals ${createdIds.join(", ")} were also already created` : "") +
                ". Re-running execute_year_end_close is safe either way: it detects existing closing entries (drafts included) and creates only the missing ones."
              : createdIds.length > 0
                ? `Draft closing journals ${createdIds.join(", ")} were already created. Fix the failure and re-run execute_year_end_close — it detects those drafts and creates only the missing entry.`
                : "No journals were created. Fix the failure and re-run execute_year_end_close.",
          });
        }
        logAudit({
          tool: "execute_year_end_close", action: "CREATED", entity_type: "journal",
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
            close_status_before: analysis.close_status,
            created_journals: created,
            ...(analysis.blocked_entries.length > 0 ? { skipped_blocked_entries: analysis.blocked_entries } : {}),
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
