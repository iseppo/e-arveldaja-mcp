import type { Account, CreatePurchaseInvoiceData, PurchaseInvoice } from "../types/api.js";
import { canonicalPlanJson, stripUndefinedDeep } from "../tools/camt-plan.js";
import { normalizeItemsForNonVat, predictPurchaseItemAmounts, previewPurchaseInvoiceTotals } from "../api/purchase-invoices.api.js";
import { applyPurchaseItemStructuralDefaults, classifyNonVatInvoiceForm } from "../tools/purchase-vat-defaults.js";
import { parseVatRateDropdown, roundMoney } from "../money.js";

/** sha256 of the canonical created draft (§5.5): what the owner approved and confirm compares before register. */
export { draftFingerprint } from "../purchase-invoice-draft-fingerprint.js";

/** Money fields: compared as numbers within half a cent (a numeric string reads as its number). */
const READBACK_MONEY_FIELDS: ReadonlySet<string> = new Set([
  "net_price", "vat_price", "gross_price", "base_net_price", "base_vat_price", "base_gross_price",
  "total_net_price", "unit_net_price", "base_total_net_price", "vat_amount", "project_no_vat_gross_price",
]);
/** Other numeric fields (rates, quantities, day counts, ids): compared as exact numbers, a numeric string read as its number. */
const READBACK_NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  "currency_rate", "vat_rate", "overdue_charge", "amount", "term_days",
  "clients_id", "subclients_id", "liability_accounts_id", "liability_accounts_dimensions_id", "cash_accounts_id", "cash_accounts_dimensions_id",
  "cl_purchase_articles_id", "purchase_accounts_id", "purchase_accounts_dimensions_id", "vat_accounts_id", "vat_accounts_dimensions_id",
  "cl_vat_articles_id", "cl_fringe_benefits_id", "reversed_vat_id", "products_id", "projects_project_id", "projects_location_id", "projects_person_id",
]);

const asNumber = (value: unknown) => (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value);

/**
 * Field-aware equality: money within half a cent, other numeric fields exact, and every other field (invoice number,
 * reference, IBAN, notes, titles, …) exact after trimming a string, never coerced to a number.
 */
const sameValue = (key: string, expectedRaw: unknown, actualRaw: unknown): boolean => {
  if (READBACK_MONEY_FIELDS.has(key) || READBACK_NUMERIC_FIELDS.has(key)) {
    const expected = asNumber(expectedRaw);
    const actual = asNumber(actualRaw);
    if (typeof expected !== "number" || typeof actual !== "number") return false;
    return READBACK_MONEY_FIELDS.has(key) ? Math.abs(expected - actual) < 0.005 : expected === actual;
  }
  if (typeof expectedRaw === "string" && typeof actualRaw === "string") return expectedRaw.trim() === actualRaw.trim();
  if (typeof expectedRaw === "object" && expectedRaw !== null && typeof actualRaw === "object" && actualRaw !== null) {
    return canonicalPlanJson(stripUndefinedDeep(expectedRaw)) === canonicalPlanJson(stripUndefinedDeep(actualRaw));
  }
  return expectedRaw === actualRaw;
};

/** A returned null or "" counts as absent, like an omitted field. */
const isAbsent = (value: unknown) => value === undefined || value === null || value === "";

/**
 * §5.5 readback, deny by default: header fields that may differ from the approved write model. Every other field the
 * readback carries, known or new, must equal the model (or, where the model has none, be absent or a listed default),
 * and every field the model or the predictor expects must be present: the live GET returns every material header and
 * item field (live presence check 2026-10-18), so an omitted one fails closed.
 */
const READBACK_HEADER_ALLOWED_TO_DIFFER: ReadonlySet<string> = new Set([
  "id", // server id of the new draft
  "status", "payment_status", "registered", "register_date", "is_deleted", // registration and payment state register itself sets
  "journals", "settlements", "transactions", "bank_payment_orders_id", // ledger and payment links the server fills in
  "insert_date", "modified_at", // server timestamps
  "base_document_files_id", "is_xls_imported", // document/attachment metadata (the source upload, the import origin)
]);
const READBACK_ITEM_ALLOWED_TO_DIFFER: ReadonlySet<string> = new Set([
  "id", // server id of the item row
  "unit", // the quantity's unit label: no posting effect (the amounts are compared)
]);

/**
 * The values the API returns for a field the approved model leaves out. Expected absent means read back absent
 * (undefined, null, "") or one of these; anything else, on any field, is a mismatch.
 */
const READBACK_HEADER_DEFAULTS: Readonly<Record<string, readonly unknown[]>> = {
  term_days: [0], currency_rate: [1], paid_in_cash: [false], overdue_charge: [0],
};

function readbackFieldMatches(key: string, expected: unknown, actual: unknown, defaults: readonly unknown[]): boolean {
  if (isAbsent(expected)) return isAbsent(actual) || defaults.some((entry) => sameValue(key, entry, actual));
  return !isAbsent(actual) && sameValue(key, expected, actual);
}

/** Fields of `actual` or `expected`, minus those allowed to differ, that do not match. */
function recordMismatches(
  expected: Record<string, unknown>, actual: Record<string, unknown>, allowed: ReadonlySet<string>, defaultsOf: (key: string) => readonly unknown[],
): string[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((key) => !allowed.has(key));
  return keys.filter((key) => !readbackFieldMatches(key, expected[key], actual[key], defaultsOf(key)));
}

/**
 * §5.5: the fields of the created draft, as read back, that differ from the approved write model, deny by default:
 * every header and item field (item count and order included) except the allowlists above. The expected write is what
 * createAndSetTotals sends (non-VAT item normalisation, last-item gross residue, the #62 structural defaults); the
 * server-derived amounts (invoice net/VAT/gross and base amounts, item VAT, VAT rate, unit and base net) are predicted
 * from it with the repo's own amount predictor and must be read back.
 */
export function draftReadbackMismatches(
  draft: PurchaseInvoice, model: CreatePurchaseInvoiceData, totals: { vatPrice?: number; grossPrice?: number }, isVatRegistered: boolean,
  accounts?: readonly Account[],
): string[] {
  const preview = previewPurchaseInvoiceTotals(model, totals.vatPrice, totals.grossPrice, isVatRegistered, accounts);
  const nonDeductible = !isVatRegistered && classifyNonVatInvoiceForm(model.items, accounts) === "non_deductible";
  const normalized = normalizeItemsForNonVat(model.items, isVatRegistered, totals.grossPrice, nonDeductible);
  const expectedItems = preview.ok && preview.lastItemGross !== undefined && normalized.length > 0
    ? [...normalized.slice(0, -1), { ...normalized[normalized.length - 1]!, project_no_vat_gross_price: preview.lastItemGross }]
    : normalized;
  const amounts = predictPurchaseItemAmounts(expectedItems);
  const expectedNet = roundMoney(amounts.reduce((sum, entry) => sum + entry.net, 0));
  const expectedVat = preview.ok ? preview.vat : totals.vatPrice;
  const expectedGross = preview.ok ? preview.gross : totals.grossPrice;
  const base = preview.ok ? preview.base : undefined;

  const { items: draftItems, ...draftHeader } = draft;
  const { items: _modelItems, ...modelHeader } = model;
  const expectedHeader: Record<string, unknown> = {
    ...modelHeader, net_price: expectedNet, vat_price: expectedVat, gross_price: expectedGross,
    // EUR base amounts mirror the totals; foreign ones are the preview's conversion.
    base_net_price: model.base_net_price ?? base?.net ?? expectedNet,
    base_vat_price: model.base_vat_price ?? base?.vat ?? expectedVat,
    base_gross_price: model.base_gross_price ?? base?.gross ?? expectedGross,
    // The create payload never sends payment_type: its first readback is the baseline, which draftFingerprint binds
    // at confirm, so a later change is draft_changed. A model that did send one is compared exactly.
    payment_type: (modelHeader as Record<string, unknown>).payment_type ?? draft.payment_type,
  };
  const fields = recordMismatches(expectedHeader, draftHeader as Record<string, unknown>, READBACK_HEADER_ALLOWED_TO_DIFFER,
    (key) => READBACK_HEADER_DEFAULTS[key] ?? []);

  const items = draftItems ?? [];
  if (items.length !== expectedItems.length) return [...fields, "items"];
  const rate = model.currency_rate ?? 1;
  // Observed live folded EUR rows clear these three VAT fields to null.
  // This is one exact single-cost-row equivalence, not null == zero generally.
  const foldedNulls = !isVatRegistered && expectedItems.length === 1
    && (model.cl_currencies_id ?? "EUR") === "EUR" && (draft.cl_currencies_id ?? "EUR") === "EUR"
    && expectedItems[0]!.vat_rate_dropdown === "-" && items[0]!.vat_rate_dropdown === "-"
    && expectedItems[0]!.cl_vat_articles_id === 11
    && (expectedItems[0]!.vat_rate == null || expectedItems[0]!.vat_rate === 0)
    && (expectedItems[0]!.vat_amount == null || expectedItems[0]!.vat_amount === 0)
    && [expectedItems[0]!, items[0]!].every(row => (row.vat_accounts_id ?? null) === null && (row.vat_accounts_dimensions_id ?? null) === null && (row.reversed_vat_id ?? null) === null)
    && preview.ok && preview.vat === 0 && draft.vat_price === 0
    && sameValue("gross_price", preview.gross, draft.gross_price)
    && sameValue("net_price", preview.gross, draft.net_price)
    && [expectedItems[0]!, items[0]!].every(row => sameValue("total_net_price", preview.gross, row.total_net_price)
      && sameValue("project_no_vat_gross_price", preview.gross, row.project_no_vat_gross_price))
    && items[0]!.vat_amount === null && items[0]!.vat_rate === null && items[0]!.cl_vat_articles_id === null;
  expectedItems.map(applyPurchaseItemStructuralDefaults).forEach((item, index) => {
    const { net, vat } = amounts[index]!;
    const actual = items[index] as unknown as Record<string, unknown>;
    // Observed live (2026-10-26, Google reverse-charge rows): on a 0% row of a VAT-registered company the API
    // clears the VAT account and VAT article the create sent; with no VAT there is no VAT posting either way.
    const zeroRateNulls = isVatRegistered && item.vat_rate_dropdown === "0" && vat === 0
      && actual.vat_accounts_id === null && actual.cl_vat_articles_id === null && (actual.vat_accounts_dimensions_id ?? null) === null;
    const expected: Record<string, unknown> = {
      ...item, total_net_price: net, vat_amount: vat,
      vat_rate: item.vat_rate ?? parseVatRateDropdown(item.vat_rate_dropdown),
      base_total_net_price: item.base_total_net_price ?? roundMoney(net / rate),
      ...(foldedNulls ? { vat_amount: null, vat_rate: null, cl_vat_articles_id: null } : {}),
      ...(zeroRateNulls ? { vat_accounts_id: null, cl_vat_articles_id: null, vat_accounts_dimensions_id: null } : {}),
    };
    // Not sent: the API leaves it empty or echoes the predicted value (live 2026-10-18: unit_net_price reads back null).
    const defaults = (field: string) => (field === "project_no_vat_gross_price" ? [roundMoney(net + vat)]
      : field === "unit_net_price" ? [roundMoney(net / (item.amount ?? 1))] : []);
    for (const key of recordMismatches(expected, actual, READBACK_ITEM_ALLOWED_TO_DIFFER, defaults)) fields.push(`items[${index}].${key}`);
  });
  return fields;
}
