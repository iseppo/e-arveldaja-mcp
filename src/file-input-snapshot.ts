import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { resolveFileInput } from "./file-validation.js";
import { cloneAndFreezePlanData } from "./plan-store.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";

export const FILE_INPUT_IDENTITY_SCHEMA = "file_input_identity_v1" as const;

export interface FileInputIdentity {
  readonly schema: typeof FILE_INPUT_IDENTITY_SCHEMA;
  readonly source_kind: "local_path" | "inline_base64";
  readonly locator_sha256?: string;
  readonly digest_sha256: string;
  readonly size_bytes: number;
  readonly extension: string;
}

export type FileInputSnapshotErrorCode =
  | "file_input_changed"
  | "file_input_identity_invalid"
  | "file_input_source_invalid"
  | "file_input_unavailable";

const SAFE_MESSAGES: Readonly<Record<FileInputSnapshotErrorCode, string>> = Object.freeze({
  file_input_changed: "The file input no longer matches the reviewed source bytes.",
  file_input_identity_invalid: "The stored file-input identity is invalid.",
  file_input_source_invalid: "Provide exactly one direct file path/input or opaque file reference.",
  file_input_unavailable: "The file input could not be safely resolved and read.",
});

export class FileInputSnapshotError extends Error {
  readonly code: FileInputSnapshotErrorCode;

  constructor(code: FileInputSnapshotErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "FileInputSnapshotError";
    this.code = code;
  }
}

export interface FileInputSnapshotDependencies {
  readonly resolveFileInput?: typeof resolveFileInput;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export interface FileInputSource {
  readonly file_path?: string;
  readonly file_ref?: string;
}

export interface CaptureFileInputOptions {
  readonly runtimeSafetyContext: RuntimeSafetyContext;
  readonly operation: string;
  readonly allowedExtensions: readonly string[];
  readonly maxSize: number;
}

export class FileInputSnapshot {
  readonly identity: FileInputIdentity;
  readonly #content: Buffer;

  constructor(identity: FileInputIdentity, content: Uint8Array) {
    this.identity = Object.freeze({ ...identity });
    this.#content = Buffer.from(content);
    Object.freeze(this);
  }

  bytes(): Buffer {
    return Buffer.from(this.#content);
  }

  text(encoding: BufferEncoding = "utf8"): string {
    return this.#content.toString(encoding);
  }
}

function isInlineInput(input: string): boolean {
  return input.toLowerCase().startsWith("base64:");
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveSource(source: FileInputSource, options: CaptureFileInputOptions): {
  input: string;
  inline: boolean;
  expectedCanonicalPath?: string;
} {
  const hasPath = Object.prototype.hasOwnProperty.call(source, "file_path");
  const hasReference = Object.prototype.hasOwnProperty.call(source, "file_ref");
  if (hasPath === hasReference) throw new FileInputSnapshotError("file_input_source_invalid");
  if (hasReference) {
    if (typeof source.file_ref !== "string" || source.file_ref.length === 0) {
      throw new FileInputSnapshotError("file_input_source_invalid");
    }
    const canonicalPath = options.runtimeSafetyContext.fileReferenceStore.resolve(source.file_ref!, {
      kind: "file",
      operation: options.operation,
    });
    return {
      input: canonicalPath,
      inline: false,
      expectedCanonicalPath: canonicalPath,
    };
  }
  if (typeof source.file_path !== "string" || source.file_path.length === 0) {
    throw new FileInputSnapshotError("file_input_source_invalid");
  }
  const inline = isInlineInput(source.file_path!);
  if (!inline && !isAbsolute(source.file_path!)) {
    throw new FileInputSnapshotError("file_input_source_invalid");
  }
  return { input: source.file_path!, inline };
}

async function cleanupBestEffort(cleanup: (() => Promise<void>) | undefined): Promise<void> {
  if (!cleanup) return;
  try { await cleanup(); } catch { /* tmp cleanup must not mask source-read results */ }
}

export async function captureFileInputSnapshot(
  source: FileInputSource,
  options: CaptureFileInputOptions,
  dependencies: FileInputSnapshotDependencies = {},
): Promise<FileInputSnapshot> {
  const resolveInput = dependencies.resolveFileInput ?? resolveFileInput;
  const read = dependencies.readFile ?? (async path => readFile(path));
  let resolvedSource: ReturnType<typeof resolveSource>;
  try {
    resolvedSource = resolveSource(source, options);
  } catch (error) {
    if (error instanceof FileInputSnapshotError) throw error;
    throw new FileInputSnapshotError("file_input_unavailable");
  }
  const { input, inline, expectedCanonicalPath } = resolvedSource;
  const allowedExtensions = [...options.allowedExtensions];
  let resolved: Awaited<ReturnType<typeof resolveFileInput>>;
  try {
    resolved = await resolveInput(input, allowedExtensions, options.maxSize);
  } catch {
    throw new FileInputSnapshotError("file_input_unavailable");
  }
  if (expectedCanonicalPath !== undefined && resolved.path !== expectedCanonicalPath) {
    await cleanupBestEffort(resolved.cleanup);
    throw new FileInputSnapshotError("file_input_changed");
  }
  let content: Uint8Array;
  try {
    try {
      content = await read(resolved.path);
    } catch {
      throw new FileInputSnapshotError("file_input_unavailable");
    }
  } finally {
    await cleanupBestEffort(resolved.cleanup);
  }
  const immutable = Buffer.from(content);
  if (immutable.byteLength > options.maxSize) {
    throw new FileInputSnapshotError("file_input_identity_invalid");
  }
  const extension = extname(resolved.path).toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    throw new FileInputSnapshotError("file_input_identity_invalid");
  }
  return new FileInputSnapshot({
    schema: FILE_INPUT_IDENTITY_SCHEMA,
    source_kind: inline ? "inline_base64" : "local_path",
    ...(!inline ? { locator_sha256: digest(Buffer.from(resolved.path, "utf8")) } : {}),
    digest_sha256: digest(immutable),
    size_bytes: immutable.byteLength,
    extension,
  }, immutable);
}

function identitiesMatch(actual: FileInputIdentity, expected: FileInputIdentity): boolean {
  return actual.schema === expected.schema &&
    actual.source_kind === expected.source_kind &&
    actual.locator_sha256 === expected.locator_sha256 &&
    actual.digest_sha256 === expected.digest_sha256 &&
    actual.size_bytes === expected.size_bytes &&
    actual.extension === expected.extension;
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function validatedExpectedIdentity(
  candidate: unknown,
  options: CaptureFileInputOptions,
): FileInputIdentity {
  let cloned: unknown;
  try {
    // Reuse the descriptor/proxy-safe immutable-data reader used by execution
    // plans. This rejects accessors, proxies, cycles and unsafe prototypes
    // without evaluating attacker-controlled properties.
    cloned = cloneAndFreezePlanData(candidate);
  } catch {
    throw new FileInputSnapshotError("file_input_identity_invalid");
  }
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new FileInputSnapshotError("file_input_identity_invalid");
  }
  const record = cloned as Record<string, unknown>;
  const sourceKind = record.source_kind;
  const expectedKeys = sourceKind === "local_path"
    ? ["schema", "source_kind", "locator_sha256", "digest_sha256", "size_bytes", "extension"]
    : ["schema", "source_kind", "digest_sha256", "size_bytes", "extension"];
  const keys = Object.keys(record);
  if ((sourceKind !== "local_path" && sourceKind !== "inline_base64") ||
    keys.length !== expectedKeys.length || keys.some(key => !expectedKeys.includes(key)) ||
    record.schema !== FILE_INPUT_IDENTITY_SCHEMA ||
    typeof record.digest_sha256 !== "string" || !SHA256_HEX_PATTERN.test(record.digest_sha256) ||
    (sourceKind === "local_path" &&
      (typeof record.locator_sha256 !== "string" || !SHA256_HEX_PATTERN.test(record.locator_sha256))) ||
    typeof record.size_bytes !== "number" || !Number.isSafeInteger(record.size_bytes) ||
    record.size_bytes < 0 || record.size_bytes > options.maxSize ||
    typeof record.extension !== "string" || !options.allowedExtensions.includes(record.extension)) {
    throw new FileInputSnapshotError("file_input_identity_invalid");
  }
  return record as unknown as FileInputIdentity;
}

export async function assertMatchingFileInputSnapshot(
  source: FileInputSource,
  expectedIdentity: FileInputIdentity,
  options: CaptureFileInputOptions,
  dependencies: FileInputSnapshotDependencies = {},
): Promise<FileInputSnapshot> {
  const validatedIdentity = validatedExpectedIdentity(expectedIdentity, options);
  const snapshot = await captureFileInputSnapshot(source, options, dependencies);
  if (!identitiesMatch(snapshot.identity, validatedIdentity)) {
    throw new FileInputSnapshotError("file_input_changed");
  }
  return snapshot;
}
