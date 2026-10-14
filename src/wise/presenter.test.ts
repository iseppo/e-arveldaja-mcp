import { describe, it, expect } from "vitest";
import { renderWiseImportCompact, renderWiseImportFull, type WiseImportRenderData } from "./presenter.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "../response-budget.js";
import { roundMoney } from "../money.js";
import type { WiseAlreadyJournalizedAssertion, WiseCreatedEntry, WiseImportCommand, WiseRow, WiseSkippedEntry } from "./types.js";
import { parseMcpResponse } from "../mcp-json.js";

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
    // One write command: the default preview is approvable (a zero-command
    // dry run has nothing to approve).
    commands: [{ action: "main_create" } as WiseImportCommand],
    alreadyJournalized: [],
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
      target_amount: 20, target_currency: "USD", source_amount_eur: 17.07, wise_currency_rate: 1.171646,
      invoice_id: 700, invoice_number: "USD-700", invoice_currency: "USD", invoice_gross: 20,
      category: "foreign_currency_lock" as const,
      proposed_action: "Advisory, not applied: lock invoice USD-700 to Wise rate: base_gross_price 17.10 → 17.07 EUR, currency_rate → 1.171646.",
      proposed_correction: { currency_rate: 1.171646, base_gross_price: 17.07 },
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

  it("keeps automatic matches and counts every omission when 90 ownership reviews push the summary over the budget", () => {
    const data = makeData(1);
    data.ownershipReviews = Array.from({ length: 90 }, (_, index) => ({
      wise_id: `TRANSFER-${1000 + index}`,
      code: "wise_transfer_dimensions_unverified" as const,
      reason: "The Wise transfer between own accounts could not be verified against a bank dimension: the counterpart account is not configured. Book it manually after checking both statements.",
    }));
    data.skipped = Array.from({ length: 4 }, (_, index) => ({
      wise_id: `CARD_TRANSACTION-${index}`,
      reason: `Already imported (wise_untagged_ledger_unique): confirmed transaction ${500 + index} without a WISE: tag is the only stored row of this movement on this Wise account; no Wise bank row created`,
      auto_match: { code: "wise_untagged_ledger_unique" as const, transaction_id: 500 + index },
    }));
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });
    expect(mcpPayloadBytes(summary)).toBeLessThanOrEqual(RESPONSE_BUDGETS.batch.target);
    const codes = summary.warnings?.map(w => w.code) ?? [];
    expect(codes.filter(code => code === "wise_untagged_ledger_unique").length).toBeGreaterThan(0);
    expect(summary.warnings?.find(w => w.code === "wise_untagged_ledger_unique_more")?.message).toMatch(/^1 more /);
    const kept = codes.filter(code => code === "wise_transfer_dimensions_unverified").length;
    expect(kept).toBeLessThan(90);
    const truncated = summary.warnings?.find(w => w.code === "warnings_truncated");
    expect(truncated?.message).toContain(`wise_transfer_dimensions_unverified: ${90 - kept}`);
    expect(truncated?.message).toContain("PLAN-HANDLE-XYZ");
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

describe("renderWiseImportFull — already-journalized rows", () => {
  function assertion(index: number, journalId: number): WiseAlreadyJournalizedAssertion {
    return {
      row_index: index, row_key: `row:${index}:inter_account`, wise_id: `TRANSFER-${index}`, date: "2026-07-19",
      booked_amount: 100, booked_currency: "EUR", source_direction: "OUT", ownership_basis: "verified_endpoints",
      existing_journal_id: journalId, current_journal_state: {},
    };
  }

  function slimData(mode: "DRY_RUN" | "EXECUTED"): WiseImportRenderData {
    const data = makeData(0, mode);
    const skipped: WiseSkippedEntry[] = [
      { wise_id: "TRANSFER-1", reason: "Already journalized: inter-account journal 501 books this transfer; no Wise bank row created" },
      { wise_id: "TRANSFER-2", reason: "Already journalized: inter-account journal 502 books this transfer; no Wise bank row created" },
      { wise_id: "CARD-1", reason: "Already imported (Wise ID match)" },
      { wise_id: "ODD-1", reason: "Unsupported Wise direction \"NEUTRAL\"" },
      { wise_id: "FEE:X", reason: "Skipped because main transaction was not created" },
    ];
    return { ...data, commands: [], alreadyJournalized: [assertion(1, 501), assertion(2, 502)], skipped };
  }

  const render = (data: WiseImportRenderData) => parseMcpResponse(renderWiseImportFull(data).content[0]!.text) as any;

  it("dry run: already-journalized rows are a compact table, not commands; already-booked skips are omitted, others stay itemised", () => {
    const out = render(slimData("DRY_RUN"));
    expect(out.execution.commands).toEqual([]);
    expect(out.execution.already_journalized_count).toBe(2);
    expect(out.execution.already_journalized_rows).toEqual([
      expect.objectContaining({ existing_journal_id: 501, date: "2026-07-19", booked_amount: 100, booked_currency: "EUR", source_direction: "OUT" }),
      expect.objectContaining({ existing_journal_id: 502 }),
    ]);
    expect(out.execution.already_journalized_commands).toBeUndefined();
    expect(out.execution.already_journalized_note).toMatch(/^Not part of the approved commands: no writes\./);
    // Validated identifiers are emitted raw.
    expect(out.execution.already_journalized_rows[0].wise_id).not.toMatch(/UNTRUSTED_OCR_START/);
    expect(out.execution.skipped.map((entry: any) => entry.wise_id)).toEqual(["ODD-1", "FEE:X"]);
    expect(out.execution.skipped_displayed).toBe(2);
    expect(out.execution.skipped_omitted_already_booked).toBe(3);
    expect(out.command_count).toBe(0);
    expect(out.summary.skipped).toBe(5);
  });

  it("executed run lists every write command and every skipped row; the re-check results are in inter_account_reconciliation", () => {
    const data = slimData("EXECUTED");
    data.interAccountResults = [
      { wise_id: "TRANSFER-1", amount: 100, status: "already_journalized", ownership_basis: "verified_endpoints", journal_id: 501 },
      { wise_id: "TRANSFER-2", amount: 100, status: "already_journalized", ownership_basis: "verified_endpoints", journal_id: 502 },
    ];
    const out = render(data);
    expect(out.execution.commands).toEqual([]);
    expect(out.execution.already_journalized_rows).toBeUndefined();
    expect(out.execution.skipped).toHaveLength(5);
    expect(out.execution.skipped_omitted_already_booked).toBeUndefined();
    expect(out.inter_account_reconciliation).toMatchObject({ total: 2, already_journalized: 2, confirmed: 0 });
  });
});

describe("renderWiseImportCompact — zero-write preview", () => {
  function zeroWriteData(autoMatches: number): WiseImportRenderData {
    const data = makeData(0);
    return {
      ...data,
      commands: [],
      approvedCommandDigest: undefined,
      planHandle: undefined,
      skipped: [
        ...Array.from({ length: autoMatches }, (_, index) => ({
          wise_id: `TRANSFER-${index}`,
          reason: `Already journalized (wise_transfer_journal_unique_legacy): inter-account journal ${700 + index} is the only same-amount journal within one day and books exactly this transfer; no Wise bank row created`,
          auto_match: { code: "wise_transfer_journal_unique_legacy" as const, journal_id: 700 + index },
        })),
        { wise_id: "CARD-1", reason: "Already imported (Wise ID match)" },
      ],
    };
  }

  it("is completed with a nothing-to-approve message, no next_action or plan handle, and a date-narrowing hint for more automatic matches", () => {
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data: zeroWriteData(5) });
    expect(summary.status).toBe("completed");
    expect(summary.message).toBe("Nothing to approve: the Wise dry run found no rows to write (6 already booked: 5 already journalized, 1 already imported); no plan handle was issued.");
    expect(summary.next_action).toBeUndefined();
    expect(summary.plan_handle).toBeUndefined();
    const legacy = summary.warnings?.filter(w => w.code === "wise_transfer_journal_unique_legacy") ?? [];
    expect(legacy).toHaveLength(3);
    const more = summary.warnings?.find(w => w.code === "wise_transfer_journal_unique_legacy_more")?.message ?? "";
    expect(more).toMatch(/^2 more /);
    expect(more).toContain("date_from/date_to");
    expect(more).not.toContain("get_execution_plan_page");
  });

  it("needs review when an ownership review is open", () => {
    const data = zeroWriteData(5);
    data.ownershipReviews = [{
      wise_id: "TRANSFER-77",
      code: "wise_transfer_dimensions_unverified",
      reason: "The Wise transfer between own accounts could not be verified against a bank dimension.",
    }];
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });
    expect(summary.status).toBe("needs_review");
    expect(summary.next_action).toBeUndefined();
  });

  it("a preview with write commands stays ready_for_approval", () => {
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data: makeData(1) });
    expect(summary.status).toBe("ready_for_approval");
  });
});

describe("renderWiseImportCompact — dry-run status ladder", () => {
  const review = (wiseId: string, code: "wise_transfer_dimensions_unverified" | "wise_transfer_journal_ambiguous") => ({
    wise_id: wiseId,
    code,
    reason: `reason for ${wiseId}`,
    source_verified: false,
    target_verified: false,
    approval_required: false,
  });

  it("rows held for their counterpart are needs_review with ONE collapsed warning (no blocker), keeping next_action and plan_handle", () => {
    const data = makeData(2);
    const held = (wiseId: string) => ({ ...review(wiseId, "wise_transfer_dimensions_unverified"), counterpart_candidate_dimension_ids: [20, 30] });
    data.ownershipReviews = [held("TRANSFER-1"), held("TRANSFER-2")];
    data.transferCounterpart = {
      unresolved_row_count: 2,
      conflict_row_count: 0,
      candidates: [
        { accounts_dimensions_id: 20, label: "LHV Own Account" },
        { accounts_dimensions_id: 30, label: "Lightyear" },
      ],
    };
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });

    expect(summary.status).toBe("needs_review");
    expect(summary.next_action?.args).toMatchObject({ plan_handle: "PLAN-HANDLE-XYZ" });
    expect(summary.plan_handle).toBe("PLAN-HANDLE-XYZ");
    expect(summary.counts?.needs_review).toBe(2);
    expect(summary.blockers ?? []).toHaveLength(0);
    const counterpartWarnings = (summary.warnings ?? []).filter(w => w.code === "wise_transfer_counterpart_unresolved");
    expect(counterpartWarnings).toHaveLength(1);
    const warning = counterpartWarnings[0]!;
    expect(warning.item_id).toBe("wise-import");
    expect(warning.message).toMatch(/<<UNTRUSTED_OCR_START:[0-9a-f]+>>\nLHV Own Account\n<<UNTRUSTED_OCR_END:[0-9a-f]+>> \(20\)/);
    expect(warning.message).toContain("(30)");
    expect(warning.message).toContain("Pass inter_account_dimension_id, or import the other bank's statement first");
    expect(summary.warnings?.some(w => w.code === "wise_transfer_dimensions_unverified") ?? false).toBe(false);
  });

  it("write commands plus an open review are needs_review and keep next_action and plan_handle", () => {
    const data = makeData(1);
    data.ownershipReviews = [review("TRANSFER-9", "wise_transfer_journal_ambiguous")];
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });

    expect(summary.status).toBe("needs_review");
    expect(summary.next_action?.args).toMatchObject({ plan_handle: "PLAN-HANDLE-XYZ" });
    expect(summary.plan_handle).toBe("PLAN-HANDLE-XYZ");
    expect(summary.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "wise_transfer_journal_ambiguous" })]));
  });
});

describe("renderWiseImportCompact — disjoint skip counts", () => {
  function legacyAndLabelledData(mode: "DRY_RUN" | "EXECUTED"): WiseImportRenderData {
    const data = makeData(1, mode);
    const legacy = (id: string, journalId: number): WiseSkippedEntry => ({
      wise_id: id,
      reason: `Already journalized (wise_transfer_journal_unique_legacy): inter-account journal ${journalId} is the only same-amount journal within one day and books exactly this transfer; no Wise bank row created`,
      auto_match: { code: "wise_transfer_journal_unique_legacy", journal_id: journalId },
    });
    const labelled = (id: string, journalId: number): WiseSkippedEntry => ({
      wise_id: id,
      reason: `Already journalized: inter-account journal ${journalId} books this transfer; no Wise bank row created`,
    });
    const assertion = (id: string, journalId: number) => ({ wise_id: id, existing_journal_id: journalId }) as unknown as WiseAlreadyJournalizedAssertion;
    data.skipped = [
      legacy("TRANSFER-L1", 701), legacy("TRANSFER-L2", 702),
      labelled("TRANSFER-J1", 801), labelled("TRANSFER-J2", 802),
      { wise_id: "CARD-1", reason: "Already imported (Wise ID match)" },
    ];
    data.alreadyJournalized = mode === "DRY_RUN"
      ? [assertion("TRANSFER-L1", 701), assertion("TRANSFER-L2", 702), assertion("TRANSFER-J1", 801), assertion("TRANSFER-J2", 802)]
      : [];
    data.interAccountResults = mode === "EXECUTED"
      ? ["TRANSFER-L1", "TRANSFER-L2", "TRANSFER-J1", "TRANSFER-J2"].map((id, index) => ({
          wise_id: id, amount: 100, status: "already_journalized", ownership_basis: "verified_endpoints", journal_id: 700 + index,
        }))
      : [];
    return data;
  }

  for (const mode of ["DRY_RUN", "EXECUTED"] as const) {
    it(`${mode}: skipped = duplicates + auto_matched + already_journalized`, () => {
      const { summary } = renderWiseImportCompact({ mode, data: legacyAndLabelledData(mode) });
      const counts = summary.counts as Record<string, number>;
      expect(counts).toMatchObject({ skipped: 5, duplicates: 1, auto_matched: 2, already_journalized: 2 });
      expect(counts.duplicates! + counts.auto_matched! + counts.already_journalized!).toBe(counts.skipped);
    });
  }
});

describe("already-journalized automatic matches: standard and guided labels", () => {
  // 31 already-journalized rows, 10 of them legacy automatic matches.
  function data(): WiseImportRenderData {
    const base = makeData(0);
    const ids = Array.from({ length: 31 }, (_, index) => `TRANSFER-${index}`);
    return {
      ...base,
      commands: [],
      approvedCommandDigest: undefined,
      planHandle: undefined,
      skipped: ids.map((id, index) => index < 10
        ? {
            wise_id: id,
            reason: `Already journalized (wise_transfer_journal_unique_legacy): inter-account journal ${700 + index} is the only same-amount journal within one day and books exactly this transfer; no Wise bank row created`,
            auto_match: { code: "wise_transfer_journal_unique_legacy" as const, journal_id: 700 + index },
          }
        : { wise_id: id, reason: `Already journalized: inter-account journal ${700 + index} books this transfer; no Wise bank row created` }),
      alreadyJournalized: ids.map((id, index) => ({ wise_id: id, existing_journal_id: 700 + index }) as unknown as WiseAlreadyJournalizedAssertion),
    };
  }

  it("standard counts all 31 and names the 10 automatic matches", () => {
    const out = parseMcpResponse(renderWiseImportFull(data()).content[0]!.text) as any;
    expect(out.execution.already_journalized_count).toBe(31);
    expect(out.execution.already_journalized_auto_matched_count).toBe(10);
    expect(out.execution.already_journalized_note).toContain("already_journalized_auto_matched_count");
  });

  it("guided keeps the disjoint split: 21 already journalized + 10 auto_matched", () => {
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data: data() });
    expect(summary.counts).toMatchObject({ already_journalized: 21, auto_matched: 10 });
  });
});

describe("Wise acknowledged_journal_holds round trip (compact and full)", () => {
  const acknowledgement = [{ wise_id: "TRANSFER-ACK", journal_ids: [801, 802] }];

  it("the guided next_action and the standard execute args carry the acknowledgement; a release is info, not a review", () => {
    const data = makeData(1);
    data.args.acknowledgedJournalHolds = acknowledgement;
    data.acknowledgedHolds = acknowledgement;
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });
    expect(summary.next_action?.args).toMatchObject({ acknowledged_journal_holds: acknowledgement, plan_handle: "PLAN-HANDLE-XYZ" });
    expect(summary.status).toBe("ready_for_approval");
    expect(summary.warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      item_id: "TRANSFER-ACK", code: "wise_acknowledged_hold_released", message: expect.stringContaining("journal(s) 801, 802"),
    })]));

    const command = {
      version: 2, action: "main_create", mutation_mode: "create", row_index: 0, row_key: "row:0:main", identity_hash: "h", wise_id: "WISE-0",
      date: "2026-02-01", transaction_type: "C", source_direction: "OUT", booked_amount: 10, booked_currency: "EUR",
      source_amount: 10, source_currency: "EUR", target_amount: 10, target_currency: "EUR", exchange_rate: 1,
      exchange_rate_orientation: "source_to_target", wise_dimension_id: 5, depends_on: null,
      create_payload: { accounts_dimensions_id: 5, type: "C", amount: 10, cl_currencies_id: "EUR", date: "2026-02-01", description: "WISE:WISE-0 [source_direction=OUT]" },
    } as unknown as WiseImportCommand;
    const full = parseMcpResponse(renderWiseImportFull({ ...data, commands: [command] }).content[0]!.text) as any;
    expect(full.acknowledged_holds).toEqual(acknowledgement);
    expect(full.workflow.approval_previews[0].execute_args.acknowledged_journal_holds).toEqual(acknowledgement);
  });

  it("a held review names the journals to acknowledge, and the ones a short acknowledgement left out, in the compact message", () => {
    const data = makeData(1);
    data.ownershipReviews = [{
      wise_id: "TRANSFER-ACK", code: "wise_transfer_journal_existing_elsewhere", reason: "Held.", source_verified: true,
      target_verified: true, approval_required: false, required_acknowledgement_ids: [801, 802], unacknowledged_journal_ids: [802],
    }];
    const { summary } = renderWiseImportCompact({ mode: "DRY_RUN", data });
    expect(summary.warnings).toEqual(expect.arrayContaining([{
      item_id: "TRANSFER-ACK",
      code: "wise_transfer_journal_existing_elsewhere",
      message: "Held. required_acknowledgement_ids: 801, 802. Not acknowledged: 802.",
    }]));
  });
});
