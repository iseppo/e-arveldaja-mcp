import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { toolError } from "../tool-error.js";
import { readOnly, mutate, destructive } from "../annotations.js";
import { isRecord } from "../record-utils.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { PlanStoreError } from "../plan-store.js";
import {
  commitApiKeyCredentialImport,
  commitRemoveStoredCredential,
  findImportableApiKeyFiles as defaultFindImportableApiKeyFiles,
  listStoredCredentials,
  previewApiKeyCredentialImport,
  previewRemoveStoredCredential,
  type Config,
  type CredentialStorageScope,
  type CredentialVerificationResult,
  type ImportApiKeyCredentialsOptions,
  type ImportApiKeyCredentialsResult,
} from "../config.js";
import {
  buildCredentialImportPlanInput,
  buildCredentialRemovePlanInput,
  credentialImportFingerprint,
  credentialRemoveFingerprint,
  CREDENTIAL_IMPORT_DOMAIN,
  CREDENTIAL_REMOVE_DOMAIN,
} from "../credential-plans.js";

export interface CredentialToolDeps {
  /** Verifies a candidate credential against the API (returns the company name). */
  verify: (config: Config) => Promise<CredentialVerificationResult>;
  /** Interactive storage-scope elicitation; returns null when cancelled. */
  resolveStorageScope: () => Promise<CredentialStorageScope | null>;
  /** Test seam; defaults to the working-directory apikey scan. */
  findImportableApiKeyFiles?: () => string[];
}

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function jsonResponse(payload: Record<string, unknown>): ToolResponse {
  return { content: [{ type: "text", text: toMcpJson(payload) }] };
}

function planErrorResult(category: string, message: string): ToolResponse {
  return toolError({ error: message, category, mutation_occurred: false }) as ToolResponse;
}

function storedPrivate(plan: { privatePayload: unknown }): Record<string, unknown> | undefined {
  return isRecord(plan.privatePayload) ? plan.privatePayload : undefined;
}

function describeAvailability(storageScope: CredentialStorageScope): string {
  return storageScope === "global"
    ? "The configuration will be available when you start the MCP server from any folder."
    : "The configuration will be available only when you start the MCP server from this folder.";
}

function describeImportAction(
  action: "created" | "appended" | "replaced" | "unchanged",
  envFile: string,
  target: "primary" | `connection_${number}`,
): string {
  switch (action) {
    case "created": return `Would store them as the default connection in ${envFile}.`;
    case "appended": return `Would store them as an additional connection (${target}) in ${envFile}.`;
    case "replaced": return `Would replace the default connection in ${envFile}.`;
    case "unchanged": return `They are already stored as ${target} in ${envFile}, so no new credential block is needed.`;
  }
}

function describeCommittedAction(
  action: "created" | "appended" | "replaced" | "unchanged",
  envFile: string,
  target: "primary" | `connection_${number}`,
): string {
  switch (action) {
    case "created": return `Stored them as the default connection in ${envFile}.`;
    case "appended": return `Stored them as an additional connection (${target}) in ${envFile}.`;
    case "replaced": return `Replaced the default connection in ${envFile}.`;
    case "unchanged": return `They were already stored as ${target} in ${envFile}, so no new credential block was added.`;
  }
}

/**
 * Issue → consume → drift-gate → persist, bound to a single one-attempt handle.
 * Shared by the tool execute path and the startup sole-candidate import so
 * persistence is reachable ONLY through a freshly-issued, drift-checked handle.
 */
export async function persistCredentialImportViaPlan(
  runtimeSafetyContext: RuntimeSafetyContext,
  options: ImportApiKeyCredentialsOptions,
): Promise<ImportApiKeyCredentialsResult> {
  const preview = await previewApiKeyCredentialImport(options);
  if (preview.unchanged) return preview.result;

  const handle = runtimeSafetyContext.planStore.issue(
    CREDENTIAL_IMPORT_DOMAIN,
    buildCredentialImportPlanInput({ projection: preview.projection, snapshot: preview.snapshot }),
  );
  const storedPlan = runtimeSafetyContext.planStore.consume(handle, CREDENTIAL_IMPORT_DOMAIN);

  const fresh = await previewApiKeyCredentialImport(options);
  const stored = storedPrivate(storedPlan);
  const storedFingerprint = stored && typeof stored.fingerprint === "string" ? stored.fingerprint : undefined;
  if (
    stored?.operation !== "import" ||
    fresh.unchanged ||
    storedFingerprint !== credentialImportFingerprint(fresh.projection, fresh.snapshot)
  ) {
    throw new Error("Credential source or destination changed during startup import; no credentials were persisted.");
  }
  return commitApiKeyCredentialImport({
    snapshot: fresh.snapshot,
    projection: fresh.projection,
    workingDir: options.workingDir,
    globalConfigDir: options.globalConfigDir,
  });
}

export function registerCredentialTools(
  server: McpServer,
  deps: CredentialToolDeps,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposeCredentialTools: boolean,
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  if (!exposeCredentialTools) return;

  const findCandidates = deps.findImportableApiKeyFiles ?? defaultFindImportableApiKeyFiles;

  async function resolveApiKeyFile(filePath: string | undefined): Promise<string | ToolResponse> {
    if (filePath) return filePath;
    const candidates = findCandidates();
    if (candidates.length === 0) {
      return toolError({
        error: "No secure apikey*.txt file found in the current folder.",
        hint: "Place a valid apikey*.txt in this folder or pass file_path explicitly.",
      }) as ToolResponse;
    }
    if (candidates.length > 1) {
      return toolError({
        error: "Multiple apikey*.txt files found in the current folder.",
        hint: "Pass file_path explicitly so the server knows which file to import.",
        candidates,
      }) as ToolResponse;
    }
    return candidates[0]!;
  }

  async function resolveScope(
    provided: CredentialStorageScope | undefined,
  ): Promise<CredentialStorageScope | null | ToolResponse> {
    if (provided) return provided;
    try {
      return await deps.resolveStorageScope();
    } catch (error) {
      return toolError(error) as ToolResponse;
    }
  }

  registerTool(server, "import_apikey_credentials",
    "Preview and persist apikey*.txt credentials into local/global .env. Preview-first: the default call verifies and projects the target and returns a plan_handle; call again with execute=true and that handle to persist. overwrite=false appends different credentials as another connection.",
    {
      file_path: z.string().optional().describe("Absolute path to apikey*.txt; defaults to the only secure apikey*.txt in cwd."),
      storage_scope: z.enum(["local", "global"]).optional().describe("local = this folder; global = any folder. Omit for interactive choice when supported."),
      overwrite: z.boolean().optional().describe("Replace the default stored connection instead of appending. Default false."),
      execute: z.boolean().optional().describe("Persist the reviewed preview (default false = preview only, writes nothing)."),
      plan_handle: z.string().optional().describe("Plan handle returned by the reviewed preview. Required for execute=true."),
    },
    { ...mutate, openWorldHint: true, title: "Import API Key Credentials" },
    async ({ file_path, storage_scope, overwrite = false, execute = false, plan_handle }): Promise<ToolResponse> => {
      const apiKeyFileOrError = await resolveApiKeyFile(file_path);
      if (typeof apiKeyFileOrError !== "string") return apiKeyFileOrError;
      const apiKeyFile = apiKeyFileOrError;

      const scopeOrError = await resolveScope(storage_scope as CredentialStorageScope | undefined);
      if (scopeOrError !== null && typeof scopeOrError === "object") return scopeOrError;
      if (scopeOrError === null) {
        return jsonResponse({
          cancelled: true,
          message: "Credential import cancelled before choosing whether the configuration should work only in this folder or from any folder.",
        });
      }
      const storageScope = scopeOrError;
      const options: ImportApiKeyCredentialsOptions = {
        apiKeyFile,
        storageScope,
        overwrite,
        verify: deps.verify,
      };

      if (execute !== true) {
        // PREVIEW — read + verify + project. Writes NOTHING. Returns a handle.
        let preview;
        try {
          preview = await previewApiKeyCredentialImport(options);
        } catch (error) {
          return toolError(error) as ToolResponse;
        }
        if (preview.unchanged) {
          return jsonResponse({
            mode: "PREVIEW",
            execute: false,
            action: "unchanged",
            already_stored: true,
            company_name: preview.projection.companyName,
            env_file: preview.projection.envFile,
            storage_scope: preview.projection.storageScope,
            target: preview.projection.target,
            masked_api_key_id: preview.projection.maskedApiKeyId,
            restart_required: false,
            message: `${describeImportAction("unchanged", preview.projection.envFile, preview.projection.target)} No plan_handle is issued because there is nothing to persist.`,
          });
        }
        let handle: string;
        try {
          handle = runtimeSafetyContext.planStore.issue(
            CREDENTIAL_IMPORT_DOMAIN,
            buildCredentialImportPlanInput({ projection: preview.projection, snapshot: preview.snapshot }),
          );
        } catch (error) {
          if (error instanceof PlanStoreError) return planErrorResult(error.code, error.message);
          throw error;
        }
        return jsonResponse({
          mode: "PREVIEW",
          execute: false,
          plan_handle: handle,
          action: preview.projection.action,
          company_name: preview.projection.companyName,
          env_file: preview.projection.envFile,
          storage_scope: preview.projection.storageScope,
          source_file: preview.projection.sourceFile,
          target: preview.projection.target,
          masked_api_key_id: preview.projection.maskedApiKeyId,
          verified_at: preview.projection.verifiedAt,
          overwrite: preview.projection.overwrite,
          restart_required: false,
          message: `Verified credentials for ${preview.projection.companyName ?? "the target company"}. ${describeImportAction(preview.projection.action, preview.projection.envFile, preview.projection.target)} ${describeAvailability(preview.projection.storageScope)} Nothing has been written yet.`,
          next_step: "Review this projection, then call import_apikey_credentials again with execute=true and this plan_handle to persist.",
          suggested_execute_args: {
            ...(file_path !== undefined ? { file_path } : {}),
            storage_scope: preview.projection.storageScope,
            overwrite: preview.projection.overwrite,
            execute: true,
            plan_handle: handle,
          },
        });
      }

      // EXECUTE — consume the one-attempt handle (burns before validate), re-read
      // and re-verify the source, reject on ANY drift, then commit atomically.
      if (typeof plan_handle !== "string" || plan_handle.length === 0) {
        return planErrorResult(
          "plan_handle_required",
          "A reviewed plan_handle from the credential preview is required to persist credentials.",
        );
      }
      let storedPlan;
      try {
        storedPlan = runtimeSafetyContext.planStore.consume(plan_handle, CREDENTIAL_IMPORT_DOMAIN);
      } catch (error) {
        if (error instanceof PlanStoreError) return planErrorResult(error.code, error.message);
        throw error;
      }

      let fresh;
      try {
        fresh = await previewApiKeyCredentialImport(options);
      } catch (error) {
        return toolError(error) as ToolResponse;
      }
      const stored = storedPrivate(storedPlan);
      const storedFingerprint = stored && typeof stored.fingerprint === "string" ? stored.fingerprint : undefined;
      if (
        stored?.operation !== "import" ||
        fresh.unchanged ||
        storedFingerprint !== credentialImportFingerprint(fresh.projection, fresh.snapshot)
      ) {
        return planErrorResult(
          "plan_drift",
          "The reviewed credential plan no longer matches the source and destination. Re-run the preview.",
        );
      }

      let result: ImportApiKeyCredentialsResult;
      try {
        result = commitApiKeyCredentialImport({ snapshot: fresh.snapshot, projection: fresh.projection });
      } catch (error) {
        return toolError(error) as ToolResponse;
      }
      return jsonResponse({
        message: `Verified credentials for ${result.companyName ?? "the target company"}. ${describeCommittedAction(result.action, result.envFile, result.target)} ${describeAvailability(result.storageScope)} Restart the MCP server to use them.`,
        action: result.action,
        company_name: result.companyName,
        env_file: result.envFile,
        storage_scope: result.storageScope,
        source_file: result.sourceFile,
        target: result.target,
        verified_at: result.verifiedAt,
        restart_required: true,
      });
    },
  );

  registerTool(server, "list_stored_credentials",
    "Inspect credentials stored in local/global .env files.",
    {
      storage_scope: z.enum(["local", "global"]).optional().describe("Optional scope filter."),
    },
    { ...readOnly, openWorldHint: true, title: "List Stored Credentials" },
    async ({ storage_scope }): Promise<ToolResponse> => {
      const scopes = listStoredCredentials();
      const filtered = storage_scope
        ? scopes.filter((scope) => scope.storageScope === storage_scope)
        : scopes;
      return jsonResponse({
        scopes: filtered,
        total_scopes: filtered.length,
        total_credentials: filtered.reduce((sum, scope) => sum + scope.credentials.length, 0),
        hint: filtered.length === 0
          ? "No stored credentials found in local/global .env files."
          : "Use remove_stored_credentials with storage_scope and target to preview a deletion, then execute=true with the plan_handle. Restart the MCP server after removing credentials.",
      });
    },
  );

  registerTool(server, "remove_stored_credentials",
    "Preview and remove one stored credential block from a local/global .env file. Preview-first: the default call projects the removal and returns a plan_handle; call again with execute=true and that handle to delete.",
    {
      storage_scope: z.enum(["local", "global"]).describe("Which .env file to modify."),
      target: z.string().regex(/^(primary|connection_\d+)$/, "Must be 'primary' or 'connection_N'").describe("Stored target from list_stored_credentials, e.g. primary or connection_1."),
      execute: z.boolean().optional().describe("Persist the reviewed removal (default false = preview only, writes nothing)."),
      plan_handle: z.string().optional().describe("Plan handle returned by the reviewed preview. Required for execute=true."),
    },
    { ...destructive, openWorldHint: true, title: "Remove Stored Credentials" },
    async ({ storage_scope, target, execute = false, plan_handle }): Promise<ToolResponse> => {
      const options = {
        storageScope: storage_scope as CredentialStorageScope,
        target: target as "primary" | `connection_${number}`,
      };

      if (execute !== true) {
        let projection;
        try {
          projection = previewRemoveStoredCredential(options);
        } catch (error) {
          return toolError(error) as ToolResponse;
        }
        let handle: string;
        try {
          handle = runtimeSafetyContext.planStore.issue(
            CREDENTIAL_REMOVE_DOMAIN,
            buildCredentialRemovePlanInput({ projection }),
          );
        } catch (error) {
          if (error instanceof PlanStoreError) return planErrorResult(error.code, error.message);
          throw error;
        }
        return jsonResponse({
          mode: "PREVIEW",
          execute: false,
          plan_handle: handle,
          env_file: projection.envFile,
          storage_scope: projection.storageScope,
          removed_target: projection.target,
          remaining_after: projection.remainingAfter,
          restart_required: false,
          message: `Would remove stored credential block ${projection.target} from ${projection.envFile}, leaving ${projection.remainingAfter} credential block(s). Nothing has been written yet.`,
          next_step: "Review this projection, then call remove_stored_credentials again with execute=true and this plan_handle to delete.",
          suggested_execute_args: {
            storage_scope: projection.storageScope,
            target: projection.target,
            execute: true,
            plan_handle: handle,
          },
        });
      }

      if (typeof plan_handle !== "string" || plan_handle.length === 0) {
        return planErrorResult(
          "plan_handle_required",
          "A reviewed plan_handle from the removal preview is required to delete credentials.",
        );
      }
      let storedPlan;
      try {
        storedPlan = runtimeSafetyContext.planStore.consume(plan_handle, CREDENTIAL_REMOVE_DOMAIN);
      } catch (error) {
        if (error instanceof PlanStoreError) return planErrorResult(error.code, error.message);
        throw error;
      }

      let fresh;
      try {
        fresh = previewRemoveStoredCredential(options);
      } catch (error) {
        return planErrorResult("plan_drift", "The credential to remove no longer matches the reviewed plan. Re-run the preview.");
      }
      const stored = storedPrivate(storedPlan);
      const storedFingerprint = stored && typeof stored.fingerprint === "string" ? stored.fingerprint : undefined;
      if (
        stored?.operation !== "remove" ||
        storedFingerprint !== credentialRemoveFingerprint(fresh)
      ) {
        return planErrorResult(
          "plan_drift",
          "The reviewed removal plan no longer matches the destination. Re-run the preview.",
        );
      }

      let result;
      try {
        result = commitRemoveStoredCredential({ projection: fresh });
      } catch (error) {
        return toolError(error) as ToolResponse;
      }
      return jsonResponse({
        message: `Removed stored credential block ${result.removedTarget} from ${result.envFile}. Restart the MCP server for the change to take effect.`,
        env_file: result.envFile,
        storage_scope: result.storageScope,
        removed_target: result.removedTarget,
        remaining_credentials: result.remainingCredentials,
        restart_required: true,
      });
    },
  );
}
