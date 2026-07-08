import { describe, expect, it } from "vitest";
import {
  approvalPreviewFromDryRunStep,
  buildWorkflowEnvelope,
  remapHiddenGranularTool,
  remapHiddenGranularWorkflowEnvelope,
  workflowActionFromBlockedDryRunStep,
} from "./workflow-response.js";

describe("workflow response helpers", () => {
  it("uses domain labels for next tool calls and questions", () => {
    const workflow = buildWorkflowEnvelope({
      summary: "Prepared CAMT import.",
      needs_decision: [{
        summary: "Which bank account dimension should be used?",
        recommendation: "Use the LHV EUR account.",
      }],
      recommended_step: {
        tool: "process_camt053",
        suggested_args: { mode: "dry_run", file_path: "/tmp/statement.xml" },
        purpose: "Preview the CAMT statement before creating transactions.",
      },
    });

    expect(workflow.recommended_next_action).toMatchObject({
      kind: "tool_call",
      tool: "process_camt053",
      label: "Preview CAMT statement import",
    });
    expect(workflow.available_actions[1]).toMatchObject({
      kind: "answer_question",
      label: "Choose bank account dimension",
      question: "Which bank account dimension should be used?",
    });
  });

  it("prioritizes the next safe tool call before asking blocking questions", () => {
    const workflow = buildWorkflowEnvelope({
      summary: "Prepared inbox.",
      needs_decision: [{
        summary: "Which bank account dimension should be used?",
        recommendation: "Use LHV.",
      }],
      recommended_step: {
        tool: "parse_camt053",
        suggested_args: { file_path: "/tmp/statement.xml" },
        purpose: "Parse the CAMT statement before asking for import-only defaults.",
      },
    });

    expect(workflow.recommended_next_action).toMatchObject({
      kind: "tool_call",
      tool: "parse_camt053",
      approval_required: false,
    });
    expect(workflow.available_actions[1]).toMatchObject({
      kind: "answer_question",
      question: "Which bank account dimension should be used?",
    });
  });

  it("keeps recommended dry-run steps ahead of ordinary review items", () => {
    const workflow = buildWorkflowEnvelope({
      summary: "Prepared inbox.",
      needs_review: [{
        summary: "Review a supplier match.",
        recommendation: "Confirm the supplier before booking.",
      }],
      recommended_step: {
        tool: "import_camt053",
        suggested_args: { file_path: "/tmp/statement.xml" },
        purpose: "Run the next dry-run step before resolving bookkeeping review items.",
      },
    });

    expect(workflow.recommended_next_action).toMatchObject({
      kind: "tool_call",
      tool: "import_camt053",
      approval_required: false,
    });
    expect(workflow.available_actions[1]).toMatchObject({
      kind: "review_item",
      tool: "continue_accounting_workflow",
      args: {
        action: "resolve_review",
        review_item_json: {
          summary: "Review a supplier match.",
          recommendation: "Confirm the supplier before booking.",
        },
      },
    });
  });

  it("creates receipt approval previews from dry-run preview counts", () => {
    const preview = approvalPreviewFromDryRunStep({
      tool: "process_receipt_batch",
      summary: "Receipt dry run would create 0 invoice(s), match 0, skip 0 duplicate(s), leave 0 in review, and fail 0.",
      suggested_args: {
        folder_path: "/tmp/receipts",
        accounts_dimensions_id: 100,
        execution_mode: "dry_run",
      },
      preview: {
        created: 0,
        matched: 0,
        dry_run_preview: 2,
        skipped_duplicate: 0,
        needs_review: 0,
        failed: 0,
      },
    });

    expect(preview).toMatchObject({
      title: "Approve receipt batch booking",
      execute_tool: "process_receipt_batch",
      execute_args: {
        folder_path: "/tmp/receipts",
        accounts_dimensions_id: 100,
        execution_mode: "create",
      },
      accounting_impact: expect.arrayContaining(["2 purchase invoices"]),
      source_documents: ["/tmp/receipts"],
    });
  });

  it("blocks receipt batch approval when result confidence signals include OCR quality issues", () => {
    const step = {
      tool: "process_receipt_batch",
      summary: "Receipt dry run would create 2 purchase invoices.",
      suggested_args: {
        folder_path: "/tmp/receipts",
        execution_mode: "dry_run",
      },
      preview: {
        created: 0,
        matched: 0,
        dry_run_preview: 2,
        skipped_duplicate: 0,
        needs_review: 0,
        failed: 0,
        results: [
          {
            llm_fallback: {
              confidence_signals: ["partial_ocr_failure"],
            },
          },
          {
            llm_fallback: {
              confidence_signals: ["low_ocr_confidence"],
            },
          },
        ],
      },
    };

    expect(approvalPreviewFromDryRunStep(step)).toBeUndefined();
    const action = workflowActionFromBlockedDryRunStep(step);
    expect(action?.why).toContain("partial OCR failure");
    expect(action?.why).toContain("low OCR confidence");
  });

  it("turns safe materializing dry-run steps into approval actions", () => {
    const workflow = buildWorkflowEnvelope({
      summary: "Dry runs are ready for approval.",
      dry_run_steps: [
        {
          tool: "import_camt053",
          summary: "CAMT dry run would create 1 bank transaction.",
          suggested_args: { file_path: "/tmp/statement.xml", accounts_dimensions_id: 7, execute: false },
          preview: { created_count: 1, skipped_count: 0, possible_duplicate_count: 0, error_count: 0 },
        },
        {
          tool: "import_wise_transactions",
          summary: "Wise dry run would create 2 bank transactions and update 1 invoice FX settlement.",
          suggested_args: { file_path: "/tmp/wise.csv", accounts_dimensions_id: 8, execute: false },
          preview: {
            created: 2,
            skipped: 0,
            error_count: 0,
            invoice_currency_fixes: {
              foreign_currency_lock: 1,
              candidates: [{
                invoice_id: 42,
                invoice_number: "INV-42",
                category: "foreign_currency_lock",
                result: "would_update",
              }],
            },
          },
        },
        {
          tool: "process_receipt_batch",
          summary: "Receipt dry run would create 1 purchase invoice.",
          suggested_args: { folder_path: "/tmp/receipts", accounts_dimensions_id: 100, execution_mode: "dry_run" },
          preview: { created: 0, matched: 0, dry_run_preview: 1, skipped_duplicate: 0, needs_review: 0, failed: 0 },
        },
        {
          tool: "apply_transaction_classifications",
          summary: "Classification dry run would create 1 purchase invoice group.",
          suggested_args: { classifications_json: "{\"groups\":[]}", execute: false },
          preview: { would_create: 1, skipped: 0, failed: 0 },
        },
      ],
    });

    expect(workflow.recommended_next_action).toMatchObject({
      kind: "approve_tool_call",
      tool: "import_camt053",
      approval_required: true,
    });
    expect(workflow.approval_previews.map(preview => preview.execute_tool)).toEqual([
      "import_camt053",
      "import_wise_transactions",
      "process_receipt_batch",
      "apply_transaction_classifications",
    ]);
    expect(workflow.available_actions.map(action => action.kind)).toEqual([
      "approve_tool_call",
      "approve_tool_call",
      "approve_tool_call",
      "approve_tool_call",
    ]);
    expect(workflow.approval_previews[1]).toMatchObject({
      execute_tool: "import_wise_transactions",
      accounting_impact: expect.arrayContaining([
        "2 bank transactions",
        "1 invoice FX update",
      ]),
      duplicate_risk: expect.stringContaining("confirms or links source bank transactions"),
    });
  });

  it("blocks follow-up tool calls when materializing dry runs still need review", () => {
    const workflow = buildWorkflowEnvelope({
      summary: "Dry runs need review before continuing.",
      dry_run_steps: [
        {
          tool: "import_camt053",
          summary: "CAMT dry run flagged a possible duplicate.",
          suggested_args: { file_path: "/tmp/statement.xml", accounts_dimensions_id: 7, execute: false },
          preview: { created_count: 1, skipped_count: 0, possible_duplicate_count: 1, error_count: 0 },
        },
        {
          tool: "import_wise_transactions",
          summary: "Wise dry run reported one import error.",
          suggested_args: { file_path: "/tmp/wise.csv", accounts_dimensions_id: 8, execute: false },
          preview: { created: 1, skipped: 0, error_count: 1 },
        },
        {
          tool: "process_receipt_batch",
          summary: "Receipt dry run skipped one duplicate.",
          suggested_args: { folder_path: "/tmp/receipts", accounts_dimensions_id: 100, execution_mode: "dry_run" },
          preview: { created: 0, matched: 0, dry_run_preview: 1, skipped_duplicate: 1, needs_review: 0, failed: 0 },
        },
        {
          tool: "apply_transaction_classifications",
          summary: "Classification dry run failed one group.",
          suggested_args: { classifications_json: "{\"groups\":[]}", execute: false },
          preview: { would_create: 1, skipped: 0, failed: 1 },
        },
      ],
      recommended_step: {
        tool: "continue_accounting_workflow",
        suggested_args: { workflow_response_json: "{}" },
        reason: "Continue once all dry runs are safe.",
      },
    });

    expect(workflow.approval_previews).toEqual([]);
    expect(workflow.recommended_next_action).toMatchObject({
      kind: "review_item",
      approval_required: false,
      label: "Review blocked CAMT dry run",
    });
    expect(workflow.available_actions.map(action => action.kind)).toEqual([
      "review_item",
      "review_item",
      "review_item",
      "review_item",
      "tool_call",
    ]);
    expect(workflow.available_actions[4]).toMatchObject({
      kind: "tool_call",
      tool: "continue_accounting_workflow",
    });
  });
});

describe("hidden-granular → merged entry-point remap", () => {
  // Each granular constituent is hidden from tools/list by default; a workflow
  // envelope must name the merged entry point (which is always registered) and
  // express the execute/execution_mode flag as the merged tool's `mode`.
  it.each([
    ["reconcile_transactions", { min_confidence: 30 }, "reconcile_bank_transactions", { mode: "suggest", min_confidence: 30 }],
    ["auto_confirm_exact_matches", { execute: true, min_confidence: 90 }, "reconcile_bank_transactions", { mode: "execute_auto_confirm", min_confidence: 90 }],
    ["auto_confirm_exact_matches", { execute: false }, "reconcile_bank_transactions", { mode: "dry_run_auto_confirm" }],
    ["parse_camt053", { file_path: "/tmp/s.xml" }, "process_camt053", { mode: "parse", file_path: "/tmp/s.xml" }],
    ["import_camt053", { execute: true, file_path: "/tmp/s.xml", accounts_dimensions_id: 7 }, "process_camt053", { mode: "execute", file_path: "/tmp/s.xml", accounts_dimensions_id: 7 }],
    ["import_camt053", { execute: false, file_path: "/tmp/s.xml" }, "process_camt053", { mode: "dry_run", file_path: "/tmp/s.xml" }],
    ["scan_receipt_folder", { folder_path: "/tmp/r" }, "receipt_batch", { mode: "scan", folder_path: "/tmp/r" }],
    ["process_receipt_batch", { execution_mode: "create", folder_path: "/tmp/r" }, "receipt_batch", { mode: "create", folder_path: "/tmp/r" }],
    ["process_receipt_batch", { execution_mode: "create_and_confirm" }, "receipt_batch", { mode: "create_and_confirm" }],
    ["process_receipt_batch", { execution_mode: "dry_run" }, "receipt_batch", { mode: "dry_run" }],
    ["classify_unmatched_transactions", { accounts_dimensions_id: 9 }, "classify_bank_transactions", { mode: "classify", accounts_dimensions_id: 9 }],
    ["apply_transaction_classifications", { execute: true, classifications_json: "[]" }, "classify_bank_transactions", { mode: "execute_apply", classifications_json: "[]" }],
    ["apply_transaction_classifications", { execute: false }, "classify_bank_transactions", { mode: "dry_run_apply" }],
  ])("maps granular %s(%o) to the merged entry point", (granular, args, mergedTool, mergedArgs) => {
    const result = remapHiddenGranularTool(granular as string, args as Record<string, unknown>);
    expect(result).toEqual({ tool: mergedTool, args: mergedArgs });
    // The execute/execution_mode flag is never carried through — it is subsumed by mode.
    expect(result!.args).not.toHaveProperty("execute");
    expect(result!.args).not.toHaveProperty("execution_mode");
  });

  it.each([
    "reconcile_inter_account_transfers",
    "import_wise_transactions",
    "continue_accounting_workflow",
    "reconcile_bank_transactions",
    "process_camt053",
  ])("leaves non-hidden tool %s untouched", (tool) => {
    expect(remapHiddenGranularTool(tool, { execute: true })).toBeUndefined();
  });

  it("rewrites every granular reference in a workflow envelope's actions and previews", () => {
    const envelope = {
      contract: "workflow_action_v1",
      recommended_next_action: {
        kind: "approve_tool_call",
        tool: "auto_confirm_exact_matches",
        args: { execute: true, min_confidence: 90 },
      },
      available_actions: [
        { kind: "approve_tool_call", tool: "auto_confirm_exact_matches", args: { execute: true } },
        { kind: "tool_call", tool: "reconcile_inter_account_transfers", args: { execute: false } },
        { kind: "done", label: "Nothing pending" },
      ],
      approval_previews: [
        { source_tool: "auto_confirm_exact_matches", execute_tool: "auto_confirm_exact_matches", execute_args: { execute: true } },
      ],
    };

    const remapped = remapHiddenGranularWorkflowEnvelope(envelope) as Record<string, any>;

    expect(remapped.recommended_next_action).toMatchObject({
      tool: "reconcile_bank_transactions",
      args: { mode: "execute_auto_confirm", min_confidence: 90 },
    });
    expect(remapped.available_actions[0]).toMatchObject({ tool: "reconcile_bank_transactions", args: { mode: "execute_auto_confirm" } });
    // A non-hidden tool (never gated) is left exactly as-is.
    expect(remapped.available_actions[1]).toEqual({ kind: "tool_call", tool: "reconcile_inter_account_transfers", args: { execute: false } });
    // A terminal action with no tool is untouched.
    expect(remapped.available_actions[2]).toEqual({ kind: "done", label: "Nothing pending" });
    expect(remapped.approval_previews[0]).toMatchObject({
      source_tool: "reconcile_bank_transactions",
      execute_tool: "reconcile_bank_transactions",
      execute_args: { mode: "execute_auto_confirm" },
    });
  });

  it("returns non-envelope values unchanged", () => {
    expect(remapHiddenGranularWorkflowEnvelope(undefined)).toBeUndefined();
    expect(remapHiddenGranularWorkflowEnvelope("not an envelope")).toBe("not an envelope");
  });
});
