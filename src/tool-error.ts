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
  if (error instanceof Error) {
    const payload: Record<string, unknown> = { error: error.message };
    if (error.name && error.name !== "Error") payload.name = error.name;
    if ("cause" in error && error.cause !== undefined) payload.cause = error.cause;
    for (const [key, value] of Object.entries(error as unknown as Record<string, unknown>)) {
      if (key === "message" || key === "name" || key === "stack" || key === "cause") continue;
      payload[key] = value;
    }
    return payload;
  }
  if (typeof error === "string") return { error };
  if (error === undefined) return { error: "Unknown error" };
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.error === "string") return record;
    if (typeof record.message === "string") return { ...record, error: record.message };
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
