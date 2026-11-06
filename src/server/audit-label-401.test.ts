import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./create-server.js";
import { getAuthBrakeStates, resetAuthBrakes } from "../api-health.js";
import type { NamedConfig } from "../config.js";

const STALE: NamedConfig = {
  name: "stale-key",
  config: { apiKeyId: "stale-id", apiPublicValue: "stale-public", apiPassword: "stale-secret", baseUrl: "https://demo-rmp-api.rik.ee/v1" },
};

describe("audit-label resolution on a stale key", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthBrakes();
  });

  it("sends one /invoice_info after a 401 and never trips the 401 brake on credential-free tools", async () => {
    resetAuthBrakes();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const bootstrap = await createMcpServer({ configs: [STALE], toolProfile: "full", connect: false });
    const client = new Client({ name: "audit-label-401-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: "get_server_status", arguments: {} });
      expect(status.isError).not.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      for (let i = 0; i < 5; i++) {
        const response = await client.callTool({ name: "list_connections", arguments: {} });
        expect(response.isError).not.toBe(true);
        await client.callTool({ name: "clear_cache", arguments: {} });
        await client.callTool({ name: "get_server_status", arguments: {} });
        // Not credential-free by catalog group: resolves the label, but only
        // once per failure window (negative cache).
        await client.callTool({ name: "get_session_log", arguments: {} });
      }

      const invoiceInfoCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/invoice_info"));
      expect(invoiceInfoCalls).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getAuthBrakeStates().some(state => state.cooldown_until !== null)).toBe(false);
    } finally {
      await Promise.allSettled([client.close(), bootstrap.server.close()]);
    }
  });
});

function staleConnection(n: number): NamedConfig {
  return {
    name: `stale-${n}`,
    config: { apiKeyId: `stale-id-${n}`, apiPublicValue: `stale-public-${n}`, apiPassword: `stale-secret-${n}`, baseUrl: "https://demo-rmp-api.rik.ee/v1" },
  };
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
}

describe("hidden audit-label lookups and the shared 401 brake", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthBrakes();
  });

  async function connectThreeStale(fetchMock: ReturnType<typeof vi.fn>) {
    resetAuthBrakes();
    vi.stubGlobal("fetch", fetchMock);
    const bootstrap = await createMcpServer({
      configs: [staleConnection(1), staleConnection(2), staleConnection(3)],
      toolProfile: "full",
      connect: false,
    });
    const client = new Client({ name: "audit-label-brake-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: () => Promise.allSettled([client.close(), bootstrap.server.close()]) };
  }

  const brakeTripped = () => getAuthBrakeStates().some(state => state.cooldown_until !== null);

  it("credential-free tools on three different stale connections send nothing and leave the brake open", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => unauthorized());
    const { client, close } = await connectThreeStale(fetchMock);
    try {
      for (const index of [0, 1, 2]) {
        expect((await client.callTool({ name: "switch_connection", arguments: { index } })).isError).not.toBe(true);
        expect((await client.callTool({ name: "list_connections", arguments: {} })).isError).not.toBe(true);
        expect((await client.callTool({ name: "clear_cache", arguments: {} })).isError).not.toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(brakeTripped()).toBe(false);
    } finally {
      await close();
    }
  });

  it("a hidden /invoice_info 401 on each of three stale connections does not trip the brake; real tool 401s still do", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => unauthorized());
    const { client, close } = await connectThreeStale(fetchMock);
    try {
      // get_session_log reads only the local audit log: the resolver's hidden
      // GET /invoice_info is the only request each call sends.
      for (const index of [0, 1, 2]) {
        await client.callTool({ name: "switch_connection", arguments: { index } });
        expect((await client.callTool({ name: "get_session_log", arguments: {} })).isError).not.toBe(true);
      }
      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls).toHaveLength(3);
      expect(urls.every(url => url.includes("/invoice_info"))).toBe(true);
      expect(brakeTripped()).toBe(false);

      // Real tool requests that answer 401 still feed the brake.
      for (const index of [0, 1, 2]) {
        await client.callTool({ name: "switch_connection", arguments: { index } });
        expect((await client.callTool({ name: "list_accounts", arguments: {} })).isError).toBe(true);
      }
      expect(brakeTripped()).toBe(true);
      const cooled = await client.callTool({ name: "list_accounts", arguments: {} });
      expect(cooled.isError).toBe(true);
      expect(JSON.stringify(cooled.content)).toContain("auth_cooldown");
    } finally {
      await close();
    }
  });
});
