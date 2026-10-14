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
import { journalReviewClause, type CamtImportPreview } from "../camt/presenter.js";
import { isCamtJournalReviewRow } from "../camt/projection.js";
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
 * - `pending_input`: an earlier import/receipt step was skipped (missing input,
 *   prerequisite, or credentials), so the ledger is incomplete until it runs.
 */
export type AutopilotMaterializationState = "current" | "pending_imports" | "failed" | "pending_input";

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
  /** Set when the same review item was raised by more than one step (e.g.
   * overlapping CAMT statements); lists those steps' numbers. */
  seen_in_steps?: number[];
  /** Internal only (never emitted): positive leg identity used to merge
   * repeats of one CAMT review item across steps. */
  merge_key?: string;
}

/** Internal merge identity of a CAMT review row: only a row with a bank
 * reference and a leg identity is positively identified; anything else is
 * never merged. */
function camtReviewMergeKey(fields: {
  category: string;
  review_code?: string;
  bank_reference?: unknown;
  movement_identity?: unknown;
  journal_ids?: readonly number[];
  transaction_ids?: readonly number[];
}): string | undefined {
  if (typeof fields.bank_reference !== "string" || fields.bank_reference.trim().length === 0) return undefined;
  if (typeof fields.movement_identity !== "string" || fields.movement_identity.length === 0) return undefined;
  const sorted = (ids: readonly number[] | undefined) => [...(ids ?? [])].sort((a, b) => a - b);
  return JSON.stringify({
    category: fields.category,
    review_code: fields.review_code ?? null,
    movement_identity: fields.movement_identity,
    journal_ids: sorted(fields.journal_ids),
    transaction_ids: sorted(fields.transaction_ids),
  });
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
  const memberIds = arrayAt(item, "transactions")
    .map((member) => (isRecord(member) ? numberAt(member, "id") : undefined))
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
    // A classification group is its member rows: two groups of one counterparty
    // and category (split by direction or history) must not share an id.
    ...(memberIds.length > 0 ? [memberIds] : []),
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
        // The pipeline discards plan handles (like receipts below), so minting
        // one per dry run would leak plan-store slots until approval paths hit
        // plan_capacity_exceeded. The approval handle comes from the tool's own
        // dry run.
        mintPlanHandles: false,
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
        mintPlanHandle: false,
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
        mintPlanHandles: false,
      });
    default:
      throw new Error(`Internal inbox autopilot has no operation binding for ${tool}`);
  }
}

/** Per-code follow-up for a Wise transfer review row. */
function wiseReviewRecommendation(review: WiseImportPreview["ownershipReviews"][number]): string {
  switch (review.code) {
    case "wise_transfer_ownership_unverified":
      return "Verify that both accounts belong to the company, then rerun the Wise dry run with this wise_id in confirm_own_transfer_ids before execute=true.";
    case "wise_transfer_dimensions_unverified":
      return "Rerun the Wise dry run with inter_account_dimension_id naming the company's other own bank account in this transfer (and make sure the Wise account is a configured bank account) before execute=true.";
    case "wise_untagged_ledger_match":
      return `Advisory only: the row is still imported, no rerun is needed. Compare it with stored transaction(s) ${(review.ledger_transaction_ids ?? []).join(", ") || "named in the reason"}; if they are the same movement, delete one of them after the owner approves.`;
    case "wise_transfer_journal_ambiguous":
      return `Show the owner candidate journal(s) ${(review.candidate_journal_ids ?? []).join(", ")}. Only if the owner picks the one that books exactly this transfer, rerun the Wise dry run with journalized_transfer_ids [{ wise_id, journal_id }] (a new preview and digest); otherwise the row is created unconfirmed and reconciled later.`;
    case "wise_transfer_journal_inconsistent":
      return `Journal(s) ${(review.candidate_journal_ids ?? []).join(", ")} carry this Wise ID but do not book this amount and direction. Correct or remove the labelled journal with the owner's approval, then rerun the Wise dry run; the row is created unconfirmed meanwhile.`;
    case "wise_transfer_mapping_rejected":
      return `The journalized_transfer_ids mapping${review.journal_id !== undefined ? ` to journal ${review.journal_id}` : ""} was rejected; tell the owner why, fix or drop the mapping and rerun the Wise dry run. The row resolves as if unmapped meanwhile.`;
    case "unused_mapping":
      return "Tell the owner this journalized_transfer_ids mapping did nothing (row absent or already imported); drop it and rerun the Wise dry run.";
    case "wise_legacy_leg_ambiguous":
      return "This leg and its fee are not imported. Compare the stored row with the Wise statement and book the missing leg manually with the owner.";
    case "wise_transfer_cross_currency":
      return "The row is created unconfirmed; after the import, reconcile it as an inter-account transfer with the correct per-account amounts.";
    case "wise_transfer_already_imported":
      return "The transfer is already stored; confirm_own_transfer_ids does not act on it. Reconcile the existing bank transaction as an inter-account transfer.";
    default:
      return "Resolve this transfer as described, then rerun the Wise dry run before execute=true.";
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
      // Skipped rows an existing journal may already book stay unimported;
      // the approval summary must name them (see DRY_RUN_TOOL_REGISTRY).
      const journalReviewCount = preview.projection.skipped.filter(isCamtJournalReviewRow).length;
      return {
        summary: `CAMT dry run would create ${createdCount} transaction(s), skip ${skippedCount}${journalReviewClause(journalReviewCount)}, raise ${reviewCount} possible duplicate review item(s), and report ${errorCount} error(s).`,
        preview: {
          created_count: createdCount,
          skipped_count: skippedCount,
          possible_duplicate_count: reviewCount,
          journal_review_count: journalReviewCount,
          error_count: errorCount,
        },
        followUps: [...reviewItems.map((item) => {
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
          const mergeKey = camtReviewMergeKey({
            category: "camt_possible_duplicate",
            bank_reference: item.bank_reference,
            movement_identity: item.movement_identity,
            transaction_ids: existingIds,
          });
          return {
            ...toAutopilotFollowUp(
              tool,
              `CAMT row ${dateLabel} ${amountLabel}${counterpartyLabel} looks like a possible duplicate${existingLabel}.`,
              duplicateGuidance,
              {
                review_type: "camt_possible_duplicate",
                source_tool: tool,
                item,
              },
            ),
            ...(mergeKey !== undefined ? { merge_key: mergeKey } : {}),
          };
        }),
        // Rows not created because an existing journal may already book them,
        // or because a previous release imported their entry only in part.
        ...preview.projection.skipped.filter((row) => isCamtJournalReviewRow(row) || row.review_note !== undefined).map((row) => {
          const journalReview = isCamtJournalReviewRow(row);
          const mergeKey = camtReviewMergeKey({
            category: journalReview ? "camt_journal_review" : "camt_partial_legacy",
            review_code: row.review_code,
            bank_reference: row.bank_reference,
            movement_identity: row.movement_identity,
            journal_ids: row.journal_ids,
            transaction_ids: row.duplicate_transaction_ids,
          });
          // A direct action, not a continuation: no resolver handles these rows,
          // so there is no resolver_input; the id still makes the item resumable.
          return {
            ...(mergeKey !== undefined ? { merge_key: mergeKey } : {}),
            id: stableReviewId(tool, {
              category: journalReview ? "camt_journal_review" : "camt_partial_legacy",
              date: row.date,
              amount: row.amount,
              bank_reference: row.bank_reference,
              existing_transactions: (row.journal_ids ?? []).map(id => ({ id })),
            }),
            ...toAutopilotFollowUp(
              tool,
              `CAMT row ${row.date} ${row.amount} was not created: ${!journalReview
                ? "a previous release imported its statement entry only in part"
                : row.review_code === "camt_duplicate_journal_conflict" || row.review_code === "camt_journal_direction_conflict"
                  ? `an existing confirmed transaction is booked wrongly (wrong direction or amount) and needs correction (${row.review_code})`
                  : `an existing journal may already book it (${row.review_code})`}.`,
              { recommendation: row.review_note ?? row.reason },
            ),
          };
        })],
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
      // Ownership/dimension reviews are the Wise preview's own needs_review rows:
      // an unverified own-account transfer must never read as approvable. One
      // follow-up per review, keyed by wise_id so the id is resume-stable.
      const wiseReviewId = (...key: string[]) =>
        `${tool}:${createHash("sha256").update(JSON.stringify([tool, ...key])).digest("hex").slice(0, 16)}`;
      // Rows held for their counterpart collapse into ONE follow-up, scoped to
      // this file and Wise account; the other rows are unaffected.
      const counterpart = preview.transferCounterpart;
      const ownershipFollowUps: AutopilotFollowUp[] = preview.ownershipReviews
        .filter(review => counterpart === undefined || review.counterpart_candidate_dimension_ids === undefined)
        .map(review => ({
          id: wiseReviewId("wise_transfer_review", review.wise_id, review.code),
          source: tool,
          summary: `Wise transfer ${review.wise_id} needs review (${review.code}): ${review.reason}`,
          recommendation: wiseReviewRecommendation(review),
        }));
      if (counterpart !== undefined) {
        const candidates = counterpart.candidates
          .map(candidate => `${candidate.label} (${candidate.accounts_dimensions_id})`)
          .join(", ");
        const held = counterpart.unresolved_row_count + counterpart.conflict_row_count;
        ownershipFollowUps.unshift({
          id: wiseReviewId("wise_transfer_counterpart_unresolved", preview.sourceIdentity.digest_sha256, String(preview.accountsDimensionsId)),
          source: tool,
          summary: `${held} Wise transfer row(s) are held for their counterpart bank account (wise_transfer_counterpart_unresolved: ${counterpart.unresolved_row_count} unresolved, ${counterpart.conflict_row_count} contradicted by own-account evidence); own bank account(s): ${candidates}. The other rows are unaffected.`,
          recommendation: "Import the other bank's statement first, or ask the owner which own bank account the held Wise transfers go to and from, then answer accounting_inbox with wise_inter_account_dimension_id (or rerun the Wise dry run with inter_account_dimension_id). Evidence on another bank is never overridden.",
        });
      }
      // Invoice FX corrections are advisory only (the import never applies
      // them); surface each so the manual correction is not silently dropped.
      const invoiceFixFollowUps: AutopilotFollowUp[] = preview.invoiceFixCandidates.map(fix => ({
        id: wiseReviewId("wise_invoice_currency_advisory", fix.wise_id, String(fix.invoice_id)),
        source: tool,
        summary: `Wise row ${fix.wise_id} settles invoice ${fix.invoice_number}: ${fix.proposed_action}`,
        recommendation: "Advisory only: the Wise import does not change the invoice. Apply the correction by hand if it is right.",
      }));
      return {
        summary: `Wise dry run would create ${created} transaction(s), skip ${skipped}, and report ${errorCount} error(s).`,
        preview: {
          created,
          skipped,
          error_count: errorCount,
          needs_review: preview.ownershipReviews.length,
          command_count: preview.commands.length,
          ...(counterpart !== undefined
            ? { transfer_counterpart_unresolved: counterpart.unresolved_row_count + counterpart.conflict_row_count }
            : {}),
        },
        followUps: [
          ...ownershipFollowUps,
          ...invoiceFixFollowUps,
          ...(errorCount > 0
            ? [{
                source: tool,
                summary: `${errorCount} Wise CSV row(s) still failed preview.`,
                recommendation: "Review the Wise import errors before execute=true.",
              }]
            : []),
        ],
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
      // F6: rows the ledger check took out of classification must stay in the
      // inbox as review items, or they would vanish from it.
      const partitionFollowUp = (
        reviewType: string,
        row: { transaction_id: number; date: string; amount: number; counterparty?: string; next_action: string },
        what: string,
      ) => {
        const counterparty = row.counterparty !== undefined ? wrapUntrustedOcr(row.counterparty) : undefined;
        // A direct action, not a continuation: no resolver handles these rows,
        // so there is no resolver_input; the id still makes the item resumable.
        return {
          id: stableReviewId(tool, { ...row, category: reviewType }),
          ...toAutopilotFollowUp(
            tool,
            `Transaction ${row.transaction_id} (${row.date} ${row.amount}${counterparty ? ` ${counterparty}` : ""}) ${what}`,
            { recommendation: row.next_action },
          ),
        };
      };
      const partitionFollowUps: AutopilotFollowUp[] = [
        ...result.alreadyBooked.map((row) => partitionFollowUp(
          "classification_already_booked", row, `is already booked by journal ${row.journal_ids.join(", ")} (same bank reference).`)),
        ...result.ownTransfers.map((row) => partitionFollowUp(
          "classification_own_transfer", row, row.target_dimension_id !== null
            ? `is a transfer to/from own account dimension ${row.target_dimension_id}.`
            : "is a transfer between own accounts with no single target account.")),
        ...result.possibleDuplicates.map((row) => partitionFollowUp(
          "classification_possible_duplicate", row, row.code === "camt_marker_unverified"
            ? "has a CAMT marker whose checksum does not verify, so its direction and counterparty account are unproven (camt_marker_unverified)."
            : `may already be booked (${row.code}).`)),
        ...(result.ledgerContextUnavailable !== undefined
          ? [{
              source: tool,
              summary: result.ledgerContextUnavailable,
              recommendation: "Re-run the classification once the journals and bank accounts can be read, before booking anything from it.",
            }]
          : []),
      ];
      return {
        summary: `Classified ${result.totalUnmatched} unmatched transaction(s) into ${groups.length} group(s), of which ${reviewGroups.length} still need accounting judgement instead of auto-booking.`
          + (result.totalPartitionedOut > 0
            ? ` ${result.totalPartitionedOut} more were taken out by the ledger check (${result.alreadyBooked.length} already booked, ${result.ownTransfers.length} own transfer(s), ${result.possibleDuplicates.length} possible duplicate(s)).`
            : ""),
        preview: {
          total_unmatched: result.totalUnmatched,
          group_count: groups.length,
          category_counts: result.categoryCounts,
          total_partitioned_out: result.totalPartitionedOut,
          already_booked: result.alreadyBooked.length,
          own_transfers: result.ownTransfers.length,
          possible_duplicates: result.possibleDuplicates.length,
        },
        followUps: [...partitionFollowUps, ...reviewGroups.map((group) => {
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
        })],
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
      const ambiguousRefless = match.ambiguousRefless ?? [];
      const crossCurrency = match.crossCurrencyPairs ?? [];
      const proposedMirrors = match.skippedAlreadyHandled.filter(row => row.mirror_proposal !== undefined);
      // Every held row is its own follow-up with its ids: a count alone reads
      // as "clean" when transfers are held for review and never booked. The
      // reasons are server-built (ids, amounts, own account titles).
      const transferFollowUp = (category: string, ids: number[], summary: string, recommendation: string): AutopilotFollowUp => ({
        id: `${tool}:${createHash("sha256").update(JSON.stringify([tool, category, ...ids])).digest("hex").slice(0, 16)}`,
        source: tool,
        summary,
        recommendation,
      });
      const followUps: AutopilotFollowUp[] = [
        ...match.ambiguousPairs.map(pair => transferFollowUp(
          "inter_account_ambiguous_pair",
          [pair.outgoing_transaction_id, ...pair.candidate_incoming_transaction_ids],
          `Inter-account transaction ${pair.outgoing_transaction_id} is ambiguous (${pair.code ?? "ambiguous_pair"}): ${pair.reason}`,
          "Check the bank statements and resolve this pair with the owner before confirming anything; it is not in the plan.",
        )),
        ...ambiguousRefless.map(row => transferFollowUp(
          row.code ?? "ambiguous_refless",
          row.transaction_ids,
          `Inter-account transaction(s) ${row.transaction_ids.join(", ")} need review (${row.code ?? "ambiguous_refless"}): ${row.reason}`,
          "Held out of the plan. Check the bank statements and resolve these rows with the owner; delete or confirm a row only after explicit approval.",
        )),
        ...crossCurrency.map(row => transferFollowUp(
          "cross_currency",
          row.transaction_ids,
          `Inter-account transaction(s) ${row.transaction_ids.join(", ")} are a cross-currency pair (${row.amount_out} out / ${row.amount_in} in): ${row.reason}`,
          "Held out of the plan. Confirm each leg with the correct per-account amounts after the owner approves.",
        )),
        ...proposedMirrors.map(row => transferFollowUp(
          "mirror_proposal",
          [row.transaction_id],
          `PROJECT transaction ${row.transaction_id} looks like the mirror of confirmed transaction ${row.mirror_proposal!.counterpart_transaction_id}, `
            + `already booked by journal ${row.mirror_proposal!.journal_id} (evidence: ${row.mirror_proposal!.evidence.join(", ")}).`,
          `Report only: verify against both bank statements, then delete transaction ${row.transaction_id} only after the owner explicitly approves (delete_transaction, available on the standard/full profile). Reconcile never deletes it.`,
        )),
        ...match.errors.map(row => transferFollowUp(
          row.code ?? "inter_account_error",
          row.transaction_ids,
          `Inter-account transaction(s) ${row.transaction_ids.join(", ")} failed (${row.code ?? "inter_account_error"}): ${row.reason}`,
          "Resolve this error before confirming the related transfer.",
        )),
      ];
      return {
        summary: `Inter-account transfer dry run found ${matchedPairs} matched pair(s), ${matchedOneSided} one-sided match(es), ${ambiguous} ambiguous case(s), `
          + `${ambiguousRefless.length} held for review, ${crossCurrency.length} cross-currency pair(s), ${proposedMirrors.length} proposed mirror deletion(s), and ${errorCount} error(s).`,
        preview: {
          matched_pairs: matchedPairs,
          matched_one_sided: matchedOneSided,
          skipped_ambiguous: ambiguous,
          skipped_already_handled: skippedAlreadyHandled,
          needs_review_ambiguous_refless: ambiguousRefless.length,
          cross_currency: crossCurrency.length,
          proposed_mirrors: proposedMirrors.length,
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

type MaterializationBlockReason = "pending_materialization" | "earlier_step_failed" | "skipped_prerequisite";

function materializationStateFromBlockReason(
  reason: MaterializationBlockReason | undefined,
): AutopilotMaterializationState {
  if (reason === "pending_materialization") return "pending_imports";
  if (reason === "earlier_step_failed") return "failed";
  if (reason === "skipped_prerequisite") return "pending_input";
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
        (numberAt(preview, "needs_review") ?? 0) > 0 ||
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
    id: question.id,
    source: question.id,
    summary: question.question,
    recommendation: question.recommendation,
  }));
  const needsAccountantReview: AutopilotFollowUp[] = [];
  // Overlapping statements raise the same CAMT review item once per file. A
  // positively identified item (merge_key) is kept once per occurrence: the
  // merged multiplicity is the maximum count any single step raised, so two
  // distinct legs one file raises never collapse into one.
  const keptByMergeKey = new Map<string, AutopilotFollowUp[]>();
  const stepsByItem = new Map<AutopilotFollowUp, number[]>();
  const mergeStepFollowUps = (stepNumber: number, accountId: number | undefined, followUps: AutopilotFollowUp[]) => {
    const countThisStep = new Map<string, number>();
    for (const followUp of followUps) {
      if (followUp.merge_key === undefined) {
        needsAccountantReview.push(followUp);
        continue;
      }
      const key = JSON.stringify([accountId ?? null, followUp.merge_key]);
      const occurrence = countThisStep.get(key) ?? 0;
      countThisStep.set(key, occurrence + 1);
      const kept = keptByMergeKey.get(key) ?? [];
      keptByMergeKey.set(key, kept);
      // The n-th occurrence in this step is the n-th kept item: only that item
      // gains this step's provenance.
      if (occurrence < kept.length) {
        stepsByItem.get(kept[occurrence]!)!.push(stepNumber);
      } else {
        kept.push(followUp);
        stepsByItem.set(followUp, [stepNumber]);
        needsAccountantReview.push(followUp);
      }
    }
  };
  let materializationBlockReason: MaterializationBlockReason | undefined;

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
          : materializationBlockReason === "skipped_prerequisite"
            ? `Deferred until the skipped import or receipt step can run: it still needs input or a prerequisite, so ${step.tool} would otherwise reflect an incomplete ledger.`
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
        // Skipped, not failed: the step never ran, so the ledger is waiting on
        // input rather than broken.
        materializationBlockReason = "skipped_prerequisite";
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
      mergeStepFollowUps(step.step, numberAt(step.suggested_args, "accounts_dimensions_id"), summarized.followUps);
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

  for (const [index, item] of needsAccountantReview.entries()) {
    const { merge_key: _mergeKey, ...publicItem } = item;
    const steps = stepsByItem.get(item);
    needsAccountantReview[index] = steps !== undefined && steps.length > 1
      ? { ...publicItem, seen_in_steps: steps }
      : publicItem;
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
