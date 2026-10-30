import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolError } from "../tool-error.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { roundMoney } from "../money.js";
import { cappedWarnings, createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import { sanitizeReceiptResultForOutput } from "../tools/receipt-inbox-output.js";
import { rawTextFallbackGuidance } from "../invoice-extraction-fallback.js";
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
  ReceiptFileInfo,
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

interface ReceiptBatchFullInput {
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
  /** Public (sandboxed, file_ref-carrying) file object used by the compact rows
   * and the reference projections — never a raw name/path. */
  readonly publicFile: (file: ReceiptFileInfo) => Record<string, unknown>;
  /** "compact" (default) drops the OCR blob and provenance from `results[]`;
   * "full" keeps today's full rows. */
  readonly detail?: ReceiptBatchDetail;
}

export type ReceiptBatchDetail = "compact" | "full";

type PublicReceiptRow = Record<string, unknown> & { status: ReceiptBatchFileResult["status"] };

export const RECEIPT_DETAIL_HINT =
  "rerun with detail='full', or call extract_pdf_invoice on that one file, for the OCR text and field provenance";

const COMPACT_CLIENT_KEYS = ["id", "name", "code", "invoice_vat_no", "cl_code_country", "is_supplier"] as const;
const FULL_RAW_TEXT_GUIDANCE = rawTextFallbackGuidance("extracted.raw_text");
const COMPACT_RAW_TEXT_GUIDANCE = rawTextFallbackGuidance("extracted.raw_text (receipt_batch detail='full', or extract_pdf_invoice on this file)");

function pickKeys(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => key in record).map(key => [key, record[key]]));
}

function withPublicFile(row: SanitizedReceiptResult, file: Record<string, unknown>): PublicReceiptRow {
  return { ...(row as PublicReceiptRow), file };
}

/**
 * Compact row: a DENY-list projection of the sanitized row. Everything is kept
 * except the OCR blob, the field provenance and the bulky client/account
 * records, so review information is never lost by omission.
 */
export function compactReceiptRow(row: PublicReceiptRow, source: ReceiptBatchFileResult): PublicReceiptRow {
  const next: PublicReceiptRow = { ...row };
  const extracted = next.extracted as Record<string, unknown> | undefined;
  if (extracted !== undefined) {
    const { raw_text: _rawText, field_provenance: _provenance, ...rest } = extracted;
    next.extracted = rest;
  }
  const supplierResolution = next.supplier_resolution as Record<string, unknown> | undefined;
  if (supplierResolution !== undefined) {
    next.supplier_resolution = {
      ...supplierResolution,
      ...("client" in supplierResolution ? { client: pickKeys(supplierResolution.client, COMPACT_CLIENT_KEYS) } : {}),
      ...("preview_client" in supplierResolution ? { preview_client: pickKeys(supplierResolution.preview_client, COMPACT_CLIENT_KEYS) } : {}),
    };
  }
  const bookingSuggestion = next.booking_suggestion as Record<string, unknown> | undefined;
  if (bookingSuggestion !== undefined) {
    next.booking_suggestion = {
      ...bookingSuggestion,
      ...("suggested_account" in bookingSuggestion ? { suggested_account: pickKeys(bookingSuggestion.suggested_account, ["id", "name_est"]) } : {}),
      ...("suggested_purchase_article" in bookingSuggestion ? { suggested_purchase_article: pickKeys(bookingSuggestion.suggested_purchase_article, ["id", "name"]) } : {}),
    };
  }
  const llmFallback = next.llm_fallback as Record<string, unknown> | undefined;
  if (llmFallback?.guidance === FULL_RAW_TEXT_GUIDANCE) {
    next.llm_fallback = { ...llmFallback, guidance: COMPACT_RAW_TEXT_GUIDANCE };
  }
  const rawTextAvailable = typeof source.extracted?.raw_text === "string" && source.extracted.raw_text.trim() !== "";
  next.raw_text_available = rawTextAvailable;
  if (rawTextAvailable) next.detail_hint = RECEIPT_DETAIL_HINT;
  return next;
}

/** Reference projection used by `execution.*`: identifies the row and carries
 * what a consumer acts on, never the whole row. */
export function receiptReference(row: PublicReceiptRow): PublicReceiptRow {
  const extracted = row.extracted as Record<string, unknown> | undefined;
  const llmFallback = row.llm_fallback as Record<string, unknown> | undefined;
  const duplicateMatch = row.duplicate_match as Record<string, unknown> | undefined;
  const duplicateCandidates = row.duplicate_candidates as Array<Record<string, unknown>> | undefined;
  const createdInvoice = row.created_invoice as Record<string, unknown> | undefined;
  const totals = extracted !== undefined
    ? pickKeys(extracted, ["total_net", "total_vat", "total_gross", "currency"]) as Record<string, unknown>
    : undefined;
  return {
    file: row.file,
    classification: row.classification,
    status: row.status,
    ...(llmFallback !== undefined ? { llm_fallback: { confidence_signals: llmFallback.confidence_signals ?? [] } } : {}),
    ...(row.error !== undefined ? { error: row.error } : {}),
    ...(row.referenced_invoice !== undefined ? { referenced_invoice: row.referenced_invoice } : {}),
    ...(duplicateMatch !== undefined ? { duplicate_match: { invoice_id: duplicateMatch.invoice_id } } : {}),
    ...(duplicateCandidates !== undefined && duplicateCandidates.length > 0
      ? { duplicate_candidates: duplicateCandidates.map(candidate => ({ invoice_id: candidate.invoice_id })) }
      : {}),
    ...(row.possible_duplicate_journal_ids !== undefined ? { possible_duplicate_journal_ids: row.possible_duplicate_journal_ids } : {}),
    ...(row.referencing_journal_ids !== undefined ? { referencing_journal_ids: row.referencing_journal_ids } : {}),
    ...(row.journal_reference_scan_unavailable ? { journal_reference_scan_unavailable: true } : {}),
    ...(createdInvoice !== undefined ? { created_invoice: pickKeys(createdInvoice, ["id", "number", "status", "confirmed"]) } : {}),
    ...(row.bank_partial !== undefined ? { bank_partial: row.bank_partial } : {}),
    ...(row.creation_partial !== undefined ? { creation_partial: row.creation_partial } : {}),
    ...(totals !== undefined && Object.keys(totals).length > 0 ? { extracted: totals } : {}),
  };
}

const INBOX_REVIEW_EXTRACTED_KEYS = [
  "supplier_name", "supplier_reg_code", "supplier_vat_no", "invoice_number", "invoice_date", "due_date",
  "total_net", "total_vat", "total_gross", "currency", "partial_ocr_failure", "amount_consistency_issues",
  "extraction_notes",
] as const;

/**
 * A receipt row as an accounting-inbox review item: identifies the file and
 * carries what the reviewer and the review resolver act on (classification,
 * guidance, notes, signals, error, duplicate / journal ids, key extracted
 * fields), never the OCR text, provenance or candidate lists. The file stays
 * as given; the inbox output boundary projects and sandboxes it.
 */
export function receiptInboxReviewItem(row: Record<string, unknown>, detailHint: string): Record<string, unknown> {
  const extracted = row.extracted as Record<string, unknown> | undefined;
  const llmFallback = row.llm_fallback as Record<string, unknown> | undefined;
  const rawText = extracted?.raw_text;
  const rawTextAvailable = typeof rawText === "string" && rawText.trim() !== "";
  const { extracted: _totals, ...reference } = receiptReviewReference(row as PublicReceiptRow);
  const keptExtracted = extracted !== undefined
    ? pickKeys(extracted, INBOX_REVIEW_EXTRACTED_KEYS) as Record<string, unknown>
    : undefined;
  return {
    ...reference,
    ...(keptExtracted !== undefined && Object.keys(keptExtracted).length > 0 ? { extracted: keptExtracted } : {}),
    ...(llmFallback !== undefined
      ? { llm_fallback: pickKeys(llmFallback, ["confidence", "confidence_signals", "missing_required_fields"]) }
      : {}),
    raw_text_available: rawTextAvailable,
    ...(rawTextAvailable ? { detail_hint: detailHint } : {}),
  };
}

/** `workflow.needs_review` reference: the review list consumers act on, so it
 * also keeps the guidance and notes. */
export function receiptReviewReference(row: PublicReceiptRow): PublicReceiptRow {
  return {
    ...receiptReference(row),
    ...(row.review_guidance !== undefined ? { review_guidance: row.review_guidance } : {}),
    ...(row.notes !== undefined ? { notes: row.notes } : {}),
  };
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
  const publicRows = sanitizedResults.map((row, index) =>
    withPublicFile(row, input.publicFile(result.results[index]!.file)));
  const outputResults = (input.detail ?? "compact") === "full"
    ? sanitizedResults
    : publicRows.map((row, index) => compactReceiptRow(row, result.results[index]!));
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
    // P0-3: the create call REQUIRES this consume-once handle bound to the
    // reviewed dry_run effect. The manifest alone is no longer approval.
    ...(result.planHandles?.create !== undefined ? { plan_handle: result.planHandles.create } : {}),
  };
  const workflowSummary = buildReceiptBatchWorkflowSummary(summary);
  const workflow = buildReceiptBatchWorkflow({
    summary,
    workflowSummary,
    sanitizedResults: publicRows.map(receiptReviewReference),
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
    // P0-3: the per-effect consume-once handles minted by dry_run. create /
    // create_and_confirm each REQUIRE the matching handle; the manifest is no
    // longer the sole approval artifact.
    ...(result.planHandles !== undefined ? { plan_handles: result.planHandles } : {}),
    skipped: projection !== undefined ? projection.skipped : scan.skipped,
    results: outputResults,
    execution: buildReceiptBatchExecution({
      mode,
      summary,
      sanitizedResults: publicRows.map(receiptReference),
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
/**
 * The currency LABEL for the reliable totals. It must be voted over exactly the
 * rows the totals sum over, not over every scanned row: a non-EUR receipt always
 * lands in `needs_review` and so contributes nothing to the sums, but it used to
 * carry a vote. Three USD receipts plus two EUR ones therefore labelled a
 * EUR-only sum as "USD".
 *
 * `mixed` is true when the contributing rows genuinely disagree — one scalar
 * total cannot describe them, and silently picking the plurality would misstate
 * the figure rather than just its label.
 */
function reliableReceiptCurrency(
  results: readonly ReceiptBatchFileResult[],
): { currency: string; mixed: boolean } {
  const counts = new Map<string, number>();
  for (const row of results) {
    if (!RELIABLE_STATUSES.has(row.status)) continue;
    if (row.extracted === undefined) continue;
    const currency = row.extracted.currency;
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
  return { currency: best, mixed: counts.size > 1 };
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
  const partialCreations = !dryRun ? results.filter(row => row.creation_partial !== undefined).length : 0;
  const unconfirmed = !dryRun && executionMode === "create_and_confirm"
    ? results.filter(row => !row.creation_partial && row.created_invoice !== undefined && row.created_invoice.confirmed !== true).length : 0;
  const partialMutations = partialCreations + unconfirmed;

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
  const { currency, mixed: currencyMixed } = reliableReceiptCurrency(results);
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

  // Unresolved decisions surface as warnings (3 + an "N more" notice); the
  // receipt file name is the only free text and is OCR-sandbox-wrapped. No raw
  // OCR / supplier text is embedded in the message.
  const warnings: CompactWarning[] = cappedWarnings(
    "needs_review",
    results.filter(candidate => candidate.status === "needs_review").map(row => {
      const duplicateIds = (row.duplicate_candidates ?? []).map(candidate => candidate.invoice_id);
      const itemId = wrapUntrustedOcr(row.file.name) ?? "";
      const postingIds = row.possible_duplicate_journal_ids ?? [];
      const referencingIds = row.referencing_journal_ids ?? [];
      if (referencingIds.length > 0) {
        return {
          item_id: itemId,
          code: "invoice_referenced_by_journal",
          message: `Journal(s) ${referencingIds.join(", ")} already reference this invoice number, so it may already be booked there; ask the user whether that journal is this document's booking: if it is, do not book it again (the document belongs on that journal); if not, book this document on its own.`,
        };
      }
      if (row.journal_reference_scan_unavailable) {
        return {
          item_id: itemId,
          code: "journal_reference_scan_unavailable",
          message: "The journal list could not be read, so journals that may already book this invoice number were not checked; re-run the batch or book this document on its own.",
        };
      }
      if (postingIds.length > 0) {
        return {
          item_id: itemId,
          code: "possible_duplicate_posting",
          message: `The payment may already be booked by journal(s) ${postingIds.join(", ")}; book this document separately only if it is a different payment.`,
        };
      }
      return duplicateIds.length > 0
        ? {
          item_id: itemId,
          code: "possible_duplicate_invoice",
          message: `Invoice number already exists as purchase invoice ${duplicateIds.join(", ")} under another client; do not book it again if it is the same supplier.`,
        }
        : {
          item_id: itemId,
          code: "needs_review",
          message: "Receipt needs manual review before booking.",
        };
    }),
    "the standard/full profile lists every receipt; or process a smaller folder to see them here.",
  );
  if (ocrIssueCount > 0) {
    warnings.push({
      code: "low_ocr_confidence",
      message: `${ocrIssueCount} receipt(s) had low or partial OCR confidence.`,
    });
  }
  if (currencyMixed) {
    // The summed rows do not share a currency, so one scalar gross/net/vat is
    // not a meaningful figure — the label names the most common currency only.
    warnings.push({
      code: "mixed_currency_totals",
      message: `Totals combine receipts in more than one currency and are labelled ${currency}; read the per-receipt amounts instead.`,
    });
  }

  // Blockers are NEVER hidden: processing failures and (for create_and_confirm)
  // created-but-not-confirmed invoices both surface here.
  const blockers: Array<CompactReviewItem & { creation_partial?: ReceiptBatchFileResult["creation_partial"] }> = [];
  for (const [index, row] of results.entries()) {
    if (!row.creation_partial) continue;
    const partial = sanitizeReceiptResultForOutput(row).creation_partial!;
    blockers.push({ item_id: partial.created_invoice_id !== undefined ? `invoice-${partial.created_invoice_id}` : `receipt-creation-${index}`, code: "receipt_creation_partial", severity: "blocker",
      message: partial.created_invoice_id !== undefined
        ? `Invoice ${partial.created_invoice_id} was created but follow-up failed; cleanup ${partial.cleanup}. Inspect this known invoice before any new preview. Automatic retry is forbidden.`
        : "Receipt creation may have committed, but no invoice ID is known. Reconcile supplier, invoice number, date and gross against live invoices before a new preview. Automatic retry is forbidden.",
      creation_partial: partial,
    });
  }
  for (const row of results) {
    if (!row.bank_partial) continue;
    const partial = row.bank_partial;
    blockers.push({ item_id: `invoice-${row.created_invoice?.id}`, code: partial.category, severity: "blocker",
      message: `Invoice ${row.created_invoice?.id} retained unlinked; transaction ${partial.transaction_id} held (${partial.changed_fields.join(", ")}). ${partial.client_update ? `Client changed from ${partial.client_update.from} to ${partial.client_update.to}.` : partial.mutation_may_have_occurred ? "Client update may have occurred." : "No bank client update occurred."} Fresh review required; do not retry automatically.` });
  }
  if (!dryRun && summary.failed > 0) {
    blockers.push({
      item_id: "receipt-batch",
      code: "receipt_processing_failed",
      message: partialCreations > 0 ? `${summary.failed} receipt(s) failed to process. Inspect known created invoice IDs and cleanup outcomes; do not recreate automatically.`
        : `${summary.failed} receipt(s) failed to process. Re-preview before retrying; a prior preview is not approval.`,
      severity: "blocker",
    });
  }
  if (unconfirmed > 0) {
    blockers.push({
      item_id: "receipt-batch-partial",
      code: "created_not_confirmed",
      message: `${unconfirmed} invoice(s) were created but not confirmed. Confirm them separately — creation and confirmation are distinct approvals.`,
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
  // obtain it (args hold only real receipt_batch inputs, so they can be resent
  // verbatim), and a manifest NEVER implies approval — it is the bytes to resend,
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
          approved_manifest: input.responseManifest ?? result.manifest,
          // P0-3: the create call REQUIRES this consume-once handle bound to the
          // reviewed effect; without it create fails closed (plan_handle_required).
          ...(result.planHandles?.create !== undefined ? { plan_handle: result.planHandles.create } : {}),
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
    // P0-3: both per-effect handles. next_action carries the `create` one; a
    // separately approved create_and_confirm resends next_action.args with
    // mode "create_and_confirm" and plan_handles.create_and_confirm instead.
    ...(dryRun && result.planHandles !== undefined ? { plan_handles: { ...result.planHandles } } : {}),
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary: operationSummary };
}
