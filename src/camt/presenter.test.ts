import { describe, it, expect } from "vitest";
import {
  camtPossibleDuplicateRow,
  camtResultRow,
  renderCamtImportCompact,
  renderCamtImportPayload,
  renderCamtParsePayload,
  type CamtImportRenderData,
} from "./presenter.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS } from "../response-budget.js";
import { roundMoney } from "../money.js";
import { camtMovementIdentity } from "./duplicate-identity.js";
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

describe("CAMT unsplit-entry review note", () => {
  const note = "camt:ntry:1 mixes leg currencies without an account-currency counter value (CntrValAmt) for every leg";
  const flagged = (): CamtImportRenderData => {
    const data = makeData(2);
    const entry: ParsedCamtEntry = {
      ...data.projection.descriptors[0]!.entry,
      review_note: note,
      legacy_identities: [{ amount: 5, description: "raw statement text" }],
    };
    const descriptors = [{ ...data.projection.descriptors[0]!, entry }, data.projection.descriptors[1]!];
    return {
      ...data,
      projection: { ...data.projection, descriptors },
      results: descriptors.map(descriptor => camtResultRow(descriptor, "would_create")),
    };
  };

  it("surfaces the note on the result row and as a compact warning", () => {
    const data = flagged();
    expect(data.results[0]).toMatchObject({ review_note: note });
    expect(data.results[1]).not.toHaveProperty("review_note");
    const { summary } = renderCamtImportCompact({ mode: "DRY_RUN", data });
    expect(summary.warnings).toEqual([{ code: "camt_unsplit_entry", message: note }]);
  });

  it("caps unsplit-entry warnings at 3 and counts the rest", () => {
    const data = makeData(4);
    const descriptors = data.projection.descriptors.map((descriptor, index) => ({
      ...descriptor,
      entry: { ...descriptor.entry, review_note: `${note} (${index})` },
    }));
    const results = descriptors.map(descriptor => camtResultRow(descriptor, "would_create"));
    const { summary } = renderCamtImportCompact({ mode: "DRY_RUN", data: { ...data, projection: { ...data.projection, descriptors }, results } });
    expect(summary.warnings?.map(w => w.code)).toEqual(["camt_unsplit_entry", "camt_unsplit_entry", "camt_unsplit_entry", "camt_unsplit_entry_more"]);
    expect(summary.warnings?.[3]!.message).toMatch(/^1 more camt_unsplit_entry item\(s\) not shown; .*PLAN-HANDLE-XYZ.*commands/);
  });

  it("routes budget-pruned unsplit entries to the plan commands in warnings_truncated", () => {
    const data = makeData(3);
    const long = "x".repeat(9_000);
    const descriptors = data.projection.descriptors.map((descriptor, index) => ({
      ...descriptor,
      entry: { ...descriptor.entry, review_note: `${long} (${index})` },
    }));
    const results = descriptors.map(descriptor => camtResultRow(descriptor, "would_create"));
    const { summary } = renderCamtImportCompact({ mode: "DRY_RUN", data: { ...data, projection: { ...data.projection, descriptors }, results } });
    const truncated = summary.warnings?.find(w => w.code === "warnings_truncated")?.message ?? "";
    expect(truncated).toMatch(/\(camt_unsplit_entry: \d+\) page them with get_execution_plan_page .*section: "commands"/);
    expect(truncated).not.toContain("exclusions");
  });

  it("renders the note but never the internal legacy identities on parse output", () => {
    const entry = flagged().projection.descriptors[0]!.entry;
    const payload = renderCamtParsePayload({ ...makeData(0).projection.parsed, entries: [entry] } as never);
    const rendered = (payload.entries as Array<Record<string, unknown>>)[0]!;
    expect(rendered.review_note).toBe(note);
    expect(rendered.legacy_identities).toBeUndefined();
  });
});

describe("CAMT partial legacy import review", () => {
  it("surfaces a skipped row's review note as a compact warning", () => {
    const data = makeData(1);
    const note = "The 95 EUR DBIT row on 2026-02-04 belongs to a statement entry a previous release imported only in part";
    const skipped = [{ date: "2026-02-04", amount: 95, duplicate_transaction_ids: [], reason: "r", review_note: note }];
    const { summary } = renderCamtImportCompact({ mode: "DRY_RUN", data: { ...data, projection: { ...data.projection, skipped } } });
    expect(summary.warnings).toEqual([{ code: "camt_partial_legacy_import", message: note }]);
  });
});

describe("CAMT journal reviews and automatic matches in the compact summary", () => {
  it("keeps each review_code, caps journal reviews at 3 with an N-more count, and itemises native-import matches", () => {
    const data = makeData(1);
    const codes = ["camt_duplicate_journal_conflict", "camt_journal_direction_conflict", "camt_journal_posting_review", "camt_journal_conflict", "camt_duplicate_journal_conflict"];
    const skipped = [
      ...codes.map((code, index) => ({
        date: "2026-02-05", amount: 10 + index, duplicate_transaction_ids: [], journal_ids: [800 + index],
        reason: "r", review_code: code, review_note: `note ${index}`,
      })),
      {
        date: "2026-02-06", amount: 42, duplicate_transaction_ids: [9001], journal_ids: [9101],
        reason: "Already imported by e-arveldaja's bank import as transaction 9001 (camt_native_import_match)",
        skip_code: "camt_native_import_match",
      },
    ];
    const { summary } = renderCamtImportCompact({ mode: "DRY_RUN", data: { ...data, projection: { ...data.projection, skipped } } });
    expect(summary.counts).toMatchObject({ skipped: 6, journal_reviews: 5, auto_matched: 1, possible_duplicates: 0 });
    expect(summary.warnings?.slice(0, 4).map(w => w.code)).toEqual([
      "camt_duplicate_journal_conflict", "camt_journal_direction_conflict", "camt_journal_posting_review", "camt_journal_review_more",
    ]);
    expect(summary.warnings?.[3]!.message).toMatch(/^2 more camt_journal_review item\(s\) not shown; .*PLAN-HANDLE-XYZ.*exclusions/);
    const native = summary.warnings?.find(w => w.code === "camt_native_import_match");
    expect(native?.item_id).toBe("9001");
    expect(native?.message).toContain("journal 9101");
    expect(native?.message).toContain("If wrong (a different movement): correct or delete transaction 9001, then re-run the preview.");
  });
});

describe("CAMT full-envelope untrusted-text wrapping", () => {
  const OCR = /^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\n/;

  it("wraps end_to_end_id, counterparty_iban and counterparty_reg_code on parse output", () => {
    const entry = { ...cleanEntry(1), end_to_end_id: "E2E-1", counterparty_reg_code: "12345678" };
    const payload = renderCamtParsePayload({ ...makeData(0).projection.parsed, entries: [entry] } as never);
    const rendered = (payload.entries as Array<Record<string, unknown>>)[0]!;
    expect(rendered.end_to_end_id).toMatch(OCR);
    expect(rendered.counterparty_iban).toMatch(OCR);
    expect(rendered.counterparty_reg_code).toMatch(OCR);
  });

  it("wraps existing-match ref_number and every suggested_patch value", () => {
    const data = makeData(1);
    const payload = renderCamtImportPayload({
      mode: "DRY_RUN",
      ...data,
      possibleDuplicates: [{
        date: "2026-02-01", amount: 11, currency: "EUR", type: "D", source_direction: "CRDT",
        counterparty: "Vendor", bank_reference: "REF", ref_number: "RF1",
        existing_transactions: [{
          id: 9, status: "CONFIRMED", counterparty: "Vendor", description: "d", ref_number: "RF-EXIST",
          match_reasons: ["counterparty_name"],
          suggested_patch_missing_fields: { bank_ref_number: "REF", ref_number: "RF1", bank_account_no: "EE47", bank_account_name: "Vendor", description: "desc" },
        }],
        recommended_default_action: "link_confirmed_transaction_then_delete_new_project_transaction",
        recommendation_note: "n",
      }],
    });
    const needsReview = ((payload.execution as Record<string, unknown>).needs_review as Array<Record<string, unknown>>)[0]!;
    const match = (needsReview.existing_transactions as Array<Record<string, unknown>>)[0]!;
    expect(match.ref_number).toMatch(OCR);
    for (const value of Object.values(match.suggested_patch_missing_fields as Record<string, unknown>)) {
      expect(value).toMatch(OCR);
    }
  });
});

describe("camtPossibleDuplicateRow", () => {
  it("carries the opaque leg identity of its statement entry", () => {
    const entry = {
      date: "2026-02-01", amount: 5, currency: "EUR", direction: "DBIT", counterparty_name: "Vendor",
      bank_reference: "REF-1", description: "x", duplicate: false, duplicate_transaction_ids: [],
    } as unknown as ParsedCamtEntry;
    const row = camtPossibleDuplicateRow({ entry, possibleDuplicateMatches: [] } as unknown as CamtCreateDescriptor);
    expect(row.movement_identity).toBe(camtMovementIdentity(entry));
    expect(row.movement_identity).toMatch(/^[0-9a-f]{64}$/);
  });
});
