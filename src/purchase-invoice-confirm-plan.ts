import type { PurchaseInvoice } from "./types/api.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";
import { draftFingerprint } from "./purchase-invoice-draft-fingerprint.js";

export const PURCHASE_INVOICE_PDF_CONFIRM_DOMAIN = "purchase_invoice_pdf_confirm";

export function issuePurchaseInvoiceConfirmPlan(runtime: RuntimeSafetyContext, draft: PurchaseInvoice): string {
  if (typeof draft.id !== "number" || !Number.isSafeInteger(draft.id) || draft.id <= 0) throw new Error("A persisted invoice ID is required.");
  const args = { invoice_id: draft.id, draft_fingerprint: draftFingerprint(draft) };
  return runtime.planStore.issue(PURCHASE_INVOICE_PDF_CONFIRM_DOMAIN, {
    normalizedArgs: args, sourceIdentities: [], liveSnapshot: { invoice_id: draft.id },
    commands: [{ id: "purchase-invoice-pdf-confirm", category: "purchase_invoice_confirm", reviewProjection: args }],
    counts: {}, totals: {}, exclusions: [], reviews: [], privatePayload: { invoice_id: draft.id },
  });
}
