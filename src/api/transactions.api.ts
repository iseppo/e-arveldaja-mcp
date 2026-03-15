import type { HttpClient } from "../http-client.js";
import type { Transaction, TransactionDistribution, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class TransactionsApi extends BaseResource<Transaction> {
  constructor(client: HttpClient) {
    super(client, "/transactions", "transactions_id");
  }

  /**
   * Confirm a transaction with distribution rows.
   * If the transaction has no clients_id (common for card payments), automatically
   * sets it from the linked invoice before confirming. Without this, the API
   * rejects confirmation with "buyer or supplier is missing".
   */
  async confirm(id: number, distributions?: TransactionDistribution[]): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    const body = distributions ?? [];

    // Auto-fix missing clients_id from linked invoice
    if (body.length > 0) {
      const tx = await this.get(id);
      if (!(tx as any).clients_id) {
        const dist = body[0]!;
        let clientsId: number | undefined;

        if (dist.related_table === "purchase_invoices" && dist.related_id) {
          const inv = await this.client.get<any>(`/purchase_invoices/${dist.related_id}`);
          clientsId = inv?.clients_id;
        } else if (dist.related_table === "sale_invoices" && dist.related_id) {
          const inv = await this.client.get<any>(`/sale_invoices/${dist.related_id}`);
          clientsId = inv?.clients_id;
        }

        if (clientsId) {
          await this.update(id, { clients_id: clientsId } as any);
        }
      }
    }

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
