import { describe, expect, it, vi } from "vitest";
import { registerCurrencyRoundingTools } from "./currency-rounding.js";
import { parseMcpResponse } from "../mcp-json.js";

interface SetupOptions {
  invoices: Array<Record<string, unknown>>;
  transactionsById?: Record<number, Record<string, unknown> | Error>;
  journalCreate?: ReturnType<typeof vi.fn>;
  journalConfirm?: ReturnType<typeof vi.fn>;
  invoiceUpdate?: ReturnType<typeof vi.fn>;
  existingJournals?: Array<Record<string, unknown>>;
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
      listAll: vi.fn().mockResolvedValue(options.existingJournals ?? []),
      listAllWithPostings: vi.fn().mockResolvedValue(options.existingJournals ?? []),
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

  it("derives base_vat as the gross−net residual so the trio reconciles when independent rounding would drift a cent", async () => {
    // Chosen so double-rounding actually diverges: rate = round(25.49/25.85, 6)
    // = 0.986074. round(net*rate) = round(11.13*0.986074) = 10.98 and
    // round(vat*rate) = round(14.72*0.986074) = 14.52 — but 10.98 + 14.52 =
    // 25.50 ≠ the 25.49 actually paid, so a naive per-field rounding overstates
    // base_gross by a cent and trips the API's net+vat=gross check. The residual
    // rule takes base_vat = round(base_gross − base_net) = round(25.49 − 10.98)
    // = 14.51, so 10.98 + 14.51 = 25.49 exactly.
    const { handler } = setupTool({
      invoices: [
        {
          id: 130,
          number: "USD-030",
          client_name: "OpenAI",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "USD",
          net_price: 11.13,
          vat_price: 14.72,
          gross_price: 25.85,
          base_net_price: 10.99,
          base_vat_price: 14.53,
          base_gross_price: 25.52,
          create_date: "2026-05-01",
          transactions: [230],
        },
      ],
      transactionsById: {
        230: { id: 230, status: "CONFIRMED", amount: 25.49, cl_currencies_id: "EUR" },
      },
    });

    const result = await handler({ execute: false });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    const c = payload.candidates[0];

    expect(c.category).toBe("small_rounding");
    expect(c.proposed_currency_rate).toBeCloseTo(0.986074, 5);
    expect(c.proposed_base_gross_price).toBe(25.49);
    expect(c.proposed_base_net_price).toBe(10.98);
    // The residual, NOT round(vat*rate)=14.52 which would break the sum.
    expect(c.proposed_base_vat_price).toBe(14.51);
    expect(c.proposed_base_vat_price).not.toBe(14.52);
    // net + vat reconciles to gross to the cent.
    expect(c.proposed_base_net_price + c.proposed_base_vat_price).toBeCloseTo(25.49, 2);
  });

  it("derives base_net as the residual when only vat_price is present (no net_price)", async () => {
    // Degenerate but possible: a foreign invoice carrying vat but no net_price.
    // The tool must still reconcile base_net + base_vat == base_gross, deriving
    // the missing net side as the residual rather than leaving base_net stale.
    const { handler } = setupTool({
      invoices: [
        {
          id: 140,
          number: "USD-040",
          client_name: "OpenAI",
          status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID",
          cl_currencies_id: "USD",
          vat_price: 3.61,
          gross_price: 20,
          base_vat_price: 3.08,
          base_gross_price: 17.10,
          create_date: "2026-05-01",
          transactions: [240],
        },
      ],
      transactionsById: {
        240: { id: 240, status: "CONFIRMED", amount: 17.07, cl_currencies_id: "EUR" },
      },
    });

    const result = await handler({ execute: false });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    const c = payload.candidates[0];

    expect(c.category).toBe("small_rounding");
    expect(c.proposed_base_gross_price).toBe(17.07);
    expect(c.proposed_base_vat_price).toBe(3.08);
    // base_net derived as the residual, so the trio reconciles to the cent.
    expect(c.proposed_base_net_price).toBe(13.99);
    expect(c.proposed_base_net_price + c.proposed_base_vat_price).toBeCloseTo(17.07, 2);
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

  it("does not post a second FX journal when one already exists (idempotent execute)", async () => {
    const journalCreate = vi.fn().mockResolvedValue({ created_object_id: 999 });
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
      // The paid-vs-booked residual persists after the FX journal is posted, so
      // the invoice is still PARTIALLY_PAID with the same diff on the next run.
      existingJournals: [{ id: 777, document_number: "FX:102" }],
      journalCreate,
      journalConfirm,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    // The candidate is recognised as already reconciled and not re-posted.
    expect(journalCreate).not.toHaveBeenCalled();
    expect(payload.summary.fx_difference).toBe(0);
    expect(payload.summary.fx_already_reconciled).toBe(1);
    expect(payload.summary.applied_success).toBe(0);
    expect(payload.candidates[0].already_reconciled).toBe(true);
  });

  it("re-books an FX journal when the existing one was deleted/invalidated", async () => {
    const journalCreate = vi.fn().mockResolvedValue({ created_object_id: 888 });
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
      // The prior FX journal was invalidated (is_deleted) — the residual is open
      // again, so it must not suppress a fresh FX adjustment.
      existingJournals: [{ id: 777, document_number: "FX:102", is_deleted: true }],
      journalCreate,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.candidates[0].already_reconciled).toBe(false);
    expect(payload.summary.fx_difference).toBe(1);
    expect(journalCreate).toHaveBeenCalledTimes(1);
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

  it("routes a 0.10–1.00 EUR residual on an EUR invoice to review, never an FX journal", async () => {
    // An EUR invoice has no exchange-rate difference, so a 0.50 EUR residual is a
    // genuine short-payment — it must be surfaced for review, not auto-booked as
    // an FX gain (which only makes sense for a foreign-currency invoice).
    const journalCreate = vi.fn();
    const { handler } = setupTool({
      invoices: [
        {
          id: 150, number: "EUR-050", client_name: "Vendor", status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID", cl_currencies_id: "EUR",
          net_price: 100.50, gross_price: 100.50, base_gross_price: 100.50,
          create_date: "2026-05-01", transactions: [250],
        },
      ],
      transactionsById: {
        250: { id: 250, status: "CONFIRMED", amount: 100.00, cl_currencies_id: "EUR", date: "2026-05-02" },
      },
      journalCreate,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.candidates[0].category).toBe("review");
    expect(payload.summary.fx_difference).toBe(0);
    expect(journalCreate).not.toHaveBeenCalled();
  });

  it("posts the FX journal on the settlement (payment) date, not the invoice date", async () => {
    const journalCreate = vi.fn().mockResolvedValue({ created_object_id: 811 });
    const { handler } = setupTool({
      invoices: [
        {
          id: 160, number: "USD-060", client_name: "Anthropic", status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
          net_price: 100, vat_price: 0, gross_price: 100, base_gross_price: 90.50,
          create_date: "2026-12-20", transactions: [260],
        },
      ],
      transactionsById: {
        260: { id: 260, status: "CONFIRMED", amount: 90.00, cl_currencies_id: "EUR", date: "2027-01-15" },
      },
      journalCreate,
    });

    await handler({ execute: true });

    expect(journalCreate).toHaveBeenCalledTimes(1);
    // Dec invoice, Jan payment → the FX difference belongs in the January period.
    expect(journalCreate.mock.calls[0]![0].effective_date).toBe("2027-01-15");
  });

  it("routes to review when a foreign payment cannot be EUR-converted (no base_amount/rate)", async () => {
    // A foreign payment with neither base_amount nor currency_rate must NOT be
    // treated as if its raw foreign amount were EUR (which here would look like a
    // 0.50 EUR fx_difference and auto-book a journal). It falls to review.
    const journalCreate = vi.fn();
    const invoiceUpdate = vi.fn();
    const { handler } = setupTool({
      invoices: [
        {
          id: 170, number: "USD-070", client_name: "Vendor", status: "CONFIRMED",
          payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
          net_price: 100, vat_price: 0, gross_price: 100, base_gross_price: 90.50,
          create_date: "2026-05-01", transactions: [270],
        },
      ],
      transactionsById: {
        270: { id: 270, status: "CONFIRMED", amount: 90.00, cl_currencies_id: "USD" },
      },
      journalCreate,
      invoiceUpdate,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.candidates[0].category).toBe("review");
    expect(journalCreate).not.toHaveBeenCalled();
    expect(invoiceUpdate).not.toHaveBeenCalled();
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
