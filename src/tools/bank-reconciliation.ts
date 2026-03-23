import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import type { ApiContext } from "./crud-tools.js";
import type { Transaction, SaleInvoice, PurchaseInvoice, BankAccount } from "../types/api.js";
import { readOnly, batch } from "../annotations.js";
import { reportProgress } from "../progress.js";
import { isProjectTransaction } from "../transaction-status.js";
import { buildInterAccountJournalIndex } from "./inter-account-utils.js";

const MAX_INTER_ACCOUNT_DATE_GAP_DAYS = 31;

function validateInterAccountDateGap(maxDateGap: number | undefined): number {
  const value = maxDateGap ?? 1;

  if (!Number.isInteger(value) || value < 0 || value > MAX_INTER_ACCOUNT_DATE_GAP_DAYS) {
    throw new Error(`max_date_gap must be an integer between 0 and ${MAX_INTER_ACCOUNT_DATE_GAP_DAYS}.`);
  }

  return value;
}

/** Normalize text for fuzzy company name matching: lowercase, strip diacritics, collapse whitespace */
export function normalizeCompanyName(name: string): string {
  return name.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // strip diacritics (ü→u, ö→o, etc.)
    .replace(/\s+/g, " ");
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

export function matchScore(
  tx: Transaction,
  invoice: { gross_price?: number; base_gross_price?: number; bank_ref_number?: string | null; clients_id?: number; client_name?: string; payment_status?: string },
  txAmount: number
): { confidence: number; reasons: string[]; partiallyPaidWarning: boolean } {
  let confidence = 0;
  const reasons: string[] = [];

  // Amount match (check both local and base currency amounts)
  const invoiceAmount = invoice.gross_price ?? 0;
  const baseAmount = tx.base_amount ?? txAmount;
  const baseInvoiceAmount = invoice.base_gross_price ?? invoiceAmount;
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

export function registerBankReconciliationTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "reconcile_transactions",
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

      const results = [];

      for (const tx of unconfirmed) {
        const candidates: MatchCandidate[] = [];

        // Match against both sale and purchase invoices regardless of type.
        // The API stores all bank transactions as type C even for incoming payments,
        // so type-based filtering would miss sale invoice matches entirely.
        for (const inv of openSales) {
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

        for (const inv of openPurchases) {
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

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.confidence - a.confidence);
          const bestMatch = candidates[0]!;
          const distribution = buildSuggestedDistribution(
            bestMatch.type,
            bestMatch.id,
            tx.amount,
            bestMatch.partially_paid_warning,
          );
          results.push({
            transaction_id: tx.id,
            date: tx.date,
            amount: tx.amount,
            type: tx.type,
            description: tx.description,
            bank_account_name: tx.bank_account_name,
            ref_number: tx.ref_number,
            best_match: bestMatch,
            other_candidates: candidates.slice(1, 3),
            ...(distribution ? { distribution } : {}),
            distribution_ready: distribution !== undefined,
            ...(bestMatch.partially_paid_warning
              ? { manual_review_required: "Invoice is PARTIALLY_PAID; verify the remaining open balance before confirming." }
              : {}),
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_unconfirmed: unconfirmed.length,
            matched: results.length,
            unmatched: unconfirmed.length - results.length,
            matches: results,
          }, null, 2),
        }],
      };
    }
  );

  registerTool(server, "auto_confirm_exact_matches",
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

      const confirmed = [];
      const skipped = [];
      // Track consumed invoices to avoid double-matching (keyed by type:id to prevent cross-table collisions)
      const consumedInvoiceKeys = new Set<string>();
      const total = unconfirmed.length;

      for (let i = 0; i < unconfirmed.length; i++) {
        const tx = unconfirmed[i]!;
        await reportProgress(i, total);
        const candidates: MatchCandidate[] = [];

        // Match against both sale and purchase invoices regardless of type.
        // The API stores all bank transactions as type C, so type-based filtering
        // would miss sale invoice matches entirely.
        for (const inv of openSales) {
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

        for (const inv of openPurchases) {
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

        // Only auto-confirm if exactly one high-confidence match
        if (candidates.length === 1) {
          const match = candidates[0]!;
          const invoiceKey = `${match.type.replace("_invoice", "")}:${match.id}`;
          const table = match.type === "sale_invoice" ? "sale_invoices" : "purchase_invoices";
          if (dryRun) {
            consumedInvoiceKeys.add(invoiceKey);
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
              consumedInvoiceKeys.add(invoiceKey);
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: dryRun ? "DRY_RUN" : "EXECUTED",
            total_unconfirmed: unconfirmed.length,
            auto_confirmed: confirmed.length,
            skipped: skipped.length,
            results: confirmed,
            errors: skipped,
          }, null, 2),
        }],
      };
    }
  );

  registerTool(server, "reconcile_inter_account_transfers",
    "Match and confirm inter-account transfers (own bank account to own bank account). " +
    "DUPLICATE-SAFE: checks existing journal entries before confirming — skips transfers already " +
    "journalized from the other account side (e.g. confirmed via CAMT import). " +
    "Phase 1: finds C↔D transaction pairs across different bank accounts with matching amounts and dates. " +
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

      // Build lookup: IBAN → accounts_dimensions_id for own bank accounts
      const ownIbanToDimension = new Map<string, number>();
      const dimensionToIban = new Map<number, string>();
      const dimensionToTitle = new Map<number, string>();
      const dimensionToAccountsId = new Map<number, number>();
      for (const ba of bankAccounts) {
        const iban = (ba.iban_code ?? ba.account_no ?? "").trim().toUpperCase();
        if (iban && ba.accounts_dimensions_id) {
          ownIbanToDimension.set(iban, ba.accounts_dimensions_id);
          dimensionToIban.set(ba.accounts_dimensions_id, iban);
          dimensionToTitle.set(ba.accounts_dimensions_id, ba.account_name_est);
        }
      }
      // Map dimension IDs to their parent accounts_id
      for (const dim of accountDimensions) {
        if (dim.id && !dim.is_deleted) {
          dimensionToAccountsId.set(dim.id, dim.accounts_id);
        }
      }
      const ownDimensionIds = new Set(dimensionToIban.keys());

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

      const matchedPairs: PairResult[] = [];
      const ambiguousPairs: AmbiguousPairResult[] = [];
      const matchedOneSided: OneSidedResult[] = [];
      const skippedAlreadyHandled: Array<{
        transaction_id: number; amount: number; date: string;
        source_account: string; existing_journal_id: number; reason: string;
      }> = [];
      const errors: Array<{ transaction_ids: number[]; reason: string }> = [];
      const consumedTxIds = new Set<number>();

      // Build index of existing confirmed inter-account journals for duplicate detection.
      // Key: "sourceDim|targetDim|amount|date" → journal_id
      const allJournals = await api.journals.listAllWithPostings();
      const existingInterAccountKeys = buildInterAccountJournalIndex(allJournals, ownDimensionIds);

      /** Check if an inter-account transfer is already journalized */
      function findExistingJournal(sourceDim: number, targetDim: number, amount: number, date: string, maxGapDays: number): number | undefined {
        // Round to avoid floating point mismatches
        const roundedAmount = Math.round(amount * 100) / 100;
        const exactKey = `${sourceDim}|${targetDim}|${roundedAmount}|${date}`;
        if (existingInterAccountKeys.has(exactKey)) return existingInterAccountKeys.get(exactKey);
        // Check nearby dates
        if (maxGapDays > 0) {
          const d = new Date(date);
          for (let offset = -maxGapDays; offset <= maxGapDays; offset++) {
            if (offset === 0) continue;
            const nearby = new Date(d.getTime() + offset * 86_400_000);
            const nearbyStr = nearby.toISOString().split("T")[0]!;
            const nearbyKey = `${sourceDim}|${targetDim}|${roundedAmount}|${nearbyStr}`;
            if (existingInterAccountKeys.has(nearbyKey)) return existingInterAccountKeys.get(nearbyKey);
          }
        }
        return undefined;
      }

      // Helper: ensure clients_id is set (API requires it for confirmation)
      let resolvedClientsId: number | undefined;
      async function ensureClientsId(txId: number, counterpartyName: string | null | undefined): Promise<void> {
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

          let confidence = 0;
          const reasons: string[] = [];

          if (Math.abs(txOut.amount - txIn.amount) < 0.01) {
            confidence += 40;
            reasons.push("exact_amount");
          } else {
            continue;
          }

          const dOut = new Date(txOut.date);
          const dIn = new Date(txIn.date);
          const daysDiff = Math.abs((dOut.getTime() - dIn.getTime()) / 86_400_000);
          if (daysDiff === 0) {
            confidence += 20;
            reasons.push("same_date");
          } else if (daysDiff <= maxGap) {
            confidence += 10;
            reasons.push(`date_gap_${Math.round(daysDiff)}d`);
          } else {
            continue;
          }

          const outCounterpartyIban = (txOut.bank_account_no ?? "").trim().toUpperCase();
          const inCounterpartyIban = (txIn.bank_account_no ?? "").trim().toUpperCase();
          const inAccountIban = dimensionToIban.get(txIn.accounts_dimensions_id) ?? "";
          const outAccountIban = dimensionToIban.get(txOut.accounts_dimensions_id) ?? "";

          if (outCounterpartyIban && outCounterpartyIban === inAccountIban) {
            confidence += 30;
            reasons.push("outgoing_iban_matches_incoming_account");
          }
          if (inCounterpartyIban && inCounterpartyIban === outAccountIban) {
            confidence += 30;
            reasons.push("incoming_iban_matches_outgoing_account");
          }

          if (outCounterpartyIban && ownIbanToDimension.has(outCounterpartyIban) && confidence <= 60) {
            confidence += 15;
            reasons.push("outgoing_counterparty_is_own_account");
          }
          if (inCounterpartyIban && ownIbanToDimension.has(inCounterpartyIban) && confidence <= 60) {
            confidence += 15;
            reasons.push("incoming_counterparty_is_own_account");
          }

          if (confidence < 50) continue;

          candidates.push({
            txIn,
            confidence: Math.min(confidence, 100),
            reasons,
            existingJournalId: findExistingJournal(txOut.accounts_dimensions_id, txIn.accounts_dimensions_id, txOut.amount, txOut.date, maxGap),
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

        if (dryRun) {
          matchedPairs.push({
            outgoing_transaction_id: txOut.id, incoming_transaction_id: txIn.id!,
            amount: txOut.amount, date_out: txOut.date, date_in: txIn.date,
            from_account: fromTitle, to_account: toTitle,
            from_dimension_id: txOut.accounts_dimensions_id, to_dimension_id: txIn.accounts_dimensions_id,
            description_out: txOut.description, description_in: txIn.description,
            confidence: bestCandidate.confidence, match_reasons: bestCandidate.reasons, status: "would_confirm",
          });
        } else {
          try {
            await ensureClientsId(txOut.id, txOut.bank_account_name);
            await api.transactions.confirm(txOut.id, [buildAccountDistribution(txIn.accounts_dimensions_id, txOut.amount)]);
            try {
              await ensureClientsId(txIn.id!, txIn.bank_account_name);
              await api.transactions.confirm(txIn.id!, [buildAccountDistribution(txOut.accounts_dimensions_id, txIn.amount)]);
            } catch (err2: unknown) {
              // Outgoing confirmed but incoming failed — partial confirmation
              errors.push({
                transaction_ids: [txOut.id, txIn.id!],
                reason: `PARTIAL: outgoing ${txOut.id} confirmed, but incoming ${txIn.id} failed: ${err2 instanceof Error ? err2.message : String(err2)}. Invalidate ${txOut.id} to roll back.`,
              });
              continue;
            }
            matchedPairs.push({
              outgoing_transaction_id: txOut.id, incoming_transaction_id: txIn.id!,
              amount: txOut.amount, date_out: txOut.date, date_in: txIn.date,
              from_account: fromTitle, to_account: toTitle,
              from_dimension_id: txOut.accounts_dimensions_id, to_dimension_id: txIn.accounts_dimensions_id,
              description_out: txOut.description, description_in: txIn.description,
              confidence: bestCandidate.confidence, match_reasons: bestCandidate.reasons, status: "confirmed",
            });
          } catch (err: unknown) {
            errors.push({
              transaction_ids: [txOut.id, txIn.id!],
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // --- Phase 2: one-sided transfers (counterparty = company name or own IBAN) ---
      const remaining = unconfirmed.filter(tx => tx.id && !consumedTxIds.has(tx.id));

      for (const tx of remaining) {
        if (!tx.id) continue;
        const counterpartyName = normalizeCompanyName(tx.bank_account_name ?? "");
        const counterpartyIban = (tx.bank_account_no ?? "").trim().toUpperCase();

        let targetDimension: number | undefined;
        let confidence = 0;
        const reasons: string[] = [];

        // Check if counterparty IBAN matches another own bank account
        if (counterpartyIban && ownIbanToDimension.has(counterpartyIban)) {
          const ibanDim = ownIbanToDimension.get(counterpartyIban)!;
          if (ibanDim !== tx.accounts_dimensions_id) {
            targetDimension = ibanDim;
            confidence += 90;
            reasons.push("counterparty_iban_is_own_account");
          }
        }

        // Check if counterparty name matches company name (min 4 chars to avoid false positives)
        if (!targetDimension && companyName.length >= 4 && counterpartyName.length >= 4) {
          const nameMatch = counterpartyName.includes(companyName) || companyName.includes(counterpartyName);
          if (nameMatch) {
            confidence += 60;
            reasons.push("counterparty_name_matches_company");

            // Determine target: user-specified (must differ from source), or auto if only one other account exists
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

        if (confidence < 50 || !targetDimension) continue;

        // Check if this transfer is already journalized from the other side
        const existingJournalId = findExistingJournal(tx.accounts_dimensions_id, targetDimension, tx.amount, tx.date, maxGap);
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
            description: tx.description, counterparty_name: tx.bank_account_name,
            confidence: Math.min(confidence, 100), match_reasons: reasons, status: "would_confirm",
          });
        } else {
          try {
            await ensureClientsId(tx.id, tx.bank_account_name);
            await api.transactions.confirm(tx.id, [buildAccountDistribution(targetDimension, tx.amount)]);
            matchedOneSided.push({
              transaction_id: tx.id, type: tx.type, amount: tx.amount, date: tx.date,
              source_account: sourceTitle, source_dimension_id: tx.accounts_dimensions_id,
              target_account: targetTitle, target_dimension_id: targetDimension,
              description: tx.description, counterparty_name: tx.bank_account_name,
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: dryRun ? "DRY_RUN" : "EXECUTED",
            company_name: invoiceInfo.invoice_company_name,
            total_unconfirmed: unconfirmed.length,
            matched_pairs: matchedPairs.length,
            matched_one_sided: matchedOneSided.length,
            skipped_ambiguous: ambiguousPairs.length,
            skipped_already_handled: skippedAlreadyHandled.length,
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
          }, null, 2),
        }],
      };
    }
  );
}
