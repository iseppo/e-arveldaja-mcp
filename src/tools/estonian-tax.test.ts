import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { Account, Journal, Posting, SaleInvoice } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { registerEstonianTaxTools } from "./estonian-tax.js";
import { roundMoney } from "../money.js";
import { parseMcpResponse } from "../mcp-json.js";
import { makeAccount, makePosting, makeJournal } from "../__fixtures__/accounting.js";

const { mockedLogAudit } = vi.hoisted(() => ({ mockedLogAudit: vi.fn() }));
vi.mock("../audit-log.js", () => ({ logAudit: mockedLogAudit }));

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
    // Income tax expense (RTJ Schema 1 "Tulumaks" line, 8900–8999)
    makeAccount(8900, "D", "Kulud", "Tulumaks", "Income tax expense"),
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
  const configs = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
  const server = {
    registerTool: vi.fn((name: string, config: unknown, callback: ToolCallback) => {
      configs.set(name, config as { description?: string; inputSchema?: Record<string, unknown> });
      tools.set(name, callback);
    }),
  };
  return { server: server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, tools, configs };
}

function toolMetadataText(config: { description?: string; inputSchema?: Record<string, unknown> }): string {
  const schema = config.inputSchema ? z.object(config.inputSchema as z.ZodRawShape).toJSONSchema() : {};
  return `${config.description ?? ""}\n${JSON.stringify(schema)}`;
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
    saleInvoices?: SaleInvoice[];
  } = {},
): ApiContext {
  const { vatRegistered = false, clientName = "Test Shareholder", saleInvoices = [] } = options;
  const bookingJournals: Journal[] = [];

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
      connectionFingerprint: "estonian-tax-test-connection",
      invalidateListCache: vi.fn(),
      listAll: vi.fn(async () => bookingJournals),
      listAllWithPostings: vi.fn(async () => journals),
      get: vi.fn(async (id: number) => bookingJournals.find(item => item.id === id)),
      create: vi.fn(async (data: Partial<Journal>) => {
        bookingJournals.push({ ...data, id: 42, registered: false, is_deleted: false } as Journal);
        return { code: 200, created_object_id: 42, messages: [] };
      }),
      confirm: vi.fn(async () => ({ code: 200, messages: [] })),
    },
    saleInvoices: { listAll: vi.fn(async () => saleInvoices) },
    purchaseInvoices: { listAll: vi.fn(async () => []) },
  } as unknown as ApiContext;
}

function makeSaleInvoice(overrides: Partial<SaleInvoice> & Pick<SaleInvoice, "id" | "journal_date">): SaleInvoice {
  return {
    sale_invoice_type: "INVOICE",
    cl_templates_id: 1,
    clients_id: 1,
    cl_countries_id: "EST",
    number_suffix: String(overrides.id),
    create_date: overrides.journal_date,
    term_days: 7,
    cl_currencies_id: "EUR",
    show_client_balance: false,
    status: "CONFIRMED",
    gross_price: 0,
    ...overrides,
  };
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
    mockedLogAudit.mockClear();
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
    // Two debit lines: NET dividend to retained earnings (3020), CIT to the
    // income-tax expense account (8900) — the tax is a P&L expense, not a
    // retained-earnings debit.
    const debitPostings = je.postings.filter(p => p.type === "D");
    expect(debitPostings).toHaveLength(2);
    const retainedDebit = debitPostings.find(p => p.account === 3020);
    expect(retainedDebit?.amount).toBe(10000);
    const taxExpenseDebit = debitPostings.find(p => p.account === 8900);
    expect(taxExpenseDebit?.amount).toBe(2820.51);
    // Retained earnings must NOT be debited with the CIT — this is the exact
    // bug the net-dividend rule fixes (gross was previously drained from equity).
    expect(debitPostings.filter(p => p.account === 3020)).toHaveLength(1);
    // Net dividend credited to payable
    const creditDividend = je.postings.find(p => p.account === 2370);
    expect(creditDividend?.type).toBe("C");
    expect(creditDividend?.amount).toBe(10000);
    // CIT credited to tax payable
    const creditTax = je.postings.find(p => p.account === 2540);
    expect(creditTax?.type).toBe("C");
    expect(creditTax?.amount).toBe(2820.51);
    // Journal balances: total debits == total credits
    const totalDebit = debitPostings.reduce((s, p) => s + p.amount, 0);
    const totalCredit = je.postings.filter(p => p.type === "C").reduce((s, p) => s + p.amount, 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
    expect(totalDebit).toBeCloseTo(10000 + 2820.51, 2);
    // Booking summary is surfaced for operator verification
    const booking = data.booking as { retained_earnings_account: number; income_tax_expense_account: number; income_tax_expense_debit: number };
    expect(booking.retained_earnings_account).toBe(3020);
    expect(booking.income_tax_expense_account).toBe(8900);
    expect(booking.income_tax_expense_debit).toBe(2820.51);
  });

  it("books the CIT to a custom income_tax_expense_account when provided", async () => {
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(8910, "D", "Kulud", "Ettevõtte tulumaks", "CIT expense"),
    ];
    api = makeApi(makeHealthyJournals(), accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      income_tax_expense_account: 8910,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const je = data.journal_entry as { postings: Array<{ account: number; type: string; amount: number }> };
    const taxExpenseDebit = je.postings.find(p => p.type === "D" && p.account === 8910);
    expect(taxExpenseDebit?.amount).toBe(2820.51);
    // Retained earnings only carries the net dividend
    const retainedDebit = je.postings.find(p => p.type === "D" && p.account === 3020);
    expect(retainedDebit?.amount).toBe(10000);
  });

  it("auto-detects the lowest 8900-series Kulud account when 8900 itself is absent", async () => {
    // Chart has no 8900 but has 8910 and 8950 — auto-detect must pick 8910
    // (lowest in range), NOT fall back to the 8900 constant. Guards against a
    // filter regression that the all-8900 fixtures would not catch.
    const accounts = [
      ...makeStandardAccounts().filter(a => a.id !== 8900),
      makeAccount(8950, "D", "Kulud", "Tulumaks B", "Income tax expense B"),
      makeAccount(8910, "D", "Kulud", "Tulumaks A", "Income tax expense A"),
    ];
    api = makeApi(makeHealthyJournals(), accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const booking = data.booking as { income_tax_expense_account: number };
    expect(booking.income_tax_expense_account).toBe(8910);
    const je = data.journal_entry as { postings: Array<{ account: number; type: string; amount: number }> };
    expect(je.postings.find(p => p.type === "D" && p.account === 8910)?.amount).toBe(2820.51);
  });

  it("auto-detect skips an inactive 8900-series account and picks the active one", async () => {
    // 8900 exists but is deactivated (is_valid=false); 8910 is active.
    // getAccounts() returns inactive accounts and validateAccounts() rejects
    // them, so the resolver must skip 8900 and book to 8910 — not error out.
    const accounts = [
      ...makeStandardAccounts().filter(a => a.id !== 8900),
      makeAccount(8900, "D", "Kulud", "Tulumaks (vana)", "Income tax (old)", { is_valid: false }),
      makeAccount(8910, "D", "Kulud", "Tulumaks", "Income tax expense"),
    ];
    api = makeApi(makeHealthyJournals(), accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const booking = data.booking as { income_tax_expense_account: number };
    expect(booking.income_tax_expense_account).toBe(8910);
    const je = data.journal_entry as { postings: Array<{ account: number; type: string; amount: number }> };
    expect(je.postings.find(p => p.type === "D" && p.account === 8910)?.amount).toBe(2820.51);
  });

  it("warns (non-blocking) when an override points the CIT at a non-expense account", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    // Override to retained earnings 3020 (an equity account) — the exact class
    // of mistake the type guard catches. Journal is still created (warning only).
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      income_tax_expense_account: 3020,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("not an expense (Kulud) account"))).toBe(true);
  });

  it("errors when no income-tax expense account exists in the chart and none is given", async () => {
    // Chart without any 8900-series account: auto-detect falls back to the
    // default 8900 constant, which is absent → account validation fails.
    const accountsWithoutTaxExpense = makeStandardAccounts().filter(a => a.id !== 8900);
    api = makeApi(makeHealthyJournals(), accountsWithoutTaxExpense);
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
    expect(r.content[0].text).toContain("Income-tax expense account");
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

  it("H06-D preserves the legacy dividend number and uses the validated client id", async () => {
    vi.mocked(api.clients.get).mockResolvedValue({ id: 999, name: "Test Shareholder" } as never);
    const cb = tools.get("prepare_dividend_package")!;
    const preview = parseResult(await cb({
      net_dividend: 1000, shareholder_client_id: 42, effective_date: "2026-06-01", dry_run: true,
    }));
    expect((preview.proposed_journal as { document_number: string; clients_id: number }).document_number)
      .toBe("DIV-2026-06-01-42");
    expect((preview.proposed_journal as { clients_id: number }).clients_id).toBe(42);
    expect((preview.shareholder as { id: number }).id).toBe(42);

    const executed = parseResult(await cb({
      net_dividend: 1000, shareholder_client_id: 42, effective_date: "2026-06-01",
    }));
    const createPayload = vi.mocked(api.journals.create).mock.calls[0]![0] as Journal;
    expect(createPayload.document_number).toBe("DIV-2026-06-01-42");
    expect(createPayload.clients_id).toBe(42);
    expect((executed.shareholder as { id: number }).id).toBe(42);
  });

  it("H06-D deduplicates the same company date and shareholder across calls", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const input = { net_dividend: 1000, shareholder_client_id: 42, effective_date: "2026-06-01" };
    const first = parseResult(await cb(input));
    const second = parseResult(await cb(input));
    expect(api.journals.create).toHaveBeenCalledTimes(1);
    expect(((first.journal_entry as Record<string, unknown>).api_response as { created_object_id: number }).created_object_id).toBe(42);
    expect(((second.journal_entry as Record<string, unknown>).api_response as { created_object_id: number }).created_object_id).toBe(42);
    expect((second.journal_entry as { booking_status: string }).booking_status).toBe("duplicate");
  });

  it("H06-D keeps created response and created audit compatible, while duplicate audit is UPDATED", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const input = { net_dividend: 1000, shareholder_client_id: 42, effective_date: "2026-06-01" };
    const first = parseResult(await cb(input));
    await cb(input);
    expect((first.journal_entry as { api_response: unknown }).api_response).toEqual({
      code: 200, messages: [], created_object_id: 42,
    });
    expect(mockedLogAudit.mock.calls[0]![0]).toMatchObject({
      action: "CREATED", entity_id: 42,
      summary: "Dividend journal: 1000 EUR net to Test Shareholder, CIT 282.05 EUR",
      details: { effective_date: "2026-06-01", client_name: "Test Shareholder", amount: 1282.05,
        total_net: 1000, total_gross: 1282.05, booking_key: "DIV-2026-06-01-42", booking_status: "created" },
    });
    expect(mockedLogAudit.mock.calls[1]![0]).toMatchObject({
      action: "UPDATED", entity_id: 42,
      details: { booking_key: "DIV-2026-06-01-42", booking_status: "duplicate" },
    });
  });

  // -------------------------------------------------------------------------
  // Retained earnings sufficiency
  // -------------------------------------------------------------------------

  it("returns error when retained earnings are insufficient (no force)", async () => {
    // Net dividend 10 000, but retained earnings only 5 000 — the ÄS § 157
    // lg 1 ceiling is NET-based, so 10 000 > 5 000 blocks.
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
    const data = parseResult(result);
    const check = data.retained_earnings_check as { net_dividend_required: number; shortfall: number };
    expect(check.net_dividend_required).toBe(10000);
    expect(check.shortfall).toBe(5000);
    // Net assets 7 500, floor 2 500 → net-assets headroom (7 500 − 2 500) × 78/100
    // = 3 900 binds below the 5 000 retained balance.
    const max = data.maximum_distributable as { max_net_dividend: number; limited_by: string };
    expect(max.max_net_dividend).toBe(3900);
    expect(max.limited_by).toBe("net_assets");
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

  it("allows distributing the ENTIRE retained-earnings balance as net dividend (§ 157 lg 1 is net-based)", async () => {
    // Retained 20 000, share capital 2 500, current-year profit 10 000.
    // Net 20 000 → gross 25 641.03 EXCEEDS retained earnings — lawful anyway:
    // the CIT is a current-period expense (TuMS § 50), not part of the
    // distribution. Net assets before = 32 500; after = 6 858.97 ≥ floor 2 500.
    // This is the exact scenario the old gross-based check wrongly blocked.
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(4000, "C", "Tulud", "Müügitulu", "Sales revenue"),
    ];
    const journals = [
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(3020, "C", 20000)]),
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(3000, "C", 2500)]),
      makeJournal("2026-02-01", [makePosting(1000, "D", 10000), makePosting(4000, "C", 10000)]),
    ];
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 20000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const check = data.retained_earnings_check as { sufficient: boolean; net_dividend_required: number };
    expect(check.sufficient).toBe(true);
    expect(check.net_dividend_required).toBe(20000);
    const calc = data.calculation as { gross_dividend: number };
    expect(calc.gross_dividend).toBe(25641.03); // gross > retained is fine
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.filter(w => w.includes("Retained earnings"))).toHaveLength(0);
    expect(vi.mocked(api.journals.create)).toHaveBeenCalledOnce();
  });

  it("blocks a net dividend exceeding retained earnings and reports the retained-limited maximum", async () => {
    // Retained 5 000 with a large net-assets buffer (profit 50 000): the
    // retained-earnings clause is the binding limit, not net assets.
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(4000, "C", "Tulud", "Müügitulu", "Sales revenue"),
    ];
    const journals = [
      makeJournal("2024-01-01", [makePosting(1000, "D", 5000), makePosting(3020, "C", 5000)]),
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(3000, "C", 2500)]),
      makeJournal("2026-02-01", [makePosting(1000, "D", 50000), makePosting(4000, "C", 50000)]),
    ];
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 6000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(String(data.error)).toContain("Insufficient retained earnings");
    const max = data.maximum_distributable as { max_net_dividend: number; limited_by: string };
    expect(max.max_net_dividend).toBe(5000);
    expect(max.limited_by).toBe("retained_earnings");
    expect(String(data.hint)).toContain("5000");
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("surfaces statutory compliance notes (approved report + decision, TSD annex 7) on every path", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const preview = parseResult(await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      dry_run: true,
    }));
    const previewNotes = preview.compliance_notes as string[];
    expect(previewNotes.some(n => n.includes("KINNITATUD majandusaasta aruannet"))).toBe(true);
    expect(previewNotes.some(n => n.includes("attach_document"))).toBe(true);
    expect(previewNotes.some(n => n.includes("TSD lisal 7"))).toBe(true);

    const executed = parseResult(await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    }));
    expect((executed.compliance_notes as string[]).some(n => n.includes("TSD lisal 7"))).toBe(true);
  });

  it("renders tool descriptions from the statutory data (rates and thresholds never hand-maintained)", () => {
    const { server, configs } = makeMockServer();
    registerEstonianTaxTools(server, makeApi(makeHealthyJournals(), makeStandardAccounts()));

    const dividendMeta = toolMetadataText(configs.get("prepare_dividend_package")!);
    expect(dividendMeta).toContain("22/78");
    expect(dividendMeta).toContain("2025-01-01");
    expect(dividendMeta).toContain("distributable as net dividend");
    expect(dividendMeta).toContain("max_net_dividend");

    const limitsMeta = toolMetadataText(configs.get("check_tax_free_limits")!);
    expect(limitsMeta).toContain("50 €/month");
    expect(limitsMeta).toContain("22/78");

    const vatMeta = toolMetadataText(configs.get("check_vat_registration_threshold")!);
    expect(vatMeta).toContain("40000 EUR");
  });

  // -------------------------------------------------------------------------
  // Net assets rule (ÄS §157)
  // -------------------------------------------------------------------------

  it("blocks distribution without force=true when it would push net assets below share capital (§ 157)", async () => {
    // Fixture: healthy retained earnings but a big current-year loss so
    // net_assets < share + retained. Retained check passes, §157 triggers.
    // - share capital 5000, retained 20000 (D 1000 25000, C 3000 5000, C 3020 20000)
    // - current-year loss 18000 (D 5000 18000, C 1000 18000)
    // - net_assets_before = equity (5000+20000) + P&L (-18000) = 7000
    // - net_dividend=2000 → gross ≈ 2564.10
    //   retained 20000 >= 2564.10  ✓ (retained check passes)
    //   net_assets_after = 7000 - 2564.10 = 4435.90 < 5000 → § 157 block
    const accounts = makeStandardAccounts().map(a =>
      a.id === 3000 ? makeAccount(3000, "C", "Omakapital", "Osakapital", "Share capital") : a
    );
    const journals = [
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(3000, "C", 5000),
      ]),
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 20000),
        makePosting(3020, "C", 20000),
      ]),
      makeJournal("2026-03-01", [
        makePosting(5000, "D", 18000),
        makePosting(1000, "C", 18000),
      ]),
    ];
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 2000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("ÄS § 157 net assets breach");
    // Net assets 7 000, floor 5 000 → max net = (7000 − 5000) × 78/100 = 1560.
    const max = data.maximum_distributable as { max_net_dividend: number; limited_by: string };
    expect(max.max_net_dividend).toBe(1560);
    expect(max.limited_by).toBe("net_assets");
  });

  it("does not let a negative restricted-reserve balance lower the § 157 floor (clamped to ≥ 0)", async () => {
    // Reserve account 3010 carries an anomalous DEBIT balance (−3000). Unclamped,
    // the § 157 floor would drop to 5000 + (−3000) = 2000 and wrongly let this
    // distribution through; clamped, the floor stays at the 5000 share capital.
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(3010, "C", "Omakapital", "Reservkapital", "Reserve capital"),
    ];
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(3000, "C", 5000)]),   // share capital 5000
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(3020, "C", 20000)]), // retained 20000
      makeJournal("2024-06-01", [makePosting(3010, "D", 3000), makePosting(1000, "C", 3000)]),   // reserve → −3000
      makeJournal("2026-03-01", [makePosting(5000, "D", 18000), makePosting(1000, "C", 18000)]), // current-year loss
    ];
    // net_assets_before = equity (5000+20000−3000) + P&L (−18000) = 4000
    // net_dividend 100 → gross ≈ 128.21 → net_assets_after ≈ 3871.79
    //   clamped floor 5000 → 3871.79 < 5000 → BLOCKED (would pass at unclamped floor 2000)
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({ net_dividend: 100, shareholder_client_id: 1, effective_date: "2026-06-01" });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("ÄS § 157 net assets breach");
    const check = data.net_assets_check as { minimum_net_assets: number; restricted_reserves: number };
    expect(check.minimum_net_assets).toBe(5000);   // floor NOT lowered by the −3000 reserve
    expect(check.restricted_reserves).toBe(-3000); // raw signed total still surfaced for visibility
  });

  it("clamps restricted reserves per account, so a negative one cannot offset a positive one in the § 157 floor", async () => {
    // Two explicit restricted reserves: 3010 = +3000, 3011 = −2000. Clamping the
    // summed total would give max(0, 1000) = 1000 and a 6000 floor; clamping per
    // account gives 3000 + 0 = 3000 and an 8000 floor. net_assets_after ≈ 6971.79
    // sits between the two, so the per-account clamp must BLOCK this distribution.
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(3010, "C", "Omakapital", "Reservkapital", "Reserve capital"),
      makeAccount(3011, "C", "Omakapital", "Muu reserv", "Other reserve"),
    ];
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(3000, "C", 5000)]),    // share capital 5000
      makeJournal("2024-01-01", [makePosting(1000, "D", 30000), makePosting(3020, "C", 30000)]),  // retained 30000
      makeJournal("2024-02-01", [makePosting(1000, "D", 3000), makePosting(3010, "C", 3000)]),    // reserve 3010 = +3000
      makeJournal("2024-03-01", [makePosting(3011, "D", 2000), makePosting(1000, "C", 2000)]),    // reserve 3011 = −2000
      makeJournal("2026-03-01", [makePosting(5000, "D", 28900), makePosting(1000, "C", 28900)]),  // current-year loss
    ];
    // net_assets_before = equity (5000+30000+3000−2000) + P&L (−28900) = 7100
    // net_dividend 100 → gross ≈ 128.21 → net_assets_after ≈ 6971.79
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      restricted_reserve_accounts: [3010, 3011],
    });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("ÄS § 157 net assets breach");
    const check = data.net_assets_check as { minimum_net_assets: number; restricted_reserves: number };
    expect(check.minimum_net_assets).toBe(8000); // 5000 + max(0,3000) + max(0,−2000), NOT 5000 + max(0,1000)
    expect(check.restricted_reserves).toBe(1000); // raw signed total (3000 + −2000) still surfaced
  });

  it("warns (still creates journal) when force=true and net assets would fall below share capital", async () => {
    // Same fixture, but with force=true: the journal is created and the
    // warning mentions both § 157 and "Net assets after distribution".
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

    // force=true bypasses both retained-earnings and net-assets hard blocks.
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
  // § 157(2) restricted-reserve floor (reservkapital)
  // -------------------------------------------------------------------------

  // Fixture: share 5000, reservkapital 3000, retained 20000, current-year loss
  // 18000 ⇒ net assets = 10000. A 2000 EUR net dividend (gross 2564.10) leaves
  // net assets at 7435.90 — above bare share capital (5000) but below the
  // § 157(2) floor of share + reserves (8000).
  function reserveFloorJournals(): Journal[] {
    return [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(3000, "C", 5000)]),
      makeJournal("2023-02-01", [makePosting(1000, "D", 3000), makePosting(3010, "C", 3000)]),
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(3020, "C", 20000)]),
      makeJournal("2026-03-01", [makePosting(5000, "D", 18000), makePosting(1000, "C", 18000)]),
    ];
  }
  function accountsWithReserveCapital(): Account[] {
    return [
      ...makeStandardAccounts().map(a =>
        a.id === 3000 ? makeAccount(3000, "C", "Omakapital", "Osakapital", "Share capital") : a
      ),
      makeAccount(3010, "C", "Omakapital", "Reservkapital", "Statutory reserve"),
    ];
  }

  it("blocks on the §157(2) reservkapital floor even when net assets clear share capital alone", async () => {
    api = makeApi(reserveFloorJournals(), accountsWithReserveCapital());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 2000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("ÄS § 157 net assets breach");
    const netCheck = data.net_assets_check as {
      share_capital: number; restricted_reserves: number; minimum_net_assets: number;
      net_assets_after_distribution: number; shortfall: number;
    };
    expect(netCheck.share_capital).toBe(5000);
    expect(netCheck.restricted_reserves).toBe(3000);
    // Floor is share + reserves, not share alone.
    expect(netCheck.minimum_net_assets).toBe(8000);
    expect(netCheck.net_assets_after_distribution).toBe(7435.9);
    expect(netCheck.shortfall).toBe(564.1);
  });

  it("override restricted_reserve_accounts=[] drops the reserve floor back to share capital", async () => {
    api = makeApi(reserveFloorJournals(), accountsWithReserveCapital());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    // Same distribution, but the operator declares no reserves are restricted:
    // net assets after (7435.90) clear bare share capital (5000), so it books.
    const result = await cb({
      net_dividend: 2000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      restricted_reserve_accounts: [],
    });

    expect(isError(result)).toBe(false);
    expect(vi.mocked(api.journals.create)).toHaveBeenCalledOnce();
    const data = parseResult(result);
    const netCheck = data.net_assets_check as { restricted_reserves: number; minimum_net_assets: number; sufficient: boolean };
    expect(netCheck.restricted_reserves).toBe(0);
    expect(netCheck.minimum_net_assets).toBe(5000);
    expect(netCheck.sufficient).toBe(true);
  });

  it("auto-detects reservkapital, raises the floor, and warns on an otherwise lawful distribution", async () => {
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(3000, "C", 2500)]),
      makeJournal("2023-02-01", [makePosting(1000, "D", 1000), makePosting(3010, "C", 1000)]),
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(3020, "C", 20000)]),
    ];
    api = makeApi(journals, accountsWithReserveCapital());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const netCheck = data.net_assets_check as { restricted_reserves: number; minimum_net_assets: number; sufficient: boolean };
    expect(netCheck.restricted_reserves).toBe(1000);
    expect(netCheck.minimum_net_assets).toBe(3500);
    expect(netCheck.sufficient).toBe(true);
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("restricted-reserve floor applied"))).toBe(true);
  });

  it("surfaces the opening-balance API limitation when share capital or retained earnings reads as zero", async () => {
    // Retained earnings present but no share-capital postings — the classic
    // symptom of opening balances entered as "Algbilansi kanded" that the
    // /journals API omits, so the § 157 check runs on incomplete data. Warn
    // (don't block): the operator verifies opening balances in the UI.
    const journals = [
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(3020, "C", 20000)]),
    ];
    api = makeApi(journals, makeStandardAccounts());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("Algbilansi kanded"))).toBe(true);
  });

  it("errors when an explicit restricted_reserve_accounts entry does not exist in the chart", async () => {
    // A mistyped/absent reserve override must fail loudly — silently reading a
    // 0 balance would LOWER the §157(2) floor and could pass an unlawful dividend.
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      restricted_reserve_accounts: [9999], // absent from makeStandardAccounts
    });
    expect(isError(result)).toBe(true);
    const r = result as { content: Array<{ text: string }> };
    expect(r.content[0].text).toContain("Account validation failed");
    expect(r.content[0].text).toContain("Restricted reserve account");
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("surfaces the opening-balance caveat on a blocked distribution when retained earnings read 0", async () => {
    // Share capital present, retained earnings absent (opening balances the
    // /journals API may omit). The distribution is blocked, but the caveat that
    // the check ran on possibly-incomplete data must still reach the operator on
    // the error path — not just on dry_run / executed.
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(3000, "C", 5000)]),
    ];
    api = makeApi(journals, makeStandardAccounts());
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({
      net_dividend: 100,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(String(data.error)).toContain("Insufficient retained earnings");
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("Algbilansi kanded"))).toBe(true);
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
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

  it("HARD-BLOCKS dividend creation when a partially-deleted journal breaks the A − L = E + P&L identity", async () => {
    // Construct: one posting side marked is_deleted so the other side drives
    // assets up without a matching equity movement. This is the exact class
    // of defect the cross-check exists to surface. On an imbalanced ledger
    // the retained-earnings and §157 net-assets checks compute from wrong
    // totals, so prepare_dividend_package refuses to produce legal-distribution
    // output — this is a legal/compliance-sensitive tool.
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

    expect(isError(result)).toBe(true);
    const payload = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(payload).toMatch(/Ledger is imbalanced|Ledger imbalance/);
  });

  it("ledger-imbalance block is overridable with force=true (operator explicitly accepts the risk)", async () => {
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 30000),
        makePosting(3020, "C", 30000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(3000, "C", 5000),
      ]),
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
      force: true,
      dry_run: true,
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("Ledger imbalance"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Booked journal: assert on what is actually sent to api.journals.create,
  // not just the echoed journal_entry. The create() payload keys postings on
  // `accounts_id` (the API field); the echoed journal_entry keys them on
  // `account`. A bug that books the wrong accounts_id but echoes the right
  // `account` would pass every response-parsing test above — so pin the call.
  // -------------------------------------------------------------------------

  it("sends the correct postings to api.journals.create (booked journal, not the echo)", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    expect(vi.mocked(api.journals.create)).toHaveBeenCalledOnce();
    const booked = vi.mocked(api.journals.create).mock.calls[0][0] as {
      postings: Array<{ accounts_id: number; type: "D" | "C"; amount: number }>;
      cl_currencies_id: string;
    };
    expect(booked.postings).toHaveLength(4);
    const byAccount = (id: number) => booked.postings.find(p => p.accounts_id === id);
    // NET dividend debited to retained earnings (3020); CIT debited to the
    // 8900 income-tax expense account — NOT a second debit to retained earnings.
    expect(byAccount(3020)).toEqual({ accounts_id: 3020, type: "D", amount: 10000 });
    expect(byAccount(8900)).toEqual({ accounts_id: 8900, type: "D", amount: 2820.51 });
    // NET dividend credited to payable (2370); CIT credited to tax payable (2540).
    expect(byAccount(2370)).toEqual({ accounts_id: 2370, type: "C", amount: 10000 });
    expect(byAccount(2540)).toEqual({ accounts_id: 2540, type: "C", amount: 2820.51 });
    // Retained earnings is debited exactly once — the gross was never drained.
    expect(booked.postings.filter(p => p.accounts_id === 3020)).toHaveLength(1);
    // Double-entry balances.
    const debits = booked.postings.filter(p => p.type === "D").reduce((s, p) => s + p.amount, 0);
    const credits = booked.postings.filter(p => p.type === "C").reduce((s, p) => s + p.amount, 0);
    expect(roundMoney(debits)).toBe(roundMoney(credits));
    expect(roundMoney(debits)).toBe(roundMoney(10000 + 2820.51));
    expect(booked.cl_currencies_id).toBe("EUR");
  });

  it("rejects a non-positive net_dividend and books nothing", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    for (const bad of [0, -0.01, -10000]) {
      const result = await cb({
        net_dividend: bad,
        shareholder_client_id: 1,
        effective_date: "2026-06-01",
      });
      expect(isError(result)).toBe(true);
      expect((result as { content: Array<{ text: string }> }).content[0].text)
        .toContain("net_dividend must be > 0");
    }
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("rejects a net_dividend that rounds to 0.00 EUR and books nothing", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    // 0.004 EUR is positive but rounds to 0.00 — must be caught AFTER rounding,
    // not by the raw > 0 guard, or an empty journal would be booked.
    const result = await cb({
      net_dividend: 0.004,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });
    expect(isError(result)).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text)
      .toContain("net_dividend rounds to 0.00 EUR");
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("dry_run previews the postings without creating a journal", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      dry_run: true,
    });
    expect(isError(result)).toBe(false);
    expect(parseResult(result).dry_run).toBe(true);
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("rounds a sub-cent net_dividend before booking — no unrounded amount leaks into the journal", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    // 100.006 rounds up to 100.01; every booked amount must be cent-exact and
    // the reported gross must equal the sum actually posted.
    const result = await cb({
      net_dividend: 100.006,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const calc = data.calculation as { net_dividend: number; gross_dividend: number };
    expect(calc.net_dividend).toBe(100.01);

    const booked = vi.mocked(api.journals.create).mock.calls[0][0] as {
      postings: Array<{ accounts_id: number; type: "D" | "C"; amount: number }>;
    };
    // Every posted amount is already cent-rounded (=== its own roundMoney).
    for (const p of booked.postings) {
      expect(p.amount).toBe(roundMoney(p.amount));
    }
    // Net dividend booked at the rounded value, not the raw 100.006.
    const retainedDebit = booked.postings.find(p => p.accounts_id === 3020 && p.type === "D");
    expect(retainedDebit?.amount).toBe(100.01);
    // Debits balance credits exactly, and the reported gross is that same total.
    const debits = roundMoney(booked.postings.filter(p => p.type === "D").reduce((s, p) => s + p.amount, 0));
    const credits = roundMoney(booked.postings.filter(p => p.type === "C").reduce((s, p) => s + p.amount, 0));
    expect(debits).toBe(credits);
    expect(calc.gross_dividend).toBe(debits);
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

  it("keeps direct-call VAT invariants in tool metadata", () => {
    const accounts = makeStandardAccounts();
    const { server, configs } = makeMockServer();
    registerEstonianTaxTools(server, makeApi([], accounts));

    const metadata = toolMetadataText(configs.get("create_owner_expense_reimbursement")!);
    expect(metadata).toContain("VAT rate as decimal");
    expect(metadata).toContain("NOT a percentage");
    expect(metadata).toContain("deductible_vat_amount");
    expect(metadata).not.toContain("restricted categories ask for confirmation");
  });

  it("rejects a non-positive net_amount instead of booking an empty/reversed journal", async () => {
    setup(false);
    const cb = tools.get("create_owner_expense_reimbursement")!;
    for (const net_amount of [0, -50]) {
      const result = await cb({
        owner_client_id: 1,
        effective_date: "2026-06-01",
        description: "Bad reimbursement",
        net_amount,
        vat_rate: 0,
        expense_account: 5000,
      });
      expect(isError(result)).toBe(true);
      expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("net_amount");
    }
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("rejects a negative vat_rate", async () => {
    setup(false);
    const cb = tools.get("create_owner_expense_reimbursement")!;
    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Bad VAT",
      net_amount: 100,
      vat_rate: -0.24,
      expense_account: 5000,
    });
    expect(isError(result)).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("vat_rate");
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

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

describe("check_tax_free_limits", () => {
  function getHandler() {
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, {} as ApiContext);
    return mock.tools.get("check_tax_free_limits") as ToolCallback;
  }

  it("computes representation and donation limits with 22/78 tax on the excess", async () => {
    const handler = getHandler();
    const payload = parseResult(await handler({
      as_of_date: "2026-06-16",
      ytd_social_taxed_payroll: 10000,
      months_elapsed: 6,
      ytd_representation_costs: 700,
      ytd_donations: 6000,
      prior_year_profit: 50000,
    }));

    expect(payload.cit_rate).toBe("22/78");
    const rep = payload.representation as Record<string, number>;
    expect(rep.limit).toBe(500);            // 50*6 + 2% of 10000
    expect(rep.excess).toBe(200);
    expect(rep.income_tax_on_excess).toBe(roundMoney(200 * 22 / 78)); // 56.41

    const don = payload.donations as Record<string, number>;
    expect(don.limit).toBe(5000);           // max(3% of 10000, 10% of 50000)
    expect(don.excess).toBe(1000);
    expect(don.income_tax_on_excess).toBe(roundMoney(1000 * 22 / 78));
  });

  it("omits a section when its inputs are not supplied and derives months from the date", async () => {
    const handler = getHandler();
    const payload = parseResult(await handler({
      as_of_date: "2025-03-31",
      ytd_social_taxed_payroll: 10000,
      ytd_representation_costs: 0,
    }));

    expect(payload.donations).toBeUndefined();
    const rep = payload.representation as Record<string, number>;
    expect(rep.limit).toBe(350); // months derived from "03" → 50*3 + 200
  });

  it("uses the 20/80 rate and the pre-2025 32 €/month allowance for pre-2025 dates", async () => {
    const handler = getHandler();
    const payload = parseResult(await handler({
      as_of_date: "2024-12-31",
      ytd_social_taxed_payroll: 10000,
      months_elapsed: 12,
      ytd_representation_costs: 1400, // 2024 limit = 32*12 + 0.02*10000 = 384 + 200 = 584 → excess 816
    }));

    expect(payload.cit_rate).toBe("20/80");
    expect(payload.note).toContain("20/80");
    expect(payload.note).not.toContain("22/78");
    const rep = payload.representation as Record<string, number>;
    expect(rep.limit).toBe(584); // 32 €/month, not the current 50 €
    expect(rep.income_tax_on_excess).toBe(roundMoney(816 * 20 / 80)); // 204
  });
});

describe("check_vat_registration_threshold", () => {
  function setup(options: Parameters<typeof makeApi>[2] = {}) {
    const mock = makeMockServer();
    const api = makeApi([], makeStandardAccounts(), options);
    registerEstonianTaxTools(mock.server, api);
    return {
      api,
      handler: mock.tools.get("check_vat_registration_threshold") as ToolCallback,
    };
  }

  function getHandler(options: Parameters<typeof makeApi>[2] = {}) {
    return setup(options).handler;
  }

  it("breaks out taxable, real-estate, insurance, and financial turnover so the operator can judge incidental exclusions", async () => {
    const { api, handler } = setup({
      vatRegistered: false,
      saleInvoices: [
        makeSaleInvoice({ id: 1, journal_date: "2026-01-15", base_net_price: 18000, net_price: 18000, base_gross_price: 21960, gross_price: 21960 }),
        makeSaleInvoice({ id: 2, journal_date: "2026-02-15", base_net_price: 9000, net_price: 9000, base_gross_price: 10980, gross_price: 10980 }),
        makeSaleInvoice({ id: 3, journal_date: "2026-03-15", base_gross_price: 5000, gross_price: 5000, status: "PROJECT" }),
        makeSaleInvoice({ id: 4, journal_date: "2025-12-31", base_gross_price: 100000, gross_price: 100000 }),
      ],
    });

    const payload = parseResult(await handler({
      year: 2026,
      financial_turnover: 16000,
      insurance_turnover: 2000,
      real_estate_turnover: 5000,
      exempt_social_turnover: 8000,
      incidental_excluded_turnover: 3000,
      taxable_turnover_adjustment: -1000,
    }));

    expect(api.saleInvoices.listAll).toHaveBeenCalledWith({
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      status: "CONFIRMED",
    });
    expect(payload.vat_registered).toBe(false);
    expect(payload.threshold_eur).toBe(40000);
    expect(payload.sale_invoice_confirmed_turnover).toBe(27000);
    expect(payload.manual_bucket_source).toBe("outside_sale_invoices");
    expect(payload.sale_invoice_turnover_reclassified_to_manual_buckets).toBe(0);
    expect(payload.sale_invoice_ordinary_turnover_after_bucket_split).toBe(27000);
    expect(payload.taxable_turnover_adjustment).toBe(-1000);
    expect(payload.taxable_or_zero_rated_turnover).toBe(26000);
    expect(payload.count_if_not_incidental).toMatchObject({
      real_estate_turnover: 5000,
      insurance_turnover: 2000,
      financial_turnover: 16000,
    });
    expect(payload.not_counted).toMatchObject({
      exempt_social_turnover: 8000,
      incidental_excluded_turnover: 3000,
    });
    expect(payload.threshold_total_if_all_non_incidental).toBe(49000);
    expect(payload.status).toBe("needs_manual_review");
    expect(payload.manual_review_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("financial_turnover"),
      expect.stringContaining("real_estate_turnover"),
      expect.stringContaining("insurance_turnover"),
    ]));
    expect(String(payload.note)).toContain("not a hard legal decision");
    expect(String(payload.legal_basis)).toContain("EMTA");
  });

  it("does not double-count manual buckets that are already included in confirmed sale invoices", async () => {
    const handler = getHandler({
      vatRegistered: false,
      saleInvoices: [
        makeSaleInvoice({ id: 1, journal_date: "2026-01-15", base_net_price: 18000, base_gross_price: 21960, gross_price: 21960 }),
        makeSaleInvoice({ id: 2, journal_date: "2026-02-15", base_net_price: 9000, base_gross_price: 10980, gross_price: 10980 }),
      ],
    });

    const payload = parseResult(await handler({
      year: 2026,
      financial_turnover: 16000,
      manual_bucket_source: "included_in_sale_invoices",
    }));

    expect(payload.sale_invoice_confirmed_turnover).toBe(27000);
    expect(payload.sale_invoice_turnover_reclassified_to_manual_buckets).toBe(16000);
    expect(payload.sale_invoice_ordinary_turnover_after_bucket_split).toBe(11000);
    expect(payload.taxable_or_zero_rated_turnover).toBe(11000);
    expect(payload.count_if_not_incidental.financial_turnover).toBe(16000);
    expect(payload.threshold_total_if_all_non_incidental).toBe(27000);
    expect(payload.status).toBe("ok");
  });

  it("reports exceeded when confirmed sales alone cross the registration threshold", async () => {
    const handler = getHandler({
      vatRegistered: false,
      saleInvoices: [
        makeSaleInvoice({ id: 1, journal_date: "2026-01-15", base_gross_price: 25000, gross_price: 25000 }),
        makeSaleInvoice({ id: 2, journal_date: "2026-02-15", base_gross_price: 17000, gross_price: 17000 }),
      ],
    });

    const payload = parseResult(await handler({ year: 2026 }));

    expect(payload.taxable_or_zero_rated_turnover).toBe(42000);
    expect(payload.threshold_total_if_all_non_incidental).toBe(42000);
    expect(payload.status).toBe("exceeded");
    expect(payload.excess_if_all_non_incidental).toBe(2000);
    expect(payload.suggested_action).toContain("registreerimiskohustus");
  });

  it("stays ok for already VAT-registered companies while still returning the turnover breakdown", async () => {
    const handler = getHandler({
      vatRegistered: true,
      saleInvoices: [
        makeSaleInvoice({ id: 1, journal_date: "2026-01-15", base_gross_price: 100000, gross_price: 100000 }),
      ],
    });

    const payload = parseResult(await handler({ year: 2026, financial_turnover: 50000 }));

    expect(payload.vat_registered).toBe(true);
    expect(payload.status).toBe("already_registered");
    expect(payload.threshold_total_if_all_non_incidental).toBe(150000);
  });
});
