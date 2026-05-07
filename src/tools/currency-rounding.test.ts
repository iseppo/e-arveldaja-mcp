import { describe, expect, it, vi } from "vitest";
import { registerCurrencyRoundingTools } from "./currency-rounding.js";
import { parseMcpResponse } from "../mcp-json.js";

interface SetupOptions {
  invoices: Array<Record<string, unknown>>;
  transactionsById?: Record<number, Record<string, unknown> | Error>;
  journalCreate?: ReturnType<typeof vi.fn>;
  journalConfirm?: ReturnType<typeof vi.fn>;
  invoiceUpdate?: ReturnType<typeof vi.fn>;
}

function setupTool(options: SetupOptions) {
  const server = { registerTool: vi.fn() } as any;
  const txGet = vi.fn().mockImplementation((id: number) => {
    const tx = options.transactionsById?.[id];
    // Throw on unknown IDs so a test that forgets a fixture fails loudly
    // instead of silently summing zero EUR (Codex test-review P2).
    if (tx === undefined) {
      return Promise.reject(new Error(`test fixture missing transaction ${id}`));
    }
    if (tx instanceof Error) return Promise.reject(tx);
    return Promise.resolve(tx);
  });
  const api = {
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.invoices),
      get: vi.fn().mockImplementation((id: number) => {
        const inv = options.invoices.find((i) => i.id === id);
        return Promise.resolve(inv);
      }),
      update: options.invoiceUpdate ?? vi.fn().mockResolvedValue({}),
    },
    transactions: {
      get: txGet,
    },
    journals: {
      create:
        options.journalCreate ??
        vi.fn().mockResolvedValue({ created_object_id: 555 }),
      confirm: options.journalConfirm ?? vi.fn().mockResolvedValue({}),
    },
  } as any;

  registerCurrencyRoundingTools(server, api);
  const registration = server.registerTool.mock.calls.find(
    ([name]: [string]) => name === "reconcile_currency_rounding",
  );
  if (!registration) throw new Error("Tool was not registered");
  return {
    api,
    handler: registration[2] as (
      args: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("reconcile_currency_rounding", () => {
  it("buckets a sub-0.10 EUR foreign-currency diff as small_rounding and proposes correct VAT split", async () => {
    // VAT-bearing invoice picked deliberately: net 16.39 + vat 3.61 = gross 20.
    // The pre-fix bug computed base_net = gross*rate, base_vat = 0, which would
    // produce base_net=17.07, base_vat=0 here — completely wrong. The fix
    // derives base_net = round(net*rate, 2) = round(16.39*0.8535, 2) = 13.99
    // and base_vat = round(vat*rate, 2) = round(3.61*0.8535, 2) = 3.08.
    const { handler } = setupTool({
      invoices: [
        {
          id: 101,
          number: "USD-001",
          client_name: "OpenAI",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "USD",
          net_price: 16.39,
          vat_price: 3.61,
          gross_price: 20,
          base_net_price: 14.02,
          base_vat_price: 3.08,
          base_gross_price: 17.10,
          create_date: "2026-05-01",
          transactions: [201],
        },
      ],
      transactionsById: {
        201: { id: 201, status: "CONFIRMED", amount: 17.07, cl_currencies_id: "EUR" },
      },
    });

    const result = await handler({ execute: false });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.summary).toMatchObject({
      total_partially_paid_scanned: 1,
      candidates_with_diff: 1,
      small_rounding: 1,
      fx_difference: 0,
      review: 0,
    });
    const c = payload.candidates[0];
    expect(c.category).toBe("small_rounding");
    expect(c.diff_eur).toBeCloseTo(0.03, 2);
    expect(c.proposed_base_gross_price).toBeCloseTo(17.07, 2);
    expect(c.proposed_currency_rate).toBeCloseTo(0.8535, 4);
    expect(c.proposed_base_net_price).toBeCloseTo(13.99, 2);
    expect(c.proposed_base_vat_price).toBeCloseTo(3.08, 2);
    // Cross-check that net+vat ≈ gross (the property the prior bug violated).
    expect(c.proposed_base_net_price + c.proposed_base_vat_price).toBeCloseTo(17.07, 2);
  });

  it("execute-mode small_rounding patch writes the right base_net/base_vat (not gross*rate)", async () => {
    const invoiceUpdate = vi.fn().mockResolvedValue({});
    const { handler } = setupTool({
      invoices: [
        {
          id: 110,
          number: "USD-010",
          client_name: "OpenAI",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "USD",
          net_price: 16.39,
          vat_price: 3.61,
          gross_price: 20,
          base_net_price: 14.02,
          base_vat_price: 3.08,
          base_gross_price: 17.10,
          create_date: "2026-05-01",
          transactions: [210],
        },
      ],
      transactionsById: {
        210: { id: 210, status: "CONFIRMED", amount: 17.07, cl_currencies_id: "EUR" },
      },
      invoiceUpdate,
    });

    await handler({ execute: true });

    expect(invoiceUpdate).toHaveBeenCalledTimes(1);
    const [, patch] = invoiceUpdate.mock.calls[0]!;
    expect(patch.base_gross_price).toBeCloseTo(17.07, 2);
    expect(patch.currency_rate).toBeCloseTo(0.8535, 4);
    // Critical: patch must NOT use gross*rate (17.07) as base_net or zero base_vat.
    expect(patch.base_net_price).toBeCloseTo(13.99, 2);
    expect(patch.base_vat_price).toBeCloseTo(3.08, 2);
  });

  it("falls in the fx_difference bucket and posts D 2310 / C 8500 when liability is overstated", async () => {
    const journalCreate = vi.fn().mockResolvedValue({ created_object_id: 777 });
    const journalConfirm = vi.fn().mockResolvedValue({});
    const { handler } = setupTool({
      invoices: [
        {
          id: 102,
          number: "USD-002",
          client_name: "Anthropic",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "USD",
          net_price: 100,
          vat_price: 0,
          gross_price: 100,
          base_gross_price: 90.50,
          create_date: "2026-05-01",
          transactions: [202],
        },
      ],
      transactionsById: {
        202: { id: 202, status: "CONFIRMED", amount: 90.00, cl_currencies_id: "EUR" },
      },
      journalCreate,
      journalConfirm,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.summary.fx_difference).toBe(1);
    // diff_eur = booked (90.50) - paid (90.00) = +0.50 → liability overstated
    // → D 2310 (reduce payable) + C 8500 (FX gain). Codex P1 fix verified.
    expect(journalCreate).toHaveBeenCalledTimes(1);
    const journal = journalCreate.mock.calls[0]![0];
    expect(journal.postings).toEqual([
      { accounts_id: 2310, type: "D", amount: 0.5 },
      { accounts_id: 8500, type: "C", amount: 0.5 },
    ]);
    // Confirm journal must be posted to the GL, not left as a draft.
    expect(journalConfirm).toHaveBeenCalledWith(777);
    expect(payload.applied).toEqual([
      expect.objectContaining({ invoice_id: 102, category: "fx_difference", result: "success" }),
    ]);
    expect(payload.summary.applied_success).toBe(1);
    expect(payload.summary.applied_errors).toBe(0);
  });

  it("posts D 8600 / C 2310 when liability is understated (paid more than booked)", async () => {
    const journalCreate = vi.fn().mockResolvedValue({ created_object_id: 778 });
    const { handler } = setupTool({
      invoices: [
        {
          id: 103,
          number: "USD-003",
          client_name: "Vendor",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "USD",
          net_price: 100,
          vat_price: 0,
          gross_price: 100,
          base_gross_price: 89.00,
          create_date: "2026-05-01",
          transactions: [203],
        },
      ],
      transactionsById: {
        203: { id: 203, status: "CONFIRMED", amount: 89.50, cl_currencies_id: "EUR" },
      },
      journalCreate,
    });

    await handler({ execute: true });
    const journal = journalCreate.mock.calls[0]![0];
    // diff_eur = booked (89) - paid (89.50) = -0.50 → liability understated
    // → D 8600 (FX loss) + C 2310 (increase payable).
    expect(journal.postings).toEqual([
      { accounts_id: 8600, type: "D", amount: 0.5 },
      { accounts_id: 2310, type: "C", amount: 0.5 },
    ]);
  });

  it("flags > 1.00 EUR diffs for review and never auto-applies them", async () => {
    const invoiceUpdate = vi.fn();
    const journalCreate = vi.fn();
    const { handler } = setupTool({
      invoices: [
        {
          id: 104,
          number: "USD-004",
          client_name: "Vendor",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "EUR",
          net_price: 100,
          gross_price: 100,
          base_gross_price: 100,
          create_date: "2026-05-01",
          transactions: [204],
        },
      ],
      transactionsById: {
        204: { id: 204, status: "CONFIRMED", amount: 50, cl_currencies_id: "EUR" },
      },
      invoiceUpdate,
      journalCreate,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.summary.review).toBe(1);
    expect(payload.candidates[0].category).toBe("review");
    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(journalCreate).not.toHaveBeenCalled();
  });

  it("does not auto-apply when one of the linked transactions cannot be loaded (incomplete paid_eur)", async () => {
    // The production tool swallows transaction.get() failures so the scan
    // can keep running. That means paid_eur is incomplete, and we must NOT
    // propose a small_rounding patch from a partial total. The diff here
    // would otherwise look like 50 EUR paid against a 100 EUR booking and
    // get bucketed as `review` (>1 EUR), which is the correct safe default.
    const invoiceUpdate = vi.fn();
    const journalCreate = vi.fn();
    const { handler } = setupTool({
      invoices: [
        {
          id: 120,
          number: "USD-020",
          client_name: "Vendor",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "EUR",
          net_price: 100,
          gross_price: 100,
          base_gross_price: 100,
          create_date: "2026-05-01",
          transactions: [220, 221],
        },
      ],
      transactionsById: {
        220: { id: 220, status: "CONFIRMED", amount: 50, cl_currencies_id: "EUR" },
        221: new Error("upstream API timeout"),
      },
      invoiceUpdate,
      journalCreate,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    // Booked 100, partial paid 50 → diff 50 → review bucket; nothing applied.
    expect(payload.candidates[0].category).toBe("review");
    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(journalCreate).not.toHaveBeenCalled();
  });

  it("ignores VOID transactions when summing paid EUR", async () => {
    const { handler } = setupTool({
      invoices: [
        {
          id: 105,
          number: "USD-005",
          client_name: "Vendor",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "EUR",
          net_price: 50,
          gross_price: 50,
          base_gross_price: 50,
          create_date: "2026-05-01",
          transactions: [205, 206],
        },
      ],
      transactionsById: {
        205: { id: 205, status: "VOID", amount: 100, cl_currencies_id: "EUR" },
        206: { id: 206, status: "CONFIRMED", amount: 49.97, cl_currencies_id: "EUR" },
      },
    });

    const result = await handler({ execute: false });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    expect(payload.candidates[0].paid_eur).toBeCloseTo(49.97, 2);
    expect(payload.candidates[0].diff_eur).toBeCloseTo(0.03, 2);
  });

  it("dry run never mutates anything", async () => {
    const invoiceUpdate = vi.fn();
    const journalCreate = vi.fn();
    const { handler } = setupTool({
      invoices: [
        {
          id: 106,
          number: "USD-006",
          client_name: "Vendor",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "EUR",
          net_price: 17.10,
          gross_price: 17.10,
          base_gross_price: 17.10,
          create_date: "2026-05-01",
          transactions: [207],
        },
      ],
      transactionsById: {
        207: { id: 207, status: "CONFIRMED", amount: 17.07, cl_currencies_id: "EUR" },
      },
      invoiceUpdate,
      journalCreate,
    });

    const result = await handler({ execute: false });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    expect(payload.mode).toBe("DRY_RUN");
    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(journalCreate).not.toHaveBeenCalled();
  });
});
