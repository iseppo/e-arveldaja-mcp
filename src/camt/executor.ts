import { wrapUntrustedOcr } from "../mcp-json.js";
import { logAudit } from "../audit-log.js";
import { reportProgress } from "../progress.js";
import { normalizeCompanyName } from "../company-name.js";
import { isNonVoidTransaction } from "../transaction-status.js";
import { createBankTransaction } from "../bank-transaction-create.js";
import { canonicalRefNumber } from "../ref-number.js";
import { checkStatementClosingBalance } from "../statement-balance-check.js";
import { appendStatementBalance, readStatementBalances } from "../statement-balance-store.js";
import { PlanStoreError, type PlanData, type PlanRecord } from "../plan-store.js";
import { captureFileInputSnapshot, FileInputSnapshotError, type FileInputSnapshot, type FileInputSource } from "../file-input-snapshot.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { type ApiContext } from "../tools/crud-tools.js";
import { type RuntimeSafetyContext } from "../runtime-safety-context.js";
import {
  buildCamtExecutionPlanInput,
  camtPlanCommandId,
  canonicalPlanJson,
  CAMT_CREATE_CATEGORY,
  CAMT_PLAN_DOMAIN,
  executeCamtCommands,
  stripUndefinedDeep,
  type CamtPlanReviewCommand,
} from "../tools/camt-plan.js";
import {
  buildDuplicateLookup,
  findDuplicateTransactionIds,
} from "./duplicate-identity.js";
import { preflightCamt053Xml } from "./parser.js";
import { computeCamtImportProjection } from "./projection.js";
import {
  camtPossibleDuplicateRow,
  camtResultRow,
  type CamtImportExecution,
} from "./presenter.js";
import { isRecord } from "../record-utils.js";
import type {
  CamtBalance,
  CamtImportProjection,
  CamtParseResult,
  CamtPreflightResult,
  ClientResolution,
  ClientResolutionCache,
  Client,
  ImportRejectedField,
  ParsedCamtEntry,
  StatementBalanceCheckResult,
} from "./types.js";

const CAMT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const CANONICAL_ACCOUNT_IDENTITY_REGEX = /^[A-Z0-9]{1,34}$/;

/**
 * Thrown when a re-read / preflight fails inside an operation. Carries the
 * structured rejected fields so the tool/presenter layer can project them into
 * the sandboxed importPreflightFailure envelope. Not an MCP type; the operation
 * interface still returns OperationOutcome<T>.
 */
export class CamtPreflightRejectedError extends Error {
  constructor(readonly source: "camt" | "wise", readonly rejected: ImportRejectedField[]) {
    super("Import preflight failed");
    this.name = "CamtPreflightRejectedError";
  }
}

export async function loadCamt053SnapshotAndPreflight(
  source: FileInputSource,
  runtimeSafetyContext: RuntimeSafetyContext,
  preloadedSnapshot?: FileInputSnapshot,
): Promise<{ snapshot: FileInputSnapshot; preflight: CamtPreflightResult }> {
  // ADDITIVE snapshot threading (bank façade): when the caller has already
  // captured the immutable bytes ONCE (under the unified bank_input operation),
  // it hands the frozen snapshot in by identity so this op does NOT read the
  // path a second time. The granular process_camt053 path passes no snapshot and
  // captures internally under camt_input exactly as before — byte-identical.
  const snapshot = preloadedSnapshot ?? await captureFileInputSnapshot(source, {
    runtimeSafetyContext,
    operation: FILE_REFERENCE_OPERATIONS.camt,
    allowedExtensions: [".xml"],
    maxSize: CAMT_MAX_FILE_SIZE,
  });
  return { snapshot, preflight: preflightCamt053Xml(snapshot.text()) };
}

export async function ensureAccountDimensionExists(api: ApiContext, accountsDimensionsId: number): Promise<void> {
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

/**
 * Fetch the ledger and drive the pure projection, injecting the api-backed
 * client resolver and progress reporter. The api I/O lives here (adapter
 * layer); the shape-building stays pure in projection.ts.
 */
export async function buildImportProjection(
  api: ApiContext,
  loaded: CamtParseResult,
  accountsDimensionsId: number,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): Promise<CamtImportProjection> {
  const ledgerTransactions = (await api.transactions.listAll()).filter(isNonVoidTransaction);
  return computeCamtImportProjection({
    loaded,
    accountsDimensionsId,
    dateFrom,
    dateTo,
    ledgerTransactions,
    resolveClient: (entry, cache) => resolveClientForEntry(api, entry, cache),
    reportProgress: (index, total) => reportProgress(index, total),
  });
}

// --- Plan input (planner) ----------------------------------------------------

export function camtNormalizedArgs(
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

export function camtPlanFingerprint(projection: CamtImportProjection, normalizedArgs: PlanRecord): string {
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
      ref_number: canonicalRefNumber(descriptor.entry.reference_number).value,
    }),
  }));
}

export function issueCamtPlan(
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

// --- Closing-balance tripwire ------------------------------------------------

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
export async function runStatementBalanceCheck(
  api: ApiContext,
  closing: CamtBalance,
  fallbackDate: string | undefined,
  accountsDimensionsId: number,
  persist: boolean,
  isExecute: boolean,
): Promise<StatementBalanceCheckResult | undefined> {
  const balanceDate = closing.date ?? fallbackDate;
  if (!balanceDate) return undefined;   // no anchor date → cannot reconcile

  let check;
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

  // Dry-run suppression: the dry run reconciles BEFORE the statement's own
  // entries are booked (execute reconciles AFTER), so the expected balance
  // excludes those rows and an out-of-tolerance comparison is expected — not a
  // real discrepancy. Suppress the tolerance warning on dry-run and replace it
  // with an explicit deferral note; all numeric figures are retained. On
  // execute the warning fires as-is when genuinely out of tolerance.
  if (!isExecute && check.warnings.length > 0) {
    check.warnings = [];
    notes.push(
      "Closing-balance reconciliation is deferred until execute: the statement's own entries " +
      "are not yet booked, so a dry-run comparison is expected to differ.",
    );
  }

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

// --- Execute path ------------------------------------------------------------

export interface CamtExecuteInput {
  readonly source: FileInputSource;
  readonly accountsDimensionsId: number;
  readonly dateFrom: string | undefined;
  readonly dateTo: string | undefined;
  readonly planHandle: string | undefined;
  /** ADDITIVE: pre-captured immutable snapshot (bank façade). When present the
   * execute path uses it as its single immutable re-read instead of capturing
   * under camt_input, so a bank_input file_ref never re-resolves. */
  readonly snapshot?: FileInputSnapshot;
}

export type CamtExecuteResult =
  | { readonly ok: true; readonly execution: CamtImportExecution }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * EXECUTE: consume the reviewed plan ONCE, re-read the source immutably, and
 * re-validate source digest / arguments / scope / ledger fingerprint before the
 * first write. Execute the frozen command set through the shared tracker
 * (indeterminate mutation stops at known_object_limit:1), audit each created
 * row, then run the fail-safe closing-balance tripwire (persist on execute).
 */
export async function executeCamtImport(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  input: CamtExecuteInput,
): Promise<CamtExecuteResult> {
  const { source, accountsDimensionsId, dateFrom, dateTo, planHandle } = input;
  const preloadedSnapshot = input.snapshot;
  const normalizedArgs = camtNormalizedArgs(accountsDimensionsId, dateFrom, dateTo);

  // A plan handle is NOT human approval; the stop gates below stay in force.
  if (typeof planHandle !== "string" || planHandle.length === 0) {
    return {
      ok: false,
      code: "plan_handle_required",
      message: "A reviewed execution-plan handle from the CAMT dry run is required to import transactions.",
    };
  }
  let storedPlan;
  try {
    storedPlan = runtimeSafetyContext.planStore.consume(planHandle, CAMT_PLAN_DOMAIN);
  } catch (error) {
    if (error instanceof PlanStoreError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }

  // One immutable read of the reviewed source, reused for the digest check
  // and the re-parse.
  let snapshot: FileInputSnapshot;
  let preflight: CamtPreflightResult;
  try {
    ({ snapshot, preflight } = await loadCamt053SnapshotAndPreflight(source, runtimeSafetyContext, preloadedSnapshot));
  } catch (error) {
    if (error instanceof FileInputSnapshotError) {
      return { ok: false, code: "plan_drift", message: "The CAMT source could not be re-read to match the reviewed plan." };
    }
    throw error;
  }
  if (!preflight.ok) throw new CamtPreflightRejectedError(preflight.source, preflight.rejected_fields);
  const loaded = preflight.value;

  const storedIdentity = storedPlan.sourceIdentities[0];
  if (!storedIdentity || storedIdentity.digest_sha256 !== snapshot.identity.digest_sha256) {
    return { ok: false, code: "plan_drift", message: "The CAMT source bytes changed since the plan was reviewed." };
  }
  if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(normalizedArgs)) {
    return { ok: false, code: "plan_drift", message: "The import arguments changed since the plan was reviewed." };
  }

  await ensureAccountDimensionExists(api, accountsDimensionsId);
  await assertStatementAccountMatchesDimension(api, loaded.statement_metadata.iban, accountsDimensionsId);

  const projection = await buildImportProjection(api, loaded, accountsDimensionsId, dateFrom, dateTo);
  const storedFingerprint = isRecord(storedPlan.privatePayload)
    ? storedPlan.privatePayload.fingerprint
    : undefined;
  if (typeof storedFingerprint !== "string" ||
    storedFingerprint !== camtPlanFingerprint(projection, normalizedArgs)) {
    return { ok: false, code: "plan_drift", message: "The reviewed CAMT plan no longer matches the current ledger and source." };
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
      const lookup = buildDuplicateLookup(freshLedger, accountsDimensionsId);
      const duplicateIds = findDuplicateTransactionIds(
        descriptor.entry, lookup, projection.repeatedBankReferences, accountsDimensionsId,
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
        accountsDimensionsId,
        true,   // execute: persist the closing-balance record
        true,   // execute: rows are booked, so the tolerance warning is real
      )
    : undefined;

  return {
    ok: true,
    execution: {
      projection,
      results,
      possibleDuplicates,
      createdCount: completedIndices.size,
      errorCount: projection.descriptors.length - completedIndices.size,
      workflowArgs: {},
      executionReport,
      ...(statementBalanceCheck ? { statementBalanceCheck } : {}),
    },
  };
}

// Re-exports used by the operation facade.
export type { FileInputSource, PlanData };
