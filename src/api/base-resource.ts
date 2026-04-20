import type { HttpClient } from "../http-client.js";
import type { ApiResponse, PaginatedResponse } from "../types/api.js";
import { Cache } from "../cache.js";
import { log } from "../logger.js";
import { reportProgress } from "../progress.js";

export const cache = new Cache(300);

export interface ListParams {
  page?: number;
  modified_since?: string;
}

export class BaseResource<T> {
  constructor(
    protected client: HttpClient,
    protected basePath: string,
  ) {}

  protected cacheKey(key: string): string {
    return `${this.client.cacheNamespace}:${key}`;
  }

  protected invalidateCache(pattern = this.basePath): void {
    cache.invalidate(this.cacheKey(pattern));
  }

  async list(params?: ListParams): Promise<PaginatedResponse<T>> {
    const sortedParams = params ? Object.keys(params).sort().map(k => `${k}=${(params as Record<string, unknown>)[k]}`).join("&") : "";
    const cacheKey = this.cacheKey(`${this.basePath}:list:${sortedParams}`);
    const cached = cache.get<PaginatedResponse<T>>(cacheKey);
    if (cached) return cached;

    const gen = cache.generation;
    const result = await this.client.get<PaginatedResponse<T>>(this.basePath, params as Record<string, string | number>);
    cache.setIfSameGeneration(cacheKey, result, gen, 120);
    return result;
  }

  /**
   * Cached aggregate `listAll()` — reads from memory for up to `ttlSeconds`
   * before walking pages again. Use this from tools that do client-side
   * filtering / pagination to avoid re-walking the whole dataset on every
   * filtered call.
   *
   * **Cache key is keyed only on `basePath` — it does NOT vary with filter
   * params.** Do not use this for filtered queries; pass the full list through
   * your own filter layer.
   *
   * **Invalidation**: the key (`${basePath}:listAll`) starts with `basePath`,
   * so `invalidateCache()` (which does a prefix-delete on `basePath`) clears
   * it together with the per-page cache on any mutation, and a connection
   * switch clears everything via `cache.invalidate()` with no pattern. Any
   * cross-namespace mutation (e.g. `TransactionsApi.confirm` creating a
   * journal) must call `this.invalidateCache("/journals")` explicitly.
   */
  async listAllCached(ttlSeconds = 60): Promise<T[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:listAll`);
    const cached = cache.get<T[]>(cacheKey);
    if (cached) return cached;
    const gen = cache.generation;
    const result = await this.listAll();
    cache.setIfSameGeneration(cacheKey, result, gen, ttlSeconds);
    return result;
  }

  async listAll(params?: Omit<ListParams, "page">, maxPages = 200, maxItems = 50_000): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    let totalPages = 1;
    const deadline = Date.now() + 300_000; // 5 minute overall timeout

    do {
      if (Date.now() > deadline) {
        throw new Error(
          `${this.basePath}: pagination timed out after 5 minutes (${allItems.length} items loaded from ${page - 1} pages). ` +
          `Use date filters to narrow the query.`
        );
      }
      if (page > maxPages) {
        throw new Error(
          `Data exceeds ${maxPages} pages (${allItems.length} items loaded). ` +
          `Use date filters to narrow the query.`
        );
      }
      const response = await this.list({ ...params, page });
      allItems.push(...(response.items ?? []));
      if (allItems.length > maxItems) {
        throw new Error(
          `${this.basePath}: item count (${allItems.length}) exceeds limit of ${maxItems}. ` +
          `Use date filters to narrow the query.`
        );
      }
      totalPages = response.total_pages;
      if (totalPages > 1 && page === 1) {
        log("info", `${this.basePath}: fetching ${totalPages} pages...`);
      }
      if (totalPages > 1) {
        await reportProgress(page - 1, totalPages);
      }
      page++;
    } while (page <= totalPages);

    return allItems;
  }

  async get(id: number): Promise<T> {
    const cacheKey = this.cacheKey(`${this.basePath}:${id}`);
    const cached = cache.get<T>(cacheKey);
    if (cached) return cached;

    const gen = cache.generation;
    const result = await this.client.get<T>(`${this.basePath}/${id}`);
    cache.setIfSameGeneration(cacheKey, result, gen, 120);
    return result;
  }

  async create(data: Partial<T>): Promise<ApiResponse> {
    const result = await this.client.post<ApiResponse>(this.basePath, data);
    this.invalidateCache();
    return result;
  }

  async update(id: number, data: Partial<T>): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`${this.basePath}/${id}`, data);
    this.invalidateCache();
    return result;
  }

  async delete(id: number): Promise<ApiResponse> {
    const result = await this.client.delete<ApiResponse>(`${this.basePath}/${id}`);
    this.invalidateCache();
    return result;
  }

  // restore/reactivate is only supported by clients and products — implemented in those subclasses
}
