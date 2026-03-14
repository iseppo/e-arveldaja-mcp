import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";

interface AgingBucket {
  label: string;
  count: number;
  total: number;
  invoices: Array<{ id: number; number: string; client: string; amount: number; days_overdue: number }>;
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

  server.tool("compute_receivables_aging",
    "Compute receivables aging report (nõuete vanusanalüüs). " +
    "Groups unpaid sale invoices into aging buckets by client.",
    {
      as_of_date: z.string().optional().describe("Aging date (YYYY-MM-DD, default today)"),
    },
    async ({ as_of_date }) => {
      const today = as_of_date ?? new Date().toISOString().split("T")[0]!;

      const allSales = await api.saleInvoices.listAll();
      const unpaid = allSales.filter((inv: SaleInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );
      const partiallyPaidCount = unpaid.filter((inv: SaleInvoice) => inv.payment_status === "PARTIALLY_PAID").length;

      const buckets = new Map<string, AgingBucket>();
      const byClient = new Map<number, { name: string; total: number; oldest_days: number }>();

      for (const inv of unpaid) {
        const dueDateStr = addDaysToDate(inv.create_date, inv.term_days);
        const daysOverdue = daysBetween(dueDateStr, today);
        const label = bucketLabel(daysOverdue);
        const amount = inv.base_gross_price ?? inv.gross_price ?? 0;

        const bucket = buckets.get(label) ?? { label, count: 0, total: 0, invoices: [] };
        bucket.count++;
        bucket.total += amount;
        bucket.invoices.push({
          id: inv.id!,
          number: inv.number ?? "",
          client: inv.client_name ?? "",
          amount: Math.round(amount * 100) / 100,
          days_overdue: Math.max(0, daysOverdue),
        });
        buckets.set(label, bucket);

        const clientEntry = byClient.get(inv.clients_id) ?? { name: inv.client_name ?? "", total: 0, oldest_days: 0 };
        clientEntry.total += amount;
        clientEntry.oldest_days = Math.max(clientEntry.oldest_days, daysOverdue);
        byClient.set(inv.clients_id, clientEntry);
      }

      const r = (n: number) => Math.round(n * 100) / 100;
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
        warnings.push(`${partiallyPaidCount} partially paid invoice(s) shown at full amount — outstanding balance may be lower.`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            as_of_date: today,
            total_unpaid: r(unpaid.reduce((s: number, inv: SaleInvoice) => s + (inv.base_gross_price ?? inv.gross_price ?? 0), 0)),
            total_invoices: unpaid.length,
            partially_paid_count: partiallyPaidCount,
            aging_buckets: sortedBuckets,
            top_debtors: topDebtors,
            ...(warnings.length > 0 && { warnings }),
          }, null, 2),
        }],
      };
    }
  );

  server.tool("compute_payables_aging",
    "Compute payables aging report (kohustuste vanusanalüüs). " +
    "Groups unpaid purchase invoices into aging buckets by supplier.",
    {
      as_of_date: z.string().optional().describe("Aging date (YYYY-MM-DD, default today)"),
    },
    async ({ as_of_date }) => {
      const today = as_of_date ?? new Date().toISOString().split("T")[0]!;

      const allPurchases = await api.purchaseInvoices.listAll();
      const unpaid = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );
      const partiallyPaidCount = unpaid.filter((inv: PurchaseInvoice) => inv.payment_status === "PARTIALLY_PAID").length;

      const buckets = new Map<string, AgingBucket>();
      const bySupplier = new Map<number, { name: string; total: number; oldest_days: number }>();

      for (const inv of unpaid) {
        const dueDateStr = addDaysToDate(inv.create_date, inv.term_days);
        const daysOverdue = daysBetween(dueDateStr, today);
        const label = bucketLabel(daysOverdue);
        const amount = inv.base_gross_price ?? inv.gross_price ?? 0;

        const bucket = buckets.get(label) ?? { label, count: 0, total: 0, invoices: [] };
        bucket.count++;
        bucket.total += amount;
        bucket.invoices.push({
          id: inv.id!,
          number: inv.number,
          client: inv.client_name,
          amount: Math.round(amount * 100) / 100,
          days_overdue: Math.max(0, daysOverdue),
        });
        buckets.set(label, bucket);

        const supplierEntry = bySupplier.get(inv.clients_id) ?? { name: inv.client_name, total: 0, oldest_days: 0 };
        supplierEntry.total += amount;
        supplierEntry.oldest_days = Math.max(supplierEntry.oldest_days, daysOverdue);
        bySupplier.set(inv.clients_id, supplierEntry);
      }

      const r = (n: number) => Math.round(n * 100) / 100;
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
        warnings.push(`${partiallyPaidCount} partially paid invoice(s) shown at full amount — outstanding balance may be lower.`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            as_of_date: today,
            total_unpaid: r(unpaid.reduce((s: number, inv: PurchaseInvoice) => s + (inv.base_gross_price ?? inv.gross_price ?? 0), 0)),
            total_invoices: unpaid.length,
            partially_paid_count: partiallyPaidCount,
            aging_buckets: sortedBuckets,
            top_creditors: topCreditors,
            ...(warnings.length > 0 && { warnings }),
          }, null, 2),
        }],
      };
    }
  );
}
