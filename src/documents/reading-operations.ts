// P2 D: the verified-draft document-reading path of process_accounting_document
// (plan .omc/plans/p2-verified-draft.md §5). Consumer code only: the packet, the
// checker and the binding are the frozen src/document-reading-*.ts modules
// (tag p2-checker-freeze); this module feeds them live data and never changes a
// value they accept or hold on.
//
// Calls: read (packet) → verify (checkReading + supplier/booking binding + the
// full §3.6 duplicate set + journal references) → create → confirm.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { plainFailureOutcome as fail, plainSuccessOutcome as ok, type OperationOutcome } from "../operation-outcome.js";
import type { PlanRecord } from "../plan-store.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { FileInputSnapshot, FileInputSource } from "../file-input-snapshot.js";
import { parseDocument, type ParsedDocument } from "../document-parser.js";
import { blankLeaderLines, buildLostValueCrops, defaultLostValueSeam, type BlankLeaderProof, lostValueRects, ocrLostValueLine, type LostValueCrops, type LostValueSeam } from "./lost-value-ocr.js";
import { LOST_VALUE_FIELDS, matchLostValue, parseLostValueReading, type LostValueField, type LostValueReason } from "../document-reading-lost-value.js";
import { buildReadingPacket, normalizeForMatch, packetLostLeaders, renderPacketLine, type PacketHoldCode, type ReadingPacket } from "../document-reading-packet.js";
import { printedPaymentReference } from "../document-reading-reference.js";
import {
  checkReading,
  labelledHeuristicValues,
  rateMatches,
  ratesDeferredForLostDate,
  type AcceptedValues,
  type CheckContext,
  type CheckResult,
  type HeuristicView,
  type HoldCode,
} from "../document-reading-check.js";
import { parseDocumentReading, parseProof, type ReadingField } from "../document-reading-schemas.js";
import {
  checkBookingBinding,
  duplicateHolds,
  duplicateKeys,
  supplierCandidates,
  type BindingHold,
  type BookingField,
  type BookingView,
} from "../document-reading-binding.js";
import { readingPacketOf } from "../tools/document-text-hazards.js";
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
import { computeBookingSuggestion, textItemsWithPageNums, type BookingSuggestionCore } from "../tools/pdf-workflow.js";
import { isCompanyVatRegistered } from "../tools/crud-tools.js";
import { resolveSupplierDefault } from "../resolution/supplier-default-resolution.js";
import { detectDuplicatePurchaseInvoice } from "../tools/document-audit.js";
import { findInvoiceNumberMatchesAnySupplier } from "../tools/receipt-inbox-matching.js";
import { checkJournalReferences } from "../journal-reference-scan.js";
import { checkIntakeCashDuplicates } from "../bank-posting-duplicate-guard.js";
import { normalizeItemsForNonVat, predictPurchaseItemAmounts, previewPurchaseInvoiceTotals } from "../api/purchase-invoices.api.js";
import {
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
import {
  allowedForSource,
  applyOwnerAnswers,
  buildReadingCard,
  checkSubstituted,
  recheckFinalValues,
  recheckReading,
  type CardHold,
  type CardHoldCode,
  type ImageAgreedField,
  type ReadingCard,
  type RecheckFieldSource,
} from "../document-reading-card.js";
import { draftFingerprint, draftReadbackMismatches } from "./purchase-draft-verification.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { withPurchaseInvoiceLock } from "./purchase-invoice-lock.js";
export { draftFingerprint, draftReadbackMismatches } from "./purchase-draft-verification.js";

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
  /** text_layer_value_lost only: PNG crops of the lost-leader rows, in packet order (untrusted pixels). */
  lostValueImages?: Array<{ line: string; png: Buffer }>;
  /** Set instead of lostValueImages when the crops exceed the size caps. */
  lostValueImagesOmitted?: "over_budget";
}

export interface VerifyDocumentInput {
  source: FileInputSource;
  snapshot?: FileInputSnapshot;
  reading: unknown;
  proof: unknown;
  booking?: ReadingBookingInput;
  /** §5.2a: the owner's explicit release of an indeterminate-create marker, by its id. */
  releaseIndeterminate?: string;
  /** Lost-value image path: the client's transcription of the read crops ({invoice_date?, invoice_number?: {line, printed}}). */
  lostValueReading?: unknown;
}

/** One submitted lost value and what became of it (diagnostics, not hold codes). */
export interface LostValueStatus {
  field?: LostValueField;
  line?: string;
  /** The client's transcription (untrusted: wrapped at the tool boundary). */
  printed?: string;
  status: "image_ocr_agreed" | LostValueReason | "lost_value_reading_invalid" | "checker_hold" | "number_still_lost";
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
  bookingNotes?: ReadingBookingNotes;
  dimensionChoiceRequired?: BookingSuggestionCore["dimension_conflicts"];
  /** Set when the server could not suggest booking items: the client repeats verify with `items`. */
  bookingItemsRequired?: true;
  /** Set when the history template's item title carries a date or names goods this document does not print: the client repeats verify with `item_title`. */
  itemTitleRequired?: true;
  itemTitleReason?: "dated" | "not_printed";
  /** The packet prints several distinct valid payment references: none is bound (counted as a card minor note). */
  paymentReferenceNote?: string;
  /** The owner card (present when nothing blocks). */
  card?: ReadingCard;
  /** The date was lost: no booking is built until the owner types it; this is what create will book (DeferredBookingBasis). */
  bookingBasis?: DeferredBookingBasis;
  /** §5.2a: an earlier create of a matching document may still complete; the owner checks e-arveldaja, then releases it. */
  indeterminateMarker?: string;
  /** The marker the owner released in this call; no handle is issued until verify runs again. */
  releasedMarker?: string;
  /** Present when lost_value_reading was given: per submitted field, agreed or why not. */
  lostValues?: LostValueStatus[];
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
  /** The booking the owner reviewed (computed on the reading's values); null when the date was lost (booking_basis). */
  booking: PlanRecord | null;
  /** Present when `booking` is null: what the owner saw instead; create's booking must match it. */
  booking_basis?: DeferredBookingBasis;
  booking_notes: ReadingBookingNotes;
  heuristic_keys: { invoiceNumber: string | null; supplierClientId: number | null };
  vat_zero_note_proven: boolean;
  reverse_charge_note_present: boolean;
  connection_fingerprint: string | null;
  own: { name: string | null; reg: string | null; vat: string | null };
  /** The parsed reading and proof (canonical JSON): create re-runs the whole checker on them with the final values. */
  reading_json: string;
  proof_json: string;
  /**
   * Every checker hold at verify. The card released all of them (a block code issues no handle); create drops a
   * re-run hold that repeats one of these only when its code is not a block code.
   */
  check_holds: ReadingHold[];
  /** Lost-value fields the client read from the crop image and server OCR agreed with (each has a confirm row). */
  image_agreed?: ImageAgreedField[];
  /** Leader lines proven blank at verify: create's proof must give exactly these, else the card is stale. */
  blank_leader_lines?: string[];
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

/** The checker's context for the active company; verify and the create-time re-run build it the same way. */
function readingCheckContext(own: OwnCompanyIdentifiers | undefined, heuristic: HeuristicView): CheckContext {
  return {
    today: todayInTallinn(),
    own: own?.ownCompanyRegistryCode || own?.ownCompanyVat
      ? { ...(own.ownCompanyRegistryCode ? { reg: own.ownCompanyRegistryCode } : {}), ...(own.ownCompanyVat ? { vat: own.ownCompanyVat } : {}) }
      : "unavailable",
    heuristic,
    isReverseChargeText: detectReverseChargeFromText,
  };
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
function suggestedItemTemplate(suggestion: BookingSuggestionCore): PurchaseInvoiceItem | undefined {
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

/** Generic title words that say nothing about the goods. */
const TITLE_GENERIC_WORDS: ReadonlySet<string> = new Set(["teenus", "teenused", "arve", "kulu", "kulud", "tasu", "eest"]);
const titleWords = (text: string): string[] => text.normalize("NFC").toLocaleLowerCase("et").split(/[^\p{L}\p{M}\p{N}]+/u).filter((word) => word.length > 0);

/**
 * Whether two words are the same word in another Estonian inflection: equal, or sharing a prefix of at least 5
 * characters that leaves at most 1 character of the shorter (pakiautomaat / pakiautomaadi) and at most 3 of the
 * longer (koolitus / koolitusele); arvutitarvikud / arvutitark do not match.
 */
export function titleWordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prefix = 0;
  while (prefix < short.length && short[prefix] === long[prefix]) prefix += 1;
  return prefix >= 5 && short.length - prefix <= 1 && long.length - prefix <= 3;
}

/**
 * Live 2026-10-28 (Arvutitark 447292): a history title naming other goods (Logitech mouse, UGREEN charger) would land
 * on a document printing a LogiLink headset. True when the title has at least two specific words (4+ characters,
 * generic words excluded) and the packet prints none of them, in any inflection.
 */
export function historyTitleNotPrinted(title: string | undefined, packet: Pick<ReadingPacket, "lines">): boolean {
  if (title === undefined) return false;
  const specific = [...new Set(titleWords(title).filter((word) => word.length >= 4 && !TITLE_GENERIC_WORDS.has(word)))];
  if (specific.length < 2) return false;
  const printed = [...new Set(packet.lines.flatMap((line) => titleWords(normalizeForMatch(line.text))))];
  return !specific.some((word) => printed.some((candidate) => titleWordsMatch(word, candidate)));
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

export type ReadingBookingNotes = Pick<BookingSuggestionCore, "tax_notes" | "dimension_notes" | "history_notes">;
function decisionNotes(suggestion: BookingSuggestionCore): ReadingBookingNotes {
  return { tax_notes: suggestion.tax_notes, dimension_notes: suggestion.dimension_notes, history_notes: suggestion.history_notes };
}
function currentDescription(input: ReadingBookingInput | undefined): string | undefined {
  const items = input?.items === undefined ? [] : parsePurchaseInvoiceItems(input.items);
  return [input?.itemTitle, ...items.map(item => item.custom_title)].filter(Boolean).join("\n") || undefined;
}
function requiredDimensionChoices(suggestion: BookingSuggestionCore, source: ReadingItemsSource | undefined): BookingSuggestionCore["dimension_conflicts"] {
  if (!source || "items" in source) return [];
  return suggestion.dimension_conflicts.filter(conflict => source.template[
    conflict.dimension_field === "purchase_accounts_dimensions_id" ? "purchase_accounts_id" : "vat_accounts_id"
  ] === conflict.account_id);
}

/** The caller's items, else the supplier's one-item history template; undefined when the server has nothing to suggest. */
export async function resolveItemsSource(api: ApiContext, supplierClientId: number, input: ReadingBookingInput | undefined, suggestion?: BookingSuggestionCore): Promise<ReadingItemsSource | undefined> {
  if (input?.items !== undefined) return { items: input.items };
  const template = suggestedItemTemplate(suggestion ?? await computeBookingSuggestion(api, { clients_id: supplierClientId, description: currentDescription(input) }));
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
  /** The payment reference the packet prints (printedPaymentReference); never a client argument. */
  paymentReference: string | undefined,
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
    ...(paymentReference !== undefined ? { refNumber: paymentReference } : {}),
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

/**
 * Step 0 (lost-value plan): what verify shows and binds when the date was lost. No booking is built without a date
 * (the VAT rate, the non-VAT form, the journal date and the term derive from it), so the owner sees every other
 * value the draft writes: supplier, VAT status, liability account, bank account, reference and notes, and per item
 * the title, cost account and dimension, purchase article, net amount and (VAT-registered) the template's or the
 * caller's VAT account, VAT dimension, VAT article and reverse-charge id. Create builds the booking on the typed date
 * and holds reading_booking_drift when any of these differs. A VAT account, VAT dimension or VAT article the
 * template or items leave empty (null here) is filled at create from the purchase-article defaults for the rate in
 * force on the typed date; the created result returns the whole booking for review before confirm.
 */
export interface DeferredBookingBasis {
  supplier_name: string;
  vat_registered: boolean;
  liability_accounts_id: number;
  bank_account_no: string | null;
  ref_number: string | null;
  notes: string | null;
  items: DeferredBasisItem[];
  gross_price: number | null;
  /** The invoice VAT for a VAT-registered company; null for a non-VAT one (its form derives from the date). */
  vat_price: number | null;
}

export interface DeferredBasisItem {
  custom_title: string | null;
  purchase_accounts_id: number | null;
  purchase_accounts_dimensions_id: number | null;
  cl_purchase_articles_id: number | null;
  total_net_price: number | null;
  /** The VAT side, VAT-registered only (null otherwise: the non-VAT form derives from the date). */
  vat_accounts_id: number | null;
  vat_accounts_dimensions_id: number | null;
  cl_vat_articles_id: number | null;
  reversed_vat_id: number | null;
}

/** The VAT-side keys a null basis value leaves to the create-time purchase-article defaults. */
const DEFAULTED_VAT_KEYS = ["vat_accounts_id", "vat_accounts_dimensions_id", "cl_vat_articles_id"] as const;

const basisItem = (item: PurchaseInvoiceItem, isVatReg: boolean): DeferredBasisItem => ({
  custom_title: item.custom_title ?? null,
  purchase_accounts_id: item.purchase_accounts_id ?? null,
  purchase_accounts_dimensions_id: item.purchase_accounts_dimensions_id ?? null,
  cl_purchase_articles_id: item.cl_purchase_articles_id ?? null,
  total_net_price: item.total_net_price ?? null,
  vat_accounts_id: isVatReg ? item.vat_accounts_id ?? null : null,
  vat_accounts_dimensions_id: isVatReg ? item.vat_accounts_dimensions_id ?? null : null,
  cl_vat_articles_id: isVatReg ? item.cl_vat_articles_id ?? null : null,
  reversed_vat_id: isVatReg ? item.reversed_vat_id ?? null : null,
});

function deferredBookingBasis(source: ReadingItemsSource, input: ReadingBookingInput | undefined, supplierName: string, isVatReg: boolean, values: AcceptedValues, knownIban: string | undefined, paymentReference: string | undefined): DeferredBookingBasis {
  // The template's net comes from the values, exactly as itemWithAmounts sets it.
  const items = "items" in source ? parsePurchaseInvoiceItems(source.items)
    : [{
        ...source.template,
        ...(input?.itemTitle !== undefined ? { custom_title: input.itemTitle } : {}),
        total_net_price: values.net ?? round2((values.gross ?? 0) - (values.vat ?? 0)),
      }];
  return {
    supplier_name: supplierName,
    vat_registered: isVatReg,
    liability_accounts_id: input?.liabilityAccountsId ?? DEFAULT_LIABILITY_ACCOUNT,
    bank_account_no: knownIban ? desandboxText(knownIban) : null,
    ref_number: paymentReference ?? null,
    notes: null,
    items: (desandboxAllStrings(items) as PurchaseInvoiceItem[]).map((item) => basisItem(item, isVatReg)),
    gross_price: values.gross,
    vat_price: isVatReg ? values.vat ?? 0 : null,
  };
}

/**
 * True when the booking computed at create differs from the basis the owner saw at verify. A corrected supplier IBAN
 * may change the bank account (as in bookingDrift); a null VAT account, VAT dimension or VAT article may be filled.
 */
export function deferredBookingDrift(basis: DeferredBookingBasis, fingerprint: PlanRecord, correctedFields: readonly string[] = []): boolean {
  const vatRegistered = fingerprint.vat_registered === true;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const items = ((fingerprint.items ?? []) as unknown as PurchaseInvoiceItem[]).map((item, index) => {
    const recomputed = basisItem(item, vatRegistered);
    const shown = basis.items[index];
    if (shown) for (const key of DEFAULTED_VAT_KEYS) if (shown[key] === null) recomputed[key] = null;
    return recomputed;
  });
  const recomputed: DeferredBookingBasis = {
    supplier_name: String(fingerprint.supplier_name),
    vat_registered: vatRegistered,
    liability_accounts_id: Number(fingerprint.liability_accounts_id),
    bank_account_no: correctedFields.includes("supplier_iban") ? basis.bank_account_no : text(fingerprint.bank_account_no),
    ref_number: text(fingerprint.ref_number),
    notes: text(fingerprint.notes),
    items,
    gross_price: typeof fingerprint.gross_price === "number" ? fingerprint.gross_price : null,
    vat_price: vatRegistered ? (typeof fingerprint.vat_price === "number" ? fingerprint.vat_price : null) : null,
  };
  return canonicalPlanJson(basis) !== canonicalPlanJson(recomputed);
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
      /** The date was lost at verify: the booking create computed on the owner's date (review it before confirm). */
      bookingComputedAtCreate?: PlanRecord;
    };

export interface ConfirmReadingInput { planHandle: string; invoiceId: number; clientName?: string }
export type ConfirmReadingResult =
  | { status: "held"; holds: ReadingHold[] }
  | { status: "confirmed"; confirmedInvoiceId: number; supplierName: string; gross: number | null; currency: string };

class ReadingDocumentOperations {
  /** Handles this instance issued (create and confirm route on them; consume still checks the domain and scope). */
  private readonly handles = new Set<string>();
  /** §5.2a pending markers per connection fingerprint. */
  private readonly markers = new Map<string, IndeterminateMarker[]>();
  /** Connections where the owner released a marker: their verify scans stay uncached, so a late commit is seen. */
  private readonly releasedConnections = new Set<string>();

  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
    private readonly lostValueSeam: LostValueSeam = defaultLostValueSeam,
    /** Signature-line proof run on every packet build; default the same seam. */
    private readonly proveBlank: BlankLeaderProof = (path, parsed, packet) => blankLeaderLines(path, parsed, packet, lostValueSeam),
  ) {}

  /** True for a reading-domain create or confirm handle this instance issued and has not yet seen consumed. */
  ownsHandle(handle: string | undefined): boolean {
    return handle !== undefined && this.handles.has(handle);
  }

  private connectionKey(): string {
    const scope = this.runtimeSafetyContext.getActiveScope();
    return scope.connectionFingerprint ?? `index:${scope.connectionIndex}`;
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
      const packet = await readingPacketOf(parsed, material.path, material.source_sha256, READING_PARSER_VERSION, this.proveBlank);
      return { material, snapshot, parsed, packet };
    } catch (error) {
      await material.cleanup();
      throw error;
    }
  }

  /** mode='read': the packet for the client's reader. Heuristic values and supplier resolution are withheld. */
  async read(input: ReadDocumentInput): Promise<OperationOutcome<ReadDocumentResult>> {
    const { material, parsed, packet } = await this.parseSource(input.source, input.snapshot);
    try {
      const packetHolds = packet.holds.map((hold) => hold.code);
      const blocked = packetHolds.some((code) => !NON_BLOCKING_PACKET_HOLDS.includes(code));
      let lostValue: LostValueCrops = { images: [] };
      if (!blocked && packetHolds.includes("text_layer_value_lost")) {
        // Any failure sends no image: the owner types the value, as without this path.
        lostValue = await buildLostValueCrops(material.path, parsed, packet, this.lostValueSeam).catch(() => ({ images: [] }));
      }
      return ok({
        sourceSha256: packet.source_sha256,
        packetDigest: packet.packet_digest,
        packetHolds,
        ...(blocked ? {} : { packetText: packet.lines.map(renderPacketLine).join("\n") }),
        ...("omitted" in lostValue ? { lostValueImagesOmitted: lostValue.omitted }
          : lostValue.images.length > 0 ? { lostValueImages: lostValue.images } : {}),
      });
    } finally {
      await material.cleanup();
    }
  }

  /**
   * The lost-value image path at verify (plan Step 4). Per submitted field: the reading left it null, the checker
   * held nothing on it but required_field_missing, the cited line is a lost-leader line no other field cites, the
   * re-made crop's OCR agrees (matchLostValue). Then the whole checker runs again with the agreed values (no
   * evidence for them); a field that draws any hold beyond the image_agreed allow-list is dropped and the pass
   * repeats. OCR never supplies a value: an agreed value is the client's own transcription.
   */
  private async resolveLostValues(raw: unknown, ctx: {
    packet: ReadingPacket;
    parsed: ParsedDocument;
    filePath: string;
    check: CheckResult;
    reading: Record<string, unknown> & { evidence: unknown };
    proofInput: unknown;
    values: AcceptedValues;
    checkContext: CheckContext;
  }): Promise<{ statuses: LostValueStatus[]; agreed: ImageAgreedField[]; values: AcceptedValues; check: CheckResult; holds: CheckResult["holds"] }> {
    const none = { agreed: [], values: ctx.values, check: ctx.check, holds: [] };
    const parsedInput = parseLostValueReading(desandboxAllStrings(raw));
    if (!parsedInput.ok) return { ...none, statuses: [{ status: "lost_value_reading_invalid" }] };
    const submitted = LOST_VALUE_FIELDS.flatMap((field) => {
      const entry = parsedInput.value[field];
      return entry ? [{ field, line: entry.line, printed: entry.printed }] : [];
    });
    const statuses = new Map<LostValueField, LostValueStatus>();
    const done = (entry: { field: LostValueField; line: string; printed: string }, status: LostValueStatus["status"]) =>
      statuses.set(entry.field, { field: entry.field, line: entry.line, printed: entry.printed, status });
    const lost = new Set(packetLostLeaders(ctx.packet).map((hit) => hit.line));
    const lineUses = new Map<string, number>();
    for (const entry of submitted) lineUses.set(entry.line, (lineUses.get(entry.line) ?? 0) + 1);
    const available = (() => { try { return this.lostValueSeam.available(); } catch { return false; } })();
    const rects = available
      ? await lostValueRects(ctx.filePath, ctx.parsed, ctx.packet).catch(() => new Map())
      : new Map();
    const rendered = new Map<number, Promise<{ png: Buffer; width: number; height: number }>>();
    const candidates = new Map<LostValueField, { entry: { field: LostValueField; line: string; printed: string }; value: string }>();
    for (const entry of submitted) {
      if (ctx.values[entry.field] !== null) { done(entry, "reading_value_present"); continue; }
      // A null field also draws the proof codes of its empty answer (no label quote); nothing else may hold on it.
      if (ctx.check.holds.some((hold) => hold.field === entry.field && hold.code !== "required_field_missing" &&
        !allowedForSource(hold, { [entry.field]: "image_agreed" }))) { done(entry, "field_has_other_holds"); continue; }
      if (!lost.has(entry.line)) { done(entry, "line_not_lost"); continue; }
      if ((lineUses.get(entry.line) ?? 0) > 1) { done(entry, "line_reused"); continue; }
      if (!available) { done(entry, "ocr_unavailable"); continue; }
      const ocr = await ocrLostValueLine(ctx.filePath, ctx.parsed, rects, entry.line, this.lostValueSeam, rendered);
      if (!ocr.ok) { done(entry, ocr.reason); continue; }
      const match = matchLostValue(entry.field, entry.printed, ocr.items, ocr.anchor);
      if (match.status !== "image_ocr_agreed") { done(entry, match.status); continue; }
      candidates.set(entry.field, { entry, value: match.value });
    }

    const proof = parseProof(ctx.proofInput);
    const firstPass = new Set(ctx.check.holds.map((hold) => `${hold.code}\u0000${hold.field ?? ""}`));
    while (candidates.size > 0) {
      const sources: Partial<Record<ReadingField, RecheckFieldSource>> =
        Object.fromEntries([...candidates.keys()].map((field) => [field, "image_agreed" as const]));
      const values = { ...ctx.values, ...Object.fromEntries([...candidates].map(([field, { value }]) => [field, value])) } as AcceptedValues;
      const check = proof.ok ? checkSubstituted(ctx.packet, ctx.reading, proof.value as unknown as Record<string, unknown>, values, sources, ctx.checkContext) : undefined;
      if (!check) {
        for (const { entry } of candidates.values()) done(entry, "checker_hold");
        break;
      }
      const holds = check.holds.filter((hold) => !allowedForSource(hold, sources));
      // A hold the first pass did not raise comes from an agreed value: drop the field it names, or every agreed
      // field when it names another one (a date that implies a different VAT rate, a document-level hold).
      const fresh = holds.filter((hold) => !firstPass.has(`${hold.code}\u0000${hold.field ?? ""}`));
      const named = [...candidates.keys()].filter((field) => fresh.some((hold) => hold.field === field));
      const conflicted = named.length > 0 ? named : fresh.length > 0 ? [...candidates.keys()] : [];
      // A date alone would end the lost-date deferral while the number stays unknown, and the booking binding then
      // holds the whole document: keep both typed instead.
      if (conflicted.length === 0 && candidates.has("invoice_date") && values.invoice_number === null) {
        done(candidates.get("invoice_date")!.entry, "number_still_lost");
        candidates.delete("invoice_date");
        continue;
      }
      if (conflicted.length === 0) {
        for (const { entry } of candidates.values()) done(entry, "image_ocr_agreed");
        return {
          statuses: submitted.map((entry) => statuses.get(entry.field)!),
          agreed: [...candidates.values()].map(({ entry }) => ({ field: entry.field, line: entry.line, printed: entry.printed })),
          values,
          check,
          holds,
        };
      }
      for (const field of conflicted) {
        done(candidates.get(field)!.entry, "checker_hold");
        candidates.delete(field);
      }
    }
    return { ...none, statuses: submitted.map((entry) => statuses.get(entry.field)!) };
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
      const checkContext = readingCheckContext(own, heuristic.view);
      let check: CheckResult = checkReading(packet, readingInput, proofInput, checkContext);
      let holds: ReadingHold[] = check.holds.map(holdOf);
      const base: Pick<VerifyDocumentResult, "sourceSha256" | "packetDigest"> = { sourceSha256: packet.source_sha256, packetDigest: packet.packet_digest };
      const parsedReading = parseDocumentReading(readingInput);
      if (!parsedReading.ok) return ok({ status: "blocked", ...base, holds });
      const { source_sha256: _sha, packet_digest: _digest, evidence: _evidence, computed: _computed, ...readValues } = parsedReading.value;
      let values: AcceptedValues = readValues;

      // Lost-value image path: a value the client read from a crop counts only when server OCR of the same crop
      // agrees and a second checker pass on it holds nothing beyond the missing evidence (plan Step 4, MAJOR-2).
      let lostValues: LostValueStatus[] | undefined;
      let imageAgreed: ImageAgreedField[] = [];
      if (input.lostValueReading !== undefined) {
        const resolved = await this.resolveLostValues(input.lostValueReading, {
          packet, parsed, filePath: material.path, check, reading: parsedReading.value, proofInput, values, checkContext,
        });
        lostValues = resolved.statuses;
        if (resolved.agreed.length > 0) {
          imageAgreed = resolved.agreed;
          values = resolved.values;
          check = resolved.check;
          holds = resolved.holds.map(holdOf);
        }
      }

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
      let bookingNotes: ReadingBookingNotes | undefined;
      let dimensionChoiceRequired: BookingSuggestionCore["dimension_conflicts"] = [];
      const bookingDeferred = ratesDeferredForLostDate(packet, values.invoice_date);
      // The printed payment reference (viitenumber) is bound into the booking; several distinct ones bind nothing.
      const reference = printedPaymentReference(packet);
      const paymentReference = reference && "value" in reference ? reference.value : undefined;
      const paymentReferenceNote = reference && "ambiguous" in reference
        ? `payment reference not bound: ${reference.ambiguous.length} distinct values printed` : undefined;
      if (supplierClient?.id !== undefined) {
        isVatReg = await isCompanyVatRegistered(this.api);
        knownIban = sameIban(values.supplier_iban, supplierClient.bank_account_no) ? values.supplier_iban ?? undefined : undefined;
        const suggestion = await computeBookingSuggestion(this.api, { clients_id: supplierClient.id, description: currentDescription(input.booking) });
        bookingNotes = decisionNotes(suggestion);
        itemsSource = await resolveItemsSource(this.api, supplierClient.id, input.booking, suggestion);
        dimensionChoiceRequired = requiredDimensionChoices(suggestion, itemsSource);
        if (dimensionChoiceRequired.length) holds.push({ code: "reading_dimension_choice_required" });
        // A gross the owner still has to type cannot be booked yet, and a lost date leaves the VAT rate, the non-VAT
        // form, the journal date and the term unknown: no booking is built or bound at verify (Step 0).
        if (itemsSource && values.gross !== null && !bookingDeferred) {
          booking = await buildReadingBooking(this.api, values, supplierClient.id, itemsSource, input.booking, material, isVatReg, knownIban, paymentReference);
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
            noteCount: (check.notes?.length ?? 0) + (paymentReferenceNote !== undefined ? 1 : 0),
            heuristic: heuristic.view,
            supplier: { clientId: supplierClient.id, name: supplierClient.name },
            company: ownCompany,
            ...(imageAgreed.length > 0 ? { imageAgreed } : {}),
          })
        : undefined;
      const result: VerifyDocumentResult = {
        status: "blocked",
        ...base,
        holds: cardOutcome && !cardOutcome.blocked ? [] : cardOutcome?.blockHolds ?? holds,
        values,
        ...(supplierClient?.id !== undefined ? { supplier: { clientId: supplierClient.id, name: supplierClient.name } } : {}),
        ...(booking?.effective ? { booking: booking.effective.fingerprint } : {}),
        ...(bookingNotes ? { bookingNotes } : {}),
        ...(dimensionChoiceRequired.length ? { dimensionChoiceRequired } : {}),
        ...(supplierClient?.id !== undefined && (!itemsSource || dimensionChoiceRequired.length) ? { bookingItemsRequired: true as const } : {}),
        ...(paymentReferenceNote !== undefined ? { paymentReferenceNote } : {}),
        ...(marker ? { indeterminateMarker: marker.id } : {}),
        ...(lostValues ? { lostValues } : {}),
      };
      const itemTitleReason = itemsSource !== undefined && "template" in itemsSource && input.booking?.itemTitle === undefined
        ? itemTitleHasDate(itemsSource.template.custom_title) ? "dated" as const
          : historyTitleNotPrinted(itemsSource.template.custom_title, packet) ? "not_printed" as const : undefined
        : undefined;
      const itemTitleRequired = itemTitleReason !== undefined;
      if (booking?.failure) return fail(booking.failure.code, booking.failure.message, "never");
      if (!cardOutcome || cardOutcome.blocked || !itemsSource || supplierClient?.id === undefined) return ok(result);
      // A booking the owner has not seen is never created: no gross, no booking review, no handle.
      if (values.gross === null) return ok({ ...result, holds: [{ code: "required_field_missing", field: "gross" }] });
      // Lost date: the owner sees the booking basis instead, and create holds a booking that differs from it.
      let bookingBasis: DeferredBookingBasis | undefined;
      if (bookingDeferred) {
        // The supplier name as computeEffectiveBooking reads it; a failed read holds like the client list (nothing written).
        const supplierName = await this.api.clients.get(supplierClient.id).then((client) => desandboxText(client.name), () => undefined);
        if (supplierName === undefined) return ok({ ...result, holds: [{ code: "clients_unavailable" }] });
        bookingBasis = deferredBookingBasis(itemsSource, input.booking, supplierName, isVatReg, values, knownIban, paymentReference);
      }
      if (!bookingBasis && !booking?.effective) return ok(result);
      // A dated history title would land on this document unchanged: no handle until the client gives item_title.
      if (itemTitleRequired) return ok({ ...result, itemTitleRequired: true, itemTitleReason });
      const card = cardOutcome.card;
      const parsedProof = parseProof(proofInput);
      if (!parsedProof.ok) return ok({ ...result, holds: [{ code: "proof_schema_invalid" }] });

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
        booking: booking?.effective?.fingerprint ?? null,
        ...(bookingBasis ? { booking_basis: bookingBasis } : {}),
        booking_notes: bookingNotes!,
        heuristic_keys: heuristicKeys,
        vat_zero_note_proven: check.vat_zero_note_proven,
        reverse_charge_note_present: check.reverse_charge_note_present,
        connection_fingerprint: scope.connectionFingerprint ?? null,
        own: ownCompany,
        reading_json: canonicalPlanJson(parsedReading.value),
        proof_json: canonicalPlanJson(parsedProof.value),
        check_holds: check.holds.map(holdOf),
        ...(imageAgreed.length > 0 ? { image_agreed: imageAgreed } : {}),
        ...(packet.blank_leader_lines?.length ? { blank_leader_lines: packet.blank_leader_lines } : {}),
      };
      const planHandle = this.runtimeSafetyContext.planStore.issue(READING_PLAN_DOMAIN, {
        normalizedArgs: planned as unknown as PlanRecord,
        sourceIdentities: [{ ...snapshot.identity } as unknown as PlanRecord],
        liveSnapshot: { source_sha256: packet.source_sha256, packet_digest: packet.packet_digest },
        commands: [
          { id: "reading-document-create", category: "purchase_invoice_create", reviewProjection: { ...(bookingBasis ? bookingBasis as unknown as PlanRecord : booking!.effective!.fingerprint), decision_notes: bookingNotes as unknown as PlanRecord } },
          { id: "reading-document-upload", category: "purchase_invoice_upload", reviewProjection: { file_name: material.fileName, source_sha256: material.source_sha256 } },
        ],
        counts: { rows: card.rows.length },
        totals: values.gross !== null ? { gross_price: values.gross } : {},
        exclusions: [],
        reviews: [],
        privatePayload: { source_sha256: packet.source_sha256 },
      });
      this.handles.add(planHandle);
      return ok({ ...result, status: "ready", card, planHandle, ...(bookingBasis ? { bookingBasis } : {}) });
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

    return withPurchaseInvoiceLock(this.api, async () => {
      const material = await materializeSnapshot(snapshot, input.source, this.runtimeSafetyContext);
      try {
        const parsed = await parseDocument(material.path);
        const packet = await readingPacketOf(parsed, material.path, material.source_sha256, READING_PARSER_VERSION, this.proveBlank);
        if (packet.packet_digest !== plan.packet_digest) return ok<CreateReadingResult>({ status: "held", holds: [{ code: "packet_changed" }] });
        // The digest leaves out the blank proof: a different blank set means other lost rows than the card was built on.
        if ((packet.blank_leader_lines ?? []).join("\n") !== (plan.blank_leader_lines ?? []).join("\n")) {
          return ok<CreateReadingResult>({ status: "held", holds: [{ code: "packet_changed" }] });
        }

        const holds: ReadingHold[] = [];
        if (this.matchingMarker(key, { supplierClientId: plan.supplier_client_id, invoiceNumber: final.invoice_number, gross: final.gross, invoiceDate: final.invoice_date, sourceSha256: plan.source_sha256 })) {
          holds.push({ code: "reading_create_indeterminate" });
        }
        holds.push(...recheckFinalValues(final, { today: todayInTallinn(), vatZeroNoteProven: plan.vat_zero_note_proven, original }));
        // Step 0: the whole checker on the bound reading with the final values; recheckFinalValues stays as well.
        const rerun = recheckReading({
          packet,
          readingJson: plan.reading_json,
          proofJson: plan.proof_json,
          final,
          sources: {
            ...Object.fromEntries((plan.image_agreed ?? []).map((entry) => [entry.field, "image_agreed" as const])),
            ...Object.fromEntries(answered.correctedFields.map((field) => [field, "owner_supplied" as const])),
          },
          releasedHolds: Array.isArray(plan.check_holds) ? plan.check_holds : [],
          ctx: readingCheckContext(own, readingHeuristic(parsed, material.fileName, own).view),
        });
        holds.push(...rerun);

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
          this.api.purchaseInvoices.invalidateListCache();
          const source = plan.items_source as unknown as ReadingItemsSource;
          const bookingInput = plan.booking_input as Omit<ReadingBookingInput, "items">;
          const suggestion = await computeBookingSuggestion(this.api, {
            clients_id: plan.supplier_client_id,
            description: currentDescription({ ...bookingInput, items: "items" in source ? source.items : [source.template] }),
          });
          if (canonicalPlanJson(decisionNotes(suggestion)) !== canonicalPlanJson(plan.booking_notes) || requiredDimensionChoices(suggestion, source).length) {
            holds.push({ code: "reading_booking_drift" });
          }
          isVatReg = await isCompanyVatRegistered(this.api);
          const knownIban = sameIban(final.supplier_iban, supplierClient.bank_account_no) ? final.supplier_iban ?? undefined : undefined;
          const reference = printedPaymentReference(packet);
          booking = await buildReadingBooking(this.api, final, plan.supplier_client_id, plan.items_source as unknown as ReadingItemsSource,
            plan.booking_input as Omit<ReadingBookingInput, "items">, material, isVatReg, knownIban, reference && "value" in reference ? reference.value : undefined);
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
        if (booking?.effective && (plan.booking === null
          ? plan.booking_basis === undefined || deferredBookingDrift(plan.booking_basis, booking.effective.fingerprint, answered.correctedFields)
          : bookingDrift(plan.booking, booking.effective.fingerprint, answered.correctedFields))) {
          holds.push({ code: "reading_booking_drift" });
        }
        if (holds.length > 0 || !booking?.effective) {
          // The re-run repeats some of the targeted checks: report each code and field once.
          const unique = [...new Map(holds.map((hold) => [`${hold.code}\u0000${hold.field ?? ""}`, hold])).values()];
          return ok<CreateReadingResult>({ status: "held", holds: unique });
        }

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
              "never", { mutationMayHaveOccurred: true });
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
            ...(card.rows.some((row) => row.id === "r:invoice_number" && row.kind === "field_review" && row.codes.includes("text_layer_value_lost") &&
              !(plan.image_agreed ?? []).some((entry) => entry.field === "invoice_number") && !answered.correctedFields.includes("invoice_number"))
              ? { text_layer_number_kept_under_label: true } : {}),
            ...(plan.image_agreed?.length ? {
              image_ocr_agreed_fields: plan.image_agreed.map((entry) => entry.field).filter((field) => !answered.correctedFields.includes(field)),
            } : {}),
            ...(packet.blank_leader_lines?.length ? { blank_leader_lines: packet.blank_leader_lines } : {}),
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
          ...(plan.booking === null ? { bookingComputedAtCreate: booking.effective.fingerprint } : {}),
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
    return withPurchaseInvoiceLock(this.api, async () => {
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

export function createReadingDocumentOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  lostValueSeam?: LostValueSeam,
  proveBlank?: BlankLeaderProof,
): ReadingOperations {
  return new ReadingDocumentOperations(api, runtimeSafetyContext, lostValueSeam, proveBlank);
}
