import type { OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { isCompanyVatRegistered, safeJsonParse, tagNotes } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { ExecutionPlanInput, PlanData, PlanRecord } from "../plan-store.js";
import { canonicalPlanJson, stripUndefinedDeep } from "../tools/camt-plan.js";
import type { Client, PurchaseInvoiceItem, Transaction } from "../types/api.js";
import { roundMoney } from "../money.js";
import { reportProgress } from "../progress.js";
import { logAudit } from "../audit-log.js";
import { isProjectTransaction } from "../transaction-status.js";
import { HttpError } from "../http-client.js";
// canonicalBusinessText strips the display sandbox to recover the EXECUTABLE
// business value (M10). It is NOT wrapUntrustedOcr — the operation never wraps
// for output; the presenter owns all output-time sandboxing. Where the mutation
// loop must embed an untrusted fragment (a remitter-controlled counterparty, an
// upstream error body) into a note, it sandboxes just that span through the
// injected `wrapUntrustedText`, so this module never imports wrapUntrustedOcr.
// Note prose is otherwise server-authored and stays unfenced — a new notes.push
// that interpolates untrusted text must wrap that span itself.
import { canonicalBusinessText } from "../mcp-json.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "../tools/purchase-vat-defaults.js";
import {
  type TransactionClassificationCategory,
  categorizeTransactionGroup,
  deriveAutoBookedNetAmount,
  deriveAutoBookedVatPrice,
  getAutoBookedVatConfig,
  getBookingSuggestionVatConfig,
} from "../tools/receipt-extraction.js";
import { buildClassificationReviewGuidance } from "../estonian-accounting-guidance.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
// Shared classify helpers stay in receipt-inbox.ts (several are exported for the
// pure-unit tests). Importing them here forms the same runtime-safe body-only
// import cycle that batch-operations.ts already relies on: every cross-reference
// is used only inside function bodies, never at module-evaluation time.
import {
  type ClassifiedTransactionGroupResult,
  type PartialClassificationMutation,
  type PartialClassificationStatus,
  type TransactionGroup,
  buildOwnerCounterpartySet,
  existingInvoiceMatch,
  extractClassificationGroups,
  groupTransactionsByCounterparty,
  invoiceClassificationStatus,
  isAmbiguousPostCreateFailure,
  resolveClassificationSuggestion,
  resolveSupplierFromTransaction,
  shouldProcessExpenseAsPurchaseInvoice,
  transactionClassificationStatus,
} from "../tools/receipt-inbox.js";

// Typed classification operations. The interface references NO MCP types — inputs
// and results are plain typed data and the operation returns UNWRAPPED domain
// data. The presenter (./classification-presenter.js) owns ALL wrapUntrustedOcr
// (the analyze double-wrap of counterparty/description and the compact surface)
// plus the workflow / batch-execution envelope builders.
//
// The critical invariants are preserved EXACTLY: classifications_json is a
// pass-through frozen projection (no digest/plan binding); apply re-fetches each
// transaction by id and re-resolves the suggestion server-side; M10 de-sandboxes
// counterparty text with canonicalBusinessText BEFORE it drives rule-matching /
// audit; the three staged mutations (create+set-totals, confirm invoice, confirm
// transaction) stay distinct and guarded; an ambiguous post-create failure is
// surfaced as mutation_indeterminate and NEVER retried; a 404 skips while a
// transient 503/timeout/network is rethrown → group failed.

// P0-2: the execution-plan domain that binds a reviewed dry_run_apply preview to
// its execute_apply. A consumed handle is scope-bound (connection/company/profile)
// and consume-once; the fingerprint below proves the FRESH executable effect
// (which transactions, in which category/apply_mode, resolved to which supplier +
// booking) equals the reviewed one before the first API write.
export const BANK_CLASSIFICATION_PLAN_DOMAIN = "bank_classification";

function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}

function fail<T>(code: string, message: string): OperationOutcome<T> {
  return { ok: false, error: { code, message, retry: "never" }, blockers: [] };
}

/** Injected at the MCP boundary so this module never imports wrapUntrustedOcr.
 * Used only to sandbox an OCR-origin error message embedded in a note. */
export type WrapUntrustedText = (text: string | undefined | null) => string | undefined;

export interface UnmatchedAnalysisInput {
  accountsDimensionsId: number;
  dateFrom?: string;
  dateTo?: string;
}

/** UNWRAPPED analysis result. `groups[].{normalized_counterparty,
 * display_counterparty}` and `transactions[].{description,bank_account_name}`
 * carry raw bank-statement text — the presenter wraps them. */
export interface UnmatchedAnalysisResult {
  accountsDimensionsId: number;
  dateFrom?: string;
  dateTo?: string;
  totalUnconfirmed: number;
  totalUnmatched: number;
  categoryCounts: Record<string, number>;
  groups: ClassifiedTransactionGroupResult[];
}

export interface ApplyClassificationsInput {
  /** The pass-through frozen projection — a string or already-parsed object,
   * exactly as `apply_transaction_classifications` receives it. It is a
   * SELECTION/proposal only: at execute the server re-derives the canonical
   * effect and rejects any material difference vs the reviewed plan as drift. */
  classificationsJson: unknown;
  execute?: boolean;
  /** REQUIRED for execute (execute===true). The consume-once handle minted by
   * the matching dry_run_apply. A missing/replayed/out-of-scope/expired handle
   * fails closed BEFORE any API write. Ignored on dry run. */
  planHandle?: string;
}

export interface ApplyClassificationGroupResult {
  category: TransactionClassificationCategory;
  counterparty: string;
  status: "applied" | "skipped" | "dry_run_preview" | "failed";
  notes: string[];
  transactions: number[];
  created_invoice_ids?: number[];
  linked_transaction_ids?: number[];
  partial_mutations?: PartialClassificationMutation[];
}

export interface ApplyClassificationsResult {
  mode: "DRY_RUN" | "EXECUTED";
  dryRun: boolean;
  summary: { applied: number; skipped: number; dry_run_preview: number; failed: number };
  results: ApplyClassificationGroupResult[];
  /** Minted on dry run only: the consume-once handle the caller must present to
   * execute_apply. Undefined after an execute. */
  planHandle?: string;
}

export interface ClassificationOperations {
  analyzeUnmatched(input: UnmatchedAnalysisInput): Promise<OperationOutcome<UnmatchedAnalysisResult>>;
  applyClassifications(input: ApplyClassificationsInput): Promise<OperationOutcome<ApplyClassificationsResult>>;
}

/** The outcome of the single per-transaction fetch done in the fingerprint pass,
 * reused by the mutation loop so a bookable transaction is fetched exactly once
 * before the post-create freshness re-read. */
type GatherOutcome =
  | { readonly kind: "ok"; readonly transaction: Transaction }
  | { readonly kind: "gone" }
  | { readonly kind: "deleted" }
  | { readonly kind: "confirmed" }
  | { readonly kind: "non_project"; readonly status?: string }
  | { readonly kind: "error"; readonly error: unknown };

class ClassificationOperationsImpl implements ClassificationOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
    private readonly wrapUntrustedText: WrapUntrustedText,
  ) {}

  /**
   * P0-2 drift fingerprint. Re-derives — READ-ONLY (execute=false, no supplier
   * creation, no invoice write) — the exact canonical effect that execute_apply
   * would produce from the SAME caller-supplied groups + the current live state,
   * and returns it as a stable canonical record. Bound into the plan at
   * dry_run_apply and recomputed fresh at execute_apply; any material difference
   * (added/removed transaction, changed category/apply_mode, a transaction whose
   * status/amount/currency/date/dimension/client moved, a re-resolved supplier or
   * booking article/account/dimension/VAT/total) makes canonicalPlanJson differ
   * and is rejected as plan_drift before the first API write. The caller JSON is
   * a SELECTION only — it can match the reviewed plan or drift, never re-authorize
   * a different effect. Both passes call resolveSupplierFromTransaction /
   * resolveClassificationSuggestion with execute=false so the read-only supplier
   * identity and server-resolved booking agree across preview and execute.
   */
  private async computeApplyFingerprint(
    groups: ClassifiedTransactionGroupResult[],
    context: { clients: Client[]; purchaseInvoices: unknown[]; purchaseArticlesWithVat: Awaited<ReturnType<typeof getPurchaseArticlesWithVat>>; accounts: unknown[]; isVatRegistered: boolean },
    cache: Map<number, GatherOutcome>,
  ): Promise<PlanRecord> {
    const api = this.api;
    const groupFingerprints: PlanData[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const bookable = group.apply_mode === "purchase_invoice"
        && shouldProcessExpenseAsPurchaseInvoice(group.category)
        && group.suggested_booking?.purchase_article_id !== undefined;
      const txFingerprints: PlanData[] = [];
      for (const stub of group.transactions) {
        if (stub.id === undefined) {
          txFingerprints.push({ id: null, present: false });
          continue;
        }
        // Fetch each transaction exactly ONCE here (the read-only pass); the
        // mutation loop below reuses this cache instead of re-fetching, so
        // execute's api.transactions.get count stays the same as before the plan
        // gate (this pass + the post-create freshness re-read).
        let transaction: Transaction | undefined;
        try {
          transaction = await api.transactions.get(stub.id);
        } catch (error) {
          // A confirmed 404 → the transaction is genuinely gone (bind absence so
          // it drifts from a plan that reviewed it as present). A transient
          // 503/timeout is NOT swallowed as "gone": it is captured and re-thrown
          // in the mutation loop so the affected GROUP fails (never a benign
          // skip), while the fingerprint marks it as an unresolved read so preview
          // and execute agree deterministically.
          if (error instanceof HttpError && error.status === 404) {
            cache.set(stub.id, { kind: "gone" });
            txFingerprints.push({ id: stub.id, present: false });
            continue;
          }
          cache.set(stub.id, { kind: "error", error });
          txFingerprints.push({ id: stub.id, present: false, read_error: true });
          continue;
        }
        if (!transaction || transaction.is_deleted) {
          cache.set(stub.id, { kind: "deleted" });
          txFingerprints.push({ id: stub.id, present: false, deleted: transaction?.is_deleted === true });
          continue;
        }
        // Fresh live-state binding — a change to any of these between preview and
        // execute drifts the whole command (invariant: the reviewed aggregate
        // effect cannot silently change).
        const liveState: PlanData = {
          id: transaction.id ?? stub.id,
          status: transaction.status ?? null,
          amount: transaction.amount ?? null,
          base_amount: transaction.base_amount ?? null,
          currency: (transaction.cl_currencies_id ?? "EUR").toUpperCase(),
          currency_rate: transaction.currency_rate ?? null,
          date: transaction.date ?? null,
          accounts_dimensions_id: transaction.accounts_dimensions_id ?? null,
          clients_id: transaction.clients_id ?? null,
        };
        if (transaction.status === "CONFIRMED") {
          cache.set(stub.id, { kind: "confirmed" });
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null });
          continue;
        }
        if (transaction.status !== "PROJECT") {
          cache.set(stub.id, { kind: "non_project", status: transaction.status ?? undefined });
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null });
          continue;
        }
        cache.set(stub.id, { kind: "ok", transaction });
        if (!bookable) {
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null });
          continue;
        }
        // Server-resolved supplier IDENTITY (read-only — no creation) and booking
        // projection, mirroring the mutation loop's resolution exactly.
        const supplierResolution = await resolveSupplierFromTransaction(api, context.clients, transaction, false, group.category);
        const supplier = supplierResolution.client;
        const grossAmount = roundMoney(Math.abs(transaction.amount));
        const transactionGroup: TransactionGroup = {
          normalized_counterparty: canonicalBusinessText(group.normalized_counterparty),
          display_counterparty: canonicalBusinessText(group.display_counterparty),
          transactions: [transaction],
        };
        const resolved = await resolveClassificationSuggestion(api, {
          purchaseInvoices: context.purchaseInvoices,
          purchaseArticlesWithVat: context.purchaseArticlesWithVat,
          accounts: context.accounts,
        } as never, context.clients, transactionGroup, {
          category: group.category,
          apply_mode: group.apply_mode,
          recurring: group.recurring,
          similar_amounts: group.similar_amounts,
          reasons: group.reasons,
        });
        if (resolved.applyMode !== "purchase_invoice") {
          txFingerprints.push({ ...(liveState as Record<string, PlanData>), booking: null, apply_mode_resolved: resolved.applyMode });
          continue;
        }
        const article = context.purchaseArticlesWithVat.find(item => item.id === resolved.suggestion.purchase_article_id);
        const vatConfig = getBookingSuggestionVatConfig({
          item: {
            vat_rate_dropdown: resolved.suggestion.vat_rate_dropdown,
            reversed_vat_id: resolved.suggestion.reversed_vat_id,
          } as PurchaseInvoiceItem,
        }) ?? getAutoBookedVatConfig();
        const netAmount = deriveAutoBookedNetAmount(grossAmount, vatConfig);
        const purchaseItem = applyPurchaseVatDefaults(
          context.purchaseArticlesWithVat,
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
          context.isVatRegistered,
        );
        txFingerprints.push({
          ...(liveState as Record<string, PlanData>),
          booking: stripUndefinedDeep({
            supplier_client_id: supplier?.id ?? null,
            supplier_name: supplier?.name !== undefined ? canonicalBusinessText(supplier.name) : null,
            invoice_number: `AUTO-TX-${transaction.id}`,
            purchase_article_id: resolved.suggestion.purchase_article_id ?? null,
            purchase_account_id: purchaseItem.purchase_accounts_id ?? null,
            purchase_account_dimensions_id: purchaseItem.purchase_accounts_dimensions_id ?? null,
            liability_account_id: resolved.suggestion.liability_account_id ?? DEFAULT_LIABILITY_ACCOUNT,
            vat_rate_dropdown: purchaseItem.vat_rate_dropdown ?? null,
            vat_accounts_id: purchaseItem.vat_accounts_id ?? null,
            cl_vat_articles_id: purchaseItem.cl_vat_articles_id ?? null,
            reversed_vat_id: purchaseItem.reversed_vat_id ?? null,
            net_amount: netAmount,
            gross_amount: grossAmount,
            vat_price: deriveAutoBookedVatPrice(grossAmount, vatConfig),
          }),
        });
      }
      groupFingerprints.push({
        category: group.category,
        apply_mode: group.apply_mode,
        bookable,
        transactions: txFingerprints,
      });
    }
    return stripUndefinedDeep({
      schema: "bank_classification_apply_v1",
      stop_policy: "stop_group_on_drift",
      commands: ["purchase_invoice_create", "purchase_invoice_confirm", "transaction_confirm_link"],
      groups: groupFingerprints,
    }) as PlanRecord;
  }

  async analyzeUnmatched(input: UnmatchedAnalysisInput): Promise<OperationOutcome<UnmatchedAnalysisResult>> {
    const api = this.api;
    const { accountsDimensionsId, dateFrom, dateTo } = input;
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
      transaction.accounts_dimensions_id === accountsDimensionsId &&
      isProjectTransaction(transaction) &&
      (!dateFrom || transaction.date >= dateFrom) &&
      (!dateTo || transaction.date <= dateTo),
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
      // Build the RAW classified group (no wrapping). The presenter reproduces
      // the double-wrap of transaction description/bank_account_name and the
      // single-wrap of counterparty fields. Key order matches the former
      // toClassifiedResult output so the wrapped envelope stays byte-identical.
      classifiedGroups.push({
        category: classification.category,
        apply_mode: applyMode,
        normalized_counterparty: group.normalized_counterparty,
        display_counterparty: group.display_counterparty,
        recurring: classification.recurring,
        similar_amounts: classification.similar_amounts,
        total_amount: roundMoney(group.transactions.reduce((sum, transaction) => sum + transaction.amount, 0)),
        suggested_booking: resolved.suggestion,
        reasons: classification.reasons,
        review_guidance: applyMode !== "purchase_invoice"
          ? buildClassificationReviewGuidance({
              category: classification.category,
              displayCounterparty: group.display_counterparty,
            })
          : undefined,
        transactions: group.transactions.map(transaction => ({
          id: transaction.id,
          type: transaction.type,
          amount: transaction.amount,
          date: transaction.date,
          description: transaction.description ?? undefined,
          bank_account_name: transaction.bank_account_name ?? undefined,
          bank_subtype: transaction.bank_subtype,
          accounts_dimensions_id: transaction.accounts_dimensions_id,
          clients_id: transaction.clients_id,
        })),
      });
    }

    const categoryCounts = classifiedGroups.reduce<Record<string, number>>((counts, group) => {
      counts[group.category] = (counts[group.category] ?? 0) + group.transactions.length;
      return counts;
    }, {});

    return ok({
      accountsDimensionsId,
      ...(dateFrom !== undefined ? { dateFrom } : {}),
      ...(dateTo !== undefined ? { dateTo } : {}),
      totalUnconfirmed: unconfirmed.length,
      totalUnmatched: unmatched.length,
      categoryCounts,
      groups: classifiedGroups,
    });
  }

  async applyClassifications(input: ApplyClassificationsInput): Promise<OperationOutcome<ApplyClassificationsResult>> {
    const api = this.api;
    const wrapUntrustedText = this.wrapUntrustedText;
    const dryRun = input.execute !== true;
    const parsed = typeof input.classificationsJson === "string"
      ? safeJsonParse(input.classificationsJson, "classifications_json")
      : input.classificationsJson;
    const groups = extractClassificationGroups(parsed);

    const [clients, purchaseArticlesWithVat, purchaseInvoices, accounts] = await Promise.all([
      api.clients.listAll(),
      getPurchaseArticlesWithVat(api),
      api.purchaseInvoices.listAll(),
      api.readonly.getAccounts(),
    ]);
    const isVatRegistered = await isCompanyVatRegistered(api);
    const fingerprintContext = { clients, purchaseInvoices, purchaseArticlesWithVat, accounts, isVatRegistered };

    // Single read-only pass: fetch every transaction ONCE, build the canonical
    // fingerprint, and cache each fetch so the mutation loop reuses it (no
    // re-fetch). Both dry_run_apply (mint the plan from this) and execute_apply
    // (drift-check against the reviewed plan) share this exact computation.
    const gatherCache = new Map<number, GatherOutcome>();
    const fingerprint = await this.computeApplyFingerprint(groups, fingerprintContext, gatherCache);

    // P0-2 execute gate: consume the reviewed plan (consume-once, scope-bound)
    // and compare the FRESH canonical effect. Any material difference vs the
    // reviewed plan — including a caller who edited classifications_json, or live
    // state that moved since the preview — is rejected as plan_drift with ZERO
    // API writes, BEFORE the first mutation. The caller's classifications_json is
    // never the executable authority; it can only match the plan or drift.
    if (!dryRun) {
      if (input.planHandle === undefined) {
        return fail("plan_handle_required", "execute_apply requires the plan_handle returned by dry_run_apply.");
      }
      let storedPlan;
      try {
        storedPlan = this.runtimeSafetyContext.planStore.consume(input.planHandle, BANK_CLASSIFICATION_PLAN_DOMAIN);
      } catch (error) {
        const code = (error as { code?: string }).code ?? "plan_handle_invalid";
        return fail(code, "The reviewed classification plan could not be consumed.");
      }
      if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(fingerprint)) {
        return fail("plan_drift", "The classifications no longer match the reviewed dry_run_apply plan (transactions, category, apply_mode, supplier, booking, or live transaction state changed). Re-run dry_run_apply and review again.");
      }
    }

    const results: ApplyClassificationGroupResult[] = [];

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      await reportProgress(index, groups.length);
      const notes: string[] = [];
      const transactionIds = group.transactions.map(transaction => transaction.id).filter((id): id is number => id !== undefined);
      const createdInvoiceIds: number[] = [];
      const linkedTransactionIds: number[] = [];
      const partialMutations: PartialClassificationMutation[] = [];
      let wouldCreateCount = 0;
      let attemptedCreateCount = 0;

      try {
        const freshTransactions: Transaction[] = [];
        for (const transactionStub of group.transactions) {
          if (!transactionStub.id) {
            notes.push("Skipped a transaction without ID.");
            continue;
          }
          // Reuse the fingerprint pass's single fetch (no re-fetch here). The
          // outcome reproduces the exact skip notes; a captured non-404 read error
          // is re-thrown so the affected GROUP fails (never a benign skip).
          const outcome = gatherCache.get(transactionStub.id);
          if (outcome === undefined || outcome.kind === "gone") {
            notes.push(`Transaction ${transactionStub.id} no longer exists.`);
            continue;
          }
          if (outcome.kind === "deleted") {
            notes.push(`Transaction ${transactionStub.id} was deleted since classification; skipped.`);
            continue;
          }
          if (outcome.kind === "confirmed") {
            notes.push(`Transaction ${transactionStub.id} was confirmed since classification; skipped.`);
            continue;
          }
          if (outcome.kind === "non_project") {
            notes.push(`Transaction ${transactionStub.id} is no longer bookable (status ${outcome.status ?? "UNKNOWN"}); skipped.`);
            continue;
          }
          if (outcome.kind === "error") {
            throw outcome.error;
          }
          freshTransactions.push(outcome.transaction);
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

        for (const transaction of freshTransactions) {
          const supplierResolution = await resolveSupplierFromTransaction(api, clients, transaction, !dryRun, group.category);
          const supplier = supplierResolution.client;
          const supplierId = supplier?.id;
          const grossAmount = roundMoney(Math.abs(transaction.amount));
          const transactionCurrency = (transaction.cl_currencies_id ?? "EUR").toUpperCase();
          const transactionCurrencyRate = transaction.currency_rate;
          // M10: the caller echoes classify output back in classifications_json,
          // where counterparty fields were sandbox-wrapped for display. Strip
          // the markers to the canonical business value BEFORE it drives rule
          // matching (findAutoBookingRule), booking suggestions, or is written
          // into the audit summary below — nothing persisted/matched may carry
          // a sandbox marker. The response still re-wraps counterparty text.
          const transactionGroup: TransactionGroup = {
            normalized_counterparty: canonicalBusinessText(group.normalized_counterparty),
            display_counterparty: canonicalBusinessText(group.display_counterparty),
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
            // display_counterparty is remitter-controlled bank-statement text
            // (bank_account_name, falling back to description) and this is the
            // only note that puts it into prose. The full apply envelope emitted
            // the sentence verbatim. Uses the injected wrapper — the same
            // mechanism the invalidation note below relies on — so this module
            // still never imports wrapUntrustedOcr, and the surrounding
            // server-authored text stays free of sandbox markers.
            notes.push(`Dry run: transaction ${transaction.id} would require creating a supplier for ${wrapUntrustedText(group.display_counterparty) ?? group.display_counterparty}.`);
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
            (!Number.isFinite(transactionCurrencyRate) || (transactionCurrencyRate ?? 0) <= 0)
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
          }) ?? getAutoBookedVatConfig();
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
          const invoiceId = invoice.id;
          if (!invoiceId) {
            throw new Error("createAndSetTotals resolved without a purchase invoice ID");
          }
          attemptedCreateCount += 1;
          createdInvoiceIds.push(invoiceId);
          let observedInvoiceStatus = invoiceClassificationStatus(invoice.status);
          logAudit({
            tool: "apply_transaction_classifications", action: "CREATED", entity_type: "purchase_invoice",
            entity_id: invoiceId,
            summary: `Auto-booked purchase invoice from transaction ${transaction.id} (${transactionGroup.display_counterparty})`,
            details: { supplier_name: supplier.name, invoice_number: `AUTO-TX-${transaction.id}`, date: transaction.date, total_gross: grossAmount },
          });

          type InvoiceInvalidationOutcome =
            | { ok: true }
            | { ok: false; error: unknown };

          const invalidateAutoCreatedInvoice = async (
            reason: string,
          ): Promise<InvoiceInvalidationOutcome> => {
            try {
              await api.purchaseInvoices.invalidate(invoiceId);
              notes.push(`Invalidated auto-created purchase invoice ${invoiceId} because ${reason}.`);
              return { ok: true };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              notes.push(
                `Auto-created purchase invoice ${invoiceId} could not be kept because ${reason}, and invalidation also failed: ${wrapUntrustedText(message) ?? message}.`,
              );
              return { ok: false, error };
            }
          };

          const recordPostCreateFailure = (
            error: unknown,
            failedStage: PartialClassificationMutation["failed_stage"],
            createdInvoiceStatus: PartialClassificationStatus,
            transactionStatus: PartialClassificationStatus,
          ): void => {
            const ambiguous = isAmbiguousPostCreateFailure(error);
            const nextAction = failedStage === "transaction_reread"
              ? `Use existing purchase invoice ${invoiceId}. Freshly read transaction ${transaction.id}, then continue only after explicit approval.`
              : failedStage === "invoice_invalidation"
                ? `Freshly read existing purchase invoice ${invoiceId} before any further action, then continue only after explicit approval.`
                : failedStage === "invoice_confirmation"
                  ? `Use existing purchase invoice ${invoiceId}. Freshly read that invoice and transaction ${transaction.id}, then continue only after explicit approval.`
                  : `Use existing confirmed purchase invoice ${invoiceId}. Freshly read transaction ${transaction.id}, then continue only after explicit approval.`;
            partialMutations.push({
              category: ambiguous ? "mutation_indeterminate" : "mutation_failed",
              mutation_may_have_occurred: true,
              failed_stage: failedStage,
              created_invoice_id: invoiceId,
              created_invoice_status: createdInvoiceStatus,
              attempted_transaction_id: transaction.id!,
              transaction_status: transactionStatus,
              next_action: nextAction,
            });
            notes.push(nextAction);
          };

          let freshTransaction: Transaction;
          try {
            freshTransaction = await api.transactions.get(transaction.id!);
          } catch (error) {
            recordPostCreateFailure(error, "transaction_reread", observedInvoiceStatus, "UNKNOWN");
            continue;
          }

          if (!isProjectTransaction(freshTransaction)) {
            const invalidation = await invalidateAutoCreatedInvoice(
              `transaction ${transaction.id} is no longer bookable (status ${freshTransaction.status ?? "UNKNOWN"})`,
            );
            if (invalidation.ok) {
              const createdIndex = createdInvoiceIds.lastIndexOf(invoiceId);
              if (createdIndex >= 0) createdInvoiceIds.splice(createdIndex, 1);
            } else {
              recordPostCreateFailure(
                invalidation.error,
                "invoice_invalidation",
                isAmbiguousPostCreateFailure(invalidation.error) ? "UNKNOWN" : observedInvoiceStatus,
                transactionClassificationStatus(freshTransaction),
              );
            }
            continue;
          }

          try {
            await api.purchaseInvoices.confirmWithTotals(invoiceId, isVatRegistered);
            observedInvoiceStatus = "CONFIRMED";
            logAudit({
              tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "purchase_invoice",
              entity_id: invoiceId,
              summary: `Auto-confirmed purchase invoice ${invoiceId} for transaction ${transaction.id}`,
              details: { invoice_id: invoiceId, transaction_id: transaction.id },
            });
          } catch (error) {
            recordPostCreateFailure(
              error,
              "invoice_confirmation",
              isAmbiguousPostCreateFailure(error) ? "UNKNOWN" : observedInvoiceStatus,
              "PROJECT",
            );
            continue;
          }

          try {
            await api.transactions.confirm(transaction.id!, [{
              related_table: "purchase_invoices",
              related_id: invoiceId,
              amount: transaction.amount,
            }]);
            logAudit({
              tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "transaction",
              entity_id: transaction.id!,
              summary: `Auto-confirmed transaction ${transaction.id} against invoice ${invoiceId}`,
              details: { amount: transaction.amount, invoice_id: invoiceId },
            });
          } catch (error) {
            recordPostCreateFailure(
              error,
              "transaction_confirmation",
              "CONFIRMED",
              isAmbiguousPostCreateFailure(error) ? "UNKNOWN" : "PROJECT",
            );
            continue;
          }

          linkedTransactionIds.push(transaction.id!);
        }

        const status = dryRun
          ? (wouldCreateCount > 0 ? "dry_run_preview" : "skipped")
          : partialMutations.length > 0
            ? "failed"
            : attemptedCreateCount > 0 && linkedTransactionIds.length === attemptedCreateCount
              ? "applied"
              : attemptedCreateCount > 0
                ? "failed"
                : "skipped";

        if (status === "failed" && linkedTransactionIds.length > 0) {
          notes.push(
            `Group reported as failed; the following transactions were already booked successfully and were left in place: ${linkedTransactionIds.join(", ")}.`
          );
        }

        results.push({
          category: group.category,
          counterparty: group.display_counterparty,
          status,
          notes,
          transactions: transactionIds,
          created_invoice_ids: dryRun ? undefined : createdInvoiceIds,
          linked_transaction_ids: dryRun ? undefined : linkedTransactionIds,
          partial_mutations: partialMutations.length > 0 ? partialMutations : undefined,
        });
      } catch (error) {
        // Upstream error bodies are untrusted: this loop calls create/resolve
        // with values derived from display_counterparty, so a backend validation
        // error can echo remitter-controlled text back. Same treatment as the
        // invalidation note above.
        const message = error instanceof Error ? error.message : String(error);
        notes.push(wrapUntrustedText(message) ?? message);
        results.push({
          category: group.category,
          counterparty: group.display_counterparty,
          status: "failed",
          notes,
          transactions: transactionIds,
          created_invoice_ids: dryRun ? undefined : createdInvoiceIds,
          linked_transaction_ids: dryRun ? undefined : linkedTransactionIds,
          partial_mutations: partialMutations.length > 0 ? partialMutations : undefined,
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

    // P0-2 dry_run_apply: mint the consume-once handle bound to the FRESH
    // canonical effect. execute_apply must present it and recompute an identical
    // fingerprint. The preview `results` above are the operator's review surface;
    // the plan fingerprint is the machine-checked binding of that same effect.
    let planHandle: string | undefined;
    if (dryRun) {
      const planInput: ExecutionPlanInput = {
        normalizedArgs: fingerprint,
        sourceIdentities: [],
        liveSnapshot: {
          groups: groups.length,
          bookable_groups: (fingerprint.groups as PlanData[] | undefined)?.filter(
            group => typeof group === "object" && group !== null && !Array.isArray(group) && (group as Record<string, PlanData>).bookable === true,
          ).length ?? 0,
        },
        commands: [{ id: "bank-classification-apply", category: "bank_classification_apply", reviewProjection: { groups: groups.length } }],
        counts: { groups: groups.length },
        totals: {},
        exclusions: [],
        reviews: [],
        privatePayload: { schema: "bank_classification_apply_v1" },
      };
      planHandle = this.runtimeSafetyContext.planStore.issue(BANK_CLASSIFICATION_PLAN_DOMAIN, planInput);
    }

    return ok({ mode, dryRun, summary, results, ...(planHandle !== undefined ? { planHandle } : {}) });
  }
}

export function createClassificationOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  wrapUntrustedText: WrapUntrustedText,
): ClassificationOperations {
  return new ClassificationOperationsImpl(api, runtimeSafetyContext, wrapUntrustedText);
}
