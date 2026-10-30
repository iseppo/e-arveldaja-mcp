import { canonicalPlanJson, stripUndefinedDeep } from "./camt-plan.js";
import {
  type BuildExecutionPlanInputArgs,
  type PlanExecutionCommandSpec,
  type PlanReviewCommand,
} from "./plan-module-core.js";

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
export const RECON_DELETE_PROPOSED_MIRROR_CATEGORY = "reconcile_delete_proposed_mirror";

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
export function reconDeleteProposedMirrorCommandId(transactionId: number): string {
  return `recon-delete-proposed-mirror-tx-${transactionId}`;
}

export type ReconciliationReviewCommand = PlanReviewCommand;
export type BuildReconciliationExecutionPlanInputArgs = BuildExecutionPlanInputArgs;

/**
 * PLANNER: assemble the immutable execution-plan input for a reviewed
 * reconciliation dry run. The drift `fingerprint` is kept in `privatePayload`,
 * stripped from every public/inspect view so the review page cannot leak it.
 */
export { buildExecutionPlanInput as buildReconciliationExecutionPlanInput } from "./plan-module-core.js";

/**
 * EXECUTOR command spec. `prepare` rechecks this command's preconditions against
 * a fresh read immediately before its own `mutate`; the tracker stops at the
 * first drift, failure, or indeterminate outcome (no match substitution).
 */
export type ReconciliationExecutionCommand = PlanExecutionCommandSpec;

/**
 * EXECUTOR: drive the reviewed reconciliation commands through the shared
 * plan-execution tracker in the exact enumerated order. The plan-data command
 * list handed to the tracker carries no closures; `prepare`/`mutate` dispatch by
 * position into the spec list.
 */
export { executePlanCommandSpecs as executeReconciliationCommands } from "./plan-module-core.js";
