import { describe, it, expect } from "vitest";
import {
  validateAccounts,
  validateItemDimensions,
  validatePostingDimensions,
  validateSaleInvoiceItemDimensions,
  validateTransactionDistributionDimensions,
} from "./account-validation.js";
import type { Account, AccountDimension, Posting, PurchaseInvoiceItem, SaleInvoiceItem, TransactionDistribution } from "./types/api.js";

// Minimal Account stub — only the fields validateAccounts reads
function account(id: number, name_est: string, is_valid = true): Account {
  return { id, name_est, is_valid } as Account;
}

function dimensionalAccount(id: number, name_est: string): Account {
  return { id, name_est, is_valid: true, allows_dimensions: true } as Account;
}

function dimension(id: number, accounts_id: number, title_est: string): AccountDimension {
  return { id, accounts_id, title_est } as AccountDimension;
}

describe("validateAccounts", () => {
  it("returns no errors for an empty targets array", () => {
    const errors = validateAccounts([account(1000, "Kassa")], []);
    expect(errors).toEqual([]);
  });

  it("returns no errors when all targets are valid active accounts", () => {
    const accounts = [account(1000, "Kassa"), account(2000, "Laen")];
    const errors = validateAccounts(accounts, [
      { id: 1000, label: "Debit account" },
      { id: 2000, label: "Credit account" },
    ]);
    expect(errors).toEqual([]);
  });

  it("reports an error for a missing account ID", () => {
    const errors = validateAccounts([], [{ id: 9999, label: "Debit account" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/9999/);
    expect(errors[0]).toMatch(/not found/);
    expect(errors[0]).toMatch(/Debit account/);
  });

  it("error message for missing account contains activation guidance", () => {
    const errors = validateAccounts([], [{ id: 1234, label: "Kulu konto" }]);
    expect(errors[0]).toMatch(/Seaded.*Kontoplaan/);
    expect(errors[0]).toMatch(/1234/);
  });

  it("reports an error for an inactive account", () => {
    const errors = validateAccounts(
      [account(5000, "Varud", false)],
      [{ id: 5000, label: "Inventory account" }],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/5000/);
    expect(errors[0]).toMatch(/inactive/);
    expect(errors[0]).toMatch(/Varud/);
  });

  it("inactive account error message contains the account's Estonian name", () => {
    const errors = validateAccounts(
      [account(3000, "Pikaajaline laen", false)],
      [{ id: 3000, label: "Long-term loan" }],
    );
    expect(errors[0]).toMatch(/Pikaajaline laen/);
  });

  it("deduplicates targets with the same id + label", () => {
    const accounts = [account(1000, "Kassa")];
    const errors = validateAccounts(accounts, [
      { id: 1000, label: "Debit account" },
      { id: 1000, label: "Debit account" }, // duplicate
      { id: 1000, label: "Debit account" }, // duplicate
    ]);
    // All three are valid so no errors, but the key point is dedup runs
    expect(errors).toEqual([]);
  });

  it("deduplicates duplicate missing-account targets and reports error only once", () => {
    const errors = validateAccounts([], [
      { id: 9999, label: "Missing" },
      { id: 9999, label: "Missing" },
    ]);
    expect(errors).toHaveLength(1);
  });

  it("does not deduplicate targets with the same id but different labels", () => {
    const errors = validateAccounts([], [
      { id: 9999, label: "Label A" },
      { id: 9999, label: "Label B" },
    ]);
    // Different labels → different keys → two separate error entries
    expect(errors).toHaveLength(2);
  });

  it("handles a mix of valid, missing, and inactive accounts", () => {
    const accounts = [
      account(1000, "Kassa", true),   // valid
      account(2000, "Laen", false),   // inactive
      // 3000 is absent                 // missing
    ];
    const errors = validateAccounts(accounts, [
      { id: 1000, label: "Cash" },
      { id: 2000, label: "Loan" },
      { id: 3000, label: "Reserve" },
    ]);

    expect(errors).toHaveLength(2);
    const combined = errors.join("\n");
    expect(combined).toMatch(/3000.*not found|not found.*3000/);
    expect(combined).toMatch(/2000.*inactive|inactive.*2000/);
    expect(combined).not.toMatch(/1000/); // valid account produces no error
  });

  it("returns errors in the order targets were provided", () => {
    const accounts = [account(2000, "B", false)];
    const errors = validateAccounts(accounts, [
      { id: 9999, label: "Missing" },
      { id: 2000, label: "Inactive" },
    ]);
    expect(errors[0]).toMatch(/not found/);
    expect(errors[1]).toMatch(/inactive/);
  });
});

describe("dimension validators", () => {
  it("reports missing purchase accounts before dimension checks", () => {
    const items: PurchaseInvoiceItem[] = [{
      custom_title: "Internet",
      purchase_accounts_id: 5000,
      vat_accounts_id: 1510,
    }];

    const errors = validateItemDimensions(
      items,
      [account(1510, "Sisendkäibemaks")],
      [],
    );

    expect(errors).toHaveLength(1);
    // Purchase-side error labels use positional index only — item.custom_title
    // is OCR-seeded from create_purchase_invoice_from_pdf and must not flow
    // through validation prose (see account-validation.ts).
    expect(errors[0]).toContain('Item 1 purchase account 5000');
    expect(errors[0]).not.toContain("Internet");
    expect(errors[0]).toContain("not found");
  });

  it("auto-fills unique purchase and VAT dimensions", () => {
    const items: PurchaseInvoiceItem[] = [{
      custom_title: "Internet",
      purchase_accounts_id: 5000,
      vat_accounts_id: 1510,
    }];

    const errors = validateItemDimensions(
      items,
      [dimensionalAccount(5000, "Internetikulu"), dimensionalAccount(1510, "Sisendkäibemaks")],
      [dimension(10, 5000, "Main"), dimension(20, 1510, "VAT Main")],
    );

    expect(errors).toEqual([]);
    expect(items[0]!.purchase_accounts_dimensions_id).toBe(10);
    expect(items[0]!.vat_accounts_dimensions_id).toBe(20);
  });

  it("rejects invalid provided purchase dimension ids", () => {
    const items: PurchaseInvoiceItem[] = [{
      custom_title: "Internet",
      purchase_accounts_id: 5000,
      purchase_accounts_dimensions_id: 999,
    }];

    const errors = validateItemDimensions(
      items,
      [dimensionalAccount(5000, "Internetikulu")],
      [dimension(10, 5000, "Main")],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("purchase_accounts_dimensions_id 999 is not a valid dimension");
  });

  it("requires VAT dimensions when multiple VAT account dimensions exist", () => {
    const items: PurchaseInvoiceItem[] = [{
      custom_title: "Internet",
      vat_accounts_id: 1510,
    }];

    const errors = validateItemDimensions(
      items,
      [dimensionalAccount(1510, "Sisendkäibemaks")],
      [dimension(20, 1510, "VAT Main"), dimension(21, 1510, "VAT Backup")],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("vat_accounts_dimensions_id is required");
  });

  it("auto-fills unique sale account dimensions", () => {
    const items: SaleInvoiceItem[] = [{
      products_id: 1,
      custom_title: "Service",
      amount: 1,
      sale_accounts_id: 3000,
    }];

    const errors = validateSaleInvoiceItemDimensions(
      items,
      [dimensionalAccount(3000, "Müügitulu")],
      [dimension(30, 3000, "Revenue Main")],
    );

    expect(errors).toEqual([]);
    expect(items[0]!.sale_accounts_dimensions_id).toBe(30);
  });

  it("reports inactive sale accounts before dimension checks", () => {
    const items: SaleInvoiceItem[] = [{
      products_id: 1,
      custom_title: "Service",
      amount: 1,
      sale_accounts_id: 3000,
    }];

    const errors = validateSaleInvoiceItemDimensions(
      items,
      [account(3000, "Müügitulu", false)],
      [],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Item 1 "Service" sale account 3000');
    expect(errors[0]).toContain("inactive");
  });

  it("rejects sale VAT accounts that require unsupported dimensions", () => {
    const items: SaleInvoiceItem[] = [{
      products_id: 1,
      custom_title: "Service",
      amount: 1,
      vat_accounts_id: 1510,
    }];

    const errors = validateSaleInvoiceItemDimensions(
      items,
      [dimensionalAccount(1510, "Käibemaks")],
      [dimension(40, 1510, "VAT Main")],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not support vat_accounts_dimensions_id");
  });

  it("auto-fills unique posting dimensions", () => {
    const postings: Posting[] = [{
      accounts_id: 1000,
      amount: 10,
      type: "D",
    }];

    const errors = validatePostingDimensions(
      postings,
      [dimensionalAccount(1000, "Kassa")],
      [dimension(50, 1000, "Cash desk")],
    );

    expect(errors).toEqual([]);
    expect(postings[0]!.accounts_dimensions_id).toBe(50);
  });

  it("reports missing posting accounts", () => {
    const postings: Posting[] = [{
      accounts_id: 1000,
      amount: 10,
      type: "D",
    }];

    const errors = validatePostingDimensions(postings, [], []);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Posting 1 account 1000");
    expect(errors[0]).toContain("not found");
  });

  it("auto-fills unique transaction distribution dimensions", () => {
    const distributions: TransactionDistribution[] = [{
      related_table: "accounts",
      related_id: 1360,
      amount: 1620.7,
    }];

    const errors = validateTransactionDistributionDimensions(
      distributions,
      [dimensionalAccount(1360, "Arveldused aruandvate isikutega")],
      [dimension(60, 1360, "Employee A")],
    );

    expect(errors).toEqual([]);
    expect(distributions[0]!.related_sub_id).toBe(60);
  });

  it("reports inactive transaction distribution accounts", () => {
    const distributions: TransactionDistribution[] = [{
      related_table: "accounts",
      related_id: 1360,
      amount: 1620.7,
    }];

    const errors = validateTransactionDistributionDimensions(
      distributions,
      [account(1360, "Arveldused aruandvate isikutega", false)],
      [],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Distribution 1 account 1360");
    expect(errors[0]).toContain("inactive");
  });

  it("requires related_sub_id when the account has multiple dimensions and none was passed", () => {
    // Without a pre-flight, the API returns a cryptic
    // "Entry cannot be made directly to the account ... since it has dimensions"
    // error; the validator catches this client-side with a clearer hint.
    const distributions: TransactionDistribution[] = [{
      related_table: "accounts",
      related_id: 1360,
      amount: 1620.7,
    }];

    const errors = validateTransactionDistributionDimensions(
      distributions,
      [dimensionalAccount(1360, "Arveldused aruandvate isikutega")],
      [
        dimension(60, 1360, "Employee A"),
        dimension(61, 1360, "Employee B"),
      ],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("related_sub_id is required");
    expect(errors[0]).toContain("Employee A");
    expect(errors[0]).toContain("Employee B");
    expect(distributions[0]!.related_sub_id).toBeUndefined();
  });

  it("rejects an invalid related_sub_id that does not belong to the account", () => {
    const distributions: TransactionDistribution[] = [{
      related_table: "accounts",
      related_id: 1360,
      related_sub_id: 999, // not a valid dimension for this account
      amount: 1620.7,
    }];

    const errors = validateTransactionDistributionDimensions(
      distributions,
      [dimensionalAccount(1360, "Arveldused aruandvate isikutega")],
      [
        dimension(60, 1360, "Employee A"),
        dimension(61, 1360, "Employee B"),
      ],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("related_sub_id 999 is not a valid dimension");
  });
});
