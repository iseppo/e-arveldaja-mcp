export type WorkflowActionKind =
  | "tool_call"
  | "answer_question"
  | "review_item"
  | "approve_tool_call"
  | "done";

export interface WorkflowAction {
  kind: WorkflowActionKind;
  label: string;
  why: string;
  approval_required: boolean;
  tool?: string;
  args?: Record<string, unknown>;
  question?: string;
  recommendation?: string;
}

export interface ApprovalPreview {
  title: string;
  summary: string;
  approval_required: true;
  source_tool: string;
  execute_tool: string;
  execute_args: Record<string, unknown>;
  accounting_impact: string[];
  duplicate_risk: string;
  source_documents: string[];
}

export interface WorkflowEnvelope {
  contract: "workflow_action_v1";
  summary: string;
  done: unknown[];
  needs_decision: unknown[];
  needs_review: unknown[];
  recommended_next_action: WorkflowAction;
  available_actions: WorkflowAction[];
  approval_previews: ApprovalPreview[];
}

interface BuildWorkflowEnvelopeOptions {
  summary: string;
  done?: unknown[];
  needs_decision?: unknown[];
  needs_review?: unknown[];
  recommended_step?: unknown;
  approval_previews?: ApprovalPreview[];
  fallback_actions?: WorkflowAction[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function actionFromQuestion(question: unknown): WorkflowAction | undefined {
  if (!isRecord(question)) return undefined;
  const prompt = stringAt(question, "summary") ?? stringAt(question, "question");
  if (!prompt) return undefined;

  return {
    kind: "answer_question",
    label: "Answer the next setup question",
    question: prompt,
    recommendation: stringAt(question, "recommendation"),
    why: "This missing input blocks the next safe workflow step.",
    approval_required: false,
  };
}

function actionFromReviewItem(reviewItem: unknown): WorkflowAction | undefined {
  if (!isRecord(reviewItem)) return undefined;
  const resolverInput = recordAt(reviewItem, "resolver_input") ?? reviewItem;
  return {
    kind: "review_item",
    label: "Resolve the first accounting review item",
    tool: "resolve_accounting_review_item",
    args: { review_item_json: resolverInput },
    why: stringAt(reviewItem, "summary") ?? "A review item needs accounting judgement before execution.",
    recommendation: stringAt(reviewItem, "recommendation"),
    approval_required: false,
  };
}

export function actionFromRecommendedStep(step: unknown): WorkflowAction | undefined {
  if (!isRecord(step)) return undefined;
  const tool = stringAt(step, "tool");
  if (!tool) return undefined;
  return {
    kind: "tool_call",
    label: `Run ${tool}`,
    tool,
    args: recordAt(step, "suggested_args") ?? recordAt(step, "args") ?? {},
    why: stringAt(step, "reason") ?? stringAt(step, "why") ?? stringAt(step, "purpose") ?? "Run the next safe workflow step.",
    approval_required: false,
  };
}

function actionFromApprovalPreview(preview: ApprovalPreview): WorkflowAction {
  return {
    kind: "approve_tool_call",
    label: preview.title,
    tool: preview.execute_tool,
    args: preview.execute_args,
    why: preview.summary,
    approval_required: true,
  };
}

function doneAction(): WorkflowAction {
  return {
    kind: "done",
    label: "No workflow action is currently pending",
    why: "There are no unanswered questions, review items, approval cards, or recommended dry-run steps in this response.",
    approval_required: false,
  };
}

export function buildWorkflowEnvelope(options: BuildWorkflowEnvelopeOptions): WorkflowEnvelope {
  const done = options.done ?? [];
  const needsDecision = options.needs_decision ?? [];
  const needsReview = options.needs_review ?? [];
  const approvalPreviews = options.approval_previews ?? [];
  const recommendedAction = actionFromRecommendedStep(options.recommended_step);

  const availableActions: WorkflowAction[] = [
    ...approvalPreviews.map(actionFromApprovalPreview),
    ...(recommendedAction ? [recommendedAction] : []),
    ...needsDecision.slice(0, 1).map(actionFromQuestion).filter((action): action is WorkflowAction => action !== undefined),
    ...needsReview.slice(0, 3).map(actionFromReviewItem).filter((action): action is WorkflowAction => action !== undefined),
    ...(options.fallback_actions ?? []),
  ];

  return {
    contract: "workflow_action_v1",
    summary: options.summary,
    done,
    needs_decision: needsDecision,
    needs_review: needsReview,
    recommended_next_action: availableActions[0] ?? doneAction(),
    available_actions: availableActions,
    approval_previews: approvalPreviews,
  };
}

function sourceDocuments(args: Record<string, unknown>): string[] {
  return [args.file_path, args.folder_path]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function withExecuteTrue(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, execute: true };
}

function impactLine(count: number | undefined, singular: string, plural = `${singular}s`): string | undefined {
  if (!count || count <= 0) return undefined;
  return `${count} ${count === 1 ? singular : plural}`;
}

export function approvalPreviewFromDryRunStep(step: unknown): ApprovalPreview | undefined {
  if (!isRecord(step)) return undefined;
  const tool = stringAt(step, "tool");
  const args = recordAt(step, "suggested_args") ?? {};
  const preview = recordAt(step, "preview");
  if (!tool || !preview) return undefined;

  if (tool === "import_camt053") {
    const created = numberAt(preview, "created_count") ?? 0;
    const duplicateCount = numberAt(preview, "possible_duplicate_count") ?? 0;
    const errorCount = numberAt(preview, "error_count") ?? 0;
    if (created <= 0 || duplicateCount > 0 || errorCount > 0) return undefined;
    return {
      title: "Approve CAMT transaction import",
      summary: stringAt(step, "summary") ?? `CAMT dry run would create ${created} transaction(s).`,
      approval_required: true,
      source_tool: tool,
      execute_tool: tool,
      execute_args: withExecuteTrue(args),
      accounting_impact: [
        impactLine(created, "bank transaction"),
        impactLine(numberAt(preview, "skipped_count"), "skipped row"),
        errorCount > 0 ? `${errorCount} import error(s) must be reviewed before approval` : undefined,
      ].filter((line): line is string => line !== undefined),
      duplicate_risk: duplicateCount > 0
        ? `${duplicateCount} possible duplicate(s) were reported; resolve those review items before approval.`
        : "No possible duplicate review items were reported by the dry run.",
      source_documents: sourceDocuments(args),
    };
  }

  if (tool === "import_wise_transactions") {
    const created = numberAt(preview, "created") ?? 0;
    const errorCount = numberAt(preview, "error_count") ?? 0;
    if (created <= 0 || errorCount > 0) return undefined;
    return {
      title: "Approve Wise transaction import",
      summary: stringAt(step, "summary") ?? `Wise dry run would create ${created} transaction(s).`,
      approval_required: true,
      source_tool: tool,
      execute_tool: tool,
      execute_args: withExecuteTrue(args),
      accounting_impact: [
        impactLine(created, "bank transaction"),
        impactLine(numberAt(preview, "skipped"), "skipped row"),
        errorCount > 0 ? `${errorCount} import error(s) must be reviewed before approval` : undefined,
      ].filter((line): line is string => line !== undefined),
      duplicate_risk: "Review skipped rows and transfer handling before approval.",
      source_documents: sourceDocuments(args),
    };
  }

  if (tool === "process_receipt_batch") {
    const created = numberAt(preview, "created") ?? 0;
    const dryRunPreview = numberAt(preview, "dry_run_preview") ?? 0;
    const wouldCreate = created > 0 ? created : dryRunPreview;
    const matched = numberAt(preview, "matched") ?? 0;
    const reviewCount = numberAt(preview, "needs_review") ?? 0;
    const failed = numberAt(preview, "failed") ?? 0;
    if ((wouldCreate <= 0 && matched <= 0) || reviewCount > 0 || failed > 0) return undefined;
    return {
      title: "Approve receipt batch booking",
      summary: stringAt(step, "summary") ?? `Receipt dry run would create ${wouldCreate} invoice(s).`,
      approval_required: true,
      source_tool: tool,
      execute_tool: tool,
      execute_args: withExecuteTrue(args),
      accounting_impact: [
        impactLine(wouldCreate, "purchase invoice"),
        impactLine(matched, "matched transaction"),
        impactLine(numberAt(preview, "skipped_duplicate"), "skipped duplicate"),
        reviewCount > 0 ? `${reviewCount} receipt(s) still need review before approval` : undefined,
        failed > 0 ? `${failed} receipt(s) failed and should be fixed before approval` : undefined,
      ].filter((line): line is string => line !== undefined),
      duplicate_risk: reviewCount > 0 || failed > 0
        ? "Review unresolved receipt items before approving execution."
        : "No unresolved receipt review items were reported by the dry run.",
      source_documents: sourceDocuments(args),
    };
  }

  if (tool === "apply_transaction_classifications") {
    const wouldCreate = numberAt(preview, "would_create") ?? numberAt(preview, "dry_run_preview") ?? 0;
    const failed = numberAt(preview, "failed") ?? 0;
    if (wouldCreate <= 0 || failed > 0) return undefined;
    return {
      title: "Approve transaction classification booking",
      summary: stringAt(step, "summary") ?? `Classification dry run would create ${wouldCreate} invoice(s).`,
      approval_required: true,
      source_tool: tool,
      execute_tool: tool,
      execute_args: withExecuteTrue(args),
      accounting_impact: [
        impactLine(wouldCreate, "purchase invoice"),
        impactLine(numberAt(preview, "skipped"), "skipped classification"),
        failed > 0 ? `${failed} classification group(s) failed and should be fixed before approval` : undefined,
      ].filter((line): line is string => line !== undefined),
      duplicate_risk: "Review the classification source groups before approving execution.",
      source_documents: sourceDocuments(args),
    };
  }

  return undefined;
}

export function approvalPreviewsFromDryRunSteps(steps: unknown[]): ApprovalPreview[] {
  return steps
    .map(approvalPreviewFromDryRunStep)
    .filter((preview): preview is ApprovalPreview => preview !== undefined);
}

export function workflowFromAccountingInboxPayload(payload: Record<string, unknown>): WorkflowEnvelope {
  const autopilot = recordAt(payload, "autopilot");
  if (autopilot) {
    return buildWorkflowEnvelope({
      summary: stringAt(autopilot, "user_summary") ?? "Accounting inbox has a workflow state.",
      done: arrayAt(autopilot, "done_automatically"),
      needs_decision: arrayAt(autopilot, "needs_one_decision"),
      needs_review: arrayAt(autopilot, "needs_accountant_review"),
      recommended_step: recordAt(autopilot, "next_recommended_action"),
      approval_previews: approvalPreviewsFromDryRunSteps(arrayAt(autopilot, "executed_steps")),
    });
  }

  const preparedInbox = recordAt(payload, "prepared_inbox") ?? payload;
  return buildWorkflowEnvelope({
    summary: stringAt(preparedInbox, "user_summary") ?? "Prepared accounting inbox workflow.",
    done: [],
    needs_decision: arrayAt(preparedInbox, "questions"),
    needs_review: [],
    recommended_step: recordAt(preparedInbox, "next_recommended_action"),
  });
}
