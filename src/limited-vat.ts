/**
 * Limited taxpayer (piiratud maksukohustuslane, KMS § 21) monthly VAT on
 * services received from foreign businesses. Pure computation: candidate
 * selection, supplier classification, § 11 dates, EUR bases (frozen ECB
 * outcomes), per-line VAT, journal postings, and the idempotency state of the
 * month's `PKM-YYYY-MM` journal family. No IO here — the tool module reads and
 * writes.
 */
import { roundMoney } from "./money.js";
import { replayFrozenFx, fxOutcomeKey, type FrozenFxOutcomes, type EcbRateRecord } from "./fx/ecb-rates.js";
import { standardVatRateOn } from "./estonian-tax-rules.js";
import { isInvalidatedPurchaseInvoice } from "./purchase-invoice-status.js";
import type { Client, Journal, PurchaseInvoice } from "./types/api.js";
import type { LimitedVatBookingRecord, LimitedVatStoreRecord, LimitedVatSupplierRecord } from "./company-vat-status.js";

/** EU member states other than Estonia (ISO 3166-1 alpha-3, as in `cl_code_country`). */
export const EU_COUNTRIES_EXCEPT_EST: ReadonlySet<string> = new Set(
  "AUT BEL BGR HRV CYP CZE DNK FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE".split(" "),
);

/**
 * Financial-service suppliers (KMS § 10 lg 5 p 4) — banks, payment and
 * brokerage providers. Treated as excluded for this feature; the owner can
 * override per supplier with classification `counts`.
 */
const FINANCIAL_SERVICE_RE = /\b(wise|lightyear|revolut|paypal|stripe|klarna|swedbank|seb|lhv|luminor|n26|bank|pank|insurance|kindlustus)\b/iu;

export type SupplierClassification = "counts" | "excluded";

/** The supplier fields the decisions read (a resolved client or a preview client). */
export interface SupplierFacts {
  name?: string | null;
  cl_code_country?: string | null;
  invoice_vat_no?: string | null;
}

export type SupplierDecision =
  | { decision: "not_foreign" }
  | { decision: "counts"; source: "owner" }
  | { decision: "excluded"; source: "owner" | "ex_small_business" | "financial_service" }
  | { decision: "unclassified" };

export function isForeignSupplier(client: SupplierFacts | null | undefined): boolean {
  const country = client?.cl_code_country?.trim().toUpperCase();
  return !!country && country !== "EST";
}

/** EU small-business special scheme: registration number ends with "EX". */
export function hasExSuffix(vatNumber: string | null | undefined): boolean {
  return /EX$/i.test((vatNumber ?? "").replace(/\s+/g, ""));
}

export function isFinancialServiceSupplier(name: string | null | undefined): boolean {
  return FINANCIAL_SERVICE_RE.test(name ?? "");
}

/**
 * The supplier decision for the monthly run. EX suppliers are always excluded
 * (statutory exception); then the owner classification (proposed in this run,
 * else stored) wins; financial-service suppliers default to excluded; anything
 * else is unclassified (a review item, never silently included or dropped).
 */
export function classifySupplier(
  client: SupplierFacts | undefined,
  ownerClassification: SupplierClassification | undefined,
): SupplierDecision {
  if (!isForeignSupplier(client)) return { decision: "not_foreign" };
  if (hasExSuffix(client?.invoice_vat_no)) return { decision: "excluded", source: "ex_small_business" };
  if (ownerClassification === "counts") return { decision: "counts", source: "owner" };
  if (ownerClassification === "excluded") return { decision: "excluded", source: "owner" };
  if (isFinancialServiceSupplier(client?.name)) return { decision: "excluded", source: "financial_service" };
  return { decision: "unclassified" };
}

/** Stored owner classifications by client id. */
export function storedSupplierClassifications(records: readonly LimitedVatStoreRecord[]): Map<number, SupplierClassification> {
  const map = new Map<number, SupplierClassification>();
  for (const record of records) {
    if (record.kind === "supplier") map.set((record as LimitedVatSupplierRecord).clients_id, record.classification);
  }
  return map;
}

/** § 11 lg 1: the earliest of the invoice (supply) date and any linked payment date. */
export function serviceReceivedDate(invoiceDate: string, paymentDates: readonly string[]): string {
  return [invoiceDate, ...paymentDates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))].sort()[0]!;
}

export function monthBounds(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** KMS § 38 lg 1: payment by the 20th of the following month. */
export function paymentDeadline(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const next = monthNumber === 12 ? `${year + 1}-01` : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
  return `${next}-20`;
}

export const limitedVatDocumentNumber = (month: string, delta?: number) =>
  delta === undefined ? `PKM-${month}` : `PKM-${month}-P${delta}`;

const TOLERANCE = 0.005;

/** The foreign supplier already charged VAT (OSS / B2C treatment) — a review item. */
export function supplierChargedVat(invoice: PurchaseInvoice): boolean {
  if ((invoice.vat_price ?? 0) > TOLERANCE) return true;
  if (invoice.gross_price !== undefined && invoice.net_price !== undefined && invoice.gross_price - invoice.net_price > TOLERANCE) return true;
  return (invoice.items ?? []).some(item =>
    (item.vat_amount ?? 0) > TOLERANCE ||
    (item.project_no_vat_gross_price != null && item.project_no_vat_gross_price - (item.total_net_price ?? 0) > TOLERANCE));
}

export interface LimitedVatInvoiceInput {
  invoice: PurchaseInvoice;
  client: Client | undefined;
  /** Dates of linked bank payments (fresh reads). */
  payment_dates: readonly string[];
}

export interface LimitedVatLine {
  accounts_id: number;
  accounts_dimensions_id: number | null;
  net: number;
  base_eur: number;
  vat: number;
}

export interface LimitedVatIncludedInvoice {
  invoice_id: number;
  number: string;
  clients_id: number;
  supplier: string;
  country: string;
  supplier_area: "eu" | "non_eu";
  service_date: string;
  currency: string;
  net: number;
  base_eur: number;
  vat_rate: number;
  vat: number;
  ecb?: { rate: string; rate_date: string };
  lines: LimitedVatLine[];
}

export type LimitedVatReviewCode =
  | "limited_vat_supplier_unclassified"
  | "limited_vat_supplier_charged_vat"
  | "limited_vat_fx_unavailable"
  | "limited_vat_item_account_missing"
  | "limited_vat_rate_unknown";

export interface LimitedVatReview {
  code: LimitedVatReviewCode;
  invoice_id: number;
  number: string;
  clients_id: number;
  supplier: string;
  service_date: string;
  message: string;
}

export interface LimitedVatExclusion {
  invoice_id: number;
  number: string;
  clients_id: number;
  supplier: string;
  reason: "owner" | "ex_small_business" | "financial_service";
}

export interface LimitedVatMonthComputation {
  month: string;
  included: LimitedVatIncludedInvoice[];
  excluded: LimitedVatExclusion[];
  reviews: LimitedVatReview[];
}

/** Candidate invoices whose create_date may put the § 11 date in `month` (paid before or invoiced in it). */
export function isMonthCandidate(invoice: PurchaseInvoice, client: Client | undefined, month: string, lookaheadDays = 92): boolean {
  if (invoice.status !== "CONFIRMED" || isInvalidatedPurchaseInvoice(invoice)) return false;
  if (!isForeignSupplier(client)) return false;
  const { from, to } = monthBounds(month);
  const ahead = new Date(`${to}T00:00:00Z`);
  ahead.setUTCDate(ahead.getUTCDate() + lookaheadDays);
  return invoice.create_date >= from && invoice.create_date <= ahead.toISOString().slice(0, 10);
}

/** ECB keys a dry run must resolve: one per foreign-currency invoice and § 11 date. */
export function fxKeysFor(inputs: readonly LimitedVatInvoiceInput[], month: string): string[] {
  const { from, to } = monthBounds(month);
  const keys = new Set<string>();
  for (const { invoice, payment_dates } of inputs) {
    const currency = (invoice.cl_currencies_id ?? "EUR").toUpperCase();
    const date = serviceReceivedDate(invoice.create_date, payment_dates);
    if (currency !== "EUR" && date >= from && date <= to) keys.add(fxOutcomeKey(currency, date));
  }
  return [...keys].sort();
}

/** Compute the month. `classifications` = stored classifications overlaid with this run's proposals. */
export function computeLimitedVatMonth(
  month: string,
  inputs: readonly LimitedVatInvoiceInput[],
  classifications: ReadonlyMap<number, SupplierClassification>,
  fx: FrozenFxOutcomes,
): LimitedVatMonthComputation {
  const { from, to } = monthBounds(month);
  const result: LimitedVatMonthComputation = { month, included: [], excluded: [], reviews: [] };
  const sorted = [...inputs].sort((a, b) => (a.invoice.id ?? 0) - (b.invoice.id ?? 0));
  for (const { invoice, client, payment_dates } of sorted) {
    const serviceDate = serviceReceivedDate(invoice.create_date, payment_dates);
    if (serviceDate < from || serviceDate > to) continue;
    const decision = classifySupplier(client, classifications.get(invoice.clients_id));
    if (decision.decision === "not_foreign") continue;
    const base = {
      invoice_id: invoice.id!,
      number: invoice.number,
      clients_id: invoice.clients_id,
      supplier: client?.name ?? invoice.client_name,
    };
    if (decision.decision === "excluded") {
      result.excluded.push({ ...base, reason: decision.source });
      continue;
    }
    const review = (code: LimitedVatReviewCode, message: string) =>
      result.reviews.push({ ...base, code, service_date: serviceDate, message });
    if (decision.decision === "unclassified") {
      review("limited_vat_supplier_unclassified", "Is this a KMS § 10 lg 5 service (e.g. cloud/SaaS/API, consulting, advertising)? Ask the owner: supplier_classifications [{clients_id, classification: \"counts\" | \"excluded\"}]; the choice is saved for later months on approval.");
      continue;
    }
    if (supplierChargedVat(invoice)) {
      review("limited_vat_supplier_charged_vat", "The foreign supplier already charged VAT (OSS / B2C treatment). Not included: whether to self-assess as well and how to recover the charged VAT is an open point — ask EMTA in writing, and give the supplier the limited-taxpayer number.");
      continue;
    }
    const rate = standardVatRateOn(serviceDate);
    if (rate === null) {
      review("limited_vat_rate_unknown", "No standard VAT rate is known for this date.");
      continue;
    }
    const items = invoice.items ?? [];
    if (items.length === 0 || items.some(item => typeof item.purchase_accounts_id !== "number")) {
      review("limited_vat_item_account_missing", "An invoice row has no cost account; the VAT cannot be assigned to a cost account.");
      continue;
    }
    const currency = (invoice.cl_currencies_id ?? "EUR").toUpperCase();
    let ecb: EcbRateRecord | undefined;
    if (currency !== "EUR") {
      const outcome = replayFrozenFx(fx, currency, serviceDate);
      if (!outcome.ok) {
        review("limited_vat_fx_unavailable", `No ECB rate for ${currency} on ${serviceDate} (${outcome.code}); never a guessed rate. Re-run the dry run later.`);
        continue;
      }
      ecb = outcome.rate;
    }
    const lines: LimitedVatLine[] = items.map(item => {
      const net = roundMoney(item.total_net_price ?? 0);
      const baseEur = ecb ? roundMoney(net / Number(ecb.rate)) : net;
      return {
        accounts_id: item.purchase_accounts_id!,
        accounts_dimensions_id: item.purchase_accounts_dimensions_id ?? null,
        net,
        base_eur: baseEur,
        vat: roundMoney(baseEur * rate / 100),
      };
    });
    result.included.push({
      ...base,
      country: client!.cl_code_country.toUpperCase(),
      supplier_area: EU_COUNTRIES_EXCEPT_EST.has(client!.cl_code_country.toUpperCase()) ? "eu" : "non_eu",
      service_date: serviceDate,
      currency,
      net: roundMoney(lines.reduce((sum, line) => sum + line.net, 0)),
      base_eur: roundMoney(lines.reduce((sum, line) => sum + line.base_eur, 0)),
      vat_rate: rate,
      vat: roundMoney(lines.reduce((sum, line) => sum + line.vat, 0)),
      ...(ecb ? { ecb: { rate: ecb.rate, rate_date: ecb.rate_date } } : {}),
      lines,
    });
  }
  return result;
}

export interface LimitedVatPosting {
  accounts_id: number;
  accounts_dimensions_id: number | null;
  type: "D" | "C";
  amount: number;
}

/** D each cost account/dimension (the non-deductible VAT is part of the cost) / K the VAT liability. */
export function buildLimitedVatPostings(invoices: readonly LimitedVatIncludedInvoice[], liabilityAccount: number): LimitedVatPosting[] {
  const groups = new Map<string, { accounts_id: number; accounts_dimensions_id: number | null; cents: number }>();
  for (const line of invoices.flatMap(invoice => invoice.lines)) {
    const key = `${line.accounts_id}|${line.accounts_dimensions_id ?? ""}`;
    const group = groups.get(key) ?? { accounts_id: line.accounts_id, accounts_dimensions_id: line.accounts_dimensions_id, cents: 0 };
    group.cents += Math.round(line.vat * 100);
    groups.set(key, group);
  }
  const postings: LimitedVatPosting[] = [];
  let total = 0;
  for (const group of [...groups.values()].sort((a, b) => a.accounts_id - b.accounts_id || (a.accounts_dimensions_id ?? 0) - (b.accounts_dimensions_id ?? 0))) {
    if (group.cents === 0) continue;
    total += group.cents;
    postings.push({ accounts_id: group.accounts_id, accounts_dimensions_id: group.accounts_dimensions_id, type: group.cents > 0 ? "D" : "C", amount: Math.abs(group.cents) / 100 });
  }
  if (total !== 0) postings.push({ accounts_id: liabilityAccount, accounts_dimensions_id: null, type: total > 0 ? "C" : "D", amount: Math.abs(total) / 100 });
  return postings;
}

/** Canonical posting signature "account|dimension|side|cents", sorted. */
export function postingSignature(postings: ReadonlyArray<{ accounts_id: number; accounts_dimensions_id?: number | null; type?: string; amount: number; base_amount?: number; is_deleted?: boolean }>): string[] {
  return postings
    .filter(posting => posting.is_deleted !== true)
    .map(posting => `${posting.accounts_id}|${posting.accounts_dimensions_id ?? ""}|${posting.type ?? ""}|${Math.round((posting.base_amount ?? posting.amount) * 100)}`)
    .sort();
}

/** Signed net cents per account|dimension over several signatures (D positive). */
function netBySlice(signatures: readonly string[][]): Map<string, number> {
  const map = new Map<string, number>();
  for (const signature of signatures) {
    for (const entry of signature) {
      const [account, dimension, side, cents] = entry.split("|");
      const key = `${account}|${dimension}`;
      map.set(key, (map.get(key) ?? 0) + (side === "D" ? 1 : -1) * Number(cents));
    }
  }
  for (const [key, value] of map) if (value === 0) map.delete(key);
  return map;
}

function sameNet(left: Map<string, number>, right: Map<string, number>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

export type LimitedVatMonthState =
  | { kind: "new"; document_number: string; invoices: LimitedVatIncludedInvoice[] }
  | { kind: "delta"; document_number: string; invoices: LimitedVatIncludedInvoice[]; booked_journal_ids: number[] }
  | { kind: "already_booked"; journal_ids: number[] }
  | { kind: "conflict"; journal_ids: number[]; reason: string };

/**
 * The idempotency state of the month: no live `PKM-YYYY-MM[-Pn]` journal →
 * `new`; every live journal matches its stored booking record (or a lone
 * unrecorded main journal equals the full proposal) and the booked invoices
 * still compute the recorded amounts → `already_booked`, or `delta` for
 * invoices added since; anything else → `conflict` (never a second full journal).
 */
export function resolveLimitedVatMonthState(
  month: string,
  computation: LimitedVatMonthComputation,
  journals: readonly Journal[],
  records: readonly LimitedVatStoreRecord[],
  liabilityAccount: number,
): LimitedVatMonthState {
  const main = limitedVatDocumentNumber(month);
  const family = journals.filter(journal =>
    journal.is_deleted !== true && typeof journal.document_number === "string" &&
    (journal.document_number === main || new RegExp(`^${main}-P\\d+$`).test(journal.document_number)));
  if (family.length === 0) return { kind: "new", document_number: main, invoices: computation.included };
  const journalIds = family.map(journal => journal.id!).sort((a, b) => a - b);
  const bookings = records.filter((record): record is LimitedVatBookingRecord => record.kind === "booking" && record.month === month);
  const full = postingSignature(buildLimitedVatPostings(computation.included, liabilityAccount));
  const bookedIds = new Set<number>();
  const recordedSignatures: string[][] = [];
  for (const journal of family) {
    const record = bookings.find(booking => booking.journal_id === journal.id);
    const signature = postingSignature(journal.postings ?? []);
    if (!record) {
      if (family.length === 1 && journal.document_number === main && signature.join() === full.join()) {
        return { kind: "already_booked", journal_ids: journalIds };
      }
      return { kind: "conflict", journal_ids: journalIds, reason: `Journal ${journal.id} (${journal.document_number}) has no booking record from this tool, or its postings differ from the computed month.` };
    }
    if (signature.join() !== record.postings.join()) {
      return { kind: "conflict", journal_ids: journalIds, reason: `Journal ${journal.id} (${journal.document_number}) was changed after booking.` };
    }
    record.invoice_ids.forEach(id => bookedIds.add(id));
    recordedSignatures.push(record.postings);
  }
  const included = new Map(computation.included.map(invoice => [invoice.invoice_id, invoice]));
  const missing = [...bookedIds].filter(id => !included.has(id));
  if (missing.length > 0) {
    return { kind: "conflict", journal_ids: journalIds, reason: `Booked invoice(s) ${missing.join(", ")} no longer compute into this month (deleted, re-dated or reclassified).` };
  }
  const recomputed = postingSignature(buildLimitedVatPostings([...bookedIds].map(id => included.get(id)!), liabilityAccount));
  if (!sameNet(netBySlice([recomputed]), netBySlice(recordedSignatures))) {
    return { kind: "conflict", journal_ids: journalIds, reason: "The booked invoices now compute different amounts than the booked journals." };
  }
  const added = computation.included.filter(invoice => !bookedIds.has(invoice.invoice_id));
  if (added.length === 0) return { kind: "already_booked", journal_ids: journalIds };
  const usedDeltas = family
    .map(journal => /-P(\d+)$/.exec(journal.document_number ?? "")?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const next = (usedDeltas.length > 0 ? Math.max(...usedDeltas) : 0) + 1;
  return { kind: "delta", document_number: limitedVatDocumentNumber(month, next), invoices: added, booked_journal_ids: journalIds };
}

export interface LimitedVatKmdFigures {
  row_1_taxable_value: number;
  row_4_vat: number;
  row_6_eu_services_value: number;
  row_7_non_eu_services_value: number;
  note: string;
}

export function kmdFigures(invoices: readonly LimitedVatIncludedInvoice[]): LimitedVatKmdFigures {
  const sum = (list: readonly LimitedVatIncludedInvoice[], pick: (invoice: LimitedVatIncludedInvoice) => number) =>
    roundMoney(list.reduce((total, invoice) => total + pick(invoice), 0));
  return {
    row_1_taxable_value: sum(invoices, invoice => invoice.base_eur),
    row_4_vat: sum(invoices, invoice => invoice.vat),
    row_6_eu_services_value: sum(invoices.filter(invoice => invoice.supplier_area === "eu"), invoice => invoice.base_eur),
    row_7_non_eu_services_value: sum(invoices.filter(invoice => invoice.supplier_area === "non_eu"), invoice => invoice.base_eur),
    note: "Kontrolli ridu e-MTA KMD juhendi järgi (rida 6 = ELi tarnija, rida 7 = muu välismaa tarnija). See server KMD-d ei esita; kui e-arveldaja toetab piiratud maksukohustuslase KMD-d ise, kasuta seda.",
  };
}

/**
 * Point-of-use advisory for a foreign supplier on a company that is not
 * fully VAT-registered. Never holds or blocks a booking.
 */
export function limitedVatPointOfUseNote(
  status: "none" | "limited" | "full",
  supplier: SupplierFacts | undefined | null,
): string | undefined {
  if (status === "full" || !supplier || !isForeignSupplier(supplier)) return undefined;
  if (hasExSuffix(supplier.invoice_vat_no) || isFinancialServiceSupplier(supplier.name)) return undefined;
  return status === "limited"
    ? "Piiratud maksukohustuslane: kui see on KMS § 10 lg 5 teenus (nt pilv/SaaS/API), arvestab selle käibemaksu igakuine limited_vat mode \"month\" (standard-profiil). Arvel ise sisendkäibemaksu ega pöördmaksustamist ei ole."
    : "Välismaa teenus: kui see on KMS § 10 lg 5 teenus (nt pilv/SaaS/API) ja ettevõte ei ole käibemaksukohustuslane, tekib kohustus registreerida end piiratud maksukohustuslaseks alates teenuse saamise päevast (KMS § 21 lg 1, piirmäära ei ole). Vaata limited_vat mode \"guide\" (standard-profiil). Broneerimist see ei peata.";
}
