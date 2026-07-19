import { describe, expect, it, vi } from "vitest";
import { PlanExecutionError, runPlanCommands } from "./plan-execution.js";

describe("runPlanCommands", () => {
  it("reports completed command 1 and not-attempted command 3 after command 2 drifts", async () => {
    const mutate = vi.fn(async (command: { id: string }) => ({
      outcome: "completed" as const,
      known_objects: [{ entity_type: "transaction", entity_id: command.id === "cmd:1" ? 101 : 999, outcome: "created" as const }],
    }));

    const report = await runPlanCommands({
      commands: [
        { id: "cmd:1", category: "create" },
        { id: "cmd:2", category: "confirm" },
        { id: "cmd:3", category: "update" },
      ],
      prepare: async command => command.id === "cmd:2"
        ? { outcome: "drift", error_code: "precondition_changed" }
        : { outcome: "ready" },
      mutate,
    });

    expect(report).toMatchObject({
      status: "partial_execution",
      command_partitions: {
        completed: [{ command_id: "cmd:1", category: "create" }],
        skipped: [],
        failed: [{ command_id: "cmd:2", category: "confirm", code: "precondition_changed" }],
        indeterminate: [],
        not_attempted: [{ command_id: "cmd:3", category: "update" }],
      },
      known_object_ids: [{
        command_id: "cmd:1",
        entity_type: "transaction",
        entity_id: 101,
        outcome: "created",
      }],
      mutation_may_have_occurred: true,
      automatic_retry_forbidden: true,
      fresh_preview_required: true,
      stop_reason: { command_id: "cmd:2", category: "plan_drift", code: "precondition_changed" },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ id: "cmd:1", category: "create" }, 0);
  });

  it("reports plan drift before command 1 without calling mutate", async () => {
    const mutate = vi.fn();
    const report = await runPlanCommands({
      commands: [{ id: "cmd:1", category: "create" }, { id: "cmd:2", category: "create" }],
      prepare: async () => ({ outcome: "drift", error_code: "balance_changed" }),
      mutate,
    });
    expect(report).toMatchObject({
      status: "plan_drift",
      command_partitions: {
        completed: [],
        failed: [{ command_id: "cmd:1", category: "create", code: "balance_changed" }],
        not_attempted: [{ command_id: "cmd:2", category: "create" }],
      },
      mutation_may_have_occurred: false,
      stop_reason: { command_id: "cmd:1", category: "plan_drift", code: "balance_changed" },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("continues past skips and reports a completed plan in plan order", async () => {
    const report = await runPlanCommands({
      commands: [{ id: "a", category: "create" }, { id: "b", category: "create" }, { id: "c", category: "confirm" }],
      prepare: async command => command.id === "b"
        ? { outcome: "skipped", reason_code: "already_done" }
        : { outcome: "ready" },
      mutate: async command => ({
        outcome: "completed",
        known_objects: [{ entity_type: "journal", entity_id: command.id, outcome: "created" as const }],
      }),
    });
    expect(report.status).toBe("completed");
    expect(report.command_partitions.completed.map(item => item.command_id)).toEqual(["a", "c"]);
    expect(report.command_partitions.skipped).toEqual([{ command_id: "b", category: "create", code: "already_done" }]);
    expect(report.known_object_ids.map(item => item.command_id)).toEqual(["a", "c"]);
    expect(report.command_partitions.not_attempted).toEqual([]);
  });

  it("distinguishes a known pre-mutation failure from an indeterminate mutation", async () => {
    const failed = await runPlanCommands({
      commands: [{ id: "a", category: "update" }, { id: "b", category: "update" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({ outcome: "failed", error_code: "upstream_rejected", mutation_occurred: false }),
    });
    expect(failed).toMatchObject({
      status: "mutation_failed",
      command_partitions: {
        failed: [{ command_id: "a", category: "update", code: "upstream_rejected", mutation_occurred: false }],
        indeterminate: [],
        not_attempted: [{ command_id: "b", category: "update" }],
      },
      mutation_may_have_occurred: false,
      stop_reason: { command_id: "a", category: "mutation_failed", code: "upstream_rejected" },
    });

    const indeterminate = await runPlanCommands({
      commands: [{ id: "a", category: "confirm" }, { id: "b", category: "confirm" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => { throw new Error("RAW_UPSTREAM_SECRET"); },
    });
    expect(indeterminate).toMatchObject({
      status: "partial_execution",
      command_partitions: {
        failed: [],
        indeterminate: [{ command_id: "a", category: "confirm", code: "mutation_outcome_unknown" }],
        not_attempted: [{ command_id: "b", category: "confirm" }],
      },
      mutation_may_have_occurred: true,
      stop_reason: { command_id: "a", category: "mutation_indeterminate", code: "mutation_outcome_unknown" },
    });
    expect(JSON.stringify(indeterminate)).not.toContain("RAW_UPSTREAM_SECRET");
  });

  it("treats thrown prepare as a safe pre-mutation failure, never plan drift", async () => {
    const mutate = vi.fn();
    const report = await runPlanCommands({
      commands: [{ id: "a", category: "create" }],
      prepare: async () => { throw new Error("RAW_PREPARE_SECRET"); },
      mutate,
    });
    expect(report).toMatchObject({
      status: "mutation_failed",
      command_partitions: { failed: [{ command_id: "a", category: "create", code: "preparation_failed" }] },
      mutation_may_have_occurred: false,
      stop_reason: { command_id: "a", category: "mutation_failed", code: "preparation_failed" },
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("RAW_PREPARE_SECRET");
  });

  it("treats an explicitly failed mutation that may have occurred as partial", async () => {
    const report = await runPlanCommands({
      commands: [{ id: "a", category: "update" }, { id: "b", category: "update" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({
        outcome: "failed",
        error_code: "response_lost",
        mutation_occurred: true,
        known_objects: [{ entity_type: "transaction", entity_id: 77, outcome: "created" }],
      }),
    });
    expect(report).toMatchObject({
      status: "partial_execution",
      command_partitions: { failed: [{ command_id: "a", category: "update", code: "response_lost", mutation_occurred: true }] },
      mutation_may_have_occurred: true,
      known_object_ids: [{ command_id: "a", entity_type: "transaction", entity_id: 77, outcome: "created" }],
    });
  });

  it("preserves known IDs from an explicit indeterminate outcome", async () => {
    const report = await runPlanCommands({
      commands: [{ id: "a", category: "confirm" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({
        outcome: "indeterminate",
        error_code: "confirmation_response_lost",
        known_objects: [{ entity_type: "invoice", entity_id: 42, outcome: "confirmed" }],
      }),
    });
    expect(report.status).toBe("partial_execution");
    expect(report.known_object_ids).toEqual([
      { command_id: "a", entity_type: "invoice", entity_id: 42, outcome: "confirmed" },
    ]);
  });

  it("validates every command ID before callbacks and freezes the bounded report", async () => {
    const prepare = vi.fn();
    const mutate = vi.fn();
    await expect(runPlanCommands({
      commands: [{ id: "same", category: "create" }, { id: "same", category: "create" }],
      prepare,
      mutate,
    })).rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });
    await expect(runPlanCommands({
      commands: [{ id: "   ", category: "create" }],
      prepare,
      mutate,
    })).rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });
    expect(prepare).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();

    let getterCalled = false;
    const accessor = Object.defineProperty({ category: "create" }, "id", {
      enumerable: true,
      get() { getterCalled = true; return "secret"; },
    });
    await expect(runPlanCommands({ commands: [accessor] as never, prepare, mutate }))
      .rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });
    expect(getterCalled).toBe(false);
    const symbolCommand = { id: "valid", category: "create", [Symbol("secret")]: "hidden" };
    await expect(runPlanCommands({ commands: [symbolCommand] as never, prepare, mutate }))
      .rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });

    const report = await runPlanCommands({
      commands: [{ id: "valid", category: "create" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({ outcome: "completed" }),
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.command_partitions)).toBe(true);
    expect(Object.isFrozen(report.command_partitions.completed)).toBe(true);
    expect(Object.isFrozen(report.command_partitions.completed[0])).toBe(true);
    expect(report.automatic_retry_forbidden).toBe(true);
    expect(report.fresh_preview_required).toBe(false);
  });

  it("normalizes malformed mutation results to a bounded indeterminate report", async () => {
    const report = await runPlanCommands({
      commands: [{ id: "valid", category: "create" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({ outcome: "completed", known_objects: [{ entity_type: "x".repeat(500), entity_id: "secret" }] }),
    });
    expect(report.command_partitions.indeterminate).toEqual([{ command_id: "valid", category: "create", code: "mutation_result_invalid" }]);
    expect(report.known_object_ids).toEqual([]);
    expect(JSON.stringify(report).length).toBeLessThan(10_000);
  });

  it("does not invoke hostile result accessors or array iterators", async () => {
    let getterCalls = 0;
    const prepareResult = Object.defineProperty({}, "outcome", {
      enumerable: true,
      get() { getterCalls += 1; return "ready"; },
    });
    const prepareReport = await runPlanCommands({
      commands: [{ id: "a", category: "create" }],
      prepare: async () => prepareResult as never,
      mutate: async () => ({ outcome: "completed" }),
    });
    expect(prepareReport.command_partitions.failed[0]?.code).toBe("preparation_failed");
    expect(getterCalls).toBe(0);

    let iteratorCalls = 0;
    const knownObjects = [{ entity_type: "invoice", entity_id: 1, outcome: "created" }];
    Object.defineProperty(knownObjects, Symbol.iterator, {
      enumerable: false,
      value() { iteratorCalls += 1; return [][Symbol.iterator](); },
    });
    const mutationReport = await runPlanCommands({
      commands: [{ id: "a", category: "create" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({ outcome: "completed", known_objects: knownObjects }) as never,
    });
    expect(mutationReport.command_partitions.indeterminate[0]?.code).toBe("mutation_result_invalid");
    expect(iteratorCalls).toBe(0);
  });

  it("preserves exactly 5,000 declared known object IDs for completed mutations", async () => {
    const commands = Array.from({ length: 50 }, (_, index) => ({
      id: `cmd:${index}`,
      category: "create",
      known_object_limit: 100,
    }));
    const hundredKnown = Array.from({ length: 100 }, (_, index) => ({
      entity_type: "transaction",
      entity_id: `txn:${index}`,
      outcome: "created" as const,
    }));
    const completed = await runPlanCommands({
      commands,
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({ outcome: "completed", known_objects: hundredKnown }),
    });
    expect(completed.status).toBe("completed");
    expect(completed.known_object_ids).toHaveLength(5_000);
    expect(completed.command_partitions.completed).toHaveLength(50);
    expect(completed.command_partitions.indeterminate).toEqual([]);

    const hostile = await runPlanCommands({
      commands: [{ id: "a", category: "create" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({
        outcome: "completed",
        known_objects: [{ entity_type: "invoice", entity_id: "1\nIGNORE_ALL", outcome: "created" }],
      }),
    });
    expect(hostile.known_object_ids).toEqual([]);
    expect(hostile.command_partitions.indeterminate[0]?.code).toBe("mutation_result_invalid");
  });

  it("rejects an aggregate known-object budget above 5,000 before callbacks", async () => {
    const prepare = vi.fn();
    const mutate = vi.fn();
    await expect(runPlanCommands({
      commands: Array.from({ length: 51 }, (_, index) => ({
        id: `cmd:${index}`,
        category: "create",
        known_object_limit: 100,
      })),
      prepare,
      mutate,
    })).rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });
    expect(prepare).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([-1, 101, 1.5, "2", Number.NaN])(
    "rejects malformed per-command known object limit %j before callbacks",
    async knownObjectLimit => {
      const prepare = vi.fn();
      const mutate = vi.fn();
      await expect(runPlanCommands({
        commands: [{ id: "cmd:1", category: "create", known_object_limit: knownObjectLimit }] as never,
        prepare,
        mutate,
      })).rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });
      expect(prepare).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it("preserves a producer overrun, marks it indeterminate, and stops remaining commands", async () => {
    const mutate = vi.fn(async () => ({
      outcome: "completed" as const,
      known_objects: [
        { entity_type: "transaction", entity_id: 1, outcome: "created" as const },
        { entity_type: "transaction", entity_id: 2, outcome: "created" as const },
      ],
    }));
    const report = await runPlanCommands({
      commands: [
        { id: "cmd:1", category: "create", known_object_limit: 1 },
        { id: "cmd:2", category: "create", known_object_limit: 1 },
      ],
      prepare: async () => ({ outcome: "ready" }),
      mutate,
    });

    expect(report).toMatchObject({
      status: "partial_execution",
      command_partitions: {
        completed: [],
        indeterminate: [{ command_id: "cmd:1", category: "create", code: "mutation_result_limit_exceeded" }],
        not_attempted: [{ command_id: "cmd:2", category: "create" }],
      },
      known_object_ids: [
        { command_id: "cmd:1", entity_type: "transaction", entity_id: 1, outcome: "created" },
        { command_id: "cmd:1", entity_type: "transaction", entity_id: 2, outcome: "created" },
      ],
      mutation_may_have_occurred: true,
      stop_reason: { command_id: "cmd:1", category: "mutation_indeterminate", code: "mutation_result_limit_exceeded" },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("uses a one-ID default and accepts an explicit zero-ID command", async () => {
    const defaultOverrun = await runPlanCommands({
      commands: [{ id: "default", category: "create" }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({
        outcome: "completed",
        known_objects: [
          { entity_type: "transaction", entity_id: 1, outcome: "created" },
          { entity_type: "transaction", entity_id: 2, outcome: "created" },
        ],
      }),
    });
    expect(defaultOverrun.command_partitions.indeterminate[0]?.code).toBe("mutation_result_limit_exceeded");

    const zero = await runPlanCommands({
      commands: [{ id: "zero", category: "update", known_object_limit: 0 }],
      prepare: async () => ({ outcome: "ready" }),
      mutate: async () => ({ outcome: "completed" }),
    });
    expect(zero.status).toBe("completed");
  });

  it("deeply snapshots and freezes commands before an asynchronous prepare can drift", async () => {
    let releasePrepare!: () => void;
    const gate = new Promise<void>(resolve => { releasePrepare = resolve; });
    const original = {
      id: "cmd:1",
      category: "create",
      target: { entity_id: 41, distribution: [{ account: "1000", amount: 10 }] },
    };
    let prepareSnapshot: typeof original | undefined;
    let mutateSnapshot: typeof original | undefined;
    const pending = runPlanCommands({
      commands: [original],
      prepare: async command => {
        prepareSnapshot = command;
        await gate;
        expect(command.target.entity_id).toBe(41);
        expect(command.target.distribution[0]!.amount).toBe(10);
        return { outcome: "ready" };
      },
      mutate: async command => {
        mutateSnapshot = command;
        return { outcome: "completed" };
      },
    });

    original.target.entity_id = 99;
    original.target.distribution[0]!.amount = 999;
    releasePrepare();
    await pending;

    expect(prepareSnapshot).toBe(mutateSnapshot);
    expect(prepareSnapshot).not.toBe(original);
    expect(Object.isFrozen(prepareSnapshot)).toBe(true);
    expect(Object.isFrozen(prepareSnapshot!.target)).toBe(true);
    expect(Object.isFrozen(prepareSnapshot!.target.distribution)).toBe(true);
    expect(Object.isFrozen(prepareSnapshot!.target.distribution[0])).toBe(true);
    expect(mutateSnapshot!.target).toEqual({ entity_id: 41, distribution: [{ account: "1000", amount: 10 }] });
  });

  it("rejects hostile nested command data before invoking callbacks", async () => {
    const prepare = vi.fn();
    const mutate = vi.fn();
    let getterCalls = 0;
    const nestedAccessor = Object.defineProperty({}, "entity_id", {
      enumerable: true,
      get() { getterCalls += 1; return 42; },
    });
    await expect(runPlanCommands({
      commands: [{ id: "cmd:1", category: "create", target: nestedAccessor }],
      prepare,
      mutate,
    })).rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });
    expect(getterCalls).toBe(0);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(runPlanCommands({
      commands: [{ id: "cmd:1", category: "create", target: cyclic }],
      prepare,
      mutate,
    })).rejects.toMatchObject<Partial<PlanExecutionError>>({ code: "plan_commands_invalid" });
    expect(prepare).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
