import type { HttpClient } from "../http-client.js";
import type { Product, ApiResponse } from "../types/api.js";
import { BaseResource } from "./base-resource.js";

export class ProductsApi extends BaseResource<Product> {
  constructor(client: HttpClient) {
    super(client, "/products");
  }

  async deactivate(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/products/${id}/deactivate`, {});
    this.invalidateCache();
    return result;
  }

  async restore(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/products/${id}/reactivate`, {});
    this.invalidateCache();
    return result;
  }

  /** Not in OpenAPI spec — endpoint may not exist on all API versions */
  async merge(targetId: number, sourceId: number): Promise<ApiResponse> {
    const result = await this.client.post<ApiResponse>(`/products/${targetId}/merge/${sourceId}`, {});
    this.invalidateCache();
    return result;
  }

  async findByName(name: string): Promise<Product[]> {
    const all = await this.listAll();
    const lower = name.toLowerCase();
    return all.filter(p => !p.is_deleted && p.name.toLowerCase().includes(lower));
  }

  async findByCode(code: string): Promise<Product | undefined> {
    const all = await this.listAll();
    return all.find(p => !p.is_deleted && p.code === code);
  }
}
