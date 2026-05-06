import { parseMcpResponse } from "../mcp-json.js";
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

export interface AutopilotStepResult {
  step: number;
  tool: string;
  status: "completed" | "skipped" | "failed";
  purpose: string;
  summary: string;
  suggested_args: Record<string, unknown>;
  preview?: Record<string, unknown>;
}

export interface AutopilotFollowUp {
  source: string;
  summary: string;
  recommendation?: string;
  compliance_basis?: string[];
  follow_up_questions?: string[];
  policy_hint?: string;
  resolver_input?: Record<string, unknown>;
}

export interface AccountingInboxDryRunPipelineResult {
  executed_step_count: number;
  skipped_step_count: number;
  executed_steps: AutopilotStepResult[];
  skipped_steps: AutopilotStepResult[];
  done_automatically: string[];
  needs_one_decision: AutopilotFollowUp[];
  needs_accountant_review: AutopilotFollowUp[];
  next_question?: AutopilotFollowUp;
  next_recommended_action?: AutopilotRecommendedStep;
  user_summary: string;
}

export type AutopilotInternalToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text?: string }> }>;

function toAutopilotFollowUp(
  source: string,
  summary: string,
  guidance?: Partial<ReviewGuidance> & { recommendation?: string },
  resolverInput?: Record<string, unknown>,
): AutopilotFollowUp {
  return {
    source,
    summary,
    recommendation: guidance?.recommendation,
    compliance_basis: guidance?.compliance_basis,
    follow_up_questions: guidance?.follow_up_questions,
    policy_hint: guidance?.policy_hint,
    resolver_input: resolverInput,
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

  const filePath = step.suggested_args.file_path;
  if (typeof filePath !== "string") return undefined;

  const failedPrereq = handledSteps.find(prior =>
    prior.tool === prereqTool &&
    prior.status === "failed" &&
    prior.suggested_args.file_path === filePath
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

async function invokeInternalTool(
  handlers: Map<string, AutopilotInternalToolHandler>,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = handlers.get(tool);
  if (!handler) {
    throw new Error(`Internal inbox autopilot could not find tool handler for ${tool}`);
  }

  const result = await handler(args);
  const text = result.content[0]?.text;
  if (!text) {
    throw new Error(`Internal inbox autopilot received no text payload from ${tool}`);
  }

  const parsed = parseMcpResponse(text);
  if (!isRecord(parsed)) {
    throw new Error(`Internal inbox autopilot expected an object payload from ${tool}`);
  }
  return parsed;
}

function summarizeAutopilotToolResult(
  tool: string,
  payload: Record<string, unknown>,
): { summary: string; preview?: Record<string, unknown>; followUps: AutopilotFollowUp[] } {
  switch (tool) {
    case "parse_camt053": {
      const summary = recordAt(payload, "summary") ?? {};
      return {
        summary: `Parsed CAMT preview with ${numberAt(summary, "entry_count") ?? 0} entries and ${numberAt(summary, "duplicate_count") ?? 0} duplicate hint(s) inside the statement.`,
        preview: {
          entry_count: numberAt(summary, "entry_count") ?? 0,
          duplicate_count: numberAt(summary, "duplicate_count") ?? 0,
          iban: recordAt(payload, "statement_metadata") ? stringAt(recordAt(payload, "statement_metadata")!, "iban") : undefined,
        },
        followUps: [],
      };
    }
    case "import_camt053": {
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const reviewItems = arrayAt(execution, "needs_review").filter(isRecord);
      const reviewCount = reviewItems.length;
      return {
        summary: `CAMT dry run would create ${numberAt(summary, "created_count") ?? 0} transaction(s), skip ${numberAt(summary, "skipped_count") ?? 0}, raise ${reviewCount} possible duplicate review item(s), and report ${numberAt(summary, "error_count") ?? 0} error(s).`,
        preview: {
          created_count: numberAt(summary, "created_count") ?? 0,
          skipped_count: numberAt(summary, "skipped_count") ?? 0,
          possible_duplicate_count: reviewCount,
          error_count: numberAt(summary, "error_count") ?? 0,
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
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const errorCount = numberAt(summary, "error_count") ?? 0;
      return {
        summary: `Wise dry run would create ${numberAt(summary, "created") ?? 0} transaction(s), skip ${numberAt(summary, "skipped") ?? 0}, and report ${errorCount} error(s).`,
        preview: {
          created: numberAt(summary, "created") ?? 0,
          skipped: numberAt(summary, "skipped") ?? 0,
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
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const preview = buildReceiptDryRunPreview(summary);
      const followUps: AutopilotFollowUp[] = arrayAt(execution, "needs_review")
        .filter(isRecord)
        .slice(0, 5)
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
      const groups = arrayAt(payload, "groups");
      const reviewGroups = groups.filter((group) =>
        isRecord(group) && stringAt(group, "apply_mode") !== "purchase_invoice"
      );
      return {
        summary: `Classified ${numberAt(payload, "total_unmatched") ?? 0} unmatched transaction(s) into ${groups.length} group(s), of which ${reviewGroups.length} still need accounting judgement instead of auto-booking.`,
        preview: {
          total_unmatched: numberAt(payload, "total_unmatched") ?? 0,
          group_count: groups.length,
          category_counts: recordAt(payload, "category_counts") ?? {},
        },
        followUps: reviewGroups.slice(0, 5).map((group) => {
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
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const ambiguous = numberAt(summary, "skipped_ambiguous") ?? 0;
      const followUps = ambiguous > 0
        ? [{
            source: tool,
            summary: `${ambiguous} inter-account transfer candidate(s) were ambiguous.`,
            recommendation: "Review only the ambiguous transfer pairs before confirming anything.",
          }]
        : [];
      return {
        summary: `Inter-account transfer dry run found ${numberAt(summary, "matched_pairs") ?? 0} matched pair(s), ${numberAt(summary, "matched_one_sided") ?? 0} one-sided match(es), ${ambiguous} ambiguous case(s), and ${numberAt(summary, "error_count") ?? 0} error(s).`,
        preview: {
          matched_pairs: numberAt(summary, "matched_pairs") ?? 0,
          matched_one_sided: numberAt(summary, "matched_one_sided") ?? 0,
          skipped_ambiguous: ambiguous,
          skipped_already_handled: numberAt(summary, "skipped_already_handled") ?? 0,
          error_count: numberAt(summary, "error_count") ?? 0,
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
  handlers,
}: {
  prepared: AutopilotPreparedInboxData;
  handlers: Map<string, AutopilotInternalToolHandler>;
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
    const blockedByPendingMaterialization = step.tool === "classify_unmatched_transactions" &&
      materializationBlockReason !== undefined;
    if (failedPrereqTool || !isAutopilotRunnableStep(step, prepared.liveApiDefaultsAvailable) || blockedByPendingMaterialization) {
      let skipSummary: string;
      if (failedPrereqTool) {
        skipSummary = `Skipped because prerequisite ${failedPrereqTool} failed for the same input.`;
      } else if (blockedByPendingMaterialization) {
        skipSummary = materializationBlockReason === "earlier_step_failed"
          ? "Skipped because an earlier import or receipt step failed; classification would otherwise reflect an incomplete ledger."
          : "Skipped because earlier import or receipt steps are still unresolved or still show pending changes; classification would otherwise reflect the old live ledger.";
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
        status: "skipped",
        purpose: step.purpose,
        summary: skipSummary,
        suggested_args: step.suggested_args,
      });
      if (isMaterializationStep(step.tool) && materializationBlockReason === undefined) {
        materializationBlockReason = "earlier_step_failed";
      }
      continue;
    }

    try {
      const payload = await invokeInternalTool(handlers, step.tool, step.suggested_args);
      const summarized = summarizeAutopilotToolResult(step.tool, payload);
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
      executedSteps.push({
        step: step.step,
        tool: step.tool,
        status: "failed",
        purpose: step.purpose,
        summary: message,
        suggested_args: step.suggested_args,
      });
      needsAccountantReview.push({
        source: step.tool,
        summary: `${step.tool} failed during autopilot dry run: ${message}`,
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
    next_question: nextQuestion,
    next_recommended_action: nextRecommendedAction,
    user_summary: doneAutomatically.length > 0
      ? `Ran ${executedSteps.length} safe dry-run step(s) automatically. ${needsOneDecision.length} small decision(s) and ${needsAccountantReview.length} review item(s) remain.`
      : `No safe dry-run steps could be completed automatically yet. ${needsOneDecision.length} small decision(s) and ${needsAccountantReview.length} review item(s) remain.`,
  };
}
