import { describe, expect, it } from "vitest";
import { buildBatchExecutionContract } from "./batch-execution.js";
import { runPlanCommands } from "./plan-execution.js";

describe("buildBatchExecutionContract execution reports", () => {
  it("preserves the exact legacy shape when an execution report is omitted", () => {
    expect(buildBatchExecutionContract({ mode: "EXECUTED", summary: { completed: 1 }, results: [1] }))
      .toEqual({
        contract: "batch_execution_v1",
        mode: "EXECUTED",
        summary: { completed: 1 },
        results: [1],
        skipped: [],
        errors: [],
        needs_review: [],
        audit_reference: expect.any(Object),
      });
  });

  it("adds a report only to EXECUTED responses and rejects it for DRY_RUN", async () => {
    const executionReport = await runPlanCommands({
      commands: [{ id: "one", category: "create" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({ outcome: "completed" }),
    });
    expect(buildBatchExecutionContract({ mode: "EXECUTED", summary: {}, results: [], execution_report: executionReport }))
      .toHaveProperty("execution_report", executionReport);
    expect(() => buildBatchExecutionContract({ mode: "DRY_RUN", summary: {}, results: [], execution_report: executionReport }))
      .toThrowError("Execution reports are only valid for executed batches.");
  });
});
