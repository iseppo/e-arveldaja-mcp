import { describe, expect, it, vi } from "vitest";
import { registerAnalyzeUnconfirmedTools } from "./analyze-unconfirmed.js";
import { parseMcpResponse } from "../mcp-json.js";

function setupTool(options: {
  transactions?: unknown[];
  sales?: unknown[];
  purchases?: unknown[];
  journals?: unknown[];
  bankAccounts?: unknown[];
  accountDimensions?: unknown[];
  companyName?: string;
} = {}) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactions ?? []),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.sales ?? []),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.purchases ?? []),
    },
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue(options.journals ?? []),
    },
    clients: {
      findByName: vi.fn().mockResolvedValue([]),
    },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue(options.bankAccounts ?? []),
      getAccountDimensions: vi.fn().mockResolvedValue(
        options.accountDimensions ??
          (options.bankAccounts ?? []).map((ba: any) => ({
            id: ba.accounts_dimensions_id,
            accounts_id: 1020,
            is_deleted: false,
          }))
      ),
      getInvoiceInfo: vi.fn().mockResolvedValue({
        invoice_company_name: options.companyName ?? "Test OÜ",
      }),
    },
  } as any;

  registerAnalyzeUnconfirmedTools(server, api);

  const registration = server.registerTool.mock.calls.find(
    ([name]: [string]) => name === "analyze_unconfirmed_transactions"
  );
  if (!registration) {
    throw new Error("Tool was not registered");
  }

  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

const defaultBankAccounts = [
  {
    id: 1,
    account_name_est: "LHV",
    account_no: "EE123456789012345678",
    iban_code: "EE123456789012345678",
    accounts_dimensions_id: 100,
  },
  {
    id: 2,
    account_name_est: "SEB",
    account_no: "EE987654321098765432",
    iban_code: "EE987654321098765432",
    accounts_dimensions_id: 200,
  },
];

describe("analyze_unconfirmed_transactions", () => {
  describe("duplicate detection", () => {
    it("flags likely_duplicate with confidence 70 when exactly one matching journal exists but bank_ref doesn't match", async () => {
      const handler = setupTool({
        transactions: [{
          id: 1,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 120,
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Payment",
          bank_account_name: "Acme OÜ",
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
        journals: [{
          id: 42,
          effective_date: "2026-03-20",
          is_deleted: false,
          registered: true,
          postings: [{
            accounts_dimensions_id: 100,
            type: "C",
            amount: 120,
            base_amount: null,
            is_deleted: false,
          }],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      expect(payload.suggestions[0]!.suggested_action).toBe("likely_duplicate");
      // Without a matching bank_ref_number we cannot distinguish a re-import from a
      // legitimate same-day movement, so the confidence stays below the 80+ band
      // reserved for the reimport_duplicate path (which requires a bank-ref match).
      expect(payload.suggestions[0]!.confidence).toBe(70);
      expect(payload.suggestions[0]!.duplicate_journal_id).toBe(42);
    });

    it("lowers confidence to 55 and notes ambiguity when multiple journals match without bank_ref shortcut", async () => {
      const handler = setupTool({
        transactions: [{
          id: 2,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 50,
          date: "2026-03-21",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Fee",
          bank_account_name: null,
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
        journals: [
          {
            id: 10,
            effective_date: "2026-03-21",
            is_deleted: false,
            registered: true,
            postings: [{
              accounts_dimensions_id: 100,
              type: "C",
              amount: 50,
              base_amount: null,
              is_deleted: false,
            }],
          },
          {
            id: 11,
            effective_date: "2026-03-21",
            is_deleted: false,
            registered: true,
            postings: [{
              accounts_dimensions_id: 100,
              type: "C",
              amount: 50,
              base_amount: null,
              is_deleted: false,
            }],
          },
        ],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions[0]!.suggested_action).toBe("likely_duplicate");
      // Ambiguous multi-journal match without a bank-ref shortcut: confidence
      // drops below the single-match value to highlight the verification gap.
      expect(payload.suggestions[0]!.confidence).toBe(55);
      expect(payload.suggestions[0]!.reason).toContain("ambiguous");
      expect(payload.suggestions[0]!.reason).toContain("2 matching journals");
    });

    it("promotes to reimport_duplicate with confidence 95 when bank_ref_number matches journal document_number", async () => {
      const handler = setupTool({
        transactions: [{
          id: 3,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 75,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Re-imported payment",
          bank_account_name: "Supplier OÜ",
          bank_account_no: null,
          bank_ref_number: "REF-XYZ-123",
        }],
        bankAccounts: defaultBankAccounts,
        journals: [{
          id: 99,
          effective_date: "2026-03-22",
          document_number: "REF-XYZ-123",
          operation_type: "TRANSACTION",
          is_deleted: false,
          registered: true,
          postings: [{
            accounts_dimensions_id: 100,
            type: "C",
            amount: 75,
            base_amount: null,
            is_deleted: false,
          }],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      expect(payload.suggestions[0]!.suggested_action).toBe("reimport_duplicate");
      expect(payload.suggestions[0]!.confidence).toBe(95);
      expect(payload.suggestions[0]!.duplicate_journal_id).toBe(99);
      expect(payload.suggestions[0]!.reason).toContain("REF-XYZ-123");
      expect(payload.suggestions[0]!.reason).toContain("safe to delete");
    });

    it("does not flag opposite-direction bank postings as duplicates", async () => {
      const handler = setupTool({
        transactions: [{
          id: 3,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 100,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Incoming customer payment",
          bank_account_name: "Acme OÜ",
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
        journals: [{
          id: 99,
          effective_date: "2026-03-22",
          is_deleted: false,
          registered: true,
          postings: [{
            accounts_dimensions_id: 100,
            type: "C",
            amount: 100,
            base_amount: null,
            is_deleted: false,
          }],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      expect(payload.suggestions[0]!.suggested_action).not.toBe("likely_duplicate");
      expect(payload.summary.likely_duplicate ?? 0).toBe(0);
    });

    it("detects duplicates using base amounts for foreign-currency transactions", async () => {
      const handler = setupTool({
        transactions: [{
          id: 4,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 100,
          base_amount: 92,
          date: "2026-03-23",
          accounts_dimensions_id: 100,
          cl_currencies_id: "USD",
          description: "USD payment",
          bank_account_name: "Acme OÜ",
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
        journals: [{
          id: 77,
          effective_date: "2026-03-23",
          is_deleted: false,
          registered: true,
          postings: [{
            accounts_dimensions_id: 100,
            type: "C",
            amount: 100,
            base_amount: 92,
            is_deleted: false,
          }],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      expect(payload.suggestions[0]!.suggested_action).toBe("likely_duplicate");
      expect(payload.suggestions[0]!.duplicate_journal_id).toBe(77);
      expect(payload.suggestions[0]!.reason).toContain("amount 92");
    });
  });

  describe("inter-account detection", () => {
    it("detects inter-account by counterparty IBAN matching own account", async () => {
      const handler = setupTool({
        transactions: [{
          id: 3,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 500,
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Transfer to SEB",
          bank_account_name: null,
          bank_account_no: "EE987654321098765432",
        }],
        bankAccounts: defaultBankAccounts,
        accountDimensions: [
          { id: 100, accounts_id: 1020, is_deleted: false },
          { id: 200, accounts_id: 1021, is_deleted: false },
        ],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      const s = payload.suggestions[0]!;
      expect(s.suggested_action).toBe("confirm_inter_account");
      expect(s.match_confidence).toBe(90);
      expect(s.reason).toContain("EE987654321098765432");
      expect(s.reason).toContain("SEB");
      expect(s.distribution).toEqual({
        related_table: "accounts",
        related_id: 1021,
        related_sub_id: 200,
        amount: 500,
      });
    });

    it("detects inter-account by company name match when exactly 1 other bank account", async () => {
      const twoAccounts = [
        {
          id: 1,
          account_name_est: "LHV",
          account_no: "EE123456789012345678",
          iban_code: "EE123456789012345678",
          accounts_dimensions_id: 100,
        },
        {
          id: 2,
          account_name_est: "Wise",
          account_no: "BE08905767222113",
          iban_code: "BE08905767222113",
          accounts_dimensions_id: 300,
        },
      ];

      const handler = setupTool({
        transactions: [{
          id: 4,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 60,
          date: "2026-01-21",
          accounts_dimensions_id: 300,
          cl_currencies_id: "EUR",
          description: "Internal transfer",
          bank_account_name: "Test OÜ",
          bank_account_no: null,
        }],
        bankAccounts: twoAccounts,
        companyName: "Test OÜ",
        accountDimensions: [
          { id: 100, accounts_id: 1020, is_deleted: false },
          { id: 300, accounts_id: 1030, is_deleted: false },
        ],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      const s = payload.suggestions[0]!;
      expect(s.suggested_action).toBe("confirm_inter_account");
      expect(s.match_confidence).toBe(80);
      expect(s.reason).toContain("Test OÜ");
      expect(s.reason).toContain("LHV");
      expect(s.distribution).toEqual({
        related_table: "accounts",
        related_id: 1020,
        related_sub_id: 100,
        amount: 60,
      });
    });
  });

  describe("invoice matching", () => {
    it("treats explicit incoming transactions as sale-invoice candidates, not purchase-invoice payments", async () => {
      const handler = setupTool({
        transactions: [{
          id: 50,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 200,
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Incoming payment",
          bank_account_name: "Vendor OÜ",
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
        sales: [{
          id: 30,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
          number: "ARV-30",
          clients_id: 30,
          client_name: "Vendor OÜ",
          gross_price: 200,
        }],
        purchases: [{
          id: 20,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
          number: "OST-20",
          clients_id: 30,
          client_name: "Vendor OÜ",
          gross_price: 200,
        }],
      });

      const result = await handler({ min_confidence: 0 });
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      const s = payload.suggestions[0]!;
      expect(s.suggested_action).toBe("confirm_invoice");
      expect(s.reason).toContain("sale_invoice");
      expect(s.reason).not.toContain("purchase_invoice");
      expect(s.distribution).toEqual({
        related_table: "sale_invoices",
        related_id: 30,
        amount: 200,
      });
    });

    it("matches a purchase invoice by amount", async () => {
      const handler = setupTool({
        transactions: [{
          id: 5,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 200,
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Invoice payment Supplier OÜ",
          bank_account_name: "Supplier OÜ",
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
        purchases: [{
          id: 20,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
          number: "OST-20",
          clients_id: 30,
          client_name: "Supplier OÜ",
          gross_price: 200,
        }],
      });

      const result = await handler({ min_confidence: 0 });
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      const s = payload.suggestions[0]!;
      expect(s.suggested_action).toBe("confirm_invoice");
      expect(s.reason).toContain("purchase_invoice");
      expect(s.reason).toContain("OST-20");
      expect(s.distribution).toEqual({
        related_table: "purchase_invoices",
        related_id: 20,
        amount: 200,
      });
    });
  });

  describe("expense detection", () => {
    it("detects a small bank fee by description pattern", async () => {
      const handler = setupTool({
        transactions: [{
          id: 6,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 3.5,
          date: "2026-03-15",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Konto hooldustasu",
          bank_account_name: null,
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      const s = payload.suggestions[0]!;
      expect(s.suggested_action).toBe("confirm_expense");
      expect(s.match_confidence).toBe(70);
      expect(s.reason).toContain("account_fee");
    });

    it("uses the transaction currency in the expense reason", async () => {
      const handler = setupTool({
        transactions: [{
          id: 7,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 5,
          date: "2026-03-15",
          accounts_dimensions_id: 100,
          cl_currencies_id: "USD",
          description: "Service fee",
          bank_account_name: null,
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions[0]!.reason).toContain("USD");
    });

    it("does not suggest expenses for incoming credits that match expense keywords", async () => {
      const handler = setupTool({
        transactions: [{
          id: 9,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 3.1,
          date: "2026-03-15",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Interest payment",
          bank_account_name: "LHV",
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      expect(payload.suggestions[0]!.suggested_action).not.toBe("confirm_expense");
      expect(payload.summary.confirm_expense ?? 0).toBe(0);
    });
  });

  describe("fallback", () => {
    it("falls back to manual_review when no pattern matches", async () => {
      const handler = setupTool({
        transactions: [{
          id: 8,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 9999,
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Unknown payment",
          bank_account_name: "Random Corp",
          bank_account_no: null,
        }],
        bankAccounts: defaultBankAccounts,
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      expect(payload.suggestions[0]!.suggested_action).toBe("manual_review");
    });
  });
});
