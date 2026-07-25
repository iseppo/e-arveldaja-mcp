import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { toolError } from "../tool-error.js";
import { roundMoney } from "../money.js";
import { createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import { createPublicOperationResultDetail, type PublicOperationResultDetail } from "../operation-result-store.js";
import type { PlanStoreError } from "../plan-store.js";
import type { FileInputSource, FileInputIdentity } from "../file-input-snapshot.js";
import {
  bookedCurrencyForWiseRow,
  counterpartyNameForWiseRow,
  isNonErrorWiseSkipReason,
  summarizeWiseSkippedEntries,
} from "./preflight.js";
import { projectWiseCommand } from "./projection.js";
import { WISE_COMMAND_VERSION } from "./types.js";
import type { WiseFailure } from "./executor.js";
import type {
  ImportRejectedField,
  WiseCreatedEntry,
  WiseImportCommand,
  WiseInterAccountResult,
  WiseInvoiceFixCandidate,
  WiseSkippedEntry,
  WiseSkippedJarRow,
  WiseTransferReview,
} from "./types.js";

// OUTPUT layer. The only Wise module that shapes MCP envelopes and applies the
// OCR/untrusted-text sandbox (wrapUntrustedOcr). The pure preflight/projection
// modules never sandbox — the presenter does, exactly as before. Standard/full
// keep the byte-identical full envelope; guided/guided-sales adopt the compact
// presenter (added in Phase B).

const MAX_EXPOSED_ISSUES = 100;
const MAX_EXPOSED_VALUE_CHARS = 256;

// --- Failure envelopes (moved verbatim from the handler) ---------------------

/**
 * Bounded, sandboxed failure payload. The fixed `error` string is load-bearing:
 * without it toolError() falls through to serializeUnknownError(), which
 * JSON.stringifies the whole payload into one 500-char string and defeats both
 * the sandbox wrapping and the truncation below.
 */
export function wisePreflightFailure(rejected: ImportRejectedField[]) {
  return toolError({
    error: "Import preflight failed",
    category: "import_preflight_failed",
    source: "wise",
    rejected_field_count: rejected.length,
    rejected_fields_truncated: rejected.length > MAX_EXPOSED_ISSUES,
    rejected_fields: rejected.slice(0, MAX_EXPOSED_ISSUES).map(issue => ({
      source_row_id: issue.source_row_id,
      field: issue.field,
      value: wrapUntrustedOcr(issue.value.slice(0, MAX_EXPOSED_VALUE_CHARS)),
      reason: issue.reason,
    })),
    mutation_occurred: false,
  });
}

export function digestMismatch() {
  return toolError({
    error: "The Wise command approval digest does not match the current mutation plan.",
    category: "digest_mismatch",
    code: "approval_digest_mismatch",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
    next_action: "Run a new Wise dry run, review its complete command plan, and approve that exact digest.",
  });
}

/** A PlanStoreError (invalid/consumed/expired/domain/scope) surfaced as a
 * structured, non-mutating tool error carrying the exact store code. */
export function planStoreErrorResult(error: Pick<PlanStoreError, "code" | "message">) {
  return toolError({
    error: error.message,
    category: error.code,
    code: error.code,
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  });
}

/** A required-but-missing plan handle blocks execute before any work. */
export function planHandleRequiredResult() {
  return toolError({
    error: "A reviewed execution-plan handle from the Wise dry run is required to execute. The digest alone cannot execute; re-run the dry run and pass its plan_handle.",
    category: "plan_handle_required",
    code: "plan_handle_required",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  });
}

/** Any source/argument/live/command drift between the reviewed plan and the
 * re-derived plan stops execution with zero mutations. */
export function planDriftResult(detail: string) {
  return toolError({
    error: `The reviewed Wise plan no longer matches the re-read source and current ledger: ${detail}`,
    category: "plan_drift",
    code: "plan_drift",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
    next_action: "Run a new Wise dry run, review the fresh plan, and execute with its new plan handle and digest.",
  });
}

/** The operator's ownership approvals must equal the previewed unverified
 * transfer IDs exactly, in the presented order (extra/missing/reordered all
 * invalidate). This is a distinct, clearer signal than a digest mismatch. */
export function ownershipReapprovalRequiredResult() {
  return toolError({
    error: "Wise ownership approvals must match the previewed unverified transfer IDs exactly, in the order presented. Extra, missing, or reordered approvals invalidate the plan — re-run the dry run, approve the enumerated IDs only, and use the new plan handle and digest.",
    category: "wise_transfer_ownership_reapproval_required",
    code: "wise_transfer_ownership_reapproval_required",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  });
}

export function wiseClientNotFoundResult() {
  return toolError({
    error: "Wise client not found — create a client named 'Wise' (or 'TransferWise') before importing with fee rows, otherwise every fee transaction is left unconfirmed and must be cleaned up manually.",
    mutation_occurred: false,
  });
}

/** Map a structured executor failure to the exact non-mutating MCP envelope it
 * produced before the refactor. Byte-identical to the inline handler returns. */
export function renderWiseFailure(failure: WiseFailure) {
  switch (failure.kind) {
    case "preflight": return wisePreflightFailure(failure.rejected);
    case "plan_store_error": return planStoreErrorResult({ code: failure.code, message: failure.message } as Pick<PlanStoreError, "code" | "message">);
    case "plan_handle_required": return planHandleRequiredResult();
    case "digest_mismatch": return digestMismatch();
    case "plan_drift": return planDriftResult(failure.detail);
    case "ownership_reapproval_required": return ownershipReapprovalRequiredResult();
    case "wise_client_not_found": return wiseClientNotFoundResult();
  }
}

// --- Render data -------------------------------------------------------------

export interface WiseImportRenderData {
  mode: "DRY_RUN" | "EXECUTED";
  executeRequested: boolean;
  source: FileInputSource;
  sourceIdentity: FileInputIdentity;
  accountsDimensionsId: number;
  totalCsvRows: number;
  eligibleCount: number;
  skippedJarCount: number;
  skippedJarRows: WiseSkippedJarRow[];
  created: WiseCreatedEntry[];
  skipped: WiseSkippedEntry[];
  commands: WiseImportCommand[];
  approvedCommandDigest: string | undefined;
  planHandle: string | undefined;
  autoDetectedInterAccountDimId: number | undefined;
  hasHintedRows: boolean;
  interAccountResults: WiseInterAccountResult[];
  ownershipReviews: WiseTransferReview[];
  invoiceFixCandidates: WiseInvoiceFixCandidate[];
  args: {
    feeAccountDimensionsId: number | undefined;
    feeAccountRelationId: number | undefined;
    interAccountDimensionId: number | undefined;
    confirmOwnTransferIds: string[] | undefined;
    dateFrom: string | undefined;
    dateTo: string | undefined;
    skipJarTransfers: boolean | undefined;
  };
}

export type WiseImportPreview = WiseImportRenderData;
export type WiseImportExecution = WiseImportRenderData;

// --- FULL envelope (standard/full — byte-identical to the pre-refactor tool) --

export function renderWiseImportFull(data: WiseImportRenderData): { content: Array<{ type: "text"; text: string }> } {
  const {
    mode,
    executeRequested,
    source,
    sourceIdentity,
    accountsDimensionsId: accounts_dimensions_id,
    totalCsvRows,
    eligibleCount,
    skippedJarCount,
    skippedJarRows,
    created,
    skipped,
    commands,
    approvedCommandDigest,
    planHandle,
    autoDetectedInterAccountDimId,
    hasHintedRows,
    interAccountResults,
    ownershipReviews,
    invoiceFixCandidates,
  } = data;
  const file_ref = source.file_ref;
  const file_path = source.file_path;
  const { feeAccountDimensionsId: fee_account_dimensions_id, feeAccountRelationId: fee_account_relation_id, interAccountDimensionId: inter_account_dimension_id, confirmOwnTransferIds: confirm_own_transfer_ids, dateFrom: date_from, dateTo: date_to, skipJarTransfers: skip_jar_transfers } = data.args;

  const executionSkipped = skipped.filter(entry => isNonErrorWiseSkipReason(entry.reason));
  const executionErrors = skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason));
  const summary = {
    total_csv_rows: totalCsvRows,
    eligible: eligibleCount,
    filtered_out: totalCsvRows - eligibleCount,
    skipped_jar_transfers: skippedJarCount,
    created: created.length,
    skipped: executionSkipped.length,
    error_count: executionErrors.length,
    inter_account_total: interAccountResults.length,
    needs_review: ownershipReviews.length,
  };
  const invoiceCurrencyFixes = invoiceFixCandidates.length > 0
    ? {
        total: invoiceFixCandidates.length,
        foreign_currency_lock: invoiceFixCandidates.filter(f => f.category === "foreign_currency_lock").length,
        eur_legacy_autofix: invoiceFixCandidates.filter(f => f.category === "eur_legacy_autofix").length,
        updated: invoiceFixCandidates.filter(f => f.result === "updated").length,
        errors: invoiceFixCandidates.filter(f => f.result === "error").length,
        // `supplier_name` is the raw Wise counterparty (targetName/sourceName)
        // CSV column — sandbox-wrap it at the output boundary so a tampered
        // statement cannot inject through the dry-run preview or the top-level
        // result. The ambiguous-match prose also embeds the raw supplier name,
        // so it is rebuilt here with the same wrap (kept out of the pure
        // projection). Every other candidate field is a number, a trusted RIK
        // invoice value, or a server-built string.
        candidates: invoiceFixCandidates.map(({ row_index: _rowIndex, current_object_state: _state, ...c }) => ({
          ...c,
          ...(c.result === "ambiguous_skipped"
            ? { proposed_action: `Ambiguous match — multiple unpaid invoices for ${wrapUntrustedOcr(c.supplier_name) ?? ""} match Wise row ${c.wise_id}; resolve manually before applying.` }
            : {}),
          supplier_name: wrapUntrustedOcr(c.supplier_name) ?? c.supplier_name,
        })),
      }
    : undefined;

  // `reason` is built from raw exception text (err.message) which can echo
  // upstream API content. Wrap at MCP output so any CSV-origin bytes echoed
  // through an error reach the LLM sandboxed.
  const sanitizeReason = (entry: { wise_id: string; reason: string }) => ({
    ...entry,
    reason: wrapUntrustedOcr(entry.reason) ?? entry.reason,
  });
  const sanitizedSkippedDetails = summarizeWiseSkippedEntries(skipped).map(group => ({
    ...group,
    reason: wrapUntrustedOcr(group.reason) ?? group.reason,
  }));
  const sanitizedExecutionSkipped = executionSkipped.map(sanitizeReason);
  const sanitizedExecutionErrors = executionErrors.map(sanitizeReason);
  const workflowArgs = {
    ...(file_ref !== undefined ? { file_ref } : {}),
    ...(file_ref === undefined && file_path !== undefined && !file_path.toLowerCase().startsWith("base64:")
      ? { file_path }
      : {}),
    accounts_dimensions_id,
    ...(fee_account_dimensions_id !== undefined ? { fee_account_dimensions_id } : {}),
    ...(fee_account_relation_id !== undefined ? { fee_account_relation_id } : {}),
    ...(inter_account_dimension_id !== undefined ? { inter_account_dimension_id } : {}),
    ...(confirm_own_transfer_ids !== undefined ? { confirm_own_transfer_ids } : {}),
    ...(date_from ? { date_from } : {}),
    ...(date_to ? { date_to } : {}),
    ...(skip_jar_transfers !== undefined ? { skip_jar_transfers } : {}),
    ...(approvedCommandDigest ? { approved_command_digest: approvedCommandDigest } : {}),
    ...(planHandle ? { plan_handle: planHandle } : {}),
    execute: false,
  };
  const workflowSummary = !executeRequested
    ? `Wise dry run would create ${summary.created} bank transaction(s), skip ${summary.skipped}, and report ${summary.error_count} error(s).`
    : `Wise import created ${summary.created} bank transaction(s), skipped ${summary.skipped}, and reported ${summary.error_count} error(s).`;
  const workflow = buildWorkflowEnvelope({
    summary: workflowSummary,
    dry_run_steps: !executeRequested
      ? [{
          tool: "import_wise_transactions",
          summary: workflowSummary,
          suggested_args: workflowArgs,
          preview: {
            ...summary,
            command_count: commands.length,
            ...(invoiceCurrencyFixes ? { invoice_currency_fixes: invoiceCurrencyFixes } : {}),
          },
        }]
      : [],
  });
  const outputResults = created.map(({ description: _description, source_row: _sourceRow, ...rest }) => rest);

  return {
    content: [{
      type: "text",
      text: toMcpJson({
        mode,
        ...(file_ref !== undefined
          ? { source_file_ref: file_ref }
          : file_path !== undefined && !file_path.toLowerCase().startsWith("base64:")
            ? { source_file: wrapUntrustedOcr(file_path) }
            : { source_identity: sourceIdentity, source_resubmission_required: true }),
        summary,
        workflow,
        total_csv_rows: summary.total_csv_rows,
        eligible: summary.eligible,
        filtered_out: summary.filtered_out,
        ...(skippedJarCount > 0 ? {
          skipped_jar_transfers: skippedJarCount,
          skipped_jar_transfer_details: skippedJarRows,
        } : {}),
        created: summary.created,
        skipped: skipped.length,
        ...(approvedCommandDigest ? { approved_command_digest: approvedCommandDigest } : {}),
        ...(planHandle ? { plan_handle: planHandle } : {}),
        command_version: WISE_COMMAND_VERSION,
        command_count: commands.length,
        ...(autoDetectedInterAccountDimId && hasHintedRows ? {
          inter_account_auto_detected_dimension_id: autoDetectedInterAccountDimId,
        } : {}),
        ...(interAccountResults.length > 0 || (executeRequested && commands.some(command => command.action === "inter_account")) ? {
          inter_account_reconciliation: {
            total: interAccountResults.length,
            already_journalized: interAccountResults.filter(r => r.status === "already_journalized").length,
            confirmed: interAccountResults.filter(r => r.status === "confirmed_inter_account").length,
            details: interAccountResults,
          },
        } : {}),
        ...(ownershipReviews.length > 0 ? { ownership_reviews: ownershipReviews } : {}),
        ...(invoiceCurrencyFixes ? { invoice_currency_fixes: invoiceCurrencyFixes } : {}),
        results: outputResults,
        skipped_details: sanitizedSkippedDetails,
        execution: {
          ...buildBatchExecutionContract({
            mode,
            summary,
            results: outputResults,
            skipped: sanitizedExecutionSkipped,
            errors: sanitizedExecutionErrors,
            needs_review: ownershipReviews,
          }),
          commands: commands.map(projectWiseCommand),
        },
      }),
    }],
  };
}

// --- COMPACT presenter (guided / guided-sales) -------------------------------
//
// Size is approximately CONSTANT regardless of row count: counts/totals are
// scalars, at most THREE samples are inlined, and the full per-row detail is
// referenced via get_operation_result_page (execute) or the plan_handle
// (dry run). Blockers (execution errors) are never hidden. Untrusted free-form
// text (counterparty + any raw reference) is OCR-sandbox-wrapped here.

function isDuplicateSkip(reason: string): boolean {
  return reason.startsWith("Already imported") || reason.startsWith("Fee already imported");
}

/**
 * Safe, scalar-only per-row details for the operation-result store. The
 * free-form fields (counterparty/description/reference) are intentionally
 * omitted — the store forbids/does not sandbox them; the compact samples carry
 * the wrapped counterparty/reference instead.
 */
export function buildWiseResultDetailItems(data: WiseImportRenderData): PublicOperationResultDetail[] {
  return data.created.map((row, index) => createPublicOperationResultDetail({
    i: index,
    status: row.status,
    date: row.date,
    amount: row.amount,
    ...(typeof row.api_id === "number" ? { id: row.api_id } : {}),
  }));
}

export interface WiseCompactInput {
  readonly mode: "DRY_RUN" | "EXECUTED";
  readonly data: WiseImportRenderData;
  /** Execute only: an operation-result handle bound to the consumed Wise plan. */
  readonly operationHandle?: string;
}

export function renderWiseImportCompact(input: WiseCompactInput): { summary: OperationSummaryV1 } {
  const { mode, data } = input;
  const dryRun = mode === "DRY_RUN";

  const executionSkipped = data.skipped.filter(entry => isNonErrorWiseSkipReason(entry.reason));
  const executionErrors = data.skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason));
  const duplicateCount = data.skipped.filter(entry => isDuplicateSkip(entry.reason)).length;

  const inEntries = data.created.filter(entry => entry.source_direction === "IN");
  const outEntries = data.created.filter(entry => entry.source_direction === "OUT");

  const counts = {
    total_csv_rows: data.totalCsvRows,
    eligible: data.eligibleCount,
    filtered_out: data.totalCsvRows - data.eligibleCount,
    [dryRun ? "would_create" : "created"]: data.created.length,
    in_count: inEntries.length,
    out_count: outEntries.length,
    skipped: executionSkipped.length,
    duplicates: duplicateCount,
    errors: executionErrors.length,
    needs_review: data.ownershipReviews.length,
    inter_account: data.interAccountResults.length,
    invoice_currency_fixes: data.invoiceFixCandidates.length,
  };
  const totals = {
    in_total: roundMoney(inEntries.reduce((sum, entry) => sum + entry.amount, 0)),
    out_total: roundMoney(outEntries.reduce((sum, entry) => sum + entry.amount, 0)),
  };

  // Ownership transfers that could not be auto-verified surface as warnings —
  // never dropped from the lean surface.
  const warnings: CompactWarning[] = data.ownershipReviews.map(review => ({
    item_id: review.wise_id,
    code: review.code,
    message: review.reason,
  }));

  // Execution errors (indeterminate / failed commands) surface as blockers —
  // never hidden.
  const blockers: CompactReviewItem[] = [];
  if (!dryRun && executionErrors.length > 0) {
    blockers.push({
      item_id: "wise-import",
      code: "import_incomplete",
      message: `${executionErrors.length} Wise command(s) did not complete. Re-preview before retrying; a prior plan is not approval.`,
      severity: "blocker",
    });
  }

  const samples = data.created.slice(0, 3).map((row, index) => ({
    i: index,
    status: row.status,
    date: row.date,
    amount: row.amount,
    ...(row.source_row ? { currency: bookedCurrencyForWiseRow(row.source_row) } : {}),
    type: row.type,
    source_direction: row.source_direction,
    // Free-form CSV fields are OCR-sandbox-wrapped at this output layer; identity
    // and dedup operate on the raw row upstream, so wrapping here is safe.
    ...(row.source_row
      ? (() => {
          const counterparty = counterpartyNameForWiseRow(row.source_row);
          return counterparty !== undefined ? { counterparty: wrapUntrustedOcr(counterparty) } : {};
        })()
      : {}),
    ...(row.source_row && row.source_row.reference
      ? { reference: wrapUntrustedOcr(row.source_row.reference) }
      : {}),
  }));

  const baseMessage = dryRun
    ? `Wise dry run would create ${data.created.length} bank transaction(s), skip ${executionSkipped.length}, and report ${executionErrors.length} error(s).`
    : `Wise import created ${data.created.length} bank transaction(s), skipped ${executionSkipped.length}, and reported ${executionErrors.length} error(s).`;

  const status = dryRun
    ? "ready_for_approval" as const
    : (executionErrors.length > 0 ? "partial" as const : "completed" as const);

  // Statement identity: the Wise bank dimension identifies the account; the
  // source-file identity (opaque file_ref, otherwise the content digest, and an
  // OCR-wrapped file_path) identifies the statement. A raw base64 upload is
  // represented by its digest only.
  const fileId = data.source.file_ref !== undefined
    ? data.source.file_ref
    : (data.source.file_path !== undefined && !data.source.file_path.toLowerCase().startsWith("base64:"))
      ? wrapUntrustedOcr(data.source.file_path)
      : data.sourceIdentity.digest_sha256;
  const scope = {
    account: String(data.accountsDimensionsId),
    ...(fileId !== undefined ? { source_documents: [fileId] } : {}),
  } as OperationSummaryV1["scope"];

  const details = !dryRun && input.operationHandle !== undefined
    ? {
        available: data.created.length > samples.length,
        total_items: data.created.length,
        returned_items: samples.length,
        tool: "get_operation_result_page",
        args: { operation_handle: input.operationHandle },
      }
    : undefined;

  // The Wise execute gate requires BOTH the plan handle and the exact command
  // digest. The compact surface is the only Wise path the guided profiles have
  // (import_wise_transactions is not registered there), so a summary carrying
  // the handle alone left the operator unable to execute at all: execute
  // rejected with digest_mismatch and the advised "run a new dry run" produced
  // another digest-less summary. Emit the execute call in full — the digest is
  // an approval artifact the caller echoes back, not a secret. The planning
  // args are repeated verbatim because plan drift binds canonicalPlanningArgs.
  // A base64 upload cannot have its source echoed back: file_ref is absent and
  // the payload itself can be megabytes, so the full envelope omits it too and
  // flags source_resubmission_required instead. next_action.args therefore
  // carries no source key on that path — but suppressing next_action outright
  // would leave a base64 statement with no way to reach the digest, i.e. the
  // very dead end this fix exists to close. Emit it, and say plainly in the
  // message that the caller must add the statement bytes back. args has no room
  // for the marker: the input schema rejects unknown keys.
  const sourceResubmissionRequired = data.source.file_ref === undefined
    && !(data.source.file_path !== undefined && !data.source.file_path.toLowerCase().startsWith("base64:"));
  const nextAction = dryRun && data.planHandle !== undefined && data.approvedCommandDigest !== undefined
    ? {
        tool: "process_bank_input",
        args: {
          mode: "execute",
          ...(data.source.file_ref !== undefined
            ? { file_ref: data.source.file_ref }
            : data.source.file_path !== undefined && !data.source.file_path.toLowerCase().startsWith("base64:")
              ? { file_path: data.source.file_path }
              : {}),
          accounts_dimensions_id: data.accountsDimensionsId,
          ...(data.args.dateFrom ? { date_from: data.args.dateFrom } : {}),
          ...(data.args.dateTo ? { date_to: data.args.dateTo } : {}),
          ...(data.args.feeAccountDimensionsId !== undefined ? { fee_account_dimensions_id: data.args.feeAccountDimensionsId } : {}),
          ...(data.args.interAccountDimensionId !== undefined ? { inter_account_dimension_id: data.args.interAccountDimensionId } : {}),
          ...(data.args.confirmOwnTransferIds !== undefined ? { confirm_own_transfer_ids: data.args.confirmOwnTransferIds } : {}),
          ...(data.args.skipJarTransfers !== undefined ? { skip_jar_transfers: data.args.skipJarTransfers } : {}),
          plan_handle: data.planHandle,
          approved_command_digest: data.approvedCommandDigest,
        },
        approval_required: true,
      }
    : undefined;

  const message = nextAction !== undefined && sourceResubmissionRequired
    ? `${baseMessage} The statement was supplied inline, so it is not echoed back: add the same file_path (or file_ref) to the next call alongside the approval artifacts.`
    : baseMessage;

  const summary = createOperationSummary({
    status,
    message,
    counts,
    totals,
    scope,
    warnings,
    blockers,
    samples,
    ...(nextAction ? { next_action: nextAction } : {}),
    ...(dryRun && data.planHandle !== undefined ? { plan_handle: data.planHandle } : {}),
    ...(details ? { details } : {}),
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary };
}
