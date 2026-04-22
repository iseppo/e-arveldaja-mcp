import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Account, Journal, Posting } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { registerEstonianTaxTools } from "./estonian-tax.js";
import { roundMoney } from "../money.js";
import { parseMcpResponse } from "../mcp-json.js";
import { makeAccount, makePosting, makeJournal } from "../__fixtures__/accounting.js";

// Standard chart of accounts used across tests
function makeStandardAccounts(): Account[] {
  return [
    // Assets
    makeAccount(1000, "D", "Varad", "Pangakonto", "Bank account"),
    // Liabilities
    makeAccount(2370, "C", "Kohustused", "Dividendide võlgnevus", "Dividend payable"),
    makeAccount(2540, "C", "Kohustused", "Tulumaksu kohustus", "CIT payable"),
    makeAccount(2110, "C", "Kohustused", "Võlg omanikule", "Owner payable"),
    // Equity
    makeAccount(3000, "C", "Omakapital", "Osakapital", "Share capital"),
    makeAccount(3020, "C", "Omakapital", "Jaotamata kasum", "Retained earnings"),
    // Expenses
    makeAccount(5000, "D", "Kulud", "Kulud", "Expenses"),
    // VAT
    makeAccount(1510, "D", "Varad", "Sisendkäibemaks", "Input VAT"),
  ];
}

// ---------------------------------------------------------------------------
// McpServer mock — captures registered tool callbacks by name
// ---------------------------------------------------------------------------

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;

function makeMockServer() {
  const tools = new Map<string, ToolCallback>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, callback: ToolCallback) => {
      tools.set(name, callback);
    }),
  };
  return { server: server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, tools };
}

// Convenience: parse the JSON text from a tool result
function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return parseMcpResponse(r.content[0].text) as Record<string, unknown>;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

// ---------------------------------------------------------------------------
// ApiContext factory
// ---------------------------------------------------------------------------

function makeApi(
  journals: Journal[],
  accounts: Account[],
  options: {
    vatRegistered?: boolean;
    extraBalances?: Journal[];
    clientName?: string;
  } = {},
): ApiContext {
  const { vatRegistered = false, clientName = "Test Shareholder" } = options;

  return {
    readonly: {
      getAccounts: vi.fn(async () => accounts),
      getAccount: vi.fn(async (id: number) => {
        const acct = accounts.find(a => a.id === id);
        return acct ?? { id, name_est: "", name_eng: "", balance_type: "C" };
      }),
      getVatInfo: vi.fn(async () => ({ vat_number: vatRegistered ? "EE123456789" : null })),
    },
    clients: {
      get: vi.fn(async (_id: number) => ({ id: _id, name: clientName })),
      listAll: vi.fn(async () => []),
    },
    journals: {
      listAllWithPostings: vi.fn(async () => journals),
      create: vi.fn(async (data: unknown) => ({ code: 200, created_object_id: 42, messages: [], ...data })),
    },
    saleInvoices: { listAll: vi.fn(async () => []) },
    purchaseInvoices: { listAll: vi.fn(async () => []) },
  } as unknown as ApiContext;
}

// ---------------------------------------------------------------------------
// Tests: prepare_dividend_package
// ---------------------------------------------------------------------------

describe("prepare_dividend_package", () => {
  let tools: Map<string, ToolCallback>;
  let api: ApiContext;

  // Journals that give retained-earnings account 3020 a credit balance of 20 000 EUR
  // and assets of 25 000 EUR with no liabilities, share capital 2 500 EUR.
  function makeHealthyJournals(): Journal[] {
    return [
      // Retained earnings credit
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 20000),
        makePosting(3020, "C", 20000),
      ]),
      // Share capital
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(3000, "C", 2500),
      ]),
      // Additional assets (brings total assets to 22 500; no liabilities)
    ];
  }

  beforeEach(() => {
    const mock = makeMockServer();
    tools = mock.tools;
    api = makeApi(makeHealthyJournals(), makeStandardAccounts());
    registerEstonianTaxTools(mock.server, api);
  });

  // -------------------------------------------------------------------------
  // CIT calculation: 22/78 rate
  // -------------------------------------------------------------------------

  it("calculates CIT at 22/78 of net dividend for round amount (10 000 EUR)", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const calc = data.calculation as { net_dividend: number; cit_rate: string; cit_amount: number; gross_dividend: number };
    expect(calc.cit_rate).toBe("22/78");
    expect(calc.net_dividend).toBe(10000);
    // 10000 * 22/78 = 2820.512... → 2820.51
    expect(calc.cit_amount).toBe(roundMoney(10000 * 22 / 78));
    expect(calc.cit_amount).toBe(2820.51);
    expect(calc.gross_dividend).toBe(roundMoney(10000 + 10000 * 22 / 78));
  });

  it("calculates CIT correctly for amount that triggers rounding (78 EUR net)", async () => {
    // 78 * 22/78 = 22.000 exactly
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 78,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const calc = data.calculation as { cit_amount: number; gross_dividend: number };
    expect(calc.cit_amount).toBe(22);
    expect(calc.gross_dividend).toBe(100);
  });

  it("rounds CIT to cents for fractional result (100 EUR net)", async () => {
    // 100 * 22/78 = 28.2051282... → 28.21
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const calc = data.calculation as { cit_amount: number };
    expect(calc.cit_amount).toBe(28.21);
  });

  // -------------------------------------------------------------------------
  // Journal postings structure
  // -------------------------------------------------------------------------

  it("creates journal with correct debit/credit postings", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const je = data.journal_entry as { postings: Array<{ account: number; type: string; amount: number }> };
    // Retained earnings debited on two lines: one for net-to-shareholder, one for CIT.
    // Both hit 3020 so audit trail can distinguish the two components.
    const debitPostings = je.postings.filter(p => p.type === "D");
    expect(debitPostings).toHaveLength(2);
    expect(debitPostings.every(p => p.account === 3020)).toBe(true);
    const totalDebit = debitPostings.reduce((s, p) => s + p.amount, 0);
    expect(totalDebit).toBeCloseTo(10000 + 2820.51, 2);
    // One debit line should match net, the other should match CIT.
    expect(debitPostings.some(p => Math.abs(p.amount - 10000) < 0.01)).toBe(true);
    expect(debitPostings.some(p => Math.abs(p.amount - 2820.51) < 0.01)).toBe(true);
    // Net dividend credited to payable
    const creditDividend = je.postings.find(p => p.account === 2370);
    expect(creditDividend?.type).toBe("C");
    expect(creditDividend?.amount).toBe(10000);
    // CIT credited to tax payable
    const creditTax = je.postings.find(p => p.account === 2540);
    expect(creditTax?.type).toBe("C");
    expect(creditTax?.amount).toBe(2820.51);
  });

  // -------------------------------------------------------------------------
  // CIT rate date-gating (20/80 pre-2025, 22/78 from 2025-01-01)
  // -------------------------------------------------------------------------

  it("applies 20/80 CIT rate for pre-2025 effective_date", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2024-12-31",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const calc = data.calculation as { cit_rate: string; cit_amount: number; gross_dividend: number };
    expect(calc.cit_rate).toBe("20/80");
    // 10000 * 20/80 = 2500
    expect(calc.cit_amount).toBe(2500);
    expect(calc.gross_dividend).toBe(12500);
  });

  it("applies 22/78 CIT rate for 2025-01-01 boundary", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2025-01-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const calc = data.calculation as { cit_rate: string };
    expect(calc.cit_rate).toBe("22/78");
  });

  it("includes shareholder_client_id in document_number to avoid same-day collisions", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    await cb({
      net_dividend: 1000,
      shareholder_client_id: 42,
      effective_date: "2026-06-01",
    });

    const createCall = vi.mocked(api.journals.create).mock.calls[0]?.[0] as { document_number: string };
    expect(createCall.document_number).toBe("DIV-2026-06-01-42");
  });

  // -------------------------------------------------------------------------
  // Retained earnings sufficiency
  // -------------------------------------------------------------------------

  it("returns error when retained earnings are insufficient (no force)", async () => {
    // Net dividend 10 000 → gross ~12 820.51, but retained earnings only 5 000
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(3020, "C", 5000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(3000, "C", 2500),
      ]),
    ];
    api = makeApi(journals, makeStandardAccounts());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(true);
    const r = result as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain("Insufficient retained earnings");
    expect(text).toContain("5000");
  });

  it("proceeds with warning when retained earnings are insufficient and force=true", async () => {
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(3020, "C", 5000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(3000, "C", 2500),
      ]),
    ];
    api = makeApi(journals, makeStandardAccounts());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      force: true,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const warnings = data.warnings as string[];
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.some(w => w.includes("5000"))).toBe(true);
    expect(warnings.some(w => w.includes("force=true"))).toBe(true);
    // Journal was still created
    expect(vi.mocked(api.journals.create)).toHaveBeenCalledOnce();
  });

  it("proceeds without warnings when retained earnings are exactly sufficient", async () => {
    // gross for net=78 is exactly 100; retained earnings = 100
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 100),
        makePosting(3020, "C", 100),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(3000, "C", 2500),
      ]),
    ];
    api = makeApi(journals, makeStandardAccounts());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 78,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    // No retained-earnings warning expected
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.filter(w => w.includes("Retained earnings"))).toHaveLength(0);
    const check = data.retained_earnings_check as { sufficient: boolean };
    expect(check.sufficient).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Net assets rule (ÄS §157)
  // -------------------------------------------------------------------------

  it("adds net-assets warning when distribution would push net assets below share capital", async () => {
    // Assets (bank): 30000 = 5000 (share capital) + 25000 (retained earnings)
    // Share capital: 5000, Retained earnings: 25000
    // net_dividend=20000 → gross ≈ 25641.03; retained 25000 < 25641.03 so we need force=true
    // Net assets before = 30000, after = 30000 - 25641.03 ≈ 4358.97 < 5000 → warning
    const accounts = makeStandardAccounts().map(a =>
      a.id === 3000 ? makeAccount(3000, "C", "Omakapital", "Osakapital", "Share capital") : a
    );
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 25000),
        makePosting(3020, "C", 25000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(3000, "C", 5000),
      ]),
    ];
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    // force=true bypasses retained-earnings check so we reach the net-assets check
    const result = await cb({
      net_dividend: 20000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      force: true,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("§ 157"))).toBe(true);
    expect(warnings.some(w => w.includes("Net assets after distribution"))).toBe(true);
  });

  it("does not add net-assets warning when distribution leaves net assets above share capital", async () => {
    // Assets: 100 000, Share capital: 2 500, Retained earnings: 20 000
    // net_dividend: 10 000 → gross ~12 820.51; net assets after: 100 000 - 12 820.51 >> 2 500
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const netCheck = data.net_assets_check as { sufficient: boolean };
    expect(netCheck.sufficient).toBe(true);
    const warnings = (data.warnings ?? []) as string[];
    // No net-assets warning (retained-earnings warning may appear if insufficient, but we have 20k)
    expect(warnings.filter(w => w.includes("net assets"))).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Account validation
  // -------------------------------------------------------------------------

  it("returns error when a required account is missing from chart of accounts", async () => {
    const accountsWithoutTaxAccount = makeStandardAccounts().filter(a => a.id !== 2540);
    api = makeApi(makeHealthyJournals(), accountsWithoutTaxAccount);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(true);
    const r = result as { content: Array<{ text: string }> };
    expect(r.content[0].text).toContain("Account validation failed");
  });

  // -------------------------------------------------------------------------
  // Custom account overrides
  // -------------------------------------------------------------------------

  it("uses custom account IDs when provided", async () => {
    // Add custom account IDs to chart
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(3099, "C", "Omakapital", "Jaotamata kasum 2", "Retained earnings 2"),
      makeAccount(2380, "C", "Kohustused", "Dividendid 2", "Dividend payable 2"),
      makeAccount(2541, "C", "Kohustused", "Tulumaks 2", "CIT payable 2"),
      makeAccount(3001, "C", "Omakapital", "Osakapital 2", "Share capital 2"),
    ];
    // Give retained earnings 3099 a credit balance
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 20000),
        makePosting(3099, "C", 20000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(3001, "C", 2500),
      ]),
    ];
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 1000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      retained_earnings_account: 3099,
      dividend_payable_account: 2380,
      tax_payable_account: 2541,
      share_capital_account: 3001,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const check = data.retained_earnings_check as { account: number };
    expect(check.account).toBe(3099);
    const netCheck = data.net_assets_check as { share_capital_account: number };
    expect(netCheck.share_capital_account).toBe(3001);
  });

  // -------------------------------------------------------------------------
  // Ledger-imbalance cross-check (A - L must equal E + P&L)
  // -------------------------------------------------------------------------

  it("emits ledger-imbalance warning when a partially-deleted journal breaks the A − L = E + P&L identity", async () => {
    // Construct: one posting side marked is_deleted so the other side drives
    // assets up without a matching equity movement. This is the exact class
    // of defect the cross-check exists to surface.
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 30000),
        makePosting(3020, "C", 30000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(3000, "C", 5000),
      ]),
      // Partially-deleted journal: D side of cash stays, C side of equity is deleted.
      // Result: assets = 30000 + 5000 + 100 = 35100; equity + P&L = 30000 + 5000 = 35000.
      makeJournal("2024-06-01", [
        makePosting(1000, "D", 100),
        makePosting(3020, "C", 100, undefined, { is_deleted: true }),
      ]),
    ];
    const api2 = makeApi(journals, makeStandardAccounts());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api2);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 1000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("Ledger imbalance"))).toBe(true);
    expect(warnings.some(w => w.includes("unregistered/deleted journals"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: create_owner_expense_reimbursement
// ---------------------------------------------------------------------------

describe("create_owner_expense_reimbursement", () => {
  let tools: Map<string, ToolCallback>;
  let api: ApiContext;

  function setup(vatRegistered: boolean) {
    api = makeApi([], makeStandardAccounts(), { vatRegistered });
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    tools = mock.tools;
  }

  // -------------------------------------------------------------------------
  // VAT-registered company: splits input VAT
  // -------------------------------------------------------------------------

  it("splits input VAT into separate posting for VAT-registered company", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Office supplies",
      net_amount: 100,
      vat_rate: 0.24,
      vat_deduction_mode: "full",
      expense_account: 5000,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const expense = data.expense as {
      net: number;
      vat: number;
      total: number;
      vat_registered_company: boolean;
      expense_debited: number;
    };
    expect(expense.vat_registered_company).toBe(true);
    expect(expense.net).toBe(100);
    expect(expense.vat).toBe(24);
    expect(expense.total).toBe(124);
    // VAT-registered: expense account gets net only
    expect(expense.expense_debited).toBe(100);

    // Verify journal create was called with three postings
    const createCall = vi.mocked(api.journals.create).mock.calls[0][0] as {
      postings: Array<{ accounts_id: number; type: string; amount: number }>;
    };
    expect(createCall.postings).toHaveLength(3);
    expect(createCall.postings).toContainEqual({ accounts_id: 5000, type: "D", amount: 100 });
    expect(createCall.postings).toContainEqual({ accounts_id: 1510, type: "D", amount: 24 });
    expect(createCall.postings).toContainEqual({ accounts_id: 2110, type: "C", amount: 124 });
  });

  it("returns standards-aware follow-up guidance for ambiguous vehicle VAT costs", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Fuel for company car",
      net_amount: 100,
      vat_rate: 0.24,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(true);
    const payload = parseResult(result);
    expect(payload.error).toBe("VAT deduction needs confirmation for this expense category");
    expect(payload.hint).toContain("50%");
    expect(payload.compliance_basis).toEqual(expect.arrayContaining([
      expect.stringContaining("KMS § 29"),
      expect.stringContaining("KMS § 32"),
    ]));
    expect(payload.follow_up_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("M1-kategooria"),
      expect.stringContaining("erasõidud"),
    ]));
    expect(payload.policy_hint).toContain("accounting-rules.md");
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("rejects conflicting deductible_vat_amount when vat_deduction_mode='none'", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Office supplies",
      net_amount: 100,
      vat_rate: 0.24,
      vat_deduction_mode: "none",
      deductible_vat_amount: 24,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(true);
    const payload = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(payload).toContain("conflicts with vat_deduction_mode='none'");
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("rejects conflicting deductible_vat_amount when vat_deduction_mode='full'", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Office supplies",
      net_amount: 100,
      vat_rate: 0.24,
      vat_deduction_mode: "full",
      deductible_vat_amount: 10,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(true);
    const payload = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(payload).toContain("conflicts with vat_deduction_mode='full'");
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Non-VAT company: full gross to expense account
  // -------------------------------------------------------------------------

  it("debits full gross amount to expense account for non-VAT company", async () => {
    setup(false);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Office supplies",
      net_amount: 100,
      vat_rate: 0.24,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const expense = data.expense as {
      vat_registered_company: boolean;
      expense_debited: number;
      total: number;
    };
    expect(expense.vat_registered_company).toBe(false);
    // Non-VAT: full gross (124) debited to expense account
    expect(expense.expense_debited).toBe(124);
    expect(expense.total).toBe(124);

    // Verify journal postings: only two (expense + payable, no VAT account)
    const createCall = vi.mocked(api.journals.create).mock.calls[0][0] as {
      postings: Array<{ accounts_id: number; type: string; amount: number }>;
    };
    expect(createCall.postings).toHaveLength(2);
    expect(createCall.postings).toContainEqual({ accounts_id: 5000, type: "D", amount: 124 });
    expect(createCall.postings).toContainEqual({ accounts_id: 2110, type: "C", amount: 124 });
  });

  // -------------------------------------------------------------------------
  // Zero VAT: no VAT posting even for VAT-registered company
  // -------------------------------------------------------------------------

  it("creates no VAT posting when vat_rate=0 even for VAT-registered company", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Bank fee",
      net_amount: 50,
      vat_rate: 0,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(false);
    const createCall = vi.mocked(api.journals.create).mock.calls[0][0] as {
      postings: Array<{ accounts_id: number }>;
    };
    expect(createCall.postings).toHaveLength(2);
    expect(createCall.postings.map(p => p.accounts_id)).not.toContain(1510);
  });

  // -------------------------------------------------------------------------
  // Custom vat_amount overrides vat_rate
  // -------------------------------------------------------------------------

  it("uses provided vat_amount instead of computing from vat_rate", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Receipt with exact VAT",
      net_amount: 100,
      vat_rate: 0.24,
      vat_amount: 20, // override: exact receipt value
      expense_account: 5000,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const expense = data.expense as { vat: number; total: number; vat_rate: string };
    expect(expense.vat).toBe(20);
    expect(expense.total).toBe(120);
    expect(expense.vat_rate).toBe("custom");
  });

  // -------------------------------------------------------------------------
  // Custom payable/VAT account IDs
  // -------------------------------------------------------------------------

  it("uses custom vat_account and payable_account when provided", async () => {
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(1511, "D", "Varad", "KM 2", "VAT 2"),
      makeAccount(2111, "C", "Kohustused", "Võlg 2", "Owner payable 2"),
    ];
    api = makeApi([], accounts, { vatRegistered: true });
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Test",
      net_amount: 100,
      vat_rate: 0.24,
      vat_deduction_mode: "full",
      expense_account: 5000,
      vat_account: 1511,
      payable_account: 2111,
    });

    expect(isError(result)).toBe(false);
    const createCall = vi.mocked(api.journals.create).mock.calls[0][0] as {
      postings: Array<{ accounts_id: number }>;
    };
    expect(createCall.postings.map(p => p.accounts_id)).toContain(1511);
    expect(createCall.postings.map(p => p.accounts_id)).toContain(2111);
  });

  it("defaults VAT to deductible for ordinary VAT-registered expenses", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Office supplies",
      net_amount: 100,
      vat_rate: 0.24,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const expense = data.expense as {
      vat_deduction_mode: string;
      deductible_vat: number;
      non_deductible_vat: number;
      expense_debited: number;
    };
    expect(expense.vat_deduction_mode).toBe("full");
    expect(expense.deductible_vat).toBe(24);
    expect(expense.non_deductible_vat).toBe(0);
    expect(expense.expense_debited).toBe(100);
    expect((data.suggestions as string[])[0]).toContain("fully deducted");
  });

  it("asks for clarification on likely restricted VAT categories when no deduction mode is provided", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Fuel for passenger car",
      net_amount: 100,
      vat_rate: 0.24,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(true);
    const payload = result as { content: Array<{ text: string }> };
    expect(payload.content[0]!.text).toContain("VAT deduction needs confirmation");
    expect(payload.content[0]!.text).toContain("vat_deduction_mode='full'");
  });

  // -------------------------------------------------------------------------
  // Account validation
  // -------------------------------------------------------------------------

  it("returns error when expense account is missing from chart of accounts", async () => {
    setup(false);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Test",
      net_amount: 100,
      vat_rate: 0,
      expense_account: 9999, // does not exist
    });

    expect(isError(result)).toBe(true);
    const r = result as { content: Array<{ text: string }> };
    expect(r.content[0].text).toContain("Account validation failed");
  });
});

// ---------------------------------------------------------------------------
// Tests: roundMoney used in CIT calculation
// ---------------------------------------------------------------------------

describe("roundMoney CIT precision", () => {
  it("22/78 CIT for 10 000 EUR rounds to 2820.51", () => {
    expect(roundMoney(10000 * 22 / 78)).toBe(2820.51);
  });

  it("22/78 CIT for 78 EUR is exactly 22.00", () => {
    expect(roundMoney(78 * 22 / 78)).toBe(22);
  });

  it("22/78 CIT for 1 EUR rounds to 0.28", () => {
    // 1 * 22/78 = 0.28205... → 0.28
    expect(roundMoney(1 * 22 / 78)).toBe(0.28);
  });

  it("gross = net + CIT is consistent with roundMoney", () => {
    const net = 10000;
    const cit = roundMoney(net * 22 / 78);
    const gross = net + cit;
    expect(gross).toBe(12820.51);
    // gross can be verified: debit = credit (within cent precision)
    expect(roundMoney(gross)).toBe(gross); // already rounded
  });
});
