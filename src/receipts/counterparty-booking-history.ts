import { normalizeCompanyName, sameCompanyIdentity } from "../company-name.js";
import { DEFAULT_ACCOUNTS_RECEIVABLE, DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { signedBankTransactionDirection } from "../bank-transaction-direction.js";
import { storedBankAccountNo } from "../camt/duplicate-identity.js";
import type { Journal, Transaction } from "../types/api.js";

// PURE: how confirmed bank rows of one counterparty were booked before. A row's
// treatment is the single contra line of its one registered TRANSACTION journal;
// its side comes from that journal's bank leg (the API reads every stored type
// back as "C"). Only the newest unbroken run of one treatment, at least
// MIN_STREAK long, becomes a suggestion, and it is review-only by contract.

const MIN_STREAK = 3;
const DEFAULT_INVOICE_LEDGER_ACCOUNTS: ReadonlySet<number> = new Set([DEFAULT_LIABILITY_ACCOUNT, DEFAULT_ACCOUNTS_RECEIVABLE]);

export type HistoryDirection = "incoming" | "outgoing";

interface Treatment {
  readonly account_id: number;
  readonly dimension_id: number | null;
}

interface HistoryRow {
  readonly id: number;
  readonly date: string;
  readonly name: string;
  readonly iban: string | undefined;
  /** undefined: the row breaks any streak it sits in. */
  readonly treatment: Treatment | undefined;
}

export interface CounterpartyBookingHistory {
  /** `${normalized name}\u0000${direction}` → rows sorted by date, then id. */
  readonly rows: ReadonlyMap<string, readonly HistoryRow[]>;
}

export interface CounterpartyHistoryQuery {
  readonly name: string | null | undefined;
  readonly iban?: string | null;
  readonly direction: HistoryDirection | "unknown";
}

export interface HistoryBreakdownEntry extends Treatment {
  readonly count: number;
}

export interface CounterpartyHistorySuggestion extends Treatment {
  readonly streak: number;
  readonly history_total: number;
  readonly latest_date: string;
  readonly breakdown: HistoryBreakdownEntry[];
}

export interface CounterpartyHistoryResult {
  /** Identity-compatible confirmed rows in this direction, across all own bank dimensions. */
  readonly history_total: number;
  readonly breakdown: HistoryBreakdownEntry[];
  readonly suggestion?: CounterpartyHistorySuggestion;
}

export function counterpartyHistoryKey(name: string | null | undefined): string {
  return normalizeCompanyName(name, { stripNonAlphanumeric: true });
}

function normalizedIban(value: string | null | undefined): string | undefined {
  const iban = (value ?? "").replace(/\s+/g, "").toUpperCase();
  return iban || undefined;
}

/** The row's direction and treatment, read from its single registered TRANSACTION journal. */
function readJournal(
  transaction: Transaction,
  joined: readonly Journal[],
  ownBankDimensionIds: ReadonlySet<number>,
  invoiceLedgerAccounts: ReadonlySet<number>,
): { direction?: HistoryDirection; treatment?: Treatment } {
  if (joined.length !== 1) return {};
  const postings = (joined[0]!.postings ?? []).filter((posting) => !posting.is_deleted);
  const bankLegs = postings.filter((posting) => posting.accounts_dimensions_id === transaction.accounts_dimensions_id);
  if (bankLegs.length !== 1 || (bankLegs[0]!.type !== "D" && bankLegs[0]!.type !== "C")) return {};
  const direction: HistoryDirection = bankLegs[0]!.type === "D" ? "incoming" : "outgoing";
  const contra = postings.filter((posting) => posting !== bankLegs[0]);
  if (contra.length !== 1) return { direction };
  const line = contra[0]!;
  const dimension = line.accounts_dimensions_id ?? null;
  if (invoiceLedgerAccounts.has(line.accounts_id)) return { direction };
  if (dimension !== null && ownBankDimensionIds.has(dimension)) return { direction };
  return { direction, treatment: { account_id: line.accounts_id, dimension_id: dimension } };
}

export function buildCounterpartyBookingHistory(input: {
  readonly transactions: readonly Transaction[];
  readonly journals: readonly Journal[];
  readonly ownBankDimensionIds: ReadonlySet<number>;
  readonly invoiceLedgerAccountIds?: ReadonlySet<number>;
}): CounterpartyBookingHistory {
  const invoiceLedgerAccounts = input.invoiceLedgerAccountIds ?? DEFAULT_INVOICE_LEDGER_ACCOUNTS;
  const journalsByTransaction = new Map<number, Journal[]>();
  for (const journal of input.journals) {
    if (journal.is_deleted || journal.registered !== true || journal.operation_type !== "TRANSACTION" || journal.operations_id == null) continue;
    const list = journalsByTransaction.get(journal.operations_id) ?? [];
    list.push(journal);
    journalsByTransaction.set(journal.operations_id, list);
  }

  const rows = new Map<string, HistoryRow[]>();
  for (const transaction of input.transactions) {
    if (transaction.status !== "CONFIRMED" || transaction.is_deleted || transaction.id == null) continue;
    const key = counterpartyHistoryKey(transaction.bank_account_name);
    if (!key) continue;
    const { direction, treatment } = readJournal(
      transaction, journalsByTransaction.get(transaction.id) ?? [], input.ownBankDimensionIds, invoiceLedgerAccounts,
    );
    const row: HistoryRow = {
      id: transaction.id,
      date: transaction.date,
      name: transaction.bank_account_name ?? "",
      iban: normalizedIban(storedBankAccountNo(transaction)),
      treatment,
    };
    // A row whose side cannot be read from its journal breaks the run in the
    // direction its signed marker proves, or in both when it has none.
    const fallback = signedBankTransactionDirection(transaction);
    const directions: HistoryDirection[] = direction ? [direction] : fallback ? [fallback] : ["incoming", "outgoing"];
    for (const side of directions) {
      const list = rows.get(`${key}\u0000${side}`) ?? [];
      list.push(row);
      rows.set(`${key}\u0000${side}`, list);
    }
  }
  for (const list of rows.values()) {
    list.sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);
  }
  return { rows };
}

/**
 * Same counterparty: differing stored IBANs never are; two names that both carry
 * a legal form must be the same legal person ("Foo OÜ" ≠ "Foo AS"); otherwise
 * both rows must carry the same stored IBAN.
 */
function sameCounterparty(query: CounterpartyHistoryQuery, row: HistoryRow): boolean {
  const queryIban = normalizedIban(query.iban);
  if (queryIban && row.iban && queryIban !== row.iban) return false;
  if (sameCompanyIdentity(query.name, query.name) && sameCompanyIdentity(row.name, row.name)) {
    return sameCompanyIdentity(query.name, row.name);
  }
  return queryIban !== undefined && queryIban === row.iban;
}

const sameTreatment = (left: Treatment, right: Treatment) =>
  left.account_id === right.account_id && left.dimension_id === right.dimension_id;

export function lookupCounterpartyHistory(
  history: CounterpartyBookingHistory,
  query: CounterpartyHistoryQuery,
): CounterpartyHistoryResult {
  const key = counterpartyHistoryKey(query.name);
  if (!key || query.direction === "unknown") return { history_total: 0, breakdown: [] };
  const rows = (history.rows.get(`${key}\u0000${query.direction}`) ?? []).filter((row) => sameCounterparty(query, row));

  const counts: HistoryBreakdownEntry[] = [];
  for (const row of rows) {
    if (!row.treatment) continue;
    const entry = counts.find((candidate) => sameTreatment(candidate, row.treatment!));
    if (entry) (entry as { count: number }).count++;
    else counts.push({ ...row.treatment, count: 1 });
  }
  const breakdown = counts.sort((left, right) => right.count - left.count).slice(0, 3);

  const newest = rows[rows.length - 1]?.treatment;
  let streak = 0;
  if (newest) {
    for (let index = rows.length - 1; index >= 0; index--) {
      const treatment = rows[index]!.treatment;
      if (!treatment || !sameTreatment(treatment, newest)) break;
      streak++;
    }
  }
  const result = { history_total: rows.length, breakdown };
  if (!newest || streak < MIN_STREAK) return result;
  return {
    ...result,
    suggestion: {
      account_id: newest.account_id,
      dimension_id: newest.dimension_id,
      streak,
      history_total: rows.length,
      latest_date: rows[rows.length - 1]!.date,
      breakdown,
    },
  };
}
