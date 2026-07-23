import type { AccountDimension, BankAccount } from "../types/api.js";
import { parseCSV } from "../csv.js";
import { canonicalRefNumber } from "../ref-number.js";
import { weaveFullRefIntoDescription } from "../bank-transaction-create.js";
import { normalizeCompanyName } from "../company-name.js";
import { DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT } from "../accounting-defaults.js";
import type {
  ImportRejectedField,
  ValidatedWiseFields,
  WisePreflightResult,
  WiseRow,
  WiseTransferDecision,
} from "./types.js";

// PURE module: parsing, strict M05 validation, IN/OUT direction helpers,
// duplicate-signature construction, skip summarization, and own-transfer
// classification. It imports NO MCP, HTTP, filesystem, audit, or environment
// module. The wisePreflightFailure→toolError/OCR envelope stays in the
// tool/presenter layer.

export const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

// --- Own-transfer classification ---------------------------------------------

const WISE_TRANSFER_DIMENSIONS_REASON =
  "Wise and target dimensions must resolve to two distinct configured bank accounts before reconciliation.";
const WISE_TRANSFER_OWNERSHIP_REASON =
  "Wise transfer ownership is unverified; both endpoints must match configured own-account identities or this exact Wise ID must be explicitly approved.";

export function isWiseTransferCandidate(row: WiseRow): boolean {
  return row.id.startsWith("TRANSFER-") || row.id.startsWith("BANK_DETAILS_PAYMENT_RETURN-");
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function bankIdentitiesByDimension(bankAccounts: BankAccount[]): {
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

export function uniqueActivePostingDimensions(accountDimensions: AccountDimension[]): Map<number, AccountDimension> {
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

export function classifyWiseOwnTransfer(
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

// --- M05 scaffolding ---------------------------------------------------------

export class ImportFieldError extends Error {
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
 * bookedFeeCurrencyForWiseRow() resolves at use time — the source side against
 * sourceCurrency, the target side against targetCurrency — so the booked value
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
 * feeds three identity sinks — the `WISE:{id}` transaction description, the
 * journal `document_number`, which carries the raw unprefixed id, and the M04
 * command digest (sha256(rowIndex\0action\0id)) — so normalizing it here would
 * silently shift the identity of every row against ledgers imported before M05.
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
 * the eligible-rows filter, so normalizing the stored value — by uppercasing OR by trimming —
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

export function preflightWiseCsv(csv: string): WisePreflightResult {
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
    // Never the Wise ID — that is attacker-controlled.
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

// --- Date / direction helpers ------------------------------------------------

export function wiseDate(dateStr: string): string {
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

export function validateWiseDateRange(dateFrom: string | undefined, dateTo: string | undefined): void {
  assertIsoDate(dateFrom, "date_from");
  assertIsoDate(dateTo, "date_to");
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error(`date_from ${dateFrom} must be on or before date_to ${dateTo}`);
  }
}

export function normalizeWiseDirection(direction: string): "IN" | "OUT" | "NEUTRAL" | undefined {
  const normalized = direction.trim().toUpperCase();
  if (normalized === "IN" || normalized === "OUT" || normalized === "NEUTRAL") {
    return normalized;
  }
  return undefined;
}

export function sourceDirectionForWiseDirection(direction: string): "IN" | "OUT" | undefined {
  const normalized = normalizeWiseDirection(direction);
  return normalized === "IN" || normalized === "OUT" ? normalized : undefined;
}

export function transactionTypeForWiseDirection(direction: string): "C" | "D" | undefined {
  // API type drives the cash-account leg at confirmation: incoming (IN) → "D"
  // (cash debited, "Laekumine"), outgoing (OUT) → "C" (cash credited, "Tasumine").
  const sourceDirection = sourceDirectionForWiseDirection(direction);
  return sourceDirection === "IN" ? "D" : sourceDirection === "OUT" ? "C" : undefined;
}

export function counterpartyNameForWiseRow(row: WiseRow): string | undefined {
  const sourceDirection = sourceDirectionForWiseDirection(row.direction);
  if (sourceDirection === "IN") {
    return row.sourceName || row.targetName || undefined;
  }
  if (sourceDirection === "OUT") {
    return row.targetName || row.sourceName || undefined;
  }
  return row.targetName || row.sourceName || undefined;
}

// --- Skip summarization -------------------------------------------------------

export function isNonErrorWiseSkipReason(reason: string): boolean {
  return reason.startsWith("Already imported") ||
    reason.startsWith("Fee already imported") ||
    reason.startsWith("Unsupported Wise direction") ||
    reason === "Skipped because main transaction was not created";
}

export function summarizeWiseSkippedEntries(skipped: Array<{ wise_id: string; reason: string }>) {
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

// --- Normalization helpers ---------------------------------------------------

export function normalizeWiseText(value?: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeWiseCompanyName(value?: unknown): string {
  return typeof value === "string" ? normalizeCompanyName(value) : "";
}

export function normalizeWiseCurrency(value?: string | null, fallback = "EUR"): string {
  const normalized = value?.trim().toUpperCase();
  return normalized || fallback;
}

// --- Booked-side resolution --------------------------------------------------

export function ownAccountSideForWiseRow(row: WiseRow): "source" | "target" | undefined {
  const sourceDirection = sourceDirectionForWiseDirection(row.direction);
  if (sourceDirection === "OUT") return "source";
  if (sourceDirection === "IN") return "target";
  return undefined;
}

export function bookedAmountForWiseRow(row: WiseRow): number {
  return ownAccountSideForWiseRow(row) === "target" ? row.targetAmount : row.sourceAmount;
}

export function bookedCurrencyForWiseRow(row: WiseRow): string {
  return ownAccountSideForWiseRow(row) === "target"
    ? normalizeWiseCurrency(row.targetCurrency)
    : normalizeWiseCurrency(row.sourceCurrency);
}

export function bookedFeeAmountForWiseRow(row: WiseRow): number {
  return ownAccountSideForWiseRow(row) === "target" ? row.targetFeeAmount : row.sourceFeeAmount;
}

export function bookedFeeCurrencyForWiseRow(row: WiseRow, fallbackCurrency: string): string {
  return ownAccountSideForWiseRow(row) === "target"
    ? normalizeWiseCurrency(row.targetFeeCurrency, fallbackCurrency)
    : normalizeWiseCurrency(row.sourceFeeCurrency, fallbackCurrency);
}

export function oppositeSideForWiseRow(row: WiseRow): { amount: number; currency: string } {
  return ownAccountSideForWiseRow(row) === "target"
    ? { amount: row.sourceAmount, currency: normalizeWiseCurrency(row.sourceCurrency) }
    : { amount: row.targetAmount, currency: normalizeWiseCurrency(row.targetCurrency) };
}

/** Detect Wise Jar (savings pot) transfers — internal movements, not real payments.
 * Checks explicit Jar indicators and self-transfer heuristic (same name, currency, zero fee).
 * The self-transfer heuristic works because real inter-account transfers (e.g. LHV→Wise)
 * typically have slightly different names (e.g. "OÜ" vs "OU" from bank registration).
 * If this incorrectly filters legitimate transfers, set skip_jar_transfers=false. */
export function isJarTransfer(row: WiseRow): boolean {
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

export function stripWisePrefix(description?: string | null): string {
  return (description ?? "")
    .replace(/^WISE:(?:FEE:)?\S+\s*/i, "")
    .replace(/\s*\[source_direction=(?:IN|OUT)\]\s*$/i, "")
    .trim();
}

export function withWiseSourceDirection(description: string, sourceDirection: "IN" | "OUT"): string {
  return `${description} [source_direction=${sourceDirection}]`;
}

function formatWiseAmount(amount: number): string {
  return amount.toFixed(2);
}

export function buildWiseTransactionSignature(
  date: string,
  amount: number,
  currency: string,
  bankAccountName?: string | null,
  refNumber?: string | null,
  description?: string | null,
): string {
  // Canonicalize the reference to the stored ref_number cap so a candidate row
  // whose full reference exceeds the cap still hashes identically to its
  // previously-stored (truncated) transaction — both sides feed through the same
  // canonicalization, keeping dedup stable across the truncation boundary.
  const canonical = canonicalRefNumber(refNumber);
  // When the ref exceeds the cap, createBankTransaction weaves the FULL ref into
  // the STORED description. The stored side re-enters here with the already-
  // truncated ref (not truncated → description used as-is = the woven desc); the
  // candidate side re-enters with the full ref (truncated → weave its full value
  // into the pre-weave desc), so both descriptions converge and dedup stays
  // symmetric across the truncation boundary.
  const descriptionForHash = canonical.truncated && canonical.full
    ? weaveFullRefIntoDescription(description, canonical.full)
    : (description ?? "");
  return [
    date,
    formatWiseAmount(amount),
    normalizeWiseCurrency(currency),
    normalizeWiseText(bankAccountName),
    normalizeWiseText(canonical.value),
    normalizeWiseText(descriptionForHash),
  ].join("|");
}

// --- Fee / distribution / own-company resolution -----------------------------

export function resolveWiseFeeAccountDimensionId(
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

export function buildAccountDistributionFromDimension(
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

export function resolveOwnCompanyClientId(
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
