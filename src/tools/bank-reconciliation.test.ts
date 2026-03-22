import { describe, expect, it, vi } from "vitest";
import { registerBankReconciliationTools } from "./bank-reconciliation.js";

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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.best_match.partially_paid_warning).toBe(true);
    expect(payload.matches[0]!.distribution_ready).toBe(false);
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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.distribution_ready).toBe(true);
    expect(payload.matches[0]!.distribution).toEqual({
      related_table: "sale_invoices",
      related_id: 11,
      amount: 250,
    });
    expect(payload.matches[0]!.manual_review_required).toBeUndefined();
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
    const payload = JSON.parse(result.content[0]!.text);

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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.results[0]!.status).toBe("confirmed");
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
    const payload = JSON.parse(result.content[0]!.text);

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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.auto_confirmed).toBe(0);
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
    const payload = JSON.parse(result.content[0]!.text);

    // Only the first transaction should match; the second should find the invoice consumed
    expect(payload.auto_confirmed).toBe(1);
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
    const payload = JSON.parse(result.content[0]!.text);

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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(1);
    expect(payload.pairs[0]!.match_reasons).toContain("exact_amount");
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
    const payload = JSON.parse(result.content[0]!.text);

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
    const payload = JSON.parse(result.content[0]!.text);

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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.matched_pairs).toBe(1);
    expect(payload.pairs[0]!.status).toBe("confirmed");

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
    const payload = JSON.parse(result.content[0]!.text);

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
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.matched_pairs).toBe(0);
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
      const payload = JSON.parse(result.content[0]!.text);

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
      const payload1 = JSON.parse(result1.content[0]!.text);
      expect(payload1.matched_one_sided).toBe(0);

      // With target param → matches
      const result2 = await handler({ target_accounts_dimensions_id: 100 });
      const payload2 = JSON.parse(result2.content[0]!.text);
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
      const payload = JSON.parse(result.content[0]!.text);

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
      const payload = JSON.parse(result.content[0]!.text);

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
      const payload = JSON.parse(result.content[0]!.text);

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
      const payload = JSON.parse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(0);
      expect(payload.skipped_already_handled).toBe(1);
      expect(payload.already_handled[0]!.transaction_id).toBe(30);
      expect(payload.already_handled[0]!.existing_journal_id).toBe(999);
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
      const payload = JSON.parse(result.content[0]!.text);

      expect(payload.matched_one_sided).toBe(0);
      expect(payload.skipped_already_handled).toBe(1);
      expect(payload.already_handled[0]!.transaction_id).toBe(31);
      expect(payload.already_handled[0]!.existing_journal_id).toBe(1000);
    });
  });
});
