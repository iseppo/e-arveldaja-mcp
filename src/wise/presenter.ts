import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { toolError } from "../tool-error.js";
import { roundMoney } from "../money.js";
import { cappedWarnings, createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import {
  createPublicOperationResultDetail,
  type OperationResultStatus,
  type OperationResultStore,
  type PublicOperationResultDetail,
} from "../operation-result-store.js";
import { importPreflightFailurePayload } from "../camt/presenter.js";
import type { PlanStoreError } from "../plan-store.js";
import type { FileInputSource, FileInputIdentity } from "../file-input-snapshot.js";
import {
  bookedCurrencyForWiseRow,
  counterpartyNameForWiseRow,
  isAlreadyBookedWiseSkipReason,
  isNonErrorWiseSkipReason,
  summarizeWiseSkippedEntries,
} from "./preflight.js";
import { projectWiseCommand, SHA256_HEX, WISE_PLAN_DOMAIN } from "./projection.js";
import { WISE_COMMAND_VERSION } from "./types.js";
import type { WiseFailure } from "./executor.js";
import type {
  ImportRejectedField,
  WiseAlreadyJournalizedAssertion,
  WiseCreatedEntry,
  WiseImportCommand,
  WiseInterAccountResult,
  WiseInvoiceFixCandidate,
  WiseSkippedEntry,
  WiseSkippedJarRow,
  WiseJournalizedTransferMapping,
  WiseTransferReview,
} from "./types.js";

// OUTPUT layer. The only Wise module that shapes MCP envelopes and applies the
// OCR/untrusted-text sandbox (wrapUntrustedOcr). The pure preflight/projection
// modules never sandbox — the presenter does, exactly as before. Standard/full
// keep the byte-identical full envelope; guided/guided-sales adopt the compact
// presenter (added in Phase B).

// --- Failure envelopes -------------------------------------------------------

/** The bounded, sandboxed preflight-failure payload shared with CAMT. */
export function wisePreflightFailure(rejected: ImportRejectedField[]) {
  return toolError(importPreflightFailurePayload("wise", rejected));
}

export function digestMismatch() {
  return toolError({
    error: "The Wise command approval digest does not match the current mutation plan.",
    category: "digest_mismatch",
    code: "approval_digest_mismatch",
    retry: "never",
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
    retry: "never",
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
    retry: "never",
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
    retry: "never",
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
    retry: "never",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  });
}

export function wiseClientNotFoundResult() {
  return toolError({
    error: "Wise client not found — create a client named 'Wise' (or 'TransferWise') before importing with fee rows, otherwise every fee transaction is left unconfirmed and must be cleaned up manually.",
    retry: "never",
    mutation_occurred: false,
  });
}

/** Digest input-format gate, checked by the Wise entry points before any file
 * read, ledger read, cache flush, plan consume, or mutation. Returns the
 * digest-mismatch envelope to send, or undefined when the input passes. */
export function wiseDigestInputRejection(approvedCommandDigest: unknown, executeRequested: boolean) {
  if (approvedCommandDigest !== undefined && (
    typeof approvedCommandDigest !== "string" || !SHA256_HEX.test(approvedCommandDigest)
  )) {
    return digestMismatch();
  }
  if (executeRequested && !SHA256_HEX.test((approvedCommandDigest as string | undefined) ?? "")) {
    return digestMismatch();
  }
  return undefined;
}

/** Reproject a simple-kind OperationOutcome error (which carries no data beyond
 * its discriminant) back into its WiseFailure so renderWiseFailure emits the
 * exact same envelope as before. The rich kinds never travel this path — they
 * are thrown as WiseOperationFailedError and rendered in the handler's catch. */
export function simpleWiseFailureFromCode(code: string): WiseFailure {
  switch (code) {
    case "plan_handle_required": return { kind: "plan_handle_required" };
    case "digest_mismatch": return { kind: "digest_mismatch" };
    case "ownership_reapproval_required": return { kind: "ownership_reapproval_required" };
    case "wise_client_not_found": return { kind: "wise_client_not_found" };
    default: throw new Error(`Unexpected Wise operation error code: ${code}`);
  }
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
  /** Transfers an existing journal already books: not commands, no writes. */
  alreadyJournalized: WiseAlreadyJournalizedAssertion[];
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
    journalizedTransferIds?: readonly WiseJournalizedTransferMapping[];
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
    alreadyJournalized,
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
        // Advisory only: the import never modifies a confirmed invoice; each
        // candidate carries its proposed_correction for a deliberate manual fix.
        advisory_only: true,
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
  // Dry run: already-booked rows are not repeated one by one in
  // execution.skipped — skipped_details groups them (with per-row `records`
  // for ledger-matched rows). Every other skip stays itemised; an executed run
  // keeps the full per-row record.
  const dryRun = mode === "DRY_RUN";
  const displayedExecutionSkipped = dryRun
    ? executionSkipped.filter(entry => !isAlreadyBookedWiseSkipReason(entry.reason))
    : executionSkipped;
  const sanitizedExecutionSkipped = displayedExecutionSkipped.map(sanitizeReason);
  // Dry run: transfers an existing journal already books are not commands;
  // they are listed as a compact table.
  const alreadyJournalizedRows = dryRun ? alreadyJournalized : [];
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
    ...(data.args.journalizedTransferIds !== undefined ? { journalized_transfer_ids: data.args.journalizedTransferIds } : {}),
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
          // invoice_currency_fixes is advisory (never applied), so it stays out
          // of the approval preview's accounting impact.
          preview: {
            ...summary,
            command_count: commands.length,
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
        ...(interAccountResults.length > 0 ||
          (executeRequested && (commands.some(command => command.action === "inter_account") || alreadyJournalized.length > 0)) ? {
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
          ...(dryRun ? {
            skipped_displayed: displayedExecutionSkipped.length,
            skipped_omitted_already_booked: executionSkipped.length - displayedExecutionSkipped.length,
            ...(executionSkipped.length > displayedExecutionSkipped.length
              ? { skipped_omitted_note: "Already-booked rows are grouped in skipped_details (records lists each ledger-matched row's journal/transaction id)." }
              : {}),
          } : {}),
          ...(alreadyJournalizedRows.length > 0 ? {
            already_journalized_count: alreadyJournalizedRows.length,
            already_journalized_rows: alreadyJournalizedRows.map(assertion => ({
              wise_id: wrapUntrustedOcr(assertion.wise_id) ?? assertion.wise_id,
              existing_journal_id: assertion.existing_journal_id,
              date: assertion.date,
              booked_amount: assertion.booked_amount,
              booked_currency: assertion.booked_currency,
              source_direction: assertion.source_direction,
            })),
            already_journalized_note: "Not part of the approved commands: no writes. Execute re-checks each journal once, after all writes, and reports a changed journal as an error.",
          } : {}),
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

// An automatic match (auto_match) is counted on its own, never as a plain
// duplicate: it is a judgement the operator can object to.
function isDuplicateSkip(entry: WiseSkippedEntry): boolean {
  return entry.auto_match === undefined &&
    (entry.reason.startsWith("Already imported") || entry.reason.startsWith("Fee already imported"));
}

function autoMatchWarning(entry: WiseSkippedEntry & { auto_match: NonNullable<WiseSkippedEntry["auto_match"]> }): CompactWarning {
  const { code, transaction_id: transactionId, journal_id: journalId } = entry.auto_match;
  const what = entry.reason.startsWith("Fee") ? "Fee row" : "Row";
  const target = transactionId !== undefined
    ? `stored confirmed transaction ${transactionId} on this Wise account`
    : `inter-account journal ${journalId}`;
  const undo = transactionId !== undefined
    ? `if it is a different movement, correct or delete transaction ${transactionId}`
    : `if the journal is not this transfer, correct or delete journal ${journalId}`;
  return {
    item_id: entry.wise_id,
    code,
    message: `${what} not created: automatic match (${code}) to ${target}. If wrong: ${undo}, then re-run the preview.`,
  };
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

/**
 * Execute-only: mint an operation-result handle bound to the just-consumed Wise
 * plan so the compact response can reference get_operation_result_page for the
 * full per-row detail. Fail-safe — the import already mutated, so a store
 * failure degrades to a compact response without the handle.
 */
export function issueWiseResultHandle(
  store: Pick<OperationResultStore, "issue">,
  data: WiseImportRenderData,
  planHandle: string | undefined,
): string | undefined {
  if (typeof planHandle !== "string" || planHandle.length === 0) return undefined;
  try {
    const errorCount = data.skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason)).length;
    const status: OperationResultStatus = errorCount === 0 ? "completed" : "partial";
    return store.issue({
      operation: WISE_PLAN_DOMAIN,
      status,
      items: buildWiseResultDetailItems(data),
      plan_handle: planHandle,
    });
  } catch {
    return undefined;
  }
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
  // A dry run with no commands has nothing to approve and issues no plan.
  const zeroWrite = dryRun && data.commands.length === 0;

  const executionSkipped = data.skipped.filter(entry => isNonErrorWiseSkipReason(entry.reason));
  const executionErrors = data.skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason));
  const duplicateCount = data.skipped.filter(isDuplicateSkip).length;
  const autoMatched = data.skipped.filter((entry): entry is WiseSkippedEntry & { auto_match: NonNullable<WiseSkippedEntry["auto_match"]> } =>
    entry.auto_match !== undefined);

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
    auto_matched: autoMatched.length,
    errors: executionErrors.length,
    needs_review: data.ownershipReviews.length,
    inter_account: data.interAccountResults.length,
    // Preview: the rows the plan asserts as already booked. Execute: only the
    // ones whose journal the post-write re-check verified.
    already_journalized: dryRun
      ? data.alreadyJournalized.length
      : data.interAccountResults.filter(result => result.status === "already_journalized").length,
    invoice_currency_fixes: data.invoiceFixCandidates.length,
  };
  // A Wise statement can hold rows booked in different currencies, and these are
  // plain sums of `amount` — 100 USD + 50 EUR became an unlabelled 150 on the
  // approval card. Label the total when every summed row agrees, and say so
  // plainly when they do not; the ledger is unaffected either way, but this is
  // the figure the operator approves against.
  // Fee rows are synthesised and carry no source_row, but they DO land in
  // outEntries and in out_total — so they must vote, or a fee booked in a
  // currency no statement row uses would be added to the total without being
  // able to change the label or trigger the warning.
  const totalCurrencies = new Set(
    [...inEntries, ...outEntries]
      .map(entry => entry.booked_currency
        ?? (entry.source_row ? bookedCurrencyForWiseRow(entry.source_row) : undefined))
      .filter((currency): currency is string => currency !== undefined && currency.length > 0),
  );
  const totalsCurrency = totalCurrencies.size === 1 ? [...totalCurrencies][0]! : undefined;
  const totals: Record<string, number | string> = {
    in_total: roundMoney(inEntries.reduce((sum, entry) => sum + entry.amount, 0)),
    out_total: roundMoney(outEntries.reduce((sum, entry) => sum + entry.amount, 0)),
    ...(totalsCurrency !== undefined ? { currency: totalsCurrency } : {}),
  };

  // Ownership transfers that could not be auto-verified surface as warnings —
  // never dropped from the lean surface.
  const warnings: CompactWarning[] = data.ownershipReviews.map(review => ({
    item_id: review.wise_id,
    code: review.code,
    message: review.reason,
  }));
  // Invoice FX corrections are advisory only (never applied); surface them so
  // the lean surface does not drop them. proposed_action is server-built from
  // numbers and the upstream invoice number, which the projection sandbox-wraps.
  for (const fix of data.invoiceFixCandidates) {
    if (fix.result !== "advisory") continue;
    warnings.push({ item_id: fix.wise_id, code: "wise_invoice_currency_advisory", message: fix.proposed_action });
  }
  // Automatic matches name the stored row / journal and how to undo them;
  // there is no flag to switch them off.
  const autoMatchMoreHint = zeroWrite
    ? "nothing will be written; to see them all, re-run process_bank_input mode='prepare' with a narrower date_from/date_to (each preview lists up to 3 per kind), or use import_wise_transactions on the standard/full profile, where skipped_details[].records lists every match."
    : dryRun && data.planHandle !== undefined
      ? `page them with get_execution_plan_page { plan_handle: "${data.planHandle}", section: "exclusions", detail: "full" }.`
      : "re-run the preview and page its plan exclusions with get_execution_plan_page.";
  for (const code of ["wise_untagged_ledger_unique", "wise_transfer_journal_unique_legacy"] as const) {
    warnings.push(...cappedWarnings(code, autoMatched.filter(entry => entry.auto_match.code === code).map(autoMatchWarning), autoMatchMoreHint));
  }
  if (totalCurrencies.size > 1) {
    warnings.push({
      code: "mixed_currency_totals",
      message: `in_total / out_total add up rows booked in ${[...totalCurrencies].sort().join(", ")}, so they are not a single-currency figure; read the per-row amounts before approving.`,
    });
  }

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

  const journalizedSkips = data.skipped.filter(entry =>
    entry.reason.startsWith("Already journalized") || entry.reason.startsWith("Fee already journalized")).length;
  const importedSkips = data.skipped.filter(entry =>
    entry.reason.startsWith("Already imported") || entry.reason.startsWith("Fee already imported")).length;
  const baseMessage = zeroWrite
    ? `Nothing to approve: the Wise dry run found no rows to write (${journalizedSkips + importedSkips} already booked: ${journalizedSkips} already journalized, ${importedSkips} already imported); no plan handle was issued.`
    : dryRun
      ? `Wise dry run would create ${data.created.length} bank transaction(s), skip ${executionSkipped.length}, and report ${executionErrors.length} error(s).`
      : `Wise import created ${data.created.length} bank transaction(s), skipped ${executionSkipped.length}, and reported ${executionErrors.length} error(s).`;

  const status = zeroWrite
    ? (executionErrors.length > 0 || data.ownershipReviews.length > 0 ? "needs_review" as const : "completed" as const)
    : dryRun
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
          ...(data.args.journalizedTransferIds !== undefined ? { journalized_transfer_ids: data.args.journalizedTransferIds } : {}),
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
