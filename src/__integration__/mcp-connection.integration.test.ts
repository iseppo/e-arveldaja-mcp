import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseMcpResponse } from "../mcp-json.js";

const RUN_LIVE_INTEGRATION = process.env.EARVELDAJA_INTEGRATION_TEST === "true";
const DIST_ENTRYPOINT = "dist/index.js";

function getEarveldajaEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => key.startsWith("EARVELDAJA_"))
  );
}

function buildTransportEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...getEarveldajaEnvironment(),
    ...overrides,
  };
}

function createTransport(env?: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: "node",
    args: [DIST_ENTRYPOINT],
    cwd: process.cwd(),
    env: env ?? buildTransportEnv(),
  });
}

describe("MCP Server Integration", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = createTransport(buildTransportEnv({
      EARVELDAJA_API_KEY_ID: "integration-test-key-id",
      EARVELDAJA_API_PUBLIC_VALUE: "integration-test-public-value",
      EARVELDAJA_API_PASSWORD: "integration-test-password",
      EARVELDAJA_SERVER: "demo",
    }));
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

  it("lists the built-in prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(10);
    expect(prompts.map(prompt => prompt.name)).toEqual(expect.arrayContaining([
      "book-invoice",
      "receipt-batch",
      "import-camt",
      "import-wise",
      "classify-unmatched",
      "reconcile-bank",
      "month-end-close",
      "new-supplier",
      "company-overview",
      "lightyear-booking",
    ]));
    for (const prompt of prompts) {
      expect(prompt.title, `${prompt.name} missing title`).toBeTruthy();
    }
  });

  it("lists static resources and dynamic resource templates", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThanOrEqual(6);
    expect(resources.map(resource => resource.name)).toEqual(expect.arrayContaining([
      "accounts",
      "sale_articles",
      "purchase_articles",
      "templates",
      "vat_info",
      "invoice_info",
    ]));
    for (const resource of resources) {
      expect(resource.title, `${resource.name} missing title`).toBeTruthy();
    }
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.length).toBeGreaterThanOrEqual(6);
    expect(resourceTemplates.map(resourceTemplate => resourceTemplate.name)).toEqual(expect.arrayContaining([
      "client",
      "product",
      "journal",
      "sale_invoice",
      "purchase_invoice",
      "transaction",
    ]));
    for (const resourceTemplate of resourceTemplates) {
      expect(resourceTemplate.title, `${resourceTemplate.name} missing title`).toBeTruthy();
    }
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
    const beforeData = parseMcpResponse((before.content as any)[0].text);

    const result = await client.callTool({ name: "switch_connection", arguments: { index: -1 } });
    const resultData = parseMcpResponse((result.content as any)[0].text);

    const after = await client.callTool({ name: "list_connections", arguments: {} });
    const afterData = parseMcpResponse((after.content as any)[0].text);

    expect(result.isError).toBe(true);
    expect(resultData.error).toMatch(/Invalid index/);
    expect(afterData.active).toBe(beforeData.active);
  });
});

describe.skipIf(!RUN_LIVE_INTEGRATION)("Live API MCP Integration", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = createTransport();
    client = new Client({ name: "integration-test-live", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try { await client.close(); } catch {}
  });

  it("get_vat_info returns data", async () => {
    const result = await client.callTool({ name: "get_vat_info", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = parseMcpResponse((result.content as any)[0].text);
    expect(data).toHaveProperty("vat_number");
  });

  it("returns structured error for invalid ID", async () => {
    const result = await client.callTool({ name: "get_client", arguments: { id: 99999999 } });
    expect(result.isError).toBe(true);
  });

  it("compute_trial_balance returns balanced totals", async () => {
    const result = await client.callTool({ name: "compute_trial_balance", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = parseMcpResponse((result.content as any)[0].text);
    expect(data.totals.difference).toBe(0);
  });
});
