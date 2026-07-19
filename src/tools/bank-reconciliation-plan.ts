import {
  runPlanCommands,
  type MutateCommandResult,
  type PlanExecutionReport,
  type PrepareCommandResult,
} from "../plan-execution.js";
import type { ExecutionPlanInput, PlanData, PlanRecord } from "../plan-store.js";
import { canonicalPlanJson, stripUndefinedDeep } from "./camt-plan.js";

// Re-export the shared canonicalization helpers so the reconciliation tool can
// import everything plan-related from one module.
export { canonicalPlanJson, stripUndefinedDeep };

// The plan domain string that binds a reviewed reconciliation dry run to its
// execute. Both the exact-invoice-match confirm path and the inter-account
// transfer path issue/consume under this one domain, distinguished by the
// enumerated command fingerprint stored in the plan's private payload.
export const BANK_RECONCILIATION_PLAN_DOMAIN = "bank_reconciliation";

export const RECON_UPDATE_CLIENT_CATEGORY = "reconcile_update_client";
export const RECON_CONFIRM_INVOICE_CATEGORY = "reconcile_confirm_invoice";
export const RECON_CONFIRM_TRANSFER_CATEGORY = "reconcile_confirm_transfer";
export const RECON_DELETE_DUPLICATE_CATEGORY = "reconcile_delete_duplicate";

/** Stable, transaction-identity-derived command ids. Deterministic across dry run and execute. */
export function reconClientUpdateCommandId(transactionId: number): string {
  return `recon-update-client-tx-${transactionId}`;
}
export function reconInvoiceConfirmCommandId(transactionId: number): string {
  return `recon-confirm-invoice-tx-${transactionId}`;
}
export function reconTransferConfirmCommandId(transactionId: number): string {
  return `recon-confirm-transfer-tx-${transactionId}`;
}
export function reconDeleteDuplicateCommandId(transactionId: number): string {
  return `recon-delete-duplicate-tx-${transactionId}`;
}

export interface ReconciliationReviewCommand {
  readonly id: string;
  readonly category: string;
  readonly reviewProjection: PlanData;
}

export interface BuildReconciliationExecutionPlanInputArgs {
  readonly normalizedArgs: PlanRecord;
  readonly sourceIdentities: readonly PlanRecord[];
  readonly liveSnapshot: PlanData;
  readonly reviewCommands: readonly ReconciliationReviewCommand[];
  readonly fingerprint: string;
  readonly counts: PlanRecord;
  readonly totals: PlanRecord;
  readonly exclusions: readonly PlanData[];
  readonly reviews: readonly PlanData[];
}

/**
 * PLANNER: assemble the immutable execution-plan input for a reviewed
 * reconciliation dry run. The drift `fingerprint` is kept in `privatePayload`,
 * stripped from every public/inspect view so the review page cannot leak it.
 */
export function buildReconciliationExecutionPlanInput(
  args: BuildReconciliationExecutionPlanInputArgs,
): ExecutionPlanInput {
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
 * first drift, failure, or indeterminate outcome (no match substitution).
 */
export interface ReconciliationExecutionCommand {
  readonly id: string;
  readonly category: string;
  readonly known_object_limit?: number;
  readonly prepare: () => Promise<PrepareCommandResult>;
  readonly mutate: () => Promise<MutateCommandResult>;
}

/**
 * EXECUTOR: drive the reviewed reconciliation commands through the shared
 * plan-execution tracker in the exact enumerated order. The plan-data command
 * list handed to the tracker carries no closures; `prepare`/`mutate` dispatch by
 * position into the spec list.
 */
export async function executeReconciliationCommands(
  commands: readonly ReconciliationExecutionCommand[],
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
