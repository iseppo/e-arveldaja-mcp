import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../document-parser.js";
import { parseMcpResponse } from "../mcp-json.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { BASE_LINES, FIXTURE_NOW, packetFor, readingApi, readingFor, readingParse, SUPPLIER_ID } from "../__fixtures__/document-reading/verified-draft.js";
import { chart, COST_ACCOUNT, fakeEarveldaja, nonDeductibleItem, resetApiCaches } from "../__fixtures__/nondeductible-vat.js";
import { createReadingDocumentOperations, readingNonVatItems } from "./reading-operations.js";
import { createAccountingDocumentOperations } from "./operations.js";
import { registerPurchaseInvoiceTools } from "../tools/crud/purchase-invoices.js";
import { registerPdfWorkflowTools } from "../tools/pdf-workflow.js";

vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../logger.js", () => ({ log: vi.fn() }));

const dirs: string[] = [];
beforeEach(() => {
  resetApiCaches();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  vi.mocked(parseDocument).mockResolvedValue(readingParse(BASE_LINES));
});
afterEach(() => {
  vi.useRealTimers();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

function source() {
  const dir = mkdtempSync(join(tmpdir(), "nonvat-path-"));
  dirs.push(dir);
  const path = join(dir, "invoice.pdf");
  const bytes = "%PDF-1.4 synthetic invoice";
  writeFileSync(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function world() {
  const fake = fakeEarveldaja();
  const api = readingApi({ withHistory: false });
  // Keep unrelated company/client/ledger fixtures, but use the real API
  // classes over an HTTP double for every purchase write, readback and proof.
  Object.assign(api, { purchaseInvoices: fake.purchaseInvoices });
  api.readonly.getAccounts = fake.readonly.getAccounts.bind(fake.readonly) as never;
  api.readonly.getAccountDimensions = fake.readonly.getAccountDimensions.bind(fake.readonly) as never;
  api.readonly.getVatInfo = fake.readonly.getVatInfo.bind(fake.readonly) as never;
  api.readonly.getPurchaseArticles = fake.readonly.getPurchaseArticles.bind(fake.readonly) as never;
  const runtime = createTestRuntimeSafetyContext();
  return { fake, api, runtime };
}

const folded = () => ({ custom_title: "Teenus", cl_purchase_articles_id: 45, purchase_accounts_id: 6000, total_net_price: 100, amount: 1, cl_vat_articles_id: 11, vat_rate_dropdown: "-" });
const item = () => nonDeductibleItem({ total_net_price: 100, vat_rate_dropdown: "24" });
const booking = () => ({ supplierClientId: SUPPLIER_ID, invoiceNumber: "A-17", invoiceDate: "2026-03-15", journalDate: "2026-03-15", termDays: 0, items: [item()], vatPrice: 24, grossPrice: 124 });
const toolArgs = () => ({ clients_id: SUPPLIER_ID, client_name: "Näidis OÜ", number: "A-17", create_date: "2026-03-15", journal_date: "2026-03-15", term_days: 0, items: [item()], vat_price: 24, gross_price: 124 });

function handler(register: typeof registerPurchaseInvoiceTools | typeof registerPdfWorkflowTools, api: ReturnType<typeof world>["api"], name: string) {
  const server = { registerTool: vi.fn() };
  register(server as never, api as never);
  const call = server.registerTool.mock.calls.find(([key]) => key === name)!;
  return call[2] as (args: Record<string, unknown>) => Promise<any>;
}

describe("non-deductible VAT through real API entry points", () => {
  it("CRUD opts in, keeps the row, and PATCHes document VAT", async () => {
    const w = world();
    const result = await handler(registerPurchaseInvoiceTools, w.api, "create_purchase_invoice")(toolArgs());
    expect(result.isError).not.toBe(true);
    expect(w.fake.posts()).toHaveLength(1);
    expect(w.fake.posts()[0]!.body).toMatchObject({ items: [{ vat_accounts_id: COST_ACCOUNT, vat_rate_dropdown: "24" }] });
    expect(w.fake.totalsPatches()[0]!.body).toMatchObject({ vat_price: 24, gross_price: 124 });
  });

  it("creation refreshes a stale chart before any POST", async () => {
    const w = world();
    await w.fake.readonly.getAccounts();
    w.fake.state.accounts = chart({ costIsVatAccount: true });
    const result = await handler(registerPurchaseInvoiceTools, w.api, "create_purchase_invoice")(toolArgs());
    expect(result.isError).toBe(true);
    expect(w.fake.posts()).toEqual([]);
    expect(w.fake.accountReads()).toHaveLength(2);
  });

  it.each([true, false])("supplied-item updates hold when current invoice carries VAT=%s", async currentHasVat => {
    const w = world();
    const id = w.fake.seed({ ...toolArgs(), vat_price: currentHasVat ? 24 : 0, gross_price: 124 }, [currentHasVat ? item() : folded()]);
    const update = await handler(registerPurchaseInvoiceTools, w.api, "update_purchase_invoice")({ id, data: { items: [item()] } });
    expect(update.isError).toBe(true);
    expect(parseMcpResponse(update.content[0].text)).toMatchObject({ code: "nonvat_nondeductible_update_unsupported" });
    expect(w.fake.totalsPatches()).toEqual([]);
    if (currentHasVat) {
      const confirm = await handler(registerPurchaseInvoiceTools, w.api, "confirm_purchase_invoice")({ id });
      expect(confirm.isError).not.toBe(true);
      expect(w.fake.registers()).toHaveLength(1);
    }
  });

  it("header-only update preserves non-deductible rows and the confirm tool proves them", async () => {
    const w = world();
    const id = w.fake.seed({ ...toolArgs(), vat_price: 24, gross_price: 124 }, [item()]);
    const update = await handler(registerPurchaseInvoiceTools, w.api, "update_purchase_invoice")({ id, data: { notes: "Reviewed" } });
    expect(update.isError).not.toBe(true);
    expect(w.fake.totalsPatches()[0]!.body).toMatchObject({ items: [{ vat_accounts_id: COST_ACCOUNT, vat_rate_dropdown: "24" }] });
    const confirm = await handler(registerPurchaseInvoiceTools, w.api, "confirm_purchase_invoice")({ id });
    expect(confirm.isError).not.toBe(true);
    expect(w.fake.registers()).toHaveLength(1);
  });

  it("does not silently fold a non-deductible draft via supplied folded rows", async () => {
    const w = world();
    const id = w.fake.seed({ ...toolArgs(), vat_price: 24, gross_price: 124 }, [item()]);
    const result = await handler(registerPurchaseInvoiceTools, w.api, "update_purchase_invoice")({ id, data: { items: [folded()] } });
    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0].text)).toMatchObject({ code: "nonvat_nondeductible_update_unsupported" });
    expect(w.fake.writes()).toEqual([]);
  });

  it("the correction-preview tool proves against a fresh chart without changing totals", async () => {
    const w = world();
    const id = w.fake.seed({ ...toolArgs(), vat_price: 24, gross_price: 124 }, [item()]);
    const preview = handler(registerPurchaseInvoiceTools, w.api, "preview_purchase_invoice_totals_correction");
    const result = await preview({ id });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(parseMcpResponse(result.content[0].text))).toContain('"correction_required":false');
    w.fake.state.accounts = chart({ costIsVatAccount: true });
    expect((await preview({ id })).isError).toBe(true);
    expect(w.fake.writes()).toEqual([]);
    expect(w.fake.accountReads()).toHaveLength(2);
  });

  it.each([false, true])("verified reading creates a confirm handle; chart changed=%s is checked at register", async changed => {
    const w = world();
    const file = source();
    const ops = createReadingDocumentOperations(w.api, w.runtime);
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const verified = await ops.verify({ source: { file_path: file.path }, reading, proof, booking: { items: [folded()] } });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.planHandle, JSON.stringify(verified.value)).toBeTruthy();
    const created = await ops.create({ source: { file_path: file.path }, planHandle: verified.value.planHandle!, ownerAnswers: {} });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok || created.value.status !== "created") throw new Error(JSON.stringify(created));
    expect(created.value.confirmPlan).toBeTruthy();
    expect(w.fake.totalsPatches()[0]!.body).toMatchObject({ vat_price: 24 });
    if (changed) w.fake.state.accounts = w.fake.state.accounts.map(account => ({ ...account, is_vat_account: true }));
    const confirmed = await ops.confirm(created.value.confirmPlan!);
    expect(confirmed).toMatchObject(changed ? { ok: false, error: { code: "nonvat_form_unproven" } } : { ok: true, value: { status: "confirmed" } });
    expect(w.fake.registers()).toHaveLength(changed ? 0 : 1);
  });

  it("PDF create runs real preflight and keeps VAT on the cost account", async () => {
    const w = world();
    const file = source();
    const result = await handler(registerPdfWorkflowTools, w.api, "create_purchase_invoice_from_pdf")({
      supplier_client_id: SUPPLIER_ID, invoice_number: "A-17", invoice_date: "2026-03-15", journal_date: "2026-03-15",
      term_days: 0, items: [item()], vat_price: 24, gross_price: 124, file_path: file.path, source_sha256: file.sha256,
    });
    expect(result.isError, JSON.stringify(parseMcpResponse(result.content[0].text))).not.toBe(true);
    expect(w.fake.posts()).toHaveLength(1);
    expect(w.fake.totalsPatches()[0]!.body).toMatchObject({ vat_price: 24 });
  });

  it.each(["unchanged", "vat", "account"])("legacy prepare → create → confirm (%s)", async tamper => {
    const w = world();
    const file = source();
    const ops = createAccountingDocumentOperations(w.api, w.runtime);
    const prepared = await ops.prepare({ source: { file_path: file.path }, booking: booking() });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.planHandle, JSON.stringify(prepared.value)).toBeTruthy();
    const created = await ops.create({ source: { file_path: file.path }, sourceSha256: file.sha256, ...booking(), planHandle: prepared.value.planHandle! });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const plan = created.value.confirmPlan!;
    expect(plan).toBeTruthy();
    const draft = w.fake.state.invoices.get(plan.invoiceId)!;
    if (tamper === "vat") draft.vat_price = 0;
    if (tamper === "account") draft.items[0].vat_accounts_id = 1510;
    const confirmed = await ops.confirmDraft(plan);
    expect(confirmed).toMatchObject(tamper === "unchanged" ? { ok: true } : { ok: false, error: { code: "nonvat_form_unproven" } });
    expect(w.fake.registers()).toHaveLength(tamper === "unchanged" ? 1 : 0);
  });
});

describe("reading conversion refuses conflicting fields", () => {
  const values = { vat: 0 } as never;
  it.each([
    nonDeductibleItem({ vat_accounts_id: 1510 }),
    nonDeductibleItem({ cl_vat_articles_id: 1 }),
    nonDeductibleItem({ reversed_vat_id: 1 }),
  ])("does not fold an unsupported template %#", row => {
    expect(readingNonVatItems([row], values, "template")).toMatchObject({ ok: false, code: "reading_nonvat_item_conflict" });
  });
  it("does not silently fold a supplied positive rate on a no-VAT document", () => {
    expect(readingNonVatItems([{ ...folded(), vat_rate_dropdown: "24" }], values, "supplied"))
      .toMatchObject({ ok: false, code: "reading_nonvat_item_conflict" });
  });
  it("folds a proven non-deductible template for a document with no VAT", () => {
    const result = readingNonVatItems([item()], values, "template");
    expect(result).toMatchObject({ ok: true, nonDeductible: false, items: [{ cl_vat_articles_id: 11, vat_rate_dropdown: "-" }] });
    if (result.ok) expect((result.items as any[])[0]).not.toHaveProperty("vat_accounts_id");
  });
  const taxed = { net: 11.92, vat: 1.07, gross: 12.99, invoice_date: "2026-03-15" } as never;
  it.each(["template", "supplied"] as const)("converts folded %s at the document's rate and dimension", source => {
    const result = readingNonVatItems([{ ...folded(), purchase_accounts_id: COST_ACCOUNT, purchase_accounts_dimensions_id: 942283 }], taxed, source);
    expect(result).toMatchObject({ ok: true, nonDeductible: true, items: [{ vat_accounts_id: COST_ACCOUNT, vat_accounts_dimensions_id: 942283, vat_rate_dropdown: "9", cl_vat_articles_id: 11 }] });
  });
  it.each([
    { ...folded(), vat_rate_dropdown: "24" },
    nonDeductibleItem({ vat_accounts_id: 1510 }),
    { ...folded(), project_no_vat_gross_price: 12.99 },
  ])("holds conflicting supplied fields %# without rewriting", row => {
    const original = structuredClone(row);
    expect(readingNonVatItems([row], taxed, "supplied")).toMatchObject({ ok: false, code: "reading_nonvat_item_conflict" });
    expect(row).toEqual(original);
  });
  it.each([
    { net: 100, vat: 17, invoice_date: "2026-03-15" },
    { net: 0.01, vat: 0.01, invoice_date: "2026-03-15" },
    { net: 100, vat: 24, invoice_date: null },
  ])("holds an ambiguous or unsupported document VAT rate %#", amounts => {
    expect(readingNonVatItems([folded()], amounts as never, "supplied")).toMatchObject({ ok: false, code: "reading_vat_rate_ambiguous" });
  });
});
