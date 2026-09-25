import { describe, it, expect } from "vitest";
import {
  renderSuggestCompact,
  renderExactMatchCompact,
  renderExactMatchPayload,
  renderInterAccountCompact,
  renderSuspects,
} from "./presenter.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "../../response-budget.js";
import { roundMoney } from "../../money.js";
import { reconInvoiceConfirmCommandId } from "../../tools/bank-reconciliation-plan.js";
import type { PlanExecutionReport } from "../../plan-execution.js";
import type {
  ExactConfirmDescriptor,
  ExactConfirmLedgerChecks,
  ExactMatchProjection,
  InterAccountMatchResult,
  PairResult,
  ReconciliationSuggestions,
} from "./types.js";
import type { DuplicatePostingSuspect } from "../../bank-posting-duplicate-guard.js";

// B2 (source-spec 2.3): the guided compact reconciliation response must include
// EVERY approval-summary field, stay approximately CONSTANT in byte size as the
// clean-row count grows, and NEVER hide blockers/errors. Untrusted free-text is
// OCR-sandbox-wrapped. The compact surface OMITS clean match rows (samples ≤ 3).

const OCR = /UNTRUSTED_OCR_START/;

// --- Suggest fixtures --------------------------------------------------------

function suggestRow(index: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: index,
    date: "2026-03-01",
    amount: 100 + index,
    description: `Payment ${index}`,
    bank_account_name: `Client ${index} OÜ`,
    ref_number: `RF${index}`,
    best_match: { type: "sale_invoice", id: 1000 + index, number: `INV-${index}`, client_name: `Client ${index}`, confidence: 95 },
    other_candidate_count: 0,
    ...extra,
  };
}

function makeSuggestions(rows: number, extraRows: Record<string, unknown>[] = []): ReconciliationSuggestions {
  const matches = [...Array.from({ length: rows }, (_, index) => suggestRow(index)), ...extraRows];
  const total = roundMoney(matches.reduce((sum, row) => sum + (row.amount as number), 0));
  return {
    totalUnconfirmed: matches.length,
    matched: matches.length,
    unmatched: 0,
    matches,
    compact: { matchedTotalsByCurrency: { EUR: total }, accountLabels: ["7"], dateFrom: "2026-03-01", dateTo: "2026-03-15" },
  };
}

const suspect: DuplicatePostingSuspect = {
  journal_id: 555,
  journal_title: "Injected <title>",
  date: "2026-03-01",
  amount: 100,
  direction: "D",
} as DuplicatePostingSuspect;

// --- Exact-match fixtures ----------------------------------------------------

function confirmDescriptor(index: number, extra: Partial<ExactConfirmDescriptor> = {}): ExactConfirmDescriptor {
  return {
    transactionId: index,
    date: "2026-03-02",
    amount: 50 + index,
    currency: "EUR",
    clientsId: 5,
    invoiceType: "purchase_invoice",
    invoiceTable: "purchase_invoices",
    invoiceId: 900 + index,
    invoiceNumber: `OST-${index}`,
    invoiceClientsId: 5,
    confidence: 99,
    clientResolution: "unchanged",
    needsClientUpdate: false,
    accountsDimensionsId: 7,
    direction: "C",
    baseAmount: 50 + index,
    ...extra,
  };
}

function makeExactProjection(rows: number, extra: Partial<ExactMatchProjection> = {}): ExactMatchProjection {
  return {
    totalUnconfirmed: rows,
    confirms: Array.from({ length: rows }, (_, index) => confirmDescriptor(index)),
    skipped: [],
    thirdPartyPayerReviews: [],
    blockedDuplicateSuspects: [],
    ...extra,
  };
}

const thirdPartyReview = {
  transaction_id: 1210,
  date: "2026-09-10",
  amount: 1488,
  currency: "EUR",
  invoice_type: "sale_invoice" as const,
  invoice_id: 77,
  invoice_number: "ARV-<77>",
  transaction_clients_id: 2309260,
  invoice_clients_id: 2327264,
  confidence: 95,
  reason: "third_party_payer" as const,
  next_action: "Review the payer",
};

const ledgerChecks: ExactConfirmLedgerChecks = {
  checked: 1,
  ok: 0,
  failures: [{
    transaction_id: 1,
    journal_id: 28013080,
    code: "ledger_client_mismatch",
    details: {
      transaction_id: 1,
      transaction_clients_id: 2309260,
      invoice_clients_id: 2327264,
      invoice_table: "sale_invoices",
      invoice_id: 77,
      journal_id: 28013080,
    },
  }],
};

function executionReport(completedTxIds: number[], stopTxId?: number): PlanExecutionReport {
  return {
    contract: "plan_execution_report_v1",
    status: stopTxId === undefined ? "completed" : "partial_execution",
    command_partitions: {
      completed: completedTxIds.map(id => ({ command_id: reconInvoiceConfirmCommandId(id), category: "reconcile_confirm_invoice" })),
      skipped: [],
      failed: stopTxId === undefined ? [] : [{ command_id: reconInvoiceConfirmCommandId(stopTxId), category: "reconcile_confirm_invoice" }],
      indeterminate: [],
      not_attempted: [],
    },
    known_object_ids: [],
    mutation_may_have_occurred: true,
    automatic_retry_forbidden: true,
    fresh_preview_required: stopTxId !== undefined,
    stop_reason: stopTxId === undefined
      ? null
      : { command_id: reconInvoiceConfirmCommandId(stopTxId), category: "mutation_failed", code: "mutation_failed" },
  };
}

// --- Inter-account fixtures --------------------------------------------------

function pair(index: number): PairResult {
  return {
    outgoing_transaction_id: index,
    incoming_transaction_id: 10000 + index,
    amount: 200 + index,
    date_out: "2026-03-03",
    date_in: "2026-03-03",
    from_account: "LHV",
    to_account: "Wise",
    from_dimension_id: 7,
    to_dimension_id: 8,
    description_out: `Transfer <${index}>`,
    description_in: `Received <${index}>`,
    confidence: 100,
    match_reasons: ["reciprocal"],
    status: "would_confirm",
    incoming_action: "would_delete_duplicate",
  };
}

function makeInterAccount(rows: number, extra: Partial<InterAccountMatchResult> = {}): InterAccountMatchResult {
  const matchedPairs = Array.from({ length: rows }, (_, index) => pair(index));
  return {
    totalUnconfirmed: rows * 2,
    invoiceInfo: { invoice_company_name: "Näidis OÜ" },
    dimensionToIban: new Map([[7, "EE001"], [8, "EE002"]]),
    dimensionToTitle: new Map([[7, "LHV"], [8, "Wise"]]),
    dimensionToAccountsId: new Map([[7, 1020], [8, 1020]]),
    matchedPairs,
    matchedOneSided: [],
    ambiguousPairs: [],
    skippedAlreadyHandled: [],
    ambiguousRefless: [],
    crossCurrencyPairs: [],
    errors: [],
    confirmActions: matchedPairs.map(p => ({
      confirmedTxId: p.outgoing_transaction_id,
      confirmedClientsId: null,
      confirmedNominalAmount: p.amount,
      confirmedCurrency: "EUR",
      targetDimensionId: 8,
      distributionAmount: p.amount,
      deleteTxId: p.incoming_transaction_id,
      auditSummary: "confirmed",
      auditDetails: {},
    })),
    companyClientsId: null,
    normalizedArgs: {},
    fingerprint: "fp",
    ...extra,
  };
}

// ============================================================================

describe("renderSuggestCompact", () => {
  it("stays approximately constant from 100 to 1000 clean rows and under the batch budget", () => {
    const bytes100 = mcpPayloadBytes(renderSuggestCompact(makeSuggestions(100)));
    const bytes1000 = mcpPayloadBytes(renderSuggestCompact(makeSuggestions(1000)));
    expect(Math.abs(bytes1000 - bytes100)).toBeLessThan(256);
    expect(bytes100).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
    expect(bytes1000).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
  });

  it("carries every 2.3 approval-summary field and OMITS clean rows (≤3 samples)", () => {
    const { summary } = renderSuggestCompact(makeSuggestions(500), { connectionName: "Näidis" });
    // contract + partial/indeterminate state
    expect(summary.contract).toBe("operation_summary_v1");
    expect(summary.status).toBe("needs_review");
    // object counts by type + duplicates + errors/unresolved
    expect(summary.counts?.total_unconfirmed).toBe(500);
    expect(summary.counts?.matched).toBe(500);
    expect(summary.counts?.unmatched).toBe(0);
    expect(summary.counts?.duplicates).toBe(0);
    expect(summary.counts?.needs_review).toBe(0);
    // financial totals with currencies
    expect(Number(summary.totals?.EUR)).toBeGreaterThan(0);
    // scope: connection + affected account + date range
    const scope = summary.scope as Record<string, unknown>;
    expect(scope.connection).toBe("Näidis");
    expect(scope.account).toBe("7");
    expect((scope.period as Record<string, unknown>).from).toBe("2026-03-01");
    expect((scope.period as Record<string, unknown>).to).toBe("2026-03-15");
    // clean rows omitted — at most 3 samples
    expect(summary.samples?.length).toBe(3);
    // the exact approval action (suggest → run the dry-run confirm)
    expect(summary.next_action?.tool).toBe("reconcile_bank_transactions");
    expect(summary.next_action?.approval_required).toBe(true);
  });

  it("wraps untrusted counterparty + invoice number in samples", () => {
    const { summary } = renderSuggestCompact(makeSuggestions(3));
    const sample = summary.samples?.[0] as Record<string, unknown>;
    expect(String(sample.counterparty)).toMatch(OCR);
    expect(String((sample.match as Record<string, unknown>).number)).toMatch(OCR);
  });

  it("counts duplicates + surfaces manual-review items as warnings", () => {
    const data = makeSuggestions(2, [
      suggestRow(900, { possible_duplicate_postings: [suspect] }),
      suggestRow(901, { manual_review_required: "Cross-currency match: verify manually." }),
    ]);
    const { summary } = renderSuggestCompact(data);
    expect(summary.counts?.duplicates).toBe(1);
    expect(summary.counts?.needs_review).toBe(1);
    expect(summary.warnings?.some(w => w.code === "manual_review_required")).toBe(true);
  });
});

describe("renderExactMatchCompact", () => {
  it("stays approximately constant from 100 to 1000 clean confirms", () => {
    const bytes100 = mcpPayloadBytes(renderExactMatchCompact({ mode: "DRY_RUN", projection: makeExactProjection(100), planHandle: "PLAN-A" }));
    const bytes1000 = mcpPayloadBytes(renderExactMatchCompact({ mode: "DRY_RUN", projection: makeExactProjection(1000), planHandle: "PLAN-A" }));
    expect(Math.abs(bytes1000 - bytes100)).toBeLessThan(256);
    expect(bytes1000).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
  });

  it("dry run carries every 2.3 field + plan_handle approval action, ≤3 samples, wrapped invoice number", () => {
    const { summary } = renderExactMatchCompact({ mode: "DRY_RUN", projection: makeExactProjection(400), planHandle: "PLAN-XYZ", connectionName: "Näidis" });
    expect(summary.status).toBe("ready_for_approval");
    expect(summary.plan_handle).toBe("PLAN-XYZ");
    expect(summary.counts?.would_confirm).toBe(400);
    expect(summary.counts?.skipped).toBe(0);
    expect(summary.counts?.duplicates).toBe(0);
    expect(summary.counts?.errors).toBe(0);
    expect(Number(summary.totals?.EUR)).toBeGreaterThan(0);
    const scope = summary.scope as Record<string, unknown>;
    expect(scope.connection).toBe("Näidis");
    expect(scope.account).toBe("7");
    expect((scope.period as Record<string, unknown>).from).toBe("2026-03-02");
    expect(summary.samples?.length).toBe(3);
    expect(String((summary.samples?.[0] as Record<string, unknown>).match && ((summary.samples?.[0] as Record<string, unknown>).match as Record<string, unknown>).number)).toMatch(OCR);
  });

  it("NEVER hides blockers: a partial execute surfaces a blocker + references the result page", () => {
    const projection = makeExactProjection(3);
    // txs 0,1 completed; tx 2 failed (stop).
    const report = executionReport([0, 1], 2);
    const { summary } = renderExactMatchCompact({ mode: "EXECUTED", projection, executionReport: report, operationHandle: "op-99", connectionName: "Näidis" });
    expect(summary.status).toBe("partial");
    expect(summary.counts?.confirmed).toBe(2);
    expect(summary.counts?.errors).toBe(1);
    expect(summary.blockers?.length).toBeGreaterThan(0);
    expect(summary.blockers?.[0]!.severity).toBe("blocker");
    expect(summary.details?.tool).toBe("get_operation_result_page");
    expect(summary.details?.args.operation_handle).toBe("op-99");
  });

  it("clean execute completes and references the result page", () => {
    const projection = makeExactProjection(2);
    const report = executionReport([0, 1]);
    const { summary } = renderExactMatchCompact({ mode: "EXECUTED", projection, executionReport: report, operationHandle: "op-ok" });
    expect(summary.status).toBe("completed");
    expect(summary.counts?.confirmed).toBe(2);
    expect(summary.counts?.errors).toBe(0);
    expect(summary.blockers?.length ?? 0).toBe(0);
    expect(summary.details?.args.operation_handle).toBe("op-ok");
  });

  it("counts blocked-duplicate suspects and surfaces them as warnings", () => {
    const projection = makeExactProjection(0, {
      blockedDuplicateSuspects: [{ transaction_id: 42, reason: "Possible cross-mechanism duplicate", conflicting_journal_ids: [555], suspects: [suspect] }],
    });
    const { summary } = renderExactMatchCompact({ mode: "DRY_RUN", projection, planHandle: "P" });
    expect(summary.counts?.blocked_duplicates).toBe(1);
    expect(summary.counts?.duplicates).toBe(1);
    expect(summary.warnings?.some(w => w.code === "blocked_duplicate_suspect")).toBe(true);
  });

  it("surfaces third-party-payer reviews as counted warnings, not as confirms", () => {
    const projection = makeExactProjection(0, { thirdPartyPayerReviews: [thirdPartyReview] });
    const { summary } = renderExactMatchCompact({ mode: "DRY_RUN", projection, planHandle: "P" });
    expect(summary.counts?.third_party_payer_reviews).toBe(1);
    expect(summary.counts?.would_confirm).toBe(0);
    const warning = summary.warnings?.find(w => w.code === "third_party_payer");
    expect(warning?.item_id).toBe("1210");
    expect(warning?.message).toContain("2327264");
  });

  it("reports a broken post-confirm ledger invariant as a blocker on an otherwise clean execute", () => {
    const projection = makeExactProjection(1);
    const { summary } = renderExactMatchCompact({
      mode: "EXECUTED",
      projection,
      executionReport: executionReport([0]),
      ledgerChecks,
      operationHandle: "op-led",
    });
    expect(summary.counts?.confirmed).toBe(1);
    expect(summary.counts?.errors).toBe(1);
    expect(summary.status).toBe("partial");
    const blocker = summary.blockers?.find(b => b.code === "ledger_client_mismatch");
    expect(blocker?.severity).toBe("blocker");
    expect(blocker?.message).toContain("IS confirmed");
    // The generic "did not complete" blocker must NOT fire: the confirm ran.
    expect(summary.blockers?.some(b => b.code === "confirm_incomplete")).toBe(false);
  });
});

describe("renderExactMatchPayload", () => {
  it("renders third-party-payer reviews with a wrapped invoice number and counts them in the summary", () => {
    const projection = makeExactProjection(0, { thirdPartyPayerReviews: [thirdPartyReview] });
    const payload = renderExactMatchPayload({ mode: "DRY_RUN", projection, planHandle: "P" });
    const reviews = payload.third_party_payer_reviews as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(1);
    expect(String(reviews[0]!.invoice_number)).toMatch(OCR);
    expect(reviews[0]!.reason).toBe("third_party_payer");
    expect((payload.summary as Record<string, unknown>).third_party_payer_reviews).toBe(1);
    expect(payload.results).toEqual([]);
    // The reviewed rows also reach the batch contract's needs_review slot.
    expect(((payload.execution as Record<string, unknown>).needs_review as unknown[])).toHaveLength(1);
  });

  it("reports ledger-check failures as errors alongside the confirmed result", () => {
    const projection = makeExactProjection(1);
    const payload = renderExactMatchPayload({
      mode: "EXECUTED",
      projection,
      executionReport: executionReport([0]),
      ledgerChecks,
    });
    expect((payload.results as Array<Record<string, unknown>>)[0]!.status).toBe("confirmed");
    const errors = payload.errors as Array<Record<string, unknown>>;
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.reason)).toContain("ledger_client_mismatch");
    expect(String(errors[0]!.reason)).toContain("journal 28013080");
    expect((payload.summary as Record<string, unknown>).error_count).toBe(1);
    expect(payload.ledger_checks).toBe(ledgerChecks);
  });

  it("surfaces an unavailable ledger check as a warning, not an error", () => {
    const projection = makeExactProjection(1);
    const payload = renderExactMatchPayload({
      mode: "EXECUTED",
      projection,
      executionReport: executionReport([0]),
      ledgerChecks: { checked: 0, ok: 0, failures: [], warnings: ["ledger read failed"] },
    });
    expect(payload.errors).toEqual([]);
    expect(payload.warnings).toEqual(["ledger read failed"]);
  });
});

describe("renderInterAccountCompact", () => {
  it("stays approximately constant from 100 to 1000 clean pairs", () => {
    const bytes100 = mcpPayloadBytes(renderInterAccountCompact({ mode: "DRY_RUN", match: makeInterAccount(100), planHandle: "P" }));
    const bytes1000 = mcpPayloadBytes(renderInterAccountCompact({ mode: "DRY_RUN", match: makeInterAccount(1000), planHandle: "P" }));
    expect(Math.abs(bytes1000 - bytes100)).toBeLessThan(256);
    expect(bytes1000).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
  });

  it("dry run carries every 2.3 field incl. company scope, currency totals, counts by type, ≤3 wrapped samples", () => {
    const { summary } = renderInterAccountCompact({ mode: "DRY_RUN", match: makeInterAccount(50), planHandle: "PLAN-IA", connectionName: "Näidis" });
    expect(summary.status).toBe("ready_for_approval");
    expect(summary.plan_handle).toBe("PLAN-IA");
    expect(summary.counts?.matched_pairs).toBe(50);
    expect(summary.counts?.matched_one_sided).toBe(0);
    expect(summary.counts?.duplicates).toBe(0);
    expect(summary.counts?.needs_review_ambiguous_refless).toBe(0);
    expect(summary.counts?.needs_review_cross_currency).toBe(0);
    expect(summary.counts?.errors).toBe(0);
    expect(Number(summary.totals?.EUR)).toBeGreaterThan(0);
    const scope = summary.scope as Record<string, unknown>;
    expect(scope.connection).toBe("Näidis");
    expect(scope.company).toBe("Näidis OÜ");
    expect(String(scope.account)).toContain("LHV");
    expect((scope.period as Record<string, unknown>).from).toBe("2026-03-03");
    expect(summary.samples?.length).toBe(3);
    expect(String((summary.samples?.[0] as Record<string, unknown>).description_out)).toMatch(OCR);
  });

  it("NEVER hides blockers: a stopped execute surfaces a blocker + references the result page", () => {
    const match = makeInterAccount(2);
    const report: PlanExecutionReport = {
      contract: "plan_execution_report_v1",
      status: "partial_execution",
      command_partitions: { completed: [], skipped: [], failed: [], indeterminate: [], not_attempted: [] },
      known_object_ids: [],
      mutation_may_have_occurred: true,
      automatic_retry_forbidden: true,
      fresh_preview_required: true,
      stop_reason: { command_id: "recon-confirm-transfer-tx-1", category: "mutation_failed", code: "mutation_failed" },
    };
    const { summary } = renderInterAccountCompact({ mode: "EXECUTED", match, executionReport: report, operationHandle: "op-ia" });
    expect(summary.status).toBe("partial");
    expect(summary.blockers?.length).toBeGreaterThan(0);
    expect(summary.blockers?.[0]!.severity).toBe("blocker");
    expect(summary.details?.tool).toBe("get_operation_result_page");
    expect(summary.details?.args.operation_handle).toBe("op-ia");
  });

  it("counts already-handled transfers as duplicates and surfaces unresolved items as warnings", () => {
    const match = makeInterAccount(1, {
      skippedAlreadyHandled: [{ transaction_id: 71, amount: 10, date: "2026-03-03", source_account: "LHV", existing_journal_id: 900, reason: "Already journalized" }],
      ambiguousRefless: [{ transaction_ids: [72, 73], amount: 10, date: "2026-03-03", source_account: "LHV", target_account: "Wise", reason: "ambiguous refless" }],
    });
    const { summary } = renderInterAccountCompact({ mode: "DRY_RUN", match, planHandle: "P" });
    expect(summary.counts?.duplicates).toBe(1);
    expect(summary.counts?.needs_review_ambiguous_refless).toBe(1);
    expect(summary.warnings?.some(w => w.code === "ambiguous_refless")).toBe(true);
  });
});

describe("renderSuspects untrusted text", () => {
  it("sandboxes document_number alongside journal_title, keeping null as null", () => {
    const base: DuplicatePostingSuspect = {
      journal_id: 1, journal_title: "t", document_number: "IGNORE PREVIOUS", operation_type: null,
      date: "2026-01-01", amount: 1, type: "C", dimension_id: 1, day_distance: 0,
    };
    const [wrapped, empty] = renderSuspects([base, { ...base, document_number: null }]);
    expect(wrapped!.document_number).toMatch(OCR);
    expect(wrapped!.journal_title).toMatch(OCR);
    expect(empty!.document_number).toBeNull();
  });
});
