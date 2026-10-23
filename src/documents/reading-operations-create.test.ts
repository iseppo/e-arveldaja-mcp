// P2 D3: reading-domain create and confirm (plan §5.2 step 3, §5.2a, §5.5).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../document-parser.js";
import { logAudit } from "../audit-log.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";
import { bookingDrift, createReadingDocumentOperations, draftReadbackMismatches, itemTitleHasDate, READING_CONFIRM_DOMAIN } from "./reading-operations.js";
import { WRONG_COMPANY_SIGNALS } from "./operations.js";
import {
  BASE_LINES, FIXTURE_NOW, HISTORY_DETAIL, HISTORY_INVOICE, packetFor, readingApi, readingFor, readingParse, SUPPLIER_ID, type ReadingCaseInput,
  served,
} from "../__fixtures__/document-reading/verified-draft.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));
const mockedParse = vi.mocked(parseDocument);

const LINES_A18 = BASE_LINES.map((line) => line.replace("A-17", "A-18"));
/** Another document of the supplier: another number and a date 14 days earlier (no §3.6 match with A-17). */
const LINES_B = LINES_A18.map((line) => line.replace("15.03.2026", "01.03.2026"));
/** A number strong enough for the journal-reference scan (6+ characters with a digit). */
const LINES_STRONG = BASE_LINES.map((line) => line.replace("A-17", "INV-202617"));
const STRONG: ReadingCaseInput = { values: { invoice_number: "INV-202617" }, evidence: { invoice_number: { line: "p1:001", quote: "Arve nr INV-202617" } } };

function writePdf(contents: string): { path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "reading-create-"));
  const path = join(dir, "invoice.pdf");
  writeFileSync(path, contents);
  return { path, sha256: createHash("sha256").update(Buffer.from(contents)).digest("hex") };
}

/** A small in-memory e-arveldaja: creates become live drafts that the uncached scans see. */
function world() {
  const rows: Array<Record<string, unknown>> = [HISTORY_INVOICE];
  const details: Record<number, Record<string, unknown>> = { [HISTORY_INVOICE.id]: HISTORY_DETAIL };
  let nextId = 900;
  const commit = (data: Record<string, unknown>, vat?: number, gross?: number) => {
    const id = nextId++;
    const draft = { ...data, id, status: "PROJECT", vat_price: vat, gross_price: gross, ...served(data, vat, gross) };
    rows.push(draft);
    details[id] = draft;
    return id;
  };
  // The POST takes a moment, so an unserialised second create would scan before the first commits.
  const createAndSetTotals = vi.fn(async (data: Record<string, unknown>, vat?: number, gross?: number) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { id: commit(data, vat, gross) };
  });
  const api = readingApi({ createAndSetTotals });
  // A list cache like the real one: a stale list until invalidateListCache drops it.
  let cached: Array<Record<string, unknown>> | undefined;
  api.purchaseInvoices.listAll.mockImplementation(async () => (cached ??= rows.map((row) => ({ ...row }))));
  api.purchaseInvoices.invalidateListCache.mockImplementation(() => { cached = undefined; });
  api.purchaseInvoices.get.mockImplementation(async (id: number) => {
    const detail = details[id];
    if (!detail) throw new Error(`Missing purchase invoice ${id}`);
    return { ...detail };
  });
  const confirm = vi.fn(async (id: number) => { details[id]!.status = "CONFIRMED"; return {}; });
  (api.purchaseInvoices as Record<string, unknown>).confirm = confirm;
  const runtime = createTestRuntimeSafetyContext();
  const ops = createReadingDocumentOperations(api, runtime);
  return { api, runtime, ops, rows, details, commit, createAndSetTotals, confirm };
}

type World = ReturnType<typeof world>;

async function verified(w: World, file: { path: string; sha256: string }, input: ReadingCaseInput = {}, lines = BASE_LINES) {
  const { reading, proof } = readingFor(packetFor(file.sha256, lines), input);
  const outcome = await w.ops.verify({ source: { file_path: file.path }, reading, proof });
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value;
}

async function create(w: World, file: { path: string }, planHandle: string, ownerAnswers: unknown = {}) {
  return w.ops.create({ source: { file_path: file.path }, planHandle, ownerAnswers });
}

const heldCodes = (outcome: Awaited<ReturnType<typeof create>>) => {
  if (!outcome.ok) throw new Error(`expected held, got failure ${outcome.error.code}`);
  if (outcome.value.status !== "held") throw new Error("expected held, got created");
  return outcome.value.holds.map((hold) => hold.code);
};

const BUYERLESS: ReadingCaseInput = { values: { buyer_name: null, buyer_reg: null }, evidence: { buyer_name: undefined, buyer_reg: undefined } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  mockedParse.mockImplementation(async (path: string) => {
    const contents = readFileSync(path, "utf8");
    return readingParse(contents.includes("B-DOC") ? LINES_B : contents.includes("A-18") ? LINES_A18 : contents.includes("STRONG") ? LINES_STRONG : BASE_LINES);
  });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("reading create", () => {
  it("a clean reading creates one draft, uploads the document, audits the reading path and binds a confirm handle", async () => {
    const w = world();
    const file = writePdf("%PDF clean A-17");
    const verify = await verified(w, file);
    const outcome = await create(w, file, verify.planHandle!);
    if (!outcome.ok || outcome.value.status !== "created") throw new Error(JSON.stringify(outcome));
    expect(w.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(w.createAndSetTotals.mock.calls[0]![0]).toMatchObject({ clients_id: SUPPLIER_ID, number: "A-17", create_date: "2026-03-15" });
    expect(w.api.purchaseInvoices.uploadDocument).toHaveBeenCalledTimes(1);
    expect(outcome.value.correctedFields).toEqual([]);
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(expect.objectContaining({
      action: "CREATED",
      details: expect.objectContaining({ reading_path: true, corrected_fields: [], buyer_attested_by_owner: false, text_layer_typed: false, source_sha256: file.sha256 }),
    }));
    expect(w.runtime.planStore.inspect(outcome.value.confirmPlan!.planHandle, READING_CONFIRM_DOMAIN).domain).toBe(READING_CONFIRM_DOMAIN);
  });

  it("a create handle is consume-once", async () => {
    const w = world();
    const file = writePdf("%PDF replay");
    const verify = await verified(w, file);
    await create(w, file, verify.planHandle!);
    const replay = await create(w, file, verify.planHandle!);
    expect(replay.ok).toBe(false);
    expect(w.createAndSetTotals).toHaveBeenCalledTimes(1);
  });

  it("a missing answer or a 'no' on the company-expense question writes nothing", async () => {
    const w = world();
    const file = writePdf("%PDF buyerless");
    const missing = await create(w, file, (await verified(w, file, BUYERLESS)).planHandle!, {});
    expect(missing).toMatchObject({ ok: false, error: { code: "owner_answer_missing" } });
    const declined = await create(w, file, (await verified(w, file, BUYERLESS)).planHandle!, { buyer: { choice: "no" } });
    expect(declined).toMatchObject({ ok: false, error: { code: "owner_declined" } });
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("a 'yes' on the company-expense question creates, audited as buyer_attested_by_owner with the company reg code", async () => {
    const w = world();
    const file = writePdf("%PDF buyerless yes");
    const outcome = await create(w, file, (await verified(w, file, BUYERLESS)).planHandle!, { buyer: { choice: "yes" } });
    expect(outcome).toMatchObject({ ok: true, value: { status: "created" } });
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ buyer_attested_by_owner: true, buyer_attested_company_reg: "10000024" }),
    }));
  });

  it("a company identity change after the company-expense answer is buyer_attestation_mismatch, 0 writes", async () => {
    const w = world();
    const file = writePdf("%PDF buyerless switch");
    const verify = await verified(w, file, BUYERLESS);
    w.api.readonly.getVatInfo.mockResolvedValue({ vat_number: "EE100000007" });
    const outcome = await create(w, file, verify.planHandle!, { buyer: { choice: "yes" } });
    expect(outcome).toMatchObject({ ok: false, error: { code: "buyer_attestation_mismatch" } });
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("a connection switch between verify and create refuses, 0 writes", async () => {
    const w = world();
    const file = writePdf("%PDF switch");
    const verify = await verified(w, file);
    w.runtime.setScope({ connectionIndex: 1, connectionFingerprint: "other-fingerprint", connectionName: "other" });
    const outcome = await create(w, file, verify.planHandle!);
    expect(outcome).toMatchObject({ ok: false, error: { code: "plan_scope_mismatch" } });
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("an owner-typed gross re-runs the arithmetic: a gross that does not close holds, 0 writes", async () => {
    const w = world();
    const file = writePdf("%PDF typed gross");
    const verify = await verified(w, file, { evidence: { gross: { line: "p1:007", quote: "Kokku 124,00" } } });
    expect(verify.card!.rows.map((row) => row.id)).toEqual(["r:gross"]);
    const outcome = await create(w, file, verify.planHandle!, { "r:gross": { value: 125 } });
    expect(heldCodes(outcome)).toContain("arithmetic_mismatch");
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("owner-typed amounts re-run every duplicate scan: an existing invoice of the supplier ±0.02 / ±7 days holds, 0 writes", async () => {
    const w = world();
    w.rows.push({ id: 610, clients_id: SUPPLIER_ID, client_name: "Näidis OÜ", number: "B-9", create_date: "2026-03-14", gross_price: 62.01, status: "CONFIRMED" });
    const file = writePdf("%PDF typed trio");
    const verify = await verified(w, file, {
      evidence: {
        net: { line: "p1:005", quote: "Summa 100,00" },
        vat: { line: "p1:006", quote: "KM 24,00" },
        gross: { line: "p1:007", quote: "Kokku 124,00" },
      },
    });
    expect(verify.status).toBe("ready");
    const outcome = await create(w, file, verify.planHandle!, { "r:net": { value: 50 }, "r:vat": { value: 12 }, "r:gross": { value: 62 } });
    const codes = heldCodes(outcome);
    expect(codes).toContain("duplicate_same_amount_date");
    // The reviewed booking showed 124: owner-typed amounts are never booked without a new review.
    expect(codes).toContain("reading_booking_drift");
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("a journal reference to the number booked between verify and create holds; an unavailable scan holds too (fail closed)", async () => {
    const w = world();
    const file = writePdf("%PDF journal ref STRONG");
    const first = await verified(w, file, STRONG, LINES_STRONG);
    expect(first.status).toBe("ready");
    w.api.journals.listAll.mockResolvedValue([{ id: 77, document_number: "ETR1:INV-202617", title: "ettemaks", is_deleted: false }]);
    expect(heldCodes(await create(w, file, first.planHandle!))).toContain("journal_reference_hit");
    w.api.journals.listAll.mockResolvedValue([]);
    const second = await verified(w, file, STRONG, LINES_STRONG);
    w.api.journals.listAll.mockRejectedValue(new Error("journals down"));
    expect(heldCodes(await create(w, file, second.planHandle!))).toContain("journal_reference_scan_unavailable");
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("an invoice booked elsewhere after verify is seen at create (list caches dropped), 0 writes", async () => {
    const w = world();
    const file = writePdf("%PDF booked elsewhere");
    const verify = await verified(w, file);
    w.rows.push({ id: 612, clients_id: SUPPLIER_ID, client_name: "Näidis OÜ", number: "A-17", create_date: "2026-03-15", gross_price: 124, status: "PROJECT" });
    expect(heldCodes(await create(w, file, verify.planHandle!))).toContain("duplicate_supplier_number");
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("an owner-typed date re-runs the date window, 0 writes", async () => {
    const w = world();
    const file = writePdf("%PDF typed date");
    const verify = await verified(w, file, { evidence: { invoice_date: { line: "p1:004", quote: "Kpv 15.03.2026" } } });
    expect(verify.card!.rows.map((row) => row.id)).toEqual(["r:invoice_date"]);
    expect(heldCodes(await create(w, file, verify.planHandle!, { "r:invoice_date": { value: "2026-05-01" } }))).toEqual(["invoice_date_out_of_window"]);
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("a booking that changed after review (here the supplier's live name) holds reading_booking_drift, 0 writes", async () => {
    const w = world();
    const file = writePdf("%PDF drift");
    const verify = await verified(w, file);
    w.api.clients.get.mockImplementation(async (id: number) => ({ ...(await readingApi().clients.get(id)), name: "Teine Nimi OÜ" }));
    expect(heldCodes(await create(w, file, verify.planHandle!))).toEqual(["reading_booking_drift"]);
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("an owner-typed invoice number may change only the number in the reviewed booking: it creates", async () => {
    const w = world();
    const file = writePdf("%PDF typed number");
    const verify = await verified(w, file, { evidence: { invoice_number: { line: "p1:001", quote: "Arve A-17" } } });
    expect(verify.card!.rows.map((row) => row.id)).toEqual(["r:invoice_number"]);
    const outcome = await create(w, file, verify.planHandle!, { "r:invoice_number": { value: "A-17/1" } });
    expect(outcome).toMatchObject({ ok: true, value: { status: "created", correctedFields: ["invoice_number"] } });
    expect(w.createAndSetTotals.mock.calls[0]![0]).toMatchObject({ number: "A-17/1" });
  });

  it("a reading without a gross is never given a create handle (no booking review exists)", async () => {
    const w = world();
    const file = writePdf("%PDF no gross");
    // A page with no amounts at all: the only amount hold is the typed gross row.
    const lines = [...BASE_LINES.slice(0, 4), "Valuuta EUR"];
    mockedParse.mockResolvedValue(readingParse(lines));
    const verify = await verified(w, file, {
      values: { net: null, vat: null, gross: null },
      evidence: { net: undefined, vat: undefined, gross: undefined, currency: { line: "p1:005", quote: "Valuuta EUR" } },
      labels: { gross: null },
    }, lines);
    expect(verify.status).toBe("blocked");
    expect(verify.holds).toEqual([{ code: "required_field_missing", field: "gross" }]);
    expect(verify.planHandle).toBeUndefined();
  });

  it("a draft read back after create that differs from the approved model gets no confirm handle", async () => {
    const w = world();
    const file = writePdf("%PDF readback");
    const verify = await verified(w, file);
    w.createAndSetTotals.mockImplementationOnce(async (data: Record<string, unknown>, vat?: number, gross?: number) =>
      ({ id: w.commit({ ...data, number: "NOT-APPROVED", paid_in_cash: true, cash_accounts_id: 1000 }, vat, gross) }));
    const outcome = await create(w, file, verify.planHandle!);
    if (!outcome.ok || outcome.value.status !== "created") throw new Error(JSON.stringify(outcome));
    expect(outcome.value.confirmPlan).toBeUndefined();
    expect(outcome.value.readbackMismatch).toEqual(expect.arrayContaining(["number", "paid_in_cash", "cash_accounts_id"]));
  });

  it.each([
    ["an item purchase dimension", (data: Record<string, any>) => ({ ...data, items: [{ ...data.items[0], purchase_accounts_dimensions_id: 999 }] }), "items[0].purchase_accounts_dimensions_id"],
    ["an item VAT dimension", (data: Record<string, any>) => ({ ...data, items: [{ ...data.items[0], vat_accounts_dimensions_id: 998 }] }), "items[0].vat_accounts_dimensions_id"],
    ["a liability dimension", (data: Record<string, any>) => ({ ...data, liability_accounts_dimensions_id: 997 }), "liability_accounts_dimensions_id"],
    ["an unexpected IBAN", (data: Record<string, any>) => ({ ...data, bank_account_no: "EE382200221020145685" }), "bank_account_no"],
    ["an extra item", (data: Record<string, any>) => ({ ...data, items: [...data.items, { ...data.items[0], custom_title: "extra" }] }), "items"],
    ["swapped item order", (data: Record<string, any>) => ({ ...data, items: [{ ...data.items[0], custom_title: "other" }] }), "items[0].custom_title"],
    ["a brand-new header field", (data: Record<string, any>) => ({ ...data, a_field_added_later: "x" }), "a_field_added_later"],
    ["a brand-new item field", (data: Record<string, any>) => ({ ...data, items: [{ ...data.items[0], an_item_field_added_later: 7 }] }), "items[0].an_item_field_added_later"],
    ["a reallocated item gross", (data: Record<string, any>) => ({ ...data, items: [{ ...data.items[0], project_no_vat_gross_price: 99 }] }), "items[0].project_no_vat_gross_price"],
  ])("a readback that adds %s the approved model lacks gets no confirm handle", async (_name, mutate, field) => {
    const w = world();
    const file = writePdf("%PDF readback probe");
    const verify = await verified(w, file);
    w.createAndSetTotals.mockImplementationOnce(async (data: Record<string, unknown>, vat?: number, gross?: number) =>
      ({ id: w.commit(mutate(data), vat, gross) }));
    const outcome = await create(w, file, verify.planHandle!);
    if (!outcome.ok || outcome.value.status !== "created") throw new Error(JSON.stringify(outcome));
    expect(outcome.value.confirmPlan).toBeUndefined();
    expect(outcome.value.readbackMismatch).toContain(field);
  });

  it("a readback with the API's own defaults for absent fields still gets a confirm handle", async () => {
    const w = world();
    const file = writePdf("%PDF readback defaults");
    const verify = await verified(w, file);
    w.createAndSetTotals.mockImplementationOnce(async (data: Record<string, any>, vat?: number, gross?: number) => ({ id: w.commit({
      ...data, currency_rate: 1, paid_in_cash: false, liability_accounts_dimensions_id: null, bank_ref_number: "", overdue_charge: 0,
      net_price: 100, base_net_price: 100, base_vat_price: vat, base_gross_price: gross,
      items: data.items.map((item: Record<string, unknown>) => ({ ...item, purchase_accounts_dimensions_id: null, vat_accounts_dimensions_id: null })),
    }, vat, gross) }));
    const outcome = await create(w, file, verify.planHandle!);
    if (!outcome.ok || outcome.value.status !== "created") throw new Error(JSON.stringify(outcome));
    expect(outcome.value.readbackMismatch).toBeUndefined();
    expect(outcome.value.confirmPlan).toBeDefined();
  });

  it("a wrong-company signal on the document holds at create, 0 writes", async () => {
    const w = world();
    const file = writePdf("%PDF wrong company");
    const verify = await verified(w, file);
    w.api.readonly.getInvoiceInfo.mockResolvedValue({ invoice_company_name: "Hoopis Muu OÜ" });
    const outcome = await create(w, file, verify.planHandle!);
    expect(heldCodes(outcome).filter((code) => (WRONG_COMPANY_SIGNALS as readonly string[]).includes(code))).toHaveLength(1);
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });
});

describe("reading create serialisation (§5.2a)", () => {
  it("two handles for the same file in parallel give exactly one write", async () => {
    const w = world();
    const file = writePdf("%PDF parallel");
    const [a, b] = [await verified(w, file), await verified(w, file)];
    const results = await Promise.all([create(w, file, a.planHandle!), create(w, file, b.planHandle!)]);
    expect(w.createAndSetTotals).toHaveBeenCalledTimes(1);
    const held = results.find((result) => result.ok && result.value.status === "held")!;
    expect(heldCodes(held)).toContain("duplicate_supplier_number");
  });

  it("two files with the same supplier, amount and date in parallel give one write and one duplicate hold", async () => {
    const w = world();
    const fileA = writePdf("%PDF A-17");
    const fileB = writePdf("%PDF A-18");
    const a = await verified(w, fileA);
    const b = await verified(w, fileB, {
      values: { invoice_number: "A-18" },
      evidence: { invoice_number: { line: "p1:001", quote: "Arve nr A-18" } },
    }, LINES_A18);
    expect(b.status).toBe("ready");
    const results = await Promise.all([create(w, fileA, a.planHandle!), create(w, fileB, b.planHandle!)]);
    expect(w.createAndSetTotals).toHaveBeenCalledTimes(1);
    const held = results.find((result) => result.ok && result.value.status === "held")!;
    expect(heldCodes(held)).toContain("duplicate_same_amount_date");
  });

  it("a POST timeout leaves a marker: matching documents hold until the owner releases it, and a late commit is then found", async () => {
    const w = world();
    const file = writePdf("%PDF timeout");
    const first = await verified(w, file);
    const queued = await verified(w, file);
    let lateDraft: Record<string, unknown> | undefined;
    w.createAndSetTotals.mockImplementationOnce(async (data: Record<string, unknown>) => {
      lateDraft = data;
      throw new MutationIndeterminateError({
        operation: "create", entity: "purchase_invoice", businessKey: "A-17", affectedCaches: [], cause: new Error("socket timeout"), nextAction: "re-read",
      });
    });
    const timedOut = await create(w, file, first.planHandle!);
    expect(timedOut).toMatchObject({ ok: false, error: { code: "reading_create_indeterminate" } });

    // A handle issued before the timeout holds inside the lock.
    expect(heldCodes(await create(w, file, queued.planHandle!))).toEqual(["reading_create_indeterminate"]);
    // verify on an empty scan keeps the hold and names the marker: no handle.
    const retry = await verified(w, file);
    expect(retry.status).toBe("blocked");
    expect(retry.holds.map((hold) => hold.code)).toEqual(["reading_create_indeterminate"]);
    expect(retry.indeterminateMarker).toEqual(expect.any(String));
    expect(retry.planHandle).toBeUndefined();

    // POST1 commits late. Without a release the marker still holds.
    w.commit(lateDraft!, 24, 124);
    const stillHeld = await verified(w, file);
    expect(stillHeld.holds.map((hold) => hold.code)).toContain("reading_create_indeterminate");
    expect(stillHeld.planHandle).toBeUndefined();

    // The owner releases the marker: the releasing call issues no handle.
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const released = await w.ops.verify({ source: { file_path: file.path }, reading, proof, releaseIndeterminate: stillHeld.indeterminateMarker! });
    if (!released.ok) throw new Error(released.error.message);
    expect(released.value).toMatchObject({ status: "blocked", holds: [], releasedMarker: stillHeld.indeterminateMarker });
    expect(released.value.planHandle).toBeUndefined();
    // The next verify scans uncached: it finds POST1's draft, a duplicate hold, still no handle.
    const after = await verified(w, file);
    expect(after.holds.map((hold) => hold.code)).toContain("duplicate_supplier_number");
    expect(after.holds.map((hold) => hold.code)).not.toContain("reading_create_indeterminate");
    expect(after.planHandle).toBeUndefined();
    expect(w.createAndSetTotals).toHaveBeenCalledTimes(1);
  });

  it("a release removes only the named marker", async () => {
    const w = world();
    const fileA = writePdf("%PDF timeout A-17");
    const fileB = writePdf("%PDF timeout B-DOC");
    const B: ReadingCaseInput = {
      values: { invoice_number: "A-18", invoice_date: "2026-03-01" },
      evidence: { invoice_number: { line: "p1:001", quote: "Arve nr A-18" }, invoice_date: { line: "p1:004", quote: "Kuupäev 01.03.2026" } },
    };
    const timeout = async () => { throw new MutationIndeterminateError({ operation: "create", entity: "purchase_invoice", businessKey: "x", affectedCaches: [], cause: new Error("timeout"), nextAction: "re-read" }); };
    w.createAndSetTotals.mockImplementationOnce(timeout);
    await create(w, fileA, (await verified(w, fileA)).planHandle!);
    const markerA = (await verified(w, fileA)).indeterminateMarker!;
    const b = await verified(w, fileB, B, LINES_B);
    expect(b.status).toBe("ready");
    w.createAndSetTotals.mockImplementationOnce(timeout);
    await create(w, fileB, b.planHandle!);
    const markerB = (await verified(w, fileB, B, LINES_B)).indeterminateMarker!;
    expect(markerB).toEqual(expect.any(String));
    expect(markerB).not.toBe(markerA);

    const { reading, proof } = readingFor(packetFor(fileA.sha256));
    const releasedA = await w.ops.verify({ source: { file_path: fileA.path }, reading, proof, releaseIndeterminate: markerA });
    expect(releasedA.ok && releasedA.value.releasedMarker).toBe(markerA);
    expect((await verified(w, fileA)).status).toBe("ready");
    const stillB = await verified(w, fileB, B, LINES_B);
    expect(stillB.indeterminateMarker).toBe(markerB);
    expect(stillB.planHandle).toBeUndefined();
  });

  it("after a release the verify scans stay uncached: a draft that commits later is still found", async () => {
    const w = world();
    const file = writePdf("%PDF timeout late");
    let lateDraft: Record<string, unknown> | undefined;
    w.createAndSetTotals.mockImplementationOnce(async (data: Record<string, unknown>) => {
      lateDraft = data;
      throw new MutationIndeterminateError({ operation: "create", entity: "purchase_invoice", businessKey: "A-17", affectedCaches: [], cause: new Error("timeout"), nextAction: "re-read" });
    });
    await create(w, file, (await verified(w, file)).planHandle!);
    const marker = (await verified(w, file)).indeterminateMarker!;
    const { reading, proof } = readingFor(packetFor(file.sha256));
    expect((await w.ops.verify({ source: { file_path: file.path }, reading, proof, releaseIndeterminate: marker })).ok).toBe(true);
    // The scan is empty, so this verify is ready and fills the list cache.
    expect((await verified(w, file)).status).toBe("ready");
    // POST1 commits now; nothing invalidates the cache.
    w.commit(lateDraft!, 24, 124);
    const after = await verified(w, file);
    expect(after.holds.map((hold) => hold.code)).toContain("duplicate_supplier_number");
    expect(after.planHandle).toBeUndefined();
  });

  it("a marker cannot be released with a document it was not made for", async () => {
    const w = world();
    const fileA = writePdf("%PDF timeout A-17 bound");
    const fileB = writePdf("%PDF other B-DOC bound");
    const B: ReadingCaseInput = {
      values: { invoice_number: "A-18", invoice_date: "2026-03-01" },
      evidence: { invoice_number: { line: "p1:001", quote: "Arve nr A-18" }, invoice_date: { line: "p1:004", quote: "Kuupäev 01.03.2026" } },
    };
    w.createAndSetTotals.mockImplementationOnce(async () => { throw new MutationIndeterminateError({ operation: "create", entity: "purchase_invoice", businessKey: "x", affectedCaches: [], cause: new Error("timeout"), nextAction: "re-read" }); });
    await create(w, fileA, (await verified(w, fileA)).planHandle!);
    const markerA = (await verified(w, fileA)).indeterminateMarker!;
    const { reading, proof } = readingFor(packetFor(fileB.sha256, LINES_B), B);
    const outcome = await w.ops.verify({ source: { file_path: fileB.path }, reading, proof, releaseIndeterminate: markerA });
    expect(outcome).toMatchObject({ ok: false, error: { code: "indeterminate_marker_other_document" } });
    // A's own (stale) reading passed with file B does not release it either.
    const stale = readingFor(packetFor(fileA.sha256));
    const staleOutcome = await w.ops.verify({ source: { file_path: fileB.path }, reading: stale.reading, proof: stale.proof, releaseIndeterminate: markerA });
    expect(staleOutcome).toMatchObject({ ok: false, error: { code: "indeterminate_marker_other_document" } });
    expect((await verified(w, fileA)).indeterminateMarker).toBe(markerA);
    expect(w.ops.hasPendingMarkerForSource(fileA.sha256)).toBe(true);
    expect(w.ops.hasPendingMarkerForSource(fileB.sha256)).toBe(false);
  });

  it("an unknown marker id is refused", async () => {
    const w = world();
    const file = writePdf("%PDF unknown marker");
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const outcome = await w.ops.verify({ source: { file_path: file.path }, reading, proof, releaseIndeterminate: "deadbeef" });
    expect(outcome).toMatchObject({ ok: false, error: { code: "indeterminate_marker_unknown" } });
  });
});

describe("reading confirm (§5.5)", () => {
  async function createdDraft(w: World, contents = "%PDF confirm STRONG") {
    const file = writePdf(contents);
    const strong = contents.includes("STRONG");
    const outcome = await create(w, file, (await verified(w, file, strong ? STRONG : {}, strong ? LINES_STRONG : BASE_LINES)).planHandle!);
    if (!outcome.ok || outcome.value.status !== "created") throw new Error(JSON.stringify(outcome));
    return outcome.value.confirmPlan!;
  }

  it("an unchanged draft is registered once", async () => {
    const w = world();
    const plan = await createdDraft(w);
    const outcome = await w.ops.confirm({ ...plan, clientName: "smoke-client" });
    expect(outcome).toMatchObject({ ok: true, value: { status: "confirmed", confirmedInvoiceId: plan.invoiceId, gross: 124, currency: "EUR" } });
    expect(w.confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(expect.objectContaining({ action: "CONFIRMED", details: { reading_path: true, draft_fingerprint_verified: true, client_name: "smoke-client" } }));
  });

  it("a draft edited between create and confirm is draft_changed, 0 registers", async () => {
    const w = world();
    const plan = await createdDraft(w);
    w.details[plan.invoiceId]!.gross_price = 125;
    expect(await w.ops.confirm(plan)).toMatchObject({ ok: false, error: { code: "draft_changed" } });
    expect(w.confirm).not.toHaveBeenCalled();
  });

  it("a draft edited while the confirm scans run is draft_changed, 0 registers", async () => {
    const w = world();
    const plan = await createdDraft(w);
    const scan = w.api.journals.listAll.getMockImplementation() as ((...args: unknown[]) => Promise<unknown>) | undefined;
    w.api.journals.listAll.mockImplementation(async (...args: unknown[]) => {
      w.details[plan.invoiceId]!.gross_price = 125;
      return scan ? scan(...(args as [])) : [];
    });
    expect(await w.ops.confirm(plan)).toMatchObject({ ok: false, error: { code: "draft_changed" } });
    expect(w.confirm).not.toHaveBeenCalled();
  });

  it("an intervening duplicate invoice, a journal-reference hit or an unavailable scan refuses, 0 registers", async () => {
    for (const intervene of [
      (w: World) => { w.rows.push({ id: 611, clients_id: SUPPLIER_ID, client_name: "Näidis OÜ", number: "INV-202617", create_date: "2026-03-15", gross_price: 124, status: "PROJECT" }); },
      (w: World) => { w.api.journals.listAll.mockResolvedValue([{ id: 78, document_number: "INV-202617", title: "x", is_deleted: false }]); },
      (w: World) => { w.api.journals.listAll.mockRejectedValue(new Error("down")); },
    ]) {
      const w = world();
      const plan = await createdDraft(w);
      intervene(w);
      const outcome = await w.ops.confirm(plan);
      expect(outcome.ok && outcome.value.status).toBe("held");
      expect(w.confirm).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["paid_in_cash", true], ["cash_accounts_id", 1000], ["cash_accounts_dimensions_id", 5], ["cash_payment_date", "2026-03-20"], ["a_field_added_later", "x"],
  ])("a draft whose %s changed after create is draft_changed, 0 registers", async (field, value) => {
    const w = world();
    const plan = await createdDraft(w);
    w.details[plan.invoiceId]![field] = value;
    expect(await w.ops.confirm(plan)).toMatchObject({ ok: false, error: { code: "draft_changed" } });
    expect(w.confirm).not.toHaveBeenCalled();
  });

  it("a connection switch between create and confirm refuses, 0 registers", async () => {
    const w = world();
    const plan = await createdDraft(w);
    w.runtime.setScope({ connectionIndex: 1, connectionFingerprint: "other-fingerprint", connectionName: "other" });
    expect((await w.ops.confirm(plan)).ok).toBe(false);
    expect(w.confirm).not.toHaveBeenCalled();
  });

  it("a confirm handle cannot create, and a create handle cannot confirm", async () => {
    const w = world();
    const file = writePdf("%PDF cross 2");
    const verify = await verified(w, file);
    const plan = await createdDraft(w, "%PDF cross");
    expect(await create(w, file, plan.planHandle)).toMatchObject({ ok: false, error: { code: "plan_domain_mismatch" } });
    expect(await w.ops.confirm({ planHandle: verify.planHandle!, invoiceId: plan.invoiceId })).toMatchObject({ ok: false, error: { code: "plan_domain_mismatch" } });
    expect(w.confirm).not.toHaveBeenCalled();
  });
});

describe("reading item title (history template)", () => {
  function datedHistory(w: World, title = "Bussipilet Tallinn-Tartu-Tallinn 13.10.2026") {
    const detail = w.details[HISTORY_INVOICE.id as number]!;
    w.details[HISTORY_INVOICE.id as number] = { ...detail, items: (detail.items as Array<Record<string, unknown>>).map((item) => ({ ...item, custom_title: title })) };
  }
  async function verifyWithTitle(w: World, file: { path: string; sha256: string }, itemTitle?: string) {
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const outcome = await w.ops.verify({ source: { file_path: file.path }, reading, proof, booking: itemTitle !== undefined ? { itemTitle } : {} });
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.value;
  }
  const titleOf = (booking: unknown) => ((booking as { items: Array<{ custom_title: string }> }).items[0]!.custom_title);

  it("a dated history title issues no handle until the client gives item_title", async () => {
    const w = world();
    datedHistory(w);
    const file = writePdf("%PDF dated title");
    const held = await verifyWithTitle(w, file);
    expect(held).toMatchObject({ status: "blocked", itemTitleRequired: true });
    expect(held.planHandle).toBeUndefined();
    expect(w.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("item_title replaces the template title in the reviewed booking and in the created draft", async () => {
    const w = world();
    datedHistory(w);
    const file = writePdf("%PDF titled");
    const ready = await verifyWithTitle(w, file, "Bussipilet Tartu-Tallinn-Tartu 19.10.2026");
    expect(ready.status).toBe("ready");
    expect(titleOf(ready.booking)).toBe("Bussipilet Tartu-Tallinn-Tartu 19.10.2026");
    const created = await create(w, file, ready.planHandle!);
    expect(created.ok && created.value.status).toBe("created");
    expect(w.createAndSetTotals.mock.calls[0]![0].items[0].custom_title).toBe("Bussipilet Tartu-Tallinn-Tartu 19.10.2026");
  });

  it("each handle keeps its own reviewed title", async () => {
    const w = world();
    datedHistory(w);
    const file = writePdf("%PDF two titles");
    const first = await verifyWithTitle(w, file, "Pealkiri A");
    const second = await verifyWithTitle(w, file, "Pealkiri B");
    expect((await create(w, file, first.planHandle!)).ok).toBe(true);
    expect(w.createAndSetTotals.mock.calls[0]![0].items[0].custom_title).toBe("Pealkiri A");
    expect(second.planHandle).not.toBe(first.planHandle);
  });

  it("an undated history title needs no item_title", async () => {
    const w = world();
    datedHistory(w, "Bussipilet Tallinn-Tartu");
    const ready = await verifyWithTitle(w, writePdf("%PDF undated"));
    expect(ready.status).toBe("ready");
    expect(ready.itemTitleRequired).toBeUndefined();
  });

  it.each([
    "Bussipilet 13.10.2026", "Bussipilet 13/10/2026", "Pilet 5.1.26", "Tartu-Tallinn 05.-06.10.2026", "Arve 2026-10-05", "Teenus 03.2026",
    "Delfi september", "Digitellimus septembri eest", "Hosting Oct", "Üür mai", "Rent 2025", "Tellimus detsembris", "Rent mais", "Üür maiks", "Teenus maikuu eest",
  ])("%s is a dated title", (title) => { expect(itemTitleHasDate(title)).toBe(true); });

  it.each(["Teenus", "Bussipilet Tallinn-Tartu", "Mainor koolitus", "Marketing", "Junior arendaja", "Decor", "Kontoritarbed 24%"])(
    "%s is not a dated title", (title) => { expect(itemTitleHasDate(title)).toBe(false); });
});

describe("draftReadbackMismatches", () => {
  const twoItems = {
    clients_id: 4242, client_name: "Näidis OÜ", number: "A-17", create_date: "2026-03-15", journal_date: "2026-03-15", term_days: 0,
    cl_currencies_id: "EUR", liability_accounts_id: 2310,
    items: [
      { custom_title: "Üks", purchase_accounts_id: 5000, vat_accounts_id: 1510, vat_rate_dropdown: "24", total_net_price: 50, project_no_vat_gross_price: 62 },
      { custom_title: "Kaks", purchase_accounts_id: 5000, vat_accounts_id: 1520, vat_rate_dropdown: "24", total_net_price: 50, project_no_vat_gross_price: 62 },
    ],
  };
  const readback = (items: Array<Record<string, unknown>>) => ({
    ...twoItems, id: 900, status: "PROJECT", net_price: 100, vat_price: 24, gross_price: 124,
    base_net_price: 100, base_vat_price: 24, base_gross_price: 124,
    items: twoItems.items.map((item, index) => ({ ...item, id: 70 + index, amount: 1, cl_fringe_benefits_id: 1, vat_rate: 24, unit_net_price: 50, base_total_net_price: 50, vat_amount: 12, ...items[index] })),
  });
  const totals = { vatPrice: 24, grossPrice: 124 };

  it("a readback that echoes the approved items, with the server-derived amounts the predictor expects, matches", () => {
    expect(draftReadbackMismatches(readback([]) as never, twoItems as never, totals, true)).toEqual([]);
  });

  it("a 74/50 + 24/0 reallocation with unchanged invoice totals is a mismatch", () => {
    const mismatches = draftReadbackMismatches(readback([
      { project_no_vat_gross_price: 74, vat_amount: 24 }, { project_no_vat_gross_price: 50, vat_amount: 0 },
    ]) as never, twoItems as never, totals, true);
    expect(mismatches).toEqual(expect.arrayContaining([
      "items[0].project_no_vat_gross_price", "items[0].vat_amount", "items[1].project_no_vat_gross_price", "items[1].vat_amount",
    ]));
  });

  const noOverride = { ...twoItems, items: twoItems.items.map(({ project_no_vat_gross_price: _gross, ...item }) => ({ ...item, cl_fringe_benefits_id: 1 })) };
  const omitting = (keys: string[], patch: Array<Record<string, unknown>> = []) => {
    const draft = readback(patch) as Record<string, any>;
    draft.items = draft.items.map((item: Record<string, unknown>, index: number) => {
      const { project_no_vat_gross_price: _gross, ...rest } = item;
      const copy: Record<string, unknown> = { ...rest, ...patch[index] };
      for (const key of keys) delete copy[key];
      return copy;
    });
    return draft;
  };

  it("a GET that omits the item VAT and gross override cannot hide a 74/50 + 24/0 reallocation: the omitted VAT fails closed", () => {
    expect(draftReadbackMismatches(omitting(["vat_amount"]) as never, noOverride as never, totals, true))
      .toEqual(["items[0].vat_amount", "items[1].vat_amount"]);
  });

  it("an approved fringe benefit the GET omits fails closed, so a 1→2 change cannot pass unseen", () => {
    expect(draftReadbackMismatches(omitting(["cl_fringe_benefits_id"]) as never, noOverride as never, totals, true))
      .toEqual(["items[0].cl_fringe_benefits_id", "items[1].cl_fringe_benefits_id"]);
    expect(draftReadbackMismatches(omitting([], [{ cl_fringe_benefits_id: 2 }]) as never, noOverride as never, totals, true))
      .toEqual(["items[0].cl_fringe_benefits_id"]);
  });

  it("a numeric string matches its number, and a returned null counts as absent", () => {
    expect(draftReadbackMismatches(omitting([], [{ vat_amount: "12.00" }, { vat_amount: "12" }]) as never, noOverride as never, totals, true)).toEqual([]);
    expect(draftReadbackMismatches({ ...omitting([]), net_price: null } as never, noOverride as never, totals, true)).toEqual(["net_price"]);
  });

  it("text fields compare as exact strings, never as numbers: a big-number invoice number one digit off is a mismatch", () => {
    const model = { ...noOverride, number: "9007199254740992" };
    expect(draftReadbackMismatches({ ...omitting([]), number: "9007199254740993" } as never, model as never, totals, true)).toEqual(["number"]);
    expect(draftReadbackMismatches({ ...omitting([]), number: " 9007199254740992 " } as never, model as never, totals, true)).toEqual([]);
  });

  it("the money tolerance applies to money only: an id off by a fraction is a mismatch", () => {
    expect(draftReadbackMismatches(omitting([], [{ purchase_accounts_id: 5000.004 }]) as never, noOverride as never, totals, true))
      .toEqual(["items[0].purchase_accounts_id"]);
  });

  it("a payment_type the model sent is compared exactly", () => {
    const model = { ...noOverride, payment_type: "Ülekanne" };
    expect(draftReadbackMismatches({ ...omitting([]), payment_type: "Sularaha" } as never, model as never, totals, true)).toEqual(["payment_type"]);
  });

  it("an unsent unit_net_price may read back empty (as live) or as the predicted unit price, never as another value", () => {
    expect(draftReadbackMismatches(readback([{ unit_net_price: null }, { unit_net_price: null }]) as never, twoItems as never, totals, true)).toEqual([]);
    expect(draftReadbackMismatches(omitting(["unit_net_price"]) as never, noOverride as never, totals, true)).toEqual([]);
    expect(draftReadbackMismatches(readback([{ unit_net_price: 60 }]) as never, twoItems as never, totals, true)).toEqual(["items[0].unit_net_price"]);
  });

  it("a server-computed item VAT alone that differs from the predicted VAT is a mismatch", () => {
    expect(draftReadbackMismatches(readback([{ vat_amount: 24 }, { vat_amount: 0 }]) as never, twoItems as never, totals, true))
      .toEqual(["items[0].vat_amount", "items[1].vat_amount"]);
  });
});

describe("bookingDrift", () => {
  const reviewed = {
    supplier_client_id: 4242, supplier_name: "Näidis OÜ", invoice_number: "A-17", invoice_date: "2026-03-15", journal_date: "2026-03-15", term_days: 0,
    items: [{ custom_title: "Teenus", purchase_accounts_id: 5000, vat_accounts_id: 1510, cl_vat_articles_id: 1, total_net_price: 100 }],
    vat_price: 24, gross_price: 124, liability_accounts_id: 2310,
  };
  const withItem = (patch: Record<string, unknown>) => ({ ...reviewed, items: [{ ...reviewed.items[0]!, ...patch }] });

  it("any change of accounts, VAT account or article, dimension or amount is drift", () => {
    for (const patch of [{ vat_accounts_id: 1520 }, { purchase_accounts_id: 5001 }, { cl_vat_articles_id: 2 }, { purchase_accounts_dimensions_id: 9 }, { total_net_price: 50 }]) {
      expect(bookingDrift(reviewed, withItem(patch), ["gross", "net", "vat", "invoice_number", "invoice_date"]), JSON.stringify(patch)).toBe(true);
    }
    expect(bookingDrift(reviewed, { ...reviewed, liability_accounts_id: 2311 }, [])).toBe(true);
  });

  it("only the keys a corrected number or date derive may change", () => {
    expect(bookingDrift(reviewed, { ...reviewed, invoice_number: "A-18" }, ["invoice_number"])).toBe(false);
    expect(bookingDrift(reviewed, { ...reviewed, invoice_number: "A-18" }, [])).toBe(true);
    expect(bookingDrift(reviewed, { ...reviewed, invoice_date: "2026-03-14", journal_date: "2026-03-14", term_days: 1 }, ["invoice_date"])).toBe(false);
    expect(bookingDrift(reviewed, { ...reviewed, gross_price: 62 }, ["gross"])).toBe(true);
  });
});
