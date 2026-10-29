import type { Journal, Transaction } from "../types/api.js";
import type { BankAccountLookups } from "../tools/inter-account-utils.js";
import { counterpartyIbanOf, hasUnverifiableCamtMarker } from "../banking/reconciliation/inter-account-matcher.js";
import { sameCompanyIdentity } from "../company-name.js";
import { bankTransactionDirection } from "../bank-transaction-direction.js";
import { sameAmountToTheCent } from "../banking/reconciliation/match-score.js";
import { journalBankDirection, provenBankDirection } from "../bank-transaction-journal-direction.js";
import { findRegistrationJournal } from "../banking/receipt-ledger-check.js";
import {
  bookedCurrencyForWiseRow,
  isPositiveSafeInteger,
  isWiseCounterpartyName,
  sourceDirectionForWiseDirection,
  wiseRowAmounts,
  wiseRowDate,
} from "./preflight.js";
import {
  dimensionNetEurCents,
  journalLabelledWithWiseId,
  knownWiseLabelsFor,
  labelledWithOtherWiseId,
  matchWiseLegTag,
  sortedUniqueIds,
  withinOneDay,
} from "./projection.js";
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
type WiseCounterpartHoldCode = "wise_transfer_counterpart_conflict" | "wise_transfer_dimensions_unverified";

interface WiseCounterpartHold {
  readonly code: WiseCounterpartHoldCode;
  readonly candidate_dimension_ids: number[];
  readonly evidence_transaction_ids: number[];
  /** Conflict with the explicit / only other bank account: that account
   * (evidence points elsewhere). */
  readonly selected_dimension_id?: number;
  /** Some evidence was demoted because several Wise movements could be it. */
  readonly contested?: true;
  /** selected_dimension_id is the row's counterpart_overrides choice. */
  readonly selected_by_override?: true;
}

type WiseCounterpartResolution =
  | {
      readonly dim: number;
      readonly basis: WiseCounterpartBasis;
      /** A fallback resolved over non-strong (weak, uncertain or contested)
       * evidence on that same bank: the banks it was on. */
      readonly otherEvidenceDims?: readonly number[];
    }
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
  /** counterpart_overrides: Wise ID → the own bank account the owner picked.
   * It decides only among the banks with strong own-account evidence; a pick
   * the evidence does not point to holds the row (conflict); a row without
   * strong evidence ignores it. */
  readonly overrides?: ReadonlyMap<string, number>;
}

type CandidateClass = "strong" | "weak" | "uncertain";

interface Candidate {
  readonly tx: Transaction;
  readonly dim: number;
  readonly cls: CandidateClass;
  readonly contested?: true;
}

const WISE_TRANSFER_COUNTERPART_CONFLICT_REASON = (hold: WiseCounterpartHold) => {
  const selected = hold.selected_dimension_id;
  if (selected === undefined) {
    return `Own-account evidence for this transfer (evidence_transaction_ids) points to several bank accounts (${hold.candidate_dimension_ids.join(", ")}). The row is not imported. Show the owner the evidence bank rows: only when the owner confirms which bank account this transfer goes to or from, re-run with counterpart_overrides [{ wise_id, dimension_id }] naming one of them; otherwise book it with the owner.`;
  }
  const evidence = hold.candidate_dimension_ids.filter(dim => dim !== selected);
  if (hold.selected_by_override === true) {
    return `The counterpart_overrides choice for this transfer, bank account ${selected}, is not one the own-account evidence (evidence_transaction_ids) points to: ${evidence.join(", ")}. The row is not imported. counterpart_overrides can only pick an evidenced bank account; correct the choice with the owner or book the row with the owner.`;
  }
  return `Own-account evidence for this transfer (evidence_transaction_ids) points to bank account(s) ${evidence.join(", ")}, not to ${selected} (the selected inter_account_dimension_id or the only other bank account). The row is not imported. If the owner confirms ${evidence.length === 1 ? evidence[0] : "one of them"} is right, re-run with inter_account_dimension_id set to it (evidence on another bank still holds the row); otherwise book it with the owner.`;
};
const WISE_TRANSFER_COUNTERPART_UNVERIFIED_REASON =
  "No own-account evidence shows which own bank account this Wise transfer goes to or from (an imported transaction of that bank with the Wise IBAN, the company's own name or Wise as counterparty, the same amount, within one day), and several are configured. The row is not imported. Pass inter_account_dimension_id, or import the other bank's statement first, then re-run the preview.";
const WISE_TRANSFER_COUNTERPART_CONTESTED_REASON =
  "Bank row(s) on another own bank may be this transfer (evidence_transaction_ids), but several Wise transfers could match the same bank rows, so they do not show which one this is, and several bank accounts are configured. The row is not imported. Ask the owner which own bank account it goes to or from and pass it as inter_account_dimension_id, then re-run the preview.";
const WISE_TRANSFER_COUNTERPART_INCONCLUSIVE_REASON =
  "Bank row(s) on another own bank may be this transfer (evidence_transaction_ids), but their amount, currency, direction or own-transfer marking cannot be proven, and several bank accounts are configured. The row is not imported. Ask the owner which own bank account it goes to or from and pass it as inter_account_dimension_id, then re-run the preview.";

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
      ? WISE_TRANSFER_COUNTERPART_CONFLICT_REASON(hold)
      : hold.contested === true
        ? WISE_TRANSFER_COUNTERPART_CONTESTED_REASON
        : hold.evidence_transaction_ids.length > 0
          ? WISE_TRANSFER_COUNTERPART_INCONCLUSIVE_REASON
        : WISE_TRANSFER_COUNTERPART_UNVERIFIED_REASON,
    source_verified: sourceVerified,
    target_verified: targetVerified,
    approval_required: false,
    counterpart_candidate_dimension_ids: hold.candidate_dimension_ids,
    ...(hold.evidence_transaction_ids.length > 0 ? { evidence_transaction_ids: hold.evidence_transaction_ids } : {}),
  };
}


export function resolveWiseRowCounterparts(input: WiseCounterpartInput): Map<WiseRow, WiseCounterpartResolution> {
  const { rows, allRows, wiseDim, otherDims, existingTx, journals, lookups, companyLegalName, explicit, overrides } = input;
  const result = new Map<WiseRow, WiseCounterpartResolution>();
  // A Wise-only company has no counterpart to find: its rows keep the
  // unresolved classification (created unconfirmed with their review).
  if (otherDims.size === 0) return result;

  const explicitDim = isPositiveSafeInteger(explicit) && otherDims.has(explicit) ? explicit : undefined;
  const fallback = explicitDim ?? (explicit === undefined && otherDims.size === 1 ? [...otherDims][0] : undefined);
  const fallbackBasis: WiseCounterpartBasis = explicitDim !== undefined ? "explicit" : "only_other_bank";

  const wiseLabels = knownWiseLabelsFor(allRows, existingTx);
  // A stored tag naming this row's own main or fee leg (exact ID, or the ID
  // with a generated split-leg suffix).
  const ownLeg = (row: WiseRow, tag: string) =>
    [`WISE:${row.id}`, `WISE:FEE:${row.id}`].some(own => matchWiseLegTag(tag, own) !== undefined);

  const touchesWise = (journal: Journal) =>
    (journal.postings ?? []).some(posting => !posting.is_deleted && posting.accounts_dimensions_id === wiseDim);

  // The candidate class of `tx` for `row`, with the registration journals of
  // `tx` it was judged on.
  const classify = (row: WiseRow, tx: Transaction): { cls: CandidateClass; registration: Journal[] } | undefined => {
    const dim = tx.accounts_dimensions_id;
    if (typeof dim !== "number" || !otherDims.has(dim) || tx.id === undefined || typeof tx.amount !== "number") return undefined;
    if (!withinOneDay(tx.date, wiseRowDate(row))) return undefined;
    // A bank row already attributed to another Wise transfer (its own WISE:
    // tag, or a registration journal labelled with another Wise ID) is that
    // transfer's evidence, never this row's.
    const tag = tx.description?.split(" ")[0] ?? "";
    if (tag.startsWith("WISE:") && !ownLeg(row, tag)) return undefined;
    const registration = findRegistrationJournal(journals, tx.id);
    if (registration.some(journal => labelledWithOtherWiseId(journal, row, wiseLabels))) return undefined;
    // A transfer to (or from) another own account is not this Wise movement.
    const iban = counterpartyIbanOf(tx);
    const ibanDims = iban === "" ? undefined : lookups.ownIbanToDimension.get(iban);
    if (ibanDims !== undefined && !ibanDims.has(wiseDim)) return undefined;
    // So is a transfer to an own account that has no dimension.
    if (iban !== "" && lookups.ownIbansWithoutDimension.has(iban)) return undefined;
    // A confirmed row whose registration journal does not touch the Wise
    // account books another movement.
    if (tx.status === "CONFIRMED" && registration.length > 0 && !registration.some(touchesWise)) return undefined;

    // Amount: usable only in EUR or with a numeric base amount; a foreign
    // amount without a base is never compared with EUR (uncertain at most).
    const amounts = wiseRowAmounts(row);
    // A confirmed row's registration journal shows what it booked on Wise:
    // a Wise side moving another amount is a different movement (no
    // evidence); one that cannot be compared (foreign row, no EUR value, no
    // side) proves nothing (uncertain at most). A confirmed row whose
    // registration journal is not in the snapshot proves nothing either.
    let wiseSideProven = true;
    if (tx.status === "CONFIRMED" && registration.length === 0) {
      wiseSideProven = false;
    } else if (tx.status === "CONFIRMED") {
      const nets = registration.map(journal => dimensionNetEurCents(journal, wiseDim));
      if (bookedCurrencyForWiseRow(row) !== "EUR" || nets.some(net => net === undefined)) {
        wiseSideProven = false;
      } else {
        const wiseNet = nets.reduce<number>((sum, net) => sum + net!, 0);
        const sign = sourceDirectionForWiseDirection(row.direction) === "IN" ? 1 : -1;
        if (!amounts.some(amount => Math.round(amount * 100) * sign === wiseNet)) return undefined;
      }
    }
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

    // Direction: the signed marker or the confirmed ledger side. A CAMT
    // marker whose signature does not verify proves nothing (legacy markers
    // were signed over the stored type, which the API reads back as "C"), but
    // the registration journal of a confirmed row still proves its side.
    const bankAccountsId = lookups.dimensionToAccountsId.get(dim);
    const direction = hasUnverifiableCamtMarker(tx)
      ? journalBankDirection(tx, journals, bankAccountsId)
      : provenBankDirection(tx, journals, bankAccountsId);
    const opposite = sourceDirectionForWiseDirection(row.direction) === "IN" ? "outgoing" : "incoming";
    if (direction !== undefined && direction !== opposite) return undefined;

    const dateReadable = /^\d{4}-\d{2}-\d{2}/.test(tx.date ?? "");
    if (!usableAmount || direction === undefined || !dateReadable || !wiseSideProven) return { cls: "uncertain", registration };
    const indicator = ibanDims?.has(wiseDim) === true ||
      sameCompanyIdentity(tx.bank_account_name, companyLegalName) ||
      isWiseCounterpartyName(tx.bank_account_name);
    return { cls: indicator ? "strong" : "weak", registration };
  };

  // One-to-one attribution: a strong candidate that another Wise movement
  // (another statement row, or a stored Wise-account row that is not this
  // row's own leg) could equally be is demoted to uncertain, unless its
  // registration journal is labelled with this row's Wise ID.
  const contested = (row: WiseRow, tx: Transaction): boolean => {
    const currency = (tx.cl_currencies_id ?? "EUR").toUpperCase();
    const eur = currency === "EUR" ? tx.amount! : tx.base_amount!;
    const rowDirection = sourceDirectionForWiseDirection(row.direction);
    // Another row's amounts are comparable with EUR only when it books EUR.
    if (allRows.some(other => other.rowIndex !== row.rowIndex &&
      bookedCurrencyForWiseRow(other) === "EUR" &&
      sourceDirectionForWiseDirection(other.direction) === rowDirection &&
      withinOneDay(wiseRowDate(other), tx.date) &&
      wiseRowAmounts(other).some(amount => sameAmountToTheCent(amount, eur)))) return true;
    return existingTx.some(stored => {
      if (stored.accounts_dimensions_id !== wiseDim || typeof stored.amount !== "number") return false;
      if (ownLeg(row, stored.description?.split(" ")[0] ?? "")) return false;
      if (!sameAmountToTheCent(stored.amount, eur) &&
        !(typeof stored.base_amount === "number" && sameAmountToTheCent(stored.base_amount, eur))) return false;
      if (!withinOneDay(stored.date, tx.date)) return false;
      const storedDirection = bankTransactionDirection(stored);
      return storedDirection === "unknown" || storedDirection === (rowDirection === "IN" ? "incoming" : "outgoing");
    });
  };
  const authoritative = (row: WiseRow, registration: readonly Journal[]): boolean =>
    registration.some(journal => journalLabelledWithWiseId(journal, row.id));

  for (const row of rows) {
    const candidates: Candidate[] = existingTx.flatMap((tx): Candidate[] => {
      const classified = classify(row, tx);
      if (classified === undefined) return [];
      const { cls, registration } = classified;
      if (cls === "strong" && !authoritative(row, registration) && contested(row, tx)) {
        return [{ tx, dim: tx.accounts_dimensions_id!, cls: "uncertain", contested: true }];
      }
      return [{ tx, dim: tx.accounts_dimensions_id!, cls }];
    });
    const strong = candidates.filter(candidate => candidate.cls === "strong");
    const others = candidates.filter(candidate => candidate.cls !== "strong");
    const strongDims = sortedUniqueIds(strong.map(candidate => candidate.dim));
    const otherEvidenceDims = sortedUniqueIds(others.map(candidate => candidate.dim));
    const hold = (code: WiseCounterpartHoldCode, dims: number[], evidence: Candidate[], selected?: number,
      byOverride?: true): WiseCounterpartResolution => ({
      hold: {
        code,
        candidate_dimension_ids: dims,
        evidence_transaction_ids: sortedUniqueIds(evidence.map(candidate => candidate.tx.id!)),
        ...(selected !== undefined ? { selected_dimension_id: selected } : {}),
        ...(evidence.some(candidate => candidate.contested) ? { contested: true as const } : {}),
        ...(byOverride ? { selected_by_override: true as const } : {}),
      },
    });

    // The owner's pick decides among the strongly evidenced banks, before the
    // explicit id; a pick outside them is a conflict, never a fallback.
    const override = overrides?.get(row.id);
    if (override !== undefined && strongDims.length > 0) {
      result.set(row, strongDims.includes(override)
        ? { dim: override, basis: "owner_selected" }
        : hold("wise_transfer_counterpart_conflict", sortedUniqueIds(strongDims, [override]), strong, override, true));
    } else if (strongDims.length === 1) {
      const [dim] = strongDims as [number];
      result.set(row, explicitDim === undefined || explicitDim === dim
        ? { dim, basis: "evidence" }
        : hold("wise_transfer_counterpart_conflict", strongDims, strong, explicitDim));
    } else if (strongDims.length >= 2) {
      result.set(row, hold("wise_transfer_counterpart_conflict", strongDims, strong));
    } else if (fallback !== undefined) {
      result.set(row, otherEvidenceDims.every(dim => dim === fallback)
        ? { dim: fallback, basis: fallbackBasis, ...(otherEvidenceDims.length > 0 ? { otherEvidenceDims } : {}) }
        : hold("wise_transfer_counterpart_conflict", sortedUniqueIds(otherEvidenceDims, [fallback]), others, fallback));
    } else {
      result.set(row, hold("wise_transfer_dimensions_unverified", sortedUniqueIds(otherDims), others));
    }
  }
  return result;
}
