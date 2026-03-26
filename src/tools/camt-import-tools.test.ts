import { readFile } from "fs/promises";
import { describe, expect, it, vi } from "vitest";
import { validateFilePath } from "../file-validation.js";
import { registerCamtImportTools } from "./camt-import.js";
import { parseMcpResponse } from "../mcp-json.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../file-validation.js", () => ({
  validateFilePath: vi.fn(),
}));

vi.mock("../progress.js", () => ({
  reportProgress: vi.fn().mockResolvedValue(undefined),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedValidateFilePath = vi.mocked(validateFilePath);

const singleEntryXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-1</Id>
      <Acct>
        <Id><IBAN>EE637700771011212909</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="EUR">10.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-01</Dt></BookgDt>
        <AcctSvcrRef>REF-VOID-1</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>REF-VOID-1</AcctSvcrRef>
            </Refs>
            <AmtDtls>
              <TxAmt><Amt Ccy="EUR">10.00</Amt></TxAmt>
            </AmtDtls>
            <RltdPties>
              <Cdtr><Nm>Vendor OÜ</Nm></Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>Test payment</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

function setupCamtTool(existingTransactions: unknown[]) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    readonly: {
      getAccountDimensions: vi.fn().mockResolvedValue([
        { id: 7, accounts_id: 1020, is_deleted: false },
      ]),
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue(existingTransactions),
      create: vi.fn().mockResolvedValue({ created_object_id: 9001 }),
    },
    clients: {
      findByCode: vi.fn().mockResolvedValue(undefined),
      findByName: vi.fn().mockResolvedValue([]),
    },
  } as any;

  registerCamtImportTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "import_camt053");
  if (!registration) throw new Error("Tool was not registered");

  return {
    api,
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("camt import tool", () => {
  it("does not treat VOID transactions as duplicates", async () => {
    mockedValidateFilePath.mockResolvedValue("/tmp/camt.xml");
    mockedReadFile.mockResolvedValue(singleEntryXml);

    const { api, handler } = setupCamtTool([
      {
        id: 12,
        status: "VOID",
        is_deleted: false,
        bank_ref_number: "REF-VOID-1",
        ref_number: null,
        description: "REF-VOID-1 old voided import",
      },
    ]);

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(payload.skipped_count).toBe(0);
    expect(payload.sample).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "created",
        bank_reference: "REF-VOID-1",
      }),
    ]));
    expect(payload.execution).toMatchObject({
      contract: "batch_execution_v1",
      mode: "EXECUTED",
      summary: {
        total_statement_entries: 1,
        eligible_entries: 1,
        filtered_out: 0,
        created_count: 1,
        skipped_count: 0,
        error_count: 0,
      },
      results: expect.arrayContaining([
        expect.objectContaining({
          status: "created",
          bank_reference: "REF-VOID-1",
        }),
      ]),
      skipped: [],
      errors: [],
      needs_review: [],
      audit_reference: expect.objectContaining({
        review_tool: "get_session_log",
        list_tool: "list_audit_logs",
        location: "logs/<company>.audit.md",
      }),
    });
  });
});
