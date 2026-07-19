import type { ApiContext } from "./tools/crud-tools.js";
import type { Account, Journal, Posting } from "./types/api.js";
import { readOpeningBalances, type StoredOpeningBalances } from "./opening-balance-store.js";

export interface OpeningBalanceJournal {
  journal: Journal;
  openingDate: string;
  unmappedCodes: string[];
}

export function buildOpeningBalanceJournal(
  accounts: Account[],
  stored: StoredOpeningBalances | null,
): OpeningBalanceJournal | null {
  if (!stored || !Array.isArray(stored.accounts) || stored.accounts.length === 0) return null;

  // Account.id doubles as the human-readable account number/code in this
  // codebase's chart-of-accounts model (see src/account-resolution.ts:
  // resolved constants like 2960 are compared against a.id directly) — the
  // API's Account type has no separate `code` field.
  const idByCode = new Map<string, number>();
  for (const a of accounts) idByCode.set(String(a.id), a.id);

  const postings: Posting[] = [];
  const unmappedCodes: string[] = [];
  for (const acc of stored.accounts) {
    const accountsId = idByCode.get(acc.code);
    if (accountsId === undefined) { unmappedCodes.push(acc.code); continue; }
    if (acc.debit !== 0) {
      postings.push({ accounts_id: accountsId, type: "D", amount: acc.debit, base_amount: acc.debit, is_deleted: false });
    }
    if (acc.credit !== 0) {
      postings.push({ accounts_id: accountsId, type: "C", amount: acc.credit, base_amount: acc.credit, is_deleted: false });
    }
  }

  const journal: Journal = {
    id: -1,                              // sentinel: synthetic, never a real ledger id
    clients_id: null,
    title: "Algbilansi kanded (imported)",
    effective_date: stored.openingDate,
    registered: true,
    is_deleted: false,
    postings,
  };

  return { journal, openingDate: stored.openingDate, unmappedCodes };
}

export async function loadOpeningBalanceJournal(api: ApiContext): Promise<OpeningBalanceJournal | null> {
  const stored = readOpeningBalances();
  if (!stored) return null;
  const accounts = await api.readonly.getAccounts();
  return buildOpeningBalanceJournal(accounts, stored);
}
