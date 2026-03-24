import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerRecurringInvoiceTools } from "./recurring-invoices.js";
import { parseMcpResponse } from "../mcp-json.js";

function buildSaleInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "CONFIRMED",
    create_date: "2026-01-15",
    number: "SI-1",
    sale_invoice_type: "INVOICE",
    cl_templates_id: 10,
    clients_id: 20,
    client_name: "Acme OU",
    cl_countries_id: "EST",
    number_prefix: "ARV",
    term_days: 14,
    cl_currencies_id: "EUR",
    show_client_balance: false,
    receivable_accounts_id: 1200,
    intra_community_supply: false,
    client_vat_no: "EE123456789",
    notes: "Original internal note",
    items: [{
      products_id: 99,
      cl_sale_articles_id: 5,
      sale_accounts_id: 3000,
      sale_accounts_dimensions_id: 4000,
      custom_title: "Monthly service",
      amount: 1,
      unit: "tk",
      unit_net_price: 100,
      total_net_price: 100,
      vat_accounts_id: 1510,
      vat_rate: 24,
      discount_percent: 0,
      discount_amount: 0,
      projects_project_id: null,
      projects_location_id: null,
      projects_person_id: null,
    }],
    ...overrides,
  };
}

function setupRecurringTool(options: {
  listAllInvoices?: unknown[];
  createImpl?: ReturnType<typeof vi.fn>;
  confirmImpl?: ReturnType<typeof vi.fn>;
} = {}) {
  const server = { registerTool: vi.fn() } as any;
  const fullInvoice = buildSaleInvoice();
  const api = {
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.listAllInvoices ?? [fullInvoice]),
      get: vi.fn().mockResolvedValue(fullInvoice),
      create: options.createImpl ?? vi.fn().mockResolvedValue({ created_object_id: 321 }),
      confirm: options.confirmImpl ?? vi.fn().mockResolvedValue({}),
    },
  } as any;

  registerRecurringInvoiceTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === "create_recurring_sale_invoices");
  if (!registration) throw new Error("Tool was not registered");

  return {
    server,
    api,
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("recurring invoices tool", () => {
  it("creates invoices by default when dry_run is omitted", async () => {
    const { api, handler } = setupRecurringTool();

    const result = await handler({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
    });

    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.created).toBe(1);
    expect(api.saleInvoices.create).toHaveBeenCalledTimes(1);
    expect(api.saleInvoices.create).toHaveBeenCalledWith(expect.objectContaining({
      notes: expect.stringContaining("RECURRING_SOURCE_INVOICE:1:TARGET_DATE:2026-02-01"),
    }));
  });

  it("supports explicit preview mode without creating invoices", async () => {
    const { api, handler } = setupRecurringTool();

    const result = await handler({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
      dry_run: true,
    });

    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.mode).toBe("DRY_RUN");
    expect(payload.would_create).toBe(1);
    expect(api.saleInvoices.create).not.toHaveBeenCalled();
  });

  it("registers a schema that validates month/date formats and invoice_ids", () => {
    const { server } = setupRecurringTool();
    const registration = server.registerTool.mock.calls.find(([name]) => name === "create_recurring_sale_invoices");
    if (!registration) throw new Error("Tool was not registered");

    const schema = z.object(registration[1].inputSchema);

    expect(schema.safeParse({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
      invoice_ids: "1, 2,3",
    }).success).toBe(true);

    expect(schema.safeParse({
      source_month: "2026-1",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
    }).success).toBe(false);

    expect(schema.safeParse({
      source_month: "2026-01",
      target_date: "2026/02/01",
      target_journal_date: "2026-02-01",
    }).success).toBe(false);

    expect(schema.safeParse({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
      invoice_ids: "1, nope, 3",
    }).success).toBe(false);
  });

  it("skips an already cloned target invoice instead of creating a duplicate", async () => {
    const sourceInvoice = buildSaleInvoice();
    const existingClone = buildSaleInvoice({
      id: 99,
      status: "DRAFT",
      create_date: "2026-02-01",
      number: "ARV-99",
      notes: "RECURRING_SOURCE_INVOICE:1:TARGET_DATE:2026-02-01",
    });
    const { api, handler } = setupRecurringTool({
      listAllInvoices: [sourceInvoice, existingClone],
    });

    const result = await handler({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
    });

    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.created).toBe(0);
    expect(payload.skipped_existing).toBe(1);
    expect(payload.results).toEqual([
      expect.objectContaining({
        source_id: 1,
        existing_id: 99,
        existing_number: "ARV-99",
        status: "skipped_existing",
      }),
    ]);
    expect(api.saleInvoices.create).not.toHaveBeenCalled();
  });

  it("reports auto-confirm failures as errors instead of success-only results", async () => {
    const { handler } = setupRecurringTool({
      confirmImpl: vi.fn().mockRejectedValue(new Error("Confirm failed")),
    });

    const result = await handler({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
      auto_confirm: true,
    });

    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.created).toBe(1);
    expect(payload.confirmed).toBe(0);
    expect(payload.errors).toBe(1);
    expect(payload.confirm_errors).toBe(1);
    expect(payload.results).toEqual([
      expect.objectContaining({
        status: "confirm_error",
        confirm_error: "Confirm failed",
      }),
    ]);
  });

  it("reports an error instead of silently skipping source invoices without items", async () => {
    const sourceWithoutItems = buildSaleInvoice({ items: [] });
    const { api, handler } = setupRecurringTool({
      listAllInvoices: [sourceWithoutItems],
    });
    api.saleInvoices.get.mockResolvedValue(sourceWithoutItems);

    const result = await handler({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
    });

    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.created).toBe(0);
    expect(payload.errors).toBe(1);
    expect(payload.results).toEqual([
      expect.objectContaining({
        source_id: 1,
        status: "error",
        error: "Source invoice has no items to clone",
      }),
    ]);
    expect(api.saleInvoices.create).not.toHaveBeenCalled();
  });
});
