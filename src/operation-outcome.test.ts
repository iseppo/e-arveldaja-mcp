import { describe, expect, expectTypeOf, it } from "vitest";
import { failureOutcome, failureResponsePayload, plainFailureOutcome, plainSuccessOutcome, successOutcome, type OperationOutcome } from "./operation-outcome.js";

describe("operation outcomes", () => {
  it.each(["plain", "frozen"] as const)("preserves explicit unknown mutation in %s outcomes", kind => {
    const outcome = kind === "plain"
      ? plainFailureOutcome("timeout", "Outcome unknown", "never", { mutationMayHaveOccurred: true })
      : failureOutcome("timeout", "Outcome unknown", "never", [], { mutationMayHaveOccurred: true });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.error).toEqual({ code: "timeout", message: "Outcome unknown", retry: "never", mutationMayHaveOccurred: true });
    expect(failureResponsePayload(outcome.error)).toEqual({
      error: "Outcome unknown", category: "timeout", retry: "never", mutation_occurred: null, mutation_may_have_occurred: true,
    });
    expect(Object.isFrozen(outcome.error)).toBe(kind === "frozen");
  });

  it.each([undefined, false, true])("keeps known/absent mutation payload byte-identical: %s", mutationOccurred => {
    const error = { code: "failed", message: "Failed", retry: "never" as const, mutationOccurred };
    expect(JSON.stringify(failureResponsePayload(error))).toBe(
      `{"error":"Failed","category":"failed","retry":"never","mutation_occurred":${mutationOccurred === true}}`,
    );
    expect(failureResponsePayload({ ...error, mutationMayHaveOccurred: false })).toEqual(failureResponsePayload(error));
    for (const outcome of [
      plainFailureOutcome("failed", "Failed", "never", { mutationOccurred }),
      failureOutcome("failed", "Failed", "never", [], { mutationOccurred }),
    ]) {
      expect(JSON.stringify(outcome)).toBe(`{"ok":false,"error":{"code":"failed","message":"Failed","retry":"never"${mutationOccurred ? ',"mutationOccurred":true' : ""}},"blockers":[]}`);
    }
  });

  it("an uncertain write never becomes a known no-write through a false flag", () => {
    expect(failureResponsePayload({ code: "timeout", message: "Unknown", retry: "never", mutationOccurred: false, mutationMayHaveOccurred: true }).mutation_occurred).toBeNull();
  });

  it("keeps known writes true when unknown-mutation evidence also exists", () => {
    expect(failureResponsePayload({ code: "partial", message: "Partial", retry: "never", mutationOccurred: true, mutationMayHaveOccurred: true })).toEqual({
      error: "Partial", category: "partial", retry: "never", mutation_occurred: true, mutation_may_have_occurred: true,
    });
  });

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

  it("creates plain (unfrozen, uncloned) outcomes with the canonical key order", () => {
    const value = { rows: new Map([["a", 1]]) };
    const success = plainSuccessOutcome(value);
    expect(success).toEqual({ ok: true, value, warnings: [], blockers: [] });
    expect(Object.isFrozen(success)).toBe(false);
    if (success.ok) expect(success.value).toBe(value);

    expect(JSON.stringify(plainFailureOutcome("bad_input", "Bad"))).toBe(
      '{"ok":false,"error":{"code":"bad_input","message":"Bad","retry":"never"},"blockers":[]}',
    );
    expect(JSON.stringify(plainFailureOutcome("net", "Unknown", "unknown", { mutationOccurred: false }))).toBe(
      '{"ok":false,"error":{"code":"net","message":"Unknown","retry":"unknown"},"blockers":[]}',
    );
    const objects = [{ type: "purchase_invoice", id: 7 }];
    const mutated = plainFailureOutcome("partial", "Partial", "safe", { mutationOccurred: true, mutatedObjects: objects });
    expect(mutated).toEqual({
      ok: false,
      error: { code: "partial", message: "Partial", retry: "safe", mutationOccurred: true, mutatedObjects: objects },
      blockers: [],
    });
    expect(Object.isFrozen(mutated)).toBe(false);
  });
});
