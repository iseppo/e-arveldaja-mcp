import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error, null, 2);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
