import { createHash } from "node:crypto";
import { extname, isAbsolute } from "node:path";
import { readFileCapped } from "./bounded-read.js";
import { resolveFileInput } from "./file-validation.js";
import { FileReferenceStoreError } from "./file-reference-store.js";
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
  | "file_input_unavailable"
  | "file_input_reference_mismatch"
  | "file_input_reference_expired"
  | "file_input_reference_invalid"
  | "file_input_reference_scope_mismatch";

const SAFE_MESSAGES: Readonly<Record<FileInputSnapshotErrorCode, string>> = Object.freeze({
  file_input_changed: "The file input no longer matches the reviewed source bytes.",
  file_input_identity_invalid: "The stored file-input identity is invalid.",
  file_input_source_invalid: "Provide exactly one direct file path/input or opaque file reference.",
  file_input_unavailable: "The file input could not be safely resolved and read.",
  file_input_reference_mismatch: "The file reference was issued for a different tool or input kind. Use the file_ref from the accounting_inbox recommended step for this tool (guided: process_bank_input), or pass file_path.",
  file_input_reference_expired: "The file reference has expired. Re-run accounting_inbox for a fresh reference, or pass file_path.",
  file_input_reference_invalid: "The file reference is unknown or expired. Re-run accounting_inbox for a fresh reference, or pass file_path.",
  file_input_reference_scope_mismatch: "The file reference was issued for another connection or runtime scope. Re-run accounting_inbox for a fresh reference, or pass file_path.",
});

/** A file-reference store rejection, mapped before anything is read. Refs are
 * random 256-bit handles, so naming "issued for another operation" separately
 * from "unknown" reveals nothing enumerable. */
function fileReferenceErrorCode(error: unknown): FileInputSnapshotErrorCode {
  if (!(error instanceof FileReferenceStoreError)) return "file_input_unavailable";
  switch (error.code) {
    case "file_reference_operation_mismatch":
    case "file_reference_kind_mismatch":
      return "file_input_reference_mismatch";
    case "file_reference_invalid":
      return "file_input_reference_invalid";
    case "file_reference_expired":
      return "file_input_reference_expired";
    case "file_reference_scope_mismatch":
      return "file_input_reference_scope_mismatch";
    default:
      return "file_input_unavailable";
  }
}

/**
 * Whether repeating the identical call could ever produce a different outcome.
 * Only `file_input_unavailable` can: the source was not readable this time and
 * may be next (a transient IO or permission condition). The others name a
 * mismatch — changed bytes, a malformed identity, a bad source combination, a
 * file reference for another tool or an expired one — that the caller must fix
 * first, so a bare retry is pointless.
 */
export function fileInputSnapshotRetry(code: FileInputSnapshotErrorCode): "never" | "unknown" {
  return code === "file_input_unavailable" ? "unknown" : "never";
}

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

/** The source's file_path when it may be echoed back to the caller: a path,
 * not an inline `base64:` payload. */
export function echoableSourcePath(source: FileInputSource): string | undefined {
  return source.file_path !== undefined && !source.file_path.toLowerCase().startsWith("base64:")
    ? source.file_path
    : undefined;
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
  readonly #canonicalPath: string | undefined;

  constructor(identity: FileInputIdentity, content: Uint8Array, canonicalPath?: string) {
    this.identity = Object.freeze({ ...identity });
    this.#content = Buffer.from(content);
    this.#canonicalPath = canonicalPath;
    Object.freeze(this);
  }

  /** The resolved local path that was read (undefined for inline input). Kept
   * private to the process: plans store it only in `privatePayload`. */
  canonicalPath(): string | undefined {
    return this.#canonicalPath;
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
  expectedSha256?: string;
} {
  const hasPath = Object.prototype.hasOwnProperty.call(source, "file_path");
  const hasReference = Object.prototype.hasOwnProperty.call(source, "file_ref");
  if (hasPath === hasReference) throw new FileInputSnapshotError("file_input_source_invalid");
  if (hasReference) {
    if (typeof source.file_ref !== "string" || source.file_ref.length === 0) {
      throw new FileInputSnapshotError("file_input_source_invalid");
    }
    const { canonicalPath, expectedSha256 } = options.runtimeSafetyContext.fileReferenceStore.resolveBound(source.file_ref!, {
      kind: "file",
      operation: options.operation,
    });
    return {
      input: canonicalPath,
      inline: false,
      expectedCanonicalPath: canonicalPath,
      ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
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
  const read = dependencies.readFile ?? (async path => readFileCapped(path, options.maxSize));
  let resolvedSource: ReturnType<typeof resolveSource>;
  try {
    resolvedSource = resolveSource(source, options);
  } catch (error) {
    if (error instanceof FileInputSnapshotError) throw error;
    throw new FileInputSnapshotError(fileReferenceErrorCode(error));
  }
  const { input, inline, expectedCanonicalPath, expectedSha256 } = resolvedSource;
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
  // A reference bound to reviewed bytes refuses any other content.
  if (expectedSha256 !== undefined && digest(immutable) !== expectedSha256) {
    throw new FileInputSnapshotError("file_input_changed");
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
  }, immutable, inline ? undefined : resolved.path);
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

export type FileInputIdentityOptions = Pick<CaptureFileInputOptions, "allowedExtensions" | "maxSize">;

function validatedExpectedIdentity(
  candidate: unknown,
  options: FileInputIdentityOptions,
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

/**
 * The one dry-run→execute source check: an already-captured snapshot must
 * match the identity the reviewed plan bound (schema, source kind, canonical
 * locator, digest, size, extension). Throws `file_input_identity_invalid` for a
 * malformed stored identity and `file_input_changed` for any field mismatch —
 * so equal bytes at a different canonical path are refused too. Sites that
 * already hold the snapshot they parse call this directly (no second read).
 */
export function assertFileInputSnapshotIdentity(
  snapshot: FileInputSnapshot,
  expectedIdentity: unknown,
  options: FileInputIdentityOptions,
): FileInputSnapshot {
  const validatedIdentity = validatedExpectedIdentity(expectedIdentity, options);
  if (!identitiesMatch(snapshot.identity, validatedIdentity)) {
    throw new FileInputSnapshotError("file_input_changed");
  }
  return snapshot;
}

export async function assertMatchingFileInputSnapshot(
  source: FileInputSource,
  expectedIdentity: FileInputIdentity,
  options: CaptureFileInputOptions,
  dependencies: FileInputSnapshotDependencies = {},
): Promise<FileInputSnapshot> {
  // Validate before any IO so a malformed identity never triggers a read.
  const validatedIdentity = validatedExpectedIdentity(expectedIdentity, options);
  const snapshot = await captureFileInputSnapshot(source, options, dependencies);
  return assertFileInputSnapshotIdentity(snapshot, validatedIdentity, options);
}

/** Why an execute-time source re-read failed, for a `plan_drift` answer. */
export type SourceReReadFailureReason =
  | "file_ref_expired"
  | "file_ref_scope_changed"
  | "file_ref_mismatch"
  | "file_unavailable"
  | "file_changed"
  | "source_invalid";

const RE_READ_FAILURE_MESSAGES: Readonly<Record<SourceReReadFailureReason, string>> = Object.freeze({
  file_ref_expired: "the file reference has expired and the reviewed file could not be re-read in its place; re-run the dry run with a fresh file_ref or with file_path",
  file_ref_scope_changed: "the file reference belongs to another connection or runtime scope; re-run the dry run in this scope",
  file_ref_mismatch: "the file reference was issued for another tool or input kind, or differs from the one the plan reviewed",
  file_unavailable: "the reviewed file could not be read (moved, deleted or unreadable)",
  file_changed: "the reviewed file's bytes or location changed since the dry run",
  source_invalid: "the source arguments are invalid (pass exactly one of file_path / file_ref)",
});

/** One mapping from a re-read failure to the `plan_drift` reason and message,
 * shared by every execute path. */
export function describeSourceReReadFailure(code: FileInputSnapshotErrorCode): {
  reason: SourceReReadFailureReason;
  message: string;
} {
  const reason: SourceReReadFailureReason =
    code === "file_input_reference_expired" || code === "file_input_reference_invalid" ? "file_ref_expired" :
    code === "file_input_reference_scope_mismatch" ? "file_ref_scope_changed" :
    code === "file_input_reference_mismatch" ? "file_ref_mismatch" :
    code === "file_input_unavailable" ? "file_unavailable" :
    code === "file_input_changed" ? "file_changed" :
    "source_invalid";
  return { reason, message: RE_READ_FAILURE_MESSAGES[reason] };
}

/** The private plan binding of a `file_ref` source: the ref string, its
 * operation and the canonical path the dry run read. */
export interface PlanBoundFileReference {
  readonly file_ref: string;
  readonly operation: string;
  readonly kind: "file";
  readonly canonical_path: string;
}

/** The binding a dry run stores in `privatePayload.source_paths[i]`; null for
 * a direct `file_path` source (nothing to fall back to). */
export function planBoundFileReference(
  source: FileInputSource,
  snapshot: FileInputSnapshot,
  operation: string,
): { readonly [key: string]: string } | null {
  const canonicalPath = snapshot.canonicalPath();
  if (typeof source.file_ref !== "string" || canonicalPath === undefined) return null;
  return { file_ref: source.file_ref, operation, kind: "file", canonical_path: canonicalPath };
}

/** `privatePayload.source_paths` of a stored plan, if present. */
export function storedSourceBindings(privatePayload: unknown): readonly unknown[] {
  if (typeof privatePayload !== "object" || privatePayload === null || Array.isArray(privatePayload)) return [];
  const bindings = (privatePayload as { readonly source_paths?: unknown }).source_paths;
  return Array.isArray(bindings) ? bindings : [];
}

function validBinding(candidate: unknown): PlanBoundFileReference | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  return typeof record.file_ref === "string" && typeof record.operation === "string" && record.kind === "file" &&
    typeof record.canonical_path === "string" && isAbsolute(record.canonical_path)
    ? record as unknown as PlanBoundFileReference
    : undefined;
}

/**
 * Execute-time re-read of a source the consumed plan reviewed. Resolves the
 * `file_ref` as usual; only when that ref is byte-equal to the one the plan
 * bound, for the same operation, and the store says it expired (or no longer
 * knows it — an expired ref is purged by the next issue), the reviewed
 * canonical path is read instead. A different ref, a scope / operation / kind
 * mismatch never falls back. The caller still checks the plan's identity
 * (locator, digest, size, extension), which proves it is the reviewed file.
 */
export async function capturePlanBoundFileInputSnapshot(
  source: FileInputSource,
  binding: unknown,
  options: CaptureFileInputOptions,
  dependencies: FileInputSnapshotDependencies = {},
): Promise<FileInputSnapshot> {
  try {
    return await captureFileInputSnapshot(source, options, dependencies);
  } catch (error) {
    const bound = validBinding(binding);
    if (
      error instanceof FileInputSnapshotError &&
      (error.code === "file_input_reference_expired" || error.code === "file_input_reference_invalid") &&
      bound !== undefined &&
      Object.prototype.hasOwnProperty.call(source, "file_ref") &&
      !Object.prototype.hasOwnProperty.call(source, "file_path") &&
      source.file_ref === bound.file_ref &&
      bound.operation === options.operation
    ) {
      return captureFileInputSnapshot({ file_path: bound.canonical_path }, options, dependencies);
    }
    throw error;
  }
}
