import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";
import { readOnly } from "../annotations.js";

export function registerDocumentAuditTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "find_missing_documents",
    "Find journals, transactions, and invoices without attached base documents. " +
    "Important for audit trail compliance.",
    {
      date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    },
    { ...readOnly, title: "Find Missing Documents" },
    async ({ date_from, date_to }) => {
      // Journals without documents
      const allJournals = await api.journals.listAll();
      const journalsWithout = allJournals.filter(j => {
        if (j.is_deleted) return false;
        if (date_from && j.effective_date < date_from) return false;
        if (date_to && j.effective_date > date_to) return false;
        // Manual journals (no operation_type) are most likely to need documents
        return !j.base_document_files_id && !j.operation_type;
      });

      // Transactions without documents
      const allTx = await api.transactions.listAll();
      const txWithout = allTx.filter(tx => {
        if (tx.is_deleted) return false;
        if (date_from && tx.date < date_from) return false;
        if (date_to && tx.date > date_to) return false;
        return !tx.uploaded_files_id && !tx.transactions_files_id;
      });

      // Purchase invoices without documents
      const allPurchases = await api.purchaseInvoices.listAll();
      const purchasesWithout = allPurchases.filter((inv: PurchaseInvoice) => {
        if (date_from && inv.create_date < date_from) return false;
        if (date_to && inv.create_date > date_to) return false;
        return !inv.base_document_files_id && inv.status === "CONFIRMED";
      });

      // Confirmed sale invoices always have a system PDF via /pdf_system
      const allSales = await api.saleInvoices.listAll();
      const confirmedSalesWithSystemPdf = allSales.filter((inv: SaleInvoice) => {
        if (date_from && inv.create_date < date_from) return false;
        if (date_to && inv.create_date > date_to) return false;
        return inv.status === "CONFIRMED";
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            period: { from: date_from ?? "all", to: date_to ?? "all" },
            manual_journals_without_documents: {
              count: journalsWithout.length,
              items: journalsWithout.slice(0, 20).map(j => ({
                id: j.id, date: j.effective_date, title: wrapUntrustedOcr(j.title), number: j.number,
              })),
            },
            transactions_without_documents: {
              count: txWithout.length,
              items: txWithout.slice(0, 20).map(tx => ({
                id: tx.id, date: tx.date, amount: tx.amount, description: wrapUntrustedOcr(tx.description ?? undefined),
              })),
            },
            purchase_invoices_without_documents: {
              count: purchasesWithout.length,
              items: purchasesWithout.slice(0, 20).map((inv: PurchaseInvoice) => ({
                id: inv.id, date: inv.create_date, number: inv.number, client: wrapUntrustedOcr(inv.client_name ?? undefined), gross: inv.gross_price,
              })),
            },
            sale_invoices_system_pdfs: {
              count: confirmedSalesWithSystemPdf.length,
              items: confirmedSalesWithSystemPdf.slice(0, 20).map((inv: SaleInvoice) => ({
                id: inv.id, date: inv.create_date, number: inv.number, client: wrapUntrustedOcr(inv.client_name ?? undefined), gross: inv.gross_price,
              })),
              note: "Confirmed sale invoices have a system-generated PDF available via /pdf_system and are not flagged as missing documents.",
            },
            total_missing: journalsWithout.length + txWithout.length + purchasesWithout.length,
          }),
        }],
      };
    }
  );

  registerTool(server, "detect_duplicate_purchase_invoice",
    "Check for duplicate purchase invoices by supplier + invoice number, and by supplier + amount + date. " +
    "Can also test an incoming invoice candidate against existing invoices.",
    {
      clients_id: z.number().optional().describe("Filter by supplier ID"),
      date_from: z.string().optional().describe("Start date"),
      date_to: z.string().optional().describe("End date"),
      invoice_number: z.string().optional().describe("Incoming invoice number to match against existing invoices"),
      gross_price: z.number().optional().describe("Incoming gross amount to match against existing invoices"),
    },
    { ...readOnly, title: "Detect Duplicate Purchase Invoices" },
    async ({ clients_id, date_from, date_to, invoice_number, gross_price }) => {
      const allPurchases = await api.purchaseInvoices.listAll();
      const normalizedInvoiceNumber = invoice_number?.trim().toLowerCase();

      const filtered = allPurchases.filter((inv: PurchaseInvoice) => {
        if (inv.status === "DELETED" || inv.status === "INVALIDATED") return false;
        if (clients_id && inv.clients_id !== clients_id) return false;
        if (date_from && inv.create_date < date_from) return false;
        if (date_to && inv.create_date > date_to) return false;
        return true;
      });

      // Group by supplier + invoice number
      const groups = new Map<string, PurchaseInvoice[]>();
      for (const inv of filtered) {
        const key = `${inv.clients_id}:${inv.number.trim().toLowerCase()}`;
        const group = groups.get(key) ?? [];
        group.push(inv);
        groups.set(key, group);
      }

      const duplicates = [];
      for (const [, invoices] of groups) {
        if (invoices.length > 1) {
          duplicates.push({
            supplier: wrapUntrustedOcr(invoices[0]!.client_name ?? undefined),
            invoice_number: invoices[0]!.number,
            count: invoices.length,
            invoices: invoices.map(inv => ({
              id: inv.id,
              date: inv.create_date,
              gross: inv.gross_price,
              status: inv.status,
            })),
          });
        }
      }

      // Also check for same supplier + same amount + same date (different number)
      const amountDupes = [];
      const amountGroups = new Map<string, PurchaseInvoice[]>();
      for (const inv of filtered) {
        const key = `${inv.clients_id}:${inv.gross_price}:${inv.create_date}`;
        const group = amountGroups.get(key) ?? [];
        group.push(inv);
        amountGroups.set(key, group);
      }

      for (const [, invoices] of amountGroups) {
        if (invoices.length > 1) {
          const numbers = new Set(invoices.map(i => i.number));
          if (numbers.size > 1) { // Different invoice numbers but same amount+date
            amountDupes.push({
              supplier: wrapUntrustedOcr(invoices[0]!.client_name ?? undefined),
              amount: invoices[0]!.gross_price,
              date: invoices[0]!.create_date,
              invoices: invoices.map(inv => ({
                id: inv.id,
                number: inv.number,
                status: inv.status,
              })),
            });
          }
        }
      }

      const candidateInvoiceNumberMatches = normalizedInvoiceNumber
        ? filtered.filter(inv => inv.number.trim().toLowerCase() === normalizedInvoiceNumber)
        : [];
      const candidateSameAmountDateMatches = gross_price !== undefined
        ? filtered.filter(inv => inv.gross_price !== undefined && Math.abs(inv.gross_price - gross_price) <= 0.02)
        : [];

      // Also look at invalidated/deleted invoices for the candidate so the caller
      // sees "we tried to book this before and voided it" instead of assuming new.
      const voidedCandidates = allPurchases.filter((inv) => {
        if (inv.status !== "DELETED" && inv.status !== "INVALIDATED") return false;
        if (clients_id && inv.clients_id !== clients_id) return false;
        if (date_from && inv.create_date < date_from) return false;
        if (date_to && inv.create_date > date_to) return false;
        const numberMatch = normalizedInvoiceNumber
          ? inv.number.trim().toLowerCase() === normalizedInvoiceNumber
          : false;
        const amountMatch = gross_price !== undefined &&
          inv.gross_price !== undefined &&
          Math.abs(inv.gross_price - gross_price) <= 0.02;
        return numberMatch || amountMatch;
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            exact_duplicates: {
              count: duplicates.length,
              items: duplicates,
            },
            suspicious_same_amount_date: {
              count: amountDupes.length,
              items: amountDupes,
            },
            candidate_invoice_number_matches: {
              count: candidateInvoiceNumberMatches.length,
              items: candidateInvoiceNumberMatches.map(inv => ({
                id: inv.id,
                supplier: wrapUntrustedOcr(inv.client_name ?? undefined),
                supplier_id: inv.clients_id,
                invoice_number: inv.number,
                date: inv.create_date,
                gross: inv.gross_price,
                status: inv.status,
              })),
            },
            candidate_same_amount_date_matches: {
              count: candidateSameAmountDateMatches.length,
              items: candidateSameAmountDateMatches.map(inv => ({
                id: inv.id,
                supplier: wrapUntrustedOcr(inv.client_name ?? undefined),
                supplier_id: inv.clients_id,
                invoice_number: inv.number,
                date: inv.create_date,
                gross: inv.gross_price,
                status: inv.status,
              })),
            },
            candidate_invalidated_matches: {
              count: voidedCandidates.length,
              note: voidedCandidates.length > 0
                ? "A previous booking of this same supplier+number or supplier+amount+date was invalidated or deleted — verify this isn't a re-attempt before creating."
                : undefined,
              items: voidedCandidates.map(inv => ({
                id: inv.id,
                supplier: wrapUntrustedOcr(inv.client_name ?? undefined),
                supplier_id: inv.clients_id,
                invoice_number: inv.number,
                date: inv.create_date,
                gross: inv.gross_price,
                status: inv.status,
              })),
            },
            candidate_duplicate_risk:
              candidateInvoiceNumberMatches.length > 0 || candidateSameAmountDateMatches.length > 0,
            total_invoices_checked: filtered.length,
          }),
        }],
      };
    }
  );
}
