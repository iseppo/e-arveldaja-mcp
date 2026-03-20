import { describe, expect, it, vi } from "vitest";
import { registerRecurringInvoiceTools } from "./recurring-invoices.js";

function buildSaleInvoice() {
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
  };
}

function setupRecurringTool() {
  const server = { registerTool: vi.fn() } as any;
  const fullInvoice = buildSaleInvoice();
  const api = {
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue([fullInvoice]),
      get: vi.fn().mockResolvedValue(fullInvoice),
      create: vi.fn().mockResolvedValue({ created_object_id: 321 }),
      confirm: vi.fn().mockResolvedValue({}),
    },
  } as any;

  registerRecurringInvoiceTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === "create_recurring_sale_invoices");
  if (!registration) throw new Error("Tool was not registered");

  return {
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

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.mode).toBe("EXECUTED");
    expect(payload.created).toBe(1);
    expect(api.saleInvoices.create).toHaveBeenCalledTimes(1);
  });

  it("supports explicit preview mode without creating invoices", async () => {
    const { api, handler } = setupRecurringTool();

    const result = await handler({
      source_month: "2026-01",
      target_date: "2026-02-01",
      target_journal_date: "2026-02-01",
      dry_run: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.mode).toBe("DRY_RUN");
    expect(payload.would_create).toBe(1);
    expect(api.saleInvoices.create).not.toHaveBeenCalled();
  });
});
