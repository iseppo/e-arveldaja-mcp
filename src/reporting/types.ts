import type { OperationOutcome } from "../operation-outcome.js";
import type { AccountBalance } from "../tools/financial-statements.js";
import type { MissingDocumentsCore } from "../tools/document-audit.js";

// Typed accounting-report operations (Task 14, PR 8C). MCP-free: inputs and
// results are plain typed, UNWRAPPED domain data. The guided façade
// (src/guided/run-accounting-report.ts) is the SOLE wrapUntrustedOcr site — it
// wraps the SAME fields the granular reporters wrap (month-end journal title /
// tx description / invoice client_name, aging client/supplier names). The
// balances themselves (chart-of-accounts reference data) are trusted and
// emitted raw. Compact is the default projection; `detail="full"` returns every
// line inline (reports are read-only and bounded — NO plan handle, NO mutation).

export type AccountingReportType =
  | "trial_balance"
  | "balance_sheet"
  | "profit_and_loss"
  | "aging"
  | "month_end"
  | "missing_documents";

export interface RunAccountingReportInput {
  readonly report: AccountingReportType;
  readonly period?: { from?: string; to?: string };
  /** aging only — the as-of cutoff date (YYYY-MM-DD, default today). */
  readonly asOfDate?: string;
  /** month_end only — the month (YYYY-MM). */
  readonly month?: string;
}

export interface TrialBalanceResult {
  readonly report: "trial_balance";
  readonly period: { from: string; to: string };
  readonly accounts: readonly AccountBalance[];
  readonly account_count: number;
  readonly totals: { debit: number; credit: number; difference: number };
  readonly warnings: readonly string[];
}

export interface BalanceSheetCategoryItem {
  readonly id: number;
  readonly name: string;
  readonly balance: number;
}
export interface BalanceSheetResult {
  readonly report: "balance_sheet";
  readonly date: string;
  readonly assets: { items: readonly BalanceSheetCategoryItem[]; total: number };
  readonly liabilities: { items: readonly BalanceSheetCategoryItem[]; total: number };
  readonly equity: { items: readonly BalanceSheetCategoryItem[]; total: number };
  readonly current_year_pl: { revenue: number; expenses: number; net_profit: number };
  readonly check: { assets: number; liabilities_plus_equity: number; balanced: boolean };
  readonly warnings: readonly string[];
}

export interface ProfitAndLossLineItem {
  readonly id: number;
  readonly name: string;
  readonly amount: number;
}
export interface ProfitAndLossResult {
  readonly report: "profit_and_loss";
  readonly period: { from: string; to: string };
  readonly revenue: { items: readonly ProfitAndLossLineItem[]; total: number };
  readonly expenses: { items: readonly ProfitAndLossLineItem[]; total: number };
  readonly net_profit: number;
  readonly warnings: readonly string[];
}

export interface AgingBucketRow {
  readonly id: number;
  readonly number: string;
  /** UNWRAPPED client/supplier name — the façade wraps it. */
  readonly client: string;
  readonly amount: number;
  readonly payment_status: string;
  readonly days_overdue: number;
}
export interface AgingBucket {
  readonly label: string;
  readonly count: number;
  readonly total: number;
  readonly invoices: readonly AgingBucketRow[];
}
export interface AgingNamedTotal {
  readonly clients_id: number;
  /** UNWRAPPED name — the façade wraps it. */
  readonly name: string;
  readonly total: number;
  readonly oldest_days: number;
}
export interface AgingSide {
  readonly total_unpaid_face_value: number;
  readonly total_invoices: number;
  readonly partially_paid_count: number;
  readonly aging_buckets: readonly AgingBucket[];
  readonly top_parties: readonly AgingNamedTotal[];
  readonly unmatched?: { count: number; total: number; oldest_days: number };
  readonly warnings: readonly string[];
}
export interface AgingResult {
  readonly report: "aging";
  readonly as_of_date: string;
  /** Present only when sales is enabled. */
  readonly receivables?: AgingSide;
  readonly payables: AgingSide;
}

export interface MonthEndCountedItems<T> {
  readonly count: number;
  readonly items: readonly T[];
}
export interface MonthEndJournalRow { readonly id: number; readonly date: string; readonly title: string }
export interface MonthEndTxRow { readonly id: number; readonly date: string; readonly amount: number; readonly description: string }
export interface MonthEndInvoiceRow {
  readonly id: number;
  readonly number: string;
  readonly client: string;
  readonly gross: number;
  readonly payment_status: string;
}
export interface MonthEndResult {
  readonly report: "month_end";
  readonly month: string;
  readonly unconfirmed_journals: MonthEndCountedItems<MonthEndJournalRow>;
  readonly unconfirmed_transactions: MonthEndCountedItems<MonthEndTxRow>;
  readonly unconfirmed_sale_invoices?: MonthEndCountedItems<MonthEndInvoiceRow>;
  readonly unconfirmed_purchase_invoices: MonthEndCountedItems<MonthEndInvoiceRow>;
  readonly overdue_receivables?: { count: number; total: number; items: readonly MonthEndInvoiceRow[] };
  readonly overdue_payables: { count: number; total: number; items: readonly MonthEndInvoiceRow[] };
  readonly summary: { issues_found: number; ready_to_close: boolean };
  readonly warnings: readonly string[];
}

/**
 * Missing-source-document report. Carries the UNWRAPPED MissingDocumentsCore
 * (shared with the `find_missing_documents` tool) behind the report discriminant;
 * the guided façade wraps `title` / `description` / `client` at MCP output.
 */
export type MissingDocumentsResult = { readonly report: "missing_documents" } & MissingDocumentsCore;

export type AccountingReportResult =
  | TrialBalanceResult
  | BalanceSheetResult
  | ProfitAndLossResult
  | AgingResult
  | MonthEndResult
  | MissingDocumentsResult;

export interface ReportingOperations {
  run(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>>;
}
