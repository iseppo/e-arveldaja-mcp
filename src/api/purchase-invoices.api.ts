import type { HttpClient } from "../http-client.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, CreatePurchaseInvoiceData, ApiResponse, ApiFile } from "../types/api.js";
import { BaseResource } from "./base-resource.js";
import { roundMoney, parseVatRateDropdown } from "../money.js";

export class InvoiceCreationError extends Error {
  constructor(message: string, public readonly invoiceId: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvoiceCreationError";
  }
}

interface ConfirmPurchaseInvoiceOptions {
  preserveExistingTotals?: boolean;
}

/**
 * For non-VAT companies: set project_no_vat_gross_price on items
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

    const rate = item.vat_rate_dropdown !== undefined
      ? parseVatRateDropdown(item.vat_rate_dropdown)
      : undefined;

    // Single-item invoice: use explicit gross_price if available
    const derivedGross =
      items.length === 1 && grossPrice !== undefined ? grossPrice :
      net !== undefined && rate !== undefined ? roundMoney(net * (1 + rate / 100)) :
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
   *
   * For foreign-currency invoices (cl_currencies_id != "EUR"):
   * data.currency_rate is required (EUR per 1 foreign unit). base_net_price /
   * base_vat_price / base_gross_price can be supplied explicitly to match the
   * actual EUR settlement (e.g. Wise card-payment rate); otherwise they are
   * auto-derived as round(amount * currency_rate, 2). For EUR invoices the
   * base_* fields are forced to mirror the foreign-currency totals so the
   * server-side payment matcher does not see a phantom rounding gap.
   */
  async createAndSetTotals(
    data: CreatePurchaseInvoiceData,
    vatPrice?: number,
    grossPrice?: number,
    isVatRegistered = true,
  ): Promise<PurchaseInvoice> {
    const currency = (data.cl_currencies_id ?? "EUR").toUpperCase();
    const isForeignCurrency = currency !== "EUR";
    if (isForeignCurrency && (data.currency_rate === undefined || data.currency_rate === null || !Number.isFinite(data.currency_rate) || data.currency_rate <= 0)) {
      throw new Error(
        `currency_rate is required when cl_currencies_id="${currency}". ` +
        `Pass the EUR-per-${currency} rate (for Wise card payments use Source amount / Target amount from the Wise CSV).`
      );
    }
    const normalizedItems = normalizeItemsForNonVat(
      data.items,
      isVatRegistered,
      grossPrice,
    );
    const createData: CreatePurchaseInvoiceData = {
      ...data,
      items: normalizedItems,
    };
    const response = await this.create(createData);
    const id = response.created_object_id;
    if (!id) throw new Error("Purchase invoice created but no ID returned");

    try {
      // Read back to get item-level VAT computed by API
      const invoice = await this.get(id);
      const apiItems = invoice.items;

      const itemVat = apiItems ? roundMoney(apiItems.reduce((s, i) => s + (i.vat_amount ?? 0), 0)) : 0;
      const itemNet = apiItems ? roundMoney(apiItems.reduce((s, i) => s + (i.total_net_price ?? 0), 0)) : 0;

      // Invoice-level VAT: explicit value wins for VAT-registered companies.
      // Non-VAT companies must keep invoice-level vat_price at 0 even if item VAT is tracked.
      const vat = isVatRegistered
        ? (vatPrice !== undefined ? vatPrice : itemVat)
        : 0;

      // Invoice-level gross: explicit value wins, otherwise net + actual item VAT
      const gross = grossPrice !== undefined
        ? grossPrice
        : roundMoney(itemNet + itemVat);

      // Merge API-returned item IDs back into our original items (preserving
      // cl_fringe_benefits_id and other fields the API GET doesn't return).
      // If the API items have different count (shouldn't happen), fall back to API items.
      const patchItems = apiItems && apiItems.length === normalizedItems.length
        ? normalizedItems.map((orig, idx) => ({
            ...orig,
            id: apiItems[idx]!.id,
            // Let the API recompute vat_amount from our fields
          }))
        : apiItems;

      // When explicit VAT differs from item-computed VAT (rounding), adjust
      // project_no_vat_gross_price on items so the API computes matching totals.
      if (patchItems && patchItems.length > 0 && vatPrice !== undefined && isVatRegistered && itemVat !== vatPrice) {
        const vatDiff = roundMoney(vatPrice - itemVat);
        // Apply the rounding difference to the last item's gross
        const lastItem = patchItems[patchItems.length - 1]!;
        const currentGross = lastItem.project_no_vat_gross_price
          ?? roundMoney((lastItem.total_net_price ?? 0) * (1 + parseVatRateDropdown(lastItem.vat_rate_dropdown) / 100));
        lastItem.project_no_vat_gross_price = roundMoney(currentGross + vatDiff);
      }

      const patchPayload: Partial<PurchaseInvoice> = {
        vat_price: vat,
        gross_price: gross,
        items: patchItems,
      };

      if (isForeignCurrency) {
        const rate = data.currency_rate!;
        const net = roundMoney(itemNet);
        const baseNet = data.base_net_price ?? roundMoney(net * rate);
        const baseVat = data.base_vat_price ?? roundMoney(vat * rate);
        const baseGross = data.base_gross_price ?? roundMoney(gross * rate);
        patchPayload.cl_currencies_id = currency;
        patchPayload.currency_rate = rate;
        patchPayload.base_net_price = baseNet;
        patchPayload.base_vat_price = baseVat;
        patchPayload.base_gross_price = baseGross;
      }

      await this.update(id, patchPayload);

      return this.get(id);
    } catch (error) {
      const followUpMessage = error instanceof Error ? error.message : String(error);
      try {
        await this.invalidate(id);
      } catch (invalidateError) {
        const invalidateMessage = invalidateError instanceof Error ? invalidateError.message : String(invalidateError);
        throw new InvoiceCreationError(
          `Purchase invoice ${id} was created but follow-up failed: ${followUpMessage}. ` +
          `Automatic invalidation also failed: ${invalidateMessage}`,
          id,
        );
      }

      throw new InvoiceCreationError(
        `Purchase invoice ${id} was created but follow-up failed and the draft was invalidated: ${followUpMessage}`,
        id,
      );
    }
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
      const grossNeedsRepair = currentGross === undefined || currentGross === null || roundMoney(currentGross) !== roundMoney(gross);
      const vatNeedsRepair = isVatRegistered && (currentVat === undefined || currentVat === null || roundMoney(currentVat) !== roundMoney(vat));
      if (grossNeedsRepair || vatNeedsRepair) {
        await this.update(id, { vat_price: vat, gross_price: gross, items } as Partial<PurchaseInvoice>);
      }
    }
    return this.confirm(id);
  }

  async confirm(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/purchase_invoices/${id}/register`, {});
    this.invalidateCache();
    // Registering a purchase invoice creates a journal server-side and can
    // flip payment_status on any linked transaction — bust both caches.
    this.invalidateCache("/journals");
    this.invalidateCache("/transactions");
    return result;
  }

  async invalidate(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/purchase_invoices/${id}/invalidate`, {});
    this.invalidateCache();
    this.invalidateCache("/journals");
    this.invalidateCache("/transactions");
    return result;
  }

  async getDocument(id: number): Promise<ApiFile> {
    return this.client.get<ApiFile>(`/purchase_invoices/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    const result = await this.client.request<ApiResponse>(`/purchase_invoices/${id}/document_user`, {
      method: "PUT",
      body: { name, contents },
    });
    this.invalidateCache();
    return result;
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    const result = await this.client.delete<ApiResponse>(`/purchase_invoices/${id}/document_user`);
    this.invalidateCache();
    return result;
  }
}
