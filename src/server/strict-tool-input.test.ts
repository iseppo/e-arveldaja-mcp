import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./create-server.js";
import type { NamedConfig } from "../config.js";

// Unknown tool arguments must be refused, not silently stripped: a stripped
// filter makes the tool answer a different question (compute_account_balance
// once ignored accounts_dimensions_id and returned the whole-account balance).

const CONFIG_A: NamedConfig = {
  name: "strict-a",
  verifiedCompanyName: "Strict Company A",
  config: { apiKeyId: "a-id", apiPublicValue: "a-public", apiPassword: "a-secret", baseUrl: "https://demo-rmp-api.rik.ee/v1" },
};
const CONFIG_B: NamedConfig = {
  name: "strict-b",
  verifiedCompanyName: "Strict Company B",
  config: { apiKeyId: "b-id", apiPublicValue: "b-public", apiPassword: "b-secret", baseUrl: "https://demo-rmp-api.rik.ee/v1" },
};

async function connect(configs: NamedConfig[]) {
  const bootstrap = await createMcpServer({ configs, toolProfile: "full", connect: false });
  const client = new Client({ name: "strict-tool-input-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: () => Promise.allSettled([client.close(), bootstrap.server.close()]),
  };
}

function textOf(response: { content?: unknown }): string {
  return (response.content as Array<{ text: string }>)[0]!.text;
}

describe("strict tool input", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advertises additionalProperties:false on every tool", async () => {
    const { client, close } = await connect([CONFIG_A, CONFIG_B]);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.length).toBeGreaterThan(100);
      const open = tools.filter(t => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false);
      expect(open.map(t => t.name)).toEqual([]);
    } finally {
      await close();
    }
  });

  it("refuses an unknown argument before the handler runs (no API request)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client, close } = await connect([CONFIG_A]);
    try {
      const response = await client.callTool({
        name: "compute_account_dimension_balances",
        arguments: { account_id: 1020, clients_id: 5 },
      });
      expect(response.isError).toBe(true);
      expect(textOf(response)).toContain("Input validation error");
      expect(textOf(response)).toContain("clients_id");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("refuses arguments on a tool that takes none", async () => {
    const { client, close } = await connect([CONFIG_A]);
    try {
      const rejected = await client.callTool({ name: "list_connections", arguments: { verbose: true } });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain("verbose");
      const accepted = await client.callTool({ name: "list_connections", arguments: {} });
      expect(accepted.isError ?? false).toBe(false);
    } finally {
      await close();
    }
  });

  it("refuses `connection` on a read-only tool instead of ignoring it (multi-connection)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client, close } = await connect([CONFIG_A, CONFIG_B]);
    try {
      const response = await client.callTool({
        name: "compute_account_balance",
        arguments: { account_id: 1020, connection: "strict-b" },
      });
      expect(response.isError).toBe(true);
      expect(textOf(response)).toContain("connection");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
