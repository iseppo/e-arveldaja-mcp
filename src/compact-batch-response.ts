import type { OperationSummaryStatus } from "./operation-summary.js";
import { createOperationSummary } from "./operation-summary.js";
import type { CompactReviewItem } from "./operation-outcome.js";
import { sandboxExternalText } from "./external-text-renderer.js";

export interface BatchItem {
  readonly item_id: string;
  readonly status: "completed" | "blocked" | "review";
  readonly code?: string;
  readonly message?: string;
  readonly priority?: number;
  readonly [key: string]: unknown;
}

export function partitionBatchItems<T extends BatchItem>(items: readonly T[]): Readonly<{
  completed: readonly T[];
  blocked: readonly T[];
  review: readonly T[];
}> {
  const completed: T[] = [];
  const blocked: T[] = [];
  const review: T[] = [];
  for (const item of items) {
    if (item.status === "completed") completed.push(item);
    else if (item.status === "blocked") blocked.push(item);
    else review.push(item);
  }
  return Object.freeze({ completed: Object.freeze(completed), blocked: Object.freeze(blocked), review: Object.freeze(review) });
}

function reviewItem(item: BatchItem, severity: CompactReviewItem["severity"]): CompactReviewItem {
  return Object.freeze({ item_id: item.item_id, code: item.code ?? item.status, message: sandboxExternalText(item.message ?? item.status), severity });
}

export function buildCompactBatchResponse(input: {
  readonly status: OperationSummaryStatus;
  readonly message: string;
  readonly operation_handle: string;
  readonly items: readonly BatchItem[];
}): Readonly<{ summary: ReturnType<typeof createOperationSummary> }> {
  const partition = partitionBatchItems(input.items);
  const blockers = [...partition.blocked]
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || (left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0))
    .map(item => reviewItem(item, "blocker"));
  const samples = [...partition.completed, ...partition.review]
    .slice(0, 3)
    .map(item => reviewItem(item, "warning"));
  return Object.freeze({ summary: createOperationSummary({
    status: input.status,
    message: input.message,
    counts: { total: input.items.length, completed: partition.completed.length, blocked: partition.blocked.length, review: partition.review.length },
    blockers,
    samples: [...samples],
    details: {
      available: input.items.length > blockers.length + samples.length,
      total_items: input.items.length,
      returned_items: blockers.length + samples.length,
      tool: "get_operation_result_page",
      args: { operation_handle: input.operation_handle },
    },
  }, { budget: "batch", measureEnvelope: "summary" }) });
}
