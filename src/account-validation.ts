import type {
  Account,
  AccountDimension,
  Posting,
  PurchaseInvoiceItem,
  SaleInvoiceItem,
  TransactionDistribution,
} from "./types/api.js";

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

    if (account.is_valid === false) {
      errors.push(
        `${target.label} ${target.id} (${account.name_est}) is inactive. ` +
        `Activate it in e-arveldaja: Seaded → Kontoplaan → ${account.name_est} → mark as active.`
      );
    }
  }

  return errors;
}

interface DimensionFieldTarget {
  accountId?: number | null;
  dimensionId?: number | null;
  dimensionFieldLabel: string;
  itemLabel: string;
  onAutofill?: (dimensionId: number) => void;
  unsupportedWhenRequired?: boolean;
}

function describeAvailableDimensions(dimensions: AccountDimension[]): string {
  const dimLabels = dimensions.map(d => `${d.id} (${d.title_est})`);
  return dimLabels.length > 0
    ? `Available dimensions: ${dimLabels.join(", ")}.`
    : "Use list_account_dimensions to find valid dimension IDs.";
}

function validateDimensionTarget(
  target: DimensionFieldTarget,
  accountMap: Map<number, Account>,
  dimensionsByAccount: Map<number, AccountDimension[]>,
): string | null {
  const accountId = target.accountId;
  if (accountId === undefined || accountId === null) return null;

  const account = accountMap.get(accountId);
  if (!account || account.is_valid === false || !account.allows_dimensions) return null;

  const dimensions = dimensionsByAccount.get(accountId) ?? [];

  if (target.dimensionId !== undefined && target.dimensionId !== null) {
    const isValidDimension = dimensions.some(d => d.id === target.dimensionId);
    if (isValidDimension) return null;

    return (
      `${target.itemLabel}: ${target.dimensionFieldLabel} ${target.dimensionId} is not a valid dimension for ` +
      `account ${accountId} (${account.name_est}). ${describeAvailableDimensions(dimensions)}`
    );
  }

  if (target.unsupportedWhenRequired) {
    return (
      `${target.itemLabel}: account ${accountId} (${account.name_est}) has dimensions (sub-accounts), ` +
      `but this item type does not support ${target.dimensionFieldLabel}. ` +
      "Use a non-dimensional VAT account or update the accounting setup."
    );
  }

  if (target.onAutofill && dimensions.length === 1 && dimensions[0]?.id !== undefined) {
    target.onAutofill(dimensions[0].id);
    return null;
  }

  return (
    `${target.itemLabel}: account ${accountId} (${account.name_est}) has dimensions (sub-accounts) — ` +
    `${target.dimensionFieldLabel} is required. ${describeAvailableDimensions(dimensions)}`
  );
}

function createDimensionValidationState(accounts: Account[], accountDimensions: AccountDimension[]) {
  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const dimensionsByAccount = new Map<number, AccountDimension[]>();

  for (const dimension of accountDimensions) {
    if (dimension.id === undefined || dimension.is_deleted) continue;
    const dims = dimensionsByAccount.get(dimension.accounts_id) ?? [];
    dims.push(dimension);
    dimensionsByAccount.set(dimension.accounts_id, dims);
  }

  return { accountMap, dimensionsByAccount };
}

function validateReferencedAccounts(
  accounts: Account[],
  targets: Array<AccountValidationTarget | null | undefined>,
): string[] {
  return validateAccounts(
    accounts,
    targets.filter((target): target is AccountValidationTarget => target !== null && target !== undefined),
  );
}

/**
 * Ensure purchase invoice items have the required dimensions for both expense
 * and VAT accounts. Auto-fills a unique active dimension when possible.
 * Returns an array of error strings (empty = all OK). Items are mutated in
 * place when auto-filling.
 */
export function validateItemDimensions(
  items: PurchaseInvoiceItem[],
  accounts: Account[],
  accountDimensions: AccountDimension[],
): string[] {
  const { accountMap, dimensionsByAccount } = createDimensionValidationState(accounts, accountDimensions);
  // Use positional labels only — item.custom_title is OCR-seeded from
  // create_purchase_invoice_from_pdf and these error messages flow out via
  // toolError, which bypasses the MCP output wrap. The index is enough for
  // the operator to identify the failing row without interpolating untrusted
  // text into validation prose.
  const errors = validateReferencedAccounts(accounts, items.flatMap((item, index) => {
    const itemLabel = `Item ${index + 1}`;
    return [
      item.purchase_accounts_id === undefined ? null : { id: item.purchase_accounts_id, label: `${itemLabel} purchase account` },
      item.vat_accounts_id === undefined || item.vat_accounts_id === null ? null : { id: item.vat_accounts_id, label: `${itemLabel} VAT account` },
    ];
  }));

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const itemLabel = `Item ${i + 1}`;

    const purchaseAccountError = validateDimensionTarget({
      accountId: item.purchase_accounts_id,
      dimensionId: item.purchase_accounts_dimensions_id,
      dimensionFieldLabel: "purchase_accounts_dimensions_id",
      itemLabel,
      onAutofill: dimensionId => {
        item.purchase_accounts_dimensions_id = dimensionId;
      },
    }, accountMap, dimensionsByAccount);
    if (purchaseAccountError) errors.push(purchaseAccountError);

    const vatAccountError = validateDimensionTarget({
      accountId: item.vat_accounts_id,
      dimensionId: item.vat_accounts_dimensions_id,
      dimensionFieldLabel: "vat_accounts_dimensions_id",
      itemLabel,
      onAutofill: dimensionId => {
        item.vat_accounts_dimensions_id = dimensionId;
      },
    }, accountMap, dimensionsByAccount);
    if (vatAccountError) errors.push(vatAccountError);
  }

  return errors;
}

export function validateSaleInvoiceItemDimensions(
  items: SaleInvoiceItem[],
  accounts: Account[],
  accountDimensions: AccountDimension[],
): string[] {
  const { accountMap, dimensionsByAccount } = createDimensionValidationState(accounts, accountDimensions);
  const errors = validateReferencedAccounts(accounts, items.flatMap((item, index) => {
    const itemLabel = `Item ${index + 1} "${item.custom_title}"`;
    return [
      item.sale_accounts_id === undefined ? null : { id: item.sale_accounts_id, label: `${itemLabel} sale account` },
      item.vat_accounts_id === undefined || item.vat_accounts_id === null ? null : { id: item.vat_accounts_id, label: `${itemLabel} VAT account` },
    ];
  }));

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const itemLabel = `Item ${i + 1} "${item.custom_title}"`;

    const saleAccountError = validateDimensionTarget({
      accountId: item.sale_accounts_id,
      dimensionId: item.sale_accounts_dimensions_id,
      dimensionFieldLabel: "sale_accounts_dimensions_id",
      itemLabel,
      onAutofill: dimensionId => {
        item.sale_accounts_dimensions_id = dimensionId;
      },
    }, accountMap, dimensionsByAccount);
    if (saleAccountError) errors.push(saleAccountError);

    const vatAccountError = validateDimensionTarget({
      accountId: item.vat_accounts_id,
      itemLabel,
      dimensionFieldLabel: "vat_accounts_dimensions_id",
      unsupportedWhenRequired: true,
    }, accountMap, dimensionsByAccount);
    if (vatAccountError) errors.push(vatAccountError);
  }

  return errors;
}

export function validatePostingDimensions(
  postings: Posting[],
  accounts: Account[],
  accountDimensions: AccountDimension[],
): string[] {
  const { accountMap, dimensionsByAccount } = createDimensionValidationState(accounts, accountDimensions);
  const errors = validateReferencedAccounts(accounts, postings.map((posting, index) => ({
    id: posting.accounts_id,
    label: `Posting ${index + 1} account`,
  })));

  for (let i = 0; i < postings.length; i++) {
    const posting = postings[i]!;
    const postingError = validateDimensionTarget({
      accountId: posting.accounts_id,
      dimensionId: posting.accounts_dimensions_id,
      dimensionFieldLabel: "accounts_dimensions_id",
      itemLabel: `Posting ${i + 1}`,
      onAutofill: dimensionId => {
        posting.accounts_dimensions_id = dimensionId;
      },
    }, accountMap, dimensionsByAccount);
    if (postingError) errors.push(postingError);
  }

  return errors;
}

export function validateTransactionDistributionDimensions(
  distributions: TransactionDistribution[],
  accounts: Account[],
  accountDimensions: AccountDimension[],
): string[] {
  const { accountMap, dimensionsByAccount } = createDimensionValidationState(accounts, accountDimensions);
  const errors = validateReferencedAccounts(accounts, distributions.map((distribution, index) => {
    if (distribution.related_table !== "accounts" || distribution.related_id === undefined) return null;
    return {
      id: distribution.related_id,
      label: `Distribution ${index + 1} account`,
    };
  }));

  for (let i = 0; i < distributions.length; i++) {
    const distribution = distributions[i]!;
    if (distribution.related_table !== "accounts") continue;

    const distributionError = validateDimensionTarget({
      accountId: distribution.related_id,
      dimensionId: distribution.related_sub_id,
      dimensionFieldLabel: "related_sub_id",
      itemLabel: `Distribution ${i + 1}`,
      onAutofill: dimensionId => {
        distribution.related_sub_id = dimensionId;
      },
    }, accountMap, dimensionsByAccount);
    if (distributionError) errors.push(distributionError);
  }

  return errors;
}
