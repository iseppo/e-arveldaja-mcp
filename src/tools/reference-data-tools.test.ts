import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

import { registerReferenceDataTools } from "./reference-data-tools.js";
import { logAudit } from "../audit-log.js";

describe("registerReferenceDataTools", () => {
  it("keeps the public reference-data tool surface registered", () => {
    const server = { registerTool: vi.fn() };
    const api = {
      readonly: {},
    };

    registerReferenceDataTools(server as never, api as never);

    expect(server.registerTool.mock.calls.map(([name]) => name)).toEqual([
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
});

function makeReadonly() {
  return {
    updateInvoiceInfo: vi.fn().mockResolvedValue({ code: 200 }),
    getInvoiceSeriesOne: vi.fn().mockResolvedValue({ id: 3, number_prefix: "2026-" }),
    updateInvoiceSeries: vi.fn().mockResolvedValue({ code: 200 }),
    deleteInvoiceSeries: vi.fn().mockResolvedValue({ code: 200 }),
    getBankAccount: vi.fn().mockResolvedValue({ id: 5, account_name_est: "LHV" }),
    updateBankAccount: vi.fn().mockResolvedValue({ code: 200 }),
    deleteBankAccount: vi.fn().mockResolvedValue({ code: 200 }),
  };
}

function register(readonly: ReturnType<typeof makeReadonly>): Record<string, (args: any) => Promise<any>> {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = { registerTool: vi.fn((name: string, _config: unknown, cb: any) => { handlers[name] = cb; }) };
  registerReferenceDataTools(server as never, { readonly } as never);
  return handlers;
}

describe("reference-data edit tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("update_invoice_info forwards only the set fields and audits the changed keys", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    await handlers.update_invoice_info({ email: "billing@x.ee", phone: undefined, address: "Tartu mnt 1" });

    expect(readonly.updateInvoiceInfo).toHaveBeenCalledWith({ email: "billing@x.ee", address: "Tartu mnt 1" });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "update_invoice_info", action: "UPDATED", entity_type: "invoice_info",
      details: { fields: ["email", "address"] },
    }));
  });

  it("update_invoice_info forwards fax and preserves an explicit null (clear) for invoice_company_name", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    await handlers.update_invoice_info({ fax: "+372 600 0000", invoice_company_name: null });

    // null is a meaningful value (clear the field) — pruneUndefined must keep it.
    expect(readonly.updateInvoiceInfo).toHaveBeenCalledWith({ fax: "+372 600 0000", invoice_company_name: null });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "update_invoice_info", action: "UPDATED", entity_type: "invoice_info",
      details: { fields: ["fax", "invoice_company_name"] },
    }));
  });

  it("update_invoice_info rejects an empty patch without calling the API", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    const res = await handlers.update_invoice_info({});

    expect(readonly.updateInvoiceInfo).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("at least one");
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("get_invoice_series fetches a single series by id", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    const res = await handlers.get_invoice_series({ id: 3 }) as { content: Array<{ text: string }> };

    expect(readonly.getInvoiceSeriesOne).toHaveBeenCalledWith(3);
    expect(res.content[0]!.text).toContain("2026-");
  });

  it("get_bank_account fetches a single bank account by id", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    const res = await handlers.get_bank_account({ id: 5 }) as { content: Array<{ text: string }> };

    expect(readonly.getBankAccount).toHaveBeenCalledWith(5);
    expect(res.content[0]!.text).toContain("LHV");
  });

  it("update_invoice_series patches by id and audits with the entity id", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    await handlers.update_invoice_series({ id: 7, number_prefix: "2026-", is_default: true });

    expect(readonly.updateInvoiceSeries).toHaveBeenCalledWith(7, { number_prefix: "2026-", is_default: true });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "update_invoice_series", action: "UPDATED", entity_type: "invoice_series", entity_id: 7,
    }));
  });

  it("update_invoice_series rejects an id-only call (no fields to change)", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    const res = await handlers.update_invoice_series({ id: 7 });

    expect(readonly.updateInvoiceSeries).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("at least one");
  });

  it("delete_invoice_series deletes by id and audits DELETED", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    await handlers.delete_invoice_series({ id: 3 });

    expect(readonly.deleteInvoiceSeries).toHaveBeenCalledWith(3);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "delete_invoice_series", action: "DELETED", entity_type: "invoice_series", entity_id: 3,
    }));
  });

  it("update_bank_account patches by id and prunes undefined fields", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    await handlers.update_bank_account({ id: 5, account_name_est: "LHV", swift_code: undefined, show_in_sale_invoices: false });

    expect(readonly.updateBankAccount).toHaveBeenCalledWith(5, { account_name_est: "LHV", show_in_sale_invoices: false });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "update_bank_account", action: "UPDATED", entity_type: "bank_account", entity_id: 5,
    }));
  });

  it("update_bank_account rejects an id-only call", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    const res = await handlers.update_bank_account({ id: 5 });

    expect(readonly.updateBankAccount).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("at least one");
  });

  it("delete_bank_account deletes by id and audits DELETED", async () => {
    const readonly = makeReadonly();
    const handlers = register(readonly);

    await handlers.delete_bank_account({ id: 9 });

    expect(readonly.deleteBankAccount).toHaveBeenCalledWith(9);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "delete_bank_account", action: "DELETED", entity_type: "bank_account", entity_id: 9,
    }));
  });
});
