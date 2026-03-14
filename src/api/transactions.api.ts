import type { HttpClient } from "../http-client.js";
import type { Transaction, TransactionDistribution, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class TransactionsApi extends BaseResource<Transaction> {
  constructor(client: HttpClient) {
    super(client, "/transactions", "transactions_id");
  }

  async confirm(id: number, distributions?: TransactionDistribution[]): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    const body = distributions ? { items: distributions } : {};
    return this.client.patch<ApiResponse>(`/transactions/${id}/confirm`, body);
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/transactions/${id}/document`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.post<ApiResponse>(`/transactions/${id}/document`, { name, contents });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.delete<ApiResponse>(`/transactions/${id}/document`);
  }
}
