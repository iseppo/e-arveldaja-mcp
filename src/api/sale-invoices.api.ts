import type { HttpClient } from "../http-client.js";
import type { SaleInvoice, SaleInvoiceDeliveryOptions, SaleInvoiceDeliveryRequest, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

export class SaleInvoicesApi extends BaseResource<SaleInvoice> {
  constructor(client: HttpClient) {
    super(client, "/sale_invoices", "sale_invoices_id");
  }

  async confirm(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/sale_invoices/${id}/confirm`, {});
  }

  async getDeliveryOptions(id: number): Promise<SaleInvoiceDeliveryOptions> {
    return this.client.get<SaleInvoiceDeliveryOptions>(`/sale_invoices/${id}/delivery_options`);
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/sale_invoices/${id}/document`);
  }

  async sendEinvoice(id: number, request: SaleInvoiceDeliveryRequest): Promise<ApiResponse> {
    return this.client.post<ApiResponse>(`/sale_invoices/${id}/send_einvoice`, request);
  }
}
