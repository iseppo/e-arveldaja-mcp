import { beforeEach, describe, expect, it, vi } from "vitest";

// The facade binds each method to ONE existing typed operation. These mocks let
// the test assert the exact op + input mapping each facade method wraps (the
// binding table) without running the real domain I/O. vi.hoisted keeps the
// shared spies available inside the (hoisted) vi.mock factories.
const {
  camtParse,
  camtPrepareImport,
  wisePrepare,
  receiptRunBatch,
  classificationAnalyze,
  reconPrepareInterAccount,
  reconSuggestMatches,
  validateReceiptFolderPath,
  loadOwnCompanyIdentity,
  createClassificationOperations,
} = vi.hoisted(() => ({
  camtParse: vi.fn(),
  camtPrepareImport: vi.fn(),
  wisePrepare: vi.fn(),
  receiptRunBatch: vi.fn(),
  classificationAnalyze: vi.fn(),
  reconPrepareInterAccount: vi.fn(),
  reconSuggestMatches: vi.fn(),
  validateReceiptFolderPath: vi.fn(),
  loadOwnCompanyIdentity: vi.fn(),
  createClassificationOperations: vi.fn(),
}));

vi.mock("./camt/operations.js", () => ({
  createCamtOperations: vi.fn(() => ({ parse: camtParse, prepareImport: camtPrepareImport, executeImport: vi.fn() })),
}));
vi.mock("./wise/operations.js", () => ({
  createWiseOperations: vi.fn(() => ({ prepare: wisePrepare, execute: vi.fn() })),
}));
vi.mock("./receipts/batch-operations.js", () => ({
  createReceiptBatchOperations: vi.fn(() => ({ scan: vi.fn(), runBatch: receiptRunBatch })),
}));
vi.mock("./receipts/classification-operations.js", () => ({
  createClassificationOperations: (...args: unknown[]) => {
    createClassificationOperations(...args);
    return { analyzeUnmatched: classificationAnalyze, applyClassifications: vi.fn() };
  },
}));
vi.mock("./banking/reconciliation/operations.js", () => ({
  createBankReconciliationOperations: vi.fn(() => ({
    suggestMatches: reconSuggestMatches,
    prepareExactConfirm: vi.fn(),
    executeExactConfirm: vi.fn(),
    prepareInterAccount: reconPrepareInterAccount,
    executeInterAccount: vi.fn(),
  })),
}));
vi.mock("./tools/receipt-inbox-files.js", () => ({ validateReceiptFolderPath }));
vi.mock("./tools/receipt-inbox.js", () => ({ loadOwnCompanyIdentity }));

import { createAccountingOperations } from "./accounting-operations.js";
import { wrapUntrustedOcr } from "./mcp-json.js";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";

function okOutcome<T>(value: T) {
  return { ok: true as const, value, warnings: [], blockers: [] };
}

const api = { readonly: {} } as never;
const rsc = createTestRuntimeSafetyContext();

describe("createAccountingOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateReceiptFolderPath.mockResolvedValue("/canonical/receipts");
    loadOwnCompanyIdentity.mockResolvedValue({ status: "available", invoiceCompanyName: "Seppo AI OÜ" });
  });

  it("exposes exactly the six dry-run read/preview methods", () => {
    const operations = createAccountingOperations(api, rsc);
    expect(typeof operations.parseBankInput).toBe("function");
    expect(typeof operations.prepareCamtImport).toBe("function");
    expect(typeof operations.prepareWiseImport).toBe("function");
    expect(typeof operations.prepareReceiptBatch).toBe("function");
    expect(typeof operations.classifyTransactions).toBe("function");
    expect(typeof operations.prepareInterAccount).toBe("function");
  });

  it("parseBankInput binds to camt.parse and returns its outcome", async () => {
    const outcome = okOutcome({ statement_metadata: { iban: "EE00" }, entries: [], summary: {} });
    camtParse.mockResolvedValue(outcome);
    const operations = createAccountingOperations(api, rsc);
    const source = { file_path: "/inbox/bank.xml" };
    const result = await operations.parseBankInput({ source });
    expect(camtParse).toHaveBeenCalledWith({ source });
    expect(result).toBe(outcome);
  });

  it("prepareCamtImport binds to camt.prepareImport with the dry-run import input", async () => {
    const outcome = okOutcome({ createdCount: 3 });
    camtPrepareImport.mockResolvedValue(outcome);
    const operations = createAccountingOperations(api, rsc);
    const input = { source: { file_path: "/inbox/bank.xml" }, accountsDimensionsId: 101, dateFrom: undefined, dateTo: undefined };
    const result = await operations.prepareCamtImport(input);
    expect(camtPrepareImport).toHaveBeenCalledWith(input);
    expect(result).toBe(outcome);
  });

  it("prepareWiseImport binds to wise.prepare", async () => {
    const outcome = okOutcome({ created: [] });
    wisePrepare.mockResolvedValue(outcome);
    const operations = createAccountingOperations(api, rsc);
    const input = {
      source: { file_path: "/inbox/wise.csv" },
      accountsDimensionsId: 202,
      feeAccountDimensionsId: undefined,
      feeAccountRelationId: undefined,
      interAccountDimensionId: undefined,
      confirmOwnTransferIds: undefined,
      approvedCommandDigest: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      skipJarTransfers: undefined,
    };
    const result = await operations.prepareWiseImport(input);
    expect(wisePrepare).toHaveBeenCalledWith(input);
    expect(result).toBe(outcome);
  });

  it("classifyTransactions binds to classification.analyzeUnmatched (facade injects wrapUntrustedOcr)", async () => {
    const outcome = okOutcome({ totalUnmatched: 0, categoryCounts: {}, groups: [] });
    classificationAnalyze.mockResolvedValue(outcome);
    const operations = createAccountingOperations(api, rsc);
    const input = { accountsDimensionsId: 303 };
    const result = await operations.classifyTransactions(input);
    expect(classificationAnalyze).toHaveBeenCalledWith(input);
    expect(result).toBe(outcome);
    // The classification factory must receive wrapUntrustedOcr (M10 wrapping stays
    // injected, exactly as the receipt-inbox adapter constructs it).
    expect(createClassificationOperations).toHaveBeenCalledWith(api, rsc, wrapUntrustedOcr);
  });

  it("prepareInterAccount binds to reconciliation.prepareInterAccount, NOT suggestMatches", async () => {
    const outcome = okOutcome({ match: { matchedPairs: [] }, planHandle: "h" });
    reconPrepareInterAccount.mockResolvedValue(outcome);
    const operations = createAccountingOperations(api, rsc);
    const input = { maxDateGap: undefined, targetAccountsDimensionsId: undefined };
    const result = await operations.prepareInterAccount(input);
    expect(reconPrepareInterAccount).toHaveBeenCalledWith(input);
    expect(reconSuggestMatches).not.toHaveBeenCalled();
    expect(result).toBe(outcome);
  });

  it("prepareReceiptBatch resolves the folder, loads own-company identity, and runs a dry-run batch", async () => {
    const outcome = okOutcome({ mode: "DRY_RUN", results: [], summary: {} });
    receiptRunBatch.mockResolvedValue(outcome);
    const operations = createAccountingOperations(api, rsc);
    const result = await operations.prepareReceiptBatch({ folderPath: "/inbox/receipts", accountsDimensionsId: 404 });

    expect(validateReceiptFolderPath).toHaveBeenCalledWith("/inbox/receipts");
    expect(loadOwnCompanyIdentity).toHaveBeenCalledWith(api);
    expect(receiptRunBatch).toHaveBeenCalledWith(expect.objectContaining({
      resolvedFolderPath: "/canonical/receipts",
      accountsDimensionsId: 404,
      executionMode: "dry_run",
      legacyExecuteCreate: false,
      dryRun: true,
      directoryAccessOptions: {},
      ownCompanyName: "Seppo AI OÜ",
      // The inbox consumer discards planHandles. Minting them here leaked two
      // plan-store slots per folder per scan, and the store THROWS at capacity
      // instead of evicting — a few scans took every approval path down until
      // the 10-minute TTL drained.
      mintPlanHandles: false,
    }));
    expect(result).toBe(outcome);
  });

  it("prepareReceiptBatch fails closed when the own-company identity read is a retryable error", async () => {
    loadOwnCompanyIdentity.mockResolvedValue({ status: "retryable_error", reason: "invoice_info 503" });
    const operations = createAccountingOperations(api, rsc);
    await expect(operations.prepareReceiptBatch({ folderPath: "/inbox/receipts", accountsDimensionsId: 404 }))
      .rejects.toThrow(/invoice_info 503/);
    expect(receiptRunBatch).not.toHaveBeenCalled();
  });
});
