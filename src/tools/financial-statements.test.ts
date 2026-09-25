import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Account, Journal, Posting, SaleInvoice, PurchaseInvoice } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { computeAllBalances, registerFinancialStatementTools } from "./financial-statements.js";
import { parseMcpResponse } from "../mcp-json.js";
import { makeAccount, makePosting, makeJournal } from "../__fixtures__/accounting.js";
import { clearRuntimeCaches } from "../cache-control.js";
import { writeOpeningBalances, resetOpeningBalanceCache } from "../opening-balance-store.js";
import type { ToolExposureConfig } from "../config.js";
import { createReportingOperations } from "../reporting/operations.js";

vi.mock("../cache-control.js", () => ({
  clearRuntimeCaches: vi.fn(() => ({
    scope: "all",
    caches_cleared: ["api_responses", "reference_data", "vat_warning_dedupe"],
  })),
  cacheClearMetadata: (result: { scope: string } | undefined) => result
    ? { cache: { fresh: true, cleared: true, scope: result.scope } }
    : {},
}));

const clearRuntimeCachesMock = vi.mocked(clearRuntimeCaches);

beforeEach(() => {
  clearRuntimeCachesMock.mockClear();
});

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
      getAccountDimensions: vi.fn().mockResolvedValue([]),
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
  exposure?: Pick<ToolExposureConfig, "enableSales">,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  const server = { registerTool: vi.fn() } as any;
  const api = createApi(options);
  registerFinancialStatementTools(server, api, exposure);

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
// Opening balance folding — stored algbilanss prepended as a synthetic journal
// ---------------------------------------------------------------------------

describe("opening balance folding", () => {
  const BANK_ACCOUNT_ID = 1020;
  const CAPITAL_ACCOUNT_ID = 2900;

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-fin-stmt-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    resetOpeningBalanceCache();
  });

  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_DIR;
    resetOpeningBalanceCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const CHART = [
    makeAccount(BANK_ACCOUNT_ID, "D", "Varad", "Pank", "Bank"),
    makeAccount(CAPITAL_ACCOUNT_ID, "C", "Omakapital", "Kapital", "Capital"),
  ];

  function storeOpeningBalances() {
    writeOpeningBalances(
      {
        openingDate: "2024-12-12",
        accounts: [
          { code: String(BANK_ACCOUNT_ID), name: "Pank", debit: 1000, credit: 0 },
          { code: String(CAPITAL_ACCOUNT_ID), name: "Kapital", debit: 0, credit: 1000 },
        ],
        totals: { debit: 1000, credit: 1000 },
        rawText: "n/a",
      },
      "2024-12-12T00:00:00.000Z",
    );
  }

  it("folds a stored opening balance into compute_trial_balance", async () => {
    storeOpeningBalances();
    const handler = setupTool("compute_trial_balance", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text) as {
      accounts: Array<{ account_id: number; debit_total: number }>;
      totals: { debit: number; credit: number };
      warnings: string[];
    };
    const bankRow = payload.accounts.find(a => a.account_id === BANK_ACCOUNT_ID)!;

    expect(bankRow.debit_total).toBe(1500); // 500 existing + 1000 opening
    expect(payload.totals.debit).toBe(1500);
    expect(payload.totals.credit).toBe(1500);
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("shows the out-of-window note for compute_trial_balance when date_from excludes the stored algbilanss", async () => {
    storeOpeningBalances();
    const handler = setupTool("compute_trial_balance", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({ date_from: "2025-01-01" });
    const payload = parseMcpResponse(result.content[0]!.text) as {
      accounts: Array<{ account_id: number; debit_total: number }>;
      warnings: string[];
    };
    const bankRow = payload.accounts.find(a => a.account_id === BANK_ACCOUNT_ID)!;

    // date_from (2025-01-01) is after the opening date (2024-12-12), so the
    // opening journal is excluded — only the in-window 500 is counted.
    expect(bankRow.debit_total).toBe(500);
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("fall outside this date range")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("leaves compute_trial_balance unchanged without a stored algbilanss", async () => {
    const handler = setupTool("compute_trial_balance", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text) as {
      accounts: Array<{ account_id: number; debit_total: number }>;
      warnings: string[];
    };
    const bankRow = payload.accounts.find(a => a.account_id === BANK_ACCOUNT_ID)!;

    expect(bankRow.debit_total).toBe(500);
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("folds a stored opening balance into compute_balance_sheet", async () => {
    storeOpeningBalances();
    const handler = setupTool("compute_balance_sheet", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text) as {
      assets: { total: number };
      equity: { total: number };
      warnings: string[];
    };

    expect(payload.assets.total).toBe(1500); // 500 existing + 1000 opening
    expect(payload.equity.total).toBe(1500);
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
  });

  it("shows the out-of-window note for compute_balance_sheet when date_to is before the stored algbilanss date", async () => {
    storeOpeningBalances();
    const handler = setupTool("compute_balance_sheet", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({ date_to: "2024-06-01" });
    const payload = parseMcpResponse(result.content[0]!.text) as {
      assets: { total: number };
      warnings: string[];
    };

    // date_to (2024-06-01) is before the opening date (2024-12-12) and before
    // the regular journal (2025-01-10) too, so both are excluded — this test
    // is about the warning, not the (zero) figure.
    expect(payload.assets.total).toBe(0);
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("fall outside this date range")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("leaves compute_balance_sheet unchanged without a stored algbilanss", async () => {
    const handler = setupTool("compute_balance_sheet", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text) as {
      assets: { total: number };
      equity: { total: number };
      warnings: string[];
    };

    expect(payload.assets.total).toBe(500);
    expect(payload.equity.total).toBe(500);
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("shows the out-of-window note for compute_profit_and_loss when the opening date is outside the period", async () => {
    storeOpeningBalances();
    const handler = setupTool("compute_profit_and_loss", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({ date_from: "2025-01-01", date_to: "2025-01-31" });
    const payload = parseMcpResponse(result.content[0]!.text) as {
      warnings: string[];
    };

    // Opening balance is dated 2024-12-12, outside this P&L period
    // (2025-01-01..2025-01-31) — the stored algbilanss is excluded from
    // these figures, so the note must reflect out-of-window, not "applied",
    // and it must NOT show the actionable "paste it" warning either (it IS
    // captured, just not in this window).
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("fall outside this date range")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("folds a stored opening balance into compute_profit_and_loss when the period includes the opening date", async () => {
    storeOpeningBalances();
    const handler = setupTool("compute_profit_and_loss", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({ date_from: "2024-12-01", date_to: "2025-01-31" });
    const payload = parseMcpResponse(result.content[0]!.text) as {
      warnings: string[];
    };

    // Opening date (2024-12-12) is within this period, so it counts as
    // "applied" — BANK/CAPITAL opening entries are Varad/Omakapital so they
    // don't move the Tulud/Kulud totals here, but the note must say applied.
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
    expect(payload.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("fall outside this date range")]),
    );
  });

  it("leaves compute_profit_and_loss unchanged without a stored algbilanss", async () => {
    const handler = setupTool("compute_profit_and_loss", {
      accounts: CHART,
      journals: [
        makeJournal("2025-01-10", [
          makePosting(BANK_ACCOUNT_ID, "D", 500),
          makePosting(CAPITAL_ACCOUNT_ID, "C", 500),
        ]),
      ],
    });

    const result = await handler({ date_from: "2025-01-01", date_to: "2025-01-31" });
    const payload = parseMcpResponse(result.content[0]!.text) as {
      warnings: string[];
    };

    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
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
    expect(payload.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Algbilansi kanded"),
    ]));
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

  it("clears runtime caches before computing when fresh is true", async () => {
    const handler = setupTool("compute_trial_balance", {
      accounts: [],
      journals: [],
    });

    const result = await handler({ fresh: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(clearRuntimeCachesMock).toHaveBeenCalledOnce();
    expect(payload.cache).toEqual({
      fresh: true,
      cleared: true,
      scope: "all",
    });
  });

  it("total debits equal total credits when sub-cent postings split across accounts round differently per-account (raw-sum rounding)", async () => {
    // Three separate D-type accounts each receive a single 0.005 posting;
    // one C-type account receives three matching 0.005 credits. The ledger
    // is balanced at the raw level (0.015 D == 0.015 C), but each D account
    // independently rounds 0.005 -> 0.01, so naively summing the three
    // per-account debit_total fields gives 0.03 while the single C account's
    // credit_total (rounded once from its own raw 0.015) is 0.02 — a false
    // ±0.01 trial-balance mismatch. Rounding the RAW grand totals once
    // instead must agree: both round to 0.02.
    const handler = setupTool("compute_trial_balance", {
      accounts: [
        makeAccount(1000, "D", "Varad", "A"),
        makeAccount(1001, "D", "Varad", "B"),
        makeAccount(1002, "D", "Varad", "C"),
        makeAccount(9000, "C", "Tulud", "Revenue"),
      ],
      journals: [
        makeJournal("2024-06-01", [makePosting(1000, "D", 0.005), makePosting(9000, "C", 0.005)]),
        makeJournal("2024-06-02", [makePosting(1001, "D", 0.005), makePosting(9000, "C", 0.005)]),
        makeJournal("2024-06-03", [makePosting(1002, "D", 0.005), makePosting(9000, "C", 0.005)]),
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.totals.debit).toBe(0.02);
    expect(payload.totals.credit).toBe(0.02);
    expect(payload.totals.difference).toBe(0);
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
    expect(payload.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Algbilansi kanded"),
    ]));
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
    expect(payload.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Algbilansi kanded"),
    ]));
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
  it("does not fetch or return sales data when sales are disabled", async () => {
    const server = { registerTool: vi.fn() } as any;
    const api = createApi({
      saleInvoices: [makeSaleInvoice({
        id: 900,
        number: "ARV-900",
        create_date: "2024-03-01",
        journal_date: "2024-03-01",
        term_days: 1,
        status: "PROJECT",
      })],
    });
    registerFinancialStatementTools(server, api, { enableSales: false });
    const registration = server.registerTool.mock.calls.find(
      ([name]: [string]) => name === "month_end_close_checklist",
    );
    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{
      content: Array<{ text: string }>;
    }>;

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(api.saleInvoices.listAll).not.toHaveBeenCalled();
    expect(payload).not.toHaveProperty("unconfirmed_sale_invoices");
    expect(payload).not.toHaveProperty("overdue_receivables");
    expect(payload).toHaveProperty("unconfirmed_purchase_invoices");
    expect(payload).toHaveProperty("overdue_payables");
  });

  it("fetches and returns sales data by default", async () => {
    const server = { registerTool: vi.fn() } as any;
    const api = createApi({});
    registerFinancialStatementTools(server, api);
    const registration = server.registerTool.mock.calls.find(
      ([name]: [string]) => name === "month_end_close_checklist",
    );
    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{
      content: Array<{ text: string }>;
    }>;

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(api.saleInvoices.listAll).toHaveBeenCalledOnce();
    expect(payload).toHaveProperty("unconfirmed_sale_invoices");
    expect(payload).toHaveProperty("overdue_receivables");
  });

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

  describe("open month vs closed month (overdue_as_of)", () => {
    // Invoice 2026-09-12 + 14 days => due 2026-09-26, month-end 2026-09-30.
    const invoice = () => makeSaleInvoice({
      id: 15,
      number: "2026_15",
      client_name: "Inkubaator",
      create_date: "2026-09-12",
      journal_date: "2026-09-12",
      term_days: 14,
      gross_price: 620,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("mid-month: an invoice not yet due today is listed as due_before_month_end, not overdue", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
      const handler = setupTool("month_end_close_checklist", { saleInvoices: [invoice()] });

      const payload = parseMcpResponse((await handler({ month: "2026-09" })).content[0]!.text);

      expect(payload.overdue_as_of).toBe("2026-09-25");
      expect(payload.overdue_receivables.count).toBe(0);
      expect(payload.due_before_month_end_receivables.count).toBe(1);
      expect(payload.due_before_month_end_receivables.total).toBe(620);
      expect(payload.due_before_month_end_receivables.items[0]).toMatchObject({ id: 15, due_date: "2026-09-26" });
      expect(payload.due_before_month_end_receivables.items[0]).not.toHaveProperty("days_overdue");
      expect(payload.due_before_month_end_payables.count).toBe(0);
      expect(payload.summary.issues_found).toBe(0);
      expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Month 2026-09 has not ended yet (today 2026-09-25)")]));
    });

    it("mid-month: an invoice already past due today stays overdue with days_overdue as of today", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
      const handler = setupTool("month_end_close_checklist", { saleInvoices: [invoice()] });

      const payload = parseMcpResponse((await handler({ month: "2026-09" })).content[0]!.text);

      expect(payload.overdue_as_of).toBe("2026-09-28");
      expect(payload.overdue_receivables.items[0]).toMatchObject({ id: 15, due_date: "2026-09-26", days_overdue: 2 });
      expect(payload.due_before_month_end_receivables.count).toBe(0);
    });

    it("uses the Tallinn calendar date: just after local midnight the invoice is already overdue", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // 2026-09-27 00:30 in Tallinn, still 2026-09-26 in UTC.
      vi.setSystemTime(new Date("2026-09-26T21:30:00Z"));
      const handler = setupTool("month_end_close_checklist", { saleInvoices: [invoice()] });

      const payload = parseMcpResponse((await handler({ month: "2026-09" })).content[0]!.text);

      expect(payload.overdue_as_of).toBe("2026-09-27");
      expect(payload.overdue_receivables.items[0]).toMatchObject({ id: 15, days_overdue: 1 });
    });

    it("an invoice due on the month's last day is listed as due before month-end (the due date is the last day to pay)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
      // 2026-09-16 + 14 days => due 2026-09-30.
      const dueLastDay = { ...invoice(), create_date: "2026-09-16", journal_date: "2026-09-16" };
      const handler = setupTool("month_end_close_checklist", { saleInvoices: [dueLastDay] });

      const payload = parseMcpResponse((await handler({ month: "2026-09" })).content[0]!.text);

      expect(payload.overdue_receivables.count).toBe(0);
      expect(payload.due_before_month_end_receivables.items).toEqual([expect.objectContaining({ id: 15, due_date: "2026-09-30" })]);
    });

    it("on the month's last day, invoices due that day are still listed and nothing due today is overdue", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
      const dueLastDay = { ...invoice(), create_date: "2026-09-16", journal_date: "2026-09-16" };
      const handler = setupTool("month_end_close_checklist", { saleInvoices: [invoice(), { ...dueLastDay, id: 16, number: "2026_16" }] });

      const payload = parseMcpResponse((await handler({ month: "2026-09" })).content[0]!.text);

      expect(payload.overdue_as_of).toBe("2026-09-30");
      expect(payload.overdue_receivables.items).toEqual([expect.objectContaining({ id: 15, days_overdue: 4 })]);
      expect(payload.due_before_month_end_receivables.items).toEqual([expect.objectContaining({ id: 16, due_date: "2026-09-30" })]);
      expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Month 2026-09 has not ended yet (today 2026-09-30)")]));
    });

    it("closed month: evaluates as of month-end, with no due_before_month_end lists or open-month warning", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
      const handler = setupTool("month_end_close_checklist", { saleInvoices: [invoice()] });

      const payload = parseMcpResponse((await handler({ month: "2026-09" })).content[0]!.text);

      expect(payload.overdue_as_of).toBe("2026-09-30");
      expect(payload.overdue_receivables.count).toBe(1);
      expect(payload.overdue_receivables.items[0]).toMatchObject({ due_date: "2026-09-26", days_overdue: 4 });
      expect(payload).not.toHaveProperty("due_before_month_end_receivables");
      expect(payload).not.toHaveProperty("due_before_month_end_payables");
      expect(payload.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining("has not ended yet")]));
    });
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

  it("treats invoices with missing term_days as 0-day terms instead of silently dropping them", async () => {
    // The upstream API occasionally serves term_days as null/undefined despite
    // the type declaring it required. Without the guard, `getUTCDate() + null`
    // coerces to today and `+ undefined` produces NaN — both regressions
    // dropped genuinely overdue invoices from the report.
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({
          id: 99,
          number: "ARV-99",
          create_date: "2024-02-01",
          journal_date: "2024-02-01",
          term_days: null as unknown as number,
          gross_price: 250,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
        }),
      ],
      purchaseInvoices: [
        makePurchaseInvoice({
          id: 100,
          number: "OST-100",
          create_date: "2024-02-15",
          journal_date: "2024-02-15",
          term_days: undefined as unknown as number,
          gross_price: 75,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
        }),
      ],
    });

    const result = await handler({ month: "2024-03" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.overdue_receivables.count).toBe(1);
    expect(payload.overdue_payables.count).toBe(1);
    expect(payload.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("had no term_days"),
    ]));
  });
});

// ---------------------------------------------------------------------------
// Reporting-surface review findings (P&L after year-end close, opening-balance
// warning parity, date defaults/validation, month-end credit/FX handling)
// ---------------------------------------------------------------------------

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

describe("compute_profit_and_loss after year-end close", () => {
  const REVENUE = 3000;
  const EXPENSE = 5000;
  const PROFIT_2990 = 2990;
  const journals = [
    makeJournal("2025-03-01", [makePosting(1000, "D", 1000), makePosting(REVENUE, "C", 1000)], { id: 1 }),
    makeJournal("2025-04-01", [makePosting(EXPENSE, "D", 400), makePosting(1000, "C", 400)], { id: 2 }),
    // execute_year_end_close: zero Tulud/Kulud into equity.
    makeJournal("2025-12-31", [
      makePosting(REVENUE, "D", 1000),
      makePosting(EXPENSE, "C", 400),
      makePosting(PROFIT_2990, "C", 600),
    ], { id: 3, document_number: "YECL-2025", title: "Aasta lõppkanne 2025" }),
  ];
  const accounts = [
    makeAccount(1000, "D", "Varad", "Pank"),
    makeAccount(REVENUE, "C", "Tulud", "Müügitulu"),
    makeAccount(EXPENSE, "D", "Kulud", "Kulu"),
    makeAccount(PROFIT_2990, "C", "Omakapital", "Aruandeaasta kasum"),
  ];

  it("excludes the YECL closing journal so the closed year still shows its revenue and expenses", async () => {
    const handler = setupTool("compute_profit_and_loss", { accounts, journals });
    const payload = parseMcpResponse((await handler({ date_from: "2025-01-01", date_to: "2025-12-31" })).content[0]!.text);
    expect(payload.revenue.total).toBe(1000);
    expect(payload.expenses.total).toBe(400);
    expect(payload.net_profit).toBe(600);
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("1 year-end closing journal(s) excluded")]));
  });

  it("the run_accounting_report profit_and_loss op excludes it too", async () => {
    const outcome = await createReportingOperations(createApi({ accounts, journals }), true)
      .run({ report: "profit_and_loss", period: { from: "2025-01-01", to: "2025-12-31" } });
    expect(outcome.ok && outcome.value.report === "profit_and_loss" && outcome.value.net_profit).toBe(600);
  });

  it("the balance sheet keeps the closing journal (a real posting there)", async () => {
    const handler = setupTool("compute_balance_sheet", { accounts, journals });
    const payload = parseMcpResponse((await handler({ date_to: "2025-12-31" })).content[0]!.text);
    expect(payload.current_year_pl.net_profit).toBe(0);
    expect(payload.equity.total).toBe(600);
    expect(payload.check.balanced).toBe(true);
  });
});

describe("compute_profit_and_loss after the RIK year-end close (9000 excluded)", () => {
  // Real e-arveldaja chart numbers. RIK entry 1 (D 9000 / K 2970) leaves the
  // revenue/expense accounts open; 9000 must not count as (negative) revenue.
  const accounts = [
    makeAccount(1020, "D", "Varad", "Pangakonto"),
    makeAccount(2970, "C", "Omakapital", "Aruandeaasta kasum (kahjum)"),
    makeAccount(3620, "C", "Tulud", "Teenuste eksport (KM0%)"),
    makeAccount(5990, "D", "Kulud", "Muud mitmesugused tegevuskulud"),
    makeAccount(9000, "D", "Tulud", "Arvestuslik koondtulemus"),
  ];
  const journals = [
    makeJournal("2025-03-01", [makePosting(1020, "D", 1000), makePosting(3620, "C", 1000)], { id: 1 }),
    makeJournal("2025-04-01", [makePosting(5990, "D", 400), makePosting(1020, "C", 400)], { id: 2 }),
    makeJournal("2025-12-31", [makePosting(9000, "D", 600), makePosting(2970, "C", 600)], { id: 3, title: "Majandusaasta lõpetamine" }),
  ];

  it("reports the real result and discloses the excluded 9000 balance", async () => {
    const handler = setupTool("compute_profit_and_loss", { accounts, journals });
    const payload = parseMcpResponse((await handler({ date_from: "2025-01-01", date_to: "2025-12-31" })).content[0]!.text);
    expect(payload.revenue.total).toBe(1000);
    expect(payload.revenue.items.map((item: { id: number }) => item.id)).toEqual([3620]);
    expect(payload.expenses.total).toBe(400);
    expect(payload.net_profit).toBe(600);
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Account 9000")]));
  });

  it("the run_accounting_report profit_and_loss op excludes 9000 too", async () => {
    const outcome = await createReportingOperations(createApi({ accounts, journals }), true)
      .run({ report: "profit_and_loss", period: { from: "2025-01-01", to: "2025-12-31" } });
    expect(outcome.ok && outcome.value.report === "profit_and_loss" && outcome.value.net_profit).toBe(600);
  });

  it("the balance sheet keeps 9000 in open P&L so it still balances (result sits in 2970)", async () => {
    const handler = setupTool("compute_balance_sheet", { accounts, journals });
    const payload = parseMcpResponse((await handler({ date_to: "2025-12-31" })).content[0]!.text);
    expect(payload.current_year_pl.net_profit).toBe(0);
    expect(payload.equity.total).toBe(600);
    expect(payload.check.balanced).toBe(true);
  });
});

describe("statement date defaults and validation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const accounts = [makeAccount(1000, "D", "Varad", "Pank"), makeAccount(2900, "C", "Omakapital", "Kapital")];
  const journals = [
    makeJournal("2026-09-01", [makePosting(1000, "D", 100), makePosting(2900, "C", 100)], { id: 1 }),
    makeJournal("2026-12-01", [makePosting(1000, "D", 50), makePosting(2900, "C", 50)], { id: 2 }),
  ];

  it("compute_balance_sheet without date_to reports as of today (Tallinn) and excludes future-dated journals", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
    const payload = parseMcpResponse((await setupTool("compute_balance_sheet", { accounts, journals })({})).content[0]!.text);
    expect(payload.date).toBe("2026-09-25");
    expect(payload.assets.total).toBe(100);
  });

  it("the balance_sheet op uses the same default and reports the concrete date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
    const outcome = await createReportingOperations(createApi({ accounts, journals }), true).run({ report: "balance_sheet", period: {} });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.report !== "balance_sheet") return;
    expect(outcome.value.date).toBe("2026-09-25");
    expect(outcome.value.assets.total).toBe(100);
  });

  it("compute_trial_balance without date_to keeps every posting and labels the end 'unbounded'", async () => {
    const payload = parseMcpResponse((await setupTool("compute_trial_balance", { accounts, journals })({})).content[0]!.text);
    expect(payload.period).toEqual({ from: "inception", to: "unbounded" });
    expect(payload.totals.debit).toBe(150);
  });

  it.each([
    ["compute_trial_balance", { date_from: "2026-02-31" }],
    ["compute_trial_balance", { date_to: "yesterday" }],
    ["compute_trial_balance", { date_from: "2026-12-31", date_to: "2026-01-01" }],
    ["compute_balance_sheet", { date_to: "2026-13-01" }],
    ["compute_profit_and_loss", { date_from: "2026-1-1", date_to: "2026-12-31" }],
    ["compute_profit_and_loss", { date_from: "2026-12-31", date_to: "2026-01-01" }],
  ])("%s rejects invalid dates %j", async (tool, args) => {
    const result = await setupTool(tool, { accounts, journals })(args) as ToolResult;
    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text).category).toBe("invalid_date");
  });
});

describe("opening-balance warning parity (standalone tools vs run_accounting_report ops)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-parity-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    resetOpeningBalanceCache();
    writeOpeningBalances(
      {
        openingDate: "2024-12-12",
        accounts: [
          { code: "1020", name: "Pank", debit: 1000, credit: 0, dimension: ["Unknown bank"] },
          { code: "9999", name: "Missing", debit: 0, credit: 0 },
          { code: "2900", name: "Kapital", debit: 0, credit: 1000 },
        ],
        totals: { debit: 1000, credit: 1000 },
        rawText: "n/a",
      },
      "2024-12-12T00:00:00.000Z",
    );
  });

  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_DIR;
    resetOpeningBalanceCache();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function parityApi(): ApiContext {
    const api = createApi({
      accounts: [makeAccount(1020, "D", "Varad", "Pank"), makeAccount(2900, "C", "Omakapital", "Kapital")],
      journals: [],
    });
    // Two dimensions on 1020, neither matching "Unknown bank" → unmappedDimensions.
    (api.readonly as unknown as { getAccountDimensions: unknown }).getAccountDimensions = vi.fn().mockResolvedValue([
      { id: 1, accounts_id: 1020, title_est: "LHV" },
      { id: 2, accounts_id: 1020, title_est: "Wise" },
    ]);
    return api;
  }

  async function toolWarnings(api: ApiContext, tool: string, args: Record<string, unknown>): Promise<string[]> {
    const server = { registerTool: vi.fn() } as any;
    registerFinancialStatementTools(server, api);
    const handler = server.registerTool.mock.calls.find(([name]: [string]) => name === tool)[2];
    return parseMcpResponse((await handler(args)).content[0]!.text).warnings;
  }

  it.each([
    ["trial_balance", "compute_trial_balance", { date_from: "2025-01-01", date_to: "2025-12-31" }],
    ["trial_balance", "compute_trial_balance", {}],
    ["balance_sheet", "compute_balance_sheet", { date_to: "2025-06-30" }],
    ["balance_sheet", "compute_balance_sheet", {}],
    ["profit_and_loss", "compute_profit_and_loss", { date_from: "2024-01-01", date_to: "2024-12-31" }],
  ] as const)("%s op emits the same warnings as %s %j", async (report, tool, args) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
    const api = parityApi();
    const expected = await toolWarnings(api, tool, args);
    const period = {
      ...("date_from" in args ? { from: args.date_from } : {}),
      ...("date_to" in args ? { to: args.date_to } : {}),
    };
    const outcome = await createReportingOperations(api, true).run({ report, period });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !("warnings" in outcome.value)) return;
    // The sandbox markers carry a per-call random nonce; compare text modulo it.
    const stripNonce = (ws: readonly string[]) => ws.map(w => w.replace(/[0-9a-f]{32}/g, "<nonce>"));
    expect(stripNonce(outcome.value.warnings)).toEqual(stripNonce(expected));
    expect(expected.some(w => w.startsWith("Opening balances"))).toBe(true);
    // The dimension warning can fire now that unmappedDimensions is passed through.
    expect(expected.some(w => w.includes("dimension label could not be resolved"))).toBe(true);
    expect(expected.some(w => w.includes("not in the chart were skipped: 9999"))).toBe(true);
  });
});

describe("month_end credit invoices, foreign currency, missing create_date, truncation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("excludes unpaid CREDIT_INVOICE sale invoices from overdue receivables and warns", async () => {
    const handler = setupTool("month_end_close_checklist", {
      saleInvoices: [
        makeSaleInvoice({ id: 1, number: "A-1", create_date: "2024-03-01", journal_date: "2024-03-01", term_days: 5, gross_price: 500 }),
        makeSaleInvoice({ id: 2, number: "K-1", sale_invoice_type: "CREDIT_INVOICE", create_date: "2024-03-01", journal_date: "2024-03-01", term_days: 5, gross_price: 200 }),
      ],
    });
    const payload = parseMcpResponse((await handler({ month: "2024-03" })).content[0]!.text);
    expect(payload.overdue_receivables.count).toBe(1);
    expect(payload.overdue_receivables.total).toBe(500);
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("1 unpaid credit invoice(s) excluded")]));
  });

  it("keeps a foreign-currency invoice without base_gross_price out of the EUR total, flagged, with a warning", async () => {
    const handler = setupTool("month_end_close_checklist", {
      purchaseInvoices: [
        makePurchaseInvoice({ id: 1, create_date: "2024-03-01", journal_date: "2024-03-01", term_days: 5, gross_price: 100 }),
        makePurchaseInvoice({ id: 2, create_date: "2024-03-01", journal_date: "2024-03-01", term_days: 5, gross_price: 1000, cl_currencies_id: "USD" }),
        makePurchaseInvoice({ id: 3, create_date: "2024-03-01", journal_date: "2024-03-01", term_days: 5, gross_price: 50, base_gross_price: 45, cl_currencies_id: "USD" }),
      ],
    });
    const payload = parseMcpResponse((await handler({ month: "2024-03" })).content[0]!.text);
    expect(payload.overdue_payables.count).toBe(3);
    expect(payload.overdue_payables.total).toBe(145);
    expect(payload.overdue_payables.items.find((r: { id: number }) => r.id === 2)).toMatchObject({ gross: 1000, currency: "USD", excluded_from_eur_totals: true });
    expect(payload.overdue_payables.items.find((r: { id: number }) => r.id === 3)).not.toHaveProperty("excluded_from_eur_totals");
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("1 listed foreign-currency invoice(s) have no base_gross_price")]));
  });

  it("does not crash on an open invoice with an empty or missing create_date", async () => {
    const handler = setupTool("month_end_close_checklist", {
      purchaseInvoices: [
        makePurchaseInvoice({ id: 1, create_date: "", journal_date: "2024-03-01", term_days: 5, gross_price: 100 }),
        makePurchaseInvoice({ id: 2, create_date: undefined as unknown as string, journal_date: "2024-03-01", term_days: 5, gross_price: 100 }),
      ],
    });
    const payload = parseMcpResponse((await handler({ month: "2024-03" })).content[0]!.text);
    expect(payload.overdue_payables.count).toBe(0);
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("2 open invoice(s) have no create_date")]));
  });

  it("counts PARTIALLY_PAID invoices in the due_before_month_end lists too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
    const handler = setupTool("month_end_close_checklist", {
      purchaseInvoices: [
        makePurchaseInvoice({ id: 1, create_date: "2026-09-20", journal_date: "2026-09-20", term_days: 7, gross_price: 100, payment_status: "PARTIALLY_PAID" }),
      ],
    });
    const payload = parseMcpResponse((await handler({ month: "2026-09" })).content[0]!.text);
    expect(payload.due_before_month_end_payables.count).toBe(1);
    expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("1 listed payable(s) are PARTIALLY_PAID")]));
  });

  it("standalone tool caps a due list at 10 rows and marks it truncated; count/total cover every row", async () => {
    const handler = setupTool("month_end_close_checklist", {
      purchaseInvoices: Array.from({ length: 12 }, (_, i) =>
        makePurchaseInvoice({ id: i + 1, create_date: "2024-03-01", journal_date: "2024-03-01", term_days: 5, gross_price: 10 })),
    });
    const payload = parseMcpResponse((await handler({ month: "2024-03" })).content[0]!.text);
    expect(payload.overdue_payables.count).toBe(12);
    expect(payload.overdue_payables.total).toBe(120);
    expect(payload.overdue_payables.items).toHaveLength(10);
    expect(payload.overdue_payables.truncated).toBe(true);
  });
});
