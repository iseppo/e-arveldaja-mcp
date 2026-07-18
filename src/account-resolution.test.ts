import { describe, expect, it } from "vitest";
import type { Account } from "./types/api.js";
import {
  findAccountByName,
  resolveAccountByName,
  resolveRetainedEarningsAccount,
  resolveDividendPayableAccount,
  resolveDividendCitPayableAccount,
  resolveShareCapitalAccount,
  resolveRestrictedReserveAccounts,
  resolveOtherFinancialIncomeAccount,
  resolveFxAccount,
  resolveSecuritiesIncomeAccount,
  resolveSecuritiesExpenseAccount,
} from "./account-resolution.js";

// Minimal account factory — only the fields the resolvers read.
function acct(id: number, name_est: string, is_valid = true): Account {
  return { id, name_est, is_valid } as Account;
}

// The e-arveldaja standard chart rows the resolvers target (verified identical
// across real company charts Seppo AI OÜ and Voxpoll OÜ).
const STANDARD_CHART: Account[] = [
  acct(2650, "Dividendivõlad"),
  acct(2655, "Dividenditulumaksu viitvõlg"),
  acct(2656, "Dividenditulumaksu võlg"),
  acct(2657, "Dividenditulumaksu intressivõlg"),
  acct(2900, "Osakapital või aktsiakapital nimiväärtuses"),
  acct(2910, "Registreerimata osakapital või aktsiakapital"),
  acct(2940, "Kohustuslik reservkapital"),
  acct(2960, "Eelmiste perioodide jaotamata kasum (kahjum)"),
  acct(2970, "Aruandeaasta kasum (kahjum)"),
  acct(3840, "Kasum valuutakursi muutustest"),
  acct(3990, "Muud äritulud"),
  acct(7310, "Valuutakursikahjum arveldustest ostjate ja tarnijatega"),
  acct(8330, "Tulu aktsiatelt ja osadelt"),
  acct(8335, "Kulu aktsiatelt ja osadelt"),
  acct(8500, "Kasum/kahjum valuutakursi muutustest"),
  acct(8600, "Muud finantstulud"),
  acct(8610, "Muud finantskulud"),
];

describe("findAccountByName / resolveAccountByName", () => {
  it("returns undefined when nothing matches", () => {
    expect(findAccountByName(STANDARD_CHART, /nonexistent account/i)).toBeUndefined();
  });

  it("skips inactive accounts and picks the lowest active id", () => {
    const chart = [acct(2650, "Dividendivõlad", false), acct(2651, "Dividendivõlad")];
    expect(findAccountByName(chart, /^dividendiv[õo]lad$/i)).toBe(2651);
  });

  it("resolveAccountByName: override wins over any match", () => {
    expect(resolveAccountByName(STANDARD_CHART, /dividendiv[õo]lad/i, 9999, 1234)).toBe(1234);
  });

  it("resolveAccountByName: falls back to the constant when no active match", () => {
    expect(resolveAccountByName([], /dividendiv[õo]lad/i, 2650)).toBe(2650);
  });

});

describe("resolveRestrictedReserveAccounts (§157(2) statutory reserve floor)", () => {
  it("returns the single standard reserve account", () => {
    expect(resolveRestrictedReserveAccounts(STANDARD_CHART)).toEqual([2940]);
  });

  it("returns EVERY 'Kohustuslik reservkapital', including a deactivated one, so a funded reserve is never missed", () => {
    // A company that replaced an old reserve account with a new one: both carry
    // the exact statutory name; the gate must read both balances, not just the
    // lowest-numbered (which could be the empty, deactivated one).
    const chart = [
      acct(2930, "Kohustuslik reservkapital", false), // old, deactivated
      acct(2940, "Kohustuslik reservkapital"),        // active replacement
    ];
    expect(resolveRestrictedReserveAccounts(chart).sort()).toEqual([2930, 2940]);
  });

  it("excludes a distributable 'Vabatahtlik reservkapital'", () => {
    const chart = [acct(2935, "Vabatahtlik reservkapital"), acct(2940, "Kohustuslik reservkapital")];
    expect(resolveRestrictedReserveAccounts(chart)).toEqual([2940]);
  });

  it("always unions in 2940 so a funded-but-renamed 2940 is not missed behind an empty legacy exact-name account", () => {
    // Composed fallback hole: an empty legacy 2930 keeps the exact statutory name,
    // while the funded reserve on 2940 was renamed to a synonym. Matching by name
    // alone would return only [2930] and understate the §157(2) floor — permitting
    // an unlawful dividend. 2940 must always be read so its balance counts.
    const chart = [
      acct(2930, "Kohustuslik reservkapital", false), // empty legacy, still exact-named
      acct(2940, "Seadusjärgne reserv"),              // funded, renamed synonym
    ];
    expect(resolveRestrictedReserveAccounts(chart).sort()).toEqual([2930, 2940]);
  });

  it("falls back to the standard 2940 number when none match by name (renamed)", () => {
    expect(resolveRestrictedReserveAccounts([acct(2940, "Seadusjärgne reserv")])).toEqual([2940]);
    expect(resolveRestrictedReserveAccounts([])).toEqual([2940]);
  });
});

describe("named resolvers against the standard chart", () => {
  it("resolves each concept to its standard account", () => {
    expect(resolveRetainedEarningsAccount(STANDARD_CHART)).toBe(2960);
    expect(resolveDividendPayableAccount(STANDARD_CHART)).toBe(2650);
    expect(resolveDividendCitPayableAccount(STANDARD_CHART)).toBe(2656);
    expect(resolveShareCapitalAccount(STANDARD_CHART)).toBe(2900);
    expect(resolveRestrictedReserveAccounts(STANDARD_CHART)).toEqual([2940]);
    expect(resolveOtherFinancialIncomeAccount(STANDARD_CHART)).toBe(8600);
    expect(resolveFxAccount(STANDARD_CHART)).toBe(8500);
    expect(resolveSecuritiesIncomeAccount(STANDARD_CHART)).toBe(8330);
    expect(resolveSecuritiesExpenseAccount(STANDARD_CHART)).toBe(8335);
  });

  it("dividend CIT resolver picks 2656, not the viitvõlg/intressivõlg siblings", () => {
    expect(resolveDividendCitPayableAccount(STANDARD_CHART)).toBe(2656);
  });

  it("FX resolver picks the combined 8500, not the Tulud-only 3840 or Kulud-only 7310", () => {
    expect(resolveFxAccount(STANDARD_CHART)).toBe(8500);
  });

  it("each resolver honours an explicit override", () => {
    expect(resolveShareCapitalAccount(STANDARD_CHART, 3000)).toBe(3000);
    expect(resolveFxAccount(STANDARD_CHART, 8610)).toBe(8610);
  });

  it("anchored resolvers reject prefixed/suffixed siblings in a custom chart", () => {
    // A custom chart where a lower-numbered distributable/unrealized sibling
    // sorts BEFORE the intended standard account. The resolver must still pick
    // the correct one, not the sibling.
    const chart: Account[] = [
      acct(2955, "Jaotamata kasumi reserv"),          // distributable reserve, lower id
      acct(2960, "Eelmiste perioodide jaotamata kasum (kahjum)"),
      acct(2935, "Vabatahtlik reservkapital"),        // distributable, lower id
      acct(2940, "Kohustuslik reservkapital"),
      acct(8490, "Realiseerimata kasum/kahjum valuutakursi muutustest"), // unrealized, lower id
      acct(8500, "Kasum/kahjum valuutakursi muutustest"),
      acct(2890, "Registreerimata osakapital või aktsiakapital"),        // prefix, lower id
      acct(2895, "Osakapital või aktsiakapital nimiväärtuses – sissemaksmata osa"), // suffix, lower id
      acct(2900, "Osakapital või aktsiakapital nimiväärtuses"),
    ];
    expect(resolveRetainedEarningsAccount(chart)).toBe(2960);
    expect(resolveRestrictedReserveAccounts(chart)).toEqual([2940]);
    expect(resolveFxAccount(chart)).toBe(8500);
    expect(resolveShareCapitalAccount(chart)).toBe(2900);
  });

  it("each resolver falls back to its standard constant on an empty chart", () => {
    expect(resolveRetainedEarningsAccount([])).toBe(2960);
    expect(resolveDividendPayableAccount([])).toBe(2650);
    expect(resolveDividendCitPayableAccount([])).toBe(2656);
    expect(resolveShareCapitalAccount([])).toBe(2900);
    expect(resolveRestrictedReserveAccounts([])).toEqual([2940]);
    expect(resolveOtherFinancialIncomeAccount([])).toBe(8600);
    expect(resolveFxAccount([])).toBe(8500);
    expect(resolveSecuritiesIncomeAccount([])).toBe(8330);
    expect(resolveSecuritiesExpenseAccount([])).toBe(8335);
  });
});
