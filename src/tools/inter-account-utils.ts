import type { AccountDimension, BankAccount, Journal } from "../types/api.js";
import { roundMoney } from "../money.js";

export interface BankAccountLookups {
  ownIbanToDimension: Map<string, number>;
  dimensionToIban: Map<number, string>;
  dimensionToTitle: Map<number, string>;
  dimensionToAccountsId: Map<number, number>;
  ownDimensionIds: Set<number>;
}

export function buildBankAccountLookups(
  bankAccounts: BankAccount[],
  accountDimensions: AccountDimension[],
): BankAccountLookups {
  const ownIbanToDimension = new Map<string, number>();
  const dimensionToIban = new Map<number, string>();
  const dimensionToTitle = new Map<number, string>();
  const dimensionToAccountsId = new Map<number, number>();
  for (const ba of bankAccounts) {
    const iban = (ba.iban_code ?? ba.account_no ?? "").trim().toUpperCase();
    if (iban && ba.accounts_dimensions_id) {
      ownIbanToDimension.set(iban, ba.accounts_dimensions_id);
      dimensionToIban.set(ba.accounts_dimensions_id, iban);
      dimensionToTitle.set(ba.accounts_dimensions_id, ba.account_name_est);
    }
  }
  for (const dim of accountDimensions) {
    if (dim.id && !dim.is_deleted) {
      dimensionToAccountsId.set(dim.id, dim.accounts_id);
    }
  }
  return {
    ownIbanToDimension,
    dimensionToIban,
    dimensionToTitle,
    dimensionToAccountsId,
    ownDimensionIds: new Set(dimensionToIban.keys()),
  };
}

export interface InterAccountJournalEntry {
  journal_id: number;
  document_number?: string | null;
}

function normalizeReference(ref?: string | null): string {
  return (ref ?? "").trim();
}

/**
 * Build a map from bidirectional "sourceDim|targetDim|amount|date" keys to arrays
 * of journal entries, scanning confirmed journals that have exactly 2 bank account
 * postings (one D, one C). Keys are inserted in both directions so lookups succeed
 * regardless of which side is checked.
 *
 * Values are **arrays** (not single journal IDs) because multiple unrelated
 * journals can legitimately share (sourceDim, targetDim, amount, date) — e.g.
 * two separate €500 LHV↔Wise transfers on the same day. Reference-based
 * disambiguation happens in `findMatchingJournal`.
 */
export function buildInterAccountJournalIndex(
  journals: Journal[],
  ownDimensionIds: Set<number>,
): Map<string, InterAccountJournalEntry[]> {
  const index = new Map<string, InterAccountJournalEntry[]>();
  for (const j of journals) {
    if (j.is_deleted || !j.registered || !j.postings) continue;
    const bankPostings = j.postings.filter(
      p => !p.is_deleted && p.accounts_dimensions_id && ownDimensionIds.has(p.accounts_dimensions_id),
    );
    if (bankPostings.length !== 2) continue;
    const [a, b] = bankPostings;
    if (!a || !b) continue;
    if (a.type === b.type) continue; // must be one D and one C
    if (j.id == null) continue;
    const debit = a.type === "D" ? a : b;
    const credit = a.type === "C" ? a : b;
    const rawAmount = debit.base_amount ?? debit.amount;
    if (rawAmount == null) continue;
    const amount = roundMoney(rawAmount);
    const entry: InterAccountJournalEntry = {
      journal_id: j.id,
      document_number: j.document_number,
    };
    // Insert in both directions so we catch it regardless of which side we're checking from
    const key1 = `${credit.accounts_dimensions_id}|${debit.accounts_dimensions_id}|${amount}|${j.effective_date}`;
    const key2 = `${debit.accounts_dimensions_id}|${credit.accounts_dimensions_id}|${amount}|${j.effective_date}`;
    for (const key of [key1, key2]) {
      const existing = index.get(key);
      if (existing) existing.push(entry);
      else index.set(key, [entry]);
    }
  }
  return index;
}

/**
 * Pick the best-matching journal from a key's candidate list, with optional
 * reference-number disambiguation.
 *
 * Semantics:
 * - If `referenceNumber` is given and a candidate's `document_number` matches →
 *   return that journal (exact match).
 * - If `referenceNumber` is given and ALL candidates have refs but none match →
 *   return `undefined` (this is a different transfer, not a duplicate).
 * - If `referenceNumber` is empty/missing, or some candidates have no ref →
 *   return any candidate (loose match, preserving pre-disambiguation behaviour).
 *
 * Prevents the false-positive where two unrelated same-day-same-amount
 * inter-account transfers suppress each other purely on amount+date+dims.
 */
export function findMatchingJournal(
  candidates: InterAccountJournalEntry[] | undefined,
  referenceNumber?: string | null,
): number | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  const ref = normalizeReference(referenceNumber);
  if (!ref) return candidates[0]!.journal_id;

  const exactMatch = candidates.find(c => normalizeReference(c.document_number) === ref);
  if (exactMatch) return exactMatch.journal_id;

  // If every candidate carries a reference and none match, this input is a
  // distinct transfer — do not dedup-suppress it.
  const allHaveRefs = candidates.every(c => normalizeReference(c.document_number).length > 0);
  if (allHaveRefs) return undefined;

  // At least one candidate has no reference → fall back to it (we can't prove
  // they're different, so preserve the old loose-match semantics).
  const refless = candidates.find(c => normalizeReference(c.document_number).length === 0);
  return refless?.journal_id;
}
