import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkStatementClosingBalance,
  STATEMENT_BALANCE_TOLERANCE_EUR,
} from "./statement-balance-check.js";
import { resetOpeningBalanceCache } from "./opening-balance-store.js";
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
