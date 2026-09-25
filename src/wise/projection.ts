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
import {
  bookedAmountForWiseRow,
  bookedCurrencyForWiseRow,
  bookedFeeAmountForWiseRow,
  bookedFeeCurrencyForWiseRow,
  buildAccountDistributionFromDimension,
  buildWiseTransactionSignature,
  counterpartyNameForWiseRow,
  normalizeWiseCompanyName,
  normalizeWiseCurrency,
  oppositeSideForWiseRow,
  sourceDirectionForWiseDirection,
  stripWisePrefix,
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
  type WiseRow,
  type WiseSkippedEntry,
  type WiseTransferDecision,
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
  // Signature fallback for rows imported before descriptions carried a WISE tag.
  // A row that DOES carry one has an explicit identity, and the exact-tag check
  // above already handled the matching case — so any other WISE-tagged row is a
  // different Wise transaction, not evidence that this command already ran.
  // Without this exclusion the row created moments ago in this same run refuses
  // its identical-looking sibling (two same-day payments to one merchant, a
  // payment and its refund, two identical fees) at the execute-time
  // precondition, after the projection had correctly planned both.
  return live.some(transaction =>
    !transaction.description?.startsWith("WISE:") &&
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
  return transaction.accounts_dimensions_id === payload.accounts_dimensions_id &&
    transaction.type === payload.type &&
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
  readonly accountsDimensionsId: number;
  readonly accountDimensions: AccountDimension[];
  readonly feeAccountDimensionsId: number | undefined;
  readonly wiseClientId: number | undefined;
  /** Non-void ledger transactions, already fetched by the operation layer. */
  readonly existingTx: Transaction[];
  readonly transferDecisions: Map<WiseRow, WiseTransferDecision>;
  readonly postingDimensionsSnapshot: Map<number, AccountDimension>;
  readonly journalSnapshot: Journal[];
  /** Lane B guard over `journalSnapshot`, built fresh per projection pass
   * (resolution consumes matched ref-less journals). */
  readonly createInterAccountGuard: (ownDimensionIds: Set<number>) => BookingGuard;
  /** Exact Wise IDs the operator passed in confirm_own_transfer_ids. */
  readonly approvedTransferIds: ReadonlySet<string>;
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

const WISE_TRANSFER_CROSS_CURRENCY_REASON =
  "Wise transfer is not a same-currency EUR movement, so its booked amount is not the base EUR the counterpart bank account records. The row is imported unconfirmed; reconcile it with reconcile_inter_account_transfers.";
const WISE_TRANSFER_JOURNAL_AMBIGUOUS_REASON =
  "A same-amount inter-account journal within one day of this Wise transfer cannot be told apart from this transfer (ambiguous or differently labelled). The row is imported unconfirmed; reconcile it with reconcile_inter_account_transfers.";
const WISE_TRANSFER_ALREADY_IMPORTED_REASON =
  "This Wise transfer was already imported by an earlier run, so confirm_own_transfer_ids does not act on it. Confirm the existing bank transaction with reconcile_inter_account_transfers.";

export function projectWiseCommands(input: WiseProjectionInput): WiseProjectionOutput {
  const {
    eligible,
    accountsDimensionsId,
    accountDimensions,
    feeAccountDimensionsId,
    wiseClientId,
    existingTx,
    transferDecisions,
    postingDimensionsSnapshot,
    journalSnapshot,
    createInterAccountGuard,
    approvedTransferIds,
    ownCompanyClientId,
    ownCompanyClientMatches,
    allPurchaseInvoices,
  } = input;
  const accounts_dimensions_id = accountsDimensionsId;

  // Signatures of ALREADY-STORED ledger rows, bucketed by the direction the
  // importer recorded for them. The signature itself is direction-blind
  // (stripWisePrefix removes the [source_direction=…] marker), so a same-day
  // same-amount refund from a counterparty we paid earlier would otherwise be
  // dropped as a duplicate of that payment. Only the EXPLICIT marker counts:
  // deriving direction from the legacy `type` would mis-read rows written
  // during the 0.22.0 forced-"C" window and re-import them (double booking).
  // An unmarked row buckets as "?" and keeps the previous match-anything
  // behaviour, so this can never cause a re-import — only prevent a false drop.
  const markedWiseDirection = (description?: string | null): "IN" | "OUT" | "?" => {
    const marked = description?.match(/\[source_direction=(IN|OUT)\]\s*$/i)?.[1];
    return marked === undefined ? "?" : (marked.toUpperCase() as "IN" | "OUT");
  };
  const existingSignatureDirections = new Map<string, Set<"IN" | "OUT" | "?">>();
  for (const tx of existingTx) {
    if (typeof tx.date !== "string" || typeof tx.amount !== "number") continue;
    const signature = buildWiseTransactionSignature(
      tx.date,
      tx.amount,
      tx.cl_currencies_id ?? "EUR",
      tx.bank_account_name,
      tx.ref_number,
      stripWisePrefix(tx.description),
    );
    const bucket = existingSignatureDirections.get(signature);
    if (bucket) bucket.add(markedWiseDirection(tx.description));
    else existingSignatureDirections.set(signature, new Set([markedWiseDirection(tx.description)]));
  }
  const alreadyStored = (signature: string, direction: "IN" | "OUT"): boolean => {
    const bucket = existingSignatureDirections.get(signature);
    return bucket !== undefined && (bucket.has("?") || bucket.has(direction));
  };
  // Also check by Wise ID in description
  const seenWiseIds = new Set(
    existingTx
      .filter(tx => tx.description?.startsWith("WISE:"))
      .map(tx => tx.description!.split(" ")[0])
  );

  const created: WiseCreatedEntry[] = [];
  const skipped: WiseSkippedEntry[] = [];
  const commands: WiseImportCommand[] = [];
  const mainCommandKeysByRow = new Map<number, string>();
  const alreadyImportedApprovalReviews: WiseTransferReview[] = [];
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
    const wiseIdTag = `WISE:${row.id}`;
    // The WISE:{id} tag is the dedup identity and the source-direction marker is
    // mandatory, so neither is ever truncated: a row whose main (or fee)
    // description cannot fit them within the description cap is not booked.
    if (
      withWiseSourceDirection(wiseIdTag, sourceDirection).length > TRANSACTION_DESCRIPTION_MAX_LENGTH ||
      (fee > 0 && withWiseSourceDirection(`WISE:FEE:${row.id} Wise teenustasu`, "OUT").length > TRANSACTION_DESCRIPTION_MAX_LENGTH)
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
    const uncappedDesc = withWiseSourceDirection(narrative ? `${wiseIdTag} ${narrative}` : wiseIdTag, sourceDirection);
    // Transactions.description maxLength is 150: trim only the narrative so the
    // WISE:{id} identity prefix and the trailing [source_direction=…] marker
    // always survive (mirrors CAMT's metadata-marker budget).
    const narrativeBudget = TRANSACTION_DESCRIPTION_MAX_LENGTH - withWiseSourceDirection(wiseIdTag, sourceDirection).length - 1;
    const cappedNarrative = narrative.length > narrativeBudget
      ? narrative.slice(0, Math.max(0, narrativeBudget)).trimEnd()
      : narrative;
    const desc = withWiseSourceDirection(cappedNarrative ? `${wiseIdTag} ${cappedNarrative}` : wiseIdTag, sourceDirection);
    const bankAccountName = counterpartyName?.slice(0, WISE_BANK_ACCOUNT_NAME_MAX_LENGTH);
    // Two signature forms per name: the legacy uncapped one (rows imported
    // before the caps) and the exact stored form — capped name, the description
    // as createBankTransaction stores it (full over-cap ref woven in when it
    // fits) and the capped ref — so the stored row re-hashes identically.
    const canonicalRef = canonicalRefNumber(row.reference || undefined);
    const storedDesc = canonicalRef.truncated && canonicalRef.full
      ? weaveFullRefIntoDescription(desc, canonicalRef.full)
      : desc;
    const mainSignatureCandidates = new Set(
      [counterpartyName, row.targetName || undefined, row.sourceName || undefined]
        .filter((name): name is string => Boolean(name))
        .flatMap((name) => [
          buildWiseTransactionSignature(
            date,
            amount,
            transactionCurrency,
            name,
            row.reference || undefined,
            stripWisePrefix(uncappedDesc),
          ),
          buildWiseTransactionSignature(
            date,
            amount,
            transactionCurrency,
            name.slice(0, WISE_BANK_ACCOUNT_NAME_MAX_LENGTH),
            canonicalRef.value,
            stripWisePrefix(storedDesc),
          ),
        ])
    );
    const mainAlreadyImported = seenWiseIds.has(wiseIdTag) ||
      [...mainSignatureCandidates].some(signature => alreadyStored(signature, sourceDirection));
    let mainAvailableForFee = false;

    if (mainAlreadyImported) {
      skipped.push({
        wise_id: row.id,
        reason: seenWiseIds.has(wiseIdTag)
          ? "Already imported (Wise ID match)"
          : "Already imported (date/amount/counterparty/reference match)",
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
      // Fees are always outgoing. The fee signature is date|amount|EUR|"Wise"||
      // "wise teenustasu" — identical for every same-day, same-amount fee — so
      // this must only ever match a STORED fee, never another fee planned in
      // this same run (seenWiseIds keeps those apart by Wise ID).
      if (seenWiseIds.has(feeWiseIdTag) || alreadyStored(feeSignature, "OUT")) {
        skipped.push({
          wise_id: `FEE:${row.id}`,
          reason: seenWiseIds.has(feeWiseIdTag)
            ? "Fee already imported (Wise ID match)"
            : "Fee already imported (date/amount/counterparty match)",
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
  ownershipReviews.push(...alreadyImportedApprovalReviews);

  const approvedTransferDecisions = [...transferDecisions.values()].filter(
    decision => decision.ownershipBasis !== undefined,
  );
  if (approvedTransferDecisions.length > 0) {
    const ownDimensionIds = new Set<number>([accounts_dimensions_id]);
    for (const decision of approvedTransferDecisions) {
      if (decision.targetDimensionId !== undefined) ownDimensionIds.add(decision.targetDimensionId);
    }
    // Lane B, like reconcile_inter_account_transfers: ±1 day, labelled journals
    // identity-only, a matched ref-less journal consumed. Planned rows are NOT
    // recorded back: every row here is a Wise-side leg with a unique Wise ID,
    // so two of them are never the two legs of one transfer.
    const guard = createInterAccountGuard(ownDimensionIds);

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
        bookedCurrencyForWiseRow(row) !== "EUR" ||
        normalizeWiseCurrency(row.sourceCurrency) !== normalizeWiseCurrency(row.targetCurrency)
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
      const resolution = guard.resolveInterAccount(query);
      if (
        resolution.status === "ambiguous_refless" ||
        (resolution.status === "none" && guard.hasOtherLabelledInterAccount(query))
      ) {
        ownershipReviews.push(reviewFor("wise_transfer_journal_ambiguous", WISE_TRANSFER_JOURNAL_AMBIGUOUS_REASON));
        continue;
      }
      const existingJournalId = resolution.status === "matched" ? resolution.journal_id : undefined;
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
          reason: `Already journalized: inter-account journal ${existingJournalId} books this transfer; no Wise bank row created`,
        });
        dependsOn = null;
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

  // --- Post-import: scan eligible payment rows for unpaid purchase invoices
  // that could be repriced to Wise's actual EUR conversion. ADVISORY ONLY: the
  // invoices are CONFIRMED, so the import never modifies them — it reports the
  // proposed correction for the operator to apply deliberately.
  const invoiceFixCandidates: WiseInvoiceFixCandidate[] = [];

  const paymentRows = eligible.filter(r => sourceDirectionForWiseDirection(r.direction) === "OUT" && bookedAmountForWiseRow(r) > 0);
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
