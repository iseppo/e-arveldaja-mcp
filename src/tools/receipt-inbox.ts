import { existsSync, realpathSync } from "fs";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join, resolve } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pdf from "pdf-parse";
import { closest } from "fastest-levenshtein";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import type { Account, Client, PurchaseInvoice, PurchaseInvoiceItem, SaleInvoice, Transaction } from "../types/api.js";
import { validateFilePath } from "../file-validation.js";
import { roundMoney } from "../money.js";
import { reportProgress } from "../progress.js";
import { getProjectRoot } from "../paths.js";
import { readOnly, batch } from "../annotations.js";
import { type ApiContext, isCompanyVatRegistered, safeJsonParse } from "./crud-tools.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat, normalizeVatRate } from "./purchase-vat-defaults.js";

const MAX_RECEIPT_SIZE = 50 * 1024 * 1024; // 50 MB
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_TYPE_EXTENSIONS = {
  pdf: [".pdf"],
  jpg: [".jpg", ".jpeg"],
  png: [".png"],
} as const;
const SUPPORTED_EXTENSIONS = [...FILE_TYPE_EXTENSIONS.pdf, ...FILE_TYPE_EXTENSIONS.jpg, ...FILE_TYPE_EXTENSIONS.png];
const DEFAULT_LIABILITY_ACCOUNT = 2310;
const EXACT_MATCH_THRESHOLD = 90;
const POSSIBLE_MATCH_THRESHOLD = 70;
const AUTO_BOOKED_NET_DECIMALS = 6;
const MAX_RECEIPT_FALLBACK_AMOUNT = 50_000;
const RECEIPT_TOTAL_LABEL_RE = /(tasuda|maksta|kokku|total|grand total|summa kokku|maksmisele kuulub|to pay|payable|amount due)/i;
const RECEIPT_VAT_LABEL_RE = /(käibemaks|km\b|vat\b)/i;
const RECEIPT_NET_LABEL_RE = /(neto|subtotal|summa km-ta|käibemaksuta|without vat|total net)/i;
const RECEIPT_REFERENCE_LINE_RE =
  /\b(reg\.?\s*(?:nr|kood|code)|registrikood|registry code|kmkr|vat\s*(?:nr|number|no\.?)|iban|viitenumber|viitenr|reference|ref\.?\s*(?:nr|number))\b/i;
const RECEIPT_CURRENCY_PATTERNS = [
  { code: "EUR", pattern: /\bEUR\b|€/i },
  { code: "USD", pattern: /\bUSD\b|\bUS\$/i },
  { code: "GBP", pattern: /\bGBP\b/i },
  { code: "SEK", pattern: /\bSEK\b/i },
  { code: "NOK", pattern: /\bNOK\b/i },
  { code: "DKK", pattern: /\bDKK\b/i },
  { code: "CHF", pattern: /\bCHF\b/i },
  { code: "PLN", pattern: /\bPLN\b/i },
] as const;
const PERSON_COUNTERPARTY_COMPANY_WORD_RE =
  /\b(limited|ltd|llc|inc|gmbh|ag|ab|oy|srl|bv|nv|sa|plc|ireland|operations|services|solutions|group|holding|capital|systems|technologies|media|digital|cloud|platform|company|corp|corporation)\b/i;
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
};

type FileType = keyof typeof FILE_TYPE_EXTENSIONS;
type ReceiptClassification = "purchase_invoice" | "owner_paid_expense_reimbursement" | "unclassifiable";
type ReceiptBatchStatus =
  | "matched"
  | "created"
  | "skipped_duplicate"
  | "needs_review"
  | "failed"
  | "dry_run_preview";
type TransactionClassificationCategory =
  | "saas_subscriptions"
  | "bank_fees"
  | "tax_payments"
  | "salary_payroll"
  | "owner_transfers"
  | "card_purchases"
  | "revenue_without_invoice"
  | "unknown";
type ClassificationApplyMode = "purchase_invoice" | "review_only";

interface ReceiptFileInfo {
  name: string;
  path: string;
  extension: string;
  file_type: FileType;
  size_bytes: number;
  modified_at: string;
}

interface ReceiptScanResult {
  files: ReceiptFileInfo[];
  skipped: Array<{ name: string; reason: string }>;
  folder_path: string;
  total_candidates: number;
}

interface ExtractedReceiptFields {
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
  currency?: string;
  description?: string;
  raw_text?: string;
}

interface SupplierResolution {
  found: boolean;
  created: boolean;
  match_type?: "registry_code" | "vat_no" | "name_fuzzy" | "created";
  client?: Client;
  preview_client?: Partial<Client>;
  registry_data?: Record<string, string> | null;
}

interface BookingSuggestion {
  item: PurchaseInvoiceItem;
  source: "supplier_history" | "keyword_match" | "fallback";
  matched_invoice_id?: number;
  matched_invoice_number?: string;
  suggested_account?: Account;
  suggested_purchase_article?: { id: number; name: string };
}

interface InvoiceDuplicateMatch {
  reason: "supplier_invoice_number" | "supplier_amount_date";
  invoice_id: number;
  invoice_number: string;
  create_date: string;
  gross_price?: number;
}

interface TransactionMatchCandidate {
  transaction_id: number;
  amount: number;
  date: string;
  bank_account_name?: string | null;
  description?: string | null;
  confidence: number;
  reasons: string[];
}

interface ReceiptBatchFileResult {
  file: ReceiptFileInfo;
  classification: ReceiptClassification;
  status: ReceiptBatchStatus;
  extracted?: ExtractedReceiptFields;
  supplier_resolution?: SupplierResolution;
  booking_suggestion?: BookingSuggestion;
  duplicate_match?: InvoiceDuplicateMatch;
  created_invoice?: {
    id?: number;
    number: string;
    status?: string;
    confirmed?: boolean;
    uploaded_document?: boolean;
  };
  bank_match?: {
    candidate?: TransactionMatchCandidate;
    linked?: boolean;
    confirmed_transaction_id?: number;
  };
  notes: string[];
  error?: string;
}

interface InvoiceSummaryForMatching {
  id?: number;
  clients_id?: number;
  client_name?: string;
  number?: string;
  gross_price?: number;
  base_gross_price?: number;
  create_date?: string;
  bank_ref_number?: string | null;
  payment_status?: string;
  status?: string;
}

interface ReceiptProcessingContext {
  clients: Client[];
  purchaseInvoices: PurchaseInvoice[];
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>;
  accounts: Account[];
  isVatRegistered: boolean;
}

interface TransactionGroup {
  normalized_counterparty: string;
  display_counterparty: string;
  transactions: Transaction[];
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

interface ClassifiedTransactionSuggestion {
  purchase_article_id?: number;
  purchase_article_name?: string;
  purchase_account_id?: number;
  purchase_account_name?: string;
  liability_account_id?: number;
  reason: string;
}

interface ClassifiedTransactionGroupResult {
  category: TransactionClassificationCategory;
  apply_mode: ClassificationApplyMode;
  normalized_counterparty: string;
  display_counterparty: string;
  recurring: boolean;
  similar_amounts: boolean;
  total_amount: number;
  suggested_booking: ClassifiedTransactionSuggestion;
  reasons: string[];
  transactions: Array<{
    id?: number;
    type: string;
    amount: number;
    date: string;
    description?: string | null;
    bank_account_name?: string | null;
    bank_subtype?: string | null;
    accounts_dimensions_id: number;
    clients_id?: number | null;
  }>;
}

interface ReceiptAmountCandidate {
  amount: number;
  blocked_as_reference: boolean;
  has_currency_keyword: boolean;
  has_total_like_label: boolean;
}

interface SupplierResolutionOptions {
  classification_category?: TransactionClassificationCategory;
}

function getAllowedRoots(): string[] {
  const raw = process.env.EARVELDAJA_ALLOWED_PATHS
    ? process.env.EARVELDAJA_ALLOWED_PATHS.split(":").map(path => resolve(path))
    : [homedir(), "/tmp"];

  return raw.map(root => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
}

function resolveInputPath(inputPath: string): string {
  if (inputPath.startsWith("/")) {
    return resolve(inputPath);
  }

  const projectRoot = getProjectRoot();
  const bases = [
    resolve(projectRoot, ".."),
    projectRoot,
    process.cwd(),
  ];

  for (const base of bases) {
    const candidate = resolve(base, inputPath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return resolve(bases[0]!, inputPath);
}

async function validateFolderPath(folderPath: string): Promise<string> {
  const resolved = resolveInputPath(folderPath);
  const real = await realpath(resolved);
  const roots = getAllowedRoots();

  if (!roots.some(root => real.startsWith(`${root}/`) || real === root)) {
    throw new Error(
      `Folder path outside allowed directories. Allowed roots: ${roots.join(", ")}. ` +
      `Set EARVELDAJA_ALLOWED_PATHS to override.`,
    );
  }

  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new Error("Not a directory");
  }

  return real;
}

function extensionsForTypes(fileTypes?: FileType[]): string[] {
  if (!fileTypes || fileTypes.length === 0) {
    return SUPPORTED_EXTENSIONS;
  }

  const expanded = new Set<string>();
  for (const fileType of fileTypes) {
    for (const extension of FILE_TYPE_EXTENSIONS[fileType]) {
      expanded.add(extension);
    }
  }

  return [...expanded];
}

function extensionToFileType(extension: string): FileType | undefined {
  const normalized = extension.toLowerCase();
  if (normalized === ".pdf") return "pdf";
  if (normalized === ".jpg" || normalized === ".jpeg") return "jpg";
  if (normalized === ".png") return "png";
  return undefined;
}

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
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? roundMoney(parsed) : undefined;
}

function extractAmountsFromLine(line: string): number[] {
  const matches = line.match(/\d[\d\s.,-]*\d|\d/g) ?? [];
  const amounts = matches
    .map(match => parseAmount(match))
    .filter((value): value is number => value !== undefined && value !== 0);

  return [...new Set(amounts)];
}

function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

function hasAllCapsWord(value: string): boolean {
  return value
    .split(/\s+/)
    .map(part => part.replace(/[^\p{L}]/gu, ""))
    .some(part => part.length >= 2 && part === part.toUpperCase() && part !== part.toLowerCase());
}

export function getClientCountryFromIban(iban?: string | null): string | undefined {
  const normalized = iban?.replace(/\s+/g, "").toUpperCase();
  const countryCode = normalized?.slice(0, 2);
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return undefined;
  return IBAN_COUNTRY_TO_CLIENT_COUNTRY[countryCode] ?? countryCode;
}

function isDomesticClientCountry(country?: string | null): boolean {
  if (!country) return true;
  const normalized = country.trim().toUpperCase();
  return normalized === "EST" || normalized === "EE";
}

function scoreReceiptAmountFallbackCandidate(candidate: ReceiptAmountCandidate): number {
  return (candidate.has_total_like_label ? 4 : 0) + (candidate.has_currency_keyword ? 2 : 0);
}

export function detectReceiptCurrency(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(clampTextLine)
    .filter(Boolean);
  const prioritizedLines = [
    ...lines.filter(line => RECEIPT_TOTAL_LABEL_RE.test(line) || extractAmountsFromLine(line).length > 0),
    ...lines,
  ];

  for (const line of prioritizedLines) {
    const matched = RECEIPT_CURRENCY_PATTERNS.find(currency => currency.pattern.test(line));
    if (matched) {
      return matched.code;
    }
  }

  return "EUR";
}

function normalizeDate(raw: string): string | undefined {
  const trimmed = raw.trim();

  if (ISO_DATE_RE.test(trimmed)) {
    return trimmed;
  }

  const dotted = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) {
    const [, day, month, year] = dotted;
    const iso = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
    return ISO_DATE_RE.test(iso) ? iso : undefined;
  }

  return undefined;
}

function dayDiff(dateA?: string, dateB?: string): number | undefined {
  if (!dateA || !dateB) return undefined;
  const tsA = Date.parse(`${dateA}T00:00:00Z`);
  const tsB = Date.parse(`${dateB}T00:00:00Z`);
  if (!Number.isFinite(tsA) || !Number.isFinite(tsB)) return undefined;
  return Math.round(Math.abs(tsA - tsB) / 86_400_000);
}

function computeTermDays(invoiceDate?: string, dueDate?: string): number {
  if (!invoiceDate || !dueDate) return 0;
  const diff = dayDiff(invoiceDate, dueDate);
  return diff === undefined ? 0 : Math.max(0, diff);
}

function pickFirstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function extractSupplierName(text: string, fallbackFileName: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map(clampTextLine)
    .filter(Boolean);

  const labelled = lines.find(line =>
    /^(müüja|seller|supplier|teenusepakkuja|arve esitaja)\b/i.test(line)
  );
  if (labelled) {
    const afterLabel = labelled.split(/[:\-]/).slice(1).join(":").trim();
    if (afterLabel) return afterLabel;
  }

  const companyPattern = /\b(OÜ|OU|AS|MTÜ|FIE|UAB|SIA|LLC|LTD|GMBH|OY|AB)\b/i;
  const ignoredPattern = /\b(arve|invoice|receipt|kviitung|tšekk|tsekk|summa|kokku|total|date|kuupäev|due|tasuda|maksta)\b/i;
  const candidate = lines.find(line =>
    line.length >= 3 &&
    line.length <= 80 &&
    !ignoredPattern.test(line) &&
    (companyPattern.test(line) || /^[A-ZÄÖÜÕ0-9][A-ZÄÖÜÕ0-9 '&().,-]{4,}$/.test(line))
  );

  if (candidate) return candidate;

  const fileToken = normalizeFilenameToken(fallbackFileName).replace(/-/g, " ");
  return fileToken || undefined;
}

function extractInvoiceNumber(text: string, fileName: string): string {
  const invoiceNumberPatterns = [
    /(?:arve\s*(?:nr|number|no\.?)|invoice\s*(?:nr|number|no\.?)|dokumendi\s*nr|receipt\s*(?:nr|number|no\.?))[:#\s-]*([A-Z0-9/_-]{3,})/i,
    /(?:number|nr)[:#\s-]*([A-Z0-9/_-]{3,})/i,
  ];

  for (const pattern of invoiceNumberPatterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }

  const todayToken = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `AUTO-${todayToken}-${normalizeFilenameToken(fileName) || "RECEIPT"}`;
}

function extractDateByLabels(text: string, labels: RegExp[]): string | undefined {
  for (const label of labels) {
    const match = text.match(label);
    const normalized = match?.[1] ? normalizeDate(match[1]) : undefined;
    if (normalized) return normalized;
  }
  return undefined;
}

function extractDates(text: string): { invoice_date?: string; due_date?: string } {
  const invoiceDate = extractDateByLabels(text, [
    /(?:invoice\s*date|arve\s*kuupäev|kuupäev|date)[:\s-]*([0-9.-]{8,10})/i,
    /(?:receipt\s*date|purchase\s*date)[:\s-]*([0-9.-]{8,10})/i,
  ]);

  const dueDate = extractDateByLabels(text, [
    /(?:due\s*date|maksetähtaeg|tähtaeg)[:\s-]*([0-9.-]{8,10})/i,
  ]);

  if (invoiceDate || dueDate) {
    return { invoice_date: invoiceDate, due_date: dueDate };
  }

  const rawDates = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})\b/g)]
    .map(match => normalizeDate(match[1] ?? ""))
    .filter((value): value is string => value !== undefined);

  return {
    invoice_date: rawDates[0],
    due_date: rawDates[1],
  };
}

export function extractAmounts(text: string): { total_net?: number; total_vat?: number; total_gross?: number } {
  const lines = text
    .split(/\r?\n/)
    .map(clampTextLine)
    .filter(Boolean);

  let totalGross: number | undefined;
  let totalVat: number | undefined;
  let totalNet: number | undefined;
  const fallbackCandidates: ReceiptAmountCandidate[] = [];

  for (const line of lines) {
    const amounts = extractAmountsFromLine(line);
    if (amounts.length === 0) continue;

    const lineLower = line.toLowerCase();
    const picked = amounts[amounts.length - 1];
    const blockedAsReference = RECEIPT_REFERENCE_LINE_RE.test(lineLower);
    const hasCurrencyKeyword = RECEIPT_CURRENCY_PATTERNS.some(currency => currency.pattern.test(line));
    const hasTotalLikeLabel = RECEIPT_TOTAL_LABEL_RE.test(lineLower);

    fallbackCandidates.push(...amounts.map(amount => ({
      amount,
      blocked_as_reference: blockedAsReference,
      has_currency_keyword: hasCurrencyKeyword,
      has_total_like_label: hasTotalLikeLabel,
    })));

    if (
      totalGross === undefined &&
      !blockedAsReference &&
      hasTotalLikeLabel
    ) {
      totalGross = picked;
    }

    if (
      totalVat === undefined &&
      !blockedAsReference &&
      RECEIPT_VAT_LABEL_RE.test(lineLower)
    ) {
      totalVat = picked;
    }

    if (
      totalNet === undefined &&
      !blockedAsReference &&
      RECEIPT_NET_LABEL_RE.test(lineLower)
    ) {
      totalNet = picked;
    }
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

  if (totalNet === undefined && totalGross !== undefined && totalVat !== undefined) {
    totalNet = roundMoney(totalGross - totalVat);
  }

  if (totalVat === undefined && totalGross !== undefined && totalNet !== undefined) {
    totalVat = roundMoney(totalGross - totalNet);
  }

  return {
    total_net: totalNet,
    total_vat: totalVat,
    total_gross: totalGross,
  };
}

export function extractPdfIdentifiers(text: string): Pick<ExtractedReceiptFields, "supplier_reg_code" | "supplier_vat_no" | "supplier_iban" | "ref_number"> {
  const regCodeMatch = text.match(/(?:reg\.?\s*(?:nr|kood|code)|registrikood|registry code)[:\s]*(\d{8})/i);
  const vatMatch = text.match(/(?:KMKR|VAT|KM\s*nr)[:\s]*(EE\d+)/i);
  const ibanMatch = text.match(/\b([A-Z]{2}[0-9A-Z]{13,30})(?![0-9A-Z])/);
  const refMatch = text.match(/(?:viitenumber|viitenr|ref\.?\s*(?:nr|number)|viitenumbrit)[:\s]*(\d+)/i);

  return {
    supplier_reg_code: regCodeMatch?.[1],
    supplier_vat_no: vatMatch?.[1],
    supplier_iban: ibanMatch?.[1],
    ref_number: refMatch?.[1],
  };
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

export function normalizeCounterpartyName(name?: string | null): string {
  return name
    ?.toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(ou|oü|as|mtu|mtü|fie|uab|sia|llc|ltd|inc|gmbh|oy|ab|pank)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
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

function parseVatRateDropdown(vatRateDropdown?: string): number | undefined {
  const normalized = normalizeVatRate(vatRateDropdown);
  if (!normalized || normalized === "-") return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getAutoBookedVatConfig(
  category: TransactionClassificationCategory,
  supplierCountry?: string | null,
): Pick<PurchaseInvoiceItem, "vat_rate_dropdown" | "reversed_vat_id"> {
  if (category === "bank_fees") {
    return { vat_rate_dropdown: "-" };
  }

  if (category === "saas_subscriptions" && !isDomesticClientCountry(supplierCountry)) {
    return {
      vat_rate_dropdown: "24",
      reversed_vat_id: 1,
    };
  }

  return { vat_rate_dropdown: isDomesticClientCountry(supplierCountry) ? "24" : "-" };
}

export function getAutoBookedVatRateDropdown(
  category: TransactionClassificationCategory,
  supplierCountry?: string | null,
): string {
  return getAutoBookedVatConfig(category, supplierCountry).vat_rate_dropdown ?? "-";
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

function isCardPurchase(transaction: Pick<Transaction, "bank_subtype" | "description">): boolean {
  return /(card|kaart|pos|visa|mastercard|debit|credit)/i.test(transaction.bank_subtype ?? "") ||
    /(card|kaart|pos|terminal|visa|mastercard)/i.test(transaction.description ?? "");
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

function classifyReceiptDocument(text: string, fileName: string): ReceiptClassification {
  const combined = `${text}\n${fileName}`;
  const hasInvoiceKeywords = /\b(arve|invoice|ostuarve|bill to)\b/i.test(combined);
  const hasReceiptKeywords = /\b(receipt|kviitung|tšekk|tsekk|card slip|terminal)\b/i.test(combined);
  const hasExpenseKeywords = /\b(bolt|wolt|uber|parking|fuel|restaurant|cafe)\b/i.test(combined);

  if (hasInvoiceKeywords) {
    return "purchase_invoice";
  }

  if (hasReceiptKeywords || hasExpenseKeywords) {
    return "owner_paid_expense_reimbursement";
  }

  return "unclassifiable";
}

async function scanReceiptFolderInternal(folderPath: string, fileTypes?: FileType[], dateFrom?: string, dateTo?: string): Promise<ReceiptScanResult> {
  const resolvedFolder = await validateFolderPath(folderPath);
  const allowedExtensions = extensionsForTypes(fileTypes);
  const entries = await readdir(resolvedFolder, { withFileTypes: true });
  const files: ReceiptFileInfo[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (!allowedExtensions.includes(extension)) continue;

    const fileType = extensionToFileType(extension);
    if (!fileType) continue;

    const candidatePath = join(resolvedFolder, entry.name);

    try {
      const validatedPath = await validateFilePath(candidatePath, allowedExtensions, MAX_RECEIPT_SIZE);
      const info = await stat(validatedPath);
      const modifiedAt = info.mtime.toISOString();
      const modifiedDate = modifiedAt.slice(0, 10);

      if ((dateFrom && modifiedDate < dateFrom) || (dateTo && modifiedDate > dateTo)) {
        continue;
      }

      files.push({
        name: entry.name,
        path: validatedPath,
        extension,
        file_type: fileType,
        size_bytes: info.size,
        modified_at: modifiedAt,
      });
    } catch (error) {
      skipped.push({
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    files,
    skipped,
    folder_path: resolvedFolder,
    total_candidates: files.length,
  };
}

async function fetchRegistryData(regCode?: string, country = "EST", fallbackName?: string): Promise<Record<string, string> | null> {
  if (!regCode || country !== "EST" || !/^\d{8}$/.test(regCode)) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(
      `https://ariregister.rik.ee/est/api/autocomplete?q=${encodeURIComponent(regCode)}`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as Array<Record<string, unknown>>;
    const entry = data[0];
    if (!entry) return null;

    return {
      name: String(entry.company_name ?? entry.nimi ?? fallbackName ?? ""),
      reg_code: regCode,
      address: String(entry.address ?? entry.aadress ?? ""),
    };
  } catch {
    return null;
  }
}

async function resolveSupplierInternal(
  api: ApiContext,
  clients: Client[],
  fields: ExtractedReceiptFields,
  execute: boolean,
  options?: SupplierResolutionOptions,
): Promise<SupplierResolution> {
  if (fields.supplier_reg_code) {
    const byCode = clients.find(client => client.code === fields.supplier_reg_code && !client.is_deleted);
    if (byCode) {
      return { found: true, created: false, match_type: "registry_code", client: byCode };
    }
  }

  if (fields.supplier_vat_no) {
    const normalizedVat = fields.supplier_vat_no.replace(/\s+/g, "").toUpperCase();
    const byVat = clients.find(client =>
      !client.is_deleted &&
      client.invoice_vat_no?.replace(/\s+/g, "").toUpperCase() === normalizedVat,
    );
    if (byVat) {
      return { found: true, created: false, match_type: "vat_no", client: byVat };
    }
  }

  if (fields.supplier_name) {
    const activeClients = clients.filter(client => !client.is_deleted);
    const names = activeClients.map(client => client.name);
    if (names.length > 0) {
      const bestMatch = closest(fields.supplier_name, names);
      const matchedClient = activeClients.find(client => client.name === bestMatch);
      if (
        matchedClient &&
        (
          bestMatch.toLowerCase().includes(fields.supplier_name.toLowerCase()) ||
          fields.supplier_name.toLowerCase().includes(bestMatch.toLowerCase())
        )
      ) {
        return { found: true, created: false, match_type: "name_fuzzy", client: matchedClient };
      }
    }
  }

  const supplierCountry = getClientCountryFromIban(fields.supplier_iban) ?? "EST";
  const registryData = await fetchRegistryData(fields.supplier_reg_code, supplierCountry, fields.supplier_name);
  const clientName = registryData?.name ?? fields.supplier_name;
  if (!clientName) {
    return { found: false, created: false, registry_data: registryData };
  }

  const isPhysicalEntity =
    options?.classification_category !== "salary_payroll" &&
    !fields.supplier_reg_code &&
    !fields.supplier_vat_no &&
    looksLikePersonCounterparty(normalizeCounterpartyName(clientName), clientName);

  const previewClient: Partial<Client> = {
    name: clientName,
    code: fields.supplier_reg_code,
    is_client: false,
    is_supplier: true,
    cl_code_country: supplierCountry,
    is_juridical_entity: !isPhysicalEntity,
    is_physical_entity: isPhysicalEntity,
    is_member: false,
    send_invoice_to_email: false,
    send_invoice_to_accounting_email: false,
    invoice_vat_no: fields.supplier_vat_no,
    bank_account_no: fields.supplier_iban,
    address_text: registryData?.address,
  };

  if (!execute) {
    return {
      found: false,
      created: false,
      preview_client: previewClient,
      registry_data: registryData,
    };
  }

  const created = await api.clients.create(previewClient as Client);
  const createdId = created.created_object_id;
  const client = createdId ? await api.clients.get(createdId) : undefined;
  if (client) {
    clients.push(client);
  }

  return {
    found: false,
    created: true,
    match_type: "created",
    client,
    preview_client: previewClient,
    registry_data: registryData,
  };
}

function findAccountByKeywords(accounts: Account[], keywords: string[]): Account | undefined {
  const loweredKeywords = keywords.map(keyword => keyword.toLowerCase());
  return accounts.find(account => {
    const text = `${account.name_est} ${account.name_eng} ${account.account_type_est} ${account.account_type_eng}`.toLowerCase();
    return loweredKeywords.some(keyword => text.includes(keyword));
  });
}

function findPurchaseArticleByKeywords(
  purchaseArticles: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  keywords: string[],
): Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>[number] | undefined {
  const loweredKeywords = keywords.map(keyword => keyword.toLowerCase());
  return [...purchaseArticles]
    .filter(article => !article.is_disabled)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .find(article => {
      const text = `${article.name_est} ${article.name_eng}`.toLowerCase();
      return loweredKeywords.some(keyword => text.includes(keyword));
    });
}

function buildKeywordSuggestion(
  purchaseArticles: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
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
  } else if (/(software|subscription|hosting|cloud|openai|google|zoom|slack|github|microsoft)/i.test(normalizedHints)) {
    articleKeywords = ["software", "subscription", "sideteenus", "it", "internet"];
    accountKeywords = ["software", "subscription", "it", "internet", "sideteenus"];
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

  const article = findPurchaseArticleByKeywords(purchaseArticles, articleKeywords)
    ?? findPurchaseArticleByKeywords(purchaseArticles, ["muu", "other", "general"]);
  const account = article?.accounts_id
    ? accounts.find(candidate => candidate.id === article.accounts_id)
    : findAccountByKeywords(accounts, accountKeywords)
      ?? findAccountByKeywords(accounts, ["muu", "general", "kulud"]);

  if (!article) return undefined;

  return {
    source: article === findPurchaseArticleByKeywords(purchaseArticles, ["muu", "other", "general"]) ? "fallback" : "keyword_match",
    suggested_account: account,
    suggested_purchase_article: { id: article.id, name: article.name_est || article.name_eng },
    item: {
      cl_purchase_articles_id: article.id,
      purchase_accounts_id: account?.id ?? article.accounts_id,
      custom_title: "Receipt expense",
      amount: 1,
    },
  };
}

async function suggestBookingInternal(
  api: ApiContext,
  context: ReceiptProcessingContext,
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

function scoreTransactionToInvoice(tx: Transaction, invoice: InvoiceSummaryForMatching): { confidence: number; reasons: string[] } {
  let confidence = 0;
  const reasons: string[] = [];
  const invoiceAmount = invoice.gross_price ?? 0;
  const txAmount = tx.amount;

  if (Math.abs(txAmount - invoiceAmount) < 0.01) {
    confidence += 50;
    reasons.push("exact_amount");
  } else if (Math.abs((tx.base_amount ?? txAmount) - (invoice.base_gross_price ?? invoiceAmount)) < 0.01) {
    confidence += 50;
    reasons.push("exact_base_amount");
  } else if (Math.abs(txAmount - invoiceAmount) <= 1) {
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

function findBestTransactionMatch(
  transactions: Transaction[],
  invoice: InvoiceSummaryForMatching,
  consumedTransactionIds: Set<number>,
): TransactionMatchCandidate | undefined {
  const candidates = transactions
    .filter(transaction => transaction.id !== undefined && !consumedTransactionIds.has(transaction.id))
    .map(transaction => {
      const { confidence, reasons } = scoreTransactionToInvoice(transaction, invoice);
      return {
        transaction_id: transaction.id!,
        amount: transaction.amount,
        date: transaction.date,
        bank_account_name: transaction.bank_account_name,
        description: transaction.description,
        confidence,
        reasons,
      };
    })
    .filter(candidate => candidate.confidence >= POSSIBLE_MATCH_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);

  return candidates[0];
}

function findDuplicateInvoice(
  invoices: PurchaseInvoice[],
  clientsId: number,
  invoiceNumber: string,
  createDate: string,
  grossPrice: number,
): InvoiceDuplicateMatch | undefined {
  const normalizedNumber = invoiceNumber.trim().toLowerCase();

  const sameNumber = invoices.find(invoice =>
    invoice.clients_id === clientsId &&
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.number.trim().toLowerCase() === normalizedNumber
  );
  if (sameNumber?.id) {
    return {
      reason: "supplier_invoice_number",
      invoice_id: sameNumber.id,
      invoice_number: sameNumber.number,
      create_date: sameNumber.create_date,
      gross_price: sameNumber.gross_price,
    };
  }

  const sameAmountDate = invoices.find(invoice =>
    invoice.clients_id === clientsId &&
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.create_date === createDate &&
    Math.abs((invoice.gross_price ?? 0) - grossPrice) < 0.01
  );
  if (sameAmountDate?.id) {
    return {
      reason: "supplier_amount_date",
      invoice_id: sameAmountDate.id,
      invoice_number: sameAmountDate.number,
      create_date: sameAmountDate.create_date,
      gross_price: sameAmountDate.gross_price,
    };
  }

  return undefined;
}

function buildSyntheticItem(
  suggestion: BookingSuggestion,
  description: string,
  amount: number,
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  isVatRegistered: boolean,
  vatRateDropdown?: string,
): PurchaseInvoiceItem {
  return applyPurchaseVatDefaults(
    purchaseArticlesWithVat,
    {
      ...suggestion.item,
      total_net_price: amount,
      custom_title: description,
      vat_rate_dropdown: vatRateDropdown ?? suggestion.item.vat_rate_dropdown ?? "-",
    },
    isVatRegistered,
  );
}

function shouldProcessExpenseAsPurchaseInvoice(classification: TransactionClassificationCategory): boolean {
  return classification === "saas_subscriptions" ||
    classification === "bank_fees" ||
    classification === "card_purchases";
}

function buildOwnerCounterpartySet(clients: Client[]): Set<string> {
  const owners = clients.filter(client =>
    !client.is_deleted &&
    client.is_physical_entity &&
    (client.is_related_party || client.is_associate_company || client.is_parent_company_group)
  );
  return new Set(owners.map(client => normalizeCounterpartyName(client.name)).filter(Boolean));
}

function groupTransactionsByCounterparty(transactions: Transaction[]): TransactionGroup[] {
  const groups = new Map<string, TransactionGroup>();

  for (const transaction of transactions) {
    const displayCounterparty = transaction.bank_account_name?.trim() ||
      transaction.description?.trim() ||
      "Unknown";
    const normalizedCounterparty = normalizeCounterpartyName(displayCounterparty) || `transaction-${transaction.id ?? displayCounterparty}`;
    const group = groups.get(normalizedCounterparty);
    if (group) {
      group.transactions.push(transaction);
    } else {
      groups.set(normalizedCounterparty, {
        normalized_counterparty: normalizedCounterparty,
        display_counterparty: displayCounterparty,
        transactions: [transaction],
      });
    }
  }

  return [...groups.values()].sort((a, b) => a.display_counterparty.localeCompare(b.display_counterparty));
}

function buildClassificationSuggestion(
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  accounts: Account[],
  category: TransactionClassificationCategory,
  normalizedCounterparty: string,
): ClassifiedTransactionSuggestion {
  let articleKeywords = ["muu", "other", "general"];
  let accountKeywords = ["muu", "general", "kulud"];
  let reason = "Fallback booking suggestion from generic expense keywords.";

  if (category === "saas_subscriptions") {
    articleKeywords = ["software", "subscription", "internet", "it", "sideteenus"];
    accountKeywords = ["software", "subscription", "internet", "it", "sideteenus"];
    reason = "Recurring similar payments to the same counterparty suggest a subscription or SaaS vendor.";
  } else if (category === "bank_fees") {
    articleKeywords = ["bank", "fee", "teenus"];
    accountKeywords = ["bank", "fee", "teenus"];
    reason = "Counterparty and description patterns match bank service fees.";
  } else if (category === "tax_payments") {
    articleKeywords = ["maks", "tax"];
    accountKeywords = ["maks", "tax"];
    reason = "Counterparty matches EMTA / Maksu- ja Tolliamet.";
  } else if (category === "salary_payroll") {
    articleKeywords = ["salary", "palk", "payroll"];
    accountKeywords = ["salary", "palk", "payroll"];
    reason = "Recurring transfers to a person-like counterparty look like payroll.";
  } else if (category === "owner_transfers") {
    articleKeywords = ["owner", "laen", "shareholder"];
    accountKeywords = ["owner", "shareholder", "loan", "laen"];
    reason = "Counterparty matches a known owner or related physical person.";
  } else if (category === "card_purchases") {
    if (/(bolt|uber)/i.test(normalizedCounterparty)) {
      articleKeywords = ["transport", "sõidu", "auto"];
      accountKeywords = ["transport", "sõidu", "auto"];
      reason = "Bolt/Uber patterns usually map to travel or transport expenses.";
    } else if (/(wolt)/i.test(normalizedCounterparty)) {
      articleKeywords = ["food", "toit", "representation", "esindus"];
      accountKeywords = ["food", "toit", "representation", "esindus"];
      reason = "Wolt-like payments usually map to food or representation expenses.";
    } else {
      articleKeywords = ["office", "kontor", "general", "muu"];
      accountKeywords = ["office", "kontor", "general", "muu"];
      reason = "Card purchase with no invoice match; suggested booking uses broad operating expense defaults.";
    }
  } else if (category === "revenue_without_invoice") {
    articleKeywords = ["sale", "revenue", "income"];
    accountKeywords = ["sale", "revenue", "income"];
    reason = "Incoming payment without a sale invoice needs manual sales-side follow-up.";
  }

  const article = findPurchaseArticleByKeywords(purchaseArticlesWithVat, articleKeywords)
    ?? findPurchaseArticleByKeywords(purchaseArticlesWithVat, ["muu", "other", "general"]);
  const account = article?.accounts_id
    ? accounts.find(candidate => candidate.id === article.accounts_id)
    : findAccountByKeywords(accounts, accountKeywords);

  return {
    purchase_article_id: article?.id,
    purchase_article_name: article?.name_est ?? article?.name_eng,
    purchase_account_id: account?.id ?? article?.accounts_id,
    purchase_account_name: account ? `${account.id} ${account.name_est}` : undefined,
    liability_account_id: DEFAULT_LIABILITY_ACCOUNT,
    reason,
  };
}

async function extractReceiptFields(file: ReceiptFileInfo): Promise<ExtractedReceiptFields> {
  if (file.file_type !== "pdf") {
    return {
      description: `Image receipt ${file.name}`,
    };
  }

  const buffer = await readFile(file.path);
  const pdfData = await pdf(buffer);
  const text = pdfData.text;
  const identifiers = extractPdfIdentifiers(text);
  const { invoice_date, due_date } = extractDates(text);
  const supplierName = extractSupplierName(text, file.name);
  const amounts = extractAmounts(text);
  const currency = detectReceiptCurrency(text);

  return {
    ...identifiers,
    ...amounts,
    currency,
    supplier_name: supplierName,
    invoice_number: extractInvoiceNumber(text, file.name),
    invoice_date,
    due_date,
    description: extractDescription(text, supplierName),
    raw_text: text,
  };
}

async function createAndMaybeMatchPurchaseInvoice(
  api: ApiContext,
  context: ReceiptProcessingContext,
  file: ReceiptFileInfo,
  extracted: ExtractedReceiptFields,
  supplierResolution: SupplierResolution,
  bookingSuggestion: BookingSuggestion,
  bankTransactions: Transaction[],
  execute: boolean,
  consumedTransactionIds: Set<number>,
): Promise<Pick<ReceiptBatchFileResult, "created_invoice" | "bank_match" | "notes" | "status">> {
  const notes: string[] = [];
  const supplier = supplierResolution.client;
  const supplierId = supplier?.id;
  const supplierName = supplier?.name ?? supplierResolution.preview_client?.name;
  const invoiceCurrency = extracted.currency ?? "EUR";
  const invoiceNotes = extracted.currency && extracted.currency !== "EUR" && extracted.total_gross !== undefined
    ? `Receipt inbox import from ${file.name} | Original receipt amount: ${roundMoney(extracted.total_gross).toFixed(2)} ${extracted.currency}`
    : `Receipt inbox import from ${file.name}`;

  if (!supplierName) {
    notes.push("Supplier resolution did not return a concrete client ID.");
    return { notes, status: "needs_review" };
  }

  const itemNetAmount = extracted.total_net
    ?? (extracted.total_gross !== undefined && extracted.total_vat !== undefined
      ? roundMoney(extracted.total_gross - extracted.total_vat)
      : undefined);
  if (itemNetAmount === undefined || extracted.total_gross === undefined) {
    notes.push("Could not derive reliable net/gross totals for invoice creation.");
    return { notes, status: "needs_review" };
  }

  const item = buildSyntheticItem(
    bookingSuggestion,
    extracted.description ?? `Expense from ${supplierName}`,
    itemNetAmount,
    context.purchaseArticlesWithVat,
    context.isVatRegistered,
    extracted.total_vat === 0 ? "-" : extracted.total_vat !== undefined ? bookingSuggestion.item.vat_rate_dropdown : "-",
  );

  const invoiceDraft: InvoiceSummaryForMatching = {
    clients_id: supplierId,
    client_name: supplierName,
    number: extracted.invoice_number,
    create_date: extracted.invoice_date,
    gross_price: extracted.total_gross,
    bank_ref_number: extracted.ref_number,
  };

  const candidate = findBestTransactionMatch(bankTransactions, invoiceDraft, consumedTransactionIds);
  const canAutoLink = candidate !== undefined && candidate.confidence >= EXACT_MATCH_THRESHOLD;

  if (invoiceCurrency !== "EUR") {
    notes.push(`Detected non-EUR receipt currency ${invoiceCurrency}; invoice will use the source currency amount.`);
  }

  if (!execute) {
    if (candidate) {
      notes.push(`Dry run: matched candidate transaction ${candidate.transaction_id} at confidence ${candidate.confidence}.`);
    }
    return {
      notes,
      status: "dry_run_preview",
      created_invoice: {
        number: extracted.invoice_number!,
        confirmed: true,
        uploaded_document: file.file_type === "pdf",
      },
      bank_match: candidate ? { candidate, linked: false } : undefined,
    };
  }

  if (!supplierId || !supplier) {
    notes.push("Supplier resolution did not return a concrete client ID.");
    return { notes, status: "needs_review" };
  }

  const createdInvoice = await api.purchaseInvoices.createAndSetTotals(
    {
      clients_id: supplierId,
      client_name: supplier.name,
      number: extracted.invoice_number!,
      create_date: extracted.invoice_date!,
      journal_date: extracted.invoice_date!,
      term_days: computeTermDays(extracted.invoice_date, extracted.due_date),
      cl_currencies_id: invoiceCurrency,
      liability_accounts_id: DEFAULT_LIABILITY_ACCOUNT,
      bank_ref_number: extracted.ref_number,
      bank_account_no: extracted.supplier_iban,
      notes: invoiceNotes,
      items: [item],
    },
    extracted.total_vat,
    extracted.total_gross,
    context.isVatRegistered,
  );

  let uploadedDocument = false;
  if (file.file_type === "pdf" && createdInvoice.id) {
    const contents = (await readFile(file.path)).toString("base64");
    await api.purchaseInvoices.uploadDocument(createdInvoice.id, file.name, contents);
    uploadedDocument = true;
    notes.push("Uploaded source PDF to created purchase invoice.");
  }

  if (createdInvoice.id) {
    await api.purchaseInvoices.confirmWithTotals(createdInvoice.id, context.isVatRegistered, {
      preserveExistingTotals: true,
    });
    notes.push("Confirmed created purchase invoice for booking and bank matching.");
  }

  let linked = false;
  if (createdInvoice.id && candidate && canAutoLink) {
    await api.transactions.confirm(candidate.transaction_id, [{
      related_table: "purchase_invoices",
      related_id: createdInvoice.id,
      amount: candidate.amount,
    }]);
    consumedTransactionIds.add(candidate.transaction_id);
    linked = true;
    notes.push(`Linked transaction ${candidate.transaction_id} to purchase invoice ${createdInvoice.id}.`);
  } else if (candidate) {
    notes.push(`Found transaction candidate ${candidate.transaction_id}, but confidence ${candidate.confidence} was below auto-link threshold ${EXACT_MATCH_THRESHOLD}.`);
  }

  context.purchaseInvoices.push(createdInvoice);

  return {
    notes,
    status: linked ? "matched" : "created",
    created_invoice: {
      id: createdInvoice.id,
      number: createdInvoice.number,
      status: createdInvoice.status,
      confirmed: true,
      uploaded_document: uploadedDocument,
    },
    bank_match: candidate ? {
      candidate,
      linked,
      confirmed_transaction_id: linked ? candidate.transaction_id : undefined,
    } : undefined,
  };
}

function existingInvoiceMatch(tx: Transaction, openSales: SaleInvoice[], openPurchases: PurchaseInvoice[]): boolean {
  if (tx.type !== "D" && tx.type !== "C") return false;
  const invoices = tx.type === "D" ? openSales : openPurchases;
  for (const invoice of invoices) {
    const { confidence } = scoreTransactionToInvoice(tx, invoice);
    if (confidence >= POSSIBLE_MATCH_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function toClassifiedResult(
  group: TransactionGroup,
  classification: TransactionGroupClassification,
  suggestion: ClassifiedTransactionSuggestion,
): ClassifiedTransactionGroupResult {
  return {
    category: classification.category,
    apply_mode: classification.apply_mode,
    normalized_counterparty: group.normalized_counterparty,
    display_counterparty: group.display_counterparty,
    recurring: classification.recurring,
    similar_amounts: classification.similar_amounts,
    total_amount: roundMoney(group.transactions.reduce((sum, transaction) => sum + transaction.amount, 0)),
    suggested_booking: suggestion,
    reasons: classification.reasons,
    transactions: group.transactions.map(transaction => ({
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      date: transaction.date,
      description: transaction.description,
      bank_account_name: transaction.bank_account_name,
      bank_subtype: transaction.bank_subtype,
      accounts_dimensions_id: transaction.accounts_dimensions_id,
      clients_id: transaction.clients_id,
    })),
  };
}

async function resolveSupplierFromTransaction(
  api: ApiContext,
  clients: Client[],
  transaction: Transaction,
  execute: boolean,
  classificationCategory?: TransactionClassificationCategory,
): Promise<SupplierResolution> {
  if (transaction.clients_id) {
    const existingClient = clients.find(client => client.id === transaction.clients_id && !client.is_deleted);
    if (existingClient) {
      return {
        found: true,
        created: false,
        match_type: "registry_code",
        client: existingClient,
      };
    }
  }

  return resolveSupplierInternal(api, clients, {
    supplier_name: transaction.bank_account_name ?? transaction.description ?? `Transaction ${transaction.id ?? ""}`.trim(),
    supplier_iban: transaction.bank_account_no ?? undefined,
  }, execute, {
    classification_category: classificationCategory,
  });
}

function extractClassificationGroups(payload: unknown): ClassifiedTransactionGroupResult[] {
  if (Array.isArray(payload)) {
    return payload as ClassifiedTransactionGroupResult[];
  }
  if (payload && typeof payload === "object" && "groups" in payload && Array.isArray((payload as { groups?: unknown[] }).groups)) {
    return (payload as { groups: ClassifiedTransactionGroupResult[] }).groups;
  }
  throw new Error("classifications_json must be a JSON array of groups or an object with a groups array");
}

export function registerReceiptInboxTools(server: McpServer, api: ApiContext): void {
  registerTool(server, 
    "scan_receipt_folder",
    "Scan a folder for supported receipt files (PDF, JPG, PNG) without recursing into subfolders. Returns valid file metadata and skipped entries.",
    {
      folder_path: z.string().describe("Folder path to scan"),
      file_types: z.array(z.enum(["pdf", "jpg", "png"])).optional().describe("Optional file type filter"),
    },
    { ...readOnly, openWorldHint: true, title: "Scan Receipt Folder" },
    async ({ folder_path, file_types }) => {
      const result = await scanReceiptFolderInternal(folder_path, file_types);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  registerTool(server, 
    "process_receipt_batch",
    "Process receipt PDFs and images from a folder. DRY RUN by default. Purchase-invoice PDFs can be created, confirmed, and matched to bank transactions when execute=true.",
    {
      folder_path: z.string().describe("Folder path with receipts"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID used when matching bank transactions"),
      execute: z.boolean().optional().describe("Actually create and book invoices (default false = dry run)"),
      date_from: z.string().optional().describe("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
    },
    { ...batch, openWorldHint: true, title: "Process Receipt Batch" },
    async ({ folder_path, accounts_dimensions_id, execute, date_from, date_to }) => {
      const dryRun = execute !== true;
      const scan = await scanReceiptFolderInternal(folder_path, undefined, date_from, date_to);
      const context: ReceiptProcessingContext = {
        clients: await api.clients.listAll(),
        purchaseInvoices: await api.purchaseInvoices.listAll(),
        purchaseArticlesWithVat: await getPurchaseArticlesWithVat(api),
        accounts: await api.readonly.getAccounts(),
        isVatRegistered: await isCompanyVatRegistered(api),
      };
      const allTransactions = await api.transactions.listAll();
      const bankTransactions = allTransactions.filter(transaction =>
        transaction.accounts_dimensions_id === accounts_dimensions_id &&
        transaction.status !== "CONFIRMED" &&
        !transaction.is_deleted &&
        transaction.type === "C" &&
        (!date_from || transaction.date >= date_from) &&
        (!date_to || transaction.date <= date_to),
      );
      const consumedTransactionIds = new Set<number>();
      const results: ReceiptBatchFileResult[] = [];

      for (let index = 0; index < scan.files.length; index++) {
        const file = scan.files[index]!;
        await reportProgress(index, scan.files.length);
        const notes: string[] = [];

        try {
          const extracted = await extractReceiptFields(file);
          const classification = file.file_type === "pdf"
            ? classifyReceiptDocument(extracted.raw_text ?? "", file.name)
            : classifyReceiptDocument(file.name, file.name);

          if (file.file_type !== "pdf") {
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              notes: [
                "Image receipt detected. OCR is not available in this server, so only filename and metadata were used.",
                classification === "owner_paid_expense_reimbursement"
                  ? "Likely owner-paid receipt. Review manually and use create_owner_expense_reimbursement if appropriate."
                  : "Could not safely auto-book image without OCR.",
              ],
            });
            continue;
          }

          if (classification !== "purchase_invoice") {
            notes.push(
              classification === "owner_paid_expense_reimbursement"
                ? "PDF looks like an owner-paid expense receipt. Review manually before booking."
                : "Document could not be classified as a supplier purchase invoice.",
            );
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              notes,
            });
            continue;
          }

          if (!extracted.supplier_name || !extracted.invoice_date || extracted.total_gross === undefined) {
            notes.push("Missing supplier name, invoice date, or gross total required for auto-booking.");
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              notes,
            });
            continue;
          }

          const supplierResolution = await resolveSupplierInternal(api, context.clients, extracted, !dryRun);
          if (!supplierResolution.client && !supplierResolution.preview_client) {
            notes.push("Supplier could not be resolved or prepared for creation.");
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              supplier_resolution: supplierResolution,
              notes,
            });
            continue;
          }

          const resolvedClientId = supplierResolution.client?.id;
          if (!resolvedClientId && dryRun) {
            notes.push("Dry run: supplier would need to be created before invoice creation.");
          }

          const bookingSuggestion = resolvedClientId
            ? await suggestBookingInternal(api, context, resolvedClientId, extracted.description ?? extracted.supplier_name)
            : buildKeywordSuggestion(
              context.purchaseArticlesWithVat,
              context.accounts,
              `${extracted.description ?? ""} ${extracted.supplier_name ?? ""}`,
            );

          if (!bookingSuggestion) {
            notes.push("Could not find a purchase article / account suggestion for this receipt.");
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              supplier_resolution: supplierResolution,
              notes,
            });
            continue;
          }

          if (resolvedClientId && extracted.invoice_number && extracted.invoice_date && extracted.total_gross !== undefined) {
            const duplicate = findDuplicateInvoice(
              context.purchaseInvoices,
              resolvedClientId,
              extracted.invoice_number,
              extracted.invoice_date,
              extracted.total_gross,
            );
            if (duplicate) {
              results.push({
                file,
                classification,
                status: "skipped_duplicate",
                extracted,
                supplier_resolution: supplierResolution,
                booking_suggestion: bookingSuggestion,
                duplicate_match: duplicate,
                notes: [`Skipped duplicate by ${duplicate.reason}.`],
              });
              continue;
            }
          }

          const created = await createAndMaybeMatchPurchaseInvoice(
            api,
            context,
            file,
            extracted,
            supplierResolution,
            bookingSuggestion,
            bankTransactions,
            !dryRun,
            consumedTransactionIds,
          );

          results.push({
            file,
            classification,
            status: created.status,
            extracted,
            supplier_resolution: supplierResolution,
            booking_suggestion: bookingSuggestion,
            created_invoice: created.created_invoice,
            bank_match: created.bank_match,
            notes: created.notes,
          });
        } catch (error) {
          results.push({
            file,
            classification: "unclassifiable",
            status: "failed",
            notes,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const summary = {
        dry_run: dryRun,
        scanned_files: scan.files.length,
        skipped_invalid_files: scan.skipped.length,
        created: results.filter(result => result.status === "created").length,
        matched: results.filter(result => result.status === "matched").length,
        skipped_duplicate: results.filter(result => result.status === "skipped_duplicate").length,
        failed: results.filter(result => result.status === "failed").length,
        needs_review: results.filter(result => result.status === "needs_review").length,
        dry_run_preview: results.filter(result => result.status === "dry_run_preview").length,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            folder_path: scan.folder_path,
            accounts_dimensions_id,
            summary,
            skipped: scan.skipped,
            results,
          }, null, 2),
        }],
      };
    },
  );

  registerTool(server, 
    "classify_unmatched_transactions",
    "Classify unconfirmed bank transactions that do not match any sale or purchase invoice. Read-only analysis with suggested booking defaults.",
    {
      accounts_dimensions_id: z.number().describe("Bank account dimension ID"),
      date_from: z.string().optional().describe("Optional lower transaction date bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional upper transaction date bound (YYYY-MM-DD)"),
    },
    { ...readOnly, title: "Classify Unmatched Transactions" },
    async ({ accounts_dimensions_id, date_from, date_to }) => {
      const [transactions, saleInvoices, purchaseInvoices, clients, purchaseArticlesWithVat, accounts] = await Promise.all([
        api.transactions.listAll(),
        api.saleInvoices.listAll(),
        api.purchaseInvoices.listAll(),
        api.clients.listAll(),
        getPurchaseArticlesWithVat(api),
        api.readonly.getAccounts(),
      ]);

      const openSales = saleInvoices.filter(invoice =>
        invoice.status === "CONFIRMED" && invoice.payment_status !== "PAID",
      );
      const openPurchases = purchaseInvoices.filter(invoice =>
        invoice.status === "CONFIRMED" && invoice.payment_status !== "PAID",
      );
      const ownerCounterparties = buildOwnerCounterpartySet(clients);

      const unconfirmed = transactions.filter(transaction =>
        transaction.accounts_dimensions_id === accounts_dimensions_id &&
        transaction.status !== "CONFIRMED" &&
        !transaction.is_deleted &&
        (!date_from || transaction.date >= date_from) &&
        (!date_to || transaction.date <= date_to),
      );

      const unmatched = unconfirmed.filter(transaction => !existingInvoiceMatch(transaction, openSales, openPurchases));
      const groups = groupTransactionsByCounterparty(unmatched);
      const classifiedGroups = groups.map(group => {
        const classification = categorizeTransactionGroup({
          normalized_counterparty: group.normalized_counterparty,
          display_counterparty: group.display_counterparty,
          transactions: group.transactions,
          owner_counterparties: ownerCounterparties,
        });
        const suggestion = buildClassificationSuggestion(
          purchaseArticlesWithVat,
          accounts,
          classification.category,
          group.normalized_counterparty,
        );
        return toClassifiedResult(group, classification, suggestion);
      });

      const categoryCounts = classifiedGroups.reduce<Record<string, number>>((counts, group) => {
        counts[group.category] = (counts[group.category] ?? 0) + group.transactions.length;
        return counts;
      }, {});

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            schema_version: 1,
            accounts_dimensions_id,
            period: {
              from: date_from ?? "all",
              to: date_to ?? "all",
            },
            total_unconfirmed: unconfirmed.length,
            total_unmatched: unmatched.length,
            category_counts: categoryCounts,
            groups: classifiedGroups,
          }, null, 2),
        }],
      };
    },
  );

  registerTool(server, 
    "apply_transaction_classifications",
    "Apply the output of classify_unmatched_transactions. DRY RUN by default. Only expense-like categories are auto-booked as purchase invoices; review-only categories are reported back.",
    {
      classifications_json: z.string().describe("JSON from classify_unmatched_transactions"),
      execute: z.boolean().optional().describe("Actually create invoices and link transactions (default false = dry run)"),
    },
    { ...batch, title: "Apply Transaction Classifications" },
    async ({ classifications_json, execute }) => {
      const dryRun = execute !== true;
      const parsed = safeJsonParse(classifications_json, "classifications_json");
      const groups = extractClassificationGroups(parsed);

      const [clients, purchaseArticlesWithVat] = await Promise.all([
        api.clients.listAll(),
        getPurchaseArticlesWithVat(api),
      ]);
      const isVatRegistered = await isCompanyVatRegistered(api);
      const results: Array<{
        category: TransactionClassificationCategory;
        counterparty: string;
        status: "applied" | "skipped" | "dry_run_preview" | "failed";
        notes: string[];
        transactions: number[];
        created_invoice_ids?: number[];
        linked_transaction_ids?: number[];
      }> = [];

      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]!;
        await reportProgress(index, groups.length);
        const notes: string[] = [];
        const transactionIds = group.transactions.map(transaction => transaction.id).filter((id): id is number => id !== undefined);

        try {
          const freshTransactions: Transaction[] = [];
          for (const transactionStub of group.transactions) {
            if (!transactionStub.id) {
              notes.push("Skipped a transaction without ID.");
              continue;
            }

            try {
              const transaction = await api.transactions.get(transactionStub.id);
              if (transaction.is_deleted) {
                notes.push(`Transaction ${transactionStub.id} was deleted since classification; skipped.`);
                continue;
              }
              if (transaction.status === "CONFIRMED") {
                notes.push(`Transaction ${transactionStub.id} was confirmed since classification; skipped.`);
                continue;
              }
              freshTransactions.push(transaction);
            } catch {
              notes.push(`Transaction ${transactionStub.id} no longer exists.`);
            }
          }

          if (freshTransactions.length === 0) {
            notes.push("No unconfirmed transactions remain in this classification group.");
            results.push({
              category: group.category,
              counterparty: group.display_counterparty,
              status: "skipped",
              notes,
              transactions: transactionIds,
            });
            continue;
          }

          if (group.apply_mode !== "purchase_invoice" || !shouldProcessExpenseAsPurchaseInvoice(group.category)) {
            notes.push(`Category ${group.category} is review-only and is not auto-booked as a purchase invoice.`);
            results.push({
              category: group.category,
              counterparty: group.display_counterparty,
              status: "skipped",
              notes,
              transactions: transactionIds,
            });
            continue;
          }

          if (!group.suggested_booking.purchase_article_id) {
            notes.push("Missing suggested purchase article ID. Re-run classification after maintaining purchase articles.");
            results.push({
              category: group.category,
              counterparty: group.display_counterparty,
              status: "skipped",
              notes,
              transactions: transactionIds,
            });
            continue;
          }

          const createdInvoiceIds: number[] = [];
          const linkedTransactionIds: number[] = [];

          for (const transaction of freshTransactions) {
            const supplierResolution = await resolveSupplierFromTransaction(api, clients, transaction, !dryRun, group.category);
            const supplier = supplierResolution.client;
            const supplierId = supplier?.id;
            const supplierMetadata = supplierResolution.client ?? supplierResolution.preview_client;
            const grossAmount = roundMoney(Math.abs(transaction.amount));
            if (!supplier?.id && dryRun) {
              notes.push(`Dry run: transaction ${transaction.id} would require creating a supplier for ${group.display_counterparty}.`);
            }
            if (!supplier?.id && !dryRun) {
              notes.push(`Transaction ${transaction.id} could not resolve a supplier client.`);
              continue;
            }

            const article = purchaseArticlesWithVat.find(item => item.id === group.suggested_booking.purchase_article_id);
            const vatConfig = getAutoBookedVatConfig(group.category, supplierMetadata?.cl_code_country);
            const netAmount = deriveAutoBookedNetAmount(grossAmount, vatConfig);
            const purchaseItem = applyPurchaseVatDefaults(
              purchaseArticlesWithVat,
              {
                cl_purchase_articles_id: group.suggested_booking.purchase_article_id,
                purchase_accounts_id: group.suggested_booking.purchase_account_id ?? article?.accounts_id,
                custom_title: transaction.description ?? `Auto-booked ${group.category}`,
                unit_net_price: netAmount,
                total_net_price: netAmount,
                amount: 1,
                ...vatConfig,
              },
              isVatRegistered,
            );

            if (dryRun) {
              notes.push(`Dry run: would create purchase invoice for transaction ${transaction.id}.`);
              continue;
            }

            if (!supplier || !supplierId) {
              notes.push(`Transaction ${transaction.id} could not resolve a supplier client.`);
              continue;
            }

            const invoice = await api.purchaseInvoices.createAndSetTotals(
              {
                clients_id: supplierId,
                client_name: supplier.name,
                number: `AUTO-TX-${transaction.id}`,
                create_date: transaction.date,
                journal_date: transaction.date,
                term_days: 0,
                cl_currencies_id: transaction.cl_currencies_id ?? "EUR",
                liability_accounts_id: group.suggested_booking.liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
                notes: `Auto-created from classified bank transaction ${transaction.id}`,
                items: [purchaseItem],
              },
              deriveAutoBookedVatPrice(grossAmount, vatConfig),
              grossAmount,
              isVatRegistered,
            );

            if (invoice.id) {
              await api.purchaseInvoices.confirmWithTotals(invoice.id, isVatRegistered, {
                preserveExistingTotals: true,
              });
              await api.transactions.confirm(transaction.id!, [{
                related_table: "purchase_invoices",
                related_id: invoice.id,
                amount: transaction.amount,
              }]);
              createdInvoiceIds.push(invoice.id);
              linkedTransactionIds.push(transaction.id!);
            }
          }

          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status: dryRun ? "dry_run_preview" : "applied",
            notes,
            transactions: transactionIds,
            created_invoice_ids: dryRun ? undefined : createdInvoiceIds,
            linked_transaction_ids: dryRun ? undefined : linkedTransactionIds,
          });
        } catch (error) {
          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status: "failed",
            notes: [error instanceof Error ? error.message : String(error)],
            transactions: transactionIds,
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dry_run: dryRun,
            summary: {
              applied: results.filter(result => result.status === "applied").length,
              skipped: results.filter(result => result.status === "skipped").length,
              dry_run_preview: results.filter(result => result.status === "dry_run_preview").length,
              failed: results.filter(result => result.status === "failed").length,
            },
            results,
          }, null, 2),
        }],
      };
    },
  );
}
