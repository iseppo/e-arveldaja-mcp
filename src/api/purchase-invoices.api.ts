import { createHash } from "node:crypto";
import type { HttpClient } from "../http-client.js";
import type { Account, PurchaseInvoice, PurchaseInvoiceItem, CreatePurchaseInvoiceData, ApiResponse } from "../types/api.js";
import type { CreatePurchaseInvoiceRequest, UpdatePurchaseInvoiceRequest } from "../types/mutations.js";
import { BaseResource } from "./base-resource.js";
import { draftFingerprint } from "../purchase-invoice-draft-fingerprint.js";
import { roundMoney, parseVatRateDropdown } from "../money.js";
import { classifyMutationFailure } from "../mutation-outcome.js";
import {
  applyPurchaseItemStructuralDefaults,
  classifyNonVatInvoiceForm,
  hasVatAccountFields,
  normalizeVatRate,
  nonVatRegisterRefusal,
  proveNonDeductibleInvoice,
} from "../tools/purchase-vat-defaults.js";

export class InvoiceCreationError extends Error {
  readonly cleanup: "invalidated" | "failed" | "unknown";
  readonly cleanupError?: unknown;
  constructor(message: string, public readonly invoiceId: number, options?: ErrorOptions & { cleanup?: "invalidated" | "failed" | "unknown"; cleanupError?: unknown }) {
    super(message, options);
    this.name = "InvoiceCreationError";
    this.cleanup = options?.cleanup ?? "unknown";
    this.cleanupError = options?.cleanupError;
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

export class PurchaseInvoiceDraftVerificationError extends Error {
  constructor(public readonly code: "draft_changed" | "draft_readback_unavailable", options?: ErrorOptions) {
    super(code === "draft_changed" ? "The purchase invoice differs from the reviewed PROJECT draft." : "The reviewed purchase invoice could not be read fresh.", options);
    this.name = "PurchaseInvoiceDraftVerificationError";
  }
}

interface ConfirmPurchaseInvoiceOptions {
  expectedDraftFingerprint?: string;
  recalculateTotals?: boolean;
  approvedCorrection?: PurchaseInvoiceTotalsCorrectionPreview;
  /** Fresh chart for the non-VAT register proof (GitHub #63); a non-VAT draft with a VAT-account item is held without it. */
  accounts?: readonly Account[];
}

export type PurchaseInvoiceTotalsCorrectionCode =
  | "correction_invoice_not_project"
  | "correction_currency_not_supported"
  | "correction_reverse_charge_not_supported"
  | "correction_items_missing"
  | "correction_preview_required"
  | "correction_preview_mismatch"
  | "correction_nonvat_form_unproven";

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
  correction_nonvat_form_unproven: {
    message: "Non-VAT purchase invoice carries a VAT account that is not a proven non-deductible form (VAT on the cost account, cent-exact, EUR); it is not registered.",
    nextAction: "Fix the rows and totals in e-arveldaja (VAT account = the item's cost account, article 11, one rate, invoice VAT = item VAT sum), or delete the draft and recreate it.",
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
 * The non-deductible form (GitHub #63) is left unchanged: its VAT is real.
 */
export function normalizeItemsForNonVat(
  items: PurchaseInvoiceItem[],
  isVatRegistered: boolean,
  grossPrice?: number,
  nonDeductible = false,
) : PurchaseInvoiceItem[] {
  if (!items || isVatRegistered || nonDeductible) return items;

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
      code: "currency_rate_required" | "purchase_totals_mismatch" | "purchase_base_sign_mismatch" | "nonvat_form_unproven";
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
  /** A non-VAT invoice in the proven non-deductible form: its VAT is the invoice VAT, as for VAT-registered. */
  nonDeductible?: boolean;
}): PurchaseInvoiceTotalsResolution {
  const { data, vatPrice, grossPrice, items, itemAmounts } = input;
  const isVatRegistered = input.isVatRegistered || input.nonDeductible === true;
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
  accounts?: readonly Account[],
): PurchaseInvoiceTotalsResolution {
  if (!isVatRegistered && data.items?.some(hasVatAccountFields)) {
    return previewNonDeductibleTotals(data, vatPrice, grossPrice, accounts);
  }
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

type TotalsFailure = Extract<PurchaseInvoiceTotalsResolution, { ok: false }>;
type TotalsSuccess = Extract<PurchaseInvoiceTotalsResolution, { ok: true }>;

/**
 * P1 (GitHub #63): a non-VAT invoice whose items carry a VAT account must be
 * the proven non-deductible form before anything is written. Returns the
 * totals and the intended rows after the last-row residue (the immutable
 * baseline createAndSetTotals writes and compares against).
 */
function resolveNonDeductibleIntended(
  data: CreatePurchaseInvoiceData,
  vatPrice: number | undefined,
  grossPrice: number | undefined,
  accounts: readonly Account[] | undefined,
): { ok: true; totals: TotalsSuccess; rows: PurchaseInvoiceItem[] } | { ok: false; totals: TotalsFailure } {
  const items = data.items;
  if (classifyNonVatInvoiceForm(items, accounts) !== "non_deductible") {
    return {
      ok: false,
      totals: {
        ok: false,
        code: "nonvat_form_unproven",
        message: "Non-VAT purchase invoice items carry a VAT account but are not the proven non-deductible form " +
          "(VAT account and dimension = the item's cost account and dimension, a non-VAT chart account, article 11, one rate). Nothing was created.",
      },
    };
  }
  const totals = resolvePurchaseInvoiceTotals({
    data, vatPrice, grossPrice, isVatRegistered: false, nonDeductible: true, items, itemAmounts: predictPurchaseItemAmounts(items),
  });
  if (!totals.ok) return { ok: false, totals };
  const last = items[items.length - 1]!;
  const suppliedOverride = last.project_no_vat_gross_price ?? null;
  // The residue is never placed on a caller-supplied override (it would rewrite it).
  if (totals.lastItemGross !== undefined && suppliedOverride !== null &&
      Math.round(totals.lastItemGross * 100) !== Math.round(suppliedOverride * 100)) {
    return {
      ok: false,
      totals: {
        ok: false,
        code: "purchase_totals_mismatch",
        message: `Purchase invoice totals mismatch: the invoice VAT differs from the item VAT and the last item's supplied project_no_vat_gross_price ${suppliedOverride} ` +
          "would have to change; it is never rewritten. Fix the item amounts or the invoice totals.",
      },
    };
  }
  const rows = totals.lastItemGross !== undefined
    ? [...items.slice(0, -1), { ...last, project_no_vat_gross_price: totals.lastItemGross }]
    : [...items];
  const net = roundMoney(predictPurchaseItemAmounts(rows).reduce((sum, entry) => sum + entry.net, 0));
  const proof = proveNonDeductibleInvoice(rows, {
    net_price: net,
    vat_price: totals.vat,
    gross_price: totals.gross,
    cl_currencies_id: data.cl_currencies_id,
    currency_rate: data.currency_rate,
    base_net_price: data.base_net_price,
    base_vat_price: data.base_vat_price,
    base_gross_price: data.base_gross_price,
  }, accounts, { intended: true });
  if (!proof.ok) {
    return {
      ok: false,
      totals: { ok: false, code: "purchase_totals_mismatch", message: `Purchase invoice totals mismatch (non-deductible VAT form): ${proof.reason}. Nothing was created.` },
    };
  }
  return { ok: true, totals, rows };
}

function previewNonDeductibleTotals(
  data: CreatePurchaseInvoiceData,
  vatPrice: number | undefined,
  grossPrice: number | undefined,
  accounts: readonly Account[] | undefined,
): PurchaseInvoiceTotalsResolution {
  return resolveNonDeductibleIntended(data, vatPrice, grossPrice, accounts).totals;
}

const sameCents = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && Math.round(a * 100) === Math.round(b * 100);

/**
 * P2/P3 (GitHub #63): read-back rows that differ from the immutable intended
 * baseline: count, accounts, dimensions, article, rate, reversed_vat_id and net;
 * after the PATCH (`afterPatch`), also the expected item VAT and, when
 * present, the gross override.
 */
function nonDeductibleBaselineMismatches(
  readBack: readonly PurchaseInvoiceItem[] | undefined,
  baseline: readonly PurchaseInvoiceItem[],
  afterPatch: boolean,
): string[] {
  const rows = readBack ?? [];
  if (rows.length !== baseline.length) return [`items (${rows.length} read back, ${baseline.length} intended)`];
  const amounts = predictPurchaseItemAmounts(baseline);
  const mismatches: string[] = [];
  baseline.forEach((expected, index) => {
    const actual = rows[index]!;
    const same = (field: keyof PurchaseInvoiceItem) => (expected[field] ?? null) === (actual[field] ?? null);
    for (const field of ["purchase_accounts_id", "purchase_accounts_dimensions_id", "vat_accounts_id", "vat_accounts_dimensions_id",
      "cl_vat_articles_id", "reversed_vat_id"] as const) {
      if (!same(field)) mismatches.push(`items[${index}].${field}`);
    }
    if (normalizeVatRate(expected.vat_rate_dropdown) !== normalizeVatRate(actual.vat_rate_dropdown)) mismatches.push(`items[${index}].vat_rate_dropdown`);
    const { net, vat } = amounts[index]!;
    if (!sameCents(actual.total_net_price, net)) mismatches.push(`items[${index}].total_net_price`);
    if (afterPatch) {
      if (!sameCents(actual.vat_amount, vat)) mismatches.push(`items[${index}].vat_amount`);
      const expectedOverride = expected.project_no_vat_gross_price ?? null;
      const actualOverride = actual.project_no_vat_gross_price ?? null;
      if (expectedOverride !== null ? !sameCents(actualOverride, expectedOverride)
        : actualOverride !== null && !sameCents(actualOverride, roundMoney(net + vat))) {
        mismatches.push(`items[${index}].project_no_vat_gross_price`);
      }
    }
  });
  return mismatches;
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
    accounts?: readonly Account[],
  ): Promise<PurchaseInvoice> {
    if (!isVatRegistered && data.items?.some(hasVatAccountFields)) {
      return this.createNonDeductible(data, vatPrice, grossPrice, accounts);
    }
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

      // A changed/missing row set cannot be matched back to the intended
      // nondefault fringe treatment. Never PATCH a default over that intent.
      // The standard follow-up failure path invalidates and retains the draft ID.
      if (apiItems?.length !== normalizedItems.length &&
        normalizedItems.some(item => item.cl_fringe_benefits_id != null && item.cl_fringe_benefits_id !== 1)) {
        throw new Error("Purchase invoice row count changed: cannot preserve the intended fringe-benefit classifiers without a proven row mapping.");
      }

      // Merge API-returned IDs into our original items, retaining explicit
      // caller fringe intent and any classifier supplied by newer GET responses.
      // If the API items have different count (shouldn't happen), fall back to API items.
      // Both branches retain #62 defaults for compatibility with older servers.
      const patchItems = (apiItems && apiItems.length === normalizedItems.length
        ? normalizedItems.map((orig, idx) => ({
            ...orig,
            id: apiItems[idx]!.id,
            cl_fringe_benefits_id: orig.cl_fringe_benefits_id ?? apiItems[idx]!.cl_fringe_benefits_id,
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
      return this.invalidateAfterFailedFollowUp(id, error);
    }
  }

  /** Invalidates a created draft whose follow-up failed and throws InvoiceCreationError (never returns). */
  private async invalidateAfterFailedFollowUp(id: number, error: unknown): Promise<never> {
    const followUpMessage = error instanceof Error ? error.message : String(error);
    try {
      await this.invalidate(id);
    } catch (invalidateError) {
      const invalidateMessage = invalidateError instanceof Error ? invalidateError.message : String(invalidateError);
      throw new InvoiceCreationError(
        `Purchase invoice ${id} was created but follow-up failed: ${followUpMessage}. ` +
        `Automatic invalidation also failed: ${invalidateMessage}`,
        id,
        { cause: error, cleanup: classifyMutationFailure(invalidateError) === "indeterminate" ? "unknown" : "failed", cleanupError: invalidateError },
      );
    }

    throw new InvoiceCreationError(
      `Purchase invoice ${id} was created but follow-up failed and the draft was invalidated: ${followUpMessage}`,
      id,
      { cause: error, cleanup: "invalidated" },
    );
  }

  /**
   * GitHub #63: create a non-VAT invoice in the non-deductible form (VAT on the
   * cost account). P1 proves the intended payload before the POST; P2 compares
   * the first read-back with the immutable intended rows before the PATCH; P3
   * proves the read-back after the PATCH. Any P2/P3 failure invalidates the draft.
   */
  private async createNonDeductible(
    data: CreatePurchaseInvoiceData,
    vatPrice: number | undefined,
    grossPrice: number | undefined,
    accounts: readonly Account[] | undefined,
  ): Promise<PurchaseInvoice> {
    const intended = resolveNonDeductibleIntended(data, vatPrice, grossPrice, accounts);
    if (!intended.ok) throw new Error(intended.totals.message);
    const { totals } = intended;
    const baseline: readonly PurchaseInvoiceItem[] = intended.rows.map(applyPurchaseItemStructuralDefaults);
    const response = await this.create({ ...data, items: data.items });
    const id = response.created_object_id;
    if (!id) throw new Error("Purchase invoice created but no ID returned");

    try {
      // P2: the first read-back must be the intended rows; never fall back to API rows.
      const first = await this.get(id);
      const p2 = nonDeductibleBaselineMismatches(first.items, baseline, false);
      if (p2.length > 0) throw new Error(`nonvat_form_unproven: the created rows differ from the intended rows (${p2.join(", ")})`);
      // The first GET precedes the totals PATCH. Prove the actual rows with
      // their own sums; its invoice totals (and matching base totals) are not
      // final yet. Currency, row base nets and every shape/amount rule still apply.
      const firstNet = roundMoney(first.items!.reduce((sum, item) => sum + item.total_net_price!, 0));
      const firstVat = roundMoney(first.items!.reduce((sum, item) => sum + item.vat_amount!, 0));
      const firstProof = proveNonDeductibleInvoice(first.items!, {
        cl_currencies_id: first.cl_currencies_id, currency_rate: first.currency_rate,
        net_price: firstNet, vat_price: firstVat, gross_price: roundMoney(firstNet + firstVat),
      }, accounts);
      if (!firstProof.ok) throw new Error(`nonvat_form_unproven: ${firstProof.reason}`);

      await this.update(id, {
        vat_price: totals.vat,
        gross_price: totals.gross,
        items: baseline.map((item, index) => ({ ...item, id: first.items![index]!.id })),
      });

      // P3: the stored draft must be exactly the intended one, and proven.
      const stored = await this.getFreshInvoice(id);
      const p3 = nonDeductibleBaselineMismatches(stored.items, baseline, true);
      const expectedNet = roundMoney(predictPurchaseItemAmounts(baseline).reduce((sum, entry) => sum + entry.net, 0));
      if (!sameCents(stored.net_price, expectedNet)) p3.push("net_price");
      if (!sameCents(stored.vat_price, totals.vat)) p3.push("vat_price");
      if (!sameCents(stored.gross_price, totals.gross)) p3.push("gross_price");
      if (p3.length > 0) throw new Error(`nonvat_form_unproven: the stored draft differs from the intended one (${p3.join(", ")})`);
      const proof = proveNonDeductibleInvoice(stored.items ?? [], stored, accounts);
      if (!proof.ok) throw new Error(`nonvat_form_unproven: ${proof.reason}`);
      return stored;
    } catch (error) {
      return this.invalidateAfterFailedFollowUp(id, error);
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
    accounts?: readonly Account[],
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

    const currentVat = invoice.vat_price ?? null;
    const currentGross = invoice.gross_price ?? null;
    // GitHub #63: no correction PATCH for a non-VAT invoice with a VAT-account
    // item. A proven one already has consistent totals (no correction); an
    // unproven one has nothing to approve.
    const nonVatWithVatAccount = !isVatRegistered && invoice.items.some(hasVatAccountFields);
    if (nonVatWithVatAccount && nonVatRegisterRefusal(invoice, accounts) !== undefined) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_nonvat_form_unproven");
    }
    const itemVat = roundMoney(invoice.items.reduce((sum, item) => sum + (item.vat_amount ?? 0), 0));
    const itemNet = roundMoney(invoice.items.reduce((sum, item) => sum + (item.total_net_price ?? 0), 0));
    const proposedVat = nonVatWithVatAccount ? currentVat! : isVatRegistered ? itemVat : 0;
    const proposedGross = nonVatWithVatAccount ? currentGross! : roundMoney(itemNet + itemVat);
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
    accounts?: readonly Account[],
  ): Promise<PurchaseInvoiceTotalsCorrectionPreview> {
    const invoice = await this.getFreshInvoice(id);
    return this.buildTotalsCorrectionPreview(id, invoice, isVatRegistered, accounts);
  }

  /**
   * Confirm without changing totals unless an exact fresh correction preview was approved.
   * A non-VAT invoice is read fresh first: one with a VAT-account item registers only
   * when proveNonDeductibleInvoice accepts it against `options.accounts` (P4, GitHub #63).
   */
  async confirmWithTotals(
    id: number,
    isVatRegistered = true,
    options: ConfirmPurchaseInvoiceOptions = {},
  ): Promise<ApiResponse> {
    if (!options.recalculateTotals) {
      if (options.approvedCorrection !== undefined) {
        throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
      }
      if (!isVatRegistered) {
        let draft: PurchaseInvoice;
        try { draft = await this.getFreshInvoice(id); }
        catch (error) {
          if (options.expectedDraftFingerprint !== undefined) throw new PurchaseInvoiceDraftVerificationError("draft_readback_unavailable", { cause: error });
          throw error;
        }
        if (nonVatRegisterRefusal(draft, options.accounts) !== undefined) throw new PurchaseInvoiceTotalsCorrectionError("correction_nonvat_form_unproven");
      }
      return this.confirm(id, { expectedDraftFingerprint: options.expectedDraftFingerprint });
    }
    if (options.approvedCorrection === undefined) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_required");
    }
    if (!isCorrectionPreview(options.approvedCorrection)) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
    }

    const invoice = await this.getFreshInvoice(id);
    const freshPreview = this.buildTotalsCorrectionPreview(id, invoice, isVatRegistered, options.accounts);
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
    return this.confirm(id, { expectedDraftFingerprint: options.expectedDraftFingerprint });
  }

  async confirm(id: number, options: { expectedDraftFingerprint?: string } = {}): Promise<ApiResponse> {
    if (options.expectedDraftFingerprint !== undefined) {
      let draft: PurchaseInvoice;
      try { draft = await this.getFreshInvoice(id); }
      catch { throw new PurchaseInvoiceDraftVerificationError("draft_readback_unavailable"); }
      if (draft.id !== id || draft.status !== "PROJECT" || draftFingerprint(draft) !== options.expectedDraftFingerprint) {
        throw new PurchaseInvoiceDraftVerificationError("draft_changed");
      }
    }
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
