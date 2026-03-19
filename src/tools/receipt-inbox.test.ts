import { describe, expect, it } from "vitest";
import { categorizeTransactionGroup, hasRecurringSimilarAmounts, normalizeCounterpartyName } from "./receipt-inbox.js";

function makeTx(overrides: Partial<{
  type: string;
  amount: number;
  description: string;
  date: string;
  bank_subtype: string;
}> = {}) {
  return {
    type: "C",
    amount: 10,
    description: "",
    date: "2026-03-01",
    bank_subtype: "",
    ...overrides,
  };
}

describe("normalizeCounterpartyName", () => {
  it("removes common company suffixes and punctuation", () => {
    expect(normalizeCounterpartyName("AS LHV Pank")).toBe("lhv");
    expect(normalizeCounterpartyName("OÜ OpenAI, Inc.")).toBe("openai");
  });
});

describe("hasRecurringSimilarAmounts", () => {
  it("detects similar recurring amounts", () => {
    expect(hasRecurringSimilarAmounts([19.99, 20.49, 20.01])).toBe(true);
  });

  it("rejects widely different amounts", () => {
    expect(hasRecurringSimilarAmounts([10, 20])).toBe(false);
  });
});

describe("categorizeTransactionGroup", () => {
  it("classifies tax authority payments", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "emta",
      transactions: [makeTx({ description: "TAX PAYMENT" })],
    });

    expect(result.category).toBe("tax_payments");
    expect(result.apply_mode).toBe("review_only");
  });

  it("classifies bank fees", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "lhv",
      transactions: [makeTx({ amount: 5.5, description: "Monthly fee" })],
    });

    expect(result.category).toBe("bank_fees");
    expect(result.apply_mode).toBe("purchase_invoice");
  });

  it("classifies recurring non-person counterparties as subscriptions", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "openai ireland limited",
      transactions: [
        makeTx({ amount: 20, description: "ChatGPT subscription" }),
        makeTx({ amount: 20.4, description: "ChatGPT subscription", date: "2026-04-01" }),
      ],
    });

    expect(result.category).toBe("saas_subscriptions");
    expect(result.recurring).toBe(true);
    expect(result.similar_amounts).toBe(true);
  });

  it("classifies known owner counterparties separately", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "john doe",
      owner_counterparties: new Set(["john doe"]),
      transactions: [makeTx({ amount: 300 })],
    });

    expect(result.category).toBe("owner_transfers");
  });

  it("classifies incoming unmatched payments as revenue without invoice", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "customer payment",
      transactions: [makeTx({ type: "D", amount: 1500 })],
    });

    expect(result.category).toBe("revenue_without_invoice");
  });

  it("classifies bolt and similar card purchases", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "bolt",
      transactions: [makeTx({ description: "Card purchase", bank_subtype: "card" })],
    });

    expect(result.category).toBe("card_purchases");
    expect(result.apply_mode).toBe("purchase_invoice");
  });
});
