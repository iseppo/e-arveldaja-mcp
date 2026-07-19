import { createHash } from "node:crypto";
import type { ToolExposureConfig } from "../config.js";
import { ExecutionPlanStore, type ExecutionPlanStoreOptions } from "../plan-store.js";
import type { RuntimeSafetyContext, RuntimeSafetyScope } from "../runtime-safety-context.js";

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
  return Object.freeze({
    get serverInstanceId() { return scope.serverInstanceId; },
    planStore,
    getActiveScope,
    setNow(value: number) { now = value; },
    advanceTime(milliseconds: number) { now += milliseconds; },
    setScope(patch: Parameters<typeof frozenScope>[1]) { scope = frozenScope(scope, patch); },
  });
}
