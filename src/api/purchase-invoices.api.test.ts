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

describe("PurchaseInvoicesApi.createAndSetTotals", () => {
  it("invalidates the created invoice when follow-up totals repair fails", async () => {
    const post = vi.fn().mockResolvedValue({ code: 200, created_object_id: 17, messages: [] });
    const get = vi.fn().mockResolvedValue({
      id: 17,
      items: [{
        total_net_price: 100,
        vat_amount: 24,
      }],
    });
    const patch = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/purchase_invoices/17") {
        throw new Error("patch failed");
      }
      if (path === "/purchase_invoices/17/invalidate") {
        return { code: 200, messages: [] };
      }
      throw new Error(`Unexpected PATCH ${path}`);
    });

    const api = new PurchaseInvoicesApi({
      cacheNamespace: "test",
      post,
      get,
      patch,
    } as any);

    await expect(api.createAndSetTotals({
      clients_id: 10,
      client_name: "OpenAI Ireland Limited",
      number: "PI-17",
      create_date: "2026-03-01",
      journal_date: "2026-03-01",
      term_days: 0,
      cl_currencies_id: "EUR",
      liability_accounts_id: 2310,
      items: [{
        custom_title: "ChatGPT subscription",
        amount: 1,
        total_net_price: 100,
      }],
    }, 24, 124, true)).rejects.toThrow(
      "Purchase invoice 17 was created but follow-up failed and the draft was invalidated: patch failed"
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/purchase_invoices/17/invalidate", {});
  });
});
