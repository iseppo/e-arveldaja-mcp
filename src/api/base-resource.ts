import type { HttpClient } from "../http-client.js";
import type { ApiResponse, PaginatedResponse } from "../types/api.js";
import { Cache } from "../cache.js";

export const cache = new Cache(300);

export interface ListParams {
  page?: number;
  modified_since?: string;
}

export class BaseResource<T> {
  constructor(
    protected client: HttpClient,
    protected basePath: string,
    protected idParam: string
  ) {}

  async list(params?: ListParams): Promise<PaginatedResponse<T>> {
    const cacheKey = `${this.basePath}:list:${JSON.stringify(params ?? {})}`;
    const cached = cache.get<PaginatedResponse<T>>(cacheKey);
    if (cached) return cached;

    const result = await this.client.get<PaginatedResponse<T>>(this.basePath, params as Record<string, string | number>);
    cache.set(cacheKey, result, 120);
    return result;
  }

  async listAll(params?: Omit<ListParams, "page">, maxPages = 200): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const response = await this.list({ ...params, page });
      allItems.push(...response.items);
      totalPages = response.total_pages;
      page++;
      if (page > maxPages) {
        throw new Error(
          `Data exceeds ${maxPages} pages (${allItems.length} items loaded). ` +
          `Use date filters to narrow the query.`
        );
      }
    } while (page <= totalPages);

    return allItems;
  }

  async get(id: number): Promise<T> {
    const cacheKey = `${this.basePath}:${id}`;
    const cached = cache.get<T>(cacheKey);
    if (cached) return cached;

    const result = await this.client.get<T>(`${this.basePath}/${id}`);
    cache.set(cacheKey, result, 120);
    return result;
  }

  async create(data: Partial<T>): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.post<ApiResponse>(this.basePath, data);
  }

  async update(id: number, data: Partial<T>): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`${this.basePath}/${id}`, data);
  }

  async delete(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.delete<ApiResponse>(`${this.basePath}/${id}`);
  }

  // restore/reactivate is only supported by clients and products — implemented in those subclasses
}
