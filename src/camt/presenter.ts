import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { canonicalRefNumber } from "../ref-number.js";
import { createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import { createPublicOperationResultDetail, type PublicOperationResultDetail } from "../operation-result-store.js";
import type { PlanExecutionReport } from "../plan-execution.js";
import {
  buildPossibleDuplicateRecommendationNote,
  determinePossibleDuplicateAction,
} from "./duplicate-identity.js";
import type {
  CamtCreateDescriptor,
  CamtImportProjection,
  CamtParseResult,
  ImportRejectedField,
  StatementBalanceCheckResult,
} from "./types.js";

// OUTPUT layer. This is the only CAMT module that shapes MCP envelopes and
// applies the OCR/untrusted-text sandbox (wrapUntrustedOcr). The pure
// parser/identity/projection modules never sandbox — the presenter does,
// exactly as before.

const MAX_EXPOSED_ISSUES = 100;
const MAX_EXPOSED_VALUE_CHARS = 256;

/**
 * Bounded, sandboxed failure payload. The fixed `error` string is load-bearing:
 * without it toolError() falls through to serializeUnknownError(), which
 * JSON.stringifies the whole payload into one 500-char string and defeats both
 * the sandbox wrapping and the truncation below.
 */
export function importPreflightFailurePayload(
  source: "camt" | "wise",
  rejected: ImportRejectedField[],
): Record<string, unknown> {
  return {
    error: "Import preflight failed",
    category: "import_preflight_failed",
    source,
    rejected_field_count: rejected.length,
    rejected_fields_truncated: rejected.length > MAX_EXPOSED_ISSUES,
    rejected_fields: rejected.slice(0, MAX_EXPOSED_ISSUES).map(issue => ({
      source_row_id: issue.source_row_id,
      field: issue.field,
      value: wrapUntrustedOcr(issue.value.slice(0, MAX_EXPOSED_VALUE_CHARS)),
      reason: issue.reason,
    })),
    mutation_occurred: false,
  };
}

export function camtResultRow(
  descriptor: CamtCreateDescriptor,
  status: "would_create" | "created",
  apiId?: number,
) {
  return {
    status,
    date: descriptor.entry.date,
    amount: descriptor.entry.amount,
    currency: descriptor.entry.currency,
    type: (descriptor.entry.direction === "CRDT" ? "D" : "C") as "C" | "D",
    source_direction: descriptor.entry.direction,
    description: descriptor.entry.description,
    counterparty: descriptor.entry.counterparty_name,
    bank_reference: descriptor.entry.bank_reference,
    ref_number: canonicalRefNumber(descriptor.entry.reference_number).value,
    clients_id: descriptor.clientResolution.clients_id,
    client_match: descriptor.clientResolution.match_type,
    ...(apiId !== undefined ? { api_id: apiId } : {}),
    ...(descriptor.storedDescription !== descriptor.entry.description
      ? { stored_description: descriptor.storedDescription }
      : {}),
  };
}

export function camtPossibleDuplicateRow(descriptor: CamtCreateDescriptor, newApiId?: number) {
  const recommendedDefaultAction = determinePossibleDuplicateAction(descriptor.possibleDuplicateMatches);
  return {
    date: descriptor.entry.date,
    amount: descriptor.entry.amount,
    currency: descriptor.entry.currency,
    type: (descriptor.entry.direction === "CRDT" ? "D" : "C") as "C" | "D",
    source_direction: descriptor.entry.direction,
    counterparty: descriptor.entry.counterparty_name,
    bank_reference: descriptor.entry.bank_reference,
    ref_number: canonicalRefNumber(descriptor.entry.reference_number).value,
    ...(newApiId !== undefined ? { new_transaction_api_id: newApiId } : {}),
    existing_transactions: descriptor.possibleDuplicateMatches,
    recommended_default_action: recommendedDefaultAction,
    recommendation_note: buildPossibleDuplicateRecommendationNote(recommendedDefaultAction),
  };
}

export interface CamtImportRenderInput {
  mode: "DRY_RUN" | "EXECUTED";
  projection: CamtImportProjection;
  results: ReturnType<typeof camtResultRow>[];
  possibleDuplicates: ReturnType<typeof camtPossibleDuplicateRow>[];
  createdCount: number;
  errorCount: number;
  workflowArgs: Record<string, unknown>;
  executionReport?: PlanExecutionReport;
  planHandle?: string;
  statementBalanceCheck?: StatementBalanceCheckResult;
}

/** Data the operation layer produces for the presenter to render. */
export type CamtImportRenderData = Omit<CamtImportRenderInput, "mode">;
export type CamtImportPreview = CamtImportRenderData;
export type CamtImportExecution = CamtImportRenderData;

export function renderCamtImportPayload(input: CamtImportRenderInput): Record<string, unknown> {
  const { projection, mode } = input;
  const dryRun = mode === "DRY_RUN";
  const summary = {
    total_statement_entries: projection.totalStatementEntries,
    eligible_entries: projection.eligibleEntries,
    filtered_out: projection.filteredOut,
    created_count: input.createdCount,
    skipped_count: projection.skipped.length,
    error_count: input.errorCount,
    possible_duplicate_count: input.possibleDuplicates.length,
  };

  const sanitizedStatementMetadata = {
    ...projection.statementMetadata,
    statement_id: wrapUntrustedOcr(projection.statementMetadata.statement_id),
    bank_name: wrapUntrustedOcr(projection.statementMetadata.bank_name),
  };
  const sanitizedResults = input.results.map(row => ({
    ...row,
    description: wrapUntrustedOcr(row.description),
    stored_description: wrapUntrustedOcr(row.stored_description),
    counterparty: wrapUntrustedOcr(row.counterparty),
  }));
  const sanitizedPossibleDuplicates = input.possibleDuplicates.map(duplicate => ({
    ...duplicate,
    counterparty: wrapUntrustedOcr(duplicate.counterparty),
    existing_transactions: duplicate.existing_transactions.map(match => ({
      ...match,
      counterparty: wrapUntrustedOcr(match.counterparty ?? undefined),
      description: wrapUntrustedOcr(match.description ?? undefined),
      suggested_patch_missing_fields: {
        ...match.suggested_patch_missing_fields,
        ...(match.suggested_patch_missing_fields?.bank_account_name
          ? { bank_account_name: wrapUntrustedOcr(match.suggested_patch_missing_fields.bank_account_name) }
          : {}),
        ...(match.suggested_patch_missing_fields?.description
          ? { description: wrapUntrustedOcr(match.suggested_patch_missing_fields.description) }
          : {}),
      },
    })),
  }));

  const workflowSummary = dryRun
    ? `CAMT dry run would create ${summary.created_count} bank transaction(s), skip ${summary.skipped_count}, flag ${summary.possible_duplicate_count} possible duplicate(s), and report ${summary.error_count} error(s).`
    : `CAMT import created ${summary.created_count} bank transaction(s), skipped ${summary.skipped_count}, flagged ${summary.possible_duplicate_count} possible duplicate(s), and reported ${summary.error_count} error(s).`;
  const workflow = buildWorkflowEnvelope({
    summary: workflowSummary,
    needs_review: sanitizedPossibleDuplicates,
    dry_run_steps: dryRun
      ? [{
          tool: "import_camt053",
          summary: workflowSummary,
          suggested_args: input.workflowArgs,
          preview: summary,
        }]
      : [],
  });

  return {
    mode,
    summary,
    workflow,
    statement_metadata: sanitizedStatementMetadata,
    total_statement_entries: summary.total_statement_entries,
    eligible_entries: summary.eligible_entries,
    filtered_out: summary.filtered_out,
    created_count: summary.created_count,
    skipped_count: summary.skipped_count,
    error_count: summary.error_count,
    sample: sanitizedResults.slice(0, 10),
    execution: buildBatchExecutionContract({
      mode,
      summary,
      results: sanitizedResults,
      skipped: projection.skipped,
      errors: [],
      needs_review: sanitizedPossibleDuplicates,
      ...(input.executionReport !== undefined ? { execution_report: input.executionReport } : {}),
    }),
    ...(projection.skipped.length > 0 && {
      skipped_summary: {
        count: projection.skipped.length,
        sample_refs: projection.skipped.slice(0, 10).map(row => row.bank_reference),
      },
    }),
    ...(input.possibleDuplicates.length > 0 && {
      possible_duplicate_summary: {
        count: input.possibleDuplicates.length,
        sample_existing_transaction_ids: input.possibleDuplicates
          .slice(0, 10)
          .flatMap(item => item.existing_transactions.map(match => match.id))
          .slice(0, 10),
        default_policy: "link_confirmed_transaction_else_review_status",
      },
    }),
    ...(input.planHandle !== undefined ? { plan_handle: input.planHandle } : {}),
    ...(input.statementBalanceCheck !== undefined ? {
      statement_balance_check: (() => {
        const sbc = input.statementBalanceCheck;
        const combinedNotes = [...(sbc.check?.notes ?? []), ...sbc.notes];
        return {
          ...(sbc.check ?? {}),
          persisted: sbc.persisted,
          ...(combinedNotes.length > 0 ? { notes: combinedNotes } : {}),
        };
      })(),
    } : {}),
  };
}

// --- COMPACT presenter (guided / guided-sales) -------------------------------
//
// Size is approximately CONSTANT regardless of row count: counts/totals are
// scalars, at most THREE samples are inlined, and the full per-row detail is
// referenced via get_operation_result_page (execute) or the plan_handle
// (dry_run). Blockers are never hidden. Untrusted free-form text
// (counterparty) is OCR-sandbox-wrapped here, at the output layer.

/**
 * Safe, scalar-only per-row details for the operation-result store. The full
 * free-form fields (counterparty/description) are intentionally omitted — the
 * store forbids/does not sandbox them; the compact samples carry the wrapped
 * counterparty instead.
 */
export function buildCamtResultDetailItems(data: CamtImportRenderData): PublicOperationResultDetail[] {
  return data.results.map((row, index) => createPublicOperationResultDetail({
    i: index,
    status: row.status,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    ...(typeof row.api_id === "number" ? { id: row.api_id } : {}),
  }));
}

export interface CamtCompactInput {
  readonly mode: "DRY_RUN" | "EXECUTED";
  readonly data: CamtImportRenderData;
  /** Execute only: an operation-result handle bound to the consumed CAMT plan. */
  readonly operationHandle?: string;
}

export function renderCamtImportCompact(input: CamtCompactInput): { summary: OperationSummaryV1 } {
  const { mode, data } = input;
  const dryRun = mode === "DRY_RUN";
  const meta = data.projection.statementMetadata;

  const possibleDuplicateCount = data.possibleDuplicates.length;
  const counts = {
    total_statement_entries: data.projection.totalStatementEntries,
    eligible_entries: data.projection.eligibleEntries,
    filtered_out: data.projection.filteredOut,
    [dryRun ? "would_create" : "created"]: data.createdCount,
    skipped: data.projection.skipped.length,
    possible_duplicates: possibleDuplicateCount,
    errors: data.errorCount,
  };
  const totals = {
    credit_total: data.projection.parsed.summary.credit_total,
    debit_total: data.projection.parsed.summary.debit_total,
  };

  const warnings: CompactWarning[] = (data.statementBalanceCheck?.check?.warnings ?? [])
    .map(message => ({ code: "closing_balance", message }));

  // Errors (indeterminate / failed commands) surface as blockers — never hidden.
  const blockers: CompactReviewItem[] = [];
  if (!dryRun && data.errorCount > 0) {
    const stop = data.executionReport?.stop_reason as { command_id?: unknown; category?: unknown } | undefined;
    blockers.push({
      item_id: typeof stop?.command_id === "string" ? stop.command_id : "camt-import",
      code: typeof stop?.category === "string" ? stop.category : "import_incomplete",
      message: `${data.errorCount} CAMT row(s) were not created. Re-preview before retrying; a prior plan is not approval.`,
      severity: "blocker",
    });
  }

  const samples = data.results.slice(0, 3).map((row, index) => ({
    i: index,
    status: row.status,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    type: row.type,
    // Display-only in the compact surface; identity/dedup operate on the raw
    // entry.bank_reference upstream, so wrapping here is safe. (The full
    // envelope keeps bank_reference raw, unchanged, for byte-compatibility.)
    ...(row.bank_reference !== undefined ? { bank_reference: wrapUntrustedOcr(row.bank_reference) } : {}),
    ...(row.counterparty !== undefined ? { counterparty: wrapUntrustedOcr(row.counterparty) } : {}),
  }));

  const message = dryRun
    ? `CAMT dry run would create ${data.createdCount} bank transaction(s), skip ${data.projection.skipped.length}, flag ${possibleDuplicateCount} possible duplicate(s), and report ${data.errorCount} error(s).`
    : `CAMT import created ${data.createdCount} bank transaction(s), skipped ${data.projection.skipped.length}, flagged ${possibleDuplicateCount} possible duplicate(s), and reported ${data.errorCount} error(s).`;

  const status = dryRun
    ? "ready_for_approval" as const
    : (data.errorCount > 0 ? "partial" as const : "completed" as const);

  // Statement identity: IBAN identifies the account (validated at the
  // statement-binding gate, safe raw); statement_id identifies the statement and
  // is attacker-controllable XML text, so it is OCR-sandbox-wrapped. bank_name
  // is a display label, not identity, and is deliberately kept off the lean
  // compact surface (the full envelope still carries it wrapped).
  const wrappedStatementId = wrapUntrustedOcr(meta.statement_id);
  const scope = {
    account: meta.iban,
    ...(wrappedStatementId !== undefined ? { statement_id: wrappedStatementId } : {}),
    ...(meta.period.from !== undefined || meta.period.to !== undefined
      ? { period: { ...(meta.period.from !== undefined ? { from: meta.period.from } : {}), ...(meta.period.to !== undefined ? { to: meta.period.to } : {}) } }
      : {}),
  } as OperationSummaryV1["scope"];

  const details = !dryRun && input.operationHandle !== undefined
    ? {
        available: data.results.length > samples.length,
        total_items: data.results.length,
        returned_items: samples.length,
        tool: "get_operation_result_page",
        args: { operation_handle: input.operationHandle },
      }
    : undefined;

  const summary = createOperationSummary({
    status,
    message,
    counts,
    totals,
    scope,
    warnings,
    blockers,
    samples,
    ...(dryRun && data.planHandle !== undefined ? { plan_handle: data.planHandle } : {}),
    ...(details ? { details } : {}),
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary };
}

/**
 * The parse_camt053 output projection: statement metadata + entries with the
 * attacker-controllable free-form fields OCR-sandbox-wrapped at MCP output.
 */
export function renderCamtParsePayload(parsed: CamtParseResult): Record<string, unknown> {
  return {
    ...parsed,
    // statement_id and bank_name originate from the uploaded XML and
    // are attacker-controllable at the same layer as the entries.
    statement_metadata: {
      ...parsed.statement_metadata,
      statement_id: wrapUntrustedOcr(parsed.statement_metadata.statement_id),
      bank_name: wrapUntrustedOcr(parsed.statement_metadata.bank_name),
    },
    entries: parsed.entries.map(entry => ({
      ...entry,
      // CAMT free-form fields (RmtInf/Ustrd, Dbtr/Nm, Cdtr/Nm) carry
      // attacker-controllable bytes from a bank statement sent by
      // any counterparty. Treat them like OCR text at MCP output.
      counterparty_name: wrapUntrustedOcr(entry.counterparty_name),
      description: wrapUntrustedOcr(entry.description),
      ...(entry.duplicate ? { duplicate: true } : { duplicate: undefined }),
      ...(entry.duplicate_transaction_ids.length > 0 ? { duplicate_transaction_ids: entry.duplicate_transaction_ids } : { duplicate_transaction_ids: undefined }),
    })),
  };
}
