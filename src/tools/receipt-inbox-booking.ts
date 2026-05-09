import { logAudit } from "../audit-log.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { roundMoney } from "../money.js";
import { isProjectTransaction } from "../transaction-status.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, Transaction } from "../types/api.js";
import { type ApiContext, tagNotes } from "./crud-tools.js";
import { applyPurchaseVatDefaults } from "./purchase-vat-defaults.js";
import type { BookingSuggestion, ExtractedReceiptFields, InvoiceSummaryForMatching } from "./receipt-extraction.js";
import { computeTermDays } from "./receipt-extraction.js";
import type { SupplierResolution } from "./supplier-resolution.js";
import { readValidatedReceiptFile } from "./receipt-inbox-files.js";
import { findBestTransactionMatch } from "./receipt-inbox-matching.js";
import type {
  ReceiptBatchExecutionMode,
  ReceiptBatchFileResult,
  ReceiptFileInfo,
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

export async function createAndMaybeMatchPurchaseInvoice(
  api: ApiContext,
  context: ReceiptProcessingContext,
  file: ReceiptFileInfo,
  extracted: ExtractedReceiptFields,
  supplierResolution: SupplierResolution,
  bookingSuggestion: BookingSuggestion,
  bankTransactions: Transaction[],
  executionMode: ReceiptBatchExecutionMode,
  legacyExecuteCreate: boolean,
  consumedTransactionIds: Set<number>,
): Promise<Pick<ReceiptBatchFileResult, "created_invoice" | "bank_match" | "notes" | "status" | "error">> {
  const notes: string[] = [];
  const dryRun = executionMode === "dry_run";
  const shouldConfirm = executionMode === "create_and_confirm";
  const supplier = supplierResolution.client;
  const supplierId = supplier?.id;
  const supplierName = supplier?.name ?? supplierResolution.preview_client?.name;
  const invoiceCurrency = extracted.currency ?? "EUR";
  const invoiceNotes = extracted.currency && extracted.currency !== "EUR" && extracted.total_gross !== undefined
    ? `Receipt inbox import from ${file.name} | Original receipt amount: ${roundMoney(extracted.total_gross).toFixed(2)} ${extracted.currency}`
    : `Receipt inbox import from ${file.name}`;

  if (!supplierName) {
    notes.push("Supplier resolution did not return a concrete client ID.");
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

  const item = buildSyntheticItem(
    bookingSuggestion,
    extracted.description ?? `Expense from ${supplierName}`,
    itemNetAmount,
    context.purchaseArticlesWithVat,
    context.isVatRegistered,
    extracted.total_vat === 0 && extracted.vat_explicit
      ? "-"
      : extracted.total_vat !== undefined
        ? bookingSuggestion.item.vat_rate_dropdown
        : undefined,
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

  const candidate = dryRun
    ? findBestTransactionMatch(bankTransactions, invoiceDraft, consumedTransactionIds)
    : undefined;

  if (invoiceCurrency !== "EUR") {
    notes.push(`Detected non-EUR receipt currency ${invoiceCurrency}; invoice will use the source currency amount.`);
  }

  if (dryRun) {
    if (candidate) {
      notes.push(`Dry run: matched candidate transaction ${candidate.transaction_id} at confidence ${candidate.confidence}.`);
    } else if (invoiceCurrency !== "EUR") {
      notes.push("Dry run: non-EUR bank matching is conservative until the created invoice exposes base_gross_price.");
    }
    notes.push("Dry run: purchase invoice document was not uploaded and the invoice was not confirmed.");
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
        file_name: file.name,
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

    if (!createdInvoice.id) {
      return {
        notes,
        status: "failed" as const,
        error: message,
      };
    }

    try {
      await api.purchaseInvoices.invalidate(createdInvoice.id);
      notes.push(`Invalidated created purchase invoice ${createdInvoice.id} because ${reason}: ${message}.`);
      return {
        notes,
        status: "failed" as const,
        error: message,
      };
    } catch (invalidateError) {
      const invalidateMessage = invalidateError instanceof Error ? invalidateError.message : String(invalidateError);
      notes.push(
        `Created purchase invoice ${createdInvoice.id} could not be invalidated after ${reason}: ${message}. ` +
        `Automatic invalidation also failed: ${invalidateMessage}.`
      );
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
    }
  };

  if (createdInvoice.id) {
    try {
      const contents = (await readValidatedReceiptFile(file)).toString("base64");
      await api.purchaseInvoices.uploadDocument(createdInvoice.id, file.name, contents);
      uploadedDocument = true;
      notes.push("Uploaded source document to created purchase invoice.");
      logAudit({
        tool: "process_receipt_batch", action: "UPLOADED", entity_type: "purchase_invoice",
        entity_id: createdInvoice.id,
        summary: `Uploaded document "${file.name}" to purchase invoice ${createdInvoice.id}`,
        details: { file_name: file.name },
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
      await api.purchaseInvoices.confirmWithTotals(createdInvoice.id, context.isVatRegistered, {
        preserveExistingTotals: true,
      });
      createdInvoice = {
        ...createdInvoice,
        status: "CONFIRMED",
      };
      notes.push("Confirmed created purchase invoice for booking and bank matching.");
      logAudit({
        tool: "process_receipt_batch", action: "CONFIRMED", entity_type: "purchase_invoice",
        entity_id: createdInvoice.id,
        summary: `Confirmed purchase invoice ${createdInvoice.id} (${createdInvoice.number ?? ""})`,
        details: { invoice_number: createdInvoice.number, file_name: file.name },
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
  const matchedCandidate = findBestTransactionMatch(bankTransactions, matchedInvoice, consumedTransactionIds);
  const canAutoLink = matchedCandidate !== undefined && matchedCandidate.confidence >= EXACT_MATCH_THRESHOLD;
  let linked = false;
  if (createdInvoice.id && matchedCandidate && canAutoLink) {
    try {
      const freshMatch = await api.transactions.get(matchedCandidate.transaction_id);
      if (isProjectTransaction(freshMatch)) {
        await api.transactions.confirm(matchedCandidate.transaction_id, [{
          related_table: "purchase_invoices",
          related_id: createdInvoice.id,
          amount: createdInvoice.base_gross_price ?? createdInvoice.gross_price ?? matchedCandidate.amount,
        }]);
        logAudit({
          tool: "process_receipt_batch", action: "CONFIRMED", entity_type: "transaction",
          entity_id: matchedCandidate.transaction_id,
          summary: `Receipt batch: confirmed transaction ${matchedCandidate.transaction_id} against invoice ${createdInvoice.id}`,
          details: { amount: matchedCandidate.amount, invoice_id: createdInvoice.id },
        });
        consumedTransactionIds.add(matchedCandidate.transaction_id);
        linked = true;
        notes.push(`Linked transaction ${matchedCandidate.transaction_id} to purchase invoice ${createdInvoice.id}.`);
      } else {
        notes.push(`Matched transaction ${matchedCandidate.transaction_id} is no longer bookable (status ${freshMatch.status ?? "UNKNOWN"}); invoice was created without bank link.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Could not link matched transaction ${matchedCandidate.transaction_id} to purchase invoice ${createdInvoice.id}: ${message}. Invoice was kept without bank link.`);
    }
  } else if (matchedCandidate) {
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
