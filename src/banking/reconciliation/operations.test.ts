import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBankReconciliationOperations } from "./operations.js";
import { ReconciliationOperationFailedError } from "./executor.js";
import { renderExactMatchPayload } from "./presenter.js";
import { MutationIndeterminateError } from "../../mutation-outcome.js";
import { createTestRuntimeSafetyContext } from "../../__fixtures__/runtime-safety.js";
import { withSignedCamtMarker } from "../../__fixtures__/camt-marker.js";

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
  date: "2026-01-10", accounts_dimensions_id: 9, accounts_id: 1020, cl_currencies_id: "EUR",
});
const matchingSale = () => ({
  id: 501, number: "INV-1", clients_id: 42, gross_price: 100, base_gross_price: 100,
  bank_ref_number: "REF1", payment_status: "NOT_PAID", status: "CONFIRMED", client_name: "Acme",
  cl_currencies_id: "EUR", sale_invoice_type: "INVOICE",
});

function setup(overrides: Record<string, unknown> = {}) {
  const confirm = vi.fn().mockResolvedValue({});
  const api = {
    transactions: {
      invalidateListCache: vi.fn(),
      listAll: vi.fn().mockResolvedValue([matchingTx()]),
      get: vi.fn().mockResolvedValue(matchingTx()),
      update: vi.fn().mockResolvedValue({}),
      confirm,
      delete: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([matchingSale()]) },
    purchaseInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([]) },
    journals: { invalidateListCache: vi.fn(), listAllWithPostings: vi.fn().mockResolvedValue([]) },
    clients: { findByName: vi.fn().mockResolvedValue([]) },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Test OÜ" }),
    },
    ...overrides,
  } as any;
  for (const resource of [api.saleInvoices, api.purchaseInvoices]) {
    resource.get ??= vi.fn(async (id: number) => (await resource.listAll()).find((row: any) => row.id === id));
  }
  const originalUpdate = api.transactions.update.getMockImplementation();
  const clientUpdates = new Map<number, number>();
  const originalGet = api.transactions.get.getMockImplementation();
  api.transactions.get.mockImplementation(async (id: number) => {
    const row = await originalGet(id);
    return clientUpdates.has(id) ? {...row, clients_id: clientUpdates.get(id)} : row;
  });
  api.transactions.update.mockImplementation(async (id: number, body: any) => {
    const result = await originalUpdate(id, body);
    if (body.clients_id != null) clientUpdates.set(id, body.clients_id);
    return result;
  });
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
  clients_id: PAYER_CLIENTS_ID, date: "2026-09-10", accounts_dimensions_id: 9, cl_currencies_id: "EUR",
});
const thirdPartySale = () => ({
  id: 501, number: "ARV-501", clients_id: INVOICE_CLIENTS_ID, gross_price: 1488.0,
  base_gross_price: 1488.0, bank_ref_number: "REF-1488",
  payment_status: "NOT_PAID", status: "CONFIRMED", client_name: "EIS", cl_currencies_id: "EUR",
});

function setupThirdPartyPayer() {
  return setup({
    transactions: {
      invalidateListCache: vi.fn(),
      listAll: vi.fn().mockResolvedValue([thirdPartyTx()]),
      get: vi.fn().mockResolvedValue(thirdPartyTx()),
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([thirdPartySale()]) },
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
  ref_number:txId===1?"REF1":"REF2",
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
      invalidateListCache: vi.fn(),
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
      invalidateListCache: vi.fn(),
      listAll: vi.fn().mockResolvedValue([matchingSale()]),
      get: vi.fn().mockResolvedValue({ ...matchingSale(), receivable_accounts_id: RECEIVABLE_ACCOUNT_ID }),
    },
    journals: { invalidateListCache: vi.fn(), listAllWithPostings: vi.fn().mockResolvedValue([registrationJournal(journalClientsId)]) },
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
      invalidateListCache: vi.fn(),
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
      invalidateListCache: vi.fn(),
      listAll: vi.fn().mockResolvedValue([matchingSale(), secondSale()]),
      get: vi.fn().mockImplementation(async (id: number) => {
        if (id === 501 && confirmedIds.has(1)) throw new Error("invoice read failed");
        if (id === 501) return {...matchingSale(), receivable_accounts_id: RECEIVABLE_ACCOUNT_ID};
        return { ...secondSale(), receivable_accounts_id: RECEIVABLE_ACCOUNT_ID };
      }),
    },
    journals: {
      invalidateListCache: vi.fn(),
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

  it("prepareInterAccount mints a plan handle by default but not with mintPlanHandles:false", async () => {
    const { operations, runtimeSafetyContext } = setup({
      journals: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([]), listAllWithPostings: vi.fn().mockResolvedValue([]) },
    });
    const before = runtimeSafetyContext.planStore.activeCount;
    const minted = await operations.prepareInterAccount({ maxDateGap: undefined, targetAccountsDimensionsId: undefined });
    expect(minted.ok && typeof minted.value.planHandle).toBe("string");
    expect(runtimeSafetyContext.planStore.activeCount).toBe(before + 1);

    const preview = await operations.prepareInterAccount({ maxDateGap: undefined, targetAccountsDimensionsId: undefined, mintPlanHandles: false });
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.value.planHandle).toBeUndefined();
    expect(runtimeSafetyContext.planStore.activeCount).toBe(before + 1);
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

  it("executeExactConfirm re-reads uncached before the gating projection and prepare hydrates transaction material", async () => {
    const { api, operations } = setup();
    const dry = await operations.prepareExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined });
    const planHandle = dry.ok ? dry.value.planHandle : undefined;
    expect(api.transactions.invalidateListCache).toHaveBeenCalled();
    for (const resource of [api.transactions, api.saleInvoices, api.purchaseInvoices, api.journals]) resource.invalidateListCache.mockClear();

    const outcome = await operations.executeExactConfirm({ minConfidence: 90, blockOnDuplicate: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    for (const resource of [api.transactions, api.saleInvoices, api.purchaseInvoices]) {
      expect(resource.invalidateListCache).toHaveBeenCalled();
      expect(resource.invalidateListCache.mock.invocationCallOrder[0]).toBeLessThan(resource.listAll.mock.invocationCallOrder.at(-1));
    }
    expect(api.journals.invalidateListCache).toHaveBeenCalledTimes(1);
    // The confirm command's own pre-mutation transaction read is uncached too.
    const lastInvalidate = api.transactions.invalidateListCache.mock.invocationCallOrder.at(-1);
    const lastGetBeforeConfirm = api.transactions.get.mock.invocationCallOrder
      .filter((order: number) => order < api.transactions.confirm.mock.invocationCallOrder[0]).at(-1);
    expect(lastInvalidate).toBeLessThan(lastGetBeforeConfirm);
    expect(lastInvalidate).toBeGreaterThan(api.transactions.listAll.mock.invocationCallOrder.at(-1));
  });

  it("executeInterAccount re-reads transactions and the journal guard snapshot uncached; prepare stays cached", async () => {
    const { api, operations } = setup({
      journals: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([]), listAllWithPostings: vi.fn().mockResolvedValue([]) },
    });
    const prepared = await operations.prepareInterAccount({ maxDateGap: undefined, targetAccountsDimensionsId: undefined });
    const planHandle = prepared.ok ? prepared.value.planHandle : undefined;
    expect(api.transactions.invalidateListCache).toHaveBeenCalled();
    api.transactions.invalidateListCache.mockClear();
    expect(api.journals.invalidateListCache).not.toHaveBeenCalled();
    const listCallsBefore = api.transactions.listAll.mock.calls.length;

    await operations.executeInterAccount({ maxDateGap: undefined, targetAccountsDimensionsId: undefined, planHandle });
    expect(api.transactions.invalidateListCache).toHaveBeenCalledTimes(2);
    expect(api.journals.invalidateListCache).toHaveBeenCalledTimes(1);
    const invalidateOrder = api.transactions.invalidateListCache.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(api.transactions.listAll.mock.invocationCallOrder[listCallsBefore]);
    expect(api.journals.invalidateListCache.mock.invocationCallOrder[0]).toBeLessThan(api.journals.listAll.mock.invocationCallOrder.at(-1));
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

  // --- ref_number_exact rule (live-shaped: type "C" + signed marker, payment_status "") ---
  const refRuleTx = () => withSignedCamtMarker({
    ...matchingTx(), type: "C", clients_id: null, cl_currencies_id: "EUR", description: "Payment INV-1",
  }, "CRDT");
  const refRuleSale = () => ({ ...matchingSale(), cl_currencies_id: "EUR", payment_status: "" });
  function setupRefRule(salesAtExecute: unknown[]) {
    const salesListAll = vi.fn()
      .mockResolvedValueOnce([refRuleSale()])
      .mockResolvedValue(salesAtExecute);
    return setup({
      transactions: {
        invalidateListCache: vi.fn(),
        listAll: vi.fn().mockResolvedValue([refRuleTx()]),
        get: vi.fn().mockResolvedValue(refRuleTx()),
        update: vi.fn().mockResolvedValue({}),
        confirm: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      saleInvoices: { invalidateListCache: vi.fn(), listAll: salesListAll },
    });
  }

  it("auto-confirms a ref_number_exact match at the default threshold, setting the client from the invoice", async () => {
    const { api, operations } = setupRefRule([refRuleSale()]);
    const dry = await operations.prepareExactConfirm({ minConfidence: undefined, blockOnDuplicate: undefined });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.value.projection.confirms.map(c => [c.transactionId, c.confidence, c.autoConfirmRule]))
      .toEqual([[1, 80, "ref_number_exact"]]);

    const executed = await operations.executeExactConfirm({ minConfidence: undefined, blockOnDuplicate: undefined, planHandle: dry.value.planHandle });
    expect(executed.ok).toBe(true);
    expect(api.transactions.update).toHaveBeenCalledWith(1, { clients_id: 42 });
    expect(api.transactions.confirm).toHaveBeenCalledWith(
      1, [{ related_table: "sale_invoices", related_id: 501, amount: 100 }], expect.objectContaining({ autoFixClientsId: false, expectedTransaction: expect.objectContaining({contract: "bank_transaction_material_v1"}), expectedLinkedInvoices: expect.any(Object) }),
    );
  });

  it("re-evaluates the ref_number_exact rule at execute: a second open invoice with the same reference is plan drift", async () => {
    const { api, operations } = setupRefRule([refRuleSale(), { ...refRuleSale(), id: 502, number: "INV-2", gross_price: 7, base_gross_price: 7 }]);
    const dry = await operations.prepareExactConfirm({ minConfidence: undefined, blockOnDuplicate: undefined });
    expect(dry.ok && dry.value.projection.confirms).toHaveLength(1);
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const executed = operations.executeExactConfirm({ minConfidence: undefined, blockOnDuplicate: undefined, planHandle });
    await expect(executed).rejects.toBeInstanceOf(ReconciliationOperationFailedError);
    await executed.catch((error: unknown) => {
      expect((error as ReconciliationOperationFailedError).failure.kind).toBe("plan_drift");
    });
    expect(api.transactions.update).not.toHaveBeenCalled();
    expect(api.transactions.confirm).not.toHaveBeenCalled();
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
        invalidateListCache: vi.fn(),
        listAll: vi.fn().mockResolvedValue([thirdPartyTx()]),
        get: vi.fn().mockResolvedValue(thirdPartyTx()),
        update: vi.fn().mockResolvedValue({}),
        confirm: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      saleInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([{ ...thirdPartySale(), payment_status: "PARTIALLY_PAID" }]) },
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
    expect(payload.summary.auto_confirmed).toBe(1);
    expect(payload.summary.error_count).toBe(1);
    expect(String(payload.errors[0]!.reason)).toContain("ledger_client_mismatch");
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
        invalidateListCache: vi.fn(),
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

// --- Document-reference candidates (okt 2026 finding 5) -----------------------
// A card payment's description names the cart number, not the invoice number;
// with no client or reference match the exact amount alone scores 40, below
// the suggestion default 50. Synthetic numbers only.
describe("suggestMatches document_reference_candidates (okt 2026 finding 5)", () => {
  const CART = "990011223344";
  const cardTx = (id: number, description: string) => withSignedCamtMarker({
    id, status: "PROJECT", is_deleted: false, type: "C",
    amount: 25.2, base_amount: 25.2, ref_number: null, clients_id: null,
    date: "2026-03-18", accounts_dimensions_id: 9, accounts_id: 1020, cl_currencies_id: "EUR",
    description, bank_account_name: null,
  }, "DBIT");
  const ticketInvoice = (id: number, notes: string | null, number = `99001122${id}`) => ({
    id, number, clients_id: 77, client_name: "Bussiliin OÜ", gross_price: 25.2, base_gross_price: 25.2,
    bank_ref_number: null, payment_status: "NOT_PAID", status: "CONFIRMED", cl_currencies_id: "EUR", notes,
  });
  // A second, independent row that does reach the exact-confirm set (95).
  const refTx = () => withSignedCamtMarker({
    id: 2, status: "PROJECT", is_deleted: false, type: "C",
    amount: 300, base_amount: 300, ref_number: "77123", clients_id: 88,
    date: "2026-03-18", accounts_dimensions_id: 9, accounts_id: 1020, cl_currencies_id: "EUR",
    description: "Rent", bank_account_name: null,
  }, "DBIT");
  const rentInvoice = () => ({
    id: 900, number: "RENT-03", clients_id: 88, client_name: "Landlord OÜ", gross_price: 300, base_gross_price: 300,
    bank_ref_number: "77123", payment_status: "NOT_PAID", status: "CONFIRMED", cl_currencies_id: "EUR", notes: null,
  });

  function setupDocRef(transactions: Array<{ id: number }>, purchases: unknown[]) {
    return setup({
      transactions: {
        invalidateListCache: vi.fn(),
        listAll: vi.fn().mockResolvedValue(transactions),
        get: vi.fn(async (id: number) => transactions.find(row => row.id === id)),
        update: vi.fn().mockResolvedValue({}),
        confirm: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      saleInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([]) },
      purchaseInvoices: { invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue(purchases) },
    });
  }

  async function suggest(transactions: Array<{ id: number }>, purchases: unknown[], minConfidence?: number) {
    const { operations, api } = setupDocRef(transactions, purchases);
    const outcome = await operations.suggestMatches({ minConfidence, blockOnDuplicate: undefined });
    if (!outcome.ok) throw new Error("suggest failed");
    expect(api.transactions.confirm).not.toHaveBeenCalled();
    return outcome.value;
  }

  it("ranks the invoice whose notes carry the cart number into matches with document_reference, below auto-confirm", async () => {
    const result = await suggest(
      [cardTx(7, `Kaardimakse 18.03.2026 ostukorv ${CART} Tallinn`)],
      [ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`)],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.best_match).toEqual(expect.objectContaining({
      id: 701, confidence: 70, match_reasons: ["exact_amount", "document_reference"],
    }));
    expect(result.matches[0]!.distribution).toEqual({ related_table: "purchase_invoices", related_id: 701, amount: 25.2 });
    expect(result.documentReferenceCandidates).toBeUndefined();
  });

  it("scores nothing extra without the notes line", async () => {
    const result = await suggest([cardTx(7, `Kaardimakse ostukorv ${CART}`)], [ticketInvoice(701, "Bus ticket")]);
    expect(result.matches).toEqual([]);
    expect(result.documentReferenceCandidates).toBeUndefined();
  });

  it("picks the invoice with this row's cart number among two same-amount invoices", async () => {
    const result = await suggest(
      [cardTx(7, `Kaardimakse ostukorv ${CART}`)],
      [ticketInvoice(702, "Ostukorvi/tellimuse nr: 990011225566"), ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`)],
      30,
    );
    expect(result.matches[0]!.best_match).toEqual(expect.objectContaining({ id: 701, confidence: 70 }));
    expect(result.matches[0]!.other_candidate_count).toBe(1);
    expect(result.documentReferenceCandidates).toBeUndefined();
  });

  it("also matches the invoice number itself as a whole token", async () => {
    const result = await suggest([cardTx(7, "Payment INV-2026-000431 card")], [ticketInvoice(701, null, "INV-2026-000431")]);
    expect(result.matches[0]!.best_match.match_reasons).toEqual(["exact_amount", "document_reference"]);
  });

  it("caps document_reference at 85 so it never reaches the 90 auto-confirm threshold", async () => {
    // exact_amount 40 + client_id 15 + document_reference 30 = 85 (cap).
    const tx = [{ ...cardTx(7, `Kaardimakse ostukorv ${CART}`), clients_id: 77 }];
    const result = await suggest(tx, [ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`)]);
    expect(result.matches[0]!.best_match).toEqual(expect.objectContaining({
      confidence: 85, match_reasons: ["exact_amount", "client_id", "document_reference"],
    }));
    expect((await suggest(tx, [ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`)], 86)).matches).toEqual([]);
    expect((await suggest(tx, [ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`)], 90)).matches).toEqual([]);
    // exact_amount 40 + ref_number 40 = 80; the document reference lifts it to
    // the cap 85, never to 100.
    const refRow = [{ ...cardTx(8, `Kaardimakse ostukorv ${CART}`), ref_number: "77123" }];
    const withRef = await suggest(refRow, [{ ...ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`), bank_ref_number: "77123" }]);
    expect(withRef.matches[0]!.best_match).toEqual(expect.objectContaining({
      confidence: 85, match_reasons: ["exact_amount", "ref_number", "document_reference"],
    }));
  });

  it("matches the cart number as a token, never as a substring", async () => {
    const purchases = [ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`)];
    for (const description of [`Kaardimakse ostukorv 9${CART}`, `Kaardimakse ostukorv ${CART}7`, `Kaardimakse ostukorvX${CART}`]) {
      const result = await suggest([cardTx(7, description)], purchases);
      expect(result.matches).toEqual([]);
      expect(result.documentReferenceCandidates).toBeUndefined();
    }
  });

  it("does not count a weak reference", async () => {
    const result = await suggest(
      [cardTx(7, "Kaardimakse ostukorv 12345 kuupäev 20260318")],
      [ticketInvoice(701, "Ostukorvi/tellimuse nr: 12345"), ticketInvoice(702, "Ostukorvi/tellimuse nr: 20260318")],
    );
    expect(result.matches).toEqual([]);
    expect(result.documentReferenceCandidates).toBeUndefined();
  });

  it("leaves an unrelated reference-number match unchanged", async () => {
    const tx = [cardTx(7, `Kaardimakse ostukorv ${CART}`), refTx()];
    const withLine = await suggest(tx, [ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`), rentInvoice()]);
    const withoutLine = await suggest(tx, [ticketInvoice(701, null), rentInvoice()]);
    expect(withLine.matches.find(row => row.transaction_id === 2)).toEqual(withoutLine.matches.find(row => row.transaction_id === 2));
    expect(withLine.matches.map(row => row.best_match.id)).toEqual([701, 900]);
    expect(withoutLine.matches.map(row => row.best_match.id)).toEqual([900]);
  });

  it("lists a document-reference invoice that a reference-number match outranked", async () => {
    // Invoice 900 carries the row's ref_number (40 + 40 = 80); invoice 701 only
    // the cart number in the description (40 + 30 = 70).
    const tx = [{ ...cardTx(7, `Kaardimakse ostukorv ${CART}`), ref_number: "77123" }];
    const result = await suggest(tx, [
      ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`),
      { ...rentInvoice(), clients_id: 99, gross_price: 25.2, base_gross_price: 25.2 },
    ]);
    expect(result.matches[0]!.best_match).toEqual(expect.objectContaining({ id: 900, confidence: 80 }));
    expect(result.documentReferenceCandidates).toEqual([expect.objectContaining({
      transaction_id: 7,
      matched_reference: CART,
      invoice: expect.objectContaining({ id: 701 }),
      match_reasons: ["exact_amount", "document_reference"],
    })]);
  });

  // Live 2026-10-30 (Seppo AI): two 25.20 Lux Express payments both best-matched
  // the older invoice; the second one's description is the newer invoice's cart number.
  it("splits two same-amount supplier payments by the cart number (live Lux Express case)", async () => {
    const luxTx = (id: number, date: string, description: string) => ({
      ...cardTx(id, description), date, bank_account_name: "Lux Express Estonia AS",
    });
    const luxInvoice = (id: number, number: string, notes: string) => ({
      ...ticketInvoice(id, notes, number), client_name: "AS Lux Express Estonia", payment_status: "",
    });
    const result = await suggest(
      [luxTx(14376580, "2026-10-18", "261018825247"), luxTx(14376588, "2026-10-25", "261025922842")],
      [luxInvoice(5577728, "261018890982", ""), luxInvoice(5581992, "261025943002", "Ostukorvi/tellimuse nr: 261025922842")],
      30,
    );
    const best = (id: number) => result.matches.find(row => row.transaction_id === id)!.best_match;
    expect(best(14376580)).toEqual(expect.objectContaining({ id: 5577728, confidence: 50, match_reasons: ["exact_amount", "client_name_partial"] }));
    expect(best(14376588)).toEqual(expect.objectContaining({
      id: 5581992, confidence: 80, match_reasons: ["exact_amount", "client_name_partial", "document_reference"],
    }));
    expect(result.documentReferenceCandidates).toBeUndefined();
  });

  it("reads transactions and invoices uncached, so a suggest sees an invoice created by another process", async () => {
    // Models the 120 s list cache: listAll serves the stale snapshot until the
    // resource's list cache is invalidated.
    const cachedResource = (stale: unknown[], live: unknown[]) => {
      let cached: unknown[] | undefined = stale;
      return {
        invalidateListCache: vi.fn(() => { cached = undefined; }),
        listAll: vi.fn(async () => cached ?? live),
      };
    };
    const tx = cardTx(7, `Kaardimakse ostukorv ${CART}`);
    const { operations } = setup({
      transactions: {
        ...cachedResource([], [tx]),
        get: vi.fn(async () => tx),
        update: vi.fn(), confirm: vi.fn(), delete: vi.fn(),
      },
      saleInvoices: cachedResource([], []),
      purchaseInvoices: cachedResource([], [ticketInvoice(701, `Ostukorvi/tellimuse nr: ${CART}`)]),
    });
    const outcome = await operations.suggestMatches({ minConfidence: undefined, blockOnDuplicate: undefined });
    if (!outcome.ok) throw new Error("suggest failed");
    expect(outcome.value.totalUnconfirmed).toBe(1);
    expect(outcome.value.matched).toBe(1);
    expect(outcome.value.matches[0]!.best_match.id).toBe(701);
  });

  it("keeps the auto-confirm set unchanged at the default and a custom threshold", async () => {
    const tx = [cardTx(7, `Kaardimakse ostukorv ${CART}`), refTx()];
    const line = `Ostukorvi/tellimuse nr: ${CART}`;
    // With vs without the notes line: one invoice, two invoices sharing the
    // cart number, and a partially paid invoice.
    const variants: Array<[unknown[], unknown[]]> = [
      [[ticketInvoice(701, line), rentInvoice()], [ticketInvoice(701, null), rentInvoice()]],
      [[ticketInvoice(701, line), ticketInvoice(702, line), rentInvoice()], [ticketInvoice(701, null), ticketInvoice(702, null), rentInvoice()]],
      [[{ ...ticketInvoice(701, line), payment_status: "PARTIALLY_PAID" }, rentInvoice()], [{ ...ticketInvoice(701, null), payment_status: "PARTIALLY_PAID" }, rentInvoice()]],
    ];
    for (const minConfidence of [undefined, 50, 80]) {
      const confirmIds = async (purchases: unknown[]) => {
        const { operations } = setupDocRef(tx, purchases);
        const outcome = await operations.prepareExactConfirm({ minConfidence, blockOnDuplicate: undefined });
        if (!outcome.ok) throw new Error("prepare failed");
        return outcome.value.projection.confirms.map(row => row.transactionId);
      };
      for (const [withLinePurchases, withoutLinePurchases] of variants) {
        const withLine = await confirmIds(withLinePurchases);
        expect(withLine).toEqual(await confirmIds(withoutLinePurchases));
        expect(withLine).toEqual([2]);
      }
    }
  });
});
