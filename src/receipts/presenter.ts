import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolError } from "../tool-error.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { roundMoney } from "../money.js";
import { createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import { sanitizeReceiptResultForOutput } from "../tools/receipt-inbox-output.js";
import {
  buildReceiptBatchExecution,
  buildReceiptBatchWorkflow,
  buildReceiptBatchWorkflowSummary,
} from "../tools/receipt-inbox-summary.js";
import type {
  ReceiptApprovedManifestEntry,
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptBatchResult,
} from "./types.js";

// OUTPUT layer for the receipt batch. The only receipt-batch module that shapes
// MCP envelopes. It owns ALL OCR/untrusted-text sandboxing for the batch surface
// (sanitizeReceiptResultForOutput on the direct-path, or the injected file-ref
// projection which sandboxes via sandboxExternalText + fileReferenceStore) and
// the workflow/execution-contract builders. The typed operation returns
// UNWRAPPED domain data. standard/full keep the byte-identical FULL envelope;
// guided/guided-sales receive the compact presenter (Phase B).

// --- Simple-failure envelopes (moved verbatim from the handler) --------------

/** Own-company identity could not be loaded from a PRESENT invoice_info
 * endpoint (M09): fail closed rather than book with weakened self-match
 * protection. Byte-identical to the pre-refactor handler return. */
export function receiptIdentityRetryableError(reason: string): CallToolResult {
  return toolError({
    error: "Could not load own-company identity; refusing to auto-process receipts",
    category: "manual_review_required",
    protection_state: "retryable_error",
    reason,
    next_action: "Retry once the invoice_info endpoint is reachable again.",
  });
}

/** H15: creating/confirming without the dry-run manifest is refused so the
 * approved-bytes binding cannot be bypassed. Byte-identical to the handler. */
export function receiptApprovedManifestRequiredError(): CallToolResult {
  return toolError({ category: "approved_manifest_required", error: "approved_manifest is required for receipt mutation" });
}

// --- FULL envelope (standard/full — byte-identical to the pre-refactor tool) --

/** A sanitized result carries at least the fields the workflow/execution
 * builders read; the file-ref projection adds display_name/display_path/file_ref. */
type SanitizedReceiptResult = ReceiptBatchFileResult | (Record<string, unknown> & { status: ReceiptBatchFileResult["status"] });

/** File-reference projection injected by the tool adapter (it owns the
 * fileReferenceStore + sandboxExternalText). Absent for direct folder_path runs,
 * where the presenter sanitizes the raw results itself. */
export interface ReceiptBatchFileRefProjection {
  readonly projectResult: (result: ReceiptBatchFileResult) => Record<string, unknown> & { status: ReceiptBatchFileResult["status"] };
  readonly manifest: Array<Record<string, unknown>>;
  readonly skipped: Array<Record<string, unknown>>;
  readonly folderPathOut: unknown;
}

export interface ReceiptBatchFullInput {
  readonly result: ReceiptBatchResult;
  readonly accountsDimensionsId: number;
  readonly fileRef?: string;
  /** The initially-resolved folder path echoed in workflow suggested_args
   * (receiptFolder.path — NOT the point-of-use path). */
  readonly workflowFolderPath: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly transactionDateFrom?: string;
  readonly transactionDateTo?: string;
  readonly fileRefProjection?: ReceiptBatchFileRefProjection;
}

/**
 * Build the FULL receipt-batch envelope object (before toMcpJson). Byte-identical
 * to the pre-refactor process_receipt_batch handler's payload, including exact
 * key order, so the standard/full public surface is unchanged.
 */
export function renderReceiptBatchFull(input: ReceiptBatchFullInput): Record<string, unknown> {
  const { result, accountsDimensionsId, fileRef } = input;
  const scan = result.scan;
  const summary = result.summary;
  const mode = result.mode;
  const projection = input.fileRefProjection;

  const sanitizedResults: SanitizedReceiptResult[] = projection !== undefined
    ? result.results.map(projection.projectResult)
    : result.results.map(sanitizeReceiptResultForOutput);
  const responseManifest: Array<ReceiptApprovedManifestEntry | Record<string, unknown>> = projection !== undefined
    ? projection.manifest
    : result.manifest;

  const workflowArgs = {
    ...(fileRef !== undefined ? { file_ref: fileRef } : { folder_path: input.workflowFolderPath }),
    accounts_dimensions_id: accountsDimensionsId,
    ...(input.dateFrom ? { date_from: input.dateFrom } : {}),
    ...(input.dateTo ? { date_to: input.dateTo } : {}),
    ...(input.transactionDateFrom ? { transaction_date_from: input.transactionDateFrom } : {}),
    ...(input.transactionDateTo ? { transaction_date_to: input.transactionDateTo } : {}),
    execution_mode: "create",
    approved_manifest: responseManifest,
  };
  const workflowSummary = buildReceiptBatchWorkflowSummary(summary);
  const workflow = buildReceiptBatchWorkflow({
    summary,
    workflowSummary,
    sanitizedResults,
    workflowArgs,
  });

  return {
    mode,
    execution_mode: result.executionMode,
    folder_path: projection !== undefined ? projection.folderPathOut : scan.folder_path,
    ...(fileRef !== undefined ? { file_ref: fileRef } : {}),
    accounts_dimensions_id: accountsDimensionsId,
    summary,
    workflow,
    // H15: bytes were snapshotted once and (for create/confirm) checked against
    // the approved manifest, so there is no execution-time re-scan drift. Echo
    // the manifest the operator approved / must approve so the create call can
    // bind to these exact bytes.
    approved_manifest: responseManifest,
    skipped: projection !== undefined ? projection.skipped : scan.skipped,
    results: sanitizedResults,
    execution: buildReceiptBatchExecution({
      mode,
      summary,
      sanitizedResults,
    }),
  };
}

// --- COMPACT presenter (guided / guided-sales) -------------------------------
//
// The scalar summary (counts/totals, ≤3 samples, clean per-file rows OMITTED) is
// approximately CONSTANT regardless of receipt count. Unresolved decisions
// (needs_review) and OCR failures surface as warnings; PARTIAL MUTATIONS
// (create_and_confirm invoices that were created but not confirmed) and
// processing FAILURES surface as blockers — never hidden. All untrusted
// free-text (supplier name, invoice number, file name) is wrapUntrustedOcr-
// wrapped here; NO raw OCR text or description enters the compact summary. The
// exact next action mirrors the domain flow: a DRY_RUN points to the create call
// (approval_required) and INLINES the approved manifest — the same O(n)
// reviewed-set artifact the full envelope carries — so a guided user's
// dry_run→create flow is self-completable (they must resend the exact reviewed
// bytes to mode=create; a manifest/reference NEVER implies approval). A completed
// create/create_and_confirm points to `continue_accounting_workflow` because
// receipts feed the accounting inbox and does NOT carry the manifest (post-
// mutation, nothing to resend) — USER-DECIDED: no operation-result handle, no
// plan store for receipts. So the compact stays scalar-bounded except for the
// dry_run manifest, which is bounded under RESPONSE_BUDGETS.batch.hard.

/** Resolved scope + echo args the compact next action needs; supplied by the
 * tool adapter (which owns fileReferenceStore + the active connection). */
export interface ReceiptBatchCompactInput {
  readonly result: ReceiptBatchResult;
  readonly accountsDimensionsId: number;
  readonly executionMode: ReceiptBatchExecutionMode;
  readonly fileRef?: string;
  /** The initially-resolved folder path echoed back into the create next_action
   * (receiptFolder.path — the caller's own argument, not OCR content). */
  readonly workflowFolderPath: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly transactionDateFrom?: string;
  readonly transactionDateTo?: string;
  readonly connectionName?: string;
  /** The exact approved manifest the FULL envelope emits (projection.manifest
   * for the file_ref path, result.manifest for a direct folder path). The
   * DRY_RUN compact inlines it into the create next_action so a guided user's
   * dry_run→create flow is self-completable: it is the reviewed-set artifact the
   * operator must resend, NOT an approval token. Undefined on non-dry_run runs. */
  readonly responseManifest?: ReadonlyArray<ReceiptApprovedManifestEntry | Record<string, unknown>>;
}

const RELIABLE_STATUSES = new Set<ReceiptBatchFileResult["status"]>([
  "created",
  "matched",
  "dry_run_preview",
]);

function receiptDateRange(dates: ReadonlyArray<string | undefined>): { from?: string; to?: string } {
  let from: string | undefined;
  let to: string | undefined;
  for (const date of dates) {
    if (typeof date !== "string" || date.length === 0) continue;
    if (from === undefined || date < from) from = date;
    if (to === undefined || date > to) to = date;
  }
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** Majority-vote receipt currency across the extracted rows, EUR fallback. */
function reliableReceiptCurrency(results: readonly ReceiptBatchFileResult[]): string {
  const counts = new Map<string, number>();
  for (const row of results) {
    const currency = row.extracted?.currency;
    if (typeof currency === "string" && currency.length > 0) {
      counts.set(currency, (counts.get(currency) ?? 0) + 1);
    }
  }
  let best = "EUR";
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

function hasOcrIssue(row: ReceiptBatchFileResult): boolean {
  const signals = row.llm_fallback?.confidence_signals ?? [];
  return signals.includes("low_ocr_confidence")
    || signals.includes("partial_ocr_failure")
    || row.extracted?.partial_ocr_failure === true;
}

export function renderReceiptBatchCompact(input: ReceiptBatchCompactInput): { summary: OperationSummaryV1 } {
  const { result, executionMode } = input;
  const summary = result.summary;
  const results = result.results;
  const dryRun = summary.dry_run;

  const confirmedCount = results.filter(row => row.created_invoice?.confirmed === true).length;
  const bankMatchedCount = results.filter(
    row => row.bank_match?.linked === true || row.bank_match?.confirmed_transaction_id !== undefined,
  ).length;
  const ocrIssueCount = results.filter(hasOcrIssue).length;

  // Created-but-not-confirmed is a PARTIAL MUTATION only in create_and_confirm,
  // where confirmation was attempted. In plain `create` mode leaving invoices
  // unconfirmed is by design (creation and confirmation are separate approvals),
  // so it is never counted as a partial mutation.
  const partialMutations = !dryRun && executionMode === "create_and_confirm"
    ? results.filter(row => row.created_invoice !== undefined && row.created_invoice.confirmed !== true).length
    : 0;

  const counts: Record<string, number> = {
    scanned: summary.scanned_files,
    skipped_invalid: summary.skipped_invalid_files,
    [dryRun ? "would_create" : "created"]: dryRun ? summary.dry_run_preview : summary.created,
    matched: summary.matched,
    bank_matched: bankMatchedCount,
    duplicates: summary.skipped_duplicate,
    needs_review: summary.needs_review,
    failed: summary.failed,
    ocr_issues: ocrIssueCount,
    ...(dryRun ? {} : { confirmed: confirmedCount }),
    ...(partialMutations > 0 ? { partial_mutations: partialMutations } : {}),
  };

  // Reliable financial totals: sum only over successfully processed rows
  // (created / matched / dry_run_preview) that carry structured extracted
  // amounts. Bounded scalars — independent of receipt count.
  const currency = reliableReceiptCurrency(results);
  let gross = 0;
  let net = 0;
  let vat = 0;
  for (const row of results) {
    if (!RELIABLE_STATUSES.has(row.status)) continue;
    const extracted = row.extracted;
    if (extracted === undefined) continue;
    if (typeof extracted.total_gross === "number") gross = roundMoney(gross + extracted.total_gross);
    if (typeof extracted.total_net === "number") net = roundMoney(net + extracted.total_net);
    if (typeof extracted.total_vat === "number") vat = roundMoney(vat + extracted.total_vat);
  }
  const totals: Record<string, number | string> = { gross, net, vat, currency };

  // Unresolved decisions surface as warnings (≤3); the receipt file name is the
  // only free text and is OCR-sandbox-wrapped. No raw OCR / supplier text is
  // embedded in the message.
  const warnings: CompactWarning[] = [];
  for (const row of results.filter(candidate => candidate.status === "needs_review").slice(0, 3)) {
    warnings.push({
      item_id: wrapUntrustedOcr(row.file.name) ?? "",
      code: "needs_review",
      message: "Receipt needs manual review before booking.",
    });
  }
  if (ocrIssueCount > 0) {
    warnings.push({
      code: "low_ocr_confidence",
      message: `${ocrIssueCount} receipt(s) had low or partial OCR confidence.`,
    });
  }

  // Blockers are NEVER hidden: processing failures and (for create_and_confirm)
  // created-but-not-confirmed invoices both surface here.
  const blockers: CompactReviewItem[] = [];
  if (!dryRun && summary.failed > 0) {
    blockers.push({
      item_id: "receipt-batch",
      code: "receipt_processing_failed",
      message: `${summary.failed} receipt(s) failed to process. Re-preview before retrying; a prior preview is not approval.`,
      severity: "blocker",
    });
  }
  if (partialMutations > 0) {
    blockers.push({
      item_id: "receipt-batch-partial",
      code: "created_not_confirmed",
      message: `${partialMutations} invoice(s) were created but not confirmed. Confirm them separately — creation and confirmation are distinct approvals.`,
      severity: "blocker",
    });
  }

  const samples = results.slice(0, 3).map((row, index) => {
    const extracted = row.extracted;
    return {
      i: index,
      status: row.status,
      file: wrapUntrustedOcr(row.file.name),
      ...(extracted?.total_gross !== undefined ? { gross: extracted.total_gross } : {}),
      ...(extracted?.currency !== undefined ? { currency: extracted.currency } : {}),
      ...(extracted?.invoice_date !== undefined ? { date: extracted.invoice_date } : {}),
      ...(extracted?.supplier_name !== undefined ? { supplier: wrapUntrustedOcr(extracted.supplier_name) } : {}),
      ...(extracted?.invoice_number !== undefined ? { invoice_number: wrapUntrustedOcr(extracted.invoice_number) } : {}),
      ...(row.created_invoice?.id !== undefined ? { invoice_id: row.created_invoice.id } : {}),
      ...(row.created_invoice?.confirmed !== undefined ? { confirmed: row.created_invoice.confirmed } : {}),
    };
  });

  const message = buildReceiptBatchWorkflowSummary(summary);

  const status: OperationSummaryV1["status"] = dryRun
    ? "ready_for_approval"
    : (summary.failed > 0 || partialMutations > 0)
      ? "partial"
      : summary.needs_review > 0
        ? "needs_review"
        : "completed";

  const period = receiptDateRange(results.map(row => row.extracted?.invoice_date));
  // The source-file identity: an opaque file_ref is safe verbatim; a raw folder
  // path is OCR-sandbox-wrapped for display.
  const sourceDocument = input.fileRef !== undefined
    ? input.fileRef
    : wrapUntrustedOcr(input.workflowFolderPath);
  const scope = {
    ...(input.connectionName ? { connection: input.connectionName } : {}),
    account: String(input.accountsDimensionsId),
    ...(period.from !== undefined || period.to !== undefined ? { period } : {}),
    ...(sourceDocument !== undefined ? { source_documents: [sourceDocument] } : {}),
  } as OperationSummaryV1["scope"];

  // Next action. A dry_run points to the create call and INLINES the exact
  // approved manifest (the same O(n) reviewed-set artifact the FULL envelope
  // emits) so a guided user can complete dry_run→create without a separate way to
  // obtain it; `approved_manifest_required` still flags that the create call must
  // carry it, and a manifest NEVER implies approval — it is the bytes to resend,
  // not an approval token. A completed create/create_and_confirm points to
  // `continue_accounting_workflow` (receipts feed the accounting inbox) and does
  // NOT resend the manifest — post-mutation there is nothing to approve.
  const next_action = dryRun
    ? {
        tool: "receipt_batch",
        args: {
          mode: "create",
          ...(input.fileRef !== undefined ? { file_ref: input.fileRef } : { folder_path: input.workflowFolderPath }),
          accounts_dimensions_id: input.accountsDimensionsId,
          ...(input.dateFrom ? { date_from: input.dateFrom } : {}),
          ...(input.dateTo ? { date_to: input.dateTo } : {}),
          ...(input.transactionDateFrom ? { transaction_date_from: input.transactionDateFrom } : {}),
          ...(input.transactionDateTo ? { transaction_date_to: input.transactionDateTo } : {}),
          approved_manifest_required: true,
          approved_manifest: input.responseManifest ?? result.manifest,
        },
        approval_required: true,
      }
    : {
        tool: "continue_accounting_workflow",
        args: {},
        approval_required: false,
      };

  const operationSummary = createOperationSummary({
    status,
    message,
    counts,
    totals,
    scope,
    warnings,
    blockers,
    samples,
    next_action,
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary: operationSummary };
}
