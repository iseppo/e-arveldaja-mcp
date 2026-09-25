import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NamedConfig, ToolExposureConfig } from "./config.js";
import { createMcpServer } from "./server-bootstrap.js";
import { TOOL_CATALOG } from "./tool-catalog.js";
import type { ToolProfile } from "./tool-profile.js";
import { promptToolAvailability, PROMPT_REGISTRY } from "./prompt-registry.js";
import { TOOL_SURFACE_SETUP_INFO } from "./__fixtures__/tool-surface.js";
import { MAXIMUM_VALID_PROMPT_ARGUMENTS } from "../scripts/prompt-surface-files.js";

const DEFAULT_EXPOSURE: ToolExposureConfig = Object.freeze({
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
});

const LEAN_EXPOSURE: ToolExposureConfig = Object.freeze({
  enableLightyear: false,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: false,
  enableReferenceAdmin: false,
  enableAnnualReport: false,
  enableSales: false,
  enableProducts: false,
});

const CONNECTION: NamedConfig = Object.freeze({
  name: "prompt-surface-fixture",
  config: Object.freeze({
    apiKeyId: "fixture-key-id",
    apiPublicValue: "fixture-public-value",
    apiPassword: "fixture-password",
    baseUrl: "https://demo-rmp-api.rik.ee/v1",
  }),
});

interface Surface {
  name: string;
  toolProfile: ToolProfile;
  exposure: ToolExposureConfig;
  setupMode: boolean;
}

const SURFACES: readonly Surface[] = [
  { name: "standard", toolProfile: "standard", exposure: DEFAULT_EXPOSURE, setupMode: false },
  { name: "guided", toolProfile: "guided", exposure: DEFAULT_EXPOSURE, setupMode: false },
  { name: "guided-sales", toolProfile: "guided-sales", exposure: DEFAULT_EXPOSURE, setupMode: false },
  { name: "full", toolProfile: "full", exposure: { ...DEFAULT_EXPOSURE, exposeGranularTools: true, exposeSetupTools: true }, setupMode: false },
  { name: "custom-lean", toolProfile: "custom", exposure: LEAN_EXPOSURE, setupMode: false },
  { name: "custom-granular-setup", toolProfile: "custom", exposure: { ...DEFAULT_EXPOSURE, exposeGranularTools: true, exposeSetupTools: true }, setupMode: false },
  { name: "setup-standard", toolProfile: "standard", exposure: DEFAULT_EXPOSURE, setupMode: true },
  { name: "setup-guided", toolProfile: "guided", exposure: DEFAULT_EXPOSURE, setupMode: true },
];

const CATALOG_NAMES = new Set(TOOL_CATALOG.map(entry => entry.name));
const TOOL_LIKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

const RUN_DATA_ENVELOPE = /<<<E_ARVELDAJA_RUN_DATA:([A-Za-z0-9_-]+)>>>[\s\S]*?<<<END_E_ARVELDAJA_RUN_DATA:\1>>>/g;

/**
 * Catalog tool names mentioned anywhere in the trusted text (backticked or
 * bare). The nonce-delimited run-data envelope is caller/setup DATA, not
 * workflow instructions, so it is excluded.
 */
function mentionedTools(text: string): string[] {
  const trusted = text.replace(RUN_DATA_ENVELOPE, "");
  return [...new Set(trusted.match(TOOL_LIKE) ?? [])].filter(token => CATALOG_NAMES.has(token)).sort();
}

async function openSurface(surface: Surface) {
  const bootstrap = await createMcpServer({
    configs: surface.setupMode ? [] : [CONNECTION],
    setupInfo: TOOL_SURFACE_SETUP_INFO,
    toolExposure: surface.exposure,
    toolProfile: surface.toolProfile,
    connect: false,
  });
  const client = new Client({ name: "prompt-surface-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = new Set((await client.listTools()).tools.map(tool => tool.name));
  const prompts = (await client.listPrompts()).prompts.map(prompt => prompt.name);
  const promptTexts = new Map<string, string>();
  for (const name of prompts) {
    const args = MAXIMUM_VALID_PROMPT_ARGUMENTS[name as keyof typeof MAXIMUM_VALID_PROMPT_ARGUMENTS] ?? {};
    const result = await client.getPrompt({ name, arguments: { ...args } });
    promptTexts.set(name, result.messages.map(message => (message.content as { text: string }).text).join("\n"));
  }
  await client.close();
  return { tools, prompts, promptTexts, instructions: bootstrap.instructions };
}

describe.each(SURFACES.map(surface => [surface.name, surface] as const))("%s tool surface", (_name, surface) => {
  it("derives the exact registered tool set for prompts and instructions", async () => {
    const { tools } = await openSurface(surface);
    const hasTool = promptToolAvailability({
      toolProfile: surface.toolProfile,
      toolExposure: surface.exposure,
      setupMode: surface.setupMode,
    });
    const derived = TOOL_CATALOG.map(entry => entry.name).filter(hasTool).sort();
    expect(derived).toEqual([...tools].sort());
  });

  it("every rendered prompt and the server instructions name only registered tools", async () => {
    const { tools, promptTexts, instructions } = await openSurface(surface);
    expect(mentionedTools(instructions).filter(tool => !tools.has(tool)), "server instructions").toEqual([]);
    expect(Buffer.byteLength(instructions, "utf8"), "server instructions size").toBeLessThan(1536);
    expect(promptTexts.size).toBeGreaterThan(0);
    for (const [name, text] of promptTexts) {
      expect(mentionedTools(text).filter(tool => !tools.has(tool)), `${name} names unregistered tools`).toEqual([]);
    }
  });

  it("registers exactly the prompts that have at least one required tool", async () => {
    const { tools, prompts } = await openSurface(surface);
    const expected = PROMPT_REGISTRY
      .filter(definition => definition.featurePredicate(surface.exposure))
      .filter(definition => definition.requiredTools.length === 0 || definition.requiredTools.some(tool => tools.has(tool)))
      .map(definition => definition.name);
    expect(prompts).toEqual(expected);
  });
});

describe("profile-specific prompt content", () => {
  it("hides workflows whose tools the guided profile does not expose", async () => {
    const { prompts } = await openSurface(SURFACES.find(surface => surface.name === "guided")!);
    expect(prompts).not.toContain("lightyear-booking");
    expect(prompts).not.toContain("new-supplier");
    expect(prompts).not.toContain("vat-registration-threshold");
    expect(prompts).toContain("book-invoice");
    expect(prompts).toContain("import-camt");
  });

  it("renders the guided façade flow on guided and the granular flow on standard", async () => {
    const guided = await openSurface(SURFACES.find(surface => surface.name === "guided")!);
    const standard = await openSurface(SURFACES.find(surface => surface.name === "standard")!);

    expect(guided.promptTexts.get("import-camt")).toContain('`process_bank_input` with `mode: "prepare"`');
    expect(standard.promptTexts.get("import-camt")).toContain('`process_camt053` with `mode: "dry_run"`');
    expect(standard.promptTexts.get("import-wise")).toContain("`execute: true`");

    const guidedInvoice = guided.promptTexts.get("book-invoice")!;
    expect(guidedInvoice).toContain('`mode: "confirm"`');
    expect(guidedInvoice).toContain("`confirm_plan.plan_handle`");
    expect(guidedInvoice.match(/`mode: "prepare"`/g)?.length).toBeGreaterThanOrEqual(2);

    expect(standard.promptTexts.get("month-end-close")).toContain("`month_end_close_checklist`");
    expect(guided.promptTexts.get("month-end-close")).toContain("`run_accounting_report`");
  });

  it("carries the plan handle into every execute step", async () => {
    for (const surface of SURFACES.filter(entry => !entry.setupMode)) {
      const { promptTexts } = await openSurface(surface);
      const receipts = promptTexts.get("receipt-batch");
      if (receipts) expect(receipts, `${surface.name} receipt-batch`).toMatch(/`plan_handle`/);
      const classify = promptTexts.get("classify-unmatched");
      if (classify) {
        expect(classify, `${surface.name} classify-unmatched`).toMatch(/`plan_handle`: the handle from that dry run/);
        expect(classify).toMatch(/BEFORE the dry run/);
      }
      const reconcile = promptTexts.get("reconcile-bank");
      if (reconcile) {
        expect(reconcile, `${surface.name} reconcile-bank`).toContain('`mode: "execute_inter_account"`');
        expect(reconcile).toContain("`linked_invoice_clients_ambiguous`");
      }
    }
  });
});
