import type { PurchaseInvoice } from "../../types/api.js";
import { textCarriesStrongReference } from "../../journal-reference-scan.js";
import { orderReferencesFromNotes } from "../../order-reference-note.js";
import { stripCamtDescriptionMetadata } from "../../camt/duplicate-identity.js";

/**
 * The strong document reference (invoice number, then the notes' order / cart
 * number lines) that `description`'s visible payment text carries as a whole
 * token, if any. The CAMT metadata marker (`br=`, `instr=`, …) is stripped
 * first: a bank or instruction id is not payment text. Shared by
 * the reconcile suggestion's document-reference group and the classification
 * partition, so a row reconcile offers as an invoice payment is never booked
 * as a new expense.
 */
export function documentReferenceOnTransaction(
  description: string | null | undefined,
  inv: Pick<PurchaseInvoice, "number" | "notes">,
): string | undefined {
  const references = [inv.number, ...orderReferencesFromNotes(inv.notes)];
  const visibleText = stripCamtDescriptionMetadata(description ?? undefined);
  return references.find(reference => textCarriesStrongReference(visibleText, reference));
}
