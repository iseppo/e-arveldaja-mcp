import { inspect } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function serializeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined) return "Unknown error";

  try {
    const json = JSON.stringify(error, null, 2);
    if (typeof json === "string") return json;
  } catch {}

  return inspect(error, { depth: 5, breakLength: 80, compact: false });
}

export function toolError(error: unknown): CallToolResult {
  const message = serializeUnknownError(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
