// Tolerant "critical codecs" for API responses.
//
// Pre-mutation safety checks read a handful of response fields (an invoice's
// status / payment_status, a create response's created_object_id). Historically
// those reads used unsafe inline casts (`current as { status?: string }`), which
// silently accept a malformed upstream value (`status: 42`) and let a wrong
// safety decision through.
//
// These decoders are TOLERANT: they permit any unknown EXTRA upstream fields
// (the API may add fields — never reject for that) and are a HAPPY-PATH NO-OP on
// every well-formed response. They fail-CLOSED only when a safety-critical field
// is present-but-malformed (`status: 42`, `id: "abc"`, `created_object_id: NaN`).
// Scope is intentionally narrow — only the fields a pre-mutation check already
// reads are decoded (YAGNI); no validation-library dependency, hand-rolled
// guards only.

export class CriticalFieldError extends Error {
  constructor(
    public readonly field: string,
    public readonly received: unknown,
  ) {
    super(`Critical response field "${field}" is malformed: received ${describeValue(received)}`);
    this.name = "CriticalFieldError";
  }
}

function describeValue(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "object") return "[object]";
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * A finite number, or `undefined` when absent (`undefined`/`null` are treated as
 * "not present" — the API omits or nulls optional ids). Throws
 * `CriticalFieldError` when present but not a finite number (e.g. `"abc"`, `NaN`,
 * `Infinity`), so a malformed id/monetary field can never slip past a safety
 * check as a silent `undefined`.
 */
function decodeFiniteNumberField(rec: Record<string, unknown>, field: string): number | undefined {
  const value = rec[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CriticalFieldError(field, value);
  }
  return value;
}

/** A string, or `undefined` when absent; throws when present but not a string. */
function decodeStringField(rec: Record<string, unknown>, field: string): string | undefined {
  const value = rec[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new CriticalFieldError(field, value);
  }
  return value;
}

export interface ApiResponseCritical {
  created_object_id?: number;
}

/**
 * Decode the safety-critical fields of a mutation ApiResponse. Only
 * `created_object_id` is read by pre-mutation / outcome-recording checks; a
 * present-but-malformed value fails closed rather than being recorded as an
 * absent id.
 */
export function decodeApiResponseCritical(value: unknown): ApiResponseCritical {
  const rec = asRecord(value);
  return {
    created_object_id: decodeFiniteNumberField(rec, "created_object_id"),
  };
}

export interface InvoiceStatusCritical {
  id?: number;
  status?: string;
  payment_status?: string;
}

/**
 * Decode the confirmation / payment fields a pre-mutation immutability or
 * open-invoice check depends on (`status`, `payment_status`, `id`). A malformed
 * value (e.g. `status: 42`) fails closed so a confirmed/paid record can never be
 * mistaken for an editable/open one.
 */
export function decodeInvoiceStatusCritical(value: unknown): InvoiceStatusCritical {
  const rec = asRecord(value);
  return {
    id: decodeFiniteNumberField(rec, "id"),
    status: decodeStringField(rec, "status"),
    payment_status: decodeStringField(rec, "payment_status"),
  };
}
