import { vi } from "vitest";
import { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import { HttpError } from "../http-client.js";
import { withSignedCamtMarker } from "./camt-marker.js";

export interface ReceiptTransportOptions {
  isVatRegistered: boolean;
  net: number;
  vat: number;
  gross: number;
  bank?: boolean;
  onInvoiceGet?: (row: any, nth: number) => any;
  onUpload?: (row: any) => void;
  onDocumentGet?: (file: any, row: any) => any;
  uploadError?: unknown;
  registerError?: unknown;
}

/** Actual observed server shapes: real PUT changes the attachment ID and
 * invalidates BaseResource cache; VAT-account rows ignore project gross override.
 * Only the HTTP transport and unrelated readonly/bank ports are doubles. */
export function receiptAttachmentTransport(options: ReceiptTransportOptions) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let stored: any; let document: any; let gets = 0;
  const id = options.isVatRegistered ? 5555771 : 5555769;
  const fileId = options.isVatRegistered ? 9705136 : 9705134;
  const supplierId = options.isVatRegistered ? 2371627 : 1702927;
  const supplierName = options.isVatRegistered ? "Next Interaction OÜ" : "Delfi Meedia AS";
  const item: any = { cl_purchase_articles_id: options.isVatRegistered ? 62 : 66,
    purchase_accounts_id: options.isVatRegistered ? 5990 : 7910,
    purchase_accounts_dimensions_id: options.isVatRegistered ? 12637375 : 942283,
    amount: 1, vat_rate_dropdown: options.isVatRegistered ? "24" : "-",
    ...(options.isVatRegistered ? { vat_accounts_id: 1510, cl_vat_articles_id: 1 } : {}) };
  const source: any = { supplier_name: supplierName, invoice_number: `ATTACHMENT-${id}`, invoice_date: "2026-10-19", due_date: "2026-10-19", ref_number: "12345",
    total_net: options.net, total_vat: options.vat, total_gross: options.gross, currency: "EUR", description: "Receipt service" };
  const normalize = (row: any, index: number) => ({ products_id: null, cl_fringe_benefits_id: 1,
    reversed_vat_id: null, unit: null, unit_net_price: null, vat_accounts_dimensions_id: null,
    projects_project_id: null, projects_location_id: null, projects_person_id: null,
    ...row, id: row.id ?? 10908710 + index, base_total_net_price: row.total_net_price,
    ...(options.isVatRegistered
      ? { project_no_vat_gross_price: null, vat_rate: 24, vat_amount: Math.round(row.total_net_price * 24) / 100 }
      : { cl_vat_articles_id: null, vat_accounts_id: null, vat_accounts_dimensions_id: null, vat_rate: null, vat_amount: null }),
  });
  const client: any = { cacheNamespace: `receipt-attachment-${Math.random()}`, connectionFingerprint: "receipt-attachment", apiBaseUrl: "https://fake.invalid",
    get: vi.fn(async (path: string) => {
      calls.push({ method: "GET", path });
      if (path === "/purchase_invoices") return { current_page: 1, total_pages: 1, items: [] };
      if (path.endsWith("/document_user")) return options.onDocumentGet ? options.onDocumentGet(structuredClone(document), stored) : structuredClone(document);
      if (path === `/purchase_invoices/${id}`) { const row = structuredClone(stored); return options.onInvoiceGet ? options.onInvoiceGet(row, ++gets) : (++gets, row); }
      throw new Error(`Unexpected GET ${path}`);
    }),
    post: vi.fn(async (path: string, body: any) => {
      calls.push({ method: "POST", path, body: structuredClone(body) });
      stored = { payment_status: null, base_document_files_id: null, bank_payment_orders_id: null, payment_type: null,
        bank_account_no: null, overdue_charge: null, paid_in_cash: false, cash_accounts_id: null, cash_accounts_dimensions_id: null,
        liability_accounts_dimensions_id: null, cash_payment_date: null, subclients_id: null, is_xls_imported: false,
        ...body, id, status: "PROJECT", currency_rate: 1, net_price: body.items[0].total_net_price,
        vat_price: 0, gross_price: 0, base_net_price: 0, base_vat_price: 0, base_gross_price: 0,
        items: body.items.map(normalize), journals: [], transactions: [], settlements: [] };
      return { code: 200, created_object_id: id, messages: [] };
    }),
    patch: vi.fn(async (path: string, body: any) => {
      calls.push({ method: "PATCH", path, body: structuredClone(body) });
      if (path.endsWith("/register")) { if (options.registerError) throw options.registerError; stored.status = "CONFIRMED"; stored.journals = [29600001]; return { code: 200 }; }
      if (path.endsWith("/invalidate")) { stored.status = "VOID"; return { code: 200 }; }
      stored = { ...stored, ...body, base_net_price: stored.net_price, base_vat_price: body.vat_price, base_gross_price: body.gross_price, items: body.items.map(normalize) };
      return { code: 200 };
    }),
    request: vi.fn(async (path: string, init: any) => {
      calls.push({ method: init.method, path, body: structuredClone(init.body) });
      if (init.method !== "PUT" || path !== `/purchase_invoices/${id}/document_user`) throw new Error(`Unexpected request ${path}`);
      document = structuredClone(init.body); stored.base_document_files_id = fileId;
      options.onUpload?.(stored);
      if (options.uploadError) throw options.uploadError;
      return { code: 200, messages: [] }; // API does not promise an attachment ID.
    }),
  };
  const purchaseInvoices = new PurchaseInvoicesApi(client);
  const tx = withSignedCamtMarker({ id: 14318407, status: "PROJECT", is_deleted: false, type: "C", clients_id: supplierId,
    accounts_dimensions_id: 942313, amount: options.gross, base_amount: options.gross, date: source.invoice_date,
    cl_currencies_id: "EUR", ref_number: source.ref_number, bank_account_name: supplierName }, "DBIT");
  const api: any = { purchaseInvoices,
    clients: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
    readonly: { getAccounts: vi.fn().mockResolvedValue([]), getPurchaseArticles: vi.fn().mockResolvedValue([]), getVatInfo: vi.fn().mockResolvedValue({ vat_number: options.isVatRegistered ? "EE102809963" : null }), getBankAccounts: vi.fn().mockResolvedValue([]) },
    journals: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
    transactions: { listAll: vi.fn().mockResolvedValue(options.bank === false ? [] : [tx]), invalidateListCache: vi.fn(), get: vi.fn(async () => structuredClone(tx)),
      confirm: vi.fn(async (_id: number, distribution: any) => { calls.push({ method: "BANK_CONFIRM", path: "/transactions/14318407", body: distribution }); return {}; }) },
  };
  return { api, client, calls, source, item, id, fileId, supplierId, supplierName, tx,
    context: { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: options.isVatRegistered },
    supplier: { found: true, created: false, client: { id: supplierId, name: supplierName } },
    suggestion: { source: "supplier_history", item },
    read: () => structuredClone(stored),
    failRead: (message = "Synthetic unavailable") => new HttpError(message, 503, "GET", `/purchase_invoices/${id}`),
  };
}
