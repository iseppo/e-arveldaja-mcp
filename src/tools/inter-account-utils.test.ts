import { describe, it, expect } from "vitest";
import { buildBankAccountLookups, buildInterAccountJournalIndex, findMatchingJournal } from "./inter-account-utils.js";
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

    // key1: credit|debit|amount|date → [{ journal_id, document_number }]
    expect(result.get("10|20|500|2024-03-15")?.[0]?.journal_id).toBe(1001);
    // key2: debit|credit|amount|date
    expect(result.get("20|10|500|2024-03-15")?.[0]?.journal_id).toBe(1001);
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

    expect(result.get("10|20|500|2024-04-01")?.[0]?.journal_id).toBe(2001);
    expect(result.get("20|10|500|2024-04-01")?.[0]?.journal_id).toBe(2001);
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

    expect(result.get("10|20|1000|2024-01-10")?.[0]?.journal_id).toBe(101);
    expect(result.get("20|10|1000|2024-01-10")?.[0]?.journal_id).toBe(101);
    expect(result.get("20|30|750|2024-01-11")?.[0]?.journal_id).toBe(102);
    expect(result.get("30|20|750|2024-01-11")?.[0]?.journal_id).toBe(102);
    expect(result.size).toBe(4);
  });

  it("collects multiple journals sharing (sourceDim, targetDim, amount, date) into the same key", () => {
    // Two unrelated €500 LHV↔SEB transfers on the same day with different
    // reference numbers — now stored together so reference-based
    // disambiguation in findMatchingJournal can tell them apart.
    const journals: Journal[] = [
      makeJournal(401, "2024-11-01", [
        makePosting(10, "C", 500),
        makePosting(20, "D", 500),
      ], { document_number: "WISE-A" }),
      makeJournal(402, "2024-11-01", [
        makePosting(10, "C", 500),
        makePosting(20, "D", 500),
      ], { document_number: "WISE-B" }),
    ];
    const result = buildInterAccountJournalIndex(journals, ownDims);

    const entries = result.get("10|20|500|2024-11-01");
    expect(entries).toHaveLength(2);
    expect(entries?.map(e => e.journal_id).sort()).toEqual([401, 402]);
    expect(entries?.map(e => e.document_number).sort()).toEqual(["WISE-A", "WISE-B"]);
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

describe("findMatchingJournal", () => {
  it("returns undefined for empty/undefined candidate list", () => {
    expect(findMatchingJournal(undefined, "anything")).toBeUndefined();
    expect(findMatchingJournal([], "anything")).toBeUndefined();
  });

  it("returns the single candidate when no reference disambiguation is requested", () => {
    expect(findMatchingJournal([{ journal_id: 42 }])).toBe(42);
    expect(findMatchingJournal([{ journal_id: 42, document_number: "REF-1" }])).toBe(42);
  });

  it("prefers an exact reference match over a ref-less candidate", () => {
    const candidates = [
      { journal_id: 100, document_number: null },
      { journal_id: 200, document_number: "WISE-X" },
    ];
    expect(findMatchingJournal(candidates, "WISE-X")).toBe(200);
  });

  it("returns undefined when every candidate has a reference and none match the input", () => {
    // Two unrelated €500 same-day transfers with different refs — the new
    // import should NOT be suppressed by either existing journal.
    const candidates = [
      { journal_id: 100, document_number: "WISE-A" },
      { journal_id: 200, document_number: "WISE-B" },
    ];
    expect(findMatchingJournal(candidates, "WISE-C")).toBeUndefined();
  });

  it("returns undefined when input ref mismatches and mixed ref-less + ref'd candidates are present", () => {
    // The tightened policy: if ANY candidate has a ref and none match the
    // input, the input is a distinct transfer — don't silently absorb it
    // into a ref-less catch-all. Protects labelled imports (Wise, CAMT
    // with document_number) from ref-less journals with coincident
    // amount+date+dims.
    const candidates = [
      { journal_id: 100, document_number: null },
      { journal_id: 200, document_number: "WISE-B" },
    ];
    expect(findMatchingJournal(candidates, "WISE-C")).toBeUndefined();
  });

  it("still absorbs into a ref-less catch-all when ALL candidates are ref-less (legacy migration)", () => {
    // Legacy journals predating document_number labelling act as a pool.
    // A new import with a reference can match one of them since we can't
    // prove they're unrelated.
    const candidates = [
      { journal_id: 100, document_number: null },
      { journal_id: 200, document_number: "" },
    ];
    expect(findMatchingJournal(candidates, "WISE-C")).toBe(100);
  });

  it("returns undefined even against 9 ref-less + 1 mismatched-ref candidates", () => {
    // Pathological case: a pool of unlabelled journals plus a single
    // labelled journal with a DIFFERENT ref from the input. Absorbing
    // into the unlabelled pool would silently suppress a distinct
    // transfer; the tightened policy rejects.
    const candidates = [
      ...Array.from({ length: 9 }, (_, i) => ({ journal_id: 100 + i, document_number: null })),
      { journal_id: 999, document_number: "OTHER" },
    ];
    expect(findMatchingJournal(candidates, "NEW")).toBeUndefined();
  });

  it("returns the first candidate when no reference is provided (loose match)", () => {
    const candidates = [
      { journal_id: 100, document_number: "WISE-A" },
      { journal_id: 200, document_number: "WISE-B" },
    ];
    expect(findMatchingJournal(candidates)).toBe(100);
    expect(findMatchingJournal(candidates, "")).toBe(100);
  });

  it("treats ISO 20022 garbage-ref sentinels as ref-less (candidate side)", () => {
    // LHV sometimes stamps 'NOTPROVIDED' when the originator omitted a reference.
    // That candidate must not block dedup against a real-ref Wise import.
    const candidates = [
      { journal_id: 100, document_number: "NOTPROVIDED" },
    ];
    // From the caller's side the ref is real, candidate pool has only garbage → legacy-migration fallback applies
    expect(findMatchingJournal(candidates, "WISE-REAL")).toBe(100);
    // Mixed with a real-ref candidate → the real-ref mismatch still rejects
    expect(findMatchingJournal(
      [...candidates, { journal_id: 200, document_number: "WISE-OTHER" }],
      "WISE-REAL",
    )).toBeUndefined();
  });

  it("treats ISO 20022 garbage-ref sentinels as ref-less (caller side)", () => {
    const candidates = [
      { journal_id: 100, document_number: "WISE-REAL" },
    ];
    // Input ref is a sentinel → treated as missing → loose match
    expect(findMatchingJournal(candidates, "NOTPROVIDED")).toBe(100);
    expect(findMatchingJournal(candidates, "NONE")).toBe(100);
    expect(findMatchingJournal(candidates, "N/A")).toBe(100);
    expect(findMatchingJournal(candidates, "-")).toBe(100);
    expect(findMatchingJournal(candidates, "   ")).toBe(100);
  });
});
