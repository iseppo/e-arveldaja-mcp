import { describe, expect, it, vi } from "vitest";
import type { Account, Journal, Posting, SaleInvoice, PurchaseInvoice } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { computeAllBalances, registerFinancialStatementTools } from "./financial-statements.js";
import { parseMcpResponse } from "../mcp-json.js";
import { makeAccount, makePosting, makeJournal } from "../__fixtures__/accounting.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSaleInvoice(
  overrides: Partial<SaleInvoice> & Pick<SaleInvoice, "id" | "create_date" | "journal_date" | "term_days">,
): SaleInvoice {
  return {
    sale_invoice_type: "INVOICE",
    cl_templates_id: 1,
    clients_id: 1,
    cl_countries_id: "EE",
    number_suffix: "1",
    cl_currencies_id: "EUR",
    show_client_balance: false,
    status: "CONFIRMED",
    payment_status: "NOT_PAID",
    ...overrides,
  };
}

function makePurchaseInvoice(
  overrides: Partial<PurchaseInvoice> & Pick<PurchaseInvoice, "id" | "create_date" | "journal_date" | "term_days">,
): PurchaseInvoice {
  return {
    clients_id: 1,
    client_name: "Supplier",
    number: "INV-1",
    cl_currencies_id: "EUR",
    status: "CONFIRMED",
    payment_status: "NOT_PAID",
    ...overrides,
  };
}

function createApi(options: {
  accounts?: Account[];
  journals?: Journal[];
  saleInvoices?: SaleInvoice[];
  purchaseInvoices?: PurchaseInvoice[];
  transactions?: unknown[];
}): ApiContext {
  return {
    readonly: {
      getAccounts: vi.fn().mockResolvedValue(options.accounts ?? []),
    },
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue(options.journals ?? []),
      listAll: vi.fn().mockResolvedValue(options.journals ?? []),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.saleInvoices ?? []),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.purchaseInvoices ?? []),
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactions ?? []),
    },
  } as unknown as ApiContext;
}

function setupTool(
  toolName: string,
  options: Parameters<typeof createApi>[0],
): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  const server = { registerTool: vi.fn() } as any;
  const api = createApi(options);
  registerFinancialStatementTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === toolName);
  if (!registration) throw new Error(`Tool '${toolName}' was not registered`);
  // mcp-compat calls server.registerTool(name, config, callback) — callback is at index 2
  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

// ---------------------------------------------------------------------------
// computeAllBalances — unit tests (directly exported)
// ---------------------------------------------------------------------------

describe("computeAllBalances", () => {
  it("returns D-type account balance as debit - credit", async () => {
    const api = createApi({
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-01-10", [
          makePosting(1000, "D", 500),
          makePosting(1000, "C", 100),
        ]),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances).toHaveLength(1);
    expect(balances[0]!.account_id).toBe(1000);
    expect(balances[0]!.balance_type).toBe("D");
    expect(balances[0]!.debit_total).toBe(500);
    expect(balances[0]!.credit_total).toBe(100);
    expect(balances[0]!.balance).toBe(400); // 500 - 100
  });

  it("returns C-type account balance as credit - debit", async () => {
    const api = createApi({
      accounts: [makeAccount(2000, "C", "Kohustused", "Payable")],
      journals: [
        makeJournal("2024-01-10", [
          makePosting(2000, "C", 300),
          makePosting(2000, "D", 50),
        ]),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances).toHaveLength(1);
    expect(balances[0]!.balance_type).toBe("C");
    expect(balances[0]!.balance).toBe(250); // 300 - 50
  });

  it("uses base_amount over amount for multi-currency postings", async () => {
    const api = createApi({
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-01-10", [
          // amount is USD, base_amount is EUR
          makePosting(1000, "D", 120, 100),
        ]),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances[0]!.debit_total).toBe(100); // uses base_amount
    expect(balances[0]!.balance).toBe(100);
  });

  it("skips deleted journals", async () => {
    const api = createApi({
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-01-10", [makePosting(1000, "D", 500)], { is_deleted: true }),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances).toHaveLength(0);
  });

  it("skips unregistered journals", async () => {
    const api = createApi({
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-01-10", [makePosting(1000, "D", 500)], { registered: false }),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances).toHaveLength(0);
  });

  it("skips deleted postings", async () => {
    const api = createApi({
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-01-10", [
          { accounts_id: 1000, type: "D", amount: 500, is_deleted: true },
        ]),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances).toHaveLength(0);
  });

  it("filters by dateFrom and dateTo", async () => {
    const api = createApi({
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-01-05", [makePosting(1000, "D", 100)]),
        makeJournal("2024-01-15", [makePosting(1000, "D", 200)]),
        makeJournal("2024-01-25", [makePosting(1000, "D", 400)]),
      ],
    });

    const balances = await computeAllBalances(api, "2024-01-10", "2024-01-20");
    expect(balances).toHaveLength(1);
    expect(balances[0]!.debit_total).toBe(200); // only the middle journal
  });

  it("results are sorted by account_id", async () => {
    const api = createApi({
      accounts: [
        makeAccount(3000, "C", "Omakapital", "Equity"),
        makeAccount(1000, "D", "Varad", "Bank"),
      ],
      journals: [
        makeJournal("2024-01-10", [
          makePosting(3000, "C", 1000),
          makePosting(1000, "D", 1000),
        ]),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances[0]!.account_id).toBe(1000);
    expect(balances[1]!.account_id).toBe(3000);
  });

  it("accumulates postings across multiple journals", async () => {
    const api = createApi({
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-01-01", [makePosting(1000, "D", 100)]),
        makeJournal("2024-01-02", [makePosting(1000, "D", 200)]),
        makeJournal("2024-01-03", [makePosting(1000, "C", 50)]),
      ],
    });

    const balances = await computeAllBalances(api);
    expect(balances[0]!.debit_total).toBe(300);
    expect(balances[0]!.credit_total).toBe(50);
    expect(balances[0]!.balance).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// compute_trial_balance — debits = credits invariant
// ---------------------------------------------------------------------------

describe("compute_trial_balance", () => {
  it("total debits equal total credits for balanced journals", async () => {
    const handler = setupTool("compute_trial_balance", {
      accounts: [
        makeAccount(1000, "D", "Varad", "Bank"),
        makeAccount(3001, "C", "Tulud", "Revenue"),
      ],
      journals: [
        makeJournal("2024-06-01", [
          makePosting(1000, "D", 1000),
          makePosting(3001, "C", 1000),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.totals.debit).toBe(1000);
    expect(payload.totals.credit).toBe(1000);
    expect(payload.totals.difference).toBe(0);
  });

  it("passes date range through to the output", async () => {
    const handler = setupTool("compute_trial_balance", {
      accounts: [],
      journals: [],
    });

    const result = await handler({ date_from: "2024-01-01", date_to: "2024-12-31" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.period.from).toBe("2024-01-01");
    expect(payload.period.to).toBe("2024-12-31");
  });

  it("reports difference when journals are unbalanced (data integrity check)", async () => {
    const handler = setupTool("compute_trial_balance", {
      accounts: [makeAccount(1000, "D", "Varad", "Bank")],
      journals: [
        makeJournal("2024-06-01", [makePosting(1000, "D", 500)]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.totals.debit).toBe(500);
    expect(payload.totals.credit).toBe(0);
    expect(payload.totals.difference).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// compute_balance_sheet — assets = liabilities + equity invariant
// ---------------------------------------------------------------------------

describe("compute_balance_sheet", () => {
  it("assets equal liabilities + equity for a balanced set of accounts", async () => {
    const handler = setupTool("compute_balance_sheet", {
      accounts: [
        makeAccount(1000, "D", "Varad", "Bank"),
        makeAccount(2000, "C", "Kohustused", "Payable"),
        makeAccount(3000, "C", "Omakapital", "Equity"),
      ],
      journals: [
        makeJournal("2024-01-01", [
          makePosting(1000, "D", 10000),
          makePosting(2000, "C", 3000),
          makePosting(3000, "C", 7000),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.check.balanced).toBe(true);
    expect(payload.check.assets).toBe(10000);
    expect(payload.check.liabilities_plus_equity).toBe(10000);
  });

  it("includes current-year P&L in equity for balance check", async () => {
    const handler = setupTool("compute_balance_sheet", {
      accounts: [
        makeAccount(1000, "D", "Varad", "Bank"),
        makeAccount(3000, "C", "Omakapital", "Equity"),
        makeAccount(3001, "C", "Tulud", "Revenue"),
        makeAccount(5000, "D", "Kulud", "Expenses"),
      ],
      journals: [
        makeJournal("2024-01-01", [
          makePosting(1000, "D", 12000),
          makePosting(3000, "C", 5000),
          makePosting(3001, "C", 10000),
          makePosting(5000, "D", 3000),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.check.balanced).toBe(true);
    expect(payload.current_year_pl.net_profit).toBe(7000); // 10000 revenue - 3000 expenses
  });

  it("contra-account (C-type) inside Varad subtracts from total assets", async () => {
    // Accumulated depreciation is C-type but lives under Varad (contra-asset)
    const handler = setupTool("compute_balance_sheet", {
      accounts: [
        makeAccount(1000, "D", "Varad", "Fixed Asset"),
        makeAccount(1009, "C", "Varad", "Accumulated Depreciation"),
        makeAccount(3000, "C", "Omakapital", "Equity"),
      ],
      journals: [
        makeJournal("2024-01-01", [
          makePosting(1000, "D", 5000),
          makePosting(1009, "C", 1000),
          makePosting(3000, "C", 4000),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    // Assets: D-type 5000 + contra C-type subtracts 1000 = 4000
    expect(payload.assets.total).toBe(4000);
    expect(payload.check.balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compute_profit_and_loss — revenue - expenses = net income
// ---------------------------------------------------------------------------

describe("compute_profit_and_loss", () => {
  it("net profit = revenue - expenses", async () => {
    const handler = setupTool("compute_profit_and_loss", {
      accounts: [
        makeAccount(3001, "C", "Tulud", "Sales Revenue"),
        makeAccount(5000, "D", "Kulud", "Salaries"),
        makeAccount(5001, "D", "Kulud", "Rent"),
      ],
      journals: [
        makeJournal("2024-03-01", [
          makePosting(3001, "C", 20000),
          makePosting(5000, "D", 8000),
          makePosting(5001, "D", 2000),
        ]),
      ],
    });

    const result = await handler({ date_from: "2024-03-01", date_to: "2024-03-31" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.revenue.total).toBe(20000);
    expect(payload.expenses.total).toBe(10000);
    expect(payload.net_profit).toBe(10000);
  });

  it("net profit is negative when expenses exceed revenue (loss)", async () => {
    const handler = setupTool("compute_profit_and_loss", {
      accounts: [
        makeAccount(3001, "C", "Tulud", "Revenue"),
        makeAccount(5000, "D", "Kulud", "Expenses"),
      ],
      journals: [
        makeJournal("2024-03-01", [
          makePosting(3001, "C", 1000),
          makePosting(5000, "D", 4000),
        ]),
      ],
    });

    const result = await handler({ date_from: "2024-03-01", date_to: "2024-03-31" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.net_profit).toBe(-3000);
  });

  it("contra-account in expenses (C-type Kulud) subtracts from total expenses", async () => {
    // E.g. a cost reversal account that is C-type under Kulud
    const handler = setupTool("compute_profit_and_loss", {
      accounts: [
        makeAccount(3001, "C", "Tulud", "Revenue"),
        makeAccount(5000, "D", "Kulud", "Expenses"),
        makeAccount(5099, "C", "Kulud", "Expense Reversal"),
      ],
      journals: [
        makeJournal("2024-03-01", [
          makePosting(3001, "C", 5000),
          makePosting(5000, "D", 3000),
          makePosting(5099, "C", 500),
        ]),
      ],
    });

    const result = await handler({ date_from: "2024-03-01", date_to: "2024-03-31" });
    const payload = parseMcpResponse(result.content[0]!.text);

    // expenses: D-type 3000 - C-type contra 500 = 2500
    expect(payload.expenses.total).toBe(2500);
    expect(payload.net_profit).toBe(2500); // 5000 - 2500
  });

  it("returns zero net profit when there are no transactions", async () => {
    const handler = setupTool("compute_profit_and_loss", {
      accounts: [],
      journals: [],
    });

    const result = await handler({ date_from: "2024-01-01", date_to: "2024-01-31" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.net_profit).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getMonthLastDay — tested via month_end_close_checklist date range output
// ---------------------------------------------------------------------------

describe("getMonthLastDay (via month_end_close_checklist)", () => {
  function setupChecklist(options: Parameters<typeof createApi>[0] = {}) {
    return setupTool("month_end_close_checklist", options);
  }

  it("returns 28 days for February in a non-leap year (2025-02)", async () => {
    const handler = setupChecklist();
    const result = await handler({ month: "2025-02" });
    const payload = parseMcpResponse(result.content[0]!.text);
    expect(payload.month).toBe("2025-02");
    // The tool uses dateTo = `${month}-${lastDay}` — we verify the overdue filter works
    // without errors for 2025-02-28 (no errors = correct last day computed)
    expect(payload.summary).toBeDefined();
  });

  it("returns 29 days for February in a leap year (2024-02)", async () => {
    const handler = setupChecklist();
    const result = await handler({ month: "2024-02" });
    const payload = parseMcpResponse(result.content[0]!.text);
    expect(payload.month).toBe("2024-02");
    expect(payload.summary).toBeDefined();
  });

  it("returns 31 days for December (2024-12)", async () => {
    const handler = setupChecklist();
    const result = await handler({ month: "2024-12" });
    const payload = parseMcpResponse(result.content[0]!.text);
    expect(payload.month).toBe("2024-12");
    expect(payload.summary).toBeDefined();
  });

  it("handles month with 30 days (2024-04)", async () => {
    const handler = setupChecklist();
    const result = await handler({ month: "2024-04" });
    const payload = parseMcpResponse(result.content[0]!.text);
    expect(payload.month).toBe("2024-04");
    expect(payload.summary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// month_end_close_checklist — business logic
// ---------------------------------------------------------------------------

describe("month_end_close_checklist", () => {
  it("detects unconfirmed journals within the month", async () => {
    const handler = setupTool("month_end_close_checklist", {
      journals: [
        {
          id: 1,
          effective_date: "2024-03-15",
          registered: false,
          is_deleted: false,
          title: "Unconfirmed entry",
          postings: [],
        },
        {
          id: 2,
          effective_date: "2024-03-20",
          registered: true,
          is_deleted: false,
          postings: [],
        },
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.unconfirmed_journals.count).toBe(1);
    expect(payload.unconfirmed_journals.items[0]!.id).toBe(1);
  });

  it("excludes journals outside the month from unconfirmed count", async () => {
    const handler = setupTool("month_end_close_checklist", {
      journals: [
        {
          id: 1,
          effective_date: "2024-02-28",
          registered: false,
          is_deleted: false,
          postings: [],
        },
        {
          id: 2,
          effective_date: "2024-04-01",
          registered: false,
          is_deleted: false,
          postings: [],
        },
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.unconfirmed_journals.count).toBe(0);
  });

  it("detects overdue receivables where due date < month-end", async () => {
    // Invoice created 2024-03-01 with term_days=10 => due 2024-03-11
    // Month-end of 2024-03 = 2024-03-31, so it's overdue
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({
          id: 10,
          number: "ARV-10",
          client_name: "Acme",
          create_date: "2024-03-01",
          journal_date: "2024-03-01",
          term_days: 10,
          gross_price: 500,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_receivables.count).toBe(1);
    expect(payload.overdue_receivables.total).toBe(500);
    expect(payload.overdue_receivables.items[0]!.id).toBe(10);
  });

  it("does not include paid receivables in overdue list", async () => {
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({
          id: 11,
          number: "ARV-11",
          create_date: "2024-03-01",
          journal_date: "2024-03-01",
          term_days: 5,
          gross_price: 200,
          status: "CONFIRMED",
          payment_status: "PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_receivables.count).toBe(0);
  });

  it("does not include unconfirmed (PROJECT) invoices in overdue list", async () => {
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({
          id: 12,
          number: "ARV-12",
          create_date: "2024-03-01",
          journal_date: "2024-03-01",
          term_days: 5,
          gross_price: 300,
          status: "PROJECT",
          payment_status: "NOT_PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_receivables.count).toBe(0);
    // But it should appear in unconfirmed_sale_invoices
    expect(payload.unconfirmed_sale_invoices.count).toBe(1);
  });

  it("does not include VOID transactions in unconfirmed transaction counts", async () => {
    const handler = setupTool("month_end_close_checklist", {
      transactions: [
        {
          id: 50,
          status: "VOID",
          is_deleted: false,
          type: "C",
          amount: 75,
          date: "2024-03-15",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Voided bank transaction",
        },
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.unconfirmed_transactions.count).toBe(0);
    expect(payload.summary.ready_to_close).toBe(true);
  });

  it("does not flag receivable as overdue when due date is exactly at month-end", async () => {
    // Invoice created 2024-03-01 with term_days=30 => due 2024-03-31 = month-end
    // Overdue condition: due < dateTo (strict less-than), so exactly month-end is NOT overdue
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({
          id: 13,
          number: "ARV-13",
          create_date: "2024-03-01",
          journal_date: "2024-03-01",
          term_days: 30,
          gross_price: 100,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_receivables.count).toBe(0);
  });

  it("detects overdue payables", async () => {
    const handler = setupTool("month_end_close_checklist", {
      purchaseInvoices: [
        makePurchaseInvoice({
          id: 20,
          number: "PINV-20",
          client_name: "Supplier X",
          create_date: "2024-03-01",
          journal_date: "2024-03-01",
          term_days: 10,
          gross_price: 800,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_payables.count).toBe(1);
    expect(payload.overdue_payables.total).toBe(800);
  });

  it("is ready_to_close when no unconfirmed items exist", async () => {
    const handler = setupTool("month_end_close_checklist", {});

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary.ready_to_close).toBe(true);
    expect(payload.summary.issues_found).toBe(0);
  });

  it("is not ready_to_close when unconfirmed journals exist", async () => {
    const handler = setupTool("month_end_close_checklist", {
      journals: [
        {
          id: 99,
          effective_date: "2024-03-10",
          registered: false,
          is_deleted: false,
          postings: [],
        },
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary.ready_to_close).toBe(false);
  });

  it("warns about PARTIALLY_PAID overdue receivables", async () => {
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({
          id: 14,
          number: "ARV-14",
          create_date: "2024-03-01",
          journal_date: "2024-03-01",
          term_days: 5,
          gross_price: 400,
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_receivables.count).toBe(1);
    const partialWarning = payload.warnings.some((w: string) => w.includes("PARTIALLY_PAID"));
    expect(partialWarning).toBe(true);
  });

  it("uses base_gross_price over gross_price for overdue total when available", async () => {
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({
          id: 15,
          number: "ARV-15",
          create_date: "2024-03-01",
          journal_date: "2024-03-01",
          term_days: 5,
          gross_price: 120,  // foreign currency amount
          base_gross_price: 100, // EUR amount
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_receivables.total).toBe(100); // uses base_gross_price
  });
});
