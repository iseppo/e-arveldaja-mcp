import { describe, expect, it, vi } from "vitest";
import { toMcpJson } from "../mcp-json.js";
import {
  runAccountingInboxDryRunPipeline,
  type AutopilotInternalToolHandler,
  type AutopilotPreparedInboxData,
} from "./accounting-inbox-autopilot-service.js";

function preparedInbox(overrides: Partial<AutopilotPreparedInboxData> = {}): AutopilotPreparedInboxData {
  return {
    workspacePath: "/tmp/accounting-inbox",
    scan: {
      max_depth: 2,
      scanned_directories: 1,
      scanned_candidate_files: 1,
      truncated: false,
    },
    camtFiles: [],
    wiseFiles: [],
    receiptFolders: [],
    defaults: {},
    steps: [],
    questions: [],
    liveApiDefaultsAvailable: true,
    ...overrides,
  };
}

describe("runAccountingInboxDryRunPipeline", () => {
  it("keeps receipt pending-approval blocking testable without MCP tool registration", async () => {
    const processReceiptBatch = vi.fn<AutopilotInternalToolHandler>().mockResolvedValue({
      content: [{
        text: toMcpJson({
          execution: {
            summary: {
              created: 0,
              dry_run_preview: 1,
              matched: 0,
              skipped_duplicate: 0,
              needs_review: 0,
              failed: 0,
            },
            needs_review: [],
          },
        }),
      }],
    });
    const classifyUnmatched = vi.fn<AutopilotInternalToolHandler>();

    const result = await runAccountingInboxDryRunPipeline({
      prepared: preparedInbox({
        steps: [
          {
            step: 1,
            tool: "process_receipt_batch",
            purpose: "Preview receipts",
            recommended: true,
            suggested_args: { folder_path: "/tmp/accounting-inbox/receipts", execute: false },
            missing_inputs: [],
            reason: "Receipts found",
          },
          {
            step: 2,
            tool: "classify_unmatched_transactions",
            purpose: "Classify unmatched transactions",
            recommended: true,
            suggested_args: { execute: false },
            missing_inputs: [],
            reason: "Classify after imports",
          },
        ],
      }),
      handlers: new Map([
        ["process_receipt_batch", processReceiptBatch],
        ["classify_unmatched_transactions", classifyUnmatched],
      ]),
    });

    expect(processReceiptBatch).toHaveBeenCalledOnce();
    expect(classifyUnmatched).not.toHaveBeenCalled();
    expect(result.executed_steps).toEqual([
      expect.objectContaining({
        tool: "process_receipt_batch",
        status: "completed",
        preview: expect.objectContaining({ dry_run_preview: 1 }),
      }),
    ]);
    expect(result.skipped_steps).toEqual([
      expect.objectContaining({
        tool: "classify_unmatched_transactions",
        status: "skipped",
        summary: expect.stringContaining("pending changes"),
      }),
    ]);
    expect(result.next_recommended_action).toBeUndefined();
  });

  it("skips CAMT import dry run when the matching CAMT parse failed", async () => {
    const parseCamt = vi.fn<AutopilotInternalToolHandler>().mockRejectedValue(
      new Error("Invalid CAMT XML"),
    );
    const importCamt = vi.fn<AutopilotInternalToolHandler>();

    const result = await runAccountingInboxDryRunPipeline({
      prepared: preparedInbox({
        steps: [
          {
            step: 1,
            tool: "parse_camt053",
            purpose: "Preview CAMT",
            recommended: true,
            suggested_args: { file_path: "/tmp/accounting-inbox/bank.xml" },
            missing_inputs: [],
            reason: "CAMT file found",
          },
          {
            step: 2,
            tool: "import_camt053",
            purpose: "Dry-run CAMT import",
            recommended: true,
            suggested_args: {
              file_path: "/tmp/accounting-inbox/bank.xml",
              accounts_dimensions_id: 123,
              execute: false,
            },
            missing_inputs: [],
            reason: "Dry-run after parse",
          },
        ],
      }),
      handlers: new Map([
        ["parse_camt053", parseCamt],
        ["import_camt053", importCamt],
      ]),
    });

    expect(parseCamt).toHaveBeenCalledOnce();
    expect(importCamt).not.toHaveBeenCalled();
    expect(result.executed_steps).toEqual([
      expect.objectContaining({
        tool: "parse_camt053",
        status: "failed",
        summary: "Invalid CAMT XML",
      }),
    ]);
    expect(result.skipped_steps).toEqual([
      expect.objectContaining({
        tool: "import_camt053",
        status: "skipped",
        summary: expect.stringContaining("prerequisite parse_camt053 failed"),
      }),
    ]);
    expect(result.next_recommended_action).toBeUndefined();
  });
});
