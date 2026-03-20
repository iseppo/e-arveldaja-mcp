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
      expect(tool.title, `${tool.name} missing title`).toBeTruthy();
      expect(typeof tool.annotations?.openWorldHint, `${tool.name} missing openWorldHint`).toBe("boolean");
    }
  });

  it("lists 6 prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBe(6);
    for (const prompt of prompts) {
      expect(prompt.title, `${prompt.name} missing title`).toBeTruthy();
    }
  });

  it("lists 6 static resources and 6 templates", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBe(6);
    for (const resource of resources) {
      expect(resource.title, `${resource.name} missing title`).toBeTruthy();
    }
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.length).toBe(6);
    for (const resourceTemplate of resourceTemplates) {
      expect(resourceTemplate.title, `${resourceTemplate.name} missing title`).toBeTruthy();
    }
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

  it("exposes core tool names", async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "list_connections",
      "switch_connection",
      "get_vat_info",
      "create_purchase_invoice",
      "compute_trial_balance",
      "extract_pdf_invoice",
      "reconcile_transactions",
    ]));
  });

  it("switch_connection rejects invalid index without changing active connection", async () => {
    const before = await client.callTool({ name: "list_connections", arguments: {} });
    const beforeData = JSON.parse((before.content as any)[0].text);

    const result = await client.callTool({ name: "switch_connection", arguments: { index: -1 } });
    const resultData = JSON.parse((result.content as any)[0].text);

    const after = await client.callTool({ name: "list_connections", arguments: {} });
    const afterData = JSON.parse((after.content as any)[0].text);

    expect(result.isError).toBe(true);
    expect(resultData.error).toMatch(/Invalid index/);
    expect(afterData.active).toBe(beforeData.active);
  });
});
