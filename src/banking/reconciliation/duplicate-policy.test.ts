import { describe, expect, it } from "vitest";
import { computeExactMatchProjection, THIRD_PARTY_PAYER_NEXT_ACTION } from "./duplicate-policy.js";
import { exactMatchFingerprint } from "./projection.js";
import type { PurchaseInvoice, SaleInvoice, Transaction } from "../../types/api.js";

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
    const projection = computeExactMatchProjection([tx({ clients_id: undefined })], [sale()], NO_PURCHASES, THRESHOLD);

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
