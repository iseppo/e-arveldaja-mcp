import type { HttpClient } from "../http-client.js";
import type { ApiFile, ApiResponse, PaginatedResponse } from "../types/api.js";
import { Cache } from "../cache.js";
import { log } from "../logger.js";
import { reportProgress } from "../progress.js";
import type { AuditEntityType } from "../audit-log.js";
import {
  classifyMutationFailure,
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

function sortedListParams(params?: ListParams): string {
  return params ? Object.keys(params).sort().map(k => `${k}=${(params as Record<string, unknown>)[k]}`).join("&") : "";
}

class PaginationMetadataError extends Error {
  constructor(requestedPage: number, detail: string) {
    super(`Pagination page ${String(requestedPage)}: ${detail}`);
  }
}

function describeMetadataValue(value: unknown): string {
  if (typeof value === "number" || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function validateRequestedPage(requestedPage: number): void {
  if (!Number.isInteger(requestedPage) || requestedPage < 1) {
    throw new PaginationMetadataError(
      requestedPage,
      `requested page must be a positive integer; received ${describeMetadataValue(requestedPage)}`,
    );
  }
}

function validatePage<T>(response: unknown, requestedPage: number): PaginatedResponse<T> {
  validateRequestedPage(requestedPage);
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new PaginationMetadataError(
      requestedPage,
      `response must be a non-null object; received ${describeMetadataValue(response)}`,
    );
  }

  const page = response as Partial<PaginatedResponse<T>>;
  if (!Array.isArray(page.items)) {
    throw new PaginationMetadataError(
      requestedPage,
      `items must be an array; received ${describeMetadataValue(page.items)}`,
    );
  }
  if (page.current_page !== requestedPage) {
    throw new PaginationMetadataError(
      requestedPage,
      `current_page must equal requested page ${requestedPage}; received ${describeMetadataValue(page.current_page)}`,
    );
  }
  if (
    !Number.isInteger(page.total_pages) ||
    (page.total_pages as number) < requestedPage
  ) {
    throw new PaginationMetadataError(
      requestedPage,
      `total_pages must be a positive integer at least ${requestedPage}; received ${describeMetadataValue(page.total_pages)}`,
    );
  }
  return page as PaginatedResponse<T>;
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

  /**
   * Force-drop this resource's list caches so the next `list()` / `listAll()`
   * re-reads from the server. Write-time duplicate guards call this right
   * before their pre-create lookup: the paged list cache lives for 120 s and
   * does not see writes made elsewhere (e-arveldaja UI, another process).
   *
   * `create()` only invalidates the cache *after* a successful POST, so a
   * create that fails with a network error never clears it and the cached
   * snapshot can still predate the ambiguous write. BookingGuard's
   * verify-then-retry calls this on journals before re-scanning to check
   * whether the ambiguous journal actually committed.
   */
  invalidateListCache(): void {
    this.invalidateCache();
  }

  protected async mutate<R>(
    operation: MutationOperation,
    entityId: number | undefined,
    businessKey: string,
    affectedPatterns: readonly string[],
    request: () => Promise<R>,
    nextAction?: string,
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

      // 5xx / 408 / network / unknown failures may have committed server-side;
      // only a 4xx rejection (except 408) is a definitive "nothing written".
      if (classifyMutationFailure(error) === "indeterminate") {
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
          nextAction: nextAction ??
            `Re-read ${entity} state for business key "${businessKey}" before deciding whether to retry; do not repeat the mutation blindly.`,
        });
      }

      throw error;
    }
  }

  private listCacheKey(params?: ListParams): string {
    return this.cacheKey(`${this.basePath}:list:${sortedListParams(params)}`);
  }

  async list(params?: ListParams): Promise<PaginatedResponse<T>> {
    const requestedPage = params?.page ?? 1;
    validateRequestedPage(requestedPage);
    const cacheKey = this.listCacheKey(params);
    const cached = cache.get<PaginatedResponse<T>>(cacheKey);
    if (cached !== undefined) {
      try {
        return validatePage<T>(cached, requestedPage);
      } catch (error) {
        if (error instanceof PaginationMetadataError) {
          cache.invalidateExact(cacheKey);
        }
        throw error;
      }
    }
    return this.fetchPage(params, requestedPage, cacheKey);
  }

  /** Live (cache-bypassing) page read; the validated page is written back to the per-page cache. */
  private async fetchPage(
    params: ListParams | undefined,
    requestedPage: number,
    cacheKey = this.listCacheKey(params),
  ): Promise<PaginatedResponse<T>> {
    validateRequestedPage(requestedPage);
    const gen = cache.generation;
    const result = await this.client.get<PaginatedResponse<T>>(this.basePath, params as Record<string, string | number>);
    try {
      const validated = validatePage<T>(result, requestedPage);
      cache.setIfSameGeneration(cacheKey, validated, gen, 120);
      return validated;
    } catch (error) {
      if (error instanceof PaginationMetadataError) {
        cache.invalidateExact(cacheKey);
      }
      throw error;
    }
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

  /**
   * Walk every page and return the stitched rows. Pages are always fetched
   * live (the per-page `list()` cache is bypassed) so one result never mixes
   * pages cached at different times, where a row that shifted across a page
   * boundary could be missed. The stitched result is cached as a whole under
   * `${basePath}:listAll:<params>` (a `basePath` prefix, so
   * `invalidateCache()` / `invalidateListCache()` clear it with the pages);
   * a cached result is reused only while it fits the caller's caps.
   */
  async listAll(params?: Omit<ListParams, "page">, maxPages = 200, maxItems = 50_000): Promise<T[]> {
    const stitchedKey = this.cacheKey(`${this.basePath}:listAll:${sortedListParams(params)}`);
    const stitched = cache.get<{ items: T[]; pages: number }>(stitchedKey);
    if (stitched !== undefined && stitched.pages <= maxPages && stitched.items.length <= maxItems) {
      return [...stitched.items];
    }
    const gen = cache.generation;
    const allItems: T[] = [];
    const seenIds = new Set<number | string>();
    let page = 1;
    let totalPages = 1;
    let pinnedTotalPages: number | undefined;
    const deadline = Date.now() + 300_000; // 5 minute overall timeout

    try {
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
        const response = await this.fetchPage({ ...params, page }, page);
        if (pinnedTotalPages === undefined) {
          pinnedTotalPages = response.total_pages;
        } else if (response.total_pages !== pinnedTotalPages) {
          throw new PaginationMetadataError(
            page,
            `total_pages changed from ${pinnedTotalPages} to ${describeMetadataValue(response.total_pages)}`,
          );
        }
        // A row can still shift across a page boundary between two live page
        // reads and appear on both pages. Keep the first occurrence per id;
        // rows without an id are kept as-is.
        for (const item of response.items) {
          const id = (item as { id?: unknown } | null)?.id;
          if (typeof id === "number" || typeof id === "string") {
            if (seenIds.has(id)) continue;
            seenIds.add(id);
          }
          allItems.push(item);
        }
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
    } catch (error) {
      if (error instanceof PaginationMetadataError) {
        this.invalidateCache();
      }
      throw error;
    }

    cache.setIfSameGeneration(stitchedKey, { items: [...allItems], pages: totalPages }, gen, 120);
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
