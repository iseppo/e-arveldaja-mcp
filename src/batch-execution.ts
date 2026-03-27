export type BatchExecutionMode = "DRY_RUN" | "EXECUTED";

export interface BatchAuditReference {
  review_tool: "get_session_log";
  list_tool: "list_audit_logs";
  format: "human_readable_markdown";
  location: "logs/<company-name>[ (<connection-name>)].audit.md";
  note: string;
}

export interface BatchExecutionContract<
  TResult = unknown,
  TSkipped = unknown,
  TError = unknown,
  TNeedsReview = unknown,
> {
  contract: "batch_execution_v1";
  mode: BatchExecutionMode;
  summary: Record<string, unknown>;
  results: TResult[];
  skipped: TSkipped[];
  errors: TError[];
  needs_review: TNeedsReview[];
  audit_reference: BatchAuditReference;
}

const DEFAULT_AUDIT_REFERENCE: BatchAuditReference = {
  review_tool: "get_session_log",
  list_tool: "list_audit_logs",
  format: "human_readable_markdown",
  location: "logs/<company-name>[ (<connection-name>)].audit.md",
  note: "Review mutating side effects in the human-readable audit log named after the company when available; a connection suffix is added only when needed to disambiguate.",
};

export function buildBatchExecutionContract<
  TResult = unknown,
  TSkipped = unknown,
  TError = unknown,
  TNeedsReview = unknown,
>(args: {
  mode: BatchExecutionMode;
  summary: Record<string, unknown>;
  results: TResult[];
  skipped?: TSkipped[];
  errors?: TError[];
  needs_review?: TNeedsReview[];
}): BatchExecutionContract<TResult, TSkipped, TError, TNeedsReview> {
  return {
    contract: "batch_execution_v1",
    mode: args.mode,
    summary: args.summary,
    results: args.results,
    skipped: args.skipped ?? [],
    errors: args.errors ?? [],
    needs_review: args.needs_review ?? [],
    audit_reference: DEFAULT_AUDIT_REFERENCE,
  };
}
