import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";
import { roundMoney, effectiveGross } from "../money.js";
import { readOnly } from "../annotations.js";

interface AgingBucket {
  label: string;
  count: number;
  total: number;
  invoices: Array<{ id: number; number: string; client: string; amount: number; payment_status: string; days_overdue: number }>;
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

export function registerAgingTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "compute_receivables_aging",
    "Compute receivables aging report (nõuete vanusanalüüs). " +
    "Groups unpaid sale invoices into aging buckets by client. " +
    "Default as_of_date uses the server's UTC calendar date. Pass as_of_date explicitly if you need a local cutoff.",
    {
      as_of_date: z.string().optional().describe("Aging date (YYYY-MM-DD, default today)"),
    },
    { ...readOnly, title: "Receivables Aging Report" },
    async ({ as_of_date }) => {
      const today = as_of_date ?? new Date().toISOString().split("T")[0]!;


      const allSales = await api.saleInvoices.listAll();
      const unpaid = allSales.filter((inv: SaleInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );
      const partiallyPaidCount = unpaid.filter((inv: SaleInvoice) => inv.payment_status === "PARTIALLY_PAID").length;

      const buckets = new Map<string, AgingBucket>();
      const byClient = new Map<number, { name: string; total: number; oldest_days: number }>();
      const unmatched = { count: 0, total: 0, oldest_days: 0 };

      for (const inv of unpaid) {
        const dueDateStr = addDaysToDate(inv.create_date, inv.term_days);
        const daysOverdue = daysBetween(dueDateStr, today);
        const label = bucketLabel(daysOverdue);
        const amount = effectiveGross(inv);

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

        // Null clients_id (e.g. card-payment-linked invoices) would collapse
        // into a single nameless by-client entry if keyed on `null`. Route
        // them into a dedicated unmatched counter so the top-debtors list
        // stays meaningful.
        if (inv.clients_id == null) {
          unmatched.count++;
          unmatched.total = roundMoney(unmatched.total + amount);
          unmatched.oldest_days = Math.max(unmatched.oldest_days, daysOverdue);
        } else {
          const clientEntry = byClient.get(inv.clients_id) ?? { name: inv.client_name ?? "", total: 0, oldest_days: 0 };
          clientEntry.total = roundMoney(clientEntry.total + amount);
          clientEntry.oldest_days = Math.max(clientEntry.oldest_days, daysOverdue);
          byClient.set(inv.clients_id, clientEntry);
        }
      }

      const r = roundMoney;
      const order = ["current", "1-30", "31-60", "61-90", "90+"];
      const sortedBuckets = order
        .map(label => buckets.get(label))
        .filter((b): b is AgingBucket => !!b)
        .map(b => ({ ...b, total: r(b.total), invoices: b.invoices.sort((a, b) => b.amount - a.amount).slice(0, 10) }));

      const topDebtors = [...byClient.entries()]
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, 10)
        .map(([id, v]) => ({ clients_id: id, name: v.name, total: r(v.total), oldest_days: v.oldest_days }));

      const warnings = [];
      if (partiallyPaidCount > 0) {
        warnings.push(`${partiallyPaidCount} partially paid invoice(s) shown at full face value — actual outstanding balance is lower. The API does not expose remaining balance.`);
      }
      if (unmatched.count > 0) {
        warnings.push(`${unmatched.count} invoice(s) have no clients_id (totaling ${roundMoney(unmatched.total)} EUR). Reported under unmatched_client_invoices; investigate and link to a client for accurate debtor reports.`);
      }
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            as_of_date: today,
            total_unpaid_face_value: unpaid.reduce((s: number, inv: SaleInvoice) => roundMoney(s + effectiveGross(inv)), 0),
            total_invoices: unpaid.length,
            partially_paid_count: partiallyPaidCount,
            aging_buckets: sortedBuckets,
            top_debtors: topDebtors,
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
    "Compute payables aging report (kohustuste vanusanalüüs). " +
    "Groups unpaid purchase invoices into aging buckets by supplier. " +
    "Default as_of_date uses the server's UTC calendar date. Pass as_of_date explicitly if you need a local cutoff.",
    {
      as_of_date: z.string().optional().describe("Aging date (YYYY-MM-DD, default today)"),
    },
    { ...readOnly, title: "Payables Aging Report" },
    async ({ as_of_date }) => {
      const today = as_of_date ?? new Date().toISOString().split("T")[0]!;


      const allPurchases = await api.purchaseInvoices.listAll();
      const unpaid = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );
      const partiallyPaidCount = unpaid.filter((inv: PurchaseInvoice) => inv.payment_status === "PARTIALLY_PAID").length;

      const buckets = new Map<string, AgingBucket>();
      const bySupplier = new Map<number, { name: string; total: number; oldest_days: number }>();
      const unmatched = { count: 0, total: 0, oldest_days: 0 };

      for (const inv of unpaid) {
        const dueDateStr = addDaysToDate(inv.create_date, inv.term_days);
        const daysOverdue = daysBetween(dueDateStr, today);
        const label = bucketLabel(daysOverdue);
        const amount = effectiveGross(inv);

        const bucket = buckets.get(label) ?? { label, count: 0, total: 0, invoices: [] };
        bucket.count++;
        bucket.total = roundMoney(bucket.total + amount);
        bucket.invoices.push({
          id: inv.id!,
          number: inv.number,
          client: inv.client_name,
          amount: roundMoney(amount),
          payment_status: inv.payment_status ?? "NOT_PAID",
          days_overdue: Math.max(0, daysOverdue),
        });
        buckets.set(label, bucket);

        // Same null-supplier handling as the receivables side — route null
        // clients_id to a dedicated unmatched counter.
        if (inv.clients_id == null) {
          unmatched.count++;
          unmatched.total = roundMoney(unmatched.total + amount);
          unmatched.oldest_days = Math.max(unmatched.oldest_days, daysOverdue);
        } else {
          const supplierEntry = bySupplier.get(inv.clients_id) ?? { name: inv.client_name, total: 0, oldest_days: 0 };
          supplierEntry.total = roundMoney(supplierEntry.total + amount);
          supplierEntry.oldest_days = Math.max(supplierEntry.oldest_days, daysOverdue);
          bySupplier.set(inv.clients_id, supplierEntry);
        }
      }

      const r = roundMoney;
      const order = ["current", "1-30", "31-60", "61-90", "90+"];
      const sortedBuckets = order
        .map(label => buckets.get(label))
        .filter((b): b is AgingBucket => !!b)
        .map(b => ({ ...b, total: r(b.total), invoices: b.invoices.sort((a, b) => b.amount - a.amount).slice(0, 10) }));

      const topCreditors = [...bySupplier.entries()]
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, 10)
        .map(([id, v]) => ({ clients_id: id, name: v.name, total: r(v.total), oldest_days: v.oldest_days }));

      const warnings = [];
      if (partiallyPaidCount > 0) {
        warnings.push(`${partiallyPaidCount} partially paid invoice(s) shown at full face value — actual outstanding balance is lower. The API does not expose remaining balance.`);
      }
      if (unmatched.count > 0) {
        warnings.push(`${unmatched.count} invoice(s) have no clients_id (totaling ${roundMoney(unmatched.total)} EUR). Reported under unmatched_supplier_invoices; investigate and link to a supplier for accurate creditor reports.`);
      }
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            as_of_date: today,
            total_unpaid_face_value: unpaid.reduce((s: number, inv: PurchaseInvoice) => roundMoney(s + effectiveGross(inv)), 0),
            total_invoices: unpaid.length,
            partially_paid_count: partiallyPaidCount,
            aging_buckets: sortedBuckets,
            top_creditors: topCreditors,
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
