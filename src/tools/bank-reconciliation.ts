import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";
import type { ApiContext } from "./crud-tools.js";
import { readOnly, batch } from "../annotations.js";
import { buildWorkflowEnvelope, remapHiddenGranularWorkflowEnvelope } from "../workflow-response.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { createBankReconciliationOperations } from "../banking/reconciliation/operations.js";
import { currentToolProfile } from "../tool-profile.js";
import { BANK_RECONCILIATION_PLAN_DOMAIN } from "./bank-reconciliation-plan.js";
import type { PlanExecutionReport } from "../plan-execution.js";
import type { OperationResultStatus, PublicOperationResultDetail } from "../operation-result-store.js";
import {
  MAX_INTER_ACCOUNT_DATE_GAP_DAYS,
  ReconciliationOperationFailedError,
} from "../banking/reconciliation/executor.js";
import {
  buildInterAccountPayload,
  buildReconExactResultDetailItems,
  buildReconInterAccountResultDetailItems,
  reconPlanError,
  reconPlanErrorPayload,
  renderExactMatchCompact,
  renderExactMatchPayload,
  renderInterAccountCompact,
  renderReconFailure,
  renderSuggestCompact,
  renderSuggestPayload,
} from "../banking/reconciliation/presenter.js";

// Thin adapter. It registers the reconciliation tools, gates the granular
// constituents, and routes each mode to the typed BankReconciliationOperations
// facade (suggest / prepare|execute exact-confirm / prepare|execute inter-account).
// All matching, byte-stable digests, execution safety, and MCP-envelope shaping
// live in the ../banking/reconciliation/* modules. Domain failures reach the
// presenter two ways, mirroring CAMT/Wise: a thrown ReconciliationOperationFailedError
// carries the rich kinds (real plan-store code, plan-drift detail); the simple
// plan_handle_required kind arrives as an OperationOutcome error reprojected below.

// Re-exported for the pure-helper consumers that still import through this
// module (analyze-unconfirmed.ts, receipt-inbox.ts, the reconciliation test's
// `matchScore`). The definitions now live in the pure ../banking/reconciliation/*
// modules.
export { buildInvoiceIndex, getIndexedCandidates } from "../banking/reconciliation/invoice-index.js";
export { matchScore, getInvoiceMatchEligibility } from "../banking/reconciliation/match-score.js";

const response = (payload: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: toMcpJson(payload) }],
});

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function registerBankReconciliationTools(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const operations = createBankReconciliationOperations(api, runtimeSafetyContext);

  // Guided profiles receive the token-lean compact reconciliation surface;
  // standard/full keep the byte-identical full envelope.
  const useCompactRecon = (): boolean => {
    const profile = currentToolProfile();
    return profile === "guided" || profile === "guided-sales";
  };
  const compactResponse = (payload: { summary: unknown }) => ({
    content: [{ type: "text" as const, text: toMcpJson(payload) }],
  });
  const activeConnectionName = (): string | undefined => {
    try {
      return runtimeSafetyContext.getActiveScope().connectionName;
    } catch {
      return undefined;
    }
  };
  // Execute-only: mint an operation-result handle bound to the just-consumed
  // reconciliation plan so the compact response can reference
  // get_operation_result_page for the full per-row detail. FAIL-SAFE — the
  // confirm already mutated, so a store failure degrades to a compact response
  // without the handle; it never throws and never blocks the completed mutation.
  const issueReconResultHandle = (
    items: PublicOperationResultDetail[],
    planHandle: string | undefined,
    executionReport: PlanExecutionReport,
  ): string | undefined => {
    if (typeof planHandle !== "string" || planHandle.length === 0) return undefined;
    try {
      const status: OperationResultStatus = executionReport.stop_reason == null ? "completed" : "partial";
      return runtimeSafetyContext.operationResultStore.issue({
        operation: BANK_RECONCILIATION_PLAN_DOMAIN,
        status,
        items,
        plan_handle: planHandle,
      });
    } catch {
      return undefined;
    }
  };

  // Constituents fully covered by the merged reconcile_bank_transactions modes
  // (suggest / dry_run_auto_confirm / execute_auto_confirm). They enter
  // tools/list (a fixed per-session token cost) only when
  // EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1. reconcile_inter_account_transfers is
  // never gated: the merged tool has no inter-account execute mode.
  const granularOnlyTools = new Set(["reconcile_transactions", "auto_confirm_exact_matches"]);

  function registerReconTool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    annotations: Parameters<typeof registerTool>[4],
    cb: (args: z.infer<z.ZodObject<Args>>, extra: unknown) => unknown,
  ): void {
    if (granularOnlyTools.has(name) && !exposure.exposeGranularTools) return;
    registerTool(server, name, description, paramsSchema, annotations, cb);
  }

  registerReconTool("reconcile_transactions",
    "Match unconfirmed bank transactions to open sale/purchase invoices. " +
    "Returns suggested matches with confidence scores and ready-to-use distribution data.",
    {
      min_confidence: z.number().min(0).max(100).optional().describe("Minimum confidence threshold 0-100 (default 50)"),
      block_on_duplicate: z.boolean().optional().describe(
        "Read-only: annotate any match whose cash movement appears already booked by another journal with duplicate_blocked=true. Suggest mode never confirms, so this only labels the row."
      ),
    },
    { ...readOnly, title: "Reconcile Transactions" },
    async ({ min_confidence, block_on_duplicate }) => {
      const outcome = await operations.suggestMatches({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate });
      if (outcome.ok) return response(renderSuggestPayload(outcome.value));
      return reconPlanError(outcome.error.code, outcome.error.message);
    }
  );

  registerReconTool("auto_confirm_exact_matches",
    "Batch-confirm bank transactions with a single high-confidence match (>=90). DRY RUN by default — the dry run returns a plan_handle enumerating the reviewed confirms; execute=true REQUIRES that handle and confirms exactly the reviewed set.",
    {
      execute: z.boolean().optional().describe("Actually confirm transactions (default false = dry run)"),
      min_confidence: z.number().min(0).max(100).optional().describe("Minimum confidence (default 90)"),
      block_on_duplicate: z.boolean().optional().describe(
        "Refuse (partition out of the confirm set) any exact match whose cash movement appears already booked by another journal (an available cross-mechanism duplicate scan finds a suspect). Default false = advisory only."
      ),
      plan_handle: z.string().optional().describe("Execution-plan handle from the reviewed dry run. Required for execute=true."),
    },
    { ...batch, title: "Auto-Confirm Bank Matches" },
    async ({ execute, min_confidence, block_on_duplicate, plan_handle }) => {
      try {
        if (execute !== true) {
          const outcome = await operations.prepareExactConfirm({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate });
          if (outcome.ok) return response(renderExactMatchPayload({ mode: "DRY_RUN", projection: outcome.value.projection, planHandle: outcome.value.planHandle }));
          return reconPlanError(outcome.error.code, outcome.error.message);
        }
        const outcome = await operations.executeExactConfirm({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate, planHandle: plan_handle });
        if (outcome.ok) return response(renderExactMatchPayload({ mode: "EXECUTED", projection: outcome.value.projection, executionReport: outcome.value.executionReport }));
        return reconPlanError(outcome.error.code, outcome.error.message);
      } catch (error) {
        if (error instanceof ReconciliationOperationFailedError) return renderReconFailure(error.failure);
        throw error;
      }
    }
  );

  registerReconTool("reconcile_inter_account_transfers",
    "Match own-account bank transfers. DUPLICATE-SAFE: skips transfers already journalized from the other side. DRY RUN by default returns a plan_handle enumerating the reviewed confirms/deletes; execute=true REQUIRES that handle and runs exactly the reviewed set. For one-sided transfers with 2+ possible targets, pass target_accounts_dimensions_id.",
    {
      execute: z.boolean().optional().describe("Actually confirm matched pairs (default false = dry run)"),
      max_date_gap: z.number().int().min(0).max(MAX_INTER_ACCOUNT_DATE_GAP_DAYS).optional()
        .describe(`Maximum days between C and D transaction dates (default 1, max ${MAX_INTER_ACCOUNT_DATE_GAP_DAYS})`),
      target_accounts_dimensions_id: z.number().optional().describe(
        "For one-sided transfers (no matching D/C pair), specify the target bank account dimension ID. " +
        "Required when there are 3+ bank accounts and counterparty IBAN is missing."
      ),
      plan_handle: z.string().optional().describe("Execution-plan handle from the reviewed dry run. Required for execute=true."),
    },
    { ...batch, title: "Reconcile Inter-Account Transfers" },
    async ({ execute, max_date_gap, target_accounts_dimensions_id, plan_handle }) => {
      const input = { maxDateGap: max_date_gap, targetAccountsDimensionsId: target_accounts_dimensions_id };
      const compact = useCompactRecon();
      const connectionName = activeConnectionName();
      try {
        if (execute !== true) {
          const outcome = await operations.prepareInterAccount(input);
          if (!outcome.ok) return reconPlanError(outcome.error.code, outcome.error.message);
          return compact
            ? compactResponse(renderInterAccountCompact({ mode: "DRY_RUN", match: outcome.value.match, planHandle: outcome.value.planHandle, connectionName }))
            : response(buildInterAccountPayload({ mode: "DRY_RUN", match: outcome.value.match, planHandle: outcome.value.planHandle }));
        }
        const outcome = await operations.executeInterAccount({ ...input, planHandle: plan_handle });
        if (!outcome.ok) return reconPlanError(outcome.error.code, outcome.error.message);
        if (!compact) return response(buildInterAccountPayload({ mode: "EXECUTED", match: outcome.value.match, executionReport: outcome.value.executionReport }));
        const operationHandle = issueReconResultHandle(
          buildReconInterAccountResultDetailItems(outcome.value.match),
          plan_handle,
          outcome.value.executionReport,
        );
        return compactResponse(renderInterAccountCompact({ mode: "EXECUTED", match: outcome.value.match, executionReport: outcome.value.executionReport, operationHandle, connectionName }));
      } catch (error) {
        if (error instanceof ReconciliationOperationFailedError) return renderReconFailure(error.failure);
        throw error;
      }
    }
  );

  registerTool(server, "reconcile_bank_transactions",
    "Merged bank reconciliation entry point. Use mode='suggest' for invoice-match suggestions, mode='dry_run_auto_confirm' or mode='execute_auto_confirm' for exact invoice matches, and mode='inter_account_dry_run' for own-account transfer detection.",
    {
      mode: z.enum(["suggest", "dry_run_auto_confirm", "execute_auto_confirm", "inter_account_dry_run"])
        .optional()
        .describe("Workflow phase to run. Defaults to suggest."),
      min_confidence: z.number().min(0).max(100).optional().describe("Minimum confidence threshold for invoice matching modes."),
      max_date_gap: z.number().int().min(0).max(MAX_INTER_ACCOUNT_DATE_GAP_DAYS).optional()
        .describe(`Maximum days between inter-account transfer legs (default 1, max ${MAX_INTER_ACCOUNT_DATE_GAP_DAYS}).`),
      target_accounts_dimensions_id: z.number().optional().describe(
        "For inter_account_dry_run one-sided transfers, specify the target bank account dimension ID when it cannot be inferred."
      ),
      block_on_duplicate: z.boolean().optional().describe(
        "For the invoice-matching modes (suggest / dry_run_auto_confirm / execute_auto_confirm): refuse (or, in suggest, flag) an exact match whose cash movement appears already booked by another journal. Default false = advisory only."
      ),
      plan_handle: z.string().optional().describe(
        "Execution-plan handle from the reviewed dry run. Required for mode='execute_auto_confirm' and forwarded to the confirm executor."
      ),
    },
    { ...batch, title: "Reconcile Bank Transactions" },
    async ({ mode, min_confidence, max_date_gap, target_accounts_dimensions_id, block_on_duplicate, plan_handle }) => {
      const selectedMode = mode ?? "suggest";

      // Guided surface: emit the token-lean compact operation summary and return
      // early. Rich domain failures still surface as the full non-mutating error
      // envelope (mirroring CAMT/Wise), so the compact path only handles success.
      if (useCompactRecon()) {
        const connectionName = activeConnectionName();
        try {
          switch (selectedMode) {
            case "dry_run_auto_confirm": {
              const outcome = await operations.prepareExactConfirm({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate });
              if (!outcome.ok) return reconPlanError(outcome.error.code, outcome.error.message);
              return compactResponse(renderExactMatchCompact({ mode: "DRY_RUN", projection: outcome.value.projection, planHandle: outcome.value.planHandle, connectionName }));
            }
            case "execute_auto_confirm": {
              const outcome = await operations.executeExactConfirm({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate, planHandle: plan_handle });
              if (!outcome.ok) return reconPlanError(outcome.error.code, outcome.error.message);
              const operationHandle = issueReconResultHandle(
                buildReconExactResultDetailItems(outcome.value.projection, outcome.value.executionReport),
                plan_handle,
                outcome.value.executionReport,
              );
              return compactResponse(renderExactMatchCompact({ mode: "EXECUTED", projection: outcome.value.projection, executionReport: outcome.value.executionReport, operationHandle, connectionName }));
            }
            case "inter_account_dry_run": {
              const outcome = await operations.prepareInterAccount({ maxDateGap: max_date_gap, targetAccountsDimensionsId: target_accounts_dimensions_id });
              if (!outcome.ok) return reconPlanError(outcome.error.code, outcome.error.message);
              return compactResponse(renderInterAccountCompact({ mode: "DRY_RUN", match: outcome.value.match, planHandle: outcome.value.planHandle, connectionName }));
            }
            default: {
              const outcome = await operations.suggestMatches({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate });
              if (!outcome.ok) return reconPlanError(outcome.error.code, outcome.error.message);
              return compactResponse(renderSuggestCompact(outcome.value, { connectionName }));
            }
          }
        } catch (error) {
          if (error instanceof ReconciliationOperationFailedError) return renderReconFailure(error.failure);
          throw error;
        }
      }

      let delegatedTool: string;
      let delegatedArgs: Record<string, unknown>;

      switch (selectedMode) {
        case "suggest":
          delegatedTool = "reconcile_transactions";
          delegatedArgs = {
            ...(min_confidence !== undefined ? { min_confidence } : {}),
            ...(block_on_duplicate !== undefined ? { block_on_duplicate } : {}),
          };
          break;
        case "dry_run_auto_confirm":
          delegatedTool = "auto_confirm_exact_matches";
          delegatedArgs = {
            execute: false,
            ...(min_confidence !== undefined ? { min_confidence } : {}),
            ...(block_on_duplicate !== undefined ? { block_on_duplicate } : {}),
          };
          break;
        case "execute_auto_confirm":
          delegatedTool = "auto_confirm_exact_matches";
          delegatedArgs = {
            execute: true,
            ...(min_confidence !== undefined ? { min_confidence } : {}),
            ...(block_on_duplicate !== undefined ? { block_on_duplicate } : {}),
            ...(plan_handle !== undefined ? { plan_handle } : {}),
          };
          break;
        case "inter_account_dry_run":
          delegatedTool = "reconcile_inter_account_transfers";
          delegatedArgs = {
            execute: false,
            ...(max_date_gap !== undefined ? { max_date_gap } : {}),
            ...(target_accounts_dimensions_id !== undefined ? { target_accounts_dimensions_id } : {}),
          };
          break;
      }

      let result: Record<string, unknown>;
      try {
        switch (selectedMode) {
          case "suggest": {
            const outcome = await operations.suggestMatches({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate });
            result = outcome.ok ? renderSuggestPayload(outcome.value) : reconPlanErrorPayload(outcome.error.code, outcome.error.message);
            break;
          }
          case "dry_run_auto_confirm": {
            const outcome = await operations.prepareExactConfirm({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate });
            result = outcome.ok
              ? renderExactMatchPayload({ mode: "DRY_RUN", projection: outcome.value.projection, planHandle: outcome.value.planHandle })
              : reconPlanErrorPayload(outcome.error.code, outcome.error.message);
            break;
          }
          case "execute_auto_confirm": {
            const outcome = await operations.executeExactConfirm({ minConfidence: min_confidence, blockOnDuplicate: block_on_duplicate, planHandle: plan_handle });
            result = outcome.ok
              ? renderExactMatchPayload({ mode: "EXECUTED", projection: outcome.value.projection, executionReport: outcome.value.executionReport })
              : reconPlanErrorPayload(outcome.error.code, outcome.error.message);
            break;
          }
          default: {
            const outcome = await operations.prepareInterAccount({ maxDateGap: max_date_gap, targetAccountsDimensionsId: target_accounts_dimensions_id });
            result = outcome.ok
              ? buildInterAccountPayload({ mode: "DRY_RUN", match: outcome.value.match, planHandle: outcome.value.planHandle })
              : reconPlanErrorPayload(outcome.error.code, outcome.error.message);
            break;
          }
        }
      } catch (error) {
        if (error instanceof ReconciliationOperationFailedError) {
          result = reconPlanErrorPayload(error.failure.category, error.failure.message);
        } else {
          throw error;
        }
      }

      const resultSummary = recordValue(result.summary);
      const workflowSummary = selectedMode === "dry_run_auto_confirm"
        ? `Exact-match dry run would confirm ${numberValue(resultSummary, "auto_confirmed")} bank transaction(s), skip ${numberValue(resultSummary, "skipped")}, and report ${numberValue(resultSummary, "error_count")} error(s).`
        : selectedMode === "inter_account_dry_run"
          ? `Inter-account dry run would reconcile ${numberValue(resultSummary, "matched_pairs")} transfer pair(s), ${numberValue(resultSummary, "matched_one_sided")} one-sided transfer(s), skip ${numberValue(resultSummary, "skipped_ambiguous")} ambiguous transfer(s), and report ${numberValue(resultSummary, "error_count")} error(s).`
          : undefined;
      const workflow = workflowSummary
        ? buildWorkflowEnvelope({
            summary: workflowSummary,
            dry_run_steps: [{
              tool: delegatedTool,
              summary: workflowSummary,
              suggested_args: delegatedArgs,
              preview: resultSummary,
            }],
          })
        : undefined;
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            recommended_entry_point: "reconcile_bank_transactions",
            mode: selectedMode,
            delegated_tool: delegatedTool,
            delegated_args: delegatedArgs,
            ...(workflow ? { workflow: remapHiddenGranularWorkflowEnvelope(workflow) } : {}),
            result,
          }),
        }],
      };
    },
  );
}
