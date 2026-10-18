import { afterEach, describe, expect, it, vi } from "vitest";
import { logAudit } from "../audit-log.js";
import { parseMcpResponse } from "../mcp-json.js";
import type { PurchaseInvoiceItem } from "../types/api.js";
import type { ExtractedReceiptFields } from "./receipt-extraction.js";
import { buildExtractionConfidenceSignals } from "./receipt-inbox.js";
import {
  applyPurchaseVatDefaultsAndValidateDimensions,
  collectNonVatItemErrors,
  refuseNonVatItemsWithVatFields,
} from "./purchase-vat-defaults.js";
import { logDocumentPurchaseInvoiceAudit, uploadSourceDocumentOrInvalidate } from "./pdf-workflow.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); });

const fields = (overrides: Partial<ExtractedReceiptFields> = {}) =>
  ({ raw_text: "Supplier OÜ\nTotal 10.00", ...overrides }) as ExtractedReceiptFields;

describe("buildExtractionConfidenceSignals", () => {
  it("returns no signals for a clean extraction", () => {
    expect(buildExtractionConfidenceSignals(fields(), { minOcrConfidence: 0.95 })).toEqual({});
  });

  it("flags parser OCR quality: partial failure and confidence strictly below the threshold", () => {
    expect(buildExtractionConfidenceSignals(fields(), { partialOcrFailure: true, minOcrConfidence: 0.59 }))
      .toEqual({ partial_ocr_failure: true, low_ocr_confidence: true });
    expect(buildExtractionConfidenceSignals(fields(), { minOcrConfidence: 0.6 })).toEqual({});
    expect(buildExtractionConfidenceSignals(fields(), { minOcrConfidence: undefined })).toEqual({});
  });

  it("flags buyer-own VAT / registry code as the only identifiers on the page", () => {
    const extracted = fields({ raw_text: "Ostja KMKR EE123456789 reg 11111111" });
    expect(buildExtractionConfidenceSignals(extracted, { ownCompanyVat: "EE123456789", ownCompanyRegistryCode: "11111111" }))
      .toEqual({ self_vat_detected: true, self_reg_code_detected: true });
    // A recovered supplier identifier means the page was not buyer-only.
    expect(buildExtractionConfidenceSignals(
      { ...extracted, supplier_vat_no: "EE100000000", supplier_reg_code: "22222222" },
      { ownCompanyVat: "EE123456789", ownCompanyRegistryCode: "11111111" },
    )).toEqual({});
  });

  it("flags a gross-total conflict and an echo-only supplier identifier, in a stable key order", () => {
    const signals = buildExtractionConfidenceSignals(
      fields({ raw_text: "EE123456789", total_gross_conflict: true, vat_no_rationale: "coordinate_confirmed_echo" } as Partial<ExtractedReceiptFields>),
      { partialOcrFailure: true, minOcrConfidence: 0.1, ownCompanyVat: "EE123456789" },
    );
    expect(Object.keys(signals)).toEqual([
      "partial_ocr_failure",
      "low_ocr_confidence",
      "self_vat_detected",
      "total_gross_conflict",
      "supplier_identifier_echo_unconfirmed",
    ]);
    expect(buildExtractionConfidenceSignals(
      fields({ reg_code_rationale: "coordinate_confirmed_echo" } as Partial<ExtractedReceiptFields>), {},
    )).toEqual({ supplier_identifier_echo_unconfirmed: true });
  });
});

describe("non-VAT item guards", () => {
  const clean = { custom_title: "a", total_net_price: 1 } as PurchaseInvoiceItem;
  const dirty = { custom_title: "b", total_net_price: 1, vat_accounts_id: 1510, vat_rate_dropdown: "24" } as PurchaseInvoiceItem;

  it("collects indexed errors across all items", () => {
    expect(collectNonVatItemErrors([clean, dirty])).toEqual([
      "items[1].vat_accounts_id must be absent",
      'items[1].vat_rate_dropdown must be absent or "-"',
    ]);
    expect(collectNonVatItemErrors([clean])).toEqual([]);
  });

  it("refuses only for a non-VAT company with deductible VAT fields", () => {
    expect(refuseNonVatItemsWithVatFields(true, [dirty])).toBeUndefined();
    expect(refuseNonVatItemsWithVatFields(false, [clean])).toBeUndefined();
    const refusal = refuseNonVatItemsWithVatFields(false, [dirty]);
    expect(refusal?.isError).toBe(true);
    const text = (refusal?.content[0] as { text: string }).text;
    const payload = parseMcpResponse(text) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["error", "category", "details", "next_action"]);
    expect(payload).toEqual({
      error: "Non-VAT purchase invoice contains deductible VAT fields",
      category: "manual_review_required",
      details: ["items[0].vat_accounts_id must be absent", 'items[0].vat_rate_dropdown must be absent or "-"'],
      next_action: "Use one non-VAT form for every item: folded (no VAT account, article 11, rate \"-\") or non-deductible VAT on the cost account " +
        "(VAT account and dimension = the item's cost account and dimension, article 11, the document's VAT rate), then review and retry.",
    });
  });
});

describe("applyPurchaseVatDefaultsAndValidateDimensions", () => {
  const api = (accounts: unknown[]) => ({
    readonly: {
      getAccounts: vi.fn().mockResolvedValue(accounts),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
    },
  }) as never;

  it("applies VAT defaults and returns no errors for valid accounts", async () => {
    const { items, dimErrors } = await applyPurchaseVatDefaultsAndValidateDimensions(
      api([{ id: 5230, is_valid: true }]), [], [{ custom_title: "x", purchase_accounts_id: 5230, total_net_price: 5 } as PurchaseInvoiceItem], false,
    );
    expect(dimErrors).toEqual([]);
    expect(items[0]).toMatchObject({ cl_vat_articles_id: 11, vat_rate_dropdown: "-", amount: 1, cl_fringe_benefits_id: 1 });
  });

  it("reports an unknown account by item position", async () => {
    const { dimErrors } = await applyPurchaseVatDefaultsAndValidateDimensions(
      api([]), [], [{ custom_title: "x", purchase_accounts_id: 99999, total_net_price: 5 } as PurchaseInvoiceItem], false,
    );
    expect(dimErrors).toHaveLength(1);
    expect(dimErrors[0]).toMatch(/^Item 1 purchase account 99999 not found/);
  });
});

describe("uploadSourceDocumentOrInvalidate", () => {
  const api = (upload: () => Promise<unknown>, invalidate: () => Promise<unknown> = async () => ({})) => ({
    purchaseInvoices: { uploadDocument: vi.fn(upload), invalidate: vi.fn(invalidate) },
  });

  it("returns undefined and never invalidates on a successful upload", async () => {
    const mock = api(async () => ({}));
    expect(await uploadSourceDocumentOrInvalidate(mock as never, 5, "a.pdf", "QQ==")).toBeUndefined();
    expect(mock.purchaseInvoices.uploadDocument).toHaveBeenCalledWith(5, "a.pdf", "QQ==");
    expect(mock.purchaseInvoices.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the draft and reports the upload failure", async () => {
    const mock = api(async () => { throw new Error("boom"); });
    expect(await uploadSourceDocumentOrInvalidate(mock as never, 5, "a.pdf", "QQ=="))
      .toBe("Purchase invoice 5 was created but source document upload failed and the draft was invalidated: boom");
    expect(mock.purchaseInvoices.invalidate).toHaveBeenCalledWith(5);
  });

  it("reports both failures when invalidation also fails", async () => {
    const mock = api(async () => { throw new Error("boom"); }, async () => { throw "nope"; });
    expect(await uploadSourceDocumentOrInvalidate(mock as never, 5, "a.pdf", "QQ=="))
      .toBe("Purchase invoice 5 was created but source document upload failed: boom. Automatic invalidation also failed: nope");
  });
});

describe("logDocumentPurchaseInvoiceAudit", () => {
  it("writes the CREATED then UPLOADED entries for the given tool", () => {
    logDocumentPurchaseInvoiceAudit({
      tool: "process_accounting_document",
      invoiceId: 9,
      createdSummary: "Created purchase invoice \"N-1\" from document",
      supplierName: "ACME OÜ",
      invoiceNumber: "N-1",
      invoiceDate: "2026-06-15",
      totalVat: 2,
      totalGross: 12,
      items: [{ custom_title: "T", cl_purchase_articles_id: 1, total_net_price: 10, purchase_accounts_id: 5000 } as PurchaseInvoiceItem],
      fileName: "invoice.pdf",
    });
    expect(vi.mocked(logAudit).mock.calls).toEqual([
      [{
        tool: "process_accounting_document", action: "CREATED", entity_type: "purchase_invoice", entity_id: 9,
        summary: "Created purchase invoice \"N-1\" from document",
        details: {
          supplier_name: "ACME OÜ", invoice_number: "N-1", invoice_date: "2026-06-15", total_vat: 2, total_gross: 12,
          items: [{ title: "T", cl_purchase_articles_id: 1, total_net_price: 10 }],
          file_name: "invoice.pdf",
        },
      }],
      [{
        tool: "process_accounting_document", action: "UPLOADED", entity_type: "purchase_invoice", entity_id: 9,
        summary: "Uploaded document to purchase invoice 9",
        details: { file_name: "invoice.pdf" },
      }],
    ]);
  });
});
