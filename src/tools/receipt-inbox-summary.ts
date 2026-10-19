import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import type {
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptBatchStatus,
  ReceiptBatchSummary,
} from "./receipt-inbox-types.js";

type ResultWithStatus = Pick<ReceiptBatchFileResult, "status" | "possible_duplicate_journal_ids" | "referencing_journal_ids">;
type WorkflowReceiptResult = Pick<ReceiptBatchFileResult, "status" | "llm_fallback"> & object;

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
    possible_duplicate_review: options.results.filter(result =>
      result.status === "needs_review" && (result.possible_duplicate_journal_ids?.length ?? 0) > 0
    ).length,
    referenced_by_journal_review: options.results.filter(result =>
      result.status === "needs_review" && (result.referencing_journal_ids?.length ?? 0) > 0
    ).length,
    dry_run_preview: countStatus(options.results, "dry_run_preview"),
  };
}

export function possibleDuplicateReviewSuffix(count: number): string {
  return count > 0 ? ` (${count} possible duplicate(s) of booked payments)` : "";
}

export function referencedByJournalReviewSuffix(count: number): string {
  return count > 0 ? ` (${count} already referenced by a journal)` : "";
}

export function buildReceiptBatchWorkflowSummary(summary: ReceiptBatchSummary): string {
  const review = `${summary.needs_review} in review${possibleDuplicateReviewSuffix(summary.possible_duplicate_review)}` +
    referencedByJournalReviewSuffix(summary.referenced_by_journal_review);
  return summary.dry_run
    ? `Receipt dry run would create ${summary.dry_run_preview} purchase invoice(s), match ${summary.matched}, skip ${summary.skipped_duplicate} duplicate(s), leave ${review}, and fail ${summary.failed}.`
    : `Receipt batch created ${summary.created} purchase invoice(s), matched ${summary.matched}, skipped ${summary.skipped_duplicate} duplicate(s), left ${review}, and failed ${summary.failed}.`;
}

export function buildReceiptBatchWorkflow(options: {
  summary: ReceiptBatchSummary;
  workflowSummary: string;
  sanitizedResults: WorkflowReceiptResult[];
  workflowArgs: Record<string, unknown>;
}) {
  return buildWorkflowEnvelope({
    summary: options.workflowSummary,
    needs_review: options.sanitizedResults.filter(result => result.status === "needs_review" || result.status === "failed")
      .map(result => result.status === "failed" ? { ...result,
        recommendation: "Inspect the recorded error, any created invoice ID and cleanup outcome. Do not recreate automatically; resolve the known objects before a fresh preview.",
      } : result),
    dry_run_steps: options.summary.dry_run
      ? [{
          tool: "process_receipt_batch",
          summary: options.workflowSummary,
          suggested_args: options.workflowArgs,
          // Slim projection: the only consumer (`receiptSignalCounts` in
          // workflow-response.ts) reads `status` and
          // `llm_fallback.confidence_signals`. Embedding the full sanitized
          // results here duplicated the top-level array — each item can carry
          // up to ~20KB of raw_text plus provenance/candidate arrays — so we
          // project down to just the fields that consumer needs.
          preview: {
            ...options.summary,
            results: options.sanitizedResults.map(result => ({
              status: result.status,
              llm_fallback: { confidence_signals: result.llm_fallback?.confidence_signals ?? [] },
            })),
          },
        }]
      : [],
  });
}

export function buildReceiptBatchExecution(options: {
  mode: "DRY_RUN" | "EXECUTED";
  summary: ReceiptBatchSummary;
  sanitizedResults: WorkflowReceiptResult[];
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
