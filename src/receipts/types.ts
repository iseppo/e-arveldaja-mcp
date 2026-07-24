import type { ReceiptDirectoryAccessOptions } from "../tools/receipt-inbox-files.js";
import type {
  ReceiptApprovedManifestEntry,
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptBatchSummary,
  ReceiptFileInfo,
  ReceiptScanResult,
} from "../tools/receipt-inbox-types.js";

// Shared type home for the typed receipt batch operation. The batch domain
// types already live in ../tools/receipt-inbox-types.js; re-export them here so
// the operation/presenter refer to `../receipts/types.js` without duplicating
// the definitions (WRAP, don't fork).
export type {
  ReceiptApprovedManifestEntry,
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptBatchSummary,
  ReceiptFileInfo,
  ReceiptScanResult,
} from "../tools/receipt-inbox-types.js";
export type { ReceiptDirectoryAccessOptions } from "../tools/receipt-inbox-files.js";

/**
 * Resolved inputs for one receipt-batch run. The file-reference resolution,
 * point-of-use revalidation, manifest normalization, own-company identity load,
 * and the identity/approved-manifest safety gates all run in the tool adapter
 * BEFORE the operation is invoked (they need the fileReferenceStore and their
 * ordering is load-bearing). The operation receives already-resolved primitives
 * plus the normalized manifest, snapshots the folder bytes (binding the manifest
 * exactly as before), and runs the per-file loop. It references NO MCP types.
 */
export interface ReceiptBatchRunInput {
  /** Point-of-use revalidated folder path the snapshot is taken from. */
  readonly resolvedFolderPath: string;
  readonly accountsDimensionsId: number;
  readonly executionMode: ReceiptBatchExecutionMode;
  readonly legacyExecuteCreate: boolean;
  readonly dryRun: boolean;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly transactionDateFrom?: string;
  readonly transactionDateTo?: string;
  /** Normalized (file_ref → relative_path resolved) approved manifest, or
   * undefined for dry_run / when none was supplied. */
  readonly approvedManifest?: readonly ReceiptApprovedManifestEntry[];
  readonly directoryAccessOptions: ReceiptDirectoryAccessOptions;
  /** invoice_company_name from the already-loaded own-company identity. */
  readonly ownCompanyName?: string;
  /** P0-3: REQUIRED for create / create_and_confirm. The consume-once handle
   * minted by the matching dry_run for THIS execution effect. A missing /
   * replayed / out-of-scope / expired handle, or one minted for the other effect
   * (create vs create_and_confirm), fails closed with zero mutation. */
  readonly planHandle?: string;
}

export interface ReceiptScanRunInput {
  readonly resolvedFolderPath: string;
  readonly fileTypes?: ("pdf" | "jpg" | "png")[];
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly directoryAccessOptions: ReceiptDirectoryAccessOptions;
}

/** Minimal per-file snapshot identity the presenter needs to mint file
 * references for the response manifest (path + name + content digest). */
export interface ReceiptBatchSnapshotFile {
  readonly file: ReceiptFileInfo;
  readonly sha256: string;
}

/**
 * UNWRAPPED structured result of a receipt batch. Carries plain domain data —
 * the presenter owns ALL OCR/untrusted-text sandboxing (wrapUntrustedOcr,
 * sanitizeReceiptResultForOutput) and the file-reference projection.
 */
export interface ReceiptBatchResult {
  readonly mode: "DRY_RUN" | "EXECUTED";
  readonly executionMode: ReceiptBatchExecutionMode;
  readonly scan: ReceiptScanResult;
  readonly results: ReceiptBatchFileResult[];
  readonly summary: ReceiptBatchSummary;
  readonly manifest: ReceiptApprovedManifestEntry[];
  readonly snapshotFiles: ReceiptBatchSnapshotFile[];
  /** P0-3: minted on dry_run only — the consume-once handles the operator must
   * present to actually mutate. Each is bound to ONE execution effect so a
   * `create` approval can never be replayed as `create_and_confirm`. */
  readonly planHandles?: {
    readonly create: string;
    readonly create_and_confirm: string;
  };
}
