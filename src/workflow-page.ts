import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readOnly } from "./annotations.js";
import { createDetailPager, CURSOR_SECRET_BYTES, type DetailPageSpec } from "./detail-page.js";
import { STORE_HANDLE_PATTERN } from "./handle-store-core.js";
import { registerTool } from "./mcp-compat.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";
import { WorkflowStateStoreError, type StoredWorkflowState } from "./workflow-state-store.js";

export const DEFAULT_WORKFLOW_PAGE_SIZE = 20;
export const MAX_WORKFLOW_PAGE_SIZE = 50;
type Args = { workflow_handle: string; cursor?: string; page_size?: number };

const WORKFLOW_PAGE: DetailPageSpec<StoredWorkflowState> = {
  cursorPrefix: "w1",
  macDomain: "workflow-state-page-v1\0",
  contract: "workflow_state_page_v1",
  defaultPageSize: DEFAULT_WORKFLOW_PAGE_SIZE,
  maxPageSize: MAX_WORKFLOW_PAGE_SIZE,
  secretErrorMessage: "Workflow-state cursor secret must contain exactly 32 bytes.",
  cursorErrorCode: "workflow_state_cursor_invalid",
  cursorErrorMessage: "The workflow-state cursor is invalid.",
  failedCode: "workflow_state_page_failed",
  failedMessage: "The workflow-state page could not be retrieved.",
  isStoreError: (error): error is WorkflowStateStoreError => error instanceof WorkflowStateStoreError,
  inspect: (context, handle) => context.workflowStateStore.inspect(handle),
  header: (handle, stored) => ({ workflow_handle: handle, workflow: stored.workflow, status: stored.status }),
};

export function createWorkflowPageHandler(runtimeSafetyContext: RuntimeSafetyContext, options: { readonly cursorSecret: Uint8Array }): (args: Args) => Promise<CallToolResult> {
  const page = createDetailPager(WORKFLOW_PAGE, runtimeSafetyContext, options.cursorSecret);
  return async ({ workflow_handle, cursor, page_size }) => page(workflow_handle, cursor, page_size);
}

export function registerWorkflowPageTool(server: McpServer, runtimeSafetyContext: RuntimeSafetyContext): void {
  registerTool(server, "get_workflow_page",
    "Retrieve one bounded, read-only page of safe public workflow-state details carried by an in-progress workflow. This never resumes, advances, or mutates the workflow and grants no approval.",
    {
      workflow_handle: z.string().regex(STORE_HANDLE_PATTERN).describe("Opaque server-issued workflow-state handle"),
      cursor: z.string().max(128).optional().describe("Optional opaque cursor returned by the preceding page"),
      page_size: z.number().int().min(1).max(MAX_WORKFLOW_PAGE_SIZE).optional().describe("Maximum items to return. Default: 20; maximum: 50"),
    }, { ...readOnly, title: "Get Workflow Page" },
    createWorkflowPageHandler(runtimeSafetyContext, { cursorSecret: randomBytes(CURSOR_SECRET_BYTES) }));
}
