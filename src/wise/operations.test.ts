import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWiseOperations } from "./operations.js";
import { WiseOperationFailedError } from "./executor.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";

// The typed Wise operations are exercised through narrow api/plan ports — NOT a
// mock McpServer. This pins prepare (zero mutations, issue plan) → execute
// (consume plan) and the execution-safety gates: plan consume-once, digest +
// plan_handle both required, approval separation, and audit truth.

const { mockedLogAudit } = vi.hoisted(() => ({ mockedLogAudit: vi.fn() }));
vi.mock("../audit-log.js", () => ({ logAudit: mockedLogAudit }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../cache-control.js", () => ({ clearRuntimeCaches: vi.fn() }));

const CSV_HEADER = [
  "ID", "Status", "Direction", "Created on", "Finished on",
  "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
  "Source name", "Source amount (after fees)", "Source currency",
  "Target name", "Target amount (after fees)", "Target currency",
  "Exchange rate", "Reference", "Batch", "Created by", "Category", "Note",
].join(",");

function oneRowCsv(): string {
  const row = [
    "WISE-1", "COMPLETED", "OUT", "2026-01-10 10:00:00", "2026-01-10 10:00:00",
    "0", "EUR", "0", "EUR",
    "MyCo", "100", "EUR",
    "Acme", "100", "EUR",
    "1", "inv-1", "", "", "General", "note",
  ].join(",");
  return `${CSV_HEADER}\n${row}\n`;
}

// CSV has no magic signature, so the base64 form needs an explicit extension
// hint (base64:csv:<b64>).
const inline = (csv: string): string => `base64:csv:${Buffer.from(csv, "utf8").toString("base64")}`;

function setup() {
  const create = vi.fn().mockResolvedValue({ created_object_id: 9001 });
  const api = {
    clients: {
      listAll: vi.fn().mockResolvedValue([{ id: 77, name: "Wise" }]),
      findByName: vi.fn().mockResolvedValue([]),
    },
    readonly: {
      getAccountDimensions: vi.fn().mockResolvedValue([{ id: 9, accounts_id: 8610, title_est: "Muud finantskulud", is_deleted: false }]),
      getBankAccounts: vi.fn().mockResolvedValue([]),
      getInvoiceInfo: vi.fn().mockResolvedValue({}),
    },
    journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
    transactions: {
      connectionFingerprint: "wise-ops-test",
      listAll: vi.fn().mockResolvedValue([]),
      create,
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
    },
    purchaseInvoices: undefined,
  } as any;
  const runtimeSafetyContext = createTestRuntimeSafetyContext();
  const operations = createWiseOperations(api, runtimeSafetyContext);
  return { api, operations };
}

const baseInput = (source: string) => ({
  source: { file_path: source },
  accountsDimensionsId: 5,
  feeAccountDimensionsId: undefined,
  feeAccountRelationId: undefined,
  interAccountDimensionId: undefined,
  confirmOwnTransferIds: undefined,
  approvedCommandDigest: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  skipJarTransfers: undefined,
});

describe("WiseOperations", () => {
  beforeEach(() => mockedLogAudit.mockClear());

  it("prepare projects one command + digest + plan handle with ZERO mutations", async () => {
    const { api, operations } = setup();
    const outcome = await operations.prepare(baseInput(inline(oneRowCsv())));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.commands).toHaveLength(1);
      expect(outcome.value.commands[0]!.action).toBe("main_create");
      expect(outcome.value.approvedCommandDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof outcome.value.planHandle).toBe("string");
    }
    expect(api.transactions.create).not.toHaveBeenCalled();
    expect(api.transactions.confirm).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  // A fee row is synthesised, so it carries no source_row and the presenter can
  // only learn its currency from booked_currency. The projection sets it, but
  // execute SPLICES `created` empty and rebuilds it from its own pushes — so a
  // presenter-level test proves nothing about the executed card. This goes
  // through the executor for that reason.
  it("execute carries the fee row's booked_currency so the executed card can label its totals", async () => {
    const usdFeeCsv = `${CSV_HEADER}\n${[
      "WISE-FEE-1", "COMPLETED", "OUT", "2026-01-10 10:00:00", "2026-01-10 10:00:00",
      "3", "USD", "0", "USD",
      "MyCo", "100", "EUR",
      "Acme", "100", "EUR",
      "1", "inv-1", "", "", "General", "note",
    ].join(",")}\n`;
    const { operations } = setup();
    const source = inline(usdFeeCsv);
    const input = { ...baseInput(source), feeAccountDimensionsId: 9 };
    const dry = await operations.prepare(input);
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;

    const outcome = await operations.execute({
      ...input,
      approvedCommandDigest: dry.value.approvedCommandDigest,
      planHandle: dry.value.planHandle,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const feeEntry = outcome.value.created.find(entry => entry.wise_id.startsWith("FEE:"));
    expect(feeEntry).toBeDefined();
    expect(feeEntry!.source_row).toBeUndefined();
    // This harness has no transactions.get, so the pre-confirm freshness check
    // fails and the row comes from the confirm-failed push. Both fee pushes are
    // covered: the confirmed one is exercised below.
    expect(feeEntry!.status).toContain("confirm failed");
    expect(feeEntry!.booked_currency).toBe("USD");
  });

  it("carries the fee row's booked_currency on the confirmed push too", async () => {
    const usdFeeCsv = `${CSV_HEADER}\n${[
      "WISE-FEE-2", "COMPLETED", "OUT", "2026-01-10 10:00:00", "2026-01-10 10:00:00",
      "3", "USD", "0", "USD",
      "MyCo", "100", "EUR",
      "Acme", "100", "EUR",
      "1", "inv-1", "", "", "General", "note",
    ].join(",")}\n`;
    const { api, operations } = setup();
    const source = inline(usdFeeCsv);
    const input = { ...baseInput(source), feeAccountDimensionsId: 9 };
    const dry = await operations.prepare(input);
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;

    // Let the pre-confirm freshness check pass by echoing back the exact payload
    // the executor just created, so the fee reaches the created_and_confirmed
    // push. The row must appear ONLY after the create — surfacing it earlier
    // changes the re-derived plan and the execute fails closed as plan_drift.
    const feeCommand = dry.value.commands.find(command => command.wise_id.startsWith("FEE:"));
    expect(feeCommand).toBeDefined();
    const live: Array<Record<string, unknown>> = [];
    let nextId = 9001;
    api.transactions.create.mockImplementation(async (payload: Record<string, unknown>) => {
      const id = nextId++;
      live.push({ id, status: "PROJECT", is_deleted: false, ...payload });
      return { created_object_id: id };
    });
    api.transactions.listAll.mockImplementation(async () => [...live]);

    const outcome = await operations.execute({
      ...input,
      approvedCommandDigest: dry.value.approvedCommandDigest,
      planHandle: dry.value.planHandle,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const feeEntry = outcome.value.created.find(entry => entry.wise_id.startsWith("FEE:"));
    expect(feeEntry).toBeDefined();
    expect(feeEntry!.status).toBe("created_and_confirmed");
    expect(feeEntry!.source_row).toBeUndefined();
    expect(feeEntry!.booked_currency).toBe("USD");
  });

  it("execute consumes the reviewed plan, creates the row once, and audits it", async () => {
    const { api, operations } = setup();
    const source = inline(oneRowCsv());
    const dry = await operations.prepare(baseInput(source));
    expect(dry.ok).toBe(true);
    const digest = dry.ok ? dry.value.approvedCommandDigest : undefined;
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const outcome = await operations.execute({ ...baseInput(source), approvedCommandDigest: digest, planHandle });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.created.filter(c => c.status === "created")).toHaveLength(1);
    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalled();
  });

  it("execute refuses without a plan handle (digest alone cannot execute)", async () => {
    const { api, operations } = setup();
    const source = inline(oneRowCsv());
    const dry = await operations.prepare(baseInput(source));
    const digest = dry.ok ? dry.value.approvedCommandDigest : undefined;
    const outcome = await operations.execute({ ...baseInput(source), approvedCommandDigest: digest, planHandle: undefined });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("plan_handle_required");
    expect(api.transactions.create).not.toHaveBeenCalled();
  });

  it("execute refuses a plan handle without the approved digest (approval separation)", async () => {
    const { api, operations } = setup();
    const source = inline(oneRowCsv());
    const dry = await operations.prepare(baseInput(source));
    const planHandle = dry.ok ? dry.value.planHandle : undefined;
    const outcome = await operations.execute({ ...baseInput(source), approvedCommandDigest: undefined, planHandle });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("digest_mismatch");
    expect(api.transactions.create).not.toHaveBeenCalled();
  });

  it("burns the plan handle on consume: a replayed execute is rejected by the store", async () => {
    const { operations } = setup();
    const source = inline(oneRowCsv());
    const dry = await operations.prepare(baseInput(source));
    const digest = dry.ok ? dry.value.approvedCommandDigest : undefined;
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const first = await operations.execute({ ...baseInput(source), approvedCommandDigest: digest, planHandle });
    expect(first.ok).toBe(true);
    // plan_store_error is a rich kind: it throws the typed carrier so the real
    // store code + message reach the presenter, rather than flattening to an
    // OperationOutcome error triple that would drop them.
    const replay = operations.execute({ ...baseInput(source), approvedCommandDigest: digest, planHandle });
    await expect(replay).rejects.toBeInstanceOf(WiseOperationFailedError);
    await replay.catch((error: unknown) => {
      expect(error).toBeInstanceOf(WiseOperationFailedError);
      const failure = (error as WiseOperationFailedError).failure;
      expect(failure.kind).toBe("plan_store_error");
    });
  });
});
