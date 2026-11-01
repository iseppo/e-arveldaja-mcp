import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../http-client.js";
import type { Journal } from "../types/api.js";
import type { ApiContext } from "../tools/crud-tools.js";
import {
  checkpointOrder,
  compareOrder,
  endOfDaySeconds,
  eventOrder,
  lightyearAccountFromFileName,
  poolFrontier,
  projectPool,
  recoverUsdPoolIntents,
  relieveCents,
  replayUsdOpening,
  statementPeriodFromFileName,
  usdCentsToEurCents,
  usdPoolRecordKey,
  validateUsdPool,
  withUsdPoolLock,
  type PoolKey,
  type StatementPoolEvent,
  type UsdPoolCheckpoint,
  type UsdPoolEvent,
  type UsdPoolRecord,
} from "./usd-pool.js";
import { memoryUsdPoolStore } from "../__fixtures__/usd-pool-store.js";

const NO_STATEMENT = { events: [], rows: [] };
/** Statement events with a role (row_index by position); sweep rows are priced at exactly 1.00. */
function statementOf(events: Array<{ ref: string; ts: number; role: StatementPoolEvent["role"] }>) {
  return {
    events: events.map((event, row_index) => ({ ...event, row_index })),
    rows: events.map((event, row_index) => ({
      row_index, reference: event.ref, ts: event.ts, type: event.role === "sweep" ? "Sell" : "Dividend", ticker: "ICSUSSDP", ccy: "USD",
      quantity: 1, price_per_share: 1, gross_amount: 1, fee: 0, net_amount: 1,
    })),
  };
}
const KEY: PoolKey = { connection_fingerprint: "conn", lightyear_account: "CHZELUU", broker_account: 1020, broker_dimension_id: 11, currency: "USD" };

function opening(usd: number, eur: number, asOf = "2026-09-30", rate?: string): UsdPoolCheckpoint {
  return {
    record: "checkpoint", pool_key: KEY, kind: "opening", as_of: asOf, ts: endOfDaySeconds(asOf),
    usd_cents: usd, eur_cents: eur, fx_cents: 0, journal_id: null, document_number: null,
    rate: rate ?? (usd === 0 ? "1.1000" : (usd / eur).toFixed(12)), rate_date: asOf, approved: true, recorded_at: "t",
  };
}

function ts(day: string, time = "12:00:00"): number {
  return Date.parse(`${day}T${time}Z`) / 1000;
}

function event(ref: string, day: string, kind: UsdPoolEvent["kind"], usd: number, eur: number, journalId: number, brokerNet = eur): UsdPoolEvent {
  return {
    record: "event", pool_key: KEY, ref, ts: ts(day), kind, usd_cents: usd, eur_cents: eur,
    document_number: `LY:${ref}`, journal_id: journalId, journal_broker_net_cents: brokerNet, state: "committed", recorded_at: "t",
  };
}

function journal(id: number, documentNumber: string, brokerNetCents: number, extra: Partial<Journal> = {}): Journal {
  return {
    id, document_number: documentNumber, effective_date: "2026-10-01", registered: true, is_deleted: false,
    postings: [{ accounts_id: 1020, accounts_dimensions_id: 11, type: brokerNetCents >= 0 ? "D" : "C", amount: Math.abs(brokerNetCents) / 100 }],
    ...extra,
  };
}

function poolApi(journals: Journal[]) {
  const byId = new Map(journals.map(j => [j.id!, j]));
  const api = {
    journals: {
      invalidateListCache: vi.fn(),
      listAll: vi.fn(async () => [...byId.values()]),
      get: vi.fn(async (id: number) => {
        const found = byId.get(id);
        if (!found) throw new HttpError("not found", 404, "GET", "/journals");
        return found;
      }),
    },
    byId,
  };
  return api as typeof api & ApiContext;
}

const UNTIL = eventOrder("OR-BUY", ts("2026-10-19", "14:43:49"));

describe("USD pool identity and helpers", () => {
  it("reads the Lightyear account and period from the statement file name", () => {
    expect(lightyearAccountFromFileName("/x/AccountStatement-LY-CHZELUU-2026-09-01_2026-10-30_et.csv")).toBe("CHZELUU");
    expect(lightyearAccountFromFileName("statement.csv")).toBeNull();
    expect(statementPeriodFromFileName("AccountStatement-LY-A6YGFLX-2026-01-01_2026-10-30_et.csv")).toEqual({ from: "2026-01-01", to: "2026-10-30" });
  });

  it("values USD at an ECB string rate with exact half-up decimal arithmetic", () => {
    expect(usdCentsToEurCents(905, "1.1225")).toBe(806); // 8.0624 → 8.06
    expect(usdCentsToEurCents(10000, "1.1172")).toBe(8951);
    expect(usdCentsToEurCents(130, "1.1225")).toBe(116);
    expect(usdCentsToEurCents(1, "0")).toBeNull();
  });

  it("relieves at average carrying value; full relief takes the whole carrying value", () => {
    expect(relieveCents({ usd_cents: 10905, eur_cents: 9702 }, 905)).toEqual({ ok: true, value: 805 });
    expect(relieveCents({ usd_cents: 100, eur_cents: 33 }, 100)).toEqual({ ok: true, value: 33 });
    expect(relieveCents({ usd_cents: 100, eur_cents: 33 }, 101)).toEqual({ ok: false, code: "usd_pool_insufficient" });
  });

  it("successive reliefs from 3.00 USD / 1.00 EUR give 0.33, 0.34, 0.33", () => {
    const snapshot = { pool_key: KEY, opening: opening(300, 100), base: opening(300, 100), events: [], snapshot_digest: "d" };
    const projected = projectPool(snapshot, [
      { ref: "B1", ts: ts("2026-10-01"), usd_delta_cents: -100, eur: "relief" },
      { ref: "B2", ts: ts("2026-10-02"), usd_delta_cents: -100, eur: "relief" },
      { ref: "B3", ts: ts("2026-10-03"), usd_delta_cents: -100, eur: "relief" },
    ]);
    expect(projected.map(p => p.ok && p.relief_eur_cents)).toEqual([33, 34, 33]);
  });

  it("two full-pool buys: the first books, the second is insufficient; a failure stops later commands", () => {
    const snapshot = { pool_key: KEY, opening: opening(10000, 9000), base: opening(10000, 9000), events: [], snapshot_digest: "d" };
    expect(projectPool(snapshot, [
      { ref: "B1", ts: ts("2026-10-01"), usd_delta_cents: -10000, eur: "relief" },
      { ref: "B2", ts: ts("2026-10-02"), usd_delta_cents: -10000, eur: "relief" },
    ])).toEqual([
      expect.objectContaining({ ref: "B1", ok: true, relief_eur_cents: 9000 }),
      { ref: "B2", ok: false, code: "usd_pool_insufficient" },
    ]);
    expect(projectPool(snapshot, [
      { ref: "B1", ts: ts("2026-10-01"), usd_delta_cents: -100, eur: "relief", blocked: "ecb_rate_unavailable" },
      { ref: "B2", ts: ts("2026-10-02"), usd_delta_cents: -100, eur: "relief" },
    ])).toEqual([
      { ref: "B1", ok: false, code: "ecb_rate_unavailable" },
      { ref: "B2", ok: false, code: "usd_pool_prerequisite_failed" },
    ]);
  });

  it("orders checkpoints before events at equal timestamps, deterministically by ref", () => {
    const records: UsdPoolRecord[] = [
      opening(100, 90),
      event("B-2", "2026-10-20", "buy_relief", -10, -9, 2),
      event("B-1", "2026-10-20", "buy_relief", -10, -9, 1),
      event("D-9", "2026-10-30", "distribution_in", 100, 80, 3),
    ];
    expect(poolFrontier(records)?.record).toMatchObject({ ref: "B-2" });
    expect(checkpointOrder("revaluation", "2026-10-20").rank).toBe(0);
  });

  it("a later committed sell_in (fixed-EUR inflow) does not move the frontier: an earlier revaluation is not backdated (plan Q3)", () => {
    const records: UsdPoolRecord[] = [
      opening(100, 90),
      event("B-1", "2026-10-10", "buy_relief", -10, -9, 1),
      event("S-1", "2026-10-25", "sell_in", 1000, 800, 2),
    ];
    expect(poolFrontier(records)?.record).toMatchObject({ ref: "B-1" });
    expect(compareOrder(checkpointOrder("revaluation", "2026-10-20"), poolFrontier(records)!.order)).toBeGreaterThan(0);
  });
});

describe("validateUsdPool", () => {
  const base = (records: UsdPoolRecord[], journals: Journal[], extra: Partial<Parameters<typeof validateUsdPool>[0]> = {}) =>
    validateUsdPool({
      api: poolApi(journals), store: memoryUsdPoolStore(records), key: KEY, until: UNTIL, newRecords: [UNTIL],
      statement: NO_STATEMENT, requireRegistered: false, ...extra,
    });

  it("replays the opening plus logged distributions (worked example 109.05 USD / 97.02 EUR)", async () => {
    const records = [opening(10000, 8900), event("IN-1", "2026-10-01", "distribution_in", 775, 686, 1), event("DD-1", "2026-10-02", "distribution_in", 130, 116, 2)];
    const result = await base(records, [journal(1, "LY:IN-1", 686), journal(2, "LY:DD-1", 116)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toHaveLength(2);
    const [projected] = projectPool(result.value, [{ ref: "OR-BUY", ts: UNTIL.ts, usd_delta_cents: -905, eur: "relief" }]);
    expect(projected).toMatchObject({ ok: true, relief_eur_cents: 805, state_before: { usd_cents: 10905, eur_cents: 9702 } });
  });

  it("an interleaved later distribution does not block an earlier buy, and is excluded from its state", async () => {
    const records = [opening(10000, 9000), event("D-1", "2026-10-01", "distribution_in", 10000, 8000, 1), event("D-30", "2026-10-30", "distribution_in", 10000, 10000, 2)];
    const until = eventOrder("OR-19", ts("2026-10-19"));
    const result = await validateUsdPool({
      api: poolApi([journal(1, "LY:D-1", 8000), journal(2, "LY:D-30", 10000)]), store: memoryUsdPoolStore(records), key: KEY,
      until, newRecords: [until], statement: NO_STATEMENT, requireRegistered: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [projected] = projectPool(result.value, [{ ref: "OR-19", ts: until.ts, usd_delta_cents: -10000, eur: "relief" }]);
    expect(projected).toMatchObject({ ok: true, relief_eur_cents: 8500 });
  });

  it("refuses a new record ordered at or before a committed relief (backdated)", async () => {
    const records = [opening(10000, 9000), event("OR-20", "2026-10-20", "buy_relief", -1000, -900, 1, -900)];
    const retro = checkpointOrder("revaluation", "2026-10-19");
    const result = await validateUsdPool({
      api: poolApi([journal(1, "LY:OR-20", -900)]), store: memoryUsdPoolStore(records), key: KEY,
      until: retro, newRecords: [retro], statement: NO_STATEMENT, requireRegistered: true,
    });
    expect(result).toMatchObject({ ok: false, code: "usd_pool_backdated_event", detail: "LY:OR-20" });
  });

  it("an edited or deleted logged journal after the latest checkpoint is usd_pool_event_mismatch", async () => {
    const records = [opening(10000, 9000), event("IN-1", "2026-10-01", "distribution_in", 775, 686, 1)];
    expect(await base(records, [journal(1, "LY:IN-1", 600)])).toMatchObject({ ok: false, code: "usd_pool_event_mismatch" });
    expect(await base(records, [])).toMatchObject({ ok: false, code: "usd_pool_event_mismatch" });
    expect(await base(records, [journal(1, "LY:IN-1", 686, { is_deleted: true })])).toMatchObject({ ok: false, code: "usd_pool_event_mismatch" });
  });

  it("a draft is fine for C4 but usd_pool_event_unregistered for C5", async () => {
    const records = [opening(10000, 9000), event("IN-1", "2026-10-01", "distribution_in", 775, 686, 1)];
    const drafts = [journal(1, "LY:IN-1", 686, { registered: false })];
    expect((await base(records, drafts)).ok).toBe(true);
    expect(await base(records, drafts, { requireRegistered: true })).toMatchObject({ ok: false, code: "usd_pool_event_unregistered" });
  });

  it("validates the whole chain from the opening: a deleted or edited pre-checkpoint journal breaks it", async () => {
    const reval: UsdPoolCheckpoint = {
      record: "checkpoint", pool_key: KEY, kind: "revaluation", as_of: "2026-10-15", ts: endOfDaySeconds("2026-10-15"),
      usd_cents: 10775, eur_cents: 9700, fx_cents: 14, journal_id: 9, document_number: "LY-FX:CHZELUU:USD:2026-10-15",
      rate: "1.1108", rate_date: "2026-10-15", recorded_at: "t",
    };
    const records = [opening(10000, 9000), event("IN-1", "2026-10-01", "distribution_in", 775, 686, 1), reval];
    const good = [journal(1, "LY:IN-1", 686), journal(9, "LY-FX:CHZELUU:USD:2026-10-15", 14)];
    expect((await base(records, good)).ok).toBe(true);
    expect(await base(records, [good[1]!])).toMatchObject({ ok: false, code: "usd_pool_chain_broken" });
    expect(await base(records, [journal(1, "LY:IN-1", 690), good[1]!])).toMatchObject({ ok: false, code: "usd_pool_chain_broken" });
    expect(await base(records, [good[0]!])).toMatchObject({ ok: false, code: "usd_pool_chain_broken" });
  });

  it("a stored checkpoint that differs from the replay breaks the chain", async () => {
    const reval: UsdPoolCheckpoint = {
      record: "checkpoint", pool_key: KEY, kind: "revaluation", as_of: "2026-10-15", ts: endOfDaySeconds("2026-10-15"),
      usd_cents: 10000, eur_cents: 9015, fx_cents: 14, journal_id: 9, document_number: "LY-FX:CHZELUU:USD:2026-10-15",
      rate: "1.1108", rate_date: "2026-10-15", recorded_at: "t",
    };
    const journals = [journal(9, "LY-FX:CHZELUU:USD:2026-10-15", 14)];
    expect((await base([opening(10000, 9001), reval], journals)).ok).toBe(true);
    expect(await base([opening(10000, 9000), reval], journals)).toMatchObject({ ok: false, code: "usd_pool_chain_broken" });
    expect(await base([opening(10000, 9001), { ...reval, usd_cents: 10001 }], journals)).toMatchObject({ ok: false, code: "usd_pool_chain_broken" });
  });

  it("reads journals fresh: the cache is invalidated before the snapshot is taken", async () => {
    const records = [opening(10000, 9000), event("IN-1", "2026-10-01", "distribution_in", 775, 686, 1)];
    const api = poolApi([journal(1, "LY:IN-1", 686)]);
    const calls: string[] = [];
    api.journals.invalidateListCache.mockImplementation(() => calls.push("invalidate"));
    api.journals.listAll.mockImplementation(async () => { calls.push("list"); return [...api.byId.values()]; });
    api.journals.get.mockImplementation(async (id: number) => { calls.push("get"); const j = api.byId.get(id); if (!j) throw new HttpError("nf", 404, "GET", "/journals"); return j; });
    await validateUsdPool({ api, store: memoryUsdPoolStore(records), key: KEY, until: UNTIL, newRecords: [UNTIL], statement: NO_STATEMENT, requireRegistered: false });
    expect(calls[0]).toBe("invalidate");
  });

  it("a zero-FX checkpoint is verified by recomputation with its stored rate", async () => {
    const zero: UsdPoolCheckpoint = {
      record: "checkpoint", pool_key: KEY, kind: "revaluation", as_of: "2026-10-15", ts: endOfDaySeconds("2026-10-15"),
      usd_cents: 10000, eur_cents: 9000, fx_cents: 0, journal_id: null, document_number: null,
      rate: "1.11111", rate_date: "2026-10-15", recorded_at: "t",
    };
    expect((await base([opening(10000, 9000), zero], [])).ok).toBe(true);
    expect(await base([opening(10000, 9000), { ...zero, rate: "1.2" }], [])).toMatchObject({ ok: false, code: "usd_pool_chain_broken" });
  });

  it("completeness: unbooked prerequisite, unsupported event, booked sweep", async () => {
    const records = [opening(10000, 9000)];
    expect(await base(records, [], { statement: statementOf([{ ref: "DD-X", ts: ts("2026-10-05"), role: "distribution_in" }]) }))
      .toMatchObject({ ok: false, code: "usd_pool_prerequisite_unbooked", detail: "DD-X" });
    expect(await base(records, [], { statement: statementOf([{ ref: "WL-X", ts: ts("2026-10-05"), role: "unsupported" }]) }))
      .toMatchObject({ ok: false, code: "usd_pool_unsupported_event" });
    expect(await base(records, [journal(5, "LY:OR-SWEEP", 905)], { statement: statementOf([{ ref: "OR-SWEEP", ts: ts("2026-10-05"), role: "sweep" }]) }))
      .toMatchObject({ ok: false, code: "usd_pool_sweep_booked" });
    expect((await base(records, [], { statement: statementOf([{ ref: "DD-X", ts: ts("2026-09-29"), role: "distribution_in" }, { ref: "OR-BUY", ts: UNTIL.ts, role: "buy_relief" }]) })).ok).toBe(true);
  });

  it("an opening whose EUR value does not recompute from its rate, or that was never approved, is not accepted", async () => {
    expect(await base([{ ...opening(10000, 9000, "2026-09-30", "1.1"), eur_cents: 9001 }], [])).toMatchObject({ ok: false, code: "usd_pool_chain_broken" });
    expect((await base([opening(10000, 9091, "2026-09-30", "1.1")], [])).ok).toBe(true);
    const { approved: _approved, ...unapproved } = opening(10000, 9091, "2026-09-30", "1.1");
    expect(await base([unapproved], [])).toMatchObject({ ok: false, code: "usd_pool_checkpoint_missing" });
  });

  it("missing opening, intents, other broker target and single-file mode are reviews", async () => {
    expect(await base([], [])).toMatchObject({ ok: false, code: "usd_pool_checkpoint_missing" });
    expect(await base([opening(1, 1), { ...event("X", "2026-10-01", "distribution_in", 1, 1, 1), state: "intent" }], []))
      .toMatchObject({ ok: false, code: "usd_pool_uncertain_outcome" });
    expect(await base([{ ...opening(1, 1), pool_key: { ...KEY, broker_dimension_id: 12 } }], []))
      .toMatchObject({ ok: false, code: "usd_pool_target_mismatch" });
    const result = await validateUsdPool({
      api: poolApi([]), store: memoryUsdPoolStore([], { unavailable: true }), key: KEY, until: UNTIL, newRecords: [], statement: NO_STATEMENT, requireRegistered: false,
    });
    expect(result).toMatchObject({ ok: false, code: "usd_pool_unavailable" });
  });

  it("two Lightyear accounts on two broker dimensions keep separate pools", async () => {
    const other: PoolKey = { ...KEY, lightyear_account: "A6YGFLX", broker_dimension_id: 12 };
    const records: UsdPoolRecord[] = [opening(10000, 9000), { ...opening(500, 450), pool_key: other }];
    const result = await base(records, []);
    expect(result.ok && result.value.base.usd_cents).toBe(10000);
  });
});

describe("recoverUsdPoolIntents", () => {
  const intent = (): UsdPoolEvent => ({ ...event("OR-1", "2026-10-19", "buy_relief", -905, -805, 0, -35796), journal_id: null, state: "intent" });

  it("a journal found with the intended postings is committed without a second create", async () => {
    const store = memoryUsdPoolStore([opening(10000, 9000), intent()]);
    const api = poolApi([journal(77, "LY:OR-1", -35796)]);
    expect(await recoverUsdPoolIntents(api, store, KEY)).toMatchObject({ ok: true });
    expect(store.records.find(r => r.record === "event")).toMatchObject({ state: "committed", journal_id: 77 });
  });

  it("no journal → the intent is dropped", async () => {
    const store = memoryUsdPoolStore([opening(10000, 9000), intent()]);
    expect(await recoverUsdPoolIntents(poolApi([]), store, KEY)).toMatchObject({ ok: true });
    expect(store.records.some(r => r.record === "event")).toBe(false);
  });

  it("a failing lookup or a journal with other postings leaves the pool blocked", async () => {
    const store = memoryUsdPoolStore([opening(10000, 9000), intent()]);
    const failing = poolApi([]);
    failing.journals.listAll.mockRejectedValue(new Error("down"));
    expect(await recoverUsdPoolIntents(failing, store, KEY)).toEqual({ ok: false, code: "usd_pool_uncertain_outcome" });
    expect(await recoverUsdPoolIntents(poolApi([journal(77, "LY:OR-1", -100)]), store, KEY)).toEqual({ ok: false, code: "usd_pool_uncertain_outcome" });
    expect(store.records.find(r => r.record === "event")).toMatchObject({ state: "intent" });
  });

  it("a revaluation intent commits its checkpoint", async () => {
    const checkpoint: UsdPoolCheckpoint = {
      record: "checkpoint", pool_key: KEY, kind: "revaluation", as_of: "2026-10-30", ts: endOfDaySeconds("2026-10-30"),
      usd_cents: 10000, eur_cents: 8951, fx_cents: 54, journal_id: null, document_number: "LY-FX:CHZELUU:USD:2026-10-30",
      rate: "1.1172", rate_date: "2026-10-30", recorded_at: "t",
    };
    const store = memoryUsdPoolStore([opening(10000, 8897), {
      record: "event", pool_key: KEY, ref: "LY-FX:CHZELUU:USD:2026-10-30", ts: checkpoint.ts, kind: "revaluation", usd_cents: 0, eur_cents: 54,
      document_number: "LY-FX:CHZELUU:USD:2026-10-30", journal_id: null, journal_broker_net_cents: 54, state: "intent", checkpoint, recorded_at: "t",
    }]);
    expect((await recoverUsdPoolIntents(poolApi([journal(5, "LY-FX:CHZELUU:USD:2026-10-30", 54)]), store, KEY)).ok).toBe(true);
    expect(store.records.filter(r => r.record === "event")).toHaveLength(0);
    expect(store.records.find(r => r.record === "checkpoint" && r.kind === "revaluation")).toMatchObject({ journal_id: 5, eur_cents: 8951 });
  });
});

describe("recoverUsdPoolIntents — checkpoint write failure (review wpc 2)", () => {
  it("a failed checkpoint write keeps the intent; the next recovery completes and a 50 USD buy relieves €47.50", async () => {
    // Opening 100 USD / €90; the +€5 revaluation journal is already booked, its intent not yet committed.
    const checkpoint: UsdPoolCheckpoint = {
      record: "checkpoint", pool_key: KEY, kind: "revaluation", as_of: "2026-10-15", ts: endOfDaySeconds("2026-10-15"),
      usd_cents: 10000, eur_cents: 9500, fx_cents: 500, journal_id: null, document_number: "LY-FX:CHZELUU:USD:2026-10-15",
      rate: "1.0526", rate_date: "2026-10-15", recorded_at: "t",
    };
    const intent: UsdPoolEvent = {
      record: "event", pool_key: KEY, ref: "LY-FX:CHZELUU:USD:2026-10-15", ts: checkpoint.ts, kind: "revaluation", usd_cents: 0, eur_cents: 500,
      document_number: "LY-FX:CHZELUU:USD:2026-10-15", journal_id: null, journal_broker_net_cents: 500, state: "intent", checkpoint, recorded_at: "t",
    };
    const store = memoryUsdPoolStore([opening(10000, 9000, "2026-09-30", "1.1111111111"), intent]);
    const upsert = store.upsert.bind(store);
    let failNext = true;
    store.upsert = records => {
      if (failNext) { failNext = false; throw new Error("disk full"); }
      upsert(records);
    };
    const api = poolApi([journal(5, "LY-FX:CHZELUU:USD:2026-10-15", 500)]);
    expect(await recoverUsdPoolIntents(api, store, KEY)).toEqual({ ok: false, code: "usd_pool_uncertain_outcome" });
    expect(store.records.filter(r => r.record === "event")).toMatchObject([{ state: "intent", kind: "revaluation" }]);
    expect((await recoverUsdPoolIntents(api, store, KEY)).ok).toBe(true);
    expect(store.records.filter(r => r.record === "event")).toHaveLength(0);
    const until = eventOrder("OR-LATER", ts("2026-10-20"));
    const validated = await validateUsdPool({ api, store, key: KEY, until, newRecords: [until], statement: NO_STATEMENT, requireRegistered: false });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(projectPool(validated.value, [{ ref: "OR-LATER", ts: until.ts, usd_delta_cents: -5000, eur: "relief" }])[0]).toMatchObject({ ok: true, relief_eur_cents: 4750 });
  });
});

describe("withUsdPoolLock", () => {
  it("serializes critical sections on one pool", async () => {
    process.env.EARVELDAJA_LOCK_DIR = mkdtempSync(join(tmpdir(), "usd-pool-lock-"));
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withUsdPoolLock(KEY, memoryUsdPoolStore(), async () => { order.push("a-start"); await gate; order.push("a-end"); });
    const second = withUsdPoolLock(KEY, memoryUsdPoolStore(), async () => { order.push("b"); });
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});

describe("replayUsdOpening", () => {
  const fund = new Set(["ICSUSSDP"]);
  const row = (day: string, time: string, type: string, ccy: string, cash: number | null, extra: { ticker?: string; quantity?: number; price?: number } = {}, index = 0) => ({
    ts: ts(day, time), row_index: index, type, ticker: extra.ticker ?? "", ccy, quantity: extra.quantity ?? 0, price_per_share: extra.price ?? 0, cash_delta: cash,
  });

  it("replays USD cash plus fund units from the first deposit", () => {
    const result = replayUsdOpening([
      row("2026-01-13", "10:00:00", "Conversion", "USD", 100),
      row("2026-01-14", "10:00:00", "Buy", "USD", -60, { ticker: "ICSUSSDP", quantity: 60, price: 1 }),
      row("2026-01-15", "10:00:00", "Distribution", "USD", 0.37),
      row("2026-02-01", "10:00:00", "Conversion", "USD", 50),
    ], endOfDaySeconds("2026-01-31"), fund);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ usd_cents: 10037, cash_cents: 4037, fund_units_cents: 6000, rows_replayed: 3 }) });
  });

  it("negative replay is unproven; a fund price other than 1.00 is a review", () => {
    expect(replayUsdOpening([row("2026-01-13", "10:00:00", "Conversion", "USD", -0.37)], endOfDaySeconds("2026-12-31"), fund))
      .toMatchObject({ ok: false, code: "usd_pool_opening_replay_unproven" });
    expect(replayUsdOpening([
      row("2026-01-13", "10:00:00", "Conversion", "USD", 10),
      row("2026-01-14", "10:00:00", "Buy", "USD", -10, { ticker: "ICSUSSDP", quantity: 9.99, price: 1.001 }),
    ], endOfDaySeconds("2026-12-31"), fund)).toMatchObject({ ok: false, code: "usd_pool_fund_price_not_stable" });
  });

  it("rows in the same second settle together", () => {
    expect(replayUsdOpening([
      row("2026-01-13", "10:00:00", "Buy", "USD", -400, {}, 0),
      row("2026-01-13", "10:00:00", "Conversion", "USD", 400, {}, 1),
    ], endOfDaySeconds("2026-12-31"), fund)).toMatchObject({ ok: true, value: { usd_cents: 0 } });
  });
});
