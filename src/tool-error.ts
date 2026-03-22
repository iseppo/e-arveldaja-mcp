import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function serializeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined) return "Unknown error";

  try {
    const json = JSON.stringify(error, null, 2);
    if (typeof json === "string") return json.substring(0, 500);
  } catch {}

  return "Internal error";
}

export function toolError(error: unknown): CallToolResult {
  const message = serializeUnknownError(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
