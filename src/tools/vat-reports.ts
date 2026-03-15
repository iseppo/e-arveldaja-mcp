import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";

// Estonian KMD VAT return structure (EMTA form 2025-07)
interface KmdLine {
  line: string;
  description_est: string;
  description_eng: string;
  amount: number;
  computed: boolean;
}

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

  server.tool("prepare_kmd_report",
    "Prepare draft Estonian KMD (VAT return) from confirmed invoices for a period. " +
    "Line mapping per EMTA form 2025-07: 1=24%, 2=9%, 21=5%, 22=13%. " +
    "Note: API field vat20_price represents current standard rate (24%).",
    {
      date_from: z.string().describe("Period start (YYYY-MM-DD)"),
      date_to: z.string().describe("Period end (YYYY-MM-DD)"),
    },
    async ({ date_from, date_to }) => {
      const allSales = await api.saleInvoices.listAll();
      const periodSales = allSales.filter((inv: SaleInvoice) =>
        inv.status === "CONFIRMED" &&
        inv.journal_date >= date_from && inv.journal_date <= date_to
      );

      const allPurchases = await api.purchaseInvoices.listAll();
      const periodPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.status === "CONFIRMED" &&
        inv.journal_date >= date_from && inv.journal_date <= date_to
      );

      // Output VAT by rate (vat20_price = standard rate, currently 24%)
      const salesVat24 = periodSales.reduce((s: number, inv: SaleInvoice) => s + (inv.base_vat20_price ?? inv.vat20_price ?? 0), 0);
      const salesVat9 = periodSales.reduce((s: number, inv: SaleInvoice) => s + (inv.base_vat9_price ?? inv.vat9_price ?? 0), 0);
      const salesVat5 = periodSales.reduce((s: number, inv: SaleInvoice) => s + (inv.base_vat5_price ?? inv.vat5_price ?? 0), 0);
      const totalOutputVat = salesVat24 + salesVat9 + salesVat5;

      // Compute implied net per rate from VAT amounts
      const netAt24 = salesVat24 > 0 ? Math.round(salesVat24 / 0.24 * 100) / 100 : 0;
      const netAt9 = salesVat9 > 0 ? Math.round(salesVat9 / 0.09 * 100) / 100 : 0;
      const netAt5 = salesVat5 > 0 ? Math.round(salesVat5 / 0.05 * 100) / 100 : 0;

      // Total sales net
      const salesNetTotal = periodSales.reduce((s: number, inv: SaleInvoice) => s + (inv.base_net_price ?? inv.net_price ?? 0), 0);
      // Remaining net could be 0% or 13% supply
      const netRemaining = salesNetTotal - netAt24 - netAt9 - netAt5;

      // Input VAT from purchase invoices
      const inputVat = periodPurchases.reduce((s: number, inv: PurchaseInvoice) => s + (inv.base_vat_price ?? inv.vat_price ?? 0), 0);

      const r = (n: number) => Math.round(n * 100) / 100;

      // KMD lines per EMTA form 2025-07
      const lines: KmdLine[] = [
        { line: "1", description_est: "24% määraga maksustatav käive", description_eng: "24% taxable supply", amount: r(netAt24), computed: true },
        { line: "2", description_est: "9% määraga maksustatav käive", description_eng: "9% taxable supply", amount: r(netAt9), computed: true },
        { line: "3", description_est: "0% määraga maksustatav käive (mahaarvatav)", description_eng: "0% taxable supply (deductible)", amount: 0, computed: false },
        { line: "3.1", description_est: "0% määraga käive (mittemahaarvatav)", description_eng: "0% supply (non-deductible)", amount: 0, computed: false },
        { line: "4", description_est: "Käibemaks kokku (1×24% + 2×9% + 21×5% + 22×13%)", description_eng: "Total output VAT", amount: r(totalOutputVat), computed: true },
        { line: "5", description_est: "Sisendkäibemaks kokku", description_eng: "Total input VAT", amount: r(inputVat), computed: true },
        { line: "6", description_est: "Ühendusesisene kaupade soetamine", description_eng: "Intra-Community acquisition of goods", amount: 0, computed: false },
        { line: "7", description_est: "Ühendusesisene kaupade soetamise käibemaks", description_eng: "VAT on intra-Community acquisition", amount: 0, computed: false },
        { line: "10", description_est: "Tasumisele kuuluv käibemaks (rida 4-5+7)", description_eng: "VAT payable (line 4-5+7)", amount: r(totalOutputVat - inputVat), computed: true },
        { line: "21", description_est: "5% määraga maksustatav käive", description_eng: "5% taxable supply", amount: r(netAt5), computed: true },
        { line: "22", description_est: "13% määraga maksustatav käive", description_eng: "13% taxable supply", amount: 0, computed: false },
      ];

      const warnings = [
        "This is a DRAFT. Review all lines before submitting to EMTA.",
        "Lines marked computed=false are NOT calculated from invoice data and require manual input: 3, 3.1 (0% supply classification), 6-7 (intra-Community acquisition), 22 (13% supply).",
        "Lines 1/2/21 are derived by dividing aggregate VAT by the rate — mixed-rate invoices may be misallocated.",
        "Line 5 (input VAT) is a GROSS sum of all purchase invoice VAT — does not distinguish deductible vs non-deductible, exempt, private use, or reverse-charge.",
      ];
      if (netRemaining > 0.01) {
        warnings.push(`Unclassified net amount: ${r(netRemaining)} EUR — may be 0% or 13% supply. Check invoice items.`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: { from: date_from, to: date_to },
            kmd_lines: lines,
            source_data: {
              sale_invoices: periodSales.length,
              purchase_invoices: periodPurchases.length,
              total_sales_net: r(salesNetTotal),
              total_sales_gross: r(periodSales.reduce((s: number, inv: SaleInvoice) => s + (inv.base_gross_price ?? inv.gross_price ?? 0), 0)),
              total_purchases_gross: r(periodPurchases.reduce((s: number, inv: PurchaseInvoice) => s + (inv.base_gross_price ?? inv.gross_price ?? 0), 0)),
            },
            warnings,
          }, null, 2),
        }],
      };
    }
  );

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
