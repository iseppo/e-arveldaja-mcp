import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkStatementClosingBalance,
  STATEMENT_BALANCE_TOLERANCE_EUR,
} from "./statement-balance-check.js";
import { resetOpeningBalanceCache, writeOpeningBalances } from "./opening-balance-store.js";
import { createAccountingWorkflowApi, fixtureTransaction } from "./__fixtures__/accounting-workflow.js";
import type { Journal } from "./types/api.js";

const ACCOUNT_ID = 1020;
const DIMENSION_ID = 101;
const BALANCE_DATE = "2026-02-28";

function confirmedJournal(type: "D" | "C", amount: number, overrides: Partial<Journal> = {}): Journal {
  return {
    id: 500,
    clients_id: null,
    title: "Bank posting",
    effective_date: "2026-02-15",
    registered: true,
    is_deleted: false,
    postings: [
      { accounts_id: ACCOUNT_ID, accounts_dimensions_id: DIMENSION_ID, type, amount, base_amount: amount, is_deleted: false },
    ],
    ...overrides,
  };
}

// Isolate the opening-balance store to an empty bundle dir so this suite never
// picks up a real opening-balances.json from the developer's config dir.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-check-"));
  process.env.EARVELDAJA_RULES_DIR = dir;
  resetOpeningBalanceCache();
});
afterEach(() => { delete process.env.EARVELDAJA_RULES_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("checkStatementClosingBalance", () => {
  it("exports the locked 0.10 EUR tolerance", () => {
    expect(STATEMENT_BALANCE_TOLERANCE_EUR).toBe(0.10);
  });

  it("reports within-tolerance (0.03 EUR drift) with no warning flag", async () => {
    const api = createAccountingWorkflowApi({
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("D", 170.00)]) },
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      closing: { amount: 170.03, direction: "CRDT", date: BALANCE_DATE, currency: "EUR" },
      fallbackDate: BALANCE_DATE,
    });
    expect(result.booked_balance).toBe(170.00);
    expect(result.unconfirmed_amount).toBe(0);
    expect(result.expected_balance).toBe(170.00);
    expect(result.statement_closing_balance).toBe(170.03);
    expect(result.difference).toBe(-0.03);
    expect(result.within_tolerance).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("flags out-of-tolerance with a warning naming the statement figure, expected balance, and difference", async () => {
    const api = createAccountingWorkflowApi({
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("D", 170.00)]) },
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      closing: { amount: 175.00, direction: "CRDT", date: BALANCE_DATE, currency: "EUR" },
      fallbackDate: BALANCE_DATE,
    });
    expect(result.within_tolerance).toBe(false);
    expect(result.difference).toBe(-5.00);
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0]!;
    expect(warning).toContain("175.00");   // statement figure
    expect(warning).toContain("170.00");   // expected balance
    expect(warning).toContain("-5.00");    // difference
  });

  it("closes the gap with unconfirmed PROJECT rows in the dimension", async () => {
    const api = createAccountingWorkflowApi({
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("D", 100.00)]) },
      transactionRows: [
        // incoming (type D) PROJECT row, in-dimension, on or before the balance date
        fixtureTransaction({ id: 1, amount: 50.00, date: "2026-02-20", type: "D", accounts_dimensions_id: DIMENSION_ID }),
        // out-of-dimension row must be ignored
        fixtureTransaction({ id: 2, amount: 999.00, date: "2026-02-20", type: "D", accounts_dimensions_id: 999 }),
        // after the balance date must be ignored
        fixtureTransaction({ id: 3, amount: 999.00, date: "2026-03-05", type: "D", accounts_dimensions_id: DIMENSION_ID }),
      ],
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      closing: { amount: 150.00, direction: "CRDT", date: BALANCE_DATE, currency: "EUR" },
      fallbackDate: BALANCE_DATE,
    });
    expect(result.booked_balance).toBe(100.00);
    expect(result.unconfirmed_amount).toBe(50.00);
    expect(result.expected_balance).toBe(150.00);
    expect(result.within_tolerance).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("notes in-scope unconfirmed rows excluded for an indeterminate direction and omits them from unconfirmed_amount", async () => {
    const api = createAccountingWorkflowApi({
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("D", 100.00)]) },
      transactionRows: [
        // Direction unknown: no type and no source-direction marker; in-dimension,
        // dated on or before the balance date. It skews the expected balance
        // silently unless surfaced.
        fixtureTransaction({ id: 1, amount: 50.00, date: "2026-02-20", type: null, description: "", accounts_dimensions_id: DIMENSION_ID }),
      ],
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      closing: { amount: 100.00, direction: "CRDT", date: BALANCE_DATE, currency: "EUR" },
      fallbackDate: BALANCE_DATE,
    });
    // The indeterminate row is not summed into the unconfirmed total...
    expect(result.unconfirmed_amount).toBe(0);
    // ...and its exclusion is surfaced as a note (no guessed sign).
    expect(result.notes.some(note => /indeterminate direction/.test(note) && /excluded/.test(note))).toBe(true);
  });

  it("treats a DBIT closing balance as a negative balance", async () => {
    const api = createAccountingWorkflowApi({
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("C", 40.00)]) },
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      closing: { amount: 40.00, direction: "DBIT", date: BALANCE_DATE, currency: "EUR" },
      fallbackDate: BALANCE_DATE,
    });
    expect(result.statement_closing_balance).toBe(-40.00);
    expect(result.booked_balance).toBe(-40.00);
    expect(result.expected_balance).toBe(-40.00);
    expect(result.difference).toBe(0);
    expect(result.within_tolerance).toBe(true);
  });

  it("skips FX reconciliation for a non-EUR closing balance instead of a false-positive warning", async () => {
    const api = createAccountingWorkflowApi({
      // booked_balance is in EUR base; a USD statement figure would trip the
      // tolerance if naively compared.
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("D", 170.00)]) },
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      closing: { amount: 200.00, direction: "CRDT", date: BALANCE_DATE, currency: "USD" },
      fallbackDate: BALANCE_DATE,
    });
    // Figures are still returned...
    expect(result.booked_balance).toBe(170.00);
    expect(result.statement_closing_balance).toBe(200.00);
    // ...but no false-positive warning is raised for the currency mismatch.
    expect(result.warnings).toEqual([]);
    expect(result.within_tolerance).toBe(true);
    expect(result.notes.some(note => /USD/.test(note) && /EUR/.test(note))).toBe(true);
  });

  it("suppresses the mismatch warning when this account's opening balance has an unresolved dimension", async () => {
    // Opening balance for account 1020 whose dimension label matches none of the
    // account's two dimensions → the fold posts it under a null dimension, so the
    // per-dimension booked balance omits it. Comparing that partial booked side
    // to a statement that DOES include the opening amount would trip the
    // tolerance — a spurious warning the tripwire must suppress.
    writeOpeningBalances({
      openingDate: "2025-12-31",
      accounts: [{ code: String(ACCOUNT_ID), name: "Pank", debit: 500, credit: 0, dimension: ["Nonexistent label"] }],
      totals: { debit: 500, credit: 0 },
      rawText: "",
    }, "2026-07-20T00:00:00Z");
    const api = createAccountingWorkflowApi({
      accounts: [{ id: ACCOUNT_ID, balance_type: "D", name_est: "Pank" }],
      accountDimensions: [
        { id: DIMENSION_ID, accounts_id: ACCOUNT_ID, title_est: "LHV", is_deleted: false },
        { id: 102, accounts_id: ACCOUNT_ID, title_est: "Wise", is_deleted: false },
      ],
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("D", 170.00)]) },
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      // Booked side sees only the 170 dimension posting (opening 500 is under
      // null), so it would mismatch by exactly the 500 opening amount.
      closing: { amount: 670.00, direction: "CRDT", date: BALANCE_DATE, currency: "EUR" },
      fallbackDate: BALANCE_DATE,
    });
    expect(result.booked_balance).toBe(170.00);
    expect(result.difference).toBe(-500.00);      // figures still reported
    expect(result.within_tolerance).toBe(true);   // but tolerance mismatch is suppressed
    expect(result.warnings).toEqual([]);
    expect(result.notes.some(n => /opening balance/i.test(n) && /dimension/i.test(n))).toBe(true);
  });

  it("falls back to the statement period date when the balance node has no date", async () => {
    const api = createAccountingWorkflowApi({
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([confirmedJournal("D", 170.00)]) },
    });
    const result = await checkStatementClosingBalance(api, {
      dimensionId: DIMENSION_ID,
      accountId: ACCOUNT_ID,
      closing: { amount: 170.00, direction: "CRDT", currency: "EUR" },
      fallbackDate: BALANCE_DATE,
    });
    expect(result.balance_date).toBe(BALANCE_DATE);
  });
});
