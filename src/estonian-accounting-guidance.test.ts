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
      expect.stringContaining("EMTA sõiduauto juhis"),
    ]));
    expect(guidance.follow_up_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("M1-kategooria"),
      expect.stringContaining("erasõidud"),
    ]));
  });

  it("asks for source-document fields before auto-booking an incomplete receipt", () => {
    const guidance = buildReceiptReviewGuidance({
      classification: "purchase_invoice",
      notes: ["Missing supplier name, confident invoice number, invoice date, or gross total required for auto-booking."],
      llmFallback: {
        raw_text_available: true,
        recommended: true,
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
    expect(guidance!.recommendation).toContain("müüja nimi");
    expect(guidance!.compliance_basis).toEqual(expect.arrayContaining([
      expect.stringContaining("RPS § 6–7"),
      expect.stringContaining("KMS § 31"),
    ]));
    expect(guidance!.follow_up_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("müüja"),
      expect.stringContaining("arve number"),
    ]));
  });

  it("gives owner-transfer review guidance instead of purchase-invoice advice", () => {
    const guidance = buildClassificationReviewGuidance({
      category: "owner_transfers",
      displayCounterparty: "Seppo Sepp",
    });

    expect(guidance).toBeDefined();
    expect(guidance!.recommendation).toContain("ära tee sellest ostuarvet");
    expect(guidance!.follow_up_questions).toEqual(expect.arrayContaining([
      expect.stringContaining("laen"),
      expect.stringContaining("kulude hüvitis"),
      expect.stringContaining("dividend"),
    ]));
  });

  it("does not ask extra questions for CAMT duplicates when the payload already determines the default", () => {
    const guidance = buildCamtDuplicateReviewGuidance({ hasConfirmedMatch: true });

    expect(guidance.follow_up_questions).toEqual([]);
    expect(guidance.recommendation).toContain("kinnitatud");
  });
});
