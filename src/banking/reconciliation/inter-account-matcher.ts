import type { Transaction } from "../../types/api.js";
import { normalizeCompanyName, sameCompanyIdentity } from "../../company-name.js";
import { toUtcDay } from "../../tools/inter-account-utils.js";
import { comparableTransactionAmount, sameAmountToTheCent } from "./match-score.js";
import { hasMeaningfulComparableAmount } from "./amount-resolution.js";
import {
  extractCamtDescriptionMetadata,
  isTrustedCamtDescriptionMetadata,
  normalizeOptionalReference,
  storedBankAccountNo,
} from "../../camt/duplicate-identity.js";

// ---------------------------------------------------------------------------
// Reciprocal-transfer TRANSACTION pairing. PURE: the reciprocal/one-sided
// detection helpers, lifted out of the handler scope so the loop state
// (`maxGap`, `target_accounts_dimensions_id`, the account lookups, the
// inference cache) is passed in as explicit parameters. This is distinct from
// inter-account-utils.ts JOURNAL dedup (imported by the executor, never
// duplicated here) — this module pairs two unconfirmed transactions.
// No MCP/HTTP/fs/audit/env.
// ---------------------------------------------------------------------------

/**
 * The counterparty IBAN of a row: the direct `bank_account_no`, else the IBAN
 * of a checksum-verified CAMT marker (MCP-CAMT rows store it only there). A
 * marker whose `sig` fails verification yields "" — never trusted evidence.
 */
export function counterpartyIbanOf(tx: Transaction): string {
  return (storedBankAccountNo(tx) ?? "").trim().toUpperCase();
}

/**
 * True when the row carries a signed CAMT marker whose `sig` does not verify:
 * its statement identity (IBAN, direction) cannot be trusted, so reconciliation
 * must not act on it automatically. A marker without a `sig` is not CAMT-signed.
 */
export function hasUnverifiableCamtMarker(tx: Transaction): boolean {
  // Same line-break normalisation as the CAMT metadata parser: an encoded
  // newline (&#10; / &#xA;) before the marker must not hide it.
  const description = (tx.description ?? "").replace(/&#(?:10|x0*a);/gi, "\n");
  const marker = description.match(/(?:^|\n)\[e-arveldaja-mcp:camt\s+([^\]\r\n]+)\]\s*$/i)?.[1];
  if (marker === undefined || !/(?:^|\s)(?:entry_sig|sig|s)=/i.test(marker)) return false;
  return !isTrustedCamtDescriptionMetadata(tx);
}

/**
 * The bank reference used to match an existing inter-account journal: the
 * direct `bank_ref_number`, else the reference of a checksum-verified CAMT
 * marker (MCP-CAMT rows store it only there), else `ref_number`.
 */
export function transferReferenceOf(tx: Transaction): string | undefined {
  const direct = normalizeOptionalReference(tx.bank_ref_number ?? undefined);
  if (direct) return direct;
  const metadata = extractCamtDescriptionMetadata(tx.description);
  const markerReference = isTrustedCamtDescriptionMetadata(tx, metadata) ? normalizeOptionalReference(metadata.bank_ref_number) : undefined;
  return markerReference ?? tx.ref_number ?? undefined;
}

export interface OneSidedInference {
  targetDimension?: number;
  confidence: number;
  reasons: string[];
  /** The own accounts behind a shared counterparty IBAN when no single target could be chosen. */
  ambiguousTargetDimensions?: number[];
}

/** The read-only account lookups + config the matcher closes over per run. */
export interface InterAccountMatchLookups {
  readonly ownIbanToDimension: Map<string, Set<number>>;
  readonly dimensionToIban: Map<number, string>;
  readonly companyName: string;
  /** The company's raw registered name (with legal form), for {@link sameCompanyIdentity}. */
  readonly companyLegalName: string;
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
  const counterpartyIban = counterpartyIbanOf(tx);

  let targetDimension: number | undefined;
  let confidence = 0;
  const reasons: string[] = [];

  let ibanTargetAmbiguous = false;
  if (counterpartyIban && ownIbanToDimension.has(counterpartyIban)) {
    const ibanDims = [...ownIbanToDimension.get(counterpartyIban)!].filter(d => d !== tx.accounts_dimensions_id);
    if (ibanDims.length === 1) {
      targetDimension = ibanDims[0]!;
      confidence += 90;
      reasons.push("counterparty_iban_is_own_account");
    } else if (ibanDims.length > 1) {
      // The IBAN backs several own accounts (e.g. LHV multi-currency
      // sub-accounts): use the caller's target_accounts_dimensions_id when it is
      // one of them; otherwise no single target, so never auto-book — review.
      const targetAccountsDimensionsId = lookups.targetAccountsDimensionsId;
      if (targetAccountsDimensionsId !== undefined && ibanDims.includes(targetAccountsDimensionsId)) {
        targetDimension = targetAccountsDimensionsId;
        confidence += 90;
        reasons.push("counterparty_iban_is_own_account", "target_from_parameter");
      } else {
        ibanTargetAmbiguous = true;
        reasons.push("counterparty_iban_maps_to_multiple_own_accounts");
      }
    }
  }

  if (!targetDimension && !ibanTargetAmbiguous && companyName.length >= 4 && counterpartyName.length >= 4) {
    // Same name AND same legal form: a payer whose name merely contains the
    // company name ("Männipuu Client AS" vs "Männipuu OÜ"), a same-stem company
    // with another legal form ("Männipuu AS"), or the owner as a natural person
    // ("JAAN TAMM" vs "Jaan Tamm OÜ") is a third party.
    const nameMatch = sameCompanyIdentity(tx.bank_account_name, lookups.companyLegalName);
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
    ...(ibanTargetAmbiguous
      ? { ambiguousTargetDimensions: [...ownIbanToDimension.get(counterpartyIban)!].filter(d => d !== tx.accounts_dimensions_id) }
      : {}),
  };
  if (tx.id) {
    cache.set(tx.id, result);
  }
  return result;
}

/**
 * For a row with an unverifiable CAMT marker: the own-transfer inference its
 * UNTRUSTED marker IBAN or its name would give, or undefined when neither
 * points at an own account. Used only to report such a row for review
 * (`camt_marker_unverified`) — never to book, pair or delete it.
 */
export function unverifiedMarkerTransferClaim(
  tx: Transaction,
  lookups: InterAccountMatchLookups,
): OneSidedInference | undefined {
  // An empty or blank direct IBAN is missing: it must not hide the marker's claim.
  const claimedIban = normalizeOptionalReference(tx.bank_account_no ?? undefined) ??
    extractCamtDescriptionMetadata(tx.description).bank_account_no ?? null;
  const inference = inferOneSidedTransfer({ ...tx, bank_account_no: claimedIban }, lookups, new Map());
  return inference.confidence > 0 || inference.ambiguousTargetDimensions ? inference : undefined;
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
  // Exact integer cents, not float subtraction — see sameAmountToTheCent.
  const nominalAmountsMatch = sameAmountToTheCent(txA.amount, txB.amount);
  const comparableAmountsMatch = sameAmountToTheCent(txAComparableAmount, txBComparableAmount);
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
  const txACounterpartyIban = counterpartyIbanOf(txA);
  const txBCounterpartyIban = counterpartyIbanOf(txB);
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
