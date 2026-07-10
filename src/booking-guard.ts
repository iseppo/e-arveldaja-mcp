import type { ApiContext } from "./tools/crud-tools.js";
import type { Journal, ApiResponse } from "./types/api.js";
import { HttpError } from "./http-client.js";
import { roundMoney } from "./money.js";
import {
  buildInterAccountJournalIndex,
  findMatchingJournal,
  findMatchingJournalEntry,
  isReflessEntry,
  toUtcDay,
  UNKNOWN_JOURNAL_ID,
  type InterAccountJournalEntry,
} from "./tools/inter-account-utils.js";

/**
 * BookingGuard — a single-snapshot idempotency layer for journal creation.
 *
 * The RIK e-Financials API signs only the request path (not the body), so it
 * offers no server-side idempotency: a retried or re-run POST creates a second
 * journal. Every booking tool therefore has to detect "did I already book
 * this?" against the existing ledger before writing. Historically each tool
 * grew its own scan of `journals.listAll()`, its own `document_number`
 * convention, and its own create/confirm/record dance — with subtle
 * divergences (deleted-journal handling, in-run vs cross-run dedup, sentinel
 * journal ids) that were the dominant source of duplicate-booking bugs.
 *
 * BookingGuard centralises that into one snapshot loaded per run, with two
 * lanes:
 *
 *   Lane A — namespaced `document_number` keys (`FX:{id}`, `LY:{ref}`, …).
 *            Exact-key dedup: one document_number ⇒ at most one live journal.
 *
 *   Lane B — structural inter-account transfers keyed
 *            `sourceDim|targetDim|amount|date` with reference disambiguation.
 *            Delegates to the existing inter-account-utils index/matcher.
 *
 * `createJournalOnce` is the guarded write: find first, create with the
 * document_number stamped, best-effort confirm, then record into the in-run
 * index so a second call in the same run is also deduped.
 *
 * NOTE: the network-level verify-then-retry (re-scan after a network error to
 * recover a journal that may have been created despite a failed response) is
 * intentionally deferred to the http-client migration step. Today the
 * http-client does not retry non-idempotent POSTs at all, so a POST either
 * succeeds (we see the id) or throws (nothing created). The guard's find pass
 * still protects against cross-run and in-run duplicates.
 */

export type DocNamespace = "FX" | "LY";

export interface DocKey {
  ns: DocNamespace;
  /** The identifier within the namespace — invoice id, Lightyear reference, … */
  id: string;
}

/** "FX:123" / "LY:OR-EVN9C76R7A" */
export function formatDocNumber(key: DocKey): string {
  return `${key.ns}:${key.id}`;
}

const KNOWN_NAMESPACES: readonly DocNamespace[] = ["FX", "LY"];

/**
 * Parse a raw `document_number` into a DocKey, or `undefined` when it does not
 * carry a known namespace prefix (manual journals, legacy entries, …).
 *
 * Only the first ":" is treated as the separator, so a reference that itself
 * contains a colon (unusual, but possible for external ids) round-trips.
 */
export function parseDocNumber(raw: string | null | undefined): DocKey | undefined {
  if (typeof raw !== "string") return undefined;
  const sep = raw.indexOf(":");
  if (sep <= 0) return undefined;
  const ns = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (id === "") return undefined;
  if (!(KNOWN_NAMESPACES as readonly string[]).includes(ns)) return undefined;
  return { ns: ns as DocNamespace, id };
}

export interface ExistingArtifact {
  journal_id: number;
  document_number: string;
  registered: boolean;
  is_deleted: boolean;
}

/**
 * Liveness filter applied at `find` time.
 * - `any`             — every artifact, including deleted/invalidated ones.
 * - `not_deleted`     — exclude deleted/invalidated journals (default). A
 *                       deleted FX/LY journal means the operator invalidated it
 *                       to re-post, so it must NOT block re-booking.
 * - `registered_only` — only confirmed, non-deleted journals.
 */
export type Liveness = "any" | "not_deleted" | "registered_only";

function passesLiveness(a: ExistingArtifact, liveness: Liveness): boolean {
  switch (liveness) {
    case "any":
      return true;
    case "registered_only":
      return a.registered && !a.is_deleted;
    case "not_deleted":
    default:
      return !a.is_deleted;
  }
}

/**
 * Outcome of {@link BookingGuard.resolveInterAccount}.
 * - `matched`   — a journal already covers this transfer; do NOT book.
 * - `ambiguous_refless` — a ref-less same-key collision that cannot be safely
 *   resolved; surface for operator review rather than booking or skipping.
 * - `none`      — no journal covers this transfer; safe to book.
 */
export type InterAccountResolution =
  | { status: "matched"; journal_id: number; matched_on: "reference" | "refless"; pool: "snapshot" | "in_run" }
  | { status: "ambiguous_refless" }
  | { status: "none" };

export interface InterAccountQuery {
  sourceDim: number;
  targetDim: number;
  amount: number;
  date: string;
  /** Optional +/- day window around `date` (default 0 — exact date only). */
  maxGapDays?: number;
  /** Reference number for disambiguating same-amount/date/dims transfers. */
  reference?: string | null;
}

export interface CreateOnceOptions {
  /** Liveness used for the pre-create dedup check (default `not_deleted`). */
  liveness?: Liveness;
  /** Attempt to confirm/register the created journal (default true). */
  confirm?: boolean;
}

export type CreateOnceResult =
  | { status: "created"; journal_id: number; registered: boolean; recovered?: boolean }
  | { status: "duplicate"; journal_id: number };

function interAccountKey(sourceDim: number, targetDim: number, amount: number, date: string): string {
  return `${sourceDim}|${targetDim}|${roundMoney(amount)}|${date}`;
}

export class BookingGuard {
  /** The raw snapshot, exposed read-only for callers that still scan directly. */
  readonly journals: readonly Journal[];

  private readonly api: ApiContext;
  private readonly ownDimensionIds: Set<number>;

  // Lane A: document_number -> artifacts (arrays, since duplicates can exist).
  private readonly docIndex = new Map<string, ExistingArtifact[]>();

  // Lane B: bidirectional "sourceDim|targetDim|amount|date" -> journal entries.
  private readonly interAccountIndex: Map<string, InterAccountJournalEntry[]>;

  private constructor(api: ApiContext, journals: Journal[], ownDimensionIds: Set<number>) {
    this.api = api;
    this.journals = journals;
    this.ownDimensionIds = ownDimensionIds;
    this.interAccountIndex = buildInterAccountJournalIndex(journals, ownDimensionIds);

    for (const j of journals) {
      if (j.id == null) continue;
      const key = parseDocNumber(j.document_number);
      if (!key) continue;
      const dn = formatDocNumber(key);
      const artifact: ExistingArtifact = {
        journal_id: j.id,
        document_number: dn,
        registered: j.registered === true,
        is_deleted: j.is_deleted === true,
      };
      const existing = this.docIndex.get(dn);
      if (existing) existing.push(artifact);
      else this.docIndex.set(dn, [artifact]);
    }
  }

  /**
   * Load one snapshot of all journals (with postings, needed for Lane B) and
   * build both indexes. `ownDimensionIds` is only required for Lane B
   * inter-account matching — Lane A works without it.
   */
  static async load(
    api: ApiContext,
    opts?: { ownDimensionIds?: Set<number> },
  ): Promise<BookingGuard> {
    const ownDimensionIds = opts?.ownDimensionIds ?? new Set<number>();
    // Lane B (inter-account) needs postings to find the two bank legs, and it
    // is only meaningful when the caller supplies its own bank dimension ids.
    // Lane A only reads document_number/id/registered/is_deleted, all of which
    // the cheaper list endpoint carries — so a Lane-A-only caller avoids the
    // per-journal posting fetches that listAllWithPostings performs.
    const needsPostings = ownDimensionIds.size > 0;
    const journals = needsPostings
      ? await api.journals.listAllWithPostings()
      : await api.journals.listAll();
    return new BookingGuard(api, journals, ownDimensionIds);
  }

  // ---- Lane A: namespaced document_number keys ---------------------------

  /** First artifact for `key` passing `liveness` (default `not_deleted`). */
  find(key: DocKey, liveness: Liveness = "not_deleted"): ExistingArtifact | undefined {
    const artifacts = this.docIndex.get(formatDocNumber(key));
    if (!artifacts) return undefined;
    return artifacts.find(a => passesLiveness(a, liveness));
  }

  /** Record a freshly-created journal into the in-run Lane A index. */
  record(
    key: DocKey,
    journalId: number,
    meta?: { registered?: boolean; is_deleted?: boolean },
  ): void {
    const dn = formatDocNumber(key);
    const artifact: ExistingArtifact = {
      journal_id: journalId,
      document_number: dn,
      registered: meta?.registered ?? true,
      is_deleted: meta?.is_deleted ?? false,
    };
    const existing = this.docIndex.get(dn);
    if (existing) existing.push(artifact);
    else this.docIndex.set(dn, [artifact]);
  }

  /**
   * Guarded journal write. Returns `duplicate` (with the existing journal id)
   * when a live artifact already carries this key; otherwise creates the
   * journal with the document_number stamped, best-effort confirms it (unless
   * `confirm:false`), records it, and returns `created`.
   *
   * The caller's `payload.document_number` is ignored — the guard stamps it
   * from `key` so the key and the stored document_number can never diverge.
   */
  async createJournalOnce(
    key: DocKey,
    payload: Omit<Partial<Journal>, "document_number">,
    opts?: CreateOnceOptions,
  ): Promise<CreateOnceResult> {
    const liveness = opts?.liveness ?? "not_deleted";
    const existing = this.find(key, liveness);
    if (existing) return { status: "duplicate", journal_id: existing.journal_id };

    const stamped: Partial<Journal> = { ...payload, document_number: formatDocNumber(key) };
    const wantConfirm = opts?.confirm !== false;

    let created: ApiResponse;
    try {
      created = await this.api.journals.create(stamped);
    } catch (err) {
      // Only a network error is ambiguous — the POST may or may not have
      // committed. An HTTP status (4xx/5xx with a body) means the server saw
      // and rejected the request, so nothing was created: propagate as-is.
      if (!(err instanceof HttpError) || err.status !== "network") throw err;

      // The document_number is a checkable key, so re-scan the server to see
      // whether the ambiguous write actually landed. create() only invalidates
      // its cache on success, so bust the stale journals cache first — the
      // snapshot could otherwise predate the write we are verifying.
      this.api.journals.invalidateListCache();
      const found = BookingGuard.findKeyInJournals(await this.api.journals.listAll(), key);
      if (found) {
        // The ambiguous write DID commit — recover its id, do NOT retry. create()
        // does not auto-confirm, so the recovered journal is typically left in
        // PROJECT; confirm it now (when wanted) exactly as a fresh create would.
        let registered = found.registered;
        if (!registered && wantConfirm) {
          try {
            await this.api.journals.confirm(found.journal_id);
            registered = true;
          } catch {
            // Leave the recovered journal in PROJECT for the operator to inspect.
          }
        }
        this.record(key, found.journal_id, { registered, is_deleted: false });
        return { status: "created", journal_id: found.journal_id, registered, recovered: true };
      }
      // The write did not commit — safe to retry exactly once. A second
      // network failure propagates; the key is not double-booked because the
      // next run's find pass (or another recovery) catches it by its
      // document_number.
      created = await this.api.journals.create(stamped);
    }

    const journalId = created.created_object_id;

    let registered = false;
    if (journalId != null && wantConfirm) {
      try {
        await this.api.journals.confirm(journalId);
        registered = true;
      } catch {
        // Leave the journal in PROJECT for the operator to inspect if confirm
        // fails — mirrors the established currency-rounding / Lightyear path.
      }
    }

    if (journalId != null) {
      this.record(key, journalId, { registered, is_deleted: false });
      return { status: "created", journal_id: journalId, registered };
    }

    // The API accepted the create but returned no object id. We cannot dedup a
    // future run against an unknown id, but we still record the key so a second
    // call within THIS run is deduped.
    this.record(key, UNKNOWN_JOURNAL_ID, { registered, is_deleted: false });
    return { status: "created", journal_id: UNKNOWN_JOURNAL_ID, registered };
  }

  /**
   * Scan a raw journal array for the first live (not-deleted) journal carrying
   * `key`'s document_number. Used by the verify-then-retry path against a
   * freshly-fetched snapshot, so it applies the same parse + `not_deleted`
   * liveness that `find` uses without disturbing the in-memory index.
   */
  private static findKeyInJournals(
    journals: readonly Journal[],
    key: DocKey,
  ): ExistingArtifact | undefined {
    const target = formatDocNumber(key);
    for (const j of journals) {
      if (j.id == null) continue;
      const k = parseDocNumber(j.document_number);
      if (!k || formatDocNumber(k) !== target) continue;
      if (j.is_deleted === true) continue;
      return {
        journal_id: j.id,
        document_number: target,
        registered: j.registered === true,
        is_deleted: false,
      };
    }
    return undefined;
  }

  // ---- Lane B: structural inter-account transfers ------------------------

  /**
   * Find an existing inter-account journal for the given transfer, or
   * `undefined`. Delegates candidate selection to `findMatchingJournal`
   * (reference disambiguation). When `maxGapDays > 0`, scans the exact date
   * first, then outward day-by-day within the window.
   */
  findInterAccount(q: InterAccountQuery): number | undefined {
    const gap = Math.max(0, Math.floor(q.maxGapDays ?? 0));
    for (const date of this.candidateDates(q.date, gap)) {
      const key = interAccountKey(q.sourceDim, q.targetDim, q.amount, date);
      const match = findMatchingJournal(this.interAccountIndex.get(key), q.reference);
      if (match !== undefined) return match;
    }
    return undefined;
  }

  /**
   * Resolve a transfer against the Lane B index with cardinality awareness.
   *
   * `findInterAccount` answers a boolean "does a journal exist for this key?",
   * which lets a single journal suppress unlimited same-key transfers. That is
   * fine when references disambiguate, but natively-confirmed inter-account
   * journals carry NO document_number (verified against the API), so two
   * distinct ref-less same-day/same-amount transfers collide. This method
   * disambiguates by consuming matched journals and by the entry's origin:
   *
   * - `reference` match → `matched` (never consumed: a same-ref re-import must
   *   keep being suppressed).
   * - ref-less match on a ref-less `snapshot` journal → `matched`, and the entry
   *   is consumed (default), so J prior-run journals suppress exactly J transfers.
   * - ref-less match landing on a `snapshot` journal that itself carries a
   *   reference (e.g. an `FX:` conversion between two bank accounts) → `matched`
   *   but NOT consumed: a labelled journal is an identity that must stay
   *   matchable for its own same-ref re-import.
   * - any match on an `in_run` journal via the ref-less catch-all → `ambiguous_refless`:
   *   we cannot tell a genuine second transfer from a duplicate re-import of the
   *   first, so the caller must surface it for review rather than guess.
   * - no direct match, but a live `in_run` journal exists on this exact key with
   *   a *different* reference → `ambiguous_refless`: the two legs of one transfer
   *   legitimately carry different bank refs, so a differing-ref same-run
   *   collision is indistinguishable from a genuine second transfer.
   * - no live candidate (or only differing-ref `snapshot` journals, which are
   *   distinct prior-run identities) → `none` (safe to book).
   */
  resolveInterAccount(
    q: InterAccountQuery,
    opts?: { consume?: boolean },
  ): InterAccountResolution {
    const consume = opts?.consume !== false;
    const gap = Math.max(0, Math.floor(q.maxGapDays ?? 0));
    for (const date of this.candidateDates(q.date, gap)) {
      const key = interAccountKey(q.sourceDim, q.targetDim, q.amount, date);
      const candidates = this.interAccountIndex.get(key);
      const match = findMatchingJournalEntry(candidates, q.reference);
      if (!match) {
        // No reference/ref-less match. If a same-key journal was booked THIS
        // run (an in_run entry that a differing ref caused us to reject), the
        // input is an indistinguishable mirror-vs-distinct case → review.
        // A differing-ref *snapshot* journal is a distinct prior-run identity,
        // so it does not block: keep scanning the remaining candidate dates.
        if (this.hasLiveInRunEntry(candidates)) return { status: "ambiguous_refless" };
        continue;
      }
      const pool = match.entry.origin ?? "snapshot";
      if (match.matchedOn === "reference") {
        return { status: "matched", journal_id: match.entry.journal_id, matched_on: "reference", pool };
      }
      // ref-less catch-all match
      if (pool === "in_run") {
        // The matched same-key journal was created THIS run; a ref-less
        // collision here is indistinguishable from a duplicate re-import.
        return { status: "ambiguous_refless" };
      }
      // Only consume a genuinely ref-less snapshot entry. A labelled snapshot
      // journal loosely matched by a ref-less query stays live so its own
      // same-ref re-import keeps being suppressed.
      if (consume && isReflessEntry(match.entry)) match.entry.consumed = true;
      return { status: "matched", journal_id: match.entry.journal_id, matched_on: "refless", pool };
    }
    return { status: "none" };
  }

  /** True when `candidates` holds a live (un-consumed) in-run journal entry. */
  private hasLiveInRunEntry(candidates: InterAccountJournalEntry[] | undefined): boolean {
    return (candidates ?? []).some(c => !c.consumed && (c.origin ?? "snapshot") === "in_run");
  }

  /** Record a freshly-created inter-account journal into the Lane B index. */
  recordInterAccount(
    q: Pick<InterAccountQuery, "sourceDim" | "targetDim" | "amount" | "date" | "reference">,
    journalId: number | undefined,
  ): void {
    const entry: InterAccountJournalEntry = {
      journal_id: journalId ?? UNKNOWN_JOURNAL_ID,
      document_number: q.reference ?? null,
      origin: "in_run",
    };
    const amount = roundMoney(q.amount);
    const key1 = `${q.sourceDim}|${q.targetDim}|${amount}|${q.date}`;
    const key2 = `${q.targetDim}|${q.sourceDim}|${amount}|${q.date}`;
    for (const key of [key1, key2]) {
      const existing = this.interAccountIndex.get(key);
      if (existing) existing.push(entry);
      else this.interAccountIndex.set(key, [entry]);
    }
  }

  /**
   * Candidate ISO dates around `date`, ordered nearest-first: the exact date,
   * then -1/+1, -2/+2, … out to `gap` days. Uses UTC day arithmetic so the
   * offsets never drift across DST or timezones.
   */
  private candidateDates(date: string, gap: number): string[] {
    if (gap === 0) return [date];
    const baseMs = toUtcDay(date); // UTC-midnight epoch millis
    if (!Number.isFinite(baseMs)) return [date];
    const DAY_MS = 86400000;
    const dates = [date];
    for (let d = 1; d <= gap; d++) {
      dates.push(msToIso(baseMs - d * DAY_MS));
      dates.push(msToIso(baseMs + d * DAY_MS));
    }
    return dates;
  }
}

/** Epoch millis at UTC midnight -> "YYYY-MM-DD". */
function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
