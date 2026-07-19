import { describe, expect, it } from "vitest";
import type {
  CredentialImportProjection,
  CredentialImportSecretSnapshot,
  CredentialRemoveProjection,
} from "./config.js";
import {
  buildCredentialImportPlanInput,
  buildCredentialRemovePlanInput,
  credentialImportFingerprint,
  credentialRemoveFingerprint,
  CREDENTIAL_IMPORT_DOMAIN,
  CREDENTIAL_REMOVE_DOMAIN,
} from "./credential-plans.js";

const SNAPSHOT: CredentialImportSecretSnapshot = {
  server: "live",
  apiKeyId: "key-id-1234567890",
  apiPublicValue: "public-value-abcdef",
  apiPassword: "super-secret-password",
};

const IMPORT_PROJECTION: CredentialImportProjection = {
  operation: "import",
  storageScope: "local",
  sourceFile: "/work/apikey.txt",
  envFile: "/work/.env",
  server: "live",
  overwrite: false,
  target: "primary",
  action: "created",
  companyName: "Acme OÜ",
  verifiedAt: "2026-03-29T12:00:00.000Z",
  maskedApiKeyId: "key-…7890",
  destinationExists: false,
  destinationStateToken: "token-aaa",
};

const REMOVE_PROJECTION: CredentialRemoveProjection = {
  operation: "remove",
  storageScope: "global",
  envFile: "/global/.env",
  target: "connection_1",
  remainingAfter: 1,
  destinationExists: true,
  destinationStateToken: "token-bbb",
};

// Deep search: does any value anywhere in `value` equal (or contain) `needle`?
function deepContains(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => deepContains(item, needle));
  if (value && typeof value === "object") return Object.values(value).some((item) => deepContains(item, needle));
  return false;
}

describe("credential plan domains", () => {
  it("uses distinct import and remove domains", () => {
    expect(CREDENTIAL_IMPORT_DOMAIN).toBe("credential_import");
    expect(CREDENTIAL_REMOVE_DOMAIN).toBe("credential_remove");
    expect(CREDENTIAL_IMPORT_DOMAIN).not.toBe(CREDENTIAL_REMOVE_DOMAIN);
  });
});

describe("credentialImportFingerprint", () => {
  it("is stable for the same projection and snapshot", () => {
    expect(credentialImportFingerprint(IMPORT_PROJECTION, SNAPSHOT))
      .toBe(credentialImportFingerprint(IMPORT_PROJECTION, SNAPSHOT));
  });

  it("changes when the secret snapshot changes (source drift)", () => {
    const drifted = { ...SNAPSHOT, apiPassword: "different-password" };
    expect(credentialImportFingerprint(IMPORT_PROJECTION, drifted))
      .not.toBe(credentialImportFingerprint(IMPORT_PROJECTION, SNAPSHOT));
  });

  it.each([
    ["destinationStateToken", { destinationStateToken: "token-zzz" }],
    ["storageScope", { storageScope: "global" as const }],
    ["overwrite", { overwrite: true }],
    ["target", { target: "connection_1" as const }],
    ["action", { action: "appended" as const }],
    ["envFile", { envFile: "/other/.env" }],
  ])("changes when %s drifts", (_label, patch) => {
    const base = credentialImportFingerprint(IMPORT_PROJECTION, SNAPSHOT);
    expect(credentialImportFingerprint({ ...IMPORT_PROJECTION, ...patch }, SNAPSHOT)).not.toBe(base);
  });
});

describe("credentialRemoveFingerprint", () => {
  it("is stable and drift-sensitive", () => {
    const base = credentialRemoveFingerprint(REMOVE_PROJECTION);
    expect(credentialRemoveFingerprint(REMOVE_PROJECTION)).toBe(base);
    expect(credentialRemoveFingerprint({ ...REMOVE_PROJECTION, destinationStateToken: "x" })).not.toBe(base);
    expect(credentialRemoveFingerprint({ ...REMOVE_PROJECTION, target: "primary" })).not.toBe(base);
  });
});

describe("buildCredentialImportPlanInput", () => {
  const input = buildCredentialImportPlanInput({ projection: IMPORT_PROJECTION, snapshot: SNAPSHOT });

  it("keeps the raw secret, fingerprint, and destination token PRIVATE only", () => {
    const { privatePayload, ...publicPortion } = input;
    // The raw secret and any reusable fingerprint/token must not appear publicly.
    expect(deepContains(publicPortion, SNAPSHOT.apiPassword)).toBe(false);
    expect(deepContains(publicPortion, SNAPSHOT.apiPublicValue)).toBe(false);
    expect(deepContains(publicPortion, SNAPSHOT.apiKeyId)).toBe(false);
    expect(deepContains(publicPortion, IMPORT_PROJECTION.destinationStateToken)).toBe(false);
    expect(deepContains(publicPortion, credentialImportFingerprint(IMPORT_PROJECTION, SNAPSHOT))).toBe(false);

    // The private payload DOES carry the snapshot + fingerprint + token.
    expect(deepContains(privatePayload, SNAPSHOT.apiPassword)).toBe(true);
    expect(deepContains(privatePayload, credentialImportFingerprint(IMPORT_PROJECTION, SNAPSHOT))).toBe(true);
    expect(deepContains(privatePayload, IMPORT_PROJECTION.destinationStateToken)).toBe(true);
  });

  it("exposes only the masked key id in the public projection", () => {
    const { privatePayload: _priv, ...publicPortion } = input;
    expect(deepContains(publicPortion, IMPORT_PROJECTION.maskedApiKeyId)).toBe(true);
  });

  it("binds the operation for defense-in-depth", () => {
    expect((input.privatePayload as Record<string, unknown>).operation).toBe("import");
  });
});

describe("buildCredentialRemovePlanInput", () => {
  it("keeps the fingerprint and token private and binds the operation", () => {
    const input = buildCredentialRemovePlanInput({ projection: REMOVE_PROJECTION });
    const { privatePayload, ...publicPortion } = input;
    expect(deepContains(publicPortion, REMOVE_PROJECTION.destinationStateToken)).toBe(false);
    expect(deepContains(publicPortion, credentialRemoveFingerprint(REMOVE_PROJECTION))).toBe(false);
    expect(deepContains(privatePayload, credentialRemoveFingerprint(REMOVE_PROJECTION))).toBe(true);
    expect((privatePayload as Record<string, unknown>).operation).toBe("remove");
  });
});
