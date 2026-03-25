import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import type { SaleInvoice } from "../types/api.js";

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
  // For each scenario we create a single invoice, set create_date + term_days
  // so we know the due date, then pass as_of_date = due_date + daysOverdue.
  // addDaysToDate(create_date, term_days) must equal due_date for the math to work.
  // We use term_days=0 so due_date = create_date, then offset as_of_date.

  function invoiceWithDueOffset(daysAfterDue: number, asOfDate: string) {
    // due date = "2024-06-01" (create_date="2024-06-01", term_days=0)
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    return { inv, asOfDate };
  }

  it("exactly 0 days overdue → current", async () => {
    const { inv } = invoiceWithDueOffset(0, "2024-06-01");
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-06-01" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "current")).toBeDefined();
    expect(buckets.find(b => b.label === "1-30")).toBeUndefined();
  });

  it("1 day overdue → 1-30 bucket", async () => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-06-02" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "1-30")).toBeDefined();
    expect(buckets.find(b => b.label === "current")).toBeUndefined();
  });

  it("30 days overdue → 1-30 bucket (upper boundary)", async () => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-07-01" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "1-30")).toBeDefined();
    expect(buckets.find(b => b.label === "31-60")).toBeUndefined();
  });

  it("31 days overdue → 31-60 bucket", async () => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-07-02" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "31-60")).toBeDefined();
    expect(buckets.find(b => b.label === "1-30")).toBeUndefined();
  });

  it("60 days overdue → 31-60 bucket (upper boundary)", async () => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-07-31" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "31-60")).toBeDefined();
    expect(buckets.find(b => b.label === "61-90")).toBeUndefined();
  });

  it("61 days overdue → 61-90 bucket", async () => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-08-01" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "61-90")).toBeDefined();
  });

  it("90 days overdue → 61-90 bucket (upper boundary)", async () => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-08-30" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "61-90")).toBeDefined();
    expect(buckets.find(b => b.label === "90+")).toBeUndefined();
  });

  it("91 days overdue → 90+ bucket", async () => {
    const inv = invoice({ id: 1, create_date: "2024-06-01", term_days: 0 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-08-31" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string }>;
    expect(buckets.find(b => b.label === "90+")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Invoice exactly on due date
// ---------------------------------------------------------------------------

describe("invoice on due date", () => {
  it("shows days_overdue=0 and lands in current bucket when queried on due date", async () => {
    // due date = create_date + term_days = 2024-03-01 + 14 = 2024-03-15
    const inv = invoice({ id: 1, create_date: "2024-03-01", term_days: 14 });
    const handler = setupReceivables([inv]);
    const result = await handler({ as_of_date: "2024-03-15" });
    const data = parse((result.content[0] as { text: string }).text);
    const buckets = data.aging_buckets as Array<{ label: string; invoices: Array<{ days_overdue: number }> }>;
    const currentBucket = buckets.find(b => b.label === "current");
    expect(currentBucket).toBeDefined();
    expect(currentBucket!.invoices[0]!.days_overdue).toBe(0);
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
