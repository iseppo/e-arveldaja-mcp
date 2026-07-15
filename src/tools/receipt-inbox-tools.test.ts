import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { parseMcpResponse } from "../mcp-json.js";
import { HttpError } from "../http-client.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";
import { resetAccountingRulesCache } from "../accounting-rules.js";
import {
  createAccountingWorkflowApi,
  createReceiptFolder,
  createMockToolServer,
  getRegisteredToolHandler,
  type AccountingWorkflowApiOptions,
} from "../__fixtures__/accounting-workflow.js";

const ORIGINAL_RULES_FILE = process.env.EARVELDAJA_RULES_FILE;

// Behavior tests exercise the granular constituent tools directly, so register
// with the full surface exposed (default hides them behind the merged tools).
const EXPOSE_GRANULAR = { enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true };

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
  const server = createMockToolServer();
  const apiOptions: AccountingWorkflowApiOptions = {
    clientRows: options.clients,
    saleInvoiceRows: options.saleInvoices,
    purchaseInvoiceRows: options.purchaseInvoices,
    purchaseInvoiceDetails: options.purchaseInvoiceDetails,
    transactionRows: options.transactions,
    transactionDetails: options.transactionDetails,
    missingTransactionDetail: "undefined",
    purchaseArticles: options.purchaseArticles,
    accounts: options.accounts,
    transactions: options.getImpl ? { get: options.getImpl } : undefined,
  };
  const api = createAccountingWorkflowApi(apiOptions);

  registerReceiptInboxTools(server, api, EXPOSE_GRANULAR);

  return {
    handler: getRegisteredToolHandler(server, toolName),
    api,
  };
}

const H14_TX = {
  id: 99,
  status: "PROJECT",
  is_deleted: false,
  type: "C",
  amount: 25,
  date: "2026-03-22",
  accounts_dimensions_id: 100,
  bank_account_name: "OpenAI",
  description: "Subscription",
  cl_currencies_id: "EUR",
  clients_id: 7,
};

const H14_CLASSIFICATION = {
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
    purchase_account_name: "Software",
    liability_account_id: 2310,
    reason: "Recurring SaaS",
  },
  reasons: ["keyword"],
  transactions: [H14_TX],
};

const H14_INVOICE = {
  id: 701,
  status: "PROJECT",
  number: "AUTO-TX-99",
  clients_id: 7,
  client_name: "OpenAI Ireland Limited",
  create_date: "2026-03-22",
  journal_date: "2026-03-22",
  term_days: 0,
  cl_currencies_id: "EUR",
  items: [],
};

function setupH14Tool(toolName: "apply_transaction_classifications" | "classify_bank_transactions") {
  const setup = setupReceiptTool(toolName, {
    getImpl: vi.fn().mockImplementation(async (id: number) =>
      id === 100 ? { ...H14_TX, id: 100, date: "2026-03-23" } : H14_TX),
    clients: [{
      id: 7,
      name: "OpenAI Ireland Limited",
      is_supplier: true,
      is_client: false,
      cl_code_country: "IE",
      is_member: false,
      send_invoice_to_email: false,
      send_invoice_to_accounting_email: false,
      is_deleted: false,
    }],
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
        number: "OLD-88",
        liability_accounts_id: 2310,
        items: [{
          custom_title: "Subscription",
          cl_purchase_articles_id: 501,
          purchase_accounts_id: 5230,
          vat_rate_dropdown: "24",
          vat_accounts_id: 1510,
        }],
      },
    },
    purchaseArticles: [{
      id: 501,
      name_est: "Software",
      name_eng: "Software",
      accounts_id: 5230,
      vat_accounts_id: 1510,
      is_disabled: false,
      priority: 1,
    }],
    accounts: [{
      id: 5230,
      name_est: "Software",
      name_eng: "Software",
      account_type_est: "Kulud",
      account_type_eng: "Expenses",
    }],
  });
  setup.api.purchaseInvoices.createAndSetTotals.mockResolvedValue(H14_INVOICE);
  return setup;
}

function h14StructuredAmbiguity(
  stage: "transaction_reread" | "invoice_invalidation" | "invoice_confirmation" | "transaction_confirmation",
) {
  const entity = stage === "invoice_invalidation" || stage === "invoice_confirmation"
    ? "purchase_invoice"
    : "transaction";
  const id = entity === "purchase_invoice" ? 701 : 99;
  return new MutationIndeterminateError({
    operation: stage === "transaction_reread"
      ? "update"
      : stage === "invoice_invalidation"
        ? "invalidate"
        : "confirm",
    entity,
    entityId: id,
    businessKey: `${entity}:${id}`,
    affectedCaches: entity === "purchase_invoice"
      ? ["/purchase_invoices"]
      : ["/transactions", "/journals"],
    cause: new HttpError(
      "response lost",
      "network",
      "PATCH",
      `/${entity}/${id}/${stage === "invoice_invalidation" ? "invalidate" : "register"}`,
    ),
    nextAction: "Fresh read required.",
  });
}

describe("H14 post-create recovery state", () => {
  const cases = [
    {
      name: "H14 reread raw network",
      createStatus: "PROJECT",
      stage: "transaction_reread",
      error: new HttpError("response lost", "network", "GET", "/transactions/99"),
      category: "mutation_indeterminate",
      invoiceStatus: "PROJECT",
      transactionStatus: "UNKNOWN",
      getCalls: 2,
      invoiceConfirmCalls: 0,
      transactionConfirmCalls: 0,
    },
    {
      name: "H14 reread H03 structural",
      createStatus: "CONFIRMED",
      stage: "transaction_reread",
      error: h14StructuredAmbiguity("transaction_reread"),
      category: "mutation_indeterminate",
      invoiceStatus: "CONFIRMED",
      transactionStatus: "UNKNOWN",
      getCalls: 2,
      invoiceConfirmCalls: 0,
      transactionConfirmCalls: 0,
    },
    {
      name: "H14 reread definite response",
      createStatus: "DRAFT",
      stage: "transaction_reread",
      error: new HttpError("reread unavailable", 503, "GET", "/transactions/99"),
      category: "mutation_failed",
      invoiceStatus: "UNKNOWN",
      transactionStatus: "UNKNOWN",
      getCalls: 2,
      invoiceConfirmCalls: 0,
      transactionConfirmCalls: 0,
    },
    {
      name: "H14 invoice confirm raw network",
      createStatus: "PROJECT",
      stage: "invoice_confirmation",
      error: new HttpError("response lost", "network", "PATCH", "/purchase_invoices/701/register"),
      category: "mutation_indeterminate",
      invoiceStatus: "UNKNOWN",
      transactionStatus: "PROJECT",
      getCalls: 2,
      invoiceConfirmCalls: 1,
      transactionConfirmCalls: 0,
    },
    {
      name: "H14 invoice confirm H03 structural",
      createStatus: "PROJECT",
      stage: "invoice_confirmation",
      error: h14StructuredAmbiguity("invoice_confirmation"),
      category: "mutation_indeterminate",
      invoiceStatus: "UNKNOWN",
      transactionStatus: "PROJECT",
      getCalls: 2,
      invoiceConfirmCalls: 1,
      transactionConfirmCalls: 0,
    },
    {
      name: "H14 invoice confirm definite PROJECT",
      createStatus: "PROJECT",
      stage: "invoice_confirmation",
      error: new HttpError("confirmation rejected", 422, "PATCH", "/purchase_invoices/701/register"),
      category: "mutation_failed",
      invoiceStatus: "PROJECT",
      transactionStatus: "PROJECT",
      getCalls: 2,
      invoiceConfirmCalls: 1,
      transactionConfirmCalls: 0,
    },
    {
      name: "H14 invoice confirm definite CONFIRMED",
      createStatus: "CONFIRMED",
      stage: "invoice_confirmation",
      error: new Error("confirmation rejected"),
      category: "mutation_failed",
      invoiceStatus: "CONFIRMED",
      transactionStatus: "PROJECT",
      getCalls: 2,
      invoiceConfirmCalls: 1,
      transactionConfirmCalls: 0,
    },
    {
      name: "H14 transaction confirm raw network",
      createStatus: "PROJECT",
      stage: "transaction_confirmation",
      error: new HttpError("response lost", "network", "PATCH", "/transactions/99/register"),
      category: "mutation_indeterminate",
      invoiceStatus: "CONFIRMED",
      transactionStatus: "UNKNOWN",
      getCalls: 2,
      invoiceConfirmCalls: 1,
      transactionConfirmCalls: 1,
    },
    {
      name: "H14 transaction confirm H03 structural",
      createStatus: "PROJECT",
      stage: "transaction_confirmation",
      error: h14StructuredAmbiguity("transaction_confirmation"),
      category: "mutation_indeterminate",
      invoiceStatus: "CONFIRMED",
      transactionStatus: "UNKNOWN",
      getCalls: 2,
      invoiceConfirmCalls: 1,
      transactionConfirmCalls: 1,
    },
    {
      name: "H14 transaction confirm definite",
      createStatus: "PROJECT",
      stage: "transaction_confirmation",
      error: new HttpError("confirmation rejected", 422, "PATCH", "/transactions/99/register"),
      category: "mutation_failed",
      invoiceStatus: "CONFIRMED",
      transactionStatus: "PROJECT",
      getCalls: 2,
      invoiceConfirmCalls: 1,
      transactionConfirmCalls: 1,
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const { handler, api } = setupH14Tool("apply_transaction_classifications");
      api.purchaseInvoices.createAndSetTotals.mockResolvedValue({
        ...H14_INVOICE,
        status: testCase.createStatus,
      });
      if (testCase.stage === "transaction_reread") {
        api.transactions.get
          .mockResolvedValueOnce(H14_TX)
          .mockRejectedValueOnce(testCase.error);
      } else if (testCase.stage === "invoice_confirmation") {
        api.purchaseInvoices.confirmWithTotals.mockRejectedValueOnce(testCase.error);
      } else {
        api.transactions.confirm.mockRejectedValueOnce(testCase.error);
      }

      const result = await handler({
        classifications_json: [H14_CLASSIFICATION],
        execute: true,
      });
      const payload = parseMcpResponse(result.content[0]!.text) as any;

      expect(payload.summary).toMatchObject({ applied: 0, failed: 1 });
      expect(payload.results[0]).toMatchObject({
        status: "failed",
        created_invoice_ids: [701],
        linked_transaction_ids: [],
        partial_mutations: [{
          category: testCase.category,
          mutation_may_have_occurred: true,
          failed_stage: testCase.stage,
          created_invoice_id: 701,
          created_invoice_status: testCase.invoiceStatus,
          attempted_transaction_id: 99,
          transaction_status: testCase.transactionStatus,
          next_action: expect.stringContaining("purchase invoice 701"),
        }],
      });
      const nextAction = payload.results[0].partial_mutations[0].next_action;
      expect(nextAction).toContain("explicit approval");
      expect(nextAction).not.toMatch(/create another|invalidate|retry/i);
      expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
      expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
      expect(api.transactions.get).toHaveBeenCalledTimes(testCase.getCalls);
      expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledTimes(testCase.invoiceConfirmCalls);
      expect(api.transactions.confirm).toHaveBeenCalledTimes(testCase.transactionConfirmCalls);
      expect(payload.execution.errors[0].partial_mutations).toEqual(
        payload.results[0].partial_mutations,
      );
    });
  }
});

describe("H14 accumulator and invalidation recovery", () => {
  const tx100 = { ...H14_TX, id: 100, date: "2026-03-23" };
  const group100 = {
    ...H14_CLASSIFICATION,
    normalized_counterparty: "openai-two",
    transactions: [tx100],
  };

  function configureDistinctInvoices(api: ReturnType<typeof setupH14Tool>["api"]): void {
    api.purchaseInvoices.createAndSetTotals.mockImplementation(async ({ number }: { number: string }) => ({
      ...H14_INVOICE,
      id: number.endsWith("100") ? 702 : 701,
      number,
    }));
  }

  it("H14 merged wrapper preserves granular partial mutations unchanged", async () => {
    const { handler, api } = setupH14Tool("classify_bank_transactions");
    api.transactions.confirm.mockRejectedValueOnce(h14StructuredAmbiguity("transaction_confirmation"));

    const result = await handler({
      mode: "execute_apply",
      classifications_json: [H14_CLASSIFICATION],
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    const expectedPartial = {
      category: "mutation_indeterminate",
      mutation_may_have_occurred: true,
      failed_stage: "transaction_confirmation",
      created_invoice_id: 701,
      created_invoice_status: "CONFIRMED",
      attempted_transaction_id: 99,
      transaction_status: "UNKNOWN",
      next_action: expect.stringContaining("explicit approval"),
    };

    expect(payload.result.results[0].partial_mutations).toEqual([
      expect.objectContaining(expectedPartial),
    ]);
    expect(payload.result.execution.errors[0].partial_mutations).toEqual(
      payload.result.results[0].partial_mutations,
    );
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
  });

  it("H14 later group error does not erase an earlier partial mutation", async () => {
    const { handler, api } = setupH14Tool("apply_transaction_classifications");
    api.purchaseInvoices.createAndSetTotals
      .mockResolvedValueOnce(H14_INVOICE)
      .mockRejectedValueOnce(new Error("second create rejected"));
    api.purchaseInvoices.confirmWithTotals
      .mockRejectedValueOnce(h14StructuredAmbiguity("invoice_confirmation"));

    const result = await handler({
      classifications_json: [{ ...H14_CLASSIFICATION, transactions: [H14_TX, tx100] }],
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.results[0]).toMatchObject({
      status: "failed",
      created_invoice_ids: [701],
      linked_transaction_ids: [],
      partial_mutations: [{
        failed_stage: "invoice_confirmation",
        created_invoice_id: 701,
      }],
    });
    expect(payload.results[0].notes.join("\n")).toContain("explicit approval");
    expect(payload.results[0].notes.join("\n")).toContain("second create rejected");
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(2);
    expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledTimes(1);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
  });

  it("H14 multi-transaction partial plus success preserves both outcomes", async () => {
    const { handler, api } = setupH14Tool("apply_transaction_classifications");
    configureDistinctInvoices(api);
    api.purchaseInvoices.confirmWithTotals.mockImplementation(async (id: number) => {
      if (id === 701) throw h14StructuredAmbiguity("invoice_confirmation");
      return {};
    });

    const result = await handler({
      classifications_json: [{ ...H14_CLASSIFICATION, transactions: [H14_TX, tx100] }],
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(payload.results[0]).toMatchObject({
      status: "failed",
      created_invoice_ids: [701, 702],
      linked_transaction_ids: [100],
      partial_mutations: [{ created_invoice_id: 701 }],
    });
    expect(payload.results[0].notes).toEqual(expect.arrayContaining([
      expect.stringContaining("transactions were already booked successfully and were left in place: 100"),
    ]));
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(2);
    expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledTimes(2);
    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
    expect(api.transactions.get).toHaveBeenCalledTimes(4);
    expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
  });

  it("H14 partial state is isolated across multiple groups", async () => {
    const { handler, api } = setupH14Tool("apply_transaction_classifications");
    configureDistinctInvoices(api);
    api.transactions.confirm.mockImplementation(async (id: number) => {
      if (id === 99) throw h14StructuredAmbiguity("transaction_confirmation");
      return {};
    });

    const result = await handler({
      classifications_json: [H14_CLASSIFICATION, group100],
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.summary).toMatchObject({ applied: 1, failed: 1 });
    expect(payload.results[0]).toMatchObject({
      status: "failed",
      created_invoice_ids: [701],
      linked_transaction_ids: [],
      partial_mutations: [{ created_invoice_id: 701 }],
    });
    expect(payload.results[1]).toMatchObject({
      status: "applied",
      created_invoice_ids: [702],
      linked_transaction_ids: [100],
    });
    expect(payload.results[1].partial_mutations).toBeUndefined();
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(2);
    expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledTimes(2);
    expect(api.transactions.confirm).toHaveBeenCalledTimes(2);
    expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
  });

  const invalidationCases = [
    {
      name: "H14 invalidation definite HTTP rejection",
      freshTransaction: { ...H14_TX, status: "VOID" },
      createStatus: "CONFIRMED",
      error: new HttpError("invalidation rejected", 422, "PATCH", "/purchase_invoices/701/invalidate"),
      errorNote: "invalidation rejected",
      category: "mutation_failed",
      invoiceStatus: "CONFIRMED",
      transactionStatus: "VOID",
    },
    {
      name: "H14 invalidation raw network",
      freshTransaction: { ...H14_TX, status: "VOID" },
      createStatus: "PROJECT",
      error: new HttpError("response lost", "network", "PATCH", "/purchase_invoices/701/invalidate"),
      errorNote: "response lost",
      category: "mutation_indeterminate",
      invoiceStatus: "UNKNOWN",
      transactionStatus: "VOID",
    },
    {
      name: "H14 invalidation H03 structural",
      freshTransaction: { ...H14_TX, status: "VOID" },
      createStatus: "PROJECT",
      error: h14StructuredAmbiguity("invoice_invalidation"),
      errorNote: "is indeterminate",
      category: "mutation_indeterminate",
      invoiceStatus: "UNKNOWN",
      transactionStatus: "VOID",
    },
    {
      name: "H14 invalidation definite deleted transaction",
      freshTransaction: { ...H14_TX, status: "PROJECT", is_deleted: true },
      createStatus: "PROJECT",
      error: new Error("invalidation rejected for deleted transaction"),
      errorNote: "invalidation rejected for deleted transaction",
      category: "mutation_failed",
      invoiceStatus: "PROJECT",
      transactionStatus: "UNKNOWN",
    },
  ] as const;

  describe("H14 failed stale invalidation retains partial recovery state", () => {
    for (const testCase of invalidationCases) {
      it(testCase.name, async () => {
        const { handler, api } = setupH14Tool("apply_transaction_classifications");
        api.transactions.get
          .mockResolvedValueOnce(H14_TX)
          .mockResolvedValueOnce(testCase.freshTransaction);
        api.purchaseInvoices.createAndSetTotals.mockResolvedValue({
          ...H14_INVOICE,
          status: testCase.createStatus,
        });
        api.purchaseInvoices.invalidate.mockRejectedValueOnce(testCase.error);

        const result = await handler({
          classifications_json: [H14_CLASSIFICATION],
          execute: true,
        });
        const payload = parseMcpResponse(result.content[0]!.text) as any;

        expect(payload.summary).toMatchObject({ applied: 0, failed: 1 });
        expect(payload.results[0]).toMatchObject({
          status: "failed",
          created_invoice_ids: [701],
          linked_transaction_ids: [],
          partial_mutations: [{
            category: testCase.category,
            mutation_may_have_occurred: true,
            failed_stage: "invoice_invalidation",
            created_invoice_id: 701,
            created_invoice_status: testCase.invoiceStatus,
            attempted_transaction_id: 99,
            transaction_status: testCase.transactionStatus,
            next_action: expect.stringContaining("Freshly read existing purchase invoice 701"),
          }],
        });
        const nextAction = payload.results[0].partial_mutations[0].next_action;
        expect(nextAction).toContain("explicit approval");
        expect(nextAction).not.toMatch(/create another|invalidate|retry/i);
        expect(payload.results[0].notes).toEqual(expect.arrayContaining([
          expect.stringContaining(
            `Auto-created purchase invoice 701 could not be kept because transaction 99 is no longer bookable (status ${testCase.freshTransaction.status}), and invalidation also failed:`,
          ),
        ]));
        expect(payload.results[0].notes.join("\n")).toContain(testCase.errorNote);
        expect(api.transactions.get).toHaveBeenCalledTimes(2);
        expect(api.transactions.get).toHaveBeenNthCalledWith(1, 99);
        expect(api.transactions.get).toHaveBeenNthCalledWith(2, 99);
        expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
        expect(api.purchaseInvoices.invalidate).toHaveBeenCalledTimes(1);
        expect(api.purchaseInvoices.invalidate).toHaveBeenCalledWith(701);
        expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
        expect(api.transactions.confirm).not.toHaveBeenCalled();
      });
    }
  });
});

describe("receipt inbox tool status handling", () => {
  it("receipt_batch scans receipt folders through the merged entry point", async () => {
    const tempDir = createReceiptFolder();
    try {
      const { handler } = setupReceiptTool("receipt_batch");

      const result = await handler({ mode: "scan", folder_path: tempDir });
      const payload = parseMcpResponse(result.content[0]!.text) as any;

      expect(payload).toMatchObject({
        recommended_entry_point: "receipt_batch",
        mode: "scan",
        delegated_tool: "scan_receipt_folder",
        delegated_args: { folder_path: tempDir },
      });
      expect(payload.result.files[0]!.name).toBe("receipt.pdf");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("receipt_batch scan mode applies modified-date filters", async () => {
    const tempDir = createReceiptFolder({
      "old.pdf": "%PDF-1.4\n",
      "new.pdf": "%PDF-1.4\n",
    });
    try {
      utimesSync(join(tempDir, "old.pdf"), new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"));
      utimesSync(join(tempDir, "new.pdf"), new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-01T00:00:00.000Z"));
      const { handler } = setupReceiptTool("receipt_batch");

      const result = await handler({
        mode: "scan",
        folder_path: tempDir,
        date_from: "2026-03-01",
        date_to: "2026-03-31",
      });
      const payload = parseMcpResponse(result.content[0]!.text) as any;

      expect(payload.delegated_args).toEqual({
        folder_path: tempDir,
        date_from: "2026-03-01",
        date_to: "2026-03-31",
      });
      expect(payload.result.files.map((file: { name: string }) => file.name)).toEqual(["new.pdf"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("receipt_batch delegates processing modes to process_receipt_batch", async () => {
    const tempDir = createReceiptFolder({});
    try {
      const { handler } = setupReceiptTool("receipt_batch");

      for (const mode of ["dry_run", "create", "create_and_confirm"] as const) {
        const result = await handler({
          mode,
          folder_path: tempDir,
          accounts_dimensions_id: 100,
        });
        const payload = parseMcpResponse(result.content[0]!.text) as any;

        expect(payload).toMatchObject({
          recommended_entry_point: "receipt_batch",
          mode,
          delegated_tool: "process_receipt_batch",
          delegated_args: {
            folder_path: tempDir,
            accounts_dimensions_id: 100,
            execution_mode: mode,
          },
          result: {
            execution_mode: mode,
          },
        });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("classify_bank_transactions classifies unmatched transactions through the merged entry point", async () => {
    const { handler } = setupReceiptTool("classify_bank_transactions", {
      transactions: [{
        id: 1,
        status: "PROJECT",
        is_deleted: false,
        type: "C",
        amount: 15,
        date: "2026-03-20",
        accounts_dimensions_id: 100,
        bank_account_name: "LHV Bank",
        description: "Bank monthly fee",
      }],
      clients: [],
      purchaseArticles: [{
        id: 501,
        name_est: "Bank fee",
        accounts_id: 5230,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Bank fees",
        account_type_est: "Kulud",
      }],
    });

    const result = await handler({ mode: "classify", accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.mode).toBe("classify");
    expect(payload.recommended_entry_point).toBe("classify_bank_transactions");
    expect(payload.result.total_unmatched).toBe(1);
    expect(payload.result.groups[0]!.category).toBe("bank_fees");
  });

  it("classify output wraps normalized_counterparty in the OCR sandbox (#3)", async () => {
    const WRAP_START = /^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\n/;
    const WRAP_END = /\n<<UNTRUSTED_OCR_END:[0-9a-f]+>>$/;
    const { handler } = setupReceiptTool("classify_unmatched_transactions", {
      transactions: [{
        id: 1,
        status: "PROJECT",
        is_deleted: false,
        type: "C",
        amount: 15,
        date: "2026-03-20",
        accounts_dimensions_id: 100,
        bank_account_name: "LHV Bank",
        description: "Bank monthly fee",
      }],
      clients: [],
      purchaseArticles: [{ id: 501, name_est: "Bank fee", accounts_id: 5230, is_disabled: false, priority: 1 }],
      accounts: [{ id: 5230, name_est: "Bank fees", account_type_est: "Kulud" }],
    });

    const result = await handler({ accounts_dimensions_id: 100 });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    const group = payload.groups[0]!;

    // normalized_counterparty would otherwise leak unwrapped via the `...g` spread.
    expect(group.normalized_counterparty).toMatch(WRAP_START);
    expect(group.normalized_counterparty).toMatch(WRAP_END);
    expect(group.display_counterparty).toMatch(WRAP_START);
  });

  it("classify_bank_transactions dry-runs classification application without creating invoices", async () => {
    const { handler, api } = setupReceiptTool("classify_bank_transactions", {
      clients: [{
        id: 7,
        name: "OpenAI Ireland Limited",
        is_supplier: true,
        is_client: false,
        cl_code_country: "IE",
        is_deleted: false,
      }],
      transactionDetails: {
        44: {
          id: 44,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          bank_account_name: "LHV Bank",
          description: "Bank monthly fee",
          cl_currencies_id: "EUR",
        },
      },
      purchaseArticles: [{
        id: 501,
        name_est: "Bank fee",
        name_eng: "Bank fee",
        accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Bank fees",
        name_eng: "Bank fees",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      }],
    });

    const classificationsJson = JSON.stringify([{
      category: "bank_fees",
      apply_mode: "purchase_invoice",
      normalized_counterparty: "lhv bank",
      display_counterparty: "LHV Bank",
      recurring: true,
      similar_amounts: true,
      total_amount: 25,
      suggested_booking: {
        purchase_article_id: 501,
        purchase_article_name: "Bank fee",
        purchase_account_id: 5230,
        purchase_account_name: "Bank fees",
        liability_account_id: 2310,
        reason: "Bank service fee",
      },
      reasons: ["keyword"],
      transactions: [{
        id: 44,
        type: "C",
        amount: 25,
        date: "2026-03-22",
        description: "Bank monthly fee",
        bank_account_name: "LHV Bank",
        accounts_dimensions_id: 100,
      }],
    }]);

    const result = await handler({ mode: "dry_run_apply", classifications_json: classificationsJson });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.mode).toBe("dry_run_apply");
    expect(payload.result.mode).toBe("DRY_RUN");
    expect(payload.result.summary.dry_run_preview).toBe(1);
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
  });

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

  it("apply_transaction_classifications reports a group as failed (not a benign skip) on a non-404 transaction lookup error (#1)", async () => {
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
      // A transient 503 from transactions.get must NOT be swallowed as
      // "no longer exists" — it should surface as a real group failure.
      getImpl: vi.fn().mockRejectedValue(new HttpError("Service Unavailable", 503, "GET", "/transactions/42")),
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
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]!.status).toBe("failed");
    // The transient error must not be reported as a benign "no longer exists" skip.
    expect(JSON.stringify(payload.results[0]!.notes)).not.toContain("no longer exists");
    expect(payload.summary.failed).toBe(1);
    expect(payload.summary.skipped).toBe(0);
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("process_receipt_batch warns that create mode re-scans the folder at execution time (#5)", async () => {
    const tempDir = createReceiptFolder({});
    try {
      const { handler } = setupReceiptTool("process_receipt_batch");

      const createResult = await handler({
        folder_path: tempDir,
        accounts_dimensions_id: 100,
        execution_mode: "create",
      });
      const createPayload = parseMcpResponse(createResult.content[0]!.text) as any;
      expect(typeof createPayload.warning).toBe("string");
      expect(createPayload.warning).toContain("RE-SCANNED");

      // The dry-run preview must NOT carry the execution-time re-scan warning.
      const dryResult = await handler({
        folder_path: tempDir,
        accounts_dimensions_id: 100,
        execution_mode: "dry_run",
      });
      const dryPayload = parseMcpResponse(dryResult.content[0]!.text) as any;
      expect(dryPayload.warning).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("apply_transaction_classifications returns an approval workflow for dry-run bookings", async () => {
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
        44: {
          id: 44,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          bank_account_name: "LHV Bank",
          description: "Bank monthly fee",
          cl_currencies_id: "EUR",
        },
      },
      purchaseArticles: [{
        id: 501,
        name_est: "Bank fee",
        name_eng: "Bank fee",
        accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        is_disabled: false,
        priority: 1,
      }],
      accounts: [{
        id: 5230,
        name_est: "Bank fees",
        name_eng: "Bank fees",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      }],
    });

    const classificationsJson = JSON.stringify([{
      category: "bank_fees",
      apply_mode: "purchase_invoice",
      normalized_counterparty: "lhv bank",
      display_counterparty: "LHV Bank",
      recurring: true,
      similar_amounts: true,
      total_amount: 25,
      suggested_booking: {
        purchase_article_id: 501,
        purchase_article_name: "Bank fee",
        purchase_account_id: 5230,
        purchase_account_name: "Bank fees",
        liability_account_id: 2310,
        reason: "Bank service fee",
      },
      reasons: ["keyword"],
      transactions: [{
        id: 44,
        type: "C",
        amount: 25,
        date: "2026-03-22",
        description: "Bank monthly fee",
        bank_account_name: "LHV Bank",
        accounts_dimensions_id: 100,
      }],
    }]);

    const result = await handler({ classifications_json: classificationsJson });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary.dry_run_preview).toBe(1);
    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      recommended_next_action: {
        kind: "approve_tool_call",
        tool: "apply_transaction_classifications",
        args: {
          classifications_json: classificationsJson,
          execute: true,
        },
      },
      approval_previews: [
        expect.objectContaining({
          title: "Approve transaction classification booking",
          accounting_impact: expect.arrayContaining(["1 purchase invoice"]),
        }),
      ],
    });
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("apply_transaction_classifications blocks non-EUR dry-run approval when no currency rate is available", async () => {
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
        45: {
          id: 45,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT subscription",
          cl_currencies_id: "USD",
          clients_id: 7,
        },
      },
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
        id: 45,
        type: "C",
        amount: 25,
        date: "2026-03-22",
        description: "ChatGPT subscription",
        bank_account_name: "OpenAI",
        accounts_dimensions_id: 100,
        clients_id: 7,
      }],
    }]);

    const result = await handler({ classifications_json: classificationsJson });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary).toMatchObject({
      dry_run_preview: 0,
      skipped: 1,
      failed: 0,
    });
    expect(payload.workflow.approval_previews).toEqual([]);
    expect(payload.workflow.recommended_next_action.kind).not.toBe("approve_tool_call");
    expect(payload.results[0]!.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Non-EUR transaction 45 uses USD but has no currency_rate"),
    ]));
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("apply_transaction_classifications still marks group applied when a non-EUR row is skipped but the EUR row succeeds", async () => {
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
        50: {
          id: 50,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT EUR",
          cl_currencies_id: "EUR",
          clients_id: 7,
        },
        51: {
          id: 51,
          status: "PROJECT",
          is_deleted: false,
          type: "C",
          amount: 25,
          date: "2026-03-23",
          accounts_dimensions_id: 100,
          bank_account_name: "OpenAI",
          description: "ChatGPT USD",
          cl_currencies_id: "USD",
          clients_id: 7,
        },
      },
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
      total_amount: 50,
      suggested_booking: {
        purchase_article_id: 501,
        purchase_article_name: "Software",
        purchase_account_id: 5230,
        purchase_account_name: "Software expense",
        liability_account_id: 2310,
        reason: "Recurring SaaS",
      },
      reasons: ["keyword"],
      transactions: [
        { id: 50, type: "C", amount: 25, date: "2026-03-22", description: "ChatGPT EUR", bank_account_name: "OpenAI", accounts_dimensions_id: 100, clients_id: 7 },
        { id: 51, type: "C", amount: 25, date: "2026-03-23", description: "ChatGPT USD", bank_account_name: "OpenAI", accounts_dimensions_id: 100, clients_id: 7 },
      ],
    }]);

    const result = await handler({ classifications_json: classificationsJson, execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(payload.results[0]!.status).toBe("applied");
    expect(payload.results[0]!.created_invoice_ids).toEqual([9001]);
    expect(payload.results[0]!.linked_transaction_ids).toEqual([50]);
    expect(payload.results[0]!.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Non-EUR transaction 51 uses USD but has no currency_rate"),
    ]));
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
  });

  it("apply_transaction_classifications reports failed when a draft invoice is invalidated after stale transaction detection", async () => {
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
    expect(payload.results[0]!.status).toBe("failed");
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

  it("apply_transaction_classifications reports a group as failed when only part of it executes", async () => {
    const getCounts = new Map<number, number>();
    const getImpl = vi.fn().mockImplementation(async (id: number) => {
      const count = getCounts.get(id) ?? 0;
      getCounts.set(id, count + 1);
      const base = {
        id,
        status: "PROJECT",
        is_deleted: false,
        type: "C",
        amount: 25,
        date: id === 44 ? "2026-03-22" : "2026-03-23",
        accounts_dimensions_id: 100,
        bank_account_name: "OpenAI",
        description: "ChatGPT subscription",
        cl_currencies_id: "EUR",
        clients_id: 7,
      };
      return id === 45 && count > 0
        ? { ...base, status: "VOID" }
        : base;
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
    api.purchaseInvoices.createAndSetTotals.mockImplementation(
      async ({ number }: { number: string }) => ({
        id: number === "AUTO-TX-44" ? 9001 : 9002,
      }),
    );

    const classificationsJson = JSON.stringify([{
      category: "saas_subscriptions",
      apply_mode: "purchase_invoice",
      normalized_counterparty: "openai",
      display_counterparty: "OpenAI",
      recurring: true,
      similar_amounts: true,
      total_amount: 50,
      suggested_booking: {
        purchase_article_id: 501,
        purchase_article_name: "Software",
        purchase_account_id: 5230,
        purchase_account_name: "Software expense",
        liability_account_id: 2310,
        reason: "Recurring SaaS",
      },
      reasons: ["keyword"],
      transactions: [
        {
          id: 44,
          type: "C",
          amount: 25,
          date: "2026-03-22",
          description: "ChatGPT subscription",
          bank_account_name: "OpenAI",
          accounts_dimensions_id: 100,
          clients_id: 7,
        },
        {
          id: 45,
          type: "C",
          amount: 25,
          date: "2026-03-23",
          description: "ChatGPT subscription",
          bank_account_name: "OpenAI",
          accounts_dimensions_id: 100,
          clients_id: 7,
        },
      ],
    }]);

    const result = await handler({ classifications_json: classificationsJson, execute: true });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary).toMatchObject({
      applied: 0,
      failed: 1,
    });
    expect(payload.results[0]!.status).toBe("failed");
    expect(payload.results[0]!.created_invoice_ids).toEqual([9001]);
    expect(payload.results[0]!.linked_transaction_ids).toEqual([44]);
    expect(payload.results[0]!.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Invalidated auto-created purchase invoice 9002 because transaction 45 is no longer bookable (status VOID)."),
      expect.stringContaining("Group reported as failed; the following transactions were already booked successfully and were left in place: 44."),
    ]));
    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(2);
    expect(api.transactions.get).toHaveBeenCalledTimes(4);
    expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledTimes(1);
    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
    expect(api.purchaseInvoices.invalidate).toHaveBeenCalledTimes(1);
    expect(api.purchaseInvoices.invalidate).toHaveBeenCalledWith(9002);
  });
});
