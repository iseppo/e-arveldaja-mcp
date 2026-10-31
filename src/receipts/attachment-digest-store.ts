import { createHash } from "crypto";
import { createConnectionScopedBundleStore } from "../connection-scoped-bundle-store.js";

/**
 * #4(b): which file bytes were attached to which purchase invoice. A record is
 * a HINT, never proof: an attachment can be replaced or removed (also in the
 * e-arveldaja UI), so a hit counts only after a fresh check of the invoice and
 * of its current attachment bytes.
 */
export interface ReceiptAttachmentDigestRecord {
  /** SHA-256 (hex) of the attached file bytes. */
  sha256: string;
  entity: "purchase_invoice";
  entity_id: number;
  /** As read after the upload; null when unknown. */
  base_document_files_id: number | null;
  number: string | null;
  clients_id: number | null;
  gross_price: number | null;
  recorded_at: string;
}

export const RECEIPT_ATTACHMENT_DIGEST_FILE = "receipt-attachment-digests.json";

export const receiptAttachmentDigestStore = createConnectionScopedBundleStore<ReceiptAttachmentDigestRecord>({
  fileName: RECEIPT_ATTACHMENT_DIGEST_FILE,
  label: "receipt attachment digests (receipt-attachment-digests.json)",
  maxEntries: 5000,
  keyOf: record => `${record.sha256}:${record.entity_id}`,
});

export function sha256OfBase64(contentsBase64: string): string {
  return createHash("sha256").update(Buffer.from(contentsBase64, "base64")).digest("hex");
}

/**
 * Record an upload that succeeded. Never throws: a store failure must never
 * fail the booking, so it returns a note instead (undefined when recorded).
 */
export function recordReceiptAttachmentDigest(
  record: Omit<ReceiptAttachmentDigestRecord, "entity" | "recorded_at">,
): string | undefined {
  try {
    if (receiptAttachmentDigestStore.read() === null) {
      return "Attachment digest not recorded: single-file rules mode (EARVELDAJA_RULES_FILE) has no bundle store.";
    }
    receiptAttachmentDigestStore.upsert([{ ...record, entity: "purchase_invoice", recorded_at: new Date().toISOString() }]);
    return undefined;
  } catch (error) {
    return `Attachment digest not recorded: ${(error as Error).message}`;
  }
}
