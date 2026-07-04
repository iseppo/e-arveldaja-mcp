import { describe, expect, it, vi } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import { registerWorkflowRecommendationTools } from "./workflow-recommendations.js";
import type { ToolExposureConfig } from "../config.js";

const ALL_ENABLED: ToolExposureConfig = {
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
};

function getRecommendWorkflowHarness(exposure?: Partial<ToolExposureConfig>) {
  const server = { registerTool: vi.fn() };
  registerWorkflowRecommendationTools(server as never, { ...ALL_ENABLED, ...exposure });
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
    expect(payload.raw.primary_tools).toContain("process_camt053");
    expect(payload.raw.primary_tools).not.toContain("import_camt053");
    expect(payload.raw.primary_tools).not.toContain("parse_camt053");
    expect(payload.next_actions[0]).toMatchObject({
      tool: "process_camt053",
      args: { mode: "dry_run" },
    });
    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      summary: expect.stringContaining("Recommended Import CAMT Bank Statement"),
      needs_decision: [],
      needs_review: [],
      recommended_next_action: {
        kind: "tool_call",
        tool: "process_camt053",
        approval_required: false,
      },
    });
    expect(payload.workflow.available_actions[0]).toMatchObject({
      kind: "tool_call",
      tool: "process_camt053",
    });
  });

  it("returns a compact catalog when no goal is provided", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({});
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.ok).toBe(true);
    expect(payload.available_workflows.map((workflow: any) => workflow.id)).toEqual([
      "setup-credentials",
      "setup-e-arveldaja",
      "accounting-inbox",
      "resolve-accounting-review",
      "prepare-accounting-review-action",
      "book-invoice",
      "receipt-batch",
      "import-camt",
      "import-wise",
      "classify-unmatched",
      "reconcile-bank",
      "month-end-close",
      "new-supplier",
      "company-overview",
      "lightyear-booking",
    ]);
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

  it("recommends company overview with the real balance-sheet date argument", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "financial overview dashboard" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({
      id: "company-overview",
    });
    expect(payload.next_actions[0]).toMatchObject({
      tool: "compute_balance_sheet",
      args: { date_to: "<YYYY-MM-DD>" },
    });
    expect(payload.next_actions[0].args).not.toHaveProperty("as_of_date");
    expect(payload.workflow.recommended_next_action).toMatchObject({
      kind: "tool_call",
      tool: "compute_balance_sheet",
      args: { date_to: "<YYYY-MM-DD>" },
    });
  });

  it.each([
    ["close March month end", "month-end-close"],
    ["book Lightyear CSV dividends and trades", "lightyear-booking"],
    ["set up API credentials from apikey file", "setup-credentials"],
    ["create a new supplier from registry code", "new-supplier"],
    ["resolve accountant review item", "resolve-accounting-review"],
    ["prepare approved review action", "prepare-accounting-review-action"],
  ])("recommends %s as %s", async (goal, expectedWorkflowId) => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({
      id: expectedWorkflowId,
    });
    expect(payload.workflow.recommended_next_action.label).not.toMatch(/^Run /);
  });

  it("recommends accounting_inbox as the merged entry point for workspace triage", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "scan this workspace and triage accounting inbox files" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({
      id: "accounting-inbox",
    });
    expect(payload.raw.primary_tools).toContain("accounting_inbox");
    expect(payload.raw.primary_tools).not.toContain("run_accounting_inbox_dry_runs");
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
    expect(payload.raw.primary_tools).not.toContain("reconcile_transactions");
    expect(payload.raw.primary_tools).not.toContain("auto_confirm_exact_matches");
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

  it("recommends the merged classification wrapper without legacy primitives as primary tools", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "classify unmatched bank transactions into expense groups" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.raw.primary_tools).toContain("classify_bank_transactions");
    expect(payload.raw.primary_tools).not.toContain("apply_transaction_classifications");
    expect(payload.raw.primary_tools).not.toContain("apply_unmatched_transaction_classifications");
  });

  it("recommends receipt_batch as the merged receipt workflow entry point", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "process a folder of receipts and book expenses" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({
      id: "receipt-batch",
    });
    expect(payload.raw.primary_tools).toContain("receipt_batch");
    expect(payload.raw.primary_tools).not.toContain("process_receipt_batch");
    expect(payload.raw.primary_tools).not.toContain("scan_receipt_folder");
    expect(payload.next_actions[0]).toMatchObject({
      tool: "receipt_batch",
      args: { mode: "dry_run" },
    });
    expect(payload.workflow.recommended_next_action).toMatchObject({
      kind: "tool_call",
      tool: "receipt_batch",
      args: { mode: "dry_run" },
    });
  });

  it("drops receivables aging from the company-overview recommendation when sales is disabled", async () => {
    const { handler } = getRecommendWorkflowHarness({ enableSales: false });

    const result = await handler({ goal: "financial overview dashboard" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({ id: "company-overview" });
    expect(payload.raw.primary_tools).not.toContain("compute_receivables_aging");
    expect(payload.raw.primary_tools).toContain("compute_payables_aging");
  });

  it("omits the lightyear-booking workflow entirely when Lightyear is disabled", async () => {
    const { handler } = getRecommendWorkflowHarness({ enableLightyear: false });

    const listed = parseMcpResponse((await handler({})).content[0]!.text) as Record<string, any>;
    expect(listed.available_workflows.map((workflow: any) => workflow.id)).not.toContain("lightyear-booking");

    const recommended = parseMcpResponse(
      (await handler({ goal: "book Lightyear CSV dividends and trades" })).content[0]!.text,
    ) as Record<string, any>;
    expect(recommended.recommended_workflow?.id).not.toBe("lightyear-booking");
  });

  it("starts book-invoice recommendations with current VAT status before extraction", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "book this supplier invoice PDF" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({
      id: "book-invoice",
    });
    expect(payload.raw.primary_tools[0]).toBe("get_vat_info");
    expect(payload.next_actions[0]).toMatchObject({
      tool: "get_vat_info",
      args: {},
    });
    expect(payload.next_actions[1]).toMatchObject({
      tool: "extract_pdf_invoice",
      args: { file_path: "<absolute invoice PDF/image path>" },
    });
  });
});
