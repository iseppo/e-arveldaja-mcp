import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { parseMcpResponse, toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { toolError } from "../tool-error.js";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";
import type { Client, Transaction } from "../types/api.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import { captureFileInputSnapshot, FileInputSnapshotError, type FileInputSnapshot, type FileInputSource } from "../file-input-snapshot.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { readOnly, batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { PlanStoreError, type PlanData, type PlanRecord } from "../plan-store.js";
import type { PlanExecutionReport } from "../plan-execution.js";
import {
  buildCamtExecutionPlanInput,
  camtPlanCommandId,
  canonicalPlanJson,
  CAMT_CREATE_CATEGORY,
  CAMT_PLAN_DOMAIN,
  executeCamtCommands,
  stripUndefinedDeep,
  type CamtPlanReviewCommand,
} from "./camt-plan.js";
import { roundMoney } from "../money.js";
import { reportProgress } from "../progress.js";
import { isNonVoidTransaction } from "../transaction-status.js";
import { normalizeCompanyName } from "../company-name.js";
import { buildWorkflowEnvelope, remapHiddenGranularWorkflowResult } from "../workflow-response.js";
import { arrayAt, isRecord, recordAt } from "../record-utils.js";
import { createBankTransaction } from "../bank-transaction-create.js";
import { checkStatementClosingBalance, type StatementBalanceCheck } from "../statement-balance-check.js";
import { appendStatementBalance, readStatementBalances } from "../statement-balance-store.js";

const CAMT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const XML_DTD_PATTERN = /<!(?:DOCTYPE|ENTITY)/i;
const CAMT_DESCRIPTION_METADATA_PREFIX = "[e-arveldaja-mcp:camt";
const TRANSACTION_DESCRIPTION_MAX_LENGTH = 150;
const CANONICAL_ACCOUNT_IDENTITY_REGEX = /^[A-Z0-9]{1,34}$/;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  trimValues: true,
  // Keep every tag value as raw text. The parser's built-in number coercion
  // rewrites the lexeme before it can be validated — it turns "1e2" into 100
  // and "0x10" into 16, so a statement could launder a hex or exponent literal
  // into a booked amount that strict validation never sees. It also silently
  // drops leading zeros from identifiers. M05 validates the bytes as sent.
  parseTagValue: false,
  // Strip XML namespace prefixes so a namespace-qualified statement
  // (<ns:Document>…) parses under the same unprefixed keys (Document, Stmt, …)
  // this code navigates by. Without it, valid prefixed CAMT files fail with
  // "Expected exactly one <Stmt>, found 0".
  removeNSPrefix: true,
});

// --- M05: strict import validation -------------------------------------------
//
// External statements are attacker-controlled. Every rejected field is
// addressed by a POSITIONAL identity so no file-supplied byte (statement ID,
// counterparty text, the malformed value itself) can reach an identity or a
// reason. Raw values are exposed only through the bounded, sandboxed projection
// in importPreflightFailure().

export interface ImportRejectedField {
  source_row_id: string;
  field: string;
  value: string;
  reason: string;
}

export type CamtPreflightResult =
  | { ok: true; source: "camt"; value: CamtParseResult }
  | { ok: false; source: "camt"; rejected_fields: ImportRejectedField[] };

class ImportFieldError extends Error {
  constructor(readonly issue: ImportRejectedField) {
    super(issue.reason);
    this.name = "ImportFieldError";
  }
}

function reject(source_row_id: string, field: string, value: unknown, reason: string): never {
  throw new ImportFieldError({ source_row_id, field, value: String(value ?? ""), reason });
}

/**
 * Run one field parse, recording its issue and continuing. Accumulating rather
 * than throwing on the first bad field is what lets one pass report defects
 * from every entry in a file instead of stopping at the first. Coverage is per
 * capture() call, not exhaustive within one: a node parsed by a single call
 * (parseAmountNode validates amount before currency) reports only the first
 * defect it hits, and the rest of that node's fields go unexamined until the
 * reported one is fixed.
 */
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
function importPreflightFailure(source: "camt" | "wise", rejected: ImportRejectedField[]) {
  return toolError({
    error: "Import preflight failed",
    category: "import_preflight_failed",
    source,
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

const CAMT_MONEY_REGEX = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;
const CAMT_DATE_TIME_REGEX =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/;

function parseCamtMoney(value: unknown, row: string, field: string): number {
  const text = String(value ?? "").trim();
  if (!CAMT_MONEY_REGEX.test(text)) {
    return reject(row, field, value, "CAMT amount must be a fully consumed finite decimal");
  }
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : reject(row, field, value, "CAMT amount must be finite");
}

/** Reject dates the calendar does not have (2026-02-30, 2026-13-01). */
function assertRealDate(date: string, row: string, field: string, original: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return reject(row, field, original, "Expected YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  const roundTrips = utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day;
  return roundTrips ? date : reject(row, field, original, "Impossible calendar date");
}

function parseCamtDate(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim();
  const match = CAMT_DATE_TIME_REGEX.exec(text);
  if (!match) return reject(row, field, value, "Expected a complete CAMT YYYY-MM-DD or ISO date-time");

  // Retain the LEXICAL calendar prefix — converting through Date would shift the
  // day for offsets far from UTC.
  const date = assertRealDate(match[1]!, row, field, value);

  if (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)) {
    return reject(row, field, value, "Impossible CAMT clock time");
  }
  if (match[6] !== undefined) {
    const offsetHours = Number(match[6]);
    const offsetMinutes = Number(match[7]);
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      return reject(row, field, value, "Invalid CAMT timezone offset");
    }
  }
  return date;
}

function parseCurrency(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim().toUpperCase();
  return CURRENCY_REGEX.test(text)
    ? text
    : reject(row, field, value, "Expected a three-letter ISO currency code");
}

type XmlRecord = Record<string, unknown>;

export interface CamtBalance {
  amount: number;
  currency: string;
  direction?: string;
  date?: string;
}

export interface CamtStatementMetadata {
  statement_id?: string;
  iban: string;
  currency?: string;
  bank_bic?: string;
  bank_name?: string;
  period: {
    from?: string;
    to?: string;
  };
  opening_balance?: CamtBalance;
  closing_balance?: CamtBalance;
}

export interface ParsedCamtEntry {
  date: string;
  amount: number;
  currency: string;
  direction: "CRDT" | "DBIT";
  original_amount?: number;
  original_currency?: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  counterparty_reg_code?: string;
  description?: string;
  reference_number?: string;
  end_to_end_id?: string;
  bank_reference?: string;
  duplicate: boolean;
  duplicate_transaction_ids: number[];
}

export interface CamtParseResult {
  statement_metadata: CamtStatementMetadata;
  entries: ParsedCamtEntry[];
  summary: {
    entry_count: number;
    credit_count: number;
    credit_total: number;
    debit_count: number;
    debit_total: number;
    duplicate_count: number;
  };
}

interface DuplicateLookup {
  byBankRef: Map<string, number[]>;
  byEntryKey: Map<string, number[]>;
}

interface PossibleDuplicateLookup {
  byCandidateKey: Map<string, Transaction[]>;
}

type PossibleDuplicateAction =
  | "link_confirmed_transaction_then_delete_new_project_transaction"
  | "review_status_before_cleanup";

interface ClientResolution {
  clients_id?: number;
  match_type?: "reg_code" | "exact_name" | "single_name_match";
  matched_client_name?: string;
}

interface ClientResolutionCache {
  byCode: Map<string, ClientResolution>;
  byName: Map<string, ClientResolution>;
}

type CreateTransactionPayload = Pick<Transaction,
  "accounts_dimensions_id" |
  "type" |
  "amount" |
  "cl_currencies_id" |
  "date"
> & Partial<Pick<Transaction,
  "description" |
  "bank_account_name" |
  "bank_account_no" |
  "clients_id" |
  "ref_number" |
  "bank_ref_number"
>>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): XmlRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as XmlRecord
    : undefined;
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textOf(item);
      if (text) return text;
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;
  const directText = record["#text"];
  if (typeof directText === "string" || typeof directText === "number" || typeof directText === "boolean") {
    const normalized = String(directText).trim();
    return normalized || undefined;
  }

  return undefined;
}

function valueAt(node: unknown, path: string[]): unknown {
  let current = node;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function textAt(node: unknown, path: string[]): string | undefined {
  return textOf(valueAt(node, path));
}

function textArrayAt(node: unknown, path: string[]): string[] {
  return asArray(valueAt(node, path))
    .map(item => textOf(item))
    .filter((item): item is string => !!item);
}

function normalizeOptionalReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.toUpperCase() === "NOTPROVIDED") return undefined;
  return normalized;
}

function encodeCamtMetadataValue(value: string): string {
  return encodeURIComponent(value);
}

function bankReferenceHash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function bankReferenceLookupKey(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalReference(value);
  return normalized ? bankReferenceHash(normalized) : undefined;
}

function dimensionScopedBankReferenceLookupKey(
  unscopedReferenceKey: string | undefined,
  dimensionId: unknown,
): string | undefined {
  if (
    !unscopedReferenceKey ||
    typeof dimensionId !== "number" ||
    !Number.isSafeInteger(dimensionId) ||
    dimensionId <= 0
  ) {
    return undefined;
  }
  return `${dimensionId}\0${unscopedReferenceKey}`;
}

function decodeCamtMetadataValue(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() || undefined;
  } catch {
    return value.trim() || undefined;
  }
}

function normalizeCamtDescriptionLineBreaks(description: string): string {
  return description.replace(/&#(?:10|x0*a);/gi, "\n");
}

function markerSafeDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const escaped = normalizeCamtDescriptionLineBreaks(description)
    .replace(/(^|\n)(\[e-arveldaja-mcp:camt\s+[^\]\r\n]+\])/g, "$1\\$2")
    .trim();
  return escaped || undefined;
}

function stripCamtDescriptionMetadata(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const stripped = normalizeCamtDescriptionLineBreaks(description)
    .replace(/(?:^|\n)\[e-arveldaja-mcp:camt\s+[^\]\r\n]+\]\s*$/g, "")
    .trim();
  return stripped || undefined;
}

function normalizeStoredBankReferenceHash(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^sha256:[a-f0-9]{64}$/i.test(normalized)
    ? normalized.toLowerCase()
    : undefined;
}

function normalizeStoredEntrySignature(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{16,64}$/.test(normalized)
    ? normalized
    : undefined;
}

function shortStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildCamtEntrySignature(parts: {
  bankReferenceKey?: string;
  date?: string;
  type?: string;
  currency?: string;
  amount?: number;
  refNumber?: string;
  bankAccountNo?: string;
  bankAccountName?: string;
  description?: string;
  sourceDirection?: ParsedCamtEntry["direction"];
}): string | undefined {
  if (!parts.bankReferenceKey || !parts.date || !parts.type || !Number.isFinite(parts.amount)) {
    return undefined;
  }
  const signatureParts = [
    parts.bankReferenceKey,
    parts.date,
    parts.type,
    parts.currency ?? "",
    roundMoney(parts.amount!).toFixed(2),
    normalizeBatchDuplicateKeyPart(parts.refNumber),
    normalizeBatchDuplicateKeyPart(parts.bankAccountNo),
    normalizeBatchDuplicateKeyPart(parts.bankAccountName),
    normalizeBatchDuplicateKeyPart(parts.description),
  ];
  if (parts.sourceDirection) signatureParts.push(parts.sourceDirection);
  return shortStableHash(JSON.stringify(signatureParts));
}

function extractCamtDescriptionMetadata(description: string | null | undefined): {
  bank_ref_number?: string;
  bank_ref_hash?: string;
  bank_account_no?: string;
  entry_sig?: string;
  source_direction?: ParsedCamtEntry["direction"];
} {
  if (!description) return {};
  const normalizedDescription = normalizeCamtDescriptionLineBreaks(description).trimEnd();
  const match = normalizedDescription.match(/(?:^|\n)\[e-arveldaja-mcp:camt\s+([^\]\r\n]+)\]$/);
  if (!match) return {};

  const metadata: { bank_ref_number?: string; bank_ref_hash?: string; bank_account_no?: string; entry_sig?: string; source_direction?: ParsedCamtEntry["direction"] } = {};
  for (const [, key, value] of match[1]!.matchAll(/(bank_ref_number|bank_ref_hash|bank_account_no|entry_sig|source_direction|br|brh|iban|sig|dir|h|i|s|d)=([^\s\]]+)/g)) {
    const decoded = decodeCamtMetadataValue(value);
    if (!decoded) continue;
    if (key === "bank_ref_number" || key === "br") metadata.bank_ref_number = decoded;
    if (key === "bank_ref_hash" || key === "brh" || key === "h") metadata.bank_ref_hash = normalizeStoredBankReferenceHash(key === "h" ? `sha256:${decoded}` : decoded);
    if (key === "bank_account_no" || key === "iban" || key === "i") metadata.bank_account_no = decoded;
    if (key === "entry_sig" || key === "sig" || key === "s") metadata.entry_sig = normalizeStoredEntrySignature(decoded);
    if ((key === "source_direction" || key === "dir" || key === "d") && (decoded === "CRDT" || decoded === "DBIT")) metadata.source_direction = decoded;
  }
  return metadata;
}

function buildCamtDescriptionMarkerFromParts(parts: string[]): string | undefined {
  return parts.length > 0
    ? `${CAMT_DESCRIPTION_METADATA_PREFIX} ${parts.join(" ")}]`
    : undefined;
}

function buildCamtEntrySignatureForParsedEntry(entry: ParsedCamtEntry, cleanDescription: string | undefined): string | undefined {
  const bankReferenceKey = bankReferenceLookupKey(entry.bank_reference);
  return buildCamtEntrySignature({
    bankReferenceKey,
    date: entry.date,
    type: "C",
    currency: entry.currency,
    amount: entry.amount,
    refNumber: entry.reference_number,
    bankAccountNo: entry.counterparty_iban,
    bankAccountName: entry.counterparty_name,
    description: cleanDescription,
    sourceDirection: entry.direction,
  });
}

function buildCamtDescriptionMarker(entry: ParsedCamtEntry, cleanDescription: string | undefined): string | undefined {
  const bankReference = normalizeOptionalReference(entry.bank_reference);
  if (!bankReference && !entry.counterparty_iban) return undefined;

  const entrySignature = buildCamtEntrySignatureForParsedEntry(entry, cleanDescription);
  const bankReferencePart = bankReference
    ? `br=${encodeCamtMetadataValue(bankReference)}`
    : undefined;
  const bankReferenceHashPart = bankReference
    ? `brh=${bankReferenceHash(bankReference)}`
    : undefined;
  const compactBankReferenceHashPart = bankReference
    ? `h=${bankReferenceHash(bankReference).replace(/^sha256:/, "")}`
    : undefined;
  const bankAccountPart = entry.counterparty_iban
    ? `iban=${encodeCamtMetadataValue(entry.counterparty_iban)}`
    : undefined;
  const signaturePart = entrySignature ? `sig=${entrySignature}` : undefined;
  const directionPart = `dir=${entry.direction}`;
  const compactBankAccountPart = entry.counterparty_iban
    ? `i=${encodeCamtMetadataValue(entry.counterparty_iban)}`
    : undefined;
  const compactDirectionPart = `d=${entry.direction}`;
  const compactSignaturePart = entrySignature ? `s=${entrySignature}` : undefined;

  const markerCandidates = [
    buildCamtDescriptionMarkerFromParts([bankReferencePart, bankAccountPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferenceHashPart, bankAccountPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([compactBankReferenceHashPart, compactBankAccountPart, compactDirectionPart, compactSignaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferencePart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferenceHashPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankAccountPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferencePart, directionPart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferenceHashPart, directionPart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankAccountPart, directionPart].filter((part): part is string => Boolean(part))),
  ];

  return markerCandidates.find((marker) => marker !== undefined && marker.length <= TRANSACTION_DESCRIPTION_MAX_LENGTH);
}

function buildCamtDescriptionWithMetadata(description: string | undefined, entry: ParsedCamtEntry): string | undefined {
  const cleanDescription = markerSafeDescription(description);
  const marker = buildCamtDescriptionMarker(entry, cleanDescription);
  if (!marker) return cleanDescription;

  const separatorLength = cleanDescription ? 1 : 0;
  const descriptionBudget = TRANSACTION_DESCRIPTION_MAX_LENGTH - marker.length - separatorLength;
  if (!cleanDescription || descriptionBudget <= 0) return marker.slice(0, TRANSACTION_DESCRIPTION_MAX_LENGTH);

  const trimmedDescription = cleanDescription.length > descriptionBudget
    ? cleanDescription.slice(0, descriptionBudget).trimEnd()
    : cleanDescription;
  return trimmedDescription ? `${trimmedDescription}\n${marker}` : marker;
}

function isTrustedCamtDescriptionMetadata(
  transaction: Pick<Transaction,
    "bank_ref_number" |
    "date" |
    "type" |
    "amount" |
    "cl_currencies_id" |
    "ref_number" |
    "bank_account_no" |
    "bank_account_name" |
    "description"
  >,
  metadata = extractCamtDescriptionMetadata(transaction.description),
): boolean {
  if (!metadata.entry_sig) return false;
  const bankReferenceKey = bankReferenceLookupKey(transaction.bank_ref_number ?? undefined) ??
    bankReferenceLookupKey(metadata.bank_ref_number) ??
    metadata.bank_ref_hash;
  const expectedSignature = buildCamtEntrySignature({
    bankReferenceKey,
    date: transaction.date,
    type: metadata.source_direction ? "C" : transaction.type,
    currency: transaction.cl_currencies_id ?? "",
    amount: transaction.amount,
    refNumber: transaction.ref_number ?? undefined,
    bankAccountNo: normalizeOptionalReference(transaction.bank_account_no ?? undefined) ?? metadata.bank_account_no,
    bankAccountName: transaction.bank_account_name ?? undefined,
    description: stripCamtDescriptionMetadata(transaction.description ?? undefined),
    sourceDirection: metadata.source_direction,
  });
  return expectedSignature !== undefined && expectedSignature === metadata.entry_sig;
}

function directBankReferenceLookupKey(transaction: Pick<Transaction, "bank_ref_number">): string | undefined {
  return bankReferenceLookupKey(transaction.bank_ref_number ?? undefined);
}

export function storedBankReferenceLookupKey(transaction: Pick<Transaction,
  "bank_ref_number" |
  "date" |
  "type" |
  "amount" |
  "cl_currencies_id" |
  "ref_number" |
  "bank_account_no" |
  "bank_account_name" |
  "description"
>): string | undefined {
  const directBankReferenceKey = bankReferenceLookupKey(transaction.bank_ref_number ?? undefined);
  if (directBankReferenceKey) return directBankReferenceKey;

  const metadata = extractCamtDescriptionMetadata(transaction.description);
  if (!isTrustedCamtDescriptionMetadata(transaction, metadata)) return undefined;
  return bankReferenceLookupKey(metadata.bank_ref_number) ?? metadata.bank_ref_hash;
}

function storedBankAccountNo(transaction: Pick<Transaction,
  "bank_account_no" |
  "bank_ref_number" |
  "date" |
  "type" |
  "amount" |
  "cl_currencies_id" |
  "ref_number" |
  "bank_account_name" |
  "description"
>): string | undefined {
  const directBankAccountNo = normalizeOptionalReference(transaction.bank_account_no ?? undefined);
  if (directBankAccountNo) return directBankAccountNo;

  const metadata = extractCamtDescriptionMetadata(transaction.description);
  return isTrustedCamtDescriptionMetadata(transaction, metadata)
    ? metadata.bank_account_no
    : undefined;
}


function parseAmountNode(
  node: unknown,
  fallbackCurrency: string | undefined,
  sourceRowId: string,
  field = "amount",
): { amount: number; currency: string; text: string } | undefined {
  const amountText = textOf(node);
  if (!amountText) return undefined;

  const currencyText = textOf(asRecord(node)?.["@_Ccy"]);
  return {
    amount: parseCamtMoney(amountText, sourceRowId, field),
    currency: currencyText === undefined
      ? (fallbackCurrency ?? "EUR")
      : parseCurrency(currencyText, sourceRowId, `${field}_currency`),
    // The raw lexeme, so a later rule (positivity) can echo the bytes the file
    // actually carried rather than a reparsed number: `value` is the operator's
    // handle on the source document, and it is what the output boundary wraps.
    text: amountText,
  };
}

function parseOriginalAmountNode(
  txDetails: unknown,
  fallbackCurrency: string | undefined,
  sourceRowId: string,
): { amount: number; currency: string } | undefined {
  const amount =
    parseAmountNode(valueAt(txDetails, ["AmtDtls", "TxAmt", "Amt"]), fallbackCurrency, sourceRowId, "original_amount") ??
    parseAmountNode(valueAt(txDetails, ["AmtDtls", "InstdAmt", "Amt"]), fallbackCurrency, sourceRowId, "original_amount");
  // Direction is carried separately, so an original amount is positive.
  if (amount && !(amount.amount > 0)) {
    return reject(sourceRowId, "original_amount", amount.text, "CAMT original amount must be positive");
  }
  return amount;
}

function collectTransactionDetails(entryNode: unknown): Array<unknown | undefined> {
  const detailNodes = asArray(valueAt(entryNode, ["NtryDtls"]))
    .flatMap((detailBlock) => asArray(valueAt(detailBlock, ["TxDtls"])));

  return detailNodes.length > 0 ? detailNodes : [undefined];
}

function splitBookedAmounts(totalAmount: number, txOriginalAmounts: Array<number | undefined>): number[] {
  if (txOriginalAmounts.length <= 1) return [totalAmount];

  const canSplitProportionally = txOriginalAmounts.every((amount) => amount !== undefined && amount > 0);
  const weights = canSplitProportionally
    ? txOriginalAmounts.map((amount) => amount!)
    : txOriginalAmounts.map(() => 1);
  const totalWeight = weights.reduce((sum, amount) => sum + amount, 0);

  if (totalWeight <= 0) {
    return txOriginalAmounts.map((_, index) =>
      index === txOriginalAmounts.length - 1
        ? roundMoney(totalAmount)
        : 0,
    );
  }

  const allocated: number[] = [];
  let allocatedTotal = 0;

  for (let index = 0; index < weights.length; index++) {
    if (index === weights.length - 1) {
      allocated.push(roundMoney(totalAmount - allocatedTotal));
      continue;
    }

    const amount = roundMoney(totalAmount * (weights[index]! / totalWeight));
    allocated.push(amount);
    allocatedTotal = roundMoney(allocatedTotal + amount);
  }

  return allocated;
}

function extractOrgIdByScheme(party: unknown, schemeCode: string): string | undefined {
  const others = asArray(valueAt(party, ["Id", "OrgId", "Othr"]));
  for (const other of others) {
    if (textAt(other, ["SchmeNm", "Cd"]) === schemeCode) {
      return textAt(other, ["Id"]);
    }
  }
  return undefined;
}

function extractIban(account: unknown): string | undefined {
  return textAt(account, ["Id", "IBAN"]);
}

function pickCounterparty(txDetails: unknown, direction: "CRDT" | "DBIT"): { party?: unknown; account?: unknown } {
  const parties = valueAt(txDetails, ["RltdPties"]);
  if (direction === "CRDT") {
    return {
      party: valueAt(parties, ["Dbtr"]),
      account: valueAt(parties, ["DbtrAcct"]),
    };
  }

  return {
    party: valueAt(parties, ["Cdtr"]),
    account: valueAt(parties, ["CdtrAcct"]),
  };
}

function buildDuplicateLookup(transactions: Transaction[], selectedDimensionId: number): DuplicateLookup {
  const byBankRef = new Map<string, number[]>();
  const byEntryKey = new Map<string, number[]>();

  for (const transaction of transactions) {
    if (!transaction.id) continue;
    if (
      typeof transaction.accounts_dimensions_id !== "number" ||
      !Number.isSafeInteger(transaction.accounts_dimensions_id) ||
      transaction.accounts_dimensions_id <= 0 ||
      transaction.accounts_dimensions_id !== selectedDimensionId
    ) {
      continue;
    }

    const entryKey = buildExistingTransactionDuplicateKey(transaction, selectedDimensionId);
    if (entryKey) {
      const exactExisting = byEntryKey.get(entryKey) ?? [];
      exactExisting.push(transaction.id);
      byEntryKey.set(entryKey, exactExisting);
    }

    const directBankRefKey = dimensionScopedBankReferenceLookupKey(
      directBankReferenceLookupKey(transaction),
      selectedDimensionId,
    );
    if (!directBankRefKey) continue;

    const existing = byBankRef.get(directBankRefKey) ?? [];
    existing.push(transaction.id);
    byBankRef.set(directBankRefKey, existing);
  }

  return { byBankRef, byEntryKey };
}

function buildPossibleDuplicateLookup(
  transactions: Transaction[],
  accountsDimensionsId: number,
): PossibleDuplicateLookup {
  const byCandidateKey = new Map<string, Transaction[]>();

  for (const transaction of transactions) {
    if (transaction.accounts_dimensions_id !== accountsDimensionsId) continue;
    const candidateKey = buildPossibleDuplicateCandidateKey(
      transaction.date,
      transaction.type,
      transaction.cl_currencies_id ?? "EUR",
      transaction.amount,
    );
    const existing = byCandidateKey.get(candidateKey) ?? [];
    existing.push(transaction);
    byCandidateKey.set(candidateKey, existing);
  }

  return { byCandidateKey };
}

function buildExistingTransactionDuplicateKey(
  transaction: Pick<Transaction,
    "bank_ref_number" |
    "date" |
    "type" |
    "amount" |
    "cl_currencies_id" |
    "ref_number" |
    "bank_account_no" |
    "bank_account_name" |
    "description"
  >,
  selectedDimensionId: number,
  bankReferenceKey = storedBankReferenceLookupKey(transaction),
): string | undefined {
  const scopedBankReferenceKey = dimensionScopedBankReferenceLookupKey(bankReferenceKey, selectedDimensionId);
  if (!scopedBankReferenceKey || !transaction.date || !transaction.type || !Number.isFinite(transaction.amount)) {
    return undefined;
  }

  return [
    scopedBankReferenceKey,
    transaction.date,
    transaction.type,
    transaction.cl_currencies_id ?? "",
    roundMoney(transaction.amount).toFixed(2),
    normalizeBatchDuplicateKeyPart(transaction.ref_number ?? undefined),
    normalizeBatchDuplicateKeyPart(storedBankAccountNo(transaction)),
    normalizeBatchDuplicateKeyPart(transaction.bank_account_name ?? undefined),
    normalizeBatchDuplicateKeyPart(transaction.description ?? undefined),
  ].join("|");
}

function transactionTypesForDuplicateCompatibility(entry: ParsedCamtEntry): Array<"C" | "D"> {
  const legacyType = legacyTransactionTypeForDirection(entry.direction);
  return legacyType === "C" ? ["C"] : ["C", legacyType];
}

function buildExistingDuplicateKeysForEntry(entry: ParsedCamtEntry, selectedDimensionId: number): string[] {
  const bankReference = normalizeOptionalReference(entry.bank_reference);
  const bankReferenceKey = dimensionScopedBankReferenceLookupKey(
    bankReferenceLookupKey(bankReference),
    selectedDimensionId,
  );
  if (!bankReference || !bankReferenceKey) return [];

  return transactionTypesForDuplicateCompatibility(entry).map((type) => [
      bankReferenceKey,
      entry.date,
      type,
      entry.currency,
      roundMoney(entry.amount).toFixed(2),
      normalizeBatchDuplicateKeyPart(entry.reference_number),
      normalizeBatchDuplicateKeyPart(entry.counterparty_iban),
      normalizeBatchDuplicateKeyPart(entry.counterparty_name),
      normalizeBatchDuplicateKeyPart(buildCamtDescriptionWithMetadata(entry.description, entry)),
    ].join("|"));
}

function findDuplicateTransactionIds(
  entry: ParsedCamtEntry,
  lookup: DuplicateLookup,
  repeatedBankReferences: ReadonlySet<string>,
  selectedDimensionId: number,
): number[] {
  for (const exactKey of buildExistingDuplicateKeysForEntry(entry, selectedDimensionId)) {
    const exactMatches = lookup.byEntryKey.get(exactKey) ?? [];
    if (exactMatches.length > 0) {
      return [...new Set(exactMatches)].sort((left, right) => left - right);
    }
  }

  const bankReference = normalizeOptionalReference(entry.bank_reference);
  const bankReferenceKey = dimensionScopedBankReferenceLookupKey(
    bankReferenceLookupKey(bankReference),
    selectedDimensionId,
  );
  if (!bankReference || !bankReferenceKey || repeatedBankReferences.has(bankReference)) return [];

  const matches = new Set<number>();

  for (const id of lookup.byBankRef.get(bankReferenceKey) ?? []) {
    matches.add(id);
  }

  return [...matches].sort((left, right) => left - right);
}

function normalizeBatchDuplicateKeyPart(value: string | undefined): string {
  return stripCamtDescriptionMetadata(value)?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function normalizePossibleDuplicateIban(value: string | undefined): string {
  return value?.replace(/\s+/g, "").toUpperCase() ?? "";
}

function normalizedCounterpartyName(value: string | undefined): string {
  return normalizeCompanyName(value) || normalizeBatchDuplicateKeyPart(value);
}

function buildPossibleDuplicateCandidateKey(
  date: string,
  type: string,
  currency: string,
  amount: number,
): string {
  return [
    date,
    type,
    currency,
    roundMoney(amount).toFixed(2),
  ].join("|");
}

/**
 * Structured counterparty evidence that two stored transactions are the SAME
 * bank entry — beyond the coarse candidate key (date/type/currency/amount/
 * dimension), which alone collides for e.g. two same-day, same-amount card
 * purchases from different merchants. Returns the matching corroborators among
 * reference number, counterparty IBAN, and counterparty name, reusing the exact
 * normalizers `findPossibleDuplicateMatches` uses for those three fields.
 *
 * This is the DESTRUCTIVE-gate subset of the proposer's `match_reasons` rule: it
 * deliberately EXCLUDES the proposer's `description` corroborator. The stored
 * description is metadata-wrapped and length-capped by
 * `buildCamtDescriptionWithMetadata`, so a persisted description is not a
 * faithful equivalent of the full `entry.description` the proposer compares —
 * and free-text description is the lowest-entropy, most attacker-influenced
 * signal. Requiring one of the three structured identifiers makes the cleanup
 * gate strictly MORE conservative than the proposer (it can only ever accept a
 * subset of what the proposer surfaces). The bank reference is intentionally not
 * a corroborator here, exactly as in the proposal logic, because the kept row
 * routinely lacks it (that is what the cleanup enriches); the gate uses the bank
 * reference only as a divergence check when BOTH rows carry one.
 */
export function camtDuplicateStructuredCorroborators(
  a: Pick<Transaction, "ref_number" | "bank_account_no" | "bank_account_name">,
  b: Pick<Transaction, "ref_number" | "bank_account_no" | "bank_account_name">,
): string[] {
  const reasons: string[] = [];

  const aRef = normalizeBatchDuplicateKeyPart(a.ref_number ?? undefined);
  const bRef = normalizeBatchDuplicateKeyPart(b.ref_number ?? undefined);
  if (aRef && aRef === bRef) reasons.push("reference_number");

  const aIban = normalizePossibleDuplicateIban(normalizeOptionalReference(a.bank_account_no ?? undefined));
  const bIban = normalizePossibleDuplicateIban(normalizeOptionalReference(b.bank_account_no ?? undefined));
  if (aIban && aIban === bIban) reasons.push("counterparty_iban");

  const aName = normalizedCounterpartyName(a.bank_account_name ?? undefined);
  const bName = normalizedCounterpartyName(b.bank_account_name ?? undefined);
  if (aName && aName === bName) reasons.push("counterparty_name");

  return reasons;
}

function findPossibleDuplicateMatches(
  entry: ParsedCamtEntry,
  lookup: PossibleDuplicateLookup,
): Array<{
  id: number;
  status?: string;
  counterparty?: string | null;
  description?: string | null;
  ref_number?: string | null;
  match_reasons: string[];
  suggested_patch_missing_fields: Partial<Transaction>;
}> {
  const candidates = transactionTypesForDuplicateCompatibility(entry)
    .flatMap((type) => lookup.byCandidateKey.get(buildPossibleDuplicateCandidateKey(
      entry.date,
      type,
      entry.currency,
      entry.amount,
    )) ?? [])
    .filter((transaction, index, all) => all.findIndex((candidate) => candidate.id === transaction.id) === index);
  const entryCounterparty = normalizedCounterpartyName(entry.counterparty_name);
  const entryDescription = normalizeBatchDuplicateKeyPart(entry.description);
  const entryReference = normalizeBatchDuplicateKeyPart(entry.reference_number);
  const entryIban = normalizePossibleDuplicateIban(entry.counterparty_iban);
  // Every candidate is considered. This function is only ever reached for an
  // entry that is NOT an exact duplicate — the caller skips those before
  // calling — so no candidate here can be double-reported, and a candidate's
  // bank reference is not grounds to drop it. Excluding candidates that merely
  // HAVE a reference used to hide two silent-rebooking paths: a reference
  // whose stored bytes were coerced by the base parser ("007" written as "7"),
  // and a reference repeated across an entry's legs, which makes
  // findDuplicateTransactionIds refuse the byBankRef fallback and leaves this
  // review the only remaining net. Output is still bounded downstream by the
  // requirement of at least one concrete match_reason.
  return candidates
    .map((transaction) => {
      const existingBankAccountNo = normalizeOptionalReference(transaction.bank_account_no ?? undefined);
      const matchReasons: string[] = [];
      if (entryReference && entryReference === normalizeBatchDuplicateKeyPart(transaction.ref_number ?? undefined)) {
        matchReasons.push("reference_number");
      }
      if (entryIban && entryIban === normalizePossibleDuplicateIban(existingBankAccountNo)) {
        matchReasons.push("counterparty_iban");
      }
      if (entryCounterparty && entryCounterparty === normalizedCounterpartyName(transaction.bank_account_name ?? undefined)) {
        matchReasons.push("counterparty_name");
      }
      if (entryDescription && entryDescription === normalizeBatchDuplicateKeyPart(transaction.description ?? undefined)) {
        matchReasons.push("description");
      }
      return {
        id: transaction.id ?? 0,
        status: transaction.status,
        counterparty: transaction.bank_account_name,
        description: transaction.description,
        ref_number: transaction.ref_number,
        match_reasons: matchReasons,
        suggested_patch_missing_fields: {
          ...(!directBankReferenceLookupKey(transaction) && entry.bank_reference
            ? { bank_ref_number: entry.bank_reference }
            : {}),
          ...(!normalizeOptionalReference(transaction.ref_number ?? undefined) && entry.reference_number
            ? { ref_number: entry.reference_number }
            : {}),
          ...(!normalizePossibleDuplicateIban(existingBankAccountNo) && entry.counterparty_iban
            ? { bank_account_no: entry.counterparty_iban }
            : {}),
          ...(!normalizedCounterpartyName(transaction.bank_account_name ?? undefined) && entry.counterparty_name
            ? { bank_account_name: entry.counterparty_name }
            : {}),
          ...(!normalizeBatchDuplicateKeyPart(transaction.description ?? undefined) && entry.description
            ? { description: entry.description }
            : {}),
        },
      };
    })
    .filter((match) => match.id > 0 && match.match_reasons.length > 0)
    .sort((left, right) => left.id - right.id);
}

function hasConfirmedPossibleDuplicate(
  matches: Array<{ status?: string }>,
): boolean {
  return matches.some((match) => match.status === "CONFIRMED");
}

function determinePossibleDuplicateAction(
  matches: Array<{ status?: string }>,
): PossibleDuplicateAction {
  return hasConfirmedPossibleDuplicate(matches)
    ? "link_confirmed_transaction_then_delete_new_project_transaction"
    : "review_status_before_cleanup";
}

function buildPossibleDuplicateRecommendationNote(
  action: PossibleDuplicateAction,
): string {
  if (action === "link_confirmed_transaction_then_delete_new_project_transaction") {
    return "Default cleanup is to enrich the older confirmed transaction with the CAMT bank reference and any other missing metadata, then delete the new PROJECT transaction.";
  }
  return "A likely duplicate was found, but the older match is not confirmed. Review both transaction statuses before deciding whether to keep the old row or the newly imported PROJECT transaction.";
}

function buildBatchDuplicateKey(entry: ParsedCamtEntry): string {
  return [
    normalizeOptionalReference(entry.bank_reference) ?? "",
    entry.date,
    entry.direction,
    entry.currency,
    roundMoney(entry.amount).toFixed(2),
    normalizeBatchDuplicateKeyPart(entry.reference_number),
    normalizeBatchDuplicateKeyPart(entry.end_to_end_id),
    normalizeBatchDuplicateKeyPart(entry.counterparty_iban),
    normalizeBatchDuplicateKeyPart(entry.counterparty_name),
    normalizeBatchDuplicateKeyPart(entry.description),
  ].join("|");
}

function findRepeatedBankReferences(entries: ParsedCamtEntry[]): Set<string> {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const bankReference = normalizeOptionalReference(entry.bank_reference);
    if (!bankReference) continue;
    counts.set(bankReference, (counts.get(bankReference) ?? 0) + 1);
  }

  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([bankReference]) => bankReference),
  );
}

function summarizeEntries(entries: ParsedCamtEntry[]): CamtParseResult["summary"] {
  const summary = {
    entry_count: entries.length,
    credit_count: 0,
    credit_total: 0,
    debit_count: 0,
    debit_total: 0,
    duplicate_count: 0,
  };

  for (const entry of entries) {
    if (entry.direction === "CRDT") {
      summary.credit_count += 1;
      summary.credit_total += entry.amount;
    } else {
      summary.debit_count += 1;
      summary.debit_total += entry.amount;
    }
    if (entry.duplicate) {
      summary.duplicate_count += 1;
    }
  }

  summary.credit_total = roundMoney(summary.credit_total);
  summary.debit_total = roundMoney(summary.debit_total);
  return summary;
}

function buildStatement(xml: string, rejected: ImportRejectedField[]): CamtParseResult {
  if (XML_DTD_PATTERN.test(xml)) {
    throw new Error("CAMT.053 files must not contain DOCTYPE or ENTITY declarations");
  }
  const parsed = xmlParser.parse(xml);
  const statements = asArray(valueAt(parsed, ["Document", "BkToCstmrStmt", "Stmt"]));

  if (statements.length !== 1) {
    throw new Error(
      `Expected exactly one <Stmt> in CAMT.053 file, found ${statements.length}. ` +
      "Split multi-statement CAMT exports into separate XML files and import them one statement at a time.",
    );
  }

  const statement = statements[0];
  const accountIban = textAt(statement, ["Acct", "Id", "IBAN"]);
  if (!accountIban) {
    throw new Error("CAMT.053 file is missing statement account IBAN");
  }

  // Held to the same three-letter rule as every <Amt Ccy=""> attribute: this
  // value is the fallback currency for any amount that carries no attribute of
  // its own, so it reaches cl_currencies_id on the mutation payload, and it is
  // emitted in statement_metadata, which wraps only statement_id and bank_name.
  const rawAccountCurrency = textAt(statement, ["Acct", "Ccy"]);
  const accountCurrency = rawAccountCurrency === undefined
    ? "EUR"
    : capture(rejected, () => parseCurrency(rawAccountCurrency, "camt:statement:1", "account_currency")) ?? "EUR";

  // Statement period strings are validated but preserved verbatim on success.
  const periodFrom = textAt(statement, ["FrToDt", "FrDtTm"]) ?? textAt(statement, ["FrToDt", "FrDt"]);
  const periodTo = textAt(statement, ["FrToDt", "ToDtTm"]) ?? textAt(statement, ["FrToDt", "ToDt"]);
  if (periodFrom !== undefined) capture(rejected, () => parseCamtDate(periodFrom, "camt:statement:1", "period_from"));
  if (periodTo !== undefined) capture(rejected, () => parseCamtDate(periodTo, "camt:statement:1", "period_to"));

  const balances = asArray(valueAt(statement, ["Bal"])).map((balanceNode, balanceIndex) => {
    const rowId = `camt:balance:${balanceIndex + 1}`;
    const balanceCode = textAt(balanceNode, ["Tp", "CdOrPrtry", "Cd"]);
    // A balance amount may legitimately be zero; its sign is carried separately
    // by CdtDbtInd, so only the lexeme itself is validated here.
    const amount = capture(rejected, () => parseAmountNode(valueAt(balanceNode, ["Amt"]), accountCurrency, rowId));
    const rawDate = textAt(balanceNode, ["Dt", "Dt"]) ?? textAt(balanceNode, ["Dt", "DtTm"]);
    const date = rawDate === undefined
      ? undefined
      : capture(rejected, () => parseCamtDate(rawDate, rowId, "balance_date"));
    // Validated under the same row identity as the balance amount and date.
    // The direction decides the balance's sign, so an unvalidated value here
    // misstates the statement rather than merely echoing bad bytes. (This is a
    // local justification, not a completeness claim: statement_metadata still
    // emits bank_bic raw, an optional identifier nothing reads. The iban is
    // not in that set — it is required, and H08 validates it at the
    // statement-binding gate via assertStatementAccountMatchesDimension.)
    const rawDirection = textAt(balanceNode, ["CdtDbtInd"]);
    const direction = rawDirection === undefined
      ? undefined
      : capture(rejected, () => rawDirection === "CRDT" || rawDirection === "DBIT"
        ? rawDirection
        : reject(rowId, "balance_direction", rawDirection, "CAMT direction must be CRDT or DBIT"));
    return {
      code: balanceCode,
      balance: amount && {
        amount: amount.amount,
        currency: amount.currency,
        direction,
        date,
      },
    };
  });

  const openingBalance = balances.find(balance => balance.code === "OPBD")?.balance;
  const closingBalance = balances.find(balance => balance.code === "CLBD")?.balance;

  const entries: ParsedCamtEntry[] = [];
  for (const [entryIndex, entryNode] of asArray(valueAt(statement, ["Ntry"])).entries()) {
    // Positional identity only. The statement <Id> is attacker-controlled and
    // must never appear in a row identity.
    const entryRowId = `camt:ntry:${entryIndex + 1}`;

    const rawDirection = textAt(entryNode, ["CdtDbtInd"]);
    const direction = rawDirection === "CRDT" || rawDirection === "DBIT"
      ? rawDirection
      : capture(rejected, () => reject(entryRowId, "direction", rawDirection, "CAMT direction must be CRDT or DBIT"));

    const rawDate = textAt(entryNode, ["BookgDt", "Dt"]) ?? textAt(entryNode, ["BookgDt", "DtTm"]);
    const entryDate = rawDate === undefined
      ? capture(rejected, () => reject(entryRowId, "booking_date", rawDate, "CAMT entry is missing a booking date"))
      : capture(rejected, () => parseCamtDate(rawDate, entryRowId, "booking_date"));

    const entryAmount = capture(rejected, () => {
      const amount = parseAmountNode(valueAt(entryNode, ["Amt"]), accountCurrency, entryRowId);
      if (!amount) return reject(entryRowId, "amount", undefined, "CAMT entry is missing an amount");
      // Direction is carried separately, so a booked entry amount is positive.
      if (!(amount.amount > 0)) return reject(entryRowId, "amount", amount.text, "CAMT entry amount must be positive");
      return amount;
    });

    const detailNodes = collectTransactionDetails(entryNode);
    const originalAmounts = detailNodes.map((txDetails, detailIndex) => capture(rejected, () =>
      parseOriginalAmountNode(txDetails, accountCurrency, `${entryRowId}:tx:${detailIndex + 1}`)));

    // An invalid core field excludes this row from the successful value but
    // never stops validation of later entries or details.
    if (!direction || !entryDate || !entryAmount) continue;

    const bookedAmounts = splitBookedAmounts(
      entryAmount.amount,
      originalAmounts.map((amount) => amount?.amount),
    );

    for (const [detailIndex, txDetails] of detailNodes.entries()) {
      const { party, account } = pickCounterparty(txDetails, direction);
      const structuredRef = asArray(valueAt(txDetails, ["RmtInf", "Strd"]))
        .map(node => textAt(node, ["CdtrRefInf", "Ref"]))
        .find((value): value is string => !!value);
      const originalAmount = originalAmounts[detailIndex];

      entries.push({
        date: entryDate,
        amount: bookedAmounts[detailIndex] ?? entryAmount.amount,
        currency: entryAmount.currency,
        direction,
        original_amount: originalAmount?.amount,
        original_currency: originalAmount?.currency,
        counterparty_name: textAt(party, ["Nm"]),
        counterparty_iban: extractIban(account),
        counterparty_reg_code: extractOrgIdByScheme(party, "COID"),
        description: textArrayAt(txDetails, ["RmtInf", "Ustrd"]).join(" | ") || undefined,
        reference_number: normalizeOptionalReference(structuredRef) ??
          normalizeOptionalReference(textAt(txDetails, ["Refs", "EndToEndId"])),
        end_to_end_id: normalizeOptionalReference(textAt(txDetails, ["Refs", "EndToEndId"])),
        bank_reference: normalizeOptionalReference(textAt(txDetails, ["Refs", "AcctSvcrRef"]) ?? textAt(entryNode, ["AcctSvcrRef"])),
        duplicate: false,
        duplicate_transaction_ids: [],
      });
    }
  }

  const MAX_CAMT_ENTRIES = 50_000;
  if (entries.length > MAX_CAMT_ENTRIES) {
    throw new Error(`CAMT file contains ${entries.length} entries, exceeding the ${MAX_CAMT_ENTRIES} limit. Split the file into smaller date ranges.`);
  }

  return {
    statement_metadata: {
      statement_id: textAt(statement, ["Id"]),
      iban: accountIban,
      currency: accountCurrency,
      bank_bic: textAt(statement, ["Acct", "Svcr", "FinInstnId", "BIC"]),
      bank_name: textAt(statement, ["Acct", "Svcr", "FinInstnId", "Nm"]),
      period: { from: periodFrom, to: periodTo },
      opening_balance: openingBalance,
      closing_balance: closingBalance,
    },
    entries,
    summary: summarizeEntries(entries),
  };
}

/**
 * Structured preflight used by the tool handlers: validates the whole file and
 * accumulates every invalid field. Structural failures (DTD/entity, malformed
 * XML, not exactly one statement) remain thrown.
 */
export function preflightCamt053Xml(xml: string): CamtPreflightResult {
  const rejected: ImportRejectedField[] = [];
  const value = buildStatement(xml, rejected);
  return rejected.length > 0
    ? { ok: false, source: "camt", rejected_fields: rejected }
    : { ok: true, source: "camt", value };
}

/**
 * Value-returning parser kept for callers that want an exception on any invalid
 * row. The thrown message is fixed and never echoes file content.
 */
export function parseCamt053Xml(xml: string): CamtParseResult {
  const rejected: ImportRejectedField[] = [];
  const value = buildStatement(xml, rejected);
  if (rejected.length > 0) {
    throw new Error(
      `CAMT.053 file contains ${rejected.length} invalid field(s). ` +
      "Use the import tool to see which rows and fields were rejected.",
    );
  }
  return value;
}

async function loadCamt053Preflight(
  source: FileInputSource,
  runtimeSafetyContext: RuntimeSafetyContext,
): Promise<CamtPreflightResult> {
  const snapshot = await captureFileInputSnapshot(source, {
    runtimeSafetyContext,
    operation: FILE_REFERENCE_OPERATIONS.camt,
    allowedExtensions: [".xml"],
    maxSize: CAMT_MAX_FILE_SIZE,
  });
  return preflightCamt053Xml(snapshot.text());
}

async function enrichWithDuplicates(
  parsed: CamtParseResult,
  api: ApiContext,
  selectedDimensionId: number,
): Promise<CamtParseResult> {
  const existingTransactions = (await api.transactions.listAll()).filter(isNonVoidTransaction);
  const duplicateLookup = buildDuplicateLookup(existingTransactions, selectedDimensionId);
  const repeatedBankReferences = findRepeatedBankReferences(parsed.entries);
  const entries = parsed.entries.map(entry => {
    const duplicateIds = findDuplicateTransactionIds(
      entry,
      duplicateLookup,
      repeatedBankReferences,
      selectedDimensionId,
    );
    return {
      ...entry,
      duplicate: duplicateIds.length > 0,
      duplicate_transaction_ids: duplicateIds,
    };
  });

  return {
    ...parsed,
    entries,
    summary: summarizeEntries(entries),
  };
}

async function ensureAccountDimensionExists(api: ApiContext, accountsDimensionsId: number): Promise<void> {
  const dimensions = await api.readonly.getAccountDimensions();
  if (!dimensions.some(dimension => dimension.id === accountsDimensionsId && !dimension.is_deleted)) {
    throw new Error(
      `Account dimension ${accountsDimensionsId} not found. Use list_account_dimensions to find the bank account dimension ID.`
    );
  }
}

function normalizeAccountIdentity(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9]+$/.test(compact)) return undefined;
  return compact.replace(/[a-z]/g, character =>
    String.fromCharCode(character.charCodeAt(0) - 32));
}

function renderAccountIdentity(value: string): string {
  return CANONICAL_ACCOUNT_IDENTITY_REGEX.test(value)
    ? value
    : wrapUntrustedOcr(value) ?? value;
}

function accountBindingValidationError(message: string): Error {
  return Object.assign(new Error(message), { category: "validation_failed" as const });
}

export async function assertStatementAccountMatchesDimension(
  api: ApiContext,
  statementIban: string,
  dimensionId: number,
): Promise<void> {
  const bankAccounts = await api.readonly.getBankAccounts();
  const selectedRows = bankAccounts.filter(account => account.accounts_dimensions_id === dimensionId);
  if (selectedRows.length === 0) {
    throw accountBindingValidationError(`No bank account record is bound to selected dimension ${dimensionId}`);
  }

  const selectedIdentityByNormalized = new Map<string, string>();
  for (const account of selectedRows) {
    for (const identity of [account.iban_code, account.account_no]) {
      const normalized = normalizeAccountIdentity(identity);
      if (normalized !== undefined && !selectedIdentityByNormalized.has(normalized)) {
        selectedIdentityByNormalized.set(normalized, identity!);
      }
    }
  }
  if (selectedIdentityByNormalized.size === 0) {
    throw accountBindingValidationError(
      `Bank account records bound to selected dimension ${dimensionId} have no usable IBAN or account number`,
    );
  }

  const normalizedStatementIdentity = normalizeAccountIdentity(statementIban);
  if (normalizedStatementIdentity === undefined) {
    throw accountBindingValidationError(
      `Statement account ${renderAccountIdentity(statementIban)} is not a valid ASCII account identity`,
    );
  }
  const statementMatchesSelected = selectedIdentityByNormalized.has(normalizedStatementIdentity);
  const matchingDimensions = new Set<number>();
  for (const account of bankAccounts) {
    const matches = [account.iban_code, account.account_no]
      .some(identity => {
        const normalizedIdentity = normalizeAccountIdentity(identity);
        return normalizedIdentity !== undefined && normalizedIdentity === normalizedStatementIdentity;
      });
    if (!matches) continue;

    const ownerDimensionId: unknown = account.accounts_dimensions_id;
    if (typeof ownerDimensionId !== "number" ||
        !Number.isSafeInteger(ownerDimensionId) ||
        ownerDimensionId <= 0) {
      throw accountBindingValidationError(
        "A matching bank-account record has an invalid dimension identifier",
      );
    }
    matchingDimensions.add(ownerDimensionId);
  }

  const owningDimensions = [...matchingDimensions]
    .filter(ownerDimensionId => ownerDimensionId !== dimensionId)
    .sort((left, right) => left - right);

  if (statementMatchesSelected) {
    if (owningDimensions.length === 0) return;
    throw accountBindingValidationError(
      `Statement account ${renderAccountIdentity(statementIban)} matches selected bank dimension ${dimensionId} ` +
      `but is also bound to other bank dimension(s): ${owningDimensions.join(", ")}.`,
    );
  }

  const selectedIdentities = [...selectedIdentityByNormalized.values()]
    .map(renderAccountIdentity)
    .join(", ");
  const ownerNote = owningDimensions.length > 0
    ? ` The statement account is bound to other bank dimension(s): ${owningDimensions.join(", ")}.`
    : "";
  throw accountBindingValidationError(
    `Statement account ${renderAccountIdentity(statementIban)} does not match selected bank dimension ${dimensionId} ` +
    `(configured identities: ${selectedIdentities}).${ownerNote}`,
  );
}

async function resolveClientForEntry(
  api: ApiContext,
  entry: ParsedCamtEntry,
  cache: ClientResolutionCache,
): Promise<ClientResolution> {
  if (entry.counterparty_reg_code) {
    const cached = cache.byCode.get(entry.counterparty_reg_code);
    if (cached) return cached;

    const match = await api.clients.findByCode(entry.counterparty_reg_code);
    const resolution: ClientResolution = match?.id
      ? {
          clients_id: match.id,
          match_type: "reg_code",
          matched_client_name: match.name,
        }
      : {};

    cache.byCode.set(entry.counterparty_reg_code, resolution);
    if (resolution.clients_id) return resolution;
  }

  const cacheKey = entry.counterparty_name?.trim().replace(/\s+/g, " ").toLowerCase();
  if (!cacheKey) return {};

  const normalizedName = normalizeCompanyName(entry.counterparty_name);
  if (!normalizedName) return {};

  const cached = cache.byName.get(cacheKey);
  if (cached) return cached;

  const matches = await api.clients.findByName(entry.counterparty_name!);
  const exactMatches = matches.filter(client => normalizeCompanyName(client.name) === normalizedName);

  let selected: Client | undefined;
  let matchType: ClientResolution["match_type"];
  if (exactMatches.length === 1) {
    selected = exactMatches[0];
    matchType = "exact_name";
  } else if (matches.length === 1) {
    selected = matches[0];
    matchType = "single_name_match";
  }

  const resolution: ClientResolution = selected?.id
    ? {
        clients_id: selected.id,
        match_type: matchType,
        matched_client_name: selected.name,
      }
    : {};

  cache.byName.set(cacheKey, resolution);
  return resolution;
}

function legacyTransactionTypeForDirection(direction: ParsedCamtEntry["direction"]): "C" | "D" {
  return direction === "CRDT" ? "D" : "C";
}

// --- Plan-bound import: projection, planner input, executor, rendering -------
//
// The dry run and the execute path share one deterministic projection of the
// reviewed CAMT source. The dry run issues an immutable execution plan; the
// execute path re-reads the source, re-derives the same projection, and refuses
// to mutate unless it matches the plan the operator approved.

interface CamtCreateDescriptor {
  entry: ParsedCamtEntry;
  payload: CreateTransactionPayload;
  storedDescription?: string;
  clientResolution: ClientResolution;
  possibleDuplicateMatches: ReturnType<typeof findPossibleDuplicateMatches>;
  batchDuplicateKey: string;
}

interface CamtSkippedRow {
  date: string;
  amount: number;
  bank_reference?: string;
  duplicate_transaction_ids: number[];
  reason: string;
}

interface CamtImportProjection {
  parsed: CamtParseResult;
  statementMetadata: CamtStatementMetadata;
  descriptors: CamtCreateDescriptor[];
  skipped: CamtSkippedRow[];
  repeatedBankReferences: Set<string>;
  totalStatementEntries: number;
  eligibleEntries: number;
  filteredOut: number;
}

async function loadCamt053SnapshotAndPreflight(
  source: FileInputSource,
  runtimeSafetyContext: RuntimeSafetyContext,
): Promise<{ snapshot: FileInputSnapshot; preflight: CamtPreflightResult }> {
  const snapshot = await captureFileInputSnapshot(source, {
    runtimeSafetyContext,
    operation: FILE_REFERENCE_OPERATIONS.camt,
    allowedExtensions: [".xml"],
    maxSize: CAMT_MAX_FILE_SIZE,
  });
  return { snapshot, preflight: preflightCamt053Xml(snapshot.text()) };
}

async function computeCamtImportProjection(
  api: ApiContext,
  loaded: CamtParseResult,
  accountsDimensionsId: number,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): Promise<CamtImportProjection> {
  const parsed = await enrichWithDuplicates(loaded, api, accountsDimensionsId);
  const existingTransactions = (await api.transactions.listAll()).filter(isNonVoidTransaction);
  const filteredEntries = parsed.entries.filter(entry => {
    if (dateFrom && entry.date < dateFrom) return false;
    if (dateTo && entry.date > dateTo) return false;
    return true;
  });
  const repeatedBankReferences = findRepeatedBankReferences(parsed.entries);
  const seenBatchDuplicateKeys = new Set(
    filteredEntries.filter(entry => entry.duplicate).map(entry => buildBatchDuplicateKey(entry)),
  );
  const clientCache: ClientResolutionCache = { byCode: new Map(), byName: new Map() };
  const possibleDuplicateLookup = buildPossibleDuplicateLookup(existingTransactions, accountsDimensionsId);
  const descriptors: CamtCreateDescriptor[] = [];
  const skipped: CamtSkippedRow[] = [];

  for (let index = 0; index < filteredEntries.length; index++) {
    const entry = filteredEntries[index]!;
    await reportProgress(index, filteredEntries.length);
    const batchDuplicateKey = buildBatchDuplicateKey(entry);

    if (entry.duplicate) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: entry.duplicate_transaction_ids,
        reason: "Existing transaction matched by bank reference",
      });
      continue;
    }
    if (seenBatchDuplicateKeys.has(batchDuplicateKey)) {
      skipped.push({
        date: entry.date,
        amount: entry.amount,
        bank_reference: entry.bank_reference,
        duplicate_transaction_ids: [],
        reason: "Duplicate CAMT entry inside current import batch",
      });
      continue;
    }

    const clientResolution = await resolveClientForEntry(api, entry, clientCache);
    const storedDescription = buildCamtDescriptionWithMetadata(entry.description, entry);
    const possibleDuplicateMatches = findPossibleDuplicateMatches(entry, possibleDuplicateLookup);
    const payload: CreateTransactionPayload = {
      accounts_dimensions_id: accountsDimensionsId,
      // API type drives the cash-account leg at confirmation: incoming (CRDT) →
      // "D" (cash debited, "Laekumine"), outgoing (DBIT) → "C" ("Tasumine").
      type: entry.direction === "CRDT" ? "D" : "C",
      amount: entry.amount,
      cl_currencies_id: entry.currency || "EUR",
      date: entry.date,
      description: storedDescription,
      bank_account_name: entry.counterparty_name,
      bank_account_no: entry.counterparty_iban,
      clients_id: clientResolution.clients_id,
      ref_number: entry.reference_number,
      bank_ref_number: entry.bank_reference,
    };
    descriptors.push({ entry, payload, storedDescription, clientResolution, possibleDuplicateMatches, batchDuplicateKey });
    seenBatchDuplicateKeys.add(batchDuplicateKey);
  }

  return {
    parsed,
    statementMetadata: parsed.statement_metadata,
    descriptors,
    skipped,
    repeatedBankReferences,
    totalStatementEntries: parsed.entries.length,
    eligibleEntries: filteredEntries.length,
    filteredOut: parsed.entries.length - filteredEntries.length,
  };
}

function camtNormalizedArgs(
  accountsDimensionsId: number,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): PlanRecord {
  return stripUndefinedDeep({
    accounts_dimensions_id: accountsDimensionsId,
    date_from: dateFrom,
    date_to: dateTo,
  }) as PlanRecord;
}

function camtPlanFingerprint(projection: CamtImportProjection, normalizedArgs: PlanRecord): string {
  return canonicalPlanJson({
    normalized_args: normalizedArgs,
    statement_iban: projection.statementMetadata.iban,
    commands: projection.descriptors.map((descriptor, index) => ({
      id: camtPlanCommandId(index),
      payload: descriptor.payload,
    })),
    skipped: projection.skipped.map(row => ({
      bank_reference: row.bank_reference,
      date: row.date,
      amount: row.amount,
      reason: row.reason,
      duplicate_transaction_ids: row.duplicate_transaction_ids,
    })),
    possible_duplicates: projection.descriptors.map((descriptor, index) => ({
      id: camtPlanCommandId(index),
      existing_transaction_ids: descriptor.possibleDuplicateMatches.map(match => match.id),
    })),
  });
}

function camtReviewCommands(projection: CamtImportProjection): CamtPlanReviewCommand[] {
  return projection.descriptors.map((descriptor, index) => ({
    id: camtPlanCommandId(index),
    category: CAMT_CREATE_CATEGORY,
    reviewProjection: stripUndefinedDeep({
      date: descriptor.entry.date,
      amount: descriptor.entry.amount,
      currency: descriptor.entry.currency,
      direction: descriptor.entry.direction,
      counterparty_name: descriptor.entry.counterparty_name,
      bank_reference: descriptor.entry.bank_reference,
      ref_number: descriptor.entry.reference_number,
    }),
  }));
}

function issueCamtPlan(
  runtimeSafetyContext: RuntimeSafetyContext,
  snapshot: FileInputSnapshot,
  projection: CamtImportProjection,
  normalizedArgs: PlanRecord,
): string {
  const possibleDuplicateCount = projection.descriptors.filter(d => d.possibleDuplicateMatches.length > 0).length;
  const planInput = buildCamtExecutionPlanInput({
    normalizedArgs,
    sourceIdentity: stripUndefinedDeep({ ...snapshot.identity }) as PlanRecord,
    statementIban: projection.statementMetadata.iban,
    reviewCommands: camtReviewCommands(projection),
    fingerprint: camtPlanFingerprint(projection, normalizedArgs),
    counts: {
      total_statement_entries: projection.totalStatementEntries,
      eligible_entries: projection.eligibleEntries,
      filtered_out: projection.filteredOut,
      would_create: projection.descriptors.length,
      skipped: projection.skipped.length,
      possible_duplicates: possibleDuplicateCount,
    },
    totals: {
      credit_total: projection.parsed.summary.credit_total,
      debit_total: projection.parsed.summary.debit_total,
    },
    exclusions: projection.skipped.map(row => stripUndefinedDeep({
      date: row.date,
      amount: row.amount,
      bank_reference: row.bank_reference,
      reason: row.reason,
      duplicate_transaction_ids: row.duplicate_transaction_ids,
    })),
    reviews: projection.descriptors
      .filter(d => d.possibleDuplicateMatches.length > 0)
      .map(d => stripUndefinedDeep({
        date: d.entry.date,
        amount: d.entry.amount,
        existing_transaction_ids: d.possibleDuplicateMatches.map(match => match.id),
      })),
  });
  return runtimeSafetyContext.planStore.issue(CAMT_PLAN_DOMAIN, planInput);
}

function planErrorResult(category: string, message: string): CamtToolResponse {
  return toolError({ error: message, category, mutation_occurred: false }) as CamtToolResponse;
}

function camtResultRow(
  descriptor: CamtCreateDescriptor,
  status: "would_create" | "created",
  apiId?: number,
) {
  return {
    status,
    date: descriptor.entry.date,
    amount: descriptor.entry.amount,
    currency: descriptor.entry.currency,
    type: (descriptor.entry.direction === "CRDT" ? "D" : "C") as "C" | "D",
    source_direction: descriptor.entry.direction,
    description: descriptor.entry.description,
    counterparty: descriptor.entry.counterparty_name,
    bank_reference: descriptor.entry.bank_reference,
    ref_number: descriptor.entry.reference_number,
    clients_id: descriptor.clientResolution.clients_id,
    client_match: descriptor.clientResolution.match_type,
    ...(apiId !== undefined ? { api_id: apiId } : {}),
    ...(descriptor.storedDescription !== descriptor.entry.description
      ? { stored_description: descriptor.storedDescription }
      : {}),
  };
}

function camtPossibleDuplicateRow(descriptor: CamtCreateDescriptor, newApiId?: number) {
  const recommendedDefaultAction = determinePossibleDuplicateAction(descriptor.possibleDuplicateMatches);
  return {
    date: descriptor.entry.date,
    amount: descriptor.entry.amount,
    currency: descriptor.entry.currency,
    type: (descriptor.entry.direction === "CRDT" ? "D" : "C") as "C" | "D",
    source_direction: descriptor.entry.direction,
    counterparty: descriptor.entry.counterparty_name,
    bank_reference: descriptor.entry.bank_reference,
    ref_number: descriptor.entry.reference_number,
    ...(newApiId !== undefined ? { new_transaction_api_id: newApiId } : {}),
    existing_transactions: descriptor.possibleDuplicateMatches,
    recommended_default_action: recommendedDefaultAction,
    recommendation_note: buildPossibleDuplicateRecommendationNote(recommendedDefaultAction),
  };
}

interface StatementBalanceCheckResult {
  check?: StatementBalanceCheck;
  persisted: boolean;
  notes: string[];
}

/**
 * Run the advisory closing-balance tripwire for a CAMT statement bound to a
 * bank dimension. Reconciles the statement's CLBD against the ledger and, when
 * `persist` is set (execute mode only), records the closing balance to the
 * statement-balance history. In single-file rules mode the store is
 * unavailable, so the comparison still runs but persistence is skipped with a
 * note. Returns undefined when no usable balance/date anchor is available.
 *
 * FAIL-SAFE: this is an advisory sub-check and must never fail the host import.
 * On execute the persist runs AFTER transactions are already created, so a
 * throw here would report a failure for work that succeeded. Both the
 * comparison and the persist are therefore wrapped so any error degrades to a
 * note instead of propagating.
 */
async function runStatementBalanceCheck(
  api: ApiContext,
  closing: CamtBalance,
  fallbackDate: string | undefined,
  accountsDimensionsId: number,
  persist: boolean,
): Promise<StatementBalanceCheckResult | undefined> {
  const balanceDate = closing.date ?? fallbackDate;
  if (!balanceDate) return undefined;   // no anchor date → cannot reconcile

  let check: StatementBalanceCheck;
  try {
    // The bank GL account backing this dimension (e.g. 1020). The dimension
    // binding was validated upstream; this is a defensive re-read.
    const dimensions = await api.readonly.getAccountDimensions();
    const dimension = dimensions.find(entry => entry.id === accountsDimensionsId && !entry.is_deleted);
    if (!dimension) return undefined;
    const accountId = dimension.accounts_id;

    const direction = closing.direction === "DBIT" ? "DBIT" : closing.direction === "CRDT" ? "CRDT" : undefined;
    check = await checkStatementClosingBalance(api, {
      dimensionId: accountsDimensionsId,
      accountId,
      closing: {
        amount: closing.amount,
        ...(direction ? { direction } : {}),
        ...(closing.date ? { date: closing.date } : {}),
        ...(closing.currency ? { currency: closing.currency } : {}),
      },
      fallbackDate: balanceDate,
    });
  } catch (error) {
    return { persisted: false, notes: [`closing-balance check could not run: ${(error as Error).message}`] };
  }

  const notes: string[] = [];
  let persisted = false;
  if (persist) {
    try {
      if (readStatementBalances() === null) {
        notes.push(
          "Statement-balance history is not persisted in single-file rules mode (EARVELDAJA_RULES_FILE); " +
          "the closing-balance comparison ran but was not stored.",
        );
      } else {
        appendStatementBalance({
          dimensionId: accountsDimensionsId,
          date: check.balance_date,
          closingBalance: check.statement_closing_balance,
          currency: closing.currency ?? "EUR",
          source: "camt",
          recordedAt: new Date().toISOString(),
        });
        persisted = true;
      }
    } catch (error) {
      notes.push(`closing-balance history could not be persisted: ${(error as Error).message}`);
    }
  }

  return { check, persisted, notes };
}

interface CamtImportRenderInput {
  mode: "DRY_RUN" | "EXECUTED";
  projection: CamtImportProjection;
  results: ReturnType<typeof camtResultRow>[];
  possibleDuplicates: ReturnType<typeof camtPossibleDuplicateRow>[];
  createdCount: number;
  errorCount: number;
  workflowArgs: Record<string, unknown>;
  executionReport?: PlanExecutionReport;
  planHandle?: string;
  statementBalanceCheck?: StatementBalanceCheckResult;
}

function renderCamtImportPayload(input: CamtImportRenderInput): Record<string, unknown> {
  const { projection, mode } = input;
  const dryRun = mode === "DRY_RUN";
  const summary = {
    total_statement_entries: projection.totalStatementEntries,
    eligible_entries: projection.eligibleEntries,
    filtered_out: projection.filteredOut,
    created_count: input.createdCount,
    skipped_count: projection.skipped.length,
    error_count: input.errorCount,
    possible_duplicate_count: input.possibleDuplicates.length,
  };

  const sanitizedStatementMetadata = {
    ...projection.statementMetadata,
    statement_id: wrapUntrustedOcr(projection.statementMetadata.statement_id),
    bank_name: wrapUntrustedOcr(projection.statementMetadata.bank_name),
  };
  const sanitizedResults = input.results.map(row => ({
    ...row,
    description: wrapUntrustedOcr(row.description),
    stored_description: wrapUntrustedOcr(row.stored_description),
    counterparty: wrapUntrustedOcr(row.counterparty),
  }));
  const sanitizedPossibleDuplicates = input.possibleDuplicates.map(duplicate => ({
    ...duplicate,
    counterparty: wrapUntrustedOcr(duplicate.counterparty),
    existing_transactions: duplicate.existing_transactions.map(match => ({
      ...match,
      counterparty: wrapUntrustedOcr(match.counterparty ?? undefined),
      description: wrapUntrustedOcr(match.description ?? undefined),
      suggested_patch_missing_fields: {
        ...match.suggested_patch_missing_fields,
        ...(match.suggested_patch_missing_fields?.bank_account_name
          ? { bank_account_name: wrapUntrustedOcr(match.suggested_patch_missing_fields.bank_account_name) }
          : {}),
        ...(match.suggested_patch_missing_fields?.description
          ? { description: wrapUntrustedOcr(match.suggested_patch_missing_fields.description) }
          : {}),
      },
    })),
  }));

  const workflowSummary = dryRun
    ? `CAMT dry run would create ${summary.created_count} bank transaction(s), skip ${summary.skipped_count}, flag ${summary.possible_duplicate_count} possible duplicate(s), and report ${summary.error_count} error(s).`
    : `CAMT import created ${summary.created_count} bank transaction(s), skipped ${summary.skipped_count}, flagged ${summary.possible_duplicate_count} possible duplicate(s), and reported ${summary.error_count} error(s).`;
  const workflow = buildWorkflowEnvelope({
    summary: workflowSummary,
    needs_review: sanitizedPossibleDuplicates,
    dry_run_steps: dryRun
      ? [{
          tool: "import_camt053",
          summary: workflowSummary,
          suggested_args: input.workflowArgs,
          preview: summary,
        }]
      : [],
  });

  return {
    mode,
    summary,
    workflow,
    statement_metadata: sanitizedStatementMetadata,
    total_statement_entries: summary.total_statement_entries,
    eligible_entries: summary.eligible_entries,
    filtered_out: summary.filtered_out,
    created_count: summary.created_count,
    skipped_count: summary.skipped_count,
    error_count: summary.error_count,
    sample: sanitizedResults.slice(0, 10),
    execution: buildBatchExecutionContract({
      mode,
      summary,
      results: sanitizedResults,
      skipped: projection.skipped,
      errors: [],
      needs_review: sanitizedPossibleDuplicates,
      ...(input.executionReport !== undefined ? { execution_report: input.executionReport } : {}),
    }),
    ...(projection.skipped.length > 0 && {
      skipped_summary: {
        count: projection.skipped.length,
        sample_refs: projection.skipped.slice(0, 10).map(row => row.bank_reference),
      },
    }),
    ...(input.possibleDuplicates.length > 0 && {
      possible_duplicate_summary: {
        count: input.possibleDuplicates.length,
        sample_existing_transaction_ids: input.possibleDuplicates
          .slice(0, 10)
          .flatMap(item => item.existing_transactions.map(match => match.id))
          .slice(0, 10),
        default_policy: "link_confirmed_transaction_else_review_status",
      },
    }),
    ...(input.planHandle !== undefined ? { plan_handle: input.planHandle } : {}),
    ...(input.statementBalanceCheck !== undefined ? {
      statement_balance_check: (() => {
        const sbc = input.statementBalanceCheck;
        const combinedNotes = [...(sbc.check?.notes ?? []), ...sbc.notes];
        return {
          ...(sbc.check ?? {}),
          persisted: sbc.persisted,
          ...(combinedNotes.length > 0 ? { notes: combinedNotes } : {}),
        };
      })(),
    } : {}),
  };
}

const isoDateString = (description: string) =>
  z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").describe(description);

interface CamtToolResponse {
  content: Array<{ type: "text"; text: string }>;
  // Modelled explicitly so a delegated failure cannot be silently downgraded to
  // a success by the merged wrapper.
  isError?: boolean;
}
type CamtToolHandler = (args: Record<string, unknown>) => Promise<CamtToolResponse>;

export function registerCamtImportTools(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const handlers = new Map<string, CamtToolHandler>();

  // Both constituents are fully covered by the merged process_camt053 modes
  // (parse / dry_run / execute). Handlers stay captured for internal routing;
  // the tools enter tools/list (a fixed per-session token cost) only when
  // EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1.
  const granularOnlyTools = new Set(["parse_camt053", "import_camt053"]);

  function registerCapturedTool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown,
  ): void {
    handlers.set(name, cb as unknown as CamtToolHandler);
    if (granularOnlyTools.has(name) && !exposure.exposeGranularTools) return;
    registerTool(server, name, description, paramsSchema, annotations, cb);
  }

  async function invokeCapturedTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Internal error: handler "${name}" is not registered`);
    const result = await handler(args);
    const text = result.content[0]?.text;
    if (!text) throw new Error(`CAMT wrapper received no text payload from ${name}`);

    const parsed = parseMcpResponse(text);
    return {
      payload: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { value: parsed },
      // The merged tool is the only CAMT entry point exposed by default, so a
      // delegated failure must not read as a completed import here.
      isError: result.isError === true,
    };
  }

  registerCapturedTool(
    "parse_camt053",
    "Parse a CAMT.053 bank statement XML file and preview statement metadata, entries, and summary without querying existing transactions.",
    {
      file_path: z.string().optional().describe("Absolute path/base64 input. Provide exactly one of file_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox CAMT file reference. Provide exactly one of file_path or file_ref."),
    },
    { ...readOnly, openWorldHint: true, title: "Parse CAMT.053" },
    async ({ file_path, file_ref }) => {
      // Resolve, read, preflight — and nothing else. No ledger or configuration
      // read happens until the file is known to be well-formed.
      const preflight = await loadCamt053Preflight({
        ...(file_path !== undefined ? { file_path } : {}),
        ...(file_ref !== undefined ? { file_ref } : {}),
      }, runtimeSafetyContext);
      if (!preflight.ok) return importPreflightFailure(preflight.source, preflight.rejected_fields);
      const parsed = preflight.value;
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            ...parsed,
            // statement_id and bank_name originate from the uploaded XML and
            // are attacker-controllable at the same layer as the entries.
            statement_metadata: {
              ...parsed.statement_metadata,
              statement_id: wrapUntrustedOcr(parsed.statement_metadata.statement_id),
              bank_name: wrapUntrustedOcr(parsed.statement_metadata.bank_name),
            },
            entries: parsed.entries.map(entry => ({
              ...entry,
              // CAMT free-form fields (RmtInf/Ustrd, Dbtr/Nm, Cdtr/Nm) carry
              // attacker-controllable bytes from a bank statement sent by
              // any counterparty. Treat them like OCR text at MCP output.
              counterparty_name: wrapUntrustedOcr(entry.counterparty_name),
              description: wrapUntrustedOcr(entry.description),
              ...(entry.duplicate ? { duplicate: true } : { duplicate: undefined }),
              ...(entry.duplicate_transaction_ids.length > 0 ? { duplicate_transaction_ids: entry.duplicate_transaction_ids } : { duplicate_transaction_ids: undefined }),
            })),
          }),
        }],
      };
    }
  );

  registerCapturedTool(
    "import_camt053",
    "Import CAMT.053 bank-statement XML. DRY RUN by default; execute=true creates non-duplicate transactions.",
    {
      file_path: z.string().optional().describe("Absolute path/base64 input. Provide exactly one of file_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox CAMT file reference. Provide exactly one of file_path or file_ref."),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID in e-arveldaja."),
      execute: z.boolean().optional().describe("Actually create transactions (default false = dry run)"),
      date_from: isoDateString("Only import entries from this date (YYYY-MM-DD)").optional(),
      date_to: isoDateString("Only import entries up to this date (YYYY-MM-DD)").optional(),
      plan_handle: z.string().optional().describe("Execution-plan handle from the reviewed dry run. Required for execute=true."),
    },
    { ...batch, openWorldHint: true, title: "Import CAMT.053" },
    async ({ file_path, file_ref, accounts_dimensions_id, execute, date_from, date_to, plan_handle }) => {
      if (date_from && date_to && date_from > date_to) {
        throw new Error(`date_from ${date_from} must be on or before date_to ${date_to}`);
      }
      const source: FileInputSource = {
        ...(file_path !== undefined ? { file_path } : {}),
        ...(file_ref !== undefined ? { file_ref } : {}),
      };
      const normalizedArgs = camtNormalizedArgs(accounts_dimensions_id, date_from, date_to);

      if (execute !== true) {
        // DRY RUN: preflight, preserve the existing stop gates, project the
        // import, and issue an immutable execution plan the operator reviews.
        const { snapshot, preflight } = await loadCamt053SnapshotAndPreflight(source, runtimeSafetyContext);
        if (!preflight.ok) return importPreflightFailure(preflight.source, preflight.rejected_fields);
        const loaded = preflight.value;

        await ensureAccountDimensionExists(api, accounts_dimensions_id);
        await assertStatementAccountMatchesDimension(api, loaded.statement_metadata.iban, accounts_dimensions_id);

        const projection = await computeCamtImportProjection(api, loaded, accounts_dimensions_id, date_from, date_to);
        const statementBalanceCheck = loaded.statement_metadata.closing_balance
          ? await runStatementBalanceCheck(
              api,
              loaded.statement_metadata.closing_balance,
              loaded.statement_metadata.period.to,
              accounts_dimensions_id,
              false,   // dry run: compute + report, never persist
            )
          : undefined;
        const planHandle = issueCamtPlan(runtimeSafetyContext, snapshot, projection, normalizedArgs);
        const results = projection.descriptors.map(descriptor => camtResultRow(descriptor, "would_create"));
        const possibleDuplicates = projection.descriptors
          .filter(descriptor => descriptor.possibleDuplicateMatches.length > 0)
          .map(descriptor => camtPossibleDuplicateRow(descriptor));
        const workflowArgs = {
          ...(file_ref !== undefined ? { file_ref } : {}),
          ...(file_ref === undefined && file_path !== undefined && !file_path.toLowerCase().startsWith("base64:")
            ? { file_path }
            : {}),
          accounts_dimensions_id,
          ...(date_from ? { date_from } : {}),
          ...(date_to ? { date_to } : {}),
          execute: false,
          plan_handle: planHandle,
        };
        return {
          content: [{
            type: "text",
            text: toMcpJson(renderCamtImportPayload({
              mode: "DRY_RUN",
              projection,
              results,
              possibleDuplicates,
              createdCount: projection.descriptors.length,
              errorCount: 0,
              workflowArgs,
              planHandle,
              ...(statementBalanceCheck ? { statementBalanceCheck } : {}),
            })),
          }],
        };
      }

      // EXECUTE: consume the reviewed plan, re-read the source immutably, and
      // re-validate every input before mutating through the shared tracker. A
      // plan handle is NOT human approval; the stop gates below stay in force.
      if (typeof plan_handle !== "string" || plan_handle.length === 0) {
        return planErrorResult(
          "plan_handle_required",
          "A reviewed execution-plan handle from the CAMT dry run is required to import transactions.",
        );
      }
      let storedPlan;
      try {
        storedPlan = runtimeSafetyContext.planStore.consume(plan_handle, CAMT_PLAN_DOMAIN);
      } catch (error) {
        if (error instanceof PlanStoreError) return planErrorResult(error.code, error.message);
        throw error;
      }

      // One immutable read of the reviewed source, reused for the digest check
      // and the re-parse.
      let snapshot: FileInputSnapshot;
      let preflight: CamtPreflightResult;
      try {
        ({ snapshot, preflight } = await loadCamt053SnapshotAndPreflight(source, runtimeSafetyContext));
      } catch (error) {
        if (error instanceof FileInputSnapshotError) {
          return planErrorResult("plan_drift", "The CAMT source could not be re-read to match the reviewed plan.");
        }
        throw error;
      }
      if (!preflight.ok) return importPreflightFailure(preflight.source, preflight.rejected_fields);
      const loaded = preflight.value;

      const storedIdentity = storedPlan.sourceIdentities[0];
      if (!storedIdentity || storedIdentity.digest_sha256 !== snapshot.identity.digest_sha256) {
        return planErrorResult("plan_drift", "The CAMT source bytes changed since the plan was reviewed.");
      }
      if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(normalizedArgs)) {
        return planErrorResult("plan_drift", "The import arguments changed since the plan was reviewed.");
      }

      await ensureAccountDimensionExists(api, accounts_dimensions_id);
      await assertStatementAccountMatchesDimension(api, loaded.statement_metadata.iban, accounts_dimensions_id);

      const projection = await computeCamtImportProjection(api, loaded, accounts_dimensions_id, date_from, date_to);
      const storedFingerprint = isRecord(storedPlan.privatePayload)
        ? storedPlan.privatePayload.fingerprint
        : undefined;
      if (typeof storedFingerprint !== "string" ||
        storedFingerprint !== camtPlanFingerprint(projection, normalizedArgs)) {
        return planErrorResult("plan_drift", "The reviewed CAMT plan no longer matches the current ledger and source.");
      }

      const createdApiIdByIndex = new Map<number, number>();
      const completedIndices = new Set<number>();
      const executionReport = await executeCamtCommands({
        count: projection.descriptors.length,
        prepareIndex: async index => {
          // Recheck this command's duplicate precondition against a fresh ledger
          // read immediately before its own mutate.
          const descriptor = projection.descriptors[index]!;
          const freshLedger = (await api.transactions.listAll()).filter(isNonVoidTransaction);
          const lookup = buildDuplicateLookup(freshLedger, accounts_dimensions_id);
          const duplicateIds = findDuplicateTransactionIds(
            descriptor.entry, lookup, projection.repeatedBankReferences, accounts_dimensions_id,
          );
          return duplicateIds.length > 0
            ? { outcome: "drift", error_code: "duplicate_appeared" }
            : { outcome: "ready" };
        },
        mutateIndex: async index => {
          const descriptor = projection.descriptors[index]!;
          const direction = descriptor.entry.direction === "CRDT" ? "incoming" : "outgoing";
          const response = await createBankTransaction(api, descriptor.payload, direction);
          const createdId = response.created_object_id;
          logAudit({
            tool: "import_camt053", action: "IMPORTED", entity_type: "transaction",
            entity_id: createdId,
            summary: `Imported CAMT transaction ${descriptor.entry.amount} ${descriptor.entry.currency} on ${descriptor.entry.date}`,
            details: { date: descriptor.entry.date, amount: descriptor.entry.amount, type: direction === "incoming" ? "D" : "C", source_direction: descriptor.entry.direction, description: descriptor.entry.description, counterparty: descriptor.entry.counterparty_name, bank_reference: descriptor.entry.bank_reference },
          });
          completedIndices.add(index);
          if (typeof createdId === "number" && Number.isSafeInteger(createdId) && createdId > 0) {
            createdApiIdByIndex.set(index, createdId);
            return { outcome: "completed", known_objects: [{ entity_type: "transaction", entity_id: createdId, outcome: "created" }] };
          }
          return { outcome: "completed" };
        },
      });

      const createdIndices = [...completedIndices].sort((left, right) => left - right);
      const results = createdIndices.map(index =>
        camtResultRow(projection.descriptors[index]!, "created", createdApiIdByIndex.get(index)));
      const possibleDuplicates = createdIndices
        .filter(index => projection.descriptors[index]!.possibleDuplicateMatches.length > 0)
        .map(index => camtPossibleDuplicateRow(projection.descriptors[index]!, createdApiIdByIndex.get(index)));

      // Run after the mutations so the freshly-imported (still PROJECT) rows are
      // reflected in the expected balance, and persist the closing balance.
      const statementBalanceCheck = loaded.statement_metadata.closing_balance
        ? await runStatementBalanceCheck(
            api,
            loaded.statement_metadata.closing_balance,
            loaded.statement_metadata.period.to,
            accounts_dimensions_id,
            true,   // execute: persist the closing-balance record
          )
        : undefined;

      return {
        content: [{
          type: "text",
          text: toMcpJson(renderCamtImportPayload({
            mode: "EXECUTED",
            projection,
            results,
            possibleDuplicates,
            createdCount: completedIndices.size,
            errorCount: projection.descriptors.length - completedIndices.size,
            workflowArgs: {},
            executionReport,
            ...(statementBalanceCheck ? { statementBalanceCheck } : {}),
          })),
        }],
      };
    }
  );

  registerTool(server,
    "process_camt053",
    "Merged CAMT.053 entry point. Use mode='parse' to inspect a bank statement, mode='dry_run' to preview transaction import, or mode='execute' to create transactions after approval.",
    {
      mode: z.enum(["parse", "dry_run", "execute"]).optional().describe("Workflow phase to run. Defaults to parse."),
      file_path: z.string().optional().describe("Absolute path/base64 input. Provide exactly one of file_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox CAMT file reference. Provide exactly one of file_path or file_ref."),
      accounts_dimensions_id: coerceId.optional().describe("Bank account dimension ID in e-arveldaja. Required for dry_run and execute modes."),
      date_from: isoDateString("Only import entries from this date (YYYY-MM-DD)").optional(),
      date_to: isoDateString("Only import entries up to this date (YYYY-MM-DD)").optional(),
      plan_handle: z.string().optional().describe("Execution-plan handle returned by the reviewed dry run. Required for mode='execute'."),
    },
    { ...batch, openWorldHint: true, title: "Process CAMT.053" },
    async ({ mode, file_path, file_ref, accounts_dimensions_id, date_from, date_to, plan_handle }) => {
      const selectedMode = mode ?? "parse";
      let delegatedTool: string;
      let delegatedArgs: Record<string, unknown>;

      if (selectedMode === "parse") {
        delegatedTool = "parse_camt053";
        delegatedArgs = { ...(file_path !== undefined ? { file_path } : {}), ...(file_ref !== undefined ? { file_ref } : {}) };
      } else {
        if (accounts_dimensions_id === undefined) {
          throw new Error("accounts_dimensions_id is required when mode is dry_run or execute");
        }
        delegatedTool = "import_camt053";
        delegatedArgs = {
          ...(file_path !== undefined ? { file_path } : {}),
          ...(file_ref !== undefined ? { file_ref } : {}),
          accounts_dimensions_id,
          execute: selectedMode === "execute",
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
          ...(selectedMode === "execute" && plan_handle !== undefined ? { plan_handle } : {}),
        };
      }

      const delegated = await invokeCapturedTool(delegatedTool, delegatedArgs);
      const result = remapHiddenGranularWorkflowResult(delegated.payload);
      return {
        ...(delegated.isError ? { isError: true } : {}),
        content: [{
          type: "text",
          text: toMcpJson({
            recommended_entry_point: "process_camt053",
            mode: selectedMode,
            delegated_tool: delegatedTool,
            delegated_args: delegatedArgs,
            result,
          }),
        }],
      };
    },
  );
}
