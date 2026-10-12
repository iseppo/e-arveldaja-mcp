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

  it("prunes warnings per code, keeping _more notices and counting what the budget dropped", () => {
    const long = "x".repeat(300);
    const summary = createOperationSummary({
      status: "needs_review",
      message: "Review",
      warnings: [
        ...Array.from({ length: 60 }, (_, index) => ({ item_id: String(index), code: "noisy", message: long })),
        ...Array.from({ length: 3 }, (_, index) => ({ item_id: `a${index}`, code: "auto", message: long })),
        { code: "auto_more", message: "1 more auto item(s) not shown; page them." },
      ],
      plan_handle: "PLAN-1",
    });
    expect(mcpPayloadBytes(summary)).toBeLessThanOrEqual(RESPONSE_BUDGETS.normal.target);
    const codes = summary.warnings!.map(w => w.code);
    const keptNoisy = codes.filter(code => code === "noisy").length;
    expect(keptNoisy).toBeLessThan(60);
    expect(codes.filter(code => code === "auto").length).toBe(Math.min(3, keptNoisy));
    expect(codes).toContain("auto_more");
    const notice = summary.warnings!.find(w => w.code === "warnings_truncated")!;
    expect(notice.message).toContain(`noisy: ${60 - keptNoisy}`);
    expect(notice.message).toContain("PLAN-1");
  });

  it("keeps a summary that fits the hard limit when the truncation notice would be larger than the warning it replaces", () => {
    const warning = { item_id: "r1", code: "ocr_low_confidence", message: "Low OCR confidence." };
    const shell = { status: "needs_review" as const, message: "m", counts: { receipts: 351 }, warnings: [warning], plan_handle: "PLAN-R" };
    const padding = RESPONSE_BUDGETS.batch.hard - 43 + 1
      - mcpPayloadBytes({ summary: { ...shell, contract: "operation_summary_v1" } });
    const input = { ...shell, message: "m".repeat(padding) };
    expect(mcpPayloadBytes({ summary: { ...input, contract: "operation_summary_v1" } })).toBe(RESPONSE_BUDGETS.batch.hard - 43);
    const summary = createOperationSummary(input, { budget: "batch", measureEnvelope: "summary" });
    expect(summary.warnings).toEqual([warning]);
    expect(mcpPayloadBytes({ summary })).toBeLessThanOrEqual(RESPONSE_BUDGETS.batch.hard);
  });

  it("does not let a larger truncation notice stop later sections from trimming the summary under the hard limit", () => {
    const warning = { item_id: "r1", code: "ocr_low_confidence", message: "Low OCR confidence." };
    const first = { item_id: "b1", code: "review", message: "Required review.", severity: "blocker" as const };
    const second = { item_id: "b2", code: "review", message: "r".repeat(200), severity: "blocker" as const };
    const shell = { status: "needs_review" as const, message: "m", warnings: [warning], blockers: [first], plan_handle: "PLAN-R" };
    const padding = RESPONSE_BUDGETS.batch.hard - 20 + 1
      - mcpPayloadBytes({ summary: { ...shell, contract: "operation_summary_v1" } });
    const input = { ...shell, message: "m".repeat(padding), blockers: [first, second] };
    const summary = createOperationSummary(input, { budget: "batch", measureEnvelope: "summary" });
    expect(summary.warnings).toEqual([warning]);
    expect(summary.blockers).toEqual([first]);
  });

  it("measures every per-code cap: a middle cap that fits is kept although dropping everything is larger", () => {
    // Dropping one of two long `a` warnings shrinks the summary, but dropping
    // the short `b` warning too adds b's long retrieval route to the notice.
    const a1 = { code: "a", message: "1" + "a".repeat(600) };
    const a2 = { code: "a", message: "2" + "a".repeat(600) };
    const b = { code: "b", message: "b".repeat(50) };
    const options = {
      budget: "batch" as const,
      measureEnvelope: "summary" as const,
      warningHints: { a: "h".repeat(100), b: "route ".repeat(400) },
    };
    const shell = { status: "needs_review" as const, message: "m", warnings: [a1, a2, b] };
    const padding = RESPONSE_BUDGETS.batch.hard + 50 + 1
      - mcpPayloadBytes({ summary: { ...shell, contract: "operation_summary_v1" } });
    const input = { ...shell, message: "m".repeat(padding) };
    expect(mcpPayloadBytes({ summary: { ...input, contract: "operation_summary_v1" } })).toBe(RESPONSE_BUDGETS.batch.hard + 50);
    const summary = createOperationSummary(input, options);
    expect(summary.warnings!.filter(w => w.code !== "warnings_truncated")).toEqual([a1, b]);
    expect(summary.warnings!.find(w => w.code === "warnings_truncated")!.message).toContain("(a: 1)");
    expect(mcpPayloadBytes({ summary })).toBeLessThanOrEqual(RESPONSE_BUDGETS.batch.hard);
  });

  it("names each dropped code's own retrieval route in warnings_truncated", () => {
    const long = "x".repeat(300);
    const summary = createOperationSummary({
      status: "needs_review",
      message: "Review",
      warnings: [
        ...Array.from({ length: 30 }, (_, index) => ({ code: "created_review", message: `${index}${long}` })),
        ...Array.from({ length: 30 }, (_, index) => ({ code: "excluded_review", message: `${index}${long}` })),
      ],
      plan_handle: "PLAN-1",
    }, { warningHints: { created_review: "page the plan commands." } });
    const notice = summary.warnings!.find(w => w.code === "warnings_truncated")!.message;
    expect(notice).toMatch(/\(created_review: \d+\) page the plan commands\./);
    expect(notice).toMatch(/\(excluded_review: \d+\) page them with get_execution_plan_page .*"exclusions" or "reviews"/);
  });

  it("throws when irreducible Unicode content exceeds the 16 KiB hard limit", () => {
    const input = { status: "failed" as const, message: "🚀".repeat(5_000) };
    expect(() => createOperationSummary(input)).toThrowError("response_budget_exceeded");
    expect(() => createOperationSummary(input)).toThrowError("response_budget_exceeded");
  });
});
