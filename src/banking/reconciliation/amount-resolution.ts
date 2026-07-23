import type { Transaction } from "../../types/api.js";
import { roundMoney } from "../../money.js";
import { comparableTransactionAmount } from "./match-score.js";

// ---------------------------------------------------------------------------
// One-sided EUR amount resolution, partial-payment / cross-currency REJECTION.
// PURE: imports only ../../money and the sibling match-score module. The heart
// of the authoritative one-sided EUR amount checks (H10). No MCP/HTTP/fs/env.
// ---------------------------------------------------------------------------

export type OneSidedEurAmountErrorCode =
  | "one_sided_amount_invalid"
  | "one_sided_currency_invalid"
  | "one_sided_base_amount_invalid"
  | "one_sided_currency_rate_invalid"
  | "one_sided_eur_amount_missing"
  | "one_sided_eur_amount_conflict";

const ONE_SIDED_EUR_AMOUNT_ERROR_REASONS: Record<OneSidedEurAmountErrorCode, string> = {
  one_sided_amount_invalid: "The one-sided transfer amount must be a finite positive number.",
  one_sided_currency_invalid: "The one-sided transfer currency must be an explicit three-letter ASCII code.",
  one_sided_base_amount_invalid: "The one-sided transfer base amount must be a finite positive number when provided.",
  one_sided_currency_rate_invalid: "The one-sided transfer currency rate must be finite and positive and produce a finite positive EUR amount when used.",
  one_sided_eur_amount_missing: "The foreign one-sided transfer has no base amount or currency rate for an authoritative EUR amount.",
  one_sided_eur_amount_conflict: "The one-sided transfer EUR amount evidence conflicts by more than one cent.",
};

export type OneSidedEurAmountResolution =
  | { ok: true; nominalAmount: number; currency: string; amountEur: number }
  | { ok: false; code: OneSidedEurAmountErrorCode; reason: string };

function oneSidedEurAmountFailure(code: OneSidedEurAmountErrorCode): OneSidedEurAmountResolution {
  return { ok: false, code, reason: ONE_SIDED_EUR_AMOUNT_ERROR_REASONS[code] };
}

function amountsDifferByMoreThanOneCent(left: number, right: number): boolean {
  const maxCentSafeAmount = Number.MAX_SAFE_INTEGER / 100;
  if (Math.abs(left) <= maxCentSafeAmount && Math.abs(right) <= maxCentSafeAmount) {
    return Math.abs(Math.round(left * 100) - Math.round(right * 100)) > 1;
  }
  return left !== right;
}

export function resolveOneSidedTransferAmount(tx: Transaction): OneSidedEurAmountResolution {
  const runtime = tx as unknown as Record<string, unknown>;
  const nominalValue = runtime.amount;
  if (typeof nominalValue !== "number" || !Number.isFinite(nominalValue) || nominalValue <= 0) {
    return oneSidedEurAmountFailure("one_sided_amount_invalid");
  }

  const currencyValue = runtime.cl_currencies_id;
  if (typeof currencyValue !== "string") {
    return oneSidedEurAmountFailure("one_sided_currency_invalid");
  }
  const currency = currencyValue.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return oneSidedEurAmountFailure("one_sided_currency_invalid");
  }

  const baseValue = runtime.base_amount;
  const hasBase = baseValue !== undefined && baseValue !== null;
  let roundedBase: number | undefined;
  if (hasBase) {
    if (typeof baseValue !== "number" || !Number.isFinite(baseValue) || baseValue <= 0) {
      return oneSidedEurAmountFailure("one_sided_base_amount_invalid");
    }
    roundedBase = roundMoney(baseValue);
    if (!Number.isFinite(roundedBase) || roundedBase <= 0) {
      return oneSidedEurAmountFailure("one_sided_base_amount_invalid");
    }
  }

  const rateValue = runtime.currency_rate;
  const hasRate = rateValue !== undefined && rateValue !== null;
  let roundedRateAmount: number | undefined;
  if (hasRate) {
    if (typeof rateValue !== "number" || !Number.isFinite(rateValue) || rateValue <= 0) {
      return oneSidedEurAmountFailure("one_sided_currency_rate_invalid");
    }
    const rateAmount = nominalValue * rateValue;
    if (!Number.isFinite(rateAmount) || rateAmount <= 0) {
      return oneSidedEurAmountFailure("one_sided_currency_rate_invalid");
    }
    roundedRateAmount = roundMoney(rateAmount);
    if (!Number.isFinite(roundedRateAmount) || roundedRateAmount <= 0) {
      return oneSidedEurAmountFailure("one_sided_currency_rate_invalid");
    }
  }

  const nominalAmount = nominalValue;
  const roundedNominal = roundMoney(nominalAmount);
  if (currency === "EUR") {
    if (roundedNominal <= 0) {
      return oneSidedEurAmountFailure("one_sided_amount_invalid");
    }
    if (roundedBase !== undefined) {
      if (amountsDifferByMoreThanOneCent(roundedNominal, roundedBase)) {
        return oneSidedEurAmountFailure("one_sided_eur_amount_conflict");
      }
    }
    return { ok: true, nominalAmount, currency, amountEur: roundedNominal };
  }

  if (roundedBase === undefined && roundedRateAmount === undefined) {
    return oneSidedEurAmountFailure("one_sided_eur_amount_missing");
  }
  if (roundedBase !== undefined && roundedRateAmount !== undefined) {
    if (amountsDifferByMoreThanOneCent(roundedBase, roundedRateAmount)) {
      return oneSidedEurAmountFailure("one_sided_eur_amount_conflict");
    }
  }

  return {
    ok: true,
    nominalAmount,
    currency,
    amountEur: roundedBase ?? roundedRateAmount!,
  };
}

export function hasMeaningfulComparableAmount(tx: Transaction): boolean {
  return Math.abs(comparableTransactionAmount(tx) - roundMoney(tx.amount)) >= 0.01;
}

export function transactionCurrency(tx: Transaction): string {
  const raw = (tx as unknown as Record<string, unknown>).cl_currencies_id;
  return typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : "EUR";
}
