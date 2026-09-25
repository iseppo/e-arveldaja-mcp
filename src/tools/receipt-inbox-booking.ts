import { logAudit } from "../audit-log.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { sanitizeUploadFileName } from "../file-validation.js";
import { checkIntakeCashDuplicates, formatDuplicatePostingWarnings } from "../bank-posting-duplicate-guard.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { roundMoney } from "../money.js";
import { REDUCED_VAT_RATES, STANDARD_VAT_RATE_TIMELINE, standardVatRateOn } from "../estonian-tax-rules.js";
import { isProjectTransaction } from "../transaction-status.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, Transaction } from "../types/api.js";
import { type ApiContext, tagNotes } from "./crud-tools.js";
import { applyPurchaseVatDefaults } from "./purchase-vat-defaults.js";
import type { BookingSuggestion, ExtractedReceiptFields, InvoiceSummaryForMatching } from "./receipt-extraction.js";
import { computeTermDays } from "./receipt-extraction.js";
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
  const invoiceDate = extracted.invoice_date ?? "";
  const candidates = [
    ...(standardRate !== null ? [standardRate] : []),
    ...REDUCED_VAT_RATES
      .filter(reduced => reduced.rate > 0 && (reduced.from === null || invoiceDate >= reduced.from))
      .map(reduced => reduced.rate),
  ];
  const tolerance = Math.max(0.02, netAmount * 0.0005);
  const snapped = netAmount > 0
    ? candidates.find(rate => Math.abs(netAmount * rate / 100 - extracted.total_vat!) <= tolerance)
    : undefined;
  if (snapped === undefined) {
    const implied = netAmount > 0 ? roundMoney(extracted.total_vat / netAmount * 100) : undefined;
    return {
      review: `Extracted VAT ${extracted.total_vat} on net ${netAmount}${implied !== undefined ? ` implies ${implied}%` : ""}, ` +
        `which matches neither the standard rate${standardRate !== null ? ` ${standardRate}%` : ""} in force on the invoice date nor a valid reduced rate.`,
    };
  }
  return { rate: String(snapped) };
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
): Promise<Pick<ReceiptBatchFileResult, "created_invoice" | "bank_match" | "notes" | "status" | "error">> {
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

  const itemNetAmount = extracted.total_net
    ?? (extracted.total_gross !== undefined && extracted.total_vat !== undefined
      ? roundMoney(extracted.total_gross - extracted.total_vat)
      : undefined);
  if (itemNetAmount === undefined || extracted.total_gross === undefined) {
    notes.push("Could not derive reliable net/gross totals for invoice creation.");
    return { notes, status: "needs_review" };
  }

  if (extracted.due_date && extracted.due_date < extracted.invoice_date) {
    notes.push(`Due date ${extracted.due_date} precedes invoice date ${extracted.invoice_date}; payment term set to 0 days — verify the dates.`);
  }

  const vatRate = resolveReceiptVatRateDropdown(extracted, itemNetAmount, bookingSuggestion.item);
  if (vatRate.review && context.isVatRegistered) {
    notes.push(vatRate.review);
    return { notes, status: "needs_review" };
  }

  const item = buildSyntheticItem(
    bookingSuggestion,
    extracted.description ?? `Expense from ${supplierName}`,
    itemNetAmount,
    context.purchaseArticlesWithVat,
    context.isVatRegistered,
    vatRate.rate,
  );

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
  // Advisory-only in both modes: folded into `notes` (the result carries no
  // separate warnings field), never blocks. The batch caller invalidates the
  // journal cache once before an execute run, so the execute scan is live.
  const grossTotal = extracted.total_gross;
  const invoiceDate = extracted.invoice_date;
  const appendIntakeDuplicateNotes = async (): Promise<void> => {
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
  };

  const dryRunMatch = dryRun
    ? findBestTransactionMatch(bankTransactions, invoiceDraft, consumedTransactionIds)
    : undefined;
  const candidate = dryRunMatch?.candidate;

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

    await appendIntakeDuplicateNotes();

    return {
      notes,
      status: "dry_run_preview",
      created_invoice: buildDryRunCreatedInvoicePreview(extracted.invoice_number),
      bank_match: candidate ? { candidate, linked: false } : undefined,
    };
  }

  if (!supplierId || !supplier) {
    notes.push("Supplier resolution did not return a concrete client ID.");
    return { notes, status: "needs_review" };
  }

  await appendIntakeDuplicateNotes();

  if (legacyExecuteCreate) {
    notes.push('Legacy execute=true maps to execution_mode="create"; invoice will be created and uploaded but left unconfirmed (#19).');
  }

  let createdInvoice: PurchaseInvoice;
  try {
    createdInvoice = await api.purchaseInvoices.createAndSetTotals(
      {
        clients_id: supplierId,
        client_name: supplier.name,
        number: extracted.invoice_number,
        create_date: extracted.invoice_date,
        journal_date: extracted.invoice_date,
        term_days: computeTermDays(extracted.invoice_date, extracted.due_date),
        cl_currencies_id: invoiceCurrency,
        liability_accounts_id: bookingSuggestion.suggested_liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
        bank_ref_number: extracted.ref_number,
        bank_account_no: extracted.supplier_iban,
        notes: tagNotes(invoiceNotes),
        items: [item],
      },
      extracted.total_vat,
      extracted.total_gross,
      context.isVatRegistered,
    );
    logAudit({
      tool: "process_receipt_batch", action: "CREATED", entity_type: "purchase_invoice",
      entity_id: createdInvoice.id,
      summary: `Receipt batch: created invoice "${extracted.invoice_number}" from ${supplier.name}`,
      details: {
        supplier_name: supplier.name, invoice_number: extracted.invoice_number,
        invoice_date: extracted.invoice_date, total_vat: extracted.total_vat, total_gross: extracted.total_gross,
        file_name: uploadFileName,
      },
    });
  } catch (error) {
    return {
      notes,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let uploadedDocument = false;
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
      return rollbackCreatedInvoice("source document upload failed", error);
    }
  }

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

  if (createdInvoice.id) {
    try {
      await api.purchaseInvoices.confirmWithTotals(createdInvoice.id, context.isVatRegistered);
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
  const matchedCandidate = matchResult.candidate;
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
      if (isProjectTransaction(freshMatch)) {
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
        }], { reassignClientToInvoice: true });
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
