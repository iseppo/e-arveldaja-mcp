import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import { cloneAndFreezePlanData, type PlanData } from "./plan-store.js";
import type { RuntimeSafetyScope } from "./runtime-safety-context.js";

export const OPERATION_RESULT_TTL_MS = 600_000;
export const MAX_ACTIVE_OPERATION_RESULTS = 128;
export const MAX_OPERATION_RESULT_TOMBSTONES = 512;
const HANDLE_BYTES = 32;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_HANDLE_ATTEMPTS = 16;
const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const FORBIDDEN_KEYS = new Set([
  "password", "apikey", "apikeyid", "apipublicvalue", "apipassword", "credential", "credentials", "secret", "token", "authorization",
  "privatepayload", "normalizedargs", "sourceidentities", "livesnapshot", "planhandle",
  "command", "commands", "executable", "tool", "args",
  "approved", "approval", "approvalrequired", "approvalstate",
  "__proto__", "constructor", "prototype",
]);

export type OperationResultStatus = "completed" | "partial" | "indeterminate" | "failed";
export interface OperationResultInput {
  readonly operation: string;
  readonly status: OperationResultStatus;
  readonly items: readonly unknown[];
}
export interface StoredOperationResult {
  readonly operation: string;
  readonly status: OperationResultStatus;
  readonly items: readonly PlanData[];
  readonly scope: RuntimeSafetyScope;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export type OperationResultStoreErrorCode =
  | "operation_result_capacity_exceeded" | "operation_result_handle_invalid" | "operation_result_expired"
  | "operation_result_scope_mismatch" | "operation_result_data_invalid" | "operation_result_handle_collision";

const MESSAGES: Readonly<Record<OperationResultStoreErrorCode, string>> = Object.freeze({
  operation_result_capacity_exceeded: "The operation-result store is full. Wait for a result to expire.",
  operation_result_handle_invalid: "The operation-result handle is invalid or unknown.",
  operation_result_expired: "The operation-result handle has expired.",
  operation_result_scope_mismatch: "The operation-result handle no longer matches the active runtime scope.",
  operation_result_data_invalid: "The operation result contains unsafe or oversized data.",
  operation_result_handle_collision: "Unable to allocate a unique operation-result handle.",
});

export class OperationResultStoreError extends Error {
  constructor(readonly code: OperationResultStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = "OperationResultStoreError";
  }
}

export interface OperationResultStoreOptions {
  readonly getActiveScope: () => RuntimeSafetyScope;
  readonly now?: () => number;
  readonly handleFactory?: () => Uint8Array;
  readonly ttlMs?: number;
  readonly maxActive?: number;
  readonly maxTombstones?: number;
}

function invalid(): never { throw new OperationResultStoreError("operation_result_data_invalid"); }
function normalizedKey(key: string): string { return key.replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function forbiddenKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return FORBIDDEN_KEYS.has(normalized) ||
    /(?:token|secret|password|credential|apikey)/.test(normalized) ||
    normalized.includes("approval") || normalized.includes("executionplan") ||
    normalized.startsWith("command") || normalized.startsWith("tool") ||
    normalized === "arguments";
}

function assertPublicProjection(value: unknown): void {
  const active = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (utilTypes.isProxy(candidate) || active.has(candidate)) invalid();
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) invalid();
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const ownKeys = Reflect.ownKeys(candidate);
        const expected = new Set(["length", ...Array.from({ length: candidate.length }, (_, index) => String(index))]);
        if (ownKeys.some(key => typeof key !== "string" || !expected.has(key)) || ownKeys.length !== expected.size) invalid();
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
          visit(descriptor.value);
        }
        return;
      }
      const keys = Reflect.ownKeys(candidate);
      if (keys.some(key => typeof key !== "string" || forbiddenKey(key))) invalid();
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      for (const key of keys as string[]) {
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor) || !descriptor.enumerable) invalid();
        visit(descriptor.value);
      }
    } finally { active.delete(candidate); }
  };
  visit(value);
}

function cloneScope(scope: RuntimeSafetyScope): RuntimeSafetyScope {
  return cloneAndFreezePlanData(scope) as unknown as RuntimeSafetyScope;
}
function scopesEqual(left: RuntimeSafetyScope, right: RuntimeSafetyScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function encodeHandle(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== HANDLE_BYTES) throw new OperationResultStoreError("operation_result_handle_collision");
  const handle = Buffer.from(bytes).toString("base64url");
  if (!HANDLE_PATTERN.test(handle)) throw new OperationResultStoreError("operation_result_handle_collision");
  return handle;
}
function canonicalHandle(handle: unknown): handle is string {
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) return false;
  const bytes = Buffer.from(handle, "base64url");
  return bytes.byteLength === HANDLE_BYTES && bytes.toString("base64url") === handle;
}

function readResultInput(candidate: unknown): OperationResultInput {
  if (typeof candidate !== "object" || candidate === null || utilTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(candidate);
  const expected = new Set(["operation", "status", "items"]);
  if (keys.length !== expected.size || keys.some(key => typeof key !== "string" || !expected.has(key))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const values: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    values[key] = descriptor.value;
  }
  if (typeof values.operation !== "string" || !OPERATION_PATTERN.test(values.operation) ||
    typeof values.status !== "string" || !["completed", "partial", "indeterminate", "failed"].includes(values.status) ||
    !Array.isArray(values.items)) invalid();
  return values as unknown as OperationResultInput;
}

export class OperationResultStore {
  readonly #active = new Map<string, StoredOperationResult>();
  readonly #tombstones = new Set<string>();
  readonly #getActiveScope: () => RuntimeSafetyScope;
  readonly #now: () => number;
  readonly #handleFactory: () => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxActive: number;
  readonly #maxTombstones: number;

  constructor(options: OperationResultStoreOptions) {
    this.#getActiveScope = options.getActiveScope;
    this.#now = options.now ?? Date.now;
    this.#handleFactory = options.handleFactory ?? (() => randomBytes(HANDLE_BYTES));
    this.#ttlMs = options.ttlMs ?? OPERATION_RESULT_TTL_MS;
    this.#maxActive = options.maxActive ?? MAX_ACTIVE_OPERATION_RESULTS;
    this.#maxTombstones = options.maxTombstones ?? MAX_OPERATION_RESULT_TOMBSTONES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 || !Number.isSafeInteger(this.#maxActive) || this.#maxActive <= 0 ||
      !Number.isSafeInteger(this.#maxTombstones) || this.#maxTombstones <= 0) invalid();
  }

  get activeCount(): number { this.#purge(this.#readNow()); return this.#active.size; }

  issue(input: OperationResultInput): string {
    const safeInput = readResultInput(input);
    assertPublicProjection(safeInput.items);
    const items = cloneAndFreezePlanData(safeInput.items) as readonly PlanData[];
    const now = this.#readNow();
    const expiresAt = now + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAt)) invalid();
    this.#purge(now);
    if (this.#active.size >= this.#maxActive) throw new OperationResultStoreError("operation_result_capacity_exceeded");
    let scope: RuntimeSafetyScope;
    try { scope = cloneScope(this.#getActiveScope()); } catch { invalid(); }
    const stored = Object.freeze({ operation: safeInput.operation, status: safeInput.status, items, scope, issuedAt: now, expiresAt });
    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
      const handle = encodeHandle(this.#handleFactory());
      if (this.#active.has(handle) || this.#tombstones.has(handle)) continue;
      this.#active.set(handle, stored);
      return handle;
    }
    throw new OperationResultStoreError("operation_result_handle_collision");
  }

  inspect(handle: string): StoredOperationResult {
    if (!canonicalHandle(handle)) throw new OperationResultStoreError("operation_result_handle_invalid");
    const now = this.#readNow();
    const stored = this.#active.get(handle);
    if (stored && now >= stored.expiresAt) { this.#active.delete(handle); this.#addTombstone(handle); }
    this.#purge(now);
    if (!stored || now >= stored.expiresAt) throw new OperationResultStoreError(stored || this.#tombstones.has(handle) ? "operation_result_expired" : "operation_result_handle_invalid");
    let current: RuntimeSafetyScope;
    try { current = cloneScope(this.#getActiveScope()); } catch { throw new OperationResultStoreError("operation_result_scope_mismatch"); }
    if (!scopesEqual(stored.scope, current)) throw new OperationResultStoreError("operation_result_scope_mismatch");
    return stored;
  }

  #readNow(): number { const now = this.#now(); if (!Number.isSafeInteger(now) || now < 0) invalid(); return now; }
  #purge(now: number): void {
    for (const [handle, stored] of this.#active) if (now >= stored.expiresAt) { this.#active.delete(handle); this.#addTombstone(handle); }
  }
  #addTombstone(handle: string): void {
    this.#tombstones.delete(handle);
    this.#tombstones.add(handle);
    while (this.#tombstones.size > this.#maxTombstones) {
      const oldest = this.#tombstones.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }
}
