import { wrapUntrustedOcr } from "../mcp-json.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { canonicalRefNumber } from "../ref-number.js";
import { cappedWarnings, compactImportStatus, createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import {
  createPublicOperationResultDetail,
  type OperationResultStatus,
  type OperationResultStore,
  type PublicOperationResultDetail,
} from "../operation-result-store.js";
import { CAMT_PLAN_DOMAIN } from "../tools/camt-plan.js";
import type { PlanExecutionReport } from "../plan-execution.js";
import {
  buildPossibleDuplicateRecommendationNote,
  camtMovementIdentity,
  determinePossibleDuplicateAction,
} from "./duplicate-identity.js";
import type {
  CamtCreateDescriptor,
  CamtImportProjection,
  CamtParseResult,
  ImportRejectedField,
  StatementBalanceCheckResult,
} from "./types.js";
import {
  CAMT_HOLD_SKIP_CODES,
  CAMT_LOSSY_IDENTITY_AMBIGUOUS,
  CAMT_MARKER_CONFLICT_REVIEW,
  CAMT_MARKER_IDENTITY_UNFIT,
  isCamtJournalReviewRow,
} from "./projection.js";

// OUTPUT layer. This is the only CAMT module that shapes MCP envelopes and
// applies the OCR/untrusted-text sandbox (wrapUntrustedOcr). The pure
// parser/identity/projection modules never sandbox — the presenter does,
// exactly as before.

const MAX_EXPOSED_ISSUES = 100;
const MAX_EXPOSED_VALUE_CHARS = 256;

export function journalReviewClause(count: number): string {
  return count > 0 ? ` (${count} of them left unimported for existing-journal review)` : "";
}

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
    retry: "never",
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
    ...(descriptor.entry.review_note !== undefined ? { review_note: descriptor.entry.review_note } : {}),
    ...(descriptor.storedDescription !== descriptor.entry.description
      ? { stored_description: descriptor.storedDescription }
      : {}),
    ...(descriptor.description_truncated ? { description_truncated: descriptor.description_truncated } : {}),
    ...(descriptor.counterparty_iban_omitted ? { counterparty_iban_omitted: true as const } : {}),
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
    movement_identity: camtMovementIdentity(descriptor.entry),
    ...(newApiId !== undefined ? { new_transaction_api_id: newApiId } : {}),
    existing_transactions: descriptor.possibleDuplicateMatches,
    recommended_default_action: recommendedDefaultAction,
    recommendation_note: buildPossibleDuplicateRecommendationNote(recommendedDefaultAction),
  };
}

interface CamtImportRenderInput {
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
    // Skipped rows an existing journal may already book; they stay unimported.
    journal_review_count: projection.skipped.filter(isCamtJournalReviewRow).length,
    // Rows whose stored text is shorter than the statement text, and rows
    // whose marker left the (proven external) counterparty IBAN out.
    description_truncated_count: input.results.filter(row => row.description_truncated !== undefined).length,
    counterparty_iban_omitted_count: input.results.filter(row => row.counterparty_iban_omitted === true).length,
  };

  const sanitizedStatementMetadata = {
    ...projection.statementMetadata,
    statement_id: wrapUntrustedOcr(projection.statementMetadata.statement_id),
    bank_name: wrapUntrustedOcr(projection.statementMetadata.bank_name),
  };
  // bank_reference / ref_number are statement text the remitter writes, exactly
  // like description and counterparty, so they are wrapped on this surface too.
  // The compact presenter already wrapped them; the full envelope kept them raw
  // "for byte-compatibility", which is a compatibility preference, not a safety
  // property — and this is the DEFAULT profile's surface. Identity and dedup run
  // on the raw upstream entry, never on these fields. A value that round-trips
  // back through the caller must be desandboxed by the write boundary that
  // accepts it: that is the boundary's job, not an automatic property of every
  // write path — `cleanup_camt_possible_duplicate` had to be fixed to do it.
  const sanitizedResults = input.results.map(row => ({
    ...row,
    description: wrapUntrustedOcr(row.description),
    stored_description: wrapUntrustedOcr(row.stored_description),
    counterparty: wrapUntrustedOcr(row.counterparty),
    bank_reference: wrapUntrustedOcr(row.bank_reference),
    ref_number: wrapUntrustedOcr(row.ref_number),
  }));
  // No statement text: date, amount, the wrapped bank reference and lengths only.
  const descriptionTruncatedRows = input.results
    .filter(row => row.description_truncated !== undefined)
    .map(row => ({
      date: row.date,
      amount: row.amount,
      bank_reference: wrapUntrustedOcr(row.bank_reference),
      stored_length: row.description_truncated!.stored_length,
      full_length: row.description_truncated!.full_length,
    }));
  const sanitizedSkipped = projection.skipped.map(row => ({
    ...row,
    bank_reference: wrapUntrustedOcr(row.bank_reference),
  }));
  const sanitizedPossibleDuplicates = input.possibleDuplicates.map(duplicate => ({
    ...duplicate,
    counterparty: wrapUntrustedOcr(duplicate.counterparty),
    bank_reference: wrapUntrustedOcr(duplicate.bank_reference),
    ref_number: wrapUntrustedOcr(duplicate.ref_number),
    existing_transactions: duplicate.existing_transactions.map(match => ({
      ...match,
      counterparty: wrapUntrustedOcr(match.counterparty ?? undefined),
      description: wrapUntrustedOcr(match.description ?? undefined),
      ref_number: wrapUntrustedOcr(match.ref_number ?? undefined),
      // Every patch value (bank_ref_number, ref_number, bank_account_no,
      // bank_account_name, description) is copied from the statement entry.
      suggested_patch_missing_fields: Object.fromEntries(
        Object.entries(match.suggested_patch_missing_fields ?? {}).map(([key, value]) =>
          [key, typeof value === "string" && value ? wrapUntrustedOcr(value) : value]),
      ),
    })),
  }));

  // Rows not created because an existing journal may already book them.
  const journalReviews = projection.skipped
    .filter(isCamtJournalReviewRow)
    .map(row => ({
      code: "camt_journal_review",
      review_code: row.review_code,
      date: row.date,
      amount: row.amount,
      bank_reference: wrapUntrustedOcr(row.bank_reference),
      journal_ids: row.journal_ids ?? [],
      review_note: row.review_note,
    }));
  const needsReview = [...sanitizedPossibleDuplicates, ...journalReviews];

  const workflowSummary = dryRun
    ? `CAMT dry run would create ${summary.created_count} bank transaction(s), skip ${summary.skipped_count}${journalReviewClause(summary.journal_review_count)}, flag ${summary.possible_duplicate_count} possible duplicate(s), and report ${summary.error_count} error(s).`
    : `CAMT import created ${summary.created_count} bank transaction(s), skipped ${summary.skipped_count}${journalReviewClause(summary.journal_review_count)}, flagged ${summary.possible_duplicate_count} possible duplicate(s), and reported ${summary.error_count} error(s).`;
  const workflow = buildWorkflowEnvelope({
    summary: workflowSummary,
    needs_review: needsReview,
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
    ...(descriptionTruncatedRows.length > 0 ? { description_truncated_rows: descriptionTruncatedRows } : {}),
    execution: buildBatchExecutionContract({
      mode,
      summary,
      results: sanitizedResults,
      skipped: sanitizedSkipped,
      errors: [],
      needs_review: needsReview,
      ...(input.executionReport !== undefined ? { execution_report: input.executionReport } : {}),
    }),
    ...(projection.skipped.length > 0 && {
      skipped_summary: {
        count: projection.skipped.length,
        sample_refs: sanitizedSkipped.slice(0, 10).map(row => row.bank_reference),
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
function buildCamtResultDetailItems(data: CamtImportRenderData): PublicOperationResultDetail[] {
  return data.results.map((row, index) => createPublicOperationResultDetail({
    i: index,
    status: row.status,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    ...(typeof row.api_id === "number" ? { id: row.api_id } : {}),
  }));
}

/**
 * Execute-only: mint an operation-result handle bound to the just-consumed CAMT
 * plan so the compact response can reference get_operation_result_page for the
 * full per-row detail. Fail-safe — the import already mutated, so a store
 * failure degrades to a compact response without the handle.
 */
export function issueCamtResultHandle(
  store: Pick<OperationResultStore, "issue">,
  execution: CamtImportExecution,
  planHandle: string | undefined,
): string | undefined {
  if (typeof planHandle !== "string" || planHandle.length === 0) return undefined;
  try {
    const stopCategory = (execution.executionReport?.stop_reason as { category?: unknown } | undefined)?.category;
    const status: OperationResultStatus = execution.errorCount === 0
      ? "completed"
      : stopCategory === "mutation_indeterminate" ? "indeterminate" : "partial";
    return store.issue({
      operation: CAMT_PLAN_DOMAIN,
      status,
      items: buildCamtResultDetailItems(execution),
      plan_handle: planHandle,
    });
  } catch {
    return undefined;
  }
}

interface CamtCompactInput {
  readonly mode: "DRY_RUN" | "EXECUTED";
  readonly data: CamtImportRenderData;
  /** Execute only: an operation-result handle bound to the consumed CAMT plan. */
  readonly operationHandle?: string;
}

export function renderCamtImportCompact(input: CamtCompactInput): { summary: OperationSummaryV1 } {
  const { mode, data } = input;
  const dryRun = mode === "DRY_RUN";
  // A dry run with no rows to create has nothing to approve and issues no plan.
  const zeroWrite = dryRun && data.createdCount === 0;
  const meta = data.projection.statementMetadata;

  const possibleDuplicateCount = data.possibleDuplicates.length;
  // Journal reviews are not duplicates: nothing is created and each needs its
  // own follow-up; automatic native-import matches name the stored row.
  const journalReviews = data.projection.skipped.filter(isCamtJournalReviewRow);
  const partialLegacy = data.projection.skipped.filter(row => row.review_code === undefined && row.review_note !== undefined);
  const nativeMatches = data.projection.skipped.filter(row => row.skip_code === "camt_native_import_match");
  // Neither created nor skipped as duplicates: each needs a human look.
  const heldRows = data.projection.skipped.filter(row => row.skip_code !== undefined && CAMT_HOLD_SKIP_CODES.includes(row.skip_code));
  const truncatedCount = data.results.filter(row => row.description_truncated !== undefined).length;
  const ibanOmittedCount = data.results.filter(row => row.counterparty_iban_omitted === true).length;
  const counts = {
    total_statement_entries: data.projection.totalStatementEntries,
    eligible_entries: data.projection.eligibleEntries,
    filtered_out: data.projection.filteredOut,
    [dryRun ? "would_create" : "created"]: data.createdCount,
    skipped: data.projection.skipped.length,
    possible_duplicates: possibleDuplicateCount,
    journal_reviews: journalReviews.length,
    auto_matched: nativeMatches.length,
    held_for_review: heldRows.length,
    errors: data.errorCount,
  };
  const totals = {
    credit_total: data.projection.parsed.summary.credit_total,
    debit_total: data.projection.parsed.summary.debit_total,
  };

  const warnings: CompactWarning[] = (data.statementBalanceCheck?.check?.warnings ?? [])
    .map(message => ({ code: "closing_balance", message }));
  const pageHint = (section: "commands" | "exclusions"): string => dryRun && data.planHandle !== undefined
    ? `page them with get_execution_plan_page { plan_handle: "${data.planHandle}", section: "${section}", detail: "full" }.`
    : zeroWrite
      ? "nothing will be written; to see them all, re-run process_bank_input mode='prepare' with a narrower date_from/date_to, or use process_camt053 on the standard/full profile."
      : `re-run the preview and page its plan ${section} with get_execution_plan_page.`;
  const moreHint = pageHint("exclusions");
  // Unsplit entries are created rows, so the full list is in the plan commands.
  warnings.push(...cappedWarnings("camt_unsplit_entry", data.results.filter(result => result.review_note !== undefined).map(row => ({
    code: "camt_unsplit_entry",
    message: row.review_note!,
  })), pageHint("commands")));
  // One cap across all journal-review codes; each warning keeps its own code.
  warnings.push(...cappedWarnings("camt_journal_review", journalReviews.map(row => ({
    code: row.review_code!,
    message: row.review_note ?? row.reason,
  })), moreHint));
  warnings.push(...cappedWarnings("camt_partial_legacy_import", partialLegacy.map(row => ({
    code: "camt_partial_legacy_import",
    message: row.review_note!,
  })), moreHint));
  warnings.push(...cappedWarnings("camt_native_import_match", nativeMatches.map(row => {
    const transactionId = row.duplicate_transaction_ids[0];
    const journalId = row.journal_ids?.[0];
    return {
      ...(transactionId !== undefined ? { item_id: String(transactionId) } : {}),
      code: "camt_native_import_match",
      message: `The ${row.amount} row on ${row.date} was not created: automatic match (camt_native_import_match) to transaction ${transactionId} `
        + `that e-arveldaja's own bank import created (journal ${journalId}). If wrong (a different movement): correct or delete transaction ${transactionId}, then re-run the preview.`,
    };
  }), moreHint));

  const holdWarning: Record<string, string> = {
    [CAMT_MARKER_IDENTITY_UNFIT]: "row(s) not created: the bank reference and counterparty account are too long for a verifiable import marker. Next: book them by hand from the bank statement.",
    [CAMT_MARKER_CONFLICT_REVIEW]: "row(s) not created: an existing transaction with a contradictory import marker may be the same payment. Next: check that transaction against the bank statement, correct or delete it, then re-run the preview.",
    [CAMT_LOSSY_IDENTITY_AMBIGUOUS]: "row(s) not created: a stored row with a shortened description or a left-out IBAN matches more than one statement entry. Next: compare the ledger with the bank statement and create only the missing rows manually.",
  };
  for (const code of CAMT_HOLD_SKIP_CODES) {
    const count = heldRows.filter(row => row.skip_code === code).length;
    if (count > 0) warnings.push({ code, message: `${count} ${holdWarning[code]}` });
  }
  if (truncatedCount > 0) {
    warnings.push({
      code: "camt_description_truncated",
      message: `${truncatedCount} row(s) store a shortened description. Next: nothing to do; the full text is in the bank statement and the row is still recognised on re-import.`,
    });
  }
  if (ibanOmittedCount > 0) {
    warnings.push({
      code: "camt_counterparty_iban_omitted",
      message: `${ibanOmittedCount} row(s) keep the full description but leave the counterparty IBAN out of the import marker. Next: nothing to do; the IBAN is only in the bank statement, and these rows are treated as external payments and never auto-paired as own transfers.`,
    });
  }

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

  const message = zeroWrite
    ? `Nothing to approve: the CAMT dry run found no rows to write (${data.projection.skipped.length} skipped); no plan handle was issued.`
    : dryRun
    ? `CAMT dry run would create ${data.createdCount} bank transaction(s), skip ${data.projection.skipped.length}, flag ${possibleDuplicateCount} possible duplicate(s), and report ${data.errorCount} error(s).`
    : `CAMT import created ${data.createdCount} bank transaction(s), skipped ${data.projection.skipped.length}, flagged ${possibleDuplicateCount} possible duplicate(s), and reported ${data.errorCount} error(s).`;

  // Journal reviews are skipped rows: they do not block approving the rows a
  // preview creates.
  const status = compactImportStatus({
    dryRun,
    zeroWrite,
    reviews: journalReviews.length + partialLegacy.length + heldRows.length > 0,
    reviewsBlockApproval: false,
    failed: data.errorCount > 0,
  });

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
  }, { budget: "batch", measureEnvelope: "summary", warningHints: { camt_unsplit_entry: pageHint("commands") } });

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
      // The reference fields belong to the same class: AcctSvcrRef / EndToEndId
      // and RmtInf/Strd/CdtrRefInf/Ref are written by the remitter, not the
      // bank, and only trimmed on the way in.
      counterparty_name: wrapUntrustedOcr(entry.counterparty_name),
      description: wrapUntrustedOcr(entry.description),
      bank_reference: wrapUntrustedOcr(entry.bank_reference),
      reference_number: wrapUntrustedOcr(entry.reference_number),
      end_to_end_id: wrapUntrustedOcr(entry.end_to_end_id),
      instruction_id: wrapUntrustedOcr(entry.instruction_id),
      counterparty_iban: wrapUntrustedOcr(entry.counterparty_iban),
      counterparty_reg_code: wrapUntrustedOcr(entry.counterparty_reg_code),
      // Internal dedup aliases (raw statement text): never rendered.
      legacy_identities: undefined,
      ...(entry.duplicate ? { duplicate: true } : { duplicate: undefined }),
      ...(entry.duplicate_transaction_ids.length > 0 ? { duplicate_transaction_ids: entry.duplicate_transaction_ids } : { duplicate_transaction_ids: undefined }),
    })),
  };
}
