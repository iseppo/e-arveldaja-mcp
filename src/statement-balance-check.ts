import type { ApiContext } from "./tools/crud-tools.js";
import type { Transaction } from "./types/api.js";
import { roundMoney } from "./money.js";
import { listAccountDimensionPostings } from "./account-postings.js";
import { loadOpeningBalanceJournal } from "./opening-balance-journal.js";
import { bankTransactionDirection } from "./bank-transaction-direction.js";
import { isProjectTransaction } from "./transaction-status.js";

// LOCKED: exceeds the known ~0.03 EUR Wise drift with headroom (decision 4).
export const STATEMENT_BALANCE_TOLERANCE_EUR = 0.10;

export interface StatementBalanceCheck {
  dimension_id: number;
  statement_closing_balance: number;
  balance_date: string;
  booked_balance: number;
  unconfirmed_amount: number;
  expected_balance: number;
  difference: number;
  within_tolerance: boolean;
  tolerance: number;
  warnings: string[];
}

/**
 * Advisory reconciliation of a bank statement's closing balance against the
 * ledger. `booked_balance` folds the opening balances plus all confirmed
 * postings on the bank GL account (filtered to the statement's dimension,
 * D-account signed = debit − credit) up to the balance date;
 * `unconfirmed_amount` adds freshly-imported but not-yet-confirmed (PROJECT)
 * transactions in that dimension, which have no journal yet. The statement's
 * CLBD should therefore equal `booked + unconfirmed`. Tolerance-based only —
 * never blocks. `DBIT` direction means the statement balance is negative.
 */
export async function checkStatementClosingBalance(
  api: ApiContext,
  input: {
    dimensionId: number;
    accountId: number;
    closing: { amount: number; direction?: "CRDT" | "DBIT"; date?: string; currency?: string };
    fallbackDate: string;
  },
  opts?: { tolerance?: number },
): Promise<StatementBalanceCheck> {
  const tolerance = opts?.tolerance ?? STATEMENT_BALANCE_TOLERANCE_EUR;
  const balanceDate = input.closing.date ?? input.fallbackDate;
  const statementClosing = roundMoney(
    input.closing.direction === "DBIT" ? -Math.abs(input.closing.amount) : input.closing.amount,
  );

  // Booked side: opening fold + confirmed postings on the account, filtered to
  // the dimension, D-account signed, raw-accumulated then rounded once.
  const opening = await loadOpeningBalanceJournal(api);
  const journals = await api.journals.listAllWithPostings();
  const allJournals = opening ? [opening.journal, ...journals] : journals;
  const rows = listAccountDimensionPostings(allJournals, input.accountId, { dateTo: balanceDate })
    .filter(row => row.accounts_dimensions_id === input.dimensionId);
  let bookedRaw = 0;
  for (const row of rows) {
    bookedRaw += row.type === "D" ? row.amount : -row.amount;
  }
  const bookedBalance = roundMoney(bookedRaw);

  // Unconfirmed side: signed sum (incoming +, outgoing −) of non-void PROJECT
  // transactions in the dimension dated on or before the balance date.
  const transactions = (await api.transactions.listAll()) as Transaction[];
  let unconfirmedRaw = 0;
  for (const tx of transactions) {
    if (!isProjectTransaction(tx)) continue;
    if (tx.accounts_dimensions_id !== input.dimensionId) continue;
    if (tx.date > balanceDate) continue;
    const amount = tx.base_amount ?? tx.amount;
    const direction = bankTransactionDirection(tx);
    if (direction === "incoming") unconfirmedRaw += amount;
    else if (direction === "outgoing") unconfirmedRaw -= amount;
  }
  const unconfirmedAmount = roundMoney(unconfirmedRaw);

  const expectedBalance = roundMoney(bookedBalance + unconfirmedAmount);
  const difference = roundMoney(expectedBalance - statementClosing);
  const withinTolerance = Math.abs(difference) <= tolerance;

  const warnings: string[] = [];
  if (!withinTolerance) {
    const currency = input.closing.currency ? ` ${input.closing.currency}` : "";
    warnings.push(
      `Statement closing balance ${statementClosing.toFixed(2)}${currency} does not match the expected ledger ` +
      `balance ${expectedBalance.toFixed(2)} (booked ${bookedBalance.toFixed(2)} + unconfirmed ${unconfirmedAmount.toFixed(2)}); ` +
      `difference ${difference.toFixed(2)} exceeds the ${tolerance.toFixed(2)} EUR tolerance. ` +
      `Review the ${input.dimensionId} dimension for missing, duplicated, or misdated entries.`,
    );
  }

  return {
    dimension_id: input.dimensionId,
    statement_closing_balance: statementClosing,
    balance_date: balanceDate,
    booked_balance: bookedBalance,
    unconfirmed_amount: unconfirmedAmount,
    expected_balance: expectedBalance,
    difference,
    within_tolerance: withinTolerance,
    tolerance,
    warnings,
  };
}
