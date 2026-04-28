import { describe, expect, it } from "vitest";
import { approvalPreviewFromDryRunStep, buildWorkflowEnvelope } from "./workflow-response.js";

describe("workflow response helpers", () => {
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
});
