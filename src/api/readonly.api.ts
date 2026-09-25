import type { HttpClient } from "../http-client.js";
import type {
  Account, AccountDimension, Currency, SaleArticle, PurchaseArticle,
  Template, CompanyInvoiceInfo, CompanyVatInfo, Project, InvoiceSeries,
  BankAccount, ApiResponse, PaginatedResponse
} from "../types/api.js";
import { Cache } from "../cache.js";
import type { AuditEntityType } from "../audit-log.js";
import {
  classifyMutationFailure,
  isMutationIndeterminate,
  MutationIndeterminateError,
  type MutationOperation,
} from "../mutation-outcome.js";

const REFERENCE_TTL_SECONDS = 600; // 10 min cache for reference data

export const readonlyCache = new Cache(REFERENCE_TTL_SECONDS);

function readonlyCacheKey(client: HttpClient, key: string): string {
  return `${client.cacheNamespace}:${key}`;
}

function invalidateReadonlyCache(client: HttpClient, pattern: string): void {
  readonlyCache.invalidate(readonlyCacheKey(client, pattern));
}

const READONLY_MUTATION_ENTITY_BY_PATH = {
  "/invoice_info": "invoice_info",
  "/invoice_series": "invoice_series",
  "/bank_accounts": "bank_account",
} as const satisfies Record<string, AuditEntityType>;

type ReadonlyMutationPath = keyof typeof READONLY_MUTATION_ENTITY_BY_PATH;

/**
 * Reference-data counterpart of BaseResource.mutate(): same outcome classifier
 * (classifyMutationFailure), but against the separate readonly cache. The
 * affected cache is invalidated on success and on any indeterminate failure
 * (5xx / 408 / network), which is rethrown as MutationIndeterminateError; a
 * definitive 4xx rejection is rethrown unchanged with the cache left intact.
 */
async function readonlyMutate<R>(
  client: HttpClient,
  operation: MutationOperation,
  basePath: ReadonlyMutationPath,
  entityId: number | undefined,
  request: () => Promise<R>,
): Promise<R> {
  try {
    const result = await request();
    invalidateReadonlyCache(client, basePath);
    return result;
  } catch (error) {
    if (classifyMutationFailure(error) === "definitive") throw error;
    invalidateReadonlyCache(client, basePath);
    let alreadyClassified = false;
    try {
      alreadyClassified = isMutationIndeterminate(error);
    } catch {
      alreadyClassified = false;
    }
    if (alreadyClassified) throw error;
    const entity = READONLY_MUTATION_ENTITY_BY_PATH[basePath];
    const businessKey = entityId === undefined ? `${basePath}:${operation}` : `${basePath}:${entityId}`;
    throw new MutationIndeterminateError({
      operation,
      entity,
      entityId,
      businessKey,
      affectedCaches: [basePath],
      cause: error,
      nextAction:
        `Re-read ${entity} state for business key "${businessKey}" before deciding whether to retry; do not repeat the mutation blindly.`,
    });
  }
}

async function readonlyCachedGet<T>(client: HttpClient, path: string): Promise<T> {
  const cacheKey = readonlyCacheKey(client, path);
  const readonlyCached = readonlyCache.get<T>(cacheKey);
  if (readonlyCached !== undefined) return readonlyCached;
  // Capture generation BEFORE the network round-trip. If a mutator invalidates
  // the cache while this request is in flight, the generation bumps and
  // setIfSameGeneration will discard the now-stale result instead of polluting
  // the cache for ~10 minutes.
  const gen = readonlyCache.generation;
  const result = await client.get<T>(path);
  readonlyCache.setIfSameGeneration(cacheKey, result, gen, REFERENCE_TTL_SECONDS);
  return result;
}

async function readonlyCachedGetAll<T>(client: HttpClient, path: string): Promise<T[]> {
  const cacheKey = readonlyCacheKey(client, `${path}:all`);
  const readonlyCached = readonlyCache.get<T[]>(cacheKey);
  if (readonlyCached !== undefined) return readonlyCached;

  const gen = readonlyCache.generation;

  // First request - detect if paginated or plain array
  const first = await client.get<T[] | PaginatedResponse<T>>(path);

  let allItems: T[];

  if (Array.isArray(first)) {
    // Plain array response (accounts, currencies, templates, etc.)
    allItems = first;
  } else if (first && typeof first === "object" && "items" in first) {
    // Paginated response
    allItems = [...first.items];
    let page = 2;
    const maxPages = 200;
    let totalPages = first.total_pages;
    while (page <= totalPages) {
      if (page > maxPages) {
        throw new Error(`Reference data ${path} exceeds ${maxPages} pages (${allItems.length} items loaded).`);
      }
      const next = await client.get<PaginatedResponse<T>>(path, { page });
      allItems.push(...(next.items ?? []));
      totalPages = next.total_pages;
      page++;
    }
  } else {
    throw new Error(`Unexpected response shape from ${path}`);
  }

  readonlyCache.setIfSameGeneration(cacheKey, allItems, gen, REFERENCE_TTL_SECONDS);
  return allItems;
}

export class ReferenceDataApi {
  constructor(private client: HttpClient) {}

  // Chart of accounts
  async getAccounts(): Promise<Account[]> {
    return readonlyCachedGetAll<Account>(this.client, "/accounts");
  }

  async getAccount(id: number): Promise<Account | undefined> {
    const accounts = await this.getAccounts();
    return accounts.find(a => a.id === id);
  }

  // Account dimensions
  async getAccountDimensions(): Promise<AccountDimension[]> {
    return readonlyCachedGetAll<AccountDimension>(this.client, "/account_dimensions");
  }

  // Currencies
  async getCurrencies(): Promise<Currency[]> {
    return readonlyCachedGetAll<Currency>(this.client, "/currencies");
  }

  // Sale articles
  async getSaleArticles(): Promise<SaleArticle[]> {
    return readonlyCachedGetAll<SaleArticle>(this.client, "/sale_articles");
  }

  // Purchase articles
  async getPurchaseArticles(): Promise<PurchaseArticle[]> {
    return readonlyCachedGetAll<PurchaseArticle>(this.client, "/purchase_articles");
  }

  // Templates
  async getTemplates(): Promise<Template[]> {
    return readonlyCachedGetAll<Template>(this.client, "/templates");
  }

  // Invoice info
  async getInvoiceInfo(): Promise<CompanyInvoiceInfo> {
    return readonlyCachedGet<CompanyInvoiceInfo>(this.client, "/invoice_info");
  }

  async updateInvoiceInfo(data: Partial<CompanyInvoiceInfo>): Promise<ApiResponse> {
    return readonlyMutate(this.client, "update", "/invoice_info", undefined,
      () => this.client.patch<ApiResponse>("/invoice_info", data));
  }

  // VAT info
  async getVatInfo(): Promise<CompanyVatInfo> {
    return readonlyCachedGet<CompanyVatInfo>(this.client, "/vat_info");
  }

  // Projects (read-only list)
  async getProjects(): Promise<Project[]> {
    return readonlyCachedGetAll<Project>(this.client, "/projects");
  }

  // Invoice series
  async getInvoiceSeries(): Promise<InvoiceSeries[]> {
    return readonlyCachedGetAll<InvoiceSeries>(this.client, "/invoice_series");
  }

  async getInvoiceSeriesOne(id: number): Promise<InvoiceSeries> {
    return this.client.get<InvoiceSeries>(`/invoice_series/${id}`);
  }

  async createInvoiceSeries(data: Partial<InvoiceSeries>): Promise<ApiResponse> {
    return readonlyMutate(this.client, "create", "/invoice_series", undefined,
      () => this.client.post<ApiResponse>("/invoice_series", data));
  }

  async updateInvoiceSeries(id: number, data: Partial<InvoiceSeries>): Promise<ApiResponse> {
    return readonlyMutate(this.client, "update", "/invoice_series", id,
      () => this.client.patch<ApiResponse>(`/invoice_series/${id}`, data));
  }

  async deleteInvoiceSeries(id: number): Promise<ApiResponse> {
    return readonlyMutate(this.client, "delete", "/invoice_series", id,
      () => this.client.delete<ApiResponse>(`/invoice_series/${id}`));
  }

  // Bank accounts
  async getBankAccounts(): Promise<BankAccount[]> {
    return readonlyCachedGetAll<BankAccount>(this.client, "/bank_accounts");
  }

  async getBankAccount(id: number): Promise<BankAccount> {
    return this.client.get<BankAccount>(`/bank_accounts/${id}`);
  }

  async createBankAccount(data: Partial<BankAccount>): Promise<ApiResponse> {
    return readonlyMutate(this.client, "create", "/bank_accounts", undefined,
      () => this.client.post<ApiResponse>("/bank_accounts", data));
  }

  async updateBankAccount(id: number, data: Partial<BankAccount>): Promise<ApiResponse> {
    return readonlyMutate(this.client, "update", "/bank_accounts", id,
      () => this.client.patch<ApiResponse>(`/bank_accounts/${id}`, data));
  }

  async deleteBankAccount(id: number): Promise<ApiResponse> {
    return readonlyMutate(this.client, "delete", "/bank_accounts", id,
      () => this.client.delete<ApiResponse>(`/bank_accounts/${id}`));
  }
}
