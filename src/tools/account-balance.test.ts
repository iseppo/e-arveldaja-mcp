import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import type { Journal } from "../types/api.js";

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

// ---------------------------------------------------------------------------
// Build a minimal ApiContext factory
// ---------------------------------------------------------------------------

function makeApi(journals: Journal[], account: { id: number; name_est: string; name_eng: string; balance_type: string } | null = null) {
  return {
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue(journals),
    },
    readonly: {
      getAccount: vi.fn().mockResolvedValue(account),
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

  it("filters by client_id", async () => {
    const journals = [
      journal({ id: 1, clients_id: 42, postings: [posting(ACCOUNT_ID, "D", 1000)] }),
      journal({ id: 2, clients_id: 99, postings: [posting(ACCOUNT_ID, "D", 500)] }),
      journal({ id: 3, clients_id: null, postings: [posting(ACCOUNT_ID, "D", 250)] }),
    ];
    const handler = setup(journals);
    const result = await handler({ account_id: ACCOUNT_ID, client_id: 42 });
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
