import { createHash } from "node:crypto";
import type { PurchaseInvoice } from "./types/api.js";
import { canonicalPlanJson, stripUndefinedDeep } from "./tools/camt-plan.js";

// Registration fills status and ledger/payment links. Every other field,
// including future material fields, belongs to the reviewed draft.
const DRAFT_FIELDS_ALLOWED_TO_DIFFER: ReadonlySet<string> = new Set(["status", "payment_status", "journals", "settlements", "transactions"]);
export function draftFingerprint(invoice: PurchaseInvoice): string {
  const material = Object.fromEntries(Object.entries(invoice).filter(([key]) => !DRAFT_FIELDS_ALLOWED_TO_DIFFER.has(key)));
  return createHash("sha256").update(canonicalPlanJson(stripUndefinedDeep(material))).digest("hex");
}
