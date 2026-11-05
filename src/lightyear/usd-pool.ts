import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { withOwnedFileLock } from "../file-lock.js";
import { createConnectionScopedBundleStore, type ConnectionScopedBundleStore } from "../connection-scoped-bundle-store.js";
import { isNotFoundHttpError } from "../http-client.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { Journal } from "../types/api.js";
import {
  checkMixedSeconds,
  checkStatementCompleteness,
  checkSweeps,
  poolSourceDigest,
  type PoolStatementRow,
  type StatementPoolEvent,
} from "./pool-statement.js";

/**
 * USD cash-equivalent pool (plan WP-C C2, owner Q1/Q3/Q13).
 *
 * All USD held at Lightyear — as cash or as ICSUSSDP units at 1.00 — sits in
 * the broker account/dimension at its EUR carrying value. The pool's carrying
 * value is tracked ONLY from its own event log (USD quantity and booked EUR
 * deltas) starting at an owner-approved opening checkpoint, never from the
 * ledger balance of the broker account (no plug).
 *
 * One pool per {@link PoolKey}, one serialized async lock per pool
 * ({@link withUsdPoolLock}), one shared validator ({@link validateUsdPool}).
 * Every pool-touching execute runs recover → validate → intent → create →
 * readback → commit inside the lock; an intent without a commit blocks the
 * pool until {@link recoverUsdPoolIntents} resolves it (journals are never
 * recreated by recovery).
 */

export interface PoolKey {
  connection_fingerprint: string;
  /** Lightyear account id from the statement file name (e.g. CHZELUU) or the `lightyear_account` argument. */
  lightyear_account: string;
  broker_account: number;
  broker_dimension_id: number | null;
  currency: "USD";
}

export type UsdPoolEventKind = "distribution_in" | "sell_in" | "buy_relief" | "conversion_out" | "revaluation";

export interface UsdPoolCheckpoint {
  record: "checkpoint";
  pool_key: PoolKey;
  kind: "opening" | "revaluation";
  /** End of this day (Europe/Tallinn statement time). */
  as_of: string;
  ts: number;
  usd_cents: number;
  eur_cents: number;
  /** EUR booked by the revaluation journal (0 for an opening or a journal-free checkpoint). */
  fx_cents: number;
  journal_id: number | null;
  document_number: string | null;
  /** ECB rate string (foreign per EUR) the checkpoint was valued at. */
  rate: string;
  rate_date: string;
  /** Opening checkpoints only: stored through a reviewed plan (owner approval). */
  approved?: true;
  /** Canonical postings of the revaluation journal ([] for an opening or a journal-free checkpoint). */
  postings?: PoolPosting[];
  /** Approved effective date of the revaluation journal; readback, recovery and validation require it. */
  effective_date?: string;
  recorded_at: string;
}

export interface UsdPoolEvent {
  record: "event";
  pool_key: PoolKey;
  ref: string;
  ts: number;
  kind: UsdPoolEventKind;
  usd_cents: number;
  eur_cents: number;
  document_number: string;
  journal_id: number | null;
  /** Net broker-dimension posting the journal must carry (D positive, C negative). */
  journal_broker_net_cents: number;
  state: "intent" | "committed";
  /** Revaluation intents carry the checkpoint they commit. */
  checkpoint?: UsdPoolCheckpoint;
  /** Canonical postings of the approved command ([] for a journal-free event). Required (r2: no legacy records). */
  postings?: PoolPosting[];
  /** Journal-free conversion_out only: the proof captured at approval (plan §2, r1 #5). */
  source_evidence?: ConversionEvidence;
  evidence_digest?: string;
  /** Approved effective date of the journal (YYYY-MM-DD); readback, recovery and validation require it. */
  effective_date?: string;
  /** Normalized source rows at logging (poolSourceDigest): a later statement covering the day must reproduce them. */
  source_digest?: string;
  recorded_at: string;
}

export type UsdPoolRecord = UsdPoolEvent | UsdPoolCheckpoint;

/** One journal posting in canonical form: integer cents, explicit null dimension. */
export interface PoolPosting {
  accounts_id: number;
  accounts_dimensions_id: number | null;
  type: "D" | "C";
  amount_cents: number;
}

/** A statement leg of a conversion, as normalized for journal-free evidence (amounts signed as on the statement). */
export interface ConversionLegEvidence {
  ccy: string;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  fx_rate: string;
}

export interface ConversionEvidence {
  ref: string;
  ts: number;
  date_string: string;
  /** Both legs, sorted by currency. */
  legs: ConversionLegEvidence[];
  state_before: { usd_cents: number; eur_cents: number };
  relief_eur_cents: number;
  fee_eur_cents: 0;
  fx_eur_cents: 0;
}

/** The validated, replayed history a plan is built on. */
export interface UsdPoolSnapshot {
  pool_key: PoolKey;
  opening: UsdPoolCheckpoint;
  /** Latest verified checkpoint ordered before the requested point. */
  base: UsdPoolCheckpoint;
  /** Committed events after `base` and before the requested point, in order. */
  events: UsdPoolEvent[];
  snapshot_digest: string;
}

export type UsdPoolReviewCode =
  | "usd_pool_unavailable"
  | "usd_pool_account_unknown"
  | "usd_pool_target_mismatch"
  | "usd_pool_checkpoint_missing"
  | "usd_pool_chain_broken"
  | "usd_pool_backdated_event"
  | "usd_pool_uncertain_outcome"
  | "usd_pool_event_mismatch"
  | "usd_pool_event_unregistered"
  | "usd_pool_prerequisite_unbooked"
  | "usd_pool_unsupported_event"
  | "usd_pool_sweep_booked"
  | "usd_pool_insufficient"
  | "usd_pool_prerequisite_failed"
  | "usd_pool_validation_unavailable"
  | "usd_pool_checkpoint_after_date"
  | "usd_pool_statement_gap"
  | "usd_pool_quantity_mismatch"
  | "usd_pool_fund_price_not_stable"
  | "usd_pool_opening_replay_unproven"
  | "usd_pool_opening_exists"
  | "usd_pool_before_opening"
  | "usd_pool_pairing_ambiguous"
  | "usd_pool_ambiguous_order"
  | "usd_pool_row_unplaceable"
  | "usd_pool_source_changed"
  | "usd_pool_source_unbound";

export const USD_POOL_REVIEW_MESSAGES: Record<UsdPoolReviewCode, string> = {
  usd_pool_unavailable: "The USD cash-fund pool store needs the accounting-rules bundle (not single-file EARVELDAJA_RULES_FILE mode); pool-dependent rows stay in review.",
  usd_pool_account_unknown: "The Lightyear account could not be read from the statement file name (AccountStatement-LY-<ACCOUNT>-…); pass lightyear_account.",
  usd_pool_target_mismatch: "This Lightyear account already has a USD pool on another broker account/dimension; nothing is booked to a second pool.",
  usd_pool_checkpoint_missing: "The USD pool has no approved opening checkpoint yet; run book_lightyear_fx_revaluation with mode \"opening\" first.",
  usd_pool_chain_broken: "A journal the USD pool's history depends on was edited, deleted or no longer matches the pool log, so the carrying value cannot be proven.",
  usd_pool_backdated_event: "A later buy relief, USD→EUR conversion or checkpoint is already committed in the USD pool; booking this earlier event would change it. Nothing is booked.",
  usd_pool_uncertain_outcome: "An earlier pool booking has an uncertain outcome (intent without commit) that recovery could not resolve; check the journal and retry.",
  usd_pool_event_mismatch: "A journal logged in the USD pool was edited or deleted after logging.",
  usd_pool_event_unregistered: "A journal logged in the USD pool is still an unregistered draft; confirm it before revaluing.",
  usd_pool_prerequisite_unbooked: "A USD pool event on the statement (a retained USD distribution, a USD sale kept in USD, a buy paid from USD at Lightyear or a USD→EUR conversion) is not booked and logged yet; book it first.",
  usd_pool_unsupported_event: "The statement holds a USD movement this tool does not book into the pool (a EUR→USD conversion with no trade, a USD deposit, withdrawal or fee, or a distribution whose conversion is reserved by a trade).",
  usd_pool_sweep_booked: "A cash-fund sweep row was booked as a journal that moves the broker account; the pool cannot be replayed.",
  usd_pool_insufficient: "The USD pool holds less USD than this buy or conversion takes from it.",
  usd_pool_prerequisite_failed: "An earlier USD pool command in this plan is not bookable, so later pool commands are not booked either.",
  usd_pool_validation_unavailable: "The USD pool journals could not be read completely; nothing is accepted.",
  usd_pool_checkpoint_after_date: "The USD pool already has a checkpoint after this date; revaluation is never back-dated.",
  usd_pool_statement_gap: "The statement does not cover the whole interval since the last USD pool checkpoint.",
  usd_pool_quantity_mismatch: "The replayed USD pool quantity differs from the holding Lightyear shows for this date; nothing is booked.",
  usd_pool_fund_price_not_stable: "An ICSUSSDP row is not priced at exactly 1.00, so its units cannot be valued as USD cash.",
  usd_pool_opening_replay_unproven: "Replaying the statement drives USD cash or ICSUSSDP units negative, so it does not start from an empty USD position.",
  usd_pool_opening_exists: "The USD pool already has a checkpoint; the opening is set only once (delete the pool's store entry to redo it).",
  usd_pool_before_opening: "This USD pool row is dated on or before the USD pool's approved opening, which already holds its effect; a new journal for it now would leave books and pool apart. Nothing is booked — book such rows before storing the opening, or correct them by hand.",
  usd_pool_pairing_ambiguous: "Same-day USD trades and conversions of the same amount cannot be paired one to one without guessing; none of them is booked and the USD pool stays blocked until they are booked by hand.",
  usd_pool_ambiguous_order: "One statement second holds both USD arriving in the pool and USD leaving it; the statement's 1-second resolution does not prove their order, so this and every later pool booking is refused.",
  usd_pool_source_changed: "The statement now shows a USD pool row already logged in the USD pool with another time, role or USD amount than when it was logged; this and every later pool booking is refused until the difference is reviewed.",
  usd_pool_source_unbound: "The statement rows of this USD pool row cannot be fingerprinted exactly (an amount is not a whole number of cents), so a later statement could not be checked against it; it is not booked and later pool bookings wait for it.",
  usd_pool_row_unplaceable: "A USD row of the statement has no valid date and time, so its place in the USD pool's history is unknown; no pool booking or revaluation is made from this statement.",
};

export type UsdPoolResult<T> = { ok: true; value: T } | { ok: false; code: UsdPoolReviewCode; detail?: string };

export const USD_POOL_STORE_FILE = "lightyear-usd-pool.json";

export function poolKeyId(key: PoolKey): string {
  return JSON.stringify([key.connection_fingerprint, key.lightyear_account, key.broker_account, key.broker_dimension_id, key.currency]);
}

function samePool(a: PoolKey, b: PoolKey): boolean {
  return poolKeyId(a) === poolKeyId(b);
}

export function usdPoolRecordKey(record: UsdPoolRecord): string {
  return record.record === "event"
    ? `e\u0000${poolKeyId(record.pool_key)}\u0000${record.ref}`
    : `c\u0000${poolKeyId(record.pool_key)}\u0000${record.kind}\u0000${record.as_of}`;
}

export type UsdPoolStore = ConnectionScopedBundleStore<UsdPoolRecord>;

export function createUsdPoolStore(): UsdPoolStore {
  return createConnectionScopedBundleStore<UsdPoolRecord>({
    fileName: USD_POOL_STORE_FILE,
    label: "Lightyear USD pool records",
    maxEntries: 4000,
    keyOf: usdPoolRecordKey,
  });
}

/** Process-wide store (bundle-backed). */
export const defaultUsdPoolStore: UsdPoolStore = createUsdPoolStore();

/** Lightyear account id from `AccountStatement-LY-<ACCOUNT>-<from>_<to>_<lang>.csv`. */
export function lightyearAccountFromFileName(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const match = /^AccountStatement-LY-([A-Z0-9]{3,32})-/i.exec(base);
  return match ? match[1]!.toUpperCase() : null;
}

/** Statement period from the file name (`…-YYYY-MM-DD_YYYY-MM-DD_…`). */
export function statementPeriodFromFileName(name: string | undefined): { from: string; to: string } | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const match = /-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:[_.]|$)/.exec(base);
  return match ? { from: match[1]!, to: match[2]! } : null;
}

/**
 * Serialize one pool across processes. The store's read cache is dropped once the
 * lock is held: another process may have committed records since this one last
 * read, and recovery, frontier checks and snapshot comparison must see them.
 */
export async function withUsdPoolLock<T>(key: PoolKey, store: UsdPoolStore, fn: () => Promise<T>): Promise<T> {
  const lockDir = process.env.EARVELDAJA_LOCK_DIR ?? resolve(tmpdir(), "e-arveldaja-mcp-locks");
  const digest = createHash("sha256").update(`usd-pool\u0000${poolKeyId(key)}`).digest("hex");
  return withOwnedFileLock(resolve(lockDir, `${digest}.lock`), () => {
    store.reset();
    return fn();
  }, { timeoutMs: 30_000, pollMs: 25 });
}

/** End-of-day timestamp (seconds) of a YYYY-MM-DD day, in the statement's own clock. */
export function endOfDaySeconds(day: string): number {
  return Date.parse(`${day}T23:59:59Z`) / 1000;
}

// ---- ordering -----------------------------------------------------------------

/**
 * Total order: ts, then event before checkpoint, then ref. A checkpoint stands at
 * its day's last second (23:59:59), so an event in that second belongs to the day
 * it closes (astra review 2026-11-04 #3).
 */
export interface PoolOrder {
  ts: number;
  rank: 0 | 1;
  ref: string;
}

function orderOf(record: UsdPoolRecord): PoolOrder {
  return record.record === "checkpoint"
    ? { ts: record.ts, rank: 1, ref: `${record.kind}:${record.as_of}` }
    : { ts: record.ts, rank: 0, ref: record.ref };
}

export function compareOrder(a: PoolOrder, b: PoolOrder): number {
  return a.ts - b.ts || a.rank - b.rank || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

export function eventOrder(ref: string, ts: number): PoolOrder {
  return { ts, rank: 0, ref };
}

export function checkpointOrder(kind: "opening" | "revaluation", asOf: string): PoolOrder {
  return { ts: endOfDaySeconds(asOf), rank: 1, ref: `${kind}:${asOf}` };
}

/**
 * The append-only history frontier: the latest committed STATE-DEPENDENT record
 * (buy relief, conversion out or checkpoint). A distribution_in or sell_in is
 * state-independent (ECB × USD) and does not advance it.
 */
export function poolFrontier(records: readonly UsdPoolRecord[]): { order: PoolOrder; record: UsdPoolRecord } | null {
  let best: { order: PoolOrder; record: UsdPoolRecord } | null = null;
  for (const record of records) {
    if (record.record === "event" && (record.state !== "committed" || record.kind === "distribution_in" || record.kind === "sell_in")) continue;
    const order = orderOf(record);
    if (best === null || compareOrder(order, best.order) > 0) best = { order, record };
  }
  return best;
}

export interface PoolRecordsView {
  events: UsdPoolEvent[];
  checkpoints: UsdPoolCheckpoint[];
  intents: UsdPoolEvent[];
  opening: UsdPoolCheckpoint | undefined;
}

export function poolRecordsFor(records: readonly UsdPoolRecord[], key: PoolKey): PoolRecordsView {
  const own = records.filter(record => samePool(record.pool_key, key));
  const events = own.filter((r): r is UsdPoolEvent => r.record === "event");
  const checkpoints = own.filter((r): r is UsdPoolCheckpoint => r.record === "checkpoint")
    .sort((a, b) => compareOrder(orderOf(a), orderOf(b)));
  return {
    events: events.filter(e => e.state === "committed").sort((a, b) => compareOrder(orderOf(a), orderOf(b))),
    checkpoints,
    intents: events.filter(e => e.state === "intent"),
    opening: checkpoints.find(c => c.kind === "opening"),
  };
}

/** A pool for the same Lightyear account on another broker target. */
export function findTargetMismatch(records: readonly UsdPoolRecord[], key: PoolKey): boolean {
  return records.some(record =>
    record.pool_key.connection_fingerprint === key.connection_fingerprint &&
    record.pool_key.lightyear_account === key.lightyear_account &&
    record.pool_key.currency === key.currency &&
    !samePool(record.pool_key, key));
}

// ---- money ---------------------------------------------------------------------

/** Round-half-up (away from zero) of numerator / denominator, exact in BigInt. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

/** EUR cents of `usdCents` at an ECB rate string (foreign per EUR), half-up — exact decimal arithmetic. */
export function usdCentsToEurCents(usdCents: number, rate: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!match || !Number.isSafeInteger(usdCents)) return null;
  const fraction = match[2] ?? "";
  const scaled = BigInt(`${match[1]}${fraction}`);
  if (scaled === 0n) return null;
  const scale = 10n ** BigInt(fraction.length);
  const result = divideRoundHalfUp(BigInt(usdCents) * scale, scaled);
  const asNumber = Number(result);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

/**
 * Relief at average carrying value: carrying × spend / held (half-up cents);
 * spending the whole holding relieves the whole carrying value.
 */
export function relieveCents(state: { usd_cents: number; eur_cents: number }, spendUsdCents: number): UsdPoolResult<number> {
  if (!Number.isSafeInteger(spendUsdCents) || spendUsdCents <= 0) return { ok: false, code: "usd_pool_insufficient" };
  if (spendUsdCents > state.usd_cents) return { ok: false, code: "usd_pool_insufficient" };
  if (spendUsdCents === state.usd_cents) return { ok: true, value: state.eur_cents };
  const relief = Number(divideRoundHalfUp(BigInt(spendUsdCents) * BigInt(state.eur_cents), BigInt(state.usd_cents)));
  return Number.isSafeInteger(relief) ? { ok: true, value: relief } : { ok: false, code: "usd_pool_insufficient" };
}

// ---- canonical postings and journal-free evidence ----------------------------------

function comparePostings(a: PoolPosting, b: PoolPosting): number {
  return a.accounts_id - b.accounts_id
    || (a.accounts_dimensions_id ?? -1) - (b.accounts_dimensions_id ?? -1)
    || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)
    || a.amount_cents - b.amount_cents;
}

/** The sorted posting multiset of a command or a live journal (deleted postings dropped). */
export function canonicalPoolPostings(postings: ReadonlyArray<{
  accounts_id: number;
  accounts_dimensions_id?: number | null;
  type?: string;
  amount: number;
  base_amount?: number | null;
  is_deleted?: boolean;
}>): PoolPosting[] {
  return postings
    .filter(posting => posting.is_deleted !== true)
    .map(posting => ({
      accounts_id: posting.accounts_id,
      accounts_dimensions_id: posting.accounts_dimensions_id ?? null,
      type: posting.type as "D" | "C",
      amount_cents: Math.round((posting.base_amount ?? posting.amount) * 100),
    }))
    .sort(comparePostings);
}

function samePostings(a: readonly PoolPosting[], b: readonly PoolPosting[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort(comparePostings);
  const right = [...b].sort(comparePostings);
  return left.every((posting, index) => comparePostings(posting, right[index]!) === 0);
}

export function conversionEvidenceDigest(evidence: ConversionEvidence): string {
  return createHash("sha256").update(JSON.stringify([
    evidence.ref, evidence.ts, evidence.date_string,
    evidence.legs.map(leg => [leg.ccy, leg.gross_cents, leg.fee_cents, leg.net_cents, leg.fx_rate]),
    [evidence.state_before.usd_cents, evidence.state_before.eur_cents],
    evidence.relief_eur_cents, evidence.fee_eur_cents, evidence.fx_eur_cents,
  ])).digest("hex");
}

function sameLegs(a: readonly ConversionLegEvidence[], b: readonly ConversionLegEvidence[]): boolean {
  return JSON.stringify(a.map(leg => [leg.ccy, leg.gross_cents, leg.fee_cents, leg.net_cents, leg.fx_rate]))
    === JSON.stringify(b.map(leg => [leg.ccy, leg.gross_cents, leg.fee_cents, leg.net_cents, leg.fx_rate]));
}

/** Statement legs of one conversion reference, normalized like {@link ConversionEvidence.legs}; null when not a clean 2-leg EUR/USD pair. */
export function conversionLegsFromRows(
  rows: ReadonlyArray<Pick<PoolStatementRow, "type" | "reference" | "ccy" | "gross_amount" | "fee" | "net_amount" | "fx_rate">>,
  ref: string,
): ConversionLegEvidence[] | null {
  const group = rows.filter(row => row.type === "Conversion" && row.reference === ref);
  const legs: ConversionLegEvidence[] = [];
  for (const row of group) {
    const gross = Math.round(row.gross_amount * 100);
    const fee = Math.round(row.fee * 100);
    const net = Math.round(row.net_amount * 100);
    if (![gross, fee, net].every(Number.isSafeInteger)) return null;
    legs.push({ ccy: row.ccy.trim().toUpperCase(), gross_cents: gross, fee_cents: fee, net_cents: net, fx_rate: String(row.fx_rate) });
  }
  legs.sort((a, b) => (a.ccy < b.ccy ? -1 : a.ccy > b.ccy ? 1 : 0));
  return legs.length === 2 && legs[0]!.ccy === "EUR" && legs[1]!.ccy === "USD" ? legs : null;
}

/**
 * The journal-free conversion_out evidence contract (plan §2, conditions 1–6),
 * checked against the replayed state before the event. `statementCovers` says
 * whether this run's statement covers the event's day (condition 4).
 */
function journalFreeEventProven(
  event: UsdPoolEvent,
  replayed: { usd_cents: number; eur_cents: number },
  statement: { rows: readonly PoolStatementRow[]; covers: (ts: number) => boolean },
  liveNumbers: ReadonlySet<string | null | undefined>,
): boolean {
  const evidence = event.source_evidence;
  if (event.kind !== "conversion_out" || !evidence || typeof event.evidence_digest !== "string") return false;
  // 1. digest
  if (conversionEvidenceDigest(evidence) !== event.evidence_digest) return false;
  // 2. leg arithmetic; the USD leg leaves without a fee and the EUR net is the relief
  const eurLeg = evidence.legs.find(leg => leg.ccy === "EUR");
  const usdLeg = evidence.legs.find(leg => leg.ccy === "USD");
  if (evidence.legs.length !== 2 || !eurLeg || !usdLeg) return false;
  if (!evidence.legs.every(leg => Math.abs(leg.gross_cents) - leg.fee_cents === Math.abs(leg.net_cents))) return false;
  if (usdLeg.fee_cents !== 0 || usdLeg.gross_cents >= 0 || eurLeg.fee_cents !== 0 || eurLeg.net_cents !== evidence.relief_eur_cents) return false;
  if (evidence.fee_eur_cents !== 0 || evidence.fx_eur_cents !== 0) return false;
  // 3. state before = the replay, and its relief recomputes
  if (evidence.state_before.usd_cents !== replayed.usd_cents || evidence.state_before.eur_cents !== replayed.eur_cents) return false;
  const relief = relieveCents(evidence.state_before, -usdLeg.gross_cents);
  if (!relief.ok || relief.value !== evidence.relief_eur_cents) return false;
  // 4. the statement, when it covers the day, still shows the same legs
  if (statement.covers(evidence.ts)) {
    const legs = conversionLegsFromRows(statement.rows, evidence.ref);
    if (!legs || !sameLegs(legs, evidence.legs)) return false;
  }
  // 5. no journal books it
  if (liveNumbers.has(`LY:${evidence.ref}`)) return false;
  // 6. the event applies exactly the deltas the evidence implies
  return event.ref === evidence.ref && event.ts === evidence.ts && event.document_number === `LY:${evidence.ref}`
    && event.usd_cents === usdLeg.gross_cents && event.eur_cents === -evidence.relief_eur_cents
    && event.journal_broker_net_cents === 0 && event.journal_id === null
    && Array.isArray(event.postings) && event.postings.length === 0;
}

// ---- journals -------------------------------------------------------------------

/** Net broker-dimension posting of a journal in EUR cents (D positive, C negative). */
export function journalBrokerNetCents(journal: Journal, key: Pick<PoolKey, "broker_account" | "broker_dimension_id">): number {
  let total = 0;
  for (const posting of journal.postings ?? []) {
    if (posting.is_deleted === true || posting.accounts_id !== key.broker_account) continue;
    if (key.broker_dimension_id !== null && posting.accounts_dimensions_id !== key.broker_dimension_id) continue;
    const cents = Math.round((posting.base_amount ?? posting.amount) * 100);
    total += posting.type === "C" ? -cents : cents;
  }
  return total;
}

const MAX_POOL_JOURNAL_READS = 500;

class JournalReader {
  private readonly cache = new Map<number, Journal | null>();
  private reads = 0;

  constructor(private readonly api: ApiContext) {}

  /** null = the journal is gone (404). Throws on an unavailable read. */
  async get(id: number): Promise<Journal | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;
    if (++this.reads > MAX_POOL_JOURNAL_READS) throw new Error("usd_pool_validation_unavailable");
    let journal: Journal | null;
    try {
      journal = await this.api.journals.get(id);
    } catch (error) {
      if (isNotFoundHttpError(error)) journal = null;
      else throw error;
    }
    this.cache.set(id, journal ?? null);
    return journal ?? null;
  }
}

/** "postings": the live journal's posting multiset differs from the stored one, or the record has none (r1 #6). */
type JournalCheck = "ok" | "mismatch" | "postings" | "unregistered";

/** The live journal still equals the pool record: number, broker net and the whole posting multiset. */
export function journalMatchesPoolRecord(
  journal: Journal,
  key: Pick<PoolKey, "broker_account" | "broker_dimension_id">,
  expect: { document_number: string | null; broker_net_cents: number; postings: readonly PoolPosting[] | undefined; effective_date: string | undefined },
): "ok" | "mismatch" | "postings" {
  if (journal.is_deleted === true || journal.document_number !== expect.document_number) return "mismatch";
  // A journal-backed record without its approved date proves nothing about when it counts (review r2 #2).
  if (typeof expect.effective_date !== "string" || String(journal.effective_date ?? "").slice(0, 10) !== expect.effective_date) return "mismatch";
  if (journalBrokerNetCents(journal, key) !== expect.broker_net_cents) return "mismatch";
  if (!Array.isArray(expect.postings) || !samePostings(canonicalPoolPostings(journal.postings ?? []), expect.postings)) return "postings";
  return "ok";
}

async function checkLoggedJournal(
  reader: JournalReader,
  key: PoolKey,
  expect: { journal_id: number | null; document_number: string | null; broker_net_cents: number; postings: readonly PoolPosting[] | undefined; effective_date: string | undefined },
  requireRegistered: boolean,
): Promise<JournalCheck> {
  if (expect.journal_id === null) return "mismatch";
  const journal = await reader.get(expect.journal_id);
  if (!journal) return "mismatch";
  const match = journalMatchesPoolRecord(journal, key, expect);
  if (match !== "ok") return match;
  if (requireRegistered && journal.registered !== true) return "unregistered";
  return "ok";
}

// ---- recovery -------------------------------------------------------------------

/**
 * Resolve intents left by a crash/timeout between intent and commit: a live
 * journal with the intent's document number and postings → committed (no new
 * journal); no such journal → the create never happened, the intent is
 * dropped; anything else → usd_pool_uncertain_outcome (the pool stays blocked).
 * Read-only on the API. Call inside {@link withUsdPoolLock}.
 */
export async function recoverUsdPoolIntents(api: ApiContext, store: UsdPoolStore, key: PoolKey): Promise<UsdPoolResult<{ committed: number; dropped: number }>> {
  const records = store.read();
  if (records === null) return { ok: false, code: "usd_pool_unavailable" };
  const intents = poolRecordsFor(records, key).intents;
  if (intents.length === 0) return { ok: true, value: { committed: 0, dropped: 0 } };
  let journals: Journal[];
  try {
    api.journals.invalidateListCache();
    journals = await api.journals.listAll();
  } catch {
    return { ok: false, code: "usd_pool_uncertain_outcome" };
  }
  const reader = new JournalReader(api);
  const upserts: UsdPoolRecord[] = [];
  const removals: string[] = [];
  let unresolved = false;
  for (const intent of intents) {
    const matches = journals.filter(j => j.document_number === intent.document_number && j.is_deleted !== true && j.id != null);
    if (matches.length === 0) {
      removals.push(usdPoolRecordKey(intent));
      continue;
    }
    if (matches.length !== 1) { unresolved = true; continue; }
    // A journal exists: committing needs the approved effective date (a pre-fix intent has none; it stays, review r2 #2).
    if (typeof intent.effective_date !== "string"
      || (intent.kind === "revaluation" && intent.checkpoint?.effective_date !== intent.effective_date)) { unresolved = true; continue; }
    const journalId = matches[0]!.id!;
    let check: JournalCheck;
    try {
      check = await checkLoggedJournal(reader, key, { journal_id: journalId, document_number: intent.document_number, broker_net_cents: intent.journal_broker_net_cents, postings: intent.postings, effective_date: intent.effective_date }, false);
    } catch {
      unresolved = true;
      continue;
    }
    if (check !== "ok") { unresolved = true; continue; }
    if (intent.kind === "revaluation") {
      if (!intent.checkpoint) { unresolved = true; continue; }
      removals.push(usdPoolRecordKey(intent));
      upserts.push({ ...intent.checkpoint, journal_id: journalId });
    } else {
      upserts.push({ ...intent, state: "committed", journal_id: journalId });
    }
  }
  // Commits and checkpoints first: if removing an intent then fails, the next
  // recovery finds both and only drops the intent again (never neither).
  try {
    if (upserts.length > 0) store.upsert(upserts);
    if (removals.length > 0) store.remove(removals);
  } catch {
    return { ok: false, code: "usd_pool_uncertain_outcome" };
  }
  if (unresolved) return { ok: false, code: "usd_pool_uncertain_outcome" };
  return { ok: true, value: { committed: upserts.length, dropped: removals.length - upserts.filter(record => record.record === "checkpoint").length } };
}

// ---- validation -----------------------------------------------------------------

export type { StatementPoolEvent } from "./pool-statement.js";

export interface ValidateUsdPoolParams {
  api: ApiContext;
  store: UsdPoolStore;
  key: PoolKey;
  /** Replay and completeness run over records ordered strictly before this point. */
  until: PoolOrder;
  /** Every new record this run would add; each must order after the frontier. */
  newRecords: readonly PoolOrder[];
  /**
   * The statement's USD rows and their roles (classifyStatementPool). `period`
   * (from the file name) says which days it covers; without it, the span of its rows.
   */
  statement: { events: readonly StatementPoolEvent[]; rows: readonly PoolStatementRow[]; period?: { from: string; to: string } | null };
  /** Refs this plan itself books (not yet committed). */
  plannedRefs?: ReadonlySet<string>;
  requireRegistered: boolean;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkpointDigestFields(c: UsdPoolCheckpoint) {
  return [c.kind, c.as_of, c.usd_cents, c.eur_cents, c.fx_cents, c.journal_id, c.document_number, c.rate, c.rate_date, c.effective_date ?? null];
}

function eventDigestFields(e: UsdPoolEvent) {
  return [e.kind, e.ref, e.ts, e.usd_cents, e.eur_cents, e.journal_id, e.document_number, e.journal_broker_net_cents, e.postings ?? null, e.evidence_digest ?? null, e.source_digest ?? null, e.effective_date ?? null];
}

/** Statement day of a pool timestamp (statement clock read as UTC). */
function statementDayOf(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function statementCoverage(statement: ValidateUsdPoolParams["statement"]): (ts: number) => boolean {
  if (statement.period) {
    const { from, to } = statement.period;
    return ts => statementDayOf(ts) >= from && statementDayOf(ts) <= to;
  }
  const days = statement.rows.flatMap(row => row.ts === null ? [] : [statementDayOf(row.ts)]).sort();
  if (days.length === 0) return () => false;
  return ts => statementDayOf(ts) >= days[0]! && statementDayOf(ts) <= days[days.length - 1]!;
}

/** Opening/zero-FX checkpoints are verified by recomputation with their stored rate. */
function checkpointValueRecomputes(checkpoint: UsdPoolCheckpoint): boolean {
  return usdCentsToEurCents(checkpoint.usd_cents, checkpoint.rate) === checkpoint.eur_cents;
}

/**
 * Shared validator (C4 with requireRegistered=false, C5 with true):
 * 0. the whole chain from the approved opening is re-verified against ONE
 *    fresh journal read (cache invalidated first) and replayed; every stored
 *    checkpoint must equal the replay (else usd_pool_chain_broken), and every
 *    new record must order after the state-dependent frontier
 *    (usd_pool_backdated_event);
 * 1. no intents (usd_pool_uncertain_outcome);
 * 2. events after the latest checkpoint: live, same number and broker net
 *    (usd_pool_event_mismatch), registered when required;
 * 3. completeness against the statement (pool-statement.ts: unplaceable rows,
 *    ambiguous pairing, mixed seconds, unsupported rows, sweeps at 1.00 and
 *    unbooked, every pool-logged role committed or planned).
 * Call inside {@link withUsdPoolLock} after {@link recoverUsdPoolIntents}.
 */
export async function validateUsdPool(params: ValidateUsdPoolParams): Promise<UsdPoolResult<UsdPoolSnapshot>> {
  const { api, key, until, requireRegistered } = params;
  const records = params.store.read();
  if (records === null) return { ok: false, code: "usd_pool_unavailable" };
  if (findTargetMismatch(records, key)) return { ok: false, code: "usd_pool_target_mismatch" };
  const view = poolRecordsFor(records, key);
  if (view.intents.length > 0) return { ok: false, code: "usd_pool_uncertain_outcome" };
  const opening = view.opening;
  if (!opening || opening.approved !== true) return { ok: false, code: "usd_pool_checkpoint_missing" };

  const frontier = poolFrontier(records.filter(record => samePool(record.pool_key, key)));
  for (const order of params.newRecords) {
    if (frontier && compareOrder(order, frontier.order) <= 0) {
      if (compareOrder(order, orderOf(opening)) <= 0) return { ok: false, code: "usd_pool_before_opening" };
      return { ok: false, code: "usd_pool_backdated_event", detail: frontier.record.record === "event" ? frontier.record.document_number : frontier.record.document_number ?? `${frontier.record.kind}:${frontier.record.as_of}` };
    }
  }

  // One fresh snapshot for the whole validation.
  let liveJournals: Journal[];
  try {
    api.journals.invalidateListCache();
    liveJournals = await api.journals.listAll();
  } catch {
    return { ok: false, code: "usd_pool_validation_unavailable" };
  }
  const reader = new JournalReader(api);

  if (!checkpointValueRecomputes(opening) || !Array.isArray(opening.postings) || opening.postings.length !== 0) {
    return { ok: false, code: "usd_pool_chain_broken", detail: `opening:${opening.as_of}` };
  }
  const liveNumbers = new Set(liveJournals.filter(j => j.is_deleted !== true).map(j => j.document_number));
  const covers = statementCoverage(params.statement);
  const openingOrder = orderOf(opening);
  const chain: UsdPoolRecord[] = [
    ...view.events,
    ...view.checkpoints.filter(c => c.kind === "revaluation"),
  ].filter(record => compareOrder(orderOf(record), openingOrder) > 0 && compareOrder(orderOf(record), until) < 0)
    .sort((a, b) => compareOrder(orderOf(a), orderOf(b)));
  const lastCheckpointIndex = chain.reduce((last, record, index) => record.record === "checkpoint" ? index : last, -1);

  let usd = opening.usd_cents;
  let eur = opening.eur_cents;
  let base = opening;
  let eventsSinceBase: UsdPoolEvent[] = [];
  try {
    for (let index = 0; index < chain.length; index++) {
      const record = chain[index]!;
      if (record.record === "event") {
        // Every statement-derived event carries its source rows' digest; there is no legacy exception (review r2 #1).
        if (record.kind !== "revaluation" && typeof record.source_digest !== "string") {
          return { ok: false, code: "usd_pool_chain_broken", detail: record.document_number };
        }
        if (record.journal_id === null || record.source_evidence !== undefined) {
          // A journal-free conversion_out stands only on its evidence; evidence never rides on a journal-backed event.
          if (!journalFreeEventProven(record, { usd_cents: usd, eur_cents: eur }, { rows: params.statement.rows, covers }, liveNumbers)) {
            return { ok: false, code: "usd_pool_chain_broken", detail: record.document_number };
          }
          usd += record.usd_cents;
          eur += record.eur_cents;
          eventsSinceBase.push(record);
          continue;
        }
        const check = await checkLoggedJournal(reader, key, { journal_id: record.journal_id, document_number: record.document_number, broker_net_cents: record.journal_broker_net_cents, postings: record.postings, effective_date: record.effective_date }, requireRegistered);
        if (check === "postings") return { ok: false, code: "usd_pool_chain_broken", detail: record.document_number };
        if (check !== "ok") {
          if (index < lastCheckpointIndex && check === "mismatch") return { ok: false, code: "usd_pool_chain_broken", detail: record.document_number };
          return { ok: false, code: check === "unregistered" ? "usd_pool_event_unregistered" : "usd_pool_event_mismatch", detail: record.document_number };
        }
        usd += record.usd_cents;
        eur += record.eur_cents;
        eventsSinceBase.push(record);
        continue;
      }
      if (record.journal_id !== null) {
        const check = await checkLoggedJournal(reader, key, { journal_id: record.journal_id, document_number: record.document_number, broker_net_cents: record.fx_cents, postings: record.postings, effective_date: record.effective_date }, requireRegistered);
        if (check === "unregistered") return { ok: false, code: "usd_pool_event_unregistered", detail: record.document_number ?? undefined };
        if (check !== "ok" || record.fx_cents === 0) return { ok: false, code: "usd_pool_chain_broken", detail: record.document_number ?? undefined };
      } else if (record.fx_cents !== 0 || !checkpointValueRecomputes(record) || !Array.isArray(record.postings) || record.postings.length !== 0) {
        return { ok: false, code: "usd_pool_chain_broken", detail: `revaluation:${record.as_of}` };
      }
      if (record.usd_cents !== usd || record.eur_cents !== eur + record.fx_cents) {
        return { ok: false, code: "usd_pool_chain_broken", detail: `revaluation:${record.as_of}` };
      }
      usd = record.usd_cents;
      eur = record.eur_cents;
      base = record;
      eventsSinceBase = [];
    }
  } catch {
    return { ok: false, code: "usd_pool_validation_unavailable" };
  }

  // Every logged event the statement covers still shows its time, role and USD amounts (review 2026-11-01 #2).
  for (const event of view.events) {
    if (!covers(event.ts)) continue;
    const own = params.statement.events.filter(row => row.ref === event.ref);
    if (own.length === 0 || own.some(row => row.ts !== event.ts || row.role !== event.kind)
      || (event.kind !== "revaluation" && poolSourceDigest(params.statement.rows, event.ref) !== event.source_digest)) {
      return { ok: false, code: "usd_pool_source_changed", detail: event.document_number };
    }
  }

  // Completeness: every statement pool row since the opening and before `until`.
  const interval = { after: openingOrder, until };
  const { events, rows } = params.statement;
  const bookedRefs = new Set(events.filter(event => liveNumbers.has(`LY:${event.ref}`) || liveNumbers.has(event.ref)).map(event => event.ref));
  const complete = checkStatementCompleteness(events, {
    interval, committedRefs: new Set(view.events.map(e => e.ref)), plannedRefs: params.plannedRefs ?? new Set(), bookedRefs,
  });
  if (!complete.ok) return complete;
  const mixed = checkMixedSeconds(events, openingOrder);
  if (mixed !== null && compareOrder(eventOrder("", mixed), until) < 0) return { ok: false, code: "usd_pool_ambiguous_order", detail: String(mixed) };
  const sweeps = checkSweeps(events, rows, interval);
  if (!sweeps.ok) return sweeps;

  const snapshot_digest = digestOf({
    pool: poolKeyId(key),
    opening: checkpointDigestFields(opening),
    chain: chain.map(record => record.record === "event" ? eventDigestFields(record) : checkpointDigestFields(record)),
  });
  return { ok: true, value: { pool_key: key, opening, base, events: eventsSinceBase, snapshot_digest } };
}

/** Pool state at `order`: the base checkpoint plus committed events before it. */
export function poolStateBefore(snapshot: UsdPoolSnapshot, order: PoolOrder): { usd_cents: number; eur_cents: number } {
  let usd = snapshot.base.usd_cents;
  let eur = snapshot.base.eur_cents;
  for (const event of snapshot.events) {
    if (compareOrder(orderOf(event), order) >= 0) break;
    usd += event.usd_cents;
    eur += event.eur_cents;
  }
  return { usd_cents: usd, eur_cents: eur };
}

/** Pool state after every validated record (the snapshot's end). */
export function poolStateAtEnd(snapshot: UsdPoolSnapshot): { usd_cents: number; eur_cents: number } {
  return poolStateBefore(snapshot, { ts: Number.MAX_SAFE_INTEGER, rank: 1, ref: "￿" });
}

// ---- provisional projection -------------------------------------------------------

/**
 * One pool command of a plan: an inflow adds a fixed EUR value (sell_in,
 * distribution_in at ECB), an outflow relieves at average carrying value
 * (buy_relief, conversion_out).
 */
export interface PoolCommand {
  ref: string;
  ts: number;
  /** USD entering (> 0) or leaving (< 0) the pool. */
  usd_delta_cents: number;
  eur: { fixed: number } | "relief";
  /** A failure decided before the pool (ECB outcome, review row). */
  blocked?: string;
}

export type ProjectedPoolCommand =
  | { ref: string; ok: true; eur_delta_cents: number; relief_eur_cents: number | null; state_before: { usd_cents: number; eur_cents: number } }
  | { ref: string; ok: false; code: string };

/**
 * Walk the plan's pool commands in (ts, ref) order; each one starts from the
 * provisional state the previous one left (committed events before it plus
 * this plan's earlier commands). The first failing command stops every later
 * one (usd_pool_prerequisite_failed); a command blocked on its own keeps its code.
 */
export function projectPool(snapshot: UsdPoolSnapshot, commands: readonly PoolCommand[]): ProjectedPoolCommand[] {
  const ordered = [...commands].sort((a, b) => compareOrder(eventOrder(a.ref, a.ts), eventOrder(b.ref, b.ts)));
  const out: ProjectedPoolCommand[] = [];
  let plannedUsd = 0;
  let plannedEur = 0;
  let failed = false;
  for (const command of ordered) {
    if (command.blocked !== undefined) {
      failed = true;
      out.push({ ref: command.ref, ok: false, code: command.blocked });
      continue;
    }
    if (failed) { out.push({ ref: command.ref, ok: false, code: "usd_pool_prerequisite_failed" }); continue; }
    const committed = poolStateBefore(snapshot, eventOrder(command.ref, command.ts));
    const state = { usd_cents: committed.usd_cents + plannedUsd, eur_cents: committed.eur_cents + plannedEur };
    let eurDelta: number;
    let relief: number | null = null;
    if (command.eur === "relief") {
      const relieved = relieveCents(state, -command.usd_delta_cents);
      if (!relieved.ok) {
        failed = true;
        out.push({ ref: command.ref, ok: false, code: relieved.code });
        continue;
      }
      relief = relieved.value;
      eurDelta = -relief;
    } else {
      if (!Number.isSafeInteger(command.usd_delta_cents) || command.usd_delta_cents <= 0 || !Number.isSafeInteger(command.eur.fixed)) {
        failed = true;
        out.push({ ref: command.ref, ok: false, code: "trade_amount_conflict" });
        continue;
      }
      eurDelta = command.eur.fixed;
    }
    plannedUsd += command.usd_delta_cents;
    plannedEur += eurDelta;
    out.push({ ref: command.ref, ok: true, eur_delta_cents: eurDelta, relief_eur_cents: relief, state_before: state });
  }
  return out;
}

// ---- opening replay ---------------------------------------------------------------

export interface OpeningReplayRow {
  ts: number | null;
  row_index: number;
  type: string;
  ticker: string;
  ccy: string;
  quantity: number;
  price_per_share: number;
  /** Cash delta of the row in its own currency (Lightyear Net = Gross − Fee convention). */
  cash_delta: number | null;
}

export interface OpeningReplaySummary {
  usd_cents: number;
  cash_cents: number;
  fund_units_cents: number;
  rows_replayed: number;
  first_row_ts: number | null;
  last_row_ts: number | null;
}

function exactCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(cents - value * 100) < 1e-6 ? cents : null;
}

/**
 * Opening USD position at `untilTs` (owner Q13): USD cash from every USD row
 * plus cash-fund units valued at exactly 1.00, replayed from the statement's
 * first row on the assumption that it starts from an empty USD position. USD
 * cash or units going negative at any timestamp disproves that assumption.
 */
export function replayUsdOpening(
  rows: readonly OpeningReplayRow[],
  untilTs: number,
  fundTickers: ReadonlySet<string>,
): UsdPoolResult<OpeningReplaySummary> {
  const relevant = rows.filter(row => row.ccy.trim().toUpperCase() === "USD");
  if (relevant.some(row => row.ts === null)) return { ok: false, code: "usd_pool_opening_replay_unproven", detail: "invalid_timestamp" };
  const ordered = relevant.filter(row => row.ts! <= untilTs).sort((a, b) => a.ts! - b.ts! || a.row_index - b.row_index);
  let cash = 0;
  let units = 0;
  for (let index = 0; index < ordered.length;) {
    const ts = ordered[index]!.ts!;
    // Rows sharing one timestamp settle together; only the end of the second is checked.
    for (; index < ordered.length && ordered[index]!.ts === ts; index++) {
      const row = ordered[index]!;
      if (fundTickers.has(row.ticker) && (row.type === "Buy" || row.type === "Sell")) {
        if (row.price_per_share !== 1) return { ok: false, code: "usd_pool_fund_price_not_stable", detail: String(row.row_index) };
        const qty = exactCents(Math.abs(row.quantity));
        if (qty === null) return { ok: false, code: "usd_pool_opening_replay_unproven", detail: String(row.row_index) };
        units += row.type === "Buy" ? qty : -qty;
      }
      if (row.cash_delta !== null) {
        const delta = exactCents(row.cash_delta);
        if (delta === null) return { ok: false, code: "usd_pool_opening_replay_unproven", detail: String(row.row_index) };
        cash += delta;
      }
    }
    if (cash < 0 || units < 0) return { ok: false, code: "usd_pool_opening_replay_unproven", detail: String(ts) };
  }
  return {
    ok: true,
    value: {
      usd_cents: cash + units,
      cash_cents: cash,
      fund_units_cents: units,
      rows_replayed: ordered.length,
      first_row_ts: ordered[0]?.ts ?? null,
      last_row_ts: ordered[ordered.length - 1]?.ts ?? null,
    },
  };
}
