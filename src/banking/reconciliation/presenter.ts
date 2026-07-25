import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { wrapUntrustedOcr } from "../../mcp-json.js";
import { buildBatchExecutionContract } from "../../batch-execution.js";
import { toolError } from "../../tool-error.js";
import type { OperationFailure } from "../../operation-outcome.js";
import type { PlanExecutionReport } from "../../plan-execution.js";
import {
  formatDuplicatePostingWarnings,
  type DuplicatePostingSuspect,
} from "../../bank-posting-duplicate-guard.js";
import { roundMoney } from "../../money.js";
import { createOperationSummary, type OperationSummaryV1 } from "../../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../../operation-outcome.js";
import { createPublicOperationResultDetail, type PublicOperationResultDetail } from "../../operation-result-store.js";
import {
  reconClientUpdateCommandId,
  reconInvoiceConfirmCommandId,
  reconTransferConfirmCommandId,
  reconDeleteDuplicateCommandId,
  stripUndefinedDeep,
  RECON_UPDATE_CLIENT_CATEGORY,
  RECON_CONFIRM_INVOICE_CATEGORY,
  type ReconciliationReviewCommand,
} from "../../tools/bank-reconciliation-plan.js";
import type {
  ExactMatchProjection,
  InterAccountMatchResult,
  ReconciliationSuggestions,
} from "./types.js";
import type { ReconFailure } from "./executor.js";

// ---------------------------------------------------------------------------
// OUTPUT layer. The only reconciliation module that shapes MCP envelopes and
// applies the OCR/untrusted-text sandbox (wrapUntrustedOcr). The pure modules
// never sandbox. standard/full keep the byte-identical FULL envelopes; the
// COMPACT presenter (Phase B) serves guided/guided-sales.
// ---------------------------------------------------------------------------

// --- Failure envelopes -------------------------------------------------------

// `retry` is carried, not guessed: every reconciliation failure that reaches
// this envelope is a plan-gate rejection (handle required / store error /
// drift), and the operations layer already types them `retry: "never"` — a
// caller must re-preview, never repeat the same call. Dropping the field left
// the consumer unable to tell "do not retry" from "unknown".
export function reconPlanErrorPayload(
  category: string,
  message: string,
  retry: OperationFailure["retry"] = "never",
): Record<string, unknown> {
  return { error: message, category, retry, mutation_occurred: false };
}

export function reconPlanError(category: string, message: string): CallToolResult {
  return toolError(reconPlanErrorPayload(category, message));
}

/** Map a structured executor failure to the exact non-mutating MCP envelope it
 * produced before the refactor. Byte-identical to the inline handler returns. */
export function renderReconFailure(failure: ReconFailure): CallToolResult {
  return reconPlanError(failure.category, failure.message);
}

// --- Suspect wrapping + plan review commands ---------------------------------

// Wrap each suspect's untrusted journal_title at MCP output (Task 3).
export function renderSuspects(suspects: DuplicatePostingSuspect[]): Array<Record<string, unknown>> {
  return suspects.map(s => ({ ...s, journal_title: wrapUntrustedOcr(s.journal_title) ?? "" }));
}

export function exactMatchReviewCommands(projection: ExactMatchProjection): ReconciliationReviewCommand[] {
  const commands: ReconciliationReviewCommand[] = [];
  for (const descriptor of projection.confirms) {
    if (descriptor.needsClientUpdate) {
      commands.push({
        id: reconClientUpdateCommandId(descriptor.transactionId),
        category: RECON_UPDATE_CLIENT_CATEGORY,
        reviewProjection: stripUndefinedDeep({
          transaction_id: descriptor.transactionId,
          set_clients_id: descriptor.invoiceClientsId,
          from_invoice: descriptor.invoiceId,
        }),
      });
    }
    commands.push({
      id: reconInvoiceConfirmCommandId(descriptor.transactionId),
      category: RECON_CONFIRM_INVOICE_CATEGORY,
      reviewProjection: stripUndefinedDeep({
        transaction_id: descriptor.transactionId,
        invoice_type: descriptor.invoiceType,
        invoice_id: descriptor.invoiceId,
        invoice_number: descriptor.invoiceNumber,
        amount: descriptor.amount,
        currency: descriptor.currency,
        confidence: descriptor.confidence,
        ...(descriptor.possibleDuplicatePostings && descriptor.possibleDuplicatePostings.length > 0
          ? { possible_duplicate_postings: renderSuspects(descriptor.possibleDuplicatePostings) }
          : {}),
      }),
    });
  }
  return commands;
}

// --- Suggest FULL envelope ---------------------------------------------------

// Wrap every untrusted free-text field on a RAW suggest match row at MCP output.
// Reassigning existing keys preserves their position, so the decoded structure is
// identical to the pre-relocation executor-side wrapping (each field wrapped once).
function wrapSuggestMatch(match: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...match };
  if ("description" in match) out.description = wrapUntrustedOcr(match.description as string | undefined);
  if ("bank_account_name" in match) out.bank_account_name = wrapUntrustedOcr(match.bank_account_name as string | undefined);
  if ("ref_number" in match) out.ref_number = wrapUntrustedOcr(match.ref_number as string | undefined);
  const bestMatch = match.best_match;
  if (bestMatch !== null && typeof bestMatch === "object") {
    const b = bestMatch as Record<string, unknown>;
    out.best_match = {
      ...b,
      number: wrapUntrustedOcr(b.number as string | undefined) ?? "",
      client_name: wrapUntrustedOcr(b.client_name as string | undefined) ?? "",
      ref_number: wrapUntrustedOcr(b.ref_number as string | undefined),
    };
  }
  if (Array.isArray(match.possible_duplicate_postings)) {
    out.possible_duplicate_postings = renderSuspects(match.possible_duplicate_postings as DuplicatePostingSuspect[]);
  }
  return out;
}

export function renderSuggestPayload(data: ReconciliationSuggestions): Record<string, unknown> {
  return {
    total_unconfirmed: data.totalUnconfirmed,
    matched: data.matched,
    unmatched: data.unmatched,
    matches: data.matches.map(wrapSuggestMatch),
    ...(data.duplicateScanNote !== undefined ? { duplicate_scan_note: data.duplicateScanNote } : {}),
  };
}

// The POSSIBLE-duplicate warning lines are built HERE (the sole sandbox site)
// from the executor's RAW scan inputs, wrapping the untrusted journal title.
const wrapReconTitle = (title: string): string => wrapUntrustedOcr(title) ?? "";
function reconDuplicateWarnings(projection: ExactMatchProjection): string[] {
  return (projection.duplicateWarningInputs ?? []).flatMap(({ scan, candidate }) =>
    formatDuplicatePostingWarnings(scan, candidate, wrapReconTitle));
}

// --- Exact-match FULL envelope (byte-identical to the pre-refactor tool) ------

export function renderExactMatchPayload(input: {
  mode: "DRY_RUN" | "EXECUTED";
  projection: ExactMatchProjection;
  planHandle?: string;
  executionReport?: PlanExecutionReport;
}): Record<string, unknown> {
  const { projection, mode } = input;
  const dryRun = mode === "DRY_RUN";
  const completedIds = new Set(input.executionReport?.command_partitions.completed.map(item => item.command_id) ?? []);

  const results: Array<Record<string, unknown>> = projection.confirms.map(descriptor => {
    const confirmed = completedIds.has(reconInvoiceConfirmCommandId(descriptor.transactionId));
    return {
      transaction_id: descriptor.transactionId,
      amount: descriptor.amount,
      date: descriptor.date,
      match: { type: descriptor.invoiceType, id: descriptor.invoiceId, number: wrapUntrustedOcr(descriptor.invoiceNumber) ?? "", confidence: descriptor.confidence },
      status: dryRun ? "would_confirm" : confirmed ? "confirmed" : "not_confirmed",
      ...(descriptor.possibleDuplicatePostings && descriptor.possibleDuplicatePostings.length > 0
        ? { possible_duplicate_postings: renderSuspects(descriptor.possibleDuplicatePostings) }
        : {}),
    };
  });

  // Descriptors partitioned out by block_on_duplicate render like skipped rows,
  // never would_confirm — the operator sees the conflict instead of an approval.
  for (const blockedRow of projection.blockedDuplicateSuspects) {
    results.push({
      transaction_id: blockedRow.transaction_id,
      status: "blocked_duplicate_suspect",
      reason: blockedRow.reason,
      conflicting_journal_ids: blockedRow.conflicting_journal_ids,
      possible_duplicate_postings: renderSuspects(blockedRow.suspects),
    });
  }

  const errors: Array<{ transaction_id?: number; reason: string }> = projection.skipped.map(row => ({ ...row }));
  if (!dryRun && input.executionReport) {
    for (const descriptor of projection.confirms) {
      if (!completedIds.has(reconInvoiceConfirmCommandId(descriptor.transactionId))) {
        errors.push({ transaction_id: descriptor.transactionId, reason: `Confirmation not completed for transaction ${descriptor.transactionId}; see execution_report.` });
      }
    }
  }

  const autoConfirmed = dryRun ? projection.confirms.length : results.filter(row => row.status === "confirmed").length;
  const summary = {
    total_unconfirmed: projection.totalUnconfirmed,
    auto_confirmed: autoConfirmed,
    skipped: projection.skipped.length,
    error_count: errors.length,
  };
  const duplicateWarnings = reconDuplicateWarnings(projection);

  return {
    mode,
    summary,
    total_unconfirmed: summary.total_unconfirmed,
    auto_confirmed: summary.auto_confirmed,
    skipped: summary.skipped,
    results,
    errors,
    execution: buildBatchExecutionContract({
      mode,
      summary,
      results,
      errors,
      ...(input.executionReport !== undefined ? { execution_report: input.executionReport } : {}),
    }),
    ...(duplicateWarnings.length > 0 ? { warnings: duplicateWarnings } : {}),
    ...(projection.duplicateScanNote !== undefined ? { duplicate_scan_note: projection.duplicateScanNote } : {}),
    ...(input.planHandle !== undefined ? { plan_handle: input.planHandle } : {}),
  };
}

// --- Inter-account FULL envelope (byte-identical to the pre-refactor tool) ----

export function buildInterAccountPayload(input: {
  mode: "DRY_RUN" | "EXECUTED";
  match: InterAccountMatchResult;
  planHandle?: string;
  executionReport?: PlanExecutionReport;
}): Record<string, unknown> {
  const m = input.match;
  const summary = {
    total_unconfirmed: m.totalUnconfirmed,
    matched_pairs: m.matchedPairs.length,
    matched_one_sided: m.matchedOneSided.length,
    skipped_ambiguous: m.ambiguousPairs.length,
    skipped_already_handled: m.skippedAlreadyHandled.length,
    needs_review_ambiguous_refless: m.ambiguousRefless.length,
    needs_review_cross_currency: m.crossCurrencyPairs.length,
    error_count: m.errors.length,
  };
  // Wrap the RAW transaction descriptions here (the sole sandbox site), once
  // each, in the same position they hold today — the decoded structure is
  // byte-identical to the pre-relocation executor-side wrapping. The batch
  // execution contract must carry the SAME wrapped rows, so it is fed the
  // wrapped arrays below.
  const wrappedPairs = m.matchedPairs.map(pair => ({
    ...pair,
    description_out: wrapUntrustedOcr(pair.description_out ?? undefined),
    description_in: wrapUntrustedOcr(pair.description_in ?? undefined),
  }));
  const wrappedOneSided = m.matchedOneSided.map(row => ({
    ...row,
    description: wrapUntrustedOcr(row.description ?? undefined),
    counterparty_name: wrapUntrustedOcr(row.counterparty_name ?? undefined),
  }));
  return {
    mode: input.mode,
    summary,
    company_name: m.invoiceInfo.invoice_company_name,
    total_unconfirmed: summary.total_unconfirmed,
    matched_pairs: summary.matched_pairs,
    matched_one_sided: summary.matched_one_sided,
    skipped_ambiguous: summary.skipped_ambiguous,
    skipped_already_handled: summary.skipped_already_handled,
    needs_review_ambiguous_refless: summary.needs_review_ambiguous_refless,
    needs_review_cross_currency: summary.needs_review_cross_currency,
    own_bank_accounts: [...m.dimensionToIban.entries()].map(([dimId, iban]) => ({
      accounts_dimensions_id: dimId,
      iban,
      title: m.dimensionToTitle.get(dimId),
    })),
    pairs: wrappedPairs,
    ambiguous_pairs: m.ambiguousPairs,
    one_sided: wrappedOneSided,
    already_handled: m.skippedAlreadyHandled,
    ambiguous_refless: m.ambiguousRefless,
    cross_currency_review: m.crossCurrencyPairs,
    errors: m.errors,
    execution: buildBatchExecutionContract({
      mode: input.mode,
      summary,
      results: [...wrappedPairs, ...wrappedOneSided],
      skipped: [...m.ambiguousPairs, ...m.skippedAlreadyHandled, ...m.ambiguousRefless, ...m.crossCurrencyPairs],
      errors: [...m.errors],
      ...(input.executionReport !== undefined ? { execution_report: input.executionReport } : {}),
    }),
    ...(input.planHandle !== undefined ? { plan_handle: input.planHandle } : {}),
  };
}

// --- COMPACT presenter (guided / guided-sales) -------------------------------
//
// Size is approximately CONSTANT regardless of reconciliation row count: counts
// and totals are scalars (bounded by #currencies / #accounts), at most THREE
// samples are inlined, clean match rows are OMITTED, and the full per-row detail
// is referenced via get_operation_result_page (execute) or the plan_handle (dry
// run). Blockers/errors are NEVER hidden. All untrusted free-text (description /
// counterparty / reference / invoice number) is OCR-sandbox-wrapped here — the
// presenter owns wrapping for BOTH full and compact, and since the typed results
// are clean domain data there is no double-wrap. The compact response carries the
// full source-spec 2.3 approval-summary list: blockers; scope (connection/company,
// affected account, date range); financial totals with currencies; object counts
// by type; duplicates; errors/unresolved review items; partial/destructive/
// indeterminate state (status); and the exact approval action (plan_handle on dry
// run, get_operation_result_page on execute).

/** Active connection label surfaced as scope.connection. */
export interface ReconCompactContext {
  readonly connectionName?: string;
}

function reconDateRange(dates: ReadonlyArray<string | null | undefined>): { from?: string; to?: string } {
  let from: string | undefined;
  let to: string | undefined;
  for (const date of dates) {
    if (typeof date !== "string" || date.length === 0) continue;
    if (from === undefined || date < from) from = date;
    if (to === undefined || date > to) to = date;
  }
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

function reconScope(input: {
  connectionName?: string;
  company?: string | null;
  accountLabels: readonly string[];
  period: { from?: string; to?: string };
}): OperationSummaryV1["scope"] {
  const hasPeriod = input.period.from !== undefined || input.period.to !== undefined;
  return {
    ...(input.connectionName ? { connection: input.connectionName } : {}),
    ...(input.company ? { company: input.company } : {}),
    ...(input.accountLabels.length > 0 ? { account: input.accountLabels.join(", ") } : {}),
    ...(hasPeriod ? { period: input.period } : {}),
  } as OperationSummaryV1["scope"];
}

// --- Suggest compact ---------------------------------------------------------

export function renderSuggestCompact(
  data: ReconciliationSuggestions,
  ctx: ReconCompactContext = {},
): { summary: OperationSummaryV1 } {
  const matches = data.matches;
  const duplicateRows = matches.filter(
    row => Array.isArray(row.possible_duplicate_postings) && (row.possible_duplicate_postings as unknown[]).length > 0,
  );
  const reviewRows = matches.filter(row => typeof row.manual_review_required === "string");

  const counts = {
    total_unconfirmed: data.totalUnconfirmed,
    matched: data.matched,
    unmatched: data.unmatched,
    duplicates: duplicateRows.length,
    needs_review: reviewRows.length,
  };
  const totals: Record<string, number> = { ...(data.compact?.matchedTotalsByCurrency ?? {}) };

  // Unresolved review items + a degraded duplicate scan surface as warnings —
  // never dropped from the lean surface.
  const warnings: CompactWarning[] = reviewRows.slice(0, 3).map(row => ({
    item_id: String(row.transaction_id ?? ""),
    code: "manual_review_required",
    message: String(row.manual_review_required),
  }));
  if (data.duplicateScanNote !== undefined) {
    warnings.push({ code: "duplicate_scan_unavailable", message: data.duplicateScanNote });
  }

  // Suggest is read-only (no execution) — it never produces execution blockers.
  const blockers: CompactReviewItem[] = [];

  const samples = matches.slice(0, 3).map((row, index) => {
    const best = (row.best_match ?? {}) as Record<string, unknown>;
    return {
      i: index,
      transaction_id: row.transaction_id,
      date: row.date,
      amount: row.amount,
      ...(row.bank_account_name !== undefined
        ? { counterparty: wrapUntrustedOcr(row.bank_account_name as string | undefined) }
        : {}),
      match: {
        type: best.type,
        id: best.id,
        number: wrapUntrustedOcr(best.number as string | undefined) ?? "",
        confidence: best.confidence,
      },
      ...(Array.isArray(row.possible_duplicate_postings) && (row.possible_duplicate_postings as unknown[]).length > 0
        ? { possible_duplicate: true }
        : {}),
    };
  });

  const message = `Reconcile suggestions: ${data.matched} of ${data.totalUnconfirmed} unconfirmed transaction(s) matched an open invoice; ${duplicateRows.length} possible duplicate(s), ${reviewRows.length} need review.`;

  const scope = reconScope({
    connectionName: ctx.connectionName,
    accountLabels: data.compact?.accountLabels ?? [],
    period: { from: data.compact?.dateFrom, to: data.compact?.dateTo },
  });

  const summary = createOperationSummary({
    status: "needs_review",
    message,
    counts,
    totals,
    scope,
    warnings,
    blockers,
    samples,
    // Suggest has no execution plan; the exact approval action is to run the
    // dry-run confirm and review its plan_handle.
    next_action: { tool: "reconcile_bank_transactions", args: { mode: "dry_run_auto_confirm" }, approval_required: true },
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary };
}

// --- Exact-match compact -----------------------------------------------------

export interface ExactMatchCompactInput {
  readonly mode: "DRY_RUN" | "EXECUTED";
  readonly projection: ExactMatchProjection;
  readonly planHandle?: string;
  readonly executionReport?: PlanExecutionReport;
  /** Execute only: an operation-result handle bound to the consumed recon plan. */
  readonly operationHandle?: string;
  readonly connectionName?: string;
}

/** Scalar-only per-confirm details for the operation-result store. Free-form
 * fields (invoice number) are intentionally omitted — the compact samples carry
 * the wrapped invoice number instead. */
export function buildReconExactResultDetailItems(
  projection: ExactMatchProjection,
  executionReport?: PlanExecutionReport,
): PublicOperationResultDetail[] {
  const completedIds = new Set(executionReport?.command_partitions.completed.map(item => item.command_id) ?? []);
  return projection.confirms.map((descriptor, index) => createPublicOperationResultDetail({
    i: index,
    status: executionReport
      ? (completedIds.has(reconInvoiceConfirmCommandId(descriptor.transactionId)) ? "confirmed" : "not_confirmed")
      : "would_confirm",
    ...(descriptor.date !== undefined ? { date: descriptor.date } : {}),
    amount: descriptor.amount,
    id: descriptor.transactionId,
  }));
}

export function renderExactMatchCompact(input: ExactMatchCompactInput): { summary: OperationSummaryV1 } {
  const { mode, projection } = input;
  const dryRun = mode === "DRY_RUN";
  const completedIds = new Set(input.executionReport?.command_partitions.completed.map(item => item.command_id) ?? []);
  const confirmedCount = dryRun
    ? projection.confirms.length
    : projection.confirms.filter(descriptor => completedIds.has(reconInvoiceConfirmCommandId(descriptor.transactionId))).length;
  const notCompleted = dryRun ? 0 : projection.confirms.length - confirmedCount;
  const errorCount = projection.skipped.length + notCompleted;
  const duplicateCount =
    projection.confirms.filter(descriptor => (descriptor.possibleDuplicatePostings?.length ?? 0) > 0).length
    + projection.blockedDuplicateSuspects.length;

  const counts = {
    total_unconfirmed: projection.totalUnconfirmed,
    [dryRun ? "would_confirm" : "confirmed"]: confirmedCount,
    skipped: projection.skipped.length,
    blocked_duplicates: projection.blockedDuplicateSuspects.length,
    duplicates: duplicateCount,
    errors: errorCount,
  };

  const totals: Record<string, number> = {};
  for (const descriptor of projection.confirms) {
    totals[descriptor.currency] = roundMoney((totals[descriptor.currency] ?? 0) + descriptor.amount);
  }

  const warnings: CompactWarning[] = [];
  for (const line of reconDuplicateWarnings(projection).slice(0, 3)) {
    warnings.push({ code: "possible_duplicate", message: line });
  }
  for (const blocked of projection.blockedDuplicateSuspects.slice(0, 3)) {
    warnings.push({ item_id: String(blocked.transaction_id), code: "blocked_duplicate_suspect", message: blocked.reason });
  }
  if (projection.duplicateScanNote !== undefined) {
    warnings.push({ code: "duplicate_scan_unavailable", message: projection.duplicateScanNote });
  }

  // Execution errors (indeterminate / failed confirms) surface as blockers —
  // never hidden.
  const blockers: CompactReviewItem[] = [];
  if (!dryRun && errorCount > 0) {
    const stop = input.executionReport?.stop_reason as { command_id?: unknown; category?: unknown } | undefined;
    blockers.push({
      item_id: typeof stop?.command_id === "string" ? stop.command_id : "reconcile-exact",
      code: typeof stop?.category === "string" ? stop.category : "confirm_incomplete",
      message: `${errorCount} exact-match confirm(s) did not complete. Re-preview before retrying; a prior plan is not approval.`,
      severity: "blocker",
    });
  }

  const samples = projection.confirms.slice(0, 3).map((descriptor, index) => ({
    i: index,
    transaction_id: descriptor.transactionId,
    amount: descriptor.amount,
    currency: descriptor.currency,
    ...(descriptor.date !== undefined ? { date: descriptor.date } : {}),
    match: {
      type: descriptor.invoiceType,
      id: descriptor.invoiceId,
      number: wrapUntrustedOcr(descriptor.invoiceNumber) ?? "",
      confidence: descriptor.confidence,
    },
    status: dryRun ? "would_confirm" : (completedIds.has(reconInvoiceConfirmCommandId(descriptor.transactionId)) ? "confirmed" : "not_confirmed"),
  }));

  const accountLabels = [...new Set(
    projection.confirms.map(descriptor => descriptor.accountsDimensionsId).filter((id): id is number => id != null).map(String),
  )];
  const scope = reconScope({
    connectionName: input.connectionName,
    accountLabels,
    period: reconDateRange(projection.confirms.map(descriptor => descriptor.date)),
  });

  const message = dryRun
    ? `Exact-match dry run would confirm ${confirmedCount} transaction(s), skip ${projection.skipped.length}, and report ${errorCount} error(s).`
    : `Exact-match confirm completed ${confirmedCount} transaction(s), skipped ${projection.skipped.length}, and reported ${errorCount} error(s).`;

  const status = dryRun
    ? "ready_for_approval" as const
    : (errorCount > 0 ? "partial" as const : "completed" as const);

  const details = !dryRun && input.operationHandle !== undefined
    ? {
        available: projection.confirms.length > samples.length,
        total_items: projection.confirms.length,
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
    ...(dryRun && input.planHandle !== undefined ? { plan_handle: input.planHandle } : {}),
    ...(details ? { details } : {}),
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary };
}

// --- Inter-account compact ---------------------------------------------------

export interface InterAccountCompactInput {
  readonly mode: "DRY_RUN" | "EXECUTED";
  readonly match: InterAccountMatchResult;
  readonly planHandle?: string;
  readonly executionReport?: PlanExecutionReport;
  /** Execute only: an operation-result handle bound to the consumed recon plan. */
  readonly operationHandle?: string;
  readonly connectionName?: string;
}

/** Scalar-only per-transfer details for the operation-result store. */
export function buildReconInterAccountResultDetailItems(
  match: InterAccountMatchResult,
): PublicOperationResultDetail[] {
  const items: PublicOperationResultDetail[] = [];
  match.matchedPairs.forEach((pair, index) => items.push(createPublicOperationResultDetail({
    i: index,
    status: pair.status,
    date: pair.date_out,
    amount: pair.amount,
    id: pair.outgoing_transaction_id,
  })));
  match.matchedOneSided.forEach((row, index) => items.push(createPublicOperationResultDetail({
    i: match.matchedPairs.length + index,
    status: row.status,
    date: row.date,
    amount: row.amount,
    id: row.transaction_id,
  })));
  return items;
}

export function renderInterAccountCompact(input: InterAccountCompactInput): { summary: OperationSummaryV1 } {
  const m = input.match;
  const dryRun = input.mode === "DRY_RUN";
  const errorCount = m.errors.length;

  const counts = {
    total_unconfirmed: m.totalUnconfirmed,
    matched_pairs: m.matchedPairs.length,
    matched_one_sided: m.matchedOneSided.length,
    skipped_ambiguous: m.ambiguousPairs.length,
    duplicates: m.skippedAlreadyHandled.length,
    needs_review_ambiguous_refless: m.ambiguousRefless.length,
    needs_review_cross_currency: m.crossCurrencyPairs.length,
    errors: errorCount,
  };

  const totals: Record<string, number> = {};
  for (const action of m.confirmActions) {
    totals[action.confirmedCurrency] = roundMoney((totals[action.confirmedCurrency] ?? 0) + action.confirmedNominalAmount);
  }

  // Ambiguous / cross-currency / unresolved rows surface as warnings — never
  // dropped from the lean surface.
  const warnings: CompactWarning[] = [];
  for (const pair of m.ambiguousPairs.slice(0, 3)) {
    warnings.push({ item_id: String(pair.outgoing_transaction_id), code: "ambiguous_pair", message: pair.reason });
  }
  for (const row of m.ambiguousRefless.slice(0, 3)) {
    warnings.push({ code: "ambiguous_refless", message: row.reason });
  }
  for (const row of m.crossCurrencyPairs.slice(0, 3)) {
    warnings.push({ code: "cross_currency_review", message: row.reason });
  }
  for (const row of m.errors.slice(0, 3)) {
    warnings.push({ code: row.code ?? "inter_account_error", message: row.reason });
  }

  const executionStopped = !dryRun && input.executionReport?.stop_reason != null;
  const blockers: CompactReviewItem[] = [];
  if (executionStopped) {
    const stop = input.executionReport?.stop_reason as { command_id?: unknown; category?: unknown } | undefined;
    blockers.push({
      item_id: typeof stop?.command_id === "string" ? stop.command_id : "reconcile-inter-account",
      code: typeof stop?.category === "string" ? stop.category : "transfer_incomplete",
      message: "An inter-account command did not complete. Re-preview before retrying; a prior plan is not approval.",
      severity: "blocker",
    });
  }

  const samplePairs = m.matchedPairs.slice(0, 3).map((pair, index) => ({
    i: index,
    kind: "pair",
    outgoing_transaction_id: pair.outgoing_transaction_id,
    incoming_transaction_id: pair.incoming_transaction_id,
    amount: pair.amount,
    date: pair.date_out,
    from_account: pair.from_account,
    to_account: pair.to_account,
    ...(pair.description_out ? { description_out: wrapUntrustedOcr(pair.description_out ?? undefined) } : {}),
    status: pair.status,
  }));
  const remaining = 3 - samplePairs.length;
  const sampleOneSided = remaining > 0
    ? m.matchedOneSided.slice(0, remaining).map((row, index) => ({
        i: samplePairs.length + index,
        kind: "one_sided",
        transaction_id: row.transaction_id,
        amount: row.amount,
        currency: row.currency,
        date: row.date,
        source_account: row.source_account,
        target_account: row.target_account,
        ...(row.counterparty_name ? { counterparty: wrapUntrustedOcr(row.counterparty_name ?? undefined) } : {}),
        status: row.status,
      }))
    : [];
  const samples = [...samplePairs, ...sampleOneSided];

  const accountLabels = [...m.dimensionToTitle.values()];
  const scope = reconScope({
    connectionName: input.connectionName,
    company: m.invoiceInfo.invoice_company_name,
    accountLabels,
    period: reconDateRange([
      ...m.matchedPairs.flatMap(pair => [pair.date_out, pair.date_in]),
      ...m.matchedOneSided.map(row => row.date),
    ]),
  });

  const message = dryRun
    ? `Inter-account dry run would reconcile ${m.matchedPairs.length} transfer pair(s), ${m.matchedOneSided.length} one-sided transfer(s), skip ${m.ambiguousPairs.length} ambiguous, and report ${errorCount} error(s).`
    : `Inter-account reconcile handled ${m.matchedPairs.length} transfer pair(s) and ${m.matchedOneSided.length} one-sided transfer(s); ${errorCount} error(s).`;

  const status = dryRun
    ? "ready_for_approval" as const
    : (executionStopped || errorCount > 0 ? "partial" as const : "completed" as const);

  const totalItems = m.matchedPairs.length + m.matchedOneSided.length;
  const details = !dryRun && input.operationHandle !== undefined
    ? {
        available: totalItems > samples.length,
        total_items: totalItems,
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
    ...(dryRun && input.planHandle !== undefined ? { plan_handle: input.planHandle } : {}),
    ...(details ? { details } : {}),
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary };
}
