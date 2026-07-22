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
