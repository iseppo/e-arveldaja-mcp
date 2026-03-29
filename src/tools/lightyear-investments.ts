import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { readFile } from "fs/promises";
import type { ApiContext } from "./crud-tools.js";
import { validateFilePath } from "../file-validation.js";
import { roundMoney } from "../money.js";
import { readOnly, batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { reportProgress } from "../progress.js";
import { parseCSVLine } from "../csv.js";
import { validateAccounts } from "../account-validation.js";
import { toolError } from "../tool-error.js";

const MAX_CSV_SIZE = 10 * 1024 * 1024; // 10 MB

// BRICEKSP is Lightyear's money market cash fund - not a real investment
const CASH_FUND_TICKER = "BRICEKSP";

const EXPECTED_STATEMENT_HEADERS = ["Date", "Reference", "Ticker", "ISIN", "Type", "Quantity", "CCY", "Price/share", "Gross Amount", "FX Rate", "Fee", "Net Amt.", "Tax Amt."];
const EXPECTED_GAINS_HEADERS = ["Date", "Ticker", "Name", "ISIN", "Country", "Fees (EUR)", "Quantity", "Cost Basis (EUR)", "Proceeds (EUR)", "Capital Gains (EUR)"];

interface AccountStatementRow {
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
}

function parseNumber(s: string): number {
  if (!s || s.trim() === "") return 0;
  return parseFloat(s.replace(/,/g, ""));
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
  const real = await validateFilePath(filePath, [".csv"], MAX_CSV_SIZE);
  return readFile(real, "utf-8");
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
      date: fields[0]!,
      reference: fields[1]!,
      ticker: fields[2]!,
      isin: fields[3]!,
      type: fields[4]! as AccountStatementRow["type"],
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
 * Extract real investment trades from the account statement.
 * Pairs Buy/Sell orders with their FX Conversion entries (for USD trades).
 * Excludes BRICEKSP (money market cash fund) trades.
 * Consumed conversions are tracked to prevent double-matching.
 */
interface TradeExtractionResult {
  trades: InvestmentTrade[];
  warnings: string[];
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
    if (row.ticker === CASH_FUND_TICKER) continue;

    const trade: InvestmentTrade = {
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
    };

    if (row.ccy === "EUR") {
      // EUR trade - amount is directly in EUR
      trade.eur_amount = Math.abs(row.gross_amount);
    } else {
      // Foreign currency trade - find the paired Conversion entry
      // Lightyear pairs: CN-xxx has two rows (EUR side + foreign currency side)
      // The foreign currency amount matches the trade's gross_amount
      let matched = false;
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
        trade.eur_amount = Math.abs(best.eurConv.gross_amount);
        trade.fx_rate = best.eurConv.fx_rate || best.fgnConv.fx_rate || null;
        trade.fx_fee_eur = Math.abs(best.eurConv.fee);
        trade.conversion_ref = best.ref;
        consumedConversions.add(best.ref);
        matched = true;
      }

      if (!matched) {
        // No matching conversion found - flag as unmatched, do NOT silently treat as EUR
        trade.eur_amount = 0;
      }
    }

    trades.push(trade);
  }

  // Sort by date ascending
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.datetime.localeCompare(b.datetime));
  return { trades, warnings: fxWarnings };
}

/**
 * Extract distribution (dividend/interest) entries.
 * Excludes BRICEKSP distributions.
 */
function extractDistributions(rows: AccountStatementRow[]): Array<{
  date: string;
  reference: string;
  ticker: string;
  isin: string;
  gross_amount: number;
  fee: number;
  net_amount: number;
  tax_amount: number;
}> {
  return rows
    .filter(r => (r.type === "Distribution" || r.type === "Dividend" || r.type === "Interest" || r.type === "Reward") && r.ticker !== CASH_FUND_TICKER)
    .map(r => ({
      date: parseLightyearDate(r.date),
      reference: r.reference,
      ticker: r.ticker,
      isin: r.isin,
      gross_amount: r.gross_amount,
      fee: r.fee,
      net_amount: r.net_amount,
      tax_amount: r.tax_amount,
    }));
}

async function findExistingJournalsByRef(api: ApiContext, references: string[]): Promise<Set<string>> {
  if (references.length === 0) return new Set();

  const allJournals = await api.journals.listAll();
  const existing = new Set<string>();

  // Build a set of target prefixed refs for O(1) lookup
  const targetRefs = new Set(references.map(r => `LY:${r}`));

  for (const journal of allJournals) {
    if (journal.is_deleted) continue;
    if (!journal.document_number) continue;
    if (targetRefs.has(journal.document_number)) {
      // Extract the reference from LY:{ref}
      existing.add(journal.document_number.substring(3));
    }
  }

  return existing;
}

/**
 * Match sell trades to capital gains entries by date + ticker + quantity + proceeds.
 * Falls back to date + ticker + quantity if proceeds don't match (FX rounding).
 * Warns on ambiguous matches (multiple gains rows for same criteria).
 */
function matchSellsToCapitalGains(
  sells: InvestmentTrade[],
  gains: CapitalGainsRow[],
  warnings: string[] = []
): Map<string, CapitalGainsRow> {
  const result = new Map<string, CapitalGainsRow>();
  const consumedGains = new Set<number>();

  for (const sell of sells) {
    // Try strict match first: date + ticker + quantity + proceeds
    let matchIdx = -1;
    let ambiguousCount = 0;

    for (let i = 0; i < gains.length; i++) {
      if (consumedGains.has(i)) continue;
      const gain = gains[i]!;
      const gainDate = parseLightyearDate(gain.date);

      if (gainDate === sell.date &&
          gain.ticker === sell.ticker &&
          Math.abs(gain.quantity - sell.quantity) < 0.000001) {
        // Proceeds tiebreaker (0.02 EUR tolerance for FX rounding)
        if (Math.abs(gain.proceeds_eur - sell.eur_amount) < 0.02) {
          if (matchIdx !== -1 && !consumedGains.has(matchIdx)) {
            ambiguousCount++; // exact-duplicate gains row
          }
          matchIdx = i;
          break; // Exact match on all four criteria
        }
        ambiguousCount++;
        if (matchIdx === -1) matchIdx = i; // fallback to first date+ticker+qty match
      }
    }

    if (ambiguousCount > 1 && matchIdx !== -1) {
      const gain = gains[matchIdx]!;
      warnings.push(
        `Ambiguous FIFO match for sell ${sell.reference} (${sell.ticker} x${sell.quantity} on ${sell.date}): ` +
        `${ambiguousCount} gains rows match date+ticker+qty. Picked first match (proceeds ${gain.proceeds_eur} EUR); verify cost basis manually.`
      );
    }

    if (matchIdx !== -1) {
      result.set(sell.reference, gains[matchIdx]!);
      consumedGains.add(matchIdx);
    }
  }

  return result;
}

export function registerLightyearTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "parse_lightyear_statement",
    "Parse a Lightyear account statement CSV. Extracts investment trades (Buy/Sell), " +
    "distributions, deposits, withdrawals. Filters out BRICEKSP money market fund trades. " +
    "Pairs foreign currency trades with their FX conversion entries. " +
    "Returns summary by default — set include_rows=true for individual trade/distribution details.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
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
      const { trades, warnings: fxWarnings } = extractTrades(rows);
      const distributions = extractDistributions(rows);

      // Summarize deposits/withdrawals
      const deposits = rows.filter(r => r.type === "Deposit");
      const withdrawals = rows.filter(r => r.type === "Withdrawal");
      const rewards = rows.filter(r => r.type === "Reward");

      // Check for unmatched FX trades
      const unmatchedFx = trades.filter(t => t.ccy !== "EUR" && t.eur_amount === 0);

      // Group trades by ticker
      const byTicker = new Map<string, InvestmentTrade[]>();
      for (const t of trades) {
        const list = byTicker.get(t.ticker) ?? [];
        list.push(t);
        byTicker.set(t.ticker, list);
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
            return s + t.eur_amount + tradeFeeEur;
          }, 0)),
          total_sold_eur: roundMoney(sells.reduce((s, t) => s + t.eur_amount, 0)),
        };
      }

      const warnings: string[] = [...fxWarnings];
      if (unmatchedFx.length > 0) {
        warnings.push(
          `${unmatchedFx.length} foreign currency trade(s) could not be matched to FX conversion entries: ` +
          unmatchedFx.map(t => `${t.reference} (${t.ticker} ${t.ccy})`).join(", ")
        );
      }

      const summaryJson = {
        total_rows: rows.length,
        ...(date_from && { date_from }),
        ...(date_to && { date_to }),
        trades: { count: trades.length, by_ticker: summary },
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
        rewards: {
          count: rewards.length,
          total_eur: roundMoney(rewards.reduce((s, r) => s + r.gross_amount, 0)),
        },
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
      const tradeRows = trades.map(t =>
        `| ${t.date} | ${t.reference} | ${t.ticker} | ${t.type} | ${t.quantity} | ${t.ccy} | ${t.eur_amount.toFixed(2)} | ${t.fee_eur.toFixed(2)} |`
      );
      const tradesTable = trades.length > 0
        ? `## Trades (${trades.length})\n\n| Date | Ref | Ticker | Type | Qty | CCY | EUR | Fee |\n|------|-----|--------|------|-----|-----|-----|-----|\n${tradeRows.join("\n")}`
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
        "BRICEKSP trades (money market cash fund) are excluded.",
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
              name: g.name,
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
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
      capital_gains_file: z.string().optional().describe("Absolute path to Lightyear CapitalGainsStatement CSV (required for sell entries)"),
      investment_account: z.number().describe("Investment/securities account (e.g. 1550 Finantsinvesteeringud)"),
      investment_dimension_id: z.number().optional().describe("Dimension ID for investment account (accounts_dimensions_id)"),
      broker_account: z.number().describe("Broker cash account (e.g. 1120 Lightyear konto)"),
      broker_dimension_id: z.number().optional().describe("Dimension ID for broker account (accounts_dimensions_id)"),
      gain_loss_account: z.number().optional().describe("Realized gain account (credit for gains; also used for losses if loss_account not set)"),
      loss_account: z.number().optional().describe("Realized loss account (debit for losses). If omitted, losses go to gain_loss_account."),
      fee_account: z.number().optional().describe("Fee expense account (default: fees included in investment cost)"),
      skip_tickers: z.string().optional().describe("Comma-separated tickers to skip (default: BRICEKSP)"),
      dry_run: z.boolean().optional().describe("Preview without creating entries (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Book Lightyear Trades" },
    async ({ file_path, capital_gains_file, investment_account, investment_dimension_id, broker_account, broker_dimension_id, gain_loss_account, loss_account, fee_account, skip_tickers, dry_run }) => {
      const isDryRun = dry_run !== false;
      const skipSet = new Set(
        (skip_tickers ?? CASH_FUND_TICKER).split(",").map(t => t.trim())
      );

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
      const allRefs = trades.map(t => t.reference);
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

        // eur_amount (from EUR conversion gross) already includes FX fee.
        // Only trade.fee_eur is an additional cost (converted to EUR for foreign trades).
        const tradeFeeEur = trade.fee_eur > 0 && trade.fx_rate
          ? roundMoney(trade.fee_eur / trade.fx_rate)
          : trade.fee_eur;
        const postings: Array<{ accounts_id: number; accounts_dimensions_id?: number; type: "D" | "C"; amount: number }> = [];

        if (trade.type === "Buy") {
          // totalCostEur = EUR conversion gross (includes FX fee) + trade fee in EUR
          const totalCostEur = roundMoney(trade.eur_amount + tradeFeeEur);

          if (fee_account && tradeFeeEur > 0) {
            postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "D", amount: trade.eur_amount });
            postings.push({ accounts_id: fee_account, type: "D", amount: tradeFeeEur });
            postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "C", amount: totalCostEur });
          } else {
            // Fees included in investment cost
            postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "D", amount: totalCostEur });
            postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "C", amount: totalCostEur });
          }
        } else {
          // Sell: need cost basis from capital gains file
          const gainEntry = gainsMap.get(trade.reference);

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

          if (fee_account && tradeFeeEur > 0) {
            postings.push({ accounts_id: fee_account, type: "D", amount: tradeFeeEur });
            postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "C", amount: tradeFeeEur });
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
          `${skippedSells.length} sell trade(s) skipped — provide capital_gains_file and gain_loss_account to book them with correct cost basis.`
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
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
      broker_account: z.number().describe("Broker cash account (e.g. 1120 Lightyear konto)"),
      broker_dimension_id: z.number().optional().describe("Dimension ID for broker account (accounts_dimensions_id)"),
      income_account: z.number().describe("Investment income account (e.g. 8320 Tulu fondiosakutelt, 8400 Intressitulu)"),
      tax_account: z.number().optional().describe("Withheld tax receivable/expense account (for tax_amount from CSV)"),
      fee_account: z.number().optional().describe("Platform fee expense account (default 8610 Muud finantskulud)"),
      dry_run: z.boolean().optional().describe("Preview without creating entries (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Book Lightyear Distributions" },
    async ({ file_path, broker_account, broker_dimension_id, income_account, tax_account, fee_account: fee_account_param, dry_run }) => {
      const isDryRun = dry_run !== false;
      const fee_account = fee_account_param ?? 8610;

      // Validate accounts exist and are active
      const accounts = await api.readonly.getAccounts();
      const errors = validateAccounts(accounts, [
        { id: broker_account, label: "Broker account" },
        { id: income_account, label: "Income account" },
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
      const allRefs = distributions.map(d => d.reference);
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
        postings.push({ accounts_id: income_account, type: "C", amount: creditAmount });

        const title = dist.ticker
          ? `Lightyear tulu: ${dist.ticker} (${dist.isin})`
          : `Lightyear tulu: ${dist.reference.startsWith("RW-") ? "boonus" : "intress"}`;

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
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
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
          // eur_amount (EUR conversion gross) already includes FX fee;
          // only add trade fee converted to EUR
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
