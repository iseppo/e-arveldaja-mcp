import type { OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { FileInputSource } from "../file-input-snapshot.js";
import {
  executeWiseImport,
  prepareWiseImport,
  WiseOperationFailedError,
  type WiseFailure,
  type WiseRunInput,
} from "./executor.js";
import type { WiseImportExecution, WiseImportPreview } from "./presenter.js";

// Typed Wise operations. The interface references NO MCP types — inputs and
// results are plain typed data. Structured domain failures surface two ways,
// mirroring the CAMT precedent: kinds whose byte-exact envelope needs data
// beyond {code,message,retry} (preflight rejected fields, the real plan-store
// error code, plan-drift detail) are THROWN as a WiseOperationFailedError
// carrying the full discriminated WiseFailure; kinds fully determined by their
// discriminant surface as an OperationOutcome failure (keeping that path alive
// for the Task 10 orchestration seam). The tool/presenter layer (renderWiseFailure)
// projects both into byte-identical MCP envelopes. Execution-safety gates (plan
// consume-once, digest + plan_handle both required, source/scope/ledger/argument
// drift, the module execution lock, ownership gating, indeterminate stops,
// partial results) all live in the executor.

export interface WisePrepareInput extends WiseRunInput {}
export interface WiseExecuteInput extends WiseRunInput {
  readonly planHandle: string | undefined;
}

export interface WiseOperations {
  prepare(input: WisePrepareInput): Promise<OperationOutcome<WiseImportPreview>>;
  execute(input: WiseExecuteInput): Promise<OperationOutcome<WiseImportExecution>>;
}

// Construct the OperationOutcome union directly rather than through
// successOutcome(), which deep-clones and freezes its value as PlanData and
// would reject the rich render data (it carries FileInputSource, Maps, and
// nested api objects).
function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}

function fail<T>(failure: WiseFailure): OperationOutcome<T> {
  // Rich kinds carry byte-load-bearing data the OperationOutcome error triple
  // cannot hold ({code,message,retry} would drop the preflight rejected fields,
  // the real plan-store error code, or the plan-drift detail). Throw the full
  // discriminated failure so renderWiseFailure reproduces the exact envelope.
  if (
    failure.kind === "preflight" ||
    failure.kind === "plan_store_error" ||
    failure.kind === "plan_drift"
  ) {
    throw new WiseOperationFailedError(failure);
  }
  // Simple kinds are fully determined by their discriminant; renderWiseFailure
  // ignores message/retry for them, so the OperationOutcome error stays byte-safe.
  return { ok: false, error: { code: failure.kind, message: failure.kind, retry: "never" }, blockers: [] };
}

class WiseOperationsImpl implements WiseOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

  async prepare(input: WisePrepareInput): Promise<OperationOutcome<WiseImportPreview>> {
    const result = await prepareWiseImport(this.api, this.runtimeSafetyContext, input);
    return result.ok ? ok(result.data) : fail(result.failure);
  }

  async execute(input: WiseExecuteInput): Promise<OperationOutcome<WiseImportExecution>> {
    const result = await executeWiseImport(this.api, this.runtimeSafetyContext, input, input.planHandle);
    return result.ok ? ok(result.data) : fail(result.failure);
  }
}

export function createWiseOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): WiseOperations {
  return new WiseOperationsImpl(api, runtimeSafetyContext);
}

export type { FileInputSource, WiseFailure };
