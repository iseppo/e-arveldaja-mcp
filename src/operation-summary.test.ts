import { describe, expect, it } from "vitest";
import { createOperationSummary } from "./operation-summary.js";

describe("operation_summary_v1", () => {
  it("pins the public contract and recursively freezes caller-owned values", () => {
    const counts = { created: 2 };
    const summary = createOperationSummary({
      status: "partial", message: "Two completed", counts, totals: { EUR: 12.5 },
      scope: { connection: "demo", company: "ACME", account: "EE00", period: { from: "2026-01-01", to: "2026-01-31" }, source_documents: 3 },
      warnings: [{ code: "w", message: "Warning" }], blockers: [], samples: [{ item_id: "1", code: "ok", message: "Created", severity: "warning" }],
      next_action: { tool: "get_operation_result_page", args: { operation_handle: "opaque" }, approval_required: false },
      workflow_handle: "workflow", plan_handle: "plan",
      details: { available: true, total_items: 4, returned_items: 1, tool: "get_operation_result_page", args: { operation_handle: "opaque" } },
    });
    counts.created = 99;
    expect(summary.contract).toBe("operation_summary_v1");
    expect(summary.counts).toEqual({ created: 2 });
    expect(Object.isFrozen(summary.scope?.period)).toBe(true);
    expect(Object.isFrozen(summary.details?.args)).toBe(true);
  });

  it("cannot have its contract discriminator overwritten by an untyped caller", () => {
    const summary = createOperationSummary({ status: "completed", message: "ok", contract: "spoofed" } as any);
    expect(summary.contract).toBe("operation_summary_v1");
  });
});
