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
    const cacheKey = `${this.basePath}:allWithPostings`;
    const cached = cache.get<Journal[]>(cacheKey);
    if (cached) return cached;

    const all = await this.listAll();
    const enriched: Journal[] = [];

    // Separate journals that need individual fetch
    const needFetch: Journal[] = [];
    for (const journal of all) {
      if (journal.postings && journal.postings.length > 0) {
        enriched.push(journal);
      } else {
        needFetch.push(journal);
      }
    }

    // Fetch in parallel batches of 5 (respects rate limiter in HttpClient)
    const batchSize = 5;
    for (let i = 0; i < needFetch.length; i += batchSize) {
      const batch = needFetch.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(j => this.get(j.id!)));
      enriched.push(...results);
    }

    cache.set(cacheKey, enriched, 120);
    return enriched;
  }

  async confirm(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/journals/${id}/register`, {});
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/journals/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.request<ApiResponse>(`/journals/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.delete<ApiResponse>(`/journals/${id}/document_user`);
  }
}
