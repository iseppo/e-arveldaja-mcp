import { arrayAt, isRecord, numberAt, recordAt, stringAt } from "./record-utils.js";

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
  dry_run_steps?: unknown[];
  approval_previews?: ApprovalPreview[];
  fallback_actions?: WorkflowAction[];
}

type MaterializingDryRunTool =
  | "import_camt053"
  | "import_wise_transactions"
  | "process_receipt_batch"
  | "apply_transaction_classifications"
  | "auto_confirm_exact_matches"
  | "reconcile_inter_account_transfers";

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function questionLabel(prompt: string): string {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("bank account dimension") || normalized.includes("bank dimension")) {
    return "Choose bank account dimension";
  }
  if (normalized.includes("fee") && normalized.includes("dimension")) {
    return "Choose fee expense dimension";
  }
  if (normalized.includes("storage_scope") || (normalized.includes("local") && normalized.includes("global"))) {
    return "Choose credential storage scope";
  }
  if (normalized.includes("apikey") || normalized.includes("which file") || normalized.includes("file should be imported")) {
    return "Choose credential file";
  }
  if (normalized.includes("supplier")) {
    return "Confirm supplier choice";
  }
  if (normalized.includes("account")) {
    return "Choose account";
  }
  return "Answer next workflow question";
}

function actionLabelForTool(tool: string, args: Record<string, unknown>): string {
  const mode = typeof args.mode === "string" ? args.mode : undefined;
  const action = typeof args.action === "string" ? args.action : undefined;
  const execute = typeof args.execute === "boolean" ? args.execute : undefined;
  const dryRun = typeof args.dry_run === "boolean" ? args.dry_run : undefined;

  switch (tool) {
    case "accounting_inbox":
      return "Scan accounting inbox";
    case "continue_accounting_workflow":
      if (action === "resolve_review") return "Resolve accounting review item";
      if (action === "prepare_action") return "Prepare review action for approval";
      return "Continue accounting workflow";
    case "extract_pdf_invoice":
      return "Extract invoice data";
    case "validate_invoice_data":
      return "Validate invoice totals";
    case "resolve_supplier":
      return "Resolve supplier";
    case "detect_duplicate_purchase_invoice":
      return "Check duplicate invoice risk";
    case "suggest_booking":
      return "Suggest invoice booking";
    case "create_purchase_invoice_from_pdf":
      return "Create purchase invoice";
    case "confirm_purchase_invoice":
      return "Confirm purchase invoice";
    case "receipt_batch":
      if (mode === "scan") return "Scan receipt folder";
      if (mode === "dry_run") return "Preview receipt batch booking";
      if (mode === "create") return "Create receipt batch invoices";
      if (mode === "create_and_confirm") return "Create and confirm receipt batch";
      return "Process receipt batch";
    case "process_camt053":
      if (mode === "parse") return "Parse CAMT statement";
      if (mode === "dry_run") return "Preview CAMT statement import";
      if (mode === "execute") return "Import CAMT bank transactions";
      return "Process CAMT statement";
    case "import_camt053":
      return execute ? "Import CAMT bank transactions" : "Preview CAMT statement import";
    case "import_wise_transactions":
      return execute ? "Import Wise transactions" : "Preview Wise transaction import";
    case "classify_bank_transactions":
      if (mode === "classify") return "Classify unmatched bank transactions";
      if (mode === "dry_run_apply") return "Preview transaction classification booking";
      if (mode === "execute_apply") return "Apply transaction classifications";
      return "Classify bank transactions";
    case "apply_transaction_classifications":
      return execute ? "Apply transaction classifications" : "Preview transaction classification booking";
    case "reconcile_bank_transactions":
      if (mode === "suggest") return "Find bank transaction matches";
      if (mode === "dry_run_auto_confirm") return "Preview exact-match confirmations";
      if (mode === "execute_auto_confirm") return "Confirm exact bank matches";
      if (mode === "inter_account_dry_run") return "Preview inter-account transfer reconciliation";
      return "Reconcile bank transactions";
    case "auto_confirm_exact_matches":
      return execute ? "Confirm exact bank matches" : "Preview exact-match confirmations";
    case "reconcile_inter_account_transfers":
      return execute ? "Reconcile inter-account transfers" : "Preview inter-account transfer reconciliation";
    case "month_end_close_checklist":
      return "Check month-end blockers";
    case "find_missing_documents":
      return "Find missing source documents";
    case "compute_trial_balance":
      return "Compute trial balance";
    case "compute_profit_and_loss":
      return "Compute profit and loss";
    case "compute_balance_sheet":
      return "Compute balance sheet";
    case "compute_receivables_aging":
      return "Compute receivables aging";
    case "compute_payables_aging":
      return "Compute payables aging";
    case "find_client_by_code":
    case "search_client":
      return "Check existing supplier";
    case "create_client":
      return "Create supplier";
    case "parse_lightyear_statement":
      return "Parse Lightyear statement";
    case "parse_lightyear_capital_gains":
      return "Parse Lightyear capital gains";
    case "lightyear_portfolio_summary":
      return "Preview Lightyear cost basis";
    case "book_lightyear_trades":
      return dryRun === false ? "Book Lightyear trades" : "Preview Lightyear trade bookings";
    case "book_lightyear_distributions":
      return dryRun === false ? "Book Lightyear distributions" : "Preview Lightyear distribution bookings";
    case "get_setup_instructions":
      return "Inspect credential setup";
    case "import_apikey_credentials":
      return "Import API credentials";
    case "list_connections":
      return "List configured connections";
    default:
      return humanizeToolName(tool);
  }
}

function actionFromQuestion(question: unknown): WorkflowAction | undefined {
  if (!isRecord(question)) return undefined;
  const prompt = stringAt(question, "summary") ?? stringAt(question, "question");
  if (!prompt) return undefined;

  return {
    kind: "answer_question",
    label: questionLabel(prompt),
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
    tool: "continue_accounting_workflow",
    args: { action: "resolve_review", review_item_json: resolverInput },
    why: stringAt(reviewItem, "summary") ?? "A review item needs accounting judgement before execution.",
    recommendation: stringAt(reviewItem, "recommendation"),
    approval_required: false,
  };
}

export function actionFromRecommendedStep(step: unknown): WorkflowAction | undefined {
  if (!isRecord(step)) return undefined;
  const tool = stringAt(step, "tool");
  if (!tool) return undefined;
  const args = recordAt(step, "suggested_args") ?? recordAt(step, "args") ?? {};
  return {
    kind: "tool_call",
    label: actionLabelForTool(tool, args),
    tool,
    args,
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

function blockedDryRunLabel(tool: MaterializingDryRunTool): string {
  switch (tool) {
    case "import_camt053":
      return "Review blocked CAMT dry run";
    case "import_wise_transactions":
      return "Review blocked Wise dry run";
    case "process_receipt_batch":
      return "Review blocked receipt batch dry run";
    case "apply_transaction_classifications":
      return "Review blocked transaction classification dry run";
    case "auto_confirm_exact_matches":
      return "Review blocked exact-match confirmation dry run";
    case "reconcile_inter_account_transfers":
      return "Review blocked inter-account reconciliation dry run";
  }
}

function isMaterializingDryRunTool(tool: string): tool is MaterializingDryRunTool {
  return tool === "import_camt053"
    || tool === "import_wise_transactions"
    || tool === "process_receipt_batch"
    || tool === "apply_transaction_classifications"
    || tool === "auto_confirm_exact_matches"
    || tool === "reconcile_inter_account_transfers";
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
  const dryRunSteps = options.dry_run_steps ?? [];
  const approvalPreviews = [
    ...(options.approval_previews ?? []),
    ...approvalPreviewsFromDryRunSteps(dryRunSteps),
  ];
  const blockedDryRunActions = workflowActionsFromBlockedDryRunSteps(dryRunSteps);
  const recommendedAction = actionFromRecommendedStep(options.recommended_step);
  const decisionActions = needsDecision
    .slice(0, 1)
    .map(actionFromQuestion)
    .filter((action): action is WorkflowAction => action !== undefined);
  const reviewActions = needsReview
    .slice(0, 3)
    .map(actionFromReviewItem)
    .filter((action): action is WorkflowAction => action !== undefined);

  const availableActions: WorkflowAction[] = [
    ...approvalPreviews.map(actionFromApprovalPreview),
    ...blockedDryRunActions,
    ...(recommendedAction ? [recommendedAction] : []),
    ...decisionActions,
    ...reviewActions,
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

function withReceiptCreateMode(args: Record<string, unknown>): Record<string, unknown> {
  const { execute: _execute, execution_mode: _executionMode, ...rest } = args;
  return { ...rest, execution_mode: "create" };
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
    const skippedDuplicate = numberAt(preview, "skipped_duplicate") ?? 0;
    const reviewCount = numberAt(preview, "needs_review") ?? 0;
    const failed = numberAt(preview, "failed") ?? 0;
    if ((wouldCreate <= 0 && matched <= 0) || skippedDuplicate > 0 || reviewCount > 0 || failed > 0) return undefined;
    return {
      title: "Approve receipt batch booking",
      summary: stringAt(step, "summary") ?? `Receipt dry run would create ${wouldCreate} invoice(s).`,
      approval_required: true,
      source_tool: tool,
      execute_tool: tool,
      execute_args: withReceiptCreateMode(args),
      accounting_impact: [
        impactLine(wouldCreate, "purchase invoice"),
        impactLine(matched, "matched transaction"),
        impactLine(skippedDuplicate, "skipped duplicate"),
        reviewCount > 0 ? `${reviewCount} receipt(s) still need review before approval` : undefined,
        failed > 0 ? `${failed} receipt(s) failed and should be fixed before approval` : undefined,
      ].filter((line): line is string => line !== undefined),
      duplicate_risk: skippedDuplicate > 0 || reviewCount > 0 || failed > 0
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

  if (tool === "auto_confirm_exact_matches") {
    const autoConfirmed = numberAt(preview, "auto_confirmed") ?? 0;
    const skipped = numberAt(preview, "skipped") ?? 0;
    const errorCount = numberAt(preview, "error_count") ?? 0;
    if (autoConfirmed <= 0 || skipped > 0 || errorCount > 0) return undefined;
    return {
      title: "Approve exact-match transaction confirmations",
      summary: stringAt(step, "summary") ?? `Exact-match dry run would confirm ${autoConfirmed} bank transaction(s).`,
      approval_required: true,
      source_tool: tool,
      execute_tool: tool,
      execute_args: withExecuteTrue(args),
      accounting_impact: [
        impactLine(autoConfirmed, "bank transaction confirmation"),
        impactLine(skipped, "skipped transaction"),
        errorCount > 0 ? `${errorCount} confirmation error(s) must be reviewed before approval` : undefined,
      ].filter((line): line is string => line !== undefined),
      duplicate_risk: "Review invoice and transaction matches before approving confirmation.",
      source_documents: sourceDocuments(args),
    };
  }

  if (tool === "reconcile_inter_account_transfers") {
    const matchedPairs = numberAt(preview, "matched_pairs") ?? 0;
    const matchedOneSided = numberAt(preview, "matched_one_sided") ?? 0;
    const skippedAmbiguous = numberAt(preview, "skipped_ambiguous") ?? 0;
    const errorCount = numberAt(preview, "error_count") ?? 0;
    if ((matchedPairs + matchedOneSided) <= 0 || skippedAmbiguous > 0 || errorCount > 0) return undefined;
    return {
      title: "Approve inter-account transfer reconciliation",
      summary: stringAt(step, "summary") ?? `Inter-account dry run would reconcile ${matchedPairs + matchedOneSided} transfer(s).`,
      approval_required: true,
      source_tool: tool,
      execute_tool: tool,
      execute_args: withExecuteTrue(args),
      accounting_impact: [
        impactLine(matchedPairs, "inter-account transfer pair"),
        impactLine(matchedOneSided, "one-sided inter-account transfer"),
        impactLine(numberAt(preview, "skipped_already_handled"), "already handled transfer"),
        skippedAmbiguous > 0 ? `${skippedAmbiguous} ambiguous transfer(s) must be reviewed before approval` : undefined,
        errorCount > 0 ? `${errorCount} reconciliation error(s) must be reviewed before approval` : undefined,
      ].filter((line): line is string => line !== undefined),
      duplicate_risk: "Existing inter-account journals are checked before approval; review already-handled and ambiguous transfers.",
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

function blockedDryRunReasons(tool: MaterializingDryRunTool, preview: Record<string, unknown>): string[] {
  switch (tool) {
    case "import_camt053": {
      const possibleDuplicates = numberAt(preview, "possible_duplicate_count") ?? 0;
      const errors = numberAt(preview, "error_count") ?? 0;
      return [
        impactLine(possibleDuplicates, "possible duplicate"),
        impactLine(errors, "import error"),
      ].filter((line): line is string => line !== undefined);
    }
    case "import_wise_transactions": {
      const errors = numberAt(preview, "error_count") ?? 0;
      return [
        impactLine(errors, "import error"),
      ].filter((line): line is string => line !== undefined);
    }
    case "process_receipt_batch": {
      const skippedDuplicate = numberAt(preview, "skipped_duplicate") ?? 0;
      const needsReview = numberAt(preview, "needs_review") ?? 0;
      const failed = numberAt(preview, "failed") ?? 0;
      return [
        impactLine(skippedDuplicate, "skipped duplicate"),
        impactLine(needsReview, "receipt needing review", "receipts needing review"),
        impactLine(failed, "failed receipt"),
      ].filter((line): line is string => line !== undefined);
    }
    case "apply_transaction_classifications": {
      const failed = numberAt(preview, "failed") ?? 0;
      return [
        impactLine(failed, "failed classification group"),
      ].filter((line): line is string => line !== undefined);
    }
    case "auto_confirm_exact_matches": {
      const skipped = numberAt(preview, "skipped") ?? 0;
      const errors = numberAt(preview, "error_count") ?? 0;
      return [
        impactLine(skipped, "skipped transaction"),
        impactLine(errors, "confirmation error"),
      ].filter((line): line is string => line !== undefined);
    }
    case "reconcile_inter_account_transfers": {
      const ambiguous = numberAt(preview, "skipped_ambiguous") ?? 0;
      const errors = numberAt(preview, "error_count") ?? 0;
      return [
        impactLine(ambiguous, "ambiguous transfer"),
        impactLine(errors, "reconciliation error"),
      ].filter((line): line is string => line !== undefined);
    }
  }
}

export function workflowActionFromBlockedDryRunStep(step: unknown): WorkflowAction | undefined {
  if (!isRecord(step)) return undefined;
  const tool = stringAt(step, "tool");
  const args = recordAt(step, "suggested_args") ?? {};
  const preview = recordAt(step, "preview");
  if (!tool || !isMaterializingDryRunTool(tool) || !preview) return undefined;
  if (approvalPreviewFromDryRunStep(step)) return undefined;

  const reasons = blockedDryRunReasons(tool, preview);
  if (reasons.length === 0) return undefined;

  return {
    kind: "review_item",
    label: blockedDryRunLabel(tool),
    why: [
      stringAt(step, "summary") ?? "This materializing dry run is not safe to approve yet.",
      `Blocked by ${reasons.join(", ")}.`,
    ].join(" "),
    approval_required: false,
    args: {
      source_tool: tool,
      source_documents: sourceDocuments(args),
      preview,
    },
  };
}

export function workflowActionsFromBlockedDryRunSteps(steps: unknown[]): WorkflowAction[] {
  return steps
    .map(workflowActionFromBlockedDryRunStep)
    .filter((action): action is WorkflowAction => action !== undefined);
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
      dry_run_steps: arrayAt(autopilot, "executed_steps"),
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
