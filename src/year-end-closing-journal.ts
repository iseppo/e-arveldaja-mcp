import type { Journal } from "./types/api.js";

/**
 * True for a LEGACY year-end closing journal (YECL-YYYY, dated YYYY-12-31) that
 * older execute_year_end_close versions booked to zero every Tulud/Kulud
 * account into 2970 (replaced by the RIK two-entry method below).
 * Without `year` the year is derived from the journal's own effective_date, so
 * a P&L spanning several years excludes every closing journal it covers.
 * Balance-sheet style reports must keep these journals: for them the close is
 * a real posting. Lives outside annual-report.ts so financial-statements.ts can
 * use it without an import cycle.
 */
export function isYearEndClosingJournal(
  journal: Pick<Journal, "document_number" | "effective_date" | "title">,
  year?: number,
): boolean {
  let targetYear: number;

  if (year !== undefined) {
    if (!Number.isInteger(year) || year < 1000 || year > 9999) return false;
    targetYear = year;
  } else {
    const dateMatch = /^(\d{4})-/.exec(journal.effective_date ?? "");
    if (!dateMatch) return false;
    targetYear = Number(dateMatch[1]);
    if (targetYear < 1000 || targetYear > 9999) return false;
  }

  if (journal.effective_date !== `${targetYear}-12-31`) return false;
  if (journal.document_number === `YECL-${targetYear}`) return true;

  const title = journal.title?.toLocaleLowerCase("et-EE") ?? "";
  return title.includes(`aasta lõppkanne ${targetYear}`) ||
    title.includes(`year-end close ${targetYear}`);
}

// ---------------------------------------------------------------------------
// RIK year-end close in e-arveldaja ("Äriühingu majandusaasta lõpetamiskanded
// e-arveldajas"): two MANUAL entries, revenue/expense accounts stay open.
//   A. last day of the year:      profit D 9000 / K 2970 (loss reversed)
//   B. first day of the next year: profit D 2970 / K 2960 (+ optional K 2940)
// Operators book these by hand under any document number, so detection is
// structural (date + the accounts touched); the MCP's own document numbers
// are an extra, stable key.
// ---------------------------------------------------------------------------

/** Document number execute_year_end_close gives entry A (9000 ↔ 2970). */
export const yearEndResultDocumentNumber = (year: number): string => `YEC-RESULT-${year}`;
/** Document number execute_year_end_close gives entry B (2970 → 2960). */
export const yearEndTransferDocumentNumber = (year: number): string => `YEC-RETAINED-${year}`;

type ClosingCandidate = Pick<Journal, "document_number" | "effective_date" | "postings">;

function postedAccountIds(journal: ClosingCandidate): Set<number> {
  return new Set((journal.postings ?? [])
    .filter((posting) => !posting.is_deleted && (posting.type === "D" || posting.type === "C"))
    .map((posting) => posting.accounts_id));
}

/**
 * RIK entry A for `year`: dated YYYY-12-31 and posting ONLY between the
 * calculated-result account (9000) and the current-year-result account (2970),
 * touching both — or carrying the MCP's YEC-RESULT-YYYY number on that date.
 * Deleted/unregistered filtering is left to the caller.
 */
export function isYearEndResultEntry(
  journal: ClosingCandidate,
  year: number,
  accounts: { calculatedResult: number; currentYearProfit: number },
): boolean {
  if (journal.effective_date !== `${year}-12-31`) return false;
  if (journal.document_number === yearEndResultDocumentNumber(year)) return true;
  return isResultEntryShape(journal, accounts);
}

/**
 * Account shape of RIK entry A: posts ONLY between 9000 and 2970, touching
 * both. A journal found by its YEC-RESULT-YYYY number alone must still have
 * this shape before it may count as a close.
 */
export function isResultEntryShape(
  journal: ClosingCandidate,
  accounts: { calculatedResult: number; currentYearProfit: number },
): boolean {
  const ids = postedAccountIds(journal);
  return ids.size === 2 && ids.has(accounts.calculatedResult) && ids.has(accounts.currentYearProfit);
}

/**
 * RIK entry B for `year`: dated (YYYY+1)-01-01, touching both the
 * current-year-result account (2970) and retained earnings (2960), with every
 * posting on those or a reserve account — or carrying YEC-RETAINED-YYYY on
 * that date.
 */
export function isYearEndTransferEntry(
  journal: ClosingCandidate,
  year: number,
  accounts: { currentYearProfit: number; retainedEarnings: number; reserves: number[] },
): boolean {
  if (journal.effective_date !== `${year + 1}-01-01`) return false;
  if (journal.document_number === yearEndTransferDocumentNumber(year)) return true;
  return isRetainedTransferShape(journal, accounts);
}

/**
 * Date-agnostic shape of RIK entry B: touches both the current-year-result
 * account (2970) and retained earnings (2960), every posting on those or a
 * reserve account. Operators also book the transfer by hand on another date
 * of the next year (e.g. 1 December), so off-date detection uses this shape.
 */
export function isRetainedTransferShape(
  journal: ClosingCandidate,
  accounts: { currentYearProfit: number; retainedEarnings: number; reserves: number[] },
): boolean {
  const ids = postedAccountIds(journal);
  if (!ids.has(accounts.currentYearProfit) || !ids.has(accounts.retainedEarnings)) return false;
  const allowed = new Set([accounts.currentYearProfit, accounts.retainedEarnings, ...accounts.reserves]);
  return [...ids].every((id) => allowed.has(id));
}

/**
 * Account shape a journal carrying YEC-RETAINED-YYYY must have: debits 2970
 * into retained earnings and/or reserves only. Unlike
 * `isRetainedTransferShape` it does not require 2960 — a close that puts the
 * whole profit into reserve capital (D 2970 / K 2940) has no 2960 line.
 */
export function isNumberedTransferShape(
  journal: ClosingCandidate,
  accounts: { currentYearProfit: number; retainedEarnings: number; reserves: number[] },
): boolean {
  const ids = postedAccountIds(journal);
  if (!ids.has(accounts.currentYearProfit) || ids.size < 2) return false;
  const allowed = new Set([accounts.currentYearProfit, accounts.retainedEarnings, ...accounts.reserves]);
  return [...ids].every((id) => allowed.has(id));
}
