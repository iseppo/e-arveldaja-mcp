import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readOnly } from "./annotations.js";
import { createDetailPager, type DetailPageSpec } from "./detail-page.js";
import { STORE_HANDLE_PATTERN } from "./handle-store-core.js";
import { registerTool } from "./mcp-compat.js";
import { OperationResultStoreError, type StoredOperationResult } from "./operation-result-store.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";

export const DEFAULT_OPERATION_RESULT_PAGE_SIZE = 20;
export const MAX_OPERATION_RESULT_PAGE_SIZE = 50;
type Args = { operation_handle: string; cursor?: string; page_size?: number };

const OPERATION_RESULT_PAGE: DetailPageSpec<StoredOperationResult> = {
  cursorPrefix: "r1",
  macDomain: "operation-result-page-v1\0",
  contract: "operation_result_page_v1",
  defaultPageSize: DEFAULT_OPERATION_RESULT_PAGE_SIZE,
  maxPageSize: MAX_OPERATION_RESULT_PAGE_SIZE,
  secretErrorMessage: "Operation-result cursor secret must contain exactly 32 bytes.",
  cursorErrorCode: "operation_result_cursor_invalid",
  cursorErrorMessage: "The operation-result cursor is invalid.",
  failedCode: "operation_result_page_failed",
  failedMessage: "The operation-result page could not be retrieved.",
  isStoreError: (error): error is OperationResultStoreError => error instanceof OperationResultStoreError,
  inspect: (context, handle) => context.operationResultStore.inspect(handle),
  header: (handle, stored) => ({ operation_handle: handle, operation: stored.operation, status: stored.status }),
};

export function createOperationResultPageHandler(runtimeSafetyContext: RuntimeSafetyContext, options: { readonly cursorSecret: Uint8Array }): (args: Args) => Promise<CallToolResult> {
  const page = createDetailPager(OPERATION_RESULT_PAGE, runtimeSafetyContext, options.cursorSecret);
  return async ({ operation_handle, cursor, page_size }) => page(operation_handle, cursor, page_size);
}

export function registerOperationResultTools(server: McpServer, runtimeSafetyContext: RuntimeSafetyContext): void {
  registerTool(server, "get_operation_result_page",
    "Retrieve one bounded, read-only page of safe public details from a completed operation. This never resumes or mutates the operation.",
    {
      operation_handle: z.string().regex(STORE_HANDLE_PATTERN).describe("Opaque server-issued operation-result handle"),
      cursor: z.string().max(128).optional().describe("Optional opaque cursor returned by the preceding page"),
      page_size: z.number().int().min(1).max(MAX_OPERATION_RESULT_PAGE_SIZE).optional().describe("Maximum items to return. Default: 20; maximum: 50"),
    }, { ...readOnly, title: "Get Operation Result Page" },
    // Sign with the ONE shared cursor secret owned by the runtime context so a
    // cursor issued here is also valid at the façade show_details entrypoint
    // (P3 §14.4). Never mint a fresh per-registration secret.
    createOperationResultPageHandler(runtimeSafetyContext, { cursorSecret: runtimeSafetyContext.operationResultPageCursorSecret }));
}
