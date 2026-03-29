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

function setupCamtTool(options: {
  existingTransactions?: unknown[];
  findByCodeResult?: unknown;
  findByNameResult?: unknown[];
  findByNameImpl?: (name: string) => unknown[] | Promise<unknown[]>;
} = {}) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    readonly: {
      getAccountDimensions: vi.fn().mockResolvedValue([
        { id: 7, accounts_id: 1020, is_deleted: false },
      ]),
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.existingTransactions ?? []),
      create: vi.fn().mockResolvedValue({ created_object_id: 9001 }),
    },
    clients: {
      findByCode: vi.fn().mockResolvedValue(options.findByCodeResult),
      findByName: options.findByNameImpl
        ? vi.fn().mockImplementation(options.findByNameImpl)
        : vi.fn().mockResolvedValue(options.findByNameResult ?? []),
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

    const { api, handler } = setupCamtTool({
      existingTransactions: [
        {
          id: 12,
          status: "VOID",
          is_deleted: false,
          bank_ref_number: "REF-VOID-1",
          ref_number: null,
          description: "REF-VOID-1 old voided import",
        },
      ],
    });

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
        location: "logs/<company-name>[ (<connection-name>)].audit.md",
        note: "Review mutating side effects in the human-readable audit log named after the company when available; a connection suffix is added only when needed to disambiguate.",
      }),
    });
  });

  it("matches clients by normalized company name when findByName returns multiple variants", async () => {
    mockedValidateFilePath.mockResolvedValue("/tmp/camt.xml");
    mockedReadFile.mockResolvedValue(singleEntryXml.replace("Vendor OÜ", "OpenAI, Inc."));

    const { handler } = setupCamtTool({
      findByNameResult: [
        {
          id: 81,
          name: "OpenAI Inc",
        },
        {
          id: 82,
          name: "OpenAI Operations Ireland Limited",
        },
      ],
    });

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.sample).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "would_create",
        clients_id: 81,
        client_match: "exact_name",
        counterparty: "OpenAI, Inc.",
      }),
    ]));
  });

  it("keeps separate cache entries for different legal-entity variants with the same normalized stem", async () => {
    mockedValidateFilePath.mockResolvedValue("/tmp/camt.xml");
    mockedReadFile.mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-variants</Id>
      <Acct>
        <Id><IBAN>EE637700771011212909</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="EUR">10.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-01</Dt></BookgDt>
        <AcctSvcrRef>REF-1</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs><AcctSvcrRef>REF-1</AcctSvcrRef></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">10.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Acme OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Payment 1</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">20.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-02</Dt></BookgDt>
        <AcctSvcrRef>REF-2</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs><AcctSvcrRef>REF-2</AcctSvcrRef></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">20.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Acme AS</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Payment 2</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`);

    const { api, handler } = setupCamtTool({
      findByNameImpl: (name: string) => {
        if (name === "Acme OÜ") {
          return [{ id: 11, name: "Acme OÜ" }];
        }
        if (name === "Acme AS") {
          return [{ id: 22, name: "Acme AS" }];
        }
        return [];
      },
    });

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(api.clients.findByName).toHaveBeenCalledTimes(2);
    expect(payload.sample).toEqual(expect.arrayContaining([
      expect.objectContaining({
        counterparty: "Acme OÜ",
        clients_id: 11,
      }),
      expect.objectContaining({
        counterparty: "Acme AS",
        clients_id: 22,
      }),
    ]));
  });

  it("does not skip split CAMT rows that only share a statement-level bank reference", async () => {
    mockedValidateFilePath.mockResolvedValue("/tmp/camt.xml");
    mockedReadFile.mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-split</Id>
      <Acct>
        <Id><IBAN>EE637700771011212909</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="EUR">300.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-03</Dt></BookgDt>
        <AcctSvcrRef>REF-SPLIT-1</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <EndToEndId>E2E-1</EndToEndId>
            </Refs>
            <AmtDtls>
              <TxAmt><Amt Ccy="EUR">100.00</Amt></TxAmt>
            </AmtDtls>
            <RltdPties>
              <Cdtr><Nm>Vendor A OÜ</Nm></Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>Split payment A</Ustrd>
            </RmtInf>
          </TxDtls>
          <TxDtls>
            <Refs>
              <EndToEndId>E2E-2</EndToEndId>
            </Refs>
            <AmtDtls>
              <TxAmt><Amt Ccy="EUR">200.00</Amt></TxAmt>
            </AmtDtls>
            <RltdPties>
              <Cdtr><Nm>Vendor B OÜ</Nm></Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>Split payment B</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`);

    const { api, handler } = setupCamtTool();

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(api.transactions.create).not.toHaveBeenCalled();
    expect(payload.created_count).toBe(2);
    expect(payload.skipped_count).toBe(0);
    expect(payload.sample).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "would_create",
        amount: 100,
        bank_reference: "REF-SPLIT-1",
        description: "Split payment A",
      }),
      expect.objectContaining({
        status: "would_create",
        amount: 200,
        bank_reference: "REF-SPLIT-1",
        description: "Split payment B",
      }),
    ]));
  });
});
