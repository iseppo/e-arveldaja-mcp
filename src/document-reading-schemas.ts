// PURE module (P1 reading checker): the strict schemas of the client's
// `document_reading` and `proof` objects. Plan: .omc/plans/p1-reading-checker.md §1.3.
//
// P2 must run desandboxAllStrings (external-text-renderer.ts) on the decoded
// input BEFORE these parsers: a string that still carries a sandbox marker is refused.

import { z } from "zod";
import { stripSandboxMarkers } from "./sandbox-markers.js";
import { isStrictDate } from "./strict-date.js";

export const READING_FIELDS = [
  "doc_type",
  "invoice_date",
  "invoice_number",
  "due_date",
  "supplier_name",
  "supplier_reg",
  "supplier_vat",
  "supplier_iban",
  "buyer_name",
  "buyer_reg",
  "buyer_vat",
  "currency",
  "net",
  "vat",
  "gross",
] as const;
export type ReadingField = typeof READING_FIELDS[number];
export type EvidenceField = Exclude<ReadingField, "doc_type">;
export const EVIDENCE_FIELDS = READING_FIELDS.filter((field): field is EvidenceField => field !== "doc_type");

export const DOC_TYPES = ["invoice", "receipt", "credit_note", "multiple_documents", "other"] as const;

export const READING_MAX_BYTES = 16 * 1024;
export const PROOF_MAX_BYTES = 24 * 1024;
/** A raw JSON string larger than this is refused before it is decoded. */
const MAX_RAW_INPUT_BYTES = 1024 * 1024;

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const lineRef = z.string().regex(/^p\d{1,3}:\d{3,4}$/);
const quote = z.string().min(1).max(200);
const nullableString = (max: number) => z.string().max(max).nullable();
const hasTwoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const amount = (positive: boolean) =>
  (positive ? z.number().gt(0) : z.number().gte(0))
    .refine(Number.isFinite)
    .refine(hasTwoDecimals)
    .nullable();

const EvidenceSchema = z.object({ line: lineRef, quote }).strict();

export const DocumentReadingSchema = z.object({
  source_sha256: digest,
  packet_digest: digest,
  doc_type: z.enum(DOC_TYPES),
  invoice_date: z.string().refine(isStrictDate).nullable(),
  invoice_number: nullableString(64),
  due_date: z.string().refine(isStrictDate).nullable(),
  supplier_name: nullableString(200),
  supplier_reg: nullableString(20),
  supplier_vat: nullableString(20),
  supplier_iban: nullableString(42),
  buyer_name: nullableString(200),
  buyer_reg: nullableString(20),
  buyer_vat: nullableString(20),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  net: amount(false),
  vat: amount(false),
  gross: amount(true),
  evidence: z.object(
    Object.fromEntries(EVIDENCE_FIELDS.map((field) => [field, EvidenceSchema.optional()])) as Record<
      EvidenceField,
      z.ZodOptional<typeof EvidenceSchema>
    >,
  ).strict(),
  // Any entry is refused upfront as `computed_field` by parseDocumentReading.
  computed: z.array(z.enum(READING_FIELDS)).max(READING_FIELDS.length).optional(),
}).strict();
export type DocumentReading = z.infer<typeof DocumentReadingSchema>;

const CompetitorSchema = z.object({ line: lineRef, quote }).strict();
const ProofAnswerSchema = z.object({
  label_quote: quote.nullable(),
  competitors: z.array(CompetitorSchema).max(32),
  why_this_one: z.string().max(300),
  verdict: z.enum(["confirm", "problem"]),
}).strict();
export type ProofAnswer = z.infer<typeof ProofAnswerSchema>;

export const ProofSchema = z.object({
  source_sha256: digest,
  packet_digest: digest,
  answers: z.object(
    Object.fromEntries(READING_FIELDS.map((field) => [field, ProofAnswerSchema])) as Record<
      ReadingField,
      typeof ProofAnswerSchema
    >,
  ).strict(),
  proof_context: z.enum(["fresh", "same"]).optional(),
}).strict();
export type Proof = z.infer<typeof ProofSchema>;

export type ParseOutcome<T, C extends string> = { ok: true; value: T } | { ok: false; code: C };

/** Decode an object or a JSON string (as jsonObjectInput does), then apply the size cap. */
function decode(input: unknown, maxBytes: number): Record<string, unknown> | undefined {
  let value = input;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_RAW_INPUT_BYTES) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) return undefined;
  return value as Record<string, unknown>;
}

function containsSandboxMarker(value: unknown): boolean {
  if (typeof value === "string") return stripSandboxMarkers(value) !== value;
  if (Array.isArray(value)) return value.some(containsSandboxMarker);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, entry]) => containsSandboxMarker(key) || containsSandboxMarker(entry));
  }
  return false;
}

export function parseDocumentReading(
  input: unknown,
): ParseOutcome<DocumentReading, "reading_schema_invalid" | "computed_field"> {
  const decoded = decode(input, READING_MAX_BYTES);
  if (!decoded || containsSandboxMarker(decoded)) return { ok: false, code: "reading_schema_invalid" };
  const parsed = DocumentReadingSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, code: "reading_schema_invalid" };
  if ((parsed.data.computed ?? []).length > 0) return { ok: false, code: "computed_field" };
  return { ok: true, value: parsed.data };
}

export function parseProof(input: unknown): ParseOutcome<Proof, "proof_schema_invalid"> {
  const decoded = decode(input, PROOF_MAX_BYTES);
  if (!decoded || containsSandboxMarker(decoded)) return { ok: false, code: "proof_schema_invalid" };
  const parsed = ProofSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, code: "proof_schema_invalid" };
  return { ok: true, value: parsed.data };
}
