import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerPurchaseInvoiceTools } from "./crud/purchase-invoices.js";
import { limitedVatStore } from "../company-vat-status.js";
import { fakeEarveldaja, resetApiCaches } from "../__fixtures__/nondeductible-vat.js";
import { computeEffectiveBooking } from "../documents/operations.js";
import { computeOwnerExpenseJournalProjection } from "./estonian-tax.js";
import { createAccountingWorkflowApi } from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { withSignedCamtMarker } from "../__fixtures__/camt-marker.js";
import { createClassificationOperations } from "../receipts/classification-operations.js";
import * as receiptInbox from "./receipt-inbox.js";
import { prepareReceiptInvoiceItems } from "./receipt-inbox-booking.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import type { ToolResponseEnvelopeOptions } from "../tool-response.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "purchase-historical-vat-"));
  vi.stubEnv("EARVELDAJA_RULES_DIR", join(directory, "rules"));
  limitedVatStore.reset();
  limitedVatStore.upsert([{
    kind: "status", key: "company_vat_status", status: "full", vat_number: "EE123456789",
    effective_from: "2026-11-01", set_at: "2026-11-06T09:00:00Z",
  }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetApiCaches();
  vi.unstubAllEnvs();
  limitedVatStore.reset();
  rmSync(directory, { recursive: true, force: true });
});

function harness(tool: string, date = "2026-10-31") {
  const createAndSetTotals = vi.fn().mockResolvedValue({ id: 1 });
  const confirmWithTotals = vi.fn().mockResolvedValue({ code: 200 });
  const draft = { id: 1, status: "PROJECT", create_date: date, journal_date: date, items: [] };
  const api = {
    readonly: {
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      getPurchaseArticles: vi.fn().mockResolvedValue([]),
      getAccounts: vi.fn().mockResolvedValue([
        { id: 5000, is_valid: true, is_vat_account: false, allows_dimensions: false },
        { id: 1510, is_valid: true, is_vat_account: true, allows_dimensions: false },
        { id: 2110, is_valid: true, is_vat_account: false, allows_dimensions: false },
      ]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
    },
    purchaseInvoices: {
      createAndSetTotals, confirmWithTotals,
      get: vi.fn().mockResolvedValue(draft), invalidateListCache: vi.fn(),
    },
  };
  const server = { registerTool: vi.fn() };
  registerPurchaseInvoiceTools(server as never, api as never);
  const registered = server.registerTool.mock.calls.find(([name]) => name === tool)!;
  const handler = registered[2] as (args: Record<string, unknown>) => Promise<CallToolResult>;
  return { api, handler, createAndSetTotals, confirmWithTotals };
}

const purchase = {
  clients_id: 1, client_name: "Cleaning OÜ", number: "OCT-31", create_date: "2026-10-31",
  journal_date: "2026-10-31", term_days: 14, vat_price: 24, gross_price: 124,
  items: [{ cl_purchase_articles_id: 1, purchase_accounts_id: 5000, custom_title: "October cleaning", total_net_price: 100, amount: 1, vat_rate_dropdown: "24" }],
};

describe("T5 historical purchase VAT review", () => {
  it("holds a pre-registration purchase before automatically applying input VAT", async () => {
    const { handler, createAndSetTotals } = harness("create_purchase_invoice");
    const result = await handler(purchase);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("purchase_vat_historical_review_required");
    expect(JSON.stringify(result)).toContain("2026-11-01");
    expect(createAndSetTotals).not.toHaveBeenCalled();
  });

  it("holds an existing pre-registration draft before registration", async () => {
    const { handler, confirmWithTotals } = harness("confirm_purchase_invoice");
    const result = await handler({ id: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("purchase_vat_historical_review_required");
    expect(confirmWithTotals).not.toHaveBeenCalled();
  });

  it("holds the shared document booking path before selecting deductible VAT defaults", async () => {
    const { api } = harness("create_purchase_invoice");
    const documentApi = { ...api, clients: {
      get: vi.fn().mockResolvedValue({ id: 1, name: "Cleaning OÜ" }),
      // Own-company record (VAT-derived registry code) so the own-company veto can run.
      listAll: vi.fn().mockResolvedValue([{ id: 1, name: "Cleaning OÜ", code: "10000001" }, { id: 2, name: "Own OÜ", code: "12345678", invoice_vat_no: "EE123456789" }]),
    } };
    await expect(computeEffectiveBooking(documentApi as never, {
      supplierClientId: 1, invoiceNumber: "OCT-31", invoiceDate: "2026-10-31", journalDate: "2026-10-31",
      termDays: 14, items: purchase.items,
    }, "a".repeat(64), "cleaning.pdf")).rejects.toMatchObject({ code: "purchase_vat_historical_review_required" });
    expect(api.readonly.getPurchaseArticles).not.toHaveBeenCalled();
  });

  it("holds automatic input-VAT deduction for an owner-paid pre-registration expense", async () => {
    const { api } = harness("create_purchase_invoice");
    await expect(computeOwnerExpenseJournalProjection(api as never, {
      owner_client_id: 1, effective_date: "2026-10-31", description: "October cleaning",
      net_amount: 100, vat_rate: 0.24, expense_account: 5000,
    })).rejects.toMatchObject({ code: "purchase_vat_historical_review_required" });
  });

  it("holds classification before supplier resolution can create a client", async () => {
    const transaction = withSignedCamtMarker({ id: 42, type: "C", status: "PROJECT", amount: 25,
      date: "2026-10-31", cl_currencies_id: "EUR", accounts_dimensions_id: 100, bank_account_name: "New supplier", description: "Service" }, "DBIT");
    const api = createAccountingWorkflowApi({ allowWrites: true, transactionRows: [transaction], transactionDetails: { 42: transaction },
      accountDimensions: [{ id: 100, accounts_id: 1020, is_deleted: false }],
      accounts: [{ id: 5000, name_est: "Kulud", account_type_est: "Kulud" }],
      purchaseArticles: [{ id: 501, accounts_id: 5000, name_est: "Service", vat_accounts_id: 1510, cl_vat_articles_id: 1 }],
    });
    vi.spyOn(receiptInbox, "resolveSupplierFromTransaction").mockImplementation(async (_api, _clients, _tx, execute) => {
      if (execute) await api.clients.create({ name: "New supplier" });
      return { found: true, created: execute, client: { id: 7, name: "New supplier" } as never };
    });
    const operations = createClassificationOperations(api as never, createTestRuntimeSafetyContext(), value => value ?? undefined);
    const groups = [{ category: "bank_fees", apply_mode: "purchase_invoice", normalized_counterparty: "new supplier",
      display_counterparty: "New supplier", recurring: false, similar_amounts: false, total_amount: 25,
      suggested_booking: { purchase_article_id: 501, purchase_account_id: 5000, liability_account_id: 2310, reason: "Service" },
      reasons: [], transactions: [transaction] }];
    const preview = await operations.applyClassifications({ classificationsJson: { groups } });
    if (!preview.ok || !preview.value.planHandle) throw new Error("Missing classification preview");
    const outcome = await operations.applyClassifications({ classificationsJson: { groups }, execute: true, planHandle: preview.value.planHandle });
    expect(JSON.stringify(outcome)).toContain("purchase_vat_historical_review_required");
    expect(api.clients.create).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
  });

  it("holds the batch's pure booking check before supplier creation and VAT defaults", () => {
    const result = prepareReceiptInvoiceItems({ isVatRegistered: true, fullVatRegistrationFrom: "2026-11-01", purchaseArticlesWithVat: [] },
      { invoice_date: "2026-10-31", total_net: 100, total_vat: 24, total_gross: 124 } as never,
      { item: purchase.items[0] } as never, "October cleaning");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("purchase_vat_historical_review_required");
  });

  it("keeps invoices on and after registration on the ordinary VAT route", async () => {
    const { handler, createAndSetTotals } = harness("create_purchase_invoice", "2026-11-01");
    const result = await handler({ ...purchase, create_date: "2026-11-01", journal_date: "2026-11-01" });
    expect(result.isError).not.toBe(true);
    expect(createAndSetTotals).toHaveBeenCalledWith(expect.anything(), 24, 124, true, expect.anything());
  });

  it.each([false, true])("creates and registers only the reviewed historical treatment (deduction=%s)", async approved => {
    const fake = fakeEarveldaja({ vatNumber: "EE123456789" });
    const server = { registerTool: vi.fn() };
    registerPurchaseInvoiceTools(server as never, fake as never);
    const handler = (name: string) => server.registerTool.mock.calls.find(([tool]) => tool === name)![2] as (args: Record<string, unknown>) => Promise<CallToolResult>;
    const result = await handler("create_purchase_invoice")({
      ...purchase, pre_registration_vat_deduction_approved: approved,
      items: [{ ...purchase.items[0], purchase_accounts_id: 6000,
        vat_accounts_id: approved ? 1510 : 6000, cl_vat_articles_id: approved ? 1 : 11 }],
    });
    expect(result.isError).not.toBe(true);
    const id = [...fake.state.invoices.keys()][0]!;
    const held = await handler("confirm_purchase_invoice")({ id });
    expect(held.isError).toBe(true);
    expect(fake.registers()).toHaveLength(0);
    const confirmed = await handler("confirm_purchase_invoice")({ id, pre_registration_vat_deduction_approved: approved });
    expect(confirmed.isError).not.toBe(true);
    expect(fake.registers()).toHaveLength(1);
    expect(fake.state.invoices.get(id)?.items[0].vat_accounts_id).toBe(approved ? 1510 : 6000);
  });

  it("refuses a deductible historical draft when the owner reviewed it as non-deductible", async () => {
    const fake = fakeEarveldaja({ vatNumber: "EE123456789" });
    const id = fake.seed({ create_date: "2026-10-31", journal_date: "2026-10-31", vat_price: 24, gross_price: 124 }, [
      { ...purchase.items[0], purchase_accounts_id: 6000, vat_accounts_id: 1510, cl_vat_articles_id: 1 },
    ]);
    const server = { registerTool: vi.fn() };
    registerPurchaseInvoiceTools(server as never, fake as never);
    const handler = server.registerTool.mock.calls.find(([name]) => name === "confirm_purchase_invoice")![2] as (args: Record<string, unknown>) => Promise<CallToolResult>;
    const result = await handler({ id, pre_registration_vat_deduction_approved: false });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("correction_nonvat_form_unproven");
    expect(fake.writes()).toHaveLength(0);
  });

  it("confirms the unchanged approved totals correction for a historical non-deductible draft", async () => {
    const fake = fakeEarveldaja({ vatNumber: "EE123456789" });
    const id = fake.seed({ create_date: "2026-10-31", journal_date: "2026-10-31", vat_price: 0, gross_price: 123 }, [{
      custom_title: "October cleaning", purchase_accounts_id: 6000, amount: 1,
      total_net_price: 124, project_no_vat_gross_price: 124, vat_rate_dropdown: "-", cl_vat_articles_id: 11,
    }]);
    const server = { registerTool: vi.fn() };
    registerPurchaseInvoiceTools(server as never, fake as never);
    const handler = (name: string) => server.registerTool.mock.calls.find(([tool]) => tool === name)![2] as (args: Record<string, unknown>) => Promise<CallToolResult>;
    const preview = await handler("preview_purchase_invoice_totals_correction")({
      id, pre_registration_vat_deduction_approved: false,
    });
    expect(preview.isError).not.toBe(true);
    const content = preview.content[0];
    if (content?.type !== "text") throw new Error("Missing correction preview");
    const body = parseToolPayload<ToolResponseEnvelopeOptions>(content.text);
    expect(fake.writes()).toHaveLength(0);

    const confirmed = await handler("confirm_purchase_invoice")({
      id, recalculate_totals: true, approved_correction: body.raw,
      pre_registration_vat_deduction_approved: false,
    });
    expect(confirmed.isError, JSON.stringify(confirmed)).not.toBe(true);
    expect(body.raw).toMatchObject({
      is_vat_registered: false, current_gross_price: 123, proposed_gross_price: 124,
      proposed_vat_price: 0, correction_required: true,
    });
    expect(fake.totalsPatches()).toHaveLength(1);
    expect(fake.registers()).toHaveLength(1);
    expect(fake.state.invoices.get(id)).toMatchObject({ status: "CONFIRMED", vat_price: 0, gross_price: 124 });
  });

  it("checks the fresh invoice date before previewing a correction without historical review", async () => {
    const fake = fakeEarveldaja({ vatNumber: "EE123456789" });
    const id = fake.seed({ create_date: "2026-11-01", journal_date: "2026-11-01", vat_price: 0, gross_price: 123 }, [{
      custom_title: "Cleaning", purchase_accounts_id: 6000, amount: 1,
      total_net_price: 124, project_no_vat_gross_price: 124, vat_rate_dropdown: "-", cl_vat_articles_id: 11,
    }]);
    await fake.purchaseInvoices.get(id); // Warm the cache with a post-registration date.
    fake.state.invoices.get(id)!.create_date = "2026-10-31";
    const server = { registerTool: vi.fn() };
    registerPurchaseInvoiceTools(server as never, fake as never);
    const handler = server.registerTool.mock.calls.find(([name]) => name === "preview_purchase_invoice_totals_correction")![2] as (args: Record<string, unknown>) => Promise<CallToolResult>;

    const result = await handler({ id });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("purchase_vat_historical_review_required");
    expect(fake.writes()).toHaveLength(0);
  });
});
