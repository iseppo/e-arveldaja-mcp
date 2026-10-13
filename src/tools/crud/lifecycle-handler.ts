import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logAudit, type AuditEntityType } from "../../audit-log.js";
import { toolResponse } from "../../tool-response.js";

/** Past-tense verb of a single-record lifecycle action; its upper/lower case forms are the audit action and the response action. */
export type LifecycleVerb = "Deleted" | "Confirmed" | "Invalidated" | "Deactivated" | "Reactivated";

/**
 * Handler for the plain single-record lifecycle tools (delete / confirm /
 * invalidate / deactivate / reactivate by `id`) that do nothing beyond the API
 * call, one audit entry and the standard `toolResponse` envelope. The API call
 * runs first, so a failed call throws before anything is audited. Tools with
 * pre-reads, approval gates, extra parameters, batch logic or a different
 * output keep their own handlers.
 */
export function lifecycleHandler(
  tool: string,
  verb: LifecycleVerb,
  entityType: AuditEntityType,
  run: (id: number) => Promise<unknown>,
): (args: { id: number }) => Promise<CallToolResult> {
  const label = entityType.replace(/_/g, " ");
  return async ({ id }) => {
    const result = await run(id);
    logAudit({
      tool, action: verb.toUpperCase(), entity_type: entityType, entity_id: id,
      summary: `${verb} ${label} ${id}`,
      details: {},
    });
    return toolResponse({
      action: verb.toLowerCase(),
      entity: entityType,
      id,
      message: `${verb} ${label} ${id}.`,
      raw: result,
    });
  };
}
