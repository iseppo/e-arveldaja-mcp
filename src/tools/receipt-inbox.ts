import { readFile, readdir, realpath, stat } from "fs/promises";
import { extname, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import type { Account, Client, PurchaseInvoice, PurchaseInvoiceItem, SaleInvoice, Transaction } from "../types/api.js";
import { validateFilePath, getAllowedRoots, resolveFilePath } from "../file-validation.js";
import { roundMoney } from "../money.js";
import { reportProgress } from "../progress.js";
import { readOnly, batch } from "../annotations.js";
import { isProjectTransaction } from "../transaction-status.js";
import { type ApiContext, isCompanyVatRegistered, safeJsonParse } from "./crud-tools.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "./purchase-vat-defaults.js";
import { parseDocument } from "../document-parser.js";
import {
  type InvoiceExtractionFallback,
  summarizeInvoiceExtraction,
} from "../invoice-extraction-fallback.js";
import {
  type BookingSuggestion,
  type ClassificationApplyMode,
  type ExtractedReceiptFields,
  type InvoiceSummaryForMatching,
  type ReceiptClassification,
  type TransactionClassificationCategory,
  type TransactionGroupClassificationInput,
  type TransactionGroupClassification,
  buildKeywordSuggestion,
  categorizeTransactionGroup,
  classifyReceiptDocument,
  computeTermDays,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  extractReceiptFieldsFromText,
  findAccountByKeywords,
  findPurchaseArticleByKeywords,
  getAutoBookedVatConfig,
  hasAutoBookableReceiptFields,
  inferSupplierCountry,
  looksLikePersonCounterparty,
  normalizeCounterpartyName,
  scoreTransactionToInvoice,
  suggestBookingInternal,
} from "./receipt-extraction.js";
import {
  type SupplierResolution,
  type SupplierResolutionOptions,
  resolveSupplierInternal,
} from "./supplier-resolution.js";

// Re-export everything that tests and other modules import from this file
export {
  type TransactionGroupClassificationInput,
  type TransactionGroupClassification,
  categorizeTransactionGroup,
  classifyReceiptDocument,
  detectReceiptCurrency,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  extractAmounts,
  extractDates,
  extractInvoiceNumber,
  extractPdfIdentifiers,
  extractReceiptFieldsFromText,
  extractSupplierName,
  getAutoBookedVatConfig,
  getAutoBookedVatRateDropdown,
  getClientCountryFromIban,
  hasAutoBookableReceiptFields,
  hasRecurringSimilarAmounts,
  inferSupplierCountry,
  looksLikePersonCounterparty,
  normalizeCounterpartyName,
  normalizeDate,
  scoreTransactionToInvoice,
  suggestBookingInternal,
} from "./receipt-extraction.js";

const MAX_RECEIPT_SIZE = 50 * 1024 * 1024; // 50 MB
const FILE_TYPE_EXTENSIONS = {
  pdf: [".pdf"],
  jpg: [".jpg", ".jpeg"],
  png: [".png"],
} as const;
const SUPPORTED_EXTENSIONS = [...FILE_TYPE_EXTENSIONS.pdf, ...FILE_TYPE_EXTENSIONS.jpg, ...FILE_TYPE_EXTENSIONS.png];
const DEFAULT_LIABILITY_ACCOUNT = 2310;
const EXACT_MATCH_THRESHOLD = 90;
const POSSIBLE_MATCH_THRESHOLD = 70;

type FileType = keyof typeof FILE_TYPE_EXTENSIONS;
type ReceiptBatchStatus =
  | "matched"
  | "created"
  | "skipped_duplicate"
  | "needs_review"
  | "failed"
  | "dry_run_preview";

interface ReceiptFileInfo {
  name: string;
  path: string;
  extension: string;
  file_type: FileType;
  size_bytes: number;
  modified_at: string;
}

interface ReceiptScanResult {
  files: ReceiptFileInfo[];
  skipped: Array<{ name: string; reason: string }>;
  folder_path: string;
  total_candidates: number;
}

interface ReceiptBatchFileResult {
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
  notes: string[];
  error?: string;
}

interface TransactionMatchCandidate {
  transaction_id: number;
  amount: number;
  date: string;
  bank_account_name?: string | null;
  description?: string | null;
  confidence: number;
  reasons: string[];
}

interface InvoiceDuplicateMatch {
  reason: "supplier_invoice_number" | "supplier_amount_date";
  invoice_id: number;
  invoice_number: string;
  create_date: string;
  gross_price?: number;
}

interface ReceiptProcessingContext {
  clients: Client[];
  purchaseInvoices: PurchaseInvoice[];
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>;
  accounts: Account[];
  isVatRegistered: boolean;
}

interface TransactionGroup {
  normalized_counterparty: string;
  display_counterparty: string;
  transactions: Transaction[];
}

interface ClassifiedTransactionSuggestion {
  purchase_article_id?: number;
  purchase_article_name?: string;
  purchase_account_id?: number;
  purchase_account_name?: string;
  liability_account_id?: number;
  reason: string;
}

interface ClassifiedTransactionGroupResult {
  category: TransactionClassificationCategory;
  apply_mode: ClassificationApplyMode;
  normalized_counterparty: string;
  display_counterparty: string;
  recurring: boolean;
  similar_amounts: boolean;
  total_amount: number;
  suggested_booking: ClassifiedTransactionSuggestion;
  reasons: string[];
  transactions: Array<{
    id?: number;
    type: string;
    amount: number;
    date: string;
    description?: string | null;
    bank_account_name?: string | null;
    bank_subtype?: string | null;
    accounts_dimensions_id: number;
    clients_id?: number | null;
  }>;
}

export function buildDryRunCreatedInvoicePreview(invoiceNumber: string) {
  return {
    number: invoiceNumber,
    status: "would_create",
    confirmed: false,
    uploaded_document: false,
  };
}

export async function revalidateReceiptFilePath(file: ReceiptFileInfo): Promise<string> {
  return validateFilePath(file.path, [file.extension], MAX_RECEIPT_SIZE);
}

export async function readValidatedReceiptFile(file: ReceiptFileInfo): Promise<Buffer> {
  const validatedPath = await revalidateReceiptFilePath(file);
  return readFile(validatedPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function validateFolderPath(folderPath: string): Promise<string> {
  const resolved = resolveFilePath(folderPath);
  const real = await realpath(resolved);
  const roots = getAllowedRoots();

  if (!roots.some(root => real.startsWith(`${root}/`) || real === root)) {
    throw new Error(
      `Folder path outside allowed directories. Allowed roots: ${roots.join(", ")}. ` +
      `Set EARVELDAJA_ALLOWED_PATHS to override.`,
    );
  }

  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new Error("Not a directory");
  }

  return real;
}

function extensionsForTypes(fileTypes?: FileType[]): string[] {
  if (!fileTypes || fileTypes.length === 0) {
    return SUPPORTED_EXTENSIONS;
  }

  const expanded = new Set<string>();
  for (const fileType of fileTypes) {
    for (const extension of FILE_TYPE_EXTENSIONS[fileType]) {
      expanded.add(extension);
    }
  }

  return [...expanded];
}

function extensionToFileType(extension: string): FileType | undefined {
  const normalized = extension.toLowerCase();
  if (normalized === ".pdf") return "pdf";
  if (normalized === ".jpg" || normalized === ".jpeg") return "jpg";
  if (normalized === ".png") return "png";
  return undefined;
}

function maybeAddLlmFallbackNote(notes: string[], fallback: InvoiceExtractionFallback): void {
  if (!fallback.recommended) return;
  const missing = fallback.missing_required_fields.join(", ");
  notes.push(`Deterministic extraction is incomplete (${missing}). Use extracted.raw_text and llm_fallback guidance instead of guessing missing fields.`);
}

function buildSyntheticItem(
  suggestion: BookingSuggestion,
  description: string,
  amount: number,
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
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

function shouldProcessExpenseAsPurchaseInvoice(classification: TransactionClassificationCategory): boolean {
  return classification === "saas_subscriptions" ||
    classification === "bank_fees" ||
    classification === "card_purchases";
}

function buildOwnerCounterpartySet(clients: Client[]): Set<string> {
  const owners = clients.filter(client =>
    !client.is_deleted &&
    client.is_physical_entity &&
    (client.is_related_party || client.is_associate_company || client.is_parent_company_group)
  );
  return new Set(owners.map(client => normalizeCounterpartyName(client.name)).filter(Boolean));
}

function groupTransactionsByCounterparty(transactions: Transaction[]): TransactionGroup[] {
  const groups = new Map<string, TransactionGroup>();

  for (const transaction of transactions) {
    const displayCounterparty = transaction.bank_account_name?.trim() ||
      transaction.description?.trim() ||
      "Unknown";
    const normalizedCounterparty = normalizeCounterpartyName(displayCounterparty) || `transaction-${transaction.id ?? displayCounterparty}`;
    const group = groups.get(normalizedCounterparty);
    if (group) {
      group.transactions.push(transaction);
    } else {
      groups.set(normalizedCounterparty, {
        normalized_counterparty: normalizedCounterparty,
        display_counterparty: displayCounterparty,
        transactions: [transaction],
      });
    }
  }

  return [...groups.values()].sort((a, b) => a.display_counterparty.localeCompare(b.display_counterparty));
}


function buildClassificationSuggestion(
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  accounts: Account[],
  category: TransactionClassificationCategory,
  normalizedCounterparty: string,
): ClassifiedTransactionSuggestion {
  let articleKeywords = ["muu", "other", "general"];
  let accountKeywords = ["muu", "general", "kulud"];
  let reason = "Fallback booking suggestion from generic expense keywords.";

  if (category === "saas_subscriptions") {
    articleKeywords = ["software", "subscription", "internet", "it", "sideteenus"];
    accountKeywords = ["software", "subscription", "internet", "it", "sideteenus"];
    reason = "Recurring similar payments to the same counterparty suggest a subscription or SaaS vendor.";
  } else if (category === "bank_fees") {
    articleKeywords = ["bank", "fee", "teenus"];
    accountKeywords = ["bank", "fee", "teenus"];
    reason = "Counterparty and description patterns match bank service fees.";
  } else if (category === "tax_payments") {
    articleKeywords = ["maks", "tax"];
    accountKeywords = ["maks", "tax"];
    reason = "Counterparty matches EMTA / Maksu- ja Tolliamet.";
  } else if (category === "salary_payroll") {
    articleKeywords = ["salary", "palk", "payroll"];
    accountKeywords = ["salary", "palk", "payroll"];
    reason = "Recurring transfers to a person-like counterparty look like payroll.";
  } else if (category === "owner_transfers") {
    articleKeywords = ["owner", "laen", "shareholder"];
    accountKeywords = ["owner", "shareholder", "loan", "laen"];
    reason = "Counterparty matches a known owner or related physical person.";
  } else if (category === "card_purchases") {
    if (/(bolt|uber)/i.test(normalizedCounterparty)) {
      articleKeywords = ["transport", "sõidu", "auto"];
      accountKeywords = ["transport", "sõidu", "auto"];
      reason = "Bolt/Uber patterns usually map to travel or transport expenses.";
    } else if (/(wolt)/i.test(normalizedCounterparty)) {
      articleKeywords = ["food", "toit", "representation", "esindus"];
      accountKeywords = ["food", "toit", "representation", "esindus"];
      reason = "Wolt-like payments usually map to food or representation expenses.";
    } else {
      articleKeywords = ["office", "kontor", "general", "muu"];
      accountKeywords = ["office", "kontor", "general", "muu"];
      reason = "Card purchase with no invoice match; suggested booking uses broad operating expense defaults.";
    }
  } else if (category === "revenue_without_invoice") {
    articleKeywords = ["sale", "revenue", "income"];
    accountKeywords = ["sale", "revenue", "income"];
    reason = "Incoming payment without a sale invoice needs manual sales-side follow-up.";
  }

  const article = findPurchaseArticleByKeywords(purchaseArticlesWithVat, articleKeywords)
    ?? findPurchaseArticleByKeywords(purchaseArticlesWithVat, ["muu", "other", "general"]);
  const account = article?.accounts_id
    ? accounts.find(candidate => candidate.id === article.accounts_id)
    : findAccountByKeywords(accounts, accountKeywords);

  return {
    purchase_article_id: article?.id,
    purchase_article_name: article?.name_est ?? article?.name_eng,
    purchase_account_id: account?.id ?? article?.accounts_id,
    purchase_account_name: account ? `${account.id} ${account.name_est}` : undefined,
    liability_account_id: DEFAULT_LIABILITY_ACCOUNT,
    reason,
  };
}

async function scanReceiptFolderInternal(folderPath: string, fileTypes?: FileType[], dateFrom?: string, dateTo?: string): Promise<ReceiptScanResult> {
  const resolvedFolder = await validateFolderPath(folderPath);
  const allowedExtensions = extensionsForTypes(fileTypes);
  const entries = await readdir(resolvedFolder, { withFileTypes: true });
  const files: ReceiptFileInfo[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (!allowedExtensions.includes(extension)) continue;

    const fileType = extensionToFileType(extension);
    if (!fileType) continue;

    const candidatePath = join(resolvedFolder, entry.name);

    try {
      const validatedPath = await validateFilePath(candidatePath, allowedExtensions, MAX_RECEIPT_SIZE);
      const info = await stat(validatedPath);
      const modifiedAt = info.mtime.toISOString();
      const modifiedDate = modifiedAt.slice(0, 10);

      if ((dateFrom && modifiedDate < dateFrom) || (dateTo && modifiedDate > dateTo)) {
        continue;
      }

      files.push({
        name: entry.name,
        path: validatedPath,
        extension,
        file_type: fileType,
        size_bytes: info.size,
        modified_at: modifiedAt,
      });
    } catch (error) {
      skipped.push({
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    files,
    skipped,
    folder_path: resolvedFolder,
    total_candidates: files.length,
  };
}

async function extractReceiptFields(file: ReceiptFileInfo): Promise<ExtractedReceiptFields> {
  const validatedPath = await revalidateReceiptFilePath(file);
  const parsedDocument = await parseDocument(validatedPath);
  return extractReceiptFieldsFromText(parsedDocument.text, file.name);
}

function findBestTransactionMatch(
  transactions: Transaction[],
  invoice: InvoiceSummaryForMatching,
  consumedTransactionIds: Set<number>,
): TransactionMatchCandidate | undefined {
  const candidates = transactions
    .filter(transaction => transaction.id !== undefined && !consumedTransactionIds.has(transaction.id))
    .map(transaction => {
      const { confidence, reasons } = scoreTransactionToInvoice(transaction, invoice);
      return {
        transaction_id: transaction.id!,
        amount: transaction.amount,
        date: transaction.date,
        bank_account_name: transaction.bank_account_name,
        description: transaction.description,
        confidence,
        reasons,
      };
    })
    .filter(candidate => candidate.confidence >= POSSIBLE_MATCH_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);

  return candidates[0];
}

function findDuplicateInvoice(
  invoices: PurchaseInvoice[],
  clientsId: number,
  invoiceNumber: string,
  createDate: string,
  grossPrice: number,
): InvoiceDuplicateMatch | undefined {
  const normalizedNumber = invoiceNumber.trim().toLowerCase();

  const sameNumber = invoices.find(invoice =>
    invoice.clients_id === clientsId &&
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.number.trim().toLowerCase() === normalizedNumber
  );
  if (sameNumber?.id) {
    return {
      reason: "supplier_invoice_number",
      invoice_id: sameNumber.id,
      invoice_number: sameNumber.number,
      create_date: sameNumber.create_date,
      gross_price: sameNumber.gross_price,
    };
  }

  const sameAmountDate = invoices.find(invoice =>
    invoice.clients_id === clientsId &&
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.create_date === createDate &&
    Math.abs((invoice.gross_price ?? 0) - grossPrice) < 0.01
  );
  if (sameAmountDate?.id) {
    return {
      reason: "supplier_amount_date",
      invoice_id: sameAmountDate.id,
      invoice_number: sameAmountDate.number,
      create_date: sameAmountDate.create_date,
      gross_price: sameAmountDate.gross_price,
    };
  }

  return undefined;
}

async function createAndMaybeMatchPurchaseInvoice(
  api: ApiContext,
  context: ReceiptProcessingContext,
  file: ReceiptFileInfo,
  extracted: ExtractedReceiptFields,
  supplierResolution: SupplierResolution,
  bookingSuggestion: BookingSuggestion,
  bankTransactions: Transaction[],
  execute: boolean,
  consumedTransactionIds: Set<number>,
): Promise<Pick<ReceiptBatchFileResult, "created_invoice" | "bank_match" | "notes" | "status" | "error">> {
  const notes: string[] = [];
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
    extracted.total_vat === 0 ? "-" : extracted.total_vat !== undefined ? bookingSuggestion.item.vat_rate_dropdown : "-",
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

  const candidate = execute
    ? undefined
    : findBestTransactionMatch(bankTransactions, invoiceDraft, consumedTransactionIds);

  if (invoiceCurrency !== "EUR") {
    notes.push(`Detected non-EUR receipt currency ${invoiceCurrency}; invoice will use the source currency amount.`);
  }

  if (!execute) {
    if (candidate) {
      notes.push(`Dry run: matched candidate transaction ${candidate.transaction_id} at confidence ${candidate.confidence}.`);
    } else if (invoiceCurrency !== "EUR") {
      notes.push("Dry run: non-EUR bank matching is conservative until the created invoice exposes base_gross_price.");
    }
    notes.push("Dry run: purchase invoice document was not uploaded and the invoice was not confirmed.");
    return {
      notes,
      status: "dry_run_preview",
      created_invoice: buildDryRunCreatedInvoicePreview(extracted.invoice_number!),
      bank_match: candidate ? { candidate, linked: false } : undefined,
    };
  }

  if (!supplierId || !supplier) {
    notes.push("Supplier resolution did not return a concrete client ID.");
    return { notes, status: "needs_review" };
  }

  let createdInvoice: PurchaseInvoice;
  try {
    createdInvoice = await api.purchaseInvoices.createAndSetTotals(
      {
        clients_id: supplierId,
        client_name: supplier.name,
        number: extracted.invoice_number!,
        create_date: extracted.invoice_date!,
        journal_date: extracted.invoice_date!,
        term_days: computeTermDays(extracted.invoice_date, extracted.due_date),
        cl_currencies_id: invoiceCurrency,
        liability_accounts_id: DEFAULT_LIABILITY_ACCOUNT,
        bank_ref_number: extracted.ref_number,
        bank_account_no: extracted.supplier_iban,
        notes: invoiceNotes,
        items: [item],
      },
      extracted.total_vat,
      extracted.total_gross,
      context.isVatRegistered,
    );
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
      context.purchaseInvoices.push(createdInvoice);
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
    } catch (error) {
      return rollbackCreatedInvoice("source document upload failed", error);
    }
  }

  if (createdInvoice.id) {
    try {
      await api.purchaseInvoices.confirmWithTotals(createdInvoice.id, context.isVatRegistered, {
        preserveExistingTotals: true,
      });
      notes.push("Confirmed created purchase invoice for booking and bank matching.");
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
          amount: matchedCandidate.amount,
        }]);
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

function existingInvoiceMatch(tx: Transaction, openSales: SaleInvoice[], openPurchases: PurchaseInvoice[]): boolean {
  if (tx.type !== "D" && tx.type !== "C") return false;
  for (const invoice of [...openSales, ...openPurchases]) {
    const { confidence } = scoreTransactionToInvoice(tx, invoice);
    if (confidence >= POSSIBLE_MATCH_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function toClassifiedResult(
  group: TransactionGroup,
  classification: TransactionGroupClassification,
  suggestion: ClassifiedTransactionSuggestion,
): ClassifiedTransactionGroupResult {
  return {
    category: classification.category,
    apply_mode: classification.apply_mode,
    normalized_counterparty: group.normalized_counterparty,
    display_counterparty: group.display_counterparty,
    recurring: classification.recurring,
    similar_amounts: classification.similar_amounts,
    total_amount: roundMoney(group.transactions.reduce((sum, transaction) => sum + transaction.amount, 0)),
    suggested_booking: suggestion,
    reasons: classification.reasons,
    transactions: group.transactions.map(transaction => ({
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      date: transaction.date,
      description: transaction.description,
      bank_account_name: transaction.bank_account_name,
      bank_subtype: transaction.bank_subtype,
      accounts_dimensions_id: transaction.accounts_dimensions_id,
      clients_id: transaction.clients_id,
    })),
  };
}

async function resolveSupplierFromTransaction(
  api: ApiContext,
  clients: Client[],
  transaction: Transaction,
  execute: boolean,
  classificationCategory?: TransactionClassificationCategory,
): Promise<SupplierResolution> {
  if (transaction.clients_id) {
    const existingClient = clients.find(client => client.id === transaction.clients_id && !client.is_deleted);
    if (existingClient) {
      return {
        found: true,
        created: false,
        match_type: "registry_code",
        client: existingClient,
      };
    }
  }

  return resolveSupplierInternal(api, clients, {
    supplier_name: transaction.bank_account_name ?? transaction.description ?? `Transaction ${transaction.id ?? ""}`.trim(),
    supplier_iban: transaction.bank_account_no ?? undefined,
  }, execute, {
    classification_category: classificationCategory,
  });
}

function validateClassificationGroup(item: unknown, index: number): void {
  if (!item || typeof item !== "object") {
    throw new Error(`classifications_json[${index}] must be an object`);
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.category !== "string") {
    throw new Error(`classifications_json[${index}] missing required field "category"`);
  }
  if (!Array.isArray(obj.transactions)) {
    throw new Error(`classifications_json[${index}] missing required field "transactions" (array)`);
  }
}

function extractClassificationGroups(payload: unknown): ClassifiedTransactionGroupResult[] {
  let groups: unknown[];
  if (Array.isArray(payload)) {
    groups = payload;
  } else if (payload && typeof payload === "object" && "groups" in payload && Array.isArray((payload as { groups?: unknown[] }).groups)) {
    groups = (payload as { groups: unknown[] }).groups;
  } else {
    throw new Error("classifications_json must be a JSON array of groups or an object with a groups array");
  }
  for (let i = 0; i < groups.length; i++) {
    validateClassificationGroup(groups[i], i);
  }
  return groups as ClassifiedTransactionGroupResult[];
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

export function registerReceiptInboxTools(server: McpServer, api: ApiContext): void {
  registerTool(server,
    "scan_receipt_folder",
    "Scan a folder for supported receipt files (PDF, JPG, PNG) without recursing into subfolders. Returns valid file metadata and skipped entries.",
    {
      folder_path: z.string().describe("Folder path to scan"),
      file_types: z.array(z.enum(["pdf", "jpg", "png"])).optional().describe("Optional file type filter"),
    },
    { ...readOnly, openWorldHint: true, title: "Scan Receipt Folder" },
    async ({ folder_path, file_types }) => {
      const result = await scanReceiptFolderInternal(folder_path, file_types);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  registerTool(server,
    "process_receipt_batch",
    "Process receipt PDFs and images from a folder. DRY RUN by default. OCR text is returned for all supported files, and incomplete deterministic extraction is surfaced through llm_fallback for model/manual review. Purchase invoices can be created, confirmed, and matched to bank transactions when execute=true.",
    {
      folder_path: z.string().describe("Folder path with receipts"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID used when matching bank transactions"),
      execute: z.boolean().optional().describe("Actually create and book invoices (default false = dry run)"),
      date_from: z.string().optional().describe("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
    },
    { ...batch, openWorldHint: true, title: "Process Receipt Batch" },
    async ({ folder_path, accounts_dimensions_id, execute, date_from, date_to }) => {
      const dryRun = execute !== true;
      const scan = await scanReceiptFolderInternal(folder_path, undefined, date_from, date_to);
      const context: ReceiptProcessingContext = {
        clients: await api.clients.listAll(),
        purchaseInvoices: await api.purchaseInvoices.listAll(),
        purchaseArticlesWithVat: await getPurchaseArticlesWithVat(api),
        accounts: await api.readonly.getAccounts(),
        isVatRegistered: await isCompanyVatRegistered(api),
      };
      const allTransactions = await api.transactions.listAll();
      const bankTransactions = allTransactions.filter(transaction =>
        transaction.accounts_dimensions_id === accounts_dimensions_id &&
        isProjectTransaction(transaction) &&
        transaction.type === "C" &&
        (!date_from || transaction.date >= date_from) &&
        (!date_to || transaction.date <= date_to),
      );
      const consumedTransactionIds = new Set<number>();
      const results: ReceiptBatchFileResult[] = [];

      for (let index = 0; index < scan.files.length; index++) {
        const file = scan.files[index]!;
        await reportProgress(index, scan.files.length);
        const notes: string[] = [];

        try {
          const extracted = await extractReceiptFields(file);
          const llmFallback = summarizeInvoiceExtraction(extracted);
          const classification = classifyReceiptDocument(extracted.raw_text ?? file.name, file.name);

          if (file.file_type !== "pdf") {
            notes.push("Image receipt OCR-parsed with LiteParse.");
          }

          if (classification !== "purchase_invoice") {
            notes.push(
              classification === "owner_paid_expense_reimbursement"
                ? "PDF looks like an owner-paid expense receipt. Review manually before booking."
                : "Document could not be classified as a supplier purchase invoice.",
            );
            maybeAddLlmFallbackNote(notes, llmFallback);
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: llmFallback,
              notes,
            });
            continue;
          }

          if (!hasAutoBookableReceiptFields(extracted)) {
            notes.push("Missing supplier name, confident invoice number, invoice date, or gross total required for auto-booking.");
            maybeAddLlmFallbackNote(notes, llmFallback);
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: llmFallback,
              notes,
            });
            continue;
          }

          const supplierResolution = await resolveSupplierInternal(api, context.clients, extracted, !dryRun);
          if (!supplierResolution.client && !supplierResolution.preview_client) {
            notes.push("Supplier could not be resolved or prepared for creation.");
            maybeAddLlmFallbackNote(notes, llmFallback);
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: llmFallback,
              supplier_resolution: supplierResolution,
              notes,
            });
            continue;
          }

          const resolvedClientId = supplierResolution.client?.id;
          if (!resolvedClientId && dryRun) {
            notes.push("Dry run: supplier would need to be created before invoice creation.");
          }

          const bookingSuggestion = resolvedClientId
            ? await suggestBookingInternal(api, context, resolvedClientId, extracted.description ?? extracted.supplier_name ?? "Receipt expense")
            : buildKeywordSuggestion(
              context.purchaseArticlesWithVat,
              context.accounts,
              `${extracted.description ?? ""} ${extracted.supplier_name ?? ""}`,
            );

          if (!bookingSuggestion) {
            notes.push("Could not find a purchase article / account suggestion for this receipt.");
            maybeAddLlmFallbackNote(notes, llmFallback);
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: llmFallback,
              supplier_resolution: supplierResolution,
              notes,
            });
            continue;
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
              results.push({
                file,
                classification,
                status: "skipped_duplicate",
                extracted,
                llm_fallback: llmFallback,
                supplier_resolution: supplierResolution,
                booking_suggestion: bookingSuggestion,
                duplicate_match: duplicate,
                notes: [`Skipped duplicate by ${duplicate.reason}.`],
              });
              continue;
            }
          }

          const created = await createAndMaybeMatchPurchaseInvoice(
            api,
            context,
            file,
            extracted,
            supplierResolution,
            bookingSuggestion,
            bankTransactions,
            !dryRun,
            consumedTransactionIds,
          );

          results.push({
            file,
            classification,
            status: created.status,
            extracted,
            llm_fallback: llmFallback,
            supplier_resolution: supplierResolution,
            booking_suggestion: bookingSuggestion,
            created_invoice: created.created_invoice,
            bank_match: created.bank_match,
            notes: created.notes,
            error: created.error,
          });
        } catch (error) {
          results.push({
            file,
            classification: "unclassifiable",
            status: "failed",
            notes,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const summary = {
        dry_run: dryRun,
        scanned_files: scan.files.length,
        skipped_invalid_files: scan.skipped.length,
        created: results.filter(result => result.status === "created").length,
        matched: results.filter(result => result.status === "matched").length,
        skipped_duplicate: results.filter(result => result.status === "skipped_duplicate").length,
        failed: results.filter(result => result.status === "failed").length,
        needs_review: results.filter(result => result.status === "needs_review").length,
        dry_run_preview: results.filter(result => result.status === "dry_run_preview").length,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            folder_path: scan.folder_path,
            accounts_dimensions_id,
            summary,
            skipped: scan.skipped,
            results,
          }, null, 2),
        }],
      };
    },
  );

  registerTool(server,
    "classify_unmatched_transactions",
    "Classify unconfirmed bank transactions that do not match any sale or purchase invoice. Read-only analysis with suggested booking defaults.",
    {
      accounts_dimensions_id: z.number().describe("Bank account dimension ID"),
      date_from: z.string().optional().describe("Optional lower transaction date bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional upper transaction date bound (YYYY-MM-DD)"),
    },
    { ...readOnly, title: "Classify Unmatched Transactions" },
    async ({ accounts_dimensions_id, date_from, date_to }) => {
      const [transactions, saleInvoices, purchaseInvoices, clients, purchaseArticlesWithVat, accounts] = await Promise.all([
        api.transactions.listAll(),
        api.saleInvoices.listAll(),
        api.purchaseInvoices.listAll(),
        api.clients.listAll(),
        getPurchaseArticlesWithVat(api),
        api.readonly.getAccounts(),
      ]);

      const openSales = saleInvoices.filter(invoice =>
        invoice.status === "CONFIRMED" && invoice.payment_status !== "PAID",
      );
      const openPurchases = purchaseInvoices.filter(invoice =>
        invoice.status === "CONFIRMED" && invoice.payment_status !== "PAID",
      );
      const ownerCounterparties = buildOwnerCounterpartySet(clients);

      const unconfirmed = transactions.filter(transaction =>
        transaction.accounts_dimensions_id === accounts_dimensions_id &&
        isProjectTransaction(transaction) &&
        (!date_from || transaction.date >= date_from) &&
        (!date_to || transaction.date <= date_to),
      );

      const unmatched = unconfirmed.filter(transaction => !existingInvoiceMatch(transaction, openSales, openPurchases));
      const groups = groupTransactionsByCounterparty(unmatched);
      const classifiedGroups = groups.map(group => {
        const classification = categorizeTransactionGroup({
          normalized_counterparty: group.normalized_counterparty,
          display_counterparty: group.display_counterparty,
          transactions: group.transactions,
          owner_counterparties: ownerCounterparties,
        });
        const suggestion = buildClassificationSuggestion(
          purchaseArticlesWithVat,
          accounts,
          classification.category,
          group.normalized_counterparty,
        );
        return toClassifiedResult(group, classification, suggestion);
      });

      const categoryCounts = classifiedGroups.reduce<Record<string, number>>((counts, group) => {
        counts[group.category] = (counts[group.category] ?? 0) + group.transactions.length;
        return counts;
      }, {});

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            schema_version: 1,
            accounts_dimensions_id,
            period: {
              from: date_from ?? "all",
              to: date_to ?? "all",
            },
            total_unconfirmed: unconfirmed.length,
            total_unmatched: unmatched.length,
            category_counts: categoryCounts,
            groups: classifiedGroups,
          }, null, 2),
        }],
      };
    },
  );

  registerTool(server,
    "apply_transaction_classifications",
    "Apply the output of classify_unmatched_transactions. DRY RUN by default. Only expense-like categories are auto-booked as purchase invoices; review-only categories are reported back.",
    {
      classifications_json: z.string().describe("JSON from classify_unmatched_transactions"),
      execute: z.boolean().optional().describe("Actually create invoices and link transactions (default false = dry run)"),
    },
    { ...batch, title: "Apply Transaction Classifications" },
    async ({ classifications_json, execute }) => {
      const dryRun = execute !== true;
      const parsed = safeJsonParse(classifications_json, "classifications_json");
      const groups = extractClassificationGroups(parsed);

      const [clients, purchaseArticlesWithVat] = await Promise.all([
        api.clients.listAll(),
        getPurchaseArticlesWithVat(api),
      ]);
      const isVatRegistered = await isCompanyVatRegistered(api);
      const results: Array<{
        category: TransactionClassificationCategory;
        counterparty: string;
        status: "applied" | "skipped" | "dry_run_preview" | "failed";
        notes: string[];
        transactions: number[];
        created_invoice_ids?: number[];
        linked_transaction_ids?: number[];
      }> = [];

      for (let index = 0; index < groups.length; index++) {
        const group = groups[index]!;
        await reportProgress(index, groups.length);
        const notes: string[] = [];
        const transactionIds = group.transactions.map(transaction => transaction.id).filter((id): id is number => id !== undefined);

        try {
          const freshTransactions: Transaction[] = [];
          for (const transactionStub of group.transactions) {
            if (!transactionStub.id) {
              notes.push("Skipped a transaction without ID.");
              continue;
            }

            try {
              const transaction = await api.transactions.get(transactionStub.id);
              if (transaction.is_deleted) {
                notes.push(`Transaction ${transactionStub.id} was deleted since classification; skipped.`);
                continue;
              }
              if (transaction.status === "CONFIRMED") {
                notes.push(`Transaction ${transactionStub.id} was confirmed since classification; skipped.`);
                continue;
              }
              if (transaction.status !== "PROJECT") {
                notes.push(`Transaction ${transactionStub.id} is no longer bookable (status ${transaction.status ?? "UNKNOWN"}); skipped.`);
                continue;
              }
              freshTransactions.push(transaction);
            } catch {
              notes.push(`Transaction ${transactionStub.id} no longer exists.`);
            }
          }

          if (freshTransactions.length === 0) {
            notes.push("No unconfirmed transactions remain in this classification group.");
            results.push({
              category: group.category,
              counterparty: group.display_counterparty,
              status: "skipped",
              notes,
              transactions: transactionIds,
            });
            continue;
          }

          if (group.apply_mode !== "purchase_invoice" || !shouldProcessExpenseAsPurchaseInvoice(group.category)) {
            notes.push(`Category ${group.category} is review-only and is not auto-booked as a purchase invoice.`);
            results.push({
              category: group.category,
              counterparty: group.display_counterparty,
              status: "skipped",
              notes,
              transactions: transactionIds,
            });
            continue;
          }

          if (!group.suggested_booking.purchase_article_id) {
            notes.push("Missing suggested purchase article ID. Re-run classification after maintaining purchase articles.");
            results.push({
              category: group.category,
              counterparty: group.display_counterparty,
              status: "skipped",
              notes,
              transactions: transactionIds,
            });
            continue;
          }

          const createdInvoiceIds: number[] = [];
          const linkedTransactionIds: number[] = [];

          for (const transaction of freshTransactions) {
            const supplierResolution = await resolveSupplierFromTransaction(api, clients, transaction, !dryRun, group.category);
            const supplier = supplierResolution.client;
            const supplierId = supplier?.id;
            const supplierMetadata = supplierResolution.client ?? supplierResolution.preview_client;
            const grossAmount = roundMoney(Math.abs(transaction.amount));
            if (!supplier?.id && dryRun) {
              notes.push(`Dry run: transaction ${transaction.id} would require creating a supplier for ${group.display_counterparty}.`);
            }
            if (!supplier?.id && !dryRun) {
              notes.push(`Transaction ${transaction.id} could not resolve a supplier client.`);
              continue;
            }

            const article = purchaseArticlesWithVat.find(item => item.id === group.suggested_booking.purchase_article_id);
            const vatConfig = getAutoBookedVatConfig(group.category, supplierMetadata?.cl_code_country);
            const netAmount = deriveAutoBookedNetAmount(grossAmount, vatConfig);
            const purchaseItem = applyPurchaseVatDefaults(
              purchaseArticlesWithVat,
              {
                cl_purchase_articles_id: group.suggested_booking.purchase_article_id,
                purchase_accounts_id: group.suggested_booking.purchase_account_id ?? article?.accounts_id,
                custom_title: transaction.description ?? `Auto-booked ${group.category}`,
                unit_net_price: netAmount,
                total_net_price: netAmount,
                amount: 1,
                ...vatConfig,
              },
              isVatRegistered,
            );

            if (dryRun) {
              notes.push(`Dry run: would create purchase invoice for transaction ${transaction.id}.`);
              continue;
            }

            if (!supplier || !supplierId) {
              notes.push(`Transaction ${transaction.id} could not resolve a supplier client.`);
              continue;
            }

            const invoice = await api.purchaseInvoices.createAndSetTotals(
              {
                clients_id: supplierId,
                client_name: supplier.name,
                number: `AUTO-TX-${transaction.id}`,
                create_date: transaction.date,
                journal_date: transaction.date,
                term_days: 0,
                cl_currencies_id: transaction.cl_currencies_id ?? "EUR",
                liability_accounts_id: group.suggested_booking.liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
                notes: `Auto-created from classified bank transaction ${transaction.id}`,
                items: [purchaseItem],
              },
              deriveAutoBookedVatPrice(grossAmount, vatConfig),
              grossAmount,
              isVatRegistered,
            );

            if (invoice.id) {
              const invalidateAutoCreatedInvoice = async (reason: string) => {
                try {
                  await api.purchaseInvoices.invalidate(invoice.id!);
                  notes.push(`Invalidated auto-created purchase invoice ${invoice.id} because ${reason}.`);
                } catch (invalidateError) {
                  const invalidateMessage = invalidateError instanceof Error ? invalidateError.message : String(invalidateError);
                  notes.push(`Auto-created purchase invoice ${invoice.id} could not be kept because ${reason}, and invalidation also failed: ${invalidateMessage}.`);
                }
              };

              const freshTransaction = await api.transactions.get(transaction.id!);
              if (!isProjectTransaction(freshTransaction)) {
                await invalidateAutoCreatedInvoice(`transaction ${transaction.id} is no longer bookable (status ${freshTransaction.status ?? "UNKNOWN"})`);
                continue;
              }

              try {
                await api.purchaseInvoices.confirmWithTotals(invoice.id, isVatRegistered, {
                  preserveExistingTotals: true,
                });
                await api.transactions.confirm(transaction.id!, [{
                  related_table: "purchase_invoices",
                  related_id: invoice.id,
                  amount: transaction.amount,
                }]);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await invalidateAutoCreatedInvoice(`automation failed after creation: ${message}`);
                continue;
              }

              createdInvoiceIds.push(invoice.id);
              linkedTransactionIds.push(transaction.id!);
            }
          }

          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status: dryRun ? "dry_run_preview" : "applied",
            notes,
            transactions: transactionIds,
            created_invoice_ids: dryRun ? undefined : createdInvoiceIds,
            linked_transaction_ids: dryRun ? undefined : linkedTransactionIds,
          });
        } catch (error) {
          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status: "failed",
            notes: [error instanceof Error ? error.message : String(error)],
            transactions: transactionIds,
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dry_run: dryRun,
            summary: {
              applied: results.filter(result => result.status === "applied").length,
              skipped: results.filter(result => result.status === "skipped").length,
              dry_run_preview: results.filter(result => result.status === "dry_run_preview").length,
              failed: results.filter(result => result.status === "failed").length,
            },
            results,
          }, null, 2),
        }],
      };
    },
  );
}
