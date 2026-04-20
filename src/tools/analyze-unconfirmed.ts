import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice } from "../types/api.js";
import { readOnly } from "../annotations.js";
import { reportProgress } from "../progress.js";
import { isProjectTransaction } from "../transaction-status.js";
import { getInvoiceMatchEligibility, matchScore, buildInvoiceIndex, getIndexedCandidates } from "./bank-reconciliation.js";
import { normalizeCompanyName } from "../company-name.js";
import { buildBankAccountLookups } from "./inter-account-utils.js";

/** Known fee/charge patterns for expense detection */
const EXPENSE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(teenustasu|service fee|commission|tasud?)\b/i, label: "bank_fee" },
  { pattern: /\b(kaardimakse.*tasu|card.*fee|interchange)\b/i, label: "card_fee" },
  { pattern: /\b(intress|interest)\b/i, label: "interest" },
  { pattern: /\b(konto.*tasu|account.*fee|maintenance)\b/i, label: "account_fee" },
  { pattern: /\b(valuuta.*vahetuse?|currency.*exchange|fx fee)\b/i, label: "fx_fee" },
];

// Small-expense threshold in EUR. EUR-centric: foreign-currency transactions are compared
// by their nominal amount, which may differ from the EUR equivalent.
const MAX_EXPENSE_AMOUNT = 50;

interface Suggestion {
  transaction_id: number;
  date: string;
  amount: number;
  currency: string;
  description: string | null | undefined;
  bank_account_name: string | null | undefined;
  suggested_action:
    | "reimport_duplicate"
    | "likely_duplicate"
    | "confirm_invoice"
    | "confirm_inter_account"
    | "confirm_expense"
    | "manual_review";
  reason: string;
  confidence?: number;
  distribution?: { related_table: string; related_id?: number; related_sub_id?: number; amount: number };
  duplicate_journal_id?: number;
  duplicate_journal_ids?: number[];
  match_confidence?: number;
}

function buildBankJournalDuplicateKey(
  accountsDimensionsId: number,
  type: "D" | "C",
  amount: number,
  date: string,
): string {
  return `${accountsDimensionsId}|${type}|${amount}|${date}`;
}

export function registerAnalyzeUnconfirmedTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "analyze_unconfirmed_transactions",
    "Analyze all unconfirmed bank transactions and suggest actions: " +
    "duplicate detection (journal already exists), invoice matching, " +
    "inter-account transfer detection, and expense pattern recognition. " +
    "Read-only — does not modify any data.",
    {
      min_confidence: z.number().optional().describe("Minimum confidence for invoice matches 0-100 (default 40)"),
      accounts_dimensions_id: z.number().optional().describe("Filter to a specific bank account dimension ID"),
    },
    { ...readOnly, title: "Analyze Unconfirmed Transactions" },
    async ({ min_confidence, accounts_dimensions_id }) => {
      const threshold = min_confidence ?? 40;

      // Fetch all data in parallel
      const [allTx, allSales, allPurchases, bankAccounts, accountDimensions, invoiceInfo, allJournals] = await Promise.all([
        api.transactions.listAll(),
        api.saleInvoices.listAll(),
        api.purchaseInvoices.listAll(),
        api.readonly.getBankAccounts(),
        api.readonly.getAccountDimensions(),
        api.readonly.getInvoiceInfo(),
        api.journals.listAllWithPostings(),
      ]);

      // Filter unconfirmed transactions
      let unconfirmed = allTx.filter(isProjectTransaction);
      if (accounts_dimensions_id !== undefined) {
        unconfirmed = unconfirmed.filter(tx => tx.accounts_dimensions_id === accounts_dimensions_id);
      }

      // Open invoices
      const openSales = allSales.filter((inv: SaleInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );
      const openPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
      );
      const saleIndex = buildInvoiceIndex(openSales);
      const purchaseIndex = buildInvoiceIndex(openPurchases);

      const { ownIbanToDimension, dimensionToIban, dimensionToTitle, dimensionToAccountsId, ownDimensionIds } =
        buildBankAccountLookups(bankAccounts, accountDimensions);
      const companyName = normalizeCompanyName(invoiceInfo.invoice_company_name ?? "");

      // Build a broader index: journals with any posting touching a bank account dimension.
      // Key: "dimensionId|type|amount|date" -> Array of { journal_id, document_number }.
      // Storing document_number (which for TRANSACTION-type journals equals the source
      // transaction's bank_ref_number) lets us distinguish a re-import duplicate from a
      // legitimate same-day same-amount movement: the former shares the bank reference,
      // the latter doesn't.
      interface JournalMatch {
        journal_id: number;
        document_number?: string;
        operation_type?: string;
      }
      const bankJournalIndex = new Map<string, JournalMatch[]>();
      for (const j of allJournals) {
        if (j.is_deleted || !j.registered || !j.postings) continue;
        for (const p of j.postings) {
          if (p.is_deleted || !p.accounts_dimensions_id) continue;
          if (!ownDimensionIds.has(p.accounts_dimensions_id)) continue;
          if (p.type !== "D" && p.type !== "C") continue;
          const amount = Math.round(((p.base_amount ?? p.amount) as number) * 100) / 100;
          const key = buildBankJournalDuplicateKey(p.accounts_dimensions_id, p.type, amount, j.effective_date);
          const entry: JournalMatch = {
            journal_id: j.id!,
            document_number: j.document_number ?? undefined,
            operation_type: j.operation_type ?? undefined,
          };
          const existing = bankJournalIndex.get(key);
          if (existing) {
            existing.push(entry);
          } else {
            bankJournalIndex.set(key, [entry]);
          }
        }
      }

      const suggestions: Suggestion[] = [];
      const total = unconfirmed.length;

      for (let i = 0; i < unconfirmed.length; i++) {
        const tx = unconfirmed[i]!;
        await reportProgress(i, total);

        const txDim = tx.accounts_dimensions_id;
        const txType = tx.type;
        const txDuplicateAmount = Math.round(((tx.base_amount ?? tx.amount) as number) * 100) / 100;
        const bankTitle = dimensionToTitle.get(txDim) ?? `dim:${txDim}`;

        // --- 1. Duplicate detection: journal already exists for this amount/date/bank account ---
        const dupMatches =
          txType === "D" || txType === "C"
            ? bankJournalIndex.get(buildBankJournalDuplicateKey(txDim, txType, txDuplicateAmount, tx.date))
            : undefined;
        if (dupMatches && dupMatches.length > 0) {
          // A shared bank reference promotes the suggestion from "possibly a duplicate"
          // to "this is clearly a re-import of the transaction that produced this journal".
          // Without the shared reference, two same-day same-amount movements can be
          // legitimate (e.g. two separate owner loan repayments on the same day).
          const txBankRef = (tx.bank_ref_number ?? "").trim().toUpperCase();
          const bankRefMatches = txBankRef
            ? dupMatches.filter(m => (m.document_number ?? "").trim().toUpperCase() === txBankRef)
            : [];
          const dupJournalIds = dupMatches.map(m => m.journal_id);

          if (bankRefMatches.length > 0) {
            const match = bankRefMatches[0]!;
            suggestions.push({
              transaction_id: tx.id!,
              date: tx.date,
              amount: tx.amount,
              currency: tx.cl_currencies_id,
              description: tx.description,
              bank_account_name: tx.bank_account_name,
              suggested_action: "reimport_duplicate",
              confidence: 95,
              reason: `Bank reference "${tx.bank_ref_number}" already booked as journal #${match.journal_id} on ${tx.date} in ${bankTitle} — safe to delete this PROJECT row.`,
              duplicate_journal_id: match.journal_id,
              duplicate_journal_ids: dupJournalIds,
            });
            continue;
          }

          const isAmbiguous = dupMatches.length > 1;
          const confidence = isAmbiguous ? 55 : 70;
          const dupJournalId = dupMatches[0]!.journal_id;
          const ambiguitySuffix = isAmbiguous
            ? ` (${dupMatches.length} matching journals — ambiguous, verify manually)`
            : "";
          const refSuffix = txBankRef
            ? ` Existing bank reference differs — could be a legitimate same-day movement rather than a re-import.`
            : ` Current transaction has no bank_ref_number, so re-import vs legitimate duplicate cannot be distinguished automatically.`;
          suggestions.push({
            transaction_id: tx.id!,
            date: tx.date,
            amount: tx.amount,
            currency: tx.cl_currencies_id,
            description: tx.description,
            bank_account_name: tx.bank_account_name,
            suggested_action: "likely_duplicate",
            confidence,
            reason: `Journal #${dupJournalId} already exists with amount ${txDuplicateAmount} on ${tx.date} in ${bankTitle}${ambiguitySuffix}.${refSuffix}`,
            duplicate_journal_id: dupJournalId,
            duplicate_journal_ids: dupJournalIds,
          });
          continue;
        }

        // --- 2. Inter-account detection ---
        const counterpartyIban = (tx.bank_account_no ?? "").trim().toUpperCase();
        const counterpartyName = normalizeCompanyName(tx.bank_account_name ?? "");
        let isInterAccount = false;

        // Check counterparty IBAN matches own bank account
        if (counterpartyIban && ownIbanToDimension.has(counterpartyIban)) {
          const targetDim = ownIbanToDimension.get(counterpartyIban)!;
          if (targetDim !== txDim) {
            const targetTitle = dimensionToTitle.get(targetDim) ?? `dim:${targetDim}`;
            const accountsId = dimensionToAccountsId.get(targetDim);
            suggestions.push({
              transaction_id: tx.id!,
              date: tx.date,
              amount: tx.amount,
              currency: tx.cl_currencies_id,
              description: tx.description,
              bank_account_name: tx.bank_account_name,
              suggested_action: "confirm_inter_account",
              reason: `Counterparty IBAN ${counterpartyIban} matches own account "${targetTitle}"`,
              match_confidence: 90,
              ...(accountsId ? {
                distribution: {
                  related_table: "accounts",
                  related_id: accountsId,
                  related_sub_id: targetDim,
                  amount: tx.amount,
                },
              } : {}),
            });
            isInterAccount = true;
          }
        }

        // Check counterparty name matches company name
        if (!isInterAccount && companyName.length >= 4 && counterpartyName.length >= 4) {
          if (counterpartyName.includes(companyName) || companyName.includes(counterpartyName)) {
            const otherDimensions = [...dimensionToIban.keys()].filter(d => d !== txDim);
            if (otherDimensions.length === 1) {
              const targetDim = otherDimensions[0]!;
              const targetTitle = dimensionToTitle.get(targetDim) ?? `dim:${targetDim}`;
              const accountsId = dimensionToAccountsId.get(targetDim);
              suggestions.push({
                transaction_id: tx.id!,
                date: tx.date,
                amount: tx.amount,
                currency: tx.cl_currencies_id,
                description: tx.description,
                bank_account_name: tx.bank_account_name,
                suggested_action: "confirm_inter_account",
                reason: `Counterparty name "${tx.bank_account_name}" matches company name, target: "${targetTitle}"`,
                match_confidence: 80,
                ...(accountsId ? {
                  distribution: {
                    related_table: "accounts",
                    related_id: accountsId,
                    related_sub_id: targetDim,
                    amount: tx.amount,
                  },
                } : {}),
              });
              isInterAccount = true;
            } else if (otherDimensions.length > 1) {
              suggestions.push({
                transaction_id: tx.id!,
                date: tx.date,
                amount: tx.amount,
                currency: tx.cl_currencies_id,
                description: tx.description,
                bank_account_name: tx.bank_account_name,
                suggested_action: "confirm_inter_account",
                reason: `Counterparty name "${tx.bank_account_name}" matches company name, but multiple target accounts exist — specify target manually`,
                match_confidence: 60,
              });
              isInterAccount = true;
            }
          }
        }

        if (isInterAccount) continue;

        // --- 3. Invoice matching ---
        let bestInvoiceMatch: {
          type: "sale_invoice" | "purchase_invoice";
          id: number;
          number: string;
          confidence: number;
          reasons: string[];
          partiallyPaidWarning: boolean;
        } | undefined;
        const { allowSaleInvoices, allowPurchaseInvoices } = getInvoiceMatchEligibility(tx);

        if (allowSaleInvoices) {
          for (const inv of getIndexedCandidates(saleIndex, tx.ref_number, tx.amount, tx.base_amount)) {
            const { confidence, reasons, partiallyPaidWarning } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold && (!bestInvoiceMatch || confidence > bestInvoiceMatch.confidence)) {
              bestInvoiceMatch = {
                type: "sale_invoice",
                id: inv.id!,
                number: inv.number ?? `${inv.number_prefix ?? ""}${inv.number_suffix}`,
                confidence,
                reasons,
                partiallyPaidWarning,
              };
            }
          }
        }

        if (allowPurchaseInvoices) {
          for (const inv of getIndexedCandidates(purchaseIndex, tx.ref_number, tx.amount, tx.base_amount)) {
            const { confidence, reasons, partiallyPaidWarning } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold && (!bestInvoiceMatch || confidence > bestInvoiceMatch.confidence)) {
              bestInvoiceMatch = {
                type: "purchase_invoice",
                id: inv.id!,
                number: inv.number,
                confidence,
                reasons,
                partiallyPaidWarning,
              };
            }
          }
        }

        if (bestInvoiceMatch) {
          const table = bestInvoiceMatch.type === "sale_invoice" ? "sale_invoices" : "purchase_invoices";
          suggestions.push({
            transaction_id: tx.id!,
            date: tx.date,
            amount: tx.amount,
            currency: tx.cl_currencies_id,
            description: tx.description,
            bank_account_name: tx.bank_account_name,
            suggested_action: "confirm_invoice",
            reason: `Matches ${bestInvoiceMatch.type} #${bestInvoiceMatch.number} (${bestInvoiceMatch.reasons.join(", ")})${bestInvoiceMatch.partiallyPaidWarning ? " — PARTIALLY_PAID, verify remaining balance" : ""}`,
            match_confidence: bestInvoiceMatch.confidence,
            ...(!bestInvoiceMatch.partiallyPaidWarning ? {
              distribution: {
                related_table: table,
                related_id: bestInvoiceMatch.id,
                amount: tx.amount,
              },
            } : {}),
          });
          continue;
        }

        // --- 4. Expense detection ---
        const desc = (tx.description ?? "").toLowerCase();
        const absAmount = Math.abs(tx.amount);
        // Only outgoing bank transactions should be suggested as expenses.
        if (tx.type === "C" && absAmount <= MAX_EXPENSE_AMOUNT) {
          const matchedPattern = EXPENSE_PATTERNS.find(ep => ep.pattern.test(desc));
          if (matchedPattern) {
            suggestions.push({
              transaction_id: tx.id!,
              date: tx.date,
              amount: tx.amount,
              currency: tx.cl_currencies_id,
              description: tx.description,
              bank_account_name: tx.bank_account_name,
              suggested_action: "confirm_expense",
              reason: `Small ${matchedPattern.label} (${absAmount} ${tx.cl_currencies_id || "EUR"}): "${tx.description}"`,
              match_confidence: 70,
            });
            continue;
          }
        }

        // --- 5. Fallback: manual review ---
        suggestions.push({
          transaction_id: tx.id!,
          date: tx.date,
          amount: tx.amount,
          currency: tx.cl_currencies_id,
          description: tx.description,
          bank_account_name: tx.bank_account_name,
          suggested_action: "manual_review",
          reason: "No automatic match found",
        });
      }

      // Group counts by action
      const actionCounts: Record<string, number> = {};
      for (const s of suggestions) {
        actionCounts[s.suggested_action] = (actionCounts[s.suggested_action] ?? 0) + 1;
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            total_unconfirmed: unconfirmed.length,
            summary: actionCounts,
            suggestions,
          }),
        }],
      };
    }
  );
}
