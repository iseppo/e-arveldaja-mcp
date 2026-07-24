import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import type { NamedConfig, Config, CredentialSetupInfo, CredentialStorageScope } from "../config.js";
import type { ConnectionState, ConnectionSnapshot } from "../connection-safety.js";
import { buildSwitchBlockedPayload } from "../connection-safety.js";
import { switchActiveConnection } from "../runtime/connection-manager.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import { registerCredentialTools } from "../tools/credential-tools.js";
import { registerCacheControlTool } from "../cache-control.js";
import { toolError } from "../tool-error.js";
import { toMcpJson, wrapUntrustedOcr, capUntrustedText, MAX_UNTRUSTED_TEXT_CHARS } from "../mcp-json.js";
import { readOnly, mutate, destructive } from "../annotations.js";
import {
  getAuditLog,
  getAuditLogByLabel,
  getAuditLogByConnection,
  listAuditLogs,
  clearAuditLog,
  AuditEntityType,
  AuditAction,
} from "../audit-log.js";
import { getServerStatus } from "./release-notices.js";
import { buildSetupModePayload, buildSetupInstructionsPayload } from "./setup-mode.js";

export interface RegisterSystemToolsContext {
  /** The public (profile/catalog-gated) server every system tool registers on. */
  readonly publicServer: McpServer;
  readonly setupInfo: CredentialSetupInfo;
  readonly setupMode: boolean;
  readonly toolProfile: import("../tool-profile.js").ToolProfile;
  readonly pkgVersion: string;
  readonly connectionState: ConnectionState;
  readonly allConfigs: readonly NamedConfig[];
  readonly invocationStorage: AsyncLocalStorage<ConnectionSnapshot>;
  readonly inFlightMutations: Set<ConnectionSnapshot>;
  readonly runtimeSafetyContext: RuntimeSafetyContext;
  /** Whether the credential-management tools are exposed (setup mode or the explicit flag). */
  readonly exposeSetupTools: boolean;
  readonly verify: (config: Config) => Promise<{ companyName: string | null; verifiedAt: string }>;
  readonly resolveStorageScope: () => Promise<CredentialStorageScope | null>;
}

/**
 * Register the multi-account / audit-log system tools plus the credential-
 * management and cache-control tools. The registration ORDER is a documented
 * security boundary and is preserved exactly as in the original bootstrap.
 */
export function registerSystemTools(ctx: RegisterSystemToolsContext): void {
  const {
    publicServer,
    setupInfo,
    setupMode,
    toolProfile,
    pkgVersion,
    connectionState,
    allConfigs,
    invocationStorage,
    inFlightMutations,
    runtimeSafetyContext,
    exposeSetupTools,
    verify,
    resolveStorageScope,
  } = ctx;

  // --- Multi-account tools ---

  registerTool(publicServer, "get_setup_instructions",
    "Show how to configure e-arveldaja API credentials when the server is running without connections.",
    {},
    { ...readOnly, openWorldHint: true, title: "Get Setup Instructions" },
    async () => ({
      content: [{
        type: "text",
        text: toMcpJson(buildSetupInstructionsPayload(setupInfo, setupMode)),
      }],
    })
  );

  // Compact read-only server/release status. Registered unconditionally (like
  // get_setup_instructions) — it reports only version, active profile, and any
  // active point-of-use release notices, so it needs no credentials. Active
  // notices are first-party release text, emitted unwrapped. The tool is a plain
  // core read: visible in standard/full, hidden from guided/guided-sales by
  // isToolVisibleForProfile, and in no opt-out feature-group so no flag drops it.
  registerTool(publicServer, "get_server_status",
    "Report the running e-arveldaja MCP server version, the active tool profile, and any active point-of-use release notices. Read-only; needs no credentials.",
    {},
    { ...readOnly, title: "Get Server Status" },
    async () => ({
      content: [{
        type: "text",
        text: toMcpJson(getServerStatus({ version: pkgVersion, profile: toolProfile })),
      }],
    })
  );

  // Credential-management tools are only needed in setup mode (no connections
  // yet) or when an operator is adding/rotating credentials, so they are hidden
  // by default once connections exist to cut the per-session tools/list cost.
  // Restore them in configured mode with EARVELDAJA_EXPOSE_SETUP_TOOLS=1.
  // get_setup_instructions stays registered above so the agent can always
  // explain how to add a connection (its payload documents these tools).
  // Persistence is preview-first and gated behind one-attempt plan handles; see
  // src/tools/credential-tools.ts.
  registerCredentialTools(
    publicServer,
    {
      verify,
      resolveStorageScope,
    },
    runtimeSafetyContext,
    exposeSetupTools,
  );

  registerTool(publicServer, "list_connections",
    "List configured e-arveldaja connections and the active index.",
    {},
    { ...readOnly, title: "List Connections" },
    async () => {
      const connections = allConfigs.map((nc: NamedConfig, i: number) => ({
        index: i,
        name: nc.name,
        active: i === connectionState.activeIndex,
        server: nc.config.baseUrl.includes("demo") ? "demo" : "live",
      }));

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            connections,
            active: allConfigs.length > 0 ? connectionState.activeIndex : null,
            total: allConfigs.length,
            setup_required: allConfigs.length === 0,
            working_directory: setupInfo.working_directory,
            searched_directories: setupInfo.searched_directories,
            global_config_directory: setupInfo.global_config_directory,
            global_env_file: setupInfo.global_env_file,
            import_tool: "import_apikey_credentials",
            hint: allConfigs.length === 0
              ? "No API credentials configured. Call get_setup_instructions, run import_apikey_credentials for an apikey*.txt in this folder, or add EARVELDAJA_API_* env vars / EARVELDAJA_API_KEY_FILE."
              : "Use switch_connection with the index to switch between accounts.",
          }),
        }],
      };
    }
  );

  registerTool(publicServer, "switch_connection",
    "Switch active e-arveldaja connection. Clears caches; interrupted in-flight tools are blocked from further API requests.",
    {
      index: z.number().int().describe("Connection index from list_connections"),
    },
    { ...mutate, title: "Switch Connection" },
    async ({ index }) => {
      if (allConfigs.length === 0) {
        return toolError(buildSetupModePayload(setupInfo, { blockedTool: "switch_connection" }));
      }

      if (index < 0 || index >= allConfigs.length) {
        return toolError({
          error: `Invalid index ${index}. Valid range: 0-${allConfigs.length - 1}`,
        });
      }

      if (index === connectionState.activeIndex) {
        return {
          content: [{
            type: "text",
            text: toMcpJson({
              message: `Already connected to "${allConfigs[index]!.name}"`,
            }),
          }],
        };
      }

      // Reject the switch while any non-readonly tool is mid-execution.
      // Without this gate, a mutation in flight against the previous
      // connection would either (a) silently land on the wrong company
      // via `requestGuard` not-yet-triggered or (b) abort partway with
      // side effects half-applied. Humans need to decide whether to
      // wait or cancel the MCP client request.
      const blockedPayload = buildSwitchBlockedPayload(
        inFlightMutations,
        invocationStorage.getStore(),
      );
      if (blockedPayload) {
        return toolError(blockedPayload);
      }

      const target = allConfigs[index]!;
      const previousIndex = connectionState.activeIndex;

      const snapshot = switchActiveConnection(connectionState, previousIndex, index);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            message: `Switched to "${target.name}"`,
            server: target.config.baseUrl.includes("demo") ? "demo" : "live",
            generation: snapshot.generation,
            note: "The previous and target connections' caches are cleared atomically, so one company's data is never served to another. New tool calls use the new connection; interrupted in-flight tools cannot make further API requests, but a request already in flight may still have completed.",
          }),
        }],
      };
    }
  );

  registerCacheControlTool(publicServer, {
    getActiveConnectionIndex: () => allConfigs.length > 0 ? connectionState.activeIndex : undefined,
  });

  // --- Audit log tools ---

  registerTool(publicServer, "get_session_log",
    "Retrieve mutating-operation audit log Markdown for the current connection, another audit-log label, or connection:<raw name>.",
    {
      connection: z.string().optional().describe("Audit-log label, or connection:<raw connection name>; default current connection."),
      entity_type: AuditEntityType.optional().describe("Filter by entity type."),
      action: AuditAction.optional().describe("Filter by action."),
      date_from: z.string().optional().describe("Return entries from this date (YYYY-MM-DD or ISO 8601)"),
      date_to: z.string().optional().describe("Return entries up to this date (YYYY-MM-DD or ISO 8601)"),
      limit: z.number().int().min(1).optional().describe("Maximum entries to return (positive integer, default 100, returns most recent)"),
    },
    { ...readOnly, title: "Get Session Audit Log" },
    async (params) => {
      const filter = {
        entity_type: params.entity_type,
        action: params.action,
        date_from: params.date_from,
        date_to: params.date_to,
        limit: params.limit,
      };
      const content = params.connection
        ? params.connection.startsWith("connection:")
          ? getAuditLogByConnection(params.connection.slice("connection:".length), filter)
          : getAuditLogByLabel(params.connection, filter) || getAuditLogByConnection(params.connection, filter)
        : getAuditLog(filter);
      // Audit log entries embed OCR/CAMT/Wise-origin fields (PDF item titles,
      // bank-statement descriptions, auto-booking titles). Reading them back
      // to the LLM without a sandbox turns this readback into another bypass
      // route for injection. Wrap the whole markdown so any untrusted fragment
      // inside the rendered text stays inside nonce delimiters. "No entries"
      // is developer-controlled and not worth wrapping.
      if (!content) {
        return { content: [{ type: "text", text: "No audit log entries found." }] };
      }
      // Cap the (untrusted, potentially large) audit blob before wrapping so a
      // long log — especially with no explicit limit — cannot flood the
      // consuming LLM's context. The truncation notice sits OUTSIDE the sandbox.
      const capped = capUntrustedText(content, MAX_UNTRUSTED_TEXT_CHARS);
      const wrapped = wrapUntrustedOcr(capped.text) ?? capped.text ?? content;
      const suffix = capped.truncated
        ? `\n[audit log truncated: ${MAX_UNTRUSTED_TEXT_CHARS} of ${capped.original_length} chars — narrow with date_from / date_to / limit]`
        : "";
      return {
        content: [{
          type: "text",
          text: wrapped + suffix,
        }],
      };
    }
  );

  registerTool(publicServer, "list_audit_logs",
    "List available human-readable audit log files.",
    {},
    { ...readOnly, title: "List Audit Logs" },
    async () => {
      const logs = listAuditLogs();
      const items = logs.map(l => ({
        connection: l.connection,
        file: l.file,
        entries: l.entries,
        last_entry: l.last_entry,
      }));
      const hint = items.length === 0
        ? "No audit logs found."
        : `${items.length} audit log file(s) available.`;
      return {
        content: [{ type: "text", text: toMcpJson({ items, count: items.length, hint }) }],
      };
    }
  );

  registerTool(publicServer, "clear_session_log",
    "Clear the audit log for the current connection. DESTRUCTIVE — cannot be undone.",
    {},
    { ...destructive, title: "Clear Session Audit Log" },
    async () => {
      if (setupMode) {
        return toolError(buildSetupModePayload(setupInfo, {
          blockedTool: "clear_session_log",
          hint: "Call get_setup_instructions and configure credentials before using mutating session-log tools.",
        }));
      }
      clearAuditLog();
      return {
        content: [{
          type: "text",
          text: toMcpJson({ message: "Audit log cleared for current connection." }),
        }],
      };
    }
  );
}
