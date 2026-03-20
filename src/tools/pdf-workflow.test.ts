import { describe, expect, it, vi } from "vitest";
import { registerPdfWorkflowTools } from "./pdf-workflow.js";

function setupSuggestBookingTool() {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([
        {
          id: 1,
          clients_id: 7,
          status: "CONFIRMED",
          create_date: "2026-02-15",
        },
      ]),
      get: vi.fn().mockResolvedValue({
        id: 1,
        number: "PI-1",
        create_date: "2026-02-15",
        gross_price: 124,
        liability_accounts_id: 2310,
        items: [{
          custom_title: "Internet subscription",
          cl_purchase_articles_id: 45,
          purchase_accounts_id: 5230,
          total_net_price: 100,
          vat_rate_dropdown: "24",
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          reversed_vat_id: null,
        }],
      }),
    },
  } as any;

  registerPdfWorkflowTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === "suggest_booking");
  if (!registration) {
    throw new Error("Tool was not registered");
  }

  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("suggest_booking", () => {
  it("returns purchase account and VAT metadata from similar invoices", async () => {
    const handler = setupSuggestBookingTool();

    const result = await handler({
      clients_id: 7,
      description: "internet",
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.supplier_id).toBe(7);
    expect(payload.suggestion).toContain("VAT settings");
    expect(payload.past_invoices).toHaveLength(1);
    expect(payload.past_invoices[0]!.items).toEqual([
      expect.objectContaining({
        custom_title: "Internet subscription",
        cl_purchase_articles_id: 45,
        purchase_accounts_id: 5230,
        vat_rate_dropdown: "24",
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        reversed_vat_id: null,
      }),
    ]);
  });
});
