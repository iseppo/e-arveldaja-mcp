import type { OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { PurchaseInvoice, SaleInvoice, Transaction } from "../types/api.js";
import { roundMoney, effectiveGross } from "../money.js";
import {
  computeTrialBalanceReport,
  computeBalanceSheetReport,
  computeProfitAndLossReport,
  gatherMonthEndScan,
  buildMonthEndDueList,
  monthEndWarnings,
} from "../tools/financial-statements.js";
import { computeAgingBuckets, missingEurAmountWarning, type AgingInvoiceInput } from "../tools/aging-analysis.js";
import { computeMissingDocuments } from "../tools/document-audit.js";
import { computeReceiptClientAlignment } from "./receipt-client-alignment.js";
import { todayInTallinn } from "../local-date.js";
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
  const missingEur = missingEurAmountWarning(c.missing_eur_amount);
  if (missingEur) warnings.push(missingEur);

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

/** Default audit window when the caller gives no `date_from`. */
const RECEIPT_ALIGNMENT_WINDOW_MONTHS = 12;
/** Same per-record fan-out concurrency journals.listAllWithPostings uses. */
const RECEIPT_ALIGNMENT_BATCH_SIZE = 5;

function shiftMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1 + months, day!)).toISOString().split("T")[0]!;
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
      case "receipt_client_alignment": return this.receiptClientAlignment(input);
      default:
        return fail("invalid_report", `Unknown report "${String((input as { report?: unknown }).report)}".`);
    }
  }

  // The three statement ops route through the same cores as the standalone
  // compute_* tools (opening-balance warnings, date defaults, YECL exclusion).
  private async trialBalance(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    return ok({ report: "trial_balance", ...await computeTrialBalanceReport(this.api, input.period?.from, input.period?.to) });
  }

  private async balanceSheet(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    return ok({ report: "balance_sheet", ...await computeBalanceSheetReport(this.api, input.period?.to) });
  }

  private async profitAndLoss(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const from = input.period?.from;
    const to = input.period?.to;
    if (from === undefined || to === undefined) {
      return fail("period_required", "profit_and_loss requires period.from and period.to (YYYY-MM-DD).");
    }
    return ok({ report: "profit_and_loss", ...await computeProfitAndLossReport(this.api, from, to) });
  }

  private async aging(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const actualToday = todayInTallinn();
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

    const invRow = (inv: SaleInvoice | PurchaseInvoice): MonthEndInvoiceRow => ({
      id: inv.id!,
      number: inv.number ?? "",
      client: inv.client_name ?? "",
      gross: effectiveGross(inv),
      payment_status: inv.payment_status ?? "NOT_PAID",
    });
    // Full lists — the façade applies the compact cap.
    const dueList = (invs: ReadonlyArray<SaleInvoice | PurchaseInvoice>, withDaysOverdue: boolean) =>
      buildMonthEndDueList(invs, scan, withDaysOverdue);

    const warnings = monthEndWarnings(scan, month, dateTo);

    const issuesFound = unconfirmedJournals.length + unconfirmedTx.length + unconfirmedSales.length + unconfirmedPurchases.length + overdueReceivables.length + overduePayables.length;

    return ok({
      report: "month_end",
      month,
      unconfirmed_journals: { count: unconfirmedJournals.length, items: unconfirmedJournals.map(j => ({ id: j.id!, date: j.effective_date, title: j.title ?? "" })) },
      unconfirmed_transactions: { count: unconfirmedTx.length, items: unconfirmedTx.map(tx => ({ id: tx.id!, date: tx.date, amount: tx.amount, description: tx.description ?? "" })) },
      ...(this.enableSales ? { unconfirmed_sale_invoices: { count: unconfirmedSales.length, items: unconfirmedSales.map(invRow) } } : {}),
      unconfirmed_purchase_invoices: { count: unconfirmedPurchases.length, items: unconfirmedPurchases.map(invRow) },
      overdue_as_of: overdueAsOf,
      ...(this.enableSales ? { overdue_receivables: dueList(overdueReceivables, true) } : {}),
      overdue_payables: dueList(overduePayables, true),
      ...(monthOpen && this.enableSales ? { due_before_month_end_receivables: dueList(dueBeforeMonthEndReceivables, false) } : {}),
      ...(monthOpen ? { due_before_month_end_payables: dueList(dueBeforeMonthEndPayables, false) } : {}),
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

  // Read-only audit: reads transactions, journals and the cached client list,
  // then defers every judgement to the pure core. No mutating API method is
  // reachable from here.
  private async receiptClientAlignment(input: RunAccountingReportInput): Promise<OperationOutcome<AccountingReportResult>> {
    const to = input.period?.to ?? todayInTallinn();
    const defaulted = input.period?.from === undefined;
    const from = input.period?.from ?? shiftMonths(to, -RECEIPT_ALIGNMENT_WINDOW_MONTHS);

    // The invoice link lives in `items[]`, which ONLY GET /transactions/{id}
    // returns — a list row never carries it. So the list is narrowed
    // server-side to the confirmed rows in the window and each one is then read
    // individually. Journals need no postings here (only id / clients_id /
    // operation fields), and a registration journal's effective_date is the
    // transaction date, so one plain listAll over the same window is enough.
    const [listed, journals, allClients] = await Promise.all([
      this.api.transactions.listAll({ status: "CONFIRMED", start_date: from, end_date: to }),
      this.api.journals.listAll({ start_date: from, end_date: to }),
      this.api.clients.listAllCached(120),
    ]);

    const confirmed = listed.filter(tx => tx.id != null && tx.status === "CONFIRMED" && !tx.is_deleted);
    const transactions: Transaction[] = [];
    for (let i = 0; i < confirmed.length; i += RECEIPT_ALIGNMENT_BATCH_SIZE) {
      const batch = confirmed.slice(i, i + RECEIPT_ALIGNMENT_BATCH_SIZE);
      transactions.push(...await Promise.all(batch.map(tx => this.api.transactions.get(tx.id!))));
    }

    const clientNames = new Map<number, string>();
    for (const client of allClients) if (client.id !== undefined) clientNames.set(client.id, client.name);
    const core = computeReceiptClientAlignment({ transactions, journals, clientNames, enableSales: this.enableSales });
    return ok({
      report: "receipt_client_alignment",
      window: { from, to, defaulted },
      ...core,
      warnings: [
        ...(defaulted ? [`No date_from given; audited the ${RECEIPT_ALIGNMENT_WINDOW_MONTHS} months ending ${to}. Pass date_from/date_to for another window.`] : []),
        ...core.warnings,
      ],
    });
  }
}

export function createReportingOperations(api: ApiContext, enableSales: boolean): ReportingOperations {
  return new ReportingOperationsImpl(api, enableSales);
}
