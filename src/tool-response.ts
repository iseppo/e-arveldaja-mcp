import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toMcpJson } from "./mcp-json.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolResponseEnvelope(options: ToolResponseEnvelopeOptions): Record<string, unknown> {
  const rawFields = isRecord(options.raw) ? options.raw : {};

  return {
    ...rawFields,
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
