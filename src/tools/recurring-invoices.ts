import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { type ApiContext, tagNotes } from "./crud-tools.js";
import type { SaleInvoice } from "../types/api.js";
import { batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";

const RECURRING_CLONE_MARKER_PREFIX = "RECURRING_SOURCE_INVOICE";
const RECURRING_CLONE_MARKER_RE = /RECURRING_SOURCE_INVOICE:\d+:TARGET_DATE:\d{4}-\d{2}-\d{2}/g;
const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const COMMA_SEPARATED_IDS_REGEX = /^\d+(?:\s*,\s*\d+)*$/;

function buildRecurringCloneMarker(sourceId: number, targetDate: string): string {
  return `${RECURRING_CLONE_MARKER_PREFIX}:${sourceId}:TARGET_DATE:${targetDate}`;
}

function extractRecurringCloneMarkers(notes?: string | null): string[] {
  return notes?.match(RECURRING_CLONE_MARKER_RE) ?? [];
}

function appendRecurringCloneMarker(notes: string | null | undefined, marker: string): string {
  if (notes?.includes(marker)) return notes;
  return notes ? `${notes}\n${marker}` : marker;
}

export function registerRecurringInvoiceTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "create_recurring_sale_invoices",
    "Clone sale invoices from a previous month for recurring monthly billing. " +
    "Copies items, client, template from source invoices and creates DRAFT invoices. " +
    "Use dry_run=true to preview without creating. Invoice numbers are auto-assigned by the configured invoice series.",
    {
      source_month: z.string().regex(MONTH_REGEX, "Expected YYYY-MM").describe("Source month to copy from (YYYY-MM)"),
      target_date: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").describe("New invoice date (YYYY-MM-DD)"),
      target_journal_date: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").describe("New turnover date (YYYY-MM-DD)"),
      invoice_ids: z.string().regex(COMMA_SEPARATED_IDS_REGEX, "Expected comma-separated numeric invoice IDs").optional().describe("Comma-separated source invoice IDs to copy (default: all confirmed from source month)"),
      auto_confirm: z.boolean().optional().describe("Confirm created invoices (default false)"),
      dry_run: z.boolean().optional().describe("Preview without creating invoices (default false)"),
    },
    { ...batch, title: "Create Recurring Sale Invoices" },
    async ({ source_month, target_date, target_journal_date, invoice_ids, auto_confirm, dry_run }) => {
      const isDryRun = dry_run === true;
      const allSales = await api.saleInvoices.listAll();
      const sourceFrom = `${source_month}-01`;
      const sourceLastDay = new Date(parseInt(source_month.split("-")[0]!, 10), parseInt(source_month.split("-")[1]!, 10), 0).getDate();
      const sourceTo = `${source_month}-${String(sourceLastDay).padStart(2, "0")}`;
      const existingCloneMarkers = new Map<string, { id?: number; number?: string }>();

      for (const invoice of allSales) {
        if (invoice.create_date !== target_date || invoice.is_deleted) continue;
        for (const marker of extractRecurringCloneMarkers(invoice.notes)) {
          existingCloneMarkers.set(marker, { id: invoice.id, number: invoice.number });
        }
      }

      let sourceInvoices: SaleInvoice[];
      if (invoice_ids) {
        const ids = invoice_ids.split(",").map(s => parseInt(s.trim(), 10));
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

      const results: Array<Record<string, unknown> & { status: string }> = [];

      for (const source of sourceInvoices) {
        if (!source.id) {
          results.push({
            source_number: source.number,
            client: source.client_name,
            status: "error",
            error: "Source invoice is missing an ID",
          });
          continue;
        }

        const recurringMarker = buildRecurringCloneMarker(source.id, target_date);
        const existingClone = existingCloneMarkers.get(recurringMarker);
        if (existingClone) {
          results.push({
            source_id: source.id,
            source_number: source.number,
            client: source.client_name,
            existing_id: existingClone.id,
            existing_number: existingClone.number,
            status: isDryRun ? "would_skip_existing" : "skipped_existing",
          });
          continue;
        }

        const full = await api.saleInvoices.get(source.id);
        if (!full.items || full.items.length === 0) {
          results.push({
            source_id: source.id,
            source_number: source.number,
            client: full.client_name,
            status: "error",
            error: "Source invoice has no items to clone",
          });
          continue;
        }

        if (isDryRun) {
          results.push({
            source_id: source.id,
            source_number: source.number,
            client: full.client_name,
            items_count: full.items.length,
            gross_price: full.gross_price,
            status: "would_create",
          });
          existingCloneMarkers.set(recurringMarker, {});
          continue;
        }

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
            // Clone tax-critical invoice-level fields. Anything affecting VAT
            // treatment, legal narrative, or cross-border classification must
            // survive the clone — a stale value on a recurring invoice can
            // silently change how it's reported on KMD INF / VD.
            intra_community_supply: full.intra_community_supply,
            client_vat_no: full.client_vat_no,
            triangulation: full.triangulation,
            assembled_in_member_state: full.assembled_in_member_state,
            contract_number: full.contract_number,
            invoice_content_code: full.invoice_content_code,
            invoice_content_text: full.invoice_content_text,
            trade_secret: full.trade_secret,
            use_per_item_rounding: full.use_per_item_rounding,
            overdue_charge: full.overdue_charge,
            notes: tagNotes(appendRecurringCloneMarker(full.notes, recurringMarker)),
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
          existingCloneMarkers.set(recurringMarker, { id: result.created_object_id });
          logAudit({
            tool: "create_recurring_sale_invoices", action: "CREATED", entity_type: "sale_invoice",
            entity_id: result.created_object_id,
            summary: `Cloned sale invoice from #${source.id} (${full.client_name}) for ${target_date}`,
            details: { source_id: source.id, source_number: source.number, client_name: full.client_name, date: target_date, total_gross: full.gross_price },
          });

          let confirmed = false;
          let confirmError: string | undefined;
          let status = "created";
          if (auto_confirm && result.created_object_id) {
            try {
              await api.saleInvoices.confirm(result.created_object_id);
              confirmed = true;
              status = "confirmed";
              logAudit({
                tool: "clone_sale_invoice", action: "CONFIRMED", entity_type: "sale_invoice",
                entity_id: result.created_object_id,
                summary: `Confirmed cloned sale invoice #${result.created_object_id} (${full.client_name}) for ${target_date}`,
                details: { source_id: source.id, client_name: full.client_name, date: target_date },
              });
            } catch (err: unknown) {
              confirmError = err instanceof Error ? err.message : String(err);
              status = "confirm_error";
            }
          }

          results.push({
            source_id: source.id,
            source_number: source.number,
            client: full.client_name,
            created_id: result.created_object_id,
            confirmed,
            ...(confirmError ? { confirm_error: confirmError } : {}),
            status,
          });
        } catch (err: unknown) {
          results.push({
            source_id: source.id,
            source_number: source.number,
            client: source.client_name,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const createdCount = results.filter(r => ["created", "confirmed", "confirm_error"].includes(r.status)).length;
      const confirmedCount = results.filter(r => r.status === "confirmed").length;
      const skippedExistingCount = results.filter(r => r.status === "skipped_existing").length;
      const createErrorsCount = results.filter(r => r.status === "error").length;
      const confirmErrorsCount = results.filter(r => r.status === "confirm_error").length;
      const wouldCreateCount = results.filter(r => r.status === "would_create").length;
      const wouldSkipExistingCount = results.filter(r => r.status === "would_skip_existing").length;

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode: isDryRun ? "DRY_RUN" : "EXECUTED",
            source_month,
            target_date,
            source_count: sourceInvoices.length,
            would_create: isDryRun ? wouldCreateCount : undefined,
            would_skip_existing: isDryRun ? wouldSkipExistingCount : undefined,
            created: isDryRun ? undefined : createdCount,
            confirmed: isDryRun ? undefined : confirmedCount,
            skipped_existing: isDryRun ? undefined : skippedExistingCount,
            errors: isDryRun ? undefined : createErrorsCount + confirmErrorsCount,
            create_errors: isDryRun ? undefined : createErrorsCount,
            confirm_errors: isDryRun ? undefined : confirmErrorsCount,
            results,
            ...(isDryRun && { note: "Preview only. Omit dry_run or set dry_run=false to create the invoices." }),
          }),
        }],
      };
    }
  );
}
