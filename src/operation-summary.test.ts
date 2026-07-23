import { describe, expect, expectTypeOf, it } from "vitest";
import { createOperationSummary, type OperationSummaryV1 } from "./operation-summary.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "./response-budget.js";

describe("operation_summary_v1", () => {
  it("pins the public contract and recursively freezes caller-owned values", () => {
    const counts = { created: 2 };
    const summary = createOperationSummary({
      status: "partial", message: "Two completed", counts, totals: { EUR: 12.5 },
      scope: { connection: "demo", company: "ACME", account: "EE00", period: { from: "2026-01-01" }, source_documents: ["statement.xml"] },
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

  it("pins optional period endpoints, document names, and unconstrained samples", () => {
    expectTypeOf<NonNullable<NonNullable<OperationSummaryV1["scope"]>["period"]>>()
      .toEqualTypeOf<{ from?: string; to?: string }>();
    expectTypeOf<NonNullable<NonNullable<OperationSummaryV1["scope"]>["source_documents"]>>()
      .toEqualTypeOf<string[]>();
    expectTypeOf<NonNullable<OperationSummaryV1["samples"]>>()
      .toEqualTypeOf<unknown[]>();

    const summary = createOperationSummary({
      status: "completed",
      message: "ok",
      scope: { period: { to: "2026-01-31" }, source_documents: ["a.xml", "b.csv"] },
      samples: ["plain", 42, { arbitrary: true }],
    });
    expect(summary.scope).toEqual({ period: { to: "2026-01-31" }, source_documents: ["a.xml", "b.csv"] });
    expect(summary.samples).toEqual(["plain", 42, { arbitrary: true }]);
  });

  it("cannot have its contract discriminator overwritten by an untyped caller", () => {
    const summary = createOperationSummary({ status: "completed", message: "ok", contract: "spoofed" } as any);
    expect(summary.contract).toBe("operation_summary_v1");
  });

  it("deterministically compacts Unicode optional content toward 8 KiB without slicing values", () => {
    const marker = "õ🚀".repeat(500);
    const input = {
      status: "partial" as const,
      message: "Review",
      scope: { source_documents: Array.from({ length: 20 }, (_, index) => `${index}-${marker}`) },
      warnings: Array.from({ length: 20 }, (_, index) => ({ code: `w${index}`, message: marker })),
      blockers: [{ item_id: "required", code: "review", message: marker, severity: "blocker" as const }],
      samples: Array.from({ length: 20 }, (_, index) => ({ index, marker })),
      details: { available: false, total_items: 41, returned_items: 41, tool: "get_operation_result_page", args: { operation_handle: "opaque" } },
    };
    const first = createOperationSummary(input);
    const second = createOperationSummary(input);
    expect(first).toEqual(second);
    expect(mcpPayloadBytes(first)).toBeLessThanOrEqual(RESPONSE_BUDGETS.normal.target);
    expect(first.blockers?.[0]?.message).toBe(marker);
    expect(first.details).toMatchObject({ available: true, returned_items: 1 });
  });

  it("throws when irreducible Unicode content exceeds the 16 KiB hard limit", () => {
    const input = { status: "failed" as const, message: "🚀".repeat(5_000) };
    expect(() => createOperationSummary(input)).toThrowError("response_budget_exceeded");
    expect(() => createOperationSummary(input)).toThrowError("response_budget_exceeded");
  });
});
