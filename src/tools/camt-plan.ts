import {
  runPlanCommands,
  type MutateCommandResult,
  type PlanExecutionReport,
  type PrepareCommandResult,
} from "../plan-execution.js";
import type { ExecutionPlanInput, PlanData, PlanRecord } from "../plan-store.js";

// The plan domain string that binds a reviewed CAMT dry run to its execute.
// It is distinct from the file-reference operation discriminator "camt_input".
export const CAMT_PLAN_DOMAIN = "camt_import";
export const CAMT_CREATE_CATEGORY = "camt_create_transaction";

/** Stable, position-derived command id. Deterministic across dry run and execute. */
export function camtPlanCommandId(index: number): string {
  return `camt-create-${index}`;
}

/**
 * Recursively drop `undefined` values and sort object keys so a value's JSON
 * form is stable and undefined-insensitive. Used for the drift fingerprint and
 * to make records safe to hand to the execution-plan store (which rejects
 * `undefined`).
 */
export function stripUndefinedDeep(value: unknown): PlanData {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(item => stripUndefinedDeep(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, PlanData> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) continue;
      result[key] = stripUndefinedDeep(child);
    }
    return result;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" || typeof value === "boolean") return value;
  // Fall back to a stable placeholder for anything non-plan-data.
  return null;
}

/** Canonical JSON with sorted keys and no `undefined`, for drift comparison. */
export function canonicalPlanJson(value: unknown): string {
  return JSON.stringify(stripUndefinedDeep(value));
}

export interface CamtPlanReviewCommand {
  readonly id: string;
  readonly category: string;
  readonly reviewProjection: PlanData;
}

export interface BuildCamtExecutionPlanInputArgs {
  readonly normalizedArgs: PlanRecord;
  readonly sourceIdentity: PlanRecord;
  readonly statementIban: string;
  readonly reviewCommands: readonly CamtPlanReviewCommand[];
  readonly fingerprint: string;
  readonly counts: PlanRecord;
  readonly totals: PlanRecord;
  readonly exclusions: readonly PlanData[];
  readonly reviews: readonly PlanData[];
}

/**
 * PLANNER: assemble the immutable execution-plan input for a reviewed CAMT
 * import. The drift `fingerprint` is kept in `privatePayload`, stripped from
 * every public/inspect view, so the review page cannot leak it.
 */
export function buildCamtExecutionPlanInput(args: BuildCamtExecutionPlanInputArgs): ExecutionPlanInput {
  return {
    normalizedArgs: args.normalizedArgs,
    sourceIdentities: [args.sourceIdentity],
    liveSnapshot: { statement_iban: args.statementIban },
    commands: args.reviewCommands.map(command => ({
      id: command.id,
      category: command.category,
      reviewProjection: command.reviewProjection,
    })),
    counts: args.counts,
    totals: args.totals,
    exclusions: args.exclusions,
    reviews: args.reviews,
    privatePayload: { fingerprint: args.fingerprint },
  };
}

/**
 * EXECUTOR: drive the reviewed CAMT commands through the shared plan-execution
 * tracker with stable ids. `prepareIndex` rechecks a command's preconditions
 * immediately before its mutate; the tracker stops at the first drift, failure,
 * or indeterminate outcome.
 */
export async function executeCamtCommands(args: {
  readonly count: number;
  readonly prepareIndex: (index: number) => Promise<PrepareCommandResult>;
  readonly mutateIndex: (index: number) => Promise<MutateCommandResult>;
}): Promise<PlanExecutionReport> {
  const commands = Array.from({ length: args.count }, (_, index) => ({
    id: camtPlanCommandId(index),
    category: CAMT_CREATE_CATEGORY,
    known_object_limit: 1,
  }));
  return runPlanCommands({
    commands,
    prepare: (_command, index) => args.prepareIndex(index),
    mutate: (_command, index) => args.mutateIndex(index),
  });
}
