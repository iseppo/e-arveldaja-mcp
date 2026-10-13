import { types as utilTypes } from "node:util";
import {
  encodeStoreHandle,
  isCanonicalStoreHandle,
  MAX_STORE_HANDLE_ATTEMPTS,
  randomStoreHandleBytes,
} from "./handle-store-core.js";
import { detailItemFitsSinglePage } from "./response-budget.js";

// Shared core of the two public-detail handle stores (operation results and
// workflow states). Each store keeps its own error class, codes, messages,
// contract string, brand WeakSet and input reader; this module only holds the
// identical validation and the handle/TTL/tombstone lifecycle.
//
// The plan-store primitives (cloneAndFreezePlanData, cloneRuntimeSafetyScope,
// runtimeSafetyScopesEqual) are passed in by each store rather than imported:
// plan-store.ts and runtime-safety-context.ts already sit on an import cycle
// with the stores, and importing either here would add new cycles.

const FORBIDDEN_KEYS = new Set([
  "password", "apikey", "apikeyid", "apipublicvalue", "apipassword", "credential", "credentials", "secret", "token", "authorization",
  "privatekey", "sessioncookie", "bearer",
  "privatepayload", "normalizedargs", "sourceidentities", "livesnapshot", "planhandle",
  "command", "commands", "executable", "tool", "args",
  "approved", "approval", "approvalrequired", "approvalstate",
  "__proto__", "constructor", "prototype",
]);

export type PublicDetailScalar = string | number | boolean | null;
export interface PublicDetailRecord { readonly [key: string]: PublicDetailValue }
export type PublicDetailValue = PublicDetailScalar | readonly PublicDetailScalar[] | PublicDetailRecord;
export interface PublicDetailInput {
  readonly item_id?: PublicDetailScalar;
  readonly id?: PublicDetailScalar;
  readonly index?: PublicDetailScalar;
  readonly i?: PublicDetailScalar;
  readonly label?: PublicDetailScalar;
  readonly name?: PublicDetailScalar;
  readonly code?: PublicDetailScalar;
  readonly message?: PublicDetailScalar;
  readonly severity?: PublicDetailScalar;
  readonly status?: PublicDetailScalar;
  readonly amount?: PublicDetailScalar;
  readonly currency?: PublicDetailScalar;
  readonly date?: PublicDetailScalar;
  readonly account?: PublicDetailScalar;
  readonly account_id?: PublicDetailScalar;
  readonly description?: PublicDetailScalar;
  readonly count?: PublicDetailScalar;
  readonly total?: PublicDetailScalar;
  readonly reason?: PublicDetailScalar;
  readonly text?: PublicDetailScalar;
  readonly value?: PublicDetailScalar;
  readonly values?: readonly PublicDetailScalar[];
  readonly labels?: readonly PublicDetailScalar[];
  readonly codes?: readonly PublicDetailScalar[];
  readonly messages?: readonly PublicDetailScalar[];
  readonly warnings?: readonly PublicDetailScalar[];
  readonly tags?: readonly PublicDetailScalar[];
  readonly source_documents?: readonly PublicDetailScalar[];
  readonly nested?: PublicDetailInput;
  readonly counts?: PublicDetailInput;
  readonly totals?: PublicDetailInput;
  readonly period?: PublicDetailInput;
  readonly range?: PublicDetailInput;
  readonly summary?: PublicDetailInput;
  readonly details?: PublicDetailInput;
}

const PUBLIC_DETAIL_SCALAR_FIELDS = new Set([
  "item_id", "id", "index", "i", "label", "name", "code", "message", "severity", "status",
  "amount", "currency", "date", "account", "account_id", "description", "count", "total", "reason", "text", "value",
]);
const PUBLIC_DETAIL_LIST_FIELDS = new Set(["values", "labels", "codes", "messages", "warnings", "tags", "source_documents"]);
const PUBLIC_DETAIL_RECORD_FIELDS = new Set(["nested", "counts", "totals", "period", "range", "summary", "details"]);
const FORBIDDEN_PUBLIC_FIELD_FRAGMENT = /(?:auth|authorization|bearer|cookie|jwt|accesskey|privatekey|session|token|secret|password|credential|apikey|approval|command|executable|action|parameter|argument|request|payload|tool)/;
const EXECUTABLE_POSITIONAL_VALUE = /^(?:delete|create|update|confirm|execute|post|put|patch|remove|upload|import)_[a-z0-9_.-]+$/i;
const CREDENTIAL_VALUE = /^(?:bearer\s+\S+|(?:authorization|auth|cookie|set-cookie|jwt|token|secret|password|access[ _-]?key|api[ _-]?key)\s*(?::|=|$)|(?:session|sid|jwt|token|secret|password|access[ _-]?key|api[ _-]?key)[ _-]*=|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function normalizedKey(key: string): string { return key.replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function forbiddenKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return FORBIDDEN_KEYS.has(normalized) ||
    /(?:token|secret|password|credential|apikey|privatekey|sessioncookie|bearer)/.test(normalized) ||
    normalized.includes("approval") || normalized.includes("executionplan") ||
    normalized.startsWith("command") || normalized.startsWith("tool") ||
    normalized === "arguments";
}

/**
 * Reject proxies, cycles, accessors, non-enumerable or symbol keys, sparse or
 * subclassed arrays, and any forbidden (credential/plan/approval/command) key.
 * `invalid` throws the calling store's own data-invalid error.
 */
export function assertPublicDetailProjection(value: unknown, invalid: () => never): void {
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

function assertSafePublicDetailData(value: unknown, invalid: () => never): asserts value is PublicDetailRecord {
  assertPublicDetailProjection(value, invalid);
  const visitRecord = (record: unknown): void => {
    if (typeof record !== "object" || record === null || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) invalid();
    for (const [key, child] of Object.entries(record)) {
      const normalized = normalizedKey(key);
      if (FORBIDDEN_PUBLIC_FIELD_FRAGMENT.test(normalized)) invalid();
      if (PUBLIC_DETAIL_SCALAR_FIELDS.has(key)) {
        if (child !== null && typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") invalid();
        if (typeof child === "number" && !Number.isFinite(child)) invalid();
        if (typeof child === "string" && CREDENTIAL_VALUE.test(child.trim())) invalid();
      } else if (PUBLIC_DETAIL_LIST_FIELDS.has(key)) {
        if (!Array.isArray(child) || child.some(item =>
          item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) invalid();
        if (child.some(item => typeof item === "number" && !Number.isFinite(item))) invalid();
        if (child.some(item => typeof item === "string" && (CREDENTIAL_VALUE.test(item.trim()) || EXECUTABLE_POSITIONAL_VALUE.test(item.trim())))) invalid();
      } else if (PUBLIC_DETAIL_RECORD_FIELDS.has(key)) {
        visitRecord(child);
      } else {
        invalid();
      }
    }
  };
  visitRecord(value);
}

/**
 * Descriptor-read a store input that must be a plain, non-proxy object with
 * exactly `expectedKeys` as own enumerable data properties. Returns the values
 * keyed in `expectedKeys` order; field-level checks stay with each store.
 */
export function readExactInputRecord(
  candidate: unknown,
  expectedKeys: readonly string[],
  invalid: () => never,
): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || utilTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(candidate);
  const expected = new Set(expectedKeys);
  if (keys.length !== expected.size || keys.some(key => typeof key !== "string" || !expected.has(key))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const values: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    values[key] = descriptor.value;
  }
  return values;
}

export interface PublicDetail<TContract extends string> {
  readonly contract: TContract;
  readonly data: PublicDetailRecord;
}

export interface PublicDetailKit<TContract extends string> {
  /** Validate, deep-clone, freeze and brand one public detail. */
  readonly create: (data: PublicDetailInput) => PublicDetail<TContract>;
  /** Accept only a detail branded by THIS kit's `create`; descriptor-read so getters and proxies cannot substitute data. */
  readonly read: (value: unknown) => PublicDetailRecord;
}

/**
 * One brand per call: each store module creates its own kit at module load, so
 * a detail branded for one store is never accepted by another.
 */
export function createPublicDetailKit<TContract extends string>(
  contract: TContract,
  invalid: () => never,
  cloneAndFreezeData: (value: unknown) => unknown,
): PublicDetailKit<TContract> {
  const brands = new WeakSet<object>();
  return Object.freeze({
    create(data: PublicDetailInput): PublicDetail<TContract> {
      assertSafePublicDetailData(data, invalid);
      const safeData = cloneAndFreezeData(data) as PublicDetailRecord;
      const detail = Object.freeze({ contract, data: safeData });
      brands.add(detail);
      return detail;
    },
    read(value: unknown): PublicDetailRecord {
      if (typeof value !== "object" || value === null || !brands.has(value)) invalid();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.length !== 2 || !keys.includes("contract") || !keys.includes("data") ||
        descriptors.contract?.value !== contract || !("value" in (descriptors.data ?? {}))) invalid();
      return descriptors.data!.value as PublicDetailRecord;
    },
  });
}

/** Error suffixes shared by both stores; each store prefixes its own namespace. */
export type PublicDetailStoreErrorKind =
  | "capacity_exceeded" | "handle_invalid" | "expired" | "scope_mismatch" | "data_invalid" | "handle_collision"
  | "item_too_large";

export interface PublicDetailStoreBaseOptions<Scope> {
  readonly getActiveScope: () => Scope;
  readonly now?: () => number;
  readonly handleFactory?: () => Uint8Array;
  readonly ttlMs?: number;
  readonly maxActive?: number;
  readonly maxTombstones?: number;
}

export interface PublicDetailStoredBase<Scope = unknown, Data = unknown> {
  readonly items: readonly Data[];
  readonly scope: Scope;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface PublicDetailStoreConfig<S extends PublicDetailStoredBase> {
  readonly defaultTtlMs: number;
  readonly defaultMaxActive: number;
  readonly defaultMaxTombstones: number;
  /** Construct the calling store's own error for a shared error kind. */
  readonly error: (kind: PublicDetailStoreErrorKind) => Error;
  readonly detail: PublicDetailKit<string>;
  /** plan-store's cloneAndFreezePlanData. */
  readonly cloneAndFreezeData: (value: unknown) => readonly S["items"][number][];
  /** plan-store's cloneRuntimeSafetyScope (throws on anything that is not a plain scope). */
  readonly cloneScope: (scope: S["scope"]) => S["scope"];
  /** plan-store's runtimeSafetyScopesEqual. */
  readonly scopesEqual: (left: S["scope"], right: S["scope"]) => boolean;
  /** Pin an external proof for the stored entry's lifetime; returns its release. A throw maps to data_invalid. */
  readonly retainProof?: (stored: S) => () => void;
  /** Re-check the pinned external proof on every read. A throw maps to scope_mismatch. */
  readonly assertProof?: (stored: S) => void;
}

const NO_RELEASE = (): void => {};

/**
 * Bounded, TTL'd, scope-bound store of frozen public-detail lists keyed by
 * unforgeable handles. Expired handles become tombstones (bounded, oldest
 * evicted first) so a late read reports `expired` rather than `handle_invalid`
 * and a tombstoned handle is never re-issued.
 */
export class PublicDetailHandleStore<S extends PublicDetailStoredBase> {
  readonly #active = new Map<string, S>();
  readonly #tombstones = new Set<string>();
  readonly #getActiveScope: () => S["scope"];
  readonly #now: () => number;
  readonly #handleFactory: () => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxActive: number;
  readonly #maxTombstones: number;
  readonly #error: (kind: PublicDetailStoreErrorKind) => Error;
  readonly #detail: PublicDetailKit<string>;
  readonly #cloneAndFreezeData: (value: unknown) => readonly S["items"][number][];
  readonly #cloneScope: (scope: S["scope"]) => S["scope"];
  readonly #scopesEqual: (left: S["scope"], right: S["scope"]) => boolean;
  readonly #retainProof: ((stored: S) => () => void) | undefined;
  readonly #assertProof: ((stored: S) => void) | undefined;
  readonly #proofReleases = new Map<string, () => void>();

  constructor(options: PublicDetailStoreBaseOptions<S["scope"]>, config: PublicDetailStoreConfig<S>) {
    this.#error = config.error;
    this.#detail = config.detail;
    this.#cloneAndFreezeData = config.cloneAndFreezeData;
    this.#cloneScope = config.cloneScope;
    this.#scopesEqual = config.scopesEqual;
    this.#retainProof = config.retainProof;
    this.#assertProof = config.assertProof;
    this.#getActiveScope = options.getActiveScope;
    this.#now = options.now ?? Date.now;
    this.#handleFactory = options.handleFactory ?? randomStoreHandleBytes;
    this.#ttlMs = options.ttlMs ?? config.defaultTtlMs;
    this.#maxActive = options.maxActive ?? config.defaultMaxActive;
    this.#maxTombstones = options.maxTombstones ?? config.defaultMaxTombstones;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 || !Number.isSafeInteger(this.#maxActive) || this.#maxActive <= 0 ||
      !Number.isSafeInteger(this.#maxTombstones) || this.#maxTombstones <= 0) this.#invalid();
  }

  get activeCount(): number { this.#purge(this.#readNow()); return this.#active.size; }

  /**
   * Admit `rawItems` (each must be a detail branded by this store's kit) and
   * return a fresh handle. `build` assembles the frozen stored entry from the
   * validated fields; it runs before any proof is pinned or slot is taken.
   */
  issue(rawItems: readonly unknown[], build: (fields: PublicDetailStoredBase<S["scope"], S["items"][number]>) => S): string {
    assertPublicDetailProjection(rawItems, () => this.#invalid());
    const publicItems = rawItems.map(this.#detail.read);
    const items = this.#cloneAndFreezeData(publicItems);
    // Refuse any single detail too large to be returned as a one-item page. This
    // runs before any side effect (no capacity slot taken, no proof pinned), so
    // an oversized item is a clean structured error rather than an admitted
    // detail no page size could ever reach.
    for (const item of items) {
      if (!detailItemFitsSinglePage(item)) throw this.#error("item_too_large");
    }
    const now = this.#readNow();
    const expiresAt = now + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAt)) this.#invalid();
    this.#purge(now);
    if (this.#active.size >= this.#maxActive) throw this.#error("capacity_exceeded");
    let scope: S["scope"];
    try { scope = this.#cloneScope(this.#getActiveScope()); } catch { this.#invalid(); }
    const stored = build({ items, scope, issuedAt: now, expiresAt });
    let releaseProof: () => void = NO_RELEASE;
    if (this.#retainProof) {
      try { releaseProof = this.#retainProof(stored); } catch { this.#invalid(); }
    }
    try {
      for (let attempt = 0; attempt < MAX_STORE_HANDLE_ATTEMPTS; attempt += 1) {
        const handle = encodeStoreHandle(this.#handleFactory());
        if (handle === undefined) throw this.#error("handle_collision");
        if (this.#active.has(handle) || this.#tombstones.has(handle)) continue;
        this.#active.set(handle, stored);
        this.#proofReleases.set(handle, releaseProof);
        return handle;
      }
    } catch (error) {
      releaseProof();
      throw error;
    }
    releaseProof();
    throw this.#error("handle_collision");
  }

  inspect(handle: string): S {
    if (!isCanonicalStoreHandle(handle)) throw this.#error("handle_invalid");
    const now = this.#readNow();
    const stored = this.#active.get(handle);
    if (stored && now >= stored.expiresAt) { this.#expire(handle); this.#addTombstone(handle); }
    this.#purge(now);
    if (!stored || now >= stored.expiresAt) throw this.#error(stored || this.#tombstones.has(handle) ? "expired" : "handle_invalid");
    let current: S["scope"];
    try { current = this.#cloneScope(this.#getActiveScope()); } catch { throw this.#error("scope_mismatch"); }
    if (!this.#scopesEqual(stored.scope, current)) throw this.#error("scope_mismatch");
    if (this.#assertProof) {
      try { this.#assertProof(stored); } catch { throw this.#error("scope_mismatch"); }
    }
    return stored;
  }

  #invalid(): never { throw this.#error("data_invalid"); }
  #readNow(): number { const now = this.#now(); if (!Number.isSafeInteger(now) || now < 0) this.#invalid(); return now; }
  #purge(now: number): void {
    for (const [handle, stored] of this.#active) if (now >= stored.expiresAt) { this.#expire(handle); this.#addTombstone(handle); }
  }
  #expire(handle: string): void {
    this.#active.delete(handle);
    this.#proofReleases.get(handle)?.();
    this.#proofReleases.delete(handle);
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
