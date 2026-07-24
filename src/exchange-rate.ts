import { roundTo } from "./money.js";

// A branded exchange-rate type, kept deliberately SEPARATE from cents. An FX
// rate is a multiplier between currencies, not a monetary amount — it is never
// expressed in cents and must never be "cents-ified". Rates keep more precision
// than money (6 decimals, matching what most APIs accept and Wise's published
// precision), which is exactly why they cannot share the cent representation.

declare const EXCHANGE_RATE_BRAND: unique symbol;

/** A positive currency-conversion multiplier, rounded to rate precision. */
export type ExchangeRate = number & { readonly [EXCHANGE_RATE_BRAND]: true };

/** Rate precision (decimals). Distinct from money's 2-decimal cent precision. */
export const EXCHANGE_RATE_DECIMALS = 6;

/**
 * Checked construction of an `ExchangeRate`. Rejects non-finite and
 * non-positive values (a rate must be a usable multiplier); rounds to rate
 * precision via the canonical `roundTo`.
 */
export function toExchangeRate(rate: number): ExchangeRate {
  if (typeof rate !== "number" || Number.isNaN(rate)) {
    throw new Error("toExchangeRate received NaN — indicates a bug in the caller");
  }
  if (!Number.isFinite(rate)) {
    throw new Error("toExchangeRate received a non-finite value — indicates a bug in the caller");
  }
  if (rate <= 0) {
    throw new Error("toExchangeRate received a non-positive rate — a rate must be a positive multiplier");
  }
  return roundTo(rate, EXCHANGE_RATE_DECIMALS) as ExchangeRate;
}
