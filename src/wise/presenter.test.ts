import { describe, it, expect } from "vitest";
import { renderWiseImportCompact, type WiseImportRenderData } from "./presenter.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "../response-budget.js";
import { roundMoney } from "../money.js";
import type { WiseCreatedEntry, WiseRow, WiseSkippedEntry } from "./types.js";

// B2: the guided compact Wise response must stay approximately CONSTANT in size
// as the clean-row count grows, and always fit under the batch response budget.
// Blockers (execution errors) are never hidden; at most three samples inline.

function cleanRow(index: number): WiseRow {
  return {
    rowIndex: index,
    id: `WISE-${index}`,
    status: "COMPLETED",
    direction: "OUT",
    createdOn: "2026-02-01 10:00:00",
    finishedOn: "2026-02-01 10:00:00",
    sourceFeeAmount: 0,
    sourceFeeCurrency: "EUR",
    targetFeeAmount: 0,
    targetFeeCurrency: "EUR",
    sourceName: "MyCo OÜ",
    sourceAmount: 10 + index,
    sourceCurrency: "EUR",
    targetName: `Vendor ${index} OÜ`,
    targetAmount: 10 + index,
    targetCurrency: "EUR",
    exchangeRate: 1,
    reference: `RF-${index}`,
    category: "General",
    note: "",
  };
}

function cleanCreated(index: number): WiseCreatedEntry {
  const row = cleanRow(index);
  return {
    wise_id: `WISE-${index}`,
    date: "2026-02-01",
    type: "C",
    source_direction: "OUT",
    amount: 10 + index,
    description: `WISE:WISE-${index} Vendor ${index} OÜ [source_direction=OUT]`,
    status: "would_create",
    source_row: row,
  };
}

function makeData(rows: number, mode: "DRY_RUN" | "EXECUTED" = "DRY_RUN", errorCount = 0): WiseImportRenderData {
  const created = Array.from({ length: rows }, (_, index) => cleanCreated(index));
  const skipped: WiseSkippedEntry[] = Array.from({ length: errorCount }, (_, index) => ({
    wise_id: `TRANSFER-${index}`,
    reason: `Inter-account confirmation failed: upstream rejected ${index}`,
  }));
  return {
    mode,
    executeRequested: mode === "EXECUTED",
    source: { file_path: "/statements/wise.csv" },
    sourceIdentity: {
      schema: "file_input_identity_v1",
      source_kind: "path",
      digest_sha256: "a".repeat(64),
      size_bytes: 1234,
      extension: ".csv",
    } as WiseImportRenderData["sourceIdentity"],
    accountsDimensionsId: 5,
    totalCsvRows: rows,
    eligibleCount: rows,
    skippedJarCount: 0,
    skippedJarRows: [],
    created,
    skipped,
    commands: [],
    approvedCommandDigest: "d".repeat(64),
    planHandle: "PLAN-HANDLE-XYZ",
    autoDetectedInterAccountDimId: undefined,
    hasHintedRows: false,
    interAccountResults: [],
    ownershipReviews: [],
    invoiceFixCandidates: [],
    args: {
      feeAccountDimensionsId: undefined,
      feeAccountRelationId: undefined,
      interAccountDimensionId: undefined,
      confirmOwnTransferIds: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      skipJarTransfers: undefined,
    },
  };
}

describe("renderWiseImportCompact", () => {
  it("stays approximately constant from 100 to 1000 clean rows and under the batch budget", () => {
    const bytes100 = mcpPayloadBytes(renderWiseImportCompact({ mode: "DRY_RUN", data: makeData(100) }));
    const bytes1000 = mcpPayloadBytes(renderWiseImportCompact({ mode: "DRY_RUN", data: makeData(1000) }));

    expect(Math.abs(bytes1000 - bytes100)).toBeLessThan(256);
    expect(bytes100).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
    expect(bytes1000).toBeLessThan(RESPONSE_BUDGETS.batch.hard);
  });

  it("inlines at most three samples and surfaces IN/OUT totals + plan handle on dry run", () => {
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data: makeData(500) });
    expect(summary.samples).toHaveLength(3);
    expect(summary.plan_handle).toBe("PLAN-HANDLE-XYZ");
    expect(summary.totals?.out_total).toBe(roundMoney(Array.from({ length: 500 }, (_, i) => 10 + i).reduce((a, b) => a + b, 0)));
    expect(summary.counts?.would_create).toBe(500);
    // Free-form CSV fields are OCR-sandbox-wrapped in the samples.
    const sample = summary.samples?.[0] as Record<string, unknown>;
    expect(sample.counterparty).toMatch(/UNTRUSTED_OCR_START/);
    expect(sample.reference).toMatch(/UNTRUSTED_OCR_START/);
  });

  it("carries the statement identity: Wise dimension account + OCR-wrapped source file", () => {
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data: makeData(50) });
    const scope = summary.scope as Record<string, unknown>;
    expect(scope.account).toBe("5");
    expect(String((scope.source_documents as string[])[0])).toMatch(/UNTRUSTED_OCR_START/);
  });

  it("never hides blockers: execution errors surface as a blocker and reference the result page", () => {
    const { summary } = renderWiseImportCompact({
      mode: "EXECUTED",
      data: makeData(300, "EXECUTED", 5),
      operationHandle: "op-handle-123",
    });
    expect(summary.blockers?.length).toBeGreaterThan(0);
    expect(summary.blockers?.[0]!.severity).toBe("blocker");
    expect(summary.details?.tool).toBe("get_operation_result_page");
    expect(summary.details?.args.operation_handle).toBe("op-handle-123");
  });
});
