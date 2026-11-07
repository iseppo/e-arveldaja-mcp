import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { lightyearStatementCsv } from "../__fixtures__/lightyear-rows.js";
import { poolOpening, setupPoolTool } from "../__fixtures__/lightyear-pool-harness.js";
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

describe("USD pool barrier: re-opening after a row the pool cannot book (Fable M2)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockReset();
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockReset();
    mockedReadFileCapped.mockImplementation(async () => Buffer.from(lightyearStatementCsv([...BLOCKING, ...LATER]), "utf8"));
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
    expect(reopen.dry.payload.note).toContain("It replaces the opening of 2025-12-31");
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

  it("a re-opening dated before the blocked row leaves it blocked", async () => {
    const { store, trades, revaluation } = tools();
    expect((await revaluation.book({ mode: "opening", as_of: "2026-02-09" })).exec.payload.status).toBe("opening_stored");
    expect(openings(store.records)).toEqual(["2025-12-31", "2026-02-09"]);
    expect(reviewCode((await trades.run({ dry_run: true })).payload, "CN-TESTLATER")).toBe("usd_pool_unsupported_event");
    expect(trades.create).not.toHaveBeenCalled();
  });

  it("a re-opening not after every pool record is refused", async () => {
    const { store, trades, revaluation } = tools();
    await revaluation.book({ mode: "opening", as_of: "2026-02-10" });
    await trades.book();
    // The conversion of 2026-03-20 is now logged: a re-opening before it would replay past a logged event.
    const refused = await revaluation.run({ mode: "opening", as_of: "2026-03-19", dry_run: true });
    expect(refused.payload).toMatchObject({ status: "review", review_reason: { code: "usd_pool_opening_exists" } });
    expect(refused.payload.plan_handle).toBeUndefined();
    expect(openings(store.records)).toEqual(["2025-12-31", "2026-02-10"]);
  });
});
