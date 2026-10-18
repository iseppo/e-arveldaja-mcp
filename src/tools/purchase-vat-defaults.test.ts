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

describe("GitHub #63: the non-deductible VAT form for non-VAT companies", () => {
  const {
    isNonDeductibleVatItem, classifyNonVatInvoiceForm, proveNonDeductibleInvoice, validateNonVatItem, collectNonVatItemErrors,
  } = purchaseVatDefaults;
  const account = (id: number, isVatAccount: boolean | undefined) => ({ id, is_vat_account: isVatAccount }) as never;
  const CHART = [account(7910, false), account(6000, false), account(1510, true)];
  const ui = (overrides: Partial<PurchaseInvoiceItem> = {}): PurchaseInvoiceItem => ({
    custom_title: "Delfi",
    purchase_accounts_id: 7910,
    purchase_accounts_dimensions_id: 942283,
    vat_accounts_id: 7910,
    vat_accounts_dimensions_id: 942283,
    cl_vat_articles_id: 11,
    vat_rate_dropdown: "9",
    total_net_price: 11.92,
    vat_amount: 1.07,
    ...overrides,
  });
  const row24 = (net: number, vat: number, overrides: Partial<PurchaseInvoiceItem> = {}) =>
    ui({ purchase_accounts_id: 6000, purchase_accounts_dimensions_id: null, vat_accounts_id: 6000, vat_accounts_dimensions_id: null,
      vat_rate_dropdown: "24", total_net_price: net, vat_amount: vat, ...overrides });
  const header = (net: number, vat: number, gross: number, extra: Record<string, unknown> = {}) =>
    ({ net_price: net, vat_price: vat, gross_price: gross, cl_currencies_id: "EUR", ...extra });

  describe("1. shape", () => {
    it("accepts the same-account 7910/942283, article 11, rate 9 row", () => {
      expect(isNonDeductibleVatItem(ui())).toBe(true);
      expect(validateNonVatItem(ui())).toEqual([]);
    });

    it.each([
      ["a 1510 VAT account", { vat_accounts_id: 1510 }],
      ["a VAT dimension that differs", { vat_accounts_dimensions_id: 1 }],
      ["a one-sided VAT dimension (missing)", { vat_accounts_dimensions_id: null }],
      ["a one-sided VAT dimension (cost account has none)", { purchase_accounts_dimensions_id: null }],
      ["article 1", { cl_vat_articles_id: 1 }],
      ["rate \"-\"", { vat_rate_dropdown: "-" }],
      ["rate \"0\"", { vat_rate_dropdown: "0" }],
      ["a non-numeric rate", { vat_rate_dropdown: "KM" }],
      ["a reversed_vat_id", { reversed_vat_id: 1 }],
    ])("rejects %s", (_label, overrides) => {
      const item = ui(overrides as Partial<PurchaseInvoiceItem>);
      expect(isNonDeductibleVatItem(item)).toBe(false);
      expect(validateNonVatItem(item).length).toBeGreaterThan(0);
    });

    it("names the incomplete non-deductible shape when the VAT account equals the cost account", () => {
      expect(validateNonVatItem(ui({ cl_vat_articles_id: 1 }))).toContain(
        "the non-deductible form (VAT on the cost account) also needs vat_accounts_dimensions_id equal to purchase_accounts_dimensions_id, " +
        "cl_vat_articles_id 11, a numeric vat_rate_dropdown above 0 and no reversed_vat_id");
    });

    it("refuses mixed forms and mixed rates at list level", () => {
      expect(collectNonVatItemErrors([ui(), { custom_title: "Folded", purchase_accounts_id: 6000, total_net_price: 5 }]))
        .toContain("items mix the folded form (no VAT account) and the non-deductible form (VAT account = cost account); use one form for the whole invoice");
      expect(collectNonVatItemErrors([ui(), row24(100, 24)]))
        .toContain("non-deductible items carry different VAT rates; an invoice in this form uses one rate");
    });
  });

  describe("2. classifier", () => {
    it.each([
      ["is_vat_account true", [account(7910, true)]],
      ["is_vat_account undefined", [account(7910, undefined)]],
      ["the account missing from the chart", [account(6000, false)]],
      ["no chart", undefined],
    ])("%s → unproven", (_label, accounts) => {
      expect(classifyNonVatInvoiceForm([ui()], accounts)).toBe("unproven");
    });

    it("mixed folded + non-deductible and mixed rates → unproven; all folded → folded; proven → non_deductible", () => {
      const folded = { custom_title: "Folded", purchase_accounts_id: 6000, total_net_price: 5, cl_vat_articles_id: 11, vat_rate_dropdown: "-" };
      expect(classifyNonVatInvoiceForm([ui(), folded], CHART)).toBe("unproven");
      expect(classifyNonVatInvoiceForm([ui(), row24(100, 24)], CHART)).toBe("unproven");
      expect(classifyNonVatInvoiceForm([folded, folded])).toBe("folded");
      expect(classifyNonVatInvoiceForm([ui()], CHART)).toBe("non_deductible");
    });
  });

  describe("3. proveNonDeductibleInvoice", () => {
    const ok = (rows: PurchaseInvoiceItem[], head: Record<string, unknown>) => expect(proveNonDeductibleInvoice(rows, head, CHART)).toMatchObject({ ok: true });
    const reject = (rows: PurchaseInvoiceItem[], head: Record<string, unknown>) => expect(proveNonDeductibleInvoice(rows, head, CHART)).toMatchObject({ ok: false });

    it("11.92 @9 → 1.07 / 12.99 and 609.20 @24 → 146.21 / 755.41 are proven", () => {
      expect(proveNonDeductibleInvoice([ui()], header(11.92, 1.07, 12.99), CHART)).toEqual({ ok: true, rate: "9" });
      ok([row24(609.2, 146.21)], header(609.2, 146.21, 755.41));
    });

    it("a last-row residue of 0.01 is proven; 0.02 is not", () => {
      ok([row24(100, 24.01)], header(100, 24.01, 124.01));
      reject([row24(100, 24.02)], header(100, 24.02, 124.02));
    });

    it("override + residue: net 100 @24, override 124.01, VAT 24.02 / gross 124.02 → rejected (0.02 off the rate)", () => {
      reject([row24(100, 24.02, { project_no_vat_gross_price: 124.01 })], header(100, 24.02, 124.02));
      reject([row24(100, 24.02, { project_no_vat_gross_price: 124.02 })], header(100, 24.02, 124.02));
    });

    it("redistribution: two net-100 @24 rows with VAT 24.01 / 23.99 (header 200/48/248) → rejected (row 1 not cent-exact)", () => {
      reject([row24(100, 24.01), row24(100, 23.99, { purchase_accounts_id: 7910, vat_accounts_id: 7910 })], header(200, 48, 248));
    });

    it("header mismatches are rejected", () => {
      reject([ui()], header(12.92, 1.07, 13.99));
      reject([ui()], header(11.92, 1.07, 13.99));
      reject([row24(100, 24), row24(100, 24)], header(200, 48.02, 248.02));
    });

    it("an override disagreeing with net + VAT, a non-finite amount and a reversed_vat_id are rejected", () => {
      reject([ui({ project_no_vat_gross_price: 13.99 })], header(11.92, 1.07, 12.99));
      reject([ui({ vat_amount: Number.NaN })], header(11.92, 1.07, 12.99));
      reject([ui({ total_net_price: Number.POSITIVE_INFINITY })], header(11.92, 1.07, 12.99));
      reject([ui()], header(11.92, 1.07, Number.NaN));
      reject([ui({ reversed_vat_id: 1 })], header(11.92, 1.07, 12.99));
    });

    it("a row base net other than the row net, and non-EUR or base settlement overrides, are rejected", () => {
      reject([ui({ base_total_net_price: 10 })], header(11.92, 1.07, 12.99));
      ok([ui({ base_total_net_price: 11.92 })], header(11.92, 1.07, 12.99, { currency_rate: 1, base_net_price: 11.92, base_vat_price: 1.07, base_gross_price: 12.99 }));
      reject([ui()], header(11.92, 1.07, 12.99, { cl_currencies_id: "USD" }));
      reject([ui()], header(11.92, 1.07, 12.99, { currency_rate: 1.08 }));
      reject([ui()], header(11.92, 1.07, 12.99, { base_gross_price: 10 }));
      reject([ui()], { net_price: 11.92, vat_price: 1.07, gross_price: 12.99 }); // a read-back without currency
    });

    it("an intended payload predicts the row VAT and refuses a supplied vat_amount", () => {
      const intended = (rows: PurchaseInvoiceItem[], head: Record<string, unknown>) => proveNonDeductibleInvoice(rows, head, CHART, { intended: true });
      const { vat_amount: _vat, ...payloadRow } = ui();
      expect(intended([payloadRow], { net_price: 11.92, vat_price: 1.07, gross_price: 12.99 })).toEqual({ ok: true, rate: "9" });
      expect(intended([ui()], { net_price: 11.92, vat_price: 1.07, gross_price: 12.99 })).toMatchObject({ ok: false });
    });
  });

  describe("4. applyPurchaseVatDefaults", () => {
    it("folds a non-deductible item without the option (receipt/classification, Q4) and keeps it with the option", () => {
      const folded = applyPurchaseVatDefaults([], ui(), false);
      expect(folded).not.toHaveProperty("vat_accounts_id");
      expect(folded).not.toHaveProperty("vat_accounts_dimensions_id");
      expect(folded).toMatchObject({ cl_vat_articles_id: 11, vat_rate_dropdown: "-" });
      expect(applyPurchaseVatDefaults([], ui(), false, { allowNonDeductible: true }))
        .toEqual({ ...ui(), cl_fringe_benefits_id: 1, amount: 1 });
      // An item that is not the shape folds even with the option.
      expect(applyPurchaseVatDefaults([], ui({ vat_accounts_id: 1510 }), false, { allowNonDeductible: true })).not.toHaveProperty("vat_accounts_id");
    });

    it("VAT-registered defaults are unchanged by the option", () => {
      const item = { custom_title: "Internet", purchase_accounts_id: 5230, total_net_price: 100, vat_rate_dropdown: "24" };
      expect(applyPurchaseVatDefaults([], item, true, { allowNonDeductible: true })).toEqual(applyPurchaseVatDefaults([], item, true));
    });
  });
});
