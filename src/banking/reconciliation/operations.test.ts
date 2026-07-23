import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBankReconciliationOperations } from "./operations.js";
import { ReconciliationOperationFailedError } from "./executor.js";
import { MutationIndeterminateError } from "../../mutation-outcome.js";
import { createTestRuntimeSafetyContext } from "../../__fixtures__/runtime-safety.js";

// The typed reconciliation operations are exercised through narrow api/plan
// ports — NOT a mock McpServer. This pins prepare (zero mutations, issue plan)
// → execute (consume plan) and the execution-safety gates: plan consume-once,
// plan_handle required, partial/indeterminate results, and audit truth.

const { mockedLogAudit } = vi.hoisted(() => ({ mockedLogAudit: vi.fn() }));
vi.mock("../../audit-log.js", () => ({ logAudit: mockedLogAudit }));
vi.mock("../../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

// One PROJECT transaction that exactly matches one open sale invoice:
// exact_amount (40) + ref_number (40) + client_id (15) = 95 >= 90.
const matchingTx = () => ({
  id: 1, status: "PROJECT", is_deleted: false, type: "D",
  amount: 100, base_amount: 100, ref_number: "REF1", clients_id: 42,
  date: "2026-01-10", accounts_dimensions_id: 9,
});
const matchingSale = () => ({
  id: 501, number: "INV-1", clients_id: 42, gross_price: 100, base_gross_price: 100,
  bank_ref_number: "REF1", payment_status: "NOT_PAID", status: "CONFIRMED", client_name: "Acme",
});

function setup(overrides: Record<string, unknown> = {}) {
  const confirm = vi.fn().mockResolvedValue({});
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue([matchingTx()]),
      get: vi.fn().mockResolvedValue(matchingTx()),
      update: vi.fn().mockResolvedValue({}),
      confirm,
      delete: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: { listAll: vi.fn().mockResolvedValue([matchingSale()]) },
    purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
    journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
    clients: { findByName: vi.fn().mockResolvedValue([]) },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Test OÜ" }),
    },
    ...overrides,
  } as any;
  const runtimeSafetyContext = createTestRuntimeSafetyContext();
  const operations = createBankReconciliationOperations(api, runtimeSafetyContext);
  return { api, operations, confirm };
}

describe("BankReconciliationOperations", () => {
  beforeEach(() => mockedLogAudit.mockClear());

  it("suggestMatches surfaces the best match with ZERO mutations", async () => {
    const { api, operations } = setup();
    const outcome = await operations.suggestMatches({ minConfidence: 50, blockOnDuplicate: undefined });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.matched).toBe(1);
      expect(outcome.value.matches).toHaveLength(1);
    }
    expect(api.transactions.confirm).not.toHaveBeenCalled();
    expect(api.transactions.update).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  it("prepareExactConfirm projects one confirm + a plan handle with ZERO mutations", async () => {
    const { api, operations } = setup();
    const outcome = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.projection.confirms).toHaveLength(1);
      expect(typeof outcome.value.planHandle).toBe("string");
    }
    expect(api.transactions.confirm).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  it("executeExactConfirm consumes the reviewed plan, confirms once, and audits it", async () => {
    const { api, operations } = setup();
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalled();
  });

  it("executeExactConfirm refuses without a plan handle (a handle is not approval, but it is required)", async () => {
    const { api, operations } = setup();
    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle: undefined });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("plan_handle_required");
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("burns the plan handle on consume: a replayed execute throws the typed store failure", async () => {
    const { operations } = setup();
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const first = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(first.ok).toBe(true);
    const replay = operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    await expect(replay).rejects.toBeInstanceOf(ReconciliationOperationFailedError);
    await replay.catch((error: unknown) => {
      const failure = (error as ReconciliationOperationFailedError).failure;
      expect(failure.kind).toBe("plan_store_error");
    });
  });

  it("stops at an indeterminate confirm without retrying (partial result)", async () => {
    const indeterminate = new MutationIndeterminateError({
      operation: "confirm", entity: "transaction", entityId: 1, businessKey: "tx-1",
      affectedCaches: [], cause: new Error("timeout"), nextAction: "Verify manually.",
    } as any);
    const { api, operations } = setup({
      transactions: {
        listAll: vi.fn().mockResolvedValue([matchingTx()]),
        get: vi.fn().mockResolvedValue(matchingTx()),
        update: vi.fn().mockResolvedValue({}),
        confirm: vi.fn().mockRejectedValue(indeterminate),
        delete: vi.fn().mockResolvedValue({}),
      },
    });
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;
    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const completed = outcome.value.executionReport.command_partitions.completed.map(c => c.command_id);
      expect(completed).not.toContain("recon-confirm-invoice-tx-1");
    }
    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
  });
});
