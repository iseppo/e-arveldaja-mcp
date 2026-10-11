import { describe, expect, it, vi } from "vitest";
import { registerAnalyzeUnconfirmedTools } from "./analyze-unconfirmed.js";
import { parseMcpResponse } from "../mcp-json.js";
import { buildCamtDescriptionWithMetadata, isTrustedCamtDescriptionMetadata } from "../camt/duplicate-identity.js";

/**
 * Re-sign a fixture's CAMT marker with a real checksum. Reconciliation excludes
 * a row whose marker sig fails verification (camt_marker_unverified), so a
 * fixture standing for a signed CAMT row must carry a sig that verifies.
 */
function camtSigned<T extends Record<string, any>>(tx: T): T {
  const description = String(tx.description ?? "");
  const direction = description.match(/\b(?:dir|d)=(CRDT|DBIT)\b/)?.[1] as "CRDT" | "DBIT";
  const clean = description.replace(/\n?\[e-arveldaja-mcp:camt [^\]]*\]$/, "") || undefined;
  const signed = {
    ...tx,
    description: buildCamtDescriptionWithMetadata(clean, {
      date: tx.date, amount: tx.amount, currency: tx.cl_currencies_id ?? "", direction,
      counterparty_name: tx.bank_account_name ?? undefined, counterparty_iban: tx.bank_account_no ?? undefined,
      bank_reference: tx.bank_ref_number ?? `FIXTURE-${tx.id}`, reference_number: tx.ref_number ?? undefined, description: clean,
    }),
  };
  if (!isTrustedCamtDescriptionMetadata(signed as any)) throw new Error(`fixture ${tx.id}: CAMT marker does not verify`);
  return signed;
}


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

    it("does NOT promote to reimport_duplicate when the matching journal is a PURCHASE_INVOICE (document_number is the invoice number, not a bank ref)", async () => {
      // Regression guard: bank_ref_number "123" must not be treated as identical
      // to a purchase-invoice journal whose document_number happens to be "123".
      // Otherwise a legitimate payment against invoice #123 would be suggested
      // for deletion at 95 confidence.
      const handler = setupTool({
        transactions: [{
          id: 4,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 200,
          date: "2026-03-23",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "Payment against invoice 123",
          bank_account_name: "Supplier OÜ",
          bank_account_no: null,
          bank_ref_number: "123",
        }],
        bankAccounts: defaultBankAccounts,
        journals: [{
          id: 123,
          effective_date: "2026-03-23",
          document_number: "123",
          operation_type: "PURCHASE_INVOICE",
          is_deleted: false,
          registered: true,
          postings: [{
            accounts_dimensions_id: 100,
            type: "C",
            amount: 200,
            base_amount: null,
            is_deleted: false,
          }],
        }],
      });

      const result = await handler({});
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      expect(payload.suggestions[0]!.suggested_action).toBe("likely_duplicate");
      expect(payload.suggestions[0]!.confidence).toBe(70);
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
          description: "Incoming customer payment\n[e-arveldaja-mcp:camt dir=CRDT sig=abc123abc123abcd]",
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

    it("checks both posting sides for an unsigned row whose direction is unknown", async () => {
      // The live API reads every transaction back as type "C" whatever was
      // stored (verified 2026-10), so an unsigned row's stored "D" proves
      // nothing: a same-amount bank posting on EITHER side is a duplicate suspect.
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
      expect(payload.suggestions[0]!.suggested_action).toBe("likely_duplicate");
      expect(payload.suggestions[0]!.duplicate_journal_id).toBe(99);
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
    it("does not pick a single target when the counterparty IBAN backs several own accounts", async () => {
      const handler = setupTool({
        transactions: [{
          id: 3, status: "PROJECT", is_deleted: false, type: "C", amount: 500, date: "2026-03-20",
          accounts_dimensions_id: 300, cl_currencies_id: "EUR", description: "Transfer to LHV",
          bank_account_name: null, bank_account_no: "EE11",
        }],
        bankAccounts: [
          { id: 1, account_name_est: "LHV EUR", account_no: "EE11", iban_code: "EE11", accounts_dimensions_id: 100 },
          { id: 2, account_name_est: "LHV USD", account_no: "EE11", iban_code: "EE11", accounts_dimensions_id: 200 },
          { id: 3, account_name_est: "Swed", account_no: "EE33", iban_code: "EE33", accounts_dimensions_id: 300 },
        ],
        accountDimensions: [
          { id: 100, accounts_id: 1020, is_deleted: false },
          { id: 200, accounts_id: 1021, is_deleted: false },
          { id: 300, accounts_id: 1022, is_deleted: false },
        ],
      });

      const payload = parseMcpResponse((await handler({})).content[0]!.text);

      expect(payload.suggestions).toHaveLength(1);
      const s = payload.suggestions[0]!;
      expect(s.suggested_action).toBe("confirm_inter_account");
      expect(s.match_confidence).toBe(60);
      expect(s.reason).toContain("specify target manually");
      expect(s.distribution).toBeUndefined();
    });

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

  describe("inter-account pairs reconcile would hold for review", () => {
    const lhvWise = [
      { id: 1, account_name_est: "LHV", account_no: "EE11", iban_code: "EE11", accounts_dimensions_id: 100 },
      { id: 2, account_name_est: "Wise", account_no: "BE22", iban_code: "BE22", accounts_dimensions_id: 300 },
    ];
    const base = { status: "PROJECT", is_deleted: false, type: "C", date: "2026-10-01", cl_currencies_id: "EUR" };
    const lhvOut = camtSigned({ ...base, id: 1, amount: 100, accounts_dimensions_id: 100, bank_account_no: "BE22", bank_account_name: "Test OÜ", description: "x\n[e-arveldaja-mcp:camt dir=DBIT sig=abcdefabcdefabcd]" });

    it("does not treat a payer whose name merely contains the company name as an own transfer", async () => {
      const handler = setupTool({
        transactions: [{ ...base, id: 9, amount: 60, accounts_dimensions_id: 300, bank_account_no: null, bank_account_name: "Test OÜ Client AS", description: "payment" }],
        bankAccounts: lhvWise,
        companyName: "Test OÜ",
      });
      const payload = parseMcpResponse((await handler({})).content[0]!.text);
      expect(payload.suggestions[0]!.suggested_action).not.toBe("confirm_inter_account");
    });

    it("downgrades both legs of a possible fee-deducted transfer to review without a distribution", async () => {
      const wiseIn = { ...base, id: 2, amount: 99, accounts_dimensions_id: 300, bank_account_no: null, bank_account_name: "Test OÜ", description: "WISE:TRANSFER-1 [source_direction=IN]" };
      const handler = setupTool({ transactions: [lhvOut, wiseIn], bankAccounts: lhvWise, companyName: "Test OÜ" });
      const payload = parseMcpResponse((await handler({})).content[0]!.text);
      expect(payload.suggestions).toHaveLength(2);
      for (const s of payload.suggestions) {
        expect(s.suggested_action).toBe("manual_review");
        expect(s.distribution).toBeUndefined();
        expect(s.reason).toMatch(/fee-deducted/);
      }
    });

    it("downgrades a pair whose mirror leg lacks own-origin evidence", async () => {
      const wiseIn = { ...base, id: 2, amount: 100, accounts_dimensions_id: 300, bank_account_no: "BE99POOL", bank_account_name: "Test OÜ", description: "WISE:TRANSFER-1 [source_direction=IN]" };
      const handler = setupTool({ transactions: [lhvOut, wiseIn], bankAccounts: lhvWise, companyName: "Test OÜ" });
      const payload = parseMcpResponse((await handler({})).content[0]!.text);
      expect(payload.suggestions).toHaveLength(2);
      for (const s of payload.suggestions) {
        expect(s.suggested_action).toBe("manual_review");
        expect(s.distribution).toBeUndefined();
        expect(s.reason).toMatch(/own-origin/);
      }
    });

    it("keeps the confirm suggestion for two same-direction rows (separate transfers)", async () => {
      const wiseOut = { ...base, id: 2, amount: 99, accounts_dimensions_id: 300, bank_account_no: null, bank_account_name: "Test OÜ", description: "WISE:TRANSFER-1 [source_direction=OUT]" };
      const handler = setupTool({ transactions: [lhvOut, wiseOut], bankAccounts: lhvWise, companyName: "Test OÜ" });
      const payload = parseMcpResponse((await handler({})).content[0]!.text);
      expect(payload.suggestions.map((s: any) => s.suggested_action)).toEqual(["confirm_inter_account", "confirm_inter_account"]);
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
          description: "Konto hooldustasu\n[e-arveldaja-mcp:camt dir=DBIT sig=abc123abc123abcd]",
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
          description: "Service fee\n[e-arveldaja-mcp:camt dir=DBIT sig=abc123abc123abcd]",
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
          type: "C",
          amount: 3.1,
          date: "2026-03-15",
          accounts_dimensions_id: 100,
          cl_currencies_id: "EUR",
          description: "WISE:interest LHV [source_direction=IN]",
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

describe("analyze_unconfirmed_transactions MEDIUM-5 hardening", () => {
  const journal = (id: number, date: string, postings: Array<{ dim: number; type: "D" | "C"; amount: number }>) => ({
    id, effective_date: date, is_deleted: false, registered: true,
    postings: postings.map(p => ({ accounts_id: 1020, accounts_dimensions_id: p.dim, type: p.type, amount: p.amount, base_amount: null, is_deleted: false })),
  });
  const baseTx = {
    id: 7, status: "PROJECT", is_deleted: false, amount: 100, date: "2026-03-22",
    accounts_dimensions_id: 100, cl_currencies_id: "EUR", bank_account_name: "Acme OÜ", bank_account_no: null,
  };

  it("keys the duplicate side on the signed direction, not the raw stored type", async () => {
    // Signed CRDT stored as legacy C: the money came IN, so the bank posting is D.
    const handler = setupTool({
      transactions: [{ ...baseTx, type: "C", description: "Receipt\n[e-arveldaja-mcp:camt d=CRDT s=abc123abc123abcd]" }],
      bankAccounts: defaultBankAccounts,
      journals: [journal(91, "2026-03-22", [{ dim: 100, type: "D", amount: 100 }])],
    });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    expect(payload.suggestions[0]).toMatchObject({ suggested_action: "likely_duplicate", duplicate_journal_id: 91 });
  });

  it("finds an already-booked journal one day off the transaction date", async () => {
    const handler = setupTool({
      transactions: [{ ...baseTx, type: "D", description: "Receipt" }],
      bankAccounts: defaultBankAccounts,
      journals: [journal(92, "2026-03-23", [{ dim: 100, type: "D", amount: 100 }])],
    });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    expect(payload.suggestions[0]).toMatchObject({ suggested_action: "likely_duplicate", duplicate_journal_id: 92 });
  });

  it("does not suggest confirming an own-account transfer Lane B already covers", async () => {
    // Legacy unsigned C on LHV, but the booked transfer shows money came IN
    // from SEB: the side-keyed scan misses it; the bidirectional Lane B key
    // does not.
    const handler = setupTool({
      transactions: [{ ...baseTx, type: "C", amount: 500, bank_account_no: "EE987654321098765432", description: "Transfer" }],
      bankAccounts: defaultBankAccounts,
      journals: [journal(93, "2026-03-21", [{ dim: 200, type: "C", amount: 500 }, { dim: 100, type: "D", amount: 500 }])],
    });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    expect(payload.suggestions[0]).toMatchObject({ suggested_action: "likely_duplicate", duplicate_journal_id: 93 });
    expect(payload.summary.confirm_inter_account ?? 0).toBe(0);
  });

  it("fails closed on a malformed invoice payment_status like the reconcile paths", async () => {
    const handler = setupTool({
      transactions: [{ ...baseTx, type: "D", description: "Payment", ref_number: "RF1" }],
      bankAccounts: defaultBankAccounts,
      sales: [{ id: 10, status: "CONFIRMED", payment_status: 42, number: "ARV-10", clients_id: 20, client_name: "Acme OÜ", gross_price: 100, bank_ref_number: "RF1" }],
    });
    await expect(handler({})).rejects.toThrow(/payment_status/);
  });
});

describe("analyze_unconfirmed_transactions F5 exact_invoice_base_amount", () => {
  const eurRow = {
    id: 901,
    status: "PROJECT",
    is_deleted: false,
    type: "C",
    amount: 290.03,
    date: "2026-09-15",
    accounts_dimensions_id: 100,
    cl_currencies_id: "EUR",
    clients_id: 77,
    description: "Card payment",
    bank_account_name: "Acme Cloud LLC",
    bank_account_no: null,
  };
  const usdInvoice = {
    id: 5487,
    status: "CONFIRMED",
    payment_status: "NOT_PAID",
    number: "INV-5487",
    clients_id: 77,
    client_name: "Acme Cloud LLC",
    cl_currencies_id: "USD",
    gross_price: 334.46,
    currency_rate: 1.1532,
    base_gross_price: 290.03,
  };

  it("suggests confirm_invoice with the EUR row amount for a unique match", async () => {
    const handler = setupTool({ transactions: [eurRow], bankAccounts: defaultBankAccounts, purchases: [usdInvoice] });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    const s = payload.suggestions[0]!;
    expect(s.suggested_action).toBe("confirm_invoice");
    expect(s.reason).toContain("exact_invoice_base_amount");
    expect(s.distribution).toEqual({ related_table: "purchase_invoices", related_id: 5487, amount: 290.03 });
  });

  it("holds a tie between two Tier A invoices for manual review without a distribution", async () => {
    const handler = setupTool({
      transactions: [eurRow],
      bankAccounts: defaultBankAccounts,
      purchases: [usdInvoice, { ...usdInvoice, id: 5488, number: "INV-5488", gross_price: 330 }],
    });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    const s = payload.suggestions[0]!;
    expect(s.suggested_action).toBe("manual_review");
    expect(s.distribution).toBeUndefined();
    expect(s.reason).toContain("ambiguous_foreign_invoice_base");
    expect(s.candidate_invoices).toEqual([
      { related_table: "purchase_invoices", related_id: 5487 },
      { related_table: "purchase_invoices", related_id: 5488 },
    ]);
  });

  // Codex counterexample: same client, EUR 100 invoice and USD 200 invoice with
  // base EUR 100. Both score 55; neither order may yield a distribution.
  const eur100Row = { ...eurRow, id: 902, amount: 100 };
  const eurInvoice = { ...usdInvoice, id: 6001, number: "INV-6001", cl_currencies_id: "EUR", gross_price: 100, currency_rate: 1, base_gross_price: 100 };
  const usd200Invoice = { ...usdInvoice, id: 6002, number: "INV-6002", gross_price: 200, currency_rate: 2, base_gross_price: 100 };
  it.each([
    ["EUR invoice first", [eurInvoice, usd200Invoice]],
    ["USD invoice first", [usd200Invoice, eurInvoice]],
  ])("holds a mixed exact_amount / Tier A top-score tie for review (%s)", async (_label, purchases) => {
    const handler = setupTool({ transactions: [eur100Row], bankAccounts: defaultBankAccounts, purchases });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    const s = payload.suggestions[0]!;
    expect(s.suggested_action).toBe("manual_review");
    expect(s.distribution).toBeUndefined();
    expect(s.reason).toContain("ambiguous_foreign_invoice_base");
    expect(s.candidate_invoices).toEqual(expect.arrayContaining([
      { related_table: "purchase_invoices", related_id: 6001 },
      { related_table: "purchase_invoices", related_id: 6002 },
    ]));
  });
});

// --- WP3 (F4): CAMT marker IBAN in inter-account suggestions ------------------
describe("analyze_unconfirmed_transactions: CAMT marker IBAN (F4)", () => {
  const WISE_IBAN = "BE08905767222113";
  const threeAccounts = [
    ...defaultBankAccounts,
    { id: 3, account_name_est: "Wise", account_no: WISE_IBAN, iban_code: WISE_IBAN, accounts_dimensions_id: 300 },
  ];
  /** A PROJECT row as MCP-CAMT stores it: bank_account_no null, the IBAN only in the signed marker. */
  function camtRow(id: number) {
    const amount = 600;
    const date = "2026-09-26";
    return {
      id, status: "PROJECT", is_deleted: false, type: "C", amount, cl_currencies_id: "EUR", date,
      accounts_dimensions_id: 100, bank_account_name: "Näide OU", bank_account_no: null, bank_ref_number: null,
      description: buildCamtDescriptionWithMetadata("Näide OU", {
        date, amount, currency: "EUR", direction: "DBIT", counterparty_name: "Näide OU",
        counterparty_iban: WISE_IBAN, bank_reference: `REF${id}`, description: "Näide OU",
      }),
    };
  }

  it("suggests confirm_inter_account to the verified marker IBAN's account", async () => {
    const handler = setupTool({ transactions: [camtRow(5002)], bankAccounts: threeAccounts, companyName: "Näide OÜ" });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    expect(payload.suggestions[0]).toMatchObject({ transaction_id: 5002, suggested_action: "confirm_inter_account", match_confidence: 90 });
    expect(payload.suggestions[0]!.distribution).toMatchObject({ related_sub_id: 300 });
  });

  const tamper = (description: string) => description.replace(/sig=([a-f0-9])/, (_m, c: string) => `sig=${c === "0" ? "1" : "0"}`);

  it("an encoded line break before the marker does not hide a tampered sig", async () => {
    for (const encoded of ["&#10;", "&#xA;"]) {
      const row = camtRow(5002);
      const tampered = { ...row, bank_account_name: "Näide OÜ", description: tamper(row.description!).replace("\n[e-arveldaja-mcp:camt", `${encoded}[e-arveldaja-mcp:camt`) };
      const handler = setupTool({ transactions: [tampered], bankAccounts: [defaultBankAccounts[0]!, threeAccounts[2]!], companyName: "Näide OÜ" });
      const payload = parseMcpResponse((await handler({})).content[0]!.text);
      expect(payload.suggestions[0]).toMatchObject({ transaction_id: 5002, suggested_action: "manual_review", code: "camt_marker_unverified" });
    }
  });

  it("an empty direct IBAN does not hide a tampered marker's own-account claim (no confirm_invoice)", async () => {
    for (const direct of ["", "   "]) {
      const row = camtRow(5002);
      const tampered = { ...row, bank_account_name: "Wise", bank_account_no: direct, clients_id: 77, description: tamper(row.description!) };
      const handler = setupTool({
        transactions: [tampered], bankAccounts: [defaultBankAccounts[0]!, threeAccounts[2]!], companyName: "Näide OÜ",
        purchases: [{ id: 901, status: "CONFIRMED", payment_status: "NOT_PAID", number: "OST-901", clients_id: 77, client_name: "Wise", gross_price: 600, cl_currencies_id: "EUR" }],
      });
      const payload = parseMcpResponse((await handler({ min_confidence: 0 })).content[0]!.text);
      expect(payload.suggestions[0]).toMatchObject({ transaction_id: 5002, suggested_action: "manual_review", code: "camt_marker_unverified" });
      expect(payload.suggestions[0]!.distribution).toBeUndefined();
    }
  });

  it("gives no confirm_inter_account suggestion for a marker whose sig fails the checksum", async () => {
    const row = camtRow(5002);
    const tampered = { ...row, bank_account_name: "Näide OÜ", description: row.description!.replace(/sig=([a-f0-9])/, (_m, c: string) => `sig=${c === "0" ? "1" : "0"}`) };
    const handler = setupTool({ transactions: [tampered], bankAccounts: [defaultBankAccounts[0]!, threeAccounts[2]!], companyName: "Näide OÜ" });
    const payload = parseMcpResponse((await handler({})).content[0]!.text);
    expect(payload.suggestions[0]).toMatchObject({ transaction_id: 5002, suggested_action: "manual_review", code: "camt_marker_unverified" });
    expect(payload.suggestions[0]!.distribution).toBeUndefined();
  });
});
