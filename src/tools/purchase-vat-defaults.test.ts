import { describe, it, expect } from "vitest";
import * as purchaseVatDefaults from "./purchase-vat-defaults.js";
import type { PurchaseInvoiceItem } from "../types/api.js";

const { normalizeVatRate, applyPurchaseVatDefaults } = purchaseVatDefaults;

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

  function expectCanonicalNonVat(
    articles: any[],
    item: PurchaseInvoiceItem,
  ): PurchaseInvoiceItem {
    const before = structuredClone(item);
    const result = applyPurchaseVatDefaults(articles, item, false);

    expect(result).not.toHaveProperty("vat_accounts_id");
    expect(result).not.toHaveProperty("vat_accounts_dimensions_id");
    expect(result.cl_vat_articles_id).toBe(11);
    expect(result.vat_rate_dropdown).toBe("-");
    expect(item).toEqual(before);
    return result;
  }

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

  it("M21 removes deductible VAT fields supplied directly on a non-VAT item", () => {
    expectCanonicalNonVat(
      [],
      {
        custom_title: "Fuel",
        cl_purchase_articles_id: 1,
        purchase_accounts_id: 5230,
        vat_accounts_id: 1510,
        vat_accounts_dimensions_id: 15101,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
      } as PurchaseInvoiceItem,
    );
  });

  it("M21 canonicalizes deductible defaults from the selected article for a non-VAT company", () => {
    expectCanonicalNonVat(
      [{
        id: 45,
        name_est: "Sisendkäibemaks",
        name_eng: "Input VAT",
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
        priority: 1,
        cl_account_groups: [],
      }],
      { custom_title: "Internet", cl_purchase_articles_id: 45 } as PurchaseInvoiceItem,
    );
  });

  it("M21 canonicalizes deductible defaults from a rate-matched article for a non-VAT company", () => {
    expectCanonicalNonVat(
      [
        { id: 10, name_est: "Internetikulu", name_eng: "Internet expense", priority: 1, cl_account_groups: [] },
        {
          id: 99,
          name_est: "Sisendkäibemaks 24%",
          name_eng: "Input VAT 24%",
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          vat_rate_dropdown: "24",
          priority: 1,
          cl_account_groups: [],
        },
      ],
      { custom_title: "Internet", cl_purchase_articles_id: 10, vat_rate_dropdown: "24" } as PurchaseInvoiceItem,
    );
  });

  it("M21 canonicalizes deductible defaults from a keyword-matched article for a non-VAT company", () => {
    expectCanonicalNonVat(
      [
        { id: 10, name_est: "Kütus", name_eng: "Fuel", priority: 1, cl_account_groups: [] },
        {
          id: 98,
          name_est: "Mitte mahaarvatav käibemaks",
          name_eng: "Non-deductible VAT",
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          priority: 1,
          cl_account_groups: [],
        },
      ],
      { custom_title: "Fuel", cl_purchase_articles_id: 10, vat_rate_dropdown: "24" } as PurchaseInvoiceItem,
    );
  });

  it("M21 non-VAT canonicalization is independent of purchase-article order", () => {
    const articles = [
      {
        id: 90,
        name_est: "KM 24 esimene",
        name_eng: "VAT 24 first",
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
        priority: 1,
        cl_account_groups: [],
      },
      {
        id: 91,
        name_est: "KM 24 teine",
        name_eng: "VAT 24 second",
        vat_accounts_id: 1511,
        cl_vat_articles_id: 2,
        vat_rate_dropdown: "24",
        priority: 1,
        cl_account_groups: [],
      },
    ];
    const item = { custom_title: "Fuel", cl_purchase_articles_id: 10, vat_rate_dropdown: "24" } as PurchaseInvoiceItem;

    const forward = expectCanonicalNonVat(articles, item);
    const reverse = expectCanonicalNonVat([...articles].reverse(), item);

    expect(forward).toEqual(reverse);
  });

  it("M21 preserves an already-canonical non-VAT item", () => {
    const item = {
      custom_title: "Membership",
      cl_purchase_articles_id: 10,
      purchase_accounts_id: 5230,
      cl_vat_articles_id: 11,
      vat_rate_dropdown: "-",
    } as PurchaseInvoiceItem;

    expect(expectCanonicalNonVat([], item)).toMatchObject({
      custom_title: "Membership",
      cl_purchase_articles_id: 10,
      purchase_accounts_id: 5230,
      cl_vat_articles_id: 11,
      vat_rate_dropdown: "-",
    });
  });

  it("M21 preserves VAT-registered deductible defaults and rate behavior", () => {
    const articles = [{
      id: 45,
      name_est: "Sisendkäibemaks",
      name_eng: "Input VAT",
      vat_accounts_id: 1510,
      cl_vat_articles_id: 1,
      vat_rate_dropdown: "24",
      priority: 1,
      cl_account_groups: [],
    }];
    const item = {
      custom_title: "Internet",
      cl_purchase_articles_id: 45,
      vat_rate_dropdown: "24",
    } as PurchaseInvoiceItem;
    const before = structuredClone(item);

    expect(applyPurchaseVatDefaults(articles, item, true)).toMatchObject({
      vat_accounts_id: 1510,
      cl_vat_articles_id: 1,
      vat_rate_dropdown: "24",
    });
    expect(item).toEqual(before);
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

describe("M21 validateNonVatItem", () => {
  it("treats null as absence and rejects every normalized non-dash VAT conflict without mutation", () => {
    const validator = (purchaseVatDefaults as any).validateNonVatItem;
    expect(validator).toBeTypeOf("function");

    const allowedItems = [
      { custom_title: "Absent", cl_purchase_articles_id: 1 },
      {
        custom_title: "Null",
        cl_purchase_articles_id: 1,
        vat_accounts_id: null,
        vat_accounts_dimensions_id: null,
        cl_vat_articles_id: null,
        vat_rate_dropdown: null,
      },
      { custom_title: "Canonical", cl_purchase_articles_id: 1, cl_vat_articles_id: 11, vat_rate_dropdown: "  -  " },
    ] as unknown as PurchaseInvoiceItem[];
    const conflictCases: Array<[PurchaseInvoiceItem, string[]]> = [
      [
        { custom_title: "VAT account", cl_purchase_articles_id: 1, vat_accounts_id: 1510 },
        ["vat_accounts_id must be absent"],
      ],
      [
        { custom_title: "VAT dimension", cl_purchase_articles_id: 1, vat_accounts_dimensions_id: 15101 },
        ["vat_accounts_dimensions_id must be absent"],
      ],
      [
        { custom_title: "VAT article", cl_purchase_articles_id: 1, cl_vat_articles_id: 1 },
        ["cl_vat_articles_id must be absent or 11"],
      ],
      [
        { custom_title: "String zero", cl_purchase_articles_id: 1, vat_rate_dropdown: "0" },
        ["vat_rate_dropdown must be absent or \"-\""],
      ],
      [
        { custom_title: "Numeric zero", cl_purchase_articles_id: 1, vat_rate_dropdown: 0 as unknown as string },
        ["vat_rate_dropdown must be absent or \"-\""],
      ],
      [
        { custom_title: "Comma rate", cl_purchase_articles_id: 1, vat_rate_dropdown: "24,0" },
        ["vat_rate_dropdown must be absent or \"-\""],
      ],
      [
        { custom_title: "Malformed rate", cl_purchase_articles_id: 1, vat_rate_dropdown: "not-vat" },
        ["vat_rate_dropdown must be absent or \"-\""],
      ],
      [
        {
          custom_title: "All conflicts",
          cl_purchase_articles_id: 1,
          vat_accounts_id: 1510,
          vat_accounts_dimensions_id: 15101,
          cl_vat_articles_id: 1,
          vat_rate_dropdown: "24",
        },
        [
          "vat_accounts_id must be absent",
          "vat_accounts_dimensions_id must be absent",
          "cl_vat_articles_id must be absent or 11",
          "vat_rate_dropdown must be absent or \"-\"",
        ],
      ],
    ];

    for (const item of allowedItems) {
      const before = structuredClone(item);
      expect.soft(validator(item), item.custom_title).toEqual([]);
      expect.soft(item, `${item.custom_title} mutation`).toEqual(before);
    }
    for (const [item, expected] of conflictCases) {
      const before = structuredClone(item);
      expect.soft(validator(item), item.custom_title).toEqual(expected);
      expect.soft(item, `${item.custom_title} mutation`).toEqual(before);
    }
  });
});
