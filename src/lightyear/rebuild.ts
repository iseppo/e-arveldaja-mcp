/**
 * Read-only Lightyear year rebuild (plan Q5): every journal the Lightyear tools
 * would create for a period from one statement + one capital-gains file,
 * starting from an in-memory pool opening, and a comparison with the books.
 *
 * The simulation runs the production planners (`extractLightyearDistributions`,
 * `planLightyearDistributions`, `planLightyearTrades` — the same code
 * `book_lightyear_distributions` / `book_lightyear_trades` run) against an
 * in-memory ledger and an in-memory pool store. It never writes: no API
 * mutation, no pool store file, no plan handle, no audit entry.
 */
import { HttpClient } from "../http-client.js";
import type { Config } from "../config.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { Account, AccountDimension, Journal, Posting } from "../types/api.js";
import { validatePostingDimensions } from "../account-validation.js";
import { fxOutcomeKey, replayFrozenFx, resolveFrozenFxOutcomes, type EcbRateDeps } from "../fx/ecb-rates.js";
import {
  canonicalPoolPostings,
  endOfDaySeconds,
  usdCentsToEurCents,
  usdPoolRecordKey,
  type PoolKey,
  type PoolPosting,
  type UsdPoolCheckpoint,
  type UsdPoolEvent,
  type UsdPoolRecord,
  type UsdPoolStore,
} from "./usd-pool.js";
import {
  KNOWN_CASH_EQUIVALENT_TICKERS,
  extractLightyearDistributions,
  lightyearFundingTickers,
  lightyearTimestampSeconds,
  parseAccountStatement,
  parseCapitalGains,
  planLightyearDistributions,
  planLightyearTrades,
  type AccountStatementRow,
  type PendingPoolEvent,
} from "../tools/lightyear-investments.js";

/** HTTP client that refuses every non-GET request before it is sent. */
export class GetOnlyHttpClient extends HttpClient {
  constructor(config: Config, cacheNamespace = "rebuild:0") {
    super(config, cacheNamespace);
  }

  override async request<T = unknown>(path: string, options: Parameters<HttpClient["request"]>[1] = {}): Promise<T> {
    const method = options.method ?? "GET";
    if (method !== "GET") throw new Error(`Read-only rebuild: ${method} ${path} refused before sending.`);
    return super.request<T>(path, options);
  }
}

export interface RebuildAccounts {
  broker_account: number;
  broker_dimension_id?: number;
  investment_account: number;
  investment_dimension_id?: number;
  income_account: number;
  interest_account: number;
  fund_distribution_account: number;
  reward_account: number;
  tax_account?: number;
  /** Buy/sell and conversion fees (book_lightyear_trades `fee_account`, default 8335). */
  trade_fee_account: number;
  /** Distribution fees (book_lightyear_distributions `fee_account`, default 8610). */
  distribution_fee_account: number;
  gain_account: number;
  loss_account: number;
  fx_account: number;
}

export interface RebuildOpening {
  as_of: string;
  usd_cents: number;
  eur_cents: number;
  rate: string;
}

export interface ProposedJournal {
  document_number: string;
  date: string;
  source: "distribution" | "trade";
  /** The pool record this journal (or journal-free record) carries, if any. */
  pool_kind?: UsdPoolEvent["kind"];
  /** True for a journal-free pool conversion: recorded in the pool, no journal. */
  journal_free: boolean;
  postings: PoolPosting[];
}

export interface RebuildReview {
  reference: string;
  source: "distribution" | "trade";
  status: string;
  reason?: string;
}

export interface RebuildMonthEnd {
  month: string;
  as_of: string;
  usd_cents: number;
  eur_cents: number;
  ecb_rate: string | null;
  ecb_value_cents: number | null;
  unrealised_cents: number | null;
}

export interface SimulationResult {
  journals: ProposedJournal[];
  monthEnds: RebuildMonthEnd[];
  reviews: RebuildReview[];
  warnings: string[];
  /** EUR deposits/withdrawals on the statement per month (net cents, deposit positive). */
  statementTransfers: Array<{ month: string; cents: number }>;
}

export interface SimulateParams {
  statementCsv: string;
  gainsCsv: string | null;
  from: string;
  to: string;
  lightyearAccount: string;
  opening: RebuildOpening;
  accounts: RebuildAccounts;
  ecb: EcbRateDeps;
  /**
   * The live chart, when known. The booking tools auto-fill an account's only
   * dimension before creating a journal; with the chart the simulation does the
   * same, so the comparison sees the dimensions the tools would book.
   */
  chart?: { accounts: Account[]; dimensions: AccountDimension[] };
}

const CONNECTION = "lightyear-rebuild";

function rowDay(row: AccountStatementRow): string | null {
  const ts = lightyearTimestampSeconds(row.date);
  return ts === null ? null : new Date(ts * 1000).toISOString().slice(0, 10);
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** An in-memory pool store: the rebuild never touches the bundle file. */
function memoryStore(initial: UsdPoolRecord[]): UsdPoolStore & { records: () => UsdPoolRecord[] } {
  let records = initial.map(record => structuredClone(record));
  return {
    records: () => records,
    read: () => records.map(record => structuredClone(record)),
    upsert(next) {
      const keys = new Set(next.map(usdPoolRecordKey));
      records = [...records.filter(record => !keys.has(usdPoolRecordKey(record))), ...next.map(record => structuredClone(record))];
    },
    remove(keys) {
      const drop = new Set(keys);
      records = records.filter(record => !drop.has(usdPoolRecordKey(record)));
    },
    reset() {},
  };
}

/** A read-only in-memory journals API over the simulated ledger. */
function memoryApi(ledger: Map<number, Journal>): ApiContext {
  const refuse = async () => { throw new Error("Read-only rebuild: no API call."); };
  const journals = {
    connectionFingerprint: CONNECTION,
    invalidateListCache: () => {},
    listAll: async () => [...ledger.values()].map(journal => structuredClone(journal)),
    listAllWithPostings: async () => [...ledger.values()].map(journal => structuredClone(journal)),
    get: async (id: number) => {
      const journal = ledger.get(id);
      if (!journal) throw new Error(`journal ${id} not in the simulated ledger`);
      return structuredClone(journal);
    },
    create: refuse,
  };
  return { journals, readonly: { getAccounts: refuse, getAccountDimensions: refuse } } as unknown as ApiContext;
}

/** Simulate one period of Lightyear bookings; see the module comment. */
export async function simulateLightyearYear(params: SimulateParams): Promise<SimulationResult> {
  const { accounts, opening } = params;
  const rows = parseAccountStatement(params.statementCsv).filter(row => {
    const day = rowDay(row);
    // Rows without a valid timestamp stay in: the production checks refuse them (unplaceable).
    return day === null || (day >= params.from && day <= params.to);
  });
  const gainsRows = params.gainsCsv === null ? null : parseCapitalGains(params.gainsCsv);
  const key: PoolKey = {
    connection_fingerprint: CONNECTION, lightyear_account: params.lightyearAccount.toUpperCase(),
    broker_account: accounts.broker_account, broker_dimension_id: accounts.broker_dimension_id ?? null, currency: "USD",
  };
  const openingRecord: UsdPoolCheckpoint = {
    record: "checkpoint", pool_key: key, kind: "opening", as_of: opening.as_of, ts: endOfDaySeconds(opening.as_of),
    usd_cents: opening.usd_cents, eur_cents: opening.eur_cents, fx_cents: 0, journal_id: null, document_number: null,
    rate: opening.rate, rate_date: opening.as_of, approved: true, postings: [], recorded_at: "rebuild",
  };
  const store = memoryStore([openingRecord]);
  const ledger = new Map<number, Journal>();
  const api = memoryApi(ledger);
  const journals: ProposedJournal[] = [];
  const reviews: RebuildReview[] = [];
  const warnings: string[] = [];
  const period = { from: params.from, to: params.to };

  type Command = { reference: string; date: string; postings: Array<{ accounts_id: number; accounts_dimensions_id?: number; type: "D" | "C"; amount: number }>; poolEvent?: PendingPoolEvent };
  // As the booking tools: every posting of the projection is validated against
  // the chart first (a unique dimension is auto-filled); any error refuses the
  // whole projection, so nothing of it is applied.
  const applyProjection = (source: ProposedJournal["source"], commands: readonly Command[]) => {
    if (params.chart) {
      const chart = params.chart;
      const failures = commands.map(command => ({
        command, errors: validatePostingDimensions(command.postings as Posting[], chart.accounts, chart.dimensions),
      })).filter(entry => entry.errors.length > 0);
      if (failures.length > 0) {
        for (const { command, errors } of failures) {
          reviews.push({ reference: command.reference, source, status: "account_validation_failed", reason: errors.join("; ") });
        }
        warnings.push(`${source}: account validation failed for ${failures.length} of ${commands.length} command(s); the booking tool refuses the whole run, so none is applied.`);
        return;
      }
    }
    for (const command of commands) apply(source, command);
  };

  const apply = (source: ProposedJournal["source"], command: Command) => {
    const postings = canonicalPoolPostings(command.postings);
    const event = command.poolEvent;
    if (event?.source_evidence) {
      store.upsert([{ ...event, postings: [], state: "committed", journal_id: null, recorded_at: "rebuild" }]);
      journals.push({ document_number: event.document_number ?? `LY:${command.reference}`, date: command.date, source, pool_kind: event.kind, journal_free: true, postings: [] });
      return;
    }
    const id = ledger.size + 1;
    const documentNumber = `LY:${command.reference}`;
    ledger.set(id, {
      id, document_number: documentNumber, effective_date: command.date, registered: true, is_deleted: false,
      postings: command.postings.map(posting => ({ ...posting })),
    } as Journal);
    if (event) store.upsert([{ ...event, postings, effective_date: command.date, state: "committed", journal_id: id, recorded_at: "rebuild" }]);
    journals.push({ document_number: documentNumber, date: command.date, source, ...(event ? { pool_kind: event.kind } : {}), journal_free: false, postings });
  };

  // 1. Distributions (retained USD at the ECB rate), as book_lightyear_distributions fx_source "ecb".
  const extracted = await extractLightyearDistributions(rows, "ecb", params.ecb);
  const { projection: distributions } = await planLightyearDistributions({
    api, store, poolKey: key, rows, distributions: extracted.distributions, warnings: extracted.warnings, inLock: true, chart: [],
    accounts: {
      broker_account: accounts.broker_account, broker_dimension_id: accounts.broker_dimension_id, income_account: accounts.income_account,
      interest_account: accounts.interest_account, fund_distribution_account: accounts.fund_distribution_account,
      reward_account: accounts.reward_account, tax_account: accounts.tax_account, fee_account: accounts.distribution_fee_account,
    },
  });
  applyProjection("distribution", distributions.commands);
  for (const row of distributions.manualResults) {
    reviews.push({ reference: String(row.reference ?? ""), source: "distribution", status: String(row.status ?? "review"), ...(row.review_reason !== undefined ? { reason: JSON.stringify(row.review_reason) } : {}) });
  }
  warnings.push(...distributions.warnings);

  // 2. Trades and conversions, as book_lightyear_trades with the default skip list.
  const skipSet = KNOWN_CASH_EQUIVALENT_TICKERS;
  const { projection: trades } = await planLightyearTrades({
    api, store, rows, gainsRows, skipSet, fundingTickers: lightyearFundingTickers(skipSet), poolKey: key, period, ecb: params.ecb, inLock: true,
    accounts: {
      investment_account: accounts.investment_account, investment_dimension_id: accounts.investment_dimension_id,
      broker_account: accounts.broker_account, broker_dimension_id: accounts.broker_dimension_id,
      gainAccount: accounts.gain_account, lossAccount: accounts.loss_account, feeAccount: accounts.trade_fee_account, fxAccount: accounts.fx_account,
    },
  });
  applyProjection("trade", trades.commands);
  for (const row of trades.planned) {
    if (row.kind !== "result") continue;
    const result = row.row;
    if (result.status === "would_create" || result.status === "would_record") continue;
    reviews.push({ reference: result.reference, source: "trade", status: result.status, ...(result.skip_reason !== undefined ? { reason: result.skip_reason } : {}) });
  }
  warnings.push(...trades.warnings);

  // 3. Month ends: the replayed pool and its ECB value.
  const monthEndDays: string[] = [];
  for (let month = params.from.slice(0, 7); month <= params.to.slice(0, 7);) {
    const [year, mon] = month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
    monthEndDays.push(last < params.to ? last : params.to);
    month = new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 7);
  }
  const rates = await resolveFrozenFxOutcomes(monthEndDays.map(day => fxOutcomeKey("USD", day)), params.ecb);
  const events = store.records().filter((record): record is UsdPoolEvent => record.record === "event" && record.state === "committed");
  const monthEnds = monthEndDays.map((day): RebuildMonthEnd => {
    const until = endOfDaySeconds(day);
    const state = events.filter(event => event.ts <= until)
      .reduce((sum, event) => ({ usd: sum.usd + event.usd_cents, eur: sum.eur + event.eur_cents }), { usd: opening.usd_cents, eur: opening.eur_cents });
    const outcome = replayFrozenFx(rates, "USD", day);
    const value = outcome.ok ? usdCentsToEurCents(state.usd, outcome.rate.rate) : null;
    return {
      month: day.slice(0, 7), as_of: day, usd_cents: state.usd, eur_cents: state.eur,
      ecb_rate: outcome.ok ? outcome.rate.rate : null, ecb_value_cents: value, unrealised_cents: value === null ? null : value - state.eur,
    };
  });

  // 4. Statement EUR deposits / withdrawals per month (bank-booked, compared with the books' transfers).
  const transfers = new Map<string, number>();
  for (const row of rows) {
    if ((row.type !== "Deposit" && row.type !== "Withdrawal") || row.ccy.trim().toUpperCase() !== "EUR") continue;
    const day = rowDay(row);
    if (day === null) continue;
    transfers.set(day.slice(0, 7), (transfers.get(day.slice(0, 7)) ?? 0) + cents(row.net_amount));
  }
  const statementTransfers = [...transfers].sort(([a], [b]) => a.localeCompare(b)).map(([month, value]) => ({ month, cents: value }));
  return { journals, monthEnds, reviews, warnings, statementTransfers };
}

// ---- comparison with the books ---------------------------------------------------

export interface CompareScope {
  /** Inclusive YYYY-MM-DD bounds, the same as the simulation's --from..--to (proposals, books and transfers alike). */
  from: string;
  to: string;
  /** Accounts compared (the broker and investment accounts are limited to their dimensions when given). */
  accounts: number[];
  broker_account: number;
  broker_dimension_id?: number;
  investment_account: number;
  investment_dimension_id?: number;
}

export interface AccountMonthDiff {
  account: number;
  dimension?: number;
  month: string;
  /** Every non-deleted journal, drafts included. */
  books_cents: number;
  proposed_cents: number;
  diff_cents: number;
  /** The draft (unregistered) part of books_cents. */
  books_draft_cents: number;
}

export interface CompareResult {
  byAccountMonth: AccountMonthDiff[];
  byRef: {
    matched_equal: string[];
    matched_different: string[];
    proposed_only: string[];
    /** In-scope journals no proposal claims (hand bookings show here), by id. */
    books_only: Array<{ id: number | null; document_number: string | null; date: string }>;
  };
  transfers: Array<{ month: string; books_broker_transaction_cents: number; statement_eur_deposit_withdrawal_cents: number }>;
}

type ScopedPosting = { accounts_id: number; accounts_dimensions_id: number | null; type: "D" | "C"; amount_cents: number };

function inScope(posting: ScopedPosting, scope: CompareScope): boolean {
  if (!scope.accounts.includes(posting.accounts_id)) return false;
  if (posting.accounts_id === scope.broker_account && scope.broker_dimension_id !== undefined) return posting.accounts_dimensions_id === scope.broker_dimension_id;
  if (posting.accounts_id === scope.investment_account && scope.investment_dimension_id !== undefined) return posting.accounts_dimensions_id === scope.investment_dimension_id;
  return true;
}

function signed(posting: ScopedPosting): number {
  return posting.type === "D" ? posting.amount_cents : -posting.amount_cents;
}

/** Compare the proposed journals with the live books over one inclusive date range (pure). */
export function compareWithBooks(
  proposed: readonly ProposedJournal[],
  liveJournals: readonly Journal[],
  scope: CompareScope,
  statementTransfers: ReadonlyArray<{ month: string; cents: number }> = [],
): CompareResult {
  const cells = new Map<string, AccountMonthDiff>();
  const cell = (posting: ScopedPosting, month: string) => {
    const id = `${posting.accounts_id}|${posting.accounts_dimensions_id ?? ""}|${month}`;
    let entry = cells.get(id);
    if (!entry) {
      entry = { account: posting.accounts_id, ...(posting.accounts_dimensions_id !== null ? { dimension: posting.accounts_dimensions_id } : {}), month, books_cents: 0, proposed_cents: 0, diff_cents: 0, books_draft_cents: 0 };
      cells.set(id, entry);
    }
    return entry;
  };
  const transfers = new Map<string, number>();
  const inRange = (day: string) => day.slice(0, 10) >= scope.from && day.slice(0, 10) <= scope.to;
  const books = liveJournals.filter(journal => journal.is_deleted !== true && inRange(journal.effective_date));
  const booksByNumber = new Map<string, Journal[]>();
  const claimed = new Set<Journal>();
  for (const journal of books) {
    const postings = canonicalPoolPostings(journal.postings ?? []).filter(posting => inScope(posting, scope));
    if (postings.length === 0) continue;
    const month = journal.effective_date.slice(0, 7);
    if (journal.operation_type === "TRANSACTION") {
      const broker = postings.filter(posting => posting.accounts_id === scope.broker_account).reduce((sum, posting) => sum + signed(posting), 0);
      if (broker !== 0) transfers.set(month, (transfers.get(month) ?? 0) + broker);
      continue;
    }
    for (const posting of postings) {
      const entry = cell(posting, month);
      entry.books_cents += signed(posting);
      if (journal.registered !== true) entry.books_draft_cents += signed(posting);
    }
    if (journal.document_number) booksByNumber.set(journal.document_number, [...(booksByNumber.get(journal.document_number) ?? []), journal]);
  }
  const byRef: CompareResult["byRef"] = { matched_equal: [], matched_different: [], proposed_only: [], books_only: [] };
  for (const journal of proposed.filter(entry => inRange(entry.date))) {
    for (const posting of journal.postings.filter(p => inScope(p, scope))) cell(posting, journal.date.slice(0, 7)).proposed_cents += signed(posting);
    if (journal.journal_free) continue;
    const matches = booksByNumber.get(journal.document_number) ?? [];
    if (matches.length === 0) { byRef.proposed_only.push(journal.document_number); continue; }
    for (const match of matches) claimed.add(match);
    const live = canonicalPoolPostings(matches[0]!.postings ?? []);
    // Equal means the same journal: one match, the same effective date and the same posting multiset.
    const same = matches.length === 1 && matches[0]!.effective_date === journal.date && JSON.stringify(live) === JSON.stringify(journal.postings);
    (same ? byRef.matched_equal : byRef.matched_different).push(journal.document_number);
  }
  for (const journals of booksByNumber.values()) {
    for (const journal of journals) if (!claimed.has(journal)) byRef.books_only.push({ id: journal.id ?? null, document_number: journal.document_number ?? null, date: journal.effective_date });
  }
  for (const journal of books) {
    if (journal.document_number || journal.operation_type === "TRANSACTION") continue;
    if (canonicalPoolPostings(journal.postings ?? []).some(posting => inScope(posting, scope))) byRef.books_only.push({ id: journal.id ?? null, document_number: null, date: journal.effective_date });
  }
  for (const entry of cells.values()) entry.diff_cents = entry.proposed_cents - entry.books_cents;
  const months = new Set([...transfers.keys(), ...statementTransfers.filter(row => row.month >= scope.from.slice(0, 7) && row.month <= scope.to.slice(0, 7)).map(row => row.month)]);
  return {
    byAccountMonth: [...cells.values()].sort((a, b) => a.month.localeCompare(b.month) || a.account - b.account || (a.dimension ?? 0) - (b.dimension ?? 0)),
    byRef,
    transfers: [...months].sort().map(month => ({
      month,
      books_broker_transaction_cents: transfers.get(month) ?? 0,
      statement_eur_deposit_withdrawal_cents: statementTransfers.find(row => row.month === month)?.cents ?? 0,
    })),
  };
}

// ---- script arguments and report ---------------------------------------------------

export interface RebuildArgs {
  statement: string;
  gains: string | null;
  from: string;
  to: string;
  openingAsOf: string;
  /** USD held at the opening (asserted by the owner; the rebuild only, flagged in the report). */
  startUsdHolding: number;
  lightyearAccount: string | null;
  brokerDimension?: number;
  investmentDimension?: number;
  out: string | null;
  connection?: number;
  /** Skip the books comparison: no credentials, no API call (statement-only run). */
  noBooks: boolean;
}

export const REBUILD_USAGE = "Usage: npm run lightyear:rebuild-compare -- --statement <csv> [--gains <csv>] --from YYYY-MM-DD --to YYYY-MM-DD "
  + "--opening-as-of YYYY-MM-DD --start-usd-holding <usd> [--lightyear-account <id>] [--broker-dimension <id>] [--investment-dimension <id>] "
  + "[--out <file.md>] [--connection <index>] [--no-books]";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the script arguments; throws (before any file or API access) on anything malformed. */
export function parseRebuildArgs(argv: readonly string[]): RebuildArgs {
  const values = new Map<string, string>();
  let noBooks = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--no-books") { noBooks = true; continue; }
    const known = ["--statement", "--gains", "--from", "--to", "--opening-as-of", "--start-usd-holding", "--lightyear-account", "--broker-dimension", "--investment-dimension", "--out", "--connection"];
    if (!known.includes(arg)) throw new Error(`Unknown argument ${arg}. ${REBUILD_USAGE}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value. ${REBUILD_USAGE}`);
    values.set(arg, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`${name} is required. ${REBUILD_USAGE}`);
    return value;
  };
  const day = (name: string) => {
    const value = required(name);
    if (!ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${name} must be YYYY-MM-DD.`);
    return value;
  };
  const integer = (name: string) => {
    const value = values.get(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
    return Number(value);
  };
  const from = day("--from");
  const to = day("--to");
  const openingAsOf = day("--opening-as-of");
  if (to < from) throw new Error("--to is before --from.");
  if (openingAsOf >= from) throw new Error("--opening-as-of must be before --from.");
  const holding = required("--start-usd-holding");
  if (!/^\d+(\.\d{1,2})?$/.test(holding)) throw new Error("--start-usd-holding must be a USD amount with at most 2 decimals.");
  const brokerDimension = integer("--broker-dimension");
  const investmentDimension = integer("--investment-dimension");
  const connection = integer("--connection");
  return {
    statement: required("--statement"), gains: values.get("--gains") ?? null, from, to, openingAsOf,
    startUsdHolding: Number(holding), lightyearAccount: values.get("--lightyear-account") ?? null,
    ...(brokerDimension !== undefined ? { brokerDimension } : {}), ...(investmentDimension !== undefined ? { investmentDimension } : {}),
    out: values.get("--out") ?? null, ...(connection !== undefined ? { connection } : {}), noBooks,
  };
}

const SAFE_REF = /^[A-Z]{2}-[A-Z0-9]{6,16}$/;

/** A document number for the report: `LY:<ref>` with an unsafe ref (CSV-controlled text) becomes `LY:<unsafe>`. */
export function safeDocumentNumber(documentNumber: string | null): string {
  if (documentNumber === null) return "(none)";
  if (documentNumber.startsWith("LY-FX:")) return /^LY-FX:[A-Z0-9]{1,32}:USD:\d{4}-\d{2}-\d{2}$/.test(documentNumber) ? documentNumber : "LY-FX:<unsafe>";
  if (documentNumber.startsWith("LY:")) return SAFE_REF.test(documentNumber.slice(3)) ? documentNumber : "LY:<unsafe>";
  return /^[A-Za-z0-9 _.:/-]{1,40}$/.test(documentNumber) ? documentNumber : "<unsafe>";
}

const money = (value: number | null) => value === null ? "n/a" : (value / 100).toFixed(2);

/** Markdown and JSON report of a rebuild run (references sanitised). */
export function renderRebuildReport(meta: { args: RebuildArgs; opening: RebuildOpening }, sim: SimulationResult, compare: CompareResult | null): { markdown: string; json: unknown } {
  const fxByMonth = new Map<string, number>();
  for (const journal of sim.journals) {
    for (const posting of journal.postings) {
      if (posting.accounts_id !== 8500) continue;
      const month = journal.date.slice(0, 7);
      fxByMonth.set(month, (fxByMonth.get(month) ?? 0) + (posting.type === "D" ? posting.amount_cents : -posting.amount_cents));
    }
  }
  const fxYear = [...fxByMonth.values()].reduce((sum, value) => sum + value, 0);
  const counts = new Map<string, number>();
  for (const journal of sim.journals) {
    const kind = journal.journal_free ? "journal_free_conversion" : journal.pool_kind ?? (journal.source === "distribution" ? "distribution" : "trade_1to1");
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const reviews = sim.reviews.map(review => ({ ...review, reference: SAFE_REF.test(review.reference) ? review.reference : "<unsafe>", reason: review.reason === undefined ? undefined : "(see tool dry run)" }));
  const lines = [
    `# Lightyear rebuild ${meta.args.from} … ${meta.args.to} (read-only)`,
    "",
    `Opening ${meta.opening.as_of}: ${money(meta.opening.usd_cents)} USD → €${money(meta.opening.eur_cents)} @ ${meta.opening.rate} — **start USD holding asserted by the owner (rebuild only)**.`,
    "",
    "## Proposed journals",
    ...[...counts].sort().map(([kind, count]) => `- ${kind}: ${count}`),
    "",
    "## Pool at month end",
    "| month | USD | EUR carrying | ECB rate | ECB value | unrealised |",
    "|---|---|---|---|---|---|",
    ...sim.monthEnds.map(month => `| ${month.month} | ${money(month.usd_cents)} | ${money(month.eur_cents)} | ${month.ecb_rate ?? "n/a"} | ${money(month.ecb_value_cents)} | ${money(month.unrealised_cents)} |`),
    "",
    "## Realised FX (8500, D positive)",
    ...[...fxByMonth].sort().map(([month, value]) => `- ${month}: ${money(value)}`),
    `- **year: ${money(fxYear)}**`,
    "",
    `## Reviews (${reviews.length}) — where the year stops being computable`,
    ...reviews.map(review => `- ${review.source} ${review.reference}: ${review.status}`),
    ...(sim.warnings.length > 0 ? ["", `Warnings: ${sim.warnings.length} (codes: ${[...new Set(sim.warnings.map(warning => /\[([a-z_]+)\]/.exec(warning)?.[1]).filter(Boolean))].join(", ") || "none"})`] : []),
  ];
  if (compare) {
    lines.push("", "## Books comparison",
      `- matched equal: ${compare.byRef.matched_equal.length}, matched different: ${compare.byRef.matched_different.length}, proposed only: ${compare.byRef.proposed_only.length}, books only: ${compare.byRef.books_only.length}`,
      "", "| account | dim | month | books | drafts | proposed | diff |", "|---|---|---|---|---|---|---|",
      ...compare.byAccountMonth.filter(cell => cell.diff_cents !== 0).map(cell => `| ${cell.account} | ${cell.dimension ?? ""} | ${cell.month} | ${money(cell.books_cents)} | ${money(cell.books_draft_cents)} | ${money(cell.proposed_cents)} | ${money(cell.diff_cents)} |`),
      "", "| month | books broker TRANSACTION | statement EUR deposits/withdrawals |", "|---|---|---|",
      ...compare.transfers.map(row => `| ${row.month} | ${money(row.books_broker_transaction_cents)} | ${money(row.statement_eur_deposit_withdrawal_cents)} |`));
  }
  const json = {
    opening: meta.opening, start_usd_holding_asserted: true,
    journals: sim.journals.map(journal => ({ ...journal, document_number: safeDocumentNumber(journal.document_number) })),
    month_ends: sim.monthEnds, fx_by_month_cents: Object.fromEntries([...fxByMonth].sort()), fx_year_cents: fxYear, reviews,
    ...(compare ? {
      compare: {
        byAccountMonth: compare.byAccountMonth,
        byRef: {
          matched_equal: compare.byRef.matched_equal.map(safeDocumentNumber), matched_different: compare.byRef.matched_different.map(safeDocumentNumber),
          proposed_only: compare.byRef.proposed_only.map(safeDocumentNumber),
          books_only: compare.byRef.books_only.map(row => ({ ...row, document_number: safeDocumentNumber(row.document_number) })),
        },
        transfers: compare.transfers,
      },
    } : {}),
  };
  return { markdown: lines.join("\n") + "\n", json };
}
