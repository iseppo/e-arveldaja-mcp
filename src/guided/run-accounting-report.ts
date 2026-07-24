import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { readOnly } from "../annotations.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { ToolExposureConfig } from "../config.js";
import { createReportingOperations } from "../reporting/operations.js";
import { wrapMissingDocuments } from "../tools/document-audit.js";
import type {
  AccountingReportResult,
  AgingSide,
  MonthEndInvoiceRow,
} from "../reporting/types.js";

// GUIDED FAÇADE. `run_accounting_report` unifies trial_balance / balance_sheet /
// profit_and_loss / aging / month_end behind ONE guided-visible tool over the
// typed ReportingOperations. It calls NO MCP handler, never parses an MCP
// response, and never surfaces a delegated granular tool name. This façade is
// the SOLE wrapUntrustedOcr site: it wraps the SAME import-origin fields the
// granular reporters wrap (month-end journal title / tx description / invoice
// client_name; aging client/supplier names). Chart-of-accounts balances are
// trusted reference data and stay raw. Compact is the default; detail='full'
// returns every line inline (read-only, bounded — no plan handle, no mutation).

const COMPACT_ITEM_CAP = 25;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_REGEX = /^\d{4}-\d{2}$/;

function textResult(payload: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: toMcpJson(payload) }],
  };
}

function cap<T>(items: readonly T[], detail: "compact" | "full"): { items: readonly T[]; truncated: boolean } {
  if (detail === "full" || items.length <= COMPACT_ITEM_CAP) return { items, truncated: false };
  return { items: items.slice(0, COMPACT_ITEM_CAP), truncated: true };
}

function renderAgingSide(side: AgingSide, detail: "compact" | "full") {
  return {
    total_unpaid_face_value: side.total_unpaid_face_value,
    total_invoices: side.total_invoices,
    partially_paid_count: side.partially_paid_count,
    aging_buckets: side.aging_buckets.map(b => {
      const { items, truncated } = cap(b.invoices, detail);
      return {
        label: b.label,
        count: b.count,
        total: b.total,
        invoices: items.map(inv => ({ ...inv, client: wrapUntrustedOcr(inv.client) ?? inv.client })),
        ...(truncated ? { truncated: true } : {}),
      };
    }),
    top_parties: side.top_parties.map(p => ({ ...p, name: wrapUntrustedOcr(p.name) ?? p.name })),
    ...(side.unmatched ? { unmatched: side.unmatched } : {}),
    ...(side.warnings.length > 0 ? { warnings: side.warnings } : {}),
  };
}

function wrapInvoiceRows(rows: readonly MonthEndInvoiceRow[]) {
  return rows.map(r => ({ ...r, client: wrapUntrustedOcr(r.client) ?? r.client }));
}

function renderReport(value: AccountingReportResult, detail: "compact" | "full"): Record<string, unknown> {
  switch (value.report) {
    case "trial_balance": {
      const { items, truncated } = cap(value.accounts, detail);
      return {
        report: "trial_balance",
        period: value.period,
        account_count: value.account_count,
        totals: value.totals,
        accounts: items,
        ...(truncated ? { truncated: true, note: "Account list truncated; call again with detail='full' for every line." } : {}),
        ...(value.warnings.length > 0 ? { warnings: value.warnings } : {}),
      };
    }
    case "balance_sheet":
      return {
        report: "balance_sheet",
        date: value.date,
        assets: { total: value.assets.total, items: cap(value.assets.items, detail).items },
        liabilities: { total: value.liabilities.total, items: cap(value.liabilities.items, detail).items },
        equity: { total: value.equity.total, items: cap(value.equity.items, detail).items },
        current_year_pl: value.current_year_pl,
        check: value.check,
        ...(value.warnings.length > 0 ? { warnings: value.warnings } : {}),
      };
    case "profit_and_loss":
      return {
        report: "profit_and_loss",
        period: value.period,
        revenue: { total: value.revenue.total, items: cap(value.revenue.items, detail).items },
        expenses: { total: value.expenses.total, items: cap(value.expenses.items, detail).items },
        net_profit: value.net_profit,
        ...(value.warnings.length > 0 ? { warnings: value.warnings } : {}),
      };
    case "aging":
      return {
        report: "aging",
        as_of_date: value.as_of_date,
        ...(value.receivables ? { receivables: renderAgingSide(value.receivables, detail) } : {}),
        payables: renderAgingSide(value.payables, detail),
      };
    case "month_end":
      return {
        report: "month_end",
        month: value.month,
        unconfirmed_journals: {
          count: value.unconfirmed_journals.count,
          items: cap(value.unconfirmed_journals.items, detail).items.map(j => ({ ...j, title: wrapUntrustedOcr(j.title) ?? j.title })),
        },
        unconfirmed_transactions: {
          count: value.unconfirmed_transactions.count,
          items: cap(value.unconfirmed_transactions.items, detail).items.map(t => ({ ...t, description: wrapUntrustedOcr(t.description) ?? t.description })),
        },
        ...(value.unconfirmed_sale_invoices ? { unconfirmed_sale_invoices: { count: value.unconfirmed_sale_invoices.count, items: wrapInvoiceRows(cap(value.unconfirmed_sale_invoices.items, detail).items) } } : {}),
        unconfirmed_purchase_invoices: { count: value.unconfirmed_purchase_invoices.count, items: wrapInvoiceRows(cap(value.unconfirmed_purchase_invoices.items, detail).items) },
        ...(value.overdue_receivables ? { overdue_receivables: { count: value.overdue_receivables.count, total: value.overdue_receivables.total, items: wrapInvoiceRows(value.overdue_receivables.items) } } : {}),
        overdue_payables: { count: value.overdue_payables.count, total: value.overdue_payables.total, items: wrapInvoiceRows(value.overdue_payables.items) },
        summary: value.summary,
        ...(value.warnings.length > 0 ? { warnings: value.warnings } : {}),
      };
    case "missing_documents":
      return { report: "missing_documents", ...wrapMissingDocuments(value, detail === "full" ? Infinity : COMPACT_ITEM_CAP) };
  }
}

interface ReportArgs {
  report?: string;
  date_from?: string;
  date_to?: string;
  as_of_date?: string;
  month?: string;
  detail?: "compact" | "full";
}

export function registerRunAccountingReportTool(
  server: McpServer,
  api: ApiContext,
  toolExposure: Pick<ToolExposureConfig, "enableSales">,
): void {
  const operations = createReportingOperations(api, toolExposure.enableSales !== false);

  registerTool(server,
    "run_accounting_report",
    "Unified accounting-report entry point. report='trial_balance' | 'balance_sheet' | 'profit_and_loss' (both need period.from/to via date_from/date_to) | 'aging' (as_of_date) | 'month_end' (month YYYY-MM) | 'missing_documents' (RPS source-document check; optional date_from/date_to). Compact by default; detail='full' returns every line.",
    {
      report: z.enum(["trial_balance", "balance_sheet", "profit_and_loss", "aging", "month_end", "missing_documents"]).describe("Which report to run."),
      date_from: z.string().optional().describe("Period start (YYYY-MM-DD). Required for profit_and_loss; optional for trial_balance."),
      date_to: z.string().optional().describe("Period end / balance date (YYYY-MM-DD)."),
      as_of_date: z.string().optional().describe("aging only: cutoff date (YYYY-MM-DD, default today)."),
      month: z.string().optional().describe("month_end only: month (YYYY-MM)."),
      detail: z.enum(["compact", "full"]).optional().describe("compact (default) caps long line lists; full returns every line."),
    },
    { ...readOnly, title: "Run Accounting Report" },
    async (args: ReportArgs) => {
      const detail = args.detail ?? "compact";
      for (const [key, value] of [["date_from", args.date_from], ["date_to", args.date_to], ["as_of_date", args.as_of_date]] as const) {
        if (value !== undefined && !ISO_DATE_REGEX.test(value)) {
          return textResult({ error: `${key} must be YYYY-MM-DD`, category: "invalid_date" }, true);
        }
      }
      if (args.month !== undefined && !MONTH_REGEX.test(args.month)) {
        return textResult({ error: "month must be YYYY-MM", category: "invalid_month" }, true);
      }
      const outcome = await operations.run({
        report: args.report as AccountingReportResult["report"],
        period: { ...(args.date_from !== undefined ? { from: args.date_from } : {}), ...(args.date_to !== undefined ? { to: args.date_to } : {}) },
        ...(args.as_of_date !== undefined ? { asOfDate: args.as_of_date } : {}),
        ...(args.month !== undefined ? { month: args.month } : {}),
      });
      if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code }, true);
      return textResult(renderReport(outcome.value, detail));
    },
  );
}
