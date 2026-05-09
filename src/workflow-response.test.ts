import { describe, expect, it } from "vitest";
import { approvalPreviewFromDryRunStep, buildWorkflowEnvelope } from "./workflow-response.js";

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
          summary: "Wise dry run would create 2 bank transactions.",
          suggested_args: { file_path: "/tmp/wise.csv", accounts_dimensions_id: 8, execute: false },
          preview: { created: 2, skipped: 0, error_count: 0 },
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
