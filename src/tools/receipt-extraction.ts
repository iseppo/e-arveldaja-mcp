import { basename, extname } from "path";
import { normalizeCompanyName as normalizeCompanyNameShared } from "../company-name.js";
import { roundMoney } from "../money.js";
import {
  type LayoutTextItem,
  type MarkerPosition,
  type RejectedCandidate,
  buildIdentifierMarkers,
  classifyByPosition,
  extractIban,
  extractIdentifiers,
  extractReferenceNumber,
  extractRegistryCode,
  extractVatNumber,
} from "../document-identifiers.js";
import { hasConfidentInvoiceNumber } from "../invoice-extraction-fallback.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
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

const RECEIPT_TOTAL_LABEL_RE =/(tasuda|maksta|kokku|\btotal\b|grand total|summa kokku|summa eurodes\s*\(km-ga\)|summa\s*\(km-ga\)|maksmisele kuulub|to pay|payable|amount due)/i;
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

export interface FieldProvenance {
  field:
    | "supplier_name"
    | "supplier_vat_no"
    | "supplier_reg_code"
    | "invoice_number"
    | "invoice_date"
    | "total_net"
    | "total_vat"
    | "total_gross"
    | "iban"
    | "ref_number"
    | "currency";
  value: string | number;
  source: "label" | "regex" | "coordinate" | "fallback" | "ocr" | "unknown";
  pageNum?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  confidence?: number;
  rationale?: string;
}

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
  /** Output-only: set when raw_text was capped for MCP output (see capUntrustedText). */
  raw_text_truncated?: boolean;
  /** Output-only: original raw_text length, present only when truncated. */
  raw_text_length?: number;
  /** Minimum OCR confidence reported by parser text items, when available. */
  min_ocr_confidence?: number;
  /** Parser reported likely missing OCR text for one or more OCR-needed pages. */
  partial_ocr_failure?: boolean;
  /** Structured identifier candidates surfaced for reviewer visibility (#vat-reg-recovery). */
  all_vat_candidates?: string[];
  all_reg_code_candidates?: string[];
  reg_code_rationale?: "labeled" | "bare_structural" | "excluded_self" | "buyer_section_only" | "coordinate_confirmed" | "coordinate_confirmed_echo" | "coordinate_rejected";
  vat_no_rationale?: "labeled" | "bare_structural" | "excluded_self" | "buyer_section_only" | "coordinate_confirmed" | "coordinate_confirmed_echo" | "coordinate_rejected";
  rejected_candidates?: RejectedCandidate[];
  field_provenance?: FieldProvenance[];
  extraction_notes?: string[];
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
  /**
   * Degradation note (#6): set when one or more of the supplier's recent
   * purchase-invoice GETs rejected and were skipped, so the freshest history may
   * be missing from this suggestion. Surfaced to the operator so the suggestion
   * is not silently trusted as complete.
   */
  history_partial_note?: string;
}

export const CATEGORY_KEYWORD_MAP: Array<{
  category: TransactionClassificationCategory;
  pattern: RegExp;
  receiptAutoBookingPattern?: RegExp;
  articleKeywords: string[];
  accountKeywords: string[];
  classificationArticleKeywords?: string[];
  classificationAccountKeywords?: string[];
}> = [
  {
    category: "bank_fees",
    pattern: /(bank|pank|fee|teenustasu|commission|service charge|haldustasu)/i,
    receiptAutoBookingPattern: /(bank|pank|fee|teenustasu|commission|service charge|haldustasu)/i,
    articleKeywords: ["bank", "teenus", "fee"],
    accountKeywords: ["bank", "teenus", "fee"],
    classificationArticleKeywords: ["bank", "fee", "teenus"],
    classificationAccountKeywords: ["bank", "fee", "teenus"],
  },
  {
    category: "saas_subscriptions",
    pattern: /(software|subscription|hosting|cloud|openai|chatgpt|anthropic|claude|cursor|google|zoom|slack|github|microsoft|internet|sideteenus|api\b|credits)/i,
    receiptAutoBookingPattern: /(software|subscription|hosting|cloud|openai|google|zoom|slack|github|microsoft|internet|sideteenus)/i,
    articleKeywords: ["tarkvara", "software", "internet", "side", "subscription", "sideteenus", "internetikulu"],
    accountKeywords: ["tarkvara", "software", "subscription", "internet", "sideteenus"],
    classificationArticleKeywords: ["software", "subscription", "internet", "sideteenus"],
    classificationAccountKeywords: ["software", "subscription", "internet", "sideteenus"],
  },
  {
    category: "card_purchases",
    pattern: /(bolt|uber|taxi|parking|transport)/i,
    receiptAutoBookingPattern: /(bolt|uber|taxi|parking|transport)/i,
    articleKeywords: ["transport", "sõidu", "auto"],
    accountKeywords: ["transport", "sõidu", "auto"],
    classificationArticleKeywords: ["transport", "sõidu", "auto"],
    classificationAccountKeywords: ["transport", "sõidu", "auto"],
  },
  {
    category: "card_purchases",
    pattern: /(wolt|restaurant|cafe|toit|food)/i,
    receiptAutoBookingPattern: /(wolt|restaurant|cafe|food|toit)/i,
    articleKeywords: ["toit", "food", "representation", "esindus"],
    accountKeywords: ["representation", "esindus", "food", "toit"],
    classificationArticleKeywords: ["food", "toit", "representation", "esindus"],
    classificationAccountKeywords: ["food", "toit", "representation", "esindus"],
  },
  {
    category: "tax_payments",
    pattern: /(tax|emta|maks)/i,
    receiptAutoBookingPattern: /(tax|emta|maks)/i,
    articleKeywords: ["maks", "tax"],
    accountKeywords: ["maks", "tax"],
  },
  {
    category: "unknown",
    pattern: /(office|kontor|stationery|admin)/i,
    articleKeywords: ["kontor", "office", "admin"],
    accountKeywords: ["kontor", "office", "admin"],
    classificationArticleKeywords: ["office", "kontor", "general", "muu"],
    classificationAccountKeywords: ["office", "kontor", "general", "muu"],
  },
];

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
  lineIndex?: number;
  blocked_as_reference: boolean;
  has_currency_keyword: boolean;
  has_total_like_label: boolean;
  likely_year_amount: boolean;
}

type AmountField = "total_net" | "total_vat" | "total_gross";

interface AmountProvenanceMetadata {
  field: AmountField;
  value: number;
  lineIndex?: number;
  source: FieldProvenance["source"];
  textItem?: LayoutTextItem;
  rationale: string;
}

interface ExtractedAmounts {
  total_net?: number;
  total_vat?: number;
  total_gross?: number;
  vat_explicit?: boolean;
}

export interface ExtractedAmountsWithMetadata extends ExtractedAmounts {
  provenance: AmountProvenanceMetadata[];
  extraction_notes?: string[];
}

interface LayoutRow {
  pageNum: number;
  y: number;
  maxHeight: number;
  items: LayoutTextItem[];
}

interface LayoutAmountCell {
  amount: number;
  item: LayoutTextItem;
  row: LayoutRow;
  columnIndex: number;
  centerX: number;
}

interface LayoutLabelCell {
  field: AmountField;
  item: LayoutTextItem;
  row: LayoutRow;
  columnIndex: number;
  centerX: number;
}

interface LayoutTextCell {
  text: string;
  item: LayoutTextItem;
  row: LayoutRow;
  columnIndex: number;
  centerX: number;
}

interface LayoutColumn {
  index: number;
  centerX: number;
  count: number;
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

// True when `context` contains a dot used as a decimal separator (an "N.NN"
// money amount, e.g. "0.00" or "1,234.56"), ignoring dots inside percentages
// like "24.5%". A dotted date/time/version/identifier is NOT locale evidence:
// treating one as English formatting can inflate an Estonian bare "1,899" to
// 1899. Signals English number formatting so a bare "1,500" is read as
// thousands, not a 3-decimal Estonian value.
function hasDotDecimalSignal(context?: string): boolean {
  if (!context) return false;
  return [...context.matchAll(/(?<![\p{L}\d._-])\d[\d,]*\.\d{1,2}(?![\p{L}\d._-])/gu)].some(match => {
    const start = match.index ?? 0;
    const prefix = context.slice(Math.max(0, start - 24), start);
    // #6: a clock label makes an otherwise amount-shaped "12.30" a time, and
    // date/version/identifier labels serve the same role for dotted tokens.
    if (/\b(?:kell|aeg|time|kuupäev|date|version|versioon|id|identifier|nr|no)\s*[:.]?\s*$/i.test(prefix)) {
      return false;
    }
    const after = context.slice(start + match[0].length);
    return !after.startsWith("%");
  });
}

// True when `context` carries a comma used as a decimal separator with exactly
// one or two fraction digits, e.g. "12,50 €" or "0,5". A three-fraction-digit
// "1,899" is deliberately NOT matched (the trailing digit breaks the boundary)
// because it is the very token whose locale we are trying to resolve — only a
// DIFFERENT, unambiguously comma-decimal sibling should count as an Estonian
// signal.
function hasCommaDecimalSignal(context?: string): boolean {
  if (!context) return false;
  return /\d,\d{1,2}(?!\d)/.test(context);
}

// Document-level number-locale classification used to disambiguate a bare
// single-group "1,234"/"1,899" token, which is structurally identical to both a
// 3-decimal Estonian unit price and an English thousands-grouped integer. The
// context should be as wide as available (ideally the whole document) so the
// decision is document-level, not just same-line (#2). Rules:
//   - a dot-decimal sibling ("10.00") => English (thousands);
//   - else a comma-decimal sibling ("12,50") => European (3-decimal);
//   - else no locale signal at all => "unknown" (caller keeps the
//     Estonian-safe 3-decimal default so a fuel price is never inflated 1000x).
function detectNumberLocale(context?: string): "english" | "european" | "unknown" {
  if (hasDotDecimalSignal(context)) return "english";
  if (hasCommaDecimalSignal(context)) return "european";
  return "unknown";
}

function parseAmount(raw: string, context?: string, documentContext?: string): number | undefined {
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
    // A single-digit integer part with exactly one 3-digit group (e.g. "1,899")
    // is ambiguous: in Estonian receipts the comma is the decimal separator, so
    // it is a 3-decimal unit price (1.899 EUR/l), not a thousands-grouped 1899.
    // But in English formatting the same "1,500" is a thousands-grouped 1500.
    // Resolve it by DOCUMENT-level locale (widest context available), not just
    // the single tokenized line: a dot-decimal sibling anywhere in the document
    // ("10.00") reads it as English thousands; an Estonian/European document
    // (comma-decimal siblings, no dot-decimal) keeps the 3-decimal reading; with
    // no locale signal at all keep the Estonian-safe 3-decimal default. Multi-
    // digit integers ("12,345") or multiple groups ("1,234,567") are always
    // thousands.
    const localeContext = documentContext ?? context;
    if (/^-?\d{1,3}(,\d{3})+$/.test(normalized) && !/^-?\d,\d{3}$/.test(normalized)) {
      normalized = normalized.replace(/,/g, "");
    } else if (/^-?\d,\d{3}$/.test(normalized) && detectNumberLocale(localeContext) === "english") {
      normalized = normalized.replace(/,/g, "");
    } else {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    }
  } else if ((normalized.match(/\./g) ?? []).length > 1) {
    normalized = normalized.replace(/\./g, "");
  } else if (/^\d{1,3}\.\d{3}$/.test(normalized)) {
    normalized = normalized.replace(".", "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? roundMoney(parsed) : undefined;
}

// Exported for unit tests.
/**
 * `includeZero` retains an explicit 0 as a real amount. It is opt-in, and the
 * only caller that sets it is the VAT-total path in classifyLine (guarded by
 * isExplicitVatTotalLine): an unlabelled zero is almost always a page number or
 * an empty cell, and admitting those as candidates would let them become
 * totals. Where the line's subject IS the VAT, the label makes the zero
 * meaningful — "VAT 0.00" states that tax is zero, which is not the same fact
 * as no VAT figure at all. Dropping it left total_vat undefined, which reports
 * VAT as a missing field and pushes zero-rated, exempt, and reverse-charge
 * receipts into needs_review instead of booking them.
 */
export function extractAmountsFromLine(
  line: string,
  documentContext?: string,
  options: { includeZero?: boolean } = {},
): number[] {
  // Only honor a leading minus at start-of-line or after whitespace, and only
  // start a number when it is not immediately preceded by another digit. This
  // stops date/range fragments like "2024-01-15" (→ -1, -15) or "10-20" (→ -20)
  // from manufacturing spurious negative pseudo-amounts.
  const matches = [...line.matchAll(/(?<!\d)-?\d[\d\s.,]*\d|(?<!\d)-?\d/g)];
  const amounts = matches
    .filter(match => {
      const raw = match[0] ?? "";
      const next = line.slice((match.index ?? 0) + raw.length).trimStart();
      return !next.startsWith("%");
    })
    .map(match => {
      const raw = match[0] ?? "";
      const parsed = parseAmount(raw, line, documentContext);
      if (parsed === undefined) return undefined;
      // Accounting-style parenthesised negatives: "(124.00)" means -124. Only
      // negate when the numeric token is immediately wrapped in parentheses,
      // i.e. the parenthesised content is itself the number — this leaves a
      // number embedded in prose like "(see note 3)" (space before the digit)
      // untouched.
      const start = match.index ?? 0;
      const parenWrapped = line[start - 1] === "(" && line[start + raw.length] === ")";
      return parenWrapped && parsed > 0 ? -parsed : parsed;
    })
    .filter((value): value is number =>
      value !== undefined && (options.includeZero === true || value !== 0));

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
  return isExplicitVatTotalLine(trimmed) ||
    /\b(?:sisaldab|including|incl\.?)\b.*(?:käibemaks|vat|tax|km\b)/i.test(trimmed);
}

/**
 * The strictly narrower half of isVatAmountLine: the line's own SUBJECT is the
 * VAT ("VAT 0.00", "KM 0.00"), so its amount IS the document's VAT figure and an
 * explicit zero there is an authoritative statement (H11).
 *
 * Deliberately excludes isVatAmountLine's second branch. A "Shipping incl. VAT
 * 0.00" line merely says a component includes tax; its zero is not the
 * document's VAT total, and retaining it would let the first-wins guard in the
 * assignment loop lock total_vat to 0 before the real "VAT 24.00" line is ever
 * read — silently destroying a deductible 24.00 and reporting it as explicit.
 *
 * Also takes the line's OWN text, never the inspection window: the window
 * appends the NEXT line, and a neighbour's label must not make this line's zero
 * meaningful.
 */
function isExplicitVatTotalLine(line: string): boolean {
  return /^(?:käibemaks\b|vat\b|tax\b|km\b)/i.test(line.trim());
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

export function toIsoDate(year: number, month: number, day: number): string | undefined {
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

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    // Shape alone is not enough: run the same calendar round-trip toIsoDate
    // uses so an impossible day (e.g. 2026-02-30) is rejected instead of
    // passing straight through to a booking field. Return the ORIGINAL string
    // when valid so a well-formed ISO date is preserved byte-for-byte.
    return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) !== undefined ? trimmed : undefined;
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

interface ClassifiedAmountLine {
  line: string;
  inspectionLine: string;
  blockedAsReference: boolean;
  blockedAsReferenceInInspection: boolean;
  amounts: number[];
  pickedGross?: number;
  pickedVat?: number;
  hasCurrencyKeyword: boolean;
  hasTotalLikeLabel: boolean;
  hasNetLikeLabel: boolean;
  hasVatAmountLabel: boolean;
  score: number;
}

function classifyLine(lines: string[], index: number): ClassifiedAmountLine {
  const line = lines[index]!;
  // Pass the whole document as locale context so a bare "1,234" is disambiguated
  // by dot-/comma-decimal siblings on OTHER lines, not just this one (#2).
  const documentContext = lines.join("\n");
  const inspectionLine = buildAmountInspectionLine(lines, index);
  const inspectionLower = inspectionLine.toLowerCase();
  const lineLower = line.toLowerCase();
  const blockedAsReference = RECEIPT_REFERENCE_LINE_RE.test(lineLower);
  const blockedAsReferenceInInspection = RECEIPT_REFERENCE_LINE_RE.test(inspectionLine);
  const hasCurrencyKeyword = RECEIPT_CURRENCY_PATTERNS.some(currency => currency.pattern.test(line));
  const hasTotalLikeLabel = RECEIPT_TOTAL_LABEL_RE.test(lineLower);
  const hasNetLikeLabel = RECEIPT_NET_LABEL_RE.test(lineLower);
  const hasVatAmountLabel = isVatAmountLine(inspectionLine);
  // Resolved BEFORE the amounts so a VAT-total line can retain an explicit zero
  // (H11). Scoped to isExplicitVatTotalLine — NOT hasVatAmountLabel, which is
  // both wider (its "incl. VAT" branch matches component lines) and computed
  // over the inspection window (this line plus the NEXT one). Either would
  // retain a zero on a line that does not state the document's VAT.
  // Everything read here comes from `line`, never from the amounts, so
  // resolving it first changes ordering only, not any value.
  const amounts = extractAmountsFromLine(line, documentContext, {
    includeZero: isExplicitVatTotalLine(line),
  });
  const deDatedAmounts = amounts.filter(amount => !isLikelyYearAmount(amount, line));
  const filteredAmounts = (deDatedAmounts.length > 0 ? deDatedAmounts : amounts).filter(amount =>
    !(Number.isInteger(amount) && amount >= 1000 && !hasCurrencyKeyword && !hasTotalLikeLabel),
  );

  if (filteredAmounts.length === 0) {
    return {
      line,
      inspectionLine,
      blockedAsReference,
      blockedAsReferenceInInspection,
      amounts: [],
      hasCurrencyKeyword,
      hasTotalLikeLabel,
      hasNetLikeLabel,
      hasVatAmountLabel,
      score: 0,
    };
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
  const score = !blockedAsReference && hasTotalLikeLabel
    ? scoreExplicitGrossCandidate(inspectionLine, hasCurrencyKeyword, hasTotalLikeLabel)
    : 0;

  return {
    line,
    inspectionLine,
    blockedAsReference,
    blockedAsReferenceInInspection,
    amounts: filteredAmounts,
    pickedGross,
    pickedVat,
    hasCurrencyKeyword,
    hasTotalLikeLabel,
    hasNetLikeLabel,
    hasVatAmountLabel,
    score,
  };
}

function layoutItemPageNum(item: LayoutTextItem): number {
  return item.pageNum ?? 1;
}

function layoutCenterX(item: LayoutTextItem): number {
  return item.x + item.width / 2;
}

function groupLayoutRows(textItems: readonly LayoutTextItem[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  const rowsByPageBucket = new Map<number, Map<number, LayoutRow[]>>();
  const bucketByRow = new Map<LayoutRow, number>();
  const maxRowHeightByPage = new Map<number, number>();
  const sortedItems = [...textItems]
    .filter(item => clampTextLine(item.text).length > 0)
    .sort((a, b) =>
      layoutItemPageNum(a) - layoutItemPageNum(b) ||
      a.y - b.y ||
      a.x - b.x,
    );

  for (const item of sortedItems) {
    const pageNum = layoutItemPageNum(item);
    const pageBuckets = rowsByPageBucket.get(pageNum) ?? new Map<number, LayoutRow[]>();
    const itemBucket = Math.round(item.y / 10);
    const maxPageHeight = Math.max(maxRowHeightByPage.get(pageNum) ?? 0, item.height);
    const bucketRange = Math.max(1, Math.ceil(Math.max(4, maxPageHeight * 0.7) / 10) + 1);
    const candidateRows = Array.from({ length: bucketRange * 2 + 1 }, (_entry, index) => itemBucket - bucketRange + index)
      .flatMap(bucket => pageBuckets.get(bucket) ?? []);
    const row = candidateRows
      .find(candidate => Math.abs(candidate.y - item.y) <= Math.max(4, Math.max(candidate.maxHeight, item.height) * 0.7));

    if (row) {
      row.items.push(item);
      row.items.sort((a, b) => a.x - b.x);
      row.y = row.items.reduce((sum, rowItem) => sum + rowItem.y, 0) / row.items.length;
      row.maxHeight = Math.max(row.maxHeight, item.height);
      const previousBucket = bucketByRow.get(row);
      const nextBucket = Math.round(row.y / 10);
      if (previousBucket !== undefined && previousBucket !== nextBucket) {
        const previousRows = pageBuckets.get(previousBucket);
        if (previousRows) pageBuckets.set(previousBucket, previousRows.filter(candidate => candidate !== row));
        pageBuckets.set(nextBucket, [...(pageBuckets.get(nextBucket) ?? []), row]);
        bucketByRow.set(row, nextBucket);
      }
      maxRowHeightByPage.set(pageNum, Math.max(maxRowHeightByPage.get(pageNum) ?? 0, row.maxHeight));
    } else {
      const newRow: LayoutRow = { pageNum, y: item.y, maxHeight: item.height, items: [item] };
      rows.push(newRow);
      pageBuckets.set(itemBucket, [...(pageBuckets.get(itemBucket) ?? []), newRow]);
      rowsByPageBucket.set(pageNum, pageBuckets);
      bucketByRow.set(newRow, itemBucket);
      maxRowHeightByPage.set(pageNum, Math.max(maxRowHeightByPage.get(pageNum) ?? 0, item.height));
    }
  }

  return rows.sort((a, b) => a.pageNum - b.pageNum || a.y - b.y);
}

function assignLayoutColumns(rows: readonly LayoutRow[]): Map<LayoutTextItem, number> {
  const columnsByPage = new Map<number, LayoutColumn[]>();
  const columnByItem = new Map<LayoutTextItem, number>();
  const items = rows
    .flatMap(row => row.items)
    .sort((a, b) =>
      layoutItemPageNum(a) - layoutItemPageNum(b) ||
      layoutCenterX(a) - layoutCenterX(b),
    );

  for (const item of items) {
    const pageNum = layoutItemPageNum(item);
    const centerX = layoutCenterX(item);
    const columns = columnsByPage.get(pageNum) ?? [];
    const match = columns.find(column => Math.abs(column.centerX - centerX) <= 35);
    if (match) {
      match.centerX = (match.centerX * match.count + centerX) / (match.count + 1);
      match.count += 1;
      columnByItem.set(item, match.index);
    } else {
      const column: LayoutColumn = { index: columns.length, centerX, count: 1 };
      columns.push(column);
      columnsByPage.set(pageNum, columns);
      columnByItem.set(item, column.index);
    }
  }

  return columnByItem;
}

// "with VAT" gross indicators that also trip the VAT-word regex (`km` inside
// `km-ga`, `käibemaks` inside `käibemaksuga`). These name the *gross* amount
// (sum *including* VAT), so they must never be pulled to total_vat.
const RECEIPT_GROSS_WITH_VAT_RE = /(km-ga|käibemaksuga|koos\s+km|sis(\.|aldab)?\s*(km|käibemaks)|with\s+vat|incl(\.|uding)?\s*vat|vat\s*incl(\.|uded)?)/i;

// Exported for unit tests.
export function classifyLayoutAmountLabel(text: string): AmountField | undefined {
  if (RECEIPT_NET_LABEL_RE.test(text)) return "total_net";
  const grossWithVat = RECEIPT_GROSS_WITH_VAT_RE.test(text);
  // A summary line that explicitly names VAT ("Käibemaks kokku") also contains a
  // TOTAL word ("kokku"). Test VAT before TOTAL when a genuine VAT word is
  // present so the bottom VAT summary is not misclassified as gross — but let an
  // explicit "with VAT" gross indicator ("summa (km-ga)", "Tasuda (sis. KM)")
  // stay gross.
  if (RECEIPT_VAT_LABEL_RE.test(text) && !grossWithVat) return "total_vat";
  if (RECEIPT_TOTAL_LABEL_RE.test(text)) return "total_gross";
  // A "with VAT" gross indicator names the gross amount even with no TOTAL word
  // ("Hind käibemaksuga"); it must win over the trailing VAT fallback below so
  // the guard is not contradicted by a same-line VAT word.
  if (grossWithVat) return "total_gross";
  if (RECEIPT_VAT_LABEL_RE.test(text)) return "total_vat";
  return undefined;
}

function mergeLayoutTextItems(items: readonly LayoutTextItem[]): LayoutTextItem {
  const first = items[0]!;
  const minX = Math.min(...items.map(item => item.x));
  const minY = Math.min(...items.map(item => item.y));
  const maxX = Math.max(...items.map(item => item.x + item.width));
  const maxY = Math.max(...items.map(item => item.y + item.height));
  const confidences = items
    .map(item => item.confidence)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));

  return {
    text: items.map(item => clampTextLine(item.text)).join(" "),
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    pageNum: first.pageNum,
    ...(confidences.length > 0 ? { confidence: Math.min(...confidences) } : {}),
  };
}

function buildLayoutTextCells(row: LayoutRow, columnByItem: ReadonlyMap<LayoutTextItem, number>): LayoutTextCell[] {
  const cells: LayoutTextCell[] = [];
  const textItems = row.items.filter(item => extractAmountsFromLine(item.text).length === 0);

  for (let start = 0; start < textItems.length; start++) {
    for (let end = start; end < Math.min(textItems.length, start + 4); end++) {
      const span = textItems.slice(start, end + 1);
      const merged = mergeLayoutTextItems(span);
      const columnIndex = columnByItem.get(span[0]!);
      if (columnIndex === undefined) continue;
      cells.push({
        text: merged.text,
        item: merged,
        row,
        columnIndex,
        centerX: layoutCenterX(merged),
      });
    }
  }

  return cells;
}

function buildLayoutCells(rows: readonly LayoutRow[], columnByItem: ReadonlyMap<LayoutTextItem, number>): {
  labels: LayoutLabelCell[];
  amounts: LayoutAmountCell[];
} {
  const labels: LayoutLabelCell[] = [];
  const amounts: LayoutAmountCell[] = [];
  // Whole-document locale context so a bare "1,234" amount cell is disambiguated
  // by dot-/comma-decimal siblings elsewhere on the document, not just its own
  // cell (#2).
  const documentContext = rows
    .flatMap(row => row.items.map(item => clampTextLine(item.text)))
    .join("\n");

  for (const row of rows) {
    for (const item of row.items) {
      const text = clampTextLine(item.text);
      const columnIndex = columnByItem.get(item);
      if (columnIndex === undefined) continue;

      for (const amount of extractAmountsFromLine(text, documentContext)) {
        if (amount > MAX_RECEIPT_FALLBACK_AMOUNT || isLikelyYearAmount(amount, text)) continue;
        amounts.push({ amount, item, row, columnIndex, centerX: layoutCenterX(item) });
      }
    }

    for (const cell of buildLayoutTextCells(row, columnByItem)) {
      const field = classifyLayoutAmountLabel(cell.text);
      if (field) {
        labels.push({
          field,
          item: cell.item,
          row: cell.row,
          columnIndex: cell.columnIndex,
          centerX: cell.centerX,
        });
      }
    }
  }

  return { labels, amounts };
}

function horizontalGap(left: LayoutTextItem, right: LayoutTextItem): number {
  if (right.x >= left.x + left.width) return right.x - (left.x + left.width);
  if (left.x >= right.x + right.width) return left.x - (right.x + right.width);
  return 0;
}

function findSameRowLayoutAmount(label: LayoutLabelCell, amounts: readonly LayoutAmountCell[]): LayoutAmountCell | undefined {
  const sameRowAmounts = amounts
    .filter(amount => amount.row === label.row && amount.item !== label.item);
  const labelRightEdge = label.item.x + label.item.width;
  const rightSideAmounts = sameRowAmounts.filter(amount => amount.item.x >= labelRightEdge);
  const isVatRateBreakdown = label.field === "total_vat" &&
    /\b(?:km|käibemaks|vat)\s*\d{1,2}(?:[.,]\d+)?\s*%/i.test(label.item.text);
  // #7: a percentage-rate row has its base and VAT in separate columns, so
  // its VAT is the rightmost amount. Summary labels keep the normal nearest
  // right-side binding, which selects their own VAT column rather than the
  // following gross-total column.
  const candidates = rightSideAmounts.length > 0 ? rightSideAmounts : sameRowAmounts;

  // #3: on a multi-rate breakdown row "KM 24% | 10.00 | 2.40" the taxable base
  // is printed before the VAT amount, so the VAT column is the RIGHTMOST amount,
  // not the nearest one. Binding a total_vat label to the nearest amount would
  // pick the base (10.00) and later sum bases instead of VAT. Bind total_vat to
  // the rightmost same-row amount; single-amount rows ("KM 24% 2.38") are
  // unaffected (rightmost = only amount). Other fields keep nearest-column
  // binding.
  if (isVatRateBreakdown && candidates.length > 1) {
    return [...candidates].sort((a, b) =>
      (b.item.x + b.item.width) - (a.item.x + a.item.width) ||
      b.centerX - a.centerX,
    )[0];
  }

  return candidates
    .sort((a, b) =>
      horizontalGap(label.item, a.item) - horizontalGap(label.item, b.item) ||
      Math.abs(a.centerX - label.centerX) - Math.abs(b.centerX - label.centerX),
    )[0];
}

function findBelowColumnLayoutAmount(label: LayoutLabelCell, amounts: readonly LayoutAmountCell[]): LayoutAmountCell | undefined {
  return amounts
    .filter(amount =>
      amount.row.pageNum === label.row.pageNum &&
      amount.row.y > label.row.y &&
      amount.columnIndex === label.columnIndex,
    )
    .sort((a, b) =>
      a.row.y - b.row.y ||
      Math.abs(a.centerX - label.centerX) - Math.abs(b.centerX - label.centerX),
    )[0];
}

function shouldReplaceLayoutBinding(current: LayoutAmountCell | undefined, next: LayoutAmountCell): boolean {
  if (!current) return true;
  // Prefer the bottom-most binding for every field, not just total_gross. A
  // per-line VAT/net value in a table body (or a column header) can otherwise
  // lock the binding at the top of the page and shadow the authoritative bottom
  // summary line ("Käibemaks kokku"). The bottom-most summary is the total.
  return next.row.pageNum > current.row.pageNum ||
    (next.row.pageNum === current.row.pageNum && next.row.y > current.row.y);
}

function amountMetadataFromLayout(field: AmountField, cell: LayoutAmountCell): AmountProvenanceMetadata {
  return {
    field,
    value: cell.amount,
    source: "coordinate",
    textItem: cell.item,
    rationale: "layout_label_binding",
  };
}

function reconcileLayoutAmounts(bindings: ReadonlyMap<AmountField, LayoutAmountCell>): ExtractedAmountsWithMetadata | undefined {
  const grossBinding = bindings.get("total_gross");
  if (!grossBinding) return undefined;

  const netBinding = bindings.get("total_net");
  const vatBinding = bindings.get("total_vat");
  let totalGross = grossBinding.amount;
  let totalNet = netBinding?.amount;
  let totalVat = vatBinding?.amount;
  const grossMetadata = amountMetadataFromLayout("total_gross", grossBinding);
  let netMetadata = netBinding ? amountMetadataFromLayout("total_net", netBinding) : undefined;
  let vatMetadata = vatBinding ? amountMetadataFromLayout("total_vat", vatBinding) : undefined;

  // #5: validate layout VAT before reconciliation. A negative VAT can make an
  // otherwise self-consistent but impossible trio (100 - -5 = 105), so a
  // later mismatch-only guard would never run. Drop it before it can derive
  // an inflated net; text extraction may still supply a valid VAT afterwards.
  if (totalVat !== undefined && (totalVat < 0 || totalVat > totalGross)) {
    totalVat = undefined;
    vatMetadata = undefined;
  }

  if (totalGross !== undefined && totalVat !== undefined) {
    const derivedNet = roundMoney(totalGross - totalVat);
    if (
      totalNet === undefined ||
      Math.abs(roundMoney(totalNet + totalVat) - totalGross) > 0.02
    ) {
      totalNet = derivedNet;
      netMetadata = {
        field: "total_net",
        value: totalNet,
        source: "fallback",
        textItem: vatMetadata?.textItem ?? grossMetadata.textItem,
        rationale: "derived_from_gross_vat",
      };
    }
  }

  if (totalVat === undefined && totalGross !== undefined && totalNet !== undefined) {
    totalVat = roundMoney(totalGross - totalNet);
    vatMetadata = {
      field: "total_vat",
      value: totalVat,
      source: "fallback",
      textItem: netMetadata?.textItem ?? grossMetadata.textItem,
      rationale: "derived_from_gross_net",
    };
  }

  const provenance = [netMetadata, vatMetadata, grossMetadata]
    .filter((entry): entry is AmountProvenanceMetadata => entry !== undefined);

  return {
    total_net: totalNet,
    total_vat: totalVat,
    total_gross: totalGross,
    vat_explicit: totalVat !== undefined && (vatBinding !== undefined || netBinding !== undefined),
    provenance,
  };
}

// Exported for unit tests.
export function extractAmountsFromLayout(textItems: readonly LayoutTextItem[]): ExtractedAmountsWithMetadata | undefined {
  const rows = groupLayoutRows(textItems);
  if (rows.length === 0) return undefined;

  const columnByItem = assignLayoutColumns(rows);
  const { labels, amounts } = buildLayoutCells(rows, columnByItem);
  const bindings = new Map<AmountField, LayoutAmountCell>();
  const vatRowBindings = new Map<LayoutRow, { label: LayoutLabelCell; cell: LayoutAmountCell }>();

  for (const label of labels) {
    const cell = findSameRowLayoutAmount(label, amounts) ?? findBelowColumnLayoutAmount(label, amounts);
    if (!cell) continue;
    if (label.field === "total_vat" && !vatRowBindings.has(label.row)) {
      vatRowBindings.set(label.row, { label, cell });
    }
    const current = bindings.get(label.field);
    if (shouldReplaceLayoutBinding(current, cell)) {
      bindings.set(label.field, cell);
    }
  }

  // Fix #2: on a multi-rate receipt with several per-rate VAT rows (e.g.
  // "KM 24% 2.38" + "KM 0% 0.00") and NO "kokku"/total VAT summary line, taking
  // the bottom-most row can silently understate VAT (bind to the 0% row). Sum the
  // distinct per-rate VAT rows instead so total_vat is the whole VAT charged.
  const bottomVat = bindings.get("total_vat");
  const hasVatSummaryLabel = [...vatRowBindings.values()].some(({ label }) => RECEIPT_TOTAL_LABEL_RE.test(label.item.text));
  if (bottomVat && vatRowBindings.size > 1 && !hasVatSummaryLabel) {
    // #3: sum only the cells that sit in the actual VAT column. On a breakdown
    // with both a taxable-base column and a VAT column ("KM 24% | 10.00 | 2.40",
    // "KM 0% | 5.00 | 0.00"), a 0%-rate row's 0.00 VAT is filtered out as a zero
    // amount, leaving only its BASE (5.00) bound to the row — summing that base
    // would inflate VAT (2.40 + 5.00 = 7.40). Anchor on the rightmost bound VAT
    // cell and sum only same-column cells; a row whose only bound cell is a base
    // in a left column contributes nothing (its true VAT was 0).
    const vatCells = [...vatRowBindings.values()].map(({ cell }) => cell);
    const rightmostVatCell = vatCells.reduce((best, cell) =>
      (cell.item.x + cell.item.width) > (best.item.x + best.item.width) ? cell : best,
    );
    const summed = roundMoney(
      vatCells
        .filter(cell => cell.columnIndex === rightmostVatCell.columnIndex)
        .reduce((total, cell) => total + cell.amount, 0),
    );
    // Coherence guard: only accept the summed VAT when it is plausible against
    // the gross total. A summed VAT that swallows most of (or exceeds) the gross
    // cannot be right — keep the single bottom-most VAT binding and let
    // reconciliation/text fallbacks supply a consistent value instead of
    // emitting an inflated VAT.
    const grossAmount = bindings.get("total_gross")?.amount;
    const summedIsCoherent = grossAmount === undefined ||
      grossAmount <= 0 ||
      summed < grossAmount;
    if (summedIsCoherent) {
      bindings.set("total_vat", { ...bottomVat, amount: summed });
    }
  }

  return reconcileLayoutAmounts(bindings);
}

// Exported for unit tests.
export function mergeLayoutAmounts(layoutAmounts: ExtractedAmountsWithMetadata, textAmounts: ExtractedAmountsWithMetadata): ExtractedAmountsWithMetadata {
  const grossValuesDisagree = layoutAmounts.total_gross !== undefined &&
    textAmounts.total_gross !== undefined &&
    Math.abs(layoutAmounts.total_gross - textAmounts.total_gross) > 0.02;
  const textGrossIsPlausible = layoutAmounts.total_gross !== undefined &&
    textAmounts.total_gross !== undefined &&
    Math.abs(textAmounts.total_gross) <= MAX_RECEIPT_FALLBACK_AMOUNT &&
    (layoutAmounts.total_gross === 0 || textAmounts.total_gross === 0 || Math.sign(layoutAmounts.total_gross) === Math.sign(textAmounts.total_gross));
  const preferTextGross = grossValuesDisagree && textGrossIsPlausible;
  const mergedProvenance = preferTextGross
    ? layoutAmounts.provenance.filter(entry => entry.field !== "total_gross")
    : [...layoutAmounts.provenance];
  let totalNet = layoutAmounts.total_net;
  let totalVat = layoutAmounts.total_vat;
  const totalGross = preferTextGross ? textAmounts.total_gross : layoutAmounts.total_gross;
  const extractionNotes: string[] = preferTextGross && layoutAmounts.total_gross !== undefined && textAmounts.total_gross !== undefined
    ? [`layout_total_gross_${layoutAmounts.total_gross}_disagreed_with_text_total_gross_${textAmounts.total_gross}_text_preferred`]
    : [];

  const addTextField = (field: AmountField, value: number | undefined) => {
    if (value === undefined) return;
    const metadata = textAmounts.provenance.find(entry => entry.field === field && Math.abs(entry.value - value) < 0.001);
    if (metadata) mergedProvenance.unshift(metadata);
  };

  const dropProvenance = (field: AmountField) => {
    const index = mergedProvenance.findIndex(entry => entry.field === field);
    if (index >= 0) mergedProvenance.splice(index, 1);
  };

  if (preferTextGross) {
    addTextField("total_gross", totalGross);
  }

  // #1c: a layout VAT pinned to the wrong table column (e.g. a per-line VAT or a
  // header cell) can disagree with a correct explicit text VAT. Apply the same
  // conflict rule gross uses — prefer the plausible, explicitly-stated text VAT
  // when the two disagree, so a correct text VAT can override a wrong layout VAT.
  const vatValuesDisagree = totalVat !== undefined &&
    textAmounts.total_vat !== undefined &&
    Math.abs(totalVat - textAmounts.total_vat) > 0.02;
  const textVatIsPlausible = textAmounts.total_vat !== undefined &&
    textAmounts.vat_explicit === true &&
    totalGross !== undefined &&
    textAmounts.total_vat >= 0 &&
    textAmounts.total_vat <= totalGross;
  if (vatValuesDisagree && textVatIsPlausible) {
    extractionNotes.push(`layout_total_vat_${totalVat}_disagreed_with_text_total_vat_${textAmounts.total_vat}_text_preferred`);
    dropProvenance("total_vat");
    totalVat = textAmounts.total_vat;
    addTextField("total_vat", totalVat);
  }

  // #2: after preferring the text gross (or overriding the VAT above) the layout
  // net can go stale — net + vat no longer equals the gross. Re-derive net from
  // the trusted gross and the vat; if the vat itself is implausible against the
  // new gross, drop the stale layout net/vat so the text fallbacks below supply
  // consistent values.
  if (totalGross !== undefined && totalVat !== undefined) {
    const trioReconciles = totalNet !== undefined &&
      Math.abs(roundMoney(totalNet + totalVat) - totalGross) <= 0.02;
    if (!trioReconciles) {
      // #5: a negative layout VAT (e.g. -5 against gross 100) is implausible —
      // re-deriving net from it (net = 105) keeps the bad VAT and inflates net.
      // Only re-derive net when the VAT is within [0, gross]; otherwise drop the
      // stale layout net+vat so the text fallbacks below supply consistent
      // values.
      if (totalVat >= 0 && totalVat <= totalGross) {
        totalNet = roundMoney(totalGross - totalVat);
        dropProvenance("total_net");
        mergedProvenance.unshift({
          field: "total_net",
          value: totalNet,
          source: "fallback",
          textItem: mergedProvenance.find(entry => entry.field === "total_vat")?.textItem
            ?? mergedProvenance.find(entry => entry.field === "total_gross")?.textItem,
          rationale: "derived_from_gross_vat",
        });
      } else {
        dropProvenance("total_net");
        dropProvenance("total_vat");
        totalNet = undefined;
        totalVat = undefined;
      }
    }
  }

  if (totalNet === undefined && textAmounts.total_net !== undefined && totalGross !== undefined && textAmounts.total_net <= totalGross) {
    totalNet = textAmounts.total_net;
    addTextField("total_net", totalNet);
  }

  if (totalVat === undefined && textAmounts.total_vat !== undefined && totalGross !== undefined && textAmounts.total_vat <= totalGross) {
    totalVat = textAmounts.total_vat;
    addTextField("total_vat", totalVat);
  }

  return {
    total_net: totalNet,
    total_vat: totalVat,
    total_gross: totalGross,
    // vat_explicit must reflect the FINAL total_vat: only true when a total_vat
    // survives AND came from an explicit source. When the trio-drop branch above
    // clears total_vat, a stale layout vat_explicit must not leak through.
    vat_explicit: totalVat !== undefined && (layoutAmounts.vat_explicit || textAmounts.vat_explicit === true),
    provenance: mergedProvenance,
    ...(extractionNotes.length > 0 ? { extraction_notes: extractionNotes } : {}),
  };
}

function extractAmountsFromTextWithMetadata(text: string): ExtractedAmountsWithMetadata {
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
  let bestExplicitGrossCandidate: { amount: number; score: number; lineIndex: number } | undefined;
  let vatMetadata: AmountProvenanceMetadata | undefined;
  let netMetadata: AmountProvenanceMetadata | undefined;
  let grossMetadata: AmountProvenanceMetadata | undefined;
  const classifiedLines = lines.map((_line, index) => classifyLine(lines, index));
  const hasExplicitVatLine = classifiedLines.some(classified =>
    classified.hasVatAmountLabel &&
    !classified.blockedAsReferenceInInspection &&
    !RECEIPT_NET_LABEL_RE.test(classified.inspectionLine),
  );

  for (const [lineIndex, classified] of classifiedLines.entries()) {
    if (classified.amounts.length === 0 || classified.pickedGross === undefined) {
      continue;
    }

    fallbackCandidates.push(...classified.amounts.map(amount => ({
      amount,
      lineIndex,
      blocked_as_reference: classified.blockedAsReference,
      has_currency_keyword: classified.hasCurrencyKeyword,
      has_total_like_label: classified.hasTotalLikeLabel,
      likely_year_amount: isLikelyYearAmount(amount, classified.line),
    })));

    if (
      !classified.blockedAsReference &&
      classified.hasTotalLikeLabel
    ) {
      if (!bestExplicitGrossCandidate || classified.score > bestExplicitGrossCandidate.score || (classified.score === bestExplicitGrossCandidate.score && classified.pickedGross > bestExplicitGrossCandidate.amount)) {
        bestExplicitGrossCandidate = { amount: classified.pickedGross, score: classified.score, lineIndex };
      }
    }

    // A zero VAT statement is authoritative only when it is the document's ONLY
    // VAT statement. A multi-rate table ("VAT zero rated 0.00" above "VAT
    // standard 24.00") states both, and the operative figure is the non-zero
    // one — strict first-wins would lock 0 and destroy the deduction. Upgrading
    // 0 -> non-zero is inert for pre-H11 behavior: totalVat is only ever
    // assigned from pickedVat here, and a zero pickedVat was unreachable while
    // extractAmountsFromLine filtered every zero, so this state is new to H11.
    const vatIsUpgradableZero = totalVat === 0 && classified.pickedVat !== 0;
    if (
      (totalVat === undefined || vatIsUpgradableZero) &&
      classified.pickedVat !== undefined &&
      !classified.blockedAsReference &&
      classified.hasVatAmountLabel &&
      !classified.hasNetLikeLabel
    ) {
      totalVat = classified.pickedVat;
      vatFromExplicitLine = true;
      vatMetadata = {
        field: "total_vat",
        value: totalVat,
        lineIndex,
        source: "label",
        rationale: "line_score",
      };
    }

    if (
      totalNet === undefined &&
      !classified.blockedAsReference &&
      classified.hasNetLikeLabel
    ) {
      totalNet = Math.max(...classified.amounts);
      netFromExplicitLine = true;
      netMetadata = {
        field: "total_net",
        value: totalNet,
        lineIndex,
        source: "label",
        rationale: "line_score",
      };
    }

    if (
      !classified.blockedAsReference &&
      !classified.hasTotalLikeLabel &&
      RECEIPT_COMPONENT_LABEL_RE.test(classified.line.toLowerCase())
    ) {
      componentAmounts.push(classified.pickedGross);
    }
  }

  if (bestExplicitGrossCandidate) {
    totalGross = bestExplicitGrossCandidate.amount;
    grossMetadata = {
      field: "total_gross",
      value: totalGross,
      lineIndex: bestExplicitGrossCandidate.lineIndex,
      source: "label",
      rationale: "line_score",
    };
  }

  if (totalGross === undefined) {
    const fallbackCandidate = [...fallbackCandidates]
      .filter(candidate =>
        candidate.amount <= MAX_RECEIPT_FALLBACK_AMOUNT &&
        !candidate.blocked_as_reference,
      )
      .sort((a, b) =>
        scoreReceiptAmountFallbackCandidate(b) - scoreReceiptAmountFallbackCandidate(a) ||
        b.amount - a.amount,
      )[0];
    totalGross = fallbackCandidate?.amount;
    if (fallbackCandidate) {
      grossMetadata = {
        field: "total_gross",
        value: fallbackCandidate.amount,
        lineIndex: fallbackCandidate.lineIndex,
        source: "fallback",
        rationale: "fallback_largest",
      };
    }
  }

  // An explicit zero VAT is authoritative only where the document does not
  // contradict it (H11). When an explicit net AND an explicit gross are both
  // present and differ, "VAT 0.00" cannot be reconciled with them — on OCR text
  // that is most often a misread of the real VAT ("24.00" losing its digits).
  // Trusting the zero would rewrite the explicit net out of the gross below
  // (Subtotal 100 / VAT 0.00 / Total 124 -> net 124), overriding one stated
  // amount to preserve a contradicted one. Deriving instead keeps BOTH stated
  // amounts and reproduces the pre-H11 result exactly. A zero that IS
  // consistent (gross - net == 0) survives untouched, which is the finding.
  // `totalNet !== undefined` already implies the net came from an explicit
  // line: the only write to it above is in the classification loop, which sets
  // netFromExplicitLine in the same breath, and every other write happens below
  // this point. Testing netFromExplicitLine as well would be an unfalsifiable
  // condition, so it is left out.
  if (
    totalVat === 0 && vatFromExplicitLine &&
    totalGross !== undefined && totalNet !== undefined
  ) {
    const reconciledVat = roundMoney(totalGross - totalNet);
    if (Math.abs(reconciledVat) > 0.02) {
      totalVat = reconciledVat;
      vatMetadata = {
        field: "total_vat",
        value: totalVat,
        lineIndex: netMetadata?.lineIndex ?? grossMetadata?.lineIndex,
        source: "fallback",
        rationale: "derived_from_gross_net",
      };
    }
  }

  if (totalGross !== undefined && totalVat !== undefined) {
    const derivedNet = roundMoney(totalGross - totalVat);
    if (
      totalNet === undefined ||
      Math.abs(roundMoney(totalNet + totalVat) - totalGross) > 0.02
    ) {
      totalNet = derivedNet;
      netMetadata = {
        field: "total_net",
        value: totalNet,
        lineIndex: vatMetadata?.lineIndex ?? grossMetadata?.lineIndex,
        source: "fallback",
        rationale: "derived_from_gross_vat",
      };
    }
  }

  if (totalVat === undefined && totalGross !== undefined && totalNet !== undefined) {
    totalVat = roundMoney(totalGross - totalNet);
    vatMetadata = {
      field: "total_vat",
      value: totalVat,
      lineIndex: netMetadata?.lineIndex ?? grossMetadata?.lineIndex,
      source: "fallback",
      rationale: "derived_from_gross_net",
    };
  }

  if (totalGross !== undefined && componentAmounts.length > 0) {
    const componentSum = roundMoney(componentAmounts.reduce((sum, amount) => sum + amount, 0));
    if (Math.abs(componentSum - totalGross) < 0.02 && !hasExplicitVatLine) {
      totalNet = totalGross;
      totalVat = 0;
      netMetadata = {
        field: "total_net",
        value: totalNet,
        lineIndex: grossMetadata?.lineIndex,
        source: "fallback",
        rationale: "component_sum",
      };
      vatMetadata = {
        field: "total_vat",
        value: totalVat,
        lineIndex: grossMetadata?.lineIndex,
        source: "fallback",
        rationale: "component_sum",
      };
      // Inferred "no VAT" from component-sum reconciliation; this is structural,
      // not an explicit OCR statement that VAT is 0.
      vatFromExplicitLine = false;
      netFromExplicitLine = false;
    }
  }

  const provenance = [netMetadata, vatMetadata, grossMetadata]
    .filter((entry): entry is AmountProvenanceMetadata => entry !== undefined);

  return {
    total_net: totalNet,
    total_vat: totalVat,
    total_gross: totalGross,
    vat_explicit: totalVat !== undefined && (vatFromExplicitLine || netFromExplicitLine),
    provenance,
  };
}

function extractAmountsWithMetadata(text: string, textItems?: readonly LayoutTextItem[]): ExtractedAmountsWithMetadata {
  const textAmounts = extractAmountsFromTextWithMetadata(text);
  if (!textItems || textItems.length === 0) return textAmounts;
  const layoutAmounts = extractAmountsFromLayout(textItems);
  if (!layoutAmounts || layoutAmounts.total_gross === undefined) return textAmounts;
  return mergeLayoutAmounts(layoutAmounts, textAmounts);
}

export function extractAmounts(text: string): { total_net?: number; total_vat?: number; total_gross?: number; vat_explicit?: boolean } {
  const { provenance: _provenance, ...amounts } = extractAmountsWithMetadata(text);
  return amounts;
}

export interface ExtractReceiptFieldsOptions {
  ownCompanyVat?: string;
  ownCompanyRegistryCode?: string;
  /** Layout text items from the PDF parser for coordinate-based column classification. */
  textItems?: readonly LayoutTextItem[];
  /** Minimum OCR confidence reported by parser text items, when precomputed by the caller. */
  minOcrConfidence?: number;
  /** Parser reported likely missing OCR text for one or more OCR-needed pages. */
  partialOcrFailure?: boolean;
}

/**
 * Below this minimum OCR confidence (scale 0–1, verified empirically) a
 * document is flagged `low_ocr_confidence` and routed to review. Shared by the
 * single-PDF flow (`extract_pdf_invoice`) and the receipt-batch flow so both
 * gate on the same bar.
 */
export const LOW_OCR_CONFIDENCE_THRESHOLD = 0.6;

export function computeMinOcrConfidence(textItems: readonly LayoutTextItem[] | undefined): number | undefined {
  const confidenceValues = textItems
    ?.map(item => item.confidence)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (!confidenceValues || confidenceValues.length === 0) return undefined;
  // Filter out very short text items (< 3 chars) — likely noise/logo artifacts
  // that carry stray low confidence and would trigger false low_ocr_confidence.
  const robustValues = textItems!
    .filter(item => (item.text?.length ?? 0) >= 3)
    .map(item => item.confidence)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  // Too few robust items for a stable 10th-percentile: fall back to the minimum
  // of the robust (>=3 char) values so a stray low-confidence <3-char noise item
  // cannot dominate. Only use the unfiltered min when no robust item survives.
  if (robustValues.length < 5) {
    return robustValues.length > 0 ? Math.min(...robustValues) : Math.min(...confidenceValues);
  }
  const sorted = [...robustValues].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.1)]!;
}

export function extractPdfIdentifiers(
  text: string,
  options?: ExtractReceiptFieldsOptions,
): Pick<ExtractedReceiptFields, "supplier_reg_code" | "supplier_vat_no" | "supplier_iban" | "ref_number" | "all_vat_candidates" | "all_reg_code_candidates" | "reg_code_rationale" | "vat_no_rationale" | "rejected_candidates"> {
  const ids = extractIdentifiers(text, {
    excludeVat: options?.ownCompanyVat,
    excludeRegCode: options?.ownCompanyRegistryCode,
    textItems: options?.textItems,
  });
  return {
    supplier_reg_code: ids.reg_code,
    supplier_vat_no: ids.vat_no,
    supplier_iban: ids.iban,
    ref_number: ids.ref_number,
    all_vat_candidates: ids.all_vat_candidates,
    all_reg_code_candidates: ids.all_reg_code_candidates,
    ...(ids.reg_code_rationale ? { reg_code_rationale: ids.reg_code_rationale } : {}),
    ...(ids.vat_no_rationale ? { vat_no_rationale: ids.vat_no_rationale } : {}),
    rejected_candidates: ids.rejected_candidates,
  };
}

interface SupplierNameLayoutCandidate {
  name: string;
  item: LayoutTextItem;
  marker: MarkerPosition;
  score: number;
}

const SUPPLIER_NAME_REGION_Y_WINDOW = 170;
const SUPPLIER_NAME_REGION_Y_ABOVE_WINDOW = 80;
const SUPPLIER_NAME_COLUMN_X_WINDOW = 90;

function layoutItemFontSize(item: LayoutTextItem): number {
  return item.fontSize ?? item.height;
}

function layoutItemSamePageAsMarker(item: LayoutTextItem, marker: MarkerPosition): boolean {
  return (item.pageNum ?? 1) === (marker.pageNum ?? 1);
}

function layoutItemColumnDistance(item: LayoutTextItem, marker: MarkerPosition): number {
  const markerCenter = marker.x + marker.width / 2;
  const itemCenter = item.x + item.width / 2;
  return Math.abs(itemCenter - markerCenter);
}

function isLayoutItemInSupplierRegion(
  item: LayoutTextItem,
  marker: MarkerPosition,
  markers: readonly MarkerPosition[],
): boolean {
  if (!layoutItemSamePageAsMarker(item, marker)) return false;
  const yDistance = item.y - marker.y;
  if (yDistance < -SUPPLIER_NAME_REGION_Y_ABOVE_WINDOW || yDistance > SUPPLIER_NAME_REGION_Y_WINDOW) return false;
  if (layoutItemColumnDistance(item, marker) > SUPPLIER_NAME_COLUMN_X_WINDOW) return false;
  if (yDistance < 0) {
    const buyerAbove = markers.some(m =>
      m.side === "buyer" &&
      layoutItemSamePageAsMarker(item, m) &&
      m.y <= item.y + 5 &&
      Math.abs((m.x + m.width / 2) - (item.x + item.width / 2)) <= 50,
    );
    return !buyerAbove;
  }
  return classifyByPosition({ x: item.x, y: item.y, pageNum: item.pageNum }, markers) === "supplier";
}

function scoreSupplierLayoutCandidate(
  item: LayoutTextItem,
  marker: MarkerPosition,
  buyerMarkers: readonly MarkerPosition[],
): number {
  const yDistance = Math.abs(item.y - marker.y);
  const fontScore = layoutItemFontSize(item) * 8;
  const proximityScore = Math.max(0, SUPPLIER_NAME_REGION_Y_WINDOW - yDistance) / 2;
  const columnScore = Math.max(0, SUPPLIER_NAME_COLUMN_X_WINDOW - layoutItemColumnDistance(item, marker)) / 2;
  const beforeBuyerScore = buyerMarkers.some(buyer =>
    layoutItemSamePageAsMarker(item, buyer) &&
    buyer.y > marker.y &&
    item.y < buyer.y
  ) ? 35 : 0;
  return fontScore + proximityScore + columnScore + beforeBuyerScore;
}

function extractSupplierNameFromLayout(textItems: readonly LayoutTextItem[]): SupplierNameLayoutCandidate | undefined {
  const markers = buildIdentifierMarkers(textItems);
  const supplierMarkers = markers.filter(marker => marker.side === "supplier");
  if (supplierMarkers.length === 0) return undefined;

  const buyerMarkers = markers.filter(marker => marker.side === "buyer");
  const candidates: SupplierNameLayoutCandidate[] = [];

  for (const marker of supplierMarkers) {
    for (const item of textItems) {
      if (!isLayoutItemInSupplierRegion(item, marker, markers)) continue;
      const candidate = cleanSupplierCandidate(item.text);
      if (!candidate) continue;
      candidates.push({
        name: candidate,
        item,
        marker,
        score: scoreSupplierLayoutCandidate(item, marker, buyerMarkers),
      });
    }
  }

  return candidates
    .sort((a, b) =>
      b.score - a.score ||
      layoutItemFontSize(b.item) - layoutItemFontSize(a.item) ||
      Math.abs(a.item.y - a.marker.y) - Math.abs(b.item.y - b.marker.y),
    )[0];
}

function extractSupplierNameFromText(text: string, fallbackFileName: string): string | undefined {
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

export interface SupplierNameExtractionResult {
  name?: string;
  extraction_notes?: string[];
  layoutSupplierNameItem?: LayoutTextItem;
  layoutSupplierNameRationale?: string;
}

export function extractSupplierNameWithNotes(
  text: string,
  fallbackFileName: string,
  textItems?: readonly LayoutTextItem[],
): SupplierNameExtractionResult {
  const textName = extractSupplierNameFromText(text, fallbackFileName);
  if (!textItems || textItems.length === 0) {
    return textName !== undefined ? { name: textName } : {};
  }

  const layoutCandidate = extractSupplierNameFromLayout(textItems);
  if (!layoutCandidate) {
    return textName !== undefined ? { name: textName } : {};
  }
  const layoutName = layoutCandidate.name;
  if (textName === undefined || layoutName === textName) {
    return { name: layoutName, layoutSupplierNameItem: layoutCandidate.item, layoutSupplierNameRationale: "layout_marker" };
  }
  const wrappedLayoutName = wrapUntrustedOcr(layoutName) ?? layoutName;
  const wrappedTextName = wrapUntrustedOcr(textName) ?? textName;
  return {
    name: layoutName,
    layoutSupplierNameItem: layoutCandidate.item,
    layoutSupplierNameRationale: "layout_marker",
    extraction_notes: [`Supplier name conflict: layout="${wrappedLayoutName}" text="${wrappedTextName}" — using layout result`],
  };
}

export function extractSupplierName(
  text: string,
  fallbackFileName: string,
  textItems?: readonly LayoutTextItem[],
): string | undefined {
  return extractSupplierNameWithNotes(text, fallbackFileName, textItems).name;
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

function normalizeProvenanceSearchValue(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function textItemContainsStringValue(item: LayoutTextItem, value: string): boolean {
  const normalizedItem = normalizeProvenanceSearchValue(item.text);
  const normalizedValue = normalizeProvenanceSearchValue(value);
  return normalizedValue.length > 0 && normalizedItem.includes(normalizedValue);
}

function textItemContainsAmountValue(item: LayoutTextItem, value: number): boolean {
  return extractAmountsFromLine(item.text).some(amount => Math.abs(amount - value) < 0.001);
}

function findTextItemForStringValue(value: string | undefined, textItems?: readonly LayoutTextItem[]): LayoutTextItem | undefined {
  if (!value || !textItems || textItems.length === 0) return undefined;
  return textItems.find(item => textItemContainsStringValue(item, value));
}

function findTextItemForAmountValue(value: number, lineIndex: number | undefined, lines: readonly string[], textItems?: readonly LayoutTextItem[]): LayoutTextItem | undefined {
  if (!textItems || textItems.length === 0) return undefined;
  const line = lineIndex !== undefined ? lines[lineIndex] : undefined;
  if (line) {
    const normalizedLine = clampTextLine(line);
    const lineMatch = textItems.find(item =>
      clampTextLine(item.text) === normalizedLine && textItemContainsAmountValue(item, value)
    );
    if (lineMatch) return lineMatch;
  }
  return textItems.find(item => textItemContainsAmountValue(item, value));
}

function provenanceLocation(item: LayoutTextItem | undefined): Pick<FieldProvenance, "pageNum" | "bbox" | "confidence"> {
  if (!item) return {};
  return {
    pageNum: item.pageNum ?? 1,
    bbox: { x: item.x, y: item.y, width: item.width, height: item.height },
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
  };
}

function identifierSourceFromRationale(rationale?: ExtractedReceiptFields["reg_code_rationale"] | ExtractedReceiptFields["vat_no_rationale"]): FieldProvenance["source"] {
  switch (rationale) {
    case "labeled":
      return "label";
    case "coordinate_confirmed":
    case "coordinate_confirmed_echo":
    case "coordinate_rejected":
      return "coordinate";
    case "bare_structural":
      return "regex";
    case "buyer_section_only":
    case "excluded_self":
      return "fallback";
    default:
      return "unknown";
  }
}

function supplierNameSource(text: string, fileName: string, supplierName: string | undefined): { source: FieldProvenance["source"]; rationale?: string } {
  if (!supplierName) return { source: "unknown" };
  const lines = text.split(/\r?\n/).map(clampTextLine).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (SUPPLIER_LABEL_RE.test(line)) {
      const labelledCandidate = cleanSupplierCandidate(line);
      const nextLineCandidate = cleanSupplierCandidate(lines[index + 1] ?? "");
      if (labelledCandidate === supplierName || nextLineCandidate === supplierName) {
        return { source: "label", rationale: "labeled" };
      }
    }
  }
  const fileToken = normalizeFilenameToken(fileName).replace(/-/g, " ");
  if (fileToken && fileToken === supplierName) {
    return { source: "fallback", rationale: "filename_token" };
  }
  return { source: "ocr", rationale: "top_line" };
}

function invoiceNumberSource(text: string, invoiceNumber: string): { source: FieldProvenance["source"]; rationale?: string } {
  if (invoiceNumber.startsWith("AUTO-")) return { source: "fallback", rationale: "filename_token" };
  const labelPatterns = [
    /(?:arve(?:\/tehingu)?(?:-saateleht)?\s*(?:nr|number|no\.?)|invoice\s*(?:nr|number|no\.?)|dokumendi\s*nr|receipt\s*(?:nr|number|no\.?)|tellimuse\s*number|order\s*number|booking\s*(?:number|no\.?)|pileti\s*nr)[:#\s.-]*([A-Z0-9/_-]{3,})/i,
    /(?:number|nr|no\.?)[:#\s-]*([A-Z0-9/_-]{3,})/i,
  ];
  for (const pattern of labelPatterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim() === invoiceNumber) {
      return { source: "label", rationale: "labeled" };
    }
  }
  return { source: "regex", rationale: "pattern_match" };
}

function dateSource(text: string, value: string): { source: FieldProvenance["source"]; rationale?: string } {
  const labelPatterns = [
    new RegExp(`(?:invoice\\s*date|arve\\s*kuupäev|arve\\s*kpv|kuupäev|date|issue\\s*date|date\\s*of\\s*issue|tellimuse\\s*kuupäev|date\\s*paid|receipt\\s*date|purchase\\s*date)[:\\s-]*(${WEEKDAY_PREFIX_SOURCE}${DATE_VALUE_SOURCE})`, "iu"),
  ];
  for (const pattern of labelPatterns) {
    const match = text.match(pattern);
    if (match?.[1] && normalizeDate(match[1]) === value) {
      return { source: "label", rationale: "labeled" };
    }
  }
  return { source: "regex", rationale: "date_pattern" };
}

function buildFieldProvenance(
  text: string,
  fileName: string,
  identifiers: ReturnType<typeof extractPdfIdentifiers>,
  amounts: ExtractedAmountsWithMetadata,
  fields: Pick<ExtractedReceiptFields, "supplier_name" | "invoice_number" | "invoice_date" | "currency">,
  textItems?: readonly LayoutTextItem[],
  layoutSupplierNameItem?: LayoutTextItem,
  layoutSupplierNameRationale?: string,
): FieldProvenance[] {
  const provenance: FieldProvenance[] = [];
  const lines = text.split(/\r?\n/).map(clampTextLine).filter(Boolean);

  const pushString = (
    field: FieldProvenance["field"],
    value: string | undefined,
    source: FieldProvenance["source"],
    rationale?: string,
    textItem?: LayoutTextItem,
  ) => {
    if (value === undefined) return;
    provenance.push({
      field,
      value,
      source,
      ...provenanceLocation(textItem ?? findTextItemForStringValue(value, textItems)),
      ...(rationale ? { rationale } : {}),
    });
  };

  const supplierSource = layoutSupplierNameItem
    ? { source: "coordinate" as const, rationale: layoutSupplierNameRationale }
    : supplierNameSource(text, fileName, fields.supplier_name);
  pushString("supplier_name", fields.supplier_name, supplierSource.source, supplierSource.rationale, layoutSupplierNameItem);
  pushString(
    "supplier_reg_code",
    identifiers.supplier_reg_code,
    identifierSourceFromRationale(identifiers.reg_code_rationale),
    identifiers.reg_code_rationale,
  );
  pushString(
    "supplier_vat_no",
    identifiers.supplier_vat_no,
    identifierSourceFromRationale(identifiers.vat_no_rationale),
    identifiers.vat_no_rationale,
  );
  pushString("iban", identifiers.supplier_iban, "regex", "pattern_match");
  pushString("ref_number", identifiers.ref_number, "regex", "pattern_match");

  if (fields.invoice_number !== undefined) {
    const source = invoiceNumberSource(text, fields.invoice_number);
    pushString("invoice_number", fields.invoice_number, source.source, source.rationale);
  }

  if (fields.invoice_date !== undefined) {
    const source = dateSource(text, fields.invoice_date);
    pushString("invoice_date", fields.invoice_date, source.source, source.rationale);
  }

  if (fields.currency !== undefined) {
    pushString("currency", fields.currency, "regex", "currency_pattern");
  }

  for (const amount of amounts.provenance) {
    provenance.push({
      field: amount.field,
      value: amount.value,
      source: amount.source,
      ...provenanceLocation(amount.textItem ?? findTextItemForAmountValue(amount.value, amount.lineIndex, lines, textItems)),
      rationale: amount.rationale,
    });
  }

  return provenance.slice(0, 15);
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
  _category?: TransactionClassificationCategory,
  _supplierCountry?: string | null,
): Pick<PurchaseInvoiceItem, "vat_rate_dropdown" | "reversed_vat_id"> {
  return { vat_rate_dropdown: "-" };
}

export function getAutoBookedVatRateDropdown(
  _category?: TransactionClassificationCategory,
  _supplierCountry?: string | null,
): string {
  return getAutoBookedVatConfig().vat_rate_dropdown ?? "-";
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
  const supplierResult = extractSupplierNameWithNotes(text, fileName, options?.textItems);
  const supplierName = supplierResult.name;
  const amounts = extractAmountsWithMetadata(text, options?.textItems);
  const currency = detectReceiptCurrency(text);
  const invoiceNumber = extractInvoiceNumber(text, fileName);
  const minOcrConfidence = options?.minOcrConfidence ?? computeMinOcrConfidence(options?.textItems);
  const fieldProvenance = buildFieldProvenance(
    text,
    fileName,
    identifiers,
    amounts,
    {
      supplier_name: supplierName,
      invoice_number: invoiceNumber,
      invoice_date,
      currency,
    },
    options?.textItems,
    supplierResult.layoutSupplierNameItem,
    supplierResult.layoutSupplierNameRationale,
  );
  const { provenance: _amountProvenance, extraction_notes: amountNotes, ...amountFields } = amounts;
  const extractionNotes = [
    ...(amountNotes ?? []),
    ...(supplierResult.extraction_notes ?? []),
  ];

  return {
    ...identifiers,
    ...amountFields,
    currency,
    supplier_name: supplierName,
    invoice_number: invoiceNumber,
    invoice_date,
    due_date,
    description: extractDescription(text, supplierName),
    raw_text: text,
    ...(minOcrConfidence !== undefined ? { min_ocr_confidence: minOcrConfidence } : {}),
    ...(options?.partialOcrFailure ? { partial_ocr_failure: true } : {}),
    ...(fieldProvenance.length > 0 ? { field_provenance: fieldProvenance } : {}),
    ...(extractionNotes && extractionNotes.length > 0 ? { extraction_notes: extractionNotes } : {}),
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

  // Use allSettled so a single transient GET failure does not reject the whole
  // batch and lose the other suppliers' history. Fulfilled results are processed
  // in the original (most-recent-first) order; rejected entries are skipped.
  const settledInvoices = await Promise.allSettled(
    supplierInvoices.slice(0, 5).map(invoice =>
      invoice.id ? api.purchaseInvoices.get(invoice.id) : Promise.resolve(undefined)
    )
  );

  // #6: a rejected GET is skipped below so the whole suggestion does not fail,
  // but the freshest history may then be missing — carry a degradation note on
  // the suggestion so the caller does not silently trust older history only.
  const historyUnavailable = settledInvoices.filter(settled => settled.status === "rejected").length;
  const historyPartialNote = historyUnavailable > 0
    ? `supplier_history_partial: ${historyUnavailable} of ${settledInvoices.length} recent invoices unavailable`
    : undefined;
  const withHistoryNote = (suggestion: BookingSuggestion | undefined): BookingSuggestion | undefined =>
    suggestion && historyPartialNote ? { ...suggestion, history_partial_note: historyPartialNote } : suggestion;

  for (const settled of settledInvoices) {
    if (settled.status !== "fulfilled") continue;
    const fullInvoice = settled.value;
    if (!fullInvoice) continue;
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

    return withHistoryNote({
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
    });
  }

  return withHistoryNote(buildKeywordSuggestion(
    context.purchaseArticlesWithVat,
    context.accounts,
    description,
  ));
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

  // Merchant-specific card_purchases patterns (bolt/uber/taxi/parking/wolt/…)
  // must be tested before the generic bank_fees pattern. Otherwise a hint like
  // "Bolt teenustasu" / "parking fee" / "Wolt service charge" matches the
  // bank_fees `fee|teenustasu|service charge` alternation (which is listed
  // first in CATEGORY_KEYWORD_MAP) and is miscoded as a bank fee instead of a
  // transport/representation expense. Restore transport-before-bank ordering
  // for this call site the way the sibling classification functions do.
  const orderedCategories = [
    ...CATEGORY_KEYWORD_MAP.filter(entry => entry.category === "card_purchases"),
    ...CATEGORY_KEYWORD_MAP.filter(entry => entry.category !== "card_purchases"),
  ];
  const keywordMatch = orderedCategories.find(entry => entry.pattern.test(normalizedHints));
  if (keywordMatch) {
    articleKeywords = keywordMatch.articleKeywords;
    accountKeywords = keywordMatch.accountKeywords;
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
