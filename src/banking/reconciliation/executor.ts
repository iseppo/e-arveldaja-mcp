import type { ApiContext } from "../../tools/crud/shared.js";
import type { Transaction, SaleInvoice, PurchaseInvoice } from "../../types/api.js";
import { isProjectTransaction } from "../../transaction-status.js";
import { roundMoney } from "../../money.js";
import { normalizeCompanyName } from "../../company-name.js";
import { bankTransactionDirection } from "../../bank-transaction-direction.js";
import { logAudit } from "../../audit-log.js";
import { reportProgress } from "../../progress.js";
import { MutationIndeterminateError } from "../../mutation-outcome.js";
import { PlanStoreError, type PlanRecord } from "../../plan-store.js";
import { isRecord } from "../../record-utils.js";
import { BookingGuard, type InterAccountResolution } from "../../booking-guard.js";
import type { RuntimeSafetyContext } from "../../runtime-safety-context.js";
import { buildBankAccountLookups, toUtcDay } from "../../tools/inter-account-utils.js";
import {
  findDuplicateBankPostings,
  resolveBankDimensionsSafe,
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
import { matchScore, getInvoiceMatchEligibility, buildSuggestedDistribution, comparableTransactionAmount, type MatchCandidate } from "./match-score.js";
import { hasMeaningfulComparableAmount, resolveOneSidedTransferAmount, transactionCurrency } from "./amount-resolution.js";
import {
  inferOneSidedTransfer,
  getTransferPairCompatibility,
  getSameTypeReciprocalEvidence,
  type InterAccountMatchLookups,
  type OneSidedInference,
} from "./inter-account-matcher.js";
import { computeExactMatchProjection } from "./duplicate-policy.js";
import {
  exactMatchFingerprint,
  buildInterAccountPlanCommandProjections,
  interAccountFingerprint,
} from "./projection.js";
import { exactMatchReviewCommands } from "./presenter.js";
import type {
  BlockedDuplicateSuspect,
  ExactConfirmExecution,
  ExactConfirmExecutionInput,
  ExactConfirmInput,
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
  SkippedAlreadyHandledRow,
  AmbiguousReflessRow,
  CrossCurrencyRow,
  InterAccountErrorRow,
  SuggestMatchesInput,
} from "./types.js";

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
  const openSales = allSales.filter((inv: SaleInvoice) =>
    inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
  );

  const allPurchases = await api.purchaseInvoices.listAll();
  const openPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
    inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
  );

  const saleIndex = buildInvoiceIndex(openSales);
  const purchaseIndex = buildInvoiceIndex(openPurchases);
  // Cross-mechanism duplicate guard (Task 3): resolve bank dimensions once so
  // each matched row can be checked against already-booked cash movements.
  const suggestBankDimsResult = await resolveBankDimensionsSafe(api);
  const suggestDimById = new Map(suggestBankDimsResult.dimensions.map(d => [d.dimensionId, d]));
  const results: Array<Record<string, unknown>> = [];
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
      const distribution = crossCurrency
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
        const scan = await findDuplicateBankPostings(api, {
          accountId: suggestDim.accountId,
          dimensionId: suggestDim.dimensionId,
          amount: tx.base_amount ?? tx.amount,
          direction: bankTransactionDirection(tx) === "incoming" ? "D" : "C",
          date: tx.date,
        });
        if (scan.scan_available && scan.suspects.length > 0) {
          possibleDuplicatePostings = scan.suspects;
        }
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
        ...(bestMatch.partially_paid_warning
          ? { manual_review_required: "Invoice is PARTIALLY_PAID; verify the remaining open balance before confirming." }
          : {}),
        ...(crossCurrency
          ? { manual_review_required: "Cross-currency match: tx amount is in a different currency than the invoice gross. Compute the correct distribution amount manually before confirming." }
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

/**
 * Cross-mechanism duplicate guard for the exact-match confirm flow (Task 3).
 * Runs identically in the dry-run and execute paths so the re-derived execute
 * projection matches the reviewed plan fingerprint.
 */
async function enrichExactMatchProjectionWithDuplicateGuard(
  api: ApiContext,
  projection: ExactMatchProjection,
  blockOnDuplicate: boolean,
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
    const scan = await findDuplicateBankPostings(api, candidate);

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
    },
    totals: {},
    exclusions: projection.skipped.map(row => stripUndefinedDeep({ transaction_id: row.transaction_id, reason: row.reason })),
    reviews: [],
  });
  return runtimeSafetyContext.planStore.issue(BANK_RECONCILIATION_PLAN_DOMAIN, planInput);
}

function buildExactMatchCommands(api: ApiContext, projection: ExactMatchProjection): ReconciliationExecutionCommand[] {
  const commands: ReconciliationExecutionCommand[] = [];
  for (const descriptor of projection.confirms) {
    if (descriptor.needsClientUpdate) {
      commands.push({
        id: reconClientUpdateCommandId(descriptor.transactionId),
        category: RECON_UPDATE_CLIENT_CATEGORY,
        prepare: async () => {
          const fresh = await api.transactions.get(descriptor.transactionId);
          if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "transaction_not_project" };
          if (fresh.clients_id != null) return { outcome: "drift", error_code: "client_already_set" };
          return { outcome: "ready" };
        },
        mutate: async () => {
          try {
            await api.transactions.update(descriptor.transactionId, { clients_id: descriptor.invoiceClientsId ?? undefined });
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
        const fresh = await api.transactions.get(descriptor.transactionId);
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
            { autoFixClientsId: false },
          );
          logAudit({
            tool: "auto_confirm_exact_matches", action: "CONFIRMED", entity_type: "transaction",
            entity_id: descriptor.transactionId,
            summary: `Confirmed transaction ${descriptor.transactionId} against ${descriptor.invoiceType} #${descriptor.invoiceId} (${descriptor.invoiceNumber})`,
            details: { amount: descriptor.amount, distributions: [{ related_table: descriptor.invoiceTable, related_id: descriptor.invoiceId, amount: descriptor.amount }] },
          });
          return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: descriptor.transactionId, outcome: "confirmed" }] };
        } catch (err) {
          if (err instanceof MutationIndeterminateError) return { outcome: "indeterminate", error_code: "mutation_outcome_unknown" };
          return { outcome: "failed", error_code: "confirm_failed", mutation_occurred: false };
        }
      },
    });
  }
  return commands;
}

async function loadExactMatchProjection(
  api: ApiContext,
  input: ExactConfirmInput,
): Promise<{ projection: ExactMatchProjection; threshold: number }> {
  const threshold = input.minConfidence ?? 90;
  const allTx = await api.transactions.listAll();
  const unconfirmed = allTx.filter(isProjectTransaction);
  const total = unconfirmed.length;
  for (let i = 0; i < total; i++) await reportProgress(i, total);

  const allSales = await api.saleInvoices.listAll();
  const openSales = allSales.filter((inv: SaleInvoice) =>
    inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
  );
  const allPurchases = await api.purchaseInvoices.listAll();
  const openPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
    inv.payment_status !== "PAID" && inv.status === "CONFIRMED"
  );

  const projection = computeExactMatchProjection(unconfirmed, openSales, openPurchases, threshold);
  await enrichExactMatchProjectionWithDuplicateGuard(api, projection, input.blockOnDuplicate === true);
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
  const { projection, threshold } = await loadExactMatchProjection(api, input);

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
  return { ok: true, data: { projection, executionReport, threshold } };
}

// === Inter-account transfers =================================================

export async function runInterAccountMatching(
  api: ApiContext,
  input: InterAccountInput,
): Promise<InterAccountMatchResult> {
  const maxGap = validateInterAccountDateGap(input.maxDateGap);
  const target_accounts_dimensions_id = input.targetAccountsDimensionsId;

  const confirmActions: InterAccountConfirmAction[] = [];

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

  const lookups: InterAccountMatchLookups = {
    ownIbanToDimension,
    dimensionToIban,
    companyName,
    targetAccountsDimensionsId: target_accounts_dimensions_id,
  };

  const outgoing = unconfirmed.filter(tx => bankTransactionDirection(tx) === "outgoing");
  const incoming = unconfirmed.filter(tx => bankTransactionDirection(tx) === "incoming");

  const matchedPairs: PairResult[] = [];
  const ambiguousPairs: AmbiguousPairResult[] = [];
  const matchedOneSided: OneSidedResult[] = [];
  const skippedAlreadyHandled: SkippedAlreadyHandledRow[] = [];
  const ambiguousRefless: AmbiguousReflessRow[] = [];
  const crossCurrencyPairs: CrossCurrencyRow[] = [];
  const errors: InterAccountErrorRow[] = [];
  const consumedTxIds = new Set<number>();
  const blockedOneSidedTxIds = new Set<number>();

  // Load one BookingGuard snapshot of existing confirmed inter-account journals.
  const guard = await BookingGuard.load(api, { ownDimensionIds });

  function resolveExistingJournal(
    sourceDim: number, targetDim: number, amount: number, date: string, maxGapDays: number,
    referenceNumber: string | null | undefined, consume: boolean,
  ): InterAccountResolution {
    return guard.resolveInterAccount(
      { sourceDim, targetDim, amount, date, maxGapDays, reference: referenceNumber },
      { consume },
    );
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

      const compatibility = getTransferPairCompatibility(txOut, txIn, maxGap);
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
        const txOutOneSided = inferOneSidedTransfer(txOut, lookups, oneSidedInferenceCache);
        const txInOneSided = inferOneSidedTransfer(txIn, lookups, oneSidedInferenceCache);
        const mutuallyConsistentOneSidedTargets =
          txOutOneSided.targetDimension === txIn.accounts_dimensions_id &&
          txInOneSided.targetDimension === txOut.accounts_dimensions_id;
        if (mutuallyConsistentOneSidedTargets) {
          blockedOneSidedTxIds.add(txOut.id);
          blockedOneSidedTxIds.add(txIn.id);
        }
        continue;
      }

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
      blockedOneSidedTxIds.add(txOut.id);
      for (const candidate of topCandidates) blockedOneSidedTxIds.add(candidate.txIn.id!);
      continue;
    }

    const bestCandidate = topCandidates[0]!;
    const txIn = bestCandidate.txIn;

    const fromTitle = dimensionToTitle.get(txOut.accounts_dimensions_id) ?? `dim:${txOut.accounts_dimensions_id}`;
    const toTitle = dimensionToTitle.get(txIn.accounts_dimensions_id) ?? `dim:${txIn.accounts_dimensions_id}`;

    const resolution = resolveExistingJournal(
      txOut.accounts_dimensions_id, txIn.accounts_dimensions_id,
      bestCandidate.comparableAmount, txOut.date, maxGap,
      txOut.bank_ref_number ?? txOut.ref_number, true,
    );
    if (resolution.status === "matched") {
      consumedTxIds.add(txOut.id);
      consumedTxIds.add(txIn.id!);
      skippedAlreadyHandled.push(
        { transaction_id: txOut.id, amount: txOut.amount, date: txOut.date, source_account: dimensionToTitle.get(txOut.accounts_dimensions_id) ?? "", existing_journal_id: resolution.journal_id, reason: "Already journalized" },
        { transaction_id: txIn.id!, amount: txIn.amount, date: txIn.date, source_account: dimensionToTitle.get(txIn.accounts_dimensions_id) ?? "", existing_journal_id: resolution.journal_id, reason: "Already journalized" },
      );
      continue;
    }
    if (resolution.status === "ambiguous_refless") {
      consumedTxIds.add(txOut.id);
      consumedTxIds.add(txIn.id!);
      ambiguousRefless.push({
        transaction_ids: [txOut.id, txIn.id!], amount: txOut.amount, date: txOut.date,
        source_account: fromTitle, target_account: toTitle,
        reason: "A same-key inter-account journal (matching amount/date/accounts) was already booked this run and its reference does not disambiguate; cannot tell a genuine second transfer from a duplicate mirror leg. Confirm inline if this is a real second transfer.",
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
      distributionAmount: txOut.amount,
      deleteTxId: txIn.id!,
      auditSummary: `Confirmed inter-account outgoing ${txOut.amount} EUR (${fromTitle} -> ${toTitle})`,
      auditDetails: { amount: txOut.amount, date: txOut.date, paired_incoming_id: txIn.id },
      deleteAuditSummary: `Deleted duplicate incoming row ${txIn.id} after confirming outgoing ${txOut.id} (${fromTitle} -> ${toTitle})`,
      deleteAuditDetails: { amount: txIn.amount, date: txIn.date, paired_outgoing_id: txOut.id },
    });
    recordInterAccountJournal(
      txOut.accounts_dimensions_id, txIn.accounts_dimensions_id, comparableTransactionAmount(txOut), txOut.date,
      undefined, txOut.bank_ref_number ?? txOut.ref_number,
    );
    if (txOut.clients_id == null) await resolveCompanyClientsId();
  }

  // --- Phase 1b: reciprocal same-type pairs with strong mutual target evidence ---
  const phaseOneRemaining = unconfirmed.filter(
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
      if (other.type !== tx.type) continue;
      if (other.accounts_dimensions_id !== txInference.targetDimension) continue;

      const otherInference = inferOneSidedTransfer(other, lookups, oneSidedInferenceCache);
      if (otherInference.confidence < 50 || otherInference.targetDimension !== tx.accounts_dimensions_id) continue;

      const reciprocalEvidence = getSameTypeReciprocalEvidence(tx, other, txInference, otherInference, dimensionToIban);
      if (!reciprocalEvidence) continue;

      const compatibility = getTransferPairCompatibility(tx, other, maxGap);
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
    const counterpart = bestCandidate.counterpart;

    if (!counterpart.id || consumedTxIds.has(counterpart.id) || blockedOneSidedTxIds.has(counterpart.id)) {
      continue;
    }

    const fromTitleEarly = dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`;
    const toTitleEarly = dimensionToTitle.get(counterpart.accounts_dimensions_id) ?? `dim:${counterpart.accounts_dimensions_id}`;

    const resolution = resolveExistingJournal(
      tx.accounts_dimensions_id, counterpart.accounts_dimensions_id,
      bestCandidate.comparableAmount, tx.date, maxGap,
      tx.bank_ref_number ?? tx.ref_number, true,
    );
    if (resolution.status === "matched") {
      consumedTxIds.add(tx.id);
      consumedTxIds.add(counterpart.id);
      skippedAlreadyHandled.push(
        {
          transaction_id: tx.id,
          amount: tx.amount,
          date: tx.date,
          source_account: dimensionToTitle.get(tx.accounts_dimensions_id) ?? "",
          existing_journal_id: resolution.journal_id,
          reason: "Already journalized",
        },
        {
          transaction_id: counterpart.id,
          amount: counterpart.amount,
          date: counterpart.date,
          source_account: dimensionToTitle.get(counterpart.accounts_dimensions_id) ?? "",
          existing_journal_id: resolution.journal_id,
          reason: "Already journalized",
        },
      );
      continue;
    }
    if (resolution.status === "ambiguous_refless") {
      consumedTxIds.add(tx.id);
      consumedTxIds.add(counterpart.id);
      ambiguousRefless.push({
        transaction_ids: [tx.id, counterpart.id], amount: tx.amount, date: tx.date,
        source_account: fromTitleEarly, target_account: toTitleEarly,
        reason: "A same-key inter-account journal (matching amount/date/accounts) was already booked this run and its reference does not disambiguate; cannot tell a genuine second transfer from a duplicate mirror leg. Confirm inline if this is a real second transfer.",
      });
      continue;
    }

    const fromTitle = dimensionToTitle.get(tx.accounts_dimensions_id) ?? `dim:${tx.accounts_dimensions_id}`;
    const toTitle = dimensionToTitle.get(counterpart.accounts_dimensions_id) ?? `dim:${counterpart.accounts_dimensions_id}`;

    consumedTxIds.add(tx.id);
    consumedTxIds.add(counterpart.id);

    const crossCurrencyPair =
      bestCandidate.reasons.includes("exact_base_amount") &&
      !bestCandidate.reasons.includes("exact_amount") &&
      hasMeaningfulComparableAmount(tx);
    if (crossCurrencyPair) {
      crossCurrencyPairs.push({
        transaction_ids: [tx.id, counterpart.id],
        amount_out: tx.amount, amount_in: counterpart.amount, date: tx.date,
        source_account: fromTitle, target_account: toTitle,
        reason: "Cross-currency inter-account pair matched on base amount only; the legs have different nominal amounts. Auto-distributing the outgoing nominal amount would misbook the target leg. Confirm inline with the correct per-account amounts.",
      });
      continue;
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
      description_out: tx.description ?? undefined,
      description_in: counterpart.description ?? undefined,
      confidence: bestCandidate.confidence,
      match_reasons: bestCandidate.reasons,
      status: "would_confirm",
      incoming_action: "would_delete_duplicate",
    });
    confirmActions.push({
      confirmedTxId: tx.id,
      confirmedClientsId: tx.clients_id ?? null,
      confirmedNominalAmount: tx.amount,
      confirmedCurrency: transactionCurrency(tx),
      targetDimensionId: counterpart.accounts_dimensions_id,
      distributionAmount: tx.amount,
      deleteTxId: counterpart.id,
      auditSummary: `Confirmed reciprocal same-type inter-account transfer ${tx.amount} EUR (${fromTitle} -> ${toTitle})`,
      auditDetails: { amount: tx.amount, date: tx.date, paired_counterpart_id: counterpart.id },
      deleteAuditSummary: `Deleted reciprocal same-type duplicate row ${counterpart.id} after confirming ${tx.id} (${fromTitle} -> ${toTitle})`,
      deleteAuditDetails: { amount: counterpart.amount, date: counterpart.date, paired_confirmed_id: tx.id },
    });
    recordInterAccountJournal(
      tx.accounts_dimensions_id, counterpart.accounts_dimensions_id, comparableTransactionAmount(tx), tx.date,
      undefined, tx.bank_ref_number ?? tx.ref_number,
    );
    if (tx.clients_id == null) await resolveCompanyClientsId();
  }

  // --- Phase 2: one-sided transfers (counterparty = company name or own IBAN) ---
  const remaining = unconfirmed.filter(
    tx => tx.id && !consumedTxIds.has(tx.id) && !blockedOneSidedTxIds.has(tx.id),
  );

  for (const tx of remaining) {
    if (!tx.id) continue;
    const { targetDimension, confidence, reasons } = inferOneSidedTransfer(tx, lookups, oneSidedInferenceCache);

    if (confidence < 50 || !targetDimension) continue;

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

    const resolution = resolveExistingJournal(
      tx.accounts_dimensions_id,
      targetDimension,
      amountEur,
      tx.date,
      maxGap,
      tx.bank_ref_number ?? tx.ref_number,
      true,
    );
    if (resolution.status === "matched") {
      consumedTxIds.add(tx.id);
      skippedAlreadyHandled.push({
        transaction_id: tx.id, amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date,
        source_account: sourceTitle, source_dimension_id: tx.accounts_dimensions_id,
        target_account: targetTitle, target_dimension_id: targetDimension,
        existing_journal_id: resolution.journal_id,
        reason: "Already journalized from the other account side",
      });
      continue;
    }
    if (resolution.status === "ambiguous_refless") {
      consumedTxIds.add(tx.id);
      ambiguousRefless.push({
        transaction_ids: [tx.id], amount: nominalAmount, currency, amount_eur: amountEur, date: tx.date,
        source_account: sourceTitle, target_account: targetTitle,
        reason: "A same-key inter-account journal (matching amount/date/accounts) was already booked this run and its reference does not disambiguate; cannot tell a genuine second transfer from a duplicate mirror leg. Confirm inline if this is a real second transfer.",
      });
      continue;
    }

    consumedTxIds.add(tx.id);

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
      undefined, tx.bank_ref_number ?? tx.ref_number,
    );
    if (tx.clients_id == null) await resolveCompanyClientsId();
  }

  const companyClientsId = await resolveCompanyClientsId();
  const planCommandProjections = buildInterAccountPlanCommandProjections(confirmActions, companyClientsId);
  const normalizedArgs = stripUndefinedDeep({
    max_date_gap: maxGap,
    target_accounts_dimensions_id,
  }) as PlanRecord;
  const fingerprint = interAccountFingerprint({
    normalizedArgs,
    planCommandProjections,
    skippedAlreadyHandled,
    ambiguousPairs,
    ambiguousRefless,
    crossCurrencyPairs,
  });

  return {
    totalUnconfirmed: unconfirmed.length,
    invoiceInfo,
    dimensionToIban,
    dimensionToTitle,
    dimensionToAccountsId,
    matchedPairs,
    matchedOneSided,
    ambiguousPairs,
    skippedAlreadyHandled,
    ambiguousRefless,
    crossCurrencyPairs,
    errors,
    confirmActions,
    companyClientsId,
    normalizedArgs,
    fingerprint,
  };
}

// Helper to build the account distribution used by inter-account confirms.
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
  const match = await runInterAccountMatching(api, input);
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
    if (needsClientUpdate) {
      commands.push({
        id: reconClientUpdateCommandId(action.confirmedTxId),
        category: RECON_UPDATE_CLIENT_CATEGORY,
        prepare: async () => {
          const fresh = await api.transactions.get(action.confirmedTxId);
          if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "transaction_not_project" };
          if (fresh.clients_id != null) return { outcome: "drift", error_code: "client_already_set" };
          return { outcome: "ready" };
        },
        mutate: async () => {
          try {
            await api.transactions.update(action.confirmedTxId, { clients_id: companyClientsId ?? undefined });
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
        const fresh = await api.transactions.get(action.confirmedTxId);
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
          await api.transactions.confirm(action.confirmedTxId, [distribution], { autoFixClientsId: false });
          logAudit({
            tool: "reconcile_inter_account_transfers", action: "CONFIRMED", entity_type: "transaction",
            entity_id: action.confirmedTxId,
            summary: action.auditSummary,
            details: action.auditDetails,
          });
          return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: action.confirmedTxId, outcome: "confirmed" }] };
        } catch (err) {
          if (err instanceof MutationIndeterminateError) return { outcome: "indeterminate", error_code: "mutation_outcome_unknown" };
          return { outcome: "failed", error_code: "confirm_failed", mutation_occurred: false };
        }
      },
    });
    if (action.deleteTxId !== undefined) {
      const deleteTxId = action.deleteTxId;
      commands.push({
        id: reconDeleteDuplicateCommandId(deleteTxId),
        category: RECON_DELETE_DUPLICATE_CATEGORY,
        prepare: async () => {
          const fresh = await api.transactions.get(deleteTxId);
          if (!fresh || !isProjectTransaction(fresh)) return { outcome: "drift", error_code: "duplicate_not_project" };
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
    const confirmed = completedIds.has(reconTransferConfirmCommandId(pair.outgoing_transaction_id));
    const deleted = completedIds.has(reconDeleteDuplicateCommandId(pair.incoming_transaction_id));
    pair.status = confirmed ? "confirmed" : "not_confirmed";
    if (deleted) {
      pair.incoming_action = "deleted";
    } else if (confirmed) {
      pair.incoming_action = "orphan";
      pair.incoming_note = `Transaction ${pair.outgoing_transaction_id} was confirmed, but deleting the duplicate PROJECT row ${pair.incoming_transaction_id} did not complete. Manually delete ${pair.incoming_transaction_id} to avoid double-booking if it is later confirmed. See execution_report for the stop reason.`;
      match.errors.push({ transaction_ids: [pair.outgoing_transaction_id, pair.incoming_transaction_id], reason: pair.incoming_note });
    } else {
      pair.incoming_action = "would_delete_duplicate";
    }
  }
  for (const single of match.matchedOneSided) {
    single.status = completedIds.has(reconTransferConfirmCommandId(single.transaction_id)) ? "confirmed" : "not_confirmed";
  }

  return { ok: true, data: { match, executionReport } };
}
