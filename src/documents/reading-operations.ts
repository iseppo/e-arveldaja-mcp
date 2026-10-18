// P2 D: the verified-draft document-reading path of process_accounting_document
// (plan .omc/plans/p2-verified-draft.md §5). Consumer code only: the packet, the
// checker and the binding are the frozen src/document-reading-*.ts modules
// (tag p2-checker-freeze); this module feeds them live data and never changes a
// value they accept or hold on.
//
// Calls: read (packet) → verify (checkReading + supplier/booking binding + the
// full §3.6 duplicate set + journal references) → create → confirm.

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
import { predictPurchaseItemAmounts, previewPurchaseInvoiceTotals } from "../api/purchase-invoices.api.js";
import { vatRatesInForceOn } from "../estonian-tax-rules.js";
import { desandboxAllStrings } from "../external-text-renderer.js";
import { todayInTallinn } from "../local-date.js";
import { parseStrictDate } from "../strict-date.js";
import type { Client, PurchaseInvoice, PurchaseInvoiceItem } from "../types/api.js";
import { computeEffectiveBooking, loadSnapshot, materializeSnapshot, type EffectiveBookingModel, type MaterializedSnapshot } from "./operations.js";
import type { AccountingDocumentBookingFields } from "./types.js";

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
export interface ReadingHold { code: HoldCode; field?: ReadingField | BookingField }

/** Booking inputs the reading cannot supply; the server suggests them from the supplier's history when omitted. */
export interface ReadingBookingInput {
  items?: unknown;
  liabilityAccountsId?: number;
  journalDate?: string;
  termDays?: number;
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
  planHandle?: string;
}

/** Packet holds that do not block the reading path (the owner types the lost values, §5.3). */
const NON_BLOCKING_PACKET_HOLDS: readonly PacketHoldCode[] = ["text_layer_value_lost"];

const holdOf = (hold: { code: HoldCode; field?: ReadingField | BookingField }): ReadingHold =>
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

/** One booking item of the template with the document's amounts: net, and the unique VAT rate in force. */
function itemWithAmounts(template: PurchaseInvoiceItem, values: AcceptedValues): PurchaseInvoiceItem {
  const vat = values.vat ?? 0;
  const gross = values.gross ?? 0;
  const net = values.net ?? round2(gross - vat);
  const rates = vat > 0 && values.invoice_date ? rateMatches(net, vat, vatRatesInForceOn(values.invoice_date)) : [];
  const vatRate = vat > 0 ? (rates.length === 1 ? String(rates[0]) : template.vat_rate_dropdown) : (template.vat_rate_dropdown ?? "0");
  return { ...template, total_net_price: net, amount: 1, ...(vatRate !== undefined && vatRate !== null ? { vat_rate_dropdown: vatRate } : {}) };
}

export interface ReadingBookingResult {
  effective?: EffectiveBookingModel;
  view?: BookingView;
  bookingSideSignals: string[];
  itemsRequired?: true;
  failure?: { code: string; message: string };
}

/** The write model for the values: the caller's items, else the server's one-item suggestion. */
export async function buildReadingBooking(
  api: ApiContext,
  values: AcceptedValues,
  supplierClientId: number,
  input: ReadingBookingInput | undefined,
  material: Pick<MaterializedSnapshot, "source_sha256" | "fileName">,
  isVatReg: boolean,
  knownIban: string | undefined,
): Promise<ReadingBookingResult> {
  let items: unknown = input?.items;
  if (items === undefined) {
    const template = await suggestedItemTemplate(api, supplierClientId);
    if (!template) return { bookingSideSignals: [], itemsRequired: true };
    items = [itemWithAmounts(template, values)];
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
    ...(isVatReg ? { vatPrice: values.vat ?? 0 } : {}),
    ...(values.gross !== null ? { grossPrice: values.gross } : {}),
    ...(input?.liabilityAccountsId !== undefined ? { liabilityAccountsId: input.liabilityAccountsId } : {}),
    ...(knownIban ? { bankAccountNo: knownIban } : {}),
  };
  const effective = await computeEffectiveBooking(api, fields, material.source_sha256, material.fileName);
  if (!effective.ok) return { bookingSideSignals: [], failure: { code: effective.error.code, message: effective.error.message } };
  const data = effective.value.invoiceData;
  const preview = previewPurchaseInvoiceTotals(data, fields.vatPrice, fields.grossPrice, isVatReg);
  const finalItems = preview.ok && preview.lastItemGross !== undefined && data.items.length > 0
    ? [...data.items.slice(0, -1), { ...data.items[data.items.length - 1]!, project_no_vat_gross_price: preview.lastItemGross }]
    : data.items;
  const amounts = predictPurchaseItemAmounts(finalItems);
  const bookingSideSignals: string[] = [];
  for (const entry of amounts) {
    if (entry.vat > 0 && rateMatches(entry.net, entry.vat, vatRatesInForceOn(invoiceDate)).length === 0) bookingSideSignals.push("vat_rate_implausible");
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
  return { effective: effective.value, view, bookingSideSignals };
}

class ReadingDocumentOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

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
    const { material, snapshot, parsed, packet } = await this.parseSource(input.source, input.snapshot);
    try {
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
      holds.push(...(await readingDuplicateHolds(this.api, values, supplierClient?.id, heuristicKeys, { uncached: false })).map(holdOf));

      let booking: ReadingBookingResult | undefined;
      if (supplierClient?.id !== undefined) {
        const isVatReg = await isCompanyVatRegistered(this.api);
        const knownIban = values.supplier_iban && supplierClient.bank_account_no &&
          supplierClient.bank_account_no.replace(/\s+/g, "").toUpperCase() === values.supplier_iban.replace(/\s+/g, "").toUpperCase()
          ? values.supplier_iban : undefined;
        booking = await buildReadingBooking(this.api, values, supplierClient.id, input.booking, material, isVatReg, knownIban);
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

      const result: VerifyDocumentResult = {
        status: "blocked",
        ...base,
        holds,
        values,
        ...(supplierClient?.id !== undefined ? { supplier: { clientId: supplierClient.id, name: supplierClient.name } } : {}),
        ...(booking?.effective ? { booking: booking.effective.fingerprint } : {}),
        ...(booking?.itemsRequired ? { bookingItemsRequired: true as const } : {}),
      };
      if (booking?.failure) return fail(booking.failure.code, booking.failure.message, "never");
      if (holds.length > 0 || !booking?.effective || supplierClient?.id === undefined) return ok(result);

      const scope = this.runtimeSafetyContext.getActiveScope();
      const planHandle = this.runtimeSafetyContext.planStore.issue(READING_PLAN_DOMAIN, {
        normalizedArgs: {
          source_sha256: packet.source_sha256,
          packet_digest: packet.packet_digest,
          values: values as unknown as PlanRecord,
          supplier_client_id: supplierClient.id,
          booking: booking.effective.fingerprint,
          connection_fingerprint: scope.connectionFingerprint ?? null,
          own: { reg: own?.ownCompanyRegistryCode ?? null, vat: own?.ownCompanyVat ?? null },
        },
        sourceIdentities: [{ ...snapshot.identity } as unknown as PlanRecord],
        liveSnapshot: { source_sha256: packet.source_sha256, packet_digest: packet.packet_digest },
        commands: [
          { id: "reading-document-create", category: "purchase_invoice_create", reviewProjection: booking.effective.fingerprint },
          { id: "reading-document-upload", category: "purchase_invoice_upload", reviewProjection: { file_name: material.fileName, source_sha256: material.source_sha256 } },
        ],
        counts: { holds: 0 },
        totals: values.gross !== null ? { gross_price: values.gross } : {},
        exclusions: [],
        reviews: [],
        privatePayload: { source_sha256: packet.source_sha256 },
      });
      return ok({ ...result, status: "ready", planHandle });
    } finally {
      await material.cleanup();
    }
  }
}

export type ReadingOperations = ReadingDocumentOperations;

export function createReadingDocumentOperations(api: ApiContext, runtimeSafetyContext: RuntimeSafetyContext): ReadingOperations {
  return new ReadingDocumentOperations(api, runtimeSafetyContext);
}
