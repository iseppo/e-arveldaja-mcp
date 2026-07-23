import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";
import { roundMoney, effectiveGross } from "../money.js";
import { readOnly } from "../annotations.js";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";

interface AgingBucket {
  label: string;
  count: number;
  total: number;
  invoices: Array<{ id: number; number: string; client: string; amount: number; payment_status: string; days_overdue: number }>;
}

interface NamedTotal {
  clients_id: number;
  name: string;
  total: number;
  oldest_days: number;
}

// Client/supplier names in aging output can be OCR-seeded (auto-created
// from purchase-invoice receipt flow). Wrap the bucket rows and top-N
// summaries so aging reports reaching the LLM stay sandboxed even when
// the underlying invoice was imported from OCR.
function sanitizeAgingBucketsForOutput(buckets: AgingBucket[]) {
  return buckets.map(b => ({
    ...b,
    invoices: b.invoices.map(inv => ({
      ...inv,
      client: wrapUntrustedOcr(inv.client),
    })),
  }));
}

function sanitizeNamedTotalsForOutput(list: NamedTotal[]) {
  return list.map(entry => ({ ...entry, name: wrapUntrustedOcr(entry.name) ?? entry.name }));
}

function daysBetween(dateStr: string, today: string): number {
  // Use UTC noon to avoid timezone/DST shift issues with YYYY-MM-DD dates
  const d1 = new Date(dateStr + "T12:00:00Z");
  const d2 = new Date(today + "T12:00:00Z");
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0]!;
}

function bucketLabel(days: number): string {
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

// Credit invoices (SaleInvoice.sale_invoice_type === "CREDIT_INVOICE") are
// sometimes stored with a positive gross_price, which would inflate AR
// instead of reducing it. Normalize to a negative contribution using the
// same -Math.abs() convention as estonian-tax.ts's saleInvoiceTurnoverAmount.
// PurchaseInvoice has no equivalent type field — purchase-side credit notes
// are already represented with a negative gross_price by the API (see
// createAndSetTotals/confirmWithTotals), so this is a no-op for payables.
function signedEffectiveGross(inv: {
  base_gross_price?: number | null;
  gross_price?: number | null;
  id?: number;
  sale_invoice_type?: string;
}): number {
  const amount = effectiveGross(inv);
  return inv.sale_invoice_type === "CREDIT_INVOICE" ? -Math.abs(amount) : amount;
}

// Minimal structural shape the pure aging core needs from either a SaleInvoice
// or a PurchaseInvoice. Kept permissive so both entity types (and the reporting
// op) can feed it.
export interface AgingInvoiceInput {
  id?: number;
  number?: string;
  client_name?: string | null;
  clients_id?: number | null;
  create_date?: string;
  term_days?: number | null;
  payment_status?: string;
  status?: string;
  base_gross_price?: number | null;
  gross_price?: number | null;
  sale_invoice_type?: string;
}

// Raw, unformatted aging computation — the single source of the bucketing
// math (bucket boundaries, signedEffectiveGross/CREDIT_INVOICE handling, the
// create_date <= asOfDate gate, top-N slicing, rounding). Callers add their own
// output shape/warnings/OCR-wrapping. Both compute_receivables_aging and
// compute_payables_aging and the run_accounting_report aging op route through
// this so the accounting logic can never drift between copies.
export interface AgingComputation {
  total_unpaid_face_value: number;
  total_invoices: number;
  partially_paid_count: number;
  missing_term_days_count: number;
  aging_buckets: AgingBucket[];
  top_parties: NamedTotal[];
  unmatched: { count: number; total: number; oldest_days: number };
}

export function computeAgingBuckets(
  invoices: readonly AgingInvoiceInput[],
  asOfDate: string,
): AgingComputation {
  const unpaid = invoices.filter(inv =>
    inv.payment_status !== "PAID" && inv.status === "CONFIRMED" &&
    // Exclude future-dated invoices: an invoice issued after the as-of-date
    // cutoff must not appear in that historical aging snapshot.
    (inv.create_date == null || inv.create_date <= asOfDate)
  );
  const partiallyPaidCount = unpaid.filter(inv => inv.payment_status === "PARTIALLY_PAID").length;
  const missingTermDaysCount = unpaid.filter(inv => inv.term_days == null).length;

  const buckets = new Map<string, AgingBucket>();
  const byParty = new Map<number, { name: string; total: number; oldest_days: number }>();
  const unmatched = { count: 0, total: 0, oldest_days: 0 };

  for (const inv of unpaid) {
    // Missing term_days defaults to 0 (due on issue date) instead of
    // producing an invalid due date that would abort the whole report.
    const dueDateStr = addDaysToDate(inv.create_date ?? asOfDate, inv.term_days ?? 0);
    const daysOverdue = daysBetween(dueDateStr, asOfDate);
    const label = bucketLabel(daysOverdue);
    const amount = signedEffectiveGross(inv);

    const bucket = buckets.get(label) ?? { label, count: 0, total: 0, invoices: [] };
    bucket.count++;
    bucket.total = roundMoney(bucket.total + amount);
    bucket.invoices.push({
      id: inv.id!,
      number: inv.number ?? "",
      client: inv.client_name ?? "",
      amount: roundMoney(amount),
      payment_status: inv.payment_status ?? "NOT_PAID",
      days_overdue: Math.max(0, daysOverdue),
    });
    buckets.set(label, bucket);

    // Null clients_id (e.g. card-payment-linked invoices) would collapse into a
    // single nameless entry if keyed on `null`. Route them into a dedicated
    // unmatched counter so the top-N party list stays meaningful.
    if (inv.clients_id == null) {
      unmatched.count++;
      unmatched.total = roundMoney(unmatched.total + amount);
      unmatched.oldest_days = Math.max(unmatched.oldest_days, daysOverdue);
    } else {
      const entry = byParty.get(inv.clients_id) ?? { name: inv.client_name ?? "", total: 0, oldest_days: 0 };
      entry.total = roundMoney(entry.total + amount);
      entry.oldest_days = Math.max(entry.oldest_days, daysOverdue);
      byParty.set(inv.clients_id, entry);
    }
  }

  const r = roundMoney;
  const order = ["current", "1-30", "31-60", "61-90", "90+"];
  const sortedBuckets = order
    .map(label => buckets.get(label))
    .filter((b): b is AgingBucket => !!b)
    .map(b => ({ ...b, total: r(b.total), invoices: b.invoices.sort((a, b) => b.amount - a.amount).slice(0, 10) }));

  const topParties = [...byParty.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 10)
    .map(([id, v]) => ({ clients_id: id, name: v.name, total: r(v.total), oldest_days: v.oldest_days }));

  return {
    total_unpaid_face_value: unpaid.reduce((s, inv) => roundMoney(s + signedEffectiveGross(inv)), 0),
    total_invoices: unpaid.length,
    partially_paid_count: partiallyPaidCount,
    missing_term_days_count: missingTermDaysCount,
    aging_buckets: sortedBuckets,
    top_parties: topParties,
    unmatched,
  };
}

export function registerAgingTools(
  server: McpServer,
  api: ApiContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): void {

  // Receivables aging is the sales/AR side — gated with the sale-invoice group.
  // Payables aging (below) is the purchase/AP side and is always registered.
  if (exposure.enableSales) registerTool(server, "compute_receivables_aging",
    "Compute receivables aging by client from unpaid sale invoices. Pass as_of_date for a specific cutoff.",
    {
      as_of_date: z.string().optional().describe("Aging date (YYYY-MM-DD, default today)"),
    },
    { ...readOnly, title: "Receivables Aging Report" },
    async ({ as_of_date }) => {
      const actualToday = new Date().toISOString().split("T")[0]!;
      const today = as_of_date ?? actualToday;


      const allSales = await api.saleInvoices.listAll();
      const computed = computeAgingBuckets(allSales as AgingInvoiceInput[], today);
      const { partially_paid_count: partiallyPaidCount, missing_term_days_count: missingTermDaysCount, unmatched } = computed;
      const r = roundMoney;
      const sortedBuckets = computed.aging_buckets;
      const topDebtors = computed.top_parties;

      const warnings = [];
      if (partiallyPaidCount > 0) {
        warnings.push(`${partiallyPaidCount} partially paid invoice(s) shown at full face value — actual outstanding balance is lower. The API does not expose remaining balance.`);
      }
      if (missingTermDaysCount > 0) {
        warnings.push(`${missingTermDaysCount} invoice(s) have no term_days set — treated as due on the issue date (term_days=0) for aging purposes.`);
      }
      if (unmatched.count > 0) {
        warnings.push(`${unmatched.count} invoice(s) have no clients_id (totaling ${roundMoney(unmatched.total)} EUR). Reported under unmatched_client_invoices; investigate and link to a client for accurate debtor reports.`);
      }
      if (as_of_date && as_of_date !== actualToday) {
        warnings.push(`as_of_date=${as_of_date} excludes invoices issued after that date and affects day-counting, but payment_status still reflects the CURRENT state — invoices settled after ${as_of_date} may be under-counted as still outstanding since the API does not expose historical payment state.`);
      }
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            as_of_date: today,
            total_unpaid_face_value: computed.total_unpaid_face_value,
            total_invoices: computed.total_invoices,
            partially_paid_count: partiallyPaidCount,
            aging_buckets: sanitizeAgingBucketsForOutput(sortedBuckets),
            top_debtors: sanitizeNamedTotalsForOutput(topDebtors),
            ...(unmatched.count > 0 && {
              unmatched_client_invoices: { count: unmatched.count, total: r(unmatched.total), oldest_days: unmatched.oldest_days },
            }),
            ...(warnings.length > 0 && { warnings }),
          }),
        }],
      };
    }
  );

  registerTool(server, "compute_payables_aging",
    "Compute payables aging by supplier from unpaid purchase invoices. Pass as_of_date for a specific cutoff.",
    {
      as_of_date: z.string().optional().describe("Aging date (YYYY-MM-DD, default today)"),
    },
    { ...readOnly, title: "Payables Aging Report" },
    async ({ as_of_date }) => {
      const actualToday = new Date().toISOString().split("T")[0]!;
      const today = as_of_date ?? actualToday;


      const allPurchases = await api.purchaseInvoices.listAll();
      const computed = computeAgingBuckets(allPurchases as AgingInvoiceInput[], today);
      const { partially_paid_count: partiallyPaidCount, missing_term_days_count: missingTermDaysCount, unmatched } = computed;
      const r = roundMoney;
      const sortedBuckets = computed.aging_buckets;
      const topCreditors = computed.top_parties;

      const warnings = [];
      if (partiallyPaidCount > 0) {
        warnings.push(`${partiallyPaidCount} partially paid invoice(s) shown at full face value — actual outstanding balance is lower. The API does not expose remaining balance.`);
      }
      if (missingTermDaysCount > 0) {
        warnings.push(`${missingTermDaysCount} invoice(s) have no term_days set — treated as due on the issue date (term_days=0) for aging purposes.`);
      }
      if (unmatched.count > 0) {
        warnings.push(`${unmatched.count} invoice(s) have no clients_id (totaling ${roundMoney(unmatched.total)} EUR). Reported under unmatched_supplier_invoices; investigate and link to a supplier for accurate creditor reports.`);
      }
      if (as_of_date && as_of_date !== actualToday) {
        warnings.push(`as_of_date=${as_of_date} excludes invoices issued after that date and affects day-counting, but payment_status still reflects the CURRENT state — invoices settled after ${as_of_date} may be under-counted as still outstanding since the API does not expose historical payment state.`);
      }
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            as_of_date: today,
            total_unpaid_face_value: computed.total_unpaid_face_value,
            total_invoices: computed.total_invoices,
            partially_paid_count: partiallyPaidCount,
            aging_buckets: sanitizeAgingBucketsForOutput(sortedBuckets),
            top_creditors: sanitizeNamedTotalsForOutput(topCreditors),
            ...(unmatched.count > 0 && {
              unmatched_supplier_invoices: { count: unmatched.count, total: r(unmatched.total), oldest_days: unmatched.oldest_days },
            }),
            ...(warnings.length > 0 && { warnings }),
          }),
        }],
      };
    }
  );
}
