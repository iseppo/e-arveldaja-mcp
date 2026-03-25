import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toMcpJson } from "./mcp-json.js";

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

function toErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { error: error.message };
  if (typeof error === "string") return { error };
  if (error === undefined) return { error: "Unknown error" };
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.error === "string") return record;
  }
  return { error: serializeUnknownError(error) };
}

export function toolError(error: unknown): CallToolResult {
  let message: string;
  try {
    message = toMcpJson(toErrorPayload(error));
  } catch {
    message = toMcpJson({ error: "Internal error" });
  }
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
