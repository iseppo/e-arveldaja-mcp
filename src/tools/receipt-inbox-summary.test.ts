import { describe, it, expect } from "vitest";
import { buildReceiptBatchWorkflow } from "./receipt-inbox-summary.js";
import type { ReceiptBatchFileResult, ReceiptBatchSummary } from "./receipt-inbox-types.js";
import type { InvoiceExtractionFallback } from "../invoice-extraction-fallback.js";
import type { ExtractedReceiptFields } from "./receipt-extraction.js";

const RAW_TEXT_SENTINEL = "RAWTEXT_SENTINEL_SHOULD_NOT_LEAK";

function summary(overrides: Partial<ReceiptBatchSummary> = {}): ReceiptBatchSummary {
  return {
    execution_mode: "dry_run",
    legacy_execute_create: false,
    dry_run: true,
    scanned_files: 1,
    skipped_invalid_files: 0,
    created: 0,
    matched: 0,
    skipped_duplicate: 0,
    failed: 0,
    needs_review: 0,
    dry_run_preview: 1,
    ...overrides,
  };
}

function dryRunPreviewResult(signals: string[]): ReceiptBatchFileResult {
  return {
    file: {
      name: "receipt.pdf",
      path: "/tmp/receipt.pdf",
      extension: ".pdf",
      file_type: "pdf",
      size_bytes: 100,
      modified_at: "2026-01-01T00:00:00.000Z",
    },
    classification: "purchase_invoice",
    status: "dry_run_preview",
    extracted: { raw_text: RAW_TEXT_SENTINEL.repeat(500) } as ExtractedReceiptFields,
    llm_fallback: { confidence_signals: signals } as InvoiceExtractionFallback,
  };
}

describe("buildReceiptBatchWorkflow — slim preview.results projection (#8)", () => {
  it("does not embed the full sanitized results (raw_text stays out of the workflow envelope)", () => {
    const workflow = buildReceiptBatchWorkflow({
      summary: summary(),
      workflowSummary: "Receipt dry run would create 1 invoice.",
      sanitizedResults: [dryRunPreviewResult([])],
      workflowArgs: { folder_path: "/tmp", execution_mode: "dry_run" },
    });

    expect(JSON.stringify(workflow)).not.toContain(RAW_TEXT_SENTINEL);
  });

  it("preserves confidence_signals so OCR-quality blocking still fires", () => {
    const workflow = buildReceiptBatchWorkflow({
      summary: summary(),
      workflowSummary: "Receipt dry run would create 1 invoice.",
      sanitizedResults: [dryRunPreviewResult(["low_ocr_confidence"])],
      workflowArgs: { folder_path: "/tmp", execution_mode: "dry_run" },
    });

    // The slim projection keeps llm_fallback.confidence_signals, so
    // receiptSignalCounts still sees the low-OCR signal and blocks approval.
    const blocked = workflow.available_actions.find(action =>
      typeof action.why === "string" && action.why.includes("low OCR confidence"),
    );
    expect(blocked).toBeDefined();
    // And no approval preview was emitted for a blocked batch.
    expect(workflow.approval_previews).toHaveLength(0);
  });
});
