import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerProcessBankInputTool } from "./process-bank-input.js";
import {
  createAccountingWorkflowApi,
  fixtureAccountDimension,
  fixtureBankAccount,
  fixtureCamtXml,
} from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { parseMcpResponse } from "../mcp-json.js";

vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const inlineXml = (xml: string) => `base64:${Buffer.from(xml, "utf8").toString("base64")}`;

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function setup(options: {
  bankAccounts?: unknown[];
  accountDimensions?: unknown[];
} = {}) {
  const runtime = createTestRuntimeSafetyContext();
  const api = createAccountingWorkflowApi({
    bankAccounts: options.bankAccounts ?? [fixtureBankAccount({ accounts_dimensions_id: 7 })],
    accountDimensions: options.accountDimensions ?? [fixtureAccountDimension({ id: 7 })],
    transactionRows: [],
  });
  const server = { registerTool: vi.fn() } as any;
  registerProcessBankInputTool(server, api, runtime);
  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_bank_input");
  if (!registration) throw new Error("process_bank_input was not registered");
  const handler = registration[2] as Handler;
  return { runtime, api, handler };
}

const parse = (result: { content: Array<{ text: string }> }) => parseMcpResponse(result.content[0]!.text) as any;

describe("process_bank_input", () => {
  it("prepares a CAMT statement, resolves the unique bank dimension silently, and returns a compact plan handle", async () => {
    const { handler } = setup();
    const result = await handler({ mode: "prepare", file_path: inlineXml(fixtureCamtXml()) });
    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    expect(payload.summary).toBeDefined();
    expect(payload.summary.status).toBe("ready_for_approval");
    expect(typeof payload.summary.plan_handle).toBe("string");
    // No technical dimension id was demanded from the user, and no delegated
    // granular tool name / MCP-response parsing leaks into the output.
    const text = result.content[0]!.text;
    expect(text).not.toContain("import_camt053");
    expect(text).not.toContain("parse_camt053");
    expect(text).not.toContain("import_wise_transactions");
    expect(text).not.toContain("delegated_tool");
  });

  it("runs the two-call prepare -> execute path over the same immutable snapshot", async () => {
    const { handler, api } = setup();
    const source = inlineXml(fixtureCamtXml());
    const dry = parse(await handler({ mode: "prepare", file_path: source }));
    const planHandle = dry.summary.plan_handle as string;
    expect(planHandle).toBeTruthy();
    const executed = parse(await handler({ mode: "execute", file_path: source, plan_handle: planHandle }));
    expect(executed.summary.status).toMatch(/completed|partial/);
    expect(api.transactions.create).toHaveBeenCalled();
  });

  it("accepts a bank_input file_ref and rejects a camt_input ref passed to the façade", async () => {
    const { handler, runtime } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bank-facade-"));
    const xmlPath = join(dir, "statement.xml");
    await writeFile(xmlPath, fixtureCamtXml(), "utf8");

    const bankRef = runtime.fileReferenceStore.issue({ canonicalPath: xmlPath, kind: "file", operation: FILE_REFERENCE_OPERATIONS.bank });
    const ok = await handler({ mode: "prepare", file_ref: bankRef });
    expect(ok.isError).toBeFalsy();
    expect(parse(ok).summary).toBeDefined();

    const camtRef = runtime.fileReferenceStore.issue({ canonicalPath: xmlPath, kind: "file", operation: FILE_REFERENCE_OPERATIONS.camt });
    const rejected = await handler({ mode: "prepare", file_ref: camtRef });
    expect(rejected.isError).toBe(true);
  });

  it("asks a compact, OCR-wrapped question when the bank dimension is ambiguous", async () => {
    const { handler } = setup({
      bankAccounts: [
        fixtureBankAccount({ accounts_dimensions_id: 7, iban_code: "EE111111111111111111", account_no: "EE111111111111111111" }),
        fixtureBankAccount({ accounts_dimensions_id: 8, iban_code: "EE222222222222222222", account_no: "EE222222222222222222" }),
      ],
      accountDimensions: [fixtureAccountDimension({ id: 7 }), fixtureAccountDimension({ id: 8 })],
    });
    const result = await handler({ mode: "prepare", file_path: inlineXml(fixtureCamtXml()) });
    const payload = parse(result);
    expect(payload.status).toBe("needs_input");
    expect(Array.isArray(payload.choices)).toBe(true);
    // F-RESOLVER-FACADE-WRAP: question + choice labels are OCR-sandbox-wrapped.
    expect(payload.question).toContain("UNTRUSTED_OCR_START");
    expect(payload.choices[0].label).toContain("UNTRUSTED_OCR_START");
  });

  it("rejects an unsupported input without mutation or raw-byte echo", async () => {
    const { handler, api } = setup();
    const result = await handler({ mode: "prepare", file_path: `base64:csv:${Buffer.from("not,a,bank\nfile,x,y\n", "utf8").toString("base64")}` });
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.category).toBe("bank_input_unsupported");
    expect(api.transactions.create).not.toHaveBeenCalled();
    expect(result.content[0]!.text).not.toContain("not,a,bank");
  });
});
