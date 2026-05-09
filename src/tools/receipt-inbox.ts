import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { parseMcpResponse, toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { Account, Client, PurchaseInvoice, PurchaseInvoiceItem, SaleInvoice, Transaction } from "../types/api.js";
import { roundMoney } from "../money.js";
import { reportProgress } from "../progress.js";
import { readOnly, batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { isProjectTransaction } from "../transaction-status.js";
import { type ApiContext, isCompanyVatRegistered, jsonObjectOrArrayInput, safeJsonParse, coerceId, tagNotes } from "./crud-tools.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "./purchase-vat-defaults.js";
import { parseDocument } from "../document-parser.js";
import { normalizeCompanyName } from "../company-name.js";
import {
  type ExtractionConfidenceSignals,
  type InvoiceExtractionFallback,
  summarizeInvoiceExtraction,
} from "../invoice-extraction-fallback.js";
import {
  type BookingSuggestion,
  type ClassificationApplyMode,
  type ExtractedReceiptFields,
  type ReceiptClassification,
  type TransactionClassificationCategory,
  type TransactionGroupClassification,
  buildKeywordSuggestion,
  categorizeTransactionGroup,
  classifyReceiptDocument,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  detectReverseChargeFromText,
  extractReceiptFieldsFromText,
  findAccountByKeywords,
  findPurchaseArticleByKeywords,
  getBookingSuggestionVatConfig,
  getAutoBookedVatConfig,
  hasAutoBookableReceiptFields,
  normalizeCounterpartyName,
  scoreTransactionToInvoice,
  suggestBookingInternal,
} from "./receipt-extraction.js";
import {
  type SupplierResolution,
  resolveSupplierInternal,
} from "./supplier-resolution.js";
import { getInvoiceMatchEligibility } from "./bank-reconciliation.js";
import {
  type AccountingAutoBookingRule,
  findAutoBookingRule,
  hasConcreteAutoBookingRuleBookingTarget,
} from "../accounting-rules.js";
import {
  type ReviewGuidance,
  buildClassificationReviewGuidance,
  buildReceiptReviewGuidance,
} from "../estonian-accounting-guidance.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import {
  RECEIPT_BATCH_EXECUTION_MODES,
  type ReceiptBatchExecutionMode,
  type ReceiptBatchFileResult,
  type ReceiptFileInfo,
  type ReceiptInboxToolHandler,
  type ReceiptInboxToolResult,
  type ReceiptProcessingContext,
} from "./receipt-inbox-types.js";
import { readValidatedReceiptFile, revalidateReceiptFilePath, scanReceiptFolderInternal } from "./receipt-inbox-files.js";
import { findBestTransactionMatch, findDuplicateInvoice } from "./receipt-inbox-matching.js";
import { sanitizeReceiptResultForOutput } from "./receipt-inbox-output.js";
import {
  buildDryRunCreatedInvoicePreview,
  createAndMaybeMatchPurchaseInvoice,
} from "./receipt-inbox-booking.js";
import {
  buildReceiptBatchExecution,
  buildReceiptBatchSummary,
  buildReceiptBatchWorkflow,
  buildReceiptBatchWorkflowSummary,
} from "./receipt-inbox-summary.js";

const POSSIBLE_MATCH_THRESHOLD = 70;

export { buildDryRunCreatedInvoicePreview };

function resolveReceiptBatchExecutionMode(
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

export function supplierCountryNeedsReview(supplierResolution: SupplierResolution): boolean {
  return !supplierResolution.client &&
    !!supplierResolution.preview_client &&
    !supplierResolution.preview_client.cl_code_country;
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
  purchase_account_dimensions_id?: number;
  liability_account_id?: number;
  vat_rate_dropdown?: string;
  reversed_vat_id?: number;
  source?: "supplier_history" | "keyword_match" | "fallback" | "local_rules";
  matched_invoice_id?: number;
  matched_invoice_number?: string;
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
  review_guidance?: ReviewGuidance;
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

// ---------------------------------------------------------------------------
// Internal helpers
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


function buildSuggestionFromBookingHistory(bookingSuggestion: BookingSuggestion): ClassifiedTransactionSuggestion {
  return {
    purchase_article_id: bookingSuggestion.item.cl_purchase_articles_id,
    purchase_article_name: bookingSuggestion.suggested_purchase_article?.name,
    purchase_account_id: bookingSuggestion.item.purchase_accounts_id ?? bookingSuggestion.suggested_account?.id,
    purchase_account_name: bookingSuggestion.suggested_account
      ? `${bookingSuggestion.suggested_account.id} ${bookingSuggestion.suggested_account.name_est}`
      : undefined,
    purchase_account_dimensions_id: bookingSuggestion.item.purchase_accounts_dimensions_id ?? undefined,
    liability_account_id: bookingSuggestion.suggested_liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
    vat_rate_dropdown: bookingSuggestion.item.vat_rate_dropdown ?? undefined,
    reversed_vat_id: bookingSuggestion.item.reversed_vat_id ?? undefined,
    source: bookingSuggestion.source,
    matched_invoice_id: bookingSuggestion.matched_invoice_id,
    matched_invoice_number: bookingSuggestion.matched_invoice_number,
    reason: bookingSuggestion.matched_invoice_number
      ? `Defaulted from confirmed supplier invoice ${bookingSuggestion.matched_invoice_number}.`
      : "Defaulted from the most recent confirmed supplier invoice.",
  };
}

function resolveAutoBookingRuleTargets(
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  accounts: Account[],
  rule: AccountingAutoBookingRule,
): {
  article?: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>[number];
  account?: Account;
} {
  const article = rule.purchase_article_id !== undefined
    ? purchaseArticlesWithVat.find(candidate => candidate.id === rule.purchase_article_id)
    : undefined;
  const account = rule.purchase_account_id !== undefined
    ? accounts.find(candidate => candidate.id === rule.purchase_account_id)
    : article?.accounts_id !== undefined
      ? accounts.find(candidate => candidate.id === article.accounts_id)
      : undefined;

  return { article, account };
}

function inferReceiptAutoBookingCategory(
  extracted: Pick<ExtractedReceiptFields, "supplier_name" | "description">,
): TransactionClassificationCategory | undefined {
  const text = `${extracted.supplier_name ?? ""} ${extracted.description ?? ""}`.toLowerCase();

  if (/(bank|pank|fee|teenustasu|commission|service charge|haldustasu)/i.test(text)) {
    return "bank_fees";
  }
  if (/(software|subscription|hosting|cloud|openai|google|zoom|slack|github|microsoft|internet|sideteenus)/i.test(text)) {
    return "saas_subscriptions";
  }
  if (/(bolt|uber|taxi|parking|transport|wolt|restaurant|cafe|food|toit)/i.test(text)) {
    return "card_purchases";
  }
  if (/(tax|emta|maks)/i.test(text)) {
    return "tax_payments";
  }

  return undefined;
}

function resolveMergedPurchaseAccountDimension(
  baseDimensionId: number | null | undefined,
  baseAccountId: number | undefined,
  resolvedAccountId: number | undefined,
  explicitDimensionId: number | undefined,
): number | undefined {
  if (explicitDimensionId !== undefined) {
    return explicitDimensionId;
  }

  const normalizedBaseDimensionId = baseDimensionId ?? undefined;
  if (normalizedBaseDimensionId === undefined) {
    return undefined;
  }

  if (resolvedAccountId === undefined) {
    return normalizedBaseDimensionId;
  }

  if (baseAccountId === undefined || resolvedAccountId !== baseAccountId) {
    return undefined;
  }

  return normalizedBaseDimensionId;
}

function buildSuggestionFromRule(
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  accounts: Account[],
  rule: AccountingAutoBookingRule,
  baseSuggestion?: ClassifiedTransactionSuggestion,
): ClassifiedTransactionSuggestion {
  const { article, account } = resolveAutoBookingRuleTargets(purchaseArticlesWithVat, accounts, rule);
  const purchaseArticleId = article?.id ?? rule.purchase_article_id ?? baseSuggestion?.purchase_article_id;
  const purchaseAccountId = account?.id ?? article?.accounts_id ?? rule.purchase_account_id ?? baseSuggestion?.purchase_account_id;
  const purchaseAccountDimensionsId = resolveMergedPurchaseAccountDimension(
    baseSuggestion?.purchase_account_dimensions_id,
    baseSuggestion?.purchase_account_id,
    purchaseAccountId,
    rule.purchase_account_dimensions_id,
  );

  return {
    purchase_article_id: purchaseArticleId,
    purchase_article_name: article?.name_est ?? article?.name_eng ?? baseSuggestion?.purchase_article_name,
    purchase_account_id: purchaseAccountId,
    purchase_account_name: account
      ? `${account.id} ${account.name_est}`
      : baseSuggestion?.purchase_account_name,
    purchase_account_dimensions_id: purchaseAccountDimensionsId,
    liability_account_id: rule.liability_account_id ?? baseSuggestion?.liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
    vat_rate_dropdown: rule.vat_rate_dropdown ?? baseSuggestion?.vat_rate_dropdown,
    reversed_vat_id: rule.reversed_vat_id ?? baseSuggestion?.reversed_vat_id,
    source: "local_rules",
    matched_invoice_id: baseSuggestion?.matched_invoice_id,
    matched_invoice_number: baseSuggestion?.matched_invoice_number,
    reason: rule.reason ?? baseSuggestion?.reason ?? "Defaulted from local accounting-rules.md counterparty rule.",
  };
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

function buildClassificationSuggestion(
  purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>,
  accounts: Account[],
  category: TransactionClassificationCategory,
  normalizedCounterparty: string,
  options?: {
    bookingSuggestion?: BookingSuggestion;
    autoBookingRule?: AccountingAutoBookingRule;
    manualReviewReason?: string;
  },
): ClassifiedTransactionSuggestion {
  if (options?.bookingSuggestion?.source === "supplier_history") {
    return buildSuggestionFromBookingHistory(options.bookingSuggestion);
  }

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

  const defaultSuggestion: ClassifiedTransactionSuggestion = {
    purchase_article_id: article?.id,
    purchase_article_name: article?.name_est ?? article?.name_eng,
    purchase_account_id: account?.id ?? article?.accounts_id,
    purchase_account_name: account ? `${account.id} ${account.name_est}` : undefined,
    liability_account_id: DEFAULT_LIABILITY_ACCOUNT,
    source: article ? "keyword_match" : "fallback",
    reason: options?.manualReviewReason ? `${reason} ${options.manualReviewReason}` : reason,
  };

  if (options?.autoBookingRule) {
    return buildSuggestionFromRule(purchaseArticlesWithVat, accounts, options.autoBookingRule, defaultSuggestion);
  }

  return defaultSuggestion;
}

async function resolveClassificationSuggestion(
  api: ApiContext,
  context: Pick<ReceiptProcessingContext, "purchaseInvoices" | "purchaseArticlesWithVat" | "accounts">,
  clients: Client[],
  group: TransactionGroup,
  classification: TransactionGroupClassification,
): Promise<{
  applyMode: ClassificationApplyMode;
  suggestion: ClassifiedTransactionSuggestion;
}> {
  const sample = group.transactions[0];
  const defaultSuggestion = buildClassificationSuggestion(
    context.purchaseArticlesWithVat,
    context.accounts,
    classification.category,
    group.normalized_counterparty,
  );
  if (!sample) {
    return { applyMode: classification.apply_mode, suggestion: defaultSuggestion };
  }

  const supplierResolution = await resolveSupplierFromTransaction(api, clients, sample, false, classification.category);
  const supplierId = supplierResolution.client?.id;
  if (supplierId) {
    const bookingSuggestion = await suggestBookingInternal(
      api,
      context,
      supplierId,
      sample.description ?? group.display_counterparty,
    );
    if (bookingSuggestion?.source === "supplier_history") {
      return {
        applyMode: classification.apply_mode,
        suggestion: buildClassificationSuggestion(
          context.purchaseArticlesWithVat,
          context.accounts,
          classification.category,
          group.normalized_counterparty,
          { bookingSuggestion },
        ),
      };
    }
  }

  const autoBookingRule = findAutoBookingRule(group.normalized_counterparty, classification.category);
  if (autoBookingRule && (
    classification.category === "bank_fees" ||
    hasConcreteAutoBookingRuleBookingTarget(autoBookingRule)
  )) {
    return {
      applyMode: classification.apply_mode,
      suggestion: buildClassificationSuggestion(
        context.purchaseArticlesWithVat,
        context.accounts,
        classification.category,
        group.normalized_counterparty,
        { autoBookingRule },
      ),
    };
  }

  if (
    classification.apply_mode === "purchase_invoice" &&
    classification.category !== "bank_fees"
  ) {
    const reviewSuggestion = buildClassificationSuggestion(
      context.purchaseArticlesWithVat,
      context.accounts,
      classification.category,
      group.normalized_counterparty,
      {
        manualReviewReason: autoBookingRule
          ? "A local rule exists, but it does not choose a stable expense article or account, so VAT and account treatment should still be reviewed manually."
          : "No confirmed supplier-history invoice or local rule was found, so VAT and account treatment should be reviewed manually.",
      },
    );
    // Thread VAT hint fields from the rule so reviewers still see the reverse-charge
    // hint even when the rule lacks a stable article/account booking target.
    if (autoBookingRule) {
      if (autoBookingRule.vat_rate_dropdown !== undefined) reviewSuggestion.vat_rate_dropdown = autoBookingRule.vat_rate_dropdown;
      if (autoBookingRule.reversed_vat_id !== undefined) reviewSuggestion.reversed_vat_id = autoBookingRule.reversed_vat_id;
      if (autoBookingRule.liability_account_id !== undefined) reviewSuggestion.liability_account_id = autoBookingRule.liability_account_id;
    }
    return {
      applyMode: "review_only",
      suggestion: reviewSuggestion,
    };
  }

  return { applyMode: classification.apply_mode, suggestion: defaultSuggestion };
}

async function extractReceiptFields(
  file: ReceiptFileInfo,
  ownCompanyVat?: string,
): Promise<ExtractedReceiptFields> {
  const validatedPath = await revalidateReceiptFilePath(file);
  const parsedDocument = await parseDocument(validatedPath);
  return extractReceiptFieldsFromText(parsedDocument.text, file.name, { ownCompanyVat });
}

function normalizeVatForCompare(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

/**
 * True when the document text contains the active company's own VAT and the
 * deterministic extractor (called with own-VAT excluded) did NOT recover a
 * different supplier VAT. Indicates the only VAT on the page was the
 * buyer's own (#14): supplier resolution must not silently proceed to
 * creating a duplicate of the active company.
 *
 * The check is a normalized-substring scan rather than a full re-run of
 * extractVatNumber: extraction already ran once with `ownCompanyVat`
 * excluded, so the only thing left to determine is whether ownVat appears
 * anywhere in the page at all.
 */
export function detectSelfVatOnly(extracted: ExtractedReceiptFields, ownCompanyVat: string | undefined): boolean {
  if (!ownCompanyVat || !extracted.raw_text) return false;
  if (extracted.supplier_vat_no) return false;
  const ownNormalized = normalizeVatForCompare(ownCompanyVat);
  if (!ownNormalized) return false;
  const normalizedText = extracted.raw_text.replace(/\s+/g, "").toUpperCase();
  return normalizedText.includes(ownNormalized);
}

/**
 * Derive the active company's registry code by looking it up in the clients
 * list. There is no e-arveldaja API endpoint that exposes the active
 * company's reg code directly, so we infer it from the company's own client
 * record. Two paths, in order:
 *
 *   1. Match a client by `invoice_vat_no` against the active company's VAT.
 *      Fast and unambiguous when the company has VAT and at least one client
 *      record reflects it.
 *   2. Match a client by normalized name against `invoice_company_name` from
 *      `/invoice_info`. Catches the case where the active company recently
 *      registered for VAT but its own client record has a stale (null/old)
 *      `invoice_vat_no` — the very situation #22 calls out.
 *
 * Path 2 requires a unique normalized-name match (≥4 chars, exactly one
 * client) so we don't pick up a coincidentally-named supplier.
 */
export function deriveOwnCompanyRegistryCode(
  clients: Client[],
  ownCompanyVat: string | undefined,
  ownCompanyName: string | undefined,
): string | undefined {
  const ownVatN = normalizeVatForCompare(ownCompanyVat);
  if (ownVatN) {
    const byVat = clients.find(
      client => !client.is_deleted && normalizeVatForCompare(client.invoice_vat_no) === ownVatN,
    );
    if (byVat?.code?.trim()) return byVat.code.trim();
  }
  if (ownCompanyName) {
    const targetKey = normalizeCompanyName(ownCompanyName);
    if (targetKey.length >= 4) {
      const candidates = clients.filter(
        client => !client.is_deleted && normalizeCompanyName(client.name) === targetKey,
      );
      if (candidates.length === 1 && candidates[0]!.code?.trim()) {
        return candidates[0]!.code.trim();
      }
    }
  }
  return undefined;
}

/**
 * Resolve `invoice_info` defensively. The endpoint is a recent addition;
 * test stubs and older API client mocks may not implement it. Returning an
 * empty object on any failure keeps the receipt-batch flow working — we
 * just lose the name-based fallback path for ownCompanyRegistryCode (#22).
 */
async function safeGetInvoiceInfo(api: ApiContext): Promise<{ invoice_company_name?: string | null }> {
  try {
    const fn = api.readonly.getInvoiceInfo;
    if (typeof fn !== "function") return {};
    return await fn.call(api.readonly);
  } catch {
    return {};
  }
}

/**
 * Auto-detect reverse-charge VAT and apply it to a booking suggestion (#18).
 *
 * Precedence:
 *  1. If supplier history (or local rules) already set `reversed_vat_id`,
 *     keep it — the call site has the strongest signal.
 *  2. Otherwise, an explicit reverse-charge phrase in OCR text wins
 *     (`reverse charge`, `pöördmaksustamine`, `Steuerschuldnerschaft des
 *     Leistungsempfängers`, …).
 *  3. Otherwise, when the active company is VAT-registered AND the
 *     resolved supplier is foreign (`cl_code_country !== "EST"`), apply
 *     reverse-charge as a service-invoice default. False positives push
 *     the result onto a reviewer; false negatives miscode VAT silently.
 *
 * The chosen reason is recorded on `bookingSuggestion.reverse_charge_reason`
 * and a human-readable note is appended for the review surface.
 */
export function applyReverseChargeAutoDetection(
  bookingSuggestion: BookingSuggestion,
  extracted: ExtractedReceiptFields,
  supplierResolution: SupplierResolution,
  isVatRegistered: boolean,
  notes: string[],
): void {
  // Case 1: history / local rule already decided.
  if (bookingSuggestion.item.reversed_vat_id !== undefined &&
      bookingSuggestion.item.reversed_vat_id !== null) {
    bookingSuggestion.reverse_charge_reason = "supplier_history";
    return;
  }

  // Case 2: phrase match.
  if (detectReverseChargeFromText(extracted.raw_text)) {
    bookingSuggestion.item.reversed_vat_id = 1;
    bookingSuggestion.reverse_charge_reason = "phrase_match";
    notes.push(
      "Reverse-charge VAT auto-applied from explicit phrase in invoice text (#18). Verify the booking before confirming.",
    );
    return;
  }

  // Case 3: foreign-supplier default. Requires (a) a VAT-registered active
  // company — without VAT registration the field has no effect — and (b) a
  // supplier whose resolved country is not Estonia.
  const supplierCountry =
    supplierResolution.client?.cl_code_country ?? supplierResolution.preview_client?.cl_code_country;
  if (isVatRegistered && supplierCountry && supplierCountry !== "EST") {
    bookingSuggestion.item.reversed_vat_id = 1;
    bookingSuggestion.reverse_charge_reason = "foreign_supplier_default";
    notes.push(
      `Reverse-charge VAT auto-applied as foreign-supplier default (supplier country: ${supplierCountry}). Override if the invoice is for goods imports rather than services (#18).`,
    );
    return;
  }

  bookingSuggestion.reverse_charge_reason = "none";
}

/**
 * Build the typed cross-reference for a payment receipt (issue #23).
 *
 * Payment receipts (Stripe / Anthropic / Wise outbound notifications) print
 * a reference to the underlying invoice they confirm. The deterministic
 * extractor's `invoice_number` is the receipt's best guess at that
 * reference. We expose the value as a typed field so downstream callers
 * (auto-attach via upload_invoice_document, manual review UIs) don't have
 * to parse it back out of the human note.
 *
 * `matched: true` AND `matched_invoice_id` are populated when the receipt's
 * invoice number resolves to an existing purchase invoice in this company's
 * book, status not DELETED/INVALIDATED. A no-match is still returned with
 * the invoice number so callers can chain a fallback (search the batch,
 * ask the user, etc.).
 *
 * AUTO-prefixed invoice numbers are placeholders the extractor synthesises
 * when it cannot find a confident number; we don't expose those — they'd
 * cause spurious cross-references.
 */
export function buildReferencedInvoiceForPaymentReceipt(
  invoiceNumber: string | undefined,
  purchaseInvoices: PurchaseInvoice[],
): { invoice_number: string; matched: boolean; matched_invoice_id?: number } | undefined {
  const trimmed = invoiceNumber?.trim();
  if (!trimmed || trimmed.toUpperCase().startsWith("AUTO-")) return undefined;
  const normalized = trimmed.toLowerCase();
  const found = purchaseInvoices.find(invoice =>
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.number.trim().toLowerCase() === normalized,
  );
  if (found?.id !== undefined) {
    return { invoice_number: trimmed, matched: true, matched_invoice_id: found.id };
  }
  return { invoice_number: trimmed, matched: false };
}

function existingInvoiceMatch(tx: Transaction, openSales: SaleInvoice[], openPurchases: PurchaseInvoice[]): boolean {
  if (tx.type !== "D" && tx.type !== "C") return false;
  const { allowSaleInvoices, allowPurchaseInvoices } = getInvoiceMatchEligibility(tx);

  if (allowSaleInvoices) {
    for (const invoice of openSales) {
      const { confidence } = scoreTransactionToInvoice(tx, invoice);
      if (confidence >= POSSIBLE_MATCH_THRESHOLD) {
        return true;
      }
    }
  }

  if (allowPurchaseInvoices) {
    for (const invoice of openPurchases) {
      const { confidence } = scoreTransactionToInvoice(tx, invoice);
      if (confidence >= POSSIBLE_MATCH_THRESHOLD) {
        return true;
      }
    }
  }

  return false;
}

function toClassifiedResult(
  group: TransactionGroup,
  classification: TransactionGroupClassification,
  suggestion: ClassifiedTransactionSuggestion,
  reviewGuidance?: ReviewGuidance,
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
    review_guidance: reviewGuidance,
    transactions: group.transactions.map(transaction => ({
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      date: transaction.date,
      description: wrapUntrustedOcr(transaction.description ?? undefined),
      bank_account_name: wrapUntrustedOcr(transaction.bank_account_name ?? undefined),
      bank_subtype: transaction.bank_subtype,
      accounts_dimensions_id: transaction.accounts_dimensions_id,
      clients_id: transaction.clients_id,
    })),
  };
}

export async function resolveSupplierFromTransaction(
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

  // Without any counterparty signal we would feed resolveSupplierInternal a
  // placeholder like "Transaction 123" and potentially create a bogus client.
  // Treat that as unresolved supplier instead.
  const supplierName = transaction.bank_account_name ?? transaction.description;
  const supplierIban = transaction.bank_account_no ?? undefined;
  if (!supplierName && !supplierIban) {
    return { found: false, created: false };
  }

  return resolveSupplierInternal(api, clients, {
    supplier_name: supplierName ?? "",
    supplier_iban: supplierIban,
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
  const handlers = new Map<string, ReceiptInboxToolHandler>();

  function registerCapturedTool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown,
  ): void {
    handlers.set(name, cb as unknown as ReceiptInboxToolHandler);
    registerTool(server, name, description, paramsSchema, annotations, cb);
  }

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
          text: toMcpJson(result),
        }],
      };
    },
  );

  registerCapturedTool(
    "process_receipt_batch",
    "Process receipt PDFs and images from a folder. DRY RUN by default. OCR text is returned for all supported files, and incomplete deterministic extraction is surfaced through llm_fallback (with a confidence: low|medium|high score, see #20) for model/manual review. Use execution_mode='create' to create/upload PROJECT invoices, or execution_mode='create_and_confirm' only after approval for high-confidence rows. Legacy execute=true maps to execution_mode='create' (#19).",
    {
      folder_path: z.string().describe("Folder path with receipts"),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID used when matching bank transactions"),
      execution_mode: z.enum(RECEIPT_BATCH_EXECUTION_MODES).optional().describe("Execution phase: dry_run (default), create (create/upload PROJECT invoices only), or create_and_confirm (create, upload, confirm, and exact-match bank transactions after explicit approval)"),
      execute: z.boolean().optional().describe("Deprecated compatibility flag. true maps to execution_mode='create'; false maps to dry_run when execution_mode is omitted."),
      date_from: z.string().optional().describe("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
    },
    { ...batch, openWorldHint: true, title: "Process Receipt Batch" },
    async ({ folder_path, accounts_dimensions_id, execution_mode, execute, date_from, date_to }) => {
      const { mode: executionMode, legacyExecuteCreate } = resolveReceiptBatchExecutionMode(
        execute,
        execution_mode as ReceiptBatchExecutionMode | undefined,
      );
      const dryRun = executionMode === "dry_run";
      const scan = await scanReceiptFolderInternal(folder_path, undefined, date_from, date_to);
      const vatInfo = await api.readonly.getVatInfo();
      // getInvoiceInfo is best-effort: a missing endpoint or test stub means
      // we lose the name-based fallback for ownCompanyRegistryCode (#22),
      // but VAT-based self-match still works.
      const invoiceInfo = await safeGetInvoiceInfo(api);
      const ownCompanyVat = vatInfo.vat_number?.trim() || undefined;
      const context: ReceiptProcessingContext = {
        clients: await api.clients.listAll(),
        purchaseInvoices: await api.purchaseInvoices.listAll(),
        purchaseArticlesWithVat: await getPurchaseArticlesWithVat(api),
        accounts: await api.readonly.getAccounts(),
        isVatRegistered: !!vatInfo.vat_number,
      };
      const ownCompanyRegistryCode = deriveOwnCompanyRegistryCode(
        context.clients,
        ownCompanyVat,
        invoiceInfo.invoice_company_name?.trim() || undefined,
      );
      const allTransactions = await api.transactions.listAll();
      const bankTransactions = allTransactions.filter(transaction =>
        transaction.accounts_dimensions_id === accounts_dimensions_id &&
        isProjectTransaction(transaction) &&
        // All API-created and CAMT-imported bank transactions are type "C" regardless of
        // debit/credit direction (see CLAUDE.md). This filter is a defensive guard — any
        // legacy type="D" rows are intentionally excluded from auto-match.
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
          const extracted = await extractReceiptFields(file, ownCompanyVat);
          const classification = classifyReceiptDocument(extracted.raw_text ?? file.name, file.name);
          const selfVatDetected = detectSelfVatOnly(extracted, ownCompanyVat);

          // Confidence signals accumulated as we walk the per-file pipeline
          // (#20). The summary is recomputed at each push site rather than
          // once up-front so late-stage findings (supplier resolution
          // outcome, booking source, in-batch duplicates, reverse-charge
          // phrasing without a flag) feed into the confidence verdict.
          const signals: ExtractionConfidenceSignals = {};
          if (selfVatDetected) signals.self_vat_detected = true;
          const summarize = () => summarizeInvoiceExtraction(extracted, signals);
          const llmFallback = summarize();

          if (file.file_type !== "pdf") {
            notes.push("Image receipt OCR-parsed with LiteParse.");
          }
          if (selfVatDetected) {
            notes.push(
              "Document only printed the buyer's VAT (matches active company). Supplier VAT cleared — verify supplier manually before booking (#14).",
            );
          }

          if (classification !== "purchase_invoice") {
            const referencedInvoice =
              classification === "payment_receipt"
                ? buildReferencedInvoiceForPaymentReceipt(extracted.invoice_number, context.purchaseInvoices)
                : undefined;
            notes.push(
              classification === "owner_paid_expense_reimbursement"
                ? "PDF looks like an owner-paid expense receipt. Review manually before booking."
                : classification === "payment_receipt"
                  ? `Document is a payment receipt${
                      referencedInvoice
                        ? ` for invoice ${referencedInvoice.invoice_number}`
                        : ""
                    }, not a separate purchase invoice. Booking it would duplicate the underlying invoice — attach to the existing invoice document instead (#15).`
                  : "Document could not be classified as a supplier purchase invoice.",
            );
            maybeAddLlmFallbackNote(notes, llmFallback);
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: llmFallback,
              ...(referencedInvoice ? { referenced_invoice: referencedInvoice } : {}),
              review_guidance: buildReceiptReviewGuidance({
                classification,
                notes,
                extracted,
                llmFallback,
              }),
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
              review_guidance: buildReceiptReviewGuidance({
                classification,
                notes,
                extracted,
                llmFallback,
              }),
              notes,
            });
            continue;
          }

          const supplierResolution = await resolveSupplierInternal(
            api,
            context.clients,
            extracted,
            !dryRun,
            ownCompanyVat || ownCompanyRegistryCode
              ? {
                  ...(ownCompanyVat ? { ownCompanyVat } : {}),
                  ...(ownCompanyRegistryCode ? { ownCompanyRegistryCode } : {}),
                }
              : undefined,
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
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: fallback,
              supplier_resolution: supplierResolution,
              review_guidance: buildReceiptReviewGuidance({
                classification,
                notes,
                extracted,
                llmFallback: fallback,
              }),
              notes,
            });
            continue;
          }

          if (supplierCountryNeedsReview(supplierResolution)) {
            const fallback = summarize();
            notes.push("Supplier country could not be inferred from IBAN, VAT number, or OCR country text. Manual review required before booking.");
            maybeAddLlmFallbackNote(notes, fallback);
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: fallback,
              supplier_resolution: supplierResolution,
              review_guidance: buildReceiptReviewGuidance({
                classification,
                notes,
                extracted,
                llmFallback: fallback,
              }),
              notes,
            });
            continue;
          }

          const resolvedClientId = supplierResolution.client?.id;
          if (!resolvedClientId && dryRun) {
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
            applyReverseChargeAutoDetection(bookingSuggestion, extracted, supplierResolution, context.isVatRegistered, notes);
            // Foreign-supplier reverse-charge default fits SaaS/services
            // but mis-codes goods imports, so it must NOT silently
            // auto-confirm (#18). Flag the row so the contract gate (#19)
            // routes it to needs_review rather than create+confirm.
            if (bookingSuggestion.reverse_charge_reason === "foreign_supplier_default") {
              signals.foreign_reverse_charge_default_unverified = true;
            }
            signals.booking_from_history = bookingSuggestion.source === "supplier_history";
            // Improbable fixed-asset guard (#20): a small invoice routed
            // to a fixed-asset account is almost certainly miscoded. The
            // 1000 EUR threshold is a defensive heuristic — typical SaaS,
            // cloud, professional-services invoices fall well below it.
            if (
              bookingSuggestion.suggested_account?.is_fixed_asset &&
              extracted.total_gross !== undefined &&
              extracted.total_gross < 1000
            ) {
              signals.improbable_fixed_asset = true;
            }
            // Reverse-charge phrase present but the booking suggestion did
            // not flag it: should be rare since applyReverseChargeAutoDetection
            // sets it automatically. The signal handles edge cases where the
            // phrase regex hits but downstream logic refused to apply.
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
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: fallback,
              supplier_resolution: supplierResolution,
              review_guidance: buildReceiptReviewGuidance({
                classification,
                notes,
                extracted,
                llmFallback: fallback,
              }),
              notes,
            });
            continue;
          }

          // In-batch duplicate detection (#19): two files in the same batch
          // bearing the same supplier-side invoice number AND a matching
          // supplier identity are almost always the same invoice scanned
          // twice. The first wins; the second is flagged.
          //
          // Also key by reg_code / VAT / normalized supplier name so dry
          // runs that haven't yet created a client (only a preview_client)
          // still detect the dupe. Without this, scanning an unknown
          // supplier twice would silently under-report the risk in
          // dry-run output.
          if (extracted.invoice_number) {
            const myInvoice = extracted.invoice_number.trim().toLowerCase();
            const myRegCode = extracted.supplier_reg_code?.trim();
            const myVat = normalizeVatForCompare(extracted.supplier_vat_no);
            const myNameKey = extracted.supplier_name ? normalizeCompanyName(extracted.supplier_name) : "";
            const earlier = results.find(prev => {
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
              results.push({
                file,
                classification,
                status: "skipped_duplicate",
                extracted,
                llm_fallback: summarize(),
                supplier_resolution: supplierResolution,
                booking_suggestion: bookingSuggestion,
                duplicate_match: duplicate,
                notes: [`Skipped duplicate by ${duplicate.reason}.`],
              });
              continue;
            }
          }

          // Contract gate (#19): the explicit create/create_and_confirm
          // paths still refuse to mutate any row whose final confidence is
          // "low" — silent miscoding is the worse failure than holding the
          // row for review.
          //
          // We additionally gate `foreign_reverse_charge_default_unverified`
          // at medium: that signal means we auto-applied reverse-charge
          // because the supplier is foreign with no explicit phrase or
          // history backing. The default is right for SaaS / services and
          // wrong for goods imports — the fact that the rest of the
          // extraction succeeded does not let us judge which it is. A
          // blanket "block all medium" is too aggressive here because
          // `booking_not_from_history` makes many legitimate keyword
          // bookings medium too; only this specific signal is gated.
          //
          // Dry-run mirrors the same gate so `dry_run_preview` and the
          // approval card it feeds reflect what `execution_mode="create"`
          // would actually do — otherwise the preview promises a booking
          // that the executor will refuse and route to review.
          const preCreateSummary = summarize();
          const foreignDefaultUnverified = preCreateSummary.confidence_signals.includes(
            "foreign_reverse_charge_default_unverified",
          );
          const confirmModeNeedsHighConfidence =
            executionMode === "create_and_confirm" && preCreateSummary.confidence !== "high";
          if (preCreateSummary.confidence === "low" || foreignDefaultUnverified || confirmModeNeedsHighConfidence) {
            const reasons = preCreateSummary.confidence_signals.join(", ") || "low confidence";
            const tense = dryRun ? "would be skipped" : "skipped";
            notes.push(
              `Auto-create ${tense}: confidence is ${preCreateSummary.confidence} (${reasons}). Manual review required before booking or confirming (#19).`,
            );
            results.push({
              file,
              classification,
              status: "needs_review",
              extracted,
              llm_fallback: preCreateSummary,
              supplier_resolution: supplierResolution,
              booking_suggestion: bookingSuggestion,
              review_guidance: buildReceiptReviewGuidance({
                classification,
                notes,
                extracted,
                llmFallback: preCreateSummary,
              }),
              notes,
            });
            continue;
          }

          const created = await createAndMaybeMatchPurchaseInvoice(
            api,
            context,
            file,
            extracted,
            supplierResolution,
            bookingSuggestion,
            bankTransactions,
            executionMode,
            legacyExecuteCreate,
            consumedTransactionIds,
          );

          results.push({
            file,
            classification,
            status: created.status,
            extracted,
            llm_fallback: summarize(),
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

      const summary = buildReceiptBatchSummary({
        executionMode,
        legacyExecuteCreate,
        dryRun,
        scannedFiles: scan.files.length,
        skippedInvalidFiles: scan.skipped.length,
        results,
      });
      const mode = dryRun ? "DRY_RUN" : "EXECUTED";
      const sanitizedResults = results.map(sanitizeReceiptResultForOutput);
      const workflowArgs = {
        folder_path,
        accounts_dimensions_id,
        ...(date_from ? { date_from } : {}),
        ...(date_to ? { date_to } : {}),
        execution_mode: "create",
      };
      const workflowSummary = buildReceiptBatchWorkflowSummary(summary);
      const workflow = buildReceiptBatchWorkflow({
        summary,
        workflowSummary,
        sanitizedResults,
        workflowArgs,
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode,
            execution_mode: executionMode,
            folder_path: scan.folder_path,
            accounts_dimensions_id,
            summary,
            workflow,
            skipped: scan.skipped,
            results: sanitizedResults,
            execution: buildReceiptBatchExecution({
              mode,
              summary,
              sanitizedResults,
            }),
          }),
        }],
      };
    },
  );

  registerTool(server,
    "receipt_batch",
    "Merged receipt batch entry point. Use mode='scan' to inspect supported files, mode='dry_run' to preview purchase invoice creation, mode='create' to create/upload PROJECT invoices after approval, or mode='create_and_confirm' only after explicit approval for high-confidence rows.",
    {
      mode: z.enum(["scan", "dry_run", "create", "create_and_confirm"]).optional().describe("Workflow phase to run. Defaults to scan."),
      folder_path: z.string().describe("Folder path with receipts"),
      accounts_dimensions_id: coerceId.optional().describe("Bank account dimension ID used when matching bank transactions. Required except in scan mode."),
      date_from: z.string().optional().describe("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
      file_types: z.array(z.enum(["pdf", "jpg", "png"])).optional().describe("Optional file type filter for scan mode"),
    },
    { ...batch, openWorldHint: true, title: "Receipt Batch" },
    async ({ mode, folder_path, accounts_dimensions_id, date_from, date_to, file_types }) => {
      const selectedMode = mode ?? "scan";
      let delegatedTool: string;
      let delegatedArgs: Record<string, unknown>;
      let result: unknown;

      if (selectedMode === "scan") {
        delegatedTool = "scan_receipt_folder";
        delegatedArgs = {
          folder_path,
          ...(file_types !== undefined ? { file_types } : {}),
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
        };
        result = await scanReceiptFolderInternal(folder_path, file_types, date_from, date_to);
      } else {
        if (accounts_dimensions_id === undefined) {
          throw new Error("accounts_dimensions_id is required when mode is dry_run, create, or create_and_confirm");
        }
        delegatedTool = "process_receipt_batch";
        delegatedArgs = {
          folder_path,
          accounts_dimensions_id,
          execution_mode: selectedMode,
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
        };
        result = await invokeCapturedTool(delegatedTool, delegatedArgs);
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            recommended_entry_point: "receipt_batch",
            mode: selectedMode,
            delegated_tool: delegatedTool,
            delegated_args: delegatedArgs,
            result,
          }),
        }],
      };
    },
  );

  registerCapturedTool(
    "classify_unmatched_transactions",
    "Classify unconfirmed bank transactions that do not match any sale or purchase invoice. Read-only analysis with suggested booking defaults.",
    {
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID"),
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
      const context = {
        purchaseInvoices,
        purchaseArticlesWithVat,
        accounts,
      };
      const classifiedGroups: ClassifiedTransactionGroupResult[] = [];

      for (const group of groups) {
        const classification = categorizeTransactionGroup({
          normalized_counterparty: group.normalized_counterparty,
          display_counterparty: group.display_counterparty,
          transactions: group.transactions,
          owner_counterparties: ownerCounterparties,
        });
        const resolved = await resolveClassificationSuggestion(api, context, clients, group, classification);
        const applyMode = resolved.applyMode;
        classifiedGroups.push(toClassifiedResult(group, {
          ...classification,
          apply_mode: applyMode,
        }, resolved.suggestion, applyMode !== "purchase_invoice"
          ? buildClassificationReviewGuidance({
              category: classification.category,
              displayCounterparty: group.display_counterparty,
            })
          : undefined));
      }

      const categoryCounts = classifiedGroups.reduce<Record<string, number>>((counts, group) => {
        counts[group.category] = (counts[group.category] ?? 0) + group.transactions.length;
        return counts;
      }, {});

      // display_counterparty and each transaction's description/bank_account_name
      // originate from bank-statement import and are attacker-controllable at
      // the counterparty layer. Wrap at the MCP boundary so classify output
      // reaching the LLM is sandboxed. apply_transaction_classifications
      // re-fetches transactions by id, so wrapped text in the JSON payload
      // never participates in server-side lookups.
      const sanitizedGroups = classifiedGroups.map(g => ({
        ...g,
        display_counterparty: wrapUntrustedOcr(g.display_counterparty) ?? g.display_counterparty,
        transactions: g.transactions.map(t => ({
          ...t,
          description: wrapUntrustedOcr(t.description ?? undefined),
          bank_account_name: wrapUntrustedOcr(t.bank_account_name ?? undefined),
        })),
      }));

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            schema_version: 1,
            accounts_dimensions_id,
            period: {
              from: date_from ?? "all",
              to: date_to ?? "all",
            },
            total_unconfirmed: unconfirmed.length,
            total_unmatched: unmatched.length,
            category_counts: categoryCounts,
            groups: sanitizedGroups,
          }),
        }],
      };
    },
  );

  registerCapturedTool(
    "apply_transaction_classifications",
    "Apply the output of classify_unmatched_transactions. DRY RUN by default. Only expense-like categories are auto-booked as purchase invoices; review-only categories are reported back.",
    {
      classifications_json: jsonObjectOrArrayInput.describe("Structured output from classify_unmatched_transactions. Legacy callers may still pass a JSON string."),
      execute: z.boolean().optional().describe("Actually create invoices and link transactions (default false = dry run)"),
    },
    { ...batch, title: "Apply Transaction Classifications" },
    async ({ classifications_json, execute }) => {
      const dryRun = execute !== true;
      const parsed = typeof classifications_json === "string"
        ? safeJsonParse(classifications_json, "classifications_json")
        : classifications_json;
      const groups = extractClassificationGroups(parsed);

      const [clients, purchaseArticlesWithVat, purchaseInvoices, accounts] = await Promise.all([
        api.clients.listAll(),
        getPurchaseArticlesWithVat(api),
        api.purchaseInvoices.listAll(),
        api.readonly.getAccounts(),
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
          let wouldCreateCount = 0;
          let attemptedCreateCount = 0;

          for (const transaction of freshTransactions) {
            const supplierResolution = await resolveSupplierFromTransaction(api, clients, transaction, !dryRun, group.category);
            const supplier = supplierResolution.client;
            const supplierId = supplier?.id;
            const supplierMetadata = supplierResolution.client ?? supplierResolution.preview_client;
            const grossAmount = roundMoney(Math.abs(transaction.amount));
            const transactionCurrency = (transaction.cl_currencies_id ?? "EUR").toUpperCase();
            const transactionCurrencyRate = transaction.currency_rate;
            const transactionGroup: TransactionGroup = {
              normalized_counterparty: group.normalized_counterparty,
              display_counterparty: group.display_counterparty,
              transactions: [transaction],
            };
            const resolved = await resolveClassificationSuggestion(api, {
              purchaseInvoices,
              purchaseArticlesWithVat,
              accounts,
            }, clients, transactionGroup, {
              category: group.category,
              apply_mode: group.apply_mode,
              recurring: group.recurring,
              similar_amounts: group.similar_amounts,
              reasons: group.reasons,
            });
            if (!supplier?.id && dryRun) {
              notes.push(`Dry run: transaction ${transaction.id} would require creating a supplier for ${group.display_counterparty}.`);
            }
            if (!supplier?.id && !dryRun) {
              notes.push(`Transaction ${transaction.id} could not resolve a supplier client.`);
              continue;
            }

            if (resolved.applyMode !== "purchase_invoice") {
              notes.push(`Transaction ${transaction.id} requires manual review before booking. ${resolved.suggestion.reason}`);
              continue;
            }

            if (
              transactionCurrency !== "EUR" &&
              (transactionCurrencyRate === undefined ||
                transactionCurrencyRate === null ||
                !Number.isFinite(transactionCurrencyRate) ||
                transactionCurrencyRate <= 0)
            ) {
              notes.push(
                `Non-EUR transaction ${transaction.id} uses ${transactionCurrency} but has no currency_rate. Review manually or retry after the transaction exposes a valid EUR conversion rate.`
              );
              continue;
            }

            const article = purchaseArticlesWithVat.find(item => item.id === resolved.suggestion.purchase_article_id);
            const vatConfig = getBookingSuggestionVatConfig({
              item: {
                vat_rate_dropdown: resolved.suggestion.vat_rate_dropdown,
                reversed_vat_id: resolved.suggestion.reversed_vat_id,
              } as PurchaseInvoiceItem,
            }) ?? getAutoBookedVatConfig(group.category, supplierMetadata?.cl_code_country);
            const netAmount = deriveAutoBookedNetAmount(grossAmount, vatConfig);
            const purchaseItem = applyPurchaseVatDefaults(
              purchaseArticlesWithVat,
              {
                cl_purchase_articles_id: resolved.suggestion.purchase_article_id,
                purchase_accounts_id: resolved.suggestion.purchase_account_id ?? article?.accounts_id,
                purchase_accounts_dimensions_id: resolved.suggestion.purchase_account_dimensions_id,
                custom_title: transaction.description ?? `Auto-booked ${group.category}`,
                unit_net_price: netAmount,
                total_net_price: netAmount,
                amount: 1,
                ...vatConfig,
              },
              isVatRegistered,
            );

            if (dryRun) {
              wouldCreateCount += 1;
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
                cl_currencies_id: transactionCurrency,
                ...(transactionCurrency !== "EUR" ? { currency_rate: transactionCurrencyRate } : {}),
                liability_accounts_id: resolved.suggestion.liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
                notes: tagNotes(`Auto-created from classified bank transaction ${transaction.id}`),
                items: [purchaseItem],
              },
              deriveAutoBookedVatPrice(grossAmount, vatConfig),
              grossAmount,
              isVatRegistered,
            );
            attemptedCreateCount += 1;
            logAudit({
              tool: "apply_transaction_classifications", action: "CREATED", entity_type: "purchase_invoice",
              entity_id: invoice.id,
              summary: `Auto-booked purchase invoice from transaction ${transaction.id} (${group.display_counterparty})`,
              details: { supplier_name: supplier.name, invoice_number: `AUTO-TX-${transaction.id}`, date: transaction.date, total_gross: grossAmount },
            });

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
                logAudit({
                  tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "purchase_invoice",
                  entity_id: invoice.id,
                  summary: `Auto-confirmed purchase invoice ${invoice.id} for transaction ${transaction.id}`,
                  details: { invoice_id: invoice.id, transaction_id: transaction.id },
                });
                await api.transactions.confirm(transaction.id!, [{
                  related_table: "purchase_invoices",
                  related_id: invoice.id,
                  amount: transaction.amount,
                }]);
                logAudit({
                  tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "transaction",
                  entity_id: transaction.id!,
                  summary: `Auto-confirmed transaction ${transaction.id} against invoice ${invoice.id}`,
                  details: { amount: transaction.amount, invoice_id: invoice.id },
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await invalidateAutoCreatedInvoice(`automation failed after creation: ${message}`);
                continue;
              }

              createdInvoiceIds.push(invoice.id);
              linkedTransactionIds.push(transaction.id!);
            }
          }

          const status = dryRun
            ? (wouldCreateCount > 0 ? "dry_run_preview" : "skipped")
            : (createdInvoiceIds.length > 0 && createdInvoiceIds.length === freshTransactions.length
                ? "applied"
                : attemptedCreateCount > 0
                  ? "failed"
                  : "skipped");

          results.push({
            category: group.category,
            counterparty: group.display_counterparty,
            status,
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

      const summary = {
        applied: results.filter(result => result.status === "applied").length,
        skipped: results.filter(result => result.status === "skipped").length,
        dry_run_preview: results.filter(result => result.status === "dry_run_preview").length,
        failed: results.filter(result => result.status === "failed").length,
      };
      const mode = dryRun ? "DRY_RUN" : "EXECUTED";
      const workflowArgs = {
        classifications_json,
        execute: false,
      };
      const workflowSummary = dryRun
        ? `Classification dry run would create ${summary.dry_run_preview} purchase invoice group(s), skip ${summary.skipped}, and fail ${summary.failed}.`
        : `Applied ${summary.applied} classification group(s), skipped ${summary.skipped}, and failed ${summary.failed}.`;
      const workflow = buildWorkflowEnvelope({
        summary: workflowSummary,
        dry_run_steps: dryRun
          ? [{
              tool: "apply_transaction_classifications",
              summary: workflowSummary,
              suggested_args: workflowArgs,
              preview: summary,
            }]
          : [],
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode,
            dry_run: dryRun,
            summary,
            workflow,
            results,
            execution: buildBatchExecutionContract({
              mode,
              summary,
              results: results.filter(result =>
                result.status === "applied" ||
                result.status === "dry_run_preview"
              ),
              skipped: results.filter(result => result.status === "skipped"),
              errors: results.filter(result => result.status === "failed"),
            }),
          }),
        }],
      };
    },
  );

  async function invokeCapturedTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const handler = handlers.get(tool);
    if (!handler) {
      throw new Error(`Classification wrapper could not find tool handler for ${tool}`);
    }

    const result = await handler(args);
    const text = result.content[0]?.text;
    if (!text) {
      throw new Error(`Classification wrapper received no text payload from ${tool}`);
    }

    const parsed = parseMcpResponse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  }

  registerTool(server,
    "classify_bank_transactions",
    "Merged unmatched bank transaction classification entry point. Use mode='classify' to group unmatched transactions, mode='dry_run_apply' to preview applying classifications, or mode='execute_apply' to create and link purchase invoices after approval.",
    {
      mode: z.enum(["classify", "dry_run_apply", "execute_apply"]).optional().describe("Workflow phase to run. Defaults to classify."),
      accounts_dimensions_id: coerceId.optional().describe("Bank account dimension ID. Required for mode='classify'."),
      date_from: z.string().optional().describe("Optional lower transaction date bound for mode='classify' (YYYY-MM-DD)."),
      date_to: z.string().optional().describe("Optional upper transaction date bound for mode='classify' (YYYY-MM-DD)."),
      classifications_json: jsonObjectOrArrayInput.optional().describe("Structured output from mode='classify'. Required for apply modes."),
    },
    { ...batch, title: "Classify Bank Transactions" },
    async ({ mode, accounts_dimensions_id, date_from, date_to, classifications_json }) => {
      const selectedMode = mode ?? "classify";
      let delegatedTool: string;
      let delegatedArgs: Record<string, unknown>;

      if (selectedMode === "classify") {
        if (accounts_dimensions_id === undefined) {
          throw new Error("accounts_dimensions_id is required when mode is classify");
        }
        delegatedTool = "classify_unmatched_transactions";
        delegatedArgs = {
          accounts_dimensions_id,
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
        };
      } else {
        if (classifications_json === undefined) {
          throw new Error("classifications_json is required when applying transaction classifications");
        }
        delegatedTool = "apply_transaction_classifications";
        delegatedArgs = {
          classifications_json,
          execute: selectedMode === "execute_apply",
        };
      }

      const result = await invokeCapturedTool(delegatedTool, delegatedArgs);
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            recommended_entry_point: "classify_bank_transactions",
            mode: selectedMode,
            delegated_tool: delegatedTool,
            delegated_args: delegatedArgs,
            result,
          }),
        }],
      };
    },
  );
}
