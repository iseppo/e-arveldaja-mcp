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
