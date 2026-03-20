import { describe, expect, it } from "vitest";
import {
  categorizeTransactionGroup,
  detectReceiptCurrency,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  extractAmounts,
  extractPdfIdentifiers,
  getAutoBookedVatConfig,
  getAutoBookedVatRateDropdown,
  getClientCountryFromIban,
  hasRecurringSimilarAmounts,
  looksLikePersonCounterparty,
  normalizeCounterpartyName,
} from "./receipt-inbox.js";

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

describe("extractAmounts", () => {
  it("ignores registry and reference numbers when falling back to the gross amount", () => {
    const result = extractAmounts([
      "Reg nr 737350",
      "Viitenumber 123456",
      "KMKR EE123456789",
      "24,40 EUR",
    ].join("\n"));

    expect(result.total_gross).toBe(24.4);
  });
});

describe("detectReceiptCurrency", () => {
  it("detects non-euro currencies from receipt text", () => {
    expect(detectReceiptCurrency("Amount due 12.50 USD")).toBe("USD");
  });

  it("defaults to EUR when no currency marker is present", () => {
    expect(detectReceiptCurrency("Kokku 24,40")).toBe("EUR");
  });
});

describe("extractPdfIdentifiers", () => {
  it("extracts alphanumeric IBAN values from receipt text", () => {
    const result = extractPdfIdentifiers("Supplier IBAN: IE29AIBK93115212345678");

    expect(result.supplier_iban).toBe("IE29AIBK93115212345678");
  });
});

describe("getClientCountryFromIban", () => {
  it("maps foreign IBAN prefixes to e-arveldaja country codes", () => {
    expect(getClientCountryFromIban("IE29AIBK93115212345678")).toBe("IRL");
    expect(getClientCountryFromIban("EE471000001020145685")).toBe("EST");
  });
});

describe("looksLikePersonCounterparty", () => {
  it("rejects company-like names and all-caps legal suffixes", () => {
    expect(
      looksLikePersonCounterparty(normalizeCounterpartyName("OpenAI Ireland Limited"), "OpenAI Ireland Limited"),
    ).toBe(false);
    expect(
      looksLikePersonCounterparty(normalizeCounterpartyName("TELIA EESTI AS"), "TELIA EESTI AS"),
    ).toBe(false);
  });

  it("accepts normal person-style names", () => {
    expect(looksLikePersonCounterparty(normalizeCounterpartyName("John Doe"), "John Doe")).toBe(true);
  });
});

describe("getAutoBookedVatConfig", () => {
  it("uses reverse charge metadata for foreign SaaS suppliers", () => {
    expect(getAutoBookedVatConfig("saas_subscriptions", "IRL")).toEqual({
      vat_rate_dropdown: "24",
      reversed_vat_id: 1,
    });
  });
});

describe("getAutoBookedVatRateDropdown", () => {
  it("uses domestic VAT defaults and keeps bank fees VAT-free", () => {
    expect(getAutoBookedVatRateDropdown("card_purchases", "EST")).toBe("24");
    expect(getAutoBookedVatRateDropdown("saas_subscriptions", "IRL")).toBe("24");
    expect(getAutoBookedVatRateDropdown("bank_fees", "EST")).toBe("-");
  });
});

describe("deriveAutoBookedNetAmount", () => {
  it("backs domestic VAT-inclusive card purchases down to a net amount", () => {
    const vatConfig = getAutoBookedVatConfig("card_purchases", "EST");

    expect(deriveAutoBookedNetAmount(100, vatConfig)).toBeCloseTo(80.645161, 6);
    expect(deriveAutoBookedVatPrice(100, vatConfig)).toBe(19.35);
  });

  it("keeps reverse-charge SaaS purchases at their supplier gross amount", () => {
    const vatConfig = getAutoBookedVatConfig("saas_subscriptions", "IRL");

    expect(deriveAutoBookedNetAmount(100, vatConfig)).toBe(100);
    expect(deriveAutoBookedVatPrice(100, vatConfig)).toBe(0);
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

  it("does not classify incoming bank credits as bank fees", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "lhv",
      transactions: [makeTx({ type: "D", amount: 5.5, description: "Monthly fee refund" })],
    });

    expect(result.category).toBe("revenue_without_invoice");
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

  it("classifies incoming EMTA transactions before the generic revenue fallback", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "emta",
      display_counterparty: "EMTA",
      transactions: [makeTx({ type: "D", amount: 300 })],
    });

    expect(result.category).toBe("tax_payments");
  });

  it("classifies incoming owner transfers before the generic revenue fallback", () => {
    const result = categorizeTransactionGroup({
      normalized_counterparty: "john doe",
      display_counterparty: "John Doe",
      owner_counterparties: new Set(["john doe"]),
      transactions: [makeTx({ type: "D", amount: 300 })],
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
