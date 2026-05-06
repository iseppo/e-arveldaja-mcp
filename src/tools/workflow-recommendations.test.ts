import { describe, expect, it, vi } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import { registerWorkflowRecommendationTools } from "./workflow-recommendations.js";

function getRecommendWorkflowHarness() {
  const server = { registerTool: vi.fn() };
  registerWorkflowRecommendationTools(server as never);
  const call = server.registerTool.mock.calls.find(([name]) => name === "recommend_workflow");
  if (!call) throw new Error("recommend_workflow tool was not registered");
  return {
    options: call[1] as { inputSchema?: Record<string, unknown> },
    handler: call[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("recommend_workflow", () => {
  it("registers a discoverability tool with a structured goal input", () => {
    const { options } = getRecommendWorkflowHarness();

    expect(options.inputSchema).toHaveProperty("goal");
    expect(options.inputSchema).toHaveProperty("risk_tolerance");
  });

  it("recommends the CAMT import workflow for bank statement goals", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "import bank statement CAMT file", risk_tolerance: "balanced" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload).toMatchObject({
      ok: true,
      action: "recommended",
      entity: "workflow",
      recommended_workflow: {
        id: "import-camt",
        prompt: "import-camt",
      },
      risk_policy: {
        default_mode: "dry_run",
      },
    });
    expect(payload.next_actions[0]).toMatchObject({
      tool: "import_camt053",
      args: { execute: false },
    });
    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      summary: expect.stringContaining("Recommended Import CAMT Bank Statement"),
      needs_decision: [],
      needs_review: [],
      recommended_next_action: {
        kind: "tool_call",
        tool: "import_camt053",
        approval_required: false,
      },
    });
    expect(payload.workflow.available_actions[0]).toMatchObject({
      kind: "tool_call",
      tool: "import_camt053",
    });
  });

  it("returns a compact catalog when no goal is provided", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.ok).toBe(true);
    expect(payload.available_workflows.map((workflow: any) => workflow.id)).toEqual(
      expect.arrayContaining(["accounting-inbox", "book-invoice", "import-wise", "reconcile-bank"]),
    );
    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      recommended_next_action: {
        kind: "answer_question",
        question: "What accounting task should be handled next?",
      },
    });
    expect(payload.workflow.recommended_next_action.tool).toBeUndefined();
    expect(JSON.stringify(payload.workflow)).not.toContain("<describe the user's accounting goal>");
  });

  it("recommends accounting_inbox as the merged entry point for workspace triage", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "scan this workspace and triage accounting inbox files" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({
      id: "accounting-inbox",
    });
    expect(payload.raw.primary_tools).toContain("accounting_inbox");
    expect(payload.raw.primary_tools).toContain("continue_accounting_workflow");
    expect(payload.next_actions[0]).toMatchObject({
      tool: "accounting_inbox",
      args: { mode: "dry_run" },
    });
    expect(payload.workflow.recommended_next_action).toMatchObject({
      kind: "tool_call",
      tool: "accounting_inbox",
      args: { mode: "dry_run" },
    });
  });

  it("recommends reconcile_bank_transactions as the merged bank reconciliation entry point", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "reconcile unmatched bank transactions and match payments" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({
      id: "reconcile-bank",
    });
    expect(payload.raw.primary_tools).toContain("reconcile_bank_transactions");
    expect(payload.raw.primary_tools).toContain("reconcile_transactions");
    expect(payload.next_actions[0]).toMatchObject({
      tool: "reconcile_bank_transactions",
      args: { mode: "suggest", min_confidence: 30 },
    });
    expect(payload.workflow.recommended_next_action).toMatchObject({
      kind: "tool_call",
      tool: "reconcile_bank_transactions",
      args: { mode: "suggest", min_confidence: 30 },
    });
  });

  it("recommends the merged classification wrapper while keeping compatibility tools visible", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "process a folder of receipts and classify expenses" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.raw.primary_tools).toContain("classify_bank_transactions");
    expect(payload.raw.primary_tools).toContain("apply_transaction_classifications");
    expect(payload.raw.primary_tools).not.toContain("apply_unmatched_transaction_classifications");
  });
});
