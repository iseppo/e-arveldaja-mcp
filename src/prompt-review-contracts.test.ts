import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PROMPT_REGISTRY } from "./prompt-registry.js";
import { buildWorkflowPromptSourceText } from "./workflow-prompt-source.js";
import { MAXIMUM_VALID_PROMPT_ARGUMENTS } from "../scripts/prompt-surface-files.js";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import { registerPlanTools } from "./plan-tools.js";
import { parseMcpResponse } from "./mcp-json.js";
import { desandboxAllStrings } from "./external-text-renderer.js";
import type { ToolProfile } from "./tool-profile.js";
import type { ToolExposureConfig } from "./config.js";

const exposure: ToolExposureConfig = { enableLightyear: true, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true, exposeGranularTools: false, exposeSetupTools: false };
function body(name: string, profile: ToolProfile) {
  const definition = PROMPT_REGISTRY.find(item => item.name === name)!;
  const args = z.object(definition.argsSchema ?? {}).parse(MAXIMUM_VALID_PROMPT_ARGUMENTS[name as keyof typeof MAXIMUM_VALID_PROMPT_ARGUMENTS] ?? {});
  return buildWorkflowPromptSourceText(definition.slug, args, definition.variants, { toolProfile: profile, toolExposure: exposure }).split("Canonical workflow source:")[1]!;
}

describe("workflow full-effect review matches actual paging contracts", () => {
  for (const profile of ["standard", "full", "guided", "guided-sales"] as const) {
    for (const workflow of ["import-camt", "import-wise", "classify-unmatched", "reconcile-bank", "lightyear-booking"]) {
      if (workflow === "lightyear-booking" && profile.startsWith("guided")) continue;
      it(`${workflow}/${profile}: full effects on every cursor are readable before approval`, async () => {
        const text = body(workflow, profile), guided = profile.startsWith("guided");
        expect(text).toContain("get_execution_plan_page");
        expect(text).toContain("next_cursor");
        expect(text).toContain("exclusions");
        expect(text).toContain("reviews");
        if (guided) expect(text).toMatch(/detail"?\s*:\s*"full"/);
        else expect(text).not.toMatch(/detail"?\s*:\s*"full"/);

        const runtime = createTestRuntimeSafetyContext({ scope: { profile } });
        const commands = Array.from({ length: 55 }, (_, i) => ({ id: `command-${i}`, category: "create", reviewProjection: { transaction_id: i + 1, amount: i + 0.25, distribution: [{ account: 1020, direction: "D" }, { account: 1210, direction: "C" }], set_clients_id: i + 100 } }));
        const exclusions = Array.from({ length: 23 }, (_, i) => ({ transaction_id: i, reason: "already booked" }));
        const reviews = Array.from({ length: 27 }, (_, i) => ({ transaction_id: i, reason: "owner decision" }));
        const handle = runtime.planStore.issue("prompt-review", { normalizedArgs: {}, sourceIdentities: [], liveSnapshot: {}, commands, counts: { create: commands.length }, totals: {}, exclusions, reviews, privatePayload: {} });
        const server = { registerTool: vi.fn() };
        registerPlanTools(server as never, runtime, { profile });
        const registration = server.registerTool.mock.calls.find(([name]) => name === "get_execution_plan_page")!;
        const schema = z.object(registration[1].inputSchema).strict(), handler = registration[2] as (args: Record<string, unknown>) => Promise<any>;
        for (const section of ["commands", "exclusions", "reviews"] as const) {
          let cursor: string | undefined; const effects: unknown[] = [];
          do {
            const args = { plan_handle: handle, section, ...(guided ? { detail: "full" } : {}), ...(cursor ? { cursor } : {}) };
            expect(schema.safeParse(args).success).toBe(true);
            const result = await handler(args); expect(result.isError).not.toBe(true);
            const page = desandboxAllStrings(parseMcpResponse(result.content[0].text)) as any;
            const rows = section === "commands" ? page.commands : page.items;
            effects.push(...rows.map((row: any) => JSON.parse(row.review_data)));
            cursor = page.next_cursor ?? undefined;
          } while (cursor);
          expect(effects).toEqual(section === "commands" ? commands.map(c => c.reviewProjection) : section === "exclusions" ? exclusions : reviews);
        }
        // Reading every effect neither consumes the handle nor authorizes a write.
        expect(runtime.planStore.inspect(handle).commands).toHaveLength(55);
      });
    }
  }
});

describe("CAMT and reference instructions follow the public response/API", () => {
  it.each(["standard", "full"] as const)("%s CAMT uses the adapter's nested result", profile => {
    const text = body("import-camt", profile);
    expect(text).toContain("result.plan_handle");
    expect(text).toContain("result.summary.created_count");
    expect(text).toContain("result.execution.execution_report");
    expect(text).not.toContain("top-level `plan_handle`");
  });
  it.each(["guided", "guided-sales"] as const)("%s CAMT retains its compact summary contract", profile => {
    const text = body("import-camt", profile);
    expect(text).toContain("summary.plan_handle");
    expect(text).toContain("summary.counts");
    expect(text).not.toContain("result.plan_handle");
  });
  it.each(["standard", "full"] as const)("%s Wise discloses ignored bank-reference writes", profile => {
    const text = body("import-wise", profile);
    expect(text).toMatch(/bank_ref_number[^\n]*(?:read-only|readOnly)/);
    expect(text).not.toContain("offer `update_transaction` with the corrected reference");
    expect(text).toMatch(/(?:fresh[^\n]*(?:read|GET)|read[^\n]*fresh)/i);
    expect(text).toContain("checksum");
  });
});
