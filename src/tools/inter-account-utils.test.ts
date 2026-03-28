import { describe, it, expect } from "vitest";
import { buildBankAccountLookups, buildInterAccountJournalIndex } from "./inter-account-utils.js";
import type { BankAccount, AccountDimension, Journal, Posting } from "../types/api.js";

// --- Helpers ---

function makeBankAccount(overrides: Partial<BankAccount> & { account_name_est: string; account_no: string }): BankAccount {
  return { ...overrides };
}

function makeAccountDimension(overrides: Partial<AccountDimension> & { accounts_id: number }): AccountDimension {
  return { title_est: "dim", ...overrides };
}

function makeJournal(id: number, effective_date: string, postings: Posting[], overrides?: Partial<Journal>): Journal {
  return {
    id,
    effective_date,
    registered: true,
    is_deleted: false,
    postings,
    ...overrides,
  };
}

function makePosting(accounts_dimensions_id: number, type: "D" | "C", amount: number, base_amount?: number): Posting {
  return {
    accounts_id: 1000,
    accounts_dimensions_id,
    type,
    amount,
    ...(base_amount !== undefined ? { base_amount } : {}),
    is_deleted: false,
  };
}

// --- buildBankAccountLookups ---

describe("buildBankAccountLookups", () => {
  it("returns empty maps for empty input", () => {
    const result = buildBankAccountLookups([], []);
    expect(result.ownIbanToDimension.size).toBe(0);
    expect(result.dimensionToIban.size).toBe(0);
    expect(result.dimensionToTitle.size).toBe(0);
    expect(result.dimensionToAccountsId.size).toBe(0);
    expect(result.ownDimensionIds.size).toBe(0);
  });

  it("maps IBAN to dimension and back", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "LHV", account_no: "EE123", iban_code: "EE123456789", accounts_dimensions_id: 10 }),
    ];
    const dims: AccountDimension[] = [
      makeAccountDimension({ id: 10, accounts_id: 1010, is_deleted: false }),
    ];

    const result = buildBankAccountLookups(accounts, dims);

    expect(result.ownIbanToDimension.get("EE123456789")).toBe(10);
    expect(result.dimensionToIban.get(10)).toBe("EE123456789");
    expect(result.dimensionToTitle.get(10)).toBe("LHV");
    expect(result.ownDimensionIds.has(10)).toBe(true);
  });

  it("prefers iban_code over account_no when both present", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "Wise", account_no: "WISE001", iban_code: "EE987654321", accounts_dimensions_id: 20 }),
    ];
    const result = buildBankAccountLookups(accounts, []);

    expect(result.ownIbanToDimension.has("EE987654321")).toBe(true);
    expect(result.ownIbanToDimension.has("WISE001")).toBe(false);
  });

  it("falls back to account_no when iban_code is absent", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "Coop", account_no: "coop001", accounts_dimensions_id: 30 }),
    ];
    const result = buildBankAccountLookups(accounts, []);

    // account_no is trimmed and uppercased
    expect(result.ownIbanToDimension.has("COOP001")).toBe(true);
    expect(result.dimensionToIban.get(30)).toBe("COOP001");
  });

  it("trims and uppercases the IBAN", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "LHV", account_no: "  ee000111  ", accounts_dimensions_id: 40 }),
    ];
    const result = buildBankAccountLookups(accounts, []);

    expect(result.ownIbanToDimension.has("EE000111")).toBe(true);
  });

  it("skips bank accounts with no accounts_dimensions_id", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "NoId", account_no: "EE999" }),
    ];
    const result = buildBankAccountLookups(accounts, []);

    expect(result.ownIbanToDimension.size).toBe(0);
  });

  it("skips bank accounts with empty IBAN and empty account_no", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "Empty", account_no: "   ", iban_code: "   ", accounts_dimensions_id: 50 }),
    ];
    const result = buildBankAccountLookups(accounts, []);

    expect(result.ownIbanToDimension.size).toBe(0);
  });

  it("handles multiple bank accounts", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "LHV", account_no: "EE100", accounts_dimensions_id: 100 }),
      makeBankAccount({ account_name_est: "Wise", account_no: "EE200", accounts_dimensions_id: 200 }),
      makeBankAccount({ account_name_est: "SEB", account_no: "EE300", accounts_dimensions_id: 300 }),
    ];
    const result = buildBankAccountLookups(accounts, []);

    expect(result.ownIbanToDimension.size).toBe(3);
    expect(result.dimensionToIban.size).toBe(3);
    expect(result.ownDimensionIds.size).toBe(3);
    expect(result.ownIbanToDimension.get("EE100")).toBe(100);
    expect(result.ownIbanToDimension.get("EE200")).toBe(200);
    expect(result.ownIbanToDimension.get("EE300")).toBe(300);
  });

  it("maps dimensionToAccountsId from AccountDimension list", () => {
    const dims: AccountDimension[] = [
      makeAccountDimension({ id: 10, accounts_id: 1010, is_deleted: false }),
      makeAccountDimension({ id: 20, accounts_id: 1020, is_deleted: false }),
    ];
    const result = buildBankAccountLookups([], dims);

    expect(result.dimensionToAccountsId.get(10)).toBe(1010);
    expect(result.dimensionToAccountsId.get(20)).toBe(1020);
  });

  it("excludes deleted AccountDimensions from dimensionToAccountsId", () => {
    const dims: AccountDimension[] = [
      makeAccountDimension({ id: 10, accounts_id: 1010, is_deleted: false }),
      makeAccountDimension({ id: 11, accounts_id: 1011, is_deleted: true }),
    ];
    const result = buildBankAccountLookups([], dims);

    expect(result.dimensionToAccountsId.has(10)).toBe(true);
    expect(result.dimensionToAccountsId.has(11)).toBe(false);
  });

  it("excludes AccountDimensions with no id from dimensionToAccountsId", () => {
    const dims: AccountDimension[] = [
      makeAccountDimension({ accounts_id: 1010, is_deleted: false }), // id undefined
    ];
    const result = buildBankAccountLookups([], dims);

    expect(result.dimensionToAccountsId.size).toBe(0);
  });

  it("ownDimensionIds reflects only the bank accounts with valid IBAN+dimensionId", () => {
    const accounts: BankAccount[] = [
      makeBankAccount({ account_name_est: "LHV", account_no: "EE100", accounts_dimensions_id: 100 }),
    ];
    const dims: AccountDimension[] = [
      makeAccountDimension({ id: 100, accounts_id: 1010 }),
      makeAccountDimension({ id: 999, accounts_id: 2020 }), // not a bank account
    ];
    const result = buildBankAccountLookups(accounts, dims);

    expect(result.ownDimensionIds.has(100)).toBe(true);
    expect(result.ownDimensionIds.has(999)).toBe(false);
  });
});

// --- buildInterAccountJournalIndex ---

describe("buildInterAccountJournalIndex", () => {
  const ownDims = new Set([10, 20, 30]);

  it("returns empty map for empty journals", () => {
    const result = buildInterAccountJournalIndex([], ownDims);
    expect(result.size).toBe(0);
  });

  it("indexes a basic inter-account transfer with bidirectional keys", () => {
    const journals: Journal[] = [
      makeJournal(1001, "2024-03-15", [
        makePosting(10, "C", 500),
        makePosting(20, "D", 500),
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    // key1: credit|debit|amount|date
    expect(result.get("10|20|500|2024-03-15")).toBe(1001);
    // key2: debit|credit|amount|date
    expect(result.get("20|10|500|2024-03-15")).toBe(1001);
    expect(result.size).toBe(2);
  });

  it("uses base_amount when present instead of amount", () => {
    const journals: Journal[] = [
      makeJournal(2001, "2024-04-01", [
        makePosting(10, "C", 450, 500), // base_amount=500
        makePosting(20, "D", 450, 500),
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.get("10|20|500|2024-04-01")).toBe(2001);
    expect(result.get("20|10|500|2024-04-01")).toBe(2001);
  });

  it("skips deleted journals", () => {
    const journals: Journal[] = [
      makeJournal(3001, "2024-05-10", [
        makePosting(10, "C", 100),
        makePosting(20, "D", 100),
      ], { is_deleted: true }),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });

  it("skips unregistered journals", () => {
    const journals: Journal[] = [
      makeJournal(4001, "2024-05-10", [
        makePosting(10, "C", 100),
        makePosting(20, "D", 100),
      ], { registered: false }),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });

  it("skips journals without postings", () => {
    const journals: Journal[] = [
      makeJournal(5001, "2024-05-10", []),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });

  it("skips journals where postings have no accounts_dimensions_id in ownDimensionIds", () => {
    const journals: Journal[] = [
      makeJournal(6001, "2024-06-01", [
        makePosting(99, "C", 200), // 99 not in ownDims
        makePosting(88, "D", 200), // 88 not in ownDims
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });

  it("skips journals with only one bank account posting", () => {
    const journals: Journal[] = [
      makeJournal(7001, "2024-06-15", [
        makePosting(10, "C", 300),
        makePosting(99, "D", 300), // 99 not in ownDims
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });

  it("skips journals where both bank postings have the same type (D+D or C+C)", () => {
    const journals: Journal[] = [
      makeJournal(8001, "2024-07-01", [
        makePosting(10, "D", 400),
        makePosting(20, "D", 400),
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });

  it("skips deleted postings when counting bank account postings", () => {
    const deletedPosting: Posting = { ...makePosting(20, "D", 500), is_deleted: true };
    const journals: Journal[] = [
      makeJournal(9001, "2024-08-01", [
        makePosting(10, "C", 500),
        deletedPosting,
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    // Only 1 non-deleted bank posting → skipped
    expect(result.size).toBe(0);
  });

  it("skips postings with no accounts_dimensions_id", () => {
    const noIdPosting: Posting = {
      accounts_id: 1000,
      accounts_dimensions_id: null,
      type: "D",
      amount: 500,
      is_deleted: false,
    };
    const journals: Journal[] = [
      makeJournal(10001, "2024-08-15", [
        makePosting(10, "C", 500),
        noIdPosting,
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });

  it("indexes multiple journals independently", () => {
    const journals: Journal[] = [
      makeJournal(101, "2024-01-10", [
        makePosting(10, "C", 1000),
        makePosting(20, "D", 1000),
      ]),
      makeJournal(102, "2024-01-11", [
        makePosting(20, "C", 750),
        makePosting(30, "D", 750),
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.get("10|20|1000|2024-01-10")).toBe(101);
    expect(result.get("20|10|1000|2024-01-10")).toBe(101);
    expect(result.get("20|30|750|2024-01-11")).toBe(102);
    expect(result.get("30|20|750|2024-01-11")).toBe(102);
    expect(result.size).toBe(4);
  });

  it("rounds amount to 2 decimal places in the key", () => {
    const journals: Journal[] = [
      makeJournal(201, "2024-09-01", [
        makePosting(10, "C", 0, 1.005), // base_amount rounds to 1.01
        makePosting(20, "D", 0, 1.005),
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.has("10|20|1.01|2024-09-01")).toBe(true);
    expect(result.has("20|10|1.01|2024-09-01")).toBe(true);
  });

  it("skips journals with more than 2 bank account postings", () => {
    const journals: Journal[] = [
      makeJournal(301, "2024-10-01", [
        makePosting(10, "C", 200),
        makePosting(20, "D", 100),
        makePosting(30, "D", 100),
      ]),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    expect(result.size).toBe(0);
  });
});
