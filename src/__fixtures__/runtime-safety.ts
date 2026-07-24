import { createHash } from "node:crypto";
import type { ToolExposureConfig } from "../config.js";
import { ExecutionPlanStore, type ExecutionPlanStoreOptions } from "../plan-store.js";
import type { RuntimeSafetyContext, RuntimeSafetyScope } from "../runtime-safety-context.js";
import { FileReferenceStore, type FileReferenceStoreOptions } from "../file-reference-store.js";
import { OperationResultStore, type OperationResultStoreOptions } from "../operation-result-store.js";
import { WorkflowStateStore, type WorkflowStateStoreOptions } from "../workflow-state-store.js";

const DEFAULT_FEATURES: ToolExposureConfig = Object.freeze({
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
});

export interface TestRuntimeSafetyContext extends RuntimeSafetyContext {
  setNow(now: number): void;
  advanceTime(milliseconds: number): void;
  setScope(scope: Partial<Omit<RuntimeSafetyScope, "features">> & {
    features?: Partial<ToolExposureConfig>;
  }): void;
}

export interface TestRuntimeSafetyContextOptions {
  readonly now?: number;
  readonly scope?: Partial<Omit<RuntimeSafetyScope, "features">> & {
    features?: Partial<ToolExposureConfig>;
  };
  readonly planStore?: Omit<ExecutionPlanStoreOptions, "getActiveScope" | "now">;
  readonly fileReferenceStore?: Omit<FileReferenceStoreOptions, "getActiveScope" | "now">;
  readonly operationResultStore?: Omit<OperationResultStoreOptions, "getActiveScope" | "assertConsumedPlan" | "retainConsumedPlan" | "now">;
  readonly workflowStateStore?: Omit<WorkflowStateStoreOptions, "getActiveScope" | "now">;
}

function frozenScope(
  current: RuntimeSafetyScope,
  patch: TestRuntimeSafetyContextOptions["scope"],
): RuntimeSafetyScope {
  return Object.freeze({
    ...current,
    ...patch,
    features: Object.freeze({ ...current.features, ...patch?.features }),
  });
}

/** Explicit deterministic fixture. Production code must never import this module. */
export function createTestRuntimeSafetyContext(
  options: TestRuntimeSafetyContextOptions = {},
): TestRuntimeSafetyContext {
  let now = options.now ?? 1_000_000;
  let handleCounter = 0;
  let scope: RuntimeSafetyScope = frozenScope(Object.freeze({
    serverInstanceId: "test-server-instance-0000000000000001",
    connectionIndex: 0,
    connectionGeneration: 0,
    connectionName: "test-connection",
    connectionFingerprint: "test-fingerprint",
    environmentKind: "demo",
    baseUrl: "https://demo-rmp-api.rik.ee/v1",
    verifiedCompanyIdentity: "acme",
    profile: "standard",
    catalogFingerprint: "test-catalog-fingerprint",
    features: DEFAULT_FEATURES,
  }), options.scope);
  const getActiveScope = () => scope;
  const planStore = new ExecutionPlanStore({
    handleFactory: () => createHash("sha256")
      .update(`test-execution-plan:${handleCounter++}`)
      .digest(),
    ...options.planStore,
    now: () => now,
    getActiveScope,
  });
  let referenceCounter = 0;
  const fileReferenceStore = new FileReferenceStore({
    referenceFactory: () => createHash("sha256")
      .update(`test-file-reference:${referenceCounter++}`)
      .digest(),
    ...options.fileReferenceStore,
    now: () => now,
    getActiveScope,
  });
  let resultCounter = 0;
  const operationResultStore = new OperationResultStore({
    handleFactory: () => createHash("sha256")
      .update(`test-operation-result:${resultCounter++}`)
      .digest(),
    ...options.operationResultStore,
    now: () => now,
    getActiveScope,
    assertConsumedPlan: (handle, domain) => planStore.assertConsumed(handle, domain),
    retainConsumedPlan: (handle, domain) => planStore.retainConsumed(handle, domain),
  });
  let workflowStateCounter = 0;
  const workflowStateStore = new WorkflowStateStore({
    handleFactory: () => createHash("sha256")
      .update(`test-workflow-state:${workflowStateCounter++}`)
      .digest(),
    ...options.workflowStateStore,
    now: () => now,
    getActiveScope,
  });
  return Object.freeze({
    serverInstanceId: scope.serverInstanceId,
    planStore,
    fileReferenceStore,
    operationResultStore,
    workflowStateStore,
    operationResultPageCursorSecret: Buffer.alloc(32, 7),
    getActiveScope,
    setNow(value: number) { now = value; },
    advanceTime(milliseconds: number) { now += milliseconds; },
    setScope(patch: Parameters<typeof frozenScope>[1]) { scope = frozenScope(scope, patch); },
  });
}
