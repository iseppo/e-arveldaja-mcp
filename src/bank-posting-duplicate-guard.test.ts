import { describe, it, expect, vi } from "vitest";
import type { AccountDimension, BankAccount, Journal, Transaction } from "./types/api.js";
import {
  DUPLICATE_SCAN_WINDOW_DAYS,
  DUPLICATE_AMOUNT_TOLERANCE,
  resolveBankDimensions,
  findDuplicatePostingsInJournals,
  findDuplicateBankPostings,
  formatDuplicatePostingWarnings,
  checkIntakeCashDuplicates,
  annotateDistinctSourceReferences,
  journalSourceReferenceIdentity,
  renderDuplicatePostingSuspects,
  transactionSourceReferenceIdentity,
  type DuplicatePostingCandidate,
  type DuplicatePostingScanResult,
} from "./bank-posting-duplicate-guard.js";
import { buildCamtDescriptionWithMetadata } from "./camt/duplicate-identity.js";

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

describe("checkIntakeCashDuplicates", () => {
  const bankAccounts: BankAccount[] = [
    { account_name_est: "LHV", account_no: "1", accounts_dimensions_id: 5001 } as BankAccount,
    { account_name_est: "Wise", account_no: "2", accounts_dimensions_id: 5002 } as BankAccount,
  ];
  const accountDimensions: AccountDimension[] = [
    { id: 5001, accounts_id: 1020, title_est: "LHV EUR" },
    { id: 5002, accounts_id: 1030, title_est: "Wise EUR" },
  ];

  function makeApi(overrides: {
    listAllWithPostings?: ReturnType<typeof vi.fn>;
    getBankAccounts?: ReturnType<typeof vi.fn>;
    getAccountDimensions?: ReturnType<typeof vi.fn>;
  } = {}) {
    return {
      journals: {
        listAllWithPostings: overrides.listAllWithPostings ?? vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getBankAccounts: overrides.getBankAccounts ?? vi.fn().mockResolvedValue(bankAccounts),
        getAccountDimensions: overrides.getAccountDimensions ?? vi.fn().mockResolvedValue(accountDimensions),
      },
    } as unknown as Parameters<typeof checkIntakeCashDuplicates>[0];
  }

  it("matches a candidate against a manual journal's C posting on ANY bank dimension (dimensionId: null, merged across accounts)", async () => {
    const journals = [
      // Bank dimension 5002 (Wise), account 1030 — not the first-listed account.
      journal({
        id: 42,
        title: "Manual Wise payment",
        effective_date: "2026-03-20",
        postings: [
          posting(1030, "C", 250, 5002),
          posting(5100, "D", 250, null),
        ],
      }),
    ];
    const api = makeApi({ listAllWithPostings: vi.fn().mockResolvedValue(journals) });

    const result = await checkIntakeCashDuplicates(api, {
      grossAmountEur: 250,
      invoiceDate: "2026-03-20",
    });

    expect(result.scan_available).toBe(true);
    expect(result.skipped_no_eur_amount).toBeUndefined();
    expect(result.suspects).toHaveLength(1);
    expect(result.suspects[0]).toMatchObject({ journal_id: 42, journal_title: "Manual Wise payment" });
  });

  it("does not merge-duplicate a suspect that matches under more than one bank account's scan", async () => {
    const journals = [
      journal({
        id: 7,
        effective_date: "2026-03-20",
        postings: [posting(1020, "C", 90, 5001)],
      }),
    ];
    const listAllWithPostings = vi.fn().mockResolvedValue(journals);
    const api = makeApi({ listAllWithPostings });

    const result = await checkIntakeCashDuplicates(api, { grossAmountEur: 90, invoiceDate: "2026-03-20" });

    expect(result.suspects).toHaveLength(1);
    // Journals were loaded once, not once per bank account.
    expect(listAllWithPostings).toHaveBeenCalledTimes(1);
  });

  it("skips a transfer between own bank accounts (no expense leg), but not a payment that also touches a bank", async () => {
    const journals = [
      journal({ id: 8, effective_date: "2026-10-04", postings: [posting(1020, "D", 25, 5001), posting(1030, "C", 25, 5002)] }),
      journal({ id: 9, effective_date: "2026-10-04", postings: [posting(1020, "C", 25, 5001), posting(1030, "D", 20, 5002), posting(5100, "D", 5, null)] }),
    ];
    const api = makeApi({ listAllWithPostings: vi.fn().mockResolvedValue(journals) });

    const result = await checkIntakeCashDuplicates(api, { grossAmountEur: 25, invoiceDate: "2026-09-28" });

    expect(result.suspects.map(suspect => suspect.journal_id)).toEqual([9]);
  });

  it("returns skipped_no_eur_amount: true (never scan_available: false) when grossAmountEur is undefined — never guesses a rate", async () => {
    const listAllWithPostings = vi.fn();
    const api = makeApi({ listAllWithPostings });

    const result = await checkIntakeCashDuplicates(api, { grossAmountEur: undefined, invoiceDate: "2026-03-20" });

    expect(result).toMatchObject({
      scan_available: true,
      window_days: DUPLICATE_SCAN_WINDOW_DAYS,
      suspects: [],
      skipped_no_eur_amount: true,
    });
    expect(result.scan_note).toContain("no EUR-equivalent gross amount");
    expect(listAllWithPostings).not.toHaveBeenCalled();
  });

  it("degrades gracefully to scan_available: false when resolveBankDimensions itself throws (e.g. a partial api mock)", async () => {
    const api = {
      journals: { listAllWithPostings: vi.fn() },
      // readonly missing entirely — resolveBankDimensions() throws synchronously.
    } as any;

    const result = await checkIntakeCashDuplicates(api, { grossAmountEur: 100, invoiceDate: "2026-03-20" });

    expect(result.scan_available).toBe(false);
    expect(result.suspects).toEqual([]);
    expect(result.scan_note).toContain("Duplicate scan unavailable");
  });

  it("degrades gracefully to scan_available: false when listAllWithPostings rejects (page-cap)", async () => {
    const api = makeApi({ listAllWithPostings: vi.fn().mockRejectedValue(new Error("Data exceeds 200 pages of results")) });

    const result = await checkIntakeCashDuplicates(api, { grossAmountEur: 100, invoiceDate: "2026-03-20" });

    expect(result.scan_available).toBe(false);
    expect(result.suspects).toEqual([]);
    expect(result.scan_note).toContain("Data exceeds 200 pages of results");
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
    expect(lines[0]).toContain("doc [DOC-1]");
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

// ---------------------------------------------------------------------------
// Distinct source reference annotation (annotation, never filtering)
// ---------------------------------------------------------------------------

describe("annotateDistinctSourceReferences", () => {
  const WISE_DIM = BANK_DIMENSION_ID;
  const OTHER_DIM = 5002;

  /** A registration journal of transaction `txId` posting the candidate's bank leg. */
  function registration(id: number, txId: number | undefined, overrides: Partial<Journal> = {}): Journal {
    return journal({
      id,
      title: "Registration",
      operation_type: "TRANSACTION",
      ...(txId !== undefined ? { operations_id: txId } : {}),
      postings: [posting(BANK_ACCOUNT_ID, "C", 100, WISE_DIM)],
      ...overrides,
    });
  }

  function bankTx(id: number, overrides: Partial<Transaction> = {}): Transaction {
    return {
      id, accounts_dimensions_id: WISE_DIM, type: "C", amount: 100, date: "2024-06-15",
      cl_currencies_id: "EUR", status: "CONFIRMED", is_deleted: false,
      ...overrides,
    } as Transaction;
  }

  function scanOf(journals: Journal[]): DuplicatePostingScanResult {
    return { scan_available: true, window_days: DUPLICATE_SCAN_WINDOW_DAYS, suspects: findDuplicatePostingsInJournals(journals, baseCandidate) };
  }

  const wiseCandidate = (tag: string) => () => transactionSourceReferenceIdentity(bankTx(999, { description: `${tag} Payment` }));

  it("carries operations_id internally but never renders it", () => {
    const scan = scanOf([registration(10, 77)]);
    expect(scan.suspects[0]!.operations_id).toBe(77);
    const rendered = renderDuplicatePostingSuspects(scan.suspects)[0]!;
    expect(rendered).not.toHaveProperty("operations_id");
    expect(rendered.journal_id).toBe(10);
  });

  it("marks a suspect whose Wise transaction carries a different WISE: id on the same leg; journal ids unchanged", async () => {
    const scan = scanOf([registration(10, 77)]);
    const transactions = [bankTx(77, { description: "WISE:TRANSFER-1 Payment" })];
    const annotated = await annotateDistinctSourceReferences(scan, wiseCandidate("WISE:TRANSFER-2"), async () => transactions);
    expect(annotated.scan_available).toBe(true);
    expect(annotated.suspects.map(s => s.journal_id)).toEqual(scan.suspects.map(s => s.journal_id));
    expect(annotated.suspects[0]!.distinct_source_reference).toBe(true);
    expect(renderDuplicatePostingSuspects(annotated.suspects)[0]!.distinct_source_reference).toBe(true);
  });

  it("keeps the same WISE: id (also with a split-leg currency suffix) a plain suspect", async () => {
    const scan = scanOf([registration(10, 77), registration(11, 78)]);
    const transactions = [
      bankTx(77, { description: "WISE:TRANSFER-1 Payment" }),
      bankTx(78, { description: "WISE:TRANSFER-1:USD Payment" }),
    ];
    const annotated = await annotateDistinctSourceReferences(scan, wiseCandidate("WISE:TRANSFER-1"), async () => transactions);
    expect(annotated.suspects).toHaveLength(2);
    expect(annotated.suspects.every(s => s.distinct_source_reference === undefined)).toBe(true);
  });

  it("does not compare a main leg with a fee leg", async () => {
    const scan = scanOf([registration(10, 77)]);
    const transactions = [bankTx(77, { description: "WISE:FEE:TRANSFER-1 Wise teenustasu" })];
    const annotated = await annotateDistinctSourceReferences(scan, wiseCandidate("WISE:TRANSFER-2"), async () => transactions);
    expect(annotated.suspects[0]!.distinct_source_reference).toBeUndefined();
  });

  it("uses a non-transaction journal's WISE: document number", async () => {
    const scan = scanOf([journal({ id: 10, document_number: "WISE:TRANSFER-1", postings: [posting(BANK_ACCOUNT_ID, "C", 100, WISE_DIM)] })]);
    const annotated = await annotateDistinctSourceReferences(scan, () => journalSourceReferenceIdentity("WISE:TRANSFER-2", WISE_DIM), async () => []);
    expect(annotated.suspects[0]!.distinct_source_reference).toBe(true);
    const same = await annotateDistinctSourceReferences(scan, () => journalSourceReferenceIdentity("WISE:TRANSFER-1", WISE_DIM), async () => []);
    expect(same.suspects[0]!.distinct_source_reference).toBeUndefined();
  });

  it("does not read a TRANSACTION journal's own document number: without its transaction it stays plain", async () => {
    const scan = scanOf([registration(10, 77, { document_number: "WISE:TRANSFER-1" })]);
    const annotated = await annotateDistinctSourceReferences(scan, wiseCandidate("WISE:TRANSFER-2"), async () => []);
    expect(annotated.suspects[0]!.distinct_source_reference).toBeUndefined();
  });

  it("keeps a Wise reference against a CAMT reference a plain suspect (different namespaces)", async () => {
    const scan = scanOf([registration(10, 77)]);
    const transactions = [bankTx(77, { description: "Payment", bank_ref_number: "CAMT-REF-1" })];
    const annotated = await annotateDistinctSourceReferences(scan, wiseCandidate("WISE:TRANSFER-2"), async () => transactions);
    expect(annotated.suspects[0]!.distinct_source_reference).toBeUndefined();
  });

  it("treats the full and the hash form of one CAMT reference as the same identity", async () => {
    const longReference = "A".repeat(120);
    const hashed = buildCamtDescriptionWithMetadata("Payment", {
      date: "2024-06-15", amount: 100, currency: "EUR", direction: "DBIT", counterparty_name: "Payee",
      bank_reference: longReference, description: "Payment",
    } as Parameters<typeof buildCamtDescriptionWithMetadata>[1])!;
    expect(hashed).toContain("brh=sha256:");
    const candidateTx = bankTx(999, { description: hashed, bank_account_name: "Payee" });
    const scan = scanOf([registration(10, 77)]);
    const sameRef = await annotateDistinctSourceReferences(scan, () => transactionSourceReferenceIdentity(candidateTx),
      async () => [bankTx(77, { bank_ref_number: longReference })]);
    expect(sameRef.suspects[0]!.distinct_source_reference).toBeUndefined();
    const otherRef = await annotateDistinctSourceReferences(scan, () => transactionSourceReferenceIdentity(candidateTx),
      async () => [bankTx(77, { bank_ref_number: "B".repeat(120) })]);
    expect(otherRef.suspects[0]!.distinct_source_reference).toBe(true);
  });

  it("keeps a poisoned or unverified marker, a missing transaction and a missing operations_id plain", async () => {
    const candidate = () => transactionSourceReferenceIdentity(bankTx(999, { bank_ref_number: "REF-2" }));
    const poisoned = bankTx(77, { description: "Payment\n[e-arveldaja-mcp:camt br=REF-1 br=REF-3 dir=DBIT sig=abc]" });
    const unverified = bankTx(78, { description: "Payment\n[e-arveldaja-mcp:camt br=REF-1 dir=DBIT sig=0000000000000000]" });
    const scan = scanOf([registration(10, 77), registration(11, 78), registration(12, 79), registration(13, undefined)]);
    const annotated = await annotateDistinctSourceReferences(scan, candidate, async () => [poisoned, unverified]);
    expect(annotated.suspects.map(s => s.journal_id)).toEqual([10, 11, 12, 13]);
    expect(annotated.suspects.every(s => s.distinct_source_reference === undefined)).toBe(true);
  });

  it("never compares identities on different bank dimensions", async () => {
    const scan = scanOf([registration(10, 77)]);
    const transactions = [bankTx(77, { description: "WISE:TRANSFER-1 Payment", accounts_dimensions_id: OTHER_DIM })];
    const annotated = await annotateDistinctSourceReferences(scan, wiseCandidate("WISE:TRANSFER-2"), async () => transactions);
    expect(annotated.suspects[0]!.distinct_source_reference).toBeUndefined();
  });

  it("ignores clients: a different, third-party or reassigned client with the same reference stays a plain suspect", async () => {
    const scan = scanOf([registration(10, 77, { clients_id: 5 }), registration(11, 78, { clients_id: 6 })]);
    const transactions = [
      bankTx(77, { description: "WISE:TRANSFER-1 Payment", clients_id: 9 }),
      bankTx(78, { bank_ref_number: "REF-1", clients_id: 9 }),
    ];
    const wise = await annotateDistinctSourceReferences(scan, () => transactionSourceReferenceIdentity(
      bankTx(999, { description: "WISE:TRANSFER-1 Payment", clients_id: 1 })), async () => transactions);
    expect(wise.suspects.every(s => s.distinct_source_reference === undefined)).toBe(true);
    const camt = await annotateDistinctSourceReferences(scan, () => transactionSourceReferenceIdentity(
      bankTx(999, { bank_ref_number: "REF-1", clients_id: 2 })), async () => transactions);
    expect(camt.suspects.every(s => s.distinct_source_reference === undefined)).toBe(true);
  });

  it("returns the original scan unannotated when the transaction read rejects", async () => {
    const scan = scanOf([registration(10, 77)]);
    const annotated = await annotateDistinctSourceReferences(scan, wiseCandidate("WISE:TRANSFER-2"),
      () => Promise.reject(new Error("transactions unavailable")));
    expect(annotated).toEqual(scan);
    expect(annotated.suspects[0]!.distinct_source_reference).toBeUndefined();
  });

  it("does not read transactions for an unavailable scan or a candidate without identity", async () => {
    const load = vi.fn().mockResolvedValue([]);
    const unavailable: DuplicatePostingScanResult = { scan_available: false, scan_note: "x", window_days: 7, suspects: [] };
    expect(await annotateDistinctSourceReferences(unavailable, wiseCandidate("WISE:TRANSFER-2"), load)).toEqual(unavailable);
    const scan = scanOf([registration(10, 77)]);
    expect(await annotateDistinctSourceReferences(scan, () => undefined, load)).toEqual(scan);
    expect(load).not.toHaveBeenCalled();
  });

  it("renders a distinct suspect as an advisory line, not a POSSIBLE duplicate", () => {
    const [suspect] = findDuplicatePostingsInJournals([journal({ id: 10, title: "Wise", postings: [posting(BANK_ACCOUNT_ID, "C", 100, WISE_DIM)] })], baseCandidate);
    const lines = formatDuplicatePostingWarnings(
      { scan_available: true, window_days: 7, suspects: [{ ...suspect!, distinct_source_reference: true }] },
      baseCandidate,
      t => `[${t}]`,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Likely a different movement \(different source reference\)/);
    expect(lines[0]).not.toContain("POSSIBLE duplicate");
    expect(lines[0]).toContain("journal 10");
  });
});
