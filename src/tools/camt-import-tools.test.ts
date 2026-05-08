import { readFile } from "fs/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { registerCamtImportTools } from "./camt-import.js";
import { parseMcpResponse } from "../mcp-json.js";

// CAMT free-form text is wrapped with a per-call OCR-sandbox nonce when
// returned to MCP. These helpers check the plain value inside the wrap.
const wrapped = (text: string): RegExp =>
  new RegExp(`^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\\n${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n<<UNTRUSTED_OCR_END:[0-9a-f]+>>$`);

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../file-validation.js", () => ({
  resolveFileInput: vi.fn(),
}));

vi.mock("../progress.js", () => ({
  reportProgress: vi.fn().mockResolvedValue(undefined),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedResolveFileInput = vi.mocked(resolveFileInput);

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
  toolName?: string;
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

  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === (options.toolName ?? "import_camt053"));
  if (!registration) throw new Error("Tool was not registered");

  return {
    api,
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("camt import tool", () => {
  describe("process_camt053 wrapper", () => {
    it("runs CAMT parsing through the merged entry point", async () => {
      mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
      mockedReadFile.mockResolvedValue(singleEntryXml);

      const { handler } = setupCamtTool({ toolName: "process_camt053" });

      const result = await handler({ mode: "parse", file_path: "/tmp/camt.xml" });
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload).toMatchObject({
        recommended_entry_point: "process_camt053",
        mode: "parse",
        delegated_tool: "parse_camt053",
        delegated_args: {
          file_path: "/tmp/camt.xml",
        },
      });
      expect(payload.result.summary.entry_count).toBe(1);
      expect(payload.result.entries[0]!.description).toEqual(expect.stringMatching(wrapped("Test payment")));
    });

    it("dry-runs CAMT import through the merged entry point", async () => {
      mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
      mockedReadFile.mockResolvedValue(singleEntryXml);

      const { api, handler } = setupCamtTool({ toolName: "process_camt053" });

      const result = await handler({
        mode: "dry_run",
        file_path: "/tmp/camt.xml",
        accounts_dimensions_id: 7,
        date_from: "2026-02-01",
        date_to: "2026-02-28",
      });
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload).toMatchObject({
        recommended_entry_point: "process_camt053",
        mode: "dry_run",
        delegated_tool: "import_camt053",
        delegated_args: {
          file_path: "/tmp/camt.xml",
          accounts_dimensions_id: 7,
          date_from: "2026-02-01",
          date_to: "2026-02-28",
          execute: false,
        },
      });
      expect(api.transactions.create).not.toHaveBeenCalled();
      expect(payload.result.mode).toBe("DRY_RUN");
      expect(payload.result.sample[0]!.status).toBe("would_create");
      expect(payload.result.workflow.recommended_next_action).toMatchObject({
        kind: "approve_tool_call",
        tool: "process_camt053",
        args: {
          mode: "execute",
          file_path: "/tmp/camt.xml",
          accounts_dimensions_id: 7,
          date_from: "2026-02-01",
          date_to: "2026-02-28",
        },
      });
      expect(payload.result.workflow.approval_previews[0]).toMatchObject({
        source_tool: "process_camt053",
        execute_tool: "process_camt053",
        execute_args: {
          mode: "execute",
          file_path: "/tmp/camt.xml",
          accounts_dimensions_id: 7,
          date_from: "2026-02-01",
          date_to: "2026-02-28",
        },
      });
    });

    it("executes CAMT import only in execute mode", async () => {
      mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
      mockedReadFile.mockResolvedValue(singleEntryXml);

      const { api, handler } = setupCamtTool({ toolName: "process_camt053" });

      const result = await handler({
        mode: "execute",
        file_path: "/tmp/camt.xml",
        accounts_dimensions_id: 7,
      });
      const payload = parseMcpResponse(result.content[0]!.text);

      expect(payload).toMatchObject({
        recommended_entry_point: "process_camt053",
        mode: "execute",
        delegated_tool: "import_camt053",
        delegated_args: {
          file_path: "/tmp/camt.xml",
          accounts_dimensions_id: 7,
          execute: true,
        },
      });
      expect(api.transactions.create).toHaveBeenCalledTimes(1);
      expect(payload.result.mode).toBe("EXECUTED");
      expect(payload.result.sample[0]!.status).toBe("created");
    });
  });

  it("does not treat VOID transactions as duplicates", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
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
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
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
        counterparty: expect.stringMatching(wrapped("OpenAI, Inc.")),
      }),
    ]));
    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      recommended_next_action: {
        kind: "approve_tool_call",
        tool: "import_camt053",
        args: {
          file_path: "/tmp/camt.xml",
          accounts_dimensions_id: 7,
          execute: true,
        },
      },
      approval_previews: [
        expect.objectContaining({
          title: "Approve CAMT transaction import",
          accounting_impact: expect.arrayContaining(["1 bank transaction"]),
          source_documents: ["/tmp/camt.xml"],
        }),
      ],
    });
  });

  it("flags likely duplicates against older manual transactions in dry run", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
    mockedReadFile.mockResolvedValue(singleEntryXml);

    const { handler } = setupCamtTool({
      existingTransactions: [
        {
          id: 77,
          status: "CONFIRMED",
          accounts_dimensions_id: 7,
          date: "2026-02-01",
          type: "C",
          amount: 10,
          cl_currencies_id: "EUR",
          bank_ref_number: null,
          bank_account_name: "Vendor OÜ",
          ref_number: null,
          description: "Test payment",
        },
      ],
    });

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary.possible_duplicate_count).toBe(1);
    expect(payload.execution.needs_review).toEqual([
      expect.objectContaining({
        date: "2026-02-01",
        amount: 10,
        recommended_default_action: "link_confirmed_transaction_then_delete_new_project_transaction",
        existing_transactions: [
          expect.objectContaining({
            id: 77,
            status: "CONFIRMED",
            match_reasons: expect.arrayContaining(["counterparty_name", "description"]),
            suggested_patch_missing_fields: expect.objectContaining({
              bank_ref_number: "REF-VOID-1",
            }),
          }),
        ],
      }),
    ]);
    expect(payload.possible_duplicate_summary).toEqual(expect.objectContaining({
      count: 1,
      default_policy: "link_confirmed_transaction_else_review_status",
    }));
  });

  it("keeps likely duplicates in needs_review after execute and includes the new transaction id", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
    mockedReadFile.mockResolvedValue(singleEntryXml);

    const { handler } = setupCamtTool({
      existingTransactions: [
        {
          id: 77,
          status: "CONFIRMED",
          accounts_dimensions_id: 7,
          date: "2026-02-01",
          type: "C",
          amount: 10,
          cl_currencies_id: "EUR",
          bank_ref_number: null,
          bank_account_name: "Vendor OÜ",
          ref_number: null,
          description: "Test payment",
        },
      ],
    });

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.execution.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "created",
        api_id: 9001,
      }),
    ]));
    expect(payload.execution.needs_review).toEqual([
      expect.objectContaining({
        new_transaction_api_id: 9001,
        recommended_default_action: "link_confirmed_transaction_then_delete_new_project_transaction",
        existing_transactions: [
          expect.objectContaining({ id: 77 }),
        ],
      }),
    ]);
  });

  it("requires status review when the older likely duplicate is still a PROJECT row", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
    mockedReadFile.mockResolvedValue(singleEntryXml);

    const { handler } = setupCamtTool({
      existingTransactions: [
        {
          id: 88,
          status: "PROJECT",
          accounts_dimensions_id: 7,
          date: "2026-02-01",
          type: "C",
          amount: 10,
          cl_currencies_id: "EUR",
          bank_ref_number: null,
          bank_account_name: "Vendor OÜ",
          ref_number: null,
          description: "Test payment",
        },
      ],
    });

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.execution.needs_review).toEqual([
      expect.objectContaining({
        recommended_default_action: "review_status_before_cleanup",
        recommendation_note: expect.stringContaining("older match is not confirmed"),
        existing_transactions: [
          expect.objectContaining({
            id: 88,
            status: "PROJECT",
          }),
        ],
      }),
    ]);
  });

  it("keeps separate cache entries for different legal-entity variants with the same normalized stem", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
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
        counterparty: expect.stringMatching(wrapped("Acme OÜ")),
        clients_id: 11,
      }),
      expect.objectContaining({
        counterparty: expect.stringMatching(wrapped("Acme AS")),
        clients_id: 22,
      }),
    ]));
  });

  it("does not skip split CAMT rows that only share a statement-level bank reference", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
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
        description: expect.stringMatching(wrapped("Split payment A")),
      }),
      expect.objectContaining({
        status: "would_create",
        amount: 200,
        bank_reference: "REF-SPLIT-1",
        description: expect.stringMatching(wrapped("Split payment B")),
      }),
    ]));
  });

  it("only skips the already imported split row when a prior import used the same shared bank reference", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
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

    const { handler } = setupCamtTool({
      existingTransactions: [
        {
          id: 501,
          status: "PROJECT",
          is_deleted: false,
          bank_ref_number: "REF-SPLIT-1",
          date: "2026-02-03",
          type: "C",
          amount: 100,
          cl_currencies_id: "EUR",
          ref_number: "E2E-1",
          bank_account_name: "Vendor A OÜ",
          description: "Split payment A",
        },
      ],
    });

    const result = await handler({
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: 7,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.created_count).toBe(1);
    expect(payload.skipped_count).toBe(1);
    expect(payload.sample).toEqual([
      expect.objectContaining({
        status: "would_create",
        amount: 200,
        bank_reference: "REF-SPLIT-1",
        description: expect.stringMatching(wrapped("Split payment B")),
      }),
    ]);
    expect(payload.execution.skipped).toEqual([
      expect.objectContaining({
        amount: 100,
        bank_reference: "REF-SPLIT-1",
        duplicate_transaction_ids: [501],
        reason: "Existing transaction matched by bank reference",
      }),
    ]);
  });

  it("skips exact duplicate rows within the same file even when AcctSvcrRef is missing", async () => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
    mockedReadFile.mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-no-ref-dupe</Id>
      <Acct>
        <Id><IBAN>EE637700771011212909</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="EUR">50.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-04</Dt></BookgDt>
        <NtryDtls>
          <TxDtls>
            <Refs><EndToEndId>E2E-1</EndToEndId></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">50.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Vendor OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Repeated row</Ustrd></RmtInf>
          </TxDtls>
          <TxDtls>
            <Refs><EndToEndId>E2E-1</EndToEndId></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">50.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Vendor OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Repeated row</Ustrd></RmtInf>
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
    expect(payload.created_count).toBe(1);
    expect(payload.skipped_count).toBe(1);
    expect(payload.sample).toEqual([
      expect.objectContaining({
        status: "would_create",
        amount: 25,
        counterparty: expect.stringMatching(wrapped("Vendor OÜ")),
        ref_number: "E2E-1",
        description: expect.stringMatching(wrapped("Repeated row")),
      }),
    ]);
    expect(payload.execution.skipped).toEqual([
      expect.objectContaining({
        amount: 25,
        reason: "Duplicate CAMT entry inside current import batch",
      }),
    ]);
  });
});
