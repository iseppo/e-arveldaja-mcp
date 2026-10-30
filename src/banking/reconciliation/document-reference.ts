import type { PurchaseInvoice } from "../../types/api.js";
import { textCarriesStrongReference } from "../../journal-reference-scan.js";
import { orderReferencesFromNotes } from "../../order-reference-note.js";

/**
 * The strong document reference (invoice number, then the notes' order / cart
 * number lines) that `description` carries as a whole token, if any. Shared by
 * the reconcile suggestion's document-reference group and the classification
 * partition, so a row reconcile offers as an invoice payment is never booked
 * as a new expense.
 */
export function documentReferenceOnTransaction(
  description: string | null | undefined,
  inv: Pick<PurchaseInvoice, "number" | "notes">,
): string | undefined {
  const references = [inv.number, ...orderReferencesFromNotes(inv.notes)];
  return references.find(reference => textCarriesStrongReference(description, reference));
}
