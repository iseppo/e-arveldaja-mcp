// Synthetic document_reading / proof builders for the P1 reading-checker tests.
import { READING_FIELDS, type ReadingField } from "../../document-reading-schemas.js";
import { FIXTURE_SHA } from "./make-packet.js";

export const FIXTURE_DIGEST = "d".repeat(64);

export function makeReading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_sha256: FIXTURE_SHA,
    packet_digest: FIXTURE_DIGEST,
    doc_type: "invoice",
    invoice_date: "2026-03-15",
    invoice_number: "A-17",
    due_date: null,
    supplier_name: "Näidis OÜ",
    supplier_reg: "10000018",
    supplier_vat: null,
    supplier_iban: null,
    buyer_name: null,
    buyer_reg: null,
    buyer_vat: null,
    currency: "EUR",
    net: 100,
    vat: 24,
    gross: 124,
    evidence: {
      invoice_number: { line: "p1:001", quote: "A-17" },
    },
    ...overrides,
  };
}

export function makeAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { label_quote: null, competitors: [], why_this_one: "", verdict: "confirm", ...overrides };
}

export function makeProof(
  answers: Partial<Record<ReadingField, Record<string, unknown>>> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source_sha256: FIXTURE_SHA,
    packet_digest: FIXTURE_DIGEST,
    answers: Object.fromEntries(READING_FIELDS.map((field) => [field, answers[field] ?? makeAnswer()])),
    ...overrides,
  };
}
