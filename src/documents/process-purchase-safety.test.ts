import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../document-parser.js";
import { registerProcessAccountingDocumentTool } from "../guided/process-accounting-document.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseMcpResponse } from "../mcp-json.js";
import { fixtureAccount } from "../__fixtures__/accounting-workflow.js";
import { createAccountingDocumentOperations, ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN } from "./operations.js";
import { createReadingDocumentOperations } from "./reading-operations.js";
import { BASE_LINES, FIXTURE_NOW, HISTORY_DETAIL, HISTORY_INVOICE, packetFor, readingApi, readingFor, readingParse, served } from "../__fixtures__/document-reading/verified-draft.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FIXTURE_NOW); vi.mocked(parseDocument).mockResolvedValue(readingParse()); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function world(titles = ["Teenus"], dimensions?: number[], currentTitle?: string, dimensionField: "purchase_accounts_dimensions_id" | "vat_accounts_dimensions_id" = "purchase_accounts_dimensions_id") {
  const lines = currentTitle ? [...BASE_LINES, currentTitle] : BASE_LINES;
  vi.mocked(parseDocument).mockResolvedValue(readingParse(lines));
  const rows: any[] = titles.map((_, i) => ({ ...HISTORY_INVOICE, id: 501 + i, number: `H-${i}`, create_date: `2026-02-${20 - i}` }));
  const details: Record<number, any> = Object.fromEntries(rows.map((row, i) => [row.id,
    { ...HISTORY_DETAIL, ...row, items: [{ ...HISTORY_DETAIL.items[0], custom_title: titles[i], ...(dimensions ? { [dimensionField]: dimensions[i] } : {}) }] }]));
  let id = 900;
  let beforeCommit: () => Promise<void> = async () => {};
  const create = vi.fn(async (data: any, vat?: number, gross?: number) => {
    await beforeCommit();
    const draft = { ...data, id: id++, status: "PROJECT", vat_price: vat, gross_price: gross, ...served(data, vat, gross) };
    rows.push(draft); details[draft.id] = draft; return structuredClone(draft);
  });
  const api = readingApi({ createAndSetTotals: create });
  api.purchaseInvoices.listAll.mockImplementation(async () => structuredClone(rows));
  api.purchaseInvoices.get.mockImplementation(async (id: number) => structuredClone(details[id]));
  const confirm = vi.fn(async (id: number) => { details[id].status = "CONFIRMED"; return {}; });
  (api.purchaseInvoices as any).confirm = confirm;
  if (dimensions) {
    api.readonly.getAccounts.mockResolvedValue([
      fixtureAccount({ id: 5000, name_est: "Kulud objektide kaupa", allows_dimensions: dimensionField === "purchase_accounts_dimensions_id" }),
      fixtureAccount({ id: 1510, name_est: "Sisendkäibemaks", is_vat_account: true, allows_dimensions: dimensionField === "vat_accounts_dimensions_id" }),
    ]);
    api.readonly.getAccountDimensions.mockResolvedValue(dimensions.map(id => ({ id, accounts_id: dimensionField === "purchase_accounts_dimensions_id" ? 5000 : 1510, title_est: `Objekt ${id}`, is_deleted: false })));
  }
  const runtime = createTestRuntimeSafetyContext();
  const ops = createAccountingDocumentOperations(api, runtime);
  const readingOps = createReadingDocumentOperations(api, runtime);
  const server = { registerTool: vi.fn() } as any;
  registerProcessAccountingDocumentTool(server, api, runtime, { documentReading: true });
  const handler = server.registerTool.mock.calls.find(([name]: any[]) => name === "process_accounting_document")![2];
  const path = join(mkdtempSync(join(tmpdir(), "purchase-safety-")), "invoice.pdf");
  const bytes = "%PDF synthetic process regression"; writeFileSync(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { reading, proof } = readingFor(packetFor(sha256, lines));
  const call = async (args: any) => parseMcpResponse((await handler(args)).content[0].text) as any;
  const booking = {
    supplierClientId: 4242, invoiceNumber: "A-17", invoiceDate: "2026-03-15", journalDate: "2026-03-15", termDays: 0,
    items: [{ ...HISTORY_DETAIL.items[0], total_net_price: 100 }], vatPrice: 24, grossPrice: 124,
  };
  const prepare = async (extra: Record<string, unknown> = {}) => {
    const p = await ops.prepare({ source: { file_path: path }, booking: { ...booking, ...extra } });
    if (!p.ok || !p.value.planHandle) throw new Error(JSON.stringify(p));
    return p.value.planHandle;
  };
  const legacyCreate = (handle: string, extra: Record<string, unknown> = {}) => ops.create({ source: { file_path: path }, sourceSha256: sha256, planHandle: handle, ...booking, ...extra });
  const verify = (extra: Record<string, unknown> = {}) => call({ mode: "verify", file_path: path, document_reading: reading, proof, ...extra });
  return { api, runtime, ops, readingOps, path, sha256, reading, proof, call, booking, prepare, legacyCreate, verify, create, confirm, rows, details,
    blockCreate: (fn: () => Promise<void>) => { beforeCommit = fn; } };
}

describe("process M1: confirm is bound to the actual reviewed draft", () => {
  it.each([
    ["supplier", { clients_id: 9999 }], ["gross", { gross_price: 1240 }], ["currency", { cl_currencies_id: "USD" }],
    ["dimension", { liability_accounts_dimensions_id: 77 }], ["date", { journal_date: "2026-03-16" }],
    ["payment", { payment_type: "CASH" }], ["notes", { notes: "changed after approval two" }], ["unknown", { new_posting_field: 1 }],
    ["items", { items: [{ purchase_accounts_id: 5900, total_net_price: 1000 }] }],
  ])("rejects %s changed after explicit approval two", async (_, patch) => {
    const w = world();
    const created = await w.legacyCreate(await w.prepare());
    expect(created.ok).toBe(true);
    if (!created.ok || !created.value.confirmPlan) throw new Error(JSON.stringify(created));
    // Owner reviews the returned actual draft and approves confirmation here.
    Object.assign(w.details[900], patch);
    const result = await w.ops.confirmDraft({ invoiceId: 900, planHandle: created.value.confirmPlan.planHandle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("draft_changed");
    expect(w.confirm).not.toHaveBeenCalled();
  });

  it("unchanged actual draft confirms once", async () => {
    const w = world(); const created = await w.legacyCreate(await w.prepare());
    if (!created.ok || !created.value.confirmPlan) throw new Error(JSON.stringify(created));
    expect((await w.ops.confirmDraft({ invoiceId: 900, planHandle: created.value.confirmPlan.planHandle })).ok).toBe(true);
    expect(w.confirm).toHaveBeenCalledOnce();
  });

  it("readback failure preserves the created ID but issues no confirm handle", async () => {
    const w = world(); const handle = await w.prepare();
    const get = w.api.purchaseInvoices.get.getMockImplementation()! as (id: number) => Promise<unknown>;
    w.api.purchaseInvoices.get.mockImplementation(async (id: number) => { if (id === 900) throw new Error("unavailable"); return get(id); });
    const created = await w.legacyCreate(handle);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.createdInvoiceId).toBe(900);
    expect(created.value.confirmPlan).toBeUndefined();
    expect(created.value.draftReadbackUnavailable).toBe(true);
    expect(w.create).toHaveBeenCalledOnce();
  });

  it("an ID-only stale confirm handle cannot register", async () => {
    const w = world();
    w.details[900] = { id: 900, status: "PROJECT" };
    const handle = w.runtime.planStore.issue(ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN, { normalizedArgs: { invoice_id: 900 }, sourceIdentities: [], liveSnapshot: {}, commands: [], counts: {}, totals: {}, exclusions: [], reviews: [], privatePayload: {} });
    expect((await w.ops.confirmDraft({ invoiceId: 900, planHandle: handle })).ok).toBe(false);
    expect(w.confirm).not.toHaveBeenCalled();
  });

  it("a mismatching create readback preserves the draft ID without confirm authority", async () => {
    const w = world(); const handle = await w.prepare();
    const get = w.api.purchaseInvoices.get.getMockImplementation()! as (id: number) => Promise<Record<string, unknown>>;
    w.api.purchaseInvoices.get.mockImplementation(async (id: number) => {
      const row = await get(id);
      return id === 900 ? { ...row, gross_price: 1240 } : row;
    });
    const created = await w.legacyCreate(handle);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.createdInvoiceId).toBe(900);
    expect(created.value.confirmPlan).toBeUndefined();
    expect(created.value.readbackMismatch).toBeDefined();
    expect(w.create).toHaveBeenCalledOnce();
  });

  it("the final GET catches changes during a prerequisite lookup", async () => {
    const w = world(); const created = await w.legacyCreate(await w.prepare());
    if (!created.ok || !created.value.confirmPlan) throw new Error(JSON.stringify(created));
    w.api.readonly.getVatInfo.mockImplementation(async () => {
      w.details[900].notes = "changed while VAT registration lookup awaited";
      return { vat_number: "EE100000010" };
    });
    expect(await w.ops.confirmDraft({ invoiceId: 900, planHandle: created.value.confirmPlan.planHandle })).toMatchObject({ ok: false, error: { code: "draft_changed" } });
    expect(w.confirm).not.toHaveBeenCalled();
  });
});

describe("process M2: final duplicate scan and create share a FIFO", () => {
  it.each(["legacy", "reading", "reading-first", "other-instance"])("holds competing %s create after the first commits", async (secondPath) => {
    const w = world(); const first = await w.prepare();
    const second = secondPath === "legacy" ? await w.prepare() : (await w.verify()).plan_handle;
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const began = new Promise<void>(r => { entered = r; });
    w.blockCreate(async () => { entered(); await gate; });
    const a = secondPath === "reading-first" ? w.call({ mode: "create", file_path: w.path, plan_handle: second, owner_answers: {} }) : w.legacyCreate(first);
    await began;
    const b = secondPath === "legacy" ? w.legacyCreate(second)
      : secondPath === "reading-first" ? w.legacyCreate(first)
      : secondPath === "other-instance" ? createAccountingDocumentOperations(w.api, w.runtime).create({ source: { file_path: w.path }, sourceSha256: w.sha256, planHandle: await w.prepare(), ...w.booking })
      : w.call({ mode: "create", file_path: w.path, plan_handle: second, owner_answers: {} });
    // Keep the first POST pending while the independent second plan reaches its
    // write boundary; a missing shared FIFO lets both POSTs enter here.
    await new Promise(resolve => setTimeout(resolve, 50));
    const enteredWhileFirstPending = w.create.mock.calls.length;
    release();
    await Promise.all([a, b]);
    expect(enteredWhileFirstPending).toBe(1);
    expect(w.create).toHaveBeenCalledOnce();
    expect(w.rows.filter(r => r.number === "A-17")).toHaveLength(1);
  });

  it("explicit duplicate-number acknowledgement remains usable", async () => {
    const w = world();
    const extra = { allowDuplicateInvoiceNumber: true };
    const first = await w.prepare(extra); const second = await w.prepare(extra);
    expect((await w.legacyCreate(first, extra)).ok).toBe(true);
    expect((await w.legacyCreate(second, extra)).ok).toBe(true);
    expect(w.create).toHaveBeenCalledTimes(2);
  });
});

describe("process M8: history decisions survive verify and create", () => {
  it.each([false, true])("retains tax restrictions with explicit items=%s", async (explicit) => {
    const w = world(["Esinduskulu restoranis"], undefined, "Esinduskulu restoranis: koostööpartnerite vastuvõtt");
    const preview = await w.verify(explicit ? { items: w.booking.items } : {});
    expect(preview.status).toBe("ready");
    expect(preview.booking_review.decision_notes.tax_notes.map((n: any) => n.code)).toContain("KMS § 30");
    const created = await w.call({ mode: "create", file_path: w.path, plan_handle: preview.plan_handle, owner_answers: {} });
    expect(created.result.created_invoice_id).toBe(900);
    expect(w.create).toHaveBeenCalledOnce();
  });

  it.each(["purchase_accounts_dimensions_id", "vat_accounts_dimensions_id"] as const)("ambiguous %s history requires an explicit reviewed choice", async (field) => {
    const w = world(["Teenus", "Teenus"], [71, 72], undefined, field);
    const blocked = await w.verify();
    expect(blocked.status).toBe("blocked"); expect(blocked.plan_handle).toBeUndefined();
    expect(blocked.booking_review.decision_notes.dimension_notes[0]).toContain("ambiguous_dimension");
    expect(blocked.booking_items_required).toBe(true);
    expect(w.create).not.toHaveBeenCalled();
    expect(blocked.dimension_choice_required).toEqual([{ account_id: field === "purchase_accounts_dimensions_id" ? 5000 : 1510, dimension_field: field, dimension_ids: [71, 72] }]);
    expect(blocked.next_step).toContain("dimension_choice_required");
    const preview = await w.verify({ items: [{ ...w.booking.items[0], [field]: 72 }] });
    expect(preview.status).toBe("ready");
    expect(preview.booking_review.decision_notes.dimension_notes[0]).toContain("ambiguous_dimension");
    const created = await w.call({ mode: "create", file_path: w.path, plan_handle: preview.plan_handle, owner_answers: {} });
    expect(created.result.created_invoice_id).toBe(900);
    expect(w.create.mock.calls[0][0].items[0][field]).toBe(72);
    const confirmed = await w.call({ mode: "confirm", invoice_id: 900, plan_handle: created.confirm_plan.plan_handle });
    expect(confirmed.result.status).toBe("CONFIRMED");
    expect(w.confirm).toHaveBeenCalledOnce();
  });

  it("freshly introduced tax restriction invalidates old create approval", async () => {
    const w = world(); const preview = await w.verify();
    w.details[501].items[0].custom_title = "Esinduskulu restoranis";
    const held = await w.call({ mode: "create", file_path: w.path, plan_handle: preview.plan_handle, owner_answers: {} });
    expect(held.status).toBe("held");
    expect(held.holds.map((h: any) => h.code)).toContain("reading_booking_drift");
    expect(w.create).not.toHaveBeenCalled();
  });

  it.each(["item_title", "items"])("current %s detects restriction despite generic historical title", async (route) => {
    const w = world();
    const title = "Esinduskulu restoranis";
    const preview = await w.verify(route === "items" ? { items: [{ ...w.booking.items[0], custom_title: title }] } : { item_title: title });
    expect(preview.status).toBe("ready");
    expect(preview.booking_review.decision_notes.tax_notes.map((n: any) => n.code)).toContain("KMS § 30");
    expect((await w.call({ mode: "create", file_path: w.path, plan_handle: preview.plan_handle, owner_answers: {} })).result.created_invoice_id).toBe(900);
  });

  it.each([false, true])("partial supplier-history warning survives supplied-items=%s", async (explicit) => {
    const w = world(["Teenus", "Teenus"]);
    const get = w.api.purchaseInvoices.get.getMockImplementation()! as (id: number) => Promise<unknown>;
    w.api.purchaseInvoices.get.mockImplementation(async (id: number) => { if (id === 502) throw new Error("503"); return get(id); });
    const preview = await w.verify(explicit ? { items: w.booking.items } : {});
    expect(preview.status).toBe("ready");
    expect(preview.booking_review.decision_notes.history_notes[0]).toContain("supplier_history_partial");
    expect((await w.call({ mode: "create", file_path: w.path, plan_handle: preview.plan_handle, owner_answers: {} })).result.created_invoice_id).toBe(900);
  });

  it.each(["history", "dimension", "tax removal"])("fresh %s decision drift causes zero writes", async (change) => {
    const w = world(change === "tax removal" ? ["Esinduskulu restoranis"] : ["Teenus", "Teenus"]);
    const preview = await w.verify({ items: w.booking.items });
    if (change === "history") {
      const get = w.api.purchaseInvoices.get.getMockImplementation()! as (id: number) => Promise<unknown>;
      w.api.purchaseInvoices.get.mockImplementation(async (id: number) => { if (id === 502) throw new Error("503"); return get(id); });
    } else if (change === "dimension") {
      w.details[501].items[0].purchase_accounts_dimensions_id = 71;
      w.details[502].items[0].purchase_accounts_dimensions_id = 72;
    } else w.details[501].items[0].custom_title = "Teenus";
    const held = await w.call({ mode: "create", file_path: w.path, plan_handle: preview.plan_handle, owner_answers: {} });
    expect(held.status).toBe("held");
    expect(held.holds.map((h: any) => h.code)).toContain("reading_booking_drift");
    expect(w.create).not.toHaveBeenCalled();
  });
});
