import type { Account, AccountDimension, PurchaseInvoiceItem } from "./types/api.js";

export interface AccountValidationTarget {
  id: number;
  label: string;
}

export function validateAccounts(
  accounts: Account[],
  targets: AccountValidationTarget[],
): string[] {
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const seen = new Set<string>();
  const errors: string[] = [];

  for (const target of targets) {
    const key = `${target.id}:${target.label}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const account = accountMap.get(target.id);
    if (!account) {
      errors.push(
        `${target.label} ${target.id} not found in chart of accounts. ` +
        `Activate it in e-arveldaja: Seaded → Kontoplaan → find account ${target.id} and enable it.`
      );
      continue;
    }

    if (!account.is_valid) {
      errors.push(
        `${target.label} ${target.id} (${account.name_est}) is inactive. ` +
        `Activate it in e-arveldaja: Seaded → Kontoplaan → ${account.name_est} → mark as active.`
      );
    }
  }

  return errors;
}

/**
 * Ensure purchase invoice items have `purchase_accounts_dimensions_id` when
 * the target account requires dimensions. Auto-fills when the account has
 * exactly one active dimension. Returns an array of error strings (empty = all OK).
 * Items are mutated in place when auto-filling.
 */
export function validateItemDimensions(
  items: PurchaseInvoiceItem[],
  accounts: Account[],
  accountDimensions: AccountDimension[],
): string[] {
  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const errors: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const accountId = item.purchase_accounts_id;
    if (accountId === undefined) continue;

    const account = accountMap.get(accountId);
    if (!account?.allows_dimensions) continue;

    if (item.purchase_accounts_dimensions_id !== undefined && item.purchase_accounts_dimensions_id !== null) continue;

    // Account requires a dimension but none was provided
    const dims = accountDimensions.filter(d => d.id !== undefined && d.accounts_id === accountId && !d.is_deleted);

    if (dims.length === 1) {
      // Auto-fill the only available dimension
      item.purchase_accounts_dimensions_id = dims[0]!.id!;
      continue;
    }

    const dimLabels = dims.map(d => `${d.id} (${d.title_est})`);
    errors.push(
      `Item ${i + 1} "${item.custom_title}": account ${accountId} (${account.name_est}) has dimensions (sub-accounts) — ` +
      `purchase_accounts_dimensions_id is required. ` +
      (dimLabels.length > 0
        ? `Available dimensions: ${dimLabels.join(", ")}.`
        : `Use list_account_dimensions to find valid dimension IDs.`)
    );
  }

  return errors;
}
