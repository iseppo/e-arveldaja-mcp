import { isAbsolute, resolve } from "node:path";
import { encodeStoreHandle, isCanonicalStoreHandle, MAX_STORE_HANDLE_ATTEMPTS, randomStoreHandleBytes } from "./handle-store-core.js";
import type { RuntimeSafetyScope } from "./runtime-safety-context.js";
import { cloneRuntimeSafetyScope, runtimeSafetyScopesEqual } from "./plan-store.js";

export const FILE_REFERENCE_TTL_MS = 600_000;
export const MAX_ACTIVE_FILE_REFERENCES = 128;
export const FILE_REFERENCE_OPERATIONS = Object.freeze({
  camt: "camt_input",
  wise: "wise_input",
  bank: "bank_input",
  receipt: "receipt_input",
  lightyearStatement: "lightyear_statement_input",
  lightyearGains: "lightyear_gains_input",
} as const);

const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const MAX_CANONICAL_PATH_CHARS = 4_096;

export type FileReferenceKind = "file" | "directory";

export type FileReferenceStoreErrorCode =
  | "file_reference_capacity_exceeded"
  | "file_reference_invalid"
  | "file_reference_expired"
  | "file_reference_operation_mismatch"
  | "file_reference_kind_mismatch"
  | "file_reference_scope_mismatch"
  | "file_reference_path_changed"
  | "file_reference_data_invalid"
  | "file_reference_collision";

const SAFE_MESSAGES: Readonly<Record<FileReferenceStoreErrorCode, string>> = Object.freeze({
  file_reference_capacity_exceeded: "The file-reference store is full. Wait for a reference to expire.",
  file_reference_invalid: "The file reference is invalid or unknown.",
  file_reference_expired: "The file reference has expired.",
  file_reference_operation_mismatch: "The file reference belongs to a different operation.",
  file_reference_kind_mismatch: "The file reference has the wrong input kind.",
  file_reference_scope_mismatch: "The file reference no longer matches the active runtime scope.",
  file_reference_path_changed: "The referenced filesystem location no longer resolves to the reviewed path.",
  file_reference_data_invalid: "The file reference contains invalid data.",
  file_reference_collision: "Unable to allocate a unique file reference.",
});

export class FileReferenceStoreError extends Error {
  readonly code: FileReferenceStoreErrorCode;

  constructor(code: FileReferenceStoreErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "FileReferenceStoreError";
    this.code = code;
  }
}

export interface FileReferenceStoreOptions {
  readonly getActiveScope: () => RuntimeSafetyScope;
  readonly now?: () => number;
  readonly referenceFactory?: () => Uint8Array;
  readonly ttlMs?: number;
  readonly maxActive?: number;
}

export interface IssueFileReferenceInput {
  readonly canonicalPath: string;
  readonly kind: FileReferenceKind;
  readonly operation: string;
}

export interface ResolveFileReferenceInput {
  readonly kind: FileReferenceKind;
  readonly operation: string;
}

interface StoredFileReference extends IssueFileReferenceInput {
  readonly scope: RuntimeSafetyScope;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function validateOperation(operation: string): void {
  if (typeof operation !== "string" || !OPERATION_PATTERN.test(operation)) {
    throw new FileReferenceStoreError("file_reference_data_invalid");
  }
}

function validateCanonicalPath(canonicalPath: string): void {
  if (typeof canonicalPath !== "string" || canonicalPath.length === 0 ||
    canonicalPath.length > MAX_CANONICAL_PATH_CHARS || canonicalPath.includes("\0") ||
    !isAbsolute(canonicalPath) || resolve(canonicalPath) !== canonicalPath) {
    throw new FileReferenceStoreError("file_reference_data_invalid");
  }
}

export class FileReferenceStore {
  readonly #active = new Map<string, StoredFileReference>();
  readonly #getActiveScope: () => RuntimeSafetyScope;
  readonly #now: () => number;
  readonly #referenceFactory: () => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxActive: number;

  constructor(options: FileReferenceStoreOptions) {
    this.#getActiveScope = options.getActiveScope;
    this.#now = options.now ?? Date.now;
    this.#referenceFactory = options.referenceFactory ?? randomStoreHandleBytes;
    this.#ttlMs = options.ttlMs ?? FILE_REFERENCE_TTL_MS;
    this.#maxActive = options.maxActive ?? MAX_ACTIVE_FILE_REFERENCES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 ||
      !Number.isSafeInteger(this.#maxActive) || this.#maxActive <= 0) {
      throw new FileReferenceStoreError("file_reference_data_invalid");
    }
  }

  #activeScope(): RuntimeSafetyScope {
    try {
      return cloneRuntimeSafetyScope(this.#getActiveScope());
    } catch {
      throw new FileReferenceStoreError("file_reference_scope_mismatch");
    }
  }

  #deleteExpired(now: number): void {
    for (const [reference, entry] of this.#active) {
      if (now >= entry.expiresAt) this.#active.delete(reference);
    }
  }

  issue(input: IssueFileReferenceInput): string {
    validateCanonicalPath(input.canonicalPath);
    validateOperation(input.operation);
    if (input.kind !== "file" && input.kind !== "directory") {
      throw new FileReferenceStoreError("file_reference_data_invalid");
    }
    const now = this.#now();
    if (!Number.isSafeInteger(now)) throw new FileReferenceStoreError("file_reference_data_invalid");
    this.#deleteExpired(now);
    const scope = this.#activeScope();
    for (const [reference, entry] of this.#active) {
      if (entry.canonicalPath === input.canonicalPath && entry.kind === input.kind &&
        entry.operation === input.operation && runtimeSafetyScopesEqual(entry.scope, scope)) {
        return reference;
      }
    }
    if (this.#active.size >= this.#maxActive) {
      throw new FileReferenceStoreError("file_reference_capacity_exceeded");
    }
    for (let attempt = 0; attempt < MAX_STORE_HANDLE_ATTEMPTS; attempt += 1) {
      const reference = encodeStoreHandle(this.#referenceFactory());
      if (reference === undefined) throw new FileReferenceStoreError("file_reference_collision");
      if (this.#active.has(reference)) continue;
      this.#active.set(reference, Object.freeze({
        canonicalPath: input.canonicalPath,
        kind: input.kind,
        operation: input.operation,
        scope,
        issuedAt: now,
        expiresAt: now + this.#ttlMs,
      }));
      return reference;
    }
    throw new FileReferenceStoreError("file_reference_collision");
  }

  resolve(reference: string, expected: ResolveFileReferenceInput): string {
    if (!isCanonicalStoreHandle(reference)) {
      throw new FileReferenceStoreError("file_reference_invalid");
    }
    validateOperation(expected.operation);
    if (expected.kind !== "file" && expected.kind !== "directory") {
      throw new FileReferenceStoreError("file_reference_data_invalid");
    }
    const entry = this.#active.get(reference);
    if (!entry) throw new FileReferenceStoreError("file_reference_invalid");
    const now = this.#now();
    if (now >= entry.expiresAt) {
      this.#active.delete(reference);
      throw new FileReferenceStoreError("file_reference_expired");
    }
    if (entry.operation !== expected.operation) {
      throw new FileReferenceStoreError("file_reference_operation_mismatch");
    }
    if (entry.kind !== expected.kind) {
      throw new FileReferenceStoreError("file_reference_kind_mismatch");
    }
    if (!runtimeSafetyScopesEqual(entry.scope, this.#activeScope())) {
      throw new FileReferenceStoreError("file_reference_scope_mismatch");
    }
    return entry.canonicalPath;
  }
}
