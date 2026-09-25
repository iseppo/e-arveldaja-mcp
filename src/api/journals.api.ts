import type { HttpClient } from "../http-client.js";
import type { Journal, ApiResponse } from "../types/api.js";
import type { CreateJournalRequest, UpdateJournalRequest } from "../types/mutations.js";
import { BaseResource, cache } from "./base-resource.js";

export class JournalsApi extends BaseResource<Journal> {
  constructor(client: HttpClient) {
    super(client, "/journals");
  }

  // Narrow the create/update boundary from `Partial<Journal>` to request types
  // that omit server-managed fields (id, number, registered, register_date,
  // operations_id, operation_type, …). Delegates to the base mutate/cache logic.
  override async create(data: CreateJournalRequest): Promise<ApiResponse> {
    return super.create(data);
  }

  override async update(id: number, data: UpdateJournalRequest): Promise<ApiResponse> {
    return super.update(id, data);
  }

  /**
   * Load all journals with postings guaranteed to be populated.
   * The list endpoint may omit postings; this method fetches individual
   * journals as needed and caches the enriched result for 120s.
   */
  async listAllWithPostings(): Promise<Journal[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:allWithPostings`);
    const cached = cache.get<Journal[]>(cacheKey);
    if (cached) return cached;

    const gen = cache.generation;
    const all = await this.listAll();

    // Identify which journals need individual fetch (missing postings)
    const fetchIndices: number[] = [];
    for (let i = 0; i < all.length; i++) {
      const journal = all[i]!;
      if (!journal.postings || journal.postings.length === 0) {
        if (journal.id != null) fetchIndices.push(i);
      }
    }

    // Fetch in parallel batches of 5 to limit concurrent API calls
    const batchSize = 5;
    for (let i = 0; i < fetchIndices.length; i += batchSize) {
      const batch = fetchIndices.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(idx => this.get(all[idx]!.id!)));
      for (let j = 0; j < batch.length; j++) {
        all[batch[j]!] = results[j]!;
      }
    }

    cache.setIfSameGeneration(cacheKey, all, gen, 120);
    return all;
  }

  async confirm(id: number): Promise<ApiResponse> {
    // If this journal is linked to a transaction (operation_type=TRANSACTION),
    // the transaction's displayed status changes too — bust the transaction
    // cache so list_transactions doesn't serve stale status.
    return this.mutate(
      "confirm",
      id,
      `/journals:${id}:register`,
      ["/journals", "/transactions"],
      () => this.client.patch<ApiResponse>(`/journals/${id}/register`, {}),
      `Re-read journal ${id} and check whether it is already registered before retrying.`,
    );
  }

  async invalidate(id: number): Promise<ApiResponse> {
    return this.mutate(
      "invalidate",
      id,
      `/journals:${id}:invalidate`,
      ["/journals", "/transactions"],
      () => this.client.patch<ApiResponse>(`/journals/${id}/invalidate`, {}),
      `Re-read journal ${id} and check whether it is already invalidated before retrying.`,
    );
  }

}
