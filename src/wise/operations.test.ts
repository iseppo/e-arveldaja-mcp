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
