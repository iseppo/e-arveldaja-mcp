import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { withOwnedFileLock } from "../file-lock.js";
import { createConnectionScopedBundleStore, type ConnectionScopedBundleStore } from "../connection-scoped-bundle-store.js";
import { isNotFoundHttpError } from "../http-client.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { Journal } from "../types/api.js";

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

export type UsdPoolEventKind = "distribution_in" | "buy_relief" | "revaluation";

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
  recorded_at: string;
}

export type UsdPoolRecord = UsdPoolEvent | UsdPoolCheckpoint;

export interface UsdPoolState {
  usd_cents: number;
  eur_cents: number;
  snapshot_digest: string;
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
  | "usd_pool_opening_exists";

export const USD_POOL_REVIEW_MESSAGES: Record<UsdPoolReviewCode, string> = {
  usd_pool_unavailable: "The USD cash-fund pool store needs the accounting-rules bundle (not single-file EARVELDAJA_RULES_FILE mode); pool-dependent rows stay in review.",
  usd_pool_account_unknown: "The Lightyear account could not be read from the statement file name (AccountStatement-LY-<ACCOUNT>-…); pass lightyear_account.",
  usd_pool_target_mismatch: "This Lightyear account already has a USD pool on another broker account/dimension; nothing is booked to a second pool.",
  usd_pool_checkpoint_missing: "The USD pool has no approved opening checkpoint yet; run book_lightyear_fx_revaluation with mode \"opening\" first.",
  usd_pool_chain_broken: "A journal the USD pool's history depends on was edited, deleted or no longer matches the pool log, so the carrying value cannot be proven.",
  usd_pool_backdated_event: "A later buy relief or checkpoint is already committed in the USD pool; booking this earlier event would change it. Nothing is booked.",
  usd_pool_uncertain_outcome: "An earlier pool booking has an uncertain outcome (intent without commit) that recovery could not resolve; check the journal and retry.",
  usd_pool_event_mismatch: "A journal logged in the USD pool was edited or deleted after logging.",
  usd_pool_event_unregistered: "A journal logged in the USD pool is still an unregistered draft; confirm it before revaluing.",
  usd_pool_prerequisite_unbooked: "A USD pool event on the statement (e.g. a retained USD distribution) is not booked and logged yet; book it first.",
  usd_pool_unsupported_event: "The statement holds a USD movement this tool does not book into the pool (USD sell kept in USD, unpaired conversion, deposit, withdrawal or fee).",
  usd_pool_sweep_booked: "A cash-fund sweep row was booked as a journal that moves the broker account; the pool cannot be replayed.",
  usd_pool_insufficient: "The USD pool holds less USD than this buy spends from it.",
  usd_pool_prerequisite_failed: "An earlier USD pool command in this plan is not bookable, so later pool commands are not booked either.",
  usd_pool_validation_unavailable: "The USD pool journals could not be read completely; nothing is accepted.",
  usd_pool_checkpoint_after_date: "The USD pool already has a checkpoint after this date; revaluation is never back-dated.",
  usd_pool_statement_gap: "The statement does not cover the whole interval since the last USD pool checkpoint.",
  usd_pool_quantity_mismatch: "The replayed USD pool quantity differs from the holding Lightyear shows for this date; nothing is booked.",
  usd_pool_fund_price_not_stable: "An ICSUSSDP row is not priced at exactly 1.00, so its units cannot be valued as USD cash.",
  usd_pool_opening_replay_unproven: "Replaying the statement drives USD cash or ICSUSSDP units negative, so it does not start from an empty USD position.",
  usd_pool_opening_exists: "The USD pool already has a checkpoint; the opening is set only once (delete the pool's store entry to redo it).",
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

export async function withUsdPoolLock<T>(key: PoolKey, fn: () => Promise<T>): Promise<T> {
  const lockDir = process.env.EARVELDAJA_LOCK_DIR ?? resolve(tmpdir(), "e-arveldaja-mcp-locks");
  const digest = createHash("sha256").update(`usd-pool\u0000${poolKeyId(key)}`).digest("hex");
  return withOwnedFileLock(resolve(lockDir, `${digest}.lock`), fn, { timeoutMs: 30_000, pollMs: 25 });
}

/** End-of-day timestamp (seconds) of a YYYY-MM-DD day, in the statement's own clock. */
export function endOfDaySeconds(day: string): number {
  return Date.parse(`${day}T23:59:59Z`) / 1000;
}

// ---- ordering -----------------------------------------------------------------

/** Total order: ts, then checkpoint before event, then ref. */
export interface PoolOrder {
  ts: number;
  rank: 0 | 1;
  ref: string;
}

function orderOf(record: UsdPoolRecord): PoolOrder {
  return record.record === "checkpoint"
    ? { ts: record.ts, rank: 0, ref: `${record.kind}:${record.as_of}` }
    : { ts: record.ts, rank: 1, ref: record.ref };
}

export function compareOrder(a: PoolOrder, b: PoolOrder): number {
  return a.ts - b.ts || a.rank - b.rank || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

export function eventOrder(ref: string, ts: number): PoolOrder {
  return { ts, rank: 1, ref };
}

export function checkpointOrder(kind: "opening" | "revaluation", asOf: string): PoolOrder {
  return { ts: endOfDaySeconds(asOf), rank: 0, ref: `${kind}:${asOf}` };
}

/**
 * The append-only history frontier: the latest committed STATE-DEPENDENT record
 * (buy relief or checkpoint). A distribution_in is state-independent (ECB × USD)
 * and does not advance it.
 */
export function poolFrontier(records: readonly UsdPoolRecord[]): { order: PoolOrder; record: UsdPoolRecord } | null {
  let best: { order: PoolOrder; record: UsdPoolRecord } | null = null;
  for (const record of records) {
    if (record.record === "event" && (record.state !== "committed" || record.kind === "distribution_in")) continue;
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

type JournalCheck = "ok" | "mismatch" | "unregistered";

async function checkLoggedJournal(
  reader: JournalReader,
  key: PoolKey,
  expect: { journal_id: number | null; document_number: string | null; broker_net_cents: number },
  requireRegistered: boolean,
): Promise<JournalCheck> {
  if (expect.journal_id === null) return "mismatch";
  const journal = await reader.get(expect.journal_id);
  if (!journal || journal.is_deleted === true || journal.document_number !== expect.document_number) return "mismatch";
  if (journalBrokerNetCents(journal, key) !== expect.broker_net_cents) return "mismatch";
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
    const journalId = matches[0]!.id!;
    let check: JournalCheck;
    try {
      check = await checkLoggedJournal(reader, key, { journal_id: journalId, document_number: intent.document_number, broker_net_cents: intent.journal_broker_net_cents }, false);
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
  try {
    if (removals.length > 0) store.remove(removals);
    if (upserts.length > 0) store.upsert(upserts);
  } catch {
    return { ok: false, code: "usd_pool_uncertain_outcome" };
  }
  if (unresolved) return { ok: false, code: "usd_pool_uncertain_outcome" };
  return { ok: true, value: { committed: upserts.length, dropped: removals.length - upserts.filter(record => record.record === "checkpoint").length } };
}

// ---- validation -----------------------------------------------------------------

/** A pool-relevant row of the statement, classified by the Lightyear extraction. */
export interface StatementPoolEvent {
  ref: string;
  ts: number;
  /** distribution_in / buy_relief must be committed; sweep and pass_through never are; unsupported blocks. */
  role: "distribution_in" | "buy_relief" | "sweep" | "pass_through" | "unsupported";
}

export interface ValidateUsdPoolParams {
  api: ApiContext;
  store: UsdPoolStore;
  key: PoolKey;
  /** Replay and completeness run over records ordered strictly before this point. */
  until: PoolOrder;
  /** Every new record this run would add; each must order after the frontier. */
  newRecords: readonly PoolOrder[];
  statementEvents: readonly StatementPoolEvent[];
  /** Refs this plan itself books (not yet committed). */
  plannedRefs?: ReadonlySet<string>;
  requireRegistered: boolean;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkpointDigestFields(c: UsdPoolCheckpoint) {
  return [c.kind, c.as_of, c.usd_cents, c.eur_cents, c.fx_cents, c.journal_id, c.document_number, c.rate, c.rate_date];
}

function eventDigestFields(e: UsdPoolEvent) {
  return [e.kind, e.ref, e.ts, e.usd_cents, e.eur_cents, e.journal_id, e.document_number, e.journal_broker_net_cents];
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
 * 3. completeness against the statement (prerequisite / unsupported / sweep).
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

  if (!checkpointValueRecomputes(opening)) return { ok: false, code: "usd_pool_chain_broken", detail: `opening:${opening.as_of}` };
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
        const check = await checkLoggedJournal(reader, key, { journal_id: record.journal_id, document_number: record.document_number, broker_net_cents: record.journal_broker_net_cents }, requireRegistered);
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
        const check = await checkLoggedJournal(reader, key, { journal_id: record.journal_id, document_number: record.document_number, broker_net_cents: record.fx_cents }, requireRegistered);
        if (check === "unregistered") return { ok: false, code: "usd_pool_event_unregistered", detail: record.document_number ?? undefined };
        if (check !== "ok" || record.fx_cents === 0) return { ok: false, code: "usd_pool_chain_broken", detail: record.document_number ?? undefined };
      } else if (record.fx_cents !== 0 || !checkpointValueRecomputes(record)) {
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

  // Completeness: every statement pool event since the opening and before `until`.
  const committedRefs = new Set(view.events.map(e => e.ref));
  for (const event of params.statementEvents) {
    const order = eventOrder(event.ref, event.ts);
    if (compareOrder(order, openingOrder) <= 0 || compareOrder(order, until) >= 0) continue;
    if (event.role === "unsupported") return { ok: false, code: "usd_pool_unsupported_event", detail: event.ref };
    if (event.role === "sweep") {
      const booked = liveJournals.some(j => j.is_deleted !== true && (j.document_number === `LY:${event.ref}` || j.document_number === event.ref));
      if (booked) return { ok: false, code: "usd_pool_sweep_booked", detail: event.ref };
      continue;
    }
    if (event.role === "pass_through") continue;
    if (!committedRefs.has(event.ref) && !params.plannedRefs?.has(event.ref)) {
      return { ok: false, code: "usd_pool_prerequisite_unbooked", detail: event.ref };
    }
  }

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

export interface PoolSpendCommand {
  ref: string;
  ts: number;
  spend_usd_cents: number;
  /** A failure decided before the pool (ECB outcome, review row). */
  blocked?: string;
}

export type ProjectedPoolCommand =
  | { ref: string; ok: true; relief_eur_cents: number; state_before: { usd_cents: number; eur_cents: number } }
  | { ref: string; ok: false; code: string };

/**
 * Walk the plan's pool-spending commands in (ts, ref) order; each relief is
 * computed from the provisional state the previous one left (committed events
 * before it plus this plan's earlier reliefs). The first failing command stops
 * every later one (usd_pool_prerequisite_failed).
 */
export function projectPool(snapshot: UsdPoolSnapshot, commands: readonly PoolSpendCommand[]): ProjectedPoolCommand[] {
  const ordered = [...commands].sort((a, b) => compareOrder(eventOrder(a.ref, a.ts), eventOrder(b.ref, b.ts)));
  const out: ProjectedPoolCommand[] = [];
  let plannedUsd = 0;
  let plannedEur = 0;
  let failed = false;
  for (const command of ordered) {
    if (failed) { out.push({ ref: command.ref, ok: false, code: "usd_pool_prerequisite_failed" }); continue; }
    if (command.blocked !== undefined) {
      failed = true;
      out.push({ ref: command.ref, ok: false, code: command.blocked });
      continue;
    }
    const committed = poolStateBefore(snapshot, eventOrder(command.ref, command.ts));
    const state = { usd_cents: committed.usd_cents + plannedUsd, eur_cents: committed.eur_cents + plannedEur };
    const relief = relieveCents(state, command.spend_usd_cents);
    if (!relief.ok) {
      failed = true;
      out.push({ ref: command.ref, ok: false, code: relief.code });
      continue;
    }
    plannedUsd -= command.spend_usd_cents;
    plannedEur -= relief.value;
    out.push({ ref: command.ref, ok: true, relief_eur_cents: relief.value, state_before: state });
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
