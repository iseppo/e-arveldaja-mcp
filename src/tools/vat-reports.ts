import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";

// EU member state country codes for VD report filtering
const EU_COUNTRY_CODES = new Set([
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "FIN", "FRA", "DEU",
  "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL",
  "PRT", "ROU", "SVK", "SVN", "ESP", "SWE",
  // Also accept 2-letter ISO codes
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "FI", "FR", "DE",
  "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL",
  "PT", "RO", "SK", "SI", "ES", "SE",
]);

export function registerVatReportTools(server: McpServer, api: ApiContext): void {

  server.tool("validate_vat_coding",
    "Check invoice-level VAT issues: missing VAT numbers on EU supply, zero VAT on domestic sales, missing supplier registry codes.",
    {
      date_from: z.string().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().describe("Period end (YYYY-MM-DD)"),
    },
    async ({ date_from, date_to }) => {
      const allSales = await api.saleInvoices.listAll();
      const allPurchases = await api.purchaseInvoices.listAll();
      const allClients = await api.clients.listAll();

      const issues: Array<{ severity: string; type: string; invoice_type: string; invoice_id: number; invoice_number: string; message: string }> = [];

      // Check sale invoices
      for (const inv of allSales) {
        if (inv.status !== "CONFIRMED") continue;
        if (inv.journal_date < date_from || inv.journal_date > date_to) continue;

        // Check for EU supply without VAT number
        if (inv.intra_community_supply && !inv.client_vat_no) {
          issues.push({
            severity: "HIGH",
            type: "missing_vat_no",
            invoice_type: "sale",
            invoice_id: inv.id!,
            invoice_number: inv.number ?? "",
            message: `Intra-Community supply to ${inv.client_name} without VAT number`,
          });
        }

        // Check zero VAT on domestic invoice
        const totalVat = (inv.vat20_price ?? 0) + (inv.vat9_price ?? 0) + (inv.vat5_price ?? 0);
        if (totalVat === 0 && (inv.net_price ?? 0) > 0 && !inv.intra_community_supply && inv.cl_countries_id === "EST") {
          issues.push({
            severity: "MEDIUM",
            type: "zero_vat_domestic",
            invoice_type: "sale",
            invoice_id: inv.id!,
            invoice_number: inv.number ?? "",
            message: `Domestic sale to ${inv.client_name} with zero VAT (net: ${inv.net_price})`,
          });
        }
      }

      // Check purchase invoices
      for (const inv of allPurchases) {
        if (inv.status !== "CONFIRMED") continue;
        if (inv.journal_date < date_from || inv.journal_date > date_to) continue;

        // Supplier without registry code
        const client = allClients.find(c => c.id === inv.clients_id);
        if (client && !client.code) {
          issues.push({
            severity: "LOW",
            type: "missing_reg_code",
            invoice_type: "purchase",
            invoice_id: inv.id!,
            invoice_number: inv.number,
            message: `Supplier ${inv.client_name} has no registry code`,
          });
        }
      }

      issues.sort((a, b) => {
        const sev = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        return (sev[a.severity as keyof typeof sev] ?? 3) - (sev[b.severity as keyof typeof sev] ?? 3);
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: { from: date_from, to: date_to },
            total_issues: issues.length,
            by_severity: {
              HIGH: issues.filter(i => i.severity === "HIGH").length,
              MEDIUM: issues.filter(i => i.severity === "MEDIUM").length,
              LOW: issues.filter(i => i.severity === "LOW").length,
            },
            issues,
          }, null, 2),
        }],
      };
    }
  );

  server.tool("prepare_kmd_inf",
    "Prepare KMD INF annexes (partner-level VAT detail). " +
    "Annex A = sales by partner, Annex B = purchases by partner. " +
    "Threshold applied to NET amount per partner per EMTA rules (default >= 1000 EUR).",
    {
      date_from: z.string().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().describe("Period end (YYYY-MM-DD)"),
      threshold: z.number().optional().describe("Reporting threshold in EUR net (default 1000)"),
    },
    async ({ date_from, date_to, threshold }) => {
      const limit = threshold ?? 1000;
      const allClients = await api.clients.listAll();

      // Aggregate sales by client
      const allSales = await api.saleInvoices.listAll();
      const salesByClient = new Map<number, { name: string; code: string; vat_no: string; net: number; vat: number; gross: number; count: number }>();

      for (const inv of allSales) {
        if (inv.status !== "CONFIRMED") continue;
        if (inv.journal_date < date_from || inv.journal_date > date_to) continue;

        const entry = salesByClient.get(inv.clients_id) ?? {
          name: inv.client_name ?? "", code: "", vat_no: "",
          net: 0, vat: 0, gross: 0, count: 0,
        };
        const client = allClients.find(c => c.id === inv.clients_id);
        if (client) {
          entry.code = client.code ?? "";
        }
        // Prefer invoice-snapshot VAT number over current client master
        entry.vat_no = inv.client_vat_no ?? client?.invoice_vat_no ?? entry.vat_no;
        entry.net += inv.base_net_price ?? inv.net_price ?? 0;
        entry.vat += (inv.base_vat20_price ?? inv.vat20_price ?? 0) + (inv.base_vat9_price ?? inv.vat9_price ?? 0) + (inv.base_vat5_price ?? inv.vat5_price ?? 0);
        entry.gross += inv.base_gross_price ?? inv.gross_price ?? 0;
        entry.count++;
        salesByClient.set(inv.clients_id, entry);
      }

      // Aggregate purchases by client
      const allPurchases = await api.purchaseInvoices.listAll();
      const purchasesByClient = new Map<number, { name: string; code: string; vat_no: string; net: number; vat: number; gross: number; count: number }>();

      for (const inv of allPurchases) {
        if (inv.status !== "CONFIRMED") continue;
        if (inv.journal_date < date_from || inv.journal_date > date_to) continue;

        const entry = purchasesByClient.get(inv.clients_id) ?? {
          name: inv.client_name, code: "", vat_no: "",
          net: 0, vat: 0, gross: 0, count: 0,
        };
        const client = allClients.find(c => c.id === inv.clients_id);
        if (client) {
          entry.code = client.code ?? "";
          entry.vat_no = client.invoice_vat_no ?? "";
        }
        entry.net += inv.base_net_price ?? inv.net_price ?? 0;
        entry.vat += inv.base_vat_price ?? inv.vat_price ?? 0;
        entry.gross += inv.base_gross_price ?? inv.gross_price ?? 0;
        entry.count++;
        purchasesByClient.set(inv.clients_id, entry);
      }

      const r = (n: number) => Math.round(n * 100) / 100;

      // Threshold applied to NET amount per EMTA rules
      const annexA = [...salesByClient.entries()]
        .filter(([, v]) => v.net >= limit)
        .map(([id, v]) => ({ clients_id: id, name: v.name, code: v.code, vat_no: v.vat_no, net: r(v.net), vat: r(v.vat), gross: r(v.gross), invoices: v.count }))
        .sort((a, b) => b.net - a.net);

      const annexB = [...purchasesByClient.entries()]
        .filter(([, v]) => v.net >= limit)
        .map(([id, v]) => ({ clients_id: id, name: v.name, code: v.code, vat_no: v.vat_no, net: r(v.net), vat: r(v.vat), gross: r(v.gross), invoices: v.count }))
        .sort((a, b) => b.net - a.net);

      const warnings = [
        "DRAFT — EMTA requires invoice-level detail. This is partner-level aggregation for review.",
        "Credit invoices should be reported separately per EMTA rules.",
      ];
      for (const row of [...annexA, ...annexB]) {
        if (!row.code) warnings.push(`${row.name}: missing registry code`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: { from: date_from, to: date_to },
            threshold_net: limit,
            annex_a_sales: { count: annexA.length, rows: annexA },
            annex_b_purchases: { count: annexB.length, rows: annexB },
            warnings,
          }, null, 2),
        }],
      };
    }
  );

  server.tool("prepare_vd_report",
    "Prepare VD report (intra-Community supply report) from sales invoices " +
    "explicitly marked as intra_community_supply to EU member states. " +
    "Only includes B2B EU supply with VAT numbers.",
    {
      date_from: z.string().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().describe("Period end (YYYY-MM-DD)"),
    },
    async ({ date_from, date_to }) => {
      const allSales = await api.saleInvoices.listAll();
      // Only include invoices explicitly flagged as intra-Community supply
      // AND to an EU member state (not non-EU exports)
      const euSales = allSales.filter((inv: SaleInvoice) =>
        inv.status === "CONFIRMED" &&
        inv.journal_date >= date_from && inv.journal_date <= date_to &&
        inv.intra_community_supply === true &&
        inv.cl_countries_id && inv.cl_countries_id !== "EST" &&
        EU_COUNTRY_CODES.has(inv.cl_countries_id)
      );

      const allClients = await api.clients.listAll();

      const byCountry = new Map<string, { country: string; partners: Map<string, { name: string; vat_no: string; amount: number; count: number }> }>();

      const issues: string[] = [];

      for (const inv of euSales) {
        const country = inv.cl_countries_id ?? "??";
        const client = allClients.find(c => c.id === inv.clients_id);
        const vatNo = inv.client_vat_no ?? client?.invoice_vat_no ?? "";

        if (!vatNo) {
          issues.push(`Invoice ${inv.number}: ${inv.client_name} - missing VAT number for EU supply (EXCLUDED from report)`);
          continue; // Cannot include in VD without a VAT number
        }

        if (!byCountry.has(country)) {
          byCountry.set(country, { country, partners: new Map() });
        }
        const countryEntry = byCountry.get(country)!;
        const partner = countryEntry.partners.get(vatNo) ?? { name: inv.client_name ?? "", vat_no: vatNo, amount: 0, count: 0 };
        partner.amount += inv.base_net_price ?? inv.net_price ?? 0;
        partner.count++;
        countryEntry.partners.set(vatNo, partner);
      }

      const r = (n: number) => Math.round(n * 100) / 100;

      const rows = [...byCountry.values()].map(c => ({
        country: c.country,
        partners: [...c.partners.values()].map(p => ({
          name: p.name,
          vat_no: p.vat_no,
          amount: r(p.amount),
          invoices: p.count,
        })),
      }));

      // Check for excluded invoices that might need attention
      const nonEuForeign = allSales.filter((inv: SaleInvoice) =>
        inv.status === "CONFIRMED" &&
        inv.journal_date >= date_from && inv.journal_date <= date_to &&
        inv.cl_countries_id && inv.cl_countries_id !== "EST" &&
        !EU_COUNTRY_CODES.has(inv.cl_countries_id)
      );
      if (nonEuForeign.length > 0) {
        issues.push(`${nonEuForeign.length} non-EU foreign invoice(s) excluded from VD (these are exports, not intra-Community supply).`);
      }

      // Compute totals only from invoices that made it into the report (i.e., had VAT numbers)
      const reportedInvoiceCount = rows.reduce((s, c) => s + c.partners.reduce((s2, p) => s2 + p.invoices, 0), 0);
      const reportedAmount = r(rows.reduce((s, c) => s + c.partners.reduce((s2, p) => s2 + p.amount, 0), 0));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: { from: date_from, to: date_to },
            total_eu_invoices: reportedInvoiceCount,
            total_amount: reportedAmount,
            excluded_no_vat_number: euSales.length - reportedInvoiceCount,
            by_country: rows,
            issues,
            note: "DRAFT VD report. Only includes invoices with intra_community_supply=true to EU member states. Verify VAT numbers before EMTA submission.",
          }, null, 2),
        }],
      };
    }
  );
}
