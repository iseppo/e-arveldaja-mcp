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
  /** Per-effect consume-once handles when one preview authorizes alternative
   * executions (e.g. receipt_batch create vs create_and_confirm). */
  readonly plan_handles?: Readonly<Record<string, string>>;
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
  options: Readonly<{
    budget?: Extract<ResponseBudgetKind, "normal" | "batch">;
    measureEnvelope?: "summary";
    /** Per-code retrieval route for the `warnings_truncated` notice, for codes
     * whose full list is not where the generic hint points (e.g. created rows
     * in the plan `commands`). Same text as the code's `cappedWarnings` hint. */
    warningHints?: Readonly<Record<string, string>>;
  }> = {},
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
    return {
      ...safe,
      ...(scope ? { scope } : {}),
      ...(safe.samples !== undefined ? { samples } : {}),
      ...(safe.warnings !== undefined ? { warnings } : {}),
      ...(safe.blockers !== undefined ? { blockers } : {}),
      ...(details ? { details } : {}),
      contract: "operation_summary_v1",
    };
  };
  const bytes = (summary: OperationSummaryV1): number => mcpPayloadBytes(
    options.measureEnvelope === "summary" ? { summary } : summary,
  );
  let summary = build();
  const rebuild = (): number => {
    summary = build();
    return bytes(summary);
  };
  const maximizeFittingPrefix = (
    length: number,
    minimum: number,
    setLength: (length: number) => void,
  ): boolean => {
    const before = bytes(summary);
    setLength(minimum);
    if (rebuild() > budget.target) {
      // Pruning that does not shrink the summary (a truncation notice larger
      // than what it dropped) is undone, so a summary never grows past the
      // hard limit by pruning and later sections trim the smaller rendering.
      if (bytes(summary) >= before) {
        setLength(length);
        rebuild();
      }
      return false;
    }
    let low = minimum;
    let high = length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      setLength(middle);
      if (rebuild() <= budget.target) low = middle;
      else high = middle - 1;
    }
    setLength(low);
    rebuild();
    return true;
  };
  if (bytes(summary) > budget.target) {
    const allSamples = samples;
    const allWarnings = warnings;
    const allSourceDocuments = sourceDocuments;
    const allBlockers = blockers;
    const fitsAfterSamples = allSamples.length > 0 && maximizeFittingPrefix(allSamples.length, 0, length => { samples = allSamples.slice(0, length); });
    // Warnings are pruned per code, never as a list prefix: every code keeps its
    // first `perCode` items (the largest that fits), `<code>_more` cap notices
    // always survive, and one `warnings_truncated` notice counts what the
    // budget dropped per code, with each code's retrieval route. A long run of
    // one category (90 identical ownership reviews) therefore shrinks before a
    // short one disappears.
    const notice = (code: string): boolean => code.endsWith("_more");
    const groupSizes = new Map<string, number>();
    for (const warning of allWarnings) {
      if (!notice(warning.code)) groupSizes.set(warning.code, (groupSizes.get(warning.code) ?? 0) + 1);
    }
    const largestGroup = Math.max(0, ...groupSizes.values());
    const genericHint = safe.plan_handle !== undefined
      ? `page them with get_execution_plan_page { plan_handle: "${safe.plan_handle}", section: "exclusions" or "reviews", detail: "full" }.`
      : safe.details !== undefined
        ? `page the result with ${safe.details.tool} ${JSON.stringify(safe.details.args)}.`
        : "narrow the request (fewer rows or a shorter period) to list them.";
    const capWarningsPerCode = (perCode: number): void => {
      const kept: CompactWarning[] = [];
      const seen = new Map<string, number>();
      for (const warning of allWarnings) {
        const index = seen.get(warning.code) ?? 0;
        seen.set(warning.code, index + 1);
        if (notice(warning.code) || index < perCode) kept.push(warning);
      }
      const droppedByHint = new Map<string, string[]>();
      for (const [code, size] of groupSizes) {
        if (size <= perCode) continue;
        const hint = options.warningHints?.[code] ?? genericHint;
        droppedByHint.set(hint, [...(droppedByHint.get(hint) ?? []), `${code}: ${size - perCode}`]);
      }
      if (droppedByHint.size > 0) {
        kept.push({
          code: "warnings_truncated",
          message: `Response size budget: more warning(s) not shown. ${[...droppedByHint].map(([hint, dropped]) => `(${dropped.join(", ")}) ${hint}`).join(" ")}`,
        });
      }
      warnings = kept;
    };
    // Sizes are not monotonic in the per-code cap: a code that keeps no item
    // gains a retrieval route in the truncation notice, which can outweigh the
    // item it dropped. So every cap is measured, from the largest down: the
    // first that fits the target wins; otherwise the smallest rendering stays
    // (the unpruned list included) and later sections trim from it.
    const fitWarnings = (): boolean => {
      let smallestSize = bytes(summary);
      let smallestCap = largestGroup;
      for (let perCode = largestGroup - 1; perCode >= 0; perCode -= 1) {
        capWarningsPerCode(perCode);
        const size = rebuild();
        if (size <= budget.target) return true;
        if (size < smallestSize) {
          smallestSize = size;
          smallestCap = perCode;
        }
      }
      if (smallestCap === largestGroup) warnings = allWarnings;
      else capWarningsPerCode(smallestCap);
      rebuild();
      return false;
    };
    const fitsAfterWarnings = fitsAfterSamples || (largestGroup > 0 && fitWarnings());
    const fitsAfterDocuments = fitsAfterWarnings || (allSourceDocuments.length > 0 && maximizeFittingPrefix(allSourceDocuments.length, 0, length => { sourceDocuments = allSourceDocuments.slice(0, length); }));
    if (!fitsAfterDocuments && allBlockers.length > 1) {
      maximizeFittingPrefix(allBlockers.length, 1, length => { blockers = allBlockers.slice(0, length); });
    }
  }
  if (bytes(summary) > budget.hard) throw new ResponseBudgetError();
  return cloneAndFreezePlanData(summary as unknown as PlanData) as unknown as OperationSummaryV1;
}

/**
 * The compact status of an import preview or execute. A preview that writes
 * nothing completes unless something needs review or failed; a preview with
 * writes is ready for approval unless its reviews block approval; an execute
 * is partial when a command failed.
 */
export function compactImportStatus(input: {
  readonly dryRun: boolean;
  readonly zeroWrite: boolean;
  readonly reviews: boolean;
  readonly reviewsBlockApproval: boolean;
  readonly failed: boolean;
}): "needs_review" | "completed" | "ready_for_approval" | "partial" {
  if (input.zeroWrite) return input.reviews || input.failed ? "needs_review" : "completed";
  if (input.dryRun) return input.reviews && input.reviewsBlockApproval ? "needs_review" : "ready_for_approval";
  return input.failed ? "partial" : "completed";
}

/**
 * At most `cap` warnings of one category, followed by one `<code>_more` warning
 * that counts the rest and says where they are listed, so a compact summary
 * never silently drops items past the cap.
 */
export function cappedWarnings(
  code: string,
  items: readonly CompactWarning[],
  moreHint: string,
  cap = 3,
): CompactWarning[] {
  if (items.length <= cap) return [...items];
  return [
    ...items.slice(0, cap),
    { code: `${code}_more`, message: `${items.length - cap} more ${code} item(s) not shown; ${moreHint}` },
  ];
}
