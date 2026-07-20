import type { ApiContext } from "./tools/crud-tools.js";
import type { Account, AccountDimension, Journal, Posting } from "./types/api.js";
import { readOpeningBalances, type StoredOpeningBalances } from "./opening-balance-store.js";

export interface OpeningBalanceJournal {
  journal: Journal;
  openingDate: string;
  unmappedCodes: string[];
  unmappedDimensions: string[];
}

function resolveDimensionId(dims: AccountDimension[], candidates: string[] | undefined): number | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  const exact = dims.filter(d => d.id !== undefined && candidates.includes(d.title_est));
  if (exact.length > 0) return exact.length === 1 ? exact[0]!.id : undefined; // ambiguous exact → caller warns
  const joined = candidates.join(" ");                 // distinctive title as substring
  const hits = dims.filter(d => d.id !== undefined && d.title_est && joined.includes(d.title_est));
  return hits.length === 1 ? hits[0]!.id : undefined;  // zero or ambiguous → caller warns
}

export function buildOpeningBalanceJournal(
  accounts: Account[],
  dimensions: AccountDimension[],
  stored: StoredOpeningBalances | null,
): OpeningBalanceJournal | null {
  if (!stored || !Array.isArray(stored.accounts) || stored.accounts.length === 0) return null;

  // Account.id doubles as the human-readable account number/code in this
  // codebase's chart-of-accounts model (see src/account-resolution.ts:
  // resolved constants like 2960 are compared against a.id directly) — the
  // API's Account type has no separate `code` field.
  const idByCode = new Map<string, number>();
  for (const a of accounts) idByCode.set(String(a.id), a.id);

  const dimsByAccount = new Map<number, AccountDimension[]>();
  for (const d of dimensions) {
    if (d.is_deleted || d.id === undefined) continue;
    const arr = dimsByAccount.get(d.accounts_id) ?? [];
    arr.push(d);
    dimsByAccount.set(d.accounts_id, arr);
  }

  const postings: Posting[] = [];
  const unmappedCodes: string[] = [];
  const unmappedDimensions: string[] = [];
  for (const acc of stored.accounts) {
    const accountsId = idByCode.get(acc.code);
    if (accountsId === undefined) { unmappedCodes.push(acc.code); continue; }

    const dims = dimsByAccount.get(accountsId) ?? [];
    let dimensionId: number | undefined;
    if (dims.length === 1) {
      dimensionId = dims[0]!.id;
    } else if (dims.length > 1) {
      dimensionId = resolveDimensionId(dims, acc.dimension);
      if (dimensionId === undefined) {
        unmappedDimensions.push(`${acc.code}: ${(acc.dimension ?? []).join(" | ") || "(no label)"}`);
      }
    }

    if (acc.debit !== 0) {
      postings.push({ accounts_id: accountsId, accounts_dimensions_id: dimensionId ?? null, type: "D", amount: acc.debit, base_amount: acc.debit, is_deleted: false });
    }
    if (acc.credit !== 0) {
      postings.push({ accounts_id: accountsId, accounts_dimensions_id: dimensionId ?? null, type: "C", amount: acc.credit, base_amount: acc.credit, is_deleted: false });
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

  return { journal, openingDate: stored.openingDate, unmappedCodes, unmappedDimensions };
}

export async function loadOpeningBalanceJournal(api: ApiContext): Promise<OpeningBalanceJournal | null> {
  const stored = readOpeningBalances();
  if (!stored || stored.accounts.length === 0) return null;
  const [accounts, dimensions] = await Promise.all([
    api.readonly.getAccounts(),
    api.readonly.getAccountDimensions(),
  ]);
  return buildOpeningBalanceJournal(accounts, dimensions, stored);
}
