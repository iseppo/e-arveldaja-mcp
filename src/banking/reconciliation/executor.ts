import type { ApiContext } from "../../tools/crud/shared.js";
import { snapshotBankTransaction, compareBankTransactionMaterial, changedLinkedInvoiceFields, TransactionMaterialDriftError } from "../transaction-material-snapshot.js";
import { findRegistrationJournal } from "../receipt-ledger-check.js";
import { confirmedDistributionEvidence } from "./confirmed-transfer-proof.js";
import { positiveEurAmount } from "../eur-amount-proof.js";
import type { Transaction, SaleInvoice, PurchaseInvoice } from "../../types/api.js";
import { isProjectTransaction } from "../../transaction-status.js";
import { roundMoney } from "../../money.js";
import { normalizeCompanyName, sameCompanyIdentity } from "../../company-name.js";
import { bankPostingSideForInvoiceMatch, bankTransactionDirection, signedBankTransactionDirection } from "../../bank-transaction-direction.js";
import { decodeInvoiceStatusCritical } from "../../api/critical-codecs.js";
import { logAudit } from "../../audit-log.js";
import { reportProgress } from "../../progress.js";
import { MutationIndeterminateError } from "../../mutation-outcome.js";
import {
  LinkedInvoiceClientMismatchError,
  LinkedInvoiceClientsAmbiguousError,
} from "../../api/transactions.api.js";
import { PlanStoreError, type PlanRecord } from "../../plan-store.js";
import { isRecord } from "../../record-utils.js";
import { BookingGuard } from "../../booking-guard.js";
import type { RuntimeSafetyContext } from "../../runtime-safety-context.js";
import { buildBankAccountLookups, normalizeReference } from "../../tools/inter-account-utils.js";
import { toUtcDay } from "../../date-utils.js";
import {
  annotateDistinctSourceReferences,
  findDuplicateBankPostings,
  resolveBankDimensionsSafe,
  transactionSourceReferenceIdentity,
  type DuplicatePostingCandidate,
  type DuplicatePostingScanResult,
  type DuplicatePostingSuspect,
} from "../../bank-posting-duplicate-guard.js";
import {
  BANK_RECONCILIATION_PLAN_DOMAIN,
  buildReconciliationExecutionPlanInput,
  canonicalPlanJson,
  executeReconciliationCommands,
  reconClientUpdateCommandId,
  reconInvoiceConfirmCommandId,
  reconTransferConfirmCommandId,
  reconDeleteDuplicateCommandId,
  RECON_CONFIRM_INVOICE_CATEGORY,
  RECON_CONFIRM_TRANSFER_CATEGORY,
  RECON_DELETE_DUPLICATE_CATEGORY,
  RECON_UPDATE_CLIENT_CATEGORY,
  stripUndefinedDeep,
  type ReconciliationExecutionCommand,
} from "../../tools/bank-reconciliation-plan.js";
import { buildInvoiceIndex, getIndexedCandidates } from "./invoice-index.js";
import { legacyTruncatedCamtMarkerHint } from "../../camt/duplicate-identity.js";
import { matchScore, getInvoiceMatchEligibility, buildSuggestedDistribution, comparableTransactionAmount, sameAmountToTheCent, isAmbiguousForeignInvoiceBase, type MatchCandidate } from "./match-score.js";
import { hasMeaningfulComparableAmount, resolveOneSidedTransferAmount, transactionCurrency } from "./amount-resolution.js";
import {
  counterpartyIbanOf,
  COUNTERPARTY_IBAN_NOT_REGISTERED,
  ONE_SIDED_MIN_CONFIDENCE,
  hasUnverifiableCamtMarker,
  inferOneSidedTransfer,
  isCamtCounterpartyIbanOmitted,
  resolveTransfer,
  resolveWithReferences,
  transferReferenceOf,
  transferReferencesOf,
  unverifiedMarkerTransferClaim,
  getTransferPairCompatibility,
  camtInstructionIdOf,
  wiseReferenceInstructionIdOf,
  getSameTypeReciprocalEvidence,
  hasMirrorOwnOriginEvidence,
  type InterAccountMatchLookups,
  type OneSidedInference,
  type TransferResolution,
} from "./inter-account-matcher.js";
import { computeExactMatchProjection, EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE } from "./duplicate-policy.js";
import {
  checkReceiptLedger,
  invoiceLinksFromTransaction,
  type LinkedReceiptInvoice,
} from "../receipt-ledger-check.js";
import {
  exactMatchFingerprint,
  buildInterAccountPlanCommandProjections,
  interAccountFingerprint,
} from "./projection.js";
import { exactMatchReviewCommands } from "./presenter.js";
import type { PlanExecutionReport } from "../../plan-execution.js";
import type {
  BlockedDuplicateSuspect,
  ExactConfirmExecution,
  ExactConfirmExecutionInput,
  ExactConfirmInput,
  ExactConfirmLedgerCheckFailure,
  ExactConfirmLedgerChecks,
  ExactConfirmPreview,
  ExactMatchProjection,
  InterAccountConfirmAction,
  InterAccountExecution,
  InterAccountExecutionInput,
  InterAccountInput,
  InterAccountMatchResult,
  InterAccountPreview,
  PairResult,
  AmbiguousPairResult,
  OneSidedResult,
  ReconciliationSuggestions,
  SuggestMatchRow,
  SkippedAlreadyHandledRow,
  AmbiguousReflessRow,
  CrossCurrencyRow,
  InterAccountErrorRow,
  SuggestMatchesInput,
} from "./types.js";

/**
 * Error code for a non-indeterminate confirm failure. The api's pre-mutation
 * refusals (payer/invoice client mismatch, ambiguous linked-invoice clients)
 * carry their own
 * category so the report says why the register was refused, not a generic
 * `confirm_failed`.
 */
function confirmRefusalErrorCode(err: unknown): string {
  if (err instanceof TransactionMaterialDriftError) return err.category;
  if (err instanceof LinkedInvoiceClientMismatchError
    || err instanceof LinkedInvoiceClientsAmbiguousError) {
    return err.category;
  }
  return "confirm_failed";
}

export const MAX_INTER_ACCOUNT_DATE_GAP_DAYS = 31;

// ---------------------------------------------------------------------------
// I/O ORCHESTRATION. Every api read/write, audit, plan issue/consume, duplicate
// scan, and progress report lives here; the byte-stable digests and pure
// matching helpers are imported. Rich failures (dynamic plan-store code, drift
// detail) THROW a typed carrier; the simple plan_handle_required kind returns a
// discriminated failure the operations layer reprojects to OperationOutcome.error.
// ---------------------------------------------------------------------------

export type ReconFailure =
  | { kind: "plan_handle_required"; category: string; message: string }
  | { kind: "plan_store_error"; category: string; message: string }
  | { kind: "plan_drift"; category: string; message: string };

export type ReconExecResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: ReconFailure };

/**
 * Thrown for failure kinds whose byte-exact MCP envelope carries data beyond a
 * fixed discriminant (the real plan-store error code + message, the specific
 * plan-drift detail). Mirrors WiseOperationFailedError / CamtPreflightRejectedError.
 */
export class ReconciliationOperationFailedError extends Error {
  constructor(readonly failure: ReconFailure) {
    super("Bank reconciliation operation failed");
    this.name = "ReconciliationOperationFailedError";
  }
}

function validateInterAccountDateGap(maxDateGap: number | undefined): number {
  const value = maxDateGap ?? 1;
  if (!Number.isInteger(value) || value < 0 || value > MAX_INTER_ACCOUNT_DATE_GAP_DAYS) {
    throw new Error(`max_date_gap must be an integer between 0 and ${MAX_INTER_ACCOUNT_DATE_GAP_DAYS}.`);
  }
  return value;
}

// === Suggest =================================================================

export async function runSuggestMatches(
  api: ApiContext,
  input: SuggestMatchesInput,
): Promise<ReconciliationSuggestions> {
  const threshold = input.minConfidence ?? 50;
  const block_on_duplicate = input.blockOnDuplicate;

  // Get all unconfirmed transactions
  const allTx = await api.transactions.listAll();
  const unconfirmed = allTx.filter(isProjectTransaction);

  // Get unpaid invoices (including partially paid)
  const allSales = await api.saleInvoices.listAll();
  const openSales = allSales.filter((inv: SaleInvoice) => {
    const critical = decodeInvoiceStatusCritical(inv);
    return critical.payment_status !== "PAID" && critical.status === "CONFIRMED";
  });

  const allPurchases = await api.purchaseInvoices.listAll();
  const openPurchases = allPurchases.filter((inv: PurchaseInvoice) => {
    const critical = decodeInvoiceStatusCritical(inv);
    return critical.payment_status !== "PAID" && critical.status === "CONFIRMED";
  });

  const saleIndex = buildInvoiceIndex(openSales);
  const purchaseIndex = buildInvoiceIndex(openPurchases);
  // Cross-mechanism duplicate guard (Task 3): resolve bank dimensions once so
  // each matched row can be checked against already-booked cash movements.
  const suggestBankDimsResult = await resolveBankDimensionsSafe(api);
  const suggestDimById = new Map(suggestBankDimsResult.dimensions.map(d => [d.dimensionId, d]));
  const results: SuggestMatchRow[] = [];
  // Compact-only aggregates (guided surface). The FULL envelope ignores these,
  // so standard/full output stays byte-identical.
  const matchedTotalsByCurrency: Record<string, number> = {};
  const matchedAccountIds = new Set<number>();
  let matchedDateFrom: string | undefined;
  let matchedDateTo: string | undefined;

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
      const crossCurrency =
        (bestMatch.match_reasons.includes("exact_base_amount") ||
          bestMatch.match_reasons.includes("cross_currency_conflict")) &&
        !bestMatch.match_reasons.includes("exact_amount");
      const ambiguousForeignBase = isAmbiguousForeignInvoiceBase(
        candidates.map(c => ({ confidence: c.confidence, reasons: c.match_reasons })),
      );
      const distribution = crossCurrency || ambiguousForeignBase
        ? undefined
        : buildSuggestedDistribution(
            bestMatch.type,
            bestMatch.id,
            tx.amount,
            bestMatch.partially_paid_warning,
          );
      // Cross-mechanism duplicate guard (Task 3): read-only annotation.
      const suggestDim = suggestDimById.get(tx.accounts_dimensions_id);
      let possibleDuplicatePostings: DuplicatePostingSuspect[] | undefined;
      if (suggestDim && tx.date) {
        const scan = await annotateDistinctSourceReferences(
          await findDuplicateBankPostings(api, {
            accountId: suggestDim.accountId,
            dimensionId: suggestDim.dimensionId,
            amount: tx.base_amount ?? tx.amount,
            direction: bankPostingSideForInvoiceMatch(tx, bestMatch.type),
            date: tx.date,
          }),
          () => transactionSourceReferenceIdentity(tx),
          async () => allTx,
        );
        if (scan.scan_available && scan.suspects.length > 0) {
          possibleDuplicatePostings = scan.suspects;
        }
      }
      // Every reason this row needs a human before it is confirmed. They are
      // joined into the ONE manual_review_required field rather than each
      // assignment overwriting the last, so a row carrying several problems
      // (a third-party payer on a partially-paid invoice) reports all of them.
      const manualReviewNotes: string[] = [];
      if (tx.clients_id != null && bestMatch.clients_id != null && bestMatch.clients_id !== tx.clients_id) {
        manualReviewNotes.push(
          `Payer client ${tx.clients_id} differs from the matched ${bestMatch.type}'s client ${bestMatch.clients_id}; `
          + "confirming as-is files the receipt in the payer's sub-ledger. "
          + "Confirm with reassign_client_to_invoice: true or match manually.");
      }
      if (bestMatch.partially_paid_warning) {
        manualReviewNotes.push("Invoice is PARTIALLY_PAID; verify the remaining open balance before confirming.");
      }
      if (ambiguousForeignBase) {
        manualReviewNotes.push(
          `ambiguous_foreign_invoice_base: ${candidates.map(c => `${c.type} #${c.id}`).join(", ")} `
          + "compete on a foreign-currency invoice base amount; pick the invoice manually.");
      }
      if (crossCurrency) {
        manualReviewNotes.push("Cross-currency match: tx amount is in a different currency than the invoice gross. Compute the correct distribution amount manually before confirming.");
      }
      // RAW domain strings — the presenter is the sole sandbox site and wraps
      // every free-text field (description/bank_account_name/ref_number,
      // best_match.number/client_name/ref_number, possible_duplicate_postings)
      // in renderSuggestPayload (full) or renderSuggestCompact (compact).
      results.push({
        transaction_id: tx.id,
        date: tx.date,
        amount: tx.amount,
        description: tx.description ?? undefined,
        bank_account_name: tx.bank_account_name ?? undefined,
        ref_number: tx.ref_number ?? undefined,
        best_match: {
          type: bestMatch.type,
          id: bestMatch.id,
          number: bestMatch.number,
          client_name: bestMatch.client_name,
          clients_id: bestMatch.clients_id,
          gross_price: bestMatch.gross_price,
          payment_status: bestMatch.payment_status,
          partially_paid_warning: bestMatch.partially_paid_warning,
          ref_number: bestMatch.ref_number ?? undefined,
          confidence: bestMatch.confidence,
          match_reasons: bestMatch.match_reasons,
        },
        other_candidate_count: candidates.length - 1,
        ...(distribution ? { distribution } : {}),
        ...(possibleDuplicatePostings
          ? { possible_duplicate_postings: possibleDuplicatePostings }
          : {}),
        ...(possibleDuplicatePostings && block_on_duplicate === true
          ? { duplicate_blocked: true }
          : {}),
        ...(manualReviewNotes.length > 0
          ? { manual_review_required: manualReviewNotes.join(" ") }
          : {}),
      });
      const matchCurrency = transactionCurrency(tx);
      matchedTotalsByCurrency[matchCurrency] = roundMoney((matchedTotalsByCurrency[matchCurrency] ?? 0) + tx.amount);
      if (tx.accounts_dimensions_id != null) matchedAccountIds.add(tx.accounts_dimensions_id);
      if (tx.date) {
        if (matchedDateFrom === undefined || tx.date < matchedDateFrom) matchedDateFrom = tx.date;
        if (matchedDateTo === undefined || tx.date > matchedDateTo) matchedDateTo = tx.date;
      }
    }
  }

  return {
    totalUnconfirmed: unconfirmed.length,
    matched: results.length,
    unmatched: unconfirmed.length - results.length,
    matches: results,
    ...(suggestBankDimsResult.scanAvailable ? {} : { duplicateScanNote: suggestBankDimsResult.scanNote }),
    compact: {
      matchedTotalsByCurrency,
      accountLabels: [...matchedAccountIds].map(String),
      ...(matchedDateFrom !== undefined ? { dateFrom: matchedDateFrom } : {}),
      ...(matchedDateTo !== undefined ? { dateTo: matchedDateTo } : {}),
    },
  };
}

// === Exact-match confirm =====================================================

/** Lists identify work; only pending or unclassified rows need detail reads. */
async function loadPendingTransactions(api: ApiContext, listed: Transaction[]): Promise<Transaction[]> {
  const candidates = listed.filter(tx => !tx.is_deleted && tx.status !== "CONFIRMED" && tx.status !== "VOID");
  const detailed = await Promise.all(candidates.map(async tx => {
    const row = await api.transactions.get(tx.id!);
    if (!row || typeof row.status !== "string" || !["PROJECT", "CONFIRMED", "VOID"].includes(row.status)) {
      throw new Error(`Transaction ${tx.id} has an unresolved status; pending bank work cannot be determined.`);
    }
    return row;
  }));
  return detailed.filter(isProjectTransaction);
}

/**
 * Cross-mechanism duplicate guard for the exact-match confirm flow (Task 3).
 * Runs identically in the dry-run and execute paths so the re-derived execute
 * projection matches the reviewed plan fingerprint.
 */
async function enrichExactMatchProjectionWithDuplicateGuard(
  api: ApiContext,
  projection: ExactMatchProjection,
  blockOnDuplicate: boolean,
  allTransactions: readonly Transaction[],
  pendingTransactions: readonly Transaction[],
): Promise<void> {
  if (projection.confirms.length === 0) return;

  const bankDimsResult = await resolveBankDimensionsSafe(api);
  if (!bankDimsResult.scanAvailable) {
    projection.duplicateScanNote ??= bankDimsResult.scanNote;
    return;
  }
  const dimById = new Map(bankDimsResult.dimensions.map(d => [d.dimensionId, d]));

  const surviving = [];
  const blocked: BlockedDuplicateSuspect[] = [];
  // RAW scan inputs for the POSSIBLE-duplicate warning lines. The presenter is
  // the sole sandbox site: it formats these with wrapUntrustedOcr on the
  // untrusted journal title. Stored raw so the executor never sandboxes.
  const warningInputs: Array<{ scan: DuplicatePostingScanResult; candidate: DuplicatePostingCandidate }> = [];

  for (const descriptor of projection.confirms) {
    const dim = descriptor.accountsDimensionsId != null ? dimById.get(descriptor.accountsDimensionsId) : undefined;
    if (!dim || descriptor.date == null) {
      surviving.push(descriptor);
      continue;
    }

    const candidate: DuplicatePostingCandidate = {
      accountId: dim.accountId,
      dimensionId: dim.dimensionId,
      amount: descriptor.baseAmount,
      direction: descriptor.direction,
      date: descriptor.date,
    };
    // The source-reference annotation is advisory: it never changes which
    // suspects block, and the plan fingerprint binds only their journal ids.
    const scan = await annotateDistinctSourceReferences(
      await findDuplicateBankPostings(api, candidate),
      () => {
        const transaction = pendingTransactions.find(tx => tx.id === descriptor.transactionId);
        return transaction ? transactionSourceReferenceIdentity(transaction) : undefined;
      },
      async () => allTransactions,
    );

    if (!scan.scan_available) {
      projection.duplicateScanNote ??= scan.scan_note;
      warningInputs.push({ scan, candidate });
      surviving.push(descriptor);
      continue;
    }

    if (scan.suspects.length > 0) {
      descriptor.possibleDuplicatePostings = scan.suspects;
      warningInputs.push({ scan, candidate });
      if (blockOnDuplicate) {
        blocked.push({
          transaction_id: descriptor.transactionId,
          reason: `Possible cross-mechanism duplicate: an already-booked same-key cash movement exists (journal(s) ${scan.suspects.map(s => s.journal_id).join(", ")}). Blocked from auto-confirm; verify before booking.`,
          conflicting_journal_ids: scan.suspects.map(s => s.journal_id),
          suspects: scan.suspects,
        });
        continue;
      }
    }
    surviving.push(descriptor);
  }

  projection.confirms = surviving;
  projection.blockedDuplicateSuspects = blocked;
  if (warningInputs.length > 0) projection.duplicateWarningInputs = warningInputs;
}

function issueExactMatchPlan(
  runtimeSafetyContext: RuntimeSafetyContext,
  projection: ExactMatchProjection,
  threshold: number,
): string {
  const planInput = buildReconciliationExecutionPlanInput({
    normalizedArgs: stripUndefinedDeep({ min_confidence: threshold }) as PlanRecord,
    sourceIdentities: [],
    liveSnapshot: { kind: "exact_match_confirm" },
    reviewCommands: exactMatchReviewCommands(projection),
    fingerprint: exactMatchFingerprint(projection, threshold),
    counts: {
      total_unconfirmed: projection.totalUnconfirmed,
      would_confirm: projection.confirms.length,
      skipped: projection.skipped.length,
      third_party_payer_reviews: projection.thirdPartyPayerReviews.length,
    },
    totals: {},
    exclusions: projection.skipped.map(row => stripUndefinedDeep({ transaction_id: row.transaction_id, reason: row.reason })),
    reviews: projection.thirdPartyPayerReviews.map(row => stripUndefinedDeep({ ...row })),
  });
  return runtimeSafetyContext.planStore.issue(BANK_RECONCILIATION_PLAN_DOMAIN, planInput);
}

function buildExactMatchCommands(api: ApiContext, projection: ExactMatchProjection): ReconciliationExecutionCommand[] {
  const commands: ReconciliationExecutionCommand[] = [];
  for (const descriptor of projection.confirms) {
    let clientWritten = false;
    const checkMaterial = async (fresh: Transaction) => {
      if (!descriptor.transactionMaterial || !descriptor.invoiceMaterial) return false;
      const comparison = compareBankTransactionMaterial(descriptor.transactionMaterial, fresh,
        clientWritten && descriptor.invoiceClientsId != null ? { client: {from: descriptor.clientsId, to: descriptor.invoiceClientsId} } : {});
      if (!comparison.ok) return false;
      const resource = descriptor.invoiceTable === "sale_invoices" ? api.saleInvoices : api.purchaseInvoices;
      resource.invalidateListCache();
      const invoice = await resource.get(descriptor.invoiceId);
      if (changedLinkedInvoiceFields(descriptor.invoiceMaterial, invoice).length) return false;
      api.transactions.invalidateListCache();
      const finalTx=await api.transactions.get(descriptor.transactionId);
      return compareBankTransactionMaterial(descriptor.transactionMaterial, finalTx,
        clientWritten && descriptor.invoiceClientsId != null ? {client:{from:descriptor.clientsId,to:descriptor.invoiceClientsId}} : {}).ok;
    };
    if (descriptor.needsClientUpdate) {
      commands.push({
        id: reconClientUpdateCommandId(descriptor.transactionId),
        category: RECON_UPDATE_CLIENT_CATEGORY,
        prepare: async () => {
          api.transactions.invalidateListCache(); // uncached: gates the mutation below
          const fresh = await api.transactions.get(descriptor.transactionId);
          if (!(await checkMaterial(fresh))) return {outcome: "drift", error_code: "transaction_material_drift"};
          if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "transaction_not_project" };
          if (fresh.clients_id != null) return { outcome: "drift", error_code: "client_already_set" };
          return { outcome: "ready" };
        },
        mutate: async () => {
          try {
            await api.transactions.update(descriptor.transactionId, { clients_id: descriptor.invoiceClientsId ?? undefined });
            clientWritten = true;
            return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: descriptor.transactionId, outcome: "updated" }] };
          } catch (err) {
            if (err instanceof MutationIndeterminateError) return { outcome: "indeterminate", error_code: "mutation_outcome_unknown" };
            return { outcome: "failed", error_code: "client_update_failed", mutation_occurred: false };
          }
        },
      });
    }
    commands.push({
      id: reconInvoiceConfirmCommandId(descriptor.transactionId),
      category: RECON_CONFIRM_INVOICE_CATEGORY,
      prepare: async () => {
        api.transactions.invalidateListCache(); // uncached: gates the mutation below
        const fresh = await api.transactions.get(descriptor.transactionId);
        if (!(await checkMaterial(fresh))) return {outcome: "drift", error_code: "transaction_material_drift"};
        if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "transaction_not_project" };
        if (roundMoney(fresh.amount) !== roundMoney(descriptor.amount)) return { outcome: "drift", error_code: "amount_changed" };
        if (transactionCurrency(fresh) !== descriptor.currency) return { outcome: "drift", error_code: "currency_changed" };
        if (!descriptor.needsClientUpdate && (fresh.clients_id ?? null) !== descriptor.clientsId) {
          return { outcome: "drift", error_code: "client_changed" };
        }
        return { outcome: "ready" };
      },
      mutate: async () => {
        try {
          await api.transactions.confirm(
            descriptor.transactionId,
            [{ related_table: descriptor.invoiceTable, related_id: descriptor.invoiceId, amount: descriptor.amount }],
            { autoFixClientsId: false,
              expectedTransaction: descriptor.transactionMaterial && {...descriptor.transactionMaterial, clients_id: clientWritten ? descriptor.invoiceClientsId : descriptor.clientsId},
              expectedLinkedInvoices: descriptor.invoiceMaterial ? {[`${descriptor.invoiceTable}:${descriptor.invoiceId}`]: descriptor.invoiceMaterial} : {},
            },
          );
          logAudit({
            tool: "auto_confirm_exact_matches", action: "CONFIRMED", entity_type: "transaction",
            entity_id: descriptor.transactionId,
            summary: `Confirmed transaction ${descriptor.transactionId} against ${descriptor.invoiceType} #${descriptor.invoiceId} (${descriptor.invoiceNumber})`,
            details: { amount: descriptor.amount, distributions: [{ related_table: descriptor.invoiceTable, related_id: descriptor.invoiceId, amount: descriptor.amount }] },
          });
          return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: descriptor.transactionId, outcome: "confirmed" }] };
        } catch (err) {
          if (err instanceof TransactionMaterialDriftError) return {outcome: "failed", error_code: err.category, mutation_occurred: err.mutation_occurred, known_objects: err.known_objects};
          if (err instanceof MutationIndeterminateError) return { outcome: "indeterminate", error_code: "mutation_outcome_unknown" };
          // A differing payer leaves `confirms` as a third-party-payer review,
          // so the api guard should never fire here. Mapped anyway: if the
          // ledger changed between projection and mutate, the reason the
          // register was refused must reach the report, not a generic failure.
          return { outcome: "failed", error_code: confirmRefusalErrorCode(err), mutation_occurred: false };
        }
      },
    });
  }
  return commands;
}

/**
 * Post-confirm receipt-ledger invariant for the exact-match batch (section D).
 *
 * The register call returns no journal id and copies `journal.clients_id` from
 * the TRANSACTION, so a confirm that "succeeded" can still have filed the
 * receivable/payable leg under the wrong client. This runs ONE journals read
 * after every command has executed (`transactions.confirm` already invalidates
 * the `/journals` cache, so the read is fresh) and asserts the invariant for
 * each transaction that actually completed its confirm.
 *
 * Fail-safe: the confirms are already committed, so a ledger read that throws
 * becomes a warning, never a failure of the batch.
 */
async function runPostConfirmLedgerChecks(
  api: ApiContext,
  projection: ExactMatchProjection,
  executionReport: PlanExecutionReport,
): Promise<ExactConfirmLedgerChecks> {
  const completedIds = new Set(executionReport.command_partitions.completed.map(item => item.command_id));
  const confirmed = projection.confirms.filter(
    descriptor => completedIds.has(reconInvoiceConfirmCommandId(descriptor.transactionId)));
  if (confirmed.length === 0) return { checked: 0, ok: 0, failures: [] };

  const failures: ExactConfirmLedgerCheckFailure[] = [];
  const unverified: NonNullable<ExactConfirmLedgerChecks["unverified"]> = [];
  // No cause text is carried on any of these warnings: an upstream body would
  // be untrusted here, and the presenter is the only module allowed to sandbox.
  const warnings: string[] = [];
  let checked = 0;
  let ok = 0;

  let journals;
  try {
    journals = await api.journals.listAllWithPostings();
  } catch {
    return {
      checked: 0,
      ok: 0,
      failures: [],
      warnings: ["Post-confirm receipt-ledger verification could not be completed because the ledger read failed. "
        + "The confirmations above are done; verify the registration journals with list_journals."],
    };
  }

  for (const descriptor of confirmed) {
    // Scoped per transaction: one unreadable invoice must not cancel the
    // verification of every other confirm in the batch.
    try {
      const tx = await api.transactions.get(descriptor.transactionId);
      // The confirmed transaction's own items are what the ledger recorded. A
      // transaction that carries no invoice link has no invoice client to
      // compare against, so there is nothing to assert.
      const links = invoiceLinksFromTransaction(tx);
      if (links.length === 0) {
        checked += 1;
        const journal = findRegistrationJournal(journals, descriptor.transactionId);
        unverified.push({transaction_id: descriptor.transactionId, ...(journal.length === 1 && journal[0]!.id != null ? {journal_id:journal[0]!.id} : {}), reasons:["invoice_leg: confirmed GET has no invoice distribution evidence"]});
        continue;
      }
      // Counted from here on: this transaction has an invoice leg, so its check
      // was attempted whether or not the reads below succeed.
      checked += 1;
      if (descriptor.transactionMaterial) {
        const actual=snapshotBankTransaction(tx);
        const identity=(row: typeof actual) => {const {items,status,clients_id,...rest}=row;return rest;};
        if (tx.status!=="CONFIRMED" || actual.clients_id!==descriptor.invoiceClientsId || canonicalPlanJson(identity(actual))!==canonicalPlanJson(identity(descriptor.transactionMaterial))) {
          const journal=findRegistrationJournal(journals,descriptor.transactionId);
          const journalId=journal.length===1?journal[0]!.id:undefined;
          failures.push({transaction_id:descriptor.transactionId,...(journalId!=null?{journal_id:journalId}:{}),code:"ledger_posting_mismatch",details:{transaction_id:descriptor.transactionId,transaction_clients_id:actual.clients_id,invoice_clients_id:descriptor.invoiceClientsId,invoice_table:descriptor.invoiceTable,invoice_id:descriptor.invoiceId,...(journalId!=null?{journal_id:journalId}:{}),leg:"reviewed_source",expected_type:descriptor.direction,expectation_source:"reviewed_material"}});
          continue;
        }
      }
      const invoices: LinkedReceiptInvoice[] = [];
      for (const link of links) {
        if (link.table === "sale_invoices") {
          const invoice = await api.saleInvoices.get(link.id);
          invoices.push({
            table: "sale_invoices",
            id: link.id,
            amount: link.amount,
            clients_id: invoice?.clients_id ?? null,
            ledger_accounts_id: invoice?.receivable_accounts_id ?? null,
            gross_price: invoice.gross_price, sale_invoice_type: invoice.sale_invoice_type, credit_sale_invoices_id: invoice.credit_sale_invoices_id,
            paid_in_cash: invoice.paid_in_cash,
          });
        } else {
          const invoice = await api.purchaseInvoices.get(link.id);
          invoices.push({
            table: "purchase_invoices",
            id: link.id,
            amount: link.amount,
            clients_id: invoice?.clients_id ?? null,
            ledger_accounts_id: invoice?.liability_accounts_id ?? null,
            gross_price: invoice.gross_price,
            paid_in_cash: invoice.paid_in_cash,
          });
        }
      }

      const result = checkReceiptLedger({ tx, invoices, journals });
      if (result.ok) {
        if (result.unverified?.length) unverified.push({transaction_id: descriptor.transactionId, journal_id: result.journal_id, reasons: result.unverified});
        else ok += 1;
        continue;
      }
      failures.push({
        transaction_id: descriptor.transactionId,
        ...(typeof result.details.journal_id === "number" ? { journal_id: result.details.journal_id } : {}),
        code: result.code,
        details: result.details,
      });
      logAudit({
        tool: "auto_confirm_exact_matches",
        action: "LEDGER_CHECK_FAILED",
        entity_type: "transaction",
        entity_id: descriptor.transactionId,
        summary: `Post-confirm receipt-ledger check failed for transaction ${descriptor.transactionId}: ${result.code}`,
        details: result.details,
      });
    } catch {
      warnings.push(
        `Post-confirm receipt-ledger verification could not be completed for transaction ${descriptor.transactionId}. `
        + "It IS confirmed; verify its registration journal with list_journals.");
    }
  }
  return { checked, ok, failures, ...(unverified.length ? {unverified} : {}), ...(warnings.length > 0 ? { warnings } : {}) };
}

async function loadExactMatchProjection(
  api: ApiContext,
  input: ExactConfirmInput,
  opts?: { fresh?: boolean },
): Promise<{ projection: ExactMatchProjection; threshold: number }> {
  const threshold = input.minConfidence ?? EXACT_CONFIRM_DEFAULT_MIN_CONFIDENCE;
  if (opts?.fresh) {
    // Execute: this projection gates confirms, so bypass the 120 s cache — an
    // invoice paid or a transaction confirmed elsewhere since the dry run must
    // not be confirmed (paid) a second time.
    api.transactions.invalidateListCache();
    api.saleInvoices.invalidateListCache();
    api.purchaseInvoices.invalidateListCache();
    api.journals.invalidateListCache();
  }
  api.transactions.invalidateListCache();
  api.saleInvoices.invalidateListCache();
  api.purchaseInvoices.invalidateListCache();
  const allTx = await api.transactions.listAll();
  const unconfirmed = await loadPendingTransactions(api, allTx);
  const total = unconfirmed.length;
  for (let i = 0; i < total; i++) await reportProgress(i, total);

  if (total === 0) {
    return { projection: computeExactMatchProjection([], [], [], threshold), threshold };
  }

  // Same fail-closed decode as the read-only suggest path above. A raw read is
  // not merely inconsistent here, it is unsafe in the dangerous direction: a
  // malformed `payment_status` (e.g. the number 42) is not equal to "PAID", so
  // an already-settled invoice would enter the open set and could be
  // auto-confirmed against a transaction a second time. This is the MUTATING
  // path, so it needs the guard at least as much as the advisory one.
  const allSales = await Promise.all((await api.saleInvoices.listAll()).map(inv => api.saleInvoices.get(inv.id!)));
  const openSales = allSales.filter((inv: SaleInvoice) => {
    const critical = decodeInvoiceStatusCritical(inv);
    return critical.payment_status !== "PAID" && critical.status === "CONFIRMED";
  });
  const allPurchases = await Promise.all((await api.purchaseInvoices.listAll()).map(inv => api.purchaseInvoices.get(inv.id!)));
  const openPurchases = allPurchases.filter((inv: PurchaseInvoice) => {
    const critical = decodeInvoiceStatusCritical(inv);
    return critical.payment_status !== "PAID" && critical.status === "CONFIRMED";
  });

  const projection = computeExactMatchProjection(unconfirmed, openSales, openPurchases, threshold);
  await enrichExactMatchProjectionWithDuplicateGuard(api, projection, input.blockOnDuplicate === true, allTx, unconfirmed);
  return { projection, threshold };
}

export async function prepareExactConfirm(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: ExactConfirmInput,
): Promise<ExactConfirmPreview> {
  const { projection, threshold } = await loadExactMatchProjection(api, input);
  const planHandle = issueExactMatchPlan(runtimeSafetyContext, projection, threshold);
  return { projection, planHandle, threshold };
}

export async function executeExactConfirm(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: ExactConfirmExecutionInput,
): Promise<ReconExecResult<ExactConfirmExecution>> {
  const { projection, threshold } = await loadExactMatchProjection(api, input, { fresh: true });

  const plan_handle = input.planHandle;
  if (typeof plan_handle !== "string" || plan_handle.length === 0) {
    return { ok: false, failure: { kind: "plan_handle_required", category: "plan_handle_required", message: "A reviewed execution-plan handle from the reconciliation dry run is required to confirm matches." } };
  }
  let storedPlan;
  try {
    storedPlan = runtimeSafetyContext.planStore.consume(plan_handle, BANK_RECONCILIATION_PLAN_DOMAIN);
  } catch (error) {
    if (error instanceof PlanStoreError) return { ok: false, failure: { kind: "plan_store_error", category: error.code, message: error.message } };
    throw error;
  }

  const storedFingerprint = isRecord(storedPlan.privatePayload) ? storedPlan.privatePayload.fingerprint : undefined;
  if (typeof storedFingerprint !== "string" || storedFingerprint !== exactMatchFingerprint(projection, threshold)) {
    return { ok: false, failure: { kind: "plan_drift", category: "plan_drift", message: "The reviewed reconciliation plan no longer matches the current ledger." } };
  }
  if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(stripUndefinedDeep({ min_confidence: threshold }))) {
    return { ok: false, failure: { kind: "plan_drift", category: "plan_drift", message: "The reconciliation arguments changed since the plan was reviewed." } };
  }

  const executionReport = await executeReconciliationCommands(buildExactMatchCommands(api, projection));
  const ledgerChecks = await runPostConfirmLedgerChecks(api, projection, executionReport);
  return { ok: true, data: { projection, executionReport, threshold, ledgerChecks } };
}

// === Inter-account transfers =================================================

export async function runInterAccountMatching(
  api: ApiContext,
  input: InterAccountInput,
  opts?: { fresh?: boolean },
): Promise<InterAccountMatchResult> {
  const maxGap = validateInterAccountDateGap(input.maxDateGap);
  const target_accounts_dimensions_id = input.targetAccountsDimensionsId;
  if (opts?.fresh) {
    // Execute: the transaction list and the BookingGuard journal snapshot gate
    // confirms and journal creates (existing-journal detection) — read them
    // uncached so a transfer booked elsewhere since the dry run is not booked twice.
    api.transactions.invalidateListCache();
    api.journals.invalidateListCache();
  }

  const confirmActions: InterAccountConfirmAction[] = [];

  // Selection now relies on list status, so do not reuse a cached CONFIRMED
  // row after it has been invalidated back to PROJECT in another session.
  api.transactions.invalidateListCache();
  const [listedTx, bankAccounts, accountDimensions, invoiceInfo] = await Promise.all([
    api.transactions.listAll(),
    api.readonly.getBankAccounts({fresh:true}),
    api.readonly.getAccountDimensions({fresh:true}),
    api.readonly.getInvoiceInfo(),
  ]);
  const unconfirmed = await loadPendingTransactions(api, listedTx);
  const allTx = new Map(unconfirmed.map(tx => [tx.id!, tx]));
  const companyName = normalizeCompanyName(invoiceInfo.invoice_company_name ?? "");

  const { ownIbanToDimension, dimensionToIban, dimensionToTitle, dimensionToAccountsId, ownDimensionIds, ownIbansWithoutDimension } =
    buildBankAccountLookups(bankAccounts, accountDimensions);

  const lookups: InterAccountMatchLookups = {
    ownIbanToDimension,
    dimensionToIban,
    ownIbansWithoutDimension,
    companyName,
    companyLegalName: invoiceInfo.invoice_company_name ?? "",
    targetAccountsDimensionsId: target_accounts_dimensions_id,
  };

  // A row whose CAMT marker sig fails the checksum has an unverifiable
  // statement identity (IBAN, direction): it never takes part in automatic
  // pairing, one-sided confirms or mirror handling. Rows it would otherwise
  // have touched as an own transfer are reported for review below.
  const pairable = unconfirmed.filter(tx => !hasUnverifiableCamtMarker(tx));

  // Rows without a signed marker ("unknown") stay on the outgoing side as
  // before; same-type pairs among them confirm only when exactly one leg is
  // signed outgoing, and a confirm books from the real stored type.
  const outgoing = pairable.filter(tx => bankTransactionDirection(tx) !== "incoming");
  const incoming = pairable.filter(tx => bankTransactionDirection(tx) === "incoming");

  const matchedPairs: PairResult[] = [];
  const ambiguousPairs: AmbiguousPairResult[] = [];
  const matchedOneSided: OneSidedResult[] = [];
  const skippedAlreadyHandled: SkippedAlreadyHandledRow[] = [];
  const ambiguousRefless: AmbiguousReflessRow[] = [];
  const crossCurrencyPairs: CrossCurrencyRow[] = [];
  const errors: InterAccountErrorRow[] = [];
  const consumedTxIds = new Set<number>();
  const blockedOneSidedTxIds = new Set<number>();

  function finish(companyClientsId: number | null): InterAccountMatchResult {
    const planCommandProjections = buildInterAccountPlanCommandProjections(confirmActions, companyClientsId);
    const normalizedArgs = stripUndefinedDeep({ max_date_gap: maxGap, target_accounts_dimensions_id }) as PlanRecord;
    const fingerprint = interAccountFingerprint({ normalizedArgs, planCommandProjections, skippedAlreadyHandled,
      ambiguousPairs, ambiguousRefless, crossCurrencyPairs });
    const companyLegalName = (invoiceInfo.invoice_company_name ?? "").trim();
    const warnings = companyLegalName && !sameCompanyIdentity(companyLegalName, companyLegalName)
      ? ["Company name has no legal form; own-transfer detection relies on IBANs only."] : [];
    return { totalUnconfirmed: unconfirmed.length, invoiceInfo, dimensionToIban, dimensionToTitle,
      dimensionToAccountsId, matchedPairs, matchedOneSided, ambiguousPairs, skippedAlreadyHandled,
      ambiguousRefless, crossCurrencyPairs, errors, confirmActions, companyClientsId, normalizedArgs,
      fingerprint, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  // With no pending bank rows there is nothing to pair, deduplicate or confirm.
  if (unconfirmed.length === 0) return finish(null);

  // Load one BookingGuard snapshot of existing confirmed inter-account journals.
  const guard = await BookingGuard.load(api, { ownDimensionIds });

  function resolveExistingJournal(
    tx: Transaction, targetDim: number, amount: number, maxGapDays: number, consume: boolean,
  ): TransferResolution {
    return resolveWithReferences(transferReferencesOf(tx, guard.journals), (reference, consumeNow) => resolveTransfer(
      guard,
      { sourceDim: tx.accounts_dimensions_id, targetDim, amount, date: tx.date, maxGapDays, reference },
      tx, consumeNow,
    ), consume);
  }

  /** Review reason for a row whose matched journal does not move its transfer. */
  function uncoveredReason(journalId: number, amount: number, sourceTitle: string, targetTitle: string): string {
    return `Journal #${journalId} matches this transfer's reference or key, but it does not move ${amount} EUR between ${sourceTitle} and ${targetTitle} in this row's direction, so it is not this row's booking. Check the bank statement and the journal, then confirm the row inline or correct the journal.`;
  }

  function recordInterAccountJournal(
    sourceDim: number | undefined, targetDim: number | undefined,
    amount: number, date: string, journalId: number | undefined, referenceNumber?: string | null,
  ): void {
    if (sourceDim === undefined || targetDim === undefined) return;
    guard.recordInterAccount(
      { sourceDim, targetDim, amount, date, reference: referenceNumber },
      journalId,
    );
  }

  let companyClientsIdResolved = false;
  let resolvedCompanyClientsId: number | null = null;
  async function resolveCompanyClientsId(): Promise<number | null> {
    if (companyClientsIdResolved) return resolvedCompanyClientsId;
    companyClientsIdResolved = true;
    if (companyName) {
      const clients = await api.clients.findByName(invoiceInfo.invoice_company_name ?? "");
      const exact = clients.find(c => normalizeCompanyName(c.name) === companyName);
      resolvedCompanyClientsId = exact?.id ?? null;
    }
    return resolvedCompanyClientsId;
  }

  const oneSidedInferenceCache = new Map<number, OneSidedInference>();

  for (const tx of unconfirmed) {
    if (!tx.id || !hasUnverifiableCamtMarker(tx)) continue;
    const claim = unverifiedMarkerTransferClaim(tx, lookups);
    if (!claim) continue;
    const claimedTargets = claim.targetDimension !== undefined ? [claim.targetDimension] : claim.ambiguousTargetDimensions ?? [];
    ambiguousRefless.push({
      transaction_ids: [tx.id], amount: tx.amount, date: tx.date,
      source_account: dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`,
      target_account: claimedTargets.length > 0
        ? claimedTargets.map(d => dimensionToTitle.get(d) ?? `dim:${d}`).join(" / ")
        : claim.unbookableOwnIban ?? "",
      code: "camt_marker_unverified",
      reason: `Transaction ${tx.id} looks like an own-account transfer, but its CAMT statement marker fails the signature check, so its statement identity (counterparty IBAN, direction) cannot be verified. It is excluded from automatic matching; check the bank statement and resolve it manually.` +
        (legacyTruncatedCamtMarkerHint(tx) ? ` ${legacyTruncatedCamtMarkerHint(tx)}` : ""),
    });
  }

  // A pair held back from both pair matching and one-sided booking (booking
  // each leg one-sided would double-book it) is reported, never dropped silently.
  function reportBlockedPair(
    out: Transaction, inc: Transaction, confidence: number,
    code: "counterpart_lacks_own_origin" | "conflicting_transfer_amounts",
  ): void {
    blockedOneSidedTxIds.add(out.id!);
    blockedOneSidedTxIds.add(inc.id!);
    ambiguousPairs.push({
      outgoing_transaction_id: out.id!,
      amount: out.amount,
      date_out: out.date,
      from_dimension_id: out.accounts_dimensions_id,
      candidate_incoming_transaction_ids: [inc.id!],
      candidate_incoming_dimension_ids: [inc.accounts_dimensions_id],
      confidence,
      code,
      reason: code === "counterpart_lacks_own_origin"
        ? `Transactions ${out.id} (${out.amount}) and ${inc.id} (${inc.amount}) point at each other's account, but ${inc.id} has no evidence it came from ${out.id}'s account (its counterparty IBAN is not that account's), so it cannot be treated as a transfer mirror. Check the bank statements and confirm each row as what it is.`
        : `Transactions ${out.id} and ${inc.id} point at each other's account with the same nominal amount but different base (EUR) amounts, so they cannot be booked as one transfer automatically. Check the bank statements and book the transfer once at the correct EUR amount.`,
    });
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
      comparableAmount: number;
    }> = [];

    for (const txIn of incoming) {
      if (!txIn.id || consumedTxIds.has(txIn.id)) continue;
      if (txOut.accounts_dimensions_id === txIn.accounts_dimensions_id) continue;
      // A trusted `x=i` leg is a proven external payment, on either side.
      if (isCamtCounterpartyIbanOmitted(txOut) || isCamtCounterpartyIbanOmitted(txIn)) continue;

      const compatibility = getTransferPairCompatibility(txOut, txIn, maxGap);
      if (!compatibility) continue;

      let confidence = compatibility.confidence;
      const reasons = [...compatibility.reasons];
      const txOutComparableAmount = compatibility.txAComparableAmount;
      const conflictingComparableAmounts = compatibility.conflictingComparableAmounts;

      const outCounterpartyIban = counterpartyIbanOf(txOut);
      const inCounterpartyIban = counterpartyIbanOf(txIn);
      const inAccountIban = dimensionToIban.get(txIn.accounts_dimensions_id) ?? "";
      const outAccountIban = dimensionToIban.get(txOut.accounts_dimensions_id) ?? "";

      if (conflictingComparableAmounts) {
        const txOutOneSided = inferOneSidedTransfer(txOut, lookups, oneSidedInferenceCache);
        const txInOneSided = inferOneSidedTransfer(txIn, lookups, oneSidedInferenceCache);
        const mutuallyConsistentOneSidedTargets =
          txOutOneSided.targetDimension === txIn.accounts_dimensions_id &&
          txInOneSided.targetDimension === txOut.accounts_dimensions_id;
        if (mutuallyConsistentOneSidedTargets) {
          reportBlockedPair(txOut, txIn, compatibility.confidence, "conflicting_transfer_amounts");
        }
        continue;
      }

      // A counterparty IBAN naming a *different* own account contradicts this
      // pairing, and an incoming row from a known third-party IBAN is a real
      // receipt, not a transfer mirror leg — pairing would delete it.
      // An IBAN may back several own accounts, so veto only when none of them
      // is the candidate's account.
      const outCounterpartyDims = outCounterpartyIban ? ownIbanToDimension.get(outCounterpartyIban) : undefined;
      const inCounterpartyDims = inCounterpartyIban ? ownIbanToDimension.get(inCounterpartyIban) : undefined;
      if (outCounterpartyDims && !outCounterpartyDims.has(txIn.accounts_dimensions_id)) continue;
      if (inCounterpartyDims && !inCounterpartyDims.has(txOut.accounts_dimensions_id)) continue;
      if (!hasMirrorOwnOriginEvidence(txIn, txOut, lookups)) continue;

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
        comparableAmount: txOutComparableAmount,
      });
    }

    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (a.txIn.id ?? 0) - (b.txIn.id ?? 0);
    });

    const topConfidence = candidates[0]!.confidence;
    let topCandidates = candidates.filter(candidate => candidate.confidence === topConfidence);
    // Payment instruction id (LHV Refs/InstrId = the Wise reference's "/<id>"
    // suffix): identity evidence only among candidates that already pass every
    // amount/date/account guard. It breaks a same-confidence tie when exactly
    // one tied candidate carries it, and sends the row to review when the sole
    // top candidate is not the one it names; it never adds a candidate.
    const instructionId = camtInstructionIdOf(txOut);
    const instructionMatches = instructionId === undefined
      ? []
      : candidates.filter(candidate => wiseReferenceInstructionIdOf(candidate.txIn) === instructionId);
    if (instructionMatches.length > 0) {
      const tiedMatches = topCandidates.filter(candidate => instructionMatches.includes(candidate));
      if (topCandidates.length > 1 && tiedMatches.length === 1) {
        topCandidates = tiedMatches;
      } else if (topCandidates.length === 1 && tiedMatches.length === 0) {
        const named = instructionMatches.map(candidate => candidate.txIn);
        ambiguousPairs.push({
          outgoing_transaction_id: txOut.id,
          amount: txOut.amount,
          date_out: txOut.date,
          from_dimension_id: txOut.accounts_dimensions_id,
          candidate_incoming_transaction_ids: [topCandidates[0]!.txIn.id!, ...named.map(tx => tx.id!)],
          candidate_incoming_dimension_ids: [topCandidates[0]!.txIn.accounts_dimensions_id, ...named.map(tx => tx.accounts_dimensions_id)],
          confidence: topConfidence,
          code: "instruction_id_conflict",
          reason: `Outgoing transaction ${txOut.id} best matches incoming ${topCandidates[0]!.txIn.id}, but its payment instruction id names incoming ${named.map(tx => tx.id).join(", ")} instead (Wise reference suffix). Check both statements and confirm the right pair inline.`,
        });
        blockedOneSidedTxIds.add(txOut.id);
        for (const candidate of [topCandidates[0]!, ...instructionMatches]) blockedOneSidedTxIds.add(candidate.txIn.id!);
        continue;
      }
      if (topCandidates.length === 1 && instructionMatches.includes(topCandidates[0]!)) {
        topCandidates[0]!.reasons.push("instruction_id_matches_reference");
      }
    }
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
      blockedOneSidedTxIds.add(txOut.id);
      for (const candidate of topCandidates) blockedOneSidedTxIds.add(candidate.txIn.id!);
      continue;
    }

    const bestCandidate = topCandidates[0]!;
    const txIn = bestCandidate.txIn;

    const fromTitle = dimensionToTitle.get(txOut.accounts_dimensions_id) ?? `dim:${txOut.accounts_dimensions_id}`;
    const toTitle = dimensionToTitle.get(txIn.accounts_dimensions_id) ?? `dim:${txIn.accounts_dimensions_id}`;

    const resolution = resolveExistingJournal(txOut, txIn.accounts_dimensions_id, bestCandidate.comparableAmount, maxGap, true);
    if (resolution.status === "matched") {
      consumedTxIds.add(txOut.id);
      consumedTxIds.add(txIn.id!);
      skippedAlreadyHandled.push(
        { transaction_id: txOut.id, amount: txOut.amount, date: txOut.date, source_account: dimensionToTitle.get(txOut.accounts_dimensions_id) ?? "", existing_journal_id: resolution.journal_id, reason: "Already journalized" },
        { transaction_id: txIn.id!, amount: txIn.amount, date: txIn.date, source_account: dimensionToTitle.get(txIn.accounts_dimensions_id) ?? "", existing_journal_id: resolution.journal_id, reason: "Already journalized" },
      );
      continue;
    }
    if (resolution.status === "ambiguous_refless" || resolution.status === "uncovered") {
      consumedTxIds.add(txOut.id);
      consumedTxIds.add(txIn.id!);
      ambiguousRefless.push({
        transaction_ids: [txOut.id, txIn.id!], amount: txOut.amount, date: txOut.date,
        source_account: fromTitle, target_account: toTitle,
        reason: resolution.status === "uncovered" ? uncoveredReason(resolution.journal_id, bestCandidate.comparableAmount, fromTitle, toTitle) : "A same-key inter-account journal (matching amount/date/accounts) was already booked this run and its reference does not disambiguate; cannot tell a genuine second transfer from a duplicate mirror leg. Confirm inline if this is a real second transfer.",
      });
      continue;
    }

    consumedTxIds.add(txOut.id);
    consumedTxIds.add(txIn.id!);

    const crossCurrencyPair =
      bestCandidate.reasons.includes("exact_base_amount") &&
      !bestCandidate.reasons.includes("exact_amount") &&
      hasMeaningfulComparableAmount(txOut);
    if (crossCurrencyPair) {
      crossCurrencyPairs.push({
        transaction_ids: [txOut.id, txIn.id!],
        amount_out: txOut.amount, amount_in: txIn.amount, date: txOut.date,
        source_account: fromTitle, target_account: toTitle,
        reason: "Cross-currency inter-account pair matched on base amount only; the legs have different nominal amounts. Auto-distributing the outgoing nominal amount would misbook the target leg. Confirm inline with the correct per-account amounts.",
      });
      continue;
    }

    matchedPairs.push({
      outgoing_transaction_id: txOut.id, incoming_transaction_id: txIn.id!,
      amount: txOut.amount, date_out: txOut.date, date_in: txIn.date,
      from_account: fromTitle, to_account: toTitle,
      from_dimension_id: txOut.accounts_dimensions_id, to_dimension_id: txIn.accounts_dimensions_id,
      description_out: txOut.description ?? undefined, description_in: txIn.description ?? undefined,
      confidence: bestCandidate.confidence, match_reasons: bestCandidate.reasons,
      status: "would_confirm", incoming_action: "would_delete_duplicate",
    });
    confirmActions.push({
      confirmedTxId: txOut.id,
      confirmedClientsId: txOut.clients_id ?? null,
      confirmedNominalAmount: txOut.amount,
      confirmedCurrency: transactionCurrency(txOut),
      targetDimensionId: txIn.accounts_dimensions_id,
      // Base EUR (H10, af62766): the same unit the BookingGuard key and the
      // one-sided confirms use. Equal to the nominal for plain EUR rows.
      distributionAmount: bestCandidate.comparableAmount,
      deleteTxId: txIn.id!,
      auditSummary: `Confirmed inter-account outgoing ${bestCandidate.comparableAmount} EUR (${fromTitle} -> ${toTitle})`,
      auditDetails: { amount: txOut.amount, date: txOut.date, paired_incoming_id: txIn.id },
      deleteAuditSummary: `Deleted duplicate incoming row ${txIn.id} after confirming outgoing ${txOut.id} (${fromTitle} -> ${toTitle})`,
      deleteAuditDetails: { amount: txIn.amount, date: txIn.date, paired_outgoing_id: txOut.id },
    });
    recordInterAccountJournal(
      txOut.accounts_dimensions_id, txIn.accounts_dimensions_id, comparableTransactionAmount(txOut), txOut.date,
      undefined, transferReferenceOf(txOut, guard.journals),
    );
    if (txOut.clients_id == null) await resolveCompanyClientsId();
  }

  // --- Phase 1b: reciprocal same-type pairs with strong mutual target evidence ---
  const phaseOneRemaining = pairable.filter(
    tx => tx.id && !consumedTxIds.has(tx.id) && !blockedOneSidedTxIds.has(tx.id),
  );

  for (const tx of phaseOneRemaining) {
    if (!tx.id || consumedTxIds.has(tx.id) || blockedOneSidedTxIds.has(tx.id)) continue;

    const txInference = inferOneSidedTransfer(tx, lookups, oneSidedInferenceCache);
    if (txInference.confidence < 50 || !txInference.targetDimension) continue;

    const candidates: Array<{
      counterpart: Transaction;
      confidence: number;
      reasons: string[];
      comparableAmount: number;
    }> = [];

    for (const other of phaseOneRemaining) {
      if (!other.id || other.id === tx.id || consumedTxIds.has(other.id) || blockedOneSidedTxIds.has(other.id)) continue;
      if (isCamtCounterpartyIbanOmitted(tx) || isCamtCounterpartyIbanOmitted(other)) continue;
      if (other.type !== tx.type) continue;
      if (other.accounts_dimensions_id !== txInference.targetDimension) continue;

      const otherInference = inferOneSidedTransfer(other, lookups, oneSidedInferenceCache);
      if (otherInference.confidence < 50 || otherInference.targetDimension !== tx.accounts_dimensions_id) continue;

      const reciprocalEvidence = getSameTypeReciprocalEvidence(tx, other, txInference, otherInference, dimensionToIban);
      if (!reciprocalEvidence) continue;

      const compatibility = getTransferPairCompatibility(tx, other, maxGap);
      if (!compatibility) continue;

      if (compatibility.conflictingComparableAmounts) {
        reportBlockedPair(tx, other, compatibility.confidence, "conflicting_transfer_amounts");
        continue;
      }

      candidates.push({
        counterpart: other,
        confidence: Math.min(compatibility.confidence + reciprocalEvidence.confidenceBonus, 100),
        reasons: [...compatibility.reasons, ...reciprocalEvidence.reasons],
        comparableAmount: compatibility.txAComparableAmount,
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
    const reciprocal = bestCandidate.counterpart;

    if (!reciprocal.id || consumedTxIds.has(reciprocal.id) || blockedOneSidedTxIds.has(reciprocal.id)) {
      continue;
    }

    // Both legs carry the same stored type, so the type cannot say which account
    // the money left. Confirming the wrong leg books the transfer reversed (the
    // confirmed row's own account becomes the source). Only a signed importer
    // marker proving "outgoing" on exactly one leg settles it; anything else is
    // a human decision, independent of listing order. (The live API reads every
    // row back as `C`, so the `type === "C"` term never discriminates — the
    // signed marker is the whole proof.)
    const txProvenOutgoing = signedBankTransactionDirection(tx) === "outgoing" && tx.type === "C";
    const reciprocalProvenOutgoing = signedBankTransactionDirection(reciprocal) === "outgoing" && reciprocal.type === "C";
    if (txProvenOutgoing === reciprocalProvenOutgoing) {
      ambiguousPairs.push({
        outgoing_transaction_id: tx.id,
        amount: tx.amount,
        date_out: tx.date,
        from_dimension_id: tx.accounts_dimensions_id,
        candidate_incoming_transaction_ids: [reciprocal.id],
        candidate_incoming_dimension_ids: [reciprocal.accounts_dimensions_id],
        confidence: bestCandidate.confidence,
        code: "direction_unresolved",
        reason: `Transactions ${tx.id} and ${reciprocal.id} look like the two legs of one own-account transfer, but no single leg has a signed outgoing statement marker (the read-back type is always "C" and says nothing about direction), so which account the money left cannot be determined. After the owner confirms it from the bank statements, confirm that leg against the other bank account and delete the mirror row, each only with explicit approval.`,
      });
      blockedOneSidedTxIds.add(tx.id);
      blockedOneSidedTxIds.add(reciprocal.id);
      continue;
    }
    const source = txProvenOutgoing ? tx : reciprocal;
    const counterpart = txProvenOutgoing ? reciprocal : tx;
    if (!hasMirrorOwnOriginEvidence(counterpart, source, lookups)) {
      // Not a deletable mirror, yet both legs infer each other's account:
      // booking each one-sided would double-book. Leave both for review.
      reportBlockedPair(source, counterpart, bestCandidate.confidence, "counterpart_lacks_own_origin");
      continue;
    }
    const sourceId = source.id!;
    const counterpartId = counterpart.id!;
    // Base EUR, the same unit the BookingGuard key and one-sided confirms use.
    const distributionAmount = comparableTransactionAmount(source);

    const fromTitleEarly = dimensionToTitle.get(source.accounts_dimensions_id) ?? `dim:${source.accounts_dimensions_id}`;
    const toTitleEarly = dimensionToTitle.get(counterpart.accounts_dimensions_id) ?? `dim:${counterpart.accounts_dimensions_id}`;

    const resolution = resolveExistingJournal(source, counterpart.accounts_dimensions_id, distributionAmount, maxGap, true);
    if (resolution.status === "matched") {
      consumedTxIds.add(sourceId);
      consumedTxIds.add(counterpartId);
      skippedAlreadyHandled.push(
        {
          transaction_id: sourceId,
          amount: source.amount,
          date: source.date,
          source_account: dimensionToTitle.get(source.accounts_dimensions_id) ?? "",
          existing_journal_id: resolution.journal_id,
          reason: "Already journalized",
        },
        {
          transaction_id: counterpartId,
          amount: counterpart.amount,
          date: counterpart.date,
          source_account: dimensionToTitle.get(counterpart.accounts_dimensions_id) ?? "",
          existing_journal_id: resolution.journal_id,
          reason: "Already journalized",
        },
      );
      continue;
    }
    if (resolution.status === "ambiguous_refless" || resolution.status === "uncovered") {
      consumedTxIds.add(sourceId);
      consumedTxIds.add(counterpartId);
      ambiguousRefless.push({
        transaction_ids: [sourceId, counterpartId], amount: source.amount, date: source.date,
        source_account: fromTitleEarly, target_account: toTitleEarly,
        reason: resolution.status === "uncovered" ? uncoveredReason(resolution.journal_id, distributionAmount, fromTitleEarly, toTitleEarly) : "A same-key inter-account journal (matching amount/date/accounts) was already booked this run and its reference does not disambiguate; cannot tell a genuine second transfer from a duplicate mirror leg. Confirm inline if this is a real second transfer.",
      });
      continue;
    }

    const fromTitle = fromTitleEarly;
    const toTitle = toTitleEarly;

    consumedTxIds.add(sourceId);
    consumedTxIds.add(counterpartId);

    const crossCurrencyPair =
      bestCandidate.reasons.includes("exact_base_amount") &&
      !bestCandidate.reasons.includes("exact_amount") &&
      hasMeaningfulComparableAmount(source);
    if (crossCurrencyPair) {
      crossCurrencyPairs.push({
        transaction_ids: [sourceId, counterpartId],
        amount_out: source.amount, amount_in: counterpart.amount, date: source.date,
        source_account: fromTitle, target_account: toTitle,
        reason: "Cross-currency inter-account pair matched on base amount only; the legs have different nominal amounts. Auto-distributing the outgoing nominal amount would misbook the target leg. Confirm inline with the correct per-account amounts.",
      });
      continue;
    }

    matchedPairs.push({
      outgoing_transaction_id: sourceId,
      incoming_transaction_id: counterpartId,
      amount: source.amount,
      date_out: source.date,
      date_in: counterpart.date,
      from_account: fromTitle,
      to_account: toTitle,
      from_dimension_id: source.accounts_dimensions_id,
      to_dimension_id: counterpart.accounts_dimensions_id,
      description_out: source.description ?? undefined,
      description_in: counterpart.description ?? undefined,
      confidence: bestCandidate.confidence,
      match_reasons: bestCandidate.reasons,
      status: "would_confirm",
      incoming_action: "would_delete_duplicate",
    });
    confirmActions.push({
      confirmedTxId: sourceId,
      confirmedClientsId: source.clients_id ?? null,
      confirmedNominalAmount: source.amount,
      confirmedCurrency: transactionCurrency(source),
      targetDimensionId: counterpart.accounts_dimensions_id,
      distributionAmount,
      deleteTxId: counterpartId,
      auditSummary: `Confirmed reciprocal same-type inter-account transfer ${distributionAmount} EUR (${fromTitle} -> ${toTitle})`,
      auditDetails: { amount: source.amount, date: source.date, paired_counterpart_id: counterpartId },
      deleteAuditSummary: `Deleted reciprocal same-type duplicate row ${counterpartId} after confirming ${sourceId} (${fromTitle} -> ${toTitle})`,
      deleteAuditDetails: { amount: counterpart.amount, date: counterpart.date, paired_confirmed_id: sourceId },
    });
    recordInterAccountJournal(
      source.accounts_dimensions_id, counterpart.accounts_dimensions_id, distributionAmount, source.date,
      undefined, transferReferenceOf(source, guard.journals),
    );
    if (source.clients_id == null) await resolveCompanyClientsId();
  }

  // --- Phase 2: one-sided transfers (counterparty = company name or own IBAN) ---
  const remaining = pairable.filter(
    tx => tx.id && !consumedTxIds.has(tx.id) && !blockedOneSidedTxIds.has(tx.id),
  );

  // Two rows that would each be booked one-sided against each other's account
  // are two legs of ONE transfer when their amounts differ only by a plausible
  // fee (Phase 1 needs equal amounts, so a fee-deducted transfer reaches here).
  // Booking both would double-book it, so route both to review instead.
  // Tolerance: a non-zero difference of at most max(1 EUR, 2% of the larger
  // leg), on the comparable (base EUR) amounts, within the pairing date gap —
  // waived when both legs' counterparty IBANs prove the reciprocal transfer.
  // Rows already covered by an existing journal keep the journal path.
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i]!;
    const aTarget = inferOneSidedTransfer(a, lookups, oneSidedInferenceCache);
    if (aTarget.confidence < 50 || !aTarget.targetDimension) continue;
    for (let j = i + 1; j < remaining.length; j++) {
      const b = remaining[j]!;
      if (b.accounts_dimensions_id !== aTarget.targetDimension) continue;
      const bTarget = inferOneSidedTransfer(b, lookups, oneSidedInferenceCache);
      if (bTarget.confidence < 50 || bTarget.targetDimension !== a.accounts_dimensions_id) continue;
      const aAmount = comparableTransactionAmount(a);
      const bAmount = comparableTransactionAmount(b);
      if (sameAmountToTheCent(aAmount, bAmount)) continue;
      // Proven reciprocal legs (each counterparty IBAN is the other own account,
      // both directions proven) are one transfer whatever the fee: no tolerance.
      const reciprocalProven =
        aTarget.reasons.includes("counterparty_iban_is_own_account") &&
        bTarget.reasons.includes("counterparty_iban_is_own_account") &&
        bankTransactionDirection(a) !== "unknown" && bankTransactionDirection(b) !== "unknown";
      const tolerance = Math.max(1, 0.02 * Math.max(Math.abs(aAmount), Math.abs(bAmount)));
      if (!reciprocalProven && Math.abs(Math.abs(aAmount) - Math.abs(bAmount)) > tolerance) continue;
      if (Math.abs(toUtcDay(a.date) - toUtcDay(b.date)) / 86_400_000 > maxGap) continue;
      // An existing journal already covering either leg is handled by the
      // one-sided journal check below (skip / ambiguous_refless), not here.
      const covered = (tx: Transaction, target: number, amount: number) =>
        resolveExistingJournal(tx, target, amount, maxGap, false).status !== "none";
      if (covered(a, b.accounts_dimensions_id, aAmount) || covered(b, a.accounts_dimensions_id, bAmount)) continue;

      // A fee-deducted transfer is one outgoing and one incoming leg with the
      // incoming no larger than the outgoing. Two same-direction rows are two
      // separate transfers and keep the one-sided path. An unproven direction
      // still goes to review, but without a delete suggestion.
      const aDir = bankTransactionDirection(a);
      const bDir = bankTransactionDirection(b);
      const directionsProven = aDir !== "unknown" && bDir !== "unknown";
      if (directionsProven && aDir === bDir) continue;
      const [out, inc] = aDir === "incoming" || bDir === "outgoing" ? [b, a] : [a, b];
      const outAmount = out === a ? aAmount : bAmount;
      const incAmount = out === a ? bAmount : aAmount;
      if (directionsProven && Math.abs(outAmount) < Math.abs(incAmount)) continue;
      blockedOneSidedTxIds.add(a.id!);
      blockedOneSidedTxIds.add(b.id!);
      ambiguousPairs.push({
        outgoing_transaction_id: out.id!,
        amount: out.amount,
        date_out: out.date,
        from_dimension_id: out.accounts_dimensions_id,
        candidate_incoming_transaction_ids: [inc.id!],
        candidate_incoming_dimension_ids: [inc.accounts_dimensions_id],
        confidence: Math.min(aTarget.confidence, bTarget.confidence),
        code: "possible_fee_deducted_transfer",
        reason: directionsProven
          ? `Possible fee-deducted transfer: outgoing ${out.id} (${out.amount}) and incoming ${inc.id} (${inc.amount}). If they are the same transfer, confirm the outgoing leg with the fee split and remove the incoming mirror; otherwise confirm each separately.`
          : `Possible fee-deducted transfer: transactions ${out.id} (${out.amount}) and ${inc.id} (${inc.amount}) point at each other's account with near-equal amounts, but their bank direction is unresolved. Check the bank statements: if they are the same transfer, book it once with the fee split; otherwise confirm each separately.`,
      });
    }
  }

  // Positive evidence that `tx` (a Phase 2 row already covered by `journalId`)
  // mirrors that journal's confirmed counterpart transaction, or undefined.
  // Report-only: the operator resolves a proposal with delete_transaction.
  const isPlainEur = (row: Transaction) =>
    row.cl_currencies_id === "EUR" && (row.base_amount == null || sameAmountToTheCent(row.base_amount, row.amount));
  async function mirrorProposalFor(tx: Transaction, targetDimension: number, journalId: number): Promise<NonNullable<SkippedAlreadyHandledRow["mirror_proposal"]> | undefined> {
    const journal = guard.journals.find(j => j.id === journalId);
    if (!journal || journal.is_deleted || journal.registered !== true || journal.operation_type !== "TRANSACTION") return undefined;
    // Only a matched registration journal needs a historical counterpart's
    // detail. Unrelated confirmed transaction history cannot affect this proof.
    if (journal.operations_id != null && !allTx.has(journal.operations_id)
      && listedTx.some(row => row.id === journal.operations_id)) {
      allTx.set(journal.operations_id, await api.transactions.get(journal.operations_id));
    }
    const counterpart = journal.operations_id != null ? allTx.get(journal.operations_id) : undefined;
    if (!counterpart || counterpart.is_deleted || counterpart.status !== "CONFIRMED") return undefined;
    if (counterpart.accounts_dimensions_id !== targetDimension || !sameAmountToTheCent(counterpart.amount, tx.amount)) return undefined;
    if (!isPlainEur(tx) || !isPlainEur(counterpart)) return undefined;
    if (!hasMirrorOwnOriginEvidence(tx, counterpart, lookups)) return undefined;
    const direction = signedBankTransactionDirection(tx);
    if (!direction) return undefined;
    const ownSide = direction === "incoming" ? "D" : "C";
    const legsOn = (dim: number) => journal.postings.filter(p => !p.is_deleted && p.accounts_dimensions_id === dim);
    const ownLegs = legsOn(tx.accounts_dimensions_id);
    const targetLegs = legsOn(targetDimension);
    if (ownLegs.length === 0 || ownLegs.some(p => p.type !== ownSide)) return undefined;
    if (targetLegs.length === 0 || targetLegs.some(p => p.type === ownSide)) return undefined;
    if (signedBankTransactionDirection(counterpart) === direction) return undefined;
    return {
      counterpart_transaction_id: counterpart.id!,
      journal_id: journalId,
      evidence: [
        "journal_is_counterpart_transaction",
        "counterpart_confirmed_on_target_account",
        "same_eur_amount",
        "own_origin_evidence",
        "posting_side_matches_signed_direction",
        "sole_same_key_candidate",
      ],
    };
  }
  const mirrorProposals: Array<{ row: SkippedAlreadyHandledRow; proposal: NonNullable<SkippedAlreadyHandledRow["mirror_proposal"]> }> = [];
  // Rows sent to same-key review stay candidates for later rows, and the
  // journal each review matched counts as claimed.
  const mirrorReviewedTxIds = new Set<number>();
  const mirrorReviewJournalClaims = new Map<number, number>();

  for (const tx of remaining) {
    if (!tx.id || blockedOneSidedTxIds.has(tx.id) || consumedTxIds.has(tx.id)) continue;
    const { targetDimension, confidence, reasons, ambiguousTargetDimensions, unbookableOwnIban } =
      inferOneSidedTransfer(tx, lookups, oneSidedInferenceCache);

    if (unbookableOwnIban) {
      // The company's own money, but the account on the other side cannot be booked:
      // never redirect it to a different own account.
      ambiguousRefless.push({
        transaction_ids: [tx.id], amount: tx.amount, date: tx.date,
        source_account: dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`,
        target_account: unbookableOwnIban,
        code: "own_account_not_bookable",
        reason: `The counterparty IBAN ${unbookableOwnIban} is an own bank account without an accounting dimension, so the transfer cannot be booked to it; give that bank account a dimension in e-arveldaja, then reconcile again, or confirm inline.`,
      });
      continue;
    }

    if (ambiguousTargetDimensions) {
      ambiguousRefless.push({
        transaction_ids: [tx.id], amount: tx.amount, date: tx.date,
        source_account: dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`,
        target_account: ambiguousTargetDimensions.map(d => dimensionToTitle.get(d) ?? `dim:${d}`).join(" / "),
        reason: `The counterparty IBAN backs several own accounts (dimensions ${ambiguousTargetDimensions.join(", ")}); pass target_accounts_dimensions_id naming one of them, or confirm inline.`,
      });
      continue;
    }
    if (!targetDimension && reasons.includes("counterparty_name_matches_company")) {
      // The payer is the company itself, but several own accounts could be
      // the other side: report it rather than silently dropping the row.
      const otherDimensions = [...dimensionToIban.keys()].filter(d => d !== tx.accounts_dimensions_id);
      const unregisteredIban = reasons.includes(COUNTERPARTY_IBAN_NOT_REGISTERED);
      ambiguousRefless.push({
        transaction_ids: [tx.id], amount: tx.amount, date: tx.date,
        source_account: dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`,
        target_account: otherDimensions.map(d => dimensionToTitle.get(d) ?? `dim:${d}`).join(" / "),
        // A target parameter would not help an unregistered IBAN: it is held until its mirror row proves it.
        ...(unregisteredIban
          ? {
            code: "unregistered_iban_needs_mirror" as const,
            reason: `The counterparty is the company itself, but its counterparty IBAN is not a registered own bank account and several own accounts could be the other side (dimensions ${otherDimensions.join(", ")}). It is booked automatically only once the other account's mirror row proves the transfer; register the account or confirm inline.`,
          }
          : {
            reason: `The counterparty is the company itself, but several own accounts could be the other side (dimensions ${otherDimensions.join(", ")}); pass target_accounts_dimensions_id naming one of them, or confirm inline.`,
          }),
      });
      continue;
    }
    if (confidence < ONE_SIDED_MIN_CONFIDENCE || !targetDimension) continue;

    const sourceTitle = dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`;
    const targetTitle = dimensionToTitle.get(targetDimension) ?? `dim:${targetDimension}`;

    const amountResolution = resolveOneSidedTransferAmount(tx);
    if (!amountResolution.ok) {
      errors.push({
        transaction_ids: [tx.id],
        code: amountResolution.code,
        reason: amountResolution.reason,
      });
      continue;
    }
    const { nominalAmount, currency, amountEur } = amountResolution;

    const resolution = resolveExistingJournal(tx, targetDimension, amountEur, maxGap, true);
    if (resolution.status === "matched") {
      consumedTxIds.add(tx.id);
      // Other unhandled rows with this transfer's key (same account and
      // target, same EUR cents, ±1 day) — including rows with an unverifiable
      // marker. The journal covers one movement; with several candidates it
      // cannot be told which is its mirror, so all of them go to review.
      const sameKeyCandidates = [...remaining, ...unconfirmed.filter(hasUnverifiableCamtMarker)].filter(other =>
        other.id !== undefined && other.id !== tx.id && (!consumedTxIds.has(other.id) || mirrorReviewedTxIds.has(other.id)) &&
        other.accounts_dimensions_id === tx.accounts_dimensions_id &&
        Math.abs(toUtcDay(other.date) - toUtcDay(tx.date)) / 86_400_000 <= 1 &&
        (hasUnverifiableCamtMarker(other)
          ? sameAmountToTheCent(comparableTransactionAmount(other), amountEur) &&
            [unverifiedMarkerTransferClaim(other, lookups)].some(claim =>
              claim?.targetDimension === targetDimension || claim?.ambiguousTargetDimensions?.includes(targetDimension))
          // A row whose own EUR amount does not resolve is already an error row.
          : [resolveOneSidedTransferAmount(other)].some(resolved => resolved.ok && sameAmountToTheCent(resolved.amountEur, amountEur)) &&
            inferOneSidedTransfer(other, lookups, oneSidedInferenceCache).targetDimension === targetDimension));
      if (sameKeyCandidates.length > 0) {
        const ids = [tx.id, ...sameKeyCandidates.map(other => other.id!)];
        for (const id of ids) {
          consumedTxIds.add(id);
          mirrorReviewedTxIds.add(id);
        }
        // Every member's journal claim counts, not only this row's: a later
        // row must not become the sole claimant of a journal a member matched.
        // Read straight from the journal snapshot, independent of what this run
        // has consumed: any live journal on this account pair with this EUR
        // amount within the date gap that is ref-less or carries the member's
        // reference is a competing claim.
        const competingJournalIds = (member: Transaction): number[] => {
          const references = new Set(transferReferencesOf(member, guard.journals).map(normalizeReference));
          return guard.journals.filter(j => {
            if (j.id == null || j.is_deleted || j.registered !== true) return false;
            if (Math.abs(toUtcDay(j.effective_date) - toUtcDay(member.date)) / 86_400_000 > maxGap) return false;
            const journalReference = normalizeReference(j.document_number);
            if (journalReference !== "" && !references.has(journalReference)) return false;
            const legOn = (dim: number) => j.postings.some(p =>
              !p.is_deleted && p.accounts_dimensions_id === dim && sameAmountToTheCent(Math.abs(p.base_amount ?? p.amount), amountEur));
            return legOn(member.accounts_dimensions_id) && legOn(targetDimension);
          }).map(j => j.id!);
        };
        const claimedJournalIds = new Set([resolution.journal_id, ...[tx, ...sameKeyCandidates].flatMap(competingJournalIds)]);
        for (const journalId of claimedJournalIds) {
          mirrorReviewJournalClaims.set(journalId, (mirrorReviewJournalClaims.get(journalId) ?? 0) + 1);
        }
        ambiguousRefless.push({
          transaction_ids: ids, amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date,
          source_account: sourceTitle, target_account: targetTitle,
          reason: `Transactions ${ids.join(", ")} are same-amount transfers from ${sourceTitle} to ${targetTitle} within a day of each other, but journal #${resolution.journal_id} books only one movement, so it cannot be told which of them (if any) is its mirror. Check the bank statements, then, only after the owner approves, delete the mirror row and confirm any genuine transfer inline.`,
        });
        continue;
      }
      const row: SkippedAlreadyHandledRow = {
        transaction_id: tx.id, amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date,
        source_account: sourceTitle, source_dimension_id: tx.accounts_dimensions_id,
        target_account: targetTitle, target_dimension_id: targetDimension,
        existing_journal_id: resolution.journal_id,
        reason: "Already journalized from the other account side",
      };
      skippedAlreadyHandled.push(row);
      const proposal = await mirrorProposalFor(tx, targetDimension, resolution.journal_id);
      if (proposal) mirrorProposals.push({ row, proposal });
      continue;
    }
    if (resolution.status === "ambiguous_refless" || resolution.status === "uncovered") {
      consumedTxIds.add(tx.id);
      ambiguousRefless.push({
        transaction_ids: [tx.id], amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date,
        source_account: sourceTitle, target_account: targetTitle,
        reason: resolution.status === "uncovered" ? uncoveredReason(resolution.journal_id, amountEur, sourceTitle, targetTitle) : "A same-key inter-account journal (matching amount/date/accounts) was already booked this run and its reference does not disambiguate; cannot tell a genuine second transfer from a duplicate mirror leg. Confirm inline if this is a real second transfer.",
      });
      continue;
    }

    consumedTxIds.add(tx.id);

    if (reasons.includes(COUNTERPARTY_IBAN_NOT_REGISTERED)) {
      ambiguousRefless.push({
        transaction_ids: [tx.id], amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date,
        source_account: sourceTitle, target_account: targetTitle, code: "unregistered_iban_needs_mirror",
        reason: `The counterparty name is the company's, but its counterparty IBAN is not a registered own bank account (an own account not set up in e-arveldaja, or a payment provider's pooled account). It is booked automatically only once the other account's mirror row proves the transfer; register the account or confirm inline if this is a transfer to ${targetTitle}.`,
      });
      continue;
    }

    matchedOneSided.push({
      transaction_id: tx.id, type: tx.type, amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date,
      source_account: sourceTitle, source_dimension_id: tx.accounts_dimensions_id,
      target_account: targetTitle, target_dimension_id: targetDimension,
      description: tx.description ?? undefined, counterparty_name: tx.bank_account_name ?? undefined,
      confidence: Math.min(confidence, 100), match_reasons: reasons, status: "would_confirm",
    });
    confirmActions.push({
      confirmedTxId: tx.id,
      confirmedClientsId: tx.clients_id ?? null,
      confirmedNominalAmount: tx.amount,
      confirmedCurrency: transactionCurrency(tx),
      targetDimensionId: targetDimension,
      distributionAmount: amountEur,
      auditSummary: `Confirmed one-sided inter-account transfer ${amountEur} EUR (${sourceTitle} -> ${targetTitle})`,
      auditDetails: { amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date },
    });
    recordInterAccountJournal(
      tx.accounts_dimensions_id, targetDimension, amountEur, tx.date,
      undefined, transferReferenceOf(tx, guard.journals),
    );
    if (tx.clients_id == null) await resolveCompanyClientsId();
  }

  // A proposal needs the journal to have no other claimant in this run.
  for (const { row, proposal } of mirrorProposals) {
    const claimants = skippedAlreadyHandled.filter(other => other.existing_journal_id === proposal.journal_id).length +
      (mirrorReviewJournalClaims.get(proposal.journal_id) ?? 0);
    if (claimants !== 1) continue;
    row.mirror_proposal = proposal;
    row.next_action = { tool: "delete_transaction", args: { id: row.transaction_id }, approval_required: true };
    row.reason = `Already journalized from the other account side: journal #${proposal.journal_id} books confirmed transaction ${proposal.counterpart_transaction_id}, and this PROJECT row is its likely mirror. Verify against the bank statements, then delete it with delete_transaction only after the owner explicitly approves; reconcile never deletes it automatically.`;
  }

  const companyClientsId = await resolveCompanyClientsId();
  for (const action of confirmActions) {
    const source = allTx.get(action.confirmedTxId)!;
    const mirror = action.deleteTxId == null ? undefined : allTx.get(action.deleteTxId);
    action.sourceMaterial = snapshotBankTransaction(source);
    if (mirror) action.mirrorMaterial = snapshotBankTransaction(mirror);
    action.mappingMaterial = transferMappingMaterial(bankAccounts, accountDimensions);
    const pair = matchedPairs.find(row => row.outgoing_transaction_id === action.confirmedTxId);
    const single = matchedOneSided.find(row => row.transaction_id === action.confirmedTxId);
    const reasons = pair?.match_reasons ?? single?.match_reasons ?? [];
    action.pairEvidence = {kind: pair ? reasons.some(reason => reason.startsWith("same_type_")) ? "same_type" : "reciprocal" : "one_sided",
      reasons, maxDateGap: maxGap, sourceSide: action.sourceMaterial.trusted_direction === "incoming" ? "D" : "C"};
  }
  return finish(companyClientsId);
}

// Helper to build the account distribution used by inter-account confirms.
function transferMappingMaterial(bankAccounts: Parameters<typeof buildBankAccountLookups>[0], dimensions: Parameters<typeof buildBankAccountLookups>[1]): string {
  const mapping = buildBankAccountLookups(bankAccounts, dimensions);
  return canonicalPlanJson({iban: [...mapping.dimensionToIban].sort((a,b)=>a[0]-b[0]),
    accounts:[...mapping.dimensionToAccountsId].sort((a,b)=>a[0]-b[0]),
    own:[...mapping.ownIbanToDimension].map(([iban,dims])=>[iban,[...dims].sort((a,b)=>a-b)]).sort()});
}

function buildAccountDistribution(dimensionToAccountsId: Map<number, number>, targetDimensionId: number, amount: number) {
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

export async function prepareInterAccount(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: InterAccountInput,
): Promise<InterAccountPreview> {
  const match = await runInterAccountMatching(api, input);
  if (input.mintPlanHandles === false) return { match };
  const planCommandProjections = buildInterAccountPlanCommandProjections(match.confirmActions, match.companyClientsId);

  const planHandle = runtimeSafetyContext.planStore.issue(
    BANK_RECONCILIATION_PLAN_DOMAIN,
    buildReconciliationExecutionPlanInput({
      normalizedArgs: match.normalizedArgs as PlanRecord,
      sourceIdentities: [],
      liveSnapshot: { kind: "inter_account" },
      reviewCommands: planCommandProjections.map(command => ({
        id: command.id,
        category: command.category,
        reviewProjection: stripUndefinedDeep({ ...command, category: undefined, id: undefined }),
      })),
      fingerprint: match.fingerprint,
      counts: {
        total_unconfirmed: match.totalUnconfirmed,
        matched_pairs: match.matchedPairs.length,
        matched_one_sided: match.matchedOneSided.length,
      },
      totals: {},
      exclusions: [...match.skippedAlreadyHandled, ...match.ambiguousRefless, ...match.crossCurrencyPairs].map(row => stripUndefinedDeep(row as unknown as PlanRecord)),
      reviews: match.ambiguousPairs.map(row => stripUndefinedDeep(row as unknown as PlanRecord)),
    }),
  );

  return { match, planHandle };
}

export async function executeInterAccount(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: InterAccountExecutionInput,
): Promise<ReconExecResult<InterAccountExecution>> {
  const match = await runInterAccountMatching(api, input, { fresh: true });
  const dimensionToAccountsId = match.dimensionToAccountsId;
  const companyClientsId = match.companyClientsId;

  const plan_handle = input.planHandle;
  if (typeof plan_handle !== "string" || plan_handle.length === 0) {
    return { ok: false, failure: { kind: "plan_handle_required", category: "plan_handle_required", message: "A reviewed execution-plan handle from the inter-account dry run is required to confirm transfers." } };
  }
  let storedPlan;
  try {
    storedPlan = runtimeSafetyContext.planStore.consume(plan_handle, BANK_RECONCILIATION_PLAN_DOMAIN);
  } catch (error) {
    if (error instanceof PlanStoreError) return { ok: false, failure: { kind: "plan_store_error", category: error.code, message: error.message } };
    throw error;
  }
  const storedFingerprint = isRecord(storedPlan.privatePayload) ? storedPlan.privatePayload.fingerprint : undefined;
  if (typeof storedFingerprint !== "string" || storedFingerprint !== match.fingerprint) {
    return { ok: false, failure: { kind: "plan_drift", category: "plan_drift", message: "The reviewed inter-account plan no longer matches the current ledger." } };
  }
  if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(match.normalizedArgs)) {
    return { ok: false, failure: { kind: "plan_drift", category: "plan_drift", message: "The inter-account arguments changed since the plan was reviewed." } };
  }

  const commands: ReconciliationExecutionCommand[] = [];
  for (const action of match.confirmActions) {
    const needsClientUpdate = action.confirmedClientsId == null && companyClientsId != null;
    let clientWritten = false;
    let sourceConfirmed = false;
    const sourceExpected = () => action.sourceMaterial && ({...action.sourceMaterial,
      clients_id: clientWritten ? companyClientsId : action.sourceMaterial.clients_id});
    const verifyPairEvidence = (source: Transaction, mirror: Transaction | undefined, bankAccounts: Parameters<typeof buildBankAccountLookups>[0], accountDimensions: Parameters<typeof buildBankAccountLookups>[1]) => {
      if (!action.pairEvidence) return false;
      const mapping = buildBankAccountLookups(bankAccounts, accountDimensions);
      const lookups: InterAccountMatchLookups = {...mapping, companyName:normalizeCompanyName(match.invoiceInfo.invoice_company_name ?? ""), companyLegalName:match.invoiceInfo.invoice_company_name ?? "", targetAccountsDimensionsId:input.targetAccountsDimensionsId};
      const sourceInference = inferOneSidedTransfer(source, lookups, new Map());
      if (!mirror) return sourceInference.targetDimension === action.targetDimensionId && sourceInference.confidence >= ONE_SIDED_MIN_CONFIDENCE && !sourceInference.reasons.includes(COUNTERPARTY_IBAN_NOT_REGISTERED);
      const compatibility = getTransferPairCompatibility(source, mirror, action.pairEvidence.maxDateGap);
      if (!compatibility || compatibility.conflictingComparableAmounts || !sameAmountToTheCent(compatibility.txAComparableAmount, action.distributionAmount)) return false;
      if (action.pairEvidence.kind === "same_type") return !!getSameTypeReciprocalEvidence(source, mirror, sourceInference, inferOneSidedTransfer(mirror, lookups, new Map()), mapping.dimensionToIban);
      const origin = hasMirrorOwnOriginEvidence(mirror, source, lookups);
      const sourceIban = counterpartyIbanOf(source);
      return !!origin && (sourceInference.targetDimension === mirror.accounts_dimensions_id
        || !!(sourceIban && mapping.ownIbanToDimension.get(sourceIban)?.has(mirror.accounts_dimensions_id!)));
    };
    const verifyTransferMaterial = async (source: Transaction) => {
      const expected = sourceExpected();
      if (!expected || !compareBankTransactionMaterial(expected, source).ok) return false;
      let mirror: Transaction | undefined;
      if (action.deleteTxId != null) {
        mirror = await api.transactions.get(action.deleteTxId);
        if (!action.mirrorMaterial || !compareBankTransactionMaterial(action.mirrorMaterial, mirror).ok || !isProjectTransaction(mirror)) return false;
      }
      const [bankAccounts, accountDimensions] = await Promise.all([api.readonly.getBankAccounts({fresh:true}), api.readonly.getAccountDimensions({fresh:true})]);
      if (action.mappingMaterial !== transferMappingMaterial(bankAccounts, accountDimensions)) return false;
      api.transactions.invalidateListCache();
      const finalSource=await api.transactions.get(action.confirmedTxId);
      if (!compareBankTransactionMaterial(expected,finalSource).ok) return false;
      if (action.deleteTxId!=null) {
        mirror=await api.transactions.get(action.deleteTxId);
        if (!action.mirrorMaterial || !compareBankTransactionMaterial(action.mirrorMaterial,mirror).ok || !isProjectTransaction(mirror)) return false;
      }
      return verifyPairEvidence(finalSource, mirror, bankAccounts, accountDimensions);
    };
    if (needsClientUpdate) {
      commands.push({
        id: reconClientUpdateCommandId(action.confirmedTxId),
        category: RECON_UPDATE_CLIENT_CATEGORY,
        prepare: async () => {
          api.transactions.invalidateListCache(); // uncached: gates the mutation below
          const fresh = await api.transactions.get(action.confirmedTxId);
          if (!(await verifyTransferMaterial(fresh))) return {outcome: "drift", error_code: "transaction_material_drift"};
          if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "transaction_not_project" };
          if (fresh.clients_id != null) return { outcome: "drift", error_code: "client_already_set" };
          return { outcome: "ready" };
        },
        mutate: async () => {
          try {
            await api.transactions.update(action.confirmedTxId, { clients_id: companyClientsId ?? undefined });
            clientWritten = true;
            return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: action.confirmedTxId, outcome: "updated" }] };
          } catch (err) {
            if (err instanceof MutationIndeterminateError) return { outcome: "indeterminate", error_code: "mutation_outcome_unknown" };
            return { outcome: "failed", error_code: "client_update_failed", mutation_occurred: false };
          }
        },
      });
    }
    commands.push({
      id: reconTransferConfirmCommandId(action.confirmedTxId),
      category: RECON_CONFIRM_TRANSFER_CATEGORY,
      prepare: async () => {
        api.transactions.invalidateListCache(); // uncached: gates the mutation below
        const fresh = await api.transactions.get(action.confirmedTxId);
        if (!(await verifyTransferMaterial(fresh))) return {outcome: "drift", error_code: "transaction_material_drift"};
        if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "transaction_not_project" };
        if (roundMoney(fresh.amount) !== roundMoney(action.confirmedNominalAmount)) return { outcome: "drift", error_code: "amount_changed" };
        if (transactionCurrency(fresh) !== action.confirmedCurrency) return { outcome: "drift", error_code: "currency_changed" };
        return { outcome: "ready" };
      },
      mutate: async () => {
        let distribution;
        try {
          distribution = buildAccountDistribution(dimensionToAccountsId, action.targetDimensionId, action.distributionAmount);
        } catch {
          return { outcome: "failed", error_code: "distribution_unresolvable", mutation_occurred: false };
        }
        try {
          await api.transactions.confirm(action.confirmedTxId, [distribution], { autoFixClientsId: false, expectedTransaction: sourceExpected(), expectedLinkedInvoices: {} });
          sourceConfirmed = true;
          logAudit({
            tool: "reconcile_inter_account_transfers", action: "CONFIRMED", entity_type: "transaction",
            entity_id: action.confirmedTxId,
            summary: action.auditSummary,
            details: action.auditDetails,
          });
          return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: action.confirmedTxId, outcome: "confirmed" }] };
        } catch (err) {
          if (err instanceof TransactionMaterialDriftError) return {outcome: "failed", error_code: err.category, mutation_occurred: err.mutation_occurred, known_objects: err.known_objects};
          if (err instanceof MutationIndeterminateError) return { outcome: "indeterminate", error_code: "mutation_outcome_unknown" };
          return { outcome: "failed", error_code: confirmRefusalErrorCode(err), mutation_occurred: false };
        }
      },
    });
    if (action.deleteTxId !== undefined) {
      const deleteTxId = action.deleteTxId;
      commands.push({
        id: reconDeleteDuplicateCommandId(deleteTxId),
        category: RECON_DELETE_DUPLICATE_CATEGORY,
        prepare: async () => {
          api.transactions.invalidateListCache(); // uncached: gates the mutation below
          let fresh = await api.transactions.get(deleteTxId);
          if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "duplicate_not_project" };
          if (!sourceConfirmed || !action.mirrorMaterial || !compareBankTransactionMaterial(action.mirrorMaterial, fresh).ok) return {outcome: "drift", error_code: "mirror_material_drift"};
          let source = await api.transactions.get(action.confirmedTxId);
          const expected = sourceExpected();
          if (!expected || source.status !== "CONFIRMED" || source.is_deleted || !compareBankTransactionMaterial(expected, {...source, status: expected.status!, items: []}).ok || expected.items.length) return {outcome: "drift", error_code: "confirmed_source_material_drift"};
          const [bankAccounts, accountDimensions] = await Promise.all([api.readonly.getBankAccounts({fresh:true}), api.readonly.getAccountDimensions({fresh:true})]);
          if (action.mappingMaterial !== transferMappingMaterial(bankAccounts, accountDimensions) || !verifyPairEvidence(source, fresh, bankAccounts, accountDimensions)) return {outcome: "drift", error_code: "bank_mapping_drift"};
          api.journals.invalidateListCache();
          const journals = findRegistrationJournal(await api.journals.listAllWithPostings(), action.confirmedTxId);
          if (journals.length !== 1) return {outcome: "drift", error_code: "registration_journal_unproven"};
          let journal = journals[0]!;
          if ((journal.postings?.length ?? 0)===0 && journal.id!=null) journal=await api.journals.get(journal.id);
          if(findRegistrationJournal([journal],action.confirmedTxId).length!==1) return {outcome:"drift",error_code:"registration_journal_unproven"};
          action.registrationJournalId = journal.id;
          // Journal/reference reads above may await another actor's correction.
          // Re-read source and make the reviewed mirror the final awaited read.
          const [finalBanks,finalDimensions]=await Promise.all([api.readonly.getBankAccounts({fresh:true}),api.readonly.getAccountDimensions({fresh:true})]);
          if(action.mappingMaterial!==transferMappingMaterial(finalBanks,finalDimensions)) return {outcome:"drift",error_code:"bank_mapping_drift"};
          api.transactions.invalidateListCache();
          source=await api.transactions.get(action.confirmedTxId);
          fresh=await api.transactions.get(deleteTxId);
          if(!compareBankTransactionMaterial(action.mirrorMaterial,fresh).ok || !isProjectTransaction(fresh)) return {outcome:"drift",error_code:"mirror_material_drift"};
          if(source.status!=="CONFIRMED" || source.is_deleted || !compareBankTransactionMaterial(expected,{...source,status:expected.status!,items:[]}).ok || !verifyPairEvidence(source,fresh,finalBanks,finalDimensions)) return {outcome:"drift",error_code:"confirmed_source_material_drift"};
          const postings = (journal.postings ?? []).filter(p => !p.is_deleted);
          if (postings.some(p=>!positiveEurAmount(p,journal.cl_currencies_id).ok)) return {outcome:"drift",error_code:"registration_eur_unproven"};
          const targetAccount = dimensionToAccountsId.get(action.targetDimensionId);
          const sourceSide = action.pairEvidence!.sourceSide;
          const targetSide = sourceSide === "D" ? "C" : "D";
          const correct = postings.length === 2 && postings.some(p => p.accounts_id === expected.accounts_id && p.accounts_dimensions_id === expected.accounts_dimensions_id && p.type === sourceSide && sameAmountToTheCent(p.base_amount ?? p.amount, action.distributionAmount))
            && postings.some(p => p.accounts_id === targetAccount && p.accounts_dimensions_id === action.targetDimensionId && p.type === targetSide && sameAmountToTheCent(p.base_amount ?? p.amount, action.distributionAmount));
          if (!correct) return {outcome: "drift", error_code: "registration_postings_mismatch"};
          const distributionProof=confirmedDistributionEvidence(source, [buildAccountDistribution(dimensionToAccountsId, action.targetDimensionId, action.distributionAmount)]);
          if (!distributionProof.ok) return {outcome: "drift", error_code: "confirmed_distribution_drift"};
          action.linkageEvidence=distributionProof.linkage_absent?"absent_actual_journal_proves_distribution":"get_distribution";
          return { outcome: "ready" };
        },
        mutate: async () => {
          try {
            await api.transactions.delete(deleteTxId);
            logAudit({
              tool: "reconcile_inter_account_transfers", action: "DELETED", entity_type: "transaction",
              entity_id: deleteTxId,
              summary: action.deleteAuditSummary ?? `Deleted duplicate mirror row ${deleteTxId} after confirming ${action.confirmedTxId}`,
              details: action.deleteAuditDetails ?? { paired_confirmed_id: action.confirmedTxId },
            });
            return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: deleteTxId, outcome: "deleted" }] };
          } catch (err) {
            if (err instanceof MutationIndeterminateError) return { outcome: "indeterminate", error_code: "mutation_outcome_unknown" };
            return { outcome: "failed", error_code: "delete_failed", mutation_occurred: false };
          }
        },
      });
    }
  }

  const executionReport = await executeReconciliationCommands(commands);
  const completedIds = new Set(executionReport.command_partitions.completed.map(item => item.command_id));
  for (const pair of match.matchedPairs) {
    const action=match.confirmActions.find(action=>action.confirmedTxId===pair.outgoing_transaction_id);
    if(action?.registrationJournalId!=null)pair.registration_journal_id=action.registrationJournalId;
    if(action?.linkageEvidence)pair.linkage_evidence=action.linkageEvidence;
    const confirmed = completedIds.has(reconTransferConfirmCommandId(pair.outgoing_transaction_id));
    const deleted = completedIds.has(reconDeleteDuplicateCommandId(pair.incoming_transaction_id));
    pair.status = confirmed ? "confirmed" : "not_confirmed";
    if (deleted) {
      pair.incoming_action = "deleted";
    } else if (confirmed) {
      pair.incoming_action = "orphan";
      pair.incoming_note = `Transaction ${pair.outgoing_transaction_id} was confirmed; row ${pair.incoming_transaction_id} was retained. Re-read both transactions and the registration journal for manual review before any correction. See execution_report for the stop reason.`;
      match.errors.push({ transaction_ids: [pair.outgoing_transaction_id, pair.incoming_transaction_id], ...(action?.registrationJournalId!=null?{journal_id:action.registrationJournalId}:{}), reason: pair.incoming_note });
    } else {
      pair.incoming_action = "would_delete_duplicate";
    }
  }
  for (const single of match.matchedOneSided) {
    single.status = completedIds.has(reconTransferConfirmCommandId(single.transaction_id)) ? "confirmed" : "not_confirmed";
  }

  return { ok: true, data: { match, executionReport } };
}
