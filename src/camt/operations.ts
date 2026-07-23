import type { OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { FileInputSource, FileInputSnapshot } from "../file-input-snapshot.js";
import {
  assertStatementAccountMatchesDimension,
  buildImportProjection,
  camtNormalizedArgs,
  CamtPreflightRejectedError,
  ensureAccountDimensionExists,
  executeCamtImport,
  issueCamtPlan,
  loadCamt053SnapshotAndPreflight,
  runStatementBalanceCheck,
} from "./executor.js";
import {
  camtPossibleDuplicateRow,
  camtResultRow,
  type CamtImportExecution,
  type CamtImportPreview,
} from "./presenter.js";
import type { CamtParseResult } from "./types.js";

// Typed CAMT operations. The interface references NO MCP types — inputs and
// results are plain typed data. Domain failures that need a special MCP
// envelope surface either as an OperationOutcome failure (plan errors) or a
// thrown CamtPreflightRejectedError (rejected fields); the tool/presenter layer
// projects both. Validation errors (account binding) throw through unchanged.

export interface ParseCamtInput {
  readonly source: FileInputSource;
}

export interface CamtImportInput {
  readonly source: FileInputSource;
  readonly accountsDimensionsId: number;
  readonly dateFrom: string | undefined;
  readonly dateTo: string | undefined;
  /** ADDITIVE (bank façade): an immutable snapshot captured ONCE upstream under
   * the unified bank_input operation. When present it is threaded by identity so
   * the op does not read the source a second time. Absent for the granular
   * process_camt053 path, which captures internally under camt_input. */
  readonly snapshot?: FileInputSnapshot;
}

export interface CamtExecuteInput extends CamtImportInput {
  readonly planHandle: string | undefined;
}

export interface CamtOperations {
  parse(input: ParseCamtInput): Promise<OperationOutcome<CamtParseResult>>;
  prepareImport(input: CamtImportInput): Promise<OperationOutcome<CamtImportPreview>>;
  executeImport(input: CamtExecuteInput): Promise<OperationOutcome<CamtImportExecution>>;
}

// Construct the OperationOutcome union directly rather than through
// successOutcome(), which deep-clones and freezes its value as PlanData and
// would reject the rich projection (it carries a Set and nested api objects).
function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}

function fail<T>(code: string, message: string, retry: "never" | "safe" | "unknown"): OperationOutcome<T> {
  return { ok: false, error: { code, message, retry }, blockers: [] };
}

class CamtOperationsImpl implements CamtOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

  async parse(input: ParseCamtInput): Promise<OperationOutcome<CamtParseResult>> {
    // Resolve, read, preflight — and nothing else. No ledger or configuration
    // read happens until the file is known to be well-formed.
    const { preflight } = await loadCamt053SnapshotAndPreflight(input.source, this.runtimeSafetyContext);
    if (!preflight.ok) throw new CamtPreflightRejectedError(preflight.source, preflight.rejected_fields);
    return ok(preflight.value);
  }

  async prepareImport(input: CamtImportInput): Promise<OperationOutcome<CamtImportPreview>> {
    const { source, accountsDimensionsId, dateFrom, dateTo } = input;
    // DRY RUN: preflight, preserve the existing stop gates, project the import,
    // and issue an immutable execution plan the operator reviews.
    const { snapshot, preflight } = await loadCamt053SnapshotAndPreflight(source, this.runtimeSafetyContext, input.snapshot);
    if (!preflight.ok) throw new CamtPreflightRejectedError(preflight.source, preflight.rejected_fields);
    const loaded = preflight.value;

    await ensureAccountDimensionExists(this.api, accountsDimensionsId);
    await assertStatementAccountMatchesDimension(this.api, loaded.statement_metadata.iban, accountsDimensionsId);

    const projection = await buildImportProjection(this.api, loaded, accountsDimensionsId, dateFrom, dateTo);
    const statementBalanceCheck = loaded.statement_metadata.closing_balance
      ? await runStatementBalanceCheck(
          this.api,
          loaded.statement_metadata.closing_balance,
          loaded.statement_metadata.period.to,
          accountsDimensionsId,
          false,   // dry run: compute + report, never persist
          false,   // dry run: defer the tolerance warning (rows not booked yet)
        )
      : undefined;
    const normalizedArgs = camtNormalizedArgs(accountsDimensionsId, dateFrom, dateTo);
    const planHandle = issueCamtPlan(this.runtimeSafetyContext, snapshot, projection, normalizedArgs);
    const results = projection.descriptors.map(descriptor => camtResultRow(descriptor, "would_create"));
    const possibleDuplicates = projection.descriptors
      .filter(descriptor => descriptor.possibleDuplicateMatches.length > 0)
      .map(descriptor => camtPossibleDuplicateRow(descriptor));
    const filePath = source.file_path;
    const fileRef = source.file_ref;
    const workflowArgs = {
      ...(fileRef !== undefined ? { file_ref: fileRef } : {}),
      ...(fileRef === undefined && filePath !== undefined && !filePath.toLowerCase().startsWith("base64:")
        ? { file_path: filePath }
        : {}),
      accounts_dimensions_id: accountsDimensionsId,
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {}),
      execute: false,
      plan_handle: planHandle,
    };

    return ok({
      projection,
      results,
      possibleDuplicates,
      createdCount: projection.descriptors.length,
      errorCount: 0,
      workflowArgs,
      planHandle,
      ...(statementBalanceCheck ? { statementBalanceCheck } : {}),
    });
  }

  async executeImport(input: CamtExecuteInput): Promise<OperationOutcome<CamtImportExecution>> {
    const result = await executeCamtImport(this.api, this.runtimeSafetyContext, {
      source: input.source,
      accountsDimensionsId: input.accountsDimensionsId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      planHandle: input.planHandle,
      ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
    });
    return result.ok
      ? ok(result.execution)
      : fail(result.code, result.message, "never");
  }
}

export function createCamtOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): CamtOperations {
  return new CamtOperationsImpl(api, runtimeSafetyContext);
}
