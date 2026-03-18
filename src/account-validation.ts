import type { Account } from "./types/api.js";

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
