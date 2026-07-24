import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../document-parser.js";
import { createAccountingWorkflowApi, fixtureAccount, fixtureClient } from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { createAccountingDocumentOperations, ACCOUNTING_DOCUMENT_PLAN_DOMAIN, ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN } from "./operations.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));

const mockedParseDocument = vi.mocked(parseDocument);

// Real Estonian registry code with a valid exact-match key used by the fixtures.
const REG_CODE = "17487472";

function docWithRegCode(): Awaited<ReturnType<typeof parseDocument>> {
  const text = ["ACME OÜ", "Reg. nr 17487472", "Arve INV-1", "Summa 12.00 EUR"].join("\n");
  return {
    text,
    pageCount: 1,
    ocrPartialFailure: false,
    result: {
      pages: [{
        pageNum: 1,
        textItems: [
          { text: "ACME OÜ", x: 10, y: 10, width: 60, height: 10, confidence: 0.95 },
          { text: "Reg. nr 17487472", x: 10, y: 30, width: 90, height: 10, confidence: 0.93 },
        ],
      }],
    },
  } as unknown as Awaited<ReturnType<typeof parseDocument>>;
}

function docPlain(): Awaited<ReturnType<typeof parseDocument>> {
  return {
    text: "Some Vendor\nInvoice INV-9\nTotal 20.00 EUR",
    pageCount: 1,
    ocrPartialFailure: false,
    result: { pages: [{ pageNum: 1, textItems: [{ text: "Some Vendor", x: 0, y: 0, width: 50, height: 10, confidence: 0.9 }] }] },
  } as unknown as Awaited<ReturnType<typeof parseDocument>>;
}

const tempDirs: string[] = [];
function writeTempPdf(contents = "%PDF-1.4 fixture"): { path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "doc-op-test-"));
  tempDirs.push(dir);
  const path = join(dir, "invoice.pdf");
  writeFileSync(path, contents);
  return { path, sha256: createHash("sha256").update(Buffer.from(contents)).digest("hex") };
}

function setup(options: Parameters<typeof createAccountingWorkflowApi>[0] = {}) {
  const runtime = createTestRuntimeSafetyContext();
  const api = createAccountingWorkflowApi(options);
  const ops = createAccountingDocumentOperations(api, runtime);
  return { runtime, api, ops };
}

afterEach(() => { vi.clearAllMocks(); });
beforeEach(() => { mockedParseDocument.mockResolvedValue(docWithRegCode()); });

describe("AccountingDocumentOperations.prepare", () => {
  it("returns a compact preview that carries NO raw OCR text and a plan handle", async () => {
    const { path } = writeTempPdf();
    const { ops } = setup({ clientRows: [], purchaseInvoiceRows: [] });
    const outcome = await ops.prepare({ source: { file_path: path } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const preview = outcome.value;
    // Compact preview omits raw_text entirely.
    expect("raw_text" in preview.extraction.fields).toBe(false);
    expect(typeof preview.planHandle).toBe("string");
    expect(preview.planHandle.length).toBeGreaterThan(0);
    expect(preview.extraction.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.extraction.page_count).toBe(1);
  });

  it("resolves a unique supplier silently by registry code — NO technical id demanded", async () => {
    const { path } = writeTempPdf();
    const supplier = fixtureClient({ id: 4242, name: "ACME OÜ", code: REG_CODE, is_supplier: true });
    const { ops } = setup({ clientRows: [supplier], purchaseInvoiceRows: [], clients: { get: vi.fn().mockResolvedValue(supplier) } });
    const outcome = await ops.prepare({ source: { file_path: path } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.supplierResolution.status).toBe("resolved");
    if (outcome.value.supplierResolution.status !== "resolved") return;
    expect(outcome.value.supplierResolution.value.client.id).toBe(4242);
    // A resolved supplier surfaces proposedBooking (suggest_booking core).
    expect(outcome.value.proposedBooking).toBeDefined();
  });

  it("surfaces a tied supplier name as ambiguous, never guessing a match", async () => {
    mockedParseDocument.mockResolvedValue(docPlain());
    const { path } = writeTempPdf();
    // Two active clients whose normalized name equals the extracted name.
    const a = fixtureClient({ id: 1, name: "Some Vendor", is_supplier: true });
    const b = fixtureClient({ id: 2, name: "Some Vendor", is_supplier: true });
    const { ops } = setup({ clientRows: [a, b], purchaseInvoiceRows: [] });
    const outcome = await ops.prepare({ source: { file_path: path } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Tie → not resolved (ambiguous or not_found); never a picked value.
    expect(outcome.value.supplierResolution.status).not.toBe("resolved");
    expect(outcome.value.proposedBooking).toBeUndefined();
  });

  it("blocks a self-match when the extracted registry code is the active company's own", async () => {
    const { path } = writeTempPdf();
    // Own company carries REG_CODE; extraction would match self → ambiguous block.
    const ownClient = fixtureClient({ id: 99, name: "ACME OÜ", code: REG_CODE, is_supplier: true });
    const api = createAccountingWorkflowApi({ clientRows: [ownClient], purchaseInvoiceRows: [] });
    api.readonly.getInvoiceInfo = vi.fn().mockResolvedValue({ invoice_company_name: "ACME OÜ", reg_no: REG_CODE });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createAccountingDocumentOperations(api, runtime);
    const outcome = await ops.prepare({ source: { file_path: path } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.supplierResolution.status).not.toBe("resolved");
  });

  it("flags an ambiguous historical dimension as a compact warning (never copies one forward)", async () => {
    const { path } = writeTempPdf();
    const supplier = fixtureClient({ id: 4242, name: "ACME OÜ", code: REG_CODE, is_supplier: true });
    const rows = [
      { id: 10, clients_id: 4242, number: "A", status: "CONFIRMED", create_date: "2026-02-10" },
      { id: 11, clients_id: 4242, number: "B", status: "CONFIRMED", create_date: "2026-02-11" },
    ];
    const details: Record<number, unknown> = {
      10: { id: 10, number: "A", create_date: "2026-02-10", items: [{ custom_title: "svc", purchase_accounts_id: 5000, purchase_accounts_dimensions_id: 100 }] },
      11: { id: 11, number: "B", create_date: "2026-02-11", items: [{ custom_title: "svc", purchase_accounts_id: 5000, purchase_accounts_dimensions_id: 200 }] },
    };
    const { ops } = setup({ clientRows: [supplier], purchaseInvoiceRows: rows, purchaseInvoiceDetails: details, clients: { get: vi.fn().mockResolvedValue(supplier) } });
    const outcome = await ops.prepare({ source: { file_path: path } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.proposedBooking?.dimension_notes.length).toBeGreaterThan(0);
    expect(outcome.value.warnings.some(w => w.code === "ambiguous_dimension")).toBe(true);
  });
});

describe("AccountingDocumentOperations.create", () => {
  const supplier = () => fixtureClient({ id: 4242, name: "ACME OÜ", code: REG_CODE, is_supplier: true });

  function createSetup() {
    const { path, sha256 } = writeTempPdf();
    const api = createAccountingWorkflowApi({
      clientRows: [supplier()],
      accounts: [
        fixtureAccount({ id: 5000, name_est: "Teenused" }),
        fixtureAccount({ id: 1510, name_est: "Sisendkäibemaks", is_vat_account: true }),
      ],
      clients: { get: vi.fn().mockResolvedValue(supplier()) },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        createAndSetTotals: vi.fn().mockResolvedValue({ id: 90_001, status: "SAVED" }),
        confirmWithTotals: vi.fn(),
        invalidate: vi.fn().mockResolvedValue({}),
        uploadDocument: vi.fn().mockResolvedValue({}),
      },
    });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createAccountingDocumentOperations(api, runtime);
    return { path, sha256, api, runtime, ops };
  }

  const baseCreateInput = (path: string, sha256: string) => ({
    source: { file_path: path },
    planHandle: undefined,
    sourceSha256: sha256,
    supplierClientId: 4242,
    invoiceNumber: "INV-1",
    invoiceDate: "2026-06-15",
    journalDate: "2026-06-15",
    termDays: 14,
    items: [{ custom_title: "Teenus", cl_purchase_articles_id: 1, purchase_accounts_id: 5000, total_net_price: 10 }],
    vatPrice: 2,
    grossPrice: 12,
  });

  // create now REQUIRES a plan_handle from a prior mode='prepare'. Mint a valid
  // in-scope handle so success-path tests reach the booking logic.
  const mintDocHandle = (runtime: ReturnType<typeof createTestRuntimeSafetyContext>, sha256: string) =>
    runtime.planStore.issue(ACCOUNTING_DOCUMENT_PLAN_DOMAIN, {
      normalizedArgs: { source_sha256: sha256 },
      sourceIdentities: [], liveSnapshot: {},
      commands: [{ id: "c", category: "purchase_invoice_create" }],
      counts: {}, totals: {}, exclusions: [], reviews: [], privatePayload: {},
    });

  it("creates a DRAFT invoice, uploads the document, and mints a SECOND confirm plan (never auto-confirmed)", async () => {
    const { path, sha256, api, runtime, ops } = createSetup();
    const outcome = await ops.create({ ...baseCreateInput(path, sha256), planHandle: mintDocHandle(runtime, sha256) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.createdInvoiceId).toBe(90_001);
    expect(outcome.value.documentUploaded).toBe(true);
    expect(api.purchaseInvoices.uploadDocument).toHaveBeenCalledTimes(1);
    // NEVER auto-confirms/registers — the op stops at DRAFT + a fresh confirm plan.
    expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
    expect(outcome.value.confirmPlan).toBeDefined();
    expect(outcome.value.confirmPlan?.invoiceId).toBe(90_001);
    expect(typeof outcome.value.confirmPlan?.planHandle).toBe("string");
  });

  it("desandboxes sandbox markers out of the invoiceData written to the API (write-boundary canonicalization)", async () => {
    const { path, sha256, api, runtime, ops } = createSetup();
    const wrap = (s: string) => wrapUntrustedOcr(s)!;
    const outcome = await ops.create({
      ...baseCreateInput(path, sha256),
      planHandle: mintDocHandle(runtime, sha256),
      invoiceNumber: wrap("INV-1"),
      refNumber: wrap("REF-9"),
      bankAccountNo: wrap("EE001122"),
      notes: wrap("hello notes"),
    });
    expect(outcome.ok).toBe(true);
    const invoiceData = (api.purchaseInvoices.createAndSetTotals as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    // The values written to e-arveldaja are the desandboxed plain text — no marker persists.
    expect(invoiceData.number).toBe("INV-1");
    expect(invoiceData.bank_ref_number).toBe("REF-9");
    expect(invoiceData.bank_account_no).toBe("EE001122");
    expect(invoiceData.notes).toBe("hello notes");
    for (const key of ["number", "bank_ref_number", "bank_account_no", "notes"]) {
      expect(String(invoiceData[key])).not.toContain("UNTRUSTED_OCR_START");
    }
  });

  it("carries structured duplicateScan + duplicateCandidate on the execution (no leaky formatted warning string)", async () => {
    const { path, sha256, runtime, ops } = createSetup();
    const outcome = await ops.create({ ...baseCreateInput(path, sha256), planHandle: mintDocHandle(runtime, sha256) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const execution = outcome.value as unknown as Record<string, unknown>;
    // Structured, UNWRAPPED domain data — the façade formats + wraps it.
    expect(execution.duplicateScan).toBeDefined();
    expect(Array.isArray((execution.duplicateScan as { suspects?: unknown }).suspects)).toBe(true);
    expect(execution.duplicateCandidate).toBeDefined();
    expect((execution.duplicateCandidate as { direction?: string }).direction).toBe("C");
    // No pre-formatted warning-string field embedding a (possibly raw) journal title.
    expect("warnings" in execution).toBe(false);
  });

  it("rejects a digest mismatch BEFORE any mutation (snapshot binding)", async () => {
    const { path, api, runtime, ops } = createSetup();
    const outcome = await ops.create({ ...baseCreateInput(path, "0".repeat(64)), planHandle: mintDocHandle(runtime, "0".repeat(64)) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("digest_mismatch");
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("requires a plan_handle for create — a create with no prepared handle is refused before any mutation", async () => {
    const { path, sha256, api, ops } = createSetup();
    const outcome = await ops.create(baseCreateInput(path, sha256)); // planHandle: undefined
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_handle_required");
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.uploadDocument).not.toHaveBeenCalled();
  });

  it("requires a well-formed source_sha256", async () => {
    const { path, ops } = createSetup();
    const outcome = await ops.create({ ...baseCreateInput(path, "not-a-hash") });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("source_sha256_required");
  });

  it("consumes the reviewed plan once — a replayed plan handle fails", async () => {
    const { path, sha256, runtime, ops } = createSetup();
    // Mint a plan under the accounting-document domain, then consume it via create.
    const handle = runtime.planStore.issue(ACCOUNTING_DOCUMENT_PLAN_DOMAIN, {
      normalizedArgs: { source_sha256: sha256 },
      sourceIdentities: [],
      liveSnapshot: {},
      commands: [{ id: "c", category: "purchase_invoice_create" }],
      counts: {}, totals: {}, exclusions: [], reviews: [], privatePayload: {},
    });
    const first = await ops.create({ ...baseCreateInput(path, sha256), planHandle: handle });
    expect(first.ok).toBe(true);
    const replay = await ops.create({ ...baseCreateInput(path, sha256), planHandle: handle });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toMatch(/plan_handle_consumed|plan_handle_invalid/);
  });
});

describe("AccountingDocumentOperations.confirmDraft", () => {
  function confirmSetup() {
    const api = createAccountingWorkflowApi({
      clientRows: [],
      purchaseInvoiceRows: [],
      purchaseInvoices: {
        confirm: vi.fn().mockResolvedValue({ code: 0, messages: [] }),
      },
    });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createAccountingDocumentOperations(api, runtime);
    return { api, runtime, ops };
  }

  // Mint the confirm plan exactly as operations.create mints it after a create
  // (ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN, normalizedArgs { invoice_id }).
  function mintConfirmPlan(runtime: ReturnType<typeof createTestRuntimeSafetyContext>, invoiceId: number) {
    return runtime.planStore.issue(ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN, {
      normalizedArgs: { invoice_id: invoiceId },
      sourceIdentities: [],
      liveSnapshot: { invoice_id: invoiceId },
      commands: [{ id: "accounting-document-confirm", category: "purchase_invoice_confirm", reviewProjection: { invoice_id: invoiceId } }],
      counts: {}, totals: {}, exclusions: [], reviews: [], privatePayload: { invoice_id: invoiceId },
    });
  }

  it("confirms the reviewed invoice via the register API and returns a compact mutation result", async () => {
    const { api, runtime, ops } = confirmSetup();
    const handle = mintConfirmPlan(runtime, 90_001);
    const outcome = await ops.confirmDraft({ planHandle: handle, invoiceId: 90_001 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.purchaseInvoices.confirm).toHaveBeenCalledWith(90_001);
    expect(outcome.value.confirmedInvoiceId).toBe(90_001);
    expect(outcome.value.status).toBe("CONFIRMED");
    expect(outcome.value.mutationOccurred).toBe(true);
  });

  it("consumes the confirm handle once — a replayed handle fails (mirrors the create replay guard)", async () => {
    const { runtime, ops } = confirmSetup();
    const handle = mintConfirmPlan(runtime, 90_001);
    const first = await ops.confirmDraft({ planHandle: handle, invoiceId: 90_001 });
    expect(first.ok).toBe(true);
    const replay = await ops.confirmDraft({ planHandle: handle, invoiceId: 90_001 });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toMatch(/plan_handle_consumed|plan_handle_invalid/);
  });

  it("fails plan_drift with NO API call when the invoice_id differs from the reviewed handle", async () => {
    const { api, runtime, ops } = confirmSetup();
    const handle = mintConfirmPlan(runtime, 90_001);
    const outcome = await ops.confirmDraft({ planHandle: handle, invoiceId: 90_002 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(api.purchaseInvoices.confirm).not.toHaveBeenCalled();
  });

  it("fails closed when no plan_handle is supplied (the handle is not approval)", async () => {
    const { api, ops } = confirmSetup();
    const outcome = await ops.confirmDraft({ planHandle: undefined, invoiceId: 90_001 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(api.purchaseInvoices.confirm).not.toHaveBeenCalled();
  });

  it("echoes the registered invoice's supplier name + gross read back after confirm (confirm receipt)", async () => {
    const api = createAccountingWorkflowApi({
      clientRows: [],
      purchaseInvoiceRows: [],
      purchaseInvoices: {
        confirm: vi.fn().mockResolvedValue({ code: 0, messages: [] }),
        get: vi.fn().mockResolvedValue({ client_name: "Acme OÜ", gross_price: 100, cl_currencies_id: "USD", base_gross_price: 92.5 }),
      },
    });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createAccountingDocumentOperations(api, runtime);
    const handle = mintConfirmPlan(runtime, 90_001);
    const outcome = await ops.confirmDraft({ planHandle: handle, invoiceId: 90_001 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.purchaseInvoices.get).toHaveBeenCalledWith(90_001);
    expect(outcome.value.echoedSupplierName).toBe("Acme OÜ");
    expect(outcome.value.echoedGross).toBe(100);
    expect(outcome.value.echoedCurrency).toBe("USD");
    expect(outcome.value.echoedBaseGross).toBe(92.5);
  });

  it("degrades to an id-only receipt (fail-safe) when the post-register read-back fails — registration is NOT rolled back", async () => {
    const api = createAccountingWorkflowApi({
      clientRows: [],
      purchaseInvoiceRows: [],
      purchaseInvoices: {
        confirm: vi.fn().mockResolvedValue({ code: 0, messages: [] }),
        get: vi.fn().mockRejectedValue(new Error("read-back unavailable")),
      },
    });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createAccountingDocumentOperations(api, runtime);
    const handle = mintConfirmPlan(runtime, 90_001);
    const outcome = await ops.confirmDraft({ planHandle: handle, invoiceId: 90_001 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.purchaseInvoices.confirm).toHaveBeenCalledWith(90_001);
    expect(outcome.value.confirmedInvoiceId).toBe(90_001);
    expect(outcome.value.mutationOccurred).toBe(true);
    expect(outcome.value.echoedSupplierName).toBeUndefined();
    expect(outcome.value.echoedGross).toBeUndefined();
    expect(outcome.value.echoedCurrency).toBeUndefined();
    expect(outcome.value.echoedBaseGross).toBeUndefined();
  });
});
