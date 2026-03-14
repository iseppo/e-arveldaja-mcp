import type { HttpClient } from "../http-client.js";
import type { Product, ApiResponse } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class ProductsApi extends BaseResource<Product> {
  constructor(client: HttpClient) {
    super(client, "/products", "products_id");
  }

  async merge(targetId: number, sourceId: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
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
