import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { parseMcpResponse } from "../mcp-json.js";
import { resetAccountingRulesCache } from "../accounting-rules.js";

const ORIGINAL_RULES_FILE = process.env.EARVELDAJA_RULES_FILE;

afterEach(() => {
  if (ORIGINAL_RULES_FILE === undefined) {
    delete process.env.EARVELDAJA_RULES_FILE;
  } else {
    process.env.EARVELDAJA_RULES_FILE = ORIGINAL_RULES_FILE;
  }
  resetAccountingRulesCache();
});

function setupReceiptTool(
  toolName: string,
  options: {
    clients?: unknown[];
    transactions?: unknown[];
    transactionDetails?: Record<number, unknown>;
    getImpl?: ReturnType<typeof vi.fn>;
    purchaseArticles?: unknown[];
    accounts?: unknown[];
    saleInvoices?: unknown[];
    purchaseInvoices?: unknown[];
    purchaseInvoiceDetails?: Record<number, unknown>;
  } = {},
) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    clients: {
      listAll: vi.fn().mockResolvedValue(options.clients ?? []),
    },
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.saleInvoices ?? []),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.purchaseInvoices ?? []),
      get: vi.fn().mockImplementation(async (id: number) => {
        const detail = options.purchaseInvoiceDetails?.[id];
        if (!detail) throw new Error(`Missing purchase invoice ${id}`);
        return detail;
      }),
      createAndSetTotals: vi.fn().mockResolvedValue({ id: 9001 }),
      confirmWithTotals: vi.fn().mockResolvedValue({}),
      invalidate: vi.fn().mockResolvedValue({}),
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactions ?? []),
      get: options.getImpl ?? vi.fn().mockImplementation(async (id: number) => {
        const detail = options.transactionDetails?.[id];
        if (detail) return detail;
        return (options.transactions ?? []).find((transaction: any) => transaction.id === id);
      }),
      confirm: vi.fn().mockResolvedValue({}),
    },
    readonly: {
      getPurchaseArticles: vi.fn().mockResolvedValue(options.purchaseArticles ?? []),
      getAccounts: vi.fn().mockResolvedValue(options.accounts ?? []),
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
    },
  } as any;

  registerReceiptInboxTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === toolName);
  if (!registration) throw new Error(`Tool '${toolName}' was not registered`);

  return {
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
    api,
  };
}

describe("receipt inbox tool status handling", () => {
  it("classify_unmatched_transactions excludes VOID transactions", async () => {
    const { handler } = setupReceiptTool("classify_unmatched_transactions", {
      transactions: [
        {
          id: 1,
          status: "VOID",
          is_deleted: false,
          type: "C",
          amount: 15,
          date: "2026-03-20",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "Subscription",
        },
        {
          id: 2,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 16,
          date: "2026-03-21",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "Subscription",
        },
      ],
      purchaseArticles: [],
      accounts: [],
    });

    const result = await handler({ accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.total_unconfirmed).toBe(1);
    expect(payload.total_unmatched).toBe(1);
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]!.transactions).toHaveLength(1);
    expect(payload.groups[0]!.transactions[0]!.id).toBe(2);
  });

  it("classify_unmatched_transactions keeps type C sale-invoice payments out of the unmatched expense flow", async () => {
    const { handler } = setupReceiptTool("classify_unmatched_transactions", {
      transactions: [
        {
          id: 3,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 100,
          date: "2026-03-21",
          accounts_dimensions_id: 100,
          bank_account_name: "Acme OU",
          ref_number: "RF-100",
          description: "Customer payment",
          cl_currencies_id: "EUR",
        },
      ],
      saleInvoices: [
        {
          id: 33,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
          number: "ARV-33",
          clients_id: 20,
          client_name: "Acme OU",
          gross_price: 100,
          bank_ref_number: "RF-100",
          cl_currencies_id: "EUR",
        },
      ],
      purchaseArticles: [],
      accounts: [],
    });

    const result = await handler({ accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.total_unconfirmed).toBe(1);
    expect(payload.total_unmatched).toBe(0);
    expect(payload.groups).toEqual([]);
  });

  it("classify_unmatched_transactions keeps explicit incoming credits with only purchase-invoice matches in the unmatched flow", async () => {
    const { handler } = setupReceiptTool("classify_unmatched_transactions", {
      transactions: [
        {
          id: 4,
          status: "PROJECT",
          is_deleted: false,
          type: "D",
          amount: 200,
          date: "2026-03-21",
          accounts_dimensions_id: 100,
          bank_account_name: "Supplier OU",
          ref_number: "RF-200",
          description: "Incoming transfer",
          cl_currencies_id: "EUR",
        },
      ],
      purchaseInvoices: [
        {
          id: 44,
          status: "CONFIRMED",
          payment_status: "NOT_PAID",
          number: "OST-44",
          clients_id: 24,
          client_name: "Supplier OU",
          gross_price: 200,
          bank_ref_number: "RF-200",
          cl_currencies_id: "EUR",
        },
      ],
      purchaseArticles: [],
      accounts: [],
    });

    const result = await handler({ accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.total_unconfirmed).toBe(1);
    expect(payload.total_unmatched).toBe(1);
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]!.transactions).toHaveLength(1);
    expect(payload.groups[0]!.transactions[0]!.id).toBe(4);
  });

  it("classify_unmatched_transactions adds review guidance for owner-transfer groups", async () => {
    const { handler } = setupReceiptTool("classify_unmatched_transactions", {
      clients: [
        {
          id: 9,
          name: "Seppo Sepp",
          is_supplier: false,
          is_client: false,
          is_physical_entity: true,
          is_related_party: true,
          is_deleted: false,
        },
      ],
      transactions: [
        {
          id: 5,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 150,
          date: "2026-03-21",
          accounts_dimensions_id: 100,
          bank_account_name: "Seppo Sepp",
          description: "Transfer",
          cl_currencies_id: "EUR",
        },
      ],
      purchaseArticles: [],
      accounts: [],
    });

    const result = await handler({ accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]).toMatchObject({
      category: "owner_transfers",
      apply_mode: "review_only",
      review_guidance: {
        recommendation: expect.stringContaining("ära tee sellest ostuarvet"),
        follow_up_questions: expect.arrayContaining([
          expect.stringContaining("laen"),
          expect.stringContaining("dividend"),
        ]),
      },
    });
  });

  it("classify_unmatched_transactions keeps metadata-only local rules in manual review for unmatched expenses", async () => {
    const rulesDir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const rulesFile = join(rulesDir, "accounting-rules.md");
    writeFileSync(rulesFile, `# Accounting Rules

## Auto Booking
| match | category | vat_rate_dropdown | reversed_vat_id | liability_account_id | reason |
| --- | --- | --- | --- | --- | --- |
| openai | saas_subscriptions | - | 1 | 2315 | OpenAI reverse-charge rule |
`, "utf-8");
    process.env.EARVELDAJA_RULES_FILE = rulesFile;
    resetAccountingRulesCache();

    const { handler } = setupReceiptTool("classify_unmatched_transactions", {
      clients: [
        {
          id: 7,
          name: "OpenAI Ireland Limited",
          is_supplier: true,
          is_client: false,
          cl_code_country: "IE",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        },
      ],
      transactions: [
        {
          id: 45,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT subscription",
          cl_currencies_id: "EUR",
          clients_id: 7,
        },
        {
          id: 46,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25.2,
          date: "2026-02-22",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT subscription",
          cl_currencies_id: "EUR",
          clients_id: 7,
        },
      ],
      purchaseArticles: [{
        id: 501,
        name_est: "Software",
        name_eng: "Software",
        accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      }],
    });

    const result = await handler({ accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]).toMatchObject({
      category: "saas_subscriptions",
      apply_mode: "review_only",
      suggested_booking: {
        purchase_article_id: 501,
        purchase_account_id: 5230,
        source: "keyword_match",
      },
    });

    rmSync(rulesDir, { recursive: true, force: true });
  });

  it("classify_unmatched_transactions auto-books from a concrete local rule that chooses the expense target", async () => {
    const rulesDir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const rulesFile = join(rulesDir, "accounting-rules.md");
    writeFileSync(rulesFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id | purchase_account_id | liability_account_id | vat_rate_dropdown | reversed_vat_id | reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| openai | saas_subscriptions | 501 | 5230 | 2315 | - | 1 | OpenAI reverse-charge rule |
`, "utf-8");
    process.env.EARVELDAJA_RULES_FILE = rulesFile;
    resetAccountingRulesCache();

    const { handler } = setupReceiptTool("classify_unmatched_transactions", {
      clients: [
        {
          id: 7,
          name: "OpenAI Ireland Limited",
          is_supplier: true,
          is_client: false,
          cl_code_country: "IE",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        },
      ],
      transactions: [
        {
          id: 47,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT subscription",
          cl_currencies_id: "EUR",
          clients_id: 7,
        },
        {
          id: 48,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25.2,
          date: "2026-02-22",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT subscription",
          cl_currencies_id: "EUR",
          clients_id: 7,
        },
      ],
      purchaseArticles: [{
        id: 501,
        name_est: "Software",
        name_eng: "Software",
        accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      }],
    });

    const result = await handler({ accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]).toMatchObject({
      category: "saas_subscriptions",
      apply_mode: "purchase_invoice",
      suggested_booking: {
        purchase_article_id: 501,
        purchase_account_id: 5230,
        liability_account_id: 2315,
        vat_rate_dropdown: "-",
        reversed_vat_id: 1,
        source: "local_rules",
      },
    });

    rmSync(rulesDir, { recursive: true, force: true });
  });

  it("apply_transaction_classifications skips stale VOID transactions before creating invoices", async () => {
    const { handler, api } = setupReceiptTool("apply_transaction_classifications", {
      clients: [
        {
          id: 7,
          name: "OpenAI Ireland Limited",
          is_supplier: true,
          is_client: false,
          cl_code_country: "IE",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        },
      ],
      transactionDetails: {
        42: {
          id: 42,
          status: "VOID",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT subscription",
          cl_currencies_id: "EUR",
          clients_id: 7,
        },
      },
      purchaseArticles: [{
        id: 501,
        name_est: "Software",
        name_eng: "Software",
        accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      }],
    });

    const classificationsJson = JSON.stringify([{
      category: "saas_subscriptions",
      apply_mode: "purchase_invoice",
      normalized_counterparty: "openai",
      display_counterparty: "OpenAI",
      recurring: true,
      similar_amounts: true,
      total_amount: 25,
      suggested_booking: {
        purchase_article_id: 501,
        purchase_article_name: "Software",
        purchase_account_id: 5230,
        purchase_account_name: "Software expense",
        liability_account_id: 2310,
        reason: "Recurring SaaS",
      },
      reasons: ["keyword"],
      transactions: [{
        id: 42,
        type: "C",
        amount: 25,
        date: "2026-03-22",
        description: "ChatGPT subscription",
        bank_account_name: "OpenAI",
        accounts_dimensions_id: 100,
        clients_id: 7,
      }],
    }]);

    const result = await handler({ classifications_json: classificationsJson, execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]!.status).toBe("skipped");
    expect(payload.results[0]!.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("status VOID"),
      "No unconfirmed transactions remain in this classification group.",
    ]));
    expect(payload.execution).toMatchObject({
      contract: "batch_execution_v1",
      mode: "EXECUTED",
      summary: {
        applied: 0,
        skipped: 1,
        dry_run_preview: 0,
        failed: 0,
      },
      results: [],
      skipped: [
        expect.objectContaining({
          category: "saas_subscriptions",
          status: "skipped",
        }),
      ],
      errors: [],
      needs_review: [],
    });
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("apply_transaction_classifications invalidates the draft invoice if the transaction turns VOID after creation", async () => {
    const getImpl = vi.fn()
      .mockResolvedValueOnce({
        id: 43,
        status: "PROJECT",
        is_deleted: false,
        type: "C",
        amount: 25,
        date: "2026-03-22",
        accounts_dimensions_id: 100,
        bank_account_name: "OpenAI",
        description: "ChatGPT subscription",
        cl_currencies_id: "EUR",
        clients_id: 7,
      })
      .mockResolvedValueOnce({
        id: 43,
        status: "VOID",
        is_deleted: false,
        type: "C",
        amount: 25,
        date: "2026-03-22",
        accounts_dimensions_id: 100,
        bank_account_name: "OpenAI",
        description: "ChatGPT subscription",
        cl_currencies_id: "EUR",
        clients_id: 7,
      });

    const { handler, api } = setupReceiptTool("apply_transaction_classifications", {
      clients: [
        {
          id: 7,
          name: "OpenAI Ireland Limited",
          is_supplier: true,
          is_client: false,
          cl_code_country: "IE",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        },
      ],
      getImpl,
      purchaseInvoices: [{
        id: 88,
        status: "CONFIRMED",
        payment_status: "PAID",
        clients_id: 7,
        client_name: "OpenAI Ireland Limited",
        create_date: "2026-02-22",
      }],
      purchaseInvoiceDetails: {
        88: {
          id: 88,
          number: "OST-88",
          liability_accounts_id: 2310,
          items: [{
            custom_title: "ChatGPT subscription",
            cl_purchase_articles_id: 501,
            purchase_accounts_id: 5230,
            purchase_accounts_dimensions_id: null,
            vat_rate_dropdown: "24",
            vat_accounts_id: 1510,
            cl_vat_articles_id: 1,
            reversed_vat_id: 1,
          }],
        },
      },
      purchaseArticles: [{
        id: 501,
        name_est: "Software",
        name_eng: "Software",
        accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      }],
    });

    const classificationsJson = JSON.stringify([{
      category: "saas_subscriptions",
      apply_mode: "purchase_invoice",
      normalized_counterparty: "openai",
      display_counterparty: "OpenAI",
      recurring: true,
      similar_amounts: true,
      total_amount: 25,
      suggested_booking: {
        purchase_article_id: 501,
        purchase_article_name: "Software",
        purchase_account_id: 5230,
        purchase_account_name: "Software expense",
        liability_account_id: 2310,
        reason: "Recurring SaaS",
      },
      reasons: ["keyword"],
      transactions: [{
        id: 43,
        type: "C",
        amount: 25,
        date: "2026-03-22",
        description: "ChatGPT subscription",
        bank_account_name: "OpenAI",
        accounts_dimensions_id: 100,
        clients_id: 7,
      }],
    }]);

    const result = await handler({ classifications_json: classificationsJson, execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]!.status).toBe("applied");
    expect(payload.results[0]!.created_invoice_ids).toEqual([]);
    expect(payload.results[0]!.linked_transaction_ids).toEqual([]);
    expect(payload.results[0]!.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Invalidated auto-created purchase invoice 9001 because transaction 43 is no longer bookable (status VOID)."),
    ]));
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.invalidate).toHaveBeenCalledWith(9001);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });
});
