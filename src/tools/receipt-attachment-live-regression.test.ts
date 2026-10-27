import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../bank-posting-duplicate-guard.js", () => ({ checkIntakeCashDuplicates: vi.fn().mockResolvedValue({ scan_available: true, suspects: [] }), formatDuplicatePostingWarnings: vi.fn().mockReturnValue([]) }));
import { receiptAttachmentTransport, type ReceiptTransportOptions } from "../__fixtures__/receipt-attachment-transport.js";
import { cache } from "../api/base-resource.js";
import { HttpError } from "../http-client.js";
import { PurchaseInvoiceDraftVerificationError, PurchaseInvoiceTotalsCorrectionError } from "../api/purchase-invoices.api.js";
import { createAndMaybeMatchPurchaseInvoice } from "./receipt-inbox-booking.js";
import { sha256Hex } from "./receipt-inbox-files.js";
import { draftFingerprint } from "../documents/purchase-draft-verification.js";

const bytes = Buffer.from("approved synthetic receipt bytes");
const snapshot: any = { file: { name: "receipt.pdf", path: "/tmp/receipt.pdf", extension: ".pdf", file_type: "pdf" }, bytes, sha256: sha256Hex(bytes) };
const positives: ReceiptTransportOptions[] = [
  { isVatRegistered: false, net: 11.92, vat: 1.07, gross: 12.99 },
  { isVatRegistered: false, net: 23.84, vat: 2.15, gross: 25.99 },
  { isVatRegistered: true, net: 12.10, vat: 2.90, gross: 15 },
  { isVatRegistered: true, net: 24.19, vat: 5.81, gross: 30 },
];
const run = (fake: ReturnType<typeof receiptAttachmentTransport>, bank = true) => createAndMaybeMatchPurchaseInvoice(fake.api, fake.context, snapshot, fake.source, fake.supplier as any, fake.suggestion as any, bank ? [fake.tx] : [], "create_and_confirm", false, new Set());
const downstream = (fake: ReturnType<typeof receiptAttachmentTransport>) => fake.calls.filter(c => c.method === "BANK_CONFIRM" || /\/(register|invalidate)$/.test(c.path));
beforeEach(() => { cache.invalidate(); vi.clearAllMocks(); });

describe("real attachment lifecycle and fresh receipt fingerprint", () => {
  it.each(positives)("accepts own upload for $isVatRegistered / $gross", async options => {
    const fake = receiptAttachmentTransport(options); const confirm = vi.spyOn(fake.api.purchaseInvoices, "confirmWithTotals");
    const result = await run(fake);
    expect(result.status).toBe("matched");
    expect(fake.read()).toMatchObject({ id: fake.id, status: "CONFIRMED", base_document_files_id: fake.fileId, net_price: options.isVatRegistered ? options.net : options.gross, vat_price: options.isVatRegistered ? options.vat : 0, gross_price: options.gross });
    const put = fake.calls.find(c => c.method === "PUT")!;
    expect(Buffer.from(put.body.contents, "base64")).toEqual(bytes);
    expect(fake.calls.filter(c => c.method === "GET" && c.path.endsWith("/document_user"))).toHaveLength(1);
    expect(confirm).toHaveBeenCalledWith(fake.id, options.isVatRegistered, { expectedDraftFingerprint: expect.any(String) });
    expect(fake.api.transactions.confirm).toHaveBeenCalledWith(fake.tx.id, [{ related_table: "purchase_invoices", related_id: fake.id, amount: options.gross }], expect.any(Object));
  });
  it.each([false, true])("verifies document and baseline without a bank candidate (VAT%s)", async isVatRegistered => {
    const fake = receiptAttachmentTransport(isVatRegistered ? positives[2]! : positives[0]!);
    expect((await run(fake, false)).status).toBe("created");
    expect(fake.calls.some(c => c.path.endsWith("/document_user") && c.method === "GET")).toBe(true);
    expect(fake.api.transactions.confirm).not.toHaveBeenCalled();
  });
  it("accepts the API ignoring the last-row residue (AI2 24.20 / 5.80 / 30): books with the document's VAT", async () => {
    // Live 2026-10-19 and 2026-10-28 (Tele2): a VAT-registered row drops the residue's project gross and keeps net × rate.
    const fake = receiptAttachmentTransport({ isVatRegistered: true, net: 24.20, vat: 5.80, gross: 30 });
    const confirm = vi.spyOn(fake.api.purchaseInvoices, "confirmWithTotals");
    const result = await run(fake);
    expect(result.status).toBe("matched");
    expect(fake.read()).toMatchObject({ status: "CONFIRMED", vat_price: 5.80 });
    expect(fake.read().items[0]).toMatchObject({ vat_amount: 5.81, project_no_vat_gross_price: null });
    expect(confirm).toHaveBeenCalledWith(fake.id, true, { expectedDraftFingerprint: expect.any(String) });
  });
  it("still holds a last-row VAT that is not exactly net × rate", async () => {
    const fake = receiptAttachmentTransport({ isVatRegistered: true, net: 24.20, vat: 5.80, gross: 30,
      onInvoiceGet: (row, nth) => nth >= 3 ? { ...row, items: [{ ...row.items[0], vat_amount: 5.82 }] } : row });
    const result = await run(fake);
    expect(result.status).toBe("needs_review"); expect(result.created_invoice?.id).toBe(fake.id);
    expect(result.notes.join(" ")).toContain("vat_amount");
    expect(downstream(fake)).toEqual([]);
  });
  it("still holds a header VAT that is not the document's", async () => {
    const fake = receiptAttachmentTransport({ isVatRegistered: true, net: 24.20, vat: 5.80, gross: 30,
      onInvoiceGet: row => ({ ...row, vat_price: 5.81 }) });
    const result = await run(fake);
    expect(result.status).toBe("needs_review"); expect(result.created_invoice?.id).toBe(fake.id);
    expect(result.notes.join(" ")).toContain("vat_price");
    expect(downstream(fake)).toEqual([]);
  });
});

describe("retained attachment or material verification holds", () => {
  const changes: Array<[string, Partial<ReceiptTransportOptions>]> = [
    ["wrong document", { onDocumentGet: file => ({ ...file, contents: Buffer.from("external document").toString("base64") }) }],
    ["malformed base64", { onDocumentGet: file => ({ ...file, contents: "@@@@" }) }],
    ["oversized base64", { onDocumentGet: file => ({ ...file, contents: "A".repeat(100000) }) }],
    ["document GET unavailable", { onDocumentGet: () => { throw new HttpError("Synthetic read failure", 503, "GET", "/purchase_invoices/5555769/document_user"); } }],
    ["metadata GET unavailable", { onInvoiceGet: (row, nth) => { if (nth === 3) throw new HttpError("Synthetic read failure", 503, "GET", "/purchase_invoices/5555769"); return row; } }],
    ["replacement during document read", { onDocumentGet: (file, row) => { row.base_document_files_id++; return file; } }],
    ["missing attachment", { onUpload: row => { row.base_document_files_id = null; } }],
    ["invalid attachment", { onUpload: row => { row.base_document_files_id = -1; } }],
    ["unknown-field drift during upload", { onUpload: row => { row.unknown_material_field = "changed"; } }],
    ["model-allowed metadata drift during upload", { onUpload: row => { row.is_xls_imported = true; } }],
    ["notes drift during upload", { onUpload: row => { row.notes = "external edit"; } }],
    ["row drift during upload", { onUpload: row => { row.items[0].purchase_accounts_dimensions_id++; } }],
    ["wrong invoice ID", { onInvoiceGet: (row, nth) => nth >= 3 ? { ...row, id: row.id + 1 } : row }],
    ["unexpected pre-upload attachment", { onInvoiceGet: (row, nth) => nth === 2 ? { ...row, base_document_files_id: 123 } : row }],
    ["unknown upload commitment", { uploadError: new HttpError("Synthetic PUT loss", "network", "PUT", "/purchase_invoices/5555769/document_user") }],
  ];
  it.each(changes)("holds %s without replay or cleanup", async (_label, change) => {
    const fake = receiptAttachmentTransport({ ...positives[0]!, ...change }); const result = await run(fake);
    expect(result.status).toBe("needs_review"); expect(result.created_invoice?.id).toBe(fake.id);
    expect(result.creation_partial).toMatchObject({ created_invoice_id: fake.id, mutation_occurred: true, automatic_retry_forbidden: true });
    expect(downstream(fake)).toEqual([]); expect(fake.calls.filter(c => c.method === "PUT")).toHaveLength(1);
    if (_label === "unknown upload commitment") expect(result.created_invoice?.uploaded_document).toBeUndefined();
  });
  it.each(["base_document_files_id", "notes"])("holds %s changed at final pre-register fingerprint", async field => {
    const fake = receiptAttachmentTransport({ ...positives[0]!, onInvoiceGet: (row, nth) => nth === 6 ? { ...row, [field]: field === "notes" ? "later" : 999 } : row });
    const result = await run(fake);
    expect(result.status).toBe("needs_review"); expect(result.created_invoice?.id).toBe(fake.id); expect(downstream(fake)).toEqual([]);
  });
  it("retains known invoice when non-VAT preflight GET fails before register", async () => {
    const failure = new HttpError("Synthetic preflight GET failure", 503, "GET", "/purchase_invoices/5555769");
    const fake = receiptAttachmentTransport({ ...positives[0]!, onInvoiceGet: (row, nth) => { if (nth === 5) throw failure; return row; } });
    const result = await run(fake);
    expect(result.status).toBe("needs_review"); expect(result.created_invoice?.id).toBe(fake.id);
    expect(result.creation_partial).toMatchObject({ automatic_retry_forbidden: true, follow_up: { status: 503, method: "GET", path: "/purchase_invoices/5555769" } }); expect(downstream(fake)).toEqual([]);
  });
  it("retains known invoice when non-VAT preflight form is unproven", async () => {
    const fake = receiptAttachmentTransport({ ...positives[0]!, onInvoiceGet: (row, nth) => { if (nth === 5) row.items[0].vat_accounts_id = 1510; return row; } });
    const result = await run(fake);
    expect(result.status).toBe("needs_review"); expect(result.created_invoice?.id).toBe(fake.id); expect(downstream(fake)).toEqual([]);
  });
});

describe("precise API pre-register failure classification", () => {
  it.each([false, true])("guarded=%s preserves the non-VAT GET error boundary", async guarded => {
    const failure = new HttpError("Synthetic non-VAT preflight GET", 503, "GET", "/purchase_invoices/5555769");
    const fake = receiptAttachmentTransport({ ...positives[0]!, onInvoiceGet: () => { throw failure; } });
    const error = await fake.api.purchaseInvoices.confirmWithTotals(fake.id, false, guarded ? { expectedDraftFingerprint: "expected" } : {}).catch((e: unknown) => e);
    if (guarded) { expect(error).toBeInstanceOf(PurchaseInvoiceDraftVerificationError); expect(error.cause).toBe(failure); }
    else expect(error).toBe(failure);
    expect(downstream(fake)).toEqual([]);
  });
  it("a genuine register rejection is not relabeled as preflight read failure", async () => {
    const failure = new HttpError("Synthetic register rejection", 409, "PATCH", "/purchase_invoices/5555771/register");
    const fake = receiptAttachmentTransport({ ...positives[2]!, registerError: failure });
    const result = await run(fake, false);
    expect(result.status).toBe("failed");
    expect(fake.calls.some(c => c.path.endsWith("/register"))).toBe(true);
    expect(fake.calls.some(c => c.path.endsWith("/invalidate"))).toBe(true);
  });
});
