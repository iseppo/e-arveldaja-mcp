import { createHash } from "node:crypto";
import type { AccountDimension, BankAccount, Journal, Transaction } from "../types/api.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import {
  assertFileInputSnapshotIdentity,
  captureFileInputSnapshot,
  FileInputSnapshotError,
  type FileInputSource,
  type FileInputSnapshot,
} from "../file-input-snapshot.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import {
  PlanStoreError,
  type ExecutionPlanInput,
  type PlanData,
  type PlanRecord,
  type StoredExecutionPlan,
} from "../plan-store.js";
import { stripUndefinedDeep } from "../tools/camt-plan.js";
import { isRecord } from "../record-utils.js";
import { logAudit } from "../audit-log.js";
import { reportProgress } from "../progress.js";
import { clearRuntimeCaches } from "../cache-control.js";
import { isNonVoidTransaction } from "../transaction-status.js";
import { createBankTransaction } from "../bank-transaction-create.js";
import { isMutationIndeterminate } from "../mutation-outcome.js";
import { BookingGuard } from "../booking-guard.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { buildBankDimensionCandidates } from "../resolution/bank-account-resolution.js";
import { buildBankAccountLookups } from "../tools/inter-account-utils.js";
import { selectClientByName } from "../camt/executor.js";
import { normalizeCompanyName } from "../company-name.js";
import { resolveWiseRowCounterparts, wiseCounterpartHoldReview } from "./counterpart.js";
import {
  bankIdentitiesByDimension,
  bookedAmountForWiseRow,
  classifyWiseOwnTransfer,
  isJarTransfer,
  isPositiveSafeInteger,
  isWiseClientName,
  isWiseTransferCandidate,
  normalizeWiseCompanyName,
  normalizeWiseDirection,
  preflightWiseCsv,
  resolveOwnCompanyClientId,
  resolveWiseCardClientFromHistory,
  resolveWiseFeeAccountDimensionId,
  sourceDirectionForWiseDirection,
  uniqueActivePostingDimensions,
  validateWiseDateRange,
  wiseExternalEndpointIsForeign,
  wiseRowAmounts,
  wiseRowDate,
} from "./preflight.js";
import {
  approvalDigest,
  buildWiseSideJournalIndex,
  canonicalPlanJson,
  createdTransactionMatchesApprovedPayload,
  exactStateMatches,
  journalLabelledWithWiseId,
  knownWiseLabelsFor,
  labelledWithOtherWiseId,
  orderedIdsEqual,
  projectWiseCommands,
  sortedUniqueIds,
  transactionCommandExists,
  wisePlanCommandId,
  wisePlanReviewProjection,
  wiseRowNeedsClientResolution,
  wiseLegEvidence,
  WISE_APPROVAL_DOMAIN,
  WISE_COMMAND_VERSION,
  WISE_PLAN_COMMAND_CATEGORY,
  WISE_PLAN_DOMAIN,
} from "./projection.js";
import type {
  FeeCreateCommand,
  ImportRejectedField,
  WiseCounterpartOverride,
  InterAccountCommand,
  MainCreateCommand,
  WiseCreatedEntry,
  WiseImportCommand,
  WiseInterAccountResult,
  WiseAcknowledgedJournalHold,
  WiseClientResolution,
  WiseJournalizedTransferMapping,
  WiseRow,
  WiseSkippedJarRow,
  WiseTransferDecision,
  WiseTransferReview,
} from "./types.js";
import type { WiseImportRenderData } from "./presenter.js";

const WISE_MAX_FILE_SIZE = 10 * 1024 * 1024;

// EXECUTION LOCK: a module-level, per-connection serialization gate. Two Wise
// executes against the same connection never interleave their read-then-write
// windows. Kept module-level (not per-instance) exactly as before.
const wiseExecutionLocks = new Map<string, Promise<void>>();

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

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type WiseFailure =
  | { kind: "preflight"; rejected: ImportRejectedField[] }
  | { kind: "plan_store_error"; code: string; message: string }
  | { kind: "plan_handle_required" }
  | { kind: "digest_mismatch" }
  | { kind: "plan_drift"; detail: string }
  | { kind: "ownership_reapproval_required" }
  | { kind: "wise_client_not_found" }
  | { kind: "wise_dimension_not_bank_account" };

export type WiseRunResult =
  | { readonly ok: true; readonly data: WiseImportRenderData }
  | { readonly ok: false; readonly failure: WiseFailure };

/**
 * Thrown by the typed WiseOperations facade for failure kinds whose byte-exact
 * MCP envelope needs data beyond {code,message,retry} (preflight rejected
 * fields, the real plan-store error code, plan-drift detail). It carries the
 * FULL discriminated WiseFailure so the tool/presenter layer can project it via
 * renderWiseFailure — mirroring CamtPreflightRejectedError. Not an MCP type; the
 * operation interface still returns OperationOutcome<T> for the simple kinds.
 */
export class WiseOperationFailedError extends Error {
  constructor(readonly failure: WiseFailure) {
    super("Wise operation failed");
    this.name = "WiseOperationFailedError";
  }
}

const WISE_NOT_OWN_TRANSFER_HELD_REASON =
  "not_own_transfer_ids lists this transfer, but the row is held for its counterpart bank account (see its own review), so the decision is not applied and the row is not imported. Resolve that hold with the owner first.";
const WISE_NOT_OWN_TRANSFER_EVIDENCE_REASON = (dimensionId: number) =>
  `not_own_transfer_ids lists this transfer, but own-account evidence (or the counterpart_overrides choice) shows it goes to or from own bank account ${dimensionId}. The row is not imported. Check that bank's rows with the owner: if it is an own transfer, drop the ID from not_own_transfer_ids; otherwise book it with the owner.`;

/** The review for an owner's not_own_transfer_ids decision the evidence contradicts. */
function notOwnConflictReview(row: WiseRow, reason: string, decision: WiseTransferDecision): WiseTransferReview {
  return {
    wise_id: row.id,
    code: "not_own_transfer_conflicts_evidence",
    reason,
    source_verified: decision.sourceVerified,
    target_verified: decision.targetVerified,
    approval_required: false,
  };
}

export interface WiseRunInput {
  readonly source: FileInputSource;
  readonly accountsDimensionsId: number;
  readonly feeAccountDimensionsId: number | undefined;
  readonly feeAccountRelationId: number | undefined;
  readonly interAccountDimensionId: number | undefined;
  readonly confirmOwnTransferIds: string[] | undefined;
  /** Exact Wise IDs the owner says are not own transfers (not_own_transfer_ids):
   * imported as ordinary payments unless own-account evidence contradicts it. */
  readonly notOwnTransferIds?: readonly string[];
  /** Operator-reviewed Wise ID → labelled journal mappings (journalized_transfer_ids). */
  readonly journalizedTransferIds?: readonly WiseJournalizedTransferMapping[];
  /** Owner acknowledgements (acknowledged_journal_holds): journals that do not
   * book a held Wise transfer. */
  readonly acknowledgedJournalHolds?: readonly WiseAcknowledgedJournalHold[];
  /** Owner choices (counterpart_overrides): the bank a transfer row with
   * own-account evidence on several banks goes to or from. */
  readonly counterpartOverrides?: readonly WiseCounterpartOverride[];
  readonly approvedCommandDigest: string | undefined;
  readonly dateFrom: string | undefined;
  readonly dateTo: string | undefined;
  readonly skipJarTransfers: boolean | undefined;
  /** ADDITIVE (bank façade): an immutable snapshot captured ONCE upstream under
   * the unified bank_input operation, threaded by identity so the Wise op does
   * not read the source a second time. Absent for the granular
   * import_wise_transactions path, which captures internally under wise_input. */
  readonly snapshot?: FileInputSnapshot;
}

export interface WisePrepareRunInput extends WiseRunInput {
  /** Issue a server plan handle for the reviewed dry run (default true). A
   * preview-only caller passes false: no plan is issued, no plan_handle returned. */
  readonly mintPlanHandle?: boolean;
}

/**
 * Shared dry-run / execute orchestration. All api I/O (file capture, ledger,
 * bank, invoice, journal, purchase-invoice reads, mutations, audit, execution
 * lock) lives here; the byte-stable command building and digest assembly stay
 * pure in ./projection. On execute the reviewed plan is consumed ONCE by the
 * caller (burn-before-validate) and passed in as `storedWisePlan`.
 */
async function runWiseImport(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: WiseRunInput,
  executeRequested: boolean,
  storedWisePlan: StoredExecutionPlan | undefined,
  mintPlanHandle = true,
): Promise<WiseRunResult> {
  const {
    source,
    accountsDimensionsId: accounts_dimensions_id,
    feeAccountDimensionsId: fee_account_dimensions_id,
    feeAccountRelationId: fee_account_relation_id,
    interAccountDimensionId: inter_account_dimension_id,
    confirmOwnTransferIds: confirm_own_transfer_ids,
    notOwnTransferIds: not_own_transfer_ids,
    journalizedTransferIds: journalized_transfer_ids,
    acknowledgedJournalHolds: acknowledged_journal_holds,
    counterpartOverrides: counterpart_overrides,
    approvedCommandDigest: approved_command_digest,
    dateFrom: date_from,
    dateTo: date_to,
    skipJarTransfers: skip_jar_transfers,
  } = input;

  validateWiseDateRange(date_from, date_to);

  const skipJars = skip_jar_transfers !== false;
  let inputSnapshot: FileInputSnapshot;
  try {
    // ADDITIVE snapshot threading (bank façade): reuse the pre-captured immutable
    // bytes when present so a bank_input file_ref is never re-resolved under
    // wise_input and the source is read only once. The granular path passes no
    // snapshot and captures internally under wise_input — byte-identical.
    inputSnapshot = input.snapshot ?? await captureFileInputSnapshot({
      ...(source.file_path !== undefined ? { file_path: source.file_path } : {}),
      ...(source.file_ref !== undefined ? { file_ref: source.file_ref } : {}),
    }, {
      runtimeSafetyContext,
      operation: FILE_REFERENCE_OPERATIONS.wise,
      allowedExtensions: [".csv"],
      maxSize: WISE_MAX_FILE_SIZE,
    });
  } catch (error) {
    // On execute the handle is already burned; a source that cannot be
    // re-read to match the reviewed plan is drift, not a fresh failure.
    if (executeRequested && error instanceof FileInputSnapshotError) {
      return { ok: false, failure: { kind: "plan_drift", detail: "the Wise source could not be re-read to match the reviewed plan" } };
    }
    throw error;
  }
  const csvBytes = inputSnapshot.bytes();
  const csv = csvBytes.toString("utf8");
  const rawCsvSha256 = sha256(csvBytes);
  // Preflight before the cache clear, every API read, progress report, audit
  // entry, and mutation. A valid digest over a malformed CSV fails here and
  // never hands back a replacement digest.
  const preflight = preflightWiseCsv(csv);
  if (!preflight.ok) return { ok: false, failure: { kind: "preflight", rejected: preflight.rejected_fields } };
  const rows = preflight.rows;
  // Planning is always side-effect free: this branch only compiles command
  // payloads. Approved execution consumes them after the digest gate below.
  clearRuntimeCaches();

  // Filter rows
  let skippedJarCount = 0;
  const skippedJarRows: WiseSkippedJarRow[] = [];
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
        date: wiseRowDate(r),
      });
      return false;
    }
    const date = wiseRowDate(r);
    if (date_from && date < date_from) return false;
    if (date_to && date > date_to) return false;
    return true;
  });

  const hintedRows = eligible.filter(isWiseTransferCandidate);
  const approvedTransferIds = confirm_own_transfer_ids ?? [];
  if (new Set(approvedTransferIds).size !== approvedTransferIds.length) {
    throw new Error("confirm_own_transfer_ids must contain unique exact Wise transfer IDs.");
  }
  const acknowledgements = acknowledged_journal_holds ?? [];
  if (new Set(acknowledgements.map(hold => hold.wise_id)).size !== acknowledgements.length) {
    throw new Error("acknowledged_journal_holds must list each Wise ID once.");
  }
  // Sorted and de-duplicated: the order the operator lists them in is not a decision.
  const canonicalAcknowledgements: WiseAcknowledgedJournalHold[] = acknowledgements
    .map(({ wise_id, journal_ids }) => ({ wise_id, journal_ids: sortedUniqueIds(journal_ids) }))
    .sort((left, right) => left.wise_id < right.wise_id ? -1 : left.wise_id > right.wise_id ? 1 : 0);
  const overrideEntries = counterpart_overrides ?? [];
  if (new Set(overrideEntries.map(entry => entry.wise_id)).size !== overrideEntries.length) {
    throw new Error("counterpart_overrides must list each Wise ID once.");
  }
  // Sorted like the acknowledgements: the listing order is not a decision.
  const canonicalOverrides: WiseCounterpartOverride[] = overrideEntries
    .map(({ wise_id, dimension_id }) => ({ wise_id, dimension_id }))
    .sort((left, right) => left.wise_id < right.wise_id ? -1 : left.wise_id > right.wise_id ? 1 : 0);
  const counterpartOverrideMap = new Map(canonicalOverrides.map(entry => [entry.wise_id, entry.dimension_id]));
  const eligibleHintIds = new Set(hintedRows.map(row => row.id));
  if (approvedTransferIds.some(id => !eligibleHintIds.has(id))) {
    throw new Error(
      "confirm_own_transfer_ids must reference eligible TRANSFER-* or BANK_DETAILS_PAYMENT_RETURN-* rows in this CSV exactly."
    );
  }
  const notOwnTransferIds = not_own_transfer_ids ?? [];
  if (new Set(notOwnTransferIds).size !== notOwnTransferIds.length) {
    throw new Error("not_own_transfer_ids must contain unique exact Wise transfer IDs.");
  }
  if (notOwnTransferIds.some(id => !eligibleHintIds.has(id))) {
    throw new Error(
      "not_own_transfer_ids must reference eligible TRANSFER-* or BANK_DETAILS_PAYMENT_RETURN-* rows in this CSV exactly."
    );
  }
  if (notOwnTransferIds.some(id => approvedTransferIds.includes(id))) {
    throw new Error("A Wise ID cannot be in both confirm_own_transfer_ids and not_own_transfer_ids.");
  }

  // Bank accounts and the posting dimensions are read for every run: the Wise
  // dimension itself must be a configured bank account (Step 1 gate below).
  const accountDimensionsSnapshot: AccountDimension[] = await api.readonly.getAccountDimensions();
  const bankAccountsSnapshot: BankAccount[] = await api.readonly.getBankAccounts();
  const { dimensions: bankDimensionIds, identityDimensions } = bankIdentitiesByDimension(bankAccountsSnapshot);
  const postingDimensionsSnapshot = uniqueActivePostingDimensions(accountDimensionsSnapshot);
  const configuredDimensions = new Set(
    [...bankDimensionIds].filter(id => postingDimensionsSnapshot.has(id)),
  );
  // Get existing transactions for duplicate detection
  const existingTx = (await api.transactions.listAll()).filter(isNonVoidTransaction);

  // A Wise dimension that is not a configured bank account (unlinked, deleted,
  // or duplicated) would book every row onto a non-bank account. Same path on
  // dry run and execute, so an old handle executed after unlinking writes nothing.
  if (!isPositiveSafeInteger(accounts_dimensions_id) || !configuredDimensions.has(accounts_dimensions_id)) {
    return { ok: false, failure: { kind: "wise_dimension_not_bank_account" } };
  }

  // Journals are read for every transfer CSV (counterpart evidence, Lane B and
  // the Wise-side holds), and when a confirmed untagged row on the Wise account
  // shares a date with a statement row: its registration journal may prove its
  // direction (wise_untagged_ledger_unique). The snapshot is digest-bound.
  const eligibleDates = new Set(eligible.map(wiseRowDate));
  const untaggedLookalikePossible = existingTx.some(tx =>
    tx.status === "CONFIRMED" && tx.accounts_dimensions_id === accounts_dimensions_id &&
    !tx.description?.startsWith("WISE:") && eligibleDates.has(tx.date));
  const journalSnapshot: Journal[] = hintedRows.length > 0 || untaggedLookalikePossible
    ? await api.journals.listAllWithPostings()
    : [];

  let invoiceInfoSnapshot: Awaited<ReturnType<typeof api.readonly.getInvoiceInfo>> | undefined;
  let autoDetectedInterAccountDimId: number | undefined;
  const otherDimensions = new Set([...configuredDimensions].filter(id => id !== accounts_dimensions_id));
  const bankAccountLookups = buildBankAccountLookups(bankAccountsSnapshot, accountDimensionsSnapshot);
  const transferDecisions = new Map<WiseRow, WiseTransferDecision>();
  if (hintedRows.length > 0) {
    invoiceInfoSnapshot = await api.readonly.getInvoiceInfo();
    const wiseDimensionId = accounts_dimensions_id;
    const otherBankDimensions = [...bankDimensionIds].filter(id => id !== wiseDimensionId);
    autoDetectedInterAccountDimId = otherBankDimensions.length === 1 ? otherBankDimensions[0] : undefined;
    // Each transfer row finds its own counterpart from the other banks'
    // stored transactions; the explicit inter_account_dimension_id (or the
    // only other bank) is a fallback that never overrides evidence. A row
    // without a determinable counterpart is held on its own (counterpartHold).
    const counterparts = resolveWiseRowCounterparts({
      rows: hintedRows,
      allRows: rows,
      wiseDim: wiseDimensionId,
      otherDims: otherDimensions,
      existingTx,
      journals: journalSnapshot,
      lookups: bankAccountLookups,
      companyLegalName: invoiceInfoSnapshot.invoice_company_name ?? undefined,
      explicit: inter_account_dimension_id,
      overrides: counterpartOverrideMap,
    });
    const ownCompanyIdentity = normalizeWiseCompanyName(invoiceInfoSnapshot.invoice_company_name);
    const approvedSet = new Set(approvedTransferIds);
    const notOwnSet = new Set(notOwnTransferIds);

    // No other configured bank account (e.g. a Wise-only company): unchanged
    // from before, the explicit / auto-detected value is classified as given
    // and the row is created unconfirmed with its review.
    const unresolvedTargetDimensionId = inter_account_dimension_id === undefined
      ? autoDetectedInterAccountDimId
      : isPositiveSafeInteger(inter_account_dimension_id)
        ? inter_account_dimension_id
        : undefined;

    for (const row of hintedRows) {
      const resolution = counterparts.get(row);
      const resolvedDim = resolution === undefined
        ? unresolvedTargetDimensionId
        : "dim" in resolution ? resolution.dim : undefined;
      const decision = classifyWiseOwnTransfer(
        row,
        wiseDimensionId,
        resolvedDim,
        configuredDimensions,
        identityDimensions,
        ownCompanyIdentity,
        approvedSet.has(row.id),
      );
      if (resolution !== undefined && "hold" in resolution) {
        transferDecisions.set(row, {
          sourceVerified: decision.sourceVerified,
          targetVerified: decision.targetVerified,
          counterpartHold: wiseCounterpartHoldReview(row, resolution.hold, decision.sourceVerified, decision.targetVerified),
          ...(resolution.hold.selected_by_override === true ? { counterpartOverrideApplied: true as const } : {}),
          // The counterpart hold stays; the owner's decision is reported on
          // its own, unbound to the row (holdRow replaces a row's reviews).
          ...(notOwnSet.has(row.id)
            ? { notOwnConflict: notOwnConflictReview(row, WISE_NOT_OWN_TRANSFER_HELD_REASON, decision) }
            : {}),
        });
        continue;
      }
      // Own-account evidence (or the owner's pick among the evidenced banks)
      // says the row is an own transfer: the owner's not-own decision
      // contradicts it, so the row is held rather than booked either way.
      if (notOwnSet.has(row.id) && resolution !== undefined && (resolution.basis === "evidence" || resolution.basis === "owner_selected")) {
        transferDecisions.set(row, {
          sourceVerified: decision.sourceVerified,
          targetVerified: decision.targetVerified,
          counterpartHold: notOwnConflictReview(row, WISE_NOT_OWN_TRANSFER_EVIDENCE_REASON(resolution.dim), decision),
          ...(resolution.basis === "owner_selected" ? { counterpartOverrideApplied: true as const } : {}),
        });
        continue;
      }
      if (notOwnSet.has(row.id)) {
        transferDecisions.set(row, {
          sourceVerified: decision.sourceVerified,
          targetVerified: decision.targetVerified,
          externalPayment: "owner",
        });
        continue;
      }
      // A transfer whose counterpart is only the fallback (no own-account
      // evidence of any strength) and whose external endpoint is provably not
      // an own account pays a third party: it is imported as an ordinary,
      // unconfirmed row instead of waiting on an ownership review. It stays a
      // transfer candidate, so every Wise-side hold still applies to it.
      if (
        resolution !== undefined &&
        (resolution.basis === "explicit" || resolution.basis === "only_other_bank") &&
        resolution.otherEvidenceDims === undefined &&
        decision.review?.code === "wise_transfer_ownership_unverified" &&
        wiseExternalEndpointIsForeign(row, identityDimensions, ownCompanyIdentity, invoiceInfoSnapshot.invoice_company_name ?? undefined)
      ) {
        transferDecisions.set(row, {
          sourceVerified: decision.sourceVerified,
          targetVerified: decision.targetVerified,
          externalPayment: "automatic",
        });
        continue;
      }
      transferDecisions.set(row, resolution !== undefined
        ? {
            ...decision,
            counterpartBasis: resolution.basis,
            ...(resolution.basis === "owner_selected" ? { counterpartOverrideApplied: true as const } : {}),
          }
        : decision);
    }
  }

  // Resolve the conditional own-company read BEFORE the pure projection so the
  // command build receives every ledger snapshot as data.
  const approvedTransferDecisions = [...transferDecisions.values()].filter(
    decision => decision.ownershipBasis !== undefined,
  );
  let ownCompanyClientMatches: Awaited<ReturnType<typeof api.clients.findByName>> = [];
  if (approvedTransferDecisions.length > 0 && invoiceInfoSnapshot?.invoice_company_name) {
    ownCompanyClientMatches = await api.clients.findByName(invoiceInfoSnapshot.invoice_company_name);
  }
  const ownCompanyClientId = resolveOwnCompanyClientId(
    invoiceInfoSnapshot?.invoice_company_name ?? undefined,
    ownCompanyClientMatches,
  );

  // Rows booked as ordinary payments get their client by the CAMT
  // counterparty-name rule, so they can be confirmed without a manual
  // clients_id (the API refuses a payment with no buyer/supplier). The
  // resolved id joins the create payload and so binds the digest.
  const clientResolutions = new Map<WiseRow, WiseClientResolution>();
  const clientResolutionsByName = new Map<string, WiseClientResolution>();
  const historyCandidates = new Map<WiseRow, number>();
  for (const row of eligible) {
    if (!wiseRowNeedsClientResolution(transferDecisions.get(row))) continue;
    // Only the counterparty endpoint names the client: the recipient of an
    // outgoing row, the sender of an incoming one. A blank one leaves the
    // client unresolved rather than falling back to the own-company endpoint.
    const direction = sourceDirectionForWiseDirection(row.direction);
    const name =
      direction === "OUT" ? row.targetName :
      direction === "IN" ? row.sourceName :
      undefined;
    const normalizedName = normalizeCompanyName(name);
    if (!name || !normalizedName) continue;
    // The lookup is a substring match on the name as written: key the cache
    // on that (as CAMT does), not on the normalized form.
    const cacheKey = name.trim().replace(/\s+/g, " ").toLowerCase();
    let resolution = clientResolutionsByName.get(cacheKey);
    if (resolution === undefined) {
      // Exact normalized name only (owner decision): CAMT's single substring
      // match is not taken here, since a Wise row has no registry code to
      // veto a similar but different client ("Seppo" vs "Indrek Seppo").
      const { selected, match_type, exact_match_count } = selectClientByName(normalizedName, await api.clients.findByName(name));
      resolution = selected?.id !== undefined && match_type === "exact_name"
        ? { clients_id: selected.id, match_type, matched_client_name: selected.name }
        : exact_match_count > 1 ? { ambiguous: true } : {};
      clientResolutionsByName.set(cacheKey, resolution);
    }
    // No exact-name client (and no exact-name ambiguity): an outgoing card row
    // may take the client its earlier confirmed payments to the merchant
    // consistently carry. Per row, never cached by name: it depends on the
    // row's date.
    if (resolution.clients_id === undefined && resolution.ambiguous !== true) {
      const historyClientsId = resolveWiseCardClientFromHistory(row, existingTx, accounts_dimensions_id);
      if (historyClientsId !== undefined) {
        historyCandidates.set(row, historyClientsId);
        continue;
      }
    }
    clientResolutions.set(row, resolution);
  }
  // The historical client must still be live: read the clients fresh (preview
  // and execute alike) and leave a missing, deleted or deactivated one unset.
  // The resulting clients_id joins the create payload and so the digest: a
  // client deactivated after review drops it at execute, which is plan drift.
  if (historyCandidates.size > 0) {
    api.clients.invalidateListCache();
    const currentClients = await api.clients.listAll();
    for (const [row, clientsId] of historyCandidates) {
      const client = currentClients.find(candidate => candidate.id === clientsId);
      const live = client !== undefined && client.is_deleted !== true && client.is_active !== false && !client.deactivated_date;
      clientResolutions.set(row, live ? { clients_id: clientsId, match_type: "confirmed_history", matched_client_name: client.name } : {});
    }
  }

  const paymentRows = eligible.filter(r => sourceDirectionForWiseDirection(r.direction) === "OUT" && bookedAmountForWiseRow(r) > 0);
  const purchaseInvoicesApi = api.purchaseInvoices;
  const hasPaymentCandidates = paymentRows.length > 0 && purchaseInvoicesApi !== undefined;
  const allPurchaseInvoices = hasPaymentCandidates ? await purchaseInvoicesApi.listAll() : [];

  const projectionInput = {
    eligible,
    allRows: rows,
    accountsDimensionsId: accounts_dimensions_id,
    accountDimensions: accountDimensionsSnapshot,
    feeAccountDimensionsId: undefined as number | undefined,
    wiseClientId: undefined as number | undefined,
    existingTx,
    transferDecisions,
    postingDimensionsSnapshot,
    bankDimensionIds,
    journalSnapshot,
    createInterAccountGuard: (ownDimensionIds: Set<number>) =>
      BookingGuard.fromSnapshot(api, journalSnapshot, ownDimensionIds),
    approvedTransferIds: new Set(approvedTransferIds),
    journalizedTransferIds: journalized_transfer_ids,
    acknowledgedJournalHolds: canonicalAcknowledgements,
    counterpartOverrides: canonicalOverrides,
    ownCompanyClientId,
    allPurchaseInvoices,
    clientResolutions,
  };
  let projected = projectWiseCommands(projectionInput);

  // Fee dimension and Wise client are resolved only when a fee row survives
  // dedup, so a fully imported re-run never needs (or fails on) them.
  let feeAccountDimensionsId: number | undefined;
  let allClientsSnapshot: Awaited<ReturnType<typeof api.clients.listAll>> = [];
  if (projected.feeResolutionRequired) {
    feeAccountDimensionsId = resolveWiseFeeAccountDimensionId(accountDimensionsSnapshot, fee_account_dimensions_id, fee_account_relation_id);
    allClientsSnapshot = await api.clients.listAll();
    const wiseClient = allClientsSnapshot.find(c => isWiseClientName(c.name));
    // Without a Wise client the fee rows can be created but never confirmed;
    // refuse the whole import up-front instead of leaving stray PROJECT rows.
    if (!wiseClient?.id) {
      return { ok: false, failure: { kind: "wise_client_not_found" } };
    }
    projected = projectWiseCommands({ ...projectionInput, feeAccountDimensionsId, wiseClientId: wiseClient.id });
  }
  const commands = projected.commands;
  const created = projected.created;
  const skipped = projected.skipped;
  const ownershipReviews = projected.ownershipReviews;
  const invoiceFixCandidates = projected.invoiceFixCandidates;
  const alreadyJournalized = projected.alreadyJournalized;
  // Rows held because their counterpart is unresolved or contradicted. Info
  // only: the other rows proceed (no whole-plan block).
  const counterpartHoldReviews = ownershipReviews.filter(review => review.counterpart_candidate_dimension_ids !== undefined);

  const canonicalPlanningArgs = {
    source_identity: inputSnapshot.identity,
    accounts_dimensions_id,
    fee_account_dimensions_id,
    fee_account_relation_id,
    resolved_fee_account_dimensions_id: feeAccountDimensionsId,
    inter_account_dimension_id,
    resolved_inter_account_dimension_id: inter_account_dimension_id ?? autoDetectedInterAccountDimId,
    confirm_own_transfer_ids: [...approvedTransferIds].sort(),
    // The owner's not-own decision changes how rows are presented and held,
    // so it binds the digest and the plan scope. Omitted when empty, keeping
    // earlier plans byte-identical.
    ...(notOwnTransferIds.length > 0 ? { not_own_transfer_ids: [...notOwnTransferIds].sort() } : {}),
    // The mapping changes which rows are created, so it binds the digest and
    // the plan scope. Omitted when empty, keeping earlier plans byte-identical.
    ...(journalized_transfer_ids !== undefined && journalized_transfer_ids.length > 0
      ? {
          journalized_transfer_ids: journalized_transfer_ids
            .map(({ wise_id, journal_id }) => ({ wise_id, journal_id }))
            .sort((left, right) => left.wise_id < right.wise_id ? -1 : left.wise_id > right.wise_id ? 1 : left.journal_id - right.journal_id),
        }
      : {}),
    // Acknowledgements release held rows, so they bind the digest and the plan
    // scope too. Omitted when empty, keeping earlier plans byte-identical.
    ...(canonicalAcknowledgements.length > 0 ? { acknowledged_journal_holds: canonicalAcknowledgements } : {}),
    // An override decides a row's counterpart: it binds the digest and the
    // plan scope. Omitted when empty, keeping earlier plans byte-identical.
    ...(canonicalOverrides.length > 0 ? { counterpart_overrides: canonicalOverrides } : {}),
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
        already_journalized: alreadyJournalized.map(assertion => ({
          wise_id: assertion.wise_id,
          row_key: assertion.row_key,
          existing_journal_id: assertion.existing_journal_id,
          current_journal_state: assertion.current_journal_state,
        })),
        current_state: {
          transactions: existingTx,
          account_dimensions: accountDimensionsSnapshot,
          bank_accounts: bankAccountsSnapshot,
          invoice_info: invoiceInfoSnapshot,
          clients: allClientsSnapshot,
          own_company_client_matches: ownCompanyClientMatches,
          journals: journalSnapshot,
        },
      })
    : undefined;

  // The enumerated set of ownership-transfer rows that REQUIRE explicit operator
  // approval, in the exact order the preview presents them (eligible/hinted
  // order). A row is in the set whether or not it was approved this run.
  const unverifiedOwnershipIds = hintedRows
    .filter(row => {
      const decision = transferDecisions.get(row);
      return decision !== undefined &&
        (decision.ownershipBasis === "operator_approved" ||
          decision.review?.code === "wise_transfer_ownership_unverified");
    })
    .map(row => row.id);

  // DRY RUN: issue an immutable server plan the operator reviews.
  let planHandle: string | undefined;
  if (!executeRequested && mintPlanHandle && commands.length > 0 && approvedCommandDigest !== undefined) {
    const planInput: ExecutionPlanInput = {
      normalizedArgs: stripUndefinedDeep(canonicalPlanningArgs) as PlanRecord,
      sourceIdentities: [stripUndefinedDeep({ ...inputSnapshot.identity }) as PlanRecord],
      liveSnapshot: stripUndefinedDeep({ connection_fingerprint: api.transactions.connectionFingerprint }),
      commands: commands.map((command, index) => ({
        id: wisePlanCommandId(index),
        category: WISE_PLAN_COMMAND_CATEGORY[command.action],
        reviewProjection: wisePlanReviewProjection(command),
      })),
      counts: {
        total_csv_rows: rows.length,
        eligible: eligible.length,
        filtered_out: rows.length - eligible.length,
        would_create: created.length,
        command_count: commands.length,
        already_journalized: alreadyJournalized.length,
        needs_review: ownershipReviews.length,
        invoice_currency_fixes: invoiceFixCandidates.length,
      },
      totals: {
        command_count: commands.length,
        inter_account_commands: commands.filter(command => command.action === "inter_account").length,
        fee_commands: commands.filter(command => command.action === "fee_create_and_confirm").length,
      },
      exclusions: skipped.map(entry => stripUndefinedDeep({ wise_id: entry.wise_id, reason: entry.reason })),
      reviews: ownershipReviews.map(review => stripUndefinedDeep({ ...review })),
      privatePayload: {
        digest: approvedCommandDigest,
        approved_transfer_ids: [...approvedTransferIds],
        unverified_ownership_ids: [...unverifiedOwnershipIds],
        normalized_args: canonicalPlanJson(canonicalPlanningArgs),
      },
    };
    planHandle = runtimeSafetyContext.planStore.issue(WISE_PLAN_DOMAIN, planInput);
  }

  // EXECUTE gates (zero mutations on any failure), before the mutation loop.
  // Ownership re-preview is checked first so a mismatched approval yields a
  // clear ownership signal rather than a generic digest mismatch.
  if (executeRequested && storedWisePlan) {
    const storedPrivate = isRecord(storedWisePlan.privatePayload) ? storedWisePlan.privatePayload : undefined;
    const storedApprovedIds = Array.isArray(storedPrivate?.approved_transfer_ids)
      ? (storedPrivate!.approved_transfer_ids as PlanData[]).filter((value): value is string => typeof value === "string")
      : undefined;
    if (!storedApprovedIds || !orderedIdsEqual(approvedTransferIds, storedApprovedIds)) {
      return { ok: false, failure: { kind: "ownership_reapproval_required" } };
    }
    try {
      assertFileInputSnapshotIdentity(inputSnapshot, storedWisePlan.sourceIdentities[0], {
        allowedExtensions: [".csv"],
        maxSize: WISE_MAX_FILE_SIZE,
      });
    } catch (error) {
      if (!(error instanceof FileInputSnapshotError)) throw error;
      return {
        ok: false,
        failure: {
          kind: "plan_drift",
          detail: error.code === "file_input_changed"
            ? "the Wise source file (bytes or location) changed since the plan was reviewed"
            : "the reviewed Wise plan's source identity is invalid",
        },
      };
    }
    if (canonicalPlanJson(storedWisePlan.normalizedArgs) !== canonicalPlanJson(canonicalPlanningArgs)) {
      return { ok: false, failure: { kind: "plan_drift", detail: "the import arguments changed since the plan was reviewed" } };
    }
    const storedDigest = storedPrivate?.digest;
    if (typeof storedDigest !== "string" || storedDigest !== approvedCommandDigest) {
      return { ok: false, failure: { kind: "plan_drift", detail: "the reviewed command plan no longer matches the current ledger and source" } };
    }
    if (canonicalPlanJson(storedPrivate?.unverified_ownership_ids ?? null) !== canonicalPlanJson([...unverifiedOwnershipIds])) {
      return { ok: false, failure: { kind: "plan_drift", detail: "the set of unverified ownership transfers changed since the plan was reviewed" } };
    }
  }

  if (executeRequested && (
    approvedCommandDigest === undefined || approved_command_digest !== approvedCommandDigest
  )) {
    return { ok: false, failure: { kind: "digest_mismatch" } };
  }
  if (!executeRequested && approved_command_digest !== undefined && approvedCommandDigest === undefined) {
    return { ok: false, failure: { kind: "digest_mismatch" } };
  }

  // Throttled: only the first in-window notification of a tight loop is ever
  // emitted, so one call reports the same progress.
  await reportProgress(0, eligible.length);

  const interAccountResults: WiseInterAccountResult[] = [];

  if (executeRequested) {
    const releaseExecutionLock = await acquireWiseExecutionLock(api.transactions.connectionFingerprint);
    try {
      created.splice(0, created.length);
      const runtimeIds = new Map<string, number>();
      const successfulCommands = new Set<string>();
      let stoppedIndeterminate = false;
      // Per-transfer-leg Wise-side guard: immediately before each write of a
      // transfer row (main create, fee create, fee confirm, inter-account
      // confirm) the journals are read again and the plan's identity and
      // evidence checks re-run. Every write reads fresh: the execution lock is
      // per process, so another process may write between two legs. Exempt:
      // the leg's proven coverage, this run's own registration journals, and
      // journals unchanged since the reviewed snapshot (so execute is never
      // stricter than the preview, and an acknowledgement holds only while its
      // journals are unchanged). A block or a failed read skips the rest of
      // that row; other rows proceed. Card rows are not transfer rows: they
      // never re-read journals.
      const holdCheckByRow = new Map(projected.holdCheckRows.map(check => [check.row_index, check]));
      const rowsByIndex = new Map(eligible.map(row => [row.rowIndex, row]));
      const wiseLabels = knownWiseLabelsFor(rows, existingTx);
      const snapshotJournals = new Map(journalSnapshot.filter(journal => journal.id !== undefined).map(journal => [journal.id!, journal]));
      const blockedRows = new Set<number>();
      const wiseSideBlock = (command: WiseImportCommand, legKind: "main" | "fee", freshJournals: Journal[]): string | undefined => {
        const check = holdCheckByRow.get(command.row_index);
        const leg = check?.legs[legKind];
        const row = rowsByIndex.get(command.row_index);
        if (check === undefined || leg === undefined || row === undefined) return undefined;
        const createdHere = new Set(runtimeIds.values());
        const exempt = (journal: Journal | undefined, coverage: ReadonlySet<number>) => journal?.id !== undefined && (
          coverage.has(journal.id) ||
          (journal.operation_type === "TRANSACTION" && journal.operations_id !== undefined && createdHere.has(journal.operations_id)) ||
          exactStateMatches(journal, snapshotJournals.get(journal.id)));
        const rowCoverage = new Set([...(check.legs.main?.coverage ?? []), ...(check.legs.fee?.coverage ?? [])]);
        const identityIds = freshJournals
          .filter(journal => journal.id !== undefined && !journal.is_deleted && journalLabelledWithWiseId(journal, row.id) && !exempt(journal, rowCoverage))
          .map(journal => journal.id!);
        if (identityIds.length > 0) {
          return `journal ${identityIds.sort((left, right) => left - right).join(", ")} labelled with this Wise transfer appeared or changed before the ${legKind} leg was written`;
        }
        const evidence = wiseLegEvidence(buildWiseSideJournalIndex(freshJournals, command.wise_dimension_id), leg.leg,
          journal => labelledWithOtherWiseId(journal, row, wiseLabels));
        const byId = new Map(freshJournals.map(journal => [journal.id, journal]));
        const legCoverage = new Set(leg.coverage);
        const blocking = sortedUniqueIds(evidence.certain, evidence.uncertain)
          .filter(id => !exempt(byId.get(id), legCoverage));
        return blocking.length > 0
          ? `journal ${blocking.join(", ")} on the Wise account may already book this transfer's ${legKind} leg (appeared or changed since the reviewed plan)`
          : undefined;
      };
      // The row's counterpart, resolved again from the fresh ledger, must
      // still be the one the plan confirms against.
      const counterpartDrift = (row: WiseRow, command: InterAccountCommand, freshTransactions: Transaction[], freshJournals: Journal[]): string | undefined => {
        if (otherDimensions.size === 0) return undefined;
        const resolution = resolveWiseRowCounterparts({
          rows: [row],
          allRows: rows,
          wiseDim: command.wise_dimension_id,
          otherDims: otherDimensions,
          existingTx: freshTransactions.filter(isNonVoidTransaction),
          journals: freshJournals,
          lookups: bankAccountLookups,
          companyLegalName: invoiceInfoSnapshot?.invoice_company_name ?? undefined,
          explicit: inter_account_dimension_id,
          overrides: counterpartOverrideMap,
        }).get(row);
        const resolved = resolution === undefined ? undefined : "dim" in resolution ? resolution.dim : undefined;
        return resolved === command.counterpart_dimension_id
          ? undefined
          : `Stale counterpart precondition: the transfer's counterpart bank account is no longer ${command.counterpart_dimension_id} (${resolution !== undefined && "hold" in resolution ? resolution.hold.code : "changed"})`;
      };
      // Reads the journals and runs the guard for one leg; a failed read skips
      // the row. Before the main create of a row the plan confirms against
      // another bank, the counterpart is re-resolved too (on the same fresh
      // read), so a changed counterpart writes nothing for the row.
      const guardWiseLeg = async (command: WiseImportCommand, legKind: "main" | "fee", freshTransactions: Transaction[]): Promise<void> => {
        const interAccount = legKind === "main"
          ? commands.find((candidate): candidate is InterAccountCommand =>
            candidate.action === "inter_account" && candidate.row_index === command.row_index)
          : undefined;
        if (holdCheckByRow.get(command.row_index)?.legs[legKind] === undefined && interAccount === undefined) return;
        let freshJournals: Journal[];
        try {
          clearRuntimeCaches();
          freshJournals = await api.journals.listAllWithPostings();
        } catch (error) {
          blockedRows.add(command.row_index);
          throw new Error(`Wise-side journal re-check failed before the ${legKind} leg was written: ${error instanceof Error ? error.message : String(error)}`);
        }
        const block = wiseSideBlock(command, legKind, freshJournals);
        if (block !== undefined) {
          blockedRows.add(command.row_index);
          throw new Error(`Stale Wise-side precondition: ${block}`);
        }
        const row = rowsByIndex.get(command.row_index);
        const drift = interAccount === undefined || row === undefined
          ? undefined
          : counterpartDrift(row, interAccount, freshTransactions, freshJournals);
        if (drift !== undefined) {
          blockedRows.add(command.row_index);
          throw new Error(drift);
        }
      };
      // A client taken from confirmed history must still be the one that
      // history and the live client list give, on the same fresh read as the
      // create: a payment confirmed or a client deactivated after the execute
      // projection stops the row before anything is written.
      const guardHistoryClient = async (command: MainCreateCommand, freshTransactions: Transaction[]): Promise<void> => {
        const row = rowsByIndex.get(command.row_index);
        if (row === undefined || clientResolutions.get(row)?.match_type !== "confirmed_history") return;
        const approved = command.create_payload.clients_id;
        const resolved = resolveWiseCardClientFromHistory(row, freshTransactions.filter(isNonVoidTransaction), accounts_dimensions_id);
        let live = false;
        if (resolved !== undefined && resolved === approved) {
          api.clients.invalidateListCache();
          const client = (await api.clients.listAll()).find(candidate => candidate.id === resolved);
          live = client !== undefined && client.is_deleted !== true && client.is_active !== false && !client.deactivated_date;
        }
        if (resolved !== approved || !live) {
          blockedRows.add(command.row_index);
          throw new Error(`Stale client precondition: the client from earlier payments to this merchant is no longer ${String(approved)} or is no longer active`);
        }
      };
      // Creates one main or fee leg, guarded in this order: fresh transactions,
      // the identity re-check, for a main leg the history-client re-check, the
      // Wise-side (and, for a main leg, the counterpart) guard, then the
      // create; returns the created id.
      const createLeg = async (command: MainCreateCommand | FeeCreateCommand, legKind: "main" | "fee"): Promise<number> => {
        clearRuntimeCaches();
        const freshTransactions = await api.transactions.listAll();
        if (transactionCommandExists(command, freshTransactions)) {
          throw new Error("Stale transaction precondition: an equivalent Wise transaction appeared before create");
        }
        if (command.action === "main_create") await guardHistoryClient(command, freshTransactions);
        await guardWiseLeg(command, legKind, freshTransactions);
        const result = await createBankTransaction(api, command.create_payload, command.source_direction === "IN" ? "incoming" : "outgoing");
        const apiId = result.created_object_id;
        if (apiId === undefined) throw new Error(`Wise ${legKind === "main" ? "transaction" : "fee"} creation returned no object ID`);
        runtimeIds.set(command.row_key, apiId);
        return apiId;
      };
      const createdEntryFor = (command: MainCreateCommand | FeeCreateCommand, apiId: number, status: string): WiseCreatedEntry => ({
        wise_id: command.wise_id,
        date: command.date,
        type: command.transaction_type,
        source_direction: command.source_direction,
        amount: command.booked_amount,
        description: command.create_payload.description ?? "",
        status,
        api_id: apiId,
      });
      for (const command of commands) {
      if (command.depends_on && !successfulCommands.has(command.depends_on)) {
        skipped.push({
          wise_id: command.wise_id,
          reason: "Skipped because main transaction was not created",
          kind: "dependency",
        });
        continue;
      }
      if (blockedRows.has(command.row_index)) {
        skipped.push({
          wise_id: command.wise_id,
          reason: "Skipped because an earlier Wise-side check of this transfer failed",
          kind: "error",
        });
        continue;
      }
      try {
        if (command.action === "main_create") {
          const apiId = await createLeg(command, "main");
          successfulCommands.add(command.row_key);
          logAudit({
            tool: "import_wise_transactions", action: "IMPORTED", entity_type: "transaction",
            entity_id: apiId,
            summary: `Imported Wise transaction ${command.booked_amount} ${command.booked_currency} on ${command.date}`,
            details: {
              date: command.date,
              amount: command.booked_amount,
              type: command.source_direction === "IN" ? "D" : "C",
              source_direction: command.source_direction,
              wise_id: command.wise_id,
              approved_command_digest: approvedCommandDigest,
              command_version: WISE_COMMAND_VERSION,
            },
          });
          const sourceRow = rowsByIndex.get(command.row_index);
          const clientsId = command.create_payload.clients_id;
          created.push({
            ...createdEntryFor(command, apiId, "created"),
            source_row: sourceRow,
            ...(clientsId !== undefined && clientsId !== null
              ? { clients_id: clientsId }
              : sourceRow !== undefined && clientResolutions.get(sourceRow)?.ambiguous === true ? { client_ambiguous: true as const } : {}),
          });
          continue;
        }

        if (command.action === "fee_create_and_confirm") {
          const apiId = await createLeg(command, "fee");
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
            await guardWiseLeg(command, "fee", freshTransactions);
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
              ...createdEntryFor(command, apiId, "created_and_confirmed"),
              // Fee rows carry no source_row, so this is the only way the
              // presenter can tell what currency the row was booked in.
              booked_currency: command.booked_currency,
            });
          } catch (error) {
            if (isMutationIndeterminate(error)) throw error;
            const errorMessage = error instanceof Error ? error.message : String(error);
            skipped.push({
              wise_id: command.wise_id,
              reason: `Fee confirmation failed: ${errorMessage}`,
              kind: "error",
            });
            created.push({
              ...createdEntryFor(command, apiId, `created (confirm failed: ${wrapUntrustedOcr(errorMessage)})`),
              booked_currency: command.booked_currency,
            });
          }
          continue;
        }

        if (command.action === "inter_account") {
          const apiId = command.depends_on ? runtimeIds.get(command.depends_on) : undefined;
          if (apiId === undefined) throw new Error("Inter-account command dependency returned no transaction ID");
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
            // Same Lane B resolution as the plan (±1 day, labelled journals
            // identity-only), minus the registration journals this run's own
            // confirmations created (operations_id = a transaction created here).
            const createdHere = new Set(runtimeIds.values());
            const priorJournals = freshJournals.filter(journal =>
              !(journal.operation_type === "TRANSACTION" && journal.operations_id !== undefined && createdHere.has(journal.operations_id))
            );
            // Journals the owner acknowledged as not this transfer
            // (acknowledged_journal_holds) are exempt only while unchanged
            // since the reviewed snapshot; the exact-label check below never is.
            const acknowledgedIds = new Set(holdCheckByRow.get(command.row_index)?.acknowledged_ids ?? []);
            const pairJournals = priorJournals.filter(journal => !(journal.id !== undefined && acknowledgedIds.has(journal.id) &&
              exactStateMatches(journal, snapshotJournals.get(journal.id))));
            const freshGuard = BookingGuard.fromSnapshot(
              api,
              pairJournals,
              new Set([command.wise_dimension_id, command.counterpart_dimension_id]),
            );
            const journalQuery = {
              sourceDim: command.wise_dimension_id,
              targetDim: command.counterpart_dimension_id,
              amount: command.booked_amount,
              date: command.date,
              maxGapDays: 1,
              reference: command.wise_id,
            };
            const sourceRow = rowsByIndex.get(command.row_index);
            // The booked amount and, with a same-currency fee, the net of it.
            const journalQueries = (sourceRow === undefined ? [command.booked_amount] : wiseRowAmounts(sourceRow))
              .map(amount => ({ ...journalQuery, amount }));
            if (journalQueries.some(query =>
              freshGuard.resolveInterAccount(query, { consume: false }).status !== "none" ||
              freshGuard.hasOtherLabelledInterAccount(query)
            )) {
              throw new Error("Stale inter-account precondition: a matching journal appeared before confirmation");
            }
            // As in the plan: a journal labelled with this Wise ID is this
            // transfer's identity whatever amount it books.
            if (priorJournals.some(journal => !journal.is_deleted && journalLabelledWithWiseId(journal, command.wise_id))) {
              throw new Error("Stale inter-account precondition: a journal labelled with this Wise transfer appeared before confirmation");
            }
            // The full Wise-side guard on the main leg, beyond the pair.
            const wiseSide = wiseSideBlock(command, "main", freshJournals);
            if (wiseSide !== undefined) throw new Error(`Stale Wise-side precondition: ${wiseSide}`);
            // Checked again at the confirm (first before the main create).
            const drift = sourceRow === undefined ? undefined : counterpartDrift(sourceRow, command, freshTransactions, freshJournals);
            if (drift !== undefined) throw new Error(drift);
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
            if (isMutationIndeterminate(error)) throw error;
            const errorMessage = error instanceof Error ? error.message : String(error);
            skipped.push({
              wise_id: command.wise_id,
              reason: `Inter-account confirmation failed: ${errorMessage}`,
              kind: "error",
            });
            interAccountResults.push({
              api_id: apiId,
              wise_id: command.wise_id,
              amount: command.booked_amount,
              status: `confirm_failed: ${wrapUntrustedOcr(errorMessage)}`,
              ownership_basis: command.ownership_basis,
              orphan_project_transaction_id: apiId,
              orphan_action_hint: `Transaction ${apiId} was created but left in PROJECT status. Rerunning the import will skip it via wise_id dedup. To retry confirmation: invalidate_transaction(${apiId}), then delete_transaction(${apiId}) and rerun — or confirm_transaction(${apiId}) manually against the target bank account.`,
            });
          }
          continue;
        }

      } catch (err) {
        if (isMutationIndeterminate(err)) {
          // The write may or may not have committed. Reporting it as a plain
          // skip/failure would invite a re-run that double-books, and carrying
          // on would build later commands on an unknown state — so stop here,
          // like the CAMT importer, and name every command left unattempted.
          skipped.push({
            wise_id: command.wise_id,
            reason: `Outcome unknown (${command.action}): the API call for Wise row ${command.wise_id} may or may not have been applied. ` +
              "Import stopped; verify with list_transactions / list_journals before re-running.",
            kind: "error",
          });
          for (const remaining of commands.slice(commands.indexOf(command) + 1)) {
            skipped.push({
              wise_id: remaining.wise_id,
              reason: "Not attempted: import stopped after an indeterminate mutation",
              kind: "error",
            });
          }
          stoppedIndeterminate = true;
          break;
        }
        skipped.push({
          wise_id: command.wise_id,
          reason: err instanceof Error ? err.message : String(err),
          kind: "error",
        });
      }
    }
      // Already-journalized rows: no write depends on them, so their journals
      // are re-checked once, after every write and still inside the lock. This
      // check only reports; it never throws after writes.
      if (alreadyJournalized.length > 0) {
        if (stoppedIndeterminate) {
          for (const assertion of alreadyJournalized) {
            skipped.push({
              wise_id: assertion.wise_id,
              reason: "Not attempted: import stopped after an indeterminate mutation",
              kind: "error",
            });
          }
        } else {
          let freshJournals: Journal[] | undefined;
          let readError: string | undefined;
          try {
            clearRuntimeCaches();
            freshJournals = await api.journals.listAllWithPostings();
          } catch (error) {
            readError = error instanceof Error ? error.message : String(error);
          }
          for (const assertion of alreadyJournalized) {
            if (freshJournals === undefined) {
              skipped.push({
                wise_id: assertion.wise_id,
                reason: `Already-journalized re-check failed: journal ${assertion.existing_journal_id} could not be read (${readError})`,
                kind: "error",
              });
              continue;
            }
            const expectedJournal = freshJournals.find(journal => journal.id === assertion.existing_journal_id);
            if (!expectedJournal || !exactStateMatches(expectedJournal, assertion.current_journal_state)) {
              const reason = `Stale already-journalized precondition: expected journal ${assertion.existing_journal_id} changed before acceptance`;
              skipped.push({ wise_id: assertion.wise_id, reason, kind: "error" });
              interAccountResults.push({
                wise_id: assertion.wise_id,
                amount: assertion.booked_amount,
                status: `precondition_failed: ${reason}`,
                ...(assertion.ownership_basis !== undefined ? { ownership_basis: assertion.ownership_basis } : {}),
              });
              continue;
            }
            interAccountResults.push({
              wise_id: assertion.wise_id,
              amount: assertion.booked_amount,
              status: "already_journalized",
              ...(assertion.ownership_basis !== undefined ? { ownership_basis: assertion.ownership_basis } : {}),
              journal_id: assertion.existing_journal_id,
            });
          }
        }
      }
    } finally {
      releaseExecutionLock();
    }
  }

  const mode = executeRequested ? "EXECUTED" : "DRY_RUN";
  const data: WiseImportRenderData = {
    mode,
    executeRequested,
    source,
    sourceIdentity: inputSnapshot.identity,
    accountsDimensionsId: accounts_dimensions_id,
    totalCsvRows: rows.length,
    eligibleCount: eligible.length,
    skippedJarCount,
    skippedJarRows,
    created,
    skipped,
    commands,
    alreadyJournalized,
    approvedCommandDigest,
    planHandle,
    autoDetectedInterAccountDimId,
    hasHintedRows: hintedRows.length > 0,
    interAccountResults,
    ownershipReviews,
    invoiceFixCandidates,
    ...(projected.acknowledgedHolds.length > 0 ? { acknowledgedHolds: projected.acknowledgedHolds } : {}),
    ...(projected.transfersTreatedAsPayments.length > 0 ? { transfersTreatedAsPayments: projected.transfersTreatedAsPayments } : {}),
    ...(counterpartHoldReviews.length > 0
      ? (() => {
          const labels = new Map(buildBankDimensionCandidates(bankAccountsSnapshot, accountDimensionsSnapshot)
            .map(candidate => [candidate.accounts_dimensions_id, candidate.label]));
          return {
            transferCounterpart: {
              unresolved_row_count: counterpartHoldReviews.filter(review => review.code === "wise_transfer_dimensions_unverified").length,
              conflict_row_count: counterpartHoldReviews.filter(review => review.code === "wise_transfer_counterpart_conflict").length,
              candidates: sortedUniqueIds(otherDimensions).map(id => ({
                accounts_dimensions_id: id,
                label: labels.get(id) ?? `Dimension ${id}`,
              })),
            },
          };
        })()
      : {}),
    args: {
      feeAccountDimensionsId: fee_account_dimensions_id,
      feeAccountRelationId: fee_account_relation_id,
      interAccountDimensionId: inter_account_dimension_id,
      confirmOwnTransferIds: confirm_own_transfer_ids,
      ...(not_own_transfer_ids !== undefined ? { notOwnTransferIds: not_own_transfer_ids } : {}),
      journalizedTransferIds: journalized_transfer_ids,
      acknowledgedJournalHolds: acknowledged_journal_holds,
      counterpartOverrides: counterpart_overrides,
      dateFrom: date_from,
      dateTo: date_to,
      skipJarTransfers: skip_jar_transfers,
    },
  };
  return { ok: true, data };
}

export async function prepareWiseImport(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: WisePrepareRunInput,
): Promise<WiseRunResult> {
  return runWiseImport(api, runtimeSafetyContext, input, false, undefined, input.mintPlanHandle !== false);
}

export async function executeWiseImport(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: WiseRunInput,
  planHandle: string | undefined,
): Promise<WiseRunResult> {
  // Layered execute gate: BOTH a live server plan handle AND the M04 digest are
  // required. A digest without a handle cannot execute — checked before any file
  // read, ledger read, cache flush, or mutation. The handle is CONSUMED on every
  // execute attempt (burn-before-validate): a replayed or drifted execute burns
  // it, forcing a fresh reviewed dry run.
  if (typeof planHandle !== "string" || planHandle.length === 0) {
    return { ok: false, failure: { kind: "plan_handle_required" } };
  }
  let storedWisePlan: StoredExecutionPlan;
  try {
    storedWisePlan = runtimeSafetyContext.planStore.consume(planHandle, WISE_PLAN_DOMAIN);
  } catch (error) {
    if (error instanceof PlanStoreError) return { ok: false, failure: { kind: "plan_store_error", code: error.code, message: error.message } };
    throw error;
  }
  return runWiseImport(api, runtimeSafetyContext, input, true, storedWisePlan);
}
