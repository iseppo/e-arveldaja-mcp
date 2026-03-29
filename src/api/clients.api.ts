import type { HttpClient } from "../http-client.js";
import type { Client, ApiResponse } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class ClientsApi extends BaseResource<Client> {
  constructor(client: HttpClient) {
    super(client, "/clients");
  }

  /** listAll() with a short-TTL aggregate cache (same pattern as JournalsApi.listAllWithPostings). */
  private async listAllCached(): Promise<Client[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:all`);
    const cached = cache.get<Client[]>(cacheKey);
    if (cached) return cached;
    const all = await this.listAll();
    cache.set(cacheKey, all, 120);
    return all;
  }

  async deactivate(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/clients/${id}/deactivate`, {});
    this.invalidateCache();
    return result;
  }

  async restore(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/clients/${id}/reactivate`, {});
    this.invalidateCache();
    return result;
  }

  async findByName(name: string): Promise<Client[]> {
    const all = await this.listAllCached();
    const lower = name.toLowerCase();
    return all.filter(c => !c.is_deleted && c.name.toLowerCase().includes(lower));
  }

  async findByCode(code: string): Promise<Client | undefined> {
    const all = await this.listAllCached();
    return all.find(c => c.code === code && !c.is_deleted);
  }

}
