import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JOURNAL_TITLE_MAX_LENGTH, journalTitleLengthMessage } from "../api/journals.api.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import { isCompanyVatRegistered } from "../company-vat-status.js";
import { computeAllBalances, sumCategory, type AccountBalance } from "./financial-statements.js";
import { roundMoney } from "../money.js";
import { create, readOnly } from "../annotations.js";
import {
  computeRepresentationCostLimit,
  computeDonationLimit,
  classifyExpenseForVat,
  getCitRateForDate,
  currentCitRate,
  currentRepresentationMonthlyLimit,
  CIT_RATE_TIMELINE,
  VAT_REGISTRATION_THRESHOLD_EUR,
  ESTONIAN_VAT_METADATA,
  VAT_REGISTRATION_THRESHOLD_DISPLAY,
  vatSourceById,
} from "../estonian-tax-rules.js";
import { logAudit } from "../audit-log.js";
import { desandboxText } from "../external-text-renderer.js";
import { validateAccounts } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { withOpeningBalanceJournalStatus } from "../opening-balance-limitations.js";
import { loadJournalsWithOpeningBalance } from "../opening-balance-journal.js";
import { BookingGuard, companyLedgerLockScope, formatDocNumber, withBookingKeyLock, type DocKey } from "../booking-guard.js";
import { INCOME_TAX_EXPENSE_ACCOUNT, DEFAULT_VAT_ACCOUNT, DEFAULT_OWNER_PAYABLE_ACCOUNT } from "../accounting-defaults.js";
import {
  resolveRestrictedReserveAccounts,
  resolveRetainedEarningsAccount,
  resolveDividendPayableAccount,
  resolveDividendCitPayableAccount,
  resolveShareCapitalAccount,
} from "../account-resolution.js";
import {
  approvedReportYearProblem,
  computeDividendCapacity,
  dividendCit,
  dividendToCents,
  DIVIDEND_HOLD_PRIORITY,
  ledgerPositionAtReportEnd,
  type DividendCapacityHold,
  type DividendCapacityHoldCode,
  type DividendCommitment,
  type DividendLg1Components,
  type DividendLg2Components,
  maxNetDividend,
  resolveDividendRoles,
  validateDividendTargets,
} from "../dividend-capacity.js";
import type { Account, ApiResponse, Posting, SaleInvoice } from "../types/api.js";
import {
  getCurrentYearProfitAccountRule,
  getDefaultOwnerExpenseVatDeductionMode,
  getDefaultOwnerExpenseVatDeductionRatio,
  getOwnerExpenseVatDeductionModeForAccount,
  getOwnerExpenseVatDeductionRatioForAccount,
} from "../accounting-rules.js";
import { buildOwnerExpenseVatReviewGuidance } from "../estonian-accounting-guidance.js";
import { todayInTallinn } from "../local-date.js";
import { isStrictDate } from "../strict-date.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { PlanRecord, StoredExecutionPlan, PlanStoreErrorCode } from "../plan-store.js";
import { canonicalPlanJson, stripUndefinedDeep } from "./camt-plan.js";

const DIVIDEND_PLAN_DOMAIN = "dividend_package";

function requiresOwnerExpenseVatReview(accountName: string | undefined, description: string): boolean {
  const { isPassengerCar, isEntertainmentOrHospitality } = classifyExpenseForVat(`${accountName ?? ""} ${description}`);
  return isPassengerCar || isEntertainmentOrHospitality;
}

const VAT_THRESHOLD_SOURCE = vatSourceById("registration-threshold");

// Strict YYYY-MM-DD + calendar validity (rejects 2025-02-31, 01.01.2025, etc.).
const isoDateSchema = (description: string) =>
  z.string().refine(isStrictDate, { message: "Expected valid YYYY-MM-DD date" }).describe(description);

/** Order-independent posting identity (account, side, cent amount) for comparing a journal to a request. */
function postingSignature(postings: ReadonlyArray<Pick<Posting, "accounts_id" | "type" | "amount" | "base_amount" | "is_deleted">>): string[] {
  return postings
    .filter(p => !p.is_deleted)
    .map(p => `${p.accounts_id}|${p.type}|${roundMoney(p.base_amount ?? p.amount).toFixed(2)}`)
    .sort();
}

function saleInvoiceTurnoverAmount(invoice: SaleInvoice): number {
  const raw = invoice.base_net_price ?? invoice.net_price ?? invoice.base_gross_price ?? invoice.gross_price;
  if (raw == null) {
    process.stderr.write(`WARNING: Sale invoice ${invoice.id ?? "unknown"} has no net/gross amount — treating as 0 for VAT threshold check\n`);
    return 0;
  }
  const amount = roundMoney(raw);
  return invoice.sale_invoice_type === "CREDIT_INVOICE" ? -Math.abs(amount) : amount;
}

function thresholdStatus(input: {
  vatRegistered: boolean;
  taxableTurnover: number;
  thresholdTotalIfAllNonIncidental: number;
}): "already_registered" | "exceeded" | "needs_manual_review" | "approaching" | "ok" {
  if (input.vatRegistered) return "already_registered";
  if (input.taxableTurnover > VAT_REGISTRATION_THRESHOLD_EUR) return "exceeded";
  if (input.thresholdTotalIfAllNonIncidental > VAT_REGISTRATION_THRESHOLD_EUR) return "needs_manual_review";
  if (input.thresholdTotalIfAllNonIncidental >= VAT_REGISTRATION_THRESHOLD_EUR * 0.8) return "approaching";
  return "ok";
}

// The CIT rate timeline (TuMS § 50) lives in estonian-tax-rules.ts with the
// other date-gated statutory data; re-exported here for existing importers.
export { getCitRateForDate } from "../estonian-tax-rules.js";

/**
 * Resolve the profit-and-loss income-tax-expense account (the "Tulumaks" line)
 * for the dividend distribution tax. An explicit override always wins. Otherwise
 * auto-detect the lowest ACTIVE Kulud account in the 8900–8999 range — the same
 * range `annual-report.ts` maps to the RTJ Schema 1 "Tulumaks" line — so the
 * booked tax lands on the income-statement line the annual report reads it from.
 * Inactive accounts (is_valid === false) are skipped: getAccounts() returns the
 * raw chart including deactivated accounts, and validateAccounts() rejects an
 * inactive account, so picking the lowest-numbered one blindly would fail the
 * booking even when an active higher-numbered account exists. Falls back to the
 * INCOME_TAX_EXPENSE_ACCOUNT constant when the chart has no active such account
 * (account validation then surfaces a helpful error).
 */
export function resolveIncomeTaxExpenseAccount(accounts: Account[], override?: number): number {
  if (override !== undefined) return override;
  const candidate = accounts
    .filter(a => a.account_type_est === "Kulud" && a.is_valid !== false && a.id >= 8900 && a.id <= 8999)
    .map(a => a.id)
    .sort((x, y) => x - y)[0];
  return candidate ?? INCOME_TAX_EXPENSE_ACCOUNT;
}

export interface OwnerExpenseReimbursementParams {
  owner_client_id: number;
  effective_date: string;
  description: string;
  net_amount: number;
  vat_rate: number;
  vat_amount?: number;
  vat_deduction_mode?: "none" | "full" | "partial";
  deductible_vat_amount?: number;
  expense_account: number;
  expense_account_dimension_id?: number;
  vat_account?: number;
  payable_account?: number;
  payable_account_dimension_id?: number;
  document_number?: string;
}

export interface OwnerExpenseReimbursementOptions {
  // Transforms ONLY the echoed expense.description in the returned display
  // payload (the persisted journal title + audit stay the canonicalized clean
  // text). The standalone tool passes nothing → identity → byte-identical
  // output; the guided continuation passes sandboxExternalText so a receipt/
  // OCR-origin description is re-wrapped as untrusted text at its own boundary.
  rewrapDescription?: (description: string) => string;
}

// One posting of the resolved owner-expense journal. `purpose` labels the
// accounting role so the approval card (and the plan fingerprint) can show WHY
// each account is debited/credited, not just the numbers.
export interface OwnerExpensePosting {
  readonly side: "D" | "C";
  readonly account_id: number;
  readonly dimension_id: number | null;
  readonly amount: number;
  readonly purpose: "expense" | "deductible_vat" | "owner_payable";
}

// The canonical EFFECTIVE owner-expense journal — everything post-desandbox,
// post-default, post-validation: the ACTUAL write model, never the raw caller
// params. computeOwnerExpenseJournalProjection() derives it from live state
// (VAT registration, chart, configured deduction policy) so the continuation
// can (a) show the whole journal on the approval card and (b) bind EXACTLY this
// projection into the plan fingerprint. A changed VAT deduction mode, payable
// account, or VAT account re-derives to a different projection and drifts.
export interface OwnerExpenseJournalProjection {
  readonly journal_date: string;
  readonly document_number: string | null;
  readonly currency: "EUR";
  readonly owner_client_id: number;
  // Desandboxed description — the persisted journal title.
  readonly title: string;
  readonly net_amount: number;
  readonly vat_rate: number;
  // Whether an explicit vat_amount was supplied (drives the "custom" rate label).
  readonly custom_vat_amount: boolean;
  readonly vat_amount: number;
  readonly vat_deduction_mode: "none" | "full" | "partial";
  readonly deductible_vat_amount: number;
  readonly non_deductible_vat_amount: number;
  readonly expense_account: number;
  readonly expense_debit_amount: number;
  // The VAT account only when a deductible-VAT posting is actually made, else null.
  readonly vat_account: number | null;
  readonly payable_account: number;
  readonly payable_account_dimension_id: number | null;
  readonly total: number;
  readonly vat_registered: boolean;
  readonly postings: readonly OwnerExpensePosting[];
}

export type OwnerExpenseProjectionResult =
  | { readonly ok: true; readonly projection: OwnerExpenseJournalProjection }
  | { readonly ok: false; readonly error: CallToolResult };

// Resolve the full effective owner-expense journal from params + live state,
// applying EVERY default (VAT account, payable account, deduction mode/ratio)
// and running every validation. Returns a structured error (no side effect) on
// any invalid input, else the canonical projection. Called at prepare (to bind
// the fingerprint + show the journal) and at execute (to re-derive fresh and
// drift-compare), so the plan proves the exact effect the operator reviewed.
export async function computeOwnerExpenseJournalProjection(
  api: ApiContext,
  params: OwnerExpenseReimbursementParams,
): Promise<OwnerExpenseProjectionResult> {
  let {
    owner_client_id,
    effective_date,
    description,
    net_amount,
    vat_rate,
    vat_amount,
    vat_deduction_mode,
    deductible_vat_amount,
    expense_account,
    expense_account_dimension_id,
    vat_account,
    payable_account,
    payable_account_dimension_id,
    document_number,
  } = params;
  // Canonicalize free-text that will be persisted to the journal + audit log:
  // a wrapped OCR receipt description/number can round-trip through the LLM
  // into this booking, so strip markers before any of it reaches the ledger.
  description = desandboxText(description);
  document_number = document_number !== undefined ? desandboxText(document_number) : undefined;
  if (vat_rate > 1) {
    return { ok: false, error: toolError({
      error: `vat_rate=${vat_rate} looks like a percentage. Pass a decimal fraction instead (e.g. 0.24 for 24%).`,
    }) };
  }
  // A reimbursement books a real expense against a payable to the owner, so
  // the amounts must be positive. z.number().finite() alone admits 0 and
  // negatives, which would post an empty or sign-reversed journal (crediting
  // the expense, debiting the owner-payable) — reject them with a clear error
  // instead of booking nonsense.
  if (net_amount <= 0) {
    return { ok: false, error: toolError({ error: `net_amount must be greater than 0 (got ${net_amount}). A reimbursement books a positive business expense.` }) };
  }
  if (vat_rate < 0) {
    return { ok: false, error: toolError({ error: `vat_rate must not be negative (got ${vat_rate}). Use 0 only when the document has no VAT; for non-deductible VAT keep the document rate and set vat_deduction_mode='none'.` }) };
  }
  if (vat_amount !== undefined && vat_amount < 0) {
    return { ok: false, error: toolError({ error: `vat_amount must not be negative (got ${vat_amount}).` }) };
  }
  if (deductible_vat_amount !== undefined && deductible_vat_amount < 0) {
    return { ok: false, error: toolError({ error: `deductible_vat_amount must not be negative (got ${deductible_vat_amount}).` }) };
  }
  const vatRegistered = await isCompanyVatRegistered(api, {
    purchaseDate: effective_date,
    ...(vat_deduction_mode === "none" ? { preRegistrationVatDeductionApproved: false } : {}),
  });
  const vatAcc = vat_account ?? DEFAULT_VAT_ACCOUNT;
  const payAcc = payable_account ?? DEFAULT_OWNER_PAYABLE_ACCOUNT;
  // Round the gross VAT whether it came from vat_rate or was supplied
  // directly: an unrounded caller vat_amount would otherwise be posted
  // verbatim while the balance guard below rounds only the sum, letting a
  // sub-cent-unbalanced journal reach the API.
  const grossVat = roundMoney(vat_amount ?? net_amount * vat_rate);
  const accounts = await api.readonly.getAccounts();
  // An account with dimensions takes entries only on one of its dimensions:
  // never post such an account without one (live 2026-10-31: the default 2110
  // was a per-lender loan account). Refused here, before anything is written.
  // Fresh, not the 10-minute cache: execute re-derives this projection, and a
  // dimension added to (or removed from) an account since the preview must show.
  const liveDimensions = (await api.readonly.getAccountDimensions({ fresh: true }))
    .filter(dimension => dimension.is_deleted !== true);
  const postingDimension = (account: number, dimensionId: number | undefined, param: string | undefined): { ok: true; id: number | null } | { ok: false; error: CallToolResult } => {
    const own = liveDimensions.filter(dimension => dimension.accounts_id === account);
    const listed = own.map(dimension => `${dimension.id} (${dimension.title_est ?? dimension.title_eng ?? "untitled"})`).join(", ");
    if (dimensionId === undefined) {
      if (own.length === 0) return { ok: true, id: null };
      return { ok: false, error: toolError({
        error: `Account ${account} has dimensions, so an entry must name one of them.`,
        hint: param !== undefined
          ? `Pass ${param} with the right dimension of account ${account}: ${listed}. Or choose an account without dimensions.`
          : `Choose an account without dimensions instead (dimensions of ${account}: ${listed}).`,
      }) };
    }
    if (own.some(dimension => dimension.id === dimensionId)) return { ok: true, id: dimensionId };
    return { ok: false, error: toolError({
      error: `${param ?? "The dimension"} ${dimensionId} is not a dimension of account ${account}.`,
      hint: own.length > 0 ? `Dimensions of account ${account}: ${listed}.` : `Account ${account} has no dimensions: leave ${param ?? "the dimension"} out.`,
    }) };
  };
  const expenseDimension = postingDimension(expense_account, expense_account_dimension_id, "expense_account_dimension_id");
  if (!expenseDimension.ok) return expenseDimension;
  const payableDimension = postingDimension(payAcc, payable_account_dimension_id, "payable_account_dimension_id");
  if (!payableDimension.ok) return payableDimension;
  const expenseAccountRecord = accounts.find(account => account.id === expense_account);
  const requiresReview = requiresOwnerExpenseVatReview(expenseAccountRecord?.name_est ?? expenseAccountRecord?.name_eng, description);
  const configuredMode = getOwnerExpenseVatDeductionModeForAccount(expense_account) ?? getDefaultOwnerExpenseVatDeductionMode();
  const configuredRatio = getOwnerExpenseVatDeductionRatioForAccount(expense_account) ?? getDefaultOwnerExpenseVatDeductionRatio();

  if (vatRegistered && grossVat > 0 && vat_deduction_mode !== undefined && deductible_vat_amount !== undefined) {
    const differenceFromFull = Math.abs(deductible_vat_amount - grossVat);
    if (vat_deduction_mode === "none" && deductible_vat_amount > 0.01) {
      return { ok: false, error: toolError({
        error: "deductible_vat_amount conflicts with vat_deduction_mode='none'",
        hint: "Suggested default: remove deductible_vat_amount or set it to 0 when VAT should be non-deductible.",
      }) };
    }
    if (vat_deduction_mode === "full" && differenceFromFull >= 0.01) {
      return { ok: false, error: toolError({
        error: "deductible_vat_amount conflicts with vat_deduction_mode='full'",
        hint: "Suggested default: omit deductible_vat_amount for full deduction, or pass the full VAT amount explicitly.",
      }) };
    }
    if (vat_deduction_mode === "partial" && (deductible_vat_amount <= 0.01 || differenceFromFull < 0.01)) {
      return { ok: false, error: toolError({
        error: "deductible_vat_amount conflicts with vat_deduction_mode='partial'",
        hint: "Suggested default: pass only the deductible VAT portion when vat_deduction_mode='partial'.",
      }) };
    }
  }

  const deductionMode = !vatRegistered || grossVat <= 0
    ? "none"
    : vat_deduction_mode
      ?? (deductible_vat_amount !== undefined
        ? (Math.abs(deductible_vat_amount - grossVat) < 0.01 ? "full" : "partial")
        : configuredMode ?? "full");

  if (vatRegistered && grossVat > 0 && requiresReview && vat_deduction_mode === undefined && deductible_vat_amount === undefined && configuredMode === undefined) {
    const reviewGuidance = buildOwnerExpenseVatReviewGuidance({
      description,
      accountName: expenseAccountRecord?.name_est ?? expenseAccountRecord?.name_eng,
    });
    return { ok: false, error: toolError({
      error: "VAT deduction needs confirmation for this expense category",
      hint: reviewGuidance.recommendation,
      compliance_basis: reviewGuidance.compliance_basis,
      follow_up_questions: reviewGuidance.follow_up_questions,
      policy_hint: reviewGuidance.policy_hint,
      suggestions: [
        "If this is a standard business receipt with fully deductible VAT, rerun with vat_deduction_mode='full'.",
        "If this is passenger-car or mixed-use cost, rerun with vat_deduction_mode='partial' and deductible_vat_amount.",
        "If this is non-deductible VAT, rerun with vat_deduction_mode='none'.",
      ],
    }) };
  }

  if (deductionMode === "partial" && deductible_vat_amount === undefined && configuredRatio === undefined) {
    return { ok: false, error: toolError({
      error: "deductible_vat_amount is required when vat_deduction_mode=partial",
      hint: "Suggested default: set deductible_vat_amount explicitly or define a partial ratio in accounting-rules.md when the policy is stable.",
    }) };
  }

  const deductibleVat = !vatRegistered || grossVat <= 0
    ? 0
    : deductionMode === "full"
      ? grossVat
      : deductionMode === "partial"
        ? roundMoney(deductible_vat_amount ?? (configuredRatio !== undefined ? grossVat * configuredRatio : 0))
        : 0;

  if (deductibleVat < 0 || deductibleVat - grossVat > 0.01) {
    return { ok: false, error: toolError({
      error: `deductible_vat_amount must be between 0 and total VAT ${grossVat}`,
      hint: "Suggested default: keep the VAT non-deductible unless the source document and business-use analysis support deduction.",
    }) };
  }

  const deductibleVatPosted = deductibleVat > 0 && vatRegistered;

  // The description becomes the journal title; refuse an over-long one here so
  // preview and approval fail, not only the approved booking.
  const titleError = journalTitleLengthMessage(description);
  if (titleError !== undefined) {
    return { ok: false, error: toolError({
      error: titleError,
      hint: `Shorten description to at most ${JOURNAL_TITLE_MAX_LENGTH} characters and retry; put longer explanations in the attached receipt.`,
    }) };
  }

  // Validate all accounts exist
  const accountErrors = validateAccounts(accounts, [
    { id: expense_account, label: "Expense account" },
    ...(deductibleVatPosted ? [{ id: vatAcc, label: "VAT account" }] : []),
    { id: payAcc, label: "Payable account" },
  ]);
  if (accountErrors.length > 0) {
    return { ok: false, error: toolError({
      error: "Account validation failed",
      details: accountErrors,
      hint: "Use list_accounts to find correct account numbers.",
    }) };
  }

  const total = roundMoney(net_amount + grossVat);
  const nonDeductibleVat = roundMoney(grossVat - deductibleVat);
  const expenseDebit = roundMoney(net_amount + nonDeductibleVat);

  // Defensive: the three postings below must balance to `total`. Rounding
  // at intermediate steps can drift by 1 cent in pathological VAT-deduction
  // combinations; refuse to create an unbalanced journal.
  const totalDebits = roundMoney(expenseDebit + (deductibleVatPosted ? deductibleVat : 0));
  if (totalDebits !== total) {
    return { ok: false, error: toolError({
      error: `Internal imbalance: sum of debits (${totalDebits}) would not equal credits (${total}).`,
      hint: "This is a rounding edge case in owner-expense reimbursement. Report with net_amount, vat_rate, vat_amount, vat_deduction_mode, deductible_vat_amount values.",
      details: [
        `net_amount=${net_amount}`,
        `grossVat=${grossVat}`,
        `deductibleVat=${deductibleVat}`,
        `nonDeductibleVat=${nonDeductibleVat}`,
        `expenseDebit=${expenseDebit}`,
        `total=${total}`,
      ],
    }) };
  }

  const postings: OwnerExpensePosting[] = [
    { side: "D", account_id: expense_account, dimension_id: expenseDimension.id, amount: expenseDebit, purpose: "expense" },
  ];
  if (deductibleVatPosted) {
    const vatDimension = postingDimension(vatAcc, undefined, undefined);
    if (!vatDimension.ok) return vatDimension;
    postings.push({ side: "D", account_id: vatAcc, dimension_id: null, amount: deductibleVat, purpose: "deductible_vat" });
  }
  postings.push({ side: "C", account_id: payAcc, dimension_id: payableDimension.id, amount: total, purpose: "owner_payable" });

  return { ok: true, projection: {
    journal_date: effective_date,
    document_number: document_number ?? null,
    currency: "EUR",
    owner_client_id,
    title: description,
    net_amount,
    vat_rate,
    custom_vat_amount: vat_amount !== undefined,
    vat_amount: grossVat,
    vat_deduction_mode: deductionMode,
    deductible_vat_amount: deductibleVat,
    non_deductible_vat_amount: nonDeductibleVat,
    expense_account,
    expense_debit_amount: expenseDebit,
    vat_account: deductibleVatPosted ? vatAcc : null,
    payable_account: payAcc,
    payable_account_dimension_id: payableDimension.id,
    total,
    vat_registered: vatRegistered,
    postings,
  } };
}

// Persist a resolved owner-expense projection: one balanced journal + audit +
// the byte-identical display payload create_owner_expense_reimbursement has
// always returned. The projection is the single source of truth, so prepare's
// preview, the plan fingerprint, and this booked journal cannot diverge.
// A retried owner-expense booking must not book the same receipt twice: a live
// journal with the same document number, owner, date and owner-payable total is
// that booking. Only document-numbered receipts have a key (two identical
// undocumented expenses on one day can be legitimate). Reads the ledger
// uncached, like the other live duplicate checks.
async function findExistingOwnerExpenseJournal(
  api: ApiContext,
  p: OwnerExpenseJournalProjection,
): Promise<{ kind: "same" | "conflict"; id: number } | undefined> {
  if (p.document_number === null) return undefined;
  api.journals.invalidateListCache();
  const candidates = (await api.journals.listAll()).filter(j =>
    j.id != null && j.is_deleted !== true &&
    j.document_number === p.document_number &&
    j.clients_id === p.owner_client_id &&
    j.effective_date === p.journal_date);
  const postingKey = (accountId: number, dimensionId: number | null | undefined, side: string | undefined, amount: number) =>
    `${accountId}|${dimensionId ?? "-"}|${side ?? "?"}|${roundMoney(amount).toFixed(2)}`;
  const approved = p.postings.map(posting => postingKey(posting.account_id, posting.dimension_id, posting.side, posting.amount)).sort();
  for (const candidate of candidates) {
    const postings = (candidate.postings?.length ? candidate.postings : (await api.journals.get(candidate.id!))?.postings ?? [])
      .filter(posting => !posting.is_deleted);
    const credited = roundMoney(postings
      .filter(posting => posting.type === "C")
      .reduce((sum, posting) => sum + (posting.base_amount ?? posting.amount), 0));
    if (credited !== p.total) continue;
    // Same document, owner, date and total: it is this expense. Reuse it only
    // when it books exactly the approved lines (accounts, dimensions, sides,
    // amounts); otherwise it is a conflict to review, never silently reused.
    const existing = postings.map(posting => postingKey(posting.accounts_id, posting.accounts_dimensions_id, posting.type, posting.base_amount ?? posting.amount)).sort();
    return existing.length === approved.length && existing.every((key, index) => key === approved[index])
      ? { kind: "same", id: candidate.id! }
      : { kind: "conflict", id: candidate.id! };
  }
  return undefined;
}

export async function bookOwnerExpenseFromProjection(
  api: ApiContext,
  projection: OwnerExpenseJournalProjection,
  options?: OwnerExpenseReimbursementOptions,
): Promise<CallToolResult> {
  const p = projection;
  const apiPostings = p.postings.map(posting => ({
    accounts_id: posting.account_id,
    ...(posting.dimension_id !== null ? { accounts_dimensions_id: posting.dimension_id } : {}),
    type: posting.side,
    amount: posting.amount,
  }));
  const existing = await findExistingOwnerExpenseJournal(api, p);
  if (existing?.kind === "conflict") {
    return toolError({
      error: `Owner-expense journal ${existing.id} already has this document number, owner, date and total, but books different lines (account, dimension or amount) than the approved journal. Nothing was created.`,
      hint: `Check journal ${existing.id} with get_journal: correct or delete it if it is wrong (e.g. the debt on no dimension or on another person's dimension), then book again; or use another document_number if it is a different expense.`,
      code: "owner_expense_journal_conflict",
      journal_id: existing.id,
    });
  }
  const existingId = existing?.id;
  const result: ApiResponse = existingId !== undefined
    ? { code: 200, messages: [`Existing owner-expense journal ${existingId} reused.`], created_object_id: existingId }
    : await api.journals.create({
        title: p.title,
        effective_date: p.journal_date,
        clients_id: p.owner_client_id,
        cl_currencies_id: "EUR",
        document_number: p.document_number ?? undefined,
        postings: apiPostings,
      });
  if (existingId === undefined) logAudit({
    tool: "create_owner_expense_reimbursement", action: "CREATED", entity_type: "journal",
    entity_id: result.created_object_id,
    summary: `Owner expense: ${p.title}, total ${p.total} EUR`,
    details: {
      effective_date: p.journal_date, description: p.title, total_net: p.net_amount, total_vat: p.vat_amount, deductible_vat: p.deductible_vat_amount, total_gross: p.total,
      postings: apiPostings,
    },
  });

  const payableLabel = p.payable_account_dimension_id !== null
    ? `${p.payable_account} dimension ${p.payable_account_dimension_id}`
    : String(p.payable_account);
  const suggestions: string[] = [];
  if (p.vat_registered && p.vat_amount > 0 && p.deductible_vat_amount === p.vat_amount) {
    suggestions.push("VAT was fully deducted by default. If this expense falls under passenger-car, representation, or mixed-use restrictions, rerun with vat_deduction_mode='partial' or 'none'.");
  } else if (p.vat_registered && p.vat_amount > 0 && p.deductible_vat_amount === 0) {
    suggestions.push("VAT was treated as non-deductible. If the receipt supports deduction, rerun with vat_deduction_mode='full' or 'partial' and deductible_vat_amount.");
  }

  return {
    content: [{
      type: "text",
      text: toMcpJson({
        expense: {
          // Only the echoed display description is re-wrapped (identity by
          // default); the journal title + audit above keep the clean text.
          description: options?.rewrapDescription ? options.rewrapDescription(p.title) : p.title,
          net: p.net_amount,
          vat_rate: p.custom_vat_amount ? "custom" : `${roundMoney(p.vat_rate * 100)}%`,
          vat: p.vat_amount,
          deductible_vat: p.deductible_vat_amount,
          non_deductible_vat: p.non_deductible_vat_amount,
          total: p.total,
          vat_registered_company: p.vat_registered,
          vat_deduction_mode: p.vat_deduction_mode,
          expense_debited: p.expense_debit_amount,
        },
        journal_entry: {
          api_response: result,
          ...(existingId !== undefined ? { booking_status: "duplicate" } : {}),
          postings: p.postings.map(posting => ({
            account: posting.account_id,
            type: posting.side,
            amount: posting.amount,
          })),
        },
        note: existingId !== undefined
          ? `An owner-expense journal ${existingId} with the same document number, owner, date and total already exists — no new journal was created.`
          : p.vat_registered
          ? `Draft journal ${String(result.created_object_id)} created, not yet confirmed: it reaches the ledger and reports only after confirm_journal. Once confirmed, owner debt increases by ${p.total} EUR on account ${payableLabel}.`
          : `Draft journal ${String(result.created_object_id)} created, not yet confirmed: it reaches the ledger and reports only after confirm_journal. Company is not VAT-registered, so the full gross amount is debited to expense account ${p.expense_account}. Once confirmed, owner debt increases by ${p.total} EUR on account ${payableLabel}.`,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      }),
    }],
  };
}


/**
 * prepare_dividend_package output (success, numeric shortfall, hold and
 * refusal share one shape; absent fields are omitted).
 */
export interface DividendPackagePayload {
  dry_run?: true;
  plan_handle?: string;
  error?: string;
  error_code?:
    | DividendCapacityHoldCode
    | "approved_annual_report_figures_required"
    | "approved_report_year_out_of_range"
    | "dividend_target_invalid"
    | "dividend_key_conflict"
    | "plan_handle_required"
    | "plan_drift"
    | PlanStoreErrorCode;
  missing?: string[];
  holds?: DividendCapacityHold[];
  details?: string[];
  diagnostic?: {
    lg1_components?: DividendLg1Components;
    net_assets?: DividendLg2Components;
    report_year_end?: string;
    ledger_position_at_report_end?: number;
    note?: string;
  } & Record<string, unknown>;
  calculation?: { net_dividend: number; cit_rate: string; cit_amount: number; gross_dividend: number };
  lg1_components?: DividendLg1Components;
  retained_earnings_check?: {
    account?: number;
    balance_before?: number;
    balance?: number;
    net_dividend_required: number;
    sufficient?: boolean;
    shortfall?: number;
  };
  net_assets_check?: {
    net_assets_before_distribution: number;
    commitments?: number;
    commitment_journals?: DividendCommitment[];
    gross_dividend: number;
    net_assets_after_distribution: number;
    share_capital_account: number;
    share_capital: number;
    restricted_reserves: number;
    restricted_reserve_accounts: Array<{ account: number; balance: number }>;
    minimum_net_assets: number;
    sufficient?: boolean;
    shortfall?: number;
  };
  maximum_distributable?: {
    max_net_dividend: number;
    max_net_by_retained_earnings: number;
    max_net_by_net_assets: number;
    limited_by: "retained_earnings" | "net_assets";
    no_positive_capacity?: true;
    note: string;
  };
  journal_entry?: {
    api_response: { code: number; messages: string[]; created_object_id: number };
    booking_status: string;
    registered?: boolean;
    recovered?: true;
    postings: Array<{ account: number; type?: string; amount: number; description?: string }>;
  };
  existing_journal_id?: number;
  existing_postings?: Array<{ account: number; type?: string; amount: number }> | null;
  requested_postings?: Array<{ account: number; type?: string; amount: number }>;
  warnings?: string[];
  compliance_notes?: string[];
  hint?: string;
  note?: string;
}

/**
 * Dividend journal title, shortening the shareholder's name (with "…") so the
 * title stays within the journal title limit: the name comes from the client
 * record, so the caller cannot shorten it, and preview and booking must agree.
 */
export function dividendJournalTitle(shareholderName: string, amounts: string): string {
  const prefix = "Dividendi väljamakse - ";
  const room = JOURNAL_TITLE_MAX_LENGTH - prefix.length - amounts.length - 1;
  const name = shareholderName.length <= room ? shareholderName : `${shareholderName.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${prefix}${name} ${amounts}`;
}

// Shared owner-expense booking core. Used by BOTH the create_owner_expense_reimbursement
// tool (output byte-identical — same code path) AND the plan-gated server-executed
// owner-expense continuation in continue_accounting_workflow.
export async function bookOwnerExpenseReimbursement(
  api: ApiContext,
  params: OwnerExpenseReimbursementParams,
  options?: OwnerExpenseReimbursementOptions,
): Promise<CallToolResult> {
  const projected = await computeOwnerExpenseJournalProjection(api, params);
  if (!projected.ok) return projected.error;
  return bookOwnerExpenseFromProjection(api, projected.projection, options);
}

export function registerEstonianTaxTools(server: McpServer, api: ApiContext, runtimeSafetyContext: RuntimeSafetyContext): void {

  registerTool(server, "prepare_dividend_package",
    `Calculate dividend CIT (${currentCitRate().formatted} from ${CIT_RATE_TIMELINE[CIT_RATE_TIMELINE.length - 1].from}; earlier dates date-gated) and create draft journal entries. ` +
    "Only the NET dividend debits retained earnings; the CIT books as income-tax expense (P&L 'Tulumaks', Kulud 8900–8999). " +
    "ÄS § 157 lg 1 starts from the owner's APPROVED annual report: pass approved_report_year and, from that report's balance sheet, " +
    "approved_retained_earnings = line 'Eelmiste perioodide jaotamata kasum (kahjum)' and approved_profit_for_year = line 'Aruandeaasta kasum (kahjum)'. " +
    "Ask the owner or read them from the approved report; never compute them from the books. " +
    "The tool cross-checks them against the ledger at that year end (a difference holds the dividend) and subtracts every equity distribution booked since, drafts and later dates included. " +
    "Hard-blocks a net dividend above that, or a gross (net + CIT) that would push net assets below share capital + restricted reserves (lg 2, unconfirmed and later journals reserved), unless force=true; force never lifts a hold or a ledger imbalance. Reports max_net_dividend. " +
    "One journal per shareholder+date: identical retry → duplicate, different amount → dividend_key_conflict. " +
    "Attach the profit-distribution decision to the journal with attach_document. " +
    "Previews by default (dry_run=true), returning a single-use plan_handle: after explicit user approval, call with identical inputs, dry_run=false and that handle. Changed inputs or proposed journal refuse with plan_drift; nothing is written.",
    {
      net_dividend: z.number().finite().describe("Net dividend amount to shareholder (EUR)"),
      shareholder_client_id: coerceId.describe("Shareholder client ID"),
      effective_date: isoDateSchema("Distribution date (YYYY-MM-DD)"),
      approved_report_year: z.number().int().optional().describe("Required. Financial year of the last APPROVED annual report: the dividend year − 1, or − 2 when last year's report is not approved yet."),
      approved_retained_earnings: z.number().finite().optional().describe("Required. EUR, may be negative: balance-sheet line 'Eelmiste perioodide jaotamata kasum (kahjum)' of that approved report. From the owner or the report, never computed."),
      approved_profit_for_year: z.number().finite().optional().describe("Required. EUR, may be negative: balance-sheet line 'Aruandeaasta kasum (kahjum)' of that approved report. From the owner or the report, never computed."),
      ledger_difference_acknowledged: z.number().finite().optional().describe("Only after the owner confirmed the approved figures against the report: the reported difference (approved − ledger at the report year end), to the cent. Never copy the displayed difference without that check."),
      retained_earnings_account: z.number().optional().describe("Retained earnings account debited with the NET dividend (default: auto-detect 'jaotamata kasum', standard 2960). Must be a retained-earnings or result account by name, number or the configured result account"),
      dividend_payable_account: z.number().optional().describe("Dividend payable account (default: auto-detect 'Dividendivõlad', standard 2650)"),
      tax_payable_account: z.number().optional().describe("Dividend income-tax payable (liability) account (default: auto-detect 'Dividenditulumaksu võlg', standard 2656)"),
      income_tax_expense_account: z.number().optional().describe("Income-tax expense account debited with the CIT — the P&L 'Tulumaks' line, Kulud 8900–8999 (default: lowest active such account, else 8900)"),
      share_capital_account: z.number().optional().describe("Share capital account for ÄS §157 net-assets check (default: auto-detect 'Osakapital', standard 2900). Must carry the share-capital name or be 2900"),
      restricted_reserve_accounts: z.array(z.number().int()).optional().describe("Accounts whose balances ÄS §157(2) makes non-distributable (net assets must stay above share capital + these reserves). Default: auto-detect every 'Kohustuslik reservkapital' account (active or inactive) AND always the standard reserve number 2940, so a funded-but-renamed 2940 is never missed; only booked balances raise the floor, so unfunded accounts add nothing. If your chart has REPURPOSED 2940 to a distributable reserve, pass this list explicitly (e.g. [] for no floor, or your real reserve account) to override the 2940 default. Explicit accounts need only exist (inactive OK)."),
      force: z.boolean().optional().describe("Book even if the ÄS § 157 lg 1 or lg 2 amount check fails (only alongside e.g. a capital reduction). Never overrides a hold (approved-report mismatch, unverified amounts, history or draft holds, invalid targets) or a ledger-imbalance block. Default false."),
      dry_run: z.boolean().optional().describe("Preview calculation, legality checks, and postings without creating a journal (default true). Set false only after the user explicitly approves the previewed journal."),
      plan_handle: z.string().optional().describe("Required with dry_run=false: single-use handle from the approved preview, with the same inputs"),
    },
    { ...create, title: "Prepare Dividend Distribution" },
    async ({ net_dividend: rawNetDividend, shareholder_client_id, effective_date, approved_report_year, approved_retained_earnings, approved_profit_for_year, ledger_difference_acknowledged, retained_earnings_account, dividend_payable_account, tax_payable_account, income_tax_expense_account, share_capital_account, restricted_reserve_accounts, force, dry_run = true, plan_handle }) => {
      const refusePlan = (error_code: string, error: string) => toolError({ error_code, error, note: "Nothing was written." });
      const normalizedArgs = stripUndefinedDeep({
        net_dividend: rawNetDividend, shareholder_client_id, effective_date, approved_report_year,
        approved_retained_earnings, approved_profit_for_year, ledger_difference_acknowledged,
        retained_earnings_account, dividend_payable_account, tax_payable_account, income_tax_expense_account,
        share_capital_account, restricted_reserve_accounts, force: force === true,
      }) as PlanRecord;
      let boundPlan: StoredExecutionPlan | undefined;
      if (!dry_run) {
        if (!plan_handle) return refusePlan("plan_handle_required", "Run the dividend preview and obtain approval, then pass its plan_handle with dry_run=false.");
        try {
          boundPlan = runtimeSafetyContext.planStore.consume(plan_handle, DIVIDEND_PLAN_DOMAIN);
        } catch (error) {
          return refusePlan((error as { code?: string }).code ?? "plan_handle_invalid", "The approved dividend plan is unavailable. Run a new preview.");
        }
        if (canonicalPlanJson(boundPlan.normalizedArgs) !== canonicalPlanJson(normalizedArgs)) {
          return refusePlan("plan_drift", "The dividend inputs differ from the approved preview. Run and approve a new preview.");
        }
      }
      // Estonian CIT rate on dividends: date-keyed per TuMS § 50
      // (20/80 pre-2025, 22/78 from 2025-01-01).
      const citRate = getCitRateForDate(effective_date);
      // Statutory prerequisites the ledger cannot prove — surfaced on every
      // path (refused, held, blocked, dry-run, executed, duplicate) so the
      // operator confirms them.
      const complianceNotes = [
        "ÄS § 157 lg 1: väljamakse eeldab KINNITATUD majandusaasta aruannet ja kasumi jaotamise otsust. Kontrolli, et mõlemad on olemas, ja lisa osanike otsus kandele (attach_document, entity_type='journal').",
        `TuMS § 50: dividendi tulumaks (${citRate.formatted}) deklareeritakse TSD lisal 7 ja tasutakse väljamakse kuule järgneva kuu 10. kuupäevaks.`,
      ];
      // Reject non-positive dividends up front — a zero or negative net
      // would otherwise compute gross=0 and book an empty journal with
      // zero-amount postings, which is noise on the ledger and passes
      // both legality checks vacuously.
      if (!(rawNetDividend > 0)) {
        return toolError({
          error: "net_dividend must be > 0",
          compliance_notes: complianceNotes,
          hint: "Pass a positive EUR amount to distribute.",
        });
      }
      // Round to cents once, up front: every downstream amount (CIT, gross,
      // postings, journal title, legality checks, echoed calculation) derives
      // from this value, so a sub-cent input can never leak an unrounded amount
      // into the booked journal or make the reported gross disagree with the
      // sum actually posted.
      const net_dividend = roundMoney(rawNetDividend);
      if (!(net_dividend > 0)) {
        return toolError({
          error: "net_dividend rounds to 0.00 EUR",
          compliance_notes: complianceNotes,
          hint: "Pass a net dividend of at least 0.01 EUR.",
        });
      }
      // Resolve every equity/liability account by NAME against the company's
      // actual chart (falling back to the standard-chart number only when no
      // active account matches), so the tool books to the right account whether
      // or not this company kept the standard account numbers. An explicit
      // caller override always wins.
      const accounts = await api.readonly.getAccounts();
      const retainedAccount = resolveRetainedEarningsAccount(accounts, retained_earnings_account);
      const payableAccount = resolveDividendPayableAccount(accounts, dividend_payable_account);
      const taxAccount = resolveDividendCitPayableAccount(accounts, tax_payable_account);
      const shareCapitalAccount = resolveShareCapitalAccount(accounts, share_capital_account);
      // The CIT is a P&L expense, not a retained-earnings debit, so it needs a
      // dedicated income-tax-expense account. Resolve it against the chart the
      // caller's company actually uses (auto-detects the 8900-series "Tulumaks"
      // account) rather than assuming a fixed number.
      const incomeTaxExpenseAccount = resolveIncomeTaxExpenseAccount(accounts, income_tax_expense_account);
      // Restricted reserves for the §157(2) floor. An explicit override is
      // deduped and validated up front, so a mistyped or absent reserve account
      // errors rather than silently reading a 0 balance and LOWERING the floor —
      // which could let an unlawful dividend through. The default path
      // name-detects "Kohustuslik reservkapital" in the actual chart and is
      // intentionally not required to exist: an absent reservkapital simply means
      // no reserve floor (the account exists in every standard chart but only a
      // BOOKED BALANCE ring-fences net assets — see the balance filter below).
      // resolveRestrictedReserveAccounts returns EVERY "Kohustuslik reservkapital"
      // account (active or inactive, so a funded-but-deactivated reserve is not
      // missed by this statutory gate; a distributable "Vabatahtlik reservkapital"
      // is excluded) UNIONED with the standard 2940, always — so a funded-but-
      // renamed 2940 is read even when an empty legacy exact-name account exists.
      // The floor keys on the booked balance, so an unfunded/absent 2940 adds
      // nothing; a genuinely repurposed 2940 needs an explicit override.
      const restrictedReserveAccounts = restricted_reserve_accounts
        ? [...new Set(restricted_reserve_accounts)]
        : resolveRestrictedReserveAccounts(accounts);
      const targetDiagnostic = {
        retained_earnings_account: retainedAccount,
        income_tax_expense_account: incomeTaxExpenseAccount,
        dividend_payable_account: payableAccount,
        tax_payable_account: taxAccount,
        share_capital_account: shareCapitalAccount,
      };
      const targetAccountErrors = validateAccounts(accounts, [
        { id: retainedAccount, label: "Retained earnings account" },
        { id: payableAccount, label: "Dividend payable account" },
        { id: taxAccount, label: "Tax payable account" },
        { id: incomeTaxExpenseAccount, label: "Income-tax expense account" },
        { id: shareCapitalAccount, label: "Share capital account" },
      ]);
      // Missing or inactive targets: same structured refusal as role-invalid ones.
      if (targetAccountErrors.length > 0) {
        return toolError({
          error: `dividend_target_invalid: ${targetAccountErrors.join(" ")}`,
          error_code: "dividend_target_invalid",
          details: targetAccountErrors,
          diagnostic: targetDiagnostic,
          compliance_notes: complianceNotes,
          hint: "Use list_accounts to find the correct, active account numbers, or omit the override to use the standard account.",
        });
      }
      const accountErrors: string[] = [];
      // Explicit reserve overrides are only READ (their balance raises the
      // § 157 lg 2 floor), never posted to — so validate existence only. A
      // funded-but-deactivated statutory reserve must still be accepted, exactly
      // as the auto-detect path includes inactive "Kohustuslik reservkapital".
      if (restricted_reserve_accounts) {
        for (const id of restrictedReserveAccounts) {
          if (!accounts.some(a => a.id === id)) {
            accountErrors.push(`Restricted reserve account ${id} not found in chart of accounts.`);
          }
        }
      }
      if (accountErrors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: accountErrors,
          compliance_notes: complianceNotes,
          hint: "Use list_accounts to find correct account numbers.",
        });
      }

      // Account roles: the proposed journal's targets must play their real
      // role (an override never establishes its own role).
      const roles = resolveDividendRoles(accounts, getCurrentYearProfitAccountRule());
      const targetProblems = validateDividendTargets(accounts, roles, {
        retainedEarnings: retainedAccount,
        incomeTaxExpense: incomeTaxExpenseAccount,
        dividendPayable: payableAccount,
        taxPayable: taxAccount,
        shareCapital: shareCapitalAccount,
      });
      if (targetProblems.length > 0) {
        return toolError({
          error: `dividend_target_invalid: ${targetProblems.join(" ")}`,
          error_code: "dividend_target_invalid",
          details: targetProblems,
          diagnostic: targetDiagnostic,
          compliance_notes: complianceNotes,
          hint:
            "Use the standard accounts (omit the override) or pass an account that really plays that role. A custom result account " +
            "is set once in the accounting rules (annual report: current year profit account), not through this tool's override.",
        });
      }
      if (approved_report_year !== undefined) {
        const yearProblem = approvedReportYearProblem(approved_report_year, effective_date);
        if (yearProblem) {
          return toolError({
            error: yearProblem,
            error_code: "approved_report_year_out_of_range",
            compliance_notes: complianceNotes,
            hint: "Pass the year of the last annual report the shareholders approved: the year before the dividend year, or two years before when last year's report is not approved yet.",
          });
        }
      }

      const cit = dividendCit(net_dividend, citRate);
      const grossDividend = roundMoney(net_dividend + cit);

      // Shareholder names can originate from receipt OCR auto-created clients:
      // strip any sandbox markers before the name enters the journal title or
      // audit log, and wrap it again at every MCP output site.
      const shareholder = await api.clients.get(shareholder_client_id);
      const shareholderName = desandboxText(shareholder.name ?? "");
      const dividendKey: DocKey = {
        ns: "DIV",
        id: `${effective_date}-${shareholder_client_id}`,
      };
      const documentNumber = formatDocNumber(dividendKey);

      // Journal entry (Estonian GAAP / RTJ): the NET dividend is the only debit
      // to retained earnings (Jaotamata kasum) — it is what the resolution
      // distributes to the shareholder. The distribution income tax (TuMS § 50)
      // is a current-period income-tax EXPENSE (the P&L "Tulumaks" line), not a
      // reduction of retained earnings, so it debits the income-tax-expense
      // account. Credits go to dividend payable and the tax liability. Net
      // assets still fall by the full gross (both a dividend payable and a tax
      // liability arise), which is why the § 157 lg 2 net-assets check below is
      // gross-based — while the § 157 lg 1 ceiling is net-based, since the tax
      // is not part of the distribution.
      const postings = [
        { accounts_id: retainedAccount, type: "D" as const, amount: net_dividend },
        { accounts_id: incomeTaxExpenseAccount, type: "D" as const, amount: cit },
        { accounts_id: payableAccount, type: "C" as const, amount: net_dividend },
        { accounts_id: taxAccount, type: "C" as const, amount: cit },
      ];
      const postingDescriptions = [
        "Dividend (net) — Jaotamata kasum",
        `Tulumaksukulu ${citRate.formatted} (dividend)`,
        "Dividendide võlgnevus",
        "Tulumaksu kohustus",
      ];
      const echoPostings = (list: ReadonlyArray<Pick<Posting, "accounts_id" | "type" | "amount" | "base_amount" | "is_deleted">>) =>
        list.filter(p => !p.is_deleted).map(p => {
          const idx = postings.findIndex(r => r.accounts_id === p.accounts_id && r.type === p.type);
          return {
            account: p.accounts_id,
            type: p.type,
            amount: roundMoney(p.base_amount ?? p.amount),
            ...(idx >= 0 && { description: postingDescriptions[idx] }),
          };
        });
      const requestedSignature = postingSignature(postings);

      // Self-documenting title so an operator opening the journal in e-arveldaja
      // can see the split (net dividend vs. income-tax expense) without cross-
      // referencing the audit log. The API Posting type has no per-line
      // description field, so the split rationale has to live on the journal
      // itself.
      const journalData = {
        title: dividendJournalTitle(shareholderName, `(neto ${net_dividend} EUR, TuMa ${citRate.formatted} ${cit} EUR)`),
        effective_date,
        clients_id: shareholder_client_id,
        cl_currencies_id: "EUR",
        postings,
      };
      const calculation = { net_dividend, cit_rate: citRate.formatted, cit_amount: cit, gross_dividend: grossDividend };
      const proposalFingerprint = canonicalPlanJson({ ...journalData, document_number: documentNumber });
      if (boundPlan && (boundPlan.privatePayload as { fingerprint?: unknown }).fingerprint !== proposalFingerprint) {
        return refusePlan("plan_drift", "The proposed dividend journal changed after preview. Run and approve a new preview.");
      }
      const bookingSummary = {
        retained_earnings_account: retainedAccount,
        retained_earnings_debit: net_dividend,
        income_tax_expense_account: incomeTaxExpenseAccount,
        income_tax_expense_debit: cit,
        note: "Only the net dividend drains retained earnings; the CIT is booked as income-tax expense (P&L 'Tulumaks').",
      };
      const shareholderEcho = { id: shareholder_client_id, name: wrapUntrustedOcr(shareholderName) };

      const loadExistingPostings = async (journalId: number, known?: Posting[]): Promise<Posting[] | undefined> => {
        if (known && known.length > 0) return known;
        try {
          return (await api.journals.get(journalId))?.postings;
        } catch {
          return undefined;
        }
      };
      // The DIV-{date}-{shareholder} key identifies ONE distribution decision.
      // A same-key journal whose postings differ is a different decision (e.g.
      // a corrected amount), never a retry — reusing it silently would report
      // "duplicate" while the ledger holds the OLD amount.
      const keyConflict = (journalId: number, existingPostings: Posting[] | undefined) => toolError({
        error: `dividend_key_conflict: journal ${journalId} already carries ${documentNumber} with different postings`,
        error_code: "dividend_key_conflict",
        document_number: documentNumber,
        existing_journal_id: journalId,
        existing_postings: existingPostings ? echoPostings(existingPostings) : null,
        requested_postings: echoPostings(postings),
        calculation,
        compliance_notes: complianceNotes,
        hint:
          `One dividend journal per shareholder per date. If the existing journal ${journalId} is wrong, ` +
          "delete (or invalidate and delete) it first and re-run; for an additional distribution to the same " +
          "shareholder, use a different effective_date.",
      });

      // Two concurrent executions must not spend the same § 157 headroom: hold
      // one per-connection lock from the fresh ledger read through the create
      // (lock order: this per-connection lock, then createJournalOnce's per-key lock).
      const checkAndBook = async () => {
        // Preload journals once for the duplicate pre-check and both legality
        // checks. Load API journals including INITIAL exactly once here;
        // both checks compute account-level equity with no
        // client filter, so the opening balance correctly feeds the lg1 ceiling
        // and the lg2 net-assets floor.
        const { opening, journals: allJournals } = await loadJournalsWithOpeningBalance(api);

        // The approved figures are business-required: without them nothing
        // beyond a diagnostic ledger position is computed.
        if (approved_report_year === undefined || approved_retained_earnings === undefined || approved_profit_for_year === undefined) {
          const diagnosticYear = approved_report_year ?? Number(effective_date.slice(0, 4)) - 1;
          const missing = [
            ...(approved_report_year === undefined ? ["approved_report_year"] : []),
            ...(approved_retained_earnings === undefined ? ["approved_retained_earnings"] : []),
            ...(approved_profit_for_year === undefined ? ["approved_profit_for_year"] : []),
          ];
          return toolError({
            error: `approved_annual_report_figures_required: missing ${missing.join(", ")}`,
            error_code: "approved_annual_report_figures_required",
            missing,
            diagnostic: {
              report_year_end: `${diagnosticYear}-12-31`,
              ledger_position_at_report_end: ledgerPositionAtReportEnd(allJournals, roles, diagnosticYear),
              note:
                `Books only (retained earnings + result + open income/expense up to ${diagnosticYear}-12-31). ` +
                "This is not the approved figure and must not be passed back as one.",
            },
            compliance_notes: complianceNotes,
            hint:
              "Ask the owner for the last APPROVED annual report and pass approved_report_year plus the balance-sheet lines " +
              "'Eelmiste perioodide jaotamata kasum (kahjum)' (approved_retained_earnings) and 'Aruandeaasta kasum (kahjum)' (approved_profit_for_year). " +
              "Never compute them from the books.",
          });
        }
        const approved = {
          reportYear: approved_report_year,
          retainedEarnings: approved_retained_earnings,
          profitForYear: approved_profit_for_year,
        };

        // Duplicate pre-check BEFORE the legality checks: once a dividend is
        // booked, the ledger already reflects it, so re-running the § 157 checks
        // on a retry would report e.g. "insufficient retained earnings" for a
        // distribution that is in fact already recorded. Same key + same postings
        // → report the existing journal; same key + different postings → conflict.
        const existingSameKey = allJournals.find(j => j.id != null && !j.is_deleted && j.document_number === documentNumber);
        if (existingSameKey) {
          const existingId = existingSameKey.id!;
          const existingPostings = await loadExistingPostings(existingId, existingSameKey.postings);
          if (!existingPostings || postingSignature(existingPostings).join() !== requestedSignature.join()) {
            return keyConflict(existingId, existingPostings);
          }
          const echoed = echoPostings(existingPostings);
          if (!dry_run) {
            logAudit({
              tool: "prepare_dividend_package",
              action: "UPDATED",
              entity_type: "journal",
              entity_id: existingId,
              summary: `Existing dividend journal ${existingId} reused for ${net_dividend} EUR net to ${shareholderName}`,
              details: {
                effective_date, client_name: shareholderName, amount: grossDividend,
                total_net: net_dividend, total_gross: grossDividend,
                postings: echoed.map(p => ({ accounts_id: p.account, type: p.type, amount: p.amount })),
                booking_key: documentNumber,
                booking_status: "duplicate",
              },
            });
          }
          return {
            content: [{
              type: "text",
              text: toMcpJson({
                ...(dry_run && { dry_run: true }),
                calculation,
                booking: bookingSummary,
                shareholder: shareholderEcho,
                journal_entry: {
                  api_response: {
                    code: 200,
                    messages: [`Existing dividend journal ${existingId} reused.`],
                    created_object_id: existingId,
                  },
                  booking_status: "duplicate",
                  registered: existingSameKey.registered === true,
                  postings: echoed,
                },
                note:
                  `An identical dividend journal ${existingId} (${documentNumber}) already exists — no new journal ` +
                  `${dry_run ? "would be" : "was"} created. ÄS § 157 legality checks were not re-run: the ledger already ` +
                  "includes this distribution (or its unconfirmed draft).",
                compliance_notes: complianceNotes,
              }),
            }],
          };
        }

        const capacity = computeDividendCapacity({
          accounts,
          journals: allJournals,
          effectiveDate: effective_date,
          approved,
          ledgerDifferenceAcknowledged: ledger_difference_acknowledged,
          roles,
          shareCapitalAccount,
          restrictedReserveAccounts,
        });
        const lg1Components = capacity.lg1;
        const lg2 = capacity.lg2;
        const warnings: string[] = [];
        // Opening-balance status: share capital and retained earnings are commonly
        // entered as INITIAL opening-balance entries. Disclose the selected
        // source and any registration/date exclusion from the §157 figures.
        warnings.push(...withOpeningBalanceJournalStatus([], opening, undefined, effective_date));

        // Holds: the figures cannot be trusted, so no maximum and no verdict —
        // only a diagnostic. force never overrides a hold.
        if (capacity.holds.length > 0) {
          const primary = DIVIDEND_HOLD_PRIORITY.find(code => capacity.holds.some(h => h.code === code))!;
          const messages = capacity.holds.map(h => {
            switch (h.code) {
              case "distribution_history_incomplete":
                return `distribution_history_incomplete: an opening balance dated after ${h.boundary_opening_date} ` +
                  `(${h.journals.map(j => `journal ${j.journal_id} on ${j.effective_date}`).join(", ")}) means the distributions made between the approved report and the opening are not in the books`;
              case "dividend_amount_unverified":
                return `dividend_amount_unverified: ${h.postings.length} foreign-currency posting(s) without a EUR value ` +
                  `(${[...new Set(h.postings.map(p => `journal ${p.journal_id}`))].join(", ")})`;
              case "pre_report_equity_draft":
                return `pre_report_equity_draft: unconfirmed journal(s) dated on or before ${approved.reportYear}-12-31 change equity ` +
                  `(${h.journals.map(j => `journal ${j.journal_id}`).join(", ")}); registering them would change the approved position`;
              case "pre_report_draft_reduces_net_assets":
                return `pre_report_draft_reduces_net_assets: unconfirmed journal(s) dated on or before ${approved.reportYear}-12-31 reduce net assets ` +
                  `(${h.journals.map(j => `journal ${j.journal_id}`).join(", ")}); the net-assets check cannot tell whether the approved figures include them`;
              case "approved_report_ledger_mismatch":
                return `approved_report_ledger_mismatch: the approved ${approved.reportYear} figures (${h.approved_total} EUR) differ from the ledger ` +
                  `at ${approved.reportYear}-12-31 (${h.ledger_position_at_report_end} EUR) by ${h.difference} EUR`;
            }
          });
          const hints: Record<typeof primary, string> = {
            distribution_history_incomplete:
              `Book the history since ${approved.reportYear}-12-31 (or move the opening to ${approved.reportYear + 1}-01-01 and book what follows), ` +
              "or use the approved report that the opening balance starts from. ledger_difference_acknowledged and force=true do not lift this hold.",
            dividend_amount_unverified:
              "Add the EUR value (base_amount) to the listed foreign-currency journals in e-arveldaja, then re-run. force=true does not override this hold.",
            pre_report_equity_draft:
              `Confirm or delete the listed unconfirmed journal(s) dated on or before ${approved.reportYear}-12-31, then check the approved figures again. force=true does not override this hold.`,
            pre_report_draft_reduces_net_assets:
              `Register or delete the listed unconfirmed journal(s) dated on or before ${approved.reportYear}-12-31 so the books match the approved report, then retry; ` +
              "the approved figures may already include them. force=true does not override this hold.",
            approved_report_ledger_mismatch:
              "Check approved_retained_earnings and approved_profit_for_year against the owner's approved annual report (balance-sheet lines " +
              "'Eelmiste perioodide jaotamata kasum (kahjum)' and 'Aruandeaasta kasum (kahjum)') and approved_report_year. If the report is right and the books " +
              "differ, pass ledger_difference_acknowledged equal to the difference only after that check with the owner — never by copying the difference shown here. " +
              "force=true does not override this hold.",
          };
          return toolError({
            error: messages.join("; "),
            error_code: primary,
            holds: capacity.holds,
            diagnostic: { lg1_components: lg1Components, net_assets: lg2 },
            calculation,
            ...(warnings.length > 0 && { warnings }),
            compliance_notes: complianceNotes,
            hint: hints[primary],
          });
        }

        const balances = await computeAllBalances(api, undefined, effective_date, {
          preloadedAccounts: accounts,
          preloadedJournals: allJournals,
        });
        const byCategory = (cat: string): AccountBalance[] =>
          balances.filter(b => b.account_type_est === cat);
        // Cross-check: on a balanced ledger, Assets − Liabilities must equal
        // Equity + P&L. A mismatch indicates unbalanced or partially-deleted
        // journals — hard-block; force=true does NOT override this.
        // Tolerance 0.05 accounts for rounding drift across the 5 sub-totals.
        const totalAssets = sumCategory(byCategory("Varad"), "D");
        const totalLiabilities = sumCategory(byCategory("Kohustused"), "C");
        const balanceSheetEquity = roundMoney(sumCategory(byCategory("Omakapital"), "C") +
          sumCategory(byCategory("Tulud"), "C") - sumCategory(byCategory("Kulud"), "D"));
        const assetsMinusLiabilities = roundMoney(totalAssets - totalLiabilities);
        const ledgerImbalance = Math.abs(assetsMinusLiabilities - balanceSheetEquity) > 0.05;
        if (ledgerImbalance) {
          warnings.push(
            `Ledger imbalance: Assets − Liabilities (${assetsMinusLiabilities} EUR) ` +
            `does not equal Equity + current-year P&L (${balanceSheetEquity} EUR). ` +
            `Retained-earnings and §157 net-assets checks are unreliable on this ledger. ` +
            `Investigate unregistered/deleted journals before distributing.`
          );
        }

        const netCents = dividendToCents(net_dividend);
        const grossCents = dividendToCents(grossDividend);
        const retainedShortfall = netCents > capacity.lg1Cents;
        const netAssetsBreach = grossCents > capacity.headroomCents;
        const netAssetsAfterDistribution = roundMoney(lg2.headroom + lg2.minimum_net_assets - grossDividend);
        const distributableProfit = lg1Components.distributable_profit;
        const legalCapitalFloor = lg2.minimum_net_assets;
        const shareCapitalFloor = Math.max(0, lg2.share_capital);
        const restrictedReserveFloor = roundMoney(legalCapitalFloor - shareCapitalFloor);

        const maximum = maxNetDividend(capacity.lg1Cents, capacity.headroomCents, citRate);
        const maxNetDividendValue = maximum.max_net_dividend;
        const maximumDistributable = {
          ...maximum,
          ...(maxNetDividendValue === 0 && { no_positive_capacity: true }),
          note:
            "Largest lawful NET dividend in whole cents: net ≤ lg 1 distributable profit (approved report − distributions since) and " +
            `net + CIT (${citRate.formatted}, rounded as booked) ≤ net assets − § 157 lg 2 floor − commitments.`,
        };
        const retainedEarningsCheck = {
          account: retainedAccount,
          balance_before: distributableProfit,
          net_dividend_required: net_dividend,
          sufficient: !retainedShortfall,
        };
        const netAssetsCheckBase = {
          net_assets_before_distribution: lg2.net_assets_before_distribution,
          ...(lg2.commitments !== 0 && { commitments: lg2.commitments, commitment_journals: lg2.commitment_journals }),
          gross_dividend: grossDividend,
          net_assets_after_distribution: netAssetsAfterDistribution,
          share_capital_account: shareCapitalAccount,
          share_capital: lg2.share_capital,
          restricted_reserves: lg2.restricted_reserves,
          restricted_reserve_accounts: lg2.restricted_reserve_accounts,
          minimum_net_assets: legalCapitalFloor,
        };
        const netAssetsCheck = { ...netAssetsCheckBase, sufficient: !netAssetsBreach };

        if (lg2.commitments !== 0) {
          warnings.push(
            `Unconfirmed or later-dated journals reserve ${lg2.commitments} EUR of the § 157 lg 2 headroom: ` +
            `${lg2.commitment_journals.map(c => `journal ${c.journal_id}${c.document_number ? ` (${c.document_number})` : ""} ${c.reserved} EUR`).join(", ")}.`
          );
        }
        if (lg1Components.difference_acknowledged) {
          warnings.push(
            `The approved figures differ from the ledger at ${approved.reportYear}-12-31 by ${lg1Components.difference} EUR; ` +
            "accepted because ledger_difference_acknowledged matches. lg 1 uses the approved figures."
          );
        }
        // Transparency: when reservkapital was auto-detected (no explicit override)
        // and carries a balance, tell the operator the floor was raised above bare
        // share capital. The floor is keyed on the BOOKED BALANCE.
        if (restricted_reserve_accounts === undefined && restrictedReserveFloor > 0) {
          warnings.push(
            `ÄS § 157(2) restricted-reserve floor applied: reservkapital ` +
            `${lg2.restricted_reserve_accounts.map(r => `${r.account} (${r.balance} EUR)`).join(", ")} ` +
            `raises the minimum net-assets floor to ${legalCapitalFloor} EUR ` +
            `(share capital ${shareCapitalFloor} + reserves ${restrictedReserveFloor}). ` +
            `This assumes the company's articles (põhikiri) mandate this statutory reserve; ` +
            `if they do not, pass restricted_reserve_accounts=[] to exclude it from the floor.`
          );
        }
        const violations: string[] = [];
        if (ledgerImbalance) violations.push("Ledger is imbalanced — legality checks cannot be trusted");
        if (retainedShortfall) violations.push("Insufficient retained earnings");
        if (netAssetsBreach) violations.push("ÄS § 157 net assets breach");

        // force overrides only the numeric § 157 shortfalls, never a ledger imbalance.
        if (ledgerImbalance || (violations.length > 0 && !force)) {
          return toolError({
            error: violations.join("; "),
            lg1_components: lg1Components,
            ...(retainedShortfall && {
              retained_earnings_check: {
                balance: distributableProfit,
                net_dividend_required: net_dividend,
                shortfall: roundMoney(net_dividend - distributableProfit),
                note: "ÄS § 157 lg 1 limit is NET-based: the CIT is a current-period expense, not part of the distribution.",
              },
            }),
            ...(netAssetsBreach && {
              net_assets_check: {
                ...netAssetsCheckBase,
                shortfall: roundMoney(legalCapitalFloor - netAssetsAfterDistribution),
              },
            }),
            maximum_distributable: maximumDistributable,
            calculation,
            ...(warnings.length > 0 && { warnings }),
            compliance_notes: complianceNotes,
            hint:
              ledgerImbalance
                ? "The ledger is imbalanced (Assets − Liabilities ≠ Equity + P&L); force=true does not override this. Find and fix the unbalanced or partially-deleted journals, then re-run."
                : retainedShortfall && netAssetsBreach
                  ? `Both retained-earnings and § 157 net-assets clauses fail (max lawful net dividend: ${maxNetDividendValue} EUR). Reduce the dividend, register a capital reduction first, or set force=true to override (unlawful absent additional action).`
                  : retainedShortfall
                    ? `Net dividend exceeds distributable profit (ÄS § 157 lg 1). Max lawful net dividend: ${maxNetDividendValue} EUR. Set force=true to create the journal anyway.`
                    : `Distribution would push net assets below the ÄS § 157 lg 2 floor (share capital + restricted reserves; the check is gross-based because the CIT liability also reduces net assets). Max lawful net dividend: ${maxNetDividendValue} EUR. Reduce the dividend, register a capital reduction first, or set force=true to override (unlawful absent additional action).`,
          });
        }

        if (retainedShortfall) {
          warnings.push(
            `Distributable profit (${distributableProfit} EUR) is less than the net dividend (${net_dividend} EUR). ` +
            `Verify that distribution is lawful per ÄS § 157 lg 1. Journal created because force=true.`
          );
        }
        if (netAssetsBreach) {
          warnings.push(
            `Net assets after distribution (${netAssetsAfterDistribution} EUR) would fall below the ÄS § 157 floor of ${legalCapitalFloor} EUR ` +
            `(share capital ${shareCapitalFloor} EUR on account ${shareCapitalAccount}` +
            `${restrictedReserveFloor > 0 ? ` + restricted reserves ${restrictedReserveFloor} EUR` : ""}). ` +
            `Journal created because force=true. Verify ÄS § 157 compliance through a separate legal action (e.g. capital reduction).`
          );
        }

        if (dry_run) {
          const planHandle = runtimeSafetyContext.planStore.issue(DIVIDEND_PLAN_DOMAIN, {
            normalizedArgs, sourceIdentities: [], liveSnapshot: {},
            commands: [{ id: "dividend", category: "dividend_journal" }],
            counts: { journals: 1 }, totals: { net_dividend, cit, gross_dividend: grossDividend },
            exclusions: [], reviews: [], privatePayload: { fingerprint: proposalFingerprint },
          });
          return {
            content: [{
              type: "text",
              text: toMcpJson({
                dry_run: true,
                plan_handle: planHandle,
                calculation,
                booking: bookingSummary,
                proposed_journal: { ...journalData, title: wrapUntrustedOcr(journalData.title), document_number: documentNumber },
                shareholder: shareholderEcho,
                lg1_components: lg1Components,
                retained_earnings_check: retainedEarningsCheck,
                maximum_distributable: maximumDistributable,
                net_assets_check: netAssetsCheck,
                ...(warnings.length > 0 && { warnings }),
                compliance_notes: complianceNotes,
                note: "No journal created. After approval, pass the same inputs, dry_run=false and this single-use plan_handle. Execution rechecks the fresh ledger.",
              }),
            }],
          };
        }

        const guard = await BookingGuard.load(api);
        const booking = await guard.createJournalOnce(dividendKey, journalData, { confirm: false });
        const createdId = booking.journal_id;
        const recovered = booking.status === "created" && booking.recovered === true;
        // A duplicate (a same-key journal appeared after the pre-check) or a
        // recovered ambiguous create may be SOMEONE ELSE's journal: verify its
        // actual postings match this request before reporting success, and echo
        // what is really in the ledger.
        let echoedPostings = echoPostings(postings);
        if (booking.status === "duplicate" || recovered) {
          const existingPostings = await loadExistingPostings(createdId);
          if (!existingPostings || postingSignature(existingPostings).join() !== requestedSignature.join()) {
            return keyConflict(createdId, existingPostings);
          }
          echoedPostings = echoPostings(existingPostings);
        }
        const apiResponse = booking.status === "created" && booking.upstream_response
          ? {
              code: booking.upstream_response.code,
              messages: booking.upstream_response.messages,
              created_object_id: createdId,
            }
          : {
              code: 200,
              messages: [booking.status === "duplicate"
                ? `Existing dividend journal ${createdId} reused.`
                : `Dividend journal ${createdId} recovered after an ambiguous create.`],
              created_object_id: createdId,
            };
        logAudit({
          tool: "prepare_dividend_package",
          action: booking.status === "created" ? "CREATED" : "UPDATED",
          entity_type: "journal",
          entity_id: createdId,
          summary: booking.status === "created"
            ? `Dividend journal: ${net_dividend} EUR net to ${shareholderName}, CIT ${cit} EUR`
            : `Existing dividend journal ${createdId} reused for ${net_dividend} EUR net to ${shareholderName}`,
          details: {
            effective_date, client_name: shareholderName, amount: grossDividend,
            total_net: net_dividend, total_gross: grossDividend,
            postings: echoedPostings.map(p => ({ accounts_id: p.account, type: p.type, amount: p.amount })),
            booking_key: documentNumber,
            booking_status: booking.status,
            ...(warnings.length > 0 && { warnings }),
          },
        });

        return {
          content: [{
            type: "text",
            text: toMcpJson({
              calculation,
              booking: bookingSummary,
              lg1_components: lg1Components,
              retained_earnings_check: retainedEarningsCheck,
              net_assets_check: netAssetsCheck,
              maximum_distributable: maximumDistributable,
              shareholder: shareholderEcho,
              journal_entry: {
                api_response: apiResponse,
                booking_status: booking.status,
                ...(recovered ? { recovered: true } : {}),
                postings: echoedPostings,
              },
              ...(warnings.length > 0 && { warnings }),
              compliance_notes: complianceNotes,
            }),
          }],
        };
      };
      if (dry_run) return checkAndBook();
      let lockScope: string;
      try {
        lockScope = await companyLedgerLockScope(api);
      } catch (error) {
        return toolError(error);
      }
      return withBookingKeyLock(lockScope, { ns: "DIV", id: "__headroom__" }, async () => {
        api.journals.invalidateListCache();
        return checkAndBook();
      });
    }
  );

  registerTool(server, "create_owner_expense_reimbursement",
    "Create a journal for a business expense paid personally by the owner.",
    {
      owner_client_id: coerceId.describe("Owner/shareholder client ID"),
      effective_date: isoDateSchema("Expense date (YYYY-MM-DD)"),
      description: z.string().describe("Expense description"),
      net_amount: z.number().finite().describe("Net amount (without VAT)"),
      vat_rate: z.number().finite().describe("VAT rate as decimal (e.g. 0.24 for 24%; 0 only when the document has no VAT). Must be a fraction, NOT a percentage — use 0.24, not 24. For non-deductible VAT keep the document's rate (or pass vat_amount) and set vat_deduction_mode=\"none\": the VAT is then added to the expense and the owner payable."),
      vat_amount: z.number().finite().optional().describe("Exact VAT amount (overrides vat_rate if provided)"),
      vat_deduction_mode: z.enum(["none", "full", "partial"]).optional().describe("VAT deduction mode. Use partial with deductible_vat_amount."),
      deductible_vat_amount: z.number().finite().optional().describe("Deductible part of VAT when vat_deduction_mode=partial, or an explicit deductible VAT amount to override the default or configured ratio."),
      expense_account: z.number().describe("Expense account number (e.g. 5000, 6000)"),
      expense_account_dimension_id: coerceId.optional().describe("Dimension ID of the expense account; required when that account has dimensions"),
      vat_account: z.number().optional().describe("Input VAT account (default 1510)"),
      payable_account: z.number().optional().describe("Payable to owner account (default 2110)"),
      payable_account_dimension_id: coerceId.optional().describe("Dimension ID of the payable account (e.g. the owner's own dimension); required when that account has dimensions (e.g. a 2110 split by lender)"),
      document_number: z.string().optional().describe("Receipt/document number"),
    },
    { ...create, title: "Book Owner-Paid Expense" },
    async (args) => bookOwnerExpenseReimbursement(api, args),
  );

  registerTool(server, "check_vat_registration_threshold",
    `Check whether a non-VAT-registered Estonian company may be approaching or exceeding the ${VAT_REGISTRATION_THRESHOLD_DISPLAY} VAT registration threshold under the scope effective ${ESTONIAN_VAT_METADATA.registration.scope_effective_from}. Facts verified ${ESTONIAN_VAT_METADATA.verified_at}; source: ${VAT_THRESHOLD_SOURCE.url}. Read-only advisory: confirmed sale invoices provide the taxable/0% turnover base, while real-estate, insurance, and financial turnover are supplied separately so the operator can decide whether they are non-incidental and count toward the threshold.`,
    {
      year: z.number().int().min(2000).max(2100).optional().describe("Calendar year to check. Defaults to the current year."),
      taxable_turnover_adjustment: z.number().finite().optional().describe("Manual EUR adjustment to confirmed sale-invoice turnover. Use negative values to exclude fixed-asset disposals, non-Estonian-place turnover, or other amounts that should not count; use positive values for taxable/0% turnover not represented by sale invoices."),
      real_estate_turnover: z.number().finite().min(0).optional().describe("EUR turnover from KMS §16(2) p 2, 3, 6 real-estate transactions/rent. Counts toward the threshold only when not fixed-asset disposal and not incidental."),
      insurance_turnover: z.number().finite().min(0).optional().describe("EUR turnover from insurance/reinsurance/intermediation services. Counts toward the threshold only when not incidental."),
      financial_turnover: z.number().finite().min(0).optional().describe("EUR turnover from financial services, e.g. non-incidental lending interest, securities/FX activity, leasing or payment services. Counts toward the threshold only when it is business turnover and not incidental; bank deposit interest, received dividends, and incidental investment disposals are normally excluded."),
      exempt_social_turnover: z.number().finite().min(0).optional().describe(`EUR social-type exempt turnover such as healthcare or education. Reported separately and not counted toward the ${VAT_REGISTRATION_THRESHOLD_DISPLAY} threshold.`),
      incidental_excluded_turnover: z.number().finite().min(0).optional().describe("EUR real-estate/financial/insurance turnover the operator has judged incidental. Reported separately and not counted toward the threshold."),
      manual_bucket_source: z.enum(["outside_sale_invoices", "included_in_sale_invoices"]).optional().describe("Whether the manually entered real_estate/insurance/financial/exempt/incidental buckets are already included in confirmed sale invoices. Defaults to outside_sale_invoices; use included_in_sale_invoices to reclassify parts of sale-invoice turnover and avoid double counting."),
    },
    { ...readOnly, title: "Check VAT Registration Threshold" },
    async ({
      year,
      taxable_turnover_adjustment,
      real_estate_turnover,
      insurance_turnover,
      financial_turnover,
      exempt_social_turnover,
      incidental_excluded_turnover,
      manual_bucket_source,
    }) => {
      // Estonian calendar year: at 00:30 Tallinn on 1 January UTC is still the old year.
      const checkYear = year ?? Number(todayInTallinn().slice(0, 4));
      const from = `${checkYear}-01-01`;
      const to = `${checkYear}-12-31`;
      const [vatRegistered, saleInvoices] = await Promise.all([
        isCompanyVatRegistered(api),
        api.saleInvoices.listAll({ start_date: from, end_date: to, status: "CONFIRMED" }),
      ]);

      const confirmedSales = saleInvoices.filter(invoice =>
        invoice.status === "CONFIRMED" &&
        invoice.journal_date >= from &&
        invoice.journal_date <= to,
      );
      const saleInvoiceConfirmedTurnover = roundMoney(confirmedSales.reduce(
        (sum, invoice) => sum + saleInvoiceTurnoverAmount(invoice),
        0,
      ));
      const taxableAdjustment = roundMoney(taxable_turnover_adjustment ?? 0);
      const realEstateTurnover = roundMoney(real_estate_turnover ?? 0);
      const insuranceTurnover = roundMoney(insurance_turnover ?? 0);
      const financialTurnover = roundMoney(financial_turnover ?? 0);
      const exemptSocialTurnover = roundMoney(exempt_social_turnover ?? 0);
      const incidentalExcludedTurnover = roundMoney(incidental_excluded_turnover ?? 0);
      const manualBucketSource = manual_bucket_source ?? "outside_sale_invoices";
      const manualBucketsTotal = roundMoney(realEstateTurnover + insuranceTurnover + financialTurnover + exemptSocialTurnover + incidentalExcludedTurnover);
      const reclassifiedFromSaleInvoices = manualBucketSource === "included_in_sale_invoices" ? manualBucketsTotal : 0;
      const saleInvoiceOrdinaryTurnover = roundMoney(Math.max(0, saleInvoiceConfirmedTurnover - reclassifiedFromSaleInvoices));
      const countIfNotIncidental = roundMoney(realEstateTurnover + insuranceTurnover + financialTurnover);
      const taxableOrZeroRatedTurnover = roundMoney(Math.max(0, saleInvoiceOrdinaryTurnover + taxableAdjustment));
      const thresholdTotalIfAllNonIncidental = roundMoney(taxableOrZeroRatedTurnover + countIfNotIncidental);
      const status = thresholdStatus({
        vatRegistered,
        taxableTurnover: taxableOrZeroRatedTurnover,
        thresholdTotalIfAllNonIncidental,
      });

      const inputWarnings: string[] = [];
      if (manualBucketSource === "included_in_sale_invoices" && reclassifiedFromSaleInvoices > saleInvoiceConfirmedTurnover) {
        inputWarnings.push("manual_bucket_source='included_in_sale_invoices' was used, but manual buckets exceed confirmed sale-invoice turnover. Check whether some buckets are actually outside sale invoices.");
      }

      const manualReviewQuestions = [
        "Kas real_estate_turnover sisaldab ainult KMS §16 lg 2 p 2, 3 või 6 kinnisasjatehinguid, mis ei ole põhivara võõrandamine ega juhuslik tehing?",
        "Kas insurance_turnover on ettevõtte tavapärane kindlustus-/edasikindlustus-/vahendusteenuse käive, mitte juhuslik teenus?",
        "Kas financial_turnover on ettevõtluse käigus osutatud finantsteenuse käive (nt laenuintress ettevõtte tavategevusena), mitte hoiuseintress, saadud dividend, võlakirja lunastus või juhuslik investeeringutehing?",
        "Kas käsitsi sisestatud käibeliigid on juba müügiarvete sees? Kui jah, kasuta manual_bucket_source='included_in_sale_invoices', et neid mitte topelt lugeda.",
        "Kas mõni muu müügiarve kuulub taxable_turnover_adjustment kaudu välja arvata, sest käibe tekkimise koht ei ole Eesti või tegu on põhivara võõrandamisega?",
      ];

      const suggestedAction = status === "already_registered"
        ? "Company already has a VAT number; use this breakdown as a reasonableness check only."
        : status === "exceeded"
          ? `Tavalise maksustatava/0% käibe põhjal on ${VAT_REGISTRATION_THRESHOLD_DISPLAY} piirmäär ületatud; kontrolli kuupäeva, millal registreerimiskohustus tekkis, ja valmista KMKR avaldus.`
          : status === "needs_manual_review"
            ? `${VAT_REGISTRATION_THRESHOLD_DISPLAY} piirmäära ületamine sõltub finants-, kindlustus- või kinnisasjakäibe mitte-juhuslikuks lugemisest. Märgi juhuslik osa incidental_excluded_turnover alla või lisa mitte-juhuslik osa vastavasse käibeliiki.`
            : status === "approaching"
              ? "Piirmäärale lähenetakse; jälgi järgmisi müügiarveid ja hinda eraldi finants-, kindlustus- ning kinnisasjakäibe juhuslikkust."
              : "Piirmäär ei ole sisestatud andmete põhjal lähedal.";

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            year: checkYear,
            period: { from, to },
            vat_registered: vatRegistered,
            threshold_eur: VAT_REGISTRATION_THRESHOLD_EUR,
            vat_metadata: ESTONIAN_VAT_METADATA,
            status,
            sale_invoice_confirmed_turnover: saleInvoiceConfirmedTurnover,
            confirmed_sale_invoice_count: confirmedSales.length,
            manual_bucket_source: manualBucketSource,
            sale_invoice_turnover_reclassified_to_manual_buckets: reclassifiedFromSaleInvoices,
            sale_invoice_ordinary_turnover_after_bucket_split: saleInvoiceOrdinaryTurnover,
            taxable_turnover_adjustment: taxableAdjustment,
            taxable_or_zero_rated_turnover: taxableOrZeroRatedTurnover,
            count_if_not_incidental: {
              real_estate_turnover: realEstateTurnover,
              insurance_turnover: insuranceTurnover,
              financial_turnover: financialTurnover,
              total: countIfNotIncidental,
            },
            not_counted: {
              exempt_social_turnover: exemptSocialTurnover,
              incidental_excluded_turnover: incidentalExcludedTurnover,
            },
            threshold_total_if_all_non_incidental: thresholdTotalIfAllNonIncidental,
            remaining_if_all_non_incidental: roundMoney(Math.max(0, VAT_REGISTRATION_THRESHOLD_EUR - thresholdTotalIfAllNonIncidental)),
            excess_if_all_non_incidental: roundMoney(Math.max(0, thresholdTotalIfAllNonIncidental - VAT_REGISTRATION_THRESHOLD_EUR)),
            input_warnings: inputWarnings,
            manual_review_questions: manualReviewQuestions,
            suggested_action: suggestedAction,
            legal_basis: `${ESTONIAN_VAT_METADATA.registration.scope_summary} Scope effective ${ESTONIAN_VAT_METADATA.registration.scope_effective_from}; ${ESTONIAN_VAT_METADATA.registration.threshold.basis}. Official ${VAT_THRESHOLD_SOURCE.authority} source: ${VAT_THRESHOLD_SOURCE.url}`,
            note: "Advisory calculation, not a hard legal decision. e-arveldaja sale invoices do not reliably identify fixed-asset disposals, incidental financial/investment transactions, all exempt categories, or place-of-supply exceptions, so review the separate turnover buckets before deciding registration duty.",
          }),
        }],
      };
    }
  );

  registerTool(server, "check_tax_free_limits",
    `Compute cumulative TuMS § 49 tax-free limits (representation ${currentRepresentationMonthlyLimit()} €/month + 2% of payroll; donations 3% of payroll or 10% of prior-year profit) and the ${currentCitRate().formatted} income tax on any excess (rates date-gated). Pure calculator over caller-supplied year-to-date figures (payroll from the TSD declaration, prior-year profit from compute_profit_and_loss); it does not read the ledger.`,
    {
      as_of_date: isoDateSchema("Date the cumulative figures are taken as of (YYYY-MM-DD). Sets the 22/78 rate and the default months elapsed."),
      ytd_social_taxed_payroll: z.number().describe("Year-to-date payments subject to social tax (the 2%/3% base)."),
      months_elapsed: z.number().int().min(1).max(12).optional().describe("Calendar months elapsed for the representation 50 €/month accrual. Defaults to the month of as_of_date."),
      ytd_representation_costs: z.number().optional().describe("Year-to-date representation/entertainment costs booked. Omit to skip the representation limit."),
      ytd_donations: z.number().optional().describe("Year-to-date gifts/donations to listed associations. Omit to skip the donation limit."),
      prior_year_profit: z.number().optional().describe("Prior financial year's profit (for the donation 10% alternative). Defaults to 0."),
      donation_basis: z.enum(["payroll", "profit", "max"]).optional().describe("Which donation limit to apply: 3% payroll, 10% prior-year profit, or the more favourable (default max)."),
    },
    { ...readOnly, title: "Check Tax-Free Limits" },
    async ({ as_of_date, ytd_social_taxed_payroll, months_elapsed, ytd_representation_costs, ytd_donations, prior_year_profit, donation_basis }) => {
      const citRate = getCitRateForDate(as_of_date);
      const incomeTaxOnExcess = (excess: number) => roundMoney(excess * citRate.num / citRate.den);
      const months = months_elapsed ?? Number(as_of_date.slice(5, 7));

      const result: Record<string, unknown> = {
        as_of_date,
        cit_rate: citRate.formatted,
      };

      if (ytd_representation_costs !== undefined) {
        const rep = computeRepresentationCostLimit({
          ytdSocialTaxedPayroll: ytd_social_taxed_payroll,
          monthsElapsed: months,
          ytdRepresentationCosts: ytd_representation_costs,
          asOfDate: as_of_date,
        });
        result.representation = { ...rep, income_tax_on_excess: incomeTaxOnExcess(rep.excess) };
      }

      if (ytd_donations !== undefined) {
        const don = computeDonationLimit({
          ytdSocialTaxedPayroll: ytd_social_taxed_payroll,
          priorYearProfit: prior_year_profit ?? 0,
          ytdDonations: ytd_donations,
          basisChoice: donation_basis,
        });
        result.donations = { ...don, income_tax_on_excess: incomeTaxOnExcess(don.excess) };
      }

      result.note = `Cumulative (year-to-date) view. Excess is taxed at the CIT rate ${citRate.formatted} and declared on the TSD. Confirm the payroll/profit figures with the company's actual declarations.`;

      return {
        content: [{
          type: "text",
          text: toMcpJson(result),
        }],
      };
    }
  );
}
