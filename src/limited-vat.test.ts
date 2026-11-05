import { describe, expect, it } from "vitest";
import {
  buildLimitedVatPostings,
  classifySupplier,
  computeLimitedVatMonth,
  fxKeysFor,
  isMonthCandidate,
  kmdFigures,
  limitedVatPointOfUseNote,
  paymentDeadline,
  postingSignature,
  resolveLimitedVatMonthState,
  serviceReceivedDate,
  type LimitedVatInvoiceInput,
} from "./limited-vat.js";
import type { FrozenFxOutcomes } from "./fx/ecb-rates.js";
import type { LimitedVatStoreRecord } from "./company-vat-status.js";
import type { Client, Journal, PurchaseInvoice, PurchaseInvoiceItem } from "./types/api.js";

const LIABILITY = 2410;

function client(id: number, name: string, country: string, vatNo: string | null = null): Client {
  return { id, name, cl_code_country: country, invoice_vat_no: vatNo, is_client: false, is_supplier: true, is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false };
}

function item(net: number, account = 5000, dimension: number | null = null, extra: Partial<PurchaseInvoiceItem> = {}): PurchaseInvoiceItem {
  return { custom_title: "Service", total_net_price: net, purchase_accounts_id: account, purchase_accounts_dimensions_id: dimension, ...extra };
}

function invoice(id: number, clientsId: number, date: string, items: PurchaseInvoiceItem[], extra: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  const net = items.reduce((sum, row) => sum + (row.total_net_price ?? 0), 0);
  return {
    id, clients_id: clientsId, client_name: `Supplier ${clientsId}`, number: `INV-${id}`, create_date: date, journal_date: date,
    term_days: 0, cl_currencies_id: "EUR", status: "CONFIRMED", net_price: net, vat_price: 0, gross_price: net, items, ...extra,
  };
}

const usdRate = (date: string, rate: string): FrozenFxOutcomes => ({
  [`USD:${date}`]: {
    ok: true,
    rate: { source: "ecb", series: "EXR.D.USD.EUR.SP00.A", currency: "USD", rate, orientation: "foreign_per_eur", rate_date: date, requested_date: date, fetched_at: "2026-04-01T00:00:00.000Z", url: "https://data-api.ecb.europa.eu/x" },
  },
});

const aws = client(10, "Amazon Web Services EMEA SARL", "LUX");
const openai = client(11, "OpenAI, LLC", "USA");
const telia = client(12, "Telia Eesti AS", "EST");

function input(inv: PurchaseInvoice, c: Client, paymentDates: string[] = []): LimitedVatInvoiceInput {
  return { invoice: inv, client: c, payment_dates: paymentDates };
}

const counts = (...ids: number[]) => new Map(ids.map(id => [id, "counts" as const]));

describe("limited VAT month computation", () => {
  it("converts a USD invoice at the ECB rate and computes VAT per line (100.00 USD @ 1.0800 → 92.59, VAT 22.22)", () => {
    const usd = invoice(1, openai.id!, "2026-03-10", [item(100)], { cl_currencies_id: "USD" });
    const result = computeLimitedVatMonth("2026-03", [input(usd, openai)], counts(openai.id!), usdRate("2026-03-10", "1.0800"));
    expect(result.reviews).toEqual([]);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]).toMatchObject({ base_eur: 92.59, vat: 22.22, vat_rate: 24, supplier_area: "non_eu", ecb: { rate: "1.0800" } });
  });

  it("takes a EUR invoice at its net (50.00 → 12.00)", () => {
    const eur = invoice(2, aws.id!, "2026-03-05", [item(50)]);
    const result = computeLimitedVatMonth("2026-03", [input(eur, aws)], counts(aws.id!), {});
    expect(result.included[0]).toMatchObject({ base_eur: 50, vat: 12, supplier_area: "eu" });
  });

  it("books two cost accounts/dimensions as two debit lines against one VAT liability credit", () => {
    const eur = invoice(2, aws.id!, "2026-03-05", [item(50, 5000)]);
    const usd = invoice(1, openai.id!, "2026-03-10", [item(100, 5100, 7)], { cl_currencies_id: "USD" });
    const result = computeLimitedVatMonth("2026-03", [input(eur, aws), input(usd, openai)], counts(aws.id!, openai.id!), usdRate("2026-03-10", "1.0800"));
    expect(buildLimitedVatPostings(result.included, LIABILITY)).toEqual([
      { accounts_id: 5000, accounts_dimensions_id: null, type: "D", amount: 12 },
      { accounts_id: 5100, accounts_dimensions_id: 7, type: "D", amount: 22.22 },
      { accounts_id: LIABILITY, accounts_dimensions_id: null, type: "C", amount: 34.22 },
    ]);
  });

  it("excludes EX small-business suppliers even when classified as counts", () => {
    const ex = client(20, "Small Studio", "DEU", "DE123456789EX");
    const result = computeLimitedVatMonth("2026-03", [input(invoice(3, 20, "2026-03-02", [item(40)]), ex)], counts(20), {});
    expect(result.included).toEqual([]);
    expect(result.excluded).toEqual([expect.objectContaining({ invoice_id: 3, reason: "ex_small_business" })]);
  });

  it("excludes financial-service suppliers by default; the owner can override", () => {
    const wise = client(21, "Wise Europe SA", "BEL");
    const row = input(invoice(4, 21, "2026-03-02", [item(3)]), wise);
    expect(computeLimitedVatMonth("2026-03", [row], new Map(), {}).excluded).toEqual([expect.objectContaining({ reason: "financial_service" })]);
    expect(computeLimitedVatMonth("2026-03", [row], counts(21), {}).included).toHaveLength(1);
  });

  it("makes an unclassified foreign supplier a review item, never part of the journal", () => {
    const result = computeLimitedVatMonth("2026-03", [input(invoice(5, aws.id!, "2026-03-02", [item(10)]), aws)], new Map(), {});
    expect(result.included).toEqual([]);
    expect(result.reviews).toEqual([expect.objectContaining({ code: "limited_vat_supplier_unclassified", invoice_id: 5 })]);
  });

  it("makes an invoice where the supplier charged VAT a review item (OSS caveat)", () => {
    const charged = invoice(6, aws.id!, "2026-03-02", [item(10, 5000, null, { project_no_vat_gross_price: 12.4 })], { gross_price: 12.4 });
    const result = computeLimitedVatMonth("2026-03", [input(charged, aws)], counts(aws.id!), {});
    expect(result.included).toEqual([]);
    expect(result.reviews).toEqual([expect.objectContaining({ code: "limited_vat_supplier_charged_vat" })]);
  });

  it("makes an invoice that already carries e-arveldaja's reverse charge a review item, never part of the PKM journal", () => {
    const reversed = invoice(16, aws.id!, "2026-03-02", [item(10, 5000, null, { reversed_vat_id: 1, vat_amount: 2.4 })]);
    const result = computeLimitedVatMonth("2026-03", [input(reversed, aws)], counts(aws.id!), {});
    expect(result.included).toEqual([]);
    expect(result.reviews).toEqual([expect.objectContaining({ code: "limited_vat_native_reverse_charge", invoice_id: 16 })]);
  });

  it("uses the 22 % rate for a 2025-06 service (50.00 → 11.00)", () => {
    const result = computeLimitedVatMonth("2025-06", [input(invoice(7, aws.id!, "2025-06-15", [item(50)]), aws)], counts(aws.id!), {});
    expect(result.included[0]).toMatchObject({ vat_rate: 22, vat: 11 });
  });

  it("dates the service by the earliest of invoice and payment date (§ 11 lg 1)", () => {
    expect(serviceReceivedDate("2026-04-03", ["2026-03-28"])).toBe("2026-03-28");
    const prepaid = input(invoice(8, aws.id!, "2026-04-03", [item(20)]), aws, ["2026-03-28"]);
    expect(computeLimitedVatMonth("2026-03", [prepaid], counts(aws.id!), {}).included).toHaveLength(1);
    expect(computeLimitedVatMonth("2026-04", [prepaid], counts(aws.id!), {}).included).toHaveLength(0);
  });

  it("makes an ECB failure a review item, never a guessed rate", () => {
    const usd = input(invoice(9, openai.id!, "2026-03-10", [item(100)], { cl_currencies_id: "USD" }), openai);
    expect(fxKeysFor([usd], "2026-03")).toEqual(["USD:2026-03-10"]);
    const result = computeLimitedVatMonth("2026-03", [usd], counts(openai.id!), { "USD:2026-03-10": { ok: false, code: "ecb_rate_unavailable" } });
    expect(result.included).toEqual([]);
    expect(result.reviews).toEqual([expect.objectContaining({ code: "limited_vat_fx_unavailable" })]);
    expect(computeLimitedVatMonth("2026-03", [usd], counts(openai.id!), {}).reviews[0]!.code).toBe("limited_vat_fx_unavailable");
  });

  it("ignores Estonian suppliers", () => {
    expect(classifySupplier(telia, "counts")).toEqual({ decision: "not_foreign" });
  });

  it("gives KMD figures split by EU / non-EU supplier and the 20th-of-next-month deadline", () => {
    const eur = invoice(2, aws.id!, "2026-03-05", [item(50)]);
    const usd = invoice(1, openai.id!, "2026-03-10", [item(100)], { cl_currencies_id: "USD" });
    const result = computeLimitedVatMonth("2026-03", [input(eur, aws), input(usd, openai)], counts(aws.id!, openai.id!), usdRate("2026-03-10", "1.0800"));
    expect(kmdFigures(result.included)).toMatchObject({ row_1_taxable_value: 142.59, row_4_vat: 34.22, row_6_eu_services_value: 50, row_7_non_eu_services_value: 92.59 });
    expect(paymentDeadline("2026-03")).toBe("2026-04-20");
    expect(paymentDeadline("2026-12")).toBe("2027-01-20");
  });
});

describe("limited VAT month idempotency", () => {
  const month = "2026-03";
  const eur = input(invoice(2, aws.id!, "2026-03-05", [item(50)]), aws);
  const late = input(invoice(3, aws.id!, "2026-03-20", [item(10)]), aws);
  const computeWith = (...rows: LimitedVatInvoiceInput[]) => computeLimitedVatMonth(month, rows, counts(aws.id!), {});
  const journal = (id: number, documentNumber: string, postings: Array<[number, "D" | "C", number]>): Journal => ({
    id, effective_date: "2026-03-31", document_number: documentNumber, registered: true,
    postings: postings.map(([account, type, amount]) => ({ accounts_id: account, type, amount, accounts_dimensions_id: null })),
  });
  const record = (journalId: number, documentNumber: string, invoiceIds: number[], postings: string[]): LimitedVatStoreRecord => ({
    kind: "booking", key: `booking:${documentNumber}`, month, document_number: documentNumber, journal_id: journalId, invoice_ids: invoiceIds, postings, booked_at: "x",
  });
  const mainPostings: Array<[number, "D" | "C", number]> = [[5000, "D", 12], [LIABILITY, "C", 12]];
  const mainSignature = postingSignature(mainPostings.map(([accounts_id, type, amount]) => ({ accounts_id, type, amount })));

  it("is new without a live PKM journal", () => {
    expect(resolveLimitedVatMonthState(month, computeWith(eur), [], [], LIABILITY)).toMatchObject({ kind: "new", document_number: "PKM-2026-03" });
  });

  it("is already_booked on a re-run whose journal matches its record", () => {
    const state = resolveLimitedVatMonthState(month, computeWith(eur), [journal(900, "PKM-2026-03", mainPostings)], [record(900, "PKM-2026-03", [2], mainSignature)], LIABILITY);
    expect(state).toEqual({ kind: "already_booked", journal_ids: [900] });
  });

  it("adopts an unrecorded main journal only when its postings equal the month", () => {
    expect(resolveLimitedVatMonthState(month, computeWith(eur), [journal(900, "PKM-2026-03", mainPostings)], [], LIABILITY).kind).toBe("already_booked");
    expect(resolveLimitedVatMonthState(month, computeWith(eur), [journal(900, "PKM-2026-03", [[5000, "D", 13], [LIABILITY, "C", 13]])], [], LIABILITY).kind).toBe("conflict");
  });

  it("is a conflict when the booked journal's postings were changed", () => {
    const state = resolveLimitedVatMonthState(month, computeWith(eur), [journal(900, "PKM-2026-03", [[5000, "D", 15], [LIABILITY, "C", 15]])], [record(900, "PKM-2026-03", [2], mainSignature)], LIABILITY);
    expect(state.kind).toBe("conflict");
  });

  it("is a conflict when a booked invoice now computes a different amount", () => {
    const changed = input(invoice(2, aws.id!, "2026-03-05", [item(60)]), aws);
    expect(resolveLimitedVatMonthState(month, computeWith(changed), [journal(900, "PKM-2026-03", mainPostings)], [record(900, "PKM-2026-03", [2], mainSignature)], LIABILITY).kind).toBe("conflict");
  });

  it("proposes a correction delta for an invoice added after booking, never a second full journal", () => {
    const state = resolveLimitedVatMonthState(month, computeWith(eur, late), [journal(900, "PKM-2026-03", mainPostings)], [record(900, "PKM-2026-03", [2], mainSignature)], LIABILITY);
    expect(state.kind).toBe("delta");
    if (state.kind !== "delta") return;
    expect(state.document_number).toBe("PKM-2026-03-P1");
    expect(state.invoices.map(row => row.invoice_id)).toEqual([3]);
    expect(buildLimitedVatPostings(state.invoices, LIABILITY)).toEqual([
      { accounts_id: 5000, accounts_dimensions_id: null, type: "D", amount: 2.4 },
      { accounts_id: LIABILITY, accounts_dimensions_id: null, type: "C", amount: 2.4 },
    ]);
  });
});

describe("limited VAT point-of-use note", () => {
  it("adds a registration note for status none and a monthly-run note for limited, nothing for full or Estonian suppliers", () => {
    expect(limitedVatPointOfUseNote("none", aws)).toContain("KMS § 21 lg 1");
    expect(limitedVatPointOfUseNote("limited", aws)).toContain("limited_vat mode \"month\"");
    expect(limitedVatPointOfUseNote("full", aws)).toBeUndefined();
    expect(limitedVatPointOfUseNote("none", telia)).toBeUndefined();
    expect(limitedVatPointOfUseNote("none", client(30, "PayPal Europe", "LUX"))).toBeUndefined();
  });
});

describe("limited VAT review fixes (fail closed)", () => {
  const month = "2026-03";
  const eur = input(invoice(2, aws.id!, "2026-03-05", [item(50)]), aws);
  const computeWith = (...rows: LimitedVatInvoiceInput[]) => computeLimitedVatMonth(month, rows, counts(aws.id!), {});
  const postings: Array<[number, "D" | "C", number]> = [[5000, "D", 12], [LIABILITY, "C", 12]];
  const signature = postingSignature(postings.map(([accounts_id, type, amount]) => ({ accounts_id, type, amount })));
  const journal = (extra: Partial<Journal>): Journal => ({
    id: 900, effective_date: "2026-03-31", document_number: "PKM-2026-03", registered: true,
    postings: postings.map(([account, type, amount]) => ({ accounts_id: account, type, amount, accounts_dimensions_id: null })),
    ...extra,
  });
  const record: LimitedVatStoreRecord = {
    kind: "booking", key: "booking:PKM-2026-03", month, document_number: "PKM-2026-03", journal_id: 900, invoice_ids: [2], postings: signature, booked_at: "x",
  };

  it("F4: a draft PKM journal is never already_booked (recorded or adopted)", () => {
    expect(resolveLimitedVatMonthState(month, computeWith(eur), [journal({ registered: false })], [record], LIABILITY).kind).toBe("conflict");
    expect(resolveLimitedVatMonthState(month, computeWith(eur), [journal({ registered: false })], [], LIABILITY).kind).toBe("conflict");
  });

  it("F4: a PKM journal dated outside the month end is never already_booked (recorded or adopted)", () => {
    expect(resolveLimitedVatMonthState(month, computeWith(eur), [journal({ effective_date: "2025-03-31" })], [record], LIABILITY).kind).toBe("conflict");
    expect(resolveLimitedVatMonthState(month, computeWith(eur), [journal({ effective_date: "2025-03-31" })], [], LIABILITY).kind).toBe("conflict");
  });

  it("F5: an invoice dated more than 92 days after the month is still a candidate (prepayment)", () => {
    expect(isMonthCandidate(invoice(5, aws.id!, "2026-07-15", [item(10)]), aws, month)).toBe(true);
    expect(isMonthCandidate(invoice(6, aws.id!, "2026-02-28", [item(10)]), aws, month)).toBe(false);
  });

  it("F6: a credit note on which the supplier charged VAT is held for the OSS review, never a negative self-assessment", () => {
    const credit = invoice(7, aws.id!, "2026-03-05", [item(-100, 5000, null, { vat_amount: -24 })], { net_price: -100, vat_price: -24, gross_price: -124 });
    const result = computeLimitedVatMonth(month, [input(credit, aws)], counts(aws.id!), {});
    expect(result.included).toEqual([]);
    expect(result.reviews.map(review => review.code)).toEqual(["limited_vat_supplier_charged_vat"]);
    const itemOnly = invoice(8, aws.id!, "2026-03-05", [item(-100, 5000, null, { vat_amount: -24 })]);
    expect(computeLimitedVatMonth(month, [input(itemOnly, aws)], counts(aws.id!), {}).reviews.map(review => review.code)).toEqual(["limited_vat_supplier_charged_vat"]);
  });

  it("F7: a foreign supplier with an Estonian VAT number or Estonian invoice country is a review item even when classified counts", () => {
    const eeVat = client(20, "Example GmbH", "DEU", "EE101234567");
    const eeInvoiceCountry = { ...client(21, "Example Ltd", "GBR"), cl_invoice_country: "EST" };
    for (const supplier of [eeVat, eeInvoiceCountry]) {
      const row = invoice(9, supplier.id!, "2026-03-05", [item(100)]);
      const result = computeLimitedVatMonth(month, [input(row, supplier)], counts(supplier.id!), {});
      expect(result.included).toEqual([]);
      expect(result.reviews.map(review => review.code)).toEqual(["limited_vat_supplier_estonian_registration"]);
    }
  });
});
