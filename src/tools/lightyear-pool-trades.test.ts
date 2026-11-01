import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { lightyearStatementCsv } from "../__fixtures__/lightyear-rows.js";
import {
  POOL_STATEMENT_PATH,
  poolDistribution,
  poolJournal,
  poolOpening,
  rateFetch,
  setupPoolTool,
  type CreatedJournal,
} from "../__fixtures__/lightyear-pool-harness.js";
import { memoryUsdPoolStore } from "../__fixtures__/usd-pool-store.js";
import { initAccountingRulesConnection } from "../accounting-rules.js";
import type { PlanData } from "../plan-store.js";
import type { Journal } from "../types/api.js";
import type { EcbFetch } from "../fx/ecb-rates.js";
import { ecbResponse } from "../__fixtures__/lightyear-pool-harness.js";
import { createUsdPoolStore, type PoolKey, type UsdPoolEvent, type UsdPoolRecord } from "../lightyear/usd-pool.js";
import type { LightyearTradesPayload } from "./lightyear-investments.js";

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

function tradesTool(options: Parameters<typeof setupPoolTool>[2] = {}) {
  return setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", ACCOUNTS, options);
}

const withGains = { capital_gains_file: GAINS_PATH };

const buy = (ts: string, ref: string, gross: string, fee = "0"): string[] =>
  [ts, ref, "NVDA", "US67066G1040", "Buy", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
const sell = (ts: string, ref: string, gross: string, fee: string): string[] =>
  [ts, ref, "AMD", "US0079031078", "Sell", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
/** The capital-gains row a pool sell matches by identity (exact statement time, ticker, quantity). */
const gain = (ts: string, cost: string, proceeds: string): string[] =>
  [ts, "AMD", "AMD", "US0079031078", "United States", "equity", "0", "1", cost, proceeds, (Number(proceeds) - Number(cost)).toFixed(2)];
/** EUR→USD conversion: EUR leg −eurGross (fee on the EUR leg), USD leg +usd. */
const convIn = (ts: string, ref: string, usd: string, eurGross: string, eurFee = "0"): string[][] => {
  const eurNet = (Number(eurGross) - Number(eurFee)).toFixed(2);
  return [
    [ts, ref, "", "", "Conversion", "0", "EUR", "0", `-${eurGross}`, String(Number(usd) / Number(eurNet)), eurFee, `-${eurNet}`, "0"],
    [ts, ref, "", "", "Conversion", "0", "USD", "0", usd, String(Number(eurNet) / Number(usd)), "0", usd, "0"],
  ];
};

function journal(env: { created: CreatedJournal[] }, ref: string): Array<{ accounts_id: number; type: string; amount: number }> | undefined {
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

function poolTotals(env: { store: { records: unknown[] } }, openingUsd = 0, openingEur = 0): { usd: number; eur: number } {
  return poolEvents(env).reduce((sum, event) => ({ usd: sum.usd + event.usd_cents, eur: sum.eur + event.eur_cents }), { usd: openingUsd, eur: openingEur });
}

describe("book_lightyear_trades — USD sells kept in USD and pool-paid buys (plan Q3)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockReset();
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockReset();
    mockedReadFileCapped.mockImplementation(async (path: string) => Buffer.from(
      path === GAINS_PATH ? `${GAINS_HEADER}\n${gainsRows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n` : lightyearStatementCsv(statementRows),
      "utf8",
    ));
  });

  it("examples 1–3: a sell at a loss, then two N:1 buys draining the pool, to the cent", async () => {
    load([
      sell("16/03/2026 14:16:27", "OR-TESTQ3S1", "636.70", "0.64"),
      ...convIn("16/03/2026 14:48:24", "CN-TESTQ3C2", "1438.90", "1257.52", "4.39"),
      buy("16/03/2026 14:48:24", "OR-TESTQ3B2", "1975.20", "1.00"),
      ...convIn("16/03/2026 14:49:24", "CN-TESTQ3C3", "400.24", "349.84", "1.22"),
      buy("16/03/2026 14:49:25", "OR-TESTQ3B3", "500.00", "0.50"),
    ], [gain("16/03/2026 14:16:27", "610.30", "555.00")]);
    const env = tradesTool({ pool: [poolOpening(0, 0, "1.1478", "2026-02-28")], fetch: rateFetch("1.1478") });
    const { dry, exec } = await env.book(withGains);
    expect(resultFor(dry.payload, "OR-TESTQ3S1")).toMatchObject({
      status: "would_create", eur_amount: 554.72, cost_basis: 610.3, gain_loss: -55.58,
      pool: { kind: "sell_in", pool_usd: 636.06, pool_eur: 554.16, ecb: { rate: "1.1478" } },
    });
    expect(resultFor(dry.payload, "OR-TESTQ3B2")).toMatchObject({
      status: "would_create", pool: { kind: "buy_relief", pool_usd: -536.3, pool_ecb_eur: 467.24, relief_eur: 467.25 },
      fx_result: { account: 8500, amount: 0.01, kind: "loss" },
    });
    expect(exec.result.isError).toBeFalsy();
    expect(journal(env, "OR-TESTQ3S1")).toEqual([
      { accounts_id: 1120, type: "D", amount: 554.16 },
      { accounts_id: 8335, type: "D", amount: 0.56 },
      { accounts_id: 8335, type: "D", amount: 55.58 },
      { accounts_id: 1550, type: "C", amount: 610.3 },
    ]);
    expect(journal(env, "OR-TESTQ3B2")).toEqual([
      { accounts_id: 1550, type: "D", amount: 1719.5 },
      { accounts_id: 8335, type: "D", amount: 0.87 },
      { accounts_id: 8335, type: "D", amount: 4.39 },
      { accounts_id: 8500, type: "D", amount: 0.01 },
      { accounts_id: 1120, type: "C", amount: 1724.77 },
    ]);
    expect(journal(env, "OR-TESTQ3B3")).toEqual([
      { accounts_id: 1550, type: "D", amount: 435.09 },
      { accounts_id: 8335, type: "D", amount: 0.44 },
      { accounts_id: 8335, type: "D", amount: 1.22 },
      { accounts_id: 1120, type: "C", amount: 436.75 },
    ]);
    expect(poolEvents(env).map(event => [event.ref, event.kind, event.usd_cents, event.eur_cents, event.state])).toEqual([
      ["OR-TESTQ3S1", "sell_in", 63606, 55416, "committed"],
      ["OR-TESTQ3B2", "buy_relief", -53630, -46725, "committed"],
      ["OR-TESTQ3B3", "buy_relief", -9976, -8691, "committed"],
    ]);
    expect(poolTotals(env)).toEqual({ usd: 0, eur: 0 });
  });

  it("example 4: a sell at a gain and a 100 % pool buy nine seconds later", async () => {
    load([
      sell("17/04/2026 14:10:12", "OR-TESTQ3S4", "100.00", "0.10"),
      buy("17/04/2026 14:10:21", "OR-TESTQ3B4", "99.90", "0.10"),
    ], [gain("17/04/2026 14:10:12", "61.65", "85.00")]);
    const env = tradesTool({ pool: [poolOpening(0, 0, "1.1797", "2026-03-31")], fetch: rateFetch("1.1797") });
    const { dry } = await env.book(withGains);
    // Lightyear says +23.34 (its own rate); the ECB-valued gain is the booked one.
    expect(resultFor(dry.payload, "OR-TESTQ3S4")).toMatchObject({ gain_loss: 23.11, lightyear_capital_gains_eur: 23.35 });
    expect(journal(env, "OR-TESTQ3S4")).toEqual([
      { accounts_id: 1120, type: "D", amount: 84.68 },
      { accounts_id: 8335, type: "D", amount: 0.08 },
      { accounts_id: 1550, type: "C", amount: 61.65 },
      { accounts_id: 8330, type: "C", amount: 23.11 },
    ]);
    expect(journal(env, "OR-TESTQ3B4")).toEqual([
      { accounts_id: 1550, type: "D", amount: 84.6 },
      { accounts_id: 8335, type: "D", amount: 0.08 },
      { accounts_id: 1120, type: "C", amount: 84.68 },
    ]);
    expect(poolTotals(env)).toEqual({ usd: 0, eur: 0 });
  });

  it("example 5: a 100 % buy relieved at average carrying value books the realised FX gain on 8500", async () => {
    load([
      sell("21/04/2026 10:00:00", "OR-TESTQ3S5A", "100.00", "0.10"),
      sell("22/04/2026 10:00:00", "OR-TESTQ3S5B", "100.00", "0.10"),
      sell("24/04/2026 10:00:00", "OR-TESTQ3S5C", "100.00", "0.10"),
      buy("24/04/2026 18:56:00", "OR-TESTQ3B5", "99.90", "0.10"),
    ], [
      gain("21/04/2026 10:00:00", "80.00", "85.00"),
      gain("22/04/2026 10:00:00", "80.00", "85.20"),
      gain("24/04/2026 10:00:00", "80.00", "85.40"),
    ]);
    const env = tradesTool({
      pool: [poolOpening(0, 0, "1.1797", "2026-03-31")],
      fetch: rateFetch("1.1712", { "2026-04-21": "1.1767", "2026-04-22": "1.1733" }),
    });
    const { dry } = await env.book(withGains);
    expect(dry.payload.results.filter(row => row.pool?.kind === "sell_in").map(row => row.pool!.pool_eur)).toEqual([84.9, 85.14, 85.3]);
    expect(resultFor(dry.payload, "OR-TESTQ3B5")).toMatchObject({ pool: { pool_ecb_eur: 85.3, relief_eur: 85.11 }, fx_result: { account: 8500, amount: 0.19, kind: "gain" } });
    expect(journal(env, "OR-TESTQ3B5")).toEqual([
      { accounts_id: 1550, type: "D", amount: 85.21 },
      { accounts_id: 8335, type: "D", amount: 0.09 },
      { accounts_id: 8500, type: "C", amount: 0.19 },
      { accounts_id: 1120, type: "C", amount: 85.11 },
    ]);
    expect(poolTotals(env)).toEqual({ usd: 19980, eur: 17023 });
  });

  it("example 6: an N:1 buy paid partly from retained dividend cash", async () => {
    load([
      ["12/06/2026 10:00:00", "DD-TESTQ3D6", "AMD", "US0079031078", "Dividend", "0", "USD", "0", "0.70", "0", "0", "0.60", "0.10"],
      ...convIn("12/06/2026 13:49:05", "CN-TESTQ3C6", "98.84", "85.74", "0.30"),
      buy("12/06/2026 13:49:05", "OR-TESTQ3B6", "99.44", "0.10"),
    ]);
    const env = tradesTool({
      pool: [poolOpening(0, 0, "1.1567", "2026-05-31"), poolDistribution("DD-TESTQ3D6", "2026-06-12T10:00:00Z", 60, 52, 601, 8330)],
      journals: [poolJournal(601, "DD-TESTQ3D6", 52, 8330)],
      fetch: rateFetch("1.1567"),
    });
    await env.book();
    expect(journal(env, "OR-TESTQ3B6")).toEqual([
      { accounts_id: 1550, type: "D", amount: 85.87 },
      { accounts_id: 8335, type: "D", amount: 0.09 },
      { accounts_id: 8335, type: "D", amount: 0.3 },
      { accounts_id: 1120, type: "C", amount: 86.26 },
    ]);
    expect(poolTotals(env)).toEqual({ usd: 0, eur: 0 });
  });

  // ---- refusals and failure classes (plan Q3; T-FC1–T-FC8) -------------------------------------------
  // Opening 100 USD / €90 (2026-03-31). S: a sell kept in USD, net 100.00 at ECB 1.25 → €80.00 (pool 200 / €170).
  // B: a 150 USD buy paid 100 % from the pool → relief 150 × 170 / 200 = €127.50 (without S it is usd_pool_insufficient).
  const OPENING = poolOpening(10000, 9000, "1.1111111111", "2026-03-31");
  const S = sell("10/04/2026 10:00:00", "OR-TESTFCS", "100.10", "0.10");
  const S_GAIN = gain("10/04/2026 10:00:00", "70.00", "80.08");
  const B = buy("20/04/2026 10:00:00", "OR-TESTFCB", "150.00");
  const fcTool = (options: Parameters<typeof setupPoolTool>[2] = {}) => tradesTool({ pool: [OPENING], fetch: rateFetch("1.25"), ...options });

  it("the S/B fixture books: sell €80 in, buy relieves €127.50", async () => {
    load([S, B], [S_GAIN]);
    const env = fcTool();
    const { exec } = await env.book(withGains);
    expect(exec.result.isError).toBeFalsy();
    expect(resultFor(exec.payload, "OR-TESTFCB")).toMatchObject({ pool: { relief_eur: 127.5 } });
    expect(poolTotals(env, 10000, 9000)).toEqual({ usd: 5000, eur: 4250 });
  });

  it("a pool sell without a timestamp-matched gains row is skipped and every later pool command is usd_pool_prerequisite_failed", async () => {
    load([S, B], [gain("10/04/2026 10:00:01", "70.00", "80.08")]);
    const env = fcTool();
    const { dry, exec } = await env.book(withGains);
    expect(resultFor(dry.payload, "OR-TESTFCS")).toMatchObject({ status: "skipped" });
    expect(reviewCode(dry.payload, "OR-TESTFCS")).toBe("pool_sell_gains_unmatched");
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_prerequisite_failed");
    expect(exec.payload.created).toBe(0);
    expect(env.create).not.toHaveBeenCalled();
  });

  it("two gains rows for the sell's timestamp are ambiguous: skipped, never guessed", async () => {
    load([S, B], [S_GAIN, gain("10/04/2026 10:00:00", "60.00", "80.08")]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    expect((dry.payload.warnings ?? []).some(warning => warning.includes("Ambiguous FIFO match") && warning.includes("OR-TESTFCS"))).toBe(true);
    expect(resultFor(dry.payload, "OR-TESTFCS")).toMatchObject({ status: "skipped" });
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_prerequisite_failed");
  });

  it("a pool sell's gains row naming another ISIN is never its cost basis", async () => {
    const otherIsin = [...S_GAIN];
    otherIsin[3] = "US0000000001";
    load([S, B], [otherIsin]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    expect(resultFor(dry.payload, "OR-TESTFCS")).toMatchObject({ status: "skipped" });
    expect(reviewCode(dry.payload, "OR-TESTFCS")).toBe("pool_sell_gains_unmatched");
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_prerequisite_failed");
  });

  it("two same-second pool sells competing for one gains row: neither takes it, in any statement order", async () => {
    const S2 = sell("10/04/2026 10:00:00", "OR-TESTFCS2", "100.10", "0.10");
    for (const rows of [[S, S2, B], [S2, S, B]]) {
      load(rows, [S_GAIN]);
      const env = fcTool();
      const dry = await env.run({ ...withGains, dry_run: true });
      expect(reviewCode(dry.payload, "OR-TESTFCS")).toBe("pool_sell_gains_unmatched");
      expect(reviewCode(dry.payload, "OR-TESTFCS2")).toBe("pool_sell_gains_unmatched");
      expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_prerequisite_failed");
    }
  });

  it("a logged pool event whose USD amount a later statement changes stops later pool commands (usd_pool_source_changed)", async () => {
    // Opening 100 USD / €90; DIV logged as +100 USD / €80 (ECB 1.25). A later export shows DIV as 200 USD:
    // the 150 USD buy must not relieve €127.50 from the logged state as if nothing changed.
    const div = (net: string): string[] => ["01/04/2026 10:00:00", "DD-TESTSRC1", "AMD", "US0079031078", "Dividend", "0", "USD", "0", net, "0", "0", net, "0"];
    load([div("100.00"), B]);
    const dist = setupPoolTool<{ created?: number }>("book_lightyear_distributions",
      { broker_account: 1120, income_account: 8330, tax_account: 8610, fee_account: 8610, fx_source: "ecb" },
      { pool: [OPENING], fetch: rateFetch("1.25") });
    await dist.book();
    expect(poolTotals(dist, 10000, 9000)).toEqual({ usd: 20000, eur: 17000 });
    const journals = [...dist.ledger.values()].map(j => ({ ...j, registered: true }));

    const same = fcTool({ store: memoryUsdPoolStore(structuredClone(dist.store.records) as UsdPoolRecord[]), journals });
    const unchanged = await same.run({ dry_run: true });
    expect(resultFor(unchanged.payload, "OR-TESTFCB")).toMatchObject({ status: "would_create", pool: { relief_eur: 127.5 } });

    load([div("200.00"), B]);
    const changed = fcTool({ store: memoryUsdPoolStore(structuredClone(dist.store.records) as UsdPoolRecord[]), journals });
    const dry = await changed.run({ dry_run: true });
    expect(resultFor(dry.payload, "OR-TESTFCB")).toMatchObject({ status: "skipped" });
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_source_changed");
  });

  it("T-FC3: with no pool key (account not in the file name) a pool sell is a review and nothing is written", async () => {
    load([S, B], [S_GAIN]);
    const env = fcTool();
    const { dry, exec } = await env.book({ ...withGains, file_path: "/tmp/statement.csv" });
    expect(reviewCode(dry.payload, "OR-TESTFCS")).toBe("usd_pool_account_unknown");
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_account_unknown");
    expect(exec.payload.created ?? 0).toBe(0);
    expect(env.create).not.toHaveBeenCalled();
    expect(env.store.records).toEqual([OPENING]);
  });

  it("a sell dated on or before the opening is usd_pool_before_opening", async () => {
    load([S, B], [S_GAIN]);
    const dry = await fcTool({ pool: [poolOpening(10000, 9000, "1.1111111111", "2026-04-10")] }).run({ ...withGains, dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTFCS")).toBe("usd_pool_before_opening");
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_prerequisite_failed");
  });

  const committedRelief = (ref: string, iso: string, usd: number, eur: number, journalId: number): { event: UsdPoolEvent; journal: Journal } => ({
    event: {
      record: "event", pool_key: OPENING.pool_key, ref, ts: Date.parse(iso) / 1000, kind: "buy_relief", usd_cents: -usd, eur_cents: -eur,
      document_number: `LY:${ref}`, journal_id: journalId, journal_broker_net_cents: -eur, state: "committed", recorded_at: "t",
      postings: [{ accounts_id: 1120, accounts_dimensions_id: null, type: "C", amount_cents: eur }, { accounts_id: 1550, accounts_dimensions_id: null, type: "D", amount_cents: eur }],
    },
    journal: {
      id: journalId, document_number: `LY:${ref}`, effective_date: iso.slice(0, 10), registered: true, is_deleted: false,
      postings: [{ accounts_id: 1550, type: "D", amount: eur / 100 }, { accounts_id: 1120, type: "C", amount: eur / 100 }],
    },
  });

  it("T-FC4: a sell dated before a committed relief is usd_pool_backdated_event", async () => {
    const relief = committedRelief("OR-TESTFCR", "2026-04-15T10:00:00Z", 5000, 4500, 701);
    load([S], [S_GAIN]);
    const env = fcTool({ pool: [OPENING, relief.event], journals: [relief.journal] });
    const { dry } = await env.book(withGains);
    expect(reviewCode(dry.payload, "OR-TESTFCS")).toBe("usd_pool_backdated_event");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("T-FC5: a sell held by a reference conflict stops the later 100 % buy (not usd_pool_insufficient)", async () => {
    load([S, ["10/04/2026 11:00:00", "OR-TESTFCS", "VWCE", "IE00BK5BQT80", "Buy", "1", "EUR", "51", "51.00", "1", "0", "51.00", "0"], B], [S_GAIN]);
    const env = fcTool();
    const { dry } = await env.book(withGains);
    expect(dry.payload.results.filter(row => String(row.reference).includes("OR-TESTFCS")).every(row => row.status === "skipped")).toBe(true);
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_prerequisite_failed");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("an ECB failure for the sell day reviews the sell and stops later pool commands", async () => {
    const good = rateFetch("1.25");
    const fetch = vi.fn(async (url: string, init: { signal: AbortSignal }) => {
      const params = new URL(url).searchParams;
      return params.get("startPeriod")! <= "2026-04-10" && params.get("endPeriod")! >= "2026-04-10" ? ecbResponse("", 503) : good(url, init);
    }) as ReturnType<typeof vi.fn> & EcbFetch;
    load([S, buy("20/05/2026 10:00:00", "OR-TESTFCB", "150.00")], [S_GAIN]);
    const dry = await fcTool({ fetch }).run({ ...withGains, dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTFCS")).toBe("ecb_rate_unavailable");
    expect(reviewCode(dry.payload, "OR-TESTFCB")).toBe("usd_pool_prerequisite_failed");
  });

  it("T-FC8: execute books from the frozen plan while the ECB source throws", async () => {
    load([S, B], [S_GAIN]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    env.fetch.mockImplementation(async () => { throw new Error("network must not be used at execute"); });
    env.ecbCache.clear();
    const fetches = env.fetch.mock.calls.length;
    const exec = await env.run({ ...withGains, dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.isError).toBeFalsy();
    expect(env.create).toHaveBeenCalledTimes(2);
    expect(env.fetch.mock.calls.length).toBe(fetches);
  });

  it("T-FC6: a sell read back with a different broker amount is partial_execution and the buy is not created", async () => {
    load([S, B], [S_GAIN]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    const get = env.api.journals.get.getMockImplementation()!;
    env.api.journals.get.mockImplementation(async (id: number) => {
      const journal = await get(id);
      return id !== 9001 ? journal : { ...journal, postings: journal.postings!.map(p => p.accounts_id === 1120 ? { ...p, amount: 79 } : p) };
    });
    const exec = await env.run({ ...withGains, dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(env.create).toHaveBeenCalledTimes(1);
    expect(exec.payload.execution_report).toMatchObject({ status: "partial_execution", stop_reason: { code: "usd_pool_commit_deferred" } });
    expect(poolEvents(env)).toMatchObject([{ ref: "OR-TESTFCS", state: "intent" }]);
  });

  it("T-FC2: a commit failure after the sell's journal is recovered on the next run without a second journal", async () => {
    load([S, B], [S_GAIN]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    const upsert = env.store.upsert.bind(env.store);
    let calls = 0;
    env.store.upsert = records => { calls += 1; if (calls === 2) throw new Error("disk full"); upsert(records); };
    const exec = await env.run({ ...withGains, dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.payload.usd_pool_notes?.join(" ")).toContain("usd_pool_commit_deferred");
    expect(env.create).toHaveBeenCalledTimes(1);
    expect(poolEvents(env)).toMatchObject([{ ref: "OR-TESTFCS", state: "intent" }]);
    // The next run (S is now booked) recovers S's intent before valuing B from the committed state.
    const { dry: retry, exec: retryExec } = await env.book(withGains);
    expect(resultFor(retry.payload, "OR-TESTFCB")).toMatchObject({ status: "would_create", pool: { relief_eur: 127.5 } });
    expect(retryExec.result.isError).toBeFalsy();
    expect(poolEvents(env)).toMatchObject([
      { ref: "OR-TESTFCS", state: "committed", journal_id: 9001 },
      { ref: "OR-TESTFCB", state: "committed", journal_id: 9002 },
    ]);
    expect(env.created.map(journal => journal.document_number)).toEqual(["LY:OR-TESTFCS", "LY:OR-TESTFCB"]);
  });

  it("T-FC1: a stale-cache process cannot book a sell before another process's committed relief", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usd-pool-q3-two-process-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    process.env.EARVELDAJA_LOCK_DIR = join(dir, "locks");
    try {
      initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" }));
      const processA = createUsdPoolStore();
      const processB = createUsdPoolStore();
      processA.upsert([OPENING]);
      expect(processB.read()).toHaveLength(1);
      const relief = committedRelief("OR-TESTFCA", "2026-04-15T10:00:00Z", 5000, 4500, 701);
      const viewB = { ...memoryUsdPoolStore(), get records(): UsdPoolRecord[] { return processB.read() ?? []; }, read: () => processB.read(), upsert: (records: UsdPoolRecord[]) => processB.upsert(records), remove: (keys: string[]) => processB.remove(keys), reset: () => processB.reset() };
      load([S], [S_GAIN]);
      const env = fcTool({ store: viewB, journals: [relief.journal] });
      const dry = await env.run({ ...withGains, dry_run: true });
      expect(resultFor(dry.payload, "OR-TESTFCS")).toMatchObject({ status: "would_create" });
      processA.upsert([relief.event]);
      expect(processB.read()).toHaveLength(1); // still stale outside the lock
      const exec = await env.run({ ...withGains, dry_run: false, plan_handle: dry.payload.plan_handle });
      expect(exec.result.content[0]!.text).toContain("plan_drift");
      expect(env.create).not.toHaveBeenCalled();
      const again = await env.run({ ...withGains, dry_run: true });
      expect(reviewCode(again.payload, "OR-TESTFCS")).toBe("usd_pool_backdated_event");
      expect(processA.read()!.filter(record => record.record === "event").map(record => (record as UsdPoolEvent).ref)).toEqual(["OR-TESTFCA"]);
    } finally {
      delete process.env.EARVELDAJA_RULES_DIR;
      delete process.env.EARVELDAJA_LOCK_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["the frozen rate string with equal cents (1.25 → 1.250001)", (outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }>) => {
      for (const outcome of Object.values(outcomes)) if (outcome.rate) outcome.rate.rate = "1.250001";
    }],
    ["the frozen rate date", (outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }>) => {
      for (const outcome of Object.values(outcomes)) if (outcome.rate) outcome.rate.rate_date = "2026-04-09";
    }],
  ])("drift: altering %s in the plan is plan_drift and books nothing", async (_label, tamper) => {
    load([S, B], [S_GAIN]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    const consume = env.context.planStore.consume.bind(env.context.planStore);
    vi.spyOn(env.context.planStore, "consume").mockImplementation((handle, domain) => {
      const plan = consume(handle, domain);
      const privatePayload = structuredClone(plan.privatePayload) as unknown as { fx_outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }> };
      tamper(privatePayload.fx_outcomes);
      return { ...plan, privatePayload: privatePayload as unknown as PlanData };
    });
    const exec = await env.run({ ...withGains, dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
  });

  it.each([
    ["the gains row's cost basis", () => load([S, B], [gain("10/04/2026 10:00:00", "71.00", "80.08")])],
    ["the pairing (a conversion now funds the buy)", () => load([S, ...convIn("20/04/2026 09:59:30", "CN-TESTFCD", "50.00", "40.00"), B], [S_GAIN])],
  ])("drift: a change to %s between dry run and execute books nothing", async (_label, change) => {
    load([S, B], [S_GAIN]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    change();
    const exec = await env.run({ ...withGains, dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.isError).toBe(true);
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
    expect(poolEvents(env)).toEqual([]);
  });

  it("mixed second (Codex r1 #2) with a real sell: +100 USD (€80) and a 50 USD buy in one second are refused, and every later spend", async () => {
    const mixedSell = sell("10/04/2026 10:00:00", "OR-TESTMXS", "100.00", "0");
    const mixedGain = gain("10/04/2026 10:00:00", "70.00", "80.00");
    load([mixedSell, buy("10/04/2026 10:00:00", "OR-TESTMXB1", "50.00"), buy("20/04/2026 10:00:00", "OR-TESTMXB2", "10.00")], [mixedGain]);
    const env = fcTool();
    const dry = await env.run({ ...withGains, dry_run: true });
    // Neither €45 (buy first, from 100 / €90) nor €42.50 (sell first, from 200 / €170) is produced.
    expect(reviewCode(dry.payload, "OR-TESTMXS")).toBe("usd_pool_ambiguous_order");
    expect(reviewCode(dry.payload, "OR-TESTMXB1")).toBe("usd_pool_ambiguous_order");
    expect(reviewCode(dry.payload, "OR-TESTMXB2")).toBe("usd_pool_ambiguous_order");
    expect(dry.payload.results.some(row => row.pool?.relief_eur !== undefined)).toBe(false);
    // Control: the buy one second later relieves €42.50 and leaves 150 USD / €127.50.
    load([mixedSell, buy("10/04/2026 10:00:01", "OR-TESTMXB1", "50.00")], [mixedGain]);
    const control = fcTool();
    const { dry: controlDry } = await control.book(withGains);
    expect(resultFor(controlDry.payload, "OR-TESTMXB1")).toMatchObject({ pool: { relief_eur: 42.5 } });
    expect(poolTotals(control, 10000, 9000)).toEqual({ usd: 15000, eur: 12750 });
  });

  it("T-FC7: 200 random sell/buy sequences book balanced cents, never take the pool negative, and close it at zero", async () => {
    let seed = 20261101;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const money = (cents: number) => (cents / 100).toFixed(2);
    for (let sequence = 0; sequence < 200; sequence++) {
      const rows: string[][] = [];
      const gains: string[][] = [];
      const rates: Record<string, string> = {};
      let usd = 0;
      const steps = 2 + Math.floor(random() * 4);
      for (let step = 0; step < steps; step++) {
        const day = String(1 + step * 5).padStart(2, "0");
        const ts = `${day}/04/2026 10:00:00`;
        rates[`2026-04-${day}`] = (1.05 + random() * 0.2).toFixed(4);
        const last = step === steps - 1;
        if (!last && (usd === 0 || random() < 0.5)) {
          const net = 100 + Math.floor(random() * 50000);
          const fee = Math.floor(random() * 50);
          rows.push(sell(ts, `OR-TESTR${sequence}S${step}`, money(net + fee), money(fee)));
          gains.push(gain(ts, money(Math.floor(net * 0.8)), money(net)));
          usd += net;
        } else {
          // The last step spends whatever is left, so the pool must close at exactly 0 / €0.
          const gross = last ? usd : 1 + Math.floor(random() * usd);
          if (gross === 0) continue;
          const fee = Math.min(gross - 1, Math.floor(random() * 30));
          rows.push(buy(ts, `OR-TESTR${sequence}B${step}`, money(gross), money(fee)));
          usd -= gross;
        }
      }
      load(rows, gains);
      const env = tradesTool({ pool: [poolOpening(0, 0, "1.1", "2026-03-31")], fetch: rateFetch("1.1", rates) });
      const { exec } = await env.book(withGains);
      expect(exec.result.isError, `sequence ${sequence}`).toBeFalsy();
      expect(env.created).toHaveLength(rows.length);
      for (const created of env.created) {
        const signed = created.postings!.reduce((sum, p) => sum + Math.round(p.amount * 100) * (p.type === "D" ? 1 : -1), 0);
        expect(signed, `sequence ${sequence} ${created.document_number}`).toBe(0);
        expect(created.postings!.every(p => p.amount > 0 && Math.abs(p.amount * 100 - Math.round(p.amount * 100)) < 1e-6)).toBe(true);
      }
      let running = { usd: 0, eur: 0 };
      for (const event of poolEvents(env)) {
        running = { usd: running.usd + event.usd_cents, eur: running.eur + event.eur_cents };
        expect(running.usd).toBeGreaterThanOrEqual(0);
        expect(running.eur).toBeGreaterThanOrEqual(0);
        if (running.usd === 0) expect(running.eur, `sequence ${sequence}`).toBe(0);
      }
      expect(running).toEqual({ usd: 0, eur: 0 });
    }
  }, 120_000);
});
