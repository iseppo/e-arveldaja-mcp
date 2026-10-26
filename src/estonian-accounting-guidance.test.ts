import { describe, expect, it } from "vitest";
import {
  buildCamtDuplicateReviewGuidance,
  buildClassificationReviewGuidance,
  buildOwnerExpenseVatReviewGuidance,
  buildReceiptReviewGuidance,
} from "./estonian-accounting-guidance.js";

describe("estonian accounting guidance", () => {
  it("uses a conservative 50% default for owner-paid vehicle costs", () => {
    const guidance = buildOwnerExpenseVatReviewGuidance({
      description: "Fuel and parking for company car",
      accountName: "Transport expenses",
    });

    expect(guidance.recommendation).toContain("50%");
    expect(guidance.compliance_basis).toEqual(expect.arrayContaining([
      expect.stringContaining("KMS § 32"),
      expect.stringContaining("EMTA passenger-car guidance"),
    ]));
    expect(guidance.follow_up_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("M1-category"),
      expect.stringContaining("private driving"),
    ]));
  });

  it("recommends attaching a receipt to the journal that already references its invoice number", () => {
    const guidance = buildReceiptReviewGuidance({
      classification: "purchase_invoice",
      notes: [],
      referencingJournalIds: [29551084],
      possibleDuplicateJournalIds: [28427570],
    });

    expect(guidance!.recommendation).toContain("Journal(s) 29551084 already reference");
    expect(guidance!.recommendation).toContain("attach_document entity_type=journal");
    expect(guidance!.recommendation).toContain("journal(s) 28427570");
    expect(guidance!.follow_up_questions).toEqual(["Is journal 29551084 this document's booking?"]);
  });

  it("asks for source-document fields before auto-booking an incomplete receipt", () => {
    const guidance = buildReceiptReviewGuidance({
      classification: "purchase_invoice",
      notes: ["Missing supplier name, confident invoice number, invoice date, or gross total required for auto-booking."],
      llmFallback: {
        raw_text_available: true,
        recommended: true,
        confidence: "low",
        confidence_signals: ["missing_required_fields"],
        reason: "Deterministic extraction left required invoice fields unresolved.",
        missing_required_fields: ["supplier_name", "invoice_number", "invoice_date", "total_gross"],
        missing_optional_fields: [],
        guidance: "Use raw text.",
      },
      extracted: {
        description: "Office supplies",
      },
    });

    expect(guidance).toBeDefined();
    expect(guidance!.recommendation).toContain("supplier name");
    expect(guidance!.compliance_basis).toEqual(expect.arrayContaining([
      expect.stringContaining("RPS § 6–7"),
      expect.stringContaining("KMS § 31"),
    ]));
    expect(guidance!.follow_up_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("supplier"),
      expect.stringContaining("invoice number"),
    ]));
  });

  it("gives owner-transfer review guidance instead of purchase-invoice advice", () => {
    const guidance = buildClassificationReviewGuidance({
      category: "owner_transfers",
      displayCounterparty: "Seppo Sepp",
    });

    expect(guidance).toBeDefined();
    expect(guidance!.recommendation).toContain("do not create a purchase invoice");
    expect(guidance!.follow_up_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("loan"),
      expect.stringContaining("expense reimbursement"),
      expect.stringContaining("dividend"),
    ]));
  });

  it("gives history guidance instead of the sales-invoice text for a history-suggested incoming loan (F6)", () => {
    const guidance = buildClassificationReviewGuidance({
      category: "revenue_without_invoice",
      displayCounterparty: "Laenaja OÜ",
      history: { accountId: 2110, dimensionId: 900, streak: 3, historyTotal: 8 },
    });

    expect(guidance).toBeDefined();
    expect(guidance!.recommendation).toContain("confirm_transaction");
    expect(guidance!.recommendation).toContain("related_id: 2110");
    expect(guidance!.recommendation).toContain("related_sub_id: 900");
    expect(guidance!.recommendation).toContain("last 3");
    expect(JSON.stringify(guidance)).not.toMatch(/sale invoice/i);
  });

  it("does not ask extra questions for CAMT duplicates when the payload already determines the default", () => {
    const guidance = buildCamtDuplicateReviewGuidance({ hasConfirmedMatch: true });

    expect(guidance.follow_up_questions).toEqual([]);
    expect(guidance.recommendation).toContain("already confirmed");
  });
});
