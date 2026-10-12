import { describe, expect, it, vi } from "vitest";
import {
  CURRENCY_EQUIVALENT_AMBIGUITY_CODE,
  checkCurrencyEquivalent,
  supplierCurrencySignal,
} from "./currency-equivalent-check.js";
import { detectCurrencyEquivalentAmbiguity, extractReceiptFieldsFromText } from "./tools/receipt-extraction.js";
import { summarizeInvoiceExtraction } from "./invoice-extraction-fallback.js";
import { shouldGateCreation } from "./tools/receipt-inbox.js";
import type { PurchaseInvoice, Transaction } from "./types/api.js";

// Anonymised synthetic documents. (a) a USD invoice that prints its EUR
// equivalent; (b) a EUR card charge that prints the USD conversion.
const USD_WITH_EUR_EQUIVALENT = [
  "Example Supplier OU",
  "Invoice no INV-1001",
  "Date 2026-03-10",
  "Currency USD",
  "Total USD 110.00",
  "Summa eurodes 100.00 EUR",
].join("\n");
const EUR_WITH_USD_CONVERSION = [
  "Example Shop",
  "Receipt R-55",
  "Date 2026-03-10",
  "Card conversion: USD 110.00",
  "TOTAL 100.00 EUR",
].join("\n");
const EUR_ONLY = ["Example Shop", "Receipt R-56", "Date 2026-03-10", "TOTAL 100.00 EUR"].join("\n");

const SUPPLIER_ID = 7;

function invoice(id: number, currency: string, date: string, clientId = SUPPLIER_ID): PurchaseInvoice {
  return {
    id,
    clients_id: clientId,
    number: `H-${id}`,
    create_date: date,
    cl_currencies_id: currency,
    gross_price: 50,
    status: "CONFIRMED",
  } as unknown as PurchaseInvoice;
}

function history(currencies: string[]): PurchaseInvoice[] {
  return currencies.map((currency, index) => invoice(100 + index, currency, `2026-0${1 + (index % 2)}-${String(10 + index).padStart(2, "0")}`));
}

function tx(overrides: Partial<Transaction> & Pick<Transaction, "id" | "amount">): Transaction {
  return {
    accounts_dimensions_id: 1,
    type: "C",
    cl_currencies_id: "EUR",
    date: "2026-03-11",
    status: "PROJECT",
    ...overrides,
  } as Transaction;
}

function extract(text: string) {
  return extractReceiptFieldsFromText(text, "receipt.pdf");
}

describe("detectCurrencyEquivalentAmbiguity", () => {
  it("flags both indistinguishable shapes as EUR + USD ambiguous", () => {
    expect(detectCurrencyEquivalentAmbiguity(USD_WITH_EUR_EQUIVALENT)).toEqual({
      foreign_currency: "USD", eur_amount: 100, foreign_amount: 110,
    });
    expect(detectCurrencyEquivalentAmbiguity(EUR_WITH_USD_CONVERSION)).toEqual({
      foreign_currency: "USD", eur_amount: 100, foreign_amount: 110,
    });
  });

  it("does not flag a single-currency document or one with two foreign currencies", () => {
    expect(detectCurrencyEquivalentAmbiguity(EUR_ONLY)).toBeUndefined();
    expect(detectCurrencyEquivalentAmbiguity("Total USD 110.00\nShipping GBP 5.00\nTotal 100.00 EUR")).toBeUndefined();
    expect(detectCurrencyEquivalentAmbiguity("Total USD 110.00")).toBeUndefined();
    expect(detectCurrencyEquivalentAmbiguity(undefined)).toBeUndefined();
  });
});

describe("supplierCurrencySignal", () => {
  it("needs at least 3 invoices and an 80% share among the last 10", () => {
    expect(supplierCurrencySignal(history(["EUR", "EUR"]), SUPPLIER_ID)).toBeUndefined();
    expect(supplierCurrencySignal(history(["EUR", "EUR", "EUR", "EUR", "USD"]), SUPPLIER_ID)).toMatchObject({
      suggested_currency: "EUR", invoices_considered: 5, invoices_in_currency: 4,
    });
    expect(supplierCurrencySignal(history(["EUR", "EUR", "EUR", "USD", "USD"]), SUPPLIER_ID)).toBeUndefined();
  });

  it("ignores other suppliers and invalidated invoices", () => {
    const rows = [
      ...history(["USD", "USD", "USD"]).map(row => ({ ...row, clients_id: 99 })),
      ...history(["EUR", "EUR", "EUR"]).map(row => ({ ...row, status: "INVALIDATED" })),
    ];
    expect(supplierCurrencySignal(rows, SUPPLIER_ID)).toBeUndefined();
  });
});

describe("checkCurrencyEquivalent", () => {
  it("warns when supplier history contradicts the extracted currency (EUR picked, supplier bills in USD)", async () => {
    const extracted = extract(EUR_WITH_USD_CONVERSION);
    expect(extracted.currency).toBe("EUR");
    const warning = await checkCurrencyEquivalent({
      rawText: extracted.raw_text,
      extractedCurrency: extracted.currency,
      extractedGross: extracted.total_gross,
      invoiceDate: extracted.invoice_date,
      supplierClientId: SUPPLIER_ID,
      loadPurchaseInvoices: async () => history(["USD", "USD", "USD", "USD"]),
    });
    expect(warning).toMatchObject({
      code: CURRENCY_EQUIVALENT_AMBIGUITY_CODE,
      extracted_currency: "EUR",
      foreign_currency: "USD",
      supplier_history: { suggested_currency: "USD", invoices_considered: 4, invoices_in_currency: 4 },
    });
    expect(warning!.message).toContain("extraction picked EUR");
    expect(warning!.message).toContain("suggests USD");
    expect(warning!.message).toContain("the extracted currency was not changed");
  });

  it("warns when a candidate EUR payment matches the EUR figure of a USD-extracted document", async () => {
    const extracted = extract(USD_WITH_EUR_EQUIVALENT);
    expect(extracted.currency).toBe("USD");
    const warning = await checkCurrencyEquivalent({
      rawText: extracted.raw_text,
      extractedCurrency: extracted.currency,
      extractedGross: extracted.total_gross,
      invoiceDate: "2026-03-10",
      supplierClientId: SUPPLIER_ID,
      loadPurchaseInvoices: async () => [],
      loadTransactions: async () => [tx({ id: 501, amount: 100, cl_currencies_id: "EUR" })],
    });
    expect(warning).toMatchObject({
      extracted_currency: "USD",
      payment: { suggested_currency: "EUR", transaction_ids: [501] },
    });
    expect(warning!.supplier_history).toBeUndefined();
  });

  it("treats a Wise row whose other side is the foreign currency as supporting the foreign currency", async () => {
    const extracted = extract(EUR_WITH_USD_CONVERSION);
    const warning = await checkCurrencyEquivalent({
      rawText: extracted.raw_text,
      extractedCurrency: extracted.currency,
      extractedGross: extracted.total_gross,
      invoiceDate: "2026-03-10",
      loadTransactions: async () => [tx({
        id: 502,
        amount: 100,
        cl_currencies_id: "EUR",
        description: "WISE:CARD-1 Example Shop [110 USD @ 1.1] [source_direction=OUT]",
      })],
    });
    expect(warning).toMatchObject({
      extracted_currency: "EUR",
      payment: { suggested_currency: "USD", transaction_ids: [502] },
    });
  });

  it("emits nothing when the signals agree with the extraction", async () => {
    const extracted = extract(EUR_WITH_USD_CONVERSION);
    const warning = await checkCurrencyEquivalent({
      rawText: extracted.raw_text,
      extractedCurrency: extracted.currency,
      extractedGross: extracted.total_gross,
      invoiceDate: "2026-03-10",
      supplierClientId: SUPPLIER_ID,
      loadPurchaseInvoices: async () => history(["EUR", "EUR", "EUR"]),
      loadTransactions: async () => [tx({ id: 503, amount: 100, cl_currencies_id: "EUR" })],
    });
    expect(warning).toBeUndefined();
  });

  it("emits nothing when no signal is available, and drops a failing lookup", async () => {
    const extracted = extract(EUR_WITH_USD_CONVERSION);
    expect(await checkCurrencyEquivalent({ rawText: extracted.raw_text, extractedCurrency: extracted.currency })).toBeUndefined();
    expect(await checkCurrencyEquivalent({
      rawText: extracted.raw_text,
      extractedCurrency: extracted.currency,
      invoiceDate: "2026-03-10",
      supplierClientId: SUPPLIER_ID,
      loadPurchaseInvoices: async () => { throw new Error("offline"); },
      loadTransactions: async () => { throw new Error("offline"); },
    })).toBeUndefined();
  });

  it("does no lookup at all for a single-currency document", async () => {
    const extracted = extract(EUR_ONLY);
    const loadPurchaseInvoices = vi.fn(async () => history(["USD", "USD", "USD"]));
    const loadTransactions = vi.fn(async () => [] as Transaction[]);
    const warning = await checkCurrencyEquivalent({
      rawText: extracted.raw_text,
      extractedCurrency: extracted.currency,
      extractedGross: extracted.total_gross,
      invoiceDate: extracted.invoice_date,
      supplierClientId: SUPPLIER_ID,
      loadPurchaseInvoices,
      loadTransactions,
    });
    expect(warning).toBeUndefined();
    expect(loadPurchaseInvoices).not.toHaveBeenCalled();
    expect(loadTransactions).not.toHaveBeenCalled();
  });

  it("leaves the extraction output byte-identical in every case", async () => {
    for (const text of [USD_WITH_EUR_EQUIVALENT, EUR_WITH_USD_CONVERSION, EUR_ONLY]) {
      const before = JSON.stringify(extract(text));
      const extracted = extract(text);
      for (const currencies of [["USD", "USD", "USD"], ["EUR", "EUR", "EUR"]]) {
        await checkCurrencyEquivalent({
          rawText: extracted.raw_text,
          extractedCurrency: extracted.currency,
          extractedGross: extracted.total_gross,
          invoiceDate: "2026-03-10",
          supplierClientId: SUPPLIER_ID,
          loadPurchaseInvoices: async () => history(currencies),
          loadTransactions: async () => [tx({ id: 504, amount: 100 })],
        });
      }
      expect(JSON.stringify(extracted)).toBe(before);
    }
  });
});

describe("currency_equivalent_ambiguity review routing", () => {
  it("is a medium signal that gates automatic creation in every mode", () => {
    const extracted = {
      supplier_name: "Example Shop", invoice_number: "R-55", invoice_date: "2026-03-10",
      total_gross: 100, currency: "EUR", raw_text: EUR_WITH_USD_CONVERSION,
    };
    expect(summarizeInvoiceExtraction(extracted, {}).confidence).toBe("high");
    const summary = summarizeInvoiceExtraction(extracted, { currency_equivalent_ambiguity: true });
    expect(summary.confidence).toBe("medium");
    expect(summary.confidence_signals).toContain("currency_equivalent_ambiguity");
    expect(summary.recommended).toBe(true);
    expect(shouldGateCreation(summary, "create").gate).toBe(true);
    expect(shouldGateCreation(summary, "create_and_confirm").gate).toBe(true);
    expect(summarizeInvoiceExtraction(extracted, {}).confidence_signals).not.toContain("currency_equivalent_ambiguity");
  });
});
