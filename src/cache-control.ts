import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cache } from "./api/base-resource.js";
import { readonlyCache } from "./api/readonly.api.js";
import { readOnly } from "./annotations.js";
import { registerTool } from "./mcp-compat.js";
import { toMcpJson } from "./mcp-json.js";
import { clearAllVatWarnings, clearVatWarnings } from "./tools/purchase-vat-defaults.js";

const CLEARED_CACHES = ["api_responses", "reference_data", "vat_warning_dedupe"] as const;

export interface CacheClearResult {
  scope: "connection" | "all";
  connection_index?: number;
  caches_cleared: string[];
  message: string;
}

export function clearConnectionCaches(connectionIndex: number): CacheClearResult {
  const connectionPrefix = `connection:${connectionIndex}:`;
  cache.invalidate(connectionPrefix);
  readonlyCache.invalidate(connectionPrefix);
  clearVatWarnings(connectionPrefix);

  return {
    scope: "connection",
    connection_index: connectionIndex,
    caches_cleared: [...CLEARED_CACHES],
    message: `Cleared cached e-arveldaja data for connection ${connectionIndex}.`,
  };
}

export function clearRuntimeCaches(options: { connectionIndex?: number } = {}): CacheClearResult {
  if (options.connectionIndex !== undefined) {
    return clearConnectionCaches(options.connectionIndex);
  }

  cache.invalidate();
  readonlyCache.invalidate();
  clearAllVatWarnings();

  return {
    scope: "all",
    caches_cleared: [...CLEARED_CACHES],
    message: "Cleared all cached e-arveldaja data for this MCP server process.",
  };
}

export function cacheClearMetadata(result: CacheClearResult | undefined): { cache?: Record<string, unknown> } {
  if (!result) return {};
  return {
    cache: {
      fresh: true,
      cleared: true,
      scope: result.scope,
      ...(result.connection_index !== undefined && { connection_index: result.connection_index }),
    },
  };
}

export function registerCacheControlTool(
  server: McpServer,
  options: { getActiveConnectionIndex: () => number | undefined },
): void {
  registerTool(server, "clear_cache",
    "Clear cached e-arveldaja API and reference data. Use after changing data directly in the e-arveldaja web UI, or before reports that must reflect the latest upstream state.",
    {
      scope: z.enum(["active_connection", "all"]).optional().describe("Cache scope to clear. Default: active_connection."),
    },
    { ...readOnly, title: "Clear Cache" },
    async ({ scope }) => {
      const requestedScope = scope ?? "active_connection";
      const activeConnectionIndex = options.getActiveConnectionIndex();
      const result = requestedScope === "all" || activeConnectionIndex === undefined
        ? clearRuntimeCaches()
        : clearRuntimeCaches({ connectionIndex: activeConnectionIndex });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            message: result.message,
            requested_scope: requestedScope,
            scope: result.scope,
            ...(result.connection_index !== undefined && { connection_index: result.connection_index }),
            ...(requestedScope === "active_connection" && activeConnectionIndex === undefined && {
              active_connection_available: false,
              note: "No active connection is configured, so all in-process caches were cleared.",
            }),
            caches_cleared: result.caches_cleared,
          }),
        }],
      };
    }
  );
}
