import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import { memoryUsdPoolStore } from "../__fixtures__/usd-pool-store.js";
import type { ApiContext } from "./crud/shared.js";
import type { Journal } from "../types/api.js";
import type { EcbFetch, EcbFetchResponse } from "../fx/ecb-rates.js";
import type { PlanData } from "../plan-store.js";
import { createUsdPoolStore, endOfDaySeconds, type UsdPoolEvent, type UsdPoolStore } from "../lightyear/usd-pool.js";
import { initAccountingRulesConnection } from "../accounting-rules.js";
import { registerLightyearTools, type LightyearDistributionsPayload } from "./lightyear-investments.js";

vi.mock("../bounded-read.js", async () => {
  const actual = await vi.importActual<typeof import("../bounded-read.js")>("../bounded-read.js");
  return { ...actual, readFileCapped: vi.fn() };
});
vi.mock("../file-validation.js", () => ({ resolveFileInput: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const mockedReadFileCapped = vi.mocked(readFileCapped);
const mockedResolveFileInput = vi.mocked(resolveFileInput);

const STATEMENT_PATH = "/tmp/AccountStatement-LY-TESTACCT1-2026-10-01_2026-10-31_en.csv";
const HEADER = "Date,Reference,Ticker,ISIN,Type,Quantity,CCY,Price/share,Gross Amount,FX Rate,Fee,Net Amt.,Tax Amt.";
const ECB_HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS";

// Worked examples of the plan (synthetic references): NVDA dividend and an
// ICSUSSDP fund distribution that both stay in USD.
const NVDA_DIVIDEND = ["02/10/2026 10:00:00", "DD-TESTNVDA01", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "1.53", "0", "0", "1.30", "0.23"];
const ICSUSSDP_DISTRIBUTION = ["01/10/2026 10:00:00", "IN-TESTFUND01", "ICSUSSDP", "IE00B44QSF52", "Distribution", "0", "USD", "0", "8.06", "0", "0.31", "7.75", "0"];
const BRICEKSP_DISTRIBUTION = ["01/10/2026 11:00:00", "IN-TESTFUND02", "BRICEKSP", "IE00BCRY6557", "Distribution", "0", "EUR", "0", "2.00", "1", "0", "2.00", "0"];
const EUR_DIVIDEND = ["02/10/2026 11:00:00", "DD-TESTEUR001", "VWCE", "IE00BK5BQT80", "Dividend", "0", "EUR", "0", "10.00", "1", "0", "10.00", "0"];

function statement(rows: string[][]): string {
  return `${HEADER}\n${rows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n`;
}

function ecbCsv(rows: Array<[string, string]>): string {
  return [ECB_HEADER, ...rows.map(([date, value]) => `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},${value},A`)].join("\n") + "\n";
}

function ecbResponse(body: string, status = 200): EcbFetchResponse {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body };
}

const OCTOBER_RATES: Array<[string, string]> = [["2026-09-30", "1.1301"], ["2026-10-01", "1.1298"], ["2026-10-02", "1.1225"], ["2026-10-05", "1.1180"]];

type FetchMock = ReturnType<typeof vi.fn> & EcbFetch;

function rateFetch(rates: Array<[string, string]> = OCTOBER_RATES): FetchMock {
  return vi.fn(async () => ecbResponse(ecbCsv(rates))) as FetchMock;
}

interface CreatedJournal { document_number?: string; postings?: Array<{ accounts_id: number; type: string; amount: number }> }

function setup(options: { fetch?: FetchMock; today?: string; journals?: Journal[]; store?: UsdPoolStore } = {}) {
  const server = { registerTool: vi.fn() };
  const created: CreatedJournal[] = [];
  const create = vi.fn(async (payload: CreatedJournal) => {
    created.push(payload);
    return { created_object_id: 9000 + created.length };
  });
  const get = vi.fn(async (id: number) => {
    const payload = created[id - 9001];
    return { id, registered: false, document_number: payload?.document_number, postings: payload?.postings ?? [] } as unknown as Journal;
  });
  const accounts = [1120, 8320, 8330, 8400, 8600, 8610].map(id => ({ id, is_deleted: false, is_valid: true, code: String(id), title_est: `Konto ${id}`, name_est: `Konto ${id}` }));
  const api = {
    readonly: {
      getAccounts: vi.fn().mockResolvedValue(accounts),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
    },
    journals: {
      connectionFingerprint: "lightyear-ecb-test-connection",
      invalidateListCache: vi.fn(),
      listAll: vi.fn(async () => options.journals ?? []),
      create,
      get,
    },
  };
  const fetch = options.fetch ?? rateFetch();
  const store = memoryUsdPoolStore();
  const context = createTestRuntimeSafetyContext();
  registerLightyearTools(server as unknown as Parameters<typeof registerLightyearTools>[0], api as unknown as ApiContext, context, {
    ecb: { fetch, today: () => options.today ?? "2026-10-31", now: () => new Date("2026-10-31T08:00:00Z"), cache: new Map() },
    usdPoolStore: options.store ?? store,
  });
  const registration = server.registerTool.mock.calls.find(call => call[0] === "book_lightyear_distributions");
  if (!registration) throw new Error("book_lightyear_distributions not registered");
  const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const run = async (args: Record<string, unknown>) => {
    const result = await handler({ file_path: STATEMENT_PATH, broker_account: 1120, income_account: 8330, tax_account: 8610, fee_account: 8610, ...args });
    return { result, payload: parseToolPayload<LightyearDistributionsPayload & { error?: string; code?: string }>(result.content[0]!.text) };
  };
  return { api, create, created, fetch, store, context, run };
}

function loadStatement(rows: string[][]): void {
  mockedReadFileCapped.mockResolvedValue(Buffer.from(statement(rows), "utf8"));
}

function provenanceOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return (row?.fx_provenance ?? {}) as Record<string, unknown>;
}

describe("book_lightyear_distributions fx_source=ecb", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockResolvedValue({ path: STATEMENT_PATH });
    mockedReadFileCapped.mockReset();
  });

  it("books the NVDA dividend and the ICSUSSDP distribution to the cent at the same-day ECB rate", async () => {
    loadStatement([ICSUSSDP_DISTRIBUTION, NVDA_DIVIDEND]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    expect(dry.payload.bookable_distributions).toBe(2);
    expect(dry.payload.results.map(row => row.fx_rate_text)).toEqual(["1.1298 USD/EUR ECB 2026-10-01", "1.1225 USD/EUR ECB 2026-10-02"]);
    expect(provenanceOf(dry.payload.results[1])).toMatchObject({ source: "ecb", rate: "1.1225", rate_date: "2026-10-02", requested_date: "2026-10-02", series: "EXR.D.USD.EUR.SP00.A" });
    const fetchesAtDryRun = env.fetch.mock.calls.length;
    expect(fetchesAtDryRun).toBe(2);

    const exec = await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.payload.mode).toBe("EXECUTED");
    expect(env.fetch.mock.calls.length).toBe(fetchesAtDryRun);
    expect(env.created.map(journal => journal.postings)).toEqual([
      [{ accounts_id: 1120, type: "D", amount: 6.86 }, { accounts_id: 8610, type: "D", amount: 0.27 }, { accounts_id: 8320, type: "C", amount: 7.13 }],
      [{ accounts_id: 1120, type: "D", amount: 1.16 }, { accounts_id: 8610, type: "D", amount: 0.2 }, { accounts_id: 8330, type: "C", amount: 1.36 }],
    ]);
  });

  it("logs each retained USD distribution as a committed distribution_in event", async () => {
    loadStatement([ICSUSSDP_DISTRIBUTION, NVDA_DIVIDEND]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    const events = env.store.records.filter((record): record is UsdPoolEvent => record.record === "event");
    expect(events.map(event => ({ ref: event.ref, kind: event.kind, state: event.state, usd: event.usd_cents, eur: event.eur_cents, journal: event.journal_id, doc: event.document_number })))
      .toEqual([
        { ref: "IN-TESTFUND01", kind: "distribution_in", state: "committed", usd: 775, eur: 686, journal: 9001, doc: "LY:IN-TESTFUND01" },
        { ref: "DD-TESTNVDA01", kind: "distribution_in", state: "committed", usd: 130, eur: 116, journal: 9002, doc: "LY:DD-TESTNVDA01" },
      ]);
    expect(events.every(event => event.pool_key.lightyear_account === "TESTACCT1" && event.pool_key.broker_account === 1120)).toBe(true);
  });

  it("only the unconverted dividend is valued by ECB and logged; the statement-converted one logs nothing", async () => {
    loadStatement([
      ["02/10/2026 12:00:00", "CN-TESTCONV01", "", "", "Conversion", "0", "USD", "0", "-85.00", "0.9", "0", "-85.00", "0"],
      ["02/10/2026 12:00:00", "CN-TESTCONV01", "", "", "Conversion", "0", "EUR", "0", "76.50", "1.111111111111", "0", "76.50", "0"],
      ["02/10/2026 09:00:00", "DD-TESTCONV01", "USCO", "US0000000001", "Dividend", "0", "USD", "0", "100.00", "0", "0", "85.00", "15.00"],
      NVDA_DIVIDEND,
    ]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    const sources = dry.payload.results.map(row => provenanceOf(row).source);
    expect(sources).toEqual(["statement_conversion", "ecb"]);
    await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(env.store.records.map(record => record.record === "event" ? record.ref : null)).toEqual(["DD-TESTNVDA01"]);
  });

  it("takes Friday's rate for a Sunday dividend and keeps rate_date apart from requested_date", async () => {
    loadStatement([["04/10/2026 10:00:00", "DD-TESTSUN001", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "1.53", "0", "0", "1.30", "0.23"]]);
    const dry = await setup().run({ fx_source: "ecb", dry_run: true });
    expect(provenanceOf(dry.payload.results[0])).toMatchObject({ rate: "1.1225", rate_date: "2026-10-02", requested_date: "2026-10-04" });
  });

  it("ECB down → review ecb_rate_unavailable, nothing guessed", async () => {
    loadStatement([NVDA_DIVIDEND]);
    const env = setup({ fetch: vi.fn(async () => ecbResponse("", 503)) as FetchMock });
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    expect(dry.payload.bookable_distributions).toBe(0);
    expect(dry.payload.results[0]).toMatchObject({ status: "manual_review", gross_eur: null, review_reason: { code: "ecb_rate_unavailable" } });
    expect(env.create).not.toHaveBeenCalled();
  });

  it("a same-day dividend is ecb_rate_not_final without any fetch", async () => {
    loadStatement([NVDA_DIVIDEND]);
    const env = setup({ today: "2026-10-02" });
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    expect(dry.payload.results[0]).toMatchObject({ review_reason: { code: "ecb_rate_not_final" } });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("an ambiguous conversion candidate stays invalid_conversion_pair under ecb", async () => {
    loadStatement([
      ["02/10/2026 12:00:00", "CN-TESTAMB01", "", "", "Conversion", "0", "USD", "0", "-85.00", "0.9", "0", "-85.00", "0"],
      ["02/10/2026 12:00:00", "CN-TESTAMB01", "", "", "Conversion", "0", "EUR", "0", "76.50", "1.111111111111", "0", "76.50", "0"],
      ["02/10/2026 12:00:00", "CN-TESTAMB02", "", "", "Conversion", "0", "USD", "0", "-85.00", "0.9", "0", "-85.00", "0"],
      ["02/10/2026 12:00:00", "CN-TESTAMB02", "", "", "Conversion", "0", "EUR", "0", "76.50", "1.111111111111", "0", "76.50", "0"],
      ["02/10/2026 09:00:00", "DD-TESTAMB001", "USCO", "US0000000001", "Dividend", "0", "USD", "0", "100.00", "0", "0", "85.00", "15.00"],
    ]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    expect(dry.payload.results[0]).toMatchObject({ review_reason: { code: "invalid_conversion_pair" }, fx_provenance: null });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("execute succeeds from the frozen plan while the ECB source throws on any call", async () => {
    loadStatement([NVDA_DIVIDEND]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    env.fetch.mockImplementation(async () => { throw new Error("network must not be used at execute"); });
    const exec = await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(exec.result.isError).toBeFalsy();
    expect(env.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ECB timeout", (): FetchMock => vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }) as FetchMock, "ecb_rate_unavailable", "2026-10-31"],
    ["same-day not final", (): FetchMock => rateFetch(), "ecb_rate_not_final", "2026-10-02"],
  ])("mixed EUR + USD with %s: the plan books the EUR row only and re-reports the USD review", async (_label, makeFetch, code, today) => {
    loadStatement([EUR_DIVIDEND, NVDA_DIVIDEND]);
    const env = setup({ fetch: makeFetch(), today });
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    expect(typeof dry.payload.plan_handle).toBe("string");
    const fetches = env.fetch.mock.calls.length;
    const exec = await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(env.fetch.mock.calls.length).toBe(fetches);
    expect(env.created.map(journal => journal.document_number)).toEqual(["LY:DD-TESTEUR001"]);
    expect(exec.payload.results.find(row => String(row.reference).includes("DD-TESTNVDA01"))).toMatchObject({ status: "manual_review", review_reason: { code } });
  });

  const tamperedExecute = async (tamper: (outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }>) => void) => {
    loadStatement([NVDA_DIVIDEND]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    const consume = env.context.planStore.consume.bind(env.context.planStore);
    vi.spyOn(env.context.planStore, "consume").mockImplementation((handle, domain) => {
      const plan = consume(handle, domain);
      const privatePayload = structuredClone(plan.privatePayload) as unknown as { fx_outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }> };
      tamper(privatePayload.fx_outcomes);
      return { ...plan, privatePayload: privatePayload as unknown as PlanData };
    });
    const exec = await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    return { env, exec };
  };

  it.each([
    ["the stored rate_date", (outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }>) => { outcomes["USD:2026-10-02"]!.rate!.rate_date = "2026-10-01"; }, "plan no longer matches"],
    ["the rate string with equal cents (1.1225 → 1.12251)", (outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }>) => { outcomes["USD:2026-10-02"]!.rate!.rate = "1.12251"; }, "plan no longer matches"],
    ["the frozen key (fx_rate_unbound)", (outcomes: Record<string, { ok: boolean; rate?: Record<string, unknown> }>) => { delete outcomes["USD:2026-10-02"]; }, "fx_rate_unbound"],
  ])("altering %s in the plan is plan_drift and books nothing", async (_label, tamper, why) => {
    const { env, exec } = await tamperedExecute(tamper);
    expect(exec.result.content[0]!.text).toContain("plan_drift");
    expect(exec.result.content[0]!.text).toContain(why);
    expect(env.create).not.toHaveBeenCalled();
    expect(env.fetch.mock.calls.length).toBe(1);
  });

  it("both cash funds (BRICEKSP, ICSUSSDP) book to the fund distribution account 8320", async () => {
    loadStatement([ICSUSSDP_DISTRIBUTION, BRICEKSP_DISTRIBUTION]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", dry_run: true });
    await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(env.created.map(journal => journal.postings?.find(posting => posting.type === "C")?.accounts_id)).toEqual([8320, 8320]);
  });

  it("the default fx_source leaves a retained USD dividend in review and fetches nothing", async () => {
    loadStatement([NVDA_DIVIDEND]);
    const env = setup();
    const dry = await env.run({ dry_run: true });
    expect(dry.payload.results[0]).toMatchObject({ status: "manual_review", review_reason: { code: "invalid_conversion_pair" } });
    expect(dry.payload.results[0]!.fx_rate_text).toBeUndefined();
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("without a resolvable Lightyear account the ECB rows still book, with usd_pool_not_logged", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/statement.csv" });
    loadStatement([NVDA_DIVIDEND]);
    const env = setup();
    const dry = await env.run({ file_path: "/tmp/statement.csv", fx_source: "ecb", dry_run: true });
    expect(dry.payload.usd_pool_notes?.[0]).toContain("usd_pool_not_logged");
    await env.run({ file_path: "/tmp/statement.csv", fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
    expect(env.create).toHaveBeenCalledTimes(1);
    expect(env.store.records).toEqual([]);
  });

  it("a lightyear_account that contradicts the file name is refused", async () => {
    loadStatement([NVDA_DIVIDEND]);
    const env = setup();
    const dry = await env.run({ fx_source: "ecb", lightyear_account: "OTHERACCT", dry_run: true });
    expect(dry.result.isError).toBe(true);
    expect(dry.result.content[0]!.text).toContain("does not match");
  });

  it("review wpc 1: a second process's committed relief is seen under the lock — the back-dated distribution is refused", async () => {
    // Two "processes" = two bundle-backed stores on one rules dir. Opening 100 USD / €90 (2026-09-30);
    // process A commits an Oct 20 relief of 50 USD / €45 after process B cached the opening only.
    // An Oct 1 distribution of +100 USD / €80 (ECB 1.25) would leave 150 USD / €125 instead of the
    // chronological €42.50 relief / €127.50 — it must be refused, not logged.
    const dir = mkdtempSync(join(tmpdir(), "usd-pool-two-process-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    process.env.EARVELDAJA_LOCK_DIR = join(dir, "locks");
    try {
      initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" }));
      const key = { connection_fingerprint: "lightyear-ecb-test-connection", lightyear_account: "TESTACCT1", broker_account: 1120, broker_dimension_id: null, currency: "USD" as const };
      const processA = createUsdPoolStore();
      const processB = createUsdPoolStore();
      processA.upsert([{
        record: "checkpoint", pool_key: key, kind: "opening", as_of: "2026-09-30", ts: endOfDaySeconds("2026-09-30"),
        usd_cents: 10000, eur_cents: 9000, fx_cents: 0, journal_id: null, document_number: null,
        rate: "1.1111111111", rate_date: "2026-09-30", approved: true, recorded_at: "t",
      }]);
      expect(processB.read()).toHaveLength(1); // B caches the opening only
      loadStatement([["01/10/2026 10:00:00", "DD-TESTBACK01", "NVDA", "US67066G1040", "Dividend", "0", "USD", "0", "100.00", "0", "0", "100.00", "0"]]);
      const env = setup({ store: processB, fetch: rateFetch([["2026-10-01", "1.25"], ["2026-10-02", "1.25"]]), journals: [] });
      const dry = await env.run({ fx_source: "ecb", dry_run: true });
      expect(dry.payload.results[0]).toMatchObject({ net_eur: 80 });
      processA.upsert([{
        record: "event", pool_key: key, ref: "OR-TESTA20", ts: Date.parse("2026-10-20T12:00:00Z") / 1000, kind: "buy_relief",
        usd_cents: -5000, eur_cents: -4500, document_number: "LY:OR-TESTA20", journal_id: 7001, journal_broker_net_cents: -4500,
        state: "committed", recorded_at: "t",
      }]);
      expect(processB.read()).toHaveLength(1); // still stale outside the lock
      const exec = await env.run({ fx_source: "ecb", dry_run: false, plan_handle: dry.payload.plan_handle });
      expect(exec.result.content[0]!.text).toContain("plan_drift");
      expect(env.create).not.toHaveBeenCalled();
      const again = await env.run({ fx_source: "ecb", dry_run: true });
      expect(again.payload.results[0]).toMatchObject({ status: "manual_review", review_reason: { code: "usd_pool_backdated_event" } });
      expect(processA.read()!.filter(record => record.record === "event").map(record => (record as UsdPoolEvent).ref)).toEqual(["OR-TESTA20"]);
    } finally {
      delete process.env.EARVELDAJA_RULES_DIR;
      delete process.env.EARVELDAJA_LOCK_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
