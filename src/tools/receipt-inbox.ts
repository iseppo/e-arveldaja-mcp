import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { basename, dirname, join } from "node:path";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { FILE_REFERENCE_OPERATIONS, FileReferenceStoreError } from "../file-reference-store.js";
import { sandboxExternalText } from "../external-text-renderer.js";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { toolError } from "../tool-error.js";
import { HttpError } from "../http-client.js";
import { isMutationIndeterminate } from "../mutation-outcome.js";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";
import type { Account, Client, PurchaseInvoice, PurchaseInvoiceItem, SaleInvoice, Transaction } from "../types/api.js";
import { readOnly, batch } from "../annotations.js";
import { isProjectTransaction } from "../transaction-status.js";
import { type ApiContext, jsonObjectOrArrayInput, coerceId } from "./crud-tools.js";
import { getPurchaseArticlesWithVat } from "./purchase-vat-defaults.js";
import { parseDocument } from "../document-parser.js";
import { normalizeVatValue } from "../document-identifiers.js";
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
  CATEGORY_KEYWORD_MAP,
  buildKeywordSuggestion,
  classifyReceiptDocument,
  detectReverseChargeFromText,
  computeMinOcrConfidence,
  extractReceiptFieldsFromText,
  findAccountByKeywords,
  findPurchaseArticleByKeywords,
  hasAutoBookableReceiptFields,
  inferSupplierCountry,
  LOW_OCR_CONFIDENCE_THRESHOLD,
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
  buildReceiptReviewGuidance,
} from "../estonian-accounting-guidance.js";
import { remapHiddenGranularWorkflowResult } from "../workflow-response.js";
import { DEFAULT_LIABILITY_ACCOUNT, EMTA_PREPAYMENT_ACCOUNT } from "../accounting-defaults.js";
import {
  RECEIPT_BATCH_EXECUTION_MODES,
  type ReceiptApprovedManifestEntry,
  type ReceiptBatchSnapshot,
  type ReceiptBatchExecutionMode,
  type ReceiptBatchFileResult,
  type ReceiptFileInfo,
  type ReceiptFileSnapshot,
  type ReceiptProcessingContext,
} from "./receipt-inbox-types.js";
import {
  prepareReceiptBatchSnapshot,
  scanReceiptFolderInternal,
  validateReceiptFolderPath,
  type ReceiptDirectoryAccessOptions,
} from "./receipt-inbox-files.js";
import { findDuplicateInvoice } from "./receipt-inbox-matching.js";
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
import {
  createReceiptBatchOperations,
  resolveReceiptBatchExecutionMode,
} from "../receipts/batch-operations.js";
import {
  receiptApprovedManifestRequiredError,
  receiptIdentityRetryableError,
  renderReceiptBatchCompact,
  renderReceiptBatchFull,
  type ReceiptBatchCompactInput,
  type ReceiptBatchFileRefProjection,
} from "../receipts/presenter.js";
import { createClassificationOperations } from "../receipts/classification-operations.js";
import {
  renderApplyClassificationsCompact,
  renderApplyClassificationsFull,
  renderClassificationAnalysisCompact,
  renderUnmatchedAnalysisFull,
} from "../receipts/classification-presenter.js";
import { currentToolProfile } from "../tool-profile.js";

const POSSIBLE_MATCH_THRESHOLD = 70;

// H15: the exact SHA-256 manifest a dry-run returned. Binding create/confirm to
// it lets prepareReceiptBatchSnapshot reject a folder that changed since the
// operator approved the preview, before any API mutation.
const directManifestEntrySchema = z.object({
  relative_path: z.string().min(1).refine(value => !value.includes("/") && !value.includes("\\")),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const referencedManifestEntrySchema = z.object({
  file_ref: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  display_name: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const manifestSchema = z.array(z.union([
  directManifestEntrySchema,
  referencedManifestEntrySchema,
]));

type ReceiptManifestInputEntry = z.infer<typeof manifestSchema>[number];

export { buildDryRunCreatedInvoicePreview };

export function supplierCountryNeedsReview(supplierResolution: SupplierResolution): boolean {
  return !supplierResolution.client &&
    !!supplierResolution.preview_client &&
    !supplierResolution.preview_client.cl_code_country;
}

export interface TransactionGroup {
  normalized_counterparty: string;
  display_counterparty: string;
  transactions: Transaction[];
}

export interface ClassifiedTransactionSuggestion {
  purchase_article_id?: number;
  purchase_article_name?: string;
  purchase_account_id?: number;
  purchase_account_name?: string;
  purchase_account_dimensions_id?: number;
  liability_account_id?: number;
  vat_rate_dropdown?: string;
  reversed_vat_id?: number;
  source?: "supplier_history" | "keyword_match" | "fallback" | "local_rules" | "category_default";
  matched_invoice_id?: number;
  matched_invoice_number?: string;
  reason: string;
}

export interface ClassifiedTransactionGroupResult {
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

export type PartialClassificationStatus = "PROJECT" | "CONFIRMED" | "VOID" | "UNKNOWN";

export interface PartialClassificationMutation {
  category: "mutation_indeterminate" | "mutation_failed";
  mutation_may_have_occurred: true;
  failed_stage:
    | "transaction_reread"
    | "invoice_invalidation"
    | "invoice_confirmation"
    | "transaction_confirmation";
  created_invoice_id: number;
  created_invoice_status: PartialClassificationStatus;
  attempted_transaction_id: number;
  transaction_status: PartialClassificationStatus;
  next_action: string;
}

export function invoiceClassificationStatus(status: unknown): PartialClassificationStatus {
  return status === "PROJECT" || status === "CONFIRMED" ? status : "UNKNOWN";
}

export function transactionClassificationStatus(
  transaction: Pick<Transaction, "status" | "is_deleted">,
): PartialClassificationStatus {
  if (transaction.is_deleted === true) return "UNKNOWN";
  return transaction.status === "PROJECT" ||
    transaction.status === "CONFIRMED" ||
    transaction.status === "VOID"
    ? transaction.status
    : "UNKNOWN";
}

export function isAmbiguousPostCreateFailure(error: unknown): boolean {
  return isMutationIndeterminate(error) || (
    error instanceof HttpError && error.status === "network"
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Exported for unit tests.
export function shouldGateCreation(
  summary: InvoiceExtractionFallback,
  executionMode: ReceiptBatchExecutionMode,
): { gate: boolean; reason: string } {
  const foreignDefaultUnverified = summary.confidence_signals.includes(
    "foreign_reverse_charge_default_unverified",
  );
  // #4: an echo-only supplier identifier may be a buyer code misread from a
  // supplier-column reference line — booking a purchase invoice against it would
  // book to the wrong (or the active) company. Gate creation in every mode (like
  // foreign_reverse_charge_default_unverified) so the operator verifies the
  // supplier first, matching the "route to review before booking" intent; a bare
  // medium signal would not block plain `create` mode.
  const supplierIdentifierEchoUnconfirmed = summary.confidence_signals.includes(
    "supplier_identifier_echo_unconfirmed",
  );
  const confirmModeNeedsHighConfidence =
    executionMode === "create_and_confirm" && summary.confidence !== "high";
  const gate = summary.confidence === "low" ||
    foreignDefaultUnverified ||
    supplierIdentifierEchoUnconfirmed ||
    confirmModeNeedsHighConfidence;
  return {
    gate,
    reason: summary.confidence_signals.join(", ") || "low confidence",
  };
}

export function shouldProcessExpenseAsPurchaseInvoice(classification: TransactionClassificationCategory): boolean {
  return classification === "saas_subscriptions" ||
    classification === "bank_fees" ||
    classification === "card_purchases";
}

export function buildOwnerCounterpartySet(clients: Client[]): Set<string> {
  const owners = clients.filter(client =>
    !client.is_deleted &&
    client.is_physical_entity &&
    (client.is_related_party || client.is_associate_company || client.is_parent_company_group)
  );
  return new Set(owners.map(client => normalizeCounterpartyName(client.name)).filter(Boolean));
}

export function groupTransactionsByCounterparty(transactions: Transaction[]): TransactionGroup[] {
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

// Exported for the receipt auto-booking merge chain, which now lives in
// ../receipts/batch-operations.js (shared with the classification path here).
export function resolveAutoBookingRuleTargets(
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

export function resolveMergedPurchaseAccountDimension(
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

/**
 * Resolve the EMTA prepayment account (ettemaksukonto) in a company's chart.
 * The exact id wins; otherwise we look for an account that specifically names
 * the prepayment account, but never a known non-asset account (liability/
 * equity/revenue/expense) and never a clearing/intermediate ("vahekonto")
 * account — so we never fall onto a customer/supplier prepayment or a
 * tax-liability/clearing account that merely contains the word "ettemaks".
 * Among the survivors an EMTA/tolliamet-named account is preferred over chart
 * order; a generic prepayment account is only accepted when it is the single
 * unambiguous candidate.
 */
function findEmtaPrepaymentAccount(accounts: Account[]): Account | undefined {
  const byId = accounts.find(candidate => candidate.id === EMTA_PREPAYMENT_ACCOUNT);
  if (byId) {
    return byId;
  }

  const candidates = accounts.filter(candidate => {
    if (candidate.is_fixed_asset) {
      return false;
    }
    const name = `${candidate.name_est ?? ""} ${candidate.name_eng ?? ""}`.toLowerCase();
    if (!/ettemaksukonto|prepayment account/.test(name)) {
      return false;
    }
    // Never a clearing / intermediate account.
    if (/vahekonto|clearing|suspense/.test(name)) {
      return false;
    }
    // Reject known non-asset account types; an empty/unknown type is allowed
    // through (it might be an asset whose type label is localised differently).
    const type = `${candidate.account_type_est ?? ""} ${candidate.account_type_eng ?? ""}`.toLowerCase();
    if (/kohustus|liabilit|omakapital|equity|tulu|revenue|income|kulu|expense/.test(type)) {
      return false;
    }
    return true;
  });

  const namesTaxAuthority = (account: Account) =>
    /emta|tolliamet|tax authority|etcb/.test(`${account.name_est ?? ""} ${account.name_eng ?? ""}`.toLowerCase());

  const emtaNamed = candidates.filter(namesTaxAuthority);
  if (emtaNamed.length > 0) {
    return emtaNamed[0];
  }
  // Only trust a generic prepayment account when there is exactly one.
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Some transaction categories must always post to one specific GL account,
 * regardless of supplier history or saved auto-booking rules — otherwise a past
 * (mis-)booking or a saved rule for the same counterparty could silently
 * re-book the payment to the wrong account. A transfer to EMTA is the canonical
 * case: it tops up the EMTA prepayment account (ettemaksukonto, an asset) and
 * the tax-expense entries that draw it down are created by e-arveldaja from the
 * EMTA prepayment-account statement, so the payment must never be booked as a
 * tax expense or a purchase invoice. Returns undefined for categories that have
 * no fixed account.
 */
function buildForcedCategorySuggestion(
  category: TransactionClassificationCategory,
  accounts: Account[],
  manualReviewReason?: string,
): ClassifiedTransactionSuggestion | undefined {
  if (category !== "tax_payments") {
    return undefined;
  }

  const account = findEmtaPrepaymentAccount(accounts);
  const reasonParts = [
    "Transfer to EMTA — book to the EMTA prepayment account (ettemaksukonto). " +
      "The tax-expense entries that draw it down are created separately in e-arveldaja " +
      "from the EMTA prepayment-account statement (Aruandlus → EMTA ettemaksukonto kanded). " +
      "Do not create a purchase invoice for this payment.",
  ];
  if (!account) {
    reasonParts.push(
      `Could not locate the EMTA prepayment account (expected id ${EMTA_PREPAYMENT_ACCOUNT}) in this company's chart — set the contra account manually.`,
    );
  }
  if (manualReviewReason) {
    reasonParts.push(manualReviewReason);
  }

  return {
    purchase_article_id: undefined,
    purchase_article_name: undefined,
    purchase_account_id: account?.id,
    purchase_account_name: account ? `${account.id} ${account.name_est}` : undefined,
    liability_account_id: DEFAULT_LIABILITY_ACCOUNT,
    source: "category_default",
    reason: reasonParts.join(" "),
  };
}

export function buildClassificationSuggestion(
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
  // Statutory fixed-account categories (e.g. EMTA tax payments) take precedence
  // over supplier history AND saved auto-booking rules.
  const forced = buildForcedCategorySuggestion(category, accounts, options?.manualReviewReason);
  if (forced) {
    return forced;
  }

  if (options?.bookingSuggestion?.source === "supplier_history") {
    return buildSuggestionFromBookingHistory(options.bookingSuggestion);
  }

  let articleKeywords = ["muu", "other", "general"];
  let accountKeywords = ["muu", "general", "kulud"];
  let reason = "Fallback booking suggestion from generic expense keywords.";

  if (category === "saas_subscriptions") {
    const saasEntry = CATEGORY_KEYWORD_MAP.find(entry => entry.category === "saas_subscriptions")!;
    articleKeywords = saasEntry.classificationArticleKeywords ?? saasEntry.articleKeywords;
    accountKeywords = saasEntry.classificationAccountKeywords ?? saasEntry.accountKeywords;
    reason = "Recurring similar payments to the same counterparty suggest a subscription or SaaS vendor.";
  } else if (category === "bank_fees") {
    const bankEntry = CATEGORY_KEYWORD_MAP.find(entry => entry.category === "bank_fees")!;
    articleKeywords = bankEntry.classificationArticleKeywords ?? bankEntry.articleKeywords;
    accountKeywords = bankEntry.classificationAccountKeywords ?? bankEntry.accountKeywords;
    reason = "Counterparty and description patterns match bank service fees.";
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
      const transportEntry = CATEGORY_KEYWORD_MAP.find(entry => entry.pattern.test("bolt"))!;
      articleKeywords = transportEntry.classificationArticleKeywords ?? transportEntry.articleKeywords;
      accountKeywords = transportEntry.classificationAccountKeywords ?? transportEntry.accountKeywords;
      reason = "Bolt/Uber patterns usually map to travel or transport expenses.";
    } else if (/(wolt)/i.test(normalizedCounterparty)) {
      const foodEntry = CATEGORY_KEYWORD_MAP.find(entry => entry.pattern.test("wolt"))!;
      articleKeywords = foodEntry.classificationArticleKeywords ?? foodEntry.articleKeywords;
      accountKeywords = foodEntry.classificationAccountKeywords ?? foodEntry.accountKeywords;
      reason = "Wolt-like payments usually map to food or representation expenses.";
    } else {
      const officeEntry = CATEGORY_KEYWORD_MAP.find(entry => entry.category === "unknown" && entry.pattern.test("office"))!;
      articleKeywords = officeEntry.classificationArticleKeywords ?? ["office", ...officeEntry.articleKeywords, "general", "muu"];
      accountKeywords = officeEntry.classificationAccountKeywords ?? ["office", ...officeEntry.accountKeywords, "general", "muu"];
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

export async function resolveClassificationSuggestion(
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

// Exported for the batch operation's per-file loop (../receipts/batch-operations.js)
// and the classification/self-match guards below.
export function normalizeVatForCompare(value: string | null | undefined): string {
  return normalizeVatValue(value) ?? "";
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
 * Symmetric to `detectSelfVatOnly` for the registry code (#22): true when
 * the document text contains the active company's own registrikood and the
 * deterministic extractor (called with own-reg excluded) did NOT recover a
 * different supplier reg code. Indicates the only 8-digit code on the page
 * was the buyer's own — supplier resolution must not silently proceed to
 * creating a duplicate of the active company.
 */
export function detectSelfRegCodeOnly(extracted: ExtractedReceiptFields, ownCompanyRegistryCode: string | undefined): boolean {
  if (!ownCompanyRegistryCode || !extracted.raw_text) return false;
  if (extracted.supplier_reg_code) return false;
  const own = ownCompanyRegistryCode.trim();
  if (!own) return false;
  const normalizedText = extracted.raw_text.replace(/\s+/g, "");
  // Check EVERY occurrence, not just the first: the own reg code could appear
  // first as a substring of a longer digit run (failing the boundary check) and
  // again later as a standalone code. Return true if ANY occurrence stands
  // alone (no adjacent digit on either side).
  for (let idx = normalizedText.indexOf(own); idx >= 0; idx = normalizedText.indexOf(own, idx + 1)) {
    const before = idx > 0 ? normalizedText[idx - 1]! : "";
    const after = idx + own.length < normalizedText.length ? normalizedText[idx + own.length]! : "";
    if (!/\d/.test(before) && !/\d/.test(after)) return true;
  }
  return false;
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
 * Load the active company's own identity (`invoice_company_name`), which feeds
 * the name-based self-match guard for `ownCompanyRegistryCode` (#22). Two
 * failure modes are deliberately treated DIFFERENTLY (M09):
 *
 *  - **Endpoint absent** (`getInvoiceInfo` is not a function): a known static
 *    configuration — older API clients / test stubs never had it, and VAT-based
 *    self-match still protects booking. Stay best-effort: `available` with no
 *    name, preserving the pre-M09 behaviour.
 *  - **Endpoint present but the call throws** (e.g. a transient 5xx): we cannot
 *    tell whether identity would have blocked a self-match, so we FAIL CLOSED
 *    (`retryable_error`) rather than silently book with weakened protection.
 */
export async function loadOwnCompanyIdentity(
  api: ApiContext,
): Promise<{ status: "available"; invoiceCompanyName?: string } | { status: "retryable_error"; reason: string }> {
  const fn = api.readonly.getInvoiceInfo;
  if (typeof fn !== "function") return { status: "available" };
  try {
    const info = await fn.call(api.readonly);
    return { status: "available", invoiceCompanyName: info.invoice_company_name?.trim() || undefined };
  } catch (error) {
    return { status: "retryable_error", reason: error instanceof Error ? error.message : String(error) };
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
 * (auto-attach via attach_document, manual review UIs) don't have
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
  supplier: { client_id?: number; name?: string },
): { invoice_number: string; matched: boolean; matched_invoice_id?: number; ambiguity_reason?: string } | undefined {
  const trimmed = invoiceNumber?.trim();
  if (!trimmed || trimmed.toUpperCase().startsWith("AUTO-")) return undefined;
  const normalized = trimmed.toLowerCase();
  const numberMatches = purchaseInvoices.filter(invoice =>
    invoice.status !== "DELETED" &&
    invoice.status !== "INVALIDATED" &&
    invoice.number.trim().toLowerCase() === normalized,
  );

  // An invoice number is not unique across suppliers, so a bare number match
  // must never auto-link — it could book the receipt against a different legal
  // entity's identically-numbered invoice (#23). Confirm the supplier: prefer
  // a resolved client_id; otherwise require the receipt's supplier name to
  // normalise-equal the invoice's client_name. Absent any supplier identity we
  // cannot confirm the link, so nothing matches and the caller routes to review.
  const supplierNameKey = supplier.name ? normalizeCompanyName(supplier.name) : "";
  const supplierMatches = numberMatches.filter(invoice => {
    if (supplier.client_id !== undefined) return invoice.clients_id === supplier.client_id;
    if (!supplierNameKey) return false;
    return normalizeCompanyName(invoice.client_name) === supplierNameKey;
  });

  if (supplierMatches.length === 1 && supplierMatches[0]!.id !== undefined) {
    return { invoice_number: trimmed, matched: true, matched_invoice_id: supplierMatches[0]!.id };
  }
  return {
    invoice_number: trimmed,
    matched: false,
    ...(numberMatches.length > 1 ? { ambiguity_reason: "supplier_identity_required" } : {}),
  };
}

/**
 * Select the bank transactions eligible for receipt auto-matching in a batch.
 *
 * Accounting-date bounds are SEPARATE from the receipt file-modified-date window
 * (`date_from`/`date_to`): a receipt saved in July can settle a bank transaction
 * dated in June, so the file-scan window must never narrow the bank rows (M08).
 * This helper accepts ONLY accounting-date bounds — it has no access to the
 * file-date params, so the two windows cannot be conflated by construction.
 */
export function selectBatchBankTransactions(
  allTransactions: Transaction[],
  accountsDimensionsId: number,
  bounds: { transaction_date_from?: string; transaction_date_to?: string },
): Transaction[] {
  return allTransactions.filter(transaction =>
    transaction.accounts_dimensions_id === accountsDimensionsId &&
    isProjectTransaction(transaction) &&
    // All API-created and CAMT-imported bank transactions are type "C" regardless of
    // debit/credit direction (see CLAUDE.md). This filter is a defensive guard — any
    // legacy type="D" rows are intentionally excluded from auto-match.
    transaction.type === "C" &&
    (!bounds.transaction_date_from || transaction.date >= bounds.transaction_date_from) &&
    (!bounds.transaction_date_to || transaction.date <= bounds.transaction_date_to),
  );
}

export function existingInvoiceMatch(tx: Transaction, openSales: SaleInvoice[], openPurchases: PurchaseInvoice[]): boolean {
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
        match_type: "client_id",
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

export function extractClassificationGroups(payload: unknown): ClassifiedTransactionGroupResult[] {
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

export function registerReceiptInboxTools(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
  receiptDirectoryAccess: Omit<ReceiptDirectoryAccessOptions, "expectedCanonicalPath"> = {},
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  // Typed receipt batch + classification operations. Every batch and classify
  // tool is a thin adapter over one of these facades + its presenter; there is
  // no serialized-MCP delegation (no invokeCapturedTool / parseMcpResponse /
  // handlers registry) anymore.
  const operations = createReceiptBatchOperations(api, runtimeSafetyContext);
  // wrapUntrustedOcr is injected so the classification operation module never
  // imports it: the operation returns unwrapped data, and the only OCR-origin
  // error fragment it must sandbox in a note goes through this adapter-owned wrap.
  const classificationOperations = createClassificationOperations(api, runtimeSafetyContext, wrapUntrustedOcr);

  // Constituents fully covered by merged entry points: receipt_batch
  // (scan / dry_run / create / create_and_confirm) covers scan_receipt_folder +
  // process_receipt_batch; classify_bank_transactions (classify / dry_run_apply /
  // execute_apply) covers classify_unmatched_transactions +
  // apply_transaction_classifications. Handlers stay captured for internal
  // routing; the tools enter tools/list (a fixed per-session token cost) only
  // when EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1.
  const granularOnlyTools = new Set([
    "process_receipt_batch",
    "classify_unmatched_transactions",
    "apply_transaction_classifications",
  ]);

  async function resolveReceiptFolder(folderPath?: string, fileRef?: string): Promise<{
    path: string;
    expectedCanonicalPath?: string;
    revalidateAtPointOfUse(): Promise<string>;
  }> {
    const hasPath = folderPath !== undefined;
    const hasReference = fileRef !== undefined;
    if (hasPath === hasReference) throw new FileReferenceStoreError("file_reference_data_invalid");
    if (hasPath && (typeof folderPath !== "string" || folderPath.length === 0)) {
      throw new FileReferenceStoreError("file_reference_data_invalid");
    }
    if (hasReference && (typeof fileRef !== "string" || fileRef.length === 0)) {
      throw new FileReferenceStoreError("file_reference_data_invalid");
    }
    const selected = hasReference
      ? runtimeSafetyContext.fileReferenceStore.resolve(fileRef!, {
          kind: "directory",
          operation: FILE_REFERENCE_OPERATIONS.receipt,
        })
      : folderPath!;
    const validated = await validateReceiptFolderPath(selected);
    if (hasReference && validated !== selected) {
      throw new FileReferenceStoreError("file_reference_path_changed");
    }
    return {
      path: validated,
      ...(hasReference ? { expectedCanonicalPath: selected } : {}),
      async revalidateAtPointOfUse() {
        const current = hasReference
          ? runtimeSafetyContext.fileReferenceStore.resolve(fileRef!, {
              kind: "directory",
              operation: FILE_REFERENCE_OPERATIONS.receipt,
            })
          : folderPath!;
        const currentValidated = await validateReceiptFolderPath(current);
        if (hasReference && (current !== selected || currentValidated !== selected)) {
          throw new FileReferenceStoreError("file_reference_path_changed");
        }
        return currentValidated;
      },
    };
  }

  function directoryAccessOptions(expectedCanonicalPath?: string): ReceiptDirectoryAccessOptions {
    return {
      ...receiptDirectoryAccess,
      ...(expectedCanonicalPath !== undefined ? { expectedCanonicalPath } : {}),
    };
  }

  function publicReceiptScan(scan: Awaited<ReturnType<typeof scanReceiptFolderInternal>>, fileRef: string) {
    return {
      folder_path: sandboxExternalText(scan.folder_path),
      file_ref: fileRef,
      total_candidates: scan.total_candidates,
      files: scan.files.map(({ name, path, ...metadata }) => ({
        ...metadata,
        display_name: sandboxExternalText(name),
        display_path: sandboxExternalText(path),
        file_ref: runtimeSafetyContext.fileReferenceStore.issue({
          canonicalPath: path,
          kind: "file",
          operation: FILE_REFERENCE_OPERATIONS.receipt,
        }),
      })),
      skipped: scan.skipped.map(({ name, reason }) => ({
        display_name: sandboxExternalText(name),
        display_reason: sandboxExternalText(reason),
      })),
    };
  }

  function publicReceiptResult(result: ReceiptBatchFileResult): Record<string, unknown> & { status: ReceiptBatchFileResult["status"] } {
    const sanitized = sanitizeReceiptResultForOutput(result);
    const { name, path, ...metadata } = sanitized.file;
    return {
      ...sanitized,
      file: {
        ...metadata,
        display_name: sandboxExternalText(name),
        display_path: sandboxExternalText(path),
        file_ref: runtimeSafetyContext.fileReferenceStore.issue({
          canonicalPath: path,
          kind: "file",
          operation: FILE_REFERENCE_OPERATIONS.receipt,
        }),
      },
    };
  }

  function publicReceiptManifest(files: ReadonlyArray<{ file: ReceiptFileInfo; sha256: string }>) {
    return files.map(({ file, sha256 }) => ({
      file_ref: runtimeSafetyContext.fileReferenceStore.issue({
        canonicalPath: file.path,
        kind: "file",
        operation: FILE_REFERENCE_OPERATIONS.receipt,
      }),
      display_name: sandboxExternalText(file.name),
      sha256,
    }));
  }

  function publicReceiptSkipped(scan: { skipped: Array<{ name: string; reason: string }> }) {
    return scan.skipped.map(({ name, reason }) => ({
      display_name: sandboxExternalText(name),
      display_reason: sandboxExternalText(reason),
    }));
  }

  function normalizeApprovedReceiptManifest(
    entries: readonly ReceiptManifestInputEntry[],
    folderPath: string,
    usesFolderReference: boolean,
  ): ReceiptApprovedManifestEntry[] {
    if (!usesFolderReference) {
      if (entries.some(entry => !("relative_path" in entry))) {
        throw new FileReferenceStoreError("file_reference_data_invalid");
      }
      return entries.map(entry => ({
        relative_path: (entry as z.infer<typeof directManifestEntrySchema>).relative_path,
        sha256: entry.sha256,
      }));
    }

    if (entries.some(entry => !("file_ref" in entry))) {
      throw new FileReferenceStoreError("file_reference_data_invalid");
    }
    return entries.map(entry => {
      const referenced = entry as z.infer<typeof referencedManifestEntrySchema>;
      const filePath = runtimeSafetyContext.fileReferenceStore.resolve(referenced.file_ref, {
        kind: "file",
        operation: FILE_REFERENCE_OPERATIONS.receipt,
      });
      const relativePath = basename(filePath);
      if (dirname(filePath) !== folderPath || join(folderPath, relativePath) !== filePath) {
        throw new FileReferenceStoreError("file_reference_data_invalid");
      }
      return { relative_path: relativePath, sha256: referenced.sha256 };
    });
  }

  function registerCapturedTool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown,
  ): void {
    // Granular constituents stay registered (routed internally by the merged
    // entry points) but only enter tools/list when EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1.
    if (granularOnlyTools.has(name) && !exposure.exposeGranularTools) return;
    registerTool(server, name, description, paramsSchema, annotations, cb);
  }

  // Shared batch adapter: resolves the file reference, runs the identity /
  // approved-manifest safety gates (whose ORDER + ownership of the
  // fileReferenceStore stay in the tool layer), invokes the typed operation, and
  // hands the UNWRAPPED result to the presenter. Returns either a byte-identical
  // non-mutating toolError (identity retryable / manifest required) or the FULL
  // envelope object (before toMcpJson). Both process_receipt_batch and the merged
  // receipt_batch non-scan modes route through here — NO invokeCapturedTool /
  // parseMcpResponse round-trip on the batch path anymore.
  // Guided profiles receive the token-lean compact receipt surface; standard/full
  // keep the byte-identical full envelope.
  const useCompactReceipts = (): boolean => {
    const profile = currentToolProfile();
    return profile === "guided" || profile === "guided-sales";
  };
  const activeConnectionName = (): string | undefined => {
    try {
      return runtimeSafetyContext.getActiveScope().connectionName;
    } catch {
      return undefined;
    }
  };

  async function runReceiptBatchFull(args: {
    folder_path?: string;
    file_ref?: string;
    accounts_dimensions_id: number;
    execution_mode?: ReceiptBatchExecutionMode;
    execute?: boolean;
    date_from?: string;
    date_to?: string;
    transaction_date_from?: string;
    transaction_date_to?: string;
    approved_manifest?: ReceiptManifestInputEntry[];
  }): Promise<{ ok: true; fullObj: Record<string, unknown>; compactInput: ReceiptBatchCompactInput } | { ok: false; error: CallToolResult }> {
    const receiptFolder = await resolveReceiptFolder(args.folder_path, args.file_ref);
    const workflowFolderPath = receiptFolder.path;
    const { mode: executionMode, legacyExecuteCreate } = resolveReceiptBatchExecutionMode(
      args.execute,
      args.execution_mode,
    );
    const dryRun = executionMode === "dry_run";
    // M09: the active company's identity feeds the #22 self-match guard. If a
    // PRESENT invoice_info endpoint fails transiently, fail closed BEFORE any
    // snapshot/mutation instead of booking with weakened protection.
    const ownCompanyIdentity = await loadOwnCompanyIdentity(api);
    if (ownCompanyIdentity.status === "retryable_error") {
      return { ok: false, error: receiptIdentityRetryableError(ownCompanyIdentity.reason) };
    }
    // H15: creating/confirming without the dry-run manifest is refused so the
    // approved-bytes binding below cannot be bypassed.
    if (!dryRun && args.approved_manifest === undefined) {
      return { ok: false, error: receiptApprovedManifestRequiredError() };
    }
    const pointOfUseFolderPath = await receiptFolder.revalidateAtPointOfUse();
    const normalizedApprovedManifest = dryRun || args.approved_manifest === undefined
      ? undefined
      : normalizeApprovedReceiptManifest(
          args.approved_manifest,
          pointOfUseFolderPath,
          args.file_ref !== undefined,
        );
    const outcome = await operations.runBatch({
      resolvedFolderPath: pointOfUseFolderPath,
      accountsDimensionsId: args.accounts_dimensions_id,
      executionMode,
      legacyExecuteCreate,
      dryRun,
      ...(args.date_from !== undefined ? { dateFrom: args.date_from } : {}),
      ...(args.date_to !== undefined ? { dateTo: args.date_to } : {}),
      ...(args.transaction_date_from !== undefined ? { transactionDateFrom: args.transaction_date_from } : {}),
      ...(args.transaction_date_to !== undefined ? { transactionDateTo: args.transaction_date_to } : {}),
      ...(normalizedApprovedManifest !== undefined ? { approvedManifest: normalizedApprovedManifest } : {}),
      directoryAccessOptions: directoryAccessOptions(receiptFolder.expectedCanonicalPath),
      ...(ownCompanyIdentity.invoiceCompanyName !== undefined ? { ownCompanyName: ownCompanyIdentity.invoiceCompanyName } : {}),
    });
    if (!outcome.ok) {
      return { ok: false, error: toolError({ error: outcome.error.message, category: outcome.error.code }) };
    }
    const result = outcome.value;
    const fileRefProjection: ReceiptBatchFileRefProjection | undefined = args.file_ref !== undefined
      ? {
          projectResult: publicReceiptResult,
          manifest: publicReceiptManifest(result.snapshotFiles),
          skipped: publicReceiptSkipped(result.scan),
          folderPathOut: sandboxExternalText(result.scan.folder_path),
        }
      : undefined;
    const fullObj = renderReceiptBatchFull({
      result,
      accountsDimensionsId: args.accounts_dimensions_id,
      ...(args.file_ref !== undefined ? { fileRef: args.file_ref } : {}),
      workflowFolderPath,
      ...(args.date_from !== undefined ? { dateFrom: args.date_from } : {}),
      ...(args.date_to !== undefined ? { dateTo: args.date_to } : {}),
      ...(args.transaction_date_from !== undefined ? { transactionDateFrom: args.transaction_date_from } : {}),
      ...(args.transaction_date_to !== undefined ? { transactionDateTo: args.transaction_date_to } : {}),
      ...(fileRefProjection !== undefined ? { fileRefProjection } : {}),
    });
    const compactInput: ReceiptBatchCompactInput = {
      result,
      accountsDimensionsId: args.accounts_dimensions_id,
      executionMode,
      ...(args.file_ref !== undefined ? { fileRef: args.file_ref } : {}),
      // Same reviewed-set artifact the FULL envelope emits (projection.manifest
      // for the file_ref path, result.manifest for a direct folder). The compact
      // DRY_RUN inlines it so the guided dry_run→create flow is self-completable.
      responseManifest: fileRefProjection !== undefined ? fileRefProjection.manifest : result.manifest,
      workflowFolderPath,
      ...(args.date_from !== undefined ? { dateFrom: args.date_from } : {}),
      ...(args.date_to !== undefined ? { dateTo: args.date_to } : {}),
      ...(args.transaction_date_from !== undefined ? { transactionDateFrom: args.transaction_date_from } : {}),
      ...(args.transaction_date_to !== undefined ? { transactionDateTo: args.transaction_date_to } : {}),
      ...((): { connectionName?: string } => {
        const connectionName = activeConnectionName();
        return connectionName !== undefined ? { connectionName } : {};
      })(),
    };
    return { ok: true, fullObj, compactInput };
  }

  // scan_receipt_folder is covered by receipt_batch mode="scan" (which calls
  // scanReceiptFolderInternal directly), so it is granular-gated too.
  if (exposure.exposeGranularTools) registerTool(server,
    "scan_receipt_folder",
    "Scan a folder for supported receipt files (PDF, JPG, PNG) without recursing into subfolders. Returns valid file metadata and skipped entries.",
    {
      folder_path: z.string().optional().describe("Folder path to scan. Provide exactly one of folder_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox receipt-folder reference."),
      file_types: z.array(z.enum(["pdf", "jpg", "png"])).optional().describe("Optional file type filter"),
      date_from: z.string().optional().describe("Optional file modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional file modified-date upper bound (YYYY-MM-DD)"),
    },
    { ...readOnly, openWorldHint: true, title: "Scan Receipt Folder" },
    async ({ folder_path, file_ref, file_types, date_from, date_to }) => {
      const receiptFolder = await resolveReceiptFolder(folder_path, file_ref);
      const resolvedFolderPath = await receiptFolder.revalidateAtPointOfUse();
      const scanOutcome = await operations.scan({
        resolvedFolderPath,
        ...(file_types !== undefined ? { fileTypes: file_types } : {}),
        ...(date_from !== undefined ? { dateFrom: date_from } : {}),
        ...(date_to !== undefined ? { dateTo: date_to } : {}),
        directoryAccessOptions: directoryAccessOptions(receiptFolder.expectedCanonicalPath),
      });
      const result = scanOutcome.ok ? scanOutcome.value : undefined;
      return {
        content: [{
          type: "text",
          text: toMcpJson(file_ref !== undefined && result !== undefined
            ? publicReceiptScan(result, file_ref)
            : result),
        }],
      };
    },
  );

  registerCapturedTool(
    "process_receipt_batch",
    "Process receipt PDFs/images from a folder. DRY RUN by default. Returns OCR/extraction review data. Use execution_mode='create' to create/upload PROJECT invoices, or create_and_confirm only after explicit approval.",
    {
      folder_path: z.string().optional().describe("Folder path with receipts. Provide exactly one of folder_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox receipt-folder reference."),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID used when matching bank transactions"),
      execution_mode: z.enum(RECEIPT_BATCH_EXECUTION_MODES).optional().describe("Execution phase: dry_run (default), create (create/upload PROJECT invoices only), or create_and_confirm (create, upload, confirm, and exact-match bank transactions after explicit approval)"),
      execute: z.boolean().optional().describe("Deprecated boolean alias for execution_mode."),
      date_from: z.string().optional().describe("Optional receipt file modified-date lower bound (YYYY-MM-DD). Filters which receipt FILES are scanned; does not affect bank transactions."),
      date_to: z.string().optional().describe("Optional receipt file modified-date upper bound (YYYY-MM-DD). Filters which receipt FILES are scanned; does not affect bank transactions."),
      transaction_date_from: z.string().optional().describe("Optional bank accounting-date lower bound for auto-matching (YYYY-MM-DD). Independent of the receipt file date_from."),
      transaction_date_to: z.string().optional().describe("Optional bank accounting-date upper bound for auto-matching (YYYY-MM-DD). Independent of the receipt file date_to."),
      approved_manifest: manifestSchema.optional().describe("Exact manifest returned by dry_run; required for create/create_and_confirm."),
    },
    { ...batch, openWorldHint: true, title: "Process Receipt Batch" },
    async ({ folder_path, file_ref, accounts_dimensions_id, execution_mode, execute, date_from, date_to, transaction_date_from, transaction_date_to, approved_manifest }) => {
      const outcome = await runReceiptBatchFull({
        ...(folder_path !== undefined ? { folder_path } : {}),
        ...(file_ref !== undefined ? { file_ref } : {}),
        accounts_dimensions_id,
        ...(execution_mode !== undefined ? { execution_mode: execution_mode as ReceiptBatchExecutionMode } : {}),
        ...(execute !== undefined ? { execute } : {}),
        ...(date_from !== undefined ? { date_from } : {}),
        ...(date_to !== undefined ? { date_to } : {}),
        ...(transaction_date_from !== undefined ? { transaction_date_from } : {}),
        ...(transaction_date_to !== undefined ? { transaction_date_to } : {}),
        ...(approved_manifest !== undefined ? { approved_manifest: approved_manifest as ReceiptManifestInputEntry[] } : {}),
      });
      if (!outcome.ok) return outcome.error;
      return {
        content: [{
          type: "text",
          text: toMcpJson(outcome.fullObj),
        }],
      };
    },
  );

  registerTool(server,
    "receipt_batch",
    "Merged receipt batch. scan inspects files; dry_run previews; create/create_and_confirm require explicit approval.",
    {
      mode: z.enum(["scan", "dry_run", "create", "create_and_confirm"]).optional().describe("Workflow phase to run. Defaults to scan."),
      folder_path: z.string().optional().describe("Folder path with receipts. Provide exactly one of folder_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox receipt-folder reference."),
      accounts_dimensions_id: coerceId.optional().describe("Bank account dimension ID used when matching bank transactions. Required except in scan mode."),
      date_from: z.string().optional().describe("Optional receipt file modified-date lower bound (YYYY-MM-DD). Filters which receipt FILES are scanned; does not affect bank transactions."),
      date_to: z.string().optional().describe("Optional receipt file modified-date upper bound (YYYY-MM-DD). Filters which receipt FILES are scanned; does not affect bank transactions."),
      transaction_date_from: z.string().optional().describe("Optional bank accounting-date lower bound for auto-matching (YYYY-MM-DD). Independent of the receipt file date_from."),
      transaction_date_to: z.string().optional().describe("Optional bank accounting-date upper bound for auto-matching (YYYY-MM-DD). Independent of the receipt file date_to."),
      file_types: z.array(z.enum(["pdf", "jpg", "png"])).optional().describe("Optional file type filter for scan mode"),
      approved_manifest: manifestSchema.optional().describe("Exact manifest returned by dry_run; required for create/create_and_confirm."),
    },
    { ...batch, openWorldHint: true, title: "Receipt Batch" },
    async ({ mode, folder_path, file_ref, accounts_dimensions_id, date_from, date_to, transaction_date_from, transaction_date_to, file_types, approved_manifest }) => {
      const selectedMode = mode ?? "scan";
      let delegatedTool: string;
      let delegatedArgs: Record<string, unknown>;
      let result: unknown;

      if (selectedMode === "scan") {
        const receiptFolder = await resolveReceiptFolder(folder_path, file_ref);
        const resolvedFolderPath = await receiptFolder.revalidateAtPointOfUse();
        delegatedTool = "scan_receipt_folder";
        delegatedArgs = {
          ...(file_ref !== undefined ? { file_ref } : { folder_path: resolvedFolderPath }),
          ...(file_types !== undefined ? { file_types } : {}),
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
        };
        const scanOutcome = await operations.scan({
          resolvedFolderPath,
          ...(file_types !== undefined ? { fileTypes: file_types } : {}),
          ...(date_from !== undefined ? { dateFrom: date_from } : {}),
          ...(date_to !== undefined ? { dateTo: date_to } : {}),
          directoryAccessOptions: directoryAccessOptions(receiptFolder.expectedCanonicalPath),
        });
        const scan = scanOutcome.ok ? scanOutcome.value : undefined;
        result = file_ref !== undefined && scan !== undefined
          ? publicReceiptScan(scan, file_ref)
          : scan;
      } else {
        if (accounts_dimensions_id === undefined) {
          throw new Error("accounts_dimensions_id is required when mode is dry_run, create, or create_and_confirm");
        }
        // H15: create/create_and_confirm must carry the exact manifest a dry_run
        // returned so the snapshot layer can reject a folder that changed. This
        // pre-check keeps the merged path's ordering: a missing manifest is
        // refused BEFORE any own-company identity load (the operation would run
        // the identity gate first).
        if (selectedMode !== "dry_run" && approved_manifest === undefined) {
          return toolError({ category: "approved_manifest_required", error: "approved_manifest is required for receipt mutation" });
        }
        delegatedTool = "process_receipt_batch";
        delegatedArgs = {
          ...(file_ref !== undefined ? { file_ref } : { folder_path }),
          accounts_dimensions_id,
          execution_mode: selectedMode,
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
          ...(transaction_date_from !== undefined ? { transaction_date_from } : {}),
          ...(transaction_date_to !== undefined ? { transaction_date_to } : {}),
          ...(approved_manifest !== undefined ? { approved_manifest } : {}),
        };
        // Call the typed operation + presenter DIRECTLY — no invokeCapturedTool /
        // parseMcpResponse round-trip. The full envelope object the granular
        // process_receipt_batch tool would have produced is built here and reused
        // as `result` below (byte-identical to the former delegated payload).
        const batch = await runReceiptBatchFull({
          ...(folder_path !== undefined ? { folder_path } : {}),
          ...(file_ref !== undefined ? { file_ref } : {}),
          accounts_dimensions_id,
          execution_mode: selectedMode,
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
          ...(transaction_date_from !== undefined ? { transaction_date_from } : {}),
          ...(transaction_date_to !== undefined ? { transaction_date_to } : {}),
          ...(approved_manifest !== undefined ? { approved_manifest: approved_manifest as ReceiptManifestInputEntry[] } : {}),
        });
        if (!batch.ok) return batch.error;
        // Guided profiles get the token-lean compact summary as the delegated
        // result; standard/full keep the byte-identical full envelope.
        result = useCompactReceipts()
          ? renderReceiptBatchCompact(batch.compactInput)
          : batch.fullObj;
      }

      const publicDelegatedArgs = file_ref !== undefined && approved_manifest !== undefined
        ? {
            ...delegatedArgs,
            approved_manifest: Array.isArray((result as Record<string, unknown>)?.approved_manifest)
              ? (result as Record<string, unknown>).approved_manifest
              : approved_manifest.map(entry => "file_ref" in entry
                  ? { file_ref: entry.file_ref, sha256: entry.sha256 }
                  : entry),
          }
        : delegatedArgs;

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            recommended_entry_point: "receipt_batch",
            mode: selectedMode,
            delegated_tool: delegatedTool,
            delegated_args: publicDelegatedArgs,
            result: remapHiddenGranularWorkflowResult(result),
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
      // Granular tool: always the byte-identical FULL envelope (granular tools
      // are only exposed under full/EXPOSE_GRANULAR, never a guided profile).
      const outcome = await classificationOperations.analyzeUnmatched({
        accountsDimensionsId: accounts_dimensions_id,
        ...(date_from !== undefined ? { dateFrom: date_from } : {}),
        ...(date_to !== undefined ? { dateTo: date_to } : {}),
      });
      if (!outcome.ok) return toolError({ error: outcome.error.message, category: outcome.error.code });
      return {
        content: [{
          type: "text",
          text: toMcpJson(renderUnmatchedAnalysisFull({ result: outcome.value })),
        }],
      };
    },
  );

  registerCapturedTool(
    "apply_transaction_classifications",
    "Apply the output of classify_unmatched_transactions. DRY RUN by default. Only expense-like categories are auto-booked as purchase invoices; review-only categories are reported back.",
    {
      classifications_json: jsonObjectOrArrayInput.describe("Structured output from classify_unmatched_transactions."),
      execute: z.boolean().optional().describe("Actually create invoices and link transactions (default false = dry run)"),
    },
    { ...batch, title: "Apply Transaction Classifications" },
    async ({ classifications_json, execute }) => {
      // Granular tool: always the byte-identical FULL envelope (granular tools
      // are only exposed under full/EXPOSE_GRANULAR, never a guided profile).
      const outcome = await classificationOperations.applyClassifications({
        classificationsJson: classifications_json,
        execute,
      });
      if (!outcome.ok) return toolError({ error: outcome.error.message, category: outcome.error.code });
      return {
        content: [{
          type: "text",
          text: toMcpJson(renderApplyClassificationsFull({
            result: outcome.value,
            classificationsJson: classifications_json,
          })),
        }],
      };
    },
  );

  registerTool(server,
    "classify_bank_transactions",
    "Merged unmatched-bank classification. classify groups; dry_run_apply previews; execute_apply requires approval.",
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
      // Call the typed operation + presenter DIRECTLY — no invokeCapturedTool /
      // parseMcpResponse round-trip. delegated_tool/delegated_args still report
      // the granular tool + args this merged entry point routes to. Guided
      // profiles get the token-lean compact summary; standard/full keep the
      // byte-identical full envelope.
      let result: unknown;

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
        const outcome = await classificationOperations.analyzeUnmatched({
          accountsDimensionsId: accounts_dimensions_id,
          ...(date_from !== undefined ? { dateFrom: date_from } : {}),
          ...(date_to !== undefined ? { dateTo: date_to } : {}),
        });
        if (!outcome.ok) return toolError({ error: outcome.error.message, category: outcome.error.code });
        result = useCompactReceipts()
          ? renderClassificationAnalysisCompact({
              result: outcome.value,
              accountsDimensionsId: accounts_dimensions_id,
              ...(date_from !== undefined ? { dateFrom: date_from } : {}),
              ...(date_to !== undefined ? { dateTo: date_to } : {}),
              ...((): { connectionName?: string } => {
                const connectionName = activeConnectionName();
                return connectionName !== undefined ? { connectionName } : {};
              })(),
            })
          : renderUnmatchedAnalysisFull({ result: outcome.value });
      } else {
        if (classifications_json === undefined) {
          throw new Error("classifications_json is required when applying transaction classifications");
        }
        delegatedTool = "apply_transaction_classifications";
        delegatedArgs = {
          classifications_json,
          execute: selectedMode === "execute_apply",
        };
        const outcome = await classificationOperations.applyClassifications({
          classificationsJson: classifications_json,
          execute: selectedMode === "execute_apply",
        });
        if (!outcome.ok) return toolError({ error: outcome.error.message, category: outcome.error.code });
        result = useCompactReceipts()
          ? renderApplyClassificationsCompact({
              result: outcome.value,
              classificationsJson: classifications_json,
              ...((): { connectionName?: string } => {
                const connectionName = activeConnectionName();
                return connectionName !== undefined ? { connectionName } : {};
              })(),
            })
          : renderApplyClassificationsFull({
              result: outcome.value,
              classificationsJson: classifications_json,
            });
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            recommended_entry_point: "classify_bank_transactions",
            mode: selectedMode,
            delegated_tool: delegatedTool,
            delegated_args: delegatedArgs,
            result: remapHiddenGranularWorkflowResult(result),
          }),
        }],
      };
    },
  );
}
