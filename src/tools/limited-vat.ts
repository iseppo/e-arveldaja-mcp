import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { destructive } from "../annotations.js";
import { toolError } from "../tool-error.js";
import { logAudit } from "../audit-log.js";
import { todayInTallinn } from "../local-date.js";
import { isStrictDate, parseStrictMonth } from "../strict-date.js";
import { roundMoney } from "../money.js";
import { findAccountByName } from "../account-resolution.js";
import { resolveBundleStorePath } from "../accounting-rules.js";
import { BookingGuard, RecoveredJournalRejectedError } from "../booking-guard.js";
import { standardVatRateOn, LIMITED_TAXPAYER_RULES, type TaxRuleReference } from "../estonian-tax-rules.js";
import { buildLimitedVatGuidance, type LimitedVatGuidance } from "../limited-vat-guidance.js";
import {
  COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE,
  COMPANY_VAT_STATUS_UNKNOWN,
  COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS,
  LIMITED_VAT_STORE_FILE,
  companyVatStatusUnknownMessage,
  sameVatNumber,
  bookingRecordKey,
  limitedVatStore,
  readLimitedVatRecords,
  resolveCompanyVatStatus,
  supplierRecordKey,
  type CompanyVatStatus,
  type CompanyVatLookupView,
  type CompanyVatStatusUnknownReason,
  type LimitedVatStoreRecord,
  type ResolvedCompanyVatStatus,
  type ResolvedVatStatus,
} from "../company-vat-status.js";
import {
  buildLimitedVatPostings,
  classifySupplier,
  computeLimitedVatMonth,
  fxKeysFor,
  isMonthCandidate,
  kmdFigures,
  limitedVatJournalProblem,
  monthBounds,
  paymentDeadline,
  postingSignature,
  resolveLimitedVatMonthState,
  storedSupplierClassifications,
  type LimitedVatExclusion,
  type LimitedVatIncludedInvoice,
  type LimitedVatInvoiceInput,
  type LimitedVatKmdFigures,
  type LimitedVatMonthState,
  type LimitedVatPosting,
  type LimitedVatReview,
  type SupplierClassification,
} from "../limited-vat.js";
import { readFrozenFxOutcomes, resolveFrozenFxOutcomes, type EcbRateDeps, type FrozenFxOutcomes } from "../fx/ecb-rates.js";
import { canonicalPlanJson } from "./camt-plan.js";
import type { ExecutionPlanInput, PlanData, PlanRecord } from "../plan-store.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { ApiContext } from "./crud-tools.js";
import type { Account, Client, PurchaseInvoice } from "../types/api.js";

export const LIMITED_VAT_STATUS_DOMAIN = "limited_vat_status";
export const LIMITED_VAT_MONTH_DOMAIN = "limited_vat_month";

/** Upper bound on purchase-invoice detail reads in one month run. */
const MAX_MONTH_CANDIDATES = 300;

/** "Käibemaksukohustis" / "Arvestatud käibemaks" / "Käibemaksuvõlg" — never guessed beyond these names. */
const VAT_LIABILITY_NAME_RE = /^(käibemaksukohustis|arvestatud käibemaks|käibemaksuv[õo]lg)$/iu;

function respond(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: toMcpJson(payload) }] };
}

function refuse(errorCode: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return toolError({ error: message, error_code: errorCode, note: "Nothing was written.", ...extra });
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface LimitedVatGuidePayload {
  mode: "guide";
  guidance: LimitedVatGuidance;
  tax_rules: readonly TaxRuleReference[];
}

export interface LimitedVatCandidateMonth {
  month: string;
  invoice_count: number;
  base_eur_estimate: number;
  vat_estimate: number;
  unvalued_invoice_count: number;
}

export interface LimitedVatStatusPayload {
  mode: "status";
  status: ResolvedVatStatus;
  source: ResolvedCompanyVatStatus["source"];
  /** The VAT number e-arveldaja shows now (`/vat_info`). */
  vat_number: string | null;
  /** The owner's stored decision, when one exists (also when it no longer applies). */
  decision_status: CompanyVatStatus | null;
  /** The VAT number that decision was made for (null = no number, or no decision). */
  decision_vat_number: string | null;
  effective_from: string | null;
  store_available: boolean;
  store_error?: string;
  /** Why the status is `unknown` (only then). */
  reason?: CompanyVatStatusUnknownReason;
  /** Source `emta_lookup`: EMTA's KMKR registration row and when it was looked up (`stale` = older than 7 days, re-check failed). */
  emta_lookup?: CompanyVatLookupView;
  /** Why the EMTA lookup failed (status `unknown`). */
  lookup_error?: string;
  explanation: string;
  /** Only for status `none`: foreign service candidates already in the books (read-only estimate). */
  registration_check?: {
    candidate_invoice_count: number;
    first_service_date: string | null;
    months: LimitedVatCandidateMonth[];
    note: string;
  };
}

export interface LimitedVatSetStatusPreviewPayload {
  mode: "set_status";
  status: "ready_for_approval";
  plan_handle: string;
  current: { status: ResolvedVatStatus; source: ResolvedCompanyVatStatus["source"]; effective_from: string | null; reason?: CompanyVatStatusUnknownReason };
  /** `vat_number` = the VAT number e-arveldaja shows now; the decision is bound to it. */
  proposed: { status: CompanyVatStatus; effective_from: string; vat_number: string | null };
  effect: string;
  next_step_summary: string;
}

export interface LimitedVatSetStatusSavedPayload {
  mode: "set_status";
  status: "saved";
  saved: { status: CompanyVatStatus; effective_from: string; vat_number: string | null };
  note: string;
}

export interface LimitedVatMonthInvoiceView extends Omit<LimitedVatIncludedInvoice, "supplier" | "number"> {
  supplier: string;
  number: string;
}

export interface LimitedVatMonthPayload {
  mode: "month";
  month: string;
  status: "ready_for_approval" | "already_booked" | "nothing_to_book" | "booked";
  state: LimitedVatMonthState["kind"];
  document_number?: string;
  journal_ids?: number[];
  plan_handle?: string;
  liability_account: number;
  included_invoices: LimitedVatMonthInvoiceView[];
  excluded_invoices: Array<Omit<LimitedVatExclusion, "supplier" | "number"> & { supplier: string; number: string }>;
  review_items: Array<Omit<LimitedVatReview, "supplier" | "number"> & { supplier: string; number: string }>;
  proposed_journal?: { document_number: string; title: string; effective_date: string; postings: LimitedVatPosting[] };
  supplier_classifications_to_save: Array<{ clients_id: number; classification: SupplierClassification }>;
  kmd: LimitedVatKmdFigures;
  payment_deadline: string;
  notes: string[];
  next_step_summary?: string;
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

function storeUnavailableMessage(): string {
  return `Single-file rules mode (EARVELDAJA_RULES_FILE) has no bundle store, so the company VAT status cannot be stored and status "limited" is unavailable. Use the bundle storage (EARVELDAJA_RULES_DIR) to store it in ${LIMITED_VAT_STORE_FILE}.`;
}

function readRecords(): LimitedVatStoreRecord[] | null {
  return readLimitedVatRecords(); // fresh: another process may have written since
}

function statusUnknownRefusal(resolved: ResolvedCompanyVatStatus): CallToolResult {
  return refuse(resolved.reason ?? COMPANY_VAT_STATUS_UNKNOWN, companyVatStatusUnknownMessage(resolved));
}

/** The stored status setting as canonical JSON ("null" when unset): the version a set_status plan binds. */
function statusRecordVersion(records: readonly LimitedVatStoreRecord[] | null): string {
  return canonicalPlanJson((records ?? []).find(record => record.kind === "status") as unknown as PlanRecord ?? null);
}

function wrapView<T extends { supplier: string; number: string }>(row: T): T {
  return { ...row, supplier: wrapUntrustedOcr(row.supplier) ?? "", number: wrapUntrustedOcr(row.number) ?? "" };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function buildStatus(api: ApiContext): Promise<LimitedVatStatusPayload> {
  const resolved = await resolveCompanyVatStatus(api);
  const base = {
    mode: "status" as const,
    status: resolved.status,
    source: resolved.source,
    vat_number: resolved.vat_number,
    decision_status: resolved.decision_status ?? null,
    decision_vat_number: resolved.decision_vat_number ?? null,
    effective_from: resolved.effective_from,
    store_available: resolved.store_available,
    ...(resolved.store_error ? { store_error: resolved.store_error } : {}),
    ...(resolved.reason ? { reason: resolved.reason } : {}),
    ...(resolved.lookup ? { emta_lookup: resolved.lookup } : {}),
    ...(resolved.lookup_error ? { lookup_error: resolved.lookup_error } : {}),
  };
  if (resolved.status === "unknown") {
    return {
      ...base,
      explanation: resolved.reason === COMPANY_VAT_STATUS_UNKNOWN || resolved.reason === undefined
        ? `The company VAT status cannot be read (${resolved.store_error}). Every VAT-dependent booking refuses (${COMPANY_VAT_STATUS_UNKNOWN}) until ${LIMITED_VAT_STORE_FILE} in the accounting-rules bundle is repaired or restored.`
        : `Every VAT-dependent booking refuses until EMTA answers or the owner confirms the status. ${companyVatStatusUnknownMessage(resolved)}`,
    };
  }
  const lookupNote = resolved.lookup
    ? ` EMTA's public KMKR query (${resolved.lookup.looked_up_at}) shows ${resolved.vat_number} registered on ${resolved.lookup.registration.registered_on}${resolved.lookup.registration.limited ? " as a limited taxpayer (Piiratud käibemaksukohustuslane)" : ""}.` +
      (resolved.lookup.stale ? ` That answer is more than 7 days old and the re-check failed (${resolved.lookup.refresh_error}); it is still used.` : "") +
      " If this is wrong, the owner can set the status with mode \"set_status\"."
    : "";
  if (resolved.status === "full") {
    return {
      ...base,
      explanation: resolved.source === "emta_lookup"
        ? `Fully VAT-registered.${lookupNote}`
        : `The owner confirmed the company as fully VAT-registered for VAT number ${resolved.decision_vat_number}.`,
    };
  }
  if (resolved.status === "limited") {
    return {
      ...base,
      explanation: `Limited taxpayer: no input-VAT deduction, no reverse-charge input leg on purchase invoices. Run mode "month" for each month with foreign services, after the purchase invoices are confirmed and before the 20th of the following month.${lookupNote}`,
    };
  }
  const [clients, invoices] = await Promise.all([api.clients.listAll(), api.purchaseInvoices.listAll()]);
  const byId = new Map(clients.map(client => [client.id, client]));
  const stored = storedSupplierClassifications(safeRecords());
  const months = new Map<string, LimitedVatCandidateMonth>();
  let first: string | null = null;
  let count = 0;
  for (const invoice of invoices) {
    if (invoice.status !== "CONFIRMED") continue;
    const client = byId.get(invoice.clients_id);
    const decision = classifySupplier(client, stored.get(invoice.clients_id));
    if (decision.decision !== "counts" && decision.decision !== "unclassified") continue;
    count += 1;
    const date = invoice.create_date;
    if (first === null || date < first) first = date;
    const month = date.slice(0, 7);
    const row = months.get(month) ?? { month, invoice_count: 0, base_eur_estimate: 0, vat_estimate: 0, unvalued_invoice_count: 0 };
    row.invoice_count += 1;
    const currency = (invoice.cl_currencies_id ?? "EUR").toUpperCase();
    const baseEur = currency === "EUR" ? invoice.net_price : invoice.base_net_price;
    const rate = standardVatRateOn(date);
    if (typeof baseEur === "number" && rate !== null) {
      row.base_eur_estimate = roundMoney(row.base_eur_estimate + baseEur);
      row.vat_estimate = roundMoney(row.vat_estimate + roundMoney(baseEur * rate / 100));
    } else {
      row.unvalued_invoice_count += 1;
    }
    months.set(month, row);
  }
  return {
    ...base,
    explanation: "The company is not VAT-registered. If it receives KMS § 10 lg 5 services (e.g. cloud/SaaS/API, consulting, advertising) from foreign businesses not registered in Estonia, it must register as a limited taxpayer from the day the first such service is received (KMS § 21 lg 1; no threshold for services). See mode \"guide\".",
    registration_check: {
      candidate_invoice_count: count,
      first_service_date: first,
      months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      note: count === 0
        ? "No confirmed foreign-supplier invoices that could be KMS § 10 lg 5 services were found."
        : `Registration may be required since ${first} (invoice date; a prepayment may make it earlier). Monthly sums are read-only estimates of the VAT a limited taxpayer would owe (invoice date, e-arveldaja's own EUR amounts, date-gated standard rate); nothing is booked. Financial-service and EX suppliers are left out; unclassified foreign suppliers are counted.`,
    },
  };
}

function safeRecords(): LimitedVatStoreRecord[] {
  try {
    return readRecords() ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// set_status
// ---------------------------------------------------------------------------

interface SetStatusArgs {
  status?: CompanyVatStatus;
  effective_from?: string;
  execute?: boolean;
  plan_handle?: string;
}

async function handleSetStatus(api: ApiContext, ctx: RuntimeSafetyContext, args: SetStatusArgs): Promise<CallToolResult> {
  if (!args.status) return refuse("limited_vat_status_required", "mode \"set_status\" needs status (none | limited | full).");
  if (resolveBundleStorePath(LIMITED_VAT_STORE_FILE) === null) return refuse("limited_vat_store_unavailable", storeUnavailableMessage());
  const effectiveFrom = args.effective_from ?? (args.status === "limited" ? undefined : todayInTallinn());
  if (!effectiveFrom || !isStrictDate(effectiveFrom)) {
    return refuse("limited_vat_effective_from_required", "status \"limited\" needs effective_from (YYYY-MM-DD): the day the registration obligation arose (KMS § 21 lg 1/lg 3).");
  }
  if (effectiveFrom > todayInTallinn()) {
    return refuse("limited_vat_effective_from_in_future", `effective_from ${effectiveFrom} is in the future; a status is stored only from today (${todayInTallinn()}, Europe/Tallinn) or earlier. Set it again when the change takes effect.`);
  }
  const current = await resolveCompanyVatStatus(api);
  // A VAT number EMTA did not settle is exactly what set_status resolves; only an unreadable store refuses.
  if (current.status === "unknown" && current.reason !== COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE && current.reason !== COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS) {
    return statusUnknownRefusal(current);
  }
  if (args.status === "full" && !current.vat_number) {
    return refuse("limited_vat_full_requires_vat_number", "status \"full\" needs a VAT number in e-arveldaja (get_vat_info shows none).");
  }
  const normalizedArgs: PlanRecord = { status: args.status, effective_from: effectiveFrom };
  if (!args.execute) {
    const planInput: ExecutionPlanInput = {
      normalizedArgs,
      sourceIdentities: [],
      liveSnapshot: { ...normalizedArgs, vat_number: current.vat_number, destructive: false },
      commands: [{ id: "limited-vat-status", category: "set_company_vat_status", reviewProjection: normalizedArgs }],
      counts: {},
      totals: {},
      exclusions: [],
      reviews: [],
      privatePayload: { ...normalizedArgs, vat_number: current.vat_number, previous_status_record: statusRecordVersion(readRecords()) },
    };
    const planHandle = ctx.planStore.issue(LIMITED_VAT_STATUS_DOMAIN, planInput);
    const payload: LimitedVatSetStatusPreviewPayload = {
      mode: "set_status",
      status: "ready_for_approval",
      plan_handle: planHandle,
      current: { status: current.status, source: current.source, effective_from: current.effective_from, ...(current.reason ? { reason: current.reason } : {}) },
      proposed: { status: args.status, effective_from: effectiveFrom, vat_number: current.vat_number },
      effect: args.status === "full"
        ? "Fully VAT-registered: input VAT and reverse charge are handled as for a VAT payer."
        : args.status === "limited"
          ? "Limited taxpayer: never treated as VAT-registered — no input-VAT deduction, no reverse-charge input leg; the monthly VAT on foreign services is booked with mode \"month\"."
          : "Not VAT-registered: no input-VAT deduction, no reverse charge.",
      next_step_summary: `Only after the owner approves this status, call limited_vat mode "set_status" again with the same status and effective_from, execute: true and this plan_handle. The decision applies to ${current.vat_number ? `VAT number ${current.vat_number}` : "the company without a VAT number"} and takes precedence over EMTA's KMKR query; if e-arveldaja shows another number later, the decision no longer applies and the new number is looked up again. Nothing is changed in e-arveldaja; the setting is stored for this connection only.`,
    };
    return respond(payload);
  }
  if (!args.plan_handle) return refuse("plan_handle_required", "execute: true needs the plan_handle from the set_status preview.");
  let plan;
  try {
    plan = ctx.planStore.consume(args.plan_handle, LIMITED_VAT_STATUS_DOMAIN);
  } catch (error) {
    return refuse((error as { code?: string }).code ?? "plan_handle_invalid", "The reviewed status plan could not be consumed.");
  }
  if (canonicalPlanJson(plan.normalizedArgs) !== canonicalPlanJson(normalizedArgs)) {
    return refuse("plan_drift", "status or effective_from differ from the approved preview.");
  }
  const bound = plan.privatePayload as { previous_status_record?: unknown; vat_number?: unknown } | null;
  const boundNumber = bound?.vat_number;
  if ((boundNumber !== null && typeof boundNumber !== "string") || !sameVatNumber(boundNumber, current.vat_number)) {
    return refuse("plan_drift", `The VAT number in e-arveldaja changed after this preview (now ${current.vat_number ?? "none"}). Run the set_status preview again and confirm the status for the current number.`);
  }
  const previous = bound?.previous_status_record;
  if (typeof previous !== "string" || previous !== statusRecordVersion(readRecords())) {
    return refuse("plan_drift", "The stored company VAT status changed after this preview (another approval saved a newer setting). Run the set_status preview again.");
  }
  try {
    limitedVatStore.upsert([{ kind: "status", key: "company_vat_status", status: args.status, effective_from: effectiveFrom, set_at: new Date().toISOString(), vat_number: current.vat_number }]);
  } catch (error) {
    return refuse("limited_vat_store_unavailable", `The status could not be stored (${(error as Error).message}).`);
  }
  logAudit({
    tool: "limited_vat",
    action: "UPDATED",
    entity_type: "company_vat_status",
    summary: `Company VAT status set to ${args.status} from ${effectiveFrom}`,
    details: { status: args.status, effective_from: effectiveFrom, vat_number: current.vat_number, previous: current.status },
  });
  const saved: LimitedVatSetStatusSavedPayload = {
    mode: "set_status",
    status: "saved",
    saved: { status: args.status, effective_from: effectiveFrom, vat_number: current.vat_number },
    note: "Stored for this connection, bound to this VAT number. Nothing was changed in e-arveldaja.",
  };
  return respond(saved);
}

// ---------------------------------------------------------------------------
// month
// ---------------------------------------------------------------------------

interface MonthArgs {
  month?: string;
  liability_account?: number;
  supplier_classifications?: Array<{ clients_id: number; classification: SupplierClassification }>;
  execute?: boolean;
  plan_handle?: string;
}

function resolveLiabilityAccount(accounts: Account[], override: number | undefined): number | { error: CallToolResult } {
  if (override !== undefined) {
    const account = accounts.find(entry => entry.id === override);
    if (!account || account.is_valid === false) {
      return { error: refuse("limited_vat_liability_account_invalid", `Account ${override} is not an active account in the chart.`) };
    }
    return override;
  }
  const found = findAccountByName(accounts, VAT_LIABILITY_NAME_RE);
  if (found === undefined) {
    return {
      error: refuse("limited_vat_liability_account_unresolved", "No VAT liability account (\"Käibemaksukohustis\" / \"Arvestatud käibemaks\" / \"Käibemaksuvõlg\") was found in the chart. Pass liability_account explicitly (the account number); it is never guessed."),
    };
  }
  return found;
}

interface MonthBuild {
  month: string;
  liabilityAccount: number;
  inputs: LimitedVatInvoiceInput[];
  classifications: Map<number, SupplierClassification>;
  proposed: Array<{ clients_id: number; classification: SupplierClassification }>;
  records: LimitedVatStoreRecord[];
  fx: FrozenFxOutcomes;
  computation: ReturnType<typeof computeLimitedVatMonth>;
  state: LimitedVatMonthState;
  postings: LimitedVatPosting[];
  notes: string[];
}

async function loadMonthInputs(api: ApiContext, month: string, fresh: boolean): Promise<{ inputs: LimitedVatInvoiceInput[]; clients: Client[]; unread: PurchaseInvoice[] } | { error: CallToolResult }> {
  if (fresh) {
    api.clients.invalidateListCache();
    api.purchaseInvoices.invalidateListCache();
    api.transactions.invalidateListCache();
    api.journals.invalidateListCache();
  }
  const [clients, invoices] = await Promise.all([api.clients.listAll(), api.purchaseInvoices.listAll()]);
  const byId = new Map(clients.map(client => [client.id, client]));
  const { to } = monthBounds(month);
  const candidates = invoices
    .filter(invoice => isMonthCandidate(invoice, byId.get(invoice.clients_id), month))
    .sort((a, b) => a.create_date.localeCompare(b.create_date) || (a.id ?? 0) - (b.id ?? 0));
  // Invoices dated in the month are always read; later ones (a prepayment in
  // the month may precede them) fill the remaining budget, earliest first.
  const inMonth = candidates.filter(invoice => invoice.create_date <= to);
  if (inMonth.length > MAX_MONTH_CANDIDATES) {
    return { error: refuse("limited_vat_too_many_candidates", `${inMonth.length} foreign-supplier invoices are dated in ${month}; at most ${MAX_MONTH_CANDIDATES} are read per run.`) };
  }
  const read = candidates.slice(0, MAX_MONTH_CANDIDATES);
  const unread = candidates.slice(MAX_MONTH_CANDIDATES);
  const inputs: LimitedVatInvoiceInput[] = [];
  for (const candidate of read) {
    const invoice: PurchaseInvoice = await api.purchaseInvoices.get(candidate.id!);
    if (invoice.status !== "CONFIRMED") continue;
    const paymentDates: string[] = [];
    for (const transactionId of invoice.transactions ?? []) {
      const transaction = await api.transactions.get(transactionId);
      if (transaction.is_deleted !== true && transaction.status === "CONFIRMED" && typeof transaction.date === "string") paymentDates.push(transaction.date);
    }
    if (invoice.paid_in_cash && typeof invoice.cash_payment_date === "string") paymentDates.push(invoice.cash_payment_date);
    inputs.push({ invoice, client: byId.get(invoice.clients_id), payment_dates: paymentDates.sort() });
  }
  return { inputs, clients, unread };
}

async function buildMonth(
  api: ApiContext,
  args: MonthArgs,
  options: { fresh: boolean; fx: FrozenFxOutcomes | "resolve"; ecb?: EcbRateDeps },
): Promise<MonthBuild | { error: CallToolResult }> {
  const parsed = args.month ? parseStrictMonth(args.month) : undefined;
  if (!parsed) return { error: refuse("limited_vat_month_required", "mode \"month\" needs month (YYYY-MM).") };
  const month = parsed.canonical;
  const status = await resolveCompanyVatStatus(api);
  if (status.status === "unknown") return { error: statusUnknownRefusal(status) };
  if (status.status !== "limited") {
    return { error: refuse("limited_vat_status_not_limited", `The company VAT status is "${status.status}" (${status.source}); the monthly run is only for a limited taxpayer. Set it with mode "set_status" (owner approval) — see mode "guide".`) };
  }
  const { from, to } = monthBounds(month);
  if (status.effective_from && to < status.effective_from) {
    return { error: refuse("limited_vat_month_before_effective_from", `${month} ends before the limited-taxpayer status starts (${status.effective_from}).`) };
  }
  if (to >= todayInTallinn()) {
    return { error: refuse("limited_vat_month_not_ended", `${month} has not ended yet; run it after the month's purchase invoices are confirmed.`) };
  }
  const accounts = await api.readonly.getAccounts();
  const liability = resolveLiabilityAccount(accounts, args.liability_account);
  if (typeof liability !== "number") return liability;
  const records = readRecords();
  if (records === null) return { error: refuse("limited_vat_store_unavailable", storeUnavailableMessage()) };
  const loaded = await loadMonthInputs(api, month, options.fresh);
  if ("error" in loaded) return loaded;
  const clientIds = new Set(loaded.clients.map(client => client.id));
  const proposed = [...new Map((args.supplier_classifications ?? []).map(entry => [entry.clients_id, entry])).values()]
    .sort((a, b) => a.clients_id - b.clients_id);
  const unknown = proposed.filter(entry => !clientIds.has(entry.clients_id));
  if (unknown.length > 0) {
    return { error: refuse("limited_vat_supplier_unknown", `supplier_classifications name unknown clients: ${unknown.map(entry => entry.clients_id).join(", ")}.`) };
  }
  const classifications = storedSupplierClassifications(records);
  for (const entry of proposed) classifications.set(entry.clients_id, entry.classification);
  const fx = options.fx === "resolve" ? await resolveFrozenFxOutcomes(fxKeysFor(loaded.inputs, month), options.ecb) : options.fx;
  const computation = computeLimitedVatMonth(month, loaded.inputs, classifications, fx);
  const byClient = new Map(loaded.clients.map(client => [client.id, client]));
  for (const invoice of loaded.unread) {
    const client = byClient.get(invoice.clients_id);
    const decision = classifySupplier(client, classifications.get(invoice.clients_id));
    if (decision.decision === "not_foreign" || decision.decision === "excluded") continue;
    computation.reviews.push({
      code: "limited_vat_coverage_incomplete",
      invoice_id: invoice.id!,
      number: invoice.number,
      clients_id: invoice.clients_id,
      supplier: client?.name ?? invoice.client_name,
      service_date: invoice.create_date,
      message: `Not read in this run (read budget ${MAX_MONTH_CANDIDATES} invoices): a payment of this invoice in ${month} would put its service date (KMS § 11) in this month. Check its payment dates; it is not included.`,
    });
  }
  const journals = await api.journals.listAll();
  const familyIds = journals
    .filter(journal => journal.is_deleted !== true && typeof journal.document_number === "string" && journal.document_number.startsWith(`PKM-${month}`))
    .map(journal => journal.id!);
  const family = await Promise.all(familyIds.map(id => api.journals.get(id)));
  const state = resolveLimitedVatMonthState(month, computation, family, records, liability);
  const postings = state.kind === "new" || state.kind === "delta" ? buildLimitedVatPostings(state.invoices, liability) : [];
  const notes: string[] = [];
  if (status.effective_from && from < status.effective_from) {
    notes.push(`The status starts ${status.effective_from}; invoices of ${month} before that day are still included — check that the effective date is right.`);
  }
  return { month, liabilityAccount: liability, inputs: loaded.inputs, classifications, proposed, records, fx, computation, state, postings, notes };
}

function monthFingerprint(build: MonthBuild): string {
  const state = build.state;
  const computation = build.computation;
  const touched = new Set([
    ...computation.included.map(row => row.invoice_id),
    ...computation.excluded.map(row => row.invoice_id),
    ...computation.reviews.map(row => row.invoice_id),
  ]);
  const suppliers = [...new Map(build.inputs
    .filter(input => touched.has(input.invoice.id!))
    .map(input => [input.invoice.clients_id, {
      clients_id: input.invoice.clients_id,
      country: input.client?.cl_code_country ?? null,
      invoice_country: input.client?.cl_invoice_country ?? null,
      vat_no: input.client?.invoice_vat_no ?? null,
    }])).values()].sort((a, b) => a.clients_id - b.clients_id);
  return canonicalPlanJson({
    included: computation.included as unknown as PlanData,
    suppliers,
    kmd: kmdFigures(computation.included) as unknown as PlanData,
    review_details: computation.reviews.map(review => `${review.code}:${review.invoice_id}:${review.clients_id}:${review.service_date}`),
    month: build.month,
    liability_account: build.liabilityAccount,
    state: state.kind,
    document_number: state.kind === "new" || state.kind === "delta" ? state.document_number : null,
    invoice_ids: state.kind === "new" || state.kind === "delta" ? state.invoices.map(invoice => invoice.invoice_id) : [],
    postings: postingSignature(build.postings),
    reviews: build.computation.reviews.map(review => `${review.code}:${review.invoice_id}`),
    excluded: build.computation.excluded.map(exclusion => `${exclusion.reason}:${exclusion.invoice_id}`),
  });
}

function monthNormalizedArgs(build: MonthBuild): PlanRecord {
  return {
    month: build.month,
    liability_account: build.liabilityAccount,
    supplier_classifications: build.proposed.map(entry => ({ clients_id: entry.clients_id, classification: entry.classification })),
  };
}

function journalTitle(month: string, documentNumber: string): string {
  return documentNumber === `PKM-${month}`
    ? `Piiratud maksukohustuslase käibemaks ${month}`
    : `Piiratud maksukohustuslase käibemaks ${month} (parandus ${documentNumber.slice(documentNumber.lastIndexOf("-") + 1)})`;
}

function monthPayload(build: MonthBuild, status: LimitedVatMonthPayload["status"], extra: Partial<LimitedVatMonthPayload> = {}): LimitedVatMonthPayload {
  const { month, state } = build;
  const { to } = monthBounds(month);
  const documentNumber = state.kind === "new" || state.kind === "delta" ? state.document_number : undefined;
  return {
    mode: "month",
    month,
    status,
    state: state.kind,
    ...(documentNumber ? { document_number: documentNumber } : {}),
    ...(state.kind === "already_booked" || state.kind === "conflict" || state.kind === "delta"
      ? { journal_ids: state.kind === "delta" ? state.booked_journal_ids : state.journal_ids } : {}),
    liability_account: build.liabilityAccount,
    included_invoices: build.computation.included.map(wrapView),
    excluded_invoices: build.computation.excluded.map(wrapView),
    review_items: build.computation.reviews.map(wrapView),
    ...(documentNumber && build.postings.length > 0
      ? { proposed_journal: { document_number: documentNumber, title: journalTitle(month, documentNumber), effective_date: to, postings: build.postings } }
      : {}),
    supplier_classifications_to_save: build.proposed,
    kmd: kmdFigures(build.computation.included),
    payment_deadline: paymentDeadline(month),
    notes: [
      ...build.notes,
      ...(build.computation.reviews.length > 0
        ? ["Offer each review item to the owner inline (yes/no per supplier for unclassified suppliers); a resolved item is booked later as a correction (PKM-YYYY-MM-Pn), never a second full journal."]
        : []),
      ...(state.kind === "delta" ? ["The month is already booked; this is a correction for invoices added since."] : []),
    ],
    ...extra,
  };
}

async function handleMonth(api: ApiContext, ctx: RuntimeSafetyContext, args: MonthArgs, ecb?: EcbRateDeps): Promise<CallToolResult> {
  if (!args.execute) {
    const build = await buildMonth(api, args, { fresh: false, fx: "resolve", ecb });
    if ("error" in build) return build.error;
    if (build.state.kind === "conflict") {
      return refuse("limited_vat_journal_conflict", build.state.reason, { month: build.month, journal_ids: build.state.journal_ids });
    }
    const bookable = build.postings.length > 0;
    if (!bookable && build.proposed.length === 0) {
      return respond(monthPayload(build, build.state.kind === "already_booked" ? "already_booked" : "nothing_to_book"));
    }
    const normalizedArgs = monthNormalizedArgs(build);
    const planInput: ExecutionPlanInput = {
      normalizedArgs,
      sourceIdentities: [],
      liveSnapshot: { month: build.month, destructive: false },
      commands: [{
        id: `limited-vat-${build.month}`,
        category: "book_limited_vat_month",
        reviewProjection: { postings: postingSignature(build.postings), classifications: normalizedArgs.supplier_classifications! },
      }],
      counts: { included: build.computation.included.length, reviews: build.computation.reviews.length },
      totals: { vat: roundMoney(build.postings.filter(posting => posting.type === "C").reduce((sum, posting) => sum + posting.amount, 0)) },
      exclusions: [],
      reviews: [],
      privatePayload: { fingerprint: monthFingerprint(build), fx_outcomes: build.fx as unknown as PlanData },
    };
    const planHandle = ctx.planStore.issue(LIMITED_VAT_MONTH_DOMAIN, planInput);
    return respond(monthPayload(build, "ready_for_approval", {
      plan_handle: planHandle,
      next_step_summary: bookable
        ? "Show the owner the proposed journal, the KMD figures and every review item. Only after approval, call limited_vat mode \"month\" again with the same month, liability_account and supplier_classifications, execute: true and this plan_handle: the journal is created and confirmed, and the supplier classifications are saved."
        : "Nothing to book; after the owner approves, call again with execute: true and this plan_handle to save the supplier classifications.",
    }));
  }
  if (!args.plan_handle) return refuse("plan_handle_required", "execute: true needs the plan_handle from the month dry run.");
  let plan;
  try {
    plan = ctx.planStore.consume(args.plan_handle, LIMITED_VAT_MONTH_DOMAIN);
  } catch (error) {
    return refuse((error as { code?: string }).code ?? "plan_handle_invalid", "The reviewed month plan could not be consumed.");
  }
  const privatePayload = plan.privatePayload as { fingerprint?: unknown } | null;
  const build = await buildMonth(api, args, { fresh: true, fx: readFrozenFxOutcomes(plan.privatePayload) });
  if ("error" in build) return build.error;
  if (canonicalPlanJson(plan.normalizedArgs) !== canonicalPlanJson(monthNormalizedArgs(build)) ||
      privatePayload?.fingerprint !== monthFingerprint(build)) {
    return refuse("plan_drift", "The month changed after the dry run (invoices, payments, journals, classifications or arguments). Run the dry run again.");
  }
  if (build.state.kind === "conflict") {
    return refuse("limited_vat_journal_conflict", build.state.reason, { journal_ids: build.state.journal_ids });
  }
  const now = new Date().toISOString();
  const supplierRecords: LimitedVatStoreRecord[] = build.proposed.map(entry => ({
    kind: "supplier", key: supplierRecordKey(entry.clients_id), clients_id: entry.clients_id, classification: entry.classification, set_at: now,
  }));
  if (build.postings.length === 0 || (build.state.kind !== "new" && build.state.kind !== "delta")) {
    try {
      limitedVatStore.upsert(supplierRecords);
    } catch (error) {
      return refuse("limited_vat_store_unavailable", `The supplier classifications could not be stored (${(error as Error).message}).`);
    }
    return respond(monthPayload(build, build.state.kind === "already_booked" ? "already_booked" : "nothing_to_book", {
      notes: ["Supplier classifications saved; no journal was needed."],
    }));
  }
  const state = build.state;
  const { to } = monthBounds(build.month);
  const expected = postingSignature(build.postings);
  const guard = await BookingGuard.load(api);
  let booking;
  try {
    booking = await guard.createJournalOnce(
      { ns: "PKM", id: state.document_number.slice(4) },
      { title: journalTitle(build.month, state.document_number), effective_date: to, postings: build.postings },
      {
        confirm: true,
        // A journal recovered by document number after a lost create is confirmed only when it is this booking.
        validateRecovered: journal => {
          if (journal.is_deleted === true) return "is deleted";
          if ((journal.effective_date ?? "").slice(0, 10) !== to) return `is dated ${journal.effective_date}, not the approved ${to}`;
          if (postingSignature(journal.postings ?? []).join() !== expected.join()) return "has different postings";
          return undefined;
        },
      },
    );
  } catch (error) {
    if (error instanceof RecoveredJournalRejectedError) {
      return refuse("limited_vat_journal_conflict", `${error.message} Review that journal; nothing was recorded.`, { journal_ids: [error.journalId] });
    }
    throw error;
  }
  const journalId = booking.journal_id;
  if (booking.status === "duplicate" || booking.recovered === true) {
    api.journals.invalidateListCache();
    const existing = await api.journals.get(journalId);
    const problem = limitedVatJournalProblem(existing, to);
    if (problem || postingSignature(existing.postings ?? []).join() !== expected.join()) {
      return refuse("limited_vat_journal_conflict", `Journal ${journalId} already carries ${state.document_number} but ${problem ?? "has different postings"}; nothing was recorded.`, { journal_ids: [journalId] });
    }
  }
  const bookingRecord: LimitedVatStoreRecord = {
    kind: "booking",
    key: bookingRecordKey(state.document_number),
    month: build.month,
    document_number: state.document_number,
    journal_id: journalId,
    effective_date: to,
    invoice_ids: state.invoices.map(invoice => invoice.invoice_id),
    postings: expected,
    booked_at: now,
  };
  logAudit({
    tool: "limited_vat",
    action: booking.status === "created" ? "CREATED" : "UPDATED",
    entity_type: "journal",
    entity_id: journalId,
    summary: `Limited-taxpayer VAT ${state.document_number}: ${roundMoney(build.postings.filter(posting => posting.type === "C").reduce((sum, posting) => sum + posting.amount, 0))} EUR`,
    details: { month: build.month, document_number: state.document_number, invoice_ids: bookingRecord.invoice_ids, postings: build.postings, booking_status: booking.status },
  });
  try {
    limitedVatStore.upsert([...supplierRecords, bookingRecord]);
  } catch (error) {
    return refuse("limited_vat_record_failed", `Journal ${journalId} was created and confirmed, but its booking record could not be stored (${(error as Error).message}). Do not book the month again; the next dry run reports the journal as already booked when its postings equal the month.`, { journal_ids: [journalId], note: "The journal was written; only the local record failed." });
  }
  return respond(monthPayload(build, "booked", {
    journal_ids: [journalId],
    notes: [`Journal ${journalId} (${state.document_number}) created and confirmed. Pay the VAT to EMTA by ${paymentDeadline(build.month)} (prepayment account flow); file the KMD for ${build.month}.`],
  }));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM");

export function registerLimitedVatTool(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  deps: { ecb?: EcbRateDeps } = {},
): void {
  registerTool(server, "limited_vat",
    "Limited taxpayer (piiratud maksukohustuslane, KMS § 21): a non-VAT company buying foreign services such as cloud/SaaS/API. " +
    "mode guide = Estonian guidance (why, how to register, monthly routine); status = the company VAT status (none/limited/full/unknown) with its source (owner setting or EMTA's public KMKR query) and, for none, foreign-service candidates in the books; " +
    "set_status = store the owner's status for the current VAT number, overriding EMTA; needed when EMTA cannot settle it (preview → owner approval → execute:true + plan_handle); " +
    "month = dry run for YYYY-MM (foreign invoices by service date, ECB rates, VAT per cost account, KMD figures), then execute:true + plan_handle creates and confirms journal PKM-YYYY-MM after owner approval. Never files the KMD.",
    {
      mode: z.enum(["guide", "status", "set_status", "month"]).describe("guide | status | set_status | month"),
      status: z.enum(["none", "limited", "full"]).optional().describe("set_status: the company VAT status"),
      effective_from: z.string().refine(isStrictDate, { message: "Expected valid YYYY-MM-DD date" }).optional().describe("set_status: first day the status applies (required for limited: the day the obligation arose)"),
      month: monthSchema.optional().describe("month: the month to compute (YYYY-MM)"),
      liability_account: z.number().int().positive().optional().describe("month: VAT liability account number (default: by name 'Käibemaksukohustis' / 'Arvestatud käibemaks' / 'Käibemaksuvõlg'; never guessed)"),
      supplier_classifications: z.array(z.object({
        clients_id: z.number().int().positive(),
        classification: z.enum(["counts", "excluded"]),
      }).strict()).max(200).optional().describe("month: owner decisions per foreign supplier (counts = KMS § 10 lg 5 service; excluded = not); saved on execute"),
      execute: z.boolean().optional().describe("set_status / month: false (default) = preview; true = execute an approved plan_handle"),
      plan_handle: z.string().optional().describe("set_status / month with execute:true: the handle from the preview"),
    },
    { ...destructive, title: "Limited VAT Taxpayer" },
    async (args) => {
      switch (args.mode) {
        case "guide": {
          const payload: LimitedVatGuidePayload = { mode: "guide", guidance: buildLimitedVatGuidance(), tax_rules: LIMITED_TAXPAYER_RULES };
          return respond(payload);
        }
        case "status":
          return respond(await buildStatus(api));
        case "set_status":
          return handleSetStatus(api, runtimeSafetyContext, args);
        case "month":
          return handleMonth(api, runtimeSafetyContext, args, deps.ecb);
      }
    },
  );
}
