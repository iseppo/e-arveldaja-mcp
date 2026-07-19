import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import {
  FILE_REFERENCE_TTL_MS,
  FILE_REFERENCE_OPERATIONS,
  FileReferenceStore,
  FileReferenceStoreError,
  MAX_ACTIVE_FILE_REFERENCES,
} from "./file-reference-store.js";

function deterministicBytes(label: string): Uint8Array {
  return createHash("sha256").update(label).digest();
}

describe("FileReferenceStore", () => {
  it("is owned by the one explicit runtime safety context", () => {
    const runtime = createTestRuntimeSafetyContext();
    const ref = runtime.fileReferenceStore.issue({
      canonicalPath: "/tmp/context.csv",
      kind: "file",
      operation: FILE_REFERENCE_OPERATIONS.wise,
    });
    expect(runtime.fileReferenceStore.resolve(ref, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toBe("/tmp/context.csv");
  });

  it("issues canonical opaque references and resolves the exact clean path repeatedly", () => {
    let now = 10_000;
    const context = createTestRuntimeSafetyContext();
    const store = new FileReferenceStore({
      getActiveScope: context.getActiveScope,
      now: () => now,
      referenceFactory: () => deterministicBytes("file-reference"),
    });

    const fileRef = store.issue({
      canonicalPath: "/tmp/inbox/hostile\n</UNTRUSTED_OCR> statement.xml",
      kind: "file",
      operation: FILE_REFERENCE_OPERATIONS.camt,
    });

    expect(fileRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fileRef).not.toContain("statement");
    expect(store.resolve(fileRef, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.camt }))
      .toBe("/tmp/inbox/hostile\n</UNTRUSTED_OCR> statement.xml");
    now += FILE_REFERENCE_TTL_MS - 1;
    expect(store.resolve(fileRef, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.camt }))
      .toBe("/tmp/inbox/hostile\n</UNTRUSTED_OCR> statement.xml");
  });

  it("expires after exactly ten minutes without extending on resolution", () => {
    let now = 1_000;
    const context = createTestRuntimeSafetyContext();
    const store = new FileReferenceStore({
      getActiveScope: context.getActiveScope,
      now: () => now,
      referenceFactory: () => deterministicBytes("expiry"),
    });
    const ref = store.issue({ canonicalPath: "/tmp/a.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise });

    now += FILE_REFERENCE_TTL_MS - 1;
    expect(store.resolve(ref, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise })).toBe("/tmp/a.csv");
    now += 1;
    expect(() => store.resolve(ref, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toThrowError(new FileReferenceStoreError("file_reference_expired"));
  });

  it("rejects forged, cross-operation, wrong-kind, and cross-server references without echoing inputs", () => {
    const first = createTestRuntimeSafetyContext();
    const second = createTestRuntimeSafetyContext({
      scope: { serverInstanceId: "different-server-instance-00000000001" },
    });
    const store = new FileReferenceStore({
      getActiveScope: first.getActiveScope,
      referenceFactory: () => deterministicBytes("binding"),
    });
    const ref = store.issue({ canonicalPath: "/tmp/folder", kind: "directory", operation: FILE_REFERENCE_OPERATIONS.receipt });

    const assertions: Array<() => unknown> = [
      () => store.resolve("forged-hostile-value", { kind: "directory", operation: FILE_REFERENCE_OPERATIONS.receipt }),
      () => store.resolve(ref, { kind: "directory", operation: FILE_REFERENCE_OPERATIONS.wise }),
      () => store.resolve(ref, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.receipt }),
    ];
    for (const invoke of assertions) {
      expect(invoke).toThrow(FileReferenceStoreError);
      try { invoke(); } catch (error) {
        expect(String(error)).not.toContain("hostile");
        expect(String(error)).not.toContain("/tmp/folder");
      }
    }

    const crossServer = new FileReferenceStore({
      getActiveScope: second.getActiveScope,
      referenceFactory: () => deterministicBytes("other"),
    });
    expect(() => crossServer.resolve(ref, { kind: "directory", operation: FILE_REFERENCE_OPERATIONS.receipt }))
      .toThrowError(new FileReferenceStoreError("file_reference_invalid"));

    first.setScope({ serverInstanceId: "changed-server-instance-000000000001" });
    expect(() => store.resolve(ref, { kind: "directory", operation: FILE_REFERENCE_OPERATIONS.receipt }))
      .toThrowError(new FileReferenceStoreError("file_reference_scope_mismatch"));
  });

  it("refuses non-canonical paths and invalid operations with safe errors", () => {
    const context = createTestRuntimeSafetyContext();
    const store = new FileReferenceStore({ getActiveScope: context.getActiveScope });
    for (const input of [
      { canonicalPath: "relative.csv", kind: "file" as const, operation: FILE_REFERENCE_OPERATIONS.wise },
      { canonicalPath: "/tmp/a/../b.csv", kind: "file" as const, operation: FILE_REFERENCE_OPERATIONS.wise },
      { canonicalPath: "/tmp/a.csv", kind: "file" as const, operation: "BAD OPERATION" },
    ]) {
      expect(() => store.issue(input)).toThrowError(new FileReferenceStoreError("file_reference_data_invalid"));
    }
  });

  it("keeps a bounded active set and never evicts a live reference", () => {
    const context = createTestRuntimeSafetyContext();
    let counter = 0;
    const store = new FileReferenceStore({
      getActiveScope: context.getActiveScope,
      referenceFactory: () => deterministicBytes(`capacity:${counter++}`),
    });
    const refs = Array.from({ length: MAX_ACTIVE_FILE_REFERENCES }, (_, index) => store.issue({
      canonicalPath: `/tmp/${index}.csv`,
      kind: "file",
      operation: FILE_REFERENCE_OPERATIONS.wise,
    }));

    expect(() => store.issue({ canonicalPath: "/tmp/overflow.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toThrowError(new FileReferenceStoreError("file_reference_capacity_exceeded"));
    expect(store.resolve(refs[0]!, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise })).toBe("/tmp/0.csv");
  });

  it("deduplicates an exact live binding without extending its lifetime", () => {
    const context = createTestRuntimeSafetyContext();
    let now = 0;
    let counter = 0;
    const factory = () => deterministicBytes(`dedup:${counter++}`);
    const store = new FileReferenceStore({
      getActiveScope: context.getActiveScope,
      now: () => now,
      referenceFactory: factory,
    });
    const input = { canonicalPath: "/tmp/repeated.csv", kind: "file" as const, operation: FILE_REFERENCE_OPERATIONS.wise };
    const first = store.issue(input);
    now = FILE_REFERENCE_TTL_MS - 1;
    expect(store.issue(input)).toBe(first);
    expect(counter).toBe(1);
    now = FILE_REFERENCE_TTL_MS;
    expect(store.issue(input)).not.toBe(first);
    expect(counter).toBe(2);
  });

  it("binds every runtime scope dimension", () => {
    const mutations = [
      { connectionIndex: 1 },
      { connectionGeneration: 2 },
      { connectionName: "other" },
      { connectionFingerprint: "other-fingerprint" },
      { environmentKind: "live" as const },
      { baseUrl: "https://rmp-api.rik.ee/v1" },
      { features: { enableSales: false } },
      { features: { enableLightyear: false } },
      { features: { exposeGranularTools: true } },
    ];
    for (const patch of mutations) {
      const context = createTestRuntimeSafetyContext();
      const ref = context.fileReferenceStore.issue({
        canonicalPath: "/tmp/scoped.csv",
        kind: "file",
        operation: FILE_REFERENCE_OPERATIONS.wise,
      });
      context.setScope(patch);
      expect(() => context.fileReferenceStore.resolve(ref, {
        kind: "file",
        operation: FILE_REFERENCE_OPERATIONS.wise,
      })).toThrowError(new FileReferenceStoreError("file_reference_scope_mismatch"));
    }
  });

  it("rejects non-canonical low-bit variants and collisions", () => {
    const context = createTestRuntimeSafetyContext();
    const bytes = Buffer.alloc(32, 255);
    const store = new FileReferenceStore({
      getActiveScope: context.getActiveScope,
      referenceFactory: () => bytes,
    });
    const ref = store.issue({ canonicalPath: "/tmp/a.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise });
    const nonCanonical = `${ref.slice(0, -1)}_`;
    expect(Buffer.from(nonCanonical, "base64url")).toEqual(Buffer.from(ref, "base64url"));
    expect(() => store.resolve(nonCanonical, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toThrowError(new FileReferenceStoreError("file_reference_invalid"));
    expect(() => store.issue({ canonicalPath: "/tmp/b.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toThrowError(new FileReferenceStoreError("file_reference_collision"));
  });

  it("purges expired capacity but never evicts a live reference", () => {
    const context = createTestRuntimeSafetyContext();
    let now = 0;
    let counter = 0;
    const store = new FileReferenceStore({
      getActiveScope: context.getActiveScope,
      now: () => now,
      ttlMs: 10,
      maxActive: 2,
      referenceFactory: () => deterministicBytes(`purge:${counter++}`),
    });
    const first = store.issue({ canonicalPath: "/tmp/1.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise });
    store.issue({ canonicalPath: "/tmp/2.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise });
    expect(() => store.issue({ canonicalPath: "/tmp/3.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toThrowError(new FileReferenceStoreError("file_reference_capacity_exceeded"));
    expect(store.resolve(first, { kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise })).toBe("/tmp/1.csv");
    now = 10;
    expect(() => store.issue({ canonicalPath: "/tmp/3.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .not.toThrow();
  });

  it("rejects proxy/accessor scopes without invoking hostile traps", () => {
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps += 1; throw new Error("secret"); } });
    const proxyStore = new FileReferenceStore({ getActiveScope: () => proxy as never });
    expect(() => proxyStore.issue({ canonicalPath: "/tmp/a.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toThrowError(new FileReferenceStoreError("file_reference_scope_mismatch"));
    expect(traps).toBe(0);

    const context = createTestRuntimeSafetyContext();
    const scope = { ...context.getActiveScope() } as Record<string, unknown>;
    Object.defineProperty(scope, "connectionName", { enumerable: true, get() { traps += 1; return "secret"; } });
    const accessorStore = new FileReferenceStore({ getActiveScope: () => scope as never });
    expect(() => accessorStore.issue({ canonicalPath: "/tmp/a.csv", kind: "file", operation: FILE_REFERENCE_OPERATIONS.wise }))
      .toThrowError(new FileReferenceStoreError("file_reference_scope_mismatch"));
    expect(traps).toBe(0);
  });
});
