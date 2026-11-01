import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AccountDimension, Journal, Posting } from "../types/api.js";
import type { ParsedCamtEntry, Transaction } from "./types.js";
import { computeCamtImportProjection } from "./projection.js";
import { summarizeEntries } from "./parser.js";
import { camtMovementIdentity } from "./duplicate-identity.js";
import { buildImportProjection, camtNormalizedArgs, camtPlanFingerprint } from "./executor.js";
import { renderCamtImportCompact, renderCamtImportPayload, renderCamtImportSlim, type CamtImportRenderData } from "./presenter.js";
import { camtReviewAcknowledgementStore } from "./review-acknowledgement-store.js";
import { recordRetainedCamtStatements, resetRetainedCamtStatements, retainedCamtMovementOccurrences } from "./statement-context.js";
import type { CamtReviewAcknowledgementCandidate, CamtReviewAcknowledgementRecord } from "./review-acknowledgement.js";
import { refusalMessage } from "./review-acknowledgement.js";
import { initAccountingRulesConnection } from "../accounting-rules.js";
import {
  buildCamtReviewAcknowledgementExecuteResponse,
  buildCamtReviewAcknowledgementPrepareResponse,
  type CamtReviewAcknowledgementPayload,
} from "../tools/camt-review-acknowledgement-action.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import type { ApiContext } from "../tools/crud-tools.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const DIM = 7;
const LOAN = 70;
const DATE = "2026-09-30";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "camt-ack-"));
  process.env.EARVELDAJA_RULES_DIR = dir;
  camtReviewAcknowledgementStore.reset();
  resetRetainedCamtStatements();
});
afterEach(() => {
  resetRetainedCamtStatements();
  delete process.env.EARVELDAJA_RULES_DIR;
  delete process.env.EARVELDAJA_RULES_FILE;
  camtReviewAcknowledgementStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (o: Partial<ParsedCamtEntry> = {}): ParsedCamtEntry => ({
  date: DATE, amount: 50, currency: "EUR", direction: "CRDT", counterparty_name: "Näidis Laenaja OÜ",
  description: "laen tagasi", bank_reference: "STMT-50-A", duplicate: false, duplicate_transaction_ids: [], ...o,
});
const p = (accounts_id: number, accounts_dimensions_id: number | null, type: "D" | "C", amount: number): Posting =>
  ({ accounts_id, accounts_dimensions_id, type, amount, base_amount: amount, cl_currencies_id: "EUR", is_deleted: false });
/** A manual journal: D bank / C loan. */
const manual = (id: number, amount = 50, o: Partial<Journal> = {}): Journal => ({
  id, effective_date: DATE, registered: true, is_deleted: false, operation_type: "ENTRY", document_number: null,
  postings: [p(1020, DIM, "D", amount), p(1410, LOAN, "C", amount)], ...o,
});

const project = (
  journals: Journal[],
  entries: ParsedCamtEntry[],
  acks: CamtReviewAcknowledgementRecord[] = [],
  // Default: a statement an inbox scan retained alone (B3b); null = no scan context.
  otherStatementOccurrences: ((identity: string) => number) | null = () => 0,
) => computeCamtImportProjection({
  loaded: { entries, summary: summarizeEntries(entries), statement_metadata: { iban: "EE000", period: {} } },
  accountsDimensionsId: DIM, dateFrom: undefined, dateTo: undefined, ledgerTransactions: [] as Transaction[],
  journalCoverage: { journals, accountId: 1020, bankAccounts: [], accountDimensions: [],
    interAccountResolver: () => ({ resolveInterAccount: () => ({ status: "none" }), hasOtherLabelledInterAccount: () => false }) },
  resolveClient: async () => ({}), reportProgress: async () => {},
  reviewAcknowledgements: acks,
  ...(otherStatementOccurrences ? { otherStatementOccurrences } : {}),
});

const ackOf = (e: ParsedCamtEntry, journalIds: number[], o: Partial<CamtReviewAcknowledgementRecord> = {}): CamtReviewAcknowledgementRecord => ({
  accounts_dimensions_id: DIM, movement_identity: camtMovementIdentity(e), review_code: "camt_journal_posting_review",
  journal_ids: journalIds, acknowledged_at: "2026-10-01T00:00:00.000Z", ...o,
});

describe("CAMT journal-review acknowledgements in the projection (#10b)", () => {
  it("a unique row with one exactly-booking journal carries an acknowledgement candidate", async () => {
    const e = entry();
    const projection = await project([manual(901)], [e]);
    expect(projection.skipped).toHaveLength(1);
    expect(projection.skipped[0]).toMatchObject({
      review_code: "camt_journal_posting_review",
      journal_ids: [901],
      acknowledgement: {
        accounts_dimensions_id: DIM, movement_identity: camtMovementIdentity(e), review_code: "camt_journal_posting_review",
        journal_ids: [901], date: DATE, amount: 50, direction: "CRDT",
      },
    });
    expect(projection.skipped[0]!.acknowledgement!.refused).toBeUndefined();
  });

  it("a matching acknowledgement quiets the review: skipped, no review_code, acknowledged_review set", async () => {
    const e = entry();
    const projection = await project([manual(901)], [e], [ackOf(e, [901])]);
    expect(projection.descriptors).toHaveLength(0);
    expect(projection.skipped).toEqual([{
      date: DATE, amount: 50, bank_reference: "STMT-50-A", duplicate_transaction_ids: [], journal_ids: [901],
      reason: "Checked earlier: journal 901 books this movement (acknowledged camt_journal_posting_review)",
      skip_code: "camt_review_acknowledged", movement_identity: camtMovementIdentity(e),
      acknowledged_review: { review_code: "camt_journal_posting_review", journal_ids: [901] },
    }]);
  });

  it("the acknowledgement reaches the plan fingerprint", async () => {
    const e = entry();
    const args = camtNormalizedArgs(DIM, undefined, undefined);
    expect(camtPlanFingerprint(await project([manual(901)], [e], [ackOf(e, [901])]), args))
      .not.toBe(camtPlanFingerprint(await project([manual(901)], [e]), args));
  });

  it("an acknowledgement plus a new suspect journal → the review returns", async () => {
    const e = entry();
    const projection = await project([manual(901), manual(902)], [e], [ackOf(e, [901])]);
    expect(projection.skipped[0]).toMatchObject({
      review_code: "camt_journal_posting_review", journal_ids: [901, 902],
      acknowledgement: { refused: "camt_ack_multiple_candidates" },
    });
    expect(projection.skipped[0]!.acknowledged_review).toBeUndefined();
  });

  it("one unique €50 row + two registered €50 manual journals → camt_ack_multiple_candidates, review stays", async () => {
    const projection = await project([manual(901), manual(902)], [entry()]);
    expect(projection.skipped[0]).toMatchObject({ review_code: "camt_journal_posting_review", acknowledgement: { refused: "camt_ack_multiple_candidates" } });
  });

  it("two identical ref-less €50 rows vs one €50 journal → camt_ack_nonunique_movement, both rows stay reviews", async () => {
    const refless = entry({ bank_reference: undefined });
    const projection = await project([manual(901)], [refless, { ...refless }]);
    expect(projection.skipped).toHaveLength(2);
    for (const row of projection.skipped) {
      expect(row).toMatchObject({ review_code: "camt_journal_posting_review", acknowledgement: { refused: "camt_ack_nonunique_movement" } });
    }
  });

  it("a stored acknowledgement for a then-unique ref-less row, then the statement shows an identical second row → both reviews return", async () => {
    const refless = entry({ bank_reference: undefined });
    const ack = ackOf(refless, [901]);
    expect((await project([manual(901)], [refless], [ack])).skipped[0]!.skip_code).toBe("camt_review_acknowledged");
    const projection = await project([manual(901)], [refless, { ...refless }], [ack]);
    expect(projection.skipped.map(row => row.review_code)).toEqual(["camt_journal_posting_review", "camt_journal_posting_review"]);
    expect(projection.skipped.some(row => row.acknowledged_review !== undefined)).toBe(false);
  });

  it("the same movement in a longer, overlapping statement → the acknowledgement applies there once", async () => {
    const e = entry();
    const longer = [entry({ date: "2026-09-29", amount: 12, bank_reference: "STMT-OTHER" }), e];
    const projection = await project([manual(901)], longer, [ackOf(e, [901])]);
    expect(projection.skipped.filter(row => row.acknowledged_review !== undefined)).toHaveLength(1);
  });

  it("B3b: two retained statements with the same ref-less €50 plus different rows → one acknowledgement quiets neither", async () => {
    const refless = entry({ bank_reference: undefined });
    const statementA = [refless, entry({ date: "2026-09-28", amount: 12, bank_reference: "STMT-A-12" })];
    const statementB = [{ ...refless }, entry({ date: "2026-10-02", amount: 30, bank_reference: "STMT-B-30" })];
    const [digestA, digestB] = ["a".repeat(64), "b".repeat(64)];
    const ack = ackOf(refless, [901]);
    const journals = [manual(901), manual(905, 12, { effective_date: "2026-09-28" }), manual(906, 30, { effective_date: "2026-10-02" })];
    // Each statement alone: the movement is unique there and the acknowledgement applies.
    expect((await project(journals, statementA, [ack])).skipped.some(row => row.acknowledged_review !== undefined)).toBe(true);
    recordRetainedCamtStatements([digestA, digestB], new Map([[digestA, statementA.map(camtMovementIdentity)], [digestB, statementB.map(camtMovementIdentity)]]));
    expect(retainedCamtMovementOccurrences(camtMovementIdentity(refless))).toBe(2);
    for (const [statement, digest] of [[statementA, digestA], [statementB, digestB]] as const) {
      const projection = await project(journals, [...statement], [ack], identity => retainedCamtMovementOccurrences(identity, digest));
      const row = projection.skipped.find(candidate => candidate.movement_identity === camtMovementIdentity(refless))!;
      expect(row).toMatchObject({ review_code: "camt_journal_posting_review", acknowledgement: { refused: "camt_ack_nonunique_movement" } });
      expect(projection.skipped.some(candidate => candidate.acknowledged_review !== undefined)).toBe(false);
    }
    // A later scan that no longer retains B: the acknowledgement applies to A again.
    recordRetainedCamtStatements([digestB], new Map());
    const again = await project(journals, statementA, [ack], identity => retainedCamtMovementOccurrences(identity, digestA));
    expect(again.skipped.some(row => row.acknowledged_review !== undefined)).toBe(true);
  });

  it("B3b: the import projection counts the other retained statements, never its own digest", async () => {
    const refless = entry({ bank_reference: undefined });
    const statement = [refless];
    camtReviewAcknowledgementStore.upsert([ackOf(refless, [901])]);
    const api = {
      transactions: { listAll: vi.fn(async () => []) },
      journals: { listAllWithPostings: vi.fn(async () => [manual(901)]) },
      readonly: {
        getAccountDimensions: vi.fn(async () => [{ id: DIM, accounts_id: 1020, is_deleted: false }] as AccountDimension[]),
        getBankAccounts: vi.fn(async () => []),
      },
    } as unknown as ApiContext;
    const loaded = { entries: statement, summary: summarizeEntries(statement), statement_metadata: { iban: "EE000", period: {} } };
    const [own, other] = ["c".repeat(64), "d".repeat(64)];
    const acknowledged = async () => (await buildImportProjection(api, loaded, DIM, undefined, undefined, false, "none", own))
      .skipped.some(row => row.skip_code === "camt_review_acknowledged");
    // Only this statement retained: its own occurrence is not a second one.
    recordRetainedCamtStatements([own], new Map([[own, [camtMovementIdentity(refless)]]]));
    expect(await acknowledged()).toBe(true);
    // Another retained statement holds the same movement: the review returns.
    recordRetainedCamtStatements([other], new Map([[other, [camtMovementIdentity(refless)]]]));
    expect(await acknowledged()).toBe(false);
  });

  describe("B3b r2: no scan context → fail closed; context is connection-scoped", () => {
    const refless = entry({ bank_reference: undefined });
    const apiOf = (journals: Journal[]) => ({
      transactions: { listAll: vi.fn(async () => []) },
      journals: { listAllWithPostings: vi.fn(async () => journals) },
      readonly: {
        getAccountDimensions: vi.fn(async () => [{ id: DIM, accounts_id: 1020, is_deleted: false }] as AccountDimension[]),
        getBankAccounts: vi.fn(async () => []),
      },
    } as unknown as ApiContext);
    const loadedOf = (statement: ParsedCamtEntry[]) =>
      ({ entries: statement, summary: summarizeEntries(statement), statement_metadata: { iban: "EE000", period: {} } });
    const journals = [manual(901), manual(905, 12, { effective_date: "2026-09-28" }), manual(906, 30, { effective_date: "2026-10-02" })];
    const statementX = [refless, entry({ date: "2026-09-28", amount: 12, bank_reference: "STMT-X-12" })];
    const statementY = [{ ...refless }, entry({ date: "2026-10-02", amount: 30, bank_reference: "STMT-Y-30" })];
    const [digestX, digestY] = ["e".repeat(64), "f".repeat(64)];
    const rowOf = async (statement: ParsedCamtEntry[], digest: string) =>
      (await buildImportProjection(apiOf(journals), loadedOf(statement), DIM, undefined, undefined, false, "none", digest))
        .skipped.find(row => row.movement_identity === camtMovementIdentity(refless))!;
    afterEach(() => initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" })));

    it("restart (empty registry), direct previews of [M, X] and [M, Y] → neither acknowledged, plain inbox-scan note", async () => {
      camtReviewAcknowledgementStore.upsert([ackOf(refless, [901])]);
      for (const [statement, digest] of [[statementX, digestX], [statementY, digestY]] as const) {
        const row = await rowOf([...statement], digest);
        expect(row.skip_code).not.toBe("camt_review_acknowledged");
        expect(row).toMatchObject({ review_code: "camt_journal_posting_review", acknowledgement: { refused: "camt_ack_needs_inbox_scan" } });
        expect(row.reason).toContain("run an inbox scan first");
      }
      expect(refusalMessage("camt_ack_needs_inbox_scan")).toContain("run an inbox scan first");
    });

    it("a scanned single statement → the acknowledgement applies", async () => {
      camtReviewAcknowledgementStore.upsert([ackOf(refless, [901])]);
      recordRetainedCamtStatements([digestX], new Map([[digestX, statementX.map(camtMovementIdentity)]]));
      expect((await rowOf([...statementX], digestX)).skip_code).toBe("camt_review_acknowledged");
      // A statement the scan did not retain still has no context.
      expect((await rowOf([...statementY], digestY)).acknowledgement?.refused).toBe("camt_ack_needs_inbox_scan");
    });

    it("another connection's retained statements never count, and never give context", async () => {
      initAccountingRulesConnection(() => ({ name: "b", stableIdentity: "company-b" }));
      recordRetainedCamtStatements([digestX, digestY], new Map([[digestX, statementX.map(camtMovementIdentity)], [digestY, statementY.map(camtMovementIdentity)]]));
      initAccountingRulesConnection(() => ({ name: "a", stableIdentity: "company-a" }));
      camtReviewAcknowledgementStore.reset();
      camtReviewAcknowledgementStore.upsert([ackOf(refless, [901])]);
      expect(retainedCamtMovementOccurrences(camtMovementIdentity(refless))).toBe(0);
      // Company B's scan of the same digest is no context for company A.
      expect((await rowOf([...statementX], digestX)).acknowledgement?.refused).toBe("camt_ack_needs_inbox_scan");
      // Company A's own scan of X alone: B's copy of the movement (in Y) does not make it non-unique.
      recordRetainedCamtStatements([digestX], new Map([[digestX, statementX.map(camtMovementIdentity)]]));
      expect((await rowOf([...statementX], digestX)).skip_code).toBe("camt_review_acknowledged");
    });
  });

  it("a second acknowledgement binding the same journal is refused (camt_ack_journal_already_claimed)", async () => {
    const first = entry();
    const second = entry({ bank_reference: "STMT-50-B", description: "muu" });
    // The stored acknowledgement binds journal 901 to `first`; a statement holding only `second` cannot bind it again.
    const projection = await project([manual(901)], [second], [ackOf(first, [901])]);
    expect(projection.skipped[0]).toMatchObject({ review_code: "camt_journal_posting_review", acknowledgement: { refused: "camt_ack_journal_already_claimed" } });
  });

  it("two rows naming the same single journal → neither can be acknowledged", async () => {
    const projection = await project([manual(901)], [entry(), entry({ bank_reference: "STMT-50-B", description: "muu" })]);
    for (const row of projection.skipped) {
      expect(row).toMatchObject({ acknowledgement: { refused: "camt_ack_journal_already_claimed" } });
    }
  });

  it("a journal whose bank net is not the row's amount (a split journal) → camt_ack_journal_mismatch", async () => {
    const split: Journal = manual(901, 50, { postings: [p(1020, DIM, "D", 50), p(1020, DIM, "D", 20), p(1410, LOAN, "C", 70)] });
    const projection = await project([split], [entry()]);
    expect(projection.skipped[0]).toMatchObject({ review_code: "camt_journal_posting_review", acknowledgement: { refused: "camt_ack_journal_mismatch" } });
  });

  it("a wrong booking (direction conflict) is never acknowledgeable", async () => {
    const backwards: Journal = { ...manual(901), operation_type: "TRANSACTION", operations_id: 77,
      postings: [p(1020, DIM, "C", 50), p(1410, LOAN, "D", 50)] };
    const ledger = [{ id: 77, status: "CONFIRMED", accounts_dimensions_id: DIM, amount: 50, cl_currencies_id: "EUR", date: DATE, is_deleted: false } as Transaction];
    const e = entry();
    const projection = await computeCamtImportProjection({
      loaded: { entries: [e], summary: summarizeEntries([e]), statement_metadata: { iban: "EE000", period: {} } },
      accountsDimensionsId: DIM, dateFrom: undefined, dateTo: undefined, ledgerTransactions: ledger,
      journalCoverage: { journals: [backwards], accountId: 1020, bankAccounts: [], accountDimensions: [],
        interAccountResolver: () => ({ resolveInterAccount: () => ({ status: "none" }), hasOtherLabelledInterAccount: () => false }) },
      resolveClient: async () => ({}), reportProgress: async () => {},
      reviewAcknowledgements: [ackOf(e, [901], { review_code: "camt_journal_direction_conflict" as never })],
    });
    expect(projection.skipped[0]).toMatchObject({ review_code: "camt_journal_direction_conflict" });
    expect(projection.skipped[0]!.acknowledgement).toBeUndefined();
  });

  it("all three renderers count the acknowledged row and keep it out of the journal reviews", async () => {
    const e = entry();
    const other = entry({ date: "2026-09-29", amount: 12, bank_reference: "STMT-12" });
    const projection = await project([manual(901), manual(905, 12, { effective_date: "2026-09-29" })], [e, other], [ackOf(e, [901])]);
    const data: CamtImportRenderData = { projection, results: [], createdCount: 0, errorCount: 0, possibleDuplicates: [], workflowArgs: {} };
    const full = renderCamtImportPayload({ ...data, mode: "DRY_RUN" });
    expect(full.summary).toMatchObject({ journal_review_count: 1, acknowledged_review_count: 1 });
    const slim = renderCamtImportSlim({ ...data, mode: "DRY_RUN" });
    expect(slim.summary.held_by_code).toEqual({ camt_review_acknowledged: 1, camt_journal_posting_review: 1 });
    expect(slim.execution.held.find(row => row.skip_code === "camt_review_acknowledged")!.acknowledged_review)
      .toEqual({ review_code: "camt_journal_posting_review", journal_ids: [901] });
    const compact = renderCamtImportCompact({ mode: "DRY_RUN", data });
    expect(compact.summary.counts).toMatchObject({ journal_reviews: 1, acknowledged_reviews: 1 });
  });
});

describe("acknowledging a CAMT journal review via prepare_action / execute_review_action (#10b)", () => {
  const e = entry();
  const candidate = (o: Partial<CamtReviewAcknowledgementCandidate> = {}): CamtReviewAcknowledgementCandidate => ({
    accounts_dimensions_id: DIM, movement_identity: camtMovementIdentity(e), review_code: "camt_journal_posting_review",
    journal_ids: [901], date: DATE, amount: 50, direction: "CRDT", ...o,
  });
  const item = (o: Partial<CamtReviewAcknowledgementCandidate> = {}) => ({
    review_type: "camt_journal_review",
    item: { code: "camt_journal_review", review_code: "camt_journal_posting_review", date: DATE, amount: 50, journal_ids: [901], acknowledgement: candidate(o) },
  });
  const apiWith = (journal: () => Journal): ApiContext => ({
    journals: { get: vi.fn(async () => journal()), invalidateListCache: vi.fn() },
    readonly: { getAccountDimensions: vi.fn(async () => [{ id: DIM, accounts_id: 1020, is_deleted: false }] as AccountDimension[]) },
  }) as unknown as ApiContext;
  const payloadOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    parseToolPayload<CamtReviewAcknowledgementPayload>((result.content[0] as { text: string }).text);
  const storeFile = () => join(dir, "camt-review-acknowledgements.json");

  it("prepare verifies the journal and mints a plan; execute records the acknowledgement", async () => {
    const context = createTestRuntimeSafetyContext();
    const api = apiWith(() => manual(901));
    const prepared = payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), api, context));
    expect(prepared).toMatchObject({ status: "ready_for_approval", proposed_action: { type: "acknowledge_camt_journal_review", acknowledgement: candidate() } });
    expect(() => readFileSync(storeFile())).toThrow(); // prepare writes nothing
    const handle = (prepared as Extract<CamtReviewAcknowledgementPayload, { status: "ready_for_approval" }>).plan_handle;
    const executed = payloadOf(await buildCamtReviewAcknowledgementExecuteResponse(item(), handle, api, context));
    expect(executed).toMatchObject({ status: "acknowledged", acknowledgement: { journal_ids: [901], movement_identity: camtMovementIdentity(e) } });
    expect(camtReviewAcknowledgementStore.read()).toHaveLength(1);
    // The next import of the statement quiets the review.
    const projection = await project([manual(901)], [e], camtReviewAcknowledgementStore.read()!);
    expect(projection.skipped[0]!.skip_code).toBe("camt_review_acknowledged");
    // The handle is consume-once.
    expect(payloadOf(await buildCamtReviewAcknowledgementExecuteResponse(item(), handle, api, context))).toMatchObject({ status: "error" });
  });

  it("a journal deleted after prepare → refused at execute, nothing written", async () => {
    const context = createTestRuntimeSafetyContext();
    let current = manual(901);
    const api = apiWith(() => current);
    const prepared = payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), api, context)) as Extract<CamtReviewAcknowledgementPayload, { status: "ready_for_approval" }>;
    current = { ...current, is_deleted: true };
    const executed = payloadOf(await buildCamtReviewAcknowledgementExecuteResponse(item(), prepared.plan_handle, api, context));
    expect(executed).toMatchObject({ status: "error", error_code: "camt_ack_journal_mismatch" });
    expect(camtReviewAcknowledgementStore.read()).toEqual([]);
  });

  it("a journal re-dated after prepare → plan_drift, nothing written", async () => {
    const context = createTestRuntimeSafetyContext();
    let current = manual(901);
    const api = apiWith(() => current);
    const prepared = payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), api, context)) as Extract<CamtReviewAcknowledgementPayload, { status: "ready_for_approval" }>;
    current = { ...current, effective_date: "2026-09-29" };
    expect(payloadOf(await buildCamtReviewAcknowledgementExecuteResponse(item(), prepared.plan_handle, api, context)))
      .toMatchObject({ status: "error", error_code: "plan_drift" });
    expect(camtReviewAcknowledgementStore.read()).toEqual([]);
  });

  it.each([
    ["a non-unique movement", { refused: "camt_ack_nonunique_movement" as const }, "camt_ack_nonunique_movement"],
    ["several candidate journals", { journal_ids: [901, 902] }, "camt_ack_multiple_candidates"],
    ["a wrong-booking review code", { review_code: "camt_journal_conflict" as never }, "camt_ack_code_not_acknowledgeable"],
  ])("prepare refuses %s and mints no handle", async (_name, override, code) => {
    const context = createTestRuntimeSafetyContext();
    const before = context.planStore.activeCount;
    expect(payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(override), apiWith(() => manual(901)), context)))
      .toMatchObject({ status: "error", error_code: code });
    expect(context.planStore.activeCount).toBe(before);
  });

  it("B3b: prepare and execute refuse a movement two retained statements share", async () => {
    const context = createTestRuntimeSafetyContext();
    const api = apiWith(() => manual(901));
    const prepared = payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), api, context)) as Extract<CamtReviewAcknowledgementPayload, { status: "ready_for_approval" }>;
    expect(prepared.status).toBe("ready_for_approval");
    // The inbox now keeps a second statement holding the same movement.
    recordRetainedCamtStatements(["a".repeat(64), "b".repeat(64)], new Map([["a".repeat(64), [camtMovementIdentity(e)]], ["b".repeat(64), [camtMovementIdentity(e)]]]));
    expect(payloadOf(await buildCamtReviewAcknowledgementExecuteResponse(item(), prepared.plan_handle, api, context)))
      .toMatchObject({ status: "error", error_code: "camt_ack_nonunique_movement" });
    expect(camtReviewAcknowledgementStore.read()).toEqual([]);
    expect(payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), api, createTestRuntimeSafetyContext())))
      .toMatchObject({ status: "error", error_code: "camt_ack_nonunique_movement" });
  });

  it("a journal that does not move the row's amount in its direction → refused", async () => {
    const outgoing = manual(901, 50, { postings: [p(1020, DIM, "C", 50), p(1410, LOAN, "D", 50)] });
    expect(payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), apiWith(() => outgoing), createTestRuntimeSafetyContext())))
      .toMatchObject({ status: "error", error_code: "camt_ack_journal_mismatch" });
  });

  it("a second acknowledgement binding an already-acknowledged journal → camt_ack_journal_already_claimed", async () => {
    camtReviewAcknowledgementStore.upsert([ackOf(entry({ bank_reference: "STMT-50-B" }), [901])]);
    expect(payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), apiWith(() => manual(901)), createTestRuntimeSafetyContext())))
      .toMatchObject({ status: "error", error_code: "camt_ack_journal_already_claimed" });
  });

  it("single-file rules mode → store unavailable, nothing prepared", async () => {
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(dir, "accounting-rules.md");
    camtReviewAcknowledgementStore.reset();
    expect(payloadOf(await buildCamtReviewAcknowledgementPrepareResponse(item(), apiWith(() => manual(901)), createTestRuntimeSafetyContext())))
      .toMatchObject({ status: "error", error_code: "camt_ack_store_unavailable" });
  });
});

describe("continue_accounting_workflow routes a camt_journal_review item to the acknowledgement (#10b)", () => {
  it("prepare_action → ready_for_approval, execute_review_action → acknowledged", async () => {
    const { registerAccountingInboxTools } = await import("../tools/accounting-inbox.js");
    const { createMockToolServer, getRegisteredToolHandler } = await import("../__fixtures__/accounting-workflow.js");
    const server = createMockToolServer();
    const context = createTestRuntimeSafetyContext();
    const api = {
      journals: { get: vi.fn(async () => manual(901)), invalidateListCache: vi.fn() },
      readonly: { getAccountDimensions: vi.fn(async () => [{ id: DIM, accounts_id: 1020, is_deleted: false }]) },
    } as unknown as ApiContext;
    registerAccountingInboxTools(server, api, context);
    const handler = getRegisteredToolHandler(server, "continue_accounting_workflow");
    const e = entry();
    const reviewItem = {
      review_type: "camt_journal_review",
      item: {
        code: "camt_journal_review",
        acknowledgement: {
          accounts_dimensions_id: DIM, movement_identity: camtMovementIdentity(e), review_code: "camt_journal_posting_review",
          journal_ids: [901], date: DATE, amount: 50, direction: "CRDT",
        },
      },
    };
    const text = (result: { content: Array<{ text?: string }> }) => result.content[0]!.text!;
    const prepared = parseToolPayload<Extract<CamtReviewAcknowledgementPayload, { status: "ready_for_approval" }>>(
      text(await handler({ action: "prepare_action", review_item_json: reviewItem })));
    expect(prepared.status).toBe("ready_for_approval");
    const executed = parseToolPayload<CamtReviewAcknowledgementPayload>(
      text(await handler({ action: "execute_review_action", review_item_json: reviewItem, plan_handle: prepared.plan_handle })));
    expect(executed.status).toBe("acknowledged");
  });
});
