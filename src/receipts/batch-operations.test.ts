import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { getAllowedRoots, resolveFilePath, validateFilePath } from "../file-validation.js";
import { parseDocument } from "../document-parser.js";
import {
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
        stat: vi.fn().mockResolvedValue({
          isDirectory: () => !isFile,
          isFile: () => isFile,
          size: isFile ? 512 : 0,
        }),
        readFile: vi.fn().mockImplementation(() => readFileMock(path)),
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

vi.mock("../tools/receipt-extraction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/receipt-extraction.js")>()),
  classifyReceiptDocument: vi.fn(),
  extractReceiptFieldsFromText: vi.fn(),
  hasAutoBookableReceiptFields: vi.fn(),
  suggestBookingInternal: vi.fn(),
}));

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
    if (String(path) === FOLDER) return { isDirectory: () => true } as never;
    return {
      isDirectory: () => false,
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
    clients: { listAll: vi.fn().mockResolvedValue([]) },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
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
    transactions: { listAll: vi.fn().mockResolvedValue([]) },
    journals: { listAll: vi.fn().mockResolvedValue([]) },
  } as never;
  return { api, spies: { createAndSetTotals, uploadDocument, confirmWithTotals, invalidate } };
}

function makeOperations(api: never) {
  return createReceiptBatchOperations(api, createTestRuntimeSafetyContext());
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

  async function dryRunManifest(api: never): Promise<ReceiptApprovedManifestEntry[]> {
    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    if (!outcome.ok) throw new Error("dry run failed");
    return outcome.value.manifest;
  }

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
    const manifest = await dryRunManifest(api);
    const outcome = await makeOperations(api).runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest,
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
    const manifest = await dryRunManifest(api);
    const outcome = await makeOperations(api).runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false, approvedManifest: manifest,
    });
    expect(outcome.ok).toBe(true);
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.uploadDocument).toHaveBeenCalledTimes(1);
    expect(spies.confirmWithTotals).toHaveBeenCalledTimes(1);
  });

  it("rolls back (invalidates) the created invoice when the document upload fails", async () => {
    const uploadDocument = vi.fn().mockRejectedValue(new Error("upload boom"));
    const { api, spies } = makeApi({ uploadDocument });
    const manifest = await dryRunManifest(api);
    const outcome = await makeOperations(api).runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest,
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
    const manifest = await dryRunManifest(api);
    const outcome = await makeOperations(api).runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false, approvedManifest: manifest,
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
