export interface CompactWarning {
  readonly code: string;
  readonly message: string;
  readonly item_id?: string;
}

export interface CompactReviewItem {
  readonly item_id: string;
  readonly code: string;
  readonly message: string;
  readonly severity: "warning" | "blocker";
}

/**
 * A record an operation wrote before it failed. Carries the id so the operator
 * can actually find the orphan — a message alone leaves them searching by hand.
 */
export interface MutatedObject {
  readonly type: string;
  readonly id: number;
}

export interface OperationFailure {
  readonly code: string;
  readonly message: string;
  readonly retry: "never" | "safe" | "unknown";
  /**
   * True when the operation had ALREADY written something when it failed.
   *
   * Failure codes are not self-describing here: `invoice_creation_failed` and
   * `client_rollback_indeterminate` are both raised strictly AFTER a record
   * exists. Façades used to hardcode `mutation_occurred: false` on the generic
   * failure branch, so those responses claimed nothing was written while a
   * draft invoice or an active client sat in e-arveldaja. That claim is the
   * only record the caller gets: the plan handle is burned before validation
   * (one-attempt semantics), so there is no second response to correct it.
   *
   * Omitted means "no known mutation". Sites where a write may have landed
   * without a conclusive response must set mutationMayHaveOccurred instead.
   */
  readonly mutationOccurred?: boolean;
  /** True when a write was attempted but its outcome could not be established. */
  readonly mutationMayHaveOccurred?: boolean;
  readonly mutatedObjects?: readonly MutatedObject[];
}

export type OperationOutcome<T> =
  | Readonly<{ ok: true; value: T; warnings: readonly CompactWarning[]; blockers: readonly CompactReviewItem[] }>
  | Readonly<{ ok: false; error: Readonly<OperationFailure>; blockers: readonly CompactReviewItem[] }>;

/**
 * The single way a façade renders an operation failure. Every field the
 * operation layer knows about the failure survives to the caller: whether a
 * write landed, which records it touched, and whether retrying is safe.
 */
export function failureResponsePayload(error: OperationFailure): Record<string, unknown> {
  return {
    error: error.message,
    category: error.code,
    retry: error.retry,
    mutation_occurred: error.mutationOccurred === true ? true : error.mutationMayHaveOccurred === true ? null : false,
    ...(error.mutationMayHaveOccurred === true ? { mutation_may_have_occurred: true } : {}),
    ...(error.mutatedObjects !== undefined && error.mutatedObjects.length > 0
      ? { mutated_objects: error.mutatedObjects.map(object => ({ type: object.type, id: object.id })) }
      : {}),
  };
}

/**
 * Plain success outcome: no clone, no freeze, empty warnings/blockers. Façade
 * operations whose values carry Maps, Sets, FileInputSource or live api
 * objects use this instead of successOutcome(), whose PlanData clone+freeze
 * would reject or detach them.
 */
export function plainSuccessOutcome<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}

/**
 * Plain failure outcome: no clone, no freeze, empty blockers. `retry` defaults
 * to "never"; mutation fields are added only when present, exactly as in
 * failureOutcome().
 */
export function plainFailureOutcome<T>(
  code: string,
  message: string,
  retry: "never" | "safe" | "unknown" = "never",
  mutation?: Readonly<{ mutationOccurred?: boolean; mutationMayHaveOccurred?: boolean; mutatedObjects?: readonly MutatedObject[] }>,
): OperationOutcome<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retry,
      ...(mutation?.mutationOccurred ? { mutationOccurred: true } : {}),
      ...(mutation?.mutationMayHaveOccurred ? { mutationMayHaveOccurred: true } : {}),
      ...(mutation?.mutatedObjects !== undefined ? { mutatedObjects: mutation.mutatedObjects } : {}),
    },
    blockers: [],
  };
}

export function successOutcome<T>(
  value: T,
  warnings: readonly CompactWarning[] = [],
  blockers: readonly CompactReviewItem[] = [],
): OperationOutcome<T> {
  return cloneAndFreezePlanData({ ok: true, value, warnings, blockers } as unknown as PlanData) as unknown as OperationOutcome<T>;
}

export function failureOutcome<T = never>(
  code: string,
  message: string,
  retry: "never" | "safe" | "unknown",
  blockers: readonly CompactReviewItem[] = [],
  mutation?: Readonly<{ mutationOccurred?: boolean; mutationMayHaveOccurred?: boolean; mutatedObjects?: readonly MutatedObject[] }>,
): OperationOutcome<T> {
  return cloneAndFreezePlanData({
    ok: false,
    error: {
      code,
      message,
      retry,
      ...(mutation?.mutationOccurred ? { mutationOccurred: true } : {}),
      ...(mutation?.mutationMayHaveOccurred ? { mutationMayHaveOccurred: true } : {}),
      ...(mutation?.mutatedObjects !== undefined ? { mutatedObjects: mutation.mutatedObjects } : {}),
    },
    blockers,
  } as unknown as PlanData) as unknown as OperationOutcome<T>;
}
import { cloneAndFreezePlanData, type PlanData } from "./plan-store.js";
