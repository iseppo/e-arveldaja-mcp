import { describe, expect, it } from "vitest";
import {
  checkBookingBinding,
  duplicateHolds,
  duplicateKeys,
  supplierCandidates,
  type BookingBindingContext,
  type BookingView,
  type ClientView,
  type DuplicateScanView,
} from "./document-reading-binding.js";
import { HOLD_CODES, type AcceptedValues } from "./document-reading-check.js";
import { runCase } from "./__fixtures__/document-reading/invoice.js";

const ACCEPTED = runCase().accepted as AcceptedValues;
const client = (overrides: Partial<ClientView>): ClientView => ({ id: 1, code: null, invoice_vat_no: null, cl_code_country: "EST", ...overrides });
const codes = (holds: Array<{ code: string; field?: string }>) => holds.map((hold) => (hold.field ? `${hold.code}:${hold.field}` : hold.code));

describe("supplierCandidates", () => {
  it("T-B-unique: one client with a matching strong id is the candidate", () => {
    const result = supplierCandidates(ACCEPTED, [client({ id: 7, code: "10000018", invoice_vat_no: "EE 100000007" }), client({ id: 8, code: "10000024" })]);
    expect(result.holds).toEqual([]);
    expect(result.candidates.map((c) => c.id)).toEqual([7]);
  });

  it("T-B-contradiction: a matching client whose other id contradicts holds supplier_id_contradiction", () => {
    const result = supplierCandidates(ACCEPTED, [client({ id: 7, code: "10000018", invoice_vat_no: "EE100000023" })]);
    expect(codes(result.holds)).toEqual(["supplier_id_contradiction"]);
    expect(result.candidates).toEqual([]);
  });

  it("T-B-no-ids: a client without ids is no candidate", () => {
    expect(codes(supplierCandidates(ACCEPTED, [client({ id: 7 })]).holds)).toEqual(["supplier_not_client"]);
  });

  it("T-B-unavailable: an unavailable client list holds clients_unavailable", () => {
    expect(codes(supplierCandidates(ACCEPTED, "unavailable").holds)).toEqual(["clients_unavailable"]);
  });

  it("T-B-two: two matching clients hold supplier_ambiguous", () => {
    const result = supplierCandidates(ACCEPTED, [client({ id: 7, code: "10000018" }), client({ id: 8, invoice_vat_no: "EE100000007" })]);
    expect(codes(result.holds)).toEqual(["supplier_ambiguous"]);
    expect(result.candidates).toEqual([]);
  });

  it("T-B-deleted: a deleted client is not counted", () => {
    const result = supplierCandidates(ACCEPTED, [client({ id: 7, code: "10000018" }), client({ id: 8, code: "10000018", is_deleted: true })]);
    expect(result.candidates.map((c) => c.id)).toEqual([7]);
  });
});

describe("checkBookingBinding", () => {
  const booking = (overrides: Partial<BookingView> = {}): BookingView => ({
    clients_id: 7,
    number: "A-17",
    create_date: "2026-03-15",
    cl_currencies_id: "EUR",
    gross_price: 124,
    vat_price: 24,
    items: [{ vat_rate_dropdown: "24", reversed_vat_id: null }],
    effective: { itemNet: 100, itemGross: 124 },
    ...overrides,
  });
  const ctx = (overrides: Partial<BookingBindingContext> = {}): BookingBindingContext => ({
    vatRegistered: true,
    vatZeroNoteProven: false,
    reverseChargeNotePresent: false,
    supplierCountry: "EST",
    bookingSideSignals: [],
    supplierKnownIbans: [],
    supplierCandidateIds: [7],
    ...overrides,
  });
  const ZERO: AcceptedValues = { ...ACCEPTED, vat: 0, net: 100, gross: 100 };
  const zeroBooking = (overrides: Partial<BookingView> = {}) =>
    booking({ gross_price: 100, vat_price: 0, effective: { itemNet: 100, itemGross: 100 }, items: [{ vat_rate_dropdown: "24", reversed_vat_id: 1 }], ...overrides });

  it("T-B-clean: a booking that matches the accepted values passes", () => {
    expect(checkBookingBinding(ACCEPTED, booking(), ctx())).toEqual({ holds: [], warnings: [] });
  });

  it("T-B-fields: client, number, date, currency, gross and VAT mismatches hold with the field", () => {
    expect(codes(checkBookingBinding(ACCEPTED, booking({ clients_id: 8 }), ctx()).holds)).toEqual(["booking_field_mismatch:clients_id"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking(), ctx({ supplierCandidateIds: [7, 8] })).holds)).toEqual(["booking_field_mismatch:clients_id"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ number: "A-18" }), ctx()).holds)).toEqual(["booking_field_mismatch:number"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ create_date: "2026-03-16" }), ctx()).holds)).toEqual(["booking_field_mismatch:create_date"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ cl_currencies_id: "USD" }), ctx()).holds)).toEqual(["booking_field_mismatch:cl_currencies_id"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ gross_price: 124.01 }), ctx()).holds)).toEqual(["booking_field_mismatch:gross_price"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ vat_price: null }), ctx()).holds)).toEqual(["booking_field_mismatch:vat_price"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ effective: { itemNet: 99, itemGross: 123 } }), ctx()).holds)).toEqual(["booking_field_mismatch:items"]);
  });

  it("T-B-base-refused: base_* and currency_rate are refused", () => {
    expect(codes(checkBookingBinding(ACCEPTED, booking({ base_gross_price: 124 }), ctx()).holds)).toEqual(["currency_fields_refused"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ currency_rate: 1 }), ctx()).holds)).toEqual(["currency_fields_refused"]);
  });

  it("T-B-non-vat: a non-VAT company's Σ item gross must equal the accepted gross", () => {
    expect(checkBookingBinding(ACCEPTED, booking({ vat_price: 0 }), ctx({ vatRegistered: false })).holds).toEqual([]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ effective: { itemNet: 100, itemGross: 120 } }), ctx({ vatRegistered: false })).holds))
      .toEqual(["booking_field_mismatch:items"]);
  });

  it("T-B-null-vat: with accepted VAT null a deductible item holds", () => {
    const accepted = { ...ACCEPTED, vat: null, net: null };
    expect(codes(checkBookingBinding(accepted, booking({ vat_price: 0, effective: { itemNet: 124, itemGross: 124 } }), ctx()).holds))
      .toEqual(["booking_field_mismatch:items"]);
    expect(checkBookingBinding(accepted, booking({ vat_price: 0, items: [{ vat_rate_dropdown: "-" }], effective: { itemNet: 124, itemGross: 124 } }), ctx()).holds)
      .toEqual([]);
  });

  it("T-B-rc-forward: a reversed_vat_id item needs VAT 0 and a proven note", () => {
    expect(codes(checkBookingBinding(ZERO, zeroBooking(), ctx({ vatZeroNoteProven: true, reverseChargeNotePresent: true })).holds)).toEqual([]);
    expect(codes(checkBookingBinding(ZERO, zeroBooking(), ctx({ vatZeroNoteProven: false })).holds)).toEqual(["reading_reverse_charge_unverified"]);
    expect(codes(checkBookingBinding(ACCEPTED, booking({ items: [{ vat_rate_dropdown: "24", reversed_vat_id: 1 }] }), ctx({ vatZeroNoteProven: true })).holds))
      .toEqual(["reading_reverse_charge_unverified"]);
  });

  it("T-B-rc-converse: a printed note (or an RC signal) without a reversed_vat_id item holds on a VAT-registered company", () => {
    const plain = zeroBooking({ items: [{ vat_rate_dropdown: "-" }] });
    expect(codes(checkBookingBinding(ZERO, plain, ctx({ reverseChargeNotePresent: true, vatZeroNoteProven: true })).holds)).toEqual(["reading_reverse_charge_unbooked"]);
    expect(codes(checkBookingBinding(ZERO, plain, ctx({ bookingSideSignals: ["reverse_charge_phrase_unhandled"], vatZeroNoteProven: true })).holds))
      .toEqual(["reading_reverse_charge_unbooked"]);
    expect(codes(checkBookingBinding(ZERO, plain, ctx({ bookingSideSignals: ["foreign_reverse_charge_default_unverified"], vatZeroNoteProven: true })).holds))
      .toEqual(["reading_reverse_charge_unbooked"]);
    expect(checkBookingBinding(ZERO, plain, ctx({ reverseChargeNotePresent: true, vatRegistered: false })).holds).toEqual([]);
  });

  it("T-B-rc-foreign: a foreign supplier with no note and no signal holds on a VAT-registered company", () => {
    const grossOnly = { ...ACCEPTED, net: null, vat: null };
    const plain = booking({ vat_price: 0, items: [{ vat_rate_dropdown: "-" }], effective: { itemNet: 124, itemGross: 124 } });
    expect(codes(checkBookingBinding(grossOnly, plain, ctx({ supplierCountry: "USA" })).holds)).toEqual(["reading_reverse_charge_unbooked"]);
    expect(checkBookingBinding(grossOnly, plain, ctx({ supplierCountry: "EST" })).holds).toEqual([]);
    const reversed = booking({ vat_price: 0, items: [{ vat_rate_dropdown: "-", reversed_vat_id: 1 }], effective: { itemNet: 124, itemGross: 124 } });
    expect(codes(checkBookingBinding(grossOnly, reversed, ctx({ supplierCountry: "USA", vatZeroNoteProven: false })).holds))
      .toEqual(["reading_reverse_charge_unverified"]);
  });

  it("T-B-rc-foreign-unknown: an unknown supplier country counts as not EST", () => {
    const grossOnly = { ...ACCEPTED, net: null, vat: null };
    const plain = booking({ vat_price: 0, items: [{ vat_rate_dropdown: "-" }], effective: { itemNet: 124, itemGross: 124 } });
    expect(codes(checkBookingBinding(grossOnly, plain, ctx({ supplierCountry: null })).holds)).toEqual(["reading_reverse_charge_unbooked"]);
  });

  it("T-B-vat-rate: a recomputed vat_rate_implausible holds booking_vat_rate_implausible", () => {
    expect(codes(checkBookingBinding(ACCEPTED, booking(), ctx({ bookingSideSignals: ["vat_rate_implausible"] })).holds)).toEqual(["booking_vat_rate_implausible"]);
  });

  it("T-B-term: term_days must equal due − invoice date", () => {
    const accepted = { ...ACCEPTED, due_date: "2026-03-29" };
    expect(checkBookingBinding(accepted, booking({ term_days: 14 }), ctx()).holds).toEqual([]);
    expect(codes(checkBookingBinding(accepted, booking({ term_days: 7 }), ctx()).holds)).toEqual(["booking_field_mismatch:term_days"]);
  });

  it("T-B-iban: an unknown bank account is a warning only", () => {
    const accepted = { ...ACCEPTED, supplier_iban: "EE591000001823456789" };
    expect(checkBookingBinding(accepted, booking({ bank_account_no: "EE59 1000 0018 2345 6789" }), ctx({ supplierKnownIbans: ["EE591000001823456789"] })))
      .toEqual({ holds: [], warnings: [] });
    expect(checkBookingBinding(accepted, booking({ bank_account_no: "EE591000001823456789" }), ctx())).toEqual({ holds: [], warnings: ["bank_account_not_known"] });
  });
});

describe("duplicates", () => {
  const empty: DuplicateScanView = {
    exactDuplicates: [], sameAmountDate: [], voidedCandidates: [], anySupplierNumberMatches: [], journalReferences: [], cashSuspects: [],
  };

  it("T-D-map: each scanner output maps to its hold", () => {
    expect(duplicateHolds(empty)).toEqual([]);
    const cases: Array<[Partial<DuplicateScanView>, string]> = [
      [{ exactDuplicates: [1] }, "duplicate_supplier_number"],
      [{ sameAmountDate: [1] }, "duplicate_same_amount_date"],
      [{ voidedCandidates: [1] }, "duplicate_voided_candidate"],
      [{ anySupplierNumberMatches: [1] }, "duplicate_number_any_supplier"],
      [{ journalReferences: [1] }, "journal_reference_hit"],
      [{ cashSuspects: [1] }, "cash_duplicate_suspect"],
      [{ journalReferences: "unavailable" }, "journal_reference_scan_unavailable"],
    ];
    for (const [view, code] of cases) {
      const holds = duplicateHolds({ ...empty, ...view });
      expect(codes(holds)).toEqual([code]);
      expect(holds[0]!.class).toBe(HOLD_CODES[code as keyof typeof HOLD_CODES].class);
    }
  });

  it("T-D-union: the union key includes the heuristic number and supplier; the amount is the accepted gross only", () => {
    const keys = duplicateKeys({
      accepted: { ...ACCEPTED, base_gross_price: 999 } as AcceptedValues,
      supplierClientId: 7,
      heuristic: { invoiceNumber: "A-17-B", supplierClientId: 9 },
    });
    expect(keys).toEqual({ invoiceNumbers: ["A-17", "A-17-B"], supplierClientIds: [7, 9], gross: 124, invoiceDate: "2026-03-15" });
    expect(duplicateKeys({ accepted: ACCEPTED, supplierClientId: 7, heuristic: { invoiceNumber: "a 17", supplierClientId: 7 } }))
      .toEqual({ invoiceNumbers: ["A-17"], supplierClientIds: [7], gross: 124, invoiceDate: "2026-03-15" });
  });

  it("T-D-no-values: binding and duplicate holds carry only code, field and class", () => {
    const holds = [
      ...duplicateHolds({ ...empty, exactDuplicates: [{ id: 1, number: "A-17" }] }),
      ...supplierCandidates(ACCEPTED, [client({ id: 7, code: "10000018", invoice_vat_no: "EE100000023" })]).holds,
    ];
    for (const hold of holds) expect(Object.keys(hold).every((key) => ["code", "field", "class"].includes(key))).toBe(true);
  });
});
