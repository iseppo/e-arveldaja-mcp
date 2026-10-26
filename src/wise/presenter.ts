import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { buildBatchExecutionContract, type BatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope, type WorkflowEnvelope } from "../workflow-response.js";
import { toolError } from "../tool-error.js";
import { roundMoney } from "../money.js";
import { cappedWarnings, compactImportStatus, createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import {
  createPublicOperationResultDetail,
  type OperationResultStatus,
  type OperationResultStore,
  type PublicOperationResultDetail,
} from "../operation-result-store.js";
import { importPreflightFailurePayload, type ImportPreflightFailurePayload } from "../camt/presenter.js";
import type { PlanStoreError } from "../plan-store.js";
import { echoableSourcePath, type FileInputSource, type FileInputIdentity } from "../file-input-snapshot.js";
import {
  bookedCurrencyForWiseRow,
  counterpartyNameForWiseRow,
  summarizeWiseSkippedEntries,
  type WiseSkippedGroup,
} from "./preflight.js";
import { projectWiseCommand, SHA256_HEX, WISE_PLAN_DOMAIN, type WiseProjectedCommand } from "./projection.js";
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
  WiseAcknowledgedJournalHold,
  WiseCounterpartOverride,
  WiseJournalizedTransferMapping,
  WiseTransferReview,
} from "./types.js";

// --- Wire payload types ------------------------------------------------------
//
// The envelopes as a consumer decodes them (toMcpJson drops undefined fields,
// so conditionally spread / possibly-undefined fields are optional). Tests
// parse tool payloads as these types (parseToolPayload<T>).

/** A non-preflight failure envelope (plan gate, digest, ownership, store, drift, setup). */
export type WiseFailurePayload = {
  error: string;
  category?: string;
  code?: string;
  retry: "never";
  mutation_occurred: false;
  known_object_ids?: number[];
  affected_cache_names?: string[];
  next_action?: string;
};

/** The preflight-rejection envelope, shared with CAMT. */
export type WisePreflightFailurePayload = ImportPreflightFailurePayload;

export type WiseImportSummary = {
  total_csv_rows: number;
  eligible: number;
  filtered_out: number;
  skipped_jar_transfers: number;
  created: number;
  skipped: number;
  error_count: number;
  inter_account_total: number;
  needs_review: number;
};

/** A created / would-create row (description and source row stay internal). */
export type WiseImportResultRow = Omit<WiseCreatedEntry, "description" | "source_row">;

/** A skipped / errored row with its reason sandbox-wrapped (kind and record_id stay internal). */
export type WiseImportSkippedRow = Omit<WiseSkippedEntry, "kind" | "record_id">;

export type WiseInvoiceCurrencyFixes = {
  total: number;
  foreign_currency_lock: number;
  eur_legacy_autofix: number;
  advisory_only: true;
  candidates: Array<Omit<WiseInvoiceFixCandidate, "row_index" | "current_object_state">>;
};

export type WiseAlreadyJournalizedRow = Pick<
  WiseAlreadyJournalizedAssertion,
  "wise_id" | "existing_journal_id" | "date" | "booked_amount" | "booked_currency" | "source_direction"
>;

export type WiseImportExecutionContract =
  BatchExecutionContract<WiseImportResultRow, WiseImportSkippedRow, WiseImportSkippedRow, WiseTransferReview> & {
    commands: WiseProjectedCommand[];
    skipped_displayed?: number;
    skipped_omitted_already_booked?: number;
    skipped_omitted_note?: string;
    already_journalized_count?: number;
    already_journalized_auto_matched_count?: number;
    already_journalized_rows?: WiseAlreadyJournalizedRow[];
    already_journalized_note?: string;
  };

/** The full (standard/full profile) import_wise_transactions envelope, dry run and execute. */
export type WiseImportFullPayload = {
  mode: "DRY_RUN" | "EXECUTED";
  source_file_ref?: string;
  source_file?: string;
  source_identity?: FileInputIdentity;
  source_resubmission_required?: true;
  summary: WiseImportSummary;
  workflow: WorkflowEnvelope;
  total_csv_rows: number;
  eligible: number;
  filtered_out: number;
  skipped_jar_transfers?: number;
  skipped_jar_transfer_details?: WiseSkippedJarRow[];
  created: number;
  skipped: number;
  approved_command_digest?: string;
  plan_handle?: string;
  command_version: typeof WISE_COMMAND_VERSION;
  command_count: number;
  inter_account_auto_detected_dimension_id?: number;
  inter_account_reconciliation?: {
    total: number;
    already_journalized: number;
    confirmed: number;
    details: WiseInterAccountResult[];
  };
  transfer_counterpart_unresolved?: {
    message: string;
    unresolved_row_count: number;
    conflict_row_count: number;
    candidates: Array<{ accounts_dimensions_id: number; label: string }>;
  };
  acknowledged_holds?: WiseAcknowledgedJournalHold[];
  ownership_reviews?: WiseTransferReview[];
  invoice_currency_fixes?: WiseInvoiceCurrencyFixes;
  results: WiseImportResultRow[];
  skipped_details: WiseSkippedGroup[];
  execution: WiseImportExecutionContract;
};

/** The compact (guided-profile) envelope. */
export type WiseImportCompactPayload = { summary: OperationSummaryV1 };

// OUTPUT layer. The only Wise module that shapes MCP envelopes and applies the
// OCR/untrusted-text sandbox (wrapUntrustedOcr). The pure preflight/projection
// modules never sandbox — the presenter does, exactly as before. Policy:
// validated identifiers (Wise IDs match WISE_ID_REGEX at preflight; FEE:/leg
// forms only add server-built affixes) are emitted raw; free-form text
// (counterparty, description, reference, reasons) is wrapped. Standard/full
// keep the byte-identical full envelope; guided/guided-sales adopt the compact
// presenter (added in Phase B).

// --- Failure envelopes -------------------------------------------------------

/** The bounded, sandboxed preflight-failure payload shared with CAMT. */
export function wisePreflightFailure(rejected: ImportRejectedField[]) {
  return toolError(importPreflightFailurePayload("wise", rejected));
}

type SimpleWiseFailureKind = Exclude<WiseFailure["kind"], "preflight" | "plan_store_error" | "plan_drift">;

/** The fixed non-mutating envelope payload of each data-less failure kind. */
const SIMPLE_WISE_FAILURES: Readonly<Record<SimpleWiseFailureKind, WiseFailurePayload>> = {
  digest_mismatch: {
    error: "The Wise command approval digest does not match the current mutation plan.",
    category: "digest_mismatch",
    code: "approval_digest_mismatch",
    retry: "never",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
    next_action: "Run a new Wise dry run, review its complete command plan, and approve that exact digest.",
  },
  // A required-but-missing plan handle blocks execute before any work.
  plan_handle_required: {
    error: "A reviewed execution-plan handle from the Wise dry run is required to execute. The digest alone cannot execute; re-run the dry run and pass its plan_handle.",
    category: "plan_handle_required",
    code: "plan_handle_required",
    retry: "never",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  },
  // The operator's ownership approvals must equal the previewed unverified
  // transfer IDs exactly, in the presented order (extra/missing/reordered all
  // invalidate). This is a distinct, clearer signal than a digest mismatch.
  ownership_reapproval_required: {
    error: "Wise ownership approvals must match the previewed unverified transfer IDs exactly, in the order presented. Extra, missing, or reordered approvals invalidate the plan — re-run the dry run, approve the enumerated IDs only, and use the new plan handle and digest.",
    category: "wise_transfer_ownership_reapproval_required",
    code: "wise_transfer_ownership_reapproval_required",
    retry: "never",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  },
  wise_client_not_found: {
    error: "Wise client not found — create a client named 'Wise' (or 'TransferWise') before importing with fee rows, otherwise every fee transaction is left unconfirmed and must be cleaned up manually.",
    retry: "never",
    mutation_occurred: false,
  },
  // The Wise accounts_dimensions_id is not the dimension of a configured bank
  // account (unlinked, deleted or duplicated): refused before any write, on dry
  // run and execute alike. The id is not echoed (simple kind).
  wise_dimension_not_bank_account: {
    error: "The Wise accounts_dimensions_id is not the dimension of a bank account in e-arveldaja. Nothing was created. Link the Wise account as a bank account in e-arveldaja (bank account → account dimension), or pass the accounts_dimensions_id of the Wise bank account.",
    category: "wise_dimension_not_bank_account",
    code: "wise_dimension_not_bank_account",
    retry: "never",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  },
};

export function digestMismatch() {
  return toolError(SIMPLE_WISE_FAILURES.digest_mismatch);
}

/** A PlanStoreError (invalid/consumed/expired/domain/scope) surfaced as a
 * structured, non-mutating tool error carrying the exact store code. */
function planStoreErrorResult(error: Pick<PlanStoreError, "code" | "message">) {
  return toolError({
    error: error.message,
    category: error.code,
    code: error.code,
    retry: "never",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
  } satisfies WiseFailurePayload);
}


/** Any source/argument/live/command drift between the reviewed plan and the
 * re-derived plan stops execution with zero mutations. */
function planDriftResult(detail: string) {
  return toolError({
    error: `The reviewed Wise plan no longer matches the re-read source and current ledger: ${detail}`,
    category: "plan_drift",
    code: "plan_drift",
    retry: "never",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
    next_action: "Run a new Wise dry run, review the fresh plan, and execute with its new plan handle and digest.",
  } satisfies WiseFailurePayload);
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
  if (Object.hasOwn(SIMPLE_WISE_FAILURES, code)) return { kind: code as SimpleWiseFailureKind };
  throw new Error(`Unexpected Wise operation error code: ${code}`);
}

/** Map a structured executor failure to the exact non-mutating MCP envelope it
 * produced before the refactor. Byte-identical to the inline handler returns. */
export function renderWiseFailure(failure: WiseFailure) {
  switch (failure.kind) {
    case "preflight": return wisePreflightFailure(failure.rejected);
    case "plan_store_error": return planStoreErrorResult({ code: failure.code, message: failure.message } as Pick<PlanStoreError, "code" | "message">);
    case "plan_drift": return planDriftResult(failure.detail);
    default: return toolError(SIMPLE_WISE_FAILURES[failure.kind]);
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
  /** Rows released by acknowledged_journal_holds (info only, not a review). */
  acknowledgedHolds?: WiseAcknowledgedJournalHold[];
  /** Set when some transfer rows are held because their counterpart bank
   * account could not be determined (unresolved) or own-account evidence
   * contradicts the selected one (conflict). Info only: the other rows still
   * form the plan. Candidates are the other configured bank accounts, listed
   * neutrally; labels are raw upstream text. */
  transferCounterpart?: {
    unresolved_row_count: number;
    conflict_row_count: number;
    candidates: Array<{ accounts_dimensions_id: number; label: string }>;
  };
  args: {
    feeAccountDimensionsId: number | undefined;
    feeAccountRelationId: number | undefined;
    interAccountDimensionId: number | undefined;
    confirmOwnTransferIds: string[] | undefined;
    journalizedTransferIds?: readonly WiseJournalizedTransferMapping[];
    acknowledgedJournalHolds?: readonly WiseAcknowledgedJournalHold[];
    counterpartOverrides?: readonly WiseCounterpartOverride[];
    dateFrom: string | undefined;
    dateTo: string | undefined;
    skipJarTransfers: boolean | undefined;
  };
}

export type WiseImportPreview = WiseImportRenderData;
export type WiseImportExecution = WiseImportRenderData;

/** Operator-facing text for transfer rows held for their counterpart.
 * Candidate labels are upstream bank-account names, so they are sandbox-wrapped here. */
function wiseTransferCounterpartMessage(info: NonNullable<WiseImportRenderData["transferCounterpart"]>): string {
  const candidates = info.candidates
    .map(candidate => `${wrapUntrustedOcr(candidate.label) ?? candidate.label} (${candidate.accounts_dimensions_id})`)
    .join(", ");
  const parts = [
    info.unresolved_row_count > 0 ? `${info.unresolved_row_count} Wise transfer row(s) have no determinable counterpart bank account` : undefined,
    info.conflict_row_count > 0 ? `${info.conflict_row_count} Wise transfer row(s) have own-account evidence that contradicts the selected counterpart` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${parts.join("; ")}. Those rows are held (not imported); the other rows are unaffected. Own bank account(s): ${candidates}. Pass inter_account_dimension_id, or import the other bank's statement first if it is not imported yet, then re-run the preview. For a row whose evidence points to several bank accounts, pass counterpart_overrides [{ wise_id, dimension_id }] with the one the owner confirms.`;
}

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
    transferCounterpart,
  } = data;
  const file_ref = source.file_ref;
  const file_path = echoableSourcePath(source);
  const { feeAccountDimensionsId: fee_account_dimensions_id, feeAccountRelationId: fee_account_relation_id, interAccountDimensionId: inter_account_dimension_id, confirmOwnTransferIds: confirm_own_transfer_ids, dateFrom: date_from, dateTo: date_to, skipJarTransfers: skip_jar_transfers } = data.args;

  const executionSkipped = skipped.filter(entry => entry.kind !== "error");
  const executionErrors = skipped.filter(entry => entry.kind === "error");
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
  const invoiceCurrencyFixes: WiseInvoiceCurrencyFixes | undefined = invoiceFixCandidates.length > 0
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
  // kind / record_id are internal classification, not part of the envelope.
  const sanitizeReason = ({ kind: _kind, record_id: _recordId, ...entry }: WiseSkippedEntry) => ({
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
    ? executionSkipped.filter(entry => entry.kind !== "already_imported" && entry.kind !== "already_journalized")
    : executionSkipped;
  const sanitizedExecutionSkipped = displayedExecutionSkipped.map(sanitizeReason);
  // Dry run: transfers an existing journal already books are not commands;
  // they are listed as a compact table.
  const alreadyJournalizedRows = dryRun ? alreadyJournalized : [];
  // Of those, the legacy rows matched automatically (also in skipped_details
  // with an auto_match); the guided surface counts them as auto_matched.
  const autoMatchedIds = new Set(skipped.filter(entry => entry.auto_match !== undefined).map(entry => entry.wise_id));
  const sanitizedExecutionErrors = executionErrors.map(sanitizeReason);
  const workflowArgs = {
    ...(file_ref !== undefined ? { file_ref } : {}),
    ...(file_ref === undefined && file_path !== undefined ? { file_path } : {}),
    accounts_dimensions_id,
    ...(fee_account_dimensions_id !== undefined ? { fee_account_dimensions_id } : {}),
    ...(fee_account_relation_id !== undefined ? { fee_account_relation_id } : {}),
    ...(inter_account_dimension_id !== undefined ? { inter_account_dimension_id } : {}),
    ...(confirm_own_transfer_ids !== undefined ? { confirm_own_transfer_ids } : {}),
    ...(data.args.journalizedTransferIds !== undefined ? { journalized_transfer_ids: data.args.journalizedTransferIds } : {}),
    ...(data.args.acknowledgedJournalHolds !== undefined ? { acknowledged_journal_holds: data.args.acknowledgedJournalHolds } : {}),
    ...(data.args.counterpartOverrides !== undefined ? { counterpart_overrides: data.args.counterpartOverrides } : {}),
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
          : file_path !== undefined
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
        ...(transferCounterpart ? {
          transfer_counterpart_unresolved: {
            message: wiseTransferCounterpartMessage(transferCounterpart),
            unresolved_row_count: transferCounterpart.unresolved_row_count,
            conflict_row_count: transferCounterpart.conflict_row_count,
            candidates: transferCounterpart.candidates.map(candidate => ({
              accounts_dimensions_id: candidate.accounts_dimensions_id,
              label: wrapUntrustedOcr(candidate.label) ?? candidate.label,
            })),
          },
        } : {}),
        ...(data.acknowledgedHolds !== undefined ? { acknowledged_holds: data.acknowledgedHolds } : {}),
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
            already_journalized_auto_matched_count: alreadyJournalizedRows.filter(assertion => autoMatchedIds.has(assertion.wise_id)).length,
            already_journalized_rows: alreadyJournalizedRows.map(assertion => ({
              wise_id: assertion.wise_id,
              existing_journal_id: assertion.existing_journal_id,
              date: assertion.date,
              booked_amount: assertion.booked_amount,
              booked_currency: assertion.booked_currency,
              source_direction: assertion.source_direction,
            })),
            already_journalized_note: "Not part of the approved commands: no writes. Execute re-checks each journal once, after all writes, and reports a changed journal as an error. already_journalized_auto_matched_count of these rows are legacy transfers matched automatically (see skipped_details auto_match).",
          } : {}),
        },
      } satisfies WiseImportFullPayload),
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
  return entry.auto_match === undefined && entry.kind === "already_imported";
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
function buildWiseResultDetailItems(data: WiseImportRenderData): PublicOperationResultDetail[] {
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
    const errorCount = data.skipped.filter(entry => entry.kind === "error").length;
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

interface WiseCompactInput {
  readonly data: WiseImportRenderData;
  /** Execute only: an operation-result handle bound to the consumed Wise plan. */
  readonly operationHandle?: string;
}

export function renderWiseImportCompact(input: WiseCompactInput): WiseImportCompactPayload {
  const { data } = input;
  const dryRun = data.mode === "DRY_RUN";
  // A dry run with no commands has nothing to approve and issues no plan.
  const zeroWrite = dryRun && data.commands.length === 0;

  const executionSkipped = data.skipped.filter(entry => entry.kind !== "error");
  const executionErrors = data.skipped.filter(entry => entry.kind === "error");
  const duplicateCount = data.skipped.filter(isDuplicateSkip).length;
  const autoMatched = data.skipped.filter((entry): entry is WiseSkippedEntry & { auto_match: NonNullable<WiseSkippedEntry["auto_match"]> } =>
    entry.auto_match !== undefined);

  // Counts are disjoint: a legacy auto-matched row is also an already-journalized
  // assertion, but is counted only under auto_matched, so
  // skipped = duplicates + auto_matched + already_journalized + other.
  const autoMatchedIds = new Set(autoMatched.map(entry => entry.wise_id));

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
    // Preview: the planned inter-account confirmations (results exist only
    // after execute). Execute: the inter-account results.
    inter_account: dryRun
      ? data.commands.filter(command => command.action === "inter_account").length
      : data.interAccountResults.length,
    // Preview: the rows the plan asserts as already booked. Execute: only the
    // ones whose journal the post-write re-check verified.
    already_journalized: dryRun
      ? data.alreadyJournalized.filter(assertion => !autoMatchedIds.has(assertion.wise_id)).length
      : data.interAccountResults.filter(result => result.status === "already_journalized" && !autoMatchedIds.has(result.wise_id)).length,
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
  // never dropped from the lean surface. Rows held for their counterpart
  // collapse into ONE warning (not a blocker): the other rows proceed.
  const counterpartInfo = data.transferCounterpart;
  const warnings: CompactWarning[] = data.ownershipReviews
    .filter(review => counterpartInfo === undefined || review.counterpart_candidate_dimension_ids === undefined)
    .map(review => ({
    item_id: review.wise_id,
    code: review.code,
    // The compact surface carries only the message: name the journals an
    // acknowledgement must list, and any a short one left out.
    message: review.required_acknowledgement_ids === undefined
      ? review.reason
      : `${review.reason} required_acknowledgement_ids: ${review.required_acknowledgement_ids.join(", ")}.${review.unacknowledged_journal_ids !== undefined
        ? ` Not acknowledged: ${review.unacknowledged_journal_ids.join(", ")}.`
        : ""}`,
  }));
  // Rows released by an acknowledgement: info, so the owner sees what the
  // acknowledgement did (not a review; approval is not blocked).
  for (const hold of data.acknowledgedHolds ?? []) {
    warnings.push({
      item_id: hold.wise_id,
      code: "wise_acknowledged_hold_released",
      message: `Released by acknowledged_journal_holds: journal(s) ${hold.journal_ids.join(", ")} acknowledged as not booking this transfer; the row is imported and confirmed normally, and execute re-checks those journals.`,
    });
  }
  if (counterpartInfo !== undefined) {
    warnings.unshift({
      item_id: "wise-import",
      code: "wise_transfer_counterpart_unresolved",
      message: `${wiseTransferCounterpartMessage(counterpartInfo)} Use process_bank_input mode='prepare' with inter_account_dimension_id.`,
    });
  }
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

  const journalizedSkips = data.skipped.filter(entry => entry.kind === "already_journalized").length;
  const importedSkips = data.skipped.filter(entry => entry.kind === "already_imported").length;
  const baseMessage = zeroWrite
    ? `Nothing to approve: the Wise dry run found no rows to write (${journalizedSkips + importedSkips} already booked: ${journalizedSkips} already journalized, ${importedSkips} already imported); no plan handle was issued.`
    : dryRun
      ? `Wise dry run would create ${data.created.length} bank transaction(s), skip ${executionSkipped.length}, and report ${executionErrors.length} error(s).`
      : `Wise import created ${data.created.length} bank transaction(s), skipped ${executionSkipped.length}, and reported ${executionErrors.length} error(s).`;

  // Dry-run ladder: open reviews (including held rows) mirror the standard
  // surface's canApprove (reviews block approval) while the plan handle and
  // next_action stay available, as the standard digest/handle do.
  const status = compactImportStatus({
    dryRun,
    zeroWrite,
    reviews: data.ownershipReviews.length > 0,
    reviewsBlockApproval: true,
    failed: executionErrors.length > 0,
  });

  // Statement identity: the Wise bank dimension identifies the account; the
  // source-file identity (opaque file_ref, otherwise the content digest, and an
  // OCR-wrapped file_path) identifies the statement. A raw base64 upload is
  // represented by its digest only.
  const echoPath = echoableSourcePath(data.source);
  const fileId = data.source.file_ref !== undefined
    ? data.source.file_ref
    : echoPath !== undefined
      ? wrapUntrustedOcr(echoPath)
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
  const sourceResubmissionRequired = data.source.file_ref === undefined && echoPath === undefined;
  const nextAction = dryRun && data.planHandle !== undefined && data.approvedCommandDigest !== undefined
    ? {
        tool: "process_bank_input",
        args: {
          mode: "execute",
          ...(data.source.file_ref !== undefined
            ? { file_ref: data.source.file_ref }
            : echoPath !== undefined
              ? { file_path: echoPath }
              : {}),
          accounts_dimensions_id: data.accountsDimensionsId,
          ...(data.args.dateFrom ? { date_from: data.args.dateFrom } : {}),
          ...(data.args.dateTo ? { date_to: data.args.dateTo } : {}),
          ...(data.args.feeAccountDimensionsId !== undefined ? { fee_account_dimensions_id: data.args.feeAccountDimensionsId } : {}),
          ...(data.args.interAccountDimensionId !== undefined ? { inter_account_dimension_id: data.args.interAccountDimensionId } : {}),
          ...(data.args.confirmOwnTransferIds !== undefined ? { confirm_own_transfer_ids: data.args.confirmOwnTransferIds } : {}),
          ...(data.args.journalizedTransferIds !== undefined ? { journalized_transfer_ids: data.args.journalizedTransferIds } : {}),
          ...(data.args.acknowledgedJournalHolds !== undefined ? { acknowledged_journal_holds: data.args.acknowledgedJournalHolds } : {}),
          ...(data.args.counterpartOverrides !== undefined ? { counterpart_overrides: data.args.counterpartOverrides } : {}),
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
