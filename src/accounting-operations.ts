import type { OperationOutcome } from "./operation-outcome.js";
import type { ApiContext } from "./tools/crud-tools.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "./runtime-safety-context.js";
import { wrapUntrustedOcr } from "./mcp-json.js";
import {
  createCamtOperations,
  type CamtImportInput,
  type CamtOperations,
  type ParseCamtInput,
} from "./camt/operations.js";
import type { CamtImportPreview } from "./camt/presenter.js";
import type { CamtParseResult } from "./camt/types.js";
import { createWiseOperations, type WiseOperations, type WisePrepareInput } from "./wise/operations.js";
import type { WiseImportPreview } from "./wise/presenter.js";
import { createReceiptBatchOperations, type ReceiptBatchOperations } from "./receipts/batch-operations.js";
import type { ReceiptBatchResult } from "./receipts/types.js";
import {
  createClassificationOperations,
  type ClassificationOperations,
  type UnmatchedAnalysisInput,
  type UnmatchedAnalysisResult,
} from "./receipts/classification-operations.js";
import { createBankReconciliationOperations } from "./banking/reconciliation/operations.js";
import type {
  BankReconciliationOperations,
  InterAccountInput,
  InterAccountPreview,
} from "./banking/reconciliation/types.js";
import { validateReceiptFolderPath } from "./tools/receipt-inbox-files.js";
import { loadOwnCompanyIdentity } from "./tools/receipt-inbox.js";

// Typed facade over the PR4-9 domain operations for the Accounting Inbox
// dry-run pipeline. It replaces the former captured-MCP-handler round-trip: the
// pipeline now calls these methods directly and reads the typed
// OperationOutcome<T>.value, so there is no fake McpServer, no handler Map, and
// no parseMcpResponse serialization boundary.
//
// The interface references NO MCP types — inputs are plain typed data derived
// from the inbox's own recommended-step suggested_args, and results are the
// operations' UNWRAPPED domain values. All untrusted-text sandboxing stays in
// the inbox presenter layer, exactly as before. Only READ/PREVIEW (dry-run)
// methods are bound: the autopilot never applies/mutates, so the execute/apply
// op methods are intentionally not exposed here.

/**
 * Inbox-shaped input for the receipt dry-run. The inbox recommends receipt steps
 * with a RAW `folder_path` it scanned itself; the facade resolves + revalidates
 * that path and loads the active company identity (the #22 self-match guard),
 * exactly as the receipt tool adapter does before invoking the batch operation.
 */
export interface ReceiptBatchDryRunInput {
  readonly folderPath: string;
  readonly accountsDimensionsId: number;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly transactionDateFrom?: string;
  readonly transactionDateTo?: string;
}

export interface AccountingOperations {
  /** parse_camt053 — read-only statement preview. */
  parseBankInput(input: ParseCamtInput): Promise<OperationOutcome<CamtParseResult>>;
  /** import_camt053 (execute:false) — CAMT import dry-run preview. */
  prepareCamtImport(input: CamtImportInput): Promise<OperationOutcome<CamtImportPreview>>;
  /** import_wise_transactions (execute:false) — Wise import dry-run preview. */
  prepareWiseImport(input: WisePrepareInput): Promise<OperationOutcome<WiseImportPreview>>;
  /** process_receipt_batch (execution_mode:dry_run) — receipt batch dry-run. */
  prepareReceiptBatch(input: ReceiptBatchDryRunInput): Promise<OperationOutcome<ReceiptBatchResult>>;
  /** classify_unmatched_transactions — read-only unmatched-transaction analysis. */
  classifyTransactions(input: UnmatchedAnalysisInput): Promise<OperationOutcome<UnmatchedAnalysisResult>>;
  /**
   * reconcile_inter_account_transfers (execute:false) — inter-account transfer
   * dry-run. Bound to prepareInterAccount, NOT suggestMatches: the inbox dry-run
   * runs the inter-account reconcile, so binding to suggestMatches would change
   * what the dry-run reconciles.
   */
  prepareInterAccount(input: InterAccountInput): Promise<OperationOutcome<InterAccountPreview>>;
}

class AccountingOperationsImpl implements AccountingOperations {
  private readonly camt: CamtOperations;
  private readonly wise: WiseOperations;
  private readonly receipts: ReceiptBatchOperations;
  private readonly classification: ClassificationOperations;
  private readonly reconciliation: BankReconciliationOperations;

  constructor(
    private readonly api: ApiContext,
    runtimeSafetyContext: RuntimeSafetyContext,
  ) {
    this.camt = createCamtOperations(api, runtimeSafetyContext);
    this.wise = createWiseOperations(api, runtimeSafetyContext);
    this.receipts = createReceiptBatchOperations(api, runtimeSafetyContext);
    // wrapUntrustedOcr is injected so the classification operation module never
    // imports it (M10): the operation returns unwrapped data and the presenter
    // owns output-time sandboxing — same construction the receipt-inbox adapter uses.
    this.classification = createClassificationOperations(api, runtimeSafetyContext, wrapUntrustedOcr);
    this.reconciliation = createBankReconciliationOperations(api, runtimeSafetyContext);
  }

  parseBankInput(input: ParseCamtInput): Promise<OperationOutcome<CamtParseResult>> {
    return this.camt.parse(input);
  }

  prepareCamtImport(input: CamtImportInput): Promise<OperationOutcome<CamtImportPreview>> {
    return this.camt.prepareImport(input);
  }

  prepareWiseImport(input: WisePrepareInput): Promise<OperationOutcome<WiseImportPreview>> {
    return this.wise.prepare(input);
  }

  async prepareReceiptBatch(input: ReceiptBatchDryRunInput): Promise<OperationOutcome<ReceiptBatchResult>> {
    // Resolve + revalidate the scanned folder path (realpath, allowed-roots,
    // is-directory) exactly as the receipt tool adapter does for a raw folder_path.
    const resolvedFolderPath = await validateReceiptFolderPath(input.folderPath);
    // Fail closed if the active company identity read fails transiently — the
    // #22 self-match guard depends on it, so a weakened guard must not run.
    const identity = await loadOwnCompanyIdentity(this.api);
    if (identity.status === "retryable_error") {
      throw new Error(`Receipt batch dry run could not load the active company identity: ${identity.reason}`);
    }
    return this.receipts.runBatch({
      resolvedFolderPath,
      accountsDimensionsId: input.accountsDimensionsId,
      executionMode: "dry_run",
      legacyExecuteCreate: false,
      dryRun: true,
      ...(input.dateFrom !== undefined ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo !== undefined ? { dateTo: input.dateTo } : {}),
      ...(input.transactionDateFrom !== undefined ? { transactionDateFrom: input.transactionDateFrom } : {}),
      ...(input.transactionDateTo !== undefined ? { transactionDateTo: input.transactionDateTo } : {}),
      directoryAccessOptions: {},
      ...(identity.invoiceCompanyName !== undefined ? { ownCompanyName: identity.invoiceCompanyName } : {}),
    });
  }

  classifyTransactions(input: UnmatchedAnalysisInput): Promise<OperationOutcome<UnmatchedAnalysisResult>> {
    return this.classification.analyzeUnmatched(input);
  }

  prepareInterAccount(input: InterAccountInput): Promise<OperationOutcome<InterAccountPreview>> {
    return this.reconciliation.prepareInterAccount(input);
  }
}

export function createAccountingOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): AccountingOperations {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  return new AccountingOperationsImpl(api, runtimeSafetyContext);
}
