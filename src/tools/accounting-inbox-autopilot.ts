export interface ReceiptDryRunPreview extends Record<string, unknown> {
  created: number;
  dry_run_preview: number;
  matched: number;
  skipped_duplicate: number;
  needs_review: number;
  failed: number;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function buildReceiptDryRunPreview(summary: Record<string, unknown>): ReceiptDryRunPreview {
  return {
    created: numberAt(summary, "created") ?? 0,
    dry_run_preview: numberAt(summary, "dry_run_preview") ?? 0,
    matched: numberAt(summary, "matched") ?? 0,
    skipped_duplicate: numberAt(summary, "skipped_duplicate") ?? 0,
    needs_review: numberAt(summary, "needs_review") ?? 0,
    failed: numberAt(summary, "failed") ?? 0,
  };
}

export function summarizeReceiptDryRunPreview(preview: ReceiptDryRunPreview): string {
  return `Receipt dry run would create ${preview.dry_run_preview} invoice(s), match ${preview.matched}, skip ${preview.skipped_duplicate} duplicate(s), leave ${preview.needs_review} in review, and fail ${preview.failed}.`;
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
