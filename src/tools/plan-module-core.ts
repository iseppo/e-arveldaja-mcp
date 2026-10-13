import {
  runPlanCommands,
  type MutateCommandResult,
  type PlanExecutionReport,
  type PrepareCommandResult,
} from "../plan-execution.js";
import type { ExecutionPlanInput, PlanData, PlanRecord } from "../plan-store.js";

// Domain-neutral core shared by the per-domain plan modules (camt-plan,
// bank-reconciliation-plan, lightyear-plan). Each of those keeps its own plan
// domain strings, command categories, and command-id formats; only the plan
// input assembly and the spec-list executor, which were identical, live here.

export interface PlanReviewCommand {
  readonly id: string;
  readonly category: string;
  readonly reviewProjection: PlanData;
}

export interface BuildExecutionPlanInputArgs {
  readonly normalizedArgs: PlanRecord;
  readonly sourceIdentities: readonly PlanRecord[];
  readonly liveSnapshot: PlanData;
  readonly reviewCommands: readonly PlanReviewCommand[];
  readonly fingerprint: string;
  readonly counts: PlanRecord;
  readonly totals: PlanRecord;
  readonly exclusions: readonly PlanData[];
  readonly reviews: readonly PlanData[];
}

/**
 * PLANNER: assemble the immutable execution-plan input for a reviewed dry run.
 * The drift `fingerprint` is kept in `privatePayload`, stripped from every
 * public/inspect view so the review page cannot leak it.
 */
export function buildExecutionPlanInput(args: BuildExecutionPlanInputArgs): ExecutionPlanInput {
  return {
    normalizedArgs: args.normalizedArgs,
    sourceIdentities: args.sourceIdentities,
    liveSnapshot: args.liveSnapshot,
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
 * EXECUTOR command spec. `prepare` rechecks this command's preconditions against
 * a fresh read immediately before its own `mutate`; the tracker stops at the
 * first drift, failure, or indeterminate outcome.
 */
export interface PlanExecutionCommandSpec {
  readonly id: string;
  readonly category: string;
  readonly known_object_limit?: number;
  readonly prepare: () => Promise<PrepareCommandResult>;
  readonly mutate: () => Promise<MutateCommandResult>;
}

/**
 * EXECUTOR: drive the reviewed commands through the shared plan-execution
 * tracker in the exact enumerated order. The plan-data command list handed to
 * the tracker carries no closures; `prepare`/`mutate` dispatch by position into
 * the spec list.
 */
export async function executePlanCommandSpecs(
  commands: readonly PlanExecutionCommandSpec[],
): Promise<PlanExecutionReport> {
  return runPlanCommands({
    commands: commands.map(command => ({
      id: command.id,
      category: command.category,
      ...(command.known_object_limit !== undefined ? { known_object_limit: command.known_object_limit } : {}),
    })),
    prepare: (_command, index) => commands[index]!.prepare(),
    mutate: (_command, index) => commands[index]!.mutate(),
  });
}
