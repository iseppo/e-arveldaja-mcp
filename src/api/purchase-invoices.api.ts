import type { HttpClient } from "../http-client.js";
import type { PurchaseInvoice, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class PurchaseInvoicesApi extends BaseResource<PurchaseInvoice> {
  constructor(client: HttpClient) {
    super(client, "/purchase_invoices", "purchase_invoices_id");
  }

  async confirm(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/purchase_invoices/${id}/register`, {});
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/purchase_invoices/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.request<ApiResponse>(`/purchase_invoices/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.delete<ApiResponse>(`/purchase_invoices/${id}/document_user`);
  }
}
