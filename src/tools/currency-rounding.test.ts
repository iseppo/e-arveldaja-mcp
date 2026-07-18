import { describe, expect, it, vi } from "vitest";
import { registerCurrencyRoundingTools } from "./currency-rounding.js";
import { parseMcpResponse } from "../mcp-json.js";
import { logAudit } from "../audit-log.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

interface SetupOptions {
  invoices: Array<Record<string, unknown>>;
  transactionsById?: Record<number, unknown>;
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
    if (typeof tx === "function") return tx();
    return Promise.resolve(tx);
  });
  const api = {
    readonly: {
      // The FX account is name-resolved from the chart; provide the standard
      // combined FX account 8500 so gains and losses both post to it.
      getAccounts: vi.fn().mockResolvedValue([
        { id: 8500, name_est: "Kasum/kahjum valuutakursi muutustest", is_valid: true },
      ]),
    },
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
      connectionFingerprint: "currency-rounding-test-connection",
      invalidateListCache: vi.fn(),
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [201],
        },
      ],
      transactionsById: {
        201: { id: 201, status: "CONFIRMED", type: "C", amount: 17.07, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 101, amount: 17.07, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [210],
        },
      ],
      transactionsById: {
        210: { id: 210, status: "CONFIRMED", type: "C", amount: 17.07, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 110, amount: 17.07, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [230],
        },
      ],
      transactionsById: {
        230: { id: 230, status: "CONFIRMED", type: "C", amount: 25.49, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 130, amount: 25.49, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [240],
        },
      ],
      transactionsById: {
        240: { id: 240, status: "CONFIRMED", type: "C", amount: 17.07, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 140, amount: 17.07, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [202],
        },
      ],
      transactionsById: {
        202: { id: 202, status: "CONFIRMED", type: "C", amount: 90.00, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 102, amount: 90.00, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [202],
        },
      ],
      transactionsById: {
        202: { id: 202, status: "CONFIRMED", type: "C", amount: 90.00, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 102, amount: 90.00, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [202],
        },
      ],
      transactionsById: {
        202: { id: 202, status: "CONFIRMED", type: "C", amount: 90.00, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 102, amount: 90.00, cl_currencies_id: "EUR" }] },
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

  it("posts D 8500 / C 2310 when liability is understated (paid more than booked)", async () => {
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [203],
        },
      ],
      transactionsById: {
        203: { id: 203, status: "CONFIRMED", type: "C", amount: 89.50, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 103, amount: 89.50, cl_currencies_id: "EUR" }] },
      },
      journalCreate,
    });

    await handler({ execute: true });
    const journal = journalCreate.mock.calls[0]![0];
    // diff_eur = booked (89) - paid (89.50) = -0.50 → liability understated
    // → D 8500 (combined FX result) + C 2310 (increase payable).
    expect(journal.postings).toEqual([
      { accounts_id: 8500, type: "D", amount: 0.5 },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [204],
        },
      ],
      transactionsById: {
        204: { id: 204, status: "CONFIRMED", type: "C", amount: 50, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 104, amount: 50, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [220, 221],
        },
      ],
      transactionsById: {
        220: { id: 220, status: "CONFIRMED", type: "C", amount: 50, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 120, amount: 50, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [205, 206],
        },
      ],
      transactionsById: {
        205: { id: 205, status: "VOID", type: "C", amount: 100, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 105, amount: 100, cl_currencies_id: "EUR" }] },
        206: { id: 206, status: "CONFIRMED", type: "C", amount: 49.97, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 105, amount: 49.97, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310, liability_accounts_dimensions_id: null,
          create_date: "2026-05-01", transactions: [250],
        },
      ],
      transactionsById: {
        250: { id: 250, status: "CONFIRMED", type: "C", amount: 100.00, cl_currencies_id: "EUR", date: "2026-05-02", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 150, amount: 100, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310, liability_accounts_dimensions_id: null,
          create_date: "2026-12-20", transactions: [260],
        },
      ],
      transactionsById: {
        260: { id: 260, status: "CONFIRMED", type: "C", amount: 90.00, cl_currencies_id: "EUR", date: "2027-01-15", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 160, amount: 90, cl_currencies_id: "EUR" }] },
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
          liability_accounts_id: 2310, liability_accounts_dimensions_id: null,
          create_date: "2026-05-01", transactions: [270],
        },
      ],
      transactionsById: {
        270: { id: 270, status: "CONFIRMED", type: "C", amount: 90.00, cl_currencies_id: "USD", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 170, amount: 90, cl_currencies_id: "USD" }] },
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
          liability_accounts_id: 2310,
          liability_accounts_dimensions_id: null,
          create_date: "2026-05-01",
          transactions: [207],
        },
      ],
      transactionsById: {
        207: { id: 207, status: "CONFIRMED", type: "C", amount: 17.07, cl_currencies_id: "EUR", items: [{ accounts_id: 2310, relation_table: "purchase_invoices", relation_id: 106, amount: 17.07, cl_currencies_id: "EUR" }] },
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

  it("H07 valid provenance uses invoice liability and only its allocated amount", async () => {
    const journalCreate = vi.fn().mockResolvedValue({ created_object_id: 901 });
    const journalConfirm = vi.fn().mockResolvedValue({});
    vi.mocked(logAudit).mockClear();
    const { api, handler } = setupTool({
      invoices: [{
        id: 701, number: "H07-ALLOC", client_name: "Allocated vendor",
        payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
        gross_price: 50, base_gross_price: 45.50, create_date: "2026-07-01",
        liability_accounts_id: 2120, liability_accounts_dimensions_id: 44,
        transactions: [801],
      }],
      transactionsById: {
        801: {
          id: 801, status: "CONFIRMED", type: "C", amount: 100,
          base_amount: 90, cl_currencies_id: "USD", date: "2026-07-02",
          items: [
            { accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 701, amount: 20, base_amount: 18.01, cl_currencies_id: "USD" },
            { accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 701, amount: 30, base_amount: 26.99, cl_currencies_id: "USD" },
            { accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 999, amount: 50, base_amount: 45, cl_currencies_id: "USD" },
          ],
        },
      },
      journalCreate,
      journalConfirm,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    const candidate = payload.candidates[0];
    expect(candidate).toMatchObject({
      paid_eur: 45,
      diff_eur: 0.5,
      liability_account_id: 2120,
      liability_account_dimension_id: 44,
      linked_transaction_ids: [801],
      contributing_transaction_ids: [801],
    });
    expect(api.transactions.get).toHaveBeenCalledTimes(1);
    expect(journalCreate).toHaveBeenCalledWith(expect.objectContaining({
      postings: [
        { accounts_id: 2120, accounts_dimensions_id: 44, type: "D", amount: 0.5 },
        { accounts_id: 8500, type: "C", amount: 0.5 },
      ],
    }));
    expect(journalConfirm).toHaveBeenCalledWith(901);
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({
        liability_account_id: 2120,
        liability_account_dimension_id: 44,
        linked_transaction_ids: [801],
        contributing_transaction_ids: [801],
        paid_eur: 45,
      }),
    }));
  });

  it.each([
    ["item base", { amount: 10, base_amount: 9, cl_currencies_id: "USD" }, { amount: 10, cl_currencies_id: "USD" }],
    ["EUR nominal", { amount: 9, cl_currencies_id: "EUR" }, { amount: 9, cl_currencies_id: "EUR" }],
    ["item rate", { amount: 10, currency_rate: 0.9, cl_currencies_id: "USD" }, { amount: 10, cl_currencies_id: "USD" }],
    ["transaction rate", { amount: 10, cl_currencies_id: "USD" }, { amount: 10, currency_rate: 0.9, cl_currencies_id: "USD" }],
    ["proportional transaction base", { amount: 10, cl_currencies_id: "USD" }, { amount: 20, base_amount: 18, cl_currencies_id: "USD" }],
  ])("H07 valid provenance derives allocated EUR from %s", async (_label, item, transaction) => {
    const { handler } = setupTool({
      invoices: [{
        id: 702, number: "H07-DERIVE", client_name: "Vendor",
        payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
        gross_price: 10, base_gross_price: 9.03, create_date: "2026-07-01",
        liability_accounts_id: 2120, liability_accounts_dimensions_id: null,
        transactions: [802],
      }],
      transactionsById: {
        802: {
          id: 802, status: "CONFIRMED", type: "C", date: "2026-07-03",
          ...transaction,
          items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 702, ...item }],
        },
      },
    });
    const payload = parseMcpResponse((await handler({ execute: false })).content[0]!.text) as any;
    expect(payload.candidates[0]).toMatchObject({
      paid_eur: 9,
      diff_eur: 0.03,
      liability_account_id: 2120,
      liability_account_dimension_id: null,
      contributing_transaction_ids: [802],
    });
  });

  it("H07 valid provenance deduplicates links, sums every allocation, and keeps deterministic IDs and date", async () => {
    const { api, handler } = setupTool({
      invoices: [{
        id: 703, number: "H07-MULTI", client_name: "Vendor",
        payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
        gross_price: 30, base_gross_price: 27.50, create_date: "2026-07-01",
        liability_accounts_id: 2120, liability_accounts_dimensions_id: null,
        transactions: [805, 803, 805, 804],
      }],
      transactionsById: {
        803: { id: 803, status: "CONFIRMED", type: "C", amount: 10, base_amount: 9, cl_currencies_id: "USD", date: "2026-07-04", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 703, amount: 10, base_amount: 9, cl_currencies_id: "USD" }] },
        804: { id: 804, status: "VOID", type: "C", amount: 999, cl_currencies_id: "EUR", date: "2026-12-31", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 703, amount: 999, cl_currencies_id: "EUR" }] },
        805: { id: 805, status: "CONFIRMED", type: "C", amount: 20, cl_currencies_id: "EUR", date: "2026-07-05", items: [
          { accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 703, amount: 8, cl_currencies_id: "EUR" },
          { accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 703, amount: 10, cl_currencies_id: "EUR" },
          { accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 999, amount: 2, cl_currencies_id: "EUR" },
        ] },
      },
    });
    const payload = parseMcpResponse((await handler({ execute: false })).content[0]!.text) as any;
    expect(payload.candidates[0]).toMatchObject({
      paid_eur: 27,
      diff_eur: 0.5,
      settlement_date: "2026-07-05",
      linked_transaction_ids: [805, 803, 805, 804],
      contributing_transaction_ids: [803, 805],
    });
    expect(api.transactions.get).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null])("H07 valid provenance keeps %s dimension account-level and matching assertion is inert", async (dimension) => {
    const invoice = {
      id: 704, number: "H07-ASSERT", client_name: "Vendor",
      payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
      gross_price: 10, base_gross_price: 9.50, create_date: "2026-07-01",
      liability_accounts_id: 2120, liability_accounts_dimensions_id: dimension,
      transactions: [806],
    };
    const tx = { id: 806, status: "CONFIRMED", type: "C", amount: 9, cl_currencies_id: "EUR", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 704, amount: 9, cl_currencies_id: "EUR" }] };
    for (const args of [{ execute: true }, { execute: true, liability_accounts_id: 2120 }]) {
      const journalCreate = vi.fn().mockResolvedValue({ created_object_id: 902 });
      const { handler } = setupTool({ invoices: [invoice], transactionsById: { 806: tx }, journalCreate });
      const payload = parseMcpResponse((await handler(args)).content[0]!.text) as any;
      expect(payload.candidates[0].liability_account_dimension_id).toBeNull();
      const liabilityPosting = journalCreate.mock.calls[0]![0].postings.find((p: any) => p.accounts_id === 2120);
      expect(liabilityPosting).toEqual({ accounts_id: 2120, type: "D", amount: 0.5 });
      expect(liabilityPosting).not.toHaveProperty("accounts_dimensions_id");
    }
  });

  it("H07 valid provenance carries allocated settlement evidence into a successful small-rounding audit", async () => {
    const invoiceUpdate = vi.fn().mockResolvedValue({});
    vi.mocked(logAudit).mockClear();
    const { handler } = setupTool({
      invoices: [{
        id: 711, number: "H07-SMALL-AUDIT", client_name: "Vendor",
        payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
        gross_price: 10, base_gross_price: 9.03, create_date: "2026-07-01",
        liability_accounts_id: 2120, liability_accounts_dimensions_id: 44,
        transactions: [823],
      }],
      transactionsById: {
        823: { id: 823, status: "CONFIRMED", type: "C", amount: 9, cl_currencies_id: "EUR", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 711, amount: 9, cl_currencies_id: "EUR" }] },
      },
      invoiceUpdate,
    });
    await handler({ execute: true });
    expect(invoiceUpdate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(expect.objectContaining({
      action: "UPDATED",
      entity_id: 711,
      details: expect.objectContaining({
        paid_eur: 9,
        liability_account_id: 2120,
        liability_account_dimension_id: 44,
        linked_transaction_ids: [823],
        contributing_transaction_ids: [823],
      }),
    }));
  });

  const provenanceMessages: Record<string, string> = {
    booked_base_missing_or_invalid: "The invoice has no finite positive booked EUR gross amount.",
    invoice_liability_account_missing_or_invalid: "The invoice liability account is missing or invalid.",
    invoice_liability_dimension_invalid: "The invoice liability dimension is invalid.",
    liability_account_assertion_conflict: "The deprecated liability account assertion conflicts with the invoice liability account.",
    linked_transactions_missing: "The partially paid invoice has no linked transactions.",
    linked_transaction_id_invalid: "A linked transaction ID is invalid.",
    linked_transaction_load_failed: "A linked transaction could not be loaded.",
    linked_transaction_identity_conflict: "A loaded transaction identity conflicts with the requested linked transaction ID.",
    linked_transaction_not_confirmed: "An active linked transaction is not confirmed.",
    linked_transaction_direction_conflict: "An active linked transaction is not an outgoing supplier payment.",
    invoice_distribution_missing: "An active linked transaction has no canonical allocation to this purchase invoice.",
    allocation_amount_invalid: "An invoice allocation amount is missing, non-finite, non-positive, or exceeds its transaction.",
    allocation_currency_missing: "An invoice allocation has no explicit source currency.",
    allocation_currency_conflict: "Invoice allocation and transaction currencies conflict.",
    allocation_rate_invalid: "An invoice allocation exchange rate is non-finite or non-positive.",
    allocation_base_invalid: "An allocation or transaction base amount is non-finite or non-positive.",
    allocation_eur_evidence_missing: "An invoice allocation has no authoritative EUR amount evidence.",
    allocation_base_conflict: "Available EUR allocation evidence conflicts by more than one cent or exceeds its transaction base.",
    no_active_settlement_allocation: "No active linked transaction provides a valid allocation to this purchase invoice.",
  };

  const h07ReviewCases: Array<{
    label: string;
    code: string;
    invoice?: Record<string, unknown>;
    tx?: Record<string, unknown> | Error;
    args?: Record<string, unknown>;
  }> = [
    { label: "missing booked base", code: "booked_base_missing_or_invalid", invoice: { base_gross_price: undefined } },
    { label: "non-finite booked base", code: "booked_base_missing_or_invalid", invoice: { base_gross_price: Number.NaN } },
    ...[undefined, 0, 2.5, Number.POSITIVE_INFINITY].map((value) => ({ label: `invalid liability ${String(value)}`, code: "invoice_liability_account_missing_or_invalid", invoice: { liability_accounts_id: value } })),
    ...[0, -1, 2.5, Number.NaN].map((value) => ({ label: `invalid dimension ${String(value)}`, code: "invoice_liability_dimension_invalid", invoice: { liability_accounts_dimensions_id: value } })),
    { label: "conflicting deprecated assertion", code: "liability_account_assertion_conflict", args: { liability_accounts_id: 2310 } },
    { label: "empty links", code: "linked_transactions_missing", invoice: { transactions: [] } },
    { label: "malformed link", code: "linked_transaction_id_invalid", invoice: { transactions: [0] } },
    { label: "load rejection", code: "linked_transaction_load_failed", tx: new Error("private upstream detail") },
    { label: "identity mismatch", code: "linked_transaction_identity_conflict", tx: { id: 999 } },
    { label: "only deleted", code: "no_active_settlement_allocation", tx: { is_deleted: true } },
    { label: "only VOID", code: "no_active_settlement_allocation", tx: { status: "VOID" } },
    { label: "PROJECT status", code: "linked_transaction_not_confirmed", tx: { status: "PROJECT" } },
    { label: "missing status", code: "linked_transaction_not_confirmed", tx: { status: undefined } },
    { label: "unknown status", code: "linked_transaction_not_confirmed", tx: { status: "SETTLED" } },
    { label: "incoming direction", code: "linked_transaction_direction_conflict", tx: { type: "D" } },
    { label: "absent items", code: "invoice_distribution_missing", tx: { items: undefined } },
    { label: "wrong relation table", code: "invoice_distribution_missing", tx: { items: [{ accounts_id: 2120, relation_table: "sale_invoices", relation_id: 705, amount: 9, cl_currencies_id: "EUR" }] } },
    { label: "wrong relation id", code: "invoice_distribution_missing", tx: { items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 999, amount: 9, cl_currencies_id: "EUR" }] } },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ label: `invalid item amount ${String(value)}`, code: "allocation_amount_invalid", tx: { items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: value, cl_currencies_id: "EUR" }] } })),
    { label: "matching nominal exceeds transaction", code: "allocation_amount_invalid", tx: { amount: 8, items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 9, cl_currencies_id: "EUR" }] } },
    { label: "missing currency", code: "allocation_currency_missing", tx: { cl_currencies_id: "" } },
    { label: "currency conflict", code: "allocation_currency_conflict", tx: { amount: 10, cl_currencies_id: "USD", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 10, base_amount: 9, cl_currencies_id: "GBP" }] } },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ label: `invalid item rate ${String(value)}`, code: "allocation_rate_invalid", tx: { items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 10, base_amount: 9, currency_rate: value, cl_currencies_id: "USD" }], amount: 10, cl_currencies_id: "USD" } })),
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ label: `invalid transaction rate ${String(value)}`, code: "allocation_rate_invalid", tx: { currency_rate: value } })),
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ label: `invalid item base ${String(value)}`, code: "allocation_base_invalid", tx: { items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 9, base_amount: value, cl_currencies_id: "EUR" }] } })),
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ label: `invalid transaction amount ${String(value)}`, code: "allocation_amount_invalid", tx: { amount: value } })),
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ label: `invalid transaction base ${String(value)}`, code: "allocation_base_invalid", tx: { base_amount: value } })),
    { label: "missing EUR evidence", code: "allocation_eur_evidence_missing", tx: { amount: 10, cl_currencies_id: "USD", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 10, cl_currencies_id: "USD" }] } },
    { label: "redundant evidence conflict", code: "allocation_base_conflict", tx: { amount: 10, base_amount: 9, currency_rate: 0.8, cl_currencies_id: "USD", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 10, base_amount: 9, currency_rate: 0.7, cl_currencies_id: "USD" }] } },
    { label: "allocated base exceeds transaction base", code: "allocation_base_conflict", tx: { amount: 20, base_amount: 8, cl_currencies_id: "USD", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 10, base_amount: 9, cl_currencies_id: "USD" }] } },
  ];

  it.each(h07ReviewCases)("H07 fail closed: $label", async ({ code, invoice: invoicePatch = {}, tx: txPatch = {}, args = {} }) => {
    for (const execute of [false, true]) {
      const invoiceUpdate = vi.fn();
      const journalCreate = vi.fn();
      const journalConfirm = vi.fn();
      vi.mocked(logAudit).mockClear();
      const baseInvoice = {
        id: 705, number: "H07-REVIEW", client_name: "Vendor",
        payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
        gross_price: 10, base_gross_price: 9.50, create_date: "2026-07-01",
        liability_accounts_id: 2120, liability_accounts_dimensions_id: null,
        transactions: [807],
      };
      const baseTx = {
        id: 807, status: "CONFIRMED", type: "C", amount: 9,
        cl_currencies_id: "EUR", date: "2026-07-02",
        items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 705, amount: 9, cl_currencies_id: "EUR" }],
      };
      const txValue = txPatch instanceof Error ? txPatch : { ...baseTx, ...txPatch };
      const { api, handler } = setupTool({
        invoices: [{ ...baseInvoice, ...invoicePatch }],
        transactionsById: { 807: txValue },
        invoiceUpdate,
        journalCreate,
        journalConfirm,
      });
      const payload = parseMcpResponse((await handler({ ...args, execute })).content[0]!.text) as any;
      expect(payload.candidates).toHaveLength(1);
      expect(payload.candidates[0]).toMatchObject({
        category: "review",
        paid_eur: null,
        diff_eur: null,
        provenance_error: { code, message: provenanceMessages[code] },
      });
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(journalCreate).not.toHaveBeenCalled();
      expect(journalConfirm).not.toHaveBeenCalled();
      expect(api.journals.create).not.toHaveBeenCalled();
      expect(vi.mocked(logAudit)).not.toHaveBeenCalled();
    }
  });

  it("H07 fail closed rejects a non-array linked-transactions container", async () => {
    const malformedLinks = { transaction_id: 807 };
    for (const execute of [false, true]) {
      const invoiceUpdate = vi.fn();
      const journalCreate = vi.fn();
      const journalConfirm = vi.fn();
      vi.mocked(logAudit).mockClear();
      const { api, handler } = setupTool({
        invoices: [{
          id: 713, number: "H07-NON-ARRAY", client_name: "Vendor",
          payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
          gross_price: 10, base_gross_price: 9.50, create_date: "2026-07-01",
          liability_accounts_id: 2120, liability_accounts_dimensions_id: null,
          transactions: malformedLinks,
        }],
        invoiceUpdate,
        journalCreate,
        journalConfirm,
      });
      const payload = parseMcpResponse((await handler({ execute })).content[0]!.text) as any;
      expect(payload.candidates).toHaveLength(1);
      expect(payload.candidates[0]).toMatchObject({
        category: "review",
        paid_eur: null,
        diff_eur: null,
        linked_transaction_ids: [],
        provenance_error: {
          code: "linked_transactions_missing",
          message: provenanceMessages.linked_transactions_missing,
        },
      });
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(journalCreate).not.toHaveBeenCalled();
      expect(journalConfirm).not.toHaveBeenCalled();
      expect(api.journals.create).not.toHaveBeenCalled();
      expect(api.journals.confirm).not.toHaveBeenCalled();
      expect(vi.mocked(logAudit)).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "null loaded transaction", transaction: null, code: "linked_transaction_load_failed" },
    { label: "non-object loaded transaction", transaction: 42, code: "linked_transaction_load_failed" },
    {
      label: "non-array transaction items",
      transaction: {
        id: 825, status: "CONFIRMED", type: "C", amount: 9,
        cl_currencies_id: "EUR", date: "2026-07-02", items: { relation_id: 714 },
      },
      code: "invoice_distribution_missing",
    },
    {
      label: "malformed item beside valid matching allocation",
      transaction: {
        id: 825, status: "CONFIRMED", type: "C", amount: 9,
        cl_currencies_id: "EUR", date: "2026-07-02",
        items: [
          null,
          { accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 714, amount: 9, cl_currencies_id: "EUR" },
        ],
      },
      code: "invoice_distribution_missing",
    },
  ])("H07 runtime guards fail closed: $label", async ({ transaction, code }) => {
    for (const execute of [false, true]) {
      const invoiceUpdate = vi.fn();
      const journalCreate = vi.fn();
      const journalConfirm = vi.fn();
      vi.mocked(logAudit).mockClear();
      const { api, handler } = setupTool({
        invoices: [{
          id: 714, number: "H07-RUNTIME", client_name: "Vendor",
          payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
          gross_price: 10, base_gross_price: 9.50, create_date: "2026-07-01",
          liability_accounts_id: 2120, liability_accounts_dimensions_id: null,
          transactions: [825],
        }],
        transactionsById: { 825: transaction },
        invoiceUpdate,
        journalCreate,
        journalConfirm,
      });
      const payload = parseMcpResponse((await handler({ execute })).content[0]!.text) as any;
      expect(payload.candidates).toHaveLength(1);
      expect(payload.candidates[0]).toMatchObject({
        category: "review",
        paid_eur: null,
        diff_eur: null,
        provenance_error: {
          code,
          message: provenanceMessages[code],
          transaction_id: 825,
        },
      });
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(journalCreate).not.toHaveBeenCalled();
      expect(journalConfirm).not.toHaveBeenCalled();
      expect(api.journals.create).not.toHaveBeenCalled();
      expect(api.journals.confirm).not.toHaveBeenCalled();
      expect(vi.mocked(logAudit)).not.toHaveBeenCalled();
    }
  });

  it("H07 fail closed selects error precedence and stable transaction IDs independent of link/load order", async () => {
    const delayed = (value: Record<string, unknown>, delay: number) => () => new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve(value), delay));
    const invoice = {
      id: 706, number: "H07-ORDER", client_name: "Vendor",
      payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD",
      gross_price: 10, base_gross_price: 9.50, create_date: "2026-07-01",
      liability_accounts_id: 2120, liability_accounts_dimensions_id: null,
      transactions: [812, 811],
    };
    const missingRelation = (id: number) => ({ id, status: "CONFIRMED", type: "C", amount: 9, cl_currencies_id: "EUR", items: [] });
    const wrongDirection = (id: number) => ({ id, status: "CONFIRMED", type: "D", amount: 9, cl_currencies_id: "EUR", items: [] });
    const scenarios = [
      {
        transactionsById: {
          812: delayed(missingRelation(812), 0),
          811: delayed(missingRelation(811), 10),
        },
        expectedError: {
          code: "invoice_distribution_missing",
          message: provenanceMessages.invoice_distribution_missing,
          transaction_id: 811,
        },
      },
      {
        transactionsById: {
          812: delayed(wrongDirection(812), 10),
          811: delayed(missingRelation(811), 0),
        },
        expectedError: {
          code: "linked_transaction_direction_conflict",
          message: provenanceMessages.linked_transaction_direction_conflict,
          transaction_id: 812,
        },
      },
    ];

    for (const scenario of scenarios) {
      for (const execute of [false, true]) {
        const invoiceUpdate = vi.fn();
        const journalCreate = vi.fn();
        const journalConfirm = vi.fn();
        vi.mocked(logAudit).mockClear();
        const { api, handler } = setupTool({
          invoices: [invoice],
          transactionsById: scenario.transactionsById,
          invoiceUpdate,
          journalCreate,
          journalConfirm,
        });
        const payload = parseMcpResponse((await handler({ execute })).content[0]!.text) as any;
        expect(payload.candidates).toHaveLength(1);
        expect(payload.candidates[0]).toMatchObject({
          category: "review",
          paid_eur: null,
          diff_eur: null,
          provenance_error: scenario.expectedError,
        });
        expect(invoiceUpdate).not.toHaveBeenCalled();
        expect(journalCreate).not.toHaveBeenCalled();
        expect(journalConfirm).not.toHaveBeenCalled();
        expect(api.journals.create).not.toHaveBeenCalled();
        expect(api.journals.confirm).not.toHaveBeenCalled();
        expect(vi.mocked(logAudit)).not.toHaveBeenCalled();
      }
    }
  });

  it("H07 fail closed rejects conflicting EUR nominal and explicit item base evidence", async () => {
    for (const execute of [false, true]) {
      const invoiceUpdate = vi.fn();
      const journalCreate = vi.fn();
      const journalConfirm = vi.fn();
      vi.mocked(logAudit).mockClear();
      const { api, handler } = setupTool({
        invoices: [{
          id: 712, number: "H07-EUR-CONFLICT", client_name: "Vendor",
          payment_status: "PARTIALLY_PAID", cl_currencies_id: "EUR",
          gross_price: 9.50, base_gross_price: 9.50, create_date: "2026-07-01",
          liability_accounts_id: 2120, liability_accounts_dimensions_id: null,
          transactions: [824],
        }],
        transactionsById: {
          824: {
            id: 824, status: "CONFIRMED", type: "C", amount: 9,
            cl_currencies_id: "EUR", date: "2026-07-02",
            items: [{
              accounts_id: 2120,
              relation_table: "purchase_invoices",
              relation_id: 712,
              amount: 9,
              base_amount: 8.50,
              cl_currencies_id: "EUR",
            }],
          },
        },
        invoiceUpdate,
        journalCreate,
        journalConfirm,
      });
      const payload = parseMcpResponse((await handler({ execute })).content[0]!.text) as any;
      expect(payload.candidates).toHaveLength(1);
      expect(payload.candidates[0]).toMatchObject({
        category: "review",
        paid_eur: null,
        diff_eur: null,
        provenance_error: {
          code: "allocation_base_conflict",
          message: provenanceMessages.allocation_base_conflict,
          transaction_id: 824,
        },
      });
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(journalCreate).not.toHaveBeenCalled();
      expect(journalConfirm).not.toHaveBeenCalled();
      expect(api.journals.create).not.toHaveBeenCalled();
      expect(api.journals.confirm).not.toHaveBeenCalled();
      expect(vi.mocked(logAudit)).not.toHaveBeenCalled();
    }
  });

  it("H07 fail closed rejects a valid active allocation beside an invalid active link", async () => {
    for (const execute of [false, true]) {
      const invoiceUpdate = vi.fn();
      const journalCreate = vi.fn();
      const journalConfirm = vi.fn();
      vi.mocked(logAudit).mockClear();
      const { handler } = setupTool({
        invoices: [{ id: 709, number: "H07-PARTIAL", client_name: "Vendor", payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD", gross_price: 10, base_gross_price: 9.03, create_date: "2026-07-01", liability_accounts_id: 2120, liability_accounts_dimensions_id: null, transactions: [821, 820] }],
        transactionsById: {
          820: { id: 820, status: "CONFIRMED", type: "C", amount: 9, cl_currencies_id: "EUR", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 709, amount: 9, cl_currencies_id: "EUR" }] },
          821: { id: 821, status: "PROJECT", type: "C", amount: 1, cl_currencies_id: "EUR", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 709, amount: 1, cl_currencies_id: "EUR" }] },
        },
        invoiceUpdate,
        journalCreate,
        journalConfirm,
      });
      const payload = parseMcpResponse((await handler({ execute })).content[0]!.text) as any;
      expect(payload.candidates[0]).toMatchObject({
        category: "review",
        paid_eur: null,
        diff_eur: null,
        contributing_transaction_ids: [820],
        provenance_error: {
          code: "linked_transaction_not_confirmed",
          message: provenanceMessages.linked_transaction_not_confirmed,
          transaction_id: 821,
        },
      });
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(journalCreate).not.toHaveBeenCalled();
      expect(journalConfirm).not.toHaveBeenCalled();
      expect(vi.mocked(logAudit)).not.toHaveBeenCalled();
    }
  });

  it.each([9.03, 9.50])("H07 fail closed blocks missing relation provenance near %s EUR mutation threshold", async (booked) => {
    for (const execute of [false, true]) {
      const invoiceUpdate = vi.fn();
      const journalCreate = vi.fn();
      const journalConfirm = vi.fn();
      vi.mocked(logAudit).mockClear();
      const { handler } = setupTool({
        invoices: [{ id: 710, number: "H07-NUMERIC", client_name: "Vendor", payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD", gross_price: 10, base_gross_price: booked, create_date: "2026-07-01", liability_accounts_id: 2120, liability_accounts_dimensions_id: null, transactions: [822] }],
        transactionsById: { 822: { id: 822, status: "CONFIRMED", type: "C", amount: 9, cl_currencies_id: "EUR", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 999, amount: 9, cl_currencies_id: "EUR" }] } },
        invoiceUpdate,
        journalCreate,
        journalConfirm,
      });
      const payload = parseMcpResponse((await handler({ execute })).content[0]!.text) as any;
      expect(payload.candidates[0]).toMatchObject({
        category: "review",
        paid_eur: null,
        diff_eur: null,
        provenance_error: {
          code: "invoice_distribution_missing",
          message: provenanceMessages.invoice_distribution_missing,
          transaction_id: 822,
        },
      });
      expect(invoiceUpdate).not.toHaveBeenCalled();
      expect(journalCreate).not.toHaveBeenCalled();
      expect(journalConfirm).not.toHaveBeenCalled();
      expect(vi.mocked(logAudit)).not.toHaveBeenCalled();
    }
  });

  it("H07 negative control keeps valid zero difference omitted", async () => {
    const { handler } = setupTool({
      invoices: [{ id: 707, number: "H07-ZERO", client_name: "Vendor", payment_status: "PARTIALLY_PAID", cl_currencies_id: "EUR", gross_price: 9, base_gross_price: 9, create_date: "2026-07-01", liability_accounts_id: 2120, liability_accounts_dimensions_id: null, transactions: [813] }],
      transactionsById: { 813: { id: 813, status: "CONFIRMED", type: "C", amount: 9, cl_currencies_id: "EUR", date: "2026-07-02", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 707, amount: 9, cl_currencies_id: "EUR" }] } },
    });
    const payload = parseMcpResponse((await handler({ execute: false })).content[0]!.text) as any;
    expect(payload.candidates).toEqual([]);
  });

  it("H07 negative control ignores deleted and VOID links beside one valid allocation", async () => {
    const { handler } = setupTool({
      invoices: [{ id: 708, number: "H07-LIVE", client_name: "Vendor", payment_status: "PARTIALLY_PAID", cl_currencies_id: "EUR", gross_price: 9.03, base_gross_price: 9.03, create_date: "2026-07-01", liability_accounts_id: 2120, liability_accounts_dimensions_id: null, transactions: [816, 814, 815] }],
      transactionsById: {
        814: { id: 814, status: "CONFIRMED", type: "C", amount: 9, cl_currencies_id: "EUR", date: "2026-07-02", items: [{ accounts_id: 2120, relation_table: "purchase_invoices", relation_id: 708, amount: 9, cl_currencies_id: "EUR" }] },
        815: { id: 815, status: "VOID", type: "C", amount: 100, cl_currencies_id: "EUR", date: "2026-12-31" },
        816: { id: 816, status: "CONFIRMED", type: "C", amount: 100, cl_currencies_id: "EUR", date: "2026-11-30", is_deleted: true },
      },
    });
    const payload = parseMcpResponse((await handler({ execute: false })).content[0]!.text) as any;
    expect(payload.candidates[0]).toMatchObject({ paid_eur: 9, diff_eur: 0.03, settlement_date: "2026-07-02" });
  });
});
