import type { HttpClient } from "../http-client.js";
import type { Journal, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class JournalsApi extends BaseResource<Journal> {
  constructor(client: HttpClient) {
    super(client, "/journals", "journals_id");
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

    const all = await this.listAll();

    // Identify which journals need individual fetch (missing postings)
    const fetchIndices: number[] = [];
    for (let i = 0; i < all.length; i++) {
      const journal = all[i]!;
      if (!journal.postings || journal.postings.length === 0) {
        fetchIndices.push(i);
      }
    }

    // Fetch in sequential batches of 5 to limit concurrent API calls
    const batchSize = 5;
    for (let i = 0; i < fetchIndices.length; i += batchSize) {
      const batch = fetchIndices.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(idx => this.get(all[idx]!.id!)));
      for (let j = 0; j < batch.length; j++) {
        all[batch[j]!] = results[j]!;
      }
    }

    cache.set(cacheKey, all, 120);
    return all;
  }

  async confirm(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.patch<ApiResponse>(`/journals/${id}/register`, {});
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/journals/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.request<ApiResponse>(`/journals/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.delete<ApiResponse>(`/journals/${id}/document_user`);
  }
}
