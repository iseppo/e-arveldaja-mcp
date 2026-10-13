import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PurchaseArticle, PurchaseInvoiceItem } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { log } from "../logger.js";
import { DEFAULT_VAT_ACCOUNT } from "../accounting-defaults.js";
import { validateItemDimensions } from "../account-validation.js";
import { toolError } from "../tool-error.js";

const VAT_REGISTERED_FALLBACK = {
  vat_accounts_id: DEFAULT_VAT_ACCOUNT,
  cl_vat_articles_id: 1,
} as const;

const warnedFallbackKeys = new Set<string>();
let connectionScope = "";

/** Clear the fallback-warning dedup set for the previous scope and set the new connection scope. Call on connection switch. */
export function clearVatWarnings(scope?: string): void {
  const oldScope = connectionScope;
  if (scope !== undefined) connectionScope = scope;
  // Only clear keys for the old scope to preserve warnings from other connections
  for (const key of warnedFallbackKeys) {
    if (key.startsWith(`${oldScope}:`)) warnedFallbackKeys.delete(key);
  }
}

export function clearAllVatWarnings(): void {
  warnedFallbackKeys.clear();
}

type PurchaseArticleWithVat = PurchaseArticle & {
  vat_accounts_id?: number | null;
  cl_vat_articles_id?: number | null;
  vat_rate_dropdown?: string | null;
  vat_rate?: number | null;
};

interface PurchaseVatDefaults {
  vat_accounts_id?: number;
  cl_vat_articles_id?: number;
}

function warnFallbackOnce(key: string, message: string): void {
  const scopedKey = `${connectionScope}:${key}`;
  if (warnedFallbackKeys.has(scopedKey)) return;
  warnedFallbackKeys.add(scopedKey);
  log("warning", `WARNING: ${message}`);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeVatRate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "-") return "-";

  const normalized = trimmed.replace(/,/g, ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return trimmed;
  return String(parsed);
}

export function validateNonVatItem(item: PurchaseInvoiceItem): string[] {
  const errors: string[] = [];
  const vatRateDropdown = normalizeVatRate(item.vat_rate_dropdown);

  if (item.vat_accounts_id !== undefined && item.vat_accounts_id !== null) {
    errors.push("vat_accounts_id must be absent");
  }
  if (item.vat_accounts_dimensions_id !== undefined && item.vat_accounts_dimensions_id !== null) {
    errors.push("vat_accounts_dimensions_id must be absent");
  }
  if (item.cl_vat_articles_id !== undefined && item.cl_vat_articles_id !== null && item.cl_vat_articles_id !== 11) {
    errors.push("cl_vat_articles_id must be absent or 11");
  }
  if (vatRateDropdown !== undefined && vatRateDropdown !== "-") {
    errors.push('vat_rate_dropdown must be absent or "-"');
  }

  return errors;
}

/** `validateNonVatItem` over a whole item list, each error prefixed `items[<index>].`. */
export function collectNonVatItemErrors(items: PurchaseInvoiceItem[]): string[] {
  return items.flatMap((item, index) => validateNonVatItem(item).map(error => `items[${index}].${error}`));
}

/**
 * MCP refusal for a non-VAT company whose items carry deductible VAT fields
 * (applyPurchaseVatDefaults would otherwise silently strip them). Returns
 * undefined when the company is VAT-registered or the items are clean.
 */
export function refuseNonVatItemsWithVatFields(isVatRegistered: boolean, items: PurchaseInvoiceItem[]): CallToolResult | undefined {
  if (isVatRegistered) return undefined;
  const details = collectNonVatItemErrors(items);
  if (details.length === 0) return undefined;
  return toolError({
    error: "Non-VAT purchase invoice contains deductible VAT fields",
    category: "manual_review_required",
    details,
    next_action: "Remove deductible VAT fields or use article 11 and rate \"-\", then review and retry.",
  });
}

function extractVatDefaults(article?: PurchaseArticleWithVat): PurchaseVatDefaults {
  return {
    vat_accounts_id: toNumber(article?.vat_accounts_id),
    cl_vat_articles_id: toNumber(article?.cl_vat_articles_id),
  };
}

function matchesRate(article: PurchaseArticleWithVat, vatRateDropdown?: string): boolean {
  if (!vatRateDropdown) return false;
  const articleRate = normalizeVatRate(article.vat_rate_dropdown ?? article.vat_rate);
  return articleRate === vatRateDropdown;
}

function getArticleSearchText(article: PurchaseArticleWithVat): string {
  return `${article.name_est} ${article.name_eng}`.toLowerCase();
}

function findArticleDefaults(
  articles: PurchaseArticleWithVat[],
  item: PurchaseInvoiceItem,
  vatRateDropdown: string | undefined,
): PurchaseVatDefaults {
  const selectedArticle = item.cl_purchase_articles_id !== undefined
    ? articles.find(article => article.id === item.cl_purchase_articles_id)
    : undefined;
  const selectedDefaults = extractVatDefaults(selectedArticle);

  if (selectedDefaults.vat_accounts_id !== undefined || selectedDefaults.cl_vat_articles_id !== undefined) {
    return selectedDefaults;
  }

  const withVatDefaults = articles.filter(article => {
    const defaults = extractVatDefaults(article);
    return defaults.vat_accounts_id !== undefined || defaults.cl_vat_articles_id !== undefined;
  });

  const rateMatch = vatRateDropdown
    ? withVatDefaults.find(article => matchesRate(article, vatRateDropdown))
    : undefined;
  if (rateMatch) return extractVatDefaults(rateMatch);

  const keywordMatch = withVatDefaults.find(article => {
    const text = getArticleSearchText(article);
    return (text.includes("vat") || text.includes("käibemaks")) &&
      !text.includes("non-deduct") &&
      !text.includes("mahaarv");
  });
  if (keywordMatch) return extractVatDefaults(keywordMatch);

  return {};
}

export async function getPurchaseArticlesWithVat(api: ApiContext): Promise<PurchaseArticleWithVat[]> {
  return await api.readonly.getPurchaseArticles() as PurchaseArticleWithVat[];
}

/**
 * Structural item defaults the API requires on every PATCH/POST row but does
 * not echo back on GET: `cl_fringe_benefits_id` (NOT NULL in the API schema;
 * 1 = no fringe benefit) and `amount` (1). A `null` counts as missing so an
 * item read back from the API can be re-sent unchanged.
 */
export function applyPurchaseItemStructuralDefaults(item: PurchaseInvoiceItem): PurchaseInvoiceItem {
  return {
    ...item,
    cl_fringe_benefits_id: item.cl_fringe_benefits_id ?? 1,
    amount: item.amount ?? 1,
  } as PurchaseInvoiceItem;
}

export function applyPurchaseVatDefaults(
  purchaseArticles: PurchaseArticleWithVat[],
  item: PurchaseInvoiceItem,
  isVatRegistered: boolean,
): PurchaseInvoiceItem {
  const merged = applyPurchaseItemStructuralDefaults(item);

  if (!isVatRegistered) {
    delete merged.vat_accounts_id;
    delete merged.vat_accounts_dimensions_id;
    merged.cl_vat_articles_id = 11;
    merged.vat_rate_dropdown = "-";
    return merged;
  }

  const vatRateDropdown = normalizeVatRate(merged.vat_rate_dropdown);
  const defaults = findArticleDefaults(purchaseArticles, merged, vatRateDropdown);

  merged.vat_accounts_id ??= defaults.vat_accounts_id ?? VAT_REGISTERED_FALLBACK.vat_accounts_id;
  merged.cl_vat_articles_id ??= defaults.cl_vat_articles_id ?? VAT_REGISTERED_FALLBACK.cl_vat_articles_id;

  if (defaults.vat_accounts_id === undefined || defaults.cl_vat_articles_id === undefined) {
    warnFallbackOnce(
      "vat-registered",
      `Could not resolve purchase VAT defaults from purchase_articles; falling back to vat_accounts_id=${VAT_REGISTERED_FALLBACK.vat_accounts_id} and cl_vat_articles_id=${VAT_REGISTERED_FALLBACK.cl_vat_articles_id}.`
    );
  }
  return merged;
}

/**
 * Apply purchase VAT defaults to every item, then validate the referenced
 * accounts and dimensions against the live chart (validateItemDimensions may
 * auto-fill a unique dimension on the returned items). An empty `dimErrors`
 * means the items are ready to write.
 */
export async function applyPurchaseVatDefaultsAndValidateDimensions(
  api: ApiContext,
  purchaseArticles: PurchaseArticleWithVat[],
  rawItems: PurchaseInvoiceItem[],
  isVatRegistered: boolean,
): Promise<{ items: PurchaseInvoiceItem[]; dimErrors: string[] }> {
  const items = rawItems.map(item => applyPurchaseVatDefaults(purchaseArticles, item, isVatRegistered));
  const [accounts, accountDimensions] = await Promise.all([
    api.readonly.getAccounts(),
    api.readonly.getAccountDimensions(),
  ]);
  return { items, dimErrors: validateItemDimensions(items, accounts, accountDimensions) };
}
