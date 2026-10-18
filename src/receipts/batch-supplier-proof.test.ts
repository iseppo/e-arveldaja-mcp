import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { getAllowedRoots, resolveFilePath, validateFilePath } from "../file-validation.js";
import { parseDocument } from "../document-parser.js";
import { buildKeywordSuggestion, suggestBookingInternal } from "../tools/receipt-extraction.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { ARIREGISTER_AUTOCOMPLETE_TELIA } from "../__fixtures__/ariregister-autocomplete.js";
import { createReceiptBatchOperations } from "./batch-operations.js";

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

function parsed(lines: string[]) {
  const text = lines.join("\n");
  return {
    text,
    pageCount: 1,
    result: { text, totalPages: 1, pageErrors: [], pages: [{ pageNum: 1, width: 595, height: 842, text, textItems: [] }] },
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

  it.each<Mode>(["create", "create_and_confirm"])(
    "%s: preview verified, then the persistence lookup fails → zero writes, no client named PRINT",
    async (mode) => {
      // dry run, execute projection, execute preview: the registry answers; the lookup right before create fails.
      stubRegistry([true, true, true, false]);
      const { api, rec } = makeApi();
      const { dry, run } = await runMode(api, mode);
      expect(dry.results[0]!.supplier_resolution?.preview_client?.name).toBe(REGISTRY_NAME);
      expect(run.ok).toBe(true);
      if (!run.ok) throw new Error("run failed");
      expect(run.value.results[0]!.status).toBe("needs_review");
      expect(rec.clientsCreate).not.toHaveBeenCalled();
      expect(rec.invoicesCreate).not.toHaveBeenCalled();
      expect(rec.confirm).not.toHaveBeenCalled();
    },
  );

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

  it("create: a supplier-label name with no registry name is created as today, with the extracted name", async () => {
    stubRegistry([false]);
    vi.mocked(parseDocument).mockResolvedValue(parsed(["Müüja: Näidis Trükk OÜ", ...PRINT_RECEIPT.slice(1)]));
    const { api, rec } = makeApi();
    const { run } = await runMode(api, "create");
    if (!run.ok) throw new Error("run failed");
    expect(rec.clientsCreate).toHaveBeenCalledTimes(1);
    expect(rec.clientsCreate.mock.calls[0]![0]).toMatchObject({ name: "Näidis Trükk OÜ" });
    expect(run.value.results[0]!.status).toBe("created");
  });
});
