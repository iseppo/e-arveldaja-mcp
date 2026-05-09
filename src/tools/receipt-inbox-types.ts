import type { Account, Client, PurchaseInvoice, Transaction } from "../types/api.js";
import type { InvoiceExtractionFallback } from "../invoice-extraction-fallback.js";
import type { BookingSuggestion, ExtractedReceiptFields, ReceiptClassification } from "./receipt-extraction.js";
import type { SupplierResolution } from "./supplier-resolution.js";
import type { ReviewGuidance } from "../estonian-accounting-guidance.js";
import type { getPurchaseArticlesWithVat } from "./purchase-vat-defaults.js";

export const FILE_TYPE_EXTENSIONS = {
  pdf: [".pdf"],
  jpg: [".jpg", ".jpeg"],
  png: [".png"],
} as const;

export const SUPPORTED_RECEIPT_EXTENSIONS = [
  ...FILE_TYPE_EXTENSIONS.pdf,
  ...FILE_TYPE_EXTENSIONS.jpg,
  ...FILE_TYPE_EXTENSIONS.png,
];

export const MAX_RECEIPT_SIZE = 50 * 1024 * 1024; // 50 MB

export const RECEIPT_BATCH_EXECUTION_MODES = ["dry_run", "create", "create_and_confirm"] as const;

export type FileType = keyof typeof FILE_TYPE_EXTENSIONS;
export type ReceiptBatchExecutionMode = typeof RECEIPT_BATCH_EXECUTION_MODES[number];

export type ReceiptBatchStatus =
  | "matched"
  | "created"
  | "skipped_duplicate"
  | "needs_review"
  | "failed"
  | "dry_run_preview";

export interface ReceiptFileInfo {
  name: string;
  path: string;
  extension: string;
  file_type: FileType;
  size_bytes: number;
  modified_at: string;
}

export interface ReceiptScanResult {
  files: ReceiptFileInfo[];
  skipped: Array<{ name: string; reason: string }>;
  folder_path: string;
  total_candidates: number;
}

export interface TransactionMatchCandidate {
  transaction_id: number;
  amount: number;
  date: string;
  bank_account_name?: string | null;
  description?: string | null;
  confidence: number;
  reasons: string[];
}

export interface InvoiceDuplicateMatch {
  reason: "supplier_invoice_number" | "supplier_amount_date";
  invoice_id: number;
  invoice_number: string;
  create_date: string;
  gross_price?: number;
}

export interface ReceiptProcessingContext {
  clients: Client[];
  purchaseInvoices: PurchaseInvoice[];
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>;
  accounts: Account[];
  isVatRegistered: boolean;
}

export interface ReceiptBatchFileResult {
  file: ReceiptFileInfo;
  classification: ReceiptClassification;
  status: ReceiptBatchStatus;
  extracted?: ExtractedReceiptFields;
  llm_fallback?: InvoiceExtractionFallback;
  supplier_resolution?: SupplierResolution;
  booking_suggestion?: BookingSuggestion;
  duplicate_match?: InvoiceDuplicateMatch;
  created_invoice?: {
    id?: number;
    number: string;
    status?: string;
    confirmed?: boolean;
    uploaded_document?: boolean;
  };
  bank_match?: {
    candidate?: TransactionMatchCandidate;
    linked?: boolean;
    confirmed_transaction_id?: number;
  };
  referenced_invoice?: {
    invoice_number: string;
    matched: boolean;
    matched_invoice_id?: number;
  };
  notes: string[];
  error?: string;
  review_guidance?: ReviewGuidance;
}

export type ReceiptInboxToolResult = Promise<{ content: Array<{ text: string }> }>;
export type ReceiptInboxToolHandler = (args: Record<string, unknown>) => ReceiptInboxToolResult;

export interface ReceiptBatchSummary {
  execution_mode: ReceiptBatchExecutionMode;
  legacy_execute_create: boolean;
  dry_run: boolean;
  scanned_files: number;
  skipped_invalid_files: number;
  created: number;
  matched: number;
  skipped_duplicate: number;
  failed: number;
  needs_review: number;
  dry_run_preview: number;
}
