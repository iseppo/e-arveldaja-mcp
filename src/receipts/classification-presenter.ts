import { wrapUntrustedOcr } from "../mcp-json.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { createOperationSummary, type OperationSummaryV1 } from "../operation-summary.js";
import type { CompactReviewItem, CompactWarning } from "../operation-outcome.js";
import type { ClassifiedTransactionGroupResult } from "../tools/receipt-inbox.js";
import type {
  ApplyClassificationsResult,
  UnmatchedAnalysisResult,
} from "./classification-operations.js";

// OUTPUT layer for the classification path. The only classification module that
// shapes MCP envelopes. It owns ALL wrapUntrustedOcr sandboxing (the analyze
// double-wrap of counterparty/description, the compact surfaces) plus the
// workflow / batch-execution builders. The typed operation returns UNWRAPPED
// domain data. standard/full keep the byte-identical FULL envelope;
// guided/guided-sales receive the token-lean compact presenter.

// --- FULL analyze envelope (standard/full — byte-identical to the tool) -------

/**
 * Reproduce the classify_unmatched_transactions FULL envelope exactly, including
 * the pre-refactor DOUBLE-wrap of transaction description/bank_account_name
 * (wrapped once in the former toClassifiedResult, again in sanitizedGroups) and
 * the single-wrap of counterparty fields. Key order matches the pre-refactor
 * handler so the standard/full public surface is unchanged.
 */
export function renderUnmatchedAnalysisFull(input: { result: UnmatchedAnalysisResult }): Record<string, unknown> {
  const { result } = input;
  // display_counterparty and each transaction's description/bank_account_name
  // originate from bank-statement import and are attacker-controllable at the
  // counterparty layer. Wrap at the MCP boundary so classify output reaching the
  // LLM is sandboxed. apply_transaction_classifications re-fetches transactions
  // by id, so wrapped text in the JSON payload never participates in lookups.
  const sanitizedGroups = result.groups.map(group => ({
    ...group,
    // normalized_counterparty is derived from imported bank-statement text and
    // would otherwise leak unwrapped via the `...group` spread. Wrap it with the
    // same OCR sandbox as display_counterparty.
    normalized_counterparty: wrapUntrustedOcr(group.normalized_counterparty) ?? group.normalized_counterparty,
    display_counterparty: wrapUntrustedOcr(group.display_counterparty) ?? group.display_counterparty,
    transactions: group.transactions.map(transaction => {
      // First wrap reproduces the former toClassifiedResult; the second
      // reproduces sanitizedGroups — the pre-refactor double-wrap byte-for-byte.
      const innerDescription = wrapUntrustedOcr(transaction.description ?? undefined);
      const innerBankAccountName = wrapUntrustedOcr(transaction.bank_account_name ?? undefined);
      return {
        ...transaction,
        description: wrapUntrustedOcr(innerDescription ?? undefined),
        bank_account_name: wrapUntrustedOcr(innerBankAccountName ?? undefined),
      };
    }),
  }));

  return {
    schema_version: 1,
    accounts_dimensions_id: result.accountsDimensionsId,
    period: {
      from: result.dateFrom ?? "all",
      to: result.dateTo ?? "all",
    },
    total_unconfirmed: result.totalUnconfirmed,
    total_unmatched: result.totalUnmatched,
    category_counts: result.categoryCounts,
    groups: sanitizedGroups,
  };
}

// --- FULL apply envelope (standard/full — byte-identical to the tool) ---------

export interface ApplyClassificationsFullInput {
  readonly result: ApplyClassificationsResult;
  /** The original classifications_json input echoed into workflow suggested_args
   * (string or object, exactly as the caller passed it). */
  readonly classificationsJson: unknown;
}

export function renderApplyClassificationsFull(input: ApplyClassificationsFullInput): Record<string, unknown> {
  const { result, classificationsJson } = input;
  const { mode, dryRun, summary, results } = result;
  // P0-2: the dry-run's next step is execute_apply, which REQUIRES the
  // consume-once plan_handle minted here. Echo it into the suggested_args so the
  // reviewed → execute hop carries the binding (a bare classifications_json can
  // no longer authorize a mutation).
  const workflowArgs = {
    classifications_json: classificationsJson,
    execute: true,
    ...(result.planHandle !== undefined ? { plan_handle: result.planHandle } : {}),
  };
  const workflowSummary = dryRun
    ? `Classification dry run would create ${summary.dry_run_preview} purchase invoice group(s), skip ${summary.skipped}, and fail ${summary.failed}.`
    : `Applied ${summary.applied} classification group(s), skipped ${summary.skipped}, and failed ${summary.failed}.`;
  const workflow = buildWorkflowEnvelope({
    summary: workflowSummary,
    dry_run_steps: dryRun
      ? [{
          tool: "apply_transaction_classifications",
          summary: workflowSummary,
          suggested_args: workflowArgs,
          preview: summary,
        }]
      : [],
  });

  return {
    mode,
    dry_run: dryRun,
    summary,
    ...(result.planHandle !== undefined ? { plan_handle: result.planHandle } : {}),
    workflow,
    results,
    execution: buildBatchExecutionContract({
      mode,
      summary,
      results: results.filter(result =>
        result.status === "applied" ||
        result.status === "dry_run_preview"
      ),
      skipped: results.filter(result => result.status === "skipped"),
      errors: results.filter(result => result.status === "failed"),
    }),
  };
}

// --- COMPACT presenters (guided / guided-sales) ------------------------------
//
// The scalar summary (counts, ≤3 samples, clean groups OMITTED) is approximately
// CONSTANT between 10 and 100 clean groups. Unresolved (review-only) groups
// surface as warnings; PARTIAL MUTATIONS and processing FAILURES surface as
// blockers, first, never hidden. All free text (counterparty) is
// wrapUntrustedOcr-wrapped here; NO raw bank-statement text enters the compact
// summary.
//
// Store constraint: classify has no execution-plan / result store, so a page
// handle cannot be handed back (verified). Mirroring the sibling receipt-batch
// domain (Task 8), the apply dry_run_apply compact INLINES the SAME reviewed
// classifications_json for execute_apply (self-completable, approval_required),
// and a completed execute_apply points at continue_accounting_workflow. The
// analysis compact points at dry_run_apply WITHOUT inlining the O(n) groups so
// its size stays approximately constant — the store-less next-step limitation
// tracked as F-UNIFORM-RESULT-PAGE for Task 10.

export interface ClassificationAnalysisCompactInput {
  readonly result: UnmatchedAnalysisResult;
  readonly accountsDimensionsId: number;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly connectionName?: string;
}

export function renderClassificationAnalysisCompact(
  input: ClassificationAnalysisCompactInput,
): { summary: OperationSummaryV1 } {
  const { result } = input;
  const groups = result.groups;
  const unresolvedGroups = groups.filter(group => group.apply_mode !== "purchase_invoice");

  const counts: Record<string, number> = {
    unconfirmed: result.totalUnconfirmed,
    unmatched: result.totalUnmatched,
    groups: groups.length,
    unresolved: unresolvedGroups.length,
    ...result.categoryCounts,
  };

  // Unresolved (review-only) groups surface as warnings (≤3); the counterparty
  // is the only free text and is OCR-sandbox-wrapped.
  const warnings: CompactWarning[] = unresolvedGroups.slice(0, 3).map(group => ({
    item_id: wrapUntrustedOcr(group.display_counterparty) ?? "",
    code: "needs_review",
    message: `Group classified as ${group.category} needs manual review before booking (apply_mode ${group.apply_mode}).`,
  }));

  const samples = groups.slice(0, 3).map((group, index) => ({
    i: index,
    category: group.category,
    apply_mode: group.apply_mode,
    counterparty: wrapUntrustedOcr(group.display_counterparty),
    transactions: group.transactions.length,
    total_amount: group.total_amount,
  }));

  const status: OperationSummaryV1["status"] = unresolvedGroups.length > 0 ? "needs_review" : "completed";
  const message = `Classified ${result.totalUnmatched} unmatched transaction(s) into ${groups.length} group(s); ${unresolvedGroups.length} need manual review.`;

  const period = {
    ...(input.dateFrom !== undefined ? { from: input.dateFrom } : {}),
    ...(input.dateTo !== undefined ? { to: input.dateTo } : {}),
  };
  const scope = {
    ...(input.connectionName ? { connection: input.connectionName } : {}),
    account: String(input.accountsDimensionsId),
    ...(period.from !== undefined || period.to !== undefined ? { period } : {}),
  } as OperationSummaryV1["scope"];

  // Store-less next step: point at dry_run_apply. classifications_json (this
  // analysis output) must be carried forward by the caller; it is NOT inlined so
  // the compact stays approximately constant-size (F-UNIFORM-RESULT-PAGE, T10).
  const next_action = {
    tool: "classify_bank_transactions",
    args: { mode: "dry_run_apply" },
    approval_required: false,
  };

  const summary = createOperationSummary({
    status,
    message,
    counts,
    scope,
    warnings,
    samples,
    next_action,
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary };
}

export interface ApplyClassificationsCompactInput {
  readonly result: ApplyClassificationsResult;
  /** The reviewed classifications_json the caller sent; the dry_run_apply compact
   * inlines it into the execute_apply next_action so the guided flow is
   * self-completable. */
  readonly classificationsJson: unknown;
  readonly accountsDimensionsId?: number;
  readonly connectionName?: string;
}

export function renderApplyClassificationsCompact(
  input: ApplyClassificationsCompactInput,
): { summary: OperationSummaryV1 } {
  const { result } = input;
  const { dryRun, summary: statusSummary, results } = result;
  const partialMutationCount = results.reduce(
    (total, group) => total + (group.partial_mutations?.length ?? 0),
    0,
  );

  const counts: Record<string, number> = {
    applied: statusSummary.applied,
    skipped: statusSummary.skipped,
    dry_run_preview: statusSummary.dry_run_preview,
    failed: statusSummary.failed,
    ...(partialMutationCount > 0 ? { partial_mutations: partialMutationCount } : {}),
  };

  // Blockers are NEVER hidden and come first: partial mutations (a created
  // invoice with an incomplete downstream mutation) and processing failures.
  const blockers: CompactReviewItem[] = [];
  for (const group of results) {
    for (const partial of group.partial_mutations ?? []) {
      blockers.push({
        item_id: `invoice-${partial.created_invoice_id}`,
        code: partial.category,
        message: `Transaction ${partial.attempted_transaction_id}: ${partial.failed_stage} left invoice ${partial.created_invoice_id} in an incomplete state. ${partial.next_action}`,
        severity: "blocker",
      });
    }
  }
  if (!dryRun) {
    for (const group of results.filter(candidate => candidate.status === "failed")) {
      blockers.push({
        item_id: wrapUntrustedOcr(group.counterparty) ?? group.category,
        code: "classification_apply_failed",
        message: `Classification group ${group.category} failed to apply. Re-preview before retrying; a prior preview is not approval.`,
        severity: "blocker",
      });
    }
  }

  const warnings: CompactWarning[] = results
    .filter(group => group.status === "skipped")
    .slice(0, 3)
    .map(group => ({
      item_id: wrapUntrustedOcr(group.counterparty) ?? "",
      code: "skipped",
      message: `Classification group ${group.category} was skipped and not booked.`,
    }));

  const samples = results.slice(0, 3).map((group, index) => ({
    i: index,
    status: group.status,
    category: group.category,
    counterparty: wrapUntrustedOcr(group.counterparty),
    transactions: group.transactions.length,
  }));

  const status: OperationSummaryV1["status"] = dryRun
    ? "ready_for_approval"
    : (statusSummary.failed > 0 || partialMutationCount > 0)
      ? "partial"
      : "completed";
  const message = dryRun
    ? `Classification dry run would create ${statusSummary.dry_run_preview} purchase invoice group(s), skip ${statusSummary.skipped}, and fail ${statusSummary.failed}.`
    : `Applied ${statusSummary.applied} classification group(s), skipped ${statusSummary.skipped}, and failed ${statusSummary.failed}.`;

  const scope = {
    ...(input.connectionName ? { connection: input.connectionName } : {}),
    ...(input.accountsDimensionsId !== undefined ? { account: String(input.accountsDimensionsId) } : {}),
  } as OperationSummaryV1["scope"];

  // dry_run_apply → execute_apply carries the SAME reviewed classifications_json
  // (self-completable, approval_required). execute_apply → continue_accounting_workflow
  // (post-mutation, nothing to resend).
  const next_action = dryRun
    ? {
        tool: "classify_bank_transactions",
        args: {
          mode: "execute_apply",
          classifications_json: input.classificationsJson,
          // P0-2: the consume-once handle bound to this reviewed effect; without
          // it execute_apply fails closed (plan_handle_required).
          ...(result.planHandle !== undefined ? { plan_handle: result.planHandle } : {}),
        },
        approval_required: true,
      }
    : {
        tool: "continue_accounting_workflow",
        args: {},
        approval_required: false,
      };

  const summary = createOperationSummary({
    status,
    message,
    counts,
    ...(scope && Object.keys(scope).length > 0 ? { scope } : {}),
    warnings,
    blockers,
    samples,
    next_action,
  }, { budget: "batch", measureEnvelope: "summary" });

  return { summary };
}
