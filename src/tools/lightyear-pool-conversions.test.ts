import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { lightyearStatementCsv } from "../__fixtures__/lightyear-rows.js";
import {
  POOL_KEY,
  POOL_STATEMENT_PATH,
  poolDistribution,
  sourceDigestOf,
  poolJournal,
  rateFetch,
  setupPoolTool,
  type CreatedJournal,
} from "../__fixtures__/lightyear-pool-harness.js";
import { endOfDaySeconds, usdCentsToEurCents, type UsdPoolCheckpoint, type UsdPoolEvent } from "../lightyear/usd-pool.js";
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

const GAINS_PATH = "/tmp/CapitalGainsStatement-TESTACCT1-2026.csv";
const GAINS_HEADER = "Date,Ticker,Name,ISIN,Country,Asset Class,Fees (EUR),Quantity,Cost Basis (EUR),Proceeds (EUR),Capital Gains (EUR)";
/** Synthetic accounts: 1120 broker (plan 1020), 1550 investment (plan 1100). */
const ACCOUNTS = { investment_account: 1550, broker_account: 1120, gain_loss_account: 8330, loss_account: 8335, fee_account: 8335, fx_account: 8500 };

let statementRows: string[][] = [];
let gainsRows: string[][] = [];
function load(rows: string[][], gains: string[][] = []): void {
  statementRows = rows;
  gainsRows = gains;
}

/** An approved opening whose stored rate recomputes its EUR value exactly. */
function opening(usd: number, eur: number, asOf = "2025-12-31"): UsdPoolCheckpoint {
  let rate = "1";
  if (usd > 0) {
    for (let digits = 4; digits <= 14; digits++) {
      const candidate = (usd / eur).toFixed(digits);
      if (usdCentsToEurCents(usd, candidate) === eur) { rate = candidate; break; }
    }
  }
  return {
    record: "checkpoint", pool_key: POOL_KEY, kind: "opening", as_of: asOf, ts: endOfDaySeconds(asOf),
    usd_cents: usd, eur_cents: eur, fx_cents: 0, journal_id: null, document_number: null,
    rate, rate_date: asOf, approved: true, postings: [], recorded_at: "t",
  };
}

function tradesTool(options: Parameters<typeof setupPoolTool>[2] = {}) {
  return setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", ACCOUNTS, options);
}

const buy = (ts: string, ref: string, gross: string, fee = "0"): string[] =>
  [ts, ref, "NVDA", "US67066G1040", "Buy", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
const sell = (ts: string, ref: string, gross: string, fee: string): string[] =>
  [ts, ref, "AMD", "US0079031078", "Sell", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
const gain = (ts: string, cost: string, proceeds: string): string[] =>
  [ts, "AMD", "AMD", "US0079031078", "United States", "equity", "0", "1", cost, proceeds, (Number(proceeds) - Number(cost)).toFixed(2)];
/** USD→EUR conversion, fee on the USD leg: USD −usdGross / fee / −net, EUR +eur. */
const convOut = (ts: string, ref: string, usdGross: string, usdFee: string, eur: string): string[][] => {
  const usdNet = (Number(usdGross) - Number(usdFee)).toFixed(2);
  return [
    [ts, ref, "", "", "Conversion", "0", "USD", "0", `-${usdGross}`, String(Number(eur) / Number(usdNet)), usdFee, `-${usdNet}`, "0"],
    [ts, ref, "", "", "Conversion", "0", "EUR", "0", eur, String(Number(usdNet) / Number(eur)), "0", eur, "0"],
  ];
};
/** USD→EUR conversion, fee on the EUR leg: USD −usd, EUR gross / fee / net. */
const convOutEurFee = (ts: string, ref: string, usd: string, eurGross: string, eurFee: string): string[][] => {
  const eurNet = (Number(eurGross) - Number(eurFee)).toFixed(2);
  return [
    [ts, ref, "", "", "Conversion", "0", "USD", "0", `-${usd}`, String(Number(eurGross) / Number(usd)), "0", `-${usd}`, "0"],
    [ts, ref, "", "", "Conversion", "0", "EUR", "0", eurGross, String(Number(usd) / Number(eurGross)), eurFee, eurNet, "0"],
  ];
};

/** EUR→USD conversion (fee on the EUR leg) that pays a USD buy 1:1. */
const convIn = (ts: string, ref: string, usd: string, eurGross: string): string[][] => [
  [ts, ref, "", "", "Conversion", "0", "EUR", "0", `-${eurGross}`, String(Number(usd) / Number(eurGross)), "0", `-${eurGross}`, "0"],
  [ts, ref, "", "", "Conversion", "0", "USD", "0", usd, String(Number(eurGross) / Number(usd)), "0", usd, "0"],
];
const dividend = (ts: string, ref: string, net: string): string[] => [ts, ref, "AMD", "US0079031078", "Dividend", "0", "USD", "0", net, "0", "0", net, "0"];

type Line = { accounts_id: number; type: string; amount: number };
function journal(env: { created: CreatedJournal[] }, ref: string): Line[] | undefined {
  return env.created.find(entry => entry.document_number === `LY:${ref}`)?.postings?.map(({ accounts_id, type, amount }) => ({ accounts_id, type, amount }));
}

function resultFor(payload: LightyearTradesPayload, reference: string) {
  return payload.results.find(row => String(row.reference).includes(reference));
}

function reviewCode(payload: LightyearTradesPayload, reference: string): string | undefined {
  const text = (payload.warnings ?? []).find(warning => warning.includes(reference));
  return text ? /FX review \[([a-z_]+)\]/.exec(text)?.[1] : undefined;
}

function poolEvents(env: { store: { records: unknown[] } }): UsdPoolEvent[] {
  return env.store.records.filter((record): record is UsdPoolEvent => (record as { record: string }).record === "event");
}

function poolEnd(env: { store: { records: unknown[] } }, start: UsdPoolCheckpoint): { usd: number; eur: number } {
  return poolEvents(env).reduce((sum, event) => ({ usd: sum.usd + event.usd_cents, eur: sum.eur + event.eur_cents }), { usd: start.usd_cents, eur: start.eur_cents });
}

describe("book_lightyear_trades — USD→EUR conversions relieve the pool (plan Q4)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockReset();
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockReset();
    mockedReadFileCapped.mockImplementation(async (path: string) => Buffer.from(
      path === GAINS_PATH ? `${GAINS_HEADER}\n${gainsRows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n` : lightyearStatementCsv(statementRows),
      "utf8",
    ));
  });

  it.each([
    ["1 (loss, full relief)", opening(20018, 17101), convOut("12/04/2026 20:35:07", "CN-TESTQ4C1", "200.18", "0.70", "170.12"),
      [{ accounts_id: 8335, type: "D", amount: 0.6 }, { accounts_id: 8500, type: "D", amount: 0.29 }, { accounts_id: 1120, type: "C", amount: 0.89 }], { usd: 0, eur: 0 }],
    ["2 (gain, partial relief)", opening(19980, 17023), convOut("25/04/2026 10:00:00", "CN-TESTQ4C1", "100.00", "0.35", "85.01"),
      [{ accounts_id: 8335, type: "D", amount: 0.3 }, { accounts_id: 8500, type: "C", amount: 0.11 }, { accounts_id: 1120, type: "C", amount: 0.19 }], { usd: 9980, eur: 8503 }],
    ["3 (loss, partial relief, large pool)", opening(174825, 151540), convOut("20/08/2026 10:00:00", "CN-TESTQ4C1", "250.00", "0.88", "213.34"),
      [{ accounts_id: 8335, type: "D", amount: 0.75 }, { accounts_id: 8500, type: "D", amount: 2.61 }, { accounts_id: 1120, type: "C", amount: 3.36 }], { usd: 149825, eur: 129870 }],
    ["4 (gain, full relief)", opening(800196, 694306), convOut("24/09/2026 10:00:00", "CN-TESTQ4C1", "8001.96", "28.01", "7012.53"),
      [{ accounts_id: 8335, type: "D", amount: 24.63 }, { accounts_id: 8500, type: "C", amount: 94.1 }, { accounts_id: 1120, type: "D", amount: 69.47 }], { usd: 0, eur: 0 }],
    ["1 with the fee on the EUR leg (synthetic)", opening(20018, 17101), convOutEurFee("12/04/2026 20:35:07", "CN-TESTQ4C1", "200.18", "170.72", "0.60"),
      [{ accounts_id: 8335, type: "D", amount: 0.6 }, { accounts_id: 8500, type: "D", amount: 0.29 }, { accounts_id: 1120, type: "C", amount: 0.89 }], { usd: 0, eur: 0 }],
  ] as const)("example %s books to the cent", async (_label, start, rows, postings, end) => {
    load([...rows]);
    const env = tradesTool({ pool: [start] });
    const { dry, exec } = await env.book();
    expect(resultFor(dry.payload, "CN-TESTQ4C1")).toMatchObject({ status: "would_create", type: "Conversion", pool: { kind: "conversion_out" } });
    expect(exec.result.isError).toBeFalsy();
    expect(journal(env, "CN-TESTQ4C1")).toEqual(postings);
    expect(poolEvents(env)).toMatchObject([{ ref: "CN-TESTQ4C1", kind: "conversion_out", state: "committed" }]);
    expect(poolEnd(env, start)).toEqual(end);
    // The stored record carries the journal's canonical postings (r1 #6).
    expect(poolEvents(env)[0]!.postings).toHaveLength(postings.length);
  });

  it("example 2 then the follow-on buy: 99.80 USD at ECB 1.1749 relieves the remaining €85.03 with +0.09 FX", async () => {
    const start = opening(19980, 17023);
    load([...convOut("25/04/2026 10:00:00", "CN-TESTQ4C2", "100.00", "0.35", "85.01"), buy("27/04/2026 10:00:00", "OR-TESTQ4B2", "99.80", "0.10")]);
    const env = tradesTool({ pool: [start], fetch: rateFetch("1.1749") });
    await env.book();
    expect(journal(env, "OR-TESTQ4B2")).toEqual([
      { accounts_id: 1550, type: "D", amount: 84.85 },
      { accounts_id: 8335, type: "D", amount: 0.09 },
      { accounts_id: 8500, type: "D", amount: 0.09 },
      { accounts_id: 1120, type: "C", amount: 85.03 },
    ]);
    expect(poolEnd(env, start)).toEqual({ usd: 0, eur: 0 });
  });

  it("example 5: 0.37 USD → €0.31 with no fee and no FX books no journal; the event stands on its evidence", async () => {
    const start = opening(37, 31);
    load(convOut("13/01/2026 10:00:00", "CN-TESTQ4C5", "0.37", "0", "0.31"));
    const env = tradesTool({ pool: [start] });
    const { dry, exec } = await env.book();
    expect(resultFor(dry.payload, "CN-TESTQ4C5")).toMatchObject({ status: "would_record", pool: { kind: "conversion_out", relief_eur: 0.31 } });
    expect(dry.payload.created).toBe(0);
    expect(resultFor(exec.payload, "CN-TESTQ4C5")).toMatchObject({ status: "recorded" });
    expect(env.create).not.toHaveBeenCalled();
    const [event] = poolEvents(env);
    expect(event).toMatchObject({ kind: "conversion_out", journal_id: null, journal_broker_net_cents: 0, usd_cents: -37, eur_cents: -31, state: "committed", postings: [] });
    expect(event!.source_evidence).toMatchObject({ ref: "CN-TESTQ4C5", state_before: { usd_cents: 37, eur_cents: 31 }, relief_eur_cents: 31, fee_eur_cents: 0, fx_eur_cents: 0 });
    expect(event!.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(poolEnd(env, start)).toEqual({ usd: 0, eur: 0 });
    // The next run sees the committed event (no intent) and books nothing again.
    const again = await env.run({ dry_run: true });
    expect(resultFor(again.payload, "CN-TESTQ4C5")).toBeUndefined();
    expect(env.store.records.filter(record => record.record === "event" && record.state === "intent")).toEqual([]);
  });

  it("broker net 0 with a nonzero fee and FX is a normal journal: D 8335 0.30 / C 8500 0.30", async () => {
    const start = opening(10000, 8500);
    load(convOut("25/04/2026 10:00:00", "CN-TESTQ4N0", "100.00", "0.35", "85.00"));
    const env = tradesTool({ pool: [start] });
    const { dry } = await env.book();
    expect(resultFor(dry.payload, "CN-TESTQ4N0")).toMatchObject({ status: "would_create" });
    expect(journal(env, "CN-TESTQ4N0")).toEqual([{ accounts_id: 8335, type: "D", amount: 0.3 }, { accounts_id: 8500, type: "C", amount: 0.3 }]);
    expect(poolEvents(env)[0]).toMatchObject({ journal_id: 9001, journal_broker_net_cents: 0 });
  });

  it("fees on both legs are conversion_fee_conflict; the later pool buy stops", async () => {
    const both = convOut("12/04/2026 20:35:07", "CN-TESTQ4FF", "200.18", "0.70", "170.12");
    both[1]![8] = "170.72"; both[1]![10] = "0.60";
    load([...both, buy("20/04/2026 10:00:00", "OR-TESTQ4FB", "50.00")]);
    const env = tradesTool({ pool: [opening(30000, 26000)] });
    const dry = await env.run({ dry_run: true });
    expect(reviewCode(dry.payload, "CN-TESTQ4FF")).toMatch(/^conversion_(fee|amount)_conflict$/);
    expect(resultFor(dry.payload, "CN-TESTQ4FF")).toMatchObject({ status: "skipped" });
    expect(reviewCode(dry.payload, "OR-TESTQ4FB")).toBe("usd_pool_prerequisite_failed");
  });

  it("a conversion larger than the pool is usd_pool_insufficient and stops later commands", async () => {
    load([...convOut("12/04/2026 20:35:07", "CN-TESTQ4BIG", "300.00", "0", "255.00"), buy("20/04/2026 10:00:00", "OR-TESTQ4AFT", "1.00")]);
    const env = tradesTool({ pool: [opening(20000, 17000)] });
    const { dry } = await env.book();
    expect(reviewCode(dry.payload, "CN-TESTQ4BIG")).toBe("usd_pool_insufficient");
    expect(reviewCode(dry.payload, "OR-TESTQ4AFT")).toBe("usd_pool_prerequisite_failed");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("T-FC9: a conflicting same-reference copy of an unpaired conversion holds it and every later pool command", async () => {
    const rows = convOut("12/04/2026 20:35:07", "CN-TESTQ4DUP", "100.00", "0", "85.00");
    const copy = [...rows[0]!]; copy[8] = "-101.00"; copy[11] = "-101.00";
    load([...rows, copy, buy("20/04/2026 10:00:00", "OR-TESTQ4DB", "10.00")]);
    const env = tradesTool({ pool: [opening(20000, 17000)] });
    const { dry } = await env.book();
    expect(resultFor(dry.payload, "CN-TESTQ4DUP")).toMatchObject({ status: "skipped" });
    expect(reviewCode(dry.payload, "OR-TESTQ4DB")).toBe("usd_pool_prerequisite_failed");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("a hand-booked LY:CN journal with no pool record is usd_pool_prerequisite_unbooked for the later buy", async () => {
    load([...convOut("12/04/2026 20:35:07", "CN-TESTQ4HB", "100.00", "0", "85.00"), buy("20/04/2026 10:00:00", "OR-TESTQ4HBB", "10.00")]);
    const handBooked: Journal = { id: 801, document_number: "LY:CN-TESTQ4HB", effective_date: "2026-04-12", registered: true, is_deleted: false, postings: [] };
    const dry = await tradesTool({ pool: [opening(20000, 17000)], journals: [handBooked] }).run({ dry_run: true });
    expect(resultFor(dry.payload, "CN-TESTQ4HB")).toBeUndefined();
    expect(reviewCode(dry.payload, "OR-TESTQ4HBB")).toBe("usd_pool_prerequisite_unbooked");
  });

  it("a journal edited to 30.00 / 30.00 (same broker net) is seen at readback: partial_execution", async () => {
    load(convOut("25/04/2026 10:00:00", "CN-TESTQ4E1", "100.00", "0.35", "85.00"));
    const env = tradesTool({ pool: [opening(10000, 8500)] });
    const dry = await env.run({ dry_run: true });
    const get = env.api.journals.get.getMockImplementation()!;
    env.api.journals.get.mockImplementation(async (id: number) => {
      const read = await get(id);
      return { ...read, postings: read.postings!.map(p => ({ ...p, amount: 30 })) };
    });
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.payload.execution_report).toMatchObject({ status: "partial_execution", stop_reason: { code: "usd_pool_commit_deferred" } });
    expect(poolEvents(env)).toMatchObject([{ ref: "CN-TESTQ4E1", state: "intent" }]);
  });

  it("the same edit after commit breaks the chain at the next validation", async () => {
    load([...convOut("25/04/2026 10:00:00", "CN-TESTQ4E2", "100.00", "0.35", "85.00"), buy("27/04/2026 10:00:00", "OR-TESTQ4E2B", "10.00")]);
    const env = tradesTool({ pool: [opening(20000, 17000)] });
    load(convOut("25/04/2026 10:00:00", "CN-TESTQ4E2", "100.00", "0.35", "85.00"));
    await env.book();
    const booked = env.ledger.get(9001)!;
    env.ledger.set(9001, { ...booked, postings: booked.postings!.map(p => ({ ...p, amount: 30 })) });
    load([...convOut("25/04/2026 10:00:00", "CN-TESTQ4E2", "100.00", "0.35", "85.00"), buy("27/04/2026 10:00:00", "OR-TESTQ4E2B", "10.00")]);
    const again = await env.run({ dry_run: true });
    expect(reviewCode(again.payload, "OR-TESTQ4E2B")).toBe("usd_pool_chain_broken");
  });

  it("the same edit before recovery commits the intent is usd_pool_uncertain_outcome", async () => {
    load(convOut("25/04/2026 10:00:00", "CN-TESTQ4E3", "100.00", "0.35", "85.00"));
    const env = tradesTool({ pool: [opening(10000, 8500)] });
    const dry = await env.run({ dry_run: true });
    const upsert = env.store.upsert.bind(env.store);
    let calls = 0;
    env.store.upsert = records => { calls += 1; if (calls === 2) throw new Error("disk full"); upsert(records); };
    await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    env.store.upsert = upsert;
    expect(poolEvents(env)).toMatchObject([{ ref: "CN-TESTQ4E3", state: "intent" }]);
    const booked = env.ledger.get(9001)!;
    env.ledger.set(9001, { ...booked, postings: booked.postings!.map(p => ({ ...p, amount: 30 })) });
    load([...convOut("25/04/2026 10:00:00", "CN-TESTQ4E3", "100.00", "0.35", "85.00"), buy("27/04/2026 10:00:00", "OR-TESTQ4E3B", "10.00")]);
    const retry = await env.run({ dry_run: true });
    expect(JSON.stringify(retry.payload)).toContain("usd_pool_uncertain_outcome");
    expect(poolEvents(env)).toMatchObject([{ ref: "CN-TESTQ4E3", state: "intent" }]);
  });

  describe("a recorded journal-free conversion (example 5 on a 37.00 USD / €31.00 pool)", () => {
    const CN = convOut("13/01/2026 10:00:00", "CN-TESTQ4JF", "0.37", "0", "0.31");
    const LATER = buy("20/01/2026 10:00:00", "OR-TESTQ4JFB", "10.00");
    async function recorded() {
      load(CN);
      const env = tradesTool({ pool: [opening(3700, 3100)] });
      const { exec } = await env.book();
      expect(resultFor(exec.payload, "CN-TESTQ4JF")).toMatchObject({ status: "recorded" });
      return env;
    }

    it("a statement edited to −0.38 USD breaks the chain", async () => {
      const env = await recorded();
      const edited = CN.map(row => [...row]);
      edited[0]![8] = "-0.38"; edited[0]![11] = "-0.38";
      load([...edited, LATER]);
      expect(reviewCode((await env.run({ dry_run: true })).payload, "OR-TESTQ4JFB")).toBe("usd_pool_chain_broken");
    });

    it("a live LY: journal for the reference breaks the chain", async () => {
      const env = await recorded();
      env.ledger.set(500, { id: 500, document_number: "LY:CN-TESTQ4JF", effective_date: "2026-01-13", registered: true, is_deleted: false, postings: [] });
      load([...CN, LATER]);
      expect(reviewCode((await env.run({ dry_run: true })).payload, "OR-TESTQ4JFB")).toBe("usd_pool_chain_broken");
    });

    it("an unedited rerun values the later buy from the replayed 36.63 USD / €30.69", async () => {
      const env = await recorded();
      load([...CN, LATER]);
      const { dry } = await env.book();
      expect(resultFor(dry.payload, "OR-TESTQ4JFB")).toMatchObject({ status: "would_create", pool: { relief_eur: 8.38 } });
    });

    it("a crash between the journal-free write and the next command leaves a committed event and no intent", async () => {
      load([...CN, LATER]);
      const env = tradesTool({ pool: [opening(3700, 3100)] });
      const dry = await env.run({ dry_run: true });
      const upsert = env.store.upsert.bind(env.store);
      let calls = 0;
      env.store.upsert = records => { calls += 1; if (calls === 2) throw new Error("disk full"); upsert(records); };
      await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
      env.store.upsert = upsert;
      expect(poolEvents(env)).toMatchObject([{ ref: "CN-TESTQ4JF", state: "committed", journal_id: null }]);
      const retry = await env.run({ dry_run: true });
      expect(resultFor(retry.payload, "CN-TESTQ4JF")).toBeUndefined();
      expect(resultFor(retry.payload, "OR-TESTQ4JFB")).toMatchObject({ status: "would_create" });
    });

    it("a later run on a statement that does not cover the day accepts it on the stored evidence (zero-FX checkpoint after it)", async () => {
      const env = await recorded();
      const revalue = (filePath: string, asOf: string) => setupPoolTool<LightyearFxRevaluationPayload>(
        "book_lightyear_fx_revaluation", { broker_account: 1120, as_of: asOf, expected_usd_holding: 36.63 },
        { store: env.store, journals: [...env.ledger.values()], fetch: rateFetch("1.1935") },
      ).book({ file_path: filePath });
      // 36.63 USD at 1.1935 = €30.69: no difference, a journal-free checkpoint.
      expect((await revalue(POOL_STATEMENT_PATH, "2026-01-31")).exec.payload.status).toBe("checkpoint_recorded");
      load([]);
      const later = await revalue("/tmp/AccountStatement-LY-TESTACCT1-2026-02-01_2026-10-30_en.csv", "2026-02-28");
      expect(later.dry.payload.status).toBe("would_record_checkpoint");
    });
  });

  it("full-month golden: April 2026 ends the pool at 0.00 USD / €0.00 with month FX +0.08", async () => {
    const start = opening(37, 31, "2026-03-31");
    load([
      dividend("02/04/2026 10:00:00", "DD-TESTQ4G1", "0.60"),
      dividend("06/04/2026 10:00:00", "DD-TESTQ4G2", "0.21"),
      sell("10/04/2026 10:00:00", "OR-TESTQ4GS0", "199.20", "0.20"),
      ...convOut("12/04/2026 20:35:07", "CN-TESTQ4GC1", "200.18", "0.70", "170.12"),
      sell("17/04/2026 14:10:12", "OR-TESTQ4GS1", "100.00", "0.10"),
      buy("17/04/2026 14:10:21", "OR-TESTQ4GB1", "99.90", "0.10"),
      sell("21/04/2026 10:00:00", "OR-TESTQ4GS2", "100.00", "0.10"),
      sell("22/04/2026 10:00:00", "OR-TESTQ4GS3", "100.00", "0.10"),
      sell("24/04/2026 10:00:00", "OR-TESTQ4GS4", "100.00", "0.10"),
      buy("24/04/2026 18:56:00", "OR-TESTQ4GB2", "99.90", "0.10"),
      ...convOut("25/04/2026 10:00:00", "CN-TESTQ4GC2", "100.00", "0.35", "85.01"),
      buy("27/04/2026 10:00:00", "OR-TESTQ4GB3", "99.80", "0.10"),
    ], ["10/04/2026 10:00:00", "17/04/2026 14:10:12", "21/04/2026 10:00:00", "22/04/2026 10:00:00", "24/04/2026 10:00:00"].map(ts => gain(ts, "60.00", "85.00")));
    const env = tradesTool({
      pool: [start, poolDistribution("DD-TESTQ4G1", "2026-04-02T10:00:00Z", 60, 52, 601, undefined, sourceDigestOf(statementRows, "DD-TESTQ4G1")), poolDistribution("DD-TESTQ4G2", "2026-04-06T10:00:00Z", 21, 18, 602, undefined, sourceDigestOf(statementRows, "DD-TESTQ4G2"))],
      journals: [poolJournal(601, "DD-TESTQ4G1", 52), poolJournal(602, "DD-TESTQ4G2", 18)],
      fetch: rateFetch("1.1500", { "2026-04-10": "1.1706", "2026-04-17": "1.1797", "2026-04-21": "1.1767", "2026-04-22": "1.1733", "2026-04-24": "1.1712", "2026-04-27": "1.1749" }),
    });
    const { exec } = await env.book({ capital_gains_file: GAINS_PATH });
    expect(exec.result.isError).toBeFalsy();
    expect(env.created).toHaveLength(10);
    const fx = (ref: string) => (journal(env, ref) ?? []).filter(line => line.accounts_id === 8500).map(line => (line.type === "D" ? 1 : -1) * line.amount);
    expect({ c1: fx("CN-TESTQ4GC1"), b1: fx("OR-TESTQ4GB1"), b2: fx("OR-TESTQ4GB2"), c2: fx("CN-TESTQ4GC2"), b3: fx("OR-TESTQ4GB3") })
      .toEqual({ c1: [0.29], b1: [], b2: [-0.19], c2: [-0.11], b3: [0.09] });
    const month = env.created.flatMap(entry => entry.postings ?? []).filter(line => line.accounts_id === 8500)
      .reduce((sum, line) => sum + (line.type === "D" ? 1 : -1) * Math.round(line.amount * 100), 0);
    expect(month).toBe(8);
    expect(poolEnd(env, start)).toEqual({ usd: 0, eur: 0 });

    // Month-end revaluation reuses the store and the ledger (drafts confirmed first): the quantity proof uses the pool USD (0.00).
    for (const entry of env.ledger.values()) entry.registered = true;
    const revaluation = setupPoolTool<LightyearFxRevaluationPayload>(
      "book_lightyear_fx_revaluation", { broker_account: 1120, as_of: "2026-04-30", expected_usd_holding: 0 },
      { store: env.store, journals: [...env.ledger.values()], fetch: rateFetch("1.1500") },
    );
    const { dry: revalueDry } = await revaluation.book();
    expect(revalueDry.payload).toMatchObject({ status: "would_record_checkpoint", usd_amount: 0, carrying_eur: 0 });
  });

  it("plan size: a 300-command trades plan fits the plan store", async () => {
    const rows: string[][] = [];
    for (let index = 0; index < 300; index++) {
      const day = String(1 + (index % 28)).padStart(2, "0");
      const month = String(1 + Math.floor(index / 30)).padStart(2, "0");
      const ts = `${day}/${month}/2026 10:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`;
      const usd = (10 + index / 100).toFixed(2);
      rows.push(...convIn(ts, `CN-TESTPS${index}`, usd, (Number(usd) * 0.85).toFixed(2)), buy(ts, `OR-TESTPS${index}`, usd));
    }
    load(rows);
    const dry = await tradesTool().run({ dry_run: true });
    expect(dry.result.isError).toBeFalsy();
    expect(dry.payload.results.filter(row => row.status === "would_create")).toHaveLength(300);
    expect(dry.payload.plan_handle).toEqual(expect.any(String));
  });
});
