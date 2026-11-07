import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { lightyearStatementCsv } from "../__fixtures__/lightyear-rows.js";
import { poolDistribution, poolOpening, setupPoolTool } from "../__fixtures__/lightyear-pool-harness.js";
import { memoryUsdPoolStore } from "../__fixtures__/usd-pool-store.js";
import type { UsdPoolCheckpoint, UsdPoolEvent } from "../lightyear/usd-pool.js";
import type { Journal } from "../types/api.js";
import type { LightyearFxRevaluationPayload, LightyearTradesPayload } from "./lightyear-investments.js";

vi.mock("../bounded-read.js", async () => {
  const actual = await vi.importActual<typeof import("../bounded-read.js")>("../bounded-read.js");
  return { ...actual, readFileCapped: vi.fn() };
});
vi.mock("../file-validation.js", () => ({ resolveFileInput: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const mockedReadFileCapped = vi.mocked(readFileCapped);
const mockedResolveFileInput = vi.mocked(resolveFileInput);

const TRADE_ACCOUNTS = { investment_account: 1550, broker_account: 1120, gain_loss_account: 8330, loss_account: 8335, fee_account: 8335, fx_account: 8500 };

/** EUR→USD conversion with no trade (an `unsupported` pool row): 180.00 EUR → 200.00 USD. */
const BLOCKING = [
  ["10/02/2026 10:00:00", "CN-TESTBLOCK", "", "", "Conversion", "0", "EUR", "0", "-180.00", "1.111111", "0", "-180.00", "0"],
  ["10/02/2026 10:00:00", "CN-TESTBLOCK", "", "", "Conversion", "0", "USD", "0", "200.00", "0.9", "0", "200.00", "0"],
];
/** A later USD→EUR conversion with no trade (`conversion_out`): 50.00 USD → 45.00 EUR. */
const LATER = [
  ["20/03/2026 10:00:00", "CN-TESTLATER", "", "", "Conversion", "0", "USD", "0", "-50.00", "0.9", "0", "-50.00", "0"],
  ["20/03/2026 10:00:00", "CN-TESTLATER", "", "", "Conversion", "0", "EUR", "0", "45.00", "1.111111", "0", "45.00", "0"],
];

/** The owner's hand booking of the blocking conversion (inside the broker account). */
const HAND_BOOKED: Journal = {
  id: 801, document_number: "LY:CN-TESTBLOCK", effective_date: "2026-02-10", registered: true, is_deleted: false,
  postings: [{ accounts_id: 1120, type: "D", amount: 180 }, { accounts_id: 1120, type: "C", amount: 180 }],
};

function reviewCode(payload: LightyearTradesPayload, reference: string): string | undefined {
  const text = (payload.warnings ?? []).find(warning => warning.includes(reference));
  return text ? /FX review \[([a-z_]+)\]/.exec(text)?.[1] : undefined;
}

function resultFor(payload: LightyearTradesPayload, reference: string) {
  return payload.results.find(row => String(row.reference).includes(reference));
}

function openings(records: readonly unknown[]): string[] {
  return records.filter((record): record is UsdPoolCheckpoint => (record as UsdPoolCheckpoint).record === "checkpoint" && (record as UsdPoolCheckpoint).kind === "opening")
    .map(record => record.as_of);
}

const GAINS_PATH = "/tmp/CapitalGainsStatement-TESTACCT1-2026.csv";
const GAINS_HEADER = "Date,Ticker,Name,ISIN,Country,Asset Class,Fees (EUR),Quantity,Cost Basis (EUR),Proceeds (EUR),Capital Gains (EUR)";
/** A USD sale kept in USD (`sell_in`): 100.00 USD. */
const SELL = ["10/02/2026 10:00:00", "OR-TESTSELL1", "AMD", "US0079031078", "Sell", "1", "USD", "100", "100.00", "0", "0", "100.00", "0"];
/** A capital-gains file without that sale's row (another ticker). */
const UNRELATED_GAINS = [["2026-02-10 10:00:00", "NVDA", "NVDA", "US67066G1040", "United States", "equity", "0", "1", "80.00", "90.00", "10.00"]];

let statementRows: string[][] = [];
let gainsRows: string[][] = [];

describe("USD pool barrier: re-opening after a row the pool cannot book (Fable M2)", () => {
  beforeEach(() => {
    statementRows = [...BLOCKING, ...LATER];
    gainsRows = UNRELATED_GAINS;
    mockedResolveFileInput.mockReset();
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockReset();
    mockedReadFileCapped.mockImplementation(async (path: string) => Buffer.from(
      path === GAINS_PATH ? `${GAINS_HEADER}\n${gainsRows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n` : lightyearStatementCsv(statementRows),
      "utf8",
    ));
  });

  function tools() {
    const store = memoryUsdPoolStore([poolOpening(0, 0, "1")]);
    const trades = setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", TRADE_ACCOUNTS, { store, journals: [HAND_BOOKED] });
    const revaluation = setupPoolTool<LightyearFxRevaluationPayload>("book_lightyear_fx_revaluation", { broker_account: 1120 }, { store, journals: [HAND_BOOKED] });
    return { store, trades, revaluation };
  }

  it("a hand-booked LY: journal alone does not clear the barrier, and the review says how to unblock", async () => {
    const { trades } = tools();
    const dry = await trades.run({ dry_run: true });
    expect(resultFor(dry.payload, "CN-TESTBLOCK")).toBeUndefined();
    expect(reviewCode(dry.payload, "CN-TESTLATER")).toBe("usd_pool_unsupported_event");
    const warning = (dry.payload.warnings ?? []).find(text => text.includes("CN-TESTLATER"))!;
    expect(warning).toContain("booking it by hand alone does not clear it");
    expect(warning).toContain("re-open the pool with book_lightyear_fx_revaluation mode \"opening\"");
    expect(trades.create).not.toHaveBeenCalled();
  });

  it("an approved re-opening on the blocked row's day clears it: the later conversion books and is logged", async () => {
    const { store, trades, revaluation } = tools();
    const reopen = await revaluation.book({ mode: "opening", as_of: "2026-02-10" });
    expect(reopen.dry.payload).toMatchObject({ status: "would_store_opening", usd_amount: 200 });
    expect(reopen.dry.payload.note).toContain("It replaces the opening of 2025-12-31, past the blocking row <<UNTRUSTED_OCR_START:");
    expect(reopen.dry.payload.note).toMatch(/CN-TESTBLOCK\n?<<UNTRUSTED_OCR_END:[0-9a-f]+>> \(usd_pool_unsupported_event\)/);
    expect(reopen.exec.payload.status).toBe("opening_stored");
    expect(openings(store.records)).toEqual(["2025-12-31", "2026-02-10"]);

    const { dry, exec } = await trades.book();
    expect(resultFor(dry.payload, "CN-TESTLATER")).toMatchObject({ status: "would_create", pool: { kind: "conversion_out" } });
    expect(exec.result.isError).toBeFalsy();
    expect(trades.created.map(journal => journal.document_number)).toEqual(["LY:CN-TESTLATER"]);
    expect(store.records.filter((record): record is UsdPoolEvent => record.record === "event"))
      .toMatchObject([{ ref: "CN-TESTLATER", kind: "conversion_out", state: "committed", usd_cents: -5000 }]);
  });

  it("without the owner's approval (dry run only) the pool stays blocked", async () => {
    const { store, trades, revaluation } = tools();
    const dry = await revaluation.run({ mode: "opening", as_of: "2026-02-10", dry_run: true });
    expect(dry.payload.status).toBe("would_store_opening");
    expect(openings(store.records)).toEqual(["2025-12-31"]);
    expect(reviewCode((await trades.run({ dry_run: true })).payload, "CN-TESTLATER")).toBe("usd_pool_unsupported_event");
  });

  it("a re-opening dated before the blocked row is refused: the pool is not blocked up to that day", async () => {
    const { store, trades, revaluation } = tools();
    const refused = await revaluation.run({ mode: "opening", as_of: "2026-02-09", dry_run: true });
    expect(refused.payload).toMatchObject({ status: "review", review_reason: { code: "usd_pool_opening_exists", detail: expect.stringContaining("not_blocked") } });
    expect(refused.payload.plan_handle).toBeUndefined();
    expect(openings(store.records)).toEqual(["2025-12-31"]);
    expect(reviewCode((await trades.run({ dry_run: true })).payload, "CN-TESTLATER")).toBe("usd_pool_unsupported_event");
  });

  it("a re-opening of a pool that is not blocked is refused, with no plan handle", async () => {
    statementRows = [...LATER];
    const { store, revaluation } = tools();
    const refused = await revaluation.run({ mode: "opening", as_of: "2026-03-31", dry_run: true });
    expect(refused.payload).toMatchObject({ status: "review", review_reason: { code: "usd_pool_opening_exists", detail: expect.stringContaining("not_blocked") } });
    expect(refused.payload.review_reason?.message).toContain("cannot be replaced");
    expect(refused.payload.plan_handle).toBeUndefined();
    expect(openings(store.records)).toEqual(["2025-12-31"]);
  });

  it("a USD sale without its capital-gains row: re-opening needs the gains file proving it, then the later conversion books", async () => {
    statementRows = [SELL, ...LATER];
    const { store, trades, revaluation } = tools();
    const blocked = await trades.run({ dry_run: true, capital_gains_file: GAINS_PATH });
    expect(reviewCode(blocked.payload, "OR-TESTSELL1")).toBe("pool_sell_gains_unmatched");
    const warning = (blocked.payload.warnings ?? []).find(text => text.includes("OR-TESTSELL1"))!;
    expect(warning).toContain("First supply the capital-gains statement");
    expect(reviewCode(blocked.payload, "CN-TESTLATER")).toBe("usd_pool_prerequisite_failed");
    // The owner books the sale by hand; that alone does not clear the pool.
    trades.ledger.set(802, {
      id: 802, document_number: "LY:OR-TESTSELL1", effective_date: "2026-02-10", registered: true, is_deleted: false,
      postings: [{ accounts_id: 1120, type: "D", amount: 90 }, { accounts_id: 1550, type: "C", amount: 90 }],
    });
    expect(reviewCode((await trades.run({ dry_run: true, capital_gains_file: GAINS_PATH })).payload, "CN-TESTLATER")).toBe("usd_pool_prerequisite_unbooked");
    // Without the gains file nothing proves the sale unmatched: not a barrier.
    const unproven = await revaluation.run({ mode: "opening", as_of: "2026-02-10", dry_run: true });
    expect(unproven.payload.review_reason).toMatchObject({ code: "usd_pool_opening_exists", detail: expect.stringContaining("capital_gains_file") });
    const reopen = await revaluation.book({ mode: "opening", as_of: "2026-02-10", capital_gains_file: GAINS_PATH });
    expect(reopen.dry.payload.note).toMatch(/OR-TESTSELL1\n?<<UNTRUSTED_OCR_END:[0-9a-f]+>> \(pool_sell_gains_unmatched\)/);
    expect(reopen.exec.payload.status).toBe("opening_stored");
    expect(openings(store.records)).toEqual(["2025-12-31", "2026-02-10"]);
    const { dry } = await trades.book({ capital_gains_file: GAINS_PATH });
    expect(resultFor(dry.payload, "CN-TESTLATER")).toMatchObject({ status: "would_create", pool: { kind: "conversion_out" } });
    expect(trades.created.map(journal => journal.document_number)).toEqual(["LY:CN-TESTLATER"]);
  });

  it("a re-opening not after every pool record is refused", async () => {
    const { store, trades, revaluation } = tools();
    await revaluation.book({ mode: "opening", as_of: "2026-02-10" });
    await trades.book();
    // The conversion of 2026-03-20 is now logged: a re-opening before it would replay past a logged event.
    const refused = await revaluation.run({ mode: "opening", as_of: "2026-03-19", dry_run: true });
    expect(refused.payload).toMatchObject({ status: "review", review_reason: { code: "usd_pool_opening_exists", detail: "record_after" } });
    expect(refused.payload.plan_handle).toBeUndefined();
    expect(openings(store.records)).toEqual(["2025-12-31", "2026-02-10"]);
  });

  it("a later revaluation validates from the new opening (the blocked row no longer counts)", async () => {
    const { revaluation } = tools();
    const before = await revaluation.run({ mode: "revalue", as_of: "2026-02-28", expected_usd_holding: 200, dry_run: true });
    expect(before.payload.review_reason?.code).toBe("usd_pool_unsupported_event");
    await revaluation.book({ mode: "opening", as_of: "2026-02-10" });
    const after = await revaluation.run({ mode: "revalue", as_of: "2026-02-28", expected_usd_holding: 200, dry_run: true });
    expect(after.payload).toMatchObject({ status: "would_record_checkpoint", usd_amount: 200 });
    expect(after.payload.plan_handle).toBeDefined();
  });

  it("capital_gains_file is refused with mode \"revalue\"", async () => {
    const { revaluation } = tools();
    const { result } = await revaluation.run({ mode: "revalue", as_of: "2026-02-28", expected_usd_holding: 200, capital_gains_file: GAINS_PATH, dry_run: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("capital_gains_file is used only with mode");
  });

  it("execute is plan_drift when the capital-gains file is swapped after the dry run", async () => {
    statementRows = [SELL, ...LATER];
    const { store, revaluation } = tools();
    const dry = await revaluation.run({ mode: "opening", as_of: "2026-02-10", capital_gains_file: GAINS_PATH, dry_run: true });
    expect(dry.payload.status).toBe("would_store_opening");
    gainsRows = [...UNRELATED_GAINS, ["2026-02-11 10:00:00", "NVDA", "NVDA", "US67066G1040", "United States", "equity", "0", "1", "70.00", "90.00", "20.00"]];
    const exec = await revaluation.run({ mode: "opening", as_of: "2026-02-10", capital_gains_file: GAINS_PATH, dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.isError).toBe(true);
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(exec.result.content[0]!.text).toContain("Lightyear capital-gains statement");
    expect(openings(store.records)).toEqual(["2025-12-31"]);
  });

  it("execute is plan_drift when a pool record is committed after the dry run", async () => {
    const { store, revaluation } = tools();
    const dry = await revaluation.run({ mode: "opening", as_of: "2026-02-10", dry_run: true });
    expect(dry.payload.status).toBe("would_store_opening");
    store.upsert([poolDistribution("DD-TESTMAR01", "2026-03-01T10:00:00Z", 100, 89, 901)]);
    const exec = await revaluation.run({ mode: "opening", as_of: "2026-02-10", dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.isError).toBe(true);
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(openings(store.records)).toEqual(["2025-12-31"]);
  });

  it("a gains file that does not cover the sale's day proves nothing: not_blocked with that reason", async () => {
    statementRows = [SELL, ...LATER];
    gainsRows = [["2026-05-01 10:00:00", "NVDA", "NVDA", "US67066G1040", "United States", "equity", "0", "1", "80.00", "90.00", "10.00"]];
    const { revaluation } = tools();
    const refused = await revaluation.run({ mode: "opening", as_of: "2026-02-10", capital_gains_file: GAINS_PATH, dry_run: true });
    expect(refused.payload.review_reason).toMatchObject({ code: "usd_pool_opening_exists", detail: "not_blocked (capital_gains_file does not cover the sale of 2026-02-10)" });
    expect(refused.payload.plan_handle).toBeUndefined();
  });

  it("a pool row booked by hand outside the pool log is a re-openable barrier (no gains file needed)", async () => {
    statementRows = [SELL, ...LATER];
    const handBookedSale: Journal = {
      id: 802, document_number: "LY:OR-TESTSELL1", effective_date: "2026-02-10", registered: true, is_deleted: false,
      postings: [{ accounts_id: 1120, type: "D", amount: 90 }, { accounts_id: 1550, type: "C", amount: 90 }],
    };
    const store = memoryUsdPoolStore([poolOpening(0, 0, "1")]);
    const trades = setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", TRADE_ACCOUNTS, { store, journals: [handBookedSale] });
    const revaluation = setupPoolTool<LightyearFxRevaluationPayload>("book_lightyear_fx_revaluation", { broker_account: 1120 }, { store, journals: [handBookedSale] });
    const blocked = await trades.run({ dry_run: true });
    expect(reviewCode(blocked.payload, "CN-TESTLATER")).toBe("usd_pool_prerequisite_unbooked");
    const warning = (blocked.payload.warnings ?? []).find(text => text.includes("CN-TESTLATER"))!;
    expect(warning).toContain("it can no longer be logged");
    const reopen = await revaluation.book({ mode: "opening", as_of: "2026-02-10" });
    expect(reopen.dry.payload.note).toMatch(/OR-TESTSELL1\n?<<UNTRUSTED_OCR_END:[0-9a-f]+>> \(usd_pool_prerequisite_unbooked\)/);
    expect(reopen.exec.payload.status).toBe("opening_stored");
    const { dry } = await trades.book();
    expect(resultFor(dry.payload, "CN-TESTLATER")).toMatchObject({ status: "would_create", pool: { kind: "conversion_out" } });
  });

  it("an ambiguously paired group is a re-openable barrier", async () => {
    // Two same-second USD buys and two same-second EUR→USD conversions of the same amount: no unique pairing.
    const conv = (ref: string): string[][] => [
      ["10/02/2026 10:00:00", ref, "", "", "Conversion", "0", "EUR", "0", "-90.00", "1.111111", "0", "-90.00", "0"],
      ["10/02/2026 10:00:00", ref, "", "", "Conversion", "0", "USD", "0", "100.00", "0.9", "0", "100.00", "0"],
    ];
    const buyRow = (ref: string): string[] => ["10/02/2026 10:00:00", ref, "NVDA", "US67066G1040", "Buy", "1", "USD", "100", "100.00", "0", "0", "100.00", "0"];
    statementRows = [...conv("CN-TESTAMB1"), ...conv("CN-TESTAMB2"), buyRow("OR-TESTAMB1"), buyRow("OR-TESTAMB2"), ...LATER];
    const { revaluation } = tools();
    const dry = await revaluation.run({ mode: "opening", as_of: "2026-02-10", dry_run: true });
    expect(dry.payload.status).toBe("would_store_opening");
    expect(dry.payload.note).toContain("(usd_pool_pairing_ambiguous)");
  });
});
