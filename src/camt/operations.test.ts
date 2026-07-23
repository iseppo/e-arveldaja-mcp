import { describe, it, expect, vi } from "vitest";
import { createCamtOperations } from "./operations.js";
import { CamtPreflightRejectedError } from "./executor.js";
import {
  createAccountingWorkflowApi,
  fixtureAccountDimension,
  fixtureBankAccount,
  fixtureCamtXml,
} from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";

// The typed CAMT operations are exercised through narrow api/plan ports — NOT a
// mock McpServer. This pins the parse → prepareImport (issue plan) →
// executeImport (consume plan) orchestration and the failure surfaces the tool
// adapter projects into MCP envelopes.

vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const inline = (xml: string): string => `base64:${Buffer.from(xml, "utf8").toString("base64")}`;

function setup(existingTransactions: unknown[] = []) {
  const api = createAccountingWorkflowApi({
    accountDimensions: [fixtureAccountDimension({ id: 7 })],
    bankAccounts: [fixtureBankAccount({ accounts_dimensions_id: 7 })],
    transactionRows: existingTransactions,
  });
  const operations = createCamtOperations(api, createTestRuntimeSafetyContext());
  return { api, operations };
}

describe("CamtOperations", () => {
  it("parse returns the parsed statement without any ledger or configuration read", async () => {
    const { api, operations } = setup();
    const outcome = await operations.parse({ source: { file_path: inline(fixtureCamtXml()) } });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.statement_metadata.iban).toBe("EE637700771011212909");
      expect(outcome.value.entries).toHaveLength(1);
    }
    expect(api.transactions.listAll).not.toHaveBeenCalled();
    expect(api.clients.findByCode).not.toHaveBeenCalled();
    expect(api.readonly.getBankAccounts).not.toHaveBeenCalled();
  });

  it("parse throws CamtPreflightRejectedError with positional row ids on an invalid field", async () => {
    const { operations } = setup();
    const bad = fixtureCamtXml().replace("<Amt Ccy=\"EUR\">10.00</Amt>\n        <CdtDbtInd>DBIT</CdtDbtInd>", "<Amt Ccy=\"EUR\">abc</Amt>\n        <CdtDbtInd>DBIT</CdtDbtInd>");
    await expect(operations.parse({ source: { file_path: inline(bad) } }))
      .rejects.toBeInstanceOf(CamtPreflightRejectedError);
  });

  it("prepareImport projects the import and issues an execution plan handle", async () => {
    const { operations } = setup();
    const outcome = await operations.prepareImport({
      source: { file_path: inline(fixtureCamtXml()) },
      accountsDimensionsId: 7,
      dateFrom: undefined,
      dateTo: undefined,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(typeof outcome.value.planHandle).toBe("string");
      expect(outcome.value.projection.descriptors).toHaveLength(1);
      expect(outcome.value.createdCount).toBe(1);
      expect(outcome.value.errorCount).toBe(0);
    }
  });

  it("executeImport consumes the reviewed plan and creates the transaction", async () => {
    const { api, operations } = setup();
    const source = { file_path: inline(fixtureCamtXml()) };
    const dry = await operations.prepareImport({ source, accountsDimensionsId: 7, dateFrom: undefined, dateTo: undefined });
    expect(dry.ok).toBe(true);
    const planHandle = dry.ok ? dry.value.planHandle : undefined;

    const outcome = await operations.executeImport({ source, accountsDimensionsId: 7, dateFrom: undefined, dateTo: undefined, planHandle });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.createdCount).toBe(1);
    }
    expect(api.transactions.create).toHaveBeenCalledTimes(1);
  });

  it("executeImport refuses without a plan handle (plan-approval separation)", async () => {
    const { api, operations } = setup();
    const outcome = await operations.executeImport({
      source: { file_path: inline(fixtureCamtXml()) },
      accountsDimensionsId: 7,
      dateFrom: undefined,
      dateTo: undefined,
      planHandle: undefined,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("plan_handle_required");
    expect(api.transactions.create).not.toHaveBeenCalled();
  });
});
