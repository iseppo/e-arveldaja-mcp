import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import { getBaseUrlForServer, type NamedConfig, type ToolExposureConfig } from "./config.js";
import { buildConnectionFingerprint } from "./connection-fingerprint.js";
import type { ConnectionSnapshot } from "./connection-safety.js";
import { ExecutionPlanStore, type ExecutionPlanStoreOptions } from "./plan-store.js";
import { FileReferenceStore, type FileReferenceStoreOptions } from "./file-reference-store.js";

export type RuntimeEnvironmentKind = "live" | "demo" | "setup";

export interface RuntimeSafetyScope {
  readonly serverInstanceId: string;
  readonly connectionIndex: number | null;
  readonly connectionGeneration: number;
  readonly connectionName: string;
  readonly connectionFingerprint: string;
  readonly environmentKind: RuntimeEnvironmentKind;
  readonly baseUrl: string | null;
  readonly features: Readonly<ToolExposureConfig>;
}

export interface RuntimeSafetyContext {
  readonly serverInstanceId: string;
  readonly planStore: ExecutionPlanStore;
  readonly fileReferenceStore: FileReferenceStore;
  getActiveScope(): RuntimeSafetyScope;
}

export interface CreateRuntimeSafetyContextOptions {
  readonly invocationStorage: AsyncLocalStorage<ConnectionSnapshot>;
  readonly configs: readonly NamedConfig[];
  readonly toolExposure: ToolExposureConfig;
  readonly serverInstanceId?: string;
  readonly planStore?: Omit<ExecutionPlanStoreOptions, "getActiveScope">;
  readonly fileReferenceStore?: Omit<FileReferenceStoreOptions, "getActiveScope">;
}

export function assertRuntimeSafetyContext(value: unknown): asserts value is RuntimeSafetyContext {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    throw new Error("A valid runtime safety context is required.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = ["serverInstanceId", "planStore", "fileReferenceStore", "getActiveScope"] as const;
  if (required.some(key => {
    const descriptor = descriptors[key];
    return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
  })) {
    throw new Error("A valid runtime safety context is required.");
  }
  if (typeof descriptors.serverInstanceId!.value !== "string" ||
    !(descriptors.planStore!.value instanceof ExecutionPlanStore) ||
    !(descriptors.fileReferenceStore!.value instanceof FileReferenceStore) ||
    typeof descriptors.getActiveScope!.value !== "function") {
    throw new Error("A valid runtime safety context is required.");
  }
}

function freezeFeatures(features: ToolExposureConfig): Readonly<ToolExposureConfig> {
  const expectedKeys: ReadonlyArray<keyof ToolExposureConfig> = [
    "enableLightyear",
    "exposeGranularTools",
    "exposeSetupTools",
    "enableTaxTools",
    "enableReferenceAdmin",
    "enableAnnualReport",
    "enableSales",
    "enableProducts",
  ];
  if (utilTypes.isProxy(features)) {
    throw new Error("Runtime safety context requires a complete tool exposure configuration.");
  }
  const actualKeys = Reflect.ownKeys(features);
  const descriptors = Object.getOwnPropertyDescriptors(features);
  if (actualKeys.length !== expectedKeys.length ||
    actualKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key as keyof ToolExposureConfig)) ||
    expectedKeys.some(key => {
      const descriptor = descriptors[key];
      return !descriptor || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "boolean";
    })) {
    throw new Error("Runtime safety context requires a complete tool exposure configuration.");
  }
  return Object.freeze(Object.fromEntries(expectedKeys.map(key => [key, descriptors[key]!.value]))) as unknown as
    Readonly<ToolExposureConfig>;
}

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Runtime safety context received an invalid connection URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Runtime safety context requires an HTTP(S) connection URL.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.href.replace(/\/$/, "");
}

function environmentKind(baseUrl: string): Exclude<RuntimeEnvironmentKind, "setup"> {
  if (baseUrl === normalizeBaseUrl(getBaseUrlForServer("demo"))) return "demo";
  if (baseUrl === normalizeBaseUrl(getBaseUrlForServer("live"))) return "live";
  throw new Error("Runtime safety context received an unknown live/demo connection URL.");
}

function createServerInstanceId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Build the one server-owned safety context. Active scope is derived only from
 * the AsyncLocalStorage invocation snapshot and immutable startup config. It
 * intentionally has no mutable-active-connection fallback.
 */
export function createRuntimeSafetyContext(
  options: CreateRuntimeSafetyContextOptions,
): RuntimeSafetyContext {
  const serverInstanceId = options.serverInstanceId ?? createServerInstanceId();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(serverInstanceId)) {
    throw new Error("Runtime safety context received an invalid server instance identity.");
  }

  const features = freezeFeatures(options.toolExposure);
  const connections = Object.freeze(options.configs.map((entry, index) => {
    const baseUrl = normalizeBaseUrl(entry.config.baseUrl);
    return Object.freeze({
      index,
      name: entry.name,
      fingerprint: buildConnectionFingerprint(entry.config),
      baseUrl,
      environmentKind: environmentKind(baseUrl),
    });
  }));

  const getActiveScope = (): RuntimeSafetyScope => {
    const snapshot = options.invocationStorage.getStore();
    if (!snapshot) {
      throw new Error("Runtime safety scope is unavailable outside an MCP invocation.");
    }
    const connection = connections[snapshot.index];
    if (!connection) {
      if (connections.length === 0 && snapshot.index === 0) {
        return Object.freeze({
          serverInstanceId,
          connectionIndex: null,
          connectionGeneration: snapshot.generation,
          connectionName: "setup",
          connectionFingerprint: "setup",
          environmentKind: "setup" as const,
          baseUrl: null,
          features,
        });
      }
      throw new Error("Runtime safety scope references an unknown connection.");
    }
    return Object.freeze({
      serverInstanceId,
      connectionIndex: connection.index,
      connectionGeneration: snapshot.generation,
      connectionName: connection.name,
      connectionFingerprint: connection.fingerprint,
      environmentKind: connection.environmentKind,
      baseUrl: connection.baseUrl,
      features,
    });
  };

  const planStore = new ExecutionPlanStore({
    ...options.planStore,
    getActiveScope,
  });
  const fileReferenceStore = new FileReferenceStore({
    ...options.fileReferenceStore,
    getActiveScope,
  });
  return Object.freeze({ serverInstanceId, planStore, fileReferenceStore, getActiveScope });
}
