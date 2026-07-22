import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildResponseFixtures,
  measureResponseFixtures,
  REQUIRED_RESPONSE_FIXTURE_NAMES,
} from "../scripts/measure-response-fixtures.js";
import { mcpSerializedByteLength, parseMcpResponse, toMcpJson } from "./mcp-json.js";
import { assertMcpPayloadWithinHardBudget, RESPONSE_BUDGETS } from "./response-budget.js";

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
