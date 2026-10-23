import { describe, expect, it } from "vitest";
import { computeExactMatchProjection, EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE, THIRD_PARTY_PAYER_NEXT_ACTION } from "./duplicate-policy.js";
import { exactMatchFingerprint } from "./projection.js";
import { matchScore } from "./match-score.js";
import type { PurchaseInvoice, SaleInvoice, Transaction } from "../../types/api.js";
import { withSignedCamtMarker } from "../../__fixtures__/camt-marker.js";
import { buildCamtDescriptionWithMetadata, isTrustedCamtDescriptionMetadata } from "../../camt/duplicate-identity.js";

// The EIS case, verified live: Rahandusministeerium (2309260) paid an invoice
// that belongs to EIS (2327264). journal.clients_id is copied from the
// TRANSACTION, so auto-confirming files the receivable under the payer and
// leaves the invoice open in the invoice client's sub-ledger. Such a match must
// leave the confirm set entirely — while still consuming the invoice key, so no
// other transaction can claim the same invoice in the same run.

const PAYER = 2309260;
const INVOICE_CLIENT = 2327264;
// exact_amount (40) + ref_number (40) = 80. A differing payer earns no
// client_id points, so 80 is the threshold at which such a row can reach the
// exact-confirm set at all; an equal client adds 15 for 95.
const THRESHOLD = 80;

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1210,
    status: "PROJECT",
    is_deleted: false,
    type: "D",
    amount: 1488.0,
    base_amount: 1488.0,
    ref_number: "REF-1488",
    clients_id: PAYER,
    date: "2026-09-10",
    accounts_dimensions_id: 9,
    cl_currencies_id: "EUR",
    ...overrides,
  } as Transaction;
}

function sale(overrides: Partial<SaleInvoice> = {}): SaleInvoice {
  return {
    id: 501,
    number: "ARV-501",
    clients_id: INVOICE_CLIENT,
    gross_price: 1488.0,
    base_gross_price: 1488.0,
    bank_ref_number: "REF-1488",
    payment_status: "NOT_PAID",
    status: "CONFIRMED",
    client_name: "EIS",
    cl_currencies_id: "EUR",
    ...overrides,
  } as SaleInvoice;
}

const NO_PURCHASES: PurchaseInvoice[] = [];

describe("computeExactMatchProjection third-party-payer partition", () => {
  it("routes a differing payer to review, confirms nothing, and still consumes the invoice", () => {
    const projection = computeExactMatchProjection([tx()], [sale()], NO_PURCHASES, THRESHOLD);

    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([]);
    expect(projection.thirdPartyPayerReviews).toEqual([{
      transaction_id: 1210,
      date: "2026-09-10",
      amount: 1488.0,
      currency: "EUR",
      invoice_type: "sale_invoice",
      invoice_id: 501,
      invoice_number: "ARV-501",
      transaction_clients_id: PAYER,
      invoice_clients_id: INVOICE_CLIENT,
      confidence: 80,
      reason: "third_party_payer",
      next_action: THIRD_PARTY_PAYER_NEXT_ACTION,
    }]);
  });

  it("does not let a second transaction claim the invoice a reviewed row consumed", () => {
    const projection = computeExactMatchProjection(
      [tx(), tx({ id: 1211, clients_id: INVOICE_CLIENT, date: "2026-09-11" })],
      [sale()],
      NO_PURCHASES,
      THRESHOLD,
    );

    expect(projection.confirms).toEqual([]);
    expect(projection.thirdPartyPayerReviews).toHaveLength(1);
    expect(projection.thirdPartyPayerReviews[0]!.transaction_id).toBe(1210);
  });

  it("reviews a match whose invoice carries no client at all", () => {
    const projection = computeExactMatchProjection([tx()], [sale({ clients_id: undefined })], NO_PURCHASES, THRESHOLD);

    expect(projection.confirms).toEqual([]);
    expect(projection.thirdPartyPayerReviews).toHaveLength(1);
    expect(projection.thirdPartyPayerReviews[0]!.reason).toBe("invoice_client_missing");
    expect(projection.thirdPartyPayerReviews[0]!.invoice_clients_id).toBeNull();
  });

  it("confirms an equal client unchanged, with no client update", () => {
    const projection = computeExactMatchProjection(
      [tx({ clients_id: INVOICE_CLIENT })],
      [sale()],
      NO_PURCHASES,
      THRESHOLD,
    );

    expect(projection.thirdPartyPayerReviews).toEqual([]);
    expect(projection.confirms).toHaveLength(1);
    expect(projection.confirms[0]!.clientResolution).toBe("unchanged");
    expect(projection.confirms[0]!.needsClientUpdate).toBe(false);
  });

  it("keeps the set_missing path for a transaction with no client of its own", () => {
    // No client to vouch for the counterparty, so the direction must be proven.
    const signed = withSignedCamtMarker(tx({ type: "C", clients_id: undefined, cl_currencies_id: "EUR" } as Partial<Transaction>), "CRDT");
    const projection = computeExactMatchProjection([signed], [sale()], NO_PURCHASES, THRESHOLD);

    expect(projection.thirdPartyPayerReviews).toEqual([]);
    expect(projection.confirms).toHaveLength(1);
    expect(projection.confirms[0]!.clientResolution).toBe("set_missing");
    expect(projection.confirms[0]!.needsClientUpdate).toBe(true);
    expect(projection.confirms[0]!.invoiceClientsId).toBe(INVOICE_CLIENT);
  });

  it("leaves an ambiguous multi-candidate match untouched by the payer partition", () => {
    const projection = computeExactMatchProjection(
      [tx()],
      [sale(), sale({ id: 502, number: "ARV-502" })],
      NO_PURCHASES,
      THRESHOLD,
    );

    expect(projection.confirms).toEqual([]);
    expect(projection.thirdPartyPayerReviews).toEqual([]);
    expect(projection.skipped).toEqual([]);
  });
});

describe("exactMatchFingerprint review coverage", () => {
  it("changes when the third-party-payer review set changes", () => {
    const projection = computeExactMatchProjection([tx()], [sale()], NO_PURCHASES, THRESHOLD);
    const withReview = exactMatchFingerprint(projection, THRESHOLD);
    const withoutReview = exactMatchFingerprint({ ...projection, thirdPartyPayerReviews: [] }, THRESHOLD);

    expect(projection.thirdPartyPayerReviews).toHaveLength(1);
    expect(withReview).not.toBe(withoutReview);
  });

  it("changes when a reviewed row's reason changes", () => {
    const projection = computeExactMatchProjection([tx()], [sale()], NO_PURCHASES, THRESHOLD);
    const reasonChanged = {
      ...projection,
      thirdPartyPayerReviews: [{ ...projection.thirdPartyPayerReviews[0]!, reason: "invoice_client_missing" as const }],
    };

    expect(exactMatchFingerprint(projection, THRESHOLD)).not.toBe(exactMatchFingerprint(reasonChanged, THRESHOLD));
  });

  it("changes when a possible-duplicate suspect appears on a confirm", () => {
    const projection = computeExactMatchProjection([tx({ clients_id: INVOICE_CLIENT })], [sale()], NO_PURCHASES, THRESHOLD);
    expect(projection.confirms).toHaveLength(1);
    const clean = exactMatchFingerprint(projection, THRESHOLD);
    const suspect = {
      journal_id: 77, journal_title: "t", document_number: null, operation_type: null,
      date: "2026-09-10", amount: 1488, type: "D" as const, dimension_id: 9, day_distance: 0,
    };
    const withSuspect = { ...projection, confirms: [{ ...projection.confirms[0]!, possibleDuplicatePostings: [suspect] }] };
    expect(exactMatchFingerprint(withSuspect, THRESHOLD)).not.toBe(clean);
  });
});

describe("computeExactMatchProjection signed-outgoing invoice eligibility", () => {
  // A statement-proven debit (CAMT DBIT / Wise OUT) is cash leaving the account.
  // Confirming it against a sale invoice would settle a receivable with money
  // that went out. Only a legacy unsigned `C` keeps the sale-invoice fallback.
  const camtDebit = "Payment\n[e-arveldaja-mcp:camt d=DBIT s=abc123abc123abcd]";

  it("never matches a signed CAMT DBIT row to a sale invoice", () => {
    const projection = computeExactMatchProjection(
      [tx({ type: "C", clients_id: INVOICE_CLIENT, description: camtDebit })],
      [sale()], NO_PURCHASES, THRESHOLD,
    );
    expect(projection.confirms).toEqual([]);
    expect(projection.thirdPartyPayerReviews).toEqual([]);
  });

  it("never matches a signed Wise OUT row to a sale invoice", () => {
    const projection = computeExactMatchProjection(
      [tx({ type: "C", clients_id: INVOICE_CLIENT, description: "WISE:TRANSFER-1 Customer [source_direction=OUT]" })],
      [sale()], NO_PURCHASES, THRESHOLD,
    );
    expect(projection.confirms).toEqual([]);
  });

  it("still matches a signed DBIT row to a purchase invoice", () => {
    const purchase = { ...sale(), id: 601, number: "P-601", client_name: "Vendor" } as unknown as PurchaseInvoice;
    const projection = computeExactMatchProjection(
      [tx({ type: "C", clients_id: INVOICE_CLIENT, description: camtDebit })],
      [], [purchase], THRESHOLD,
    );
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceTable, c.invoiceId])).toEqual([[1210, "purchase_invoices", 601]]);
  });

  it("keeps the sale-invoice fallback for a legacy unsigned C row", () => {
    const projection = computeExactMatchProjection(
      [tx({ type: "C", clients_id: INVOICE_CLIENT, description: "legacy row" })],
      [sale()], NO_PURCHASES, THRESHOLD,
    );
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceTable])).toEqual([[1210, "sale_invoices"]]);
  });
});

describe("computeExactMatchProjection exact_invoice_base_amount (F5)", () => {
  const eurRow = tx({
    id: 901, type: "C", amount: 290.03, base_amount: undefined, cl_currencies_id: "EUR",
    clients_id: 77, ref_number: "RF-5487", description: "Acme Cloud",
  } as Partial<Transaction>);
  const usdInvoice = {
    id: 5487, number: "INV-5487", clients_id: 77, client_name: "Acme Cloud LLC",
    cl_currencies_id: "USD", gross_price: 334.46, currency_rate: 1.1532, base_gross_price: 290.03,
    bank_ref_number: "RF-5487", payment_status: "NOT_PAID", status: "CONFIRMED",
  } as unknown as PurchaseInvoice;

  it("confirms the unique match at the EUR row amount when min_confidence <= 85", () => {
    const projection = computeExactMatchProjection([eurRow], [], [usdInvoice], 85);
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceTable, c.invoiceId, c.amount, c.confidence]))
      .toEqual([[901, "purchase_invoices", 5487, 290.03, 85]]);
    expect(projection.skipped).toEqual([]);
  });

  it("does not confirm at the default threshold of 90", () => {
    const projection = computeExactMatchProjection([eurRow], [], [usdInvoice], 90);
    expect(projection.confirms).toEqual([]);
  });

  // The live API reports an unpaid invoice as "" or null, never "NOT_PAID".
  it.each([[""], [null]])("treats payment_status %j as unpaid (live API shape)", (status) => {
    const live = { ...usdInvoice, payment_status: status } as unknown as PurchaseInvoice;
    const projection = computeExactMatchProjection([eurRow], [], [live], 85);
    expect(projection.confirms.map(c => [c.invoiceId, c.amount, c.confidence])).toEqual([[5487, 290.03, 85]]);
  });

  it.each([["PAID"], ["PARTIALLY_PAID"], ["SOMETHING_NEW"], [undefined]])("never matches a %s invoice at its base amount", (status) => {
    const invoice = { ...usdInvoice, payment_status: status } as unknown as PurchaseInvoice;
    expect(matchScore(eurRow, invoice, 290.03).reasons).not.toContain("exact_invoice_base_amount");
  });

  it("skips two Tier A candidates as ambiguous_foreign_invoice_base", () => {
    const second = { ...usdInvoice, id: 5488, number: "INV-5488", gross_price: 330 } as PurchaseInvoice;
    const projection = computeExactMatchProjection([eurRow], [], [usdInvoice, second], 40);
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([{ transaction_id: 901, reason: expect.stringContaining("ambiguous_foreign_invoice_base") }]);
  });

  const eur100 = tx({ id: 902, type: "C", amount: 100, base_amount: undefined, cl_currencies_id: "EUR", clients_id: 77, ref_number: undefined } as Partial<Transaction>);
  const eurInvoice = { ...usdInvoice, id: 6001, cl_currencies_id: "EUR", gross_price: 100, currency_rate: 1, base_gross_price: 100, bank_ref_number: undefined } as unknown as PurchaseInvoice;
  const usd200 = { ...usdInvoice, id: 6002, gross_price: 200, currency_rate: 2, base_gross_price: 100, bank_ref_number: undefined } as unknown as PurchaseInvoice;
  it.each([
    ["EUR invoice first", [eurInvoice, usd200]],
    ["USD invoice first", [usd200, eurInvoice]],
  ])("skips a mixed exact_amount / Tier A tie as ambiguous (%s)", (_label, purchases) => {
    const projection = computeExactMatchProjection([eur100], [], purchases, 40);
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([{ transaction_id: 902, reason: expect.stringContaining("ambiguous_foreign_invoice_base") }]);
  });

  it("still skips a foreign-row exact_base_amount match as cross-currency", () => {
    const usdRow = tx({ id: 903, type: "C", amount: 330, base_amount: 290.03, cl_currencies_id: "USD", clients_id: 77, ref_number: "RF-5487" } as Partial<Transaction>);
    const projection = computeExactMatchProjection([usdRow], [], [usdInvoice], 40);
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([{ transaction_id: 903, reason: expect.stringContaining("Cross-currency match") }]);
  });
});

describe("computeExactMatchProjection Tier A when the foreign gross equals its base", () => {
  const row = tx({ id: 950, type: "C", amount: 100, base_amount: undefined, cl_currencies_id: "EUR", clients_id: 77, ref_number: "RF-7001" } as Partial<Transaction>);
  const usdEqual = {
    id: 7001, number: "INV-7001", clients_id: 77, client_name: "Acme Cloud LLC", cl_currencies_id: "USD",
    gross_price: 100, currency_rate: 1, base_gross_price: 100, bank_ref_number: "RF-7001",
    payment_status: "NOT_PAID", status: "CONFIRMED",
  } as unknown as PurchaseInvoice;
  const eurInvoice = { ...usdEqual, id: 7002, cl_currencies_id: "EUR" } as unknown as PurchaseInvoice;

  it("does not confirm at the default threshold of 90 (capped at 85)", () => {
    const projection = computeExactMatchProjection([row], [], [usdEqual], 90);
    expect(projection.confirms).toEqual([]);
  });

  it.each([
    ["EUR invoice first", [eurInvoice, usdEqual]],
    ["USD invoice first", [usdEqual, eurInvoice]],
  ])("skips the EUR 100 / USD 100 (base 100) tie as ambiguous (%s)", (_label, purchases) => {
    // No reference: both score 55 (amount 40 + client 15), a true top-score tie.
    const refless = { ...row, ref_number: undefined } as Transaction;
    const unref = purchases.map(p => ({ ...p, bank_ref_number: undefined }) as unknown as PurchaseInvoice);
    const projection = computeExactMatchProjection([refless], [], unref, 40);
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([{ transaction_id: 950, reason: expect.stringContaining("ambiguous_foreign_invoice_base") }]);
  });
});


describe("computeExactMatchProjection ref_number_exact rule (live-shaped)", () => {
  // Live shape: every row reads back type "C"; direction comes only from the
  // signed marker; an unpaid confirmed invoice reads back payment_status "".
  // exact_amount (40) + ref_number (40) = 80 < the default 90.
  const DEFAULT = EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE;
  const wiseOut = "WISE:TRANSFER-77 Vendor [source_direction=OUT]";
  const unsignedTx = (overrides: Partial<Transaction> = {}) => tx({
    type: "C", cl_currencies_id: "EUR", clients_id: undefined, description: "Payment ARV-501", ...overrides,
  } as Partial<Transaction>);
  // A genuine, checksum-valid CAMT marker built from the row's own fields.
  const liveTx = (overrides: Partial<Transaction> = {}, direction: "CRDT" | "DBIT" = "CRDT") =>
    withSignedCamtMarker(unsignedTx(overrides), direction);
  const liveSale = (overrides: Partial<SaleInvoice> = {}) => sale({ cl_currencies_id: "EUR", payment_status: "", ...overrides } as Partial<SaleInvoice>);
  const livePurchase = (overrides: Partial<PurchaseInvoice> = {}) => ({
    id: 601, number: "P-601", clients_id: INVOICE_CLIENT, client_name: "Vendor", cl_currencies_id: "EUR",
    gross_price: 1488.0, base_gross_price: 1488.0, bank_ref_number: "REF-1488",
    payment_status: "", status: "CONFIRMED", ...overrides,
  }) as unknown as PurchaseInvoice;

  it("auto-confirms an incoming CRDT payment of a sale invoice at the default threshold, setting the client from the invoice", () => {
    const projection = computeExactMatchProjection([liveTx()], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.thirdPartyPayerReviews).toEqual([]);
    expect(projection.confirms).toHaveLength(1);
    expect(projection.confirms[0]).toMatchObject({
      transactionId: 1210, invoiceTable: "sale_invoices", invoiceId: 501, amount: 1488.0, confidence: 80,
      autoConfirmRule: "ref_number_exact", clientResolution: "set_missing", needsClientUpdate: true,
      invoiceClientsId: INVOICE_CLIENT, direction: "D",
    });
  });

  it("auto-confirms an outgoing signed DBIT payment of a purchase invoice (null payment_status)", () => {
    const projection = computeExactMatchProjection(
      [liveTx({}, "DBIT")], [], [livePurchase({ payment_status: null } as never)], DEFAULT,
    );
    expect(projection.confirms).toHaveLength(1);
    expect(projection.confirms[0]).toMatchObject({
      invoiceTable: "purchase_invoices", invoiceId: 601, autoConfirmRule: "ref_number_exact",
      clientResolution: "set_missing", direction: "C",
    });
  });

  it("leaves a score-qualified match unflagged", () => {
    const projection = computeExactMatchProjection([liveTx({ clients_id: INVOICE_CLIENT })], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toHaveLength(1);
    expect(projection.confirms[0]!.confidence).toBe(95);
    expect(projection.confirms[0]!.autoConfirmRule).toBeUndefined();
  });

  it("binds the rule flag into the plan fingerprint", () => {
    const projection = computeExactMatchProjection([liveTx()], [liveSale()], NO_PURCHASES, DEFAULT);
    const unflagged = { ...projection, confirms: [{ ...projection.confirms[0]!, autoConfirmRule: undefined }] };
    expect(exactMatchFingerprint(projection, DEFAULT)).not.toBe(exactMatchFingerprint(unflagged, DEFAULT));
  });

  it("never applies to an unsigned row (type C without a marker)", () => {
    const projection = computeExactMatchProjection([unsignedTx()], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
    expect(projection.thirdPartyPayerReviews).toEqual([]);
  });

  it("never applies to a tampered CAMT marker whose dir no longer matches its sig", () => {
    // A genuine outgoing marker flipped to dir=CRDT keeps its shape (so
    // bankTransactionDirection reads "incoming") but fails its checksum.
    const signed = liveTx({}, "DBIT");
    const tampered = { ...signed, description: signed.description!.replace("dir=DBIT", "dir=CRDT") };
    expect(tampered.description).toContain("dir=CRDT");
    expect(isTrustedCamtDescriptionMetadata(tampered)).toBe(false);
    const projection = computeExactMatchProjection([tampered], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
    expect(projection.thirdPartyPayerReviews).toEqual([]);
  });

  it("never applies to a Wise [source_direction] marker, which carries no checksum", () => {
    const projection = computeExactMatchProjection(
      [unsignedTx({ description: wiseOut })], [], [livePurchase({ payment_status: null } as never)], DEFAULT,
    );
    expect(projection.confirms).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["blank", "  "],
  ])("never applies to a row whose currency is %s (not proven EUR)", (_label, currency) => {
    // Sign the marker over the same blank currency the row reads back with, so
    // the checksum verifies and only the explicit-EUR requirement can refuse it.
    const row = unsignedTx({ cl_currencies_id: currency } as Partial<Transaction>);
    const text = "Payment ARV-501";
    const description = buildCamtDescriptionWithMetadata(text, {
      date: row.date!, amount: row.amount, currency: currency ?? "", direction: "CRDT",
      reference_number: row.ref_number ?? undefined, bank_reference: "BR-CCY", description: text,
    });
    const signed = { ...row, description } as Transaction;
    expect(isTrustedCamtDescriptionMetadata(signed)).toBe(true);
    const projection = computeExactMatchProjection([signed], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
  });

  it("never applies when the signed direction does not match the invoice kind", () => {
    expect(computeExactMatchProjection([liveTx({}, "CRDT")], [], [livePurchase()], DEFAULT).confirms).toEqual([]);
    expect(computeExactMatchProjection([liveTx({}, "DBIT")], [liveSale()], NO_PURCHASES, DEFAULT).confirms).toEqual([]);
  });

  it("never applies when the reference is shared by another open invoice of either kind", () => {
    const otherSale = computeExactMatchProjection(
      [liveTx()], [liveSale(), liveSale({ id: 502, number: "ARV-502", gross_price: 10, base_gross_price: 10 })], NO_PURCHASES, DEFAULT,
    );
    expect(otherSale.confirms).toEqual([]);
    const otherPurchase = computeExactMatchProjection(
      [liveTx()], [liveSale()], [livePurchase({ gross_price: 10, base_gross_price: 10 })], DEFAULT,
    );
    expect(otherPurchase.confirms).toEqual([]);
  });

  it.each([
    ["partially paid", { payment_status: "PARTIALLY_PAID" }],
    ["paid", { payment_status: "PAID" }],
    ["unknown payment status", { payment_status: "SOMETHING_NEW" }],
    ["not confirmed", { status: "PROJECT" }],
    ["missing status", { status: undefined }],
  ])("never applies to a %s invoice", (_label, overrides) => {
    const projection = computeExactMatchProjection([liveTx()], [liveSale(overrides as Partial<SaleInvoice>)], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
  });

  it("routes a differing payer to third-party-payer review, never auto", () => {
    const projection = computeExactMatchProjection([liveTx({ clients_id: PAYER })], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
    expect(projection.thirdPartyPayerReviews.map(r => [r.transaction_id, r.reason])).toEqual([[1210, "third_party_payer"]]);
  });

  it("never applies to a Tier A (foreign invoice base amount) match", () => {
    const usd = liveSale({ cl_currencies_id: "USD", gross_price: 1700, currency_rate: 0.8753, base_gross_price: 1488.0 } as Partial<SaleInvoice>);
    const projection = computeExactMatchProjection([liveTx({ clients_id: INVOICE_CLIENT })], [usd], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
  });

  it("never applies to a non-EUR row or a row with a differing base amount", () => {
    expect(computeExactMatchProjection([liveTx({ base_amount: 1400 })], [liveSale()], NO_PURCHASES, DEFAULT).confirms).toEqual([]);
    // Nominal AND base both match (exact_amount), but the row's EUR base differs from its amount.
    expect(computeExactMatchProjection(
      [liveTx({ base_amount: 1400 })], [liveSale({ base_gross_price: 1400 })], NO_PURCHASES, DEFAULT,
    ).confirms).toEqual([]);
    // Nominal-only matches across currencies (no base fields): exact_amount, but not EUR on both sides.
    const noBase = { base_gross_price: undefined, currency_rate: undefined } as Partial<SaleInvoice>;
    expect(computeExactMatchProjection(
      [liveTx({ cl_currencies_id: "USD", base_amount: undefined } as Partial<Transaction>)], [liveSale(noBase)], NO_PURCHASES, DEFAULT,
    ).confirms).toEqual([]);
    expect(computeExactMatchProjection(
      [liveTx({ base_amount: undefined })], [liveSale({ ...noBase, cl_currencies_id: "USD" } as Partial<SaleInvoice>)], NO_PURCHASES, DEFAULT,
    ).confirms).toEqual([]);
    expect(computeExactMatchProjection(
      [liveTx({ base_amount: undefined })], [liveSale({ ...noBase, cl_currencies_id: undefined } as Partial<SaleInvoice>)], NO_PURCHASES, DEFAULT,
    ).confirms).toEqual([]);
  });

  it("lets an explicit min_confidence above the default opt out", () => {
    const projection = computeExactMatchProjection([liveTx()], [liveSale()], NO_PURCHASES, 96);
    expect(projection.confirms).toEqual([]);
  });

  it("lets the first row claim the invoice; a second same-reference row gets nothing", () => {
    const projection = computeExactMatchProjection(
      [liveTx(), liveTx({ id: 1211, date: "2026-09-11" })], [liveSale()], NO_PURCHASES, DEFAULT,
    );
    expect(projection.confirms.map(c => c.transactionId)).toEqual([1210]);
  });
});

describe("computeExactMatchProjection direction proof for score-qualified matches", () => {
  // exact_amount (40) + ref_number (40) + client_name_partial (10) = 90, the
  // default. Live rows read back type "C"; without a verified marker the money
  // may have gone either way, so a substring name match must not settle the
  // invoice — only the invoice's own counterparty (equal client or equal name).
  const DEFAULT = EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE;
  const vendorSale = () => sale({ cl_currencies_id: "EUR", payment_status: "", client_name: "Vendor" } as Partial<SaleInvoice>);
  const row = (overrides: Partial<Transaction> = {}) => tx({
    type: "C", cl_currencies_id: "EUR", clients_id: undefined, bank_account_name: "Vendor Logistics",
    description: "Payment ARV-501", ...overrides,
  } as Partial<Transaction>);

  it("does not auto-confirm an unsigned row on a partial payer name; skips it as direction_unproven", () => {
    const projection = computeExactMatchProjection([row()], [vendorSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([{ transaction_id: 1210, reason: expect.stringContaining("direction_unproven") }]);
  });

  it("does not auto-confirm on a partial name when the marker is a Wise or tampered CAMT one", () => {
    const wise = row({ description: "WISE:TRANSFER-9 Vendor Logistics [source_direction=IN]" });
    const signedOut = withSignedCamtMarker(row(), "DBIT");
    const tampered = { ...signedOut, description: signedOut.description!.replace("dir=DBIT", "dir=CRDT") };
    for (const candidate of [wise, tampered]) {
      expect(computeExactMatchProjection([candidate], [vendorSale()], NO_PURCHASES, DEFAULT).confirms).toEqual([]);
    }
  });

  it("still auto-confirms an unsigned row whose clients_id equals the invoice's", () => {
    const projection = computeExactMatchProjection([row({ clients_id: INVOICE_CLIENT })], [vendorSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceId, c.confidence])).toEqual([[1210, 501, 95]]);
  });

  it("still auto-confirms an unsigned native-import row whose payer name equals the invoice client", () => {
    const projection = computeExactMatchProjection([row({ bank_account_name: "VENDOR" })], [vendorSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceId, c.confidence])).toEqual([[1210, 501, 90]]);
  });

  it("auto-confirms a partial-name match whose verified CAMT direction matches the invoice kind", () => {
    const projection = computeExactMatchProjection([withSignedCamtMarker(row(), "CRDT")], [vendorSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceId, c.confidence, c.autoConfirmRule])).toEqual([[1210, 501, 90, undefined]]);
  });
});

describe("computeExactMatchProjection currency evidence", () => {
  // exact_amount (40) + ref_number (40) + client_name_partial (10) = 90, the
  // default, on an unsigned live-shaped row whose payer name equals the
  // invoice client. The scorer compares bare numbers, so currency must be
  // proven separately before anything is confirmed automatically.
  const DEFAULT = EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE;
  const vendorRow = (overrides: Partial<Transaction> = {}) => tx({
    id: 2001, type: "C", amount: 100, base_amount: undefined, ref_number: "202618", clients_id: undefined,
    bank_account_name: "Vendor", cl_currencies_id: "EUR", description: "Arve 202618", ...overrides,
  } as Partial<Transaction>);
  const vendorSale = (overrides: Partial<SaleInvoice> = {}) => sale({
    id: 701, number: "ARV-701", client_name: "Vendor", gross_price: 100, base_gross_price: 100,
    bank_ref_number: "202618", payment_status: "", cl_currencies_id: "EUR", ...overrides,
  } as Partial<SaleInvoice>);

  it("still auto-confirms an explicit EUR row against a EUR invoice", () => {
    const projection = computeExactMatchProjection([vendorRow()], [vendorSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceId, c.currency, c.confidence])).toEqual([[2001, 701, "EUR", 90]]);
    expect(projection.skipped).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["blank", "  "],
  ])("skips a row with %s currency as currency_unproven at score 90", (_label, currency) => {
    const projection = computeExactMatchProjection(
      [vendorRow({ cl_currencies_id: currency as never })], [vendorSale()], NO_PURCHASES, DEFAULT,
    );
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([{
      transaction_id: 2001,
      reason: expect.stringMatching(/^currency_unproven: sale_invoice #701 .*no explicit currency/),
    }]);
  });

  it("skips an invoice without an explicit currency", () => {
    const projection = computeExactMatchProjection(
      [vendorRow()], [vendorSale({ cl_currencies_id: undefined } as never)], NO_PURCHASES, DEFAULT,
    );
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped[0]!.reason).toMatch(/^currency_unproven: .*invoice carries no explicit currency/);
  });

  it("never auto-confirms a USD row without a base amount against a EUR invoice", () => {
    const projection = computeExactMatchProjection(
      [vendorRow({ cl_currencies_id: "USD" })], [vendorSale()], NO_PURCHASES, DEFAULT,
    );
    expect(projection.confirms).toEqual([]);
    // Equal numbers across currencies now score cross_currency_conflict, so the
    // cross-currency skip fires before the currency-evidence gap.
    expect(projection.skipped).toEqual([{ transaction_id: 2001, reason: expect.stringContaining("Cross-currency match") }]);
  });

  it("auto-confirms a USD row whose finite EUR base amount equals the EUR invoice", () => {
    const projection = computeExactMatchProjection(
      [vendorRow({ cl_currencies_id: "USD", base_amount: 100 })], [vendorSale()], NO_PURCHASES, DEFAULT,
    );
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceId])).toEqual([[2001, 701]]);
  });

  it("still confirms the Tier A foreign-invoice base path (EUR row vs USD invoice base)", () => {
    const usdInvoice = {
      id: 5487, number: "INV-5487", clients_id: 77, client_name: "Acme Cloud LLC",
      cl_currencies_id: "USD", gross_price: 334.46, currency_rate: 1.1532, base_gross_price: 290.03,
      bank_ref_number: "RF-5487", payment_status: "", status: "CONFIRMED",
    } as unknown as PurchaseInvoice;
    const eurRow = tx({ id: 901, type: "C", amount: 290.03, base_amount: undefined, clients_id: 77, ref_number: "RF-5487" } as Partial<Transaction>);
    const projection = computeExactMatchProjection([eurRow], [], [usdInvoice], 85);
    expect(projection.confirms.map(c => [c.transactionId, c.invoiceId, c.amount])).toEqual([[901, 5487, 290.03]]);
    expect(projection.skipped).toEqual([]);
  });

  it("binds a currency_unproven skip into the plan fingerprint", () => {
    const confirmed = computeExactMatchProjection([vendorRow()], [vendorSale()], NO_PURCHASES, DEFAULT);
    const skipped = computeExactMatchProjection([vendorRow({ cl_currencies_id: undefined })], [vendorSale()], NO_PURCHASES, DEFAULT);
    expect(exactMatchFingerprint(skipped, DEFAULT)).not.toBe(exactMatchFingerprint(confirmed, DEFAULT));
  });
});

describe("computeExactMatchProjection explains an unverifiable CAMT marker", () => {
  const DEFAULT = EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE;
  const row = (overrides: Partial<Transaction> = {}) => tx({
    type: "C", cl_currencies_id: "EUR", clients_id: undefined, description: "Payment ARV-501", ...overrides,
  } as Partial<Transaction>);
  const liveSale = () => sale({ payment_status: "", client_name: "Vendor" } as Partial<SaleInvoice>);
  const tamper = (signed: Transaction) => ({ ...signed, description: signed.description!.replace("Payment", "Paymant") });

  it("skips a ref_number_exact match whose marker fails its checksum with that reason", () => {
    const tampered = tamper(withSignedCamtMarker(row(), "CRDT"));
    expect(isTrustedCamtDescriptionMetadata(tampered)).toBe(false);
    const projection = computeExactMatchProjection([tampered], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.confirms).toEqual([]);
    expect(projection.skipped).toEqual([{
      transaction_id: 1210,
      reason: expect.stringMatching(/^direction_unproven: CAMT marker checksum does not verify; sale_invoice #501/),
    }]);
  });

  it("names the failed checksum on a score-qualified direction_unproven skip", () => {
    const tampered = tamper(withSignedCamtMarker(row({ bank_account_name: "Vendor Logistics" }), "CRDT"));
    const projection = computeExactMatchProjection([tampered], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.skipped).toEqual([{
      transaction_id: 1210,
      reason: expect.stringMatching(/^direction_unproven: CAMT marker checksum does not verify; sale_invoice #501 matches/),
    }]);
  });

  it("keeps the plain direction_unproven reason for an unsigned row", () => {
    const projection = computeExactMatchProjection([row({ bank_account_name: "Vendor Logistics" })], [liveSale()], NO_PURCHASES, DEFAULT);
    expect(projection.skipped[0]!.reason).toMatch(/^direction_unproven: sale_invoice #501/);
  });
});
