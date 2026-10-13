import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cloneAndFreezePlanData, cloneRuntimeSafetyScope, runtimeSafetyScopesEqual, type PlanData } from "./plan-store.js";
import {
  assertPublicDetailProjection,
  createPublicDetailKit,
  PublicDetailHandleStore,
  readExactInputRecord,
  type PublicDetailStoreErrorKind,
} from "./public-detail-store.js";
import type { RuntimeSafetyScope } from "./runtime-safety-context.js";

class KindError extends Error {
  constructor(readonly kind: PublicDetailStoreErrorKind) { super(kind); }
}
const fail = (): never => { throw new KindError("data_invalid"); };
const kitA = createPublicDetailKit("a_detail_v1", fail, cloneAndFreezePlanData);
const kitB = createPublicDetailKit("b_detail_v1", fail, cloneAndFreezePlanData);

const SCOPE = Object.freeze({
  serverInstanceId: "s", connectionIndex: 0, connectionGeneration: 0, connectionName: "c", connectionFingerprint: "f",
  environmentKind: "demo", baseUrl: "https://example.invalid", verifiedCompanyIdentity: "acme", profile: "standard",
  catalogFingerprint: "cat", features: Object.freeze({
    enableLightyear: true, exposeGranularTools: false, exposeSetupTools: false, enableTaxTools: true,
    enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true,
  }),
}) as unknown as RuntimeSafetyScope;

interface Stored { readonly items: readonly PlanData[]; readonly scope: RuntimeSafetyScope; readonly issuedAt: number; readonly expiresAt: number }

function harness(overrides: { maxActive?: number; maxTombstones?: number; factory?: () => Uint8Array; proof?: boolean } = {}) {
  let now = 1_000;
  let scope = SCOPE;
  let counter = 0;
  const events: string[] = [];
  let proofValid = true;
  const store = new PublicDetailHandleStore<Stored>({
    getActiveScope: () => scope,
    now: () => now,
    handleFactory: overrides.factory ?? (() => createHash("sha256").update(`h${counter++}`).digest()),
    ttlMs: 100,
    maxActive: overrides.maxActive ?? 8,
    maxTombstones: overrides.maxTombstones ?? 8,
  }, {
    defaultTtlMs: 1, defaultMaxActive: 1, defaultMaxTombstones: 1,
    error: kind => new KindError(kind),
    detail: kitA,
    cloneAndFreezeData: value => cloneAndFreezePlanData(value) as readonly PlanData[],
    cloneScope: cloneRuntimeSafetyScope,
    scopesEqual: runtimeSafetyScopesEqual,
    ...(overrides.proof ? {
      retainProof: (stored: Stored) => { events.push(`retain:${stored.items.length}`); return () => events.push("release"); },
      assertProof: () => { if (!proofValid) throw new Error("gone"); },
    } : {}),
  });
  const issue = () => store.issue([kitA.create({ item_id: "1" })], fields => Object.freeze({ ...fields }));
  return {
    store, issue, events,
    setNow: (value: number) => { now = value; },
    setScope: (value: RuntimeSafetyScope) => { scope = value; },
    revokeProof: () => { proofValid = false; },
  };
}

const kindOf = (fn: () => unknown): string | undefined => {
  try { fn(); return undefined; } catch (error) { return error instanceof KindError ? error.kind : `other:${(error as Error).name}`; }
};

describe("public detail kit", () => {
  it("brands per kit, freezes, and rejects look-alikes and other kits' details", () => {
    const detail = kitA.create({ item_id: "1", nested: { label: "x" } });
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.data)).toBe(true);
    expect(detail.contract).toBe("a_detail_v1");
    expect(kitA.read(detail)).toEqual({ item_id: "1", nested: { label: "x" } });
    expect(kindOf(() => kitB.read(detail))).toBe("data_invalid");
    expect(kindOf(() => kitA.read({ contract: "a_detail_v1", data: { item_id: "1" } }))).toBe("data_invalid");
    expect(kindOf(() => kitA.read(new Proxy(detail, {})))).toBe("data_invalid");
  });

  it("rejects unsafe detail data through the caller's invalid()", () => {
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "x" });
    for (const bad of [{ password: "x" }, { unknown_field: 1 }, { amount: Number.NaN }, { text: "Bearer abc" },
      { values: ["delete_transaction"] }, accessor, new Proxy({}, {}), { nested: [1] }]) {
      expect(kindOf(() => kitA.create(bad as never))).toBe("data_invalid");
    }
  });

  it("projection check rejects cycles, symbols and subclassed arrays", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    class Sub extends Array {}
    for (const bad of [cyclic, { [Symbol("s")]: 1 }, Sub.from([1]), [new Proxy({}, {})]]) {
      expect(kindOf(() => assertPublicDetailProjection(bad, fail))).toBe("data_invalid");
    }
    expect(kindOf(() => assertPublicDetailProjection([{ a: 1 }, null, "x"], fail))).toBeUndefined();
  });
});

describe("readExactInputRecord", () => {
  it("returns exactly the expected data properties and rejects everything else", () => {
    expect(readExactInputRecord({ b: 2, a: 1 }, ["a", "b"], fail)).toEqual({ a: 1, b: 2 });
    for (const bad of [
      null, "x", [], new Proxy({ a: 1, b: 2 }, {}), Object.create({ a: 1, b: 2 }), { a: 1 }, { a: 1, b: 2, c: 3 },
      Object.defineProperty({ a: 1 }, "b", { enumerable: true, get: () => 2 }),
      Object.defineProperty({ a: 1 }, "b", { enumerable: false, value: 2 }),
      { a: 1, b: 2, [Symbol("s")]: 3 },
    ]) {
      expect(kindOf(() => readExactInputRecord(bad, ["a", "b"], fail))).toBe("data_invalid");
    }
  });
});

describe("PublicDetailHandleStore", () => {
  it("expires exactly at expiresAt (now >= expiresAt) and then reports expired, not invalid", () => {
    const h = harness();
    const handle = h.issue();
    h.setNow(1_099);
    expect(h.store.inspect(handle).expiresAt).toBe(1_100);
    h.setNow(1_100);
    expect(kindOf(() => h.store.inspect(handle))).toBe("expired");
    expect(kindOf(() => h.store.inspect(handle))).toBe("expired");
    expect(kindOf(() => h.store.inspect("A".repeat(43)))).toBe("handle_invalid");
    expect(kindOf(() => h.store.inspect("not-a-handle"))).toBe("handle_invalid");
  });

  it("evicts the oldest tombstone first", () => {
    const h = harness({ maxTombstones: 2 });
    const handles = [h.issue(), h.issue(), h.issue()];
    h.setNow(2_000);
    expect(h.store.activeCount).toBe(0);
    expect(kindOf(() => h.store.inspect(handles[0]!))).toBe("handle_invalid");
    expect(kindOf(() => h.store.inspect(handles[1]!))).toBe("expired");
    expect(kindOf(() => h.store.inspect(handles[2]!))).toBe("expired");
  });

  it("enforces capacity, binds scope, and never re-issues an active or tombstoned handle", () => {
    const fixed = createHash("sha256").update("same").digest();
    const h = harness({ maxActive: 1, factory: () => fixed });
    const handle = h.issue();
    expect(kindOf(() => h.issue())).toBe("capacity_exceeded");
    h.setScope({ ...SCOPE, connectionGeneration: 1 });
    expect(kindOf(() => h.store.inspect(handle))).toBe("scope_mismatch");
    h.setScope(SCOPE);
    h.setNow(1_100);
    expect(h.store.activeCount).toBe(0);
    expect(kindOf(() => h.issue())).toBe("handle_collision");
  });

  it("pins the external proof for the handle's lifetime and maps its failure to scope_mismatch", () => {
    const h = harness({ proof: true });
    const handle = h.issue();
    expect(h.events).toEqual(["retain:1"]);
    expect(h.store.inspect(handle).items).toHaveLength(1);
    h.revokeProof();
    expect(kindOf(() => h.store.inspect(handle))).toBe("scope_mismatch");
    h.setNow(1_100);
    expect(h.store.activeCount).toBe(0);
    expect(h.events).toEqual(["retain:1", "release"]);
  });

  it("releases the pinned proof when no handle can be allocated", () => {
    const h = harness({ proof: true, factory: () => new Uint8Array(31) });
    expect(kindOf(() => h.issue())).toBe("handle_collision");
    expect(h.events).toEqual(["retain:1", "release"]);
  });
});
