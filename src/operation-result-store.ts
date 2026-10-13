import { cloneAndFreezePlanData, cloneRuntimeSafetyScope, runtimeSafetyScopesEqual, type PlanData } from "./plan-store.js";
import {
  createPublicDetailKit,
  PublicDetailHandleStore,
  readExactInputRecord,
  type PublicDetailInput,
  type PublicDetailRecord,
  type PublicDetailScalar,
  type PublicDetailValue,
} from "./public-detail-store.js";
import type { RuntimeSafetyScope } from "./runtime-safety-context.js";

export const OPERATION_RESULT_TTL_MS = 600_000;
export const MAX_ACTIVE_OPERATION_RESULTS = 128;
export const MAX_OPERATION_RESULT_TOMBSTONES = 512;
const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

export type OperationResultStatus = "completed" | "partial" | "indeterminate";
export type PublicResultScalar = PublicDetailScalar;
export type PublicResultRecord = PublicDetailRecord;
export type PublicResultValue = PublicDetailValue;
export type PublicOperationResultDetailInput = PublicDetailInput;
export interface PublicOperationResultDetail {
  readonly contract: "operation_result_detail_v1";
  readonly data: PublicResultRecord;
}
export interface OperationResultInput {
  readonly operation: string;
  readonly status: OperationResultStatus;
  readonly items: readonly PublicOperationResultDetail[];
  readonly plan_handle: string;
}
export interface StoredOperationResult {
  readonly operation: string;
  readonly status: OperationResultStatus;
  readonly items: readonly PlanData[];
  readonly planHandle: string;
  readonly scope: RuntimeSafetyScope;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export type OperationResultStoreErrorCode =
  | "operation_result_capacity_exceeded" | "operation_result_handle_invalid" | "operation_result_expired"
  | "operation_result_scope_mismatch" | "operation_result_data_invalid" | "operation_result_handle_collision"
  | "operation_result_item_too_large";

const MESSAGES: Readonly<Record<OperationResultStoreErrorCode, string>> = Object.freeze({
  operation_result_capacity_exceeded: "The operation-result store is full. Wait for a result to expire.",
  operation_result_handle_invalid: "The operation-result handle is invalid or unknown.",
  operation_result_expired: "The operation-result handle has expired.",
  operation_result_scope_mismatch: "The operation-result handle no longer matches the active runtime scope.",
  operation_result_data_invalid: "The operation result contains unsafe or oversized data.",
  operation_result_handle_collision: "Unable to allocate a unique operation-result handle.",
  operation_result_item_too_large: "A single operation-result detail is too large to page within the response budget.",
});

export class OperationResultStoreError extends Error {
  constructor(readonly code: OperationResultStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = "OperationResultStoreError";
  }
}

export interface OperationResultStoreOptions {
  readonly getActiveScope: () => RuntimeSafetyScope;
  readonly now?: () => number;
  readonly handleFactory?: () => Uint8Array;
  readonly ttlMs?: number;
  readonly maxActive?: number;
  readonly maxTombstones?: number;
  readonly assertConsumedPlan: (handle: string, domain: string) => void;
  readonly retainConsumedPlan: (handle: string, domain: string) => () => void;
}

function invalid(): never { throw new OperationResultStoreError("operation_result_data_invalid"); }

// Module-private brand: only details created here are accepted by this store.
const detailKit = createPublicDetailKit("operation_result_detail_v1", invalid, cloneAndFreezePlanData);

export function createPublicOperationResultDetail(
  data: PublicOperationResultDetailInput,
): PublicOperationResultDetail {
  return detailKit.create(data);
}

function readResultInput(candidate: unknown): OperationResultInput {
  const values = readExactInputRecord(candidate, ["operation", "status", "items", "plan_handle"], invalid);
  if (typeof values.operation !== "string" || !OPERATION_PATTERN.test(values.operation) ||
    typeof values.status !== "string" || !["completed", "partial", "indeterminate"].includes(values.status) ||
    !Array.isArray(values.items) || typeof values.plan_handle !== "string") invalid();
  return values as unknown as OperationResultInput;
}

export class OperationResultStore {
  readonly #store: PublicDetailHandleStore<StoredOperationResult>;

  constructor(options: OperationResultStoreOptions) {
    const assertConsumedPlan = options.assertConsumedPlan;
    const retainConsumedPlan = options.retainConsumedPlan;
    this.#store = new PublicDetailHandleStore<StoredOperationResult>(options, {
      defaultTtlMs: OPERATION_RESULT_TTL_MS,
      defaultMaxActive: MAX_ACTIVE_OPERATION_RESULTS,
      defaultMaxTombstones: MAX_OPERATION_RESULT_TOMBSTONES,
      error: kind => new OperationResultStoreError(`operation_result_${kind}`),
      detail: detailKit,
      cloneAndFreezeData: value => cloneAndFreezePlanData(value) as readonly PlanData[],
      cloneScope: cloneRuntimeSafetyScope,
      scopesEqual: runtimeSafetyScopesEqual,
      // The result is readable only while the plan it reports on stays provably
      // consumed: pin that proof for the handle's lifetime and re-check it on read.
      retainProof: stored => retainConsumedPlan(stored.planHandle, stored.operation),
      assertProof: stored => assertConsumedPlan(stored.planHandle, stored.operation),
    });
  }

  get activeCount(): number { return this.#store.activeCount; }

  issue(input: OperationResultInput): string {
    const safeInput = readResultInput(input);
    return this.#store.issue(safeInput.items, ({ items, scope, issuedAt, expiresAt }) => Object.freeze({
      operation: safeInput.operation, status: safeInput.status, items, planHandle: safeInput.plan_handle, scope, issuedAt, expiresAt,
    }));
  }

  inspect(handle: string): StoredOperationResult {
    return this.#store.inspect(handle);
  }
}
