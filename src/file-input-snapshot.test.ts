import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import { FILE_REFERENCE_OPERATIONS } from "./file-reference-store.js";
import {
  FILE_INPUT_IDENTITY_SCHEMA,
  FileInputSnapshotError,
  assertMatchingFileInputSnapshot,
  captureFileInputSnapshot,
} from "./file-input-snapshot.js";

const roots: string[] = [];
const runtime = () => createTestRuntimeSafetyContext();
const csvOptions = (runtimeSafetyContext = runtime()) => ({
  runtimeSafetyContext,
  operation: FILE_REFERENCE_OPERATIONS.wise,
  allowedExtensions: [".csv"],
  maxSize: 1024,
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("captureFileInputSnapshot", () => {
  it("reads a validated local file exactly once and returns immutable byte copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-snapshot-"));
    roots.push(root);
    const path = join(root, "statement.csv");
    await writeFile(path, "first");
    const read = vi.fn(readFile);

    const snapshot = await captureFileInputSnapshot({ file_path: path }, csvOptions(), { readFile: read });
    await writeFile(path, "changed");
    const firstCopy = snapshot.bytes();
    firstCopy.fill(0);

    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshot.text()).toBe("first");
    expect(snapshot.bytes().toString("utf8")).toBe("first");
    expect(snapshot.identity).toMatchObject({
      schema: "file_input_identity_v1",
      source_kind: "local_path",
      size_bytes: 5,
      extension: ".csv",
      locator_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(snapshot.identity).not.toHaveProperty("canonical_path");
    expect(JSON.stringify(snapshot.identity)).not.toContain(path);
    expect(Object.isFrozen(snapshot.identity)).toBe(true);
  });

  it("cleans up materialized base64 immediately after its single read", async () => {
    const cleanup = vi.fn(async () => undefined);
    const resolveInput = vi.fn(async () => ({ path: "/tmp/materialized.csv", cleanup }));
    const read = vi.fn(async () => Buffer.from("a,b\n1,2\n"));

    const snapshot = await captureFileInputSnapshot({ file_path: "base64:csv:YSxiCjEsMgo=" }, csvOptions(), {
      resolveFileInput: resolveInput,
      readFile: read,
    });

    expect(resolveInput).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(snapshot.identity).toMatchObject({ source_kind: "inline_base64", size_bytes: 8, extension: ".csv" });
    expect(snapshot.identity).not.toHaveProperty("locator_sha256");
    expect(JSON.stringify(snapshot.identity)).not.toContain("YSxi");
    expect(JSON.stringify(snapshot)).not.toContain("YSxi");
  });

  it("cleans up materialized base64 when the single read fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(captureFileInputSnapshot({ file_path: "base64:csv:AAAA" }, csvOptions(), {
      resolveFileInput: async () => ({ path: "/tmp/materialized.csv", cleanup }),
      readFile: async () => { throw new Error("read failed"); },
    })).rejects.toThrowError(new FileInputSnapshotError("file_input_unavailable"));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("accepts matching inline resubmission and rejects changed bytes with a safe error", async () => {
    const expected = await captureFileInputSnapshot({ file_path: "base64:csv:YSxiCg==" }, csvOptions());
    const matching = await assertMatchingFileInputSnapshot(
      { file_path: "base64:csv:YSxiCg==" },
      expected.identity,
      csvOptions(),
    );
    expect(matching.text()).toBe("a,b\n");

    await expect(assertMatchingFileInputSnapshot(
      { file_path: "base64:csv:YSxjCg==" },
      expected.identity,
      csvOptions(),
    )).rejects.toThrowError(new FileInputSnapshotError("file_input_changed"));
  });

  it("rejects hostile or malformed expected identities without invoking accessors", async () => {
    let proxyTraps = 0;
    const hostileProxy = new Proxy({}, {
      get() {
        proxyTraps += 1;
        throw new Error("hostile identity secret");
      },
    });
    const hostileAccessor = Object.defineProperty({}, "schema", {
      enumerable: true,
      get() {
        throw new Error("hostile identity secret");
      },
    });

    for (const expected of [hostileProxy, hostileAccessor, {
      schema: FILE_INPUT_IDENTITY_SCHEMA,
      source_kind: "local_path",
      locator_sha256: "not-a-digest",
      digest_sha256: "also-not-a-digest",
      size_bytes: -1,
      extension: "csv",
    }]) {
      await expect(assertMatchingFileInputSnapshot(
        { file_path: "base64:csv:YSxiCg==" },
        expected as any,
        csvOptions(),
      )).rejects.toThrowError(new FileInputSnapshotError("file_input_identity_invalid"));
    }
    expect(proxyTraps).toBe(0);
  });

  it("resolves a same-context file_ref then revalidates and snapshots the exact file", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-ref-snapshot-"));
    roots.push(root);
    const path = join(root, "statement.csv");
    await writeFile(path, "a,b\n");
    const context = runtime();
    const fileRef = context.fileReferenceStore.issue({
      canonicalPath: path,
      kind: "file",
      operation: FILE_REFERENCE_OPERATIONS.wise,
    });

    const snapshot = await captureFileInputSnapshot({ file_ref: fileRef }, csvOptions(context));
    expect(snapshot.text()).toBe("a,b\n");
    expect(snapshot.identity.source_kind).toBe("local_path");

    const direct = await captureFileInputSnapshot({ file_path: path }, csvOptions(context));
    expect(snapshot.identity).toEqual(direct.identity);
  });

  it("requires exactly one direct file_path or file_ref", async () => {
    const context = runtime();
    const ref = context.fileReferenceStore.issue({
      canonicalPath: "/tmp/a.csv",
      kind: "file",
      operation: FILE_REFERENCE_OPERATIONS.wise,
    });
    await expect(captureFileInputSnapshot({}, csvOptions(context)))
      .rejects.toThrowError(new FileInputSnapshotError("file_input_source_invalid"));
    await expect(captureFileInputSnapshot({ file_path: "/tmp/a.csv", file_ref: ref }, csvOptions(context)))
      .rejects.toThrowError(new FileInputSnapshotError("file_input_source_invalid"));
    await expect(captureFileInputSnapshot({ file_path: "", file_ref: ref }, csvOptions(context)))
      .rejects.toThrowError(new FileInputSnapshotError("file_input_source_invalid"));
    await expect(captureFileInputSnapshot({ file_path: "/tmp/a.csv", file_ref: "" }, csvOptions(context)))
      .rejects.toThrowError(new FileInputSnapshotError("file_input_source_invalid"));
    await expect(captureFileInputSnapshot({ file_path: "relative.csv" }, csvOptions(context)))
      .rejects.toThrowError(new FileInputSnapshotError("file_input_source_invalid"));
  });

  it("does not let cleanup failure mask bytes or the original read failure", async () => {
    const cleanup = vi.fn(async () => { throw new Error("cleanup failed"); });
    const options = csvOptions();
    const success = await captureFileInputSnapshot({ file_path: "base64:csv:YSxiCg==" }, options, {
      resolveFileInput: async () => ({ path: "/tmp/materialized.csv", cleanup }),
      readFile: async () => Buffer.from("a,b\n"),
    });
    expect(success.text()).toBe("a,b\n");

    await expect(captureFileInputSnapshot({ file_path: "base64:csv:YSxiCg==" }, options, {
      resolveFileInput: async () => ({ path: "/tmp/materialized.csv", cleanup }),
      readFile: async () => { throw new Error("original read failed"); },
    })).rejects.toThrowError(new FileInputSnapshotError("file_input_unavailable"));
  });

  it("keeps a 10 MiB inline source identity small and free of source bytes", async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const snapshot = await captureFileInputSnapshot({ file_path: "base64:csv:placeholder" }, {
      ...csvOptions(),
      maxSize: bytes.length,
    }, {
      resolveFileInput: async () => ({ path: "/tmp/materialized.csv", cleanup: async () => undefined }),
      readFile: async () => bytes,
    });
    expect(snapshot.identity.size_bytes).toBe(bytes.length);
    expect(JSON.stringify(snapshot.identity).length).toBeLessThan(512);
    expect(JSON.stringify(snapshot)).not.toContain("aaaa");
  });

  it("treats equal bytes at a different canonical local path as changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-identity-path-"));
    roots.push(root);
    const first = join(root, "first.csv");
    const second = join(root, "second.csv");
    await writeFile(first, "a,b\n");
    await writeFile(second, "a,b\n");
    const expected = await captureFileInputSnapshot({ file_path: first }, csvOptions());
    await expect(assertMatchingFileInputSnapshot({ file_path: second }, expected.identity, csvOptions()))
      .rejects.toThrowError(new FileInputSnapshotError("file_input_changed"));
  });

  it("rejects ref retarget, wrong binding, expiry, and forgery before reading", async () => {
    const context = runtime();
    const read = vi.fn(async () => Buffer.from("secret"));
    const fileRef = context.fileReferenceStore.issue({
      canonicalPath: "/tmp/exact.csv",
      kind: "file",
      operation: FILE_REFERENCE_OPERATIONS.wise,
    });
    await expect(captureFileInputSnapshot({ file_ref: fileRef }, csvOptions(context), {
      resolveFileInput: async () => ({ path: "/tmp/retargeted.csv" }),
      readFile: read,
    })).rejects.toThrowError(new FileInputSnapshotError("file_input_changed"));

    const wrongKind = context.fileReferenceStore.issue({
      canonicalPath: "/tmp/folder",
      kind: "directory",
      operation: FILE_REFERENCE_OPERATIONS.receipt,
    });
    for (const [source, options] of [
      [{ file_ref: fileRef }, { ...csvOptions(context), operation: FILE_REFERENCE_OPERATIONS.camt }],
      [{ file_ref: wrongKind }, csvOptions(context)],
      [{ file_ref: "forged-hostile-ref" }, csvOptions(context)],
    ] as const) {
      await expect(captureFileInputSnapshot(source, options, { readFile: read }))
        .rejects.toThrowError(new FileInputSnapshotError("file_input_unavailable"));
    }
    context.advanceTime(600_000);
    await expect(captureFileInputSnapshot({ file_ref: fileRef }, csvOptions(context), { readFile: read }))
      .rejects.toThrowError(new FileInputSnapshotError("file_input_unavailable"));
    expect(read).not.toHaveBeenCalled();
  });
});
