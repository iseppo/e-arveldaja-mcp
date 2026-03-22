import type { HttpClient } from "../http-client.js";
import type { Transaction, TransactionDistribution, PurchaseInvoice, SaleInvoice, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource } from "./base-resource.js";

export class TransactionsApi extends BaseResource<Transaction> {
  constructor(client: HttpClient) {
    super(client, "/transactions");
  }

  /**
   * Confirm a transaction with distribution rows.
   * If the transaction has no clients_id (common for card payments), automatically
   * sets it from the linked invoice before confirming. Without this, the API
   * rejects confirmation with "buyer or supplier is missing".
   * If confirmation fails after setting clients_id, the change is rolled back.
   */
  async confirm(id: number, distributions?: TransactionDistribution[]): Promise<ApiResponse> {
    const body = distributions ?? [];

    // Auto-fix missing clients_id from linked invoice
    let clientsIdWasSet = false;
    if (body.length > 0) {
      const tx = await this.get(id);
      if (!tx.clients_id) {
        let clientsId: number | undefined;

        for (const dist of body) {
          if (dist.related_table === "purchase_invoices" && dist.related_id) {
            const inv = await this.client.get<PurchaseInvoice>(`/purchase_invoices/${dist.related_id}`);
            clientsId = inv?.clients_id;
          } else if (dist.related_table === "sale_invoices" && dist.related_id) {
            const inv = await this.client.get<SaleInvoice>(`/sale_invoices/${dist.related_id}`);
            clientsId = inv?.clients_id;
          }
          if (clientsId !== undefined) break;
        }

        if (clientsId !== undefined) {
          await this.update(id, { clients_id: clientsId });
          clientsIdWasSet = true;
        }
      }
    }

    try {
      const result = await this.client.patch<ApiResponse>(`/transactions/${id}/register`, body);
      this.invalidateCache();
      return result;
    } catch (error) {
      if (clientsIdWasSet) {
        try {
          await this.update(id, { clients_id: null } as Partial<Transaction>);
        } catch (rollbackErr) {
          process.stderr.write(
            `WARNING: Failed to roll back clients_id on transaction ${id}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}\n`
          );
        }
      }
      throw error;
    }
  }

  async invalidate(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/transactions/${id}/invalidate`, {});
    this.invalidateCache();
    return result;
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/transactions/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    const result = await this.client.request<ApiResponse>(`/transactions/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
    this.invalidateCache();
    return result;
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    const result = await this.client.delete<ApiResponse>(`/transactions/${id}/document_user`);
    this.invalidateCache();
    return result;
  }
}
