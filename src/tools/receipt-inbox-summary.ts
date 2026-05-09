import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import type {
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptBatchStatus,
  ReceiptBatchSummary,
} from "./receipt-inbox-types.js";

type ResultWithStatus = Pick<ReceiptBatchFileResult, "status">;

function countStatus(results: ResultWithStatus[], status: ReceiptBatchStatus): number {
  return results.filter(result => result.status === status).length;
}

export function buildReceiptBatchSummary(options: {
  executionMode: ReceiptBatchExecutionMode;
  legacyExecuteCreate: boolean;
  dryRun: boolean;
  scannedFiles: number;
  skippedInvalidFiles: number;
  results: ResultWithStatus[];
}): ReceiptBatchSummary {
  return {
    execution_mode: options.executionMode,
    legacy_execute_create: options.legacyExecuteCreate,
    dry_run: options.dryRun,
    scanned_files: options.scannedFiles,
    skipped_invalid_files: options.skippedInvalidFiles,
    created: countStatus(options.results, "created"),
    matched: countStatus(options.results, "matched"),
    skipped_duplicate: countStatus(options.results, "skipped_duplicate"),
    failed: countStatus(options.results, "failed"),
    needs_review: countStatus(options.results, "needs_review"),
    dry_run_preview: countStatus(options.results, "dry_run_preview"),
  };
}

export function buildReceiptBatchWorkflowSummary(summary: ReceiptBatchSummary): string {
  return summary.dry_run
    ? `Receipt dry run would create ${summary.dry_run_preview} purchase invoice(s), match ${summary.matched}, skip ${summary.skipped_duplicate} duplicate(s), leave ${summary.needs_review} in review, and fail ${summary.failed}.`
    : `Receipt batch created ${summary.created} purchase invoice(s), matched ${summary.matched}, skipped ${summary.skipped_duplicate} duplicate(s), left ${summary.needs_review} in review, and failed ${summary.failed}.`;
}

export function buildReceiptBatchWorkflow(options: {
  summary: ReceiptBatchSummary;
  workflowSummary: string;
  sanitizedResults: ReceiptBatchFileResult[];
  workflowArgs: Record<string, unknown>;
}) {
  return buildWorkflowEnvelope({
    summary: options.workflowSummary,
    needs_review: options.sanitizedResults.filter(result => result.status === "needs_review"),
    dry_run_steps: options.summary.dry_run
      ? [{
          tool: "process_receipt_batch",
          summary: options.workflowSummary,
          suggested_args: options.workflowArgs,
          preview: options.summary,
        }]
      : [],
  });
}

export function buildReceiptBatchExecution(options: {
  mode: "DRY_RUN" | "EXECUTED";
  summary: ReceiptBatchSummary;
  sanitizedResults: ReceiptBatchFileResult[];
}) {
  return buildBatchExecutionContract({
    mode: options.mode,
    summary: { ...options.summary },
    results: options.sanitizedResults.filter(result =>
      result.status === "created" ||
      result.status === "matched" ||
      result.status === "dry_run_preview"
    ),
    skipped: options.sanitizedResults.filter(result => result.status === "skipped_duplicate"),
    errors: options.sanitizedResults.filter(result => result.status === "failed"),
    needs_review: options.sanitizedResults.filter(result => result.status === "needs_review"),
  });
}
