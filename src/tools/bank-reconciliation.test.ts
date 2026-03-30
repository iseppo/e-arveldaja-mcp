import { describe, expect, it, vi } from "vitest";
import { registerBankReconciliationTools, matchScore } from "./bank-reconciliation.js";
import { parseMcpResponse } from "../mcp-json.js";

function setupReconciliationTool(options: {
  transactions?: unknown[];
  sales?: unknown[];
  purchases?: unknown[];
} = {}) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactions ?? []),
      confirm: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.sales ?? []),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.purchases ?? []),
    },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([]),
    },
  } as any;

  registerBankReconciliationTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === "reconcile_transactions");
  if (!registration) {
    throw new Error("Tool was not registered");
  }

  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

function setupInterAccountTool(options: {
  transactions?: unknown[];
  bankAccounts?: unknown[];
  companyName?: string;
  journals?: unknown[];
  accountDimensions?: unknown[];
} = {}) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactions ?? []),
      get: vi.fn().mockImplementation(async (id: number) => {
        const tx = (options.transactions ?? []).find((t: any) => t.id === id) as any;
        return tx ?? { id, clients_id: null };
      }),
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
    },
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue(options.journals ?? []),
    },
    clients: {
      findByName: vi.fn().mockResolvedValue([{ id: 99, name: options.companyName ?? "Test OÜ" }]),
    },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue(options.bankAccounts ?? []),
      getAccountDimensions: vi.fn().mockResolvedValue(
        options.accountDimensions ?? (options.bankAccounts ?? []).map((ba: any) => ({
          id: ba.accounts_dimensions_id,
          accounts_id: 1020,
          is_deleted: false,
        }))
      ),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: options.companyName ?? "Test OÜ" }),
    },
  } as any;

  registerBankReconciliationTools(server, api);

  const registration = server.registerTool.mock.calls.find(
    ([name]: [string]) => name === "reconcile_inter_account_transfers"
  );
  if (!registration) {
    throw new Error("Tool was not registered");
  }

  return {
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
    api,
  };
}

describe("reconcile_transactions", () => {
  it("ignores VOID transactions", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 99,
        status: "VOID",
        is_deleted: false,
        type: "D",
        amount: 100,
        date: "2026-03-20",
        description: "Voided payment",
        bank_account_name: "Acme OU",
      }],
      sales: [{
        id: 199,
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        number: "ARV-199",
        clients_id: 20,
        client_name: "Acme OU",
        gross_price: 100,
      }],
    });

    const result = await handler({ min_confidence: 0 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.total_unconfirmed).toBe(0);
    expect(payload.matches).toHaveLength(0);
  });

  it("does not provide a ready-to-use distribution for partially paid invoices", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 1,
        status: "PROJECT",
        is_deleted: false,
        type: "D",
        amount: 100,
        date: "2026-03-20",
        description: "Incoming payment",
        bank_account_name: "Acme OU",
      }],
      sales: [{
        id: 10,
        status: "CONFIRMED",
        payment_status: "PARTIALLY_PAID",
        number: "ARV-10",
        clients_id: 20,
        client_name: "Acme OU",
        gross_price: 100,
      }],
    });

    const result = await handler({ min_confidence: 0 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.best_match.partially_paid_warning).toBe(true);
    expect(payload.matches[0]!.distribution).toBeUndefined();
    expect(payload.matches[0]!.manual_review_required).toContain("remaining open balance");
  });

  it("keeps the ready-to-use distribution for non-partially-paid matches", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 2,
        status: "PROJECT",
        is_deleted: false,
        type: "D",
        amount: 250,
        date: "2026-03-20",
        description: "Incoming payment",
        bank_account_name: "Beta OU",
      }],
      sales: [{
        id: 11,
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        number: "ARV-11",
        clients_id: 21,
        client_name: "Beta OU",
        gross_price: 250,
      }],
    });

    const result = await handler({ min_confidence: 0 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.distribution).toEqual({
      related_table: "sale_invoices",
      related_id: 11,
      amount: 250,
    });
    expect(payload.matches[0]!.manual_review_required).toBeUndefined();
  });

  it("matches type C transactions against sale invoices (API always stores type C)", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 3,
        status: "PROJECT",
        is_deleted: false,
        type: "C",
        amount: 300,
        date: "2026-03-21",
        description: "Incoming payment",
        bank_account_name: "Delta OU",
      }],
      sales: [{
        id: 12,
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        number: "ARV-12",
        clients_id: 22,
        client_name: "Delta OU",
        gross_price: 300,
      }],
    });

    const result = await handler({ min_confidence: 0 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.best_match.type).toBe("sale_invoice");
    expect(payload.matches[0]!.distribution).toEqual({
      related_table: "sale_invoices",
      related_id: 12,
      amount: 300,
    });
  });

  it("does not match explicit incoming transactions against purchase invoices", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 31,
        status: "PROJECT",
        is_deleted: false,
        type: "D",
        amount: 200,
        date: "2026-03-21",
        description: "Incoming transfer",
        bank_account_name: "Supplier OU",
        ref_number: "RF-200",
      }],
      purchases: [{
        id: 21,
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        number: "OST-21",
        clients_id: 31,
        client_name: "Supplier OU",
        gross_price: 200,
        bank_ref_number: "RF-200",
      }],
    });

    const result = await handler({ min_confidence: 0 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.total_unconfirmed).toBe(1);
    expect(payload.matched).toBe(0);
    expect(payload.matches).toEqual([]);
  });

  it("matches invoices via base amounts even when nominal currencies differ", async () => {
    const handler = setupReconciliationTool({
      transactions: [{
        id: 32,
        status: "PROJECT",
        is_deleted: false,
        type: "C",
        amount: 1000,
        base_amount: 92,
        cl_currencies_id: "SEK",
        date: "2026-03-21",
        description: "Incoming payment",
        bank_account_name: "Acme OU",
      }],
      sales: [{
        id: 22,
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        number: "ARV-22",
        clients_id: 32,
        client_name: "Acme OU",
        gross_price: 100,
        base_gross_price: 92,
        cl_currencies_id: "USD",
      }],
    });

    const result = await handler({ min_confidence: 50 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched).toBe(1);
    expect(payload.matches[0]!.best_match.id).toBe(22);
    expect(payload.matches[0]!.best_match.match_reasons).toContain("exact_base_amount");
  });
});

function setupAutoConfirmTool(options: {
  transactions?: unknown[];
  sales?: unknown[];
  purchases?: unknown[];
} = {}) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactions ?? []),
      confirm: vi.fn().mockResolvedValue({}),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.sales ?? []),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.purchases ?? []),
    },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Test OÜ" }),
    },
    journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
    clients: { findByName: vi.fn().mockResolvedValue([]) },
  } as any;

  registerBankReconciliationTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "auto_confirm_exact_matches");
  if (!registration) throw new Error("Tool was not registered");

  return {
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
    api,
  };
}

describe("auto_confirm_exact_matches", () => {
  it("ignores VOID transactions", async () => {
    const { handler, api } = setupAutoConfirmTool({
      transactions: [
        { id: 98, status: "VOID", is_deleted: false, type: "D", amount: 100, date: "2026-03-20", bank_account_name: "Acme OU", ref_number: "RFVOID" },
      ],
      sales: [
        { id: 108, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-108", clients_id: 20, client_name: "Acme OU", gross_price: 100, bank_ref_number: "RFVOID" },
      ],
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.total_unconfirmed).toBe(0);
    expect(payload.auto_confirmed).toBe(0);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("dry run produces would_confirm without calling API", async () => {
    const { handler, api } = setupAutoConfirmTool({
      transactions: [
        { id: 1, status: "PROJECT", is_deleted: false, type: "D", amount: 100, date: "2026-03-20", bank_account_name: "Acme OU", ref_number: "RF123" },
      ],
      sales: [
        { id: 10, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-10", clients_id: 20, client_name: "Acme OU", gross_price: 100, bank_ref_number: "RF123" },
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("DRY_RUN");
    expect(payload.auto_confirmed).toBe(1);
    expect(payload.results[0]!.status).toBe("would_confirm");
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("execute mode calls confirm with correct distribution", async () => {
    const { handler, api } = setupAutoConfirmTool({
      transactions: [
        { id: 2, status: "PROJECT", is_deleted: false, type: "D", amount: 200, date: "2026-03-20", bank_account_name: "Beta OU", ref_number: "RF456" },
      ],
      sales: [
        { id: 11, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-11", clients_id: 21, client_name: "Beta OU", gross_price: 200, bank_ref_number: "RF456" },
      ],
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.results[0]!.status).toBe("confirmed");
    expect(payload.execution).toMatchObject({
      contract: "batch_execution_v1",
      mode: "EXECUTED",
      summary: {
        total_unconfirmed: 1,
        auto_confirmed: 1,
        skipped: 0,
        error_count: 0,
      },
      results: [
        expect.objectContaining({
          transaction_id: 2,
          status: "confirmed",
        }),
      ],
      errors: [],
      needs_review: [],
    });
    expect(api.transactions.confirm).toHaveBeenCalledWith(2, [
      { related_table: "sale_invoices", related_id: 11, amount: 200 },
    ]);
  });

  it("skips partially paid invoices", async () => {
    const { handler } = setupAutoConfirmTool({
      transactions: [
        { id: 3, status: "PROJECT", is_deleted: false, type: "D", amount: 100, date: "2026-03-20", bank_account_name: "Gamma OU" },
      ],
      sales: [
        { id: 12, status: "CONFIRMED", payment_status: "PARTIALLY_PAID", number: "ARV-12", clients_id: 22, client_name: "Gamma OU", gross_price: 100 },
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.auto_confirmed).toBe(0);
  });

  it("does not auto-confirm when multiple candidates match", async () => {
    const { handler } = setupAutoConfirmTool({
      transactions: [
        { id: 4, status: "PROJECT", is_deleted: false, type: "D", amount: 100, date: "2026-03-20", ref_number: "RF789" },
      ],
      sales: [
        { id: 13, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-13", clients_id: 23, gross_price: 100, bank_ref_number: "RF789" },
        { id: 14, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-14", clients_id: 24, gross_price: 100, bank_ref_number: "RF789" },
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.auto_confirmed).toBe(0);
  });

  it("auto-confirms type C transaction against sale invoice", async () => {
    const { handler, api } = setupAutoConfirmTool({
      transactions: [
        { id: 7, status: "PROJECT", is_deleted: false, type: "C", amount: 150, date: "2026-03-21", bank_account_name: "Delta OU", ref_number: "RF999" },
      ],
      sales: [
        { id: 16, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-16", clients_id: 26, client_name: "Delta OU", gross_price: 150, bank_ref_number: "RF999" },
      ],
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.auto_confirmed).toBe(1);
    expect(payload.results[0]!.status).toBe("confirmed");
    expect(api.transactions.confirm).toHaveBeenCalledWith(7, [
      { related_table: "sale_invoices", related_id: 16, amount: 150 },
    ]);
  });

  it("does not auto-confirm explicit incoming transactions against purchase invoices", async () => {
    const { handler, api } = setupAutoConfirmTool({
      transactions: [
        { id: 17, status: "PROJECT", is_deleted: false, type: "D", amount: 200, date: "2026-03-21", bank_account_name: "Supplier OU", ref_number: "RF200" },
      ],
      purchases: [
        { id: 26, status: "CONFIRMED", payment_status: "NOT_PAID", number: "OST-26", clients_id: 36, client_name: "Supplier OU", gross_price: 200, bank_ref_number: "RF200" },
      ],
    });

    const result = await handler({ execute: true, min_confidence: 0 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.auto_confirmed).toBe(0);
    expect(payload.results).toEqual([]);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("does not double-match the same invoice to two transactions", async () => {
    const { handler } = setupAutoConfirmTool({
      transactions: [
        { id: 5, status: "PROJECT", is_deleted: false, type: "D", amount: 100, date: "2026-03-20", ref_number: "RF111", clients_id: 25 },
        { id: 6, status: "PROJECT", is_deleted: false, type: "D", amount: 100, date: "2026-03-21", ref_number: "RF111", clients_id: 25 },
      ],
      sales: [
        { id: 15, status: "CONFIRMED", payment_status: "NOT_PAID", number: "ARV-15", clients_id: 25, gross_price: 100, bank_ref_number: "RF111" },
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    // Only the first transaction should match; the second should find the invoice consumed
    expect(payload.auto_confirmed).toBe(1);
  });

  it("auto-confirms base-amount matches when the reference number is exact", async () => {
    const { handler, api } = setupAutoConfirmTool({
      transactions: [
        {
          id: 18,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 1000,
          base_amount: 92,
          cl_currencies_id: "SEK",
          date: "2026-03-21",
          bank_account_name: "Acme OU",
          ref_number: "RF-BASE-92",
        },
      ],
      sales: [
        {
          id: 27,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
          number: "ARV-27",
          clients_id: 37,
          client_name: "Acme OU",
          gross_price: 100,
          base_gross_price: 92,
          cl_currencies_id: "USD",
          bank_ref_number: "RF-BASE-92",
        },
      ],
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.auto_confirmed).toBe(1);
    expect(payload.results[0]!.match.id).toBe(27);
    expect(api.transactions.confirm).toHaveBeenCalledWith(18, [
      { related_table: "sale_invoices", related_id: 27, amount: 1000 },
    ]);
  });
});

describe("reconcile_inter_account_transfers", () => {
  const bankAccounts = [
    { id: 1, account_name_est: "LHV", account_no: "EE123456789012345678", iban_code: "EE123456789012345678", accounts_dimensions_id: 100 },
    { id: 2, account_name_est: "SEB", account_no: "EE987654321098765432", iban_code: "EE987654321098765432", accounts_dimensions_id: 200 },
  ];

  it("matches a C↔D pair with same amount, same date, and counterparty IBAN matching own account", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 1, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432", description: "Ülekanne SEB kontole" },
        { id: 2, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678", description: "Ülekanne LHV kontolt" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(1);
    expect(payload.pairs[0]!.outgoing_transaction_id).toBe(1);
    expect(payload.pairs[0]!.incoming_transaction_id).toBe(2);
    expect(payload.pairs[0]!.amount).toBe(500);
    expect(payload.pairs[0]!.from_account).toBe("LHV");
    expect(payload.pairs[0]!.to_account).toBe("SEB");
    expect(payload.pairs[0]!.confidence).toBeGreaterThanOrEqual(90);
    expect(payload.pairs[0]!.status).toBe("would_confirm");
  });

  it("matches pairs with 1-day date gap", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 3, status: "PROJECT", is_deleted: false, type: "C", amount: 1000, date: "2026-03-19", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 4, status: "PROJECT", is_deleted: false, type: "D", amount: 1000, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(1);
    expect(payload.pairs[0]!.match_reasons).toContain("exact_amount");
  });

  it("rejects oversized max_date_gap values", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 5, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-15", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 6, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    await expect(handler({ max_date_gap: 1000000 })).rejects.toThrow(
      "max_date_gap must be an integer between 0 and 31."
    );
  });

  it("does not match when date gap exceeds max_date_gap", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 5, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-15", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 6, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
  });

  it("does not match transactions on the same account", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 7, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 8, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
  });

  it("does not match when amounts differ", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 9, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 10, status: "PROJECT", is_deleted: false, type: "D", amount: 499, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
  });

  it("pairs reciprocal same-type own-IBAN transfers instead of treating both legs as one-sided", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 109, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432", bank_account_name: "SEB", description: "Transfer to SEB" },
        { id: 110, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678", bank_account_name: "LHV", description: "Transfer from LHV" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(1);
    expect(payload.matched_one_sided).toBe(0);
    expect(payload.pairs[0]!.outgoing_transaction_id).toBe(109);
    expect(payload.pairs[0]!.incoming_transaction_id).toBe(110);
    expect(payload.pairs[0]!.match_reasons).toContain("same_type_reciprocal_own_iban");
  });

  it("pairs reciprocal same-type company-name transfers when both sides strongly infer each other", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 115, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: null, bank_account_name: "Test OÜ", description: "Transfer out" },
        { id: 116, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: null, bank_account_name: "Test OÜ", description: "Transfer in" },
      ],
      bankAccounts,
      companyName: "Test OÜ",
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(1);
    expect(payload.matched_one_sided).toBe(0);
    expect(payload.pairs[0]!.outgoing_transaction_id).toBe(115);
    expect(payload.pairs[0]!.incoming_transaction_id).toBe(116);
    expect(payload.pairs[0]!.match_reasons).toContain("same_type_reciprocal_target_inference");
  });

  it("confirms reciprocal same-type own-IBAN transfers through the pair path when execute=true", async () => {
    const { handler, api } = setupInterAccountTool({
      transactions: [
        { id: 111, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432", bank_account_name: "SEB", description: "Transfer to SEB" },
        { id: 112, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678", bank_account_name: "LHV", description: "Transfer from LHV" },
      ],
      bankAccounts,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.matched_pairs).toBe(1);
    expect(payload.matched_one_sided).toBe(0);
    expect(payload.pairs[0]!.status).toBe("confirmed");
    expect(api.transactions.confirm).toHaveBeenCalledTimes(2);
    expect(api.transactions.confirm).toHaveBeenCalledWith(111, [
      { related_table: "accounts", related_id: 1020, related_sub_id: 200, amount: 500 },
    ]);
    expect(api.transactions.confirm).toHaveBeenCalledWith(112, [
      { related_table: "accounts", related_id: 1020, related_sub_id: 100, amount: 500 },
    ]);
  });

  it("does not pair or one-side-match reciprocal same-type transfers when base amounts conflict", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 113, status: "PROJECT", is_deleted: false, type: "C", amount: 100, base_amount: 92, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432", bank_account_name: "SEB" },
        { id: 114, status: "PROJECT", is_deleted: false, type: "C", amount: 100, base_amount: 100, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678", bank_account_name: "LHV" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
    expect(payload.matched_one_sided).toBe(0);
  });

  it("matches FX pairs by base amount and does not fall back to one-sided matches", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        {
          id: 101,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 100,
          base_amount: 100,
          cl_currencies_id: "EUR",
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          bank_account_no: "EE987654321098765432",
        },
        {
          id: 102,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 110,
          base_amount: 100,
          cl_currencies_id: "USD",
          date: "2026-03-20",
          accounts_dimensions_id: 200,
          bank_account_no: "EE123456789012345678",
        },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(1);
    expect(payload.matched_one_sided).toBe(0);
    expect(payload.pairs[0]!.outgoing_transaction_id).toBe(101);
    expect(payload.pairs[0]!.incoming_transaction_id).toBe(102);
    expect(payload.pairs[0]!.match_reasons).toContain("exact_base_amount");
  });

  it("does not pair or one-side-match conflicting nominal FX amounts when both legs strongly point to each other", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        {
          id: 103,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 100,
          base_amount: 92,
          cl_currencies_id: "USD",
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          bank_account_no: "EE987654321098765432",
        },
        {
          id: 104,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 100,
          base_amount: 100,
          cl_currencies_id: "EUR",
          date: "2026-03-20",
          accounts_dimensions_id: 200,
          bank_account_no: "EE123456789012345678",
        },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
    expect(payload.matched_one_sided).toBe(0);
  });

  it("still allows a valid one-sided own-IBAN match when an unrelated opposite-side transaction shares the nominal amount", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        {
          id: 105,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 100,
          base_amount: 92,
          cl_currencies_id: "USD",
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          bank_account_name: "Transfer",
          bank_account_no: "BE08905767222113",
        },
        {
          id: 106,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 100,
          base_amount: 100,
          cl_currencies_id: "EUR",
          date: "2026-03-20",
          accounts_dimensions_id: 200,
          bank_account_name: "Customer",
          bank_account_no: "EE000000000000000000",
        },
      ],
      bankAccounts: [
        ...bankAccounts,
        { id: 3, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
    expect(payload.matched_one_sided).toBe(1);
    expect(payload.one_sided[0]!.transaction_id).toBe(105);
    expect(payload.one_sided[0]!.target_dimension_id).toBe(300);
    expect(payload.one_sided[0]!.match_reasons).toContain("counterparty_iban_is_own_account");
  });

  it("does not suppress distinct one-sided transfers just because both counterparty IBANs are own accounts", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        {
          id: 107,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 100,
          base_amount: 92,
          cl_currencies_id: "USD",
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          bank_account_name: "Transfer to Wise",
          bank_account_no: "BE08905767222113",
        },
        {
          id: 108,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 100,
          base_amount: 100,
          cl_currencies_id: "EUR",
          date: "2026-03-20",
          accounts_dimensions_id: 200,
          bank_account_name: "Transfer from LHV",
          bank_account_no: "EE123456789012345678",
        },
      ],
      bankAccounts: [
        ...bankAccounts,
        { id: 3, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ],
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
    expect(payload.matched_one_sided).toBe(2);
    expect(payload.one_sided).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transaction_id: 107,
        target_dimension_id: 300,
        match_reasons: expect.arrayContaining(["counterparty_iban_is_own_account"]),
      }),
      expect.objectContaining({
        transaction_id: 108,
        target_dimension_id: 100,
        match_reasons: expect.arrayContaining(["counterparty_iban_is_own_account"]),
      }),
    ]));
  });

  it("skips ambiguous pair matches instead of picking the first incoming candidate", async () => {
    const { handler, api } = setupInterAccountTool({
      transactions: [
        { id: 25, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_name: "Transfer" },
        { id: 26, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_name: "Transfer" },
        { id: 27, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 300, bank_account_name: "Transfer" },
      ],
      bankAccounts: [
        ...bankAccounts,
        { id: 3, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ],
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
    expect(payload.skipped_ambiguous).toBe(1);
    expect(payload.ambiguous_pairs).toEqual([
      expect.objectContaining({
        outgoing_transaction_id: 25,
        candidate_incoming_transaction_ids: [26, 27],
        confidence: 60,
      }),
    ]);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("confirms both sides with correct distribution when execute=true", async () => {
    const { handler, api } = setupInterAccountTool({
      transactions: [
        { id: 11, status: "PROJECT", is_deleted: false, type: "C", amount: 750, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 12, status: "PROJECT", is_deleted: false, type: "D", amount: 750, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.matched_pairs).toBe(1);
    expect(payload.pairs[0]!.status).toBe("confirmed");
    expect(payload.execution).toMatchObject({
      contract: "batch_execution_v1",
      mode: "EXECUTED",
      summary: {
        total_unconfirmed: 2,
        matched_pairs: 1,
        matched_one_sided: 0,
        skipped_ambiguous: 0,
        skipped_already_handled: 0,
        error_count: 0,
      },
      results: [
        expect.objectContaining({
          outgoing_transaction_id: 11,
          incoming_transaction_id: 12,
          status: "confirmed",
        }),
      ],
      skipped: [],
      errors: [],
    });

    // Outgoing confirmed with destination account + dimension
    expect(api.transactions.confirm).toHaveBeenCalledWith(11, [
      { related_table: "accounts", related_id: 1020, related_sub_id: 200, amount: 750 },
    ]);
    // Incoming confirmed with source account + dimension
    expect(api.transactions.confirm).toHaveBeenCalledWith(12, [
      { related_table: "accounts", related_id: 1020, related_sub_id: 100, amount: 750 },
    ]);
  });

  it("does not double-match a transaction", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 13, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 14, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 15, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    // Only one pair matched, the second C stays unmatched
    expect(payload.matched_pairs).toBe(1);
  });

  it("skips already confirmed transactions", async () => {
    const { handler } = setupInterAccountTool({
      transactions: [
        { id: 16, status: "CONFIRMED", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 17, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_no: "EE123456789012345678" },
      ],
      bankAccounts,
    });

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
  });

  it("ignores VOID transactions when matching transfers", async () => {
    const { handler, api } = setupInterAccountTool({
      transactions: [
        { id: 18, status: "VOID", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE987654321098765432" },
        { id: 19, status: "PROJECT", is_deleted: false, type: "D", amount: 500, date: "2026-03-20", accounts_dimensions_id: 200, bank_account_name: "Random Counterparty", bank_account_no: null },
      ],
      bankAccounts,
    });

    const result = await handler({ execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.total_unconfirmed).toBe(1);
    expect(payload.matched_pairs).toBe(0);
    expect(payload.matched_one_sided).toBe(0);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  describe("one-sided transfers (Phase 2)", () => {
    it("detects one-sided transfer by company name when only 2 bank accounts", async () => {
      const twoAccounts = [
        { id: 1, account_name_est: "LHV", account_no: "EE123456789012345678", iban_code: "EE123456789012345678", accounts_dimensions_id: 100 },
        { id: 2, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ];

      const { handler } = setupInterAccountTool({
        transactions: [
          { id: 20, status: "PROJECT", is_deleted: false, type: "C", amount: 60, date: "2026-01-21", accounts_dimensions_id: 300, bank_account_name: "Test OÜ", bank_account_no: null },
        ],
        bankAccounts: twoAccounts,
        companyName: "Test OÜ",
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(1);
      expect(payload.one_sided[0]!.transaction_id).toBe(20);
      expect(payload.one_sided[0]!.source_account).toBe("Wise");
      expect(payload.one_sided[0]!.target_account).toBe("LHV");
      expect(payload.one_sided[0]!.target_dimension_id).toBe(100);
      expect(payload.one_sided[0]!.match_reasons).toContain("counterparty_name_matches_company");
      expect(payload.one_sided[0]!.match_reasons).toContain("only_one_other_account");
    });

    it("uses target_accounts_dimensions_id when 3+ bank accounts", async () => {
      const { handler } = setupInterAccountTool({
        transactions: [
          { id: 21, status: "PROJECT", is_deleted: false, type: "C", amount: 850, date: "2026-01-13", accounts_dimensions_id: 300, bank_account_name: "Test OÜ", bank_account_no: null },
        ],
        bankAccounts: [
          ...bankAccounts,
          { id: 3, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
        ],
        companyName: "Test OÜ",
      });

      // Without target param → no match (ambiguous, 2 other accounts)
      const result1 = await handler({});
      const payload1 = parseMcpResponse(result1.content[0]!.text);
      expect(payload1.matched_one_sided).toBe(0);

      // With target param → matches
      const result2 = await handler({ target_accounts_dimensions_id: 100 });
      const payload2 = parseMcpResponse(result2.content[0]!.text);
      expect(payload2.matched_one_sided).toBe(1);
      expect(payload2.one_sided[0]!.target_dimension_id).toBe(100);
      expect(payload2.one_sided[0]!.match_reasons).toContain("target_from_parameter");
    });

    it("detects one-sided transfer by counterparty IBAN matching own account", async () => {
      const { handler } = setupInterAccountTool({
        transactions: [
          { id: 22, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_name: "Some Name", bank_account_no: "EE987654321098765432" },
        ],
        bankAccounts,
        companyName: "Test OÜ",
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(1);
      expect(payload.one_sided[0]!.target_dimension_id).toBe(200);
      expect(payload.one_sided[0]!.match_reasons).toContain("counterparty_iban_is_own_account");
      expect(payload.one_sided[0]!.confidence).toBeGreaterThanOrEqual(90);
    });

    it("does not detect one-sided if counterparty name does not match company", async () => {
      const { handler } = setupInterAccountTool({
        transactions: [
          { id: 23, status: "PROJECT", is_deleted: false, type: "C", amount: 100, date: "2026-03-20", accounts_dimensions_id: 100, bank_account_name: "Random Company", bank_account_no: null },
        ],
        bankAccounts,
        companyName: "Test OÜ",
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(0);
    });

    it("confirms one-sided transfer with correct distribution when execute=true", async () => {
      const twoAccounts = [
        { id: 1, account_name_est: "LHV", account_no: "EE123456789012345678", iban_code: "EE123456789012345678", accounts_dimensions_id: 100 },
        { id: 2, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ];

      const { handler, api } = setupInterAccountTool({
        transactions: [
          { id: 24, status: "PROJECT", is_deleted: false, type: "C", amount: 750, date: "2026-03-20", accounts_dimensions_id: 300, bank_account_name: "Test OÜ", bank_account_no: null },
        ],
        bankAccounts: twoAccounts,
        companyName: "Test OÜ",
      });

      const result = await handler({ execute: true });
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.mode).toBe("EXECUTED");
      expect(payload.matched_one_sided).toBe(1);
      expect(payload.one_sided[0]!.status).toBe("confirmed");

      expect(api.transactions.confirm).toHaveBeenCalledWith(24, [
        { related_table: "accounts", related_id: 1020, related_sub_id: 100, amount: 750 },
      ]);
    });

    it("skips one-sided transfer when already journalized from other side", async () => {
      const twoAccounts = [
        { id: 1, account_name_est: "LHV", account_no: "EE123456789012345678", iban_code: "EE123456789012345678", accounts_dimensions_id: 100 },
        { id: 2, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ];

      const { handler } = setupInterAccountTool({
        transactions: [
          { id: 30, status: "PROJECT", is_deleted: false, type: "C", amount: 800, date: "2025-12-05", accounts_dimensions_id: 300, bank_account_name: "Test OÜ", bank_account_no: null },
        ],
        bankAccounts: twoAccounts,
        companyName: "Test OÜ",
        journals: [{
          id: 999, effective_date: "2025-12-05", is_deleted: false, registered: true,
          postings: [
            { accounts_id: 1020, accounts_dimensions_id: 100, type: "C", amount: 800, is_deleted: false },
            { accounts_id: 1020, accounts_dimensions_id: 300, type: "D", amount: 800, is_deleted: false },
          ],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(0);
      expect(payload.skipped_already_handled).toBe(1);
      expect(payload.already_handled[0]!.transaction_id).toBe(30);
      expect(payload.already_handled[0]!.existing_journal_id).toBe(999);
    });

    it("detects already-journalized FX transfers using the transaction base amount", async () => {
      const twoAccounts = [
        { id: 1, account_name_est: "LHV", account_no: "EE123456789012345678", iban_code: "EE123456789012345678", accounts_dimensions_id: 100 },
        { id: 2, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ];

      const { handler } = setupInterAccountTool({
        transactions: [
          {
            id: 32,
            status: "PROJECT",
            is_deleted: false,
            type: "C",
            amount: 110,
            base_amount: 100,
            cl_currencies_id: "USD",
            date: "2025-12-05",
            accounts_dimensions_id: 300,
            bank_account_name: "Test OÜ",
            bank_account_no: null,
          },
        ],
        bankAccounts: twoAccounts,
        companyName: "Test OÜ",
        journals: [{
          id: 1001, effective_date: "2025-12-05", is_deleted: false, registered: true,
          postings: [
            { accounts_id: 1020, accounts_dimensions_id: 100, type: "C", amount: 100, is_deleted: false },
            { accounts_id: 1020, accounts_dimensions_id: 300, type: "D", amount: 100, is_deleted: false },
          ],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(0);
      expect(payload.skipped_already_handled).toBe(1);
      expect(payload.already_handled[0]!.transaction_id).toBe(32);
      expect(payload.already_handled[0]!.existing_journal_id).toBe(1001);
    });

    it("detects already-journalized transfers even when bank dimensions use non-1020 parent accounts", async () => {
      const twoAccounts = [
        { id: 1, account_name_est: "LHV", account_no: "EE123456789012345678", iban_code: "EE123456789012345678", accounts_dimensions_id: 100 },
        { id: 2, account_name_est: "Wise", account_no: "BE08905767222113", iban_code: "BE08905767222113", accounts_dimensions_id: 300 },
      ];

      const { handler } = setupInterAccountTool({
        transactions: [
          { id: 31, status: "PROJECT", is_deleted: false, type: "C", amount: 800, date: "2025-12-05", accounts_dimensions_id: 300, bank_account_name: "Test OÜ", bank_account_no: null },
        ],
        bankAccounts: twoAccounts,
        accountDimensions: [
          { id: 100, accounts_id: 1210, is_deleted: false },
          { id: 300, accounts_id: 1220, is_deleted: false },
        ],
        companyName: "Test OÜ",
        journals: [{
          id: 1000, effective_date: "2025-12-05", is_deleted: false, registered: true,
          postings: [
            { accounts_id: 1210, accounts_dimensions_id: 100, type: "C", amount: 800, is_deleted: false },
            { accounts_id: 1220, accounts_dimensions_id: 300, type: "D", amount: 800, is_deleted: false },
          ],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(0);
      expect(payload.skipped_already_handled).toBe(1);
      expect(payload.already_handled[0]!.transaction_id).toBe(31);
      expect(payload.already_handled[0]!.existing_journal_id).toBe(1000);
    });
  });
});

describe("matchScore", () => {
  const baseTx = {
    id: 1,
    type: "C",
    amount: 100,
    date: "2026-03-20",
    cl_currencies_id: "EUR",
    accounts_dimensions_id: 100,
  };

  it("returns exact_amount when transaction amount matches invoice gross_price", () => {
    const result = matchScore(baseTx, { gross_price: 100 }, 100);
    expect(result.confidence).toBeGreaterThanOrEqual(40);
    expect(result.reasons).toContain("exact_amount");
  });

  it("returns exact_base_amount when base amounts match via currency_rate fallback", () => {
    // Invoice has no base_gross_price but has currency_rate.
    // getComparableBaseInvoiceAmount computes: gross_price * currency_rate = 100 * 0.92 = 92
    // tx.base_amount = 92, txAmount = 1000 (SEK), invoice.gross_price = 100 (USD)
    // txAmount (1000) !== invoiceAmount (100) so exact_amount is skipped;
    // baseAmount (92) === baseInvoiceAmount (92) triggers exact_base_amount.
    const tx = { ...baseTx, amount: 1000, base_amount: 92, cl_currencies_id: "SEK" };
    const invoice = { gross_price: 100, currency_rate: 0.92 };
    const result = matchScore(tx, invoice, 1000);
    expect(result.reasons).toContain("exact_base_amount");
    expect(result.confidence).toBeGreaterThanOrEqual(40);
  });

  it("returns exact_base_amount when base_gross_price is explicit on invoice", () => {
    const tx = { ...baseTx, amount: 1000, base_amount: 92, cl_currencies_id: "SEK" };
    const invoice = { gross_price: 100, base_gross_price: 92 };
    const result = matchScore(tx, invoice, 1000);
    expect(result.reasons).toContain("exact_base_amount");
  });

  it("adds ref_number score when references match", () => {
    const tx = { ...baseTx, ref_number: "RF123" };
    const invoice = { gross_price: 100, bank_ref_number: "RF123" };
    const result = matchScore(tx, invoice, 100);
    expect(result.reasons).toContain("ref_number");
    expect(result.confidence).toBeGreaterThanOrEqual(80);
  });

  it("adds client_id score when client IDs match", () => {
    const tx = { ...baseTx, clients_id: 42 };
    const invoice = { gross_price: 100, clients_id: 42 };
    const result = matchScore(tx, invoice, 100);
    expect(result.reasons).toContain("client_id");
  });

  it("adds client_name_partial score when company names partially match", () => {
    const tx = { ...baseTx, bank_account_name: "Acme Solutions OU" };
    const invoice = { gross_price: 100, client_name: "Acme Solutions" };
    const result = matchScore(tx, invoice, 100);
    expect(result.reasons).toContain("client_name_partial");
  });

  it("penalizes partially paid invoices", () => {
    const fullResult = matchScore(baseTx, { gross_price: 100, payment_status: "NOT_PAID" }, 100);
    const partialResult = matchScore(baseTx, { gross_price: 100, payment_status: "PARTIALLY_PAID" }, 100);
    expect(partialResult.partiallyPaidWarning).toBe(true);
    expect(partialResult.confidence).toBeLessThan(fullResult.confidence);
    expect(partialResult.reasons).toContain("partially_paid_warning");
  });

  it("returns close_amount when amounts are within 1 but not exact", () => {
    const result = matchScore(baseTx, { gross_price: 100.5 }, 100);
    expect(result.reasons).toContain("close_amount");
  });

  it("caps confidence at 100", () => {
    const tx = { ...baseTx, ref_number: "RF123", clients_id: 42 };
    const invoice = { gross_price: 100, bank_ref_number: "RF123", clients_id: 42 };
    const result = matchScore(tx, invoice, 100);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });
});
