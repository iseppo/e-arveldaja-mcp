import type { PurchaseArticle, PurchaseInvoiceItem } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { log } from "../logger.js";

const VAT_REGISTERED_FALLBACK = {
  vat_accounts_id: 1510,
  cl_vat_articles_id: 1,
} as const;

const NON_VAT_REGISTERED_FALLBACK = {
  cl_vat_articles_id: 11,
} as const;

const warnedFallbackKeys = new Set<string>();

/** Clear the fallback-warning dedup set. Call on connection switch. */
export function clearVatWarnings(): void {
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
  if (warnedFallbackKeys.has(key)) return;
  warnedFallbackKeys.add(key);
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
  isVatRegistered: boolean,
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
    return isVatRegistered
      ? (text.includes("vat") || text.includes("käibemaks")) &&
          !text.includes("non-deduct") &&
          !text.includes("mahaarv")
      : text.includes("non-deduct") ||
          text.includes("mahaarv") ||
          text.includes("mitte");
  });
  if (keywordMatch) return extractVatDefaults(keywordMatch);

  return {};
}

export async function getPurchaseArticlesWithVat(api: ApiContext): Promise<PurchaseArticleWithVat[]> {
  return await api.readonly.getPurchaseArticles() as PurchaseArticleWithVat[];
}

export function applyPurchaseVatDefaults(
  purchaseArticles: PurchaseArticleWithVat[],
  item: PurchaseInvoiceItem,
  isVatRegistered: boolean,
): PurchaseInvoiceItem {
  const merged = {
    cl_fringe_benefits_id: 1,
    amount: 1,
    ...item,
  } as PurchaseInvoiceItem;

  const vatRateDropdown = normalizeVatRate(merged.vat_rate_dropdown);
  const defaults = findArticleDefaults(purchaseArticles, merged, vatRateDropdown, isVatRegistered);

  if (isVatRegistered) {
    merged.vat_accounts_id ??= defaults.vat_accounts_id ?? VAT_REGISTERED_FALLBACK.vat_accounts_id;
    merged.cl_vat_articles_id ??= defaults.cl_vat_articles_id ?? VAT_REGISTERED_FALLBACK.cl_vat_articles_id;

    if (defaults.vat_accounts_id === undefined || defaults.cl_vat_articles_id === undefined) {
      warnFallbackOnce(
        "vat-registered",
        "Could not resolve purchase VAT defaults from purchase_articles; falling back to vat_accounts_id=1510 and cl_vat_articles_id=1."
      );
    }
    return merged;
  }

  merged.vat_rate_dropdown ??= "-";

  if (merged.vat_rate_dropdown !== "-") {
    merged.vat_accounts_id ??= defaults.vat_accounts_id ?? merged.purchase_accounts_id;
    merged.cl_vat_articles_id ??= defaults.cl_vat_articles_id ?? NON_VAT_REGISTERED_FALLBACK.cl_vat_articles_id;

    if (defaults.cl_vat_articles_id === undefined) {
      warnFallbackOnce(
        "non-vat-registered",
        "Could not resolve non-deductible VAT defaults from purchase_articles; falling back to cl_vat_articles_id=11."
      );
    }
  }

  return merged;
}
