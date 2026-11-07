import { describe, expect, it, vi } from "vitest";
import { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import type { HttpClient } from "../http-client.js";
import type { CreatePurchaseInvoiceData, PurchaseInvoice, PurchaseInvoiceItem } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { createAndMaybeMatchPurchaseInvoice } from "./receipt-inbox-booking.js";
import { sha256Hex } from "./receipt-inbox-files.js";
import type { ReceiptFileSnapshot, ReceiptProcessingContext } from "./receipt-inbox-types.js";
import type { BookingSuggestion, ExtractedReceiptFields } from "./receipt-extraction.js";
import type { SupplierResolution } from "./supplier-resolution.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../receipts/attachment-digest-store.js", () => ({ recordReceiptAttachmentDigest: vi.fn() }));
vi.mock("../bank-posting-duplicate-guard.js", () => ({
  checkIntakeCashDuplicates: vi.fn().mockResolvedValue({ scan_available: true, suspects: [] }),
  formatDuplicatePostingWarnings: vi.fn().mockReturnValue([]),
}));

const bytes = Buffer.from("synthetic reverse-charge receipt");
const snapshot: ReceiptFileSnapshot = {
  file: { name: "receipt.pdf", path: "/synthetic/receipt.pdf", extension: ".pdf", file_type: "pdf", size_bytes: bytes.length, modified_at: "2026-11-07T00:00:00Z" },
  relative_path: "receipt.pdf", snapshot_path: "/synthetic/snapshot.pdf", bytes, sha256: sha256Hex(bytes),
};

// Replay RC1's storage rule: an ordinary VAT account / positive dropdown makes
// the backend discard reversed_vat_id, even though the caller sent that flag.
function reverseChargeTransport() {
  let stored: PurchaseInvoice;
  const writes: Array<{ path: string; body: Partial<PurchaseInvoice> }> = [];
  const normalize = (row: PurchaseInvoiceItem): PurchaseInvoiceItem => {
    const rate = Number(row.vat_rate_dropdown);
    const reverse = row.vat_accounts_id == null && rate === 0;
    const net = row.total_net_price ?? 0;
    return {
      ...row, id: 1100, total_net_price: net, base_total_net_price: net,
      vat_rate: rate, vat_amount: net * rate / 100,
      reversed_vat_id: reverse ? row.reversed_vat_id : null,
    };
  };
  const client = {
    cacheNamespace: `rc1-${Math.random()}`, connectionFingerprint: "rc1", apiBaseUrl: "https://fake.invalid",
    post: vi.fn(async (path: string, body: CreatePurchaseInvoiceData) => {
      writes.push({ path, body: structuredClone(body) });
      stored = { ...body, id: 900, status: "PROJECT", base_document_files_id: null,
        net_price: 90, vat_price: 0, gross_price: 0, base_net_price: 90, base_vat_price: 0, base_gross_price: 0,
        currency_rate: 1, items: body.items.map(normalize) };
      return { created_object_id: 900 };
    }),
    get: vi.fn(async (path: string) => {
      if (path === "/purchase_invoices") return { current_page: 1, total_pages: 1, items: [] };
      if (path.endsWith("/document_user")) return { name: "receipt.pdf", contents: bytes.toString("base64") };
      return structuredClone(stored);
    }),
    request: vi.fn(async () => { stored.base_document_files_id = 100; return {}; }),
    patch: vi.fn(async (path: string, body: Partial<PurchaseInvoice>) => {
      writes.push({ path, body: structuredClone(body) });
      if (path.endsWith("/register")) { stored.status = "CONFIRMED"; return {}; }
      if (path.endsWith("/invalidate")) { stored.status = "VOID"; return {}; }
      stored = { ...stored, ...body, base_net_price: 90, base_vat_price: body.vat_price, base_gross_price: body.gross_price,
        items: body.items?.map(normalize) ?? stored.items };
      return {};
    }),
  };
  const api = {
    purchaseInvoices: new PurchaseInvoicesApi(client as unknown as HttpClient),
    journals: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
  } as unknown as ApiContext;
  return { api, writes, read: () => structuredClone(stored) };
}

describe("RC1 live reverse-charge receipt replay", () => {
  it("creates and confirms 90 EUR with the native zero-rate / null-account reverse-charge shape", async () => {
    const fake = reverseChargeTransport();
    const context: ReceiptProcessingContext = { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: true };
    const source: ExtractedReceiptFields = { supplier_name: "Synthetic Cloud", invoice_number: "RC1-90-EUR", invoice_date: "2026-11-07",
      total_net: 90, total_vat: 0, total_gross: 90, currency: "EUR" };
    const supplier = { found: true, created: false, client: { id: 7, name: "Synthetic Cloud" } } as SupplierResolution;
    const suggestion: BookingSuggestion = { source: "supplier_history", item: {
      custom_title: "Cloud service", purchase_accounts_id: 5230, cl_purchase_articles_id: 45,
      vat_rate_dropdown: "0", vat_accounts_id: null, cl_vat_articles_id: null, reversed_vat_id: 1,
    } };
    const result = await createAndMaybeMatchPurchaseInvoice(fake.api, context, snapshot, source, supplier, suggestion, [], "create_and_confirm", false, new Set());
    expect(result).toMatchObject({ status: "created", created_invoice: { id: 900, confirmed: true, uploaded_document: true } });
    expect(fake.writes.find(write => write.path === "/purchase_invoices")?.body.items?.[0]).toMatchObject({
      total_net_price: 90, vat_rate_dropdown: "0", vat_accounts_id: null, cl_vat_articles_id: null, reversed_vat_id: 1,
    });
    expect(fake.read()).toMatchObject({ status: "CONFIRMED", net_price: 90, vat_price: 0, gross_price: 90,
      items: [{ vat_rate_dropdown: "0", vat_accounts_id: null, cl_vat_articles_id: null, reversed_vat_id: 1 }] });
    expect(fake.writes.filter(write => write.path.endsWith("/register"))).toHaveLength(1);
  });
});
