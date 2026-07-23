import { describe, expect, it } from "vitest";
import { createTestRuntimeSafetyContext } from "./__fixtures__/runtime-safety.js";
import { runWithToolProfile } from "./tool-profile.js";
import { buildWorkflowEnvelope } from "./workflow-response.js";
import { buildWorkflowActionV2 } from "./workflow-action-v2.js";
import { createPublicWorkflowStateDetail } from "./workflow-state-store.js";

function guidedRuntime() {
  return createTestRuntimeSafetyContext({ scope: { profile: "guided" } });
}

describe("workflow_action_v2", () => {
  it("emits exactly one next_action and a compact alternative count, with no action/approval arrays", () => {
    const runtime = guidedRuntime();
    const envelope = runWithToolProfile("guided", () => buildWorkflowEnvelope({
      summary: "Prepared CAMT import.",
      needs_decision: [{ summary: "Which bank account dimension should be used?", recommendation: "LHV" }],
      recommended_step: {
        tool: "process_camt053",
        suggested_args: { mode: "dry_run", file_path: "/tmp/statement.xml" },
        purpose: "Preview the CAMT statement before creating transactions.",
      },
    }));
    const v2 = runWithToolProfile("guided", () => buildWorkflowActionV2(envelope, runtime.workflowStateStore, { workflow: "accounting_inbox" }));

    expect(v2.contract).toBe("workflow_action_v2");
    expect(v2.status).toBe("in_progress");
    expect(v2.next_action).toEqual({
      tool: "process_bank_input",
      args: { file_path: "/tmp/statement.xml" },
      approval_required: false,
    });
    expect(v2.alternative_action_count).toBe(1);
    expect(typeof v2.alternative_action_count).toBe("number");
    expect(v2).not.toHaveProperty("available_actions");
    expect(v2).not.toHaveProperty("approval_previews");
    expect(v2).not.toHaveProperty("recommended_next_action");
  });

  it("issues a workflow_handle that resolves back through the store", () => {
    const runtime = guidedRuntime();
    const envelope = runWithToolProfile("guided", () => buildWorkflowEnvelope({
      summary: "Prepared inbox.",
      recommended_step: { tool: "process_camt053", suggested_args: { mode: "parse", file_path: "/tmp/s.xml" } },
    }));
    const v2 = runWithToolProfile("guided", () => buildWorkflowActionV2(envelope, runtime.workflowStateStore, { workflow: "accounting_inbox" }));

    expect(v2.workflow_handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = runtime.workflowStateStore.inspect(v2.workflow_handle);
    expect(stored.workflow).toBe("accounting_inbox");
    expect(stored.status).toBe("in_progress");
  });

  it("preserves blockers from needs_review", () => {
    const runtime = guidedRuntime();
    const envelope = runWithToolProfile("guided", () => buildWorkflowEnvelope({
      summary: "Review a duplicate.",
      needs_review: [{ item_id: "r1", code: "duplicate_suspect", summary: "Possible duplicate payment", severity: "blocker" }],
      recommended_step: { tool: "process_camt053", suggested_args: { mode: "parse" } },
    }));
    const v2 = runWithToolProfile("guided", () => buildWorkflowActionV2(envelope, runtime.workflowStateStore));
    expect(v2.blockers).toEqual([
      { item_id: "r1", code: "duplicate_suspect", message: "Possible duplicate payment", severity: "blocker" },
    ]);
  });

  it("sets page only when detail items exist and keeps it latent when get_workflow_page is not visible", () => {
    const runtime = guidedRuntime();
    const envelope = runWithToolProfile("guided", () => buildWorkflowEnvelope({
      summary: "Prepared inbox.",
      recommended_step: { tool: "process_camt053", suggested_args: { mode: "parse" } },
    }));

    const withoutItems = runWithToolProfile("guided", () => buildWorkflowActionV2(envelope, runtime.workflowStateStore));
    expect(withoutItems.page).toBeUndefined();

    const items = [
      createPublicWorkflowStateDetail({ item_id: "1", label: "row one" }),
      createPublicWorkflowStateDetail({ item_id: "2", label: "row two" }),
    ];
    const withItems = runWithToolProfile("guided", () => buildWorkflowActionV2(envelope, runtime.workflowStateStore, { items }));
    expect(withItems.page).toEqual({ available: false, total_items: 2, tool: "get_workflow_page", args: {} });
  });

  it("emits an actionable page reference only where get_workflow_page is visible (full)", () => {
    const runtime = createTestRuntimeSafetyContext({ scope: { profile: "full" } });
    const envelope = buildWorkflowEnvelope({
      summary: "Prepared inbox.",
      recommended_step: { tool: "process_camt053", suggested_args: { mode: "parse" } },
    });
    const items = [createPublicWorkflowStateDetail({ item_id: "1" })];
    const v2 = runWithToolProfile("full", () => buildWorkflowActionV2(envelope, runtime.workflowStateStore, { items }));
    expect(v2.page).toEqual({
      available: true,
      total_items: 1,
      tool: "get_workflow_page",
      args: { workflow_handle: v2.workflow_handle },
    });
  });

  it("tolerates a partial envelope with no needs_review or summary (no crash)", () => {
    const runtime = guidedRuntime();
    // A guided continue_accounting_workflow(next) can derive the envelope from
    // user-supplied workflow_state_json that lacks needs_review / summary entirely.
    const partial = { contract: "workflow_action_v1" } as unknown as Parameters<typeof buildWorkflowActionV2>[0];
    const v2 = runWithToolProfile("guided", () => buildWorkflowActionV2(partial, runtime.workflowStateStore));
    expect(v2.contract).toBe("workflow_action_v2");
    expect(v2.blockers).toEqual([]);
    expect(v2.message).toBe("");
    expect(v2.alternative_action_count).toBe(0);
    expect(v2.workflow_handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("keeps a fail-closed advanced action fail-closed: next_action is the setup fallback", () => {
    const runtime = guidedRuntime();
    const envelope = runWithToolProfile("guided", () => buildWorkflowEnvelope({
      summary: "Advanced proposal",
      recommended_step: { tool: "create_journal", suggested_args: { amount: 12 } },
    }));
    const v2 = runWithToolProfile("guided", () => buildWorkflowActionV2(envelope, runtime.workflowStateStore));
    expect(v2.status).toBe("needs_review");
    expect(v2.next_action).toEqual({ tool: "get_setup_instructions", args: {}, approval_required: false });
  });
});
