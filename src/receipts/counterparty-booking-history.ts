import { normalizeCompanyName, sameCompanyIdentity } from "../company-name.js";
import { DEFAULT_ACCOUNTS_RECEIVABLE, DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { signedBankTransactionDirection } from "../bank-transaction-direction.js";
import { isCamtCounterpartyIbanOmitted, storedBankAccountNo } from "../camt/duplicate-identity.js";
import type { Journal, Transaction } from "../types/api.js";

// PURE: how confirmed bank rows of one counterparty were booked before. A row's
// treatment is the single contra line of its one registered TRANSACTION journal;
// its side comes from that journal's bank leg (the API reads every stored type
// back as "C"). Only the newest unbroken run of one treatment, at least
// MIN_STREAK long, becomes a suggestion, and it is review-only by contract.
// Counterparties without a stored IBAN or a legal form (e.g. a Wise fee row
// "TransferWise") match by exact display name on the same own bank dimension
// only, and such a suggestion is marked `identity: "name_only"`.

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
  /** A trusted `x=i` marker: the IBAN exists but was left out (proven external). */
  readonly iban_omitted: boolean;
  /** The own bank dimension the row was imported on. */
  readonly dimension_id: number | null;
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
  /** The query row's IBAN was left out of its CAMT marker (`x=i`): present, value unknown. */
  readonly iban_omitted?: boolean;
  /** The query row's own bank dimension; required for a name-only match. */
  readonly accounts_dimensions_id?: number | null;
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
  /** Set when neither side has an IBAN or legal form: the match rests on the exact name alone. */
  readonly identity?: "name_only";
}

export interface CounterpartyHistoryResult {
  /**
   * Identity-compatible confirmed rows in this direction, across all own bank
   * dimensions (only the query's own dimension for a name-only match).
   */
  readonly history_total: number;
  readonly breakdown: HistoryBreakdownEntry[];
  readonly suggestion?: CounterpartyHistorySuggestion;
}

export function counterpartyHistoryKey(name: string | null | undefined): string {
  return normalizeCompanyName(name, { stripNonAlphanumeric: true });
}

/** Case- and whitespace-insensitive display name; punctuation still counts. */
function displayNameKey(name: string | null | undefined): string {
  return (name ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

const hasLegalForm = (name: string | null | undefined) => sameCompanyIdentity(name, name);

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
      iban_omitted: isCamtCounterpartyIbanOmitted(transaction),
      dimension_id: transaction.accounts_dimensions_id ?? null,
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
 * both rows must carry the same stored IBAN. When neither side has an IBAN nor
 * a legal form, the same display name (up to case and whitespace) on the same
 * own bank dimension is the weaker, name-only identity.
 */
function sameCounterparty(query: CounterpartyHistoryQuery, row: HistoryRow): boolean {
  const queryIban = normalizedIban(query.iban);
  if (queryIban && row.iban && queryIban !== row.iban) return false;
  const queryHasForm = hasLegalForm(query.name);
  const rowHasForm = hasLegalForm(row.name);
  if (queryHasForm && rowHasForm) {
    return sameCompanyIdentity(query.name, row.name);
  }
  // An omitted IBAN is present with an unknown value: it never equals anything.
  const queryOmitted = queryIban === undefined && query.iban_omitted === true;
  const rowOmitted = row.iban === undefined && row.iban_omitted;
  if (queryIban !== undefined || row.iban !== undefined || queryOmitted || rowOmitted) {
    return !queryOmitted && !rowOmitted && queryIban !== undefined && queryIban === row.iban;
  }
  if (queryHasForm || rowHasForm) return false;
  return query.accounts_dimensions_id != null &&
    query.accounts_dimensions_id === row.dimension_id &&
    displayNameKey(query.name) === displayNameKey(row.name);
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
      // Without a query IBAN or legal form, every matched row came through the name-only tier.
      ...(normalizedIban(query.iban) === undefined && !hasLegalForm(query.name) ? { identity: "name_only" as const } : {}),
    },
  };
}
