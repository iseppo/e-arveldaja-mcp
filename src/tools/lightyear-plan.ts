import { canonicalPlanJson, stripUndefinedDeep } from "./camt-plan.js";
import {
  type BuildExecutionPlanInputArgs,
  type PlanExecutionCommandSpec,
  type PlanReviewCommand,
} from "./plan-module-core.js";

// Re-export the shared canonicalization helpers so the Lightyear tool can import
// everything plan-related from one module.
export { canonicalPlanJson, stripUndefinedDeep };

// Two distinct plan domains bind a reviewed Lightyear dry run to its execute.
// A trades handle must be rejected for a distributions execute and vice-versa
// (plan_domain_mismatch), so the two booking paths can never be crossed.
export const LIGHTYEAR_TRADES_PLAN_DOMAIN = "lightyear_trades";
export const LIGHTYEAR_DISTRIBUTIONS_PLAN_DOMAIN = "lightyear_distributions";

export const LIGHTYEAR_TRADE_CREATE_CATEGORY = "lightyear_create_trade_journal";
export const LIGHTYEAR_DISTRIBUTION_CREATE_CATEGORY = "lightyear_create_distribution_journal";

/**
 * Stable, position-derived command ids. Deterministic across dry run and
 * execute because the projection enumerates the deduped bookable rows in a
 * fixed order. Position (not the free-form CSV reference) keeps the id inside
 * the plan store's command-id character set and immune to reference injection.
 */
export function lightyearTradeCommandId(index: number): string {
  return `ly-trade-${index}`;
}
export function lightyearDistributionCommandId(index: number): string {
  return `ly-dist-${index}`;
}

export type LightyearPlanReviewCommand = PlanReviewCommand;
export type BuildLightyearExecutionPlanInputArgs = BuildExecutionPlanInputArgs;

/**
 * PLANNER: assemble the immutable execution-plan input for a reviewed Lightyear
 * dry run. The drift `fingerprint` lives in `privatePayload`, stripped from
 * every public/inspect view so the review page cannot leak it. All bound source
 * identities (statement CSV, and for trades the capital-gains CSV) are carried
 * so execute can re-validate every source it read against the plan.
 */
export { buildExecutionPlanInput as buildLightyearExecutionPlanInput } from "./plan-module-core.js";

/**
 * EXECUTOR command spec. `prepare` rechecks this command's duplicate
 * precondition against a fresh ledger read immediately before its own `mutate`;
 * the tracker stops at the first drift, failure, or indeterminate outcome.
 */
export type LightyearExecutionCommand = PlanExecutionCommandSpec;

/**
 * EXECUTOR: drive the reviewed Lightyear journal creations through the shared
 * plan-execution tracker in the exact enumerated order (see
 * executePlanCommandSpecs).
 */
export { executePlanCommandSpecs as executeLightyearCommands } from "./plan-module-core.js";
