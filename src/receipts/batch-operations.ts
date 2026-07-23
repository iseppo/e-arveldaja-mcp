import type { OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { Account, PurchaseInvoiceItem, Transaction } from "../types/api.js";
import { reportProgress } from "../progress.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { normalizeCompanyName } from "../company-name.js";
import { parseDocument } from "../document-parser.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import {
  type ExtractionConfidenceSignals,
  type InvoiceExtractionFallback,
  summarizeInvoiceExtraction,
} from "../invoice-extraction-fallback.js";
import {
  type BookingSuggestion,
  type ExtractedReceiptFields,
  type ReceiptClassification,
  type TransactionClassificationCategory,
  CATEGORY_KEYWORD_MAP,
  buildKeywordSuggestion,
  classifyReceiptDocument,
  computeMinOcrConfidence,
  detectReverseChargeFromText,
  extractReceiptFieldsFromText,
  hasAutoBookableReceiptFields,
  inferSupplierCountry,
  LOW_OCR_CONFIDENCE_THRESHOLD,
  normalizeCounterpartyName,
  suggestBookingInternal,
} from "../tools/receipt-extraction.js";
import { resolveSupplierInternal } from "../tools/supplier-resolution.js";
import {
  type AccountingAutoBookingRule,
  findAutoBookingRule,
} from "../accounting-rules.js";
import { buildReceiptReviewGuidance } from "../estonian-accounting-guidance.js";
import { getPurchaseArticlesWithVat } from "../tools/purchase-vat-defaults.js";
import {
  type ReceiptApprovedManifestEntry,
  type ReceiptBatchExecutionMode,
  type ReceiptBatchFileResult,
  type ReceiptFileInfo,
  type ReceiptFileSnapshot,
  type ReceiptProcessingContext,
} from "../tools/receipt-inbox-types.js";
import {
  prepareReceiptBatchSnapshot,
  scanReceiptFolderInternal,
} from "../tools/receipt-inbox-files.js";
import { findDuplicateInvoice } from "../tools/receipt-inbox-matching.js";
import { createAndMaybeMatchPurchaseInvoice } from "../tools/receipt-inbox-booking.js";
import { buildReceiptBatchSummary } from "../tools/receipt-inbox-summary.js";
// These pure guards + rule-target resolvers stay in receipt-inbox.ts (several
// are exported for pdf-workflow / own-company-identity / unit tests, and the
// rule-target resolvers are shared with the classification path). Importing them
// here forms a runtime-safe cycle with receipt-inbox.ts: every cross-reference
// is used only inside function bodies, never at module-evaluation time.
import {
  applyReverseChargeAutoDetection,
  buildReferencedInvoiceForPaymentReceipt,
  deriveOwnCompanyRegistryCode,
  detectSelfRegCodeOnly,
  detectSelfVatOnly,
  loadOwnCompanyIdentity,
  normalizeVatForCompare,
  resolveAutoBookingRuleTargets,
  resolveMergedPurchaseAccountDimension,
  selectBatchBankTransactions,
  shouldGateCreation,
  supplierCountryNeedsReview,
} from "../tools/receipt-inbox.js";
import type {
  ReceiptBatchResult,
  ReceiptBatchRunInput,
  ReceiptScanResult,
  ReceiptScanRunInput,
} from "./types.js";

// Typed receipt batch operations. The interface references NO MCP types — inputs
// and results are plain typed data. The operation orchestrates I/O (folder byte
// snapshot binding the approved SHA-256 manifest, OCR extraction, api
// create/upload/confirm/link) and returns UNWRAPPED domain data; the presenter
// (./presenter.js) owns ALL wrapUntrustedOcr + sanitizeReceiptResultForOutput +
// the workflow/execution-contract builders + the file-reference projection.
//
// The staged-approval mechanism is preserved EXACTLY: prepareReceiptBatchSnapshot
// re-snapshots the folder bytes and throws `manifest_mismatch` (propagated to the
// adapter/framework, never swallowed) BEFORE any api mutation; create/upload
// (APPROVAL ONE) and confirm/link (APPROVAL TWO) stay distinct inside
// createAndMaybeMatchPurchaseInvoice; an ambiguous post-create failure is
// compensated (rollbackCreatedInvoice) and reported, never retried.

// Construct the OperationOutcome union directly rather than through
// successOutcome(), which deep-clones + freezes its value; the receipt result
// carries live api records (Client/PurchaseInvoice) that need not be frozen.
function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export function resolveReceiptBatchExecutionMode(
  execute: boolean | undefined,
  executionMode: ReceiptBatchExecutionMode | undefined,
): { mode: ReceiptBatchExecutionMode; legacyExecuteCreate: boolean } {
  if (executionMode) {
    return { mode: executionMode, legacyExecuteCreate: false };
  }
  if (execute === true) {
    return { mode: "create", legacyExecuteCreate: true };
  }
  return { mode: "dry_run", legacyExecuteCreate: false };
}

// ---------------------------------------------------------------------------
// Receipt auto-booking-rule merge chain (batch-only)
// ---------------------------------------------------------------------------

function inferReceiptAutoBookingCategory(
  extracted: Pick<ExtractedReceiptFields, "supplier_name" | "description">,
): TransactionClassificationCategory | undefined {
  const text = `${extracted.supplier_name ?? ""} ${extracted.description ?? ""}`.toLowerCase();
  return CATEGORY_KEYWORD_MAP.find(entry =>
    entry.category !== "unknown" && (entry.receiptAutoBookingPattern ?? entry.pattern).test(text)
  )?.category;
}

function mergeReceiptAutoBookingRule(
  bookingSuggestion: BookingSuggestion | undefined,
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  accounts: Account[],
  rule: AccountingAutoBookingRule,
  description: string,
): BookingSuggestion | undefined {
  const { article, account } = resolveAutoBookingRuleTargets(purchaseArticlesWithVat, accounts, rule);
  const baseItem = bookingSuggestion?.item;
  let changed = false;

  const mergedItem: PurchaseInvoiceItem = {
    ...(baseItem ?? {}),
    custom_title: baseItem?.custom_title ?? description,
    amount: baseItem?.amount ?? 1,
  };

  const resolvedArticleId = article?.id ?? rule.purchase_article_id;
  if (resolvedArticleId !== undefined && mergedItem.cl_purchase_articles_id !== resolvedArticleId) {
    mergedItem.cl_purchase_articles_id = resolvedArticleId;
    changed = true;
  }

  const resolvedAccountId = account?.id ?? article?.accounts_id ?? rule.purchase_account_id;
  if (resolvedAccountId !== undefined && mergedItem.purchase_accounts_id !== resolvedAccountId) {
    mergedItem.purchase_accounts_id = resolvedAccountId;
    changed = true;
  }

  const mergedPurchaseAccountDimensionsId = resolveMergedPurchaseAccountDimension(
    baseItem?.purchase_accounts_dimensions_id,
    baseItem?.purchase_accounts_id,
    resolvedAccountId,
    rule.purchase_account_dimensions_id,
  );
  if ((mergedItem.purchase_accounts_dimensions_id ?? undefined) !== mergedPurchaseAccountDimensionsId) {
    if (mergedPurchaseAccountDimensionsId === undefined) {
      delete mergedItem.purchase_accounts_dimensions_id;
    } else {
      mergedItem.purchase_accounts_dimensions_id = mergedPurchaseAccountDimensionsId;
    }
    changed = true;
  }

  if (rule.vat_rate_dropdown !== undefined && mergedItem.vat_rate_dropdown !== rule.vat_rate_dropdown) {
    mergedItem.vat_rate_dropdown = rule.vat_rate_dropdown;
    changed = true;
  }

  if (rule.reversed_vat_id !== undefined && mergedItem.reversed_vat_id !== rule.reversed_vat_id) {
    mergedItem.reversed_vat_id = rule.reversed_vat_id;
    changed = true;
  }

  const mergedSuggestedAccount = account ?? bookingSuggestion?.suggested_account;
  const mergedSuggestedArticle = article
    ? { id: article.id, name: article.name_est || article.name_eng }
    : bookingSuggestion?.suggested_purchase_article;
  const mergedLiabilityAccountId = rule.liability_account_id ?? bookingSuggestion?.suggested_liability_account_id;

  if (
    rule.liability_account_id !== undefined &&
    bookingSuggestion?.suggested_liability_account_id !== rule.liability_account_id
  ) {
    changed = true;
  }

  const hasBookingTarget = mergedItem.cl_purchase_articles_id !== undefined || mergedItem.purchase_accounts_id !== undefined;
  if (!hasBookingTarget) {
    return bookingSuggestion;
  }

  if (!changed && bookingSuggestion) {
    return bookingSuggestion;
  }

  return {
    source: "local_rules",
    matched_invoice_id: bookingSuggestion?.matched_invoice_id,
    matched_invoice_number: bookingSuggestion?.matched_invoice_number,
    suggested_account: mergedSuggestedAccount,
    suggested_purchase_article: mergedSuggestedArticle,
    suggested_liability_account_id: mergedLiabilityAccountId,
    item: mergedItem,
  };
}

function applyReceiptAutoBookingRule(
  bookingSuggestion: BookingSuggestion | undefined,
  extracted: Pick<ExtractedReceiptFields, "supplier_name" | "description">,
  context: Pick<ReceiptProcessingContext, "purchaseArticlesWithVat" | "accounts">,
): BookingSuggestion | undefined {
  if (bookingSuggestion?.source === "supplier_history") {
    return bookingSuggestion;
  }

  const normalizedSupplier = normalizeCounterpartyName(extracted.supplier_name);
  if (!normalizedSupplier) {
    return bookingSuggestion;
  }

  const inferredCategory = inferReceiptAutoBookingCategory(extracted);
  const rule = inferredCategory !== undefined
    ? findAutoBookingRule(normalizedSupplier, inferredCategory)
    : findAutoBookingRule(normalizedSupplier);
  if (!rule) {
    return bookingSuggestion;
  }

  return mergeReceiptAutoBookingRule(
    bookingSuggestion,
    context.purchaseArticlesWithVat,
    context.accounts,
    rule,
    extracted.description ?? extracted.supplier_name ?? "Receipt expense",
  );
}

// ---------------------------------------------------------------------------
// Needs-review builders (batch-only)
// ---------------------------------------------------------------------------

function maybeAddLlmFallbackNote(notes: string[], fallback: InvoiceExtractionFallback): void {
  if (!fallback.recommended) return;
  // With the #20 confidence model, `recommended` is true for any non-high
  // outcome — including medium with no missing required fields (e.g.
  // supplier_resolution_failed only). Don't emit "incomplete ()" when the
  // field list is empty; surface the confidence signals instead.
  if (fallback.missing_required_fields.length > 0) {
    const missing = fallback.missing_required_fields.join(", ");
    notes.push(`Deterministic extraction is incomplete (${missing}). Use extracted.raw_text and llm_fallback guidance instead of guessing missing fields.`);
  } else {
    const detail = fallback.confidence_signals.length > 0
      ? fallback.confidence_signals.join(", ")
      : fallback.reason;
    notes.push(`Deterministic extraction confidence is ${fallback.confidence} (${detail}). Use extracted.raw_text and llm_fallback guidance to verify before booking.`);
  }
}

function buildNeedsReviewResult(
  file: ReceiptFileInfo,
  classification: ReceiptClassification,
  extracted: ExtractedReceiptFields,
  fallback: InvoiceExtractionFallback,
  notes: string[],
  extras?: Pick<ReceiptBatchFileResult, "supplier_resolution" | "booking_suggestion" | "referenced_invoice">,
): ReceiptBatchFileResult {
  return {
    file,
    classification,
    status: "needs_review",
    extracted,
    llm_fallback: fallback,
    ...extras,
    review_guidance: buildReceiptReviewGuidance({
      classification,
      notes,
      extracted,
      llmFallback: fallback,
    }),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Per-file OCR extraction + orchestration (batch-only, the operation core)
// ---------------------------------------------------------------------------

async function extractReceiptFields(
  snapshot: ReceiptFileSnapshot,
  ownCompanyVat?: string,
  ownCompanyRegistryCode?: string,
): Promise<ExtractedReceiptFields> {
  // Parse the immutable snapshot bytes (snapshot_path), never the live folder
  // file, so the parser and the later uploader observe byte-identical content.
  const parsedDocument = await parseDocument(snapshot.snapshot_path);
  const allTextItems = parsedDocument.result?.pages?.flatMap(page =>
    (page.textItems ?? []).map(item => ({
      ...item,
      pageNum: page.pageNum,
    }))
  );
  return extractReceiptFieldsFromText(parsedDocument.text, snapshot.file.name, {
    ownCompanyVat,
    ownCompanyRegistryCode,
    textItems: allTextItems,
    minOcrConfidence: computeMinOcrConfidence(allTextItems),
    partialOcrFailure: parsedDocument.ocrPartialFailure,
  });
}

interface ProcessSingleReceiptOptions {
  ownCompanyVat?: string;
  ownCompanyRegistryCode?: string;
  bankTransactions: Transaction[];
  executionMode: ReceiptBatchExecutionMode;
  legacyExecuteCreate: boolean;
  dryRun: boolean;
  consumedTransactionIds: Set<number>;
  previousResults: ReceiptBatchFileResult[];
}

async function processSingleReceipt(
  api: ApiContext,
  context: ReceiptProcessingContext,
  snapshot: ReceiptFileSnapshot,
  options: ProcessSingleReceiptOptions,
): Promise<ReceiptBatchFileResult> {
  const file = snapshot.file;
  const notes: string[] = [];

  try {
    const extracted = await extractReceiptFields(snapshot, options.ownCompanyVat, options.ownCompanyRegistryCode);
    const classification = classifyReceiptDocument(extracted.raw_text ?? file.name, file.name);
    const selfVatDetected = detectSelfVatOnly(extracted, options.ownCompanyVat);
    const signals: ExtractionConfidenceSignals = {};
    if (extracted.partial_ocr_failure) signals.partial_ocr_failure = true;
    if (extracted.min_ocr_confidence !== undefined && extracted.min_ocr_confidence < LOW_OCR_CONFIDENCE_THRESHOLD) {
      signals.low_ocr_confidence = true;
    }
    if (selfVatDetected) signals.self_vat_detected = true;
    const selfRegCodeDetected = detectSelfRegCodeOnly(extracted, options.ownCompanyRegistryCode);
    if (selfRegCodeDetected) signals.self_reg_code_detected = true;
    // #1: an echo-only supplier identifier (rationale coordinate_confirmed_echo)
    // is kept but UNCONFIRMED — coordinate data cannot tell a legit supplier-id
    // echo in the buyer block from a buyer-id echo in a supplier-column
    // reference line. Route it to review so the operator verifies the supplier
    // before booking, rather than trusting it as coordinate-confirmed.
    const supplierIdentifierEcho =
      extracted.reg_code_rationale === "coordinate_confirmed_echo" ||
      extracted.vat_no_rationale === "coordinate_confirmed_echo";
    if (supplierIdentifierEcho) {
      signals.supplier_identifier_echo_unconfirmed = true;
      notes.push(
        "Supplier identifier was only kept because the same value also appears in a supplier column (echo). Coordinate data cannot confirm it is the supplier's own code — verify the supplier before booking (#1).",
      );
    }
    const inferredSupplierCountry = inferSupplierCountry(extracted);
    const summarize = () => summarizeInvoiceExtraction(extracted, signals, "extracted.raw_text", inferredSupplierCountry);
    const llmFallback = summarize();

    if (file.file_type !== "pdf") {
      notes.push("Image receipt OCR-parsed with LiteParse.");
    }
    if (selfVatDetected) {
      notes.push(
        "Document only printed the buyer's VAT (matches active company). Supplier VAT cleared — verify supplier manually before booking (#14).",
      );
    }
    if (selfRegCodeDetected) {
      notes.push(
        "Document only printed the buyer's registry code (matches active company). Supplier reg code cleared — verify supplier manually before booking (#22).",
      );
    }

    if (classification !== "purchase_invoice") {
      const referencedInvoice =
        classification === "payment_receipt"
          ? buildReferencedInvoiceForPaymentReceipt(extracted.invoice_number, context.purchaseInvoices, {
              ...(extracted.supplier_name ? { name: extracted.supplier_name } : {}),
            })
          : undefined;
      notes.push(
        classification === "owner_paid_expense_reimbursement"
          ? "PDF looks like an owner-paid expense receipt. Review manually before booking."
          : classification === "payment_receipt"
            ? `Document is a payment receipt${
                referencedInvoice
                  // invoice_number is OCR-derived; wrap only the interpolated
                  // fragment so it is delimited as data, consistent with how
                  // `error` is wrapped elsewhere (#9).
                  ? ` for invoice ${wrapUntrustedOcr(referencedInvoice.invoice_number) ?? referencedInvoice.invoice_number}`
                  : ""
              }, not a separate purchase invoice. Booking it would duplicate the underlying invoice — attach to the existing invoice document instead (#15).`
            : "Document could not be classified as a supplier purchase invoice.",
      );
      maybeAddLlmFallbackNote(notes, llmFallback);
      return buildNeedsReviewResult(file, classification, extracted, llmFallback, notes, {
        ...(referencedInvoice ? { referenced_invoice: referencedInvoice } : {}),
      });
    }

    if (!hasAutoBookableReceiptFields(extracted)) {
      notes.push("Missing supplier name, confident invoice number, invoice date, or gross total required for auto-booking.");
      maybeAddLlmFallbackNote(notes, llmFallback);
      return buildNeedsReviewResult(file, classification, extracted, llmFallback, notes);
    }

    const ownCompanyOptions = options.ownCompanyVat || options.ownCompanyRegistryCode
      ? {
          ...(options.ownCompanyVat ? { ownCompanyVat: options.ownCompanyVat } : {}),
          ...(options.ownCompanyRegistryCode ? { ownCompanyRegistryCode: options.ownCompanyRegistryCode } : {}),
        }
      : undefined;
    const supplierResolution = await resolveSupplierInternal(
      api,
      context.clients,
      extracted,
      false,
      ownCompanyOptions,
    );
    if (supplierResolution.self_match_blocked) {
      notes.push(
        "Refused to resolve supplier to the active company — manual supplier resolution required (#14).",
      );
    }
    if (!supplierResolution.found) signals.supplier_resolution_failed = true;
    if (!supplierResolution.client && !supplierResolution.preview_client) {
      const fallback = summarize();
      notes.push("Supplier could not be resolved or prepared for creation.");
      maybeAddLlmFallbackNote(notes, fallback);
      return buildNeedsReviewResult(file, classification, extracted, fallback, notes, {
        supplier_resolution: supplierResolution,
      });
    }

    if (supplierCountryNeedsReview(supplierResolution)) {
      const fallback = summarize();
      notes.push("Supplier country could not be inferred from IBAN, VAT number, or OCR country text. Manual review required before booking.");
      maybeAddLlmFallbackNote(notes, fallback);
      return buildNeedsReviewResult(file, classification, extracted, fallback, notes, {
        supplier_resolution: supplierResolution,
      });
    }

    const resolvedClientId = supplierResolution.client?.id;
    if (!resolvedClientId && options.dryRun) {
      notes.push("Dry run: supplier would need to be created before invoice creation.");
    }

    const bookingSuggestion = applyReceiptAutoBookingRule(
      resolvedClientId
      ? await suggestBookingInternal(api, context, resolvedClientId, extracted.description ?? extracted.supplier_name ?? "Receipt expense")
      : buildKeywordSuggestion(
        context.purchaseArticlesWithVat,
        context.accounts,
        `${extracted.description ?? ""} ${extracted.supplier_name ?? ""}`,
      ),
      extracted,
      context,
    );

    if (bookingSuggestion) {
      // #6: if a recent-invoice GET rejected, the booking suggestion may be
      // based on stale history — surface the degradation note so the operator
      // knows the freshest history may be missing.
      if (bookingSuggestion.history_partial_note) {
        notes.push(bookingSuggestion.history_partial_note);
      }
      applyReverseChargeAutoDetection(bookingSuggestion, extracted, supplierResolution, context.isVatRegistered, notes);
      if (bookingSuggestion.reverse_charge_reason === "foreign_supplier_default") {
        signals.foreign_reverse_charge_default_unverified = true;
      }
      signals.booking_from_history = bookingSuggestion.source === "supplier_history";
      if (
        bookingSuggestion.suggested_account?.is_fixed_asset &&
        extracted.total_gross !== undefined &&
        extracted.total_gross < 1000
      ) {
        signals.improbable_fixed_asset = true;
      }
      if (
        detectReverseChargeFromText(extracted.raw_text) &&
        !bookingSuggestion.item.reversed_vat_id
      ) {
        signals.reverse_charge_phrase_unhandled = true;
      }
    }

    if (!bookingSuggestion) {
      const fallback = summarize();
      notes.push("Could not find a purchase article / account suggestion for this receipt.");
      maybeAddLlmFallbackNote(notes, fallback);
      return buildNeedsReviewResult(file, classification, extracted, fallback, notes, {
        supplier_resolution: supplierResolution,
      });
    }

    if (extracted.invoice_number) {
      const myInvoice = extracted.invoice_number.trim().toLowerCase();
      const myRegCode = extracted.supplier_reg_code?.trim();
      const myVat = normalizeVatForCompare(extracted.supplier_vat_no);
      const myNameKey = extracted.supplier_name ? normalizeCompanyName(extracted.supplier_name) : "";
      const earlier = options.previousResults.find(prev => {
        if (prev.extracted?.invoice_number?.trim().toLowerCase() !== myInvoice) return false;
        if (resolvedClientId && prev.supplier_resolution?.client?.id === resolvedClientId) return true;
        if (myRegCode && prev.extracted?.supplier_reg_code?.trim() === myRegCode) return true;
        if (myVat && normalizeVatForCompare(prev.extracted?.supplier_vat_no) === myVat) return true;
        if (myNameKey.length >= 4 && prev.extracted?.supplier_name &&
            normalizeCompanyName(prev.extracted.supplier_name) === myNameKey) return true;
        return false;
      });
      if (earlier) {
        signals.duplicate_invoice_in_batch = true;
      }
    }

    if (resolvedClientId && extracted.invoice_number && extracted.invoice_date && extracted.total_gross !== undefined) {
      const duplicate = findDuplicateInvoice(
        context.purchaseInvoices,
        resolvedClientId,
        extracted.invoice_number,
        extracted.invoice_date,
        extracted.total_gross,
      );
      if (duplicate) {
        return {
          file,
          classification,
          status: "skipped_duplicate",
          extracted,
          llm_fallback: summarize(),
          supplier_resolution: supplierResolution,
          booking_suggestion: bookingSuggestion,
          duplicate_match: duplicate,
          notes: [`Skipped duplicate by ${duplicate.reason}.`],
        };
      }
    }

    const preCreateSummary = summarize();
    const creationGate = shouldGateCreation(preCreateSummary, options.executionMode);
    if (creationGate.gate) {
      const tense = options.dryRun ? "would be skipped" : "skipped";
      notes.push(
        `Auto-create ${tense}: confidence is ${preCreateSummary.confidence} (${creationGate.reason}). Manual review required before booking or confirming (#19).`,
      );
      return buildNeedsReviewResult(file, classification, extracted, preCreateSummary, notes, {
        supplier_resolution: supplierResolution,
        booking_suggestion: bookingSuggestion,
      });
    }

    let materializedSupplierResolution = supplierResolution;
    if (!options.dryRun && !supplierResolution.found && supplierResolution.preview_client) {
      materializedSupplierResolution = await resolveSupplierInternal(
        api,
        context.clients,
        extracted,
        true,
        ownCompanyOptions,
      );
      if (materializedSupplierResolution.self_match_blocked) {
        notes.push(
          "Refused to resolve supplier to the active company — manual supplier resolution required (#14).",
        );
      }
    }

    if (materializedSupplierResolution.self_match_blocked && !materializedSupplierResolution.found) {
      notes.push("Supplier materialization blocked: self-match detected. Manual review required.");
      const fallback = summarize();
      return buildNeedsReviewResult(file, classification, extracted, fallback, notes, {
        supplier_resolution: materializedSupplierResolution,
        booking_suggestion: bookingSuggestion,
      });
    }

    // P17: the legal-entity identity gate refused to auto-create the supplier
    // (no verified Estonian registry code, no explicit natural person, and no
    // operator attestation for a foreign registration). Create NEITHER the
    // supplier NOR the invoice — route to manual review.
    if (materializedSupplierResolution.code === "legal_entity_identity_required" && !materializedSupplierResolution.found) {
      notes.push(
        `Supplier auto-create refused: ${materializedSupplierResolution.reason ?? "a verified legal-entity identity is required"} Manual review required before booking.`,
      );
      const fallback = summarize();
      return buildNeedsReviewResult(file, classification, extracted, fallback, notes, {
        supplier_resolution: materializedSupplierResolution,
        booking_suggestion: bookingSuggestion,
      });
    }

    const created = await createAndMaybeMatchPurchaseInvoice(
      api,
      context,
      snapshot,
      extracted,
      materializedSupplierResolution,
      bookingSuggestion,
      options.bankTransactions,
      options.executionMode,
      options.legacyExecuteCreate,
      options.consumedTransactionIds,
    );

    return {
      file,
      classification,
      status: created.status,
      extracted,
      llm_fallback: summarize(),
      supplier_resolution: materializedSupplierResolution,
      booking_suggestion: bookingSuggestion,
      created_invoice: created.created_invoice,
      bank_match: created.bank_match,
      notes: created.notes,
      error: created.error,
    };
  } catch (error) {
    return {
      file,
      classification: "unclassifiable",
      status: "failed",
      notes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Typed operation facade
// ---------------------------------------------------------------------------

export interface ReceiptBatchOperations {
  scan(input: ReceiptScanRunInput): Promise<OperationOutcome<ReceiptScanResult>>;
  runBatch(input: ReceiptBatchRunInput): Promise<OperationOutcome<ReceiptBatchResult>>;
}

class ReceiptBatchOperationsImpl implements ReceiptBatchOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {
    void this.runtimeSafetyContext;
  }

  async scan(input: ReceiptScanRunInput): Promise<OperationOutcome<ReceiptScanResult>> {
    const scan = await scanReceiptFolderInternal(
      input.resolvedFolderPath,
      input.fileTypes,
      input.dateFrom,
      input.dateTo,
      input.directoryAccessOptions,
    );
    return ok(scan);
  }

  async runBatch(input: ReceiptBatchRunInput): Promise<OperationOutcome<ReceiptBatchResult>> {
    // Snapshot every receipt's bytes ONCE and (for create/confirm) verify the
    // folder still matches the approved manifest before any API mutation. A drift
    // throws `manifest_mismatch` here (propagated, never swallowed).
    const snapshot = await prepareReceiptBatchSnapshot(
      input.resolvedFolderPath,
      undefined,
      input.dateFrom,
      input.dateTo,
      input.approvedManifest,
      input.directoryAccessOptions,
    );
    try {
      const scan = snapshot.scan;
      const vatInfo = await this.api.readonly.getVatInfo();
      const ownCompanyVat = vatInfo.vat_number?.trim() || undefined;
      const context: ReceiptProcessingContext = {
        clients: await this.api.clients.listAll(),
        purchaseInvoices: await this.api.purchaseInvoices.listAll(),
        purchaseArticlesWithVat: await getPurchaseArticlesWithVat(this.api),
        accounts: await this.api.readonly.getAccounts(),
        isVatRegistered: !!vatInfo.vat_number,
      };
      const ownCompanyRegistryCode = deriveOwnCompanyRegistryCode(
        context.clients,
        ownCompanyVat,
        input.ownCompanyName,
      );
      const allTransactions = await this.api.transactions.listAll();
      const bankTransactions = selectBatchBankTransactions(allTransactions, input.accountsDimensionsId, {
        ...(input.transactionDateFrom ? { transaction_date_from: input.transactionDateFrom } : {}),
        ...(input.transactionDateTo ? { transaction_date_to: input.transactionDateTo } : {}),
      });
      const consumedTransactionIds = new Set<number>();
      const results: ReceiptBatchFileResult[] = [];

      for (let index = 0; index < snapshot.files.length; index++) {
        const fileSnapshot = snapshot.files[index]!;
        await reportProgress(index, snapshot.files.length);
        results.push(await processSingleReceipt(this.api, context, fileSnapshot, {
          ownCompanyVat,
          ownCompanyRegistryCode,
          bankTransactions,
          executionMode: input.executionMode,
          legacyExecuteCreate: input.legacyExecuteCreate,
          dryRun: input.dryRun,
          consumedTransactionIds,
          previousResults: results,
        }));
      }

      const summary = buildReceiptBatchSummary({
        executionMode: input.executionMode,
        legacyExecuteCreate: input.legacyExecuteCreate,
        dryRun: input.dryRun,
        scannedFiles: scan.files.length,
        skippedInvalidFiles: scan.skipped.length,
        results,
      });
      const mode = input.dryRun ? "DRY_RUN" : "EXECUTED";

      return ok({
        mode,
        executionMode: input.executionMode,
        scan,
        results,
        summary,
        manifest: snapshot.manifest,
        snapshotFiles: snapshot.files.map(entry => ({ file: entry.file, sha256: entry.sha256 })),
      });
    } finally {
      await snapshot.cleanup();
    }
  }
}

export function createReceiptBatchOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): ReceiptBatchOperations {
  return new ReceiptBatchOperationsImpl(api, runtimeSafetyContext);
}
