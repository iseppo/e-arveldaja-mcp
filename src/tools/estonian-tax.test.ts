import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Account, Journal, SaleInvoice } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { registerEstonianTaxTools as registerEstonianTaxToolsImpl, bookOwnerExpenseReimbursement, type DividendPackagePayload } from "./estonian-tax.js";
import { roundMoney } from "../money.js";
import { parseMcpResponse, parseToolPayload } from "../__fixtures__/mcp-response.js";
import { makeAccount, makePosting, makeJournal } from "../__fixtures__/accounting.js";
import { ESTONIAN_VAT_METADATA, vatSourceById } from "../estonian-tax-rules.js";
import { resetAccountingRulesCache } from "../accounting-rules.js";
import { toolMetadataText } from "../__fixtures__/tool-metadata.js";

const { mockedLogAudit } = vi.hoisted(() => ({ mockedLogAudit: vi.fn() }));
// API-only fixture: the values below become normalized rows returned by the mock server.
let apiOpeningFixture: Journal | null = null;
function resetApiOpening() { apiOpeningFixture = null; }
beforeEach(resetApiOpening);
function seedApiOpening(data: { openingDate: string; accounts: Array<{ code: string; debit: number; credit: number; [key: string]: unknown }>; [key: string]: unknown }, _timestamp?: string) {
  apiOpeningFixture = {
    id: 88001, operation_type: "INITIAL", effective_date: data.openingDate,
    registered: true, is_deleted: false, clients_id: null,
    postings: data.accounts.flatMap(row => [
      ...(row.debit ? [{ accounts_id: Number(row.code), type: "D", amount: row.debit, base_amount: row.debit, accounts_dimensions_id: null }] : []),
      ...(row.credit ? [{ accounts_id: Number(row.code), type: "C", amount: row.credit, base_amount: row.credit, accounts_dimensions_id: null }] : []),
    ]) as Journal["postings"],
  };
}
function withApiOpening(journals: Journal[]): Journal[] {
  return apiOpeningFixture && !journals.some(j => j.operation_type === "INITIAL") ? [apiOpeningFixture, ...journals] : journals;
}

vi.mock("../audit-log.js", () => ({ logAudit: mockedLogAudit }));

// Standard chart of accounts used across tests
function makeStandardAccounts(): Account[] {
  return [
    // Assets
    makeAccount(1000, "D", "Varad", "Pangakonto", "Bank account"),
    // Liabilities — standard e-arveldaja chart numbers/names (resolvers match by name)
    makeAccount(2650, "C", "Kohustused", "Dividendivõlad", "Dividend payable"),
    makeAccount(2656, "C", "Kohustused", "Dividenditulumaksu võlg", "CIT payable"),
    makeAccount(2110, "C", "Kohustused", "Võlg omanikule", "Owner payable"),
    // Equity
    makeAccount(2900, "C", "Omakapital", "Osakapital või aktsiakapital nimiväärtuses", "Share capital"),
    makeAccount(2960, "C", "Omakapital", "Eelmiste perioodide jaotamata kasum (kahjum)", "Retained earnings"),
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

// The API each mock server was registered with, so the dividend wrapper below
// can read the fixture ledger without recording an extra API call.
const serverApi = new WeakMap<object, ApiContext>();
function registerEstonianTaxTools(server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, api: ApiContext): void {
  serverApi.set(server, api);
  registerEstonianTaxToolsImpl(server, api);
}

/**
 * Test-side figures for tests that are not about the approved-report anchor:
 * the "approved" report of the year before the dividend equals the books
 * (2960/2970/9000 + Tulud/Kulud, registered, up to that year end, plus a
 * registered opening dated on the next 1 January). Computed independently of
 * src/dividend-capacity.ts.
 */
async function booksAsApproved(api: ApiContext, effectiveDate: string): Promise<Record<string, number>> {
  const year = Number(effectiveDate.slice(0, 4)) - 1;
  const journalsImpl = vi.mocked(api.journals.listAllWithPostings).getMockImplementation();
  const accountsImpl = vi.mocked(api.readonly.getAccounts).getMockImplementation();
  const journals = (journalsImpl ? await journalsImpl() : []) as Journal[];
  const accounts = (accountsImpl ? await accountsImpl() : []) as Account[];
  const counted = new Set([2960, 2970, 9000, ...accounts.filter(a => a.account_type_est === "Tulud" || a.account_type_est === "Kulud").map(a => a.id)]);
  let cents = 0;
  for (const j of journals) {
    if (j.is_deleted || j.registered !== true) continue;
    const boundary = j.operation_type === "INITIAL" && j.effective_date === `${year + 1}-01-01`;
    if (j.effective_date > `${year}-12-31` && !boundary) continue;
    for (const p of j.postings ?? []) {
      if (p.is_deleted || !counted.has(p.accounts_id)) continue;
      const c = Math.round((p.base_amount ?? p.amount) * 100);
      cents += p.type === "C" ? c : p.type === "D" ? -c : 0;
    }
  }
  return { approved_report_year: year, approved_retained_earnings: cents / 100, approved_profit_for_year: 0 };
}

function makeMockServer() {
  const tools = new Map<string, ToolCallback>();
  const rawTools = new Map<string, ToolCallback>();
  const configs = new Map<string, { description?: string; inputSchema?: Record<string, unknown> }>();
  const server = {
    registerTool: vi.fn((name: string, config: unknown, callback: ToolCallback) => {
      configs.set(name, config as { description?: string; inputSchema?: Record<string, unknown> });
      rawTools.set(name, callback);
      // prepare_dividend_package previews by default (dry_run=true). These
      // tests exercise the approved execute path, so a call that does not set
      // dry_run explicitly runs with dry_run=false; the default itself is
      // pinned through rawTools below.
      // Calls that pass no approved-report figures get the books' own figures
      // (booksAsApproved); tests of the anchor itself pass them explicitly.
      tools.set(name, name === "prepare_dividend_package"
        ? (async (args: Record<string, unknown>, extra: unknown) => {
          const api = serverApi.get(server);
          const approved = !("approved_report_year" in args) && api && typeof args.effective_date === "string"
            ? await booksAsApproved(api, args.effective_date)
            : {};
          return (callback as (a: Record<string, unknown>, e: unknown) => unknown)({ dry_run: false, ...approved, ...args }, extra);
        }) as unknown as ToolCallback
        : callback);
    }),
  };
  return { server: server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, tools, rawTools, configs };
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
      getAccountDimensions: vi.fn(async () => []),
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
      listAllWithPostings: vi.fn(async () => withApiOpening(journals)),
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
        makePosting(2960, "C", 20000),
      ]),
      // Share capital
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(2900, "C", 2500),
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
    expect(calc.gross_dividend).toBe(12820.51);
    expect(roundMoney(calc.gross_dividend)).toBe(calc.gross_dividend);
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

  // 100 * 22/78 = 28.2051282... → 28.21; 1 * 22/78 = 0.28205... → 0.28
  it.each([
    [100, 28.21, 128.21],
    [1, 0.28, 1.28],
  ])("rounds CIT to cents for fractional result (%s EUR net)", async (net, cit, gross) => {
    const cb = tools.get("prepare_dividend_package")!;
    const result = await cb({
      net_dividend: net,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
    });

    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    const calc = data.calculation as { cit_amount: number; gross_dividend: number };
    expect(calc.cit_amount).toBe(cit);
    expect(calc.gross_dividend).toBe(gross);
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
    const retainedDebit = debitPostings.find(p => p.account === 2960);
    expect(retainedDebit?.amount).toBe(10000);
    const taxExpenseDebit = debitPostings.find(p => p.account === 8900);
    expect(taxExpenseDebit?.amount).toBe(2820.51);
    // Retained earnings must NOT be debited with the CIT — this is the exact
    // bug the net-dividend rule fixes (gross was previously drained from equity).
    expect(debitPostings.filter(p => p.account === 2960)).toHaveLength(1);
    // Net dividend credited to payable
    const creditDividend = je.postings.find(p => p.account === 2650);
    expect(creditDividend?.type).toBe("C");
    expect(creditDividend?.amount).toBe(10000);
    // CIT credited to tax payable
    const creditTax = je.postings.find(p => p.account === 2656);
    expect(creditTax?.type).toBe("C");
    expect(creditTax?.amount).toBe(2820.51);
    // Journal balances: total debits == total credits
    const totalDebit = debitPostings.reduce((s, p) => s + p.amount, 0);
    const totalCredit = je.postings.filter(p => p.type === "C").reduce((s, p) => s + p.amount, 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
    expect(totalDebit).toBeCloseTo(10000 + 2820.51, 2);
    // Booking summary is surfaced for operator verification
    const booking = data.booking as { retained_earnings_account: number; income_tax_expense_account: number; income_tax_expense_debit: number };
    expect(booking.retained_earnings_account).toBe(2960);
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
    const retainedDebit = je.postings.find(p => p.type === "D" && p.account === 2960);
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

  it("refuses (dividend_target_invalid) an override that points the CIT at a non-expense account, writing nothing", async () => {
    const cb = tools.get("prepare_dividend_package")!;
    for (const dry_run of [true, false]) {
      const result = await cb({
        net_dividend: 10000,
        shareholder_client_id: 1,
        effective_date: "2026-06-01",
        income_tax_expense_account: 2960,
        dry_run,
      });
      expect(isError(result)).toBe(true);
      const data = parseToolPayload<DividendPackagePayload>((result as { content: Array<{ text: string }> }).content[0]!.text);
      expect(data.error_code).toBe("dividend_target_invalid");
      expect(data.details!.join(" ")).toContain("'Tulumaks' line");
      expect(data.maximum_distributable).toBeUndefined();
    }
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
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
    const data = parseToolPayload<DividendPackagePayload>((result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(data.error_code).toBe("dividend_target_invalid");
    expect(data.details!.join(" ")).toContain("Income-tax expense account 8900 not found");
    expect(data.diagnostic).toMatchObject({ income_tax_expense_account: 8900 });
    expect(data.compliance_notes).toHaveLength(2);
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
      // The 2024 retained-earnings credit is after the 2023 report: lg 1 is 0.
      force: true,
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
        makePosting(2960, "C", 5000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(2900, "C", 2500),
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
        makePosting(2960, "C", 5000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(2900, "C", 2500),
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
        makePosting(2960, "C", 100),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 2500),
        makePosting(2900, "C", 2500),
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
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2960, "C", 20000)]),
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
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
      makeJournal("2024-01-01", [makePosting(1000, "D", 5000), makePosting(2960, "C", 5000)]),
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
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
    expect(dividendMeta).toContain("Eelmiste perioodide jaotamata kasum (kahjum)");
    expect(dividendMeta).toContain("Aruandeaasta kasum (kahjum)");
    expect(dividendMeta).toContain("never compute them");
    expect(dividendMeta).toContain("max_net_dividend");

    const limitsMeta = toolMetadataText(configs.get("check_tax_free_limits")!);
    expect(limitsMeta).toContain("50 €/month");
    expect(limitsMeta).toContain("22/78");

    const vatMeta = toolMetadataText(configs.get("check_vat_registration_threshold")!);
    expect(vatMeta).toContain("40 000 EUR");
    expect(vatMeta).toContain(ESTONIAN_VAT_METADATA.registration.scope_effective_from);
    expect(vatMeta).toContain(ESTONIAN_VAT_METADATA.verified_at);
    expect(vatMeta).toContain(vatSourceById("registration-threshold").url);
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
      a.id === 2900 ? makeAccount(2900, "C", "Omakapital", "Osakapital", "Share capital") : a
    );
    const journals = [
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(2900, "C", 5000),
      ]),
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 20000),
        makePosting(2960, "C", 20000),
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
      makeAccount(2940, "C", "Omakapital", "Kohustuslik reservkapital", "Reserve capital"),
    ];
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(2900, "C", 5000)]),   // share capital 5000
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2960, "C", 20000)]), // retained 20000
      makeJournal("2024-06-01", [makePosting(2940, "D", 3000), makePosting(1000, "C", 3000)]),   // reserve → −3000
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
      makeAccount(2940, "C", "Omakapital", "Kohustuslik reservkapital", "Reserve capital"),
      makeAccount(3011, "C", "Omakapital", "Muu reserv", "Other reserve"),
    ];
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(2900, "C", 5000)]),    // share capital 5000
      makeJournal("2024-01-01", [makePosting(1000, "D", 30000), makePosting(2960, "C", 30000)]),  // retained 30000
      makeJournal("2024-02-01", [makePosting(1000, "D", 3000), makePosting(2940, "C", 3000)]),    // reserve 3010 = +3000
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
      restricted_reserve_accounts: [2940, 3011],
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
      a.id === 2900 ? makeAccount(2900, "C", "Omakapital", "Osakapital", "Share capital") : a
    );
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 25000),
        makePosting(2960, "C", 25000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(2900, "C", 5000),
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
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(2900, "C", 5000)]),
      makeJournal("2023-02-01", [makePosting(1000, "D", 3000), makePosting(2940, "C", 3000)]),
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2960, "C", 20000)]),
      makeJournal("2026-03-01", [makePosting(5000, "D", 18000), makePosting(1000, "C", 18000)]),
    ];
  }
  function accountsWithReserveCapital(): Account[] {
    return [
      ...makeStandardAccounts().map(a =>
        a.id === 2900 ? makeAccount(2900, "C", "Omakapital", "Osakapital", "Share capital") : a
      ),
      makeAccount(2940, "C", "Omakapital", "Kohustuslik reservkapital", "Statutory reserve"),
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
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
      makeJournal("2023-02-01", [makePosting(1000, "D", 1000), makePosting(2940, "C", 1000)]),
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2960, "C", 20000)]),
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

  it("aggregates a funded-but-renamed 2940 into the §157(2) floor even when an empty legacy account owns the exact name", async () => {
    // Composed fallback hole (regression guard): an inactive legacy 2930 still
    // carries the exact statutory name "Kohustuslik reservkapital" with a ZERO
    // balance, while the funded reserve lives on 2940 that was RENAMED to a
    // synonym. Name-matching alone would resolve only [2930] and read a 0 reserve,
    // dropping the floor to bare share capital (5000) and letting this dividend
    // through. resolveRestrictedReserveAccounts always unions 2940 in, so the
    // +3000 reserve is read and the floor is 8000 → the distribution is BLOCKED.
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(2930, "C", "Omakapital", "Kohustuslik reservkapital", "Legacy statutory reserve", { is_valid: false }),
      makeAccount(2940, "C", "Omakapital", "Seadusjärgne reserv", "Statutory reserve (renamed)"),
    ];
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(2900, "C", 5000)]),   // share capital 5000
      makeJournal("2023-02-01", [makePosting(1000, "D", 3000), makePosting(2940, "C", 3000)]),   // reserve on the renamed 2940 = +3000
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2960, "C", 20000)]), // retained 20000
      makeJournal("2026-03-01", [makePosting(5000, "D", 18000), makePosting(1000, "C", 18000)]), // current-year loss
    ];
    // net_assets_before = equity (5000+3000+20000) + P&L (−18000) = 10000
    // net_dividend 2000 → gross 2564.10 → net_assets_after = 7435.90
    //   floor with reserve = 8000 → 7435.90 < 8000 → BLOCKED (would pass at the 5000 bare-share floor)
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({ net_dividend: 2000, shareholder_client_id: 1, effective_date: "2026-06-01" });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("ÄS § 157 net assets breach");
    const netCheck = data.net_assets_check as {
      share_capital: number; restricted_reserves: number; minimum_net_assets: number;
      net_assets_after_distribution: number; shortfall: number;
    };
    expect(netCheck.share_capital).toBe(5000);
    expect(netCheck.restricted_reserves).toBe(3000); // the renamed 2940 balance, not the empty legacy 2930
    expect(netCheck.minimum_net_assets).toBe(8000);
    expect(netCheck.net_assets_after_distribution).toBe(7435.9);
    expect(netCheck.shortfall).toBe(564.1);
  });

  it("aggregates TWO funded auto-detected reserve accounts into the §157(2) floor (no override)", async () => {
    // Both 2940 and 2941 carry the exact statutory name and a positive balance,
    // with NO explicit restricted_reserve_accounts override. The floor must sum
    // both auto-detected balances (2000 + 1000 = 3000), not just one.
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(2940, "C", "Omakapital", "Kohustuslik reservkapital", "Statutory reserve A"),
      makeAccount(2941, "C", "Omakapital", "Kohustuslik reservkapital", "Statutory reserve B"),
    ];
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(2900, "C", 5000)]),   // share capital 5000
      makeJournal("2023-02-01", [makePosting(1000, "D", 2000), makePosting(2940, "C", 2000)]),   // reserve A = +2000
      makeJournal("2023-03-01", [makePosting(1000, "D", 1000), makePosting(2941, "C", 1000)]),   // reserve B = +1000
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2960, "C", 20000)]), // retained 20000
      makeJournal("2026-03-01", [makePosting(5000, "D", 18000), makePosting(1000, "C", 18000)]), // current-year loss
    ];
    // net_assets_before = equity (5000+2000+1000+20000) + P&L (−18000) = 10000
    // net_dividend 2000 → gross 2564.10 → net_assets_after 7435.90; floor 8000 → BLOCKED
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const result = await cb({ net_dividend: 2000, shareholder_client_id: 1, effective_date: "2026-06-01" });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("ÄS § 157 net assets breach");
    const netCheck = data.net_assets_check as { restricted_reserves: number; minimum_net_assets: number; shortfall: number };
    expect(netCheck.restricted_reserves).toBe(3000); // 2000 + 1000, both auto-detected
    expect(netCheck.minimum_net_assets).toBe(8000);
    expect(netCheck.shortfall).toBe(564.1);
  });

  it("surfaces the opening-balance API limitation when share capital or retained earnings reads as zero", async () => {
    // Retained earnings present but no share-capital postings — the classic
    // symptom of opening balances entered as "Algbilansi kanded" that the
    // /journals API omits, so the § 157 check runs on incomplete data. Warn
    // (don't block): the operator verifies opening balances in the UI.
    const journals = [
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2960, "C", 20000)]),
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
    expect(warnings).toEqual([]);
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
      makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(2900, "C", 5000)]),
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
    expect(warnings).toEqual([]);
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Account validation
  // -------------------------------------------------------------------------

  it("returns error when a required account is missing from chart of accounts", async () => {
    const accountsWithoutTaxAccount = makeStandardAccounts().filter(a => a.id !== 2656);
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
    const data = parseToolPayload<DividendPackagePayload>((result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(data.error_code).toBe("dividend_target_invalid");
    expect(data.details!.join(" ")).toContain("Tax payable account 2656 not found");
    expect(data.diagnostic).toMatchObject({ tax_payable_account: 2656 });
    expect(data.compliance_notes).toHaveLength(2);
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Custom account overrides
  // -------------------------------------------------------------------------

  it("uses custom liability accounts and a retained target that is a real result account", async () => {
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(2970, "C", "Omakapital", "Aruandeaasta kasum (kahjum)", "Current year profit"),
      makeAccount(2380, "C", "Kohustused", "Dividendid 2", "Dividend payable 2"),
      makeAccount(2541, "C", "Kohustused", "Tulumaks 2", "CIT payable 2"),
    ];
    const journals = [
      makeJournal("2024-01-01", [makePosting(1000, "D", 20000), makePosting(2970, "C", 20000)]),
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
    ];
    api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const result = await mock.tools.get("prepare_dividend_package")!({
      net_dividend: 1000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      retained_earnings_account: 2970,
      dividend_payable_account: 2380,
      tax_payable_account: 2541,
    });
    expect(isError(result)).toBe(false);
    const data = parseResult(result);
    expect((data.retained_earnings_check as { account: number }).account).toBe(2970);
    const created = vi.mocked(api.journals.create).mock.calls[0]![0] as { postings: Array<{ accounts_id: number; type: string }> };
    expect(created.postings.map(p => `${p.accounts_id}${p.type}`).sort()).toEqual(["2380C", "2541C", "2970D", "8900D"]);
  });

  it.each([
    { name: "an empty voluntary reserve as retained target", override: { retained_earnings_account: 2950 }, text: "not a retained-earnings or result account" },
    { name: "an unrelated empty account as share capital", override: { share_capital_account: 3001 }, text: "not the share-capital account" },
    { name: "a liability as retained target", override: { retained_earnings_account: 2110 }, text: "not a retained-earnings or result account" },
    { name: "an equity account as dividend payable", override: { dividend_payable_account: 2950 }, text: "not a liability" },
    { name: "one account in two roles", override: { tax_payable_account: 2650 }, text: "used both as dividend payable and as tax payable" },
    { name: "a Kulud account outside 8900–8999 as CIT expense", override: { income_tax_expense_account: 5000 }, text: "'Tulumaks' line" },
  ])("refuses $name (dividend_target_invalid) on preview and create, writing nothing", async ({ override, text }) => {
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(2950, "C", "Omakapital", "Vabatahtlik reservkapital", "Voluntary reserve"),
      makeAccount(3001, "C", "Omakapital", "Osakapital 2", "Share capital 2"),
    ];
    api = makeApi(makeHealthyJournals(), accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    for (const dry_run of [true, false]) {
      for (const force of [false, true]) {
        const result = await mock.tools.get("prepare_dividend_package")!({
          net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01", dry_run, force, ...override,
        });
        expect(isError(result)).toBe(true);
        const data = parseToolPayload<DividendPackagePayload>((result as { content: Array<{ text: string }> }).content[0]!.text);
        expect(data.error_code).toBe("dividend_target_invalid");
        expect(data.details!.join(" ")).toContain(text);
        expect(data.compliance_notes).toHaveLength(2);
      }
    }
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("refuses an INACTIVE retained-earnings override as a posting target", async () => {
    const accounts = [...makeStandardAccounts(), makeAccount(2961, "C", "Omakapital", "Jaotamata kasum", "Old retained", { is_valid: false })];
    api = makeApi(makeHealthyJournals(), accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const result = await mock.tools.get("prepare_dividend_package")!({
      net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01", retained_earnings_account: 2961,
    });
    expect(isError(result)).toBe(true);
    const data = parseToolPayload<DividendPackagePayload>((result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(data.error_code).toBe("dividend_target_invalid");
    expect(data.details!.join(" ")).toContain("is inactive");
    expect(data.diagnostic).toMatchObject({ retained_earnings_account: 2961 });
    expect(data.compliance_notes).toHaveLength(2);
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

  it("refuses a missing or inactive dividend-payable override with the same structured refusal, on preview and create", async () => {
    const accounts = [...makeStandardAccounts(), makeAccount(2651, "C", "Kohustused", "Vana dividendivõlg", "Old payable", { is_valid: false })];
    api = makeApi(makeHealthyJournals(), accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    for (const [account, text] of [[2651, "is inactive"], [2659, "not found"]] as const) {
      for (const dry_run of [true, false]) {
        for (const force of [false, true]) {
          const result = await mock.tools.get("prepare_dividend_package")!({
            net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01", dividend_payable_account: account, dry_run, force,
          });
          expect(isError(result)).toBe(true);
          const data = parseToolPayload<DividendPackagePayload>((result as { content: Array<{ text: string }> }).content[0]!.text);
          expect(data.error_code).toBe("dividend_target_invalid");
          expect(data.details!.join(" ")).toContain(`Dividend payable account ${account}`);
          expect(data.details!.join(" ")).toContain(text);
          expect(data.diagnostic).toMatchObject({ dividend_payable_account: account });
        }
      }
    }
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
  });

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
        makePosting(2960, "C", 30000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(2900, "C", 5000),
      ]),
      // Partially-deleted journal: D side of cash stays, C side of equity is deleted.
      // Result: assets = 30000 + 5000 + 100 = 35100; equity + P&L = 30000 + 5000 = 35000.
      makeJournal("2024-06-01", [
        makePosting(1000, "D", 100),
        makePosting(2960, "C", 100, undefined, { is_deleted: true }),
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

  it("ledger-imbalance block is NOT overridable with force=true (force only overrides the § 157 clauses)", async () => {
    const journals = [
      makeJournal("2024-01-01", [
        makePosting(1000, "D", 30000),
        makePosting(2960, "C", 30000),
      ]),
      makeJournal("2023-01-01", [
        makePosting(1000, "D", 5000),
        makePosting(2900, "C", 5000),
      ]),
      makeJournal("2024-06-01", [
        makePosting(1000, "D", 100),
        makePosting(2960, "C", 100, undefined, { is_deleted: true }),
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
    });

    expect(isError(result)).toBe(true);
    const data = parseResult(result);
    expect(String(data.error)).toContain("Ledger is imbalanced");
    expect(String(data.hint)).toContain("force=true does not override");
    const warnings = (data.warnings ?? []) as string[];
    expect(warnings.some(w => w.includes("Ledger imbalance"))).toBe(true);
    expect(vi.mocked(api2.journals.create)).not.toHaveBeenCalled();
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
    expect(byAccount(2960)).toEqual({ accounts_id: 2960, type: "D", amount: 10000 });
    expect(byAccount(8900)).toEqual({ accounts_id: 8900, type: "D", amount: 2820.51 });
    // NET dividend credited to payable (2370); CIT credited to tax payable (2540).
    expect(byAccount(2650)).toEqual({ accounts_id: 2650, type: "C", amount: 10000 });
    expect(byAccount(2656)).toEqual({ accounts_id: 2656, type: "C", amount: 2820.51 });
    // Retained earnings is debited exactly once — the gross was never drained.
    expect(booked.postings.filter(p => p.accounts_id === 2960)).toHaveLength(1);
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

  it("previews by default: omitting dry_run creates no journal", async () => {
    const rawMock = makeMockServer();
    registerEstonianTaxTools(rawMock.server, api);
    const cb = rawMock.rawTools.get("prepare_dividend_package")!;
    const result = await (cb as (a: Record<string, unknown>) => Promise<unknown>)({
      net_dividend: 10000,
      shareholder_client_id: 1,
      effective_date: "2026-06-01",
      approved_report_year: 2025,
      approved_retained_earnings: 20000,
      approved_profit_for_year: 0,
    });
    expect(isError(result as never)).toBe(false);
    expect(parseResult(result as never).dry_run).toBe(true);
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
    const retainedDebit = booked.postings.find(p => p.accounts_id === 2960 && p.type === "D");
    expect(retainedDebit?.amount).toBe(100.01);
    // Debits balance credits exactly, and the reported gross is that same total.
    const debits = roundMoney(booked.postings.filter(p => p.type === "D").reduce((s, p) => s + p.amount, 0));
    const credits = roundMoney(booked.postings.filter(p => p.type === "C").reduce((s, p) => s + p.amount, 0));
    expect(debits).toBe(credits);
    expect(calc.gross_dividend).toBe(debits);
  });

  // -------------------------------------------------------------------------
  // Opening-balance folding — a captured algbilanss feeds both § 157 checks
  // -------------------------------------------------------------------------

  describe("opening-balance folding", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ob-estonian-tax-"));
      process.env.EARVELDAJA_RULES_DIR = dir;
      resetApiOpening();
    });

    afterEach(() => {
      delete process.env.EARVELDAJA_RULES_DIR;
      resetApiOpening();
      rmSync(dir, { recursive: true, force: true });
    });

    it("uses API retained earnings once", async () => {
      const accounts = [...makeStandardAccounts(), makeAccount(4000, "C", "Tulud", "Müügitulu", "Sales revenue")];
      const journals = [
        makeJournal("2022-01-01", [makePosting(1000, "D", 5000), makePosting(2960, "C", 5000)], { id: 800, operation_type: "INITIAL" }),
        makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
        makeJournal("2024-01-01", [makePosting(1000, "D", 1000), makePosting(2960, "C", 1000)]),
        makeJournal("2026-02-01", [makePosting(1000, "D", 20000), makePosting(4000, "C", 20000)]),
      ];
      const fixture = makeMockServer();
      registerEstonianTaxTools(fixture.server, makeApi(journals, accounts));
      const result = await fixture.tools.get("prepare_dividend_package")!({ net_dividend: 3000, shareholder_client_id: 1, effective_date: "2026-06-01" });
      expect(isError(result)).toBe(false);
      expect(parseResult(result).retained_earnings_check).toMatchObject({ balance_before: 6000, sufficient: true });
    });

    it("raising retained earnings via a captured opening balance flips a § 157 lg1 FAIL to PASS", async () => {
      const accounts = [
        ...makeStandardAccounts(),
        makeAccount(4000, "C", "Tulud", "Müügitulu", "Sales revenue"),
      ];
      // Ledger-only: retained earnings 1 000, share capital 2 500, plus a
      // 20 000 revenue cushion so net assets is never the binding constraint
      // — isolates the lg1 (retained-earnings) check for this flip.
      const journals = [
        makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
        makeJournal("2024-01-01", [makePosting(1000, "D", 1000), makePosting(2960, "C", 1000)]),
        makeJournal("2026-02-01", [makePosting(1000, "D", 20000), makePosting(4000, "C", 20000)]),
      ];

      // 1) Without an INITIAL: net dividend 3 000 exceeds the 1 000
      //    ledger-only retained earnings — blocked (lg1).
      const apiBefore = makeApi(journals, accounts);
      const before = makeMockServer();
      registerEstonianTaxTools(before.server, apiBefore);
      const resultBefore = await before.tools.get("prepare_dividend_package")!({
        net_dividend: 3000,
        shareholder_client_id: 1,
        effective_date: "2026-06-01",
      });
      expect(isError(resultBefore)).toBe(true);
      const dataBefore = parseResult(resultBefore);
      expect((resultBefore as { content: Array<{ text: string }> }).content[0].text)
        .toContain("Insufficient retained earnings");
      const checkBefore = dataBefore.retained_earnings_check as { balance: number; shortfall: number };
      expect(checkBefore.balance).toBe(1000);
      expect(checkBefore.shortfall).toBe(2000);
      const warningsBefore = (dataBefore.warnings ?? []) as string[];
      expect(warningsBefore).toEqual([]);

      // 2) An API INITIAL (dated before the ledger) adds 5 000 credit to
      //    retained earnings — 1 000 + 5 000 = 6 000 ≥ 3 000, now sufficient.
      seedApiOpening(
        {
          openingDate: "2022-01-01",
          accounts: [
            { code: "1000", name: "Pangakonto", debit: 5000, credit: 0 },
            { code: "2960", name: "Retained earnings", debit: 0, credit: 5000 },
          ],
          totals: { debit: 5000, credit: 5000 },
          rawText: "n/a",
        },
        "2022-01-01T00:00:00.000Z",
      );

      const apiAfter = makeApi(journals, accounts);
      const after = makeMockServer();
      registerEstonianTaxTools(after.server, apiAfter);
      const resultAfter = await after.tools.get("prepare_dividend_package")!({
        net_dividend: 3000,
        shareholder_client_id: 1,
        effective_date: "2026-06-01",
      });

      expect(isError(resultAfter)).toBe(false);
      const dataAfter = parseResult(resultAfter);
      const checkAfter = dataAfter.retained_earnings_check as { balance_before: number; sufficient: boolean };
      expect(checkAfter.balance_before).toBe(6000);
      expect(checkAfter.sufficient).toBe(true);
      const warningsAfter = (dataAfter.warnings ?? []) as string[];
      expect(warningsAfter).toEqual(
        expect.arrayContaining([expect.stringContaining("Opening balances applied from API INITIAL")]),
      );
    });

    it("lowering net assets via a captured opening balance flips a § 157 lg2 PASS to BLOCK", async () => {
      const accounts = [
        ...makeStandardAccounts(),
        makeAccount(2500, "C", "Kohustused", "Muu kohustus", "Other liability"),
      ];
      // Ledger-only: share capital 5 000, retained earnings 5 000 — a 3 000
      // net dividend clears both § 157 clauses comfortably.
      const journals = [
        makeJournal("2023-01-01", [makePosting(1000, "D", 5000), makePosting(2900, "C", 5000)]),
        makeJournal("2024-01-01", [makePosting(1000, "D", 5000), makePosting(2960, "C", 5000)]),
      ];

      // 1) Without an INITIAL: passes both clauses.
      const apiBefore = makeApi(journals, accounts);
      const before = makeMockServer();
      registerEstonianTaxTools(before.server, apiBefore);
      const resultBefore = await before.tools.get("prepare_dividend_package")!({
        net_dividend: 3000,
        shareholder_client_id: 1,
        effective_date: "2026-06-01",
      });
      expect(isError(resultBefore)).toBe(false);
      const dataBefore = parseResult(resultBefore);
      const netCheckBefore = dataBefore.net_assets_check as { sufficient: boolean };
      expect(netCheckBefore.sufficient).toBe(true);

      // 2) An API INITIAL (dated before the ledger) reveals a 2 000
      //    expense/liability pair that wasn't previously booked — net assets
      //    drop by 2 000 (10 000 → 8 000), pushing the post-distribution
      //    figure (8 000 − 3 846.15 = 4 153.85) below the 5 000 share-capital
      //    floor. Retained earnings (2 000) is untouched, so lg1 stays clear —
      //    isolating the lg2 (net-assets) flip.
      seedApiOpening(
        {
          openingDate: "2022-01-01",
          accounts: [
            { code: "5000", name: "Kulud", debit: 2000, credit: 0 },
            { code: "2500", name: "Muu kohustus", debit: 0, credit: 2000 },
          ],
          totals: { debit: 2000, credit: 2000 },
          rawText: "n/a",
        },
        "2022-01-01T00:00:00.000Z",
      );

      const apiAfter = makeApi(journals, accounts);
      const after = makeMockServer();
      registerEstonianTaxTools(after.server, apiAfter);
      const resultAfter = await after.tools.get("prepare_dividend_package")!({
        net_dividend: 3000,
        shareholder_client_id: 1,
        effective_date: "2026-06-01",
      });

      expect(isError(resultAfter)).toBe(true);
      expect((resultAfter as { content: Array<{ text: string }> }).content[0].text)
        .toContain("ÄS § 157 net assets breach");
      const dataAfter = parseResult(resultAfter);
      const netCheckAfter = dataAfter.net_assets_check as {
        net_assets_before_distribution: number;
        net_assets_after_distribution: number;
        minimum_net_assets: number;
        shortfall: number;
      };
      expect(netCheckAfter.net_assets_before_distribution).toBe(8000);
      expect(netCheckAfter.minimum_net_assets).toBe(5000);
      expect(netCheckAfter.net_assets_after_distribution).toBeLessThan(netCheckAfter.minimum_net_assets);
      // lg1 stays clear — this is a pure lg2 flip. toolError only echoes
      // retained_earnings_check when the lg1 shortfall itself is a violation,
      // so its absence plus the exact single-clause violation message is the
      // isolation proof here.
      expect(dataAfter.retained_earnings_check).toBeUndefined();
      expect(dataAfter.error).toBe("ÄS § 157 net assets breach");
      const warningsAfter = (dataAfter.warnings ?? []) as string[];
      expect(warningsAfter).toEqual(
        expect.arrayContaining([expect.stringContaining("Opening balances applied from API INITIAL")]),
      );
    });
  });

  it("serializes concurrent executions so two distributions cannot spend the same § 157 headroom", async () => {
    // Distributable profit 500 EUR; two different shareholders each request 400 EUR net at once.
    const store: Journal[] = [
      { ...makeJournal("2024-01-01", [makePosting(1000, "D", 500), makePosting(2960, "C", 500)]), id: 1, registered: true },
      { ...makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]), id: 2, registered: true },
      // Current-year profit: lifts net assets clear of the lg 2 floor, but is not lg 1 distributable.
      { ...makeJournal("2026-03-01", [makePosting(1000, "D", 1000), makePosting(3000, "C", 1000)]), id: 3, registered: true },
    ];
    let nextId = 100;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    const sharedApi = makeApi([], [...makeStandardAccounts(), makeAccount(3000, "C", "Tulud", "Müük", "Sales")]);
    const snapshot = async () => { await tick(); return store.map((journal) => ({ ...journal })); };
    Object.assign(sharedApi.journals, {
      connectionFingerprint: "estonian-tax-concurrent-headroom",
      listAll: vi.fn(snapshot),
      listAllWithPostings: vi.fn(snapshot),
      get: vi.fn(async (id: number) => store.find((journal) => journal.id === id)),
      create: vi.fn(async (data: Partial<Journal>) => {
        await tick();
        const id = nextId++;
        store.push({ ...data, id, registered: false, is_deleted: false } as Journal);
        return { code: 200, created_object_id: id, messages: [] };
      }),
    });
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, sharedApi);
    const cb = mock.tools.get("prepare_dividend_package")!;
    const results = await Promise.all([1, 2].map((shareholder) =>
      cb({ net_dividend: 400, shareholder_client_id: shareholder, effective_date: "2026-06-01" })));
    expect(results.filter((result) => !isError(result))).toHaveLength(1);
    const loser = results.find((result) => isError(result))! as { content: Array<{ text: string }> };
    expect(loser.content[0]!.text.toLowerCase()).toContain("insufficient retained earnings");
    expect(store.filter((journal) => String(journal.document_number ?? "").startsWith("DIV-"))).toHaveLength(1);
  });

  it("serializes concurrent executions for one company even through two different API keys (connection fingerprints)", async () => {
    // Same ledger as above, reached by two processes with different credentials.
    const store: Journal[] = [
      { ...makeJournal("2024-01-01", [makePosting(1000, "D", 500), makePosting(2960, "C", 500)]), id: 1, registered: true },
      { ...makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]), id: 2, registered: true },
      { ...makeJournal("2026-03-01", [makePosting(1000, "D", 1000), makePosting(3000, "C", 1000)]), id: 3, registered: true },
    ];
    let nextId = 100;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = async () => { await tick(); return store.map((journal) => ({ ...journal })); };
    const callbacks = ["key-a-fingerprint", "key-b-fingerprint"].map((fingerprint) => {
      const api = makeApi([], [...makeStandardAccounts(), makeAccount(3000, "C", "Tulud", "Müük", "Sales")]);
      Object.assign(api.readonly, {
        getVatInfo: vi.fn(async () => ({ vat_number: null, tax_refnumber: "9000123456" })),
      });
      Object.assign(api.journals, {
        connectionFingerprint: `estonian-tax-shared-ledger-${fingerprint}`,
        apiBaseUrl: "https://rmp-api.rik.ee/v1",
        listAll: vi.fn(snapshot),
        listAllWithPostings: vi.fn(snapshot),
        get: vi.fn(async (id: number) => store.find((journal) => journal.id === id)),
        create: vi.fn(async (data: Partial<Journal>) => {
          await tick();
          const id = nextId++;
          store.push({ ...data, id, registered: false, is_deleted: false } as Journal);
          return { code: 200, created_object_id: id, messages: [] };
        }),
      });
      const mock = makeMockServer();
      registerEstonianTaxTools(mock.server, api);
      return mock.tools.get("prepare_dividend_package")!;
    });
    const results = await Promise.all(callbacks.map((cb, index) =>
      cb({ net_dividend: 400, shareholder_client_id: index + 1, effective_date: "2026-06-01" })));
    expect(results.filter((result) => !isError(result))).toHaveLength(1);
    const loser = results.find((result) => isError(result))! as { content: Array<{ text: string }> };
    expect(loser.content[0]!.text.toLowerCase()).toContain("insufficient retained earnings");
    expect(store.filter((journal) => String(journal.document_number ?? "").startsWith("DIV-"))).toHaveLength(1);
  });

  it("refuses a booking execute (fail closed) when the company identity for the lock cannot be read; dry runs are unaffected", async () => {
    const api = makeApi([
      makeJournal("2024-01-01", [makePosting(1000, "D", 5000), makePosting(2960, "C", 5000)]),
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
    ], makeStandardAccounts());
    Object.assign(api.readonly, {
      getVatInfo: vi.fn().mockRejectedValue(Object.assign(new Error("HTTP 503"), { status: 503 })),
    });
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;

    const refused = await cb({ net_dividend: 400, shareholder_client_id: 1, effective_date: "2026-06-01", dry_run: false }) as { content: Array<{ text: string }> };
    expect(isError(refused)).toBe(true);
    expect(refused.content[0]!.text).toContain("Could not determine company identity for the booking lock; retry");
    expect(api.journals.create).not.toHaveBeenCalled();

    const preview = await cb({ net_dividend: 400, shareholder_client_id: 1, effective_date: "2026-06-01", dry_run: true });
    expect(isError(preview)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: create_owner_expense_reimbursement
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// prepare_dividend_package — pending drafts (M1), key conflicts (M2),
// lg 1 distributable profit components (M3), and minors
// ---------------------------------------------------------------------------

describe("prepare_dividend_package remediation", () => {
  beforeEach(() => {
    mockedLogAudit.mockClear();
  });

  function setup(journals: Journal[], accounts: Account[] = makeStandardAccounts(), options: { clientName?: string } = {}) {
    const api = makeApi(journals, accounts, options);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    return { api, cb: mock.tools.get("prepare_dividend_package")! };
  }

  const base = (retained: number): Journal[] => [
    makeJournal("2024-01-01", [makePosting(1000, "D", retained), makePosting(2960, "C", retained)]),
    makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)]),
  ];

  // The unconfirmed journal prepare_dividend_package itself creates (confirm:false).
  const dividendDraft = (id: number, date: string, clientId: number, net: number, cit: number, registered = false): Journal =>
    makeJournal(date, [
      makePosting(2960, "D", net),
      makePosting(8900, "D", cit),
      makePosting(2650, "C", net),
      makePosting(2656, "C", cit),
    ], { id, registered, is_deleted: false, document_number: `DIV-${date}-${clientId}` });

  // ---- M2: same key, different amount → conflict; same → echo existing ----

  it("M2 refuses a same-key call with a different amount (dividend_key_conflict), on execute and on dry_run", async () => {
    const { api, cb } = setup([...base(100000), dividendDraft(501, "2026-06-01", 1, 1000, 282.05)]);
    for (const dry_run of [false, true]) {
      const result = await cb({ net_dividend: 2000, shareholder_client_id: 1, effective_date: "2026-06-01", dry_run });
      expect(isError(result)).toBe(true);
      const data = parseResult(result);
      expect(data.error_code).toBe("dividend_key_conflict");
      expect(data.existing_journal_id).toBe(501);
      expect(data.compliance_notes).toEqual([expect.stringContaining("ÄS § 157 lg 1"), expect.stringContaining("TSD lisal 7")]);
      const existing = data.existing_postings as Array<{ account: number; type: string; amount: number }>;
      const requested = data.requested_postings as Array<{ account: number; type: string; amount: number }>;
      expect(existing.find(p => p.account === 2960)?.amount).toBe(1000);
      expect(requested.find(p => p.account === 2960)?.amount).toBe(2000);
    }
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  it("M2 detects a key collision that appears after the pre-check (guard duplicate) and reports the conflict instead of 'duplicate'", async () => {
    const { api, cb } = setup(base(100000));
    const first = await cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01" });
    expect(isError(first)).toBe(false);
    const second = await cb({ net_dividend: 2000, shareholder_client_id: 1, effective_date: "2026-06-01" });
    expect(isError(second)).toBe(true);
    const data = parseResult(second);
    expect(data.error_code).toBe("dividend_key_conflict");
    expect(data.compliance_notes).toEqual([expect.stringContaining("ÄS § 157 lg 1"), expect.stringContaining("TSD lisal 7")]);
    expect((data.existing_postings as Array<{ account: number; amount: number }>).find(p => p.account === 2650)?.amount).toBe(1000);
    expect(vi.mocked(api.journals.create)).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledTimes(1); // only the original CREATED
  });

  it("M2 echoes the EXISTING journal's postings on an identical retry (guard duplicate path)", async () => {
    const { cb } = setup(base(100000));
    await cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01" });
    const data = parseResult(await cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01" }));
    const je = data.journal_entry as { booking_status: string; postings: Array<{ account: number; type: string; amount: number }> };
    expect(je.booking_status).toBe("duplicate");
    expect(je.postings.map(p => `${p.account}${p.type}${p.amount}`).sort()).toEqual(["2650C1000", "2656C282.05", "2960D1000", "8900D282.05"]);
    const audit = mockedLogAudit.mock.calls[1]![0] as { details: { postings: unknown[] } };
    expect(audit.details.postings).toHaveLength(4);
  });

  it("M2 echoes the existing journal's ACTUAL postings (as stored, e.g. reordered) on both duplicate paths", async () => {
    // Pre-check path: the stored same-key journal lists its postings in a different order.
    const stored = dividendDraft(501, "2026-06-01", 1, 1000, 282.05);
    stored.postings = [...stored.postings].reverse();
    const pre = setup([...base(100000), stored]);
    const preData = parseResult(await pre.cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01" }));
    expect((preData.journal_entry as { postings: Array<{ account: number }> }).postings.map(p => p.account)).toEqual([2656, 2650, 8900, 2960]);

    // Guard-duplicate path: the journal fetched by id stores its postings reordered.
    const { api, cb } = setup(base(100000));
    await cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01" });
    const created = await api.journals.get(42);
    vi.mocked(api.journals.get).mockResolvedValue({ ...created!, postings: [...created!.postings].reverse() });
    const data = parseResult(await cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01" }));
    const je = data.journal_entry as { booking_status: string; postings: Array<{ account: number }> };
    expect(je.booking_status).toBe("duplicate");
    expect(je.postings.map(p => p.account)).toEqual([2656, 2650, 8900, 2960]);
  });

  it("MINOR-4 an identical retry of an already-CONFIRMED dividend reports duplicate, not 'insufficient retained earnings'", async () => {
    // Retained 1000 fully distributed by the confirmed DIV journal 501 → the
    // ledger now shows 0 retained; the retry must be recognised before the
    // legality checks run.
    const { api, cb } = setup([...base(1000), dividendDraft(501, "2026-06-01", 1, 1000, 282.05, true)]);
    for (const dry_run of [true, false]) {
      const result = await cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01", dry_run });
      expect(isError(result)).toBe(false);
      const data = parseResult(result);
      const je = data.journal_entry as { booking_status: string; api_response: { created_object_id: number }; postings: Array<{ account: number; amount: number }> };
      expect(je.booking_status).toBe("duplicate");
      expect(je.api_response.created_object_id).toBe(501);
      expect(je.postings.find(p => p.account === 2960)?.amount).toBe(1000);
    }
    expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit.mock.calls[0]![0]).toMatchObject({ action: "UPDATED", entity_id: 501, details: { booking_status: "duplicate" } });
  });

  // ---- MINOR 8: shareholder name sandboxing ---------------------------------

  it("MINOR-8 desandboxes the shareholder name for the journal title and wraps it at MCP output", async () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const wrapped = `<<UNTRUSTED_OCR_START:${nonce}>>\nEvil OÜ\n<<UNTRUSTED_OCR_END:${nonce}>>`;
    const { api, cb } = setup(base(100000), makeStandardAccounts(), { clientName: wrapped });
    const result = await cb({ net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01" });
    expect(isError(result)).toBe(false);
    const created = vi.mocked(api.journals.create).mock.calls[0]![0] as { title: string };
    expect(created.title).toContain("Evil OÜ");
    expect(created.title).not.toContain("UNTRUSTED_OCR");
    const data = parseResult(result);
    const name = (data.shareholder as { name: string }).name;
    expect(name).toMatch(/^<<UNTRUSTED_OCR_START:[0-9a-f]{32}>>\nEvil OÜ\n<<UNTRUSTED_OCR_END:[0-9a-f]{32}>>$/);
    expect(name).not.toContain(nonce);
    const audit = mockedLogAudit.mock.calls[0]![0] as { summary: string };
    expect(audit.summary).not.toContain("UNTRUSTED_OCR");
  });

  // ---- MINOR 9: explicit inactive reserve account accepted -----------------

  it("MINOR-9 accepts an explicit INACTIVE restricted reserve account and still reads its balance into the floor", async () => {
    const accounts = [
      ...makeStandardAccounts(),
      makeAccount(2930, "C", "Omakapital", "Kohustuslik reservkapital (vana)", "Old reserve", { is_valid: false }),
    ];
    const journals = [...base(20000), makeJournal("2023-02-01", [makePosting(1000, "D", 3000), makePosting(2930, "C", 3000)])];
    const { cb } = setup(journals, accounts);
    const result = await cb({ net_dividend: 100, shareholder_client_id: 1, effective_date: "2026-06-01", restricted_reserve_accounts: [2930], dry_run: true });
    expect(isError(result)).toBe(false);
    const net = parseResult(result).net_assets_check as { restricted_reserves: number; minimum_net_assets: number };
    expect(net.restricted_reserves).toBe(3000);
    expect(net.minimum_net_assets).toBe(5500);
  });
});

// ---------------------------------------------------------------------------
// prepare_dividend_package — ÄS § 157 anchored on the approved annual report
// (plan rev 10 + 10.1). Approved 2025 report: retained 5 000 + profit 20 000 =
// 25 000; share capital 2 500; net assets 27 500 unless stated.
// ---------------------------------------------------------------------------

describe("prepare_dividend_package approved-report anchor", () => {
  beforeEach(() => {
    mockedLogAudit.mockClear();
  });

  const chart = (extra: Account[] = []): Account[] => [
    ...makeStandardAccounts(),
    makeAccount(2940, "C", "Omakapital", "Kohustuslik reservkapital", "Statutory reserve"),
    makeAccount(2950, "C", "Omakapital", "Vabatahtlik reservkapital", "Voluntary reserve"),
    makeAccount(2970, "C", "Omakapital", "Aruandeaasta kasum (kahjum)", "Current year profit"),
    makeAccount(4000, "C", "Tulud", "Müügitulu", "Sales revenue"),
    makeAccount(9000, "D", "Tulud", "Arvestuslik koondtulemus", "Calculated result"),
    ...extra,
  ];
  const books = (): Journal[] => [
    makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)], { id: 1 }),
    makeJournal("2024-01-01", [makePosting(1000, "D", 5000), makePosting(2960, "C", 5000)], { id: 2 }),
    makeJournal("2025-06-01", [makePosting(1000, "D", 20000), makePosting(4000, "C", 20000)], { id: 3 }),
  ];
  const APPROVED = { approved_report_year: 2025, approved_retained_earnings: 5000, approved_profit_for_year: 20000 };
  const pair = (id: number, date: string, debit: number, credit: number, amount: number, extra: Partial<Journal> = {}) =>
    makeJournal(date, [makePosting(debit, "D", amount), makePosting(credit, "C", amount)], { id, ...extra });
  const rikResult = (date: string, amount = 20000, id = 10, extra: Partial<Journal> = {}) => pair(id, date, 9000, 2970, amount, extra);
  const rikTransfer = (date: string, amount = 20000, id = 11, extra: Partial<Journal> = {}) => pair(id, date, 2970, 2960, amount, extra);
  const dividend = (id: number, date: string, net: number, cit: number, extra: Partial<Journal> = {}, accounts: { debit?: number; credit?: number } = {}) =>
    makeJournal(date, [
      makePosting(accounts.debit ?? 2960, "D", net), makePosting(8900, "D", cit),
      makePosting(accounts.credit ?? 2650, "C", net), makePosting(2656, "C", cit),
    ], { id, ...extra });

  function setup(journals: Journal[], accounts: Account[] = chart()) {
    const api = makeApi(journals, accounts);
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, api);
    const cb = mock.tools.get("prepare_dividend_package")!;
    const call = async (args: Record<string, unknown> = {}) => {
      const result = await cb({ net_dividend: 1, shareholder_client_id: 1, effective_date: "2026-06-01", dry_run: true, ...APPROVED, ...args });
      return { isError: isError(result), data: parseToolPayload<DividendPackagePayload>((result as { content: Array<{ text: string }> }).content[0]!.text) };
    };
    return { api, call };
  }
  const lg1Of = (data: DividendPackagePayload) => data.lg1_components ?? data.diagnostic?.lg1_components;
  async function lg1(journals: Journal[], args: Record<string, unknown> = {}, accounts?: Account[]) {
    const { data } = await setup(journals, accounts).call({ force: true, ...args });
    expect(data.holds, JSON.stringify(data.holds)).toBeUndefined();
    return lg1Of(data)!;
  }

  // ---- case table ----------------------------------------------------------

  it.each([
    ["open", []],
    ["RIK result on 31 Dec", [rikResult("2025-12-31")]],
    ["RIK result + transfer", [rikResult("2025-12-31"), rikTransfer("2026-01-01")]],
    ["late RIK result", [rikResult("2026-01-05")]],
    ["late RIK result + late transfer", [rikResult("2026-01-05"), rikTransfer("2026-01-10")]],
    ["legacy close on date", [pair(12, "2025-12-31", 4000, 2970, 20000, { document_number: "YECL-2025" })]],
    ["legacy close late", [pair(12, "2026-01-05", 4000, 2970, 20000, { document_number: "YECL-2025" })]],
    ["transfer only, in the closed year", [rikTransfer("2025-12-01")]],
    ["transfer only, in the dividend year", [rikTransfer("2026-05-01")]],
  ] as Array<[string, Journal[]]>)("books agree (%s): lg 1 = 25 000", async (_name, extra) => {
    const components = await lg1([...books(), ...extra]);
    expect(components).toMatchObject({
      approved_total: 25000, ledger_position_at_report_end: 25000, difference: 0,
      difference_acknowledged: false, distributions_since_report: [], total: 0, distributable_profit: 25000,
    });
  });

  it("an approved figure typed as 30 000 holds as a mismatch; only the exact acknowledgement lifts it", async () => {
    const { api, call } = setup(books());
    const typo = { approved_retained_earnings: 10000 };
    for (const ack of [undefined, -5000, 4999.99, 5000.01]) {
      for (const dry_run of [true, false]) {
        for (const force of [false, true]) {
          const { isError: failed, data } = await call({ ...typo, ledger_difference_acknowledged: ack, dry_run, force });
          expect(failed).toBe(true);
          expect(data.error_code).toBe("approved_report_ledger_mismatch");
          expect(data.holds).toEqual([{
            code: "approved_report_ledger_mismatch", approved_total: 30000, ledger_position_at_report_end: 25000,
            difference: 5000, ledger_difference_acknowledged: ack ?? null,
          }]);
          expect(data.hint).toContain("never by copying the difference");
          expect(data.maximum_distributable).toBeUndefined();
          expect(data.retained_earnings_check).toBeUndefined();
          expect(data.net_assets_check).toBeUndefined();
          expect(data.diagnostic?.lg1_components?.distributable_profit).toBe(30000);
        }
      }
    }
    expect(api.journals.create).not.toHaveBeenCalled();
    const accepted = await call({ ...typo, ledger_difference_acknowledged: 5000 });
    expect(accepted.isError).toBe(false);
    expect(accepted.data.lg1_components).toMatchObject({ distributable_profit: 30000, difference: 5000, difference_acknowledged: true });
    expect(accepted.data.warnings!.some(w => w.includes("ledger_difference_acknowledged"))).toBe(true);
  });

  it.each([
    ["registered DIV journal", [dividend(20, "2026-03-01", 7800, 2200, { document_number: "DIV-2026-03-01-9" })], [20]],
    ["any title and number", [dividend(20, "2026-03-01", 7800, 2200, { document_number: "Otsus 1", title: "Väljamakse" })], [20]],
    ["paid straight from the bank", [dividend(20, "2026-03-01", 7800, 2200, {}, { credit: 1000 })], [20]],
    ["booked against the result account", [rikResult("2025-12-31"), dividend(20, "2026-03-01", 7800, 2200, {}, { debit: 2970 })], [20]],
    ["paid out of a voluntary reserve", [dividend(20, "2026-03-01", 7800, 2200, {}, { debit: 2950 })], [20]],
    ["split into dividend and CIT journals", [pair(21, "2026-03-01", 2960, 2650, 7800), pair(22, "2026-03-01", 8900, 2656, 2200)], [21]],
  ] as Array<[string, Journal[], number[]]>)("an earlier dividend in the year (%s) reduces lg 1 by its net to 17 200", async (_name, extra, ids) => {
    const components = await lg1([...books(), ...extra]);
    expect(components.distributable_profit).toBe(17200);
    expect(components.total).toBe(7800);
    expect(components.distributions_since_report.map(d => d.journal_id)).toEqual(ids);
  });

  it.each([
    ["a pending draft", { registered: false }, "2026-03-01"],
    ["registered after the dividend date", { registered: true }, "2026-09-01"],
    ["a draft after the dividend date", { registered: false }, "2026-09-01"],
  ] as Array<[string, Partial<Journal>, string]>)("the same dividend as %s: lg 1 17 200 and lg 2 reserves 10 000", async (_name, extra, date) => {
    const { data } = await setup([...books(), dividend(20, date, 7800, 2200, extra)]).call();
    expect(data.lg1_components!.distributable_profit).toBe(17200);
    expect(data.lg1_components!.distributions_since_report).toEqual([
      expect.objectContaining({ journal_id: 20, d: 7800, status: extra.registered ? "registered" : "draft" }),
    ]);
    expect(data.net_assets_check).toMatchObject({ net_assets_before_distribution: 27500, commitments: 10000 });
    expect(data.net_assets_check!.commitment_journals).toEqual([expect.objectContaining({ journal_id: 20, reserved: 10000 })]);
  });

  it("ignores deleted journals in distributions and commitments", async () => {
    const { data } = await setup([...books(), dividend(20, "2026-03-01", 7800, 2200, { registered: false, is_deleted: true })]).call();
    expect(data.lg1_components!.distributable_profit).toBe(25000);
    expect(data.net_assets_check!.commitments).toBeUndefined();
  });

  it("a reserve allocation D2970/K2940 1 000 in the year: lg 1 24 000; a pending one also raises the floor", async () => {
    const registered = await setup([...books(), rikResult("2025-12-31"), pair(30, "2026-02-01", 2970, 2940, 1000)]).call();
    expect(registered.data.lg1_components!.distributable_profit).toBe(24000);
    expect(registered.data.net_assets_check).toMatchObject({ net_assets_before_distribution: 27500, minimum_net_assets: 3500 });
    const draft = await setup([...books(), rikResult("2025-12-31"), pair(30, "2026-02-01", 2970, 2940, 1000, { registered: false })]).call();
    expect(draft.data.lg1_components!.distributable_profit).toBe(24000);
    expect(draft.data.net_assets_check).toMatchObject({ minimum_net_assets: 2500, commitments: 1000 });
    expect(draft.data.net_assets_check!.commitment_journals).toEqual([expect.objectContaining({ journal_id: 30, floor_increase: 1000, net_assets_reduction: 0 })]);
    expect(draft.data.maximum_distributable!.max_net_by_net_assets).toBe(registered.data.maximum_distributable!.max_net_by_net_assets);
  });

  it("current-year income, a capital contribution and a correction into equity never raise lg 1", async () => {
    const components = await lg1([
      ...books(),
      pair(40, "2026-02-01", 1000, 4000, 7000),
      pair(41, "2026-02-02", 1000, 2900, 1000),
      pair(42, "2026-02-03", 1000, 2960, 3000),
      pair(43, "2026-02-04", 2110, 2970, 500, { registered: false }),
    ]);
    expect(components.distributable_profit).toBe(25000);
    expect(components.distributions_since_report).toEqual([]);
  });

  it("a correction D2960/K4000 5 000 in the year counts as a distribution (conservative): 20 000", async () => {
    const components = await lg1([...books(), pair(44, "2026-02-01", 2960, 4000, 5000)]);
    expect(components.distributable_profit).toBe(20000);
    expect(components.distributions_since_report.map(d => d.journal_id)).toEqual([44]);
  });

  it("a January dividend against the Y−2 report subtracts everything booked since the Y−2 year end", async () => {
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)], { id: 1 }),
      pair(2, "2023-06-01", 1000, 2960, 5000),
      pair(3, "2024-06-01", 1000, 4000, 3000),
      rikResult("2024-12-31", 3000, 4),
      rikTransfer("2025-01-01", 3000, 5),
      dividend(6, "2025-04-01", 1000, 282.05),
      pair(7, "2025-06-01", 1000, 4000, 20000),
      rikResult("2025-12-31", 20000, 8),
    ];
    const components = await lg1(journals, {
      effective_date: "2026-01-15", approved_report_year: 2024, approved_retained_earnings: 5000, approved_profit_for_year: 3000,
    });
    expect(components).toMatchObject({ approved_total: 8000, ledger_position_at_report_end: 8000, total: 1000, distributable_profit: 7000 });
    expect(components.distributions_since_report.map(d => d.journal_id)).toEqual([6]);
  });

  it.each([2026, 2023])("refuses approved_report_year %s for a 2026 dividend before reading the ledger", async year => {
    const { api, call } = setup(books());
    for (const dry_run of [true, false]) {
      const { isError: failed, data } = await call({ approved_report_year: year, dry_run, force: true });
      expect(failed).toBe(true);
      expect(data.error_code).toBe("approved_report_year_out_of_range");
      expect(data.compliance_notes).toHaveLength(2);
    }
    expect(api.journals.listAllWithPostings).not.toHaveBeenCalled();
    expect(api.journals.create).not.toHaveBeenCalled();
  });

  it("holds a draft dated on or before the report end that changes equity; neutral RIK drafts do not hold", async () => {
    const held = setup([...books(), pair(50, "2025-11-01", 2960, 1000, 500, { registered: false })]);
    for (const dry_run of [true, false]) {
      for (const force of [false, true]) {
        const { isError: failed, data } = await held.call({ dry_run, force });
        expect(failed).toBe(true);
        expect(data.error_code).toBe("pre_report_equity_draft");
        expect(data.holds).toEqual([{ code: "pre_report_equity_draft", journals: [{ journal_id: 50, document_number: null, effective_date: "2025-11-01" }] }]);
      }
    }
    expect(held.api.journals.create).not.toHaveBeenCalled();
    const neutral = await lg1([
      ...books(),
      rikResult("2025-12-31", 20000, 51, { registered: false }),
      rikTransfer("2025-12-31", 20000, 52, { registered: false }),
    ]);
    expect(neutral.distributable_profit).toBe(25000);
  });

  it("holds a pre-report draft that moves a voluntary reserve into the statutory reserve (floor not neutral)", async () => {
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)], { id: 1 }),
      pair(2, "2024-01-01", 1000, 2960, 25000),
      pair(3, "2024-02-01", 1000, 2950, 5000),
      pair(53, "2025-12-31", 2950, 2940, 5000, { registered: false }),
    ];
    const { api, call } = setup(journals);
    for (const dry_run of [true, false]) {
      for (const force of [false, true]) {
        const { isError: failed, data } = await call({
          approved_retained_earnings: 25000, approved_profit_for_year: 0, net_dividend: 23400, dry_run, force,
        });
        expect(failed).toBe(true);
        expect(data.error_code).toBe("pre_report_equity_draft");
        expect(data.holds).toEqual([{ code: "pre_report_equity_draft", journals: [{ journal_id: 53, document_number: null, effective_date: "2025-12-31" }] }]);
        expect(data.maximum_distributable).toBeUndefined();
      }
    }
    expect(api.journals.create).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  it("holds a pre-report draft that reduces net assets without touching equity (pending year-end expense)", async () => {
    const journals = [
      makeJournal("2023-01-01", [makePosting(1000, "D", 27500), makePosting(2900, "C", 2500), makePosting(2960, "C", 25000)], { id: 1 }),
      pair(54, "2025-12-31", 5000, 2310, 10000, { registered: false }),
    ];
    const accounts = chart([makeAccount(2310, "C", "Kohustused", "Viitvõlad", "Accrued liabilities")]);
    const { api, call } = setup(journals, accounts);
    for (const dry_run of [true, false]) {
      for (const force of [false, true]) {
        const { isError: failed, data } = await call({
          approved_retained_earnings: 25000, approved_profit_for_year: -10000, ledger_difference_acknowledged: -10000,
          net_dividend: 15000, dry_run, force,
        });
        expect(failed).toBe(true);
        expect(data.error_code).toBe("pre_report_draft_reduces_net_assets");
        expect(data.holds).toEqual([{ code: "pre_report_draft_reduces_net_assets", journals: [{ journal_id: 54, document_number: null, effective_date: "2025-12-31" }] }]);
        expect(data.hint).toContain("Register or delete");
        expect(data.maximum_distributable).toBeUndefined();
      }
    }
    expect(api.journals.create).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
    // Registered, the books match the approved report and lg 2 reads the expense.
    const registered = await setup([journals[0]!, pair(54, "2025-12-31", 5000, 2310, 10000)], accounts).call({
      approved_retained_earnings: 25000, approved_profit_for_year: -10000, net_dividend: 15000,
    });
    expect(registered.data.holds).toBeUndefined();
    expect(registered.data.error).toBe("ÄS § 157 net assets breach");
    // A pre-report draft that raises net assets and has no equity posting stays ignored; an unvalued one holds.
    const income = await setup([...books(), pair(55, "2025-12-31", 1000, 4000, 500, { registered: false })]).call();
    expect(income.data.holds).toBeUndefined();
    const foreign = await setup([...books(), pair(56, "2025-12-31", 1000, 4000, 500, { registered: false, cl_currencies_id: "USD" })]).call();
    expect(foreign.data.error_code).toBe("dividend_amount_unverified");
  });

  it("includes the compliance notes on every refusal and hold", async () => {
    const holdCall = await setup(books()).call({ approved_profit_for_year: 19000 });
    const missing = await setup(books()).call({ approved_report_year: undefined });
    const year = await setup(books()).call({ approved_report_year: 2026 });
    const target = await setup(books()).call({ income_tax_expense_account: 5000 });
    const zero = await setup(books()).call({ net_dividend: 0 });
    for (const { isError: failed, data } of [holdCall, missing, year, target, zero]) {
      expect(failed).toBe(true);
      expect(data.compliance_notes, String(data.error)).toEqual([
        expect.stringContaining("ÄS § 157 lg 1"), expect.stringContaining("TSD lisal 7"),
      ]);
    }
  });

  it("a future registered dividend 10 000 + CIT 2 820.51: lg 1 15 000; lg 2 reserves 12 820.51", async () => {
    const { data } = await setup([...books(), dividend(60, "2026-09-01", 10000, 2820.51)]).call();
    expect(data.lg1_components!.distributable_profit).toBe(15000);
    expect(data.net_assets_check).toMatchObject({ commitments: 12820.51 });
    expect(data.maximum_distributable!.max_net_by_net_assets).toBeLessThanOrEqual(roundMoney((25000 - 12820.51) * 78 / 100));
  });

  // ---- rev 10.1 --------------------------------------------------------------

  it("an opening balance after the report boundary holds (history incomplete), whatever is acknowledged", async () => {
    const migration = [
      makeJournal("2026-01-01", [makePosting(1000, "D", 17500), makePosting(2900, "C", 2500), makePosting(2960, "C", 15000)],
        { id: 70, operation_type: "INITIAL" }),
      pair(71, "2026-02-01", 1000, 4000, 10000),
    ];
    const { api, call } = setup(migration);
    for (const ack of [undefined, 25000]) {
      for (const force of [false, true]) {
        for (const dry_run of [true, false]) {
          const { isError: failed, data } = await call({
            approved_report_year: 2024, approved_retained_earnings: 25000, approved_profit_for_year: 0,
            ledger_difference_acknowledged: ack, force, dry_run, net_dividend: 19500,
          });
          expect(failed).toBe(true);
          expect(data.error_code).toBe("distribution_history_incomplete");
          expect(data.holds![0]).toEqual({ code: "distribution_history_incomplete", boundary_opening_date: "2025-01-01", journals: [{ journal_id: 70, effective_date: "2026-01-01" }] });
        }
      }
    }
    expect(api.journals.create).not.toHaveBeenCalled();
  });

  it("a boundary opening (report year + 1, 1 January) is the report-end position and the history after it counts", async () => {
    const opening = makeJournal("2025-01-01", [makePosting(1000, "D", 27500), makePosting(2900, "C", 2500), makePosting(2960, "C", 25000)],
      { id: 72, operation_type: "INITIAL" });
    const y2 = await lg1([opening, dividend(73, "2025-03-01", 7800, 2200)], {
      approved_report_year: 2024, approved_retained_earnings: 25000, approved_profit_for_year: 0,
    });
    expect(y2).toMatchObject({ ledger_position_at_report_end: 25000, difference: 0, distributable_profit: 17200 });
    const opening2026 = makeJournal("2026-01-01", [
      makePosting(1000, "D", 27500), makePosting(2900, "C", 2500), makePosting(2960, "C", 5000), makePosting(2970, "C", 20000),
    ], { id: 74, operation_type: "INITIAL" });
    expect(await lg1([opening2026])).toMatchObject({ ledger_position_at_report_end: 25000, distributable_profit: 25000 });
  });

  describe("configured result account (accounting rules: 2999)", () => {
    let dir: string;
    let previous: string | undefined;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "earv-div-anchor-2999-"));
      const rulesPath = join(dir, "accounting-rules.md");
      writeFileSync(rulesPath, "# Accounting Rules\n\n## Annual Report\nCurrent year profit account: 2999\n", "utf-8");
      previous = process.env.EARVELDAJA_RULES_FILE;
      process.env.EARVELDAJA_RULES_FILE = rulesPath;
      resetAccountingRulesCache();
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.EARVELDAJA_RULES_FILE;
      else process.env.EARVELDAJA_RULES_FILE = previous;
      resetAccountingRulesCache();
      rmSync(dir, { recursive: true, force: true });
    });
    const chart2999 = () => chart([makeAccount(2999, "C", "Omakapital", "Aruandeaasta kasum erikonto", "Configured result")]);

    it.each(["2025-12-31", "2026-01-05"])("a result entry D9000/K2999 dated %s counts once", async date => {
      const components = await lg1([...books(), pair(80, date, 9000, 2999, 20000)], {}, chart2999());
      expect(components).toMatchObject({ ledger_position_at_report_end: 25000, distributions_since_report: [], distributable_profit: 25000 });
    });

    it("in Y−2 mode the intervening result entry on 2999 does not consume capacity, and 2999 is a valid retained target", async () => {
      const { data, isError: failed } = await setup([...books(), pair(81, "2025-12-31", 9000, 2999, 20000)], chart2999()).call({
        effective_date: "2026-01-15", approved_report_year: 2024, approved_retained_earnings: 5000, approved_profit_for_year: 0,
        retained_earnings_account: 2999,
      });
      expect(failed).toBe(false);
      expect(data.lg1_components).toMatchObject({ ledger_position_at_report_end: 5000, distributions_since_report: [], distributable_profit: 5000 });
      expect(data.retained_earnings_check!.account).toBe(2999);
    });
  });

  it("loss result and transfer entries never count; a late legacy loss close counts (documented, conservative)", async () => {
    const lossBooks = () => [
      makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)], { id: 1 }),
      pair(2, "2024-01-01", 1000, 2960, 5000),
      pair(3, "2025-06-01", 5000, 1000, 3000),
    ];
    const approvedLoss = { approved_retained_earnings: 5000, approved_profit_for_year: -3000 };
    for (const extra of [
      [pair(90, "2025-12-31", 2970, 9000, 3000), pair(91, "2026-01-01", 2960, 2970, 3000)],
      [pair(90, "2026-01-05", 2970, 9000, 3000)],
      [pair(90, "2026-01-05", 2970, 9000, 3000), pair(91, "2026-01-10", 2960, 2970, 3000)],
    ]) {
      const components = await lg1([...lossBooks(), ...extra], approvedLoss);
      expect(components).toMatchObject({ approved_total: 2000, ledger_position_at_report_end: 2000, distributions_since_report: [], distributable_profit: 2000 });
    }
    const { data } = await setup([...lossBooks(), pair(92, "2026-01-05", 2970, 5000, 3000, { document_number: "YECL-2025" })]).call(approvedLoss);
    expect(data.error).toContain("Insufficient retained earnings");
    expect(lg1Of(data)).toMatchObject({ distributable_profit: -1000, distributions_since_report: [expect.objectContaining({ journal_id: 92, d: 3000 })] });
    expect(data.maximum_distributable).toMatchObject({ max_net_dividend: 0, no_positive_capacity: true });
  });

  it("split dividend/CIT drafts reserve both legs; once registered on or before the date nothing is reserved twice", async () => {
    const split = (registered: boolean) => [pair(21, "2026-03-01", 2960, 2650, 7800, { registered }), pair(22, "2026-03-01", 8900, 2656, 2200, { registered })];
    const drafts = (await setup([...books(), ...split(false)]).call()).data;
    expect(drafts.lg1_components!.distributions_since_report.map(d => d.journal_id)).toEqual([21]);
    expect(drafts.net_assets_check).toMatchObject({ net_assets_before_distribution: 27500, commitments: 10000 });
    expect(drafts.net_assets_check!.commitment_journals!.map(c => [c.journal_id, c.reserved])).toEqual([[21, 7800], [22, 2200]]);
    const registered = (await setup([...books(), ...split(true)]).call()).data;
    expect(registered.lg1_components!.distributable_profit).toBe(17200);
    expect(registered.net_assets_check).toMatchObject({ net_assets_before_distribution: 17500 });
    expect(registered.net_assets_check!.commitments).toBeUndefined();
    expect(registered.maximum_distributable).toEqual(drafts.maximum_distributable);
  });

  it.each([
    ["an equity (dividend) journal", dividend(100, "2026-03-01", 7800, 2200, { cl_currencies_id: "USD" })],
    ["a P&L journal before the report", makeJournal("2025-03-01", [makePosting(5000, "D", 1200), makePosting(2110, "C", 1200)], { id: 100, cl_currencies_id: "USD" })],
    ["a later P&L draft", makeJournal("2026-07-01", [makePosting(5000, "D", 1200), makePosting(2110, "C", 1200)], { id: 100, registered: false, cl_currencies_id: "USD" })],
  ] as Array<[string, Journal]>)("holds a foreign-currency posting without a EUR value on %s", async (_name, journal) => {
    const { api, call } = setup([...books(), journal]);
    for (const dry_run of [true, false]) {
      for (const force of [false, true]) {
        const { isError: failed, data } = await call({ dry_run, force });
        expect(failed).toBe(true);
        expect(data.error_code).toBe("dividend_amount_unverified");
        expect(data.holds![0]).toMatchObject({ code: "dividend_amount_unverified", postings: expect.arrayContaining([expect.objectContaining({ journal_id: 100, currency: "USD" })]) });
      }
    }
    expect(api.journals.create).not.toHaveBeenCalled();
    const valued = { ...journal, postings: journal.postings!.map(p => ({ ...p, base_amount: roundMoney(p.amount / 1.1) })) };
    const { data } = await setup([...books(), valued]).call({ force: true });
    expect(data.holds?.some(h => h.code === "dividend_amount_unverified") ?? false).toBe(false);
  });

  it("returns an exact-cent maximum: booking it passes, +0.01 fails (lg 2 binding)", async () => {
    const preview = (await setup(books()).call()).data.maximum_distributable!;
    expect(preview.limited_by).toBe("net_assets");
    const max = preview.max_net_dividend;
    const cit = (net: number) => roundMoney(net * 22 / 78);
    expect(roundMoney(max + cit(max))).toBeLessThanOrEqual(25000);
    expect(roundMoney(max + 0.01 + cit(roundMoney(max + 0.01)))).toBeGreaterThan(25000);
    const ok = setup(books());
    const booked = await ok.call({ net_dividend: max, dry_run: false });
    expect(booked.isError, JSON.stringify(booked.data)).toBe(false);
    expect(ok.api.journals.create).toHaveBeenCalledTimes(1);
    const over = setup(books());
    const refused = await over.call({ net_dividend: roundMoney(max + 0.01), dry_run: false });
    expect(refused.data.error).toBe("ÄS § 157 net assets breach");
    expect(over.api.journals.create).not.toHaveBeenCalled();
  });

  it("returns an exact-cent maximum: booking it passes, +0.01 fails (lg 1 binding)", async () => {
    const journals = [...books(), dividend(20, "2026-03-01", 7800, 2200), pair(21, "2026-04-01", 1000, 4000, 50000)];
    const preview = (await setup(journals).call()).data.maximum_distributable!;
    expect(preview).toMatchObject({ max_net_dividend: 17200, limited_by: "retained_earnings" });
    const ok = setup(journals);
    expect((await ok.call({ net_dividend: 17200, dry_run: false })).isError).toBe(false);
    const over = setup(journals);
    const refused = await over.call({ net_dividend: 17200.01, dry_run: false });
    expect(refused.data.error).toBe("Insufficient retained earnings");
    expect(refused.data.retained_earnings_check).toMatchObject({ balance: 17200, shortfall: 0.01 });
    expect(over.api.journals.create).not.toHaveBeenCalled();
  });

  it("execute re-reads the ledger: a dividend draft added after the preview is counted", async () => {
    const { api, call } = setup(books());
    expect((await call({ net_dividend: 15000 })).isError).toBe(false);
    vi.mocked(api.journals.listAllWithPostings).mockResolvedValue([...books(), dividend(110, "2026-05-01", 10000, 2820.51, { registered: false })]);
    const executed = await call({ net_dividend: 15000, dry_run: false });
    expect(executed.isError).toBe(true);
    expect(executed.data.error).toBe("ÄS § 157 net assets breach");
    expect(api.journals.invalidateListCache).toHaveBeenCalled();
    expect(api.journals.listAllWithPostings).toHaveBeenCalledTimes(2);
    expect(api.journals.create).not.toHaveBeenCalled();
  });

  it("missing approved figures: approved_annual_report_figures_required with a ledger diagnostic for the named cut-off", async () => {
    const { api, call } = setup(books());
    for (const dry_run of [true, false]) {
      const all = await call({ approved_report_year: undefined, approved_retained_earnings: undefined, approved_profit_for_year: undefined, dry_run, force: true });
      expect(all.isError).toBe(true);
      expect(all.data).toMatchObject({
        error_code: "approved_annual_report_figures_required",
        missing: ["approved_report_year", "approved_retained_earnings", "approved_profit_for_year"],
        diagnostic: { report_year_end: "2025-12-31", ledger_position_at_report_end: 25000 },
      });
      expect(all.data.maximum_distributable).toBeUndefined();
      const partial = await call({ approved_report_year: 2024, approved_profit_for_year: undefined, dry_run });
      expect(partial.data).toMatchObject({ missing: ["approved_profit_for_year"], diagnostic: { report_year_end: "2024-12-31", ledger_position_at_report_end: 5000 } });
    }
    expect(api.journals.create).not.toHaveBeenCalled();
  });

  it("writes nothing on any hold, with either force value, and shows only a diagnostic", async () => {
    const holdFixtures: Array<[string, Journal[], Record<string, unknown>]> = [
      ["approved_report_ledger_mismatch", books(), { approved_profit_for_year: 19000 }],
      ["dividend_amount_unverified", [...books(), dividend(120, "2026-03-01", 100, 28.21, { cl_currencies_id: "USD" })], {}],
      ["pre_report_equity_draft", [...books(), pair(121, "2025-10-01", 2960, 1000, 1, { registered: false })], {}],
      ["distribution_history_incomplete", [...books(), makeJournal("2026-02-01", [makePosting(1000, "D", 1), makePosting(2960, "C", 1)], { id: 122, operation_type: "INITIAL" })], {}],
    ];
    for (const [code, journals, args] of holdFixtures) {
      const { api, call } = setup(journals);
      for (const dry_run of [true, false]) {
        for (const force of [false, true]) {
          const { isError: failed, data } = await call({ ...args, dry_run, force, net_dividend: 100 });
          expect(failed, code).toBe(true);
          expect(data.error_code, code).toBe(code);
          expect(data.diagnostic?.lg1_components, code).toBeDefined();
          expect(data.maximum_distributable, code).toBeUndefined();
          expect(data.retained_earnings_check, code).toBeUndefined();
          expect(data.net_assets_check, code).toBeUndefined();
        }
      }
      expect(api.journals.create, code).not.toHaveBeenCalled();
      expect(mockedLogAudit, code).not.toHaveBeenCalled();
    }
  });

  it("keeps duplicate detection ahead of the capacity checks (an identical retry is a duplicate, not a shortfall)", async () => {
    const { api, call } = setup([...books(), dividend(130, "2026-06-01", 25000, 7051.28, { document_number: "DIV-2026-06-01-1" })]);
    const { isError: failed, data } = await call({ net_dividend: 25000, dry_run: false });
    expect(failed).toBe(false);
    expect(data.journal_entry).toMatchObject({ booking_status: "duplicate", api_response: { created_object_id: 130 } });
    expect(api.journals.create).not.toHaveBeenCalled();
  });

  // ---- properties ---------------------------------------------------------------

  function prng(seed: number) {
    let x = seed >>> 0;
    return () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  }

  it("preservation: adding neutral RIK result/transfer entries anywhere after the report never changes lg 1 or lg 2", async () => {
    const base = [...books(), rikResult("2025-12-31", 20000, 140), dividend(141, "2026-03-01", 1000, 282.05, { registered: false })];
    const reference = (await setup(base).call()).data;
    const rand = prng(157);
    for (let i = 0; i < 25; i++) {
      const extra: Journal[] = [];
      const count = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < count; k++) {
        const amount = roundMoney(1 + rand() * 30000);
        const date = `2026-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`;
        const loss = rand() < 0.5;
        const transfer = rand() < 0.5;
        const [debit, credit] = transfer ? (loss ? [2960, 2970] : [2970, 2960]) : (loss ? [2970, 9000] : [9000, 2970]);
        extra.push(pair(200 + k, date, debit, credit, amount, { registered: rand() < 0.5 }));
      }
      const { data } = await setup([...base, ...extra]).call();
      expect(data.lg1_components!.distributable_profit, JSON.stringify(extra)).toBe(reference.lg1_components!.distributable_profit);
      expect(data.net_assets_check!.net_assets_before_distribution).toBe(reference.net_assets_check!.net_assets_before_distribution);
      expect(data.maximum_distributable).toEqual(reference.maximum_distributable);
    }
  });
});

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

  describe("accounts with dimensions (live 2026-10-31: default 2110 is a per-lender loan account)", () => {
    const LOAN_DIMENSION = { id: 12637384, accounts_id: 2110, title_est: "Seppo OÜ", is_deleted: false };
    const OWNER_DIMENSION = { id: 12637385, accounts_id: 2110, title_est: "Indrek Seppo", is_deleted: false };
    const COST_DIMENSION = { id: 900, accounts_id: 5000, title_est: "Projekt A", is_deleted: false };
    const base = { owner_client_id: 1, effective_date: "2026-10-31", description: "Taxi", net_amount: 10, vat_rate: 0, expense_account: 5000 };
    function setupWithDimensions(dimensions: unknown[]) {
      setup(false);
      vi.mocked(api.readonly.getAccountDimensions).mockResolvedValue(dimensions as never);
    }
    const errorText = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

    it("refuses the default payable account when it has dimensions and none is given, before writing", async () => {
      setupWithDimensions([LOAN_DIMENSION, OWNER_DIMENSION]);
      const result = await tools.get("create_owner_expense_reimbursement")!(base);
      expect(isError(result)).toBe(true);
      expect(errorText(result)).toContain("payable_account_dimension_id");
      expect(errorText(result)).toContain("12637385");
      expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
    });

    it("refuses an expense account with dimensions when no expense dimension is given", async () => {
      setupWithDimensions([COST_DIMENSION]);
      const result = await tools.get("create_owner_expense_reimbursement")!(base);
      expect(isError(result)).toBe(true);
      expect(errorText(result)).toContain("expense_account_dimension_id");
      expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
    });

    it("refuses a dimension that does not belong to its account", async () => {
      setupWithDimensions([LOAN_DIMENSION, OWNER_DIMENSION, COST_DIMENSION]);
      const result = await tools.get("create_owner_expense_reimbursement")!({
        ...base, expense_account_dimension_id: 900, payable_account_dimension_id: 900,
      });
      expect(isError(result)).toBe(true);
      expect(errorText(result)).toContain("payable_account_dimension_id");
      expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
    });

    it("refuses a dimension on an account that has none", async () => {
      setupWithDimensions([]);
      const result = await tools.get("create_owner_expense_reimbursement")!({ ...base, payable_account_dimension_id: 12637385 });
      expect(isError(result)).toBe(true);
      expect(errorText(result)).toContain("payable_account_dimension_id");
      expect(vi.mocked(api.journals.create)).not.toHaveBeenCalled();
    });

    it("posts the given dimensions on the expense and payable lines", async () => {
      setupWithDimensions([LOAN_DIMENSION, OWNER_DIMENSION, COST_DIMENSION]);
      const data = parseResult(await tools.get("create_owner_expense_reimbursement")!({
        ...base, expense_account_dimension_id: 900, payable_account_dimension_id: 12637385,
      }));
      const payload = vi.mocked(api.journals.create).mock.calls[0]![0] as Journal;
      expect(payload.postings).toEqual([
        { accounts_id: 5000, accounts_dimensions_id: 900, type: "D", amount: 10 },
        { accounts_id: 2110, accounts_dimensions_id: 12637385, type: "C", amount: 10 },
      ]);
      expect(data.note).toContain("account 2110 dimension 12637385");
    });

    it("validates against a fresh dimension list, not the cached one", async () => {
      setupWithDimensions([]);
      await tools.get("create_owner_expense_reimbursement")!(base);
      expect(vi.mocked(api.readonly.getAccountDimensions)).toHaveBeenCalledWith({ fresh: true });
    });

    it("does not reuse an earlier same-document draft that books the debt on no or another dimension", async () => {
      setupWithDimensions([]);
      const withDoc = { ...base, document_number: "R-1" };
      await tools.get("create_owner_expense_reimbursement")!(withDoc);
      expect(vi.mocked(api.journals.create)).toHaveBeenCalledTimes(1);
      // 2110 gets its per-lender dimensions; the retry names the owner's one.
      vi.mocked(api.readonly.getAccountDimensions).mockResolvedValue([LOAN_DIMENSION, OWNER_DIMENSION] as never);
      const retry = await tools.get("create_owner_expense_reimbursement")!({ ...withDoc, payable_account_dimension_id: 12637385 });
      expect(isError(retry)).toBe(true);
      expect(errorText(retry)).toContain("owner_expense_journal_conflict");
      expect(errorText(retry)).toContain("42");
      expect(vi.mocked(api.journals.create)).toHaveBeenCalledTimes(1);
    });

    it("does not reuse an earlier same-document draft on another person's dimension", async () => {
      setupWithDimensions([LOAN_DIMENSION, OWNER_DIMENSION]);
      const withDoc = { ...base, document_number: "R-3" };
      await tools.get("create_owner_expense_reimbursement")!({ ...withDoc, payable_account_dimension_id: 12637384 });
      const retry = await tools.get("create_owner_expense_reimbursement")!({ ...withDoc, payable_account_dimension_id: 12637385 });
      expect(isError(retry)).toBe(true);
      expect(errorText(retry)).toContain("owner_expense_journal_conflict");
      expect(vi.mocked(api.journals.create)).toHaveBeenCalledTimes(1);
    });

    it("reuses an earlier same-document draft that books exactly the approved lines", async () => {
      setupWithDimensions([LOAN_DIMENSION, OWNER_DIMENSION]);
      const withDoc = { ...base, document_number: "R-2", payable_account_dimension_id: 12637385 };
      await tools.get("create_owner_expense_reimbursement")!(withDoc);
      const second = parseResult(await tools.get("create_owner_expense_reimbursement")!(withDoc));
      expect(vi.mocked(api.journals.create)).toHaveBeenCalledTimes(1);
      expect((second.journal_entry as { booking_status?: string }).booking_status).toBe("duplicate");
    });

    it("posts no dimension field for accounts without dimensions (unchanged payload)", async () => {
      setupWithDimensions([]);
      const r = await tools.get("create_owner_expense_reimbursement")!(base);
      if (isError(r)) throw new Error(errorText(r));
      const payload = vi.mocked(api.journals.create).mock.calls[0]![0] as Journal;
      expect(payload.postings).toEqual([
        { accounts_id: 5000, type: "D", amount: 10 },
        { accounts_id: 2110, type: "C", amount: 10 },
      ]);
    });
  });

  it("reports the created journal as an unconfirmed draft, not as booked", async () => {
    for (const vatRegistered of [false, true]) {
      setup(vatRegistered);
      const data = parseResult(await tools.get("create_owner_expense_reimbursement")!({
        owner_client_id: 1, effective_date: "2026-06-01", description: "Taxi",
        net_amount: 100, vat_rate: 0, expense_account: 5000,
      }));
      const id = ((data.journal_entry as Record<string, unknown>).api_response as { created_object_id: number }).created_object_id;
      expect(data.note).toContain(`Draft journal ${id} created, not yet confirmed`);
      expect(data.note).toContain("confirm_journal");
      expect(data.note).not.toContain("Expense booked");
    }
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

  it("refuses a description longer than the journal title limit before booking", async () => {
    setup(false);
    const cb = tools.get("create_owner_expense_reimbursement")!;
    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "x".repeat(101),
      net_amount: 100,
      vat_rate: 0,
      expense_account: 5000,
    });
    expect(isError(result)).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("at most 100");
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

  it("strips sandbox markers from description and document_number before the journal and audit", async () => {
    setup(false);
    const cb = tools.get("create_owner_expense_reimbursement")!;
    const nonce = "deadbeef";
    const wrap = (s: string) => `<<UNTRUSTED_OCR_START:${nonce}>>\n${s}\n<<UNTRUSTED_OCR_END:${nonce}>>`;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: wrap("Office chair"),
      document_number: wrap("R-2026-14"),
      net_amount: 100,
      vat_rate: 0,
      expense_account: 5000,
    });

    expect(isError(result)).toBe(false);
    const createCall = vi.mocked(api.journals.create).mock.calls[0][0] as { title: string; document_number?: string };
    expect(createCall.title).toBe("Office chair");
    expect(createCall.document_number).toBe("R-2026-14");
    const auditCall = mockedLogAudit.mock.lastCall?.[0] as { summary: string } | undefined;
    expect(auditCall?.summary).not.toContain("UNTRUSTED_OCR");
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

  it("non-deductible VAT: the document rate with vat_deduction_mode='none' books the VAT into the expense and payable", async () => {
    setup(true);
    const cb = tools.get("create_owner_expense_reimbursement")!;

    const result = await cb({
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Client dinner",
      net_amount: 100,
      vat_rate: 0.24,
      vat_deduction_mode: "none",
      expense_account: 5000,
    });

    expect(isError(result)).toBe(false);
    const createCall = vi.mocked(api.journals.create).mock.calls[0][0] as {
      postings: Array<{ accounts_id: number; type: string; amount: number }>;
    };
    expect(createCall.postings).toHaveLength(2);
    expect(createCall.postings).toContainEqual({ accounts_id: 5000, type: "D", amount: 124 });
    expect(createCall.postings).toContainEqual({ accounts_id: 2110, type: "C", amount: 124 });
  });

  it("describes vat_rate 0 as no VAT only, never as the non-deductible form", () => {
    const { server, configs } = makeMockServer();
    registerEstonianTaxTools(server, makeApi([], makeStandardAccounts()));
    const metadata = toolMetadataText(configs.get("create_owner_expense_reimbursement")!);
    expect(metadata).not.toContain("0 = no VAT/non-deductible");
    expect(metadata).toContain("vat_deduction_mode=\\\"none\\\"");
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
      expect.stringContaining("M1-category"),
      expect.stringContaining("private driving"),
    ]));
    expect(payload.policy_hint).toContain("save_auto_booking_rule");
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
// Tests: bookOwnerExpenseReimbursement shared-core parity
// ---------------------------------------------------------------------------

describe("bookOwnerExpenseReimbursement (shared core)", () => {
  const bookingParams = {
    owner_client_id: 1,
    effective_date: "2026-06-01",
    description: "Office supplies",
    net_amount: 100,
    vat_rate: 0.24,
    vat_deduction_mode: "full" as const,
    expense_account: 5000,
  };

  it("produces byte-identical output to the create_owner_expense_reimbursement tool", async () => {
    // Tool path
    const toolApi = makeApi([], makeStandardAccounts(), { vatRegistered: true });
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, toolApi);
    const toolResult = await mock.tools.get("create_owner_expense_reimbursement")!({ ...bookingParams });

    // Core path (separate identical api so the fixed created_object_id matches)
    const coreApi = makeApi([], makeStandardAccounts(), { vatRegistered: true });
    const coreResult = await bookOwnerExpenseReimbursement(coreApi, { ...bookingParams });

    const toolText = (toolResult as { content: Array<{ text: string }> }).content[0].text;
    const coreText = (coreResult as { content: Array<{ text: string }> }).content[0].text;
    expect(coreText).toBe(toolText);
    expect(isError(coreResult)).toBe(false);

    // Both booked the same three-leg-equivalent journal via journals.create.
    const toolCreate = vi.mocked(toolApi.journals.create).mock.calls[0][0];
    const coreCreate = vi.mocked(coreApi.journals.create).mock.calls[0][0];
    expect(coreCreate).toEqual(toolCreate);
  });

  it("returns the existing journal instead of booking the same receipt twice", async () => {
    const api = makeApi([], makeStandardAccounts(), { vatRegistered: true });
    const params = { ...bookingParams, document_number: "R-1" };
    await bookOwnerExpenseReimbursement(api, params);
    const retry = await bookOwnerExpenseReimbursement(api, params);
    const payload = parseMcpResponse((retry as { content: Array<{ text: string }> }).content[0].text) as any;
    expect(vi.mocked(api.journals.create)).toHaveBeenCalledTimes(1);
    expect(payload.journal_entry).toMatchObject({ booking_status: "duplicate", api_response: { created_object_id: 42 } });
    expect(payload.note).toContain("already exists");

    // A different total on the same document is a different booking.
    await bookOwnerExpenseReimbursement(api, { ...params, net_amount: 50 });
    expect(vi.mocked(api.journals.create)).toHaveBeenCalledTimes(2);
  });

  it("core surfaces the same validation errors as the tool", async () => {
    const coreApi = makeApi([], makeStandardAccounts(), { vatRegistered: false });
    const result = await bookOwnerExpenseReimbursement(coreApi, {
      owner_client_id: 1,
      effective_date: "2026-06-01",
      description: "Bad",
      net_amount: -5,
      vat_rate: 0,
      expense_account: 5000,
    });
    expect(isError(result)).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("net_amount");
    expect(vi.mocked(coreApi.journals.create)).not.toHaveBeenCalled();
  });
});

describe("estonian tax date schemas", () => {
  it("accept only real calendar dates", () => {
    const mock = makeMockServer();
    registerEstonianTaxTools(mock.server, {} as ApiContext);
    const fields: Array<[string, string]> = [
      ["prepare_dividend_package", "effective_date"],
      ["create_owner_expense_reimbursement", "effective_date"],
      ["check_tax_free_limits", "as_of_date"],
    ];
    for (const [tool, field] of fields) {
      const schema = mock.configs.get(tool)!.inputSchema![field] as { safeParse: (v: unknown) => { success: boolean } };
      expect(schema.safeParse("2026-02-31").success, `${tool}.${field}`).toBe(false);
      expect(schema.safeParse("2026-02-29").success, `${tool}.${field}`).toBe(false);
      expect(schema.safeParse("0050-02-29").success, `${tool}.${field}`).toBe(false);
      expect(schema.safeParse("2024-02-29").success, `${tool}.${field}`).toBe(true);
      expect(schema.safeParse("0050-03-01").success, `${tool}.${field}`).toBe(true);
    }
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

  it("defaults to the Tallinn calendar year, not the UTC one, just after New Year", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 2027-01-01 00:30 in Tallinn (UTC+2) is still 2026 in UTC.
      vi.setSystemTime(new Date("2026-12-31T22:30:00Z"));
      const { api, handler } = setup({ vatRegistered: false, saleInvoices: [] });
      await handler({});
      expect(api.saleInvoices.listAll).toHaveBeenCalledWith({
        start_date: "2027-01-01",
        end_date: "2027-12-31",
        status: "CONFIRMED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

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
    expect(payload.vat_metadata).toEqual(ESTONIAN_VAT_METADATA);
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
    expect(String(payload.legal_basis)).toContain(ESTONIAN_VAT_METADATA.registration.scope_effective_from);
    expect(String(payload.legal_basis)).toContain(ESTONIAN_VAT_METADATA.registration.threshold.basis);
    expect(String(payload.legal_basis)).toContain(vatSourceById("registration-threshold").url);
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
    expect((payload.count_if_not_incidental as Record<string, unknown>).financial_turnover).toBe(16000);
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

  it("does not report exceeded at the exact threshold because registration requires turnover above it", async () => {
    const handler = getHandler({
      vatRegistered: false,
      saleInvoices: [
        makeSaleInvoice({ id: 1, journal_date: "2026-01-15", base_gross_price: 40_000, gross_price: 40_000 }),
      ],
    });

    const payload = parseResult(await handler({ year: 2026 }));

    expect(payload.taxable_or_zero_rated_turnover).toBe(ESTONIAN_VAT_METADATA.registration.threshold.amount);
    expect(payload.status).toBe("approaching");
    expect(payload.excess_if_all_non_incidental).toBe(0);
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

describe("dividendJournalTitle", () => {
  it("keeps a short name whole and shortens a long one to fit the journal title limit", async () => {
    const { dividendJournalTitle } = await import("./estonian-tax.js");
    const amounts = "(neto 15000 EUR, TuMa 22/78 4230.77 EUR)";
    expect(dividendJournalTitle("Mari Maasikas", amounts)).toBe(`Dividendi väljamakse - Mari Maasikas ${amounts}`);
    const long = dividendJournalTitle("Osaühing Põhjamaade Kinnisvara Investeeringud ja Arendus", amounts);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toContain("…");
    expect(long.endsWith(amounts)).toBe(true);
  });
});
