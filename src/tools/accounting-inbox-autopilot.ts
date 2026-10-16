import { numberAt } from "../record-utils.js";
import { possibleDuplicateReviewSuffix, referencedByJournalReviewSuffix } from "./receipt-inbox-summary.js";

export interface ReceiptDryRunPreview extends Record<string, unknown> {
  created: number;
  dry_run_preview: number;
  matched: number;
  skipped_duplicate: number;
  needs_review: number;
  possible_duplicate_review: number;
  referenced_by_journal_review: number;
  failed: number;
}

export function buildReceiptDryRunPreview(summary: Record<string, unknown>): ReceiptDryRunPreview {
  return {
    created: numberAt(summary, "created") ?? 0,
    dry_run_preview: numberAt(summary, "dry_run_preview") ?? 0,
    matched: numberAt(summary, "matched") ?? 0,
    skipped_duplicate: numberAt(summary, "skipped_duplicate") ?? 0,
    needs_review: numberAt(summary, "needs_review") ?? 0,
    possible_duplicate_review: numberAt(summary, "possible_duplicate_review") ?? 0,
    referenced_by_journal_review: numberAt(summary, "referenced_by_journal_review") ?? 0,
    failed: numberAt(summary, "failed") ?? 0,
  };
}

export function summarizeReceiptDryRunPreview(preview: ReceiptDryRunPreview): string {
  return `Receipt dry run would create ${preview.dry_run_preview} invoice(s), match ${preview.matched}, skip ${preview.skipped_duplicate} duplicate(s), leave ${preview.needs_review} in review${possibleDuplicateReviewSuffix(preview.possible_duplicate_review)}${referencedByJournalReviewSuffix(preview.referenced_by_journal_review)}, and fail ${preview.failed}.`;
}

export function receiptDryRunLeavesPendingMaterialization(
  preview: Record<string, unknown> | undefined,
): boolean {
  if (!preview) return false;
  return (numberAt(preview, "created") ?? 0) > 0 ||
    (numberAt(preview, "dry_run_preview") ?? 0) > 0 ||
    (numberAt(preview, "matched") ?? 0) > 0 ||
    (numberAt(preview, "needs_review") ?? 0) > 0 ||
    (numberAt(preview, "failed") ?? 0) > 0;
}
