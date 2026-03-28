import type { Account, Journal, Posting, Transaction, BankAccount } from "../types/api.js";

/** Create a test Account with sensible defaults. */
export function makeAccount(
  id: number,
  balance_type: "D" | "C" | string,
  account_type_est: string,
  name_est = "Account",
  name_eng = name_est,
  overrides: Partial<Account> = {},
): Account {
  return {
    id,
    balance_type,
    account_type_est,
    account_type_eng: account_type_est,
    name_est,
    name_eng,
    is_valid: true,
    allows_deactivation: false,
    is_vat_account: false,
    is_fixed_asset: false,
    transaction_in_bindable: false,
    transaction_out_bindable: false,
    cl_account_groups: [],
    default_disabled: false,
    ...overrides,
  };
}

/** Create a test Posting. */
export function makePosting(
  accounts_id: number,
  type: "D" | "C",
  amount: number,
  base_amount?: number,
  overrides: Partial<Posting> = {},
): Posting {
  return {
    accounts_id,
    type,
    amount,
    ...(base_amount !== undefined && { base_amount }),
    ...overrides,
  };
}

/** Create a test Journal entry with sensible defaults. */
export function makeJournal(
  effective_date: string,
  postings: Posting[],
  overrides: Partial<Journal> = {},
): Journal {
  return {
    effective_date,
    registered: true,
    postings,
    ...overrides,
  };
}

/** Create a test Transaction with sensible defaults. */
export function makeTransaction(
  overrides: Partial<Transaction> & Pick<Transaction, "amount" | "date">,
): Transaction {
  return {
    accounts_dimensions_id: 100,
    type: "C",
    cl_currencies_id: "EUR",
    status: "PROJECT",
    ...overrides,
  } as Transaction;
}

/** Create a test BankAccount with sensible defaults. */
export function makeBankAccount(
  overrides: Partial<BankAccount> & Pick<BankAccount, "id">,
): BankAccount {
  return {
    accounts_id: 1020,
    is_deleted: false,
    ...overrides,
  } as BankAccount;
}
