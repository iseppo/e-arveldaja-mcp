import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetOpeningBalanceCache, readOpeningBalances } from "../opening-balance-store.js";
import { parseMcpResponse } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import { registerOpeningBalanceTools } from "./opening-balance-import.js";

// ---------------------------------------------------------------------------
// McpServer mock — captures registered tool callbacks by name (same pattern
// as src/tools/estonian-tax.test.ts / src/tools/account-balance.test.ts).
// ---------------------------------------------------------------------------

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;

function makeMockServer() {
  const tools = new Map<string, ToolCallback>();
  const configs = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
  const server = {
    registerTool: vi.fn((name: string, config: unknown, callback: ToolCallback) => {
      configs.set(name, config as { description?: string; inputSchema?: Record<string, unknown> });
      tools.set(name, callback);
    }),
  };
  return { server: server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, tools, configs };
}

function resultText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  return r.content[0].text;
}

async function callTool(
  tools: Map<string, ToolCallback>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = tools.get(name);
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  const result = await handler(args);
  return resultText(result);
}

const SAMPLE = [
  "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
  "1.\t12.12.2024\t1020 Pank\t1 000.00 €\t",
  "\t\t2900 Kapital\t\t1 000.00 €",
].join("\n");

let dir: string;
let tools: Map<string, ToolCallback>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ob-tool-"));
  process.env.EARVELDAJA_RULES_DIR = dir;
  resetOpeningBalanceCache();
  const mock = makeMockServer();
  tools = mock.tools;
  registerOpeningBalanceTools(mock.server, {} as ApiContext);
});

afterEach(() => {
  delete process.env.EARVELDAJA_RULES_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("import_opening_balances", () => {
  it("dry_run previews without writing", async () => {
    const res = await callTool(tools, "import_opening_balances", { pasted_text: SAMPLE });
    expect(res).toMatch(/1020/);
    expect(res).toMatch(/balanced/i);
    expect(existsSync(join(dir, "opening-balances.json"))).toBe(false);
    expect(readOpeningBalances()).toBeNull();
    const parsed = parseMcpResponse(res) as Record<string, unknown>;
    expect(parsed.persisted).toBe(false);
  });

  it("persists when dry_run=false", async () => {
    await callTool(tools, "import_opening_balances", { pasted_text: SAMPLE, dry_run: false });
    resetOpeningBalanceCache();
    expect(readOpeningBalances()?.openingDate).toBe("2024-12-12");
  });

  it("wraps the echoed paste in the untrusted-text sandbox", async () => {
    const res = await callTool(tools, "import_opening_balances", { pasted_text: SAMPLE });
    expect(res).toMatch(/UNTRUSTED_OCR_START/);
  });

  it("returns the balance error without writing on an unbalanced paste", async () => {
    const bad = "Nr\tKuupäev\tKonto\tDeebet\tKreedit\n1.\t12.12.2024\t1020 Pank\t1 000.00 €\t\n\t\t2900 Kapital\t\t900.00 €";
    const res = await callTool(tools, "import_opening_balances", { pasted_text: bad });
    expect(res).toMatch(/does not balance/i);
    expect(existsSync(join(dir, "opening-balances.json"))).toBe(false);
  });

  it("explicit dry_run:true previews and does not write", async () => {
    const res = await callTool(tools, "import_opening_balances", { pasted_text: SAMPLE, dry_run: true });
    const parsed = parseMcpResponse(res) as Record<string, unknown>;
    expect(parsed.persisted).toBe(false);
    expect(existsSync(join(dir, "opening-balances.json"))).toBe(false);
  });

  it("does not sandbox account code/debit/credit in the dry-run preview (only name is wrapped)", async () => {
    const res = await callTool(tools, "import_opening_balances", { pasted_text: SAMPLE });
    const parsed = parseMcpResponse(res) as {
      accounts: Array<{ code: string; name: string; debit: number; credit: number }>;
    };
    const acc = parsed.accounts[0]!;
    expect(acc.name).toMatch(/UNTRUSTED_OCR_START/);
    expect(acc.code).toBe("1020");
    expect(String(acc.code)).not.toMatch(/UNTRUSTED_OCR/);
    expect(String(acc.debit)).not.toMatch(/UNTRUSTED_OCR/);
    expect(String(acc.credit)).not.toMatch(/UNTRUSTED_OCR/);
  });

  it("returns ok:false without throwing when persisting fails in single-file EARVELDAJA_RULES_FILE mode", async () => {
    const fileDir = mkdtempSync(join(tmpdir(), "ob-tool-file-"));
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(fileDir, "accounting-rules.md");
    resetOpeningBalanceCache();
    try {
      const res = await callTool(tools, "import_opening_balances", { pasted_text: SAMPLE, dry_run: false });
      const parsed = parseMcpResponse(res) as Record<string, unknown>;
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toMatch(/bundle storage|EARVELDAJA_RULES_DIR/i);
    } finally {
      delete process.env.EARVELDAJA_RULES_FILE;
      process.env.EARVELDAJA_RULES_DIR = dir;
      resetOpeningBalanceCache();
      rmSync(fileDir, { recursive: true, force: true });
    }
  });
});
