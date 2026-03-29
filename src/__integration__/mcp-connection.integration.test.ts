import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initAuditLog, logAudit, setAuditLogLabel } from "../audit-log.js";
import { parseMcpResponse } from "../mcp-json.js";

const RUN_LIVE_INTEGRATION = process.env.EARVELDAJA_INTEGRATION_TEST === "true";
const DIST_ENTRYPOINT = join(process.cwd(), "dist", "index.js");
const TEST_AUDIT_CONNECTION = "integration-session-log-test";
const TEST_AUDIT_LOG_PATH = join(process.cwd(), "logs", `${TEST_AUDIT_CONNECTION}.audit.md`);
const TEST_AUDIT_LABEL = "Integration Session Label";
const TEST_AUDIT_LABEL_PATH = join(process.cwd(), "logs", `${TEST_AUDIT_LABEL}.audit.md`);
const TEST_AUDIT_LABELS_PATH = join(process.cwd(), "logs", ".audit-labels.json");

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

function createTransport(options?: { env?: Record<string, string>; cwd?: string }): StdioClientTransport {
  return new StdioClientTransport({
    command: "node",
    args: [DIST_ENTRYPOINT],
    cwd: options?.cwd ?? process.cwd(),
    env: options?.env ?? buildTransportEnv(),
  });
}

async function seedAuditLog(entries: Array<{ timestamp: string; entityId: number; summary: string }>): Promise<void> {
  initAuditLog(() => TEST_AUDIT_CONNECTION);
  vi.useFakeTimers();
  try {
    for (const entry of entries) {
      vi.setSystemTime(new Date(entry.timestamp));
      logAudit({
        tool: "create_purchase_invoice",
        action: "CREATED",
        entity_type: "purchase_invoice",
        entity_id: entry.entityId,
        summary: entry.summary,
        details: {},
      });
    }
  } finally {
    vi.useRealTimers();
  }
}

describe("MCP Server Integration", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = createTransport({
      env: buildTransportEnv({
        EARVELDAJA_API_KEY_ID: "integration-test-key-id",
        EARVELDAJA_API_PUBLIC_VALUE: "integration-test-public-value",
        EARVELDAJA_API_PASSWORD: "integration-test-password",
        EARVELDAJA_SERVER: "demo",
      }),
    });
    client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try { await client.close(); } catch {}
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(TEST_AUDIT_LOG_PATH, { force: true });
    await rm(TEST_AUDIT_LABEL_PATH, { force: true });
    await rm(TEST_AUDIT_LABELS_PATH, { force: true });
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

  it("get_session_log applies ISO date filters end-to-end", async () => {
    await seedAuditLog([
      { timestamp: "2026-03-25T22:30:00Z", entityId: 101, summary: "Included entry" },
      { timestamp: "2026-03-25T23:30:00Z", entityId: 102, summary: "Excluded entry" },
    ]);

    const result = await client.callTool({
      name: "get_session_log",
      arguments: {
        connection: TEST_AUDIT_CONNECTION,
        date_from: "2026-03-25T22:00:00",
        date_to: "2026-03-25T23:00:00",
      },
    });

    const text = (result.content as any)[0].text as string;

    expect(result.isError).toBeFalsy();
    expect(text).toContain("2026-03-25 22:30:00");
    expect(text).not.toContain("2026-03-25 23:30:00");
    expect(text).toContain("#101");
    expect(text).not.toContain("#102");
  });

  it("get_session_log reads by audit-log label and explicit raw connection selector", async () => {
    await seedAuditLog([
      { timestamp: "2026-03-26T10:00:00Z", entityId: 103, summary: "Label-selected entry" },
    ]);
    setAuditLogLabel(TEST_AUDIT_CONNECTION, TEST_AUDIT_LABEL);

    const byLabel = await client.callTool({
      name: "get_session_log",
      arguments: {
        connection: TEST_AUDIT_LABEL,
      },
    });
    const byRawConnection = await client.callTool({
      name: "get_session_log",
      arguments: {
        connection: `connection:${TEST_AUDIT_CONNECTION}`,
      },
    });

    const byLabelText = (byLabel.content as any)[0].text as string;
    const byRawConnectionText = (byRawConnection.content as any)[0].text as string;

    expect(byLabel.isError).toBeFalsy();
    expect(byRawConnection.isError).toBeFalsy();
    expect(byLabelText).toContain("#103");
    expect(byRawConnectionText).toContain("#103");
  });

  it("reports configured-mode setup guidance when credentials are present", async () => {
    const result = await client.callTool({ name: "get_setup_instructions", arguments: {} });
    const data = parseMcpResponse((result.content as any)[0].text);

    expect(result.isError).toBeFalsy();
    expect(data.mode).toBe("configured");
    expect(data.message).toContain("API credentials are configured");
    expect(data.credential_file_env_var).toBe("EARVELDAJA_API_KEY_FILE");
  });
});

describe("MCP Server Setup Mode", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "earveldaja-mcp-setup-"));
    transport = createTransport({
      cwd: tempDir,
      env: buildTransportEnv({
        EARVELDAJA_API_KEY_ID: "",
        EARVELDAJA_API_PUBLIC_VALUE: "",
        EARVELDAJA_API_PASSWORD: "",
        EARVELDAJA_API_KEY_FILE: "",
      }),
    });
    client = new Client({ name: "setup-mode-test", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try { await client.close(); } catch {}
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps prompts and resources listed in setup mode", async () => {
    const { prompts } = await client.listPrompts();
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    const { tools } = await client.listTools();

    expect(prompts.map(prompt => prompt.name)).toEqual(expect.arrayContaining([
      "setup-e-arveldaja",
      "book-invoice",
      "receipt-batch",
    ]));
    expect(resources.map(resource => resource.name)).toEqual(expect.arrayContaining([
      "accounts",
      "vat_info",
      "invoice_info",
    ]));
    expect(resourceTemplates.map(resource => resource.name)).toEqual(expect.arrayContaining([
      "client",
      "purchase_invoice",
      "transaction",
    ]));
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "get_setup_instructions",
      "import_apikey_credentials",
      "list_connections",
      "get_vat_info",
      "validate_invoice_data",
    ]));
  });

  it("reports zero connections and working-directory setup guidance", async () => {
    const result = await client.callTool({ name: "list_connections", arguments: {} });
    const data = parseMcpResponse((result.content as any)[0].text);

    expect(result.isError).toBeFalsy();
    expect(data.connections).toEqual([]);
    expect(data.active).toBeUndefined();
    expect(data.total).toBe(0);
    expect(data.setup_required).toBe(true);
    expect(data.working_directory).toBe(tempDir);
    expect(data.hint).toContain("get_setup_instructions");
  });

  it("returns structured setup guidance and blocks API tools consistently", async () => {
    const setup = await client.callTool({ name: "get_setup_instructions", arguments: {} });
    const setupData = parseMcpResponse((setup.content as any)[0].text);

    expect(setup.isError).toBeFalsy();
    expect(setupData.mode).toBe("setup");
    expect(setupData.working_directory).toBe(tempDir);
    expect(setupData.credential_file_pattern).toBe("apikey*.txt");
    expect(setupData.credential_file_env_var).toBe("EARVELDAJA_API_KEY_FILE");
    expect(setupData.env_vars).toEqual(expect.arrayContaining([
      "EARVELDAJA_API_KEY_ID",
      "EARVELDAJA_API_PUBLIC_VALUE",
      "EARVELDAJA_API_PASSWORD",
    ]));

    const blocked = await client.callTool({ name: "get_vat_info", arguments: {} });
    const blockedData = parseMcpResponse((blocked.content as any)[0].text);

    expect(blocked.isError).toBe(true);
    expect(blockedData.error).toContain("setup mode");
    expect(blockedData.hint).toContain("get_setup_instructions");
    expect(blockedData.blocked_tool).toBe("get_vat_info");
    expect(blockedData.blocked_api_method).toBe("readonly.getVatInfo");
    expect(blockedData.working_directory).toBe(tempDir);
  });

  it("falls back cleanly when interactive credential prompting is unavailable", async () => {
    const apiKeyFile = join(tempDir, "apikey.txt");
    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"), { mode: 0o600 });
    chmodSync(apiKeyFile, 0o600);

    const result = await client.callTool({ name: "import_apikey_credentials", arguments: {} });
    const data = parseMcpResponse((result.content as any)[0].text);

    expect(result.isError).toBe(true);
    expect(data.error).toContain("Client does not support interactive setup prompting");
    expect(data.error).toContain("storage_scope");
  });

  it("returns setup guidance when reading API resources in setup mode", async () => {
    const result = await client.readResource({ uri: "earveldaja://accounts" });
    const data = parseMcpResponse((result.contents as any)[0].text);

    expect(data.mode).toBe("setup");
    expect(data.error).toContain("setup mode");
    expect(data.blocked_resource).toBe("earveldaja://accounts");
    expect(data.blocked_api_method).toBe("readonly.getAccounts");
    expect(data.working_directory).toBe(tempDir);
  });

  it("still allows local offline tools in setup mode", async () => {
    const result = await client.callTool({
      name: "validate_invoice_data",
      arguments: {
        total_net: 100,
        total_vat: 22,
        total_gross: 122,
        items: JSON.stringify([{ total_net_price: 100, vat_rate_dropdown: "22" }]),
        invoice_date: "2026-03-26",
        due_date: "2026-03-26",
      },
    });
    const data = parseMcpResponse((result.content as any)[0].text);

    expect(result.isError).toBeFalsy();
    expect(data.valid).toBe(true);
  });
});

describe("MCP Server Startup Credential Import", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let tempDir: string;
  let globalDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "earveldaja-mcp-startup-import-"));
    globalDir = join(tempDir, "global");
    mkdirSync(globalDir, { recursive: true });

    const apiKeyFile = join(tempDir, "apikey.txt");
    writeFileSync(apiKeyFile, [
      "ApiKey ID: startup-key-id",
      "ApiKey public value: startup-public-value",
      "Password: startup-secret-password",
      "",
    ].join("\n"), { mode: 0o600 });
    chmodSync(apiKeyFile, 0o600);

    transport = createTransport({
      cwd: tempDir,
      env: buildTransportEnv({
        EARVELDAJA_API_KEY_ID: "",
        EARVELDAJA_API_PUBLIC_VALUE: "",
        EARVELDAJA_API_PASSWORD: "",
        EARVELDAJA_API_KEY_FILE: "",
        EARVELDAJA_CONFIG_DIR: globalDir,
      }),
    });
    client = new Client({ name: "startup-import-test", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    try { await client.close(); } catch {}
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps serving when startup prompting is unsupported and leaves the global env untouched", async () => {
    const result = await client.callTool({ name: "list_connections", arguments: {} });
    const data = parseMcpResponse((result.content as any)[0].text);

    expect(result.isError).toBeFalsy();
    expect(data.total).toBe(1);
    expect(data.connections[0].name).toBe("apikey");
    expect(existsSync(join(globalDir, ".env"))).toBe(false);
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
