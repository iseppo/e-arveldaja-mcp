import type { Journal, Transaction } from "../types/api.js";
import type { BankAccountLookups } from "../tools/inter-account-utils.js";
import { counterpartyIbanOf, hasUnverifiableCamtMarker } from "../banking/reconciliation/inter-account-matcher.js";
import { sameCompanyIdentity } from "../company-name.js";
import { bankTransactionDirection } from "../bank-transaction-direction.js";
import { sameAmountToTheCent } from "../banking/reconciliation/match-score.js";
import { provenBankDirection } from "../bank-transaction-journal-direction.js";
import { findRegistrationJournal } from "../banking/receipt-ledger-check.js";
import {
  bookedAmountForWiseRow,
  bookedCurrencyForWiseRow,
  isPositiveSafeInteger,
  isWiseCounterpartyName,
  sourceDirectionForWiseDirection,
  wiseDate,
} from "./preflight.js";
import { journalLabelledWithWiseId, wiseLegAmountNetOfFee, withinOneDay } from "./projection.js";
import type { WiseCounterpartBasis, WiseRow, WiseTransferReview } from "./types.js";

// PURE per-row counterpart detection for Wise transfer rows. Evidence is the
// other own banks' already-stored bank transactions (typically CAMT-imported,
// CONFIRMED or PROJECT): same amount, ±1 day, the opposite proven direction,
// and an own-transfer indicator (the Wise IBAN, the company's own name, or Wise
// as the counterparty). The explicit inter_account_dimension_id, or the single
// other bank, is only a fallback: it never overrides contrary evidence. A false
// hold is acceptable, a false create or confirm is not, so anything uncertain
// holds. No MCP/HTTP/fs/audit/env.

export type { WiseCounterpartBasis };
export type WiseCounterpartHoldCode = "wise_transfer_counterpart_conflict" | "wise_transfer_dimensions_unverified";

export interface WiseCounterpartHold {
  readonly code: WiseCounterpartHoldCode;
  readonly candidate_dimension_ids: number[];
  readonly evidence_transaction_ids: number[];
}

export type WiseCounterpartResolution =
  | { readonly dim: number; readonly basis: WiseCounterpartBasis }
  | { readonly hold: WiseCounterpartHold };

export interface WiseCounterpartInput {
  /** The Wise transfer rows to resolve (hinted rows). */
  readonly rows: readonly WiseRow[];
  /** Every row of the parsed statement (any status): competing Wise movements. */
  readonly allRows: readonly WiseRow[];
  readonly wiseDim: number;
  /** Configured bank dimensions other than Wise. */
  readonly otherDims: ReadonlySet<number>;
  /** Non-void stored bank transactions. */
  readonly existingTx: readonly Transaction[];
  readonly journals: readonly Journal[];
  readonly lookups: BankAccountLookups;
  readonly companyLegalName: string | undefined;
  /** inter_account_dimension_id as passed; a value that is not another
   * configured bank account counts as absent, and disables the single-bank
   * fallback, so its rows hold unless evidence resolves them. */
  readonly explicit: unknown;
}

type CandidateClass = "strong" | "weak" | "uncertain";

interface Candidate {
  readonly tx: Transaction;
  readonly dim: number;
  readonly cls: CandidateClass;
}

const WISE_TRANSFER_COUNTERPART_CONFLICT_REASON = (dims: readonly number[]) =>
  `Own-account evidence points to bank account(s) ${dims.join(", ")} for this transfer, not to the selected/only one. The row is not imported. Re-run without inter_account_dimension_id (or with ${dims.length === 1 ? dims[0] : "the right one"}) if ${dims.length === 1 ? dims[0] : "one of them"} is right; if several banks show evidence, book it with the owner.`;
const WISE_TRANSFER_COUNTERPART_UNVERIFIED_REASON =
  "No own-account evidence shows which own bank account this Wise transfer goes to or from (an imported transaction of that bank with the Wise IBAN, the company's own name or Wise as counterparty, the same amount, within one day), and several are configured. The row is not imported. Pass inter_account_dimension_id, or import the other bank's statement first, then re-run the preview.";

/** The review a counterpart hold carries: the held row's only review. */
export function wiseCounterpartHoldReview(
  row: WiseRow,
  hold: WiseCounterpartHold,
  sourceVerified: boolean,
  targetVerified: boolean,
): WiseTransferReview {
  return {
    wise_id: row.id,
    code: hold.code,
    reason: hold.code === "wise_transfer_counterpart_conflict"
      ? WISE_TRANSFER_COUNTERPART_CONFLICT_REASON(hold.candidate_dimension_ids)
      : WISE_TRANSFER_COUNTERPART_UNVERIFIED_REASON,
    source_verified: sourceVerified,
    target_verified: targetVerified,
    approval_required: false,
    counterpart_candidate_dimension_ids: hold.candidate_dimension_ids,
    ...(hold.evidence_transaction_ids.length > 0 ? { evidence_transaction_ids: hold.evidence_transaction_ids } : {}),
  };
}

function rowDate(row: WiseRow): string {
  return wiseDate(row.finishedOn || row.createdOn);
}

/** Gross and, with a same-currency fee, net-of-fee amounts of a row. */
function rowAmounts(row: WiseRow): number[] {
  const gross = bookedAmountForWiseRow(row);
  const net = wiseLegAmountNetOfFee(row, gross);
  return net === undefined ? [gross] : [gross, net];
}

const sortedIds = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((left, right) => left - right);

export function resolveWiseRowCounterparts(input: WiseCounterpartInput): Map<WiseRow, WiseCounterpartResolution> {
  const { rows, allRows, wiseDim, otherDims, existingTx, journals, lookups, companyLegalName, explicit } = input;
  const result = new Map<WiseRow, WiseCounterpartResolution>();
  // A Wise-only company has no counterpart to find: its rows keep the
  // unresolved classification (created unconfirmed with their review).
  if (otherDims.size === 0) return result;

  const explicitDim = isPositiveSafeInteger(explicit) && otherDims.has(explicit) ? explicit : undefined;
  const fallback = explicitDim ?? (explicit === undefined && otherDims.size === 1 ? [...otherDims][0] : undefined);
  const fallbackBasis: WiseCounterpartBasis = explicitDim !== undefined ? "explicit" : "only_other_bank";

  const touchesWise = (journal: Journal) =>
    (journal.postings ?? []).some(posting => !posting.is_deleted && posting.accounts_dimensions_id === wiseDim);

  const classify = (row: WiseRow, tx: Transaction): CandidateClass | undefined => {
    const dim = tx.accounts_dimensions_id;
    if (typeof dim !== "number" || !otherDims.has(dim) || tx.id === undefined || typeof tx.amount !== "number") return undefined;
    if (!withinOneDay(tx.date, rowDate(row))) return undefined;
    // A transfer to (or from) another own account is not this Wise movement.
    const iban = counterpartyIbanOf(tx);
    const ibanDims = iban === "" ? undefined : lookups.ownIbanToDimension.get(iban);
    if (ibanDims !== undefined && !ibanDims.has(wiseDim)) return undefined;
    // A confirmed row whose registration journal does not touch the Wise
    // account books another movement.
    const registration = findRegistrationJournal(journals, tx.id);
    if (tx.status === "CONFIRMED" && registration.length > 0 && !registration.some(touchesWise)) return undefined;

    // Amount: usable only in EUR or with a numeric base amount; a foreign
    // amount without a base is never compared with EUR (uncertain at most).
    const amounts = rowAmounts(row);
    const txCurrency = (tx.cl_currencies_id ?? "EUR").toUpperCase();
    const usableEur = txCurrency === "EUR" ? tx.amount : typeof tx.base_amount === "number" ? tx.base_amount : undefined;
    let usableAmount: boolean;
    if (bookedCurrencyForWiseRow(row) === "EUR") {
      if (usableEur !== undefined) {
        if (!amounts.some(amount => sameAmountToTheCent(usableEur, amount))) return undefined;
        usableAmount = true;
      } else {
        if (!amounts.some(amount => sameAmountToTheCent(tx.amount!, amount))) return undefined;
        usableAmount = false;
      }
    } else {
      if (txCurrency !== bookedCurrencyForWiseRow(row) || !amounts.some(amount => sameAmountToTheCent(tx.amount!, amount))) return undefined;
      usableAmount = false;
    }

    // Direction: the signed marker or the confirmed ledger side; a CAMT
    // marker whose signature does not verify proves nothing.
    const direction = hasUnverifiableCamtMarker(tx)
      ? undefined
      : provenBankDirection(tx, journals, lookups.dimensionToAccountsId.get(dim));
    const opposite = sourceDirectionForWiseDirection(row.direction) === "IN" ? "outgoing" : "incoming";
    if (direction !== undefined && direction !== opposite) return undefined;

    const dateReadable = /^\d{4}-\d{2}-\d{2}/.test(tx.date ?? "");
    if (!usableAmount || direction === undefined || !dateReadable) return "uncertain";
    const indicator = ibanDims?.has(wiseDim) === true ||
      sameCompanyIdentity(tx.bank_account_name, companyLegalName) ||
      isWiseCounterpartyName(tx.bank_account_name);
    return indicator ? "strong" : "weak";
  };

  // One-to-one attribution: a strong candidate that another Wise movement
  // (another statement row, or a stored Wise-account row that is not this
  // row's own leg) could equally be is demoted to uncertain, unless its
  // registration journal is labelled with this row's Wise ID.
  const contested = (row: WiseRow, tx: Transaction): boolean => {
    const currency = (tx.cl_currencies_id ?? "EUR").toUpperCase();
    const eur = currency === "EUR" ? tx.amount! : tx.base_amount!;
    const rowDirection = sourceDirectionForWiseDirection(row.direction);
    if (allRows.some(other => other.rowIndex !== row.rowIndex &&
      sourceDirectionForWiseDirection(other.direction) === rowDirection &&
      withinOneDay(rowDate(other), tx.date) &&
      rowAmounts(other).some(amount => sameAmountToTheCent(amount, eur)))) return true;
    const ownLeg = (tag: string) => [`WISE:${row.id}`, `WISE:FEE:${row.id}`].some(own => tag === own || tag.startsWith(`${own}:`));
    return existingTx.some(stored => {
      if (stored.accounts_dimensions_id !== wiseDim || typeof stored.amount !== "number") return false;
      if (ownLeg(stored.description?.split(" ")[0] ?? "")) return false;
      if (!sameAmountToTheCent(stored.amount, eur) &&
        !(typeof stored.base_amount === "number" && sameAmountToTheCent(stored.base_amount, eur))) return false;
      if (!withinOneDay(stored.date, tx.date)) return false;
      const storedDirection = bankTransactionDirection(stored);
      return storedDirection === "unknown" || storedDirection === (rowDirection === "IN" ? "incoming" : "outgoing");
    });
  };
  const authoritative = (row: WiseRow, tx: Transaction): boolean =>
    findRegistrationJournal(journals, tx.id!).some(journal => journalLabelledWithWiseId(journal, row.id));

  for (const row of rows) {
    const candidates: Candidate[] = existingTx.flatMap((tx): Candidate[] => {
      let cls = classify(row, tx);
      if (cls === undefined) return [];
      if (cls === "strong" && !authoritative(row, tx) && contested(row, tx)) cls = "uncertain";
      return [{ tx, dim: tx.accounts_dimensions_id!, cls }];
    });
    const strong = candidates.filter(candidate => candidate.cls === "strong");
    const others = candidates.filter(candidate => candidate.cls !== "strong");
    const strongDims = sortedIds(strong.map(candidate => candidate.dim));
    const otherEvidenceDims = sortedIds(others.map(candidate => candidate.dim));
    const hold = (code: WiseCounterpartHoldCode, dims: number[], evidence: Candidate[]): WiseCounterpartResolution => ({
      hold: { code, candidate_dimension_ids: dims, evidence_transaction_ids: sortedIds(evidence.map(candidate => candidate.tx.id!)) },
    });

    if (strongDims.length === 1) {
      const [dim] = strongDims as [number];
      result.set(row, explicitDim === undefined || explicitDim === dim
        ? { dim, basis: "evidence" }
        : hold("wise_transfer_counterpart_conflict", strongDims, strong));
    } else if (strongDims.length >= 2) {
      result.set(row, hold("wise_transfer_counterpart_conflict", strongDims, strong));
    } else if (fallback !== undefined) {
      result.set(row, otherEvidenceDims.every(dim => dim === fallback)
        ? { dim: fallback, basis: fallbackBasis }
        : hold("wise_transfer_counterpart_conflict", sortedIds([...otherEvidenceDims, fallback]), others));
    } else {
      result.set(row, hold("wise_transfer_dimensions_unverified", sortedIds(otherDims), others));
    }
  }
  return result;
}
