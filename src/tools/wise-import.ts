import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { registerTool } from "../mcp-compat.js";
import {
  toMcpJson,
  UNTRUSTED_OCR_END_PREFIX,
  UNTRUSTED_OCR_START_PREFIX,
  wrapUntrustedOcr,
} from "../mcp-json.js";
import type { AccountDimension, BankAccount } from "../types/api.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import { captureFileInputSnapshot } from "../file-input-snapshot.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { reportProgress } from "../progress.js";
import { isNonVoidTransaction, isProjectTransaction } from "../transaction-status.js";
import { parseCSV } from "../csv.js";
import { roundMoney } from "../money.js";
import { normalizeCompanyName } from "../company-name.js";
import { BookingGuard } from "../booking-guard.js";
import { DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT } from "../accounting-defaults.js";
import { roundTo } from "../money.js";
import type { PurchaseInvoice } from "../types/api.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";
import { clearRuntimeCaches } from "../cache-control.js";
import { toolError } from "../tool-error.js";
import { buildInterAccountJournalIndex, findMatchingJournal } from "./inter-account-utils.js";
import { createBankTransaction } from "../bank-transaction-create.js";

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

interface WiseRow {
  rowIndex: number;
  id: string;
  status: string;
  direction: string;
  createdOn: string;
  finishedOn: string;
  sourceFeeAmount: number;
  sourceFeeCurrency: string;
  targetFeeAmount: number;
  targetFeeCurrency: string;
  sourceName: string;
  sourceAmount: number;
  sourceCurrency: string;
  targetName: string;
  targetAmount: number;
  targetCurrency: string;
  exchangeRate: number;
  reference: string;
  category: string;
  note: string;
}

type WiseTransferOwnershipBasis = "verified_endpoints" | "operator_approved";

interface WiseTransferReview {
  wise_id: string;
  code: "wise_transfer_dimensions_unverified" | "wise_transfer_ownership_unverified";
  reason: string;
  source_verified: boolean;
  target_verified: boolean;
  approval_required: boolean;
}

interface WiseTransferDecision {
  targetDimensionId?: number;
  sourceVerified: boolean;
  targetVerified: boolean;
  ownershipBasis?: WiseTransferOwnershipBasis;
  review?: WiseTransferReview;
}

const WISE_TRANSFER_DIMENSIONS_REASON =
  "Wise and target dimensions must resolve to two distinct configured bank accounts before reconciliation.";
const WISE_TRANSFER_OWNERSHIP_REASON =
  "Wise transfer ownership is unverified; both endpoints must match configured own-account identities or this exact Wise ID must be explicitly approved.";

function isWiseTransferCandidate(row: WiseRow): boolean {
  return row.id.startsWith("TRANSFER-") || row.id.startsWith("BANK_DETAILS_PAYMENT_RETURN-");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function bankIdentitiesByDimension(bankAccounts: BankAccount[]): {
  dimensions: Set<number>;
  identityDimensions: Map<string, Set<number>>;
} {
  const dimensions = new Set<number>();
  const identityDimensions = new Map<string, Set<number>>();

  for (const account of bankAccounts) {
    const dimensionId = account.accounts_dimensions_id;
    if (!isPositiveSafeInteger(dimensionId)) continue;
    dimensions.add(dimensionId);
    for (const value of [account.beneficiary_name, account.account_name_est, account.account_name_eng]) {
      const identity = normalizeWiseCompanyName(value);
      if (!identity) continue;
      const owners = identityDimensions.get(identity) ?? new Set<number>();
      owners.add(dimensionId);
      identityDimensions.set(identity, owners);
    }
  }

  return { dimensions, identityDimensions };
}

function uniqueActivePostingDimensions(accountDimensions: AccountDimension[]): Map<number, AccountDimension> {
  const candidates = new Map<number, AccountDimension[]>();
  for (const dimension of accountDimensions) {
    if (dimension.is_deleted || !isPositiveSafeInteger(dimension.id)) {
      continue;
    }
    const matches = candidates.get(dimension.id) ?? [];
    matches.push(dimension);
    candidates.set(dimension.id, matches);
  }

  const unique = new Map<number, AccountDimension>();
  for (const [id, matches] of candidates) {
    if (matches.length === 1 && isPositiveSafeInteger(matches[0]!.accounts_id)) {
      unique.set(id, matches[0]!);
    }
  }
  return unique;
}

function endpointMatchesOwnDimension(
  value: string,
  dimensionId: number | undefined,
  ownCompanyIdentity: string,
  identityDimensions: Map<string, Set<number>>,
): boolean {
  const identity = normalizeWiseCompanyName(value);
  if (!identity) return false;
  if (ownCompanyIdentity && identity === ownCompanyIdentity) return true;
  if (dimensionId === undefined) return false;
  const owners = identityDimensions.get(identity);
  return owners?.size === 1 && owners.has(dimensionId);
}

function classifyWiseOwnTransfer(
  row: WiseRow,
  accountsDimensionsId: number | undefined,
  targetDimensionId: number | undefined,
  configuredDimensions: Set<number>,
  identityDimensions: Map<string, Set<number>>,
  ownCompanyIdentity: string,
  approved: boolean,
): WiseTransferDecision {
  const direction = normalizeWiseDirection(row.direction);
  const sourceDimensionId = direction === "IN" ? targetDimensionId : accountsDimensionsId;
  const destinationDimensionId = direction === "IN" ? accountsDimensionsId : targetDimensionId;
  const sourceVerified = endpointMatchesOwnDimension(
    row.sourceName,
    sourceDimensionId,
    ownCompanyIdentity,
    identityDimensions,
  );
  const targetVerified = endpointMatchesOwnDimension(
    row.targetName,
    destinationDimensionId,
    ownCompanyIdentity,
    identityDimensions,
  );
  const structurallyValid = accountsDimensionsId !== undefined &&
    configuredDimensions.has(accountsDimensionsId) &&
    targetDimensionId !== undefined &&
    targetDimensionId !== accountsDimensionsId &&
    configuredDimensions.has(targetDimensionId);

  if (!structurallyValid) {
    return {
      targetDimensionId,
      sourceVerified,
      targetVerified,
      review: {
        wise_id: row.id,
        code: "wise_transfer_dimensions_unverified",
        reason: WISE_TRANSFER_DIMENSIONS_REASON,
        source_verified: sourceVerified,
        target_verified: targetVerified,
        approval_required: false,
      },
    };
  }

  if (sourceVerified && targetVerified) {
    return { targetDimensionId, sourceVerified, targetVerified, ownershipBasis: "verified_endpoints" };
  }
  if (approved) {
    return { targetDimensionId, sourceVerified, targetVerified, ownershipBasis: "operator_approved" };
  }
  return {
    targetDimensionId,
    sourceVerified,
    targetVerified,
    review: {
      wise_id: row.id,
      code: "wise_transfer_ownership_unverified",
      reason: WISE_TRANSFER_OWNERSHIP_REASON,
      source_verified: sourceVerified,
      target_verified: targetVerified,
      approval_required: true,
    },
  };
}

// --- M05: strict Wise row validation -----------------------------------------
//
// A Wise export is external input. Every rejected field is addressed by a
// POSITIONAL identity so no file-supplied byte (the Wise ID, counterparty text,
// the malformed value itself) reaches an identity or a reason. Raw values are
// exposed only through the bounded, sandboxed projection in
// wisePreflightFailure().

export interface ImportRejectedField {
  source_row_id: string;
  field: string;
  value: string;
  reason: string;
}

type WisePreflightResult =
  | { ok: true; source: "wise"; rows: WiseRow[] }
  | { ok: false; source: "wise"; rejected_fields: ImportRejectedField[] };

class ImportFieldError extends Error {
  constructor(readonly issue: ImportRejectedField) {
    super(issue.reason);
    this.name = "ImportFieldError";
  }
}

function reject(source_row_id: string, field: string, value: unknown, reason: string): never {
  throw new ImportFieldError({ source_row_id, field, value: String(value ?? ""), reason });
}

/** Run one field parse, recording its issue and continuing. */
function capture<T>(sink: ImportRejectedField[], parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ImportFieldError) {
      sink.push(error.issue);
      return undefined;
    }
    throw error;
  }
}

const MAX_EXPOSED_ISSUES = 100;
const MAX_EXPOSED_VALUE_CHARS = 256;

/**
 * Bounded, sandboxed failure payload. The fixed `error` string is load-bearing:
 * without it toolError() falls through to serializeUnknownError(), which
 * JSON.stringifies the whole payload into one 500-char string and defeats both
 * the sandbox wrapping and the truncation below.
 */
function wisePreflightFailure(rejected: ImportRejectedField[]) {
  return toolError({
    error: "Import preflight failed",
    category: "import_preflight_failed",
    source: "wise",
    rejected_field_count: rejected.length,
    rejected_fields_truncated: rejected.length > MAX_EXPOSED_ISSUES,
    rejected_fields: rejected.slice(0, MAX_EXPOSED_ISSUES).map(issue => ({
      source_row_id: issue.source_row_id,
      field: issue.field,
      value: wrapUntrustedOcr(issue.value.slice(0, MAX_EXPOSED_VALUE_CHARS)),
      reason: issue.reason,
    })),
    mutation_occurred: false,
  });
}

// Every column consumed into a WiseRow. `Batch` and `Created by` are accepted
// export columns that nothing reads, so they are not required; unrelated extra
// columns are allowed through untouched.
const WISE_ROW_HEADERS = [
  "ID", "Status", "Direction", "Created on", "Finished on",
  "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
  "Source name", "Source amount (after fees)", "Source currency",
  "Target name", "Target amount (after fees)", "Target currency",
  "Exchange rate", "Reference", "Category", "Note",
] as const;
type WiseRowHeader = typeof WISE_ROW_HEADERS[number];
type WiseHeaderIndex = (name: WiseRowHeader) => number;

const WISE_MONEY_REGEX = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const WISE_CURRENCY_REGEX = /^[A-Z]{3}$/;
const WISE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WISE_STATUS_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;
const WISE_TIMESTAMP_REGEX =
  /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function assertRealWiseDate(date: string, row: string, field: string, original: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return reject(row, field, original, "Expected YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  const roundTrips = utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day;
  return roundTrips ? date : reject(row, field, original, "Impossible calendar date");
}

function parseWiseMoney(value: unknown, row: string, field: string, defaultValue?: number): number {
  const text = String(value ?? "").trim();
  if (text === "" && defaultValue !== undefined) return defaultValue;
  if (!WISE_MONEY_REGEX.test(text)) {
    return reject(row, field, value, "Wise number must be a fully consumed finite decimal");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : reject(row, field, value, "Wise number must be finite");
}

function parseWiseNonNegativeMoney(value: unknown, row: string, field: string, defaultValue?: number): number {
  const amount = parseWiseMoney(value, row, field, defaultValue);
  return amount >= 0 ? amount : reject(row, field, value, "Wise amount must not be negative");
}

/**
 * `allowBlank` marks a timestamp Wise legitimately leaves empty. Only
 * "Finished on" qualifies: Wise blanks it for every transfer that never
 * completed, and callers already fall back to the creation date
 * (`wiseDate(row.finishedOn || row.createdOn)`), so a blank still books a real
 * date. Rejecting it would fail the whole file — preflight runs before the
 * status filter — turning one cancelled transfer into a blocked import.
 * "Created on" is the terminal operand of that `||`, so validating it strictly
 * is what guarantees the chain always yields a real date; a blank there is
 * rejected because nothing further can substitute for it. That is a
 * strengthening over the base, which booked `date: ""` when both timestamps
 * were blank; here the chain can no longer produce one.
 */
function parseWiseTimestamp(value: unknown, row: string, field: string, allowBlank = false): string {
  const text = String(value ?? "").trim();
  if (text === "" && allowBlank) return text;
  const match = WISE_TIMESTAMP_REGEX.exec(text);
  if (!match) return reject(row, field, value, "Invalid Wise timestamp");
  assertRealWiseDate(match[1]!, row, field, value);
  if (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)) {
    return reject(row, field, value, "Impossible Wise clock time");
  }
  // Preserve the trimmed text; the booking date is derived only after this.
  return text;
}

function parseWiseCurrency(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim().toUpperCase();
  return WISE_CURRENCY_REGEX.test(text)
    ? text
    : reject(row, field, value, "Expected a three-letter ISO currency code");
}

/**
 * A blank fee currency falls back to its own side's currency, matching what
 * bookedFeeCurrencyForWiseRow() resolves at use time \u2014 the source side against
 * sourceCurrency, the target side against targetCurrency \u2014 so the booked value
 * is unchanged. The use-time resolver still runs and still applies the same
 * fallback; resolving here only means the stored row already carries a real
 * currency rather than a blank. Both agree in every case, so this is
 * behavior-preserving, not a second, competing rule.
 */
function parseWiseOptionalCurrency(value: unknown, fallback: string, row: string, field: string): string {
  return String(value ?? "").trim() === "" ? fallback : parseWiseCurrency(value, row, field);
}

/**
 * Only the BLANK fallback needs the row's own side currency; whether a
 * non-blank value is well-formed is independent of every other field. Asserting
 * it in the field loop is what keeps a bad ID from hiding a bad fee currency —
 * buildWiseRow runs only for an otherwise-clean row, so a check that lived
 * solely there would go unreported on exactly the rows that need it most.
 */
function assertWiseOptionalCurrency(value: unknown, row: string, field: string): void {
  if (String(value ?? "").trim() === "") return;
  parseWiseCurrency(value, row, field);
}

/**
 * Validates the trimmed form; the caller stores the RAW field. The stored id
 * feeds three identity sinks — the `WISE:{id}` transaction description
 * (:1334), the journal `document_number`, which carries the raw unprefixed id
 * (:1711), and the M04 command digest (sha256(rowIndex\0action\0id)) — so
 * normalizing it here would silently shift the identity of every row against
 * ledgers imported before M05.
 */
function assertWiseId(value: unknown, row: string): void {
  const text = String(value ?? "").trim();
  if (!WISE_ID_REGEX.test(text)) {
    reject(row, "ID", value, "Wise ID must be 1-128 characters of ASCII alphanumerics, '.', '_', ':' or '-'");
  }
}

/**
 * Validates the trimmed form but returns nothing: the caller stores the RAW
 * field. Eligibility stays the raw `r.status !== "COMPLETED"` comparison in
 * the eligible-rows filter, so normalizing the stored value \u2014 by uppercasing OR by trimming \u2014
 * would make a `completed` / `" COMPLETED "` row that is silently filtered
 * today newly eligible for mutation. That is a new mutation path, not a
 * tightening, and the global constraints forbid it. Validate the trimmed form;
 * store the bytes as sent.
 */
function assertWiseStatus(value: unknown, row: string): void {
  const text = String(value ?? "").trim();
  if (!WISE_STATUS_REGEX.test(text)) {
    reject(row, "Status", value, "Wise status must be uppercase alphanumerics or underscore");
  }
}

/**
 * Validates AFTER the existing normalizeWiseDirection() casing rules, so a
 * lowercase direction that works today keeps working. The caller stores the RAW
 * field; every consumer normalizes at use time.
 */
function assertWiseDirection(value: unknown, row: string): void {
  if (normalizeWiseDirection(String(value ?? "")) === undefined) {
    reject(row, "Direction", value, "Wise direction must be IN, OUT or NEUTRAL");
  }
}

function validateWiseHeaders(
  records: string[][],
  rejected: ImportRejectedField[],
): { headers: string[]; idx: WiseHeaderIndex } {
  const headers = records[0]!.map(header => header.replace(/^\uFEFF/, "").trim());
  for (const expected of WISE_ROW_HEADERS) {
    const count = headers.filter(header => header === expected).length;
    if (count !== 1) {
      rejected.push({
        source_row_id: "wise:header",
        field: expected,
        value: String(count),
        reason: count === 0 ? "Missing expected header" : "Header occurs more than once",
      });
    }
  }
  return { headers, idx: name => headers.indexOf(name) };
}

function parseWiseExchangeRate(value: unknown, row: string): number {
  const rate = parseWiseMoney(value, row, "Exchange rate", 1);
  return rate > 0 ? rate : reject(row, "Exchange rate", value, "Wise exchange rate must be positive");
}

/**
 * Fields whose VALUE is derived by validation. `id`, `status`, and `direction`
 * are deliberately absent: they are validated but stored raw, because their
 * stored bytes decide filtering eligibility and M04 identity.
 */
interface ValidatedWiseFields {
  createdOn: string; finishedOn: string;
  sourceAmount: number; targetAmount: number;
  sourceCurrency: string; targetCurrency: string;
  sourceFeeAmount: number; targetFeeAmount: number;
  exchangeRate: number;
}

function buildWiseRow(
  fields: string[],
  idx: WiseHeaderIndex,
  row: string,
  rowIndex: number,
  valid: ValidatedWiseFields,
): WiseRow {
  return {
    // Preserved verbatim: every M04 command key and approval digest is derived
    // from rowIndex.
    rowIndex,
    // id / status / direction are validated but stored EXACTLY as sent.
    // Normalizing them here would change behavior rather than tighten it:
    // a trimmed status flips a padded " COMPLETED " row from filtered to
    // booked, and a trimmed id shifts the WISE:{id} description, the raw-id
    // journal document_number, and the M04 command digest alike.
    id: fields[idx("ID")] ?? "",
    status: fields[idx("Status")] ?? "",
    direction: fields[idx("Direction")] ?? "",
    createdOn: valid.createdOn,
    finishedOn: valid.finishedOn,
    sourceFeeAmount: valid.sourceFeeAmount,
    // Only the fee CURRENCIES depend on other validated fields (their own
    // side's currency), so they resolve here rather than in the field loop.
    sourceFeeCurrency: parseWiseOptionalCurrency(fields[idx("Source fee currency")], valid.sourceCurrency, row, "Source fee currency"),
    targetFeeAmount: valid.targetFeeAmount,
    targetFeeCurrency: parseWiseOptionalCurrency(fields[idx("Target fee currency")], valid.targetCurrency, row, "Target fee currency"),
    sourceName: fields[idx("Source name")] ?? "",
    sourceAmount: valid.sourceAmount,
    sourceCurrency: valid.sourceCurrency,
    targetName: fields[idx("Target name")] ?? "",
    targetAmount: valid.targetAmount,
    targetCurrency: valid.targetCurrency,
    exchangeRate: valid.exchangeRate,
    reference: fields[idx("Reference")] ?? "",
    category: fields[idx("Category")] ?? "",
    note: fields[idx("Note")] ?? "",
  };
}

function preflightWiseCsv(csv: string): WisePreflightResult {
  const records = parseCSV(csv, ",", 10 * 1024 * 1024).filter(record => record.some(field => field.trim() !== ""));
  // A headers-only file is a structural error: there is no data row to address.
  if (records.length < 2) throw new Error("CSV has no data rows");

  const rejected: ImportRejectedField[] = [];
  const { headers, idx } = validateWiseHeaders(records, rejected);
  // Header issues short-circuit: with a missing header idx() returns -1 and
  // every row would manufacture a derived issue, burying the real cause and
  // potentially evicting it under the exposure cap.
  if (rejected.length > 0) return { ok: false, source: "wise", rejected_fields: rejected };

  const rows: WiseRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const fields = records[i]!;
    // Positional identity: the ordinal of this data record, == rowIndex + 1.
    // Never the Wise ID \u2014 that is attacker-controlled.
    const rowId = `wise:row:${i}`;

    if (fields.length !== headers.length) {
      rejected.push({
        source_row_id: rowId,
        field: "row",
        value: String(fields.length),
        reason: `Expected ${headers.length} columns`,
      });
      continue;
    }

    // EVERY independently checkable field is validated before the row is
    // abandoned, so one pass reports all of a row's defects rather than only
    // the first. Anything that depends on nothing else belongs here rather
    // than in buildWiseRow, which runs only for an otherwise-clean row: a bad
    // ID must not hide a bad rate.
    const before = rejected.length;
    // Validated in place; their raw bytes are what buildWiseRow stores.
    capture(rejected, () => assertWiseId(fields[idx("ID")], rowId));
    capture(rejected, () => assertWiseStatus(fields[idx("Status")], rowId));
    capture(rejected, () => assertWiseDirection(fields[idx("Direction")], rowId));
    // Only the blank fallback is side-dependent, so validate the non-blank
    // form here and leave buildWiseRow to resolve it.
    capture(rejected, () => assertWiseOptionalCurrency(fields[idx("Source fee currency")], rowId, "Source fee currency"));
    capture(rejected, () => assertWiseOptionalCurrency(fields[idx("Target fee currency")], rowId, "Target fee currency"));
    const valid = {
      createdOn: capture(rejected, () => parseWiseTimestamp(fields[idx("Created on")], rowId, "Created on")),
      finishedOn: capture(rejected, () => parseWiseTimestamp(fields[idx("Finished on")], rowId, "Finished on", true)),
      sourceFeeAmount: capture(rejected, () => parseWiseNonNegativeMoney(fields[idx("Source fee amount")], rowId, "Source fee amount", 0)),
      targetFeeAmount: capture(rejected, () => parseWiseNonNegativeMoney(fields[idx("Target fee amount")], rowId, "Target fee amount", 0)),
      sourceAmount: capture(rejected, () => parseWiseNonNegativeMoney(fields[idx("Source amount (after fees)")], rowId, "Source amount (after fees)", 0)),
      targetAmount: capture(rejected, () => parseWiseNonNegativeMoney(fields[idx("Target amount (after fees)")], rowId, "Target amount (after fees)", 0)),
      sourceCurrency: capture(rejected, () => parseWiseCurrency(fields[idx("Source currency")], rowId, "Source currency")),
      targetCurrency: capture(rejected, () => parseWiseCurrency(fields[idx("Target currency")], rowId, "Target currency")),
      exchangeRate: capture(rejected, () => parseWiseExchangeRate(fields[idx("Exchange rate")], rowId)),
    };

    if (rejected.length !== before) continue;

    capture(rejected, () => rows.push(buildWiseRow(fields, idx, rowId, i - 1, valid as ValidatedWiseFields)));
  }

  // No partial rows: any issue rejects the whole file.
  return rejected.length > 0
    ? { ok: false, source: "wise", rejected_fields: rejected }
    : { ok: true, source: "wise", rows };
}

function wiseDate(dateStr: string): string {
  // "2026-01-19 17:59:56" or "2026-01-19T17:59:56" → "2026-01-19".
  // Both separators are accepted by WISE_TIMESTAMP_REGEX, so splitting on space
  // alone would hand the whole "…T…" string back as a booking date and skew the
  // date_from/date_to string comparisons.
  return dateStr.split(/[ T]/)[0] ?? dateStr;
}

function assertIsoDate(value: string | undefined, fieldName: "date_from" | "date_to"): void {
  if (value === undefined) return;
  const match = value.match(ISO_DATE_REGEX);
  if (!match) {
    throw new Error(`${fieldName} must be a valid date in YYYY-MM-DD format, got "${value}"`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} must be a valid date in YYYY-MM-DD format, got "${value}"`);
  }
}

function validateWiseDateRange(dateFrom: string | undefined, dateTo: string | undefined): void {
  assertIsoDate(dateFrom, "date_from");
  assertIsoDate(dateTo, "date_to");
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error(`date_from ${dateFrom} must be on or before date_to ${dateTo}`);
  }
}

function normalizeWiseDirection(direction: string): "IN" | "OUT" | "NEUTRAL" | undefined {
  const normalized = direction.trim().toUpperCase();
  if (normalized === "IN" || normalized === "OUT" || normalized === "NEUTRAL") {
    return normalized;
  }
  return undefined;
}

function sourceDirectionForWiseDirection(direction: string): "IN" | "OUT" | undefined {
  const normalized = normalizeWiseDirection(direction);
  return normalized === "IN" || normalized === "OUT" ? normalized : undefined;
}

function transactionTypeForWiseDirection(direction: string): "C" | undefined {
  return sourceDirectionForWiseDirection(direction) ? "C" : undefined;
}

function counterpartyNameForWiseRow(row: WiseRow): string | undefined {
  const sourceDirection = sourceDirectionForWiseDirection(row.direction);
  if (sourceDirection === "IN") {
    return row.sourceName || row.targetName || undefined;
  }
  if (sourceDirection === "OUT") {
    return row.targetName || row.sourceName || undefined;
  }
  return row.targetName || row.sourceName || undefined;
}

function isNonErrorWiseSkipReason(reason: string): boolean {
  return reason.startsWith("Already imported") ||
    reason.startsWith("Fee already imported") ||
    reason.startsWith("Unsupported Wise direction") ||
    reason === "Skipped because main transaction was not created";
}

function summarizeWiseSkippedEntries(skipped: Array<{ wise_id: string; reason: string }>) {
  const groups = new Map<string, { reason: string; count: number; sample_ids: string[] }>();
  for (const entry of skipped) {
    const existing = groups.get(entry.reason);
    if (existing) {
      existing.count++;
      if (existing.sample_ids.length < 5) existing.sample_ids.push(entry.wise_id);
    } else {
      groups.set(entry.reason, { reason: entry.reason, count: 1, sample_ids: [entry.wise_id] });
    }
  }
  return [...groups.values()];
}

function normalizeWiseText(value?: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeWiseCompanyName(value?: unknown): string {
  return typeof value === "string" ? normalizeCompanyName(value) : "";
}

function normalizeWiseCurrency(value?: string | null, fallback = "EUR"): string {
  const normalized = value?.trim().toUpperCase();
  return normalized || fallback;
}

function ownAccountSideForWiseRow(row: WiseRow): "source" | "target" | undefined {
  const sourceDirection = sourceDirectionForWiseDirection(row.direction);
  if (sourceDirection === "OUT") return "source";
  if (sourceDirection === "IN") return "target";
  return undefined;
}

function bookedAmountForWiseRow(row: WiseRow): number {
  return ownAccountSideForWiseRow(row) === "target" ? row.targetAmount : row.sourceAmount;
}

function bookedCurrencyForWiseRow(row: WiseRow): string {
  return ownAccountSideForWiseRow(row) === "target"
    ? normalizeWiseCurrency(row.targetCurrency)
    : normalizeWiseCurrency(row.sourceCurrency);
}

function bookedFeeAmountForWiseRow(row: WiseRow): number {
  return ownAccountSideForWiseRow(row) === "target" ? row.targetFeeAmount : row.sourceFeeAmount;
}

function bookedFeeCurrencyForWiseRow(row: WiseRow, fallbackCurrency: string): string {
  return ownAccountSideForWiseRow(row) === "target"
    ? normalizeWiseCurrency(row.targetFeeCurrency, fallbackCurrency)
    : normalizeWiseCurrency(row.sourceFeeCurrency, fallbackCurrency);
}

function oppositeSideForWiseRow(row: WiseRow): { amount: number; currency: string } {
  return ownAccountSideForWiseRow(row) === "target"
    ? { amount: row.sourceAmount, currency: normalizeWiseCurrency(row.sourceCurrency) }
    : { amount: row.targetAmount, currency: normalizeWiseCurrency(row.targetCurrency) };
}

/** Detect Wise Jar (savings pot) transfers — internal movements, not real payments.
 * Checks explicit Jar indicators and self-transfer heuristic (same name, currency, zero fee).
 * The self-transfer heuristic works because real inter-account transfers (e.g. LHV→Wise)
 * typically have slightly different names (e.g. "OÜ" vs "OU" from bank registration).
 * If this incorrectly filters legitimate transfers, set skip_jar_transfers=false. */
function isJarTransfer(row: WiseRow): boolean {
  const catLower = row.category.toLowerCase();
  const noteLower = row.note.toLowerCase();
  const refLower = row.reference.toLowerCase();

  // Explicit Jar indicators
  if (catLower.includes("jar")) return true;
  if (noteLower.includes("jar")) return true;
  if (refLower.includes("jar")) return true;

  // Self-transfer: source and target are the same person/company,
  // same currency, zero fee (to avoid false-positives on owner payments)
  const src = normalizeWiseText(row.sourceName);
  const tgt = normalizeWiseText(row.targetName);
  if (src && tgt && src === tgt && row.sourceCurrency === row.targetCurrency && row.sourceFeeAmount === 0) return true;

  return false;
}

function stripWisePrefix(description?: string | null): string {
  return (description ?? "")
    .replace(/^WISE:(?:FEE:)?\S+\s*/i, "")
    .replace(/\s*\[source_direction=(?:IN|OUT)\]\s*$/i, "")
    .trim();
}

function withWiseSourceDirection(description: string, sourceDirection: "IN" | "OUT"): string {
  return `${description} [source_direction=${sourceDirection}]`;
}

function formatWiseAmount(amount: number): string {
  return amount.toFixed(2);
}

function buildWiseTransactionSignature(
  date: string,
  amount: number,
  currency: string,
  bankAccountName?: string | null,
  refNumber?: string | null,
  description?: string | null,
): string {
  return [
    date,
    formatWiseAmount(amount),
    normalizeWiseCurrency(currency),
    normalizeWiseText(bankAccountName),
    normalizeWiseText(refNumber),
    normalizeWiseText(description),
  ].join("|");
}

function resolveWiseFeeAccountDimensionId(
  accountDimensions: AccountDimension[],
  feeAccountDimensionId: number | undefined,
  deprecatedFeeAccountRelationId: number | undefined,
): number {
  if (
    feeAccountDimensionId !== undefined &&
    deprecatedFeeAccountRelationId !== undefined &&
    feeAccountDimensionId !== deprecatedFeeAccountRelationId
  ) {
    throw new Error("fee_account_dimensions_id and fee_account_relation_id must match when both are provided");
  }

  const resolved = feeAccountDimensionId ?? deprecatedFeeAccountRelationId;
  if (resolved !== undefined) {
    return resolved;
  }

  const defaultFeeDimensions = accountDimensions.filter((item) =>
    !item.is_deleted &&
    item.accounts_id === DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT &&
    item.id !== undefined,
  );
  if (defaultFeeDimensions.length === 1) {
    return defaultFeeDimensions[0]!.id!;
  }

  if (defaultFeeDimensions.length > 1) {
    const candidateIds = defaultFeeDimensions.map((item) => item.id).join(", ");
    throw new Error(
      `Wise fee rows require fee_account_dimensions_id because account ${DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT} has multiple active dimensions (${candidateIds}).`
    );
  }

  throw new Error(
    `Wise fee rows require fee_account_dimensions_id. No unique active dimension for account ${DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT} was found. Use list_account_dimensions to find it.`
  );
}

function buildAccountDistributionFromDimension(
  accountDimensions: AccountDimension[],
  accountsDimensionsId: number,
  amount: number,
) {
  const dimension = accountDimensions.find(item => item.id === accountsDimensionsId && !item.is_deleted);
  if (!dimension?.id) {
    throw new Error(
      `Account dimension ${accountsDimensionsId} not found. Use list_account_dimensions to find a valid fee account dimension ID.`
    );
  }

  return {
    related_table: "accounts" as const,
    related_id: dimension.accounts_id,
    related_sub_id: dimension.id,
    amount,
  };
}

function resolveOwnCompanyClientId(
  companyName: string | undefined,
  matches: Array<{ id?: number; name?: string | null }>,
): number | undefined {
  const normalizedTarget = normalizeWiseCompanyName(companyName);
  if (!normalizedTarget) return undefined;

  const exactMatches = matches.filter(
    (client) => client.id !== undefined && normalizeWiseCompanyName(client.name) === normalizedTarget,
  );

  if (exactMatches.length === 1) {
    return exactMatches[0]!.id;
  }

  return undefined;
}

const WISE_COMMAND_VERSION = "wise_import_command_v2";
const WISE_APPROVAL_DOMAIN = "e-arveldaja-mcp/wise-import";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const WISE_COMMAND_PROJECTION_SECRET = randomBytes(32);
const wiseExecutionLocks = new Map<string, Promise<void>>();

type TransactionCreatePayload = Parameters<ApiContext["transactions"]["create"]>[0];
type TransactionConfirmPayload = Parameters<ApiContext["transactions"]["confirm"]>[1];

interface WiseCommandBase {
  version: typeof WISE_COMMAND_VERSION;
  row_index: number;
  row_key: string;
  identity_hash: string;
  wise_id: string;
  date: string;
  transaction_type: "C";
  source_direction: "IN" | "OUT";
  booked_amount: number;
  booked_currency: string;
  source_amount: number;
  source_currency: string;
  target_amount: number;
  target_currency: string;
  exchange_rate: number;
  exchange_rate_orientation: "source_to_target";
  wise_dimension_id: number;
  depends_on: string | null;
}

interface MainCreateCommand extends WiseCommandBase {
  action: "main_create";
  mutation_mode: "create";
  create_payload: TransactionCreatePayload;
}

interface FeeCreateCommand extends WiseCommandBase {
  action: "fee_create_and_confirm";
  mutation_mode: "create_then_confirm";
  posting_account_id: number;
  posting_dimension_id: number;
  create_payload: TransactionCreatePayload;
  confirmation_distribution: TransactionConfirmPayload;
  wise_client_id: number;
}

interface InterAccountCommand extends WiseCommandBase {
  action: "inter_account";
  mutation_mode: "create_then_confirm" | "create_only_already_journalized";
  counterpart_dimension_id: number;
  flow_source_dimension_id: number;
  flow_target_dimension_id: number;
  posting_account_id: number;
  posting_dimension_id: number;
  ownership_basis: WiseTransferOwnershipBasis;
  existing_journal_id: number | null;
  client_update: { clients_id: number } | null;
  confirmation_distribution: TransactionConfirmPayload | null;
  current_journal_state: unknown;
  current_client_state: unknown;
}

interface PurchaseInvoiceUpdateCommand extends WiseCommandBase {
  action: "purchase_invoice_update";
  mutation_mode: "update_existing";
  existing_object_id: number;
  update_payload: Partial<PurchaseInvoice>;
  category: "foreign_currency_lock" | "eur_legacy_autofix";
  current_object_state: PurchaseInvoice;
}

type WiseImportCommand = MainCreateCommand | FeeCreateCommand | InterAccountCommand | PurchaseInvoiceUpdateCommand;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map(key => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function approvalDigest(snapshot: unknown): string {
  return sha256(JSON.stringify(canonicalize(snapshot)));
}

async function acquireWiseExecutionLock(connectionFingerprint: string): Promise<() => void> {
  const previous = wiseExecutionLocks.get(connectionFingerprint) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const tail = previous.then(() => gate);
  wiseExecutionLocks.set(connectionFingerprint, tail);
  await previous;
  return () => {
    releaseGate();
    if (wiseExecutionLocks.get(connectionFingerprint) === tail) wiseExecutionLocks.delete(connectionFingerprint);
  };
}

function transactionCommandExists(
  command: MainCreateCommand | FeeCreateCommand,
  transactions: Awaited<ReturnType<ApiContext["transactions"]["listAll"]>>,
): boolean {
  const live = transactions.filter(isNonVoidTransaction);
  const wiseTag = `WISE:${command.wise_id}`;
  if (live.some(transaction => transaction.description?.startsWith(`${wiseTag} `) || transaction.description === wiseTag)) {
    return true;
  }
  const payload = command.create_payload;
  if (typeof payload.date !== "string" || typeof payload.amount !== "number") return false;
  const expectedSignature = buildWiseTransactionSignature(
    payload.date,
    payload.amount,
    payload.cl_currencies_id ?? "EUR",
    payload.bank_account_name,
    payload.ref_number,
    stripWisePrefix(payload.description),
  );
  return live.some(transaction =>
    typeof transaction.date === "string" && typeof transaction.amount === "number" &&
    buildWiseTransactionSignature(
      transaction.date,
      transaction.amount,
      transaction.cl_currencies_id ?? "EUR",
      transaction.bank_account_name,
      transaction.ref_number,
      stripWisePrefix(transaction.description),
    ) === expectedSignature
  );
}

function createdTransactionMatchesApprovedPayload(
  transaction: Awaited<ReturnType<ApiContext["transactions"]["listAll"]>>[number] | undefined,
  apiId: number,
  payload: TransactionCreatePayload,
): boolean {
  if (!transaction || transaction.id !== apiId || !isProjectTransaction(transaction)) {
    return false;
  }
  const sameOptional = (actual: unknown, expected: unknown) =>
    expected === undefined || expected === null
      ? actual === undefined || actual === null
      : actual === expected;
  return transaction.accounts_dimensions_id === payload.accounts_dimensions_id &&
    transaction.type === payload.type &&
    transaction.amount === payload.amount &&
    transaction.cl_currencies_id === payload.cl_currencies_id &&
    transaction.date === payload.date &&
    sameOptional(transaction.bank_account_name, payload.bank_account_name) &&
    sameOptional(transaction.ref_number, payload.ref_number) &&
    sameOptional(transaction.description, payload.description) &&
    sameOptional(transaction.clients_id, payload.clients_id);
}

function exactStateMatches(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function commandIdentity(row: WiseRow, action: string): string {
  return sha256(`${row.rowIndex}\0${action}\0${row.id}`);
}

function projectUntrustedCommandText(
  command: WiseImportCommand,
  field: string,
  text: string | null | undefined,
): string | null | undefined {
  if (text === undefined || text === null || text === "") return text;
  const nonce = createHmac("sha256", WISE_COMMAND_PROJECTION_SECRET)
    .update(`${command.identity_hash}\0${field}\0${text}`)
    .digest("hex")
    .slice(0, 32);
  return `${UNTRUSTED_OCR_START_PREFIX}${nonce}>>\n${text}\n${UNTRUSTED_OCR_END_PREFIX}${nonce}>>`;
}

function projectTransactionCreatePayload(command: MainCreateCommand | FeeCreateCommand): Record<string, unknown> {
  const payload = command.create_payload;
  return {
    accounts_dimensions_id: payload.accounts_dimensions_id,
    type: payload.type,
    amount: payload.amount,
    cl_currencies_id: payload.cl_currencies_id,
    date: payload.date,
    ...(payload.bank_account_name !== undefined
      ? { bank_account_name: projectUntrustedCommandText(command, "bank_account_name", payload.bank_account_name) }
      : {}),
    ...(payload.ref_number !== undefined
      ? { ref_number: projectUntrustedCommandText(command, "ref_number", payload.ref_number) }
      : {}),
    ...(payload.description !== undefined
      ? { description: projectUntrustedCommandText(command, "description", payload.description) }
      : {}),
    ...(payload.clients_id !== undefined ? { clients_id: payload.clients_id } : {}),
  };
}

function projectWiseCommand(command: WiseImportCommand): Record<string, unknown> {
  const common = {
    action: command.action,
    mutation_mode: command.mutation_mode,
    date: command.date,
    row_key: command.row_key,
    identity_hash: command.identity_hash,
    wise_id: projectUntrustedCommandText(command, "wise_id", command.wise_id),
    transaction_type: command.transaction_type,
    source_direction: command.source_direction,
    booked_amount: command.booked_amount,
    booked_currency: command.booked_currency,
    source_amount: command.source_amount,
    source_currency: command.source_currency,
    target_amount: command.target_amount,
    target_currency: command.target_currency,
    exchange_rate: command.exchange_rate,
    exchange_rate_orientation: command.exchange_rate_orientation,
    wise_dimension_id: command.wise_dimension_id,
    depends_on: command.depends_on,
  };
  switch (command.action) {
    case "main_create":
      return {
        ...common,
        create_payload: projectTransactionCreatePayload(command),
      };
    case "fee_create_and_confirm":
      return {
        ...common,
        posting_account_id: command.posting_account_id,
        posting_dimension_id: command.posting_dimension_id,
        wise_client_id: command.wise_client_id,
        create_payload: projectTransactionCreatePayload(command),
        confirmation_distribution: command.confirmation_distribution,
      };
    case "inter_account":
      return {
        ...common,
        counterpart_dimension_id: command.counterpart_dimension_id,
        flow_source_dimension_id: command.flow_source_dimension_id,
        flow_target_dimension_id: command.flow_target_dimension_id,
        posting_account_id: command.posting_account_id,
        posting_dimension_id: command.posting_dimension_id,
        ownership_basis: command.ownership_basis,
        existing_journal_id: command.existing_journal_id,
        client_update: command.client_update,
        confirmation_distribution: command.confirmation_distribution,
      };
    case "purchase_invoice_update":
      return {
        ...common,
        existing_object_id: command.existing_object_id,
        category: command.category,
        update_payload: command.category === "foreign_currency_lock"
          ? {
              currency_rate: command.update_payload.currency_rate,
              base_gross_price: command.update_payload.base_gross_price,
            }
          : { gross_price: command.update_payload.gross_price },
      };
  }
}

function digestMismatch() {
  return toolError({
    error: "The Wise command approval digest does not match the current mutation plan.",
    category: "digest_mismatch",
    code: "approval_digest_mismatch",
    mutation_occurred: false,
    known_object_ids: [],
    affected_cache_names: [],
    next_action: "Run a new Wise dry run, review its complete command plan, and approve that exact digest.",
  });
}

export function registerWiseImportTools(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);

  registerTool(server, "import_wise_transactions",
    "Import Wise transaction-history CSV rows. Direct-call contract: DRY RUN by default; execute=true creates rows; every created bank row uses API type C while source_direction preserves IN/OUT flow; fees use separate C transactions; inter-account transfers avoid double-counting confirmed counterpart journals.",
    {
      file_path: z.string().optional().describe("Absolute path/base64 Wise CSV input. Provide exactly one of file_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox Wise CSV reference. Provide exactly one of file_path or file_ref."),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID for the Wise account in e-arveldaja"),
      fee_account_dimensions_id: z.number().optional().describe("Account dimension ID for the Wise fee expense account."),
      fee_account_relation_id: z.number().optional().describe("Deprecated alias for fee_account_dimensions_id."),
      inter_account_dimension_id: coerceId.optional().describe(
        "Other bank account dimension ID for inter-account transfers. Auto-detected if only one other bank account exists; required with 3+ bank accounts."
      ),
      confirm_own_transfer_ids: z.array(z.string().min(1)).optional().describe(
        "Exact Wise IDs explicitly approved as own transfers. TRANSFER-* and BANK_DETAILS_PAYMENT_RETURN-* prefixes are hints only."
      ),
      approved_command_digest: z.string().regex(SHA256_HEX).optional().describe(
        "Exact lowercase SHA-256 command digest returned by the reviewed dry run. Required for execute=true when mutations are planned."
      ),
      execute: z.boolean().optional().describe("Actually create transactions (default false = dry run)"),
      date_from: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").optional().describe("Only import transactions from this date (YYYY-MM-DD)"),
      date_to: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").optional().describe("Only import transactions up to this date (YYYY-MM-DD)"),
      skip_jar_transfers: z.boolean().optional().describe("Skip Jar (savings pot) transfers — internal movements within Wise (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Import Wise Transactions" },
    async ({
      file_path,
      file_ref,
      accounts_dimensions_id,
      fee_account_dimensions_id,
      fee_account_relation_id,
      inter_account_dimension_id,
      confirm_own_transfer_ids,
      approved_command_digest,
      execute,
      date_from,
      date_to,
      skip_jar_transfers,
    }) => {
      if (approved_command_digest !== undefined && (
        typeof approved_command_digest !== "string" || !SHA256_HEX.test(approved_command_digest)
      )) {
        return digestMismatch();
      }
      if (execute === true && !SHA256_HEX.test(approved_command_digest ?? "")) {
        return digestMismatch();
      }
      validateWiseDateRange(date_from, date_to);

      const skipJars = skip_jar_transfers !== false;
      const inputSnapshot = await captureFileInputSnapshot({
        ...(file_path !== undefined ? { file_path } : {}),
        ...(file_ref !== undefined ? { file_ref } : {}),
      }, {
        runtimeSafetyContext,
        operation: FILE_REFERENCE_OPERATIONS.wise,
        allowedExtensions: [".csv"],
        maxSize: 10 * 1024 * 1024,
      });
      const csvBytes = inputSnapshot.bytes();
      const csv = csvBytes.toString("utf8");
      const rawCsvSha256 = sha256(csvBytes);
      // Preflight before the cache clear, every API read, progress report,
      // audit entry, and mutation. A valid digest over a malformed CSV fails
      // here and never hands back a replacement digest.
      const preflight = preflightWiseCsv(csv);
      if (!preflight.ok) return wisePreflightFailure(preflight.rejected_fields);
      const rows = preflight.rows;
      const executeRequested = execute === true;
      // Planning is always side-effect free. Approved execution consumes the
      // compiled command payloads after the digest gate below.
      const dryRun = true;
      clearRuntimeCaches();

      // Filter rows
      let skippedJarCount = 0;
      // Jar-filtered rows used to be counted but invisible in the response.
      // Surface them as full skip records so a user auditing why a known
      // transfer wasn't imported can see it landed in the Jar branch.
      const skippedJarRows: Array<{ wise_id: string; reason: string; amount: number; date: string }> = [];
      const eligible = rows.filter(r => {
        if (r.status !== "COMPLETED") return false;
        if (normalizeWiseDirection(r.direction) === "NEUTRAL") return false;
        if (r.sourceAmount === 0 && r.targetAmount === 0) return false;
        if (skipJars && isJarTransfer(r)) {
          skippedJarCount++;
          skippedJarRows.push({
            wise_id: r.id,
            reason: "Jar / self-transfer detected (pass skip_jar_transfers=false to include)",
            amount: r.sourceAmount !== 0 ? r.sourceAmount : r.targetAmount,
            date: wiseDate(r.finishedOn || r.createdOn),
          });
          return false;
        }
        const date = wiseDate(r.finishedOn || r.createdOn);
        if (date_from && date < date_from) return false;
        if (date_to && date > date_to) return false;
        return true;
      });

      const hintedRows = eligible.filter(isWiseTransferCandidate);
      const approvedTransferIds = confirm_own_transfer_ids ?? [];
      if (new Set(approvedTransferIds).size !== approvedTransferIds.length) {
        throw new Error("confirm_own_transfer_ids must contain unique exact Wise transfer IDs.");
      }
      const eligibleHintIds = new Set(hintedRows.map(row => row.id));
      if (approvedTransferIds.some(id => !eligibleHintIds.has(id))) {
        throw new Error(
          "confirm_own_transfer_ids must reference eligible TRANSFER-* or BANK_DETAILS_PAYMENT_RETURN-* rows in this CSV exactly."
        );
      }

      let bankAccountsSnapshot: BankAccount[] = [];
      let invoiceInfoSnapshot: Awaited<ReturnType<typeof api.readonly.getInvoiceInfo>> | undefined;
      const accountDimensionsSnapshot: AccountDimension[] = await api.readonly.getAccountDimensions();
      let postingDimensionsSnapshot = new Map<number, AccountDimension>();
      let autoDetectedInterAccountDimId: number | undefined;
      const transferDecisions = new Map<WiseRow, WiseTransferDecision>();
      if (hintedRows.length > 0) {
        [bankAccountsSnapshot, invoiceInfoSnapshot] = await Promise.all([
          api.readonly.getBankAccounts(),
          api.readonly.getInvoiceInfo(),
        ]);
        const { dimensions: bankDimensions, identityDimensions } = bankIdentitiesByDimension(bankAccountsSnapshot);
        postingDimensionsSnapshot = uniqueActivePostingDimensions(accountDimensionsSnapshot);
        const configuredDimensions = new Set(
          [...bankDimensions].filter(id => postingDimensionsSnapshot.has(id)),
        );
        const wiseDimensionId = isPositiveSafeInteger(accounts_dimensions_id)
          ? accounts_dimensions_id
          : undefined;
        // Resolve endpoint direction from safe configured bank records first;
        // posting validity is a separate structural gate below so endpoint
        // booleans stay truthful when an otherwise-known bank dimension has a
        // missing, deleted, or ambiguous posting dimension.
        const otherDimensions = [...bankDimensions].filter(id => id !== wiseDimensionId);
        autoDetectedInterAccountDimId = otherDimensions.length === 1 ? otherDimensions[0] : undefined;
        const targetDimensionId = inter_account_dimension_id === undefined
          ? autoDetectedInterAccountDimId
          : isPositiveSafeInteger(inter_account_dimension_id)
            ? inter_account_dimension_id
            : undefined;
        const ownCompanyIdentity = normalizeWiseCompanyName(invoiceInfoSnapshot.invoice_company_name);
        const approvedSet = new Set(approvedTransferIds);

        for (const row of hintedRows) {
          const decision = classifyWiseOwnTransfer(
            row,
            wiseDimensionId,
            targetDimensionId,
            configuredDimensions,
            identityDimensions,
            ownCompanyIdentity,
            approvedSet.has(row.id),
          );
          transferDecisions.set(row, decision);
        }
      }

      const hasFeeRows = eligible.some(row => bookedFeeAmountForWiseRow(row) > 0);
      const accountDimensions = hasFeeRows
        ? accountDimensionsSnapshot
        : accountDimensionsSnapshot;
      const feeAccountDimensionsId = hasFeeRows
        ? resolveWiseFeeAccountDimensionId(accountDimensions, fee_account_dimensions_id, fee_account_relation_id)
        : undefined;

      // Find Wise client for fee transactions
      let wiseClientId: number | undefined;
      let allClientsSnapshot: Awaited<ReturnType<typeof api.clients.listAll>> = [];
      if (hasFeeRows) {
        allClientsSnapshot = await api.clients.listAll();
        const allClients = allClientsSnapshot;
        const wiseClient = allClients.find(c =>
          c.name?.toUpperCase() === "WISE" || c.name?.toUpperCase() === "TRANSFERWISE"
        );
        wiseClientId = wiseClient?.id;
        // Without a Wise client the fee rows can be created but never confirmed;
        // refuse the whole import up-front instead of leaving stray PROJECT rows.
        if (!wiseClientId) {
          return toolError({
            error: "Wise client not found — create a client named 'Wise' (or 'TransferWise') before importing with fee rows, otherwise every fee transaction is left unconfirmed and must be cleaned up manually.",
            mutation_occurred: false,
          });
        }
      }

      // Get existing transactions for duplicate detection
      const existingTx = (await api.transactions.listAll()).filter(isNonVoidTransaction);
      const existingSignatures = new Set(
        existingTx.flatMap(tx => (
          typeof tx.date === "string" && typeof tx.amount === "number"
            ? [buildWiseTransactionSignature(
                tx.date,
                tx.amount,
                tx.cl_currencies_id ?? "EUR",
                tx.bank_account_name,
                tx.ref_number,
                stripWisePrefix(tx.description),
              )]
            : []
        ))
      );
      // Also check by Wise ID in description
      const seenWiseIds = new Set(
        existingTx
          .filter(tx => tx.description?.startsWith("WISE:"))
          .map(tx => tx.description!.split(" ")[0])
      );

      const created: Array<{
        wise_id: string;
        date: string;
        type: string;
        source_direction: "IN" | "OUT";
        amount: number;
        description: string;
        status: string;
        api_id?: number;
        source_row?: WiseRow;
      }> = [];
      const skipped: Array<{ wise_id: string; reason: string }> = [];
      const commands: WiseImportCommand[] = [];
      const mainCommandKeysByRow = new Map<number, string>();

      const totalEligible = eligible.length;
      for (let i = 0; i < eligible.length; i++) {
        const row = eligible[i]!;
        const date = wiseDate(row.finishedOn || row.createdOn);
        const type = transactionTypeForWiseDirection(row.direction);
        const sourceDirection = sourceDirectionForWiseDirection(row.direction);
        if (!type || !sourceDirection) {
          skipped.push({ wise_id: row.id, reason: `Unsupported Wise direction "${row.direction}"` });
          continue;
        }
        const amount = bookedAmountForWiseRow(row);
        const fee = bookedFeeAmountForWiseRow(row);
        const transactionCurrency = bookedCurrencyForWiseRow(row);
        const wiseIdTag = `WISE:${row.id}`;
        const counterpartyName = counterpartyNameForWiseRow(row);
        const oppositeSide = oppositeSideForWiseRow(row);

        // Build description
        let desc = wiseIdTag;
        if (counterpartyName) desc += ` ${counterpartyName}`;
        if (row.category && row.category !== "General") desc += ` (${row.category})`;
        if (oppositeSide.currency !== transactionCurrency) {
          desc += ` [${oppositeSide.amount} ${oppositeSide.currency} @ ${row.exchangeRate}]`;
        }
        desc = withWiseSourceDirection(desc, sourceDirection);
        const legacyDesc = stripWisePrefix(desc);
        const mainSignatureCandidates = new Set(
          [counterpartyName, row.targetName || undefined, row.sourceName || undefined]
            .filter((name): name is string => Boolean(name))
            .map((name) => buildWiseTransactionSignature(
              date,
              amount,
              transactionCurrency,
              name,
              row.reference || undefined,
              legacyDesc,
            ))
        );
        const mainAlreadyImported = seenWiseIds.has(wiseIdTag) ||
          [...mainSignatureCandidates].some(signature => existingSignatures.has(signature));
        let mainAvailableForFee = false;

        if (mainAlreadyImported) {
          skipped.push({
            wise_id: row.id,
            reason: seenWiseIds.has(wiseIdTag)
              ? "Already imported (Wise ID match)"
              : "Already imported (date/amount/counterparty/reference match)",
          });
          mainAvailableForFee = true;
        } else {
          if (dryRun) {
            const createPayload: TransactionCreatePayload = {
              accounts_dimensions_id,
              type,
              amount,
              cl_currencies_id: transactionCurrency,
              date,
              description: desc,
              bank_account_name: counterpartyName,
              ref_number: row.reference || undefined,
            };
            commands.push({
              version: WISE_COMMAND_VERSION,
              action: "main_create",
              mutation_mode: "create",
              row_index: row.rowIndex,
              row_key: `row:${row.rowIndex}:main`,
              identity_hash: commandIdentity(row, "main"),
              wise_id: row.id,
              date,
              transaction_type: type,
              source_direction: sourceDirection,
              booked_amount: amount,
              booked_currency: transactionCurrency,
              source_amount: row.sourceAmount,
              source_currency: normalizeWiseCurrency(row.sourceCurrency),
              target_amount: row.targetAmount,
              target_currency: normalizeWiseCurrency(row.targetCurrency),
              exchange_rate: row.exchangeRate,
              exchange_rate_orientation: "source_to_target",
              wise_dimension_id: accounts_dimensions_id,
              depends_on: null,
              create_payload: createPayload,
            });
            mainCommandKeysByRow.set(row.rowIndex, `row:${row.rowIndex}:main`);
            created.push({
              wise_id: row.id,
              date,
              type,
              source_direction: sourceDirection,
              amount,
              description: desc,
              status: "would_create",
              source_row: row,
            });
            seenWiseIds.add(wiseIdTag);
            for (const signature of mainSignatureCandidates) {
              existingSignatures.add(signature);
            }
            mainAvailableForFee = true;
          } else {
            try {
              const result = await createBankTransaction(api, {
                accounts_dimensions_id,
                type,
                amount,
                cl_currencies_id: transactionCurrency,
                date,
                description: desc,
                bank_account_name: counterpartyName,
                ref_number: row.reference || undefined,
              });
              logAudit({
                tool: "import_wise_transactions", action: "IMPORTED", entity_type: "transaction",
                entity_id: result.created_object_id,
                summary: `Imported Wise transaction ${amount} ${transactionCurrency} on ${date}`,
                details: { date, amount, description: desc, counterparty: counterpartyName, wise_id: row.id },
              });
              created.push({
                wise_id: row.id,
                date,
                type,
                source_direction: sourceDirection,
                amount,
                description: desc,
                status: "created",
                api_id: result.created_object_id,
                source_row: row,
              });
              seenWiseIds.add(wiseIdTag);
              for (const signature of mainSignatureCandidates) {
                existingSignatures.add(signature);
              }
              mainAvailableForFee = true;
            } catch (err: unknown) {
              skipped.push({ wise_id: row.id, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }

        if (fee > 0) {
          if (!mainAvailableForFee) {
            skipped.push({
              wise_id: `FEE:${row.id}`,
              reason: "Skipped because main transaction was not created",
            });
            continue;
          }

          const feeWiseIdTag = `WISE:FEE:${row.id}`;
          const feeDesc = withWiseSourceDirection(`WISE:FEE:${row.id} Wise teenustasu`, "OUT");
          const feeCurrency = bookedFeeCurrencyForWiseRow(row, transactionCurrency);
          const feeSignature = buildWiseTransactionSignature(
            date,
            fee,
            feeCurrency,
            "Wise",
            undefined,
            stripWisePrefix(feeDesc),
          );
          if (seenWiseIds.has(feeWiseIdTag) || existingSignatures.has(feeSignature)) {
            skipped.push({
              wise_id: `FEE:${row.id}`,
              reason: seenWiseIds.has(feeWiseIdTag)
                ? "Fee already imported (Wise ID match)"
                : "Fee already imported (date/amount/counterparty match)",
            });
            continue;
          }

          const feeType = "C" as const; // Fees are always outgoing regardless of main transaction direction

          if (dryRun) {
            if (!feeAccountDimensionsId || !wiseClientId) {
              throw new Error("Wise fee planning requires resolved fee dimension and Wise client IDs");
            }
            const confirmationDistribution = [
              buildAccountDistributionFromDimension(accountDimensions, feeAccountDimensionsId, fee),
            ];
            commands.push({
              version: WISE_COMMAND_VERSION,
              action: "fee_create_and_confirm",
              mutation_mode: "create_then_confirm",
              row_index: row.rowIndex,
              row_key: `row:${row.rowIndex}:fee`,
              identity_hash: commandIdentity(row, "fee"),
              wise_id: `FEE:${row.id}`,
              date,
              transaction_type: feeType,
              source_direction: "OUT",
              booked_amount: fee,
              booked_currency: feeCurrency,
              source_amount: row.sourceAmount,
              source_currency: normalizeWiseCurrency(row.sourceCurrency),
              target_amount: row.targetAmount,
              target_currency: normalizeWiseCurrency(row.targetCurrency),
              exchange_rate: row.exchangeRate,
              exchange_rate_orientation: "source_to_target",
              wise_dimension_id: accounts_dimensions_id,
              depends_on: mainCommandKeysByRow.get(row.rowIndex) ?? null,
              posting_account_id: confirmationDistribution[0]!.related_id,
              posting_dimension_id: confirmationDistribution[0]!.related_sub_id!,
              create_payload: {
                accounts_dimensions_id,
                type: feeType,
                amount: fee,
                cl_currencies_id: feeCurrency,
                date,
                description: feeDesc,
                bank_account_name: "Wise",
                clients_id: wiseClientId,
              },
              confirmation_distribution: confirmationDistribution,
              wise_client_id: wiseClientId,
            });
            created.push({
              wise_id: `FEE:${row.id}`,
              date,
              type: feeType,
              source_direction: "OUT",
              amount: fee,
              description: feeDesc,
              status: "would_create",
            });
            seenWiseIds.add(feeWiseIdTag);
            existingSignatures.add(feeSignature);
          } else {
            try {
              const feeResult = await createBankTransaction(api, {
                accounts_dimensions_id,
                type: feeType,
                amount: fee,
                cl_currencies_id: feeCurrency,
                date,
                description: feeDesc,
                bank_account_name: "Wise",
                clients_id: wiseClientId,
              });
              logAudit({
                tool: "import_wise_transactions", action: "IMPORTED", entity_type: "transaction",
                entity_id: feeResult.created_object_id,
                summary: `Imported Wise fee ${fee} ${feeCurrency} on ${date}`,
                details: { date, amount: fee, description: feeDesc, wise_id: `FEE:${row.id}` },
              });
              const feeId = feeResult.created_object_id;

              // Auto-confirm fee to expense account
              if (feeId && wiseClientId) {
                try {
                  if (!feeAccountDimensionsId) throw new Error("Fee account dimension ID is undefined — should not happen when hasFeeRows is true");
                  await api.transactions.confirm(feeId, [
                    buildAccountDistributionFromDimension(accountDimensions, feeAccountDimensionsId, fee),
                  ]);
                  logAudit({
                    tool: "import_wise_transactions", action: "CONFIRMED", entity_type: "transaction",
                    entity_id: feeId,
                    summary: `Auto-confirmed Wise fee transaction ${feeId}: ${fee} ${feeCurrency} on ${date}`,
                    details: { amount: fee, currency: feeCurrency, date, description: feeDesc },
                  });
                  created.push({
                    wise_id: `FEE:${row.id}`,
                    date, type: feeType, source_direction: "OUT", amount: fee, description: feeDesc,
                    status: "created_and_confirmed",
                    api_id: feeId,
                  });
                  seenWiseIds.add(feeWiseIdTag);
                  existingSignatures.add(feeSignature);
                } catch (confErr: unknown) {
                  created.push({
                    wise_id: `FEE:${row.id}`,
                    date, type: feeType, source_direction: "OUT", amount: fee, description: feeDesc,
                    status: "created (confirm failed: " + (confErr instanceof Error ? confErr.message : String(confErr)) + ")",
                    api_id: feeId,
                  });
                  seenWiseIds.add(feeWiseIdTag);
                  existingSignatures.add(feeSignature);
                }
              } else {
                created.push({
                  wise_id: `FEE:${row.id}`,
                  date, type: feeType, source_direction: "OUT", amount: fee, description: feeDesc,
                  status: "created (needs manual confirm)",
                  api_id: feeId,
                });
                seenWiseIds.add(feeWiseIdTag);
                existingSignatures.add(feeSignature);
              }
            } catch (err: unknown) {
              skipped.push({ wise_id: `FEE:${row.id}`, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      }

      const ownershipReviews = created.flatMap(entry => {
        if (!entry.source_row) return [];
        const review = transferDecisions.get(entry.source_row)?.review;
        return review ? [review] : [];
      });

      const approvedTransferDecisions = [...transferDecisions.values()].filter(
        decision => decision.ownershipBasis !== undefined,
      );
      const journalSnapshot = approvedTransferDecisions.length > 0
        ? await api.journals.listAllWithPostings()
        : [];
      let ownCompanyClientMatches: Awaited<ReturnType<typeof api.clients.findByName>> = [];
      if (approvedTransferDecisions.length > 0 && invoiceInfoSnapshot?.invoice_company_name) {
        ownCompanyClientMatches = await api.clients.findByName(invoiceInfoSnapshot.invoice_company_name);
      }

      const ownCompanyClientId = resolveOwnCompanyClientId(
        invoiceInfoSnapshot?.invoice_company_name ?? undefined,
        ownCompanyClientMatches,
      );
      if (approvedTransferDecisions.length > 0) {
        const ownDimensionIds = new Set<number>([accounts_dimensions_id]);
        for (const decision of approvedTransferDecisions) {
          if (decision.targetDimensionId !== undefined) ownDimensionIds.add(decision.targetDimensionId);
        }
        const journalIndex = buildInterAccountJournalIndex(journalSnapshot, ownDimensionIds);
        let simulatedJournalId = -1;

        for (const entry of created) {
          const row = entry.source_row;
          if (!row || entry.status !== "would_create") continue;
          const decision = transferDecisions.get(row);
          const ownershipBasis = decision?.ownershipBasis;
          const targetDimensionId = decision?.targetDimensionId;
          const targetDim = targetDimensionId === undefined
            ? undefined
            : postingDimensionsSnapshot.get(targetDimensionId);
          if (!ownershipBasis || targetDimensionId === undefined || !targetDim?.id) continue;

          const roundedAmount = roundMoney(entry.amount);
          const key = `${accounts_dimensions_id}|${targetDimensionId}|${roundedAmount}|${entry.date}`;
          const candidates = journalIndex.get(key);
          const existingJournalId = findMatchingJournal(candidates, row.id);
          const existingJournal = existingJournalId === undefined
            ? undefined
            : journalSnapshot.find(journal => journal.id === existingJournalId);
          if (existingJournalId !== undefined && candidates) {
            const consumed = candidates.find(candidate => candidate.journal_id === existingJournalId);
            if (consumed && !(consumed.document_number ?? "").trim()) consumed.consumed = true;
          }

          const direction = sourceDirectionForWiseDirection(row.direction)!;
          const confirmationDistribution = existingJournalId === undefined
            ? [{
                related_table: "accounts" as const,
                related_id: targetDim.accounts_id,
                related_sub_id: targetDim.id,
                amount: entry.amount,
              }]
            : null;
          commands.push({
            version: WISE_COMMAND_VERSION,
            action: "inter_account",
            mutation_mode: existingJournalId === undefined
              ? "create_then_confirm"
              : "create_only_already_journalized",
            row_index: row.rowIndex,
            row_key: `row:${row.rowIndex}:inter_account`,
            identity_hash: commandIdentity(row, "inter_account"),
            wise_id: row.id,
            date: entry.date,
            transaction_type: "C",
            source_direction: direction,
            booked_amount: entry.amount,
            booked_currency: bookedCurrencyForWiseRow(row),
            source_amount: row.sourceAmount,
            source_currency: normalizeWiseCurrency(row.sourceCurrency),
            target_amount: row.targetAmount,
            target_currency: normalizeWiseCurrency(row.targetCurrency),
            exchange_rate: row.exchangeRate,
            exchange_rate_orientation: "source_to_target",
            wise_dimension_id: accounts_dimensions_id,
            depends_on: mainCommandKeysByRow.get(row.rowIndex) ?? null,
            counterpart_dimension_id: targetDimensionId,
            flow_source_dimension_id: direction === "IN" ? targetDimensionId : accounts_dimensions_id,
            flow_target_dimension_id: direction === "IN" ? accounts_dimensions_id : targetDimensionId,
            posting_account_id: targetDim.accounts_id,
            posting_dimension_id: targetDim.id,
            ownership_basis: ownershipBasis,
            existing_journal_id: existingJournalId ?? null,
            client_update: existingJournalId === undefined && ownCompanyClientId !== undefined
              ? { clients_id: ownCompanyClientId }
              : null,
            confirmation_distribution: confirmationDistribution,
            current_journal_state: existingJournal ?? null,
            current_client_state: ownCompanyClientMatches,
          });

          if (existingJournalId === undefined) {
            const simulated = {
              journal_id: simulatedJournalId--,
              document_number: row.id,
              origin: "in_run" as const,
            };
            const reverseKey = `${targetDimensionId}|${accounts_dimensions_id}|${roundedAmount}|${entry.date}`;
            for (const indexKey of [key, reverseKey]) {
              const indexed = journalIndex.get(indexKey);
              if (indexed) indexed.push(simulated);
              else journalIndex.set(indexKey, [simulated]);
            }
          }
        }
      }

      // --- Post-import: auto-reconcile inter-account transfers ---
      const interAccountResults: Array<{
        api_id: number;
        wise_id: string;
        amount: number;
        status: string;
        ownership_basis: WiseTransferOwnershipBasis;
        journal_id?: number;
        orphan_project_transaction_id?: number;
        orphan_action_hint?: string;
      }> = [];

      // A prefix only marks a candidate. Only a row-keyed preflight decision
      // with verified dimensions and ownership may enter reconciliation.
      const transferEntries = created.filter(entry => {
        if (!entry.api_id || entry.status !== "created" || !entry.source_row) return false;
        return transferDecisions.get(entry.source_row)?.ownershipBasis !== undefined;
      });

      if (transferEntries.length > 0 && !dryRun) {
        const firstDecision = transferDecisions.get(transferEntries[0]!.source_row!);
        const targetDimensionId = firstDecision?.targetDimensionId;
        const targetDim = targetDimensionId === undefined
          ? undefined
          : postingDimensionsSnapshot.get(targetDimensionId);

        // The bank snapshot proved this dimension is configured; the account
        // dimension supplies the posting account needed by confirm.
        if (targetDimensionId !== undefined && targetDim) {
          const ownDimensionIds = new Set([accounts_dimensions_id, targetDimensionId]);
          const guard = await BookingGuard.load(api, { ownDimensionIds });

          let companyClientId: number | undefined;
          const companyName = invoiceInfoSnapshot?.invoice_company_name;
          if (companyName) {
            const clients = await api.clients.findByName(companyName);
            companyClientId = resolveOwnCompanyClientId(companyName, clients);
          }

          for (const entry of transferEntries) {
            const decision = transferDecisions.get(entry.source_row!);
            const ownershipBasis = decision?.ownershipBasis;
            if (!ownershipBasis) continue;
            const roundedAmount = roundMoney(entry.amount);
            // Check both directions for an existing journal. The Wise ID acts
            // as a per-transfer reference — the guard only suppresses the
            // confirmation when an existing journal's document_number carries
            // the same reference (or no reference at all, preserving
            // pre-disambiguation behaviour).
            const existingJournal = guard.findInterAccount({
              sourceDim: accounts_dimensions_id,
              targetDim: targetDimensionId,
              amount: roundedAmount,
              date: entry.date,
              reference: entry.wise_id,
            });

            if (existingJournal) {
              interAccountResults.push({
                api_id: entry.api_id!,
                wise_id: entry.wise_id,
                amount: entry.amount,
                status: "already_journalized",
                ownership_basis: ownershipBasis,
                journal_id: existingJournal,
              });
            } else {
              // Confirm against the target bank account
              try {
                if (companyClientId) {
                  await api.transactions.update(entry.api_id!, { clients_id: companyClientId });
                }
                const confirmResult = await api.transactions.confirm(entry.api_id!, [{
                  related_table: "accounts",
                  related_id: targetDim.accounts_id,
                  related_sub_id: targetDim.id!,
                  amount: entry.amount,
                }]);
                // Record the new journal into the in-run index so the opposite
                // leg of this same transfer, if also queued in this batch, is
                // detected as already journalized instead of double-confirmed.
                guard.recordInterAccount({
                  sourceDim: accounts_dimensions_id,
                  targetDim: targetDimensionId,
                  amount: roundedAmount,
                  date: entry.date,
                  reference: entry.wise_id,
                }, confirmResult?.created_object_id);
                logAudit({
                  tool: "import_wise_transactions", action: "CONFIRMED", entity_type: "transaction",
                  entity_id: entry.api_id!,
                  summary: `Confirmed Wise inter-account transfer ${entry.amount} EUR`,
                  details: {
                    amount: entry.amount,
                    wise_id: entry.wise_id,
                    target_dimension_id: targetDim.id,
                    ownership_basis: ownershipBasis,
                  },
                });
                interAccountResults.push({
                  api_id: entry.api_id!,
                  wise_id: entry.wise_id,
                  amount: entry.amount,
                  status: "confirmed_inter_account",
                  ownership_basis: ownershipBasis,
                });
                // Update the created entry status
                entry.status = "created_and_confirmed_inter_account";
              } catch (err: unknown) {
                // Orphan-PROJECT warning: the transaction was created in the
                // API (api_id assigned) but confirmation failed. A retry
                // would hit the wise-ID dedup and skip, leaving the row
                // permanently in PROJECT status. Surface api_id explicitly
                // as `orphan_project_transaction_id` so the user can
                // invalidate/retry manually.
                const errorMessage = err instanceof Error ? err.message : String(err);
                interAccountResults.push({
                  api_id: entry.api_id!,
                  wise_id: entry.wise_id,
                  amount: entry.amount,
                  status: "confirm_failed: " + errorMessage,
                  ownership_basis: ownershipBasis,
                  orphan_project_transaction_id: entry.api_id!,
                  orphan_action_hint: `Transaction ${entry.api_id} was created but left in PROJECT status. Rerunning the import will skip it via wise_id dedup. To retry confirmation: invalidate_transaction(${entry.api_id}), then delete_transaction(${entry.api_id}) and rerun — or confirm_transaction(${entry.api_id}) manually against the target bank account.`,
                });
              }
            }
          }
        }
      }

      // --- Post-import: scan eligible payment rows for unpaid purchase
      // invoices that should be repriced to Wise's actual EUR conversion.
      // This addresses the recurring kursivahe jääk on USD/foreign-currency
      // card payments where the original booking used a guessed rate.
      const invoiceFixCandidates: Array<{
        row_index: number;
        wise_id: string;
        date: string;
        supplier_name: string;
        target_amount: number;
        target_currency: string;
        source_amount_eur: number;
        wise_currency_rate: number;
        invoice_id: number;
        invoice_number: string;
        invoice_currency: string;
        invoice_gross: number;
        current_base_gross?: number;
        current_currency_rate?: number;
        category: "foreign_currency_lock" | "eur_legacy_autofix";
        proposed_action: string;
        result?: "would_update" | "updated" | "error" | "ambiguous_skipped" | "already_matches";
        error?: string;
        current_object_state: PurchaseInvoice;
      }> = [];

      const paymentRows = eligible.filter(r => sourceDirectionForWiseDirection(r.direction) === "OUT" && bookedAmountForWiseRow(r) > 0);
      const purchaseInvoicesApi = api.purchaseInvoices;
      const hasPaymentCandidates = paymentRows.length > 0 && purchaseInvoicesApi !== undefined;
      const allPurchaseInvoices = hasPaymentCandidates ? await purchaseInvoicesApi.listAll() : [];
      const unpaidInvoices: PurchaseInvoice[] = allPurchaseInvoices.filter(inv =>
        inv.id !== undefined &&
        inv.status === "CONFIRMED" &&
        (inv.payment_status === "PARTIALLY_PAID" || inv.payment_status === "UNPAID" || inv.payment_status === "OVERDUE")
      );

      for (const row of paymentRows) {
        const counterparty = counterpartyNameForWiseRow(row);
        if (!counterparty) continue;
        const counterpartyKey = normalizeWiseCompanyName(counterparty);
        if (!counterpartyKey) continue;
        const date = wiseDate(row.finishedOn || row.createdOn);
        const targetCurrency = normalizeWiseCurrency(row.targetCurrency);
        const sourceCurrency = normalizeWiseCurrency(row.sourceCurrency);
        const targetAmount = row.targetAmount;
        const sourceAmount = row.sourceAmount; // EUR (after fees) for OUT rows
        const isForeignCardPayment = sourceCurrency === "EUR" && targetCurrency !== "EUR" && targetAmount > 0;

        for (const inv of unpaidInvoices) {
          const invSupplierKey = normalizeWiseCompanyName(inv.client_name);
          if (!invSupplierKey || invSupplierKey !== counterpartyKey) continue;

          // Date window: invoice within ±5 days of payment
          const invDate = inv.create_date;
          if (!invDate) continue;
          const dayDiff = Math.abs((Date.parse(invDate) - Date.parse(date)) / 86400000);
          if (!Number.isFinite(dayDiff) || dayDiff > 5) continue;

          const invCurrency = (inv.cl_currencies_id ?? "EUR").toUpperCase();
          const invGross = inv.gross_price;
          if (invGross === undefined || invGross === null) continue;

          if (isForeignCardPayment && invCurrency === targetCurrency && Math.abs(invGross - targetAmount) < 0.01) {
            const wiseRate = roundTo(sourceAmount / targetAmount, 6);
            const proposedBaseGross = roundMoney(sourceAmount);
            // Idempotency: skip when the invoice already carries the Wise
            // settlement values (within 1 cent for base_gross and 6dp for
            // rate) so a re-imported CSV does not re-update the same row.
            const currentBaseGross = inv.base_gross_price ?? undefined;
            const currentRate = inv.currency_rate ?? undefined;
            const baseGrossMatches = currentBaseGross !== undefined && Math.abs(roundMoney(currentBaseGross) - proposedBaseGross) < 0.01;
            const rateMatches = currentRate !== undefined && Math.abs(roundTo(currentRate, 6) - wiseRate) < 1e-6;
            if (baseGrossMatches && rateMatches) continue;
            invoiceFixCandidates.push({
              row_index: row.rowIndex,
              wise_id: row.id,
              date,
              supplier_name: counterparty,
              target_amount: targetAmount,
              target_currency: targetCurrency,
              source_amount_eur: sourceAmount,
              wise_currency_rate: wiseRate,
              invoice_id: inv.id!,
              invoice_number: inv.number,
              invoice_currency: invCurrency,
              invoice_gross: invGross,
              current_base_gross: currentBaseGross,
              current_currency_rate: currentRate,
              category: "foreign_currency_lock",
              proposed_action: `Lock invoice ${inv.number} to Wise rate: base_gross_price ${(currentBaseGross ?? 0).toFixed(2)} → ${proposedBaseGross.toFixed(2)} EUR, currency_rate → ${wiseRate}.`,
              current_object_state: inv,
            });
          } else {
            const eurDiff = roundMoney(invGross - sourceAmount);
            if (invCurrency === "EUR" && eurDiff !== 0 && Math.abs(eurDiff) < 0.10) {
              invoiceFixCandidates.push({
                row_index: row.rowIndex,
                wise_id: row.id,
                date,
                supplier_name: counterparty,
                target_amount: targetAmount,
                target_currency: targetCurrency,
                source_amount_eur: sourceAmount,
                wise_currency_rate: 1,
                invoice_id: inv.id!,
                invoice_number: inv.number,
                invoice_currency: invCurrency,
                invoice_gross: invGross,
                current_base_gross: inv.base_gross_price ?? undefined,
                current_currency_rate: inv.currency_rate ?? undefined,
                category: "eur_legacy_autofix",
                proposed_action: `Auto-fix legacy EUR booking ${inv.number}: gross_price ${invGross.toFixed(2)} → ${sourceAmount.toFixed(2)} EUR (Wise actual settlement, diff ${eurDiff.toFixed(2)}).`,
                current_object_state: inv,
              });
            }
          }
        }
      }

      // Ambiguity guard: when one Wise row matches multiple unpaid invoices
      // for the same supplier+amount+date window, do not pick — flag both as
      // ambiguous_skipped and let the operator resolve manually.
      const candidatesByWiseId = new Map<string, number>();
      for (const fix of invoiceFixCandidates) {
        candidatesByWiseId.set(fix.wise_id, (candidatesByWiseId.get(fix.wise_id) ?? 0) + 1);
      }
      for (const fix of invoiceFixCandidates) {
        if ((candidatesByWiseId.get(fix.wise_id) ?? 0) > 1) {
          fix.result = "ambiguous_skipped";
          // `supplier_name` is the raw Wise counterparty — wrap it here too so
          // this prose field cannot relay attacker text the way the structured
          // `supplier_name` field is wrapped at the output map below.
          fix.proposed_action = `Ambiguous match — multiple unpaid invoices for ${wrapUntrustedOcr(fix.supplier_name) ?? ""} match Wise row ${fix.wise_id}; resolve manually before applying.`;
        }
      }

      for (const fix of invoiceFixCandidates) {
        if (fix.result === "ambiguous_skipped") continue;
        const row = eligible.find(candidate => candidate.rowIndex === fix.row_index);
        if (!row) continue;
        const type = transactionTypeForWiseDirection(row.direction);
        if (!type) continue;
        const updatePayload: Partial<PurchaseInvoice> = fix.category === "foreign_currency_lock"
          ? {
              currency_rate: fix.wise_currency_rate,
              base_gross_price: roundMoney(fix.source_amount_eur),
            }
          : { gross_price: roundMoney(fix.source_amount_eur) };
        commands.push({
          version: WISE_COMMAND_VERSION,
          action: "purchase_invoice_update",
          mutation_mode: "update_existing",
          row_index: row.rowIndex,
          row_key: `row:${row.rowIndex}:invoice:${fix.invoice_id}`,
          identity_hash: commandIdentity(row, `invoice:${fix.invoice_id}`),
          wise_id: row.id,
          date: fix.date,
          transaction_type: type,
          source_direction: sourceDirectionForWiseDirection(row.direction)!,
          booked_amount: bookedAmountForWiseRow(row),
          booked_currency: bookedCurrencyForWiseRow(row),
          source_amount: row.sourceAmount,
          source_currency: normalizeWiseCurrency(row.sourceCurrency),
          target_amount: row.targetAmount,
          target_currency: normalizeWiseCurrency(row.targetCurrency),
          exchange_rate: row.exchangeRate,
          exchange_rate_orientation: "source_to_target",
          wise_dimension_id: accounts_dimensions_id,
          depends_on: mainCommandKeysByRow.get(row.rowIndex) ?? null,
          existing_object_id: fix.invoice_id,
          update_payload: updatePayload,
          category: fix.category,
          current_object_state: fix.current_object_state,
        });
      }

      if (!dryRun && invoiceFixCandidates.length > 0 && purchaseInvoicesApi) {
        for (const fix of invoiceFixCandidates) {
          if (fix.result === "ambiguous_skipped") continue;
          try {
            if (fix.category === "foreign_currency_lock") {
              await purchaseInvoicesApi.update(fix.invoice_id, {
                currency_rate: fix.wise_currency_rate,
                base_gross_price: roundMoney(fix.source_amount_eur),
              } as Partial<PurchaseInvoice>);
              fix.result = "updated";
              logAudit({
                tool: "import_wise_transactions", action: "UPDATED", entity_type: "purchase_invoice",
                entity_id: fix.invoice_id,
                summary: `Locked Wise rate for ${fix.invoice_number}: ${fix.target_amount} ${fix.target_currency} → ${fix.source_amount_eur} EUR @ ${fix.wise_currency_rate}`,
                details: { wise_id: fix.wise_id, currency_rate: fix.wise_currency_rate, base_gross_price: fix.source_amount_eur },
              });
            } else if (fix.category === "eur_legacy_autofix") {
              await purchaseInvoicesApi.update(fix.invoice_id, {
                gross_price: roundMoney(fix.source_amount_eur),
              } as Partial<PurchaseInvoice>);
              fix.result = "updated";
              logAudit({
                tool: "import_wise_transactions", action: "UPDATED", entity_type: "purchase_invoice",
                entity_id: fix.invoice_id,
                summary: `Auto-fixed EUR rounding for ${fix.invoice_number}: ${fix.invoice_gross} → ${fix.source_amount_eur} EUR`,
                details: { wise_id: fix.wise_id, old_gross: fix.invoice_gross, new_gross: fix.source_amount_eur },
              });
            }
          } catch (err) {
            fix.result = "error";
            fix.error = err instanceof Error ? err.message : String(err);
          }
        }
      } else if (dryRun) {
        for (const fix of invoiceFixCandidates) {
          if (fix.result !== "ambiguous_skipped") fix.result = "would_update";
        }
      }

      const canonicalPlanningArgs = {
        source_identity: inputSnapshot.identity,
        accounts_dimensions_id,
        fee_account_dimensions_id,
        fee_account_relation_id,
        resolved_fee_account_dimensions_id: feeAccountDimensionsId,
        inter_account_dimension_id,
        resolved_inter_account_dimension_id: inter_account_dimension_id ?? autoDetectedInterAccountDimId,
        confirm_own_transfer_ids: [...approvedTransferIds].sort(),
        date_from,
        date_to,
        skip_jar_transfers: skipJars,
      };
      const approvedCommandDigest = commands.length > 0
        ? approvalDigest({
            domain: WISE_APPROVAL_DOMAIN,
            version: WISE_COMMAND_VERSION,
            connection_fingerprint: api.transactions.connectionFingerprint,
            raw_csv_sha256: rawCsvSha256,
            planning_args: canonicalPlanningArgs,
            commands,
            current_state: {
              transactions: existingTx,
              account_dimensions: accountDimensionsSnapshot,
              bank_accounts: bankAccountsSnapshot,
              invoice_info: invoiceInfoSnapshot,
              clients: allClientsSnapshot,
              own_company_client_matches: ownCompanyClientMatches,
              journals: journalSnapshot,
              purchase_invoices: allPurchaseInvoices,
            },
          })
        : undefined;

      if (executeRequested && (
        approvedCommandDigest === undefined || approved_command_digest !== approvedCommandDigest
      )) {
        return digestMismatch();
      }
      if (!executeRequested && approved_command_digest !== undefined && approvedCommandDigest === undefined) {
        return digestMismatch();
      }

      for (let i = 0; i < totalEligible; i++) {
        await reportProgress(i, totalEligible);
      }

      if (executeRequested) {
        const releaseExecutionLock = await acquireWiseExecutionLock(api.transactions.connectionFingerprint);
        try {
          created.splice(0, created.length);
          const runtimeIds = new Map<string, number>();
          const successfulCommands = new Set<string>();
          for (const command of commands) {
          if (command.depends_on && !successfulCommands.has(command.depends_on)) {
            skipped.push({
              wise_id: command.wise_id,
              reason: "Skipped because main transaction was not created",
            });
            continue;
          }
          try {
            if (command.action === "main_create") {
              clearRuntimeCaches();
              const freshTransactions = await api.transactions.listAll();
              if (transactionCommandExists(command, freshTransactions)) {
                throw new Error("Stale transaction precondition: an equivalent Wise transaction appeared before create");
              }
              const result = await createBankTransaction(api, command.create_payload);
              const apiId = result.created_object_id;
              if (apiId === undefined) throw new Error("Wise transaction creation returned no object ID");
              runtimeIds.set(command.row_key, apiId);
              successfulCommands.add(command.row_key);
              logAudit({
                tool: "import_wise_transactions", action: "IMPORTED", entity_type: "transaction",
                entity_id: apiId,
                summary: `Imported Wise transaction ${command.booked_amount} ${command.booked_currency} on ${command.date}`,
                details: {
                  date: command.date,
                  amount: command.booked_amount,
                  type: "C",
                  source_direction: command.source_direction,
                  wise_id: command.wise_id,
                  approved_command_digest: approvedCommandDigest,
                  command_version: WISE_COMMAND_VERSION,
                },
              });
              const sourceRow = eligible.find(row => row.rowIndex === command.row_index);
              created.push({
                wise_id: command.wise_id,
                date: command.date,
                type: command.transaction_type,
                source_direction: command.source_direction,
                amount: command.booked_amount,
                description: command.create_payload.description ?? "",
                status: "created",
                api_id: apiId,
                source_row: sourceRow,
              });
              continue;
            }

            if (command.action === "fee_create_and_confirm") {
              clearRuntimeCaches();
              const freshTransactions = await api.transactions.listAll();
              if (transactionCommandExists(command, freshTransactions)) {
                throw new Error("Stale transaction precondition: an equivalent Wise transaction appeared before create");
              }
              const result = await createBankTransaction(api, command.create_payload);
              const apiId = result.created_object_id;
              if (apiId === undefined) throw new Error("Wise fee creation returned no object ID");
              runtimeIds.set(command.row_key, apiId);
              logAudit({
                tool: "import_wise_transactions", action: "IMPORTED", entity_type: "transaction",
                entity_id: apiId,
                summary: `Imported Wise fee ${command.booked_amount} ${command.booked_currency} on ${command.date}`,
                details: {
                  date: command.date,
                  amount: command.booked_amount,
                  wise_id: command.wise_id,
                  approved_command_digest: approvedCommandDigest,
                  command_version: WISE_COMMAND_VERSION,
                },
              });
              try {
                clearRuntimeCaches();
                const freshTransactions = await api.transactions.listAll();
                const createdTransaction = freshTransactions.find(transaction => transaction.id === apiId);
                if (!createdTransactionMatchesApprovedPayload(createdTransaction, apiId, command.create_payload)) {
                  throw new Error(`Stale created transaction precondition: fee transaction ${apiId} is missing or changed before confirmation`);
                }
                await api.transactions.confirm(apiId, command.confirmation_distribution);
                successfulCommands.add(command.row_key);
                logAudit({
                  tool: "import_wise_transactions", action: "CONFIRMED", entity_type: "transaction",
                  entity_id: apiId,
                  summary: `Auto-confirmed Wise fee transaction ${apiId}: ${command.booked_amount} ${command.booked_currency} on ${command.date}`,
                  details: {
                    amount: command.booked_amount,
                    currency: command.booked_currency,
                    date: command.date,
                    wise_id: command.wise_id,
                    approved_command_digest: approvedCommandDigest,
                    command_version: WISE_COMMAND_VERSION,
                  },
                });
                created.push({
                  wise_id: command.wise_id,
                  date: command.date,
                  type: command.transaction_type,
                  source_direction: command.source_direction,
                  amount: command.booked_amount,
                  description: command.create_payload.description ?? "",
                  status: "created_and_confirmed",
                  api_id: apiId,
                });
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                skipped.push({
                  wise_id: command.wise_id,
                  reason: `Fee confirmation failed: ${errorMessage}`,
                });
                created.push({
                  wise_id: command.wise_id,
                  date: command.date,
                  type: command.transaction_type,
                  source_direction: command.source_direction,
                  amount: command.booked_amount,
                  description: command.create_payload.description ?? "",
                  status: `created (confirm failed: ${errorMessage})`,
                  api_id: apiId,
                });
              }
              continue;
            }

            if (command.action === "inter_account") {
              const apiId = command.depends_on ? runtimeIds.get(command.depends_on) : undefined;
              if (apiId === undefined) throw new Error("Inter-account command dependency returned no transaction ID");
              if (command.mutation_mode === "create_only_already_journalized") {
                clearRuntimeCaches();
                const freshJournals = await api.journals.listAllWithPostings();
                const expectedJournal = freshJournals.find(journal => journal.id === command.existing_journal_id);
                if (!expectedJournal || !exactStateMatches(expectedJournal, command.current_journal_state)) {
                  const reason = `Stale already-journalized precondition: expected journal ${command.existing_journal_id} changed before acceptance`;
                  skipped.push({ wise_id: command.wise_id, reason });
                  interAccountResults.push({
                    api_id: apiId,
                    wise_id: command.wise_id,
                    amount: command.booked_amount,
                    status: `precondition_failed: ${reason}`,
                    ownership_basis: command.ownership_basis,
                    orphan_project_transaction_id: apiId,
                    orphan_action_hint: `Transaction ${apiId} was created but the approved journal precondition changed. Review journal ${command.existing_journal_id} and clean up or reconcile the PROJECT transaction manually.`,
                  });
                  continue;
                }
                successfulCommands.add(command.row_key);
                interAccountResults.push({
                  api_id: apiId,
                  wise_id: command.wise_id,
                  amount: command.booked_amount,
                  status: "already_journalized",
                  ownership_basis: command.ownership_basis,
                  ...(command.existing_journal_id !== null ? { journal_id: command.existing_journal_id } : {}),
                });
                continue;
              }

              try {
                clearRuntimeCaches();
                const [freshTransactions, freshJournals] = await Promise.all([
                  api.transactions.listAll(),
                  api.journals.listAllWithPostings(),
                ]);
                const currentTransaction = freshTransactions.find(transaction => transaction.id === apiId);
                const parentCreateCommand = commands.find((candidate): candidate is MainCreateCommand =>
                  candidate.action === "main_create" && candidate.row_key === command.depends_on
                );
                if (!parentCreateCommand || !createdTransactionMatchesApprovedPayload(
                  currentTransaction,
                  apiId,
                  parentCreateCommand.create_payload,
                )) {
                  throw new Error(`Stale created transaction precondition: inter-account transaction ${apiId} is missing or changed before confirmation`);
                }
                const freshJournalIndex = buildInterAccountJournalIndex(
                  freshJournals,
                  new Set([command.wise_dimension_id, command.counterpart_dimension_id]),
                );
                const journalKey = `${command.wise_dimension_id}|${command.counterpart_dimension_id}|${roundMoney(command.booked_amount)}|${command.date}`;
                if (findMatchingJournal(freshJournalIndex.get(journalKey), command.wise_id) !== undefined) {
                  throw new Error("Stale inter-account precondition: a matching journal appeared before confirmation");
                }
                if (command.client_update) await api.transactions.update(apiId, command.client_update);
                if (!command.confirmation_distribution) throw new Error("Inter-account confirmation distribution is missing");
                await api.transactions.confirm(apiId, command.confirmation_distribution);
                successfulCommands.add(command.row_key);
                const createdEntry = created.find(entry => entry.api_id === apiId);
                if (createdEntry) createdEntry.status = "created_and_confirmed_inter_account";
                logAudit({
                  tool: "import_wise_transactions", action: "CONFIRMED", entity_type: "transaction",
                  entity_id: apiId,
                  summary: `Confirmed Wise inter-account transfer ${command.booked_amount} ${command.booked_currency}`,
                  details: {
                    amount: command.booked_amount,
                    wise_id: command.wise_id,
                    target_dimension_id: command.posting_dimension_id,
                    ownership_basis: command.ownership_basis,
                    approved_command_digest: approvedCommandDigest,
                    command_version: WISE_COMMAND_VERSION,
                  },
                });
                interAccountResults.push({
                  api_id: apiId,
                  wise_id: command.wise_id,
                  amount: command.booked_amount,
                  status: "confirmed_inter_account",
                  ownership_basis: command.ownership_basis,
                });
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                skipped.push({
                  wise_id: command.wise_id,
                  reason: `Inter-account confirmation failed: ${errorMessage}`,
                });
                interAccountResults.push({
                  api_id: apiId,
                  wise_id: command.wise_id,
                  amount: command.booked_amount,
                  status: `confirm_failed: ${errorMessage}`,
                  ownership_basis: command.ownership_basis,
                  orphan_project_transaction_id: apiId,
                  orphan_action_hint: `Transaction ${apiId} was created but left in PROJECT status. Rerunning the import will skip it via wise_id dedup. To retry confirmation: invalidate_transaction(${apiId}), then delete_transaction(${apiId}) and rerun — or confirm_transaction(${apiId}) manually against the target bank account.`,
                });
              }
              continue;
            }

            const purchaseInvoices = api.purchaseInvoices;
            if (!purchaseInvoices) throw new Error("Purchase invoice API is unavailable");
            clearRuntimeCaches();
            const freshInvoices = await purchaseInvoices.listAll();
            const freshInvoice = freshInvoices.find(invoice => invoice.id === command.existing_object_id);
            if (!freshInvoice || !exactStateMatches(freshInvoice, command.current_object_state)) {
              throw new Error(`Stale purchase invoice precondition: invoice ${command.existing_object_id} changed before update`);
            }
            await purchaseInvoices.update(command.existing_object_id, command.update_payload);
            successfulCommands.add(command.row_key);
            const fix = invoiceFixCandidates.find(candidate =>
              candidate.row_index === command.row_index && candidate.invoice_id === command.existing_object_id
            );
            if (fix) fix.result = "updated";
            logAudit({
              tool: "import_wise_transactions", action: "UPDATED", entity_type: "purchase_invoice",
              entity_id: command.existing_object_id,
              summary: command.category === "foreign_currency_lock"
                ? `Locked Wise rate for invoice ${command.existing_object_id}`
                : `Auto-fixed EUR rounding for invoice ${command.existing_object_id}`,
              details: {
                wise_id: command.wise_id,
                ...command.update_payload,
                approved_command_digest: approvedCommandDigest,
                command_version: WISE_COMMAND_VERSION,
              },
            });
          } catch (err) {
            skipped.push({
              wise_id: command.wise_id,
              reason: err instanceof Error ? err.message : String(err),
            });
            if (command.action === "purchase_invoice_update") {
              const fix = invoiceFixCandidates.find(candidate =>
                candidate.row_index === command.row_index && candidate.invoice_id === command.existing_object_id
              );
              if (fix) {
                fix.result = "error";
                fix.error = err instanceof Error ? err.message : String(err);
              }
            }
          }
        }
        } finally {
          releaseExecutionLock();
        }
      }

      const mode = executeRequested ? "EXECUTED" : "DRY_RUN";
      const executionSkipped = skipped.filter(entry => isNonErrorWiseSkipReason(entry.reason));
      const executionErrors = skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason));
      const summary = {
        total_csv_rows: rows.length,
        eligible: eligible.length,
        filtered_out: rows.length - eligible.length,
        skipped_jar_transfers: skippedJarCount,
        created: created.length,
        skipped: executionSkipped.length,
        error_count: executionErrors.length,
        inter_account_total: interAccountResults.length,
        needs_review: ownershipReviews.length,
      };
      const invoiceCurrencyFixes = invoiceFixCandidates.length > 0
        ? {
            total: invoiceFixCandidates.length,
            foreign_currency_lock: invoiceFixCandidates.filter(f => f.category === "foreign_currency_lock").length,
            eur_legacy_autofix: invoiceFixCandidates.filter(f => f.category === "eur_legacy_autofix").length,
            updated: invoiceFixCandidates.filter(f => f.result === "updated").length,
            errors: invoiceFixCandidates.filter(f => f.result === "error").length,
            // `supplier_name` is the raw Wise counterparty (targetName/sourceName)
            // CSV column — sandbox-wrap it at the output boundary so a tampered
            // statement cannot inject through the dry-run preview or the
            // top-level result. Every other candidate field is a number, a
            // trusted RIK invoice value, or a server-built string. Wrapping here
            // covers both emit paths (this object feeds the top-level result and
            // the workflow-envelope preview).
            candidates: invoiceFixCandidates.map(({ row_index: _rowIndex, current_object_state: _state, ...c }) => ({
              ...c,
              supplier_name: wrapUntrustedOcr(c.supplier_name) ?? c.supplier_name,
            })),
          }
        : undefined;

      // `reason` is built from raw exception text (err.message) which can
      // echo upstream API content. Wrap at MCP output so any CSV-origin
      // bytes echoed through an error reach the LLM sandboxed.
      const sanitizeReason = (entry: { wise_id: string; reason: string }) => ({
        ...entry,
        reason: wrapUntrustedOcr(entry.reason) ?? entry.reason,
      });
      const sanitizedSkippedDetails = summarizeWiseSkippedEntries(skipped).map(group => ({
        ...group,
        reason: wrapUntrustedOcr(group.reason) ?? group.reason,
      }));
      const sanitizedExecutionSkipped = executionSkipped.map(sanitizeReason);
      const sanitizedExecutionErrors = executionErrors.map(sanitizeReason);
      const workflowArgs = {
        ...(file_ref !== undefined ? { file_ref } : {}),
        ...(file_ref === undefined && file_path !== undefined && !file_path.toLowerCase().startsWith("base64:")
          ? { file_path }
          : {}),
        accounts_dimensions_id,
        ...(fee_account_dimensions_id !== undefined ? { fee_account_dimensions_id } : {}),
        ...(fee_account_relation_id !== undefined ? { fee_account_relation_id } : {}),
        ...(inter_account_dimension_id !== undefined ? { inter_account_dimension_id } : {}),
        ...(confirm_own_transfer_ids !== undefined ? { confirm_own_transfer_ids } : {}),
        ...(date_from ? { date_from } : {}),
        ...(date_to ? { date_to } : {}),
        ...(skip_jar_transfers !== undefined ? { skip_jar_transfers } : {}),
        ...(approvedCommandDigest ? { approved_command_digest: approvedCommandDigest } : {}),
        execute: false,
      };
      const workflowSummary = !executeRequested
        ? `Wise dry run would create ${summary.created} bank transaction(s), skip ${summary.skipped}, and report ${summary.error_count} error(s).`
        : `Wise import created ${summary.created} bank transaction(s), skipped ${summary.skipped}, and reported ${summary.error_count} error(s).`;
      const workflow = buildWorkflowEnvelope({
        summary: workflowSummary,
        dry_run_steps: !executeRequested
          ? [{
              tool: "import_wise_transactions",
              summary: workflowSummary,
              suggested_args: workflowArgs,
              preview: {
                ...summary,
                command_count: commands.length,
                ...(invoiceCurrencyFixes ? { invoice_currency_fixes: invoiceCurrencyFixes } : {}),
              },
            }]
          : [],
      });
      const outputResults = created.map(({ description: _description, source_row: _sourceRow, ...rest }) => rest);

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode,
            ...(file_ref !== undefined
              ? { source_file_ref: file_ref }
              : file_path !== undefined && !file_path.toLowerCase().startsWith("base64:")
                ? { source_file: wrapUntrustedOcr(file_path) }
                : { source_identity: inputSnapshot.identity, source_resubmission_required: true }),
            summary,
            workflow,
            total_csv_rows: summary.total_csv_rows,
            eligible: summary.eligible,
            filtered_out: summary.filtered_out,
            ...(skippedJarCount > 0 ? {
              skipped_jar_transfers: skippedJarCount,
              skipped_jar_transfer_details: skippedJarRows,
            } : {}),
            created: summary.created,
            skipped: skipped.length,
            ...(approvedCommandDigest ? { approved_command_digest: approvedCommandDigest } : {}),
            command_version: WISE_COMMAND_VERSION,
            command_count: commands.length,
            ...(autoDetectedInterAccountDimId && hintedRows.length > 0 && dryRun ? {
              inter_account_auto_detected_dimension_id: autoDetectedInterAccountDimId,
            } : {}),
            ...(interAccountResults.length > 0 || (executeRequested && commands.some(command => command.action === "inter_account")) ? {
              inter_account_reconciliation: {
                total: interAccountResults.length,
                already_journalized: interAccountResults.filter(r => r.status === "already_journalized").length,
                confirmed: interAccountResults.filter(r => r.status === "confirmed_inter_account").length,
                details: interAccountResults,
              },
            } : {}),
            ...(ownershipReviews.length > 0 ? { ownership_reviews: ownershipReviews } : {}),
            ...(invoiceCurrencyFixes ? { invoice_currency_fixes: invoiceCurrencyFixes } : {}),
            results: outputResults,
            skipped_details: sanitizedSkippedDetails,
            execution: {
              ...buildBatchExecutionContract({
                mode,
                summary,
                results: outputResults,
                skipped: sanitizedExecutionSkipped,
                errors: sanitizedExecutionErrors,
                needs_review: ownershipReviews,
              }),
              commands: commands.map(projectWiseCommand),
            },
          }),
        }],
      };
    }
  );
}
