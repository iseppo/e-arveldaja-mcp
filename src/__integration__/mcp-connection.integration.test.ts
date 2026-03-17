import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RUN_INTEGRATION = process.env.EARVELDAJA_INTEGRATION_TEST === "true";

describe.skipIf(!RUN_INTEGRATION)("MCP Server Integration", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
    client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try { await client.close(); } catch {}
  });

  it("lists 85+ tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(85);
  });

  it("all tools have annotations with title", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.title, `${tool.name} missing title`).toBeTruthy();
      expect(tool.annotations?.openWorldHint, `${tool.name} missing openWorldHint`).toBe(true);
    }
  });

  it("lists 7 prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBe(7);
  });

  it("lists 6 static resources and 6 templates", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBe(6);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.length).toBe(6);
  });

  it("get_vat_info returns data", async () => {
    const result = await client.callTool({ name: "get_vat_info", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as any)[0].text);
    expect(data).toHaveProperty("vat_number");
  });

  it("returns structured error for invalid ID", async () => {
    const result = await client.callTool({ name: "get_client", arguments: { id: 99999999 } });
    expect(result.isError).toBe(true);
  });

  it("compute_trial_balance returns balanced totals", async () => {
    const result = await client.callTool({ name: "compute_trial_balance", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.totals.difference).toBe(0);
  });
});
