import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toMcpJson } from "./mcp-json.js";

/**
 * Response-envelope contract boundary
 * -----------------------------------
 * `toolResponse` is the single, uniform success envelope for **single-record
 * mutations** — every create / update / delete / confirm / invalidate /
 * deactivate / reactivate tool that operates on exactly one entity. They emit
 * `{ ok, action, entity, id?, message, ...extra, raw }`, where `action` is the
 * past-tense verb, `entity` is the singular entity name (matching the
 * logAudit `entity_type`), and `raw` carries the underlying API result.
 *
 * Deliberately OUTSIDE this contract — these keep their own shapes:
 *   - Read tools (`get_*`, `list_*`, `find_*`) — return the raw/paginated API
 *     payload (or, for searches, a `{ ok, action, entity, message, count, raw }`
 *     read envelope).
 *   - Batch / aggregate tools (`batch_confirm_journals`,
 *     `batch_delete_transactions`, `auto_confirm_exact_matches`, …) — return a
 *     multi-item summary (per-ID results, counts).
 *   - Document tools, importers, and any tool already returning a richer domain
 *     envelope — those are intentionally separate contracts.
 */

export interface ToolResponseEnvelopeOptions {
  ok?: boolean;
  action: string;
  entity: string;
  message: string;
  raw?: unknown;
  id?: string | number;
  found?: boolean;
  warnings?: unknown[];
  next_actions?: unknown[];
  extra?: Record<string, unknown>;
}

export function toolResponseEnvelope(options: ToolResponseEnvelopeOptions): Record<string, unknown> {
  return {
    ok: options.ok ?? true,
    action: options.action,
    entity: options.entity,
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.found !== undefined ? { found: options.found } : {}),
    message: options.message,
    ...(options.warnings !== undefined ? { warnings: options.warnings } : {}),
    ...(options.next_actions !== undefined ? { next_actions: options.next_actions } : {}),
    ...(options.extra ?? {}),
    raw: options.raw,
  };
}

export function toolResponse(options: ToolResponseEnvelopeOptions): CallToolResult {
  return {
    content: [{
      type: "text",
      text: toMcpJson(toolResponseEnvelope(options)),
    }],
  };
}
