import { describe, expect, it, vi } from "vitest";
import { scanPurchaseIntakeDuplicates, withPurchaseInvoiceLock } from "./purchase-invoice-lock.js";

const apiFor = (connectionFingerprint: string) => ({ purchaseInvoices: { connectionFingerprint, invalidateListCache: vi.fn(), listAll: vi.fn().mockResolvedValue([]) } }) as any;

describe("purchase intake FIFO", () => {
  it("queues in order, releases after rejection, and lets another connection run", async () => {
    const api = apiFor("fifo-test"), other = apiFor("other-test");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const a = withPurchaseInvoiceLock(api, async () => { order.push("A"); await gate; });
    const b = withPurchaseInvoiceLock(api, async () => { order.push("B"); throw new Error("B failed"); });
    const caught = b.catch(e => e.message);
    const c = withPurchaseInvoiceLock(api, async () => { order.push("C"); });
    await withPurchaseInvoiceLock(other, async () => { order.push("other"); });
    expect(order).toEqual(["A", "other"]);
    release(); await a; expect(await caught).toBe("B failed"); await c;
    expect(order).toEqual(["A", "other", "B", "C"]);
  });

  it("uses the existing blank-number currency/amount/date fallback without a number override", async () => {
    const api = apiFor("blank-number");
    api.purchaseInvoices.listAll.mockResolvedValue([
      { id: 1, clients_id: 4242, number: "", gross_price: 124, create_date: "2026-03-15", cl_currencies_id: "EUR", status: "PROJECT" },
      { id: 2, clients_id: 4242, number: "", gross_price: 124, create_date: "2026-03-15", cl_currencies_id: "USD", status: "PROJECT" },
      { id: 3, clients_id: 4242, number: "", gross_price: 124, create_date: "2026-03-15", cl_currencies_id: "EUR", status: "DELETED" },
    ]);
    const result = await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: " ", grossPrice: 124, invoiceDate: "2026-03-15", currency: "EUR" });
    expect(result).toEqual({ kind: "amount_date", invoiceIds: [1] });
    expect(api.purchaseInvoices.invalidateListCache).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])("blank-number supplied gross %s is unavailable comparison, not an empty scan", async (grossPrice) => {
    const api = apiFor("missing-comparison");
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: " ", grossPrice: grossPrice as any, invoiceDate: "2026-03-15", currency: "EUR" }))
      .toEqual({ kind: "amount_date", invoiceIds: [], comparisonUnavailable: ["gross_price"] });
    expect(api.purchaseInvoices.listAll).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "2026-02-31", "2026-3-15"])("blank-number date %s refuses an unavailable date comparison", async (invoiceDate) => {
    const api = apiFor("missing-date");
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "", grossPrice: 124, invoiceDate, currency: "EUR" }))
      .toEqual({ kind: "amount_date", invoiceIds: [], comparisonUnavailable: ["invoice_date"] });
  });

  it("a different non-blank number with the same supplier, gross and near date is an other-number match", async () => {
    const api = apiFor("other-number");
    api.purchaseInvoices.listAll.mockResolvedValue([
      { id: 11, clients_id: 4242, number: "INV-1O23", gross_price: 124, create_date: "2026-03-12", cl_currencies_id: "EUR", status: "CONFIRMED" },
      { id: 12, clients_id: 4242, number: "INV-1O23", gross_price: 124, create_date: "2026-03-12", cl_currencies_id: "USD", status: "CONFIRMED" },
      { id: 13, clients_id: 4242, number: "INV-0999", gross_price: 124, create_date: "2026-02-12", cl_currencies_id: "EUR", status: "CONFIRMED" },
      { id: 14, clients_id: 9999, number: "INV-1O23", gross_price: 124, create_date: "2026-03-12", cl_currencies_id: "EUR", status: "CONFIRMED" },
    ]);
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "INV-1023", grossPrice: 124, invoiceDate: "2026-03-15", currency: "EUR" }))
      .toEqual({ kind: "amount_date_other_number", invoiceIds: [11] });
  });

  it("an AUTO- placeholder number never takes the other-number amount/date match", async () => {
    const api = apiFor("auto-number");
    api.purchaseInvoices.listAll.mockResolvedValue([
      { id: 11, clients_id: 4242, number: "INV-1O23", gross_price: 124, create_date: "2026-03-15", cl_currencies_id: "EUR", status: "CONFIRMED" },
    ]);
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "AUTO-TX-5", grossPrice: 124, invoiceDate: "2026-03-15", currency: "EUR" }))
      .toEqual({ kind: "number", invoiceIds: [] });
  });

  it("an existing AUTO- placeholder invoice never takes the other-number amount/date match", async () => {
    const api = apiFor("auto-existing");
    api.purchaseInvoices.listAll.mockResolvedValue([
      { id: 11, clients_id: 4242, number: "AUTO-TX-5", gross_price: 124, create_date: "2026-03-15", cl_currencies_id: "EUR", status: "CONFIRMED" },
    ]);
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "INV-1023", grossPrice: 124, invoiceDate: "2026-03-15", currency: "EUR" }))
      .toEqual({ kind: "number", invoiceIds: [] });
  });

  it("a signed credit-note gross takes the other-number match", async () => {
    const api = apiFor("credit-note");
    api.purchaseInvoices.listAll.mockResolvedValue([
      { id: 15, clients_id: 4242, number: "KR-1O", gross_price: -124, create_date: "2026-03-15", cl_currencies_id: "EUR", status: "CONFIRMED" },
    ]);
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "KR-10", grossPrice: -124, invoiceDate: "2026-03-15", currency: "EUR" }))
      .toEqual({ kind: "amount_date_other_number", invoiceIds: [15] });
  });

  it("a numbered scan derives the comparison gross when none was supplied, and holds when neither is available", async () => {
    const api = apiFor("derived-gross");
    api.purchaseInvoices.listAll.mockResolvedValue([
      { id: 11, clients_id: 4242, number: "INV-1O23", gross_price: 124, create_date: "2026-03-15", cl_currencies_id: "EUR", status: "CONFIRMED" },
    ]);
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "INV-1023", derivedGrossPrice: 124, invoiceDate: "2026-03-15", currency: "EUR" }))
      .toEqual({ kind: "amount_date_other_number", invoiceIds: [11] });
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "INV-1023", invoiceDate: "2026-03-15", currency: "EUR" }))
      .toEqual({ kind: "amount_date_other_number", invoiceIds: [], comparisonUnavailable: ["gross_price"] });
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: "INV-1023", grossPrice: 124, invoiceDate: "2026-3-15", currency: "EUR" }))
      .toEqual({ kind: "amount_date_other_number", invoiceIds: [], comparisonUnavailable: ["invoice_date"] });
  });

  it("nonblank exact-number scans do not require amount/date comparison inputs", async () => {
    const api = apiFor("number-only");
    api.purchaseInvoices.listAll.mockResolvedValue([{ id: 9, clients_id: 4242, number: "A-17", status: "PROJECT" }]);
    expect(await scanPurchaseIntakeDuplicates(api, { supplierClientId: 4242, invoiceNumber: " A-17 " }))
      .toEqual({ kind: "number", invoiceIds: [9] });
  });
});
