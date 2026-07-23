import { describe, it, expect } from "vitest";
import { camtResultRow, renderCamtImportCompact, type CamtImportRenderData } from "./presenter.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "../response-budget.js";
import { roundMoney } from "../money.js";
import type { CamtCreateDescriptor, CamtImportProjection, ParsedCamtEntry } from "./types.js";

// B2: the guided compact CAMT response must stay approximately CONSTANT in size
// as the clean-row count grows, and always fit under the batch response budget.
// Blockers are never hidden; at most three samples are inlined.

function cleanEntry(index: number): ParsedCamtEntry {
  return {
    date: "2026-02-01",
    amount: 10 + index,
    currency: "EUR",
    direction: "CRDT",
    counterparty_name: `Vendor ${index} OÜ`,
    counterparty_iban: "EE471000001020145685",
    description: `Statement row ${index}`,
    reference_number: `RF${index}`,
    bank_reference: `REF-${index}`,
    duplicate: false,
    duplicate_transaction_ids: [],
  };
}

function makeData(rows: number, errorCount = 0): CamtImportRenderData {
  const entries = Array.from({ length: rows }, (_, index) => cleanEntry(index));
  const creditTotal = roundMoney(entries.reduce((sum, entry) => sum + entry.amount, 0));
  const parsed = {
    statement_metadata: {
      statement_id: "stmt-1",
      iban: "EE637700771011212909",
      currency: "EUR",
      bank_name: "Test Bank",
      period: { from: "2026-02-01", to: "2026-02-28" },
    },
    entries,
    summary: { entry_count: rows, credit_count: rows, credit_total: creditTotal, debit_count: 0, debit_total: 0, duplicate_count: 0 },
  };
  const descriptors: CamtCreateDescriptor[] = entries.map((entry, index) => ({
    entry,
    payload: {
      accounts_dimensions_id: 7,
      type: "D",
      amount: entry.amount,
      cl_currencies_id: "EUR",
      date: entry.date,
    },
    clientResolution: {},
    possibleDuplicateMatches: [],
    batchDuplicateKey: `key-${index}`,
  }));
  const projection: CamtImportProjection = {
    parsed,
    statementMetadata: parsed.statement_metadata,
    descriptors,
    skipped: [],
    repeatedBankReferences: new Set<string>(),
    totalStatementEntries: rows,
    eligibleEntries: rows,
    filteredOut: 0,
  };
  return {
    projection,
    results: descriptors.map(descriptor => camtResultRow(descriptor, "would_create")),
    possibleDuplicates: [],
    createdCount: rows - errorCount,
    errorCount,
    workflowArgs: {},
    planHandle: "PLAN-HANDLE-XYZ",
  };
}

describe("renderCamtImportCompact", () => {
  it("stays approximately constant from 100 to 1000 clean rows and under the batch budget", () => {
    const bytes100 = mcpPayloadBytes(renderCamtImportCompact({ mode: "DRY_RUN", data: makeData(100) }));
    const bytes1000 = mcpPayloadBytes(renderCamtImportCompact({ mode: "DRY_RUN", data: makeData(1000) }));

    expect(Math.abs(bytes1000 - bytes100)).toBeLessThan(256);
    expect(bytes100).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
    expect(bytes1000).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
  });

  it("inlines at most three samples and surfaces direction totals + plan handle on dry run", () => {
    const { summary } = renderCamtImportCompact({ mode: "DRY_RUN", data: makeData(500) });
    expect(summary.samples).toHaveLength(3);
    expect(summary.plan_handle).toBe("PLAN-HANDLE-XYZ");
    expect(summary.totals?.credit_total).toBeGreaterThan(0);
    expect(summary.counts?.would_create).toBe(500);
  });

  it("carries the statement identity: raw IBAN + OCR-wrapped statement_id, and wraps sample bank_reference", () => {
    const { summary } = renderCamtImportCompact({ mode: "DRY_RUN", data: makeData(50) });
    const scope = summary.scope as Record<string, unknown>;
    expect(scope.account).toBe("EE637700771011212909");
    expect(scope.statement_id).toMatch(/UNTRUSTED_OCR_START/);
    expect(String(scope.statement_id)).toContain("stmt-1");
    const sample = summary.samples?.[0] as Record<string, unknown>;
    expect(sample.bank_reference).toMatch(/UNTRUSTED_OCR_START/);
    expect(String(sample.bank_reference)).toContain("REF-0");
  });

  it("never hides blockers: execution errors surface as a blocker and reference the result page", () => {
    const { summary } = renderCamtImportCompact({
      mode: "EXECUTED",
      data: makeData(300, 5),
      operationHandle: "op-handle-123",
    });
    expect(summary.blockers?.length).toBeGreaterThan(0);
    expect(summary.blockers?.[0]!.severity).toBe("blocker");
    expect(summary.details?.tool).toBe("get_operation_result_page");
    expect(summary.details?.args.operation_handle).toBe("op-handle-123");
  });
});
