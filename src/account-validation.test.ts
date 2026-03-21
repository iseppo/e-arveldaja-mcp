import { describe, it, expect } from "vitest";
import { validateAccounts } from "./account-validation.js";
import type { Account } from "./types/api.js";

// Minimal Account stub — only the fields validateAccounts reads
function account(id: number, name_est: string, is_valid = true): Account {
  return { id, name_est, is_valid } as Account;
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
