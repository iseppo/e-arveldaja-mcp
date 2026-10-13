// UTC calendar-day arithmetic shared across modules. Pure, no ambient time
// zone: every helper works on UTC so offsets never drift across DST. These are
// arithmetic helpers, not validators — see strict-date.ts for input checking.

/**
 * Convert a date string (`YYYY-MM-DD` or any ISO prefix) to a UTC day
 * timestamp. Slicing to the first 10 chars drops any time / timezone
 * suffix, so arithmetic stays DST-free.
 */
export function toUtcDay(s: string): number {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

/** Number of days (28-31) in a `YYYY-MM` month. */
export function getMonthLastDay(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  // setUTCFullYear, not Date.UTC: Date.UTC remaps years 0-99 to 1900-1999,
  // which gets 0000-02 wrong (1900 is not a leap year, year 0 is).
  const date = new Date(0);
  date.setUTCFullYear(year!, monthNumber!, 0);
  return date.getUTCDate();
}

/** Whole days from `dueDate` to `asOf` (both YYYY-MM-DD); positive when past due. */
export function daysPastDue(dueDate: string, asOf: string): number {
  return Math.round((Date.parse(asOf + "T12:00:00Z") - Date.parse(dueDate + "T12:00:00Z")) / 86_400_000);
}
