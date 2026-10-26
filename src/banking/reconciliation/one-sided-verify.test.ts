import { describe, expect, it, vi } from "vitest";
import { executeInterAccount, prepareInterAccount } from "./executor.js";
import { createTestRuntimeSafetyContext } from "../../__fixtures__/runtime-safety.js";
import { ONE_SIDED_MIN_CONFIDENCE, type OneSidedInference } from "./inter-account-matcher.js";
import type { ApiContext } from "../../tools/crud/shared.js";

vi.mock("../../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../progress.js", () => ({ reportProgress: vi.fn() }));

// Simulates a planner that lost the unregistered-IBAN hold (a regression, or a
// plan built under other rules): while `planning` is set, the matcher's
// inference drops COUNTERPARTY_IBAN_NOT_REGISTERED, so the plan books the row
// one-sided. Execute-time verification must still refuse it on its own.
const hooks = vi.hoisted(() => ({ planning: true }));
vi.mock("./inter-account-matcher.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./inter-account-matcher.js")>();
  return {
    ...actual,
    inferOneSidedTransfer: (...args: Parameters<typeof actual.inferOneSidedTransfer>): OneSidedInference => {
      const inference = actual.inferOneSidedTransfer(...args);
      return hooks.planning
        ? { ...inference, reasons: inference.reasons.filter(reason => reason !== actual.COUNTERPARTY_IBAN_NOT_REGISTERED) }
        : inference;
    },
  };
});

function setup() {
  const row = {
    id: 7, status: "PROJECT", is_deleted: false, type: "C", amount: 60, cl_currencies_id: "EUR", date: "2026-01-21",
    accounts_id: 1020, accounts_dimensions_id: 100, clients_id: 5,
    bank_account_name: "Test OÜ", bank_account_no: "EE471000001020145685",
  };
  let bankAccountReads = 0;
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue([row]),
      invalidateListCache: vi.fn(),
      get: vi.fn(async () => ({ ...row })),
      update: vi.fn(),
      confirm: vi.fn(async () => ({})),
      delete: vi.fn(),
    },
    saleInvoices: { listAll: vi.fn().mockResolvedValue([]), get: vi.fn(), invalidateListCache: vi.fn() },
    purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]), get: vi.fn(), invalidateListCache: vi.fn() },
    journals: { listAll: vi.fn().mockResolvedValue([]), listAllWithPostings: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() },
    clients: { findByName: vi.fn().mockResolvedValue([]) },
    readonly: {
      // Reads 1-2 are the dry-run and execute matching runs; read 3 is the
      // execute-time verification of the confirm command.
      getBankAccounts: vi.fn(async () => {
        bankAccountReads += 1;
        hooks.planning = bankAccountReads < 3;
        return [
          { id: 1, account_name_est: "LHV", account_no: "EE123456789012345678", iban_code: "EE123456789012345678", accounts_dimensions_id: 100 },
          { id: 2, account_name_est: "SEB", account_no: "EE987654321098765432", iban_code: "EE987654321098765432", accounts_dimensions_id: 200 },
        ];
      }),
      getAccountDimensions: vi.fn().mockResolvedValue([{ id: 100, accounts_id: 1020 }, { id: 200, accounts_id: 1020 }]),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Test OÜ" }),
    },
  };
  return { api: api as unknown as ApiContext, mocks: api };
}

describe("execute-time one-sided transfer verification", () => {
  it("refuses a planned one-sided transfer to an unregistered counterparty IBAN despite sufficient confidence", async () => {
    hooks.planning = true;
    const { api, mocks } = setup();
    const context = createTestRuntimeSafetyContext();
    const input = { maxDateGap: undefined, targetAccountsDimensionsId: undefined };
    const preview = await prepareInterAccount(api, context, input);
    // The (simulated) planner booked it one-sided at a confidence that passes the threshold.
    expect(preview.match.matchedOneSided).toEqual([expect.objectContaining({ transaction_id: 7 })]);
    expect(preview.match.matchedOneSided[0]!.confidence).toBeGreaterThanOrEqual(ONE_SIDED_MIN_CONFIDENCE);

    const result = await executeInterAccount(api, context, { ...input, planHandle: preview.planHandle });

    expect(mocks.readonly.getBankAccounts).toHaveBeenCalledTimes(3);
    expect(mocks.transactions.confirm).not.toHaveBeenCalled();
    expect(result.ok && result.data.match.matchedOneSided[0]!.status).toBe("not_confirmed");
  });
});
