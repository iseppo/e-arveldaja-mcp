import { beforeEach, describe, expect, it, vi } from "vitest";
import { cache } from "./api/base-resource.js";
import { readonlyCache } from "./api/readonly.api.js";
import { parseMcpResponse } from "./mcp-json.js";
import { clearRuntimeCaches, registerCacheControlTool } from "./cache-control.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function getRegisteredHandler(server: { registerTool: ReturnType<typeof vi.fn> }, name: string): ToolHandler {
  const registration = server.registerTool.mock.calls.find(([toolName]: [string]) => toolName === name);
  if (!registration) throw new Error(`Tool '${name}' was not registered`);
  return registration[2] as ToolHandler;
}

describe("cache control", () => {
  beforeEach(() => {
    clearRuntimeCaches();
  });

  it("clears only the selected connection cache prefix", () => {
    cache.set("connection:0:/journals", "stale");
    cache.set("connection:1:/journals", "fresh");
    readonlyCache.set("connection:0:/accounts", "stale-reference");
    readonlyCache.set("connection:1:/accounts", "fresh-reference");

    const result = clearRuntimeCaches({ connectionIndex: 0 });

    expect(result.scope).toBe("connection");
    expect(result.connection_index).toBe(0);
    expect(cache.get("connection:0:/journals")).toBeUndefined();
    expect(readonlyCache.get("connection:0:/accounts")).toBeUndefined();
    expect(cache.get("connection:1:/journals")).toBe("fresh");
    expect(readonlyCache.get("connection:1:/accounts")).toBe("fresh-reference");
  });

  it("registers clear_cache with active-connection default", async () => {
    cache.set("connection:0:/journals", "stale");
    cache.set("connection:1:/journals", "other-company");

    const server = { registerTool: vi.fn() } as any;
    registerCacheControlTool(server, { getActiveConnectionIndex: () => 0 });

    const handler = getRegisteredHandler(server, "clear_cache");
    const response = await handler({});
    const payload = parseMcpResponse(response.content[0]!.text);

    expect(payload.scope).toBe("connection");
    expect(payload.connection_index).toBe(0);
    expect(payload.caches_cleared).toEqual(expect.arrayContaining([
      "api_responses",
      "reference_data",
      "vat_warning_dedupe",
    ]));
    expect(cache.get("connection:0:/journals")).toBeUndefined();
    expect(cache.get("connection:1:/journals")).toBe("other-company");
  });

  it("lets clear_cache clear all runtime caches explicitly", async () => {
    cache.set("connection:0:/journals", "stale");
    cache.set("connection:1:/journals", "also-stale");

    const server = { registerTool: vi.fn() } as any;
    registerCacheControlTool(server, { getActiveConnectionIndex: () => 0 });

    const handler = getRegisteredHandler(server, "clear_cache");
    const response = await handler({ scope: "all" });
    const payload = parseMcpResponse(response.content[0]!.text);

    expect(payload.scope).toBe("all");
    expect(payload.connection_index).toBeUndefined();
    expect(cache.get("connection:0:/journals")).toBeUndefined();
    expect(cache.get("connection:1:/journals")).toBeUndefined();
  });
});
