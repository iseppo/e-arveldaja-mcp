import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { parseMcpResponse, toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { Transaction, SaleInvoice, PurchaseInvoice } from "../types/api.js";
import { readOnly, batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { reportProgress } from "../progress.js";
import { isProjectTransaction } from "../transaction-status.js";
import { roundMoney } from "../money.js";
import { buildBankAccountLookups, buildInterAccountJournalIndex, findMatchingJournal, toUtcDay } from "./inter-account-utils.js";

const MAX_INTER_ACCOUNT_DATE_GAP_DAYS = 31;

type BankReconciliationToolResult = Promise<{ content: Array<{ text: string }> }>;
type BankReconciliationToolHandler = (args: Record<string, unknown>) => BankReconciliationToolResult;

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function validateInterAccountDateGap(maxDateGap: number | undefined): number {
  const value = maxDateGap ?? 1;

  if (!Number.isInteger(value) || value < 0 || value > MAX_INTER_ACCOUNT_DATE_GAP_DAYS) {
    throw new Error(`max_date_gap must be an integer between 0 and ${MAX_INTER_ACCOUNT_DATE_GAP_DAYS}.`);
  }

  return value;
}

import { normalizeCompanyName } from "../company-name.js";

// ---------------------------------------------------------------------------
// Invoice index for O(1) candidate narrowing by ref_number and amount
// ---------------------------------------------------------------------------

interface InvoiceIndex<T> {
  byRef: Map<string, T[]>;
  byAmount: Map<number, T[]>; // keyed by Math.round of comparable local/base amounts
}

type MatchableInvoiceAmounts = {
  gross_price?: number | null;
  base_gross_price?: number | null;
  currency_rate?: number | null;
};

function getComparableBaseInvoiceAmount(invoice: MatchableInvoiceAmounts): number | undefined {
  if (invoice.base_gross_price != null) return invoice.base_gross_price;
  if (invoice.gross_price == null) return undefined;
  if (invoice.currency_rate != null) {
    return roundMoney(invoice.gross_price * invoice.currency_rate);
  }
  return invoice.gross_price;
}

function getComparableInvoiceAmountBuckets(invoice: MatchableInvoiceAmounts): number[] {
  const buckets = new Set<number>();
  if (invoice.gross_price != null) {
    buckets.add(Math.round(invoice.gross_price));
  }
  const baseAmount = getComparableBaseInvoiceAmount(invoice);
  if (baseAmount != null) {
    buckets.add(Math.round(baseAmount));
  }
  return [...buckets];
}

export function buildInvoiceIndex<T extends MatchableInvoiceAmounts & { bank_ref_number?: string | null }>(
  invoices: T[],
): InvoiceIndex<T> {
  const byRef = new Map<string, T[]>();
  const byAmount = new Map<number, T[]>();

  for (const inv of invoices) {
    if (inv.bank_ref_number) {
      let list = byRef.get(inv.bank_ref_number);
      if (!list) { list = []; byRef.set(inv.bank_ref_number, list); }
      list.push(inv);
    }
    for (const key of getComparableInvoiceAmountBuckets(inv)) {
      let list = byAmount.get(key);
      if (!list) { list = []; byAmount.set(key, list); }
      list.push(inv);
    }
  }

  return { byRef, byAmount };
}

/**
 * Collect candidate invoices that could match a transaction on amount or ref_number.
 * Safe to skip invoices not in any index bucket: client-only matches (max 15 pts)
 * can never reach the minimum practical threshold (50), so they would be filtered anyway.
 */
export function getIndexedCandidates<T>(
  index: InvoiceIndex<T>,
  refNumber: string | null | undefined,
  amount: number,
  baseAmount?: number,
): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  const add = (inv: T) => { if (!seen.has(inv)) { seen.add(inv); result.push(inv); } };

  if (refNumber) {
    for (const inv of index.byRef.get(refNumber) ?? []) add(inv);
  }

  // Check ±1 integer buckets to cover close_amount matches (within 1.0)
  const key = Math.round(amount);
  for (let offset = -1; offset <= 1; offset++) {
    for (const inv of index.byAmount.get(key + offset) ?? []) add(inv);
  }

  // Also check base_amount buckets if different from local amount
  if (baseAmount != null && Math.round(baseAmount) !== key) {
    const baseKey = Math.round(baseAmount);
    for (let offset = -1; offset <= 1; offset++) {
      for (const inv of index.byAmount.get(baseKey + offset) ?? []) add(inv);
    }
  }

  return result;
}

interface MatchCandidate {
  type: "sale_invoice" | "purchase_invoice";
  id: number;
  number: string;
  client_name: string;
  clients_id: number;
  gross_price: number;
  payment_status: string;
  partially_paid_warning: boolean;
  ref_number?: string | null;
  confidence: number;
  match_reasons: string[];
}

function buildSuggestedDistribution(
  type: MatchCandidate["type"],
  id: number,
  amount: number,
  partiallyPaidWarning: boolean,
): { related_table: string; related_id: number; amount: number } | undefined {
  if (partiallyPaidWarning) return undefined;

  return {
    related_table: type === "sale_invoice" ? "sale_invoices" : "purchase_invoices",
    related_id: id,
    amount,
  };
}

function comparableTransactionAmount(tx: Transaction): number {
  return roundMoney(tx.base_amount ?? tx.amount);
}

function hasMeaningfulComparableAmount(tx: Transaction): boolean {
  return Math.abs(comparableTransactionAmount(tx) - roundMoney(tx.amount)) >= 0.01;
}

export function matchScore(
  tx: Transaction,
  invoice: { gross_price?: number; base_gross_price?: number; currency_rate?: number | null; bank_ref_number?: string | null; clients_id?: number; client_name?: string; payment_status?: string },
  txAmount: number
): { confidence: number; reasons: string[]; partiallyPaidWarning: boolean } {
  let confidence = 0;
  const reasons: string[] = [];

  // Amount match (check both local and base currency amounts)
  const invoiceAmount = invoice.gross_price ?? 0;
  const baseAmount = tx.base_amount ?? txAmount;
  const baseInvoiceAmount = getComparableBaseInvoiceAmount(invoice) ?? invoiceAmount;
  if (Math.abs(txAmount - invoiceAmount) < 0.01) {
    confidence += 40;
    reasons.push("exact_amount");
  } else if (Math.abs(baseAmount - baseInvoiceAmount) < 0.01 && baseAmount !== txAmount) {
    confidence += 40;
    reasons.push("exact_base_amount");
  } else if (Math.abs(txAmount - invoiceAmount) < 1) {
    confidence += 20;
    reasons.push("close_amount");
  }

  // Reference number match
  if (tx.ref_number && invoice.bank_ref_number && tx.ref_number === invoice.bank_ref_number) {
    confidence += 40;
    reasons.push("ref_number");
  }

  // Client match
  if (tx.clients_id && invoice.clients_id && tx.clients_id === invoice.clients_id) {
    confidence += 15;
    reasons.push("client_id");
  } else if (tx.bank_account_name && invoice.client_name) {
    const nameLower = normalizeCompanyName(tx.bank_account_name);
    const clientLower = normalizeCompanyName(invoice.client_name);
    if (nameLower.length >= 4 && clientLower.length >= 4 && (nameLower.includes(clientLower) || clientLower.includes(nameLower))) {
      confidence += 10;
      reasons.push("client_name_partial");
    }
  }

  const partiallyPaidWarning = invoice.payment_status === "PARTIALLY_PAID";
  if (partiallyPaidWarning) {
    confidence = Math.max(0, confidence - 15);
    reasons.push("partially_paid_warning");
  }

  return { confidence: Math.min(confidence, 100), reasons, partiallyPaidWarning };
}

export function getInvoiceMatchEligibility(
  tx: Pick<Transaction, "type">,
): { allowSaleInvoices: boolean; allowPurchaseInvoices: boolean } {
  // Treat explicit D as authoritative incoming direction. Do not treat C as
  // authoritative outgoing direction because upstream bank transaction APIs and
  // imports still surface some incoming payments as type C.
  if (tx.type === "D") {
    return {
      allowSaleInvoices: true,
      allowPurchaseInvoices: false,
    };
  }

  return {
    allowSaleInvoices: true,
    allowPurchaseInvoices: true,
  };
}

export function registerBankReconciliationTools(server: McpServer, api: ApiContext): void {
  const handlers = new Map<string, BankReconciliationToolHandler>();

  function registerCapturedTool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown,
  ): void {
    handlers.set(name, cb as unknown as BankReconciliationToolHandler);
    registerTool(server, name, description, paramsSchema, annotations, cb);
  }

  registerCapturedTool("reconcile_transactions",
    "Match unconfirmed bank transactions to open sale/purchase invoices. " +
    "Returns suggested matches with confidence scores and ready-to-use distribution data.",
    {
      min_confidence: z.number().optional().describe("Minimum confidence threshold 0-100 (default 50)"),
    },
    { ...readOnly, title: "Reconcile Transactions" },
    async ({ min_confidence }) => {
      const threshold = min_confidence ?? 50;

      // Get all unconfirmed transactions
      const allTx = await api.transactions.listAll();
      const unconfirmed = allTx.filter(isProjectTransaction);

      // Get unpaid invoices (including partially paid)
      const allSales = await api.saleInvoices.listAll();
      const openSales = allSales.filter((inv: SaleInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );

      const allPurchases = await api.purchaseInvoices.listAll();
      const openPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );

      const saleIndex = buildInvoiceIndex(openSales);
      const purchaseIndex = buildInvoiceIndex(openPurchases);
      const results = [];

      for (const tx of unconfirmed) {
        const candidates: MatchCandidate[] = [];
        const { allowSaleInvoices, allowPurchaseInvoices } = getInvoiceMatchEligibility(tx);

        if (allowSaleInvoices) {
          for (const inv of getIndexedCandidates(saleIndex, tx.ref_number, tx.amount, tx.base_amount)) {
            const { confidence, reasons, partiallyPaidWarning } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold) {
              candidates.push({
                type: "sale_invoice",
                id: inv.id!,
                number: inv.number ?? `${inv.number_prefix ?? ""}${inv.number_suffix}`,
                client_name: inv.client_name ?? "",
                clients_id: inv.clients_id,
                gross_price: inv.gross_price ?? 0,
                payment_status: inv.payment_status ?? "NOT_PAID",
                partially_paid_warning: partiallyPaidWarning,
                ref_number: inv.bank_ref_number,
                confidence,
                match_reasons: reasons,
              });
            }
          }
        }

        if (allowPurchaseInvoices) {
          for (const inv of getIndexedCandidates(purchaseIndex, tx.ref_number, tx.amount, tx.base_amount)) {
            const { confidence, reasons, partiallyPaidWarning } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold) {
              candidates.push({
                type: "purchase_invoice",
                id: inv.id!,
                number: inv.number,
                client_name: inv.client_name,
                clients_id: inv.clients_id,
                gross_price: inv.gross_price ?? 0,
                payment_status: inv.payment_status ?? "NOT_PAID",
                partially_paid_warning: partiallyPaidWarning,
                ref_number: inv.bank_ref_number,
                confidence,
                match_reasons: reasons,
              });
            }
          }
        }

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.confidence - a.confidence);
          const bestMatch = candidates[0]!;
          // Cross-currency match: if the match survived only on base-currency
          // evidence (exact_base_amount), tx.amount is in a different currency
          // than the invoice gross and a naive distribution of tx.amount would
          // book the wrong figure. Skip the auto-distribution and flag for
          // manual review; the match is still surfaced so a human can decide.
          const crossCurrency =
            bestMatch.match_reasons.includes("exact_base_amount") &&
            !bestMatch.match_reasons.includes("exact_amount");
          const distribution = crossCurrency
            ? undefined
            : buildSuggestedDistribution(
                bestMatch.type,
                bestMatch.id,
                tx.amount,
                bestMatch.partially_paid_warning,
              );
          // tx.description, tx.bank_account_name, and tx.ref_number originate
          // from bank-statement import (CAMT, Wise). Counterparties control
          // those bytes. bestMatch mirrors invoice fields — for purchase
          // invoices, number/ref_number/client_name can be OCR-seeded from
          // the receipt flow (see pdf-workflow.ts create_purchase_invoice_from_pdf).
          // Enumerate best_match explicitly rather than spreading bestMatch so
          // new MatchCandidate fields cannot silently bypass the wrap.
          results.push({
            transaction_id: tx.id,
            date: tx.date,
            amount: tx.amount,
            description: wrapUntrustedOcr(tx.description ?? undefined),
            bank_account_name: wrapUntrustedOcr(tx.bank_account_name ?? undefined),
            ref_number: wrapUntrustedOcr(tx.ref_number ?? undefined),
            best_match: {
              type: bestMatch.type,
              id: bestMatch.id,
              number: wrapUntrustedOcr(bestMatch.number) ?? "",
              client_name: wrapUntrustedOcr(bestMatch.client_name) ?? "",
              clients_id: bestMatch.clients_id,
              gross_price: bestMatch.gross_price,
              payment_status: bestMatch.payment_status,
              partially_paid_warning: bestMatch.partially_paid_warning,
              ref_number: wrapUntrustedOcr(bestMatch.ref_number ?? undefined),
              confidence: bestMatch.confidence,
              match_reasons: bestMatch.match_reasons,
            },
            other_candidate_count: candidates.length - 1,
            ...(distribution ? { distribution } : {}),
            ...(bestMatch.partially_paid_warning
              ? { manual_review_required: "Invoice is PARTIALLY_PAID; verify the remaining open balance before confirming." }
              : {}),
            ...(crossCurrency
              ? { manual_review_required: "Cross-currency match: tx amount is in a different currency than the invoice gross. Compute the correct distribution amount manually before confirming." }
              : {}),
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            total_unconfirmed: unconfirmed.length,
            matched: results.length,
            unmatched: unconfirmed.length - results.length,
            matches: results,
          }),
        }],
      };
    }
  );

  registerCapturedTool("auto_confirm_exact_matches",
    "Batch-confirm bank transactions with a single high-confidence match (>=90). DRY RUN by default — set execute=true to confirm.",
    {
      execute: z.boolean().optional().describe("Actually confirm transactions (default false = dry run)"),
      min_confidence: z.number().optional().describe("Minimum confidence (default 90)"),
    },
    { ...batch, title: "Auto-Confirm Bank Matches" },
    async ({ execute, min_confidence }) => {
      const threshold = min_confidence ?? 90;
      const dryRun = execute !== true;

      // Get all unconfirmed transactions across pages
      const allTx = await api.transactions.listAll();
      const unconfirmed = allTx.filter(isProjectTransaction);

      const allSales = await api.saleInvoices.listAll();
      const openSales = allSales.filter((inv: SaleInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );

      const allPurchases = await api.purchaseInvoices.listAll();
      const openPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );

      const saleIndex = buildInvoiceIndex(openSales);
      const purchaseIndex = buildInvoiceIndex(openPurchases);
      const confirmed = [];
      const skipped = [];
      // Track consumed invoices to avoid double-matching (keyed by type:id to prevent cross-table collisions)
      const consumedInvoiceKeys = new Set<string>();
      const total = unconfirmed.length;

      for (let i = 0; i < unconfirmed.length; i++) {
        const tx = unconfirmed[i]!;
        await reportProgress(i, total);
        const candidates: MatchCandidate[] = [];
        const { allowSaleInvoices, allowPurchaseInvoices } = getInvoiceMatchEligibility(tx);

        if (allowSaleInvoices) {
          for (const inv of getIndexedCandidates(saleIndex, tx.ref_number, tx.amount, tx.base_amount)) {
            if (inv.payment_status === "PARTIALLY_PAID") continue;
            const invKey = `sale:${inv.id!}`;
            if (consumedInvoiceKeys.has(invKey)) continue;
            const { confidence, reasons } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold) {
              candidates.push({
                type: "sale_invoice",
                id: inv.id!,
                number: inv.number ?? "",
                client_name: inv.client_name ?? "",
                clients_id: inv.clients_id,
                gross_price: inv.gross_price ?? 0,
                payment_status: inv.payment_status ?? "NOT_PAID",
                partially_paid_warning: false,
                confidence,
                match_reasons: reasons,
              });
            }
          }
        }

        if (allowPurchaseInvoices) {
          for (const inv of getIndexedCandidates(purchaseIndex, tx.ref_number, tx.amount, tx.base_amount)) {
            if (inv.payment_status === "PARTIALLY_PAID") continue;
            const invKey = `purchase:${inv.id!}`;
            if (consumedInvoiceKeys.has(invKey)) continue;
            const { confidence, reasons } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold) {
              candidates.push({
                type: "purchase_invoice",
                id: inv.id!,
                number: inv.number ?? "",
                client_name: inv.client_name ?? "",
                clients_id: inv.clients_id,
                gross_price: inv.gross_price ?? 0,
                payment_status: inv.payment_status ?? "NOT_PAID",
                partially_paid_warning: false,
                confidence,
                match_reasons: reasons,
              });
            }
          }
        }

        // Only auto-confirm if exactly one high-confidence match
        if (candidates.length === 1) {
          const match = candidates[0]!;
          // Cross-currency skip: if the match survived only on base-currency
          // evidence, tx.amount is in a different currency than the invoice
          // gross. Distributing tx.amount as-is books the wrong figure — same
          // guard that reconcile_transactions applies. Surface for manual review.
          const crossCurrency =
            match.match_reasons.includes("exact_base_amount") &&
            !match.match_reasons.includes("exact_amount");
          if (crossCurrency) {
            skipped.push({
              transaction_id: tx.id,
              reason: `Cross-currency match (base-amount only) against ${match.type} #${match.id}; compute the correct distribution amount manually before confirming.`,
            });
            continue;
          }
          const invoiceKey = `${match.type.replace("_invoice", "")}:${match.id}`;
          const table = match.type === "sale_invoice" ? "sale_invoices" : "purchase_invoices";
          // Always claim the invoice on attempt so dry-run preview matches execute
          // behaviour and a single invoice is never auto-matched against more than
          // one transaction within one call (even if confirm later fails).
          consumedInvoiceKeys.add(invoiceKey);
          if (dryRun) {
            confirmed.push({
              transaction_id: tx.id,
              amount: tx.amount,
              date: tx.date,
              match: { type: match.type, id: match.id, number: match.number, confidence: match.confidence },
              status: "would_confirm",
            });
          } else {
            try {
              await api.transactions.confirm(tx.id!, [{
                related_table: table,
                related_id: match.id,
                amount: tx.amount,
              }]);
              logAudit({
                tool: "auto_confirm_exact_matches", action: "CONFIRMED", entity_type: "transaction",
                entity_id: tx.id!,
                summary: `Confirmed transaction ${tx.id} against ${match.type} #${match.id} (${match.number})`,
                details: { amount: tx.amount, distributions: [{ related_table: table, related_id: match.id, amount: tx.amount }] },
              });
              confirmed.push({
                transaction_id: tx.id,
                amount: tx.amount,
                match: { type: match.type, id: match.id, number: match.number },
                status: "confirmed",
              });
            } catch (err: unknown) {
              skipped.push({ transaction_id: tx.id, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      }

      const mode = dryRun ? "DRY_RUN" : "EXECUTED";
      const summary = {
        total_unconfirmed: unconfirmed.length,
        auto_confirmed: confirmed.length,
        skipped: skipped.length,
        error_count: skipped.length,
      };

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode,
            summary,
            total_unconfirmed: summary.total_unconfirmed,
            auto_confirmed: summary.auto_confirmed,
            skipped: summary.skipped,
            results: confirmed,
            errors: skipped,
            execution: buildBatchExecutionContract({
              mode,
              summary,
              results: confirmed,
              errors: skipped,
            }),
          }),
        }],
      };
    }
  );

  registerCapturedTool("reconcile_inter_account_transfers",
    "Match and confirm inter-account transfers (own bank account to own bank account). " +
    "DUPLICATE-SAFE: checks existing journal entries before confirming — skips transfers already " +
    "journalized from the other account side (e.g. confirmed via CAMT import). " +
    "Phase 1: finds reciprocal transaction pairs across different bank accounts with matching amounts, dates, and own-account evidence, including mislabelled same-type bank rows. " +
    "Phase 2: detects one-sided transfers where counterparty name matches the company name or " +
    "counterparty IBAN matches another own bank account — confirms them with the target account. " +
    "If there are 2+ other bank accounts and IBAN is missing, provide target_accounts_dimensions_id. " +
    "DRY RUN by default — set execute=true to confirm. " +
    "Already-handled transfers are reported in the output for review/deletion.",
    {
      execute: z.boolean().optional().describe("Actually confirm matched pairs (default false = dry run)"),
      max_date_gap: z.number().int().min(0).max(MAX_INTER_ACCOUNT_DATE_GAP_DAYS).optional()
        .describe(`Maximum days between C and D transaction dates (default 1, max ${MAX_INTER_ACCOUNT_DATE_GAP_DAYS})`),
      target_accounts_dimensions_id: z.number().optional().describe(
        "For one-sided transfers (no matching D/C pair), specify the target bank account dimension ID. " +
        "Required when there are 3+ bank accounts and counterparty IBAN is missing."
      ),
    },
    { ...batch, title: "Reconcile Inter-Account Transfers" },
    async ({ execute, max_date_gap, target_accounts_dimensions_id }) => {
      const dryRun = execute !== true;
      const maxGap = validateInterAccountDateGap(max_date_gap);

      const [allTx, bankAccounts, accountDimensions, invoiceInfo] = await Promise.all([
        api.transactions.listAll(),
        api.readonly.getBankAccounts(),
        api.readonly.getAccountDimensions(),
        api.readonly.getInvoiceInfo(),
      ]);

      const unconfirmed = allTx.filter(isProjectTransaction);
      const companyName = normalizeCompanyName(invoiceInfo.invoice_company_name ?? "");

      const { ownIbanToDimension, dimensionToIban, dimensionToTitle, dimensionToAccountsId, ownDimensionIds } =
        buildBankAccountLookups(bankAccounts, accountDimensions);

      // Split by type
      const outgoing = unconfirmed.filter(tx => tx.type === "C");
      const incoming = unconfirmed.filter(tx => tx.type === "D");

      interface PairResult {
        outgoing_transaction_id: number;
        incoming_transaction_id: number;
        amount: number;
        date_out: string;
        date_in: string;
        from_account: string;
        to_account: string;
        from_dimension_id: number;
        to_dimension_id: number;
        description_out?: string | null;
        description_in?: string | null;
        confidence: number;
        match_reasons: string[];
        status: string;
        // Single-confirm policy: the incoming/reciprocal PROJECT row is deleted
        // after the outgoing confirm succeeds. In execute mode this field reports
        // the disposition ("deleted" or "orphan" when delete fails); in dry_run
        // it reports "would_delete_duplicate".
        incoming_action?: "deleted" | "orphan" | "would_delete_duplicate";
        incoming_note?: string;
      }

      interface AmbiguousPairResult {
        outgoing_transaction_id: number;
        amount: number;
        date_out: string;
        from_dimension_id: number;
        candidate_incoming_transaction_ids: number[];
        candidate_incoming_dimension_ids: number[];
        confidence: number;
        reason: string;
      }

      interface OneSidedResult {
        transaction_id: number;
        type: string;
        amount: number;
        date: string;
        source_account: string;
        source_dimension_id: number;
        target_account: string;
        target_dimension_id: number;
        description?: string | null;
        counterparty_name?: string | null;
        confidence: number;
        match_reasons: string[];
        status: string;
      }

      interface OneSidedInference {
        targetDimension?: number;
        confidence: number;
        reasons: string[];
      }

      const matchedPairs: PairResult[] = [];
      const ambiguousPairs: AmbiguousPairResult[] = [];
      const matchedOneSided: OneSidedResult[] = [];
      const skippedAlreadyHandled: Array<{
        transaction_id: number; amount: number; date: string;
        source_account: string; existing_journal_id: number; reason: string;
      }> = [];
      const errors: Array<{ transaction_ids: number[]; reason: string }> = [];
      const consumedTxIds = new Set<number>();
      const blockedOneSidedTxIds = new Set<number>();

      // Build index of existing confirmed inter-account journals for duplicate detection.
      // Key: "sourceDim|targetDim|amount|date" → journal_id
      const allJournals = await api.journals.listAllWithPostings();
      const existingInterAccountKeys = buildInterAccountJournalIndex(allJournals, ownDimensionIds);

      /**
       * Check if an inter-account transfer is already journalized. When the
       * transaction carries a `bank_ref_number` / `ref_number`, the reference
       * is used to disambiguate multiple journals sharing amount+date+dims —
       * only a same-reference or ref-less existing journal counts as a
       * duplicate. Unrelated transfers with different references no longer
       * suppress each other.
       */
      function findExistingJournal(
        sourceDim: number, targetDim: number, amount: number, date: string, maxGapDays: number,
        referenceNumber?: string | null,
      ): number | undefined {
        const roundedAmount = roundMoney(amount);
        const exactKey = `${sourceDim}|${targetDim}|${roundedAmount}|${date}`;
        const exact = findMatchingJournal(existingInterAccountKeys.get(exactKey), referenceNumber);
        if (exact !== undefined) return exact;
        if (maxGapDays > 0) {
          // Pure-UTC arithmetic via toUtcDay matches the Phase-1 compatibility
          // check. new Date(string) parses YYYY-MM-DD as UTC midnight today,
          // but any timestamp/offset suffix would drift under DST — defense
          // in depth against future inputs.
          const anchor = toUtcDay(date);
          for (let offset = -maxGapDays; offset <= maxGapDays; offset++) {
            if (offset === 0) continue;
            const nearby = new Date(anchor + offset * 86_400_000);
            const nearbyStr = nearby.toISOString().split("T")[0]!;
            const nearbyKey = `${sourceDim}|${targetDim}|${roundedAmount}|${nearbyStr}`;
            const nearbyMatch = findMatchingJournal(existingInterAccountKeys.get(nearbyKey), referenceNumber);
            if (nearbyMatch !== undefined) return nearbyMatch;
          }
        }
        return undefined;
      }

      // Helper: ensure clients_id is set (API requires it for confirmation)
      let resolvedClientsId: number | undefined;
      async function ensureClientsId(txId: number): Promise<void> {
        const tx = await api.transactions.get(txId);
        if (tx.clients_id) return;

        if (!resolvedClientsId && companyName) {
          const clients = await api.clients.findByName(invoiceInfo.invoice_company_name ?? "");
          const exact = clients.find(c => normalizeCompanyName(c.name) === companyName);
          resolvedClientsId = exact?.id;
        }

        if (resolvedClientsId) {
          await api.transactions.update(txId, { clients_id: resolvedClientsId });
        }
      }

      // Helper: build distribution with accounts_id + accounts_dimensions_id
      function buildAccountDistribution(targetDimensionId: number, amount: number) {
        const accountsId = dimensionToAccountsId.get(targetDimensionId);
        if (!accountsId) {
          throw new Error(`Cannot resolve accounts_id for dimension ${targetDimensionId}. Use list_account_dimensions to verify.`);
        }
        return {
          related_table: "accounts" as const,
          related_id: accountsId,
          related_sub_id: targetDimensionId,
          amount,
        };
      }

      const oneSidedInferenceCache = new Map<number, OneSidedInference>();
      function inferOneSidedTransfer(tx: Transaction): OneSidedInference {
        if (tx.id && oneSidedInferenceCache.has(tx.id)) {
          return oneSidedInferenceCache.get(tx.id)!;
        }

        const counterpartyName = normalizeCompanyName(tx.bank_account_name ?? "");
        const counterpartyIban = (tx.bank_account_no ?? "").trim().toUpperCase();

        let targetDimension: number | undefined;
        let confidence = 0;
        const reasons: string[] = [];

        if (counterpartyIban && ownIbanToDimension.has(counterpartyIban)) {
          const ibanDim = ownIbanToDimension.get(counterpartyIban)!;
          if (ibanDim !== tx.accounts_dimensions_id) {
            targetDimension = ibanDim;
            confidence += 90;
            reasons.push("counterparty_iban_is_own_account");
          }
        }

        if (!targetDimension && companyName.length >= 4 && counterpartyName.length >= 4) {
          const nameMatch = counterpartyName.includes(companyName) || companyName.includes(counterpartyName);
          if (nameMatch) {
            confidence += 60;
            reasons.push("counterparty_name_matches_company");

            const otherDimensions = [...dimensionToIban.keys()].filter(d => d !== tx.accounts_dimensions_id);
            if (target_accounts_dimensions_id && target_accounts_dimensions_id !== tx.accounts_dimensions_id && dimensionToIban.has(target_accounts_dimensions_id)) {
              targetDimension = target_accounts_dimensions_id;
              reasons.push("target_from_parameter");
            } else if (otherDimensions.length === 1) {
              targetDimension = otherDimensions[0]!;
              confidence += 20;
              reasons.push("only_one_other_account");
            }
          }
        }

        const result: OneSidedInference = {
          targetDimension,
          confidence: Math.min(confidence, 100),
          reasons,
        };
        if (tx.id) {
          oneSidedInferenceCache.set(tx.id, result);
        }
        return result;
      }

      function getTransferPairCompatibility(
        txA: Transaction,
        txB: Transaction,
      ): {
        confidence: number;
        reasons: string[];
        txAComparableAmount: number;
        conflictingComparableAmounts: boolean;
      } | undefined {
        const reasons: string[] = [];
        let confidence = 0;
        const txAComparableAmount = comparableTransactionAmount(txA);
        const txBComparableAmount = comparableTransactionAmount(txB);
        const nominalAmountsMatch = Math.abs(txA.amount - txB.amount) < 0.01;
        const comparableAmountsMatch = Math.abs(txAComparableAmount - txBComparableAmount) < 0.01;
        const hasMeaningfulComparableAmounts =
          hasMeaningfulComparableAmount(txA) ||
          hasMeaningfulComparableAmount(txB);
        const conflictingComparableAmounts =
          nominalAmountsMatch &&
          hasMeaningfulComparableAmounts &&
          !comparableAmountsMatch;

        if (nominalAmountsMatch) {
          if (!conflictingComparableAmounts) {
            confidence += 40;
            reasons.push("exact_amount");
          }
        } else if (comparableAmountsMatch && hasMeaningfulComparableAmounts) {
          confidence += 40;
          reasons.push("exact_base_amount");
        } else {
          return undefined;
        }

        // Pure-date UTC arithmetic via shared toUtcDay helper — stable
        // regardless of whether the input is YYYY-MM-DD or a full timestamp.
        const daysDiff = Math.abs((toUtcDay(txA.date) - toUtcDay(txB.date)) / 86_400_000);
        if (daysDiff === 0) {
          confidence += 20;
          reasons.push("same_date");
        } else if (daysDiff <= maxGap) {
          confidence += 10;
          reasons.push(`date_gap_${Math.round(daysDiff)}d`);
        } else {
          return undefined;
        }

        return {
          confidence,
          reasons,
          txAComparableAmount,
          conflictingComparableAmounts,
        };
      }

      function hasReciprocalOwnIbanEvidence(txA: Transaction, txB: Transaction): boolean {
        const txACounterpartyIban = (txA.bank_account_no ?? "").trim().toUpperCase();
        const txBCounterpartyIban = (txB.bank_account_no ?? "").trim().toUpperCase();
        const txAAccountIban = dimensionToIban.get(txA.accounts_dimensions_id) ?? "";
        const txBAccountIban = dimensionToIban.get(txB.accounts_dimensions_id) ?? "";

        return Boolean(
          txACounterpartyIban &&
          txBCounterpartyIban &&
          txAAccountIban &&
          txBAccountIban &&
          txACounterpartyIban === txBAccountIban &&
          txBCounterpartyIban === txAAccountIban
        );
      }

      function getSameTypeReciprocalEvidence(
        txA: Transaction,
        txB: Transaction,
        txAInference: OneSidedInference,
        txBInference: OneSidedInference,
      ): { confidenceBonus: number; reasons: string[] } | undefined {
        if (hasReciprocalOwnIbanEvidence(txA, txB)) {
          return {
            confidenceBonus: 40,
            reasons: ["same_type_reciprocal_own_iban"],
          };
        }

        const mutuallyStrongOneSidedInference =
          txAInference.confidence >= 80 &&
          txBInference.confidence >= 80;

        if (mutuallyStrongOneSidedInference) {
          return {
            confidenceBonus: 20,
            reasons: ["same_type_reciprocal_target_inference"],
          };
        }

        return undefined;
      }

      // --- Phase 1: C↔D pair matching ---
      for (let i = 0; i < outgoing.length; i++) {
        const txOut = outgoing[i]!;
        if (!txOut.id || consumedTxIds.has(txOut.id)) continue;
        await reportProgress(i, outgoing.length);

        const candidates: Array<{
          txIn: Transaction;
          confidence: number;
          reasons: string[];
          existingJournalId?: number;
        }> = [];

        for (const txIn of incoming) {
          if (!txIn.id || consumedTxIds.has(txIn.id)) continue;
          if (txOut.accounts_dimensions_id === txIn.accounts_dimensions_id) continue;

          const compatibility = getTransferPairCompatibility(txOut, txIn);
          if (!compatibility) continue;

          let confidence = compatibility.confidence;
          const reasons = [...compatibility.reasons];
          const txOutComparableAmount = compatibility.txAComparableAmount;
          const conflictingComparableAmounts = compatibility.conflictingComparableAmounts;

          const outCounterpartyIban = (txOut.bank_account_no ?? "").trim().toUpperCase();
          const inCounterpartyIban = (txIn.bank_account_no ?? "").trim().toUpperCase();
          const inAccountIban = dimensionToIban.get(txIn.accounts_dimensions_id) ?? "";
          const outAccountIban = dimensionToIban.get(txOut.accounts_dimensions_id) ?? "";

          if (conflictingComparableAmounts) {
            const txOutOneSided = inferOneSidedTransfer(txOut);
            const txInOneSided = inferOneSidedTransfer(txIn);
            const mutuallyConsistentOneSidedTargets =
              txOutOneSided.targetDimension === txIn.accounts_dimensions_id &&
              txInOneSided.targetDimension === txOut.accounts_dimensions_id;
            if (mutuallyConsistentOneSidedTargets) {
              blockedOneSidedTxIds.add(txOut.id);
              blockedOneSidedTxIds.add(txIn.id);
            }
            continue;
          }

          // Counterparty-signal evidence. Hard gate (below) requires at least
          // one of these to fire — amount+date alone is not enough to
          // auto-pair two unconfirmed transactions. Without this gate, two
          // unrelated same-day same-amount movements across different own
          // accounts (e.g. salary payout on LHV + VAT remittance on Wise
          // happening to share amount) would pair as a false "transfer."
          const hasOutgoingIbanMatchesIncomingAccount =
            Boolean(outCounterpartyIban && outCounterpartyIban === inAccountIban);
          const hasIncomingIbanMatchesOutgoingAccount =
            Boolean(inCounterpartyIban && inCounterpartyIban === outAccountIban);
          const hasOutgoingCounterpartyIsOwnAccount =
            Boolean(outCounterpartyIban && ownIbanToDimension.has(outCounterpartyIban));
          const hasIncomingCounterpartyIsOwnAccount =
            Boolean(inCounterpartyIban && ownIbanToDimension.has(inCounterpartyIban));

          if (hasOutgoingIbanMatchesIncomingAccount) {
            confidence += 30;
            reasons.push("outgoing_iban_matches_incoming_account");
          }
          if (hasIncomingIbanMatchesOutgoingAccount) {
            confidence += 30;
            reasons.push("incoming_iban_matches_outgoing_account");
          }

          if (hasOutgoingCounterpartyIsOwnAccount && confidence <= 60) {
            confidence += 15;
            reasons.push("outgoing_counterparty_is_own_account");
          }
          if (hasIncomingCounterpartyIsOwnAccount && confidence <= 60) {
            confidence += 15;
            reasons.push("incoming_counterparty_is_own_account");
          }

          const hasCounterpartySignal =
            hasOutgoingIbanMatchesIncomingAccount ||
            hasIncomingIbanMatchesOutgoingAccount ||
            hasOutgoingCounterpartyIsOwnAccount ||
            hasIncomingCounterpartyIsOwnAccount;
          if (!hasCounterpartySignal) continue;

          if (confidence < 50) continue;

          candidates.push({
            txIn,
            confidence: Math.min(confidence, 100),
            reasons,
            existingJournalId: findExistingJournal(
              txOut.accounts_dimensions_id,
              txIn.accounts_dimensions_id,
              txOutComparableAmount,
              txOut.date,
              maxGap,
              txOut.bank_ref_number ?? txOut.ref_number,
            ),
          });
        }

        if (candidates.length === 0) continue;

        candidates.sort((a, b) => {
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return (a.txIn.id ?? 0) - (b.txIn.id ?? 0);
        });

        const topConfidence = candidates[0]!.confidence;
        const topCandidates = candidates.filter(candidate => candidate.confidence === topConfidence);
        if (topCandidates.length > 1) {
          ambiguousPairs.push({
            outgoing_transaction_id: txOut.id,
            amount: txOut.amount,
            date_out: txOut.date,
            from_dimension_id: txOut.accounts_dimensions_id,
            candidate_incoming_transaction_ids: topCandidates.map(candidate => candidate.txIn.id!),
            candidate_incoming_dimension_ids: topCandidates.map(candidate => candidate.txIn.accounts_dimensions_id),
            confidence: topConfidence,
            reason: `Multiple incoming transactions matched outgoing transaction ${txOut.id} with the same confidence ${topConfidence}.`,
          });
          // Prevent Phase 2 from silently auto-confirming any tx flagged as
          // ambiguous here — humans need to decide. Phase 1b already does
          // this for its own ambiguity branch; mirror the protection here.
          blockedOneSidedTxIds.add(txOut.id);
          for (const candidate of topCandidates) blockedOneSidedTxIds.add(candidate.txIn.id!);
          continue;
        }

        const bestCandidate = topCandidates[0]!;
        const txIn = bestCandidate.txIn;

        if (bestCandidate.existingJournalId) {
          consumedTxIds.add(txOut.id);
          consumedTxIds.add(txIn.id!);
          skippedAlreadyHandled.push(
            { transaction_id: txOut.id, amount: txOut.amount, date: txOut.date, source_account: dimensionToTitle.get(txOut.accounts_dimensions_id) ?? "", existing_journal_id: bestCandidate.existingJournalId, reason: "Already journalized" },
            { transaction_id: txIn.id!, amount: txIn.amount, date: txIn.date, source_account: dimensionToTitle.get(txIn.accounts_dimensions_id) ?? "", existing_journal_id: bestCandidate.existingJournalId, reason: "Already journalized" },
          );
          continue;
        }

        const fromTitle = dimensionToTitle.get(txOut.accounts_dimensions_id) ?? `dim:${txOut.accounts_dimensions_id}`;
        const toTitle = dimensionToTitle.get(txIn.accounts_dimensions_id) ?? `dim:${txIn.accounts_dimensions_id}`;

        consumedTxIds.add(txOut.id);
        consumedTxIds.add(txIn.id!);

        // ONE confirm per pair: confirming the outgoing side with a distribution
        // to the target bank dimension creates a journal that touches BOTH bank
        // accounts (per CLAUDE.md: "confirming one side creates a journal touching
        // both bank accounts"). The incoming PROJECT row is a duplicate mirror of
        // the same physical movement — keeping it would double-book the legs, and
        // confirming it in this same loop was the bug that motivated this change.
        // Delete the mirror after the confirm succeeds; on delete failure the
        // outgoing journal is still correct, only the orphan PROJECT row remains.
        if (dryRun) {
          matchedPairs.push({
            outgoing_transaction_id: txOut.id, incoming_transaction_id: txIn.id!,
            amount: txOut.amount, date_out: txOut.date, date_in: txIn.date,
            from_account: fromTitle, to_account: toTitle,
            from_dimension_id: txOut.accounts_dimensions_id, to_dimension_id: txIn.accounts_dimensions_id,
            description_out: wrapUntrustedOcr(txOut.description ?? undefined), description_in: wrapUntrustedOcr(txIn.description ?? undefined),
            confidence: bestCandidate.confidence, match_reasons: bestCandidate.reasons,
            status: "would_confirm", incoming_action: "would_delete_duplicate",
          });
        } else {
          try {
            await ensureClientsId(txOut.id);
            await api.transactions.confirm(txOut.id, [buildAccountDistribution(txIn.accounts_dimensions_id, txOut.amount)]);
            logAudit({
              tool: "reconcile_inter_account_transfers", action: "CONFIRMED", entity_type: "transaction",
              entity_id: txOut.id,
              summary: `Confirmed inter-account outgoing ${txOut.amount} EUR (${fromTitle} -> ${toTitle})`,
              details: { amount: txOut.amount, date: txOut.date, paired_incoming_id: txIn.id },
            });

            let incomingAction: "deleted" | "orphan" = "deleted";
            let incomingNote: string | undefined;
            try {
              await api.transactions.delete(txIn.id!);
              logAudit({
                tool: "reconcile_inter_account_transfers", action: "DELETED", entity_type: "transaction",
                entity_id: txIn.id!,
                summary: `Deleted duplicate incoming row ${txIn.id} after confirming outgoing ${txOut.id} (${fromTitle} -> ${toTitle})`,
                details: { amount: txIn.amount, date: txIn.date, paired_outgoing_id: txOut.id },
              });
            } catch (delErr: unknown) {
              incomingAction = "orphan";
              incomingNote = `Outgoing ${txOut.id} was confirmed, but deleting the duplicate incoming PROJECT row ${txIn.id} failed: ${delErr instanceof Error ? delErr.message : String(delErr)}. Manually delete ${txIn.id} to avoid double-booking if it is later confirmed.`;
              errors.push({ transaction_ids: [txOut.id, txIn.id!], reason: incomingNote });
            }

            matchedPairs.push({
              outgoing_transaction_id: txOut.id, incoming_transaction_id: txIn.id!,
              amount: txOut.amount, date_out: txOut.date, date_in: txIn.date,
              from_account: fromTitle, to_account: toTitle,
              from_dimension_id: txOut.accounts_dimensions_id, to_dimension_id: txIn.accounts_dimensions_id,
              description_out: wrapUntrustedOcr(txOut.description ?? undefined), description_in: wrapUntrustedOcr(txIn.description ?? undefined),
              confidence: bestCandidate.confidence, match_reasons: bestCandidate.reasons,
              status: "confirmed", incoming_action: incomingAction,
              ...(incomingNote ? { incoming_note: incomingNote } : {}),
            });
          } catch (err: unknown) {
            errors.push({
              transaction_ids: [txOut.id, txIn.id!],
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // --- Phase 1b: reciprocal same-type pairs with strong mutual target evidence ---
      const phaseOneRemaining = unconfirmed.filter(
        tx => tx.id && !consumedTxIds.has(tx.id) && !blockedOneSidedTxIds.has(tx.id),
      );

      for (const tx of phaseOneRemaining) {
        if (!tx.id || consumedTxIds.has(tx.id) || blockedOneSidedTxIds.has(tx.id)) continue;

        const txInference = inferOneSidedTransfer(tx);
        if (txInference.confidence < 50 || !txInference.targetDimension) continue;

        const candidates: Array<{
          counterpart: Transaction;
          confidence: number;
          reasons: string[];
          existingJournalId?: number;
        }> = [];

        for (const other of phaseOneRemaining) {
          if (!other.id || other.id === tx.id || consumedTxIds.has(other.id) || blockedOneSidedTxIds.has(other.id)) continue;
          if (other.type !== tx.type) continue;
          if (other.accounts_dimensions_id !== txInference.targetDimension) continue;

          const otherInference = inferOneSidedTransfer(other);
          if (otherInference.confidence < 50 || otherInference.targetDimension !== tx.accounts_dimensions_id) continue;

          const reciprocalEvidence = getSameTypeReciprocalEvidence(tx, other, txInference, otherInference);
          if (!reciprocalEvidence) continue;

          const compatibility = getTransferPairCompatibility(tx, other);
          if (!compatibility) continue;

          if (compatibility.conflictingComparableAmounts) {
            blockedOneSidedTxIds.add(tx.id);
            blockedOneSidedTxIds.add(other.id);
            continue;
          }

          candidates.push({
            counterpart: other,
            confidence: Math.min(compatibility.confidence + reciprocalEvidence.confidenceBonus, 100),
            reasons: [...compatibility.reasons, ...reciprocalEvidence.reasons],
            existingJournalId: findExistingJournal(
              tx.accounts_dimensions_id,
              other.accounts_dimensions_id,
              compatibility.txAComparableAmount,
              tx.date,
              maxGap,
              tx.bank_ref_number ?? tx.ref_number,
            ),
          });
        }

        if (candidates.length === 0) continue;

        candidates.sort((a, b) => {
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return (a.counterpart.id ?? 0) - (b.counterpart.id ?? 0);
        });

        const topConfidence = candidates[0]!.confidence;
        const topCandidates = candidates.filter(candidate => candidate.confidence === topConfidence);
        if (topCandidates.length > 1) {
          ambiguousPairs.push({
            outgoing_transaction_id: tx.id,
            amount: tx.amount,
            date_out: tx.date,
            from_dimension_id: tx.accounts_dimensions_id,
            candidate_incoming_transaction_ids: topCandidates.map(candidate => candidate.counterpart.id!),
            candidate_incoming_dimension_ids: topCandidates.map(candidate => candidate.counterpart.accounts_dimensions_id),
            confidence: topConfidence,
            reason: `Multiple reciprocal same-type own-account candidates matched transaction ${tx.id} with confidence ${topConfidence}.`,
          });
          blockedOneSidedTxIds.add(tx.id);
          for (const candidate of topCandidates) blockedOneSidedTxIds.add(candidate.counterpart.id!);
          continue;
        }

        const bestCandidate = topCandidates[0]!;
        const counterpart = bestCandidate.counterpart;

        if (!counterpart.id || consumedTxIds.has(counterpart.id) || blockedOneSidedTxIds.has(counterpart.id)) {
          continue;
        }

        if (bestCandidate.existingJournalId) {
          consumedTxIds.add(tx.id);
          consumedTxIds.add(counterpart.id);
          skippedAlreadyHandled.push(
            {
              transaction_id: tx.id,
              amount: tx.amount,
              date: tx.date,
              source_account: dimensionToTitle.get(tx.accounts_dimensions_id) ?? "",
              existing_journal_id: bestCandidate.existingJournalId,
              reason: "Already journalized",
            },
            {
              transaction_id: counterpart.id,
              amount: counterpart.amount,
              date: counterpart.date,
              source_account: dimensionToTitle.get(counterpart.accounts_dimensions_id) ?? "",
              existing_journal_id: bestCandidate.existingJournalId,
              reason: "Already journalized",
            },
          );
          continue;
        }

        const fromTitle = dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`;
        const toTitle = dimensionToTitle.get(counterpart.accounts_dimensions_id) ?? `dim:${counterpart.accounts_dimensions_id}`;

        consumedTxIds.add(tx.id);
        consumedTxIds.add(counterpart.id);

        // Same single-confirm policy as Phase 1: one journal per pair. The
        // reciprocal same-type counterpart is a duplicate record of the same
        // physical movement, so delete it after tx confirms successfully.
        if (dryRun) {
          matchedPairs.push({
            outgoing_transaction_id: tx.id,
            incoming_transaction_id: counterpart.id,
            amount: tx.amount,
            date_out: tx.date,
            date_in: counterpart.date,
            from_account: fromTitle,
            to_account: toTitle,
            from_dimension_id: tx.accounts_dimensions_id,
            to_dimension_id: counterpart.accounts_dimensions_id,
            description_out: wrapUntrustedOcr(tx.description ?? undefined),
            description_in: wrapUntrustedOcr(counterpart.description ?? undefined),
            confidence: bestCandidate.confidence,
            match_reasons: bestCandidate.reasons,
            status: "would_confirm",
            incoming_action: "would_delete_duplicate",
          });
        } else {
          try {
            await ensureClientsId(tx.id);
            await api.transactions.confirm(tx.id, [buildAccountDistribution(counterpart.accounts_dimensions_id, tx.amount)]);
            logAudit({
              tool: "reconcile_inter_account_transfers",
              action: "CONFIRMED",
              entity_type: "transaction",
              entity_id: tx.id,
              summary: `Confirmed reciprocal same-type inter-account transfer ${tx.amount} EUR (${fromTitle} -> ${toTitle})`,
              details: { amount: tx.amount, date: tx.date, paired_counterpart_id: counterpart.id },
            });

            let incomingAction: "deleted" | "orphan" = "deleted";
            let incomingNote: string | undefined;
            try {
              await api.transactions.delete(counterpart.id);
              logAudit({
                tool: "reconcile_inter_account_transfers",
                action: "DELETED",
                entity_type: "transaction",
                entity_id: counterpart.id,
                summary: `Deleted reciprocal same-type duplicate row ${counterpart.id} after confirming ${tx.id} (${fromTitle} -> ${toTitle})`,
                details: { amount: counterpart.amount, date: counterpart.date, paired_confirmed_id: tx.id },
              });
            } catch (delErr: unknown) {
              incomingAction = "orphan";
              incomingNote = `Transaction ${tx.id} was confirmed, but deleting the duplicate counterpart PROJECT row ${counterpart.id} failed: ${delErr instanceof Error ? delErr.message : String(delErr)}. Manually delete ${counterpart.id} to avoid double-booking if it is later confirmed.`;
              errors.push({ transaction_ids: [tx.id, counterpart.id], reason: incomingNote });
            }

            matchedPairs.push({
              outgoing_transaction_id: tx.id,
              incoming_transaction_id: counterpart.id,
              amount: tx.amount,
              date_out: tx.date,
              date_in: counterpart.date,
              from_account: fromTitle,
              to_account: toTitle,
              from_dimension_id: tx.accounts_dimensions_id,
              to_dimension_id: counterpart.accounts_dimensions_id,
              description_out: wrapUntrustedOcr(tx.description ?? undefined),
              description_in: wrapUntrustedOcr(counterpart.description ?? undefined),
              confidence: bestCandidate.confidence,
              match_reasons: bestCandidate.reasons,
              status: "confirmed",
              incoming_action: incomingAction,
              ...(incomingNote ? { incoming_note: incomingNote } : {}),
            });
          } catch (err: unknown) {
            errors.push({
              transaction_ids: [tx.id, counterpart.id],
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // --- Phase 2: one-sided transfers (counterparty = company name or own IBAN) ---
      const remaining = unconfirmed.filter(
        tx => tx.id && !consumedTxIds.has(tx.id) && !blockedOneSidedTxIds.has(tx.id),
      );

      for (const tx of remaining) {
        if (!tx.id) continue;
        const { targetDimension, confidence, reasons } = inferOneSidedTransfer(tx);

        if (confidence < 50 || !targetDimension) continue;

        // Check if this transfer is already journalized from the other side
        const existingJournalId = findExistingJournal(
          tx.accounts_dimensions_id,
          targetDimension,
          comparableTransactionAmount(tx),
          tx.date,
          maxGap,
          tx.bank_ref_number ?? tx.ref_number,
        );
        if (existingJournalId) {
          consumedTxIds.add(tx.id);
          skippedAlreadyHandled.push({
            transaction_id: tx.id, amount: tx.amount, date: tx.date,
            source_account: dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`,
            existing_journal_id: existingJournalId,
            reason: "Already journalized from the other account side",
          });
          continue;
        }

        consumedTxIds.add(tx.id);
        const sourceTitle = dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`;
        const targetTitle = dimensionToTitle.get(targetDimension) ?? `dim:${targetDimension}`;

        if (dryRun) {
          matchedOneSided.push({
            transaction_id: tx.id, type: tx.type, amount: tx.amount, date: tx.date,
            source_account: sourceTitle, source_dimension_id: tx.accounts_dimensions_id,
            target_account: targetTitle, target_dimension_id: targetDimension,
            description: wrapUntrustedOcr(tx.description ?? undefined), counterparty_name: wrapUntrustedOcr(tx.bank_account_name ?? undefined),
            confidence: Math.min(confidence, 100), match_reasons: reasons, status: "would_confirm",
          });
        } else {
          try {
            await ensureClientsId(tx.id);
            await api.transactions.confirm(tx.id, [buildAccountDistribution(targetDimension, tx.amount)]);
            logAudit({
              tool: "reconcile_inter_account_transfers", action: "CONFIRMED", entity_type: "transaction",
              entity_id: tx.id,
              summary: `Confirmed one-sided inter-account transfer ${tx.amount} EUR (${sourceTitle} -> ${targetTitle})`,
              details: { amount: tx.amount, date: tx.date },
            });
            matchedOneSided.push({
              transaction_id: tx.id, type: tx.type, amount: tx.amount, date: tx.date,
              source_account: sourceTitle, source_dimension_id: tx.accounts_dimensions_id,
              target_account: targetTitle, target_dimension_id: targetDimension,
              description: wrapUntrustedOcr(tx.description ?? undefined), counterparty_name: wrapUntrustedOcr(tx.bank_account_name ?? undefined),
              confidence: Math.min(confidence, 100), match_reasons: reasons, status: "confirmed",
            });
          } catch (err: unknown) {
            errors.push({
              transaction_ids: [tx.id],
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const mode = dryRun ? "DRY_RUN" : "EXECUTED";
      const summary = {
        total_unconfirmed: unconfirmed.length,
        matched_pairs: matchedPairs.length,
        matched_one_sided: matchedOneSided.length,
        skipped_ambiguous: ambiguousPairs.length,
        skipped_already_handled: skippedAlreadyHandled.length,
        error_count: errors.length,
      };

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode,
            summary,
            company_name: invoiceInfo.invoice_company_name,
            total_unconfirmed: summary.total_unconfirmed,
            matched_pairs: summary.matched_pairs,
            matched_one_sided: summary.matched_one_sided,
            skipped_ambiguous: summary.skipped_ambiguous,
            skipped_already_handled: summary.skipped_already_handled,
            own_bank_accounts: [...dimensionToIban.entries()].map(([dimId, iban]) => ({
              accounts_dimensions_id: dimId,
              iban,
              title: dimensionToTitle.get(dimId),
            })),
            pairs: matchedPairs,
            ambiguous_pairs: ambiguousPairs,
            one_sided: matchedOneSided,
            already_handled: skippedAlreadyHandled,
            errors,
            execution: buildBatchExecutionContract({
              mode,
              summary,
              results: [...matchedPairs, ...matchedOneSided],
              skipped: [...ambiguousPairs, ...skippedAlreadyHandled],
              errors,
            }),
          }),
        }],
      };
    }
  );

  async function invokeCapturedTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const handler = handlers.get(tool);
    if (!handler) {
      throw new Error(`Bank reconciliation wrapper could not find tool handler for ${tool}`);
    }

    const result = await handler(args);
    const text = result.content[0]?.text;
    if (!text) {
      throw new Error(`Bank reconciliation wrapper received no text payload from ${tool}`);
    }

    const parsed = parseMcpResponse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  }

  registerTool(server, "reconcile_bank_transactions",
    "Merged bank reconciliation entry point. Use mode='suggest' for invoice-match suggestions, mode='dry_run_auto_confirm' or mode='execute_auto_confirm' for exact invoice matches, and mode='inter_account_dry_run' for own-account transfer detection.",
    {
      mode: z.enum(["suggest", "dry_run_auto_confirm", "execute_auto_confirm", "inter_account_dry_run"])
        .optional()
        .describe("Workflow phase to run. Defaults to suggest."),
      min_confidence: z.number().optional().describe("Minimum confidence threshold for invoice matching modes."),
      max_date_gap: z.number().int().min(0).max(MAX_INTER_ACCOUNT_DATE_GAP_DAYS).optional()
        .describe(`Maximum days between inter-account transfer legs (default 1, max ${MAX_INTER_ACCOUNT_DATE_GAP_DAYS}).`),
      target_accounts_dimensions_id: z.number().optional().describe(
        "For inter_account_dry_run one-sided transfers, specify the target bank account dimension ID when it cannot be inferred."
      ),
    },
    { ...batch, title: "Reconcile Bank Transactions" },
    async ({ mode, min_confidence, max_date_gap, target_accounts_dimensions_id }) => {
      const selectedMode = mode ?? "suggest";
      let delegatedTool: string;
      let delegatedArgs: Record<string, unknown>;

      switch (selectedMode) {
        case "suggest":
          delegatedTool = "reconcile_transactions";
          delegatedArgs = {
            ...(min_confidence !== undefined ? { min_confidence } : {}),
          };
          break;
        case "dry_run_auto_confirm":
          delegatedTool = "auto_confirm_exact_matches";
          delegatedArgs = {
            execute: false,
            ...(min_confidence !== undefined ? { min_confidence } : {}),
          };
          break;
        case "execute_auto_confirm":
          delegatedTool = "auto_confirm_exact_matches";
          delegatedArgs = {
            execute: true,
            ...(min_confidence !== undefined ? { min_confidence } : {}),
          };
          break;
        case "inter_account_dry_run":
          delegatedTool = "reconcile_inter_account_transfers";
          delegatedArgs = {
            execute: false,
            ...(max_date_gap !== undefined ? { max_date_gap } : {}),
            ...(target_accounts_dimensions_id !== undefined ? { target_accounts_dimensions_id } : {}),
          };
          break;
      }

      const result = await invokeCapturedTool(delegatedTool, delegatedArgs);
      const resultSummary = recordValue(result.summary);
      const workflowSummary = selectedMode === "dry_run_auto_confirm"
        ? `Exact-match dry run would confirm ${numberValue(resultSummary, "auto_confirmed")} bank transaction(s), skip ${numberValue(resultSummary, "skipped")}, and report ${numberValue(resultSummary, "error_count")} error(s).`
        : selectedMode === "inter_account_dry_run"
          ? `Inter-account dry run would reconcile ${numberValue(resultSummary, "matched_pairs")} transfer pair(s), ${numberValue(resultSummary, "matched_one_sided")} one-sided transfer(s), skip ${numberValue(resultSummary, "skipped_ambiguous")} ambiguous transfer(s), and report ${numberValue(resultSummary, "error_count")} error(s).`
          : undefined;
      const workflow = workflowSummary
        ? buildWorkflowEnvelope({
            summary: workflowSummary,
            dry_run_steps: [{
              tool: delegatedTool,
              summary: workflowSummary,
              suggested_args: delegatedArgs,
              preview: resultSummary,
            }],
          })
        : undefined;
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            recommended_entry_point: "reconcile_bank_transactions",
            mode: selectedMode,
            delegated_tool: delegatedTool,
            delegated_args: delegatedArgs,
            ...(workflow ? { workflow } : {}),
            result,
          }),
        }],
      };
    },
  );
}
