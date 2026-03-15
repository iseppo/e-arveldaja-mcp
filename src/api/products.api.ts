import type { HttpClient } from "../http-client.js";
import type { Product, ApiResponse } from "../types/api.js";
import { BaseResource } from "./base-resource.js";

export class ProductsApi extends BaseResource<Product> {
  constructor(client: HttpClient) {
    super(client, "/products", "products_id");
  }

  async deactivate(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.patch<ApiResponse>(`/products/${id}/deactivate`, {});
  }

  async restore(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.patch<ApiResponse>(`/products/${id}/reactivate`, {});
  }

  /** Not in OpenAPI spec — endpoint may not exist on all API versions */
  async merge(targetId: number, sourceId: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.post<ApiResponse>(`/products/${targetId}/merge/${sourceId}`, {});
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
