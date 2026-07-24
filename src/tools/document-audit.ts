import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";
import { readOnly } from "../annotations.js";

export interface DetectDuplicateFilters {
  clients_id?: number;
  date_from?: string;
  date_to?: string;
  invoice_number?: string;
  gross_price?: number;
}

export interface MissingDocumentsFilters {
  date_from?: string;
  date_to?: string;
}

/** UNWRAPPED core rows — `title` / `description` / `client` are wrapped at output. */
export interface MissingJournalRow { id?: number; date: string; title?: string; number?: number }
export interface MissingTransactionRow { id?: number; date: string; amount: number; description?: string }
export interface MissingInvoiceRow { id?: number; date: string; number?: string; client?: string; gross?: number }

/**
 * Raw, UNWRAPPED missing-documents core (the exact envelope `find_missing_documents`
 * emits, minus the wrapping). Counts are the FULL match counts; `items` carry every
 * matching row so each consumer can slice as it needs. `wrapMissingDocuments` is the
 * SINGLE site that both `find_missing_documents` and the guided `run_accounting_report`
 * report='missing_documents' façade use to wrap `title` / `description` / `client`.
 */
export interface MissingDocumentsCore {
  period: { from: string; to: string };
  manual_journals_without_documents: { count: number; items: MissingJournalRow[] };
  transactions_without_documents: { count: number; items: MissingTransactionRow[] };
  purchase_invoices_without_documents: { count: number; items: MissingInvoiceRow[] };
  sale_invoices_system_pdfs: { count: number; items: MissingInvoiceRow[]; note: string };
  total_missing: number;
}

const SALE_INVOICES_SYSTEM_PDF_NOTE =
  "Confirmed sale invoices have a system-generated PDF available via /pdf_system and are not flagged as missing documents.";

/**
 * Pure missing-source-document detection core, EXTRACTED from the
 * `find_missing_documents` handler (behavior-preserving). Returns raw UNWRAPPED
 * rows; both the tool handler and the guided report façade wrap at MCP output via
 * `wrapMissingDocuments` — ONE source of truth for both the detection logic AND
 * the untrusted-field set.
 */
export async function computeMissingDocuments(
  api: ApiContext,
  { date_from, date_to }: MissingDocumentsFilters,
): Promise<MissingDocumentsCore> {
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
    period: { from: date_from ?? "all", to: date_to ?? "all" },
    manual_journals_without_documents: {
      count: journalsWithout.length,
      items: journalsWithout.map(j => ({ id: j.id, date: j.effective_date, title: j.title, number: j.number })),
    },
    transactions_without_documents: {
      count: txWithout.length,
      items: txWithout.map(tx => ({ id: tx.id, date: tx.date, amount: tx.amount, description: tx.description ?? undefined })),
    },
    purchase_invoices_without_documents: {
      count: purchasesWithout.length,
      items: purchasesWithout.map((inv: PurchaseInvoice) => ({ id: inv.id, date: inv.create_date, number: inv.number, client: inv.client_name ?? undefined, gross: inv.gross_price })),
    },
    sale_invoices_system_pdfs: {
      count: confirmedSalesWithSystemPdf.length,
      items: confirmedSalesWithSystemPdf.map((inv: SaleInvoice) => ({ id: inv.id, date: inv.create_date, number: inv.number, client: inv.client_name ?? undefined, gross: inv.gross_price })),
      note: SALE_INVOICES_SYSTEM_PDF_NOTE,
    },
    total_missing: journalsWithout.length + txWithout.length + purchasesWithout.length,
  };
}

/**
 * Wrap the untrusted `title` / `description` / `client` fields of a
 * MissingDocumentsCore at MCP output and slice each item list to `limit`.
 * `limit=Infinity` returns every row. Envelope key order is byte-identical to
 * the historical `find_missing_documents` output.
 */
export function wrapMissingDocuments(core: MissingDocumentsCore, limit = 20): Record<string, unknown> {
  const slice = <T>(items: readonly T[]): readonly T[] => (limit === Infinity ? items : items.slice(0, limit));
  return {
    period: core.period,
    manual_journals_without_documents: {
      count: core.manual_journals_without_documents.count,
      items: slice(core.manual_journals_without_documents.items).map(j => ({
        id: j.id, date: j.date, title: wrapUntrustedOcr(j.title), number: j.number,
      })),
    },
    transactions_without_documents: {
      count: core.transactions_without_documents.count,
      items: slice(core.transactions_without_documents.items).map(tx => ({
        id: tx.id, date: tx.date, amount: tx.amount, description: wrapUntrustedOcr(tx.description),
      })),
    },
    purchase_invoices_without_documents: {
      count: core.purchase_invoices_without_documents.count,
      items: slice(core.purchase_invoices_without_documents.items).map(inv => ({
        id: inv.id, date: inv.date, number: inv.number, client: wrapUntrustedOcr(inv.client), gross: inv.gross,
      })),
    },
    sale_invoices_system_pdfs: {
      count: core.sale_invoices_system_pdfs.count,
      items: slice(core.sale_invoices_system_pdfs.items).map(inv => ({
        id: inv.id, date: inv.date, number: inv.number, client: wrapUntrustedOcr(inv.client), gross: inv.gross,
      })),
      note: core.sale_invoices_system_pdfs.note,
    },
    total_missing: core.total_missing,
  };
}

/**
 * Pure duplicate-purchase-invoice detection core, EXTRACTED from the
 * `detect_duplicate_purchase_invoice` handler (behavior-preserving). Returns the
 * raw computed structure with UNWRAPPED supplier names; the tool handler wraps
 * `supplier` at MCP output, and the typed AccountingDocumentOperations reuse this
 * same core with the guided façade owning wrapping instead.
 */
export function detectDuplicatePurchaseInvoice(
  allPurchases: PurchaseInvoice[],
  { clients_id, date_from, date_to, invoice_number, gross_price }: DetectDuplicateFilters,
): Record<string, unknown> {
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
        supplier: invoices[0]!.client_name ?? undefined,
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
          supplier: invoices[0]!.client_name ?? undefined,
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
        supplier: inv.client_name ?? undefined,
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
        supplier: inv.client_name ?? undefined,
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
        supplier: inv.client_name ?? undefined,
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
  };
}

/** Wrap every `supplier` string in a duplicate-detection result at MCP output. */
function wrapDuplicateSuppliers(result: Record<string, unknown>): Record<string, unknown> {
  const wrapItems = (items: Array<Record<string, unknown>>) =>
    items.map(item => ({ ...item, supplier: wrapUntrustedOcr((item.supplier as string | undefined) ?? undefined) }));
  const section = (value: unknown) => {
    const s = value as { count: number; items: Array<Record<string, unknown>>; note?: unknown };
    return { ...s, items: wrapItems(s.items) };
  };
  return {
    exact_duplicates: section(result.exact_duplicates),
    suspicious_same_amount_date: section(result.suspicious_same_amount_date),
    candidate_invoice_number_matches: section(result.candidate_invoice_number_matches),
    candidate_same_amount_date_matches: section(result.candidate_same_amount_date_matches),
    candidate_invalidated_matches: section(result.candidate_invalidated_matches),
    candidate_duplicate_risk: result.candidate_duplicate_risk,
    total_invoices_checked: result.total_invoices_checked,
  };
}

export function registerDocumentAuditTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "find_missing_documents",
    "Find journals, transactions, and invoices without attached base documents.",
    {
      date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    },
    { ...readOnly, title: "Find Missing Documents" },
    async ({ date_from, date_to }) => {
      const core = await computeMissingDocuments(api, { date_from, date_to });
      return {
        content: [{
          type: "text",
          text: toMcpJson(wrapMissingDocuments(core)),
        }],
      };
    }
  );

  registerTool(server, "detect_duplicate_purchase_invoice",
    "Check duplicate purchase invoices by supplier, invoice number, amount, and date.",
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
      const result = detectDuplicatePurchaseInvoice(allPurchases, { clients_id, date_from, date_to, invoice_number, gross_price });
      return {
        content: [{
          type: "text",
          text: toMcpJson(wrapDuplicateSuppliers(result)),
        }],
      };
    }
  );
}
