import { describe, it, expect } from "vitest";
import {
  type ConnectionSnapshot,
  ConnectionSwitchInterruptedError,
  captureSnapshot,
  assertSnapshotCurrent,
  buildSwitchBlockedPayload,
  resolveDefaultConnectionIndex,
  buildConnectionMismatchPayload,
} from "./connection-safety.js";

describe("captureSnapshot", () => {
  it("captures the current index + generation from the state", () => {
    const snap = captureSnapshot({ activeIndex: 2, generation: 5 });
    expect(snap).toMatchObject({ index: 2, generation: 5 });
    expect(snap.toolName).toBeUndefined();
    expect(snap.isReadOnly).toBeUndefined();
  });

  it("records toolName and isReadOnly when provided", () => {
    const snap = captureSnapshot(
      { activeIndex: 0, generation: 7 },
      { toolName: "create_journal", isReadOnly: false },
    );
    expect(snap).toMatchObject({
      index: 0,
      generation: 7,
      toolName: "create_journal",
      isReadOnly: false,
    });
    expect(snap.capturedAtMs).toBeTypeOf("number");
    expect(snap.capturedAtMs!).toBeGreaterThan(0);
  });
});

describe("assertSnapshotCurrent", () => {
  it("is a no-op when the snapshot's generation still matches", () => {
    const state = { activeIndex: 0, generation: 1 };
    const snap = captureSnapshot(state, { toolName: "list_clients", isReadOnly: true });
    expect(() => assertSnapshotCurrent(state, snap)).not.toThrow();
  });

  it("throws ConnectionSwitchInterruptedError when the generation advanced", () => {
    const state = { activeIndex: 0, generation: 1 };
    const snap = captureSnapshot(state, { toolName: "confirm_transaction", isReadOnly: false });
    state.generation = 2; // simulate a switch_connection mid-execution
    expect(() => assertSnapshotCurrent(state, snap)).toThrowError(ConnectionSwitchInterruptedError);
  });

  it("surfaces the captured toolName in the thrown error", () => {
    const state = { activeIndex: 0, generation: 1 };
    const snap = captureSnapshot(state, { toolName: "confirm_transaction", isReadOnly: false });
    state.generation = 5;
    try {
      assertSnapshotCurrent(state, snap);
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as ConnectionSwitchInterruptedError;
      expect(e.name).toBe("ConnectionSwitchInterruptedError");
      expect(e.toolName).toBe("confirm_transaction");
      expect(e.wasReadOnly).toBe(false);
      expect(e.originalIndex).toBe(0);
      expect(e.message).toContain("confirm_transaction");
      expect(e.message).toContain("Further API requests were blocked");
    }
  });

  it("falls back gracefully when toolName is undefined (resource handlers)", () => {
    const state = { activeIndex: 0, generation: 1 };
    const snap: ConnectionSnapshot = { index: 0, generation: 1 };
    state.generation = 9;
    expect(() => assertSnapshotCurrent(state, snap)).toThrowError(
      /Active connection changed during tool execution/,
    );
  });
});

describe("buildSwitchBlockedPayload", () => {
  it("returns null when no mutations are in flight", () => {
    expect(buildSwitchBlockedPayload(new Set(), undefined)).toBeNull();
  });

  it("returns null when the only in-flight snapshot is the current one (switch_connection itself)", () => {
    // switch_connection is marked mutate, so its own snapshot is in the set.
    // It must not block itself.
    const self: ConnectionSnapshot = {
      index: 0, generation: 3, toolName: "switch_connection", isReadOnly: false,
    };
    expect(buildSwitchBlockedPayload([self], self)).toBeNull();
  });

  it("returns a structured error when a non-readonly tool is in flight", () => {
    const current: ConnectionSnapshot = {
      index: 0, generation: 3, toolName: "switch_connection", isReadOnly: false,
    };
    const interrupted: ConnectionSnapshot = {
      index: 0, generation: 3, toolName: "confirm_transaction", isReadOnly: false,
    };
    const payload = buildSwitchBlockedPayload([current, interrupted], current);
    expect(payload).not.toBeNull();
    expect(payload!.error).toContain("1 non-readonly tool(s) are in flight");
    expect(payload!.in_flight_tools).toEqual([
      { tool_name: "confirm_transaction", source_connection_index: 0 },
    ]);
    expect(payload!.hint).toContain("cancel the MCP client request");
  });

  it("lists every interruptable tool when several are in flight", () => {
    const a: ConnectionSnapshot = { index: 0, generation: 2, toolName: "create_journal", isReadOnly: false };
    const b: ConnectionSnapshot = { index: 0, generation: 2, toolName: "send_sale_invoice", isReadOnly: false };
    const c: ConnectionSnapshot = { index: 0, generation: 2, toolName: "switch_connection", isReadOnly: false };
    const payload = buildSwitchBlockedPayload([a, b, c], c);
    expect(payload).not.toBeNull();
    expect(payload!.in_flight_tools.map(t => t.tool_name).sort())
      .toEqual(["create_journal", "send_sale_invoice"]);
    expect(payload!.error).toContain("2 non-readonly tool(s)");
  });

  it("labels snapshots without a toolName as 'unknown'", () => {
    // Shouldn't happen in practice (all mutating tool snapshots include
    // toolName), but the helper is defensive.
    const weird: ConnectionSnapshot = { index: 1, generation: 0, isReadOnly: false };
    const payload = buildSwitchBlockedPayload([weird], undefined);
    expect(payload!.in_flight_tools).toEqual([
      { tool_name: "unknown", source_connection_index: 1 },
    ]);
  });

  it("reports age_ms for in-flight snapshots with capturedAtMs", () => {
    const now = 1_000_000;
    const snap: ConnectionSnapshot = {
      index: 0, generation: 1, toolName: "confirm_transaction", isReadOnly: false,
      capturedAtMs: now - 5_000,
    };
    const payload = buildSwitchBlockedPayload([snap], undefined, { now });
    expect(payload!.in_flight_tools[0]).toMatchObject({
      tool_name: "confirm_transaction",
      age_ms: 5_000,
    });
  });

  it("keeps blocking long-running snapshots rather than auto-releasing the gate", () => {
    // A tool that has already performed one API write then spends a long
    // time in local work (PDF parse, CAMT enrichment, etc.) must NOT have
    // its snapshot reaped: letting switch_connection proceed would commit
    // the first write on connection A while subsequent calls fail after
    // the switch, producing partial state across the switch boundary.
    const now = 1_000_000;
    const longRunning: ConnectionSnapshot = {
      index: 0, generation: 1, toolName: "create_purchase_invoice_from_pdf", isReadOnly: false,
      capturedAtMs: now - 600_000, // 10 minutes
    };
    const set = new Set<ConnectionSnapshot>([longRunning]);
    const payload = buildSwitchBlockedPayload(set, undefined, { now });
    expect(payload).not.toBeNull();
    expect(payload!.in_flight_tools).toHaveLength(1);
    expect(payload!.in_flight_tools[0]!.age_ms).toBe(600_000);
    expect(payload!.hint).toMatch(/over 2 minutes/);
    // Set is NOT mutated — snapshot stays tracked until the handler finishes
    // or the MCP client cancels the request.
    expect(set.has(longRunning)).toBe(true);
  });

  it("uses the standard hint when no snapshot has been running long", () => {
    const now = 1_000_000;
    const snap: ConnectionSnapshot = {
      index: 0, generation: 1, toolName: "confirm_transaction", isReadOnly: false,
      capturedAtMs: now - 5_000,
    };
    const payload = buildSwitchBlockedPayload([snap], undefined, { now });
    expect(payload!.hint).toMatch(/cancel the MCP client request/);
    expect(payload!.hint).not.toMatch(/over 2 minutes/);
  });
});

describe("resolveDefaultConnectionIndex", () => {
  const names = ["alpha", "beta"];
  it("defaults to index 0 when unset or blank", () => {
    expect(resolveDefaultConnectionIndex(names, undefined)).toBe(0);
    expect(resolveDefaultConnectionIndex(names, "  ")).toBe(0);
    expect(resolveDefaultConnectionIndex([], "anything")).toBe(0);
  });
  it("accepts an index or an exact name", () => {
    expect(resolveDefaultConnectionIndex(names, "1")).toBe(1);
    expect(resolveDefaultConnectionIndex(names, " beta ")).toBe(1);
    expect(resolveDefaultConnectionIndex(names, "alpha")).toBe(0);
  });
  it("throws on an out-of-range index or unknown name", () => {
    expect(() => resolveDefaultConnectionIndex(names, "2")).toThrow(/Valid indexes: 0-1/);
    expect(() => resolveDefaultConnectionIndex(names, "gamma")).toThrow(/"gamma" does not match/);
  });
});

describe("buildConnectionMismatchPayload", () => {
  const names = ["alpha", "beta"];
  it("is null when no guard argument was given or it matches", () => {
    expect(buildConnectionMismatchPayload(undefined, 1, names)).toBeNull();
    expect(buildConnectionMismatchPayload(null, 1, names)).toBeNull();
    expect(buildConnectionMismatchPayload(1, 1, names)).toBeNull();
    expect(buildConnectionMismatchPayload("1", 1, names)).toBeNull();
    expect(buildConnectionMismatchPayload("beta", 1, names)).toBeNull();
  });
  it("returns a structured refusal naming both sides on a mismatch", () => {
    const payload = buildConnectionMismatchPayload("alpha", 1, names);
    expect(payload).toMatchObject({
      category: "connection_mismatch",
      expected_connection: "alpha",
      active_connection: { index: 1, name: "beta" },
    });
    expect(buildConnectionMismatchPayload(0, 1, names)?.expected_connection).toBe(0);
    expect(buildConnectionMismatchPayload("", 1, names)?.category).toBe("connection_mismatch");
  });
});
