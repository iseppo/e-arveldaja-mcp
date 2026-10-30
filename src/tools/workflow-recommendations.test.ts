import { describe, expect, it, vi } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import { registerWorkflowRecommendationTools } from "./workflow-recommendations.js";
import type { ToolExposureConfig } from "../config.js";
import { ESTONIAN_VAT_METADATA, VAT_REGISTRATION_THRESHOLD_DISPLAY } from "../estonian-tax-rules.js";
import { runWithToolProfile, type ToolProfile } from "../tool-profile.js";
import { enabledPromptDefinitions, promptToolAvailability } from "../prompt-registry.js";

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

function getRecommendWorkflowHarness(exposure?: Partial<ToolExposureConfig>, options: { setupMode?: boolean } = {}) {
  const server = { registerTool: vi.fn() };
  registerWorkflowRecommendationTools(server as never, { ...ALL_ENABLED, ...exposure }, options);
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
    // interaction_style replaces the misleading risk_tolerance; the deprecated
    // option is still advertised for the compatibility window.
    expect(options.inputSchema).toHaveProperty("interaction_style");
    expect(options.inputSchema).toHaveProperty("risk_tolerance");
  });

  it("echoes the resolved interaction_style and no longer defaults a risk_tolerance echo", async () => {
    const { handler } = getRecommendWorkflowHarness();
    const payload = parseMcpResponse((await handler({ goal: "import bank statement CAMT file" })).content[0]!.text) as Record<string, any>;
    expect(payload.interaction_style).toBe("guided");
    // With no risk_tolerance supplied, it is not echoed back.
    expect(payload.risk_tolerance).toBeUndefined();
  });

  it("still ACCEPTS deprecated risk_tolerance and maps careful→detailed (detail depth only)", async () => {
    const { handler } = getRecommendWorkflowHarness();
    const careful = parseMcpResponse((await handler({ goal: "import bank statement CAMT file", risk_tolerance: "careful" })).content[0]!.text) as Record<string, any>;
    expect(careful.interaction_style).toBe("detailed");
    expect(careful.risk_tolerance).toBe("careful"); // echoed back when supplied
    const fast = parseMcpResponse((await handler({ goal: "import bank statement CAMT file", risk_tolerance: "fast" })).content[0]!.text) as Record<string, any>;
    expect(fast.interaction_style).toBe("concise");
  });

  it("interaction_style / risk_tolerance NEVER change which workflow or steps are recommended", async () => {
    const { handler } = getRecommendWorkflowHarness();
    const baseline = parseMcpResponse((await handler({ goal: "import bank statement CAMT file" })).content[0]!.text) as Record<string, any>;
    for (const args of [
      { interaction_style: "concise" as const },
      { interaction_style: "detailed" as const },
      { risk_tolerance: "fast" as const },
      { risk_tolerance: "careful" as const },
    ]) {
      const payload = parseMcpResponse((await handler({ goal: "import bank statement CAMT file", ...args })).content[0]!.text) as Record<string, any>;
      expect(payload.recommended_workflow.id).toBe(baseline.recommended_workflow.id);
      expect(payload.next_actions).toEqual(baseline.next_actions);
      expect(payload.risk_policy).toEqual(baseline.risk_policy);
    }
  });

  it("explicit interaction_style overrides the deprecated risk_tolerance mapping", async () => {
    const { handler } = getRecommendWorkflowHarness();
    const payload = parseMcpResponse((await handler({ goal: "import bank statement CAMT file", interaction_style: "concise", risk_tolerance: "careful" })).content[0]!.text) as Record<string, any>;
    expect(payload.interaction_style).toBe("concise");
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
      "vat-registration-threshold",
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
    ["check KMKR 40 000 threshold with finantskäive", "vat-registration-threshold"],
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

  it("derives current VAT recommendation guidance from canonical metadata", async () => {
    const { handler } = getRecommendWorkflowHarness();
    const payload = parseMcpResponse(
      (await handler({ goal: "check KMKR threshold with finantskäive" })).content[0]!.text,
    ) as Record<string, any>;

    expect(payload.recommended_workflow.summary).toContain(VAT_REGISTRATION_THRESHOLD_DISPLAY);
    expect(payload.recommended_workflow.summary).toContain(ESTONIAN_VAT_METADATA.registration.scope_effective_from);
    expect(payload.recommended_workflow.summary).toContain(ESTONIAN_VAT_METADATA.verified_at);
  });

  it("uses file_path for the Lightyear statement next action (M25)", async () => {
    const { handler } = getRecommendWorkflowHarness();

    const result = await handler({ goal: "book Lightyear CSV dividends and trades" });
    const payload = parseMcpResponse(result.content[0]!.text) as Record<string, any>;

    expect(payload.recommended_workflow).toMatchObject({ id: "lightyear-booking" });
    // parse_lightyear_statement's own parameter is file_path — the recommendation
    // must not drift to statement_path.
    expect(payload.next_actions[0]).toMatchObject({
      tool: "parse_lightyear_statement",
      args: { file_path: expect.any(String) },
    });
    expect(payload.next_actions[0].args).not.toHaveProperty("statement_path");
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

  it("omits the VAT threshold workflow entirely when tax tools are disabled", async () => {
    const { handler } = getRecommendWorkflowHarness({ enableTaxTools: false });

    const listed = parseMcpResponse((await handler({})).content[0]!.text) as Record<string, any>;
    expect(listed.available_workflows.map((workflow: any) => workflow.id)).not.toContain("vat-registration-threshold");

    const recommended = parseMcpResponse(
      (await handler({ goal: "check KMKR 40 000 threshold" })).content[0]!.text,
    ) as Record<string, any>;
    expect(recommended.recommended_workflow?.id).not.toBe("vat-registration-threshold");
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
  interface CompactWorkflow { id: string; prompt: string; default_mode: string; primary_tools: string[]; required_inputs: string[] }
  interface RecommendPayload {
    available_workflows: CompactWorkflow[];
    recommended_workflow: CompactWorkflow;
    raw: CompactWorkflow;
    next_actions: Array<{ tool: string; args: Record<string, unknown>; why: string }>;
  }

  async function callOnProfile(profile: ToolProfile, args: Record<string, unknown>, options: { setupMode?: boolean } = {}) {
    const { handler } = getRecommendWorkflowHarness(undefined, options);
    const result = await runWithToolProfile(profile, () => handler(args));
    return parseMcpResponse(result.content[0]!.text) as RecommendPayload;
  }

  it.each(["guided", "guided-sales", "standard", "full"] as const)(
    "lists exactly the workflows whose prompt is registered on %s, naming only registered tools",
    async (profile) => {
      const listed = await callOnProfile(profile, {});
      const ids = listed.available_workflows.map(workflow => workflow.prompt);
      const prompts = enabledPromptDefinitions(ALL_ENABLED, { toolProfile: profile, setupMode: false }).map(definition => definition.name);
      expect([...ids].sort()).toEqual([...prompts].sort());
      const hasTool = promptToolAvailability({ toolProfile: profile, toolExposure: ALL_ENABLED, setupMode: false });
      for (const workflow of listed.available_workflows) {
        for (const tool of workflow.primary_tools) expect(hasTool(tool), `${workflow.id}: ${tool}`).toBe(true);
        if (!hasTool("list_account_dimensions")) {
          expect(workflow.required_inputs.join(" "), workflow.id).not.toContain("list_account_dimensions");
        }
      }
    },
  );

  it("routes month-end close on guided to run_accounting_report month_end", async () => {
    const payload = await callOnProfile("guided", { goal: "month end close" });
    expect(payload.recommended_workflow.id).toBe("month-end-close");
    expect(payload.raw.primary_tools).toEqual(["run_accounting_report"]);
    expect(payload.next_actions).toEqual([{
      tool: "run_accounting_report",
      args: { report: "month_end", month: "<YYYY-MM>" },
      why: "Start with the month-end checklist to identify blockers before computing reports.",
    }]);
  });

  it("keeps the granular month-end checklist on full without the guided alternative", async () => {
    const payload = await callOnProfile("full", { goal: "month end close" });
    expect(payload.next_actions.map(action => action.tool)).toEqual(["month_end_close_checklist"]);
  });

  it("routes company overview on guided-sales to run_accounting_report balance_sheet", async () => {
    const payload = await callOnProfile("guided-sales", { goal: "financial overview dashboard" });
    expect(payload.recommended_workflow.id).toBe("company-overview");
    expect(payload.next_actions).toEqual([expect.objectContaining({
      tool: "run_accounting_report",
      args: { report: "balance_sheet", date_to: "<YYYY-MM-DD>" },
    })]);
  });

  it("routes CAMT import on guided to process_bank_input and drops the unregistered dimension hint", async () => {
    const payload = await callOnProfile("guided", { goal: "import bank statement CAMT file" });
    expect(payload.recommended_workflow.id).toBe("import-camt");
    expect(payload.raw.primary_tools).toEqual(["process_bank_input"]);
    expect(payload.next_actions[0]).toMatchObject({
      tool: "process_bank_input",
      args: { file_path: "<absolute CAMT.053 XML path>", accounts_dimensions_id: "<bank dimension id>" },
    });
    expect(payload.raw.required_inputs).toEqual(["absolute CAMT.053 XML path", "optional bank account dimension id"]);
  });

  it("names credential tools only when they are registered (setup mode vs configured)", async () => {
    const configured = await callOnProfile("standard", { goal: "set up API credentials from apikey file" });
    expect(configured.recommended_workflow.id).toBe("setup-credentials");
    expect(configured.raw.primary_tools).toEqual(["get_setup_instructions", "list_connections"]);

    const setup = await callOnProfile("standard", { goal: "set up API credentials from apikey file" }, { setupMode: true });
    expect(setup.raw.primary_tools).toEqual([
      "get_setup_instructions", "import_apikey_credentials", "list_stored_credentials", "remove_stored_credentials", "list_connections",
    ]);
  });

  it("uses confirm_once for the setup-e-arveldaja workflow", async () => {
    const payload = await callOnProfile("standard", { goal: "setup e-arveldaja" });
    expect(payload.recommended_workflow).toMatchObject({ id: "setup-e-arveldaja", default_mode: "confirm_once" });
  });
});
