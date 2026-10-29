import type { AccountDimension, BankAccount, Journal, Transaction } from "./types/api.js";
import { listAccountDimensionPostings } from "./account-postings.js";
import { roundMoney } from "./money.js";
import { wrapUntrustedOcr } from "./mcp-json.js";
import { toUtcDay } from "./date-utils.js";
import { storedBankReferenceLookupKey } from "./camt/duplicate-identity.js";
import { matchWiseLegTag } from "./wise/projection.js";

/**
 * Cross-mechanism bank-posting duplicate guard — core matching logic.
 *
 * Reconcile, create_transaction, create_journal, and intake booking flows
 * each detect duplicates within their own mechanism (e.g. inter-account
 * transfer indexing), but none of them sees a plain manual journal that
 * happens to touch a bank account dimension directly (one bank-dimension
 * posting + one expense/income leg, no transaction record at all). This
 * module scans ALL journals touching a bank account's dimension for a
 * same-direction, same-amount, nearby-date posting — a SUSPECT, never a
 * certainty, since two legitimate identical payments are possible.
 *
 * Kept MCP-free: no `wrapUntrustedOcr` import here — callers pass their own
 * `wrapTitle` into `formatDuplicatePostingWarnings`.
 */

export const DUPLICATE_SCAN_WINDOW_DAYS = 7;
export const DUPLICATE_AMOUNT_TOLERANCE = 0.01;

export interface BankDimensionInfo {
  dimensionId: number;
  accountId: number;
  title: string;
}

export interface DuplicatePostingCandidate {
  accountId: number;
  dimensionId: number | null; // null = any dimension (intake mode)
  amount: number;
  direction: "D" | "C";
  date: string;
  excludeJournalIds?: ReadonlySet<number>;
}

export interface DuplicatePostingSuspect {
  journal_id: number;
  journal_title: string;
  document_number: string | null;
  operation_type: string | null;
  date: string;
  amount: number;
  type: "D" | "C";
  dimension_id: number | null;
  day_distance: number;
  /** Internal only (never rendered): the transaction a TRANSACTION journal registers. */
  operations_id?: number;
  /**
   * Advisory annotation: a same-namespace source reference proves this suspect
   * is a different movement. It stays a suspect: blocking is unchanged.
   */
  distinct_source_reference?: true;
}

export interface DuplicatePostingScanResult {
  scan_available: boolean;
  scan_note?: string;
  window_days: number;
  suspects: DuplicatePostingSuspect[];
}

// ---------------------------------------------------------------------------
// Date helpers — UTC day arithmetic on split ISO parts (no ambient time),
// built on the shared `toUtcDay` (src/date-utils.ts).
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function shiftIsoDate(date: string, deltaDays: number): string {
  const shifted = new Date(toUtcDay(date) + deltaDays * MS_PER_DAY);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function utcDayDiff(a: string, b: string): number {
  return Math.round(Math.abs(toUtcDay(a) - toUtcDay(b)) / MS_PER_DAY);
}

/**
 * Join bank accounts to their account dimensions: `{dimensionId, accountId,
 * title}` for every bank account that has an `accounts_dimensions_id`,
 * resolved against a non-deleted `AccountDimension`, deduped by dimension id.
 */
export async function resolveBankDimensions(api: {
  readonly: { getBankAccounts(): Promise<BankAccount[]>; getAccountDimensions(): Promise<AccountDimension[]> };
}): Promise<BankDimensionInfo[]> {
  const [bankAccounts, accountDimensions] = await Promise.all([
    api.readonly.getBankAccounts(),
    api.readonly.getAccountDimensions(),
  ]);

  const dimensionsById = new Map<number, AccountDimension>();
  for (const dim of accountDimensions) {
    if (dim.id == null || dim.is_deleted) continue;
    dimensionsById.set(dim.id, dim);
  }

  const seen = new Set<number>();
  const result: BankDimensionInfo[] = [];
  for (const ba of bankAccounts) {
    const dimensionId = ba.accounts_dimensions_id;
    if (dimensionId == null || seen.has(dimensionId)) continue;
    const dim = dimensionsById.get(dimensionId);
    if (!dim) continue;
    seen.add(dimensionId);
    result.push({ dimensionId, accountId: dim.accounts_id, title: dim.title_est });
  }
  return result;
}

export interface SafeBankDimensions {
  dimensions: BankDimensionInfo[];
  scanAvailable: boolean;
  scanNote?: string;
}

/**
 * Fail-safe wrapper over `resolveBankDimensions` for the mutation-path guard
 * hooks (create_transaction, create_journal, reconcile confirm/suggest). The
 * guard is advisory only, so its OWN reference-data reads (`getBankAccounts` /
 * `getAccountDimensions`) must never fail an otherwise-valid booking. Any throw
 * degrades to `scanAvailable: false` with an empty dimension list and a
 * scan-unavailable note (same "Duplicate scan unavailable:" prefix the journals
 * fetch uses), mirroring how `checkIntakeCashDuplicates` guards the intake path.
 */
export async function resolveBankDimensionsSafe(api: {
  readonly: { getBankAccounts(): Promise<BankAccount[]>; getAccountDimensions(): Promise<AccountDimension[]> };
}): Promise<SafeBankDimensions> {
  try {
    return { dimensions: await resolveBankDimensions(api), scanAvailable: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      dimensions: [],
      scanAvailable: false,
      scanNote: `Duplicate scan unavailable: ${message} — bank-dimension resolution failed; cross-mechanism duplicate coverage is incomplete for this call.`,
    };
  }
}

/**
 * Pure in-memory matcher: scan `journals` for postings on
 * `candidate.accountId` within `+/-windowDays` of `candidate.date`, matching
 * direction and amount (within `amountTolerance`), filtered by dimension
 * (`null` = any) and `excludeJournalIds`. Sorted by day distance, then
 * journal id. Only registered journals count unless `includeUnregistered`.
 */
export function findDuplicatePostingsInJournals(
  journals: Journal[],
  candidate: DuplicatePostingCandidate,
  opts?: { windowDays?: number; amountTolerance?: number; includeUnregistered?: boolean },
): DuplicatePostingSuspect[] {
  const windowDays = opts?.windowDays ?? DUPLICATE_SCAN_WINDOW_DAYS;
  const tolerance = opts?.amountTolerance ?? DUPLICATE_AMOUNT_TOLERANCE;
  const from = shiftIsoDate(candidate.date, -windowDays);
  const to = shiftIsoDate(candidate.date, windowDays);
  const rows = listAccountDimensionPostings(journals, candidate.accountId, {
    dateFrom: from,
    dateTo: to,
    includeUnregistered: opts?.includeUnregistered,
  });

  const suspects: DuplicatePostingSuspect[] = [];
  for (const row of rows) {
    if (candidate.dimensionId !== null && row.accounts_dimensions_id !== candidate.dimensionId) continue;
    if (row.type !== candidate.direction) continue;
    if (Math.abs(row.amount - candidate.amount) > tolerance + 1e-9) continue;
    if (candidate.excludeJournalIds?.has(row.journal_id)) continue;
    suspects.push({
      journal_id: row.journal_id,
      journal_title: row.journal_title,
      document_number: row.document_number,
      operation_type: row.operation_type,
      date: row.date,
      amount: row.amount,
      type: row.type,
      dimension_id: row.accounts_dimensions_id,
      day_distance: utcDayDiff(row.date, candidate.date),
      ...(row.operations_id !== undefined ? { operations_id: row.operations_id } : {}),
    });
  }

  return suspects.sort((a, b) => a.day_distance - b.day_distance || a.journal_id - b.journal_id);
}

/**
 * Wire shape of a rendered suspect: the same fields without the internal
 * `operations_id`, with `journal_title` / `document_number` sandbox-wrapped.
 */
export type RenderedDuplicatePostingSuspect = Omit<DuplicatePostingSuspect, "operations_id">;

/**
 * Suspects as MCP output: the journal title and document number are
 * upstream free text, so both are sandbox-wrapped. The one rendering every
 * `possible_duplicate_postings` list uses.
 */
export function renderDuplicatePostingSuspects(suspects: readonly DuplicatePostingSuspect[]): RenderedDuplicatePostingSuspect[] {
  return suspects.map(({ operations_id: _operationsId, ...s }) => ({
    ...s,
    journal_title: wrapUntrustedOcr(s.journal_title) ?? "",
    document_number: s.document_number == null ? s.document_number : wrapUntrustedOcr(s.document_number) ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Source-reference annotation — advisory only, never a filter. A suspect stays
// in the list (and in every block_on_duplicate refusal); one proven to be a
// different movement by a typed source reference in the SAME namespace is
// only marked `distinct_source_reference: true`.
// ---------------------------------------------------------------------------

/** The typed source identity of one bank movement on its bank dimension. */
export interface SourceReferenceIdentity {
  readonly dimensionId: number;
  /** `wise:<id>` per leg (main row or its fee row). */
  readonly wise?: { readonly leg: "main" | "fee"; readonly id: string };
  /** `camt:<key>` — the stored bank-reference lookup key (full and hash forms agree). */
  readonly camt?: string;
}

/** The Wise leg and ID a `WISE:{id}` / `WISE:FEE:{id}` tag names (a split-leg `:CUR` suffix is the same ID). */
function wiseTagIdentity(tag: string | null | undefined): SourceReferenceIdentity["wise"] {
  const value = tag?.trim().split(/\s+/)[0] ?? "";
  const leg = value.startsWith("WISE:FEE:") ? "fee" : value.startsWith("WISE:") ? "main" : undefined;
  if (leg === undefined) return undefined;
  const prefix = leg === "fee" ? "WISE:FEE:" : "WISE:";
  const id = value.slice(prefix.length).split(":")[0] ?? "";
  if (id === "" || matchWiseLegTag(value, `${prefix}${id}`) === undefined) return undefined;
  return { leg, id };
}

/** A stored or about-to-be-created bank transaction's identity: its WISE: tag and/or verified CAMT key. */
export function transactionSourceReferenceIdentity(
  transaction: Parameters<typeof storedBankReferenceLookupKey>[0] & Pick<Transaction, "accounts_dimensions_id">,
): SourceReferenceIdentity | undefined {
  const dimensionId = transaction.accounts_dimensions_id;
  if (typeof dimensionId !== "number") return undefined;
  const wise = wiseTagIdentity(transaction.description);
  const camt = storedBankReferenceLookupKey(transaction);
  if (wise === undefined && camt === undefined) return undefined;
  return { dimensionId, ...(wise ? { wise } : {}), ...(camt ? { camt } : {}) };
}

/** A journal's identity from a `WISE:{id}` document number, on the bank dimension it posts. */
export function journalSourceReferenceIdentity(
  documentNumber: string | null | undefined,
  dimensionId: number | null,
): SourceReferenceIdentity | undefined {
  const wise = wiseTagIdentity(documentNumber);
  return wise !== undefined && dimensionId !== null ? { dimensionId, wise } : undefined;
}

/**
 * Positively different: the same bank dimension, at least one namespace both
 * sides carry (Wise on the same leg, or CAMT), and a different value in every
 * such namespace. Different namespaces are not comparable.
 */
function differentSourceReference(left: SourceReferenceIdentity, right: SourceReferenceIdentity): boolean {
  if (left.dimensionId !== right.dimensionId) return false;
  const differs: boolean[] = [];
  if (left.wise && right.wise && left.wise.leg === right.wise.leg) differs.push(left.wise.id !== right.wise.id);
  if (left.camt && right.camt) differs.push(left.camt !== right.camt);
  return differs.length > 0 && differs.every(Boolean);
}

/**
 * Annotate an existing scan's suspects with `distinct_source_reference`.
 * Runs after the scan and never changes it otherwise: same suspects, same
 * order, same `scan_available`. A TRANSACTION journal is identified only
 * through its registered transaction (`operations_id`), any other journal by
 * its `WISE:` document number. Any error returns the scan unannotated.
 */
export async function annotateDistinctSourceReferences(
  scan: DuplicatePostingScanResult,
  candidate: () => SourceReferenceIdentity | undefined,
  loadTransactions: () => Promise<readonly Transaction[]>,
): Promise<DuplicatePostingScanResult> {
  if (!scan.scan_available || scan.suspects.length === 0) return scan;
  try {
    const candidateIdentity = candidate();
    if (candidateIdentity === undefined) return scan;
    const transactions = await loadTransactions();
    const transactionById = new Map(transactions.filter(tx => tx.is_deleted !== true && tx.id !== undefined).map(tx => [tx.id!, tx]));
    const suspects = scan.suspects.map(suspect => {
      let identity: SourceReferenceIdentity | undefined;
      if (suspect.operation_type === "TRANSACTION") {
        const transaction = suspect.operations_id !== undefined ? transactionById.get(suspect.operations_id) : undefined;
        identity = transaction ? transactionSourceReferenceIdentity(transaction) : undefined;
      } else {
        identity = journalSourceReferenceIdentity(suspect.document_number, suspect.dimension_id);
      }
      return identity && differentSourceReference(candidateIdentity, identity)
        ? { ...suspect, distinct_source_reference: true as const }
        : suspect;
    });
    return { ...scan, suspects };
  } catch {
    return scan;
  }
}

/**
 * API-facing scan: loads `opts.preloadedJournals` or
 * `api.journals.listAllWithPostings()` and runs the pure matcher over it.
 * Degrades gracefully — a guard failure must never fail a host tool. ANY
 * throw while loading journals (e.g. past `BaseResource.listAll`'s 200-page
 * cap) is caught and reported as `scan_available: false` with an empty
 * suspect list; it is never re-thrown.
 */
export async function findDuplicateBankPostings(
  api: { journals: { listAllWithPostings(): Promise<Journal[]> } },
  candidate: DuplicatePostingCandidate,
  opts?: { windowDays?: number; amountTolerance?: number; preloadedJournals?: Journal[] },
): Promise<DuplicatePostingScanResult> {
  const windowDays = opts?.windowDays ?? DUPLICATE_SCAN_WINDOW_DAYS;
  try {
    const journals = opts?.preloadedJournals ?? (await api.journals.listAllWithPostings());
    const suspects = findDuplicatePostingsInJournals(journals, candidate, opts);
    return { scan_available: true, window_days: windowDays, suspects };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      scan_available: false,
      scan_note: `Duplicate scan unavailable: ${message} — cross-mechanism duplicate coverage is incomplete for this call.`,
      window_days: windowDays,
      suspects: [],
    };
  }
}

/**
 * Intake-time scan (Task 6): catches the incident at the EARLIEST moment — a
 * receipt/PDF about to become a fresh invoice+transaction pair — before any
 * mutation exists to clean up. Unlike `findDuplicateBankPostings` (one known
 * bank dimension), this scans ALL bank dimensions across ALL bank accounts,
 * since the intake flow does not yet know which bank account will settle the
 * invoice.
 *
 * `grossAmountEur` must be a real EUR figure (actual settled EUR gross, or the
 * nominal gross for an EUR-native invoice) — never a guessed conversion. When
 * the caller has no such figure (e.g. a foreign-currency invoice without
 * `base_gross_price`), pass `undefined` and this returns `skipped_no_eur_amount:
 * true` with `scan_available: true` (the scan wasn't attempted, not that it
 * failed) and an explanatory `scan_note`.
 *
 * Defensively wraps the ENTIRE lookup (including `resolveBankDimensions`) in
 * one try/catch — stricter than `findDuplicateBankPostings`, which only
 * guards the journals fetch — because this is the earliest-moment guard and
 * must never be the reason a legitimate intake booking fails, regardless of
 * which reference-data call is unavailable.
 */
export async function checkIntakeCashDuplicates(
  api: {
    journals: { listAllWithPostings(): Promise<Journal[]> };
    readonly: { getBankAccounts(): Promise<BankAccount[]>; getAccountDimensions(): Promise<AccountDimension[]> };
  },
  input: { grossAmountEur: number | undefined; invoiceDate: string },
  opts?: { windowDays?: number },
): Promise<DuplicatePostingScanResult & { skipped_no_eur_amount?: boolean }> {
  const windowDays = opts?.windowDays ?? DUPLICATE_SCAN_WINDOW_DAYS;

  if (input.grossAmountEur === undefined) {
    return {
      scan_available: true,
      window_days: windowDays,
      suspects: [],
      skipped_no_eur_amount: true,
      scan_note:
        "Duplicate scan skipped: no EUR-equivalent gross amount available for this invoice " +
        "(foreign-currency invoice without base_gross_price) — never guessing a conversion rate to compare " +
        "against EUR-denominated bank postings.",
    };
  }

  try {
    const bankDims = await resolveBankDimensions(api);
    const accountIds = [...new Set(bankDims.map(d => d.accountId))];
    if (accountIds.length === 0) {
      return { scan_available: true, window_days: windowDays, suspects: [] };
    }

    // Load journals ONCE, then run the pure in-memory matcher per account —
    // avoids refetching the full journals list per bank account.
    // A journal with debit and credit legs all on bank accounts (a transfer between own accounts) has no
    // expense leg, so it cannot be an earlier payment of this invoice (live: a 25 € transfer between own banks).
    const isOwnTransfer = (journal: Journal) => {
      const postings = journal.postings ?? [];
      return postings.some(posting => posting.type === "D") && postings.some(posting => posting.type === "C")
        && postings.every(posting => accountIds.includes(posting.accounts_id));
    };
    const journals = (await api.journals.listAllWithPostings()).filter(journal => !isOwnTransfer(journal));
    const seenJournalIds = new Set<number>();
    const suspects: DuplicatePostingSuspect[] = [];
    for (const accountId of accountIds) {
      const candidate: DuplicatePostingCandidate = {
        accountId,
        dimensionId: null, // any dimension — intake doesn't yet know which bank account settles this
        amount: input.grossAmountEur,
        direction: "C", // outflow: paying a purchase invoice
        date: input.invoiceDate,
      };
      for (const suspect of findDuplicatePostingsInJournals(journals, candidate, { windowDays })) {
        if (seenJournalIds.has(suspect.journal_id)) continue;
        seenJournalIds.add(suspect.journal_id);
        suspects.push(suspect);
      }
    }
    suspects.sort((a, b) => a.day_distance - b.day_distance || a.journal_id - b.journal_id);

    return { scan_available: true, window_days: windowDays, suspects };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      scan_available: false,
      scan_note: `Duplicate scan unavailable: ${message} — cross-mechanism duplicate coverage is incomplete for this call.`,
      window_days: windowDays,
      suspects: [],
    };
  }
}

/**
 * Render one warning line per suspect plus (when the scan degraded) one
 * line carrying `scan_note`. `wrapTitle` sandboxes untrusted journal titles
 * and document numbers at the call site (`wrapUntrustedOcr`) — this module
 * stays MCP-free.
 */
export function formatDuplicatePostingWarnings(
  result: DuplicatePostingScanResult,
  candidate: DuplicatePostingCandidate,
  wrapTitle: (t: string) => string,
): string[] {
  const lines: string[] = [];
  const directionWord = candidate.direction === "C" ? "outflow" : "inflow";
  const amount = roundMoney(candidate.amount);
  for (const suspect of result.suspects) {
    // document_number is upstream free text too — sandbox it like the title.
    const docPart = suspect.document_number ? `, doc ${wrapTitle(suspect.document_number)}` : "";
    if (suspect.distinct_source_reference === true) {
      lines.push(
        `Likely a different movement (different source reference): journal ${suspect.journal_id} "${wrapTitle(suspect.journal_title)}" (${suspect.date}${docPart}) books the same ${amount} € ${directionWord} under a different source reference. Advisory only — it is still listed as a duplicate suspect.`,
      );
      continue;
    }
    lines.push(
      `POSSIBLE duplicate: this ${amount} € ${directionWord} may already be booked by journal ${suspect.journal_id} "${wrapTitle(suspect.journal_title)}" (${suspect.date}${docPart}). Verify before proceeding — two legitimate identical payments are possible.`,
    );
  }
  if (!result.scan_available && result.scan_note) {
    lines.push(result.scan_note);
  }
  return lines;
}
