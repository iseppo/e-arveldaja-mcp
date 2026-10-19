import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Account, PurchaseArticle, PurchaseInvoiceItem } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { log } from "../logger.js";
import { DEFAULT_VAT_ACCOUNT } from "../accounting-defaults.js";
import { validateItemDimensions } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { parseVatRateDropdown, roundMoney } from "../money.js";

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

/** True when an item carries a VAT account or VAT-account dimension (null and undefined count as absent). */
export function hasVatAccountFields(item: PurchaseInvoiceItem): boolean {
  return (item.vat_accounts_id ?? null) !== null || (item.vat_accounts_dimensions_id ?? null) !== null;
}

/**
 * The non-deductible form of a non-VAT purchase item, as e-arveldaja's own UI
 * books it (GitHub #63): the VAT is posted to the item's own cost account.
 * Structural only; the amounts are proven by proveNonDeductibleInvoice.
 */
export function isNonDeductibleVatItem(item: PurchaseInvoiceItem): boolean {
  const rate = normalizeVatRate(item.vat_rate_dropdown);
  return item.cl_vat_articles_id === 11
    && Number.isInteger(item.vat_accounts_id)
    && item.vat_accounts_id === item.purchase_accounts_id
    && (item.vat_accounts_dimensions_id ?? null) === (item.purchase_accounts_dimensions_id ?? null)
    && rate !== undefined && /^\d+(\.\d+)?$/.test(rate) && Number(rate) > 0
    && (item.reversed_vat_id ?? null) === null;
}

export type NonVatInvoiceForm = "folded" | "non_deductible" | "unproven";

/**
 * Routes a non-VAT invoice's items: "folded" (no item carries a VAT account,
 * today's form), "non_deductible" (every item has the non-deductible shape at
 * one shared rate and every shared account is in the chart with
 * is_vat_account === false; no chart fails closed), else "unproven". It never
 * authorizes a write on its own: proveNonDeductibleInvoice does.
 */
export function classifyNonVatInvoiceForm(items: readonly PurchaseInvoiceItem[], accounts?: readonly Account[]): NonVatInvoiceForm {
  if (items.every(item => !hasVatAccountFields(item))) return "folded";
  if (!accounts || !items.every(isNonDeductibleVatItem)) return "unproven";
  if (new Set(items.map(item => normalizeVatRate(item.vat_rate_dropdown))).size !== 1) return "unproven";
  const chartProven = items.every(item => accounts.find(account => account.id === item.vat_accounts_id)?.is_vat_account === false);
  return chartProven ? "non_deductible" : "unproven";
}

/** Invoice-level figures the non-deductible proof checks (an intended payload or a read-back invoice). */
export interface NonDeductibleProofHeader {
  net_price?: number | null;
  vat_price?: number | null;
  gross_price?: number | null;
  cl_currencies_id?: string | null;
  currency_rate?: number | null;
  base_net_price?: number | null;
  base_vat_price?: number | null;
  base_gross_price?: number | null;
}

export type NonDeductibleProof = { ok: true; rate: string } | { ok: false; reason: string };

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const toCents = (value: number) => Math.round(value * 100);

/**
 * The one proof for the non-deductible form (GitHub #63), used before the POST,
 * on both create read-backs and before every register. Positive proof only:
 * whole invoice, row by row, cent-exact, against the chart, EUR only. It
 * refuses with a reason and never returns a corrected value.
 *
 * `intended: true` is an intended payload: a row VAT is predicted (from a row
 * project_no_vat_gross_price, else net × rate) and a caller-supplied
 * vat_amount is refused. Otherwise the rows are read back and their
 * vat_amount is the API's.
 */
export function proveNonDeductibleInvoice(
  rows: readonly PurchaseInvoiceItem[],
  header: NonDeductibleProofHeader,
  accounts: readonly Account[] | undefined,
  options: { intended?: boolean } = {},
): NonDeductibleProof {
  // a. shape, one rate, chart, no reversed_vat_id
  if (classifyNonVatInvoiceForm(rows, accounts) !== "non_deductible") {
    return { ok: false, reason: "items are not all the non-deductible form (VAT account = cost account, article 11, one rate) on a non-VAT chart account" };
  }
  const rate = normalizeVatRate(rows[0]!.vat_rate_dropdown)!;
  const r = parseVatRateDropdown(rate);
  let netCents = 0;
  let vatCents = 0;
  for (const [index, row] of rows.entries()) {
    if (options.intended && row.vat_amount !== undefined && row.vat_amount !== null) {
      return { ok: false, reason: `items[${index}].vat_amount must not be supplied for the non-deductible form` };
    }
    // b. every amount used is a finite number
    const net = row.total_net_price ?? (isFiniteNumber(row.unit_net_price) ? roundMoney(row.unit_net_price * (row.amount ?? 1)) : undefined);
    const override = row.project_no_vat_gross_price ?? null;
    if (!isFiniteNumber(net) || (override !== null && !isFiniteNumber(override))) {
      return { ok: false, reason: `items[${index}] has a non-finite amount` };
    }
    const vat = options.intended
      ? (override !== null ? roundMoney(override - net) : roundMoney(net * r / 100))
      : row.vat_amount;
    if (!isFiniteNumber(vat)) return { ok: false, reason: `items[${index}].vat_amount is not a finite number` };
    // c. per row: VAT cent-exact to net × rate; only the last row may be one cent off
    const offBy = Math.abs(toCents(vat) - toCents(roundMoney(net * r / 100)));
    if (index < rows.length - 1 ? offBy !== 0 : offBy > 1) {
      return { ok: false, reason: `items[${index}] VAT ${vat} is not net ${net} × ${rate}%` };
    }
    if (override !== null && toCents(override) !== toCents(net) + toCents(vat)) {
      return { ok: false, reason: `items[${index}].project_no_vat_gross_price ${override} is not net ${net} + VAT ${vat}` };
    }
    const baseNet = row.base_total_net_price ?? null;
    if (baseNet !== null && (!isFiniteNumber(baseNet) || toCents(baseNet) !== toCents(net))) {
      return { ok: false, reason: `items[${index}].base_total_net_price ${baseNet} is not the row net ${net}` };
    }
    netCents += toCents(net);
    vatCents += toCents(vat);
  }
  // d. header sums, cent-exact
  const { net_price: net, vat_price: vat, gross_price: gross } = header;
  if (!isFiniteNumber(net) || !isFiniteNumber(vat) || !isFiniteNumber(gross)) {
    return { ok: false, reason: "invoice net_price, vat_price and gross_price must be finite numbers" };
  }
  if (toCents(net) !== netCents) return { ok: false, reason: `invoice net_price ${net} is not the item net sum ${netCents / 100}` };
  if (toCents(vat) !== vatCents) return { ok: false, reason: `invoice vat_price ${vat} is not the item VAT sum ${vatCents / 100}` };
  if (toCents(gross) !== toCents(net) + toCents(vat)) return { ok: false, reason: `invoice gross_price ${gross} is not net ${net} + VAT ${vat}` };
  // e. EUR only: no foreign currency, rate or base settlement override
  const currency = header.cl_currencies_id ?? null;
  if (currency === null ? !options.intended : currency.toUpperCase() !== "EUR") {
    return { ok: false, reason: "the non-deductible form supports EUR invoices only" };
  }
  if ((header.currency_rate ?? null) !== null && header.currency_rate !== 1) {
    return { ok: false, reason: "the non-deductible form supports EUR invoices only (currency_rate must be absent or 1)" };
  }
  const bases: Array<[string, number | null | undefined, number]> = [
    ["base_net_price", header.base_net_price, net], ["base_vat_price", header.base_vat_price, vat], ["base_gross_price", header.base_gross_price, gross],
  ];
  for (const [field, base, total] of bases) {
    if ((base ?? null) !== null && (!isFiniteNumber(base) || toCents(base) !== toCents(total))) {
      return { ok: false, reason: `${field} ${base} differs from the EUR total ${total}` };
    }
  }
  return { ok: true, rate };
}

/**
 * The register gate (P4) of a non-VAT invoice: undefined when no item carries
 * a VAT account (folded, today's form), else the proof's refusal reason, if any.
 */
export function nonVatRegisterRefusal(
  invoice: NonDeductibleProofHeader & { items?: PurchaseInvoiceItem[] },
  accounts: readonly Account[] | undefined,
): string | undefined {
  const items = invoice.items ?? [];
  if (!items.some(hasVatAccountFields)) return undefined;
  const proof = proveNonDeductibleInvoice(items, invoice, accounts);
  return proof.ok ? undefined : proof.reason;
}

export function validateNonVatItem(item: PurchaseInvoiceItem): string[] {
  if (isNonDeductibleVatItem(item)) return [];
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
  if (item.vat_accounts_id !== undefined && item.vat_accounts_id !== null && item.vat_accounts_id === item.purchase_accounts_id) {
    errors.push("the non-deductible form (VAT on the cost account) also needs vat_accounts_dimensions_id equal to purchase_accounts_dimensions_id, " +
      "cl_vat_articles_id 11, a numeric vat_rate_dropdown above 0 and no reversed_vat_id");
  }

  return errors;
}

/**
 * `validateNonVatItem` over a whole item list, each error prefixed
 * `items[<index>].`, plus list-level errors: one invoice is either all folded
 * or all non-deductible at one rate.
 */
export function collectNonVatItemErrors(items: PurchaseInvoiceItem[]): string[] {
  const errors = items.flatMap((item, index) => validateNonVatItem(item).map(error => `items[${index}].${error}`));
  const nonDeductible = items.filter(isNonDeductibleVatItem);
  if (nonDeductible.length > 0 && nonDeductible.length < items.length) {
    errors.push("items mix the folded form (no VAT account) and the non-deductible form (VAT account = cost account); use one form for the whole invoice");
  }
  if (new Set(nonDeductible.map(item => normalizeVatRate(item.vat_rate_dropdown))).size > 1) {
    errors.push("non-deductible items carry different VAT rates; an invoice in this form uses one rate");
  }
  return errors;
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
    next_action: "Use one non-VAT form for every item: folded (no VAT account, article 11, rate \"-\") or non-deductible VAT on the cost account " +
      "(VAT account and dimension = the item's cost account and dimension, article 11, the document's VAT rate), then review and retry.",
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
 * Compatible structural defaults for PATCH/POST rows: `cl_fringe_benefits_id`
 * (1 = no fringe benefit) and `amount` (1). RIK now handles a missing fringe
 * classifier without HTTP 500; keep the existing default and preserve explicit
 * values, including values returned by newer GET responses. A `null` counts as missing so an
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
  options: { allowNonDeductible?: boolean } = {},
): PurchaseInvoiceItem {
  const merged = applyPurchaseItemStructuralDefaults(item);

  if (!isVatRegistered) {
    // Opted-in create paths keep the non-deductible form (GitHub #63); it is
    // proven whole-invoice before any write. Everyone else folds, as before.
    if (options.allowNonDeductible === true && isNonDeductibleVatItem(merged)) return merged;
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
 * means the items are ready to write. For a non-VAT company whose (opted-in)
 * items keep a VAT account, the chart is read uncached and an unproven
 * non-VAT form is an error; the loaded chart is returned for the later proofs.
 */
export async function applyPurchaseVatDefaultsAndValidateDimensions(
  api: ApiContext,
  purchaseArticles: PurchaseArticleWithVat[],
  rawItems: PurchaseInvoiceItem[],
  isVatRegistered: boolean,
  options: { allowNonDeductible?: boolean } = {},
): Promise<{ items: PurchaseInvoiceItem[]; dimErrors: string[]; accounts: Account[] }> {
  const items = rawItems.map(item => applyPurchaseVatDefaults(purchaseArticles, item, isVatRegistered, options));
  const freshChart = !isVatRegistered && items.some(hasVatAccountFields);
  const [accounts, accountDimensions] = await Promise.all([
    freshChart ? api.readonly.getAccounts({ fresh: true }) : api.readonly.getAccounts(),
    api.readonly.getAccountDimensions(),
  ]);
  const dimErrors = validateItemDimensions(items, accounts, accountDimensions);
  if (!isVatRegistered && classifyNonVatInvoiceForm(items, accounts) === "unproven") {
    dimErrors.push("Non-VAT items carrying a VAT account must all be the non-deductible form: VAT account and dimension = the item's cost account and dimension " +
      "(a chart account with is_vat_account false), article 11, one VAT rate above 0.");
  }
  return { items, dimErrors, accounts };
}
