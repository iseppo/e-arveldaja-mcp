import type { HttpClient } from "../http-client.js";
import type {
  Account, AccountDimension, Currency, SaleArticle, PurchaseArticle,
  Template, CompanyInvoiceInfo, CompanyVatInfo, Project, InvoiceSeries,
  BankAccount, ApiResponse, PaginatedResponse
} from "../types/api.js";
import { Cache } from "../cache.js";

const cache = new Cache(600); // 10 min cache for reference data

async function cachedGet<T>(client: HttpClient, path: string): Promise<T> {
  const cached = cache.get<T>(path);
  if (cached) return cached;
  const result = await client.get<T>(path);
  cache.set(path, result, 600);
  return result;
}

async function cachedGetAll<T>(client: HttpClient, path: string): Promise<T[]> {
  const cacheKey = `${path}:all`;
  const cached = cache.get<T[]>(cacheKey);
  if (cached) return cached;

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
    while (page <= first.total_pages) {
      const next = await client.get<PaginatedResponse<T>>(path, { page });
      allItems.push(...next.items);
      page++;
    }
  } else {
    throw new Error(`Unexpected response shape from ${path}: ${JSON.stringify(first).substring(0, 200)}`);
  }

  cache.set(cacheKey, allItems, 600);
  return allItems;
}

export class ReadonlyApi {
  constructor(private client: HttpClient) {}

  // Chart of accounts
  async getAccounts(): Promise<Account[]> {
    return cachedGetAll<Account>(this.client, "/accounts");
  }

  async getAccount(id: number): Promise<Account | undefined> {
    const accounts = await this.getAccounts();
    return accounts.find(a => a.id === id);
  }

  // Account dimensions
  async getAccountDimensions(): Promise<AccountDimension[]> {
    return cachedGetAll<AccountDimension>(this.client, "/account_dimensions");
  }

  // Currencies
  async getCurrencies(): Promise<Currency[]> {
    return cachedGetAll<Currency>(this.client, "/currencies");
  }

  // Sale articles
  async getSaleArticles(): Promise<SaleArticle[]> {
    return cachedGetAll<SaleArticle>(this.client, "/sale_articles");
  }

  // Purchase articles
  async getPurchaseArticles(): Promise<PurchaseArticle[]> {
    return cachedGetAll<PurchaseArticle>(this.client, "/purchase_articles");
  }

  // Templates
  async getTemplates(): Promise<Template[]> {
    return cachedGetAll<Template>(this.client, "/templates");
  }

  // Invoice info
  async getInvoiceInfo(): Promise<CompanyInvoiceInfo> {
    return cachedGet<CompanyInvoiceInfo>(this.client, "/invoice_info");
  }

  async updateInvoiceInfo(data: Partial<CompanyInvoiceInfo>): Promise<ApiResponse> {
    cache.invalidate("/invoice_info");
    return this.client.patch<ApiResponse>("/invoice_info", data);
  }

  // VAT info
  async getVatInfo(): Promise<CompanyVatInfo> {
    return cachedGet<CompanyVatInfo>(this.client, "/vat_info");
  }

  // Projects (read-only list)
  async getProjects(): Promise<Project[]> {
    return cachedGetAll<Project>(this.client, "/projects");
  }

  // Invoice series
  async getInvoiceSeries(): Promise<InvoiceSeries[]> {
    return cachedGetAll<InvoiceSeries>(this.client, "/invoice_series");
  }

  async getInvoiceSeriesOne(id: number): Promise<InvoiceSeries> {
    return this.client.get<InvoiceSeries>(`/invoice_series/${id}`);
  }

  async createInvoiceSeries(data: Partial<InvoiceSeries>): Promise<ApiResponse> {
    cache.invalidate("/invoice_series");
    return this.client.post<ApiResponse>("/invoice_series", data);
  }

  async updateInvoiceSeries(id: number, data: Partial<InvoiceSeries>): Promise<ApiResponse> {
    cache.invalidate("/invoice_series");
    return this.client.patch<ApiResponse>(`/invoice_series/${id}`, data);
  }

  async deleteInvoiceSeries(id: number): Promise<ApiResponse> {
    cache.invalidate("/invoice_series");
    return this.client.delete<ApiResponse>(`/invoice_series/${id}`);
  }

  // Bank accounts
  async getBankAccounts(): Promise<BankAccount[]> {
    return cachedGetAll<BankAccount>(this.client, "/bank_accounts");
  }

  async getBankAccount(id: number): Promise<BankAccount> {
    return this.client.get<BankAccount>(`/bank_accounts/${id}`);
  }

  async createBankAccount(data: Partial<BankAccount>): Promise<ApiResponse> {
    cache.invalidate("/bank_accounts");
    return this.client.post<ApiResponse>("/bank_accounts", data);
  }

  async updateBankAccount(id: number, data: Partial<BankAccount>): Promise<ApiResponse> {
    cache.invalidate("/bank_accounts");
    return this.client.patch<ApiResponse>(`/bank_accounts/${id}`, data);
  }

  async deleteBankAccount(id: number): Promise<ApiResponse> {
    cache.invalidate("/bank_accounts");
    return this.client.delete<ApiResponse>(`/bank_accounts/${id}`);
  }
}
