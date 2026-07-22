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

export type OperationOutcome<T> =
  | Readonly<{ ok: true; value: T; warnings: readonly CompactWarning[]; blockers: readonly CompactReviewItem[] }>
  | Readonly<{ ok: false; error: Readonly<{ code: string; message: string; retry: "never" | "safe" | "unknown" }>; blockers: readonly CompactReviewItem[] }>;

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
): OperationOutcome<T> {
  return cloneAndFreezePlanData({ ok: false, error: { code, message, retry }, blockers } as unknown as PlanData) as unknown as OperationOutcome<T>;
}
import { cloneAndFreezePlanData, type PlanData } from "./plan-store.js";
