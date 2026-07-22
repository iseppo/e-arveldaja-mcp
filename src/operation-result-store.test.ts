import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import {
  MAX_ACTIVE_OPERATION_RESULTS,
  OPERATION_RESULT_TTL_MS,
  OperationResultStoreError,
} from "./operation-result-store.js";

function result(items: readonly unknown[] = [{ item_id: "1", amount: 12.5 }]) {
  return { operation: "camt_import", status: "completed" as const, items };
}

describe("operation result store", () => {
  it("clones and recursively freezes only public projections", () => {
    const runtime = createTestRuntimeSafetyContext();
    const source = { item_id: "1", nested: { label: "safe" } };
    const handle = runtime.operationResultStore.issue(result([source]));
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
      { privatePayload: {} }, { normalizedArgs: {} }, { liveSnapshot: {} }, { plan_handle: "plan" },
      { command: "execute" }, { commands: [] }, { tool: "delete_transaction", args: {} },
      { approved: true }, { approval_required: true }, { approvalState: "approved" },
      { user_approval: "approved" }, { execution_plan: {} }, { tool_call: "delete" },
    ];
    for (const item of cases) {
      expect(() => runtime.operationResultStore.issue(result([item]))).toThrowError(OperationResultStoreError);
    }
    expect(runtime.operationResultStore.activeCount).toBe(0);
  });

  it("rejects unsafe or non-exact top-level result envelopes before reading getters", () => {
    const runtime = createTestRuntimeSafetyContext();
    let getterRead = false;
    const getterInput = Object.defineProperty({}, "operation", { enumerable: true, get() { getterRead = true; return "test"; } });
    expect(() => runtime.operationResultStore.issue(getterInput as any)).toThrowError(OperationResultStoreError);
    expect(getterRead).toBe(false);
    expect(() => runtime.operationResultStore.issue(new Proxy(result(), {}) as any)).toThrowError(OperationResultStoreError);
    expect(() => runtime.operationResultStore.issue({ ...result(), privatePayload: {} } as any)).toThrowError(OperationResultStoreError);
  });

  it("binds handles to every runtime scope dimension without burning wrong-scope results", () => {
    const changes = [
      { serverInstanceId: "other-server-instance-00000000000001" },
      { connectionIndex: 1 }, { connectionGeneration: 1 }, { connectionName: "other" },
      { connectionFingerprint: "other-fingerprint" }, { environmentKind: "live" as const },
      { baseUrl: "https://rmp-api.rik.ee/v1" }, { profile: "guided" as const },
      { catalogFingerprint: "other-catalog" }, { features: { enableSales: false } },
    ];
    for (const patch of changes) {
      const runtime = createTestRuntimeSafetyContext();
      const handle = runtime.operationResultStore.issue(result());
      runtime.setScope(patch);
      expect(() => runtime.operationResultStore.inspect(handle)).toThrowError(expect.objectContaining({ code: "operation_result_scope_mismatch" }));
      runtime.setScope({
        serverInstanceId: "test-server-instance-0000000000000001", connectionIndex: 0, connectionGeneration: 0,
        connectionName: "test-connection", connectionFingerprint: "test-fingerprint", environmentKind: "demo",
        baseUrl: "https://demo-rmp-api.rik.ee/v1", profile: "standard", catalogFingerprint: "test-catalog-fingerprint",
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
    const first = runtime.operationResultStore.issue(result([{ item_id: "first" }]));
    runtime.advanceTime(1);
    runtime.operationResultStore.issue(result([{ item_id: "second" }]));
    runtime.operationResultStore.inspect(first);
    expect(() => runtime.operationResultStore.issue(result())).toThrowError(expect.objectContaining({ code: "operation_result_capacity_exceeded" }));
    runtime.advanceTime(10);
    expect(() => runtime.operationResultStore.inspect(first)).toThrowError(expect.objectContaining({ code: "operation_result_expired" }));
    expect(runtime.operationResultStore.activeCount).toBe(0);
    expect(OPERATION_RESULT_TTL_MS).toBeGreaterThan(0);
    expect(MAX_ACTIVE_OPERATION_RESULTS).toBeGreaterThan(0);
  });

  it("rejects repeated and malformed handle factory output after bounded attempts", () => {
    const bytes = createHash("sha256").update("same").digest();
    const runtime = createTestRuntimeSafetyContext({ operationResultStore: { handleFactory: () => bytes } });
    runtime.operationResultStore.issue(result());
    expect(() => runtime.operationResultStore.issue(result())).toThrowError(expect.objectContaining({ code: "operation_result_handle_collision" }));
    const malformed = createTestRuntimeSafetyContext({ operationResultStore: { handleFactory: () => Buffer.alloc(1) } });
    expect(() => malformed.operationResultStore.issue(result())).toThrowError(expect.objectContaining({ code: "operation_result_handle_collision" }));
  });

  it("never aliases an expired handle to a later result", () => {
    const bytes = createHash("sha256").update("same-after-expiry").digest();
    const runtime = createTestRuntimeSafetyContext({ now: 0, operationResultStore: { ttlMs: 1, handleFactory: () => bytes } });
    const expired = runtime.operationResultStore.issue(result());
    runtime.advanceTime(1);
    expect(() => runtime.operationResultStore.inspect(expired)).toThrowError(expect.objectContaining({ code: "operation_result_expired" }));
    expect(() => runtime.operationResultStore.issue(result())).toThrowError(expect.objectContaining({ code: "operation_result_handle_collision" }));
  });

  it("rejects an expiration timestamp outside the safe integer range", () => {
    const runtime = createTestRuntimeSafetyContext({ now: Number.MAX_SAFE_INTEGER, operationResultStore: { ttlMs: 1 } });
    expect(() => runtime.operationResultStore.issue(result())).toThrowError(expect.objectContaining({ code: "operation_result_data_invalid" }));
  });
});
