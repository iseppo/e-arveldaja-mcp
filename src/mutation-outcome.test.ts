import { describe, expect, it } from "vitest";
import { HttpError } from "./http-client.js";
import {
  MutationIndeterminateError,
  classifyMutationFailure,
  describeMutationCause,
  isMutationIndeterminate,
  type MutationOperation,
} from "./mutation-outcome.js";

describe("H03 mutation outcome", () => {
  it("H03 mutation outcome exposes serializable recovery and HttpError cause fields", () => {
    const operation: MutationOperation = "confirm";
    const error = new MutationIndeterminateError({
      operation,
      entity: "transaction",
      entityId: 7,
      businessKey: "transaction:7",
      affectedCaches: ["/transactions", "/journals"],
      cause: new HttpError("lost", "network", "PATCH", "/transactions/7/register"),
      nextAction: "Freshly read transaction 7 before any retry.",
    });
    expect(error).toMatchObject({
      name: "MutationIndeterminateError",
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
      operation: "confirm",
      entity: "transaction",
      entityId: 7,
      businessKey: "transaction:7",
      affectedCaches: ["/transactions", "/journals"],
      cause: {
        name: "HttpError",
        message: "lost",
        status: "network",
        method: "PATCH",
        path: "/transactions/7/register",
      },
      nextAction: "Freshly read transaction 7 before any retry.",
    });
    expect(JSON.parse(JSON.stringify(error.cause))).toEqual({
      name: "HttpError",
      message: "lost",
      status: "network",
      method: "PATCH",
      path: "/transactions/7/register",
    });
  });

  it("H03 mutation outcome normalizes ordinary and non-Error causes", () => {
    expect(describeMutationCause(new TypeError("bad shape"))).toEqual({
      name: "TypeError",
      message: "bad shape",
    });
    expect(describeMutationCause({ code: "ODD" })).toEqual({
      name: "UnknownThrownValue",
      message: "[object Object]",
    });
  });

  it("H03 mutation outcome recognizes instances and serialized errors safely", () => {
    const instance = new MutationIndeterminateError({
      operation: "rollback",
      entity: "transaction",
      entityId: 7,
      businessKey: "transaction:7",
      affectedCaches: ["/transactions"],
      cause: new Error("cleanup lost"),
      nextAction: "Freshly read transaction 7.",
    });
    expect(isMutationIndeterminate(instance)).toBe(true);
    expect(isMutationIndeterminate({
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
    })).toBe(true);
    expect(isMutationIndeterminate({
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: false,
    })).toBe(false);
    expect(isMutationIndeterminate({ category: "mutation_indeterminate" })).toBe(false);
    expect(isMutationIndeterminate(null)).toBe(false);
  });
});

describe("classifyMutationFailure", () => {
  it.each([400, 401, 403, 404, 409, 422, 429])("treats HTTP %s as a definitive rejection", status => {
    expect(classifyMutationFailure(new HttpError("rejected", status, "POST", "/journals"))).toBe("definitive");
  });

  it.each([408, 500, 502, 503, 504])("treats HTTP %s as indeterminate", status => {
    expect(classifyMutationFailure(new HttpError("ambiguous", status, "POST", "/journals"))).toBe("indeterminate");
  });

  it("treats network / timeout / body-read failures as indeterminate", () => {
    expect(classifyMutationFailure(new HttpError("lost", "network", "PATCH", "/journals/1/register")))
      .toBe("indeterminate");
  });

  it("treats already-classified ambiguity and unknown thrown values as indeterminate", () => {
    const structured = new MutationIndeterminateError({
      operation: "create",
      entity: "journal",
      businessKey: "k",
      affectedCaches: ["/journals"],
      cause: new HttpError("lost", "network", "POST", "/journals"),
      nextAction: "Re-read.",
    });
    expect(classifyMutationFailure(structured)).toBe("indeterminate");
    expect(classifyMutationFailure(new Error("boom"))).toBe("indeterminate");
    expect(classifyMutationFailure("string failure")).toBe("indeterminate");
    expect(classifyMutationFailure(undefined)).toBe("indeterminate");
  });

  it("contains a throwing category getter as indeterminate", () => {
    const hostile = {};
    Object.defineProperty(hostile, "category", { get() { throw new Error("getter"); } });
    expect(classifyMutationFailure(hostile)).toBe("indeterminate");
  });
});
