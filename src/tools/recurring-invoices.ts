import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice } from "../types/api.js";
import { batch } from "../annotations.js";

export function registerRecurringInvoiceTools(server: McpServer, api: ApiContext): void {

  server.tool("create_recurring_sale_invoices",
    "Clone sale invoices from a previous month for recurring monthly billing. " +
    "Copies items, client, template from source invoices. Creates as DRAFT. " +
    "Invoice numbers are auto-assigned by the configured invoice series.",
    {
      source_month: z.string().describe("Source month to copy from (YYYY-MM)"),
      target_date: z.string().describe("New invoice date (YYYY-MM-DD)"),
      target_journal_date: z.string().describe("New turnover date (YYYY-MM-DD)"),
      invoice_ids: z.string().optional().describe("Comma-separated source invoice IDs to copy (default: all confirmed from source month)"),
      auto_confirm: z.boolean().optional().describe("Confirm created invoices (default false)"),
    },
    { ...batch, title: "Create Recurring Sale Invoices" },
    async ({ source_month, target_date, target_journal_date, invoice_ids, auto_confirm }) => {
      // Get source invoices
      const allSales = await api.saleInvoices.listAll();
      const sourceFrom = `${source_month}-01`;
      const sourceLastDay = new Date(parseInt(source_month.split("-")[0]!), parseInt(source_month.split("-")[1]!), 0).getDate();
      const sourceTo = `${source_month}-${String(sourceLastDay).padStart(2, "0")}`;

      let sourceInvoices: SaleInvoice[];
      if (invoice_ids) {
        const ids = invoice_ids.split(",").map(s => parseInt(s.trim()));
        sourceInvoices = [];
        for (const id of ids) {
          sourceInvoices.push(await api.saleInvoices.get(id));
        }
      } else {
        sourceInvoices = allSales.filter((inv: SaleInvoice) =>
          inv.status === "CONFIRMED" &&
          inv.create_date >= sourceFrom && inv.create_date <= sourceTo
        );
      }

      const results = [];

      for (const source of sourceInvoices) {
        // Fetch full invoice to get items
        const full = await api.saleInvoices.get(source.id!);
        if (!full.items || full.items.length === 0) continue;

        try {
          const result = await api.saleInvoices.create({
            sale_invoice_type: full.sale_invoice_type,
            cl_templates_id: full.cl_templates_id,
            clients_id: full.clients_id,
            cl_countries_id: full.cl_countries_id,
            number_prefix: full.number_prefix,
            number_suffix: "", // empty = auto-assigned by invoice series
            create_date: target_date,
            journal_date: target_journal_date,
            term_days: full.term_days,
            cl_currencies_id: full.cl_currencies_id,
            show_client_balance: full.show_client_balance,
            receivable_accounts_id: full.receivable_accounts_id,
            // Clone tax-critical invoice-level fields
            intra_community_supply: full.intra_community_supply,
            client_vat_no: full.client_vat_no,
            items: full.items.map(item => ({
              products_id: item.products_id,
              cl_sale_articles_id: item.cl_sale_articles_id,
              sale_accounts_id: item.sale_accounts_id,
              sale_accounts_dimensions_id: item.sale_accounts_dimensions_id,
              custom_title: item.custom_title,
              amount: item.amount,
              unit: item.unit,
              unit_net_price: item.unit_net_price,
              total_net_price: item.total_net_price,
              vat_accounts_id: item.vat_accounts_id,
              vat_rate: item.vat_rate,
              discount_percent: item.discount_percent,
              discount_amount: item.discount_amount,
              projects_project_id: item.projects_project_id,
              projects_location_id: item.projects_location_id,
              projects_person_id: item.projects_person_id,
            })),
          });

          let confirmed = false;
          let confirmError: string | undefined;
          if (auto_confirm && result.created_object_id) {
            try {
              await api.saleInvoices.confirm(result.created_object_id);
              confirmed = true;
            } catch (err: any) {
              confirmError = err instanceof Error ? err.message : String(err);
            }
          }

          results.push({
            source_id: source.id,
            source_number: source.number,
            client: full.client_name,
            created_id: result.created_object_id,
            confirmed,
            ...(confirmError ? { confirm_error: confirmError } : {}),
            status: "ok",
          });
        } catch (err: any) {
          results.push({
            source_id: source.id,
            source_number: source.number,
            client: source.client_name,
            status: "error",
            error: err.message,
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            source_month,
            target_date,
            source_count: sourceInvoices.length,
            created: results.filter(r => r.status === "ok").length,
            errors: results.filter(r => r.status === "error").length,
            results,
          }, null, 2),
        }],
      };
    }
  );
}
