import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicToolRegistrar } from "./public-tool-registrar.js";
import { toolMeta } from "./tool-catalog.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server-bootstrap.js";
import { TOOL_SURFACE_SETUP_INFO } from "./__fixtures__/tool-surface.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMcpResponse } from "./mcp-json.js";
import { currentToolProfile } from "./tool-profile.js";

describe("PublicToolRegistrar", () => {
  it("filters the real production bootstrap without stdio", async () => {
    const bootstrap = await createMcpServer({ configs: [], setupInfo: TOOL_SURFACE_SETUP_INFO, toolProfile: "guided", connect: false });
    const client = new Client({ name: "profile-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map(({ name }) => name);
      expect(names).toHaveLength(19);
      expect(names).toContain("process_bank_input");
      expect(names).toContain("process_accounting_document");
      expect(names).toContain("run_accounting_report");
      expect(names).toContain("search_accounting_records");
      expect(names).toContain("inspect_accounting_record");
      expect(names).not.toContain("process_camt053");
      expect(names).not.toContain("import_wise_transactions");
      expect(names).not.toContain("create_purchase_invoice_from_pdf");
      expect(names).not.toContain("compute_trial_balance");
      expect(names).not.toContain("reconcile_inter_account_transfers");
      expect(names).not.toContain("manage_sale_invoice");
      expect(names).toContain("get_operation_result_page");
      expect(names).toContain("recommend_workflow");
      expect(names).not.toContain("create_journal");
    } finally {
      await Promise.allSettled([client.close(), bootstrap.server.close()]);
    }
  });

  it("filters only the public boundary and strips private catalog metadata", () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;
    const publicServer = createPublicToolRegistrar(server, "guided");
    publicServer.registerTool("recommend_workflow", { _meta: { earveldajaTool: toolMeta("recommend_workflow") } }, vi.fn());
    publicServer.registerTool("create_journal", { _meta: { earveldajaTool: toolMeta("create_journal") } }, vi.fn());
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]![0]).toBe("recommend_workflow");
    expect(registerTool.mock.calls[0]![1]).not.toHaveProperty("_meta.earveldajaTool");
  });

  it("rejects duplicate public names server-wide", () => {
    const server = { registerTool: vi.fn() } as unknown as McpServer;
    const first = createPublicToolRegistrar(server, "full");
    const second = createPublicToolRegistrar(server, "full");
    first.registerTool("recommend_workflow", { _meta: { earveldajaTool: toolMeta("recommend_workflow") } }, vi.fn());
    expect(() => second.registerTool("recommend_workflow", { _meta: { earveldajaTool: toolMeta("recommend_workflow") } }, vi.fn()))
      .toThrow("Duplicate public MCP tool name");
  });

  it("fails closed on missing metadata and destructive parity", () => {
    const server = { registerTool: vi.fn() } as unknown as McpServer;
    const publicServer = createPublicToolRegistrar(server, "full");
    expect(() => publicServer.registerTool("unknown", {}, vi.fn())).toThrow("Missing ToolMeta");
    expect(() => publicServer.registerTool("delete_transaction", {
      annotations: { destructiveHint: false },
      _meta: { earveldajaTool: toolMeta("delete_transaction") },
    }, vi.fn())).toThrow("destructive-risk metadata mismatch");
  });

  it("composes invocation scope outside the public profile callback", async () => {
    const events: string[] = [];
    let registered: (() => Promise<void>) | undefined;
    const real = {
      registerTool: (_name: string, _config: unknown, callback: () => Promise<void>) => { registered = callback; },
    } as unknown as McpServer;
    const scoped = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "registerTool") return Reflect.get(target, property, receiver);
        return (name: string, config: unknown, callback: () => Promise<void>) =>
          target.registerTool(name, config as any, async () => {
            events.push("scope-enter");
            await callback();
            events.push("scope-exit");
          });
      },
    }) as McpServer;
    const publicServer = createPublicToolRegistrar(scoped, "guided");
    publicServer.registerTool("recommend_workflow", { _meta: { earveldajaTool: toolMeta("recommend_workflow") } }, async () => {
      events.push(`profile:${currentToolProfile()}`);
    });

    await registered!();
    expect(events).toEqual(["scope-enter", "profile:guided", "scope-exit"]);
  });

  it("runs credential and plan tools through the active runtime scope", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "earveldaja-profile-scope-"));
    const previousConfigDir = process.env.EARVELDAJA_CONFIG_DIR;
    process.env.EARVELDAJA_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, ".env"), [
      "EARVELDAJA_SERVER=live",
      "EARVELDAJA_API_KEY_ID=scope-key",
      "EARVELDAJA_API_PUBLIC_VALUE=scope-public",
      "EARVELDAJA_API_PASSWORD=scope-password",
      "",
    ].join("\n"), { mode: 0o600 });

    const bootstrap = await createMcpServer({ configs: [], setupInfo: TOOL_SURFACE_SETUP_INFO, toolProfile: "full", connect: false });
    const client = new Client({ name: "scope-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const removal = await client.callTool({
        name: "remove_stored_credentials",
        arguments: { storage_scope: "global", target: "primary" },
      });
      const preview = parseMcpResponse((removal.content[0] as { text: string }).text) as Record<string, unknown>;
      expect(removal.isError).not.toBe(true);
      expect(preview.plan_handle).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const page = await client.callTool({
        name: "get_execution_plan_page",
        arguments: { plan_handle: preview.plan_handle },
      });
      const pagePayload = parseMcpResponse((page.content[0] as { text: string }).text) as Record<string, unknown>;
      expect(page.isError).not.toBe(true);
      expect(pagePayload.contract).toBe("execution_plan_page_v1");
    } finally {
      await Promise.allSettled([client.close(), bootstrap.server.close()]);
      if (previousConfigDir === undefined) delete process.env.EARVELDAJA_CONFIG_DIR;
      else process.env.EARVELDAJA_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("resolves verified company identity before read-only tools and reuses verified startup metadata", async () => {
    const config = {
      name: "company-scope",
      config: { apiKeyId: "id", apiPublicValue: "public", apiPassword: "password", baseUrl: "https://demo-rmp-api.rik.ee/v1" },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ invoice_company_name: "Live Company OÜ" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const bootstrap = await createMcpServer({ configs: [config], toolProfile: "guided", connect: false });
    const client = new Client({ name: "company-scope-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: "list_connections", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain("/invoice_info");
    } finally {
      await Promise.allSettled([client.close(), bootstrap.server.close()]);
      vi.unstubAllGlobals();
    }

    const shouldNotFetch = vi.fn().mockRejectedValue(new Error("startup metadata should prevent lookup"));
    vi.stubGlobal("fetch", shouldNotFetch);
    const metadataBootstrap = await createMcpServer({
      configs: [{ ...config, verifiedCompanyName: "Stored Company OÜ" }],
      toolProfile: "guided",
      connect: false,
    });
    const metadataClient = new Client({ name: "company-metadata-test", version: "1" });
    const [metadataClientTransport, metadataServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([metadataBootstrap.server.connect(metadataServerTransport), metadataClient.connect(metadataClientTransport)]);
    try {
      const response = await metadataClient.callTool({ name: "list_connections", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(shouldNotFetch).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([metadataClient.close(), metadataBootstrap.server.close()]);
      vi.unstubAllGlobals();
    }
  });
});
