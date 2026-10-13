import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  UNTRUSTED_OCR_END_PREFIX,
  UNTRUSTED_OCR_START_PREFIX,
} from "../mcp-json.js";
import type { AccountDimension, Journal, PurchaseInvoice, Transaction } from "../types/api.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { PlanData } from "../plan-store.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { canonicalPlanJson, stripUndefinedDeep } from "../tools/camt-plan.js";
import { roundMoney, roundTo } from "../money.js";
import type { BookingGuard } from "../booking-guard.js";
import { canonicalRefNumber } from "../ref-number.js";
import { TRANSACTION_DESCRIPTION_MAX_LENGTH, weaveFullRefIntoDescription } from "../bank-transaction-create.js";
import { isNonVoidTransaction, isProjectTransaction } from "../transaction-status.js";
import { bankReferenceLookupKey, journalDocumentReferenceKeys } from "../camt/duplicate-identity.js";
import { buildInterAccountJournalIndex, normalizeReference, UNKNOWN_JOURNAL_ID } from "../tools/inter-account-utils.js";
import { toUtcDay } from "../date-utils.js";
import { findRegistrationJournal } from "../banking/receipt-ledger-check.js";
import { journalBankDirection, provenBankDirection } from "../bank-transaction-journal-direction.js";
import {
  bookedAmountForWiseRow,
  bookedCurrencyForWiseRow,
  bookedFeeAmountForWiseRow,
  bookedFeeCurrencyForWiseRow,
  buildAccountDistributionFromDimension,
  counterpartyNameForWiseRow,
  normalizeWiseCompanyName,
  normalizeWiseCurrency,
  oppositeSideForWiseRow,
  sourceDirectionForWiseDirection,
  transactionTypeForWiseDirection,
  wiseDate,
  withWiseSourceDirection,
} from "./preflight.js";
import {
  WISE_COMMAND_VERSION,
  type FeeCreateCommand,
  type MainCreateCommand,
  type TransactionCreatePayload,
  type WiseCreatedEntry,
  type WiseImportCommand,
  type WiseInvoiceFixCandidate,
  type WiseJournalizedTransferMapping,
  type WiseRow,
  type WiseSkippedEntry,
  type WiseTransferDecision,
  type WiseTransferJournalCandidate,
  type WiseTransferReview,
} from "./types.js";

// PURE projection: byte-stable command building + digest assembly + plan-review
// projection + command identity. No MCP/HTTP/filesystem/audit/environment
// import, and NO OCR/untrusted-text sandbox (that stays in the presenter). The
// module-random WISE_COMMAND_PROJECTION_SECRET seeds ONLY the untrusted-text
// command projection nonce — it is never fed into the byte-stable digest.

export { WISE_COMMAND_VERSION };
export const WISE_APPROVAL_DOMAIN = "e-arveldaja-mcp/wise-import";
export const SHA256_HEX = /^[0-9a-f]{64}$/;
const WISE_COMMAND_PROJECTION_SECRET = randomBytes(32);

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

export function approvalDigest(snapshot: unknown): string {
  return sha256(JSON.stringify(canonicalize(snapshot)));
}

export function transactionCommandExists(
  command: MainCreateCommand | FeeCreateCommand,
  transactions: Awaited<ReturnType<ApiContext["transactions"]["listAll"]>>,
): boolean {
  const live = transactions.filter(isNonVoidTransaction);
  const wiseTag = `WISE:${command.wise_id}`;
  // No signature fallback: an untagged stored row (e.g. one entered by hand)
  // is not this command's identity. The projection reports it as the advisory
  // wise_untagged_ledger_match; it never silently suppresses the create.
  return live.some(transaction => transaction.description?.startsWith(`${wiseTag} `) || transaction.description === wiseTag);
}

export function createdTransactionMatchesApprovedPayload(
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
  // The write boundary (createBankTransaction) canonicalizes the reference to
  // the cap and, when truncated, weaves the full ref into the description. Mirror
  // that exactly so the stored transaction still matches the approved payload for
  // an over-cap ref — otherwise a legitimate inter-account/fee confirm aborts
  // with a false "Stale created transaction precondition".
  const canonicalRef = canonicalRefNumber(payload.ref_number);
  const expectedRefNumber = canonicalRef.value;
  const expectedDescription = canonicalRef.truncated && canonicalRef.full
    ? weaveFullRefIntoDescription(payload.description ?? undefined, canonicalRef.full)
    : payload.description;
  // `type` is not compared: the live API reads every transaction back as "C"
  // whatever was stored, so an incoming ("D") row would always look changed.
  // The direction is still pinned by the description, whose
  // [source_direction=IN|OUT] marker must match exactly.
  return transaction.accounts_dimensions_id === payload.accounts_dimensions_id &&
    transaction.amount === payload.amount &&
    transaction.cl_currencies_id === payload.cl_currencies_id &&
    transaction.date === payload.date &&
    sameOptional(transaction.bank_account_name, payload.bank_account_name) &&
    sameOptional(transaction.ref_number, expectedRefNumber) &&
    sameOptional(transaction.description, expectedDescription) &&
    sameOptional(transaction.clients_id, payload.clients_id);
}

export function exactStateMatches(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function commandIdentity(row: WiseRow, action: string): string {
  return sha256(`${row.rowIndex}\0${action}\0${row.id}`);
}

export function projectUntrustedCommandText(
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

export function projectWiseCommand(command: WiseImportCommand): Record<string, unknown> {
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
  }
}

// The server-plan domain that binds a reviewed Wise dry run to its execute. It
// is layered ON TOP of the M04 command digest: execute requires BOTH a live
// plan handle (one-attempt, scope/domain/TTL server binding) AND the operator's
// approved_command_digest (command-integrity check). Distinct from the
// file-reference operation discriminator "wise_input".
export const WISE_PLAN_DOMAIN = "wise_import";

// Plan-store command categories per action (lowercase, DOMAIN_PATTERN-safe).
export const WISE_PLAN_COMMAND_CATEGORY: Readonly<Record<WiseImportCommand["action"], string>> = Object.freeze({
  main_create: "wise_main_create",
  fee_create_and_confirm: "wise_fee_create_and_confirm",
  inter_account: "wise_inter_account",
});

/** Stable, position-derived plan-command id. Deterministic across dry run and
 * execute because the command list enumerates in a fixed order. */
export function wisePlanCommandId(index: number): string {
  return `wise-cmd-${index}`;
}

/** Safe, review-only projection of a compiled Wise command for the paged plan
 * review surface. Untrusted text (the Wise ID) is sandbox-wrapped; every other
 * field is server-derived or numeric. Executable payloads never enter here. */
export function wisePlanReviewProjection(command: WiseImportCommand): PlanData {
  return stripUndefinedDeep({
    action: command.action,
    date: command.date,
    booked_amount: command.booked_amount,
    booked_currency: command.booked_currency,
    source_direction: command.source_direction,
    wise_id: projectUntrustedCommandText(command, "wise_id", command.wise_id),
  });
}

export function orderedIdsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export { canonicalPlanJson };

// --- Pure command building ---------------------------------------------------

export interface WiseProjectionInput {
  readonly eligible: WiseRow[];
  /** Every row of the parsed statement, before the status, Jar and date
   * filters. Automatic matches (wise_transfer_journal_unique_legacy,
   * wise_untagged_ledger_unique) must be unique against all of them, already
   * imported or filtered out or not. */
  readonly allRows: readonly WiseRow[];
  readonly accountsDimensionsId: number;
  readonly accountDimensions: AccountDimension[];
  readonly feeAccountDimensionsId: number | undefined;
  readonly wiseClientId: number | undefined;
  /** Non-void ledger transactions, already fetched by the operation layer. */
  readonly existingTx: Transaction[];
  readonly transferDecisions: Map<WiseRow, WiseTransferDecision>;
  readonly postingDimensionsSnapshot: Map<number, AccountDimension>;
  /** Every own bank account dimension the company has configured
   * (getBankAccounts), not only this statement's transfer endpoints. */
  readonly bankDimensionIds: ReadonlySet<number>;
  readonly journalSnapshot: Journal[];
  /** Lane B guard over `journalSnapshot`, built fresh per projection pass
   * (resolution consumes matched ref-less journals). */
  readonly createInterAccountGuard: (ownDimensionIds: Set<number>) => BookingGuard;
  /** Exact Wise IDs the operator passed in confirm_own_transfer_ids. */
  readonly approvedTransferIds: ReadonlySet<string>;
  /** Operator-reviewed journalized_transfer_ids: Wise ID → the labelled
   * inter-account journal that already books it. */
  readonly journalizedTransferIds?: readonly WiseJournalizedTransferMapping[];
  readonly ownCompanyClientId: number | undefined;
  readonly ownCompanyClientMatches: unknown;
  readonly allPurchaseInvoices: PurchaseInvoice[];
}

export interface WiseProjectionOutput {
  commands: WiseImportCommand[];
  created: WiseCreatedEntry[];
  skipped: WiseSkippedEntry[];
  mainCommandKeysByRow: Map<number, string>;
  ownershipReviews: WiseTransferReview[];
  invoiceFixCandidates: WiseInvoiceFixCandidate[];
  /** True when a fee row still needs booking but the fee dimension / Wise
   * client were not supplied: resolve them and project again. */
  feeResolutionRequired: boolean;
}

// Transactions.bank_account_name maxLength in the e-arveldaja API.
const WISE_BANK_ACCOUNT_NAME_MAX_LENGTH = 100;

// Inter-account route for Wise review rows: merged tool (registered on every
// profile) first, granular tool as the standard/full alternative.
const WISE_INTER_ACCOUNT_ROUTE =
  "preview it with reconcile_bank_transactions mode 'inter_account_dry_run' (reconcile_inter_account_transfers on the standard/full profile) and run mode 'execute_inter_account' with that preview's plan_handle only for the actions the user approved; a row the preview leaves out (e.g. a foreign-currency leg without EUR base evidence) still needs its counterpart or rate resolved, or manual booking";
const WISE_TRANSFER_CROSS_CURRENCY_REASON =
  `Wise transfer is not a same-currency EUR movement, so its booked amount is not the base EUR the counterpart bank account records. The row is imported unconfirmed; ${WISE_INTER_ACCOUNT_ROUTE}.`;
const WISE_TRANSFER_JOURNAL_AMBIGUOUS_REASON =
  `A same-amount inter-account journal within one day of this Wise transfer cannot be told apart from this transfer (ambiguous or differently labelled). The row is imported unconfirmed. First check whether one of the candidate journals books exactly this Wise transfer: if one does, do not reconcile the row (that would book the transfer twice): while the row is not yet created (a preview), re-run the import with journalized_transfer_ids [{ wise_id, journal_id }] so it is recorded as already journalized instead (the mapping is validated and needs a journal with a document number); once the row exists, a mapping no longer applies, so delete the unconfirmed row after the user approves; if none does, ${WISE_INTER_ACCOUNT_ROUTE}.`;
const WISE_TRANSFER_JOURNAL_INCONSISTENT_REASON =
  `A journal labelled with this Wise transfer's ID already exists, but its Wise-account posting does not move this row's amount (gross, or net of a fee the journal also books) in this row's direction. Confirming the row would book the transfer twice, so it is imported unconfirmed. Correct or remove the labelled journal. If a journal then books this transfer, delete this unconfirmed row instead of reconciling it: reconciliation may not recognise the labelled journal and would book the transfer twice. Only if no journal books it, ${WISE_INTER_ACCOUNT_ROUTE}.`;
const WISE_LEGACY_LEG_AMBIGUOUS_REASON =
  "A bank row stored by an older release under this plain Wise ID (before split-leg tags and the currency fix) could be any of several legs of this ID, so which leg is still missing cannot be told. This leg and its fee are not imported; compare the stored row with the Wise statement and book the missing leg manually.";
const WISE_TRANSFER_MAPPING_REJECTED_REASON =
  "The journalized_transfer_ids mapping for this Wise transfer was not accepted, so the row resolves as if unmapped: it may still be skipped as already journalized, or created unconfirmed for review; see this row's own result. Check the mapping. Rejected because";
const WISE_TRANSFER_MAPPING_UNUSED_REASON =
  "This journalized_transfer_ids mapping was not used:";
const WISE_UNTAGGED_LEDGER_MATCH_REASON =
  "A bank row without a WISE: identity tag, already stored on this Wise account, has the same date, amount and currency. It may be this movement entered by hand. Advisory only: the row is still imported; if it duplicates the stored row, remove one of them.";
const WISE_TRANSFER_ALREADY_IMPORTED_REASON =
  `This Wise transfer was already imported by an earlier run, so confirm_own_transfer_ids does not act on it. If the existing bank transaction is already CONFIRMED, nothing is left to do; if it is still unconfirmed (PROJECT), ${WISE_INTER_ACCOUNT_ROUTE}.`;

/**
 * The Wise bank leg's amount when a journal books this row's transfer net of
 * the row's separate fee row (IN: gross − fee; OUT: gross + fee), or
 * `undefined` when the row has no same-currency fee. Read from the row itself,
 * so a fee row already stored by an interrupted import (whose fee command is
 * deduplicated away) still counts.
 */
export function wiseLegAmountNetOfFee(row: WiseRow, amount: number): number | undefined {
  const direction = sourceDirectionForWiseDirection(row.direction);
  const fee = bookedFeeAmountForWiseRow(row);
  const bookedCurrency = bookedCurrencyForWiseRow(row);
  if (!direction || !(fee > 0) || bookedFeeCurrencyForWiseRow(row, bookedCurrency) !== bookedCurrency) return undefined;
  return roundMoney(direction === "IN" ? amount - fee : amount + fee);
}

/**
 * Whether `journal` is labelled with this Wise transfer's ID (bare or as
 * WISE:{id}), by the shared journal document-reference key contract. Amount
 * plays no part: an exact-reference journal is this transfer's identity
 * whatever it books.
 */
export function journalLabelledWithWiseId(journal: Journal, wiseId: string): boolean {
  const keys = journalDocumentReferenceKeys(journal.document_number);
  return [wiseId, `WISE:${wiseId}`].some(reference => {
    const key = bankReferenceLookupKey(reference);
    return key !== undefined && keys.includes(key);
  });
}

/** A label shaped like a Wise ID (TRANSFER-123, CARD_TRANSACTION-9001). */
const WISE_ID_SHAPED_LABEL = /^[A-Z]+(?:_[A-Z]+)*-\d+$/;

/**
 * Signed net (D +, C −) in base EUR cents that `journal` posts on
 * `dimensionId`, or `undefined` when a posting there cannot show its EUR
 * amount (foreign currency without a base amount) or has no side.
 */
function dimensionNetEurCents(journal: Journal, dimensionId: number): number | undefined {
  let net = 0;
  for (const posting of journal.postings ?? []) {
    if (posting.is_deleted || posting.accounts_dimensions_id !== dimensionId) continue;
    const currency = (posting.cl_currencies_id ?? journal.cl_currencies_id ?? "EUR").toUpperCase();
    if ((posting.base_amount == null && currency !== "EUR") || (posting.type !== "D" && posting.type !== "C")) return undefined;
    net += (posting.type === "D" ? 1 : -1) * Math.round((posting.base_amount ?? posting.amount) * 100);
  }
  return net;
}

/** Whether two ISO dates are at most one day apart; an unreadable date is near
 * anything (fails closed for a uniqueness check). */
function withinOneDay(left: string | undefined, right: string | undefined): boolean {
  const day = (value: string | undefined) => /^\d{4}-\d{2}-\d{2}/.test(value ?? "") ? toUtcDay(value!) : NaN;
  const gap = Math.abs(day(left) - day(right));
  return !Number.isFinite(gap) || gap <= 86400000;
}

/** Lower-case letter/digit tokens of a free-text field. */
function textTokens(value: string | null | undefined): string[] {
  return (value ?? "").normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token !== "");
}

/** Name tokens that identify no one: legal forms, payment and Wise words. */
const GENERIC_NAME_TOKENS = new Set([
  "as", "oü", "ou", "mtü", "fie", "ltd", "llc", "inc", "gmbh", "ab", "oy", "sa", "bv", "plc", "co", "com", "the", "and",
  "wise", "card", "payment", "transfer", "fee", "bank", "money", "kaardimakse", "makse", "ülekanne", "teenustasu",
]);

/**
 * Positive identity evidence that an untagged stored row IS this Wise row, not
 * only a same-date same-amount movement: its ref_number or description holds
 * the Wise ID's numeric part as a whole token, or the Wise counterparty name
 * (at least 3 characters beyond generic words) occurs as a whole-token run in
 * its bank_account_name or description. A structured ref_number that is
 * neither the Wise ID number nor the Wise reference contradicts it. Works on
 * the raw API strings (the projection never sees sandbox markers).
 */
function untaggedRowNamesWiseRow(row: WiseRow, tx: Transaction): boolean {
  const idNumber = row.id.match(/-(\d{6,})$/)?.[1];
  const ref = normalizeReference(tx.ref_number);
  const refIsIdNumber = idNumber !== undefined && textTokens(ref).includes(idNumber);
  if (ref !== "" && !refIsIdNumber &&
    ref.toUpperCase() !== normalizeReference(row.reference).toUpperCase()) return false;
  if (refIsIdNumber || (idNumber !== undefined && textTokens(tx.description).includes(idNumber))) return true;
  const name = textTokens(counterpartyNameForWiseRow(row));
  if (name.filter(token => !GENERIC_NAME_TOKENS.has(token)).join("").length < 3) return false;
  return [tx.bank_account_name, tx.description].some(field => {
    const tokens = textTokens(field);
    return tokens.some((_token, start) => name.every((token, offset) => tokens[start + offset] === token));
  });
}

interface StoredWiseLeg {
  readonly tx: Transaction;
  readonly tag: string;
  /** Booked currency named by a WISE:{id}:{CUR} tag; undefined for a plain tag. */
  readonly suffixCurrency: string | undefined;
}

function mainLegValue(leg: WiseRow): { amount: number; currency: string } {
  return { amount: bookedAmountForWiseRow(leg), currency: bookedCurrencyForWiseRow(leg) };
}

function feeLegValue(leg: WiseRow): { amount: number; currency: string } | undefined {
  return bookedFeeAmountForWiseRow(leg) > 0
    ? { amount: bookedFeeAmountForWiseRow(leg), currency: bookedFeeCurrencyForWiseRow(leg, bookedCurrencyForWiseRow(leg)) }
    : undefined;
}

/** Whether a stored WISE-tagged row accounts for an exported leg, by matching
 * pass: 1 currency and amount; 2 currency; 3 (plain tag) amount only — rows
 * stored before the currency fix carry EUR; 4 (plain tag, several exported
 * legs) any leg, as the previous release booked the first one. A leg-suffixed
 * tag only ever matches a leg of its own booked currency. Passes 3 and 4 serve
 * only that EUR-stored legacy row, and only while no still-unclaimed exported
 * leg of the ID is in EUR: a row stored in another explicit currency is its own leg, so it never
 * hides a missing leg of a different currency. */
function storedLegMatches(
  entry: StoredWiseLeg,
  leg: WiseRow,
  value: { amount: number; currency: string },
  exportedLegs: number,
  exportedCurrencies: readonly string[],
  pass: number,
): boolean {
  if (entry.suffixCurrency !== undefined && entry.suffixCurrency !== bookedCurrencyForWiseRow(leg)) return false;
  const storedCurrency = entry.tx.cl_currencies_id ?? "EUR";
  const sameCurrency = storedCurrency === value.currency;
  const sameAmount = Math.abs(entry.tx.amount! - value.amount) < 0.005;
  const legacyEurRow = entry.suffixCurrency === undefined && storedCurrency === "EUR" &&
    !exportedCurrencies.includes(storedCurrency);
  switch (pass) {
    case 1: return sameCurrency && sameAmount;
    case 2: return sameCurrency;
    case 3: return legacyEurRow && sameAmount;
    default: return legacyEurRow && exportedLegs > 1;
  }
}

export function projectWiseCommands(input: WiseProjectionInput): WiseProjectionOutput {
  const {
    eligible,
    allRows,
    accountsDimensionsId,
    accountDimensions,
    feeAccountDimensionsId,
    wiseClientId,
    existingTx,
    transferDecisions,
    postingDimensionsSnapshot,
    bankDimensionIds,
    journalSnapshot,
    createInterAccountGuard,
    approvedTransferIds,
    journalizedTransferIds = [],
    ownCompanyClientId,
    ownCompanyClientMatches,
    allPurchaseInvoices,
  } = input;
  const accounts_dimensions_id = accountsDimensionsId;

  // The explicit direction marker a stored row carries, "?" when it has none.
  // Only the marker counts: the read-back `type` is unreliable (0.22.0 forced "C").
  const markedWiseDirection = (description?: string | null): "IN" | "OUT" | "?" => {
    const marked = description?.match(/\[source_direction=(IN|OUT)\]\s*$/i)?.[1];
    return marked === undefined ? "?" : (marked.toUpperCase() as "IN" | "OUT");
  };
  // Also check by Wise ID in description
  const seenWiseIds = new Set(
    existingTx
      .filter(tx => tx.description?.startsWith("WISE:"))
      .map(tx => tx.description!.split(" ")[0])
  );

  // Wise exports a card payment funded from two balances as two rows sharing
  // one ID (e.g. a USD-balance leg and a converted EUR leg carrying the fee).
  // Each is its own cash movement, so a split leg is identified by ID + booked
  // currency: WISE:{id}:{CUR} (WISE:FEE:{id}:{CUR} for its fee). A single-row
  // ID keeps the plain WISE:{id} tag.
  const legsById = new Map<string, WiseRow[]>();
  for (const row of eligible) legsById.set(row.id, [...(legsById.get(row.id) ?? []), row]);
  // Stored rows carrying an identity of an exported ID, plain or leg-suffixed.
  const storedTagged = (prefix: string): StoredWiseLeg[] => existingTx.flatMap((tx): StoredWiseLeg[] => {
    const tag = tx.description?.split(" ")[0];
    if (tag === undefined || typeof tx.amount !== "number") return [];
    if (tag === prefix) return [{ tx, tag, suffixCurrency: undefined }];
    const suffix = tag.startsWith(`${prefix}:`) ? tag.slice(prefix.length + 1) : undefined;
    const match = suffix?.match(/^([A-Z]{3})(?:-\d+)?$/);
    return match ? [{ tx, tag, suffixCurrency: match[1] }] : [];
  });
  const legSuffix = new Map<WiseRow, string>();
  const storedMainLegs = new Map<string, StoredWiseLeg[]>();
  const storedFeeLegs = new Map<string, StoredWiseLeg[]>();
  for (const [id, legs] of legsById) {
    const storedMain = storedTagged(`WISE:${id}`);
    const storedFee = storedTagged(`WISE:FEE:${id}`);
    storedMainLegs.set(id, storedMain);
    storedFeeLegs.set(id, storedFee);
    if (legs.length < 2) {
      // A lone exported leg whose ID already has a stored leg-suffixed tag, or a
      // stored row it does not match, is one leg of a split: tag it by currency
      // too, so the identity does not depend on which legs the export holds.
      const leg = legs[0]!;
      const stored = [...storedMain, ...storedFee];
      const split = stored.some(entry => entry.suffixCurrency !== undefined) ||
        (storedMain.length > 0 && !storedMain.some(entry => [1, 2, 3].some(pass => storedLegMatches(entry, leg, mainLegValue(leg), legs.length, [mainLegValue(leg).currency], pass))));
      if (!split) continue;
      const currency = bookedCurrencyForWiseRow(leg);
      const taken = new Set(stored.map(entry => entry.tag.slice(entry.tag.lastIndexOf(":") + 1)));
      let suffix = currency;
      for (let n = 1; taken.has(suffix); n++) suffix = `${currency}-${n}`;
      legSuffix.set(leg, suffix);
      continue;
    }
    for (const leg of legs) {
      const currency = bookedCurrencyForWiseRow(leg);
      const sameCurrency = legs.filter(other => bookedCurrencyForWiseRow(other) === currency);
      legSuffix.set(leg, sameCurrency.length > 1 ? `${currency}-${sameCurrency.indexOf(leg) + 1}` : currency);
    }
  }
  // Each stored row accounts for at most one exported leg of its ID, matched by
  // booked currency and amount whatever its tag form, so a one-leg export, a
  // reordered export and a ledger written by releases before split-leg tags
  // (which booked only the FIRST leg as WISE:{id} and the first fee-bearing
  // leg's fee as WISE:FEE:{id}) all resolve to the legs really missing.
  // A plain row whose amount-only / any-leg pass still fits several legs
  // cannot say which one it is: the ID's unclaimed legs go to review.
  const ambiguousLegacyIds = new Set<string>();
  const claimStoredLegs = (
    storedById: Map<string, StoredWiseLeg[]>,
    value: (leg: WiseRow) => { amount: number; currency: string } | undefined,
  ): Set<WiseRow> => {
    const claimed = new Set<WiseRow>();
    for (const [id, legs] of legsById) {
      const stored = storedById.get(id) ?? [];
      // Leg-tagged rows (WISE:{id}:{CUR}) claim their legs first, then plain
      // rows run the passes against the legs left, whatever the ledger order.
      phases: for (const legTagged of [true, false]) {
        const open = new Set(stored.filter(entry => (entry.suffixCurrency !== undefined) === legTagged));
        for (let pass = 1; pass <= 4; pass++) {
          for (const entry of [...open]) {
            // Legs another stored row already accounts for are out of the EUR gate.
            const currencies = legs.filter(leg => !claimed.has(leg)).flatMap(leg => value(leg)?.currency ?? []);
            const candidates = legs.filter(candidate => {
              const candidateValue = value(candidate);
              return !claimed.has(candidate) && candidateValue !== undefined &&
                storedLegMatches(entry, candidate, candidateValue, legs.length, currencies, pass);
            });
            if (candidates.length === 0) continue;
            if (pass >= 3 && candidates.length > 1) {
              ambiguousLegacyIds.add(id);
              break phases;
            }
            claimed.add(candidates[0]!);
            open.delete(entry);
          }
        }
      }
    }
    return claimed;
  };
  const claimedMainLegs = claimStoredLegs(storedMainLegs, mainLegValue);
  const claimedFeeLegs = claimStoredLegs(storedFeeLegs, feeLegValue);

  const created: WiseCreatedEntry[] = [];
  const skipped: WiseSkippedEntry[] = [];
  const commands: WiseImportCommand[] = [];
  const mainCommandKeysByRow = new Map<number, string>();
  const alreadyImportedApprovalReviews: WiseTransferReview[] = [];
  const legacyLegReviews: WiseTransferReview[] = [];
  let feeResolutionRequired = false;

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
    const legId = legSuffix.has(row) ? `${row.id}:${legSuffix.get(row)}` : row.id;
    const wiseIdTag = `WISE:${legId}`;
    if (ambiguousLegacyIds.has(row.id) && (!claimedMainLegs.has(row) || (fee > 0 && !claimedFeeLegs.has(row)))) {
      legacyLegReviews.push({
        wise_id: legId,
        code: "wise_legacy_leg_ambiguous",
        reason: WISE_LEGACY_LEG_AMBIGUOUS_REASON,
        source_verified: false,
        target_verified: false,
        approval_required: false,
      });
      continue;
    }
    // The WISE:{id} tag is the dedup identity and the source-direction marker is
    // mandatory, so neither is ever truncated: a row whose main (or fee)
    // description cannot fit them within the description cap is not booked.
    if (
      withWiseSourceDirection(wiseIdTag, sourceDirection).length > TRANSACTION_DESCRIPTION_MAX_LENGTH ||
      (fee > 0 && withWiseSourceDirection(`WISE:FEE:${legId} Wise teenustasu`, "OUT").length > TRANSACTION_DESCRIPTION_MAX_LENGTH)
    ) {
      skipped.push({
        wise_id: row.id,
        reason: `Wise ID is too long (${row.id.length} characters) for its WISE: identity tag and source-direction marker to fit the ${TRANSACTION_DESCRIPTION_MAX_LENGTH}-character transaction description; book this row manually.`,
      });
      continue;
    }
    const counterpartyName = counterpartyNameForWiseRow(row);
    const oppositeSide = oppositeSideForWiseRow(row);

    // Build description
    const narrativeParts: string[] = [];
    if (counterpartyName) narrativeParts.push(counterpartyName);
    if (row.category && row.category !== "General") narrativeParts.push(`(${row.category})`);
    if (oppositeSide.currency !== transactionCurrency) {
      narrativeParts.push(`[${oppositeSide.amount} ${oppositeSide.currency} @ ${row.exchangeRate}]`);
    }
    const narrative = narrativeParts.join(" ");
    // Transactions.description maxLength is 150: trim only the narrative so the
    // WISE:{id} identity prefix and the trailing [source_direction=…] marker
    // always survive (mirrors CAMT's metadata-marker budget).
    const narrativeBudget = TRANSACTION_DESCRIPTION_MAX_LENGTH - withWiseSourceDirection(wiseIdTag, sourceDirection).length - 1;
    const cappedNarrative = narrative.length > narrativeBudget
      ? narrative.slice(0, Math.max(0, narrativeBudget)).trimEnd()
      : narrative;
    const desc = withWiseSourceDirection(cappedNarrative ? `${wiseIdTag} ${cappedNarrative}` : wiseIdTag, sourceDirection);
    const bankAccountName = counterpartyName?.slice(0, WISE_BANK_ACCOUNT_NAME_MAX_LENGTH);
    const mainTagImported = seenWiseIds.has(wiseIdTag) || claimedMainLegs.has(row);
    // Only a WISE: identity proves the row is stored: an untagged lookalike
    // gets the wise_untagged_ledger_match advisory below, never a silent skip.
    const mainAlreadyImported = mainTagImported;
    let mainAvailableForFee = false;

    if (mainAlreadyImported) {
      skipped.push({
        wise_id: legId,
        reason: "Already imported (Wise ID match)",
      });
      if (approvedTransferIds.has(row.id)) {
        const decision = transferDecisions.get(row);
        alreadyImportedApprovalReviews.push({
          wise_id: row.id,
          code: "wise_transfer_already_imported",
          reason: WISE_TRANSFER_ALREADY_IMPORTED_REASON,
          source_verified: decision?.sourceVerified ?? false,
          target_verified: decision?.targetVerified ?? false,
          approval_required: false,
        });
      }
      mainAvailableForFee = true;
    } else {
      const createPayload: TransactionCreatePayload = {
        accounts_dimensions_id,
        type,
        amount,
        cl_currencies_id: transactionCurrency,
        date,
        description: desc,
        bank_account_name: bankAccountName,
        ref_number: row.reference || undefined,
      };
      commands.push({
        version: WISE_COMMAND_VERSION,
        action: "main_create",
        mutation_mode: "create",
        row_index: row.rowIndex,
        row_key: `row:${row.rowIndex}:main`,
        identity_hash: commandIdentity(row, "main"),
        wise_id: legId,
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
        wise_id: legId,
        date,
        type,
        source_direction: sourceDirection,
        amount,
        description: desc,
        status: "would_create",
        source_row: row,
      });
      // Deliberately NOT feeding this row's signature back into the stored-row
      // set: within one statement the Wise ID is the identity, and seenWiseIds
      // already carries it. Two rows with distinct Wise IDs are two distinct
      // payments however alike they look — two identical card payments to the
      // same merchant on one day, or a payment and its same-day refund. Folding
      // planned rows into the duplicate set silently dropped the second one and
      // under-booked the account.
      seenWiseIds.add(wiseIdTag);
      mainAvailableForFee = true;
    }

    if (fee > 0) {
      if (!mainAvailableForFee) {
        skipped.push({
          wise_id: `FEE:${legId}`,
          reason: "Skipped because main transaction was not created",
        });
        continue;
      }

      const feeWiseIdTag = `WISE:FEE:${legId}`;
      const feeDesc = withWiseSourceDirection(`${feeWiseIdTag} Wise teenustasu`, "OUT");
      const feeCurrency = bookedFeeCurrencyForWiseRow(row, transactionCurrency);
      const feeTagImported = seenWiseIds.has(feeWiseIdTag) || claimedFeeLegs.has(row);
      if (feeTagImported) {
        skipped.push({
          wise_id: `FEE:${legId}`,
          reason: "Fee already imported (Wise ID match)",
        });
        continue;
      }

      const feeType = "C" as const; // Fees are always outgoing regardless of main transaction direction

      // Resolved lazily by the caller: only a fee that survives dedup needs
      // the fee dimension and the Wise client.
      if (!feeAccountDimensionsId || !wiseClientId) {
        feeResolutionRequired = true;
        continue;
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
        wise_id: `FEE:${legId}`,
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
        wise_id: `FEE:${legId}`,
        date,
        type: feeType,
        source_direction: "OUT",
        amount: fee,
        description: feeDesc,
        status: "would_create",
        booked_currency: feeCurrency,
      });
      seenWiseIds.add(feeWiseIdTag);
    }
  }

  const ownershipReviews = created.flatMap(entry => {
    if (!entry.source_row) return [];
    const review = transferDecisions.get(entry.source_row)?.review;
    return review ? [review] : [];
  });
  ownershipReviews.push(...alreadyImportedApprovalReviews, ...legacyLegReviews);

  // journalized_transfer_ids: an operator-reviewed claim that a labelled
  // journal (identity-only for Lane B) books this Wise transfer. Accepted only
  // when every check below holds; otherwise the row is created as usual and a
  // review names the reason. Checks on the mapping list itself come first, so
  // the verdict never depends on the CSV or mapping order.
  const mappingReview = (wiseId: string, code: "wise_transfer_mapping_rejected" | "unused_mapping", journalId: number, why: string,
    decision?: WiseTransferDecision): WiseTransferReview => ({
    wise_id: wiseId,
    code,
    reason: `${code === "unused_mapping" ? WISE_TRANSFER_MAPPING_UNUSED_REASON : WISE_TRANSFER_MAPPING_REJECTED_REASON} ${why}.`,
    source_verified: decision?.sourceVerified ?? false,
    target_verified: decision?.targetVerified ?? false,
    approval_required: false,
    journal_id: journalId,
  });
  const mappingReviews: WiseTransferReview[] = [];
  const pendingMappings = new Map<WiseRow, number>();
  const acceptedMappings = new Map<WiseRow, number>();
  // A rejected mapping is reported and otherwise ignored: the row resolves as
  // if unmapped (guard, fee coverage, review), never a forced second booking.
  const rejectMapping = (row: WiseRow, journalId: number, why: string) => {
    mappingReviews.push(mappingReview(row.id, "wise_transfer_mapping_rejected", journalId, why, transferDecisions.get(row)));
  };
  for (const [index, mapping] of journalizedTransferIds.entries()) {
    if (journalizedTransferIds.findIndex(other => other.wise_id === mapping.wise_id) !== index) continue;
    const legs = eligible.filter(row => row.id === mapping.wise_id);
    const pending = created.filter(entry => entry.source_row !== undefined && legs.includes(entry.source_row));
    if (pending.length === 0) {
      mappingReviews.push(mappingReview(mapping.wise_id, "unused_mapping", mapping.journal_id, legs.length === 0
        ? "no eligible row of this statement has this Wise ID"
        : "this Wise transfer was already imported by an earlier run"));
      continue;
    }
    const why = journalizedTransferIds.filter(other => other.wise_id === mapping.wise_id).length > 1
      ? "the Wise ID is listed more than once in journalized_transfer_ids"
      : legs.length > 1
        ? "several rows of this statement share the Wise ID, so the mapping cannot say which one the journal books"
        : new Set(journalizedTransferIds.filter(other => other.journal_id === mapping.journal_id).map(other => other.wise_id)).size > 1
          ? "another Wise ID is mapped to the same journal"
          : undefined;
    for (const entry of pending) {
      if (why !== undefined) rejectMapping(entry.source_row!, mapping.journal_id, why);
      else pendingMappings.set(entry.source_row!, mapping.journal_id);
    }
  }
  const eligibleIds = new Set(eligible.map(row => normalizeReference(row.id)));

  const approvedTransferDecisions = [...transferDecisions.values()].filter(
    decision => decision.ownershipBasis !== undefined,
  );
  if (approvedTransferDecisions.length > 0) {
    const ownDimensionIds = new Set<number>([accounts_dimensions_id]);
    for (const decision of approvedTransferDecisions) {
      if (decision.targetDimensionId !== undefined) ownDimensionIds.add(decision.targetDimensionId);
    }
    // Fee coverage tells bank postings from the fee expense by every own bank
    // account, not only this statement's endpoints.
    const ownBankDimensionIds = new Set<number>([...ownDimensionIds, ...bankDimensionIds]);
    const ownBankAccountIds = new Set(accountDimensions
      .filter(dimension => dimension.id !== undefined && ownBankDimensionIds.has(dimension.id))
      .map(dimension => dimension.accounts_id));
    // Lane B, like reconcile_inter_account_transfers: ±1 day, labelled journals
    // identity-only, a matched ref-less journal consumed. Planned rows are NOT
    // recorded back: every row here is a Wise-side leg with a unique Wise ID,
    // so two of them are never the two legs of one transfer.
    const guard = createInterAccountGuard(ownDimensionIds);
    // The same Lane B index, read-only, to name the journals a review is about.
    const laneBIndex = buildInterAccountJournalIndex(journalSnapshot, ownDimensionIds);
    const laneBCandidateIds = (targetDim: number, amounts: number[], date: string): number[] => {
      const day = toUtcDay(date);
      const dates = Number.isFinite(day)
        ? [-1, 0, 1].map(offset => new Date(day + offset * 86400000).toISOString().slice(0, 10))
        : [date];
      const ids = new Set(amounts.flatMap(amount => dates.flatMap(candidateDate =>
        (laneBIndex.get(`${accounts_dimensions_id}|${targetDim}|${roundMoney(amount)}|${candidateDate}`) ?? [])
          .map(entry => entry.journal_id))));
      ids.delete(UNKNOWN_JOURNAL_ID);
      return [...ids].sort((left, right) => left - right);
    };
    const describeCandidate = (journalId: number): WiseTransferJournalCandidate => {
      const journal = journalSnapshot.find(candidate => candidate.id === journalId);
      const counterpart = journal?.operation_type === "TRANSACTION" && journal.operations_id !== undefined
        ? existingTx.find(tx => tx.id === journal.operations_id && isNonVoidTransaction(tx) &&
            tx.accounts_dimensions_id !== accounts_dimensions_id && ownDimensionIds.has(tx.accounts_dimensions_id))
        : undefined;
      const counterpartKey = bankReferenceLookupKey(counterpart?.bank_ref_number ?? undefined);
      return {
        journal_id: journalId,
        ...(counterpart?.id !== undefined ? { counterpart_transaction_id: counterpart.id } : {}),
        label_source: counterpartKey !== undefined && journalDocumentReferenceKeys(journal?.document_number).includes(counterpartKey)
          ? "counterpart_bank_ref"
          : "other",
      };
    };
    const hasForeignPostingWithoutBase = (journal: Journal): boolean =>
      (journal.postings ?? []).some(posting => !posting.is_deleted && posting.base_amount == null &&
        (posting.cl_currencies_id ?? journal.cl_currencies_id ?? "EUR").toUpperCase() !== "EUR");
    // Whether the journal's Wise-dimension postings net to `amount` in the
    // row's direction (IN debits the Wise account), in base EUR.
    const wiseLegMoves = (journal: Journal | undefined, row: WiseRow, amount: number): boolean => {
      const cents = (value: number) => Math.round(value * 100);
      const signedWiseCents = (journal?.postings ?? [])
        .filter(posting => !posting.is_deleted && posting.accounts_dimensions_id === accounts_dimensions_id)
        .reduce((sum, posting) => sum + (posting.type === "D" ? 1 : -1) * cents(posting.base_amount ?? posting.amount), 0);
      return journal !== undefined &&
        signedWiseCents === (sourceDirectionForWiseDirection(row.direction) === "IN" ? 1 : -1) * cents(amount);
    };
    const mappingRejection = (row: WiseRow, journalId: number): string | undefined => {
      const decision = transferDecisions.get(row);
      const targetDimensionId = decision?.targetDimensionId;
      if (!decision?.ownershipBasis || targetDimensionId === undefined || !postingDimensionsSnapshot.get(targetDimensionId)?.id) {
        return "the row is not an own transfer approved for inter-account booking";
      }
      if (bookedCurrencyForWiseRow(row) !== "EUR" || normalizeWiseCurrency(row.sourceCurrency) !== normalizeWiseCurrency(row.targetCurrency)) {
        return "the row is not a same-currency EUR transfer";
      }
      const journal = journalSnapshot.find(candidate => candidate.id === journalId);
      if (!journal) return "the journal is not in the ledger";
      if (journal.is_deleted) return "the journal is deleted";
      if (journal.registered !== true) return "the journal is not registered";
      const label = normalizeReference(journal.document_number);
      if (label === "") {
        return "the journal carries no document number; a ref-less journal is matched automatically, or reviewed when ambiguous";
      }
      // Lane B and the checks below compare base EUR: a foreign posting without
      // a base amount cannot show the EUR the row moved.
      if (hasForeignPostingWithoutBase(journal)) {
        return "the journal has foreign-currency postings without an EUR base amount";
      }
      const amount = bookedAmountForWiseRow(row);
      const candidateIds = laneBCandidateIds(targetDimensionId, [amount], wiseDate(row.finishedOn || row.createdOn));
      if (!candidateIds.includes(journalId)) {
        return "the journal is not a same-amount transfer between this Wise account and the counterpart account within one day";
      }
      if (!wiseLegMoves(journal, row, amount)) {
        return "the journal's Wise-account posting does not move this amount in this row's direction";
      }
      // Exact-reference claims are reserved across the whole statement, before
      // any mapping: a journal labelled with another row's Wise ID belongs to
      // that row, and a row whose own exact-reference journal exists is that
      // journal's.
      if (label !== normalizeReference(row.id) && eligibleIds.has(label)) {
        return "the journal is labelled with another Wise transfer of this statement, which owns it by exact reference";
      }
      // The guard also looks the row up net of its fee, so reserve there too.
      const netAmount = wiseLegAmountNetOfFee(row, amount);
      const identityIds = laneBCandidateIds(targetDimensionId, netAmount === undefined ? [amount] : [amount, netAmount],
        wiseDate(row.finishedOn || row.createdOn));
      if (identityIds.some(id => id !== journalId &&
        normalizeReference(journalSnapshot.find(candidate => candidate.id === id)?.document_number) === normalizeReference(row.id))) {
        return "another journal already books this Wise transfer by exact reference";
      }
      return undefined;
    };
    for (const [row, journalId] of pendingMappings) {
      const why = mappingRejection(row, journalId);
      if (why !== undefined) rejectMapping(row, journalId, why);
      else acceptedMappings.set(row, journalId);
    }
    pendingMappings.clear();

    // Unique legacy match competitors: a journal is accepted automatically only
    // when no OTHER movement on the Wise account has its Lane B key (gross or
    // net of a fee, ±1 day): no other row of the parsed statement, whatever
    // its status, the date filter or whether it was imported before, and no
    // stored row on the Wise account (a stored main row also net of, or
    // grossed up by, its stored WISE:FEE: row). A key match in either
    // direction or currency counts, so the check fails closed.
    // Residual cross-file gap: accepting a journal writes nothing (no Wise
    // bank row, no journal edit, no audit entry; only the transfer's fee row,
    // if any, is stored, and it carries the fee amount, not the key). So when
    // TRANSFER-A (file 1) and TRANSFER-B (file 2) share a key and one
    // journal, and neither file contains the other transfer, each import
    // still sees that journal as unique and both are recorded as booked by it.
    // Only an import whose CSV holds both, or a ledger holding a stored row of
    // the other, is protected.
    const statementKeys = allRows.map(row => {
      const amount = bookedAmountForWiseRow(row);
      const net = wiseLegAmountNetOfFee(row, amount);
      return { row, amounts: net === undefined ? [amount] : [amount, net], date: wiseDate(row.finishedOn || row.createdOn) };
    });
    const storedWiseKeys = existingTx.flatMap(tx => {
      if (!isNonVoidTransaction(tx) || tx.accounts_dimensions_id !== accounts_dimensions_id || typeof tx.amount !== "number") return [];
      const tag = tx.description?.startsWith("WISE:") && !tx.description.startsWith("WISE:FEE:") ? tx.description.split(" ")[0]! : undefined;
      const fees = tag === undefined ? [] : existingTx.filter(fee => isNonVoidTransaction(fee) &&
        fee.accounts_dimensions_id === accounts_dimensions_id && typeof fee.amount === "number" &&
        fee.description?.split(" ")[0] === tag.replace(/^WISE:/, "WISE:FEE:")).map(fee => fee.amount);
      return [{ amounts: [tx.amount, ...fees.flatMap(fee => [tx.amount - fee, tx.amount + fee])], date: tx.date ?? "" }];
    });
    // Wise IDs and references a journal label could name: this statement's
    // rows and the WISE: tags already stored.
    const knownWiseLabels = [...new Set([
      ...allRows.flatMap(row => [row.id, row.reference]),
      ...existingTx.flatMap(tx => tx.description?.startsWith("WISE:")
        ? [tx.description.split(" ")[0]!.replace(/^WISE:(?:FEE:)?/, "")]
        : []),
    ].filter(label => normalizeReference(label) !== ""))];
    const labelledWithOtherWiseId = (journal: Journal, row: WiseRow): boolean => {
      const label = normalizeReference(journal.document_number);
      if (label === "" || journalLabelledWithWiseId(journal, row.id) || label === normalizeReference(row.reference)) return false;
      return /^WISE:/i.test(label) || WISE_ID_SHAPED_LABEL.test(label) ||
        knownWiseLabels.some(other => other !== row.id && other !== row.reference && journalLabelledWithWiseId(journal, other));
    };

    for (const entry of [...created]) {
      const row = entry.source_row;
      if (!row || entry.status !== "would_create") continue;
      const decision = transferDecisions.get(row);
      const ownershipBasis = decision?.ownershipBasis;
      const targetDimensionId = decision?.targetDimensionId;
      const targetDim = targetDimensionId === undefined
        ? undefined
        : postingDimensionsSnapshot.get(targetDimensionId);
      if (!decision || !ownershipBasis || targetDimensionId === undefined || !targetDim?.id) continue;
      const mappedJournalId = acceptedMappings.get(row);

      const reviewFor = (code: WiseTransferReview["code"], reason: string): WiseTransferReview => ({
        wise_id: row.id,
        code,
        reason,
        source_verified: decision.sourceVerified,
        target_verified: decision.targetVerified,
        approval_required: false,
      });
      // Inter-account distribution amounts are base EUR (H10). A non-EUR or
      // cross-currency row's booked nominal is not that amount, so it is left
      // unconfirmed for reconcile_inter_account_transfers.
      if (
        mappedJournalId === undefined && (
          bookedCurrencyForWiseRow(row) !== "EUR" ||
          normalizeWiseCurrency(row.sourceCurrency) !== normalizeWiseCurrency(row.targetCurrency)
        )
      ) {
        ownershipReviews.push(reviewFor("wise_transfer_cross_currency", WISE_TRANSFER_CROSS_CURRENCY_REASON));
        continue;
      }

      const query = {
        sourceDim: accounts_dimensions_id,
        targetDim: targetDimensionId,
        amount: entry.amount,
        date: entry.date,
        maxGapDays: 1,
        reference: row.id,
      };
      const feeKey = `row:${row.rowIndex}:fee`;
      const cents = (value: number) => Math.round(value * 100);
      const baseCents = (posting: { amount: number; base_amount?: number }) => cents(posting.base_amount ?? posting.amount);
      const signedCents = (posting: { type?: string; amount: number; base_amount?: number }) =>
        (posting.type === "D" ? 1 : -1) * baseCents(posting);
      // Lane B binds each journal amount to its own bank leg. A journal booking
      // this transfer net of the row's separate fee row carries the Wise leg at
      // the net amount. It stands in for the row (and its fee) only when it
      // reproduces the statement on both bank accounts: the Wise leg moves the
      // net amount in the row's direction, the counterpart leg moves the booked
      // amount the opposite way, no other own bank account is touched, and the
      // one remaining posting is a fee expense DEBIT of exactly the fee. Base
      // EUR, the basis the guard matched on. Anything else is reviewed.
      // Eligibility is the transfer coverage's own: a registered, live journal
      // whose postings all carry a EUR amount. A bank posting is any posting on
      // a configured own bank dimension or on a bank account's GL account
      // (e.g. 1020 with any or no dimension), never mistaken for the fee.
      const netAmount = wiseLegAmountNetOfFee(row, entry.amount);
      const journalBooksNetOfFee = (journal: Journal | undefined): boolean => {
        if (journal === undefined || netAmount === undefined) return false;
        if (journal.registered !== true || journal.is_deleted || hasForeignPostingWithoutBase(journal)) return false;
        const postings = (journal.postings ?? []).filter(posting => !posting.is_deleted);
        const ownDimension = (posting: { accounts_id?: number | null; accounts_dimensions_id?: number | null }) =>
          ownBankDimensionIds.has(posting.accounts_dimensions_id ?? -1) || ownBankAccountIds.has(posting.accounts_id ?? -1);
        const nonBank = postings.filter(posting => !ownDimension(posting));
        const counterpartCents = postings
          .filter(posting => posting.accounts_dimensions_id === targetDimensionId)
          .reduce((sum, posting) => sum + signedCents(posting), 0);
        const direction = sourceDirectionForWiseDirection(row.direction) === "IN" ? 1 : -1;
        return wiseLegMoves(journal, row, netAmount) &&
          postings.every(posting => !ownDimension(posting) ||
            posting.accounts_dimensions_id === accounts_dimensions_id || posting.accounts_dimensions_id === targetDimensionId) &&
          counterpartCents === -direction * cents(entry.amount) &&
          nonBank.length === 1 && nonBank[0]!.type === "D" && baseCents(nonBank[0]!) === cents(bookedFeeAmountForWiseRow(row));
      };
      // Whether `journal` already books the fee this fee command would book.
      const journalBooksFee = (journal: Journal | undefined, feeCommand: WiseImportCommand | undefined): boolean =>
        feeCommand !== undefined &&
        feeCommand.booked_currency === bookedCurrencyForWiseRow(row) &&
        cents(feeCommand.booked_amount) === cents(bookedFeeAmountForWiseRow(row)) &&
        journalBooksNetOfFee(journal);
      // The legacy journal stands in for the row only when it books this
      // transfer exactly: gross on both bank legs and nothing else, or net of
      // the fee it also books.
      const journalBooksGross = (journal: Journal): boolean => {
        const direction = sourceDirectionForWiseDirection(row.direction) === "IN" ? 1 : -1;
        return (journal.postings ?? []).filter(posting => !posting.is_deleted).every(posting =>
            posting.accounts_dimensions_id === accounts_dimensions_id || posting.accounts_dimensions_id === targetDimensionId) &&
          dimensionNetEurCents(journal, accounts_dimensions_id) === direction * cents(entry.amount) &&
          dimensionNetEurCents(journal, targetDimensionId) === -direction * cents(entry.amount);
      };
      // wise_transfer_journal_unique_legacy: the row's ONLY same-key candidate
      // is accepted as already journalized, as an accepted mapping would be,
      // when it is registered and EUR-covered, books this transfer exactly in
      // this row's direction, names no other Wise transfer, no other mapping
      // names it, and no other statement row or stored Wise-account row has
      // its key (see statementKeys / storedWiseKeys).
      const uniqueLegacyJournalId = (candidateIds: number[]): number | undefined => {
        if (candidateIds.length !== 1) return undefined;
        const journalId = candidateIds[0]!;
        const journal = journalSnapshot.find(candidate => candidate.id === journalId);
        if (!journal || journal.registered !== true || journal.is_deleted || hasForeignPostingWithoutBase(journal)) return undefined;
        if (!(journalBooksGross(journal) || journalBooksNetOfFee(journal))) return undefined;
        if (labelledWithOtherWiseId(journal, row)) return undefined;
        if (statementKeys.some(key => key.row.rowIndex !== row.rowIndex &&
          laneBCandidateIds(targetDimensionId, key.amounts, key.date).includes(journalId))) return undefined;
        if (storedWiseKeys.some(key => laneBCandidateIds(targetDimensionId, key.amounts, key.date).includes(journalId))) return undefined;
        if (journalizedTransferIds.some(mapping => mapping.journal_id === journalId && mapping.wise_id !== row.id)) return undefined;
        if (journal.operation_type === "TRANSACTION" && existingTx.some(tx =>
          tx.id === journal.operations_id && tx.accounts_dimensions_id === accounts_dimensions_id)) return undefined;
        return journalId;
      };
      const dropFeeCommand = (feeCommand: WiseImportCommand) => {
        commands.splice(commands.indexOf(feeCommand), 1);
        const feeEntryIndex = created.findIndex(candidate => candidate.wise_id === feeCommand.wise_id);
        if (feeEntryIndex >= 0) created.splice(feeEntryIndex, 1);
      };
      // The row stays for review, but a candidate journal that already books
      // its fee keeps the fee out of the plan: confirming it would expense
      // the fee twice if that journal is this transfer.
      const pushJournalReview = (code: "wise_transfer_journal_ambiguous" | "wise_transfer_journal_inconsistent",
        reason: string, candidateIds: number[]) => {
        const feeCommand = commands.find(command => command.row_key === feeKey);
        const feeHeldIds = candidateIds.filter(id => journalBooksFee(journalSnapshot.find(journal => journal.id === id), feeCommand));
        if (feeCommand && feeHeldIds.length > 0) dropFeeCommand(feeCommand);
        const feeHeldNote = feeCommand && feeHeldIds.length > 0
          ? ` Its fee row is not imported while journal${feeHeldIds.length === 1 ? "" : "s"} ${feeHeldIds.join(", ")} may already book it; if ${feeHeldIds.length === 1 ? "that journal is" : "none of those journals is"} this transfer, book the fee by hand.`
          : "";
        ownershipReviews.push({
          ...reviewFor(code, reason + feeHeldNote),
          candidate_journal_ids: candidateIds,
          candidates: candidateIds.map(describeCandidate),
          ...(feeHeldIds.length > 0 ? { fee_held_journal_ids: feeHeldIds } : {}),
        });
      };

      let existingJournalId = mappedJournalId;
      let uniqueLegacy = false;
      if (existingJournalId === undefined) {
        let resolution = guard.resolveInterAccount(query);
        let otherLabelled = resolution.status === "none" && guard.hasOtherLabelledInterAccount(query);
        // Look the net-of-fee Wise leg up too.
        if (resolution.status === "none" && !otherLabelled && netAmount !== undefined) {
          const netQuery = { ...query, amount: netAmount };
          resolution = guard.resolveInterAccount(netQuery);
          otherLabelled = resolution.status === "none" && guard.hasOtherLabelledInterAccount(netQuery);
        } else if (resolution.status === "none" && netAmount !== undefined) {
          // A differently labelled gross journal does not hide the row's own
          // exact-reference journal net of the fee: identity wins (a reference
          // match is never consumed, so this probe has no side effect).
          const netIdentity = guard.resolveInterAccount({ ...query, amount: netAmount }, { consume: false });
          // The identity must also move the net amount in this row's direction.
          if (netIdentity.status === "matched" && netIdentity.matched_on === "reference" &&
            wiseLegMoves(journalSnapshot.find(journal => journal.id === netIdentity.journal_id), row, netAmount)) {
            resolution = netIdentity;
            otherLabelled = false;
          }
        }
        // Lane B keys are direction-blind: a matched journal (exact reference,
        // gross or net of the fee, or ref-less) stands in for the row only when
        // its Wise leg moves this row's gross amount, or the net amount while
        // also booking the fee, in the row's direction, in EUR. Otherwise the
        // row is created and reviewed.
        const matchedJournal = resolution.status === "matched"
          ? journalSnapshot.find(journal => journal.id === resolution.journal_id)
          : undefined;
        const matchUncovered = resolution.status === "matched" && (
          matchedJournal === undefined || hasForeignPostingWithoutBase(matchedJournal) ||
          !(wiseLegMoves(matchedJournal, row, entry.amount) || journalBooksNetOfFee(matchedJournal))
        );
        if (resolution.status === "ambiguous_refless" || otherLabelled || matchUncovered) {
          const candidateIds = laneBCandidateIds(targetDimensionId, netAmount === undefined ? [entry.amount] : [entry.amount, netAmount], entry.date);
          existingJournalId = uniqueLegacyJournalId(candidateIds);
          if (existingJournalId === undefined) {
            pushJournalReview("wise_transfer_journal_ambiguous", WISE_TRANSFER_JOURNAL_AMBIGUOUS_REASON, candidateIds);
            continue;
          }
          uniqueLegacy = true;
        } else {
          existingJournalId = resolution.status === "matched" ? resolution.journal_id : undefined;
        }
      }
      // Exact-reference identity is independent of the amount keys above: a
      // live journal labelled with this Wise ID that is not the journal
      // standing in for the row (e.g. it books another amount or direction)
      // means the transfer may already be booked, so the row is reviewed,
      // never confirmed or suppressed.
      const identityIds = journalSnapshot
        .filter(journal => journal.id !== undefined && !journal.is_deleted && journalLabelledWithWiseId(journal, row.id))
        .map(journal => journal.id!)
        .sort((left, right) => left - right);
      if (identityIds.some(id => id !== existingJournalId)) {
        pushJournalReview("wise_transfer_journal_inconsistent", WISE_TRANSFER_JOURNAL_INCONSISTENT_REASON, identityIds);
        continue;
      }
      const existingJournal = existingJournalId === undefined
        ? undefined
        : journalSnapshot.find(journal => journal.id === existingJournalId);

      let dependsOn = mainCommandKeysByRow.get(row.rowIndex) ?? null;
      if (existingJournalId !== undefined) {
        // The journal already books this transfer: creating the Wise row would
        // only leave a PROJECT duplicate of it. Drop the row (its fee, a
        // separate cash movement, still books) and report it as journalized.
        const mainIndex = commands.findIndex(command => command.row_key === dependsOn);
        if (mainIndex >= 0) commands.splice(mainIndex, 1);
        for (const command of commands) {
          if (command.depends_on === dependsOn) command.depends_on = null;
        }
        mainCommandKeysByRow.delete(row.rowIndex);
        created.splice(created.indexOf(entry), 1);
        skipped.push({
          wise_id: row.id,
          reason: uniqueLegacy
            ? `Already journalized (wise_transfer_journal_unique_legacy): inter-account journal ${existingJournalId} is the only same-amount journal within one day and books exactly this transfer; no Wise bank row created`
            : `Already journalized: inter-account journal ${existingJournalId} books this transfer; no Wise bank row created`,
          ...(uniqueLegacy ? { auto_match: { code: "wise_transfer_journal_unique_legacy" as const, journal_id: existingJournalId } } : {}),
        });
        dependsOn = null;
        // A journal that books the transfer net of the fee already books the
        // fee too: booking the fee row would expense it twice.
        const feeCommand = commands.find(command => command.row_key === feeKey);
        if (feeCommand && journalBooksFee(existingJournal, feeCommand)) {
          dropFeeCommand(feeCommand);
          skipped.push({
            wise_id: feeCommand.wise_id,
            reason: `Fee already journalized: inter-account journal ${existingJournalId} books this transfer net of the fee`,
            ...(uniqueLegacy ? { auto_match: { code: "wise_transfer_journal_unique_legacy" as const, journal_id: existingJournalId } } : {}),
          });
        }
      }

      const direction = sourceDirectionForWiseDirection(row.direction)!;
      const interAccountType = direction === "IN" ? "D" : "C";
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
        transaction_type: interAccountType,
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
        depends_on: dependsOn,
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
    }
  }

  // No approved own transfer at all: nothing a mapping could apply to.
  for (const [row, journalId] of pendingMappings) {
    rejectMapping(row, journalId, "the row is not an own transfer approved for inter-account booking");
  }
  ownershipReviews.push(...mappingReviews);

  // An untagged stored row of the same movement on this account, e.g. a card
  // payment entered by hand. A stored direction marker, when present, must
  // agree. Advisory (the row is still created) unless the stored row is
  // provably this movement (wise_untagged_ledger_unique below).
  const untaggedLookalikes = new Map<WiseCreatedEntry, Transaction[]>();
  for (const entry of created) {
    const currency = entry.source_row ? bookedCurrencyForWiseRow(entry.source_row) : entry.booked_currency;
    if (currency === undefined) continue;
    untaggedLookalikes.set(entry, existingTx.filter(tx =>
      isNonVoidTransaction(tx) &&
      tx.id !== undefined &&
      !tx.description?.startsWith("WISE:") &&
      tx.accounts_dimensions_id === accounts_dimensions_id &&
      tx.date === entry.date &&
      typeof tx.amount === "number" && Math.abs(tx.amount - entry.amount) < 0.005 &&
      (tx.cl_currencies_id ?? "EUR") === currency
    ));
  }
  // Movements a stored lookalike could be instead of this row: every row of
  // the parsed statement (any status, outside the date filter or already
  // imported) by its amount or fee, and every other stored row on the Wise
  // account, WISE:-tagged or not; same cents within one day, any currency
  // (the API reads every row back as EUR) and either direction.
  const wiseBankAccountsId = accountDimensions.find(dimension =>
    dimension.id === accounts_dimensions_id && dimension.is_deleted !== true)?.accounts_id;
  const lookalikeContested = (row: WiseRow, tx: Transaction): boolean => {
    const txCents = Math.round(tx.amount * 100);
    return allRows.some(other => other.rowIndex !== row.rowIndex &&
        withinOneDay(wiseDate(other.finishedOn || other.createdOn), tx.date) &&
        [bookedAmountForWiseRow(other), bookedFeeAmountForWiseRow(other)].some(amount => Math.round(amount * 100) === txCents)) ||
      existingTx.some(other => other !== tx && other.id !== tx.id && isNonVoidTransaction(other) &&
        other.accounts_dimensions_id === accounts_dimensions_id && typeof other.amount === "number" &&
        Math.round(other.amount * 100) === txCents && withinOneDay(other.date, tx.date));
  };
  // wise_untagged_ledger_unique: the row is not created when its ONLY stored
  // lookalike is CONFIRMED, names this Wise row (untaggedRowNamesWiseRow),
  // could be no other statement row or stored row (lookalikeContested), and
  // its direction and amount are ledger-proven: one registration journal
  // that moves exactly this amount on the Wise account in the row's
  // direction (base EUR, to the cent), with no signed marker contradicting it
  // (provenBankDirection — an unsigned or unverifiable marker proves
  // nothing). A plain card/payment row only: a transfer or a reviewed row
  // keeps its create.
  const untaggedRowCovers = (entry: WiseCreatedEntry, tx: Transaction): boolean => {
    const row = entry.source_row;
    if (!row || tx.status !== "CONFIRMED" || typeof tx.amount !== "number") return false;
    if (Math.round(tx.amount * 100) !== Math.round(entry.amount * 100) || (tx.cl_currencies_id ?? "EUR") !== "EUR") return false;
    if (!commands.some(command => command.row_key === `row:${row.rowIndex}:main` && command.action === "main_create")) return false;
    if (commands.some(command => command.row_index === row.rowIndex && command.action === "inter_account")) return false;
    if (ownershipReviews.some(review => review.wise_id === row.id || review.wise_id === entry.wise_id)) return false;
    if (!untaggedRowNamesWiseRow(row, tx) || lookalikeContested(row, tx)) return false;
    const direction = entry.source_direction === "IN" ? "incoming" : "outgoing";
    const journals = findRegistrationJournal(journalSnapshot, tx.id!);
    return journals.length === 1 &&
      journalBankDirection(tx, journals, wiseBankAccountsId) === direction &&
      provenBankDirection(tx, journals, wiseBankAccountsId) === direction &&
      dimensionNetEurCents(journals[0]!, accounts_dimensions_id) ===
        (direction === "incoming" ? 1 : -1) * Math.round(entry.amount * 100);
  };
  for (const [entry, lookalikes] of untaggedLookalikes) {
    const matches = lookalikes.filter(tx => [entry.source_direction, "?"].includes(markedWiseDirection(tx.description)));
    if (matches.length === 0) continue;
    if (lookalikes.length === 1 && untaggedRowCovers(entry, lookalikes[0]!)) {
      const mainKey = `row:${entry.source_row!.rowIndex}:main`;
      commands.splice(commands.findIndex(command => command.row_key === mainKey), 1);
      for (const command of commands) {
        if (command.depends_on === mainKey) command.depends_on = null;
      }
      mainCommandKeysByRow.delete(entry.source_row!.rowIndex);
      created.splice(created.indexOf(entry), 1);
      skipped.push({
        wise_id: entry.wise_id,
        reason: `Already imported (wise_untagged_ledger_unique): confirmed transaction ${lookalikes[0]!.id} without a WISE: tag is the only stored row of this movement on this Wise account; no Wise bank row created`,
        auto_match: { code: "wise_untagged_ledger_unique", transaction_id: lookalikes[0]!.id! },
      });
      continue;
    }
    ownershipReviews.push({
      wise_id: entry.wise_id,
      code: "wise_untagged_ledger_match",
      reason: WISE_UNTAGGED_LEDGER_MATCH_REASON,
      source_verified: false,
      target_verified: false,
      approval_required: false,
      ledger_transaction_ids: matches.map(tx => tx.id!),
    });
  }

  // --- Post-import: scan eligible payment rows for unpaid purchase invoices
  // that could be repriced to Wise's actual EUR conversion. ADVISORY ONLY: the
  // invoices are CONFIRMED, so the import never modifies them — it reports the
  // proposed correction for the operator to apply deliberately.
  const invoiceFixCandidates: WiseInvoiceFixCandidate[] = [];

  const paymentRows = eligible.filter(r => sourceDirectionForWiseDirection(r.direction) === "OUT" && bookedAmountForWiseRow(r) > 0);
  const unpaidInvoices: PurchaseInvoice[] = allPurchaseInvoices.filter(inv =>
    inv.id !== undefined &&
    inv.status === "CONFIRMED" &&
    // The live API reads an unpaid CONFIRMED invoice back as "" or null.
    (inv.payment_status == null || inv.payment_status === "" ||
      inv.payment_status === "PARTIALLY_PAID" || inv.payment_status === "UNPAID" || inv.payment_status === "OVERDUE")
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
    const isForeignCardPayment = sourceCurrency === "EUR" && targetCurrency !== "EUR" && targetAmount > 0 && sourceAmount > 0;

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
        // e-arveldaja currency_rate is FOREIGN units per 1 EUR (ECB
        // convention): the EUR-funded card payment's rate is target / source.
        const wiseRate = roundTo(targetAmount / sourceAmount, 6);
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
          invoice_number: wrapUntrustedOcr(inv.number) ?? inv.number,
          invoice_currency: invCurrency,
          invoice_gross: invGross,
          current_base_gross: currentBaseGross,
          current_currency_rate: currentRate,
          category: "foreign_currency_lock",
          proposed_action: `Advisory, not applied: lock invoice ${wrapUntrustedOcr(inv.number) ?? ""} to Wise rate: base_gross_price ${(currentBaseGross ?? 0).toFixed(2)} → ${proposedBaseGross.toFixed(2)} EUR, currency_rate → ${wiseRate}.`,
          proposed_correction: { currency_rate: wiseRate, base_gross_price: proposedBaseGross },
          current_object_state: inv,
        });
      } else {
        // sourceAmount is only a EUR figure when the row was FUNDED in EUR — the
        // sibling foreign_currency_lock branch establishes that via
        // isForeignCardPayment, this one asserted it. Without the guard a
        // USD-funded row is compared against a EUR invoice gross as if the two
        // were the same unit; whenever the pair rate sits within ~0.1% of 1.0
        // the difference slips under the 10-cent window and the candidate
        // proposes overwriting a confirmed invoice's gross_price with a
        // foreign-currency number relabelled EUR (source_amount_eur, rate 1).
        const eurDiff = roundMoney(invGross - sourceAmount);
        if (sourceCurrency === "EUR" && invCurrency === "EUR" && eurDiff !== 0 && Math.abs(eurDiff) < 0.10) {
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
            invoice_number: wrapUntrustedOcr(inv.number) ?? inv.number,
            invoice_currency: invCurrency,
            invoice_gross: invGross,
            current_base_gross: inv.base_gross_price ?? undefined,
            current_currency_rate: inv.currency_rate ?? undefined,
            category: "eur_legacy_autofix",
            proposed_action: `Advisory, not applied: legacy EUR booking ${wrapUntrustedOcr(inv.number) ?? ""}: gross_price ${invGross.toFixed(2)} → ${sourceAmount.toFixed(2)} EUR (Wise actual settlement, diff ${eurDiff.toFixed(2)}).`,
            proposed_correction: { gross_price: roundMoney(sourceAmount) },
            current_object_state: inv,
          });
        }
      }
    }
  }

  // Ambiguity guard: when one Wise row matches multiple unpaid invoices for the
  // same supplier+amount+date window, do not pick — flag both as
  // ambiguous_skipped and let the operator resolve manually. The
  // supplier-name OCR wrap for the ambiguous prose lives in the presenter.
  const candidatesByWiseId = new Map<string, number>();
  for (const fix of invoiceFixCandidates) {
    candidatesByWiseId.set(fix.wise_id, (candidatesByWiseId.get(fix.wise_id) ?? 0) + 1);
  }
  for (const fix of invoiceFixCandidates) {
    if ((candidatesByWiseId.get(fix.wise_id) ?? 0) > 1) {
      fix.result = "ambiguous_skipped";
    }
  }

  for (const fix of invoiceFixCandidates) {
    if (fix.result !== "ambiguous_skipped") fix.result = "advisory";
  }

  return {
    commands,
    created,
    skipped,
    mainCommandKeysByRow,
    ownershipReviews,
    invoiceFixCandidates,
    feeResolutionRequired,
  };
}
