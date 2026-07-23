import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import {
  MAX_ACTIVE_OPERATION_RESULTS,
  OPERATION_RESULT_TTL_MS,
  OperationResultStoreError,
} from "./operation-result-store.js";
import type { ExecutionPlanInput } from "./plan-store.js";

function planInput(): ExecutionPlanInput {
  return { normalizedArgs: {}, sourceIdentities: [], liveSnapshot: {}, commands: [], counts: {}, totals: {}, exclusions: [], reviews: [], privatePayload: {} };
}

function consumedPlan(runtime: ReturnType<typeof createTestRuntimeSafetyContext>, operation = "camt_import"): string {
  const handle = runtime.planStore.issue(operation, planInput());
  runtime.planStore.consume(handle, operation);
  return handle;
}

function result(runtime: ReturnType<typeof createTestRuntimeSafetyContext>, items: readonly unknown[] = [{ item_id: "1", amount: 12.5 }]) {
  return { operation: "camt_import", status: "completed" as const, items, plan_handle: consumedPlan(runtime) };
}

describe("operation result store", () => {
  it("clones and recursively freezes only public projections", () => {
    const runtime = createTestRuntimeSafetyContext();
    const source = { item_id: "1", nested: { label: "safe" } };
    const handle = runtime.operationResultStore.issue(result(runtime, [source]));
    source.nested.label = "mutated";
    const stored = runtime.operationResultStore.inspect(handle);
    expect(stored.items).toEqual([{ item_id: "1", nested: { label: "safe" } }]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen((stored.items[0] as any).nested)).toBe(true);
  });

  it("rejects proxies, accessors, cycles, unsafe keys, credentials, plans, commands, and approval state", () => {
    const runtime = createTestRuntimeSafetyContext();
    const cyclic: any = {}; cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "secret" });
    const cases = [
      new Proxy({}, {}), accessor, cyclic,
      { __proto__: null, constructor: "x" },
      { password: "secret" }, { api_key: "secret" }, { credential: "secret" },
      { access_token: "secret" }, { refreshToken: "secret" }, { client_secret: "secret" },
      { private_key: "secret" }, { "Private-Key": "secret" }, { privateKey: "secret" }, { PRIVATE_KEY_MATERIAL: "secret" },
      { session_cookie: "secret" }, { "Session-Cookie": "secret" }, { sessionCookie: "secret" }, { session_cookie_value: "secret" },
      { bearer: "secret" }, { BearerToken: "secret" }, { bearer_auth: "secret" },
      { privatePayload: {} }, { normalizedArgs: {} }, { liveSnapshot: {} }, { plan_handle: "plan" },
      { command: "execute" }, { commands: [] }, { tool: "delete_transaction", args: {} },
      { approved: true }, { approval_required: true }, { approvalState: "approved" },
      { user_approval: "approved" }, { execution_plan: {} }, { tool_call: "delete" },
    ];
    for (const item of cases) {
      expect(() => runtime.operationResultStore.issue(result(runtime, [item]))).toThrowError(OperationResultStoreError);
    }
    expect(runtime.operationResultStore.activeCount).toBe(0);
  });

  it("rejects unsafe or non-exact top-level result envelopes before reading getters", () => {
    const runtime = createTestRuntimeSafetyContext();
    let getterRead = false;
    const getterInput = Object.defineProperty({}, "operation", { enumerable: true, get() { getterRead = true; return "test"; } });
    expect(() => runtime.operationResultStore.issue(getterInput as any)).toThrowError(OperationResultStoreError);
    expect(getterRead).toBe(false);
    expect(() => runtime.operationResultStore.issue(new Proxy(result(runtime), {}) as any)).toThrowError(OperationResultStoreError);
    expect(() => runtime.operationResultStore.issue({ ...result(runtime), privatePayload: {} } as any)).toThrowError(OperationResultStoreError);
  });

  it("requires a successfully consumed plan for the same store, operation, and scope", () => {
    const runtime = createTestRuntimeSafetyContext();
    const live = runtime.planStore.issue("camt_import", planInput());
    expect(() => runtime.operationResultStore.issue({ operation: "camt_import", status: "completed", items: [], plan_handle: live }))
      .toThrowError(OperationResultStoreError);
    expect(() => runtime.operationResultStore.issue({ operation: "camt_import", status: "completed", items: [], plan_handle: "x".repeat(43) }))
      .toThrowError(OperationResultStoreError);
    expect(() => runtime.operationResultStore.issue({ operation: "camt_import", status: "completed", items: [] } as any))
      .toThrowError(OperationResultStoreError);

    const wrongOperation = consumedPlan(runtime, "wise_import");
    expect(() => runtime.operationResultStore.issue({ operation: "camt_import", status: "completed", items: [], plan_handle: wrongOperation }))
      .toThrowError(OperationResultStoreError);

    const failedConsumption = runtime.planStore.issue("camt_import", planInput());
    expect(() => runtime.planStore.consume(failedConsumption, "wise_import")).toThrow();
    expect(() => runtime.operationResultStore.issue({ operation: "camt_import", status: "completed", items: [], plan_handle: failedConsumption }))
      .toThrowError(OperationResultStoreError);

    const other = createTestRuntimeSafetyContext();
    const otherHandle = consumedPlan(other);
    expect(() => runtime.operationResultStore.issue({ operation: "camt_import", status: "completed", items: [], plan_handle: otherHandle }))
      .toThrowError(OperationResultStoreError);

    const valid = consumedPlan(runtime);
    runtime.setScope({ connectionGeneration: 1 });
    expect(() => runtime.operationResultStore.issue({ operation: "camt_import", status: "completed", items: [], plan_handle: valid }))
      .toThrowError(OperationResultStoreError);
  });

  it("accepts only completed, partial, and indeterminate statuses", () => {
    const runtime = createTestRuntimeSafetyContext();
    for (const status of ["completed", "partial", "indeterminate"] as const) {
      expect(() => runtime.operationResultStore.issue({ ...result(runtime), status })).not.toThrow();
    }
    expect(() => runtime.operationResultStore.issue({ ...result(runtime), status: "failed" } as any)).toThrowError(OperationResultStoreError);
  });

  it("binds handles to every runtime scope dimension without burning wrong-scope results", () => {
    const changes = [
      { serverInstanceId: "other-server-instance-00000000000001" },
      { connectionIndex: 1 }, { connectionGeneration: 1 }, { connectionName: "other" },
      { connectionFingerprint: "other-fingerprint" }, { environmentKind: "live" as const },
      { baseUrl: "https://rmp-api.rik.ee/v1" }, { profile: "guided" as const },
      { verifiedCompanyIdentity: "other oü" },
      { catalogFingerprint: "other-catalog" }, { features: { enableSales: false } },
    ];
    for (const patch of changes) {
      const runtime = createTestRuntimeSafetyContext();
      const handle = runtime.operationResultStore.issue(result(runtime));
      runtime.setScope(patch);
      expect(() => runtime.operationResultStore.inspect(handle)).toThrowError(expect.objectContaining({ code: "operation_result_scope_mismatch" }));
      runtime.setScope({
        serverInstanceId: "test-server-instance-0000000000000001", connectionIndex: 0, connectionGeneration: 0,
        connectionName: "test-connection", connectionFingerprint: "test-fingerprint", environmentKind: "demo",
        baseUrl: "https://demo-rmp-api.rik.ee/v1", profile: "standard", catalogFingerprint: "test-catalog-fingerprint",
        verifiedCompanyIdentity: "acme",
        features: { enableSales: true },
      });
      expect(runtime.operationResultStore.inspect(handle).items).toHaveLength(1);
    }
  });

  it("enforces finite TTL and capacity without extending or reordering on inspect", () => {
    const runtime = createTestRuntimeSafetyContext({
      now: 100,
      operationResultStore: { ttlMs: 10, maxActive: 2 },
    });
    const first = runtime.operationResultStore.issue(result(runtime, [{ item_id: "first" }]));
    runtime.advanceTime(1);
    runtime.operationResultStore.issue(result(runtime, [{ item_id: "second" }]));
    runtime.operationResultStore.inspect(first);
    expect(() => runtime.operationResultStore.issue(result(runtime))).toThrowError(expect.objectContaining({ code: "operation_result_capacity_exceeded" }));
    runtime.advanceTime(10);
    expect(() => runtime.operationResultStore.inspect(first)).toThrowError(expect.objectContaining({ code: "operation_result_expired" }));
    expect(runtime.operationResultStore.activeCount).toBe(0);
    expect(OPERATION_RESULT_TTL_MS).toBeGreaterThan(0);
    expect(MAX_ACTIVE_OPERATION_RESULTS).toBeGreaterThan(0);
  });

  it("rejects repeated and malformed handle factory output after bounded attempts", () => {
    const bytes = createHash("sha256").update("same").digest();
    const runtime = createTestRuntimeSafetyContext({ operationResultStore: { handleFactory: () => bytes } });
    runtime.operationResultStore.issue(result(runtime));
    expect(() => runtime.operationResultStore.issue(result(runtime))).toThrowError(expect.objectContaining({ code: "operation_result_handle_collision" }));
    const malformed = createTestRuntimeSafetyContext({ operationResultStore: { handleFactory: () => Buffer.alloc(1) } });
    expect(() => malformed.operationResultStore.issue(result(malformed))).toThrowError(expect.objectContaining({ code: "operation_result_handle_collision" }));
  });

  it("never aliases an expired handle to a later result", () => {
    const bytes = createHash("sha256").update("same-after-expiry").digest();
    const runtime = createTestRuntimeSafetyContext({ now: 0, operationResultStore: { ttlMs: 1, handleFactory: () => bytes } });
    const expired = runtime.operationResultStore.issue(result(runtime));
    runtime.advanceTime(1);
    expect(() => runtime.operationResultStore.inspect(expired)).toThrowError(expect.objectContaining({ code: "operation_result_expired" }));
    expect(() => runtime.operationResultStore.issue(result(runtime))).toThrowError(expect.objectContaining({ code: "operation_result_handle_collision" }));
  });

  it("rejects an expiration timestamp outside the safe integer range", () => {
    const runtime = createTestRuntimeSafetyContext({ now: 0, operationResultStore: { ttlMs: 1 } });
    const input = result(runtime);
    runtime.setNow(Number.MAX_SAFE_INTEGER);
    expect(() => runtime.operationResultStore.issue(input)).toThrowError(expect.objectContaining({ code: "operation_result_data_invalid" }));
  });
});
