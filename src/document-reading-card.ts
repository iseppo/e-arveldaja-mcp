// PURE module (P2 D2): the owner card of the verified-draft reading path.
// Plan: .omc/plans/p2-verified-draft.md §5.3–§5.4.
//
// Consumer of the frozen checker (src/document-reading-check.ts, tag
// p2-checker-freeze): it never changes a check. It gives every hold code a
// disposition, turns the released codes into owner rows (forced-choice
// questions, typed values, payload-field review rows), applies the owner's
// answers, and re-checks the values that depend on them. A typed value is
// owner_supplied: it never rewrites an extracted value, it replaces it with the
// owner's own reading of the PDF, and it is recorded as a corrected field.

import { checkReading, HOLD_CODES, rateMatches, type AcceptedValues, type CheckContext, type CheckResult, type HeuristicView, type HoldCode } from "./document-reading-check.js";
import type { ReadingPacket } from "./document-reading-packet.js";
import type { ReadingField } from "./document-reading-schemas.js";
import { lineTokens } from "./document-reading-tokens.js";
import { printedUnderLostLabel } from "./document-reading-lost-value.js";
import { BUYER_MARKER_RE, isForeignVatShape, isValidEeRegistryCode, isValidEeVatNumber, isValidIban, normalizeVatValue } from "./document-identifiers.js";
import { vatRatesInForceOn } from "./estonian-tax-rules.js";
import { isStrictDate } from "./strict-date.js";

/** Hold codes the reading path adds beyond the checker's (§5.4, rev. 2.1). */
export const READING_PATH_HOLD_CODES = ["buyer_attestation_mismatch", "reading_create_indeterminate", "reading_booking_drift", "reading_dimension_choice_required"] as const;
export type ReadingPathHoldCode = typeof READING_PATH_HOLD_CODES[number];
export type CardHoldCode = HoldCode | ReadingPathHoldCode;

export type Disposition = "block" | "question" | "typed" | "field_review";

const B = "block" as const;
const Q = "question" as const;
const T = "typed" as const;
const R = "field_review" as const;

/** Every hold code, explicitly (§5.4). Only question/typed/field_review codes are released, and only by owner answers. */
export const DISPOSITION = {
  // schema / digest
  reading_schema_invalid: B, proof_schema_invalid: B, computed_field: B, packet_changed: B,
  // packet / page / OCR
  packet_oversize: B, partial_parse_config: B, page_count_mismatch: B, page_extraction_failed: B,
  ocr_document: B, partial_ocr_failure: B, low_ocr_confidence: B, raw_text_missing: B,
  // amount structure
  arithmetic_mismatch: B, zero_vat_unproven: B, vat_rate_not_snapped: B, competitor_omitted: B,
  competitor_limit_exceeded: B, competing_consistent_total: B, mixed_vat_rate: B, trio_not_read: B,
  signed_amount_present: B, foreign_rate_trio: B, zero_total_stated: B,
  // identifiers and parties
  identifier_invalid: B, buyer_not_own: B, supplier_is_own: B, unaccounted_identifier: B,
  invoice_number_is_identifier: B, supplier_id_contradiction: B, supplier_id_missing: B, own_identity_unavailable: B,
  buyer_not_active_company: B, buyer_ambiguous: B, buyer_ownership_unverified: B, supplier_from_footer_block: B,
  supplier_identifier_ambiguous: B, supplier_identifier_echo_unconfirmed: B, self_vat_detected: B,
  self_reg_code_detected: B,
  // document kind and currency
  doc_type_not_bookable: B, credit_word_present: B, non_eur_currency: B, foreign_currency_marker: B,
  currency_not_stated: B, currency_equivalent_ambiguity: B, multiple_documents_in_file: B,
  duplicate_invoice_in_batch: B, invoice_date_out_of_window: B,
  // binding / booking
  clients_unavailable: B, supplier_not_client: B, supplier_ambiguous: B, booking_field_mismatch: B,
  currency_fields_refused: B, reading_reverse_charge_unverified: B, reading_reverse_charge_unbooked: B,
  booking_vat_rate_implausible: B,
  // duplicates
  duplicate_supplier_number: B, duplicate_same_amount_date: B, duplicate_voided_candidate: B,
  duplicate_number_any_supplier: B, journal_reference_hit: B, cash_duplicate_suspect: B,
  journal_reference_scan_unavailable: B,
  // forced-choice questions
  reading_heuristic_conflict: Q, ambiguous_amount_token: Q, ambiguous_slash_date: Q, buyer_id_missing: Q,
  // typed by the owner
  required_field_missing: T, text_layer_value_lost: T,
  // payload-field review rows
  missing_evidence: R, unknown_line: R, quote_not_printed: R, value_not_complete_token: R, proof_problem: R,
  label_quote_missing: R, label_quote_not_printed: R, label_quote_no_letter: R, label_quote_overlaps_value: R,
  competitor_not_printed: R, competitor_ambiguous: R, ocr_cited_text: R, cited_origin_unestablished: R,
  // reading path (rev. 2.1)
  buyer_attestation_mismatch: B, reading_create_indeterminate: B,
  // the booking recomputed at create differs from the reviewed one
  reading_booking_drift: B,
  reading_dimension_choice_required: B,
} as const satisfies Record<CardHoldCode, Disposition>;

/** Every code DISPOSITION must cover: the checker's codes and the reading path's own. */
export const ALL_CARD_HOLD_CODES: readonly CardHoldCode[] = [...(Object.keys(HOLD_CODES) as HoldCode[]), ...READING_PATH_HOLD_CODES];

/** The fields whose value is written to the invoice (§5.3). */
export const PAYLOAD_FIELDS = [
  "invoice_number", "invoice_date", "due_date", "net", "vat", "gross", "supplier_reg", "supplier_vat", "supplier_iban",
] as const;
export type PayloadField = typeof PAYLOAD_FIELDS[number];
const isPayloadField = (field: string | undefined): field is PayloadField => PAYLOAD_FIELDS.includes(field as PayloadField);

/** Non-payload fields whose evidence notes collapse into one count (§5.3). Buyer ids are not here: they prove the addressee. */
const COLLAPSIBLE_FIELDS: readonly ReadingField[] = ["supplier_name", "buyer_name", "doc_type", "currency"];

const AMOUNT_FIELDS = ["net", "vat", "gross"] as const;
const DATE_FIELDS = ["invoice_date", "due_date"] as const;
const isAmountField = (field: string): field is typeof AMOUNT_FIELDS[number] => AMOUNT_FIELDS.includes(field as never);
const isDateField = (field: string): field is typeof DATE_FIELDS[number] => DATE_FIELDS.includes(field as never);
/** Fields an owner may type (payload fields and the currency, which must be EUR). */
export type TypedField = PayloadField | "currency";

export interface CardHold { code: CardHoldCode; field?: string }

export interface CardOption { id: string; value?: string | number; stop?: true }
export type CardRow =
  | { id: string; kind: "question"; code: "reading_heuristic_conflict" | "ambiguous_amount_token" | "ambiguous_slash_date"; field: PayloadField; options: CardOption[]; line?: string }
  | { id: "buyer"; kind: "buyer_question"; company: { name: string | null; reg: string | null; vat: string | null }; lines: string[]; options: CardOption[] }
  | { id: string; kind: "typed"; field: TypedField; reason: "required_field_missing" | "text_layer_value_lost" | "unresolved_question" | "no_printed_token" }
  | { id: string; kind: "field_review"; field: PayloadField; codes: CardHoldCode[]; value: string | number; printed_token: string; line: string };

export interface ReadingCard {
  look_here: {
    gross: { value: number | null; line?: string };
    supplier: { client_id: number; name: string; line?: string };
  };
  rows: CardRow[];
  /** Notes on non-payload fields and same-value competitors, collapsed into one count. */
  minor_notes: number;
}

/** A lost-leader value the client read from the crop image and server OCR agreed with (lost-value plan Step 4). */
export interface ImageAgreedField {
  field: "invoice_date" | "invoice_number";
  /** The packet line whose crop showed it. */
  line: string;
  /** The value as the client transcribed it from the image. */
  printed: string;
}

export interface CardInput {
  packet: ReadingPacket;
  values: AcceptedValues;
  evidence: Partial<Record<string, { line: string; quote: string }>>;
  holds: readonly CardHold[];
  noteCount: number;
  heuristic: Pick<HeuristicView, "labelled">;
  supplier: { clientId: number; name: string };
  company: { name: string | null; reg: string | null; vat: string | null };
  /** Image-agreed fields: a mandatory confirm row each, instead of the typed row of a lost text layer. */
  imageAgreed?: readonly ImageAgreedField[];
}

export type CardOutcome = { blocked: true; blockHolds: CardHold[] } | { blocked: false; card: ReadingCard };

/** The holds that stop the reading path outright: block codes, and released codes that cannot form an owner row. */
export function blockingHolds(holds: readonly CardHold[]): CardHold[] {
  return holds.filter((hold) => {
    const disposition = DISPOSITION[hold.code];
    if (disposition === "block") return true;
    if (disposition === "field_review") {
      // A field-review code needs a payload field (an owner row) or a collapsible field (a note). Anything else,
      // including a buyer id whose evidence failed, stops: the buyer ids are what proves the addressee.
      return !(isPayloadField(hold.field) || COLLAPSIBLE_FIELDS.includes(hold.field as ReadingField));
    }
    if (disposition === "typed") {
      return hold.code === "required_field_missing" && !(isPayloadField(hold.field) || hold.field === "currency");
    }
    if (disposition === "question") return hold.code !== "buyer_id_missing" && !isPayloadField(hold.field);
    return false;
  });
}

const lineText = (packet: ReadingPacket, id: string | undefined) => (id === undefined ? undefined : packet.lines.find((line) => line.id === id));

/** The cited line's exact printed token for a value, or undefined (then the owner can only type it). */
function printedToken(packet: ReadingPacket, field: PayloadField, value: string | number, lineId: string | undefined): string | undefined {
  const line = lineText(packet, lineId);
  if (!line) return undefined;
  const tokens = lineTokens(line);
  if (isAmountField(field)) {
    const hits = tokens.money.filter((token) => (token.kind === "decimal" || token.kind === "integer") && token.values.some((v) => Math.abs(v - Number(value)) < 0.005));
    return hits.length === 1 ? hits[0]!.text : undefined;
  }
  if (isDateField(field)) {
    const hits = tokens.dates.filter((token) => !token.ambiguousSlash && token.values.includes(String(value)));
    return hits.length === 1 ? hits[0]!.text : undefined;
  }
  // A whole whitespace-delimited word equal to the value, nothing more (`AB1` is not printed in `AB1.234`).
  const words = line.text.split(/[\s¦]+/).map((word) => word.replace(/^[(#:]+/, "").replace(/[,;:)]+$/, ""));
  return words.includes(String(value)) ? String(value) : undefined;
}

function questionRow(input: CardInput, code: "reading_heuristic_conflict" | "ambiguous_amount_token" | "ambiguous_slash_date", field: PayloadField): CardRow | undefined {
  const value = input.values[field];
  const evidence = input.evidence[field];
  const line = lineText(input.packet, evidence?.line);
  const neither: CardOption = { id: "neither", stop: true };
  if (code === "reading_heuristic_conflict") {
    const other = input.heuristic.labelled[field as keyof HeuristicView["labelled"]];
    if (value === null || value === undefined || other === undefined) return undefined;
    const otherValue = isAmountField(field) ? Number(String(other).replace(",", ".")) : String(other);
    if (typeof otherValue === "number" && !Number.isFinite(otherValue)) return undefined;
    return {
      id: `q:${field}`, kind: "question", code, field,
      options: [{ id: "reader", value }, { id: "parser", value: otherValue }, neither],
      ...(line ? { line: line.text } : {}),
    };
  }
  if (!line || value === null || value === undefined) return undefined;
  const tokens = lineTokens(line);
  const readings = code === "ambiguous_amount_token"
    ? [...new Set(tokens.money.filter((token) => token.values.length > 1 && token.values.some((v) => Math.abs(v - Number(value)) < 0.005)).flatMap((token) => token.values))]
    : [...new Set(tokens.dates.filter((token) => token.ambiguousSlash && token.values.includes(String(value))).flatMap((token) => token.values))];
  if (readings.length < 2) return undefined;
  return {
    id: `q:${field}`, kind: "question", code, field,
    options: [...readings.map((reading, index) => ({ id: `option_${index + 1}`, value: reading })), neither],
    line: line.text,
  };
}

function addresseeLines(input: CardInput): string[] {
  const ids = (["buyer_name", "buyer_reg", "buyer_vat"] as const).map((field) => input.evidence[field]?.line).filter((id): id is string => id !== undefined);
  const lines = [...new Set(ids)].map((id) => lineText(input.packet, id)).filter((line) => line !== undefined).map((line) => line.text);
  if (lines.length > 0) return lines.slice(0, 3);
  // No buyer evidence: the printed buyer block (a buyer marker such as "Ostja" / "Bill to") or an e-mail line.
  return input.packet.lines.filter((line) => BUYER_MARKER_RE.test(line.text) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(line.text)).map((line) => line.text).slice(0, 3);
}

/** The card for a reading whose holds are all released codes; `blocked` when any hold stops the path. */
export function buildReadingCard(input: CardInput): CardOutcome {
  const blockHolds = blockingHolds(input.holds);
  if (blockHolds.length > 0) return { blocked: true, blockHolds };

  const byField = new Map<PayloadField | "currency", CardHold[]>();
  let minorNotes = input.noteCount;
  let buyerQuestion = false;
  let textLayerLost = false;
  for (const hold of input.holds) {
    if (hold.code === "buyer_id_missing") { buyerQuestion = true; continue; }
    if (hold.code === "text_layer_value_lost") { textLayerLost = true; continue; }
    if (DISPOSITION[hold.code] === "field_review" && !isPayloadField(hold.field)) { minorNotes += 1; continue; }
    const field = hold.field as PayloadField | "currency";
    byField.set(field, [...(byField.get(field) ?? []), hold]);
  }
  const agreed = new Map((input.imageAgreed ?? []).map((entry) => [entry.field, entry]));
  let numberKept = false;
  if (textLayerLost) {
    // §5.3: on a lost text layer the owner types the date and the number (the true value is not in the text),
    // unless server OCR agreed with the client's reading of the crop image, or the text layer prints the read number
    // under the lost cell's own label on another line: then the owner confirms it.
    for (const field of ["invoice_date", "invoice_number"] as const) {
      if (agreed.has(field)) continue;
      const value = input.values.invoice_number;
      const line = lineText(input.packet, input.evidence.invoice_number?.line);
      if (field === "invoice_number" && !byField.has(field) && typeof value === "string" && line &&
        printedToken(input.packet, field, value, line.id) === value && printedUnderLostLabel(input.packet, line.id, value)) {
        numberKept = true;
        continue;
      }
      byField.set(field, [...(byField.get(field) ?? []), { code: "text_layer_value_lost", field }]);
    }
  }
  // An image-agreed field gets only its confirm row. Verify drops the agreement when anything else holds on it;
  // should a hold still remain here, the agreement is not shown and the owner types the value instead.
  for (const field of [...agreed.keys()]) {
    const remaining = byField.get(field);
    if (remaining === undefined) continue;
    agreed.delete(field);
    byField.set(field, [...remaining, { code: "text_layer_value_lost", field }]);
  }

  const rows: CardRow[] = [];
  for (const [field, holds] of byField) {
    const codes = holds.map((hold) => hold.code);
    const typedReason = codes.includes("text_layer_value_lost") ? "text_layer_value_lost"
      : codes.includes("required_field_missing") ? "required_field_missing" : undefined;
    const questionCodes = codes.filter((code) => DISPOSITION[code] === "question") as Array<"reading_heuristic_conflict" | "ambiguous_amount_token" | "ambiguous_slash_date">;
    const reviewCodes = codes.filter((code) => DISPOSITION[code] === "field_review");
    if (typedReason || field === "currency") {
      rows.push({ id: `t:${field}`, kind: "typed", field, reason: typedReason ?? "required_field_missing" });
      continue;
    }
    // One question per field; a field with two question codes, or a question and failed evidence, is typed.
    if (questionCodes.length === 1 && reviewCodes.length === 0) {
      const row = questionRow(input, questionCodes[0]!, field);
      rows.push(row ?? { id: `t:${field}`, kind: "typed", field, reason: "unresolved_question" });
      continue;
    }
    if (questionCodes.length > 0) {
      rows.push({ id: `t:${field}`, kind: "typed", field, reason: "unresolved_question" });
      continue;
    }
    const value = input.values[field];
    const evidence = input.evidence[field];
    const token = value === null || value === undefined || codes.includes("value_not_complete_token")
      ? undefined
      : printedToken(input.packet, field, value, evidence?.line);
    const line = lineText(input.packet, evidence?.line);
    rows.push(token === undefined || !line || value === null || value === undefined
      ? { id: `t:${field}`, kind: "typed", field, reason: "no_printed_token" }
      : { id: `r:${field}`, kind: "field_review", field, codes: [...new Set(reviewCodes)], value, printed_token: token, line: line.text });
  }
  for (const entry of agreed.values()) {
    // Every image-agreed value is shown with its cited row: which label it sits on is the owner's to confirm.
    const value = input.values[entry.field];
    const line = lineText(input.packet, entry.line);
    rows.push(value === null || value === undefined || !line
      ? { id: `t:${entry.field}`, kind: "typed", field: entry.field, reason: "text_layer_value_lost" }
      : { id: `r:${entry.field}`, kind: "field_review", field: entry.field, codes: ["text_layer_value_lost"], value, printed_token: entry.printed, line: line.text });
  }
  if (numberKept) {
    const line = lineText(input.packet, input.evidence.invoice_number!.line)!;
    const value = input.values.invoice_number as string;
    rows.push({ id: "r:invoice_number", kind: "field_review", field: "invoice_number", codes: ["text_layer_value_lost"], value, printed_token: value, line: line.text });
  }
  if (buyerQuestion) {
    rows.push({ id: "buyer", kind: "buyer_question", company: input.company, lines: addresseeLines(input), options: [{ id: "yes" }, { id: "no", stop: true }] });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const grossLine = lineText(input.packet, input.evidence.gross?.line);
  const supplierLine = lineText(input.packet, (input.evidence.supplier_reg ?? input.evidence.supplier_vat)?.line);
  return {
    blocked: false,
    card: {
      look_here: {
        gross: { value: input.values.gross, ...(grossLine ? { line: grossLine.text } : {}) },
        supplier: { client_id: input.supplier.clientId, name: input.supplier.name, ...(supplierLine ? { line: supplierLine.text } : {}) },
      },
      rows,
      minor_notes: minorNotes,
    },
  };
}

// ---------------------------------------------------------------------------
// Owner answers
// ---------------------------------------------------------------------------

export type OwnerAnswer = { choice: string } | { value: string | number } | { confirm: boolean };

export type AnswerOutcome =
  | { ok: true; values: AcceptedValues; correctedFields: TypedField[]; buyerAttested: boolean; textLayerTyped: boolean }
  | { ok: false; code: "owner_answer_missing" | "owner_answer_invalid" | "owner_declined"; rows: string[] };

const hasTwoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/** A typed value in the field's strict format, or undefined. */
function typedValue(field: TypedField, raw: unknown): string | number | undefined {
  if (isAmountField(field)) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || !hasTwoDecimals(raw)) return undefined;
    if (field === "gross" ? raw <= 0 : raw < 0) return undefined;
    return raw;
  }
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (isDateField(field)) return isStrictDate(value) ? value : undefined;
  if (field === "currency") return value === "EUR" ? value : undefined;
  const max = field === "supplier_iban" ? 42 : field === "invoice_number" ? 64 : 20;
  return value.length > 0 && value.length <= max ? value : undefined;
}

const sameValue = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.005 : a === b;

/** Apply the owner's answers: every row needs one; a "neither"/"no" without a typed value stops the card. */
export function applyOwnerAnswers(card: ReadingCard, values: AcceptedValues, answers: unknown): AnswerOutcome {
  const given = typeof answers === "object" && answers !== null && !Array.isArray(answers) ? answers as Record<string, unknown> : {};
  const rowIds = new Set(card.rows.map((row) => row.id));
  const unknown = Object.keys(given).filter((id) => !rowIds.has(id));
  if (unknown.length > 0) return { ok: false, code: "owner_answer_invalid", rows: unknown };
  const missing = card.rows.filter((row) => given[row.id] === undefined).map((row) => row.id);
  if (missing.length > 0) return { ok: false, code: "owner_answer_missing", rows: missing };

  const final: Record<string, unknown> = { ...values };
  const corrected = new Set<TypedField>();
  let buyerAttested = false;
  let textLayerTyped = false;
  const invalid: string[] = [];
  const declined: string[] = [];
  for (const row of card.rows) {
    const answer = given[row.id] as Record<string, unknown>;
    const keys = typeof answer === "object" && answer !== null ? Object.keys(answer) : [];
    const only = (key: string) => keys.length === 1 && keys[0] === key;
    if (row.kind === "question" || row.kind === "buyer_question") {
      if (!only("choice") || typeof answer.choice !== "string") { invalid.push(row.id); continue; }
      const option = row.options.find((entry) => entry.id === answer.choice);
      if (!option) { invalid.push(row.id); continue; }
      if (option.stop) { declined.push(row.id); continue; }
      if (row.kind === "buyer_question") { buyerAttested = true; continue; }
      if (!sameValue(option.value, values[row.field])) corrected.add(row.field);
      final[row.field] = option.value;
      continue;
    }
    if (row.kind === "field_review" && only("confirm")) {
      if (answer.confirm === true) continue;
      if (answer.confirm === false) { declined.push(row.id); continue; }
      invalid.push(row.id);
      continue;
    }
    if (!only("value")) { invalid.push(row.id); continue; }
    const value = typedValue(row.field, answer.value);
    if (value === undefined) { invalid.push(row.id); continue; }
    final[row.field] = value;
    corrected.add(row.field);
    if ((row.kind === "typed" && row.reason === "text_layer_value_lost") ||
      (row.kind === "field_review" && row.codes.includes("text_layer_value_lost"))) textLayerTyped = true;
  }
  if (invalid.length > 0) return { ok: false, code: "owner_answer_invalid", rows: invalid };
  if (declined.length > 0) return { ok: false, code: "owner_declined", rows: declined };
  return { ok: true, values: final as AcceptedValues, correctedFields: [...corrected].sort(), buyerAttested, textLayerTyped };
}

// ---------------------------------------------------------------------------
// Re-checks on the final values (§5.2 step 3)
// ---------------------------------------------------------------------------

/**
 * Lost-value plan Step 0 (rev 3 NEW-1, rev 3.1 NEW-3): the evidence and proof codes. A field whose final value is not
 * the reading's own has its evidence and proof answer removed before the create-time re-run, so these codes say
 * nothing about it.
 */
export const RECHECK_EVIDENCE_PROOF_CODES = [
  "missing_evidence", "quote_not_printed", "proof_problem",
  "label_quote_missing", "label_quote_not_printed", "label_quote_no_letter", "label_quote_overlaps_value",
] as const satisfies readonly HoldCode[];

/** Where a final value came from when it is not the reading's own. */
export type RecheckFieldSource = "owner_supplied" | "image_agreed";

/**
 * The create-time re-run's per-field allow-lists (pinned by a test). Only a hold on a field of that source is
 * dropped; every other hold blocks create, including H5–H10, A2–A5, the foreign-rate trio and every document-level
 * hold. Owner-supplied (typed or corrected): the owner's own reading of the PDF overrides the reading's evidence,
 * its proof of role (the competitor codes, including A1 for an owner-typed gross) and the heuristic.
 */
export const RECHECK_ALLOWED_CODES: { readonly [Source in RecheckFieldSource]: readonly HoldCode[] } = {
  owner_supplied: [
    ...RECHECK_EVIDENCE_PROOF_CODES,
    "value_not_complete_token",
    "competitor_omitted", "competitor_limit_exceeded", "competitor_not_printed", "competitor_ambiguous",
    "reading_heuristic_conflict",
  ],
  // Image-agreed (the client's crop reading = server OCR): the value has no packet evidence or proof answer. Nothing
  // else is waived: a heuristic conflict, a date outside the window or a number that is an identifier still holds.
  image_agreed: [...RECHECK_EVIDENCE_PROOF_CODES],
};

/** True when `hold` is on a field of a listed source whose allow-list names its code. */
export function allowedForSource(hold: { code: HoldCode; field?: string }, sources: Partial<Record<ReadingField, RecheckFieldSource>>): boolean {
  const source = hold.field === undefined ? undefined : sources[hold.field as ReadingField];
  return source !== undefined && RECHECK_ALLOWED_CODES[source].includes(hold.code);
}

/**
 * The whole checker on a reading and proof with `final` substituted. A field of a listed source loses its
 * evidence and gets a neutral proof answer (its value is not the reading's own). Undefined when the reading or
 * proof has no evidence/answers object.
 */
export function checkSubstituted(
  packet: ReadingPacket,
  reading: Record<string, unknown>,
  proof: Record<string, unknown>,
  final: AcceptedValues,
  sources: Partial<Record<ReadingField, RecheckFieldSource>>,
  ctx: CheckContext,
): CheckResult | undefined {
  if (!isRecord(reading.evidence) || !isRecord(proof.answers)) return undefined;
  const evidence: Record<string, unknown> = { ...reading.evidence };
  const answers: Record<string, unknown> = { ...proof.answers };
  for (const field of Object.keys(sources)) {
    delete evidence[field];
    answers[field] = { label_quote: null, competitors: [], why_this_one: "", verdict: "confirm" };
  }
  return checkReading(packet, { ...reading, ...final, evidence }, { ...proof, answers }, ctx);
}

export interface RecheckReadingInput {
  packet: ReadingPacket;
  /** The verified reading and proof as the plan binds them (canonical JSON). */
  readingJson: unknown;
  proofJson: unknown;
  final: AcceptedValues;
  /** The fields whose final value is not the reading's own, by source. */
  sources: Partial<Record<ReadingField, RecheckFieldSource>>;
  /**
   * Every checker hold at verify. A handle exists only when the card released all of them (owner rows, or notes for
   * non-payload fields); the re-run drops a repeat of one only when its code is not a block code.
   */
  releasedHolds: readonly CardHold[];
  ctx: CheckContext;
}

const holdKey = (hold: { code: string; field?: string }) => `${hold.code}\u0000${hold.field ?? ""}`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The whole checker re-run at create on the bound reading with the final values substituted (Step 0). Holds only:
 * the re-run's holds minus (a) a non-block hold verify already raised (the card released it) and (b) a hold
 * on a field of a listed source whose code that source's allow-list names. A re-run that cannot be performed (no
 * bound reading or proof, unparseable JSON) holds reading_schema_invalid: never a fallback to recheckFinalValues alone.
 */
export function recheckReading(input: RecheckReadingInput): CardHold[] {
  const unavailable: CardHold[] = [{ code: "reading_schema_invalid" }];
  if (typeof input.readingJson !== "string" || typeof input.proofJson !== "string") return unavailable;
  let reading: unknown;
  let proof: unknown;
  try {
    reading = JSON.parse(input.readingJson);
    proof = JSON.parse(input.proofJson);
  } catch {
    return unavailable;
  }
  if (!isRecord(reading) || !isRecord(proof)) return unavailable;
  const result = checkSubstituted(input.packet, reading, proof, input.final, input.sources, input.ctx);
  if (!result) return unavailable;
  const released = new Set(input.releasedHolds.map(holdKey));
  return result.holds
    .filter((hold) => {
      if (allowedForSource(hold, input.sources)) return false;
      return DISPOSITION[hold.code] === "block" || !released.has(holdKey(hold));
    })
    .map((hold) => (hold.field === undefined ? { code: hold.code } : { code: hold.code, field: hold.field }));
}

export interface RecheckContext {
  today: string;
  /** The checker's zero-VAT proof for the reading's own VAT line. */
  vatZeroNoteProven: boolean;
  /** The reading's values before the owner's answers. */
  original: AcceptedValues;
}

/**
 * The value-level checks that depend on owner answers, re-run on the final values: required fields, format,
 * arithmetic (H5), zero VAT and rate snapping (H6), the date window (H10) and changed identifiers (H7). Holds only.
 */
export function recheckFinalValues(final: AcceptedValues, ctx: RecheckContext): CardHold[] {
  const holds: CardHold[] = [];
  for (const field of ["invoice_number", "invoice_date", "currency", "gross"] as const) {
    if (final[field] === null) holds.push({ code: "required_field_missing", field });
  }
  for (const field of AMOUNT_FIELDS) {
    const value = final[field];
    if (value !== null && typedValue(field, value) === undefined) holds.push({ code: "arithmetic_mismatch", field });
  }
  for (const field of DATE_FIELDS) {
    const value = final[field];
    if (value !== null && !isStrictDate(value)) holds.push({ code: "invoice_date_out_of_window", field });
  }
  const { net, vat, gross } = final;
  if (net !== null && vat !== null && gross !== null && Math.abs(net + vat - gross) > 0.01 + 1e-9) holds.push({ code: "arithmetic_mismatch" });
  if (vat === 0 && (!ctx.vatZeroNoteProven || ctx.original.vat !== 0)) holds.push({ code: "zero_vat_unproven", field: "vat" });
  if (vat !== null && vat > 0) {
    const base = net ?? (gross !== null ? gross - vat : undefined);
    if (base !== undefined && rateMatches(base, vat, vatRatesInForceOn(final.invoice_date)).length !== 1) holds.push({ code: "vat_rate_not_snapped", field: "vat" });
  }
  if (final.due_date !== null && final.invoice_date !== null && final.due_date < final.invoice_date) {
    holds.push({ code: "invoice_date_out_of_window", field: "due_date" });
  }
  if (final.invoice_date !== null) {
    const earliest = `${Number(ctx.today.slice(0, 4)) - 1}-01-01`;
    if (final.invoice_date < earliest || final.invoice_date > ctx.today) holds.push({ code: "invoice_date_out_of_window", field: "invoice_date" });
  }
  if (final.supplier_reg !== null && final.supplier_reg !== ctx.original.supplier_reg && !isValidEeRegistryCode(final.supplier_reg)) {
    holds.push({ code: "identifier_invalid", field: "supplier_reg" });
  }
  if (final.supplier_vat !== null && final.supplier_vat !== ctx.original.supplier_vat) {
    const normalized = normalizeVatValue(final.supplier_vat);
    if (!normalized || !(isValidEeVatNumber(normalized) || isForeignVatShape(normalized))) holds.push({ code: "identifier_invalid", field: "supplier_vat" });
  }
  if (final.supplier_iban !== null && final.supplier_iban !== ctx.original.supplier_iban && !isValidIban(final.supplier_iban)) {
    holds.push({ code: "identifier_invalid", field: "supplier_iban" });
  }
  return holds;
}
