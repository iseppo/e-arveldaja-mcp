import { createHash } from "node:crypto";
import type { AccountDimension, BankAccount, Journal } from "../types/api.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import {
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
import { roundMoney } from "../money.js";
import { createBankTransaction } from "../bank-transaction-create.js";
import { buildInterAccountJournalIndex, findMatchingJournal } from "../tools/inter-account-utils.js";
import {
  bankIdentitiesByDimension,
  bookedAmountForWiseRow,
  bookedCurrencyForWiseRow,
  bookedFeeAmountForWiseRow,
  classifyWiseOwnTransfer,
  isJarTransfer,
  isPositiveSafeInteger,
  isWiseTransferCandidate,
  normalizeWiseCompanyName,
  normalizeWiseDirection,
  preflightWiseCsv,
  resolveOwnCompanyClientId,
  resolveWiseFeeAccountDimensionId,
  sourceDirectionForWiseDirection,
  uniqueActivePostingDimensions,
  validateWiseDateRange,
  wiseDate,
} from "./preflight.js";
import {
  approvalDigest,
  canonicalPlanJson,
  createdTransactionMatchesApprovedPayload,
  exactStateMatches,
  orderedIdsEqual,
  projectWiseCommands,
  transactionCommandExists,
  wisePlanCommandId,
  wisePlanReviewProjection,
  WISE_APPROVAL_DOMAIN,
  WISE_COMMAND_VERSION,
  WISE_PLAN_COMMAND_CATEGORY,
  WISE_PLAN_DOMAIN,
} from "./projection.js";
import type {
  ImportRejectedField,
  MainCreateCommand,
  WiseImportCommand,
  WiseInterAccountResult,
  WiseRow,
  WiseTransferDecision,
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
  | { kind: "wise_client_not_found" };

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

export interface WiseRunInput {
  readonly source: FileInputSource;
  readonly accountsDimensionsId: number;
  readonly feeAccountDimensionsId: number | undefined;
  readonly feeAccountRelationId: number | undefined;
  readonly interAccountDimensionId: number | undefined;
  readonly confirmOwnTransferIds: string[] | undefined;
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
): Promise<WiseRunResult> {
  const {
    source,
    accountsDimensionsId: accounts_dimensions_id,
    feeAccountDimensionsId: fee_account_dimensions_id,
    feeAccountRelationId: fee_account_relation_id,
    interAccountDimensionId: inter_account_dimension_id,
    confirmOwnTransferIds: confirm_own_transfer_ids,
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
  const feeAccountDimensionsId = hasFeeRows
    ? resolveWiseFeeAccountDimensionId(accountDimensionsSnapshot, fee_account_dimensions_id, fee_account_relation_id)
    : undefined;

  // Find Wise client for fee transactions
  let wiseClientId: number | undefined;
  let allClientsSnapshot: Awaited<ReturnType<typeof api.clients.listAll>> = [];
  if (hasFeeRows) {
    allClientsSnapshot = await api.clients.listAll();
    const wiseClient = allClientsSnapshot.find(c =>
      c.name?.toUpperCase() === "WISE" || c.name?.toUpperCase() === "TRANSFERWISE"
    );
    wiseClientId = wiseClient?.id;
    // Without a Wise client the fee rows can be created but never confirmed;
    // refuse the whole import up-front instead of leaving stray PROJECT rows.
    if (!wiseClientId) {
      return { ok: false, failure: { kind: "wise_client_not_found" } };
    }
  }

  // Get existing transactions for duplicate detection
  const existingTx = (await api.transactions.listAll()).filter(isNonVoidTransaction);

  // Resolve the conditional journal / own-company reads BEFORE the pure
  // projection so the command build receives every ledger snapshot as data.
  const approvedTransferDecisions = [...transferDecisions.values()].filter(
    decision => decision.ownershipBasis !== undefined,
  );
  const journalSnapshot: Journal[] = approvedTransferDecisions.length > 0
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

  const paymentRows = eligible.filter(r => sourceDirectionForWiseDirection(r.direction) === "OUT" && bookedAmountForWiseRow(r) > 0);
  const purchaseInvoicesApi = api.purchaseInvoices;
  const hasPaymentCandidates = paymentRows.length > 0 && purchaseInvoicesApi !== undefined;
  const allPurchaseInvoices = hasPaymentCandidates ? await purchaseInvoicesApi.listAll() : [];

  const projected = projectWiseCommands({
    eligible,
    accountsDimensionsId: accounts_dimensions_id,
    accountDimensions: accountDimensionsSnapshot,
    feeAccountDimensionsId,
    wiseClientId,
    existingTx,
    transferDecisions,
    postingDimensionsSnapshot,
    journalSnapshot,
    ownCompanyClientId,
    ownCompanyClientMatches,
    allPurchaseInvoices,
  });
  const commands = projected.commands;
  const created = projected.created;
  const skipped = projected.skipped;
  const ownershipReviews = projected.ownershipReviews;
  const invoiceFixCandidates = projected.invoiceFixCandidates;

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
  if (!executeRequested && commands.length > 0 && approvedCommandDigest !== undefined) {
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
        needs_review: ownershipReviews.length,
        invoice_currency_fixes: invoiceFixCandidates.length,
      },
      totals: {
        command_count: commands.length,
        inter_account_commands: commands.filter(command => command.action === "inter_account").length,
        fee_commands: commands.filter(command => command.action === "fee_create_and_confirm").length,
        purchase_invoice_updates: commands.filter(command => command.action === "purchase_invoice_update").length,
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
    const storedIdentity = storedWisePlan.sourceIdentities[0];
    if (!storedIdentity || storedIdentity.digest_sha256 !== inputSnapshot.identity.digest_sha256) {
      return { ok: false, failure: { kind: "plan_drift", detail: "the Wise source bytes changed since the plan was reviewed" } };
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

  for (let i = 0; i < eligible.length; i++) {
    await reportProgress(i, eligible.length);
  }

  const interAccountResults: WiseInterAccountResult[] = [];

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
          const result = await createBankTransaction(api, command.create_payload, command.source_direction === "IN" ? "incoming" : "outgoing");
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
              type: command.source_direction === "IN" ? "D" : "C",
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
          const result = await createBankTransaction(api, command.create_payload, command.source_direction === "IN" ? "incoming" : "outgoing");
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
              // Fee rows carry no source_row, so this is the only way the
              // presenter can tell what currency the row was booked in.
              booked_currency: command.booked_currency,
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
              booked_currency: command.booked_currency,
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
    approvedCommandDigest,
    planHandle,
    autoDetectedInterAccountDimId,
    hasHintedRows: hintedRows.length > 0,
    interAccountResults,
    ownershipReviews,
    invoiceFixCandidates,
    args: {
      feeAccountDimensionsId: fee_account_dimensions_id,
      feeAccountRelationId: fee_account_relation_id,
      interAccountDimensionId: inter_account_dimension_id,
      confirmOwnTransferIds: confirm_own_transfer_ids,
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
  input: WiseRunInput,
): Promise<WiseRunResult> {
  return runWiseImport(api, runtimeSafetyContext, input, false, undefined);
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
