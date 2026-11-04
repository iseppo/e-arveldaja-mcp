import { sourceDigestOf } from "../__fixtures__/lightyear-pool-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import { memoryUsdPoolStore } from "../__fixtures__/usd-pool-store.js";
import type { ApiContext } from "./crud/shared.js";
import type { Journal } from "../types/api.js";
import type { EcbFetch, EcbFetchResponse } from "../fx/ecb-rates.js";
import { endOfDaySeconds, type PoolKey, type UsdPoolCheckpoint, type UsdPoolEvent, type UsdPoolRecord } from "../lightyear/usd-pool.js";
import { registerLightyearTools, type LightyearDistributionsPayload, type LightyearFxRevaluationPayload } from "./lightyear-investments.js";
import { rateFetch as harnessRateFetch, setupPoolTool } from "../__fixtures__/lightyear-pool-harness.js";

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
const CONNECTION = "lightyear-reval-test-connection";
const KEY: PoolKey = { connection_fingerprint: CONNECTION, lightyear_account: "TESTACCT1", broker_account: 1120, broker_dimension_id: null, currency: "USD" };
const DOC = "LY-FX:TESTACCT1:USD:2026-10-30";

// Statement after the opening: the plan's C3 + C4 worked examples (synthetic references).
const ROWS = [
  ["01/10/2026 10:00:00", "IN-TESTFUND01", "ICSUSSDP", "IE00B44QSF52", "Distribution", "0", "USD", "0", "8.06", "0", "0.31", "7.75", "0"],
  ["02/10/2026 10:00:00", "DD-TESTNVDA01", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "1.53", "0", "0", "1.30", "0.23"],
  ["19/10/2026 14:43:15", "OR-TESTSWEEP1", "ICSUSSDP", "IE00B44QSF52", "Sell", "9.05", "USD", "1", "9.05", "0", "0", "9.05", "0"],
  ["19/10/2026 14:43:48", "CN-TESTFUND1", "", "", "Conversion", "0", "EUR", "0", "-349.91", "1.121196", "1.22", "-348.69", "0"],
  ["19/10/2026 14:43:48", "CN-TESTFUND1", "", "", "Conversion", "0", "USD", "0", "390.95", "0.891904", "0", "390.95", "0"],
  ["19/10/2026 14:43:49", "OR-TESTBUY001", "NVDA", "US67066G1040", "Buy", "2", "USD", "199.80", "400.00", "0", "0.40", "399.60", "0"],
];

function statement(rows: string[][]): string {
  return `${HEADER}\n${rows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n`;
}

function ecbResponse(body: string, status = 200): EcbFetchResponse {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body };
}

type FetchMock = ReturnType<typeof vi.fn> & EcbFetch;

function rateFetch(rate: string): FetchMock {
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

function poolEvent(ref: string, iso: string, kind: UsdPoolEvent["kind"], usd: number, eur: number, journalId: number, brokerNet = eur): UsdPoolEvent {
  return {
    record: "event", pool_key: KEY, ref, ts: Date.parse(iso) / 1000, kind, usd_cents: usd, eur_cents: eur,
    document_number: `LY:${ref}`, journal_id: journalId, journal_broker_net_cents: brokerNet, state: "committed", source_digest: sourceDigestOf(ROWS, ref), effective_date: "2026-10-01", recorded_at: "t",
    postings: [{ accounts_id: 1120, accounts_dimensions_id: null, type: brokerNet >= 0 ? "D" : "C", amount_cents: Math.abs(brokerNet) }],
  };
}

function journal(id: number, documentNumber: string, brokerNetCents: number, registered = true): Journal {
  return {
    id, document_number: documentNumber, effective_date: "2026-10-01", registered, is_deleted: false,
    postings: [{ accounts_id: 1120, type: brokerNetCents >= 0 ? "D" : "C", amount: Math.abs(brokerNetCents) / 100 }],
  };
}

// Pool after C3 + C4: 100.00 USD / 88.97 EUR.
const POOL: UsdPoolRecord[] = [
  opening(10000, 8900, "1.1236"),
  poolEvent("IN-TESTFUND01", "2026-10-01T10:00:00Z", "distribution_in", 775, 686, 501),
  poolEvent("DD-TESTNVDA01", "2026-10-02T10:00:00Z", "distribution_in", 130, 116, 502),
  poolEvent("OR-TESTBUY001", "2026-10-19T14:43:49Z", "buy_relief", -905, -805, 503, -35796),
];
const JOURNALS = [journal(501, "LY:IN-TESTFUND01", 686), journal(502, "LY:DD-TESTNVDA01", 116), journal(503, "LY:OR-TESTBUY001", -35796)];

interface CreatedJournal { document_number?: string; postings?: Array<{ accounts_id: number; type: string; amount: number }> }

function setup(options: { rate?: string; fetch?: FetchMock; pool?: UsdPoolRecord[]; journals?: Journal[] } = {}) {
  const server = { registerTool: vi.fn() };
  const ledger = new Map<number, Journal>((options.journals ?? JOURNALS).map(j => [j.id!, structuredClone(j)]));
  const created: CreatedJournal[] = [];
  const create = vi.fn(async (payload: CreatedJournal) => {
    created.push(payload);
    const id = 9000 + created.length;
    ledger.set(id, { id, registered: false, is_deleted: false, ...payload } as unknown as Journal);
    return { created_object_id: id };
  });
  const accounts = [1120, 8320, 8330, 8335, 8500, 8610].map(id => ({ id, is_deleted: false, is_valid: true, code: String(id), title_est: `Konto ${id}`, name_est: `Konto ${id}` }));
  const api = {
    readonly: { getAccounts: vi.fn().mockResolvedValue(accounts), getAccountDimensions: vi.fn().mockResolvedValue([]) },
    journals: {
      connectionFingerprint: CONNECTION,
      invalidateListCache: vi.fn(),
      listAll: vi.fn(async () => [...ledger.values()]),
      get: vi.fn(async (id: number) => ledger.get(id)!),
      create,
    },
  };
  const fetch = options.fetch ?? rateFetch(options.rate ?? "1.1172");
  const ecbCache = new Map();
  const store = memoryUsdPoolStore(options.pool ?? POOL);
  registerLightyearTools(server as unknown as Parameters<typeof registerLightyearTools>[0], api as unknown as ApiContext, createTestRuntimeSafetyContext(), {
    ecb: { fetch, today: () => "2026-10-31", now: () => new Date("2026-10-31T08:00:00Z"), cache: ecbCache },
    usdPoolStore: store,
  });
  const registration = server.registerTool.mock.calls.find(call => call[0] === "book_lightyear_fx_revaluation");
  if (!registration) throw new Error("book_lightyear_fx_revaluation not registered");
  const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const run = async (args: Record<string, unknown> = {}) => {
    const result = await handler({ file_path: STATEMENT_PATH, broker_account: 1120, as_of: "2026-10-30", expected_usd_holding: 100, ...args });
    return { result, payload: parseToolPayload<LightyearFxRevaluationPayload>(result.content[0]!.text) };
  };
  const book = async (args: Record<string, unknown> = {}) => {
    const dry = await run({ ...args, dry_run: true });
    const exec = await run({ ...args, dry_run: false, plan_handle: dry.payload.plan_handle });
    return { dry, exec };
  };
  return { api, ledger, create, created, fetch, ecbCache, store, run, book };
}

function checkpointsOf(records: UsdPoolRecord[]): UsdPoolCheckpoint[] {
  return records.filter((record): record is UsdPoolCheckpoint => record.record === "checkpoint" && record.kind === "revaluation");
}

describe("book_lightyear_fx_revaluation (C5)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockResolvedValue({ path: STATEMENT_PATH });
    mockedReadFileCapped.mockReset();
    mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(ROWS), "utf8"));
  });

  it("revalues 100.00 USD / 88.97 EUR at 1.1172 → D 1120 0.54 / C 8500 0.54 and commits the checkpoint", async () => {
    const env = setup();
    const { dry, exec } = await env.book();
    expect(dry.payload).toMatchObject({
      status: "would_create", usd_amount: 100, carrying_eur: 88.97, target_eur: 89.51, fx_amount: 0.54, document_number: DOC,
      ecb: { rate: "1.1172", rate_date: "2026-10-30", fx_rate_text: "1.1172 USD/EUR ECB 2026-10-30" },
    });
    expect(exec.payload.status).toBe("created");
    expect(env.created).toEqual([expect.objectContaining({
      document_number: DOC,
      postings: [{ accounts_id: 1120, type: "D", amount: 0.54 }, { accounts_id: 8500, type: "C", amount: 0.54 }],
    })]);
    expect(checkpointsOf(env.store.records)).toEqual([expect.objectContaining({ as_of: "2026-10-30", usd_cents: 10000, eur_cents: 8951, fx_cents: 54, journal_id: 9001, document_number: DOC, rate: "1.1172" })]);
    expect(env.store.records.some(record => record.record === "event" && record.state === "intent")).toBe(false);
  });

  it("a loss books D 8500 / C 1120", async () => {
    const env = setup({ rate: "1.1300" });
    await env.book();
    expect(env.created[0]!.postings).toEqual([{ accounts_id: 8500, type: "D", amount: 0.47 }, { accounts_id: 1120, type: "C", amount: 0.47 }]);
  });

  it("zero difference records a journal-free checkpoint; a same-date retry is already_booked", async () => {
    const env = setup({ rate: "1.1240" });
    const { dry, exec } = await env.book();
    expect(dry.payload.status).toBe("would_record_checkpoint");
    expect(exec.payload.status).toBe("checkpoint_recorded");
    expect(env.create).not.toHaveBeenCalled();
    expect(checkpointsOf(env.store.records)).toEqual([expect.objectContaining({ fx_cents: 0, journal_id: null, eur_cents: 8897 })]);
    expect((await env.run({ dry_run: true })).payload.status).toBe("already_booked");
  });

  it("a same-date retry after a booked journal is already_booked, not checkpoint_after_date", async () => {
    const env = setup();
    await env.book();
    const retry = await env.run({ dry_run: true });
    expect(retry.payload.status).toBe("already_booked");
    expect(retry.payload.plan_handle).toBeUndefined();
  });

  it("a replayed quantity off by 0.01 USD is a review", async () => {
    const dry = await setup().run({ dry_run: true, expected_usd_holding: 100.01 });
    expect(dry.payload).toMatchObject({ status: "review", review_reason: { code: "usd_pool_quantity_mismatch" } });
    expect(dry.payload.plan_handle).toBeUndefined();
  });

  it("a journal with the revaluation number but no checkpoint → fx_revaluation_conflict", async () => {
    const dry = await setup({ journals: [...JOURNALS, journal(700, DOC, 99)] }).run({ dry_run: true });
    expect(dry.payload.review_reason?.code).toBe("fx_revaluation_conflict");
  });

  it("an unregistered (draft) pool journal blocks: usd_pool_event_unregistered", async () => {
    const dry = await setup({ journals: [journal(501, "LY:IN-TESTFUND01", 686), journal(502, "LY:DD-TESTNVDA01", 116), journal(503, "LY:OR-TESTBUY001", -35796, false)] }).run({ dry_run: true });
    expect(dry.payload.review_reason?.code).toBe("usd_pool_event_unregistered");
  });

  it("an edited pool journal → usd_pool_event_mismatch", async () => {
    const dry = await setup({ journals: [journal(501, "LY:IN-TESTFUND01", 600), journal(502, "LY:DD-TESTNVDA01", 116), journal(503, "LY:OR-TESTBUY001", -35796)] }).run({ dry_run: true });
    expect(dry.payload.review_reason?.code).toBe("usd_pool_event_mismatch");
  });

  it("a checkpoint after the date → usd_pool_checkpoint_after_date", async () => {
    const later: UsdPoolCheckpoint = { ...opening(10000, 8951, "1.1172", "2026-10-31"), kind: "revaluation", approved: undefined, fx_cents: 0 };
    delete later.approved;
    const dry = await setup({ pool: [...POOL, later] }).run({ dry_run: true });
    expect(dry.payload.review_reason?.code).toBe("usd_pool_checkpoint_after_date");
  });

  it("a statement that starts after the last checkpoint → usd_pool_statement_gap", async () => {
    const late = "/tmp/AccountStatement-LY-TESTACCT1-2026-10-05_2026-10-30_en.csv";
    mockedResolveFileInput.mockResolvedValue({ path: late });
    const dry = await setup().run({ dry_run: true, file_path: late });
    expect(dry.payload.review_reason?.code).toBe("usd_pool_statement_gap");
  });

  it("an unbooked retained distribution in the interval → usd_pool_prerequisite_unbooked", async () => {
    mockedReadFileCapped.mockResolvedValue(Buffer.from(statement([...ROWS, ["20/10/2026 10:00:00", "DD-TESTLATE01", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "1.00", "0", "0", "1.00", "0"]]), "utf8"));
    const dry = await setup().run({ dry_run: true });
    expect(dry.payload.review_reason?.code).toBe("usd_pool_prerequisite_unbooked");
  });

  it("execute succeeds from the frozen plan while the ECB source throws", async () => {
    const env = setup();
    const dry = await env.run({ dry_run: true });
    env.fetch.mockImplementation(async () => { throw new Error("network must not be used at execute"); });
    env.ecbCache.clear();
    const fetches = env.fetch.mock.calls.length;
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.payload.status).toBe("created");
    expect(env.fetch.mock.calls.length).toBe(fetches);
  });

  it("a pool change between dry run and execute → plan_drift, nothing created", async () => {
    const env = setup({ journals: [...JOURNALS, journal(504, "LY:DD-TESTMID01", 89)] });
    const dry = await env.run({ dry_run: true });
    env.store.upsert([poolEvent("DD-TESTMID01", "2026-10-25T10:00:00Z", "distribution_in", 100, 89, 504)]);
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("a pool change that leaves quantity and carrying equal still drifts (snapshot digest)", async () => {
    const env = setup({ journals: [...JOURNALS, journal(504, "LY:DD-TESTMID01", 89), journal(505, "LY:OR-TESTMID02", -89)] });
    const dry = await env.run({ dry_run: true });
    env.store.upsert([
      poolEvent("DD-TESTMID01", "2026-10-25T10:00:00Z", "distribution_in", 100, 89, 504),
      poolEvent("OR-TESTMID02", "2026-10-26T10:00:00Z", "buy_relief", -100, -89, 505),
    ]);
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(env.create).not.toHaveBeenCalled();
  });

  it("a commit failure after the journal is recovered on the next run without a second journal", async () => {
    const env = setup();
    const dry = await env.run({ dry_run: true });
    const upsert = env.store.upsert.bind(env.store);
    let calls = 0;
    env.store.upsert = records => { calls += 1; if (calls === 2) throw new Error("disk full"); upsert(records); };
    const exec = await env.run({ dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.payload.status).toBe("created");
    expect(exec.payload.usd_pool_notes?.[0]).toContain("usd_pool_commit_deferred");
    expect(checkpointsOf(env.store.records)).toEqual([]);
    const retry = await env.run({ dry_run: true });
    expect(retry.payload.status).toBe("already_booked");
    expect(checkpointsOf(env.store.records)).toEqual([expect.objectContaining({ journal_id: 9001, fx_cents: 54 })]);
    expect(env.create).toHaveBeenCalledTimes(1);
  });

  it("two Lightyear accounts get two document numbers", async () => {
    const second = "/tmp/AccountStatement-LY-TESTACCT2-2026-09-01_2026-10-30_en.csv";
    mockedResolveFileInput.mockResolvedValue({ path: second });
    const otherKey: PoolKey = { ...KEY, lightyear_account: "TESTACCT2", broker_account: 1120, broker_dimension_id: 7 };
    const pool = POOL.map(record => ({ ...record, pool_key: otherKey, postings: record.postings?.map(p => ({ ...p, accounts_dimensions_id: 7 })) }));
    const journals = JOURNALS.map(j => ({ ...j, postings: j.postings!.map(p => ({ ...p, accounts_dimensions_id: 7 })) }));
    const dry = await setup({ pool, journals }).run({ dry_run: true, file_path: second, broker_dimension_id: 7 });
    expect(dry.payload.document_number).toBe("LY-FX:TESTACCT2:USD:2026-10-30");
  });

  describe("mode opening", () => {
    const OPENING_ROWS = [
      ["02/09/2026 10:00:00", "DT-TESTDEP01", "", "", "Deposit", "0", "EUR", "0", "1000.00", "0", "0", "1000.00", "0"],
      ["02/09/2026 11:00:00", "CN-TESTOPEN1", "", "", "Conversion", "0", "EUR", "0", "-89.00", "1.1236", "0", "-89.00", "0"],
      ["02/09/2026 11:00:00", "CN-TESTOPEN1", "", "", "Conversion", "0", "USD", "0", "100.00", "0.89", "0", "100.00", "0"],
      ["03/09/2026 10:00:00", "OR-TESTSWEEP0", "ICSUSSDP", "IE00B44QSF52", "Buy", "60", "USD", "1", "60.00", "0", "0", "60.00", "0"],
      ...ROWS,
    ];

    it("replays the statement to as_of, values it at the ECB rate and stores the approved opening", async () => {
      mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(OPENING_ROWS), "utf8"));
      const env = setup({ pool: [], rate: "1.1236" });
      const { dry, exec } = await env.book({ mode: "opening", as_of: "2026-09-30", expected_usd_holding: undefined });
      expect(dry.payload).toMatchObject({ status: "would_store_opening", usd_amount: 100, target_eur: 89, replay: { usd_cents: 10000, cash_cents: 4000, fund_units_cents: 6000 } });
      expect(dry.payload.note).toContain("empty USD position");
      expect(exec.payload.status).toBe("opening_stored");
      expect(env.store.records).toEqual([expect.objectContaining({ record: "checkpoint", kind: "opening", as_of: "2026-09-30", usd_cents: 10000, eur_cents: 8900, approved: true, rate: "1.1236" })]);
      expect(env.create).not.toHaveBeenCalled();
    });

    it("is refused once the pool has a checkpoint", async () => {
      mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(OPENING_ROWS), "utf8"));
      const dry = await setup().run({ dry_run: true, mode: "opening", as_of: "2026-09-30" });
      expect(dry.payload.review_reason?.code).toBe("usd_pool_opening_exists");
    });

    it("a replay that goes negative is unproven", async () => {
      mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(ROWS), "utf8"));
      const dry = await setup({ pool: [] }).run({ dry_run: true, mode: "opening", as_of: "2026-10-30" });
      expect(dry.payload.review_reason?.code).toBe("usd_pool_opening_replay_unproven");
    });
  });

  it("revalue without expected_usd_holding is an argument error", async () => {
    const { result } = await setup().run({ dry_run: true, expected_usd_holding: undefined });
    expect(result.isError).toBe(true);
  });
});

describe("book_lightyear_fx_revaluation — astra review 2026-11-04", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockResolvedValue({ path: STATEMENT_PATH });
    mockedReadFileCapped.mockReset();
    mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(ROWS), "utf8"));
  });

  it("#3 a distribution at the opening day's 23:59:59 is in the opening replay and is held usd_pool_before_opening, never added twice", async () => {
    // 100 USD bought on Sep 2 plus a 10 USD dividend at 30/09 23:59:59: the opening holds 110 USD. Booking that
    // dividend afterwards would make the pool 120 USD against the statement's 110.
    const rows = [
      ["02/09/2026 10:00:00", "DT-TESTDEP02", "", "", "Deposit", "0", "EUR", "0", "1000.00", "0", "0", "1000.00", "0"],
      ["02/09/2026 11:00:00", "CN-TESTOPEN2", "", "", "Conversion", "0", "EUR", "0", "-100.00", "1", "0", "-100.00", "0"],
      ["02/09/2026 11:00:00", "CN-TESTOPEN2", "", "", "Conversion", "0", "USD", "0", "100.00", "1", "0", "100.00", "0"],
      ["30/09/2026 23:59:59", "DD-TESTLAST09", "AMD", "US0079031078", "Dividend", "0", "USD", "0", "10.00", "0", "0", "10.00", "0"],
    ];
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(rows), "utf8"));
    const fetch = harnessRateFetch("1");
    const opening = setupPoolTool<LightyearFxRevaluationPayload>("book_lightyear_fx_revaluation", { broker_account: 1120 }, { fetch });
    const stored = await opening.book({ mode: "opening", as_of: "2026-09-30" });
    expect(stored.exec.payload.status).toBe("opening_stored");
    expect(opening.store.records).toEqual([expect.objectContaining({ kind: "opening", usd_cents: 11000, eur_cents: 11000 })]);
    const distributions = setupPoolTool<LightyearDistributionsPayload>("book_lightyear_distributions",
      { broker_account: 1120, income_account: 8330, tax_account: 8610, fee_account: 8610 }, { fetch, store: opening.store });
    const dry = await distributions.run({ fx_source: "ecb", dry_run: true });
    const held = dry.payload.results.find(row => String(row.reference).includes("DD-TESTLAST09"));
    expect(held).toMatchObject({ status: "manual_review", review_reason: { code: "usd_pool_before_opening" } });
    expect(distributions.create).not.toHaveBeenCalled();
    expect(opening.store.records).toHaveLength(1);
  });

  it("#3 a revaluation counts a committed event in the reporting day's last second (23:59:59)", async () => {
    // 100.00 USD / €88.97 plus 1.00 USD / €0.89 at 30/10 23:59:59 = 101.00 USD / €89.86; at 1.1172 the target is
    // 101 / 1.1172 = €90.40 (90.404…), so FX +€0.54.
    const last = ["30/10/2026 23:59:59", "DD-TESTLAST10", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "1.00", "0", "0", "1.00", "0"];
    const rows = [...ROWS, last];
    mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(rows), "utf8"));
    const event = { ...poolEvent("DD-TESTLAST10", "2026-10-30T23:59:59Z", "distribution_in", 100, 89, 504), source_digest: sourceDigestOf(rows, "DD-TESTLAST10") };
    const dry = await setup({ pool: [...POOL, event], journals: [...JOURNALS, journal(504, "LY:DD-TESTLAST10", 89)] }).run({ dry_run: true, expected_usd_holding: 101 });
    expect(dry.payload).toMatchObject({ status: "would_create", usd_amount: 101, carrying_eur: 89.86, target_eur: 90.4, fx_amount: 0.54 });
  });

  it.each([
    ["omits a committed distribution", ROWS.filter(row => row[1] !== "IN-TESTFUND01")],
    ["has no rows (header only)", []],
  ])("#4 a full-period export that %s is usd_pool_source_changed; nothing is written", async (_label, rows) => {
    // The file name declares 2026-09-01…2026-10-30, so the Oct 1 distribution logged in the pool (and its journal) must be in it.
    mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(rows), "utf8"));
    const env = setup();
    const dry = await env.run({ dry_run: true });
    expect(dry.payload).toMatchObject({ status: "review", review_reason: { code: "usd_pool_source_changed" } });
    expect(dry.payload.plan_handle).toBeUndefined();
    expect(env.create).not.toHaveBeenCalled();
    expect(checkpointsOf(env.store.records)).toEqual([]);
  });

  type Edit = (ledger: Map<number, Journal>) => void;
  const editJournal = (change: (journal: Journal) => Journal): Edit => ledger => { ledger.set(9001, change(ledger.get(9001)!)); };
  it.each<[string, Edit]>([
    ["its amount", editJournal(j => ({ ...j, postings: j.postings!.map(p => ({ ...p, amount: 0.55 })) }))],
    ["its effective date", editJournal(j => ({ ...j, effective_date: "2026-10-29" }))],
    ["an account", editJournal(j => ({ ...j, postings: j.postings!.map(p => p.accounts_id === 8500 ? { ...p, accounts_id: 8330 } : p) }))],
    ["a dimension", editJournal(j => ({ ...j, postings: j.postings!.map(p => p.accounts_id === 1120 ? { ...p, accounts_dimensions_id: 7 } : p) }))],
    ["a second live journal with the same number", ledger => { ledger.set(700, journal(700, DOC, 54)); }],
  ])("#5 a same-date retry after editing %s is fx_revaluation_conflict, not already_booked", async (_label, edit) => {
    const env = setup();
    await env.book();
    expect(env.created).toHaveLength(1);
    edit(env.ledger);
    const retry = await env.run({ dry_run: true });
    expect(retry.payload).toMatchObject({ status: "review", review_reason: { code: "fx_revaluation_conflict" } });
    expect(env.created).toHaveLength(1);
  });
});
