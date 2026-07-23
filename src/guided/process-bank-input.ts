import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { batch } from "../annotations.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { type ApiContext, coerceId } from "../tools/crud-tools.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import {
  captureFileInputSnapshot,
  FileInputSnapshotError,
  type FileInputSnapshot,
  type FileInputSource,
} from "../file-input-snapshot.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { detectBankInputFormat } from "../banking/input-format.js";
import { createCamtOperations } from "../camt/operations.js";
import { CamtPreflightRejectedError } from "../camt/executor.js";
import { CAMT_PLAN_DOMAIN } from "../tools/camt-plan.js";
import {
  buildCamtResultDetailItems,
  importPreflightFailurePayload,
  renderCamtImportCompact,
  type CamtImportExecution,
} from "../camt/presenter.js";
import { createWiseOperations } from "../wise/operations.js";
import { WiseOperationFailedError, type WiseFailure, type WiseRunInput } from "../wise/executor.js";
import { SHA256_HEX, WISE_PLAN_DOMAIN } from "../wise/projection.js";
import { isNonErrorWiseSkipReason } from "../wise/preflight.js";
import {
  buildWiseResultDetailItems,
  digestMismatch,
  renderWiseFailure,
  renderWiseImportCompact,
  type WiseImportRenderData,
} from "../wise/presenter.js";
import {
  buildBankDimensionCandidates,
  resolveBankAccountSync,
} from "../resolution/bank-account-resolution.js";
import type { Resolution } from "../resolution/types.js";
import type { OperationResultStatus } from "../operation-result-store.js";
import { createOperationResultPageHandler } from "../operation-result-page.js";

// GUIDED FAÇADE. `process_bank_input` unifies CAMT.053 and Wise import behind one
// guided-visible tool. It captures the immutable source ONCE under the unified
// `bank_input` operation, auto-detects the format from the validated CONTENT
// (both parser preflights, never the filename), and routes to the existing typed
// createCamtOperations / createWiseOperations by threading the pre-captured
// snapshot by identity. It calls NO MCP handler, never parses an MCP response,
// and never surfaces a delegated granular tool name/args. Untrusted resolver +
// preflight-rejection text is OCR-sandbox-wrapped at THIS boundary
// (F-RESOLVER-FACADE-WRAP); the pure resolvers/ops stay unwrapped.

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const BANK_INPUT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function textResult(payload: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: toMcpJson(payload) }],
  };
}

export function registerProcessBankInputTool(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const camtOperations = createCamtOperations(api, runtimeSafetyContext);
  const wiseOperations = createWiseOperations(api, runtimeSafetyContext);
  const pageHandler = createOperationResultPageHandler(runtimeSafetyContext, { cursorSecret: randomBytes(32) });

  // Execute-only: mint a get_operation_result_page handle bound to the just
  // consumed plan. Fail-safe — the import already mutated, so a store failure
  // degrades to a compact response without the handle.
  const issueCamtResultHandle = (execution: CamtImportExecution, planHandle: string | undefined): string | undefined => {
    if (typeof planHandle !== "string" || planHandle.length === 0) return undefined;
    try {
      const stopCategory = (execution.executionReport?.stop_reason as { category?: unknown } | undefined)?.category;
      const status: OperationResultStatus = execution.errorCount === 0
        ? "completed"
        : stopCategory === "mutation_indeterminate" ? "indeterminate" : "partial";
      return runtimeSafetyContext.operationResultStore.issue({
        operation: CAMT_PLAN_DOMAIN,
        status,
        items: buildCamtResultDetailItems(execution),
        plan_handle: planHandle,
      });
    } catch {
      return undefined;
    }
  };

  const issueWiseResultHandle = (data: WiseImportRenderData, planHandle: string | undefined): string | undefined => {
    if (typeof planHandle !== "string" || planHandle.length === 0) return undefined;
    try {
      const errorCount = data.skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason)).length;
      const status: OperationResultStatus = errorCount === 0 ? "completed" : "partial";
      return runtimeSafetyContext.operationResultStore.issue({
        operation: WISE_PLAN_DOMAIN,
        status,
        items: buildWiseResultDetailItems(data),
        plan_handle: planHandle,
      });
    } catch {
      return undefined;
    }
  };

  const simpleFailureFromCode = (code: string): WiseFailure => {
    switch (code) {
      case "plan_handle_required": return { kind: "plan_handle_required" };
      case "digest_mismatch": return { kind: "digest_mismatch" };
      case "ownership_reapproval_required": return { kind: "ownership_reapproval_required" };
      case "wise_client_not_found": return { kind: "wise_client_not_found" };
      default: throw new Error(`Unexpected Wise operation error code: ${code}`);
    }
  };

  // Resolve the bank dimension WITHOUT ever demanding a technical id on a unique
  // match. Feed the CAMT statement IBAN as the statement-IBAN evidence rung; an
  // explicit override always wins. Never guesses — a tie/zero surfaces as a
  // compact question.
  async function resolveDimension(override: number | undefined, statementIban: string | undefined): Promise<Resolution<number>> {
    const [bankAccounts, accountDimensions] = await Promise.all([
      api.readonly.getBankAccounts(),
      api.readonly.getAccountDimensions(),
    ]);
    const candidates = buildBankDimensionCandidates(bankAccounts, accountDimensions);
    return resolveBankAccountSync({
      candidates,
      ...(override !== undefined ? { override } : {}),
      ...(statementIban ? { statementIban } : {}),
    });
  }

  // F-RESOLVER-FACADE-WRAP: the pure resolver returns question / choice labels
  // embedding statement/account text; wrap them here, at the façade boundary.
  function resolverQuestion(resolution: Resolution<number>) {
    if (resolution.status === "ambiguous") {
      return textResult({
        status: "needs_input",
        category: "bank_account_dimension_required",
        question: wrapUntrustedOcr(resolution.question),
        choices: resolution.choices.map(choice => ({ id: choice.id, label: wrapUntrustedOcr(choice.label) })),
        mutation_occurred: false,
      });
    }
    const question = resolution.status === "not_found"
      ? resolution.question
      : "A bank account dimension is required.";
    return textResult({
      status: "needs_input",
      category: "bank_account_dimension_required",
      question: wrapUntrustedOcr(question),
      mutation_occurred: false,
    });
  }

  interface BankArgs {
    mode?: "prepare" | "execute" | "show_details";
    file_path?: string;
    file_ref?: string;
    accounts_dimensions_id?: number;
    date_from?: string;
    date_to?: string;
    plan_handle?: string;
    fee_account_dimensions_id?: number;
    inter_account_dimension_id?: number;
    confirm_own_transfer_ids?: string[];
    approved_command_digest?: string;
    skip_jar_transfers?: boolean;
    operation_handle?: string;
    cursor?: string;
    page_size?: number;
  }

  async function handleCamt(mode: "prepare" | "execute", args: BankArgs, source: FileInputSource, snapshot: FileInputSnapshot, statementIban: string | undefined) {
    const resolution = await resolveDimension(args.accounts_dimensions_id, statementIban);
    if (resolution.status !== "resolved") return resolverQuestion(resolution);
    const accountsDimensionsId = resolution.value;
    try {
      if (mode === "prepare") {
        const outcome = await camtOperations.prepareImport({
          source, accountsDimensionsId, dateFrom: args.date_from, dateTo: args.date_to, snapshot,
        });
        if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code, mutation_occurred: false }, true);
        return textResult(renderCamtImportCompact({ mode: "DRY_RUN", data: outcome.value }));
      }
      const outcome = await camtOperations.executeImport({
        source, accountsDimensionsId, dateFrom: args.date_from, dateTo: args.date_to, planHandle: args.plan_handle, snapshot,
      });
      if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code, mutation_occurred: false }, true);
      const operationHandle = issueCamtResultHandle(outcome.value, args.plan_handle);
      return textResult(renderCamtImportCompact({ mode: "EXECUTED", data: outcome.value, operationHandle }));
    } catch (error) {
      if (error instanceof CamtPreflightRejectedError) {
        return textResult(importPreflightFailurePayload(error.source, error.rejected), true);
      }
      throw error;
    }
  }

  async function handleWise(mode: "prepare" | "execute", args: BankArgs, source: FileInputSource, snapshot: FileInputSnapshot) {
    const resolution = await resolveDimension(args.accounts_dimensions_id, undefined);
    if (resolution.status !== "resolved") return resolverQuestion(resolution);
    const accountsDimensionsId = resolution.value;

    // Preserve the Wise digest gate before any read/mutation.
    if (args.approved_command_digest !== undefined && (
      typeof args.approved_command_digest !== "string" || !SHA256_HEX.test(args.approved_command_digest)
    )) {
      return digestMismatch();
    }
    if (mode === "execute" && !SHA256_HEX.test(args.approved_command_digest ?? "")) {
      return digestMismatch();
    }

    const runInput: WiseRunInput = {
      source,
      accountsDimensionsId,
      feeAccountDimensionsId: args.fee_account_dimensions_id,
      feeAccountRelationId: undefined,
      interAccountDimensionId: args.inter_account_dimension_id,
      confirmOwnTransferIds: args.confirm_own_transfer_ids,
      approvedCommandDigest: args.approved_command_digest,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      skipJarTransfers: args.skip_jar_transfers,
      snapshot,
    };
    try {
      const outcome = mode === "execute"
        ? await wiseOperations.execute({ ...runInput, planHandle: args.plan_handle })
        : await wiseOperations.prepare(runInput);
      if (!outcome.ok) return renderWiseFailure(simpleFailureFromCode(outcome.error.code));
      if (mode !== "execute") return textResult(renderWiseImportCompact({ mode: "DRY_RUN", data: outcome.value }));
      const operationHandle = issueWiseResultHandle(outcome.value, args.plan_handle);
      return textResult(renderWiseImportCompact({ mode: "EXECUTED", data: outcome.value, operationHandle }));
    } catch (error) {
      if (error instanceof WiseOperationFailedError) return renderWiseFailure(error.failure);
      throw error;
    }
  }

  registerTool(server,
    "process_bank_input",
    "Unified bank-statement entry point. Auto-detects CAMT.053 XML vs Wise transaction-history CSV from the file content and imports it. Use mode='prepare' (default) to preview a dry run and get a plan handle, mode='execute' to create the reviewed transactions, or mode='show_details' to page the full per-row result. If the bank account dimension is unique it is resolved automatically.",
    {
      mode: z.enum(["prepare", "execute", "show_details"]).optional().describe("Workflow phase. Defaults to prepare (dry-run preview)."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox bank_input file reference. Provide exactly one of file_ref or file_path."),
      file_path: z.string().optional().describe("Advanced: absolute path / base64 input. Provide exactly one of file_ref or file_path."),
      accounts_dimensions_id: coerceId.optional().describe("Optional bank account dimension ID. Omit to let a unique bank account resolve automatically."),
      date_from: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").optional().describe("Only import entries from this date (YYYY-MM-DD)."),
      date_to: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").optional().describe("Only import entries up to this date (YYYY-MM-DD)."),
      plan_handle: z.string().optional().describe("Execution-plan handle from the reviewed dry run. Required for mode='execute'."),
      fee_account_dimensions_id: z.number().optional().describe("Wise only: account dimension ID for the Wise fee expense account."),
      inter_account_dimension_id: coerceId.optional().describe("Wise only: other bank account dimension ID for inter-account transfers."),
      confirm_own_transfer_ids: z.array(z.string().min(1)).optional().describe("Wise only: exact Wise IDs explicitly approved as own transfers."),
      approved_command_digest: z.string().regex(SHA256_HEX).optional().describe("Wise only: exact lowercase SHA-256 command digest from the reviewed dry run. Required for Wise mode='execute'."),
      skip_jar_transfers: z.boolean().optional().describe("Wise only: skip Jar (savings pot) transfers (default true)."),
      operation_handle: z.string().regex(HANDLE_PATTERN).optional().describe("mode='show_details' only: operation-result handle from a prior execute."),
      cursor: z.string().max(128).optional().describe("mode='show_details' only: opaque cursor returned by the preceding page."),
      page_size: z.number().int().min(1).max(50).optional().describe("mode='show_details' only: maximum items to return (default 20, max 50)."),
    },
    { ...batch, openWorldHint: true, title: "Process Bank Input" },
    async (args: BankArgs) => {
      const mode = args.mode ?? "prepare";

      if (mode === "show_details") {
        if (args.operation_handle === undefined) {
          return textResult({ error: "operation_handle is required for mode='show_details'.", category: "operation_handle_required", mutation_occurred: false }, true);
        }
        return pageHandler({ operation_handle: args.operation_handle, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), ...(args.page_size !== undefined ? { page_size: args.page_size } : {}) });
      }

      if (args.date_from && args.date_to && args.date_from > args.date_to) {
        return textResult({ error: `date_from ${args.date_from} must be on or before date_to ${args.date_to}`, category: "invalid_date_range", mutation_occurred: false }, true);
      }

      const source: FileInputSource = {
        ...(args.file_path !== undefined ? { file_path: args.file_path } : {}),
        ...(args.file_ref !== undefined ? { file_ref: args.file_ref } : {}),
      };

      // CAPTURE ONCE under the unified bank_input operation. A bank_input ref
      // resolves only here; a camt_input/wise_input ref cannot, so the op-mismatch
      // guard fires and this rejects without any second read.
      let snapshot: FileInputSnapshot;
      try {
        snapshot = await captureFileInputSnapshot(source, {
          runtimeSafetyContext,
          operation: FILE_REFERENCE_OPERATIONS.bank,
          allowedExtensions: [".xml", ".csv"],
          maxSize: BANK_INPUT_MAX_FILE_SIZE,
        });
      } catch (error) {
        if (error instanceof FileInputSnapshotError) {
          return textResult({ error: error.message, category: error.code, mutation_occurred: false }, true);
        }
        throw error;
      }

      // AUTO-DETECT from the captured bytes (both preflights). No second read.
      const detected = detectBankInputFormat(snapshot);
      if (detected.format === "ambiguous" || detected.format === "unsupported") {
        return textResult({
          error: detected.format === "ambiguous"
            ? "The file matched both CAMT.053 and Wise CSV signatures and cannot be routed."
            : "The file was not recognized as a CAMT.053 statement or a Wise transaction-history CSV.",
          category: detected.format === "ambiguous" ? "bank_input_ambiguous" : "bank_input_unsupported",
          camt_rejected_field_count: detected.camt_rejected_field_count,
          wise_rejected_field_count: detected.wise_rejected_field_count,
          mutation_occurred: false,
        }, true);
      }

      return detected.format === "camt"
        ? handleCamt(mode, args, source, snapshot, detected.preflight.value.statement_metadata.iban)
        : handleWise(mode, args, source, snapshot);
    },
  );
}
