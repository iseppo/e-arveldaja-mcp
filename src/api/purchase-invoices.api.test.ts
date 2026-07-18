import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseInvoicesApi } from "./purchase-invoices.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

function makeClient(namespace = "connection:0"): HttpClient {
  return {
    cacheNamespace: namespace,
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
    delete: vi.fn(),
  } as unknown as HttpClient;
}

describe("PurchaseInvoicesApi.confirm (cross-cache invalidation)", () => {
  beforeEach(() => cache.invalidate());

  it("busts /journals and /transactions caches when confirming", async () => {
    const client = makeClient();
    const api = new PurchaseInvoicesApi(client);
    cache.set("connection:0:/journals:list:page=1", { stale: true });
    cache.set("connection:0:/transactions:list:page=1", { stale: true });
    cache.set("connection:0:/purchase_invoices:list:page=1", { stale: true });

    await api.confirm(99);

    expect(cache.get("connection:0:/journals:list:page=1")).toBeUndefined();
    expect(cache.get("connection:0:/transactions:list:page=1")).toBeUndefined();
    expect(cache.get("connection:0:/purchase_invoices:list:page=1")).toBeUndefined();
  });
});

describe("PurchaseInvoicesApi.invalidate (cross-cache invalidation)", () => {
  beforeEach(() => cache.invalidate());

  it("busts /journals and /transactions caches when invalidating", async () => {
    const client = makeClient();
    const api = new PurchaseInvoicesApi(client);
    cache.set("connection:0:/journals:list:page=1", { stale: true });
    cache.set("connection:0:/transactions:list:page=1", { stale: true });
    cache.set("connection:0:/purchase_invoices:99", { stale: true });

    await api.invalidate(99);

    expect(cache.get("connection:0:/journals:list:page=1")).toBeUndefined();
    expect(cache.get("connection:0:/transactions:list:page=1")).toBeUndefined();
    expect(cache.get("connection:0:/purchase_invoices:99")).toBeUndefined();
  });
});

function h05Invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    clients_id: 10,
    client_name: "Supplier OÜ",
    number: "PI-1",
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
    ...overrides,
  };
}

function h05Api(get: ReturnType<typeof vi.fn>) {
  const patch = vi.fn().mockResolvedValue({ code: 200, messages: [] });
  const api = new PurchaseInvoicesApi({
    cacheNamespace: "h05",
    get,
    patch,
  } as any);
  return { api, patch };
}

describe("H05 default preservation", () => {
  beforeEach(() => cache.invalidate());

  it.each([
    ["supplier rounding", true, h05Invoice()],
    ["missing VAT", true, h05Invoice({ vat_price: undefined })],
    ["missing gross", true, h05Invoice({ gross_price: undefined })],
    ["non-VAT item VAT", false, h05Invoice({ vat_price: 0 })],
    ["reverse charge", true, h05Invoice({ items: [{ ...h05Invoice().items[0], reversed_vat_id: 1 }] })],
    ["non-EUR", true, h05Invoice({ cl_currencies_id: "USD", currency_rate: 0.92 })],
  ])("registers %s without reading or rewriting totals", async (_label, isVatRegistered, invoice) => {
    const get = vi.fn().mockResolvedValue(invoice);
    const { api, patch } = h05Api(get);

    await api.confirmWithTotals(1, isVatRegistered as boolean);

    expect(get).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/purchase_invoices/1/register", {});
  });

  it("treats explicit recalculateTotals=false as the preserving default", async () => {
    const get = vi.fn().mockResolvedValue(h05Invoice());
    const { api, patch } = h05Api(get);

    await api.confirmWithTotals(1, true, { recalculateTotals: false });

    expect(get).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/purchase_invoices/1/register", {});
  });
});

describe("H05 correction approval", () => {
  beforeEach(() => cache.invalidate());

  it("fresh-reads after invalidation and returns an exact no-mutation preview", async () => {
    cache.set("h05:/purchase_invoices:1", h05Invoice({ vat_price: 999, gross_price: 999 }));
    cache.set("h05:/purchase_invoices:list:page=1", { stale: true });
    const get = vi.fn().mockResolvedValue(h05Invoice());
    const { api, patch } = h05Api(get);

    const preview = await api.previewTotalsCorrection(1, true);

    expect(get).toHaveBeenCalledWith("/purchase_invoices/1");
    expect(preview).toEqual({
      invoice_id: 1,
      is_vat_registered: true,
      current_vat_price: 23.99,
      current_gross_price: 123.99,
      proposed_vat_price: 24,
      proposed_gross_price: 124,
      correction_required: true,
      approval_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(patch).not.toHaveBeenCalled();
    expect(cache.get("h05:/purchase_invoices:list:page=1")).toBeUndefined();
  });

  it.each([
    ["status", h05Invoice({ status: "CONFIRMED" }), "correction_invoice_not_project"],
    ["missing items", h05Invoice({ items: [] }), "correction_items_missing"],
    ["reverse charge", h05Invoice({ items: [{ ...h05Invoice().items[0], reversed_vat_id: 2 }] }), "correction_reverse_charge_not_supported"],
    ["currency", h05Invoice({ cl_currencies_id: "USD" }), "correction_currency_not_supported"],
  ])("rejects ineligible %s without mutation", async (_label, invoice, code) => {
    const get = vi.fn().mockResolvedValue(invoice);
    const { api, patch } = h05Api(get);

    await expect(api.previewTotalsCorrection(1, true)).rejects.toMatchObject({ code });
    expect(patch).not.toHaveBeenCalled();
  });

  it("requires an approval before any correction read or mutation", async () => {
    const get = vi.fn().mockResolvedValue(h05Invoice());
    const { api, patch } = h05Api(get);

    await expect(api.confirmWithTotals(1, true, { recalculateTotals: true }))
      .rejects.toMatchObject({ code: "correction_preview_required" });

    expect(get).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects approval without explicit recalculation before any read or mutation", async () => {
    const get = vi.fn().mockResolvedValue(h05Invoice());
    const { api, patch } = h05Api(get);
    const approval = { invoice_id: 1 } as any;

    await expect(api.confirmWithTotals(1, true, { approvedCorrection: approval } as any))
      .rejects.toMatchObject({ code: "correction_preview_mismatch" });

    expect(get).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    [true, 24, 124],
    [false, 0, 124],
  ])("applies a matching approval for VAT mode %s and then registers", async (isVatRegistered, expectedVat, expectedGross) => {
    const invoice = h05Invoice();
    const get = vi.fn().mockResolvedValue(invoice);
    const { api, patch } = h05Api(get);
    const approval = await api.previewTotalsCorrection(1, isVatRegistered);

    await api.confirmWithTotals(1, isVatRegistered, {
      recalculateTotals: true,
      approvedCorrection: approval,
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenNthCalledWith(1, "/purchase_invoices/1", {
      vat_price: expectedVat,
      gross_price: expectedGross,
      items: invoice.items,
    });
    expect(patch).toHaveBeenNthCalledWith(2, "/purchase_invoices/1/register", {});
  });

  it("registers without a totals update when the approved correction is a no-op", async () => {
    const invoice = h05Invoice({ vat_price: 24, gross_price: 124 });
    const get = vi.fn().mockResolvedValue(invoice);
    const { api, patch } = h05Api(get);
    const approval = await api.previewTotalsCorrection(1, true);

    expect(approval.correction_required).toBe(false);
    await api.confirmWithTotals(1, true, { recalculateTotals: true, approvedCorrection: approval });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/purchase_invoices/1/register", {});
  });

  it.each([
    ["missing items", { items: [] }, "correction_items_missing"],
    ["reverse charge", { items: [{ ...h05Invoice().items[0], reversed_vat_id: 1 }] }, "correction_reverse_charge_not_supported"],
  ])("rechecks apply-time %s eligibility", async (_label, drift, code) => {
    const initial = h05Invoice();
    const get = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, ...drift });
    const { api, patch } = h05Api(get);
    const approval = await api.previewTotalsCorrection(1, true);

    await expect(api.confirmWithTotals(1, true, { recalculateTotals: true, approvedCorrection: approval }))
      .rejects.toMatchObject({ code });
    expect(patch).not.toHaveBeenCalled();
  });

  it("sorts object keys recursively while preserving semantic approval state", async () => {
    const first = h05Invoice();
    const reversedItem = Object.fromEntries(Object.entries(first.items[0]).reverse());
    const second = Object.fromEntries(Object.entries({ ...first, items: [reversedItem] }).reverse());
    const firstPreview = await h05Api(vi.fn().mockResolvedValue(first)).api
      .previewTotalsCorrection(1, true);
    const secondPreview = await h05Api(vi.fn().mockResolvedValue(second)).api
      .previewTotalsCorrection(1, true);

    expect(secondPreview.approval_digest).toBe(firstPreview.approval_digest);
  });

  it.each([
    ["status", { status: "CONFIRMED" }, "correction_invoice_not_project"],
    ["net_price", { net_price: 101 }, "correction_preview_mismatch"],
    ["vat_price", { vat_price: 23.98 }, "correction_preview_mismatch"],
    ["gross_price", { gross_price: 123.98 }, "correction_preview_mismatch"],
    ["currency", { cl_currencies_id: "USD" }, "correction_currency_not_supported"],
    ["currency_rate", { currency_rate: 0.99 }, "correction_preview_mismatch"],
    ["base_net_price undefined to concrete", { base_net_price: 101 }, "correction_preview_mismatch"],
    ["base_vat_price concrete to null", { base_vat_price: null }, "correction_preview_mismatch"],
    ["base_gross_price", { base_gross_price: 124 }, "correction_preview_mismatch"],
  ])("rejects fresh %s drift before mutation", async (_label, drift, code) => {
    const initial = _label === "base_net_price undefined to concrete"
      ? h05Invoice({ base_net_price: undefined })
      : h05Invoice();
    const get = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, ...drift });
    const { api, patch } = h05Api(get);
    const approval = await api.previewTotalsCorrection(1, true);

    await expect(api.confirmWithTotals(1, true, { recalculateTotals: true, approvedCorrection: approval }))
      .rejects.toMatchObject({ code });
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    ["VAT registration", false, h05Invoice()],
    ["proposed totals", true, h05Invoice({ items: [{ ...h05Invoice().items[0], total_net_price: 101, vat_amount: 24.24 }] })],
    ["non-total item field", true, h05Invoice({ items: [{ ...h05Invoice().items[0], purchase_accounts_id: 5240 }] })],
    ["item order", true, h05Invoice({ items: [
      { ...h05Invoice().items[0], id: 12, custom_title: "Second", total_net_price: 0, vat_amount: 0 },
      h05Invoice().items[0],
    ] })],
  ])("binds approval to %s", async (_label, applyVatMode, changedInvoice) => {
    const initial = _label === "item order"
      ? h05Invoice({ items: [h05Invoice().items[0], { ...h05Invoice().items[0], id: 12, custom_title: "Second", total_net_price: 0, vat_amount: 0 }] })
      : h05Invoice();
    const get = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(changedInvoice);
    const { api, patch } = h05Api(get);
    const approval = await api.previewTotalsCorrection(1, true);

    await expect(api.confirmWithTotals(1, applyVatMode as boolean, { recalculateTotals: true, approvedCorrection: approval }))
      .rejects.toMatchObject({ code: "correction_preview_mismatch" });
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    ["invoice id", { invoice_id: 2 }],
    ["VAT flag", { is_vat_registered: false }],
    ["proposed value", { proposed_gross_price: 999 }],
    ["digest", { approval_digest: "0".repeat(64) }],
    ["missing field", { current_vat_price: undefined }],
    ["extra field", { unexpected: true }],
    ["non-finite", { proposed_vat_price: Number.POSITIVE_INFINITY }],
  ])("rejects tampered approval %s", async (_label, tamper) => {
    const invoice = h05Invoice();
    const get = vi.fn().mockResolvedValue(invoice);
    const { api, patch } = h05Api(get);
    const approval = await api.previewTotalsCorrection(1, true);
    const tampered = { ...approval, ...tamper };
    if (_label === "missing field") delete tampered.current_vat_price;

    await expect(api.confirmWithTotals(1, true, { recalculateTotals: true, approvedCorrection: tampered } as any))
      .rejects.toMatchObject({ code: "correction_preview_mismatch" });
    expect(patch).not.toHaveBeenCalled();
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
