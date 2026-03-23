import type { AccountDimension, BankAccount, Journal } from "../types/api.js";

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

/**
 * Build a map from bidirectional "sourceDim|targetDim|amount|date" keys to journal IDs
 * by scanning confirmed journals that have exactly 2 bank account postings (one D, one C).
 * Keys are inserted in both directions so lookups succeed regardless of which side is checked.
 */
export function buildInterAccountJournalIndex(
  journals: Journal[],
  ownDimensionIds: Set<number>,
): Map<string, number> {
  const index = new Map<string, number>();
  for (const j of journals) {
    if (j.is_deleted || !j.registered || !j.postings) continue;
    const bankPostings = j.postings.filter(
      p => !p.is_deleted && p.accounts_dimensions_id && ownDimensionIds.has(p.accounts_dimensions_id),
    );
    if (bankPostings.length !== 2) continue;
    const [a, b] = bankPostings;
    if (!a || !b) continue;
    if (a.type === b.type) continue; // must be one D and one C
    const debit = a.type === "D" ? a : b;
    const credit = a.type === "C" ? a : b;
    const amount = Math.round(((debit.base_amount ?? debit.amount) as number) * 100) / 100;
    // Insert in both directions so we catch it regardless of which side we're checking from
    const key1 = `${credit.accounts_dimensions_id}|${debit.accounts_dimensions_id}|${amount}|${j.effective_date}`;
    const key2 = `${debit.accounts_dimensions_id}|${credit.accounts_dimensions_id}|${amount}|${j.effective_date}`;
    index.set(key1, j.id!);
    index.set(key2, j.id!);
  }
  return index;
}
