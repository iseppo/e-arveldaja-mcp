import { basename, extname } from "path";
import { normalizeCompanyName as normalizeCompanyNameShared } from "../company-name.js";
import { roundMoney } from "../money.js";
import { extractIban, extractReferenceNumber, extractRegistryCode, extractVatNumber } from "../document-identifiers.js";
import { hasConfidentInvoiceNumber } from "../invoice-extraction-fallback.js";
import type { Account, PurchaseInvoiceItem, Transaction } from "../types/api.js";
import { normalizeVatRate } from "./purchase-vat-defaults.js";

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

export const WEEKDAY_PREFIX_SOURCE =
  String.raw`(?:(?:esmaspäev|teisipäev|kolmapäev|neljapäev|reede|laupäev|pühapäev|monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s*)?`;
export const TEXTUAL_MONTH_SOURCE = String.raw`[A-Za-zÀ-ž]{3,12}`;
export const DATE_VALUE_SOURCE =
  String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{1,2}\.?\s+` +
  TEXTUAL_MONTH_SOURCE +
  String.raw`\s+\d{4}|` +
  TEXTUAL_MONTH_SOURCE +
  String.raw`\s+\d{1,2},?\s+\d{4})`;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECEIPT_TOTAL_LABEL_RE = /(tasuda|maksta|kokku|\btotal\b|grand total|summa kokku|summa eurodes\s*\(km-ga\)|summa\s*\(km-ga\)|maksmisele kuulub|to pay|payable|amount due)/i;
const RECEIPT_VAT_LABEL_RE = /(käibemaks|km\b|vat\b|tax\b)/i;
const RECEIPT_NET_LABEL_RE = /(neto|subtotal|vahesumma|summa km-ta|summa eurodes\s*\(km-ta\)|summa\s*\(km-ta\)|käibemaksuta|without vat|total net)/i;
const RECEIPT_REFERENCE_LINE_RE =
  /\b(reg\.?\s*(?:nr|kood|code)|registrikood|registry code|kmkr|vat\s*(?:nr|number|no\.?)|tax\s*id|iban|viitenumber|viitenr|reference|ref\.?\s*(?:nr|number))\b/i;
const RECEIPT_COMPONENT_LABEL_RE = /(shipping|transport|delivery|postage|service fee|vahesumma|subtotal|handling)/i;
const SUPPLIER_LABEL_RE =
  /^(?:saatja nimi|müüja|seller|supplier|teenusepakkuja|arve esitaja|makse saaja|vedaja\/teenuse pakkuja)\b[:\s-]*/i;
const BUYER_SECTION_RE = /\b(bill to|invoice to|arve saaja|saaja|vastuvõtja|receiver|klient|client)\b/i;
const BUYER_OR_RECIPIENT_SECTION_RE = /\b(recipient|buyer|ostja|bill to|invoice to|arve saaja|saaja|vastuvõtja|receiver|klient|client)\b/i;
const PURE_BUYER_LABEL_RE = /^(?:recipient|buyer|ostja|bill to|invoice to|arve saaja|saaja|vastuvõtja|receiver|klient|client)[:\s]*$/i;
const SUPPLIER_METADATA_RE =
  /\b(?:telefon|phone|e-?post|email|kodulehekülg|website|web|iban|swift|reg\.?\s*(?:nr|code)|registrikood|kmkr|vat(?:\s*(?:nr|number|no\.?))?|tax id|payment method|makseviis|kuupäev|date|due date|maksetähtaeg)\b[:]?/i;
const SUPPLIER_INVALID_LINE_RE =
  /\b(arve|invoice|receipt|kviitung|tšekk|tsekk|summa|kokku|total|date|kuupäev|due|tasuda|maksta|toode|teenus|qty|kogus|hind|amount|subtotal|shipping|transport|käibemaks|vat|tax)\b/i;
// Currency detection runs over lines that already contain numeric amounts
// (see detectReceiptCurrency), so symbol-only patterns like `$`, `£`, and
// `€` are safe — they won't fire on prose. The dollar pattern requires
// digit adjacency (`$40` or `40 $`) and a negative lookbehind/lookahead so
// it doesn't swallow `CA$`, `AU$`, `S$`, etc. — those have their own
// patterns and must be tried first. Without these symbol patterns,
// Estonian USD invoices like "40,00 $" silently default to EUR (#16).
const RECEIPT_CURRENCY_PATTERNS = [
  // Non-USD dollar variants first — required so the bare-`$` USD pattern
  // below doesn't capture `CA$99` etc. and label them as USD.
  { code: "CAD", pattern: /\bCAD\b|(?<![A-Z])CA\$|(?<![A-Z])C\$/i },
  { code: "AUD", pattern: /\bAUD\b|(?<![A-Z])AU\$|(?<![A-Z])A\$/i },
  { code: "NZD", pattern: /\bNZD\b|(?<![A-Z])NZ\$/i },
  { code: "HKD", pattern: /\bHKD\b|(?<![A-Z])HK\$/i },
  { code: "SGD", pattern: /\bSGD\b|(?<![A-Z])S\$/i },
  // Bare `$` is USD only when not preceded/followed by a letter (so `US$`
  // is captured by the explicit `US\$` clause and not by the bare-`$`
  // tail) and only adjacent to a numeric.
  { code: "USD", pattern: /\bUSD\b|US\$|(?<![A-Z])\$\s*\d|\d\s*\$(?![A-Z])/i },
  { code: "EUR", pattern: /\bEUR\b|€/i },
  { code: "GBP", pattern: /\bGBP\b|£/i },
  { code: "JPY", pattern: /\bJPY\b|¥/i },
  { code: "SEK", pattern: /\bSEK\b/i },
  { code: "NOK", pattern: /\bNOK\b/i },
  { code: "DKK", pattern: /\bDKK\b/i },
  { code: "CHF", pattern: /\bCHF\b/i },
  { code: "PLN", pattern: /\bPLN\b/i },
] as const;

const NON_EUR_CURRENCY_CODES: ReadonlySet<string> = new Set(
  RECEIPT_CURRENCY_PATTERNS.map(c => c.code).filter(c => c !== "EUR"),
);
const PERSON_COUNTERPARTY_COMPANY_WORD_RE =
  /\b(limited|ltd|llc|inc|gmbh|ag|ab|oy|srl|bv|nv|sa|plc|tmi|ireland|operations|services|solutions|group|holding|capital|systems|technologies|media|digital|cloud|platform|company|corp|corporation)\b/i;
const TEXTUAL_MONTH_VALUE_RE =
  /\b(?:jaan(?:uar)?|jan(?:uary)?|veebr(?:uar)?|feb(?:ruary)?|märts|mar(?:ch)?|aprill|apr(?:il)?|mai|may|juuni|june?|juuli|july?|aug(?:ust)?|september|sept?|oktoober|okt|oct(?:ober)?|nov(?:ember)?|detsember|dets|dec(?:ember)?)\b/iu;
const SUPPLIER_COUNTRY_NAME_TO_CLIENT_COUNTRY: Array<[string, string]> = [
  ["united states", "USA"],
  ["estonia", "EST"],
  ["eesti", "EST"],
  ["finland", "FIN"],
  ["suomi", "FIN"],
  ["ireland", "IRL"],
  ["united kingdom", "GBR"],
  ["great britain", "GBR"],
  ["latvia", "LVA"],
  ["lithuania", "LTU"],
  ["sweden", "SWE"],
  ["norway", "NOR"],
  ["denmark", "DNK"],
  ["germany", "DEU"],
  ["france", "FRA"],
  ["netherlands", "NLD"],
  ["poland", "POL"],
];
const MONTH_NAME_TO_NUMBER: Record<string, number> = {
  jaan: 1,
  jaanuar: 1,
  jan: 1,
  january: 1,
  veebr: 2,
  veebruar: 2,
  feb: 2,
  february: 2,
  märts: 3,
  mar: 3,
  march: 3,
  aprill: 4,
  apr: 4,
  april: 4,
  mai: 5,
  may: 5,
  juuni: 6,
  jun: 6,
  june: 6,
  juuli: 7,
  jul: 7,
  july: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  oktoober: 10,
  okt: 10,
  sep: 9,
  oct: 10,
  october: 10,
  november: 11,
  nov: 11,
  dets: 12,
  detsember: 12,
  dec: 12,
  december: 12,
};
const IBAN_COUNTRY_TO_CLIENT_COUNTRY: Record<string, string> = {
  AT: "AUT",
  BE: "BEL",
  BG: "BGR",
  CH: "CHE",
  CY: "CYP",
  CZ: "CZE",
  DE: "DEU",
  DK: "DNK",
  EE: "EST",
  EL: "GRC", // VAT prefix for Greece (ISO is GR)
  ES: "ESP",
  FI: "FIN",
  FR: "FRA",
  GB: "GBR",
  GR: "GRC",
  HR: "HRV",
  HU: "HUN",
  IE: "IRL",
  IT: "ITA",
  LT: "LTU",
  LU: "LUX",
  LV: "LVA",
  MT: "MLT",
  NL: "NLD",
  NO: "NOR",
  PL: "POL",
  PT: "PRT",
  RO: "ROU",
  SE: "SWE",
  SI: "SVN",
  SK: "SVK",
  XI: "GBR", // Northern Ireland VAT prefix (post-Brexit)
};

const MAX_RECEIPT_FALLBACK_AMOUNT = 50_000;
const AUTO_BOOKED_NET_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type TransactionClassificationCategory =
  | "saas_subscriptions"
  | "bank_fees"
  | "tax_payments"
  | "salary_payroll"
  | "owner_transfers"
  | "card_purchases"
  | "revenue_without_invoice"
  | "unknown";

export type ReceiptClassification =
  | "purchase_invoice"
  | "payment_receipt"
  | "owner_paid_expense_reimbursement"
  | "unclassifiable";

export interface ExtractedReceiptFields {
  supplier_name?: string;
  supplier_reg_code?: string;
  supplier_vat_no?: string;
  supplier_iban?: string;
  ref_number?: string;
  invoice_number?: string;
  invoice_date?: string;
  due_date?: string;
  total_net?: number;
  total_vat?: number;
  total_gross?: number;
  /** True when total_vat is backed by an explicit OCR VAT / net label rather than a structural fallback. */
  vat_explicit?: boolean;
  currency?: string;
  description?: string;
  raw_text?: string;
}

export interface TransactionGroupClassificationInput {
  normalized_counterparty: string;
  display_counterparty?: string;
  transactions: Array<Pick<Transaction, "type" | "amount" | "description" | "date" | "bank_subtype">>;
  owner_counterparties?: Set<string>;
}

export interface TransactionGroupClassification {
  category: TransactionClassificationCategory;
  apply_mode: ClassificationApplyMode;
  recurring: boolean;
  similar_amounts: boolean;
  reasons: string[];
}

export interface BookingSuggestion {
  item: PurchaseInvoiceItem;
  source: "supplier_history" | "keyword_match" | "fallback" | "local_rules";
  matched_invoice_id?: number;
  matched_invoice_number?: string;
  suggested_liability_account_id?: number;
  suggested_account?: Account;
  suggested_purchase_article?: { id: number; name: string };
  /**
   * Why `item.reversed_vat_id` was set (or left unset). Surfaced so reviewers
   * can see whether the reverse-charge flag came from explicit text in the
   * document, a foreign-supplier heuristic, supplier history, or nothing
   * (issue #18). The field is populated by the caller after a booking
   * suggestion is produced; `suggestBookingInternal` itself does not set it.
   */
  reverse_charge_reason?: "phrase_match" | "foreign_supplier_default" | "supplier_history" | "none";
}

export interface InvoiceSummaryForMatching {
  id?: number;
  clients_id?: number;
  client_name?: string;
  number?: string;
  cl_currencies_id?: string;
  gross_price?: number;
  base_gross_price?: number;
  create_date?: string;
  bank_ref_number?: string | null;
  payment_status?: string;
  status?: string;
}

export type ClassificationApplyMode = "purchase_invoice" | "review_only";

interface ReceiptAmountCandidate {
  amount: number;
  blocked_as_reference: boolean;
  has_currency_keyword: boolean;
  has_total_like_label: boolean;
  likely_year_amount: boolean;
}

// ---------------------------------------------------------------------------
// Internal helper functions
// ---------------------------------------------------------------------------

function clampTextLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function normalizeForCompare(value?: string | null): string {
  return value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

function normalizeFilenameToken(name: string): string {
  return basename(name, extname(name))
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .toUpperCase();
}

function parseAmount(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d,.-]/g, "").trim();
  if (!cleaned) return undefined;

  let normalized = cleaned;
  const commaIndex = normalized.lastIndexOf(",");
  const dotIndex = normalized.lastIndexOf(".");

  if (commaIndex >= 0 && dotIndex >= 0) {
    normalized = commaIndex > dotIndex
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(/,/g, "");
  } else if (commaIndex >= 0) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if ((normalized.match(/\./g) ?? []).length > 1) {
    normalized = normalized.replace(/\./g, "");
  } else if (/^\d{1,3}\.\d{3}$/.test(normalized)) {
    // Single dot as thousands separator (e.g., "1.000" → "1000")
    normalized = normalized.replace(".", "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? roundMoney(parsed) : undefined;
}

function extractAmountsFromLine(line: string): number[] {
  const matches = [...line.matchAll(/\d[\d\s.,-]*\d|\d/g)];
  const amounts = matches
    .filter(match => {
      const raw = match[0] ?? "";
      const next = line.slice((match.index ?? 0) + raw.length).trimStart();
      return !next.startsWith("%");
    })
    .map(match => parseAmount(match[0] ?? ""))
    .filter((value): value is number => value !== undefined && value !== 0);

  return [...new Set(amounts)];
}

function isLikelyYearAmount(amount: number, line: string): boolean {
  if (!Number.isInteger(amount) || amount < 1900 || amount > 2100) {
    return false;
  }

  return /\b(?:date|kuupäev|issue\s*date|date\s*of\s*issue|date\s*paid|paid|makstud|sisseregistreerimine|väljaregistreerimine|check-?in|check-?out)\b/i.test(line) ||
    /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/.test(line) ||
    TEXTUAL_MONTH_VALUE_RE.test(line);
}

function roundToDecimals(value: number, decimals: number): number {
  if (value === 0 || !Number.isFinite(value)) return 0;
  const abs = Math.abs(value);
  const rounded = Number(Math.round(parseFloat(abs + "e" + decimals)) + "e-" + decimals);
  return (value < 0 ? -rounded : rounded) || 0;
}

function hasAllCapsWord(value: string): boolean {
  return value
    .split(/\s+/)
    .map(part => part.replace(/[^\p{L}]/gu, ""))
    .some(part => part.length >= 2 && part === part.toUpperCase() && part !== part.toLowerCase());
}

function getClientCountryFromVatNumber(vatNo?: string | null): string | undefined {
  const normalized = vatNo?.replace(/\s+/g, "").toUpperCase();
  const countryCode = normalized?.slice(0, 2);
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode) || countryCode === "EU") return undefined;
  return IBAN_COUNTRY_TO_CLIENT_COUNTRY[countryCode] ?? countryCode;
}

function getClientCountryFromText(text?: string): string | undefined {
  if (!text) return undefined;
  const rows = text
    .split(/\r?\n/)
    .map(raw => ({ raw, line: clampTextLine(raw) }))
    .filter(row => row.line);
  const buyerIndex = rows.findIndex(row => BUYER_OR_RECIPIENT_SECTION_RE.test(row.line));
  const supplierParts: string[] = [];

  const prefixRows = buyerIndex >= 0 ? rows.slice(0, buyerIndex) : rows.slice(0, 20);
  supplierParts.push(...prefixRows.map(row => row.line));

  if (buyerIndex >= 0) {
    for (const row of rows.slice(buyerIndex, buyerIndex + 10)) {
      const columns = row.raw
        .split(/\s{2,}/)
        .map(clampTextLine)
        .filter(Boolean);
      if (columns.length >= 2) {
        const leftColumn = columns[0]!;
        if (!PURE_BUYER_LABEL_RE.test(leftColumn)) {
          supplierParts.push(leftColumn);
        }
      }
    }
  }

  const supplierSide = supplierParts.join("\n").toLowerCase();

  for (const [countryName, countryCode] of SUPPLIER_COUNTRY_NAME_TO_CLIENT_COUNTRY) {
    if (supplierSide.includes(countryName)) {
      return countryCode;
    }
  }

  return undefined;
}

function scoreReceiptAmountFallbackCandidate(candidate: ReceiptAmountCandidate): number {
  return (candidate.has_total_like_label ? 4 : 0) +
    (candidate.has_currency_keyword ? 2 : 0) -
    (candidate.likely_year_amount ? 10 : 0);
}

function scoreExplicitGrossCandidate(line: string, hasCurrencyKeyword: boolean, hasTotalLikeLabel: boolean): number {
  const lineLower = line.toLowerCase();
  return (hasTotalLikeLabel ? 4 : 0) +
    (hasCurrencyKeyword ? 2 : 0) +
    (/\b(?:including|incl\.?|sisaldab)\b/i.test(line) ? 4 : 0) +
    (/\b(?:grand total|amount due|payable|km-ga|charged|makstud summa|paid amount)\b/i.test(lineLower) ? 4 : 0) +
    (RECEIPT_VAT_LABEL_RE.test(lineLower) ? 2 : 0);
}

function isVatAmountLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:käibemaks\b|vat\b|tax\b|km\b)/i.test(trimmed) ||
    /\b(?:sisaldab|including|incl\.?)\b.*(?:käibemaks|vat|tax|km\b)/i.test(trimmed);
}

function buildAmountInspectionLine(lines: string[], index: number): string {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return next ? `${current} ${next}` : current;
}

function dayDiff(dateA?: string, dateB?: string): number | undefined {
  if (!dateA || !dateB) return undefined;
  const tsA = Date.parse(`${dateA}T00:00:00Z`);
  const tsB = Date.parse(`${dateB}T00:00:00Z`);
  if (!Number.isFinite(tsA) || !Number.isFinite(tsB)) return undefined;
  return Math.round(Math.abs(tsA - tsB) / 86_400_000);
}

function normalizeYearToken(rawYear: string): number {
  if (rawYear.length === 4) return Number(rawYear);
  const shortYear = Number(rawYear);
  return shortYear >= 70 ? 1900 + shortYear : 2000 + shortYear;
}

function toIsoDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanSupplierCandidate(raw: string): string | undefined {
  let candidate = raw
    .replace(SUPPLIER_LABEL_RE, "")
    .replace(/\s+/g, " ")
    .trim();

  candidate = candidate.replace(new RegExp(`\\s+${BUYER_SECTION_RE.source}.*$`, "i"), "").trim();

  const metadataIndex = candidate.search(SUPPLIER_METADATA_RE);
  if (metadataIndex > 0) {
    candidate = candidate.slice(0, metadataIndex).trim();
  }

  candidate = candidate.split(/\s*;\s*/)[0]!.trim();
  candidate = candidate.replace(/^[^0-9A-Za-zÀ-ž]+|[^0-9A-Za-zÀ-ž).]+$/gu, "").trim();
  if (!candidate) return undefined;
  if (candidate.length < 2) return undefined;
  if (extractIban(candidate) || extractVatNumber(candidate) || extractRegistryCode(candidate) || extractReferenceNumber(candidate)) {
    return undefined;
  }
  if ((candidate.match(/\d/g) ?? []).length >= Math.max(6, Math.ceil(candidate.length / 2))) {
    return undefined;
  }
  if (/^(?:bill to|invoice to|arve saaja|saaja|vastuvõtja|receiver|klient|client)\b/i.test(candidate)) return undefined;
  if (/^(?:invoice|arve|receipt|müügiarve|order details|search|thank you)\b/i.test(candidate)) return undefined;
  if (SUPPLIER_INVALID_LINE_RE.test(candidate) && !/\b(OÜ|OU|AS|MTÜ|FIE|UAB|SIA|LLC|LTD|GMBH|OY|AB)\b/i.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function extractDescription(text: string, supplierName?: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(clampTextLine)
    .filter(Boolean)
    .filter(line => line.length >= 4 && line.length <= 120);

  const descriptive = lines.find(line =>
    !/(arve|invoice|receipt|kviitung|kokku|total|summa|vat|käibemaks|date|kuupäev)/i.test(line)
  );

  return descriptive ?? (supplierName ? `Expense from ${supplierName}` : "Receipt expense");
}

function parseVatRateDropdown(vatRateDropdown?: string): number | undefined {
  const normalized = normalizeVatRate(vatRateDropdown);
  if (!normalized || normalized === "-") return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCardPurchase(transaction: Pick<Transaction, "bank_subtype" | "description">): boolean {
  return /(card|kaart|pos|visa|mastercard|debit|credit)/i.test(transaction.bank_subtype ?? "") ||
    /(card|kaart|pos|terminal|visa|mastercard)/i.test(transaction.description ?? "");
}

function extractDateByLabels(text: string, labels: RegExp[]): string | undefined {
  for (const label of labels) {
    const match = text.match(label);
    const normalized = match?.[1] ? normalizeDate(match[1]) : undefined;
    if (normalized) return normalized;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function getClientCountryFromIban(iban?: string | null): string | undefined {
  const normalized = iban?.replace(/\s+/g, "").toUpperCase();
  const countryCode = normalized?.slice(0, 2);
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return undefined;
  return IBAN_COUNTRY_TO_CLIENT_COUNTRY[countryCode] ?? countryCode;
}

export function inferSupplierCountry(fields: Pick<ExtractedReceiptFields, "supplier_iban" | "supplier_vat_no" | "raw_text">): string | undefined {
  return getClientCountryFromIban(fields.supplier_iban) ??
    getClientCountryFromVatNumber(fields.supplier_vat_no) ??
    getClientCountryFromText(fields.raw_text);
}

// Phrases an invoice/receipt prints when VAT is shifted to the recipient
// (Estonian, English, German, French). The match is intentionally broad:
// false positives push reverse_charge_reason="phrase_match" onto a booking
// reviewer's screen, which they can override; false negatives silently
// miscode VAT — the worse failure mode (issue #18).
const REVERSE_CHARGE_PHRASES_RE =
  /\b(p[öo]ördmaksustamise|p[öo]ördmaksustamine|p[öo]ördk[äa]ibemaks|reverse[\s-]?charge(?:d)?(?:\s*vat)?|vat\s*(?:to\s*be\s*)?paid\s*by\s*(?:the\s*)?recipient|steuerschuldnerschaft\s*des\s*leistungsempf[äa]ngers|autoliquidation(?:\s*de\s*la\s*tva)?)\b/i;

/**
 * Detect explicit reverse-charge language in raw OCR text. Used by the
 * receipt-batch flow to set `reversed_vat_id=1` on booking suggestions
 * automatically (issue #18). Phrase coverage is the high-precision signal;
 * a foreign-supplier heuristic can be applied separately as a backstop.
 */
export function detectReverseChargeFromText(text: string | undefined): boolean {
  if (!text) return false;
  return REVERSE_CHARGE_PHRASES_RE.test(text);
}

/**
 * On a single line, return all currency codes whose pattern matches.
 * Pattern order matters for collision-prone variants (CA$/AU$/S$ before
 * bare USD) — RECEIPT_CURRENCY_PATTERNS is ordered accordingly.
 */
function detectCurrenciesOnLine(line: string): string[] {
  const found: string[] = [];
  for (const currency of RECEIPT_CURRENCY_PATTERNS) {
    if (currency.pattern.test(line) && !found.includes(currency.code)) {
      found.push(currency.code);
    }
  }
  return found;
}

/**
 * Detect the receipt's currency from amount-bearing lines. Returns
 * `undefined` when no currency token is found rather than silently
 * defaulting to EUR — see issue #16. Callers that need a downstream
 * default still handle it explicitly via `?? "EUR"`.
 *
 * When a single line carries both a non-EUR currency and EUR (e.g.
 * `Total: $40 / €37,12`), the non-EUR currency wins: invoices are
 * denominated in one currency and EUR is typically the buyer-side
 * reference / FX comparison.
 */
export function detectReceiptCurrency(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map(clampTextLine)
    .filter(Boolean);
  const prioritizedLines = [
    ...lines.filter(line => RECEIPT_TOTAL_LABEL_RE.test(line) || extractAmountsFromLine(line).length > 0),
    ...lines,
  ];

  for (const line of prioritizedLines) {
    const matches = detectCurrenciesOnLine(line);
    if (matches.length === 0) continue;
    const nonEur = matches.find(code => NON_EUR_CURRENCY_CODES.has(code));
    return nonEur ?? matches[0];
  }

  return undefined;
}

export function normalizeDate(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .replace(/^(?:esmaspäev|teisipäev|kolmapäev|neljapäev|reede|laupäev|pühapäev|monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s*/i, "");

  if (ISO_DATE_RE.test(trimmed)) {
    return trimmed;
  }

  const dotted = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (dotted) {
    const [, day, month, year] = dotted;
    return toIsoDate(normalizeYearToken(year!), Number(month), Number(day));
  }

  const slashed = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slashed) {
    const [, day, month, year] = slashed;
    return toIsoDate(normalizeYearToken(year!), Number(month), Number(day));
  }

  const dayFirstTextual = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (dayFirstTextual) {
    const [, day, monthName, year] = dayFirstTextual;
    const month = MONTH_NAME_TO_NUMBER[monthName!.toLowerCase()];
    if (month) {
      return toIsoDate(Number(year), month, Number(day));
    }
  }

  const dayFirstTextualWithDot = trimmed.match(/^(\d{1,2})\.\s*([A-Za-zÀ-ž]{3,12})\s+(\d{4})$/u);
  if (dayFirstTextualWithDot) {
    const [, day, monthName, year] = dayFirstTextualWithDot;
    const month = MONTH_NAME_TO_NUMBER[monthName!.toLowerCase()];
    if (month) {
      return toIsoDate(Number(year), month, Number(day));
    }
  }

  const monthFirstTextual = trimmed.match(/^([A-Za-zÀ-ž]{3,12})\s+(\d{1,2}),?\s*(\d{4})$/u);
  if (monthFirstTextual) {
    const [, monthName, day, year] = monthFirstTextual;
    const month = MONTH_NAME_TO_NUMBER[monthName!.toLowerCase()];
    if (month) {
      return toIsoDate(Number(year), month, Number(day));
    }
  }

  return undefined;
}

export function extractAmounts(text: string): { total_net?: number; total_vat?: number; total_gross?: number; vat_explicit?: boolean } {
  const lines = text
    .split(/\r?\n/)
    .map(clampTextLine)
    .filter(Boolean);

  let totalGross: number | undefined;
  let totalVat: number | undefined;
  let totalNet: number | undefined;
  let vatFromExplicitLine = false;
  let netFromExplicitLine = false;
  const fallbackCandidates: ReceiptAmountCandidate[] = [];
  const componentAmounts: number[] = [];
  let bestExplicitGrossCandidate: { amount: number; score: number } | undefined;
  const hasExplicitVatLine = lines.some((_line, index) =>
    isVatAmountLine(buildAmountInspectionLine(lines, index)) &&
    !RECEIPT_REFERENCE_LINE_RE.test(buildAmountInspectionLine(lines, index)) &&
    !RECEIPT_NET_LABEL_RE.test(buildAmountInspectionLine(lines, index)),
  );

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const amounts = extractAmountsFromLine(line);
    if (amounts.length === 0) continue;

    const inspectionLine = buildAmountInspectionLine(lines, index);
    const inspectionLower = inspectionLine.toLowerCase();
    const lineLower = line.toLowerCase();
    const blockedAsReference = RECEIPT_REFERENCE_LINE_RE.test(lineLower);
    const hasCurrencyKeyword = RECEIPT_CURRENCY_PATTERNS.some(currency => currency.pattern.test(line));
    const hasTotalLikeLabel = RECEIPT_TOTAL_LABEL_RE.test(lineLower);
    const hasNetLikeLabel = RECEIPT_NET_LABEL_RE.test(lineLower);
    const hasVatAmountLabel = isVatAmountLine(inspectionLine);
    const deDatedAmounts = amounts.filter(amount => !isLikelyYearAmount(amount, line));
    const filteredAmounts = (deDatedAmounts.length > 0 ? deDatedAmounts : amounts).filter(amount =>
      !(Number.isInteger(amount) && amount >= 1000 && !hasCurrencyKeyword && !hasTotalLikeLabel),
    );
    if (filteredAmounts.length === 0) {
      continue;
    }

    const pickedGross = filteredAmounts.length > 1 && (RECEIPT_VAT_LABEL_RE.test(inspectionLower) || /\b(?:sisaldab|including|incl\.?)\b/i.test(inspectionLine))
      ? Math.max(...filteredAmounts)
      : filteredAmounts[filteredAmounts.length - 1];
    const vatCandidates = filteredAmounts.filter(amount => ![...inspectionLine.matchAll(/(\d{1,2}(?:[.,]\d+)?)\s*%/g)]
      .map(match => parseAmount(match[1] ?? ""))
      .some(rate => rate !== undefined && Math.abs(rate - amount) < 0.001));
    // Guard against a narrow VAT misread: when the %-rate filter above discards every candidate
    // except one, and that survivor equals the largest amount on the line, the "VAT" is almost
    // certainly the gross total (e.g. "Kokku 100 EUR KM 20%" → 20 excluded as rate, leaving 100).
    // Keep lastVatCandidate in that case so totalVat falls through to the later gross − net
    // reconciliation. Lines without a %-rate exclusion (e.g. "Tax 1 €3.96 €3.96") are unaffected.
    const lastVatCandidate = vatCandidates[vatCandidates.length - 1];
    const filteredByPercentRate = vatCandidates.length < filteredAmounts.length;
    const pickedVat = lastVatCandidate !== undefined &&
      (!filteredByPercentRate || filteredAmounts.length <= 1 || lastVatCandidate < Math.max(...filteredAmounts))
      ? lastVatCandidate
      : undefined;

    fallbackCandidates.push(...filteredAmounts.map(amount => ({
      amount,
      blocked_as_reference: blockedAsReference,
      has_currency_keyword: hasCurrencyKeyword,
      has_total_like_label: hasTotalLikeLabel,
      likely_year_amount: isLikelyYearAmount(amount, line),
    })));

    if (
      !blockedAsReference &&
      hasTotalLikeLabel
    ) {
      const score = scoreExplicitGrossCandidate(inspectionLine, hasCurrencyKeyword, hasTotalLikeLabel);
      if (!bestExplicitGrossCandidate || score > bestExplicitGrossCandidate.score || (score === bestExplicitGrossCandidate.score && pickedGross > bestExplicitGrossCandidate.amount)) {
        bestExplicitGrossCandidate = { amount: pickedGross, score };
      }
    }

    if (
      totalVat === undefined &&
      pickedVat !== undefined &&
      !blockedAsReference &&
      hasVatAmountLabel &&
      !hasNetLikeLabel
    ) {
      totalVat = pickedVat;
      vatFromExplicitLine = true;
    }

    if (
      totalNet === undefined &&
      !blockedAsReference &&
      hasNetLikeLabel
    ) {
      totalNet = Math.max(...filteredAmounts);
      netFromExplicitLine = true;
    }

    if (
      !blockedAsReference &&
      !hasTotalLikeLabel &&
      RECEIPT_COMPONENT_LABEL_RE.test(lineLower)
    ) {
      componentAmounts.push(pickedGross);
    }
  }

  if (bestExplicitGrossCandidate) {
    totalGross = bestExplicitGrossCandidate.amount;
  }

  if (totalGross === undefined) {
    totalGross = [...fallbackCandidates]
      .filter(candidate =>
        candidate.amount <= MAX_RECEIPT_FALLBACK_AMOUNT &&
        !candidate.blocked_as_reference,
      )
      .sort((a, b) =>
        scoreReceiptAmountFallbackCandidate(b) - scoreReceiptAmountFallbackCandidate(a) ||
        b.amount - a.amount,
      )[0]?.amount;
  }

  if (totalGross !== undefined && totalVat !== undefined) {
    const derivedNet = roundMoney(totalGross - totalVat);
    if (
      totalNet === undefined ||
      Math.abs(roundMoney(totalNet + totalVat) - totalGross) > 0.02
    ) {
      totalNet = derivedNet;
    }
  }

  if (totalVat === undefined && totalGross !== undefined && totalNet !== undefined) {
    totalVat = roundMoney(totalGross - totalNet);
  }

  if (totalGross !== undefined && componentAmounts.length > 0) {
    const componentSum = roundMoney(componentAmounts.reduce((sum, amount) => sum + amount, 0));
    if (Math.abs(componentSum - totalGross) < 0.02 && !hasExplicitVatLine) {
      totalNet = totalGross;
      totalVat = 0;
      // Inferred "no VAT" from component-sum reconciliation; this is structural,
      // not an explicit OCR statement that VAT is 0.
      vatFromExplicitLine = false;
      netFromExplicitLine = false;
    }
  }

  return {
    total_net: totalNet,
    total_vat: totalVat,
    total_gross: totalGross,
    vat_explicit: totalVat !== undefined && (vatFromExplicitLine || netFromExplicitLine),
  };
}

export interface ExtractReceiptFieldsOptions {
  /**
   * VAT number of the active company. Used to keep an invoice's buyer-side VAT
   * (= our own VAT) from being resolved as the supplier when the supplier's
   * VAT is missing from the document — see issue #14.
   */
  ownCompanyVat?: string;
}

export function extractPdfIdentifiers(
  text: string,
  options?: ExtractReceiptFieldsOptions,
): Pick<ExtractedReceiptFields, "supplier_reg_code" | "supplier_vat_no" | "supplier_iban" | "ref_number"> {
  return {
    supplier_reg_code: extractRegistryCode(text),
    supplier_vat_no: extractVatNumber(
      text,
      options?.ownCompanyVat ? { exclude: options.ownCompanyVat } : undefined,
    ),
    supplier_iban: extractIban(text),
    ref_number: extractReferenceNumber(text),
  };
}

export function extractSupplierName(text: string, fallbackFileName: string): string | undefined {
  const rows = text
    .split(/\r?\n/)
    .map(raw => ({ raw, line: clampTextLine(raw) }))
    .filter(row => row.line);
  const lines = rows.map(row => row.line);

  const extractRightmostColumnCandidate = (rawLine: string): string | undefined => {
    const segments = rawLine
      .split(/\s{2,}/)
      .map(clampTextLine)
      .filter(Boolean);
    if (segments.length < 2) return undefined;
    for (let index = segments.length - 1; index >= 1; index--) {
      const candidate = cleanSupplierCandidate(segments[index] ?? "");
      if (candidate) return candidate;
    }
    return undefined;
  };

  for (let index = 0; index < rows.length; index++) {
    const line = rows[index]!.line;
    const previousLine = rows[index - 1]?.line ?? "";

    if (PURE_BUYER_LABEL_RE.test(previousLine)) {
      const rightmostColumnCandidate = extractRightmostColumnCandidate(rows[index]!.raw);
      if (rightmostColumnCandidate) return rightmostColumnCandidate;
    }

    const dualNameMatch = line.match(/^Nimi:\s*(.+?)\s+Nimi:\s*(.+)$/i);
    const sellerFromDualName = cleanSupplierCandidate(dualNameMatch?.[2] ?? "");
    if (sellerFromDualName) return sellerFromDualName;

    if (SUPPLIER_LABEL_RE.test(line)) {
      const labelledCandidate = cleanSupplierCandidate(line);
      if (labelledCandidate) return labelledCandidate;

      const nextLineCandidate = cleanSupplierCandidate(lines[index + 1] ?? "");
      if (nextLineCandidate) return nextLineCandidate;
    }
  }

  for (const line of lines) {
    const buyerMatch = line.match(/^(.*?)\b(?:bill to|invoice to)\b/i);
    const beforeBuyer = cleanSupplierCandidate(buyerMatch?.[1] ?? "");
    if (beforeBuyer) return beforeBuyer;
  }

  const companyPattern = /\b(OÜ|OU|AS|MTÜ|FIE|UAB|SIA|LLC|LTD|GMBH|OY|AB|INC|LIMITED|TMI)\b/i;
  const buyerSectionIndex = lines.findIndex(line => BUYER_OR_RECIPIENT_SECTION_RE.test(line));
  const searchLines = lines.slice(0, buyerSectionIndex >= 0 ? Math.max(buyerSectionIndex + 1, 1) : Math.min(lines.length, 12));
  for (const line of searchLines) {
    const candidate = cleanSupplierCandidate(line);
    if (
      candidate &&
      candidate.length <= 80 &&
      (companyPattern.test(candidate) || /^[A-ZÄÖÜÕ0-9][A-ZÄÖÜÕ0-9 '&().,-]{4,}$/.test(candidate))
    ) {
      return candidate;
    }
  }

  for (const line of lines) {
    const candidate = cleanSupplierCandidate(line);
    if (candidate && companyPattern.test(candidate)) {
      return candidate;
    }
  }

  const fileToken = normalizeFilenameToken(fallbackFileName).replace(/-/g, " ");
  if (!fileToken || /^(?:INVOICE|RECEIPT|DOCUMENT|PDF|IMAGE|SCAN)$/i.test(fileToken)) {
    return undefined;
  }
  return fileToken;
}

export function extractInvoiceNumber(text: string, fileName: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(clampTextLine)
    .filter(Boolean);
  const invoiceNumberPatterns = [
    /(?:arve(?:\/tehingu)?(?:-saateleht)?\s*(?:nr|number|no\.?)|invoice\s*(?:nr|number|no\.?)|dokumendi\s*nr|receipt\s*(?:nr|number|no\.?)|tellimuse\s*number|order\s*number|booking\s*(?:number|no\.?)|pileti\s*nr)[:#\s.-]*([A-Z0-9/_-]{3,})/i,
    /\b(?:invoice|arve(?:-saateleht)?|receipt)\s+(?!date\b|number\b|nr\b|no\.?\b)([A-Z0-9][A-Z0-9/_-]*\d[A-Z0-9/_-]*)\b/i,
  ];

  for (const pattern of invoiceNumberPatterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }

  for (const line of lines) {
    if (/\b(?:reg\.?\s*(?:nr|kood|code)|registrikood|registry code|kmkr|vat(?:\s*(?:nr|number|no\.?))?|tax id)\b/i.test(line)) {
      continue;
    }
    const match = line.match(/(?:number|nr|no\.?)[:#\s-]*([A-Z0-9/_-]{3,})/i);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }

  const todayToken = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `AUTO-${todayToken}-${normalizeFilenameToken(fileName) || "RECEIPT"}`;
}

export function extractDates(text: string): { invoice_date?: string; due_date?: string } {
  const invoiceDate = extractDateByLabels(text, [
    new RegExp(`(?:invoice\\s*date|arve\\s*kuupäev|arve\\s*kpv|kuupäev|date|issue\\s*date|date\\s*of\\s*issue|tellimuse\\s*kuupäev|date\\s*paid)[:\\s-]*(${WEEKDAY_PREFIX_SOURCE}${DATE_VALUE_SOURCE})`, "iu"),
    new RegExp(`(?:receipt\\s*date|purchase\\s*date)[:\\s-]*(${WEEKDAY_PREFIX_SOURCE}${DATE_VALUE_SOURCE})`, "iu"),
  ]);

  const dueDate = extractDateByLabels(text, [
    new RegExp(`(?:due\\s*date|date\\s*due|maksetähtaeg|tähtaeg)[:\\s-]*(${WEEKDAY_PREFIX_SOURCE}${DATE_VALUE_SOURCE})`, "iu"),
  ]);

  if (invoiceDate || dueDate) {
    return { invoice_date: invoiceDate, due_date: dueDate };
  }

  const rawDates = [...text.matchAll(new RegExp(`\\b(${WEEKDAY_PREFIX_SOURCE}${DATE_VALUE_SOURCE})\\b`, "giu"))]
    .map(match => normalizeDate(match[1] ?? ""))
    .filter((value): value is string => value !== undefined);

  return {
    invoice_date: rawDates[0],
    due_date: rawDates[1],
  };
}

export function normalizeCounterpartyName(name?: string | null): string {
  return normalizeCompanyNameShared(name, { stripNonAlphanumeric: true });
}

export function hasRecurringSimilarAmounts(amounts: number[]): boolean {
  if (amounts.length < 2) return false;
  const sorted = [...amounts].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const avg = sorted.reduce((sum, amount) => sum + amount, 0) / sorted.length;
  return roundMoney(max - min) <= Math.max(2, roundMoney(avg * 0.05));
}

export function looksLikePersonCounterparty(normalizedCounterparty: string, rawCounterparty?: string): boolean {
  if (!normalizedCounterparty) {
    return false;
  }
  if (PERSON_COUNTERPARTY_COMPANY_WORD_RE.test(normalizedCounterparty)) {
    return false;
  }
  if (rawCounterparty && hasAllCapsWord(rawCounterparty)) {
    return false;
  }
  const parts = normalizedCounterparty.split(" ").filter(Boolean);
  return parts.length >= 2 && parts.length <= 4;
}

export function getAutoBookedVatConfig(
  category: TransactionClassificationCategory,
  supplierCountry?: string | null,
): Pick<PurchaseInvoiceItem, "vat_rate_dropdown" | "reversed_vat_id"> {
  if (category === "bank_fees") {
    return { vat_rate_dropdown: "-" };
  }
  void supplierCountry;
  return { vat_rate_dropdown: "-" };
}

export function getAutoBookedVatRateDropdown(
  category: TransactionClassificationCategory,
  supplierCountry?: string | null,
): string {
  return getAutoBookedVatConfig(category, supplierCountry).vat_rate_dropdown ?? "-";
}

export function getBookingSuggestionVatConfig(
  bookingSuggestion?: Pick<BookingSuggestion, "item"> | null,
): Pick<PurchaseInvoiceItem, "vat_rate_dropdown" | "reversed_vat_id"> | undefined {
  if (!bookingSuggestion) {
    return undefined;
  }

  const vatRateDropdown = bookingSuggestion.item.vat_rate_dropdown;
  const reversedVatId = bookingSuggestion.item.reversed_vat_id;

  if (vatRateDropdown === undefined && reversedVatId === undefined) {
    return undefined;
  }

  return {
    ...(vatRateDropdown !== undefined ? { vat_rate_dropdown: vatRateDropdown } : {}),
    ...(reversedVatId !== undefined && reversedVatId !== null ? { reversed_vat_id: reversedVatId } : {}),
  };
}

export function deriveAutoBookedNetAmount(
  grossAmount: number,
  vatConfig: Pick<PurchaseInvoiceItem, "vat_rate_dropdown" | "reversed_vat_id">,
): number {
  const rate = parseVatRateDropdown(vatConfig.vat_rate_dropdown);
  if (!rate || vatConfig.reversed_vat_id) {
    return roundMoney(grossAmount);
  }
  return roundToDecimals(grossAmount / (1 + rate / 100), AUTO_BOOKED_NET_DECIMALS);
}

export function deriveAutoBookedVatPrice(
  grossAmount: number,
  vatConfig: Pick<PurchaseInvoiceItem, "vat_rate_dropdown" | "reversed_vat_id">,
): number {
  if (vatConfig.reversed_vat_id) {
    return 0;
  }
  const rate = parseVatRateDropdown(vatConfig.vat_rate_dropdown);
  if (!rate) {
    return 0;
  }
  return roundMoney(grossAmount - deriveAutoBookedNetAmount(grossAmount, vatConfig));
}

export function categorizeTransactionGroup(input: TransactionGroupClassificationInput): TransactionGroupClassification {
  const counterparty = input.normalized_counterparty;
  const displayCounterparty = input.display_counterparty;
  const sample = input.transactions[0];
  const amounts = input.transactions.map(transaction => Math.abs(transaction.amount));
  const recurring = input.transactions.length >= 2;
  const similarAmounts = hasRecurringSimilarAmounts(amounts);
  const reasons: string[] = [];

  if (!sample) {
    return {
      category: "unknown",
      apply_mode: "review_only",
      recurring: false,
      similar_amounts: false,
      reasons: ["no_transactions"],
    };
  }

  const feeText = input.transactions
    .map(transaction => `${transaction.description ?? ""} ${transaction.bank_subtype ?? ""}`.toLowerCase())
    .join(" ");
  if (
    sample.type !== "D" &&
    /(lhv|swedbank|seb|luminor|coop)/i.test(counterparty) &&
    (/(fee|teenustasu|service charge|commission|monthly fee|haldustasu)/i.test(feeText) ||
      Math.max(...amounts) <= 20)
  ) {
    reasons.push("bank_counterparty_with_fee_pattern");
    return {
      category: "bank_fees",
      apply_mode: "purchase_invoice",
      recurring,
      similar_amounts: similarAmounts,
      reasons,
    };
  }

  if (/(emta|maksu ja tolliamet)/i.test(counterparty)) {
    reasons.push("matched_estonian_tax_authority");
    return {
      category: "tax_payments",
      apply_mode: "review_only",
      recurring,
      similar_amounts: similarAmounts,
      reasons,
    };
  }

  if (input.owner_counterparties?.has(counterparty)) {
    reasons.push("matched_known_owner_counterparty");
    return {
      category: "owner_transfers",
      apply_mode: "review_only",
      recurring,
      similar_amounts: similarAmounts,
      reasons,
    };
  }

  if (sample.type === "D") {
    reasons.push("incoming_without_sale_invoice");
    return {
      category: "revenue_without_invoice",
      apply_mode: "review_only",
      recurring,
      similar_amounts: similarAmounts,
      reasons,
    };
  }

  if (recurring && similarAmounts && looksLikePersonCounterparty(counterparty, displayCounterparty)) {
    reasons.push("recurring_person_counterparty");
    return {
      category: "salary_payroll",
      apply_mode: "review_only",
      recurring,
      similar_amounts: similarAmounts,
      reasons,
    };
  }

  if (recurring && similarAmounts) {
    reasons.push("recurring_similar_amounts");
    return {
      category: "saas_subscriptions",
      apply_mode: "purchase_invoice",
      recurring,
      similar_amounts: similarAmounts,
      reasons,
    };
  }

  if (
    /(bolt|uber|wolt)/i.test(counterparty) ||
    input.transactions.some(transaction => isCardPurchase(transaction))
  ) {
    reasons.push("card_purchase_pattern");
    return {
      category: "card_purchases",
      apply_mode: "purchase_invoice",
      recurring,
      similar_amounts: similarAmounts,
      reasons,
    };
  }

  reasons.push("no_known_pattern");
  return {
    category: "unknown",
    apply_mode: "review_only",
    recurring,
    similar_amounts: similarAmounts,
    reasons,
  };
}

export function classifyReceiptDocument(text: string, fileName: string): ReceiptClassification {
  const combined = `${text}\n${fileName}`;
  const hasSalesInvoiceKeywords = /\b(müügiarve|sale invoice)\b/i.test(combined);
  const hasInvoiceKeywords = /\b(arve|invoice|ostuarve|bill to)\b/i.test(combined);
  const hasReceiptKeywords = /\b(receipt|kviitung|tšekk|tsekk|card slip|terminal)\b/i.test(combined);
  const hasExpenseKeywords = /\b(bolt|wolt|uber|forus|taxi|parking|fuel|restaurant|cafe)\b/i.test(combined);
  const hasTravelTicketKeywords = /\b(pileti nr|ticket no|reisija nimi|reisi kokkuvõte|lux express)\b/i.test(combined);
  const hasOrderReceiptKeywords = /\b(order details|your order has been received|payment method)\b/i.test(combined);
  const hasNonInvoiceConfirmationKeywords =
    /\b(see ei ole arve|this is not an invoice|tehingu kinnitus|order summary|sinu tellimuse kokkuvõte)\b/i.test(combined);
  const hasCardTerminalReceiptKeywords = /\b(kaarditerminal|card terminal|maksemeetod|makseviis)\b/i.test(combined);

  if (hasSalesInvoiceKeywords) {
    return "unclassifiable";
  }

  if (hasNonInvoiceConfirmationKeywords) {
    return "owner_paid_expense_reimbursement";
  }

  if (hasExpenseKeywords && hasCardTerminalReceiptKeywords) {
    return "owner_paid_expense_reimbursement";
  }

  // Payment receipts: a "Receipt" header / `Receipt-*` filename combined
  // with both payment-confirmation language ("Date paid", "Amount paid",
  // "Receipt number", "Payment history") AND a referenced invoice number.
  // These are confirmations of payment for an invoice that already exists
  // (or appears separately in the same batch). Booking them as their own
  // purchase_invoice creates a duplicate of the underlying invoice.
  // See issue #15.
  if (looksLikePaymentReceiptForInvoice(text, fileName) && !hasSalesInvoiceKeywords) {
    return "payment_receipt";
  }

  if (hasInvoiceKeywords) {
    return "purchase_invoice";
  }

  if (hasReceiptKeywords || hasExpenseKeywords || hasTravelTicketKeywords || hasOrderReceiptKeywords) {
    return "owner_paid_expense_reimbursement";
  }

  return "unclassifiable";
}

const PAYMENT_RECEIPT_INDICATORS_RE =
  /\b(date\s*paid|amount\s*paid|receipt\s*number|payment\s*history|paid\s*on|makstud\s*kuupäev|tasumiskuupäev|maksekuupäev)\b/i;
// Stripe and similar gateways localise both the filename and the document
// header — accept the common Estonian / German / French equivalents in
// addition to the English "Receipt".
const PAYMENT_RECEIPT_FILENAME_RE = /^(?:receipt|kviitung|quittung|reçu|recu)[-_]/i;
const PAYMENT_RECEIPT_INVOICE_REFERENCE_RE =
  /\b(invoice\s*(?:number|nr|no\.?)|arve\s*(?:number|nr|no\.?)|bill\s*number|ostuarve\s*(?:number|nr))\b/i;
const PAYMENT_RECEIPT_HEADER_RE = /^[\s]*(?:receipt|kviitung|quittung|reçu|recu)\s*$/im;

/**
 * True when a document is a payment confirmation for an underlying invoice.
 * Strong signals: Receipt-prefixed filename OR explicit "Receipt" header,
 * combined with payment-confirmation language AND a reference back to an
 * invoice number. Mere appearance of the word "Receipt" anywhere in body
 * text is not enough — many invoices say "this serves as a receipt of …".
 */
export function looksLikePaymentReceiptForInvoice(text: string, fileName: string): boolean {
  const hasIndicators = PAYMENT_RECEIPT_INDICATORS_RE.test(text);
  const hasInvoiceReference = PAYMENT_RECEIPT_INVOICE_REFERENCE_RE.test(text);
  if (!hasIndicators || !hasInvoiceReference) return false;
  // Require a structural signal — header or filename — so we don't catch
  // invoices that happen to summarise prior payment history.
  return PAYMENT_RECEIPT_FILENAME_RE.test(fileName) || PAYMENT_RECEIPT_HEADER_RE.test(text);
}

export function hasAutoBookableReceiptFields(
  extracted: Pick<ExtractedReceiptFields, "supplier_name" | "invoice_number" | "invoice_date" | "total_gross">,
): boolean {
  return Boolean(
    extracted.supplier_name &&
    extracted.invoice_date &&
    extracted.total_gross !== undefined &&
    hasConfidentInvoiceNumber(extracted.invoice_number),
  );
}

export function extractReceiptFieldsFromText(
  text: string,
  fileName: string,
  options?: ExtractReceiptFieldsOptions,
): ExtractedReceiptFields {
  const identifiers = extractPdfIdentifiers(text, options);
  const { invoice_date, due_date } = extractDates(text);
  const supplierName = extractSupplierName(text, fileName);
  const amounts = extractAmounts(text);
  const currency = detectReceiptCurrency(text);

  return {
    ...identifiers,
    ...amounts,
    currency,
    supplier_name: supplierName,
    invoice_number: extractInvoiceNumber(text, fileName),
    invoice_date,
    due_date,
    description: extractDescription(text, supplierName),
    raw_text: text,
  };
}

export function scoreTransactionToInvoice(tx: Transaction, invoice: InvoiceSummaryForMatching): { confidence: number; reasons: string[] } {
  let confidence = 0;
  const reasons: string[] = [];
  const invoiceAmount = invoice.gross_price ?? 0;
  const txAmount = tx.amount;
  const txBaseAmount = tx.base_amount;
  const invoiceBaseAmount = invoice.base_gross_price;
  const invoiceCurrency = invoice.cl_currencies_id?.trim().toUpperCase();
  const txCurrency = tx.cl_currencies_id?.trim().toUpperCase();
  const canCompareNominalAmounts = !invoiceCurrency || !txCurrency || invoiceCurrency === txCurrency;

  if (canCompareNominalAmounts && Math.abs(txAmount - invoiceAmount) < 0.01) {
    confidence += 50;
    reasons.push("exact_amount");
  } else if (txBaseAmount !== undefined && invoiceBaseAmount !== undefined && Math.abs(txBaseAmount - invoiceBaseAmount) < 0.01) {
    confidence += 50;
    reasons.push("exact_base_amount");
  } else if (canCompareNominalAmounts && Math.abs(txAmount - invoiceAmount) <= 1) {
    confidence += 20;
    reasons.push("close_amount");
  }

  const txRef = normalizeForCompare(tx.ref_number ?? tx.bank_ref_number);
  const invoiceRef = normalizeForCompare(invoice.bank_ref_number);
  if (txRef && invoiceRef && txRef === invoiceRef) {
    confidence += 20;
    reasons.push("reference_number");
  }

  if (tx.clients_id && invoice.clients_id && tx.clients_id === invoice.clients_id) {
    confidence += 15;
    reasons.push("client_id");
  } else {
    const txName = normalizeForCompare(tx.bank_account_name);
    const invoiceName = normalizeForCompare(invoice.client_name);
    if (txName && invoiceName && (txName.includes(invoiceName) || invoiceName.includes(txName))) {
      confidence += 10;
      reasons.push("counterparty_name");
    }
  }

  const dateDistance = dayDiff(tx.date, invoice.create_date);
  if (dateDistance !== undefined) {
    if (dateDistance <= 3) {
      confidence += 20;
      reasons.push("date_within_3_days");
    } else if (dateDistance <= 10) {
      confidence += 10;
      reasons.push("date_within_10_days");
    }
  }

  return { confidence: Math.min(confidence, 100), reasons };
}

export function suggestBookingInternal(
  api: { purchaseInvoices: { get(id: number): Promise<{ id?: number; number?: string; liability_accounts_id?: number; items?: PurchaseInvoiceItem[] }> } },
  context: {
    purchaseInvoices: Array<{ id?: number; clients_id?: number; status?: string; create_date?: string }>;
    purchaseArticlesWithVat: Array<{ id: number; name_est: string; name_eng: string; accounts_id?: number; is_disabled?: boolean; priority?: number }>;
    accounts: Account[];
  },
  clientId: number,
  description: string,
): Promise<BookingSuggestion | undefined> {
  return suggestBookingInternalImpl(api, context, clientId, description);
}

async function suggestBookingInternalImpl(
  api: { purchaseInvoices: { get(id: number): Promise<{ id?: number; number?: string; liability_accounts_id?: number; items?: PurchaseInvoiceItem[] }> } },
  context: {
    purchaseInvoices: Array<{ id?: number; clients_id?: number; status?: string; create_date?: string }>;
    purchaseArticlesWithVat: Array<{ id: number; name_est: string; name_eng: string; accounts_id?: number; is_disabled?: boolean; priority?: number }>;
    accounts: Account[];
  },
  clientId: number,
  description: string,
): Promise<BookingSuggestion | undefined> {
  const supplierInvoices = context.purchaseInvoices
    .filter(invoice => invoice.clients_id === clientId && invoice.status === "CONFIRMED")
    .sort((a, b) => (b.create_date ?? "").localeCompare(a.create_date ?? ""));

  for (const invoice of supplierInvoices.slice(0, 5)) {
    if (!invoice.id) continue;
    const fullInvoice = await api.purchaseInvoices.get(invoice.id);
    const matchedItem = fullInvoice.items?.find(item =>
      item.custom_title?.toLowerCase().includes(description.toLowerCase())
    ) ?? fullInvoice.items?.[0];

    if (!matchedItem?.cl_purchase_articles_id) continue;

    const suggestedArticle = context.purchaseArticlesWithVat.find(article => article.id === matchedItem.cl_purchase_articles_id);
    const suggestedAccount = matchedItem.purchase_accounts_id
      ? context.accounts.find(account => account.id === matchedItem.purchase_accounts_id)
      : suggestedArticle?.accounts_id
        ? context.accounts.find(account => account.id === suggestedArticle.accounts_id)
        : undefined;

    return {
      source: "supplier_history",
      matched_invoice_id: fullInvoice.id,
      matched_invoice_number: fullInvoice.number,
      suggested_liability_account_id: fullInvoice.liability_accounts_id,
      suggested_account: suggestedAccount,
      suggested_purchase_article: suggestedArticle
        ? { id: suggestedArticle.id, name: suggestedArticle.name_est || suggestedArticle.name_eng }
        : undefined,
      item: {
        cl_purchase_articles_id: matchedItem.cl_purchase_articles_id,
        purchase_accounts_id: pickFirstDefined(matchedItem.purchase_accounts_id, suggestedArticle?.accounts_id),
        purchase_accounts_dimensions_id: matchedItem.purchase_accounts_dimensions_id,
        vat_rate_dropdown: matchedItem.vat_rate_dropdown,
        vat_accounts_id: matchedItem.vat_accounts_id,
        cl_vat_articles_id: matchedItem.cl_vat_articles_id,
        reversed_vat_id: matchedItem.reversed_vat_id,
        custom_title: matchedItem.custom_title || description,
        amount: 1,
      },
    };
  }

  return buildKeywordSuggestion(
    context.purchaseArticlesWithVat,
    context.accounts,
    description,
  );
}

function pickFirstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Prefix-at-word-boundary keyword match. The keyword has to start at the
 * beginning of a word (string start or any non-letter/non-digit), but may
 * be followed by additional letters — Estonian inflects nouns heavily and
 * a fixed keyword like `muu` should still match `muud` / `muude`.
 *
 * Why not plain `String.prototype.includes`? The canonical bug was the
 * 2-letter keyword `"it"` catching the substring inside `"Ehitised"`
 * (Buildings), miscoding OpenAI/ChatGPT receipts as fixed-asset
 * acquisitions (issue #17). Requiring a word boundary at the start kills
 * that without sacrificing Estonian suffix flexibility.
 *
 * Boundary characters use Unicode `\p{L}\p{N}` so Estonian non-ASCII
 * letters (õ, ä, ö, ü, š, ž) act as part of a word.
 */
function matchesKeywordWithBoundary(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, "iu").test(text);
}

export function findAccountByKeywords(accounts: Account[], keywords: string[]): Account | undefined {
  const loweredKeywords = keywords.map(keyword => keyword.toLowerCase());
  return accounts.find(account => {
    // Sanity guard (#17): keyword matching never picks fixed-asset accounts.
    // SaaS/services/subscriptions are categorically not fixed assets;
    // before this guard, the substring bug routed them to "Ehitised"
    // (Buildings, id=1810) via the `"it"` keyword.
    if (account.is_fixed_asset) return false;
    const text = `${account.name_est} ${account.name_eng} ${account.account_type_est} ${account.account_type_eng}`.toLowerCase();
    return loweredKeywords.some(keyword => matchesKeywordWithBoundary(text, keyword));
  });
}

export function findPurchaseArticleByKeywords(
  purchaseArticles: Array<{ id: number; name_est: string; name_eng: string; accounts_id?: number; is_disabled?: boolean; priority?: number }>,
  keywords: string[],
): (typeof purchaseArticles)[number] | undefined {
  const loweredKeywords = keywords.map(keyword => keyword.toLowerCase());
  return [...purchaseArticles]
    .filter(article => !article.is_disabled)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .find(article => {
      const text = `${article.name_est} ${article.name_eng}`.toLowerCase();
      return loweredKeywords.some(keyword => matchesKeywordWithBoundary(text, keyword));
    });
}

export function buildKeywordSuggestion(
  purchaseArticles: Array<{ id: number; name_est: string; name_eng: string; accounts_id?: number; is_disabled?: boolean; priority?: number }>,
  accounts: Account[],
  hints: string,
): BookingSuggestion | undefined {
  const normalizedHints = hints.toLowerCase();
  let articleKeywords = ["muu", "other", "general"];
  let accountKeywords = ["muu", "general", "kulud"];

  if (/(bolt|uber|taxi|parking|transport)/i.test(normalizedHints)) {
    articleKeywords = ["transport", "sõidu", "auto"];
    accountKeywords = ["transport", "sõidu", "auto"];
  } else if (/(wolt|restaurant|cafe|toit|food)/i.test(normalizedHints)) {
    articleKeywords = ["toit", "food", "representation", "esindus"];
    accountKeywords = ["representation", "esindus", "food", "toit"];
  } else if (/(software|subscription|hosting|cloud|openai|chatgpt|anthropic|claude|cursor|google|zoom|slack|github|microsoft|api\b|credits)/i.test(normalizedHints)) {
    // Article-level keywords are tried in order; longer/specific keys come
    // first so the boundary matcher (#17) doesn't accidentally pick a generic
    // entry. Bare "it" is intentionally NOT here — it is too short and was
    // the source of the original Ehitised miscoding bug.
    articleKeywords = ["tarkvara", "software", "internet", "side", "subscription", "sideteenus", "internetikulu"];
    accountKeywords = ["tarkvara", "software", "internet", "sideteenus"];
  } else if (/(bank|pank|fee|teenustasu|commission)/i.test(normalizedHints)) {
    articleKeywords = ["bank", "teenus", "fee"];
    accountKeywords = ["bank", "teenus", "fee"];
  } else if (/(tax|emta|maks)/i.test(normalizedHints)) {
    articleKeywords = ["maks", "tax"];
    accountKeywords = ["maks", "tax"];
  } else if (/(office|kontor|stationery|admin)/i.test(normalizedHints)) {
    articleKeywords = ["kontor", "office", "admin"];
    accountKeywords = ["kontor", "office", "admin"];
  }

  const fallbackArticle = findPurchaseArticleByKeywords(purchaseArticles, ["muu", "other", "general"]);
  const article = findPurchaseArticleByKeywords(purchaseArticles, articleKeywords) ?? fallbackArticle;
  // Resolve the suggested account. If the article's own accounts_id points
  // at a fixed-asset account (rare misconfiguration), refuse it and fall
  // back to keyword search — `findAccountByKeywords` already filters fixed
  // assets out (#17). Without this layer, a single bad purchase-article
  // configuration could re-introduce the Ehitised miscoding through the
  // back door.
  const articleAccount = article?.accounts_id
    ? accounts.find(candidate => candidate.id === article.accounts_id)
    : undefined;
  const articleAccountUsable = !!articleAccount && !articleAccount.is_fixed_asset;
  const account = articleAccountUsable
    ? articleAccount
    : findAccountByKeywords(accounts, accountKeywords)
      ?? findAccountByKeywords(accounts, ["muu", "general", "kulud"]);

  if (!article) return undefined;
  // If the article maps to a fixed-asset account AND we have no non-fixed
  // replacement, refuse to emit a suggestion. Otherwise the article-fallback
  // path below would silently propagate the fixed-asset account into
  // `purchase_accounts_id` — the same back door #17 closed elsewhere.
  // Returning undefined forces the caller to route the row to needs_review.
  if (articleAccount?.is_fixed_asset && !account) return undefined;

  return {
    source: article === fallbackArticle ? "fallback" : "keyword_match",
    suggested_account: account,
    suggested_purchase_article: { id: article.id, name: article.name_est || article.name_eng },
    item: {
      cl_purchase_articles_id: article.id,
      // article.accounts_id is only used as a fallback when itself non-fixed.
      purchase_accounts_id: account?.id ?? (articleAccountUsable ? article.accounts_id : undefined),
      custom_title: "Receipt expense",
      amount: 1,
    },
  };
}

export function computeTermDays(invoiceDate?: string, dueDate?: string): number {
  if (!invoiceDate || !dueDate) return 0;
  const diff = dayDiff(invoiceDate, dueDate);
  return diff === undefined ? 0 : Math.max(0, diff);
}
