import { describe, it, expect, vi } from "vitest";
import type { AccountDimension, BankAccount, Journal } from "./types/api.js";
import {
  DUPLICATE_SCAN_WINDOW_DAYS,
  DUPLICATE_AMOUNT_TOLERANCE,
  resolveBankDimensions,
  findDuplicatePostingsInJournals,
  findDuplicateBankPostings,
  formatDuplicatePostingWarnings,
  type DuplicatePostingCandidate,
  type DuplicatePostingScanResult,
} from "./bank-posting-duplicate-guard.js";

// ---------------------------------------------------------------------------
// Helpers — mirror the fixture style used in src/account-postings.test.ts
// ---------------------------------------------------------------------------

function journal(overrides: Partial<Journal> & { postings?: Journal["postings"] }): Journal {
  return {
    id: 1,
    effective_date: "2024-06-15",
    registered: true,
    is_deleted: false,
    postings: [],
    ...overrides,
  };
}

function posting(accountId: number, type: "D" | "C", amount: number, dimensionId: number | null = null) {
  return {
    accounts_id: accountId,
    type,
    amount,
    accounts_dimensions_id: dimensionId,
    is_deleted: false,
  };
}

const BANK_ACCOUNT_ID = 1020;
const BANK_DIMENSION_ID = 5001;

const baseCandidate: DuplicatePostingCandidate = {
  accountId: BANK_ACCOUNT_ID,
  dimensionId: BANK_DIMENSION_ID,
  amount: 100,
  direction: "C",
  date: "2024-06-15",
};

describe("findDuplicatePostingsInJournals", () => {
  it("finds an exact match", () => {
    const journals = [
      journal({
        id: 10,
        title: "Payment",
        document_number: "DOC-1",
        operation_type: "bank",
        effective_date: "2024-06-15",
        postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)],
      }),
    ];
    const suspects = findDuplicatePostingsInJournals(journals, baseCandidate);
    expect(suspects).toHaveLength(1);
    expect(suspects[0]).toMatchObject({
      journal_id: 10,
      journal_title: "Payment",
      document_number: "DOC-1",
      operation_type: "bank",
      date: "2024-06-15",
      amount: 100,
      type: "C",
      dimension_id: BANK_DIMENSION_ID,
      day_distance: 0,
    });
  });

  it("matches within amount tolerance (0.005) but not beyond it (0.05)", () => {
    const journals = [
      journal({ id: 1, postings: [posting(BANK_ACCOUNT_ID, "C", 100.005, BANK_DIMENSION_ID)] }),
      journal({ id: 2, postings: [posting(BANK_ACCOUNT_ID, "C", 100.05, BANK_DIMENSION_ID)] }),
    ];
    const suspects = findDuplicatePostingsInJournals(journals, baseCandidate);
    expect(suspects.map(s => s.journal_id)).toEqual([1]);
  });

  it("does not match on direction mismatch", () => {
    const journals = [
      journal({ id: 1, postings: [posting(BANK_ACCOUNT_ID, "D", 100, BANK_DIMENSION_ID)] }),
    ];
    expect(findDuplicatePostingsInJournals(journals, baseCandidate)).toHaveLength(0);
  });

  it("matches at exactly the +/-7 day window boundary but not at +/-8 days", () => {
    const journals = [
      journal({ id: 1, effective_date: "2024-06-08", postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)] }), // -7
      journal({ id: 2, effective_date: "2024-06-22", postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)] }), // +7
      journal({ id: 3, effective_date: "2024-06-07", postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)] }), // -8
      journal({ id: 4, effective_date: "2024-06-23", postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)] }), // +8
    ];
    const suspects = findDuplicatePostingsInJournals(journals, baseCandidate);
    expect(suspects.map(s => s.journal_id).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("dimensionId null matches any dimension; a set dimensionId filters to that dimension only", () => {
    const journals = [
      journal({ id: 1, postings: [posting(BANK_ACCOUNT_ID, "C", 100, 9999)] }),
      journal({ id: 2, postings: [posting(BANK_ACCOUNT_ID, "C", 100, null)] }),
    ];
    const anyDimensionCandidate: DuplicatePostingCandidate = { ...baseCandidate, dimensionId: null };
    expect(
      findDuplicatePostingsInJournals(journals, anyDimensionCandidate).map(s => s.journal_id).sort((a, b) => a - b),
    ).toEqual([1, 2]);
    // baseCandidate has dimensionId = BANK_DIMENSION_ID (5001); neither row uses it.
    expect(findDuplicatePostingsInJournals(journals, baseCandidate)).toHaveLength(0);
  });

  it("respects excludeJournalIds", () => {
    const journals = [
      journal({ id: 10, postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)] }),
    ];
    const candidate: DuplicatePostingCandidate = { ...baseCandidate, excludeJournalIds: new Set([10]) };
    expect(findDuplicatePostingsInJournals(journals, candidate)).toHaveLength(0);
  });

  it("finds the incident shape: one registered manual journal with a bank-dimension C posting plus an expense D posting", () => {
    const journals = [
      journal({
        id: 77,
        title: "Manual booking",
        registered: true,
        postings: [
          posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID),
          posting(5100, "D", 100, null), // expense account leg — not the bank account
        ],
      }),
    ];
    const suspects = findDuplicatePostingsInJournals(journals, baseCandidate);
    expect(suspects).toHaveLength(1);
    expect(suspects[0]!.journal_id).toBe(77);
  });
});

describe("findDuplicateBankPostings", () => {
  it("degrades gracefully (does not throw) when listAllWithPostings rejects, e.g. past the 200-page cap", async () => {
    const api = {
      journals: {
        listAllWithPostings: vi.fn().mockRejectedValue(new Error("Data exceeds 200 pages of results")),
      },
    };
    const result = await findDuplicateBankPostings(api, baseCandidate);
    expect(result.scan_available).toBe(false);
    expect(result.suspects).toEqual([]);
    expect(result.window_days).toBe(DUPLICATE_SCAN_WINDOW_DAYS);
    expect(result.scan_note).toContain("Duplicate scan unavailable");
    expect(result.scan_note).toContain("Data exceeds 200 pages of results");
  });

  it("uses preloadedJournals and bypasses the api call entirely", async () => {
    const journals = [
      journal({ id: 10, postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)] }),
    ];
    const listAllWithPostings = vi.fn();
    const api = { journals: { listAllWithPostings } };
    const result = await findDuplicateBankPostings(api, baseCandidate, { preloadedJournals: journals });
    expect(listAllWithPostings).not.toHaveBeenCalled();
    expect(result.scan_available).toBe(true);
    expect(result.suspects).toHaveLength(1);
  });

  it("returns scan_available true with suspects on a successful api call", async () => {
    const journals = [
      journal({ id: 10, postings: [posting(BANK_ACCOUNT_ID, "C", 100, BANK_DIMENSION_ID)] }),
    ];
    const api = { journals: { listAllWithPostings: vi.fn().mockResolvedValue(journals) } };
    const result = await findDuplicateBankPostings(api, baseCandidate);
    expect(result.scan_available).toBe(true);
    expect(result.suspects).toHaveLength(1);
    expect(result.window_days).toBe(DUPLICATE_SCAN_WINDOW_DAYS);
  });
});

describe("resolveBankDimensions", () => {
  it("joins bank accounts to their account dimensions, filtering is_deleted dimensions and deduping by dimension id", async () => {
    const bankAccounts: BankAccount[] = [
      { account_name_est: "LHV", account_no: "1", accounts_dimensions_id: 5001 } as BankAccount,
      { account_name_est: "Wise", account_no: "2", accounts_dimensions_id: 5002 } as BankAccount,
      { account_name_est: "NoDim", account_no: "3" } as BankAccount, // no accounts_dimensions_id
      { account_name_est: "Dup", account_no: "4", accounts_dimensions_id: 5001 } as BankAccount, // duplicate dimension
    ];
    const accountDimensions: AccountDimension[] = [
      { id: 5001, accounts_id: 1020, title_est: "LHV EUR" },
      { id: 5002, accounts_id: 1020, title_est: "Wise EUR", is_deleted: true },
      { id: 5003, accounts_id: 1020, title_est: "Unrelated" },
    ];
    const api = {
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue(bankAccounts),
        getAccountDimensions: vi.fn().mockResolvedValue(accountDimensions),
      },
    };
    const result = await resolveBankDimensions(api);
    expect(result).toEqual([{ dimensionId: 5001, accountId: 1020, title: "LHV EUR" }]);
  });
});

describe("formatDuplicatePostingWarnings", () => {
  const wrapTitle = (t: string) => `[${t}]`;

  it("formats one line per suspect with POSSIBLE duplicate wording and journal id/title/date/amount", () => {
    const result: DuplicatePostingScanResult = {
      scan_available: true,
      window_days: 7,
      suspects: [
        {
          journal_id: 10,
          journal_title: "Payment",
          document_number: "DOC-1",
          operation_type: "bank",
          date: "2024-06-15",
          amount: 100,
          type: "C",
          dimension_id: BANK_DIMENSION_ID,
          day_distance: 0,
        },
      ],
    };
    const lines = formatDuplicatePostingWarnings(result, baseCandidate, wrapTitle);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("POSSIBLE duplicate");
    expect(lines[0]).toContain("100");
    expect(lines[0]).toContain("outflow");
    expect(lines[0]).toContain("journal 10");
    expect(lines[0]).toContain("[Payment]");
    expect(lines[0]).toContain("2024-06-15");
    expect(lines[0]).toContain("doc DOC-1");
  });

  it("uses 'inflow' wording for D-direction candidates and omits the doc fragment when document_number is null", () => {
    const result: DuplicatePostingScanResult = {
      scan_available: true,
      window_days: 7,
      suspects: [
        {
          journal_id: 5,
          journal_title: "Receipt",
          document_number: null,
          operation_type: null,
          date: "2024-06-15",
          amount: 50,
          type: "D",
          dimension_id: null,
          day_distance: 0,
        },
      ],
    };
    const lines = formatDuplicatePostingWarnings(result, { ...baseCandidate, direction: "D", amount: 50 }, wrapTitle);
    expect(lines[0]).toContain("inflow");
    expect(lines[0]).not.toContain("doc ");
  });

  it("adds a note line carrying scan_note when scan_available is false", () => {
    const result: DuplicatePostingScanResult = {
      scan_available: false,
      scan_note: "Duplicate scan unavailable: boom — cross-mechanism duplicate coverage is incomplete for this call.",
      window_days: 7,
      suspects: [],
    };
    const lines = formatDuplicatePostingWarnings(result, baseCandidate, wrapTitle);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Duplicate scan unavailable");
  });

  it("returns no lines when scan_available is true and there are no suspects", () => {
    const result: DuplicatePostingScanResult = { scan_available: true, window_days: 7, suspects: [] };
    expect(formatDuplicatePostingWarnings(result, baseCandidate, wrapTitle)).toHaveLength(0);
  });
});
