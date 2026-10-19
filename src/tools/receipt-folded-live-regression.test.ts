import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../bank-posting-duplicate-guard.js", () => ({ checkIntakeCashDuplicates: vi.fn().mockResolvedValue({ scan_available: true, suspects: [] }), formatDuplicatePostingWarnings: vi.fn().mockReturnValue([]) }));
import { logAudit } from "../audit-log.js";
import { PurchaseInvoicesApi, InvoiceCreationError } from "../api/purchase-invoices.api.js";
import { cache } from "../api/base-resource.js";
import { HttpError } from "../http-client.js";
import { createAndMaybeMatchPurchaseInvoice, prepareReceiptInvoiceItem } from "./receipt-inbox-booking.js";
import { draftReadbackMismatches, draftFingerprint } from "../documents/purchase-draft-verification.js";
import { sha256Hex } from "./receipt-inbox-files.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { withSignedCamtMarker } from "../__fixtures__/camt-marker.js";

const context: any = { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: false };
const suggestion: any = { source: "supplier_history", item: { cl_purchase_articles_id: 66, purchase_accounts_id: 7910, purchase_accounts_dimensions_id: 942283, amount: 1 } };
const supplier: any = { found: true, client: { id: 1702927, name: "Delfi Meedia AS" } };
const source = (net = 11.92, vat = 1.07, gross = 12.99): any => ({ supplier_name: supplier.client.name, invoice_number: "LIVE-REPLAY", invoice_date: "2026-10-19", ref_number: "12345", total_net: net, total_vat: vat, total_gross: gross, currency: "EUR" });
const snapshot: any = { file: { name: "receipt.pdf", path: "/tmp/receipt.pdf", extension: ".pdf", file_type: "pdf" }, bytes: Buffer.from("synthetic"), sha256: sha256Hex(Buffer.from("synthetic")) };
const amounts = [[11.92, 1.07, 12.99], [23.84, 2.15, 25.99]] as const;

// The null VAT/article/rate and gross-zero first GET reproduce recorded live
// 5555767/68. The PATCH arithmetic check is a strict local regression rule,
// NOT a recovered upstream validation message. Error detail below is synthetic.
function transport(gross: number, options: { rejectPatch?: boolean; rejectInvalidate?: boolean | "unknown" } = {}) {
  let stored: any; const writes: Array<{ path: string; body: any }> = []; const reads: any[] = [];
  const followUp = new HttpError("Synthetic totals rejection", 409, "PATCH", "/purchase_invoices/5555767", { upstream_detail: wrapUntrustedOcr("synthetic server detail") });
  const cleanup = new HttpError("Synthetic invalidation rejection", options.rejectInvalidate === "unknown" ? "network" : 409, "PATCH", "/purchase_invoices/5555767/invalidate");
  const normalize = (row: any) => ({ ...row, id: 10908706, total_net_price: row.total_net_price, base_total_net_price: row.total_net_price, unit_net_price: null, project_no_vat_gross_price: gross, cl_vat_articles_id: null, vat_accounts_id: null, vat_accounts_dimensions_id: null, vat_rate_dropdown: "-", vat_rate: null, vat_amount: null });
  const client: any = { cacheNamespace: `receipt-live-${Math.random()}`, connectionFingerprint: "receipt-live", apiBaseUrl: "https://fake.invalid",
    post: vi.fn(async (path: string, body: any) => { writes.push({ path, body: structuredClone(body) }); stored = { ...body, id: 5555767, status: "PROJECT", base_document_files_id: null, net_price: body.items[0].total_net_price, vat_price: 0, gross_price: 0, base_net_price: 0, base_vat_price: 0, base_gross_price: 0, currency_rate: 1, items: body.items.map(normalize), transactions: [], journals: [], settlements: [] }; return { created_object_id: 5555767 }; }),
    get: vi.fn(async (path: string) => { if (path.endsWith("/document_user")) return { name: "receipt.pdf", contents: snapshot.bytes.toString("base64") }; if (path === "/purchase_invoices") return { current_page: 1, total_pages: 1, items: [] }; const value = structuredClone(stored); reads.push(value); return value; }),
    request: vi.fn(async (path: string, init: any) => { writes.push({ path, body: structuredClone(init.body) }); stored.base_document_files_id = 9705134; return {}; }),
    patch: vi.fn(async (path: string, body: any) => {
      writes.push({ path, body: structuredClone(body) });
      if (path.endsWith("/invalidate")) { if (options.rejectInvalidate) throw cleanup; stored.status = "VOID"; return {}; }
      if (path.endsWith("/register")) { stored.status = "CONFIRMED"; return {}; }
      if (options.rejectPatch || body.vat_price !== 0 || body.gross_price !== body.items[0].total_net_price) throw followUp;
      stored = { ...stored, ...body, base_net_price: body.gross_price, base_vat_price: 0, base_gross_price: body.gross_price, items: body.items.map(normalize) }; return {};
    }),
  };
  const purchaseInvoices = new PurchaseInvoicesApi(client);
  const upload = vi.spyOn(purchaseInvoices, "uploadDocument");
  const api: any = { purchaseInvoices, journals: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() } };
  return { api, client, purchaseInvoices, writes, reads, followUp, cleanup, upload, read: () => structuredClone(stored), edit: (changes: object) => Object.assign(stored, changes) };
}
function bank(fake: ReturnType<typeof transport>, gross: number, onRead?: (nth: number) => void) {
  const tx = withSignedCamtMarker({ id: 14318373, status: "PROJECT", is_deleted: false, type: "C", clients_id: 1702927, accounts_dimensions_id: 942313, amount: gross, base_amount: gross, date: "2026-10-19", cl_currencies_id: "EUR", ref_number: "12345", bank_account_name: "Delfi Meedia AS" }, "DBIT");
  let nth = 0;
  fake.api.transactions = { invalidateListCache: vi.fn(), get: vi.fn(async () => { onRead?.(++nth); return structuredClone(tx); }), confirm: vi.fn().mockResolvedValue({}) };
  return [tx];
}
beforeEach(() => { cache.invalidate(); vi.clearAllMocks(); });

describe("recorded folded receipt representation", () => {
  it.each(amounts)("folds source %s + %s into cost %s without changing source", async (net, vat, gross) => {
    const extracted = source(net, vat, gross); const before = structuredClone(extracted);
    const prepared = prepareReceiptInvoiceItem(context, extracted, suggestion, "Expense");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("held");
    expect(prepared.item.total_net_price).toBe(gross);
    const fake = transport(gross);
    const result = await createAndMaybeMatchPurchaseInvoice(fake.api, { ...context, purchaseInvoices: [] }, snapshot, extracted, supplier, suggestion, bank(fake, gross), "create_and_confirm", false, new Set());
    expect(result.status).toBe("matched");
    expect(result.created_invoice?.confirmed).toBe(true);
    expect(fake.read()).toMatchObject({ net_price: gross, vat_price: 0, gross_price: gross, items: [{ total_net_price: gross, vat_amount: null, cl_vat_articles_id: null }] });
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(extracted).toEqual(before);
    expect(fake.writes.find(w => w.path === "/purchase_invoices")?.body.items[0].total_net_price).toBe(gross);
    expect(fake.api.transactions.confirm).toHaveBeenCalledWith(14318373, [{ related_table: "purchase_invoices", related_id: 5555767, amount: gross }], expect.any(Object));
  });
  it("a later material edit after initial draft verification blocks bank confirmation", async () => {
    const fake = transport(12.99);
    const tx = bank(fake, 12.99, nth => { if (nth === 3) fake.edit({ notes: "Changed after registration" }); });
    const result = await createAndMaybeMatchPurchaseInvoice(fake.api, { ...context, purchaseInvoices: [] }, snapshot, source(), supplier, suggestion, tx, "create_and_confirm", false, new Set());
    expect(result.status).toBe("needs_review"); expect(result.created_invoice?.confirmed).toBe(true);
    expect(fake.api.transactions.confirm).not.toHaveBeenCalled();
  });
  it("keeps zero VAT/zero gross valid", () => {
    const net = 0, vat = 0, gross = 0;
    const prepared = prepareReceiptInvoiceItem(context, source(net, vat, gross), suggestion, "Expense");
    expect(prepared.ok).toBe(true); if (prepared.ok) expect(prepared.item.total_net_price).toBe(gross);
  });
  it("keeps signed credit source on the existing review path", () => {
    const extracted = source(-11.92, -1.07, -12.99); const before = structuredClone(extracted);
    expect(prepareReceiptInvoiceItem(context, extracted, suggestion, "Credit").ok).toBe(false);
    expect(extracted).toEqual(before);
  });
  it("keeps registered VAT source net and rate", () => {
    const prepared = prepareReceiptInvoiceItem({ ...context, isVatRegistered: true }, source(), suggestion, "Expense");
    expect(prepared.ok).toBe(true); if (prepared.ok) expect(prepared.item).toMatchObject({ total_net_price: 11.92, vat_rate_dropdown: "9" });
  });
});

describe("strict live folded null equivalence", () => {
  const model: any = { clients_id: 1702927, number: "F-1", cl_currencies_id: "EUR", items: [{ purchase_accounts_id: 7910, purchase_accounts_dimensions_id: 942283, cl_vat_articles_id: 11, total_net_price: 12.99, amount: 1, vat_rate_dropdown: "-" }] };
  const draft: any = { ...model, id: 1, status: "PROJECT", net_price: 12.99, vat_price: 0, gross_price: 12.99, base_net_price: 12.99, base_vat_price: 0, base_gross_price: 12.99, items: [{ ...model.items[0], cl_fringe_benefits_id: 1, project_no_vat_gross_price: 12.99, base_total_net_price: 12.99, vat_amount: null, vat_rate: null, cl_vat_articles_id: null }] };
  const check = (value: any, expected = model, registered = false) => draftReadbackMismatches(value, expected, { vatPrice: 1.07, grossPrice: 12.99 }, registered);
  it("accepts the observed exact null normalization and fingerprints later edits", () => {
    expect(check(draft)).toEqual([]);
    expect(draftFingerprint(draft)).not.toBe(draftFingerprint({ ...draft, notes: "later edit" }));
  });
  it.each(["vat_amount", "vat_rate", "cl_vat_articles_id"])("missing/empty %s is not the observed null", field => {
    for (const absent of [undefined, ""]) { const changed = structuredClone(draft); changed.items[0][field] = absent; expect(check(changed).length).toBeGreaterThan(0); }
  });
  it.each([
    ["account", { purchase_accounts_id: 6000 }], ["dimension", { purchase_accounts_dimensions_id: 9 }],
    ["cost", { total_net_price: 11.92 }], ["override", { project_no_vat_gross_price: 13 }],
    ["VAT account", { vat_accounts_id: 7910 }], ["VAT dimension", { vat_accounts_dimensions_id: 942283 }],
    ["article", { cl_vat_articles_id: 1 }], ["rate", { vat_rate_dropdown: "9" }], ["amount", { amount: 2 }],
    ["VAT", { vat_amount: 1.07 }], ["extra", { unknown_posting_field: true }], ["base", { base_total_net_price: 13 }],
  ])("rejects %s drift", (_label, changes) => { const changed = structuredClone(draft); Object.assign(changed.items[0], changes); expect(check(changed).length).toBeGreaterThan(0); });
  it("does not waive header VAT/gross/currency or registered forms", () => {
    for (const changes of [{ vat_price: 1.07 }, { gross_price: 13 }, { cl_currencies_id: "USD" }]) expect(check({ ...draft, ...changes }).length).toBeGreaterThan(0);
    expect(check(draft, model, true).length).toBeGreaterThan(0);
  });
  it.each([
    { vat_accounts_id: 7910 }, { vat_accounts_dimensions_id: 942283 }, { total_net_price: 11.92 },
    { project_no_vat_gross_price: 13 }, { cl_vat_articles_id: 1 }, { vat_rate_dropdown: "9" },
    { vat_rate: 9 }, { vat_amount: 1.07 }, { reversed_vat_id: 1 },
  ])("does not waive a non-folded expected row %j", changes => {
    const changed = structuredClone(model); Object.assign(changed.items[0], changes);
    expect(check(draft, changed).length).toBeGreaterThan(0);
  });
});

describe("known receipt POST followed by failed totals", () => {
  it.each(amounts)("replays the original retained draft NET%s VAT%s GROSS%s", async (net, vat, gross) => {
    const fake = transport(gross, { rejectInvalidate: true });
    const error = await fake.purchaseInvoices.createAndSetTotals({ clients_id: 1702927, client_name: "Delfi Meedia AS", number: "ORIGINAL-FAILED", create_date: "2026-10-19", journal_date: "2026-10-19", liability_accounts_id: 2310, items: [{ ...suggestion.item, total_net_price: net, vat_rate_dropdown: "-", cl_vat_articles_id: 11 }] } as any, vat, gross, false).catch(e => e);
    expect(error).toBeInstanceOf(InvoiceCreationError);
    expect(fake.reads[0]).toMatchObject({ net_price: net, vat_price: 0, gross_price: 0, base_net_price: 0, base_vat_price: 0, base_gross_price: 0, items: [{ total_net_price: net, project_no_vat_gross_price: gross, vat_accounts_id: null, vat_rate_dropdown: "-", vat_rate: null, vat_amount: null, cl_vat_articles_id: null }] });
    expect(fake.writes.map(w => w.path)).toEqual(["/purchase_invoices", "/purchase_invoices/5555767", "/purchase_invoices/5555767/invalidate"]);
    expect(fake.read().status).toBe("PROJECT");
  });
  it.each([false, true])("retains typed cause and receipt recovery when invalidation fails=%s", async rejectInvalidate => {
    const fake = transport(12.99, { rejectPatch: true, rejectInvalidate });
    const result: any = await createAndMaybeMatchPurchaseInvoice(fake.api, { ...context, purchaseInvoices: [] }, snapshot, source(), supplier, suggestion, [], "create", false, new Set());
    expect(result).toMatchObject({ status: "failed", created_invoice: { id: 5555767, confirmed: false, uploaded_document: false }, creation_partial: { created_invoice_id: 5555767, mutation_occurred: true, automatic_retry_forbidden: true, cleanup: rejectInvalidate ? "failed" : "invalidated", follow_up: { status: 409, method: "PATCH" } } });
    expect(result.created_invoice.status).toBeUndefined();
    expect(fake.upload).not.toHaveBeenCalled();
    expect(fake.writes.some(w => w.path.endsWith("/register"))).toBe(false);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATED", entity_id: 5555767, details: expect.objectContaining({ cleanup: rejectInvalidate ? "failed" : "invalidated", follow_up_failed: true }) }));
    const direct = transport(12.99, { rejectPatch: true, rejectInvalidate });
    const error: any = await direct.purchaseInvoices.createAndSetTotals({ ...source(), clients_id: 1702927, client_name: "Delfi Meedia AS", number: "F-2", create_date: "2026-10-19", journal_date: "2026-10-19", liability_accounts_id: 2310, items: [{ ...suggestion.item, total_net_price: 12.99, vat_rate_dropdown: "-" }] } as any, 1.07, 12.99, false).catch(e => e);
    expect(error).toBeInstanceOf(InvoiceCreationError); expect(error.cause).toBe(direct.followUp);
    expect(error.cleanup).toBe(rejectInvalidate ? "failed" : "invalidated");
    if (rejectInvalidate) expect(error.cleanupError).toBe(direct.cleanup);
  });
  it("unknown POST commitment does not invent an invoice ID or repeat the POST", async () => {
    const fake = transport(12.99);
    fake.client.post.mockRejectedValue(new HttpError("Synthetic unknown POST", "network", "POST", "/purchase_invoices"));
    const result: any = await createAndMaybeMatchPurchaseInvoice(fake.api, { ...context, purchaseInvoices: [] }, snapshot, source(), supplier, suggestion, [], "create", false, new Set());
    expect(result.status).toBe("failed"); expect(result.created_invoice).toBeUndefined();
    expect(result.creation_partial).toMatchObject({ mutation_may_have_occurred: true, automatic_retry_forbidden: true, cleanup: "unknown", follow_up: { status: "network", method: "POST", path: "/purchase_invoices" } });
    expect(result.creation_partial.created_invoice_id).toBeUndefined();
    expect(fake.client.post).toHaveBeenCalledTimes(1); expect(fake.client.patch).not.toHaveBeenCalled(); expect(fake.upload).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "CREATED" }));
  });
  it("reports indeterminate invalidation as unknown and retains its underlying cause", async () => {
    const fake = transport(12.99, { rejectPatch: true, rejectInvalidate: "unknown" });
    const result: any = await createAndMaybeMatchPurchaseInvoice(fake.api, { ...context, purchaseInvoices: [] }, snapshot, source(), supplier, suggestion, [], "create", false, new Set());
    expect(result.creation_partial).toMatchObject({ created_invoice_id: 5555767, mutation_occurred: true, cleanup: "unknown", automatic_retry_forbidden: true, cleanup_error: { status: "network", method: "PATCH", path: "/purchase_invoices/5555767/invalidate" } });
    expect(fake.upload).not.toHaveBeenCalled();
  });
});
