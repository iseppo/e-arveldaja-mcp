import { describe, expect, it } from "vitest";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import { runWithToolProfile } from "./tool-profile.js";
import { createPublicWorkflowStateDetail } from "./workflow-state-store.js";
import {
  approvalPreviewFromDryRunStep,
  buildWorkflowEnvelope,
  projectWorkflowResponse,
  remapHiddenGranularTool,
  remapHiddenGranularWorkflowEnvelope,
  workflowActionFromBlockedDryRunStep,
} from "./workflow-response.js";

describe("workflow response helpers", () => {
  it("projects an advanced guided action to review-only setup guidance", () => {
    const workflow = runWithToolProfile("guided", () => buildWorkflowEnvelope({
      summary: "Advanced proposal",
      recommended_step: { tool: "create_journal", suggested_args: { amount: 12 } },
    }));
    expect(workflow).toMatchObject({
      status: "needs_review",
      blocker: { code: "advanced_action_unavailable_in_profile" },
      proposal: { tool: "create_journal", args: { amount: 12 } },
      recommended_next_action: { tool: "get_setup_instructions", args: {}, approval_required: false },
      available_actions: [{ tool: "get_setup_instructions", args: {}, approval_required: false }],
      approval_previews: [],
    });
  });
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
    const wiseDigest = "a".repeat(64);
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
          suggested_args: {
            file_path: "/tmp/wise.csv",
            accounts_dimensions_id: 8,
            approved_command_digest: wiseDigest,
            execute: false,
          },
          preview: {
            created: 2,
            command_count: 4,
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
      execute_args: {
        file_path: "/tmp/wise.csv",
        accounts_dimensions_id: 8,
        approved_command_digest: wiseDigest,
        execute: true,
      },
      accounting_impact: expect.arrayContaining([
        "2 bank transactions",
        "1 invoice FX update",
      ]),
      duplicate_risk: expect.stringContaining("confirms or links source bank transactions"),
    });

    const invoiceOnly = buildWorkflowEnvelope({
      summary: "One Wise invoice FX update is ready for approval.",
      dry_run_steps: [{
        tool: "import_wise_transactions",
        suggested_args: {
          file_path: "/tmp/wise.csv",
          accounts_dimensions_id: 8,
          approved_command_digest: wiseDigest,
          execute: false,
        },
        preview: {
          created: 0,
          command_count: 1,
          skipped: 1,
          error_count: 0,
          invoice_currency_fixes: {
            total: 1,
            candidates: [{ invoice_id: 42, category: "foreign_currency_lock", result: "would_update" }],
          },
        },
      }],
    });
    const expectedInvoiceOnlyArgs = {
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 8,
      approved_command_digest: wiseDigest,
      execute: true,
    };
    expect(invoiceOnly.approval_previews).toHaveLength(1);
    expect(invoiceOnly.approval_previews[0]?.execute_args).toEqual(expectedInvoiceOnlyArgs);
    expect(invoiceOnly.available_actions[0]).toMatchObject({ args: expectedInvoiceOnlyArgs });
    expect(invoiceOnly.recommended_next_action).toMatchObject({ args: expectedInvoiceOnlyArgs });
    expect(invoiceOnly.approval_previews[0]?.execute_args).not.toHaveProperty("command_count");
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

describe("profile-gated v1/v2 workflow projection", () => {
  function envelope() {
    return buildWorkflowEnvelope({
      summary: "Prepared inbox.",
      recommended_step: { tool: "process_camt053", suggested_args: { mode: "parse", file_path: "/tmp/s.xml" } },
    });
  }

  it("keeps standard on the byte-compatible v1 envelope", () => {
    const runtime = createTestRuntimeSafetyContext({ scope: { profile: "standard" } });
    const result = runWithToolProfile("standard", () => projectWorkflowResponse(envelope(), runtime.workflowStateStore, { workflow: "accounting_inbox" }));
    expect(result.contract).toBe("workflow_action_v1");
    expect(result).toHaveProperty("available_actions");
    expect(runtime.workflowStateStore.activeCount).toBe(0);
  });

  it("keeps full on the v1 envelope", () => {
    const runtime = createTestRuntimeSafetyContext({ scope: { profile: "full" } });
    const result = runWithToolProfile("full", () => projectWorkflowResponse(envelope(), runtime.workflowStateStore, { workflow: "accounting_inbox" }));
    expect(result.contract).toBe("workflow_action_v1");
  });

  it("emits the compact v2 envelope for guided and guided-sales", () => {
    for (const profile of ["guided", "guided-sales"] as const) {
      const runtime = createTestRuntimeSafetyContext({ scope: { profile } });
      // A response WITH pageable detail state mints and carries a workflow handle.
      const items = [createPublicWorkflowStateDetail({ item_id: "1", label: "row one" })];
      const result = runWithToolProfile(profile, () => projectWorkflowResponse(
        runWithToolProfile(profile, () => envelope()),
        runtime.workflowStateStore,
        { workflow: "accounting_inbox", items },
      ));
      expect(result.contract).toBe("workflow_action_v2");
      expect(result).not.toHaveProperty("available_actions");
      expect((result as { workflow_handle: string }).workflow_handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("mints no workflow handle for an item-less guided v2 envelope (§12)", () => {
    for (const profile of ["guided", "guided-sales"] as const) {
      const runtime = createTestRuntimeSafetyContext({ scope: { profile } });
      const result = runWithToolProfile(profile, () => projectWorkflowResponse(
        runWithToolProfile(profile, () => envelope()),
        runtime.workflowStateStore,
        { workflow: "accounting_inbox" },
      ));
      expect(result.contract).toBe("workflow_action_v2");
      expect((result as { workflow_handle?: string }).workflow_handle).toBeUndefined();
      expect(runtime.workflowStateStore.activeCount).toBe(0);
    }
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

  it("preserves plan review scope through every hidden-tool remapping surface", () => {
    const reviewScope = {
      plan_handle: "A".repeat(43),
      command_count: 3,
      category_counts: { create: 2, confirm: 1 },
      monetary_totals: { EUR: 42 },
      exclusions: [{ reason: "duplicate" }],
      plan_page: { tool: "get_execution_plan_page", args: { plan_handle: "A".repeat(43) } },
      execute: true,
      execution_mode: "create",
    };
    const envelope = {
      recommended_next_action: { tool: "process_receipt_batch", args: reviewScope },
      available_actions: [{ tool: "process_receipt_batch", args: reviewScope }],
      approval_previews: [{ source_tool: "process_receipt_batch", execute_tool: "process_receipt_batch", execute_args: reviewScope }],
    };
    const remapped = remapHiddenGranularWorkflowEnvelope(envelope) as Record<string, any>;
    for (const args of [
      remapped.recommended_next_action.args,
      remapped.available_actions[0].args,
      remapped.approval_previews[0].execute_args,
    ]) {
      expect(args).toMatchObject({
        plan_handle: reviewScope.plan_handle,
        command_count: 3,
        category_counts: reviewScope.category_counts,
        monetary_totals: reviewScope.monetary_totals,
        exclusions: reviewScope.exclusions,
        plan_page: reviewScope.plan_page,
      });
      expect(args).not.toHaveProperty("execute");
      expect(args).not.toHaveProperty("execution_mode");
    }
  });

  it("returns non-envelope values unchanged", () => {
    expect(remapHiddenGranularWorkflowEnvelope(undefined)).toBeUndefined();
    expect(remapHiddenGranularWorkflowEnvelope("not an envelope")).toBe("not an envelope");
  });

  it("guided fail-closed output preserves ordered multiple blocked proposals and safe action context", () => {
    const safe = {
      kind: "tool_call", label: "Open the inbox", why: "Continue the safe review.",
      approval_required: false, tool: "accounting_inbox", args: { mode: "scan" }, source: "safe",
    };
    const firstBlocked = {
      kind: "tool_call", label: "Create journal", why: "Post the adjustment.",
      approval_required: true, tool: "create_journal", args: { amount: 12 }, source: "first",
    };
    const secondBlocked = {
      kind: "tool_call", label: "Delete transaction", why: "Remove the duplicate.",
      approval_required: true, tool: "delete_transaction", args: { id: 9 }, source: "second",
    };
    const remapped = runWithToolProfile("guided", () => remapHiddenGranularWorkflowEnvelope({
      recommended_next_action: safe,
      available_actions: [safe, firstBlocked, secondBlocked],
      approval_previews: [{ execute_tool: "create_journal", execute_args: { amount: 12 } }],
      needs_review: [],
    })) as Record<string, any>;

    expect(remapped.status).toBe("needs_review");
    expect(remapped.blocker.code).toBe("advanced_action_unavailable_in_profile");
    expect(remapped.blocked_proposals).toEqual([firstBlocked, secondBlocked]);
    expect(remapped.proposal).toEqual(firstBlocked);
    expect(remapped.safe_action_context).toEqual([safe]);
    expect(remapped.action_proposals).toEqual([safe, firstBlocked, secondBlocked]);
    expect(remapped.needs_review).toEqual([firstBlocked, secondBlocked]);
    expect(remapped.recommended_next_action.tool).toBe("get_setup_instructions");
    expect(remapped.recommended_next_action.approval_required).toBe(false);
    expect(remapped.available_actions).toEqual([remapped.recommended_next_action]);
    expect(remapped.approval_previews).toEqual([]);
  });
});
