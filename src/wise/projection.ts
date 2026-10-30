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
  isWiseTransferCandidate,
  normalizeWiseCompanyName,
  normalizeWiseCurrency,
  oppositeSideForWiseRow,
  sourceDirectionForWiseDirection,
  transactionTypeForWiseDirection,
  wiseLegAmountNetOfFee,
  wiseRowAmounts,
  wiseRowDate,
  withWiseSourceDirection,
} from "./preflight.js";
import {
  WISE_COMMAND_VERSION,
  type FeeCreateCommand,
  type InterAccountCommand,
  type MainCreateCommand,
  type TransactionCreatePayload,
  type WiseCommandBase,
  type WiseAlreadyJournalizedAssertion,
  type WiseCreatedEntry,
  type WiseImportCommand,
  type WiseInvoiceFixCandidate,
  type WiseAcknowledgedJournalHold,
  type WiseCounterpartOverride,
  type WiseJournalizedTransferMapping,
  type WiseRow,
  type WiseSkippedEntry,
  type WiseTransferDecision,
  type WiseTransferJournalCandidate,
  type WiseTransferReview,
  type WiseTransferTreatedAsPayment,
  type WiseClientResolution,
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

/** The review projection of a command's create payload: free text sandbox-wrapped (null stays null). */
export type WiseProjectedCreatePayload = Pick<
  TransactionCreatePayload,
  "accounts_dimensions_id" | "type" | "amount" | "cl_currencies_id" | "date" | "clients_id"
> & {
  bank_account_name?: string | null;
  ref_number?: string | null;
  description?: string | null;
};

/**
 * A compiled command as the dry run / execute envelope lists it (execution.commands).
 * The action-specific fields are optional: `action` is not narrowed in the projection,
 * so the type is flat rather than discriminated. main_create carries create_payload;
 * fee_create_and_confirm adds the posting/client fields and confirmation_distribution;
 * inter_account carries the counterpart/flow/ownership fields and no create_payload.
 */
export type WiseProjectedCommand = Pick<
  WiseCommandBase,
  | "date" | "row_key" | "identity_hash" | "wise_id" | "transaction_type" | "source_direction" | "booked_amount" | "booked_currency"
  | "source_amount" | "source_currency" | "target_amount" | "target_currency" | "exchange_rate" | "exchange_rate_orientation"
  | "wise_dimension_id" | "depends_on"
> & {
  action: WiseImportCommand["action"];
  create_payload?: WiseProjectedCreatePayload;
  posting_account_id?: number;
  posting_dimension_id?: number;
  wise_client_id?: number;
  confirmation_distribution?: FeeCreateCommand["confirmation_distribution"] | InterAccountCommand["confirmation_distribution"];
} & Partial<Pick<
  InterAccountCommand,
  "counterpart_dimension_id" | "flow_source_dimension_id" | "flow_target_dimension_id" | "ownership_basis" | "client_update"
>>;

function projectTransactionCreatePayload(command: MainCreateCommand | FeeCreateCommand): WiseProjectedCreatePayload {
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

export function projectWiseCommand(command: WiseImportCommand): WiseProjectedCommand {
  const common = {
    action: command.action,
    date: command.date,
    row_key: command.row_key,
    identity_hash: command.identity_hash,
    // Validated at preflight (WISE_ID_REGEX) plus server-built FEE:/leg
    // affixes: an identifier, emitted raw like every other Wise id.
    wise_id: command.wise_id,
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
 * review surface. The Wise ID is a preflight-validated identifier (emitted
 * raw); every other field is server-derived or numeric. Executable payloads never enter here. */
export function wisePlanReviewProjection(command: WiseImportCommand): PlanData {
  return stripUndefinedDeep({
    action: command.action,
    date: command.date,
    booked_amount: command.booked_amount,
    booked_currency: command.booked_currency,
    source_direction: command.source_direction,
    // Validated at preflight (WISE_ID_REGEX) plus server-built FEE:/leg
    // affixes: an identifier, emitted raw like every other Wise id.
    wise_id: command.wise_id,
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
  /** Owner acknowledgements (acknowledged_journal_holds): Wise ID → journals
   * that do not book it. Never an assertion; releases a held row only when it
   * covers the row's full evidence. */
  readonly acknowledgedJournalHolds?: readonly WiseAcknowledgedJournalHold[];
  /** Owner choices (counterpart_overrides), already applied to the transfer
   * decisions; listed here only to report the unused ones. */
  readonly counterpartOverrides?: readonly WiseCounterpartOverride[];
  readonly ownCompanyClientId: number | undefined;
  readonly allPurchaseInvoices: PurchaseInvoice[];
  /** Counterparty-name client lookups for rows that are not own transfers
   * (wiseRowNeedsClientResolution); a resolved clients_id joins the row's
   * main create payload. */
  readonly clientResolutions?: ReadonlyMap<WiseRow, WiseClientResolution>;
}

/** A row booked as an ordinary payment needs a client to be confirmable:
 * every row except an own-transfer candidate (whose client is the own company,
 * set by its inter_account command) and a row held for its counterpart. */
export function wiseRowNeedsClientResolution(decision: WiseTransferDecision | undefined): boolean {
  return decision === undefined || decision.externalPayment !== undefined;
}

export interface WiseProjectionOutput {
  commands: WiseImportCommand[];
  created: WiseCreatedEntry[];
  skipped: WiseSkippedEntry[];
  mainCommandKeysByRow: Map<number, string>;
  ownershipReviews: WiseTransferReview[];
  invoiceFixCandidates: WiseInvoiceFixCandidate[];
  /** Approved own transfers an existing journal already books: no command, no
   * write. Bound into the plan digest and re-checked once after the writes. */
  alreadyJournalized: WiseAlreadyJournalizedAssertion[];
  /** True when a fee row still needs booking but the fee dimension / Wise
   * client were not supplied: resolve them and project again. */
  feeResolutionRequired: boolean;
  /** Transfer rows that keep commands after the hold pass, with each pending
   * Wise leg and its proven coverage: execute re-checks exactly these. */
  holdCheckRows: WiseHoldCheckRow[];
  /** Rows released by acknowledged_journal_holds, with the journals the
   * acknowledgement exempts (info only, not a review). */
  acknowledgedHolds: WiseAcknowledgedJournalHold[];
  /** Transfer rows imported as ordinary payments (externalPayment) that
   * still create their row after the hold pass (info only, not a review). */
  transfersTreatedAsPayments: WiseTransferTreatedAsPayment[];
}

export interface WiseHoldCheckLeg {
  readonly leg: WiseLeg;
  readonly coverage: number[];
}

export interface WiseHoldCheckRow {
  readonly row_index: number;
  readonly wise_id: string;
  readonly legs: { readonly main?: WiseHoldCheckLeg; readonly fee?: WiseHoldCheckLeg };
  readonly acknowledged_ids?: number[];
}

// Transactions.bank_account_name maxLength in the e-arveldaja API.
const WISE_BANK_ACCOUNT_NAME_MAX_LENGTH = 100;

// Inter-account route for Wise review rows: merged tool (registered on every
// profile) first, granular tool as the standard/full alternative.
const WISE_INTER_ACCOUNT_ROUTE =
  "preview it with reconcile_bank_transactions mode 'inter_account_dry_run' (reconcile_inter_account_transfers on the standard/full profile) and run mode 'execute_inter_account' with that preview's plan_handle only for the actions the user approved; a row the preview leaves out (e.g. a foreign-currency leg without EUR base evidence) still needs its counterpart or rate resolved, or manual booking";
const WISE_TRANSFER_CROSS_CURRENCY_REASON =
  `Wise transfer is not a same-currency EUR movement, so its booked amount is not the base EUR the counterpart bank account records. The row is imported unconfirmed; ${WISE_INTER_ACCOUNT_ROUTE}.`;
const WISE_JOURNAL_HOLD_RELEASE =
  "Use acknowledged_journal_holds [{ wise_id, journal_ids: <required_acknowledgement_ids> }] only when the owner confirms every one of those journals is a different movement: the row is then created and confirmed as a new transaction.";
const WISE_TRANSFER_JOURNAL_AMBIGUOUS_REASON =
  `A same-amount journal on the Wise account within one day of this Wise transfer cannot be told apart from this transfer (ambiguous or differently labelled). The row and its fee are not imported. First check whether a candidate journal IS this transfer (likely when date and amount agree): then re-run with journalized_transfer_ids [{ wise_id, journal_id }] to record it as already journalized (validated; the journal needs a document number). ${WISE_JOURNAL_HOLD_RELEASE}`;
const WISE_TRANSFER_JOURNAL_INCONSISTENT_REASON =
  "A journal labelled with this Wise transfer's ID already exists, but it is not the journal that books this row's amount (gross, or net of a fee the journal also books) in this row's direction. The transfer may already be booked, so the row and its fee are not imported. Correct or remove the labelled journal, then re-run the preview.";
const WISE_LEGACY_LEG_AMBIGUOUS_REASON =
  "A bank row stored by an older release under this plain Wise ID (before split-leg tags and the currency fix) could be any of several legs of this ID, so which leg is still missing cannot be told. This leg and its fee are not imported; compare the stored row with the Wise statement and book the missing leg manually.";
const WISE_TRANSFER_MAPPING_REJECTED_REASON =
  "The journalized_transfer_ids mapping for this Wise transfer was not accepted, so the row resolves as if unmapped: it may still be skipped as already journalized, imported, or held for review (not imported); see this row's own result. Check the mapping. Rejected because";
const WISE_TRANSFER_MAPPING_UNUSED_REASON =
  "This journalized_transfer_ids mapping was not used:";
const WISE_UNTAGGED_LEDGER_MATCH_REASON =
  "A bank row without a WISE: identity tag, already stored on this Wise account, has the same date, amount and currency. It may be this movement entered by hand. Advisory only: the row is still imported; if it duplicates the stored row, remove one of them.";
const WISE_UNTAGGED_LEDGER_MATCH_TRANSFER_REASON =
  "A bank row without a WISE: identity tag, already stored on this Wise account, has the same date, amount and currency as this transfer. It may be this transfer entered by hand, so the row and its fee are not imported. If the stored row is this transfer, nothing is left to do; otherwise book the transfer with the owner.";
const WISE_TRANSFER_JOURNAL_EXISTING_ELSEWHERE_REASON =
  `A registered journal already moves this amount on the Wise account within one day of this transfer (or may, for a journal of several Wise postings). The row and its fee are not imported. First check whether one of those journals IS this transfer: then it is already booked and nothing is needed (an inter-account journal can be recorded with journalized_transfer_ids). ${WISE_JOURNAL_HOLD_RELEASE}`;
const WISE_EXACT_LABEL_POSSIBLE_DOUBLE_BOOKING_REASON = (journalId: number, releasable: boolean): string =>
  `Journal ${journalId} (journal_id) is labelled with this Wise ID and books this movement on the Wise account, but another booking of the same amount in the same direction within one day is also on the Wise account (candidate_journal_ids, ledger_transaction_ids), so the movement may be booked twice. The row and its fee are not imported. Check them with the owner: if one also books this movement, remove the duplicate booking (after approval) and re-run the preview. ${releasable
    ? `Only if the owner confirms every journal in required_acknowledgement_ids is a different movement, re-run with acknowledged_journal_holds [{ wise_id, journal_ids: <required_acknowledgement_ids> }]: the row is then recorded as already journalized by journal ${journalId} (nothing is created).`
    : "A stored bank row in ledger_transaction_ids has no registration journal among them, so this hold cannot be acknowledged: delete or correct that row with the owner, then re-run the preview."}`;
const WISE_TRANSFER_ALREADY_IMPORTED_REASON =
  `This Wise transfer was already imported by an earlier run, so confirm_own_transfer_ids does not act on it. If the existing bank transaction is already CONFIRMED, nothing is left to do; if it is still unconfirmed (PROJECT), ${WISE_INTER_ACCOUNT_ROUTE}.`;

/** The distinct ids of `lists`, ascending. */
export function sortedUniqueIds(...lists: readonly Iterable<number>[]): number[] {
  return [...new Set(lists.flatMap(list => [...list]))].sort((left, right) => left - right);
}

const cents = (value: number): number => Math.round(value * 100);

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
 * amount (foreign currency without a base amount, or a missing / non-finite
 * amount) or has no side.
 */
export function dimensionNetEurCents(journal: Journal, dimensionId: number): number | undefined {
  let net = 0;
  for (const posting of journal.postings ?? []) {
    if (posting.is_deleted || posting.accounts_dimensions_id !== dimensionId) continue;
    const currency = (posting.cl_currencies_id ?? journal.cl_currencies_id ?? "EUR").toUpperCase();
    if ((posting.base_amount == null && currency !== "EUR") || (posting.type !== "D" && posting.type !== "C")) return undefined;
    const eur = posting.base_amount ?? posting.amount;
    if (!Number.isFinite(eur)) return undefined;
    net += (posting.type === "D" ? 1 : -1) * Math.round(eur * 100);
  }
  return net;
}

/** Whether two ISO dates are at most one day apart; an unreadable date is near
 * anything (fails closed for a uniqueness check). */
export function withinOneDay(left: string | undefined, right: string | undefined): boolean {
  const day = (value: string | undefined) => /^\d{4}-\d{2}-\d{2}/.test(value ?? "") ? toUtcDay(value!) : NaN;
  const gap = Math.abs(day(left) - day(right));
  return !Number.isFinite(gap) || gap <= 86400000;
}

/** Whether a stored description tag is `prefix` (e.g. `WISE:{id}`) itself or
 * `prefix` with a generated split-leg suffix (`:CUR` or `:CUR-n`); a suffixed
 * tag also gives its currency. Any other continuation is a distinct ID. */
export function matchWiseLegTag(tag: string, prefix: string): { suffixCurrency: string | undefined } | undefined {
  if (tag === prefix) return { suffixCurrency: undefined };
  const match = tag.startsWith(`${prefix}:`) ? tag.slice(prefix.length + 1).match(/^([A-Z]{3})(?:-\d+)?$/) : null;
  return match ? { suffixCurrency: match[1] } : undefined;
}

/** Wise IDs and references a journal label could name: the statement's rows
 * and the WISE: tags already stored. */
export function knownWiseLabelsFor(allRows: readonly WiseRow[], existingTx: readonly Transaction[]): string[] {
  return [...new Set([
    ...allRows.flatMap(row => [row.id, row.reference]),
    ...existingTx.flatMap(tx => tx.description?.startsWith("WISE:")
      ? [tx.description.split(" ")[0]!.replace(/^WISE:(?:FEE:)?/, "")]
      : []),
  ].filter(label => normalizeReference(label) !== ""))];
}

/** Whether `journal` is labelled with a Wise ID other than this row's. */
export function labelledWithOtherWiseId(journal: Journal, row: WiseRow, knownWiseLabels: readonly string[]): boolean {
  const label = normalizeReference(journal.document_number);
  if (label === "" || journalLabelledWithWiseId(journal, row.id) || label === normalizeReference(row.reference)) return false;
  return /^WISE:/i.test(label) || WISE_ID_SHAPED_LABEL.test(label) ||
    knownWiseLabels.some(other => other !== row.id && other !== row.reference && journalLabelledWithWiseId(journal, other));
}

/** One live posting on the Wise account dimension. */
interface WiseSidePosting {
  /** D +1, C −1; 0 when the posting carries no side or no readable amount. */
  readonly sign: 1 | -1 | 0;
  readonly currency: string;
  readonly nominalCents: number;
  /** Base EUR cents; undefined for a foreign posting without a base amount. */
  readonly eurCents: number | undefined;
}

interface WiseSideJournal {
  readonly journal: Journal;
  readonly postings: readonly WiseSidePosting[];
}

/** Registered, live journals with at least one live posting on the Wise
 * dimension, bucketed by effective date. One index per journal snapshot. */
export interface WiseSideJournalIndex {
  readonly byDay: ReadonlyMap<string, readonly WiseSideJournal[]>;
  /** Journals whose date cannot be read: near every leg. */
  readonly undated: readonly WiseSideJournal[];
  readonly all: readonly WiseSideJournal[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

export function buildWiseSideJournalIndex(journals: readonly Journal[], wiseDim: number): WiseSideJournalIndex {
  const byDay = new Map<string, WiseSideJournal[]>();
  const undated: WiseSideJournal[] = [];
  const all: WiseSideJournal[] = [];
  for (const journal of journals) {
    if (journal.registered !== true || journal.is_deleted === true || journal.id === undefined) continue;
    const postings = (journal.postings ?? []).flatMap((posting): WiseSidePosting[] => {
      if (posting.is_deleted || posting.accounts_dimensions_id !== wiseDim) return [];
      const currency = (posting.cl_currencies_id ?? journal.cl_currencies_id ?? "EUR").toUpperCase();
      // A missing or non-finite amount cannot be compared: no side, so the
      // journal is uncertain evidence.
      const readable = Number.isFinite(posting.amount) && (posting.base_amount == null || Number.isFinite(posting.base_amount));
      if (!readable) return [{ sign: 0, currency, nominalCents: 0, eurCents: undefined }];
      return [{
        sign: posting.type === "D" ? 1 : posting.type === "C" ? -1 : 0,
        currency,
        nominalCents: Math.round(posting.amount * 100),
        eurCents: posting.base_amount != null ? Math.round(posting.base_amount * 100)
          : currency === "EUR" ? Math.round(posting.amount * 100) : undefined,
      }];
    });
    if (postings.length === 0) continue;
    const entry = { journal, postings };
    all.push(entry);
    if (ISO_DAY.test(journal.effective_date ?? "")) {
      const day = journal.effective_date.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    } else {
      undated.push(entry);
    }
  }
  return { byDay, undated, all };
}

/** A pending Wise bank leg of a statement row: its main movement (gross, and
 * net of a same-currency fee) or its fee (always outgoing). */
export interface WiseLeg {
  readonly date: string;
  readonly direction: "IN" | "OUT";
  readonly currency: string;
  readonly amounts: readonly number[];
}

function wiseMainLeg(row: WiseRow): WiseLeg | undefined {
  const direction = sourceDirectionForWiseDirection(row.direction);
  if (!direction) return undefined;
  return {
    date: wiseRowDate(row),
    direction,
    currency: bookedCurrencyForWiseRow(row),
    amounts: wiseRowAmounts(row),
  };
}

function wiseFeeLeg(row: WiseRow): WiseLeg | undefined {
  const fee = bookedFeeAmountForWiseRow(row);
  if (!(fee > 0)) return undefined;
  return {
    date: wiseRowDate(row),
    direction: "OUT",
    currency: bookedFeeCurrencyForWiseRow(row, bookedCurrencyForWiseRow(row)),
    amounts: [fee],
  };
}

/**
 * Journals on the Wise account that may book `leg` (±1 day; journals `skip`
 * names, e.g. labelled with another Wise ID, are left out).
 * Certain: the journal's Wise postings in total, or any single one, move one
 * of the leg's amounts in its direction (base EUR for an EUR leg, else the
 * nominal in the leg's currency). Uncertain: a composite journal (≥2 Wise
 * postings, one in the leg's direction) whose same-direction postings cannot
 * be shown to stay below the leg, or a lone same-direction posting with no
 * shared currency. Opposite-direction-only or different amounts: no evidence.
 */
export function wiseLegEvidence(
  index: WiseSideJournalIndex,
  leg: WiseLeg,
  skip: (journal: Journal) => boolean,
): { certain: number[]; uncertain: number[] } {
  const dir = leg.direction === "IN" ? 1 : -1;
  const legCents = leg.amounts.map(amount => Math.round(amount * 100));
  const comparable = (posting: WiseSidePosting): number | undefined =>
    leg.currency === "EUR" ? posting.eurCents : posting.currency === leg.currency ? posting.nominalCents : undefined;
  let nearby: readonly WiseSideJournal[];
  if (ISO_DAY.test(leg.date)) {
    const day = toUtcDay(leg.date);
    nearby = [
      ...[-1, 0, 1].flatMap(offset => index.byDay.get(new Date(day + offset * 86400000).toISOString().slice(0, 10)) ?? []),
      ...index.undated,
    ];
  } else {
    nearby = index.all;
  }
  const certain = new Set<number>();
  const uncertain = new Set<number>();
  for (const { journal, postings } of nearby) {
    if (skip(journal)) continue;
    // A Wise posting without a side cannot be ruled out either way.
    if (postings.some(posting => posting.sign === 0)) {
      uncertain.add(journal.id!);
      continue;
    }
    const values = postings.map(comparable);
    const total = values.every(value => value !== undefined)
      ? postings.reduce((sum, posting, i) => sum + posting.sign * values[i]!, 0)
      : undefined;
    const single = postings.some((posting, i) => posting.sign === dir && values[i] !== undefined && legCents.includes(values[i]!));
    if (single || (total !== undefined && legCents.includes(dir * total))) {
      certain.add(journal.id!);
      continue;
    }
    const sameDirection = postings.filter(posting => posting.sign === dir);
    if (sameDirection.length === 0) continue;
    if (postings.length >= 2) {
      const sameValues = sameDirection.map(comparable);
      const shownBelow = sameValues.every(value => value !== undefined) &&
        sameValues.reduce<number>((sum, value) => sum + value!, 0) < Math.min(...legCents);
      if (!shownBelow) uncertain.add(journal.id!);
    } else if (comparable(sameDirection[0]!) === undefined) {
      uncertain.add(journal.id!);
    }
  }
  return { certain: sortedUniqueIds(certain), uncertain: sortedUniqueIds(uncertain) };
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
    acknowledgedJournalHolds = [],
    counterpartOverrides = [],
    ownCompanyClientId,
    allPurchaseInvoices,
    clientResolutions,
  } = input;
  const accounts_dimensions_id = accountsDimensionsId;
  const knownWiseLabels = knownWiseLabelsFor(allRows, existingTx);
  const acknowledgedIds = new Map(acknowledgedJournalHolds.map(hold => [hold.wise_id, new Set(hold.journal_ids)]));
  // Ambiguous rows whose acknowledgement covers every candidate: they go on
  // through the ordinary flow, and the hold pass releases them only when the
  // acknowledgement covers the row's full evidence (else this review holds).
  const pendingReleaseReviews = new Map<WiseRow, WiseTransferReview>();
  // The statement row each row-specific review belongs to. Split legs of one
  // Wise ID share row.id, so the review's wise_id cannot tell them apart.
  const reviewRows = new Map<WiseTransferReview, number>();
  const forRow = (row: WiseRow, review: WiseTransferReview): WiseTransferReview => {
    reviewRows.set(review, row.rowIndex);
    return review;
  };

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
    const match = matchWiseLegTag(tag, prefix);
    return match ? [{ tx, tag, ...match }] : [];
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
  const legIdOf = (row: WiseRow): string => legSuffix.has(row) ? `${row.id}:${legSuffix.get(row)}` : row.id;
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
  ): Map<WiseRow, Transaction> => {
    const claimed = new Map<WiseRow, Transaction>();
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
            claimed.set(candidates[0]!, entry.tx);
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
  const alreadyJournalized: WiseAlreadyJournalizedAssertion[] = [];
  const mainCommandKeysByRow = new Map<number, string>();
  const alreadyImportedApprovalReviews: WiseTransferReview[] = [];
  const legacyLegReviews: WiseTransferReview[] = [];
  let feeResolutionRequired = false;

  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i]!;
    const date = wiseRowDate(row);
    const type = transactionTypeForWiseDirection(row.direction);
    const sourceDirection = sourceDirectionForWiseDirection(row.direction);
    if (!type || !sourceDirection) {
      skipped.push({ wise_id: row.id, reason: `Unsupported Wise direction "${row.direction}"`, kind: "unsupported_direction" });
      continue;
    }
    const amount = bookedAmountForWiseRow(row);
    const fee = bookedFeeAmountForWiseRow(row);
    const transactionCurrency = bookedCurrencyForWiseRow(row);
    const legId = legIdOf(row);
    const wiseIdTag = `WISE:${legId}`;
    if (ambiguousLegacyIds.has(row.id) && (!claimedMainLegs.has(row) || (fee > 0 && !claimedFeeLegs.has(row)))) {
      legacyLegReviews.push(forRow(row, {
        wise_id: legId,
        code: "wise_legacy_leg_ambiguous",
        reason: WISE_LEGACY_LEG_AMBIGUOUS_REASON,
        source_verified: false,
        target_verified: false,
        approval_required: false,
      }));
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
        kind: "error",
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
    // Only a WISE: identity proves the row is stored: an untagged lookalike
    // gets the wise_untagged_ledger_match advisory below, never a silent skip.
    const mainAlreadyImported = seenWiseIds.has(wiseIdTag) || claimedMainLegs.has(row);

    if (mainAlreadyImported) {
      skipped.push({
        wise_id: legId,
        reason: "Already imported (Wise ID match)",
        kind: "already_imported",
      });
      if (approvedTransferIds.has(row.id)) {
        const decision = transferDecisions.get(row);
        alreadyImportedApprovalReviews.push(forRow(row, {
          wise_id: row.id,
          code: "wise_transfer_already_imported",
          reason: WISE_TRANSFER_ALREADY_IMPORTED_REASON,
          source_verified: decision?.sourceVerified ?? false,
          target_verified: decision?.targetVerified ?? false,
          approval_required: false,
        }));
      }
    } else {
      const clientResolution = clientResolutions?.get(row);
      const createPayload: TransactionCreatePayload = {
        accounts_dimensions_id,
        type,
        amount,
        cl_currencies_id: transactionCurrency,
        date,
        description: desc,
        bank_account_name: bankAccountName,
        ref_number: row.reference || undefined,
        ...(clientResolution?.clients_id !== undefined ? { clients_id: clientResolution.clients_id } : {}),
      };
      commands.push({
        version: WISE_COMMAND_VERSION,
        action: "main_create",
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
      const counterpartDecision = transferDecisions.get(row);
      created.push({
        wise_id: legId,
        date,
        type,
        source_direction: sourceDirection,
        amount,
        description: desc,
        status: "would_create",
        source_row: row,
        ...(counterpartDecision?.counterpartBasis !== undefined && counterpartDecision.targetDimensionId !== undefined
          ? { counterpart_dimension_id: counterpartDecision.targetDimensionId, counterpart_basis: counterpartDecision.counterpartBasis }
          : {}),
        ...(clientResolution?.clients_id !== undefined
          ? {
              clients_id: clientResolution.clients_id,
              ...(clientResolution.match_type !== undefined ? { client_match: clientResolution.match_type } : {}),
              ...(clientResolution.matched_client_name !== undefined ? { matched_client_name: clientResolution.matched_client_name } : {}),
            }
          : clientResolution?.ambiguous === true ? { client_ambiguous: true as const } : {}),
      });
      // Deliberately NOT feeding this row's signature back into the stored-row
      // set: within one statement the Wise ID is the identity, and seenWiseIds
      // already carries it. Two rows with distinct Wise IDs are two distinct
      // payments however alike they look — two identical card payments to the
      // same merchant on one day, or a payment and its same-day refund. Folding
      // planned rows into the duplicate set silently dropped the second one and
      // under-booked the account.
      seenWiseIds.add(wiseIdTag);
    }

    if (fee > 0) {
      const feeWiseIdTag = `WISE:FEE:${legId}`;
      const feeDesc = withWiseSourceDirection(`${feeWiseIdTag} Wise teenustasu`, "OUT");
      const feeCurrency = bookedFeeCurrencyForWiseRow(row, transactionCurrency);
      const feeTagImported = seenWiseIds.has(feeWiseIdTag) || claimedFeeLegs.has(row);
      if (feeTagImported) {
        skipped.push({
          wise_id: `FEE:${legId}`,
          reason: "Fee already imported (Wise ID match)",
          kind: "already_imported",
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
    return review ? [forRow(entry.source_row, review)] : [];
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

  const hasForeignPostingWithoutBase = (journal: Journal): boolean =>
    (journal.postings ?? []).some(posting => !posting.is_deleted && posting.base_amount == null &&
      (posting.cl_currencies_id ?? journal.cl_currencies_id ?? "EUR").toUpperCase() !== "EUR");
  // Whether the journal's Wise-dimension postings net to `amount` in the
  // row's direction (IN debits the Wise account), in base EUR.
  const wiseLegMoves = (journal: Journal | undefined, row: WiseRow, amount: number): boolean => {
    const signedWiseCents = (journal?.postings ?? [])
      .filter(posting => !posting.is_deleted && posting.accounts_dimensions_id === accounts_dimensions_id)
      .reduce((sum, posting) => sum + (posting.type === "D" ? 1 : -1) * cents(posting.base_amount ?? posting.amount), 0);
    return journal !== undefined &&
      signedWiseCents === (sourceDirectionForWiseDirection(row.direction) === "IN" ? 1 : -1) * cents(amount);
  };
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
      return sortedUniqueIds(ids);
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
      const candidateIds = laneBCandidateIds(targetDimensionId, [amount], wiseRowDate(row));
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
      const identityIds = laneBCandidateIds(targetDimensionId, wiseRowAmounts(row), wiseRowDate(row));
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
    const statementKeys = allRows.map(row => ({ row, amounts: wiseRowAmounts(row), date: wiseRowDate(row) }));
    const storedWiseKeys = existingTx.flatMap(tx => {
      if (!isNonVoidTransaction(tx) || tx.accounts_dimensions_id !== accounts_dimensions_id || typeof tx.amount !== "number") return [];
      const tag = tx.description?.startsWith("WISE:") && !tx.description.startsWith("WISE:FEE:") ? tx.description.split(" ")[0]! : undefined;
      const fees = tag === undefined ? [] : existingTx.filter(fee => isNonVoidTransaction(fee) &&
        fee.accounts_dimensions_id === accounts_dimensions_id && typeof fee.amount === "number" &&
        fee.description?.split(" ")[0] === tag.replace(/^WISE:/, "WISE:FEE:")).map(fee => fee.amount);
      return [{ amounts: [tx.amount, ...fees.flatMap(fee => [tx.amount - fee, tx.amount + fee])], date: tx.date ?? "" }];
    });
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
        ownershipReviews.push(forRow(row, reviewFor("wise_transfer_cross_currency", WISE_TRANSFER_CROSS_CURRENCY_REASON)));
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
        if (labelledWithOtherWiseId(journal, row, knownWiseLabels)) return undefined;
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
        reason: string, candidateIds: number[]): boolean => {
        const acknowledged = acknowledgedIds.get(row.id);
        if (code === "wise_transfer_journal_ambiguous" && acknowledged !== undefined && candidateIds.every(id => acknowledged.has(id))) {
          pendingReleaseReviews.set(row, forRow(row, {
            ...reviewFor(code, reason),
            candidate_journal_ids: candidateIds,
            candidates: candidateIds.map(describeCandidate),
          }));
          return true;
        }
        const feeCommand = commands.find(command => command.row_key === feeKey);
        const feeHeldIds = candidateIds.filter(id => journalBooksFee(journalSnapshot.find(journal => journal.id === id), feeCommand));
        if (feeCommand && feeHeldIds.length > 0) dropFeeCommand(feeCommand);
        const feeHeldNote = feeCommand && feeHeldIds.length > 0
          ? ` Its fee row is not imported while journal${feeHeldIds.length === 1 ? "" : "s"} ${feeHeldIds.join(", ")} may already book it; if ${feeHeldIds.length === 1 ? "that journal is" : "none of those journals is"} this transfer, book the fee by hand.`
          : "";
        ownershipReviews.push(forRow(row, {
          ...reviewFor(code, reason + feeHeldNote),
          candidate_journal_ids: candidateIds,
          candidates: candidateIds.map(describeCandidate),
          ...(feeHeldIds.length > 0 ? { fee_held_journal_ids: feeHeldIds } : {}),
        }));
        return false;
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
          const candidateIds = laneBCandidateIds(targetDimensionId, wiseRowAmounts(row), entry.date);
          existingJournalId = uniqueLegacyJournalId(candidateIds);
          if (existingJournalId === undefined) {
            // Released only by an acknowledgement (the hold pass decides);
            // never an assertion: the row is created and confirmed normally.
            if (!pushJournalReview("wise_transfer_journal_ambiguous", WISE_TRANSFER_JOURNAL_AMBIGUOUS_REASON, candidateIds)) continue;
          } else {
            uniqueLegacy = true;
          }
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
          kind: "already_journalized",
          record_id: existingJournalId,
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
            kind: "already_journalized",
            record_id: existingJournalId,
            ...(uniqueLegacy ? { auto_match: { code: "wise_transfer_journal_unique_legacy" as const, journal_id: existingJournalId } } : {}),
          });
        }
      }

      const direction = sourceDirectionForWiseDirection(row.direction)!;
      if (existingJournalId !== undefined) {
        // Nothing to write: the assertion binds the journal into the plan
        // digest and execute re-checks it once after all writes.
        alreadyJournalized.push({
          row_index: row.rowIndex,
          row_key: `row:${row.rowIndex}:inter_account`,
          wise_id: row.id,
          date: entry.date,
          booked_amount: entry.amount,
          booked_currency: bookedCurrencyForWiseRow(row),
          source_direction: direction,
          ownership_basis: ownershipBasis,
          existing_journal_id: existingJournalId,
          current_journal_state: existingJournal ?? null,
        });
        continue;
      }
      const interAccountType = direction === "IN" ? "D" : "C";
      commands.push({
        version: WISE_COMMAND_VERSION,
        action: "inter_account",
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
        client_update: ownCompanyClientId !== undefined
          ? { clients_id: ownCompanyClientId }
          : null,
        confirmation_distribution: [{
          related_table: "accounts" as const,
          related_id: targetDim.accounts_id,
          related_sub_id: targetDim.id,
          amount: entry.amount,
        }],
      });
    }
  }

  // No approved own transfer at all: nothing a mapping could apply to.
  for (const [row, journalId] of pendingMappings) {
    rejectMapping(row, journalId, "the row is not an own transfer approved for inter-account booking");
  }
  ownershipReviews.push(...mappingReviews);

  // Holding a row: it loses all of its commands (main, fee, inter-account)
  // and its created entries, is skipped as "Held for review (<code>): not
  // imported", and carries exactly one review (mapping feedback aside). Only
  // this row's own reviews are replaced: split legs of one Wise ID share
  // row.id. A row whose transfer is already journalized holds only its fee
  // leg: the assertion stays, and the skip and review say so.
  const heldCodes = new Map<WiseRow, WiseTransferReview["code"]>();
  const holdRow = (row: WiseRow, holdReview: WiseTransferReview) => {
    const rowCommands = commands.filter(command => command.row_index === row.rowIndex);
    const commandWiseIds = new Set(rowCommands.map(command => command.wise_id));
    for (const command of rowCommands) commands.splice(commands.indexOf(command), 1);
    for (const entry of [...created]) {
      if (entry.source_row === row || commandWiseIds.has(entry.wise_id)) created.splice(created.indexOf(entry), 1);
    }
    mainCommandKeysByRow.delete(row.rowIndex);
    // The hold review takes the place of the row's first replaced review.
    let at = -1;
    for (const other of [...ownershipReviews]) {
      if (reviewRows.get(other) === row.rowIndex) {
        const index = ownershipReviews.indexOf(other);
        if (at < 0) at = index;
        ownershipReviews.splice(index, 1);
      }
    }
    const journalized = alreadyJournalized.find(assertion => assertion.row_index === row.rowIndex);
    const legId = legIdOf(row);
    const review = journalized === undefined ? holdReview : {
      ...holdReview,
      reason: `${holdReview.reason} Only this transfer's fee leg (FEE:${legId}) is held: the transfer itself is already journalized by journal ${journalized.existing_journal_id}.`,
    };
    skipped.push(journalized === undefined
      ? { wise_id: row.id, reason: `Held for review (${review.code}): not imported`, kind: "held" }
      : {
          wise_id: `FEE:${legId}`,
          reason: `Held for review (${review.code}): fee leg not imported; the transfer is already journalized by journal ${journalized.existing_journal_id}`,
          kind: "held",
          record_id: journalized.existing_journal_id,
        });
    heldCodes.set(row, review.code);
    reviewRows.set(review, row.rowIndex);
    ownershipReviews.splice(at < 0 ? ownershipReviews.length : at, 0, review);
  };
  const wiseSideIndex = buildWiseSideJournalIndex(journalSnapshot, accounts_dimensions_id);
  const registrationJournalIds = (tx: Transaction | undefined): number[] =>
    tx?.id === undefined ? [] : findRegistrationJournal(journalSnapshot, tx.id).map(journal => journal.id!);

  // Exact-label coverage, for a row (transfer or not) that is not an own
  // transfer handled above: when exactly one live journal is labelled with
  // this row's Wise ID, is registered, names no other Wise ID, is not the
  // registration journal of a stored Wise-account row, shows EUR for every
  // posting, and its Wise-account postings move this row's EUR amount in the
  // row's direction (gross, or net of the fee while debiting exactly the fee
  // on the fee account), that journal already books the row. No Wise bank row
  // is created, the assertion binds the journal into the plan digest and
  // execute re-checks it. The counterpart of a booked row is irrelevant, so
  // this precedes the counterpart and identity holds; anything else keeps
  // today's flow.
  // Rows an acknowledgement kept covered by their exact-label journal.
  const exactLabelAcknowledgedIds = new Set<string>();
  for (const entry of [...created]) {
    const row = entry.source_row;
    if (!row || entry.status !== "would_create") continue;
    const decision = transferDecisions.get(row);
    if (decision?.ownershipBasis !== undefined) continue;
    if (legsById.get(row.id)?.length !== 1 || legSuffix.has(row)) continue;
    // A split ID counts as split even when the date filter dropped its other leg.
    if (allRows.some(other => other.rowIndex !== row.rowIndex && other.id === row.id)) continue;
    if (alreadyJournalized.some(assertion => assertion.row_index === row.rowIndex)) continue;
    const mainKey = `row:${row.rowIndex}:main`;
    const mainIndex = commands.findIndex(command => command.row_key === mainKey && command.action === "main_create");
    if (mainIndex < 0 || bookedCurrencyForWiseRow(row) !== "EUR") continue;
    const labelled = journalSnapshot.filter(journal =>
      journal.id !== undefined && !journal.is_deleted && journalLabelledWithWiseId(journal, row.id));
    if (labelled.length !== 1) continue;
    const journal = labelled[0]!;
    const journalId = journal.id!;
    if (journal.registered !== true || hasForeignPostingWithoutBase(journal)) continue;
    if (knownWiseLabels.some(other => other !== row.id && journalLabelledWithWiseId(journal, other))) continue;
    if (journal.operation_type === "TRANSACTION" && existingTx.some(tx =>
      tx.id === journal.operations_id && tx.accounts_dimensions_id === accounts_dimensions_id)) continue;
    const fee = bookedFeeAmountForWiseRow(row);
    const netAmount = wiseLegAmountNetOfFee(row, entry.amount);
    const booksFee = feeAccountDimensionsId !== undefined && (journal.postings ?? []).some(posting =>
      !posting.is_deleted && posting.type === "D" && posting.accounts_dimensions_id === feeAccountDimensionsId &&
      cents(posting.base_amount ?? posting.amount) === cents(fee));
    const feeCommand = commands.find(command => command.row_key === `row:${row.rowIndex}:fee`);
    const feePending = feeCommand !== undefined && feeCommand.booked_currency === "EUR" &&
      cents(feeCommand.booked_amount) === cents(fee);
    // Net of the fee only while the fee row is still to be imported: a stored
    // fee row plus the journal's fee posting is a double expense to review.
    const booksNetOfFee = netAmount !== undefined && booksFee && feePending && wiseLegMoves(journal, row, netAmount);
    // Gross plus an exact fee debit also expenses the fee; importing the fee
    // row would book it twice, so leave such a journal to the normal flow.
    const booksGross = !(booksFee && cents(fee) > 0) && wiseLegMoves(journal, row, entry.amount);
    if (!booksGross && !booksNetOfFee) continue;
    // Skipping the row would hide a second booking of the same movement: the
    // hold pass never sees it. So the main leg's Wise-side evidence (the hold
    // pass's) without this journal, and the stored untagged rows moving its
    // amount in its direction within one day, hold the row and its fee
    // instead. Journals of another Wise ID or of a stored WISE:-tagged row
    // book another movement. An acknowledgement of every such journal keeps
    // the row covered by this journal; a stored row without one of them as
    // its registration journal cannot be acknowledged.
    const mainLeg = wiseMainLeg(row)!;
    const mainLegCents = mainLeg.amounts.map(cents);
    const ownRegistrationTxId = journal.operation_type === "TRANSACTION" ? journal.operations_id : undefined;
    const taggedRegistration = (other: Journal) => other.operation_type === "TRANSACTION" && existingTx.some(tx =>
      tx.id === other.operations_id && tx.accounts_dimensions_id === accounts_dimensions_id && tx.description?.startsWith("WISE:"));
    const otherEvidence = wiseLegEvidence(wiseSideIndex, mainLeg, other =>
      other.id === journalId || labelledWithOtherWiseId(other, row, knownWiseLabels) || taggedRegistration(other));
    const otherJournalIds = sortedUniqueIds(otherEvidence.certain, otherEvidence.uncertain);
    const otherRows = existingTx.filter(tx => isNonVoidTransaction(tx) && tx.id !== undefined && tx.id !== ownRegistrationTxId &&
      !tx.description?.startsWith("WISE:") && tx.accounts_dimensions_id === accounts_dimensions_id &&
      typeof tx.amount === "number" && mainLegCents.includes(cents(tx.amount)) && withinOneDay(tx.date, mainLeg.date) &&
      [mainLeg.direction, "?"].includes(markedWiseDirection(tx.description)) && !registrationJournalIds(tx).includes(journalId));
    const unacknowledgeableRows = otherRows.filter(tx => !registrationJournalIds(tx).some(id => otherJournalIds.includes(id)));
    const acknowledged = acknowledgedIds.get(row.id);
    const releasedByAcknowledgement = otherJournalIds.length > 0 && unacknowledgeableRows.length === 0 &&
      acknowledged !== undefined && otherJournalIds.every(id => acknowledged.has(id));
    if ((otherJournalIds.length > 0 || otherRows.length > 0) && !releasedByAcknowledgement) {
      const releasable = unacknowledgeableRows.length === 0;
      holdRow(row, {
        wise_id: row.id,
        code: "wise_exact_label_possible_double_booking",
        reason: WISE_EXACT_LABEL_POSSIBLE_DOUBLE_BOOKING_REASON(journalId, releasable),
        source_verified: decision?.sourceVerified ?? false,
        target_verified: decision?.targetVerified ?? false,
        approval_required: false,
        journal_id: journalId,
        ...(otherJournalIds.length > 0 ? { candidate_journal_ids: otherJournalIds } : {}),
        ...(otherEvidence.uncertain.length > 0 ? { uncertain_journal_ids: otherEvidence.uncertain } : {}),
        ...(otherRows.length > 0 ? { ledger_transaction_ids: sortedUniqueIds(otherRows.map(tx => tx.id!)) } : {}),
        ...(releasable ? { required_acknowledgement_ids: otherJournalIds } : {}),
        ...(releasable && acknowledged !== undefined
          ? { unacknowledged_journal_ids: otherJournalIds.filter(id => !acknowledged.has(id)) }
          : {}),
      });
      continue;
    }
    if (releasedByAcknowledgement) exactLabelAcknowledgedIds.add(row.id);

    commands.splice(mainIndex, 1);
    for (const command of commands) {
      if (command.depends_on === mainKey) command.depends_on = null;
    }
    mainCommandKeysByRow.delete(row.rowIndex);
    created.splice(created.indexOf(entry), 1);
    // The ownership review asked whether to book the row as an own transfer;
    // the row is booked already, so it has nothing left to decide.
    const ownershipReviewIndex = decision?.review === undefined ? -1 : ownershipReviews.indexOf(decision.review);
    if (ownershipReviewIndex >= 0) ownershipReviews.splice(ownershipReviewIndex, 1);
    skipped.push({
      wise_id: row.id,
      reason: `Already journalized: journal ${journalId} is labelled with this Wise ID and books this movement on the Wise account; no Wise bank row created${releasedByAcknowledgement
        ? `; journal(s) ${otherJournalIds.join(", ")} acknowledged (acknowledged_journal_holds) as other movements`
        : ""}`,
      kind: "already_journalized",
      record_id: journalId,
    });
    // Net of the fee, the journal books the fee too: booking the fee row
    // would expense it twice.
    if (booksNetOfFee && feeCommand !== undefined) {
      commands.splice(commands.indexOf(feeCommand), 1);
      const feeEntryIndex = created.findIndex(candidate => candidate.wise_id === feeCommand.wise_id);
      if (feeEntryIndex >= 0) created.splice(feeEntryIndex, 1);
      skipped.push({
        wise_id: feeCommand.wise_id,
        reason: `Fee already journalized: journal ${journalId} books this movement net of the fee`,
        kind: "already_journalized",
        record_id: journalId,
      });
    }
    alreadyJournalized.push({
      row_index: row.rowIndex,
      row_key: `row:${row.rowIndex}:exact_label`,
      wise_id: row.id,
      date: entry.date,
      booked_amount: entry.amount,
      booked_currency: "EUR",
      source_direction: entry.source_direction,
      existing_journal_id: journalId,
      current_journal_state: journal,
    });
  }

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
        withinOneDay(wiseRowDate(other), tx.date) &&
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
  // keeps its create (and a transfer is then held by its lookalike), even a
  // transfer imported as an ordinary payment, which has neither a review nor
  // an inter-account command.
  const untaggedRowCovers = (entry: WiseCreatedEntry, tx: Transaction): boolean => {
    const row = entry.source_row;
    if (!row || tx.status !== "CONFIRMED" || typeof tx.amount !== "number") return false;
    if (isWiseTransferCandidate(row)) return false;
    if (Math.round(tx.amount * 100) !== Math.round(entry.amount * 100) || (tx.cl_currencies_id ?? "EUR") !== "EUR") return false;
    if (!commands.some(command => command.row_key === `row:${row.rowIndex}:main` && command.action === "main_create")) return false;
    if (commands.some(command => command.row_index === row.rowIndex && command.action === "inter_account")) return false;
    if (alreadyJournalized.some(assertion => assertion.row_index === row.rowIndex)) return false;
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
        kind: "already_imported",
        record_id: lookalikes[0]!.id!,
        auto_match: { code: "wise_untagged_ledger_unique", transaction_id: lookalikes[0]!.id! },
      });
      continue;
    }
    const untaggedReview: WiseTransferReview = {
      wise_id: entry.wise_id,
      code: "wise_untagged_ledger_match",
      reason: WISE_UNTAGGED_LEDGER_MATCH_REASON,
      source_verified: false,
      target_verified: false,
      approval_required: false,
      ledger_transaction_ids: matches.map(tx => tx.id!),
    };
    // A fee entry has no source row: its command names the row.
    const entryRowIndex = entry.source_row?.rowIndex ?? commands.find(command => command.wise_id === entry.wise_id)?.row_index;
    if (entryRowIndex !== undefined) reviewRows.set(untaggedReview, entryRowIndex);
    ownershipReviews.push(untaggedReview);
  }

  const holdCheckRows: WiseHoldCheckRow[] = [];
  const acknowledgedHolds: WiseAcknowledgedJournalHold[] = [];
  // --- Hold pass: every eligible hinted (transfer) row that still has a
  // command (holdRow above).
  for (const row of eligible) {
    const decision = transferDecisions.get(row);
    const rowCommands = commands.filter(command => command.row_index === row.rowIndex);
    if (decision === undefined || rowCommands.length === 0) continue;
    // 1. Counterpart hold: hard, not releasable, its review is the only one.
    // A row its exact-label journal already books keeps only its fee leg,
    // which is confirmed against the fee account and needs no counterpart.
    const exactLabelled = alreadyJournalized.some(assertion =>
      assertion.row_index === row.rowIndex && assertion.row_key === `row:${row.rowIndex}:exact_label`);
    if (decision.counterpartHold !== undefined && !exactLabelled) {
      holdRow(row, decision.counterpartHold);
      continue;
    }
    const legId = legIdOf(row);
    const pendingMain = rowCommands.some(command => command.action === "main_create");
    const pendingFee = rowCommands.some(command => command.action === "fee_create_and_confirm");
    // Proven coverage, per leg: the row's own already-journalized assertion,
    // the registration journals of the stored rows Wise-ID dedup matched to
    // the leg, and the untagged stored row matched to it. Never a review
    // candidate or another row's stored transaction.
    const storedTagged = (tag: string) => existingTx.filter(tx => tx.description?.split(" ")[0] === tag);
    const untaggedUnique = skipped.find(entry => entry.wise_id === legId && entry.auto_match?.code === "wise_untagged_ledger_unique");
    const mainCoverage = new Set<number>([
      ...alreadyJournalized.filter(assertion => assertion.row_index === row.rowIndex).map(assertion => assertion.existing_journal_id),
      ...registrationJournalIds(claimedMainLegs.get(row)),
      ...storedTagged(`WISE:${legId}`).flatMap(registrationJournalIds),
      ...(untaggedUnique?.auto_match?.code === "wise_untagged_ledger_unique"
        ? registrationJournalIds(existingTx.find(tx => tx.id === untaggedUnique.auto_match!.transaction_id))
        : []),
    ]);
    const feeCoverage = new Set<number>([
      ...registrationJournalIds(claimedFeeLegs.get(row)),
      ...storedTagged(`WISE:FEE:${legId}`).flatMap(registrationJournalIds),
    ]);
    // 2. Exact-ID identity, independent of Lane B, ownership and currency: a
    // live journal labelled with this Wise ID that is not the row's proven
    // coverage means the transfer may already be booked.
    const identityIds = journalSnapshot
      .filter(journal => journal.id !== undefined && !journal.is_deleted && journalLabelledWithWiseId(journal, row.id) &&
        !mainCoverage.has(journal.id) && !feeCoverage.has(journal.id))
      .map(journal => journal.id!)
      .sort((left, right) => left - right);
    if (identityIds.length > 0) {
      const existing = ownershipReviews.find(review => reviewRows.get(review) === row.rowIndex && review.code === "wise_transfer_journal_inconsistent");
      holdRow(row, existing ?? {
        wise_id: row.id,
        code: "wise_transfer_journal_inconsistent",
        reason: WISE_TRANSFER_JOURNAL_INCONSISTENT_REASON,
        source_verified: decision.sourceVerified,
        target_verified: decision.targetVerified,
        approval_required: false,
        candidate_journal_ids: identityIds,
      });
      continue;
    }
    // 3. Other hard holds: a stored untagged lookalike of this transfer.
    const commandWiseIds = new Set(rowCommands.map(command => command.wise_id));
    const untaggedMatch = ownershipReviews.find(review => review.code === "wise_untagged_ledger_match" && commandWiseIds.has(review.wise_id));
    if (untaggedMatch) {
      holdRow(row, { ...untaggedMatch, wise_id: row.id, reason: WISE_UNTAGGED_LEDGER_MATCH_TRANSFER_REASON });
      continue;
    }
    // 4. Wise-side evidence of every pending leg, minus that leg's coverage,
    // plus the ambiguous review's candidates.
    const skipOtherLabelled = (journal: Journal) => labelledWithOtherWiseId(journal, row, knownWiseLabels);
    const mainLeg = pendingMain ? wiseMainLeg(row) : undefined;
    const feeLeg = pendingFee ? wiseFeeLeg(row) : undefined;
    const evidenceFor = (leg: WiseLeg | undefined, coverage: Set<number>) => {
      const evidence = leg === undefined ? { certain: [], uncertain: [] } : wiseLegEvidence(wiseSideIndex, leg, skipOtherLabelled);
      return {
        certain: evidence.certain.filter(id => !coverage.has(id)),
        uncertain: evidence.uncertain.filter(id => !coverage.has(id)),
      };
    };
    const mainEvidence = evidenceFor(mainLeg, mainCoverage);
    const feeEvidence = evidenceFor(feeLeg, feeCoverage);
    const ambiguous = ownershipReviews.find(review => reviewRows.get(review) === row.rowIndex && review.code === "wise_transfer_journal_ambiguous") ??
      pendingReleaseReviews.get(row);
    const evidenceIds = sortedUniqueIds(
      mainEvidence.certain, mainEvidence.uncertain, feeEvidence.certain, feeEvidence.uncertain,
      ambiguous?.candidate_journal_ids ?? [],
    );
    // 5. Decision: no evidence keeps the row; an acknowledgement listing
    // every evidence journal releases it into the ordinary flow.
    const acknowledged = acknowledgedIds.get(row.id);
    const unacknowledged = evidenceIds.filter(id => acknowledged?.has(id) !== true);
    if (evidenceIds.length === 0 || (acknowledged !== undefined && unacknowledged.length === 0)) {
      if (evidenceIds.length > 0) acknowledgedHolds.push({ wise_id: row.id, journal_ids: evidenceIds });
      holdCheckRows.push({
        row_index: row.rowIndex,
        wise_id: row.id,
        legs: {
          ...(mainLeg ? { main: { leg: mainLeg, coverage: sortedUniqueIds(mainCoverage) } } : {}),
          ...(feeLeg ? { fee: { leg: feeLeg, coverage: sortedUniqueIds(feeCoverage) } } : {}),
        },
        ...(evidenceIds.length > 0 ? { acknowledged_ids: evidenceIds } : {}),
      });
      continue;
    }
    // 6. Hold, with the full union to acknowledge from the first response.
    const uncertainIds = sortedUniqueIds(mainEvidence.uncertain, feeEvidence.uncertain);
    const feeLegIds = sortedUniqueIds(feeEvidence.certain, feeEvidence.uncertain);
    const base: WiseTransferReview = ambiguous ?? {
      wise_id: row.id,
      code: "wise_transfer_journal_existing_elsewhere",
      reason: WISE_TRANSFER_JOURNAL_EXISTING_ELSEWHERE_REASON,
      source_verified: decision.sourceVerified,
      target_verified: decision.targetVerified,
      approval_required: false,
      candidate_journal_ids: evidenceIds,
    };
    holdRow(row, {
      ...base,
      required_acknowledgement_ids: evidenceIds,
      ...(uncertainIds.length > 0 ? { uncertain_journal_ids: uncertainIds } : {}),
      ...(feeLegIds.length > 0 ? { fee_leg_journal_ids: feeLegIds } : {}),
      ...(acknowledged !== undefined ? { unacknowledged_journal_ids: unacknowledged } : {}),
    });
  }

  // not_own_transfer_ids on a row held for its counterpart: the hold stays,
  // and the conflict is reported unbound to the row (as an unused
  // acknowledgement is), so holdRow never replaces it.
  for (const row of eligible) {
    const conflict = transferDecisions.get(row)?.notOwnConflict;
    if (conflict !== undefined && heldCodes.has(row) && !ownershipReviews.includes(conflict)) ownershipReviews.push(conflict);
  }

  // Transfer rows imported as ordinary payments, once per Wise ID: info for
  // the owner, not a review. A held row has lost its create and is not listed.
  const transfersTreatedAsPayments: WiseTransferTreatedAsPayment[] = [];
  for (const row of eligible) {
    const basis = transferDecisions.get(row)?.externalPayment;
    if (basis === undefined || transfersTreatedAsPayments.some(entry => entry.wise_id === row.id)) continue;
    if (!commands.some(command => command.row_key === `row:${row.rowIndex}:main` && command.action === "main_create")) continue;
    transfersTreatedAsPayments.push({ wise_id: row.id, basis });
  }

  // acknowledged_journal_holds entries that release nothing are reported, as
  // an unused journalized_transfer_ids mapping is. A row still held by a
  // releasable hold already names the journals its acknowledgement missed.
  for (const acknowledgement of acknowledgedJournalHolds) {
    if (acknowledgedHolds.some(hold => hold.wise_id === acknowledgement.wise_id) ||
      exactLabelAcknowledgedIds.has(acknowledgement.wise_id)) continue;
    const legs = eligible.filter(row => row.id === acknowledgement.wise_id);
    const codes = legs.flatMap(row => heldCodes.get(row) ?? []);
    if (codes.some(code => code === "wise_transfer_journal_ambiguous" || code === "wise_transfer_journal_existing_elsewhere" ||
      code === "wise_exact_label_possible_double_booking")) continue;
    const why = legs.length === 0
      ? "no eligible row of this statement has this Wise ID"
      : !legs.some(isWiseTransferCandidate)
        ? "the row is not a Wise transfer row, and only transfer rows are held by journals"
        : codes.length > 0
          ? `the row is held for ${codes[0]}, which an acknowledgement cannot release`
          : "the row is not held by a journal on the Wise account, so there is nothing to release";
    ownershipReviews.push({
      wise_id: acknowledgement.wise_id,
      code: "unused_acknowledgement",
      reason: `This acknowledged_journal_holds entry was not used: ${why}.`,
      source_verified: false,
      target_verified: false,
      approval_required: false,
    });
  }

  // counterpart_overrides entries that decided nothing are reported, as an
  // unused acknowledgement is.
  for (const override of counterpartOverrides) {
    const legs = eligible.filter(row => row.id === override.wise_id);
    if (legs.some(row => transferDecisions.get(row)?.counterpartOverrideApplied === true)) continue;
    const why = legs.length === 0
      ? "no eligible row of this statement has this Wise ID"
      : !legs.some(isWiseTransferCandidate)
        ? "the row is not a Wise transfer row"
        : "the row has no own-account evidence on another bank account to choose from (an override only picks among the evidenced bank accounts; for a row without evidence pass inter_account_dimension_id)";
    ownershipReviews.push({
      wise_id: override.wise_id,
      code: "unused_counterpart_override",
      reason: `This counterpart_overrides entry was not used: ${why}.`,
      source_verified: false,
      target_verified: false,
      approval_required: false,
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
    const date = wiseRowDate(row);
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
    fix.result = (candidatesByWiseId.get(fix.wise_id) ?? 0) > 1 ? "ambiguous_skipped" : "advisory";
  }

  return {
    commands,
    created,
    skipped,
    mainCommandKeysByRow,
    ownershipReviews,
    invoiceFixCandidates,
    alreadyJournalized,
    feeResolutionRequired,
    holdCheckRows,
    acknowledgedHolds,
    transfersTreatedAsPayments,
  };
}
