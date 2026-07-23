import { cloneAndFreezePlanData, type PlanData } from "./plan-store.js";
import type { CompactReviewItem, CompactWarning } from "./operation-outcome.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS, ResponseBudgetError, type ResponseBudgetKind } from "./response-budget.js";

export type OperationSummaryStatus = "completed" | "ready_for_approval" | "needs_input" | "needs_review" | "partial" | "failed";

export interface OperationSummaryV1 {
  readonly contract: "operation_summary_v1";
  readonly status: OperationSummaryStatus;
  readonly message: string;
  readonly counts?: Readonly<Record<string, number>>;
  readonly totals?: Readonly<Record<string, number | string>>;
  readonly scope?: Readonly<{
    connection?: string;
    company?: string;
    account?: string;
    period?: { from?: string; to?: string };
    source_documents?: string[];
  }>;
  readonly warnings?: readonly CompactWarning[];
  readonly blockers?: readonly CompactReviewItem[];
  readonly samples?: unknown[];
  readonly next_action?: Readonly<{ tool: string; args: Readonly<Record<string, unknown>>; approval_required: boolean }>;
  readonly workflow_handle?: string;
  readonly plan_handle?: string;
  readonly details?: Readonly<{
    available: boolean;
    total_items: number;
    returned_items: number;
    tool: string;
    args: Readonly<Record<string, unknown>>;
  }>;
}

export type OperationSummaryInput = Omit<OperationSummaryV1, "contract">;

export function createOperationSummary(
  input: OperationSummaryInput,
  options: Readonly<{ budget?: Extract<ResponseBudgetKind, "normal" | "batch"> }> = {},
): OperationSummaryV1 {
  const budget = RESPONSE_BUDGETS[options.budget ?? "normal"];
  const safe = cloneAndFreezePlanData({ ...input, contract: "operation_summary_v1" } as unknown as PlanData) as unknown as OperationSummaryV1;
  let samples = safe.samples ?? [];
  let warnings = safe.warnings ?? [];
  let blockers = safe.blockers ?? [];
  let sourceDocuments = safe.scope?.source_documents ?? [];
  const build = (): OperationSummaryV1 => {
    const scope = safe.scope && (safe.scope.source_documents !== undefined || sourceDocuments.length > 0)
      ? { ...safe.scope, source_documents: sourceDocuments }
      : safe.scope;
    const details = safe.details
      ? {
          ...safe.details,
          available: safe.details.available || blockers.length + samples.length < safe.details.total_items,
          returned_items: blockers.length + samples.length,
        }
      : undefined;
    return cloneAndFreezePlanData({
      ...safe,
      ...(scope ? { scope } : {}),
      ...(safe.samples !== undefined ? { samples } : {}),
      ...(safe.warnings !== undefined ? { warnings } : {}),
      ...(safe.blockers !== undefined ? { blockers } : {}),
      ...(details ? { details } : {}),
      contract: "operation_summary_v1",
    } as unknown as PlanData) as unknown as OperationSummaryV1;
  };
  let summary = build();
  while (mcpPayloadBytes(summary) > budget.target) {
    if (samples.length > 0) samples = samples.slice(0, -1);
    else if (warnings.length > 0) warnings = warnings.slice(0, -1);
    else if (sourceDocuments.length > 0) sourceDocuments = sourceDocuments.slice(0, -1);
    else if (blockers.length > 1) blockers = blockers.slice(0, -1);
    else break;
    summary = build();
  }
  if (mcpPayloadBytes(summary) > budget.hard) throw new ResponseBudgetError();
  return summary;
}
