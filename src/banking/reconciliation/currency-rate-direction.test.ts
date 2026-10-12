import { describe, expect, it } from "vitest";
import type { Transaction } from "../../types/api.js";
import { resolveOneSidedTransferAmount } from "./amount-resolution.js";
import { getComparableBaseInvoiceAmount } from "./invoice-index.js";

// e-arveldaja `currency_rate` is FOREIGN currency units per 1 EUR (ECB
// convention, e.g. USD 1.08): the EUR amount is amount / currency_rate.
describe("currency_rate direction (foreign units per 1 EUR)", () => {
  it("derives an invoice EUR base as gross / rate", () => {
    expect(getComparableBaseInvoiceAmount({ gross_price: 108, currency_rate: 1.08 })).toBe(100);
  });

  it("prefers an explicit base_gross_price over the rate fallback", () => {
    expect(getComparableBaseInvoiceAmount({ gross_price: 108, base_gross_price: 99.5, currency_rate: 1.08 })).toBe(99.5);
  });

  it("derives a one-sided transfer EUR amount as amount / rate", () => {
    const tx = { amount: 108, cl_currencies_id: "USD", currency_rate: 1.08 } as unknown as Transaction;
    expect(resolveOneSidedTransferAmount(tx)).toEqual({ ok: true, nominalAmount: 108, currency: "USD", amountEur: 100 });
  });

  it("accepts a base_amount that agrees with amount / rate and rejects the inverted reading", () => {
    const agreeing = { amount: 108, cl_currencies_id: "USD", currency_rate: 1.08, base_amount: 100 } as unknown as Transaction;
    expect(resolveOneSidedTransferAmount(agreeing)).toMatchObject({ ok: true, amountEur: 100 });
    // 108 * 1.08 = 116.64 is the EUR-per-foreign misreading; it must conflict.
    const inverted = { amount: 108, cl_currencies_id: "USD", currency_rate: 1.08, base_amount: 116.64 } as unknown as Transaction;
    expect(resolveOneSidedTransferAmount(inverted)).toMatchObject({ ok: false });
  });
});
