import type { OperationOutcome } from "../../operation-outcome.js";
import type { ApiContext } from "../../tools/crud/shared.js";
import type { RuntimeSafetyContext } from "../../runtime-safety-context.js";
import {
  runSuggestMatches,
  prepareExactConfirm,
  executeExactConfirm,
  prepareInterAccount,
  executeInterAccount,
  ReconciliationOperationFailedError,
  type ReconExecResult,
  type ReconFailure,
} from "./executor.js";
import type {
  BankReconciliationOperations,
  ExactConfirmExecution,
  ExactConfirmExecutionInput,
  ExactConfirmInput,
  ExactConfirmPreview,
  InterAccountExecution,
  InterAccountExecutionInput,
  InterAccountInput,
  InterAccountPreview,
  ReconciliationSuggestions,
  SuggestMatchesInput,
} from "./types.js";

// Typed reconciliation operations. The interface references NO MCP types —
// inputs and results are plain typed data. Structured domain failures surface
// two ways, mirroring CAMT/Wise: kinds whose byte-exact MCP envelope needs data
// beyond a fixed discriminant (the real plan-store error code + message, the
// specific plan-drift detail) are THROWN as a ReconciliationOperationFailedError
// carrying the full ReconFailure; the simple plan_handle_required kind surfaces
// as an OperationOutcome failure (keeping that path alive for the orchestration
// seam). The tool/presenter layer projects both into byte-identical envelopes.
// All execution-safety gates (plan consume-once, plan_handle + drift, frozen
// command loop, indeterminate stops, partial results, inter-account journal
// dedup, ownership gating) live in the executor.

// Construct the OperationOutcome union directly rather than through
// successOutcome(), which deep-clones and freezes its value as PlanData and
// would reject the rich render data (it carries Maps and nested api objects).
function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}

function fail<T>(failure: ReconFailure): OperationOutcome<T> {
  // Rich kinds carry byte-load-bearing data the OperationOutcome error triple
  // cannot fully hold as a stable discriminant; throw the full failure so the
  // presenter reproduces the exact envelope.
  if (failure.kind === "plan_store_error" || failure.kind === "plan_drift") {
    throw new ReconciliationOperationFailedError(failure);
  }
  // plan_handle_required is fully determined by its category + fixed message.
  return { ok: false, error: { code: failure.category, message: failure.message, retry: "never" }, blockers: [] };
}

function project<T>(result: ReconExecResult<T>): OperationOutcome<T> {
  return result.ok ? ok(result.data) : fail(result.failure);
}

class BankReconciliationOperationsImpl implements BankReconciliationOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

  async suggestMatches(input: SuggestMatchesInput): Promise<OperationOutcome<ReconciliationSuggestions>> {
    return ok(await runSuggestMatches(this.api, input));
  }

  async prepareExactConfirm(input: ExactConfirmInput): Promise<OperationOutcome<ExactConfirmPreview>> {
    return ok(await prepareExactConfirm(this.api, this.runtimeSafetyContext, input));
  }

  async executeExactConfirm(input: ExactConfirmExecutionInput): Promise<OperationOutcome<ExactConfirmExecution>> {
    return project(await executeExactConfirm(this.api, this.runtimeSafetyContext, input));
  }

  async prepareInterAccount(input: InterAccountInput): Promise<OperationOutcome<InterAccountPreview>> {
    return ok(await prepareInterAccount(this.api, this.runtimeSafetyContext, input));
  }

  async executeInterAccount(input: InterAccountExecutionInput): Promise<OperationOutcome<InterAccountExecution>> {
    return project(await executeInterAccount(this.api, this.runtimeSafetyContext, input));
  }
}

export function createBankReconciliationOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): BankReconciliationOperations {
  return new BankReconciliationOperationsImpl(api, runtimeSafetyContext);
}
