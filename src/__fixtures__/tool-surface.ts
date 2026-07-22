import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CredentialSetupInfo,
  NamedConfig,
  ToolExposureConfig,
} from "../config.js";
import { createMcpServer } from "../server-bootstrap.js";

export interface MeasuredMcpSurface {
  toolCount: number;
  toolsListBytes: number;
  descriptionsBytes: number;
  inputSchemasBytes: number;
  largestTool: { name: string; bytes: number };
  serverInstructionsBytes: number;
  promptMetadataBytes: number;
  resourceMetadataBytes: number;
}

export const TOOL_SURFACE_PROFILES = [
  "default",
  "setup",
  "full",
  "lean-purchase",
] as const;

export type ToolSurfaceProfileName = typeof TOOL_SURFACE_PROFILES[number];

type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

interface SurfaceProfile {
  setupMode: boolean;
  exposure: ToolExposureConfig;
}

export interface ToolSurfaceSnapshot {
  profile: ToolSurfaceProfileName;
  measurement: MeasuredMcpSurface;
  serverInstructions: string;
  tools: ListedTool[];
  prompts: unknown[];
  resources: unknown[];
  resourceTemplates: unknown[];
}

const DEFAULT_EXPOSURE: ToolExposureConfig = Object.freeze({
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
});

const PROFILES: Record<ToolSurfaceProfileName, SurfaceProfile> = {
  default: { setupMode: false, exposure: DEFAULT_EXPOSURE },
  setup: { setupMode: true, exposure: DEFAULT_EXPOSURE },
  full: {
    setupMode: false,
    exposure: { ...DEFAULT_EXPOSURE, exposeGranularTools: true, exposeSetupTools: true },
  },
  "lean-purchase": {
    setupMode: false,
    exposure: {
      enableLightyear: false,
      exposeGranularTools: false,
      exposeSetupTools: false,
      enableTaxTools: false,
      enableReferenceAdmin: false,
      enableAnnualReport: false,
      enableSales: false,
      enableProducts: false,
    },
  },
};

export const TOOL_SURFACE_SETUP_INFO: CredentialSetupInfo = Object.freeze({
  mode: "setup",
  message: "No API credentials found.",
  working_directory: "/normalized/workspace",
  searched_directories: ["/normalized/workspace", "/normalized/config"],
  env_vars: [
    "EARVELDAJA_API_KEY_ID",
    "EARVELDAJA_API_PUBLIC_VALUE",
    "EARVELDAJA_API_PASSWORD",
  ],
  credential_file_env_var: "EARVELDAJA_API_KEY_FILE",
  credential_file_pattern: "apikey*.txt",
  credential_file_directory: "/normalized/workspace",
  global_config_directory: "/normalized/config",
  global_config_directory_env_var: "EARVELDAJA_CONFIG_DIR",
  global_env_file: "/normalized/config/.env",
  file_format_example: [
    "ApiKey ID: <key_id>",
    "ApiKey public value: <public_value>",
    "Password: <password>",
  ],
  next_steps: ["Call import_apikey_credentials."],
});

const CONFIGURED_CONNECTION: NamedConfig = Object.freeze({
  name: "surface-fixture",
  config: Object.freeze({
    apiKeyId: "fixture-key-id",
    apiPublicValue: "fixture-public-value",
    apiPassword: "fixture-password",
    baseUrl: "https://demo-rmp-api.rik.ee/v1",
  }),
});

function recordingServer(server: McpServer): McpServer {
  const registered = {
    registerTool: new Set<string>(),
    registerPrompt: new Set<string>(),
    registerResource: new Set<string>(),
  };

  return new Proxy(server, {
    get(target, property) {
      if (property === "registerTool" || property === "registerPrompt" || property === "registerResource") {
        return (name: string, ...args: unknown[]) => {
          const seen = registered[property];
          if (seen.has(name)) throw new Error(`Duplicate MCP ${property.slice("register".length).toLowerCase()} name: ${name}`);
          seen.add(name);
          return (target[property] as (...callArgs: unknown[]) => unknown).call(target, name, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpServer;
}

function normalize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, key));
  if (typeof value !== "object" || value === null) {
    if (typeof value !== "string") return value;
    if (/^(?:plan_handle|file_ref|handle|nonce)$/i.test(key) && /^[A-Za-z0-9_-]{43}$/.test(value)) {
      return `<${key.toUpperCase()}>`;
    }
    return value
      .replace(/((?:E_ARVELDAJA_RUN_DATA|END_E_ARVELDAJA_RUN_DATA):)[A-Za-z0-9_-]{43}/g, "$1<NONCE>")
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g, "<TIMESTAMP>")
      .replace(/\bp1\.\d+\.[A-Za-z0-9_-]{43}\b/g, "<CURSOR>")
      .replace(/\/(?:home|Users|tmp|var\/folders)\/[^\s\"']+/g, "<ABSOLUTE_PATH>")
      .replace(/[A-Za-z]:\\(?:[^\s\"']+\\)+[^\s\"']*/g, "<ABSOLUTE_PATH>");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entry]) => [entryKey, normalize(entry, entryKey)]),
  );
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function measure(
  rawToolsResult: { tools: ListedTool[] },
  instructions: string,
  rawPromptsResult: unknown,
  rawResourcesResult: unknown,
): MeasuredMcpSurface {
  const largestTool = rawToolsResult.tools
    .map((tool) => ({ name: tool.name, bytes: byteLength(tool) }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))[0] ?? { name: "", bytes: 0 };
  return {
    toolCount: rawToolsResult.tools.length,
    toolsListBytes: byteLength(rawToolsResult),
    descriptionsBytes: rawToolsResult.tools.reduce((total, tool) => total + byteLength(tool.description ?? ""), 0),
    inputSchemasBytes: rawToolsResult.tools.reduce((total, tool) => total + byteLength(tool.inputSchema), 0),
    largestTool,
    serverInstructionsBytes: byteLength(instructions),
    promptMetadataBytes: byteLength(rawPromptsResult),
    resourceMetadataBytes: byteLength(rawResourcesResult),
  };
}

export async function captureToolSurface(profileName: ToolSurfaceProfileName): Promise<ToolSurfaceSnapshot> {
  const profile = PROFILES[profileName];
  const bootstrap = await createMcpServer({
    configs: profile.setupMode ? [] : [CONFIGURED_CONNECTION],
    setupInfo: TOOL_SURFACE_SETUP_INFO,
    toolExposure: profile.exposure,
    connect: false,
    wrapServer: recordingServer,
  });
  const { server, instructions } = bootstrap;
  const client = new Client({ name: "surface-measurement", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const [rawTools, rawPrompts, rawResources, rawResourceTemplates] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    const toolsResult = normalize(rawTools) as { tools: ListedTool[] };
    const promptsResult = normalize(rawPrompts) as { prompts: unknown[] };
    const resourcesResult = normalize(rawResources) as { resources: unknown[] };
    const resourceTemplatesResult = normalize(rawResourceTemplates) as { resourceTemplates: unknown[] };
    const rawCombinedResources = {
      resources: rawResources.resources,
      resourceTemplates: rawResourceTemplates.resourceTemplates,
    };

    return {
      profile: profileName,
      measurement: measure(
        rawTools as { tools: ListedTool[] },
        instructions,
        rawPrompts,
        rawCombinedResources,
      ),
      serverInstructions: instructions,
      tools: toolsResult.tools,
      prompts: promptsResult.prompts,
      resources: resourcesResult.resources,
      resourceTemplates: resourceTemplatesResult.resourceTemplates,
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}
