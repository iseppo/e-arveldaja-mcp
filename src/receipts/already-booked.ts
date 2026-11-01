import type { ApiContext } from "../tools/crud-tools.js";
import type { PurchaseInvoice } from "../types/api.js";
import { isInvalidatedPurchaseInvoice } from "../purchase-invoice-status.js";
import { findInvoiceNumberMatchesAnySupplier } from "../tools/receipt-inbox-matching.js";
import {
  receiptAttachmentDigestStore,
  sha256OfBase64,
  type ReceiptAttachmentDigestRecord,
} from "./attachment-digest-store.js";

/** Attachment downloads (checks + backfill) per batch run. Beyond it files are processed normally. */
export const MAX_ATTACHMENT_CHECKS = 20;

export interface AttachmentCheckBudget {
  remaining: number;
  exhausted: boolean;
}

export function newAttachmentCheckBudget(): AttachmentCheckBudget {
  return { remaining: MAX_ATTACHMENT_CHECKS, exhausted: false };
}

export interface AttachedInvoice {
  invoice_id: number;
  base_document_files_id: number;
}

function digestKey(record: Pick<ReceiptAttachmentDigestRecord, "sha256" | "entity_id">): string {
  return `${record.sha256}:${record.entity_id}`;
}

function take(budget: AttachmentCheckBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= 1;
  return true;
}

/**
 * Fresh proof that invoice `invoiceId` currently carries exactly the bytes
 * `sha256`: the invoice is re-read past the cache and must be live with an
 * attachment; when `expected` holds recorded values, its number, supplier,
 * gross and attachment id must still equal them; and the current attachment
 * bytes must hash to `sha256` (the API returns uploads byte-identical, live
 * check L4). Any read failure is "not proven".
 */
export async function verifyCurrentAttachment(
  api: ApiContext,
  invoiceId: number,
  sha256: string,
  expected: Partial<Pick<ReceiptAttachmentDigestRecord, "base_document_files_id" | "number" | "clients_id" | "gross_price">> = {},
): Promise<AttachedInvoice | undefined> {
  try {
    api.purchaseInvoices.invalidateListCache();
    const invoice = await api.purchaseInvoices.get(invoiceId);
    if (isInvalidatedPurchaseInvoice(invoice)) return undefined;
    const fileId = invoice.base_document_files_id;
    if (typeof fileId !== "number") return undefined;
    if (expected.base_document_files_id != null && expected.base_document_files_id !== fileId) return undefined;
    if (expected.number != null && expected.number !== invoice.number) return undefined;
    if (expected.clients_id != null && expected.clients_id !== invoice.clients_id) return undefined;
    if (expected.gross_price != null && Math.abs(expected.gross_price - (invoice.gross_price ?? Number.NaN)) >= 0.005) return undefined;
    const document = await api.purchaseInvoices.getDocument(invoiceId);
    if (typeof document?.contents !== "string" || sha256OfBase64(document.contents) !== sha256) return undefined;
    return { invoice_id: invoiceId, base_document_files_id: fileId };
  } catch {
    return undefined;
  }
}

/**
 * #4(b): the purchase invoice this receipt file is already attached to, if
 * proven fresh in this run. Stored digest records are hints: a record whose
 * fresh check fails is deleted and the file is processed normally. With
 * `backfill` (the reviewed dry run only), invoices named by the receipt's
 * invoice number that have an attachment but no record are downloaded, hashed
 * and recorded (bounded by the shared budget).
 */
export async function findAttachedInvoice(
  api: ApiContext,
  purchaseInvoices: readonly PurchaseInvoice[],
  sha256: string,
  invoiceNumber: string | undefined,
  options: { backfill: boolean; budget: AttachmentCheckBudget },
): Promise<AttachedInvoice | undefined> {
  let records: ReceiptAttachmentDigestRecord[] | null;
  try {
    records = receiptAttachmentDigestStore.read();
  } catch {
    return undefined; // an unreadable store is no evidence either way
  }
  if (records === null) return undefined; // single-file rules mode: feature off

  const stale: string[] = [];
  let hit: AttachedInvoice | undefined;
  for (const record of records.filter(candidate => candidate.sha256 === sha256)) {
    if (!take(options.budget)) break;
    hit = await verifyCurrentAttachment(api, record.entity_id, sha256, record);
    if (hit) break;
    stale.push(digestKey(record));
  }
  if (stale.length > 0) {
    try { receiptAttachmentDigestStore.remove(stale); } catch { /* a hint store; next run retries */ }
  }
  if (hit || !options.backfill || !invoiceNumber) return hit;

  const recorded = new Set(records.map(record => record.entity_id));
  const byId = new Map(purchaseInvoices.map(invoice => [invoice.id, invoice]));
  const fresh: ReceiptAttachmentDigestRecord[] = [];
  for (const candidate of findInvoiceNumberMatchesAnySupplier([...purchaseInvoices], invoiceNumber)) {
    const invoice = byId.get(candidate.invoice_id);
    if (!invoice || typeof invoice.base_document_files_id !== "number" || recorded.has(candidate.invoice_id)) continue;
    if (!take(options.budget)) break;
    // The listed invoice is a cached hint: re-read it past the cache, and only
    // a live invoice still carrying an attachment under the matched number is
    // recorded or excludes the receipt (one voided in the UI keeps its file).
    let current: PurchaseInvoice;
    let documentSha: string;
    try {
      api.purchaseInvoices.invalidateListCache();
      current = await api.purchaseInvoices.get(candidate.invoice_id);
      if (isInvalidatedPurchaseInvoice(current) || typeof current.base_document_files_id !== "number" ||
        current.number !== invoice.number) continue;
      const document = await api.purchaseInvoices.getDocument(candidate.invoice_id);
      if (typeof document?.contents !== "string") continue;
      documentSha = sha256OfBase64(document.contents);
    } catch {
      continue;
    }
    fresh.push({
      sha256: documentSha, entity: "purchase_invoice", entity_id: candidate.invoice_id,
      base_document_files_id: current.base_document_files_id, number: current.number ?? null,
      clients_id: current.clients_id ?? null, gross_price: current.gross_price ?? null,
      recorded_at: new Date().toISOString(),
    });
    if (documentSha === sha256) {
      hit = { invoice_id: candidate.invoice_id, base_document_files_id: current.base_document_files_id };
      break;
    }
  }
  if (fresh.length > 0) {
    try { receiptAttachmentDigestStore.upsert(fresh); } catch { /* backfill is best effort */ }
  }
  return hit;
}
