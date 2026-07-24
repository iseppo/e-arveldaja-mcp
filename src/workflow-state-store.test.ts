import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import {
  MAX_ACTIVE_WORKFLOW_STATES,
  MAX_WORKFLOW_STATE_TOMBSTONES,
  WORKFLOW_STATE_TTL_MS,
  WorkflowStateStoreError,
  createPublicWorkflowStateDetail,
} from "./workflow-state-store.js";

function state(
  items: readonly unknown[] = [{ item_id: "1", amount: 12.5 }],
) {
  return {
    workflow: "accounting_inbox",
    status: "in_progress" as const,
    items: items.map(item => createPublicWorkflowStateDetail(item as never)),
  };
}

describe("workflow state store", () => {
  it("clones and recursively freezes only public projections", () => {
    const runtime = createTestRuntimeSafetyContext();
    const source = { item_id: "1", nested: { label: "safe" } };
    const handle = runtime.workflowStateStore.issue(state([source]));
    source.nested.label = "mutated";
    const stored = runtime.workflowStateStore.inspect(handle);
    expect(stored.items).toEqual([{ item_id: "1", nested: { label: "safe" } }]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen((stored.items[0] as any).nested)).toBe(true);
  });

  it("admits a detail under the per-item budget but refuses one no page size could reach (item_too_large)", () => {
    const runtime = createTestRuntimeSafetyContext();
    const underHandle = runtime.workflowStateStore.issue(state([{ item_id: "1", text: "a".repeat(10_000) }]));
    expect(runtime.workflowStateStore.inspect(underHandle).items).toHaveLength(1);

    expect(() => runtime.workflowStateStore.issue(state([{ item_id: "2", text: "€".repeat(15_000) }])))
      .toThrowError(expect.objectContaining({ code: "workflow_state_item_too_large" }));
    expect(() => runtime.workflowStateStore.issue(state([{ item_id: "3", text: "x".repeat(20_001) }])))
      .toThrowError(expect.objectContaining({ code: "workflow_state_item_too_large" }));

    expect(runtime.workflowStateStore.activeCount).toBe(1);
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
      expect(() => runtime.workflowStateStore.issue(state([item]))).toThrowError(WorkflowStateStoreError);
    }
    expect(runtime.workflowStateStore.activeCount).toBe(0);
  });

  it("rejects raw, credential-bearing, executable, and positional state projections", () => {
    const probes: readonly unknown[] = [
      { item_id: "raw-but-unconstructed" },
      { auth_header: "Bearer top-secret" },
      { AUTH_HEADER: "Bearer top-secret" },
      { cookie: "session=secret" },
      { jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature" },
      { access_key_id: "AKIAEXAMPLE" },
      { action: "delete_transaction", parameters: { id: 1 } },
      { request_payload: { operation: "delete_transaction" } },
      ["delete_transaction", { id: 1 }],
      { values: ["delete_transaction", { id: 1 }] },
      { values: ["cookie", "session=secret"] },
      { messages: ["authorization", "Bearer top-secret"] },
      { nested: { "Session-Cookie": "secret" } },
    ];
    for (const probe of probes) {
      const runtime = createTestRuntimeSafetyContext();
      expect(() => runtime.workflowStateStore.issue({
        workflow: "accounting_inbox", status: "in_progress", items: [probe] as never,
      }))
        .toThrowError(WorkflowStateStoreError);
    }
    for (const probe of probes.slice(1)) {
      expect(() => createPublicWorkflowStateDetail(probe as never))
        .toThrowError(WorkflowStateStoreError);
    }
  });

  it("stores constructed inert workflow rows with scalar, list, and nested summary fields", () => {
    const runtime = createTestRuntimeSafetyContext();
    const detail = createPublicWorkflowStateDetail({
      item_id: "row-1",
      status: "completed",
      amount: 12.5,
      labels: ["verified", "imported"],
      nested: { label: "cash", counts: { count: 2 } },
    });
    const handle = runtime.workflowStateStore.issue({
      workflow: "accounting_inbox", status: "needs_review", items: [detail],
    });
    expect(runtime.workflowStateStore.inspect(handle).items).toEqual([{
      item_id: "row-1", status: "completed", amount: 12.5, labels: ["verified", "imported"], nested: { label: "cash", counts: { count: 2 } },
    }]);
  });

  it("rejects structural forgeries and clones while retaining constructor branding and immutability", () => {
    const runtime = createTestRuntimeSafetyContext();
    const source = { item_id: "row-1", nested: { label: "safe" } };
    const branded = createPublicWorkflowStateDetail(source);
    const forged = { contract: "workflow_state_detail_v1", data: { item_id: "forged" } };
    const cloned = { ...branded };
    source.nested.label = "mutated";

    expect(branded).toMatchObject({ contract: "workflow_state_detail_v1", data: { item_id: "row-1", nested: { label: "safe" } } });
    expect(Object.isFrozen(branded)).toBe(true);
    expect(Object.isFrozen(branded.data)).toBe(true);
    for (const detail of [forged, cloned]) {
      expect(() => runtime.workflowStateStore.issue({
        workflow: "accounting_inbox", status: "in_progress", items: [detail] as never,
      })).toThrowError(WorkflowStateStoreError);
    }
  });

  it("rejects proxied, accessor-backed, and sparse item arrays without executing traps or getters", () => {
    const detail = createPublicWorkflowStateDetail({ item_id: "row-1" });
    let proxyRead = false;
    const proxied = new Proxy([detail], { get(target, property, receiver) { proxyRead = true; return Reflect.get(target, property, receiver); } });
    let getterRead = false;
    const accessorBacked: unknown[] = [];
    Object.defineProperty(accessorBacked, "0", { enumerable: true, get() { getterRead = true; return detail; } });
    Object.defineProperty(accessorBacked, "length", { value: 1, writable: true });
    const sparse = new Array(1);

    for (const items of [proxied, accessorBacked, sparse]) {
      const runtime = createTestRuntimeSafetyContext();
      expect(() => runtime.workflowStateStore.issue({
        workflow: "accounting_inbox", status: "in_progress", items: items as never,
      })).toThrowError(WorkflowStateStoreError);
    }
    expect(proxyRead).toBe(false);
    expect(getterRead).toBe(false);
  });

  it("rejects unsafe or non-exact top-level state envelopes before reading getters", () => {
    const runtime = createTestRuntimeSafetyContext();
    let getterRead = false;
    const getterInput = Object.defineProperty({}, "workflow", { enumerable: true, get() { getterRead = true; return "test"; } });
    expect(() => runtime.workflowStateStore.issue(getterInput as any)).toThrowError(WorkflowStateStoreError);
    expect(getterRead).toBe(false);
    expect(() => runtime.workflowStateStore.issue(new Proxy(state(), {}) as any)).toThrowError(WorkflowStateStoreError);
    expect(() => runtime.workflowStateStore.issue({ ...state(), privatePayload: {} } as any)).toThrowError(WorkflowStateStoreError);
    expect(() => runtime.workflowStateStore.issue({ ...state(), plan_handle: "x".repeat(43) } as any)).toThrowError(WorkflowStateStoreError);
  });

  it("issues handles mid-workflow without any plan-consumption proof", () => {
    const runtime = createTestRuntimeSafetyContext();
    // No plan is ever issued or consumed; the store must still mint a handle.
    const handle = runtime.workflowStateStore.issue(state());
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(runtime.workflowStateStore.inspect(handle).workflow).toBe("accounting_inbox");
    expect(runtime.workflowStateStore.inspect(handle)).not.toHaveProperty("planHandle");
  });

  it("rejects an unknown workflow name and a malformed handle", () => {
    const runtime = createTestRuntimeSafetyContext();
    expect(() => runtime.workflowStateStore.issue({ workflow: "Delete Everything", status: "in_progress", items: [] } as any))
      .toThrowError(WorkflowStateStoreError);
    expect(() => runtime.workflowStateStore.inspect("not-a-handle"))
      .toThrowError(expect.objectContaining({ code: "workflow_state_handle_invalid" }));
  });

  it("accepts only the five workflow-state statuses", () => {
    const runtime = createTestRuntimeSafetyContext();
    for (const status of ["in_progress", "needs_input", "needs_review", "ready_for_approval", "completed"] as const) {
      expect(() => runtime.workflowStateStore.issue({ ...state(), status })).not.toThrow();
    }
    expect(() => runtime.workflowStateStore.issue({ ...state(), status: "partial" } as any)).toThrowError(WorkflowStateStoreError);
    expect(() => runtime.workflowStateStore.issue({ ...state(), status: "failed" } as any)).toThrowError(WorkflowStateStoreError);
  });

  it("binds handles to every runtime scope dimension without burning wrong-scope states", () => {
    // Default feature-flag values in the test fixture (all 8 dimensions).
    const DEFAULT_FLAGS = {
      enableLightyear: true, exposeGranularTools: false, exposeSetupTools: false, enableTaxTools: true,
      enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true,
    } as const;
    const featureFlagChanges = (Object.keys(DEFAULT_FLAGS) as Array<keyof typeof DEFAULT_FLAGS>)
      .map(flag => ({ features: { [flag]: !DEFAULT_FLAGS[flag] } }));
    const changes = [
      { serverInstanceId: "other-server-instance-00000000000001" },
      { connectionIndex: 1 }, { connectionGeneration: 1 }, { connectionName: "other" },
      { connectionFingerprint: "other-fingerprint" }, { environmentKind: "live" as const },
      { baseUrl: "https://rmp-api.rik.ee/v1" }, { profile: "guided" as const },
      { verifiedCompanyIdentity: "other oü" },
      { catalogFingerprint: "other-catalog" },
      // Each of the 8 feature flags flipped individually must invalidate the handle.
      ...featureFlagChanges,
    ];
    for (const patch of changes) {
      const runtime = createTestRuntimeSafetyContext();
      const handle = runtime.workflowStateStore.issue(state());
      runtime.setScope(patch);
      expect(() => runtime.workflowStateStore.inspect(handle)).toThrowError(expect.objectContaining({ code: "workflow_state_scope_mismatch" }));
      runtime.setScope({
        serverInstanceId: "test-server-instance-0000000000000001", connectionIndex: 0, connectionGeneration: 0,
        connectionName: "test-connection", connectionFingerprint: "test-fingerprint", environmentKind: "demo",
        baseUrl: "https://demo-rmp-api.rik.ee/v1", profile: "standard", catalogFingerprint: "test-catalog-fingerprint",
        verifiedCompanyIdentity: "acme",
        features: { ...DEFAULT_FLAGS },
      });
      expect(runtime.workflowStateStore.inspect(handle).items).toHaveLength(1);
    }
  });

  it("enforces finite TTL and capacity without extending or reordering on inspect", () => {
    const runtime = createTestRuntimeSafetyContext({
      now: 100,
      workflowStateStore: { ttlMs: 10, maxActive: 2 },
    });
    const first = runtime.workflowStateStore.issue(state([{ item_id: "first" }]));
    runtime.advanceTime(1);
    runtime.workflowStateStore.issue(state([{ item_id: "second" }]));
    runtime.workflowStateStore.inspect(first);
    expect(() => runtime.workflowStateStore.issue(state())).toThrowError(expect.objectContaining({ code: "workflow_state_capacity_exceeded" }));
    runtime.advanceTime(10);
    expect(() => runtime.workflowStateStore.inspect(first)).toThrowError(expect.objectContaining({ code: "workflow_state_expired" }));
    expect(runtime.workflowStateStore.activeCount).toBe(0);
    expect(WORKFLOW_STATE_TTL_MS).toBe(1_800_000);
    expect(MAX_ACTIVE_WORKFLOW_STATES).toBe(128);
    expect(MAX_WORKFLOW_STATE_TOMBSTONES).toBe(512);
  });

  it("rejects repeated and malformed handle factory output after bounded attempts", () => {
    const bytes = createHash("sha256").update("same").digest();
    const runtime = createTestRuntimeSafetyContext({ workflowStateStore: { handleFactory: () => bytes } });
    runtime.workflowStateStore.issue(state());
    expect(() => runtime.workflowStateStore.issue(state())).toThrowError(expect.objectContaining({ code: "workflow_state_handle_collision" }));
    const malformed = createTestRuntimeSafetyContext({ workflowStateStore: { handleFactory: () => Buffer.alloc(1) } });
    expect(() => malformed.workflowStateStore.issue(state())).toThrowError(expect.objectContaining({ code: "workflow_state_handle_collision" }));
  });

  it("never aliases an expired handle to a later state", () => {
    const bytes = createHash("sha256").update("same-after-expiry").digest();
    const runtime = createTestRuntimeSafetyContext({ now: 0, workflowStateStore: { ttlMs: 1, handleFactory: () => bytes } });
    const expired = runtime.workflowStateStore.issue(state());
    runtime.advanceTime(1);
    expect(() => runtime.workflowStateStore.inspect(expired)).toThrowError(expect.objectContaining({ code: "workflow_state_expired" }));
    expect(() => runtime.workflowStateStore.issue(state())).toThrowError(expect.objectContaining({ code: "workflow_state_handle_collision" }));
  });

  it("rejects an expiration timestamp outside the safe integer range", () => {
    const runtime = createTestRuntimeSafetyContext({ now: 0, workflowStateStore: { ttlMs: 1 } });
    const input = state();
    runtime.setNow(Number.MAX_SAFE_INTEGER);
    expect(() => runtime.workflowStateStore.issue(input)).toThrowError(expect.objectContaining({ code: "workflow_state_data_invalid" }));
  });
});
