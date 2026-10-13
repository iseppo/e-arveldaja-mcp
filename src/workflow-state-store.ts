import { cloneAndFreezePlanData, cloneRuntimeSafetyScope, runtimeSafetyScopesEqual, type PlanData } from "./plan-store.js";
import {
  createPublicDetailKit,
  PublicDetailHandleStore,
  readExactInputRecord,
  type PublicDetailInput,
} from "./public-detail-store.js";
import type { RuntimeSafetyScope } from "./runtime-safety-context.js";
import type {
  PublicWorkflowRecord,
  WorkflowStateStatus,
} from "./workflow-state-types.js";

export type {
  PublicWorkflowRecord,
  PublicWorkflowScalar,
  PublicWorkflowValue,
  WorkflowStateStatus,
} from "./workflow-state-types.js";

// A workflow handle carries inert, server-owned state between continuation
// calls of an in-progress workflow. Unlike the operation-result store it has NO
// plan-consumption gate: handles are issued MID-workflow, before any plan is
// even proposed, so there is no plan proof, no plan handle, and no mutation
// authority. TTL is sized for a multi-step (multi-turn) workflow rather than a
// single tool call, but capacity/tombstone bounds and every fail-closed
// rejection are identical to the operation-result store.
export const WORKFLOW_STATE_TTL_MS = 1_800_000;
export const MAX_ACTIVE_WORKFLOW_STATES = 128;
export const MAX_WORKFLOW_STATE_TOMBSTONES = 512;
const WORKFLOW_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const WORKFLOW_STATE_STATUSES: readonly WorkflowStateStatus[] = [
  "in_progress", "needs_input", "needs_review", "ready_for_approval", "completed",
];

export type PublicWorkflowStateDetailInput = PublicDetailInput;
export interface PublicWorkflowStateDetail {
  readonly contract: "workflow_state_detail_v1";
  readonly data: PublicWorkflowRecord;
}
export interface WorkflowStateInput {
  readonly workflow: string;
  readonly status: WorkflowStateStatus;
  readonly items: readonly PublicWorkflowStateDetail[];
}
export interface StoredWorkflowState {
  readonly workflow: string;
  readonly status: WorkflowStateStatus;
  readonly items: readonly PlanData[];
  readonly scope: RuntimeSafetyScope;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export type WorkflowStateStoreErrorCode =
  | "workflow_state_capacity_exceeded" | "workflow_state_handle_invalid" | "workflow_state_expired"
  | "workflow_state_scope_mismatch" | "workflow_state_data_invalid" | "workflow_state_handle_collision"
  | "workflow_state_item_too_large";

const MESSAGES: Readonly<Record<WorkflowStateStoreErrorCode, string>> = Object.freeze({
  workflow_state_capacity_exceeded: "The workflow-state store is full. Wait for a state to expire.",
  workflow_state_handle_invalid: "The workflow-state handle is invalid or unknown.",
  workflow_state_expired: "The workflow-state handle has expired.",
  workflow_state_scope_mismatch: "The workflow-state handle no longer matches the active runtime scope.",
  workflow_state_data_invalid: "The workflow state contains unsafe or oversized data.",
  workflow_state_handle_collision: "Unable to allocate a unique workflow-state handle.",
  workflow_state_item_too_large: "A single workflow-state detail is too large to page within the response budget.",
});

export class WorkflowStateStoreError extends Error {
  constructor(readonly code: WorkflowStateStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = "WorkflowStateStoreError";
  }
}

export interface WorkflowStateStoreOptions {
  readonly getActiveScope: () => RuntimeSafetyScope;
  readonly now?: () => number;
  readonly handleFactory?: () => Uint8Array;
  readonly ttlMs?: number;
  readonly maxActive?: number;
  readonly maxTombstones?: number;
}

function invalid(): never { throw new WorkflowStateStoreError("workflow_state_data_invalid"); }

// Module-private brand: only details created here are accepted by this store
// (an operation-result detail is rejected, and vice versa).
const detailKit = createPublicDetailKit("workflow_state_detail_v1", invalid, cloneAndFreezePlanData);

export function createPublicWorkflowStateDetail(
  data: PublicWorkflowStateDetailInput,
): PublicWorkflowStateDetail {
  return detailKit.create(data);
}

function readWorkflowStateInput(candidate: unknown): WorkflowStateInput {
  const values = readExactInputRecord(candidate, ["workflow", "status", "items"], invalid);
  if (typeof values.workflow !== "string" || !WORKFLOW_PATTERN.test(values.workflow) ||
    typeof values.status !== "string" || !WORKFLOW_STATE_STATUSES.includes(values.status as WorkflowStateStatus) ||
    !Array.isArray(values.items)) invalid();
  return values as unknown as WorkflowStateInput;
}

export class WorkflowStateStore {
  readonly #store: PublicDetailHandleStore<StoredWorkflowState>;

  constructor(options: WorkflowStateStoreOptions) {
    this.#store = new PublicDetailHandleStore<StoredWorkflowState>(options, {
      defaultTtlMs: WORKFLOW_STATE_TTL_MS,
      defaultMaxActive: MAX_ACTIVE_WORKFLOW_STATES,
      defaultMaxTombstones: MAX_WORKFLOW_STATE_TOMBSTONES,
      error: kind => new WorkflowStateStoreError(`workflow_state_${kind}`),
      detail: detailKit,
      cloneAndFreezeData: value => cloneAndFreezePlanData(value) as readonly PlanData[],
      cloneScope: cloneRuntimeSafetyScope,
      scopesEqual: runtimeSafetyScopesEqual,
    });
  }

  get activeCount(): number { return this.#store.activeCount; }

  issue(input: WorkflowStateInput): string {
    const safeInput = readWorkflowStateInput(input);
    return this.#store.issue(safeInput.items, ({ items, scope, issuedAt, expiresAt }) => Object.freeze({
      workflow: safeInput.workflow, status: safeInput.status, items, scope, issuedAt, expiresAt,
    }));
  }

  inspect(handle: string): StoredWorkflowState {
    return this.#store.inspect(handle);
  }
}
