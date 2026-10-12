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

  it("surfaces advisory invoice FX corrections as warnings (never applied, never dropped)", () => {
    const data = makeData(1);
    const advisory = {
      row_index: 0, wise_id: "WISE-0", date: "2026-02-01", supplier_name: "Vendor 0 OÜ",
      target_amount: 20, target_currency: "USD", source_amount_eur: 17.07, wise_currency_rate: 0.8535,
      invoice_id: 700, invoice_number: "USD-700", invoice_currency: "USD", invoice_gross: 20,
      category: "foreign_currency_lock" as const,
      proposed_action: "Advisory, not applied: lock invoice USD-700 to Wise rate: base_gross_price 17.10 → 17.07 EUR, currency_rate → 0.8535.",
      proposed_correction: { currency_rate: 0.8535, base_gross_price: 17.07 },
      current_object_state: {} as never,
    };
    data.invoiceFixCandidates = [
      { ...advisory, result: "advisory" },
      { ...advisory, invoice_id: 701, result: "ambiguous_skipped" },
    ];
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });
    expect(summary.warnings).toEqual([
      { item_id: "WISE-0", code: "wise_invoice_currency_advisory", message: advisory.proposed_action },
    ]);
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

describe("renderWiseImportCompact — automatic matches", () => {
  it("itemises each automatic match with the stored row / journal and an undo hint, never as a plain duplicate", () => {
    const data = makeData(1);
    data.skipped = [
      ...Array.from({ length: 4 }, (_, index) => ({
        wise_id: `CARD_TRANSACTION-${index}`,
        reason: `Already imported (wise_untagged_ledger_unique): confirmed transaction ${500 + index} without a WISE: tag is the only stored row of this movement on this Wise account; no Wise bank row created`,
        auto_match: { code: "wise_untagged_ledger_unique" as const, transaction_id: 500 + index },
      })),
      {
        wise_id: "TRANSFER-9",
        reason: "Already journalized (wise_transfer_journal_unique_legacy): inter-account journal 7100 is the only same-amount journal within one day and books exactly this transfer; no Wise bank row created",
        auto_match: { code: "wise_transfer_journal_unique_legacy" as const, journal_id: 7100 },
      },
      {
        wise_id: "FEE-TRANSFER-9",
        reason: "Fee already journalized: inter-account journal 7100 books this transfer net of the fee",
        auto_match: { code: "wise_transfer_journal_unique_legacy" as const, journal_id: 7100 },
      },
      { wise_id: "TRANSFER-1", reason: "Already imported" },
    ];
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });
    expect(summary.counts).toMatchObject({ skipped: 7, duplicates: 1, auto_matched: 6, errors: 0 });
    const untagged = summary.warnings?.filter(w => w.code === "wise_untagged_ledger_unique") ?? [];
    expect(untagged.map(w => w.item_id)).toEqual(["CARD_TRANSACTION-0", "CARD_TRANSACTION-1", "CARD_TRANSACTION-2"]);
    expect(untagged[0]!.message).toContain("If wrong: if it is a different movement, correct or delete transaction 500, then re-run the preview.");
    expect(summary.warnings?.find(w => w.code === "wise_untagged_ledger_unique_more")?.message)
      .toMatch(/^1 more wise_untagged_ledger_unique item\(s\) not shown; .*get_execution_plan_page.*PLAN-HANDLE-XYZ.*exclusions/);
    const legacy = summary.warnings?.filter(w => w.code === "wise_transfer_journal_unique_legacy") ?? [];
    expect(legacy.map(w => w.message.split(":")[0])).toEqual(["Row not created", "Fee row not created"]);
    expect(legacy[0]!.message).toContain("correct or delete journal 7100");
  });
});

describe("renderWiseImportCompact — totals currency", () => {
  function foreignCreated(index: number): WiseCreatedEntry {
    const entry = cleanCreated(index);
    return {
      ...entry,
      source_row: { ...entry.source_row!, sourceCurrency: "USD", targetCurrency: "USD" },
    };
  }

  it("labels in_total / out_total when every summed row shares a currency", () => {
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data: makeData(3) });
    expect(summary.totals?.currency).toBe("EUR");
    expect((summary.warnings ?? []).some(w => w.code === "mixed_currency_totals")).toBe(false);
  });

  // 100 USD + 50 EUR used to render as an unlabelled in_total of 150 on the
  // approval card. The ledger is unaffected, but this is the figure the operator
  // approves against.
  it("does not label a total that adds up more than one currency, and says so", () => {
    const data = makeData(2);
    const mixed = { ...data, created: [...data.created, foreignCreated(99)] };
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data: mixed });

    expect(summary.totals?.currency).toBeUndefined();
    const warning = (summary.warnings ?? []).find(w => w.code === "mixed_currency_totals");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("EUR");
    expect(warning!.message).toContain("USD");
  });
});

describe("renderWiseImportCompact — fee rows vote on the totals currency", () => {
  // Fee entries are synthesised: they carry no source_row to read a currency
  // from, yet source_direction "OUT" puts them in out_total. Without their own
  // booked_currency they were summed silently, unable to change the label or
  // trigger the mixed warning.
  it("counts a fee row booked in another currency as a currency disagreement", () => {
    const data = makeData(2);
    const feeEntry: WiseCreatedEntry = {
      wise_id: "FEE:WISE-0",
      date: "2026-02-01",
      type: "C",
      source_direction: "OUT",
      amount: 1.5,
      description: "WISE:FEE:WISE-0 fee [source_direction=OUT]",
      status: "would_create",
      booked_currency: "USD",
    };
    const { summary } = renderWiseImportCompact({
      mode: "DRY_RUN",
      data: { ...data, created: [...data.created, feeEntry] },
    });

    expect(summary.totals?.currency).toBeUndefined();
    const warning = (summary.warnings ?? []).find(w => w.code === "mixed_currency_totals");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("USD");
  });
});
