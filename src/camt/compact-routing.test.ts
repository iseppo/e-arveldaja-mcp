import { describe, it, expect, vi } from "vitest";
import { registerCamtImportTools } from "../tools/camt-import.js";
import { parseMcpResponse } from "../mcp-json.js";
import { runWithToolProfile } from "../tool-profile.js";
import {
  createAccountingWorkflowApi,
  createMockToolServer,
  fixtureAccountDimension,
  fixtureBankAccount,
  fixtureCamtXml,
  getRegisteredToolHandler,
} from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";

vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const inline = (xml: string): string => `base64:${Buffer.from(xml, "utf8").toString("base64")}`;

function setup() {
  const server = createMockToolServer();
  const api = createAccountingWorkflowApi({
    accountDimensions: [fixtureAccountDimension({ id: 7 })],
    bankAccounts: [fixtureBankAccount({ accounts_dimensions_id: 7 })],
    transactionRows: [],
  });
  registerCamtImportTools(server, api, createTestRuntimeSafetyContext(), {
    enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true,
    enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true,
  });
  return { api, handler: getRegisteredToolHandler(server, "import_camt053") };
}

async function call(handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>, args: Record<string, unknown>) {
  return parseMcpResponse((await handler(args)).content[0]!.text);
}

describe("CAMT compact profile routing", () => {
  it("standard profile keeps the full envelope (no compact summary)", async () => {
    const { handler } = setup();
    const payload = await call(handler, { file_path: inline(fixtureCamtXml()), accounts_dimensions_id: 7, execute: false });
    expect(payload.mode).toBe("DRY_RUN");
    expect(payload.statement_metadata).toBeDefined();
    expect(payload.execution).toBeDefined();
    expect(payload.summary).toBeDefined();
    // Full-envelope summary is a counts object, not the compact operation_summary_v1.
    expect(payload.summary.contract).toBeUndefined();
  });

  it("guided profile returns the compact operation summary with a plan handle on dry run", async () => {
    const { handler } = setup();
    await runWithToolProfile("guided", async () => {
      const payload = await call(handler, { file_path: inline(fixtureCamtXml()), accounts_dimensions_id: 7, execute: false });
      expect(payload.summary.contract).toBe("operation_summary_v1");
      expect(payload.summary.status).toBe("ready_for_approval");
      expect(typeof payload.summary.plan_handle).toBe("string");
      expect(payload.summary.scope.account).toBe("EE637700771011212909");
      // Statement identity: attacker-controllable statement_id is OCR-wrapped.
      expect(payload.summary.scope.statement_id).toMatch(/UNTRUSTED_OCR_START/);
      expect(payload.summary.scope.statement_id).toContain("stmt-1");
      // The new compact surface wraps display-only bank_reference too.
      expect(payload.summary.samples[0].bank_reference).toMatch(/UNTRUSTED_OCR_START/);
      expect(payload.summary.counts.would_create).toBe(1);
      // No unbounded per-row array leaks into the compact surface.
      expect(payload.statement_metadata).toBeUndefined();
    });
  });

  it("guided execute issues an operation-result handle and references get_operation_result_page", async () => {
    const { api, handler } = setup();
    await runWithToolProfile("guided", async () => {
      const dry = await call(handler, { file_path: inline(fixtureCamtXml()), accounts_dimensions_id: 7, execute: false });
      const planHandle = dry.summary.plan_handle as string;
      const exec = await call(handler, { file_path: inline(fixtureCamtXml()), accounts_dimensions_id: 7, execute: true, plan_handle: planHandle });
      expect(exec.summary.contract).toBe("operation_summary_v1");
      expect(exec.summary.status).toBe("completed");
      expect(exec.summary.details.tool).toBe("get_operation_result_page");
      expect(typeof exec.summary.details.args.operation_handle).toBe("string");
      expect(api.transactions.create).toHaveBeenCalledTimes(1);
    });
  });
});
