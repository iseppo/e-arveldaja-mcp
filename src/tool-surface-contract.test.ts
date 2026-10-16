import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  captureToolSurface,
  TOOL_SURFACE_PROFILES,
  type ToolSurfaceProfileName,
  type ToolSurfaceSnapshot,
} from "./__fixtures__/tool-surface.js";
import { isGranularTool, TOOL_CATALOG } from "./tool-catalog.js";
import { isGuidedProfile, projectActionForProfile, remapHiddenGranularTool } from "./tool-profile.js";

const fixtureUrl = (profile: ToolSurfaceProfileName): URL =>
  new URL(`../testdata/tool-surface/${profile}.json`, import.meta.url);

describe("MCP tool-surface contract", () => {
  const snapshots = new Map<ToolSurfaceProfileName, ToolSurfaceSnapshot>();

  beforeAll(async () => {
    const captured = await Promise.all(TOOL_SURFACE_PROFILES.map((profile) => captureToolSurface(profile)));
    for (const snapshot of captured) snapshots.set(snapshot.profile, snapshot);
  });

  for (const profile of TOOL_SURFACE_PROFILES) {
    it(`pins the normalized ${profile} exposure`, async () => {
      const expected = JSON.parse(await readFile(fixtureUrl(profile), "utf8"));
      const snapshot = snapshots.get(profile)!;

      expect(new Set(snapshot.tools.map((tool) => tool.name)).size).toBe(snapshot.tools.length);
      expect(snapshot).toEqual(expected);
    });
  }

  it.each(TOOL_SURFACE_PROFILES)("captures a deterministic %s surface across repeated bootstraps", async (profile) => {
    expect(await captureToolSurface(profile)).toEqual(snapshots.get(profile));
  });

  it("lists every granular constituent only when granular tools are exposed", () => {
    const granular = TOOL_CATALOG.filter((entry) => entry.granular_of).map((entry) => entry.name);
    expect(granular.every(isGranularTool)).toBe(true);
    expect(TOOL_CATALOG.filter((entry) => isGranularTool(entry.name)).map((entry) => entry.name)).toEqual(granular);
    expect(isGranularTool("toString")).toBe(false);
    const listed = (profile: ToolSurfaceProfileName) => new Set(snapshots.get(profile)!.tools.map((tool) => tool.name));
    expect(granular.filter((name) => listed("standard").has(name))).toEqual([]);
    expect(granular.filter((name) => !listed("full").has(name))).toEqual([]);
  });

  // Tool inputs are strict: a remapped call carrying a key the destination
  // tool does not declare is refused. For every profile, feed each source tool
  // every argument it accepts (plus each execute/execution_mode variant),
  // project it the way that profile does, and check the result only uses keys
  // the destination advertises in THAT profile's surface.
  it("projects every tool call only to arguments the destination declares in that profile", () => {
    const propsOf = (snapshot: ToolSurfaceSnapshot) => new Map(snapshot.tools.map((tool) => [
      tool.name,
      new Set(Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})),
    ]));
    const sources = propsOf(snapshots.get("full")!);
    const variants = [{}, { execute: true }, { execute: false }, { execution_mode: "create" }, { execution_mode: "create_and_confirm" }];
    const problems: string[] = [];
    const remappedPerProfile = new Map<ToolSurfaceProfileName, number>();
    for (const profile of TOOL_SURFACE_PROFILES) {
      const allowed = propsOf(snapshots.get(profile)!);
      const toolProfile = profile === "setup" ? "standard" : profile;
      for (const [source, sourceProps] of sources) {
        for (const variant of variants) {
          if (Object.keys(variant).some((key) => !sourceProps.has(key))) continue;
          const args = { ...Object.fromEntries([...sourceProps].map((key) => [key, "x"])), ...variant };
          // Standard-style surfaces hide granular tools and remap them; guided
          // profiles run the full projection chain (granular → bank façade →
          // inter-account).
          const granularHidden = !allowed.has(source);
          const projected = isGuidedProfile(toolProfile)
            ? projectActionForProfile({ tool: source, args }, toolProfile)
            : granularHidden ? remapHiddenGranularTool(source, args) : undefined;
          if (!projected || projected.status === "needs_review" || projected.tool === source) continue;
          remappedPerProfile.set(profile, (remappedPerProfile.get(profile) ?? 0) + 1);
          const destination = allowed.get(projected.tool);
          if (!destination) { problems.push(`${profile}: ${source} -> ${projected.tool}: destination not listed`); continue; }
          for (const key of Object.keys(projected.args ?? {})) {
            if (!destination.has(key)) problems.push(`${profile}: ${source} -> ${projected.tool}: undeclared "${key}"`);
          }
        }
      }
    }
    for (const profile of ["standard", "guided", "guided-sales"] as const) expect(remappedPerProfile.get(profile) ?? 0).toBeGreaterThan(0);
    expect([...new Set(problems)]).toEqual([]);
  });

  it("keeps opt-in profile budgets", () => {
    const guided = snapshots.get("guided")!;
    const guidedSales = snapshots.get("guided-sales")!;
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
  });

  it("captures registrations by invoking the production bootstrap rather than recreating it", async () => {
    // The bootstrap was decomposed: createMcpServer now lives in the
    // src/server/create-server.ts orchestrator (server-bootstrap.ts is a thin
    // re-export barrel). This still pins that the production entrypoint exists
    // and that the fixture invokes it rather than re-declaring registrations.
    const bootstrapSource = await readFile(new URL("./server/create-server.ts", import.meta.url), "utf8");
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
