import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBankReconciliationOperations } from "./operations.js";
import { ReconciliationOperationFailedError } from "./executor.js";
import { renderExactMatchPayload } from "./presenter.js";
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
  date: "2026-01-10", accounts_dimensions_id: 9, accounts_id: 1020,
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
  return { api, operations, confirm, runtimeSafetyContext };
}

// --- Third-party payer (EIS case, verified live) ------------------------------
// Rahandusministeerium (2309260) paid an invoice that belongs to EIS (2327264).
// exact_amount (40) + ref_number (40) = 80 and no client_id points, so 80 is the
// threshold at which the row reaches the exact-confirm set at all.
const THIRD_PARTY_THRESHOLD = 80;
const PAYER_CLIENTS_ID = 2309260;
const INVOICE_CLIENTS_ID = 2327264;

const thirdPartyTx = () => ({
  id: 1210, status: "PROJECT", is_deleted: false, type: "D",
  amount: 1488.0, base_amount: 1488.0, ref_number: "REF-1488",
  clients_id: PAYER_CLIENTS_ID, date: "2026-09-10", accounts_dimensions_id: 9,
});
const thirdPartySale = () => ({
  id: 501, number: "ARV-501", clients_id: INVOICE_CLIENTS_ID, gross_price: 1488.0,
  base_gross_price: 1488.0, bank_ref_number: "REF-1488",
  payment_status: "NOT_PAID", status: "CONFIRMED", client_name: "EIS",
});

function setupThirdPartyPayer() {
  return setup({
    transactions: {
      listAll: vi.fn().mockResolvedValue([thirdPartyTx()]),
      get: vi.fn().mockResolvedValue(thirdPartyTx()),
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: { listAll: vi.fn().mockResolvedValue([thirdPartySale()]) },
  });
}

// --- Post-confirm ledger check -----------------------------------------------
// The register call returns no journal id and copies journal.clients_id from the
// TRANSACTION, so the invariant can only be asserted by re-reading the ledger.

const LEDGER_TX_ID = 1;
const BANK_ACCOUNT_ID = 1020;
const BANK_DIMENSION_ID = 9;
const RECEIVABLE_ACCOUNT_ID = 1210;

const registrationJournal = (clientsId: number, txId: number = LEDGER_TX_ID) => ({
  id: 28013080 + txId,
  operation_type: "TRANSACTION",
  operations_id: txId,
  clients_id: clientsId,
  registered: true,
  is_deleted: false,
  postings: [
    { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 100, is_deleted: false },
    { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "C", amount: 100, is_deleted: false },
  ],
});

/** A registered transaction as the ledger check re-reads it: the invoice link
 * and its EUR amount live on the items. */
const confirmedTxWithInvoiceItem = (txId: number, invoiceId: number) => ({
  ...matchingTx(),
  id: txId,
  status: "CONFIRMED",
  accounts_id: BANK_ACCOUNT_ID,
  accounts_dimensions_id: BANK_DIMENSION_ID,
  items: [{ relation_table: "sale_invoices", relation_id: invoiceId, amount: 100, base_amount: 100 }],
});

/** Exact-match setup whose confirmed transaction carries the invoice link the
 * ledger check reads, plus a controllable registration journal. */
function setupLedgerCheck(journalClientsId: number) {
  let confirmed = false;
  const confirm = vi.fn().mockImplementation(async () => {
    confirmed = true;
    return {};
  });
  return setup({
    transactions: {
      listAll: vi.fn().mockResolvedValue([matchingTx()]),
      // Before the confirm the command's prepare() must still see a PROJECT row;
      // afterwards the ledger check reads the registered row and its items.
      get: vi.fn().mockImplementation(async () => (confirmed
        ? confirmedTxWithInvoiceItem(LEDGER_TX_ID, 501)
        : matchingTx())),
      update: vi.fn().mockResolvedValue({}),
      confirm,
      delete: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue([matchingSale()]),
      get: vi.fn().mockResolvedValue({ ...matchingSale(), receivable_accounts_id: RECEIVABLE_ACCOUNT_ID }),
    },
    journals: { listAllWithPostings: vi.fn().mockResolvedValue([registrationJournal(journalClientsId)]) },
  });
}

/** Two confirmable matches; the first transaction's invoice read rejects so the
 * per-transaction scoping of the ledger check can be pinned. */
function setupTwoTxLedgerCheck() {
  // Tracked per id: each confirm command's prepare() must still see ITS OWN row
  // as PROJECT, so a single shared flag would drift the second command.
  const confirmedIds = new Set<number>();
  const secondTx = () => ({ ...matchingTx(), id: 2, ref_number: "REF2" });
  const secondSale = () => ({ ...matchingSale(), id: 502, number: "INV-2", bank_ref_number: "REF2" });
  return setup({
    transactions: {
      listAll: vi.fn().mockResolvedValue([matchingTx(), secondTx()]),
      get: vi.fn().mockImplementation(async (id: number) => (confirmedIds.has(id)
        ? confirmedTxWithInvoiceItem(id, id === LEDGER_TX_ID ? 501 : 502)
        : (id === LEDGER_TX_ID ? matchingTx() : secondTx()))),
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockImplementation(async (id: number) => {
        confirmedIds.add(id);
        return {};
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue([matchingSale(), secondSale()]),
      get: vi.fn().mockImplementation(async (id: number) => {
        if (id === 501) throw new Error("invoice read failed");
        return { ...secondSale(), receivable_accounts_id: RECEIVABLE_ACCOUNT_ID };
      }),
    },
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue([registrationJournal(42, 1), registrationJournal(42, 2)]),
    },
  });
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

  it("routes a third-party payer to review instead of confirming it, and says so in the plan", async () => {
    const { api, operations, runtimeSafetyContext } = setupThirdPartyPayer();
    const dry = await operations.prepareExactConfirm({ minConfidence: THIRD_PARTY_THRESHOLD, blockOnDuplicate: undefined });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;

    expect(dry.value.projection.confirms).toEqual([]);
    expect(dry.value.projection.thirdPartyPayerReviews).toHaveLength(1);
    const review = dry.value.projection.thirdPartyPayerReviews[0]!;
    expect(review.reason).toBe("third_party_payer");
    expect(review.transaction_clients_id).toBe(PAYER_CLIENTS_ID);
    expect(review.invoice_clients_id).toBe(INVOICE_CLIENTS_ID);

    const plan = runtimeSafetyContext.planStore.inspect(dry.value.planHandle, "bank_reconciliation");
    expect(plan.reviews).toHaveLength(1);
    expect(plan.counts.third_party_payer_reviews).toBe(1);
    expect(plan.counts.would_confirm).toBe(0);
    expect(plan.commands).toEqual([]);

    const executed = await operations.executeExactConfirm({
      minConfidence: THIRD_PARTY_THRESHOLD, blockOnDuplicate: undefined, planHandle: dry.value.planHandle,
    });
    expect(executed.ok).toBe(true);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
    expect(api.transactions.update).not.toHaveBeenCalled();
  });

  it("flags a differing payer for manual review on the read-only suggest surface", async () => {
    const { operations } = setupThirdPartyPayer();
    const outcome = await operations.suggestMatches({ minConfidence: 50, blockOnDuplicate: undefined });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(String(outcome.value.matches[0]!.manual_review_required)).toContain(String(INVOICE_CLIENTS_ID));
  });

  it("keeps every manual-review note on a row that is both third-party paid and partially paid", async () => {
    const { operations } = setup({
      transactions: {
        listAll: vi.fn().mockResolvedValue([thirdPartyTx()]),
        get: vi.fn().mockResolvedValue(thirdPartyTx()),
        update: vi.fn().mockResolvedValue({}),
        confirm: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      saleInvoices: { listAll: vi.fn().mockResolvedValue([{ ...thirdPartySale(), payment_status: "PARTIALLY_PAID" }]) },
    });

    const outcome = await operations.suggestMatches({ minConfidence: 50, blockOnDuplicate: undefined });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const note = String(outcome.value.matches[0]!.manual_review_required);
    expect(note).toContain(String(INVOICE_CLIENTS_ID));
    expect(note).toContain("PARTIALLY_PAID");
  });

  it("reports a wrong-client registration journal as a ledger-check failure on a confirmed transaction", async () => {
    const { api, operations } = setupLedgerCheck(999);
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
    // ONE journals read for the whole batch, taken after the confirms.
    expect(api.journals.listAllWithPostings).toHaveBeenCalledTimes(1);
    expect(outcome.value.ledgerChecks.checked).toBe(1);
    expect(outcome.value.ledgerChecks.ok).toBe(0);
    expect(outcome.value.ledgerChecks.failures).toHaveLength(1);
    const failure = outcome.value.ledgerChecks.failures[0]!;
    expect(failure.transaction_id).toBe(LEDGER_TX_ID);
    expect(failure.code).toBe("ledger_client_mismatch");
    expect(failure.journal_id).toBe(28013080 + LEDGER_TX_ID);
    expect(mockedLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "LEDGER_CHECK_FAILED" }));

    // The failure reaches the envelope as an error, never hidden under the
    // successful confirm count.
    const payload = renderExactMatchPayload({
      mode: "EXECUTED",
      projection: outcome.value.projection,
      executionReport: outcome.value.executionReport,
      ledgerChecks: outcome.value.ledgerChecks,
    });
    expect((payload.summary as Record<string, unknown>).auto_confirmed).toBe(1);
    expect((payload.summary as Record<string, unknown>).error_count).toBe(1);
    expect(String((payload.errors as Array<Record<string, unknown>>)[0]!.reason)).toContain("ledger_client_mismatch");
  });

  it("passes the ledger check when the registration journal carries the invoice client", async () => {
    const { operations } = setupLedgerCheck(42);
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.ledgerChecks).toEqual({ checked: 1, ok: 1, failures: [] });
    expect(mockedLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "LEDGER_CHECK_FAILED" }));
  });

  it("keeps checking the rest of the batch when one transaction's invoice read fails", async () => {
    const { operations, api } = setupTwoTxLedgerCheck();
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(api.transactions.confirm).toHaveBeenCalledTimes(2);
    expect(outcome.value.ledgerChecks.checked).toBe(2);
    expect(outcome.value.ledgerChecks.ok).toBe(1);
    expect(outcome.value.ledgerChecks.failures).toEqual([]);
    expect(outcome.value.ledgerChecks.warnings).toHaveLength(1);
    expect(outcome.value.ledgerChecks.warnings![0]).toContain("transaction 1");
  });

  it("degrades a failed ledger re-read to a warning without failing the completed confirm", async () => {
    const { operations, api } = setupLedgerCheck(42);
    api.journals.listAllWithPostings = vi.fn().mockRejectedValue(new Error("network"));
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.ledgerChecks.failures).toEqual([]);
    expect(outcome.value.ledgerChecks.warnings).toHaveLength(1);
    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
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
