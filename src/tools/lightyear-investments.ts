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
import { parseCSV } from "../csv.js";
import { validateAccounts } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT, DEFAULT_OTHER_FINANCIAL_INCOME_ACCOUNT } from "../accounting-defaults.js";
import {
  resolveSecuritiesIncomeAccount,
  resolveSecuritiesExpenseAccount,
  resolveOtherFinancialIncomeAccount,
} from "../account-resolution.js";
import { BookingGuard } from "../booking-guard.js";
import type { Journal } from "../types/api.js";

const MAX_CSV_SIZE = 10 * 1024 * 1024; // 10 MB

// Known Lightyear cash-sweep / cash-equivalent instruments. Lightyear's capital
// gains report does not cover these, so we book buy/sell only for EUR-denominated
// sweeps where proceeds equal cost basis 1:1. Non-EUR sweeps (e.g. ICSUSSDP in USD)
// would need a proper cost-basis source to avoid FX drift on the investment account.
const KNOWN_CASH_EQUIVALENT_TICKERS = new Set(["BRICEKSP", "ICSUSSDP"]);

const EXPECTED_STATEMENT_HEADERS = ["Date", "Reference", "Ticker", "ISIN", "Type", "Quantity", "CCY", "Price/share", "Gross Amount", "FX Rate", "Fee", "Net Amt.", "Tax Amt."];
const REQUIRED_GAINS_HEADERS = ["Date", "Ticker", "Name", "ISIN", "Country", "Fees (EUR)", "Quantity", "Cost Basis (EUR)", "Proceeds (EUR)", "Capital Gains (EUR)"] as const;

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

export type FxRateOrientation = "eur_per_foreign" | "foreign_per_eur";

export type FxReviewCode =
  | "invalid_net_amount"
  | "missing_rate"
  | "invalid_rate"
  | "contradictory_rate"
  | "ambiguous_orientation"
  | "ambiguous_rate"
  | "invalid_conversion_pair"
  | "conversion_amount_conflict"
  | "conversion_fee_conflict"
  | "trade_amount_conflict"
  | "trade_fee_unresolved"
  | "distribution_currency_missing"
  | "distribution_amount_conflict"
  | "portfolio_arithmetic_overflow";

export interface FxReviewReason {
  code: FxReviewCode;
  message: string;
}

export type FxPairResolution =
  | { ok: true; rate: number; orientation: FxRateOrientation }
  | { ok: false; reason: FxReviewReason };

export const FX_REVIEW_MESSAGES: Record<FxReviewCode, string> = {
  invalid_net_amount: "The conversion pair has missing or invalid net amount evidence.",
  missing_rate: "The conversion pair has no exchange-rate evidence.",
  invalid_rate: "The conversion pair contains an invalid exchange rate.",
  contradictory_rate: "The conversion rates contradict the paired EUR and foreign net amounts.",
  ambiguous_orientation: "A conversion rate fits both exchange-rate orientations.",
  ambiguous_rate: "Multiple exchange rates fit equally well and cannot be selected deterministically.",
  invalid_conversion_pair: "The conversion reference does not contain one unambiguous EUR/foreign row pair.",
  conversion_amount_conflict: "The conversion gross, net, sign, or fee arithmetic is inconsistent.",
  conversion_fee_conflict: "The conversion fee cannot be attributed and converted to EUR unambiguously.",
  trade_amount_conflict: "The trade gross, net, or fee arithmetic is inconsistent.",
  trade_fee_unresolved: "The foreign-currency trade fee has no proven EUR conversion.",
  distribution_currency_missing: "The distribution has no explicit source currency.",
  distribution_amount_conflict: "The distribution gross, net, tax, fee, or converted EUR amounts are inconsistent.",
  portfolio_arithmetic_overflow: "The portfolio arithmetic exceeds the supported exact bounds.",
};

export interface DistributionFxProvenance {
  rate: number;
  orientation: FxRateOrientation;
  conversion_reference: string;
  conversion_row_indexes: [number, number];
}

export interface LightyearDistribution {
  row_index: number;
  date: string;
  reference: string;
  type: AccountStatementRow["type"];
  ticker: string;
  isin: string;
  currency: string;
  gross_amount: number;
  fee: number;
  net_amount: number;
  tax_amount: number;
  gross_eur: number | null;
  fee_eur: number | null;
  net_eur: number | null;
  tax_eur: number | null;
  fx_provenance: DistributionFxProvenance | null;
  fx_review_reason: FxReviewReason | null;
}

interface DistributionExtractionResult {
  distributions: LightyearDistribution[];
  warnings: string[];
  consumedConversionRefs: Set<string>;
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
  fx_orientation: FxRateOrientation | null;
  fx_review_reason: FxReviewReason | null;
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

function buildHeaderIndex<T extends readonly string[]>(actual: string[], required: T, label: string): Record<T[number], number> {
  const indexes = new Map<string, number>();
  for (let i = 0; i < actual.length; i++) {
    const header = actual[i]!.trim();
    if (indexes.has(header)) {
      throw new Error(`${label}: duplicate column "${header}". File may not be a valid Lightyear export.`);
    }
    indexes.set(header, i);
  }

  const missing = required.filter((header) => !indexes.has(header));
  if (missing.length > 0) {
    throw new Error(
      `${label}: missing required column${missing.length === 1 ? "" : "s"} ${missing.map(h => `"${h}"`).join(", ")}. ` +
      `File may not be a valid Lightyear export.`
    );
  }

  return Object.fromEntries(required.map((header) => [header, indexes.get(header)!])) as Record<T[number], number>;
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
  // Full-file RFC-4180 CSV parse (handles quoted newlines inside fields).
  // The old split-on-"\n" approach would corrupt any row whose name/reference
  // field contained an embedded newline, silently skipping or merging rows.
  const allRows = parseCSV(csv).filter(r => r.some(f => f.trim().length > 0));
  if (allRows.length < 2) return [];

  validateHeaders(allRows[0]!, EXPECTED_STATEMENT_HEADERS, "Account Statement CSV");

  const rows: AccountStatementRow[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const fields = allRows[i]!;
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

const MIN_FX_RATE = 1e-4;

// Account-statement decimals are parsed through Number, so accepting values all
// the way to Number.MAX_SAFE_INTEGER cents would pretend adjacent source cents
// remain distinguishable where the binary ULP is already larger than a cent.
// At this deliberately conservative ceiling (10 trillion EUR), the ULP stays
// below half a cent and decimal -> Number -> integer-cent recovery is unambiguous.
const MAX_UNAMBIGUOUS_MONEY_CENTS = 1_000_000_000_000_000;

function fxReason(code: FxReviewCode): FxReviewReason {
  return { code, message: FX_REVIEW_MESSAGES[code] };
}

function normalizedCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

const LEGACY_CENT_MATCH_TOLERANCE = 0.0100000001;

function boundedIeeeNoise(...values: number[]): number {
  return Math.min(
    1e-9,
    Number.EPSILON * Math.max(1, ...values.map(value => Math.abs(value))) * 4,
  );
}

function strictCandidateResidualTolerance(left: number, right: number): number {
  return 0.01 + boundedIeeeNoise(left, right);
}

function agreesToCent(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(roundMoney(left) - roundMoney(right)) <= LEGACY_CENT_MATCH_TOLERANCE;
}

function moneyToPostingSafeCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = roundMoney(value);
  const scaled = rounded * 100;
  if (!Number.isFinite(scaled)) return null;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents)) return null;
  const normalizedCents = Object.is(cents, -0) ? 0 : cents;
  return roundMoney(normalizedCents / 100) === rounded ? normalizedCents : null;
}

function moneyToSafeCents(value: number): number | null {
  const cents = moneyToPostingSafeCents(value);
  return cents !== null && Math.abs(cents) <= MAX_UNAMBIGUOUS_MONEY_CENTS ? cents : null;
}

function hasExactRoundedMoneyBalance(gross: number, net: number, tax: number, fee: number): boolean {
  const grossCents = moneyToSafeCents(gross);
  const netCents = moneyToSafeCents(net);
  const taxCents = moneyToSafeCents(tax);
  const feeCents = moneyToSafeCents(fee);
  if (grossCents === null || netCents === null || taxCents === null || feeCents === null) return false;
  const netAndTaxCents = netCents + taxCents;
  if (!Number.isSafeInteger(netAndTaxCents)) return false;
  const componentCents = netAndTaxCents + feeCents;
  return Number.isSafeInteger(componentCents) && grossCents === componentCents;
}

function convertForeignToEur(
  amount: number,
  rate: number,
  orientation: FxRateOrientation,
): number {
  return orientation === "eur_per_foreign" ? amount * rate : amount / rate;
}

export function resolveFxPair(
  eurNet: number,
  foreignNet: number,
  rates: number[],
): FxPairResolution {
  if (!isFinitePositive(eurNet) || !isFinitePositive(foreignNet)) {
    return { ok: false, reason: fxReason("invalid_net_amount") };
  }

  const distinctRates: number[] = [];
  for (const rate of rates) {
    if (rate === 0) continue;
    if (!Number.isFinite(rate) || rate < MIN_FX_RATE) {
      return { ok: false, reason: fxReason("invalid_rate") };
    }
    if (!distinctRates.includes(rate)) distinctRates.push(rate);
  }
  if (distinctRates.length === 0) {
    return { ok: false, reason: fxReason("missing_rate") };
  }

  type Candidate = {
    rate: number;
    orientation: FxRateOrientation;
    convertedEur: number;
    residual: number;
  };
  const byOrientation: Record<FxRateOrientation, Candidate[]> = {
    eur_per_foreign: [],
    foreign_per_eur: [],
  };
  let hasAmbiguousOrientation = false;
  let hasContradictoryRate = false;

  for (const rate of distinctRates) {
    const multiplied = convertForeignToEur(foreignNet, rate, "eur_per_foreign");
    const divided = convertForeignToEur(foreignNet, rate, "foreign_per_eur");
    const multiplyFits = agreesToCent(multiplied, eurNet);
    const divideFits = agreesToCent(divided, eurNet);

    if (multiplyFits && divideFits) {
      hasAmbiguousOrientation = true;
      continue;
    }
    if (!multiplyFits && !divideFits) {
      hasContradictoryRate = true;
      continue;
    }

    const orientation: FxRateOrientation = multiplyFits ? "eur_per_foreign" : "foreign_per_eur";
    const convertedEur = multiplyFits ? multiplied : divided;
    byOrientation[orientation].push({
      rate,
      orientation,
      convertedEur,
      residual: Math.abs(convertedEur - eurNet),
    });
  }

  // Classify the complete evidence set before returning. Orientation ambiguity
  // is the more specific failure when mixed with a contradictory rate; this
  // precedence keeps the result independent of CSV/rate array order.
  if (hasAmbiguousOrientation) {
    return { ok: false, reason: fxReason("ambiguous_orientation") };
  }
  if (hasContradictoryRate) {
    return { ok: false, reason: fxReason("contradictory_rate") };
  }

  const chooseBest = (candidates: Candidate[]): Candidate | null | "ambiguous" => {
    if (candidates.length === 0) return null;
    const ordered = [...candidates].sort((left, right) =>
      left.residual - right.residual || left.rate - right.rate
    );
    const best = ordered[0]!;
    const tieTolerance = 1e-12 * Math.max(1, eurNet);
    if (ordered.slice(1).some(candidate => Math.abs(candidate.residual - best.residual) <= tieTolerance)) {
      return "ambiguous";
    }
    return best;
  };

  const multiply = chooseBest(byOrientation.eur_per_foreign);
  const divide = chooseBest(byOrientation.foreign_per_eur);
  if (multiply === "ambiguous" || divide === "ambiguous") {
    return { ok: false, reason: fxReason("ambiguous_rate") };
  }
  if (multiply && divide) {
    if (!agreesToCent(multiply.convertedEur, divide.convertedEur)) {
      return { ok: false, reason: fxReason("contradictory_rate") };
    }
    return { ok: true, rate: multiply.rate, orientation: "eur_per_foreign" };
  }
  const selected = multiply || divide;
  if (!selected) return { ok: false, reason: fxReason("contradictory_rate") };
  return { ok: true, rate: selected.rate, orientation: selected.orientation };
}

function fxFeeToEur(
  eurConv: AccountStatementRow,
  foreignConv: AccountStatementRow,
  resolution: FxPairResolution & { ok: true },
): number | null {
  const eurFee = eurConv.fee;
  const foreignFee = foreignConv.fee;
  if (!isFiniteNonNegative(eurFee) || !isFiniteNonNegative(foreignFee)) return null;
  if (eurFee > 0 && foreignFee > 0) return null;
  if (eurFee > 0) return roundMoney(eurFee);
  if (foreignFee === 0) return 0;
  const convertedFee = convertForeignToEur(foreignFee, resolution.rate, resolution.orientation);
  return Number.isFinite(convertedFee) ? roundMoney(convertedFee) : null;
}

export function tradeFeeInEur(trade: {
  ccy: string;
  fee_eur: number;
  fx_rate: number | null;
  fx_orientation: FxRateOrientation | null;
}): number | null {
  if (!Number.isFinite(trade.fee_eur) || trade.fee_eur < 0) return null;
  if (trade.fee_eur === 0) return 0;
  if (normalizedCurrency(trade.ccy) === "EUR") return roundMoney(trade.fee_eur);
  const rate = trade.fx_rate;
  const orientation = trade.fx_orientation;
  if (
    rate === null ||
    !Number.isFinite(rate) ||
    rate < MIN_FX_RATE ||
    (orientation !== "eur_per_foreign" && orientation !== "foreign_per_eur")
  ) return null;
  const convertedFee = convertForeignToEur(trade.fee_eur, rate, orientation);
  return Number.isFinite(convertedFee) ? roundMoney(convertedFee) : null;
}

export type TradeIntrinsicReadiness =
  | { kind: "ready"; converted_trade_fee_eur: number }
  | { kind: "review_required"; reason: FxReviewReason };

function quantityToSafeMicrounits(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const units = Math.round(value * 1_000_000);
  return Number.isSafeInteger(units) ? units : null;
}

export function classifyTradeIntrinsicReadiness(
  trade: Pick<InvestmentTrade, "type" | "quantity" | "ccy" | "eur_amount" | "fee_eur" | "fx_rate" | "fx_orientation" | "fx_review_reason" | "fx_fee_eur">,
): TradeIntrinsicReadiness {
  if (trade.fx_review_reason !== null) {
    return { kind: "review_required", reason: trade.fx_review_reason };
  }
  if (
    normalizedCurrency(trade.ccy) !== "EUR" &&
    (trade.eur_amount === 0 || trade.fx_rate === null || trade.fx_orientation === null)
  ) {
    return { kind: "review_required", reason: fxReason("trade_fee_unresolved") };
  }
  const convertedTradeFee = tradeFeeInEur(trade);
  if (convertedTradeFee === null) {
    return { kind: "review_required", reason: fxReason("trade_fee_unresolved") };
  }
  const quantityUnits = quantityToSafeMicrounits(trade.quantity);
  const eurAmountCents = moneyToPostingSafeCents(trade.eur_amount);
  const tradeFeeCents = moneyToPostingSafeCents(convertedTradeFee);
  const fxFeeCents = moneyToPostingSafeCents(trade.fx_fee_eur);
  const checkedCentArithmetic = (...values: number[]): number | null => {
    let total = 0;
    for (const value of values) {
      total += value;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  };
  const hasSafeQuantity = Number.isFinite(trade.quantity) && trade.quantity > 0 &&
    quantityUnits !== null;
  const hasSafeMoney = eurAmountCents !== null && eurAmountCents > 0 &&
    tradeFeeCents !== null && tradeFeeCents >= 0 &&
    fxFeeCents !== null && fxFeeCents >= 0;
  const hasSafePostingArithmetic = hasSafeMoney && (
    trade.type === "Buy"
      ? checkedCentArithmetic(eurAmountCents!, tradeFeeCents!) !== null &&
        checkedCentArithmetic(fxFeeCents!, tradeFeeCents!) !== null &&
        checkedCentArithmetic(eurAmountCents!, fxFeeCents!, tradeFeeCents!) !== null
      : checkedCentArithmetic(eurAmountCents!, -tradeFeeCents!) !== null &&
        checkedCentArithmetic(tradeFeeCents!, fxFeeCents!) !== null
  );
  if (!hasSafeQuantity || !hasSafePostingArithmetic) {
    return { kind: "review_required", reason: fxReason("trade_amount_conflict") };
  }
  return { kind: "ready", converted_trade_fee_eur: convertedTradeFee };
}

type PortfolioTradeBaseDto = {
  reference: string;
  ticker: string;
  isin: string;
  type: "Buy" | "Sell";
  date: string;
  quantity: number;
  currency: string;
  gross_amount: number;
};

type BookedBasisTradeDto = PortfolioTradeBaseDto & {
  status: "intrinsically_ready";
  eur_amount: number;
  trade_fee_eur: number;
};

type SkippedTradeDto = PortfolioTradeBaseDto & {
  status: "skipped";
  skip_reason: {
    code: "default_cash_equivalent";
    message: string;
  };
};

type ReviewRequiredTradeDto = PortfolioTradeBaseDto & {
  status: "review_required";
  review_reason: FxReviewReason;
};

const SAFE_PORTFOLIO_TICKER_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,31}$/;
const SAFE_PORTFOLIO_ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const SAFE_PORTFOLIO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SAFE_PORTFOLIO_CURRENCY_RE = /^[A-Z]{3}$/;

function renderPortfolioTicker(value: string): string {
  return SAFE_PORTFOLIO_TICKER_RE.test(value)
    ? value
    : (wrapUntrustedOcr(value) ?? "");
}

function renderPortfolioIsin(value: string): string {
  return value === "" || SAFE_PORTFOLIO_ISIN_RE.test(value)
    ? value
    : (wrapUntrustedOcr(value) ?? "");
}

function renderPortfolioDate(value: string): string {
  const match = SAFE_PORTFOLIO_DATE_RE.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]!) return value;
  }
  return value === "" ? value : (wrapUntrustedOcr(value) ?? "");
}

function renderPortfolioCurrency(value: string): string {
  return value === "" || SAFE_PORTFOLIO_CURRENCY_RE.test(value)
    ? value
    : (wrapUntrustedOcr(value) ?? "");
}

function renderPortfolioQuantity(value: number): number {
  const units = quantityToSafeMicrounits(value);
  return units === null ? value : units / 1_000_000;
}

function portfolioTradeBaseDto(trade: InvestmentTrade): PortfolioTradeBaseDto {
  return {
    reference: wrapUntrustedOcr(trade.reference) ?? "",
    ticker: renderPortfolioTicker(trade.ticker),
    isin: renderPortfolioIsin(trade.isin),
    type: trade.type,
    date: renderPortfolioDate(trade.date),
    quantity: renderPortfolioQuantity(trade.quantity),
    currency: renderPortfolioCurrency(trade.ccy),
    gross_amount: trade.gross_amount_ccy,
  };
}

function bookedBasisTradeDto(trade: InvestmentTrade, convertedTradeFee: number): BookedBasisTradeDto {
  return {
    ...portfolioTradeBaseDto(trade),
    status: "intrinsically_ready",
    eur_amount: trade.eur_amount,
    trade_fee_eur: convertedTradeFee,
  };
}

function skippedTradeDto(trade: InvestmentTrade): SkippedTradeDto {
  return {
    ...portfolioTradeBaseDto(trade),
    status: "skipped",
    skip_reason: {
      code: "default_cash_equivalent",
      message: "Default cash-equivalent instruments are excluded from the analytical WAC basis.",
    },
  };
}

function reviewRequiredTradeDto(trade: InvestmentTrade, reason: FxReviewReason): ReviewRequiredTradeDto {
  return {
    ...portfolioTradeBaseDto(trade),
    status: "review_required",
    review_reason: reason,
  };
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

interface CashAccumulator {
  values: Map<string, number>;
  overflowCurrencies: Set<string>;
}

function cashAccumulator(): CashAccumulator {
  return { values: new Map(), overflowCurrencies: new Set() };
}

function addCashDelta(target: CashAccumulator, currency: string, amount: number): void {
  if (!currency || target.overflowCurrencies.has(currency)) return;
  if (!Number.isFinite(amount)) {
    target.values.delete(currency);
    target.overflowCurrencies.add(currency);
    return;
  }
  if (Math.abs(amount) < 0.000001) return;
  const next = (target.values.get(currency) ?? 0) + amount;
  if (!Number.isFinite(next)) {
    target.values.delete(currency);
    target.overflowCurrencies.add(currency);
    return;
  }
  target.values.set(currency, roundMoney(next));
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
  const totalByCurrency = cashAccumulator();
  const handledByCurrency = cashAccumulator();
  const gapByCurrency = cashAccumulator();

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
    ...totalByCurrency.values.keys(),
    ...handledByCurrency.values.keys(),
    ...totalByCurrency.overflowCurrencies,
    ...handledByCurrency.overflowCurrencies,
  ]);
  for (const currency of currencies) {
    if (totalByCurrency.overflowCurrencies.has(currency) || handledByCurrency.overflowCurrencies.has(currency)) {
      gapByCurrency.overflowCurrencies.add(currency);
      continue;
    }
    addCashDelta(
      gapByCurrency,
      currency,
      (totalByCurrency.values.get(currency) ?? 0) - (handledByCurrency.values.get(currency) ?? 0),
    );
  }

  const overflowByCurrency = Object.fromEntries(
    [...currencies]
      .sort((left, right) => left.localeCompare(right))
      .map(currency => {
        const states = [
          ...(totalByCurrency.overflowCurrencies.has(currency) ? ["total"] : []),
          ...(handledByCurrency.overflowCurrencies.has(currency) ? ["handled"] : []),
          ...(gapByCurrency.overflowCurrencies.has(currency) ? ["gap"] : []),
        ];
        return [currency, states] as const;
      })
      .filter(([, states]) => states.length > 0)
  );
  const hasOverflow = Object.keys(overflowByCurrency).length > 0;

  return {
    total_by_currency: cashMapToObject(totalByCurrency.values),
    handled_by_currency: cashMapToObject(handledByCurrency.values),
    gap_by_currency: cashMapToObject(gapByCurrency.values),
    ignored_rows: ignoredRowIndexes.size,
    ...(hasOverflow && { overflow_by_currency: overflowByCurrency }),
    is_balanced: !hasOverflow && [...gapByCurrency.values.values()].every((amount) => Math.abs(amount) < 0.01),
  };
}

function parseCapitalGains(csv: string): CapitalGainsRow[] {
  // Full-file RFC-4180 CSV parse — same rationale as parseAccountStatement:
  // capital-gains rows embed security names, which can contain commas and
  // quoted newlines; split-on-"\n" silently drops or merges those rows.
  const allRows = parseCSV(csv).filter(r => r.some(f => f.trim().length > 0));
  if (allRows.length < 2) return [];

  const headerIndex = buildHeaderIndex(allRows[0]!, REQUIRED_GAINS_HEADERS, "Capital Gains CSV");
  const expectedColumns = Math.max(...Object.values(headerIndex)) + 1;

  const rows: CapitalGainsRow[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const fields = allRows[i]!;
    if (fields.length < expectedColumns) {
      throw new Error(`Capital Gains CSV row ${i + 1}: expected ${expectedColumns} columns, got ${fields.length}`);
    }

    // Cap `name` at a defensive length so a malformed CSV with multi-line
    // or unusually long names can't smuggle bulk text. Real security names
    // fit easily under 128 chars; truncation makes the Lightyear-CSV trust
    // decision robust to format drift.
    const rawName = fields[headerIndex.Name]!;
    const name = rawName.length > 128 ? rawName.slice(0, 128) + "…" : rawName;
    rows.push({
      date: fields[headerIndex.Date]!,
      ticker: fields[headerIndex.Ticker]!,
      name,
      isin: fields[headerIndex.ISIN]!,
      country: fields[headerIndex.Country]!,
      fees_eur: parseNumber(fields[headerIndex["Fees (EUR)"]]!),
      quantity: parseNumber(fields[headerIndex.Quantity]!),
      cost_basis_eur: parseNumber(fields[headerIndex["Cost Basis (EUR)"]]!),
      proceeds_eur: parseNumber(fields[headerIndex["Proceeds (EUR)"]]!),
      capital_gains_eur: parseNumber(fields[headerIndex["Capital Gains (EUR)"]]!),
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

function validateTradeAmounts(row: AccountStatementRow): FxReviewReason | null {
  const gross = Math.abs(row.gross_amount);
  const net = Math.abs(row.net_amount);
  if (!isFinitePositive(gross) || !isFinitePositive(net) || !isFiniteNonNegative(row.fee)) {
    return fxReason("trade_amount_conflict");
  }
  if (Math.sign(row.gross_amount) !== Math.sign(row.net_amount)) {
    return fxReason("trade_amount_conflict");
  }
  const expectedNet = row.type === "Buy" ? gross + row.fee : gross - row.fee;
  if (!isFinitePositive(expectedNet) || !agreesToCent(net, expectedNet)) {
    return fxReason("trade_amount_conflict");
  }
  return null;
}

function validateConversionAmounts(
  eurConv: AccountStatementRow,
  foreignConv: AccountStatementRow,
): FxReviewReason | null {
  const eurGross = Math.abs(eurConv.gross_amount);
  const eurNet = Math.abs(eurConv.net_amount);
  const foreignGross = Math.abs(foreignConv.gross_amount);
  const foreignNet = Math.abs(foreignConv.net_amount);
  if (!isFinitePositive(eurNet) || !isFinitePositive(foreignNet)) {
    return fxReason("invalid_net_amount");
  }
  if (
    !isFinitePositive(eurGross) ||
    !isFinitePositive(foreignGross) ||
    !isFiniteNonNegative(eurConv.fee) ||
    !isFiniteNonNegative(foreignConv.fee) ||
    Math.sign(eurConv.gross_amount) !== Math.sign(eurConv.net_amount) ||
    Math.sign(foreignConv.gross_amount) !== Math.sign(foreignConv.net_amount) ||
    Math.sign(eurConv.net_amount) === Math.sign(foreignConv.net_amount) ||
    !agreesToCent(Math.abs(eurGross - eurNet), eurConv.fee) ||
    !agreesToCent(Math.abs(foreignGross - foreignNet), foreignConv.fee)
  ) {
    return fxReason("conversion_amount_conflict");
  }
  if (eurConv.fee > 0 && foreignConv.fee > 0) {
    return fxReason("conversion_fee_conflict");
  }
  return null;
}

function fxReviewWarning(
  tradeReference: string,
  reason: FxReviewReason,
  conversionReference?: string,
): string {
  const orderContext = wrapUntrustedOcr(tradeReference) ?? "";
  const conversionContext = conversionReference === undefined
    ? ""
    : ` Conversion ${wrapUntrustedOcr(conversionReference) ?? ""}.`;
  return `${orderContext}: FX review [${reason.code}] ${reason.message}${conversionContext}`;
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
      fx_orientation: null,
      fx_review_reason: null,
      fx_fee_eur: 0,
      conversion_ref: null,
      conversion_row_indexes: [],
      cash_equivalent: isCashEquivalentTicker(row.ticker),
    };

    const tradeAmountFailure = validateTradeAmounts(row);
    if (tradeAmountFailure) {
      trade.fx_review_reason = tradeAmountFailure;
      fxWarnings.push(fxReviewWarning(trade.reference, tradeAmountFailure));
      trades.push(trade);
      continue;
    }

    if (normalizedCurrency(row.ccy) === "EUR") {
      trade.eur_amount = Math.abs(row.gross_amount);
      trades.push(trade);
      continue;
    }

    const tradeCurrency = normalizedCurrency(row.ccy);
    const orderDatePrefix = row.date.split(/[\sT]/)[0];
    const shortlisted: Array<{ ref: string; rows: AccountStatementRow[] }> = [];
    for (const [ref, conversionRows] of conversionsByRef) {
      if (consumedConversions.has(ref)) continue;
      const hasMatchingForeignRow = conversionRows.some(conversionRow =>
        normalizedCurrency(conversionRow.ccy) === tradeCurrency &&
        conversionRow.date.split(/[\sT]/)[0] === orderDatePrefix &&
        agreesToCent(Math.abs(conversionRow.gross_amount), Math.abs(row.gross_amount))
      );
      if (hasMatchingForeignRow) shortlisted.push({ ref, rows: conversionRows });
    }

    if (shortlisted.length !== 1) {
      const reason = fxReason("invalid_conversion_pair");
      trade.fx_review_reason = reason;
      fxWarnings.push(fxReviewWarning(trade.reference, reason));
      trades.push(trade);
      continue;
    }

    const candidate = shortlisted[0]!;
    const eurRows = candidate.rows.filter(conversionRow => normalizedCurrency(conversionRow.ccy) === "EUR");
    const foreignRows = candidate.rows.filter(conversionRow => normalizedCurrency(conversionRow.ccy) === tradeCurrency);
    if (candidate.rows.length !== 2 || eurRows.length !== 1 || foreignRows.length !== 1) {
      const reason = fxReason("invalid_conversion_pair");
      trade.fx_review_reason = reason;
      fxWarnings.push(fxReviewWarning(trade.reference, reason, candidate.ref));
      trades.push(trade);
      continue;
    }

    const eurConv = eurRows[0]!;
    const foreignConv = foreignRows[0]!;
    const conversionFailure = validateConversionAmounts(eurConv, foreignConv);
    if (conversionFailure) {
      trade.fx_review_reason = conversionFailure;
      fxWarnings.push(fxReviewWarning(trade.reference, conversionFailure, candidate.ref));
      trades.push(trade);
      continue;
    }

    const resolution = resolveFxPair(
      Math.abs(eurConv.net_amount),
      Math.abs(foreignConv.net_amount),
      [eurConv.fx_rate, foreignConv.fx_rate],
    );
    if (!resolution.ok) {
      trade.fx_review_reason = resolution.reason;
      fxWarnings.push(fxReviewWarning(trade.reference, resolution.reason, candidate.ref));
      trades.push(trade);
      continue;
    }

    const convertedFxFee = fxFeeToEur(eurConv, foreignConv, resolution);
    if (convertedFxFee === null) {
      const reason = fxReason("conversion_fee_conflict");
      trade.fx_review_reason = reason;
      fxWarnings.push(fxReviewWarning(trade.reference, reason, candidate.ref));
      trades.push(trade);
      continue;
    }

    trade.eur_amount = Math.abs(eurConv.net_amount);
    trade.fx_rate = resolution.rate;
    trade.fx_orientation = resolution.orientation;
    trade.fx_fee_eur = convertedFxFee;
    trade.conversion_ref = candidate.ref;
    trade.conversion_row_indexes = [eurConv.row_index, foreignConv.row_index];
    consumedConversions.add(candidate.ref);
    trades.push(trade);
  }

  // Sort by date ascending
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.datetime.localeCompare(b.datetime));
  return { trades, warnings: fxWarnings, consumedConversionRefs: consumedConversions };
}

export { extractTrades as extractTradesForTesting };

function rawStatementDatePrefix(value: string): string {
  return value.split(/[\sT]/)[0]!;
}

function statementDay(value: string): string | null {
  const day = parseLightyearDate(value).split(/[T ]/)[0]!;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date
    ? day
    : null;
}

function conversionRowsByReference(rows: AccountStatementRow[]): Map<string, AccountStatementRow[]> {
  const result = new Map<string, AccountStatementRow[]>();
  for (const row of rows) {
    if (row.type !== "Conversion") continue;
    const group = result.get(row.reference) ?? [];
    group.push(row);
    result.set(row.reference, group);
  }
  return result;
}

interface CappedReferenceMatch {
  count: 0 | 1 | 2;
  uniqueReference: string | null;
}

interface TradeReservationEntry {
  amount: number;
  reference: string;
  row: AccountStatementRow;
}

interface TradeReservationGroup {
  entries: TradeReservationEntry[];
  nextActive: number[];
}

interface MutableTradeReservationIndex {
  groups: Map<string, TradeReservationGroup>;
  positionsByReference: Map<string, Array<{ group: TradeReservationGroup; index: number }>>;
}

interface ConversionCandidateIndex {
  buckets: Map<string, Set<string>>;
  wildcardCurrencyBuckets: Map<string, Set<string>>;
  bucketKeysByReference: Map<string, Array<{ wildcard: boolean; key: string }>>;
  evidenceByReference: Map<string, AccountStatementRow[]>;
}

function hasExactCandidateResidual(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const residual = Math.abs(Math.abs(left) - Math.abs(right));
  return Number.isFinite(residual) && residual <= strictCandidateResidualTolerance(left, right);
}

function candidateAmountBucket(amount: number): { kind: "cents"; value: number } | { kind: "exact"; value: string } | null {
  if (!isFiniteNonNegative(amount)) return null;
  const rounded = roundMoney(amount);
  const scaled = rounded * 100;
  if (Number.isFinite(scaled)) {
    const cents = Math.round(scaled);
    if (Number.isSafeInteger(cents) && roundMoney(cents / 100) === rounded) {
      return { kind: "cents", value: cents };
    }
  }
  return { kind: "exact", value: rounded.toString() };
}

function candidateBucketKey(day: string, currency: string, bucket: { kind: "cents"; value: number } | { kind: "exact"; value: string }): string {
  return `${day}\u0000${currency}\u0000${bucket.kind}:${bucket.value}`;
}

function candidateProbeKeys(day: string, currency: string, amount: number): string[] {
  const bucket = candidateAmountBucket(amount);
  if (bucket === null) return [];
  if (bucket.kind === "exact") return [candidateBucketKey(day, currency, bucket)];
  // Each raw amount can round by up to half a cent, while the authoritative
  // raw residual allows one cent plus bounded IEEE noise. Therefore two
  // rounded-cent buckets in either direction are the complete candidate
  // window; a third bucket is necessarily outside the final raw predicate.
  return [-2, -1, 0, 1, 2]
    .map(offset => bucket.value + offset)
    .filter(Number.isSafeInteger)
    .map(value => candidateBucketKey(day, currency, { kind: "cents", value }));
}

function emptyTradeReservationIndex(): MutableTradeReservationIndex {
  return { groups: new Map(), positionsByReference: new Map() };
}

function addTradeReservationEntry(
  index: MutableTradeReservationIndex,
  key: string,
  amount: number,
  row: AccountStatementRow,
): void {
  const group = index.groups.get(key) ?? { entries: [], nextActive: [] };
  group.entries.push({ amount, reference: row.reference, row });
  index.groups.set(key, group);
}

function finalizeTradeReservationIndex(index: MutableTradeReservationIndex): void {
  for (const group of index.groups.values()) {
    group.entries.sort((left, right) => left.amount - right.amount);
    group.nextActive = Array.from({ length: group.entries.length + 1 }, (_value, position) => position);
    for (let position = 0; position < group.entries.length; position++) {
      const reference = group.entries[position]!.reference;
      const positions = index.positionsByReference.get(reference) ?? [];
      positions.push({ group, index: position });
      index.positionsByReference.set(reference, positions);
    }
  }
}

function findNextActive(group: TradeReservationGroup, position: number): number {
  let root = position;
  while (group.nextActive[root] !== root) root = group.nextActive[root]!;
  let cursor = position;
  while (group.nextActive[cursor] !== cursor) {
    const next = group.nextActive[cursor]!;
    group.nextActive[cursor] = root;
    cursor = next;
  }
  return root;
}

function deactivateTradeReservationReference(index: MutableTradeReservationIndex, reference: string): void {
  for (const position of index.positionsByReference.get(reference) ?? []) {
    position.group.nextActive[position.index] = findNextActive(position.group, position.index + 1);
  }
  index.positionsByReference.delete(reference);
}

function lowerBoundTradeReservation(entries: readonly TradeReservationEntry[], target: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle]!.amount < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundTradeReservation(entries: readonly TradeReservationEntry[], target: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle]!.amount <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

const NEXT_FLOAT_BUFFER = new ArrayBuffer(8);
const NEXT_FLOAT_VIEW = new DataView(NEXT_FLOAT_BUFFER);

function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value;
  if (value === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE;
  if (value === 0) return Number.MIN_VALUE;
  NEXT_FLOAT_VIEW.setFloat64(0, value, false);
  const bits = NEXT_FLOAT_VIEW.getBigUint64(0, false);
  NEXT_FLOAT_VIEW.setBigUint64(0, bits + (value > 0 ? 1n : -1n), false);
  return NEXT_FLOAT_VIEW.getFloat64(0, false);
}

function nextDown(value: number): number {
  return -nextUp(-value);
}

interface TradeReservationBounds {
  lower: number;
  upper: number;
}

export interface TradeReservationDiagnostics {
  strict_candidate_visits?: number;
  legacy_candidate_visits?: number;
  strict_queries?: number;
  legacy_queries?: number;
  strict_cache_hits?: number;
  legacy_cache_hits?: number;
}

function incrementTradeReservationDiagnostic(
  diagnostics: TradeReservationDiagnostics | undefined,
  key: keyof TradeReservationDiagnostics,
): void {
  if (diagnostics) diagnostics[key] = (diagnostics[key] ?? 0) + 1;
}

function finiteNumberIdentity(value: number): string {
  NEXT_FLOAT_VIEW.setFloat64(0, value, false);
  return NEXT_FLOAT_VIEW.getBigUint64(0, false).toString(16).padStart(16, "0");
}

function strictTradeProbeIdentity(day: string, currency: string, wildcardCurrency: boolean, gross: number): string {
  return JSON.stringify([
    "strict",
    "raw-residual",
    day,
    wildcardCurrency ? "wildcard" : "exact",
    wildcardCurrency ? "*" : currency,
    finiteNumberIdentity(gross),
  ]);
}

function legacyTradeProbeIdentity(datePrefix: string, currency: string, gross: number): string {
  return JSON.stringify([
    "legacy",
    "rounded-cent",
    datePrefix,
    "exact",
    currency,
    finiteNumberIdentity(gross),
  ]);
}

function strictReservationBoundGuard(target: number, tolerance: number, bound: number): number {
  const scale = Math.max(1, Math.abs(target), Math.abs(tolerance), Math.abs(bound));
  const scaledMagnitude = (
    Math.abs(target) / scale +
    Math.abs(tolerance) / scale +
    Math.abs(bound) / scale
  );
  return Number.MIN_VALUE + Number.EPSILON * scale * scaledMagnitude * 8;
}

function strictTradeReservationBounds(target: number): TradeReservationBounds {
  const lowerTolerance = strictCandidateResidualTolerance(target, target);
  const rawLower = target - lowerTolerance;
  const lowerGuard = strictReservationBoundGuard(target, lowerTolerance, rawLower);

  let rawUpper = target + 0.01;
  for (let iteration = 0; iteration < 8; iteration++) {
    const expanded = target + strictCandidateResidualTolerance(target, rawUpper);
    if (expanded <= rawUpper) break;
    rawUpper = expanded;
  }
  const upperTolerance = strictCandidateResidualTolerance(target, rawUpper);
  const upperGuard = strictReservationBoundGuard(target, upperTolerance, rawUpper);

  return {
    lower: nextDown(rawLower - lowerGuard),
    upper: nextUp(rawUpper + upperGuard),
  };
}

function queryTradeReservationIndex(
  index: MutableTradeReservationIndex,
  key: string,
  target: number,
  tolerance: number,
  matches: (row: AccountStatementRow) => boolean,
  reserve: (reference: string) => void,
  bounds?: TradeReservationBounds,
  onCandidateVisit?: () => void,
): void {
  const group = index.groups.get(key);
  if (!group) return;
  const lower = lowerBoundTradeReservation(group.entries, bounds?.lower ?? target - tolerance);
  const upper = upperBoundTradeReservation(group.entries, bounds?.upper ?? target + tolerance);
  for (
    let position = findNextActive(group, lower);
    position < upper;
    position = findNextActive(group, position + 1)
  ) {
    const entry = group.entries[position]!;
    onCandidateVisit?.();
    if (matches(entry.row)) reserve(entry.reference);
  }
}

function strictTradeReservationKey(day: string, currency: string, wildcard: boolean): string {
  return `${wildcard ? "*" : "="}\u0000${day}\u0000${currency}`;
}

function legacyTradeReservationKey(datePrefix: string, currency: string): string {
  return `${datePrefix}\u0000${currency}`;
}

function buildTradeReservationIndexes(rows: AccountStatementRow[]): {
  strictH17: MutableTradeReservationIndex;
  legacyH16: MutableTradeReservationIndex;
} {
  const strictH17 = emptyTradeReservationIndex();
  const legacyH16 = emptyTradeReservationIndex();
  for (const row of rows) {
    if (row.type !== "Conversion") continue;
    const currency = normalizedCurrency(row.ccy);
    const amount = Math.abs(row.gross_amount);

    const day = statementDay(row.date);
    if (day !== null && currency !== "" && currency !== "EUR" && isFinitePositive(amount)) {
      addTradeReservationEntry(strictH17, strictTradeReservationKey(day, currency, false), amount, row);
      addTradeReservationEntry(strictH17, strictTradeReservationKey(day, "*", true), amount, row);
    }

    if (currency !== "EUR" && Number.isFinite(amount)) {
      addTradeReservationEntry(legacyH16, legacyTradeReservationKey(rawStatementDatePrefix(row.date), currency), roundMoney(amount), row);
    }
  }
  finalizeTradeReservationIndex(strictH17);
  finalizeTradeReservationIndex(legacyH16);
  return { strictH17, legacyH16 };
}

function reserveAndPruneTradeReference(
  reference: string,
  reserved: Set<string>,
  strict: MutableTradeReservationIndex,
  legacy: MutableTradeReservationIndex,
): void {
  if (reserved.has(reference)) return;
  reserved.add(reference);
  deactivateTradeReservationReference(strict, reference);
  deactivateTradeReservationReference(legacy, reference);
}

function addReferenceToBucket(
  index: ConversionCandidateIndex,
  reference: string,
  wildcard: boolean,
  key: string,
): void {
  const buckets = wildcard ? index.wildcardCurrencyBuckets : index.buckets;
  const references = buckets.get(key) ?? new Set<string>();
  if (references.has(reference)) return;
  references.add(reference);
  buckets.set(key, references);
  const keys = index.bucketKeysByReference.get(reference) ?? [];
  keys.push({ wildcard, key });
  index.bucketKeysByReference.set(reference, keys);
}

function buildConversionCandidateIndex(
  rows: AccountStatementRow[],
  excludedReferences: ReadonlySet<string> = new Set(),
): ConversionCandidateIndex {
  const index: ConversionCandidateIndex = {
    buckets: new Map(),
    wildcardCurrencyBuckets: new Map(),
    bucketKeysByReference: new Map(),
    evidenceByReference: new Map(),
  };
  for (const row of rows) {
    if (row.type !== "Conversion" || excludedReferences.has(row.reference)) continue;
    const day = statementDay(row.date);
    const currency = normalizedCurrency(row.ccy);
    const amount = Math.abs(row.gross_amount);
    const bucket = candidateAmountBucket(amount);
    if (day === null || currency === "" || currency === "EUR" || bucket === null) continue;
    const evidence = index.evidenceByReference.get(row.reference) ?? [];
    evidence.push(row);
    index.evidenceByReference.set(row.reference, evidence);
    addReferenceToBucket(index, row.reference, false, candidateBucketKey(day, currency, bucket));
    addReferenceToBucket(index, row.reference, true, candidateBucketKey(day, "*", bucket));
  }
  return index;
}

function referenceHasExactCandidateEvidence(
  index: ConversionCandidateIndex,
  reference: string,
  day: string,
  currency: string,
  amount: number,
  wildcardCurrency: boolean,
): boolean {
  return (index.evidenceByReference.get(reference) ?? []).some(row => {
    const rowCurrency = normalizedCurrency(row.ccy);
    return statementDay(row.date) === day &&
      rowCurrency !== "" &&
      rowCurrency !== "EUR" &&
      (wildcardCurrency || rowCurrency === currency) &&
      hasExactCandidateResidual(row.gross_amount, amount);
  });
}

function probeCappedReferences(
  index: ConversionCandidateIndex,
  day: string,
  currency: string,
  amount: number,
  wildcardCurrency = false,
): CappedReferenceMatch {
  const buckets = wildcardCurrency ? index.wildcardCurrencyBuckets : index.buckets;
  const bucketCurrency = wildcardCurrency ? "*" : currency;
  let first: string | null = null;
  for (const key of candidateProbeKeys(day, bucketCurrency, amount)) {
    for (const reference of buckets.get(key) ?? []) {
      if (!referenceHasExactCandidateEvidence(index, reference, day, currency, amount, wildcardCurrency)) continue;
      if (reference === first) continue;
      if (first === null) {
        first = reference;
        continue;
      }
      return { count: 2, uniqueReference: null };
    }
  }
  return first === null
    ? { count: 0, uniqueReference: null }
    : { count: 1, uniqueReference: first };
}

function removeConversionReference(index: ConversionCandidateIndex, reference: string): void {
  for (const { wildcard, key } of index.bucketKeysByReference.get(reference) ?? []) {
    const buckets = wildcard ? index.wildcardCurrencyBuckets : index.buckets;
    const references = buckets.get(key);
    references?.delete(reference);
    if (references?.size === 0) buckets.delete(key);
  }
  index.bucketKeysByReference.delete(reference);
  index.evidenceByReference.delete(reference);
}

type DistributionCandidateIndex = Map<string, Set<LightyearDistribution>>;

function buildDistributionCandidateIndex(
  distributions: readonly LightyearDistribution[],
  sourceRowsByIndex: ReadonlyMap<number, AccountStatementRow>,
): DistributionCandidateIndex {
  const index: DistributionCandidateIndex = new Map();
  for (const distribution of distributions) {
    const source = sourceRowsByIndex.get(distribution.row_index);
    if (!source || distribution.currency === "" || distribution.currency === "EUR" || !isFinitePositive(distribution.net_amount)) continue;
    const day = statementDay(source.date);
    const bucket = candidateAmountBucket(distribution.net_amount);
    if (day === null || bucket === null) continue;
    const key = candidateBucketKey(day, distribution.currency, bucket);
    const owners = index.get(key) ?? new Set<LightyearDistribution>();
    owners.add(distribution);
    index.set(key, owners);
  }
  return index;
}

function countCappedDistributionOwners(
  candidateRows: readonly AccountStatementRow[],
  distributionIndex: DistributionCandidateIndex,
  sourceRowsByIndex: ReadonlyMap<number, AccountStatementRow>,
): 0 | 1 | 2 {
  let first: LightyearDistribution | null = null;
  for (const row of candidateRows) {
    const day = statementDay(row.date);
    const currency = normalizedCurrency(row.ccy);
    const amount = Math.abs(row.gross_amount);
    if (day === null || currency === "" || currency === "EUR" || !isFinitePositive(amount)) continue;
    for (const key of candidateProbeKeys(day, currency, amount)) {
      for (const distribution of distributionIndex.get(key) ?? []) {
        const source = sourceRowsByIndex.get(distribution.row_index);
        if (
          !source ||
          statementDay(source.date) !== day ||
          distribution.currency !== currency ||
          !hasExactCandidateResidual(distribution.net_amount, amount)
        ) continue;
        if (distribution === first) continue;
        if (first === null) {
          first = distribution;
          continue;
        }
        return 2;
      }
    }
  }
  return first === null ? 0 : 1;
}

export function collectTradeReservedConversionRefs(
  rows: AccountStatementRow[],
  diagnostics?: TradeReservationDiagnostics,
): ReadonlySet<string> {
  const indexes = buildTradeReservationIndexes(rows);
  const reserved = new Set<string>();
  const processedStrictProbes = new Set<string>();
  const processedLegacyProbes = new Set<string>();
  for (const trade of rows) {
    if (trade.type !== "Buy" && trade.type !== "Sell") continue;
    const day = statementDay(trade.date);
    const gross = Math.abs(trade.gross_amount);
    const currency = normalizedCurrency(trade.ccy);

    if (day !== null && isFinitePositive(gross) && currency !== "EUR") {
      const wildcardCurrency = currency === "";
      const probeIdentity = strictTradeProbeIdentity(day, currency, wildcardCurrency, gross);
      if (processedStrictProbes.has(probeIdentity)) {
        incrementTradeReservationDiagnostic(diagnostics, "strict_cache_hits");
      } else {
        incrementTradeReservationDiagnostic(diagnostics, "strict_queries");
        queryTradeReservationIndex(
          indexes.strictH17,
          strictTradeReservationKey(day, wildcardCurrency ? "*" : currency, wildcardCurrency),
          gross,
          strictCandidateResidualTolerance(gross, gross),
          row => {
            const rowCurrency = normalizedCurrency(row.ccy);
            return statementDay(row.date) === day &&
              rowCurrency !== "" &&
              rowCurrency !== "EUR" &&
              (wildcardCurrency || rowCurrency === currency) &&
              hasExactCandidateResidual(row.gross_amount, gross);
          },
          reference => reserveAndPruneTradeReference(reference, reserved, indexes.strictH17, indexes.legacyH16),
          strictTradeReservationBounds(gross),
          () => incrementTradeReservationDiagnostic(diagnostics, "strict_candidate_visits"),
        );
        processedStrictProbes.add(probeIdentity);
      }
    }

    if (validateTradeAmounts(trade) === null && currency !== "EUR") {
      const datePrefix = rawStatementDatePrefix(trade.date);
      const roundedGross = roundMoney(gross);
      const probeIdentity = legacyTradeProbeIdentity(datePrefix, currency, gross);
      if (processedLegacyProbes.has(probeIdentity)) {
        incrementTradeReservationDiagnostic(diagnostics, "legacy_cache_hits");
      } else {
        incrementTradeReservationDiagnostic(diagnostics, "legacy_queries");
        queryTradeReservationIndex(
          indexes.legacyH16,
          legacyTradeReservationKey(datePrefix, currency),
          roundedGross,
          LEGACY_CENT_MATCH_TOLERANCE,
          row => rawStatementDatePrefix(row.date) === datePrefix &&
            normalizedCurrency(row.ccy) === currency &&
            agreesToCent(Math.abs(row.gross_amount), gross),
          reference => reserveAndPruneTradeReference(reference, reserved, indexes.strictH17, indexes.legacyH16),
          undefined,
          () => incrementTradeReservationDiagnostic(diagnostics, "legacy_candidate_visits"),
        );
        processedLegacyProbes.add(probeIdentity);
      }
    }
  }
  return reserved;
}

function distributionWarning(
  reference: string,
  reason: FxReviewReason,
  candidateReference?: string,
): string {
  const candidate = candidateReference === undefined
    ? ""
    : ` Conversion ${wrapUntrustedOcr(candidateReference) ?? ""}.`;
  return `${wrapUntrustedOcr(reference) ?? ""}: distribution review [${reason.code}] ${reason.message}${candidate}`;
}

function hasRawDistributionArithmetic(row: AccountStatementRow): boolean {
  const componentTotal = row.net_amount + row.tax_amount + row.fee;
  if (!Number.isFinite(componentTotal)) return false;
  const residual = Math.abs(row.gross_amount - componentTotal);
  return Number.isFinite(residual) &&
    residual <= 0.01 + boundedIeeeNoise(
      row.gross_amount,
      componentTotal,
      row.net_amount,
      row.tax_amount,
      row.fee,
    );
}

function nominalDistributionFailure(row: AccountStatementRow, currency: string): FxReviewReason | null {
  if (currency === "") return fxReason("distribution_currency_missing");
  if (
    !isFinitePositive(row.gross_amount) ||
    !isFiniteNonNegative(row.net_amount) ||
    !isFiniteNonNegative(row.tax_amount) ||
    !isFiniteNonNegative(row.fee) ||
    !hasRawDistributionArithmetic(row) ||
    !agreesToCent(row.gross_amount, row.net_amount + row.tax_amount + row.fee) ||
    (currency !== "EUR" && !isFinitePositive(row.net_amount))
  ) return fxReason("distribution_amount_conflict");
  return null;
}

function isBookableDistribution(distribution: LightyearDistribution): boolean {
  const { gross_eur, net_eur, tax_eur, fee_eur } = distribution;
  if (
    distribution.fx_review_reason !== null ||
    gross_eur === null || net_eur === null || tax_eur === null || fee_eur === null ||
    !isFinitePositive(gross_eur) ||
    !isFiniteNonNegative(net_eur) ||
    !isFiniteNonNegative(tax_eur) ||
    !isFiniteNonNegative(fee_eur) ||
    !hasExactRoundedMoneyBalance(gross_eur, net_eur, tax_eur, fee_eur)
  ) return false;
  return distribution.currency === "EUR"
    ? distribution.fx_provenance === null
    : distribution.fx_provenance !== null;
}

function sumBookableDistributionGrossEur(distributions: readonly LightyearDistribution[]): number {
  let totalCents = 0;
  for (const distribution of distributions) {
    if (!isBookableDistribution(distribution) || distribution.gross_eur === null) continue;
    const grossCents = moneyToSafeCents(distribution.gross_eur);
    if (grossCents === null) return 0;
    const nextTotal = totalCents + grossCents;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_UNAMBIGUOUS_MONEY_CENTS) return 0;
    totalCents = nextTotal;
  }
  return roundMoney(totalCents / 100);
}

function extractDistributions(
  rows: AccountStatementRow[],
  tradeReservedConversionRefs: ReadonlySet<string>,
): DistributionExtractionResult {
  const sourceRows = rows.filter(r => r.type === "Distribution" || r.type === "Dividend" || r.type === "Interest" || r.type === "Reward");
  const sourceRowsByIndex = new Map(sourceRows.map(row => [row.row_index, row]));
  const conversions = conversionRowsByReference(rows);
  const distributions: LightyearDistribution[] = sourceRows.map(row => ({
    row_index: row.row_index,
    date: parseLightyearDate(row.date),
    reference: row.reference,
    type: row.type,
    ticker: row.ticker,
    isin: row.isin,
    currency: normalizedCurrency(row.ccy),
    gross_amount: row.gross_amount,
    fee: row.fee,
    net_amount: row.net_amount,
    tax_amount: row.tax_amount,
    gross_eur: null,
    fee_eur: null,
    net_eur: null,
    tax_eur: null,
    fx_provenance: null,
    fx_review_reason: null,
  }));

  const rawCandidateIndex = buildConversionCandidateIndex(rows);
  const availableCandidateIndex = buildConversionCandidateIndex(rows, tradeReservedConversionRefs);
  const rawCandidates = new Map<LightyearDistribution, CappedReferenceMatch>();
  const availableCandidates = new Map<LightyearDistribution, CappedReferenceMatch>();
  for (const distribution of distributions) {
    const source = sourceRowsByIndex.get(distribution.row_index)!;
    const nominalFailure = nominalDistributionFailure(source, distribution.currency);
    const day = statementDay(source.date);
    const canProbe = day !== null && distribution.currency !== "" && distribution.currency !== "EUR" && isFinitePositive(distribution.net_amount);
    const raw = canProbe
      ? probeCappedReferences(rawCandidateIndex, day, distribution.currency, distribution.net_amount)
      : { count: 0 as const, uniqueReference: null };
    const available = canProbe
      ? probeCappedReferences(availableCandidateIndex, day, distribution.currency, distribution.net_amount)
      : { count: 0 as const, uniqueReference: null };
    rawCandidates.set(distribution, raw);
    availableCandidates.set(distribution, available);
    if (nominalFailure) {
      distribution.fx_review_reason = nominalFailure;
      continue;
    }
    if (distribution.currency === "EUR") {
      try {
        const grossEur = roundMoney(distribution.gross_amount);
        const netEur = roundMoney(distribution.net_amount);
        const taxEur = roundMoney(distribution.tax_amount);
        const feeEur = roundMoney(distribution.fee);
        if (
          !isFinitePositive(grossEur) ||
          !isFiniteNonNegative(netEur) ||
          !isFiniteNonNegative(taxEur) ||
          !isFiniteNonNegative(feeEur) ||
          !hasExactRoundedMoneyBalance(grossEur, netEur, taxEur, feeEur)
        ) {
          distribution.fx_review_reason = fxReason("distribution_amount_conflict");
          continue;
        }
        distribution.gross_eur = grossEur;
        distribution.net_eur = netEur;
        distribution.tax_eur = taxEur;
        distribution.fee_eur = feeEur;
      } catch {
        distribution.fx_review_reason = fxReason("distribution_amount_conflict");
        distribution.gross_eur = distribution.net_eur = distribution.tax_eur = distribution.fee_eur = null;
      }
      continue;
    }
  }

  const distributionCandidateIndex = buildDistributionCandidateIndex(distributions, sourceRowsByIndex);
  const ownerCounts = new Map<string, 0 | 1 | 2>();

  const consumedConversionRefs = new Set<string>();
  for (const distribution of distributions) {
    if (distribution.fx_review_reason || distribution.currency === "EUR") continue;
    const available = availableCandidates.get(distribution) ?? { count: 0, uniqueReference: null };
    if (available.count !== 1 || available.uniqueReference === null) {
      distribution.fx_review_reason = fxReason("invalid_conversion_pair");
      continue;
    }
    const reference = available.uniqueReference;
    const candidateRows = conversions.get(reference) ?? [];
    let ownerCount = ownerCounts.get(reference);
    if (ownerCount === undefined) {
      ownerCount = countCappedDistributionOwners(candidateRows, distributionCandidateIndex, sourceRowsByIndex);
      ownerCounts.set(reference, ownerCount);
    }
    if (ownerCount !== 1) {
      distribution.fx_review_reason = fxReason("invalid_conversion_pair");
      continue;
    }
    const eurRows = candidateRows.filter(row => normalizedCurrency(row.ccy) === "EUR");
    const foreignRows = candidateRows.filter(row => normalizedCurrency(row.ccy) === distribution.currency);
    const day = statementDay(sourceRowsByIndex.get(distribution.row_index)!.date);
    if (
      candidateRows.length !== 2 || eurRows.length !== 1 || foreignRows.length !== 1 ||
      day === null ||
      candidateRows.some(row => statementDay(row.date) !== day)
    ) {
      distribution.fx_review_reason = fxReason("invalid_conversion_pair");
      continue;
    }
    const eur = eurRows[0]!;
    const foreign = foreignRows[0]!;
    if (!isFinitePositive(Math.abs(eur.net_amount)) || !isFinitePositive(Math.abs(foreign.net_amount))) {
      distribution.fx_review_reason = fxReason("invalid_net_amount");
      continue;
    }
    const amountFailure = validateConversionAmounts(eur, foreign);
    if (amountFailure && amountFailure.code !== "conversion_fee_conflict") {
      distribution.fx_review_reason = amountFailure;
      continue;
    }
    if (eur.net_amount <= 0 || foreign.net_amount >= 0) {
      distribution.fx_review_reason = fxReason("conversion_amount_conflict");
      continue;
    }
    if (eur.fee !== 0 || foreign.fee !== 0) {
      distribution.fx_review_reason = fxReason("conversion_fee_conflict");
      continue;
    }
    const resolution = resolveFxPair(Math.abs(eur.net_amount), Math.abs(foreign.net_amount), [eur.fx_rate, foreign.fx_rate]);
    if (!resolution.ok) {
      distribution.fx_review_reason = resolution.reason;
      continue;
    }
    try {
      const netEur = roundMoney(Math.abs(eur.net_amount));
      const taxEur = roundMoney(convertForeignToEur(distribution.tax_amount, resolution.rate, resolution.orientation));
      const feeEur = roundMoney(convertForeignToEur(distribution.fee, resolution.rate, resolution.orientation));
      const grossEur = roundMoney(netEur + taxEur + feeEur);
      const directGross = convertForeignToEur(distribution.gross_amount, resolution.rate, resolution.orientation);
      const roundedDirectGross = roundMoney(directGross);
      if (
        !isFinitePositive(grossEur) ||
        !isFiniteNonNegative(netEur) ||
        !isFiniteNonNegative(taxEur) ||
        !isFiniteNonNegative(feeEur) ||
        !isFiniteNonNegative(roundedDirectGross) ||
        moneyToSafeCents(roundedDirectGross) === null ||
        !hasExactRoundedMoneyBalance(grossEur, netEur, taxEur, feeEur) ||
        !agreesToCent(grossEur, roundedDirectGross)
      ) {
        distribution.fx_review_reason = fxReason("distribution_amount_conflict");
        continue;
      }
      distribution.net_eur = netEur;
      distribution.tax_eur = taxEur;
      distribution.fee_eur = feeEur;
      distribution.gross_eur = grossEur;
      distribution.fx_provenance = {
        rate: resolution.rate,
        orientation: resolution.orientation,
        conversion_reference: reference,
        conversion_row_indexes: [eur.row_index, foreign.row_index],
      };
      consumedConversionRefs.add(reference);
    } catch {
      distribution.fx_review_reason = fxReason("distribution_amount_conflict");
      distribution.gross_eur = distribution.net_eur = distribution.tax_eur = distribution.fee_eur = null;
      distribution.fx_provenance = null;
    }
  }

  const aggregateContributors = distributions.filter(isBookableDistribution);
  const aggregateGrossCents = aggregateContributors.map(distribution =>
    distribution.gross_eur === null ? null : moneyToSafeCents(distribution.gross_eur)
  );
  let aggregateTotalCents = 0;
  let aggregateIsSafe = true;
  for (const grossCents of aggregateGrossCents) {
    if (
      grossCents === null ||
      grossCents < 0 ||
      aggregateTotalCents > MAX_UNAMBIGUOUS_MONEY_CENTS - grossCents
    ) {
      aggregateIsSafe = false;
      break;
    }
    aggregateTotalCents += grossCents;
  }

  if (!aggregateIsSafe) {
    for (const distribution of aggregateContributors) {
      if (distribution.fx_provenance !== null) {
        consumedConversionRefs.delete(distribution.fx_provenance.conversion_reference);
      }
      distribution.gross_eur = null;
      distribution.net_eur = null;
      distribution.tax_eur = null;
      distribution.fee_eur = null;
      distribution.fx_provenance = null;
      distribution.fx_review_reason = fxReason("distribution_amount_conflict");
    }
  }

  const warnings = distributions
    .filter(distribution => distribution.fx_review_reason !== null)
    .map(distribution => {
      const raw = rawCandidates.get(distribution) ?? { count: 0, uniqueReference: null };
      return distributionWarning(
        distribution.reference,
        distribution.fx_review_reason!,
        raw.count === 1 ? raw.uniqueReference ?? undefined : undefined,
      );
    });
  return { distributions, warnings, consumedConversionRefs };
}

interface LightyearRefLookup {
  reference: string;
  date: string;
}

// Scans a pre-loaded journal snapshot (from the BookingGuard) rather than
// issuing its own listAll — this keeps the legacy raw-ref date-cross-check
// (which the guard's LY:-prefix Lane A does not model) while sharing the single
// per-run snapshot. The guard handles the canonical LY: prefix at create time;
// this function additionally catches legacy journals booked with a bare ref.
function findExistingJournalsByRef(
  allJournals: readonly Journal[],
  lookups: LightyearRefLookup[],
): Set<string> {
  if (lookups.length === 0) return new Set();

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
 * - Exactly one eligible match (raw exact or within the bounded proceeds
 *   tolerance) → pair. Tolerant matches retain the existing review warning.
 * - Multiple eligible matches → SKIP the sell with an ambiguity warning.
 * - Shaped matches outside the proceeds tolerance → SKIP with an actionable
 *   manual-review warning.
 */
export function withinProceedsTolerance(
  actual: number,
  expected: number,
  absolute = 0.02,
  relative = 0.001,
): boolean {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    !Number.isFinite(absolute) ||
    !Number.isFinite(relative) ||
    absolute < 0 ||
    relative < 0
  ) {
    return false;
  }

  const difference = Math.abs(actual - expected);
  return difference <= Math.max(absolute, Math.abs(expected) * relative);
}

function matchSellsToCapitalGains(
  sells: InvestmentTrade[],
  gains: CapitalGainsRow[],
  warnings: string[] = []
): Map<string, CapitalGainsRow> {
  const result = new Map<string, CapitalGainsRow>();
  const consumedGains = new Set<number>();

  for (const sell of sells) {
    const exactMatches: number[] = [];
    const tolerantMatches: number[] = [];
    const outsideMatches: number[] = [];

    for (let i = 0; i < gains.length; i++) {
      if (consumedGains.has(i)) continue;
      const gain = gains[i]!;
      const gainDate = parseLightyearDate(gain.date);

      if (gainDate !== sell.date) continue;
      if (gain.ticker !== sell.ticker) continue;
      if (Math.abs(gain.quantity - sell.quantity) >= 0.000001) continue;

      if (Math.abs(gain.proceeds_eur - sell.eur_amount) < 0.02) {
        exactMatches.push(i);
      } else if (withinProceedsTolerance(sell.eur_amount, gain.proceeds_eur)) {
        tolerantMatches.push(i);
      } else {
        outsideMatches.push(i);
      }
    }

    const eligibleMatches = [...exactMatches, ...tolerantMatches];

    if (eligibleMatches.length === 1) {
      const idx = eligibleMatches[0]!;
      const gain = gains[idx]!;
      if (tolerantMatches.length === 1) {
        warnings.push(
          `Inexact FIFO match for sell ${sell.reference} (${sell.ticker} x${sell.quantity} on ${sell.date}): ` +
          `proceeds differ (sell ${sell.eur_amount} EUR vs gains ${gain.proceeds_eur} EUR, likely FX rounding). ` +
          `Using date+ticker+qty match; verify cost basis.`
        );
      }
      result.set(sell.reference, gains[idx]!);
      consumedGains.add(idx);
    } else if (eligibleMatches.length > 1) {
      warnings.push(
        `Ambiguous FIFO match for sell ${sell.reference} (${sell.ticker} x${sell.quantity} on ${sell.date}): ` +
        `${eligibleMatches.length} gains rows match date+ticker+qty within proceeds tolerance. ` +
        `Skipping — verify cost basis manually and book the journal by hand.`
      );
      // Don't book — ambiguous cost basis is worse than missing it.
    } else if (outsideMatches.length > 0) {
      warnings.push(
        `FIFO candidates for sell ${sell.reference} (${sell.ticker} x${sell.quantity} on ${sell.date}, ` +
        `sell proceeds ${sell.eur_amount} EUR) are outside proceeds tolerance. ` +
        `Skipping — manual review is required before booking.`
      );
    }
  }

  return result;
}

export function registerLightyearTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "parse_lightyear_statement",
    "Parse a Lightyear account statement CSV. Returns summary by default; set include_rows=true for trade/distribution details.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file."),
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
      const tradeReservedConversionRefs = collectTradeReservedConversionRefs(rows);
      const {
        trades,
        warnings: fxWarnings,
      } = extractTrades(rows);
      const distributionExtraction = extractDistributions(rows, tradeReservedConversionRefs);
      const distributions = distributionExtraction.distributions;
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
        ...rows.filter(row => row.type === "Conversion" && distributionExtraction.consumedConversionRefs.has(row.reference)).map(row => row.row_index),
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
        else if (r.type === "Reward") suggestion = `Platform reward — book via book_lightyear_distributions (defaults to ${DEFAULT_OTHER_FINANCIAL_INCOME_ACCOUNT} Muud finantstulud).`;
        else if (r.type === "Interest") suggestion = "Interest income — book via book_lightyear_distributions.";
        else if (r.type === "Dividend" || r.type === "Distribution") suggestion = "Distribution — book via book_lightyear_distributions.";
        else if (r.type === "Buy" || r.type === "Sell") suggestion = `${r.type} of ${r.ticker} — missing FX pairing or unsupported trade flow. Check if intentional.`;
        return {
          date: parseLightyearDate(r.date),
          // Security: `reference` is the free-form CSV column an attacker can
          // control (parseCSV honours quoted embedded newlines), so it is
          // sandbox-wrapped before it reaches MCP output — same treatment as the
          // sibling parse_lightyear_capital_gains `name`. ticker/ccy are
          // structurally bounded tokens and are left raw.
          reference: wrapUntrustedOcr(r.reference),
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

      const tradeFeesInEur = new Map<InvestmentTrade, number | null>();
      const unresolvedTradeFeeWarnings: string[] = [];
      for (const trade of bookableTrades) {
        const convertedFee = tradeFeeInEur(trade);
        tradeFeesInEur.set(trade, convertedFee);
        if (convertedFee === null && trade.fx_review_reason === null) {
          unresolvedTradeFeeWarnings.push(fxReviewWarning(
            trade.reference,
            fxReason("trade_fee_unresolved"),
            trade.conversion_ref ?? undefined,
          ));
        }
      }

      const summary: Record<string, { buys: number; sells: number; total_invested_eur: number; total_sold_eur: number }> = {};
      for (const [ticker, tickerTrades] of byTicker) {
        const buys = tickerTrades.filter(t => t.type === "Buy");
        const sells = tickerTrades.filter(t => t.type === "Sell");
        summary[ticker] = {
          buys: buys.length,
          sells: sells.length,
          total_invested_eur: roundMoney(buys.reduce((s, t) => {
            const convertedFee = tradeFeesInEur.get(t);
            return s + t.eur_amount + (convertedFee === null || convertedFee === undefined ? 0 : convertedFee);
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

      const warnings: string[] = [...fxWarnings, ...unresolvedTradeFeeWarnings, ...distributionExtraction.warnings];
      if (unmatchedFx.length > 0) {
        warnings.push(
          `${unmatchedFx.length} foreign currency trade(s) could not be matched to FX conversion entries: ` +
          unmatchedFx.map(t => `${wrapUntrustedOcr(t.reference) ?? ""} (${t.ticker} ${t.ccy})`).join(", ")
        );
      }
      const cashOverflowEntries = Object.entries(cashReconciliation.overflow_by_currency ?? {});
      if (cashOverflowEntries.length > 0) {
        warnings.push(
          `Statement cash reconciliation overflowed while accumulating: ` +
          cashOverflowEntries
            .map(([currency, states]) => `${currency} (${states.join(", ")})`)
            .join("; ") +
          `. Reconciliation is not balanced; review the statement manually.`
        );
      } else if (!cashReconciliation.is_balanced) {
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
          bookable_count: distributions.filter(isBookableDistribution).length,
          review_count: distributions.filter(distribution => !isBookableDistribution(distribution)).length,
          total_eur: sumBookableDistributionGrossEur(distributions),
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
        ...((
          !cashReconciliation.is_balanced ||
          unhandledSuggestions.length > 0 ||
          trades.some(trade => trade.fx_review_reason !== null) ||
          unresolvedTradeFeeWarnings.length > 0 ||
          distributions.some(distribution => distribution.fx_review_reason !== null)
        ) && {
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
        ? `## Trades (${bookableTrades.length})\n\n| Date | Ref | Ticker | Type | Qty | CCY | EUR | Fee |\n|------|-----|--------|------|-----|-----|-----|-----|\n${bookableTrades.map(t => `| ${t.date} | ${wrapUntrustedOcr(t.reference) ?? ""} | ${t.ticker} | ${t.type} | ${t.quantity} | ${t.ccy} | ${t.eur_amount.toFixed(2)} | ${t.fee_eur.toFixed(2)} |`).join("\n")}`
        : "";

      const eurCell = (value: number | null): string => value === null ? "—" : value.toFixed(2);
      const distRows = distributions.map(d => {
        const status = isBookableDistribution(d) ? "bookable" : `manual_review:${d.fx_review_reason!.code}`;
        const fx = d.currency === "EUR"
          ? "source_eur"
          : d.fx_provenance
            ? `${d.fx_provenance.rate} ${d.fx_provenance.orientation} via ${wrapUntrustedOcr(d.fx_provenance.conversion_reference) ?? ""}`
            : "—";
        return `| ${d.date} | ${wrapUntrustedOcr(d.reference) ?? ""} | ${d.ticker || "—"} | ${d.currency} | ${d.gross_amount.toFixed(2)} | ${d.tax_amount.toFixed(2)} | ${d.fee.toFixed(2)} | ${d.net_amount.toFixed(2)} | ${eurCell(d.gross_eur)} | ${eurCell(d.tax_eur)} | ${eurCell(d.fee_eur)} | ${eurCell(d.net_eur)} | ${status} | ${fx} |`;
      });
      const distTable = distributions.length > 0
        ? `## Distributions (${distributions.length})\n\n| Date | Ref | Ticker | CCY | Gross CCY | Tax CCY | Fee CCY | Net CCY | Gross EUR | Tax EUR | Fee EUR | Net EUR | Status | FX |\n|------|-----|--------|-----|-----------|---------|---------|---------|-----------|---------|---------|---------|--------|----|\n${distRows.join("\n")}`
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
    "Book Lightyear stock Buy/Sell trades. DRY RUN by default. For sells, capital_gains_file is required for FIFO cost basis and recognized gain/loss.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file."),
      capital_gains_file: z.string().optional().describe("Absolute path to Lightyear CapitalGainsStatement CSV (required for sell entries)"),
      investment_account: z.number().describe("Investment/securities account (e.g. 1550 Finantsinvesteeringud)"),
      investment_dimension_id: z.number().optional().describe("Dimension ID for investment account (accounts_dimensions_id)"),
      broker_account: z.number().describe("Broker cash account (e.g. 1120 Lightyear konto)"),
      broker_dimension_id: z.number().optional().describe("Dimension ID for broker account (accounts_dimensions_id)"),
      gain_loss_account: z.number().optional().describe("Realized gain account, credited on a sell gain (default: auto-detect 'Tulu aktsiatelt ja osadelt', standard 8330)"),
      loss_account: z.number().optional().describe("Realized loss account, debited on a sell loss (default: auto-detect 'Kulu aktsiatelt ja osadelt', standard 8335)"),
      fee_account: z.number().optional().describe("Account for EXPENSED trade fees — all Sell fees and a Buy's FX-conversion fee (default: auto-detect 'Kulu aktsiatelt ja osadelt', standard 8335). A Buy's trade platform fee is capitalized into the investment cost to match FIFO cost basis and is NOT posted here."),
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

      // Validate accounts exist and are active. Securities trading results route
      // to the standard securities account PAIR (name-resolved against the actual
      // chart, standard fallbacks 8330/8335): realized gain → 8330 "Tulu
      // aktsiatelt ja osadelt"; realized loss and EXPENSED trade fees → 8335 "Kulu
      // aktsiatelt ja osadelt". Expensed fees = all Sell fees and a Buy's
      // FX-conversion fee; a Buy's trade platform fee is capitalized into the
      // investment cost (to match FIFO cost basis), not posted to 8335. Dimension
      // is left null on 8330/8335. A caller override still wins per account.
      const accounts = await api.readonly.getAccounts();
      const gainAccount = resolveSecuritiesIncomeAccount(accounts, gain_loss_account);
      const lossAccount = resolveSecuritiesExpenseAccount(accounts, loss_account);
      const feeAccount = resolveSecuritiesExpenseAccount(accounts, fee_account);
      const errors = validateAccounts(accounts, [
        { id: investment_account, label: "Investment account" },
        { id: broker_account, label: "Broker account" },
        { id: feeAccount, label: "Fee account" },
        { id: gainAccount, label: "Gain account" },
        { id: lossAccount, label: "Loss account" },
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

      // Check for duplicates. Load one BookingGuard snapshot for the whole run:
      // findExistingJournalsByRef reads it for legacy raw-ref detection, and the
      // create sites below use guard.createJournalOnce for LY:-prefix idempotency
      // (incl. in-run dedup of duplicate references within a single CSV).
      const guard = await BookingGuard.load(api);
      const allRefs = trades.map(t => ({ reference: t.reference, date: t.date }));
      const existingRefs = findExistingJournalsByRef(guard.journals, allRefs);

      // Dedupe against existing journals AND within this CSV. Two rows sharing a
      // reference must resolve to ONE journal, so the first occurrence books and
      // any later same-ref row is a duplicate — mirroring the existing-journal
      // dedup. Doing it here keeps the dry-run preview counts matching what
      // execution actually creates (the loop only ever sees the first occurrence).
      const seenRefs = new Set<string>();
      const newTrades: typeof trades = [];
      const duplicates: typeof trades = [];
      for (const t of trades) {
        if (existingRefs.has(t.reference) || seenRefs.has(t.reference)) {
          duplicates.push(t);
        } else {
          seenRefs.add(t.reference);
          newTrades.push(t);
        }
      }

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
        const readiness = classifyTradeIntrinsicReadiness(trade);
        if (readiness.kind === "review_required") {
          if (trade.fx_review_reason === null) {
            warnings.push(fxReviewWarning(
              trade.reference,
              readiness.reason,
              trade.conversion_ref ?? undefined,
            ));
          }
          results.push({
            reference: trade.reference,
            ticker: trade.ticker,
            type: trade.type,
            date: trade.date,
            eur_amount: 0,
            status: "skipped",
            skip_reason: readiness.reason.message,
          });
          continue;
        }

        // eur_amount is the EUR conversion net (after FX fee deduction).
        // fx_fee_eur is the FX conversion fee. trade.fee_eur is the trade platform fee.
        const tradeFeeEur = readiness.converted_trade_fee_eur;
        const postings: Array<{ accounts_id: number; accounts_dimensions_id?: number; type: "D" | "C"; amount: number }> = [];

        if (trade.type === "Buy") {
          // Investment cost = eur_amount (conversion net) + trade fee. FX fee is always
          // expensed separately — Lightyear's capital gains report does NOT include FX fees
          // in cost basis, so including them in the investment account would leave a residual
          // balance on every sell.
          const feeAcct = feeAccount;
          const totalFees = roundMoney(trade.fx_fee_eur + tradeFeeEur);
          const investmentCostEur = roundMoney(trade.eur_amount + tradeFeeEur);
          const totalCashOutEur = roundMoney(trade.eur_amount + totalFees);

          if (totalFees > 0) {
            // Capitalize the trade platform fee into the investment cost so the
            // investment account matches the FIFO cost basis relieved on sell
            // (the capital-gains report bakes the trade fee into cost basis).
            // Only the FX conversion fee is expensed — the report excludes it,
            // so capitalizing it would strand a residual on every sell.
            postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "D", amount: investmentCostEur });
            if (trade.fx_fee_eur > 0) {
              postings.push({ accounts_id: feeAcct, type: "D", amount: trade.fx_fee_eur });
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
              const feeAcct = feeAccount;
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

            const outcome = await guard.createJournalOnce(
              { ns: "LY", id: trade.reference },
              { title, effective_date: trade.date, cl_currencies_id: "EUR", postings },
              { confirm: false }, // Lightyear journals stay in PROJECT for review
            );
            resultEntry.journal_id = outcome.journal_id;
            if (outcome.status === "duplicate") {
              // The guard found an existing journal for this key (already booked
              // this run or a prior run) — do NOT log a second CREATED audit event
              // or report a fresh creation. Report it as a duplicate instead.
              resultEntry.status = "duplicate";
              results.push(resultEntry);
              continue;
            }
            logAudit({
              tool: "book_lightyear_trades", action: "CREATED", entity_type: "journal",
              entity_id: outcome.journal_id,
              summary: `Lightyear cash-equivalent sell: ${trade.ticker} ${trade.quantity} @ ${proceeds} EUR`,
              details: {
                effective_date: trade.date, ticker: trade.ticker, type: "Sell",
                amount: proceeds, gain_loss: 0,
                postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
              },
            });

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

          const costBasis = roundMoney(gainEntry.cost_basis_eur);
          const proceeds = roundMoney(gainEntry.proceeds_eur);
          // Derive gain/loss so the journal balances by construction (CSV columns are independently rounded)
          const gainLoss = roundMoney(proceeds - costBasis);

          // Dr broker_account: proceeds (what we receive)
          // Cr investment_account: cost_basis (what we originally paid)
          // Cr securities-income (gainAccount, 8330) on a gain / Dr securities-
          // expense (lossAccount, 8335) on a loss — both resolved above.
          postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "D", amount: proceeds });
          postings.push({ accounts_id: investment_account, ...(investment_dimension_id && { accounts_dimensions_id: investment_dimension_id }), type: "C", amount: costBasis });

          if (gainLoss > 0) {
            postings.push({ accounts_id: gainAccount, type: "C", amount: gainLoss });
          } else if (gainLoss < 0) {
            postings.push({ accounts_id: lossAccount, type: "D", amount: Math.abs(gainLoss) });
          }

          const sellFees = roundMoney(tradeFeeEur + trade.fx_fee_eur);
          if (sellFees > 0) {
            const feeAcct = feeAccount;
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

          const outcome = await guard.createJournalOnce(
            { ns: "LY", id: trade.reference },
            { title, effective_date: trade.date, cl_currencies_id: "EUR", postings },
            { confirm: false }, // Lightyear journals stay in PROJECT for review
          );
          resultEntry.journal_id = outcome.journal_id;
          if (outcome.status === "duplicate") {
            // Existing journal for this key — skip the CREATED audit and report a duplicate.
            resultEntry.status = "duplicate";
            results.push(resultEntry);
            continue;
          }
          logAudit({
            tool: "book_lightyear_trades", action: "CREATED", entity_type: "journal",
            entity_id: outcome.journal_id,
            summary: `Lightyear Sell: ${trade.ticker} ${trade.quantity} @ ${proceeds} EUR, gain/loss ${gainLoss} EUR`,
            details: {
              effective_date: trade.date, ticker: trade.ticker, type: "Sell",
              amount: proceeds, cost_basis: costBasis, gain_loss: gainLoss,
              postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
            },
          });

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
          const outcome = await guard.createJournalOnce(
            { ns: "LY", id: trade.reference },
            { title, effective_date: trade.date, cl_currencies_id: "EUR", postings },
            { confirm: false }, // Lightyear journals stay in PROJECT for review
          );
          if (outcome.status === "duplicate") {
            // Existing journal for this key — skip the CREATED audit and report a duplicate.
            results.push({
              reference: trade.reference,
              ticker: trade.ticker,
              type: trade.type,
              date: trade.date,
              eur_amount: trade.eur_amount,
              status: "duplicate",
              journal_id: outcome.journal_id,
            });
          } else {
            logAudit({
              tool: "book_lightyear_trades", action: "CREATED", entity_type: "journal",
              entity_id: outcome.journal_id,
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
              journal_id: outcome.journal_id,
            });
          }
        }
      }

      const skippedSells = results.filter(r => r.status === "skipped" && r.type === "Sell");
      if (skippedSells.length > 0 && !capital_gains_file) {
        warnings.push(
          `${skippedSells.length} sell trade(s) skipped — provide capital_gains_file to book non-cash-equivalent sells with correct cost basis (the gain/loss accounts default to 8330/8335).`
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
              gain: gainAccount,
              loss: lossAccount,
              fee: feeAccount,
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
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file."),
      broker_account: z.number().describe("Broker cash account (e.g. 1120 Lightyear konto)"),
      broker_dimension_id: z.number().optional().describe("Dimension ID for broker account (accounts_dimensions_id)"),
      income_account: z.number().describe("Investment income account for the distribution. Dividends from directly-held shares → 8330 'Tulu aktsiatelt ja osadelt'; fund distributions → 8320; interest → 8400."),
      reward_account: z.number().optional().describe(`Account for platform rewards/bonuses (default: auto-detect 'Muud finantstulud', standard ${DEFAULT_OTHER_FINANCIAL_INCOME_ACCOUNT}). Rewards are broker fee/campaign income, not securities income.`),
      tax_account: z.number().optional().describe("Withheld tax receivable/expense account (for tax_amount from CSV)"),
      fee_account: z.number().optional().describe(`Platform fee expense account (default ${DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT} Muud finantskulud)`),
      dry_run: z.boolean().optional().describe("Preview without creating entries (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Book Lightyear Distributions" },
    async ({ file_path, broker_account, broker_dimension_id, income_account, reward_account: reward_account_param, tax_account, fee_account: fee_account_param, dry_run }) => {
      const isDryRun = dry_run !== false;
      const fee_account = fee_account_param ?? DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT;

      const csv = await readCsvFile(file_path);
      const rows = parseAccountStatement(csv);
      const extraction = extractDistributions(rows, collectTradeReservedConversionRefs(rows));
      const distributions = extraction.distributions;
      const bookable = distributions.filter(isBookableDistribution);
      const reviewed = distributions.filter(distribution => !isBookableDistribution(distribution));
      const sourceFields = (distribution: LightyearDistribution) => ({
        reference: distribution.reference,
        ticker: distribution.ticker,
        date: distribution.date,
        currency: distribution.currency,
        gross_amount: distribution.gross_amount,
        tax_amount: distribution.tax_amount,
        fee: distribution.fee,
        net_amount: distribution.net_amount,
        gross_eur: distribution.gross_eur,
        tax_eur: distribution.tax_eur,
        fee_eur: distribution.fee_eur,
        net_eur: distribution.net_eur,
        fx_provenance: distribution.fx_provenance,
      });
      const manualResult = (distribution: LightyearDistribution) => ({
        ...sourceFields(distribution),
        status: "manual_review",
        review_reason: distribution.fx_review_reason,
      });
      const baseResponse = {
        mode: isDryRun ? "DRY_RUN" : "EXECUTED",
        total_distributions: distributions.length,
        bookable_distributions: bookable.length,
        review_required: reviewed.length,
        ...(extraction.warnings.length > 0 && { warnings: extraction.warnings }),
        note: isDryRun
          ? "Set dry_run=false to create journal entries."
          : "Journal entries created. Review and register when ready.",
      };
      if (bookable.length === 0) {
        return {
          content: [{ type: "text", text: toMcpJson({
            ...baseResponse,
            new_entries: 0,
            duplicates_skipped: 0,
            results: reviewed.map(manualResult),
          }) }],
        };
      }

      const hasReward = bookable.some(distribution => distribution.type === "Reward");
      const needsTax = bookable.some(distribution => (distribution.tax_eur ?? 0) > 0);
      const needsFee = bookable.some(distribution => (distribution.fee_eur ?? 0) > 0);
      const accounts = await api.readonly.getAccounts();
      // Broker rewards/bonuses are broker fee/campaign income, not securities
      // income — default to "Muud finantstulud" (standard 8600, name-resolved),
      // NOT the 8330 securities-income account used for dividends/sell gains.
      const reward_account = resolveOtherFinancialIncomeAccount(accounts, reward_account_param);
      const errors = validateAccounts(accounts, [
        { id: broker_account, label: "Broker account" },
        { id: income_account, label: "Income account" },
        ...((hasReward || reward_account_param !== undefined)
          ? [{ id: reward_account, label: "Reward account" }]
          : []),
        ...(tax_account !== undefined ? [{ id: tax_account, label: "Tax account" }] : []),
        ...((needsFee || fee_account_param !== undefined) ? [{ id: fee_account, label: "Fee account" }] : []),
      ]);

      if (errors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: errors,
        });
      }

      if (!tax_account && needsTax) {
        return toolError({
          error: "tax_account is required when distributions include withheld tax",
          hint: "Provide tax_account so tax_amount can be booked separately for Lightyear distributions.",
        });
      }

      // Check duplicates — one snapshot for the run (see book_lightyear_trades).
      const guard = await BookingGuard.load(api);
      const allRefs = bookable.map(d => ({ reference: d.reference, date: d.date }));
      const existingRefs = findExistingJournalsByRef(guard.journals, allRefs);

      // Dedupe against existing journals AND within this CSV (see book_lightyear_trades):
      // the first occurrence of a reference books, later same-ref rows are duplicates,
      // so dry-run counts match what execution creates.
      const seenRefs = new Set<string>();
      const newDist: LightyearDistribution[] = [];
      const duplicates: LightyearDistribution[] = [];
      for (const d of bookable) {
        if (existingRefs.has(d.reference) || seenRefs.has(d.reference)) {
          duplicates.push(d);
        } else {
          seenRefs.add(d.reference);
          newDist.push(d);
        }
      }

      const newSet = new Set(newDist.map(distribution => distribution.row_index));
      const results: Array<Record<string, unknown>> = [];
      for (const dist of distributions) {
        if (!isBookableDistribution(dist)) {
          results.push(manualResult(dist));
          continue;
        }
        if (!newSet.has(dist.row_index)) continue;
        const netEur = dist.net_eur;
        const taxEur = dist.tax_eur;
        const feeEur = dist.fee_eur;
        const grossEur = dist.gross_eur;
        if (netEur === null || taxEur === null || feeEur === null || grossEur === null) continue;
        const postings: Array<{ accounts_id: number; accounts_dimensions_id?: number; type: "D" | "C"; amount: number }> = [];

        if (netEur > 0) {
          postings.push({ accounts_id: broker_account, ...(broker_dimension_id && { accounts_dimensions_id: broker_dimension_id }), type: "D", amount: netEur });
        }
        if (taxEur > 0 && tax_account) {
          postings.push({ accounts_id: tax_account, type: "D", amount: taxEur });
        }
        if (feeEur > 0) {
          postings.push({ accounts_id: fee_account, type: "D", amount: feeEur });
        }
        const isReward = dist.type === "Reward";
        postings.push({ accounts_id: isReward ? reward_account : income_account, type: "C", amount: grossEur });

        const title = dist.ticker
          ? `Lightyear tulu: ${dist.ticker} (${dist.isin})`
          : `Lightyear tulu: ${dist.type === "Reward" ? "boonus" : "intress"}`;

        if (isDryRun) {
          results.push({
            ...sourceFields(dist),
            status: "would_create",
          });
        } else {
          const outcome = await guard.createJournalOnce(
            { ns: "LY", id: dist.reference },
            { title, effective_date: dist.date, cl_currencies_id: "EUR", postings },
            { confirm: false }, // Lightyear journals stay in PROJECT for review
          );
          if (outcome.status === "duplicate") {
            // Existing journal for this key — skip the CREATED audit and report a duplicate.
            results.push({
              ...sourceFields(dist),
              status: "duplicate",
              journal_id: outcome.journal_id,
            });
          } else {
            logAudit({
              tool: "book_lightyear_distributions", action: "CREATED", entity_type: "journal",
              entity_id: outcome.journal_id,
              summary: `Lightyear distribution: ${dist.ticker || "interest"} gross ${grossEur} EUR`,
              details: {
                effective_date: dist.date,
                ...sourceFields(dist),
                postings: postings.map(posting => ({ ...posting })),
              },
            });

            results.push({
              ...sourceFields(dist),
              status: "created",
              journal_id: outcome.journal_id,
            });
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            ...baseResponse,
            new_entries: newDist.length,
            duplicates_skipped: duplicates.length,
            results,
          }),
        }],
      };
    }
  );

  registerTool(server, "lightyear_portfolio_summary",
    "Compute current holdings and cost basis from a Lightyear account statement. Useful for verifying investment account balance.",
    {
      file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file."),
    },
    { ...readOnly, openWorldHint: true, title: "Lightyear Portfolio Summary" },
    async ({ file_path }) => {
      const csv = await readCsvFile(file_path);
      const rows = parseAccountStatement(csv);
      const { trades, warnings: fxWarnings } = extractTrades(rows);

      const portfolioWarnings: string[] = [...fxWarnings];

      const skippedTrades: InvestmentTrade[] = [];
      const reviewedTrades: Array<{ trade: InvestmentTrade; reason: FxReviewReason; ordinal: number }> = [];
      const candidateTrades: Array<{ trade: InvestmentTrade; convertedTradeFee: number }> = [];
      for (let ordinal = 0; ordinal < trades.length; ordinal++) {
        const trade = trades[ordinal]!;
        if (trade.cash_equivalent) {
          skippedTrades.push(trade);
          continue;
        }
        const readiness = classifyTradeIntrinsicReadiness(trade);
        if (readiness.kind === "review_required") {
          reviewedTrades.push({ trade, reason: readiness.reason, ordinal });
          if (trade.fx_review_reason === null) {
            portfolioWarnings.push(fxReviewWarning(
              trade.reference,
              readiness.reason,
              trade.conversion_ref ?? undefined,
            ));
          }
          continue;
        }
        candidateTrades.push({ trade, convertedTradeFee: readiness.converted_trade_fee_eur });
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
      const acceptedReadyTrades: typeof candidateTrades = [];
      const tradeOrdinals = new Map(trades.map((trade, ordinal) => [trade, ordinal]));
      const holdingRemainingCostCents = new Map<string, number>();
      const holdingRealizedCents = new Map<string, number>();
      let portfolioRemainingCostCents = 0;
      let portfolioRealizedCents = 0;
      const replaceBoundedCents = (total: number, previous: number, next: number): number | null => {
        const withoutPrevious = total - previous;
        if (!Number.isSafeInteger(withoutPrevious)) return null;
        const replaced = withoutPrevious + next;
        return Number.isSafeInteger(replaced) && Math.abs(replaced) <= MAX_UNAMBIGUOUS_MONEY_CENTS
          ? replaced
          : null;
      };

      for (const { trade, convertedTradeFee } of candidateTrades) {
        const previous = holdings.get(trade.ticker);
        const proposed = previous ? { ...previous } : {
          ticker: trade.ticker,
          isin: trade.isin,
          quantity: 0,
          total_cost_eur: 0,
          total_proceeds_eur: 0,
          realized_gain_loss_eur: 0,
          buy_count: 0,
          sell_count: 0,
        };
        let soldCost: number | null = null;
        let averageCost: number | null = null;

        if (trade.type === "Buy") {
          // Investment cost = eur_amount (conversion net) + trade fee.
          // FX fee is expensed, not part of cost basis (matches Lightyear CG report).
          proposed.total_cost_eur += trade.eur_amount + convertedTradeFee;
          proposed.quantity += trade.quantity;
          proposed.buy_count++;
        } else {
          // Sell: remove proportional cost basis using weighted average cost
          const proceeds = trade.eur_amount - convertedTradeFee;
          proposed.total_proceeds_eur += proceeds;
          proposed.sell_count++;

          if (proposed.quantity > 0.000001) {
            averageCost = proposed.total_cost_eur / proposed.quantity;
            soldCost = averageCost * trade.quantity;
            proposed.realized_gain_loss_eur += proceeds - soldCost;
            proposed.total_cost_eur -= soldCost;
          }
          proposed.quantity -= trade.quantity;
        }

        if (averageCost === null && proposed.quantity > 0.000001) {
          averageCost = proposed.total_cost_eur / proposed.quantity;
        }
        const quantityUnits = quantityToSafeMicrounits(proposed.quantity);
        const remainingCostCents = moneyToSafeCents(proposed.total_cost_eur);
        const proceedsCents = moneyToSafeCents(proposed.total_proceeds_eur);
        const realizedCents = moneyToSafeCents(proposed.realized_gain_loss_eur);
        const soldCostCents = soldCost === null ? 0 : moneyToSafeCents(soldCost);
        const averageCostCents = averageCost === null ? 0 : moneyToSafeCents(averageCost);
        const previousRemainingCents = holdingRemainingCostCents.get(trade.ticker) ?? 0;
        const previousRealizedCents = holdingRealizedCents.get(trade.ticker) ?? 0;
        const previousActiveRemainingCents = previous && Math.abs(previous.quantity) >= 0.000001
          ? previousRemainingCents
          : 0;
        const proposedActiveRemainingCents = quantityUnits !== null && Math.abs(proposed.quantity) >= 0.000001
          ? remainingCostCents
          : 0;
        const nextPortfolioRemainingCents = remainingCostCents === null || proposedActiveRemainingCents === null
          ? null
          : replaceBoundedCents(portfolioRemainingCostCents, previousActiveRemainingCents, proposedActiveRemainingCents);
        const nextPortfolioRealizedCents = realizedCents === null
          ? null
          : replaceBoundedCents(portfolioRealizedCents, previousRealizedCents, realizedCents);

        if (
          quantityUnits === null || remainingCostCents === null || proceedsCents === null ||
          realizedCents === null || soldCostCents === null || averageCostCents === null ||
          nextPortfolioRemainingCents === null || nextPortfolioRealizedCents === null
        ) {
          const reason = fxReason("portfolio_arithmetic_overflow");
          reviewedTrades.push({ trade, reason, ordinal: tradeOrdinals.get(trade)! });
          portfolioWarnings.push(fxReviewWarning(trade.reference, reason));
          continue;
        }

        holdings.set(trade.ticker, proposed);
        holdingRemainingCostCents.set(trade.ticker, remainingCostCents);
        holdingRealizedCents.set(trade.ticker, realizedCents);
        portfolioRemainingCostCents = nextPortfolioRemainingCents;
        portfolioRealizedCents = nextPortfolioRealizedCents;
        acceptedReadyTrades.push({ trade, convertedTradeFee });
      }

      const positions = Array.from(holdings.values()).map(h => {
        const qtyHeld = quantityToSafeMicrounits(h.quantity)! / 1_000_000;
        const remainingCostCents = holdingRemainingCostCents.get(h.ticker)!;
        const realizedCents = holdingRealizedCents.get(h.ticker)!;
        return {
          ticker: renderPortfolioTicker(h.ticker),
          isin: renderPortfolioIsin(h.isin),
          quantity_held: qtyHeld,
          remaining_cost_eur: remainingCostCents / 100,
          avg_cost_per_unit: qtyHeld > 0.000001
            ? moneyToSafeCents(h.total_cost_eur / h.quantity)! / 100
            : null,
          total_proceeds_eur: moneyToSafeCents(h.total_proceeds_eur)! / 100,
          realized_gain_loss_eur: realizedCents / 100,
          buys: h.buy_count,
          sells: h.sell_count,
          fully_sold: Math.abs(h.quantity) < 0.000001,
        };
      });

      const previewed = positions.map(position => ({
        ...position,
        state: position.fully_sold ? "closed" as const : "active" as const,
      }));
      const legacyPositions = previewed.map(({ state: _state, ...position }) => position);
      const active = legacyPositions.filter((_position, index) => previewed[index]!.state === "active");
      const closed = legacyPositions.filter((_position, index) => previewed[index]!.state === "closed");
      reviewedTrades.sort((left, right) => left.ordinal - right.ordinal);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            booked_basis: acceptedReadyTrades.map(({ trade, convertedTradeFee }) =>
              bookedBasisTradeDto(trade, convertedTradeFee)),
            previewed,
            skipped: skippedTrades.map(skippedTradeDto),
            review_required: reviewedTrades.map(({ trade, reason }) =>
              reviewRequiredTradeDto(trade, reason)),
            active_holdings: active,
            closed_positions: closed,
            totals: {
              active_positions: active.length,
              total_remaining_cost_eur: portfolioRemainingCostCents / 100,
              total_realized_gain_loss_eur: portfolioRealizedCents / 100,
              closed_positions: closed.length,
            },
            ...(portfolioWarnings.length > 0 && { warnings: portfolioWarnings }),
            note: "This analytical WAC preview uses the intrinsic readiness classifier and default cash-equivalent policy. " +
              "It does not prove journals, gains, accounts, or duplicates are ready. " +
              "Run book_lightyear_trades as a dry run for authoritative booking readiness. " +
              "Cost basis is computed using weighted average cost; book_lightyear_trades and " +
              "parse_lightyear_capital_gains use FIFO for sell and tax reporting.",
          }),
        }],
      };
    }
  );
}
