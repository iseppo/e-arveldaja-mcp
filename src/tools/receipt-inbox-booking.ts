import { logAudit } from "../audit-log.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { sanitizeUploadFileName } from "../file-validation.js";
import { checkIntakeCashDuplicates, formatDuplicatePostingWarnings } from "../bank-posting-duplicate-guard.js";
import { checkJournalReferences, type JournalReferenceHit } from "../journal-reference-scan.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { roundMoney } from "../money.js";
import { REDUCED_VAT_RATES, STANDARD_VAT_RATE_TIMELINE, standardVatRateOn, vatRatesInForceOn } from "../estonian-tax-rules.js";
import { isProjectTransaction } from "../transaction-status.js";
import { snapshotBankTransaction, compareBankTransactionMaterial, snapshotLinkedInvoice, TransactionMaterialDriftError } from "../banking/transaction-material-snapshot.js";
import { withPurchaseInvoiceLock, scanPurchaseIntakeDuplicates } from "../documents/purchase-invoice-lock.js";
import { draftFingerprint, draftReadbackMismatches } from "../documents/purchase-draft-verification.js";
import { MutationIndeterminateError, describeMutationCause, classifyMutationFailure } from "../mutation-outcome.js";
import { HttpError } from "../http-client.js";
import type { CreatePurchaseInvoiceData, PurchaseInvoice, PurchaseInvoiceItem, Transaction } from "../types/api.js";
import { type ApiContext, tagNotes } from "./crud-tools.js";
import { applyPurchaseVatDefaults } from "./purchase-vat-defaults.js";
import type { BookingSuggestion, ExtractedReceiptFields, InvoiceSummaryForMatching } from "./receipt-extraction.js";
import { amountConsistencyIssues, computeTermDays, snapVatRate } from "./receipt-extraction.js";
import { InvoiceCreationError, PurchaseInvoiceDraftVerificationError, PurchaseInvoiceTotalsCorrectionError, previewPurchaseInvoiceTotals } from "../api/purchase-invoices.api.js";
import { sha256Hex } from "./receipt-inbox-files.js";
import type { SupplierResolution } from "./supplier-resolution.js";
import { findBestTransactionMatch } from "./receipt-inbox-matching.js";
import type {
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptFileSnapshot,
  ReceiptProcessingContext,
} from "./receipt-inbox-types.js";

const EXACT_MATCH_THRESHOLD = 90;

export function buildDryRunCreatedInvoicePreview(invoiceNumber: string) {
  return {
    number: invoiceNumber,
    status: "would_create",
    confirmed: false,
    uploaded_document: false,
  };
}

export async function invalidateAndReport(
  api: ApiContext,
  invoice: Pick<PurchaseInvoice, "id">,
  notes: string[],
  messages: {
    reason: string;
    onInvalidated: (invoiceId: number) => string;
    onInvalidationFailed: (invoiceId: number, invalidateMessage: string) => string;
  },
): Promise<string | undefined> {
  if (!invoice.id) return undefined;
  try {
    await api.purchaseInvoices.invalidate(invoice.id);
    notes.push(messages.onInvalidated(invoice.id));
    return undefined;
  } catch (invalidateError) {
    const invalidateMessage = invalidateError instanceof Error ? invalidateError.message : String(invalidateError);
    notes.push(messages.onInvalidationFailed(invoice.id, invalidateMessage));
    return invalidateMessage;
  }
}

function buildSyntheticItem(
  suggestion: BookingSuggestion,
  description: string,
  amount: number,
  purchaseArticlesWithVat: ReceiptProcessingContext["purchaseArticlesWithVat"],
  isVatRegistered: boolean,
  vatRateDropdown?: string,
): PurchaseInvoiceItem {
  return applyPurchaseVatDefaults(
    purchaseArticlesWithVat,
    {
      ...suggestion.item,
      total_net_price: amount,
      custom_title: description,
      vat_rate_dropdown: vatRateDropdown ?? suggestion.item.vat_rate_dropdown ?? "-",
    },
    isVatRegistered,
  );
}

function numericVatRate(dropdown: string | undefined | null): number | undefined {
  if (dropdown === undefined || dropdown === null) return undefined;
  const parsed = Number(String(dropdown).replace(",", ".").replace("%", "").trim());
  return String(dropdown).trim() !== "" && String(dropdown).trim() !== "-" && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * VAT rate for the synthetic receipt item, derived from the extracted totals
 * and the invoice date — never copied blindly from history (a 22% history row
 * on a 24% receipt) or defaulted to "-" when VAT was charged (keyword path).
 * Returns `review` when the extracted VAT does not snap to the standard rate in
 * force on the invoice date or a valid reduced rate.
 */
export function resolveReceiptVatRateDropdown(
  extracted: Pick<ExtractedReceiptFields, "total_vat" | "invoice_date">,
  netAmount: number,
  suggestionItem: Pick<PurchaseInvoiceItem, "vat_rate_dropdown" | "reversed_vat_id">,
): { rate?: string; review?: string } {
  const standardRate = standardVatRateOn(extracted.invoice_date);
  const isReverseCharge = suggestionItem.reversed_vat_id !== undefined && suggestionItem.reversed_vat_id !== null;
  if (extracted.total_vat === undefined) return {};
  if (extracted.total_vat === 0) {
    if (!isReverseCharge) return { rate: "-" };
    // Reverse charge: the supplier charges no VAT but the buyer self-assesses
    // at the real rate — "-" would drop the self-assessment.
    // The history rate is kept only when it is a reduced rate in force on the
    // invoice date; a history standard rate (20/22 from before a rate change)
    // is replaced by the standard rate in force on the invoice date.
    if (standardRate === null) {
      return { review: "Reverse-charge receipt has no valid invoice date to derive the self-assessed VAT rate." };
    }
    const historyRate = numericVatRate(suggestionItem.vat_rate_dropdown);
    if (historyRate === undefined || historyRate <= 0
      || STANDARD_VAT_RATE_TIMELINE.some(period => period.rate === historyRate)) {
      return { rate: String(standardRate) };
    }
    const reverseChargeDate = extracted.invoice_date ?? "";
    if (REDUCED_VAT_RATES.some(reduced => reduced.rate === historyRate
      && (reduced.from === null || reverseChargeDate >= reduced.from))) {
      return { rate: String(historyRate) };
    }
    return {
      review: `Reverse-charge receipt: the supplier's history VAT rate ${historyRate}% is neither the standard rate ` +
        `${standardRate}% nor a reduced rate in force on the invoice date; confirm the self-assessed rate.`,
    };
  }
  const candidates = vatRatesInForceOn(extracted.invoice_date).filter(rate => rate > 0);
  const snapped = snapVatRate(netAmount, extracted.total_vat, candidates);
  if (snapped === undefined) {
    const implied = netAmount > 0 ? roundMoney(extracted.total_vat / netAmount * 100) : undefined;
    return {
      review: `Extracted VAT ${extracted.total_vat} on net ${netAmount}${implied !== undefined ? ` implies ${implied}%` : ""}, ` +
        `which matches neither the standard rate${standardRate !== null ? ` ${standardRate}%` : ""} in force on the invoice date nor a valid reduced rate.`,
    };
  }
  return { rate: String(snapped) };
}

/**
 * The pure amount checks of an automatic receipt booking, run before ANY write
 * (the batch flow calls it before materializing a supplier as well):
 * - the receipt SOURCE gate: extracted amount_consistency_issues, or
 *   amountConsistencyIssues of the final totals, hold the row in every mode and
 *   for both VAT-registration states;
 * - the VAT-rate review for a VAT-registered company;
 * - createAndSetTotals' own totals rules on the synthetic item
 *   (previewPurchaseInvoiceTotals).
 * Notes carry codes and numbers only (no untrusted text).
 */
export function prepareReceiptInvoiceItem(
  context: Pick<ReceiptProcessingContext, "isVatRegistered" | "purchaseArticlesWithVat">,
  extracted: ExtractedReceiptFields,
  bookingSuggestion: BookingSuggestion,
  description: string,
): { ok: true; item: PurchaseInvoiceItem; grossTotal: number } | { ok: false; notes: string[] } {
  const itemNetAmount = extracted.total_net
    ?? (extracted.total_gross !== undefined && extracted.total_vat !== undefined
      ? roundMoney(extracted.total_gross - extracted.total_vat)
      : undefined);
  if (itemNetAmount === undefined || extracted.total_gross === undefined) {
    return { ok: false, notes: ["Could not derive reliable net/gross totals for invoice creation."] };
  }

  const vatRate = resolveReceiptVatRateDropdown(extracted, itemNetAmount, bookingSuggestion.item);
  const sourceIssues = [...new Set([
    ...(extracted.amount_consistency_issues ?? []),
    ...amountConsistencyIssues({ ...extracted, total_net: itemNetAmount }),
  ])];
  if (sourceIssues.length > 0) {
    return {
      ok: false,
      notes: [
        `Held: the extracted amounts are inconsistent (${sourceIssues.join(", ")}; net ${itemNetAmount}, ` +
        `VAT ${extracted.total_vat ?? "none"}, gross ${extracted.total_gross}). Verify the totals and book this document ` +
        "with process_accounting_document.",
        ...(vatRate.review ? [vatRate.review] : []),
      ],
    };
  }

  if (vatRate.review && context.isVatRegistered) {
    return { ok: false, notes: [vatRate.review] };
  }

  const item = buildSyntheticItem(
    bookingSuggestion,
    description,
    // Fold non-deductible source VAT into the expense cost. A rate "-"
    // row has no computed VAT: its accounting net must equal payable gross.
    context.isVatRegistered ? itemNetAmount : extracted.total_gross,
    context.purchaseArticlesWithVat,
    context.isVatRegistered,
    vatRate.rate,
  );

  // Only an EUR receipt reaches createAndSetTotals (a non-EUR one is held
  // before create), so the preview is for EUR.
  const totalsPreview = previewPurchaseInvoiceTotals(
    { items: [item], cl_currencies_id: "EUR" } as CreatePurchaseInvoiceData,
    extracted.total_vat,
    extracted.total_gross,
    context.isVatRegistered,
  );
  if (!totalsPreview.ok) {
    return { ok: false, notes: [`Held (${totalsPreview.code}): ${totalsPreview.message}`] };
  }
  return { ok: true, item, grossTotal: extracted.total_gross };
}

export async function createAndMaybeMatchPurchaseInvoice(
  api: ApiContext,
  context: ReceiptProcessingContext,
  snapshot: ReceiptFileSnapshot,
  extracted: ExtractedReceiptFields,
  supplierResolution: SupplierResolution,
  bookingSuggestion: BookingSuggestion,
  bankTransactions: Transaction[],
  executionMode: ReceiptBatchExecutionMode,
  legacyExecuteCreate: boolean,
  consumedTransactionIds: Set<number>,
): Promise<Pick<ReceiptBatchFileResult, "created_invoice" | "creation_partial" | "bank_match" | "bank_partial" | "notes" | "status" | "error" | "possible_duplicate_journal_ids" | "referencing_journal_ids" | "referencing_journals" | "journal_reference_scan_unavailable">> {
  const file = snapshot.file;
  // The inbox dir-entry name is untrusted (control chars, odd bytes): upload and
  // audit it only in sanitized form.
  const uploadFileName = sanitizeUploadFileName(file.name);
  const notes: string[] = [];
  const dryRun = executionMode === "dry_run";
  const shouldConfirm = executionMode === "create_and_confirm";
  const supplier = supplierResolution.client;
  const supplierId = supplier?.id;
  const supplierName = supplier?.name ?? supplierResolution.preview_client?.name;
  const invoiceCurrency = extracted.currency ?? "EUR";
  // Never the source filename (user preference): the file name is not a
  // description of the purchase.
  const invoiceNotes = "Receipt inbox import";

  if (!supplierName) {
    notes.push("Supplier resolution did not return a concrete client ID.");
    return { notes, status: "needs_review" };
  }
  if (invoiceCurrency !== "EUR") {
    notes.push(
      `Non-EUR receipt currency ${invoiceCurrency} requires an explicit currency_rate before automatic invoice creation. Review manually or create the invoice with the correct EUR conversion rate.`
    );
    return { notes, status: "needs_review" };
  }
  if (!extracted.invoice_number || !extracted.invoice_date) {
    notes.push("Missing a confident supplier invoice number required for auto-booking.");
    return { notes, status: "needs_review" };
  }

  if (extracted.due_date && extracted.due_date < extracted.invoice_date) {
    notes.push(`Due date ${extracted.due_date} precedes invoice date ${extracted.invoice_date}; payment term set to 0 days — verify the dates.`);
  }

  // P2 E1b: the single point where the booked line is built, after supplier
  // resolution or creation. A generated description (possibly a logo word such
  // as "PRINT") is replaced by the bound client's name: an existing client, or
  // one just created under its registry-verified name (E1). A document or
  // operator description, and the extracted supplier_name, are never changed.
  const description = extracted.description_source === "generated" && supplier?.name
    ? `Expense from ${supplier.name}`
    : extracted.description ?? `Expense from ${supplierName}`;
  const prepared = prepareReceiptInvoiceItem(
    context,
    extracted,
    bookingSuggestion,
    description,
  );
  if (!prepared.ok) {
    notes.push(...prepared.notes);
    return { notes, status: "needs_review" };
  }
  const item = prepared.item;

  const invoiceDraft: InvoiceSummaryForMatching = {
    clients_id: supplierId,
    client_name: supplierName,
    cl_currencies_id: invoiceCurrency,
    number: extracted.invoice_number,
    create_date: extracted.invoice_date,
    gross_price: extracted.total_gross,
    bank_ref_number: extracted.ref_number,
  };

  // Task 6: cross-mechanism intake duplicate guard — catches the incident at
  // the EARLIEST moment (the dry-run preview, before any invoice exists), and
  // again at execute right before the create. Currency is guaranteed EUR here
  // (a non-EUR receipt already returned needs_review above), so the extracted
  // gross total IS the EUR figure — no conversion, never a guessed rate.
  // A batch has no person looking at each row, so a suspect HOLDS the row as
  // needs_review in both modes (unlike the advisory single-document tools);
  // an unavailable scan keeps its note and never holds. Returns the suspect
  // journal ids.
  const grossTotal = prepared.grossTotal;
  const invoiceDate = extracted.invoice_date;
  const appendIntakeDuplicateNotes = async (): Promise<number[]> => {
    const duplicateScan = await checkIntakeCashDuplicates(api, {
      grossAmountEur: grossTotal,
      invoiceDate,
    });
    if (duplicateScan.suspects.length > 0) {
      notes.push(...formatDuplicatePostingWarnings(
        duplicateScan,
        { accountId: -1, dimensionId: null, amount: grossTotal, direction: "C", date: invoiceDate },
        t => wrapUntrustedOcr(t) ?? "",
      ));
    } else if (!duplicateScan.scan_available && duplicateScan.scan_note) {
      notes.push(duplicateScan.scan_note);
    }
    return [...new Set(duplicateScan.suspects.map(suspect => suspect.journal_id))];
  };
  // A live journal whose document_number or title carries this invoice number
  // (e.g. a manual prepayment journal `ETR1:EE1966453`) may already book this
  // document — the cash scan cannot see it (no bank posting in the window).
  // Same policy: holds in both modes. An unavailable scan is retried once and,
  // still unavailable, holds too: no person reads each row, so an unchecked
  // row must not be created. Only the final scan note is kept.
  const invoiceNumber = extracted.invoice_number;
  const findReferencingJournals = async (): Promise<{ hits: JournalReferenceHit[]; unavailable: boolean }> => {
    let referenceScan = await checkJournalReferences(api, [invoiceNumber]);
    if (!referenceScan.scan_available) referenceScan = await checkJournalReferences(api, [invoiceNumber]);
    if (!referenceScan.scan_available && referenceScan.scan_note) notes.push(referenceScan.scan_note);
    return { hits: referenceScan.hits, unavailable: !referenceScan.scan_available };
  };
  // Both scans run before any hold so a held row reports both id lists.
  const holdIfAlreadyBooked = async () => {
    const suspects = await appendIntakeDuplicateNotes();
    const { hits: referencing, unavailable: referenceScanUnavailable } = await findReferencingJournals();
    if (suspects.length === 0 && referencing.length === 0 && !referenceScanUnavailable) return undefined;
    if (suspects.length > 0) {
      notes.push(
        `Held: this cash outflow may already be booked by journal(s) ${suspects.join(", ")}. ` +
        "If it is a separate payment, book this one document on its own (process_accounting_document, or create_purchase_invoice_from_pdf on the standard surface).",
      );
    }
    const referencingIds = referencing.map(hit => hit.journal_id);
    if (referencingIds.length > 0) {
      notes.push(
        `Held: journal(s) ${referencingIds.join(", ")} already reference invoice number ${wrapUntrustedOcr(invoiceNumber) ?? ""}; ` +
        "this document may already be booked. Attach it to that journal (attach_document entity_type=journal on the standard surface, or in the e-arveldaja UI) instead of creating an invoice.",
      );
    }
    if (referenceScanUnavailable) {
      notes.push(
        "Held: the journal reference scan was unavailable (twice), so journals that may already book this invoice number were not checked. " +
        "Re-run the batch, or book this document on its own (process_accounting_document, or create_purchase_invoice_from_pdf on the standard surface).",
      );
    }
    return {
      notes,
      status: "needs_review" as const,
      ...(suspects.length > 0 ? { possible_duplicate_journal_ids: suspects } : {}),
      ...(referenceScanUnavailable ? { journal_reference_scan_unavailable: true } : {}),
      ...(referencingIds.length > 0
        ? {
            referencing_journal_ids: referencingIds,
            referencing_journals: referencing.map(hit => ({
              journal_id: hit.journal_id,
              matched_field: hit.matched_field,
              document_number: hit.document_number,
              title: hit.title,
            })),
          }
        : {}),
    };
  };

  // The dry run scans before reserving a bank candidate, so a held row does
  // not take a transaction another row could preview.
  if (dryRun) {
    const held = await holdIfAlreadyBooked();
    if (held) return held;
  }

  const dryRunMatch = findBestTransactionMatch(bankTransactions, invoiceDraft, consumedTransactionIds);
  const candidate = dryRunMatch?.candidate;
  const approvedTransaction = candidate ? bankTransactions.find(tx => tx.id === candidate.transaction_id) : undefined;
  const approvedSnapshot = approvedTransaction ? snapshotBankTransaction(approvedTransaction) : undefined;
  const approvedClientTransition = approvedSnapshot && supplierId !== undefined && approvedSnapshot.clients_id !== supplierId
    ? { from: approvedSnapshot.clients_id, to: supplierId } : undefined;

  if (dryRun) {
    if (candidate) {
      // Reserve the candidate the same way execute does (consumedTransactionIds)
      // when it would meet the execute-time auto-link criteria, so a second
      // receipt in the same dry-run can't also preview linking this exact
      // transaction. Mirror the execute-path canAutoLink guard (#2).
      const crossCurrencyMatch =
        candidate.reasons.includes("exact_base_amount") &&
        !candidate.reasons.includes("exact_amount");
      const wouldAutoLink =
        candidate.confidence >= EXACT_MATCH_THRESHOLD && !crossCurrencyMatch;
      if (wouldAutoLink) {
        consumedTransactionIds.add(candidate.transaction_id);
      }
      notes.push(`Dry run: matched candidate transaction ${candidate.transaction_id} at confidence ${candidate.confidence}.`);
    } else if (dryRunMatch?.ambiguous) {
      notes.push(`Dry run: ${dryRunMatch.tiedCount} bank transactions tied at confidence ${dryRunMatch.topConfidence}; no candidate auto-selected.`);
    }
    notes.push("Dry run: purchase invoice document was not uploaded and the invoice was not confirmed.");

    return {
      notes,
      status: "dry_run_preview",
      created_invoice: buildDryRunCreatedInvoicePreview(extracted.invoice_number),
      bank_match: candidate || dryRunMatch.ambiguous ? { candidate, linked: false, ambiguous: dryRunMatch.ambiguous,
        top_confidence: dryRunMatch.topConfidence, tied_count: dryRunMatch.tiedCount } : undefined,
    };
  }

  if (!supplierId || !supplier) {
    notes.push("Supplier resolution did not return a concrete client ID.");
    return { notes, status: "needs_review" };
  }

  // Uncached, right before the create: the execute projection pass refilled
  // the journal list cache, and a payment booked since then must be seen.
  if (legacyExecuteCreate) {
    notes.push('Legacy execute=true maps to execution_mode="create"; invoice will be created and uploaded but left unconfirmed (#19).');
  }

  let createdInvoice!: PurchaseInvoice;
  let preUploadInvoice!: PurchaseInvoice;
  const invoiceModel: CreatePurchaseInvoiceData = {
    clients_id: supplierId, client_name: supplier.name, number: invoiceNumber,
    create_date: invoiceDate, journal_date: invoiceDate, term_days: computeTermDays(invoiceDate, extracted.due_date),
    cl_currencies_id: invoiceCurrency,
    liability_accounts_id: bookingSuggestion.suggested_liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
    bank_ref_number: extracted.ref_number, bank_account_no: extracted.supplier_iban,
    notes: tagNotes(invoiceNotes), items: [item],
  };
  let uploadedDocument = false;
  const describe = (cause: unknown) => {
    const original = cause instanceof PurchaseInvoiceDraftVerificationError && cause.cause !== undefined ? cause.cause : cause;
    return { ...(original instanceof MutationIndeterminateError ? original.cause : describeMutationCause(original)),
      ...(original instanceof HttpError && original.upstream_detail !== undefined ? { upstream_detail: original.upstream_detail } : {}) };
  };
  const heldCreated = (changed: readonly string[], error?: unknown, uploadUncertain = false) => {
    notes.push(`Held purchase invoice ${createdInvoice.id}: material verification failed (${changed.join(", ")}). Reuse this invoice after fresh review; automatic retry is forbidden. No automatic invalidation was attempted.`);
    context.purchaseInvoices.push(createdInvoice);
    const creation_partial: NonNullable<ReceiptBatchFileResult["creation_partial"]> = {
      created_invoice_id: createdInvoice.id, mutation_occurred: true, automatic_retry_forbidden: true, cleanup: "unknown",
      follow_up: error !== undefined ? describe(error) : { name: "ReceiptVerificationHold", message: changed.join(", ") },
    };
    return { notes, status: "needs_review" as const, creation_partial,
      created_invoice: { id: createdInvoice.id, number: createdInvoice.number, status: createdInvoice.status,
        confirmed: createdInvoice.status === "CONFIRMED", ...(!uploadUncertain ? { uploaded_document: uploadedDocument } : {}) },
      bank_match: candidate ? { candidate, linked: false } : undefined };
  };
  const rollbackCreatedInvoice = async (reason: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // The API error message is untrusted upstream text; wrap only the
    // interpolated fragment when it goes into a `notes[]` string (which is not
    // wrapped at MCP output, unlike the `error` field), keeping the
    // server-authored template clean — consistent with how `error` is wrapped.
    const wrappedMessage = wrapUntrustedOcr(message) ?? message;

    if (!createdInvoice.id) {
      return {
        notes,
        status: "failed" as const,
        error: message,
      };
    }

    const invalidateMessage = await invalidateAndReport(api, createdInvoice, notes, {
      reason,
      onInvalidated: invoiceId => `Invalidated created purchase invoice ${invoiceId} because ${reason}: ${wrappedMessage}.`,
      onInvalidationFailed: (invoiceId, failedMessage) =>
        `Created purchase invoice ${invoiceId} could not be invalidated after ${reason}: ${wrappedMessage}. ` +
        `Automatic invalidation also failed: ${wrapUntrustedOcr(failedMessage) ?? failedMessage}.`,
    });
    if (!invalidateMessage) {
      return {
        notes,
        status: "failed" as const,
        error: message,
      };
    }
    return {
      notes,
      status: "failed" as const,
      error: `${message}; automatic invalidation failed: ${invalidateMessage}`,
      created_invoice: {
        id: createdInvoice.id,
        number: createdInvoice.number,
        status: createdInvoice.status,
        confirmed: false,
        uploaded_document: uploadedDocument,
      },
    };
  };

  // Keep duplicate scans, create/readback, upload and upload-failure cleanup in
  // one FIFO. A waiter must not mistake a soon-to-be-invalidated draft for the
  // completed intake of the first writer.
  const creationOutcome = await withPurchaseInvoiceLock(api, async () => {
    api.journals.invalidateListCache();
    const held = await holdIfAlreadyBooked();
    if (held) return held;
    const duplicates = await scanPurchaseIntakeDuplicates(api, { supplierClientId: supplierId, invoiceNumber, grossPrice: grossTotal, invoiceDate, currency: invoiceCurrency });
    if (duplicates.comparisonUnavailable?.length) {
      notes.push(`Held: purchase invoice duplicate comparison requires supplied valid ${duplicates.comparisonUnavailable.join(", ")} when the invoice number is blank. Correct the document data before creating an invoice.`);
      return { notes, status: "needs_review" as const };
    }
    if (duplicates.invoiceIds.length) {
      notes.push(`Held: existing purchase invoice(s) ${duplicates.invoiceIds.join(", ")} match this receipt. Reuse the existing invoice.`);
      return { notes, status: "needs_review" as const };
    }
    try {
      createdInvoice = await api.purchaseInvoices.createAndSetTotals(invoiceModel, extracted.total_vat, extracted.total_gross, context.isVatRegistered);
      preUploadInvoice = structuredClone(createdInvoice);
      logAudit({ tool: "process_receipt_batch", action: "CREATED", entity_type: "purchase_invoice", entity_id: createdInvoice.id,
        summary: `Receipt batch: created invoice "${invoiceNumber}" from ${supplier.name}`,
        details: { supplier_name: supplier.name, invoice_number: invoiceNumber, invoice_date: invoiceDate, total_vat: extracted.total_vat, total_gross: extracted.total_gross, file_name: uploadFileName } });
    } catch (error) {
      if (error instanceof InvoiceCreationError) {
        const creation_partial: NonNullable<ReceiptBatchFileResult["creation_partial"]> = {
          created_invoice_id: error.invoiceId, mutation_occurred: true, automatic_retry_forbidden: true,
          cleanup: error.cleanup,
          follow_up: describe(error.cause),
          ...(error.cleanupError !== undefined ? { cleanup_error: describe(error.cleanupError) } : {}),
        };
        logAudit({ tool: "process_receipt_batch", action: "CREATED", entity_type: "purchase_invoice", entity_id: error.invoiceId,
          summary: `Receipt invoice created; follow-up failed; cleanup ${error.cleanup}. Review the known invoice before any retry.`,
          details: { invoice_number: invoiceNumber, file_name: uploadFileName, follow_up_failed: true, cleanup: error.cleanup,
            automatic_retry_forbidden: true } });
        if (error.cleanup === "invalidated") logAudit({ tool: "process_receipt_batch", action: "INVALIDATED", entity_type: "purchase_invoice", entity_id: error.invoiceId,
          summary: "Created receipt draft invalidated after failed follow-up.", details: { follow_up_failed: true } });
        return { notes, status: "failed" as const, error: error.message, creation_partial,
          created_invoice: { id: error.invoiceId, number: invoiceNumber, confirmed: false, uploaded_document: false } };
      }
      if (error instanceof MutationIndeterminateError) {
        logAudit({ tool: "process_receipt_batch", action: "MUTATION_INDETERMINATE", entity_type: "purchase_invoice",
          summary: "Receipt creation outcome unknown. Reconcile the source and invoice business key before any retry.",
          details: { invoice_number: invoiceNumber, supplier_client_id: supplierId, total_gross: extracted.total_gross,
            automatic_retry_forbidden: true } });
        return { notes, status: "failed" as const, error: error.message,
          creation_partial: { mutation_may_have_occurred: true, automatic_retry_forbidden: true, cleanup: "unknown", follow_up: describe(error) } as const };
      }
      return { notes, status: "failed" as const, error: error instanceof Error ? error.message : String(error) };
    }
    if (createdInvoice.id) {
      try {
        const contents = snapshot.bytes.toString("base64");
        await api.purchaseInvoices.uploadDocument(createdInvoice.id, uploadFileName, contents);
        uploadedDocument = true;
        notes.push("Uploaded source document to created purchase invoice.");
        logAudit({
          tool: "process_receipt_batch", action: "UPLOADED", entity_type: "purchase_invoice",
          entity_id: createdInvoice.id,
          summary: `Uploaded document "${uploadFileName}" to purchase invoice ${createdInvoice.id}`,
          details: { file_name: uploadFileName },
        });
      } catch (error) {
        if (classifyMutationFailure(error) === "indeterminate") return heldCreated(["source_document_upload_unknown"], error, true);
        return rollbackCreatedInvoice("source document upload failed", error);
      }
    }
    return undefined;
  });
  if (creationOutcome) return creationOutcome;

  if (!shouldConfirm) {
    notes.push("Created purchase invoice was left unconfirmed. Review it and call confirm_purchase_invoice after approval (#19).");
    context.purchaseInvoices.push(createdInvoice);
    return {
      notes,
      status: "created",
      created_invoice: {
        id: createdInvoice.id,
        number: createdInvoice.number,
        status: createdInvoice.status,
        confirmed: false,
        uploaded_document: uploadedDocument,
      },
    };
  }

  const checkApprovedBank = async () => {
    if (!candidate || !approvedSnapshot) return undefined;
    api.transactions.invalidateListCache();
    const fresh = await api.transactions.get(candidate.transaction_id);
    const comparison = compareBankTransactionMaterial(approvedSnapshot, fresh);
    const score = findBestTransactionMatch([fresh], { ...invoiceDraft, ...createdInvoice }, new Set());
    if (!comparison.ok) return comparison.changedFields;
    if (!isProjectTransaction(fresh) || comparison.snapshot.trusted_direction !== "outgoing") return ["status", "trusted_direction"];
    if (!score.candidate || score.ambiguous || score.candidate.confidence < EXACT_MATCH_THRESHOLD ||
      (score.candidate.reasons.includes("exact_base_amount") && !score.candidate.reasons.includes("exact_amount"))) return ["match_score"];
    return undefined;
  };
  if (candidate) {
    try { const drift = await checkApprovedBank(); if (drift) return heldCreated(drift); }
    catch { return heldCreated(["transaction_read_unavailable"]); }
  }
  if (createdInvoice.id) {
    try {
      api.purchaseInvoices.invalidateListCache();
      const freshDraft = await api.purchaseInvoices.get(createdInvoice.id);
      const mismatches = draftReadbackMismatches(freshDraft, invoiceModel, { vatPrice: extracted.total_vat, grossPrice: extracted.total_gross }, context.isVatRegistered, context.accounts);
      if (freshDraft.id !== createdInvoice.id || freshDraft.status !== "PROJECT" || mismatches.length) {
        createdInvoice = { ...createdInvoice, status: freshDraft.status };
        return heldCreated(["purchase_invoice_material", ...mismatches]);
      }
      const fileId = freshDraft.base_document_files_id;
      if (preUploadInvoice.base_document_files_id != null || !Number.isInteger(fileId) || fileId! <= 0 ||
          draftFingerprint({ ...preUploadInvoice, base_document_files_id: fileId }) !== draftFingerprint(freshDraft)) {
        return heldCreated(["purchase_invoice_upload_transition"]);
      }
      const document = await api.purchaseInvoices.getDocument(createdInvoice.id);
      const encodedLimit = Math.ceil(snapshot.bytes.length / 3) * 4;
      if (typeof document?.contents !== "string" || document.contents.length > encodedLimit + 1024) return heldCreated(["source_document_readback_mismatch"]);
      const encoded = document.contents.replace(/\s/g, "");
      if (encoded.length !== encodedLimit) return heldCreated(["source_document_readback_mismatch"]);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== snapshot.bytes.length || bytes.toString("base64") !== encoded || sha256Hex(bytes) !== snapshot.sha256) return heldCreated(["source_document_readback_mismatch"]);
      api.purchaseInvoices.invalidateListCache();
      const verifiedDraft = await api.purchaseInvoices.get(createdInvoice.id);
      if (verifiedDraft.id !== createdInvoice.id || verifiedDraft.status !== "PROJECT" || draftFingerprint(verifiedDraft) !== draftFingerprint(freshDraft)) return heldCreated(["source_document_attachment_changed"]);
      createdInvoice = verifiedDraft;
    } catch (error) { return heldCreated(["purchase_invoice_or_document_read_unavailable"], error); }
  }
  const intendedInvoiceFingerprint = draftFingerprint(createdInvoice);
  if (candidate) {
    try { const drift = await checkApprovedBank(); if (drift) return heldCreated(drift); }
    catch (error) { return heldCreated(["transaction_read_unavailable"], error); }
  }

  if (createdInvoice.id) {
    try {
      await api.purchaseInvoices.confirmWithTotals(createdInvoice.id, context.isVatRegistered, { expectedDraftFingerprint: intendedInvoiceFingerprint });
      createdInvoice = {
        ...createdInvoice,
        status: "CONFIRMED",
      };
      notes.push("Confirmed created purchase invoice for booking and bank matching.");
      logAudit({
        tool: "process_receipt_batch", action: "CONFIRMED", entity_type: "purchase_invoice",
        entity_id: createdInvoice.id,
        summary: `Confirmed purchase invoice ${createdInvoice.id} (${createdInvoice.number ?? ""})`,
        details: { invoice_number: createdInvoice.number, file_name: uploadFileName },
      });
    } catch (error) {
      if (error instanceof PurchaseInvoiceDraftVerificationError || error instanceof PurchaseInvoiceTotalsCorrectionError) {
        return heldCreated([error.code], error);
      }
      return rollbackCreatedInvoice("invoice confirmation failed", error);
    }
  }

  const matchedInvoice: InvoiceSummaryForMatching = {
    id: createdInvoice.id,
    clients_id: createdInvoice.clients_id,
    client_name: createdInvoice.client_name,
    cl_currencies_id: createdInvoice.cl_currencies_id,
    number: createdInvoice.number,
    create_date: createdInvoice.create_date,
    gross_price: createdInvoice.gross_price,
    base_gross_price: createdInvoice.base_gross_price,
    bank_ref_number: createdInvoice.bank_ref_number,
  };
  const matchResult = findBestTransactionMatch(bankTransactions, matchedInvoice, consumedTransactionIds);
  const matchedCandidate = candidate;
  // Cross-currency guard: when the match survived only on base-currency evidence
  // (base amounts equal but nominal amounts differ), the transaction amount is
  // in a different currency than the invoice gross. Auto-confirming would post
  // the invoice's EUR figure against a foreign-currency transaction — the wrong
  // distribution amount. Surface for manual review instead. Same guard the
  // sibling bank-reconciliation auto-confirm path applies.
  const crossCurrencyMatch =
    matchedCandidate !== undefined &&
    matchedCandidate.reasons.includes("exact_base_amount") &&
    !matchedCandidate.reasons.includes("exact_amount");
  const canAutoLink =
    matchedCandidate !== undefined &&
    matchedCandidate.confidence >= EXACT_MATCH_THRESHOLD &&
    !crossCurrencyMatch;
  let linked = false;
  if (matchResult.ambiguous) {
    notes.push(`Skipped bank match because ${matchResult.tiedCount} candidate transactions tied at confidence ${matchResult.topConfidence}; invoice was created without bank link.`);
  } else if (crossCurrencyMatch && matchedCandidate) {
    notes.push(`Skipped auto-link of transaction ${matchedCandidate.transaction_id}: cross-currency match (base-amount only). Compute the correct distribution amount manually before confirming; invoice was created without bank link.`);
  }
  if (createdInvoice.id && matchedCandidate && canAutoLink) {
    try {
      const freshMatch = await api.transactions.get(matchedCandidate.transaction_id);
      const drift = await checkApprovedBank();
      if (drift) return heldCreated(drift);
      const freshInvoice = await api.purchaseInvoices.get(createdInvoice.id);
      if (freshInvoice.status !== "CONFIRMED" || draftFingerprint(freshInvoice) !== intendedInvoiceFingerprint) {
        createdInvoice = { ...createdInvoice, status: freshInvoice.status };
        return heldCreated(["purchase_invoice_material"]);
      }
      // Confirming books a payment, so it needs a proven outgoing row. Without
      // a signed statement marker the direction is unknown (the API reads every
      // type back as "C") — a same-amount supplier refund must not be booked
      // as the payment.
      const matchDirection = snapshotBankTransaction(freshMatch).trusted_direction;
      if (isProjectTransaction(freshMatch) && matchDirection !== "outgoing") {
        notes.push(`Matched transaction ${matchedCandidate.transaction_id} has no signed outgoing direction (direction: ${matchDirection}); invoice was created without bank link — confirm the payment after checking it.`);
      } else if (isProjectTransaction(freshMatch)) {
        // The invoice was just created from the receipt for its own supplier,
        // while the matched transaction's client came from bank counterparty
        // resolution. The supplier owns the payable sub-ledger, so this
        // plan-approved flow moves the transaction to it rather than refusing.
        const clientReassignedToInvoice =
          freshMatch.clients_id != null && freshMatch.clients_id !== createdInvoice.clients_id;
        await api.transactions.confirm(matchedCandidate.transaction_id, [{
          related_table: "purchase_invoices",
          related_id: createdInvoice.id,
          amount: createdInvoice.base_gross_price ?? createdInvoice.gross_price ?? matchedCandidate.amount,
        }], { reassignClientToInvoice: approvedClientTransition !== undefined, approvedClientTransition,
          expectedTransaction: approvedSnapshot,
          expectedLinkedInvoices: { [`purchase_invoices:${createdInvoice.id}`]: snapshotLinkedInvoice("purchase_invoices", freshInvoice) } });
        logAudit({
          tool: "process_receipt_batch", action: "CONFIRMED", entity_type: "transaction",
          entity_id: matchedCandidate.transaction_id,
          summary: `Receipt batch: confirmed transaction ${matchedCandidate.transaction_id} against invoice ${createdInvoice.id}`,
          details: {
            amount: matchedCandidate.amount,
            invoice_id: createdInvoice.id,
            ...(clientReassignedToInvoice ? { client_reassigned_to_invoice: true } : {}),
          },
        });
        consumedTransactionIds.add(matchedCandidate.transaction_id);
        linked = true;
        notes.push(`Linked transaction ${matchedCandidate.transaction_id} to purchase invoice ${createdInvoice.id}.`);
        if (clientReassignedToInvoice) {
          notes.push(
            `Transaction ${matchedCandidate.transaction_id}: payer client ${freshMatch.clients_id} replaced by supplier client `
            + `${createdInvoice.clients_id} so the payable is booked under the invoice's supplier (bank payer name kept).`
          );
        }
      } else {
        notes.push(`Matched transaction ${matchedCandidate.transaction_id} is no longer bookable (status ${freshMatch.status ?? "UNKNOWN"}); invoice was created without bank link.`);
      }
    } catch (error) {
      if (error instanceof TransactionMaterialDriftError) return { ...heldCreated(error.changed_fields), bank_partial: {
        transaction_id: error.transaction_id, category: error.category, register_attempted: false,
        mutation_occurred: error.mutation_occurred, changed_fields: error.changed_fields,
        known_objects: error.known_objects, client_update: error.client_update,
        automatic_retry_forbidden: true, fresh_preview_required: true,
      } };
      if (error instanceof MutationIndeterminateError && error.entity === "transaction" && error.operation === "update") return {
        ...heldCreated(["client_update_indeterminate"]), bank_partial: {
          transaction_id: matchedCandidate.transaction_id, category: "mutation_indeterminate", register_attempted: false,
          mutation_occurred: false, mutation_may_have_occurred: true, changed_fields: ["clients_id"], known_objects: [], client_update: null,
          automatic_retry_forbidden: true, fresh_preview_required: true,
        },
      };
      const message = error instanceof Error ? error.message : String(error);
      // Wrap the untrusted API-error fragment interpolated into this note (#9).
      notes.push(`Could not link matched transaction ${matchedCandidate.transaction_id} to purchase invoice ${createdInvoice.id}: ${wrapUntrustedOcr(message) ?? message}. Invoice was kept without bank link.`);
    }
  } else if (matchedCandidate && !crossCurrencyMatch) {
    notes.push(`Found transaction candidate ${matchedCandidate.transaction_id}, but confidence ${matchedCandidate.confidence} was below auto-link threshold ${EXACT_MATCH_THRESHOLD}.`);
  }

  context.purchaseInvoices.push(createdInvoice);

  return {
    notes,
    status: linked ? "matched" : "created",
    created_invoice: {
      id: createdInvoice.id,
      number: createdInvoice.number,
      status: createdInvoice.status,
      confirmed: true,
      uploaded_document: uploadedDocument,
    },
    bank_match: matchedCandidate ? {
      candidate: matchedCandidate,
      linked,
      confirmed_transaction_id: linked ? matchedCandidate.transaction_id : undefined,
    } : undefined,
  };
}
