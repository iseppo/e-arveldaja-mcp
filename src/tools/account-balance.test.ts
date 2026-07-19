import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseMcpResponse } from "../mcp-json.js";
import type { Journal, Account } from "../types/api.js";
import { clearRuntimeCaches } from "../cache-control.js";
import { withOpeningBalanceStatus } from "../opening-balance-limitations.js";
import { writeOpeningBalances, resetOpeningBalanceCache } from "../opening-balance-store.js";
import { makeAccount } from "../__fixtures__/accounting.js";

// ---------------------------------------------------------------------------
// The module registers MCP tools but also exports computeAccountBalance via
// the internal function.  Because the function is not exported we test the
// observable behaviour through the registered tool handler by extracting the
// pure computation logic.  To keep the tests fast and dependency-free we
// re-implement the tiny computation inline and cross-check it; but the real
// value is testing the `computeAccountBalance` function indirectly by calling
// the tool handler that is registered on a minimal mock server.
// ---------------------------------------------------------------------------

// We need to reach the un-exported `computeAccountBalance`.  The simplest
// approach is to import the module and capture the handler passed to
// `registerTool` via a mock.

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

const capturedHandlers: Record<string, ToolHandler> = {};

vi.mock("../mcp-compat.js", () => ({
  registerTool: (
    _server: unknown,
    name: string,
    _description: string,
    _schema: unknown,
    _annotations: unknown,
    handler: ToolHandler,
  ) => {
    capturedHandlers[name] = handler;
  },
}));

vi.mock("../annotations.js", () => ({ readOnly: {} }));

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

// ---------------------------------------------------------------------------
// Build a minimal ApiContext factory
// ---------------------------------------------------------------------------

function makeApi(
  journals: Journal[],
  account: { id: number; name_est: string; name_eng: string; balance_type: string } | null = null,
  accounts: Account[] = [],
) {
  return {
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue(journals),
    },
    readonly: {
      getAccount: vi.fn().mockResolvedValue(account),
      getAccounts: vi.fn().mockResolvedValue(accounts),
    },
  };
}

// ---------------------------------------------------------------------------
// Import the module under test (side-effects register the tools)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let registerAccountBalanceTools: typeof import("./account-balance.js").registerAccountBalanceTools;

beforeEach(async () => {
  // Reset captured handlers between describe blocks
  for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
  clearRuntimeCachesMock.mockClear();
  ({ registerAccountBalanceTools } = await import("./account-balance.js"));
});

// ---------------------------------------------------------------------------
// Helper: build a Journal with postings
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compute_account_balance tool", () => {
  const ACCOUNT_ID = 1000;
  const D_ACCOUNT = { id: ACCOUNT_ID, name_est: "Kassa", name_eng: "Cash", balance_type: "D" };
  const C_ACCOUNT = { id: ACCOUNT_ID, name_est: "Laen", name_eng: "Loan", balance_type: "C" };

  function setup(journals: Journal[], account = D_ACCOUNT) {
    const api = makeApi(journals, account) as unknown as Parameters<typeof registerAccountBalanceTools>[1];
    const server = {} as Parameters<typeof registerAccountBalanceTools>[0];
    registerAccountBalanceTools(server, api);
    return capturedHandlers["compute_account_balance"]!;
  }

  function parse(text: string) {
    return parseMcpResponse(text) as Record<string, unknown>;
  }

  it("computes D-type balance as debits minus credits", async () => {
    const journals = [
      journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 2, postings: [posting(ACCOUNT_ID, "C", 200)] }),
    ];
    const handler = setup(journals, D_ACCOUNT);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.balance).toBe(300);
    expect(data.debit_total).toBe(500);
    expect(data.credit_total).toBe(200);
    expect(data.balance_type).toBe("D");
    expect(data.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Algbilansi kanded"),
    ]));
  });

  it("computes C-type balance as credits minus debits", async () => {
    const journals = [
      journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 100)] }),
      journal({ id: 2, postings: [posting(ACCOUNT_ID, "C", 700)] }),
    ];
    const handler = setup(journals, C_ACCOUNT);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.balance).toBe(600);   // C: credits - debits
    expect(data.debit_total).toBe(100);
    expect(data.credit_total).toBe(700);
    expect(data.balance_type).toBe("C");
  });

  it("clears runtime caches before computing when fresh is true", async () => {
    const handler = setup([], D_ACCOUNT);
    const result = await handler({ account_id: ACCOUNT_ID, fresh: true });
    const data = parse((result.content[0] as { text: string }).text);

    expect(clearRuntimeCachesMock).toHaveBeenCalledOnce();
    expect(data.cache).toEqual({
      fresh: true,
      cleared: true,
      scope: "all",
    });
  });

  it("returns zero balance for empty postings", async () => {
    const handler = setup([], D_ACCOUNT);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.balance).toBe(0);
    expect(data.debit_total).toBe(0);
    expect(data.credit_total).toBe(0);
    expect(data.entry_count).toBe(0);
  });

  it("filters by dateFrom — excludes journals before the start date", async () => {
    const journals = [
      journal({ id: 1, effective_date: "2024-01-01", postings: [posting(ACCOUNT_ID, "D", 100)] }),
      journal({ id: 2, effective_date: "2024-02-01", postings: [posting(ACCOUNT_ID, "D", 200)] }),
      journal({ id: 3, effective_date: "2024-03-01", postings: [posting(ACCOUNT_ID, "D", 400)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID, date_from: "2024-02-01" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.debit_total).toBe(600); // Feb + Mar
    expect(data.entry_count).toBe(2);
  });

  it("filters by dateTo — excludes journals after the end date", async () => {
    const journals = [
      journal({ id: 1, effective_date: "2024-01-01", postings: [posting(ACCOUNT_ID, "D", 100)] }),
      journal({ id: 2, effective_date: "2024-02-01", postings: [posting(ACCOUNT_ID, "D", 200)] }),
      journal({ id: 3, effective_date: "2024-03-01", postings: [posting(ACCOUNT_ID, "D", 400)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID, date_to: "2024-02-01" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.debit_total).toBe(300); // Jan + Feb
    expect(data.entry_count).toBe(2);
  });

  it("filters by dateFrom AND dateTo — inclusive on both ends", async () => {
    const journals = [
      journal({ id: 1, effective_date: "2024-01-01", postings: [posting(ACCOUNT_ID, "D", 100)] }),
      journal({ id: 2, effective_date: "2024-06-15", postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 3, effective_date: "2024-12-31", postings: [posting(ACCOUNT_ID, "D", 900)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID, date_from: "2024-01-01", date_to: "2024-06-15" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.debit_total).toBe(600);
    expect(data.entry_count).toBe(2);
  });

  it("filters by clients_id", async () => {
    const journals = [
      journal({ id: 1, clients_id: 42, postings: [posting(ACCOUNT_ID, "D", 1000)] }),
      journal({ id: 2, clients_id: 99, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 3, clients_id: null, postings: [posting(ACCOUNT_ID, "D", 250)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID, clients_id: 42 });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.debit_total).toBe(1000);
    expect(data.entry_count).toBe(1);
  });

  it("uses base_amount instead of amount for multi-currency postings", async () => {
    const journals = [
      journal({
        id: 1,
        postings: [posting(ACCOUNT_ID, "D", 1000 /* USD */, 920 /* EUR base */)],
      }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    // base_amount (920) takes priority over amount (1000)
    expect(data.debit_total).toBe(920);
  });

  it("skips deleted journals", async () => {
    const journals = [
      journal({ id: 1, is_deleted: true, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 2, postings: [posting(ACCOUNT_ID, "D", 100)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.debit_total).toBe(100);
  });

  it("skips unregistered journals", async () => {
    const journals = [
      journal({ id: 1, registered: false, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 2, registered: true, postings: [posting(ACCOUNT_ID, "D", 100)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.debit_total).toBe(100);
  });

  it("computes the correct net balance from raw D/C sums instead of drifting ±0.01 (D 1.005 / C 0.004)", async () => {
    // Raw D 1.005 / C 0.004 nets to 1.001, which rounds once to 1.00.
    // Rounding debitTotal (1.005 -> 1.01) and creditTotal (0.004 -> 0.00)
    // independently before subtracting would wrongly report 1.01.
    const journals = [
      journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 1.005)] }),
      journal({ id: 2, postings: [posting(ACCOUNT_ID, "C", 0.004)] }),
    ];
    const handler = setup(journals, D_ACCOUNT);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.balance).toBe(1.00);
  });

  it("computes the correct net balance from raw D/C sums for C-type accounts too (C 1.005 / D 0.004)", async () => {
    const journals = [
      journal({ id: 1, postings: [posting(ACCOUNT_ID, "C", 1.005)] }),
      journal({ id: 2, postings: [posting(ACCOUNT_ID, "D", 0.004)] }),
    ];
    const handler = setup(journals, C_ACCOUNT);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.balance).toBe(1.00);
  });

  it("skips postings for other accounts", async () => {
    const journals = [
      journal({
        id: 1,
        postings: [
          posting(ACCOUNT_ID, "D", 300),
          posting(9999, "D", 1000), // different account — must be ignored
        ],
      }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.debit_total).toBe(300);
    expect(data.entry_count).toBe(1);
  });
});

describe("opening balance folding", () => {
  const ACCOUNT_ID = 1020;
  const CONTRA_ACCOUNT_ID = 2900;
  const D_ACCOUNT = { id: ACCOUNT_ID, name_est: "Pank", name_eng: "Bank", balance_type: "D" };

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-account-balance-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    resetOpeningBalanceCache();
  });

  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_DIR;
    resetOpeningBalanceCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function registerWithApi(journals: Journal[], accounts: Account[] = []) {
    const api = makeApi(journals, D_ACCOUNT, accounts) as unknown as Parameters<typeof registerAccountBalanceTools>[1];
    const server = {} as Parameters<typeof registerAccountBalanceTools>[0];
    registerAccountBalanceTools(server, api);
    return capturedHandlers["compute_account_balance"]!;
  }

  const CHART: Account[] = [
    makeAccount(ACCOUNT_ID, "D", "Varad", "Pank", "Bank"),
    makeAccount(CONTRA_ACCOUNT_ID, "C", "Omakapital", "Kapital", "Capital"),
  ];

  it("folds a stored opening balance into compute_account_balance", async () => {
    writeOpeningBalances(
      {
        openingDate: "2024-12-12",
        accounts: [
          { code: String(ACCOUNT_ID), name: "Pank", debit: 1000, credit: 0 },
          { code: String(CONTRA_ACCOUNT_ID), name: "Kapital", debit: 0, credit: 1000 },
        ],
        totals: { debit: 1000, credit: 1000 },
        rawText: "n/a",
      },
      "2024-12-12T00:00:00.000Z",
    );

    const journals = [journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 500)] })];
    const handler = registerWithApi(journals, CHART);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parseMcpResponse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    expect(data.debit_total).toBe(1500); // 500 existing + 1000 opening
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(data.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("leaves figures unchanged and shows the actionable warning without a stored algbilanss", async () => {
    const journals = [journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 500)] })];
    const handler = registerWithApi(journals, CHART);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parseMcpResponse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    expect(data.debit_total).toBe(500);
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });
});

describe("compute_client_debt tool", () => {
  const CLIENT_ID = 42;
  const ACCOUNT_ID = 2110;
  const CLIENT_DEBT_ACCOUNT = {
    id: ACCOUNT_ID,
    name_est: "Võlg kliendile",
    name_eng: "Debt to client",
    balance_type: "C",
  };

  function setupClientDebtFixture() {
    const api = makeApi([
      journal({
        id: 1,
        clients_id: CLIENT_ID,
        postings: [posting(ACCOUNT_ID, "C", 100)],
      }),
      journal({
        id: 2,
        clients_id: CLIENT_ID,
        postings: [posting(ACCOUNT_ID, "D", 30)],
      }),
    ], CLIENT_DEBT_ACCOUNT);
    const server = {} as Parameters<typeof registerAccountBalanceTools>[0];
    registerAccountBalanceTools(
      server,
      api as unknown as Parameters<typeof registerAccountBalanceTools>[1],
    );

    return {
      handler: capturedHandlers["compute_client_debt"]!,
      listAllWithPostings: api.journals.listAllWithPostings,
    };
  }

  async function invokeClientDebtHandler() {
    const fixture = setupClientDebtFixture();
    const result = await fixture.handler({
      clients_id: CLIENT_ID,
      account_ids: String(ACCOUNT_ID),
      fresh: true,
    });

    return {
      data: parseMcpResponse(result.content[0]!.text) as Record<string, unknown>,
      listAllWithPostings: fixture.listAllWithPostings,
    };
  }

  it("preserves client debt totals and cache metadata", async () => {
    const { data, listAllWithPostings } = await invokeClientDebtHandler();

    expect(data.accounts).toEqual([{
      account_id: 2110,
      account_name: "Võlg kliendile",
      balance_type: "C",
      balance: 70,
      debit_total: 30,
      credit_total: 100,
      entry_count: 2,
    }]);
    expect(data.summary).toEqual({
      total_debt_to_client: 70,
      total_receivable_from_client: 0,
      net_position: -70,
    });
    expect(data.cache).toEqual({
      fresh: true,
      cleared: true,
      scope: "all",
    });
    expect(clearRuntimeCachesMock).toHaveBeenCalledOnce();
    expect(listAllWithPostings).toHaveBeenCalledOnce();
  });

  it("adds client debt opening-balance disclosure", async () => {
    const { data } = await invokeClientDebtHandler();

    expect(data.opening_balance_status).toBe("api_incomplete");
    expect(data.balance_scope).toBe("journal_api_visible_entries_only");
    expect(data.warnings).toEqual(withOpeningBalanceStatus([], { captured: false }));
  });
});
