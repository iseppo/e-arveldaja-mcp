/**
 * Workflow trace harness — a small, pure model of the cross-cutting approval
 * invariants every MUTATING e-arveldaja workflow must satisfy, plus a checker
 * that reports violations over an ordered event list.
 *
 * This is a PROOF harness, not a runtime. It does not perform mutations; it
 * models the real contract shapes (plan-store handles + domains/scope from
 * `plan-store.ts`, the advertised MCP tool surface, receipt approved-manifest
 * bindings, Wise ownership/digest bindings) as stable IDs so the safety-invariant
 * tests can assert that a trace which violates an invariant is caught and a
 * well-formed trace passes.
 *
 * Stable IDs modeled (all opaque strings so a test can bind them to real values):
 * - workflow: the plan-store domain / workflow identity (e.g. `camt_import`).
 * - tool:     the advertised MCP tool id (e.g. `import_camt053`).
 * - plan handle: the one-attempt execution-plan handle (`plan-store.ts`).
 * - manifest: the integrity binding a dry run returned (receipt `approved_manifest`,
 *             Wise `approved_command_digest`).
 * - source:   a previewed/mutated subject id (CAMT entry, transaction, transfer,
 *             receipt file, supplier identity).
 */

export type WorkflowId = string;
export type ToolId = string;
export type PlanHandleId = string;
export type ManifestId = string;
export type SourceId = string;

/** What a dry run previewed and what a matching approval must cover. */
export interface PlanPreview {
  /** Plan-store domain the handle belongs to. */
  readonly domain: string;
  /** Mutation categories the preview authorizes (create/confirm/…). */
  readonly categories: readonly string[];
  /** GL/bank accounts the preview touches. */
  readonly accounts: readonly string[];
  /** The exact subject ids the preview enumerated. */
  readonly sources: readonly SourceId[];
  /** Optional integrity binding (receipt manifest / Wise digest). */
  readonly manifest?: ManifestId;
}

export interface ApprovalScope extends PlanPreview {
  readonly workflow: WorkflowId;
  /** The plan handle the operator approved. Approval never floats free of a handle. */
  readonly planHandle: PlanHandleId;
}

export interface PromptEvent {
  readonly type: "PROMPT";
  readonly workflow: WorkflowId;
  /** The tool surface advertised for this workflow in this session. */
  readonly advertisedTools: readonly ToolId[];
}

export interface ToolCallEvent {
  readonly type: "TOOL_CALL";
  readonly workflow: WorkflowId;
  readonly tool: ToolId;
}

export interface ToolResultEvent {
  readonly type: "TOOL_RESULT";
  readonly workflow: WorkflowId;
  readonly tool: ToolId;
  /** A dry run that issued a one-attempt plan handle. */
  readonly issuesPlanHandle?: PlanHandleId;
  /** The scope the issued handle previewed. */
  readonly planPreview?: PlanPreview;
  /** A handle that has been expired / drifted / otherwise invalidated. */
  readonly invalidatesPlanHandle?: PlanHandleId;
}

export interface UserApprovalEvent {
  readonly type: "USER_APPROVAL";
  readonly workflow: WorkflowId;
  readonly scope: ApprovalScope;
}

export interface MutationEvent {
  readonly type: "MUTATION";
  readonly workflow: WorkflowId;
  readonly tool: ToolId;
  readonly domain: string;
  /** The handle presented at execute time (consumed once). */
  readonly planHandle: PlanHandleId;
  readonly manifest?: ManifestId;
  readonly category: string;
  readonly account: string;
  /** The subject ids actually mutated. */
  readonly sources: readonly SourceId[];
}

export type WorkflowTraceEvent =
  | PromptEvent
  | ToolCallEvent
  | ToolResultEvent
  | UserApprovalEvent
  | MutationEvent;

export type WorkflowInvariant =
  | "mutation_requires_prior_approval"
  | "tool_must_be_advertised"
  | "mutation_within_approved_scope"
  | "scope_change_requires_new_preview"
  | "stale_or_replayed_handle";

export interface WorkflowTraceViolation {
  readonly invariant: WorkflowInvariant;
  readonly eventIndex: number;
  readonly workflow: WorkflowId;
  readonly tool: ToolId;
  readonly detail: string;
}

type HandleState = {
  issuedAt: number;
  consumedAt: number | undefined;
  invalidatedAt: number | undefined;
};

function isSubset(candidate: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return candidate.every(value => allowedSet.has(value));
}

/**
 * Check an ordered workflow trace against the five approval invariants. Returns
 * one violation per broken rule per offending event (empty when well-formed).
 */
export function checkWorkflowTrace(
  events: readonly WorkflowTraceEvent[],
): readonly WorkflowTraceViolation[] {
  const violations: WorkflowTraceViolation[] = [];

  // Advertised tool surface per workflow, taken from that workflow's PROMPT.
  const advertisedByWorkflow = new Map<WorkflowId, ReadonlySet<ToolId>>();
  for (const event of events) {
    if (event.type === "PROMPT") {
      advertisedByWorkflow.set(event.workflow, new Set(event.advertisedTools));
    }
  }

  const handleStates = new Map<PlanHandleId, HandleState>();

  events.forEach((event, index) => {
    switch (event.type) {
      case "TOOL_RESULT": {
        if (event.issuesPlanHandle !== undefined) {
          const existing = handleStates.get(event.issuesPlanHandle);
          if (existing === undefined) {
            handleStates.set(event.issuesPlanHandle, {
              issuedAt: index,
              consumedAt: undefined,
              invalidatedAt: undefined,
            });
          }
        }
        if (event.invalidatesPlanHandle !== undefined) {
          const state = handleStates.get(event.invalidatesPlanHandle);
          if (state && state.invalidatedAt === undefined) state.invalidatedAt = index;
        }
        return;
      }
      case "TOOL_CALL": {
        checkAdvertised(event.workflow, event.tool, index);
        return;
      }
      case "MUTATION": {
        checkAdvertised(event.workflow, event.tool, index);
        checkHandleLiveness(event, index);
        const approval = findCoveringApproval(event, index);
        if (!approval) {
          push("mutation_requires_prior_approval", event, index,
            "no prior USER_APPROVAL is bound to the presented plan handle (a plan handle is not approval)");
        } else {
          checkScope(event, approval, index);
        }
        // Consume the handle (once) after evaluation so a replay is caught next time.
        const state = handleStates.get(event.planHandle);
        if (state && state.consumedAt === undefined) state.consumedAt = index;
        return;
      }
      default:
        return;
    }
  });

  return violations;

  function push(
    invariant: WorkflowInvariant,
    event: { workflow: WorkflowId; tool?: ToolId },
    eventIndex: number,
    detail: string,
  ): void {
    violations.push({
      invariant,
      eventIndex,
      workflow: event.workflow,
      tool: event.tool ?? "",
      detail,
    });
  }

  function checkAdvertised(workflow: WorkflowId, tool: ToolId, index: number): void {
    const advertised = advertisedByWorkflow.get(workflow);
    if (!advertised || !advertised.has(tool)) {
      push("tool_must_be_advertised", { workflow, tool }, index,
        `tool ${tool} is not advertised in the ${workflow} surface`);
    }
  }

  function checkHandleLiveness(event: MutationEvent, index: number): void {
    const state = handleStates.get(event.planHandle);
    if (!state || state.issuedAt >= index) {
      push("stale_or_replayed_handle", event, index,
        `plan handle ${event.planHandle} was not issued before this mutation (early execute or unknown handle)`);
      return;
    }
    if (state.consumedAt !== undefined && state.consumedAt < index) {
      push("stale_or_replayed_handle", event, index,
        `plan handle ${event.planHandle} was already consumed (replay)`);
      return;
    }
    if (state.invalidatedAt !== undefined && state.invalidatedAt < index) {
      push("stale_or_replayed_handle", event, index,
        `plan handle ${event.planHandle} was invalidated (expired/drifted) before this mutation`);
    }
  }

  function findCoveringApproval(event: MutationEvent, index: number): ApprovalScope | undefined {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = events[i]!;
      if (candidate.type !== "USER_APPROVAL") continue;
      if (candidate.scope.workflow === event.workflow && candidate.scope.planHandle === event.planHandle) {
        return candidate.scope;
      }
    }
    return undefined;
  }

  function checkScope(event: MutationEvent, approval: ApprovalScope, index: number): void {
    if (event.domain !== approval.domain) {
      push("mutation_within_approved_scope", event, index,
        `mutation domain ${event.domain} differs from approved domain ${approval.domain}`);
    }
    if (event.manifest !== approval.manifest) {
      push("mutation_within_approved_scope", event, index,
        "mutation manifest does not match the approved manifest/digest binding");
    }
    if (!approval.categories.includes(event.category)) {
      push("scope_change_requires_new_preview", event, index,
        `category ${event.category} is outside the approved plan — a new preview is required`);
    }
    if (!approval.accounts.includes(event.account)) {
      push("scope_change_requires_new_preview", event, index,
        `account ${event.account} is outside the approved plan — a new preview is required`);
    }
    if (!isSubset(event.sources, approval.sources)) {
      push("scope_change_requires_new_preview", event, index,
        "mutation subject ids exceed the approved subset — a new preview is required");
    }
  }
}
