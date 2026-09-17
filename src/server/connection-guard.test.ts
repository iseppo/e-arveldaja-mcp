import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./create-server.js";
import { parseMcpResponse } from "../mcp-json.js";
import type { NamedConfig } from "../config.js";

// verifiedCompanyName is pre-set so the audit-label resolver never reaches
// for the (fake) API on first use.
const CONFIG_A: NamedConfig = {
  name: "guard-a",
  verifiedCompanyName: "Guard Company A",
  config: { apiKeyId: "a-id", apiPublicValue: "a-public", apiPassword: "a-secret", baseUrl: "https://demo-rmp-api.rik.ee/v1" },
};
const CONFIG_B: NamedConfig = {
  name: "guard-b",
  verifiedCompanyName: "Guard Company B",
  config: { apiKeyId: "b-id", apiPublicValue: "b-public", apiPassword: "b-secret", baseUrl: "https://demo-rmp-api.rik.ee/v1" },
};

async function connect(configs: NamedConfig[]) {
  const bootstrap = await createMcpServer({ configs, toolProfile: "full", connect: false });
  const client = new Client({ name: "connection-guard-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: () => Promise.allSettled([client.close(), bootstrap.server.close()]),
  };
}

function payloadOf(response: { content?: unknown }): Record<string, unknown> {
  const first = (response.content as Array<{ text: string }>)[0]!;
  return parseMcpResponse(first.text) as Record<string, unknown>;
}

function schemaProps(tools: Array<{ name: string; inputSchema: unknown }>, name: string): Record<string, unknown> {
  const tool = tools.find(t => t.name === name);
  expect(tool, `tool ${name} registered`).toBeDefined();
  return ((tool!.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {};
}

describe("connection guard (GitHub #61)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    const logsDir = join(process.cwd(), "logs");
    if (!existsSync(logsDir)) return;
    for (const entry of readdirSync(logsDir)) {
      if (/^Guard Company [AB]\.audit\.md$|^guard-[ab]\.audit\.md$/.test(entry)) rmSync(join(logsDir, entry), { force: true });
    }
  });

  it("adds an optional `connection` argument to non-readonly tools only when several connections exist", async () => {
    const multi = await connect([CONFIG_A, CONFIG_B]);
    try {
      const tools = (await multi.client.listTools()).tools;
      expect(schemaProps(tools, "create_client")).toHaveProperty("connection");
      expect(schemaProps(tools, "update_purchase_invoice")).toHaveProperty("connection");
      expect(schemaProps(tools, "clear_session_log")).toHaveProperty("connection");
      expect(schemaProps(tools, "get_vat_info")).not.toHaveProperty("connection");
      expect(schemaProps(tools, "list_connections")).not.toHaveProperty("connection");
      expect(schemaProps(tools, "switch_connection")).not.toHaveProperty("connection");
    } finally {
      await multi.close();
    }

    const single = await connect([CONFIG_A]);
    try {
      const tools = (await single.client.listTools()).tools;
      expect(schemaProps(tools, "create_client")).not.toHaveProperty("connection");
    } finally {
      await single.close();
    }
  });

  it("refuses a write whose `connection` does not name the active connection, before any API call", async () => {
    const { client, close } = await connect([CONFIG_A, CONFIG_B]);
    try {
      for (const wrong of [1, "guard-b", "1", "no-such-company"]) {
        const response = await client.callTool({
          name: "create_client",
          arguments: { connection: wrong, name: "Should never be created", is_client: true, is_supplier: false, is_physical_entity: false },
        });
        expect(response.isError, `connection=${JSON.stringify(wrong)}`).toBe(true);
        const payload = payloadOf(response);
        expect(payload.category).toBe("connection_mismatch");
        expect(payload.active_connection).toEqual({ index: 0, name: "guard-a" });
        expect(String(payload.error)).toContain("No API request was made");
      }
    } finally {
      await close();
    }
  });

  it("lets a call through when `connection` matches by index, numeric string or name, and strips the argument", async () => {
    const { client, close } = await connect([CONFIG_A, CONFIG_B]);
    try {
      for (const right of [0, "0", "guard-a"]) {
        const response = await client.callTool({ name: "clear_session_log", arguments: { connection: right } });
        expect(response.isError ?? false, `connection=${JSON.stringify(right)}`).toBe(false);
      }
      // After switching, the same guard follows the new active connection.
      const switched = await client.callTool({ name: "switch_connection", arguments: { index: 1 } });
      expect(switched.isError ?? false).toBe(false);
      const staleGuard = await client.callTool({ name: "clear_session_log", arguments: { connection: "guard-a" } });
      expect(staleGuard.isError).toBe(true);
      expect(payloadOf(staleGuard).active_connection).toEqual({ index: 1, name: "guard-b" });
      const freshGuard = await client.callTool({ name: "clear_session_log", arguments: { connection: "guard-b" } });
      expect(freshGuard.isError ?? false).toBe(false);
    } finally {
      await close();
    }
  });

  it("starts on the connection named by EARVELDAJA_DEFAULT_CONNECTION", async () => {
    vi.stubEnv("EARVELDAJA_DEFAULT_CONNECTION", "guard-b");
    const { client, close } = await connect([CONFIG_A, CONFIG_B]);
    try {
      const response = payloadOf(await client.callTool({ name: "list_connections", arguments: {} })) as { active: number };
      expect(response.active).toBe(1);
    } finally {
      await close();
    }
  });

  it("fails startup instead of silently using index 0 when EARVELDAJA_DEFAULT_CONNECTION is unknown", async () => {
    vi.stubEnv("EARVELDAJA_DEFAULT_CONNECTION", "guard-z");
    await expect(createMcpServer({ configs: [CONFIG_A, CONFIG_B], connect: false }))
      .rejects.toThrow(/EARVELDAJA_DEFAULT_CONNECTION="guard-z" does not match/);
  });
});
