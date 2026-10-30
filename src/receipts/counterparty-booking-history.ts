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
// only; a suggestion resting on any such row is marked `identity: "name_only"`.
// A contra on another own bank dimension is a transfer to an own account: it
// counts as a treatment only when the caller has established that the inter-
// account matcher cannot resolve the query row (`allow_own_bank_contra`, e.g. a
// top-up to a broker's pooled IBAN) and never on a name-only identity;
// otherwise it breaks the run.
// A query row linked to an e-arveldaja client also matches confirmed rows of
// that same client whatever their name spelling or stored IBAN, unless both
// stored IBANs are present and differ; rows of another client never match.
// When every matched row (at least MIN_CONSISTENT) carries one and the same
// treatment, the suggestion is `consistent`: the caller may offer it for a
// plan-bound apply, and below MIN_STREAK it is suggested only on a strong
// identity to a non-bank account. A mixed history only yields a review hint.

const MIN_STREAK = 3;
const MIN_CONSISTENT = 2;
const EVIDENCE_JOURNALS = 5;
const DEFAULT_INVOICE_LEDGER_ACCOUNTS: ReadonlySet<number> = new Set([DEFAULT_LIABILITY_ACCOUNT, DEFAULT_ACCOUNTS_RECEIVABLE]);

export type HistoryDirection = "incoming" | "outgoing";

interface Treatment {
  readonly account_id: number;
  readonly dimension_id: number | null;
  /** The contra is another own bank account's dimension. */
  readonly own_bank_account?: true;
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
  readonly clients_id: number | null;
  /** The row's single registered TRANSACTION journal. */
  readonly journal_id: number | undefined;
  /** undefined: the row breaks any streak it sits in. */
  readonly treatment: Treatment | undefined;
}

export interface CounterpartyBookingHistory {
  /** `${normalized name}\u0000${direction}` → rows sorted by date, then id. */
  readonly rows: ReadonlyMap<string, readonly HistoryRow[]>;
  /** `${clients_id}\u0000${direction}` → rows sorted by date, then id. */
  readonly byClient: ReadonlyMap<string, readonly HistoryRow[]>;
}

export interface CounterpartyHistoryQuery {
  readonly name: string | null | undefined;
  readonly iban?: string | null;
  /** The query row's IBAN was left out of its CAMT marker (`x=i`): present, value unknown. */
  readonly iban_omitted?: boolean;
  /** The query row's own bank dimension; required for a name-only match. */
  readonly accounts_dimensions_id?: number | null;
  /** The query row's e-arveldaja client, when the import linked one. */
  readonly clients_id?: number | null;
  readonly direction: HistoryDirection | "unknown";
  /** The inter-account matcher cannot resolve the query row: an own-bank contra may be suggested. */
  readonly allow_own_bank_contra?: boolean;
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
  /** Every matched row (at least two) was booked this one way: no other treatment, no invoice link. */
  readonly consistent: boolean;
  /** The one client every matched row that carries a client is linked to. */
  readonly clients_id?: number;
  /** The newest matched rows' registration journals, newest first. */
  readonly last_journal_ids: number[];
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
): { direction?: HistoryDirection; treatment?: Treatment; journal_id?: number } {
  if (joined.length !== 1) return {};
  const postings = (joined[0]!.postings ?? []).filter((posting) => !posting.is_deleted);
  const bankLegs = postings.filter((posting) => posting.accounts_dimensions_id === transaction.accounts_dimensions_id);
  if (bankLegs.length !== 1 || (bankLegs[0]!.type !== "D" && bankLegs[0]!.type !== "C")) return {};
  const direction: HistoryDirection = bankLegs[0]!.type === "D" ? "incoming" : "outgoing";
  const journal_id = joined[0]!.id ?? undefined;
  const contra = postings.filter((posting) => posting !== bankLegs[0]);
  if (contra.length !== 1) return { direction, journal_id };
  const line = contra[0]!;
  const dimension = line.accounts_dimensions_id ?? null;
  if (invoiceLedgerAccounts.has(line.accounts_id)) return { direction, journal_id };
  if (dimension !== null && ownBankDimensionIds.has(dimension)) {
    return { direction, journal_id, treatment: { account_id: line.accounts_id, dimension_id: dimension, own_bank_account: true } };
  }
  return { direction, journal_id, treatment: { account_id: line.accounts_id, dimension_id: dimension } };
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
  const byClient = new Map<string, HistoryRow[]>();
  const add = (index: Map<string, HistoryRow[]>, key: string, row: HistoryRow) => {
    const list = index.get(key) ?? [];
    list.push(row);
    index.set(key, list);
  };
  for (const transaction of input.transactions) {
    if (transaction.status !== "CONFIRMED" || transaction.is_deleted || transaction.id == null) continue;
    const key = counterpartyHistoryKey(transaction.bank_account_name);
    if (!key) continue;
    const { direction, treatment, journal_id } = readJournal(
      transaction, journalsByTransaction.get(transaction.id) ?? [], input.ownBankDimensionIds, invoiceLedgerAccounts,
    );
    const row: HistoryRow = {
      id: transaction.id,
      date: transaction.date,
      name: transaction.bank_account_name ?? "",
      iban: normalizedIban(storedBankAccountNo(transaction)),
      iban_omitted: isCamtCounterpartyIbanOmitted(transaction),
      dimension_id: transaction.accounts_dimensions_id ?? null,
      clients_id: typeof transaction.clients_id === "number" ? transaction.clients_id : null,
      journal_id,
      treatment,
    };
    // A row whose side cannot be read from its journal breaks the run in the
    // direction its signed marker proves, or in both when it has none.
    const fallback = signedBankTransactionDirection(transaction);
    const directions: HistoryDirection[] = direction ? [direction] : fallback ? [fallback] : ["incoming", "outgoing"];
    for (const side of directions) {
      add(rows, `${key}\u0000${side}`, row);
      if (row.clients_id !== null) add(byClient, `${row.clients_id}\u0000${side}`, row);
    }
  }
  for (const list of [...rows.values(), ...byClient.values()]) {
    list.sort(byDateThenId);
  }
  return { rows, byClient };
}

/** How a history row was tied to the query; only "name" is weak evidence. */
type MatchTier = "client" | "iban" | "legal_form" | "name";

const byDateThenId = (left: HistoryRow, right: HistoryRow) => left.date.localeCompare(right.date) || left.id - right.id;

/**
 * Same counterparty: differing stored IBANs never are; rows linked to two
 * different clients never are, rows linked to the query's own client always are; two names that both carry
 * a legal form must be the same legal person ("Foo OÜ" ≠ "Foo AS"); otherwise
 * both rows must carry the same stored IBAN. When neither side has an IBAN nor
 * a legal form, the same display name (up to case and whitespace) on the same
 * own bank dimension is the weaker, name-only identity. Returns how the row
 * matched, or undefined when it is another counterparty.
 */
function sameCounterparty(query: CounterpartyHistoryQuery, row: HistoryRow): MatchTier | undefined {
  const queryIban = normalizedIban(query.iban);
  if (queryIban && row.iban && queryIban !== row.iban) return undefined;
  if (query.clients_id != null && row.clients_id !== null) return query.clients_id === row.clients_id ? "client" : undefined;
  const queryHasForm = hasLegalForm(query.name);
  const rowHasForm = hasLegalForm(row.name);
  if (queryHasForm && rowHasForm) {
    return sameCompanyIdentity(query.name, row.name) ? "legal_form" : undefined;
  }
  // An omitted IBAN is present with an unknown value: it never equals anything.
  const queryOmitted = queryIban === undefined && query.iban_omitted === true;
  const rowOmitted = row.iban === undefined && row.iban_omitted;
  if (queryIban !== undefined || row.iban !== undefined || queryOmitted || rowOmitted) {
    return !queryOmitted && !rowOmitted && queryIban !== undefined && queryIban === row.iban ? "iban" : undefined;
  }
  if (queryHasForm || rowHasForm) return undefined;
  return query.accounts_dimensions_id != null &&
    query.accounts_dimensions_id === row.dimension_id &&
    displayNameKey(query.name) === displayNameKey(row.name)
    ? "name"
    : undefined;
}

const sameTreatment = (left: Treatment, right: Treatment) =>
  left.account_id === right.account_id && left.dimension_id === right.dimension_id;

export function lookupCounterpartyHistory(
  history: CounterpartyBookingHistory,
  query: CounterpartyHistoryQuery,
): CounterpartyHistoryResult {
  const key = counterpartyHistoryKey(query.name);
  if (!key || query.direction === "unknown") return { history_total: 0, breakdown: [] };
  const byName = history.rows.get(`${key}\u0000${query.direction}`) ?? [];
  const byClient = query.clients_id != null ? history.byClient.get(`${query.clients_id}\u0000${query.direction}`) ?? [] : [];
  const tiers = new Map<number, MatchTier>();
  for (const row of [...byName, ...byClient]) {
    const tier = sameCounterparty(query, row);
    if (tier) tiers.set(row.id, tier);
  }
  const rows = [...new Map([...byName, ...byClient].map((row) => [row.id, row])).values()]
    .filter((row) => tiers.has(row.id))
    .sort(byDateThenId);
  // One row tied to the query by its name alone makes the whole history name-only
  // evidence (a client on the query row does not vouch for a client-less row).
  const nameOnly = rows.some((row) => tiers.get(row.id) === "name");
  const treatmentOf = (row: HistoryRow): Treatment | undefined =>
    row.treatment?.own_bank_account && (!query.allow_own_bank_contra || tiers.get(row.id) === "name") ? undefined : row.treatment;

  const counts: HistoryBreakdownEntry[] = [];
  for (const row of rows) {
    const treatment = treatmentOf(row);
    if (!treatment) continue;
    const entry = counts.find((candidate) => sameTreatment(candidate, treatment));
    if (entry) (entry as { count: number }).count++;
    else counts.push({ ...treatment, count: 1 });
  }
  const breakdown = counts.sort((left, right) => right.count - left.count).slice(0, 3);

  const newest = rows.length > 0 ? treatmentOf(rows[rows.length - 1]!) : undefined;
  let streak = 0;
  if (newest) {
    for (let index = rows.length - 1; index >= 0; index--) {
      const treatment = treatmentOf(rows[index]!);
      if (!treatment || !sameTreatment(treatment, newest)) break;
      streak++;
    }
  }
  const result = { history_total: rows.length, breakdown };
  const consistent = streak === rows.length && streak >= MIN_CONSISTENT;
  // Below MIN_STREAK only a consistent history on a strong identity (client,
  // IBAN or legal form) to a non-bank account is suggested.
  const shortButConsistent = consistent && !nameOnly && newest?.own_bank_account !== true;
  if (!newest || (streak < MIN_STREAK && !shortButConsistent)) return result;
  const clients = new Set(rows.flatMap((row) => row.clients_id !== null ? [row.clients_id] : []));
  return {
    ...result,
    suggestion: {
      account_id: newest.account_id,
      dimension_id: newest.dimension_id,
      ...(newest.own_bank_account ? { own_bank_account: true as const } : {}),
      streak,
      history_total: rows.length,
      latest_date: rows[rows.length - 1]!.date,
      breakdown,
      ...(nameOnly ? { identity: "name_only" as const } : {}),
      consistent,
      ...(clients.size === 1 ? { clients_id: [...clients][0]! } : {}),
      last_journal_ids: rows.slice(-streak).reverse().flatMap((row) => row.journal_id !== undefined ? [row.journal_id] : []).slice(0, EVIDENCE_JOURNALS),
    },
  };
}
