import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readOnly } from "./annotations.js";
import { sandboxExternalText } from "./external-text-renderer.js";
import { registerTool } from "./mcp-compat.js";
import { toMcpJson } from "./mcp-json.js";
import { WorkflowStateStoreError } from "./workflow-state-store.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS, ResponseBudgetError } from "./response-budget.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CURSOR_PATTERN = /^w1\.(0|[1-9][0-9]{0,6})\.([A-Za-z0-9_-]{43})$/;
const CURSOR_SECRET_BYTES = 32;
export const DEFAULT_WORKFLOW_PAGE_SIZE = 20;
export const MAX_WORKFLOW_PAGE_SIZE = 50;
type Args = { workflow_handle: string; cursor?: string; page_size?: number };
class CursorError extends Error { readonly code = "workflow_state_cursor_invalid" as const; }

function canonicalJson(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(Object.keys(candidate).sort().map(key => [key, canonicalize((candidate as Record<string, unknown>)[key])]));
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
}

function mac(secret: Buffer, handle: string, offset: number, pageSize: number): Buffer {
  return createHmac("sha256", secret).update("workflow-state-page-v1\0").update(handle).update("\0")
    .update(String(offset)).update("\0").update(String(pageSize)).digest();
}
function encodeCursor(secret: Buffer, handle: string, offset: number, pageSize: number): string {
  return `w1.${offset}.${mac(secret, handle, offset, pageSize).toString("base64url")}`;
}
function decodeCursor(secret: Buffer, handle: string, cursor: string | undefined, pageSize: number, total: number): number {
  if (cursor === undefined) return 0;
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new CursorError();
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= total) throw new CursorError();
  const received = Buffer.from(match[2]!, "base64url");
  if (received.toString("base64url") !== match[2]) throw new CursorError();
  const expected = mac(secret, handle, offset, pageSize);
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) throw new CursorError();
  return offset;
}
function errorResult(error: unknown): CallToolResult {
  const safe = error instanceof WorkflowStateStoreError || error instanceof CursorError || error instanceof ResponseBudgetError
    ? { code: error.code, message: error instanceof CursorError ? "The workflow-state cursor is invalid." : error.message }
    : { code: "workflow_state_page_failed", message: "The workflow-state page could not be retrieved." };
  return { isError: true, content: [{ type: "text", text: toMcpJson({ error: safe }) }] };
}

export function createWorkflowPageHandler(runtimeSafetyContext: RuntimeSafetyContext, options: { readonly cursorSecret: Uint8Array }): (args: Args) => Promise<CallToolResult> {
  if (!(options.cursorSecret instanceof Uint8Array) || options.cursorSecret.byteLength !== CURSOR_SECRET_BYTES) throw new Error("Workflow-state cursor secret must contain exactly 32 bytes.");
  const secret = Buffer.from(options.cursorSecret);
  return async ({ workflow_handle, cursor, page_size }) => {
    try {
      const pageSize = page_size ?? DEFAULT_WORKFLOW_PAGE_SIZE;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_WORKFLOW_PAGE_SIZE) throw new CursorError();
      const stored = runtimeSafetyContext.workflowStateStore.inspect(workflow_handle);
      const offset = decodeCursor(secret, workflow_handle, cursor, pageSize, stored.items.length);
      const maximumEnd = Math.min(offset + pageSize, stored.items.length);
      const renderedItems = stored.items.slice(offset, maximumEnd).map(item => Object.freeze({
        review_data: sandboxExternalText(canonicalJson(item)),
      }));
      let end = maximumEnd;
      const profile = runtimeSafetyContext.getActiveScope().profile;
      const reductionLimit = profile === "guided" || profile === "guided-sales"
        ? RESPONSE_BUDGETS.detail.target
        : RESPONSE_BUDGETS.detail.hard;
      const build = () => Object.freeze({
        contract: "workflow_state_page_v1" as const, workflow_handle, workflow: stored.workflow, status: stored.status,
        total_items: stored.items.length,
        range: Object.freeze(stored.items.length === 0 ? { from: 0, to: 0, count: 0 } : { from: offset + 1, to: end, count: end - offset }),
        current_cursor: offset === 0 ? null : encodeCursor(secret, workflow_handle, offset, pageSize),
        next_cursor: end < stored.items.length ? encodeCursor(secret, workflow_handle, end, pageSize) : null,
        items: Object.freeze(renderedItems.slice(0, end - offset)),
      });
      let payload = build();
      while (mcpPayloadBytes(payload) > reductionLimit && end > offset + 1) { end -= 1; payload = build(); }
      if (mcpPayloadBytes(payload) > RESPONSE_BUDGETS.detail.hard) return errorResult(new ResponseBudgetError());
      return { content: [{ type: "text", text: toMcpJson(payload) }] };
    } catch (error) { return errorResult(error); }
  };
}

export function registerWorkflowPageTool(server: McpServer, runtimeSafetyContext: RuntimeSafetyContext): void {
  registerTool(server, "get_workflow_page",
    "Retrieve one bounded, read-only page of safe public workflow-state details carried by an in-progress workflow. This never resumes, advances, or mutates the workflow and grants no approval.",
    {
      workflow_handle: z.string().regex(HANDLE_PATTERN).describe("Opaque server-issued workflow-state handle"),
      cursor: z.string().max(128).optional().describe("Optional opaque cursor returned by the preceding page"),
      page_size: z.number().int().min(1).max(MAX_WORKFLOW_PAGE_SIZE).optional().describe("Maximum items to return. Default: 20; maximum: 50"),
    }, { ...readOnly, title: "Get Workflow Page" },
    createWorkflowPageHandler(runtimeSafetyContext, { cursorSecret: randomBytes(CURSOR_SECRET_BYTES) }));
}
