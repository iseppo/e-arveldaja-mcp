import { describe, expect, it, vi } from "vitest";
import { PurchaseInvoicesApi } from "./purchase-invoices.api.js";

describe("PurchaseInvoicesApi.confirmWithTotals", () => {
  it("preserves explicit invoice totals when requested", async () => {
    const get = vi.fn().mockResolvedValue({
      id: 1,
      clients_id: 10,
      client_name: "OpenAI Ireland Limited",
      number: "PI-1",
      create_date: "2026-03-01",
      journal_date: "2026-03-01",
      term_days: 0,
      cl_currencies_id: "EUR",
      gross_price: 100,
      vat_price: 0,
      items: [{
        custom_title: "ChatGPT subscription",
        total_net_price: 100,
        vat_amount: 24,
        reversed_vat_id: 1,
      }],
    });
    const patch = vi.fn().mockResolvedValue({ code: 200, messages: [] });

    const api = new PurchaseInvoicesApi({
      cacheNamespace: "test",
      get,
      patch,
    } as any);

    await api.confirmWithTotals(1, true, { preserveExistingTotals: true });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/purchase_invoices/1/register", {});
  });
});
