import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { getAllowedRoots, resolveFilePath, validateFilePath } from "../file-validation.js";
import { parseDocument } from "../document-parser.js";
import { buildKeywordSuggestion, suggestBookingInternal } from "../tools/receipt-extraction.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { ARIREGISTER_AUTOCOMPLETE_TELIA } from "../__fixtures__/ariregister-autocomplete.js";
import { createReceiptBatchOperations } from "./batch-operations.js";
import { createAndMaybeMatchPurchaseInvoice } from "../tools/receipt-inbox-booking.js";
import { sha256Hex } from "../tools/receipt-inbox-files.js";

// P2 E1 / E1b / E3 through the REAL receipt_batch path: real extraction, real
// supplier resolution (registry lookup = stubbed fetch), real gating and booking.
// Only the file system, the parser and the booking-account suggestion are
// stubbed. The API is a recording mock: every write is counted.

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const readFileMock = vi.fn();
  return {
    ...actual,
    open: vi.fn().mockImplementation(async (path: unknown) => {
      const isFile = String(path).toLowerCase().endsWith(".pdf");
      return {
        fd: 42,
        stat: vi.fn().mockImplementation(async () => ({
          isDirectory: () => !isFile,
          isFile: () => isFile,
          dev: 1,
          ino: isFile ? 3 : 2,
          size: isFile ? Buffer.from(await readFileMock(path)).length : 0,
          mtimeMs: 0,
        })),
        read: vi.fn().mockImplementation(async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytes = Buffer.from(await readFileMock(path));
          const bytesRead = position >= bytes.length
            ? 0
            : bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
          return { bytesRead, buffer };
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
    readFile: readFileMock,
    readdir: vi.fn(),
    realpath: vi.fn(),
    stat: vi.fn(),
  };
});

vi.mock("../file-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../file-validation.js")>()),
  getAllowedRoots: vi.fn(),
  resolveFilePath: vi.fn(),
  validateFilePath: vi.fn(),
}));

vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));

vi.mock("../tools/receipt-extraction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/receipt-extraction.js")>();
  return { ...actual, buildKeywordSuggestion: vi.fn(), suggestBookingInternal: vi.fn() };
});

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const FOLDER = "/tmp/receipts";
const REG_CODE = "10234957"; // the recorded registry entry (Telia Eesti AS)
const REGISTRY_NAME = "Telia Eesti AS";

/** A synthetic receipt whose supplier name is a bare top line ("PRINT"), with a labelled registry code. */
const PRINT_RECEIPT = [
  "PRINT",
  `Reg. nr ${REG_CODE}`,
  "KMKR EE100000007",
  "Arve nr A-17",
  "Kuupäev 15.03.2026",
  "Summa ilma KM-ta 100,00",
  "Käibemaks 24% 24,00",
  "Kokku 124,00 EUR",
];

function parsed(lines: string[], textItems: unknown[] = []) {
  const text = lines.join("\n");
  return {
    text,
    pageCount: 1,
    result: { text, totalPages: 1, pageErrors: [], pages: [{ pageNum: 1, width: 595, height: 842, text, textItems }] },
  } as never;
}

function registryResponse(ok: boolean) {
  const text = JSON.stringify(ARIREGISTER_AUTOCOMPLETE_TELIA);
  return ok
    ? { ok: true, headers: { get: () => String(text.length) }, text: () => Promise.resolve(text) }
    : { ok: false, headers: { get: () => "0" }, text: () => Promise.resolve("") };
}

/** fetch answers the registry lookups in order (true = the registry's entry, false = unavailable); the last one repeats. */
function stubRegistry(sequence: boolean[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => registryResponse(sequence[Math.min(call++, sequence.length - 1)]!));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const BOOKING = {
  item: { custom_title: "x", amount: 1, total_net_price: 100, cl_purchase_articles_id: 501, purchase_accounts_id: 5230, vat_rate_dropdown: "24" },
  source: "fallback",
  suggested_purchase_article: { id: 501, name: "Office" },
};

interface Recorder {
  clientsCreate: ReturnType<typeof vi.fn>;
  invoicesCreate: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

function makeApi(existingClients: Array<Record<string, unknown>> = []): { api: never; rec: Recorder } {
  const clients = [...existingClients];
  const clientsCreate = vi.fn(async (client: Record<string, unknown>) => {
    clients.push({ ...client, id: 900 + clients.length, is_deleted: false });
    return { created_object_id: 900 + clients.length - 1 };
  });
  const invoicesCreate = vi.fn(async (data: Record<string, unknown>) => ({
    id: 555, number: data.number, status: "PROJECT", clients_id: data.clients_id, client_name: data.client_name,
    cl_currencies_id: "EUR", create_date: data.create_date, gross_price: 124,
  }));
  const confirm = vi.fn().mockResolvedValue(undefined);
  const api = {
    clients: {
      listAll: vi.fn(async () => clients.map(client => ({ ...client }))),
      invalidateListCache: vi.fn(),
      create: clientsCreate,
      get: vi.fn(async (id: number) => clients.find(client => client.id === id)),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
      invalidateListCache: vi.fn(),
      createAndSetTotals: invoicesCreate,
      uploadDocument: vi.fn().mockResolvedValue(undefined),
      confirmWithTotals: confirm,
      invalidate: vi.fn().mockResolvedValue(undefined),
    },
    readonly: {
      getAccounts: vi.fn().mockResolvedValue([]),
      getPurchaseArticles: vi.fn().mockResolvedValue([]),
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE102809963" }),
      getBankAccounts: vi.fn().mockResolvedValue([]),
    },
    transactions: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
    journals: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
  } as never;
  return { api, rec: { clientsCreate, invoicesCreate, confirm } };
}

const baseRun = { resolvedFolderPath: FOLDER, accountsDimensionsId: 100, legacyExecuteCreate: false, directoryAccessOptions: {} } as const;
type Mode = "create" | "create_and_confirm";

async function runMode(api: never, mode: Mode) {
  const ops = createReceiptBatchOperations(api, createTestRuntimeSafetyContext());
  const dry = await ops.runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
  if (!dry.ok || !dry.value.planHandles) throw new Error("dry run failed");
  const run = await ops.runBatch({
    ...baseRun, executionMode: mode, dryRun: false, approvedManifest: dry.value.manifest, planHandle: dry.value.planHandles[mode],
  });
  return { dry: dry.value, run };
}

beforeEach(() => {
  vi.mocked(realpath).mockImplementation((async (path: unknown) => {
    const value = String(path);
    if (value === "/proc/self/fd/42" || value === "/dev/fd/42") throw Object.assign(new Error("no fd ns"), { code: "ENOENT" });
    return value;
  }) as never);
  vi.mocked(readdir).mockResolvedValue([{ name: "receipt.pdf", isFile: () => true }] as never);
  vi.mocked(stat).mockImplementation(async (path) => (String(path) === FOLDER
    ? { isDirectory: () => true, isFile: () => false, dev: 1, ino: 2 }
    : { isDirectory: () => false, isFile: () => true, dev: 1, ino: 3, size: 512, mtime: new Date("2026-03-20T10:00:00.000Z") }) as never);
  vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as never);
  vi.mocked(resolveFilePath).mockImplementation((path) => path);
  vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
  vi.mocked(validateFilePath).mockImplementation(async (path) => path as string);
  vi.mocked(parseDocument).mockResolvedValue(parsed(PRINT_RECEIPT));
  vi.mocked(buildKeywordSuggestion).mockReturnValue(BOOKING as never);
  vi.mocked(suggestBookingInternal).mockResolvedValue(BOOKING as never);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("P2 E1: a new supplier's name needs proof right before the client is created", () => {
  it("dry run: the registry name previews the client; an unavailable registry holds the top-line name", async () => {
    stubRegistry([true]);
    const { api, rec } = makeApi();
    const ops = createReceiptBatchOperations(api, createTestRuntimeSafetyContext());
    const verified = await ops.runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!verified.ok) throw new Error("dry run failed");
    expect(verified.value.results[0]!.status).toBe("dry_run_preview");
    expect(verified.value.results[0]!.supplier_resolution?.preview_client?.name).toBe(REGISTRY_NAME);

    stubRegistry([false]);
    const held = await ops.runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!held.ok) throw new Error("dry run failed");
    expect(held.value.results[0]!.status).toBe("needs_review");
    expect(held.value.results[0]!.supplier_resolution?.code).toBe("supplier_name_unverified");
    expect(rec.clientsCreate).not.toHaveBeenCalled();
    expect(rec.invoicesCreate).not.toHaveBeenCalled();
  });

  it("create: preview verified, then the persistence lookup (the one right before clients.create) fails → zero writes, no client named PRINT", async () => {
    // dry run, execute projection, execute preview: the registry answers; the lookup right before create fails.
    const fetchMock = stubRegistry([true, true, true, false]);
    const { api, rec } = makeApi();
    const { dry, run } = await runMode(api, "create");
    expect(dry.results[0]!.supplier_resolution?.preview_client?.name).toBe(REGISTRY_NAME);
    if (!run.ok) throw new Error("run failed");
    // The 4th lookup is the persistence-time one: the E1 boundary was reached.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(run.value.results[0]!.status).toBe("needs_review");
    expect(run.value.results[0]!.supplier_resolution?.code).toBe("supplier_name_unverified");
    expect(rec.clientsCreate).not.toHaveBeenCalled();
    expect(rec.invoicesCreate).not.toHaveBeenCalled();
    expect(rec.confirm).not.toHaveBeenCalled();
  });

  it("create_and_confirm (earlier-gate coverage, not the E1 boundary): a new supplier is never high confidence, so the batch stops before the persistence lookup", async () => {
    // create_and_confirm needs high confidence, and an unmatched supplier always raises
    // supplier_resolution_failed (medium), so this mode can never reach clients.create
    // for a new supplier; the E1 boundary itself is covered by the create arm above.
    const fetchMock = stubRegistry([true, true, true, false]);
    const { api, rec } = makeApi();
    const { run } = await runMode(api, "create_and_confirm");
    if (!run.ok) throw new Error("run failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(run.value.results[0]!.status).toBe("needs_review");
    expect(run.value.results[0]!.llm_fallback?.confidence_signals).toContain("supplier_resolution_failed");
    expect(rec.clientsCreate).not.toHaveBeenCalled();
    expect(rec.invoicesCreate).not.toHaveBeenCalled();
    expect(rec.confirm).not.toHaveBeenCalled();
  });

  describe("occurrence-specific name evidence: text-item order never hides an OCR origin", () => {
    // A supplier label read from an OCR item, and an unrelated native line that also contains the name.
    const LINES = ["Printed on 15.03.2026", "Supplier: PRINT", ...PRINT_RECEIPT.slice(1)];
    const items = LINES.map((text, index) => ({
      text, x: 40, y: 40 + 20 * index, width: 200, height: 12, ...(index === 1 ? { confidence: 0.9 } : {}),
    }));
    const permutations: Array<[string, typeof items]> = [
      ["page order", items],
      ["reversed", [...items].reverse()],
      ["native footer first, OCR label last", [items[0]!, ...items.slice(2), items[1]!]],
      ["OCR label first", [items[1]!, items[0]!, ...items.slice(2)]],
      ["rotated", [...items.slice(4), ...items.slice(0, 4)]],
    ];

    it.each(permutations)("%s: registry unavailable → zero writes in create", async (_label, ordered) => {
      stubRegistry([false]);
      vi.mocked(parseDocument).mockResolvedValue(parsed(LINES, ordered));
      const { api, rec } = makeApi();
      const { dry, run } = await runMode(api, "create");
      expect(dry.results[0]!.extracted?.supplier_name).toBe("PRINT");
      expect(dry.results[0]!.supplier_resolution?.code).toBe("supplier_name_unverified");
      expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
    });

    it("native text only, registry unavailable: held too (no text-derived name is proof)", async () => {
      stubRegistry([false]);
      vi.mocked(parseDocument).mockResolvedValue(parsed(LINES, items.map(({ confidence: _c, ...item }) => item)));
      const { api, rec } = makeApi();
      const { run } = await runMode(api, "create");
      expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
    });

    it.each(permutations)("%s, registry confirms the id: created once under the registry name", async (_label, ordered) => {
      stubRegistry([true]);
      vi.mocked(parseDocument).mockResolvedValue(parsed(LINES, ordered));
      const { api, rec } = makeApi();
      const { run } = await runMode(api, "create");
      expect(run.ok && run.value.results[0]!.status).toBe("created");
      expect(rec.clientsCreate).toHaveBeenCalledTimes(1);
      expect(rec.clientsCreate.mock.calls[0]![0]).toMatchObject({ name: REGISTRY_NAME });
    });
  });

  it.each<Mode>(["create", "create_and_confirm"])("%s: the preview lookup fails → zero writes", async (mode) => {
    stubRegistry([false]);
    const { api, rec } = makeApi();
    const { dry, run } = await runMode(api, mode);
    expect(dry.results[0]!.status).toBe("needs_review");
    expect(dry.results[0]!.supplier_resolution?.code).toBe("supplier_name_unverified");
    expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
    expect(rec.clientsCreate).not.toHaveBeenCalled();
    expect(rec.invoicesCreate).not.toHaveBeenCalled();
  });

  it("create: the registry name is returned at persistence → one client, with the registry name", async () => {
    stubRegistry([true]);
    const { api, rec } = makeApi();
    const { run } = await runMode(api, "create");
    if (!run.ok) throw new Error("run failed");
    expect(rec.clientsCreate).toHaveBeenCalledTimes(1);
    expect(rec.clientsCreate.mock.calls[0]![0]).toMatchObject({ name: REGISTRY_NAME, code: REG_CODE });
    expect(rec.invoicesCreate).toHaveBeenCalledTimes(1);
    expect(run.value.results[0]!.status).toBe("created");
  });

  it("create_and_confirm: a new supplier is not high confidence, so nothing is written (as today)", async () => {
    stubRegistry([true]);
    const { api, rec } = makeApi();
    const { run } = await runMode(api, "create_and_confirm");
    expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
    expect(rec.clientsCreate).not.toHaveBeenCalled();
    expect(rec.invoicesCreate).not.toHaveBeenCalled();
  });

  describe("positive proof: no text-derived name creates a client when the registry did not name it", () => {
    const tail = PRINT_RECEIPT.slice(1);
    const item = (text: string, index: number, extra: Record<string, unknown> = {}) =>
      ({ text, x: 40, y: 100 + 20 * index, width: 200, height: 12, ...extra });
    const probes: Array<[string, string[], unknown[]]> = [
      ["supplier label (native)", ["Müüja: Näidis Trükk OÜ", ...tail], ["Müüja: Näidis Trükk OÜ", ...tail].map((t, i) => item(t, i))],
      ["split OCR name, label first", ["Supplier: ACME PRINT", ...tail],
        [item("Supplier:", 0, { confidence: 0.9 }), { ...item("ACME", 0, { confidence: 0.9 }), x: 110 }, { ...item("PRINT", 0, { confidence: 0.9 }), x: 160 }, ...tail.map((t, i) => item(t, i + 1))]],
      ["split OCR name, label last", ["Supplier: ACME PRINT", ...tail],
        [...tail.map((t, i) => item(t, i + 1)), { ...item("PRINT", 0, { confidence: 0.9 }), x: 160 }, { ...item("ACME", 0, { confidence: 0.9 }), x: 110 }, item("Supplier:", 0, { confidence: 0.9 })]],
      ["NFC text, NFD OCR items", ["Müüja: Näidis Trükk OÜ", ...tail],
        [item("Müüja: Näidis Trükk OÜ".normalize("NFD"), 0, { confidence: 0.9 }), ...tail.map((t, i) => item(t, i + 1))]],
      ["large native layout logo above the supplier label", ["ACME PRINT", "Müüja:", ...tail],
        [{ text: "ACME PRINT", x: 40, y: 40, width: 300, height: 40 }, item("Müüja:", 1), ...tail.map((t, i) => item(t, i + 2))]],
    ];

    it.each(probes)("%s, registry unavailable: zero writes in dry run and create", async (_label, lines, textItems) => {
      stubRegistry([false]);
      vi.mocked(parseDocument).mockResolvedValue(parsed(lines, textItems));
      const { api, rec } = makeApi();
      const { dry, run } = await runMode(api, "create");
      expect(dry.results[0]!.status).toBe("needs_review");
      expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
    });

    it("file-name token name (KIRRET SINISILM ARVE), registry unavailable: zero writes in dry run and create", async () => {
      stubRegistry([false]);
      vi.mocked(readdir).mockResolvedValue([{ name: "KIRRET SINISILM ARVE.pdf", isFile: () => true }] as never);
      vi.mocked(parseDocument).mockResolvedValue(parsed(tail, tail.map((t, i) => item(t, i))));
      const { api, rec } = makeApi();
      const { dry, run } = await runMode(api, "create");
      expect(dry.results[0]!.extracted?.supplier_name).toBe("KIRRET SINISILM ARVE");
      expect(dry.results[0]!.supplier_resolution?.code).toBe("supplier_name_unverified");
      expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
    });

    it("the hold names the code, keeps the extracted name for confirmation, and adds the provenance as a diagnostic", async () => {
      stubRegistry([false]);
      const { api } = makeApi();
      const { dry } = await runMode(api, "create");
      const result = dry.results[0]!;
      expect(result.supplier_resolution?.code).toBe("supplier_name_unverified");
      expect(result.extracted?.supplier_name).toBe("PRINT");
      expect(result.notes.join(" ")).toContain("Name provenance (diagnostic): ocr/top_line");
    });

    it("an existing client is matched as before: no registry lookup, no client created, invoice booked", async () => {
      const fetchMock = stubRegistry([false]);
      const { api, rec } = makeApi([{
        id: 7, name: "Printimiskeskus OÜ", code: REG_CODE, is_supplier: true, is_client: false, cl_code_country: "EST",
        is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false,
      }]);
      const { run } = await runMode(api, "create");
      expect(run.ok && run.value.results[0]!.status).toBe("created");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("P2 E1b: a generated description is booked with the bound client's name", () => {
  const bookedTitle = (rec: Recorder) =>
    (rec.invoicesCreate.mock.calls[0]![0] as { items: Array<{ custom_title: string }> }).items[0]!.custom_title;

  it("existing client: the generated PRINT description becomes Expense from <client name>; supplier_name is unchanged", async () => {
    stubRegistry([true]);
    const { api, rec } = makeApi([{
      id: 7, name: "Printimiskeskus OÜ", code: REG_CODE, is_supplier: true, is_client: false, cl_code_country: "EST",
      is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false,
    }]);
    const { run } = await runMode(api, "create");
    if (!run.ok) throw new Error("run failed");
    const result = run.value.results[0]!;
    expect(result.extracted?.description).toBe("PRINT");
    expect(result.extracted?.description_source).toBe("generated");
    expect(result.extracted?.supplier_name).toBe("PRINT");
    expect(rec.clientsCreate).not.toHaveBeenCalled();
    expect(rec.invoicesCreate).toHaveBeenCalledTimes(1);
    expect(bookedTitle(rec)).toBe("Expense from Printimiskeskus OÜ");
  });

  it("newly created registry-verified client: the description and the client both carry the registry name", async () => {
    stubRegistry([true]);
    const { api, rec } = makeApi();
    const { run } = await runMode(api, "create");
    if (!run.ok) throw new Error("run failed");
    expect(rec.clientsCreate.mock.calls[0]![0]).toMatchObject({ name: REGISTRY_NAME });
    expect(bookedTitle(rec)).toBe(`Expense from ${REGISTRY_NAME}`);
    expect(bookedTitle(rec)).not.toContain("PRINT");
  });

  describe("at the booking boundary", () => {
    const snapshot = () => {
      const bytes = Buffer.from("%PDF-receipt");
      return {
        file: { name: "receipt.pdf", path: "/tmp/receipts/receipt.pdf", extension: ".pdf", file_type: "pdf", size_bytes: bytes.length, modified_at: "2026-03-15T00:00:00.000Z" },
        relative_path: "receipt.pdf", sha256: sha256Hex(bytes), bytes, snapshot_path: "/tmp/receipts/receipt.pdf",
      } as never;
    };
    const extracted = (overrides: Record<string, unknown>) => ({
      supplier_name: "PRINT", invoice_number: "A-17", invoice_date: "2026-03-15",
      total_net: 100, total_vat: 24, total_gross: 124, currency: "EUR", ...overrides,
    });
    const client = { id: 7, name: "Printimiskeskus OÜ", is_supplier: true, is_client: false, cl_code_country: "EST", is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false };
    async function bookRaw(fields: Record<string, unknown>, resolution: Record<string, unknown>) {
      const { api, rec } = makeApi();
      const result = await createAndMaybeMatchPurchaseInvoice(
        api, { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: true } as never,
        snapshot(), extracted(fields) as never, resolution as never, BOOKING as never, [], "create", false, new Set(),
      );
      return { result, rec };
    }
    const book = async (fields: Record<string, unknown>, resolution: Record<string, unknown>) =>
      bookedTitle((await bookRaw(fields, resolution)).rec);

    it("a document or operator description is kept, even with a bound client", async () => {
      expect(await book({ description: "Kontoritarbed", description_source: "document" }, { found: true, created: false, client })).toBe("Kontoritarbed");
      expect(await book({ description: "Paber A4" }, { found: true, created: false, client })).toBe("Paber A4");
    });

    it("an unresolved supplier keeps today's behaviour: held, nothing booked, the extraction unchanged", async () => {
      const fields = { description: "PRINT", description_source: "generated" };
      const { result, rec } = await bookRaw(fields, { found: false, created: false, preview_client: { name: "PRINT" } });
      expect(result.status).toBe("needs_review");
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
      expect(fields.description).toBe("PRINT");
    });
  });
});

describe("P2 E3: a receipt read as EUR that prints another currency is held in every mode", () => {
  const LABELLED = ["Müüja: Näidis Trükk OÜ", ...PRINT_RECEIPT.slice(1, -1)];
  const signalsOf = (result: { llm_fallback?: { confidence_signals?: string[] } }) => result.llm_fallback?.confidence_signals ?? [];

  it.each([
    ["the extractor reads EUR (Kokku 124,00 EUR) and the page prints kr", [...LABELLED, "Kokku 124,00 EUR", "Att betala 1 250,00 kr"]],
    ["Att betala 1 250,00 kr", [...LABELLED, "Att betala 1 250,00 kr"]],
  ])("%s: dry run, create and create_and_confirm write nothing", async (_label, lines) => {
    vi.mocked(parseDocument).mockResolvedValue(parsed(lines as string[]));
    for (const mode of ["create", "create_and_confirm"] as const) {
      stubRegistry([true]);
      const { api, rec } = makeApi();
      const { dry, run } = await runMode(api, mode);
      expect(dry.results[0]!.status).toBe("needs_review");
      expect(signalsOf(dry.results[0]!)).toContain("foreign_currency_marker");
      expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
      expect(rec.confirm).not.toHaveBeenCalled();
    }
  });

  it("a BIC branch code XXX next to a stated EUR is no marker: the receipt is created", async () => {
    stubRegistry([true]);
    vi.mocked(parseDocument).mockResolvedValue(parsed([...LABELLED, "Kokku 124,00 €", "BIC: TRWIBEB1XXX"]));
    const { api, rec } = makeApi();
    const { dry, run } = await runMode(api, "create");
    expect(signalsOf(dry.results[0]!)).not.toContain("foreign_currency_marker");
    expect(run.ok && run.value.results[0]!.status).toBe("created");
    expect(rec.invoicesCreate).toHaveBeenCalledTimes(1);
  });

  it("h30 shape (a USD reading) still stops at booking as a non-EUR receipt, not on the marker", async () => {
    stubRegistry([true]);
    vi.mocked(parseDocument).mockResolvedValue(parsed([...LABELLED, "Total 124,00 USD"]));
    const { api, rec } = makeApi([{
      id: 7, name: "Näidis Trükk OÜ", code: REG_CODE, is_supplier: true, is_client: false, cl_code_country: "EST",
      is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false,
    }]);
    const { dry, run } = await runMode(api, "create");
    expect(dry.results[0]!.extracted?.currency).toBe("USD");
    expect(signalsOf(dry.results[0]!)).not.toContain("foreign_currency_marker");
    if (!run.ok) throw new Error("run failed");
    expect(run.value.results[0]!.status).toBe("needs_review");
    expect(run.value.results[0]!.notes.join(" ")).toContain("Non-EUR receipt currency USD");
    expect(rec.invoicesCreate).not.toHaveBeenCalled();
  });
});

describe("P2 E4: a credit word or a signed amount holds the receipt in every mode", () => {
  const signalsOf = (result: { llm_fallback?: { confidence_signals?: string[] } }) => result.llm_fallback?.confidence_signals ?? [];

  it.each([
    ["credit_word_present", "Kreeditarve viide K-1"],
    ["credit_word_present", "Refund for order 17"],
    ["signed_amount_present", "Allahindlus -5,00"],
    ["signed_amount_present", "Allahindlus (5,00)"],
  ])("%s (%s): dry run, create and create_and_confirm write nothing", async (signal, line) => {
    vi.mocked(parseDocument).mockResolvedValue(parsed(["Müüja: Näidis Trükk OÜ", ...PRINT_RECEIPT.slice(1), line]));
    for (const mode of ["create", "create_and_confirm"] as const) {
      stubRegistry([true]);
      const { api, rec } = makeApi();
      const { dry, run } = await runMode(api, mode);
      expect(dry.results[0]!.status).toBe("needs_review");
      expect(signalsOf(dry.results[0]!)).toContain(signal);
      expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
      expect(rec.confirm).not.toHaveBeenCalled();
    }
  });

  it("a credit word only inside a longer word (non-refundable) is no hold: the receipt is created", async () => {
    stubRegistry([true]);
    vi.mocked(parseDocument).mockResolvedValue(parsed(["Müüja: Näidis Trükk OÜ", ...PRINT_RECEIPT.slice(1), "Tickets are non-refundable"]));
    const { api, rec } = makeApi();
    const { dry, run } = await runMode(api, "create");
    expect(signalsOf(dry.results[0]!)).not.toContain("credit_word_present");
    expect(run.ok && run.value.results[0]!.status).toBe("created");
    expect(rec.invoicesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("P2 E2: a value lost under a dot leader holds the receipt in every mode", () => {
  const LABELLED = ["Müüja: Näidis Trükk OÜ", ...PRINT_RECEIPT.slice(1)];
  const signalsOf = (result: { llm_fallback?: { confidence_signals?: string[] } }) => result.llm_fallback?.confidence_signals ?? [];
  // h25 shape (Google): the date and number cells are only grey leaders; the period line prints other dates.
  const H25 = [
    ...LABELLED,
    "Arve number    ....................",
    "Arve kuupäev    ....................    Kogusumma (EUR)    1,87 €",
    "Konto ID    ....................    Kokkuvõte - 1. sept 2026 - 30. sept 2026",
  ];

  it("h25 shape: dry run, create and create_and_confirm write nothing", async () => {
    vi.mocked(parseDocument).mockResolvedValue(parsed(H25));
    for (const mode of ["create", "create_and_confirm"] as const) {
      stubRegistry([true]);
      const { api, rec } = makeApi();
      const { dry, run } = await runMode(api, mode);
      expect(dry.results[0]!.status).toBe("needs_review");
      expect(signalsOf(dry.results[0]!)).toContain("text_layer_value_lost");
      expect(run.ok && run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
      expect(rec.confirm).not.toHaveBeenCalled();
    }
  });

  it("the same receipt without a leader-only cell is created", async () => {
    stubRegistry([true]);
    vi.mocked(parseDocument).mockResolvedValue(parsed(LABELLED));
    const { api, rec } = makeApi();
    const { dry, run } = await runMode(api, "create");
    expect(signalsOf(dry.results[0]!)).not.toContain("text_layer_value_lost");
    expect(run.ok && run.value.results[0]!.status).toBe("created");
    expect(rec.invoicesCreate).toHaveBeenCalledTimes(1);
  });
});
