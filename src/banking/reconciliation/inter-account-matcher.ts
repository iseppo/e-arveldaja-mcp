import type { Transaction } from "../../types/api.js";
import { normalizeCompanyName } from "../../company-name.js";
import { toUtcDay } from "../../tools/inter-account-utils.js";
import { comparableTransactionAmount } from "./match-score.js";
import { hasMeaningfulComparableAmount } from "./amount-resolution.js";

// ---------------------------------------------------------------------------
// Reciprocal-transfer TRANSACTION pairing. PURE: the reciprocal/one-sided
// detection helpers, lifted out of the handler scope so the loop state
// (`maxGap`, `target_accounts_dimensions_id`, the account lookups, the
// inference cache) is passed in as explicit parameters. This is distinct from
// inter-account-utils.ts JOURNAL dedup (imported by the executor, never
// duplicated here) — this module pairs two unconfirmed transactions.
// No MCP/HTTP/fs/audit/env.
// ---------------------------------------------------------------------------

export interface OneSidedInference {
  targetDimension?: number;
  confidence: number;
  reasons: string[];
}

/** The read-only account lookups + config the matcher closes over per run. */
export interface InterAccountMatchLookups {
  readonly ownIbanToDimension: Map<string, number>;
  readonly dimensionToIban: Map<number, string>;
  readonly companyName: string;
  readonly targetAccountsDimensionsId: number | undefined;
}

export function inferOneSidedTransfer(
  tx: Transaction,
  lookups: InterAccountMatchLookups,
  cache: Map<number, OneSidedInference>,
): OneSidedInference {
  if (tx.id && cache.has(tx.id)) {
    return cache.get(tx.id)!;
  }

  const { ownIbanToDimension, dimensionToIban, companyName } = lookups;
  const counterpartyName = normalizeCompanyName(tx.bank_account_name ?? "");
  const counterpartyIban = (tx.bank_account_no ?? "").trim().toUpperCase();

  let targetDimension: number | undefined;
  let confidence = 0;
  const reasons: string[] = [];

  if (counterpartyIban && ownIbanToDimension.has(counterpartyIban)) {
    const ibanDim = ownIbanToDimension.get(counterpartyIban)!;
    if (ibanDim !== tx.accounts_dimensions_id) {
      targetDimension = ibanDim;
      confidence += 90;
      reasons.push("counterparty_iban_is_own_account");
    }
  }

  if (!targetDimension && companyName.length >= 4 && counterpartyName.length >= 4) {
    const nameMatch = counterpartyName.includes(companyName) || companyName.includes(counterpartyName);
    if (nameMatch) {
      confidence += 60;
      reasons.push("counterparty_name_matches_company");

      const otherDimensions = [...dimensionToIban.keys()].filter(d => d !== tx.accounts_dimensions_id);
      const targetAccountsDimensionsId = lookups.targetAccountsDimensionsId;
      if (targetAccountsDimensionsId && targetAccountsDimensionsId !== tx.accounts_dimensions_id && dimensionToIban.has(targetAccountsDimensionsId)) {
        targetDimension = targetAccountsDimensionsId;
        reasons.push("target_from_parameter");
      } else if (otherDimensions.length === 1) {
        targetDimension = otherDimensions[0]!;
        confidence += 20;
        reasons.push("only_one_other_account");
      }
    }
  }

  const result: OneSidedInference = {
    targetDimension,
    confidence: Math.min(confidence, 100),
    reasons,
  };
  if (tx.id) {
    cache.set(tx.id, result);
  }
  return result;
}

export function getTransferPairCompatibility(
  txA: Transaction,
  txB: Transaction,
  maxGap: number,
): {
  confidence: number;
  reasons: string[];
  txAComparableAmount: number;
  conflictingComparableAmounts: boolean;
} | undefined {
  const reasons: string[] = [];
  let confidence = 0;
  const txAComparableAmount = comparableTransactionAmount(txA);
  const txBComparableAmount = comparableTransactionAmount(txB);
  const nominalAmountsMatch = Math.abs(txA.amount - txB.amount) < 0.01;
  const comparableAmountsMatch = Math.abs(txAComparableAmount - txBComparableAmount) < 0.01;
  const hasMeaningfulComparableAmounts =
    hasMeaningfulComparableAmount(txA) ||
    hasMeaningfulComparableAmount(txB);
  const conflictingComparableAmounts =
    nominalAmountsMatch &&
    hasMeaningfulComparableAmounts &&
    !comparableAmountsMatch;

  if (nominalAmountsMatch) {
    if (!conflictingComparableAmounts) {
      confidence += 40;
      reasons.push("exact_amount");
    }
  } else if (comparableAmountsMatch && hasMeaningfulComparableAmounts) {
    confidence += 40;
    reasons.push("exact_base_amount");
  } else {
    return undefined;
  }

  // Pure-date UTC arithmetic via shared toUtcDay helper — stable
  // regardless of whether the input is YYYY-MM-DD or a full timestamp.
  const daysDiff = Math.abs((toUtcDay(txA.date) - toUtcDay(txB.date)) / 86_400_000);
  if (daysDiff === 0) {
    confidence += 20;
    reasons.push("same_date");
  } else if (daysDiff <= maxGap) {
    confidence += 10;
    reasons.push(`date_gap_${Math.round(daysDiff)}d`);
  } else {
    return undefined;
  }

  return {
    confidence,
    reasons,
    txAComparableAmount,
    conflictingComparableAmounts,
  };
}

export function hasReciprocalOwnIbanEvidence(
  txA: Transaction,
  txB: Transaction,
  dimensionToIban: Map<number, string>,
): boolean {
  const txACounterpartyIban = (txA.bank_account_no ?? "").trim().toUpperCase();
  const txBCounterpartyIban = (txB.bank_account_no ?? "").trim().toUpperCase();
  const txAAccountIban = dimensionToIban.get(txA.accounts_dimensions_id) ?? "";
  const txBAccountIban = dimensionToIban.get(txB.accounts_dimensions_id) ?? "";

  return Boolean(
    txACounterpartyIban &&
    txBCounterpartyIban &&
    txAAccountIban &&
    txBAccountIban &&
    txACounterpartyIban === txBAccountIban &&
    txBCounterpartyIban === txAAccountIban
  );
}

export function getSameTypeReciprocalEvidence(
  txA: Transaction,
  txB: Transaction,
  txAInference: OneSidedInference,
  txBInference: OneSidedInference,
  dimensionToIban: Map<number, string>,
): { confidenceBonus: number; reasons: string[] } | undefined {
  if (hasReciprocalOwnIbanEvidence(txA, txB, dimensionToIban)) {
    return {
      confidenceBonus: 40,
      reasons: ["same_type_reciprocal_own_iban"],
    };
  }

  const mutuallyStrongOneSidedInference =
    txAInference.confidence >= 80 &&
    txBInference.confidence >= 80;

  if (mutuallyStrongOneSidedInference) {
    return {
      confidenceBonus: 20,
      reasons: ["same_type_reciprocal_target_inference"],
    };
  }

  return undefined;
}
