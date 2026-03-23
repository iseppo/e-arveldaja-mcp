import type { McpServer, ResourceMetadata, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type UnknownRecord = Record<string, unknown>;
type LegacyToolCallback<Args extends z.ZodRawShape> = (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown;
type LegacyPromptCallback<Args extends z.ZodRawShape> = (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown;
type StaticResourceCallback = (uri: URL, extra: unknown) => unknown;
type DynamicResourceCallback = (uri: URL, params: Record<string, string>, extra: unknown) => unknown;

const TOOL_ANNOTATION_KEYS = new Set([
  "title",
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
]);

const TITLE_WORD_OVERRIDES: Record<string, string> = {
  api: "API",
  csv: "CSV",
  iban: "IBAN",
  mcp: "MCP",
  pdf: "PDF",
  rtj: "RTJ",
  vat: "VAT",
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeName(name: string): string {
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map((segment) => {
      const override = TITLE_WORD_OVERRIDES[segment.toLowerCase()];
      if (override) return override;
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join(" ");
}

function isToolAnnotations(value: unknown): value is UnknownRecord {
  return isRecord(value) && Object.keys(value).some((key) => TOOL_ANNOTATION_KEYS.has(key));
}

function normalizeToolAnnotations(value: unknown): { title?: string; annotations?: UnknownRecord } {
  if (!isRecord(value)) return {};

  const { title, ...rest } = value;
  return {
    title: typeof title === "string" ? title : undefined,
    annotations: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

function ensureCallback(value: unknown, kind: string, name: string): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`Invalid ${kind} registration for ${name}: missing callback`);
  }
  return value as (...args: unknown[]) => unknown;
}

export function registerTool<Args extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  paramsSchema: Args,
  annotations: ToolAnnotations,
  cb: LegacyToolCallback<Args>,
): unknown;
export function registerTool(server: McpServer, name: string, ...rest: unknown[]): unknown {
  const callback = ensureCallback(rest.pop(), "tool", name);

  let description: string | undefined;
  if (typeof rest[0] === "string") {
    description = rest.shift() as string;
  }

  let inputSchema: unknown;
  let annotations: unknown;
  if (rest.length === 1) {
    if (isToolAnnotations(rest[0])) {
      annotations = rest[0];
    } else {
      inputSchema = rest[0];
    }
  } else if (rest.length === 2) {
    [inputSchema, annotations] = rest;
  } else if (rest.length > 2) {
    throw new Error(`Invalid tool registration for ${name}: unsupported legacy signature`);
  }

  const normalized = normalizeToolAnnotations(annotations);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server.registerTool as any)(name, {
    title: normalized.title ?? humanizeName(name),
    description,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(normalized.annotations ? { annotations: normalized.annotations } : {}),
  }, callback);
}

export function registerPrompt<Args extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  argsSchema: Args,
  cb: LegacyPromptCallback<Args>,
): unknown;
export function registerPrompt(
  server: McpServer,
  name: string,
  description: string,
  cb: (extra: unknown) => unknown,
): unknown;
export function registerPrompt(server: McpServer, name: string, ...rest: unknown[]): unknown {
  const callback = ensureCallback(rest.pop(), "prompt", name);

  let description: string | undefined;
  if (typeof rest[0] === "string") {
    description = rest.shift() as string;
  }

  let argsSchema: unknown;
  if (rest.length === 1) {
    [argsSchema] = rest;
  } else if (rest.length > 1) {
    throw new Error(`Invalid prompt registration for ${name}: unsupported legacy signature`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server.registerPrompt as any)(name, {
    title: humanizeName(name),
    description,
    ...(argsSchema !== undefined ? { argsSchema } : {}),
  }, callback);
}

export function registerResource(
  server: McpServer,
  name: string,
  uriOrTemplate: string,
  metadata: ResourceMetadata,
  cb: StaticResourceCallback,
): unknown;
export function registerResource(
  server: McpServer,
  name: string,
  uriOrTemplate: ResourceTemplate,
  metadata: ResourceMetadata,
  cb: DynamicResourceCallback,
): unknown;
export function registerResource(
  server: McpServer,
  name: string,
  uriOrTemplate: string | ResourceTemplate,
  ...rest: unknown[]
): unknown {
  const callback = ensureCallback(rest.pop(), "resource", name);

  let metadata: UnknownRecord | undefined;
  if (rest.length === 1) {
    if (!isRecord(rest[0])) {
      throw new Error(`Invalid resource registration for ${name}: metadata must be an object`);
    }
    metadata = rest[0];
  } else if (rest.length > 1) {
    throw new Error(`Invalid resource registration for ${name}: unsupported legacy signature`);
  }

  const title = typeof metadata?.title === "string" ? metadata.title : humanizeName(name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server.registerResource as any)(name, uriOrTemplate, {
    ...metadata,
    title,
  }, callback);
}
