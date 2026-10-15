import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { getAllowedRoots, resolveFilePath, validateFilePath } from "../file-validation.js";
import { parseDocument } from "../document-parser.js";
import {
  buildKeywordSuggestion,
  classifyReceiptDocument,
  extractReceiptFieldsFromText,
  hasAutoBookableReceiptFields,
  suggestBookingInternal,
} from "../tools/receipt-extraction.js";
import { summarizeInvoiceExtraction } from "../invoice-extraction-fallback.js";
import { resolveSupplierInternal } from "../tools/supplier-resolution.js";
import { HttpError } from "../http-client.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { createReceiptBatchOperations } from "./batch-operations.js";
import type { ReceiptApprovedManifestEntry } from "./types.js";

// The typed operation is exercised DIRECTLY (no mock McpServer): narrow api / fs
// / OCR ports only. These pin the staged-approval invariants the refactor must
// preserve: scan is zero-mutation; dry_run issues the SHA-256 manifest without
// mutating; create resends + validates it (manifest_mismatch BEFORE any
// mutation); create (APPROVAL ONE) creates+uploads but never confirms;
// create_and_confirm (APPROVAL TWO) confirms; a post-create failure is
// compensated (rollback) and reported, NEVER auto-retried.

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const readFileMock = vi.fn();
  return {
    ...actual,
    open: vi.fn().mockImplementation(async (path: unknown) => {
      const isFile = String(path).toLowerCase().endsWith(".pdf");
      return {
        fd: 42,
        // fstat size tracks the served bytes: the capped read refuses a size mismatch.
        stat: vi.fn().mockImplementation(async () => ({
          isDirectory: () => !isFile,
          isFile: () => isFile,
          dev: 1,
          ino: isFile ? 3 : 2,
          size: isFile ? Buffer.from(await readFileMock(path)).length : 0,
          mtimeMs: 0,
        })),
        // Positional FileHandle.read over the bytes readFileMock serves for this path.
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

vi.mock("../document-parser.js", () => ({
  parseDocument: vi.fn(),
}));

vi.mock("../tools/receipt-extraction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/receipt-extraction.js")>();
  return {
  ...actual,
  buildKeywordSuggestion: vi.fn(actual.buildKeywordSuggestion),
  classifyReceiptDocument: vi.fn(),
  extractReceiptFieldsFromText: vi.fn(),
  hasAutoBookableReceiptFields: vi.fn(),
  suggestBookingInternal: vi.fn(),
  };
});

vi.mock("../tools/supplier-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/supplier-resolution.js")>()),
  resolveSupplierInternal: vi.fn(),
}));

vi.mock("../invoice-extraction-fallback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../invoice-extraction-fallback.js")>()),
  summarizeInvoiceExtraction: vi.fn(),
}));

const FOLDER = "/tmp/receipts";

async function receiptRealpath(path: unknown): Promise<string> {
  const value = String(path);
  if (value === "/proc/self/fd/42" || value === "/dev/fd/42") {
    throw Object.assign(new Error("descriptor namespace unavailable"), { code: "ENOENT" });
  }
  return value;
}

function primeFilesystem(): void {
  vi.mocked(realpath).mockImplementation(receiptRealpath as never);
  vi.mocked(readdir).mockResolvedValue([{ name: "receipt.pdf", isFile: () => true }] as never);
  vi.mocked(stat).mockImplementation(async (path) => {
    if (String(path) === FOLDER) {
      return { isDirectory: () => true, isFile: () => false, dev: 1, ino: 2 } as never;
    }
    return {
      isDirectory: () => false,
      isFile: () => true,
      dev: 1,
      ino: 3,
      size: 512,
      mtime: new Date("2026-03-20T10:00:00.000Z"),
    } as never;
  });
  vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as never);
  vi.mocked(resolveFilePath).mockImplementation((path) => path);
  vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
  vi.mocked(validateFilePath).mockImplementation(async (path) => path as string);
}

function primeExtraction(): void {
  vi.mocked(parseDocument).mockResolvedValue({ text: "ignored", pageCount: 1 } as never);
  vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
  vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
    supplier_name: "Supplier OÜ",
    invoice_number: "INV-1",
    invoice_date: "2026-03-20",
    due_date: "2026-03-20",
    total_net: 100,
    total_vat: 24,
    total_gross: 124,
    currency: "EUR",
    description: "Service",
    raw_text: "ignored",
  } as never);
  vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
  vi.mocked(suggestBookingInternal).mockResolvedValue({
    item: { custom_title: "Service", amount: 1, total_net_price: 100, cl_purchase_articles_id: 501, purchase_accounts_id: 5230 },
    source: "fallback",
    suggested_purchase_article: { id: 501, name: "Software" },
  } as never);
  vi.mocked(resolveSupplierInternal).mockResolvedValue({
    found: true,
    created: false,
    match_type: "exact_name",
    client: {
      id: 7,
      name: "Supplier OU",
      is_supplier: true,
      is_client: false,
      cl_code_country: "EST",
      is_member: false,
      send_invoice_to_email: false,
      send_invoice_to_accounting_email: false,
      is_deleted: false,
    },
  } as never);
  // High confidence so create_and_confirm is not gated to needs_review by the
  // create_and_confirm-needs-high rule (shouldGateCreation).
  vi.mocked(summarizeInvoiceExtraction).mockReturnValue({
    recommended: false,
    confidence: "high",
    missing_required_fields: [],
    confidence_signals: [],
    reason: "",
  } as never);
}

interface ApiSpies {
  createAndSetTotals: ReturnType<typeof vi.fn>;
  uploadDocument: ReturnType<typeof vi.fn>;
  confirmWithTotals: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
}

function makeApi(spies: Partial<ApiSpies> = {}): { api: never; spies: ApiSpies } {
  const createAndSetTotals = spies.createAndSetTotals ?? vi.fn().mockResolvedValue({
    id: 555, number: "INV-1", status: "PROJECT", clients_id: 7,
    client_name: "Supplier OU", cl_currencies_id: "EUR", create_date: "2026-03-20", gross_price: 124,
  });
  const uploadDocument = spies.uploadDocument ?? vi.fn().mockResolvedValue(undefined);
  const confirmWithTotals = spies.confirmWithTotals ?? vi.fn().mockResolvedValue(undefined);
  const invalidate = spies.invalidate ?? vi.fn().mockResolvedValue(undefined);
  const api = {
    clients: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
      invalidateListCache: vi.fn(),
      createAndSetTotals,
      uploadDocument,
      confirmWithTotals,
      invalidate,
    },
    readonly: {
      getAccounts: vi.fn().mockResolvedValue([]),
      getPurchaseArticles: vi.fn().mockResolvedValue([]),
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      getBankAccounts: vi.fn().mockResolvedValue([]),
    },
    transactions: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
    journals: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
  } as never;
  return { api, spies: { createAndSetTotals, uploadDocument, confirmWithTotals, invalidate } };
}

function makeOperations(api: never) {
  return createReceiptBatchOperations(api, createTestRuntimeSafetyContext());
}

// P0-3 drift tests need to reach the SAME runtime safety context the plan handle
// was minted on (to advance the clock / rescope / read the plan store), so mint
// and execute must share one context. makeOperations() hides its context, so this
// variant exposes it.
function makeOperationsWithContext(api: never) {
  const context = createTestRuntimeSafetyContext();
  return { ops: createReceiptBatchOperations(api, context), context };
}

// P0-3: the plan handle is minted by a dry_run and consumed by the matching
// create / create_and_confirm on the SAME operation instance (the plan store
// lives on that instance's runtime safety context). So dry_run and execute must
// share one `ops` — a fresh makeOperations() would have an empty store.
type DryRunPlan = {
  manifest: ReceiptApprovedManifestEntry[];
  planHandles: { create: string; create_and_confirm: string };
};
async function dryRunPlan(ops: ReturnType<typeof makeOperations>, overrides: Partial<typeof baseRun> = {}): Promise<DryRunPlan> {
  const outcome = await ops.runBatch({ ...baseRun, ...overrides, executionMode: "dry_run", dryRun: true });
  if (!outcome.ok) throw new Error("dry run failed");
  if (!outcome.value.planHandles) throw new Error("dry run minted no plan handles");
  return { manifest: outcome.value.manifest, planHandles: outcome.value.planHandles };
}

const baseRun = {
  resolvedFolderPath: FOLDER,
  accountsDimensionsId: 100,
  legacyExecuteCreate: false,
  directoryAccessOptions: {},
} as const;

beforeEach(() => {
  primeFilesystem();
  primeExtraction();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("receipt batch typed operation", () => {
  it("scan performs zero mutation and returns file metadata", async () => {
    const { api, spies } = makeApi();
    const outcome = await makeOperations(api).scan({ resolvedFolderPath: FOLDER, directoryAccessOptions: {} });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("scan failed");
    expect(outcome.value.files.map(f => f.name)).toEqual(["receipt.pdf"]);
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.uploadDocument).not.toHaveBeenCalled();
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
  });

  it("dry_run issues the SHA-256 manifest and mutates nothing", async () => {
    const { api, spies } = makeApi();
    const outcome = await makeOperations(api).runBatch({
      ...baseRun, executionMode: "dry_run", dryRun: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.manifest).toHaveLength(1);
    expect(outcome.value.manifest[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.value.results[0]!.status).toBe("dry_run_preview");
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
  });

  it("refuses a receipt rewritten while its snapshot bytes are read (torn read)", async () => {
    const { api, spies } = makeApi();
    // Served bytes per call: open fstat, pre-read fstat, first read → original;
    // from the end-of-file probe on, the file holds rewritten (longer) content.
    let calls = 0;
    vi.mocked(readFile).mockImplementation(async () =>
      Buffer.from(++calls <= 3 ? "receipt pdf" : "receipt pdf, rewritten") as never);
    await expect(makeOperations(api).runBatch({
      ...baseRun, executionMode: "dry_run", dryRun: true,
    })).rejects.toMatchObject({ code: "file_reference_path_changed" });
    expect(calls).toBeGreaterThan(3);
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("mintPlanHandles:false previews without consuming plan-store slots", async () => {
    const { api } = makeApi();
    const { ops, context } = makeOperationsWithContext(api as never);
    const before = context.planStore.activeCount;

    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "dry_run", dryRun: true, mintPlanHandles: false,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    // The preview is unchanged — only the unused approval artifacts are gone.
    expect(outcome.value.results[0]!.status).toBe("dry_run_preview");
    expect(outcome.value.manifest).toHaveLength(1);
    expect(outcome.value.planHandles).toBeUndefined();
    // The store THROWS at capacity rather than evicting, so a summarizing
    // caller that discards handles must not consume slots at all.
    expect(context.planStore.activeCount).toBe(before);
  });

  it("a default dry run still mints one handle per execution effect", async () => {
    const { api } = makeApi();
    const { ops, context } = makeOperationsWithContext(api as never);
    const before = context.planStore.activeCount;

    const outcome = await ops.runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.planHandles?.create).toBeDefined();
    expect(outcome.value.planHandles?.create_and_confirm).toBeDefined();
    expect(context.planStore.activeCount).toBe(before + 2);
  });

  it("create rejects with manifest_mismatch BEFORE any mutation when the folder drifted", async () => {
    const { api, spies } = makeApi();
    const wrongManifest: ReceiptApprovedManifestEntry[] = [{ relative_path: "receipt.pdf", sha256: "0".repeat(64) }];
    await expect(makeOperations(api).runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: wrongManifest,
    })).rejects.toMatchObject({ category: "manifest_mismatch" });
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.uploadDocument).not.toHaveBeenCalled();
  });

  it("create (APPROVAL ONE) creates + uploads but never confirms", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.uploadDocument).toHaveBeenCalledTimes(1);
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
    expect(outcome.value.results[0]!.status).toBe("created");
    expect(outcome.value.results[0]!.created_invoice?.confirmed).toBe(false);
  });

  it("create_and_confirm (APPROVAL TWO) also confirms the created invoice", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create_and_confirm,
    });
    expect(outcome.ok).toBe(true);
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.uploadDocument).toHaveBeenCalledTimes(1);
    expect(spies.confirmWithTotals).toHaveBeenCalledTimes(1);
  });

  it("execute re-reads clients/invoices/transactions/journals uncached; the dry run stays cached", async () => {
    const { api } = makeApi();
    const a = api as unknown as Record<string, { invalidateListCache: ReturnType<typeof vi.fn>; listAll: ReturnType<typeof vi.fn> }>;
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    for (const resource of ["clients", "purchaseInvoices", "transactions", "journals"]) {
      expect(a[resource]!.invalidateListCache).not.toHaveBeenCalled();
    }
    const listCallsBeforeExecute = a.clients!.listAll.mock.calls.length;
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(true);
    for (const resource of ["clients", "purchaseInvoices", "transactions"]) {
      const invalidate = a[resource]!.invalidateListCache.mock.invocationCallOrder;
      expect(invalidate).toHaveLength(1);
      // The execute run's (first) list read follows the cache drop.
      expect(invalidate[0]!).toBeLessThan(a[resource]!.listAll.mock.invocationCallOrder.at(-1)!);
    }
    expect(a.clients!.listAll.mock.invocationCallOrder[listCallsBeforeExecute]!)
      .toBeGreaterThan(a.clients!.invalidateListCache.mock.invocationCallOrder[0]!);
    // Once before the execute projection, then once more right before the
    // intake duplicate scan that precedes each create (one created receipt).
    expect(a.journals!.invalidateListCache).toHaveBeenCalledTimes(2);
  });

  it("a possible duplicate booked after the dry run drifts the plan; nothing is created", async () => {
    const { api, spies } = makeApi();
    const mocked = api as unknown as {
      readonly: Record<string, ReturnType<typeof vi.fn>>;
      journals: Record<string, ReturnType<typeof vi.fn>>;
    };
    mocked.readonly.getBankAccounts!.mockResolvedValue([{ account_name_est: "LHV", account_no: "1", accounts_dimensions_id: 5001 }]);
    mocked.readonly.getAccountDimensions = vi.fn().mockResolvedValue([{ id: 5001, accounts_id: 1020, title_est: "LHV EUR" }]);
    mocked.journals.listAllWithPostings = vi.fn().mockResolvedValue([]);
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    // A matching bank posting booked elsewhere AFTER the reviewed dry run: the
    // execute projection now holds the row, so the plan fingerprint drifts.
    mocked.journals.listAllWithPostings = vi.fn().mockResolvedValue([{
      id: 555, title: "Manual booking", effective_date: "2026-03-20", registered: true, is_deleted: false,
      postings: [{ accounts_id: 1020, type: "C", amount: 124, accounts_dimensions_id: 5001, is_deleted: false }],
    }]);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("a possible duplicate booked after the execute projection is caught by the uncached pre-create scan", async () => {
    const { api, spies } = makeApi();
    const mocked = api as unknown as {
      readonly: Record<string, ReturnType<typeof vi.fn>>;
      journals: Record<string, ReturnType<typeof vi.fn>>;
    };
    mocked.readonly.getBankAccounts!.mockResolvedValue([{ account_name_est: "LHV", account_no: "1", accounts_dimensions_id: 5001 }]);
    mocked.readonly.getAccountDimensions = vi.fn().mockResolvedValue([{ id: 5001, accounts_id: 1020, title_est: "LHV EUR" }]);
    const suspect = {
      id: 556, title: "Tasumine", effective_date: "2026-03-20", registered: true, is_deleted: false,
      postings: [{ accounts_id: 1020, type: "C", amount: 124, accounts_dimensions_id: 5001, is_deleted: false }],
    };
    // Emulate the journals list cache: a read is served from the cache until
    // invalidateListCache drops it. The suspect is booked right after the second
    // live read (the execute projection's), so only an uncached scan sees it.
    let cached: unknown[] | undefined;
    let liveReads = 0;
    let live: unknown[] = [];
    mocked.journals.invalidateListCache = vi.fn(() => { cached = undefined; });
    mocked.journals.listAllWithPostings = vi.fn(async () => {
      if (cached) return cached;
      cached = live;
      liveReads += 1;
      if (liveReads === 2) live = [suspect];
      return cached;
    });
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    const result = outcome.value.results[0]!;
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(result.status).toBe("needs_review");
    expect(result.possible_duplicate_journal_ids).toEqual([556]);
    expect(result.review_guidance?.recommendation).toContain("556");
    expect(outcome.value.summary.possible_duplicate_review).toBe(1);
    // Invalidation order: projection drop, projection scan, pre-create drop, pre-create scan.
    const invalidateOrder = mocked.journals.invalidateListCache.mock.invocationCallOrder;
    const scanOrder = mocked.journals.listAllWithPostings.mock.invocationCallOrder;
    expect(invalidateOrder).toHaveLength(2);
    const projectionScan = scanOrder.find(order => order > invalidateOrder[0]!)!;
    expect(projectionScan).toBeLessThan(invalidateOrder[1]!);
    expect(invalidateOrder[1]!).toBeLessThan(scanOrder.at(-1)!);
  });

  it("rolls back (invalidates) the created invoice when the document upload fails", async () => {
    const uploadDocument = vi.fn().mockRejectedValue(new Error("upload boom"));
    const { api, spies } = makeApi({ uploadDocument });
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.invalidate).toHaveBeenCalledTimes(1);
    expect(outcome.value.results[0]!.status).toBe("failed");
  });

  it("never auto-retries an ambiguous (network) post-create confirmation failure", async () => {
    const confirmWithTotals = vi.fn().mockRejectedValue(new HttpError("network failure", "network", "PATCH", "/purchase_invoices/555/register"));
    const { api, spies } = makeApi({ confirmWithTotals });
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create_and_confirm,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    // Created exactly once, confirmation attempted exactly once, then compensated
    // (invalidate) and reported — no second create/confirm.
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.confirmWithTotals).toHaveBeenCalledTimes(1);
    expect(spies.invalidate).toHaveBeenCalledTimes(1);
    expect(outcome.value.results[0]!.status).toBe("failed");
  });
});

// P0-3: the SHA-256 manifest alone only proves the file BYTES are unchanged. It
// says nothing about the accounting effect the operator reviewed — the bank
// dimension, the date filters, the create-vs-create_and_confirm mode, the
// per-file supplier/booking projection, or the live bank transactions the batch
// intends to link. The consume-once plan handle binds ALL of that. Every case
// below proves a mutation is refused BEFORE the first API write when any of those
// drift, plus the replay / scope / expiry lifecycle guards. Each asserts the
// create/upload/confirm/invalidate API mocks were NEVER called.
describe("receipt batch typed operation — P0-3 plan-handle drift gate", () => {
  function expectZeroMutation(spies: ApiSpies): void {
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.uploadDocument).not.toHaveBeenCalled();
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
    expect(spies.invalidate).not.toHaveBeenCalled();
  }

  it("refuses create with NO plan_handle even when the manifest matches", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest,
      // planHandle deliberately omitted — the SHA-256 manifest is NOT approval.
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_handle_required");
    expect(outcome.error.code).toBe("plan_handle_required");
    expectZeroMutation(spies);
  });

  it("blocks the same manifest booked against a DIFFERENT bank dimension", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // minted at accountsDimensionsId 100
    const outcome = await ops.runBatch({
      ...baseRun, accountsDimensionsId: 200, // operator silently re-pointed the bank leg
      executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks the same manifest with a CHANGED transaction date range", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // minted with no transaction-date filter
    const outcome = await ops.runBatch({
      ...baseRun, transactionDateFrom: "2026-01-01", transactionDateTo: "2026-01-31",
      executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CREATE handle replayed as create_and_confirm (mode escalation)", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false,
      approvedManifest: manifest, planHandle: planHandles.create, // create approval used to auto-confirm
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CREATE_AND_CONFIRM handle used for a bare create (mode downgrade)", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false,
      approvedManifest: manifest, planHandle: planHandles.create_and_confirm,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CHANGED supplier resolution between dry_run and create", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // reviewed with supplier client id 7
    // The supplier-resolution rule changed under the operator's feet.
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true, created: false, match_type: "exact_name",
      client: {
        id: 9, name: "Different Supplier OU", is_supplier: true, is_client: false,
        cl_code_country: "EST", is_member: false, send_invoice_to_email: false,
        send_invoice_to_accounting_email: false, is_deleted: false,
      },
    } as never);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CHANGED booking projection (article/account) between dry_run and create", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // reviewed with article 501 / account 5230
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: { custom_title: "Service", amount: 1, total_net_price: 100, cl_purchase_articles_id: 999, purchase_accounts_id: 6000 },
      source: "fallback",
      suggested_purchase_article: { id: 999, name: "Something else" },
    } as never);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks when a live bank transaction the plan intended to link has changed", async () => {
    const { api, spies } = makeApi();
    const txListAll = vi.fn();
    (api as { transactions: { listAll: typeof txListAll } }).transactions.listAll = txListAll;
    let liveTransactions: unknown[] = [
      { id: 1, status: "PROJECT", type: "C", amount: 124, base_amount: 124, date: "2026-03-20", accounts_dimensions_id: 100 },
    ];
    txListAll.mockImplementation(async () => liveTransactions.map(tx => ({ ...(tx as object) })));
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    // The live bank row moved (amount corrected upstream) after the operator reviewed.
    liveTransactions = [
      { id: 1, status: "PROJECT", type: "C", amount: 130, base_amount: 130, date: "2026-03-20", accounts_dimensions_id: 100 },
    ];
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("throws manifest_mismatch (zero mutation) when a receipt file's bytes changed", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    // A file in the folder was rewritten after approval; the manifest no longer holds.
    vi.mocked(readFile).mockResolvedValue(Buffer.from("a different receipt pdf") as never);
    await expect(ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    })).rejects.toMatchObject({ category: "manifest_mismatch" });
    expectZeroMutation(spies);
  });

  it("cannot be REPLAYED — a consumed handle is refused with zero further mutation", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const first = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(first.ok).toBe(true);
    const createCallsAfterFirst = spies.createAndSetTotals.mock.calls.length;
    expect(createCallsAfterFirst).toBe(1);
    const replay = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("expected plan_handle_consumed");
    expect(replay.error.code).toBe("plan_handle_consumed");
    // No SECOND create/upload from the replay.
    expect(spies.createAndSetTotals.mock.calls.length).toBe(createCallsAfterFirst);
    expect(spies.uploadDocument.mock.calls.length).toBe(1);
  });

  it("rejects a handle used under a DIFFERENT runtime scope (connection switch)", async () => {
    const { api, spies } = makeApi();
    const { ops, context } = makeOperationsWithContext(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    context.setScope({ verifiedCompanyIdentity: "a-different-company" });
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_scope_mismatch");
    expect(outcome.error.code).toBe("plan_scope_mismatch");
    expectZeroMutation(spies);
  });

  it("rejects an EXPIRED handle (past the plan TTL) with zero mutation", async () => {
    const { api, spies } = makeApi();
    const { ops, context } = makeOperationsWithContext(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    context.advanceTime(601_000); // > 600_000 ms TTL
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_handle_expired");
    expect(outcome.error.code).toBe("plan_handle_expired");
    expectZeroMutation(spies);
  });
});

describe("receipt batch — unresolved supplier duplicate check (live smoke 0.29.2)", () => {
  function primeUnresolvedSupplier(invoiceNumber = "60E2BBAF-0027"): void {
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Anthropic, PBC @anthropic",
      invoice_number: invoiceNumber,
      invoice_date: "2026-09-20",
      due_date: "2026-09-20",
      total_net: 90,
      total_vat: 0,
      total_gross: 90,
      currency: "EUR",
      description: "Claude Max plan",
      raw_text: "ignored",
    } as never);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: false,
      created: false,
      preview_client: {
        name: "Anthropic, PBC @anthropic", is_client: false, is_supplier: true, cl_code_country: "USA",
        is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false,
      },
    } as never);
  }

  function apiWithInvoices(invoices: unknown[]) {
    const made = makeApi();
    (made.api as { purchaseInvoices: { listAll: ReturnType<typeof vi.fn> } }).purchaseInvoices.listAll
      .mockResolvedValue(invoices);
    return made;
  }

  const booked = {
    id: 5501110, number: "60E2BBAF-0027", clients_id: 2010417, client_name: "Anthropic",
    status: "CONFIRMED", create_date: "2026-09-20", journal_date: "2026-09-20", gross_price: 90,
  };

  it("routes to needs_review with duplicate_candidates when another client already has the number", async () => {
    primeUnresolvedSupplier();
    const { api, spies } = apiWithInvoices([booked]);
    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!outcome.ok) throw new Error("runBatch failed");
    const result = outcome.value.results[0]!;
    expect(result.status).toBe("needs_review");
    expect(result.duplicate_candidates?.map(c => c.invoice_id)).toEqual([5501110]);
    expect(result.duplicate_candidates?.[0]?.client_id).toBe(2010417);
    expect(result.notes.join(" ")).toContain("purchase invoice 5501110");
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("matches despite separator differences in the invoice number", async () => {
    primeUnresolvedSupplier("60E2BBAF 0027");
    const { api } = apiWithInvoices([booked]);
    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.results[0]!.status).toBe("needs_review");
    expect(outcome.value.results[0]!.duplicate_candidates?.[0]?.invoice_id).toBe(5501110);
  });

  it("ignores invalidated invoices with the same number", async () => {
    primeUnresolvedSupplier();
    const { api } = apiWithInvoices([{ ...booked, status: "VOID" }]);
    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.results[0]!.duplicate_candidates).toBeUndefined();
  });

  it("never matches an AUTO- placeholder number", async () => {
    primeUnresolvedSupplier("AUTO-20260920-ANTHROPIC");
    const { api } = apiWithInvoices([{ ...booked, number: "AUTO-20260920-ANTHROPIC" }]);
    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.results[0]!.duplicate_candidates).toBeUndefined();
  });

  it("keeps the resolved-supplier exact match as skipped_duplicate", async () => {
    const { api } = apiWithInvoices([{ ...booked, id: 900, number: "INV-1", clients_id: 7, client_name: "Supplier OU", create_date: "2026-03-20", gross_price: 124 }]);
    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.results[0]!.status).toBe("skipped_duplicate");
    expect(outcome.value.results[0]!.duplicate_candidates).toBeUndefined();
  });

  // Codex review: an ambiguous number may match the wrong existing invoice, so
  // a real invoice must not be skipped as its duplicate.
  it.each(["dry_run", "create"] as const)("an ambiguous invoice number matching an existing invoice is reviewed, not skipped (%s)", async (mode) => {
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Supplier OÜ", invoice_number: "INV-1", invoice_date: "2026-03-20", due_date: "2026-03-20",
      total_net: 100, total_vat: 24, total_gross: 124, currency: "EUR", description: "Service", raw_text: "ignored",
      invoice_number_ambiguous: true,
    } as never);
    const { api, spies } = apiWithInvoices([{ ...booked, id: 900, number: "INV-1", clients_id: 7, client_name: "Supplier OU", create_date: "2026-03-20", gross_price: 124 }]);
    const ops = makeOperations(api);
    const dryRun = await ops.runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!dryRun.ok) throw new Error("runBatch failed");
    const outcome = mode === "dry_run" ? dryRun : await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: dryRun.value.manifest, planHandle: dryRun.value.planHandles?.create,
    });
    if (!outcome.ok) throw new Error("runBatch failed");
    const result = outcome.value.results[0]!;
    expect(result.status).toBe("needs_review");
    expect(result.duplicate_match?.invoice_id).toBe(900);
    expect(result.notes.join(" ")).toContain("purchase invoice 900");
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
  });
});

describe("receipt batch — own company name reaches extraction", () => {
  it("passes ownCompanyName to extractReceiptFieldsFromText", async () => {
    const { api } = makeApi();
    const outcome = await makeOperations(api).runBatch({
      ...baseRun, executionMode: "dry_run", dryRun: true, ownCompanyName: "Proovi OÜ",
    });
    expect(outcome.ok).toBe(true);
    expect(vi.mocked(extractReceiptFieldsFromText).mock.calls[0]![2]).toMatchObject({ ownCompanyName: "Proovi OÜ" });
  });
  it("names a sales offer / quote in the needs_review note", async () => {
    vi.mocked(classifyReceiptDocument).mockReturnValue("unclassifiable");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Näidis Meedia AS",
      raw_text: "Meeldetuletus/müügipakkumine nr. 82045101\nTasumiseks: 59,94",
    } as never);
    const { api } = makeApi();
    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.results[0]!.status).toBe("needs_review");
    expect(outcome.value.results[0]!.notes).toContain("Document is a sales offer/quote, not an invoice.");
  });
});

describe("receipt batch — receipt source amount gate (live smoke 1d50fd5)", () => {
  function primeAmounts(amounts: { total_net: number; total_vat: number; total_gross: number }): void {
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Supplier OÜ",
      invoice_number: "INV-1",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      ...amounts,
      currency: "EUR",
      description: "Service",
      raw_text: "ignored",
    } as never);
  }

  async function runMode(api: never, mode: "dry_run" | "create" | "create_and_confirm") {
    const ops = makeOperations(api);
    if (mode === "dry_run") {
      const outcome = await ops.runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
      if (!outcome.ok) throw new Error("runBatch failed");
      return outcome.value.results[0]!;
    }
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: mode, dryRun: false, approvedManifest: manifest, planHandle: planHandles[mode],
    });
    if (!outcome.ok) throw new Error("runBatch failed");
    return outcome.value.results[0]!;
  }

  const sources = [
    { label: "0 / 100 / 100", amounts: { total_net: 0, total_vat: 100, total_gross: 100 }, code: "net_nonpositive_with_vat" },
    { label: "-3.11 / 13.1 / 9.99", amounts: { total_net: -3.11, total_vat: 13.1, total_gross: 9.99 }, code: "net_negative" },
  ];
  for (const source of sources) {
    for (const mode of ["dry_run", "create", "create_and_confirm"] as const) {
      for (const vatRegistered of [true, false]) {
        it(`${source.label} × ${mode} × ${vatRegistered ? "VAT-registered" : "not VAT-registered"} → needs_review, no create`, async () => {
          primeAmounts(source.amounts);
          const { api, spies } = makeApi();
          if (!vatRegistered) {
            (api as unknown as { readonly: Record<string, ReturnType<typeof vi.fn>> }).readonly.getVatInfo!
              .mockResolvedValue({ vat_number: null });
          }
          const result = await runMode(api, mode);
          expect(result.status).toBe("needs_review");
          expect(result.notes.join(" ")).toContain(source.code);
          expect(spies.createAndSetTotals).not.toHaveBeenCalled();
          expect(spies.uploadDocument).not.toHaveBeenCalled();
        });
      }
    }
  }

  it("clean source totals whose synthetic item fails the totals preview are held in the dry run too", async () => {
    // 100 at 24% with VAT 24.02 snaps to 24% (tolerance 0.05) and reconciles,
    // but the residue 0.02 exceeds createAndSetTotals' 0.01 per-item tolerance.
    primeAmounts({ total_net: 100, total_vat: 24.02, total_gross: 124.02 });
    const { api, spies } = makeApi();
    const result = await runMode(api, "dry_run");
    expect(result.status).toBe("needs_review");
    expect(result.notes.join(" ")).toContain("purchase_totals_mismatch");
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("an inconsistent receipt from a new supplier creates no supplier either (zero writes)", async () => {
    primeAmounts({ total_net: 0, total_vat: 100, total_gross: 100 });
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: false,
      created: false,
      preview_client: {
        name: "New Supplier OÜ", code: "17487472", is_client: false, is_supplier: true, cl_code_country: "EST",
        is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false,
      },
    } as never);
    // An unresolved supplier books through the keyword suggestion.
    const actual = await vi.importActual<typeof import("../tools/receipt-extraction.js")>("../tools/receipt-extraction.js");
    vi.mocked(buildKeywordSuggestion).mockReturnValue({
      item: { custom_title: "Service", amount: 1, total_net_price: 0, cl_purchase_articles_id: 501, purchase_accounts_id: 5230 },
      source: "keyword_match",
    } as never);
    try {
      const { api, spies } = makeApi();
      const result = await runMode(api, "create");
      expect(result.status).toBe("needs_review");
      expect(result.notes.join(" ")).toContain("net_nonpositive_with_vat");
      // resolveSupplierInternal(..., allowCreate=true) is the supplier materialization.
      expect(vi.mocked(resolveSupplierInternal).mock.calls.some(call => call[3] === true)).toBe(false);
      expect(spies.createAndSetTotals).not.toHaveBeenCalled();
      expect(spies.uploadDocument).not.toHaveBeenCalled();
    } finally {
      vi.mocked(buildKeywordSuggestion).mockImplementation(actual.buildKeywordSuggestion);
    }
  });
});

describe("receipt batch — document-scope and amount-evidence holds, extraction to execution (WP1)", () => {
  // Real extraction + real summary over crafted documents: each signal must hold
  // the receipt in every creation mode with zero writes, while its clean twin
  // creates (so the signal, not the fixture, is what blocks).
  type Item = { text: string; x: number; y: number };
  const head = ["Supplier OÜ", "Arve nr INV-1", "Kuupäev 20.03.2026"];
  const labelledTrio = ["Summa km-ta 100,00", "Käibemaks 24,00", "Kokku 124,00 EUR"];
  const textDocument = (lines: string[]) => ({ text: lines.join("\n"), pageCount: 1 });
  const layoutDocument = (items: Item[]) => ({
    text: items.map(entry => entry.text).join("\n"),
    pageCount: 1,
    result: { pages: [{ pageNum: 1, textItems: items.map(entry => ({ ...entry, width: 120, height: 12 })) }] },
  });
  const buyerBlockDocument = (buyerLines: string[]) => layoutDocument([
    ...head.map((text, index) => ({ text, x: 52, y: 20 + index * 14 })),
    { text: "Arve saaja:", x: 52, y: 100 },
    ...buyerLines.map((text, index) => ({ text, x: 52, y: 114 + index * 14 })),
    ...labelledTrio.map((text, index) => ({ text, x: 400, y: 300 + index * 16 })),
  ]);

  const cases = [
    {
      signal: "multiple_documents_in_file",
      held: textDocument([...head, "Pileti nr 900000000001", "Pileti nr 900000000002", ...labelledTrio]),
      clean: textDocument([...head, "Pileti nr 900000000001", "Pileti nr 900000000001", ...labelledTrio]),
    },
    {
      signal: "gross_unlabelled",
      // "Käibemaks 24%" is not read as a labelled VAT, so nothing corroborates the gross.
      held: textDocument([...head, "Summa km-ta 100,00", "Käibemaks 24% 24,00", "124,00 EUR"]),
      // A labelled net and labelled VAT adding up to the unlabelled gross.
      clean: textDocument([...head, "Summa km-ta 100,00", "Käibemaks 24,00", "124,00 EUR"]),
    },
    {
      signal: "labelled_amount_over_max",
      held: textDocument([...head, ...labelledTrio, "Summa km-ta 60 000,00"]),
      clean: textDocument([...head, ...labelledTrio]),
    },
    {
      signal: "zero_total_stated",
      held: textDocument([...head, ...labelledTrio, "Ettemaks −124,00", "Arve kokku 0,00"]),
      clean: textDocument([...head, ...labelledTrio, "Tasutud 124,00", "Jäänud tasuda 0,00"]),
    },
    {
      signal: "buyer_not_active_company",
      held: buyerBlockDocument(["Teine Ettevõte OÜ"]),
      clean: buyerBlockDocument(["Proovi OÜ"]),
    },
    {
      signal: "buyer_ambiguous",
      held: buyerBlockDocument(["Teine Ettevõte OÜ", "Proovi OÜ"]),
      clean: buyerBlockDocument(["Proovi OÜ"]),
    },
    {
      // No own-company identifier is known, so a company buyer is unverified;
      // a person as buyer needs no verification.
      signal: "buyer_ownership_unverified",
      held: buyerBlockDocument(["Proovi OÜ"]),
      clean: buyerBlockDocument(["Mari Maasikas"]),
      anonymous: true,
    },
    {
      signal: "invoice_number_ambiguous",
      held: textDocument([...head, "Arve nr INV-2", ...labelledTrio]),
      clean: textDocument([...head, "Arve nr INV-1", ...labelledTrio]),
    },
  ] as const;

  beforeEach(async () => {
    const extraction = await vi.importActual<typeof import("../tools/receipt-extraction.js")>("../tools/receipt-extraction.js");
    const fallback = await vi.importActual<typeof import("../invoice-extraction-fallback.js")>("../invoice-extraction-fallback.js");
    vi.mocked(extractReceiptFieldsFromText).mockImplementation(extraction.extractReceiptFieldsFromText);
    vi.mocked(summarizeInvoiceExtraction).mockImplementation(fallback.summarizeInvoiceExtraction);
  });

  async function runMode(api: never, mode: "dry_run" | "create" | "create_and_confirm", anonymous = false) {
    const ops = makeOperations(api);
    if (anonymous) {
      (api as unknown as { readonly: Record<string, ReturnType<typeof vi.fn>> }).readonly.getVatInfo!.mockResolvedValue({});
    }
    const run = { ...baseRun, ownCompanyName: anonymous ? undefined : "Proovi OÜ" };
    const dryRun = await ops.runBatch({ ...run, executionMode: "dry_run", dryRun: true });
    if (!dryRun.ok) throw new Error("dry run failed");
    if (mode === "dry_run") return dryRun.value.results[0]!;
    const outcome = await ops.runBatch({
      ...run, executionMode: mode, dryRun: false, approvedManifest: dryRun.value.manifest, planHandle: dryRun.value.planHandles?.[mode],
    });
    if (!outcome.ok) throw new Error("runBatch failed");
    return outcome.value.results[0]!;
  }

  for (const testCase of cases) {
    const { signal, held, clean } = testCase;
    const anonymous = "anonymous" in testCase && testCase.anonymous;
    for (const mode of ["dry_run", "create", "create_and_confirm"] as const) {
      it(`${signal} × ${mode} → needs_review, zero writes`, async () => {
        vi.mocked(parseDocument).mockResolvedValue(held as never);
        const { api, spies } = makeApi();
        const result = await runMode(api, mode, anonymous);
        expect(result.status).toBe("needs_review");
        // The signal is the only reason to hold: nothing else would block.
        expect(result.llm_fallback?.confidence_signals.filter(code => code !== "booking_not_from_history")).toEqual([signal]);
        expect(spies.createAndSetTotals).not.toHaveBeenCalled();
        expect(spies.uploadDocument).not.toHaveBeenCalled();
        expect(spies.confirmWithTotals).not.toHaveBeenCalled();
      });
    }

    it(`${signal}: the clean twin creates`, async () => {
      vi.mocked(parseDocument).mockResolvedValue(clean as never);
      const { api, spies } = makeApi();
      const result = await runMode(api, "create", anonymous);
      expect(result.status).toBe("created");
      expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    });
  }
});
