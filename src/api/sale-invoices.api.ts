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
    // Registering a sale invoice creates a journal server-side — bust the
    // journals cache so trial balance / aging / list_journals don't serve
    // stale data missing the new registration journal.
    this.invalidateCache("/journals");
    return result;
  }

  async invalidate(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/sale_invoices/${id}/invalidate`, {});
    this.invalidateCache();
    this.invalidateCache("/journals");
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
    // Defensive: delivery currently updates only the invoice itself, but
    // if the server ever posts an e-invoice-delivery journal we would
    // otherwise serve stale journal lists. Keep parity with confirm/invalidate.
    this.invalidateCache("/journals");
    return result;
  }
}
