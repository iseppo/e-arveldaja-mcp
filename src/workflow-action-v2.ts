import { arrayAt, isRecord, stringAt } from "./record-utils.js";
import {
  currentToolProfile,
  isToolVisibleForProfile,
  projectActionForCurrentProfile,
} from "./tool-profile.js";
import type { WorkflowAction, WorkflowEnvelope } from "./workflow-response.js";
import type { PublicWorkflowStateDetail, WorkflowStateStore } from "./workflow-state-store.js";
import type { WorkflowStateStatus } from "./workflow-state-types.js";

const WORKFLOW_PAGE_TOOL = "get_workflow_page" as const;
const SETUP_FALLBACK_TOOL = "get_setup_instructions" as const;

export interface WorkflowActionV2NextAction {
  tool: string;
  args: Record<string, unknown>;
  approval_required: boolean;
}
export interface WorkflowActionV2Blocker {
  item_id: string;
  code: string;
  message: string;
  severity: "warning" | "blocker";
}
export interface WorkflowActionV2Page {
  available: boolean;
  total_items: number;
  tool: typeof WORKFLOW_PAGE_TOOL;
  args: Record<string, unknown>;
}
export interface WorkflowActionV2 {
  contract: "workflow_action_v2";
  status: WorkflowStateStatus;
  message: string;
  next_action: WorkflowActionV2NextAction;
  alternative_action_count: number;
  blockers: WorkflowActionV2Blocker[];
  // Present ONLY when the response carries pageable detail state. An item-less
  // response mints no handle, so a stream of item-less guided responses can no
  // longer fill the workflow-state store (§12).
  workflow_handle?: string;
  page?: WorkflowActionV2Page;
}

export interface BuildWorkflowActionV2Options {
  readonly workflow?: string;
  readonly items?: readonly PublicWorkflowStateDetail[];
  readonly message?: string;
}

// The v1 envelope has no explicit status: derive the compact workflow-state
// status. A guided fail-closed envelope already carries status="needs_review";
// otherwise map from the recommended action's kind.
function deriveStatus(envelope: WorkflowEnvelope): WorkflowStateStatus {
  const explicit = stringAt(envelope as unknown as Record<string, unknown>, "status");
  if (explicit === "needs_review") return "needs_review";
  const kind = envelope.recommended_next_action?.kind;
  switch (kind) {
    case "done": return "completed";
    case "approve_tool_call": return "ready_for_approval";
    case "answer_question": return "needs_input";
    case "review_item": return "needs_review";
    default: return "in_progress";
  }
}

function nextActionFrom(action: WorkflowAction | undefined): WorkflowActionV2NextAction {
  const projected = projectActionForCurrentProfile({
    tool: typeof action?.tool === "string" ? action.tool : "",
    args: action?.args ?? {},
    approval_required: action?.approval_required === true,
  });
  if (typeof projected.tool === "string" && projected.tool.length > 0) {
    return {
      tool: projected.tool,
      args: isRecord(projected.args) ? projected.args : {},
      approval_required: projected.approval_required === true,
    };
  }
  // Fail-closed projection: the only executable next action is the setup fallback.
  const fallback = Array.isArray(projected.next_actions) ? projected.next_actions[0] : undefined;
  if (fallback && typeof fallback.tool === "string") {
    return {
      tool: fallback.tool,
      args: isRecord(fallback.args) ? fallback.args : {},
      approval_required: fallback.approval_required === true,
    };
  }
  return { tool: SETUP_FALLBACK_TOOL, args: {}, approval_required: false };
}

function blockerFrom(item: unknown): WorkflowActionV2Blocker {
  const record = isRecord(item) ? item : {};
  const severity = stringAt(record, "severity");
  return {
    item_id: stringAt(record, "item_id") ?? stringAt(record, "id") ?? "",
    code: stringAt(record, "code") ?? "review_required",
    message: stringAt(record, "message") ?? stringAt(record, "summary") ?? "A review item needs accounting judgement before execution.",
    severity: severity === "warning" ? "warning" : "blocker",
  };
}

/**
 * Compact, guided-only projection of a v1 workflow envelope. Emits exactly one
 * next_action (routed through the same profile projection v1 uses, so a
 * fail-closed advanced action stays fail-closed), a numeric count of the
 * remaining alternatives instead of the full array, blockers derived from
 * needs_review, and — only when there is pageable detail state — an opaque
 * server-owned workflow_handle. An item-less response mints no handle and takes
 * no store slot, so a stream of item-less guided responses cannot fill the
 * workflow-state store (§12). The optional page reference is only actionable
 * where get_workflow_page is visible in the active profile; otherwise it stays
 * latent (available:false, no handle) so the envelope never points at a tool the
 * caller cannot invoke.
 */
export function buildWorkflowActionV2(
  envelope: WorkflowEnvelope,
  store: WorkflowStateStore,
  options: BuildWorkflowActionV2Options = {},
): WorkflowActionV2 {
  const status = deriveStatus(envelope);
  const items = options.items ?? [];
  // Mint a workflow-state handle ONLY when there is pageable detail state. Every
  // guided workflow response used to mint a fresh 30-minute handle even with zero
  // pageable items, so ~128 rapid item-less calls could fill the store and start
  // returning capacity errors. An item-less response now carries no handle, takes
  // no store slot, and needs none — there is nothing to page (§12).
  const hasPageableItems = items.length > 0;
  const workflowHandle = hasPageableItems
    ? store.issue({ workflow: options.workflow ?? "accounting_inbox", status, items })
    : undefined;
  // Read collection/text fields defensively: a guided continue_accounting_workflow
  // envelope can be derived from user-supplied workflow_state_json and may lack
  // needs_review / summary entirely, so never dereference them non-defensively.
  const record = envelope as unknown as Record<string, unknown>;
  const availableActions = arrayAt(record, "available_actions");
  const v2: WorkflowActionV2 = {
    contract: "workflow_action_v2",
    status,
    message: options.message ?? stringAt(record, "summary") ?? "",
    next_action: nextActionFrom(envelope.recommended_next_action),
    alternative_action_count: Math.max(0, availableActions.length - 1),
    blockers: arrayAt(record, "needs_review").map(blockerFrom),
  };
  if (workflowHandle !== undefined) {
    v2.workflow_handle = workflowHandle;
    const visible = isToolVisibleForProfile(WORKFLOW_PAGE_TOOL, currentToolProfile());
    v2.page = {
      available: visible,
      total_items: items.length,
      tool: WORKFLOW_PAGE_TOOL,
      args: visible ? { workflow_handle: workflowHandle } : {},
    };
  }
  return v2;
}
