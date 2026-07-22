import { describe, expect, expectTypeOf, it } from "vitest";
import { failureOutcome, successOutcome, type OperationOutcome } from "./operation-outcome.js";

describe("operation outcomes", () => {
  it("creates frozen transport-independent success and failure outcomes", () => {
    const success = successOutcome({ id: 1 }, [{ code: "rounded", message: "Rounded", item_id: "1" }]);
    const failure = failureOutcome("network_unknown", "Outcome unknown", "unknown", [{
      item_id: "1", code: "manual_review", message: "Review", severity: "blocker",
    }]);
    expect(success).toEqual({ ok: true, value: { id: 1 }, warnings: [{ code: "rounded", message: "Rounded", item_id: "1" }], blockers: [] });
    expect(failure).toEqual({ ok: false, error: { code: "network_unknown", message: "Outcome unknown", retry: "unknown" }, blockers: [expect.objectContaining({ severity: "blocker" })] });
    expect(Object.isFrozen(success)).toBe(true);
    expect(JSON.stringify([success, failure])).not.toContain("content");
    expectTypeOf(success).toMatchTypeOf<OperationOutcome<{ id: number }>>();
  });

  it("deeply detaches and freezes caller-owned values, warnings, and blockers", () => {
    const value = { nested: { amount: 1 } };
    const warning = { code: "w", message: "before" };
    const blocker = { item_id: "1", code: "b", message: "before", severity: "blocker" as const };
    const outcome = successOutcome(value, [warning], [blocker]);
    value.nested.amount = 2;
    warning.message = "after";
    blocker.message = "after";
    expect(outcome).toMatchObject({ value: { nested: { amount: 1 } }, warnings: [{ message: "before" }], blockers: [{ message: "before" }] });
    if (outcome.ok) {
      expect(Object.isFrozen((outcome.value as any).nested)).toBe(true);
      expect(Object.isFrozen(outcome.warnings[0])).toBe(true);
      expect(Object.isFrozen(outcome.blockers[0])).toBe(true);
    }
  });
});
