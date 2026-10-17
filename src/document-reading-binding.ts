// PURE module (P1 reading checker): supplier binding, booking binding and the
// duplicate-key / duplicate-hold mapping, all over data the caller injects
// (clients, the proposed booking, the scanner outputs). No IO.
// Plan: .omc/plans/p1-reading-checker.md §2.6 (design §3.5, §3.6).

import { normalizeVatValue } from "./document-identifiers.js";
import { parseVatRateDropdown } from "./money.js";
import { normalizeInvoiceNumberForComparison } from "./purchase-invoice-status.js";
import { parseStrictDate } from "./strict-date.js";
import type { Client } from "./types/api.js";
import { HOLD_CODES, type AcceptedValues, type HoldClass, type HoldCode } from "./document-reading-check.js";
import type { ReadingField } from "./document-reading-schemas.js";

/** The booking fields a binding hold can name (CreatePurchaseInvoiceData names). */
export type BookingField =
  | "clients_id"
  | "number"
  | "create_date"
  | "cl_currencies_id"
  | "gross_price"
  | "vat_price"
  | "items"
  | "term_days";

export interface BindingHold { code: HoldCode; field?: ReadingField | BookingField; class: HoldClass }

function bindingHold(code: HoldCode, field?: BookingField): BindingHold {
  return field === undefined ? { code, class: HOLD_CODES[code].class } : { code, field, class: HOLD_CODES[code].class };
}

/** Integer cents of a cent-precision amount, else undefined (`124.005` has no cent value). */
function cents(value: number): number | undefined {
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  return Number.isFinite(scaled) && Math.abs(scaled - rounded) < 1e-6 ? rounded : undefined;
}
/** Booking amounts must equal the accepted amounts in whole cents. */
const near = (a: number, b: number) => {
  const ca = cents(a);
  return ca !== undefined && ca === cents(b);
};
const normalizeReg = (value: string) => value.replace(/\s+/g, "");

type StrongIds = Pick<AcceptedValues, "supplier_reg" | "supplier_vat">;

// ---------------------------------------------------------------------------
// Supplier candidates
// ---------------------------------------------------------------------------

export type ClientView = Pick<Client, "id" | "code" | "invoice_vat_no" | "cl_code_country" | "is_deleted">;

export interface SupplierCandidatesResult { candidates: ClientView[]; holds: BindingHold[] }

/**
 * A candidate is a live client whose populated `code` or `invoice_vat_no` equals an accepted strong id
 * and none of whose populated ids contradicts an accepted id. Uniqueness counts every positive match.
 */
export function supplierCandidates(accepted: StrongIds, clients: readonly ClientView[] | "unavailable"): SupplierCandidatesResult {
  if (clients === "unavailable") return { candidates: [], holds: [bindingHold("clients_unavailable")] };
  const reg = accepted.supplier_reg ? normalizeReg(accepted.supplier_reg) : undefined;
  const vat = accepted.supplier_vat ? normalizeVatValue(accepted.supplier_vat) : undefined;
  const positives: ClientView[] = [];
  const candidates: ClientView[] = [];
  let contradiction = false;
  for (const client of clients) {
    if (client.is_deleted === true) continue;
    const code = client.code ? normalizeReg(client.code) : undefined;
    const vatNo = client.invoice_vat_no ? normalizeVatValue(client.invoice_vat_no) : undefined;
    const positive = (reg !== undefined && code === reg) || (vat !== undefined && vatNo === vat);
    if (!positive) continue;
    positives.push(client);
    const contradicts = (reg !== undefined && code !== undefined && code !== reg) ||
      (vat !== undefined && vatNo !== undefined && vatNo !== vat);
    if (contradicts) contradiction = true;
    else candidates.push(client);
  }
  const holds: BindingHold[] = [];
  if (contradiction) holds.push(bindingHold("supplier_id_contradiction"));
  if (positives.length === 0) holds.push(bindingHold("supplier_not_client"));
  if (positives.length > 1) holds.push(bindingHold("supplier_ambiguous"));
  return { candidates: holds.length === 0 ? candidates : [], holds };
}

// ---------------------------------------------------------------------------
// Booking binding (§3.5)
// ---------------------------------------------------------------------------

export interface BookingItemView {
  vat_rate_dropdown?: string | null;
  reversed_vat_id?: number | null;
}

export interface BookingView {
  clients_id: number;
  number: string;
  create_date: string;
  cl_currencies_id: string;
  currency_rate?: number | null;
  base_net_price?: number | null;
  base_vat_price?: number | null;
  base_gross_price?: number | null;
  gross_price?: number | null;
  vat_price?: number | null;
  term_days?: number | null;
  bank_account_no?: string | null;
  items: readonly BookingItemView[];
  /** Effective item sums, computed by the caller with previewPurchaseInvoiceTotals. */
  effective: { itemNet: number; itemGross: number };
}

export interface BookingBindingContext {
  vatRegistered: boolean;
  vatZeroNoteProven: boolean;
  reverseChargeNotePresent: boolean;
  /** The bound client's cl_code_country; null = unknown (counts as not EST). */
  supplierCountry: string | null;
  /** Booking-side signals the caller recomputed on the final items (vat_rate_implausible, the RC signals). */
  bookingSideSignals: readonly string[];
  supplierKnownIbans: readonly string[];
  /** The supplierCandidates result's client ids; the booking's client must be the unique one. */
  supplierCandidateIds: readonly number[];
}

export type BookingWarning = "bank_account_not_known";

export interface BookingBindingResult { holds: BindingHold[]; warnings: BookingWarning[] }

const REVERSE_CHARGE_SIGNALS = ["reverse_charge_phrase_unhandled", "foreign_reverse_charge_default_unverified"];

function dayDiff(from: string, to: string): number | undefined {
  const a = parseStrictDate(from);
  const b = parseStrictDate(to);
  if (!a || !b) return undefined;
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

const compactIban = (value: string) => value.replace(/\s+/g, "").toUpperCase();

export function checkBookingBinding(accepted: AcceptedValues, booking: BookingView, ctx: BookingBindingContext): BookingBindingResult {
  const holds: BindingHold[] = [];
  const warnings: BookingWarning[] = [];
  const mismatch = (field: BookingField) => holds.push(bindingHold("booking_field_mismatch", field));

  if (ctx.supplierCandidateIds.length !== 1 || booking.clients_id !== ctx.supplierCandidateIds[0]) mismatch("clients_id");
  if (accepted.invoice_number === null || booking.number !== accepted.invoice_number) mismatch("number");
  if (accepted.invoice_date === null || booking.create_date !== accepted.invoice_date) mismatch("create_date");
  if (accepted.currency !== "EUR" || booking.cl_currencies_id.toUpperCase() !== "EUR") mismatch("cl_currencies_id");
  const isSet = (value: number | null | undefined) => value !== undefined && value !== null;
  if (isSet(booking.currency_rate) || isSet(booking.base_net_price) || isSet(booking.base_vat_price) || isSet(booking.base_gross_price)) {
    holds.push(bindingHold("currency_fields_refused"));
  }
  if (accepted.gross === null || !isSet(booking.gross_price) || !near(booking.gross_price!, accepted.gross)) mismatch("gross_price");

  const reversedItems = booking.items.filter((item) => item.reversed_vat_id !== undefined && item.reversed_vat_id !== null);
  if (ctx.vatRegistered) {
    if (accepted.vat !== null) {
      if (!isSet(booking.vat_price) || !near(booking.vat_price!, accepted.vat)) mismatch("vat_price");
    } else {
      if (isSet(booking.vat_price) && booking.vat_price !== 0) mismatch("vat_price");
      const deductible = booking.items.some((item) =>
        (item.reversed_vat_id === undefined || item.reversed_vat_id === null) && parseVatRateDropdown(item.vat_rate_dropdown) !== 0);
      if (deductible) mismatch("items");
    }
  } else if (accepted.gross !== null && !near(booking.effective.itemGross, accepted.gross)) {
    mismatch("items");
  }
  const expectedNet = accepted.net ?? (accepted.gross !== null ? accepted.gross - (accepted.vat ?? 0) : undefined);
  if (expectedNet !== undefined && !near(booking.effective.itemNet, expectedNet)) mismatch("items");

  // Reverse charge: forward and converse (rev. 3.1, M2).
  if (reversedItems.length > 0 && (accepted.vat !== 0 || !ctx.vatZeroNoteProven)) holds.push(bindingHold("reading_reverse_charge_unverified"));
  const reverseChargeIndicated = ctx.reverseChargeNotePresent ||
    ctx.bookingSideSignals.some((signal) => REVERSE_CHARGE_SIGNALS.includes(signal)) ||
    ctx.supplierCountry !== "EST";
  if (ctx.vatRegistered && reverseChargeIndicated && reversedItems.length === 0) holds.push(bindingHold("reading_reverse_charge_unbooked"));
  if (ctx.bookingSideSignals.includes("vat_rate_implausible")) holds.push(bindingHold("booking_vat_rate_implausible"));

  if (accepted.due_date !== null && accepted.invoice_date !== null) {
    const term = dayDiff(accepted.invoice_date, accepted.due_date);
    if (term === undefined || booking.term_days !== term) mismatch("term_days");
  }
  if (booking.bank_account_no) {
    const iban = compactIban(booking.bank_account_no);
    const known = ctx.supplierKnownIbans.map(compactIban);
    if (accepted.supplier_iban === null || compactIban(accepted.supplier_iban) !== iban || !known.includes(iban)) {
      warnings.push("bank_account_not_known");
    }
  }
  return { holds, warnings };
}

// ---------------------------------------------------------------------------
// Duplicates (§3.6)
// ---------------------------------------------------------------------------

export interface DuplicateKeys {
  invoiceNumbers: string[];
  supplierClientIds: number[];
  /** The accepted EUR gross only, never base_* or a conversion. */
  gross: number | null;
  invoiceDate: string | null;
}

/** The union keys: the accepted number plus the heuristic's, the bound supplier plus the heuristic's. */
export function duplicateKeys(input: {
  accepted: Pick<AcceptedValues, "invoice_number" | "gross" | "invoice_date">;
  supplierClientId: number;
  heuristic?: { invoiceNumber?: string | null; supplierClientId?: number | null };
}): DuplicateKeys {
  const numbers: string[] = [];
  for (const number of [input.accepted.invoice_number, input.heuristic?.invoiceNumber]) {
    if (!number) continue;
    if (!numbers.some((known) => normalizeInvoiceNumberForComparison(known) === normalizeInvoiceNumberForComparison(number))) numbers.push(number);
  }
  const suppliers = [input.supplierClientId];
  const heuristicSupplier = input.heuristic?.supplierClientId;
  if (heuristicSupplier !== undefined && heuristicSupplier !== null && heuristicSupplier !== input.supplierClientId) suppliers.push(heuristicSupplier);
  return { invoiceNumbers: numbers, supplierClientIds: suppliers, gross: input.accepted.gross, invoiceDate: input.accepted.invoice_date };
}

/** Scanner outputs, computed by the caller over the union keys. Only presence matters. */
export interface DuplicateScanView {
  /** detectDuplicatePurchaseInvoice exact supplier + number matches. */
  exactDuplicates: readonly unknown[];
  /** candidate_same_amount_date_matches. */
  sameAmountDate: readonly unknown[];
  /** candidate_invalidated_matches. */
  voidedCandidates: readonly unknown[];
  /** findInvoiceNumberMatchesAnySupplier. */
  anySupplierNumberMatches: readonly unknown[];
  /** findJournalsReferencingDocument; "unavailable" after the retry. */
  journalReferences: readonly unknown[] | "unavailable";
  /** findDuplicatePostingsInJournals suspects (only when the scan was available). */
  cashSuspects: readonly unknown[];
}

export function duplicateHolds(view: DuplicateScanView): BindingHold[] {
  const holds: BindingHold[] = [];
  if (view.exactDuplicates.length > 0) holds.push(bindingHold("duplicate_supplier_number"));
  if (view.sameAmountDate.length > 0) holds.push(bindingHold("duplicate_same_amount_date"));
  if (view.voidedCandidates.length > 0) holds.push(bindingHold("duplicate_voided_candidate"));
  if (view.anySupplierNumberMatches.length > 0) holds.push(bindingHold("duplicate_number_any_supplier"));
  if (view.journalReferences === "unavailable") holds.push(bindingHold("journal_reference_scan_unavailable"));
  else if (view.journalReferences.length > 0) holds.push(bindingHold("journal_reference_hit"));
  if (view.cashSuspects.length > 0) holds.push(bindingHold("cash_duplicate_suspect"));
  return holds;
}
