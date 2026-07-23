import { describe, it, expect, vi } from "vitest";
import { registerWiseImportTools } from "../tools/wise-import.js";
import { parseMcpResponse } from "../mcp-json.js";
import { runWithToolProfile } from "../tool-profile.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";

vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../cache-control.js", () => ({ clearRuntimeCaches: vi.fn() }));

const CSV_HEADER = [
  "ID", "Status", "Direction", "Created on", "Finished on",
  "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
  "Source name", "Source amount (after fees)", "Source currency",
  "Target name", "Target amount (after fees)", "Target currency",
  "Exchange rate", "Reference", "Batch", "Created by", "Category", "Note",
].join(",");

function oneRowCsv(): string {
  const row = [
    "WISE-1", "COMPLETED", "OUT", "2026-01-10 10:00:00", "2026-01-10 10:00:00",
    "0", "EUR", "0", "EUR",
    "MyCo OÜ", "100", "EUR",
    "Acme OÜ", "100", "EUR",
    "1", "inv-1", "", "", "General", "note",
  ].join(",");
  return `${CSV_HEADER}\n${row}\n`;
}

const inline = (csv: string): string => `base64:csv:${Buffer.from(csv, "utf8").toString("base64")}`;

function setup() {
  const server = { registerTool: vi.fn() } as any;
  const create = vi.fn().mockResolvedValue({ created_object_id: 9001 });
  const api = {
    clients: { listAll: vi.fn().mockResolvedValue([{ id: 77, name: "Wise" }]), findByName: vi.fn().mockResolvedValue([]) },
    readonly: {
      getAccountDimensions: vi.fn().mockResolvedValue([{ id: 9, accounts_id: 8610, title_est: "Muud finantskulud", is_deleted: false }]),
      getBankAccounts: vi.fn().mockResolvedValue([]),
      getInvoiceInfo: vi.fn().mockResolvedValue({}),
    },
    journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
    transactions: {
      connectionFingerprint: "wise-compact-test",
      listAll: vi.fn().mockResolvedValue([]),
      create,
      update: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
    },
    purchaseInvoices: undefined,
  } as any;
  registerWiseImportTools(server, api, createTestRuntimeSafetyContext());
  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "import_wise_transactions");
  const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  return { api, handler };
}

async function call(handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>, args: Record<string, unknown>) {
  return parseMcpResponse((await handler(args)).content[0]!.text) as any;
}

describe("Wise compact profile routing", () => {
  it("standard profile keeps the full envelope (no compact summary)", async () => {
    const { handler } = setup();
    const payload = await call(handler, { file_path: inline(oneRowCsv()), accounts_dimensions_id: 5, execute: false });
    expect(payload.mode).toBe("DRY_RUN");
    expect(payload.execution).toBeDefined();
    expect(payload.results).toBeDefined();
    // Full-envelope summary is a counts object, not the compact operation_summary_v1.
    expect(payload.summary.contract).toBeUndefined();
  });

  it("guided profile returns the compact operation summary with a plan handle on dry run", async () => {
    const { handler } = setup();
    await runWithToolProfile("guided", async () => {
      const payload = await call(handler, { file_path: inline(oneRowCsv()), accounts_dimensions_id: 5, execute: false });
      expect(payload.summary.contract).toBe("operation_summary_v1");
      expect(payload.summary.status).toBe("ready_for_approval");
      expect(typeof payload.summary.plan_handle).toBe("string");
      expect(payload.summary.scope.account).toBe("5");
      expect(payload.summary.counts.would_create).toBe(1);
      // Free-form counterparty is OCR-wrapped in the sample.
      expect(payload.summary.samples[0].counterparty).toMatch(/UNTRUSTED_OCR_START/);
      // No unbounded per-row array leaks into the compact surface.
      expect(payload.results).toBeUndefined();
      expect(payload.execution).toBeUndefined();
    });
  });

  it("guided execute issues an operation-result handle and references get_operation_result_page", async () => {
    const { api, handler } = setup();
    const args = { file_path: inline(oneRowCsv()), accounts_dimensions_id: 5 };
    await runWithToolProfile("guided", async () => {
      const dry = await call(handler, { ...args, execute: false });
      const planHandle = dry.summary.plan_handle as string;
      // The compact dry-run summary deliberately omits the digest; the digest is
      // deterministic across profiles, so recover it from a standard dry run.
      const digest = await runWithToolProfile("standard", async () =>
        (await call(handler, { ...args, execute: false })).approved_command_digest);
      const exec = await call(handler, { ...args, execute: true, plan_handle: planHandle, approved_command_digest: digest });
      expect(exec.summary.contract).toBe("operation_summary_v1");
      expect(exec.summary.status).toBe("completed");
      expect(exec.summary.details.tool).toBe("get_operation_result_page");
      expect(typeof exec.summary.details.args.operation_handle).toBe("string");
      expect(api.transactions.create).toHaveBeenCalledTimes(1);
    });
  });
});
