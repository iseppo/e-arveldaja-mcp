import type { HttpClient } from "../http-client.js";
import type { SaleInvoice, SaleInvoiceDeliveryOptions, SaleInvoiceDeliveryRequest, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource } from "./base-resource.js";

export class SaleInvoicesApi extends BaseResource<SaleInvoice> {
  constructor(client: HttpClient) {
    super(client, "/sale_invoices", "sale_invoices_id");
  }

  async confirm(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.patch<ApiResponse>(`/sale_invoices/${id}/register`, {});
  }

  async getDeliveryOptions(id: number): Promise<SaleInvoiceDeliveryOptions> {
    return this.client.get<SaleInvoiceDeliveryOptions>(`/sale_invoices/${id}/delivery_options`);
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/sale_invoices/${id}/pdf_system`);
  }

  async getUploadedDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/sale_invoices/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.request<ApiResponse>(`/sale_invoices/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.delete<ApiResponse>(`/sale_invoices/${id}/document_user`);
  }

  async sendEinvoice(id: number, request: SaleInvoiceDeliveryRequest): Promise<ApiResponse> {
    return this.client.patch<ApiResponse>(`/sale_invoices/${id}/deliver`, request);
  }
}
