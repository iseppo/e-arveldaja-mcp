import { cloneAndFreezePlanData, type PlanData } from "./plan-store.js";
import type { CompactReviewItem, CompactWarning } from "./operation-outcome.js";

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
    period?: Readonly<{ from: string; to: string }>;
    source_documents?: number;
  }>;
  readonly warnings?: readonly CompactWarning[];
  readonly blockers?: readonly CompactReviewItem[];
  readonly samples?: readonly CompactReviewItem[];
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

export function createOperationSummary(input: OperationSummaryInput): OperationSummaryV1 {
  return cloneAndFreezePlanData({ ...input, contract: "operation_summary_v1" } as unknown as PlanData) as unknown as OperationSummaryV1;
}
