import { roundMoney } from "./money.js";

// Branded SAFE-INTEGER cents for float-epsilon-free monetary COMPARISON and
// IDENTITY (duplicate keys, reconciliation, CAMT fingerprints, closing-balance
// tolerances). This is NOT a currency wire type: API payloads, response bodies,
// and display stay in euros. Cents exist only so that "are these two euro
// amounts equal / within N cents?" is decided by exact integer arithmetic
// instead of IEEE-754 float subtraction.
//
// Cents are a `number` behind a brand — NEVER a `bigint`. A safe integer cent
// value covers ±90 071 992 547 409 EUR, far beyond any real ledger figure, so
// no bigint is ever needed and none may reach JSON / `toMcpJson`.
//
// Rounding is NOT redefined here: `toCents` builds on `money.ts` `roundMoney`,
// the single canonical euro rounding, so cents and euro rounding can never
// drift.

declare const CENTS_BRAND: unique symbol;

/** A monetary amount expressed as a safe-integer number of cents. */
export type Cents = number & { readonly [CENTS_BRAND]: true };

/** ±0.01 EUR expressed exactly as cents. */
export const ONE_CENT = 1;
/** ±0.10 EUR expressed exactly as cents (the CAMT closing-balance tolerance). */
export const TEN_CENTS = 10;

function assertFinite(euros: number, fn: string): void {
  if (typeof euros !== "number" || Number.isNaN(euros)) {
    throw new Error(`${fn} received NaN — indicates a bug in the caller`);
  }
  if (!Number.isFinite(euros)) {
    throw new Error(`${fn} received a non-finite value — indicates a bug in the caller`);
  }
}

/**
 * Convert a euro amount to integer cents, using the canonical `roundMoney` so a
 * float-fuzzy input (0.1 + 0.2, 1.005) lands on the same cent the rest of the
 * system would round it to. Rejects non-finite inputs and any result that is
 * not a safe integer (so the branded value is always exact). This is the
 * conversion the comparison/identity sites use — it is deliberately lenient
 * about sub-cent noise because that is exactly what `roundMoney` exists to
 * absorb.
 */
export function toCents(euros: number): Cents {
  assertFinite(euros, "toCents");
  const cents = Math.round(roundMoney(euros) * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new Error("toCents produced a value outside the safe-integer cent range");
  }
  return cents as Cents;
}

/**
 * Strict conversion for a euro amount that is ASSERTED to already carry no more
 * than cent precision (e.g. a value read back from storage that must be whole
 * cents). Rejects non-finite, unsafe-integer, AND excess-precision (sub-cent)
 * inputs rather than silently rounding them away. Use `toCents` when the input
 * may legitimately need rounding.
 */
export function exactCents(euros: number): Cents {
  assertFinite(euros, "exactCents");
  const scaled = euros * 100;
  const nearest = Math.round(scaled);
  if (!Number.isSafeInteger(nearest)) {
    throw new Error("exactCents produced a value outside the safe-integer cent range");
  }
  // Float noise from a legitimate cent value (e.g. 12.34 * 100 = 1234.0000000002)
  // stays far under this bound; a genuine sub-cent amount (12.345 → 1234.5) does
  // not. Tightened enough to catch a third significant decimal, loose enough to
  // ignore representation error.
  if (Math.abs(scaled - nearest) > 1e-4) {
    throw new Error("exactCents received a value with more than cent precision");
  }
  return nearest as Cents;
}

/** Convert integer cents back to a euro `number` for emission/display. */
export function fromCents(cents: Cents): number {
  return roundMoney((cents as number) / 100);
}

/**
 * Canonical amount component for an INTERNAL duplicate/identity key: the exact
 * integer-cents string (e.g. `"1234"`). Float-epsilon-free by construction, so
 * two amounts collide in a key iff they are equal to the cent. Not for emission
 * — wire/display amounts stay euros.
 */
export function centsKey(euros: number): string {
  return String(toCents(euros) as number);
}

/** Exact equality of two cent amounts. */
export function centsEqual(a: Cents, b: Cents): boolean {
  return (a as number) === (b as number);
}

/** Sign of `a - b` in cents: -1, 0, or 1. */
export function compareCents(a: Cents, b: Cents): -1 | 0 | 1 {
  const left = a as number;
  const right = b as number;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when `a` and `b` are within `toleranceCents` (inclusive) of each other. */
export function centsWithinTolerance(a: Cents, b: Cents, toleranceCents: number): boolean {
  return Math.abs((a as number) - (b as number)) <= toleranceCents;
}

/**
 * True when two EURO amounts are within `toleranceCents` (inclusive), decided by
 * exact integer cents rather than float subtraction. Convenience over
 * `centsWithinTolerance(toCents(a), toCents(b), …)` for the migrated comparison
 * sites.
 */
export function eurosWithinTolerance(aEur: number, bEur: number, toleranceCents: number): boolean {
  return centsWithinTolerance(toCents(aEur), toCents(bEur), toleranceCents);
}
