import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import { cloneAndFreezePlanData, type PlanData } from "./plan-store.js";
import type { RuntimeSafetyScope } from "./runtime-safety-context.js";
import type {
  PublicWorkflowRecord,
  PublicWorkflowScalar,
  WorkflowStateStatus,
} from "./workflow-state-types.js";

export type {
  PublicWorkflowRecord,
  PublicWorkflowScalar,
  PublicWorkflowValue,
  WorkflowStateStatus,
} from "./workflow-state-types.js";

// A workflow handle carries inert, server-owned state between continuation
// calls of an in-progress workflow. Unlike the operation-result store it has NO
// plan-consumption gate: handles are issued MID-workflow, before any plan is
// even proposed, so there is no plan proof, no plan handle, and no mutation
// authority. TTL is sized for a multi-step (multi-turn) workflow rather than a
// single tool call, but capacity/tombstone bounds and every fail-closed
// rejection are identical to the operation-result store.
export const WORKFLOW_STATE_TTL_MS = 1_800_000;
export const MAX_ACTIVE_WORKFLOW_STATES = 128;
export const MAX_WORKFLOW_STATE_TOMBSTONES = 512;
const HANDLE_BYTES = 32;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_HANDLE_ATTEMPTS = 16;
const WORKFLOW_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const WORKFLOW_STATE_STATUSES: readonly WorkflowStateStatus[] = [
  "in_progress", "needs_input", "needs_review", "ready_for_approval", "completed",
];
const FORBIDDEN_KEYS = new Set([
  "password", "apikey", "apikeyid", "apipublicvalue", "apipassword", "credential", "credentials", "secret", "token", "authorization",
  "privatekey", "sessioncookie", "bearer",
  "privatepayload", "normalizedargs", "sourceidentities", "livesnapshot", "planhandle",
  "command", "commands", "executable", "tool", "args",
  "approved", "approval", "approvalrequired", "approvalstate",
  "__proto__", "constructor", "prototype",
]);

export interface PublicWorkflowStateDetailInput {
  readonly item_id?: PublicWorkflowScalar;
  readonly id?: PublicWorkflowScalar;
  readonly index?: PublicWorkflowScalar;
  readonly i?: PublicWorkflowScalar;
  readonly label?: PublicWorkflowScalar;
  readonly name?: PublicWorkflowScalar;
  readonly code?: PublicWorkflowScalar;
  readonly message?: PublicWorkflowScalar;
  readonly severity?: PublicWorkflowScalar;
  readonly status?: PublicWorkflowScalar;
  readonly amount?: PublicWorkflowScalar;
  readonly currency?: PublicWorkflowScalar;
  readonly date?: PublicWorkflowScalar;
  readonly account?: PublicWorkflowScalar;
  readonly account_id?: PublicWorkflowScalar;
  readonly description?: PublicWorkflowScalar;
  readonly count?: PublicWorkflowScalar;
  readonly total?: PublicWorkflowScalar;
  readonly reason?: PublicWorkflowScalar;
  readonly text?: PublicWorkflowScalar;
  readonly value?: PublicWorkflowScalar;
  readonly values?: readonly PublicWorkflowScalar[];
  readonly labels?: readonly PublicWorkflowScalar[];
  readonly codes?: readonly PublicWorkflowScalar[];
  readonly messages?: readonly PublicWorkflowScalar[];
  readonly warnings?: readonly PublicWorkflowScalar[];
  readonly tags?: readonly PublicWorkflowScalar[];
  readonly source_documents?: readonly PublicWorkflowScalar[];
  readonly nested?: PublicWorkflowStateDetailInput;
  readonly counts?: PublicWorkflowStateDetailInput;
  readonly totals?: PublicWorkflowStateDetailInput;
  readonly period?: PublicWorkflowStateDetailInput;
  readonly range?: PublicWorkflowStateDetailInput;
  readonly summary?: PublicWorkflowStateDetailInput;
  readonly details?: PublicWorkflowStateDetailInput;
}
export interface PublicWorkflowStateDetail {
  readonly contract: "workflow_state_detail_v1";
  readonly data: PublicWorkflowRecord;
}
export interface WorkflowStateInput {
  readonly workflow: string;
  readonly status: WorkflowStateStatus;
  readonly items: readonly PublicWorkflowStateDetail[];
}
export interface StoredWorkflowState {
  readonly workflow: string;
  readonly status: WorkflowStateStatus;
  readonly items: readonly PlanData[];
  readonly scope: RuntimeSafetyScope;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export type WorkflowStateStoreErrorCode =
  | "workflow_state_capacity_exceeded" | "workflow_state_handle_invalid" | "workflow_state_expired"
  | "workflow_state_scope_mismatch" | "workflow_state_data_invalid" | "workflow_state_handle_collision";

const MESSAGES: Readonly<Record<WorkflowStateStoreErrorCode, string>> = Object.freeze({
  workflow_state_capacity_exceeded: "The workflow-state store is full. Wait for a state to expire.",
  workflow_state_handle_invalid: "The workflow-state handle is invalid or unknown.",
  workflow_state_expired: "The workflow-state handle has expired.",
  workflow_state_scope_mismatch: "The workflow-state handle no longer matches the active runtime scope.",
  workflow_state_data_invalid: "The workflow state contains unsafe or oversized data.",
  workflow_state_handle_collision: "Unable to allocate a unique workflow-state handle.",
});

const PUBLIC_DETAIL_SCALAR_FIELDS = new Set([
  "item_id", "id", "index", "i", "label", "name", "code", "message", "severity", "status",
  "amount", "currency", "date", "account", "account_id", "description", "count", "total", "reason", "text", "value",
]);
const PUBLIC_DETAIL_LIST_FIELDS = new Set(["values", "labels", "codes", "messages", "warnings", "tags", "source_documents"]);
const PUBLIC_DETAIL_RECORD_FIELDS = new Set(["nested", "counts", "totals", "period", "range", "summary", "details"]);
const FORBIDDEN_PUBLIC_FIELD_FRAGMENT = /(?:auth|authorization|bearer|cookie|jwt|accesskey|privatekey|session|token|secret|password|credential|apikey|approval|command|executable|action|parameter|argument|request|payload|tool)/;
const EXECUTABLE_POSITIONAL_VALUE = /^(?:delete|create|update|confirm|execute|post|put|patch|remove|upload|import)_[a-z0-9_.-]+$/i;
const CREDENTIAL_VALUE = /^(?:bearer\s+\S+|(?:authorization|auth|cookie|set-cookie|jwt|token|secret|password|access[ _-]?key|api[ _-]?key)\s*(?::|=|$)|(?:session|sid|jwt|token|secret|password|access[ _-]?key|api[ _-]?key)[ _-]*=|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const publicDetailBrands = new WeakSet<object>();

export class WorkflowStateStoreError extends Error {
  constructor(readonly code: WorkflowStateStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = "WorkflowStateStoreError";
  }
}

export interface WorkflowStateStoreOptions {
  readonly getActiveScope: () => RuntimeSafetyScope;
  readonly now?: () => number;
  readonly handleFactory?: () => Uint8Array;
  readonly ttlMs?: number;
  readonly maxActive?: number;
  readonly maxTombstones?: number;
}

function invalid(): never { throw new WorkflowStateStoreError("workflow_state_data_invalid"); }
function normalizedKey(key: string): string { return key.replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function forbiddenKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return FORBIDDEN_KEYS.has(normalized) ||
    /(?:token|secret|password|credential|apikey|privatekey|sessioncookie|bearer)/.test(normalized) ||
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

function assertSafePublicDetailData(value: unknown): asserts value is PublicWorkflowRecord {
  assertPublicProjection(value);
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

export function createPublicWorkflowStateDetail(
  data: PublicWorkflowStateDetailInput,
): PublicWorkflowStateDetail {
  assertSafePublicDetailData(data);
  const safeData = cloneAndFreezePlanData(data) as PublicWorkflowRecord;
  const detail = Object.freeze({ contract: "workflow_state_detail_v1" as const, data: safeData });
  publicDetailBrands.add(detail);
  return detail;
}

function readPublicWorkflowStateDetail(value: unknown): PublicWorkflowRecord {
  if (typeof value !== "object" || value === null || !publicDetailBrands.has(value)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("contract") || !keys.includes("data") ||
    descriptors.contract?.value !== "workflow_state_detail_v1" || !("value" in (descriptors.data ?? {}))) invalid();
  return descriptors.data!.value as PublicWorkflowRecord;
}

function cloneScope(scope: RuntimeSafetyScope): RuntimeSafetyScope {
  return cloneAndFreezePlanData(scope) as unknown as RuntimeSafetyScope;
}
function scopesEqual(left: RuntimeSafetyScope, right: RuntimeSafetyScope): boolean {
  return left.serverInstanceId === right.serverInstanceId &&
    left.connectionIndex === right.connectionIndex &&
    left.connectionGeneration === right.connectionGeneration &&
    left.connectionName === right.connectionName &&
    left.connectionFingerprint === right.connectionFingerprint &&
    left.environmentKind === right.environmentKind &&
    left.baseUrl === right.baseUrl &&
    left.verifiedCompanyIdentity === right.verifiedCompanyIdentity &&
    left.profile === right.profile &&
    left.catalogFingerprint === right.catalogFingerprint &&
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
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== HANDLE_BYTES) throw new WorkflowStateStoreError("workflow_state_handle_collision");
  const handle = Buffer.from(bytes).toString("base64url");
  if (!HANDLE_PATTERN.test(handle)) throw new WorkflowStateStoreError("workflow_state_handle_collision");
  return handle;
}
function canonicalHandle(handle: unknown): handle is string {
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) return false;
  const bytes = Buffer.from(handle, "base64url");
  return bytes.byteLength === HANDLE_BYTES && bytes.toString("base64url") === handle;
}

function readWorkflowStateInput(candidate: unknown): WorkflowStateInput {
  if (typeof candidate !== "object" || candidate === null || utilTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(candidate);
  const expected = new Set(["workflow", "status", "items"]);
  if (keys.length !== expected.size || keys.some(key => typeof key !== "string" || !expected.has(key))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const values: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    values[key] = descriptor.value;
  }
  if (typeof values.workflow !== "string" || !WORKFLOW_PATTERN.test(values.workflow) ||
    typeof values.status !== "string" || !WORKFLOW_STATE_STATUSES.includes(values.status as WorkflowStateStatus) ||
    !Array.isArray(values.items)) invalid();
  return values as unknown as WorkflowStateInput;
}

export class WorkflowStateStore {
  readonly #active = new Map<string, StoredWorkflowState>();
  readonly #tombstones = new Set<string>();
  readonly #getActiveScope: () => RuntimeSafetyScope;
  readonly #now: () => number;
  readonly #handleFactory: () => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxActive: number;
  readonly #maxTombstones: number;

  constructor(options: WorkflowStateStoreOptions) {
    this.#getActiveScope = options.getActiveScope;
    this.#now = options.now ?? Date.now;
    this.#handleFactory = options.handleFactory ?? (() => randomBytes(HANDLE_BYTES));
    this.#ttlMs = options.ttlMs ?? WORKFLOW_STATE_TTL_MS;
    this.#maxActive = options.maxActive ?? MAX_ACTIVE_WORKFLOW_STATES;
    this.#maxTombstones = options.maxTombstones ?? MAX_WORKFLOW_STATE_TOMBSTONES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 || !Number.isSafeInteger(this.#maxActive) || this.#maxActive <= 0 ||
      !Number.isSafeInteger(this.#maxTombstones) || this.#maxTombstones <= 0) invalid();
  }

  get activeCount(): number { this.#purge(this.#readNow()); return this.#active.size; }

  issue(input: WorkflowStateInput): string {
    const safeInput = readWorkflowStateInput(input);
    assertPublicProjection(safeInput.items);
    const publicItems = safeInput.items.map(readPublicWorkflowStateDetail);
    const items = cloneAndFreezePlanData(publicItems) as readonly PlanData[];
    const now = this.#readNow();
    const expiresAt = now + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAt)) invalid();
    this.#purge(now);
    if (this.#active.size >= this.#maxActive) throw new WorkflowStateStoreError("workflow_state_capacity_exceeded");
    let scope: RuntimeSafetyScope;
    try { scope = cloneScope(this.#getActiveScope()); } catch { invalid(); }
    const stored = Object.freeze({ workflow: safeInput.workflow, status: safeInput.status, items, scope, issuedAt: now, expiresAt });
    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
      const handle = encodeHandle(this.#handleFactory());
      if (this.#active.has(handle) || this.#tombstones.has(handle)) continue;
      this.#active.set(handle, stored);
      return handle;
    }
    throw new WorkflowStateStoreError("workflow_state_handle_collision");
  }

  inspect(handle: string): StoredWorkflowState {
    if (!canonicalHandle(handle)) throw new WorkflowStateStoreError("workflow_state_handle_invalid");
    const now = this.#readNow();
    const stored = this.#active.get(handle);
    if (stored && now >= stored.expiresAt) { this.#expire(handle); this.#addTombstone(handle); }
    this.#purge(now);
    if (!stored || now >= stored.expiresAt) throw new WorkflowStateStoreError(stored || this.#tombstones.has(handle) ? "workflow_state_expired" : "workflow_state_handle_invalid");
    let current: RuntimeSafetyScope;
    try { current = cloneScope(this.#getActiveScope()); } catch { throw new WorkflowStateStoreError("workflow_state_scope_mismatch"); }
    if (!scopesEqual(stored.scope, current)) throw new WorkflowStateStoreError("workflow_state_scope_mismatch");
    return stored;
  }

  #readNow(): number { const now = this.#now(); if (!Number.isSafeInteger(now) || now < 0) invalid(); return now; }
  #purge(now: number): void {
    for (const [handle, stored] of this.#active) if (now >= stored.expiresAt) { this.#expire(handle); this.#addTombstone(handle); }
  }
  #expire(handle: string): void {
    this.#active.delete(handle);
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
