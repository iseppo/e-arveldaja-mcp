import type { HttpClient } from "../http-client.js";
import type { SaleInvoice, SaleInvoiceDeliveryOptions, SaleInvoiceDeliveryRequest, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource } from "./base-resource.js";

export class SaleInvoicesApi extends BaseResource<SaleInvoice> {
  constructor(client: HttpClient) {
    super(client, "/sale_invoices");
  }

  async confirm(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/sale_invoices/${id}/register`, {});
    this.invalidateCache();
    return result;
  }

  async getDeliveryOptions(id: number): Promise<SaleInvoiceDeliveryOptions> {
    return this.client.get<SaleInvoiceDeliveryOptions>(`/sale_invoices/${id}/delivery_options`);
  }

  async getSystemPdf(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/sale_invoices/${id}/pdf_system`);
  }

  async sendEinvoice(id: number, request: SaleInvoiceDeliveryRequest): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/sale_invoices/${id}/deliver`, request);
    this.invalidateCache();
    return result;
  }
}
