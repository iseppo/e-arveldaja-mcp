import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { isStrictDate } from "../strict-date.js";
import { batch } from "../annotations.js";
import { toMcpJson } from "../mcp-json.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { FileInputSource } from "../file-input-snapshot.js";
import type { OperationOutcome } from "../operation-outcome.js";
import { currentToolProfile, isGuidedProfile } from "../tool-profile.js";
import { ISO_DATE_REGEX } from "../wise/preflight.js";
import { SHA256_HEX } from "../wise/projection.js";
import { WiseOperationFailedError, type WiseRunInput } from "../wise/executor.js";
import { createWiseOperations } from "../wise/operations.js";
import {
  issueWiseResultHandle,
  renderWiseFailure,
  renderWiseImportCompact,
  renderWiseImportFull,
  simpleWiseFailureFromCode,
  wiseDigestInputRejection,
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
  const useCompactWise = (): boolean => isGuidedProfile(currentToolProfile());

  const compactResponse = (payload: { summary: unknown }) => ({
    content: [{ type: "text" as const, text: toMcpJson(payload) }],
  });

  function render(
    outcome: OperationOutcome<WiseImportRenderData>,
    executeRequested: boolean,
    planHandle: string | undefined,
  ) {
    if (!outcome.ok) return renderWiseFailure(simpleWiseFailureFromCode(outcome.error.code));
    if (!useCompactWise()) return renderWiseImportFull(outcome.value);
    if (!executeRequested) {
      return compactResponse(renderWiseImportCompact({ data: outcome.value }));
    }
    const operationHandle = issueWiseResultHandle(runtimeSafetyContext.operationResultStore, outcome.value, planHandle);
    return compactResponse(renderWiseImportCompact({ data: outcome.value, operationHandle }));
  }

  registerTool(server, "import_wise_transactions",
    "Import Wise transaction-history CSV rows. Direct-call contract: DRY RUN by default; execute=true creates rows; each created bank row carries the API type of its true direction (incoming IN → type D, outgoing OUT → type C) and source_direction records that same flow; fees are separate outgoing (type C) transactions; inter-account transfers avoid double-counting confirmed counterpart journals.",
    {
      file_path: z.string().optional().describe("Absolute path/base64 Wise CSV input. Provide exactly one of file_path or file_ref."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox Wise CSV reference. Provide exactly one of file_path or file_ref."),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID for the Wise account in e-arveldaja. Must be the dimension of a configured bank account; otherwise refused with wise_dimension_not_bank_account before any write."),
      fee_account_dimensions_id: z.number().optional().describe("Account dimension ID for the Wise fee expense account."),
      fee_account_relation_id: z.number().optional().describe("Deprecated alias for fee_account_dimensions_id."),
      inter_account_dimension_id: coerceId.optional().describe(
        "Other bank account dimension ID for inter-account transfers. Auto-detected if only one other bank account exists. Per row, own-account evidence on another bank decides first and this id is the fallback; a row whose counterpart cannot be determined or whose evidence contradicts this id is held (not imported), the other rows are planned."
      ),
      confirm_own_transfer_ids: z.array(z.string().min(1)).optional().describe(
        "Exact Wise IDs explicitly approved as own transfers. TRANSFER-* and BANK_DETAILS_PAYMENT_RETURN-* prefixes are hints only."
      ),
      journalized_transfer_ids: z.array(z.object({ wise_id: z.string().min(1), journal_id: coerceId })).optional().describe(
        "Exact { wise_id, journal_id } pairs the operator has checked: the labelled inter-account journal already books that Wise transfer (resolves a wise_transfer_journal_ambiguous review). Each mapping is validated; a rejected one is reported and the row resolves as if unmapped (it may still be skipped as already journalized, or held for review)."
      ),
      acknowledged_journal_holds: z.array(z.object({ wise_id: z.string().min(1), journal_ids: z.array(coerceId).min(1) })).optional().describe(
        "Owner-confirmed only: { wise_id, journal_ids } stating those journals do NOT book that held Wise transfer. Releases the row (imported and confirmed normally) only when journal_ids lists every required_acknowledgement_ids journal of its review; never for counterpart, identity or untagged-row holds."
      ),
      counterpart_overrides: z.array(z.object({ wise_id: z.string().min(1), dimension_id: coerceId })).optional().describe(
        "Owner-confirmed only: { wise_id, dimension_id } picking the own bank account a transfer row goes to or from when its own-account evidence points to several (wise_transfer_counterpart_conflict). The pick must be one of the evidenced accounts, else the row stays held; an entry that decides nothing is reported (unused_counterpart_override)."
      ),
      approved_command_digest: z.string().regex(SHA256_HEX).optional().describe(
        "Exact lowercase SHA-256 command digest returned by the reviewed dry run. Required for execute=true when mutations are planned."
      ),
      plan_handle: z.string().optional().describe(
        "Execution-plan handle returned by the reviewed dry run. Required for execute=true in addition to approved_command_digest; the digest alone cannot execute."
      ),
      execute: z.boolean().optional().describe("Actually create transactions (default false = dry run)"),
      date_from: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").refine(isStrictDate, "Expected a real calendar date (canonical YYYY-MM-DD)").optional().describe("Only import transactions from this date (YYYY-MM-DD)"),
      date_to: z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").refine(isStrictDate, "Expected a real calendar date (canonical YYYY-MM-DD)").optional().describe("Only import transactions up to this date (YYYY-MM-DD)"),
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
      journalized_transfer_ids,
      acknowledged_journal_holds,
      counterpart_overrides,
      approved_command_digest,
      plan_handle,
      execute,
      date_from,
      date_to,
      skip_jar_transfers,
    }) => {
      // Digest input-format gate, checked before any file read, ledger read,
      // cache flush, plan consume, or mutation.
      const digestRejection = wiseDigestInputRejection(approved_command_digest, execute === true);
      if (digestRejection) return digestRejection;

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
        journalizedTransferIds: journalized_transfer_ids,
        acknowledgedJournalHolds: acknowledged_journal_holds,
        counterpartOverrides: counterpart_overrides,
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
