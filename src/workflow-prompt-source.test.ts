import { describe, expect, it } from "vitest";
import { buildWorkflowRunData } from "./workflow-prompt-source.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_REGISTRY, promptToolAvailability } from "./prompt-registry.js";
import type { ToolExposureConfig } from "./config.js";
import { PROMPT_SURFACE_LIMIT } from "./prompt-surface.js";
import {
  generatedClaudeCommandText,
  syncWorkflowPromptSurfaces,
  validateWorkflowPromptSurfaces,
} from "../scripts/prompt-surface-files.js";

describe("static workflow availability", () => {
  it.each([
    ["new-supplier", "create_client"],
    ["lightyear-booking", "book_lightyear_trades"],
    ["vat-registration-threshold", "check_vat_registration_threshold"],
  ])("gates unavailable %s before the business flow", (slug, tool) => {
    expect(promptToolAvailability({ toolProfile: "guided" })(tool!)).toBe(false);
    const command = generatedClaudeCommandText(slug!, "BUSINESS FLOW");
    expect(command).toContain(`at least one of these tools is advertised: \`${tool}\``);
    expect(command).toContain("If none is advertised, stop this workflow");
    expect(command).toContain("Never call a missing tool to probe capability");
    expect(command).toContain("profile or feature configuration");
    expect(command.indexOf("Workflow availability")).toBeLessThan(command.indexOf("BUSINESS FLOW"));
  });

  it("uses ANY for workflow availability while preserving ALL/unless for sections", () => {
    const source = "<!-- E_ARVELDAJA_FEATURE_START:test -->\nBUSINESS FLOW\n<!-- E_ARVELDAJA_FEATURE_END:test -->";
    const command = generatedClaudeCommandText("custom", source,
      [{ name: "test", advertisedTools: ["one", "two"], unlessTools: ["three"] }],
      ["one", "two"]);
    expect(command).toContain("at least one of these tools is advertised: `one`, `two`");
    expect(command).toContain("every named tool is advertised: `one`, `two`, and none of these is advertised: `three`");
    expect(generatedClaudeCommandText("custom", "body", [], [])).not.toContain("Workflow availability");
    // An explicit empty requirement overrides the canonical registry's tools.
    expect(generatedClaudeCommandText("new-supplier", "body", [], [])).not.toContain("Workflow availability");
  });

  it("covers feature-disabled custom surfaces as well as guided profiles", () => {
    const toolExposure: ToolExposureConfig = {
      enableLightyear: false, exposeGranularTools: false, exposeSetupTools: false,
      enableTaxTools: false, enableReferenceAdmin: false, enableAnnualReport: false,
      enableSales: false, enableProducts: false,
    };
    const hasTool = promptToolAvailability({ toolProfile: "custom", toolExposure });
    for (const slug of ["lightyear-booking", "vat-registration-threshold"]) {
      const definition = PROMPT_REGISTRY.find(entry => entry.slug === slug)!;
      expect(definition.requiredTools.some(hasTool)).toBe(false);
      expect(generatedClaudeCommandText(slug, "body")).toContain("If none is advertised, stop this workflow");
    }
  });

  it("threads injected registry requirements through synchronization and validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt-availability-"));
    const registry = [{ name: "new-supplier", slug: "new-supplier", requiredTools: ["custom_only"] }];
    try {
      await mkdir(join(root, "workflows"));
      await writeFile(join(root, "workflows/new-supplier.md"), "BUSINESS FLOW");
      await writeFile(join(root, "README.md"), "## Workflows (MCP Prompts)\nThe server includes 1 built-in workflow prompts\n| `new-supplier` | Description |\n");
      await syncWorkflowPromptSurfaces(root, registry);
      const command = await readFile(join(root, ".claude/commands/new-supplier.md"), "utf8");
      expect(command).toContain("at least one of these tools is advertised: `custom_only`");
      expect(command).not.toContain("`create_client`");
      expect(await validateWorkflowPromptSurfaces(root, registry)).toEqual([]);
      expect(await validateWorkflowPromptSurfaces(root, [{ ...registry[0]!, requiredTools: ["different"] }]))
        .toContain(".claude/commands/new-supplier.md must be regenerated from workflows/new-supplier.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every static command within its surface budget", async () => {
    for (const definition of PROMPT_REGISTRY) {
      const source = await readFile(new URL(`../workflows/${definition.slug}.md`, import.meta.url), "utf8");
      expect(generatedClaudeCommandText(definition.slug, source).length).toBeLessThanOrEqual(PROMPT_SURFACE_LIMIT);
    }
  });
});

describe("buildWorkflowRunData month derivation", () => {
  it("derives the month's real last day, leap-year aware", () => {
    expect(buildWorkflowRunData({ month: "2024-02" }).derived).toEqual({
      date_from: "2024-02-01",
      date_to: "2024-02-29",
      fiscal_year_date_from: "2024-01-01",
    });
    expect(buildWorkflowRunData({ month: "2026-02" }).derived.date_to).toBe("2026-02-28");
  });

  it("keeps years 0000-0099 in their own century", () => {
    expect(buildWorkflowRunData({ month: "0050-02" }).derived.date_to).toBe("0050-02-28");
    expect(buildWorkflowRunData({ month: "0048-02" }).derived.date_to).toBe("0048-02-29");
  });

  it("derives nothing for a non-existent month", () => {
    expect(buildWorkflowRunData({ month: "2026-13" }).derived).toEqual({});
    expect(buildWorkflowRunData({ month: "2026-00" }).derived).toEqual({});
  });
});
