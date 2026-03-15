import type { HttpClient } from "../http-client.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource, cache } from "./base-resource.js";

const roundMoney = (v: number): number => Math.round(v * 100) / 100;

/**
 * For non-VAT (mitte-KMD) companies: set project_no_vat_gross_price on items
 * so the API computes item-level vat_amount for informational tracking.
 * Without this field, item vat_amount stays 0 and gross_price = net_price.
 */
function normalizeItemsForNonVat(
  items: PurchaseInvoiceItem[] | undefined,
  isVatRegistered: boolean,
  grossPrice?: number,
): PurchaseInvoiceItem[] | undefined {
  if (!items || isVatRegistered) return items;

  return items.map(item => {
    // Preserve caller-provided value
    if (item.project_no_vat_gross_price != null) return item;

    const net = item.total_net_price
      ?? (item.unit_net_price !== undefined && item.amount !== undefined
        ? roundMoney(item.unit_net_price * item.amount)
        : undefined);

    const rate = item.vat_rate_dropdown === "-" ? 0
      : item.vat_rate_dropdown !== undefined
        ? Number(item.vat_rate_dropdown.replace(",", "."))
        : undefined;

    // Single-item invoice: use explicit gross_price if available
    const derivedGross =
      items.length === 1 && grossPrice !== undefined ? grossPrice :
      net !== undefined && rate !== undefined && Number.isFinite(rate) ? roundMoney(net * (1 + rate / 100)) :
      undefined;

    if (derivedGross === undefined) return item; // best-effort: skip if not derivable

    return { ...item, project_no_vat_gross_price: derivedGross };
  });
}

export class PurchaseInvoicesApi extends BaseResource<PurchaseInvoice> {
  constructor(client: HttpClient) {
    super(client, "/purchase_invoices", "purchase_invoices_id");
  }

  /**
   * Create a purchase invoice and set invoice-level totals.
   * The API does not auto-compute vat_price/gross_price at invoice level,
   * so we PATCH them after creation based on item-level VAT amounts.
   * If explicit vatPrice/grossPrice are given, those are used (to match the original invoice exactly).
   *
   * For non-VAT companies (isVatRegistered=false): invoice-level vat_price stays 0
   * because input VAT is not deductible. gross_price is still set to actual payable amount.
   * Items get project_no_vat_gross_price set for VAT tracking.
   */
  async createAndSetTotals(
    data: Partial<PurchaseInvoice>,
    vatPrice?: number,
    grossPrice?: number,
    isVatRegistered = true,
  ): Promise<PurchaseInvoice> {
    const createData = {
      ...data,
      items: normalizeItemsForNonVat(
        data.items as PurchaseInvoiceItem[] | undefined,
        isVatRegistered,
        grossPrice,
      ),
    };
    const response = await this.create(createData);
    const id = response.created_object_id;
    if (!id) throw new Error("Purchase invoice created but no ID returned");

    // Read back to get item-level VAT computed by API
    const invoice = await this.get(id);
    const items = (invoice as any).items as Array<{ vat_amount?: number; total_net_price: number }> | undefined;

    const itemVat = items ? Math.round(items.reduce((s, i) => s + (i.vat_amount ?? 0), 0) * 100) / 100 : 0;
    const itemNet = items ? Math.round(items.reduce((s, i) => s + (i.total_net_price ?? 0), 0) * 100) / 100 : 0;

    // Invoice-level VAT: explicit value wins, otherwise compute from items.
    // Non-KMD companies also need vat_price set (informational) so net + vat = gross.
    const vat = vatPrice !== undefined ? vatPrice : itemVat;

    // Invoice-level gross: explicit value wins, otherwise net + actual item VAT
    const gross = grossPrice !== undefined
      ? grossPrice
      : Math.round((itemNet + itemVat) * 100) / 100;

    if (vat > 0 || gross > 0) {
      await this.update(id, { vat_price: vat, gross_price: gross, items: (invoice as any).items } as any);
      cache.invalidate(this.basePath);
    }

    return this.get(id);
  }

  /**
   * Confirm a purchase invoice. Automatically fixes vat_price/gross_price if needed.
   * For non-VAT companies: only fixes gross_price, leaves vat_price at 0.
   */
  async confirmWithTotals(id: number, isVatRegistered = true): Promise<ApiResponse> {
    const invoice = await this.get(id);
    if ((invoice as any).gross_price === 0 || (invoice as any).gross_price === null) {
      const items = (invoice as any).items as Array<{ vat_amount?: number; total_net_price: number }> | undefined;
      if (items) {
        const itemVat = Math.round(items.reduce((s, i) => s + (i.vat_amount ?? 0), 0) * 100) / 100;
        const net = Math.round(items.reduce((s, i) => s + (i.total_net_price ?? 0), 0) * 100) / 100;
        const vat = isVatRegistered ? itemVat : 0;
        const gross = Math.round((net + itemVat) * 100) / 100;
        await this.update(id, { vat_price: vat, gross_price: gross, items } as any);
      }
    }
    return this.confirm(id);
  }

  async confirm(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/purchase_invoices/${id}/register`, {});
  }

  async invalidate(id: number): Promise<ApiResponse> {
    cache.invalidate(this.basePath);
    return this.client.patch<ApiResponse>(`/purchase_invoices/${id}/invalidate`, {});
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
