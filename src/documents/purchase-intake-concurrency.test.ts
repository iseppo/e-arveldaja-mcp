import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../document-parser.js";
import { createAccountingDocumentOperations } from "./operations.js";
import { createReadingDocumentOperations } from "./reading-operations.js";
import { registerCreatePurchaseInvoiceFromPdfTool } from "../tools/pdf-workflow.js";
import { createAndMaybeMatchPurchaseInvoice } from "../tools/receipt-inbox-booking.js";
import { createClassificationOperations } from "../receipts/classification-operations.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { createAccountingWorkflowApi, fixtureAccount } from "../__fixtures__/accounting-workflow.js";
import { withSignedCamtMarker } from "../__fixtures__/camt-marker.js";
import { BASE_LINES, FIXTURE_NOW, HISTORY_DETAIL, HISTORY_INVOICE, ownClient, supplierClient, packetFor, readingFor, readingParse, served } from "../__fixtures__/document-reading/verified-draft.js";
import { parseMcpResponse, wrapUntrustedOcr } from "../mcp-json.js";
import * as purchaseLock from "./purchase-invoice-lock.js";
import { HttpError } from "../http-client.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));
const actualLock = purchaseLock.withPurchaseInvoiceLock;
let attempts = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FIXTURE_NOW); vi.mocked(parseDocument).mockResolvedValue(readingParse());
  attempts = 0;
  // Observe arrival only: every public writer still executes the real FIFO,
  // its complete callback and all fresh scans against shared API state.
  vi.spyOn(purchaseLock, "withPurchaseInvoiceLock").mockImplementation((api, run) => { attempts++; return actualLock(api, run); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

let sequence = 0;
function setup(number = "A-17", fingerprint = `cross-entry-${++sequence}`) {
  const supplier = { ...supplierClient(), name: "OpenAI Ireland Limited" };
  const accounts = [fixtureAccount({ id: 5000, name_est: "Software expense", name_eng: "Software expense" }), fixtureAccount({ id: 1510, name_est: "Sisendkäibemaks", is_vat_account: true })];
  const articles = [{ id: 1, name_est: "Software", name_eng: "Software", accounts_id: 5000, vat_accounts_id: 1510, cl_vat_articles_id: 1, is_disabled: false }];
  const rows: any[] = [{ ...HISTORY_INVOICE, payment_status: "PAID" }];
  const details: Record<number, any> = { 501: { ...HISTORY_DETAIL, client_name: supplier.name } };
  const tx = withSignedCamtMarker({ id: 42, status: "PROJECT", is_deleted: false, type: "C", amount: 124, date: "2026-03-15", accounts_dimensions_id: 100,
    bank_account_name: "OpenAI", clients_id: 4242, cl_currencies_id: "EUR", description: "OpenAI subscription" }, "DBIT");
  let beforePost = async () => {};
  const create = vi.fn(async (data: any, vat?: number, gross?: number) => {
    await beforePost();
    const draft = { ...data, id: 900 + rows.length, status: "PROJECT", vat_price: vat, gross_price: gross, ...served(data, vat, gross) };
    rows.push(draft); details[draft.id] = draft; return structuredClone(draft);
  });
  const apis: any[] = [];
  const makeApi = (scope = fingerprint) => {
    const api = createAccountingWorkflowApi({ allowWrites: true,
      clientRows: [ownClient(), supplier], accounts, purchaseArticles: articles,
      accountDimensions: [{ id: 100, accounts_id: 1020, is_deleted: false }],
      transactionRows: [tx], transactionDetails: { 42: tx },
      clients: { get: vi.fn().mockImplementation(async (id: number) => id === 4242 ? supplier : ownClient()) } as any,
      readonly: { getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE100000010" }), getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Ostja AS" }) },
      purchaseInvoices: { listAll: vi.fn().mockImplementation(async () => structuredClone(rows)),
        get: vi.fn().mockImplementation(async (id: number) => structuredClone(details[id])),
        createAndSetTotals: create, uploadDocument: vi.fn().mockResolvedValue({}),
        confirmWithTotals: vi.fn().mockImplementation(async (id: number) => { details[id].status = "CONFIRMED"; return {}; }) } as any,
    });
    Object.defineProperty(api.purchaseInvoices, "connectionFingerprint", { value: scope });
    apis.push(api); return api;
  };
  const api = makeApi();
  const dir = mkdtempSync(join(tmpdir(), "cross-entry-")); const path = join(dir, "invoice.pdf");
  const bytes = Buffer.from("%PDF-1.4 synthetic concurrency fixture"); writeFileSync(path, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const booking = { supplierClientId: 4242, invoiceNumber: number, invoiceDate: "2026-03-15", journalDate: "2026-03-15", termDays: 0,
    items: [{ ...HISTORY_DETAIL.items[0], total_net_price: 100 }], grossPrice: 124, vatPrice: 24 };
  const fields = { supplier_client_id: 4242, invoice_number: number, invoice_date: booking.invoiceDate, journal_date: booking.journalDate, term_days: 0, items: booking.items,
    vat_price: 24, gross_price: 124, file_path: path, source_sha256: sha };
  const prepareLegacy = async (target = api, changes: any = {}) => {
    const ops = createAccountingDocumentOperations(target, createTestRuntimeSafetyContext());
    const model = { ...booking, ...changes };
    const preview = await ops.prepare({ source: { file_path: path }, booking: model });
    if (!preview.ok || !preview.value.planHandle) throw new Error(JSON.stringify(preview));
    return () => ops.create({ source: { file_path: path }, sourceSha256: sha, ...model, planHandle: preview.value.planHandle });
  };
  const pdf = (target = api, changes: any = {}) => {
    const server = { registerTool: vi.fn() } as any;
    registerCreatePurchaseInvoiceFromPdfTool(server, target);
    const handler = server.registerTool.mock.calls.find(([name]: any[]) => name === "create_purchase_invoice_from_pdf")![2];
    return async () => parseMcpResponse((await handler({ ...fields, ...changes })).content[0].text);
  };
  const prepareReading = async (target = api) => {
    const ops = createReadingDocumentOperations(target, createTestRuntimeSafetyContext());
    const { reading, proof } = readingFor(packetFor(sha, BASE_LINES));
    const preview = await ops.verify({ source: { file_path: path }, reading, proof });
    if (!preview.ok || !preview.value.planHandle) throw new Error(JSON.stringify(preview));
    return () => ops.create({ source: { file_path: path }, ownerAnswers: {}, planHandle: preview.value.planHandle! });
  };
  const receipt = (target = api) => () => createAndMaybeMatchPurchaseInvoice(target,
    { clients: [supplier], purchaseInvoices: [], purchaseArticlesWithVat: articles, accounts, isVatRegistered: true } as any,
    { file: { name: "invoice.pdf", path, extension: ".pdf", file_type: "pdf", size_bytes: bytes.length, modified_at: "2026-03-15T00:00:00Z" }, relative_path: "invoice.pdf", sha256: sha, bytes, snapshot_path: path },
    { supplier_name: supplier.name, invoice_number: number, invoice_date: booking.invoiceDate, total_net: 100, total_vat: 24, total_gross: 124, currency: "EUR", description: "Subscription" },
    { found: true, created: false, match_type: "name_normalized", client: supplier },
    { source: "supplier_history", item: booking.items[0] } as any, [], "create", false, new Set());
  const prepareClassifier = async (target = api) => {
    const ops = createClassificationOperations(target, createTestRuntimeSafetyContext(), wrapUntrustedOcr);
    const classificationsJson = { groups: [{ category: "saas_subscriptions", apply_mode: "purchase_invoice", normalized_counterparty: "openai", display_counterparty: "OpenAI", recurring: true,
      similar_amounts: true, total_amount: 124, suggested_booking: { purchase_article_id: 1, purchase_account_id: 5000, liability_account_id: 2310, reason: "Recurring SaaS" }, reasons: ["keyword"], transactions: [tx] }] };
    const preview = await ops.applyClassifications({ classificationsJson });
    if (!preview.ok || !preview.value.planHandle) throw new Error(JSON.stringify(preview));
    return () => ops.applyClassifications({ classificationsJson, execute: true, planHandle: preview.value.planHandle });
  };
  return { api, makeApi, rows, create, apis, prepareLegacy, prepareReading, prepareClassifier, pdf, receipt,
    gate: (fn: () => Promise<void>) => { beforePost = fn; } };
}

async function compete(w: ReturnType<typeof setup>, first: () => Promise<any>, second: () => Promise<any>) {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const began = new Promise<void>(r => { entered = r; });
  w.gate(async () => { entered(); await gate; });
  const a = first();
  await Promise.race([began, a.then(result => { throw new Error(`First writer did not reach POST: ${JSON.stringify(result)}`); })]);
  const callsBeforeWait = w.apis.map(api => api.purchaseInvoices.invalidateListCache.mock.calls.length);
  const attemptsBeforeWait = attempts;
  const b = second();
  b.catch(() => {});
  await vi.waitFor(() => expect(attempts).toBeGreaterThan(attemptsBeforeWait));
  const postsWhileBlocked = w.create.mock.calls.length;
  release();
  const results = await Promise.all([a, b]);
  expect(postsWhileBlocked).toBe(1);
  expect(w.create).toHaveBeenCalledOnce();
  expect(w.rows.filter(row => row.status !== "CONFIRMED" || row.id !== 501)).toHaveLength(1);
  expect(w.apis.some((api, i) => api.purchaseInvoices.invalidateListCache.mock.calls.length > callsBeforeWait[i])).toBe(true);
  return results;
}

describe("actual automated purchase writers share one FIFO", () => {
  it.each([false, true])("legacy and PDF, PDF first=%s", async (pdfFirst) => {
    const w = setup(); const legacy = await w.prepareLegacy(); const pdf = w.pdf();
    await compete(w, pdfFirst ? pdf : legacy, pdfFirst ? legacy : pdf);
    expect(w.api.purchaseInvoices.uploadDocument).toHaveBeenCalledOnce();
  });
  it.each([false, true])("reading and receipt, receipt first=%s", async (receiptFirst) => {
    const w = setup(); const reading = await w.prepareReading(); const receipt = w.receipt();
    await compete(w, receiptFirst ? receipt : reading, receiptFirst ? reading : receipt);
    expect(w.api.purchaseInvoices.uploadDocument).toHaveBeenCalledOnce();
  });
  it.each([false, true])("legacy and classifier AUTO-TX, classifier first=%s", async (classifierFirst) => {
    const w = setup("AUTO-TX-42"); const legacy = await w.prepareLegacy(); const classification = await w.prepareClassifier();
    await compete(w, classifierFirst ? classification : legacy, classifierFirst ? legacy : classification);
  });
  it("separate API objects with the same credential fingerprint serialize", async () => {
    const w = setup(); const other = w.makeApi();
    await compete(w, await w.prepareLegacy(), w.pdf(other));
    expect(other).not.toBe(w.api);
  });
  it("different credential fingerprints can reach their POST concurrently", async () => {
    const w = setup(); const other = w.makeApi("independent-credential");
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    w.gate(async () => { await gate; });
    const legacy = await w.prepareLegacy(); const a = legacy(); const b = w.pdf(other)();
    await vi.waitFor(() => expect(w.create).toHaveBeenCalledTimes(2));
    release(); await Promise.all([a, b]);
  });
  it.each(["amount", "date", "currency"])("blank-number unrelated %s permits the next actual writer", async (difference) => {
    const w = setup("");
    const first = await w.prepareLegacy(); expect((await first()).ok).toBe(true);
    const changes: any = difference === "amount" ? { gross_price: 248, vat_price: 48, items: [{ ...HISTORY_DETAIL.items[0], total_net_price: 200 }] }
      : difference === "date" ? { invoice_date: "2026-04-15", journal_date: "2026-04-15" }
      : { currency: "USD", currency_rate: 1 };
    await w.pdf(w.api, changes)();
    expect(w.create).toHaveBeenCalledTimes(2);
  });
  it("blank-number same supplier/currency/amount/date holds despite number override", async () => {
    const w = setup(""); const first = await w.prepareLegacy(); await first();
    await w.pdf(w.api, { allow_duplicate_invoice_number: true })();
    expect(w.create).toHaveBeenCalledOnce();
    expect(w.api.purchaseInvoices.uploadDocument).toHaveBeenCalledOnce();
  });

  it.each(["legacy", "PDF"])("%s blank number refuses missing supplied gross even when item totals can predict it", async (route) => {
    for (const existing of [false, true]) {
      const w = setup("");
      if (existing) w.rows.push({ id: 700, clients_id: 4242, number: "", gross_price: 124, create_date: "2026-03-15", cl_currencies_id: "EUR", status: "PROJECT" });
      const result: any = route === "legacy"
        ? await (await w.prepareLegacy(w.api, { grossPrice: undefined }))()
        : await w.pdf(w.api, { gross_price: undefined })();
      expect(w.create).not.toHaveBeenCalled();
      expect(w.api.purchaseInvoices.uploadDocument).not.toHaveBeenCalled();
      if (route === "legacy") expect(result).toMatchObject({ ok: false, error: { code: "purchase_duplicate_comparison_required" } });
      else expect(result.category).toBe("purchase_duplicate_comparison_required");
    }
  });

  it.each(["legacy", "PDF"])("%s blank number refuses missing/malformed comparison dates", async (route) => {
    for (const date of [undefined, "", "2026-02-31", "2026-3-15"]) {
      const w = setup("");
      const result: any = route === "legacy"
        ? await (await w.prepareLegacy(w.api, { invoiceDate: date }))()
        : await w.pdf(w.api, { invoice_date: date })();
      expect(w.create).not.toHaveBeenCalled();
      expect(w.api.purchaseInvoices.uploadDocument).not.toHaveBeenCalled();
      if (route === "legacy") expect(result).toMatchObject({ ok: false, error: { code: "purchase_duplicate_comparison_required" } });
      else expect(result.error).toBeTruthy();
    }
  });

  it.each([false, true, "unknown"] as const)("receipt upload holds the queue through upload failure=%s", async (failUpload) => {
    const w = setup(); const reading = await w.prepareReading();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const began = new Promise<void>(r => { entered = r; });
    w.api.purchaseInvoices.uploadDocument.mockImplementation(async () => { entered(); await gate;
      if (failUpload) throw new HttpError("upload failed", failUpload === "unknown" ? "network" : 409, "PUT", "/purchase_invoices/555/document_user"); return {}; });
    w.api.purchaseInvoices.invalidate.mockImplementation(async (id: number) => { w.rows.find(row => row.id === id).status = "DELETED"; return {}; });
    const a = w.receipt()(); await began;
    const countBefore = w.api.purchaseInvoices.listAll.mock.calls.length;
    const attemptsBeforeWait = attempts;
    const b = reading();
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(attemptsBeforeWait));
    expect(w.create).toHaveBeenCalledOnce();
    expect(w.api.purchaseInvoices.listAll.mock.calls.length).toBe(countBefore);
    release(); const [receiptResult, readingResult] = await Promise.all([a, b]);
    expect(receiptResult.status).toBe(failUpload === "unknown" ? "needs_review" : failUpload ? "failed" : "created");
    expect(readingResult).toMatchObject({ ok: true, value: { status: "held" } });
    expect(w.create).toHaveBeenCalledOnce();
    expect(w.api.purchaseInvoices.invalidate).toHaveBeenCalledTimes(failUpload === true ? 1 : 0);
    if (failUpload === "unknown") expect(receiptResult.creation_partial).toMatchObject({ automatic_retry_forbidden: true, mutation_occurred: true });
  });
});
