import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { z } from "zod";
import {
  safeJsonParse,
  parseSaleInvoiceItems,
  parsePurchaseInvoiceItems,
  parseJsonObject,
  parseJsonObjectArray,
  requireFields,
  coerceNumericFields,
  MAX_JSON_INPUT_SIZE,
  registerCrudTools,
  validateUpdateFields,
} from "./crud-tools.js";
import { registerClientTools } from "./crud/clients.js";
import { registerJournalTools } from "./crud/journals.js";
import { registerProductTools } from "./crud/products.js";
import { registerPurchaseInvoiceTools } from "./crud/purchase-invoices.js";
import { registerSaleInvoiceTools } from "./crud/sale-invoices.js";
import { registerTransactionTools } from "./crud/transactions.js";
import { parseMcpResponse } from "../mcp-json.js";
import { logAudit } from "../audit-log.js";
import { HttpError } from "../http-client.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";
import {
  PurchaseInvoicesApi,
  PurchaseInvoiceTotalsCorrectionError,
  type PurchaseInvoiceTotalsCorrectionCode,
} from "../api/purchase-invoices.api.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

function getCrudToolHarness(toolName: string, overrides?: {
  transactions?: Record<string, unknown>;
  readonly?: Record<string, unknown>;
  clients?: Record<string, unknown>;
  products?: Record<string, unknown>;
  journals?: Record<string, unknown>;
  saleInvoices?: Record<string, unknown>;
  purchaseInvoices?: Record<string, unknown>;
}) {
  const api = {
    transactions: {
      get: vi.fn(),
      update: vi.fn(),
      confirm: vi.fn(),
      ...overrides?.transactions,
    },
    readonly: {
      getAccounts: vi.fn(),
      getAccountDimensions: vi.fn(),
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      ...overrides?.readonly,
    },
    clients: {
      update: vi.fn(),
      ...overrides?.clients,
    },
    products: {
      update: vi.fn(),
      ...overrides?.products,
    },
    journals: {
      update: vi.fn(),
      get: vi.fn().mockResolvedValue({ id: 7, registered: false }),
      ...overrides?.journals,
    },
    saleInvoices: {
      update: vi.fn(),
      get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }),
      ...overrides?.saleInvoices,
    },
    purchaseInvoices: {
      update: vi.fn(),
      get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }),
      previewTotalsCorrection: vi.fn(),
      confirmWithTotals: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
      ...overrides?.purchaseInvoices,
    },
  };
  const server = { registerTool: vi.fn() };

  registerCrudTools(server as never, api as never);

  const call = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!call) throw new Error(`${toolName} tool was not registered`);

  return {
    api,
    options: call[1] as { description?: string; inputSchema?: Record<string, unknown> },
    handler: call[2] as (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
  };
}

function toolMetadataText(options: { description?: string; inputSchema?: Record<string, unknown> }): string {
  const schema = options.inputSchema ? z.object(options.inputSchema as z.ZodRawShape).toJSONSchema() : {};
  return `${options.description ?? ""}\n${JSON.stringify(schema)}`;
}

function purchaseInvoiceCreateParams(items: Array<Record<string, unknown>>) {
  return {
    clients_id: 17,
    client_name: "Test Supplier",
    number: "PI-M21",
    create_date: "2026-07-16",
    journal_date: "2026-07-16",
    term_days: 14,
    vat_price: 0,
    gross_price: 100,
    items,
  };
}

describe("M21 create_purchase_invoice non-VAT boundary", () => {
  beforeEach(() => vi.mocked(logAudit).mockClear());

  it("M21 rejects one explicit non-VAT deductible field with classified indexed guidance", async () => {
    const getVatInfo = vi.fn().mockResolvedValue({ vat_number: null });
    const getPurchaseArticles = vi.fn().mockResolvedValue([]);
    const createAndSetTotals = vi.fn().mockResolvedValue({ id: 70 });
    const { api, handler } = getCrudToolHarness("create_purchase_invoice", {
      readonly: {
        getVatInfo,
        getPurchaseArticles,
        getAccounts: vi.fn().mockResolvedValue([{
          id: 1510,
          name_est: "Sisendkäibemaks",
          allows_dimensions: false,
          is_valid: true,
        }]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: { createAndSetTotals },
    });

    const result = await handler(purchaseInvoiceCreateParams([{
      cl_purchase_articles_id: 45,
      custom_title: "Internet",
      total_net_price: 100,
      vat_accounts_id: 1510,
    }])) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text)).toEqual({
      error: "Non-VAT purchase invoice contains deductible VAT fields",
      category: "manual_review_required",
      details: ["items[0].vat_accounts_id must be absent"],
      next_action: "Remove deductible VAT fields or use article 11 and rate \"-\", then review and retry.",
    });
    expect(getVatInfo).toHaveBeenCalledTimes(1);
    expect(getPurchaseArticles).not.toHaveBeenCalled();
    expect(createAndSetTotals).not.toHaveBeenCalled();
    expect(api.readonly.getAccounts).not.toHaveBeenCalled();
    expect(api.readonly.getAccountDimensions).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("M21 aggregates every indexed non-VAT conflict before all reference, create, and audit side effects", async () => {
    const getVatInfo = vi.fn().mockResolvedValue({ vat_number: "" });
    const getPurchaseArticles = vi.fn().mockResolvedValue([]);
    const getAccounts = vi.fn().mockResolvedValue([]);
    const getAccountDimensions = vi.fn().mockResolvedValue([]);
    const createAndSetTotals = vi.fn();
    const { handler } = getCrudToolHarness("create_purchase_invoice", {
      readonly: { getVatInfo, getPurchaseArticles, getAccounts, getAccountDimensions },
      purchaseInvoices: { createAndSetTotals },
    });

    const result = await handler(purchaseInvoiceCreateParams([
      {
        cl_purchase_articles_id: 45,
        custom_title: "Internet",
        vat_accounts_id: 1510,
        vat_accounts_dimensions_id: 15101,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
      },
      {
        cl_purchase_articles_id: 46,
        custom_title: "Fuel",
        cl_vat_articles_id: 2,
        vat_rate_dropdown: 0,
      },
    ])) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      category: "manual_review_required",
      details: [
        "items[0].vat_accounts_id must be absent",
        "items[0].vat_accounts_dimensions_id must be absent",
        "items[0].cl_vat_articles_id must be absent or 11",
        "items[0].vat_rate_dropdown must be absent or \"-\"",
        "items[1].cl_vat_articles_id must be absent or 11",
        "items[1].vat_rate_dropdown must be absent or \"-\"",
      ],
    });
    expect(getVatInfo).toHaveBeenCalledTimes(1);
    expect(getPurchaseArticles).not.toHaveBeenCalled();
    expect(getAccounts).not.toHaveBeenCalled();
    expect(getAccountDimensions).not.toHaveBeenCalled();
    expect(createAndSetTotals).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("M21 creates canonical non-VAT rows for absent null and article 11 dash inputs", async () => {
    const getVatInfo = vi.fn().mockResolvedValue({ vat_number: null });
    const getPurchaseArticles = vi.fn().mockResolvedValue([{
      id: 45,
      name_est: "Sisendkäibemaks",
      name_eng: "Input VAT",
      vat_accounts_id: 1510,
      cl_vat_articles_id: 1,
      vat_rate_dropdown: "24",
    }]);
    const createAndSetTotals = vi.fn().mockResolvedValue({ id: 71 });
    const { api, handler } = getCrudToolHarness("create_purchase_invoice", {
      readonly: {
        getVatInfo,
        getPurchaseArticles,
        getAccounts: vi.fn().mockResolvedValue([{
          id: 1510,
          name_est: "Sisendkäibemaks",
          allows_dimensions: false,
          is_valid: true,
        }]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: { createAndSetTotals },
    });

    const result = await handler(purchaseInvoiceCreateParams([
      { cl_purchase_articles_id: 45, custom_title: "Absent VAT fields", total_net_price: 30 },
      {
        cl_purchase_articles_id: 45,
        custom_title: "Null VAT fields",
        total_net_price: 30,
        vat_accounts_id: null,
        vat_accounts_dimensions_id: null,
        cl_vat_articles_id: null,
        vat_rate_dropdown: null,
      },
      {
        cl_purchase_articles_id: 45,
        custom_title: "Canonical VAT fields",
        total_net_price: 40,
        cl_vat_articles_id: 11,
        vat_rate_dropdown: " - ",
      },
    ])) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).not.toBe(true);
    expect(getVatInfo).toHaveBeenCalledTimes(1);
    expect(getPurchaseArticles).toHaveBeenCalledTimes(1);
    expect(createAndSetTotals).toHaveBeenCalledTimes(1);
    const created = createAndSetTotals.mock.calls[0]![0] as { items: Array<Record<string, unknown>> };
    expect(created.items).toHaveLength(3);
    for (const item of created.items) {
      expect(item).not.toHaveProperty("vat_accounts_id");
      expect(item).not.toHaveProperty("vat_accounts_dimensions_id");
      expect(item.cl_vat_articles_id).toBe(11);
      expect(item.vat_rate_dropdown).toBe("-");
    }
    expect(createAndSetTotals).toHaveBeenCalledWith(expect.any(Object), 0, 100, false);
    expect(api.readonly.getAccounts).toHaveBeenCalledTimes(1);
    expect(api.readonly.getAccountDimensions).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("M21 accepts the same deductible input for a live VAT-registered company", async () => {
    const getVatInfo = vi.fn().mockResolvedValue({ vat_number: "EE123456789" });
    const getPurchaseArticles = vi.fn().mockResolvedValue([]);
    const createAndSetTotals = vi.fn().mockResolvedValue({ id: 72 });
    const { handler } = getCrudToolHarness("create_purchase_invoice", {
      readonly: {
        getVatInfo,
        getPurchaseArticles,
        getAccounts: vi.fn().mockResolvedValue([{
          id: 1510,
          name_est: "Sisendkäibemaks",
          allows_dimensions: false,
          is_valid: true,
        }]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: { createAndSetTotals },
    });
    const deductibleItem = {
      cl_purchase_articles_id: 45,
      custom_title: "Internet",
      total_net_price: 100,
      vat_accounts_id: 1510,
      cl_vat_articles_id: 1,
      vat_rate_dropdown: "24",
    };

    const result = await handler(purchaseInvoiceCreateParams([deductibleItem])) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(getVatInfo).toHaveBeenCalledTimes(1);
    expect(createAndSetTotals).toHaveBeenCalledTimes(1);
    expect((createAndSetTotals.mock.calls[0]![0] as { items: unknown[] }).items).toEqual([
      expect.objectContaining(deductibleItem),
    ]);
    expect(createAndSetTotals).toHaveBeenCalledWith(expect.any(Object), 0, 100, true);
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}', "test")).toEqual({ a: 1 });
    expect(safeJsonParse("[1,2,3]", "test")).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"', "test")).toBe("hello");
  });

  it("throws on invalid JSON", () => {
    expect(() => safeJsonParse("{invalid", "test")).toThrow('Invalid JSON in "test"');
  });

  it("throws on oversized input", () => {
    const huge = "x".repeat(MAX_JSON_INPUT_SIZE + 1);
    expect(() => safeJsonParse(huge, "test")).toThrow("exceeds maximum size");
  });

  it("accepts JSON whose length is exactly MAX_JSON_INPUT_SIZE", () => {
    const value = "x".repeat(MAX_JSON_INPUT_SIZE - 2);
    const json = `"${value}"`;
    expect(json.length).toBe(MAX_JSON_INPUT_SIZE);
    expect(safeJsonParse(json, "test")).toBe(value);
  });
});

describe("registerCrudTools", () => {
  it("exposes focused domain registrars for CRUD tool groups", () => {
    expect(registerClientTools).toEqual(expect.any(Function));
    expect(registerProductTools).toEqual(expect.any(Function));
    expect(registerJournalTools).toEqual(expect.any(Function));
    expect(registerTransactionTools).toEqual(expect.any(Function));
    expect(registerSaleInvoiceTools).toEqual(expect.any(Function));
    expect(registerPurchaseInvoiceTools).toEqual(expect.any(Function));
  });

  it("keeps domain registrars independent from the aggregate CRUD module", () => {
    const crudDir = new URL("./crud/", import.meta.url);
    for (const fileName of readdirSync(crudDir).filter(name => name.endsWith(".ts") && name !== "shared.ts")) {
      const source = readFileSync(new URL(fileName, crudDir), "utf-8");
      expect(source, fileName).not.toContain('from "../crud-tools.js"');
    }
  });

  it("keeps the public CRUD and reference tool surface registered", () => {
    const server = { registerTool: vi.fn() };
    const api = {
      clients: {},
      products: {},
      journals: {},
      transactions: {},
      saleInvoices: {},
      purchaseInvoices: {},
      readonly: {},
    };

    registerCrudTools(server as never, api as never);

    expect(server.registerTool.mock.calls.map(([name]) => name)).toEqual([
      "list_clients",
      "get_client",
      "create_client",
      "update_client",
      "deactivate_client",
      "reactivate_client",
      "delete_client",
      "search_client",
      "find_client_by_code",
      "list_products",
      "get_product",
      "create_product",
      "update_product",
      "deactivate_product",
      "reactivate_product",
      "delete_product",
      "list_journals",
      "get_journal",
      "create_journal",
      "update_journal",
      "delete_journal",
      "confirm_journal",
      "batch_confirm_journals",
      "invalidate_journal",
      "list_transactions",
      "get_transaction",
      "create_transaction",
      "confirm_transaction",
      "update_transaction",
      "invalidate_transaction",
      "delete_transaction",
      "batch_delete_transactions",
      "list_sale_invoices",
      "get_sale_invoice",
      "create_sale_invoice",
      "update_sale_invoice",
      "delete_sale_invoice",
      "confirm_sale_invoice",
      "invalidate_sale_invoice",
      "get_sale_invoice_delivery_options",
      "send_sale_invoice",
      "get_sale_invoice_document",
      "get_sale_invoice_xml",
      "list_purchase_invoices",
      "get_purchase_invoice",
      "create_purchase_invoice",
      "update_purchase_invoice",
      "delete_purchase_invoice",
      "preview_purchase_invoice_totals_correction",
      "confirm_purchase_invoice",
      "invalidate_purchase_invoice",
      "list_accounts",
      "list_account_dimensions",
      "list_currencies",
      "list_sale_articles",
      "list_purchase_articles",
      "list_templates",
      "list_projects",
      "get_invoice_info",
      "update_invoice_info",
      "get_vat_info",
      "list_invoice_series",
      "get_invoice_series",
      "create_invoice_series",
      "update_invoice_series",
      "delete_invoice_series",
      "list_bank_accounts",
      "get_bank_account",
      "create_bank_account",
      "update_bank_account",
      "delete_bank_account",
    ]);
  });

  it("keeps compact direct-call invariants in heavy CRUD tool metadata", () => {
    const purchaseInvoice = toolMetadataText(getCrudToolHarness("create_purchase_invoice").options);
    expect(purchaseInvoice).toContain("EXACT");
    expect(purchaseInvoice).toContain("EUR per 1 foreign currency unit");
    expect(purchaseInvoice).toContain("purchase_accounts_dimensions_id is REQUIRED");
    expect(purchaseInvoice).not.toContain("Legacy callers may still pass");

    const transaction = toolMetadataText(getCrudToolHarness("confirm_transaction").options);
    expect(transaction).toContain("Array of distribution rows");
    expect(transaction).toContain("related_sub_id is REQUIRED");
    expect(transaction).toContain("Client ID to set on the transaction before confirming");
    expect(transaction).not.toContain("Legacy callers may still pass");

    const transactionsList = toolMetadataText(getCrudToolHarness("list_transactions").options);
    expect(transactionsList).toContain("brief view");
    expect(transactionsList).not.toContain("listAll()");
    expect(transactionsList).not.toContain("dozens of pages");
  });
});

describe("parseJsonObject", () => {
  it("parses a valid JSON object", () => {
    expect(parseJsonObject('{"name":"test"}', "data")).toEqual({ name: "test" });
  });

  it("accepts an already-structured object", () => {
    expect(parseJsonObject({ name: "test" }, "data")).toEqual({ name: "test" });
  });

  it("throws on JSON array", () => {
    expect(() => parseJsonObject("[1,2]", "data")).toThrow('"data" must be a JSON object');
  });

  it("throws on JSON string", () => {
    expect(() => parseJsonObject('"hello"', "data")).toThrow('"data" must be a JSON object');
  });
});

describe("parseJsonObjectArray", () => {
  it("parses a valid JSON array of objects", () => {
    const result = parseJsonObjectArray('[{"a":1},{"b":2}]', "items");
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("accepts an already-structured array of objects", () => {
    expect(parseJsonObjectArray([{ a: 1 }, { b: 2 }], "items")).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("throws on non-array JSON", () => {
    expect(() => parseJsonObjectArray('{"a":1}', "items")).toThrow('"items" must be a JSON array');
  });

  it("throws when array contains non-objects", () => {
    expect(() => parseJsonObjectArray('[1, 2]', "items")).toThrow('"items" item 1 must be a JSON object');
  });
});

describe("requireFields", () => {
  it("passes when all fields present", () => {
    expect(() => requireFields([{ a: 1, b: "x" }], "items", ["a", "b"])).not.toThrow();
  });

  it("throws on missing field", () => {
    expect(() => requireFields([{ a: 1 }], "items", ["a", "b"])).toThrow('"items" item 1 is missing required field "b"');
  });

  it("throws on null field", () => {
    expect(() => requireFields([{ a: null }], "items", ["a"])).toThrow('"items" item 1 is missing required field "a"');
  });

  it("throws on empty string field", () => {
    expect(() => requireFields([{ a: "" }], "items", ["a"])).toThrow('"items" item 1 is missing required field "a"');
  });

  it("reports correct item index", () => {
    expect(() => requireFields([{ a: 1 }, { b: 2 }], "items", ["a"])).toThrow("item 2");
  });
});

describe("parsePurchaseInvoiceItems", () => {
  it("parses valid items", () => {
    const items = parsePurchaseInvoiceItems('[{"cl_purchase_articles_id":45,"custom_title":"Internet"}]');
    expect(items).toHaveLength(1);
    expect(items[0]!.custom_title).toBe("Internet");
  });

  it("coerces VAT dimension ids to numbers", () => {
    const items = parsePurchaseInvoiceItems(
      '[{"cl_purchase_articles_id":45,"custom_title":"Internet","vat_accounts_dimensions_id":"12"}]'
    );
    expect(items[0]!.vat_accounts_dimensions_id).toBe(12);
  });

  it("throws when cl_purchase_articles_id missing", () => {
    expect(() => parsePurchaseInvoiceItems('[{"custom_title":"test"}]')).toThrow("cl_purchase_articles_id");
  });

  it("throws when custom_title missing", () => {
    expect(() => parsePurchaseInvoiceItems('[{"cl_purchase_articles_id":1}]')).toThrow("custom_title");
  });
});

describe("parseSaleInvoiceItems", () => {
  it("coerces string-typed discount_percent to number", () => {
    const items = parseSaleInvoiceItems('[{"products_id":1,"custom_title":"Service","amount":1,"discount_percent":"10"}]');
    expect(items[0]!.discount_percent).toBe(10);
  });

  it("coerces sale account dimensions and project ids to numbers", () => {
    const items = parseSaleInvoiceItems(
      '[{"products_id":1,"custom_title":"Service","amount":1,"sale_accounts_dimensions_id":"22","projects_location_id":"33","projects_person_id":"44"}]'
    );
    expect(items[0]!.sale_accounts_dimensions_id).toBe(22);
    expect(items[0]!.projects_location_id).toBe(33);
    expect(items[0]!.projects_person_id).toBe(44);
  });

  it("rejects non-numeric discount_percent values", () => {
    expect(() =>
      parseSaleInvoiceItems('[{"products_id":1,"custom_title":"Service","amount":1,"discount_percent":"bad"}]')
    ).toThrow("discount_percent");
  });
});

describe("coerceNumericFields", () => {
  it("coerces integer string to number", () => {
    const items = [{ price: "10" }];
    coerceNumericFields(items, ["price"]);
    expect(items[0]!.price).toBe(10);
  });

  it("coerces decimal string to number", () => {
    const items = [{ rate: "3.14" }];
    coerceNumericFields(items, ["rate"]);
    expect(items[0]!.rate).toBe(3.14);
  });

  it("does not coerce non-numeric string", () => {
    const items = [{ name: "bad" }];
    coerceNumericFields(items, ["name"]);
    expect(items[0]!.name).toBe("bad");
  });

  it("rejects empty string explicitly with item index (Number('') would silently become 0)", () => {
    const items = [{ value: "" }];
    expect(() => coerceNumericFields(items, ["value"])).toThrow(
      'Numeric field "value" at item 1 cannot be an empty string'
    );
  });

  it("rejects whitespace-only string the same way and reports the correct row", () => {
    const items = [{ amount: 1 }, { amount: "   " }];
    expect(() => coerceNumericFields(items, ["amount"])).toThrow(
      'Numeric field "amount" at item 2 cannot be an empty string'
    );
  });

  it("does not touch null or undefined values", () => {
    const items = [{ a: null, b: undefined }];
    coerceNumericFields(items, ["a", "b"]);
    expect(items[0]!.a).toBeNull();
    expect(items[0]!.b).toBeUndefined();
  });

  it("does not coerce NaN or Infinity strings", () => {
    const items = [{ a: "NaN", b: "Infinity", c: "-Infinity" }];
    coerceNumericFields(items, ["a", "b", "c"]);
    expect(items[0]!.a).toBe("NaN");
    expect(items[0]!.b).toBe("Infinity");
    expect(items[0]!.c).toBe("-Infinity");
  });

  it("only coerces specified fields", () => {
    const items = [{ price: "10", name: "test" }];
    coerceNumericFields(items, ["price"]);
    expect(items[0]!.price).toBe(10);
    expect(items[0]!.name).toBe("test");
  });

  it("coerces across multiple items", () => {
    const items = [{ amount: "5" }, { amount: "7.5" }];
    coerceNumericFields(items, ["amount"]);
    expect(items[0]!.amount).toBe(5);
    expect(items[1]!.amount).toBe(7.5);
  });

  it("ignores fields not present on item", () => {
    const items = [{ a: "1" }];
    coerceNumericFields(items, ["a", "b"]);
    expect(items[0]!.a).toBe(1);
    expect("b" in items[0]!).toBe(false);
  });

  it("does not coerce non-string values", () => {
    const items = [{ price: 42 }];
    coerceNumericFields(items, ["price"]);
    expect(items[0]!.price).toBe(42);
  });
});

describe("create_product", () => {
  it("exposes account default fields in the MCP input schema", () => {
    const { options } = getCrudToolHarness("create_product");

    expect(options.inputSchema).toHaveProperty("sale_accounts_id");
    expect(options.inputSchema).toHaveProperty("cl_sale_accounts_dimensions_id");
    expect(options.inputSchema).toHaveProperty("sale_accounts_dimensions_id");
    expect(options.inputSchema).toHaveProperty("purchase_accounts_id");
    expect(options.inputSchema).toHaveProperty("purchase_accounts_dimensions_id");
  });

  it("coerces and passes account defaults through to the products API", async () => {
    const { api, options, handler } = getCrudToolHarness("create_product", {
      products: {
        create: vi.fn().mockResolvedValue({ code: 0, messages: [], created_object_id: 123 }),
      },
    });

    const parsed = z.object(options.inputSchema as z.ZodRawShape).parse({
      name: "Consulting",
      code: "CONSULT",
      cl_sale_articles_id: "7",
      sale_accounts_id: "3100",
      cl_sale_accounts_dimensions_id: "1245521",
      sale_accounts_dimensions_id: "1245522",
      cl_purchase_articles_id: "8",
      purchase_accounts_id: "4000",
      purchase_accounts_dimensions_id: "1245523",
      sales_price: "100",
      unit: "h",
    });

    const result = await handler(parsed) as { content: Array<{ text: string }> };

    expect(api.products.create).toHaveBeenCalledWith({
      name: "Consulting",
      code: "CONSULT",
      cl_sale_articles_id: 7,
      sale_accounts_id: 3100,
      cl_sale_accounts_dimensions_id: 1245521,
      sale_accounts_dimensions_id: 1245522,
      cl_purchase_articles_id: 8,
      purchase_accounts_id: 4000,
      purchase_accounts_dimensions_id: 1245523,
      sales_price: 100,
      unit: "h",
    });
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      ok: true,
      action: "created",
      entity: "product",
      id: 123,
      raw: {
        code: 0,
        created_object_id: 123,
      },
    });
  });
});

describe("list_journals", () => {
  it("warns that opening balance entries may be absent from journal API results", async () => {
    const { handler } = getCrudToolHarness("list_journals", {
      journals: {
        list: vi.fn().mockResolvedValue({
          current_page: 1,
          total_pages: 1,
          items: [],
        }),
      },
    });

    const result = await handler({}) as { content: Array<{ text: string }> };
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(payload.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Algbilansi kanded"),
    ]));
    // The native/server path emits the same superset envelope as the client-side path.
    expect(payload).toMatchObject({
      current_page: 1,
      total_pages: 1,
      filtered_client_side: false,
      out_of_range: false,
      items: [],
    });
    expect(payload).toHaveProperty("total_items");
    expect(payload).toHaveProperty("per_page");
  });
});

describe("server-side list filters", () => {
  const emptyPage = { current_page: 1, total_pages: 1, items: [] };

  it("list_purchase_invoices passes the API-native filters server-side and strips view", async () => {
    const { api, handler } = getCrudToolHarness("list_purchase_invoices", {
      purchaseInvoices: { list: vi.fn().mockResolvedValue(emptyPage) },
    });

    await handler({
      page: 2, date_from: "2026-01-01", date_to: "2026-03-31",
      status: "CONFIRMED", payment_status: "NOT_PAID", clients_id: 42, view: "full",
    });

    expect(api.purchaseInvoices.list).toHaveBeenCalledTimes(1);
    const arg = (api.purchaseInvoices.list as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Public params are date_from/date_to; the handler remaps to the API's start_date/end_date.
    expect(arg).toEqual({
      page: 2, start_date: "2026-01-01", end_date: "2026-03-31",
      status: "CONFIRMED", payment_status: "NOT_PAID", clients_id: 42,
    });
    expect(arg).not.toHaveProperty("view"); // view is a presentation concern, never sent to the API
    expect(arg).not.toHaveProperty("date_from"); // remapped, not forwarded raw
  });

  it("list_sale_invoices passes the API-native filters server-side", async () => {
    const { api, handler } = getCrudToolHarness("list_sale_invoices", {
      saleInvoices: { list: vi.fn().mockResolvedValue(emptyPage) },
    });

    await handler({ date_from: "2026-04-01", status: "PROJECT", clients_id: 7, view: "brief" });

    expect(api.saleInvoices.list).toHaveBeenCalledTimes(1);
    // Public date_from remaps to the API's start_date.
    expect((api.saleInvoices.list as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      start_date: "2026-04-01", status: "PROJECT", clients_id: 7,
    });
  });

  it("list_transactions uses server-side pagination when only API-native filters are set", async () => {
    const { api, handler } = getCrudToolHarness("list_transactions", {
      transactions: {
        list: vi.fn().mockResolvedValue(emptyPage),
        listAll: vi.fn(),
        listAllCached: vi.fn(),
      },
    });

    const res = await handler({ date_from: "2026-01-01", status: "CONFIRMED", type: "C", clients_id: 9 }) as { content: Array<{ text: string }> };

    expect(api.transactions.list).toHaveBeenCalledTimes(1);
    expect((api.transactions.list as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      start_date: "2026-01-01", status: "CONFIRMED", type: "C", clients_id: 9,
    });
    expect(api.transactions.listAll).not.toHaveBeenCalled();
    expect(api.transactions.listAllCached).not.toHaveBeenCalled();
    // The native/server path emits the same superset envelope as the client-side path.
    const payload = parseMcpResponse(res.content[0]!.text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      current_page: 1,
      total_pages: 1,
      filtered_client_side: false,
      out_of_range: false,
      items: [],
    });
    expect(payload).toHaveProperty("total_items");
    expect(payload).toHaveProperty("per_page");
  });

  it("list_transactions narrows server-side then filters client-side when both kinds of filter are set", async () => {
    const rows = [
      { id: 1, date: "2026-02-01", amount: 100, base_amount: 100, status: "CONFIRMED", type: "C", bank_ref_number: "REF1" },
      { id: 2, date: "2026-02-02", amount: 5, base_amount: 5, status: "CONFIRMED", type: "C", bank_ref_number: "REF2" },
    ];
    const { api, handler } = getCrudToolHarness("list_transactions", {
      transactions: {
        list: vi.fn(),
        listAll: vi.fn().mockResolvedValue(rows),
        listAllCached: vi.fn(),
      },
    });

    const res = await handler({ date_from: "2026-01-01", amount_min: 50 }) as { content: Array<{ text: string }> };

    expect(api.transactions.listAll).toHaveBeenCalledTimes(1);
    expect((api.transactions.listAll as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ start_date: "2026-01-01" });
    expect(api.transactions.listAllCached).not.toHaveBeenCalled();
    const payload = parseMcpResponse(res.content[0]!.text) as { total_items: number; filtered_client_side: boolean };
    expect(payload.filtered_client_side).toBe(true);
    expect(payload.total_items).toBe(1); // only the 100-amount row clears amount_min=50
  });

  it("list_transactions falls back to the cached full walk when only a client-side filter is set", async () => {
    const { api, handler } = getCrudToolHarness("list_transactions", {
      transactions: {
        list: vi.fn(),
        listAll: vi.fn(),
        listAllCached: vi.fn().mockResolvedValue([]),
      },
    });

    await handler({ amount_min: 50 });

    expect(api.transactions.listAllCached).toHaveBeenCalledTimes(1);
    expect(api.transactions.listAll).not.toHaveBeenCalled();
    expect(api.transactions.list).not.toHaveBeenCalled();
  });

  it("list_transactions honours modified_since (server-side narrow) even when only a client-side filter is also set", async () => {
    const { api, handler } = getCrudToolHarness("list_transactions", {
      transactions: {
        list: vi.fn(),
        listAll: vi.fn().mockResolvedValue([]),
        listAllCached: vi.fn(),
      },
    });

    await handler({ modified_since: "2026-01-01T00:00:00Z", amount_min: 50 });

    // modified_since is a server-native filter on every endpoint, so it must
    // route to the narrowed listAll, not the params-blind cached full walk.
    expect(api.transactions.listAll).toHaveBeenCalledTimes(1);
    expect((api.transactions.listAll as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ modified_since: "2026-01-01T00:00:00Z" });
    expect(api.transactions.listAllCached).not.toHaveBeenCalled();
  });

  it("list_journals honours modified_since even when only a client-side filter is also set", async () => {
    const { api, handler } = getCrudToolHarness("list_journals", {
      journals: {
        list: vi.fn(),
        listAll: vi.fn().mockResolvedValue([]),
        listAllCached: vi.fn(),
      },
    });

    await handler({ modified_since: "2026-01-01T00:00:00Z", registered: true });

    expect(api.journals.listAll).toHaveBeenCalledTimes(1);
    expect((api.journals.listAll as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ modified_since: "2026-01-01T00:00:00Z" });
    expect(api.journals.listAllCached).not.toHaveBeenCalled();
  });

  it("list_journals narrows server-side by effective-date range, then filters client-side", async () => {
    const { api, handler } = getCrudToolHarness("list_journals", {
      journals: {
        list: vi.fn(),
        listAll: vi.fn().mockResolvedValue([{ id: 1, effective_date: "2026-02-01", registered: true, postings: [] }]),
        listAllCached: vi.fn(),
      },
    });

    await handler({ date_from: "2026-01-01", registered: true });

    expect(api.journals.listAll).toHaveBeenCalledTimes(1);
    // Public date_from remaps to the API's start_date.
    expect((api.journals.listAll as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ start_date: "2026-01-01" });
    expect(api.journals.listAllCached).not.toHaveBeenCalled();
  });

  it("list_journals uses the cached full walk when no server-side (date) filter is set", async () => {
    const { api, handler } = getCrudToolHarness("list_journals", {
      journals: {
        list: vi.fn(),
        listAll: vi.fn(),
        listAllCached: vi.fn().mockResolvedValue([]),
      },
    });

    await handler({ registered: true });

    expect(api.journals.listAllCached).toHaveBeenCalledTimes(1);
    expect(api.journals.listAll).not.toHaveBeenCalled();
  });
});

describe("hard-delete master data", () => {
  const annotationsOf = (options: unknown) =>
    (options as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }).annotations;

  it("delete_client routes to api.clients.delete (DELETE /clients/{id}), is destructive, and audits DELETED", async () => {
    const { api, handler, options } = getCrudToolHarness("delete_client", {
      clients: { delete: vi.fn().mockResolvedValue({ code: 200, messages: [] }) },
    });

    const res = await handler({ id: 55 }) as { content: Array<{ text: string }> };

    expect(api.clients.delete).toHaveBeenCalledWith(55);
    expect(res.content[0]!.text).toBeTruthy();
    // Safety contract: a hard delete must stay annotated destructive (never silently downgraded to mutate).
    expect(annotationsOf(options)).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "delete_client", action: "DELETED", entity_type: "client", entity_id: 55,
    }));
  });

  it("delete_product routes to api.products.delete (DELETE /products/{id}), is destructive, and audits DELETED", async () => {
    const { api, handler, options } = getCrudToolHarness("delete_product", {
      products: { delete: vi.fn().mockResolvedValue({ code: 200, messages: [] }) },
    });

    await handler({ id: 88 });

    expect(api.products.delete).toHaveBeenCalledWith(88);
    expect(annotationsOf(options)).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "delete_product", action: "DELETED", entity_type: "product", entity_id: 88,
    }));
  });
});

describe("get_sale_invoice_xml", () => {
  it("downloads the system-generated e-invoice XML via getSystemXml", async () => {
    const { api, handler } = getCrudToolHarness("get_sale_invoice_xml", {
      saleInvoices: {
        getSystemXml: vi.fn().mockResolvedValue({ name: "invoice-42.xml", contents: "PGludm9pY2U+" }),
        getSystemPdf: vi.fn(),
      },
    });

    const res = await handler({ id: 42 }) as { content: Array<{ text: string }> };

    expect(api.saleInvoices.getSystemXml).toHaveBeenCalledWith(42);
    expect(api.saleInvoices.getSystemPdf).not.toHaveBeenCalled(); // distinct from the PDF download
    expect(res.content[0]!.text).toContain("invoice-42.xml");
    expect(res.content[0]!.text).toContain("PGludm9pY2U+");
  });
});

describe("structured JSON-compatible inputs", () => {
  it("update_client accepts an object instead of a JSON string", async () => {
    const { api, handler } = getCrudToolHarness("update_client", {
      clients: { update: vi.fn().mockResolvedValue({ code: 1, messages: ["ok"] }) },
    });

    const result = await handler({ id: 7, data: { email: "new@example.com" } }) as { content: Array<{ text: string }> };

    expect(api.clients.update).toHaveBeenCalledWith(7, { email: "new@example.com" });
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      ok: true,
      action: "updated",
      entity: "client",
      id: 7,
    });
  });

  it("create_journal accepts an array of postings instead of a JSON string", async () => {
    const { api, handler } = getCrudToolHarness("create_journal", {
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([
          { id: 4000, account_code: "4000", allows_dimensions: false, is_valid: true },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      journals: {
        create: vi.fn().mockResolvedValue({ code: 0, messages: [], created_object_id: 456 }),
      },
    });

    const result = await handler({
      effective_date: "2026-04-24",
      postings: [{ accounts_id: "4000", type: "D", amount: "12.50" }],
    }) as { content: Array<{ text: string }> };

    expect(api.journals.create).toHaveBeenCalledWith({
      effective_date: "2026-04-24",
      cl_currencies_id: "EUR",
      postings: [{ accounts_id: 4000, type: "D", amount: 12.5 }],
    });
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      ok: true,
      action: "created",
      entity: "journal",
      id: 456,
    });
  });

  it("confirm_transaction accepts an array of distributions instead of a JSON string", async () => {
    const { api, handler } = getCrudToolHarness("confirm_transaction", {
      transactions: {
        get: vi.fn().mockResolvedValue({ id: 1, clients_id: 99 }),
        confirm: vi.fn().mockResolvedValue({ code: 0, messages: [] }),
      },
    });

    await handler({
      id: 1,
      distributions: [{ related_table: "sale_invoices", related_id: "321", amount: "12" }],
    });

    expect(api.transactions.confirm).toHaveBeenCalledWith(1, [
      { related_table: "sale_invoices", related_id: 321, amount: 12 },
    ]);
  });
});

describe("search_client", () => {
  it("returns a structured object envelope with count and raw results", async () => {
    const { handler } = getCrudToolHarness("search_client", {
      clients: {
        findByName: vi.fn().mockResolvedValue([{ id: 1, name: "Acme OÜ" }, { id: 2, name: "Acme Trading" }]),
      },
    });

    const result = await handler({ name: "Acme" }) as { content: Array<{ text: string }> };

    const payload = parseMcpResponse(result.content[0]!.text) as {
      ok: boolean; action: string; entity: string; message: string; count: number;
      raw: Array<{ id: number; name: string }>;
    };
    expect(payload).toMatchObject({
      ok: true,
      action: "searched",
      entity: "client",
      message: 'Found 2 client(s) matching "Acme".',
      count: 2,
    });
    // ids are structural and unchanged; the import-origin name is now sandboxed (D01)
    expect(payload.raw.map(r => r.id)).toEqual([1, 2]);
    expect(payload.raw[0]!.name).toContain("UNTRUSTED_OCR_START:");
    expect(payload.raw[0]!.name).toContain("Acme OÜ");
    expect(payload.raw[1]!.name).toContain("UNTRUSTED_OCR_START:");
    expect(payload.raw[1]!.name).toContain("Acme Trading");
  });

  it("returns count:0 and an empty array (still ok) when nothing matches", async () => {
    const { handler } = getCrudToolHarness("search_client", {
      clients: { findByName: vi.fn().mockResolvedValue([]) },
    });

    const result = await handler({ name: "Nonexistent" }) as { content: Array<{ text: string }> };

    expect(parseMcpResponse(result.content[0]!.text)).toEqual({
      ok: true,
      action: "searched",
      entity: "client",
      message: 'Found 0 client(s) matching "Nonexistent".',
      count: 0,
      raw: [],
    });
  });
});

describe("reactivate tools", () => {
  it("reactivate_client calls api.clients.restore and returns the reactivated envelope", async () => {
    const { api, handler } = getCrudToolHarness("reactivate_client", {
      clients: { restore: vi.fn().mockResolvedValue({ code: 200, messages: [] }) },
    });

    const result = await handler({ id: 12 }) as { content: Array<{ text: string }> };

    expect(api.clients.restore).toHaveBeenCalledWith(12);
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      ok: true,
      action: "reactivated",
      entity: "client",
      id: 12,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "reactivate_client", action: "UPDATED", entity_type: "client", entity_id: 12,
    }));
  });

  it("reactivate_product calls api.products.restore and returns the reactivated envelope", async () => {
    const { api, handler } = getCrudToolHarness("reactivate_product", {
      products: { restore: vi.fn().mockResolvedValue({ code: 200, messages: [] }) },
    });

    const result = await handler({ id: 34 }) as { content: Array<{ text: string }> };

    expect(api.products.restore).toHaveBeenCalledWith(34);
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      ok: true,
      action: "reactivated",
      entity: "product",
      id: 34,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "reactivate_product", action: "UPDATED", entity_type: "product", entity_id: 34,
    }));
  });
});

describe("find_client_by_code", () => {
  it("returns a structured not-found envelope instead of plain text", async () => {
    const { handler } = getCrudToolHarness("find_client_by_code", {
      clients: {
        findByCode: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await handler({ code: "12345678" }) as { content: Array<{ text: string }> };

    expect(parseMcpResponse(result.content[0]!.text)).toEqual({
      ok: false,
      action: "found",
      entity: "client",
      found: false,
      message: "No client found for registry code 12345678.",
      raw: null,
    });
  });
});

describe("confirm_transaction", () => {
  it("rejects account distributions without related_id before mutating the transaction", async () => {
    const { api, handler } = getCrudToolHarness("confirm_transaction");

    await expect(handler({
      id: 1,
      clients_id: 99,
      distributions: '[{"related_table":"accounts","amount":12}]',
    })).rejects.toThrow('field "related_id" must be a positive number');

    expect(api.transactions.get).not.toHaveBeenCalled();
    expect(api.transactions.update).not.toHaveBeenCalled();
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("returns dimension validation errors before setting temporary clients_id", async () => {
    const { api, handler } = getCrudToolHarness("confirm_transaction", {
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([
          { id: 1360, name_est: "Arveldused aruandvate isikutega", allows_dimensions: true, is_valid: true },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          { id: 10, accounts_id: 1360, title_est: "Mari", is_deleted: false },
          { id: 11, accounts_id: 1360, title_est: "Jaan", is_deleted: false },
        ]),
      },
    });

    const result = await handler({
      id: 1,
      clients_id: 99,
      distributions: '[{"related_table":"accounts","related_id":1360,"amount":12}]',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      error: "Account validation failed",
    });
    expect(api.transactions.get).not.toHaveBeenCalled();
    expect(api.transactions.update).not.toHaveBeenCalled();
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("rolls back a temporary clients_id if confirm fails", async () => {
    const { api, handler } = getCrudToolHarness("confirm_transaction", {
      transactions: {
        get: vi.fn().mockResolvedValue({ id: 1, clients_id: null }),
        update: vi.fn().mockResolvedValue({}),
        confirm: vi.fn().mockRejectedValue(new Error("confirm failed")),
      },
    });

    await expect(handler({
      id: 1,
      clients_id: 99,
      distributions: '[{"related_table":"sale_invoices","related_id":321,"amount":12}]',
    })).rejects.toThrow("confirm failed");

    expect(api.transactions.get).toHaveBeenCalledWith(1);
    expect(api.transactions.update).toHaveBeenNthCalledWith(1, 1, { clients_id: 99 });
    expect(api.transactions.confirm).toHaveBeenCalledWith(1, [
      { related_table: "sale_invoices", related_id: 321, amount: 12 },
    ]);
    expect(api.transactions.update).toHaveBeenNthCalledWith(2, 1, { clients_id: null });
  });

  it.each([
    {
      label: "definite HTTP rejection",
      confirmError: new HttpError("rejected", 409, "PATCH", "/transactions/1/register"),
      shouldClean: true,
    },
    {
      label: "structured indeterminate confirmation",
      confirmError: new MutationIndeterminateError({
        operation: "confirm",
        entity: "transaction",
        entityId: 1,
        businessKey: "transaction:1",
        affectedCaches: ["/transactions", "/journals"],
        cause: new HttpError("read lost", "network", "GET", "/transactions/1"),
        nextAction: "Freshly read transaction 1 before any retry.",
      }),
      shouldClean: false,
    },
  ])("H03 CRUD cleans a tool-set client only after proven rejection: $label", async ({ confirmError, shouldClean }) => {
    const { api, handler } = getCrudToolHarness("confirm_transaction", {
      transactions: {
        get: vi.fn().mockResolvedValue({ id: 1, clients_id: null }),
        update: vi.fn().mockResolvedValue({}),
        confirm: vi.fn().mockRejectedValue(confirmError),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([
          { id: 4000, account_code: "4000", allows_dimensions: false, is_valid: true },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(handler({
      id: 1,
      clients_id: 99,
      distributions: [{ related_table: "accounts", related_id: 4000, amount: 12 }],
    })).rejects.toBe(confirmError);

    expect(api.transactions.update).toHaveBeenNthCalledWith(1, 1, { clients_id: 99 });
    if (shouldClean) {
      expect(api.transactions.update).toHaveBeenCalledTimes(2);
      expect(api.transactions.update).toHaveBeenNthCalledWith(2, 1, { clients_id: null });
    } else {
      expect(api.transactions.update).toHaveBeenCalledTimes(1);
      expect(api.transactions.update).not.toHaveBeenCalledWith(1, { clients_id: null });
    }
  });

  it("H03 CRUD exposes ambiguous explicit-client cleanup as rollback", async () => {
    const confirmError = new HttpError("rejected", 409, "PATCH", "/transactions/1/register");
    const cleanupError = new HttpError("cleanup lost", "network", "PATCH", "/transactions/1");
    const invalidateTransactionsAfterAmbiguousCleanup = vi.fn();
    const { api, handler } = getCrudToolHarness("confirm_transaction", {
      transactions: {
        get: vi.fn().mockResolvedValue({ id: 1, clients_id: null }),
        update: vi.fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(cleanupError),
        confirm: vi.fn().mockRejectedValue(confirmError),
        invalidateTransactionsAfterAmbiguousCleanup,
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([
          { id: 4000, account_code: "4000", allows_dimensions: false, is_valid: true },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
    });

    let outcome: unknown;
    try {
      await handler({
        id: 1,
        clients_id: 99,
        distributions: [{ related_table: "accounts", related_id: 4000, amount: 12 }],
      });
    } catch (error) {
      expect(invalidateTransactionsAfterAmbiguousCleanup).toHaveBeenCalledTimes(1);
      outcome = error;
    }

    expect(outcome).toBeInstanceOf(MutationIndeterminateError);
    expect(outcome).toMatchObject({
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
      operation: "rollback",
      entity: "transaction",
      entityId: 1,
      businessKey: "transaction:1",
      affectedCaches: ["/transactions"],
      cause: {
        name: "HttpError",
        message: "cleanup lost",
        status: "network",
        method: "PATCH",
        path: "/transactions/1",
      },
      nextAction: "Freshly read transaction 1; clients_id cleanup may or may not have committed.",
    });
    expect(api.transactions.update).toHaveBeenNthCalledWith(1, 1, { clients_id: 99 });
    expect(api.transactions.update).toHaveBeenNthCalledWith(2, 1, { clients_id: null });
  });

  it("H03 CRUD normalizes structured explicit-client cleanup ambiguity as rollback", async () => {
    const confirmError = new HttpError("rejected", 409, "PATCH", "/transactions/1/register");
    const cleanupError = new MutationIndeterminateError({
      operation: "update",
      entity: "transaction",
      entityId: 1,
      businessKey: "/transactions:1",
      affectedCaches: ["/transactions"],
      cause: new HttpError("cleanup lost", "network", "PATCH", "/transactions/1"),
      nextAction: "Intermediate M01 recovery.",
    });
    const invalidateTransactionsAfterAmbiguousCleanup = vi.fn();
    const { api, handler } = getCrudToolHarness("confirm_transaction", {
      transactions: {
        get: vi.fn().mockResolvedValue({ id: 1, clients_id: null }),
        update: vi.fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(cleanupError),
        confirm: vi.fn().mockRejectedValue(confirmError),
        invalidateTransactionsAfterAmbiguousCleanup,
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([
          { id: 4000, account_code: "4000", allows_dimensions: false, is_valid: true },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
    });

    const outcome = await handler({
      id: 1,
      clients_id: 99,
      distributions: [{ related_table: "accounts", related_id: 4000, amount: 12 }],
    }).catch(error => error);

    expect(outcome).toBeInstanceOf(MutationIndeterminateError);
    expect(outcome).toMatchObject({
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
      operation: "rollback",
      entity: "transaction",
      entityId: 1,
      businessKey: "transaction:1",
      affectedCaches: ["/transactions"],
      cause: {
        name: "HttpError",
        message: "cleanup lost",
        status: "network",
        method: "PATCH",
        path: "/transactions/1",
      },
      nextAction: "Freshly read transaction 1; clients_id cleanup may or may not have committed.",
    });
    expect(outcome).not.toBe(cleanupError);
    expect(api.transactions.update).toHaveBeenCalledTimes(2);
    expect(api.transactions.update).toHaveBeenNthCalledWith(1, 1, { clients_id: 99 });
    expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
    expect(api.transactions.confirm).toHaveBeenCalledWith(1, [
      { related_table: "accounts", related_id: 4000, amount: 12 },
    ]);
    expect(api.transactions.update).toHaveBeenNthCalledWith(2, 1, { clients_id: null });
    expect(invalidateTransactionsAfterAmbiguousCleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "incomplete cause",
      cleanupError: Object.assign(new Error("incomplete cleanup ambiguity"), {
        category: "mutation_indeterminate" as const,
        mutationMayHaveOccurred: true as const,
        cause: {
          name: "HttpError",
          message: "cleanup lost",
          status: "network" as const,
          method: "TRACE",
          path: "/transactions/1",
        },
      }),
    },
    {
      label: "throwing cause getter",
      cleanupError: (() => {
        const error = Object.assign(new Error("getter-backed cleanup ambiguity"), {
          category: "mutation_indeterminate" as const,
          mutationMayHaveOccurred: true as const,
        });
        Object.defineProperty(error, "cause", {
          enumerable: false,
          get() {
            throw new Error("malicious cause getter");
          },
        });
        return error;
      })(),
    },
  ])("H03 CRUD preserves non-normalizable explicit-client cleanup: $label", async ({ cleanupError }) => {
    const confirmError = new HttpError("rejected", 409, "PATCH", "/transactions/1/register");
    const invalidateTransactionsAfterAmbiguousCleanup = vi.fn();
    const { api, handler } = getCrudToolHarness("confirm_transaction", {
      transactions: {
        get: vi.fn().mockResolvedValue({ id: 1, clients_id: null }),
        update: vi.fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(cleanupError),
        confirm: vi.fn().mockRejectedValue(confirmError),
        invalidateTransactionsAfterAmbiguousCleanup,
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([
          { id: 4000, account_code: "4000", allows_dimensions: false, is_valid: true },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
    });

    const outcome = await handler({
      id: 1,
      clients_id: 99,
      distributions: [{ related_table: "accounts", related_id: 4000, amount: 12 }],
    }).catch(error => error);

    expect(outcome).toBe(cleanupError);
    expect(api.transactions.update).toHaveBeenCalledTimes(2);
    expect(api.transactions.update).toHaveBeenNthCalledWith(2, 1, { clients_id: null });
    expect(invalidateTransactionsAfterAmbiguousCleanup).not.toHaveBeenCalled();
  });
});

describe("update_transaction", () => {
  it("rejects non-metadata fields", async () => {
    const { api, handler } = getCrudToolHarness("update_transaction");

    const result = await handler({
      id: 1,
      data: '{"bank_ref_number":"RF123","amount":99.5}',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      error: "Transaction metadata validation failed",
    });
    expect(api.transactions.update).not.toHaveBeenCalled();
  });

  it("rejects non-string metadata values", async () => {
    const { api, handler } = getCrudToolHarness("update_transaction");

    const result = await handler({
      id: 1,
      data: '{"bank_ref_number":123}',
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      error: "Transaction metadata validation failed",
    });
    expect(api.transactions.update).not.toHaveBeenCalled();
  });

  it("allows safe metadata enrichment fields", async () => {
    const { api, handler } = getCrudToolHarness("update_transaction", {
      transactions: {
        update: vi.fn().mockResolvedValue({ code: 1, messages: ["ok"] }),
      },
    });

    const result = await handler({
      id: 1,
      data: '{"bank_ref_number":"RF123","description":"CAMT import metadata"}',
    }) as { content: Array<{ text: string }> };

    expect(api.transactions.update).toHaveBeenCalledWith(1, {
      bank_ref_number: "RF123",
      description: "CAMT import metadata",
    });
    expect(parseMcpResponse(result.content[0]!.text)).toMatchObject({
      ok: true,
      action: "updated",
      entity: "transaction",
      id: 1,
      raw: { code: 1, messages: ["ok"] },
    });
  });
});

describe("update_* allowlists", () => {
  it("update_client rejects is_active without mutating", async () => {
    const { api, handler } = getCrudToolHarness("update_client");
    const result = await handler({ id: 7, data: '{"is_active":false}' }) as { content: Array<{ text: string }> };
    expect(api.clients.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.error).toBe("Invalid update fields");
    expect(body.details[0]).toMatch(/"is_active".*update_client/);
  });

  it("update_product rejects deactivated_date without mutating", async () => {
    const { api, handler } = getCrudToolHarness("update_product");
    const result = await handler({ id: 7, data: '{"deactivated_date":"2026-01-01"}' }) as { content: Array<{ text: string }> };
    expect(api.products.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.error).toBe("Invalid update fields");
  });

  it("update_journal rejects status without mutating", async () => {
    const { api, handler } = getCrudToolHarness("update_journal");
    const result = await handler({ id: 7, data: '{"status":"CONFIRMED"}' }) as { content: Array<{ text: string }> };
    expect(api.journals.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.details[0]).toMatch(/"status".*confirm_journal/);
  });

  it("update_sale_invoice rejects registered without mutating", async () => {
    const { api, handler } = getCrudToolHarness("update_sale_invoice");
    const result = await handler({ id: 7, data: '{"registered":true}' }) as { content: Array<{ text: string }> };
    expect(api.saleInvoices.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.details[0]).toMatch(/"registered".*confirm_sale_invoice/);
  });

  it("update_purchase_invoice rejects payment_status without mutating", async () => {
    const { api, handler } = getCrudToolHarness("update_purchase_invoice");
    const result = await handler({ id: 7, data: '{"payment_status":"PAID"}' }) as { content: Array<{ text: string }> };
    expect(api.purchaseInvoices.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.details[0]).toMatch(/"payment_status"/);
  });

  it("update_client with empty object reports 'provide at least one field'", async () => {
    const { api, handler } = getCrudToolHarness("update_client");
    const result = await handler({ id: 7, data: "{}" }) as { content: Array<{ text: string }> };
    expect(api.clients.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.details[0]).toMatch(/at least one field/);
  });

  it("update_client passes through an allowed field", async () => {
    const { api, handler } = getCrudToolHarness("update_client", {
      clients: { update: vi.fn().mockResolvedValue({ code: 1, messages: ["ok"] }) },
    });
    await handler({ id: 7, data: '{"email":"new@example.com"}' });
    expect(api.clients.update).toHaveBeenCalledWith(7, { email: "new@example.com" });
  });
});

describe("update_* post-confirmation audit lock", () => {
  it("update_journal rejects effective_date on a registered journal", async () => {
    const { api, handler } = getCrudToolHarness("update_journal", {
      journals: {
        get: vi.fn().mockResolvedValue({ id: 7, registered: true }),
        update: vi.fn(),
      },
    });
    const result = await handler({ id: 7, data: '{"effective_date":"2026-05-01"}' }) as { content: Array<{ text: string }> };
    expect(api.journals.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.details[0]).toMatch(/"effective_date".*CONFIRMED journal.*invalidate_journal/);
  });

  it("update_journal allows effective_date on an unregistered (draft) journal", async () => {
    const { api, handler } = getCrudToolHarness("update_journal", {
      journals: {
        get: vi.fn().mockResolvedValue({ id: 7, registered: false }),
        update: vi.fn().mockResolvedValue({ code: 1, messages: ["ok"] }),
      },
    });
    await handler({ id: 7, data: '{"effective_date":"2026-05-01"}' });
    expect(api.journals.update).toHaveBeenCalledWith(7, { effective_date: "2026-05-01" });
  });

  it("update_sale_invoice rejects create_date on a CONFIRMED invoice", async () => {
    const { api, handler } = getCrudToolHarness("update_sale_invoice", {
      saleInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "CONFIRMED" }),
        update: vi.fn(),
      },
    });
    const result = await handler({ id: 7, data: '{"create_date":"2026-05-01"}' }) as { content: Array<{ text: string }> };
    expect(api.saleInvoices.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.details[0]).toMatch(/"create_date".*CONFIRMED sale_invoice.*invalidate_sale_invoice/);
  });

  it("update_sale_invoice allows create_date on a PROJECT invoice", async () => {
    const { api, handler } = getCrudToolHarness("update_sale_invoice", {
      saleInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }),
        update: vi.fn().mockResolvedValue({ code: 1, messages: ["ok"] }),
      },
    });
    await handler({ id: 7, data: '{"create_date":"2026-05-01"}' });
    expect(api.saleInvoices.update).toHaveBeenCalledWith(7, { create_date: "2026-05-01" });
  });

  it("update_purchase_invoice rejects journal_date on a CONFIRMED invoice", async () => {
    const { api, handler } = getCrudToolHarness("update_purchase_invoice", {
      purchaseInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "CONFIRMED" }),
        update: vi.fn(),
      },
    });
    const result = await handler({ id: 7, data: '{"journal_date":"2026-05-01"}' }) as { content: Array<{ text: string }> };
    expect(api.purchaseInvoices.update).not.toHaveBeenCalled();
    const body = parseMcpResponse(result.content[0]!.text) as { error: string; details: string[] };
    expect(body.details[0]).toMatch(/"journal_date".*CONFIRMED purchase_invoice.*invalidate_purchase_invoice/);
  });

  it("update_purchase_invoice re-sends existing items when the caller omits them (PATCH requires items)", async () => {
    const existingItems = [{ custom_title: "Item A", total_net_price: 100 }];
    const updateMock = vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" });
    const { handler } = getCrudToolHarness("update_purchase_invoice", {
      purchaseInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT", items: existingItems }),
        update: updateMock,
      },
    });

    await handler({ id: 7, data: '{"notes":"updated note"}' });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const patch = updateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.notes).toBe("updated note");
    expect(patch.items).toEqual(existingItems);
  });

  it("update_purchase_invoice keeps caller-supplied items when provided", async () => {
    const callerItems = [{ custom_title: "New line", total_net_price: 50 }];
    const updateMock = vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" });
    const { handler } = getCrudToolHarness("update_purchase_invoice", {
      purchaseInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT", items: [{ custom_title: "Old", total_net_price: 1 }] }),
        update: updateMock,
      },
    });

    await handler({ id: 7, data: { items: callerItems } });

    const patch = updateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.items).toEqual(callerItems);
  });
});

describe("H04 confirmed accounting record update boundaries", () => {
  it.each([
    { entity: "journal" as const, field: "postings", value: [{ accounts_id: 4000, type: "D", amount: 10 }] },
    { entity: "journal" as const, field: "effective_date", value: "2026-07-15" },
    { entity: "journal" as const, field: "document_number", value: "DOC-7" },
    { entity: "journal" as const, field: "clients_id", value: 17 },
    { entity: "journal" as const, field: "is_deleted", value: true },
    { entity: "journal" as const, field: "registered", value: true },
    { entity: "journal" as const, field: "status", value: "CONFIRMED" },
    { entity: "purchase_invoice" as const, field: "items", value: [{ custom_title: "Hosting", total_net_price: 10 }] },
    { entity: "purchase_invoice" as const, field: "gross_price", value: 12.2 },
    { entity: "purchase_invoice" as const, field: "clients_id", value: 17 },
    { entity: "purchase_invoice" as const, field: "liability_accounts_id", value: 2310 },
    { entity: "purchase_invoice" as const, field: "is_deleted", value: true },
    { entity: "purchase_invoice" as const, field: "status", value: "CONFIRMED" },
    { entity: "purchase_invoice" as const, field: "registered", value: true },
    { entity: "purchase_invoice" as const, field: "payment_status", value: "PAID" },
    { entity: "sale_invoice" as const, field: "items", value: [{ products_id: 1, custom_title: "Service", amount: 1 }] },
    { entity: "sale_invoice" as const, field: "gross_price", value: 122 },
    { entity: "sale_invoice" as const, field: "clients_id", value: 17 },
    { entity: "sale_invoice" as const, field: "receivable_accounts_id", value: 1300 },
    { entity: "sale_invoice" as const, field: "is_deleted", value: true },
    { entity: "sale_invoice" as const, field: "status", value: "CONFIRMED" },
    { entity: "sale_invoice" as const, field: "registered", value: true },
    { entity: "sale_invoice" as const, field: "payment_status", value: "PAID" },
  ])("H04 validator rejects $entity field $field on confirmed records", ({ entity, field, value }) => {
    const errors = validateUpdateFields({ [field]: value }, entity, { isConfirmed: true });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`\"${field}\"`);
    expect(errors[0]).toContain(`invalidate_${entity}`);
  });

  it.each([
    { entity: "journal" as const, field: "title", value: "Corrected description" },
    { entity: "purchase_invoice" as const, field: "notes", value: "Internal note" },
    { entity: "sale_invoice" as const, field: "notes", value: "Internal note" },
    { entity: "sale_invoice" as const, field: "invoice_info", value: "Shown on invoice" },
    { entity: "sale_invoice" as const, field: "payment_description", value: "Use reference number" },
    { entity: "sale_invoice" as const, field: "additional_info_content", value: "Additional terms" },
  ])("H04 validator allows confirmed metadata $entity field $field", ({ entity, field, value }) => {
    expect(validateUpdateFields({ [field]: value }, entity, { isConfirmed: true })).toEqual([]);
  });

  it("H04 confirmed journal rejects postings with classified recovery guidance and no update", async () => {
    const { api, handler } = getCrudToolHarness("update_journal", {
      journals: { get: vi.fn().mockResolvedValue({ id: 7, registered: true }) },
    });

    const result = await handler({
      id: 7,
      data: { postings: [{ accounts_id: 4000, type: "D", amount: 10 }] },
    }) as { content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(api.journals.update).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      error: "Confirmed journal update contains ledger-bearing fields",
      category: "confirmed_record_immutable",
      next_action: "invalidate_journal, fetch the draft, update it, then explicitly re-confirm",
    });
    expect(body.details).toEqual([expect.stringContaining("invalidate_journal")]);
  });

  it("H04 confirmed purchase invoice rejects caller items unchanged before transport completion", async () => {
    const callerItems = [{ custom_title: "Replacement line", total_net_price: 50 }];
    const originalItems = callerItems.map(item => ({ ...item }));
    const { api, handler } = getCrudToolHarness("update_purchase_invoice", {
      purchaseInvoices: {
        get: vi.fn().mockResolvedValue({
          id: 7,
          status: "CONFIRMED",
          items: [{ custom_title: "Current line", total_net_price: 10 }],
        }),
      },
    });

    const result = await handler({ id: 7, data: { items: callerItems } }) as { content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(callerItems).toEqual(originalItems);
    expect(api.purchaseInvoices.update).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      error: "Confirmed purchase_invoice update contains ledger-bearing fields",
      category: "confirmed_record_immutable",
      next_action: "invalidate_purchase_invoice, fetch the draft, update it, then explicitly re-confirm",
    });
    expect(body.details).toEqual([expect.stringContaining("invalidate_purchase_invoice")]);
  });

  it("H04 confirmed sale invoice rejects items with classified recovery guidance and no update", async () => {
    const { api, handler } = getCrudToolHarness("update_sale_invoice", {
      saleInvoices: { get: vi.fn().mockResolvedValue({ id: 7, status: "CONFIRMED" }) },
    });

    const result = await handler({
      id: 7,
      data: { items: [{ products_id: 1, custom_title: "Service", amount: 1 }] },
    }) as { content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(api.saleInvoices.update).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      error: "Confirmed sale_invoice update contains ledger-bearing fields",
      category: "confirmed_record_immutable",
      next_action: "invalidate_sale_invoice, fetch the draft, update it, then explicitly re-confirm",
    });
    expect(body.details).toEqual([expect.stringContaining("invalidate_sale_invoice")]);
  });

  it("H04 confirmed journal forwards title metadata exactly", async () => {
    const { api, handler } = getCrudToolHarness("update_journal", {
      journals: {
        get: vi.fn().mockResolvedValue({ id: 7, registered: true }),
        update: vi.fn().mockResolvedValue({ id: 7, registered: true }),
      },
    });

    await handler({ id: 7, data: { title: "Corrected description" } });

    expect(api.journals.update).toHaveBeenCalledWith(7, { title: "Corrected description" });
  });

  it("H04 confirmed purchase notes clone the current item array and every item object", async () => {
    const currentItems = [
      { custom_title: "Hosting", total_net_price: 10 },
      { custom_title: "Support", total_net_price: 20 },
    ];
    const update = vi.fn().mockResolvedValue({ id: 7, status: "CONFIRMED" });
    const { handler } = getCrudToolHarness("update_purchase_invoice", {
      purchaseInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "CONFIRMED", items: currentItems }),
        update,
      },
    });

    await handler({ id: 7, data: { notes: "Internal note" } });

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0]![1] as { notes: string; items: Array<Record<string, unknown>> };
    expect(patch).toEqual({ notes: "Internal note", items: currentItems });
    expect(patch.items).not.toBe(currentItems);
    patch.items.forEach((item, index) => expect(item).not.toBe(currentItems[index]));
  });

  it("H04 confirmed sale invoice forwards the complete allowed metadata patch", async () => {
    const patch = {
      notes: "Internal note",
      invoice_info: "Shown on invoice",
      payment_description: "Use reference number",
      additional_info_content: "Additional terms",
    };
    const { api, handler } = getCrudToolHarness("update_sale_invoice", {
      saleInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "CONFIRMED" }),
        update: vi.fn().mockResolvedValue({ id: 7, status: "CONFIRMED" }),
      },
    });

    await handler({ id: 7, data: patch });

    expect(api.saleInvoices.update).toHaveBeenCalledWith(7, patch);
  });

  it("H04 draft journal blocked registered field retains Invalid update fields", async () => {
    const { api, handler } = getCrudToolHarness("update_journal", {
      journals: { get: vi.fn().mockResolvedValue({ id: 7, registered: false }) },
    });

    const result = await handler({ id: 7, data: { registered: true } }) as { content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(api.journals.update).not.toHaveBeenCalled();
    expect(body.error).toBe("Invalid update fields");
    expect(body).not.toHaveProperty("category", "confirmed_record_immutable");
  });

  it("H04 draft purchase invoice blocked payment status retains Invalid update fields", async () => {
    const { api, handler } = getCrudToolHarness("update_purchase_invoice", {
      purchaseInvoices: { get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }) },
    });

    const result = await handler({ id: 7, data: { payment_status: "PAID" } }) as { content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(api.purchaseInvoices.update).not.toHaveBeenCalled();
    expect(body.error).toBe("Invalid update fields");
    expect(body).not.toHaveProperty("category", "confirmed_record_immutable");
  });

  it("H04 draft sale invoice blocked status retains Invalid update fields", async () => {
    const { api, handler } = getCrudToolHarness("update_sale_invoice", {
      saleInvoices: { get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }) },
    });

    const result = await handler({ id: 7, data: { status: "CONFIRMED" } }) as { content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(api.saleInvoices.update).not.toHaveBeenCalled();
    expect(body.error).toBe("Invalid update fields");
    expect(body).not.toHaveProperty("category", "confirmed_record_immutable");
  });

  it("H04 draft journal forwards effective date and postings exactly", async () => {
    const patch = {
      effective_date: "2026-07-15",
      postings: [{ accounts_id: 4000, type: "D", amount: 10 }],
    };
    const { api, handler } = getCrudToolHarness("update_journal", {
      journals: {
        get: vi.fn().mockResolvedValue({ id: 7, registered: false }),
        update: vi.fn().mockResolvedValue({ id: 7, registered: false }),
      },
    });

    await handler({ id: 7, data: patch });

    expect(api.journals.update).toHaveBeenCalledWith(7, patch);
  });

  it("H04 draft purchase invoice forwards journal date and caller items exactly", async () => {
    const patch = {
      journal_date: "2026-07-15",
      items: [{ custom_title: "Hosting", total_net_price: 10 }],
    };
    const { api, handler } = getCrudToolHarness("update_purchase_invoice", {
      purchaseInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT", items: [{ custom_title: "Old" }] }),
        update: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }),
      },
    });

    await handler({ id: 7, data: patch });

    expect(api.purchaseInvoices.update).toHaveBeenCalledWith(7, patch);
  });

  it("H04 draft sale invoice forwards journal date and items exactly", async () => {
    const patch = {
      journal_date: "2026-07-15",
      items: [{ products_id: 1, custom_title: "Service", amount: 1 }],
    };
    const { api, handler } = getCrudToolHarness("update_sale_invoice", {
      saleInvoices: {
        get: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }),
        update: vi.fn().mockResolvedValue({ id: 7, status: "PROJECT" }),
      },
    });

    await handler({ id: 7, data: patch });

    expect(api.saleInvoices.update).toHaveBeenCalledWith(7, patch);
  });
});

const h05Approval = {
  invoice_id: 7,
  is_vat_registered: true,
  current_vat_price: 23.99,
  current_gross_price: 123.99,
  proposed_vat_price: 24,
  proposed_gross_price: 124,
  correction_required: true,
  approval_digest: "a".repeat(64),
};

describe("H05 correction tool inventory and workflow", () => {
  beforeEach(() => vi.mocked(logAudit).mockClear());

  it("registers one read-only preview and keeps confirmation destructive", () => {
    const server = { registerTool: vi.fn() };
    const api = {
      clients: {}, products: {}, journals: {}, transactions: {}, saleInvoices: {},
      purchaseInvoices: {}, readonly: {},
    };
    registerCrudTools(server as never, api as never);

    const preview = server.registerTool.mock.calls.filter(([name]) => name === "preview_purchase_invoice_totals_correction");
    const confirm = server.registerTool.mock.calls.filter(([name]) => name === "confirm_purchase_invoice");
    expect(preview).toHaveLength(1);
    expect(preview[0]![1]).toMatchObject({
      title: "Preview Purchase Invoice Totals Correction",
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(confirm).toHaveLength(1);
    expect(confirm[0]![1]).toMatchObject({ annotations: { destructiveHint: true, readOnlyHint: false } });
  });

  it("previews without mutation or audit and returns the exact approval snapshot", async () => {
    const previewTotalsCorrection = vi.fn().mockResolvedValue(h05Approval);
    const { api, handler } = getCrudToolHarness("preview_purchase_invoice_totals_correction", {
      purchaseInvoices: { previewTotalsCorrection },
    });

    const result = await handler({ id: 7 }) as { content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(previewTotalsCorrection).toHaveBeenCalledWith(7, true);
    expect(api.purchaseInvoices.update).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      action: "previewed",
      entity: "purchase_invoice",
      id: 7,
      raw: h05Approval,
      next_actions: [expect.stringContaining("confirm_purchase_invoice")],
    });
  });

  it("default confirmation uses two arguments and retains the empty audit details", async () => {
    const { api, handler } = getCrudToolHarness("confirm_purchase_invoice");

    await handler({ id: 7 });

    expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledWith(7, true);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "confirm_purchase_invoice",
      action: "CONFIRMED",
      entity_id: 7,
      details: {},
    }));
  });

  it.each([
    ["missing approval", { id: 7, recalculate_totals: true }],
    ["approval without flag", { id: 7, approved_correction: h05Approval }],
  ])("rejects %s before API calls or audit", async (_label, args) => {
    const { api, handler } = getCrudToolHarness("confirm_purchase_invoice");

    const result = await handler(args) as { isError?: boolean; content: Array<{ text: string }> };
    const body = parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      category: "purchase_invoice_totals_correction",
      code: "correction_preview_required",
    });
    expect(api.purchaseInvoices.previewTotalsCorrection).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("forwards exact approved correction and records only the digest", async () => {
    const { api, handler } = getCrudToolHarness("confirm_purchase_invoice");

    await handler({ id: 7, recalculate_totals: true, approved_correction: h05Approval });

    expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledWith(7, true, {
      recalculateTotals: true,
      approvedCorrection: h05Approval,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: { recalculate_totals: true, approval_digest: h05Approval.approval_digest },
    }));
  });

  it.each([
    {
      label: "PROJECT to CONFIRMED",
      drift: { status: "CONFIRMED" },
      code: "correction_invoice_not_project",
      error: "Purchase invoice totals correction requires a PROJECT draft.",
      nextAction: "Fetch the invoice; if it is confirmed, invalidate it explicitly, then request and approve a new correction preview.",
    },
    {
      label: "EUR to USD",
      drift: { cl_currencies_id: "USD" },
      code: "correction_currency_not_supported",
      error: "Automatic purchase invoice totals correction supports EUR invoices only.",
      nextAction: "Review the currency and base totals manually; do not use automatic totals correction.",
    },
  ] as const)("real public preview/apply rejects fresh $label drift without PATCH or audit", async ({ drift, code, error, nextAction }) => {
    const initialInvoice = {
      id: 7,
      clients_id: 10,
      client_name: "Supplier OÜ",
      number: "PI-7",
      create_date: "2026-03-01",
      journal_date: "2026-03-01",
      term_days: 0,
      status: "PROJECT",
      cl_currencies_id: "EUR",
      net_price: 100,
      vat_price: 23.99,
      gross_price: 123.99,
      currency_rate: 1,
      base_net_price: 100,
      base_vat_price: 23.99,
      base_gross_price: 123.99,
      items: [{
        id: 11,
        custom_title: "Consulting",
        purchase_accounts_id: 5230,
        amount: 1,
        total_net_price: 100,
        vat_amount: 24,
        vat_rate_dropdown: "24",
      }],
    };
    const get = vi.fn()
      .mockResolvedValueOnce(initialInvoice)
      .mockResolvedValueOnce({ ...initialInvoice, ...drift });
    const patch = vi.fn().mockResolvedValue({ code: 200, messages: [] });
    const purchaseInvoices = new PurchaseInvoicesApi({
      cacheNamespace: `h05-public-${code}`,
      get,
      patch,
    } as never);
    const server = { registerTool: vi.fn() };
    registerPurchaseInvoiceTools(server as never, {
      purchaseInvoices,
      readonly: { getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }) },
    } as never);
    const previewRegistration = server.registerTool.mock.calls.find(([name]) =>
      name === "preview_purchase_invoice_totals_correction");
    const confirmRegistration = server.registerTool.mock.calls.find(([name]) =>
      name === "confirm_purchase_invoice");
    if (!previewRegistration || !confirmRegistration) throw new Error("H05 correction tools were not registered");
    const previewHandler = previewRegistration[2] as (args: { id: number }) => Promise<{
      content: Array<{ text: string }>;
    }>;
    const confirmHandler = confirmRegistration[2] as (args: Record<string, unknown>) => Promise<{
      isError?: boolean;
      content: Array<{ text: string }>;
    }>;

    const previewResult = await previewHandler({ id: 7 });
    const previewBody = parseMcpResponse(previewResult.content[0]!.text) as { raw: typeof h05Approval };
    expect(previewBody.raw).toMatchObject({
      invoice_id: 7,
      approval_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const confirmResult = await confirmHandler({
      id: 7,
      recalculate_totals: true,
      approved_correction: previewBody.raw,
    });

    expect(confirmResult.isError).toBe(true);
    expect(parseMcpResponse(confirmResult.content[0]!.text)).toEqual({
      category: "purchase_invoice_totals_correction",
      code,
      error,
      next_action: nextAction,
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "/purchase_invoices/7");
    expect(get).toHaveBeenNthCalledWith(2, "/purchase_invoices/7");
    expect(patch).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON string", JSON.stringify(h05Approval)],
    ["extra field", { ...h05Approval, extra: true }],
    ["missing field", (({ proposed_vat_price: _missing, ...rest }) => rest)(h05Approval)],
    ["wrong type", { ...h05Approval, invoice_id: "7" }],
    ["non-finite", { ...h05Approval, proposed_vat_price: Number.POSITIVE_INFINITY }],
    ["malformed digest", { ...h05Approval, approval_digest: "xyz" }],
  ])("strict schema rejects %s approval", (_label, approved_correction) => {
    const { options } = getCrudToolHarness("confirm_purchase_invoice");
    const schema = z.object(options.inputSchema as z.ZodRawShape);

    expect(schema.safeParse({ id: 7, recalculate_totals: true, approved_correction }).success).toBe(false);
  });

  const correctionErrors: Array<[
    PurchaseInvoiceTotalsCorrectionCode,
    string,
    string,
  ]> = [
    ["correction_invoice_not_project", "Purchase invoice totals correction requires a PROJECT draft.", "Fetch the invoice; if it is confirmed, invalidate it explicitly, then request and approve a new correction preview."],
    ["correction_currency_not_supported", "Automatic purchase invoice totals correction supports EUR invoices only.", "Review the currency and base totals manually; do not use automatic totals correction."],
    ["correction_reverse_charge_not_supported", "Automatic totals correction is disabled for reverse-charge purchase invoices.", "Review and preserve the reverse-charge totals manually, then confirm without recalculation only after approval."],
    ["correction_items_missing", "Purchase invoice totals correction requires at least one item.", "Add or repair the invoice items, then request and approve a new correction preview."],
    ["correction_preview_required", "An exact approved purchase invoice totals correction preview is required.", "Call preview_purchase_invoice_totals_correction, obtain approval, and resubmit that preview unchanged."],
    ["correction_preview_mismatch", "The approved purchase invoice totals correction preview no longer matches fresh invoice state.", "Call preview_purchase_invoice_totals_correction again and obtain approval for the new snapshot."],
  ];

  it.each(correctionErrors)("preview maps %s to the exact domain error", async (code, error, nextAction) => {
    const { handler } = getCrudToolHarness("preview_purchase_invoice_totals_correction", {
      purchaseInvoices: {
        previewTotalsCorrection: vi.fn().mockRejectedValue(new PurchaseInvoiceTotalsCorrectionError(code)),
      },
    });

    const result = await handler({ id: 7 }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text)).toEqual({
      category: "purchase_invoice_totals_correction",
      code,
      error,
      next_action: nextAction,
    });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each(correctionErrors)("confirmation maps %s to the exact domain error", async (code, error, nextAction) => {
    const { handler } = getCrudToolHarness("confirm_purchase_invoice", {
      purchaseInvoices: {
        confirmWithTotals: vi.fn().mockRejectedValue(new PurchaseInvoiceTotalsCorrectionError(code)),
      },
    });

    const result = await handler({ id: 7 }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(parseMcpResponse(result.content[0]!.text)).toEqual({
      category: "purchase_invoice_totals_correction",
      code,
      error,
      next_action: nextAction,
    });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["preview_purchase_invoice_totals_correction", "previewTotalsCorrection"],
    ["confirm_purchase_invoice", "confirmWithTotals"],
  ])("%s rethrows non-domain transport errors", async (toolName, method) => {
    const { handler } = getCrudToolHarness(toolName, {
      purchaseInvoices: { [method]: vi.fn().mockRejectedValue(new Error("transport failed")) },
    });

    await expect(handler({ id: 7 })).rejects.toThrow("transport failed");
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("D01 external-text sandboxing at CRUD read boundaries", () => {
  const crudRenderCases = [
    ["client", "clients", "list_clients", "get_client", { id: 7, name: "Injected client" }],
    ["product", "products", "list_products", "get_product", { id: 7, name: "Injected product" }],
    ["journal", "journals", "list_journals", "get_journal", { id: 7, title: "Injected journal", postings: [] }],
    ["transaction", "transactions", "list_transactions", "get_transaction", { id: 7, description: "Injected transaction", bank_account_name: "Injected party" }],
    ["sale_invoice", "saleInvoices", "list_sale_invoices", "get_sale_invoice", { id: 7, client_name: "Injected buyer", items: [{ custom_title: "Injected line" }] }],
    ["purchase_invoice", "purchaseInvoices", "list_purchase_invoices", "get_purchase_invoice", { id: 7, client_name: "Injected supplier", items: [{ custom_title: "Injected line" }] }],
  ] as const;

  it.each(crudRenderCases)("sandboxes %s list and get output", async (_entity, apiKey, listTool, getTool, source) => {
    const listApi = { list: vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [source] }) };
    const listHarness = getCrudToolHarness(listTool, { [apiKey]: listApi } as never);
    const list = await listHarness.handler({ page: 1, view: "full" }) as { content: Array<{ text: string }> };
    const getHarness = getCrudToolHarness(getTool, { [apiKey]: { get: vi.fn().mockResolvedValue(source) } } as never);
    const get = await getHarness.handler({ id: 7 }) as { content: Array<{ text: string }> };
    expect(JSON.stringify(parseMcpResponse(list.content[0]!.text))).toContain("UNTRUSTED_OCR_START:");
    expect(JSON.stringify(parseMcpResponse(get.content[0]!.text))).toContain("UNTRUSTED_OCR_START:");
  });

  it("sandboxes search_client and find_client_by_code raw client records without mutating them", async () => {
    const searchSource = { id: 7, name: "Injected supplier", code: "12345678" };
    const foundSource = { id: 8, name: "Injected found", code: "87654321" };
    const search = getCrudToolHarness("search_client", { clients: { findByName: vi.fn().mockResolvedValue([searchSource]) } });
    const found = getCrudToolHarness("find_client_by_code", { clients: { findByCode: vi.fn().mockResolvedValue(foundSource) } });
    const searchPayload = parseMcpResponse(((await search.handler({ name: "supplier" })) as { content: Array<{ text: string }> }).content[0]!.text) as { raw: Array<{ name: string; code: string }> };
    const foundPayload = parseMcpResponse(((await found.handler({ code: "87654321" })) as { content: Array<{ text: string }> }).content[0]!.text) as { raw: { name: string; code: string } };
    expect(searchPayload.raw[0]!.name).toContain("UNTRUSTED_OCR_START:");
    expect(foundPayload.raw.name).toContain("UNTRUSTED_OCR_START:");
    // structured registry code stays raw; source objects unmutated
    expect(foundPayload.raw.code).toBe("87654321");
    expect(searchSource.name).toBe("Injected supplier");
    expect(foundSource.name).toBe("Injected found");
  });
});

describe("D01 external-text stripping at CRUD write boundaries", () => {
  const marker = (s: string) => `<<UNTRUSTED_OCR_START:deadbeef>>\n${s}\n<<UNTRUSTED_OCR_END:deadbeef>>`;

  it("strips sandbox markers from create_client name before API and audit", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 5 });
    const { handler } = getCrudToolHarness("create_client", { clients: { create } });
    await handler({ name: marker("Acme OÜ"), is_client: true, is_supplier: false, is_physical_entity: false, code: "12345678" });
    const arg = create.mock.calls[0]![0] as { name: string };
    expect(arg.name).toBe("Acme OÜ");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.not.stringContaining("UNTRUSTED_OCR"),
    }));
  });

  it("strips sandbox markers from update_client data.name before API", async () => {
    const update = vi.fn().mockResolvedValue({ code: 200, messages: [] });
    const { handler } = getCrudToolHarness("update_client", { clients: { update } });
    await handler({ id: 3, data: JSON.stringify({ name: marker("New Name") }) });
    const arg = update.mock.calls[0]![1] as { name: string };
    expect(arg.name).toBe("New Name");
  });

  it("strips sandbox markers from create_transaction description and bank_account_name", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 9 });
    const { handler } = getCrudToolHarness("create_transaction", { transactions: { create } });
    await handler({ accounts_dimensions_id: 1, type: "D", amount: 10, date: "2026-07-17", description: marker("PAYMENT"), bank_account_name: marker("Bob") });
    const arg = create.mock.calls[0]![0] as { description: string; bank_account_name: string; type: string };
    expect(arg.description).toBe("PAYMENT");
    expect(arg.bank_account_name).toBe("Bob");
    expect(arg.type).toBe("C");
  });

  it("strips sandbox markers from update_transaction data fields before API", async () => {
    const update = vi.fn().mockResolvedValue({ code: 200, messages: [] });
    const { handler } = getCrudToolHarness("update_transaction", { transactions: { update } });
    await handler({ id: 4, data: JSON.stringify({ description: marker("desc"), bank_account_name: marker("party") }) });
    const arg = update.mock.calls[0]![1] as { description: string; bank_account_name: string };
    expect(arg.description).toBe("desc");
    expect(arg.bank_account_name).toBe("party");
  });

  it("strips sandbox markers from create_purchase_invoice client_name and item custom_title", async () => {
    const createAndSetTotals = vi.fn().mockResolvedValue({ id: 12 });
    const { handler } = getCrudToolHarness("create_purchase_invoice", {
      readonly: {
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getPurchaseArticles: vi.fn().mockResolvedValue([{ id: 45, name_est: "X", name_eng: "X", vat_accounts_id: 1510, cl_vat_articles_id: 1, vat_rate_dropdown: "24" }]),
        getAccounts: vi.fn().mockResolvedValue([{ id: 1510, name_est: "X", allows_dimensions: false, is_valid: true }]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: { createAndSetTotals },
    });
    await handler({
      ...purchaseInvoiceCreateParams([{ cl_purchase_articles_id: 45, custom_title: marker("Widget"), total_net_price: 100 }]),
      client_name: marker("Supplier OÜ"),
    });
    const arg = createAndSetTotals.mock.calls[0]![0] as { client_name: string; items: Array<{ custom_title: string }> };
    expect(arg.client_name).toBe("Supplier OÜ");
    expect(arg.items[0]!.custom_title).toBe("Widget");
  });

  it("strips sandbox markers from search_client name before matching", async () => {
    const findByName = vi.fn().mockResolvedValue([]);
    const { handler } = getCrudToolHarness("search_client", { clients: { findByName } });
    await handler({ name: marker("Acme") });
    expect(findByName).toHaveBeenCalledWith("Acme");
  });

  // F-MUTATION-BOUNDARY-CANONICAL: the write boundary now strips markers from
  // EVERY field, not only the D01-scoped ones, so a wrapped value round-tripped
  // into any create/update field can never persist a marker.
  it("strips markers from a NON-scoped create_client field (notes)", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 7 });
    const { handler } = getCrudToolHarness("create_client", { clients: { create } });
    await handler({ name: "Clean OÜ", notes: marker("hidden note"), is_client: true, is_supplier: false, is_physical_entity: false, code: "12345678" });
    const arg = create.mock.calls[0]![0] as { notes: string };
    expect(arg.notes).toBe("hidden note");
  });

  it("strips markers from NON-scoped create_journal fields (title, document_number)", async () => {
    const create = vi.fn().mockResolvedValue({ code: 0, messages: [], created_object_id: 77 });
    const { handler } = getCrudToolHarness("create_journal", {
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{ id: 4000, account_code: "4000", allows_dimensions: false, is_valid: true }]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      journals: { create },
    });
    await handler({
      effective_date: "2026-04-24",
      title: marker("Monthly close"),
      document_number: marker("DOC-1"),
      postings: [{ accounts_id: 4000, type: "D", amount: 10 }],
    });
    const arg = create.mock.calls[0]![0] as { title: string; document_number: string };
    expect(arg.title).toBe("Monthly close");
    expect(arg.document_number).toBe("DOC-1");
  });

  it("strips markers from NON-scoped create_purchase_invoice fields (number, notes)", async () => {
    const createAndSetTotals = vi.fn().mockResolvedValue({ id: 13 });
    const { handler } = getCrudToolHarness("create_purchase_invoice", {
      readonly: {
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getPurchaseArticles: vi.fn().mockResolvedValue([{ id: 45, name_est: "X", name_eng: "X", vat_accounts_id: 1510, cl_vat_articles_id: 1, vat_rate_dropdown: "24" }]),
        getAccounts: vi.fn().mockResolvedValue([{ id: 1510, name_est: "X", allows_dimensions: false, is_valid: true }]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: { createAndSetTotals },
    });
    await handler({
      ...purchaseInvoiceCreateParams([{ cl_purchase_articles_id: 45, custom_title: "Widget", total_net_price: 100 }]),
      client_name: "Supplier OÜ",
      number: marker("INV-9"),
      notes: marker("secret note"),
    });
    const arg = createAndSetTotals.mock.calls[0]![0] as { number: string; notes: string };
    expect(arg.number).toBe("INV-9");
    expect(arg.notes).not.toContain("UNTRUSTED_OCR");
    expect(arg.notes).toContain("secret note");
  });

  it("cleanly unwraps a wrapped item title even when items arrives as a JSON string (parse-then-clean, no framing newlines left)", async () => {
    // Regression guard: stripping the items JSON STRING before parse would remove
    // only the marker tokens and leave the wrapper's framing newlines inside the
    // title ("\nWidget\n"). Parsing first, then deep-cleaning, recovers "Widget".
    const createAndSetTotals = vi.fn().mockResolvedValue({ id: 14 });
    const { handler } = getCrudToolHarness("create_purchase_invoice", {
      readonly: {
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getPurchaseArticles: vi.fn().mockResolvedValue([{ id: 45, name_est: "X", name_eng: "X", vat_accounts_id: 1510, cl_vat_articles_id: 1, vat_rate_dropdown: "24" }]),
        getAccounts: vi.fn().mockResolvedValue([{ id: 1510, name_est: "X", allows_dimensions: false, is_valid: true }]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: { createAndSetTotals },
    });
    await handler({
      ...purchaseInvoiceCreateParams([]),
      items: JSON.stringify([{ cl_purchase_articles_id: 45, custom_title: marker("Widget"), total_net_price: 100 }]),
    });
    const arg = createAndSetTotals.mock.calls[0]![0] as { items: Array<{ custom_title: string }> };
    expect(arg.items[0]!.custom_title).toBe("Widget");
  });
});
