import type { HttpClient } from "../http-client.js";
import type {
  Account, AccountDimension, Currency, SaleArticle, PurchaseArticle,
  Template, CompanyInvoiceInfo, CompanyVatInfo, Project, InvoiceSeries,
  BankAccount, ApiResponse, PaginatedResponse
} from "../types/api.js";
import { Cache } from "../cache.js";

export const readonlyCache = new Cache(600); // 10 min cache for reference data

function readonlyCacheKey(client: HttpClient, key: string): string {
  return `${client.cacheNamespace}:${key}`;
}

function invalidateReadonlyCache(client: HttpClient, pattern: string): void {
  readonlyCache.invalidate(readonlyCacheKey(client, pattern));
}

async function readonlyCachedGet<T>(client: HttpClient, path: string): Promise<T> {
  const cacheKey = readonlyCacheKey(client, path);
  const readonlyCached = readonlyCache.get<T>(cacheKey);
  if (readonlyCached) return readonlyCached;
  const result = await client.get<T>(path);
  readonlyCache.set(cacheKey, result, 600);
  return result;
}

async function readonlyCachedGetAll<T>(client: HttpClient, path: string): Promise<T[]> {
  const cacheKey = readonlyCacheKey(client, `${path}:all`);
  const readonlyCached = readonlyCache.get<T[]>(cacheKey);
  if (readonlyCached) return readonlyCached;

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
    while (page <= first.total_pages) {
      if (page > maxPages) {
        throw new Error(`Reference data ${path} exceeds ${maxPages} pages (${allItems.length} items loaded).`);
      }
      const next = await client.get<PaginatedResponse<T>>(path, { page });
      allItems.push(...next.items);
      page++;
    }
  } else {
    throw new Error(`Unexpected response shape from ${path}`);
  }

  readonlyCache.set(cacheKey, allItems, 600);
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
    const result = await this.client.patch<ApiResponse>("/invoice_info", data);
    invalidateReadonlyCache(this.client, "/invoice_info");
    return result;
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
    const result = await this.client.post<ApiResponse>("/invoice_series", data);
    invalidateReadonlyCache(this.client, "/invoice_series");
    return result;
  }

  async updateInvoiceSeries(id: number, data: Partial<InvoiceSeries>): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/invoice_series/${id}`, data);
    invalidateReadonlyCache(this.client, "/invoice_series");
    return result;
  }

  async deleteInvoiceSeries(id: number): Promise<ApiResponse> {
    const result = await this.client.delete<ApiResponse>(`/invoice_series/${id}`);
    invalidateReadonlyCache(this.client, "/invoice_series");
    return result;
  }

  // Bank accounts
  async getBankAccounts(): Promise<BankAccount[]> {
    return readonlyCachedGetAll<BankAccount>(this.client, "/bank_accounts");
  }

  async getBankAccount(id: number): Promise<BankAccount> {
    return this.client.get<BankAccount>(`/bank_accounts/${id}`);
  }

  async createBankAccount(data: Partial<BankAccount>): Promise<ApiResponse> {
    const result = await this.client.post<ApiResponse>("/bank_accounts", data);
    invalidateReadonlyCache(this.client, "/bank_accounts");
    return result;
  }

  async updateBankAccount(id: number, data: Partial<BankAccount>): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/bank_accounts/${id}`, data);
    invalidateReadonlyCache(this.client, "/bank_accounts");
    return result;
  }

  async deleteBankAccount(id: number): Promise<ApiResponse> {
    const result = await this.client.delete<ApiResponse>(`/bank_accounts/${id}`);
    invalidateReadonlyCache(this.client, "/bank_accounts");
    return result;
  }
}
