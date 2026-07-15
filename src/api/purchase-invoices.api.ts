import { createHash } from "node:crypto";
import type { HttpClient } from "../http-client.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, CreatePurchaseInvoiceData, ApiResponse } from "../types/api.js";
import { BaseResource } from "./base-resource.js";
import { roundMoney, parseVatRateDropdown } from "../money.js";

export class InvoiceCreationError extends Error {
  constructor(message: string, public readonly invoiceId: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvoiceCreationError";
  }
}

export interface PurchaseInvoiceTotalsCorrectionPreview {
  invoice_id: number;
  is_vat_registered: boolean;
  current_vat_price: number | null;
  current_gross_price: number | null;
  proposed_vat_price: number;
  proposed_gross_price: number;
  correction_required: boolean;
  approval_digest: string;
}

interface ConfirmPurchaseInvoiceOptions {
  recalculateTotals?: boolean;
  approvedCorrection?: PurchaseInvoiceTotalsCorrectionPreview;
}

export type PurchaseInvoiceTotalsCorrectionCode =
  | "correction_invoice_not_project"
  | "correction_currency_not_supported"
  | "correction_reverse_charge_not_supported"
  | "correction_items_missing"
  | "correction_preview_required"
  | "correction_preview_mismatch";

const TOTALS_CORRECTION_ERRORS: Record<PurchaseInvoiceTotalsCorrectionCode, {
  message: string;
  nextAction: string;
}> = {
  correction_invoice_not_project: {
    message: "Purchase invoice totals correction requires a PROJECT draft.",
    nextAction: "Fetch the invoice; if it is confirmed, invalidate it explicitly, then request and approve a new correction preview.",
  },
  correction_currency_not_supported: {
    message: "Automatic purchase invoice totals correction supports EUR invoices only.",
    nextAction: "Review the currency and base totals manually; do not use automatic totals correction.",
  },
  correction_reverse_charge_not_supported: {
    message: "Automatic totals correction is disabled for reverse-charge purchase invoices.",
    nextAction: "Review and preserve the reverse-charge totals manually, then confirm without recalculation only after approval.",
  },
  correction_items_missing: {
    message: "Purchase invoice totals correction requires at least one item.",
    nextAction: "Add or repair the invoice items, then request and approve a new correction preview.",
  },
  correction_preview_required: {
    message: "An exact approved purchase invoice totals correction preview is required.",
    nextAction: "Call preview_purchase_invoice_totals_correction, obtain approval, and resubmit that preview unchanged.",
  },
  correction_preview_mismatch: {
    message: "The approved purchase invoice totals correction preview no longer matches fresh invoice state.",
    nextAction: "Call preview_purchase_invoice_totals_correction again and obtain approval for the new snapshot.",
  },
};

export class PurchaseInvoiceTotalsCorrectionError extends Error {
  readonly nextAction: string;

  constructor(public readonly code: PurchaseInvoiceTotalsCorrectionCode) {
    const contract = TOTALS_CORRECTION_ERRORS[code];
    super(contract.message);
    this.name = "PurchaseInvoiceTotalsCorrectionError";
    this.nextAction = contract.nextAction;
  }
}

function normalizeCorrectionSnapshot(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalizeCorrectionSnapshot);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeCorrectionSnapshot((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

function canonicalCorrectionJson(value: unknown): string {
  return JSON.stringify(normalizeCorrectionSnapshot(value));
}

const CORRECTION_PREVIEW_KEYS = [
  "invoice_id",
  "is_vat_registered",
  "current_vat_price",
  "current_gross_price",
  "proposed_vat_price",
  "proposed_gross_price",
  "correction_required",
  "approval_digest",
] as const;

function isFiniteNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isCorrectionPreview(value: unknown): value is PurchaseInvoiceTotalsCorrectionPreview {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== CORRECTION_PREVIEW_KEYS.length ||
      keys.some((key, index) => key !== [...CORRECTION_PREVIEW_KEYS].sort()[index])) return false;
  return Number.isInteger(record.invoice_id) && (record.invoice_id as number) > 0 &&
    typeof record.is_vat_registered === "boolean" &&
    isFiniteNullableNumber(record.current_vat_price) &&
    isFiniteNullableNumber(record.current_gross_price) &&
    typeof record.proposed_vat_price === "number" && Number.isFinite(record.proposed_vat_price) &&
    typeof record.proposed_gross_price === "number" && Number.isFinite(record.proposed_gross_price) &&
    typeof record.correction_required === "boolean" &&
    typeof record.approval_digest === "string" && /^[0-9a-f]{64}$/.test(record.approval_digest);
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
          ?? roundMoney((lastItem.total_net_price ?? 0) + (apiItems?.[patchItems.length - 1]?.vat_amount ?? 0));
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
        const baseGross = data.base_gross_price ?? roundMoney(gross * rate);
        // Derive base_vat as the residual of base_gross − base_net so the trio
        // reconciles exactly (base_net + base_vat === base_gross). Rounding net,
        // vat, and gross independently against the rate can leave them off by a
        // cent, which fails API sum validation or re-trips currency rounding.
        const baseVat = data.base_vat_price ?? roundMoney(baseGross - baseNet);
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

  private async getFreshInvoice(id: number): Promise<PurchaseInvoice> {
    this.invalidateCache();
    return this.get(id);
  }

  private buildTotalsCorrectionPreview(
    id: number,
    invoice: PurchaseInvoice,
    isVatRegistered: boolean,
  ): PurchaseInvoiceTotalsCorrectionPreview {
    if (invoice.status !== "PROJECT") {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_invoice_not_project");
    }
    if (invoice.cl_currencies_id?.toUpperCase() !== "EUR") {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_currency_not_supported");
    }
    if (!invoice.items || invoice.items.length === 0) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_items_missing");
    }
    if (invoice.items.some(item => item.reversed_vat_id !== undefined && item.reversed_vat_id !== null)) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_reverse_charge_not_supported");
    }

    const itemVat = roundMoney(invoice.items.reduce((sum, item) => sum + (item.vat_amount ?? 0), 0));
    const itemNet = roundMoney(invoice.items.reduce((sum, item) => sum + (item.total_net_price ?? 0), 0));
    const proposedVat = isVatRegistered ? itemVat : 0;
    const proposedGross = roundMoney(itemNet + itemVat);
    const currentVat = invoice.vat_price ?? null;
    const currentGross = invoice.gross_price ?? null;
    const correctionRequired =
      currentVat === null || roundMoney(currentVat) !== proposedVat ||
      currentGross === null || roundMoney(currentGross) !== proposedGross;

    const digestSnapshot = {
      invoice_id: id,
      is_vat_registered: isVatRegistered,
      status: invoice.status,
      net_price: invoice.net_price,
      vat_price: invoice.vat_price,
      gross_price: invoice.gross_price,
      cl_currencies_id: invoice.cl_currencies_id,
      currency_rate: invoice.currency_rate,
      base_net_price: invoice.base_net_price,
      base_vat_price: invoice.base_vat_price,
      base_gross_price: invoice.base_gross_price,
      proposed_vat_price: proposedVat,
      proposed_gross_price: proposedGross,
      correction_required: correctionRequired,
      items: invoice.items,
    };
    const approvalDigest = createHash("sha256")
      .update(canonicalCorrectionJson(digestSnapshot))
      .digest("hex");

    return {
      invoice_id: id,
      is_vat_registered: isVatRegistered,
      current_vat_price: currentVat,
      current_gross_price: currentGross,
      proposed_vat_price: proposedVat,
      proposed_gross_price: proposedGross,
      correction_required: correctionRequired,
      approval_digest: approvalDigest,
    };
  }

  async previewTotalsCorrection(
    id: number,
    isVatRegistered = true,
  ): Promise<PurchaseInvoiceTotalsCorrectionPreview> {
    const invoice = await this.getFreshInvoice(id);
    return this.buildTotalsCorrectionPreview(id, invoice, isVatRegistered);
  }

  /** Confirm without changing totals unless an exact fresh correction preview was approved. */
  async confirmWithTotals(
    id: number,
    isVatRegistered = true,
    options: ConfirmPurchaseInvoiceOptions = {},
  ): Promise<ApiResponse> {
    if (!options.recalculateTotals) {
      if (options.approvedCorrection !== undefined) {
        throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
      }
      return this.confirm(id);
    }
    if (options.approvedCorrection === undefined) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_required");
    }
    if (!isCorrectionPreview(options.approvedCorrection)) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
    }

    const invoice = await this.getFreshInvoice(id);
    const freshPreview = this.buildTotalsCorrectionPreview(id, invoice, isVatRegistered);
    if (canonicalCorrectionJson(options.approvedCorrection) !== canonicalCorrectionJson(freshPreview)) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
    }

    if (freshPreview.correction_required) {
      await this.update(id, {
        vat_price: freshPreview.proposed_vat_price,
        gross_price: freshPreview.proposed_gross_price,
        items: invoice.items,
      });
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

  // getDocument / uploadDocument / deleteDocument are inherited from BaseResource
  // (document_user is generic across purchase_invoices, sale_invoices, journals,
  // and transactions).
}
