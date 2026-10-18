import { createHash } from "node:crypto";
import type { HttpClient } from "../http-client.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, CreatePurchaseInvoiceData, ApiResponse } from "../types/api.js";
import type { CreatePurchaseInvoiceRequest, UpdatePurchaseInvoiceRequest } from "../types/mutations.js";
import { BaseResource } from "./base-resource.js";
import { roundMoney, parseVatRateDropdown } from "../money.js";
import { applyPurchaseItemStructuralDefaults } from "../tools/purchase-vat-defaults.js";

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
export function normalizeItemsForNonVat(
  items: PurchaseInvoiceItem[],
  isVatRegistered: boolean,
  grossPrice?: number,
) : PurchaseInvoiceItem[] {
  if (!items || isVatRegistered) return items;

  // Multi-item invoice with a known invoice gross: distribute that gross across
  // the items pro rata to their net, cent-exact with the remainder on the last
  // item. Non-VAT defaults force vat_rate_dropdown "-", so a per-item rate
  // cannot be derived and the gross would otherwise collapse to net.
  if (items.length > 1 && grossPrice !== undefined && items.every(item => item.project_no_vat_gross_price == null)) {
    const nets = items.map(item => item.total_net_price
      ?? (item.unit_net_price !== undefined && item.amount !== undefined
        ? roundMoney(item.unit_net_price * item.amount)
        : undefined));
    if (nets.every((net): net is number => net !== undefined)) {
      const netCents = nets.map(net => Math.round(net * 100));
      const totalNetCents = netCents.reduce((sum, cents) => sum + cents, 0);
      if (totalNetCents !== 0) {
        const grossCents = Math.round(grossPrice * 100);
        let allocated = 0;
        return items.map((item, idx) => {
          const share = idx === items.length - 1
            ? grossCents - allocated
            : Math.round(grossCents * netCents[idx]! / totalNetCents);
          allocated += share;
          return { ...item, project_no_vat_gross_price: share / 100 };
        });
      }
    }
  }

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

/** Net and VAT of one invoice item, predicted before create or read back after it. */
export interface PurchaseItemAmounts {
  net: number;
  vat: number;
}

export type PurchaseInvoiceTotalsResolution =
  | {
      ok: true;
      vat: number;
      gross: number;
      /** New project_no_vat_gross_price of the last item, absorbing a per-line VAT rounding residue. */
      lastItemGross?: number;
      /** EUR base trio, foreign-currency invoices only. */
      base?: { net: number; vat: number; gross: number };
    }
  | {
      ok: false;
      code: "currency_rate_required" | "purchase_totals_mismatch" | "purchase_base_sign_mismatch";
      message: string;
    };

/**
 * The invoice-level totals rules of createAndSetTotals, as a pure function.
 * Runs before create on predicted item amounts and after the read-back on the
 * API's item amounts, so both stages refuse with the same rules.
 *
 * `items` are the items the PATCH would send (their count sets the rounding
 * tolerance, a `reversed_vat_id` exempts the residue check, and the last one
 * absorbs the residue); `itemAmounts` are the item net/VAT figures, indexed
 * like the API items.
 */
export function resolvePurchaseInvoiceTotals(input: {
  data: CreatePurchaseInvoiceData;
  vatPrice?: number;
  grossPrice?: number;
  isVatRegistered: boolean;
  items: readonly PurchaseInvoiceItem[] | undefined;
  itemAmounts: readonly PurchaseItemAmounts[] | undefined;
}): PurchaseInvoiceTotalsResolution {
  const { data, vatPrice, grossPrice, isVatRegistered, items, itemAmounts } = input;
  const currency = (data.cl_currencies_id ?? "EUR").toUpperCase();
  const isForeignCurrency = currency !== "EUR";
  if (isForeignCurrency && (data.currency_rate === undefined || data.currency_rate === null || !Number.isFinite(data.currency_rate) || data.currency_rate <= 0)) {
    return {
      ok: false,
      code: "currency_rate_required",
      message: `currency_rate is required when cl_currencies_id="${currency}". ` +
        `Pass the ${currency}-per-1-EUR rate (for Wise card payments use Target amount / Source amount from the Wise CSV).`,
    };
  }

  const itemVat = itemAmounts ? roundMoney(itemAmounts.reduce((s, i) => s + i.vat, 0)) : 0;
  const itemNet = itemAmounts ? roundMoney(itemAmounts.reduce((s, i) => s + i.net, 0)) : 0;

  // Invoice-level VAT: explicit value wins for VAT-registered companies.
  // Non-VAT companies must keep invoice-level vat_price at 0 even if item VAT is tracked.
  const vat = isVatRegistered
    ? (vatPrice !== undefined ? vatPrice : itemVat)
    : 0;

  // Invoice-level gross: explicit value wins, otherwise net + actual item VAT
  const gross = grossPrice !== undefined
    ? grossPrice
    : roundMoney(itemNet + itemVat);

  // When explicit VAT differs from item-computed VAT (rounding), adjust
  // project_no_vat_gross_price on the last item so the API computes matching totals.
  let lastItemGross: number | undefined;
  if (items && items.length > 0 && vatPrice !== undefined && isVatRegistered && itemVat !== vatPrice) {
    const vatDiff = roundMoney(vatPrice - itemVat);
    // Only a per-line rounding residue (≤ 1 cent per item) may be absorbed.
    // A larger gap means the explicit totals disagree with the items; the
    // reverse-charge path (item VAT ≠ invoice VAT by design) keeps the
    // pre-existing behaviour.
    const isReverseCharge = items.some(item => item.reversed_vat_id !== undefined && item.reversed_vat_id !== null);
    if (!isReverseCharge && Math.abs(vatDiff) > roundMoney(0.01 * items.length) + 1e-9) {
      return {
        ok: false,
        code: "purchase_totals_mismatch",
        message: `Purchase invoice totals mismatch: explicit vat_price ${vatPrice} differs from the item-computed VAT ${itemVat} ` +
          `by ${vatDiff}, more than the ${roundMoney(0.01 * items.length)} rounding tolerance for ${items.length} item(s). ` +
          "Fix the item net amounts / VAT rates or the invoice totals.",
      };
    }
    const lastItem = items[items.length - 1]!;
    const currentGross = lastItem.project_no_vat_gross_price
      ?? roundMoney((lastItem.total_net_price ?? 0) + (itemAmounts?.[items.length - 1]?.vat ?? 0));
    lastItemGross = roundMoney(currentGross + vatDiff);
  }

  if (!isForeignCurrency) return { ok: true, vat, gross, ...(lastItemGross !== undefined ? { lastItemGross } : {}) };

  const rate = data.currency_rate!;
  const net = roundMoney(itemNet);
  // currency_rate is FOREIGN units per 1 EUR, so EUR = foreign / rate.
  const baseGross = data.base_gross_price ?? roundMoney(gross / rate);
  // With an explicit EUR gross (actual settlement), split it in the
  // invoice's own net/gross proportion rather than re-deriving net from
  // the nominal rate — otherwise a 0-VAT invoice gets a phantom base VAT.
  const baseNet = data.base_net_price ?? (
    data.base_gross_price !== undefined && gross !== 0
      ? roundMoney(net * baseGross / gross)
      : roundMoney(net / rate)
  );
  // Derive base_vat as the residual of base_gross − base_net so the trio
  // reconciles exactly (base_net + base_vat === base_gross). Rounding net,
  // vat, and gross independently against the rate can leave them off by a
  // cent, which fails API sum validation or re-trips currency rounding.
  const baseVat = data.base_vat_price ?? roundMoney(baseGross - baseNet);

  // The EUR base of an amount cannot have the opposite sign of the amount.
  // Only opposite NONZERO signs are refused: a non-VAT invoice posts VAT 0
  // while its informational base VAT may be positive.
  const oppositeSigns = (a: number, b: number) => a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b);
  const mismatched = [
    oppositeSigns(baseNet, net) ? `base_net_price ${baseNet} vs net ${net}` : undefined,
    oppositeSigns(baseVat, vat) ? `base_vat_price ${baseVat} vs vat_price ${vat}` : undefined,
    oppositeSigns(baseGross, gross) ? `base_gross_price ${baseGross} vs gross_price ${gross}` : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  if (mismatched.length > 0) {
    return {
      ok: false,
      code: "purchase_base_sign_mismatch",
      message: `Purchase invoice base (EUR) amounts have the opposite sign of the document-currency amounts: ${mismatched.join(", ")}. ` +
        "Fix the base_* amounts or the invoice totals.",
    };
  }

  return {
    ok: true,
    vat,
    gross,
    ...(lastItemGross !== undefined ? { lastItemGross } : {}),
    base: { net: baseNet, vat: baseVat, gross: baseGross },
  };
}

/**
 * Item net/VAT the API is expected to compute on create: net from
 * total_net_price (else unit price × quantity), VAT from
 * project_no_vat_gross_price when set, else net × the dropdown rate.
 */
export function predictPurchaseItemAmounts(items: readonly PurchaseInvoiceItem[]): PurchaseItemAmounts[] {
  return items.map(item => {
    const net = item.total_net_price
      ?? (item.unit_net_price !== undefined ? roundMoney(item.unit_net_price * (item.amount ?? 1)) : 0);
    const vat = item.project_no_vat_gross_price != null
      ? roundMoney(item.project_no_vat_gross_price - net)
      : roundMoney(net * parseVatRateDropdown(item.vat_rate_dropdown) / 100);
    return { net, vat };
  });
}

/**
 * Pre-write check of createAndSetTotals' totals rules on predicted item
 * amounts. Call it before any mutation (supplier creation, upload, create) so
 * totals the API would refuse after create cause zero writes.
 */
export function previewPurchaseInvoiceTotals(
  data: CreatePurchaseInvoiceData,
  vatPrice: number | undefined,
  grossPrice: number | undefined,
  isVatRegistered: boolean,
): PurchaseInvoiceTotalsResolution {
  const normalizedItems = normalizeItemsForNonVat(data.items, isVatRegistered, grossPrice);
  return resolvePurchaseInvoiceTotals({
    data,
    vatPrice,
    grossPrice,
    isVatRegistered,
    items: normalizedItems,
    itemAmounts: normalizedItems ? predictPurchaseItemAmounts(normalizedItems) : undefined,
  });
}

export class PurchaseInvoicesApi extends BaseResource<PurchaseInvoice> {
  constructor(client: HttpClient) {
    super(client, "/purchase_invoices");
  }

  // Narrow the create/update boundary from `Partial<PurchaseInvoice>` to request
  // types that omit server-managed fields (id, status, payment_status,
  // journals/settlements/transactions back-refs, …). Delegates to the base
  // mutate/cache logic; the internal createAndSetTotals / confirmWithTotals paths
  // call through these overrides unchanged.
  override async create(data: CreatePurchaseInvoiceRequest): Promise<ApiResponse> {
    return super.create(data);
  }

  override async update(id: number, data: UpdatePurchaseInvoiceRequest): Promise<ApiResponse> {
    return super.update(id, data);
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
   * data.currency_rate is required (foreign units per 1 EUR, ECB convention —
   * e.g. USD 1.08 means 1 EUR = 1.08 USD). base_net_price /
   * base_vat_price / base_gross_price can be supplied explicitly to match the
   * actual EUR settlement (e.g. Wise card-payment rate); otherwise they are
   * auto-derived as round(amount / currency_rate, 2). For EUR invoices the
   * base_* fields are forced to mirror the foreign-currency totals so the
   * server-side payment matcher does not see a phantom rounding gap.
   */
  async createAndSetTotals(
    data: CreatePurchaseInvoiceData,
    vatPrice?: number,
    grossPrice?: number,
    isVatRegistered = true,
  ): Promise<PurchaseInvoice> {
    // Same totals rules as after the read-back, on predicted item amounts:
    // totals the API would refuse are refused before the draft exists.
    const preview = previewPurchaseInvoiceTotals(data, vatPrice, grossPrice, isVatRegistered);
    if (!preview.ok) throw new Error(preview.message);
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

      // Merge API-returned item IDs back into our original items (preserving
      // cl_fringe_benefits_id and other fields the API GET doesn't return).
      // If the API items have different count (shouldn't happen), fall back to API items.
      // Both branches go through the #62 structural defaults: the API requires
      // cl_fringe_benefits_id/amount on every PATCH row but does not echo them.
      const patchItems = (apiItems && apiItems.length === normalizedItems.length
        ? normalizedItems.map((orig, idx) => ({
            ...orig,
            id: apiItems[idx]!.id,
            // Let the API recompute vat_amount from our fields
          }))
        : apiItems)?.map(applyPurchaseItemStructuralDefaults);

      const totals = resolvePurchaseInvoiceTotals({
        data,
        vatPrice,
        grossPrice,
        isVatRegistered,
        items: patchItems,
        itemAmounts: apiItems?.map(item => ({ net: item.total_net_price ?? 0, vat: item.vat_amount ?? 0 })),
      });
      if (!totals.ok) throw new Error(totals.message);

      // Apply the rounding difference to the last item's gross
      if (totals.lastItemGross !== undefined) {
        patchItems![patchItems!.length - 1]!.project_no_vat_gross_price = totals.lastItemGross;
      }

      const patchPayload: Partial<PurchaseInvoice> = {
        vat_price: totals.vat,
        gross_price: totals.gross,
        items: patchItems,
      };

      if (totals.base) {
        patchPayload.cl_currencies_id = (data.cl_currencies_id ?? "EUR").toUpperCase();
        patchPayload.currency_rate = data.currency_rate!;
        patchPayload.base_net_price = totals.base.net;
        patchPayload.base_vat_price = totals.base.vat;
        patchPayload.base_gross_price = totals.base.gross;
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
        items: invoice.items?.map(applyPurchaseItemStructuralDefaults),
      });
    }
    return this.confirm(id);
  }

  async confirm(id: number): Promise<ApiResponse> {
    // Registering a purchase invoice creates a journal server-side and can
    // flip payment_status on any linked transaction — bust both caches.
    return this.mutate(
      "confirm",
      id,
      `/purchase_invoices:${id}:register`,
      ["/purchase_invoices", "/journals", "/transactions"],
      () => this.client.patch<ApiResponse>(`/purchase_invoices/${id}/register`, {}),
      `Re-read purchase invoice ${id} and check whether it is already confirmed before retrying.`,
    );
  }

  async invalidate(id: number): Promise<ApiResponse> {
    return this.mutate(
      "invalidate",
      id,
      `/purchase_invoices:${id}:invalidate`,
      ["/purchase_invoices", "/journals", "/transactions"],
      () => this.client.patch<ApiResponse>(`/purchase_invoices/${id}/invalidate`, {}),
      `Re-read purchase invoice ${id} and check whether it is already invalidated before retrying.`,
    );
  }

  // getDocument / uploadDocument / deleteDocument are inherited from BaseResource
  // (document_user is generic across purchase_invoices, sale_invoices, journals,
  // and transactions).
}
