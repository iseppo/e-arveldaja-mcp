import { describe, it, expect } from "vitest";
import {
  renderSuggestCompact,
  renderExactMatchCompact,
  renderInterAccountCompact,
} from "./presenter.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "../../response-budget.js";
import { roundMoney } from "../../money.js";
import { reconInvoiceConfirmCommandId } from "../../tools/bank-reconciliation-plan.js";
import type { PlanExecutionReport } from "../../plan-execution.js";
import type {
  ExactConfirmDescriptor,
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
    blockedDuplicateSuspects: [],
    ...extra,
  };
}

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
