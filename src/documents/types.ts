import type { CompactReviewItem, CompactWarning, OperationOutcome } from "../operation-outcome.js";
import type { PlanData } from "../plan-store.js";
import type { Resolution } from "../resolution/types.js";
import type { SupplierRef } from "../resolution/supplier-default-resolution.js";
import type { ExtractedReceiptFields } from "../tools/receipt-extraction.js";
import type { ExtractionConfidenceSignals, InvoiceExtractionFallback } from "../invoice-extraction-fallback.js";
import type { FileInputSnapshot, FileInputSource } from "../file-input-snapshot.js";
import type { BookingSuggestionCore } from "../tools/pdf-workflow.js";
import type { DuplicatePostingCandidate, DuplicatePostingScanResult, DuplicatePostingSuspect } from "../bank-posting-duplicate-guard.js";
import type { ApiResponse, PurchaseInvoice } from "../types/api.js";

// Typed accounting-document operations (Task 13, PR 8B). The interface
// references NO MCP types — inputs and results are plain typed, UNWRAPPED
// domain data. The guided façade (src/guided/process-accounting-document.ts) is
// the SOLE wrapUntrustedOcr site (F-RESOLVER-FACADE-WRAP); nothing here wraps.
// The compact preview carries NO raw OCR — `raw_text` is omitted from the
// extracted fields (full text only via the advanced/detail path).

/** Operator-supplied overrides threaded into prepare (all optional). */
export interface AccountingDocumentOverrides {
  readonly supplier_client_id?: number;
  readonly currency?: string;
  readonly currency_rate?: number;
  readonly base_net_price?: number;
  readonly base_vat_price?: number;
  readonly base_gross_price?: number;
  readonly is_physical_entity?: boolean;
  readonly foreign_identity_attested?: boolean;
  readonly country?: string;
  readonly notes?: string;
}

export interface PrepareAccountingDocumentInput {
  readonly source: FileInputSource;
  /** ADDITIVE (guided façade): an immutable snapshot captured ONCE upstream
   * under the receipt_input operation. When present it is threaded by identity
   * so the op does not read the source a second time. */
  readonly snapshot?: FileInputSnapshot;
  readonly overrides?: AccountingDocumentOverrides;
}

/** Compact extraction summary — carries NO raw OCR text. */
export interface DocumentExtraction {
  readonly source_sha256: string;
  readonly page_count: number;
  readonly min_ocr_confidence?: number;
  readonly partial_ocr_failure?: boolean;
  readonly confidence_signals: ExtractionConfidenceSignals;
  /** Structured extracted fields with `raw_text` OMITTED (no raw OCR in compact). */
  readonly fields: Omit<ExtractedReceiptFields, "raw_text">;
  readonly llm_fallback: InvoiceExtractionFallback;
  readonly warnings: string[];
}

export interface DocumentVatValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly summary?: Record<string, unknown>;
}

export interface AccountingDocumentPreview {
  readonly extraction: DocumentExtraction;
  readonly vatValidation: DocumentVatValidation;
  /** Three-way supplier resolution — resolved (unique) / ambiguous / not_found. */
  readonly supplierResolution: Resolution<SupplierRef>;
  /** Duplicate detection result (UNWRAPPED supplier names). */
  readonly duplicate: Record<string, unknown>;
  /** suggest_booking core — present ONLY when the supplier resolved uniquely. */
  readonly proposedBooking?: BookingSuggestionCore;
  /** Cross-mechanism intake cash-duplicate suspects (advisory). */
  readonly possibleDuplicatePostings?: readonly DuplicatePostingSuspect[];
  readonly blockers: readonly CompactReviewItem[];
  readonly warnings: readonly CompactWarning[];
  /** Public, review-only plan projection (no private fingerprint). */
  readonly planProjection: PlanData;
  readonly planHandle: string;
}

export interface ExecuteAccountingDocumentInput {
  readonly source: FileInputSource;
  readonly snapshot?: FileInputSnapshot;
  readonly planHandle: string | undefined;
  /** SHA-256 the caller echoes from prepare; re-verified against the bytes. */
  readonly sourceSha256: string;
  readonly supplierClientId: number;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly journalDate: string;
  readonly termDays: number;
  readonly items: unknown;
  readonly vatPrice?: number;
  readonly grossPrice?: number;
  readonly liabilityAccountsId?: number;
  readonly notes?: string;
  readonly refNumber?: string;
  readonly bankAccountNo?: string;
  readonly currency?: string;
  readonly currencyRate?: number;
  readonly baseNetPrice?: number;
  readonly baseVatPrice?: number;
  readonly baseGrossPrice?: number;
  readonly blockOnDuplicate?: boolean;
}

export interface AccountingDocumentExecution {
  readonly createdInvoiceId: number;
  readonly documentUploaded: boolean;
  readonly result: PurchaseInvoice;
  /** STRUCTURED, UNWRAPPED duplicate-scan data. The façade formats it into
   * warning lines and wraps the untrusted journal titles with wrapUntrustedOcr
   * (F-RESOLVER-FACADE-WRAP) — the op never embeds a raw title into a string. */
  readonly duplicateScan: DuplicatePostingScanResult & { skipped_no_eur_amount?: boolean };
  readonly duplicateCandidate: DuplicatePostingCandidate;
  readonly possibleDuplicatePostings?: readonly DuplicatePostingSuspect[];
  /** SECOND plan minted for the SEPARATE confirm/link step — NEVER auto-run. */
  readonly confirmPlan?: {
    readonly planHandle: string;
    readonly invoiceId: number;
  };
}

/** Input for the SEPARATE confirm/link step (Step 3). Confirm operates purely
 * on the reviewed invoice id — it never re-reads the source or re-extracts. */
export interface ConfirmAccountingDocumentInput {
  /** The confirm plan handle minted at create time. Consume-once; NOT approval. */
  readonly planHandle: string | undefined;
  readonly invoiceId: number;
}

export interface AccountingDocumentConfirmation {
  readonly confirmedInvoiceId: number;
  readonly status: string;
  readonly mutationOccurred: true;
  /** Raw register-endpoint response (UNWRAPPED). */
  readonly result: ApiResponse;
  /** Draft supplier name read back from the registered invoice for the confirm
   *  receipt. UNWRAPPED domain value — the façade wraps it (an OCR-created
   *  client name is untrusted). Omitted (undefined) if the best-effort read-back
   *  failed — an advisory echo must never fail a completed registration. */
  readonly echoedSupplierName?: string;
  /** Draft gross (invoice `gross_price`, the invoice-currency face value) read
   *  back for the confirm receipt. Labelled by `echoedCurrency`. Omitted if the
   *  read-back failed or the field was absent. */
  readonly echoedGross?: number;
  /** Invoice currency (`cl_currencies_id`) read back for the confirm receipt, so
   *  `echoedGross` is never an unlabelled number. Omitted if the read-back
   *  failed. */
  readonly echoedCurrency?: string;
  /** EUR-settled gross (`base_gross_price`) read back for the confirm receipt —
   *  the figure the ledger actually moves. Only meaningful when the invoice is
   *  non-EUR (for an EUR invoice it equals `echoedGross`). Omitted if the
   *  read-back failed or the field was absent. */
  readonly echoedBaseGross?: number;
}

export interface AccountingDocumentOperations {
  prepare(input: PrepareAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentPreview>>;
  create(input: ExecuteAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentExecution>>;
  confirmDraft(input: ConfirmAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentConfirmation>>;
}
