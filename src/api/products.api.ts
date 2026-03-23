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

}
