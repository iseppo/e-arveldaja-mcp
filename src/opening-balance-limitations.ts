import type { OpeningBalanceJournal } from "./opening-balance-journal.js";

/** Disclose source presence separately from amounts included by normal filters. */
export function withOpeningBalanceJournalStatus(
  warnings: string[],
  opening: OpeningBalanceJournal | null,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): string[] {
  if (!opening) return [...warnings];
  const { journal, openingDate } = opening;
  const reason = journal.is_deleted ? "deleted" : !journal.registered ? "unregistered" :
    !journal.postings?.some(p => !p.is_deleted) ? "without active postings" :
    (dateFrom && openingDate < dateFrom) || (dateTo && openingDate > dateTo) ? "outside this date range" : undefined;
  return [...warnings, reason
    ? `API INITIAL opening balance (as of ${openingDate}) is ${reason} and is not included in these figures.`
    : `Opening balances applied from API INITIAL (as of ${openingDate}).`];
}
