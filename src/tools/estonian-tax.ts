import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { type ApiContext, isCompanyVatRegistered, coerceId } from "./crud-tools.js";
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
import { withOpeningBalanceStatus } from "../opening-balance-limitations.js";
import { loadOpeningBalanceJournal } from "../opening-balance-journal.js";
import { BookingGuard, formatDocNumber, type DocKey } from "../booking-guard.js";
import { INCOME_TAX_EXPENSE_ACCOUNT, DEFAULT_VAT_ACCOUNT, DEFAULT_OWNER_PAYABLE_ACCOUNT } from "../accounting-defaults.js";
import {
  resolveRestrictedReserveAccounts,
  resolveRetainedEarningsAccount,
  resolveDividendPayableAccount,
  resolveDividendCitPayableAccount,
  resolveShareCapitalAccount,
  resolveCurrentYearProfitAccount,
  resolveCalculatedResultAccount,
} from "../account-resolution.js";
import { isYearEndClosingJournal, isYearEndResultEntry } from "../year-end-closing-journal.js";
import type { Account, ApiResponse, Journal, Posting, SaleInvoice } from "../types/api.js";
import {
  getCurrentYearProfitAccountRule,
  getDefaultOwnerExpenseVatDeductionMode,
  getDefaultOwnerExpenseVatDeductionRatio,
  getOwnerExpenseVatDeductionModeForAccount,
  getOwnerExpenseVatDeductionRatioForAccount,
} from "../accounting-rules.js";
import { buildOwnerExpenseVatReviewGuidance } from "../estonian-accounting-guidance.js";

function requiresOwnerExpenseVatReview(accountName: string | undefined, description: string): boolean {
  const { isPassengerCar, isEntertainmentOrHospitality } = classifyExpenseForVat(`${accountName ?? ""} ${description}`);
  return isPassengerCar || isEntertainmentOrHospitality;
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VAT_THRESHOLD_SOURCE = vatSourceById("registration-threshold");

// Strict YYYY-MM-DD + calendar validity (rejects 2025-02-31, 01.01.2025, etc.).
// Round-trips through Date to catch month/day overflow that regex alone allows.
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_REGEX.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

const isoDateSchema = (description: string) =>
  z.string().refine(isValidIsoDate, { message: "Expected valid YYYY-MM-DD date" }).describe(description);

/**
 * Round DOWN to whole cents. Used for the reported maximum distributable
 * dividend so that booking exactly the reported maximum always passes the
 * legality checks it was derived from (round-half-up could overshoot by a cent).
 */
function floorMoney(x: number): number {
  return Math.floor(x * 100 + 1e-9) / 100;
}

/**
 * Σ(credit − debit) over the live postings of `journals` on accounts matching
 * `include`, for journals `keepJournal` accepts (deleted journals and postings
 * are always skipped). Uses the EUR base_amount when present. Unrounded — the
 * caller rounds once.
 */
function sumCreditMinusDebit(
  journals: readonly Journal[],
  include: (accountId: number) => boolean,
  keepJournal: (journal: Journal) => boolean,
): number {
  let sum = 0;
  for (const journal of journals) {
    if (journal.is_deleted || !keepJournal(journal)) continue;
    for (const posting of journal.postings ?? []) {
      if (posting.is_deleted || !include(posting.accounts_id)) continue;
      const amount = posting.base_amount ?? posting.amount;
      if (posting.type === "C") sum += amount;
      else if (posting.type === "D") sum -= amount;
    }
  }
  return sum;
}

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
  vat_account?: number;
  payable_account?: number;
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
    vat_account,
    payable_account,
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
    return { ok: false, error: toolError({ error: `vat_rate must not be negative (got ${vat_rate}). Use 0 for no/non-deductible VAT.` }) };
  }
  if (vat_amount !== undefined && vat_amount < 0) {
    return { ok: false, error: toolError({ error: `vat_amount must not be negative (got ${vat_amount}).` }) };
  }
  if (deductible_vat_amount !== undefined && deductible_vat_amount < 0) {
    return { ok: false, error: toolError({ error: `deductible_vat_amount must not be negative (got ${deductible_vat_amount}).` }) };
  }
  const vatRegistered = await isCompanyVatRegistered(api);
  const vatAcc = vat_account ?? DEFAULT_VAT_ACCOUNT;
  const payAcc = payable_account ?? DEFAULT_OWNER_PAYABLE_ACCOUNT;
  // Round the gross VAT whether it came from vat_rate or was supplied
  // directly: an unrounded caller vat_amount would otherwise be posted
  // verbatim while the balance guard below rounds only the sum, letting a
  // sub-cent-unbalanced journal reach the API.
  const grossVat = roundMoney(vat_amount ?? net_amount * vat_rate);
  const accounts = await api.readonly.getAccounts();
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
    { side: "D", account_id: expense_account, dimension_id: null, amount: expenseDebit, purpose: "expense" },
  ];
  if (deductibleVatPosted) {
    postings.push({ side: "D", account_id: vatAcc, dimension_id: null, amount: deductibleVat, purpose: "deductible_vat" });
  }
  postings.push({ side: "C", account_id: payAcc, dimension_id: null, amount: total, purpose: "owner_payable" });

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
): Promise<number | undefined> {
  if (p.document_number === null) return undefined;
  api.journals.invalidateListCache();
  const candidates = (await api.journals.listAll()).filter(j =>
    j.id != null && j.is_deleted !== true &&
    j.document_number === p.document_number &&
    j.clients_id === p.owner_client_id &&
    j.effective_date === p.journal_date);
  for (const candidate of candidates) {
    const postings = candidate.postings?.length ? candidate.postings : (await api.journals.get(candidate.id!))?.postings ?? [];
    const credited = roundMoney(postings
      .filter(posting => !posting.is_deleted && posting.type === "C")
      .reduce((sum, posting) => sum + (posting.base_amount ?? posting.amount), 0));
    if (credited === p.total) return candidate.id!;
  }
  return undefined;
}

export async function bookOwnerExpenseFromProjection(
  api: ApiContext,
  projection: OwnerExpenseJournalProjection,
  options?: OwnerExpenseReimbursementOptions,
): Promise<CallToolResult> {
  const p = projection;
  const apiPostings = p.postings.map(posting => ({ accounts_id: posting.account_id, type: posting.side, amount: posting.amount }));
  const existingId = await findExistingOwnerExpenseJournal(api, p);
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
          ? `Expense booked. Owner debt increased by ${p.total} EUR on account ${p.payable_account}.`
          : `Expense booked. Company is not VAT-registered, so the full gross amount was debited to expense account ${p.expense_account}. Owner debt increased by ${p.total} EUR on account ${p.payable_account}.`,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      }),
    }],
  };
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

export function registerEstonianTaxTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "prepare_dividend_package",
    `Calculate dividend CIT (${currentCitRate().formatted} from ${CIT_RATE_TIMELINE[CIT_RATE_TIMELINE.length - 1].from}; earlier dates date-gated) and create draft journal entries. ` +
    "Only the NET dividend debits retained earnings (Jaotamata kasum); the CIT books as a current-period income-tax expense (P&L 'Tulumaks' line), never a direct reduction of retained earnings — so the ENTIRE lg 1 distributable profit (retained earnings + closed prior-year result + unclosed prior-year P&L; not the current year) is distributable as net dividend (ÄS § 157 lg 1). " +
    "Hard-blocks a net dividend exceeding it, or a distribution whose gross effect (net + CIT) would push net assets below share capital + restricted reserves (ÄS § 157 lg 2), unless force=true (never on an imbalanced ledger); pending unconfirmed dividend drafts count. Reports max_net_dividend. " +
    "One journal per shareholder+date: identical retry → duplicate, different amount → dividend_key_conflict. " +
    "Requires an approved annual report and a profit-distribution decision — attach the decision to the journal with attach_document. " +
    "Previews by default (dry_run=true): show the preview and get explicit user approval, then call again with dry_run=false to create the draft journal.",
    {
      net_dividend: z.number().finite().describe("Net dividend amount to shareholder (EUR)"),
      shareholder_client_id: coerceId.describe("Shareholder client ID"),
      effective_date: isoDateSchema("Distribution date (YYYY-MM-DD)"),
      retained_earnings_account: z.number().optional().describe("Retained earnings account debited with the NET dividend (default: auto-detect 'jaotamata kasum', standard 2960)"),
      dividend_payable_account: z.number().optional().describe("Dividend payable account (default: auto-detect 'Dividendivõlad', standard 2650)"),
      tax_payable_account: z.number().optional().describe("Dividend income-tax payable (liability) account (default: auto-detect 'Dividenditulumaksu võlg', standard 2656)"),
      income_tax_expense_account: z.number().optional().describe("Income-tax expense account debited with the CIT — the P&L 'Tulumaks' line (default: lowest Kulud account in 8900–8999, else 8900)"),
      share_capital_account: z.number().optional().describe("Share capital account for ÄS §157 net-assets check (default: auto-detect 'Osakapital', standard 2900)"),
      restricted_reserve_accounts: z.array(z.number().int()).optional().describe("Accounts whose balances ÄS §157(2) makes non-distributable (net assets must stay above share capital + these reserves). Default: auto-detect every 'Kohustuslik reservkapital' account (active or inactive) AND always the standard reserve number 2940, so a funded-but-renamed 2940 is never missed; only booked balances raise the floor, so unfunded accounts add nothing. If your chart has REPURPOSED 2940 to a distributable reserve, pass this list explicitly (e.g. [] for no floor, or your real reserve account) to override the 2940 default. Explicit accounts need only exist (inactive OK)."),
      force: z.boolean().optional().describe("Book even if the ÄS § 157 lg 1 or lg 2 check fails (only alongside e.g. a capital reduction). Never overrides a ledger-imbalance block. Default false."),
      dry_run: z.boolean().optional().describe("Preview calculation, legality checks, and postings without creating a journal (default true). Set false only after the user explicitly approves the previewed journal."),
    },
    { ...create, title: "Prepare Dividend Distribution" },
    async ({ net_dividend: rawNetDividend, shareholder_client_id, effective_date, retained_earnings_account, dividend_payable_account, tax_payable_account, income_tax_expense_account, share_capital_account, restricted_reserve_accounts, force, dry_run = true }) => {
      // Reject non-positive dividends up front — a zero or negative net
      // would otherwise compute gross=0 and book an empty journal with
      // zero-amount postings, which is noise on the ledger and passes
      // both legality checks vacuously.
      if (!(rawNetDividend > 0)) {
        return toolError({
          error: "net_dividend must be > 0",
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
      const accountErrors = validateAccounts(accounts, [
        { id: retainedAccount, label: "Retained earnings account" },
        { id: payableAccount, label: "Dividend payable account" },
        { id: taxAccount, label: "Tax payable account" },
        { id: incomeTaxExpenseAccount, label: "Income-tax expense account" },
        { id: shareCapitalAccount, label: "Share capital account" },
      ]);
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
          hint: "Use list_accounts to find correct account numbers.",
        });
      }

      // Estonian CIT rate on dividends: date-keyed per TuMS § 50
      // (20/80 pre-2025, 22/78 from 2025-01-01).
      const citRate = getCitRateForDate(effective_date);
      const taxRate = citRate.num / citRate.den;
      const cit = roundMoney(net_dividend * taxRate);
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
        title: `Dividendi väljamakse - ${shareholderName} (neto ${net_dividend} EUR, TuMa ${citRate.formatted} ${cit} EUR)`,
        effective_date,
        clients_id: shareholder_client_id,
        cl_currencies_id: "EUR",
        postings,
      };
      const calculation = { net_dividend, cit_rate: citRate.formatted, cit_amount: cit, gross_dividend: grossDividend };
      const bookingSummary = {
        retained_earnings_account: retainedAccount,
        retained_earnings_debit: net_dividend,
        income_tax_expense_account: incomeTaxExpenseAccount,
        income_tax_expense_debit: cit,
        note: "Only the net dividend drains retained earnings; the CIT is booked as income-tax expense (P&L 'Tulumaks').",
      };
      const shareholderEcho = { id: shareholder_client_id, name: wrapUntrustedOcr(shareholderName) };

      // Statutory prerequisites the ledger cannot prove — surfaced on every
      // path (blocked, dry-run, executed, duplicate) so the operator confirms them.
      const complianceNotes = [
        "ÄS § 157 lg 1: väljamakse eeldab KINNITATUD majandusaasta aruannet ja kasumi jaotamise otsust. Kontrolli, et mõlemad on olemas, ja lisa osanike otsus kandele (attach_document, entity_type='journal').",
        `TuMS § 50: dividendi tulumaks (${citRate.formatted}) deklareeritakse TSD lisal 7 ja tasutakse väljamakse kuule järgneva kuu 10. kuupäevaks.`,
      ];

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
        hint:
          `One dividend journal per shareholder per date. If the existing journal ${journalId} is wrong, ` +
          "delete (or invalidate and delete) it first and re-run; for an additional distribution to the same " +
          "shareholder, use a different effective_date.",
      });

      // Preload journals once for the duplicate pre-check and both legality
      // checks. Prepend the synthetic opening-balance journal (clients_id: null)
      // exactly once here — both checks compute account-level equity with no
      // client filter, so the opening balance correctly feeds the lg1 ceiling
      // and the lg2 net-assets floor.
      const opening = await loadOpeningBalanceJournal(api);
      const allJournals = [...(opening ? [opening.journal] : []), ...(await api.journals.listAllWithPostings())];

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

      // ÄS § 157 lg 1 distributable profit, as of the distribution date:
      //  - retained earnings (Eelmiste perioodide jaotamata kasum, 2960);
      //  - the closed prior-year result on "Aruandeaasta kasum" (2970), which
      //    RIK's year-end result entry (D 9000 / K 2970, Dec 31) credits and
      //    which is transferred to 2960 only later (Jan 1 entry) — ignoring it
      //    understates the ceiling;
      //  - prior-year P&L not yet closed: Σ Tulud/Kulud before Jan 1 of the
      //    distribution year, INCLUDING the calculated-result account 9000:
      //    its debit from the result entry cancels the still-open revenue/
      //    expense balances (RIK does not zero them), so a closed year counts
      //    once (via 2970/2960) and only the unclosed residual counts here.
      //    Legacy YECL journals are included too (they zero P&L into 2970).
      // The distribution year's own result is NOT distributable (no approved
      // annual report yet), so its closing entry (RIK result entry or legacy
      // YECL, dated Dec 31 of that year) is excluded from the 2960/2970
      // balances and its P&L is outside the window.
      const distributionYear = Number(effective_date.slice(0, 4));
      const distributionYearStart = `${distributionYear}-01-01`;
      const currentYearProfitAccount = resolveCurrentYearProfitAccount(accounts, getCurrentYearProfitAccountRule());
      const calculatedResultAccount = resolveCalculatedResultAccount(accounts);
      const registeredAsOf = (j: Journal) =>
        j.registered === true && j.effective_date <= effective_date && !isYearEndClosingJournal(j, distributionYear) &&
        !isYearEndResultEntry(j, distributionYear, { calculatedResult: calculatedResultAccount, currentYearProfit: currentYearProfitAccount });
      const retainedBalance = roundMoney(sumCreditMinusDebit(allJournals, id => id === retainedAccount, registeredAsOf));
      const closedPriorYearResult = currentYearProfitAccount === retainedAccount
        ? 0
        : roundMoney(sumCreditMinusDebit(allJournals, id => id === currentYearProfitAccount, registeredAsOf));
      const plAccountIds = new Set(accounts
        .filter(a => a.account_type_est === "Tulud" || a.account_type_est === "Kulud")
        .map(a => a.id));
      plAccountIds.add(calculatedResultAccount);
      const unclosedPriorYearPL = roundMoney(sumCreditMinusDebit(
        allJournals,
        id => plAccountIds.has(id),
        j => j.registered === true && j.effective_date < distributionYearStart,
      ));
      const lg1Accounts = new Set([retainedAccount, currentYearProfitAccount]);

      // Unconfirmed (PROJECT) dividend drafts: this tool creates its journals
      // unconfirmed, and every balance read skips unregistered journals — so a
      // pending draft would otherwise be invisible and a second shareholder's
      // dividend could pass against the same retained earnings. Identify drafts
      // by this tool's DIV- document number OR a credit to the dividend-payable
      // account (manual drafts). Their reduction is measured from their actual
      // postings, so an over-included non-dividend draft only counts what it
      // really does to the lg1 pool / net assets. The same-key journal of this
      // call is never counted (it was handled by the duplicate pre-check).
      const equityOrPlAccountIds = new Set(accounts
        .filter(a => a.account_type_est === "Omakapital" || a.account_type_est === "Tulud" || a.account_type_est === "Kulud")
        .map(a => a.id));
      const pendingDividendDrafts = allJournals
        .filter(j =>
          j.id != null && !j.is_deleted && j.registered !== true && j.document_number !== documentNumber &&
          ((j.document_number ?? "").startsWith("DIV-") ||
            (j.postings ?? []).some(p => !p.is_deleted && p.accounts_id === payableAccount && p.type === "C")))
        .map(j => ({
          journal_id: j.id!,
          document_number: j.document_number ?? null,
          effective_date: j.effective_date,
          retained_earnings_reduction: roundMoney(-sumCreditMinusDebit([j], id => lg1Accounts.has(id), () => true)),
          net_assets_reduction: roundMoney(-sumCreditMinusDebit([j], id => equityOrPlAccountIds.has(id), () => true)),
        }))
        .filter(d => d.retained_earnings_reduction !== 0 || d.net_assets_reduction !== 0);
      const pendingRetainedReduction = roundMoney(pendingDividendDrafts.reduce((s, d) => s + d.retained_earnings_reduction, 0));
      const pendingNetAssetsReduction = roundMoney(pendingDividendDrafts.reduce((s, d) => s + d.net_assets_reduction, 0));
      const distributableProfit = roundMoney(retainedBalance + closedPriorYearResult + unclosedPriorYearPL - pendingRetainedReduction);
      const lg1Components = {
        retained_earnings_account: retainedAccount,
        retained_earnings_balance: retainedBalance,
        current_year_profit_account: currentYearProfitAccount,
        closed_prior_year_result: closedPriorYearResult,
        unclosed_prior_year_profit_and_loss: unclosedPriorYearPL,
        pending_unconfirmed_dividends: pendingRetainedReduction,
        note:
          `lg 1 distributable = retained earnings + closed prior-year result (${currentYearProfitAccount}) + ` +
          `unclosed P&L before ${distributionYearStart} − pending unconfirmed dividend drafts. ` +
          `${distributionYear} P&L is excluded (no approved annual report yet).`,
      };
      const warnings: string[] = [];
      if (pendingDividendDrafts.length > 0) {
        warnings.push(
          `Pending unconfirmed dividend drafts counted: ${pendingDividendDrafts
            .map(d => `journal ${d.journal_id}${d.document_number ? ` (${d.document_number})` : ""} ` +
              `−${d.retained_earnings_reduction} EUR distributable / −${d.net_assets_reduction} EUR net assets`)
            .join(", ")}. Confirm or delete them; they already reserve part of the § 157 headroom.`
        );
      }

      // Guard the manual override: auto-detection only ever picks a Kulud
      // account, but an explicit income_tax_expense_account is existence-checked,
      // not type-checked. A mistyped override (e.g. an equity or liability
      // account) would silently book the CIT to the wrong statement line, so
      // warn — non-blocking — when the resolved account is not an expense.
      const incomeTaxExpenseRecord = accounts.find(a => a.id === incomeTaxExpenseAccount);
      if (incomeTaxExpenseRecord && incomeTaxExpenseRecord.account_type_est !== "Kulud") {
        warnings.push(
          `Income-tax expense account ${incomeTaxExpenseAccount} (${incomeTaxExpenseRecord.name_est}) is not an expense (Kulud) account. ` +
          `The dividend CIT belongs on the P&L 'Tulumaks' expense line (Kulud, usually 8900–8999). Verify income_tax_expense_account.`
        );
      }

      const balances = await computeAllBalances(api, undefined, effective_date, {
        preloadedAccounts: accounts,
        preloadedJournals: allJournals,
      });
      // Net assets = equity + current-year P&L. Revenue/expense accounts
      // (Tulud/Kulud) are not closed into Omakapital until year-end, so the
      // equity total alone understates net assets mid-year. Fold current-year
      // P&L in explicitly — shares `sumCategory` with `compute_balance_sheet`
      // so both tools agree bit-identically on the same ledger.
      const byCategory = (cat: string): AccountBalance[] =>
        balances.filter(b => b.account_type_est === cat);
      const totalAssets = sumCategory(byCategory("Varad"), "D");
      const totalLiabilities = sumCategory(byCategory("Kohustused"), "C");
      const totalEquity = sumCategory(byCategory("Omakapital"), "C");
      const totalRevenue = sumCategory(byCategory("Tulud"), "C");
      const totalExpenses = sumCategory(byCategory("Kulud"), "D");
      const currentYearPL = roundMoney(totalRevenue - totalExpenses);
      const shareCapital = balances.find(balance => balance.account_id === shareCapitalAccount)?.balance ?? 0;
      const netAssetsBeforeDistribution = roundMoney(totalEquity + currentYearPL);
      // Pending unconfirmed dividend drafts will reduce net assets once
      // confirmed — the lg 2 floor is tested against what remains after them.
      const netAssetsAvailable = roundMoney(netAssetsBeforeDistribution - pendingNetAssetsReduction);
      const netAssetsAfterDistribution = roundMoney(netAssetsAvailable - grossDividend);
      const roundedShareCapital = roundMoney(shareCapital);

      // ÄS § 157(2): statutory/articles-mandated reserves (reservkapital) are not
      // distributable — the net-assets floor is share capital PLUS these reserves,
      // not share capital alone. restrictedReserveAccounts was resolved/validated
      // above (default: name-detect "Kohustuslik reservkapital", standard 2940,
      // and included only when it carries a non-zero balance; override via
      // restricted_reserve_accounts).
      const restrictedReserveDetails = restrictedReserveAccounts
        .map(id => ({ account: id, balance: roundMoney(balances.find(b => b.account_id === id)?.balance ?? 0) }))
        .filter(r => r.balance !== 0);
      const restrictedReserveTotal = roundMoney(restrictedReserveDetails.reduce((sum, r) => sum + r.balance, 0));
      // The § 157 net-assets floor: share capital + non-distributable reserves.
      // Clamp each component to ≥ 0 — PER reserve account, not just the summed
      // total — so a data anomaly (a debit balance on the share-capital or a
      // reserve account, which should never happen on a clean ledger) can only
      // make the floor, and therefore the distribution block, more conservative,
      // never silently lower it. Clamping only the total would let a negative
      // reserve balance offset a positive one and pull the floor down; summing
      // max(0, balance) per account prevents that. The reported restricted_reserves
      // echo keeps the raw signed total so the anomaly stays visible.
      const restrictedReserveFloor = roundMoney(restrictedReserveDetails.reduce((sum, r) => sum + Math.max(0, r.balance), 0));
      const legalCapitalFloor = roundMoney(Math.max(0, roundedShareCapital) + restrictedReserveFloor);

      // Cross-check: on a balanced ledger, Assets − Liabilities must equal
      // Equity + P&L. A mismatch indicates unbalanced or partially-deleted
      // journals, which means the retained-earnings and §157 net-assets checks
      // below are computed from an untrustworthy ledger. Hard-block — force=true
      // does NOT override this: force exists for a lawful distribution the
      // ledger cannot prove (e.g. alongside a capital reduction), not for
      // producing legal-distribution output from a broken balance sheet.
      // Tolerance 0.05 accounts for rounding drift across the 5 sub-totals
      // (each rounded independently at up to 0.005 EUR).
      const assetsMinusLiabilities = roundMoney(totalAssets - totalLiabilities);
      const ledgerImbalance = Math.abs(assetsMinusLiabilities - netAssetsBeforeDistribution) > 0.05;
      if (ledgerImbalance) {
        warnings.push(
          `Ledger imbalance: Assets − Liabilities (${assetsMinusLiabilities} EUR) ` +
          `does not equal Equity + current-year P&L (${netAssetsBeforeDistribution} EUR). ` +
          `Retained-earnings and §157 net-assets checks are unreliable on this ledger. ` +
          `Investigate unregistered/deleted journals before distributing.`
        );
      }

      // ÄS § 157 lg 1 ceiling is NET-based: the statutory limit applies to the
      // distribution decided by the shareholders (the net dividend). The CIT is
      // the company's own current-period income-tax expense (TuMS § 50, booked
      // to the P&L "Tulumaks" line below), not part of the payout — so the
      // ENTIRE distributable profit is distributable as net dividend.
      // The § 157 lg 2 net-assets floor below stays GROSS-based, because the
      // payout does create both a dividend payable and a tax liability.
      const retainedShortfall = distributableProfit < net_dividend;
      const netAssetsBreach = netAssetsAfterDistribution < legalCapitalFloor - 0.01;
      // Report the same verdict the block uses (same 0.01 tolerance), so the
      // echoed net_assets_check.sufficient never says "false" on a distribution
      // the tool actually books, or vice versa.
      const netAssetsSufficient = !netAssetsBreach;

      // Maximum lawful NET dividend under both § 157 clauses, floored to whole
      // cents so booking exactly this amount always passes both checks:
      //  - lg 1: net ≤ distributable profit (after pending drafts);
      //  - lg 2: netAssetsAvailable − net×(1+rate) ≥ floor  ⇔  net ≤ (netAssetsAvailable − floor)/(1+rate).
      const maxNetByRetained = Math.max(0, distributableProfit);
      const maxNetByNetAssets = Math.max(0, (netAssetsAvailable - legalCapitalFloor) / (1 + taxRate));
      const maxNetDividend = floorMoney(Math.min(maxNetByRetained, maxNetByNetAssets));
      const maximumDistributable = {
        max_net_dividend: maxNetDividend,
        limited_by: maxNetByRetained <= maxNetByNetAssets ? "retained_earnings" : "net_assets",
        max_net_by_retained_earnings: floorMoney(maxNetByRetained),
        max_net_by_net_assets: floorMoney(maxNetByNetAssets),
        ...(pendingDividendDrafts.length > 0 && { pending_unconfirmed_dividend_drafts: pendingDividendDrafts }),
        note:
          "Largest lawful NET dividend on this ledger: min(distributable profit [ÄS § 157 lg 1: retained earnings + closed prior-year result + unclosed prior-year P&L], " +
          `(net assets − §157 lg 2 floor) × ${citRate.den}/${citRate.den + citRate.num} [tax comes on top of the payout]), ` +
          "both after pending unconfirmed dividend drafts.",
      };
      const retainedEarningsCheck = {
        account: retainedAccount,
        balance_before: distributableProfit,
        components: lg1Components,
        net_dividend_required: net_dividend,
        sufficient: !retainedShortfall,
      };
      const netAssetsCheck = {
        net_assets_before_distribution: netAssetsBeforeDistribution,
        ...(pendingNetAssetsReduction !== 0 && { pending_unconfirmed_dividends: pendingNetAssetsReduction }),
        gross_dividend: grossDividend,
        net_assets_after_distribution: netAssetsAfterDistribution,
        share_capital_account: shareCapitalAccount,
        share_capital: roundedShareCapital,
        restricted_reserves: restrictedReserveTotal,
        restricted_reserve_accounts: restrictedReserveDetails,
        minimum_net_assets: legalCapitalFloor,
        sufficient: netAssetsSufficient,
      };

      // Opening-balance status: share capital and retained earnings are commonly
      // entered as "Algbilansi kanded" (opening-balance entries). When a stored
      // algbilanss is captured, it was folded into allJournals above and this
      // reports what was applied; otherwise it's the actionable "paste it"
      // warning, since the § 157 / retained-earnings checks would otherwise run
      // on incomplete data.
      warnings.push(...withOpeningBalanceStatus([], {
        captured: opening !== null,
        openingDate: opening?.openingDate,
        unmappedCodes: opening?.unmappedCodes,
      }));

      // Transparency: when reservkapital was auto-detected (no explicit override)
      // and carries a balance, tell the operator the floor was raised above bare
      // share capital — they may not realise reserves are being ring-fenced. A
      // mandatory reserve is not universal (it applies only when the company's
      // articles / põhikiri require it), and the account exists in every standard
      // e-arveldaja chart, so the floor is keyed on the BOOKED BALANCE, not the
      // account's mere presence — an unfunded reserve (0 balance) adds no floor.
      if (restricted_reserve_accounts === undefined && restrictedReserveFloor > 0) {
        warnings.push(
          `ÄS § 157(2) restricted-reserve floor applied: reservkapital ` +
          `${restrictedReserveDetails.map(r => `${r.account} (${r.balance} EUR)`).join(", ")} ` +
          `raises the minimum net-assets floor to ${legalCapitalFloor} EUR ` +
          `(share capital ${Math.max(0, roundedShareCapital)} + reserves ${restrictedReserveFloor}). ` +
          `This assumes the company's articles (põhikiri) mandate this statutory reserve; ` +
          `if they do not, pass restricted_reserve_accounts=[] to exclude it from the floor.`
        );
      }
      const violations: string[] = [];
      if (ledgerImbalance) violations.push("Ledger is imbalanced — legality checks cannot be trusted");
      if (retainedShortfall) violations.push("Insufficient retained earnings");
      if (netAssetsBreach) violations.push("ÄS § 157 net assets breach");

      // force overrides the two § 157 clauses only — never a ledger imbalance.
      if (ledgerImbalance || (violations.length > 0 && !force)) {
        // Report every triggered legality violation in one response so the
        // operator sees the full picture. ÄS § 157 is explicitly the
        // framework for retained-earnings distribution legality, so a
        // retained shortfall is already a § 157 signal; the net-assets
        // check covers the separate share-capital clause.
        return toolError({
          error: violations.join("; "),
          ...(retainedShortfall && {
            retained_earnings_check: {
              balance: distributableProfit,
              components: lg1Components,
              net_dividend_required: net_dividend,
              shortfall: roundMoney(net_dividend - distributableProfit),
              note: "ÄS § 157 lg 1 limit is NET-based: the CIT is a current-period expense, not part of the distribution.",
            },
          }),
          ...(netAssetsBreach && {
            net_assets_check: {
              net_assets_before_distribution: netAssetsBeforeDistribution,
              ...(pendingNetAssetsReduction !== 0 && { pending_unconfirmed_dividends: pendingNetAssetsReduction }),
              gross_dividend: grossDividend,
              net_assets_after_distribution: netAssetsAfterDistribution,
              share_capital: roundedShareCapital,
              share_capital_account: shareCapitalAccount,
              restricted_reserves: restrictedReserveTotal,
              restricted_reserve_accounts: restrictedReserveDetails,
              minimum_net_assets: legalCapitalFloor,
              shortfall: roundMoney(legalCapitalFloor - netAssetsAfterDistribution),
            },
          }),
          maximum_distributable: maximumDistributable,
          calculation,
          // Surface non-blocking warnings (esp. the opening-balance caveat) on the
          // blocked path too: a "0 retained earnings" block is often exactly the
          // symptom of opening balances the /journals API omits, so the operator
          // must see that the check may have run on incomplete data.
          ...(warnings.length > 0 && { warnings }),
          compliance_notes: complianceNotes,
          hint:
            ledgerImbalance
              ? "The ledger is imbalanced (Assets − Liabilities ≠ Equity + P&L); force=true does not override this. Find and fix the unbalanced or partially-deleted journals, then re-run."
              : retainedShortfall && netAssetsBreach
                ? `Both retained-earnings and § 157 net-assets clauses fail (max lawful net dividend: ${maxNetDividend} EUR). Reduce the dividend, register a capital reduction first, or set force=true to override (unlawful absent additional action).`
                : retainedShortfall
                  ? `Net dividend exceeds distributable profit (ÄS § 157 lg 1). Max lawful net dividend on this ledger: ${maxNetDividend} EUR. Set force=true to create the journal anyway.`
                  : `Distribution would push net assets below the ÄS § 157 lg 2 floor (share capital + restricted reserves; the check is gross-based because the CIT liability also reduces net assets). Max lawful net dividend on this ledger: ${maxNetDividend} EUR. Reduce the dividend, register a capital reduction first, or set force=true to override (unlawful absent additional action).`,
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
          `(share capital ${Math.max(0, roundedShareCapital)} EUR on account ${shareCapitalAccount}` +
          `${restrictedReserveFloor > 0 ? ` + restricted reserves ${restrictedReserveFloor} EUR` : ""}). ` +
          `Journal created because force=true. Verify ÄS § 157 compliance through a separate legal action (e.g. capital reduction).`
        );
      }

      if (dry_run) {
        return {
          content: [{
            type: "text",
            text: toMcpJson({
              dry_run: true,
              calculation,
              booking: bookingSummary,
              proposed_journal: { ...journalData, title: wrapUntrustedOcr(journalData.title), document_number: documentNumber },
              shareholder: shareholderEcho,
              // Mirror the executed path so the preview doesn't hide legality
              // context: an operator running dry_run with force=true must see
              // the same § 157 / retained-earnings signals they would on execute.
              retained_earnings_check: retainedEarningsCheck,
              maximum_distributable: maximumDistributable,
              net_assets_check: netAssetsCheck,
              ...(warnings.length > 0 && { warnings }),
              compliance_notes: complianceNotes,
              note: "No journal created. Set dry_run=false to execute.",
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
    }
  );

  registerTool(server, "create_owner_expense_reimbursement",
    "Create a journal for a business expense paid personally by the owner.",
    {
      owner_client_id: coerceId.describe("Owner/shareholder client ID"),
      effective_date: isoDateSchema("Expense date (YYYY-MM-DD)"),
      description: z.string().describe("Expense description"),
      net_amount: z.number().finite().describe("Net amount (without VAT)"),
      vat_rate: z.number().finite().describe("VAT rate as decimal (e.g. 0.24 for 24%; 0 = no VAT/non-deductible). Must be a fraction, NOT a percentage — use 0.24, not 24."),
      vat_amount: z.number().finite().optional().describe("Exact VAT amount (overrides vat_rate if provided)"),
      vat_deduction_mode: z.enum(["none", "full", "partial"]).optional().describe("VAT deduction mode. Use partial with deductible_vat_amount."),
      deductible_vat_amount: z.number().finite().optional().describe("Deductible part of VAT when vat_deduction_mode=partial, or an explicit deductible VAT amount to override the default or configured ratio."),
      expense_account: z.number().describe("Expense account number (e.g. 5000, 6000)"),
      vat_account: z.number().optional().describe("Input VAT account (default 1510)"),
      payable_account: z.number().optional().describe("Payable to owner account (default 2110)"),
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
      const checkYear = year ?? new Date().getUTCFullYear();
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
