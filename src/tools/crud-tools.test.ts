import { describe, it, expect, vi } from "vitest";
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
} from "./crud-tools.js";
import { parseMcpResponse } from "../mcp-json.js";

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
      ...overrides?.purchaseInvoices,
    },
  };
  const server = { registerTool: vi.fn() };

  registerCrudTools(server as never, api as never);

  const call = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!call) throw new Error(`${toolName} tool was not registered`);

  return {
    api,
    options: call[1] as { inputSchema?: Record<string, unknown> },
    handler: call[2] as (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
  };
}

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
      code: 1,
      messages: ["ok"],
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
});
