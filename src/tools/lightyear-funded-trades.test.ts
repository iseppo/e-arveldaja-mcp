import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import { memoryUsdPoolStore } from "../__fixtures__/usd-pool-store.js";
import { sourceDigestOf } from "../__fixtures__/lightyear-pool-harness.js";
import type { ApiContext } from "./crud/shared.js";
import type { Journal } from "../types/api.js";
import type { EcbFetch, EcbFetchResponse } from "../fx/ecb-rates.js";
import { endOfDaySeconds, type PoolKey, type UsdPoolCheckpoint, type UsdPoolEvent, type UsdPoolRecord } from "../lightyear/usd-pool.js";
import {
  extractTradesForTesting,
  registerLightyearTools,
  tradeReservedConversionRefsWithFunding,
  type LightyearTradesPayload,
} from "./lightyear-investments.js";

vi.mock("../bounded-read.js", async () => {
  const actual = await vi.importActual<typeof import("../bounded-read.js")>("../bounded-read.js");
  return { ...actual, readFileCapped: vi.fn() };
});
vi.mock("../file-validation.js", () => ({ resolveFileInput: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const mockedReadFileCapped = vi.mocked(readFileCapped);
const mockedResolveFileInput = vi.mocked(resolveFileInput);

const STATEMENT_PATH = "/tmp/AccountStatement-LY-TESTACCT1-2026-09-01_2026-10-30_en.csv";
const HEADER = "Date,Reference,Ticker,ISIN,Type,Quantity,CCY,Price/share,Gross Amount,FX Rate,Fee,Net Amt.,Tax Amt.";
const ECB_HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS";
const CONNECTION = "lightyear-funded-test-connection";
const KEY: PoolKey = { connection_fingerprint: CONNECTION, lightyear_account: "TESTACCT1", broker_account: 1120, broker_dimension_id: null, currency: "USD" };

// Synthetic NVDA-shaped funded buy (plan worked example, fake references).
const FUNDING_SELL = ["19/10/2026 14:43:15", "OR-TESTSWEEP1", "ICSUSSDP", "IE00B44QSF52", "Sell", "9.05", "USD", "1", "9.05", "0", "0", "9.05", "0"];
const CONVERSION = [
  ["19/10/2026 14:43:48", "CN-TESTFUND1", "", "", "Conversion", "0", "EUR", "0", "-349.91", "1.121196", "1.22", "-348.69", "0"],
  ["19/10/2026 14:43:48", "CN-TESTFUND1", "", "", "Conversion", "0", "USD", "0", "390.95", "0.891904", "0", "390.95", "0"],
];
const FUNDED_BUY = ["19/10/2026 14:43:49", "OR-TESTBUY001", "NVDA", "US67066G1040", "Buy", "2", "USD", "199.80", "400.00", "0", "0.40", "399.60", "0"];
const DISTRIBUTIONS = [
  ["01/10/2026 10:00:00", "IN-TESTFUND01", "ICSUSSDP", "IE00B44QSF52", "Distribution", "0", "USD", "0", "8.06", "0", "0.31", "7.75", "0"],
  ["02/10/2026 10:00:00", "DD-TESTNVDA01", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "1.53", "0", "0", "1.30", "0.23"],
];
const EUR_BUY = ["20/10/2026 10:00:00", "OR-TESTEURBUY", "VWCE", "IE00BK5BQT80", "Buy", "1", "EUR", "100", "100.00", "1", "0", "100.00", "0"];

function statement(rows: string[][]): string {
  return `${HEADER}\n${rows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n`;
}

function ecbResponse(body: string, status = 200): EcbFetchResponse {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body };
}

type FetchMock = ReturnType<typeof vi.fn> & EcbFetch;

function rateFetch(rate = "1.1225"): FetchMock {
  // One observation per calendar day in the requested window, so every day resolves to itself.
  return vi.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    const days: string[] = [];
    for (let day = new Date(`${params.get("startPeriod")}T00:00:00Z`); day <= new Date(`${params.get("endPeriod")}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
      const iso = day.toISOString().slice(0, 10);
      if (iso < "2026-10-31") days.push(iso);
    }
    return ecbResponse([ECB_HEADER, ...days.map(day => `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${day},${rate},A`)].join("\n") + "\n");
  }) as FetchMock;
}

function opening(usd: number, eur: number, rate: string, asOf = "2026-09-30"): UsdPoolCheckpoint {
  return {
    record: "checkpoint", pool_key: KEY, kind: "opening", as_of: asOf, ts: endOfDaySeconds(asOf),
    usd_cents: usd, eur_cents: eur, fx_cents: 0, journal_id: null, document_number: null,
    rate, rate_date: asOf, approved: true, postings: [], recorded_at: "t",
  };
}

function poolEvent(ref: string, iso: string, usd: number, eur: number, journalId: number, sourceRows: string[][] = DISTRIBUTIONS): UsdPoolEvent {
  return {
    record: "event", pool_key: KEY, ref, ts: Date.parse(iso) / 1000, kind: "distribution_in", usd_cents: usd, eur_cents: eur,
    document_number: `LY:${ref}`, journal_id: journalId, journal_broker_net_cents: eur, state: "committed", source_digest: sourceDigestOf(sourceRows, ref), recorded_at: "t",
    postings: [{ accounts_id: 1120, accounts_dimensions_id: null, type: "D", amount_cents: eur }, { accounts_id: 8320, accounts_dimensions_id: null, type: "C", amount_cents: eur }],
  };
}

function poolJournal(id: number, ref: string, eurCents: number): Journal {
  return {
    id, document_number: `LY:${ref}`, effective_date: "2026-10-01", registered: true, is_deleted: false,
    postings: [{ accounts_id: 1120, type: "D", amount: eurCents / 100 }, { accounts_id: 8320, type: "C", amount: eurCents / 100 }],
  };
}

const WORKED_POOL: UsdPoolRecord[] = [
  opening(10000, 8900, "1.1236"),
  poolEvent("IN-TESTFUND01", "2026-10-01T10:00:00Z", 775, 686, 501),
  poolEvent("DD-TESTNVDA01", "2026-10-02T10:00:00Z", 130, 116, 502),
];
const WORKED_JOURNALS = [poolJournal(501, "IN-TESTFUND01", 686), poolJournal(502, "DD-TESTNVDA01", 116)];

interface CreatedJournal { document_number?: string; postings?: Array<{ accounts_id: number; type: string; amount: number }> }

function setup(options: { fetch?: FetchMock; pool?: UsdPoolRecord[]; journals?: Journal[] } = {}) {
  const server = { registerTool: vi.fn() };
  const ledger = new Map<number, Journal>((options.journals ?? []).map(j => [j.id!, j]));
  const created: CreatedJournal[] = [];
  const create = vi.fn(async (payload: CreatedJournal) => {
    created.push(payload);
    const id = 9000 + created.length;
    ledger.set(id, { id, registered: false, is_deleted: false, ...payload } as unknown as Journal);
    return { created_object_id: id };
  });
  const accounts = [1120, 1550, 8320, 8330, 8335, 8500, 8610].map(id => ({ id, is_deleted: false, is_valid: true, code: String(id), title_est: `Konto ${id}`, name_est: `Konto ${id}` }));
  const api = {
    readonly: {
      getAccounts: vi.fn().mockResolvedValue(accounts),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
    },
    journals: {
      connectionFingerprint: CONNECTION,
      invalidateListCache: vi.fn(),
      listAll: vi.fn(async () => [...ledger.values()]),
      get: vi.fn(async (id: number) => ledger.get(id)!),
      create,
    },
  };
  const fetch = options.fetch ?? rateFetch();
  const ecbCache = new Map();
  const store = memoryUsdPoolStore(options.pool ?? WORKED_POOL);
  const context = createTestRuntimeSafetyContext();
  registerLightyearTools(server as unknown as Parameters<typeof registerLightyearTools>[0], api as unknown as ApiContext, context, {
    ecb: { fetch, today: () => "2026-10-31", now: () => new Date("2026-10-31T08:00:00Z"), cache: ecbCache },
    usdPoolStore: store,
  });
  const registration = server.registerTool.mock.calls.find(call => call[0] === "book_lightyear_trades");
  if (!registration) throw new Error("book_lightyear_trades not registered");
  const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const run = async (args: Record<string, unknown> = {}) => {
    const result = await handler({ file_path: STATEMENT_PATH, investment_account: 1550, broker_account: 1120, ...args });
    return { result, payload: parseToolPayload<LightyearTradesPayload>(result.content[0]!.text) };
  };
  const book = async (args: Record<string, unknown> = {}) => {
    const dry = await run({ ...args, dry_run: true });
    const exec = await run({ ...args, dry_run: false, plan_handle: dry.payload.plan_handle });
    return { dry, exec };
  };
  return { api, ledger, create, created, fetch, ecbCache, store, context, run, book };
}

function loadStatement(rows: string[][]): void {
  mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(rows), "utf8"));
}

function resultFor(payload: LightyearTradesPayload, reference: string) {
  return payload.results.find(row => String(row.reference).includes(reference));
}

function reviewCode(payload: LightyearTradesPayload, reference: string): string | undefined {
  const text = (payload.warnings ?? []).find(warning => warning.includes(reference));
  return text ? /FX review \[([a-z_]+)\]/.exec(text)?.[1] : undefined;
}

describe("book_lightyear_trades — buys paid from the USD pool (C4, generalised in Q3)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockResolvedValue({ path: STATEMENT_PATH });
    mockedReadFileCapped.mockReset();
  });

  it("books the worked example to the cent and commits the buy_relief event", async () => {
    loadStatement([...DISTRIBUTIONS, FUNDING_SELL, ...CONVERSION, FUNDED_BUY, EUR_BUY]);
    const env = setup({ journals: WORKED_JOURNALS });
    const { dry, exec } = await env.book();
    const row = resultFor(dry.payload, "OR-TESTBUY001")!;
    expect(row).toMatchObject({ status: "would_create", eur_amount: 356.75, fx_result: { account: 8500, amount: 0.01, kind: "gain" } });
    expect(row.pool).toMatchObject({ kind: "buy_relief", pool_usd: -9.05, pool_eur: -8.05, pool_ecb_eur: 8.06, relief_eur: 8.05, ecb: { rate: "1.1225", rate_date: "2026-10-19" }, fx_rate_text: "1.1225 USD/EUR ECB 2026-10-19" });
    expect(String(row.pool!.conversion_reference)).toContain("CN-TESTFUND1");
    expect(exec.result.isError).toBeFalsy();
    const funded = env.created.find(journal => journal.document_number === "LY:OR-TESTBUY001")!;
    expect(funded.postings).toEqual([
      { accounts_id: 1550, type: "D", amount: 356.39 },
      { accounts_id: 8335, type: "D", amount: 0.36 },
      { accounts_id: 8335, type: "D", amount: 1.22 },
      { accounts_id: 8500, type: "C", amount: 0.01 },
      { accounts_id: 1120, type: "C", amount: 357.96 },
    ]);
    // The 1:1 EUR buy in the same file is unaffected.
    expect(env.created.find(journal => journal.document_number === "LY:OR-TESTEURBUY")!.postings).toEqual([
      { accounts_id: 1550, type: "D", amount: 100 },
      { accounts_id: 1120, type: "C", amount: 100 },
    ]);
    const relief = env.store.records.find((record): record is UsdPoolEvent => record.record === "event" && record.kind === "buy_relief");
    expect(relief).toMatchObject({ ref: "OR-TESTBUY001", state: "committed", usd_cents: -905, eur_cents: -805, journal_broker_net_cents: -35796, journal_id: 9001 });
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });

  it("a 100 % pool-funded buy (no conversion) books D investment / ±8500 / C broker relief", async () => {
    loadStatement([
      ["19/10/2026 14:43:15", "OR-TESTSWEEP2", "ICSUSSDP", "IE00B44QSF52", "Sell", "9.05", "USD", "1", "9.05", "0", "0", "9.05", "0"],
      ["19/10/2026 14:43:49", "OR-TESTBUY002", "NVDA", "US67066G1040", "Buy", "0.05", "USD", "181", "9.05", "0", "0", "9.05", "0"],
    ]);
    const env = setup({ pool: [opening(10000, 8900, "1.1236")] });
    await env.book();
    expect(env.created[0]!.postings).toEqual([
      { accounts_id: 1550, type: "D", amount: 8.06 },
      { accounts_id: 8500, type: "C", amount: 0.01 },
      { accounts_id: 1120, type: "C", amount: 8.05 },
    ]);
  });

  it("relieving the whole pool closes it exactly", async () => {
    loadStatement([
      ["19/10/2026 14:43:15", "OR-TESTSWEEP3", "ICSUSSDP", "IE00B44QSF52", "Sell", "100", "USD", "1", "100.00", "0", "0", "100.00", "0"],
      ["19/10/2026 14:43:49", "OR-TESTBUY003", "NVDA", "US67066G1040", "Buy", "0.5", "USD", "200", "100.00", "0", "0", "100.00", "0"],
    ]);
    const env = setup({ pool: [opening(10000, 8900, "1.1236")] });
    await env.book();
    const relief = env.store.records.find((record): record is UsdPoolEvent => record.record === "event")!;
    expect(relief).toMatchObject({ usd_cents: -10000, eur_cents: -8900 });
    expect(env.created[0]!.postings).toContainEqual({ accounts_id: 1120, type: "C", amount: 89 });
  });

  it("the fund sweep's timing does not matter: a sweep 61 s away gives the same N:1 relief (plan Q3)", async () => {
    loadStatement([...DISTRIBUTIONS, ["19/10/2026 14:42:48", ...FUNDING_SELL.slice(1)], ...CONVERSION, FUNDED_BUY]);
    const dry = await setup({ journals: WORKED_JOURNALS }).run({ dry_run: true });
    expect(resultFor(dry.payload, "OR-TESTBUY001")).toMatchObject({ status: "would_create", pool: { pool_usd: -9.05, relief_eur: 8.05 } });
  });

  it("two qualifying conversions → review, no guess", async () => {
    const second = CONVERSION.map(row => [row[0]!, "CN-TESTFUND2", ...row.slice(2)]);
    loadStatement([FUNDING_SELL, ...CONVERSION, ...second, FUNDED_BUY]);
    const dry = await setup().run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTBUY001")).toBe("invalid_conversion_pair");
  });

  it("the pool part is buy gross − conversion USD, whatever the same-window sweeps add up to", async () => {
    loadStatement([...DISTRIBUTIONS, FUNDING_SELL, ...CONVERSION, ["19/10/2026 14:43:49", "OR-TESTBUY001", "NVDA", "US67066G1040", "Buy", "2", "USD", "204.80", "410.00", "0", "0.40", "409.60", "0"]]);
    const dry = await setup({ journals: WORKED_JOURNALS }).run({ dry_run: true });
    // 410.00 − 390.95 = 19.05 USD from the pool (109.05 USD / €97.02): relief 19.05 × 9702 / 10905 = 16.95.
    expect(resultFor(dry.payload, "OR-TESTBUY001")).toMatchObject({ status: "would_create", pool: { pool_usd: -19.05, relief_eur: 16.95 } });
  });

  it("skip_tickers none (ICSUSSDP booked) turns the funded pass off", async () => {
    loadStatement([FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const dry = await setup().run({ dry_run: true, skip_tickers: "none" });
    expect(reviewCode(dry.payload, "OR-TESTBUY001")).toBe("invalid_conversion_pair");
  });

  it("a second buy in the window does not share the conversion: it is paid 100 % from the pool", () => {
    const { trades } = extractTradesForTesting(parseRowsForTest([FUNDING_SELL, ...CONVERSION, FUNDED_BUY, ["19/10/2026 14:43:50", "OR-TESTBUY004", "NVDA", "US67066G1040", "Buy", "0.05", "USD", "181", "9.05", "0", "0", "9.05", "0"]]), { fundingTickers: new Set(["ICSUSSDP"]) });
    expect(trades.find(t => t.reference === "OR-TESTBUY001")!.pool).toMatchObject({ kind: "buy_relief", conversion_ref: "CN-TESTFUND1", pool_usd_cents: 905 });
    expect(trades.find(t => t.reference === "OR-TESTBUY004")!.pool).toMatchObject({ kind: "buy_relief", conversion_ref: null, pool_usd_cents: 905 });
    expect(trades.find(t => t.reference === "OR-TESTBUY004")!.fx_review_reason?.code).toBe("usd_pool_funded");
  });

  it("parse/portfolio see a funded buy as a usd_pool_funded review; distributions never claim its conversion", () => {
    const rows = parseRowsForTest([FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const { trades, fundedConversionRefs } = extractTradesForTesting(rows, { fundingTickers: new Set(["ICSUSSDP"]) });
    expect(trades.find(t => t.reference === "OR-TESTBUY001")!.fx_review_reason?.code).toBe("usd_pool_funded");
    expect([...fundedConversionRefs]).toEqual(["CN-TESTFUND1"]);
    expect(tradeReservedConversionRefsWithFunding(rows, new Set(["ICSUSSDP"])).has("CN-TESTFUND1")).toBe(true);
    // Two-pass: without funding tickers the 1:1 pass alone leaves it unpaired.
    expect(extractTradesForTesting(rows).trades.find(t => t.reference === "OR-TESTBUY001")!.pool).toBeUndefined();
  });

  it("no opening checkpoint → usd_pool_checkpoint_missing, nothing guessed", async () => {
    loadStatement([FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const dry = await setup({ pool: [] }).run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTBUY001")).toBe("usd_pool_checkpoint_missing");
    expect(dry.payload.created).toBe(0);
  });

  it("ECB failure → ecb_rate_unavailable", async () => {
    loadStatement([...DISTRIBUTIONS, FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const dry = await setup({ journals: WORKED_JOURNALS, fetch: vi.fn(async () => ecbResponse("", 503)) as FetchMock }).run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTBUY001")).toBe("ecb_rate_unavailable");
  });

  const oneDollarBuy = (n: number): string[][] => [
    [`2${n}/10/2026 10:00:00`, `OR-TESTSW${n}`, "ICSUSSDP", "IE00B44QSF52", "Sell", "1", "USD", "1", "1.00", "0", "0", "1.00", "0"],
    [`2${n}/10/2026 10:00:10`, `OR-TESTB${n}`, "NVDA", "US67066G1040", "Buy", "0.005", "USD", "200", "1.00", "0", "0", "1.00", "0"],
  ];

  it("three 1.00 USD buys from a 3.00 USD / 1.00 EUR pool relieve 0.33, 0.34, 0.33", async () => {
    loadStatement([...oneDollarBuy(1), ...oneDollarBuy(2), ...oneDollarBuy(3)]);
    const env = setup({ pool: [opening(300, 100, "3")] });
    const { dry } = await env.book();
    expect([1, 2, 3].map(n => resultFor(dry.payload, `OR-TESTB${n}`)!.pool!.relief_eur)).toEqual([0.33, 0.34, 0.33]);
    expect(env.store.records.filter(record => record.record === "event").map(record => (record as UsdPoolEvent).eur_cents)).toEqual([-33, -34, -33]);
  });

  it("two 100.00 USD buys against a 100.00 USD pool: the first books, the second is usd_pool_insufficient", async () => {
    const hundred = (n: number): string[][] => [
      [`2${n}/10/2026 10:00:00`, `OR-TESTSW${n}`, "ICSUSSDP", "IE00B44QSF52", "Sell", "100", "USD", "1", "100.00", "0", "0", "100.00", "0"],
      [`2${n}/10/2026 10:00:10`, `OR-TESTB${n}`, "NVDA", "US67066G1040", "Buy", "0.5", "USD", "200", "100.00", "0", "0", "100.00", "0"],
    ];
    loadStatement([...hundred(1), ...hundred(2)]);
    const dry = await setup({ pool: [opening(10000, 8900, "1.1236")] }).run({ dry_run: true });
    expect(resultFor(dry.payload, "OR-TESTB1")).toMatchObject({ status: "would_create" });
    expect(reviewCode(dry.payload, "OR-TESTB2")).toBe("usd_pool_insufficient");
  });

  it("the first buy's ECB failure makes later pool buys usd_pool_prerequisite_failed", async () => {
    loadStatement([...oneDollarBuy(1), ...oneDollarBuy(2)]);
    const fetch = vi.fn(async (url: string) => url.includes("startPeriod=2026-10-14") ? ecbResponse("", 503) : rateFetch()(url, { signal: new AbortController().signal })) as FetchMock;
    const dry = await setup({ pool: [opening(300, 100, "3")], fetch }).run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTB1")).toBe("ecb_rate_unavailable");
    expect(reviewCode(dry.payload, "OR-TESTB2")).toBe("usd_pool_prerequisite_failed");
  });

  it("an unbooked retained distribution before the buy → usd_pool_prerequisite_unbooked", async () => {
    loadStatement([...DISTRIBUTIONS, FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const dry = await setup({ pool: [opening(10000, 8900, "1.1236")] }).run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTBUY001")).toBe("usd_pool_prerequisite_unbooked");
  });

  it("a logged distribution edited after logging → usd_pool_event_mismatch", async () => {
    loadStatement([...DISTRIBUTIONS, FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const edited = [poolJournal(501, "IN-TESTFUND01", 600), poolJournal(502, "DD-TESTNVDA01", 116)];
    const dry = await setup({ journals: edited }).run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTBUY001")).toBe("usd_pool_event_mismatch");
  });

  it("a pool event booked between dry run and execute → plan_drift, nothing created", async () => {
    loadStatement([FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const env = setup({ pool: [opening(10000, 8900, "1.1236")], journals: [poolJournal(503, "DD-TESTLATE01", 89)] });
    const dry = await env.run({ dry_run: true });
    env.store.upsert([poolEvent("DD-TESTLATE01", "2026-10-10T10:00:00Z", 100, 89, 503)]);
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("execute succeeds from the frozen plan while the ECB source throws", async () => {
    loadStatement([FUNDING_SELL, ...CONVERSION, FUNDED_BUY]);
    const env = setup({ pool: [opening(10000, 8900, "1.1236")] });
    const dry = await env.run({ dry_run: true });
    env.fetch.mockImplementation(async () => { throw new Error("network must not be used at execute"); });
    env.ecbCache.clear();
    const fetches = env.fetch.mock.calls.length;
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.isError).toBeFalsy();
    expect(env.create).toHaveBeenCalledTimes(1);
    expect(env.fetch.mock.calls.length).toBe(fetches);
  });

  it("a definitive create rejection stops the later pool buys of the plan", async () => {
    loadStatement([...oneDollarBuy(1), ...oneDollarBuy(2)]);
    const env = setup({ pool: [opening(300, 100, "3")] });
    const dry = await env.run({ dry_run: true });
    const { HttpError } = await import("../http-client.js");
    env.create.mockImplementationOnce(async () => { throw new HttpError("rejected", 400, "POST", "/journals"); });
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(env.create).toHaveBeenCalledTimes(1);
    expect(exec.payload.execution_report).toBeDefined();
    expect(env.store.records.filter(record => record.record === "event")).toEqual([]);
  });

  it("exact balanced cents on random conversion/fund splits", async () => {
    let seed = 12345;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 40; i++) {
      const grossCents = 1000 + Math.floor(random() * 99000);
      const poolCents = 1 + Math.floor(random() * Math.min(grossCents - 1, 9000));
      const convUsd = grossCents - poolCents;
      const convEur = Math.max(1, Math.round(convUsd / 1.13));
      const feeEur = Math.floor(random() * 300);
      const tradeFee = Math.floor(random() * 50);
      const cents = (value: number) => (value / 100).toFixed(2);
      loadStatement([
        ["19/10/2026 14:43:15", "OR-TESTSWR", "ICSUSSDP", "IE00B44QSF52", "Sell", cents(poolCents), "USD", "1", cents(poolCents), "0", "0", cents(poolCents), "0"],
        ["19/10/2026 14:43:48", "CN-TESTR", "", "", "Conversion", "0", "EUR", "0", `-${cents(convEur + feeEur)}`, String(convUsd / convEur), cents(feeEur), `-${cents(convEur)}`, "0"],
        ["19/10/2026 14:43:48", "CN-TESTR", "", "", "Conversion", "0", "USD", "0", cents(convUsd), String(convEur / convUsd), "0", cents(convUsd), "0"],
        ["19/10/2026 14:43:49", "OR-TESTBR", "NVDA", "US67066G1040", "Buy", "1", "USD", cents(grossCents - tradeFee), cents(grossCents), "0", cents(tradeFee), cents(grossCents - tradeFee), "0"],
      ]);
      const env = setup({ pool: [opening(10000, 8900, "1.1236")] });
      const { dry } = await env.book();
      expect(resultFor(dry.payload, "OR-TESTBR")).toMatchObject({ status: "would_create" });
      const postings = env.created[0]!.postings!;
      const signed = postings.reduce((sum, p) => sum + Math.round(p.amount * 100) * (p.type === "D" ? 1 : -1), 0);
      expect(signed).toBe(0);
      expect(postings.every(p => Number.isInteger(Math.round(p.amount * 100)) && Math.abs(p.amount * 100 - Math.round(p.amount * 100)) < 1e-6)).toBe(true);
    }
  });

  it("review wpc 3: a statement that does not reach back to the checkpoint is usd_pool_statement_gap", async () => {
    // Opening 100 USD / €90 on 2026-09-30; an unlogged 100 USD / €80 distribution on Oct 1 sits outside a
    // shorter Oct 15–30 statement holding only a 100 USD fund-paid buy. Valued from the pool alone the buy
    // would relieve €90 (not €85) and book a €10 FX loss at ECB 1.25 (not €5): it must stay in review.
    const rows = [
      ["19/10/2026 14:43:15", "OR-TESTSWGAP", "ICSUSSDP", "IE00B44QSF52", "Sell", "100", "USD", "1", "100.00", "0", "0", "100.00", "0"],
      ["19/10/2026 14:43:49", "OR-TESTBUYGAP", "NVDA", "US67066G1040", "Buy", "0.5", "USD", "200", "100.00", "0", "0", "100.00", "0"],
    ];
    const short = "/tmp/AccountStatement-LY-TESTACCT1-2026-10-15_2026-10-30_en.csv";
    mockedResolveFileInput.mockResolvedValue({ path: short });
    loadStatement(rows);
    const env = setup({ pool: [opening(10000, 9000, "1.1111111111")], fetch: rateFetch("1.25") });
    const dry = await env.run({ file_path: short, dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTBUYGAP")).toBe("usd_pool_statement_gap");
    expect(resultFor(dry.payload, "OR-TESTBUYGAP")).toMatchObject({ status: "skipped" });
    // The full statement shows the unlogged distribution and blocks on it instead.
    mockedResolveFileInput.mockResolvedValue({ path: STATEMENT_PATH });
    loadStatement([["01/10/2026 10:00:00", "DD-TESTUNLOG", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "100.00", "0", "0", "100.00", "0"], ...rows]);
    const full = await env.run({ dry_run: true });
    expect(reviewCode(full.payload, "OR-TESTBUYGAP")).toBe("usd_pool_prerequisite_unbooked");
    expect(env.create).not.toHaveBeenCalled();
  });

  const poolBuy = (day: string, n: string, usd: string): string[][] => [
    [`${day}/10/2026 10:00:00`, `OR-TESTSWP${n}`, "ICSUSSDP", "IE00B44QSF52", "Sell", usd, "USD", "1", usd, "0", "0", usd, "0"],
    [`${day}/10/2026 10:00:10`, `OR-TESTBUY${n}`, "NVDA", "US67066G1040", "Buy", String(Number(usd) / 200), "USD", "200", usd, "0", "0", usd, "0"],
  ];

  const MID1 = ["21/10/2026 10:00:00", "DD-TESTMID01", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "100.00", "0", "0", "100.00", "0"];
  const MID2 = ["21/10/2026 10:00:00", "DD-TESTMID02", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "100.00", "0", "0", "100.00", "0"];

  it("review wpc 5: a held earlier spend stops the later one instead of being assumed (€31.50 vs €34.75)", async () => {
    // Opening 100 USD / €89. The Oct 20 50 USD buy is held (its reference is booked on Oct 21: date mismatch);
    // a +100 USD / €50 distribution is logged on Oct 21; the Oct 22 buy spends 50 USD. Assuming the held buy
    // consumed €44.50 would relieve €31.50; the logged state (200 USD / €139) requires €34.75. It must not book €31.50.
    loadStatement([...poolBuy("20", "M1", "50.00"), MID1, ...poolBuy("22", "M2", "50.00")]);
    const mismatched = { id: 701, document_number: "OR-TESTBUYM1", effective_date: "2026-10-21", registered: true, is_deleted: false, postings: [] } as unknown as Journal;
    const env = setup({
      pool: [opening(10000, 8900, "1.1236"), poolEvent("DD-TESTMID01", "2026-10-21T10:00:00Z", 10000, 5000, 601, [MID1])],
      journals: [poolJournal(601, "DD-TESTMID01", 5000), mismatched],
    });
    const dry = await env.run({ dry_run: true });
    expect(resultFor(dry.payload, "OR-TESTBUYM1")).toMatchObject({ status: "skipped", candidate_journal_ids: [701] });
    expect(resultFor(dry.payload, "OR-TESTBUYM2")).toMatchObject({ status: "skipped" });
    expect(resultFor(dry.payload, "OR-TESTBUYM2")!.pool).toBeUndefined();
    expect(reviewCode(dry.payload, "OR-TESTBUYM2")).toBe("usd_pool_prerequisite_failed");
    expect(dry.payload.created).toBe(0);
  });

  it("review wpc 6: a relief read back as €44 instead of €45 stops the next pool purchase", async () => {
    // From 100 USD / €90: the 50 USD buy expects €45 relief; readback shows €44. The 25 USD buy would post €22.50
    // although the carrying value left would need €23 — it must not be created; the first journal id and intent are reported.
    loadStatement([...poolBuy("20", "R1", "50.00"), ...poolBuy("22", "R2", "25.00")]);
    const env = setup({ pool: [opening(10000, 9000, "1.1111111111")] });
    const dry = await env.run({ dry_run: true });
    expect(resultFor(dry.payload, "OR-TESTBUYR1")!.pool!.relief_eur).toBe(45);
    expect(resultFor(dry.payload, "OR-TESTBUYR2")!.pool!.relief_eur).toBe(22.5);
    const get = env.api.journals.get.getMockImplementation()!;
    env.api.journals.get.mockImplementation(async (id: number) => {
      const journal = await get(id);
      if (id !== 9001) return journal;
      return { ...journal, postings: journal.postings!.map(p => p.accounts_id === 1120 ? { ...p, amount: 44 } : p) };
    });
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(env.create).toHaveBeenCalledTimes(1);
    expect(exec.payload.execution_report).toMatchObject({
      status: "partial_execution",
      stop_reason: { code: "usd_pool_commit_deferred" },
      known_object_ids: [expect.objectContaining({ entity_id: 9001, outcome: "created" })],
    });
    expect(resultFor(exec.payload, "OR-TESTBUYR1")).toMatchObject({ journal_id: 9001 });
    expect(exec.payload.usd_pool_notes?.[0]).toContain("journal 9001");
    expect(env.store.records.filter(record => record.record === "event")).toMatchObject([{ ref: "OR-TESTBUYR1", state: "intent" }]);
  });

  it("review wpc r2: a funded buy conflicting with a non-funded same-reference copy stops the later spend (€31.50/€8.50 vs €34.75/€5.25)", async () => {
    // Opening 100 USD / €89. The Oct 20 50 USD fund buy shares its reference with a €51 EUR row, so both are skipped;
    // +100 USD / €50 is logged Oct 21; the Oct 22 50 USD buy at ECB 1.25 must be held, not valued at €31.50 relief /
    // €8.50 FX gain (assuming the skipped buy); valued from the logged state it would be €34.75 / €5.25.
    loadStatement([
      ...poolBuy("20", "C1", "50.00"),
      ["20/10/2026 11:00:00", "OR-TESTBUYC1", "VWCE", "IE00BK5BQT80", "Buy", "0.51", "EUR", "100", "51.00", "1", "0", "51.00", "0"],
      MID2,
      ...poolBuy("22", "C2", "50.00"),
    ]);
    const env = setup({
      pool: [opening(10000, 8900, "1.1236"), poolEvent("DD-TESTMID02", "2026-10-21T10:00:00Z", 10000, 5000, 602, [MID2])],
      journals: [poolJournal(602, "DD-TESTMID02", 5000)],
      fetch: rateFetch("1.25"),
    });
    const dry = await env.run({ dry_run: true });
    expect(dry.payload.results.filter(row => String(row.reference).includes("OR-TESTBUYC1")).every(row => row.status === "skipped")).toBe(true);
    expect(resultFor(dry.payload, "OR-TESTBUYC2")).toMatchObject({ status: "skipped" });
    expect(resultFor(dry.payload, "OR-TESTBUYC2")!.pool).toBeUndefined();
    expect(reviewCode(dry.payload, "OR-TESTBUYC2")).toBe("usd_pool_prerequisite_failed");
    expect(dry.payload.created).toBe(0);
  });
});

function parseRowsForTest(rows: string[][]) {
  const numeric = (value: string | undefined): number => value?.trim() ? Number.parseFloat(value) : 0;
  return rows.map((fields, row_index) => ({
    row_index,
    date: fields[0]!,
    reference: fields[1]!,
    ticker: fields[2]!,
    isin: fields[3]!,
    type: fields[4]! as "Buy" | "Sell" | "Conversion",
    quantity: numeric(fields[5]),
    ccy: fields[6]!,
    price_per_share: numeric(fields[7]),
    gross_amount: numeric(fields[8]),
    fx_rate: numeric(fields[9]),
    fee: numeric(fields[10]),
    net_amount: numeric(fields[11]),
    tax_amount: numeric(fields[12]),
  }));
}
