import { describe, it, expect } from "vitest";
import type { Journal } from "./types/api.js";
import { listAccountDimensionPostings } from "./account-postings.js";

// ---------------------------------------------------------------------------
// Helpers — mirror the fixture style used in src/tools/account-balance.test.ts
// ---------------------------------------------------------------------------

function journal(overrides: Partial<Journal> & { postings?: Journal["postings"] }): Journal {
  return {
    id: 1,
    effective_date: "2024-01-15",
    registered: true,
    is_deleted: false,
    postings: [],
    ...overrides,
  };
}

function posting(accountId: number, type: "D" | "C", amount: number, baseAmount?: number) {
  return {
    accounts_id: accountId,
    type,
    amount,
    ...(baseAmount !== undefined && { base_amount: baseAmount }),
    is_deleted: false,
  };
}

const ACCOUNT_ID = 1020;

describe("listAccountDimensionPostings", () => {
  it("includes postings from registered, non-deleted journals", () => {
    const journals = [
      journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 500)] }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(500);
    expect(rows[0]!.type).toBe("D");
  });

  it("skips unregistered journals", () => {
    const journals = [
      journal({ id: 1, registered: false, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 2, registered: true, postings: [posting(ACCOUNT_ID, "D", 100)] }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(100);
  });

  it("skips deleted journals", () => {
    const journals = [
      journal({ id: 1, is_deleted: true, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 2, postings: [posting(ACCOUNT_ID, "D", 100)] }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(100);
  });

  it("skips deleted postings", () => {
    const journals = [
      journal({
        id: 1,
        postings: [
          { ...posting(ACCOUNT_ID, "D", 500), is_deleted: true },
          posting(ACCOUNT_ID, "D", 100),
        ],
      }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(100);
  });

  it("skips postings for a different account", () => {
    const journals = [
      journal({
        id: 1,
        postings: [
          posting(ACCOUNT_ID, "D", 300),
          posting(9999, "D", 1000),
        ],
      }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(300);
  });

  it("skips postings without a D/C type", () => {
    const journals = [
      journal({
        id: 1,
        postings: [
          { ...posting(ACCOUNT_ID, "D", 300), type: undefined },
          posting(ACCOUNT_ID, "D", 100),
        ],
      }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(100);
  });

  it("skips journals with missing postings array", () => {
    const journals = [
      { id: 1, effective_date: "2024-01-15", registered: true, is_deleted: false } as unknown as Journal,
      journal({ id: 2, postings: [posting(ACCOUNT_ID, "D", 100)] }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(100);
  });

  it("filters by dateFrom and dateTo inclusively on both ends", () => {
    const journals = [
      journal({ id: 1, effective_date: "2024-01-01", postings: [posting(ACCOUNT_ID, "D", 100)] }),
      journal({ id: 2, effective_date: "2024-06-15", postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 3, effective_date: "2024-12-31", postings: [posting(ACCOUNT_ID, "D", 900)] }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID, {
      dateFrom: "2024-01-01",
      dateTo: "2024-06-15",
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.amount)).toEqual([100, 500]);
  });

  it("prefers base_amount over amount for multi-currency postings", () => {
    const journals = [
      journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 1000, 920)] }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows[0]!.amount).toBe(920);
  });

  it("passes a null dimension through unchanged", () => {
    const journals = [
      journal({
        id: 1,
        postings: [{ ...posting(ACCOUNT_ID, "D", 300), accounts_dimensions_id: null }],
      }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows[0]!.accounts_dimensions_id).toBeNull();
  });

  it("passes through a defined dimension id", () => {
    const journals = [
      journal({
        id: 1,
        postings: [{ ...posting(ACCOUNT_ID, "D", 300), accounts_dimensions_id: 12345 }],
      }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows[0]!.accounts_dimensions_id).toBe(12345);
  });

  it("defaults journal_title, document_number, operation_type, clients_id when absent", () => {
    const journals = [
      journal({ id: 1, title: undefined, document_number: undefined, operation_type: undefined, clients_id: undefined, postings: [posting(ACCOUNT_ID, "D", 100)] }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows[0]!.journal_title).toBe("");
    expect(rows[0]!.document_number).toBeNull();
    expect(rows[0]!.operation_type).toBeNull();
    expect(rows[0]!.clients_id).toBeNull();
  });

  it("carries through journal_title, document_number, operation_type, clients_id, date, journal_id when present", () => {
    const journals = [
      journal({
        id: 7,
        title: "Some journal",
        document_number: "DOC-1",
        operation_type: "bank",
        clients_id: 42,
        effective_date: "2024-05-05",
        postings: [posting(ACCOUNT_ID, "C", 250)],
      }),
    ];
    const rows = listAccountDimensionPostings(journals, ACCOUNT_ID);
    expect(rows[0]).toMatchObject({
      journal_id: 7,
      journal_title: "Some journal",
      document_number: "DOC-1",
      operation_type: "bank",
      clients_id: 42,
      date: "2024-05-05",
      type: "C",
      amount: 250,
    });
  });
});
