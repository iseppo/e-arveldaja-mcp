import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildResponseFixtures,
  measureResponseFixtures,
  REQUIRED_RESPONSE_FIXTURE_NAMES,
} from "../scripts/measure-response-fixtures.js";
import { mcpSerializedByteLength, parseMcpResponse, toMcpJson } from "./mcp-json.js";
import { assertMcpPayloadWithinHardBudget, RESPONSE_BUDGETS } from "./response-budget.js";
import type { ToolExposureConfig } from "./config.js";
import { buildServerInstructions } from "./server/server-instructions.js";

const INSTRUCTION_TARGET_BYTES = 1536; // 1.5 KiB soft target
const INSTRUCTION_HARD_BYTES = 2048; // 2 KiB hard bound
const CONTEXT_BUDGET_EXPOSURE: ToolExposureConfig = Object.freeze({
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
});

describe("response context-budget baseline", () => {
  it("pins deterministic final encoded bytes without enforcing a target budget", async () => {
    const expected = JSON.parse(await readFile(
      new URL("../testdata/context-budgets.json", import.meta.url),
      "utf8",
    ));

    const first = await measureResponseFixtures();
    const second = await measureResponseFixtures();

    expect(first).toEqual(second);
    expect(first).toEqual(expected);
  });

  it("covers every required representative response and round-trips losslessly", async () => {
    const fixtures = await buildResponseFixtures();
    expect(fixtures.map((fixture) => fixture.name)).toEqual(REQUIRED_RESPONSE_FIXTURE_NAMES);
    for (const fixture of fixtures) {
      expect(parseMcpResponse(fixture.encoded)).toEqual(fixture.payload);
    }
  });

  it("keeps a guided workflow continuation's arguments under the compact byte bounds", () => {
    // The arguments a guided client sends back to continue_accounting_workflow
    // via a workflow_action_v2 next_action: an opaque handle plus a bounded,
    // human-scale answer — never a re-serialized prior workflow envelope.
    const CONTINUATION_TARGET_BYTES = 512;
    const CONTINUATION_HARD_BYTES = 1024;
    const args = {
      workflow_handle: "A".repeat(43),
      action: "next",
      item_id: "review-0007",
      answer: "Use the LHV EUR bank account dimension for this fee posting.",
    };
    const bytes = Buffer.byteLength(toMcpJson(args), "utf8");
    expect(bytes).toBeLessThan(CONTINUATION_TARGET_BYTES);
    expect(bytes).toBeLessThanOrEqual(CONTINUATION_HARD_BYTES);

    // Structural guarantee: the WORST-CASE continuation — every field at its
    // schema-max length (workflow_handle 43, action "prepare_action", item_id
    // 128, answer 700) — must still fit the 1 KiB hard bound. This is what caps
    // `answer` at 700 in continue_accounting_workflow's input schema.
    const worstCase = {
      workflow_handle: "A".repeat(43),
      action: "prepare_action",
      item_id: "x".repeat(128),
      answer: "x".repeat(700),
    };
    expect(Buffer.byteLength(toMcpJson(worstCase), "utf8")).toBeLessThanOrEqual(CONTINUATION_HARD_BYTES);
  });

  it("keeps the fixed per-session server-instruction string within the context budget", () => {
    // The configured (non-setup) instruction string is loaded on every session,
    // so it is a fixed per-session context cost. Task 16 trimmed it under 1.5 KiB
    // by moving detailed guidance into the owning workflow prompts and binding the
    // v0.22.0 regression advisory to a point-of-use release notice.
    const instructions = buildServerInstructions({ setupMode: false, toolExposure: CONTEXT_BUDGET_EXPOSURE });
    const bytes = Buffer.byteLength(instructions, "utf8");
    expect(bytes).toBeLessThan(INSTRUCTION_TARGET_BYTES);
    expect(bytes).toBeLessThanOrEqual(INSTRUCTION_HARD_BYTES);

    // The setup-mode branch is also on the per-session path; hold it under the
    // same hard bound so a future edit cannot blow the budget there either.
    const setup = buildServerInstructions({ setupMode: true, toolExposure: CONTEXT_BUDGET_EXPOSURE });
    expect(Buffer.byteLength(setup, "utf8")).toBeLessThanOrEqual(INSTRUCTION_HARD_BYTES);
  });

  it("enforces UTF-8 boundaries after real whole-response serialization", () => {
    const nearBoundary = { contract: "operation_summary_v1", message: "õ".repeat(5_000) };
    const overBoundary = { contract: "operation_summary_v1", message: "õ".repeat(10_000) };
    expect(mcpSerializedByteLength(nearBoundary)).toBe(Buffer.byteLength(toMcpJson(nearBoundary), "utf8"));
    expect(mcpSerializedByteLength(nearBoundary)).toBeGreaterThan(RESPONSE_BUDGETS.normal.target);
    expect(mcpSerializedByteLength(nearBoundary)).toBeLessThan(RESPONSE_BUDGETS.normal.hard);
    expect(() => assertMcpPayloadWithinHardBudget(nearBoundary, "normal")).not.toThrow();
    expect(mcpSerializedByteLength(overBoundary)).toBeGreaterThan(RESPONSE_BUDGETS.normal.hard);
    expect(() => assertMcpPayloadWithinHardBudget(overBoundary, "normal")).toThrow("response_budget_exceeded");
  });
});
