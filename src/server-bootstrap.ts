/**
 * Thin compatibility barrel for the MCP runtime bootstrap.
 *
 * The runtime bootstrap was decomposed into focused modules under
 * `src/runtime/*` (connection/invocation/audit/runtime-context) and
 * `src/server/*` (create-server orchestrator, system/domain registrations,
 * setup-mode helpers, server instructions). This file remains only as a
 * stable import surface so existing `from "./server-bootstrap.js"` importers
 * (index.ts, the tool-surface fixture, tool-profile, company-resolution,
 * elicitation, and several contract tests) keep working with zero churn.
 *
 * New code should import directly from the owning module.
 */
export {
  createMcpServer,
  type McpBootstrapOptions,
  type McpBootstrapResult,
} from "./server/create-server.js";
export { buildSetupInstructionsPayload } from "./server/setup-mode.js";
