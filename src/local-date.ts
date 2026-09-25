// e-arveldaja books are kept in Estonian local time. Deriving "today" from the
// UTC date is off by one day between local midnight and 02:00/03:00, which
// shifts overdue/aging cut-offs and default booking dates.
const tallinnDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Tallinn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) in Europe/Tallinn at `now` (default: current time). */
export function todayInTallinn(now: Date = new Date()): string {
  return tallinnDate.format(now);
}
