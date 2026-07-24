import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  captureToolSurface,
  TOOL_SURFACE_PROFILES,
  type ToolSurfaceProfileName,
} from "./__fixtures__/tool-surface.js";

const fixtureUrl = (profile: ToolSurfaceProfileName): URL =>
  new URL(`../testdata/tool-surface/${profile}.json`, import.meta.url);

describe("MCP tool-surface contract", () => {
  for (const profile of TOOL_SURFACE_PROFILES) {
    it(`pins the normalized ${profile} exposure`, async () => {
      const expected = JSON.parse(await readFile(fixtureUrl(profile), "utf8"));
      const first = await captureToolSurface(profile);
      const second = await captureToolSurface(profile);

      expect(first).toEqual(second);
      expect(new Set(first.tools.map((tool) => tool.name)).size).toBe(first.tools.length);
      expect(first).toEqual(expected);
    });
  }

  it("keeps opt-in profile budgets and PR0 standard/full compatibility", async () => {
    const [guided, guidedSales, standard, currentDefault, full] = await Promise.all([
      captureToolSurface("guided"), captureToolSurface("guided-sales"), captureToolSurface("standard"),
      captureToolSurface("default"), captureToolSurface("full"),
    ]);
    // Guided is sized for routing clarity, not token cost. The design TARGET is
    // <=20; 21-24 is a deliberate recorded-exception band and 24 is the hard
    // backstop above which the surface must be redesigned by merging, not grown.
    // This guard enforces the backstop; the target and add/don't-add criteria
    // live in docs/guided-tool-policy.md. (Today both are 19/20, well under.)
    expect(guided.tools.length).toBeLessThanOrEqual(24);
    expect(guidedSales.tools.length).toBeLessThanOrEqual(24);
    const directDestructiveCrud = /^(?:delete|confirm|invalidate)_(?:client|product|journal|transaction|sale_invoice|purchase_invoice)$/;
    expect(guided.tools.map(({ name }) => name).filter((name) => directDestructiveCrud.test(name))).toEqual([]);
    expect(guidedSales.tools.map(({ name }) => name).filter((name) => directDestructiveCrud.test(name))).toEqual([]);
    expect(standard.tools).toEqual(currentDefault.tools);
    expect(new Set(full.tools.map(({ name }) => name)).size).toBe(full.tools.length);
  });

  it("captures registrations by invoking the production bootstrap rather than recreating it", async () => {
    const bootstrapSource = await readFile(new URL("./server-bootstrap.ts", import.meta.url), "utf8");
    const fixtureSource = await readFile(new URL("./__fixtures__/tool-surface.ts", import.meta.url), "utf8");

    expect(bootstrapSource).toContain("export async function createMcpServer");
    expect(fixtureSource).not.toMatch(/\bregister(?:Core|Crud|AccountBalance|PdfWorkflow)Tools\s*\(/);
  });

  it("keeps index.ts as an unconditional production entrypoint", async () => {
    const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(indexSource).toContain("installStderrTee();");
    expect(indexSource).toContain("createMcpServer().catch");
    expect(indexSource).not.toContain("isDirectExecution");
  });
});
