import type { Journal, Transaction } from "../../types/api.js";
import type { BookingGuard, InterAccountQuery, InterAccountResolution } from "../../booking-guard.js";
import { bankTransactionDirection } from "../../bank-transaction-direction.js";
import { normalizeCompanyName, sameCompanyIdentity } from "../../company-name.js";
import { toUtcDay } from "../../date-utils.js";
import { normalizeIban } from "../../resolution/bank-account-resolution.js";
import { REF_NUMBER_MAX_LENGTH } from "../../ref-number.js";
import { comparableTransactionAmount, sameAmountToTheCent } from "./match-score.js";
import { hasMeaningfulComparableAmount } from "./amount-resolution.js";
import {
  extractCamtDescriptionMetadata,
  isCamtCounterpartyIbanOmitted,
  isTrustedCamtDescriptionMetadata,
  journalDocumentReferenceKeys,
  normalizeOptionalReference,
  storedBankAccountNo,
  storedBankReferenceLookupKey,
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
  return normalizeIban(storedBankAccountNo(tx)) ?? "";
}

/**
 * True when a row's empty {@link counterpartyIbanOf} means "known external"
 * (a trusted `x=i` CAMT marker), not "no IBAN": never a name-based own-origin
 * or own-transfer fallback.
 */
export { isCamtCounterpartyIbanOmitted };

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
 * The bank references to match an existing inter-account journal with: the
 * direct `bank_ref_number`, else the reference of a checksum-verified CAMT
 * marker (MCP-CAMT rows store it only there), else `ref_number`. A verified
 * marker that kept only the reference hash (a reference over the marker cap)
 * yields the document numbers of every live registered journal whose
 * reference keys (with or without "BANK:") include its lookup key — each
 * literal alias, so a draft or stale alias never hides the booking journal.
 */
export function transferReferencesOf(tx: Transaction, journals: readonly Journal[] = []): string[] {
  const direct = normalizeOptionalReference(tx.bank_ref_number ?? undefined);
  if (direct) return [direct];
  const metadata = extractCamtDescriptionMetadata(tx.description);
  if (isTrustedCamtDescriptionMetadata(tx, metadata)) {
    const markerReference = normalizeOptionalReference(metadata.bank_ref_number);
    if (markerReference) return [markerReference];
    const key = storedBankReferenceLookupKey(tx);
    const aliases = key
      ? [...new Set(journals
          .filter(j => !j.is_deleted && j.registered === true && journalDocumentReferenceKeys(j.document_number).includes(key))
          .map(j => j.document_number!))]
      : [];
    if (aliases.length > 0) return aliases;
  }
  return tx.ref_number ? [tx.ref_number] : [];
}

/** The first of {@link transferReferencesOf}, for recording an in-run journal. */
export function transferReferenceOf(tx: Transaction, journals: readonly Journal[] = []): string | undefined {
  return transferReferencesOf(tx, journals)[0];
}

/**
 * The payment instruction id (Refs/InstrId) of an outgoing CAMT row, read only
 * from a checksum-verified marker whose direction is DBIT; else undefined.
 */
export function camtInstructionIdOf(tx: Transaction): string | undefined {
  const metadata = extractCamtDescriptionMetadata(tx.description);
  if (metadata.instruction_id === undefined || metadata.source_direction !== "DBIT") return undefined;
  return isTrustedCamtDescriptionMetadata(tx, metadata) ? metadata.instruction_id : undefined;
}

/**
 * The trailing "/<digits>" id of an incoming Wise main row's full reference
 * (an own-account top-up from LHV reads "<COMPANY>/<InstrId>"). The full
 * reference is `ref_number` when under the cap; a capped one counts only when
 * the write boundary wove the full reference in front of the direction marker
 * (it then ends the description text). Anything else yields undefined.
 */
export function wiseReferenceInstructionIdOf(tx: Transaction): string | undefined {
  const description = tx.description ?? "";
  if (!/^WISE:(?!FEE:)\S/i.test(description) || bankTransactionDirection(tx) !== "incoming") return undefined;
  const ref = tx.ref_number?.trim() ?? "";
  if (ref === "") return undefined;
  let full = ref;
  if (ref.length >= REF_NUMBER_MAX_LENGTH) {
    const head = description.replace(/\s*\[source_direction=IN\]\s*$/i, "");
    const start = head.lastIndexOf(` ${ref}`);
    if (start < 0) return undefined;
    full = head.slice(start + 1);
  }
  return full.match(/\/(\d{1,10})$/)?.[1];
}

/**
 * Resolve a transfer against its candidate references: the first reference
 * that matches a journal wins (probed without consuming); else a reference
 * that hits a journal it cannot be booked against (any outcome but `none`)
 * blocks booking; with neither, the first reference's outcome stands.
 */
export function resolveWithReferences<R extends { status: string }>(
  references: readonly string[],
  resolve: (reference: string | undefined, consume: boolean) => R,
  consume: boolean,
): R {
  if (references.length > 1) {
    const probes = references.map(reference => ({ reference, outcome: resolve(reference, false) }));
    const matching = probes.find(probe => probe.outcome.status === "matched");
    if (matching !== undefined) return resolve(matching.reference, consume);
    const blocking = probes.find(probe => probe.outcome.status !== "none");
    if (blocking !== undefined) return blocking.outcome;
  }
  return resolve(references[0], consume);
}

/**
 * A journal's signed EUR net (debit positive, in cents) on one account
 * dimension, or `undefined` when a live foreign posting has no EUR base amount
 * (not EUR-comparable). Shared by reconcile's `journalMovesTransfer` and the
 * analyze path's own-account cover check.
 */
export function journalEurNetCents(journal: Journal, dimensionId: number | null | undefined): number | undefined {
  const live = (journal.postings ?? []).filter(posting => !posting.is_deleted);
  if (live.some(posting => posting.base_amount == null &&
    (posting.cl_currencies_id ?? journal.cl_currencies_id ?? "EUR").toUpperCase() !== "EUR")) return undefined;
  return live
    .filter(posting => posting.accounts_dimensions_id === dimensionId)
    .reduce((sum, posting) => sum + (posting.type === "D" ? 1 : -1) * Math.round((posting.base_amount ?? posting.amount) * 100), 0);
}

/**
 * Whether a journal books this row's transfer: its legs on the row's account
 * move `amountEur` in the row's signed direction (either way when the row is
 * unsigned) and its legs on the target account move the opposite way (a fee
 * may make that amount differ), in EUR (no foreign posting without a base
 * amount).
 */
export function journalMovesTransfer(journal: Journal | undefined, tx: Transaction, targetDim: number, amountEur: number): boolean {
  if (!journal) return false;
  const cents = Math.round(Math.abs(amountEur) * 100);
  const direction = bankTransactionDirection(tx);
  const sides = direction === "incoming" ? [1] : direction === "outgoing" ? [-1] : [1, -1];
  const own = journalEurNetCents(journal, tx.accounts_dimensions_id);
  const target = journalEurNetCents(journal, targetDim);
  if (own === undefined || target === undefined) return false;
  return sides.some(side => own === side * cents && target * side < 0);
}

/** A Lane B outcome, or a matched snapshot journal that does not move the row's transfer. */
export type TransferResolution = InterAccountResolution | { status: "uncovered"; journal_id: number };

/**
 * Lane B keys are direction-blind: a snapshot journal matched by reference or
 * key stands in for the row only when {@link journalMovesTransfer}; otherwise
 * the outcome is `uncovered` (review) and nothing is consumed.
 */
export function resolveTransfer(
  guard: Pick<BookingGuard, "resolveInterAccount" | "journals">,
  query: InterAccountQuery, tx: Transaction, consume: boolean,
): TransferResolution {
  const probe = guard.resolveInterAccount(query, { consume: false });
  if (probe.status === "matched" && probe.pool === "snapshot" &&
    !journalMovesTransfer(guard.journals.find(journal => journal.id === probe.journal_id), tx, query.targetDim, query.amount)) {
    return { status: "uncovered", journal_id: probe.journal_id };
  }
  return consume ? guard.resolveInterAccount(query, { consume: true }) : probe;
}

export interface OneSidedInference {
  targetDimension?: number;
  confidence: number;
  reasons: string[];
  /** The own accounts behind a shared counterparty IBAN when no single target could be chosen. */
  ambiguousTargetDimensions?: number[];
  /** The row's counterparty IBAN is an own bank account without a booking dimension: review only. */
  unbookableOwnIban?: string;
}

/** The read-only account lookups + config the matcher closes over per run. */
export interface InterAccountMatchLookups {
  readonly ownIbanToDimension: Map<string, Set<number>>;
  readonly dimensionToIban: Map<number, string>;
  /** Own identifiers of accounts without a dimension (see BankAccountLookups). */
  readonly ownIbansWithoutDimension: ReadonlySet<string>;
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
  if (isCamtCounterpartyIbanOmitted(tx)) {
    const inference: OneSidedInference = { confidence: 0, reasons: [] };
    if (tx.id) cache.set(tx.id, inference);
    return inference;
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

  // The IBAN is provably one of the company's own bank accounts, but one without a
  // dimension: the transfer cannot be booked to it, and the company-name fallback
  // below must never redirect it to a different own account. Review only.
  // (An unregistered IBAN under the company's name keeps the name fallback: that is
  // also how a top-up to a payment provider's pooled IBAN looks.)
  if (counterpartyIban && lookups.ownIbansWithoutDimension.has(counterpartyIban)) {
    const result: OneSidedInference = {
      confidence: 0, reasons: ["counterparty_iban_own_account_without_dimension"], unbookableOwnIban: counterpartyIban,
    };
    if (tx.id) cache.set(tx.id, result);
    return result;
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
