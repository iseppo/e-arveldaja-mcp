import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { readFile } from "fs/promises";
import type { ApiContext } from "./crud-tools.js";
import { resolveFileInput } from "../file-validation.js";
import { roundMoney } from "../money.js";
import { readOnly, batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { reportProgress } from "../progress.js";
import { parseCSVLine } from "../csv.js";
import { validateAccounts } from "../account-validation.js";
import { toolError } from "../tool-error.js";

const MAX_CSV_SIZE = 10 * 1024 * 1024; // 10 MB

// Known Lightyear cash-sweep / cash-equivalent instruments. Lightyear's capital
// gains report does not cover these, so we book buy/sell only for EUR-denominated
// sweeps where proceeds equal cost basis 1:1. Non-EUR sweeps (e.g. ICSUSSDP in USD)
// would need a proper cost-basis source to avoid FX drift on the investment account.
const KNOWN_CASH_EQUIVALENT_TICKERS = new Set(["BRICEKSP", "ICSUSSDP"]);

const EXPECTED_STATEMENT_HEADERS = ["Date", "Reference", "Ticker", "ISIN", "Type", "Quantity", "CCY", "Price/share", "Gross Amount", "FX Rate", "Fee", "Net Amt.", "Tax Amt."];
const EXPECTED_GAINS_HEADERS = ["Date", "Ticker", "Name", "ISIN", "Country", "Fees (EUR)", "Quantity", "Cost Basis (EUR)", "Proceeds (EUR)", "Capital Gains (EUR)"];

interface AccountStatementRow {
  row_index: number;
  date: string;           // DD/MM/YYYY HH:MM:SS
  reference: string;      // OR-xxx, CN-xxx, DT-xxx, WL-xxx, IN-xxx, RW-xxx
  ticker: string;
  isin: string;
  type: "Buy" | "Sell" | "Conversion" | "Deposit" | "Withdrawal" | "Distribution" | "Dividend" | "Interest" | "Reward";
  quantity: number;
  ccy: string;
  price_per_share: number;
  gross_amount: number;
  fx_rate: number;
  fee: number;
  net_amount: number;
  tax_amount: number;
}

interface CapitalGainsRow {
  date: string;
  ticker: string;
  name: string;
  isin: string;
  country: string;
  fees_eur: number;
  quantity: number;
  cost_basis_eur: number;
  proceeds_eur: number;
  capital_gains_eur: number;
}

interface InvestmentTrade {
  row_index: number;
  date: string;           // YYYY-MM-DD
  datetime: string;       // original DD/MM/YYYY HH:MM:SS for matching
  reference: string;
  ticker: string;
  isin: string;
  type: "Buy" | "Sell";
  quantity: number;
  ccy: string;
  price_per_share: number;
  gross_amount_ccy: number;
  eur_amount: number;     // amount in EUR (after FX if applicable)
  fee_eur: number;
  fx_rate: number | null;
  fx_fee_eur: number;     // FX conversion fee
  conversion_ref: string | null;
  conversion_row_indexes: number[];
  cash_equivalent: boolean;
}

function parseNumber(s: string): number {
  if (!s || s.trim() === "") return 0;
  // Lightyear exports US-formatted numbers (thousands separator = comma,
  // decimal = dot). Strip commas before parseFloat.
  const parsed = parseFloat(s.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unparseable numeric value: "${s}"`);
  }
  return parsed;
}

const KNOWN_LIGHTYEAR_TYPES = new Set<AccountStatementRow["type"]>([
  "Buy", "Sell", "Conversion", "Deposit", "Withdrawal", "Distribution", "Dividend", "Interest", "Reward",
]);

function validateLightyearType(value: string): AccountStatementRow["type"] {
  if (KNOWN_LIGHTYEAR_TYPES.has(value as AccountStatementRow["type"])) {
    return value as AccountStatementRow["type"];
  }
  process.stderr.write(`WARNING: Unknown Lightyear transaction type: "${value}" — treating as-is, may be skipped by filters\n`);
  return value as AccountStatementRow["type"];
}

function parseLightyearDate(d: string): string {
  // DD/MM/YYYY HH:MM:SS -> YYYY-MM-DD
  const parts = d.split(" ")[0]!.split("/");
  if (parts.length === 3 && parts[2]!.length === 4) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return d;
}

function validateHeaders(actual: string[], expected: string[], label: string): void {
  if (actual.length < expected.length) {
    throw new Error(
      `${label}: expected ${expected.length} columns, got ${actual.length}. ` +
      `Expected: ${expected.join(", ")}`
    );
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i]!.trim() !== expected[i]) {
      throw new Error(
        `${label}: column ${i + 1} expected "${expected[i]}", got "${actual[i]!.trim()}". ` +
        `File may not be a valid Lightyear export.`
      );
    }
  }
}

async function readCsvFile(filePath: string): Promise<string> {
  const { path, cleanup } = await resolveFileInput(filePath, [".csv"], MAX_CSV_SIZE);
  try {
    return await readFile(path, "utf-8");
  } finally {
    if (cleanup) await cleanup();
  }
}

function parseAccountStatement(csv: string): AccountStatementRow[] {
  const lines = csv.split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Validate headers
  const headers = parseCSVLine(lines[0]!);
  validateHeaders(headers, EXPECTED_STATEMENT_HEADERS, "Account Statement CSV");

  const rows: AccountStatementRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]!);
    if (fields.length < 13) {
      throw new Error(`Account Statement CSV row ${i + 1}: expected 13 columns, got ${fields.length}`);
    }

    rows.push({
      row_index: i - 1,
      date: fields[0]!,
      reference: fields[1]!,
      ticker: fields[2]!,
      isin: fields[3]!,
      type: validateLightyearType(fields[4]!),
      quantity: parseNumber(fields[5]!),
      ccy: fields[6]!,
      price_per_share: parseNumber(fields[7]!),
      gross_amount: parseNumber(fields[8]!),
      fx_rate: parseNumber(fields[9]!),
      fee: parseNumber(fields[10]!),
      net_amount: parseNumber(fields[11]!),
      tax_amount: parseNumber(fields[12]!),
    });
  }
  return rows;
}

function isCashEquivalentTicker(ticker: string): boolean {
  return KNOWN_CASH_EQUIVALENT_TICKERS.has(ticker);
}

function fxFeeToEur(eurConv: AccountStatementRow, fgnConv: AccountStatementRow): number {
  const eurSideFee = Math.abs(eurConv.fee);
  if (eurSideFee > 0) return eurSideFee;

  const foreignSideFee = Math.abs(fgnConv.fee);
  if (foreignSideFee <= 0) return 0;

  if (fgnConv.fx_rate > 0) return roundMoney(foreignSideFee * fgnConv.fx_rate);
  if (eurConv.fx_rate > 0) return roundMoney(foreignSideFee / eurConv.fx_rate);
  return 0;
}

function getStatementRowCashDelta(row: AccountStatementRow): { currency: string; amount: number } | null {
  if (!row.ccy) return null;

  switch (row.type) {
    case "Buy":
      return { currency: row.ccy, amount: -Math.abs(row.net_amount || row.gross_amount) };
    case "Sell":
      return { currency: row.ccy, amount: Math.abs(row.net_amount || row.gross_amount) };
    default:
      return { currency: row.ccy, amount: row.net_amount };
  }
}

function addCashDelta(target: Map<string, number>, currency: string, amount: number): void {
  if (!currency || Math.abs(amount) < 0.000001) return;
  target.set(currency, roundMoney((target.get(currency) ?? 0) + amount));
}

function cashMapToObject(map: Map<string, number>): Record<string, number> {
  // Sub-cent residuals are treated as balanced — is_balanced uses the same 0.01 threshold.
  return Object.fromEntries(
    [...map.entries()]
      .map(([currency, amount]): [string, number] => [currency, roundMoney(amount)])
      .filter(([, amount]) => Math.abs(amount) >= 0.01)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function reconcileHandledStatementCash(
  rows: AccountStatementRow[],
  handledRowIndexes: Set<number>,
  ignoredRowIndexes: Set<number> = new Set(),
) {
  const totalByCurrency = new Map<string, number>();
  const handledByCurrency = new Map<string, number>();
  const gapByCurrency = new Map<string, number>();

  for (const row of rows) {
    if (ignoredRowIndexes.has(row.row_index)) continue;
    const delta = getStatementRowCashDelta(row);
    if (!delta) continue;
    addCashDelta(totalByCurrency, delta.currency, delta.amount);
    if (handledRowIndexes.has(row.row_index)) {
      addCashDelta(handledByCurrency, delta.currency, delta.amount);
    }
  }

  const currencies = new Set([
    ...totalByCurrency.keys(),
    ...handledByCurrency.keys(),
  ]);
  for (const currency of currencies) {
    addCashDelta(
      gapByCurrency,
      currency,
      (totalByCurrency.get(currency) ?? 0) - (handledByCurrency.get(currency) ?? 0),
    );
  }

  return {
    total_by_currency: cashMapToObject(totalByCurrency),
    handled_by_currency: cashMapToObject(handledByCurrency),
    gap_by_currency: cashMapToObject(gapByCurrency),
    ignored_rows: ignoredRowIndexes.size,
    is_balanced: [...gapByCurrency.values()].every((amount) => Math.abs(amount) < 0.01),
  };
}

function parseCapitalGains(csv: string): CapitalGainsRow[] {
  const lines = csv.split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Validate headers
  const headers = parseCSVLine(lines[0]!);
  validateHeaders(headers, EXPECTED_GAINS_HEADERS, "Capital Gains CSV");

  const rows: CapitalGainsRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]!);
    if (fields.length < 10) {
      throw new Error(`Capital Gains CSV row ${i + 1}: expected 10 columns, got ${fields.length}`);
    }

    rows.push({
      date: fields[0]!,
      ticker: fields[1]!,
      name: fields[2]!,
      isin: fields[3]!,
      country: fields[4]!,
      fees_eur: parseNumber(fields[5]!),
      quantity: parseNumber(fields[6]!),
      cost_basis_eur: parseNumber(fields[7]!),
      proceeds_eur: parseNumber(fields[8]!),
      capital_gains_eur: parseNumber(fields[9]!),
    });
  }
  return rows;
}

/**
 * Extract investment and cash-equivalent trades from the account statement.
 * Pairs Buy/Sell orders with their FX Conversion entries (for USD trades).
 * Consumed conversions are tracked to prevent double-matching.
 */
interface TradeExtractionResult {
  trades: InvestmentTrade[];
  warnings: string[];
  consumedConversionRefs: Set<string>;
}

function extractTrades(rows: AccountStatementRow[]): TradeExtractionResult {
  // Index conversion rows by reference for quick lookup
  const conversionsByRef = new Map<string, AccountStatementRow[]>();
  for (const row of rows) {
    if (row.type === "Conversion") {
      const existing = conversionsByRef.get(row.reference) ?? [];
      existing.push(row);
      conversionsByRef.set(row.reference, existing);
    }
  }

  // Track consumed conversion references to prevent reuse
  const consumedConversions = new Set<string>();
  const fxWarnings: string[] = [];

  const trades: InvestmentTrade[] = [];

  for (const row of rows) {
    if (row.type !== "Buy" && row.type !== "Sell") continue;

    const trade: InvestmentTrade = {
      row_index: row.row_index,
      date: parseLightyearDate(row.date),
      datetime: row.date,
      reference: row.reference,
      ticker: row.ticker,
      isin: row.isin,
      type: row.type,
      quantity: row.quantity,
      ccy: row.ccy,
      price_per_share: row.price_per_share,
      gross_amount_ccy: Math.abs(row.gross_amount),
      eur_amount: 0,
      fee_eur: row.fee,
      fx_rate: null,
      fx_fee_eur: 0,
      conversion_ref: null,
      conversion_row_indexes: [],
      cash_equivalent: isCashEquivalentTicker(row.ticker),
    };

    if (row.ccy === "EUR") {
      // EUR trade - amount is directly in EUR
      trade.eur_amount = Math.abs(row.gross_amount);
    } else {
      // Foreign currency trade - find the paired Conversion entry
      // Lightyear pairs: CN-xxx has two rows (EUR side + foreign currency side)
      // The foreign currency amount matches the trade's gross_amount
      let fxMatched = false;
      const orderDatePrefix = row.date.split(/[\sT]/)[0]; // date portion (DD/MM/YYYY or ISO)

      // Collect all candidate conversions to detect ambiguity
      const candidates: Array<{ ref: string; eurConv: AccountStatementRow; fgnConv: AccountStatementRow }> = [];
      for (const [ref, convRows] of conversionsByRef) {
        if (consumedConversions.has(ref)) continue;

        const eurConv = convRows.find(c => c.ccy === "EUR");
        const fgnConv = convRows.find(c => c.ccy === row.ccy);

        if (eurConv && fgnConv) {
          const convDatePrefix = fgnConv.date.split(/[\sT]/)[0];
          if (convDatePrefix !== orderDatePrefix) continue;

          if (Math.abs(Math.abs(fgnConv.gross_amount) - Math.abs(row.gross_amount)) < 0.02) {
            candidates.push({ ref, eurConv, fgnConv });
          }
        }
      }

      if (candidates.length > 1) {
        fxWarnings.push(
          `${row.reference} (${row.ticker} ${row.ccy} ${Math.abs(row.gross_amount)}): ` +
          `${candidates.length} FX conversions match by date+amount — SKIPPED (ambiguous). ` +
          `Refs: ${candidates.map(c => c.ref).join(", ")}`
        );
        // Do NOT pick a candidate — leave eur_amount = 0 so trade is flagged as unmatched
      } else if (candidates.length === 1) {
        const best = candidates[0]!;
        // Use net_amount (gross minus FX fee) — the actual EUR leaving the account.
        // gross_amount is the EUR equivalent before FX fee deduction.
        trade.eur_amount = Math.abs(best.eurConv.net_amount);
        trade.fx_rate = best.eurConv.fx_rate || best.fgnConv.fx_rate || null;
        trade.fx_fee_eur = fxFeeToEur(best.eurConv, best.fgnConv);
        trade.conversion_ref = best.ref;
        trade.conversion_row_indexes = [best.eurConv.row_index, best.fgnConv.row_index];
        consumedConversions.add(best.ref);
        fxMatched = true;
      }

      if (!fxMatched) {
        fxWarnings.push(`${trade.reference}: no FX conversion found for ${trade.ccy} trade`);
      }
    }

    trades.push(trade);
  }

  // Sort by date ascending
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.datetime.localeCompare(b.datetime));
  return { trades, warnings: fxWarnings, consumedConversionRefs: consumedConversions };
}

/**
 * Extract distribution (dividend/interest) entries.
 */
function extractDistributions(rows: AccountStatementRow[]): Array<{
  row_index: number;
  date: string;
  reference: string;
  type: AccountStatementRow["type"];
  ticker: string;
  isin: string;
  gross_amount: number;
  fee: number;
  net_amount: number;
  tax_amount: number;
}> {
  return rows
    .filter(r => r.type === "Distribution" || r.type === "Dividend" || r.type === "Interest" || r.type === "Reward")
    .map(r => ({
      row_index: r.row_index,
      date: parseLightyearDate(r.date),
      reference: r.reference,
      type: r.type,
      ticker: r.ticker,
      isin: r.isin,
      gross_amount: r.gross_amount,
      fee: r.fee,
      net_amount: r.net_amount,
      tax_amount: r.tax_amount,
    }));
}

interface LightyearRefLookup {
  reference: string;
  date: string;
}

async function findExistingJournalsByRef(
  api: ApiContext,
  lookups: LightyearRefLookup[],
): Promise<Set<string>> {
  if (lookups.length === 0) return new Set();

  const allJournals = await api.journals.listAll();
  const existing = new Set<string>();

  // Two document_number forms:
  // - `LY:{ref}` — our canonical prefix. Collision-free with hand-entered
  //   journals (the `LY:` namespace is ours), so a match is authoritative.
  // - Raw `{ref}` — legacy. Lightyear references use fixed prefixes (OR-, CN-,
  //   DT-, WL-, IN-, RW-) but a hand-entered journal could accidentally use
  //   the same string. Require the journal's effective_date to match the
  //   trade date before treating a raw match as a duplicate. Without the
  //   date cross-check, a pasted broker reference on an unrelated journal
  //   would silently suppress a real import.
  const prefixedTargets = new Set(lookups.map(l => `LY:${l.reference}`));
  const rawRefToDate = new Map(lookups.map(l => [l.reference, l.date]));

  for (const journal of allJournals) {
    if (journal.is_deleted) continue;
    if (!journal.document_number) continue;
    const documentNumber = String(journal.document_number).trim();

    if (prefixedTargets.has(documentNumber)) {
      existing.add(documentNumber.substring(3));
      continue;
    }

    const expectedDate = rawRefToDate.get(documentNumber);
    if (expectedDate !== undefined) {
      // Raw-ref match: require date alignment as a cross-check.
      if (journal.effective_date === expectedDate) {
        existing.add(documentNumber);
      }
    }
  }

  return existing;
}

/**
 * Match sell trades to capital gains entries by date + ticker + quantity + proceeds.
 *
 * Disambiguation rules:
 * - Exactly one exact match (date+ticker+qty+proceeds within 0.02 EUR) → pair.
 * - Multiple exact matches → SKIP the sell with an ambiguity warning. Earlier
 *   versions would `break` on the first exact proceeds match and silently
 *   pick whichever came first in CSV order; two identical-proceeds lots
 *   could collide without detection.
 * - No exact match, exactly one inexact match (date+ticker+qty only, proceeds
 *   differ) → pair with a warning so the user can cross-check cost basis.
 * - Multiple inexact matches → SKIP with ambiguity warning.
 */
function matchSellsToCapitalGains(
  sells: InvestmentTrade[],
  gains: CapitalGainsRow[],
  warnings: string[] = []
): Map<string, CapitalGainsRow> {
  const result = new Map<string, CapitalGainsRow>();
  const consumedGains = new Set<number>();

  for (const sell of sells) {
    const exactMatches: number[] = [];
    const inexactMatches: number[] = [];

    for (let i = 0; i < gains.length; i++) {
      if (consumedGains.has(i)) continue;
      const gain = gains[i]!;
      const gainDate = parseLightyearDate(gain.date);

      if (gainDate !== sell.date) continue;
      if (gain.ticker !== sell.ticker) continue;
      if (Math.abs(gain.quantity - sell.quantity) >= 0.000001) continue;

      if (Math.abs(gain.proceeds_eur - sell.eur_amount) < 0.02) {
        exactMatches.push(i);
      } else {
        inexactMatches.push(i);
      }
    }

    if (exactMatches.length === 1) {
      const idx = exactMatches[0]!;
      result.set(sell.reference, gains[idx]!);
      consumedGains.add(idx);
    } else if (exactMatches.length > 1) {
      warnings.push(
        `Ambiguous FIFO match for sell ${sell.reference} (${sell.ticker} x${sell.quantity} on ${sell.date}): ` +
        `${exactMatches.length} gains rows match date+ticker+qty+proceeds exactly. Skipping — verify cost basis manually and book the journal by hand.`
      );
      // Don't book — ambiguous cost basis is worse than missing it.
    } else if (inexactMatches.length === 1) {
      const idx = inexactMatches[0]!;
      const gain = gains[idx]!;
      warnings.push(
        `Inexact FIFO match for sell ${sell.reference} (${sell.ticker} x${sell.quantity} on ${sell.date}): ` +
        `proceeds differ (sell ${sell.eur_amount} EUR vs gains ${gain.proceeds_eur} EUR, likely FX rounding). ` +
        `Using date+ticker+qty match; verify cost basis.`
      );
      result.set(sell.reference, gains[idx]!);
      consumedGains.add(idx);
    } else if (inexactMatches.length > 1) {
      warnings.push(
        `Ambiguous FIFO match for sell ${sell.reference} (${sell.ticker} x${sell.quantity} on ${sell.date}): ` +
        `${inexactMatches.length} gains rows match date+ticker+qty but none match proceeds within 0.02 EUR. Skipping — resolve manually.`
      );
    }
  }

  return result;
}

export function registerLightyearTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "parse_lightyear_statement",
    "Parse a Lightyear account statement CSV. Extracts investment trades (Buy/Sell), " +
    "distributions, deposits, withdrawals, and cash reconciliation gaps. " +
    "Pairs foreign currency trades with their FX conversion entries. " +
    "Returns summary by default — set include_rows=true for individual trade/distribution details.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file. Also accepts a base64 payload (\"base64:csv:<data>\") for cross-system file transfer from remote MCP clients."),
      date_from: z.string().optional().describe("Only include entries from this date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Only include entries up to this date (YYYY-MM-DD)"),
      include_rows: z.boolean().optional().describe("Include individual trade/distribution rows (default false — summary only)"),
    },
    { ...readOnly, openWorldHint: true, title: "Parse Lightyear Account Statement" },
    async ({ file_path, date_from, date_to, include_rows }) => {
      const csv = await readCsvFile(file_path);
      let rows = parseAccountStatement(csv);

      // Apply date filters
      if (date_from || date_to) {
        rows = rows.filter(r => {
          const d = parseLightyearDate(r.date);
          if (date_from && d < date_from) return false;
          if (date_to && d > date_to) return false;
          return true;
        });
      }
      const {
        trades,
        warnings: fxWarnings,
      } = extractTrades(rows);
      const distributions = extractDistributions(rows);
      const bookableTrades = trades.filter(t => !t.cash_equivalent);
      const cashEquivalentTrades = trades.filter(t => t.cash_equivalent);

      // Summarize deposits/withdrawals
      const deposits = rows.filter(r => r.type === "Deposit");
      const withdrawals = rows.filter(r => r.type === "Withdrawal");

      // Find rows not handled by any extraction
      const handledRowIndexes = new Set<number>([
        ...bookableTrades.map(t => t.row_index),
        ...bookableTrades.flatMap(t => t.conversion_row_indexes),
        ...distributions.map(d => d.row_index),
        ...deposits.map(r => r.row_index),
        ...withdrawals.map(r => r.row_index),
      ]);

      const ignoredRowIndexes = new Set<number>([
        ...cashEquivalentTrades.map(t => t.row_index),
        ...cashEquivalentTrades.flatMap(t => t.conversion_row_indexes),
      ]);

      // When cash-equivalent trades are intentionally excluded from booking, their
      // internal sweep activity should not trigger a false reconciliation error.
      const cashReconciliation = reconcileHandledStatementCash(rows, handledRowIndexes, ignoredRowIndexes);
      const unhandled = rows.filter(r => !handledRowIndexes.has(r.row_index) && !ignoredRowIndexes.has(r.row_index));
      const unhandledSuggestions = unhandled.map(r => {
        let suggestion = "Review manually";
        if (r.type === "Conversion") suggestion = "Unpaired FX conversion — likely matches a reward, deposit, withdrawal, or manual trade. Review before booking so broker cash stays reconciled; book FX gain/loss if material.";
        else if (r.type === "Reward") suggestion = "Platform reward — book via book_lightyear_distributions (defaults to 8600 Muud äritulud).";
        else if (r.type === "Interest") suggestion = "Interest income — book via book_lightyear_distributions.";
        else if (r.type === "Dividend" || r.type === "Distribution") suggestion = "Distribution — book via book_lightyear_distributions.";
        else if (r.type === "Buy" || r.type === "Sell") suggestion = `${r.type} of ${r.ticker} — missing FX pairing or unsupported trade flow. Check if intentional.`;
        return {
          date: parseLightyearDate(r.date),
          reference: r.reference,
          type: r.type,
          ticker: r.ticker || undefined,
          ccy: r.ccy,
          gross_amount: r.gross_amount,
          fee: r.fee,
          suggestion,
        };
      });

      // Check for unmatched FX trades
      const unmatchedFx = bookableTrades.filter(t => t.ccy !== "EUR" && t.eur_amount === 0);

      // Group trades by ticker
      const byTicker = new Map<string, InvestmentTrade[]>();
      for (const t of bookableTrades) {
        const list = byTicker.get(t.ticker) ?? [];
        list.push(t);
        byTicker.set(t.ticker, list);
      }
      const skippedCashEquivalentByTicker = new Map<string, InvestmentTrade[]>();
      for (const t of cashEquivalentTrades) {
        const list = skippedCashEquivalentByTicker.get(t.ticker) ?? [];
        list.push(t);
        skippedCashEquivalentByTicker.set(t.ticker, list);
      }

      const summary: Record<string, { buys: number; sells: number; total_invested_eur: number; total_sold_eur: number }> = {};
      for (const [ticker, tickerTrades] of byTicker) {
        const buys = tickerTrades.filter(t => t.type === "Buy");
        const sells = tickerTrades.filter(t => t.type === "Sell");
        summary[ticker] = {
          buys: buys.length,
          sells: sells.length,
          total_invested_eur: roundMoney(buys.reduce((s, t) => {
            const tradeFeeEur = t.fee_eur > 0 && t.fx_rate ? t.fee_eur / t.fx_rate : t.fee_eur;
            return s + t.eur_amount + tradeFeeEur; // FX fee excluded (matches Lightyear CG report)
          }, 0)),
          total_sold_eur: roundMoney(sells.reduce((s, t) => s + t.eur_amount, 0)),
        };
      }
      const skippedCashEquivalentSummary: Record<string, { buys: number; sells: number }> = {};
      for (const [ticker, tickerTrades] of skippedCashEquivalentByTicker) {
        skippedCashEquivalentSummary[ticker] = {
          buys: tickerTrades.filter(t => t.type === "Buy").length,
          sells: tickerTrades.filter(t => t.type === "Sell").length,
        };
      }

      const warnings: string[] = [...fxWarnings];
      if (unmatchedFx.length > 0) {
        warnings.push(
          `${unmatchedFx.length} foreign currency trade(s) could not be matched to FX conversion entries: ` +
          unmatchedFx.map(t => `${t.reference} (${t.ticker} ${t.ccy})`).join(", ")
        );
      }
      if (!cashReconciliation.is_balanced) {
        warnings.push(
          `Statement cash reconciliation is not balanced. Unhandled cash impact remains in: ` +
          Object.entries(cashReconciliation.gap_by_currency)
            .map(([currency, amount]) => `${currency} ${amount}`)
            .join(", ")
        );
      }

      const summaryJson = {
        total_rows: rows.length,
        ...(date_from && { date_from }),
        ...(date_to && { date_to }),
        trades: { count: bookableTrades.length, by_ticker: summary },
        ...(cashEquivalentTrades.length > 0 && {
          cash_equivalent_skipped: {
            count: cashEquivalentTrades.length,
            by_ticker: skippedCashEquivalentSummary,
            note: "Cash-equivalent buy/sell rows are intentionally excluded from booking and cash reconciliation by default.",
          },
        }),
        distributions: {
          count: distributions.length,
          total_eur: roundMoney(distributions.reduce((s, d) => s + d.gross_amount, 0)),
        },
        deposits: {
          count: deposits.length,
          total_eur: roundMoney(deposits.reduce((s, r) => s + r.gross_amount, 0)),
        },
        withdrawals: {
          count: withdrawals.length,
          total_eur: roundMoney(withdrawals.reduce((s, r) => s + Math.abs(r.gross_amount), 0)),
        },
        cash_reconciliation: cashReconciliation,
        ...(unhandledSuggestions.length > 0 && {
          unhandled: {
            count: unhandledSuggestions.length,
            rows: unhandledSuggestions,
          },
        }),
        ...((!cashReconciliation.is_balanced || unhandledSuggestions.length > 0) && {
          needs_review: true,
        }),
        ...(warnings.length > 0 && { warnings }),
      };

      if (!include_rows) {
        return {
          content: [{
            type: "text",
            text: toMcpJson({
              ...summaryJson,
              note: "Summary only. Use include_rows=true for individual trade details, or date_from/date_to to narrow the range.",
            }),
          }],
        };
      }

      // Compact markdown tables for LLM-friendly output
      const tradesTable = bookableTrades.length > 0
        ? `## Trades (${bookableTrades.length})\n\n| Date | Ref | Ticker | Type | Qty | CCY | EUR | Fee |\n|------|-----|--------|------|-----|-----|-----|-----|\n${bookableTrades.map(t => `| ${t.date} | ${t.reference} | ${t.ticker} | ${t.type} | ${t.quantity} | ${t.ccy} | ${t.eur_amount.toFixed(2)} | ${t.fee_eur.toFixed(2)} |`).join("\n")}`
        : "";

      const distRows = distributions.map(d =>
        `| ${d.date} | ${d.reference} | ${d.ticker || "—"} | ${d.gross_amount.toFixed(2)} | ${d.tax_amount.toFixed(2)} | ${d.net_amount.toFixed(2)} |`
      );
      const distTable = distributions.length > 0
        ? `## Distributions (${distributions.length})\n\n| Date | Ref | Ticker | Gross | Tax | Net |\n|------|-----|--------|-------|-----|-----|\n${distRows.join("\n")}`
        : "";

      const parts = [
        "```json\n" + JSON.stringify(summaryJson, null, 2) + "\n```",
        tradesTable,
        distTable,
      ].filter(Boolean);

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
      };
    }
  );

  registerTool(server, "parse_lightyear_capital_gains",
    "Parse a Lightyear Capital Gains Statement CSV (FIFO method). " +
    "Shows cost basis, proceeds, and realized capital gains per sale.",
    {
      file_path: z.string().describe("Absolute path to Lightyear CapitalGainsStatement CSV file"),
    },
    { ...readOnly, openWorldHint: true, title: "Parse Lightyear Capital Gains" },
    async ({ file_path }) => {
      const csv = await readCsvFile(file_path);
      const gains = parseCapitalGains(csv);

      const totalGains = gains.reduce((s, g) => s + g.capital_gains_eur, 0);
      const totalProceeds = gains.reduce((s, g) => s + g.proceeds_eur, 0);
      const totalCostBasis = gains.reduce((s, g) => s + g.cost_basis_eur, 0);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            sales: gains.map(g => ({
              date: parseLightyearDate(g.date),
              ticker: g.ticker,
              // Security `name` is the main free-text CSV field; ticker/isin/
              // country are structurally bounded tokens and do not meaningfully
              // expand prompt-injection surface.
              name: wrapUntrustedOcr(g.name),
              isin: g.isin,
              country: g.country,
              quantity: g.quantity,
              cost_basis_eur: roundMoney(g.cost_basis_eur),
              proceeds_eur: roundMoney(g.proceeds_eur),
              capital_gains_eur: roundMoney(g.capital_gains_eur),
              fees_eur: g.fees_eur,
            })),
            totals: {
              cost_basis_eur: roundMoney(totalCostBasis),
              proceeds_eur: roundMoney(totalProceeds),
              capital_gains_eur: roundMoney(totalGains),
              fees_eur: roundMoney(gains.reduce((s, g) => s + g.fees_eur, 0)),
            },
            note: "Capital gains calculated using FIFO method.",
          }),
        }],
      };
    }
  );

  registerTool(server, "book_lightyear_trades",
    "Create journal entries for Lightyear stock Buy/Sell trades. " +
    "Checks for duplicates using Lightyear reference IDs (stored as LY:{ref} in document_number). " +
    "For sells: requires capital_gains_file to determine cost basis and recognized gain/loss. " +
    "Without it, sells are skipped with a warning.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file. Also accepts a base64 payload (\"base64:csv:<data>\") for cross-system file transfer from remote MCP clients."),
      capital_gains_file: z.string().optional().describe("Absolute path to Lightyear CapitalGainsStatement CSV (required for sell entries)"),
      investment_account: z.number().describe("Investment/securities account (e.g. 1550 Finantsinvesteeringud)"),
      investment_dimension_id: z.number().optional().describe("Dimension ID for investment account (accounts_dimensions_id)"),
      broker_account: z.number().describe("Broker cash account (e.g. 1120 Lightyear konto)"),
      broker_dimension_id: z.number().optional().describe("Dimension ID for broker account (accounts_dimensions_id)"),
      gain_loss_account: z.number().optional().describe("Realized gain account (credit for gains; also used for losses if loss_account not set)"),
      loss_account: z.number().optional().describe("Realized loss account (debit for losses). If omitted, losses go to gain_loss_account."),
      fee_account: z.number().optional().describe("Fee expense account (default: fees included in investment cost)"),
      skip_tickers: z.string().optional().describe("Comma-separated tickers to skip (default: BRICEKSP, ICSUSSDP). Pass \"none\" to disable; the empty string is treated as the default."),
      dry_run: z.boolean().optional().describe("Preview without creating entries (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Book Lightyear Trades" },
    async ({ file_path, capital_gains_file, investment_account, investment_dimension_id, broker_account, broker_dimension_id, gain_loss_account, loss_account, fee_account, skip_tickers, dry_run }) => {
      const isDryRun = dry_run !== false;
      const skipInput = skip_tickers?.trim() || [...KNOWN_CASH_EQUIVALENT_TICKERS].join(",");
      const skipSet = skipInput.toLowerCase() === "none"
        ? new Set<string>()
        : new Set(skipInput.split(",").map(t => t.trim()).filter(Boolean));

      // Validate accounts exist and are active
      const accounts = await api.readonly.getAccounts();
      const errors = validateAccounts(accounts, [
        { id: investment_account, label: "Investment account" },
        { id: broker_account, label: "Broker account" },
        ...(fee_account ? [{ id: fee_account, label: "Fee account" }] : []),
        ...(gain_loss_account ? [{ id: gain_loss_account, label: "Gain/loss account" }] : []),
        ...(loss_account ? [{ id: loss_account, label: "Loss account" }] : []),
      ]);

      if (errors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: errors,
          hint: "Use list_accounts to find correct account numbers.",
        });
      }

      const csv = await readCsvFile(file_path);
      const rows = parseAccountStatement(csv);
      const extraction = extractTrades(rows);
      const trades = extraction.trades.filter(t => !skipSet.has(t.ticker));

      // Parse capital gains if provided
      let gainsMap = new Map<string, CapitalGainsRow>();
      const gainsWarnings: string[] = [];
      if (capital_gains_file) {
        const gainsCsv = await readCsvFile(capital_gains_file);
        const gainsRows = parseCapitalGains(gainsCsv);
        const sells = trades.filter(t => t.type === "Sell");
        gainsMap = matchSellsToCapitalGains(sells, gainsRows, gainsWarnings);
      }

      // Check for duplicates
      const allRefs = trades.map(t => ({ reference: t.reference, date: t.date }));
      const existingRefs = await findExistingJournalsByRef(api, allRefs);

      const newTrades = trades.filter(t => !existingRefs.has(t.reference));
      const duplicates = trades.filter(t => existingRefs.has(t.reference));

      const results: Array<{
        reference: string;
        ticker: string;
        type: string;
        date: string;
        eur_amount: number;
        status: string;
        journal_id?: number;
        cost_basis?: number;
        gain_loss?: number;
        skip_reason?: string;
      }> = [];

      const warnings: string[] = [...extraction.warnings, ...gainsWarnings];
      const totalNewTrades = newTrades.length;

      for (let tradeIdx = 0; tradeIdx < newTrades.length; tradeIdx++) {
        const trade = newTrades[tradeIdx]!;
        await reportProgress(tradeIdx, totalNewTrades);
        // Skip unmatched FX trades
        if (trade.ccy !== "EUR" && trade.eur_amount === 0) {
          results.push({
            reference: trade.reference,
            ticker: trade.ticker,
            type: trade.type,
            date: trade.date,
            eur_amount: 0,
            status: "skipped",
            skip_reason: `No matching FX conversion found for ${trade.ccy} trade`,
          });
          continue;
        }

        // eur_amount is the EUR conversion net (after FX fee deduction).
        // fx_fee_eur is the FX conversion fee. trade.fee_eur is the trade platform fee.
        const tradeFeeEur = trade.fee_eur > 0 && trade.fx_rate
          ? roundMoney(trade.fee_eur / trade.fx_rate)
          : trade.fee_eur;
        const postings: Array<{ accounts_id: number; accounts_dimensions_id?: number; type: "D" | "C"; amount: number }> = [];

        if (trade.type === "Buy") {
          // Investment cost = eur_amount (conversion net) + trade fee. FX fee is always
          // expensed separately — Lightyear's capital gains report does NOT include FX fees
          // in cost basis, so including them in the investment account would leave a residual
          // balance on every sell.
          const feeAcct = fee_account ?? 8610;
          const totalFees = roundMoney(trade.fx_fee_eur + tradeFeeEur);
          const investmentCostEur = roundMoney(trade.eur_amount + tradeFeeEur);
          const totalCashOutEur = roundMoney(trade.eur_amount + totalFees);

          if (totalFees > 0) {
            postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "D", amount: trade.eur_amount });
            if (trade.fx_fee_eur > 0) {
              postings.push({ accounts_id: feeAcct, type: "D", amount: trade.fx_fee_eur });
            }
            if (tradeFeeEur > 0) {
              postings.push({ accounts_id: feeAcct, type: "D", amount: tradeFeeEur });
            }
            postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "C", amount: totalCashOutEur });
          } else {
            postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "D", amount: investmentCostEur });
            postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "C", amount: investmentCostEur });
          }
        } else {
          // Sell: need cost basis from capital gains file
          const gainEntry = gainsMap.get(trade.reference);

          if (!gainEntry && trade.cash_equivalent) {
            // Capital gains CSV does not cover cash-equivalent sweeps. For EUR-denominated
            // sweeps (e.g. BRICEKSP) proceeds equal cost basis 1:1 so we can book them
            // directly as break-even. For non-EUR sweeps (e.g. ICSUSSDP in USD) the FX
            // rate on buy vs sell differs, so booking proceeds as the investment credit
            // would leave permanent FX drift on the investment account. Skip those.
            if (trade.ccy !== "EUR") {
              results.push({
                reference: trade.reference,
                ticker: trade.ticker,
                type: trade.type,
                date: trade.date,
                eur_amount: trade.eur_amount,
                status: "skipped",
                skip_reason: `Non-EUR cash-equivalent sell (${trade.ccy}) needs a cost-basis source to avoid FX drift. Provide capital_gains_file entry for ${trade.reference} or remove ${trade.ticker} from skip_tickers only when cost basis is known.`,
              });
              continue;
            }

            const proceeds = roundMoney(trade.eur_amount);

            postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "D", amount: proceeds });
            postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "C", amount: proceeds });

            const sellTradeFees = tradeFeeEur;
            if (sellTradeFees > 0) {
              const feeAcct = fee_account ?? 8610;
              postings.push({ accounts_id: feeAcct, type: "D", amount: sellTradeFees });
              postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "C", amount: sellTradeFees });
            }

            const resultEntry: typeof results[number] = {
              reference: trade.reference,
              ticker: trade.ticker,
              type: trade.type,
              date: trade.date,
              eur_amount: proceeds,
              status: isDryRun ? "would_create" : "created",
              cost_basis: proceeds,
              gain_loss: 0,
            };

            if (isDryRun) {
              results.push(resultEntry);
              continue;
            }

            const fxInfo = trade.fx_rate ? ` (${trade.ccy} FX ${trade.fx_rate})` : "";
            const title = `Lightyear Cash-Equivalent Sell: ${trade.quantity.toFixed(6)} ${trade.ticker}${fxInfo}`;

            const journal = await api.journals.create({
              title,
              effective_date: trade.date,
              cl_currencies_id: "EUR",
              document_number: `LY:${trade.reference}`,
              postings,
            });
            logAudit({
              tool: "book_lightyear_trades", action: "CREATED", entity_type: "journal",
              entity_id: journal.created_object_id,
              summary: `Lightyear cash-equivalent sell: ${trade.ticker} ${trade.quantity} @ ${proceeds} EUR`,
              details: {
                effective_date: trade.date, ticker: trade.ticker, type: "Sell",
                amount: proceeds, gain_loss: 0,
                postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
              },
            });

            resultEntry.journal_id = journal.created_object_id;
            results.push(resultEntry);
            continue;
          }

          if (!gainEntry) {
            // No capital gains data — skip this sell
            results.push({
              reference: trade.reference,
              ticker: trade.ticker,
              type: trade.type,
              date: trade.date,
              eur_amount: trade.eur_amount,
              status: "skipped",
              skip_reason: "No capital gains data. Provide capital_gains_file to book sells with correct cost basis.",
            });
            continue;
          }

          if (!gain_loss_account) {
            results.push({
              reference: trade.reference,
              ticker: trade.ticker,
              type: trade.type,
              date: trade.date,
              eur_amount: trade.eur_amount,
              status: "skipped",
              skip_reason: "gain_loss_account is required for sell entries.",
            });
            continue;
          }

          const costBasis = roundMoney(gainEntry.cost_basis_eur);
          const proceeds = roundMoney(gainEntry.proceeds_eur);
          // Derive gain/loss so the journal balances by construction (CSV columns are independently rounded)
          const gainLoss = roundMoney(proceeds - costBasis);

          // Dr broker_account: proceeds (what we receive)
          // Cr investment_account: cost_basis (what we originally paid)
          // Cr/Dr gain_loss_account: gain (credit) or loss (debit)
          postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "D", amount: proceeds });
          postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "C", amount: costBasis });

          if (gainLoss > 0) {
            postings.push({ accounts_id: gain_loss_account, type: "C", amount: gainLoss });
          } else if (gainLoss < 0) {
            const lossAcct = loss_account ?? gain_loss_account;
            postings.push({ accounts_id: lossAcct, type: "D", amount: Math.abs(gainLoss) });
          }

          const sellFees = roundMoney(tradeFeeEur + trade.fx_fee_eur);
          if (sellFees > 0) {
            const feeAcct = fee_account ?? 8610;
            if (trade.fx_fee_eur > 0) {
              postings.push({ accounts_id: feeAcct, type: "D", amount: trade.fx_fee_eur });
            }
            if (tradeFeeEur > 0) {
              postings.push({ accounts_id: feeAcct, type: "D", amount: tradeFeeEur });
            }
            postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "C", amount: sellFees });
          }

          // Store cost basis info in result
          const resultEntry: typeof results[number] = {
            reference: trade.reference,
            ticker: trade.ticker,
            type: trade.type,
            date: trade.date,
            eur_amount: proceeds,
            status: isDryRun ? "would_create" : "created",
            cost_basis: costBasis,
            gain_loss: gainLoss,
          };

          if (isDryRun) {
            results.push(resultEntry);
            continue;
          }

          const fxInfo = trade.fx_rate ? ` (${trade.ccy} FX ${trade.fx_rate})` : "";
          const title = `Lightyear Sell: ${trade.quantity.toFixed(6)} ${trade.ticker}${fxInfo} kasum/kahjum ${gainLoss >= 0 ? "+" : ""}${gainLoss} EUR`;

          const journal = await api.journals.create({
            title,
            effective_date: trade.date,
            cl_currencies_id: "EUR",
            document_number: `LY:${trade.reference}`,
            postings,
          });
          logAudit({
            tool: "book_lightyear_trades", action: "CREATED", entity_type: "journal",
            entity_id: journal.created_object_id,
            summary: `Lightyear Sell: ${trade.ticker} ${trade.quantity} @ ${proceeds} EUR, gain/loss ${gainLoss} EUR`,
            details: {
              effective_date: trade.date, ticker: trade.ticker, type: "Sell",
              amount: proceeds, cost_basis: costBasis, gain_loss: gainLoss,
              postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
            },
          });

          resultEntry.journal_id = journal.created_object_id;
          results.push(resultEntry);
          continue;
        }

        // Buy entry creation
        const fxInfo = trade.fx_rate ? ` (${trade.ccy} FX ${trade.fx_rate})` : "";
        const title = `Lightyear Buy: ${trade.quantity.toFixed(6)} ${trade.ticker}${fxInfo}`;

        if (isDryRun) {
          results.push({
            reference: trade.reference,
            ticker: trade.ticker,
            type: trade.type,
            date: trade.date,
            eur_amount: trade.eur_amount,
            status: "would_create",
          });
        } else {
          const journal = await api.journals.create({
            title,
            effective_date: trade.date,
            cl_currencies_id: "EUR",
            document_number: `LY:${trade.reference}`,
            postings,
          });
          logAudit({
            tool: "book_lightyear_trades", action: "CREATED", entity_type: "journal",
            entity_id: journal.created_object_id,
            summary: `Lightyear Buy: ${trade.ticker} ${trade.quantity} @ ${trade.eur_amount} EUR`,
            details: {
              effective_date: trade.date, ticker: trade.ticker, type: "Buy",
              amount: trade.eur_amount,
              postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
            },
          });

          results.push({
            reference: trade.reference,
            ticker: trade.ticker,
            type: trade.type,
            date: trade.date,
            eur_amount: trade.eur_amount,
            status: "created",
            journal_id: journal.created_object_id,
          });
        }
      }

      const skippedSells = results.filter(r => r.status === "skipped" && r.type === "Sell");
      if (skippedSells.length > 0 && !capital_gains_file) {
        warnings.push(
          `${skippedSells.length} sell trade(s) skipped — provide capital_gains_file and gain_loss_account to book non-cash-equivalent sells with correct cost basis.`
        );
      }

      if (fee_account && capital_gains_file) {
        warnings.push(
          "fee_account is set: buy fees are expensed separately, but capital gains cost_basis includes fees. " +
          "The investment account balance may not match cost_basis exactly. Consider omitting fee_account to include fees in investment cost."
        );
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode: isDryRun ? "DRY_RUN" : "EXECUTED",
            total_trades: trades.length,
            new_entries: newTrades.length,
            created: results.filter(r => r.status === "created" || r.status === "would_create").length,
            skipped: results.filter(r => r.status === "skipped").length,
            duplicates_skipped: duplicates.length,
            duplicate_refs: duplicates.map(d => ({ reference: d.reference, ticker: d.ticker, date: d.date })),
            results,
            accounts: {
              investment: investment_account,
              broker: broker_account,
              gain: gain_loss_account ?? "not configured (sells will be skipped)",
              loss: loss_account ?? gain_loss_account ?? "not configured",
              fee: fee_account ?? "included in cost",
            },
            ...(warnings.length > 0 && { warnings }),
            note: isDryRun
              ? "Set dry_run=false to create journal entries."
              : "Journal entries created. Review and register (confirm) them when ready.",
          }),
        }],
      };
    }
  );

  registerTool(server, "book_lightyear_distributions",
    "Create journal entries for Lightyear dividend, interest, and reward distributions, including withheld tax. DRY RUN by default.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file. Also accepts a base64 payload (\"base64:csv:<data>\") for cross-system file transfer from remote MCP clients."),
      broker_account: z.number().describe("Broker cash account (e.g. 1120 Lightyear konto)"),
      broker_dimension_id: z.number().optional().describe("Dimension ID for broker account (accounts_dimensions_id)"),
      income_account: z.number().describe("Investment income account (e.g. 8320 Tulu fondiosakutelt, 8400 Intressitulu)"),
      reward_account: z.number().optional().describe("Account for platform rewards (default: 8600 Muud äritulud). Rewards are non-investment income."),
      tax_account: z.number().optional().describe("Withheld tax receivable/expense account (for tax_amount from CSV)"),
      fee_account: z.number().optional().describe("Platform fee expense account (default 8610 Muud finantskulud)"),
      dry_run: z.boolean().optional().describe("Preview without creating entries (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Book Lightyear Distributions" },
    async ({ file_path, broker_account, broker_dimension_id, income_account, reward_account: reward_account_param, tax_account, fee_account: fee_account_param, dry_run }) => {
      const isDryRun = dry_run !== false;
      const fee_account = fee_account_param ?? 8610;
      const reward_account = reward_account_param ?? 8600;

      // Validate accounts exist and are active
      const accounts = await api.readonly.getAccounts();
      const errors = validateAccounts(accounts, [
        { id: broker_account, label: "Broker account" },
        { id: income_account, label: "Income account" },
        { id: reward_account, label: "Reward account" },
        ...(tax_account ? [{ id: tax_account, label: "Tax account" }] : []),
        { id: fee_account, label: "Fee account" },
      ]);

      if (errors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: errors,
        });
      }

      const csv = await readCsvFile(file_path);
      const rows = parseAccountStatement(csv);
      const distributions = extractDistributions(rows);

      if (!tax_account && distributions.some(dist => dist.tax_amount > 0)) {
        return toolError({
          error: "tax_account is required when distributions include withheld tax",
          hint: "Provide tax_account so tax_amount can be booked separately for Lightyear distributions.",
        });
      }

      // Check duplicates
      const allRefs = distributions.map(d => ({ reference: d.reference, date: d.date }));
      const existingRefs = await findExistingJournalsByRef(api, allRefs);

      const newDist = distributions.filter(d => !existingRefs.has(d.reference));
      const duplicates = distributions.filter(d => existingRefs.has(d.reference));

      const results: Array<{
        reference: string;
        ticker: string;
        date: string;
        gross_amount: number;
        tax_amount: number;
        fee: number;
        net_amount: number;
        status: string;
        journal_id?: number;
      }> = [];

      for (const dist of newDist) {
        const postings: Array<{ accounts_id: number; accounts_dimensions_id?: number; type: "D" | "C"; amount: number }> = [];

        // Dr broker_account: net received amount
        if (dist.net_amount > 0) {
          postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "D", amount: dist.net_amount });
        }

        // Dr tax_account: withheld tax (tax_amount from CSV, NOT fee)
        if (dist.tax_amount > 0 && tax_account) {
          postings.push({ accounts_id: tax_account, type: "D", amount: dist.tax_amount });
        }

        // Dr fee_account: platform fee (fee from CSV)
        if (dist.fee > 0) {
          postings.push({ accounts_id: fee_account, type: "D", amount: dist.fee });
        }

        // Cr income_account: gross amount (net + tax + fee)
        const creditAmount = roundMoney(dist.net_amount + dist.tax_amount + dist.fee);
        const isReward = dist.type === "Reward";
        postings.push({ accounts_id: isReward ? reward_account : income_account, type: "C", amount: creditAmount });

        const title = dist.ticker
          ? `Lightyear tulu: ${dist.ticker} (${dist.isin})`
          : `Lightyear tulu: ${dist.type === "Reward" ? "boonus" : "intress"}`;

        if (isDryRun) {
          results.push({
            reference: dist.reference,
            ticker: dist.ticker,
            date: dist.date,
            gross_amount: dist.gross_amount,
            tax_amount: dist.tax_amount,
            fee: dist.fee,
            net_amount: dist.net_amount,
            status: "would_create",
          });
        } else {
          const journal = await api.journals.create({
            title,
            effective_date: dist.date,
            cl_currencies_id: "EUR",
            document_number: `LY:${dist.reference}`,
            postings,
          });
          logAudit({
            tool: "book_lightyear_distributions", action: "CREATED", entity_type: "journal",
            entity_id: journal.created_object_id,
            summary: `Lightyear distribution: ${dist.ticker || "interest"} gross ${dist.gross_amount} EUR`,
            details: {
              effective_date: dist.date, ticker: dist.ticker,
              total_gross: dist.gross_amount, tax_amount: dist.tax_amount, fee: dist.fee, net_amount: dist.net_amount,
              postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
            },
          });

          results.push({
            reference: dist.reference,
            ticker: dist.ticker,
            date: dist.date,
            gross_amount: dist.gross_amount,
            tax_amount: dist.tax_amount,
            fee: dist.fee,
            net_amount: dist.net_amount,
            status: "created",
            journal_id: journal.created_object_id,
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode: isDryRun ? "DRY_RUN" : "EXECUTED",
            total_distributions: distributions.length,
            new_entries: newDist.length,
            duplicates_skipped: duplicates.length,
            results,
            note: isDryRun
              ? "Set dry_run=false to create journal entries."
              : "Journal entries created. Review and register when ready.",
          }),
        }],
      };
    }
  );

  registerTool(server, "lightyear_portfolio_summary",
    "Compute current holdings and cost basis from a Lightyear account statement. Useful for verifying investment account balance.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file. Also accepts a base64 payload (\"base64:csv:<data>\") for cross-system file transfer from remote MCP clients."),
    },
    { ...readOnly, openWorldHint: true, title: "Lightyear Portfolio Summary" },
    async ({ file_path }) => {
      const csv = await readCsvFile(file_path);
      const rows = parseAccountStatement(csv);
      const { trades, warnings: fxWarnings } = extractTrades(rows);

      // Check for unmatched FX trades that will have zero cost basis
      const unmatchedFx = trades.filter(t => t.ccy !== "EUR" && t.eur_amount === 0);
      const portfolioWarnings: string[] = [...fxWarnings];
      if (unmatchedFx.length > 0) {
        portfolioWarnings.push(
          `${unmatchedFx.length} foreign currency trade(s) have no matched FX conversion (eur_amount=0). ` +
          `Holdings and cost basis for affected tickers may be understated: ` +
          unmatchedFx.map(t => `${t.reference} (${t.ticker} ${t.type} ${t.quantity})`).join(", ")
        );
      }

      // Compute holdings using weighted average cost (WAC)
      const holdings = new Map<string, {
        ticker: string;
        isin: string;
        quantity: number;
        total_cost_eur: number;  // remaining cost basis (reduced on sells)
        total_proceeds_eur: number;
        realized_gain_loss_eur: number;
        buy_count: number;
        sell_count: number;
      }>();

      for (const trade of trades) {
        const h = holdings.get(trade.ticker) ?? {
          ticker: trade.ticker,
          isin: trade.isin,
          quantity: 0,
          total_cost_eur: 0,
          total_proceeds_eur: 0,
          realized_gain_loss_eur: 0,
          buy_count: 0,
          sell_count: 0,
        };

        if (trade.type === "Buy") {
          // Investment cost = eur_amount (conversion net) + trade fee.
          // FX fee is expensed, not part of cost basis (matches Lightyear CG report).
          const tradeFeeEur = trade.fee_eur > 0 && trade.fx_rate
            ? trade.fee_eur / trade.fx_rate
            : trade.fee_eur;
          h.total_cost_eur += trade.eur_amount + tradeFeeEur;
          h.quantity += trade.quantity;
          h.buy_count++;
        } else {
          // Sell: remove proportional cost basis using weighted average cost
          const tradeFeeEur = trade.fee_eur > 0 && trade.fx_rate
            ? trade.fee_eur / trade.fx_rate
            : trade.fee_eur;
          const proceeds = trade.eur_amount - tradeFeeEur;
          h.total_proceeds_eur += proceeds;
          h.sell_count++;

          if (h.quantity > 0.000001) {
            const avgCost = h.total_cost_eur / h.quantity;
            const soldCost = avgCost * trade.quantity;
            h.realized_gain_loss_eur += proceeds - soldCost;
            h.total_cost_eur -= soldCost;
          }
          h.quantity -= trade.quantity;
        }

        holdings.set(trade.ticker, h);
      }

      const portfolio = Array.from(holdings.values()).map(h => {
        const qtyHeld = Math.round(h.quantity * 1000000) / 1000000;
        return {
          ticker: h.ticker,
          isin: h.isin,
          quantity_held: qtyHeld,
          remaining_cost_eur: roundMoney(h.total_cost_eur),
          avg_cost_per_unit: qtyHeld > 0.000001
            ? roundMoney(h.total_cost_eur / h.quantity)
            : null,
          total_proceeds_eur: roundMoney(h.total_proceeds_eur),
          realized_gain_loss_eur: roundMoney(h.realized_gain_loss_eur),
          buys: h.buy_count,
          sells: h.sell_count,
          fully_sold: Math.abs(h.quantity) < 0.000001,
        };
      });

      const active = portfolio.filter(p => !p.fully_sold);
      const closed = portfolio.filter(p => p.fully_sold);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            active_holdings: active,
            closed_positions: closed,
            totals: {
              active_positions: active.length,
              total_remaining_cost_eur: roundMoney(active.reduce((s, p) => s + p.remaining_cost_eur, 0)),
              total_realized_gain_loss_eur: roundMoney(portfolio.reduce((s, p) => s + p.realized_gain_loss_eur, 0)),
              closed_positions: closed.length,
            },
            ...(portfolioWarnings.length > 0 && { warnings: portfolioWarnings }),
            note: "Cost basis computed using weighted average cost (WAC) method — for analytical purposes only. " +
              "book_lightyear_trades uses FIFO cost basis from the capital gains file, so this summary " +
              "may not match the investment account balance after booking sells. " +
              "For tax reporting, use parse_lightyear_capital_gains which uses FIFO.",
          }),
        }],
      };
    }
  );
}
