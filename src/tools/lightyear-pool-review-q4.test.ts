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
    mockedReadFileCapped.mockImplementation(async () => Buffer.from(lightyearStatementCsv(statementRows), "utf8"));
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
});
