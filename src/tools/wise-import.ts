import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { batch } from "../annotations.js";
import { toMcpJson } from "../mcp-json.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { FileInputSource } from "../file-input-snapshot.js";
import type { OperationOutcome } from "../operation-outcome.js";
import { currentToolProfile } from "../tool-profile.js";
import type { OperationResultStatus } from "../operation-result-store.js";
import { ISO_DATE_REGEX, isNonErrorWiseSkipReason } from "../wise/preflight.js";
import { SHA256_HEX, WISE_PLAN_DOMAIN } from "../wise/projection.js";
import { WiseOperationFailedError, type WiseFailure, type WiseRunInput } from "../wise/executor.js";
import { createWiseOperations } from "../wise/operations.js";
import {
  buildWiseResultDetailItems,
  digestMismatch,
  renderWiseFailure,
  renderWiseImportCompact,
  renderWiseImportFull,
  type WiseImportRenderData,
} from "../wise/presenter.js";

// Thin adapter: it registers `import_wise_transactions`, validates the digest
// input format, and routes to the typed WiseOperations facade (dry run /
// execute). All parsing/validation, byte-stable command building + digest,
// execution safety, and MCP-envelope shaping live in the ../wise/* modules.
// Domain failures reach the presenter two ways, mirroring CAMT: a thrown
// WiseOperationFailedError carries the rich kinds; the simple kinds arrive as an
// OperationOutcome error whose code is reprojected into its WiseFailure below.

// Re-exported for the identity-only consumers that still import through this
// module (e.g. wise-import.test). The definitions now live in the pure
// ../wise/* modules.
export { buildWiseTransactionSignature } from "../wise/preflight.js";
export { createdTransactionMatchesApprovedPayload, WISE_PLAN_DOMAIN } from "../wise/projection.js";
export type { TransactionCreatePayload } from "../wise/types.js";

export function registerWiseImportTools(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const operations = createWiseOperations(api, runtimeSafetyContext);

  // Guided profiles receive the token-lean compact Wise surface; standard/full
  // keep the byte-identical full envelope.
  const useCompactWise = (): boolean => {
    const profile = currentToolProfile();
    return profile === "guided" || profile === "guided-sales";
  };

  // Execute-only: mint an operation-result handle bound to the just-consumed
  // Wise plan so the compact response can reference get_operation_result_page
  // for the full per-row detail. Fail-safe — the import already mutated, so a
  // store failure degrades to a compact response without the handle.
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

  const compactResponse = (payload: { summary: unknown }) => ({
    content: [{ type: "text" as const, text: toMcpJson(payload) }],
  });

  // Reproject a simple-kind OperationOutcome error (which carries no data beyond
  // its discriminant) back into its WiseFailure so renderWiseFailure emits the
  // exact same envelope as before. The rich kinds never travel this path — they
  // are thrown as WiseOperationFailedError and rendered in the handler's catch.
  const simpleFailureFromCode = (code: string): WiseFailure => {
    switch (code) {
      case "plan_handle_required": return { kind: "plan_handle_required" };
      case "digest_mismatch": return { kind: "digest_mismatch" };
      case "ownership_reapproval_required": return { kind: "ownership_reapproval_required" };
      case "wise_client_not_found": return { kind: "wise_client_not_found" };
      default: throw new Error(`Unexpected Wise operation error code: ${code}`);
    }
  };

  function render(
    outcome: OperationOutcome<WiseImportRenderData>,
    executeRequested: boolean,
    planHandle: string | undefined,
  ) {
    if (!outcome.ok) return renderWiseFailure(simpleFailureFromCode(outcome.error.code));
    if (!useCompactWise()) return renderWiseImportFull(outcome.value);
    if (!executeRequested) {
      return compactResponse(renderWiseImportCompact({ mode: "DRY_RUN", data: outcome.value }));
    }
    const operationHandle = issueWiseResultHandle(outcome.value, planHandle);
    return compactResponse(renderWiseImportCompact({ mode: "EXECUTED", data: outcome.value, operationHandle }));
  }

  registerTool(server, "import_wise_transactions",
    "Import Wise transaction-history CSV rows. Direct-call contract: DRY RUN by default; execute=true creates rows; every created bank row uses API type C while source_direction preserves IN/OUT flow; fees use separate C transactions; inter-account transfers avoid double-counting confirmed counterpart journals.",
    {
      file_path: z.string().optional().describe("Absolute path/base64 Wise CSV input. Provide exactly one of file_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox Wise CSV reference. Provide exactly one of file_path or file_ref."),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID for the Wise account in e-arveldaja"),
      fee_account_dimensions_id: z.number().optional().describe("Account dimension ID for the Wise fee expense account."),
      fee_account_relation_id: z.number().optional().describe("Deprecated alias for fee_account_dimensions_id."),
      inter_account_dimension_id: coerceId.optional().describe(
        "Other bank account dimension ID for inter-account transfers. Auto-detected if only one other bank account exists; required with 3+ bank accounts."
      ),
      confirm_own_transfer_ids: z.array(z.string().min(1)).optional().describe(
        "Exact Wise IDs explicitly approved as own transfers. TRANSFER-* and BANK_DETAILS_PAYMENT_RETURN-* prefixes are hints only."
      ),
      approved_command_digest: z.string().regex(SHA256_HEX).optional().describe(
        "Exact lowercase SHA-256 command digest returned by the reviewed dry run. Required for execute=true when mutations are planned."
      ),
      plan_handle: z.string().optional().describe(
        "Execution-plan handle returned by the reviewed dry run. Required for execute=true in addition to approved_command_digest; the digest alone cannot execute."
      ),
      execute: z.boolean().optional().describe("Actually create transactions (default false = dry run)"),
      date_from: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").optional().describe("Only import transactions from this date (YYYY-MM-DD)"),
      date_to: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").optional().describe("Only import transactions up to this date (YYYY-MM-DD)"),
      skip_jar_transfers: z.boolean().optional().describe("Skip Jar (savings pot) transfers — internal movements within Wise (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Import Wise Transactions" },
    async ({
      file_path,
      file_ref,
      accounts_dimensions_id,
      fee_account_dimensions_id,
      fee_account_relation_id,
      inter_account_dimension_id,
      confirm_own_transfer_ids,
      approved_command_digest,
      plan_handle,
      execute,
      date_from,
      date_to,
      skip_jar_transfers,
    }) => {
      // Digest input-format gate, checked before any file read, ledger read,
      // cache flush, plan consume, or mutation.
      if (approved_command_digest !== undefined && (
        typeof approved_command_digest !== "string" || !SHA256_HEX.test(approved_command_digest)
      )) {
        return digestMismatch();
      }
      if (execute === true && !SHA256_HEX.test(approved_command_digest ?? "")) {
        return digestMismatch();
      }

      const source: FileInputSource = {
        ...(file_path !== undefined ? { file_path } : {}),
        ...(file_ref !== undefined ? { file_ref } : {}),
      };
      const runInput: WiseRunInput = {
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
      };

      try {
        const outcome = execute === true
          ? await operations.execute({ ...runInput, planHandle: plan_handle })
          : await operations.prepare(runInput);
        return render(outcome, execute === true, plan_handle);
      } catch (error) {
        if (error instanceof WiseOperationFailedError) return renderWiseFailure(error.failure);
        throw error;
      }
    }
  );
}
