import { HttpError, type HttpClient } from "../http-client.js";
import type { ApiFile, ApiResponse, PaginatedResponse } from "../types/api.js";
import { Cache } from "../cache.js";
import { log } from "../logger.js";
import { reportProgress } from "../progress.js";
import type { AuditEntityType } from "../audit-log.js";
import {
  isMutationIndeterminate,
  MutationIndeterminateError,
  type MutationOperation,
} from "../mutation-outcome.js";

export const cache = new Cache(300);

const MUTATION_ENTITY_BY_PATH = {
  "/clients": "client",
  "/products": "product",
  "/journals": "journal",
  "/transactions": "transaction",
  "/sale_invoices": "sale_invoice",
  "/purchase_invoices": "purchase_invoice",
} as const satisfies Record<string, AuditEntityType>;
const KNOWN_MUTATION_CACHE_PREFIXES = new Set<string>(
  Object.keys(MUTATION_ENTITY_BY_PATH),
);

function safelyIsMutationIndeterminate(error: unknown): boolean {
  try {
    return isMutationIndeterminate(error);
  } catch {
    return false;
  }
}

export interface ListParams {
  page?: number;
  modified_since?: string;
  // Server-side filters supported by some list endpoints (see the OpenAPI spec).
  // Not every endpoint honours every field: e.g. /journals supports only the
  // date range, while /purchase_invoices, /sale_invoices and /transactions also
  // support status / clients_id (and transactions additionally `type`). Unknown
  // query params are ignored by the API, but callers should pass only the fields
  // the target endpoint documents. start_date/end_date are inclusive bounds whose
  // meaning is per-endpoint (invoice/turnover/effective/transaction date).
  start_date?: string;
  end_date?: string;
  status?: string;
  payment_status?: string;
  clients_id?: number;
  type?: string;
}

export class BaseResource<T> {
  constructor(
    protected client: HttpClient,
    protected basePath: string,
  ) {}

  get connectionFingerprint(): string {
    return this.client.connectionFingerprint;
  }

  protected cacheKey(key: string): string {
    return `${this.client.cacheNamespace}:${key}`;
  }

  protected invalidateCache(pattern = this.basePath): void {
    cache.invalidate(this.cacheKey(pattern));
  }

  protected async mutate<R>(
    operation: MutationOperation,
    entityId: number | undefined,
    businessKey: string,
    affectedPatterns: readonly string[],
    request: () => Promise<R>,
  ): Promise<R> {
    try {
      const result = await request();
      for (const pattern of new Set(affectedPatterns)) {
        this.invalidateCache(pattern);
      }
      return result;
    } catch (error) {
      if (safelyIsMutationIndeterminate(error)) {
        const invalidatedPatterns = new Set<string>();
        for (const pattern of affectedPatterns) {
          if (invalidatedPatterns.has(pattern)) continue;
          this.invalidateCache(pattern);
          invalidatedPatterns.add(pattern);
        }

        try {
          const declaredPatterns = (error as { affectedCaches?: unknown }).affectedCaches;
          if (Array.isArray(declaredPatterns)) {
            for (const pattern of declaredPatterns) {
              if (
                typeof pattern !== "string" ||
                !KNOWN_MUTATION_CACHE_PREFIXES.has(pattern) ||
                invalidatedPatterns.has(pattern)
              ) {
                continue;
              }
              this.invalidateCache(pattern);
              invalidatedPatterns.add(pattern);
            }
          }
        } catch {
          throw error;
        }
        throw error;
      }

      if (error instanceof HttpError && error.status === "network") {
        for (const pattern of new Set(affectedPatterns)) {
          this.invalidateCache(pattern);
        }
        const entity = MUTATION_ENTITY_BY_PATH[
          this.basePath as keyof typeof MUTATION_ENTITY_BY_PATH
        ];
        if (!entity) throw error;
        throw new MutationIndeterminateError({
          operation,
          entity,
          entityId,
          businessKey,
          affectedCaches: [...affectedPatterns],
          cause: error,
          nextAction: `Re-read ${entity} state for business key "${businessKey}" before deciding whether to retry; do not repeat the mutation blindly.`,
        });
      }

      throw error;
    }
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
    return this.mutate(
      "create",
      undefined,
      `${this.basePath}:create`,
      [this.basePath],
      () => this.client.post<ApiResponse>(this.basePath, data),
    );
  }

  async update(id: number, data: Partial<T>): Promise<ApiResponse> {
    return this.mutate(
      "update",
      id,
      `${this.basePath}:${id}`,
      [this.basePath],
      () => this.client.patch<ApiResponse>(`${this.basePath}/${id}`, data),
    );
  }

  async delete(id: number): Promise<ApiResponse> {
    return this.mutate(
      "delete",
      id,
      `${this.basePath}:${id}`,
      [this.basePath],
      () => this.client.delete<ApiResponse>(`${this.basePath}/${id}`),
    );
  }

  // === User-uploaded source document (document_user) ===
  // Supported by purchase_invoices, sale_invoices, journals, and transactions
  // (PUT to upload/replace, GET to read back, DELETE to remove). Calling these
  // on a resource whose API has no /{id}/document_user endpoint returns a 404 —
  // only the document-capable resources are wired to tools.

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`${this.basePath}/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    return this.mutate(
      "upload",
      id,
      `${this.basePath}:${id}:document_user`,
      [this.basePath],
      () => this.client.request<ApiResponse>(`${this.basePath}/${id}/document_user`, {
        method: "PUT",
        body: { name, contents },
      }),
    );
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    return this.mutate(
      "delete",
      id,
      `${this.basePath}:${id}:document_user`,
      [this.basePath],
      () => this.client.delete<ApiResponse>(`${this.basePath}/${id}/document_user`),
    );
  }

  // restore/reactivate is only supported by clients and products — implemented in those subclasses
}
