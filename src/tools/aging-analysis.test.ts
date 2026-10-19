import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import type { SaleInvoice } from "../types/api.js";

it("historical caveat formatter is pure and absent for current or omitted dates", async () => {
  const { historicalAgingWarnings } = await import("./aging-analysis.js");
  expect(historicalAgingWarnings(undefined, "2026-10-18")).toEqual([]);
  expect(historicalAgingWarnings("2026-10-18", "2026-10-18")).toEqual([]);
  expect(historicalAgingWarnings("2026-09-30", "2026-10-18")).toEqual([
    "as_of_date=2026-09-30 excludes invoices issued after that date and affects day-counting, but payment_status still reflects the CURRENT state — invoices settled after 2026-09-30 may be under-counted as still outstanding since the API does not expose historical payment state.",
  ]);
});

// ---------------------------------------------------------------------------
// Capture tool handlers registered by the module under test
// ---------------------------------------------------------------------------

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
// Import module under test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let registerAgingTools: typeof import("./aging-analysis.js").registerAgingTools;

beforeEach(async () => {
  for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
  ({ registerAgingTools } = await import("./aging-analysis.js"));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi(invoices: SaleInvoice[]) {
  return {
    saleInvoices: { listAll: vi.fn().mockResolvedValue(invoices) },
    purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
  };
}

function invoice(overrides: Partial<SaleInvoice> & { id: number }): SaleInvoice {
  return {
    sale_invoice_type: "INVOICE",
    cl_templates_id: 1,
    clients_id: 1,
    client_name: "Test Client",
    cl_countries_id: "EE",
    number_suffix: "1",
    number: `INV-${overrides.id}`,
    create_date: "2024-01-01",
    journal_date: "2024-01-01",
    status: "CONFIRMED",
    payment_status: "NOT_PAID",
    term_days: 30,
    gross_price: 100,
    cl_currencies_id: "EUR",
    show_client_balance: false,
    ...overrides,
  };
}

function setupReceivables(invoices: SaleInvoice[]) {
  const api = makeApi(invoices) as unknown as Parameters<typeof registerAgingTools>[1];
  const server = {} as Parameters<typeof registerAgingTools>[0];
  registerAgingTools(server, api);
  return capturedHandlers["compute_receivables_aging"]!;
}

function parse(text: string) {
  return parseMcpResponse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// daysBetween (tested indirectly via bucket placement)
// The function uses UTC noon to avoid DST issues: we verify it by controlling
// create_date + term_days so the due date is known, then checking days_overdue.
// ---------------------------------------------------------------------------

describe("daysBetween (via receivables aging)", () => {
  it("returns 0 when due date equals as_of_date", async () => {
    // create_date 2024-01-01 + term_days 30 → due 2024-01-31
    const inv = invoice({ id: 1, create_date: "2024-01-01", term_days: 30 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-01-31" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string; invoices: Array<{ days_overdue: number }> }>;
    const currentBucket = buckets.find(b => b.label === "current");
    expect(currentBucket).toBeDefined();
    expect(currentBucket!.invoices[0]!.days_overdue).toBe(0);
  });

  it("returns exact number of days overdue", async () => {
    // due date 2024-01-31, as_of_date 2024-02-10 → 10 days overdue
    const inv = invoice({ id: 1, create_date: "2024-01-01", term_days: 30 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-02-10" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string; invoices: Array<{ days_overdue: number }> }>;
    const bucket = buckets.find(b => b.label === "1-30");
    expect(bucket).toBeDefined();
    expect(bucket!.invoices[0]!.days_overdue).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// addDaysToDate (tested indirectly: due date = create_date + term_days)
// ---------------------------------------------------------------------------

describe("addDaysToDate (via due date computation)", () => {
  it("adds days across month boundary correctly", async () => {
    // create_date 2024-01-31 + 1 day → due 2024-02-01
    const inv = invoice({ id: 1, create_date: "2024-01-31", term_days: 1 });
    const handler = setupReceivables([inv]);
    // If we query on 2024-02-01 it should be "current" (0 days overdue)
    const result = await handler({ as_of_date: "2024-02-01" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.some(b => b.label === "current")).toBe(true);
    expect(buckets.every(b => b.label !== "1-30")).toBe(true);
  });

  it("adds days across year boundary correctly", async () => {
    // create_date 2023-12-25 + 10 days → due 2024-01-04
    const inv = invoice({ id: 1, create_date: "2023-12-25", term_days: 10 });
    const handler = setupReceivables([inv]);
    // Query on due date itself → current
    const result = await handler({ as_of_date: "2024-01-04" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.some(b => b.label === "current")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bucketLabel boundary tests
// ---------------------------------------------------------------------------

describe("bucketLabel boundaries", () => {
  // Single invoice due 2024-06-01 (create_date 2024-06-01, term_days 0); the
  // as_of_date offset places it in exactly one bucket. (0 days → current is
  // covered by the daysBetween test above.)
  it.each([
    ["1 day overdue → 1-30 bucket", "2024-06-02", "1-30", "current"],
    ["30 days overdue → 1-30 bucket (upper boundary)", "2024-07-01", "1-30", "31-60"],
    ["31 days overdue → 31-60 bucket", "2024-07-02", "31-60", "1-30"],
    ["60 days overdue → 31-60 bucket (upper boundary)", "2024-07-31", "31-60", "61-90"],
    ["61 days overdue → 61-90 bucket", "2024-08-01", "61-90", undefined],
    ["90 days overdue → 61-90 bucket (upper boundary)", "2024-08-30", "61-90", "90+"],
    ["91 days overdue → 90+ bucket", "2024-08-31", "90+", undefined],
  ] as const)("%s", async (_name, asOfDate, present, absent) => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: asOfDate });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === present)).toBeDefined();
    if (absent) expect(buckets.find(b => b.label === absent)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// base_gross_price fallback
// ---------------------------------------------------------------------------

describe("base_gross_price fallback", () => {
  it("uses base_gross_price when set (multi-currency amount in base currency)", async () => {
    const inv = invoice({ id: 1, create_date: "2024-01-01", term_days: 0, gross_price: 1000, base_gross_price: 920 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-01-01" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_unpaid_face_value).toBe(920);
  });

  it("falls back to gross_price when base_gross_price is absent", async () => {
    const inv = invoice({ id: 1, create_date: "2024-01-01", term_days: 0, gross_price: 500 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-01-01" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_unpaid_face_value).toBe(500);
  });

  it("uses 0 when both base_gross_price and gross_price are null/undefined", async () => {
    const inv = invoice({ id: 1, create_date: "2024-01-01", term_days: 0 });
    // explicitly unset gross_price
    delete (inv as Partial<SaleInvoice>).gross_price;
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-01-01" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_unpaid_face_value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filtering: only CONFIRMED + not PAID
// ---------------------------------------------------------------------------

describe("invoice filtering", () => {
  it("excludes PAID invoices", async () => {
    const invoices = [
      invoice({ id: 1, payment_status: "PAID", gross_price: 100 }),
      invoice({ id: 2, payment_status: "NOT_PAID", gross_price: 200 }),
    ];
    const handler = setupReceivables(invoices);
    const result = await handler({ as_of_date: "2024-01-31" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_invoices).toBe(1);
    expect(data.total_unpaid_face_value).toBe(200);
  });

  it("excludes non-CONFIRMED invoices (e.g. draft)", async () => {
    const invoices = [
      invoice({ id: 1, status: "DRAFT", gross_price: 100 }),
      invoice({ id: 2, status: "CONFIRMED", gross_price: 300 }),
    ];
    const handler = setupReceivables(invoices);
    const result = await handler({ as_of_date: "2024-01-31" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_invoices).toBe(1);
    expect(data.total_unpaid_face_value).toBe(300);
  });

  it("includes PARTIALLY_PAID invoices and emits a warning", async () => {
    const invoices = [
      invoice({ id: 1, payment_status: "PARTIALLY_PAID", gross_price: 400 }),
    ];
    const handler = setupReceivables(invoices);
    const result = await handler({ as_of_date: "2024-01-31" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.partially_paid_count).toBe(1);
    expect(data.total_invoices).toBe(1);
    const warnings = data.warnings as string[] | undefined;
    expect(warnings?.some(w => w.includes("partially paid"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// as_of_date membership: future-dated invoices excluded, and a warning is
// emitted when as_of_date is a back-dated cutoff (differs from today) since
// payment_status still reflects the CURRENT state, not the historical one.
// ---------------------------------------------------------------------------

describe("as_of_date membership", () => {
  it("excludes an invoice issued after a back-dated as_of_date", async () => {
    const invoices = [
      invoice({ id: 1, create_date: "2024-01-01", gross_price: 100 }),
      // Issued after the as_of_date cutoff — must not appear in a report as-of 2024-01-15.
      invoice({ id: 2, create_date: "2024-02-01", gross_price: 200 }),
    ];
    const handler = setupReceivables(invoices);
    const result = await handler({ as_of_date: "2024-01-15" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_invoices).toBe(1);
    expect(data.total_unpaid_face_value).toBe(100);
  });

  it("emits a warning when as_of_date differs from today", async () => {
    const inv = invoice({ id: 1, create_date: "2024-01-01", gross_price: 100 });
    const handler = setupReceivables([inv]);
    // Any back-dated as_of_date differs from the real "today" at test-run time.
    const result = await handler({ as_of_date: "2024-01-31" });
    const data = parse((result.content[0] as { text: string }).text);
    const warnings = data.warnings as string[] | undefined;
    expect(warnings?.some(w => w.includes("CURRENT state"))).toBe(true);
  });

  it("does not emit the as_of_date warning when as_of_date is omitted", async () => {
    const today = new Date().toISOString().split("T")[0]!;
    const inv = invoice({ id: 1, create_date: today, gross_price: 100 });
    const handler = setupReceivables([inv]);
    const result = await handler({});
    const data = parse((result.content[0] as { text: string }).text);
    const warnings = data.warnings as string[] | undefined;
    expect(warnings?.some(w => w.includes("CURRENT state")) ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CREDIT_INVOICE sign normalization
// ---------------------------------------------------------------------------

describe("CREDIT_INVOICE sign normalization", () => {
  it("normalizes a positive-priced credit invoice to a negative contribution, reducing the total", async () => {
    const invoices = [
      invoice({ id: 1, gross_price: 500 }),
      // Positive-priced credit invoice should subtract, not add, to the total.
      invoice({ id: 2, sale_invoice_type: "CREDIT_INVOICE", gross_price: 200 }),
    ];
    const handler = setupReceivables(invoices);
    const result = await handler({ as_of_date: "2024-01-31" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_unpaid_face_value).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Missing term_days does not abort the report
// ---------------------------------------------------------------------------

describe("missing term_days", () => {
  it("defaults missing term_days to 0 (due on issue date) instead of throwing", async () => {
    const inv = invoice({ id: 1, create_date: "2024-01-01", gross_price: 100 });
    delete (inv as Partial<SaleInvoice>).term_days;
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-01-01" });
    const data = parse((result.content[0] as { text: string }).text);
    expect(data.total_invoices).toBe(1);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "current")).toBeDefined();
    const warnings = data.warnings as string[] | undefined;
    expect(warnings?.some(w => w.includes("term_days"))).toBe(true);
  });
});

describe("as_of_date validation", () => {
  it.each(["2024-02-31", "yesterday", "2024-1-5", ""])("rejects %j instead of bucketing everything as 90+", async (asOf) => {
    const handler = setupReceivables([invoice({ id: 1 })]);
    const result = await handler({ as_of_date: asOf }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(parse(result.content[0]!.text).category).toBe("invalid_date");
  });

  it("validates compute_payables_aging as_of_date too", async () => {
    setupReceivables([]);
    const result = await capturedHandlers["compute_payables_aging"]!({ as_of_date: "2024-13-01" }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe("empty create_date", () => {
  it("does not throw a RangeError; the invoice is aged from as_of_date", async () => {
    const handler = setupReceivables([invoice({ id: 1, create_date: "", term_days: 0, gross_price: 70 })]);
    const data = parse((await handler({ as_of_date: "2024-03-01" })).content[0]!.text);
    expect(data.total_unpaid_face_value).toBe(70);
    expect((data.aging_buckets as Array<{ label: string }>)[0]!.label).toBe("current");
  });
});

describe("foreign-currency invoices without base_gross_price", () => {
  it("are excluded from every EUR total, kept (flagged) in the rows, and warned about", async () => {
    const handler = setupReceivables([
      invoice({ id: 1, gross_price: 100 }),
      invoice({ id: 2, gross_price: 5000, cl_currencies_id: "USD", clients_id: null as unknown as number }),
      invoice({ id: 3, gross_price: 50, base_gross_price: 46, cl_currencies_id: "USD" }),
    ]);
    const data = parse((await handler({ as_of_date: "2024-06-01" })).content[0]!.text);
    expect(data.total_invoices).toBe(3);
    expect(data.total_unpaid_face_value).toBe(146);
    const bucket = (data.aging_buckets as Array<{ total: number; count: number; invoices: Array<Record<string, unknown>> }>)[0]!;
    expect(bucket.count).toBe(3);
    expect(bucket.total).toBe(146);
    expect(bucket.invoices.find(r => r.id === 2)).toMatchObject({ amount: 5000, currency: "USD", excluded_from_eur_totals: true });
    expect(data.top_debtors).toEqual([expect.objectContaining({ total: 146 })]);
    expect(data.unmatched_client_invoices).toMatchObject({ count: 1, total: 0 });
    expect(data.warnings as string[]).toEqual(expect.arrayContaining([expect.stringContaining("1 foreign-currency invoice(s) have no base_gross_price")]));
  });
});

describe("standalone list caps are flagged", () => {
  it("caps a bucket and the debtor list at 10 and says so; the shared core keeps every row", async () => {
    const invoices = Array.from({ length: 12 }, (_, i) => invoice({ id: i + 1, clients_id: i + 1, client_name: `C${i}` }));
    const data = parse((await setupReceivables(invoices)({ as_of_date: "2024-06-01" })).content[0]!.text);
    const bucket = (data.aging_buckets as Array<{ count: number; invoices: unknown[]; truncated?: boolean }>)[0]!;
    expect(bucket.count).toBe(12);
    expect(bucket.invoices).toHaveLength(10);
    expect(bucket.truncated).toBe(true);
    expect(data.top_debtors as unknown[]).toHaveLength(10);
    expect(data.top_debtors_truncated).toBe(true);
    expect(data.debtor_count).toBe(12);

    const { computeAgingBuckets } = await import("./aging-analysis.js");
    const core = computeAgingBuckets(invoices, "2024-06-01");
    expect(core.aging_buckets[0]!.invoices).toHaveLength(12);
    expect(core.top_parties).toHaveLength(12);
  });
});

describe("agingComputationWarnings", () => {
  it("emits partial / term / unmatched / missing-EUR warnings in order with the caller's unmatched advice", async () => {
    const { agingComputationWarnings, computeAgingBuckets } = await import("./aging-analysis.js");
    const c = computeAgingBuckets([
      invoice({ id: 1, payment_status: "PARTIALLY_PAID" }),
      invoice({ id: 2, term_days: null as unknown as number }),
      invoice({ id: 3, clients_id: null as unknown as number, gross_price: 10.005, base_gross_price: 10.005 }),
      invoice({ id: 4, cl_currencies_id: "USD", gross_price: 50 }),
    ], "2024-06-01");
    const w = agingComputationWarnings(c, "ADVICE.");
    expect(w).toHaveLength(4);
    expect(w[0]).toMatch(/^1 partially paid invoice/);
    expect(w[1]).toMatch(/^1 invoice\(s\) have no term_days/);
    expect(w[2]).toBe("1 invoice(s) have no clients_id (totaling 10.01 EUR). ADVICE.");
    expect(w[3]).toMatch(/#4 \(50 USD\)/);
  });

  it("returns no warnings for a clean computation", async () => {
    const { agingComputationWarnings, computeAgingBuckets } = await import("./aging-analysis.js");
    expect(agingComputationWarnings(computeAgingBuckets([invoice({ id: 1 })], "2024-06-01"), "x")).toEqual([]);
  });
});
