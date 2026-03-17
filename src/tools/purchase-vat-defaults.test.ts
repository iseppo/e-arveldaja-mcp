import { describe, it, expect } from "vitest";
import { normalizeVatRate, applyPurchaseVatDefaults } from "./purchase-vat-defaults.js";
import type { PurchaseInvoiceItem } from "../types/api.js";

describe("normalizeVatRate", () => {
  it("normalizes number to string", () => {
    expect(normalizeVatRate(24)).toBe("24");
    expect(normalizeVatRate(9.5)).toBe("9.5");
    expect(normalizeVatRate(0)).toBe("0");
  });

  it("normalizes string with comma", () => {
    expect(normalizeVatRate("22,0")).toBe("22");
    expect(normalizeVatRate("9,5")).toBe("9.5");
  });

  it("handles dash (no VAT)", () => {
    expect(normalizeVatRate("-")).toBe("-");
  });

  it("returns undefined for empty/null/undefined", () => {
    expect(normalizeVatRate(undefined)).toBeUndefined();
    expect(normalizeVatRate("")).toBeUndefined();
    expect(normalizeVatRate(null)).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(normalizeVatRate("  24  ")).toBe("24");
  });

  it("returns undefined for non-finite numbers", () => {
    expect(normalizeVatRate(NaN)).toBeUndefined();
    expect(normalizeVatRate(Infinity)).toBeUndefined();
  });
});

describe("applyPurchaseVatDefaults", () => {
  const emptyArticles: any[] = [];

  it("sets default cl_fringe_benefits_id and amount", () => {
    const item = { custom_title: "test", cl_purchase_articles_id: 1 } as PurchaseInvoiceItem;
    const result = applyPurchaseVatDefaults(emptyArticles, item, true);
    expect(result.cl_fringe_benefits_id).toBe(1);
    expect(result.amount).toBe(1);
  });

  it("preserves caller-provided values", () => {
    const item = { custom_title: "test", cl_purchase_articles_id: 1, cl_fringe_benefits_id: 2, amount: 5 } as PurchaseInvoiceItem;
    const result = applyPurchaseVatDefaults(emptyArticles, item, true);
    expect(result.cl_fringe_benefits_id).toBe(2);
    expect(result.amount).toBe(5);
  });

  it("uses fallback VAT defaults for VAT-registered companies", () => {
    const item = { custom_title: "test", cl_purchase_articles_id: 1 } as PurchaseInvoiceItem;
    const result = applyPurchaseVatDefaults(emptyArticles, item, true);
    expect(result.vat_accounts_id).toBe(1510);
    expect(result.cl_vat_articles_id).toBe(1);
  });

  it("sets vat_rate_dropdown to dash for non-VAT companies", () => {
    const item = { custom_title: "test", cl_purchase_articles_id: 1 } as PurchaseInvoiceItem;
    const result = applyPurchaseVatDefaults(emptyArticles, item, false);
    expect(result.vat_rate_dropdown).toBe("-");
  });

  it("for non-VAT with specific rate, sets cl_vat_articles_id fallback to 11", () => {
    const item = { custom_title: "test", cl_purchase_articles_id: 1, vat_rate_dropdown: "24" } as PurchaseInvoiceItem;
    const result = applyPurchaseVatDefaults(emptyArticles, item, false);
    expect(result.cl_vat_articles_id).toBe(11);
  });

  it("falls back to another article with matching VAT rate when selected has no defaults", () => {
    const articles = [
      { id: 10, name_est: "Internetikulu", name_eng: "Internet expense", vat_rate_dropdown: "24", priority: 1, cl_account_groups: [] },
      { id: 99, name_est: "Sisendkäibemaks 24%", name_eng: "Input VAT 24%", vat_accounts_id: 1510, cl_vat_articles_id: 1, vat_rate: 24, priority: 1, cl_account_groups: [] },
    ] as any[];

    const result = applyPurchaseVatDefaults(
      articles,
      { custom_title: "Internet", cl_purchase_articles_id: 10, vat_rate_dropdown: "24" } as PurchaseInvoiceItem,
      true,
    );
    expect(result.vat_accounts_id).toBe(1510);
    expect(result.cl_vat_articles_id).toBe(1);
  });

  it("uses purchase_accounts_id as vat_accounts_id fallback for non-VAT with specific rate", () => {
    const result = applyPurchaseVatDefaults(
      [],
      { custom_title: "Fuel", cl_purchase_articles_id: 1, purchase_accounts_id: 5230, vat_rate_dropdown: "24" } as PurchaseInvoiceItem,
      false,
    );
    expect(result.vat_accounts_id).toBe(5230);
    expect(result.cl_vat_articles_id).toBe(11);
  });

  it("resolves defaults from matching purchase article", () => {
    const articles = [{
      id: 45,
      level: 1,
      name_est: "Internet ja sideteenused",
      name_eng: "Internet and communication",
      accounts_id: 5230,
      vat_accounts_id: 1510,
      cl_vat_articles_id: 1,
      vat_rate_dropdown: "24",
      vat_rate: 24,
      priority: 1,
      cl_account_groups: [],
    }] as any[];

    const item = { custom_title: "test", cl_purchase_articles_id: 45 } as PurchaseInvoiceItem;
    const result = applyPurchaseVatDefaults(articles, item, true);
    expect(result.vat_accounts_id).toBe(1510);
    expect(result.cl_vat_articles_id).toBe(1);
  });
});
