// P2 D: the verified-draft document-reading path of process_accounting_document
// (plan .omc/plans/p2-verified-draft.md §5). Consumer code only: the packet, the
// checker and the binding are the frozen src/document-reading-*.ts modules
// (tag p2-checker-freeze); this module feeds them live data and never changes a
// value they accept or hold on.
//
// Calls: read (packet) → verify (checkReading + supplier/booking binding + the
// full §3.6 duplicate set + journal references) → create → confirm.

import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { plainFailureOutcome as fail, plainSuccessOutcome as ok, type OperationOutcome } from "../operation-outcome.js";
import type { PlanRecord } from "../plan-store.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { FileInputSnapshot, FileInputSource } from "../file-input-snapshot.js";
import { parseDocument, type ParsedDocument } from "../document-parser.js";
import { buildReadingPacket, renderPacketLine, type PacketHoldCode, type ReadingPacket } from "../document-reading-packet.js";
import {
  checkReading,
  labelledHeuristicValues,
  rateMatches,
  type AcceptedValues,
  type CheckResult,
  type HeuristicView,
  type HoldCode,
} from "../document-reading-check.js";
import { parseDocumentReading, type ReadingField } from "../document-reading-schemas.js";
import {
  checkBookingBinding,
  duplicateHolds,
  duplicateKeys,
  supplierCandidates,
  type BindingHold,
  type BookingField,
  type BookingView,
} from "../document-reading-binding.js";
import { packetInputFromParse } from "../tools/document-text-hazards.js";
import {
  computeMinOcrConfidence,
  detectReverseChargeFromText,
  extractReceiptFieldsFromText,
  inferSupplierCountry,
  type ExtractedReceiptFields,
} from "../tools/receipt-extraction.js";
import { buildExtractionConfidenceSignals } from "../tools/receipt-inbox.js";
import { summarizeInvoiceExtraction } from "../invoice-extraction-fallback.js";
import { resolveOwnCompanyIdentifiers, type OwnCompanyIdentifiers } from "../tools/own-company-identity.js";
import { computeBookingSuggestion, textItemsWithPageNums } from "../tools/pdf-workflow.js";
import { isCompanyVatRegistered } from "../tools/crud-tools.js";
import { resolveSupplierDefault } from "../resolution/supplier-default-resolution.js";
import { detectDuplicatePurchaseInvoice } from "../tools/document-audit.js";
import { findInvoiceNumberMatchesAnySupplier } from "../tools/receipt-inbox-matching.js";
import { checkJournalReferences } from "../journal-reference-scan.js";
import { checkIntakeCashDuplicates } from "../bank-posting-duplicate-guard.js";
import { normalizeItemsForNonVat, predictPurchaseItemAmounts, previewPurchaseInvoiceTotals } from "../api/purchase-invoices.api.js";
import { parseVatRateDropdown, roundMoney } from "../money.js";
import {
  applyPurchaseItemStructuralDefaults,
  classifyNonVatInvoiceForm,
  hasVatAccountFields,
  isNonDeductibleVatItem,
  nonVatRegisterRefusal,
  normalizeVatRate,
} from "../tools/purchase-vat-defaults.js";
import { parsePurchaseInvoiceItems } from "../tools/crud-tools.js";
import { vatRatesInForceOn } from "../estonian-tax-rules.js";
import { desandboxAllStrings, desandboxText } from "../external-text-renderer.js";
import { logAudit } from "../audit-log.js";
import { normalizeInvoiceNumberForComparison } from "../purchase-invoice-status.js";
import { canonicalPlanJson, stripUndefinedDeep } from "../tools/camt-plan.js";
import { isAmbiguousPostCreateFailure } from "../tools/receipt-inbox.js";
import { InvoiceCreationError } from "../api/purchase-invoices.api.js";
import { uploadSourceDocumentOrInvalidate } from "../tools/pdf-workflow.js";
import { assertFileInputSnapshotIdentity, FileInputSnapshotError } from "../file-input-snapshot.js";
import { todayInTallinn } from "../local-date.js";
import { parseStrictDate } from "../strict-date.js";
import type { Account, Client, CreatePurchaseInvoiceData, PurchaseInvoice, PurchaseInvoiceItem } from "../types/api.js";
import { computeEffectiveBooking, INVOICE_DOCUMENT_EXTENSIONS, loadSnapshot, materializeSnapshot, MAX_INVOICE_DOCUMENT_SIZE, wrongCompanySignal, type EffectiveBookingModel, type MaterializedSnapshot } from "./operations.js";
import type { AccountingDocumentBookingFields } from "./types.js";
import { applyOwnerAnswers, buildReadingCard, recheckFinalValues, type CardHold, type CardHoldCode, type ReadingCard } from "../document-reading-card.js";

export const READING_PLAN_DOMAIN = "accounting_document_reading";

const requireFromHere = createRequire(import.meta.url);
function liteparseVersion(): string {
  try {
    return (requireFromHere("@llamaindex/liteparse/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}
/** The packet's parser identity: the same `liteparse@<version>` form the reading harness uses. */
export const READING_PARSER_VERSION = `liteparse@${liteparseVersion()}`;

/** A hold as the reading path reports it: a code and an optional field, never a value. */
export type ReadingHold = CardHold;

/** Booking inputs the reading cannot supply; the server suggests them from the supplier's history when omitted. */
export interface ReadingBookingInput {
  items?: unknown;
  liabilityAccountsId?: number;
  journalDate?: string;
  termDays?: number;
  /** The client's item title for the one-item history template (verify only; bound in the plan). */
  itemTitle?: string;
}

export interface ReadDocumentInput { source: FileInputSource; snapshot?: FileInputSnapshot }

export interface ReadDocumentResult {
  sourceSha256: string;
  packetDigest: string;
  packetHolds: PacketHoldCode[];
  /** Absent when a packet hold blocks the reading path. */
  packetText?: string;
}

export interface VerifyDocumentInput {
  source: FileInputSource;
  snapshot?: FileInputSnapshot;
  reading: unknown;
  proof: unknown;
  booking?: ReadingBookingInput;
  /** §5.2a: the owner's explicit release of an indeterminate-create marker, by its id. */
  releaseIndeterminate?: string;
}

export interface VerifyDocumentResult {
  status: "blocked" | "ready";
  sourceSha256: string;
  packetDigest: string;
  holds: ReadingHold[];
  /** The reading's values (present when the reading parsed). */
  values?: AcceptedValues;
  supplier?: { clientId: number; name: string };
  /** The bound write model (present when the booking could be built). */
  booking?: PlanRecord;
  /** Set when the server could not suggest booking items: the client repeats verify with `items`. */
  bookingItemsRequired?: true;
  /** Set when the history template's item title carries a date: the client repeats verify with `item_title`. */
  itemTitleRequired?: true;
  /** The owner card (present when nothing blocks). */
  card?: ReadingCard;
  /** §5.2a: an earlier create of a matching document may still complete; the owner checks e-arveldaja, then releases it. */
  indeterminateMarker?: string;
  /** The marker the owner released in this call; no handle is issued until verify runs again. */
  releasedMarker?: string;
  planHandle?: string;
}

/** What a reading-domain create handle binds (§5.2): everything create re-checks the owner's answers against. */
export interface ReadingPlan {
  source_sha256: string;
  packet_digest: string;
  file_name: string;
  values: PlanRecord;
  card: PlanRecord;
  supplier_client_id: number;
  items_source: PlanRecord;
  booking_input: PlanRecord;
  /** The booking the owner reviewed (computed on the reading's values). */
  booking: PlanRecord;
  heuristic_keys: { invoiceNumber: string | null; supplierClientId: number | null };
  vat_zero_note_proven: boolean;
  reverse_charge_note_present: boolean;
  connection_fingerprint: string | null;
  own: { name: string | null; reg: string | null; vat: string | null };
}

function sameIban(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
}

/** Packet holds that do not block the reading path (the owner types the lost values, §5.3). */
const NON_BLOCKING_PACKET_HOLDS: readonly PacketHoldCode[] = ["text_layer_value_lost"];

const holdOf = (hold: { code: CardHoldCode; field?: ReadingField | BookingField }): ReadingHold =>
  hold.field === undefined ? { code: hold.code } : { code: hold.code, field: hold.field };

function dayDiff(from: string, to: string): number | undefined {
  const a = parseStrictDate(from);
  const b = parseStrictDate(to);
  if (!a || !b) return undefined;
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export interface ReadingParse {
  material: MaterializedSnapshot;
  snapshot: FileInputSnapshot;
  parsed: ParsedDocument;
  packet: ReadingPacket;
}

/** Own-company identity for the checker and the extraction; "unavailable" when nothing is known. */
export async function readingOwnIdentity(api: ApiContext, clients: Client[]): Promise<OwnCompanyIdentifiers | undefined> {
  try {
    return await resolveOwnCompanyIdentifiers(api, clients);
  } catch {
    return undefined;
  }
}

/** The heuristic view the checker cross-checks against, built as the reading harness builds it (build-packets.ts). */
export function readingHeuristic(parsed: ParsedDocument, fileName: string, own: OwnCompanyIdentifiers | undefined): { view: HeuristicView; extracted: ExtractedReceiptFields } {
  const items = textItemsWithPageNums(parsed.result?.pages);
  const extracted = extractReceiptFieldsFromText(parsed.text, fileName, {
    textItems: items,
    ownCompanyVat: own?.ownCompanyVat,
    ownCompanyRegistryCode: own?.ownCompanyRegistryCode,
    ownIbans: own?.ownIbans,
    ownCompanyName: own?.ownCompanyName,
  });
  const signals = buildExtractionConfidenceSignals(extracted, {
    partialOcrFailure: parsed.ocrPartialFailure,
    minOcrConfidence: computeMinOcrConfidence(items),
    ownCompanyVat: own?.ownCompanyVat,
    ownCompanyRegistryCode: own?.ownCompanyRegistryCode,
  });
  const summary = summarizeInvoiceExtraction(extracted, signals, "advanced_detail.raw_text", inferSupplierCountry(extracted));
  const raised = Object.entries(signals).filter(([, value]) => value === true).map(([key]) => key);
  return {
    view: {
      signals: [...new Set([...raised, ...summary.confidence_signals])],
      confidence: summary.confidence,
      labelled: labelledHeuristicValues(extracted.field_provenance ?? []),
    },
    extracted,
  };
}

/** The §3.6 duplicate set over the union keys, plus the journal-reference scan (fail closed: unavailable holds). */
export async function readingDuplicateHolds(
  api: ApiContext,
  values: Pick<AcceptedValues, "invoice_number" | "gross" | "invoice_date" | "currency">,
  supplierClientId: number | undefined,
  heuristic: { invoiceNumber?: string | null; supplierClientId?: number | null },
  options: { uncached: boolean; excludeInvoiceId?: number },
): Promise<BindingHold[]> {
  if (options.uncached) {
    api.purchaseInvoices.invalidateListCache();
    api.journals.invalidateListCache();
  }
  const keys = duplicateKeys({ accepted: values, supplierClientId: supplierClientId ?? 0, heuristic });
  const invoices: PurchaseInvoice[] = (await api.purchaseInvoices.listAll())
    .filter((invoice) => options.excludeInvoiceId === undefined || invoice.id !== options.excludeInvoiceId);
  const eurGross = values.currency === "EUR" && keys.gross !== null ? keys.gross : undefined;
  const exact: unknown[] = [];
  const sameAmountDate: unknown[] = [];
  const voided: unknown[] = [];
  const anySupplier: unknown[] = [];
  for (const clientId of keys.supplierClientIds) {
    if (!clientId) continue;
    const numbers = keys.invoiceNumbers.length > 0 ? keys.invoiceNumbers : [undefined];
    for (const number of numbers) {
      const found = detectDuplicatePurchaseInvoice(invoices, {
        clients_id: clientId,
        ...(number !== undefined ? { invoice_number: number } : {}),
        ...(eurGross !== undefined ? { gross_price: eurGross } : {}),
        ...(keys.invoiceDate ? { invoice_date: keys.invoiceDate } : {}),
      }) as Record<string, { items?: unknown[] }>;
      if (number !== undefined) exact.push(...(found.candidate_invoice_number_matches?.items ?? []));
      sameAmountDate.push(...(found.candidate_same_amount_date_matches?.items ?? []));
      voided.push(...(found.candidate_invalidated_matches?.items ?? []));
    }
  }
  for (const number of keys.invoiceNumbers) anySupplier.push(...findInvoiceNumberMatchesAnySupplier(invoices, number));

  // Journal references: one retry, then unavailable (as receipt_batch).
  let references = await checkJournalReferences(api, keys.invoiceNumbers);
  if (!references.scan_available) {
    api.journals.invalidateListCache();
    references = await checkJournalReferences(api, keys.invoiceNumbers);
  }
  const cash = await checkIntakeCashDuplicates(api, { grossAmountEur: eurGross, invoiceDate: keys.invoiceDate ?? "" });
  const journalReferences = !references.scan_available || !cash.scan_available ? "unavailable" as const : references.hits;
  return duplicateHolds({
    exactDuplicates: exact,
    sameAmountDate,
    voidedCandidates: voided,
    anySupplierNumberMatches: anySupplier,
    journalReferences,
    cashSuspects: cash.scan_available && !cash.skipped_no_eur_amount ? cash.suspects : [],
  });
}

/** The single booking item the server suggests from the supplier's latest confirmed single-item invoice. */
async function suggestedItemTemplate(api: ApiContext, supplierClientId: number): Promise<PurchaseInvoiceItem | undefined> {
  const suggestion = await computeBookingSuggestion(api, { clients_id: supplierClientId });
  const latest = suggestion.past_invoices[0];
  const items = latest?.items ?? [];
  if (items.length !== 1 || items[0]!.purchase_accounts_id == null) return undefined;
  const item = items[0]!;
  return {
    custom_title: item.custom_title ?? "",
    ...(item.cl_purchase_articles_id != null ? { cl_purchase_articles_id: item.cl_purchase_articles_id } : {}),
    purchase_accounts_id: item.purchase_accounts_id,
    ...(item.purchase_accounts_dimensions_id != null ? { purchase_accounts_dimensions_id: item.purchase_accounts_dimensions_id } : {}),
    ...(item.vat_accounts_id != null ? { vat_accounts_id: item.vat_accounts_id } : {}),
    ...(item.vat_accounts_dimensions_id != null ? { vat_accounts_dimensions_id: item.vat_accounts_dimensions_id } : {}),
    ...(item.cl_vat_articles_id != null ? { cl_vat_articles_id: item.cl_vat_articles_id } : {}),
    ...(item.reversed_vat_id != null ? { reversed_vat_id: item.reversed_vat_id } : {}),
    ...(item.vat_rate_dropdown != null ? { vat_rate_dropdown: item.vat_rate_dropdown } : {}),
  } as PurchaseInvoiceItem;
}

const MONTH_WORD = /(?<!\p{L})(?:(?:jaanuar|veebruar|märts|aprill|juuni|juuli|august|septemb|oktoob|novemb|detsemb|january|february|march|april|june|july|september|october|november|december)\p{L}*|mai(?:s|ks|st|le|ni|ga|l|lt|kuu\p{L}*)(?!\p{L})|(?:jan|feb|mar|apr|mai|may|jun|jul|aug|sep|sept|oct|okt|nov|dec|dets)(?!\p{L}))/iu;
const DATE_TOKEN = /\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\.\s*-\s*\d{1,2}\.\d{1,2}|(?<!\d)\d{1,2}[./]\d{4}(?!\d)|(?<!\d)(19|20)\d{2}(?!\d)/;

/** True when a history item title names a date, period or month: copied to another document it would be stale. */
export function itemTitleHasDate(title: string | undefined): boolean {
  return title !== undefined && (DATE_TOKEN.test(title) || MONTH_WORD.test(title));
}

/**
 * One booking item of the template with the document's amounts: net, and the unique VAT rate in force. A non-VAT
 * company's template keeps its rate: readingNonVatItems decides the non-VAT form.
 */
function itemWithAmounts(template: PurchaseInvoiceItem, values: AcceptedValues, isVatReg: boolean, itemTitle?: string): PurchaseInvoiceItem {
  const vat = values.vat ?? 0;
  const gross = values.gross ?? 0;
  const net = values.net ?? round2(gross - vat);
  const rates = vat > 0 && values.invoice_date ? rateMatches(net, vat, vatRatesInForceOn(values.invoice_date)) : [];
  const vatRate = !isVatReg ? template.vat_rate_dropdown
    : vat > 0 ? (rates.length === 1 ? String(rates[0]) : template.vat_rate_dropdown) : (template.vat_rate_dropdown ?? "0");
  return { ...template, ...(itemTitle !== undefined ? { custom_title: itemTitle } : {}), total_net_price: net, amount: 1, ...(vatRate !== undefined && vatRate !== null ? { vat_rate_dropdown: vatRate } : {}) };
}

/** The document's unique VAT rate in force on its date, or undefined (no VAT, no date, zero or several matching rates). */
function documentVatRate(values: AcceptedValues): string | undefined {
  const vat = values.vat ?? 0;
  if (vat <= 0 || !values.invoice_date) return undefined;
  const net = values.net ?? round2((values.gross ?? 0) - vat);
  const rates = rateMatches(net, vat, vatRatesInForceOn(values.invoice_date));
  return rates.length === 1 ? String(rates[0]) : undefined;
}

export type ReadingNonVatItemsResult =
  | { ok: true; items: unknown; nonDeductible: boolean }
  | { ok: false; code: "reading_vat_rate_ambiguous" | "reading_nonvat_item_conflict"; message: string };

/**
 * GitHub #63, owner decision Q2 = CONVERT: a non-VAT company's booking items for the verified reading. A document
 * printing VAT books the non-deductible form (VAT account and dimension = the item's cost account and dimension,
 * article 11, the document's unique rate in force); a folded item is converted, an item already non-deductible at
 * that rate is kept, and anything else is held, never rewritten. A document printing no VAT keeps the folded form: a
 * non-deductible server template is folded, caller-supplied VAT-account fields are held.
 */
export function readingNonVatItems(items: unknown, values: AcceptedValues, source: "template" | "supplied"): ReadingNonVatItemsResult {
  let parsed: PurchaseInvoiceItem[];
  try {
    parsed = parsePurchaseInvoiceItems(items);
  } catch {
    return { ok: true, items, nonDeductible: false }; // computeEffectiveBooking reports the malformed items
  }
  const conflict = (index: number): ReadingNonVatItemsResult => ({
    ok: false,
    code: "reading_nonvat_item_conflict",
    message: `items[${index}] cannot be booked for a non-VAT company on this document without rewriting a supplied field ` +
      "(VAT account, article, rate, project_no_vat_gross_price or reversed_vat_id). Fix the item or book with mode='prepare'.",
  });
  if ((values.vat ?? 0) > 0) {
    const rate = documentVatRate(values);
    if (rate === undefined) {
      return {
        ok: false,
        code: "reading_vat_rate_ambiguous",
        message: "The document's VAT does not match exactly one VAT rate in force on its date: the non-deductible VAT form cannot be booked without guessing the rate.",
      };
    }
    const converted: PurchaseInvoiceItem[] = [];
    for (const [index, item] of parsed.entries()) {
      const itemRate = normalizeVatRate(item.vat_rate_dropdown);
      const folded = !hasVatAccountFields(item) && Number.isInteger(item.purchase_accounts_id)
        && (item.cl_vat_articles_id ?? 11) === 11 && (itemRate === undefined || itemRate === "-" || itemRate === rate)
        && (item.project_no_vat_gross_price ?? null) === null && (item.reversed_vat_id ?? null) === null;
      const kept = isNonDeductibleVatItem(item) && itemRate === rate && (item.project_no_vat_gross_price ?? null) === null;
      if (!folded && !kept) return conflict(index);
      converted.push(kept ? item : {
        ...item,
        vat_accounts_id: item.purchase_accounts_id!,
        ...((item.purchase_accounts_dimensions_id ?? null) !== null ? { vat_accounts_dimensions_id: item.purchase_accounts_dimensions_id } : {}),
        cl_vat_articles_id: 11,
        vat_rate_dropdown: rate,
      });
    }
    return { ok: true, items: converted, nonDeductible: true };
  }
  if (source === "supplied") {
    const conflicting = parsed.findIndex(item => hasVatAccountFields(item)
      || (normalizeVatRate(item.vat_rate_dropdown) !== undefined && normalizeVatRate(item.vat_rate_dropdown) !== "-")
      || (item.cl_vat_articles_id ?? 11) !== 11 || (item.reversed_vat_id ?? null) !== null);
    if (conflicting !== -1) return conflict(conflicting);
  }
  const withVatAccount = parsed.findIndex(hasVatAccountFields);
  if (withVatAccount === -1) return { ok: true, items, nonDeductible: false };
  if (source === "supplied") return conflict(withVatAccount);
  const unsupportedTemplate = parsed.findIndex(item => hasVatAccountFields(item) && !isNonDeductibleVatItem(item));
  if (unsupportedTemplate !== -1) return conflict(unsupportedTemplate);
  return {
    ok: true,
    nonDeductible: false,
    items: parsed.map((item) => {
      if (!hasVatAccountFields(item)) return item;
      const { vat_accounts_id: _account, vat_accounts_dimensions_id: _dimension, ...rest } = item;
      return { ...rest, cl_vat_articles_id: 11, vat_rate_dropdown: "-" };
    }),
  };
}

/** Where the booking items come from: the caller's items, or the server's one-item template (amounts from the values). */
export type ReadingItemsSource = { items: unknown } | { template: PurchaseInvoiceItem };

/** The caller's items, else the supplier's one-item history template; undefined when the server has nothing to suggest. */
export async function resolveItemsSource(api: ApiContext, supplierClientId: number, input: ReadingBookingInput | undefined): Promise<ReadingItemsSource | undefined> {
  if (input?.items !== undefined) return { items: input.items };
  const template = await suggestedItemTemplate(api, supplierClientId);
  return template ? { template } : undefined;
}

export interface ReadingBookingResult {
  effective?: EffectiveBookingModel;
  view?: BookingView;
  bookingSideSignals: string[];
  /** The invoice-level totals createAndSetTotals is called with. */
  vatPrice?: number;
  grossPrice?: number;
  failure?: { code: string; message: string };
}

/** The write model for the values: the caller's items, else the server's one-item suggestion. */
export async function buildReadingBooking(
  api: ApiContext,
  values: AcceptedValues,
  supplierClientId: number,
  itemsSource: ReadingItemsSource,
  input: Omit<ReadingBookingInput, "items"> | undefined,
  material: Pick<MaterializedSnapshot, "source_sha256" | "fileName">,
  isVatReg: boolean,
  knownIban: string | undefined,
): Promise<ReadingBookingResult> {
  let items: unknown = "items" in itemsSource ? itemsSource.items : [itemWithAmounts(itemsSource.template, values, isVatReg, input?.itemTitle)];
  let nonDeductible = false;
  if (!isVatReg) {
    const nonVat = readingNonVatItems(items, values, "items" in itemsSource ? "supplied" : "template");
    if (!nonVat.ok) return { bookingSideSignals: [], failure: { code: nonVat.code, message: nonVat.message } };
    items = nonVat.items;
    nonDeductible = nonVat.nonDeductible;
  }
  const invoiceDate = values.invoice_date ?? "";
  const dueTerm = values.due_date && values.invoice_date ? dayDiff(values.invoice_date, values.due_date) : undefined;
  const fields: AccountingDocumentBookingFields = {
    supplierClientId,
    invoiceNumber: values.invoice_number ?? "",
    invoiceDate,
    journalDate: input?.journalDate ?? invoiceDate,
    termDays: dueTerm ?? input?.termDays ?? 0,
    items,
    ...(isVatReg ? { vatPrice: values.vat ?? 0 } : nonDeductible ? { vatPrice: values.vat! } : {}),
    ...(values.gross !== null ? { grossPrice: values.gross } : {}),
    ...(input?.liabilityAccountsId !== undefined ? { liabilityAccountsId: input.liabilityAccountsId } : {}),
    ...(knownIban ? { bankAccountNo: knownIban } : {}),
  };
  const effective = await computeEffectiveBooking(api, fields, material.source_sha256, material.fileName);
  if (!effective.ok) return { bookingSideSignals: [], failure: { code: effective.error.code, message: effective.error.message } };
  const data = effective.value.invoiceData;
  const preview = previewPurchaseInvoiceTotals(data, fields.vatPrice, fields.grossPrice, isVatReg, effective.value.accounts);
  // What createAndSetTotals sends: the form-aware non-VAT normalisation, then the last-item residue.
  const normalized = normalizeItemsForNonVat(data.items, isVatReg, fields.grossPrice, nonDeductible);
  const finalItems = preview.ok && preview.lastItemGross !== undefined && normalized.length > 0
    ? [...normalized.slice(0, -1), { ...normalized[normalized.length - 1]!, project_no_vat_gross_price: preview.lastItemGross }]
    : normalized;
  const amounts = predictPurchaseItemAmounts(finalItems);
  const bookingSideSignals: string[] = [];
  for (const entry of amounts) {
    if (entry.vat > 0 && rateMatches(entry.net, entry.vat, vatRatesInForceOn(invoiceDate)).length === 0) bookingSideSignals.push("vat_rate_implausible");
  }
  // The non-deductible rate must be the document's unique rate in force (P1 proves the per-row amounts).
  const rate = documentVatRate(values);
  if (nonDeductible && (rate === undefined || finalItems.some((item) => normalizeVatRate(item.vat_rate_dropdown) !== rate))) {
    bookingSideSignals.push("vat_rate_not_document_rate");
  }
  const view: BookingView = {
    clients_id: data.clients_id,
    number: data.number,
    create_date: data.create_date,
    cl_currencies_id: data.cl_currencies_id ?? "EUR",
    currency_rate: data.currency_rate ?? null,
    base_net_price: data.base_net_price ?? null,
    base_vat_price: data.base_vat_price ?? null,
    base_gross_price: data.base_gross_price ?? null,
    gross_price: preview.ok ? preview.gross : fields.grossPrice ?? null,
    vat_price: preview.ok ? preview.vat : fields.vatPrice ?? null,
    term_days: data.term_days ?? null,
    bank_account_no: data.bank_account_no ?? null,
    items: finalItems.map((item) => ({ vat_rate_dropdown: item.vat_rate_dropdown ?? null, reversed_vat_id: item.reversed_vat_id ?? null })),
    effective: {
      itemNet: round2(amounts.reduce((sum, entry) => sum + entry.net, 0)),
      itemGross: round2(amounts.reduce((sum, entry) => sum + entry.net + entry.vat, 0)),
    },
  };
  return {
    effective: effective.value,
    view,
    bookingSideSignals,
    ...(fields.vatPrice !== undefined ? { vatPrice: fields.vatPrice } : {}),
    ...(fields.grossPrice !== undefined ? { grossPrice: fields.grossPrice } : {}),
  };
}

export const READING_CONFIRM_DOMAIN = "accounting_document_reading_confirm";

/**
 * §5.2a: an in-process marker for a create whose outcome is unknown (a POST timeout or an unknown result). It holds
 * every later matching reading-domain document of that connection until a fresh scan finds the late-committed draft
 * (the duplicate hold then applies) or the owner explicitly releases it. Never on an empty scan or elapsed time alone.
 */
export interface IndeterminateMarker {
  id: string;
  supplierClientId: number;
  invoiceNumber: string | null;
  gross: number | null;
  invoiceDate: string | null;
  sourceSha256: string;
}

type MarkerKey = Pick<IndeterminateMarker, "supplierClientId" | "invoiceNumber" | "gross" | "invoiceDate" | "sourceSha256">;

/** The §3.6 predicates: the same file, the same number, or the same supplier with gross ±0.02 and date ±7 days. */
function markerMatches(marker: IndeterminateMarker, key: Partial<MarkerKey>): boolean {
  if (key.sourceSha256 !== undefined && marker.sourceSha256 === key.sourceSha256) return true;
  if (marker.invoiceNumber && key.invoiceNumber &&
    normalizeInvoiceNumberForComparison(marker.invoiceNumber) === normalizeInvoiceNumberForComparison(key.invoiceNumber)) return true;
  if (key.supplierClientId === undefined || marker.supplierClientId !== key.supplierClientId) return false;
  if (marker.gross === null || key.gross === null || key.gross === undefined || Math.abs(marker.gross - key.gross) > 0.02 + 1e-9) return false;
  if (!marker.invoiceDate || !key.invoiceDate) return true;
  const days = dayDiff(marker.invoiceDate, key.invoiceDate);
  return days === undefined || Math.abs(days) <= 7;
}

/**
 * Invoice fields that may differ between the reviewed draft and the one registered: the status and the payment and
 * ledger links register itself fills in. Every other field, known or new (payment fields, cash account and its
 * dimension, dates, items, notes, document id, …), is part of the fingerprint (§5.5).
 */
const DRAFT_FIELDS_ALLOWED_TO_DIFFER: ReadonlySet<string> = new Set(["status", "payment_status", "journals", "settlements", "transactions"]);

/** sha256 of the canonical created draft (§5.5): what the owner approved and confirm compares before register. */
export function draftFingerprint(invoice: PurchaseInvoice): string {
  const material = Object.fromEntries(Object.entries(invoice).filter(([key]) => !DRAFT_FIELDS_ALLOWED_TO_DIFFER.has(key)));
  return createHash("sha256").update(canonicalPlanJson(stripUndefinedDeep(material))).digest("hex");
}

/** Money fields: compared as numbers within half a cent (a numeric string reads as its number). */
const READBACK_MONEY_FIELDS: ReadonlySet<string> = new Set([
  "net_price", "vat_price", "gross_price", "base_net_price", "base_vat_price", "base_gross_price",
  "total_net_price", "unit_net_price", "base_total_net_price", "vat_amount", "project_no_vat_gross_price",
]);
/** Other numeric fields (rates, quantities, day counts, ids): compared as exact numbers, a numeric string read as its number. */
const READBACK_NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  "currency_rate", "vat_rate", "overdue_charge", "amount", "term_days",
  "clients_id", "subclients_id", "liability_accounts_id", "liability_accounts_dimensions_id", "cash_accounts_id", "cash_accounts_dimensions_id",
  "cl_purchase_articles_id", "purchase_accounts_id", "purchase_accounts_dimensions_id", "vat_accounts_id", "vat_accounts_dimensions_id",
  "cl_vat_articles_id", "cl_fringe_benefits_id", "reversed_vat_id", "products_id", "projects_project_id", "projects_location_id", "projects_person_id",
]);

const asNumber = (value: unknown) => (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value);

/**
 * Field-aware equality: money within half a cent, other numeric fields exact, and every other field (invoice number,
 * reference, IBAN, notes, titles, …) exact after trimming a string, never coerced to a number.
 */
const sameValue = (key: string, expectedRaw: unknown, actualRaw: unknown): boolean => {
  if (READBACK_MONEY_FIELDS.has(key) || READBACK_NUMERIC_FIELDS.has(key)) {
    const expected = asNumber(expectedRaw);
    const actual = asNumber(actualRaw);
    if (typeof expected !== "number" || typeof actual !== "number") return false;
    return READBACK_MONEY_FIELDS.has(key) ? Math.abs(expected - actual) < 0.005 : expected === actual;
  }
  if (typeof expectedRaw === "string" && typeof actualRaw === "string") return expectedRaw.trim() === actualRaw.trim();
  if (typeof expectedRaw === "object" && expectedRaw !== null && typeof actualRaw === "object" && actualRaw !== null) {
    return canonicalPlanJson(stripUndefinedDeep(expectedRaw)) === canonicalPlanJson(stripUndefinedDeep(actualRaw));
  }
  return expectedRaw === actualRaw;
};

/** A returned null or "" counts as absent, like an omitted field. */
const isAbsent = (value: unknown) => value === undefined || value === null || value === "";

/**
 * §5.5 readback, deny by default: header fields that may differ from the approved write model. Every other field the
 * readback carries, known or new, must equal the model (or, where the model has none, be absent or a listed default),
 * and every field the model or the predictor expects must be present: the live GET returns every material header and
 * item field (live presence check 2026-10-18), so an omitted one fails closed.
 */
const READBACK_HEADER_ALLOWED_TO_DIFFER: ReadonlySet<string> = new Set([
  "id", // server id of the new draft
  "status", "payment_status", "registered", "register_date", "is_deleted", // registration and payment state register itself sets
  "journals", "settlements", "transactions", "bank_payment_orders_id", // ledger and payment links the server fills in
  "insert_date", "modified_at", // server timestamps
  "base_document_files_id", "is_xls_imported", // document/attachment metadata (the source upload, the import origin)
]);
const READBACK_ITEM_ALLOWED_TO_DIFFER: ReadonlySet<string> = new Set([
  "id", // server id of the item row
  "unit", // the quantity's unit label: no posting effect (the amounts are compared)
]);

/**
 * The values the API returns for a field the approved model leaves out. Expected absent means read back absent
 * (undefined, null, "") or one of these; anything else, on any field, is a mismatch.
 */
const READBACK_HEADER_DEFAULTS: Readonly<Record<string, readonly unknown[]>> = {
  term_days: [0], currency_rate: [1], paid_in_cash: [false], overdue_charge: [0],
};

function readbackFieldMatches(key: string, expected: unknown, actual: unknown, defaults: readonly unknown[]): boolean {
  if (isAbsent(expected)) return isAbsent(actual) || defaults.some((entry) => sameValue(key, entry, actual));
  return !isAbsent(actual) && sameValue(key, expected, actual);
}

/** Fields of `actual` or `expected`, minus those allowed to differ, that do not match. */
function recordMismatches(
  expected: Record<string, unknown>, actual: Record<string, unknown>, allowed: ReadonlySet<string>, defaultsOf: (key: string) => readonly unknown[],
): string[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((key) => !allowed.has(key));
  return keys.filter((key) => !readbackFieldMatches(key, expected[key], actual[key], defaultsOf(key)));
}

/**
 * §5.5: the fields of the created draft, as read back, that differ from the approved write model, deny by default:
 * every header and item field (item count and order included) except the allowlists above. The expected write is what
 * createAndSetTotals sends (non-VAT item normalisation, last-item gross residue, the #62 structural defaults); the
 * server-derived amounts (invoice net/VAT/gross and base amounts, item VAT, VAT rate, unit and base net) are predicted
 * from it with the repo's own amount predictor and must be read back.
 */
export function draftReadbackMismatches(
  draft: PurchaseInvoice, model: CreatePurchaseInvoiceData, totals: { vatPrice?: number; grossPrice?: number }, isVatRegistered: boolean,
  accounts?: readonly Account[],
): string[] {
  const preview = previewPurchaseInvoiceTotals(model, totals.vatPrice, totals.grossPrice, isVatRegistered, accounts);
  const nonDeductible = !isVatRegistered && classifyNonVatInvoiceForm(model.items, accounts) === "non_deductible";
  const normalized = normalizeItemsForNonVat(model.items, isVatRegistered, totals.grossPrice, nonDeductible);
  const expectedItems = preview.ok && preview.lastItemGross !== undefined && normalized.length > 0
    ? [...normalized.slice(0, -1), { ...normalized[normalized.length - 1]!, project_no_vat_gross_price: preview.lastItemGross }]
    : normalized;
  const amounts = predictPurchaseItemAmounts(expectedItems);
  const expectedNet = roundMoney(amounts.reduce((sum, entry) => sum + entry.net, 0));
  const expectedVat = preview.ok ? preview.vat : totals.vatPrice;
  const expectedGross = preview.ok ? preview.gross : totals.grossPrice;
  const base = preview.ok ? preview.base : undefined;

  const { items: draftItems, ...draftHeader } = draft;
  const { items: _modelItems, ...modelHeader } = model;
  const expectedHeader: Record<string, unknown> = {
    ...modelHeader, net_price: expectedNet, vat_price: expectedVat, gross_price: expectedGross,
    // EUR base amounts mirror the totals; foreign ones are the preview's conversion.
    base_net_price: model.base_net_price ?? base?.net ?? expectedNet,
    base_vat_price: model.base_vat_price ?? base?.vat ?? expectedVat,
    base_gross_price: model.base_gross_price ?? base?.gross ?? expectedGross,
    // The create payload never sends payment_type: its first readback is the baseline, which draftFingerprint binds
    // at confirm, so a later change is draft_changed. A model that did send one is compared exactly.
    payment_type: (modelHeader as Record<string, unknown>).payment_type ?? draft.payment_type,
  };
  const fields = recordMismatches(expectedHeader, draftHeader as Record<string, unknown>, READBACK_HEADER_ALLOWED_TO_DIFFER,
    (key) => READBACK_HEADER_DEFAULTS[key] ?? []);

  const items = draftItems ?? [];
  if (items.length !== expectedItems.length) return [...fields, "items"];
  const rate = model.currency_rate ?? 1;
  expectedItems.map(applyPurchaseItemStructuralDefaults).forEach((item, index) => {
    const { net, vat } = amounts[index]!;
    const expected: Record<string, unknown> = {
      ...item, total_net_price: net, vat_amount: vat,
      vat_rate: item.vat_rate ?? parseVatRateDropdown(item.vat_rate_dropdown),
      base_total_net_price: item.base_total_net_price ?? roundMoney(net / rate),
    };
    // Not sent: the API leaves it empty or echoes the predicted value (live 2026-10-18: unit_net_price reads back null).
    const defaults = (field: string) => (field === "project_no_vat_gross_price" ? [roundMoney(net + vat)]
      : field === "unit_net_price" ? [roundMoney(net / (item.amount ?? 1))] : []);
    const actual = items[index] as unknown as Record<string, unknown>;
    for (const key of recordMismatches(expected, actual, READBACK_ITEM_ALLOWED_TO_DIFFER, defaults)) fields.push(`items[${index}].${key}`);
  });
  return fields;
}

/** Booking fingerprint keys a corrected reading field may change; everything else must equal the reviewed booking. */
const BOOKING_KEYS_BY_CORRECTED_FIELD: Partial<Record<string, readonly string[]>> = {
  invoice_number: ["invoice_number"],
  invoice_date: ["invoice_date", "journal_date", "term_days"],
  due_date: ["term_days"],
  supplier_iban: ["bank_account_no"],
};

/**
 * §5.2 step 3: the booking recomputed at create against the one the owner reviewed at verify. Accounts, VAT account
 * and article, dimensions, item titles, liability account, supplier name and amounts must be identical; only the
 * keys a corrected number, date or IBAN derive may differ. An owner-corrected amount is drift too: the reviewed
 * booking showed other amounts, so the owner verifies again (a false hold, never a write nobody reviewed).
 */
export function bookingDrift(reviewed: PlanRecord, recomputed: PlanRecord, correctedFields: readonly string[]): boolean {
  const allowed = new Set(correctedFields.flatMap((field) => BOOKING_KEYS_BY_CORRECTED_FIELD[field] ?? []));
  const strip = (record: PlanRecord) => Object.fromEntries(Object.entries(record).filter(([key]) => !allowed.has(key)));
  return canonicalPlanJson(strip(reviewed)) !== canonicalPlanJson(strip(recomputed));
}

export interface CreateReadingInput {
  source: FileInputSource;
  snapshot?: FileInputSnapshot;
  planHandle: string;
  ownerAnswers: unknown;
  /** The MCP client's name (clientInfo.name), for the audit (§5.6). */
  clientName?: string;
}

export type CreateReadingResult =
  | { status: "held"; holds: ReadingHold[] }
  | {
      status: "created";
      createdInvoiceId: number;
      documentUploaded: true;
      correctedFields: string[];
      /** Absent when the fresh draft read failed or differs from the approved model: the owner checks it in e-arveldaja. */
      confirmPlan?: { planHandle: string; invoiceId: number };
      /** Fields of the read-back draft that differ from the approved write model (no confirm handle then). */
      readbackMismatch?: string[];
    };

export interface ConfirmReadingInput { planHandle: string; invoiceId: number; clientName?: string }
export type ConfirmReadingResult =
  | { status: "held"; holds: ReadingHold[] }
  | { status: "confirmed"; confirmedInvoiceId: number; supplierName: string; gross: number | null; currency: string };

class ReadingDocumentOperations {
  /** Handles this instance issued (create and confirm route on them; consume still checks the domain and scope). */
  private readonly handles = new Set<string>();
  /** §5.2a per-connection in-process lock: a promise chain per connection fingerprint. */
  private readonly locks = new Map<string, Promise<void>>();
  /** §5.2a pending markers per connection fingerprint. */
  private readonly markers = new Map<string, IndeterminateMarker[]>();
  /** Connections where the owner released a marker: their verify scans stay uncached, so a late commit is seen. */
  private readonly releasedConnections = new Set<string>();

  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

  /** True for a reading-domain create or confirm handle this instance issued and has not yet seen consumed. */
  ownsHandle(handle: string | undefined): boolean {
    return handle !== undefined && this.handles.has(handle);
  }

  private connectionKey(): string {
    const scope = this.runtimeSafetyContext.getActiveScope();
    return scope.connectionFingerprint ?? `index:${scope.connectionIndex}`;
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** True while a pending marker on the active connection was made for this exact file; the prepare path refuses it. */
  hasPendingMarkerForSource(sourceSha256: string): boolean {
    return (this.markers.get(this.connectionKey()) ?? []).some((marker) => marker.sourceSha256 === sourceSha256);
  }

  private matchingMarker(key: string, match: Partial<MarkerKey>): IndeterminateMarker | undefined {
    return (this.markers.get(key) ?? []).find((marker) => markerMatches(marker, match));
  }

  private addMarker(key: string, marker: Omit<IndeterminateMarker, "id">): IndeterminateMarker {
    const entry = { ...marker, id: randomBytes(8).toString("hex") };
    this.markers.set(key, [...(this.markers.get(key) ?? []), entry]);
    return entry;
  }

  /** The owner's explicit release of one marker (§5.2a): logged; nothing else ever removes a marker. */
  private releaseMarker(key: string, id: string): boolean {
    const entries = this.markers.get(key) ?? [];
    const remaining = entries.filter((marker) => marker.id !== id);
    if (remaining.length === entries.length) return false;
    if (remaining.length > 0) this.markers.set(key, remaining); else this.markers.delete(key);
    logAudit({
      tool: "process_accounting_document", action: "RELEASED", entity_type: "purchase_invoice",
      summary: `Owner released indeterminate-create marker ${id}`,
      details: { reading_path: true, indeterminate_marker: id },
    });
    return true;
  }

  private async parseSource(source: FileInputSource, provided?: FileInputSnapshot): Promise<ReadingParse> {
    const snapshot = await loadSnapshot(source, this.runtimeSafetyContext, provided);
    const material = await materializeSnapshot(snapshot, source, this.runtimeSafetyContext);
    try {
      const parsed = await parseDocument(material.path);
      const packet = buildReadingPacket(packetInputFromParse(parsed, material.source_sha256, READING_PARSER_VERSION));
      return { material, snapshot, parsed, packet };
    } catch (error) {
      await material.cleanup();
      throw error;
    }
  }

  /** mode='read': the packet for the client's reader. Heuristic values and supplier resolution are withheld. */
  async read(input: ReadDocumentInput): Promise<OperationOutcome<ReadDocumentResult>> {
    const { material, packet } = await this.parseSource(input.source, input.snapshot);
    try {
      const packetHolds = packet.holds.map((hold) => hold.code);
      const blocked = packetHolds.some((code) => !NON_BLOCKING_PACKET_HOLDS.includes(code));
      return ok({
        sourceSha256: packet.source_sha256,
        packetDigest: packet.packet_digest,
        packetHolds,
        ...(blocked ? {} : { packetText: packet.lines.map(renderPacketLine).join("\n") }),
      });
    } finally {
      await material.cleanup();
    }
  }

  /** mode='verify': the checker, binding and duplicate set; a create handle only when nothing holds. */
  async verify(input: VerifyDocumentInput): Promise<OperationOutcome<VerifyDocumentResult>> {
    const key = this.connectionKey();
    if (input.releaseIndeterminate !== undefined && !(this.markers.get(key) ?? []).some((marker) => marker.id === input.releaseIndeterminate)) {
      return fail("indeterminate_marker_unknown", "No pending indeterminate-create marker has that id on this connection.", "never");
    }
    // Uncached while a marker is pending or was released on this connection: a late-committed draft must be seen.
    const uncached = input.releaseIndeterminate !== undefined || this.markers.has(key) || this.releasedConnections.has(key);
    const { material, snapshot, parsed, packet } = await this.parseSource(input.source, input.snapshot);
    try {
      // The release is bound to the exact file whose create was indeterminate, and the releasing call issues no handle.
      if (input.releaseIndeterminate !== undefined) {
        const target = (this.markers.get(key) ?? []).find((entry) => entry.id === input.releaseIndeterminate);
        if (!target || target.sourceSha256 !== packet.source_sha256) {
          return fail("indeterminate_marker_other_document", "That marker was made for a different file; release it with the file whose create was indeterminate.", "never");
        }
        this.releaseMarker(key, target.id);
        this.releasedConnections.add(key);
        return ok({ status: "blocked", sourceSha256: packet.source_sha256, packetDigest: packet.packet_digest, holds: [], releasedMarker: target.id });
      }
      const allClients = await this.api.clients.listAll().catch(() => "unavailable" as const);
      const own = await readingOwnIdentity(this.api, allClients === "unavailable" ? [] : allClients);
      const heuristic = readingHeuristic(parsed, material.fileName, own);
      const readingInput = desandboxAllStrings(input.reading);
      const proofInput = desandboxAllStrings(input.proof);
      const check: CheckResult = checkReading(packet, readingInput, proofInput, {
        today: todayInTallinn(),
        own: own?.ownCompanyRegistryCode || own?.ownCompanyVat
          ? { ...(own.ownCompanyRegistryCode ? { reg: own.ownCompanyRegistryCode } : {}), ...(own.ownCompanyVat ? { vat: own.ownCompanyVat } : {}) }
          : "unavailable",
        heuristic: heuristic.view,
        isReverseChargeText: detectReverseChargeFromText,
      });
      const holds: ReadingHold[] = check.holds.map(holdOf);
      const base: Pick<VerifyDocumentResult, "sourceSha256" | "packetDigest"> = { sourceSha256: packet.source_sha256, packetDigest: packet.packet_digest };
      const parsedReading = parseDocumentReading(readingInput);
      if (!parsedReading.ok) return ok({ status: "blocked", ...base, holds });
      const { source_sha256: _sha, packet_digest: _digest, evidence: _evidence, computed: _computed, ...values } = parsedReading.value;

      // Supplier: the unique live client of an accepted strong id.
      const candidates = supplierCandidates(values, allClients);
      holds.push(...candidates.holds.map(holdOf));
      const supplierView = candidates.candidates.length === 1 ? candidates.candidates[0]! : undefined;
      const supplierClient = supplierView && allClients !== "unavailable" ? allClients.find((client) => client.id === supplierView.id) : undefined;

      // Union keys (§3.6): the heuristic's own supplier resolution and number join the reading's.
      const heuristicResolution = allClients === "unavailable" ? undefined : resolveSupplierDefault(allClients, {
        supplier_name: heuristic.extracted.supplier_name,
        supplier_reg_code: heuristic.extracted.supplier_reg_code,
        supplier_vat_no: heuristic.extracted.supplier_vat_no,
        supplier_iban: heuristic.extracted.supplier_iban,
      }, { ownCompanyVat: own?.ownCompanyVat, ownCompanyRegistryCode: own?.ownCompanyRegistryCode });
      const heuristicKeys = {
        invoiceNumber: heuristic.extracted.invoice_number ?? null,
        supplierClientId: heuristicResolution?.status === "resolved" ? heuristicResolution.value.client.id ?? null : null,
      };
      holds.push(...(await readingDuplicateHolds(this.api, values, supplierClient?.id, heuristicKeys, { uncached })).map(holdOf));

      const ownCompany = { name: own?.ownCompanyName ?? null, reg: own?.ownCompanyRegistryCode ?? null, vat: own?.ownCompanyVat ?? null };
      let booking: ReadingBookingResult | undefined;
      let itemsSource: ReadingItemsSource | undefined;
      let isVatReg = false;
      let knownIban: string | undefined;
      if (supplierClient?.id !== undefined) {
        isVatReg = await isCompanyVatRegistered(this.api);
        knownIban = sameIban(values.supplier_iban, supplierClient.bank_account_no) ? values.supplier_iban ?? undefined : undefined;
        itemsSource = await resolveItemsSource(this.api, supplierClient.id, input.booking);
        // A gross the owner still has to type cannot be booked yet: the booking is computed at create.
        if (itemsSource && values.gross !== null) {
          booking = await buildReadingBooking(this.api, values, supplierClient.id, itemsSource, input.booking, material, isVatReg, knownIban);
          if (booking.view) {
            const binding = checkBookingBinding(values, booking.view, {
              vatRegistered: isVatReg,
              vatZeroNoteProven: check.vat_zero_note_proven,
              reverseChargeNotePresent: check.reverse_charge_note_present,
              supplierCountry: supplierClient.cl_code_country ?? null,
              bookingSideSignals: booking.bookingSideSignals,
              supplierKnownIbans: supplierClient.bank_account_no ? [supplierClient.bank_account_no] : [],
              supplierCandidateIds: candidates.candidates.map((candidate) => candidate.id!),
            });
            holds.push(...binding.holds.map(holdOf));
          }
        }
      }
      const marker = this.matchingMarker(key, {
        supplierClientId: supplierClient?.id, invoiceNumber: values.invoice_number, gross: values.gross, invoiceDate: values.invoice_date, sourceSha256: packet.source_sha256,
      });
      if (marker) holds.push({ code: "reading_create_indeterminate" });

      const cardOutcome = supplierClient?.id !== undefined
        ? buildReadingCard({
            packet,
            values,
            evidence: parsedReading.value.evidence,
            holds,
            noteCount: check.notes?.length ?? 0,
            heuristic: heuristic.view,
            supplier: { clientId: supplierClient.id, name: supplierClient.name },
            company: ownCompany,
          })
        : undefined;
      const result: VerifyDocumentResult = {
        status: "blocked",
        ...base,
        holds: cardOutcome && !cardOutcome.blocked ? [] : cardOutcome?.blockHolds ?? holds,
        values,
        ...(supplierClient?.id !== undefined ? { supplier: { clientId: supplierClient.id, name: supplierClient.name } } : {}),
        ...(booking?.effective ? { booking: booking.effective.fingerprint } : {}),
        ...(supplierClient?.id !== undefined && !itemsSource ? { bookingItemsRequired: true as const } : {}),
        ...(marker ? { indeterminateMarker: marker.id } : {}),
      };
      const itemTitleRequired = itemsSource !== undefined && "template" in itemsSource && input.booking?.itemTitle === undefined &&
        itemTitleHasDate(itemsSource.template.custom_title);
      if (booking?.failure) return fail(booking.failure.code, booking.failure.message, "never");
      if (!cardOutcome || cardOutcome.blocked || !itemsSource || supplierClient?.id === undefined) return ok(result);
      // A booking the owner has not seen is never created: no gross, no booking review, no handle.
      if (!booking?.effective) {
        return ok(values.gross === null ? { ...result, holds: [{ code: "required_field_missing", field: "gross" }] } : result);
      }
      // A dated history title would land on this document unchanged: no handle until the client gives item_title.
      if (itemTitleRequired) return ok({ ...result, itemTitleRequired: true });
      const card = cardOutcome.card;

      const scope = this.runtimeSafetyContext.getActiveScope();
      const planned: ReadingPlan = {
        source_sha256: packet.source_sha256,
        packet_digest: packet.packet_digest,
        file_name: material.fileName,
        values: values as unknown as PlanRecord,
        card: card as unknown as PlanRecord,
        supplier_client_id: supplierClient.id,
        items_source: itemsSource as unknown as PlanRecord,
        booking_input: {
          ...(input.booking?.liabilityAccountsId !== undefined ? { liabilityAccountsId: input.booking.liabilityAccountsId } : {}),
          ...(input.booking?.journalDate !== undefined ? { journalDate: input.booking.journalDate } : {}),
          ...(input.booking?.termDays !== undefined ? { termDays: input.booking.termDays } : {}),
          ...(input.booking?.itemTitle !== undefined ? { itemTitle: input.booking.itemTitle } : {}),
        },
        booking: booking.effective.fingerprint,
        heuristic_keys: heuristicKeys,
        vat_zero_note_proven: check.vat_zero_note_proven,
        reverse_charge_note_present: check.reverse_charge_note_present,
        connection_fingerprint: scope.connectionFingerprint ?? null,
        own: ownCompany,
      };
      const planHandle = this.runtimeSafetyContext.planStore.issue(READING_PLAN_DOMAIN, {
        normalizedArgs: planned as unknown as PlanRecord,
        sourceIdentities: [{ ...snapshot.identity } as unknown as PlanRecord],
        liveSnapshot: { source_sha256: packet.source_sha256, packet_digest: packet.packet_digest },
        commands: [
          { id: "reading-document-create", category: "purchase_invoice_create", reviewProjection: booking.effective.fingerprint },
          { id: "reading-document-upload", category: "purchase_invoice_upload", reviewProjection: { file_name: material.fileName, source_sha256: material.source_sha256 } },
        ],
        counts: { rows: card.rows.length },
        totals: values.gross !== null ? { gross_price: values.gross } : {},
        exclusions: [],
        reviews: [],
        privatePayload: { source_sha256: packet.source_sha256 },
      });
      this.handles.add(planHandle);
      return ok({ ...result, status: "ready", card, planHandle });
    } finally {
      await material.cleanup();
    }
  }

  /** mode='create' on a reading-domain handle (§5.2 step 3, §5.2a): owner answers, every re-check, one write. */
  async create(input: CreateReadingInput): Promise<OperationOutcome<CreateReadingResult>> {
    this.handles.delete(input.planHandle);
    let stored;
    try {
      stored = this.runtimeSafetyContext.planStore.consume(input.planHandle, READING_PLAN_DOMAIN);
    } catch (error) {
      return fail((error as { code?: string }).code ?? "plan_handle_invalid", "The reviewed reading plan could not be consumed.", "never");
    }
    const plan = stored.normalizedArgs as unknown as ReadingPlan;
    const key = this.connectionKey();
    if ((this.runtimeSafetyContext.getActiveScope().connectionFingerprint ?? null) !== plan.connection_fingerprint) {
      return fail("plan_scope_mismatch", "The active connection is not the one the reading was verified on.", "never");
    }
    const snapshot = await loadSnapshot(input.source, this.runtimeSafetyContext, input.snapshot);
    if (snapshot.identity.digest_sha256 !== plan.source_sha256) {
      return fail("digest_mismatch", "The document no longer matches the verified source bytes.", "never");
    }
    try {
      assertFileInputSnapshotIdentity(snapshot, stored.sourceIdentities[0], { allowedExtensions: INVOICE_DOCUMENT_EXTENSIONS, maxSize: MAX_INVOICE_DOCUMENT_SIZE });
    } catch (error) {
      if (!(error instanceof FileInputSnapshotError)) throw error;
      return fail("plan_drift", "The document file (bytes or location) no longer matches the verified reading. Run mode='verify' again.", "never");
    }

    const card = plan.card as unknown as ReadingCard;
    const original = plan.values as unknown as AcceptedValues;
    const answered = applyOwnerAnswers(card, original, input.ownerAnswers ?? {});
    if (!answered.ok) {
      const message = answered.code === "owner_declined"
        ? "The owner answered no or neither: nothing is created on this path. Book the document with mode='prepare' instead."
        : `owner_answers must answer every card row exactly once in its format; rows: ${answered.rows.join(", ")}.`;
      return fail(answered.code, message, "never");
    }
    const final = answered.values;

    // The owner identity the reading was verified (and any company-expense answer given) for.
    const clients = await this.api.clients.listAll().catch(() => "unavailable" as const);
    const own = await readingOwnIdentity(this.api, clients === "unavailable" ? [] : clients);
    if ((own?.ownCompanyRegistryCode ?? null) !== plan.own.reg || (own?.ownCompanyVat ?? null) !== plan.own.vat) {
      return fail(answered.buyerAttested ? "buyer_attestation_mismatch" : "plan_drift",
        "The active company identity differs from the one the reading was verified for. Run mode='verify' again.", "never");
    }

    return this.withLock(key, async () => {
      const material = await materializeSnapshot(snapshot, input.source, this.runtimeSafetyContext);
      try {
        const parsed = await parseDocument(material.path);
        const packet = buildReadingPacket(packetInputFromParse(parsed, material.source_sha256, READING_PARSER_VERSION));
        if (packet.packet_digest !== plan.packet_digest) return ok<CreateReadingResult>({ status: "held", holds: [{ code: "packet_changed" }] });

        const holds: ReadingHold[] = [];
        if (this.matchingMarker(key, { supplierClientId: plan.supplier_client_id, invoiceNumber: final.invoice_number, gross: final.gross, invoiceDate: final.invoice_date, sourceSha256: plan.source_sha256 })) {
          holds.push({ code: "reading_create_indeterminate" });
        }
        holds.push(...recheckFinalValues(final, { today: todayInTallinn(), vatZeroNoteProven: plan.vat_zero_note_proven, original }));

        // The supplier the final values bind must still be the one verified.
        const candidates = supplierCandidates(final, clients);
        holds.push(...candidates.holds.map(holdOf));
        const supplierClient = clients === "unavailable" ? undefined : clients.find((client) => client.id === plan.supplier_client_id);
        if (candidates.candidates.length !== 1 || candidates.candidates[0]!.id !== plan.supplier_client_id || !supplierClient) {
          holds.push({ code: "booking_field_mismatch", field: "clients_id" });
        }
        const wrongCompany = await wrongCompanySignal(this.api, material.path, material.fileName);
        if (wrongCompany) holds.push({ code: wrongCompany });

        let booking: ReadingBookingResult | undefined;
        let isVatReg = false;
        if (supplierClient) {
          isVatReg = await isCompanyVatRegistered(this.api);
          const knownIban = sameIban(final.supplier_iban, supplierClient.bank_account_no) ? final.supplier_iban ?? undefined : undefined;
          booking = await buildReadingBooking(this.api, final, plan.supplier_client_id, plan.items_source as unknown as ReadingItemsSource,
            plan.booking_input as Omit<ReadingBookingInput, "items">, material, isVatReg, knownIban);
          if (booking.failure) return fail(booking.failure.code, booking.failure.message, "never");
          const binding = checkBookingBinding(final, booking.view!, {
            vatRegistered: isVatReg,
            vatZeroNoteProven: plan.vat_zero_note_proven,
            reverseChargeNotePresent: plan.reverse_charge_note_present,
            supplierCountry: supplierClient.cl_code_country ?? null,
            bookingSideSignals: booking.bookingSideSignals,
            supplierKnownIbans: supplierClient.bank_account_no ? [supplierClient.bank_account_no] : [],
            supplierCandidateIds: candidates.candidates.map((candidate) => candidate.id!),
          });
          holds.push(...binding.holds.map(holdOf));
        }
        // Every §3.6 scan on the final values with every list cache dropped; journal references fail closed.
        holds.push(...(await readingDuplicateHolds(this.api, final, plan.supplier_client_id, plan.heuristic_keys, { uncached: true })).map(holdOf));
        if (booking?.effective && bookingDrift(plan.booking, booking.effective.fingerprint, answered.correctedFields)) {
          holds.push({ code: "reading_booking_drift" });
        }
        if (holds.length > 0 || !booking?.effective) return ok<CreateReadingResult>({ status: "held", holds });

        const { invoiceData } = booking.effective;
        let created;
        try {
          created = await this.api.purchaseInvoices.createAndSetTotals(invoiceData, booking.vatPrice, booking.grossPrice, isVatReg, booking.effective.accounts);
        } catch (error: unknown) {
          if (error instanceof InvoiceCreationError) {
            return fail("invoice_creation_failed", error.message, "never", { mutationOccurred: true, mutatedObjects: [{ type: "purchase_invoice", id: error.invoiceId }] });
          }
          if (isAmbiguousPostCreateFailure(error)) {
            const marker = this.addMarker(key, {
              supplierClientId: plan.supplier_client_id, invoiceNumber: final.invoice_number, gross: final.gross, invoiceDate: final.invoice_date, sourceSha256: plan.source_sha256,
            });
            return fail("reading_create_indeterminate",
              `The create request's outcome is unknown: the invoice may still be created. Check e-arveldaja; matching documents are held until mode='verify' finds the draft or the owner releases marker ${marker.id}.`,
              "never");
          }
          throw error;
        }
        if (!created.id) {
          this.addMarker(key, {
            supplierClientId: plan.supplier_client_id, invoiceNumber: final.invoice_number, gross: final.gross, invoiceDate: final.invoice_date, sourceSha256: plan.source_sha256,
          });
          return fail("invoice_id_missing", "Purchase invoice was created but no invoice ID was returned.", "never", { mutationOccurred: true });
        }
        const uploadFailure = await uploadSourceDocumentOrInvalidate(this.api, created.id, material.fileName, material.contentsBase64);
        if (uploadFailure !== undefined) {
          return fail("document_upload_failed", uploadFailure, "never", { mutationOccurred: true, mutatedObjects: [{ type: "purchase_invoice", id: created.id }] });
        }
        logAudit({
          tool: "process_accounting_document", action: "CREATED", entity_type: "purchase_invoice", entity_id: created.id,
          summary: `Created purchase invoice "${invoiceData.number}" from a verified reading`,
          details: {
            reading_path: true,
            corrected_fields: answered.correctedFields,
            buyer_attested_by_owner: answered.buyerAttested,
            ...(answered.buyerAttested ? { buyer_attested_company_reg: plan.own.reg } : {}),
            text_layer_typed: answered.textLayerTyped,
            source_sha256: plan.source_sha256,
            packet_digest: plan.packet_digest,
            supplier_name: invoiceData.client_name,
            invoice_number: invoiceData.number,
            invoice_date: invoiceData.create_date,
            total_gross: booking.grossPrice,
            file_name: material.fileName,
            client_name: input.clientName ?? null,
          },
        });

        // §5.5: the confirm handle binds the draft as read back fresh, not as requested.
        let confirmPlan: { planHandle: string; invoiceId: number } | undefined;
        let readbackMismatch: string[] | undefined;
        try {
          this.api.purchaseInvoices.invalidateListCache();
          const draft = await this.api.purchaseInvoices.get(created.id);
          const mismatches = draftReadbackMismatches(draft, invoiceData, booking, isVatReg, booking.effective.accounts);
          if (mismatches.length > 0) {
            readbackMismatch = mismatches;
            throw new Error("draft_readback_mismatch");
          }
          const planHandle = this.runtimeSafetyContext.planStore.issue(READING_CONFIRM_DOMAIN, {
            normalizedArgs: {
              invoice_id: created.id,
              draft_fingerprint: draftFingerprint(draft),
              connection_fingerprint: plan.connection_fingerprint,
              heuristic_keys: plan.heuristic_keys,
            },
            sourceIdentities: [],
            liveSnapshot: { invoice_id: created.id },
            commands: [{ id: "reading-document-confirm", category: "purchase_invoice_confirm", reviewProjection: { invoice_id: created.id } }],
            counts: {},
            totals: {},
            exclusions: [],
            reviews: [],
            privatePayload: { invoice_id: created.id },
          });
          this.handles.add(planHandle);
          confirmPlan = { planHandle, invoiceId: created.id };
        } catch {
          confirmPlan = undefined;
        }
        return ok<CreateReadingResult>({
          status: "created",
          createdInvoiceId: created.id,
          documentUploaded: true,
          correctedFields: answered.correctedFields,
          ...(confirmPlan ? { confirmPlan } : {}),
          ...(readbackMismatch ? { readbackMismatch } : {}),
        });
      } finally {
        await material.cleanup();
      }
    });
  }

  /** mode='confirm' on a reading-domain confirm handle (§5.5): the draft must be exactly the one created. */
  async confirm(input: ConfirmReadingInput): Promise<OperationOutcome<ConfirmReadingResult>> {
    this.handles.delete(input.planHandle);
    let stored;
    try {
      stored = this.runtimeSafetyContext.planStore.consume(input.planHandle, READING_CONFIRM_DOMAIN);
    } catch (error) {
      return fail((error as { code?: string }).code ?? "plan_handle_invalid", "The reviewed confirm plan could not be consumed.", "never");
    }
    const plan = stored.normalizedArgs as { invoice_id: number; draft_fingerprint: string; connection_fingerprint: string | null; heuristic_keys: ReadingPlan["heuristic_keys"] };
    if (plan.invoice_id !== input.invoiceId) return fail("plan_drift", "The reviewed confirm plan no longer matches the requested invoice_id.", "never");
    if ((this.runtimeSafetyContext.getActiveScope().connectionFingerprint ?? null) !== plan.connection_fingerprint) {
      return fail("plan_scope_mismatch", "The active connection is not the one the draft was created on.", "never");
    }
    return this.withLock(this.connectionKey(), async () => {
      this.api.purchaseInvoices.invalidateListCache();
      const draft = await this.api.purchaseInvoices.get(input.invoiceId);
      if (draft.status !== "PROJECT" || draftFingerprint(draft) !== plan.draft_fingerprint) {
        return fail<ConfirmReadingResult>("draft_changed", "The draft changed after it was created and reviewed; it is not registered. Review it in e-arveldaja.", "never");
      }
      const holds = await readingDuplicateHolds(this.api, {
        invoice_number: draft.number, gross: draft.gross_price ?? null, invoice_date: draft.create_date, currency: draft.cl_currencies_id,
      }, draft.clients_id, plan.heuristic_keys, { uncached: true, excludeInvoiceId: input.invoiceId });
      if (holds.length > 0) return ok<ConfirmReadingResult>({ status: "held", holds: holds.map(holdOf) });
      // The scans take time: read the draft once more right before registering it.
      this.api.purchaseInvoices.invalidateListCache();
      const latest = await this.api.purchaseInvoices.get(input.invoiceId);
      if (latest.status !== "PROJECT" || draftFingerprint(latest) !== plan.draft_fingerprint) {
        return fail<ConfirmReadingResult>("draft_changed", "The draft changed after it was created and reviewed; it is not registered. Review it in e-arveldaja.", "never");
      }
      // GitHub #63 (P4): a non-VAT draft carrying a VAT account registers only when the proof accepts it on a fresh chart.
      if ((latest.items ?? []).some(hasVatAccountFields) && !(await isCompanyVatRegistered(this.api))) {
        const refusal = nonVatRegisterRefusal(latest, await this.api.readonly.getAccounts({ fresh: true }));
        if (refusal !== undefined) {
          return fail<ConfirmReadingResult>("nonvat_form_unproven",
            `The draft is not registered: its VAT-account rows are not a proven non-deductible form (${refusal}). Review it in e-arveldaja.`, "never");
        }
      }

      await this.api.purchaseInvoices.confirm(input.invoiceId);
      logAudit({
        tool: "process_accounting_document", action: "CONFIRMED", entity_type: "purchase_invoice", entity_id: input.invoiceId,
        summary: `Confirmed purchase invoice ${input.invoiceId} from a verified reading`,
        details: { reading_path: true, draft_fingerprint_verified: true, client_name: input.clientName ?? null },
      });
      return ok<ConfirmReadingResult>({
        status: "confirmed",
        confirmedInvoiceId: input.invoiceId,
        supplierName: desandboxText(draft.client_name),
        gross: draft.gross_price ?? null,
        currency: draft.cl_currencies_id,
      });
    });
  }
}

export type ReadingOperations = ReadingDocumentOperations;

export function createReadingDocumentOperations(api: ApiContext, runtimeSafetyContext: RuntimeSafetyContext): ReadingOperations {
  return new ReadingDocumentOperations(api, runtimeSafetyContext);
}
