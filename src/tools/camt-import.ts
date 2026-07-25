import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { isStrictDate } from "../strict-date.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { toMcpJson } from "../mcp-json.js";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import type { FileInputSource } from "../file-input-snapshot.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { readOnly, batch } from "../annotations.js";
import { remapHiddenGranularWorkflowResult } from "../workflow-response.js";
import { createCamtOperations } from "../camt/operations.js";
import { CamtPreflightRejectedError } from "../camt/executor.js";
import { CAMT_PLAN_DOMAIN } from "./camt-plan.js";
import { currentToolProfile } from "../tool-profile.js";
import type { OperationResultStatus } from "../operation-result-store.js";
import {
  buildCamtResultDetailItems,
  importPreflightFailurePayload,
  renderCamtImportCompact,
  renderCamtImportPayload,
  renderCamtParsePayload,
  type CamtImportExecution,
} from "../camt/presenter.js";

// Re-exported for the identity-only consumers that still import through this
// module (e.g. bank-transaction-create.test). The definitions now live in the
// pure ../camt/* modules.
export { extractCamtDescriptionMetadata } from "../camt/duplicate-identity.js";
export type { ParsedCamtEntry, CamtParseResult, CamtStatementMetadata } from "../camt/types.js";

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isoDateString = (description: string) =>
  z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").refine(isStrictDate, "Expected a real calendar date (canonical YYYY-MM-DD)").describe(description);

interface AdapterResult {
  payload: Record<string, unknown>;
  isError: boolean;
}

function planErrorPayload(error: { code: string; message: string }): Record<string, unknown> {
  return { error: error.message, category: error.code, mutation_occurred: false };
}

export function registerCamtImportTools(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const operations = createCamtOperations(api, runtimeSafetyContext);

  // Guided profiles receive the token-lean compact CAMT surface; standard/full
  // keep the PR0-pinned full envelope byte-for-byte.
  const useCompactCamt = (): boolean => {
    const profile = currentToolProfile();
    return profile === "guided" || profile === "guided-sales";
  };

  // Execute-only: mint an operation-result handle bound to the just-consumed
  // CAMT plan so the compact response can reference get_operation_result_page
  // for the full per-row detail. Fail-safe — the import already mutated, so a
  // store failure degrades to a compact response without the handle.
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

  // parse_camt053 / import_camt053 are fully covered by the merged
  // process_camt053 modes (parse / dry_run / execute). They enter tools/list (a
  // fixed per-session token cost) only when EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1.
  // Their handlers call the typed operations + presenter directly — there is no
  // captured-handler registry, no serialized-response parsing, and
  // process_camt053 dispatches by mode without invoking a captured handler.
  const granularOnlyTools = new Set(["parse_camt053", "import_camt053"]);

  function maybeRegisterTool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown,
  ): void {
    if (granularOnlyTools.has(name) && !exposure.exposeGranularTools) return;
    registerTool(server, name, description, paramsSchema, annotations, cb);
  }

  async function runParse(source: FileInputSource): Promise<AdapterResult> {
    try {
      const outcome = await operations.parse({ source });
      if (!outcome.ok) return { payload: planErrorPayload(outcome.error), isError: true };
      return { payload: renderCamtParsePayload(outcome.value), isError: false };
    } catch (error) {
      if (error instanceof CamtPreflightRejectedError) {
        return { payload: importPreflightFailurePayload(error.source, error.rejected), isError: true };
      }
      throw error;
    }
  }

  async function runImport(args: {
    file_path?: string;
    file_ref?: string;
    accounts_dimensions_id: number;
    execute?: boolean;
    date_from?: string;
    date_to?: string;
    plan_handle?: string;
  }): Promise<AdapterResult> {
    const { file_path, file_ref, accounts_dimensions_id, execute, date_from, date_to, plan_handle } = args;
    if (date_from && date_to && date_from > date_to) {
      throw new Error(`date_from ${date_from} must be on or before date_to ${date_to}`);
    }
    const source: FileInputSource = {
      ...(file_path !== undefined ? { file_path } : {}),
      ...(file_ref !== undefined ? { file_ref } : {}),
    };
    try {
      if (execute !== true) {
        const outcome = await operations.prepareImport({
          source,
          accountsDimensionsId: accounts_dimensions_id,
          dateFrom: date_from,
          dateTo: date_to,
        });
        if (!outcome.ok) return { payload: planErrorPayload(outcome.error), isError: true };
        if (useCompactCamt()) {
          return { payload: renderCamtImportCompact({ mode: "DRY_RUN", data: outcome.value }), isError: false };
        }
        return { payload: renderCamtImportPayload({ mode: "DRY_RUN", ...outcome.value }), isError: false };
      }

      const outcome = await operations.executeImport({
        source,
        accountsDimensionsId: accounts_dimensions_id,
        dateFrom: date_from,
        dateTo: date_to,
        planHandle: plan_handle,
      });
      if (!outcome.ok) return { payload: planErrorPayload(outcome.error), isError: true };
      if (useCompactCamt()) {
        const operationHandle = issueCamtResultHandle(outcome.value, plan_handle);
        return {
          payload: renderCamtImportCompact({ mode: "EXECUTED", data: outcome.value, operationHandle }),
          isError: false,
        };
      }
      return { payload: renderCamtImportPayload({ mode: "EXECUTED", ...outcome.value }), isError: false };
    } catch (error) {
      if (error instanceof CamtPreflightRejectedError) {
        return { payload: importPreflightFailurePayload(error.source, error.rejected), isError: true };
      }
      throw error;
    }
  }

  function toToolResponse(result: AdapterResult) {
    return {
      ...(result.isError ? { isError: true } : {}),
      content: [{ type: "text" as const, text: toMcpJson(result.payload) }],
    };
  }

  maybeRegisterTool(
    "parse_camt053",
    "Parse a CAMT.053 bank statement XML file and preview statement metadata, entries, and summary without querying existing transactions.",
    {
      file_path: z.string().optional().describe("Absolute path/base64 input. Provide exactly one of file_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox CAMT file reference. Provide exactly one of file_path or file_ref."),
    },
    { ...readOnly, openWorldHint: true, title: "Parse CAMT.053" },
    async ({ file_path, file_ref }) => toToolResponse(await runParse({
      ...(file_path !== undefined ? { file_path } : {}),
      ...(file_ref !== undefined ? { file_ref } : {}),
    })),
  );

  maybeRegisterTool(
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
    async ({ file_path, file_ref, accounts_dimensions_id, execute, date_from, date_to, plan_handle }) =>
      toToolResponse(await runImport({ file_path, file_ref, accounts_dimensions_id, execute, date_from, date_to, plan_handle })),
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
      let inner: AdapterResult;

      if (selectedMode === "parse") {
        delegatedTool = "parse_camt053";
        delegatedArgs = { ...(file_path !== undefined ? { file_path } : {}), ...(file_ref !== undefined ? { file_ref } : {}) };
        inner = await runParse({
          ...(file_path !== undefined ? { file_path } : {}),
          ...(file_ref !== undefined ? { file_ref } : {}),
        });
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
        inner = await runImport({
          ...(file_path !== undefined ? { file_path } : {}),
          ...(file_ref !== undefined ? { file_ref } : {}),
          accounts_dimensions_id,
          execute: selectedMode === "execute",
          ...(date_from !== undefined ? { date_from } : {}),
          ...(date_to !== undefined ? { date_to } : {}),
          ...(selectedMode === "execute" && plan_handle !== undefined ? { plan_handle } : {}),
        });
      }

      const result = remapHiddenGranularWorkflowResult(inner.payload);
      return {
        ...(inner.isError ? { isError: true } : {}),
        content: [{
          type: "text" as const,
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
