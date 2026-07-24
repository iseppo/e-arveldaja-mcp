import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadDotenvFiles,
  loadAllConfigs,
  type NamedConfig,
  NO_API_CREDENTIALS_FOUND_MESSAGE,
  getCredentialSetupInfo,
  findImportableApiKeyFiles,
  getToolProfileConfig,
  type CredentialStorageScope,
  type Config,
  type CredentialSetupInfo,
  type ToolExposureConfig,
} from "../config.js";
import { runWithExtra } from "../progress.js";
import { HttpClient } from "../http-client.js";
import { buildConnectionFingerprint } from "../connection-fingerprint.js";
import { ClientsApi } from "../api/clients.api.js";
import { ProductsApi } from "../api/products.api.js";
import { JournalsApi } from "../api/journals.api.js";
import { TransactionsApi } from "../api/transactions.api.js";
import { SaleInvoicesApi } from "../api/sale-invoices.api.js";
import { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import { ReferenceDataApi } from "../api/readonly.api.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { createElicitor } from "../elicitation.js";
import { persistCredentialImportViaPlan } from "../tools/credential-tools.js";
import { toolError } from "../tool-error.js";
import { toMcpJson } from "../mcp-json.js";
import { setLogger, log } from "../logger.js";
import {
  maybeImportCredentialsOnStartup,
  type StartupCredentialImportOutcome,
} from "../startup-credential-import.js";
import { getAllowedRootsStartupWarning } from "../file-validation.js";
import { initAuditLog, logAudit } from "../audit-log.js";
import { serializeToolMutationError } from "../mutation-audit.js";
import { initAccountingRulesConnection } from "../accounting-rules.js";
import { createPublicToolRegistrar } from "../public-tool-registrar.js";
import { exposureForProfile, type ToolProfile } from "../tool-profile.js";
import { buildServerInstructions } from "./server-instructions.js";
import {
  type ConnectionSnapshot,
  ConnectionSwitchInterruptedError,
  captureSnapshot,
  assertSnapshotCurrent,
} from "../connection-safety.js";
import { createInvocationStorage, createScopedApiContext } from "../runtime/invocation-scope.js";
import { createConnectionState } from "../runtime/connection-manager.js";
import { createAuditLabelResolver, normalizeAuditCompanyName } from "../runtime/audit-label-resolver.js";
import { buildRuntimeSafetyContext } from "../runtime/runtime-context.js";
import {
  buildSetupModePayload,
  createSetupModeApiContext,
  isSetupModeError,
  getResourceUri,
} from "./setup-mode.js";
import { registerSystemTools } from "./register-system-tools.js";
import { registerDomainTools } from "./register-domain-tools.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../../package.json") as { version: string };

function buildApiContext(httpClient: HttpClient): ApiContext {
  return {
    clients: new ClientsApi(httpClient),
    products: new ProductsApi(httpClient),
    journals: new JournalsApi(httpClient),
    transactions: new TransactionsApi(httpClient),
    saleInvoices: new SaleInvoicesApi(httpClient),
    purchaseInvoices: new PurchaseInvoicesApi(httpClient),
    readonly: new ReferenceDataApi(httpClient),
  };
}

async function verifyImportedCredentials(config: Config): Promise<{ companyName: string | null; verifiedAt: string }> {
  // Namespace the verify cache by the credential identity. A fixed
  // "setup-import" namespace keys the cached invoice-info by path only, so
  // verifying company B within the cache TTL of company A would reuse A's
  // response — falsely "verifying" B (or mislabelling its company name).
  // Keying by apiKeyId alone is also insufficient: re-importing the SAME
  // apiKeyId with a corrected public value or password would reuse the earlier
  // verification response, storing non-working credentials as "verified". Hash
  // the FULL credential identity (never log or expose the secret itself).
  const identityHash = createHash("sha256")
    .update(`${config.apiKeyId}:${config.apiPublicValue}:${config.apiPassword}`)
    .digest("hex")
    .slice(0, 16);
  const readonly = new ReferenceDataApi(new HttpClient(config, `setup-import:${identityHash}`));
  const invoiceInfo = await readonly.getInvoiceInfo();
  return {
    companyName: normalizeAuditCompanyName(invoiceInfo.invoice_company_name),
    verifiedAt: new Date().toISOString(),
  };
}

async function resolveCredentialStorageScope(
  server: McpServer,
): Promise<CredentialStorageScope | null> {
  // Behavior-preserving: routes the storage-scope form through the shared
  // capability-aware elicitation wrapper (proves the generalization). An
  // unsupported client still surfaces the same friendly "call with storage_scope"
  // guidance; decline/cancel still returns null.
  const outcome = await createElicitor(server)({
    message: "Where should this e-arveldaja configuration be available?",
    fields: {
      storage_scope: {
        type: "enum",
        title: "Configuration availability",
        description: "Choose whether this verified configuration should work only when you start the MCP server from this folder, or from any folder on this computer.",
        choices: [
          { const: "global", title: "Any folder on this computer" },
          { const: "local", title: "Only this folder" },
        ],
        default: "global",
      },
    },
    required: ["storage_scope"],
    // Unused as a payload here — an unsupported client is translated into the
    // established friendly throw below rather than a needs_input response.
    needsInput: { status: "needs_input", category: "credential_storage_scope_required" },
  });

  if (outcome.kind === "unsupported") {
    throw new Error(
      "Client does not support interactive setup prompting. Call import_apikey_credentials with storage_scope=\"local\" for this folder only or storage_scope=\"global\" to make it available when starting the MCP server from any folder."
    );
  }
  if (outcome.kind === "declined") return null;
  const scope = outcome.content.storage_scope;
  if (typeof scope !== "string") return null;
  return scope === "local" ? "local" : "global";
}

function describeCredentialAvailability(storageScope: CredentialStorageScope): string {
  return storageScope === "global"
    ? "The configuration will be available when you start the MCP server from any folder."
    : "The configuration will be available only when you start the MCP server from this folder.";
}

function describeCredentialImportAction(
  action: import("../config.js").CredentialImportAction,
  envFile: string,
  target: "primary" | `connection_${number}`,
): string {
  switch (action) {
    case "created":
      return `Stored them as the default connection in ${envFile}.`;
    case "appended":
      return `Stored them as an additional connection (${target}) in ${envFile}.`;
    case "replaced":
      return `Replaced the default connection in ${envFile}.`;
    case "profile_updated":
      return `Kept the existing ${target} credential and updated the named tool profile in ${envFile}.`;
    case "unchanged":
      return `They were already stored as ${target} in ${envFile}, so no new credential block was added.`;
  }
}

function reportStartupCredentialImportOutcome(outcome: StartupCredentialImportOutcome): void {
  switch (outcome.status) {
    case "skipped":
      if (outcome.reason === "multiple_candidates") {
        process.stderr.write(
          "e-arveldaja MCP startup found multiple secure apikey*.txt files in the working directory. " +
          "Skipping the automatic import prompt; run import_apikey_credentials with file_path to choose one.\n"
        );
      }
      return;
    case "imported":
      process.stderr.write(
        `Verified credentials for ${outcome.result.companyName ?? "the target company"}. ` +
        `${describeCredentialImportAction(outcome.result.action, outcome.result.envFile, outcome.result.target)} ` +
        `${describeCredentialAvailability(outcome.result.storageScope)} ` +
        "Restart the MCP server to start using the stored .env.\n"
      );
      return;
    case "failed":
      if (/Client does not support interactive setup prompting/i.test(outcome.error)) {
        return;
      }
      process.stderr.write(
        `Automatic apikey import failed for ${outcome.candidateFile}: ${outcome.error}\n`
      );
      return;
  }
}

export interface McpBootstrapOptions {
  /** Explicit configs bypass environment and filesystem discovery; [] selects setup mode. */
  configs?: readonly NamedConfig[];
  setupInfo?: CredentialSetupInfo;
  toolExposure?: ToolExposureConfig;
  toolProfile?: ToolProfile;
  /** False registers the complete surface and returns without starting a transport. */
  connect?: boolean;
  /** Test/measurement seam for observing the real production registrations. */
  wrapServer?: (server: McpServer) => McpServer;
}

export interface McpBootstrapResult {
  server: McpServer;
  instructions: string;
}

export async function createMcpServer(
  options: McpBootstrapOptions = {},
): Promise<McpBootstrapResult> {
  const shouldConnect = options.connect !== false;
  if (options.configs === undefined) loadDotenvFiles();
  if (shouldConnect) {
    const allowedRootsWarning = getAllowedRootsStartupWarning();
    if (allowedRootsWarning) {
      log("warning", allowedRootsWarning);
    }
  }
  let allConfigs: NamedConfig[];
  let setupMode = false;
  if (options.configs !== undefined) {
    allConfigs = [...options.configs];
    setupMode = allConfigs.length === 0;
  } else {
    try {
      allConfigs = loadAllConfigs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith(NO_API_CREDENTIALS_FOUND_MESSAGE)) {
        throw error;
      }
      allConfigs = [];
      setupMode = true;
    }
  }

  // Log every credential source visible at startup so operators can spot
  // an unexpected apikey*.txt landing in the working directory (e.g. from a
  // shared workspace) BEFORE it becomes a reachable connection via
  // switch_connection. The name + source-path disclosure is already in
  // list_connections output; surfacing it at startup makes drift visible
  // without requiring the operator to probe.
  if (shouldConnect && allConfigs.length > 0) {
    log(
      "info",
      `Loaded ${allConfigs.length} connection(s): ` +
      allConfigs
        .map((c, i) => `[${i}] ${c.name}${c.filePath ? ` (${c.filePath})` : ""}`)
        .join("; "),
    );
  }

  const setupInfo = options.setupInfo ?? getCredentialSetupInfo();
  const connectionNames = Object.freeze(allConfigs.map(config => config.name));
  const connectionState = createConnectionState();
  initAccountingRulesConnection(() => ({
    name: allConfigs[connectionState.activeIndex]?.name ?? "setup",
    stableIdentity: allConfigs[connectionState.activeIndex]
      ? buildConnectionFingerprint(allConfigs[connectionState.activeIndex]!.config)
      : "setup",
  }));
  const connectionFingerprints = Object.fromEntries(
    allConfigs.map((config) => [config.name, buildConnectionFingerprint(config.config)]),
  );
  initAuditLog(
    () => allConfigs[connectionState.activeIndex]?.name ?? "setup",
    connectionFingerprints,
  );
  const invocationStorage = createInvocationStorage();
  /**
   * Active non-readonly tool snapshots. switch_connection consults this to
   * refuse mid-flight mutations. Tracked by object identity so the set
   * survives the async boundary without needing a unique token.
   */
  const inFlightMutations = new Set<ConnectionSnapshot>();
  const requestGuard = () => {
    const snapshot = invocationStorage.getStore();
    if (snapshot) {
      assertSnapshotCurrent(connectionState, snapshot);
    }
  };
  const connectionContexts = allConfigs.map((namedConfig, index) =>
    buildApiContext(new HttpClient(namedConfig.config, `connection:${index}`, requestGuard))
  );
  const api = setupMode
    ? createSetupModeApiContext(setupInfo)
    : createScopedApiContext(connectionState, connectionContexts, invocationStorage);
  const auditResolver = createAuditLabelResolver({ allConfigs, connectionContexts, setupMode });

  // toolExposure decides which optional/redundant tools enter tools/list;
  // resolved here (before the server instructions) so both the setup-mode
  // instruction text and the setup-tool gating below can use it.
  const resolvedProfile = getToolProfileConfig();
  const toolProfile = options.toolProfile ?? resolvedProfile.profile;
  const toolExposure = exposureForProfile(toolProfile, options.toolExposure ?? resolvedProfile.exposure);
  const runtimeSafetyContext = buildRuntimeSafetyContext({
    invocationStorage,
    configs: allConfigs,
    toolExposure,
    toolProfile,
    getVerifiedCompanyIdentity: (index) => auditResolver.getVerifiedCompanyIdentity(index),
  });

  const instructions = buildServerInstructions({ setupMode, toolExposure, toolProfile });
  const baseServer = new McpServer({
    name: "e-arveldaja",
    version: PKG_VERSION,
    description: "EXPERIMENTAL, UNOFFICIAL MCP server for the Estonian e-arveldaja (e-Financials) API. " +
      "NOT affiliated with or endorsed by RIK. Use entirely at your own risk — " +
      "this software interacts with live financial data and can create, modify, and delete accounting records. " +
      "Provides CRUD for clients, products, journals, transactions, " +
      "sale/purchase invoices. Includes account balance computation (D/C logic), " +
      "PDF invoice extraction, supplier resolution with business registry lookup, " +
      "and smart booking suggestions based on past invoices.",
  }, { instructions });
  // Registration order is a security boundary, not an implementation detail:
  // every tool first receives connection/runtime scoping, then crosses the one
  // public catalog/profile boundary. The optional observation wrapper sits
  // between them so tests/measurements see real scoped registrations without
  // bypassing either boundary.
  const scopedServer = new Proxy(baseServer, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (...toolArgs: unknown[]) => {
          const toolName = typeof toolArgs[0] === "string" ? toolArgs[0] : "unknown_tool";
          const toolSpec = (toolArgs[1] && typeof toolArgs[1] === "object")
            ? toolArgs[1] as { annotations?: { readOnlyHint?: boolean } }
            : undefined;
          const isReadOnly = toolSpec?.annotations?.readOnlyHint === true;
          const lastIdx = toolArgs.length - 1;
          if (lastIdx >= 0 && typeof toolArgs[lastIdx] === "function") {
            toolArgs[lastIdx] = wrapToolHandler(toolName, isReadOnly, toolArgs[lastIdx] as any);
          }
          return (target.registerTool as any)(...toolArgs);
        };
      }

      if (prop === "registerResource") {
        return (...resourceArgs: unknown[]) => {
          const lastIdx = resourceArgs.length - 1;
          if (lastIdx >= 0 && typeof resourceArgs[lastIdx] === "function") {
            resourceArgs[lastIdx] = wrapResourceHandler(resourceArgs[lastIdx] as any);
          }
          return (target.registerResource as any)(...resourceArgs);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as McpServer;
  const server = options.wrapServer?.(scopedServer) ?? scopedServer;
  const publicServer = createPublicToolRegistrar(server, toolProfile);

  function wrapToolHandler<T extends (...args: any[]) => any>(toolName: string, isReadOnly: boolean, handler: T): T {
    return (async (...args: unknown[]) => {
      const snapshot = captureSnapshot(connectionState, { toolName, isReadOnly });
      const extra = args.length >= 2 ? args[1] as any : undefined;
      const trackMutation = !isReadOnly && !setupMode;
      // Register the in-flight mutation synchronously *before* any awaitable
      // work. A microtask-scheduled switch_connection between snapshot
      // capture and entering `try` would otherwise see an empty set and
      // flip the generation, leaving the mutation's "switch is blocked"
      // guarantee unmet. Keeping the add/delete balanced around the same
      // snapshot: both are inside the synchronous prologue + finally.
      if (trackMutation) {
        inFlightMutations.add(snapshot);
      }
      try {
        return await invocationStorage.run(snapshot, async () => {
          if (!setupMode) {
            await auditResolver.ensureAuditLogLabelResolved(snapshot.index);
          }
          const runInExtra = extra
            ? () => runWithExtra(extra, () => handler(...args))
            : () => handler(...args);
          return runInExtra();
        });
      } catch (error) {
        // When a mutation is interrupted by a connection switch, leave a
        // dedicated audit entry so the orphan is visible in audit history.
        // The request was blocked at requestGuard and never reached the API
        // post-switch, but any pre-switch work is not rolled back by this
        // code — the entry documents exactly which tool and which connection.
        if (error instanceof ConnectionSwitchInterruptedError && trackMutation) {
          try {
            // Direct the entry to the ORIGINAL (interrupted) connection's
            // log, not the new active one. The mutation's side effects
            // (if any) landed on the original company; the audit trail for
            // that company is where operators will look when investigating.
            const originalConnectionName = allConfigs[error.originalIndex]?.name;
            logAudit({
              tool: toolName,
              action: "CONNECTION_SWITCH_INTERRUPTED",
              entity_type: "tool_execution",
              summary: `Tool "${toolName}" was interrupted by a connection switch mid-execution. ` +
                `Further API requests blocked; inspect for partial side effects.`,
              details: {
                tool_name: toolName,
                original_connection_index: error.originalIndex,
                was_read_only: Boolean(error.wasReadOnly),
              },
            }, originalConnectionName ? { connectionName: originalConnectionName } : undefined);
          } catch (auditErr) {
            log("error", `Failed to write CONNECTION_SWITCH_INTERRUPTED audit entry: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
        }
        log("error", `Tool handler error: ${error instanceof Error ? error.message : String(error)}`);
        if (process.env.EARVELDAJA_DEBUG === "true" && error instanceof Error && error.stack) {
          process.stderr.write(`[debug] ${error.stack}\n`);
        }
        if (setupMode && isSetupModeError(error)) {
          return toolError(buildSetupModePayload(setupInfo, {
            blockedTool: toolName,
            blockedApiMethod: error.blocked_api_method,
            hint: error.hint,
          }));
        }
        return serializeToolMutationError({
          toolName,
          error,
          trackMutation,
          snapshotIndex: snapshot.index,
          connectionNames,
        });
      } finally {
        if (trackMutation) {
          inFlightMutations.delete(snapshot);
        }
      }
    }) as unknown as T;
  }

  function wrapResourceHandler<T extends (...args: any[]) => any>(handler: T): T {
    return (async (...args: unknown[]) => {
      const snapshot = captureSnapshot(connectionState);
      try {
        return await invocationStorage.run(snapshot, async () => handler(...args));
      } catch (error) {
        log("error", `Resource handler error: ${error instanceof Error ? error.message : String(error)}`);
        if (process.env.EARVELDAJA_DEBUG === "true" && error instanceof Error && error.stack) {
          process.stderr.write(`[debug] ${error.stack}\n`);
        }
        if (setupMode && isSetupModeError(error)) {
          const uri = getResourceUri(args);
          return {
            contents: [{
              uri,
              mimeType: "text/plain",
              text: toMcpJson(buildSetupModePayload(setupInfo, {
                blockedResource: uri,
                blockedApiMethod: error.blocked_api_method,
                hint: error.hint,
              })),
            }],
          };
        }
        throw error;
      }
    }) as unknown as T;
  }

  registerSystemTools({
    publicServer,
    setupInfo,
    setupMode,
    toolProfile,
    pkgVersion: PKG_VERSION,
    connectionState,
    allConfigs,
    invocationStorage,
    inFlightMutations,
    runtimeSafetyContext,
    exposeSetupTools: setupMode || toolExposure.exposeSetupTools,
    verify: verifyImportedCredentials,
    resolveStorageScope: () => resolveCredentialStorageScope(publicServer),
  });

  registerDomainTools({
    publicServer,
    server,
    api,
    toolExposure,
    runtimeSafetyContext,
    toolProfile,
    setupMode,
    setupInfo,
  });

  if (!shouldConnect) {
    return { server, instructions };
  }

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Route log output through MCP logging protocol. When EARVELDAJA_LOG_FILE
  // is set, also mirror via stderr (the stderr-tee captures it to the file).
  const debugLogFile = process.env.EARVELDAJA_LOG_FILE && process.env.EARVELDAJA_LOG_FILE.trim() !== "";
  setLogger((level, message) => {
    server.sendLoggingMessage({ level, data: message });
    if (debugLogFile) {
      process.stderr.write(`[${level}] ${message}\n`);
    }
  });

  if (setupMode) {
    const startupImportOutcome = await maybeImportCredentialsOnStartup({
      env: process.env,
      candidateFiles: findImportableApiKeyFiles(),
      promptForScope: () => resolveCredentialStorageScope(server),
      // Persist the sole startup candidate ONLY through a freshly-issued,
      // single-use, drift-checked plan handle — uniform with the tool execute
      // path — instead of writing directly after elicitation.
      importCredentials: ({ apiKeyFile, storageScope }) => persistCredentialImportViaPlan(runtimeSafetyContext, {
        apiKeyFile,
        storageScope,
        verify: verifyImportedCredentials,
      }),
    });
    reportStartupCredentialImportOutcome(startupImportOutcome);
  }

  if (setupMode) {
    process.stderr.write(
      `e-arveldaja MCP server started in setup mode (0 connections configured). ` +
      `Call get_setup_instructions for credential setup. Working directory: ${setupInfo.working_directory}. ` +
      `Looking for ${setupInfo.credential_file_pattern} in: ${setupInfo.searched_directories.join(", ")}.\n`
    );
  } else {
    const names = allConfigs.map(c => c.name).join(", ");
    process.stderr.write(
      `e-arveldaja MCP server started (${allConfigs.length} connection(s): ${names}). ` +
      "Review all mutating actions via get_session_log or list_audit_logs. " +
      "The audit log is human-readable, stored under logs/, named after the company when available, and gets a connection suffix only when needed to disambiguate.\n"
    );
  }

  return { server, instructions };
}
