import { describe, it, expect } from "vitest";
import { readOnly, create, mutate, destructive, send, batch } from "./annotations.js";

describe("annotations", () => {
  it("readOnly is non-destructive and read-only", () => {
    expect(readOnly.readOnlyHint).toBe(true);
    expect(readOnly.destructiveHint).toBe(false);
    expect(readOnly.openWorldHint).toBe(false);
  });

  it("create is not read-only, not destructive, not idempotent", () => {
    expect(create.readOnlyHint).toBe(false);
    expect(create.destructiveHint).toBe(false);
    expect(create.idempotentHint).toBe(false);
  });

  it("mutate is not read-only, not destructive, idempotent", () => {
    expect(mutate.readOnlyHint).toBe(false);
    expect(mutate.destructiveHint).toBe(false);
    expect(mutate.idempotentHint).toBe(true);
  });

  it("destructive is destructive and idempotent", () => {
    expect(destructive.destructiveHint).toBe(true);
    expect(destructive.idempotentHint).toBe(true);
  });

  it("send is destructive and not idempotent", () => {
    expect(send.destructiveHint).toBe(true);
    expect(send.idempotentHint).toBe(false);
  });

  it("batch is destructive and not idempotent", () => {
    expect(batch.destructiveHint).toBe(true);
    expect(batch.idempotentHint).toBe(false);
  });

  it("closed-world presets stay closed while send remains open-world", () => {
    for (const ann of [readOnly, create, mutate, destructive, batch]) {
      expect(ann.openWorldHint).toBe(false);
    }
    expect(send.openWorldHint).toBe(true);
  });
});
