import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { lightyearStatementCsv } from "../__fixtures__/lightyear-rows.js";
import { poolOpening, rateFetch, setupPoolTool, type CreatedJournal } from "../__fixtures__/lightyear-pool-harness.js";
import type { UsdPoolEvent } from "../lightyear/usd-pool.js";
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

/** Synthetic accounts: 1120 broker (plan 1020), 1550 investment (plan 1100). */
const ACCOUNTS = { investment_account: 1550, broker_account: 1120, gain_loss_account: 8330, loss_account: 8335, fee_account: 8335, fx_account: 8500 };

let statementRows: string[][] = [];
let gainsRows: string[][] = [];
const GAINS_PATH = "/tmp/CapitalGainsStatement-TESTACCT1-2026.csv";
const GAINS_HEADER = "Date,Ticker,Name,ISIN,Country,Asset Class,Fees (EUR),Quantity,Cost Basis (EUR),Proceeds (EUR),Capital Gains (EUR)";

function tradesTool(options: Parameters<typeof setupPoolTool>[2] = {}) {
  return setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", ACCOUNTS, options);
}

const buy = (ts: string, ref: string, gross: string, fee = "0"): string[] =>
  [ts, ref, "NVDA", "US67066G1040", "Buy", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
/** EUR→USD conversion legs (no fee): EUR −eur, USD +usd. */
const eurLegOut = (ts: string, ref: string, eur: string, usd: string): string[] =>
  [ts, ref, "", "", "Conversion", "0", "EUR", "0", `-${eur}`, String(Number(usd) / Number(eur)), "0", `-${eur}`, "0"];
const usdLegIn = (ts: string, ref: string, usd: string, eur: string): string[] =>
  [ts, ref, "", "", "Conversion", "0", "USD", "0", usd, String(Number(eur) / Number(usd)), "0", usd, "0"];
/** USD→EUR conversion, fee on the USD leg. */
const convOut = (ts: string, ref: string, usdGross: string, usdFee: string, eur: string): string[][] => {
  const usdNet = (Number(usdGross) - Number(usdFee)).toFixed(2);
  return [
    [ts, ref, "", "", "Conversion", "0", "USD", "0", `-${usdGross}`, String(Number(eur) / Number(usdNet)), usdFee, `-${usdNet}`, "0"],
    [ts, ref, "", "", "Conversion", "0", "EUR", "0", eur, String(Number(usdNet) / Number(eur)), "0", eur, "0"],
  ];
};

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

describe("book_lightyear_trades — Codex review of Q1–Q5 (2026-11-01)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockReset();
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockReset();
    gainsRows = [];
    mockedReadFileCapped.mockImplementation(async (path: string) => Buffer.from(
      path === GAINS_PATH ? `${GAINS_HEADER}\n${gainsRows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n` : lightyearStatementCsv(statementRows),
      "utf8",
    ));
  });

  describe("#1 an orphan conversion leg is never pool funding", () => {
    const BUY = buy("14/04/2026 10:00:00", "OR-TESTORPH1", "100.00");
    const EUR_LEG = eurLegOut("14/04/2026 10:00:00", "CN-TESTORPH1", "90.00", "100.00");
    const USD_LEG = usdLegIn("14/04/2026 10:00:00", "CN-TESTORPH1", "100.00", "90.00");

    it("opening 200 USD / €180, EUR-only conversion −€90 beside a 100 USD buy, ECB 1.25: held, no D1100 €80 / D8500 €10 / C1020 €90", async () => {
      statementRows = [EUR_LEG, BUY];
      const env = tradesTool({ pool: [poolOpening(20000, 18000, "1.1111111111")], fetch: rateFetch("1.25") });
      const { dry, exec } = await env.book();
      expect(resultFor(dry.payload, "OR-TESTORPH1")).toMatchObject({ status: "skipped" });
      expect(reviewCode(dry.payload, "OR-TESTORPH1")).toBe("invalid_conversion_pair");
      expect(resultFor(dry.payload, "OR-TESTORPH1")!.pool).toBeUndefined();
      expect(exec.payload.created ?? 0).toBe(0);
      expect(env.create).not.toHaveBeenCalled();
      expect(poolEvents(env)).toEqual([]);
    });

    it("a USD-only leg hours earlier the same day also holds the buy (no N:1 link, still no pool fallback)", async () => {
      statementRows = [usdLegIn("14/04/2026 08:00:00", "CN-TESTORPH2", "80.00", "72.00"), BUY];
      const env = tradesTool({ pool: [poolOpening(20000, 18000, "1.1111111111")], fetch: rateFetch("1.25") });
      const dry = await env.run({ dry_run: true });
      expect(resultFor(dry.payload, "OR-TESTORPH1")).toMatchObject({ status: "skipped" });
      expect(reviewCode(dry.payload, "OR-TESTORPH1")).toBe("invalid_conversion_pair");
      expect(dry.payload.created ?? 0).toBe(0);
    });

    it("control: with the USD leg restored the buy is a €90 1:1 investment and the pool is unchanged", async () => {
      statementRows = [EUR_LEG, USD_LEG, BUY];
      const env = tradesTool({ pool: [poolOpening(20000, 18000, "1.1111111111")], fetch: rateFetch("1.25") });
      await env.book();
      expect(journal(env, "OR-TESTORPH1")).toEqual([{ accounts_id: 1550, type: "D", amount: 90 }, { accounts_id: 1120, type: "C", amount: 90 }]);
      expect(poolEvents(env)).toEqual([]);
    });
  });

  describe("#2 an intrinsic conversion error is a projection barrier; only usd_pool_funded is valued", () => {
    const BUY = buy("15/04/2026 10:00:10", "OR-TESTNERR1", "100.00");
    const LATER = buy("20/04/2026 10:00:00", "OR-TESTNERR2", "10.00");

    it("opening 100 USD / €90, incoming 80 USD conversion missing its EUR leg, then a 100 USD buy, ECB 1.25: held, no D1100 €16 / D8500 €2 / C1020 €18", async () => {
      statementRows = [usdLegIn("15/04/2026 10:00:00", "CN-TESTNERR1", "80.00", "64.00"), BUY, LATER];
      const env = tradesTool({ pool: [poolOpening(10000, 9000, "1.1111111111")], fetch: rateFetch("1.25") });
      const { dry, exec } = await env.book();
      expect(resultFor(dry.payload, "OR-TESTNERR1")).toMatchObject({ status: "skipped" });
      expect(reviewCode(dry.payload, "OR-TESTNERR1")).toBe("invalid_conversion_pair");
      expect(resultFor(dry.payload, "OR-TESTNERR2")).toMatchObject({ status: "skipped" });
      expect(exec.payload.created ?? 0).toBe(0);
      expect(env.create).not.toHaveBeenCalled();
      expect(poolEvents(env)).toEqual([]);
    });

    it("same numbers with both legs but fees on both (an N:1 conversion that cannot be valued): held, the later pool buy stops", async () => {
      statementRows = [
        ["15/04/2026 10:00:00", "CN-TESTNERR1", "", "", "Conversion", "0", "EUR", "0", "-64.00", "1.25", "0.50", "-64.50", "0"],
        ["15/04/2026 10:00:00", "CN-TESTNERR1", "", "", "Conversion", "0", "USD", "0", "80.00", "0.8", "0.10", "79.90", "0"],
        BUY, LATER,
      ];
      const env = tradesTool({ pool: [poolOpening(10000, 9000, "1.1111111111")], fetch: rateFetch("1.25") });
      const { dry, exec } = await env.book();
      expect(resultFor(dry.payload, "OR-TESTNERR1")).toMatchObject({ status: "skipped" });
      expect(reviewCode(dry.payload, "OR-TESTNERR1")).toMatch(/^(conversion_(fee|amount)_conflict|invalid_conversion_pair)$/);
      expect(reviewCode(dry.payload, "OR-TESTNERR2")).toBe("usd_pool_prerequisite_failed");
      expect(exec.payload.created ?? 0).toBe(0);
      expect(poolEvents(env)).toEqual([]);
    });
  });

  describe("#4 bookability is decided before the pool projection", () => {
    it("opening 3 USD / €1, ECB 3: a $1 buy with a $0.99 fee rounds to a zero investment and is skipped without consuming the pool; the $1→€0.33 conversion stops (no D8500 €0.01 / C1020 €0.01)", async () => {
      statementRows = [buy("14/04/2026 10:00:00", "OR-TESTZERO1", "1.00", "0.99"), ...convOut("14/04/2026 11:00:00", "CN-TESTZERO1", "1.00", "0", "0.33")];
      const env = tradesTool({ pool: [poolOpening(300, 100, "3")], fetch: rateFetch("3") });
      const { dry, exec } = await env.book();
      expect(resultFor(dry.payload, "OR-TESTZERO1")).toMatchObject({ status: "skipped" });
      expect(reviewCode(dry.payload, "OR-TESTZERO1")).toBe("trade_amount_conflict");
      expect(resultFor(dry.payload, "CN-TESTZERO1")).toMatchObject({ status: "skipped" });
      expect(reviewCode(dry.payload, "CN-TESTZERO1")).toBe("usd_pool_prerequisite_failed");
      expect(journal(env, "CN-TESTZERO1")).toBeUndefined();
      expect(env.created.flatMap(entry => entry.postings ?? []).filter(posting => posting.accounts_id === 8500)).toEqual([]);
      expect(exec.payload.created ?? 0).toBe(0);
      expect(poolEvents(env)).toEqual([]);
    });

    it("a sell kept in USD whose gains cost basis has no exact cent value is held before the projection; the later pool buy stops", async () => {
      statementRows = [
        ["14/04/2026 10:00:00", "OR-TESTCOST1", "AMD", "US0079031078", "Sell", "1", "USD", "1", "30.00", "0", "0", "30.00", "0"],
        buy("14/04/2026 12:00:00", "OR-TESTCOST2", "1.00"),
      ];
      gainsRows = [["14/04/2026 10:00:00", "AMD", "AMD", "US0079031078", "United States", "equity", "0", "1", "100000000000000000", "10.00", "-99999999999999990"]];
      const env = tradesTool({ pool: [poolOpening(300, 100, "3")], fetch: rateFetch("3") });
      const { dry, exec } = await env.book({ capital_gains_file: GAINS_PATH });
      expect(resultFor(dry.payload, "OR-TESTCOST1")).toMatchObject({ status: "skipped" });
      expect(reviewCode(dry.payload, "OR-TESTCOST1")).toBe("trade_amount_conflict");
      expect(reviewCode(dry.payload, "OR-TESTCOST2")).toBe("usd_pool_prerequisite_failed");
      expect(exec.payload.created ?? 0).toBe(0);
      expect(poolEvents(env)).toEqual([]);
    });

    it("control: without the zero buy the same conversion relieves €0.33 of the 3 USD / €1 pool with no FX and books no journal", async () => {
      statementRows = convOut("14/04/2026 11:00:00", "CN-TESTZERO1", "1.00", "0", "0.33");
      const env = tradesTool({ pool: [poolOpening(300, 100, "3")], fetch: rateFetch("3") });
      const { dry } = await env.book();
      expect(resultFor(dry.payload, "CN-TESTZERO1")).toMatchObject({ status: "would_record", pool: { kind: "conversion_out", relief_eur: 0.33 } });
      expect(env.create).not.toHaveBeenCalled();
      expect(poolEvents(env)).toMatchObject([{ ref: "CN-TESTZERO1", usd_cents: -100, eur_cents: -33 }]);
    });
  });
});
