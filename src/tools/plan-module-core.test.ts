import { describe, expect, it } from "vitest";
import { buildExecutionPlanInput, executePlanCommandSpecs, type PlanExecutionCommandSpec } from "./plan-module-core.js";
import { buildCamtExecutionPlanInput } from "./camt-plan.js";
import { buildReconciliationExecutionPlanInput, executeReconciliationCommands } from "./bank-reconciliation-plan.js";
import { buildLightyearExecutionPlanInput, executeLightyearCommands } from "./lightyear-plan.js";

const ARGS = {
  normalizedArgs: { z: 1, a: "x" },
  sourceIdentities: [{ digest_sha256: "d1" }, { digest_sha256: "d2" }],
  liveSnapshot: { accounts: { broker: 1120 } },
  reviewCommands: [
    { id: "c-0", category: "cat", reviewProjection: { amount: 1 }, extra: "not copied" },
    { id: "c-1", category: "cat", reviewProjection: null },
  ],
  fingerprint: "fp",
  counts: { n: 2 },
  totals: { command_count: 2 },
  exclusions: [{ reference: "R" }],
  reviews: [],
};

describe("buildExecutionPlanInput", () => {
  it("assembles the plan input in a fixed key order with the fingerprint kept private", () => {
    const input = buildExecutionPlanInput(ARGS);
    expect(Object.keys(input)).toEqual([
      "normalizedArgs", "sourceIdentities", "liveSnapshot", "commands",
      "counts", "totals", "exclusions", "reviews", "privatePayload",
    ]);
    expect(input.commands).toEqual([
      { id: "c-0", category: "cat", reviewProjection: { amount: 1 } },
      { id: "c-1", category: "cat", reviewProjection: null },
    ]);
    expect(input.privatePayload).toEqual({ fingerprint: "fp" });
  });

  it("is what the reconciliation and Lightyear plan modules build", () => {
    expect(buildReconciliationExecutionPlanInput).toBe(buildExecutionPlanInput);
    expect(buildLightyearExecutionPlanInput).toBe(buildExecutionPlanInput);
  });

  it("binds the CAMT plan to its one statement source and IBAN", () => {
    const { sourceIdentities: _ids, liveSnapshot: _live, ...rest } = ARGS;
    const camt = buildCamtExecutionPlanInput({ ...rest, sourceIdentity: { digest_sha256: "c" }, statementIban: "EE12" });
    expect(JSON.stringify(camt)).toBe(JSON.stringify(buildExecutionPlanInput({
      ...rest, sourceIdentities: [{ digest_sha256: "c" }], liveSnapshot: { statement_iban: "EE12" },
    })));
  });
});

describe("executePlanCommandSpecs", () => {
  it("runs prepare then mutate per command in order and stops at the first drift", async () => {
    const log: string[] = [];
    const spec = (id: string, prep: "ready" | "drift", limit?: number): PlanExecutionCommandSpec => ({
      id,
      category: "cat",
      ...(limit !== undefined ? { known_object_limit: limit } : {}),
      prepare: async () => { log.push(`prepare ${id}`); return prep === "ready" ? { outcome: "ready" } : { outcome: "drift", error_code: "duplicate_appeared" }; },
      mutate: async () => { log.push(`mutate ${id}`); return { outcome: "completed", known_objects: [{ entity_type: "journal", entity_id: 1, outcome: "created" }] }; },
    });
    const report = await executePlanCommandSpecs([spec("a", "ready", 1), spec("b", "drift"), spec("c", "ready")]);
    expect(log).toEqual(["prepare a", "mutate a", "prepare b"]);
    expect(report.command_partitions.completed.map(item => item.command_id)).toEqual(["a"]);
    expect(report.status).not.toBe("completed");
  });

  it("is what the reconciliation and Lightyear plan modules execute with", () => {
    expect(executeReconciliationCommands).toBe(executePlanCommandSpecs);
    expect(executeLightyearCommands).toBe(executePlanCommandSpecs);
  });
});
