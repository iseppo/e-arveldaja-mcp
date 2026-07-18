/**
 * Resolve chart-of-accounts numbers by their Estonian name against the company's
 * ACTUAL chart, instead of assuming a fixed number. e-arveldaja generates the
 * RTJ-standard chart for every new company, so the account NAMES are stable
 * across companies (verified identical across multiple company charts), while a
 * hardcoded NUMBER can be wrong for a custom or older chart. Each resolver takes
 * the fetched chart and an optional caller override, and falls back to the
 * standard-chart constant only when no active account matches by name.
 */
import type { Account } from "./types/api.js";
import {
  RETAINED_EARNINGS_ACCOUNT,
  DIVIDEND_PAYABLE_ACCOUNT,
  CIT_PAYABLE_ACCOUNT,
  SHARE_CAPITAL_ACCOUNT,
  RESERVE_CAPITAL_ACCOUNT,
  DEFAULT_OTHER_FINANCIAL_INCOME_ACCOUNT,
  DEFAULT_FX_GAIN_ACCOUNT,
  SECURITIES_INCOME_ACCOUNT,
  SECURITIES_EXPENSE_ACCOUNT,
} from "./accounting-defaults.js";

/**
 * Return the id (account number) of the lowest-numbered ACTIVE account whose
 * Estonian name matches `pattern`, or undefined when none match. Inactive
 * accounts (is_valid === false) are skipped so a deactivated account is never
 * chosen. The lowest-id tie-break makes the choice deterministic when several
 * accounts share a name fragment.
 */
export function findAccountByName(accounts: Account[], pattern: RegExp): number | undefined {
  return accounts
    .filter(a => a.is_valid !== false)
    .filter(a => pattern.test(a.name_est ?? ""))
    .map(a => a.id)
    .sort((x, y) => x - y)[0];
}

/**
 * Resolve an account: explicit override wins; otherwise the first active
 * name match; otherwise the standard-chart fallback constant.
 */
export function resolveAccountByName(
  accounts: Account[],
  pattern: RegExp,
  fallback: number,
  override?: number,
): number {
  if (override !== undefined) return override;
  return findAccountByName(accounts, pattern) ?? fallback;
}

// Name patterns are anchored/specific enough to match exactly one account in the
// standard chart (verified against real company charts). Kept here so every tool
// resolves the same concept identically.

// Patterns are anchored (^…$) so a prefixed/suffixed sibling in a custom chart
// (e.g. "Jaotamata kasumi reserv", "Realiseerimata kasum/kahjum valuutakursi
// muutustest", "Vabatahtlik reservkapital") can never be matched instead of the
// intended standard account.

/** Retained earnings — "Eelmiste perioodide jaotamata kasum (kahjum)" (2960);
 * anchored so "Jaotamata kasumi reserv" (a distributable reserve) is excluded. */
export const resolveRetainedEarningsAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^(eelmiste perioodide )?jaotamata kasum( \(kahjum\))?$/i, RETAINED_EARNINGS_ACCOUNT, override);

/** Dividend payable — "Dividendivõlad" (2650). */
export const resolveDividendPayableAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^dividendiv[õo]lad$/i, DIVIDEND_PAYABLE_ACCOUNT, override);

/** Dividend income-tax payable — "Dividenditulumaksu võlg" (2656), not the
 * viitvõlg/intressivõlg siblings. */
export const resolveDividendCitPayableAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^dividenditulumaksu v[õo]lg$/i, CIT_PAYABLE_ACCOUNT, override);

/** Share capital — "Osakapital või aktsiakapital nimiväärtuses" (2900); fully
 * anchored so "Registreerimata …" / "Sissemaksmata osakapital" (prefixes) and
 * "… – sissemaksmata osa" (suffixes) are all excluded. */
export const resolveShareCapitalAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^osakapital v[õo]i aktsiakapital nimiväärtuses$/i, SHARE_CAPITAL_ACCOUNT, override);

/**
 * Statutory non-distributable reserves for the ÄS §157(2) floor — EVERY account
 * named exactly "Kohustuslik reservkapital" PLUS the standard-chart reserve
 * number (2940), always unioned in and de-duplicated.
 *
 * Anchored on "kohustuslik" so a distributable "Vabatahtlik reservkapital" is
 * excluded. Returns ALL name matches (a company may hold both an old,
 * deactivated reserve account and its active replacement) and INCLUDES inactive
 * accounts — this is a statutory balance read, so a funded reserve must not be
 * missed just because the account was deactivated for posting.
 *
 * The standard 2940 is ALWAYS included, even when a name match already exists,
 * to close a composed fallback hole: if an empty legacy account still carries
 * the exact name "Kohustuslik reservkapital" while the funded 2940 was RENAMED
 * to a synonym (e.g. "Seadusjärgne reserv"), matching by name alone would return
 * only the empty legacy account and silently understate the floor — permitting an
 * unlawful dividend. Unioning 2940 guarantees its balance is always read. This is
 * safe because the caller keys the floor on the BOOKED BALANCE: an unfunded or
 * absent 2940 adds nothing, so the union can only make the floor more
 * conservative, never lower it. A company that has genuinely repurposed 2940 to a
 * distributable reserve must pass restricted_reserve_accounts explicitly to
 * override this statutory default.
 */
export function resolveRestrictedReserveAccounts(accounts: Account[]): number[] {
  const matches = accounts
    .filter(a => /^kohustuslik reservkapital$/i.test(a.name_est ?? ""))
    .map(a => a.id);
  return [...new Set([...matches, RESERVE_CAPITAL_ACCOUNT])];
}

/** Other financial income — "Muud finantstulud" (8600). Lightyear broker rewards. */
export const resolveOtherFinancialIncomeAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^muud finantstulud$/i, DEFAULT_OTHER_FINANCIAL_INCOME_ACCOUNT, override);

/** Combined FX gain/loss — "Kasum/kahjum valuutakursi muutustest" (8500);
 * anchored so an unrealized-FX sibling ("Realiseerimata …") is excluded. */
export const resolveFxAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^kasum\/kahjum valuutakursi muutustest$/i, DEFAULT_FX_GAIN_ACCOUNT, override);

/** Securities income — "Tulu aktsiatelt ja osadelt" (8330). */
export const resolveSecuritiesIncomeAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^tulu aktsiatelt ja osadelt$/i, SECURITIES_INCOME_ACCOUNT, override);

/** Securities expense — "Kulu aktsiatelt ja osadelt" (8335). */
export const resolveSecuritiesExpenseAccount = (accounts: Account[], override?: number): number =>
  resolveAccountByName(accounts, /^kulu aktsiatelt ja osadelt$/i, SECURITIES_EXPENSE_ACCOUNT, override);
