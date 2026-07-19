import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { RuntimeSafetyScope } from "./runtime-safety-context.js";

export const EXECUTION_PLAN_SCHEMA = "execution_plan_v1" as const;
export const EXECUTION_PLAN_TTL_MS = 600_000;
export const MAX_ACTIVE_EXECUTION_PLANS = 128;
export const MAX_EXECUTION_PLAN_TOMBSTONES = 512;

const HANDLE_BYTES = 32;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_HANDLE_ATTEMPTS = 16;
const MAX_PLAN_DEPTH = 16;
const MAX_PLAN_NODES = 10_000;
const MAX_PLAN_ARRAY_ITEMS = 5_000;
const MAX_PLAN_OBJECT_KEYS = 2_000;
const MAX_PLAN_STRING_CHARS = 262_144;
const MAX_PLAN_CANONICAL_BYTES = 1_048_576;
const MAX_COMMANDS = 5_000;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type PlanScalar = string | number | boolean | null;
export type PlanData = PlanScalar | readonly PlanData[] | { readonly [key: string]: PlanData };
export type PlanRecord = { readonly [key: string]: PlanData };

export interface ExecutionPlanCommand {
  readonly id: string;
  readonly category: string;
  /** Safe review-only detail. Executable commands belong in privatePayload. */
  readonly reviewProjection?: PlanData;
}

export interface ExecutionPlanInput {
  readonly normalizedArgs: PlanRecord;
  readonly sourceIdentities: readonly PlanRecord[];
  readonly liveSnapshot: PlanData;
  readonly commands: readonly ExecutionPlanCommand[];
  readonly counts: PlanRecord;
  readonly totals: PlanRecord;
  readonly exclusions: readonly PlanData[];
  readonly reviews: readonly PlanData[];
  readonly privatePayload: PlanData;
}

export interface StoredExecutionPlan extends ExecutionPlanInput {
  readonly schema: typeof EXECUTION_PLAN_SCHEMA;
  readonly domain: string;
  readonly scope: RuntimeSafetyScope;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type PublicExecutionPlan = Omit<StoredExecutionPlan, "privatePayload">;

export type PlanStoreErrorCode =
  | "plan_capacity_exceeded"
  | "plan_handle_invalid"
  | "plan_handle_consumed"
  | "plan_handle_expired"
  | "plan_domain_mismatch"
  | "plan_scope_mismatch"
  | "plan_data_invalid"
  | "plan_handle_collision";

const SAFE_ERROR_MESSAGES: Readonly<Record<PlanStoreErrorCode, string>> = Object.freeze({
  plan_capacity_exceeded: "The execution-plan store is full. Wait for a plan to expire or consume an existing plan.",
  plan_handle_invalid: "The execution-plan handle is invalid or unknown.",
  plan_handle_consumed: "The execution-plan handle has already been consumed.",
  plan_handle_expired: "The execution-plan handle has expired.",
  plan_domain_mismatch: "The execution-plan handle belongs to a different operation.",
  plan_scope_mismatch: "The execution-plan handle no longer matches the active runtime scope.",
  plan_data_invalid: "The execution plan contains invalid or oversized data.",
  plan_handle_collision: "Unable to allocate a unique execution-plan handle.",
});

export class PlanStoreError extends Error {
  readonly code: PlanStoreErrorCode;

  constructor(code: PlanStoreErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "PlanStoreError";
    this.code = code;
  }
}

export interface ExecutionPlanStoreOptions {
  readonly getActiveScope: () => RuntimeSafetyScope;
  readonly now?: () => number;
  readonly handleFactory?: () => Uint8Array;
  readonly ttlMs?: number;
  readonly maxActive?: number;
  readonly maxTombstones?: number;
}

interface Tombstone {
  readonly reason: "consumed" | "expired";
}

function failData(): never {
  throw new PlanStoreError("plan_data_invalid");
}

function cloneAndFreezePlanData(value: unknown): PlanData {
  let nodes = 0;
  let stringChars = 0;
  const active = new Set<object>();

  const visit = (candidate: unknown, depth: number): PlanData => {
    nodes += 1;
    if (nodes > MAX_PLAN_NODES || depth > MAX_PLAN_DEPTH) failData();
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) failData();
      return candidate;
    }
    if (typeof candidate === "string") {
      stringChars += candidate.length;
      if (candidate.length > MAX_PLAN_STRING_CHARS || stringChars > MAX_PLAN_STRING_CHARS) failData();
      return candidate;
    }
    if (typeof candidate !== "object") failData();
    if (utilTypes.isProxy(candidate)) failData();

    if (active.has(candidate)) failData();
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) failData();
        if (candidate.length > MAX_PLAN_ARRAY_ITEMS) failData();
        const ownKeys = Reflect.ownKeys(candidate);
        if (ownKeys.some(key => typeof key === "symbol")) failData();
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const expectedKeys = new Set(["length", ...Array.from({ length: candidate.length }, (_, index) => String(index))]);
        if (ownKeys.some(key => typeof key !== "string" || !expectedKeys.has(key)) || ownKeys.length !== expectedKeys.size) {
          failData();
        }
        const lengthDescriptor = (descriptors as unknown as Record<string, PropertyDescriptor>)["length"];
        if (!lengthDescriptor || lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined ||
          lengthDescriptor.value !== candidate.length) failData();
        const result: PlanData[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) failData();
          result.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) failData();
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const ownKeys = Reflect.ownKeys(candidate);
      if (ownKeys.some(key => typeof key === "symbol")) failData();
      const keys = ownKeys as string[];
      if (keys.length > MAX_PLAN_OBJECT_KEYS) failData();
      const result: Record<string, PlanData> = Object.create(null);
      for (const key of keys) {
        if (UNSAFE_KEYS.has(key)) failData();
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor) || !descriptor.enumerable) failData();
        stringChars += key.length;
        if (stringChars > MAX_PLAN_STRING_CHARS) failData();
        result[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      active.delete(candidate);
    }
  };

  const cloned = visit(value, 0);
  let canonical: string;
  try {
    canonical = JSON.stringify(cloned);
  } catch {
    failData();
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_PLAN_CANONICAL_BYTES) failData();
  return cloned;
}

function asRecord(value: PlanData): PlanRecord {
  if (value === null || Array.isArray(value) || typeof value !== "object") failData();
  return value as PlanRecord;
}

function asArray(value: PlanData): readonly PlanData[] {
  if (!Array.isArray(value)) failData();
  return value;
}

function validateDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) failData();
}

function cloneScope(scope: RuntimeSafetyScope): RuntimeSafetyScope {
  const cloned = cloneAndFreezePlanData(scope) as PlanRecord;
  return cloned as unknown as RuntimeSafetyScope;
}

function scopesEqual(left: RuntimeSafetyScope, right: RuntimeSafetyScope): boolean {
  return left.serverInstanceId === right.serverInstanceId &&
    left.connectionIndex === right.connectionIndex &&
    left.connectionGeneration === right.connectionGeneration &&
    left.connectionName === right.connectionName &&
    left.connectionFingerprint === right.connectionFingerprint &&
    left.environmentKind === right.environmentKind &&
    left.baseUrl === right.baseUrl &&
    left.features.enableLightyear === right.features.enableLightyear &&
    left.features.exposeGranularTools === right.features.exposeGranularTools &&
    left.features.exposeSetupTools === right.features.exposeSetupTools &&
    left.features.enableTaxTools === right.features.enableTaxTools &&
    left.features.enableReferenceAdmin === right.features.enableReferenceAdmin &&
    left.features.enableAnnualReport === right.features.enableAnnualReport &&
    left.features.enableSales === right.features.enableSales &&
    left.features.enableProducts === right.features.enableProducts;
}

function encodeHandle(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== HANDLE_BYTES) {
    throw new PlanStoreError("plan_handle_collision");
  }
  const handle = Buffer.from(bytes).toString("base64url");
  if (!HANDLE_PATTERN.test(handle)) throw new PlanStoreError("plan_handle_collision");
  return handle;
}

function isCanonicalHandle(handle: string): boolean {
  if (!HANDLE_PATTERN.test(handle)) return false;
  try {
    const decoded = Buffer.from(handle, "base64url");
    return decoded.byteLength === HANDLE_BYTES && decoded.toString("base64url") === handle;
  } catch {
    return false;
  }
}

export class ExecutionPlanStore {
  readonly #active = new Map<string, StoredExecutionPlan>();
  readonly #tombstones = new Map<string, Tombstone>();
  readonly #getActiveScope: () => RuntimeSafetyScope;
  readonly #now: () => number;
  readonly #handleFactory: () => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxActive: number;
  readonly #maxTombstones: number;

  constructor(options: ExecutionPlanStoreOptions) {
    this.#getActiveScope = options.getActiveScope;
    this.#now = options.now ?? Date.now;
    this.#handleFactory = options.handleFactory ?? (() => randomBytes(HANDLE_BYTES));
    this.#ttlMs = options.ttlMs ?? EXECUTION_PLAN_TTL_MS;
    this.#maxActive = options.maxActive ?? MAX_ACTIVE_EXECUTION_PLANS;
    this.#maxTombstones = options.maxTombstones ?? MAX_EXECUTION_PLAN_TOMBSTONES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 ||
      !Number.isSafeInteger(this.#maxActive) || this.#maxActive <= 0 ||
      !Number.isSafeInteger(this.#maxTombstones) || this.#maxTombstones <= 0) {
      throw new PlanStoreError("plan_data_invalid");
    }
  }

  get activeCount(): number {
    this.#purgeExpired(this.#readNow());
    return this.#active.size;
  }

  get stats(): Readonly<{ active: number; tombstones: number }> {
    this.#purgeExpired(this.#readNow());
    return Object.freeze({ active: this.#active.size, tombstones: this.#tombstones.size });
  }

  issue(domain: string, input: ExecutionPlanInput): string {
    validateDomain(domain);
    const now = this.#readNow();
    this.#purgeExpired(now);
    if (this.#active.size >= this.#maxActive) {
      throw new PlanStoreError("plan_capacity_exceeded");
    }

    const scope = this.#readScopeForIssue();
    const clonedInput = asRecord(cloneAndFreezePlanData(input));
    const commands = asArray(clonedInput.commands);
    if (commands.length > MAX_COMMANDS) failData();
    const commandIds = new Set<string>();
    const publicCommands: ExecutionPlanCommand[] = [];
    for (const command of commands) {
      const record = asRecord(command);
      if (typeof record.id !== "string" || !COMMAND_ID_PATTERN.test(record.id) || commandIds.has(record.id)) {
        failData();
      }
      const keys = Object.keys(record);
      if (keys.some(key => key !== "id" && key !== "category" && key !== "reviewProjection")) failData();
      if (typeof record.category !== "string" || !DOMAIN_PATTERN.test(record.category)) failData();
      commandIds.add(record.id);
      publicCommands.push(Object.freeze({
        id: record.id,
        category: record.category,
        ...(record.reviewProjection !== undefined ? { reviewProjection: record.reviewProjection } : {}),
      }));
    }

    const issuedAt = now;
    const expiresAt = now + this.#ttlMs;
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) failData();
    const plan = Object.freeze({
      schema: EXECUTION_PLAN_SCHEMA,
      domain,
      scope,
      issuedAt,
      expiresAt,
      normalizedArgs: asRecord(clonedInput.normalizedArgs),
      sourceIdentities: Object.freeze(asArray(clonedInput.sourceIdentities).map(asRecord)),
      liveSnapshot: clonedInput.liveSnapshot,
      commands: Object.freeze(publicCommands),
      counts: asRecord(clonedInput.counts),
      totals: asRecord(clonedInput.totals),
      exclusions: asArray(clonedInput.exclusions),
      reviews: asArray(clonedInput.reviews),
      privatePayload: clonedInput.privatePayload,
    }) satisfies StoredExecutionPlan;

    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
      const handle = encodeHandle(this.#handleFactory());
      if (this.#active.has(handle) || this.#tombstones.has(handle)) continue;
      this.#active.set(handle, plan);
      return handle;
    }
    throw new PlanStoreError("plan_handle_collision");
  }

  inspect(handle: string, expectedDomain?: string): PublicExecutionPlan {
    this.#validateHandle(handle);
    if (expectedDomain !== undefined) validateDomain(expectedDomain);
    const now = this.#readNow();
    const plan = this.#active.get(handle);
    if (plan && now >= plan.expiresAt) {
      this.#active.delete(handle);
      this.#purgeExpired(now);
      this.#addTombstone(handle, "expired");
      throw new PlanStoreError("plan_handle_expired");
    }
    this.#purgeExpired(now);
    if (!plan) this.#throwMissing(handle);
    if (expectedDomain !== undefined && plan.domain !== expectedDomain) {
      throw new PlanStoreError("plan_domain_mismatch");
    }
    if (!this.#scopeMatches(plan.scope)) {
      throw new PlanStoreError("plan_scope_mismatch");
    }
    const { privatePayload: _private, ...publicPlan } = plan;
    return Object.freeze(publicPlan);
  }

  consume(handle: string, expectedDomain: string): StoredExecutionPlan {
    this.#validateHandle(handle);
    const now = this.#readNow();
    const plan = this.#active.get(handle);
    if (!plan) {
      this.#purgeExpired(now);
      this.#throwMissing(handle);
    }

    // One-attempt semantics: burn the credential before every execute-time
    // validation, including expiry, operation, connection, and feature drift.
    this.#active.delete(handle);
    this.#purgeExpired(now);
    this.#addTombstone(handle, now >= plan.expiresAt ? "expired" : "consumed");

    if (now >= plan.expiresAt) throw new PlanStoreError("plan_handle_expired");
    validateDomain(expectedDomain);
    if (plan.domain !== expectedDomain) throw new PlanStoreError("plan_domain_mismatch");
    if (!this.#scopeMatches(plan.scope)) {
      throw new PlanStoreError("plan_scope_mismatch");
    }
    return plan;
  }

  #validateHandle(handle: string): void {
    if (typeof handle !== "string" || !isCanonicalHandle(handle)) {
      throw new PlanStoreError("plan_handle_invalid");
    }
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) failData();
    return now;
  }

  #readScopeForIssue(): RuntimeSafetyScope {
    try {
      return cloneScope(this.#getActiveScope());
    } catch {
      throw new PlanStoreError("plan_data_invalid");
    }
  }

  #scopeMatches(expected: RuntimeSafetyScope): boolean {
    try {
      return scopesEqual(expected, cloneScope(this.#getActiveScope()));
    } catch {
      return false;
    }
  }

  #throwMissing(handle: string): never {
    const tombstone = this.#tombstones.get(handle);
    if (tombstone?.reason === "expired") throw new PlanStoreError("plan_handle_expired");
    if (tombstone) throw new PlanStoreError("plan_handle_consumed");
    throw new PlanStoreError("plan_handle_invalid");
  }

  #purgeExpired(now: number): void {
    for (const [handle, plan] of this.#active) {
      if (now >= plan.expiresAt) {
        this.#active.delete(handle);
        this.#addTombstone(handle, "expired");
      }
    }
  }

  #addTombstone(handle: string, reason: Tombstone["reason"]): void {
    this.#tombstones.delete(handle);
    this.#tombstones.set(handle, Object.freeze({ reason }));
    while (this.#tombstones.size > this.#maxTombstones) {
      const oldest = this.#tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }
}
