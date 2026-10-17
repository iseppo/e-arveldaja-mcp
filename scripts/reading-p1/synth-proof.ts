// Replay validity (plan §5.5): truth-derived base readings, the synthetic confirm-all proof, and base
// admission. Every base equals truth on the scored payload fields; each truth value is located as a
// complete line-level token of its type (labelled occurrence first, else the first in packet order).
// Truth-unscored fields (no value in e-arveldaja) take the heuristic's value when it is printed, else null.

import { normalizeVatValue } from "../../src/document-identifiers.js";
import { checkReading, type CheckContext, type CheckResult, type HeuristicView } from "../../src/document-reading-check.js";
import { matchOffsets, type PacketLine, type ReadingPacket } from "../../src/document-reading-packet.js";
import { READING_FIELDS, type EvidenceField, type ReadingField } from "../../src/document-reading-schemas.js";
import { ibanScan, identifierScan, lineCells, lineTokens } from "../../src/document-reading-tokens.js";
import { detectReverseChargeFromText } from "../../src/tools/receipt-extraction.js";
import { ownExtractionContext, type PacketFile, type OwnIds } from "./build-packets.js";
import type { TruthRecord } from "./truth.js";

export interface Located { line: PacketLine; start: number; end: number; quote: string }
type FieldKind = "date" | "amount" | "reg" | "vat" | "iban" | "number" | "currency" | "name";

export const FIELD_KIND: Record<EvidenceField, FieldKind> = {
  invoice_date: "date",
  due_date: "date",
  invoice_number: "number",
  supplier_name: "name",
  supplier_reg: "reg",
  supplier_vat: "vat",
  supplier_iban: "iban",
  buyer_name: "name",
  buyer_reg: "reg",
  buyer_vat: "vat",
  currency: "currency",
  net: "amount",
  vat: "amount",
  gross: "amount",
};

const LETTER = /\p{L}/u;
/** A due-date label on the token's line or the line above (a payment date such as "Makse kuupäev" is not one). */
const DUE_LABEL = /t\u00e4htaeg|due|maksta hiljemalt|pay by|f\u00e4llig|termin/iu;
const UNPRINTED_AS_NULL: ReadonlySet<EvidenceField> = new Set(["supplier_reg", "supplier_vat", "supplier_iban"]);
const compact = (value: string) => value.replace(/\s+/g, "").toUpperCase();

/** The cell holding [start, end) on the line, as the quote (the token itself when the cell is too long). */
function quoteFor(line: PacketLine, start: number, end: number): string {
  const cell = lineCells(line.text).find((candidate) => start >= candidate.start && end <= candidate.end);
  const text = cell ? cell.text.trim() : line.text.slice(start, end);
  return text.length <= 200 ? text : line.text.slice(start, end);
}

/** Every complete token of `kind` on the packet whose reading equals `value`. */
export function occurrences(packet: ReadingPacket, kind: FieldKind, value: string | number): Located[] {
  const found: Located[] = [];
  const push = (line: PacketLine, start: number, end: number) => found.push({ line, start, end, quote: quoteFor(line, start, end) });
  if (kind === "reg" || kind === "vat") {
    const wanted = kind === "vat" ? normalizeVatValue(String(value)) : String(value).replace(/\s+/g, "");
    for (const hit of identifierScan(packet.lines, "strict")) {
      if (!hit.values.includes(wanted ?? "")) continue;
      const line = packet.lines.find((candidate) => candidate.id === hit.line)!;
      push(line, hit.start, hit.end);
    }
    return found;
  }
  if (kind === "iban") {
    for (const hit of ibanScan(packet.lines)) {
      if (hit.value !== compact(String(value))) continue;
      push(packet.lines.find((candidate) => candidate.id === hit.line)!, hit.start, hit.end);
    }
    return found;
  }
  for (const line of packet.lines) {
    const tokens = lineTokens(line);
    if (kind === "date") {
      for (const token of tokens.dates) if (!token.ambiguousSlash && token.values.includes(String(value))) push(line, token.start, token.end);
    } else if (kind === "amount") {
      for (const token of tokens.money) {
        if (token.kind === "ambiguous" || token.kind === "ambiguous_join") continue;
        if (token.values.some((reading) => Math.abs(reading - Number(value)) <= 0.005)) push(line, token.start, token.end);
      }
    } else if (kind === "number") {
      for (const token of tokens.wordTokens) if (token.text === String(value)) push(line, token.start, token.end);
    } else if (kind === "currency") {
      // H2 currency: a whole token EUR/eur/euro/eurot or the character €; another code as its own token.
      const code = String(value);
      const words = code === "EUR" ? ["EUR", "eur", "euro", "eurot", "Euro", "EURO"] : [code];
      for (const token of tokens.wordTokens) if (words.includes(token.text)) push(line, token.start, token.end);
      const symbol = code === "EUR" ? "€" : code === "USD" ? "$" : code === "GBP" ? "£" : undefined;
      if (symbol) for (const match of line.text.matchAll(new RegExp(`\\${symbol}`, "g"))) push(line, match.index!, match.index! + 1);
    } else if (kind === "name") {
      const needle = String(value);
      for (const cell of lineCells(line.text)) {
        const text = cell.text.trim();
        if (text.toLocaleLowerCase() === needle.toLocaleLowerCase()) {
          const at = line.text.indexOf(text, cell.start);
          push(line, at, at + text.length);
        }
      }
    }
  }
  return found;
}

/** The labelled occurrence: its cell, or the cell before it on the same line, has a letter. */
function preferLabelled(candidates: Located[]): Located | undefined {
  const labelled = candidates.find((candidate) => {
    const cells = lineCells(candidate.line.text);
    const index = cells.findIndex((cell) => candidate.start >= cell.start && candidate.end <= cell.end);
    const own = index >= 0 ? cells[index]!.text : "";
    const before = index > 0 ? cells[index - 1]!.text : "";
    const ownWithoutToken = own.replace(candidate.line.text.slice(candidate.start, candidate.end), "");
    return LETTER.test(ownWithoutToken) || LETTER.test(before);
  });
  return labelled ?? candidates[0];
}

export interface BaseReading {
  reading: Record<string, unknown> & { evidence: Record<string, { line: string; quote: string }> };
  sources: Partial<Record<EvidenceField, "truth" | "truth_unprinted" | "heuristic" | "own">>;
  dropped?: string;
}

/** A truth-derived base reading, or `dropped` with the first scored field that has no printed occurrence. */
export function truthDerivedReading(file: PacketFile, truth: TruthRecord, own: OwnIds): BaseReading {
  const packet = file.packet;
  const reading: BaseReading["reading"] = {
    source_sha256: packet.source_sha256,
    packet_digest: packet.packet_digest,
    doc_type: "invoice",
    evidence: {},
  };
  const sources: BaseReading["sources"] = {};
  const unscored = new Set(truth.unscored_fields ?? []);
  const set = (field: EvidenceField, value: string | number, located: Located, source: "truth" | "heuristic" | "own") => {
    reading[field] = value;
    reading.evidence[field] = { line: located.line.id, quote: located.quote };
    sources[field] = source;
  };
  const scoredFields: Array<[EvidenceField, string | number | null | undefined]> = [
    ["invoice_date", truth.invoice_date],
    ["invoice_number", truth.invoice_number],
    ["supplier_reg", truth.supplier_reg],
    ["supplier_vat", truth.supplier_vat],
    ["supplier_iban", truth.supplier_iban],
    ["currency", truth.currency],
    ["net", truth.net],
    ["vat", truth.vat],
    ["gross", truth.gross],
  ];
  for (const [field, value] of scoredFields) {
    if (unscored.has(field) || value === null || value === undefined) {
      // Unscored: the heuristic's value when printed as a complete token, else null.
      const heuristic = heuristicValue(file, field);
      const located = heuristic === undefined ? undefined : preferLabelled(occurrences(packet, FIELD_KIND[field], heuristic));
      if (heuristic !== undefined && located) set(field, heuristic, located, "heuristic");
      else reading[field] = null;
      continue;
    }
    const located = preferLabelled(occurrences(packet, FIELD_KIND[field], value));
    if (!located) {
      // e-arveldaja may hold more than the document prints: an unprinted supplier id or IBAN, or a VAT of 0,
      // is read as null (no value is written from it). Any other unprinted truth value drops the base.
      if (UNPRINTED_AS_NULL.has(field) || (field === "vat" && value === 0)) {
        reading[field] = null;
        sources[field] = "truth_unprinted";
        continue;
      }
      return { reading, sources, dropped: `${field}_not_printed` };
    }
    set(field, value, located, "truth");
  }
  // Due date: scored only when printed under a due-date label; e-arveldaja's create_date + term_days otherwise
  // has no source line, and the same date printed as an invoice or payment date is not a due date.
  const due = truth.due_date ? occurrences(packet, "date", truth.due_date).find((located) => {
    const index = packet.lines.findIndex((line) => line.id === located.line.id);
    const before = located.line.text.slice(0, located.start);
    return DUE_LABEL.test(before) || (!LETTER.test(before) && index > 0 && DUE_LABEL.test(packet.lines[index - 1]!.text));
  }) : undefined;
  if (due && truth.due_date) set("due_date", truth.due_date, due, "truth");
  else reading.due_date = null;
  // Buyer ids: the own ids, when printed.
  const buyerReg = own.reg ? preferLabelled(occurrences(packet, "reg", own.reg)) : undefined;
  const buyerVat = own.vat ? preferLabelled(occurrences(packet, "vat", own.vat)) : undefined;
  if (buyerReg && own.reg) set("buyer_reg", own.reg, buyerReg, "own");
  else reading.buyer_reg = null;
  if (buyerVat && own.vat) set("buyer_vat", own.vat, buyerVat, "own");
  else reading.buyer_vat = null;
  if (!buyerReg && !buyerVat) reading.doc_type = "receipt";
  // Names are never written by the booking; the supplier name is kept only when a whole cell prints it.
  const name = truth.supplier_name ? preferLabelled(occurrences(packet, "name", truth.supplier_name)) : undefined;
  if (name && truth.supplier_name) set("supplier_name", name.quote, name, "truth");
  else reading.supplier_name = null;
  // Buyer name: the own company name, when a whole cell prints it.
  const ownName = ownExtractionContext(own).ownCompanyName ?? own.name;
  const buyerName = ownName ? preferLabelled(occurrences(packet, "name", ownName)) : undefined;
  if (buyerName) set("buyer_name", buyerName.quote, buyerName, "own");
  else reading.buyer_name = null;
  for (const field of READING_FIELDS) if (!(field in reading)) reading[field] = null;
  return { reading, sources };
}

function heuristicValue(file: PacketFile, field: EvidenceField): string | number | undefined {
  const labelled = file.heuristic.labelled as Record<string, string | number | undefined>;
  const fields = file.heuristic_fields as Record<string, string | number | null>;
  const value = labelled[field] ?? fields[field];
  return value === null ? undefined : value;
}

// ---------------------------------------------------------------------------
// Synthetic confirm-all proof
// ---------------------------------------------------------------------------

function valueToken(packet: ReadingPacket, field: EvidenceField, reading: Record<string, unknown>): Located | undefined {
  const evidence = (reading.evidence as Record<string, { line: string; quote: string }> | undefined)?.[field];
  const value = reading[field];
  if (!evidence || value === null || value === undefined) return undefined;
  const line = packet.lines.find((candidate) => candidate.id === evidence.line);
  if (!line) return undefined;
  const spans = matchOffsets(evidence.quote, line);
  const tokens = occurrences({ ...packet, lines: [line] }, FIELD_KIND[field], value as string | number)
    .filter((located) => spans.some((span) => located.start >= span.start && located.end <= span.end));
  return tokens[0] ?? (spans[0] ? { line, start: spans[0].start, end: spans[0].end, quote: evidence.quote } : undefined);
}

function labelFor(packet: ReadingPacket, token: Located): string | null {
  const before = token.line.text.slice(0, token.start).replace(/[\s¦:]+$/u, "").trim();
  const candidate = before.length > 200 ? before.slice(before.length - 200).trim() : before;
  if (candidate && LETTER.test(candidate)) return candidate;
  const index = packet.lines.findIndex((line) => line.id === token.line.id);
  const previous = index > 0 ? packet.lines[index - 1]! : undefined;
  if (previous && previous.page === token.line.page && LETTER.test(previous.text)) {
    const text = previous.text.trim();
    return text.length <= 200 ? text : text.slice(0, 200).trim();
  }
  return null;
}

/** label = the evidence line before the value token (else the previous line); gross competitors = every larger amount. */
export function synthesizeProof(packet: ReadingPacket, reading: Record<string, unknown>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  const gross = typeof reading.gross === "number" ? reading.gross : null;
  for (const field of READING_FIELDS) {
    let label: string | null = null;
    let competitors: Array<{ line: string; quote: string }> = [];
    if (field !== "doc_type") {
      const token = valueToken(packet, field as EvidenceField, reading);
      if (token) label = labelFor(packet, token);
    }
    if (field === "gross" && gross !== null) {
      const seen = new Set<string>();
      for (const line of packet.lines) {
        for (const token of lineTokens(line).money) {
          if (!token.values.some((value) => value > gross + 0.005)) continue;
          if (token.values.some((value) => Math.abs(value - gross) <= 0.005)) continue;
          const key = `${line.id}\u0000${token.text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          competitors.push({ line: line.id, quote: token.text });
        }
      }
      competitors = competitors.slice(0, 32);
    }
    answers[field] = { label_quote: label, competitors, why_this_one: "synthetic confirm-all proof", verdict: "confirm" };
  }
  return { source_sha256: reading.source_sha256, packet_digest: reading.packet_digest, answers };
}

export function checkContext(file: PacketFile, own: OwnIds, today: string, heuristic: HeuristicView = file.heuristic): CheckContext {
  const ownIds: { reg?: string; vat?: string } = {};
  if (own.reg) ownIds.reg = own.reg;
  if (own.vat) ownIds.vat = own.vat;
  return {
    today,
    own: own.reg || own.vat ? ownIds : "unavailable",
    heuristic,
    isReverseChargeText: detectReverseChargeFromText,
  };
}

/** Base admission: base reading + its synthetic proof must be accepted in the as-of pass. */
export function admitBase(file: PacketFile, base: BaseReading, own: OwnIds, asOfToday: string): { admitted: boolean; result: CheckResult; proof: Record<string, unknown> } {
  const proof = synthesizeProof(file.packet, base.reading);
  const result = checkReading(file.packet, base.reading, proof, checkContext(file, own, asOfToday));
  return { admitted: base.dropped === undefined && result.verdict === "accept", result, proof };
}

export type { ReadingField };
