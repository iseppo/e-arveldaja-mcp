import { describe, it, expect } from "vitest";
import { renderReceiptBatchCompact, type ReceiptBatchCompactInput } from "./presenter.js";
import { buildReceiptBatchSummary } from "../tools/receipt-inbox-summary.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "../response-budget.js";
import type {
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptBatchResult,
  ReceiptBatchStatus,
} from "./types.js";

// Task 8 / PR6A (Phase B): the guided compact receipt-batch response must carry
// EVERY approval-summary field, NEVER hide blockers/partial mutations, wrap
// untrusted OCR free-text, and direct the exact next action (dry_run → create;
// create/create_and_confirm → continue_accounting_workflow). It OMITS clean
// per-file rows (samples ≤ 3) and never inlines raw OCR text. The DRY_RUN compact
// INLINES the approved manifest (the reviewed-set bytes the guided user must
// resend to mode=create — a self-completable flow), staying bounded under the
// batch budget; the create/create_and_confirm compacts carry NO manifest and are
// strictly ~O(1) in size.

const OCR = /UNTRUSTED_OCR_START/;

function fileResult(
  index: number,
  status: ReceiptBatchStatus,
  extra: Partial<ReceiptBatchFileResult> = {},
): ReceiptBatchFileResult {
  return {
    file: {
      name: `receipt-${index}.pdf`,
      path: `/receipts/receipt-${index}.pdf`,
      extension: ".pdf",
      file_type: "pdf",
      size_bytes: 1000,
      modified_at: "2026-03-01T00:00:00Z",
    },
    classification: "purchase_invoice",
    status,
    extracted: {
      supplier_name: `Supplier ${index} OÜ`,
      invoice_number: `INV-${index}`,
      invoice_date: "2026-03-01",
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      currency: "EUR",
    },
    notes: [],
    ...extra,
  };
}

function makeBatch(
  cleanRows: number,
  options: {
    executionMode?: ReceiptBatchExecutionMode;
    dryRun?: boolean;
    extraRows?: ReceiptBatchFileResult[];
  } = {},
): ReceiptBatchResult {
  const executionMode = options.executionMode ?? "dry_run";
  const dryRun = options.dryRun ?? executionMode === "dry_run";
  const cleanStatus: ReceiptBatchStatus = dryRun ? "dry_run_preview" : "created";
  const results = [
    ...Array.from({ length: cleanRows }, (_, index) =>
      fileResult(
        index,
        cleanStatus,
        dryRun
          ? {}
          : { created_invoice: { number: `AUTO-${index}`, id: 5000 + index, confirmed: executionMode === "create_and_confirm" } },
      ),
    ),
    ...(options.extraRows ?? []),
  ];
  const summary = buildReceiptBatchSummary({
    executionMode,
    legacyExecuteCreate: false,
    dryRun,
    scannedFiles: results.length,
    skippedInvalidFiles: 0,
    results,
  });
  return {
    mode: dryRun ? "DRY_RUN" : "EXECUTED",
    executionMode,
    scan: { files: [], skipped: [], folder_path: "/receipts", total_candidates: results.length },
    results,
    summary,
    manifest: results.map((row, index) => ({ relative_path: row.file.name, sha256: `${index}`.padStart(64, "0") })),
    snapshotFiles: [],
  };
}

function compactInput(result: ReceiptBatchResult, extra: Partial<ReceiptBatchCompactInput> = {}): ReceiptBatchCompactInput {
  return {
    result,
    accountsDimensionsId: 7,
    executionMode: result.executionMode,
    workflowFolderPath: "/receipts",
    ...extra,
  };
}

describe("renderReceiptBatchCompact — size", () => {
  it("dry_run inlines the manifest but stays bounded under the batch budget at 100 files", () => {
    const bytes10 = mcpPayloadBytes(renderReceiptBatchCompact(compactInput(makeBatch(10))));
    const bytes100 = mcpPayloadBytes(renderReceiptBatchCompact(compactInput(makeBatch(100))));
    // The DRY_RUN compact carries the O(n) approved manifest (the reviewed bytes
    // the guided user must resend), so it grows with the file count — but a
    // 100-file manifest (~12 KB) plus the scalar base stays well under the hard
    // budget (32 KB), and comfortably under the 16 KB target.
    expect(bytes10).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
    expect(bytes100).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
    expect(bytes100).toBeLessThan(16 * 1024);
  });

  it("create / create_and_confirm compacts carry NO manifest and stay strictly ~O(1)", () => {
    for (const executionMode of ["create", "create_and_confirm"] as const) {
      const bytes10 = mcpPayloadBytes(
        renderReceiptBatchCompact(compactInput(makeBatch(10, { executionMode, dryRun: false }))),
      );
      const bytes100 = mcpPayloadBytes(
        renderReceiptBatchCompact(compactInput(makeBatch(100, { executionMode, dryRun: false }))),
      );
      // No per-file rows, no inlined manifest: strictly scalar-bounded.
      expect(Math.abs(bytes100 - bytes10)).toBeLessThan(256);
      expect(bytes100).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
    }
  });
});

describe("renderReceiptBatchCompact — totals currency", () => {
  // The currency label used to be voted over EVERY scanned row while the sums
  // covered only the reliable ones, so rows that contribute nothing to the
  // figure could still name it. Three USD receipts held for review plus two
  // booked EUR ones reported the EUR-only sum labelled "USD".
  it("labels the totals with the currency of the rows actually summed", () => {
    const usdRows = Array.from({ length: 3 }, (_, i) => ({
      ...fileResult(100 + i, "needs_review" as ReceiptBatchStatus),
      extracted: { ...fileResult(100 + i, "needs_review" as ReceiptBatchStatus).extracted!, currency: "USD" },
    }));
    const { summary } = renderReceiptBatchCompact(compactInput(makeBatch(2, { extraRows: usdRows })));

    expect(summary.totals?.currency).toBe("EUR");
    // 2 clean EUR rows at 124 gross each — the USD rows contributed nothing.
    expect(Number(summary.totals?.gross)).toBe(248);
    expect((summary.warnings ?? []).some(w => w.code === "mixed_currency_totals")).toBe(false);
  });

  it("warns when the summed rows themselves do not share a currency", () => {
    const usdBooked = {
      ...fileResult(200, "dry_run_preview" as ReceiptBatchStatus),
      extracted: { ...fileResult(200, "dry_run_preview" as ReceiptBatchStatus).extracted!, currency: "USD" },
    };
    const { summary } = renderReceiptBatchCompact(compactInput(makeBatch(2, { extraRows: [usdBooked] })));

    const warning = (summary.warnings ?? []).find(w => w.code === "mixed_currency_totals");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("more than one currency");
  });
});

describe("renderReceiptBatchCompact — dry_run", () => {
  it("carries every approval-summary field, ≤3 wrapped samples, and directs create", () => {
    const { summary } = renderReceiptBatchCompact(compactInput(makeBatch(40), { connectionName: "Näidis", fileRef: "REF-abc" }));
    expect(summary.contract).toBe("operation_summary_v1");
    expect(summary.status).toBe("ready_for_approval");
    // counts by status
    expect(summary.counts?.scanned).toBe(40);
    expect(summary.counts?.would_create).toBe(40);
    expect(summary.counts?.duplicates).toBe(0);
    expect(summary.counts?.needs_review).toBe(0);
    expect(summary.counts?.failed).toBe(0);
    expect(summary.counts?.ocr_issues).toBe(0);
    // reliable totals with currency
    expect(Number(summary.totals?.gross)).toBeGreaterThan(0);
    expect(Number(summary.totals?.net)).toBeGreaterThan(0);
    expect(Number(summary.totals?.vat)).toBeGreaterThan(0);
    expect(summary.totals?.currency).toBe("EUR");
    // scope: connection + affected account + period + source document
    const scope = summary.scope as Record<string, unknown>;
    expect(scope.connection).toBe("Näidis");
    expect(scope.account).toBe("7");
    expect((scope.period as Record<string, unknown>).from).toBe("2026-03-01");
    expect(scope.source_documents).toEqual(["REF-abc"]);
    // clean rows omitted — at most 3 samples, untrusted text wrapped
    expect(summary.samples?.length).toBe(3);
    const sample = summary.samples?.[0] as Record<string, unknown>;
    expect(String(sample.file)).toMatch(OCR);
    expect(String(sample.supplier)).toMatch(OCR);
    expect(String(sample.invoice_number)).toMatch(OCR);
    // exact next action → create call (approval required; the reviewed-set
    // manifest IS inlined so the guided dry_run→create flow is self-completable)
    expect(summary.next_action?.tool).toBe("receipt_batch");
    expect(summary.next_action?.args.mode).toBe("create");
    expect(summary.next_action?.args.approved_manifest_required).toBe(true);
    const manifest = summary.next_action?.args.approved_manifest as unknown[];
    expect(Array.isArray(manifest)).toBe(true);
    // one manifest entry per scanned file — the exact bytes to resend to create
    expect(manifest.length).toBe(40);
    expect(summary.next_action?.approval_required).toBe(true);
  });

  it("does NOT inline bulk OCR text, and any supplier text is wrapped", () => {
    const batch = makeBatch(60);
    // Attach a bulk raw_text blob to a row — it must never reach the compact.
    batch.results[0]!.extracted!.raw_text = "RAW OCR BLOB PARAGRAPH <injection>";
    const encoded = JSON.stringify(renderReceiptBatchCompact(compactInput(batch)));
    // Bulk OCR text is not carried by the compact summary at all.
    expect(encoded).not.toContain("RAW OCR BLOB PARAGRAPH");
    expect(encoded).not.toContain("raw_text");
    // The DRY_RUN compact DOES inline the approved manifest (relative_path + sha256
    // per file) — the reviewed-set bytes the guided user resends to create — but
    // the manifest carries only file identities, never OCR supplier/free text.
    expect(encoded).toContain("relative_path");
    // The supplier name only ever appears sandbox-wrapped: its single occurrence
    // is immediately preceded by an OCR sandbox start marker.
    expect(encoded.split("Supplier 0 OÜ").length - 1).toBe(1);
    const index = encoded.indexOf("Supplier 0 OÜ");
    const preceding = encoded.slice(Math.max(0, index - 80), index);
    expect(preceding).toContain("UNTRUSTED_OCR_START");
  });

  it("counts duplicates + surfaces needs-review and OCR issues as warnings", () => {
    const batch = makeBatch(2, {
      extraRows: [
        fileResult(900, "skipped_duplicate"),
        fileResult(901, "needs_review"),
        fileResult(902, "created", {
          status: "needs_review",
          llm_fallback: { raw_text_available: true, recommended: true, confidence: "medium", confidence_signals: ["low_ocr_confidence"], reason: "", missing_required_fields: [], missing_optional_fields: [], guidance: "" },
        }),
      ],
    });
    const { summary } = renderReceiptBatchCompact(compactInput(batch));
    expect(summary.counts?.duplicates).toBe(1);
    expect(summary.counts?.needs_review).toBe(2);
    expect(summary.counts?.ocr_issues).toBe(1);
    expect(summary.warnings?.some(w => w.code === "needs_review")).toBe(true);
    expect(summary.warnings?.some(w => w.code === "low_ocr_confidence")).toBe(true);
    // the needs_review warning's item_id (file name) is OCR-wrapped
    const reviewWarning = summary.warnings?.find(w => w.code === "needs_review");
    expect(String(reviewWarning?.item_id)).toMatch(OCR);
  });
});

describe("renderReceiptBatchCompact — executed", () => {
  it("create completes and points the guided user to continue_accounting_workflow", () => {
    const { summary } = renderReceiptBatchCompact(compactInput(makeBatch(5, { executionMode: "create", dryRun: false })));
    expect(summary.status).toBe("completed");
    expect(summary.counts?.created).toBe(5);
    expect(summary.counts?.confirmed).toBe(0);
    expect(summary.next_action?.tool).toBe("continue_accounting_workflow");
    expect(summary.next_action?.approval_required).toBe(false);
    // Post-mutation: nothing to resend, so the manifest is NOT inlined here.
    expect(summary.next_action?.args.approved_manifest).toBeUndefined();
  });

  it("NEVER hides processing failures: a partial batch surfaces a blocker", () => {
    const batch = makeBatch(2, {
      executionMode: "create",
      dryRun: false,
      extraRows: [fileResult(50, "failed", { error: "upstream refused" })],
    });
    const { summary } = renderReceiptBatchCompact(compactInput(batch));
    expect(summary.status).toBe("partial");
    expect(summary.counts?.failed).toBe(1);
    expect(summary.blockers?.length).toBeGreaterThan(0);
    expect(summary.blockers?.[0]!.severity).toBe("blocker");
    expect(summary.blockers?.[0]!.code).toBe("receipt_processing_failed");
  });

  it("NEVER hides PARTIAL MUTATIONS: create_and_confirm created-but-not-confirmed surfaces a blocker", () => {
    const batch = makeBatch(3, { executionMode: "create_and_confirm", dryRun: false });
    // Force one created invoice to remain unconfirmed (confirm failed after create).
    (batch.results[0]!.created_invoice as { confirmed?: boolean }).confirmed = false;
    const { summary } = renderReceiptBatchCompact(compactInput(batch));
    expect(summary.status).toBe("partial");
    expect(summary.counts?.partial_mutations).toBe(1);
    expect(summary.blockers?.some(b => b.code === "created_not_confirmed")).toBe(true);
    expect(summary.next_action?.tool).toBe("continue_accounting_workflow");
  });
});
