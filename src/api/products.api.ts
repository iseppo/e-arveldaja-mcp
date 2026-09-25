import type { HttpClient } from "../http-client.js";
import type { Product, ApiResponse } from "../types/api.js";
import { BaseResource } from "./base-resource.js";

export class ProductsApi extends BaseResource<Product> {
  constructor(client: HttpClient) {
    super(client, "/products");
  }

  async deactivate(id: number): Promise<ApiResponse> {
    return this.mutate(
      "update",
      id,
      `/products:${id}:deactivate`,
      ["/products"],
      () => this.client.patch<ApiResponse>(`/products/${id}/deactivate`, {}),
      `Re-read product ${id} and check whether it is already deactivated before retrying.`,
    );
  }

  async restore(id: number): Promise<ApiResponse> {
    return this.mutate(
      "update",
      id,
      `/products:${id}:reactivate`,
      ["/products"],
      () => this.client.patch<ApiResponse>(`/products/${id}/reactivate`, {}),
      `Re-read product ${id} and check whether it is already active before retrying.`,
    );
  }

}
