import type { HttpClient } from "../http-client.js";
import type { Transaction, TransactionDistribution, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class TransactionsApi extends BaseResource<Transaction> {
  constructor(client: HttpClient) {
    super(client, "/transactions", "transactions_id");
  }

  async confirm(id: number, distributions?: TransactionDistribution[]): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    const body = distributions ?? [];
    return this.client.patch<ApiResponse>(`/transactions/${id}/register`, body);
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/transactions/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.request<ApiResponse>(`/transactions/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.delete<ApiResponse>(`/transactions/${id}/document_user`);
  }
}
