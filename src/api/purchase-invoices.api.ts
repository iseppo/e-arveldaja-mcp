import type { HttpClient } from "../http-client.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, CreatePurchaseInvoiceData, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource } from "./base-resource.js";
import { roundMoney } from "../money.js";

interface ConfirmPurchaseInvoiceOptions {
  preserveExistingTotals?: boolean;
}

/**
 * For non-VAT (mitte-KMD) companies: set project_no_vat_gross_price on items
 * so the API computes item-level vat_amount for informational tracking.
 * Without this field, item vat_amount stays 0 and gross_price = net_price.
 */
function normalizeItemsForNonVat(
  items: PurchaseInvoiceItem[],
  isVatRegistered: boolean,
  grossPrice?: number,
) : PurchaseInvoiceItem[] {
  if (!items || isVatRegistered) return items;

  return items.map(item => {
    // Preserve caller-provided value
    if (item.project_no_vat_gross_price != null) return item;

    const net = item.total_net_price
      ?? (item.unit_net_price !== undefined && item.amount !== undefined
        ? roundMoney(item.unit_net_price * item.amount)
        : undefined);

    const rateStr = item.vat_rate_dropdown !== undefined ? String(item.vat_rate_dropdown) : undefined;
    const rate = rateStr === "-" ? 0
      : rateStr !== undefined
        ? Number(rateStr.replace(",", "."))
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
    super(client, "/purchase_invoices");
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
    data: CreatePurchaseInvoiceData,
    vatPrice?: number,
    grossPrice?: number,
    isVatRegistered = true,
  ): Promise<PurchaseInvoice> {
    const createData: CreatePurchaseInvoiceData = {
      ...data,
      items: normalizeItemsForNonVat(
        data.items,
        isVatRegistered,
        grossPrice,
      ),
    };
    const response = await this.create(createData);
    const id = response.created_object_id;
    if (!id) throw new Error("Purchase invoice created but no ID returned");

    // Read back to get item-level VAT computed by API
    const invoice = await this.get(id);
    const items = invoice.items;

    const itemVat = items ? roundMoney(items.reduce((s, i) => s + (i.vat_amount ?? 0), 0)) : 0;
    const itemNet = items ? roundMoney(items.reduce((s, i) => s + (i.total_net_price ?? 0), 0)) : 0;

    // Invoice-level VAT: explicit value wins for VAT-registered companies.
    // Non-KMD companies must keep invoice-level vat_price at 0 even if item VAT is tracked.
    const vat = isVatRegistered
      ? (vatPrice !== undefined ? vatPrice : itemVat)
      : 0;

    // Invoice-level gross: explicit value wins, otherwise net + actual item VAT
    const gross = grossPrice !== undefined
      ? grossPrice
      : roundMoney(itemNet + itemVat);

    if (vat !== undefined || gross !== undefined) {
      await this.update(id, { vat_price: vat, gross_price: gross, items: invoice.items } as Partial<PurchaseInvoice>);
      this.invalidateCache();
    }

    return this.get(id);
  }

  /**
   * Confirm a purchase invoice. Automatically fixes vat_price/gross_price when needed.
   * For non-VAT companies: only fixes gross_price, leaves vat_price at 0.
   */
  async confirmWithTotals(
    id: number,
    isVatRegistered = true,
    options: ConfirmPurchaseInvoiceOptions = {},
  ): Promise<ApiResponse> {
    const invoice = await this.get(id);
    const hasInvoiceGross = invoice.gross_price !== undefined && invoice.gross_price !== null;
    const hasInvoiceVat = invoice.vat_price !== undefined && invoice.vat_price !== null;

    if (options.preserveExistingTotals && hasInvoiceGross && (hasInvoiceVat || !isVatRegistered)) {
      return this.confirm(id);
    }

    const items = invoice.items;
    if (items) {
      const itemVat = roundMoney(items.reduce((s, i) => s + (i.vat_amount ?? 0), 0));
      const net = roundMoney(items.reduce((s, i) => s + (i.total_net_price ?? 0), 0));
      const vat = isVatRegistered ? itemVat : 0;
      const gross = roundMoney(net + itemVat);
      const currentGross = invoice.gross_price;
      const currentVat = invoice.vat_price;
      const grossNeedsRepair = !currentGross || Math.abs(currentGross - gross) > 0.02;
      const vatNeedsRepair = isVatRegistered && (currentVat === undefined || currentVat === null || Math.abs(currentVat - vat) > 0.02);
      if (grossNeedsRepair || vatNeedsRepair) {
        await this.update(id, { vat_price: vat, gross_price: gross, items } as Partial<PurchaseInvoice>);
      }
    }
    return this.confirm(id);
  }

  async confirm(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.patch<ApiResponse>(`/purchase_invoices/${id}/register`, {});
  }

  async invalidate(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.patch<ApiResponse>(`/purchase_invoices/${id}/invalidate`, {});
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/purchase_invoices/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.request<ApiResponse>(`/purchase_invoices/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    this.invalidateCache();
    return this.client.delete<ApiResponse>(`/purchase_invoices/${id}/document_user`);
  }
}
