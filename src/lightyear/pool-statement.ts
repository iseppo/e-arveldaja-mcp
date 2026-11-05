import { createHash } from "node:crypto";
import { compareOrder, eventOrder, type PoolOrder, type UsdPoolResult } from "./usd-pool.js";

/**
 * Statement side of the USD cash-fund pool (plan Q2, Codex r1 #1–#4): one role
 * per USD statement row, and the pure checks production (validateUsdPool, the
 * trades valuation, the revaluation) and the read-only rebuild both run.
 */

/** One role per USD statement row (`row_index`). */
export type PoolRole =
  | "pass_through"
  | "sweep"
  | "distribution_in"
  | "sell_in"
  | "buy_relief"
  | "conversion_out"
  | "unsupported"
  | "pairing_ambiguous"
  | "unplaceable";

/** The statement fields the classification needs (amounts in the row's currency, as on the statement). */
export interface PoolStatementRow {
  row_index: number;
  reference: string;
  /** Statement timestamp in seconds; null when the date is not a strict DD/MM/YYYY HH:MM:SS. */
  ts: number | null;
  type: string;
  ticker: string;
  ccy: string;
  quantity: number;
  price_per_share: number;
  gross_amount: number;
  fee: number;
  net_amount: number;
  /** The statement's FX rate column (conversions; journal-free evidence). */
  fx_rate: number;
}

/** Trade↔conversion pairing decided by the trade extraction (order-independent). */
export interface PoolPairing {
  /** Non-fund USD trade rows: paired 1:1, in an ambiguous group, or left for the pool stages. */
  trades: ReadonlyMap<number, "paired" | "ambiguous" | "unmatched">;
  /** Conversion references claimed by the 1:1 stage, or blocked by an ambiguous group. */
  conversions: ReadonlyMap<string, "paired" | "ambiguous">;
  /** Conversions a pool-funded (N:1) buy consumes. */
  fundedConversions: ReadonlySet<string>;
}

export interface ClassifyStatementPoolInput {
  pairing: PoolPairing;
  /** Cash-fund tickers whose Buy/Sell rows are intra-pool sweeps. */
  fundTickers: ReadonlySet<string>;
  /** Conversions a distribution consumed (statement-converted distributions). */
  distributionConversions: ReadonlySet<string>;
  /** Retained USD distribution rows (no conversion candidate). */
  retainedDistributionRows: ReadonlySet<number>;
  /** Distribution rows converted by a statement conversion. */
  convertedDistributionRows: ReadonlySet<number>;
}

export interface StatementPoolEvent {
  ref: string;
  row_index: number;
  ts: number | null;
  role: PoolRole;
}

const DISTRIBUTION_TYPES = new Set(["Dividend", "Distribution", "Interest", "Reward"]);

function isUsd(ccy: string): boolean {
  return ccy.trim().toUpperCase() === "USD";
}

/** Exactly one entry per USD row of `rows`, in row order. */
export function classifyStatementPool(rows: readonly PoolStatementRow[], input: ClassifyStatementPoolInput): StatementPoolEvent[] {
  const events: StatementPoolEvent[] = [];
  for (const row of rows) {
    if (!isUsd(row.ccy)) continue;
    const role = row.ts === null ? "unplaceable" : roleOf(row, input);
    events.push({ ref: row.reference, row_index: row.row_index, ts: row.ts, role });
  }
  return events;
}

function roleOf(row: PoolStatementRow, input: ClassifyStatementPoolInput): PoolRole {
  if (row.type === "Buy" || row.type === "Sell") {
    if (input.fundTickers.has(row.ticker)) return "sweep";
    const pairing = input.pairing.trades.get(row.row_index);
    if (pairing === "paired") return "pass_through";
    if (pairing === "ambiguous") return "pairing_ambiguous";
    return row.type === "Buy" ? "buy_relief" : "sell_in";
  }
  if (row.type === "Conversion") {
    const pairing = input.pairing.conversions.get(row.reference);
    if (pairing === "paired") return "pass_through";
    if (pairing === "ambiguous") return "pairing_ambiguous";
    if (input.pairing.fundedConversions.has(row.reference) || input.distributionConversions.has(row.reference)) return "pass_through";
    // USD leaving (USD→EUR) drains the pool; USD arriving with no trade is not supported (OQ3).
    return row.net_amount < 0 || row.gross_amount < 0 ? "conversion_out" : "unsupported";
  }
  if (DISTRIBUTION_TYPES.has(row.type)) {
    if (input.retainedDistributionRows.has(row.row_index)) return "distribution_in";
    if (input.convertedDistributionRows.has(row.row_index)) return "pass_through";
  }
  return "unsupported";
}

/**
 * Normalized source evidence of one pool event (review 2026-11-01 #2): the
 * timestamp and USD quantities of every USD statement row of `ref`, sorted by
 * content (row indexes differ between exports). Stored on the event when it is
 * logged; a later statement covering its day must reproduce it. Null when the
 * statement has no USD row of `ref` or an amount is not whole cents.
 */
export function poolSourceDigest(rows: readonly PoolStatementRow[], ref: string): string | null {
  const own: Array<Array<string | number | null>> = [];
  for (const row of rows) {
    if (row.reference !== ref || !isUsd(row.ccy)) continue;
    const amounts = [row.gross_amount, row.fee, row.net_amount].map(value => {
      const scaled = Math.round(value * 100);
      return Number.isFinite(value) && Math.abs(value * 100 - scaled) < 1e-6 ? scaled : null;
    });
    if (amounts.some(value => value === null)) return null;
    own.push([row.ts, row.type, row.ticker, String(row.quantity), ...amounts]);
  }
  if (own.length === 0) return null;
  own.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return createHash("sha256").update(JSON.stringify([ref, own])).digest("hex");
}

const INFLOW_ROLES: ReadonlySet<PoolRole> = new Set(["distribution_in", "sell_in"]);
const OUTFLOW_ROLES: ReadonlySet<PoolRole> = new Set(["buy_relief", "conversion_out"]);

/** Interval of pool history a check covers: rows ordered after `after` and before `until`. */
export interface PoolInterval {
  after: PoolOrder;
  until: PoolOrder;
}

function inInterval(event: StatementPoolEvent, interval: PoolInterval): boolean {
  if (event.ts === null) return false;
  const order = eventOrder(event.ref, event.ts);
  return compareOrder(order, interval.after) > 0 && compareOrder(order, interval.until) < 0;
}

function cents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const scaled = Math.round(Math.abs(value) * 100);
  return Math.abs(Math.abs(value) * 100 - scaled) < 1e-6 ? scaled : null;
}

/**
 * Every sweep row in the interval is an exact intra-pool no-op: price exactly
 * 1.00, no fee, gross equal to quantity (plan §2(d)).
 */
export function checkSweeps(
  events: readonly StatementPoolEvent[],
  rows: readonly PoolStatementRow[],
  interval: PoolInterval,
): UsdPoolResult<void> {
  const byIndex = new Map(rows.map(row => [row.row_index, row]));
  for (const event of events) {
    if (event.role !== "sweep" || !inInterval(event, interval)) continue;
    const row = byIndex.get(event.row_index)!;
    const gross = cents(row.gross_amount);
    if (row.price_per_share !== 1 || row.fee !== 0 || gross === null || gross !== cents(row.quantity) || gross !== cents(row.net_amount)) {
      return { ok: false, code: "usd_pool_fund_price_not_stable", detail: event.ref };
    }
  }
  return { ok: true, value: undefined };
}

/**
 * The earliest second after `after` that holds both a pool inflow and a
 * state-dependent outflow: the statement's 1-second resolution does not prove
 * their order, so every pool command at or after it is refused
 * (`usd_pool_ambiguous_order`). Null when there is none.
 */
export function checkMixedSeconds(events: readonly StatementPoolEvent[], after: PoolOrder): number | null {
  const seconds = new Map<number, { inflow: boolean; outflow: boolean }>();
  for (const event of events) {
    if (event.ts === null || event.ts <= after.ts) continue;
    const entry = seconds.get(event.ts) ?? { inflow: false, outflow: false };
    if (INFLOW_ROLES.has(event.role)) entry.inflow = true;
    if (OUTFLOW_ROLES.has(event.role)) entry.outflow = true;
    seconds.set(event.ts, entry);
  }
  let earliest: number | null = null;
  for (const [ts, entry] of seconds) {
    if (entry.inflow && entry.outflow && (earliest === null || ts < earliest)) earliest = ts;
  }
  return earliest;
}

export interface CompletenessInput {
  interval: PoolInterval;
  /** Refs with a committed pool record. */
  committedRefs: ReadonlySet<string>;
  /** Refs this plan itself books. */
  plannedRefs: ReadonlySet<string>;
  /** Refs that already have a live `LY:<ref>` (or bare `<ref>`) journal. */
  bookedRefs: ReadonlySet<string>;
}

/**
 * Completeness of the statement against the pool log:
 * - any unplaceable USD row blocks the whole pool for this statement;
 * - in the interval: an ambiguous pairing, an unsupported row, a booked sweep,
 *   or a pool-logged role that is neither committed nor planned is refused.
 */
export function checkStatementCompleteness(events: readonly StatementPoolEvent[], input: CompletenessInput): UsdPoolResult<void> {
  const unplaceable = events.find(event => event.role === "unplaceable");
  if (unplaceable) return { ok: false, code: "usd_pool_row_unplaceable", detail: unplaceable.ref };
  for (const event of events) {
    if (!inInterval(event, input.interval)) continue;
    switch (event.role) {
      case "pairing_ambiguous": return { ok: false, code: "usd_pool_pairing_ambiguous", detail: event.ref };
      case "unsupported": return { ok: false, code: "usd_pool_unsupported_event", detail: event.ref };
      case "sweep":
        if (input.bookedRefs.has(event.ref)) return { ok: false, code: "usd_pool_sweep_booked", detail: event.ref };
        continue;
      case "pass_through":
        continue;
      default:
        if (input.committedRefs.has(event.ref) || input.plannedRefs.has(event.ref)) continue;
        return {
          ok: false, code: "usd_pool_prerequisite_unbooked",
          detail: input.bookedRefs.has(event.ref) ? `${event.ref} (booked outside the pool log)` : event.ref,
        };
    }
  }
  return { ok: true, value: undefined };
}
