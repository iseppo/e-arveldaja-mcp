import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../document-parser.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { createReadingDocumentOperations, READING_PLAN_DOMAIN } from "./reading-operations.js";
import { FIXTURE_NOW, packetFor, readingApi, readingFor, readingParse, SUPPLIER_ID, type ReadingApiOptions } from "../__fixtures__/document-reading/verified-draft.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));
const mockedParse = vi.mocked(parseDocument);

function writePdf(contents = "%PDF-1.4 reading fixture"): { path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "reading-op-"));
  const path = join(dir, "invoice.pdf");
  writeFileSync(path, contents);
  return { path, sha256: createHash("sha256").update(Buffer.from(contents)).digest("hex") };
}

function setup(options: ReadingApiOptions = {}) {
  const createAndSetTotals = vi.fn().mockRejectedValue(new Error("no write expected"));
  const api = readingApi({ createAndSetTotals, ...options });
  const runtime = createTestRuntimeSafetyContext();
  const ops = createReadingDocumentOperations(api, runtime);
  const file = writePdf();
  return { api, runtime, ops, file, createAndSetTotals };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  mockedParse.mockResolvedValue(readingParse());
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("reading operations: read", () => {
  it("returns only the packet and its digests: heuristic values and supplier resolution are withheld", async () => {
    const { ops, file, api } = setup();
    const outcome = await ops.read({ source: { file_path: file.path } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.value).sort()).toEqual(["packetDigest", "packetHolds", "packetText", "sourceSha256"]);
    expect(outcome.value.sourceSha256).toBe(file.sha256);
    expect(outcome.value.packetDigest).toBe(packetFor(file.sha256).packet_digest);
    expect(outcome.value.packetText).toContain("p1:007");
    // read never resolves a supplier or reads the books.
    expect(api.clients.listAll).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.listAll).not.toHaveBeenCalled();
  });

  it("a blocking packet hold returns no packet text", async () => {
    const parse = readingParse();
    (parse.result as { pageErrors: unknown[] }).pageErrors = [{ pageNum: 1, error: "boom" }];
    mockedParse.mockResolvedValue(parse);
    const { ops, file } = setup();
    const outcome = await ops.read({ source: { file_path: file.path } });
    if (!outcome.ok) throw new Error("read failed");
    expect(outcome.value.packetHolds).toContain("page_extraction_failed");
    expect(outcome.value.packetText).toBeUndefined();
  });
});

describe("reading operations: verify", () => {
  it("a clean reading is ready, with a create handle in the reading domain bound to the booking", async () => {
    const { ops, file, runtime, createAndSetTotals } = setup();
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const outcome = await ops.verify({ source: { file_path: file.path }, reading, proof });
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value.status).toBe("ready");
    expect(outcome.value.holds).toEqual([]);
    expect(outcome.value.supplier).toEqual({ clientId: SUPPLIER_ID, name: "Näidis OÜ" });
    expect(outcome.value.booking).toMatchObject({ supplier_client_id: SUPPLIER_ID, invoice_number: "A-17", gross_price: 124, vat_price: 24 });
    const plan = runtime.planStore.consume(outcome.value.planHandle!, READING_PLAN_DOMAIN);
    expect(plan.normalizedArgs).toMatchObject({ source_sha256: file.sha256, supplier_client_id: SUPPLIER_ID });
    expect(createAndSetTotals).not.toHaveBeenCalled();
  });

  it("a reading bound to another packet digest holds packet_changed, with no handle", async () => {
    const { ops, file } = setup();
    const packet = { ...packetFor(file.sha256), packet_digest: "e".repeat(64) };
    const { reading, proof } = readingFor(packet);
    const outcome = await ops.verify({ source: { file_path: file.path }, reading, proof });
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value.status).toBe("blocked");
    expect(outcome.value.holds.map((hold) => hold.code)).toContain("packet_changed");
    expect(outcome.value.planHandle).toBeUndefined();
  });

  it("the reading schema is strict: an extra key holds reading_schema_invalid, with no handle", async () => {
    const { ops, file } = setup();
    const { reading, proof } = readingFor(packetFor(file.sha256), { extra: { base_gross_price: 124 } });
    const outcome = await ops.verify({ source: { file_path: file.path }, reading, proof });
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value.status).toBe("blocked");
    expect(outcome.value.holds.map((hold) => hold.code)).toContain("reading_schema_invalid");
    expect(outcome.value.values).toBeUndefined();
    expect(outcome.value.planHandle).toBeUndefined();
  });

  it("an existing invoice of the supplier with the same number holds duplicate_supplier_number, with no handle", async () => {
    const { ops, file } = setup({
      purchaseInvoiceRows: [{ id: 777, clients_id: SUPPLIER_ID, client_name: "Näidis OÜ", number: "A-17", create_date: "2026-03-15", gross_price: 124, status: "PROJECT" }],
    });
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const outcome = await ops.verify({ source: { file_path: file.path }, reading, proof });
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value.status).toBe("blocked");
    expect(outcome.value.holds.map((hold) => hold.code)).toContain("duplicate_supplier_number");
    expect(outcome.value.planHandle).toBeUndefined();
  });

  it("without supplier history the server asks for items instead of guessing an account", async () => {
    const { ops, file } = setup({ withHistory: false });
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const outcome = await ops.verify({ source: { file_path: file.path }, reading, proof });
    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value.bookingItemsRequired).toBe(true);
    expect(outcome.value.planHandle).toBeUndefined();
  });
});
