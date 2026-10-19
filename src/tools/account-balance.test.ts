import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseMcpResponse, UNTRUSTED_OCR_START_PREFIX, UNTRUSTED_OCR_END_PREFIX } from "../mcp-json.js";
import type { Journal, Account } from "../types/api.js";
import { clearRuntimeCaches } from "../cache-control.js";
import { makeAccount } from "../__fixtures__/accounting.js";

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
      listAllWithPostings: vi.fn().mockResolvedValue(withApiOpening(journals)),
    },
    readonly: {
      getAccount: vi.fn().mockResolvedValue(account),
      getAccounts: vi.fn().mockResolvedValue(accounts),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
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
    expect(data.warnings).toEqual([]);
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

  it("reports draft journals on the account, which the balance leaves out", async () => {
    const journals = [
      journal({ id: 7, registered: false, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 8, registered: false, postings: [posting(ACCOUNT_ID, "C", 20), posting(ACCOUNT_ID, "D", 5)] }),
      journal({ id: 9, registered: false, postings: [posting(ACCOUNT_ID + 1, "D", 999)] }),
      journal({ id: 10, registered: false, is_deleted: true, postings: [posting(ACCOUNT_ID, "D", 999)] }),
      journal({ id: 11, registered: false, effective_date: "2024-03-01", postings: [posting(ACCOUNT_ID, "D", 999)] }),
      journal({ id: 2, registered: true, postings: [posting(ACCOUNT_ID, "D", 100)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID, date_to: "2024-02-01" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.balance).toBe(100);
    expect(data.unregistered_drafts).toEqual({ journal_count: 2, journal_ids: [7, 8], debit_total: 505, credit_total: 20 });
    expect((data.warnings as string[]).some(w => w.includes("2 unregistered (draft) journal(s)") && w.includes("batch_confirm_journals"))).toBe(true);
  });

  it("omits the draft report when every journal on the account is registered", async () => {
    const handler = setup([journal({ id: 2, postings: [posting(ACCOUNT_ID, "D", 100)] })]);
    const data = parse(((await handler({ account_id: ACCOUNT_ID })).content[0] as { text: string }).text);
    expect(data.unregistered_drafts).toBeUndefined();
    expect((data.warnings as string[] ?? []).some(w => w.includes("unregistered"))).toBe(false);
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

  describe("accounts_dimensions_id filter", () => {
    const LHV = 11;
    const WISE = 22;

    function setupWithDimensions(journals: Journal[]) {
      const api = makeApi(journals, D_ACCOUNT);
      api.readonly.getAccountDimensions.mockResolvedValue([
        { id: LHV, accounts_id: ACCOUNT_ID, title_est: "LHV" },
        { id: WISE, accounts_id: ACCOUNT_ID, title_est: "Wise" },
        { id: 33, accounts_id: 1360, title_est: "Other account" },
      ]);
      registerAccountBalanceTools({} as Parameters<typeof registerAccountBalanceTools>[0], api as unknown as Parameters<typeof registerAccountBalanceTools>[1]);
      return capturedHandlers["compute_account_balance"]!;
    }

    const journals = [
      journal({ id: 1, postings: [{ ...posting(ACCOUNT_ID, "D", 29.79), accounts_dimensions_id: LHV }] }),
      journal({ id: 2, postings: [{ ...posting(ACCOUNT_ID, "D", 300), accounts_dimensions_id: WISE }] }),
      journal({ id: 3, postings: [{ ...posting(ACCOUNT_ID, "C", 48.28), accounts_dimensions_id: WISE }] }),
      journal({ id: 4, registered: false, postings: [{ ...posting(ACCOUNT_ID, "C", 5), accounts_dimensions_id: LHV }] }),
    ];

    it("counts only postings on the requested dimension", async () => {
      const handler = setupWithDimensions(journals);
      const data = parse((await handler({ account_id: ACCOUNT_ID, accounts_dimensions_id: WISE, include_entries: true })).content[0]!.text);
      expect(data.balance).toBe(251.72);
      expect(data.entry_count).toBe(2);
      expect(data.accounts_dimensions_id).toBe(WISE);
      expect((data.entries as Array<{ journal_id: number }>).map(e => e.journal_id)).toEqual([2, 3]);
      // The LHV draft is not on this dimension, so no draft warning.
      expect(data.unregistered_drafts).toBeUndefined();
    });

    it("still returns the whole-account total without the filter", async () => {
      const handler = setupWithDimensions(journals);
      const data = parse((await handler({ account_id: ACCOUNT_ID })).content[0]!.text);
      expect(data.balance).toBe(281.51);
    });

    it("refuses a dimension that belongs to another account", async () => {
      const handler = setupWithDimensions(journals);
      const result = await handler({ account_id: ACCOUNT_ID, accounts_dimensions_id: 33 }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(parse(result.content[0]!.text).code).toBe("dimension_account_mismatch");
    });

    it("refuses an unknown dimension", async () => {
      const handler = setupWithDimensions(journals);
      const result = await handler({ account_id: ACCOUNT_ID, accounts_dimensions_id: 999 }) as { isError?: boolean };
      expect(result.isError).toBe(true);
    });
  });
});

describe("compute_account_dimension_balances tool", () => {
  const ACCOUNT_ID = 1020;
  const D_ACCOUNT = { id: ACCOUNT_ID, name_est: "Pank", name_eng: "Bank", balance_type: "D" };
  const DIM_A = { id: 12637392, accounts_id: ACCOUNT_ID, title_est: "LHV" };
  const DIM_B = { id: 13172505, accounts_id: ACCOUNT_ID, title_est: "Wise" };

  function dimPosting(type: "D" | "C", amount: number, dimensionId: number | null) {
    return { ...posting(ACCOUNT_ID, type, amount), accounts_dimensions_id: dimensionId };
  }

  function setup(
    journals: Journal[],
    account = D_ACCOUNT,
    dimensions: Array<{ id?: number; accounts_id: number; title_est: string }> = [DIM_A, DIM_B],
  ) {
    const api = {
      journals: { listAllWithPostings: vi.fn().mockResolvedValue(withApiOpening(journals)) },
      readonly: {
        getAccount: vi.fn().mockResolvedValue(account),
        getAccounts: vi.fn().mockResolvedValue([]),
        getAccountDimensions: vi.fn().mockResolvedValue(dimensions),
      },
    } as unknown as Parameters<typeof registerAccountBalanceTools>[1];
    const server = {} as Parameters<typeof registerAccountBalanceTools>[0];
    registerAccountBalanceTools(server, api);
    return capturedHandlers["compute_account_dimension_balances"]!;
  }

  function parse(text: string) {
    return parseMcpResponse(text) as Record<string, unknown>;
  }

  it("counts draft journals per dimension without adding them to the balance", async () => {
    const journals = [
      journal({ id: 1, postings: [dimPosting("D", 1000, DIM_A.id)] }),
      journal({ id: 2, postings: [dimPosting("D", 50, DIM_B.id)] }),
      journal({ id: 3, registered: false, postings: [dimPosting("D", 743.54, DIM_B.id)] }),
    ];
    const data = parse(((await setup(journals)({ account_id: ACCOUNT_ID })).content[0] as { text: string }).text);
    const rows = data.dimensions as Array<Record<string, unknown>>;
    expect(rows.find(r => r.dimension_id === DIM_B.id)).toMatchObject({ balance: 50, unregistered_entry_count: 1 });
    expect(rows.find(r => r.dimension_id === DIM_A.id)!.unregistered_entry_count).toBeUndefined();
    expect(data.total).toBe(1050);
    expect(data.unregistered_drafts).toMatchObject({ journal_count: 1, journal_ids: [3], debit_total: 743.54 });
  });

  it("lists a dimension that holds only drafts as a zero-balance row", async () => {
    const journals = [
      journal({ id: 1, postings: [dimPosting("D", 1000, DIM_A.id)] }),
      journal({ id: 2, registered: false, postings: [dimPosting("D", 300, DIM_B.id)] }),
    ];
    const data = parse(((await setup(journals)({ account_id: ACCOUNT_ID })).content[0] as { text: string }).text);
    const rows = data.dimensions as Array<Record<string, unknown>>;
    expect(rows.find(r => r.dimension_id === DIM_B.id)).toMatchObject({
      balance: 0, debit_total: 0, credit_total: 0, entry_count: 0, unregistered_entry_count: 1,
    });
    expect(data.total).toBe(1000);
  });

  it("splits account 1020 into per-dimension rows that sum to the account total", async () => {
    const journals = [
      journal({ id: 1, postings: [dimPosting("D", 1000, DIM_A.id)] }),
      journal({ id: 2, postings: [dimPosting("C", 200, DIM_A.id)] }),
      journal({ id: 3, postings: [dimPosting("D", 50, DIM_B.id)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);

    const dims = data.dimensions as Array<Record<string, unknown>>;
    const dimA = dims.find(d => d.dimension_id === DIM_A.id);
    const dimB = dims.find(d => d.dimension_id === DIM_B.id);
    expect(dimA?.balance).toBe(800);
    expect(dimB?.balance).toBe(50);
    expect(data.total).toBe(850);
  });

  it("puts postings with no dimension in the (määramata) bucket", async () => {
    const journals = [
      journal({ id: 1, postings: [dimPosting("D", 300, null)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parse((result.content[0] as { text: string }).text);

    const dims = data.dimensions as Array<Record<string, unknown>>;
    const row = dims.find(d => d.dimension_id === null);
    expect(row).toBeDefined();
    expect(row?.title).toBe("(määramata)");
    expect(row?.balance).toBe(300);
  });

  it("reconciles the per-dimension total to compute_account_balance for the same account", async () => {
    const journals = [
      journal({ id: 1, postings: [dimPosting("D", 1000, DIM_A.id)] }),
      journal({ id: 2, postings: [dimPosting("C", 200, DIM_A.id)] }),
      journal({ id: 3, postings: [dimPosting("D", 50, DIM_B.id)] }),
      journal({ id: 4, postings: [dimPosting("D", 75, null)] }),
    ];

    const dimHandler = setup(journals);
    const dimResult = await dimHandler({ account_id: ACCOUNT_ID });
    const dimData = parse((dimResult.content[0] as { text: string }).text);

    const balanceApi = makeApi(journals, D_ACCOUNT) as unknown as Parameters<typeof registerAccountBalanceTools>[1];
    const balanceServer = {} as Parameters<typeof registerAccountBalanceTools>[0];
    for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
    registerAccountBalanceTools(balanceServer, balanceApi);
    const balanceHandler = capturedHandlers["compute_account_balance"]!;
    const balanceResult = await balanceHandler({ account_id: ACCOUNT_ID });
    const balanceData = parse((balanceResult.content[0] as { text: string }).text);

    expect(dimData.total).toBe(balanceData.balance);
  });
});

describe("compute_account_dimension_balances tool — unmapped opening-balance dimensions", () => {
  const ACCOUNT_ID = 1020;
  const D_ACCOUNT = { id: ACCOUNT_ID, name_est: "Pank", name_eng: "Bank", balance_type: "D" };
  const DIM_A = { id: 12637392, accounts_id: ACCOUNT_ID, title_est: "AS LHV Pank" };
  const DIM_B = { id: 13172505, accounts_id: ACCOUNT_ID, title_est: "WISE" };

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-dim-balance-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    resetApiOpening();
  });
  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_DIR;
    resetApiOpening();
    rmSync(dir, { recursive: true, force: true });
  });

  it("discloses real API opening postings without a dimension", async () => {
    seedApiOpening({
      openingDate: "2024-12-12",
      accounts: [{ code: String(ACCOUNT_ID), debit: 1000, credit: 0 }],
    });

    const api = {
      journals: { listAllWithPostings: vi.fn().mockResolvedValue(withApiOpening([])) },
      readonly: {
        getAccount: vi.fn().mockResolvedValue(D_ACCOUNT),
        getAccounts: vi.fn().mockResolvedValue([makeAccount(ACCOUNT_ID, "D", "Varad", "Pank", "Bank")]),
        getAccountDimensions: vi.fn().mockResolvedValue([DIM_A, DIM_B]),
      },
    } as unknown as Parameters<typeof registerAccountBalanceTools>[1];
    const server = {} as Parameters<typeof registerAccountBalanceTools>[0];
    registerAccountBalanceTools(server, api);
    const handler = capturedHandlers["compute_account_dimension_balances"]!;

    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parseMcpResponse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    const warnings = data.warnings as string[];

    expect(warnings.join(" ")).toMatch(/1000\.00.*dimension|dimension.*1000\.00/is);
    expect(warnings.join(" ")).not.toMatch(/import_opening|paste|fallback/i);
  });

  it("compute_account_balance warns that an unattributed opening balance is outside a dimension-scoped figure", async () => {
    seedApiOpening(
      {
        openingDate: "2024-12-12",
        accounts: [{ code: String(ACCOUNT_ID), name: "Pank", debit: 1000, credit: 0, dimension: ["no such bank"] }],
        totals: { debit: 1000, credit: 0 },
      } as unknown as Parameters<typeof seedApiOpening>[0],
    );
    const api = {
      journals: { listAllWithPostings: vi.fn().mockResolvedValue(withApiOpening([
        journal({ id: 5, effective_date: "2025-01-10", postings: [{ ...posting(ACCOUNT_ID, "D", 40), accounts_dimensions_id: DIM_B.id }] }),
      ])) },
      readonly: {
        getAccount: vi.fn().mockResolvedValue(D_ACCOUNT),
        getAccounts: vi.fn().mockResolvedValue([makeAccount(ACCOUNT_ID, "D", "Varad", "Pank", "Bank")]),
        getAccountDimensions: vi.fn().mockResolvedValue([DIM_A, DIM_B]),
      },
    } as unknown as Parameters<typeof registerAccountBalanceTools>[1];
    registerAccountBalanceTools({} as Parameters<typeof registerAccountBalanceTools>[0], api);
    const handler = capturedHandlers["compute_account_balance"]!;
    const warningsOf = async (args: Record<string, unknown>) => {
      const data = parseMcpResponse((await handler(args)).content[0]!.text) as Record<string, unknown>;
      return { balance: data.balance, warnings: data.warnings as string[] };
    };

    const scoped = await warningsOf({ account_id: ACCOUNT_ID, accounts_dimensions_id: DIM_B.id });
    expect(scoped.balance).toBe(40);
    expect(scoped.warnings.some(w => w.includes("1000.00 EUR") && w.includes("NOT in this dimension-scoped figure"))).toBe(true);

    // Whole account: the opening balance is in the figure, so no such warning.
    const whole = await warningsOf({ account_id: ACCOUNT_ID });
    expect(whole.balance).toBe(1040);
    expect(whole.warnings.some(w => w.includes("dimension-scoped"))).toBe(false);

    // Range starting after the opening date: the opening balance is not in range at all.
    const later = await warningsOf({ account_id: ACCOUNT_ID, accounts_dimensions_id: DIM_B.id, date_from: "2025-01-01" });
    expect(later.warnings.some(w => w.includes("dimension-scoped"))).toBe(false);
  });
});

describe("API INITIAL precedence and client attribution", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "api-initial-account-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    resetApiOpening();
  });
  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_DIR;
    resetApiOpening();
    rmSync(dir, { recursive: true, force: true });
  });
  function setupApi(journals: Journal[], accountId = 1020, balanceType = "D") {
    const account = { id: accountId, name_est: "Konto", name_eng: "Account", balance_type: balanceType };
    const api = makeApi(journals, account, [makeAccount(accountId, balanceType, "Varad")]);
    api.readonly.getAccountDimensions.mockResolvedValue([{ id: 101, accounts_id: accountId, title_est: "Bank" }] as any);
    registerAccountBalanceTools({} as any, api as any);
  }
  it("counts API 1000 plus movement 500 once and preserves dates", async () => {
    setupApi([
      journal({ id: 800, operation_type: "INITIAL", effective_date: "2023-12-31", postings: [posting(1020, "D", 1000)] }),
      journal({ id: 801, postings: [posting(1020, "D", 500)] }),
    ]);
    const all = parseMcpResponse((await capturedHandlers.compute_account_balance!({ account_id: 1020 })).content[0]!.text) as any;
    expect(all.balance).toBe(1500);
    expect(all.debit_total).toBe(1500);
    const period = parseMcpResponse((await capturedHandlers.compute_account_balance!({ account_id: 1020, date_from: "2024-01-01" })).content[0]!.text) as any;
    expect(period.balance).toBe(500);
  });
  it.each([
    { client: 42, balance: 1070, entries: 3, other: 0 },
    { client: 99, balance: 70, entries: 2, other: 1 },
    { client: null, balance: 70, entries: 2, other: 0 },
  ])("counts INITIAL client $client without subtracting selected client entries twice", async ({ client, balance, entries, other }) => {
    setupApi([
      journal({ id: 800, operation_type: "INITIAL", clients_id: client, postings: [posting(2110, "C", 1000)] }),
      journal({ id: 801, clients_id: 42, postings: [posting(2110, "C", 100)] }),
      journal({ id: 802, clients_id: 42, postings: [posting(2110, "D", 30)] }),
    ], 2110, "C");
    const data = parseMcpResponse((await capturedHandlers.compute_client_debt!({ clients_id: 42, account_ids: "2110" })).content[0]!.text) as any;
    expect(data.accounts[0]).toMatchObject({ balance, entry_count: entries, account_balance_all_clients: 1070, other_client_entry_count: other });
  });
  it("discloses an API bank opening without a dimension while leaving whole-account figures intact", async () => {
    setupApi([
      journal({ id: 800, operation_type: "INITIAL", postings: [posting(1020, "D", 1000)] }),
      journal({ id: 801, postings: [{ ...posting(1020, "D", 40), accounts_dimensions_id: 101 }] }),
    ]);
    const scoped = parseMcpResponse((await capturedHandlers.compute_account_balance!({ account_id: 1020, accounts_dimensions_id: 101 })).content[0]!.text) as any;
    expect(scoped.balance).toBe(40);
    expect(scoped.warnings.join(" ")).toMatch(/1000\.00/);
    expect(scoped.warnings.join(" ")).toMatch(/dimension/i);
    const whole = parseMcpResponse((await capturedHandlers.compute_account_balance!({ account_id: 1020 })).content[0]!.text) as any;
    expect(whole.balance).toBe(1040);
    const breakdown = parseMcpResponse((await capturedHandlers.compute_account_dimension_balances!({ account_id: 1020 })).content[0]!.text) as any;
    expect(breakdown.total).toBe(1040);
    expect(breakdown.dimensions.find((row: any) => row.dimension_id === null).balance).toBe(1000);
    expect(breakdown.warnings.join(" ")).toMatch(/partial dimension attribution/i);
    expect(breakdown.warnings.join(" ")).toMatch(/1000\.00/);
    expect(breakdown.warnings.join(" ")).toMatch(/Correct.*INITIAL.*e-arveldaja/);
    expect(breakdown.warnings.join(" ")).not.toMatch(/not in this.*figure|re-import/i);
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
    resetApiOpening();
  });

  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_DIR;
    resetApiOpening();
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

  it("folds a API opening balance into compute_account_balance", async () => {
    seedApiOpening(
      {
        openingDate: "2024-12-12",
        accounts: [
          { code: String(ACCOUNT_ID), name: "Pank", debit: 1000, credit: 0 },
          { code: String(CONTRA_ACCOUNT_ID), name: "Kapital", debit: 0, credit: 1000 },
        ],
        totals: { debit: 1000, credit: 1000 },
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

  it("leaves figures unchanged without an API INITIAL", async () => {
    const journals = [journal({ id: 1, postings: [posting(ACCOUNT_ID, "D", 500)] })];
    const handler = registerWithApi(journals, CHART);
    const result = await handler({ account_id: ACCOUNT_ID });
    const data = parseMcpResponse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    expect(data.debit_total).toBe(500);
    expect(data.warnings).toEqual([]);
  });

  it("shows the out-of-window note (not 'applied', not 'paste it') when date_to excludes the API opening balance", async () => {
    seedApiOpening(
      {
        openingDate: "2024-12-12",
        accounts: [
          { code: String(ACCOUNT_ID), name: "Pank", debit: 1000, credit: 0 },
          { code: String(CONTRA_ACCOUNT_ID), name: "Kapital", debit: 0, credit: 1000 },
        ],
        totals: { debit: 1000, credit: 1000 },
      },
      "2024-12-12T00:00:00.000Z",
    );

    const journals = [journal({ id: 1, effective_date: "2024-01-15", postings: [posting(ACCOUNT_ID, "D", 500)] })];
    const handler = registerWithApi(journals, CHART);
    const result = await handler({ account_id: ACCOUNT_ID, date_to: "2024-06-01" });
    const data = parseMcpResponse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    // date_to (2024-06-01) is before the opening date (2024-12-12), so the
    // opening journal is excluded from the figure — only the in-window
    // regular journal (500) is counted, not 500 + 1000.
    expect(data.debit_total).toBe(500);
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("outside this date range")]),
    );
    expect(data.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(data.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances are not captured")]),
    );
  });

  it("excludes the API opening balance and does NOT claim 'applied' when clients_id is passed", async () => {
    seedApiOpening(
      {
        openingDate: "2024-12-12",
        accounts: [
          { code: String(ACCOUNT_ID), name: "Pank", debit: 1000, credit: 0 },
          { code: String(CONTRA_ACCOUNT_ID), name: "Kapital", debit: 0, credit: 1000 },
        ],
        totals: { debit: 1000, credit: 1000 },
      },
      "2024-12-12T00:00:00.000Z",
    );

    const CLIENT_ID = 42;
    const journals = [journal({ id: 1, clients_id: CLIENT_ID, postings: [posting(ACCOUNT_ID, "D", 500)] })];
    const handler = registerWithApi(journals, CHART);
    const result = await handler({ account_id: ACCOUNT_ID, clients_id: CLIENT_ID });
    const data = parseMcpResponse((result.content[0] as { text: string }).text) as Record<string, unknown>;

    // The API INITIAL journal has clients_id: null, so the client
    // filter excludes it — the figure must reflect ONLY the client's own
    // 500, not 500 + 1000 opening.
    expect(data.debit_total).toBe(500);
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("no client attribution")]),
    );
    expect(data.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
    expect(data.warnings).not.toEqual(
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
      account_balance_all_clients: 70,
      other_client_entry_count: 0,
    }]);
    expect(data.summary).toEqual({
      total_debt_to_client: 70,
      total_receivable_from_client: 0,
      net_position: -70,
      filter_scope: "journal_header_client",
    });
    expect(data.cache).toEqual({
      fresh: true,
      cleared: true,
      scope: "all",
    });
    expect(clearRuntimeCachesMock).toHaveBeenCalledOnce();
    expect(listAllWithPostings).toHaveBeenCalledOnce();
  });

  it("flags net_position as needing counterpart review when other clients share the account", async () => {
    const api = makeApi([
      journal({ id: 1, clients_id: CLIENT_ID, postings: [posting(ACCOUNT_ID, "D", 100)] }),
      journal({ id: 2, clients_id: 99, postings: [posting(ACCOUNT_ID, "C", 100)] }),
    ], CLIENT_DEBT_ACCOUNT);
    registerAccountBalanceTools({} as Parameters<typeof registerAccountBalanceTools>[0], api as unknown as Parameters<typeof registerAccountBalanceTools>[1]);
    const result = await capturedHandlers["compute_client_debt"]!({ clients_id: CLIENT_ID, account_ids: String(ACCOUNT_ID) });
    const data = parseMcpResponse(result.content[0]!.text) as any;
    expect(data.accounts[0]).toMatchObject({ balance: -100, account_balance_all_clients: 0, other_client_entry_count: 1 });
    expect(data.summary).toMatchObject({ filter_scope: "journal_header_client", net_position_status: "requires_counterpart_review" });
    expect(data.warnings[0]).toContain("NOT proven debt");
  });

  it("reports a normal client scope when no INITIAL exists", async () => {
    const { data } = await invokeClientDebtHandler();

    expect(data.opening_balance_status).toBe("not_present");
    expect(data.balance_scope).toBe("journal_header_client");
    expect(data.warnings).toEqual([]);
  });
});

describe("compute_client_debt tool — opening balance folding", () => {
  const CLIENT_ID = 42;
  const ACCOUNT_ID = 2110;
  const CLIENT_DEBT_ACCOUNT = {
    id: ACCOUNT_ID,
    name_est: "Võlg kliendile",
    name_eng: "Debt to client",
    balance_type: "C",
  };
  const CHART: Account[] = [makeAccount(ACCOUNT_ID, "C", "Kohustused", "Võlg kliendile", "Debt to client")];

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob-client-debt-"));
    process.env.EARVELDAJA_RULES_DIR = dir;
    resetApiOpening();
  });

  afterEach(() => {
    delete process.env.EARVELDAJA_RULES_DIR;
    resetApiOpening();
    rmSync(dir, { recursive: true, force: true });
  });

  it("excludes the API opening balance (clients_id is mandatory) and does NOT report 'complete'", async () => {
    seedApiOpening(
      {
        openingDate: "2024-12-12",
        accounts: [
          { code: String(ACCOUNT_ID), name: "Võlg kliendile", debit: 0, credit: 1000 },
        ],
        totals: { debit: 1000, credit: 1000 },
      },
      "2024-12-12T00:00:00.000Z",
    );

    const api = makeApi([
      journal({ id: 1, clients_id: CLIENT_ID, postings: [posting(ACCOUNT_ID, "C", 100)] }),
      journal({ id: 2, clients_id: CLIENT_ID, postings: [posting(ACCOUNT_ID, "D", 30)] }),
    ], CLIENT_DEBT_ACCOUNT, CHART);
    const server = {} as Parameters<typeof registerAccountBalanceTools>[0];
    registerAccountBalanceTools(server, api as unknown as Parameters<typeof registerAccountBalanceTools>[1]);

    const result = await capturedHandlers["compute_client_debt"]!({
      clients_id: CLIENT_ID,
      account_ids: String(ACCOUNT_ID),
    });
    const data = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    // The 1000 EUR opening balance carries no client attribution
    // (clients_id: null) and clients_id is mandatory here, so it must be
    // excluded — balance stays 70 (100 credit - 30 debit), not 1070. The
    // whole-account context matches compute_account_balance (opening folded
    // in) without counting the opening balance as another client's entry.
    expect(data.accounts).toEqual([{
      account_id: ACCOUNT_ID,
      account_name: "Võlg kliendile",
      balance_type: "C",
      balance: 70,
      debit_total: 30,
      credit_total: 100,
      entry_count: 2,
      account_balance_all_clients: 1070,
      other_client_entry_count: 0,
    }]);
    expect(data.opening_balance_status).not.toBe("complete");
    expect(data.balance_scope).not.toBe("complete_balance");
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("no client attribution")]),
    );
    expect(data.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Opening balances applied")]),
    );
  });
});
