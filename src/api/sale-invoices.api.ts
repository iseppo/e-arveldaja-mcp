import type { HttpClient } from "../http-client.js";
import type { SaleInvoice, SaleInvoiceDeliveryOptions, SaleInvoiceDeliveryRequest, ApiResponse, ApiFile } from "../types/api.js";
import type { CreateSaleInvoiceRequest, UpdateSaleInvoiceRequest } from "../types/mutations.js";
import { BaseResource } from "./base-resource.js";

export class SaleInvoicesApi extends BaseResource<SaleInvoice> {
  constructor(client: HttpClient) {
    super(client, "/sale_invoices");
  }

  // Narrow the create/update boundary from `Partial<SaleInvoice>` to request
  // types that omit server-managed fields (id, number, status, payment_status,
  // journals/settlements/transactions/deliveries back-refs, …). Delegates to the
  // base mutate/cache logic.
  override async create(data: CreateSaleInvoiceRequest): Promise<ApiResponse> {
    return super.create(data);
  }

  override async update(id: number, data: UpdateSaleInvoiceRequest): Promise<ApiResponse> {
    return super.update(id, data);
  }

  async confirm(id: number): Promise<ApiResponse> {
    // Registering a sale invoice creates a journal server-side — bust the
    // journals cache so trial balance / aging / list_journals don't serve
    // stale data missing the new registration journal. Linked transactions'
    // displayed state can change too (parity with purchase invoices).
    return this.mutate(
      "confirm",
      id,
      `/sale_invoices:${id}:register`,
      ["/sale_invoices", "/journals", "/transactions"],
      () => this.client.patch<ApiResponse>(`/sale_invoices/${id}/register`, {}),
      `Re-read sale invoice ${id} and check whether it is already confirmed before retrying.`,
    );
  }

  async invalidate(id: number): Promise<ApiResponse> {
    return this.mutate(
      "invalidate",
      id,
      `/sale_invoices:${id}:invalidate`,
      ["/sale_invoices", "/journals", "/transactions"],
      () => this.client.patch<ApiResponse>(`/sale_invoices/${id}/invalidate`, {}),
      `Re-read sale invoice ${id} and check whether it is already invalidated before retrying.`,
    );
  }

  async getDeliveryOptions(id: number): Promise<SaleInvoiceDeliveryOptions> {
    return this.client.get<SaleInvoiceDeliveryOptions>(`/sale_invoices/${id}/delivery_options`);
  }

  async getSystemPdf(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/sale_invoices/${id}/pdf_system`);
  }

  async getSystemXml(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/sale_invoices/${id}/xml`);
  }

  async sendEinvoice(id: number, request: SaleInvoiceDeliveryRequest): Promise<ApiResponse> {
    // Defensive: delivery currently updates only the invoice itself, but
    // if the server ever posts an e-invoice-delivery journal we would
    // otherwise serve stale journal lists. Keep parity with confirm/invalidate.
    return this.mutate(
      "update",
      id,
      `/sale_invoices:${id}:deliver`,
      ["/sale_invoices", "/journals"],
      () => this.client.patch<ApiResponse>(`/sale_invoices/${id}/deliver`, request),
      `Re-read sale invoice ${id} and check its delivery status before retrying; the e-invoice may already have been sent.`,
    );
  }
}
