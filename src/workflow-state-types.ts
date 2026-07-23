export type WorkflowStateStatus =
  | "in_progress" | "needs_input" | "needs_review" | "ready_for_approval" | "completed";

export type PublicWorkflowScalar = string | number | boolean | null;
export interface PublicWorkflowRecord { readonly [key: string]: PublicWorkflowValue }
export type PublicWorkflowValue =
  | PublicWorkflowScalar | readonly PublicWorkflowScalar[] | PublicWorkflowRecord;
