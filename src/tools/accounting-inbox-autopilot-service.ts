import { createHash } from "crypto";
import { canonicalBusinessText, wrapUntrustedOcr, capUntrustedText } from "../mcp-json.js";
import { arrayAt, isRecord, numberAt, recordAt, stringArrayAt, stringAt } from "../record-utils.js";
import {
  buildCamtDuplicateReviewGuidance,
  type ReviewGuidance,
} from "../estonian-accounting-guidance.js";
import {
  buildReceiptDryRunPreview,
  receiptDryRunLeavesPendingMaterialization,
  summarizeReceiptDryRunPreview,
} from "./accounting-inbox-autopilot.js";
import type { OperationOutcome } from "../operation-outcome.js";
import type { AccountingOperations } from "../accounting-operations.js";
import type { CamtParseResult } from "../camt/types.js";
import type { CamtImportPreview } from "../camt/presenter.js";
import type { WiseImportPreview } from "../wise/presenter.js";
import { isNonErrorWiseSkipReason } from "../wise/preflight.js";
import type { ReceiptBatchResult } from "../receipts/types.js";
import type { UnmatchedAnalysisResult } from "../receipts/classification-operations.js";
import type { InterAccountPreview } from "../banking/reconciliation/types.js";

export interface AutopilotRecommendedStep {
  step: number;
  tool: string;
  purpose: string;
  recommended: boolean;
  suggested_args: Record<string, unknown>;
  missing_inputs: string[];
  reason: string;
}

export interface AutopilotPreparedInboxData {
  workspacePath: string;
  scan: {
    max_depth: number;
    scanned_directories: number;
    scanned_candidate_files: number;
    truncated: boolean;
  };
  camtFiles: unknown[];
  wiseFiles: unknown[];
  receiptFolders: unknown[];
  defaults: unknown;
  steps: AutopilotRecommendedStep[];
  questions: Array<{
    id: string;
    question: string;
    recommendation: string;
  }>;
  liveApiDefaultsAvailable: boolean;
}

/**
 * Freshness of the live ledger the autopilot's ledger-dependent steps read:
 * - `current`: no approved import is waiting to be materialized.
 * - `pending_imports`: an import/receipt dry run would create rows that are not
 *   yet in the ledger, so reading it now would reflect the OLD state.
 * - `failed`: an earlier import/receipt step failed, so the ledger is
 *   incomplete and unsafe to reconcile against.
 */
export type AutopilotMaterializationState = "current" | "pending_imports" | "failed";

export interface AutopilotStepResult {
  step: number;
  tool: string;
  status: "completed" | "skipped" | "failed" | "deferred";
  purpose: string;
  summary: string;
  suggested_args: Record<string, unknown>;
  preview?: Record<string, unknown>;
  /**
   * Set on a step deferred because the ledger it reads is not `current` (M12).
   * The step is safe to run only after the pending imports are materialized and
   * a fresh ledger is loaded.
   */
  materialization_state?: AutopilotMaterializationState;
}

export interface AutopilotFollowUp {
  /**
   * Deterministic, resume-stable identifier for a resolvable review item (see
   * stableReviewId). Present on every follow-up that carries a resolver_input
   * (CAMT/receipt/classification review items); absent on aggregate notices that
   * have nothing to resume against (e.g. a failed-step message).
   */
  id?: string;
  source: string;
  summary: string;
  recommendation?: string;
  compliance_basis?: string[];
  follow_up_questions?: string[];
  policy_hint?: string;
  resolver_input?: Record<string, unknown>;
}

export interface AutopilotReviewPage {
  /**
   * Number of review items on this page (i.e. `needs_accountant_review.length`).
   * Each resolvable item carries an `id`; a few aggregate notices (e.g. a
   * failed-step message) have none but are still counted as page rows.
   */
  total: number;
  /**
   * True when the page is guaranteed to contain every review item. The
   * summarizer never slices, so incompleteness can only come from upstream: a
   * truncated file scan may have missed CAMT/receipt files whose reviews would
   * belong here, so `complete` is false whenever `prepared.scan.truncated` is set.
   */
  complete: boolean;
}

export interface AccountingInboxDryRunPipelineResult {
  executed_step_count: number;
  skipped_step_count: number;
  executed_steps: AutopilotStepResult[];
  skipped_steps: AutopilotStepResult[];
  done_automatically: string[];
  needs_one_decision: AutopilotFollowUp[];
  needs_accountant_review: AutopilotFollowUp[];
  review_page: AutopilotReviewPage;
  next_question?: AutopilotFollowUp;
  next_recommended_action?: AutopilotRecommendedStep;
  user_summary: string;
}

/**
 * Deterministic, resume-stable identifier for one accountant-review item.
 *
 * The identity is a curated set of STABLE business keys spanning the three
 * review sources (CAMT possible-duplicate, receipt, classification group) — not
 * the whole item, whose free-text fields are wrapped with a per-call random
 * nonce (see wrapUntrustedOcr) and would change the id on every dry-run. Text
 * keys are run through canonicalBusinessText so a re-run that re-wraps the same
 * counterparty with a fresh nonce still yields the same id — that stability is
 * what makes a review item resumable by id across dry-runs.
 */
export function stableReviewId(sourceTool: string, item: Record<string, unknown>): string {
  const file = recordAt(item, "file");
  // Filesystem path is a trusted, per-item-unique key (two receipts can share a
  // name across folders); it is not OCR-derived, so it is used verbatim.
  const filePath = typeof item.file_path === "string" && item.file_path
    ? item.file_path
    : (file ? (stringAt(file, "path") ?? stringAt(file, "name") ?? "") : "");
  // Counterparty/reference arrive under different field names per source
  // (classification: normalized/display_counterparty; CAMT: counterparty,
  // bank_reference, ref_number) and may be nonce-wrapped, so canonicalize each
  // and take the first non-empty — an empty normalized value must not suppress a
  // present display value.
  const counterparty =
    canonicalBusinessText(item.normalized_counterparty)
    || canonicalBusinessText(item.display_counterparty)
    || canonicalBusinessText(item.counterparty);
  const reference =
    canonicalBusinessText(item.bank_reference)
    || canonicalBusinessText(item.bank_ref_number)
    || canonicalBusinessText(item.ref_number)
    || canonicalBusinessText(item.reference_number);
  // A reference-less CAMT row can still differ from another by direction and by
  // which existing transactions it matched, so fold both in: a debit and a
  // credit for the same date/amount/counterparty, or rows matched to different
  // candidates, get distinct ids. The candidate ids are sorted for determinism.
  const candidateIds = arrayAt(item, "existing_transactions")
    .map((candidate) => (isRecord(candidate) ? numberAt(candidate, "id") : undefined))
    .filter((id): id is number => id !== undefined)
    .sort((left, right) => left - right);
  const identity = JSON.stringify([
    sourceTool,
    item.transaction_id ?? null,
    item.new_transaction_api_id ?? null,
    filePath || null,
    canonicalBusinessText(item.category) || null,
    counterparty || null,
    item.date ?? null,
    item.amount ?? null,
    item.currency ?? null,
    typeof item.type === "string" ? item.type : null,
    reference || null,
    candidateIds,
  ]);
  return `${sourceTool}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function toAutopilotFollowUp(
  source: string,
  summary: string,
  guidance?: Partial<ReviewGuidance> & { recommendation?: string },
  resolverInput?: Record<string, unknown>,
): AutopilotFollowUp {
  // The resolver_input's `item`/`group` is the raw review record; derive the
  // resume-stable id from it and thread it back into resolver_input so the id
  // the caller sees is the same id continuation payloads carry.
  const identityItem = resolverInput
    ? (recordAt(resolverInput, "item") ?? recordAt(resolverInput, "group"))
    : undefined;
  const id = identityItem ? stableReviewId(source, identityItem) : undefined;
  const resolver_input = resolverInput && id !== undefined
    ? { ...resolverInput, id }
    : resolverInput;
  return {
    ...(id !== undefined ? { id } : {}),
    source,
    summary,
    recommendation: guidance?.recommendation,
    compliance_basis: guidance?.compliance_basis,
    follow_up_questions: guidance?.follow_up_questions,
    policy_hint: guidance?.policy_hint,
    resolver_input,
  };
}

function reviewGuidanceFromRecord(record: Record<string, unknown>): ReviewGuidance | undefined {
  const guidance = recordAt(record, "review_guidance");
  if (!guidance) return undefined;

  const recommendation = stringAt(guidance, "recommendation");
  if (!recommendation) return undefined;

  return {
    recommendation,
    compliance_basis: stringArrayAt(guidance, "compliance_basis"),
    follow_up_questions: stringArrayAt(guidance, "follow_up_questions"),
    policy_hint: stringAt(guidance, "policy_hint"),
  };
}

const PREREQ_TOOL_BY_DOWNSTREAM: Record<string, string> = {
  import_camt053: "parse_camt053",
};

function failedPrerequisiteForStep(
  step: AutopilotRecommendedStep,
  handledSteps: AutopilotStepResult[],
): string | undefined {
  const prereqTool = PREREQ_TOOL_BY_DOWNSTREAM[step.tool];
  if (!prereqTool) return undefined;

  const fileIdentity = step.suggested_args.file_ref ?? step.suggested_args.file_path;
  if (typeof fileIdentity !== "string") return undefined;

  const failedPrereq = handledSteps.find(prior =>
    prior.tool === prereqTool &&
    prior.status === "failed" &&
    (prior.suggested_args.file_ref ?? prior.suggested_args.file_path) === fileIdentity
  );
  return failedPrereq ? prereqTool : undefined;
}

function pickNextAutopilotRecommendedAction(
  prepared: AutopilotPreparedInboxData,
  handledSteps: AutopilotStepResult[],
  options: {
    hasPendingDecision: boolean;
    hasReviewFollowUp: boolean;
  },
): AutopilotRecommendedStep | undefined {
  if (options.hasPendingDecision || options.hasReviewFollowUp) {
    return undefined;
  }

  const handledStepNumbers = new Set(handledSteps.map(step => step.step));

  return prepared.steps.find((step) => {
    if (!step.recommended) return false;
    if (step.missing_inputs.length > 0) return false;
    if (handledStepNumbers.has(step.step)) return false;
    if (failedPrerequisiteForStep(step, handledSteps)) return false;
    return true;
  });
}

function fileInputSource(args: Record<string, unknown>): { file_path?: string; file_ref?: string } {
  const filePath = stringAt(args, "file_path");
  const fileRef = stringAt(args, "file_ref");
  return {
    ...(filePath !== undefined ? { file_path: filePath } : {}),
    ...(fileRef !== undefined ? { file_ref: fileRef } : {}),
  };
}

/**
 * Dispatch one recommended step to its typed operation on the AccountingOperations
 * facade, mapping the step's suggested_args to the operation's typed input. This
 * replaces the former captured-MCP-handler round-trip: there is no handler Map,
 * no serialized response, and no MCP-JSON decoding boundary — the caller reads the
 * typed OperationOutcome<T>.value directly. Only DRY-RUN read/preview methods are
 * bound (the autopilot never applies/mutates).
 */
function invokeAutopilotOperation(
  operations: AccountingOperations,
  tool: string,
  args: Record<string, unknown>,
): Promise<OperationOutcome<unknown>> {
  switch (tool) {
    case "parse_camt053":
      return operations.parseBankInput({ source: fileInputSource(args) });
    case "import_camt053":
      return operations.prepareCamtImport({
        source: fileInputSource(args),
        accountsDimensionsId: numberAt(args, "accounts_dimensions_id") ?? 0,
        dateFrom: stringAt(args, "date_from"),
        dateTo: stringAt(args, "date_to"),
      });
    case "import_wise_transactions":
      return operations.prepareWiseImport({
        source: fileInputSource(args),
        accountsDimensionsId: numberAt(args, "accounts_dimensions_id") ?? 0,
        feeAccountDimensionsId: numberAt(args, "fee_account_dimensions_id"),
        feeAccountRelationId: numberAt(args, "fee_account_relation_id"),
        interAccountDimensionId: numberAt(args, "inter_account_dimension_id"),
        confirmOwnTransferIds: undefined,
        approvedCommandDigest: undefined,
        dateFrom: stringAt(args, "date_from"),
        dateTo: stringAt(args, "date_to"),
        skipJarTransfers: undefined,
      });
    case "process_receipt_batch":
      return operations.prepareReceiptBatch({
        folderPath: stringAt(args, "folder_path") ?? "",
        accountsDimensionsId: numberAt(args, "accounts_dimensions_id") ?? 0,
        ...(stringAt(args, "date_from") !== undefined ? { dateFrom: stringAt(args, "date_from")! } : {}),
        ...(stringAt(args, "date_to") !== undefined ? { dateTo: stringAt(args, "date_to")! } : {}),
      });
    case "classify_unmatched_transactions":
      return operations.classifyTransactions({
        accountsDimensionsId: numberAt(args, "accounts_dimensions_id") ?? 0,
        ...(stringAt(args, "date_from") !== undefined ? { dateFrom: stringAt(args, "date_from")! } : {}),
        ...(stringAt(args, "date_to") !== undefined ? { dateTo: stringAt(args, "date_to")! } : {}),
      });
    case "reconcile_inter_account_transfers":
      return operations.prepareInterAccount({
        maxDateGap: numberAt(args, "max_date_gap"),
        targetAccountsDimensionsId: numberAt(args, "target_accounts_dimensions_id"),
      });
    default:
      throw new Error(`Internal inbox autopilot has no operation binding for ${tool}`);
  }
}

function summarizeAutopilotToolResult(
  tool: string,
  value: unknown,
): { summary: string; preview?: Record<string, unknown>; followUps: AutopilotFollowUp[] } {
  switch (tool) {
    case "parse_camt053": {
      const parsed = value as CamtParseResult;
      const entryCount = parsed.summary.entry_count;
      const duplicateCount = parsed.summary.duplicate_count;
      return {
        summary: `Parsed CAMT preview with ${entryCount} entries and ${duplicateCount} duplicate hint(s) inside the statement.`,
        preview: {
          entry_count: entryCount,
          duplicate_count: duplicateCount,
          iban: parsed.statement_metadata.iban,
        },
        followUps: [],
      };
    }
    case "import_camt053": {
      const preview = value as CamtImportPreview;
      const createdCount = preview.createdCount;
      const skippedCount = preview.projection.skipped.length;
      const errorCount = preview.errorCount;
      const reviewItems = preview.possibleDuplicates as unknown as Record<string, unknown>[];
      const reviewCount = reviewItems.length;
      return {
        summary: `CAMT dry run would create ${createdCount} transaction(s), skip ${skippedCount}, raise ${reviewCount} possible duplicate review item(s), and report ${errorCount} error(s).`,
        preview: {
          created_count: createdCount,
          skipped_count: skippedCount,
          possible_duplicate_count: reviewCount,
          error_count: errorCount,
        },
        followUps: reviewItems.map((item) => {
          const hasConfirmedMatch = arrayAt(item, "existing_transactions").some((candidate) =>
            isRecord(candidate) && stringAt(candidate, "status") === "CONFIRMED"
          );
          const duplicateGuidance = buildCamtDuplicateReviewGuidance({ hasConfirmedMatch });
          const date = stringAt(item, "date");
          const amount = numberAt(item, "amount");
          const currency = stringAt(item, "currency");
          const counterparty = stringAt(item, "counterparty");
          const existingIds = arrayAt(item, "existing_transactions")
            .filter(isRecord)
            .map((candidate) => numberAt(candidate, "id"))
            .filter((id): id is number => id !== undefined);
          const dateLabel = date ?? "unknown date";
          const amountLabel = amount !== undefined ? `${amount}${currency ? ` ${currency}` : ""}` : "unknown amount";
          const counterpartyLabel = counterparty ? ` for ${counterparty}` : "";
          const shownIds = existingIds.slice(0, 5);
          const hiddenCount = existingIds.length - shownIds.length;
          const existingIdsSummary = hiddenCount > 0
            ? `${shownIds.join(", ")}, +${hiddenCount} more`
            : shownIds.join(", ");
          const existingLabel = existingIds.length > 0
            ? ` against existing transaction${existingIds.length === 1 ? "" : "s"} ${existingIdsSummary}`
            : "";
          return toAutopilotFollowUp(
            tool,
            `CAMT row ${dateLabel} ${amountLabel}${counterpartyLabel} looks like a possible duplicate${existingLabel}.`,
            duplicateGuidance,
            {
              review_type: "camt_possible_duplicate",
              source_tool: tool,
              item,
            },
          );
        }),
      };
    }
    case "import_wise_transactions": {
      const preview = value as WiseImportPreview;
      // The Wise presenter splits the `skipped` render rows into non-error
      // skips vs errors by reason (isNonErrorWiseSkipReason). The summarizer must
      // reproduce that split so `error_count` / `skipped` match the former
      // decoded execution.summary exactly (M12 gating reads created/error counts).
      const created = preview.created.length;
      const skipped = preview.skipped.filter(entry => isNonErrorWiseSkipReason(entry.reason)).length;
      const errorCount = preview.skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason)).length;
      return {
        summary: `Wise dry run would create ${created} transaction(s), skip ${skipped}, and report ${errorCount} error(s).`,
        preview: {
          created,
          skipped,
          error_count: errorCount,
        },
        followUps: errorCount > 0
          ? [{
              source: tool,
              summary: `${errorCount} Wise CSV row(s) still failed preview.`,
              recommendation: "Review the Wise import errors before execute=true.",
            }]
          : [],
      };
    }
    case "process_receipt_batch": {
      const result = value as ReceiptBatchResult;
      const preview = buildReceiptDryRunPreview(result.summary as unknown as Record<string, unknown>);
      // Per-file review rows are the raw batch results with status needs_review.
      // sanitizeReceiptResultForOutput leaves file.name / classification RAW (it
      // wraps only OCR-derived extracted/supplier/error text), so the summary text
      // and stableReviewId identity are byte-identical to the former decoded rows.
      const reviewResults = result.results.filter(entry => entry.status === "needs_review") as unknown as Record<string, unknown>[];
      const followUps: AutopilotFollowUp[] = reviewResults
        .map((item) => {
          const file = recordAt(item, "file");
          const fileName = stringAt(file ?? {}, "name") ?? "receipt";
          const classification = stringAt(item, "classification") ?? "needs review";
          return toAutopilotFollowUp(
            tool,
            `${fileName} jäi dry-runis ülevaatuseks (${classification}).`,
            reviewGuidanceFromRecord(item) ?? {
              recommendation: "Vaata üle ainult see märgitud kviitung ning kinnita puudu olevad andmed või korrektne maksukäsitlus enne teostust.",
            },
            {
              review_type: "receipt_review",
              source_tool: tool,
              item,
            },
          );
        });
      if (preview.failed > 0) {
        followUps.push(toAutopilotFollowUp(
          tool,
          `${preview.failed} receipt(s) failed the dry run completely.`,
          {
            recommendation: "Kontrolli esmalt täpset extraction- või booking-viga; ilma piisava alusdokumendi või korrektse käsitluseta ei tohiks neid automaatselt läbi lasta.",
          },
        ));
      }
      return {
        summary: summarizeReceiptDryRunPreview(preview),
        preview,
        followUps,
      };
    }
    case "classify_unmatched_transactions": {
      // UNWRAPPED analysis value: the op returns camelCase totalUnmatched /
      // categoryCounts (the presenter renders the snake_case envelope); the
      // groups are the same ClassifiedTransactionGroupResult rows the presenter
      // wraps for output, so apply_mode/category are read raw here.
      const result = value as UnmatchedAnalysisResult;
      const groups = result.groups as unknown as Record<string, unknown>[];
      const reviewGroups = groups.filter((group) =>
        isRecord(group) && stringAt(group, "apply_mode") !== "purchase_invoice"
      );
      return {
        summary: `Classified ${result.totalUnmatched} unmatched transaction(s) into ${groups.length} group(s), of which ${reviewGroups.length} still need accounting judgement instead of auto-booking.`,
        preview: {
          total_unmatched: result.totalUnmatched,
          group_count: groups.length,
          category_counts: result.categoryCounts,
        },
        followUps: reviewGroups.map((group) => {
          const record = group as Record<string, unknown>;
          const displayCounterparty = stringAt(record, "display_counterparty") ?? "transaction group";
          const category = stringAt(record, "category") ?? "review_only";
          return toAutopilotFollowUp(
            tool,
            `${displayCounterparty} jäi ülevaatuseks kategoorias ${category}.`,
            reviewGuidanceFromRecord(record) ?? {
              recommendation: "Ära auto-booki seda gruppi ostuarvena enne, kui tehingu sisu ja alusdokumendid on kinnitatud.",
            },
            {
              review_type: "classification_group",
              source_tool: tool,
              group: record,
            },
          );
        }),
      };
    }
    case "reconcile_inter_account_transfers": {
      // The presenter builds execution.summary from the match arrays' lengths;
      // read the same lengths off the typed InterAccountPreview.match.
      const match = (value as InterAccountPreview).match;
      const matchedPairs = match.matchedPairs.length;
      const matchedOneSided = match.matchedOneSided.length;
      const ambiguous = match.ambiguousPairs.length;
      const skippedAlreadyHandled = match.skippedAlreadyHandled.length;
      const errorCount = match.errors.length;
      const followUps = ambiguous > 0
        ? [{
            source: tool,
            summary: `${ambiguous} inter-account transfer candidate(s) were ambiguous.`,
            recommendation: "Review only the ambiguous transfer pairs before confirming anything.",
          }]
        : [];
      return {
        summary: `Inter-account transfer dry run found ${matchedPairs} matched pair(s), ${matchedOneSided} one-sided match(es), ${ambiguous} ambiguous case(s), and ${errorCount} error(s).`,
        preview: {
          matched_pairs: matchedPairs,
          matched_one_sided: matchedOneSided,
          skipped_ambiguous: ambiguous,
          skipped_already_handled: skippedAlreadyHandled,
          error_count: errorCount,
        },
        followUps,
      };
    }
    default:
      return {
        summary: `${tool} completed successfully.`,
        preview: undefined,
        followUps: [],
      };
  }
}

function isAutopilotRunnableStep(step: AutopilotRecommendedStep, liveApiDefaultsAvailable: boolean): boolean {
  if (step.missing_inputs.length > 0) return false;
  if (!step.recommended) return false;
  if (liveApiDefaultsAvailable) return true;
  return step.tool === "parse_camt053";
}

function isMaterializationStep(tool: string): boolean {
  return tool === "import_camt053" ||
    tool === "import_wise_transactions" ||
    tool === "process_receipt_batch";
}

/**
 * Steps that READ the live ledger and would therefore act on stale data if an
 * approved import has not been materialized yet: classification of unmatched
 * transactions and inter-account transfer reconciliation. These are the only
 * ledger-reading tools the autopilot ever runs. Both are deferred until the
 * ledger is `current` (M12) — previously only classification was gated, so
 * reconciliation ran against the pre-import ledger.
 */
const LEDGER_DEPENDENT_TOOLS = new Set([
  "classify_unmatched_transactions",
  "reconcile_inter_account_transfers",
]);

function materializationStateFromBlockReason(
  reason: "pending_materialization" | "earlier_step_failed" | undefined,
): AutopilotMaterializationState {
  if (reason === "pending_materialization") return "pending_imports";
  if (reason === "earlier_step_failed") return "failed";
  return "current";
}

function leavesPendingMaterializationAfterDryRun(
  tool: string,
  preview: Record<string, unknown> | undefined,
): boolean {
  if (!preview) return false;

  switch (tool) {
    case "import_camt053":
      return (numberAt(preview, "created_count") ?? 0) > 0 ||
        (numberAt(preview, "possible_duplicate_count") ?? 0) > 0 ||
        (numberAt(preview, "error_count") ?? 0) > 0;
    case "import_wise_transactions":
      return (numberAt(preview, "created") ?? 0) > 0 ||
        (numberAt(preview, "error_count") ?? 0) > 0;
    case "process_receipt_batch":
      return receiptDryRunLeavesPendingMaterialization(preview);
    default:
      return false;
  }
}

export async function runAccountingInboxDryRunPipeline({
  prepared,
  operations,
}: {
  prepared: AutopilotPreparedInboxData;
  operations: AccountingOperations;
}): Promise<AccountingInboxDryRunPipelineResult> {
  const executedSteps: AutopilotStepResult[] = [];
  const skippedSteps: AutopilotStepResult[] = [];
  const doneAutomatically: string[] = [];
  const needsOneDecision: AutopilotFollowUp[] = prepared.questions.map(question => ({
    source: question.id,
    summary: question.question,
    recommendation: question.recommendation,
  }));
  const needsAccountantReview: AutopilotFollowUp[] = [];
  let materializationBlockReason: "pending_materialization" | "earlier_step_failed" | undefined;

  for (const step of prepared.steps) {
    const failedPrereqTool = failedPrerequisiteForStep(step, [...executedSteps, ...skippedSteps]);
    const runnable = isAutopilotRunnableStep(step, prepared.liveApiDefaultsAvailable);
    const blockedByMaterialization = LEDGER_DEPENDENT_TOOLS.has(step.tool) &&
      materializationBlockReason !== undefined;
    // A ledger-dependent step is DEFERRED (not merely skipped) only when the
    // stale ledger is its sole obstacle — an independent skip reason (failed
    // prerequisite, not runnable, missing inputs) keeps the ordinary "skipped"
    // status and its more specific message.
    const deferredForMaterialization = blockedByMaterialization &&
      !failedPrereqTool && runnable && step.missing_inputs.length === 0;
    if (failedPrereqTool || !runnable || blockedByMaterialization) {
      let skipSummary: string;
      let status: "skipped" | "deferred" = "skipped";
      let materializationState: AutopilotMaterializationState | undefined;
      if (deferredForMaterialization) {
        status = "deferred";
        materializationState = materializationStateFromBlockReason(materializationBlockReason);
        skipSummary = materializationBlockReason === "earlier_step_failed"
          ? `Deferred until approved imports are materialized and a fresh ledger is loaded: an earlier import or receipt step failed, so ${step.tool} would otherwise reflect an incomplete ledger.`
          : `Deferred until approved imports are materialized and a fresh ledger is loaded: earlier import or receipt steps still show pending changes, so ${step.tool} would otherwise reflect the old live ledger.`;
      } else if (failedPrereqTool) {
        skipSummary = `Skipped because prerequisite ${failedPrereqTool} failed for the same input.`;
      } else if (step.missing_inputs.length > 0) {
        skipSummary = `Skipped because ${step.missing_inputs.join(", ")} is still missing.`;
      } else if (!prepared.liveApiDefaultsAvailable && step.tool !== "parse_camt053") {
        skipSummary = "Skipped because live API-backed dry runs are unavailable until credentials are configured.";
      } else {
        skipSummary = "Skipped because this step is not currently marked as a safe default.";
      }
      skippedSteps.push({
        step: step.step,
        tool: step.tool,
        status,
        purpose: step.purpose,
        summary: skipSummary,
        suggested_args: step.suggested_args,
        ...(materializationState !== undefined ? { materialization_state: materializationState } : {}),
      });
      if (isMaterializationStep(step.tool) && materializationBlockReason === undefined) {
        materializationBlockReason = "earlier_step_failed";
      }
      continue;
    }

    try {
      const outcome = await invokeAutopilotOperation(operations, step.tool, step.suggested_args);
      if (!outcome.ok) {
        // A domain failure (ok:false) surfaces as a failed step, exactly like a
        // thrown operation error — the dry-run pipeline never proceeds on an
        // operation that did not produce a value.
        throw new Error(outcome.error.message);
      }
      const summarized = summarizeAutopilotToolResult(step.tool, outcome.value);
      executedSteps.push({
        step: step.step,
        tool: step.tool,
        status: "completed",
        purpose: step.purpose,
        summary: summarized.summary,
        suggested_args: step.suggested_args,
        preview: summarized.preview,
      });
      doneAutomatically.push(summarized.summary);
      needsAccountantReview.push(...summarized.followUps);
      if (leavesPendingMaterializationAfterDryRun(step.tool, summarized.preview)) {
        materializationBlockReason = "pending_materialization";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Import-step errors (Wise/CAMT parsing) can embed raw counterparty-
      // controlled CSV cell/header bytes in their message. Cap and sandbox-wrap
      // it before it reaches MCP output so it cannot smuggle instructions.
      const safeMessage = wrapUntrustedOcr(capUntrustedText(message).text) ?? message;
      executedSteps.push({
        step: step.step,
        tool: step.tool,
        status: "failed",
        purpose: step.purpose,
        summary: safeMessage,
        suggested_args: step.suggested_args,
      });
      needsAccountantReview.push({
        source: step.tool,
        summary: `${step.tool} failed during autopilot dry run: ${safeMessage}`,
        recommendation: "Inspect this specific step before relying on the automatic first pass.",
      });
      if (isMaterializationStep(step.tool) && materializationBlockReason === undefined) {
        materializationBlockReason = "earlier_step_failed";
      }
    }
  }

  const nextQuestion = needsOneDecision[0];
  const nextRecommendedAction = pickNextAutopilotRecommendedAction(prepared, [...executedSteps, ...skippedSteps], {
    hasPendingDecision: needsOneDecision.length > 0,
    hasReviewFollowUp: needsAccountantReview.length > 0,
  });

  return {
    executed_step_count: executedSteps.length,
    skipped_step_count: skippedSteps.length,
    executed_steps: executedSteps,
    skipped_steps: skippedSteps,
    done_automatically: doneAutomatically,
    needs_one_decision: needsOneDecision,
    needs_accountant_review: needsAccountantReview,
    // No review item is ever sliced away; the page is complete unless the
    // upstream file scan was truncated and may have missed source files.
    review_page: { total: needsAccountantReview.length, complete: !prepared.scan.truncated },
    next_question: nextQuestion,
    next_recommended_action: nextRecommendedAction,
    user_summary: doneAutomatically.length > 0
      ? `Ran ${executedSteps.length} safe dry-run step(s) automatically. ${needsOneDecision.length} small decision(s) and ${needsAccountantReview.length} review item(s) remain.`
      : `No safe dry-run steps could be completed automatically yet. ${needsOneDecision.length} small decision(s) and ${needsAccountantReview.length} review item(s) remain.`,
  };
}
