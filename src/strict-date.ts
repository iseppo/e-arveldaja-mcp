// Strict calendar-date validation shared by every façade and flow that accepts
// operator-supplied dates. A bare /^\d{4}-\d{2}-\d{2}$/ regex admits
// non-existent calendar dates (2026-02-31, 2026-13-01, 2026-00-10) which the
// backend may coerce or reject unpredictably; Date.parse is locale/UTC-shift
// ambiguous. This module is the single canonical parser: it requires the
// canonical YYYY-MM-DD form, checks the real calendar (month lengths + leap
// years) with pure integer arithmetic, and never consults Date/locale.

const CANONICAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CANONICAL_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1]!;
}

export interface StrictDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** The canonical YYYY-MM-DD value (identical to the accepted input). */
  readonly canonical: string;
}

/** Parse a strict canonical calendar date. Returns undefined for anything that
 * is not a real calendar date in canonical YYYY-MM-DD form (wrong shape,
 * month 00/13, day 00/32, 2026-02-29 on a non-leap year, `2026-1-1`, …). */
export function parseStrictDate(value: string): StrictDateParts | undefined {
  const match = CANONICAL_DATE_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day, canonical: value };
}

/** True iff the value is a real calendar date in canonical YYYY-MM-DD form. */
export function isStrictDate(value: string): boolean {
  return parseStrictDate(value) !== undefined;
}

/** Parse a strict canonical YYYY-MM month. Returns undefined for wrong shape
 * or month 00/13+. */
export function parseStrictMonth(value: string): { readonly year: number; readonly month: number; readonly canonical: string } | undefined {
  const match = CANONICAL_MONTH_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return { year, month, canonical: value };
}

/** True iff both are strict calendar dates and from <= to (lexicographic
 * comparison is correct for canonical YYYY-MM-DD). */
export function isStrictDateRange(from: string, to: string): boolean {
  return isStrictDate(from) && isStrictDate(to) && from <= to;
}

/** Validate an optional date field: undefined passes; a present value must be
 * a strict calendar date. Returns an error message naming the field, or
 * undefined when valid. */
export function validateOptionalStrictDate(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isStrictDate(value)) return `${field} must be a real calendar date in canonical YYYY-MM-DD form.`;
  return undefined;
}

/** Validate an optional from/to pair: each present value must be strict, and
 * when both are present from must not exceed to. Returns the first error
 * message, or undefined when valid. */
export function validateOptionalStrictDateRange(
  fromField: string,
  from: string | undefined,
  toField: string,
  to: string | undefined,
): string | undefined {
  const fromError = validateOptionalStrictDate(fromField, from);
  if (fromError) return fromError;
  const toError = validateOptionalStrictDate(toField, to);
  if (toError) return toError;
  if (from !== undefined && to !== undefined && from > to) {
    return `${fromField} must not be after ${toField}.`;
  }
  return undefined;
}
