import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import type { SaleInvoice, PurchaseInvoice, Transaction } from "../types/api.js";
import { readOnly } from "../annotations.js";
import { reportProgress } from "../progress.js";
import { isProjectTransaction } from "../transaction-status.js";
import { getInvoiceMatchEligibility, matchScore, buildInvoiceIndex, getIndexedCandidates } from "./bank-reconciliation.js";
import { normalizeCompanyName, sameCompanyIdentity } from "../company-name.js";
import {
  counterpartyIbanOf,
  hasUnverifiableCamtMarker,
  inferOneSidedTransfer,
  resolveWithReferences,
  transferReferencesOf,
  unverifiedMarkerTransferClaim,
  type OneSidedInference,
} from "../banking/reconciliation/inter-account-matcher.js";
import { comparableTransactionAmount, isAmbiguousForeignInvoiceBase, sameAmountToTheCent } from "../banking/reconciliation/match-score.js";
import { buildBankAccountLookups, toUtcDay } from "./inter-account-utils.js";
import { bankTransactionDirection } from "../bank-transaction-direction.js";
import { decodeInvoiceStatusCritical } from "../api/critical-codecs.js";
import { BookingGuard } from "../booking-guard.js";

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

// ±days around the transaction date searched for an already-booked journal
// (booking vs value date can differ by a day between the bank and the ledger).
// Also the Lane B window for own-account transfers — the reconcile default.
const DUPLICATE_DATE_WINDOW_DAYS = 1;
const MS_PER_DAY = 86_400_000;

function shiftDate(date: string, days: number): string {
  return new Date(toUtcDay(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

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
  candidate_invoices?: Array<{ related_table: string; related_id: number }>;
  /** Set on a review whose CAMT marker sig fails the checksum. */
  code?: "camt_marker_unverified";
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
    "Read-only analysis of unconfirmed bank transactions: duplicates, invoice matches, own-account transfers, and expense patterns.",
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

      // Open invoices — the same fail-closed decode as the reconcile paths: a
      // malformed payment_status must not let a settled invoice look open.
      const openSales = allSales.filter((inv: SaleInvoice) => {
        const critical = decodeInvoiceStatusCritical(inv);
        return critical.payment_status !== "PAID" && critical.status === "CONFIRMED";
      });
      const openPurchases = allPurchases.filter((inv: PurchaseInvoice) => {
        const critical = decodeInvoiceStatusCritical(inv);
        return critical.payment_status !== "PAID" && critical.status === "CONFIRMED";
      });
      const saleIndex = buildInvoiceIndex(openSales);
      const purchaseIndex = buildInvoiceIndex(openPurchases);

      const { ownIbanToDimension, dimensionToIban, dimensionToTitle, dimensionToAccountsId, ownDimensionIds } =
        buildBankAccountLookups(bankAccounts, accountDimensions);
      const companyLegalName = invoiceInfo.invoice_company_name ?? "";

      // reconcile_inter_account_transfers holds a transfer for review instead
      // of booking it when the target account carries a PROJECT row pointing
      // back at this account that is either a possible fee-deducted leg or an
      // equal-amount mirror without own-origin evidence (it cannot be deleted).
      // A confirm_inter_account distribution for such a row would double-book.
      const allProject = allTx.filter(isProjectTransaction);
      const inferenceLookups = {
        ownIbanToDimension, dimensionToIban, companyName: normalizeCompanyName(companyLegalName), companyLegalName,
        targetAccountsDimensionsId: undefined,
      };
      const inferenceCache = new Map<number, OneSidedInference>();
      const hasOwnOriginEvidence = (row: Transaction, sourceDim: number): boolean => {
        const iban = counterpartyIbanOf(row);
        if (iban) return ownIbanToDimension.get(iban)?.has(sourceDim) ?? false;
        return sameCompanyIdentity(row.bank_account_name, companyLegalName);
      };
      const reconcileReviewReason = (tx: Transaction, targetDim: number): string | undefined => {
        const txDirection = bankTransactionDirection(tx);
        for (const other of allProject) {
          if (other.id === tx.id || other.accounts_dimensions_id !== targetDim) continue;
          if (Math.abs(toUtcDay(tx.date) - toUtcDay(other.date)) / MS_PER_DAY > DUPLICATE_DATE_WINDOW_DAYS) continue;
          if (inferOneSidedTransfer(other, inferenceLookups, inferenceCache).targetDimension !== tx.accounts_dimensions_id) continue;
          const otherDirection = bankTransactionDirection(other);
          const directionsProven = txDirection !== "unknown" && otherDirection !== "unknown";
          if (directionsProven && txDirection === otherDirection) continue;
          const [source, mirror] = txDirection === "incoming" || otherDirection === "outgoing" ? [other, tx] : [tx, other];
          const sourceAmount = Math.abs(comparableTransactionAmount(source));
          const mirrorAmount = Math.abs(comparableTransactionAmount(mirror));
          if (sameAmountToTheCent(sourceAmount, mirrorAmount)) {
            if (hasOwnOriginEvidence(mirror, source.accounts_dimensions_id)) continue;
            return `Own-account transfer with transaction ${other.id}, but ${mirror.id} has no own-origin evidence (its counterparty IBAN is not ${source.id}'s account), so reconcile holds the pair for review; check the bank statements before confirming.`;
          }
          if (directionsProven && sourceAmount < mirrorAmount) continue;
          if (Math.abs(sourceAmount - mirrorAmount) <= Math.max(1, 0.02 * Math.max(sourceAmount, mirrorAmount))) {
            return `Possible fee-deducted transfer with transaction ${other.id} (${tx.amount} vs ${other.amount}); reconcile holds the pair for review. If they are the same transfer, book it once with the fee split; otherwise confirm each separately.`;
          }
        }
        return undefined;
      };

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

      // Lane B snapshot: an own-account transfer is only suggested for
      // confirmation when no inter-account journal already covers it.
      const guard = await BookingGuard.load(api, { ownDimensionIds });

      const suggestions: Suggestion[] = [];
      const total = unconfirmed.length;

      for (let i = 0; i < unconfirmed.length; i++) {
        const tx = unconfirmed[i]!;
        await reportProgress(i, total);

        const txDim = tx.accounts_dimensions_id;
        // The bank-posting side comes from the signed statement direction:
        // incoming debits the bank. Unsigned rows ("unknown" — the API reads
        // every type back as "C") are checked against both sides.
        const direction = bankTransactionDirection(tx);
        const postingSides: Array<"D" | "C"> =
          direction === "incoming" ? ["D"] : direction === "outgoing" ? ["C"] : ["D", "C"];
        const txDuplicateAmount = Math.round(((tx.base_amount ?? tx.amount) as number) * 100) / 100;
        const bankTitle = dimensionToTitle.get(txDim) ?? `dim:${txDim}`;

        // --- 1. Duplicate detection: journal already exists for this amount/bank account within the date window ---
        let dupMatches: JournalMatch[] | undefined;
        {
          const found: JournalMatch[] = [];
          // Exact date first, then outward, so the nearest journal leads.
          for (let offset = 0; offset <= DUPLICATE_DATE_WINDOW_DAYS; offset++) {
            const dates = offset === 0 ? [tx.date] : [shiftDate(tx.date, -offset), shiftDate(tx.date, offset)];
            for (const date of dates) {
              for (const postingSide of postingSides) {
                for (const match of bankJournalIndex.get(buildBankJournalDuplicateKey(txDim, postingSide, txDuplicateAmount, date)) ?? []) {
                  if (!found.some(existing => existing.journal_id === match.journal_id)) found.push(match);
                }
              }
            }
          }
          dupMatches = found;
        }
        if (dupMatches && dupMatches.length > 0) {
          // A shared bank reference promotes the suggestion from "possibly a duplicate"
          // to "this is clearly a re-import of the transaction that produced this journal".
          // Without the shared reference, two same-day same-amount movements can be
          // legitimate (e.g. two separate owner loan repayments on the same day).
          //
          // Only TRANSACTION-typed journals carry `document_number = bank_ref_number`.
          // For PURCHASE_INVOICE / SALE_INVOICE journals, `document_number` is the
          // invoice number — treating a coincidental "123" match as a re-import
          // would silently drop a real invoice payment.
          const txBankRef = (tx.bank_ref_number ?? "").trim().toUpperCase();
          const bankRefMatches = txBankRef
            ? dupMatches.filter(m =>
                m.operation_type === "TRANSACTION" &&
                (m.document_number ?? "").trim().toUpperCase() === txBankRef,
              )
            : [];
          const dupJournalIds = dupMatches.map(m => m.journal_id);

          if (bankRefMatches.length > 0) {
            const match = bankRefMatches[0]!;
            // Use the journal's document_number (already trimmed+uppercased in the
            // match comparison) rather than tx.bank_ref_number to avoid rendering
            // whitespace-only raw values. Still JSON.stringify to escape any hostile
            // characters in CAMT-imported references before LLM surfaces them.
            const safeRef = JSON.stringify((match.document_number ?? "").slice(0, 100));
            suggestions.push({
              transaction_id: tx.id!,
              date: tx.date,
              amount: tx.amount,
              currency: tx.cl_currencies_id,
              description: tx.description,
              bank_account_name: tx.bank_account_name,
              suggested_action: "reimport_duplicate",
              confidence: 95,
              reason: `Bank reference ${safeRef} already booked as journal #${match.journal_id} near ${tx.date} in ${bankTitle} — safe to delete this PROJECT row.`,
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
            reason: `Journal #${dupJournalId} already exists with amount ${txDuplicateAmount} within ${DUPLICATE_DATE_WINDOW_DAYS} day(s) of ${tx.date} in ${bankTitle}${ambiguitySuffix}.${refSuffix}`,
            duplicate_journal_id: dupJournalId,
            duplicate_journal_ids: dupJournalIds,
          });
          continue;
        }

        // --- 2. Inter-account detection ---
        // Before suggesting a transfer confirm, ask Lane B whether an
        // inter-account journal already covers it (e.g. the mirror leg was
        // confirmed first). Returns a replacement suggestion, or undefined.
        const alreadyBookedTransfer = (targetDim: number): Suggestion | undefined => {
          const resolution = resolveWithReferences(transferReferencesOf(tx, guard.journals), reference => guard.resolveInterAccount({
            sourceDim: txDim,
            targetDim,
            amount: txDuplicateAmount,
            date: tx.date,
            maxGapDays: DUPLICATE_DATE_WINDOW_DAYS,
            reference,
          }, { consume: false }), false);
          if (resolution.status === "none") return undefined;
          const targetTitle = dimensionToTitle.get(targetDim) ?? `dim:${targetDim}`;
          const base = {
            transaction_id: tx.id!,
            date: tx.date,
            amount: tx.amount,
            currency: tx.cl_currencies_id,
            description: tx.description,
            bank_account_name: tx.bank_account_name,
          };
          if (resolution.status === "matched") {
            return {
              ...base,
              suggested_action: "likely_duplicate",
              confidence: 70,
              reason: `Own-account transfer ${bankTitle} <-> "${targetTitle}" is already booked as journal #${resolution.journal_id} (within ${DUPLICATE_DATE_WINDOW_DAYS} day). Do not confirm; this PROJECT row is likely the mirror leg — delete it after verifying.`,
              duplicate_journal_id: resolution.journal_id,
              duplicate_journal_ids: [resolution.journal_id],
            };
          }
          return {
            ...base,
            suggested_action: "manual_review",
            reason: `A same-amount own-account transfer ${bankTitle} <-> "${targetTitle}" collides with an existing journal that its reference cannot disambiguate; verify before confirming.`,
          };
        };
        const heldForReview = (reason: string): Suggestion => ({
          transaction_id: tx.id!,
          date: tx.date,
          amount: tx.amount,
          currency: tx.cl_currencies_id,
          description: tx.description,
          bank_account_name: tx.bank_account_name,
          suggested_action: "manual_review",
          reason,
        });
        const counterpartyIban = counterpartyIbanOf(tx);
        let isInterAccount = false;

        // A CAMT marker whose sig fails the checksum has an unverifiable
        // statement identity: never suggest an inter-account confirm for it.
        const markerUnverified = hasUnverifiableCamtMarker(tx);
        if (markerUnverified && unverifiedMarkerTransferClaim(tx, inferenceLookups)) {
          suggestions.push({
            ...heldForReview("Looks like an own-account transfer, but the CAMT statement marker fails the signature check, so its statement identity (counterparty IBAN, direction) cannot be verified; check the bank statement and resolve it manually."),
            code: "camt_marker_unverified",
          });
          isInterAccount = true;
        }

        // Check counterparty IBAN matches own bank account
        // One IBAN can back several own accounts (LHV multi-currency).
        const ibanTargets = !markerUnverified && counterpartyIban && ownIbanToDimension.has(counterpartyIban)
          ? [...ownIbanToDimension.get(counterpartyIban)!].filter(d => d !== txDim)
          : [];
        if (ibanTargets.length > 1) {
          suggestions.push({
            transaction_id: tx.id!,
            date: tx.date,
            amount: tx.amount,
            currency: tx.cl_currencies_id,
            description: tx.description,
            bank_account_name: tx.bank_account_name,
            suggested_action: "confirm_inter_account",
            reason: `Counterparty IBAN ${counterpartyIban} belongs to several own accounts — specify target manually`,
            match_confidence: 60,
          });
          isInterAccount = true;
        } else if (ibanTargets.length === 1) {
          const targetDim = ibanTargets[0]!;
          const booked = alreadyBookedTransfer(targetDim);
          const heldReason = booked ? undefined : reconcileReviewReason(tx, targetDim);
          if (booked) {
            suggestions.push(booked);
            isInterAccount = true;
          } else if (heldReason) {
            suggestions.push(heldForReview(heldReason));
            isInterAccount = true;
          } else {
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
                  amount: txDuplicateAmount,
                },
              } : {}),
            });
            isInterAccount = true;
          }
        }

        // Check counterparty name matches company name
        // Same name AND legal form, as reconcile's one-sided inference requires.
        if (!isInterAccount && !markerUnverified) {
          if (sameCompanyIdentity(tx.bank_account_name, companyLegalName)) {
            const otherDimensions = [...dimensionToIban.keys()].filter(d => d !== txDim);
            const booked = otherDimensions.length === 1 ? alreadyBookedTransfer(otherDimensions[0]!) : undefined;
            const heldReason = !booked && otherDimensions.length === 1 ? reconcileReviewReason(tx, otherDimensions[0]!) : undefined;
            if (booked) {
              suggestions.push(booked);
              isInterAccount = true;
            } else if (heldReason) {
              suggestions.push(heldForReview(heldReason));
              isInterAccount = true;
            } else if (otherDimensions.length === 1) {
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
                reason: `Counterparty name ${wrapUntrustedOcr(tx.bank_account_name ?? undefined)} matches company name, target: "${targetTitle}"`,
                match_confidence: 80,
                ...(accountsId ? {
                  distribution: {
                    related_table: "accounts",
                    related_id: accountsId,
                    related_sub_id: targetDim,
                    amount: txDuplicateAmount,
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
                reason: `Counterparty name ${wrapUntrustedOcr(tx.bank_account_name ?? undefined)} matches company name, but multiple target accounts exist — specify target manually`,
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
        // Every candidate at or above the threshold, for the Tier A tie check.
        const invoiceCandidates: Array<{ table: "sale_invoices" | "purchase_invoices"; id: number; confidence: number; reasons: string[] }> = [];
        const { allowSaleInvoices, allowPurchaseInvoices } = getInvoiceMatchEligibility(tx);

        if (allowSaleInvoices) {
          for (const inv of getIndexedCandidates(saleIndex, tx.ref_number, tx.amount, tx.base_amount)) {
            const { confidence, reasons, partiallyPaidWarning } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold) invoiceCandidates.push({ table: "sale_invoices", id: inv.id!, confidence, reasons });
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
            if (confidence >= threshold) invoiceCandidates.push({ table: "purchase_invoices", id: inv.id!, confidence, reasons });
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

        if (bestInvoiceMatch && isAmbiguousForeignInvoiceBase(invoiceCandidates)) {
          suggestions.push({
            transaction_id: tx.id!,
            date: tx.date,
            amount: tx.amount,
            currency: tx.cl_currencies_id,
            description: tx.description,
            bank_account_name: tx.bank_account_name,
            suggested_action: "manual_review",
            reason: `ambiguous_foreign_invoice_base: ${invoiceCandidates.length} open invoices compete on a foreign-currency invoice base amount; pick the invoice manually.`,
            candidate_invoices: invoiceCandidates.map(c => ({ related_table: c.table, related_id: c.id })),
          });
          continue;
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
            // bestInvoiceMatch.number is OCR-seeded for purchase invoices
            // (supplier receipt → create_purchase_invoice_from_pdf). Wrap it
            // inline in the reason prose so the LLM sees the number sandboxed
            // even though the surrounding prose is developer-controlled.
            reason: `Matches ${bestInvoiceMatch.type} #${wrapUntrustedOcr(bestInvoiceMatch.number) ?? ""} (${bestInvoiceMatch.reasons.join(", ")})${bestInvoiceMatch.partiallyPaidWarning ? " — PARTIALLY_PAID, verify remaining balance" : ""}`,
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
        if (bankTransactionDirection(tx) === "outgoing" && absAmount <= MAX_EXPENSE_AMOUNT) {
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
              reason: `Small ${matchedPattern.label} (${absAmount} ${tx.cl_currencies_id || "EUR"}): ${wrapUntrustedOcr(tx.description ?? undefined)}`,
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

      // description + bank_account_name are CAMT/Wise-origin text. Wrap at
      // the MCP boundary so counterparty-controlled bytes reach the LLM
      // sandboxed. In-memory suggestions[] keeps the plain strings so any
      // internal logic continues to see the raw values.
      const sanitizedSuggestions = suggestions.map(s => ({
        ...s,
        description: wrapUntrustedOcr(s.description ?? undefined),
        bank_account_name: wrapUntrustedOcr(s.bank_account_name ?? undefined),
      }));

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            total_unconfirmed: unconfirmed.length,
            summary: actionCounts,
            suggestions: sanitizedSuggestions,
          }),
        }],
      };
    }
  );
}
