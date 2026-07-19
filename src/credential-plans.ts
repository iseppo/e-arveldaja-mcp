import { createHash } from "node:crypto";
import type {
  CredentialImportProjection,
  CredentialImportSecretSnapshot,
  CredentialRemoveProjection,
} from "./config.js";
import type { ExecutionPlanInput } from "./plan-store.js";
import { canonicalPlanJson } from "./tools/camt-plan.js";

// Two distinct plan domains. Because they differ, a handle issued for one
// operation is automatically rejected (plan_domain_mismatch) when replayed
// against the other — cross-operation confusion is impossible by construction.
export const CREDENTIAL_IMPORT_DOMAIN = "credential_import";
export const CREDENTIAL_REMOVE_DOMAIN = "credential_remove";

/**
 * PRIVATE drift fingerprint for a credential import. It folds in the raw secret
 * snapshot AND the full destination projection, so ANY source/destination/scope/
 * operation/overwrite/target/action change flips it. It lives only in the plan's
 * private payload and is never exposed publicly (it would be a reusable secret
 * oracle otherwise).
 */
export function credentialImportFingerprint(
  projection: CredentialImportProjection,
  snapshot: CredentialImportSecretSnapshot,
): string {
  return createHash("sha256")
    .update(canonicalPlanJson({
      operation: "import",
      server: snapshot.server,
      api_key_id: snapshot.apiKeyId,
      api_public_value: snapshot.apiPublicValue,
      api_password: snapshot.apiPassword,
      source_file: projection.sourceFile,
      env_file: projection.envFile,
      storage_scope: projection.storageScope,
      overwrite: projection.overwrite,
      target: projection.target,
      action: projection.action,
      destination_exists: projection.destinationExists,
      destination_state_token: projection.destinationStateToken,
    }))
    .digest("hex");
}

/** PRIVATE drift fingerprint for a stored-credential removal. */
export function credentialRemoveFingerprint(projection: CredentialRemoveProjection): string {
  return createHash("sha256")
    .update(canonicalPlanJson({
      operation: "remove",
      env_file: projection.envFile,
      storage_scope: projection.storageScope,
      target: projection.target,
      remaining_after: projection.remainingAfter,
      destination_exists: projection.destinationExists,
      destination_state_token: projection.destinationStateToken,
    }))
    .digest("hex");
}

/**
 * Assemble the immutable execution-plan input for a reviewed credential import.
 * The public views expose ONLY non-secret projection fields (masked key id,
 * server, scope, paths, projected target/action). The raw secret snapshot, the
 * destination-state token, and the drift fingerprint are confined to
 * privatePayload, which the plan store strips from every inspect/page view.
 */
export function buildCredentialImportPlanInput(args: {
  projection: CredentialImportProjection;
  snapshot: CredentialImportSecretSnapshot;
}): ExecutionPlanInput {
  const { projection, snapshot } = args;
  const fingerprint = credentialImportFingerprint(projection, snapshot);
  return {
    normalizedArgs: {
      operation: "import",
      storage_scope: projection.storageScope,
      overwrite: projection.overwrite,
      server: projection.server,
      source_file: projection.sourceFile,
      env_file: projection.envFile,
    },
    sourceIdentities: [{
      operation: "import",
      masked_api_key_id: projection.maskedApiKeyId,
      server: projection.server,
    }],
    liveSnapshot: {
      target: projection.target,
      action: projection.action,
      destination_exists: projection.destinationExists,
      company_name: projection.companyName,
    },
    commands: [],
    counts: {},
    totals: {},
    exclusions: [],
    reviews: [],
    privatePayload: {
      operation: "import",
      fingerprint,
      destination_state_token: projection.destinationStateToken,
      snapshot: {
        server: snapshot.server,
        api_key_id: snapshot.apiKeyId,
        api_public_value: snapshot.apiPublicValue,
        api_password: snapshot.apiPassword,
      },
      projection: {
        storage_scope: projection.storageScope,
        source_file: projection.sourceFile,
        env_file: projection.envFile,
        target: projection.target,
        action: projection.action,
        company_name: projection.companyName,
        verified_at: projection.verifiedAt,
      },
    },
  };
}

/** Assemble the immutable execution-plan input for a reviewed credential removal. */
export function buildCredentialRemovePlanInput(args: {
  projection: CredentialRemoveProjection;
}): ExecutionPlanInput {
  const { projection } = args;
  const fingerprint = credentialRemoveFingerprint(projection);
  return {
    normalizedArgs: {
      operation: "remove",
      storage_scope: projection.storageScope,
      target: projection.target,
      env_file: projection.envFile,
    },
    sourceIdentities: [{
      operation: "remove",
      target: projection.target,
    }],
    liveSnapshot: {
      target: projection.target,
      remaining_after: projection.remainingAfter,
      destination_exists: projection.destinationExists,
    },
    commands: [],
    counts: { remaining_after: projection.remainingAfter },
    totals: {},
    exclusions: [],
    reviews: [],
    privatePayload: {
      operation: "remove",
      fingerprint,
      destination_state_token: projection.destinationStateToken,
    },
  };
}
