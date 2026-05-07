import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import { parseDocument } from "../document-parser.js";
import { registerAccountingInboxTools } from "./accounting-inbox.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import * as auditLogModule from "../audit-log.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));

const mockedParseDocument = vi.mocked(parseDocument);

function setupAccountingInboxTool(apiOverrides: Record<string, unknown> = {}, toolName = "prepare_accounting_inbox") {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    clients: {
      findByCode: vi.fn().mockResolvedValue(undefined),
      findByName: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
    },
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue([]),
    },
    products: {},
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockImplementation(async (id: number) => ({ id, status: "CONFIRMED", is_deleted: false })),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue([]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
      getAccounts: vi.fn().mockResolvedValue([]),
      getPurchaseArticles: vi.fn().mockResolvedValue([]),
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
    },
    ...apiOverrides,
  } as any;

  registerAccountingInboxTools(server, api);
  const registration = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!registration) throw new Error("Tool was not registered");

  return {
    api,
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

async function createWorkspace(options: {
  includeCamt?: boolean;
  includeWise?: boolean;
  includeReceipts?: boolean;
  camtIban?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "accounting-inbox-"));

  if (options.includeCamt !== false) {
    await writeFile(
      join(root, "statement.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct>
        <Id><IBAN>${options.camtIban ?? "EE637700771011212909"}</IBAN></Id>
      </Acct>
    </Stmt>
  </BkToCstmrStmt>
</Document>`,
    );
  }

  if (options.includeWise !== false) {
    const wiseDir = join(root, "wise");
    await mkdir(wiseDir, { recursive: true });
    await writeFile(
      join(wiseDir, "transaction-history.csv"),
      [
        "Source amount (after fees),Target amount (after fees),Exchange rate",
        "10,10,1",
      ].join("\n"),
    );
  }

  if (options.includeReceipts !== false) {
    const receiptsDir = join(root, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    await writeFile(join(receiptsDir, "receipt-1.pdf"), "fake pdf");
    await writeFile(join(receiptsDir, "receipt-2.jpg"), "fake jpg");
  }

  return root;
}

const workspacesToClean: string[] = [];

afterEach(async () => {
  await Promise.all(workspacesToClean.splice(0).map(path => rm(path, { recursive: true, force: true })));
  mockedParseDocument.mockReset();
});

describe("prepare_accounting_inbox", () => {
  it("exposes accounting_inbox scan mode as the merged scan entry point", async () => {
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    const { handler } = setupAccountingInboxTool({
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 101,
            accounts_id: 1020,
            title_est: "LHV põhikonto",
            is_deleted: false,
          },
        ]),
      },
    }, "accounting_inbox");

    const result = await handler({ mode: "scan", workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.detected_inputs.camt_files).toHaveLength(1);
    expect(payload.recommended_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "parse_camt053" }),
      expect.objectContaining({ tool: "import_camt053" }),
    ]));
    expect(payload.workflow.contract).toBe("workflow_action_v1");
    expect(payload.autopilot).toBeUndefined();
  });

  it("exposes accounting_inbox dry_run mode as the merged autopilot entry point", async () => {
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    const { handler } = setupAccountingInboxTool({
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 101,
            accounts_id: 1020,
            title_est: "LHV põhikonto",
            is_deleted: false,
          },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    }, "accounting_inbox");

    const result = await handler({ mode: "dry_run", workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.prepared_inbox.detected_inputs.camt_files).toHaveLength(1);
    expect(payload.autopilot.executed_steps.map((step: any) => step.tool)).toEqual([
      "parse_camt053",
      "import_camt053",
      "classify_unmatched_transactions",
    ]);
    expect(payload.workflow.contract).toBe("workflow_action_v1");
  });

  it("detects likely accounting inputs and suggests the first dry-run flow with defaults", async () => {
    const workspace = await createWorkspace();
    workspacesToClean.push(workspace);

    const { handler } = setupAccountingInboxTool({
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV arvelduskonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
          {
            accounts_dimensions_id: 202,
            account_name_est: "Wise konto",
            account_no: "BE62510007547061",
            iban_code: "BE62510007547061",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 303,
            accounts_id: 8610,
            title_est: "Muud finantskulud",
            is_deleted: false,
          },
        ]),
      },
    });

    const result = await handler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.scan.scanned_candidate_files).toBe(4);
    expect(payload.detected_inputs.camt_files).toHaveLength(1);
    expect(payload.detected_inputs.wise_csv_files).toHaveLength(1);
    expect(payload.detected_inputs.receipt_folders).toHaveLength(1);
    expect(payload.defaults).toMatchObject({
      live_api_defaults_available: true,
      suggested_bank_dimension_id: 101,
      suggested_receipt_matching_dimension_id: 101,
      suggested_wise_account_dimension_id: 202,
      suggested_wise_fee_dimension_id: 303,
    });
    expect(payload.recommended_steps.map((step: any) => step.tool)).toEqual([
      "parse_camt053",
      "import_camt053",
      "import_wise_transactions",
      "process_receipt_batch",
      "classify_unmatched_transactions",
      "reconcile_inter_account_transfers",
    ]);
    expect(payload.recommended_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "classify_unmatched_transactions",
        recommended: true,
      }),
    ]));
    expect(payload.questions).toEqual([]);
    expect(payload.next_question).toBeUndefined();
    expect(payload.next_recommended_action).toEqual(expect.objectContaining({
      tool: "parse_camt053",
    }));
    expect(payload.assistant_guidance).toContain(
      "Ask only the questions listed under questions, and always start with the recommendation.",
    );
  });

  it("uses CAMT statement IBAN to avoid unnecessary bank-dimension questions", async () => {
    const workspace = await createWorkspace({ includeWise: false });
    workspacesToClean.push(workspace);

    const { handler } = setupAccountingInboxTool({
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
          {
            accounts_dimensions_id: 102,
            account_name_est: "SEB põhikonto",
            account_no: "EE381010220123456789",
            iban_code: "EE381010220123456789",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await handler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.defaults.suggested_bank_dimension_id).toBeUndefined();
    expect(payload.defaults.suggested_receipt_matching_dimension_id).toBeUndefined();
    expect(payload.questions.map((question: any) => question.id)).toEqual([
      "receipt_accounts_dimensions_id",
    ]);
    expect(payload.recommended_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "import_camt053",
        recommended: true,
        suggested_args: expect.objectContaining({
          accounts_dimensions_id: 101,
        }),
        missing_inputs: [],
      }),
      expect.objectContaining({
        tool: "process_receipt_batch",
        recommended: false,
        missing_inputs: ["accounts_dimensions_id"],
      }),
    ]));
    expect(payload.next_question).toEqual(expect.objectContaining({
      id: "receipt_accounts_dimensions_id",
    }));
    expect(payload.next_recommended_action).toEqual(expect.objectContaining({
      tool: "parse_camt053",
    }));
    expect(payload.user_summary).toContain("small decision");
  });

  it("still asks for CAMT bank dimension when ambiguous accounts cannot be matched by IBAN", async () => {
    const workspace = await createWorkspace({ includeWise: false, camtIban: "EE001234567890123456" });
    workspacesToClean.push(workspace);

    const { handler } = setupAccountingInboxTool({
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
          {
            accounts_dimensions_id: 102,
            account_name_est: "SEB põhikonto",
            account_no: "EE381010220123456789",
            iban_code: "EE381010220123456789",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await handler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.questions.map((question: any) => question.id)).toEqual([
      "camt_accounts_dimensions_id",
      "receipt_accounts_dimensions_id",
    ]);
    expect(payload.recommended_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "import_camt053",
        recommended: false,
        missing_inputs: ["accounts_dimensions_id"],
      }),
    ]));
  });

  it("does not classify unmatched transactions while a prior CAMT import step is still unresolved", async () => {
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false, camtIban: "EE001234567890123456" });
    workspacesToClean.push(workspace);

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([
          {
            id: 9,
            name: "Seppo Sepp",
            is_physical_entity: true,
            is_related_party: true,
            is_deleted: false,
          },
        ]),
      },
      journals: {
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      products: {},
      saleInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([
          {
            id: 5,
            status: "PROJECT",
            is_deleted: false,
            type: "C",
            amount: 150,
            date: "2026-03-21",
            accounts_dimensions_id: 101,
            bank_account_name: "Seppo Sepp",
            description: "Transfer",
            cl_currencies_id: "EUR",
          },
        ]),
      },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
          {
            accounts_dimensions_id: 102,
            account_name_est: "SEB põhikonto",
            account_no: "EE381010220123456789",
            iban_code: "EE381010220123456789",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Autopilot tool was not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({
      workspace_path: workspace,
      receipt_matching_dimension_id: 101,
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.autopilot.executed_steps.map((step: any) => step.tool)).toEqual([
      "parse_camt053",
      "reconcile_inter_account_transfers",
    ]);
    expect(payload.autopilot.skipped_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "import_camt053",
        summary: expect.stringContaining("accounts_dimensions_id"),
      }),
      expect.objectContaining({
        tool: "classify_unmatched_transactions",
        summary: expect.stringContaining("failed"),
      }),
    ]));
    expect(payload.autopilot.needs_accountant_review).toEqual([]);
    expect(payload.autopilot.needs_one_decision).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "camt_accounts_dimensions_id",
      }),
    ]));
  });

  it("still provides a usable scan plan when live defaults are unavailable in setup mode", async () => {
    const workspace = await createWorkspace({ includeReceipts: false });
    workspacesToClean.push(workspace);

    const setupError = Object.assign(new Error("setup"), { mode: "setup" });
    const { handler } = setupAccountingInboxTool({
      readonly: {
        getBankAccounts: vi.fn().mockRejectedValue(setupError),
        getAccountDimensions: vi.fn().mockRejectedValue(setupError),
      },
    });

    const result = await handler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.detected_inputs.camt_files).toHaveLength(1);
    expect(payload.detected_inputs.wise_csv_files).toHaveLength(1);
    expect(payload.defaults.live_api_defaults_available).toBe(false);
    expect(payload.questions.map((question: any) => question.id)).toEqual([
      "camt_accounts_dimensions_id",
      "wise_accounts_dimensions_id",
    ]);
    expect(payload.next_question).toEqual(expect.objectContaining({
      id: "camt_accounts_dimensions_id",
    }));
    expect(payload.next_recommended_action).toEqual(expect.objectContaining({
      tool: "parse_camt053",
    }));
    expect(payload.assistant_guidance).toContain(
      "Live bank-account defaults were unavailable because credentials are not configured yet. File scanning still works, but bank dimension defaults may need manual confirmation.",
    );
    expect(payload.user_summary).toContain("credentials are not configured yet");
  });

  it("runs the safe automatic dry-run first pass and returns one consolidated preview", async () => {
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
      journals: {
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      products: {},
      saleInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 101,
            accounts_id: 1020,
            title_est: "LHV põhikonto",
            is_deleted: false,
          },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);
    const registration = server.registerTool.mock.calls.find(([name]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Autopilot tool was not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.prepared_inbox.detected_inputs.camt_files).toHaveLength(1);
    expect(payload.autopilot.executed_step_count).toBe(3);
    expect(payload.autopilot.executed_steps.map((step: any) => step.tool)).toEqual([
      "parse_camt053",
      "import_camt053",
      "classify_unmatched_transactions",
    ]);
    expect(payload.autopilot.done_automatically).toEqual(expect.arrayContaining([
      expect.stringContaining("Parsed CAMT preview"),
      expect.stringContaining("CAMT dry run would create"),
      expect.stringContaining("Classified 0 unmatched transaction"),
    ]));
    expect(payload.prepared_inbox.recommended_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "classify_unmatched_transactions",
        recommended: true,
      }),
    ]));
    expect(payload.autopilot.needs_one_decision).toEqual([]);
    expect(payload.autopilot.next_question).toBeUndefined();
    expect(payload.prepared_inbox.next_recommended_action).toBeUndefined();
  });

  it("does not classify unmatched transactions while receipt dry-run invoices are waiting for approval", async () => {
    const workspace = await createWorkspace({ includeCamt: false, includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);
    const receiptsDir = join(workspace, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    await writeFile(join(receiptsDir, "receipt-1.pdf"), "fake pdf");

    mockedParseDocument.mockResolvedValue({
      text: [
        "Invoice",
        "Supplier: Acme Software OÜ",
        "Invoice number: INV-2026-001",
        "Invoice date: 2026-03-10",
        "Total net: 100.00 EUR",
        "VAT 24%: 24.00 EUR",
        "Total: 124.00 EUR",
        "Software subscription",
      ].join("\n"),
      pageCount: 1,
      result: { text: "", pages: [] } as any,
    });

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([
          {
            id: 7,
            name: "Acme Software OÜ",
            is_deleted: false,
            is_supplier: true,
          },
        ]),
      },
      journals: {
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      products: {},
      saleInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 101,
            accounts_id: 1020,
            title_est: "LHV põhikonto",
            is_deleted: false,
          },
        ]),
        getAccounts: vi.fn().mockResolvedValue([
          {
            id: 5230,
            name_est: "Muud tegevuskulud",
            name_eng: "General expense",
            account_type_est: "Kulud",
            account_type_eng: "Expenses",
          },
        ]),
        getPurchaseArticles: vi.fn().mockResolvedValue([
          {
            id: 99,
            name_est: "Muu kulu",
            name_eng: "Other general expense",
            accounts_id: 5230,
            vat_accounts_id: 1510,
            cl_vat_articles_id: 1,
            vat_rate_dropdown: "24",
            is_disabled: false,
            priority: 1,
          },
        ]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Autopilot tool was not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.autopilot.executed_steps.map((step: any) => step.tool)).toEqual([
      "process_receipt_batch",
    ]);
    expect(payload.autopilot.executed_steps[0].summary).toContain("would create 1 invoice");
    expect(payload.autopilot.executed_steps[0].preview).toMatchObject({
      dry_run_preview: 1,
    });
    expect(payload.autopilot.skipped_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "classify_unmatched_transactions",
        summary: expect.stringContaining("pending changes"),
      }),
    ]));
    expect(payload.workflow.recommended_next_action).toMatchObject({
      kind: "approve_tool_call",
      tool: "process_receipt_batch",
      approval_required: true,
    });
  });

  it("keeps each CAMT possible duplicate as a separate review follow-up with its own resolver payload", async () => {
    const workspace = await createWorkspace({ includeCamt: false, includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    await writeFile(
      join(workspace, "statement.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
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
        <AcctSvcrRef>REF-1</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs><AcctSvcrRef>REF-1</AcctSvcrRef></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">10.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Vendor OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Test payment one</Ustrd></RmtInf>
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
            <RltdPties><Cdtr><Nm>Other Vendor OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Test payment two</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`,
      "utf8",
    );

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
      journals: {
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      products: {},
      saleInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([
          {
            id: 77,
            status: "CONFIRMED",
            accounts_dimensions_id: 101,
            date: "2026-02-01",
            type: "C",
            amount: 10,
            cl_currencies_id: "EUR",
            bank_ref_number: null,
            bank_account_name: "Vendor OÜ",
            ref_number: null,
            description: "Test payment one",
            is_deleted: false,
          },
          {
            id: 88,
            status: "PROJECT",
            accounts_dimensions_id: 101,
            date: "2026-02-02",
            type: "C",
            amount: 20,
            cl_currencies_id: "EUR",
            bank_ref_number: null,
            bank_account_name: "Other Vendor OÜ",
            ref_number: null,
            description: "Test payment two",
            is_deleted: false,
          },
        ]),
      },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 101,
            accounts_id: 1020,
            title_est: "LHV põhikonto",
            is_deleted: false,
          },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Autopilot tool was not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.autopilot.skipped_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "classify_unmatched_transactions",
        summary: expect.stringContaining("pending changes"),
      }),
    ]));
    const duplicateFollowUps = payload.autopilot.needs_accountant_review.filter((item: any) => item.source === "import_camt053");
    expect(duplicateFollowUps).toHaveLength(2);
    expect(duplicateFollowUps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resolver_input: expect.objectContaining({
          review_type: "camt_possible_duplicate",
          item: expect.objectContaining({
            date: "2026-02-01",
            amount: 10,
          }),
        }),
      }),
      expect.objectContaining({
        resolver_input: expect.objectContaining({
          review_type: "camt_possible_duplicate",
          item: expect.objectContaining({
            date: "2026-02-02",
            amount: 20,
          }),
        }),
      }),
    ]));
  });

  it("does not truncate CAMT possible duplicate review items when there are more than five", async () => {
    const workspace = await createWorkspace({ includeCamt: false, includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    const entryXml = Array.from({ length: 6 }, (_, index) => {
      const entryNo = index + 1;
      const amount = entryNo * 10;
      const date = `2026-02-0${entryNo}`;
      return `      <Ntry>
        <Amt Ccy="EUR">${amount.toFixed(2)}</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>${date}</Dt></BookgDt>
        <AcctSvcrRef>REF-${entryNo}</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs><AcctSvcrRef>REF-${entryNo}</AcctSvcrRef></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">${amount.toFixed(2)}</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Vendor ${entryNo} OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Test payment ${entryNo}</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>`;
    }).join("\n");

    await writeFile(
      join(workspace, "statement.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-many</Id>
      <Acct>
        <Id><IBAN>EE637700771011212909</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
${entryXml}
    </Stmt>
  </BkToCstmrStmt>
</Document>`,
      "utf8",
    );

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
      journals: {
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      products: {},
      saleInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue(Array.from({ length: 6 }, (_, index) => {
          const entryNo = index + 1;
          return {
            id: 200 + entryNo,
            status: "CONFIRMED",
            accounts_dimensions_id: 101,
            date: `2026-02-0${entryNo}`,
            type: "C",
            amount: entryNo * 10,
            cl_currencies_id: "EUR",
            bank_ref_number: null,
            bank_account_name: `Vendor ${entryNo} OÜ`,
            ref_number: null,
            description: `Test payment ${entryNo}`,
            is_deleted: false,
          };
        })),
      },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 101,
            accounts_id: 1020,
            title_est: "LHV põhikonto",
            is_deleted: false,
          },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Autopilot tool was not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    const duplicateFollowUps = payload.autopilot.needs_accountant_review.filter((item: any) => item.source === "import_camt053");
    expect(duplicateFollowUps).toHaveLength(6);
    expect(payload.autopilot.user_summary).toContain("6 review item(s) remain");
  });

  it("keeps autopilot useful in setup mode by running only the local preview step", async () => {
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    const setupError = Object.assign(new Error("setup"), { mode: "setup" });
    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
      journals: {
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      products: {},
      saleInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getBankAccounts: vi.fn().mockRejectedValue(setupError),
        getAccountDimensions: vi.fn().mockRejectedValue(setupError),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({}),
        getInvoiceInfo: vi.fn().mockResolvedValue({}),
      },
    } as any);
    const registration = server.registerTool.mock.calls.find(([name]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Autopilot tool was not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.autopilot.executed_step_count).toBe(1);
    expect(payload.autopilot.executed_steps[0]).toEqual(expect.objectContaining({
      tool: "parse_camt053",
      status: "completed",
    }));
    expect(payload.autopilot.skipped_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "import_camt053",
        status: "skipped",
      }),
    ]));
    expect(payload.autopilot.needs_one_decision).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "camt_accounts_dimensions_id",
      }),
    ]));
  });

  it("surfaces standards-aware review guidance for unmatched groups that still need judgement", async () => {
    const workspace = await createWorkspace({ includeCamt: false, includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([
          {
            id: 9,
            name: "Seppo Sepp",
            is_physical_entity: true,
            is_related_party: true,
            is_deleted: false,
          },
        ]),
      },
      journals: {
        listAllWithPostings: vi.fn().mockResolvedValue([]),
      },
      products: {},
      saleInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([
          {
            id: 5,
            status: "PROJECT",
            is_deleted: false,
            type: "C",
            amount: 150,
            date: "2026-03-21",
            accounts_dimensions_id: 101,
            bank_account_name: "Seppo Sepp",
            description: "Transfer",
            cl_currencies_id: "EUR",
          },
        ]),
      },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          {
            accounts_dimensions_id: 101,
            account_name_est: "LHV põhikonto",
            account_no: "EE637700771011212909",
            iban_code: "EE637700771011212909",
          },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          {
            id: 101,
            accounts_id: 1020,
            title_est: "LHV põhikonto",
            is_deleted: false,
          },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Autopilot tool was not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.autopilot.needs_accountant_review).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "classify_unmatched_transactions",
        recommendation: expect.stringContaining("ära tee sellest ostuarvet"),
        compliance_basis: expect.arrayContaining([
          expect.stringContaining("RPS § 6–7"),
        ]),
        follow_up_questions: expect.arrayContaining([
          expect.stringContaining("laen"),
        ]),
        resolver_input: expect.objectContaining({
          review_type: "classification_group",
        }),
      }),
    ]));
  });

  it("resolve_accounting_review_item turns one review item into a concrete next-step plan", async () => {
    const { handler } = setupAccountingInboxTool({}, "resolve_accounting_review_item");

    const result = await handler({
      review_item_json: JSON.stringify({
        review_type: "classification_group",
        group: {
          category: "owner_transfers",
          display_counterparty: "Seppo Sepp",
          review_guidance: {
            recommendation: "Soovitus: ära tee sellest ostuarvet.",
            compliance_basis: ["RPS § 6–7"],
            follow_up_questions: ["Kas see on laen või dividend?"],
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      review_type: "classification_group",
      status: "needs_answers",
      recommendation: expect.stringContaining("ära tee sellest ostuarvet"),
      compliance_basis: ["RPS § 6–7"],
      unresolved_questions: ["Kas see on laen või dividend?"],
      suggested_workflow: "classify-unmatched",
    });
    expect(payload.assistant_guidance).toContain(
      "Ask only unresolved_questions, and only if the payload itself does not already answer them.",
    );
  });

  it("resolve_accounting_review_item does not suggest an auto-booking rule for owner expense reimbursement receipts", async () => {
    const { handler } = setupAccountingInboxTool({}, "resolve_accounting_review_item");

    const result = await handler({
      review_item_json: JSON.stringify({
        review_type: "receipt_review",
        item: {
          classification: "owner_paid_expense_reimbursement",
          extracted: {
            supplier_name: "Circle K Eesti AS",
          },
          review_guidance: {
            recommendation: "Soovitus: käsitle seda omaniku poolt tasutud kuluna ja kontrolli sisendkäibemaksu mahaarvatavust.",
            compliance_basis: ["KMS § 30", "RPS § 6–7"],
            follow_up_questions: ["Kas kulu oli 100% ettevõtluseks?"],
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      review_type: "receipt_review",
      suggested_tools: ["create_owner_expense_reimbursement"],
      unresolved_questions: ["Kas kulu oli 100% ettevõtluseks?"],
    });
    expect(payload.suggested_workflow).toBeUndefined();
  });

  it("resolve_accounting_review_item keeps receipt-review workflow names separate from actual tools", async () => {
    const { handler } = setupAccountingInboxTool({}, "resolve_accounting_review_item");

    const result = await handler({
      review_item_json: JSON.stringify({
        review_type: "receipt_review",
        item: {
          classification: "purchase_invoice",
          file: {
            path: "/tmp/receipt.pdf",
          },
          review_guidance: {
            recommendation: "Soovitus: kinnita puudu olevad arveandmed enne automaatset broneerimist.",
            compliance_basis: ["RPS § 6–7"],
            follow_up_questions: [],
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      review_type: "receipt_review",
      suggested_workflow: "book-invoice",
      suggested_tools: ["process_receipt_batch"],
    });
  });

  it("prepare_accounting_review_action proposes a persistent CAMT duplicate cleanup action", async () => {
    const { handler } = setupAccountingInboxTool({}, "prepare_accounting_review_action");

    const result = await handler({
      review_item_json: JSON.stringify({
        review_type: "camt_possible_duplicate",
        item: {
          new_transaction_api_id: 9001,
          existing_transactions: [
            {
              id: 77,
              status: "CONFIRMED",
              suggested_patch_missing_fields: {
                bank_ref_number: "CAMT-REF-1",
                ref_number: "RF123",
              },
            },
          ],
          review_guidance: {
            recommendation: "Keep the confirmed transaction and remove the new duplicate.",
            compliance_basis: ["RPS § 6–7"],
            follow_up_questions: [],
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      status: "ready_for_approval",
      proposed_action: {
        type: "tool_call",
        tool: "cleanup_camt_possible_duplicate",
        args: {
          keep_transaction_id: 77,
          delete_transaction_id: 9001,
          patch_missing_fields: {
            bank_ref_number: "CAMT-REF-1",
            ref_number: "RF123",
          },
        },
        approval_required: true,
      },
    });
  });

  it("prepare_accounting_review_action refuses CAMT duplicate cleanup when multiple confirmed matches exist", async () => {
    const { handler } = setupAccountingInboxTool({}, "prepare_accounting_review_action");

    const result = await handler({
      review_item_json: JSON.stringify({
        review_type: "camt_possible_duplicate",
        item: {
          new_transaction_api_id: 9001,
          existing_transactions: [
            {
              id: 77,
              status: "CONFIRMED",
              suggested_patch_missing_fields: {
                bank_ref_number: "CAMT-REF-1",
              },
            },
            {
              id: 88,
              status: "CONFIRMED",
              suggested_patch_missing_fields: {
                bank_ref_number: "CAMT-REF-1",
              },
            },
          ],
          review_guidance: {
            recommendation: "Keep the authoritative confirmed transaction and remove the duplicate only after that choice is explicit.",
            compliance_basis: ["RPS § 6–7"],
            follow_up_questions: [],
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      status: "needs_answers",
      unresolved_questions: [
        "Which confirmed transaction is the authoritative older row to keep before any duplicate cleanup is executed?",
      ],
    });
    expect(payload.proposed_action).toBeUndefined();
  });

  it("cleanup_camt_possible_duplicate enriches missing metadata before deleting the duplicate row", async () => {
    const { handler, api } = setupAccountingInboxTool({
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockImplementation(async (id: number) => {
          if (id === 77) {
            return {
              id: 77,
              status: "CONFIRMED",
              is_deleted: false,
              bank_ref_number: null,
              ref_number: "",
              bank_account_name: "Curated supplier",
            };
          }
          return {
            id,
            status: "PROJECT",
            is_deleted: false,
          };
        }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({ deleted: true }),
      },
    }, "cleanup_camt_possible_duplicate");

    const result = await handler({
      keep_transaction_id: 77,
      delete_transaction_id: 9001,
      patch_missing_fields: {
        bank_ref_number: "CAMT-REF-1",
        ref_number: "RF123",
        bank_account_name: "Bank text that should not overwrite",
      },
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(api.transactions.update).toHaveBeenCalledWith(77, {
      bank_ref_number: "CAMT-REF-1",
      ref_number: "RF123",
    });
    expect(api.transactions.delete).toHaveBeenCalledWith(9001);
    expect(payload).toMatchObject({
      cleaned: true,
      keep_transaction_id: 77,
      delete_transaction_id: 9001,
      updated_keep_transaction: true,
      applied_patch: {
        bank_ref_number: "CAMT-REF-1",
        ref_number: "RF123",
      },
    });
  });

  it("cleanup_camt_possible_duplicate refuses to delete a row that is no longer PROJECT", async () => {
    const { handler, api } = setupAccountingInboxTool({
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockImplementation(async (id: number) => {
          if (id === 77) {
            return {
              id: 77,
              status: "CONFIRMED",
              is_deleted: false,
            };
          }
          return {
            id,
            status: "CONFIRMED",
            is_deleted: false,
          };
        }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({ deleted: true }),
      },
    }, "cleanup_camt_possible_duplicate");

    await expect(handler({
      keep_transaction_id: 77,
      delete_transaction_id: 9001,
      patch_missing_fields: {
        bank_ref_number: "CAMT-REF-1",
      },
    })).rejects.toThrow(/instead of PROJECT/i);

    expect(api.transactions.delete).not.toHaveBeenCalled();
  });

  it("cleanup_camt_possible_duplicate refuses to keep a row that is no longer CONFIRMED", async () => {
    const { handler, api } = setupAccountingInboxTool({
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockImplementation(async (id: number) => {
          if (id === 77) {
            return {
              id: 77,
              status: "PROJECT",
              is_deleted: false,
            };
          }
          return {
            id,
            status: "PROJECT",
            is_deleted: false,
          };
        }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({ deleted: true }),
      },
    }, "cleanup_camt_possible_duplicate");

    await expect(handler({
      keep_transaction_id: 77,
      delete_transaction_id: 9001,
      patch_missing_fields: {
        bank_ref_number: "CAMT-REF-1",
      },
    })).rejects.toThrow(/instead of CONFIRMED/i);

    expect(api.transactions.update).not.toHaveBeenCalled();
    expect(api.transactions.delete).not.toHaveBeenCalled();
  });

  it("save_auto_booking_rule upserts a local rule into the configured markdown file", async () => {
    const workspace = await createWorkspace({ includeCamt: false, includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);
    const rulesPath = join(workspace, "accounting-rules.md");
    await writeFile(rulesPath, "# Accounting Rules\n\n## Auto Booking\n", "utf8");
    const originalRulesFile = process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_FILE = rulesPath;

    const { handler } = setupAccountingInboxTool({}, "save_auto_booking_rule");
    const result = await handler({
      match: "openai",
      category: "saas_subscriptions",
      purchase_article_id: 501,
      purchase_account_id: 5230,
      liability_account_id: 2315,
      vat_rate_dropdown: "-",
      reversed_vat_id: 1,
      reason: "OpenAI default",
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    const saved = await readFile(rulesPath, "utf8");

    expect(payload).toMatchObject({
      saved: true,
      action: "inserted",
      match: "openai",
      category: "saas_subscriptions",
    });
    expect(saved).toContain("| openai | saas_subscriptions | 501 | 5230 |  | 2315 | - | 1 | OpenAI default |");

    if (originalRulesFile === undefined) {
      delete process.env.EARVELDAJA_RULES_FILE;
    } else {
      process.env.EARVELDAJA_RULES_FILE = originalRulesFile;
    }
  });

  it("save_auto_booking_rule rejects reason-only rules", async () => {
    const { handler } = setupAccountingInboxTool({}, "save_auto_booking_rule");

    await expect(handler({
      match: "openai",
      category: "saas_subscriptions",
      reason: "This alone should not become an auto-booking rule",
    })).rejects.toThrow(/requires at least one concrete booking field/i);
  });

  it("prepare_accounting_review_action can prepare save_auto_booking_rule directly from suggested_booking", async () => {
    const { handler } = setupAccountingInboxTool({}, "prepare_accounting_review_action");

    const result = await handler({
      save_as_rule: true,
      review_item_json: JSON.stringify({
        review_type: "classification_group",
        group: {
          category: "saas_subscriptions",
          display_counterparty: "OpenAI",
          suggested_booking: {
            source: "supplier_history",
            purchase_article_id: 501,
            purchase_account_id: 5230,
            liability_account_id: 2315,
            vat_rate_dropdown: "-",
            reversed_vat_id: 1,
            reason: "Defaulted from the most recent confirmed supplier invoice.",
          },
          review_guidance: {
            recommendation: "Use the established SaaS treatment for this counterparty.",
            compliance_basis: ["RPS § 4"],
            follow_up_questions: [],
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      status: "ready_for_approval",
      proposed_action: {
        type: "rule_save",
        tool: "save_auto_booking_rule",
        args: {
          match: "OpenAI",
          category: "saas_subscriptions",
          purchase_article_id: 501,
          purchase_account_id: 5230,
          liability_account_id: 2315,
          vat_rate_dropdown: "-",
          reversed_vat_id: 1,
          reason: "Defaulted from the most recent confirmed supplier invoice.",
        },
        approval_required: true,
      },
    });
  });

  it("prepare_accounting_review_action does not prefill save_auto_booking_rule from heuristic suggested_booking", async () => {
    const { handler } = setupAccountingInboxTool({}, "prepare_accounting_review_action");

    const result = await handler({
      save_as_rule: true,
      review_item_json: JSON.stringify({
        review_type: "classification_group",
        group: {
          category: "saas_subscriptions",
          display_counterparty: "OpenAI",
          suggested_booking: {
            source: "keyword_match",
            purchase_article_id: 501,
            purchase_account_id: 5230,
            liability_account_id: 2315,
            vat_rate_dropdown: "-",
            reversed_vat_id: 1,
            reason: "Fallback booking suggestion from generic expense keywords.",
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      status: "no_direct_action",
      suggested_tools: ["save_auto_booking_rule"],
    });
    expect(payload.proposed_action).toBeUndefined();
  });

  it("buildClassificationSuggestion keyword_match review-only path preserves VAT hint from metadata-only rule", async () => {
    // Set up a rules file with a metadata-only rule: vat_rate_dropdown + reversed_vat_id
    // but no purchase_article_id / purchase_account_id, so hasConcreteAutoBookingRuleBookingTarget = false.
    // classify_unmatched_transactions should thread the VAT fields into suggested_booking
    // even in review-only mode so reviewers see the reverse-charge hint.
    const workspace = await createWorkspace({ includeCamt: false, includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);
    const rulesPath = join(workspace, "accounting-rules.md");
    await writeFile(
      rulesPath,
      [
        "# Accounting Rules",
        "",
        "## Auto Booking",
        "",
        "| match | category | purchase_article_id | purchase_account_id | purchase_account_dimensions_id | liability_account_id | vat_rate_dropdown | reversed_vat_id | reason |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| eu reverse charge softwareco | saas_subscriptions |  |  |  | 2315 | - | 1 | EU SaaS reverse charge |",
      ].join("\n"),
      "utf8",
    );
    const originalRulesFile = process.env.EARVELDAJA_RULES_FILE;
    process.env.EARVELDAJA_RULES_FILE = rulesPath;

    try {
      const server = { registerTool: vi.fn() } as any;
      // Two transactions with similar amounts to trigger recurring+similar_amounts → saas_subscriptions
      // apply_mode:purchase_invoice, which is the code path that hits the manualReviewReason branch.
      const api = {
        clients: { listAll: vi.fn().mockResolvedValue([]) },
        saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
        purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
        transactions: {
          listAll: vi.fn().mockResolvedValue([
            {
              id: 42,
              status: "PROJECT",
              accounts_dimensions_id: 101,
              date: "2026-03-01",
              type: "C",
              amount: 50,
              cl_currencies_id: "EUR",
              bank_account_name: "EU Reverse Charge Softwareco",
              description: "SaaS invoice",
              is_deleted: false,
            },
            {
              id: 43,
              status: "PROJECT",
              accounts_dimensions_id: 101,
              date: "2026-04-01",
              type: "C",
              amount: 50,
              cl_currencies_id: "EUR",
              bank_account_name: "EU Reverse Charge Softwareco",
              description: "SaaS invoice",
              is_deleted: false,
            },
          ]),
        },
        readonly: {
          getAccounts: vi.fn().mockResolvedValue([]),
          getPurchaseArticles: vi.fn().mockResolvedValue([]),
          getVatInfo: vi.fn().mockResolvedValue({}),
        },
      } as any;

      registerReceiptInboxTools(server, api);
      const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "classify_unmatched_transactions");
      if (!registration) throw new Error("classify_unmatched_transactions not registered");
      const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

      const result = await handler({ accounts_dimensions_id: 101 });
      const payload = parseMcpResponse(result.content[0]!.text) as any;

      const group = payload.groups?.[0];
      expect(group).toBeDefined();
      // source is keyword_match when articles are available, fallback otherwise; either is fine here
      expect(["keyword_match", "fallback"]).toContain(group.suggested_booking.source);
      // VAT hint fields must be present even in review-only mode (threaded from the metadata-only rule)
      expect(group.suggested_booking.vat_rate_dropdown).toBe("-");
      expect(group.suggested_booking.reversed_vat_id).toBe(1);
      expect(group.suggested_booking.liability_account_id).toBe(2315);
    } finally {
      if (originalRulesFile === undefined) {
        delete process.env.EARVELDAJA_RULES_FILE;
      } else {
        process.env.EARVELDAJA_RULES_FILE = originalRulesFile;
      }
    }
  });

  it("extractRuleBookingFields drops malformed type fields and keeps well-typed ones", async () => {
    const { handler } = setupAccountingInboxTool({}, "prepare_accounting_review_action");

    const result = await handler({
      save_as_rule: true,
      review_item_json: JSON.stringify({
        review_type: "classification_group",
        group: {
          category: "saas_subscriptions",
          display_counterparty: "OpenAI",
          suggested_booking: {
            source: "supplier_history",
            purchase_article_id: 501,          // good number
            purchase_account_id: "bad-string", // bad: should be number → dropped
            liability_account_id: 2315,        // good number
            vat_rate_dropdown: "-",            // good string
            reversed_vat_id: 1,               // good number
            reason: 99,                        // bad: should be string → dropped
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;
    const args = payload.proposed_action.args;

    expect(args.purchase_article_id).toBe(501);
    expect(args.liability_account_id).toBe(2315);
    expect(args.vat_rate_dropdown).toBe("-");
    expect(args.reversed_vat_id).toBe(1);
    // malformed fields are silently dropped
    expect(args.purchase_account_id).toBeUndefined();
    expect(args.reason).toBeUndefined();
  });

  it("classify_unmatched_transactions skip reason distinguishes pending_materialization from earlier_step_failed", async () => {
    // Branch 1: import_camt053 ran but has pending changes → "pending changes" wording
    const workspace1 = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace1);

    const server1 = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server1, {
      clients: { findByCode: vi.fn().mockResolvedValue(undefined), findByName: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]) },
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
      products: {},
      saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      transactions: { listAll: vi.fn().mockResolvedValue([]) },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          { accounts_dimensions_id: 101, account_name_est: "LHV", account_no: "EE637700771011212909", iban_code: "EE637700771011212909" },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          { id: 101, accounts_id: 1020, title_est: "LHV", is_deleted: false },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);
    const reg1 = server1.registerTool.mock.calls.find(([name]: [string]) => name === "run_accounting_inbox_dry_runs");
    const handler1 = reg1![2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result1 = await handler1({ workspace_path: workspace1, bank_account_dimension_id: 101 });
    const payload1 = parseMcpResponse(result1.content[0]!.text) as any;
    const classifySkip1 = payload1.autopilot.skipped_steps?.find((s: any) => s.tool === "classify_unmatched_transactions");
    // import_camt053 ran and would create transactions → pending_materialization
    if (classifySkip1) {
      expect(classifySkip1.summary).toContain("pending changes");
      expect(classifySkip1.summary).not.toContain("failed");
    }

    // Branch 2: setup mode → import_camt053 is skipped → classify gets "failed" wording
    const workspace2 = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace2);

    const setupError = Object.assign(new Error("setup"), { mode: "setup" });
    const server2 = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server2, {
      clients: { findByCode: vi.fn().mockResolvedValue(undefined), findByName: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]) },
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
      products: {},
      saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      transactions: { listAll: vi.fn().mockResolvedValue([]) },
      readonly: {
        getBankAccounts: vi.fn().mockRejectedValue(setupError),
        getAccountDimensions: vi.fn().mockRejectedValue(setupError),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({}),
        getInvoiceInfo: vi.fn().mockResolvedValue({}),
      },
    } as any);
    const reg2 = server2.registerTool.mock.calls.find(([name]: [string]) => name === "run_accounting_inbox_dry_runs");
    const handler2 = reg2![2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result2 = await handler2({ workspace_path: workspace2 });
    const payload2 = parseMcpResponse(result2.content[0]!.text) as any;
    const classifySkip2 = payload2.autopilot.skipped_steps?.find((s: any) => s.tool === "classify_unmatched_transactions");
    if (classifySkip2) {
      // import_camt053 was skipped (not runnable in setup mode) → earlier_step_failed wording
      expect(classifySkip2.summary).toContain("failed");
      expect(classifySkip2.summary).not.toContain("pending changes");
    }
  });

  it("CAMT followup summary truncates more than 5 existing IDs with +N more suffix", async () => {
    const workspace = await createWorkspace({ includeCamt: false, includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);

    await writeFile(
      join(workspace, "statement.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-trunc</Id>
      <Acct><Id><IBAN>EE637700771011212909</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Ntry>
        <Amt Ccy="EUR">99.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-03-01</Dt></BookgDt>
        <AcctSvcrRef>REF-TRUNC</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs><AcctSvcrRef>REF-TRUNC</AcctSvcrRef></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">99.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Big Vendor OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Bulk payment</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`,
      "utf8",
    );

    // 8 matching confirmed transactions so existingIds has 8 elements
    const existingTransactions = Array.from({ length: 8 }, (_, i) => ({
      id: 100 + i,
      status: "CONFIRMED",
      accounts_dimensions_id: 101,
      date: "2026-03-01",
      type: "C",
      amount: 99,
      cl_currencies_id: "EUR",
      bank_ref_number: null,
      bank_account_name: "Big Vendor OÜ",
      ref_number: null,
      description: "Bulk payment",
      is_deleted: false,
    }));

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
      products: {},
      saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      transactions: { listAll: vi.fn().mockResolvedValue(existingTransactions) },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          { accounts_dimensions_id: 101, account_name_est: "LHV", account_no: "EE637700771011212909", iban_code: "EE637700771011212909" },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          { id: 101, accounts_id: 1020, title_est: "LHV", is_deleted: false },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Tool not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    const duplicateFollowUps = (payload.autopilot.needs_accountant_review as any[])
      .filter((item: any) => item.source === "import_camt053");
    expect(duplicateFollowUps.length).toBeGreaterThan(0);
    const summary: string = duplicateFollowUps[0].summary;
    // Should show first 5 IDs and "+3 more" for the 8-item list
    expect(summary).toMatch(/\+3 more/);
    // Should not contain all 8 IDs spelled out
    expect(summary).not.toMatch(/100, 101, 102, 103, 104, 105/);
  });

  it("mergeRuleOverrides: explicit rule_override_json match takes precedence over derived counterparty", async () => {
    const { handler } = setupAccountingInboxTool({}, "prepare_accounting_review_action");

    const result = await handler({
      save_as_rule: true,
      rule_override_json: JSON.stringify({ match: "custom-match-stem", purchase_account_id: 5200 }),
      review_item_json: JSON.stringify({
        review_type: "classification_group",
        group: {
          category: "saas_subscriptions",
          display_counterparty: "OpenAI Ireland Ltd",
          suggested_booking: {
            source: "supplier_history",
            purchase_article_id: 501,
            purchase_account_id: 5230,
            reason: "SaaS default.",
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.proposed_action.args.match).toBe("custom-match-stem");
    // explicit purchase_account_id from override wins over suggested_booking value
    expect(payload.proposed_action.args.purchase_account_id).toBe(5200);
    // non-overridden fields from suggested_booking are still present
    expect(payload.proposed_action.args.purchase_article_id).toBe(501);
  });

  it("extractTransactionPatchFields keeps numeric patch field values but drops malformed structured ones", async () => {
    const { handler } = setupAccountingInboxTool({}, "prepare_accounting_review_action");

    const result = await handler({
      review_item_json: JSON.stringify({
        review_type: "camt_possible_duplicate",
        item: {
          new_transaction_api_id: 9001,
          existing_transactions: [
            {
              id: 77,
              status: "CONFIRMED",
              suggested_patch_missing_fields: {
                bank_ref_number: 12345,   // numeric — should be coerced to "12345"
                ref_number: "RF99",       // normal string — should pass through
                description: { nested: true }, // malformed structured value — should be dropped
              },
            },
          ],
          review_guidance: {
            recommendation: "Keep confirmed.",
            compliance_basis: [],
            follow_up_questions: [],
          },
        },
      }),
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.proposed_action.args.patch_missing_fields).toEqual({
      bank_ref_number: "12345",
      ref_number: "RF99",
    });
  });

  it("pickNextAutopilotRecommendedAction never re-recommends a step that already failed", async () => {
    // parse_camt053 fails (bad XML) → its step number goes into executedSteps with status=failed
    // → next_recommended_action must not be parse_camt053
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);
    const { join: pathJoin } = await import("path");
    await writeFile(pathJoin(workspace, "statement.xml"), "NOT VALID XML AT ALL");

    const setupError = Object.assign(new Error("setup"), { mode: "setup" });
    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: {
        findByCode: vi.fn().mockResolvedValue(undefined),
        findByName: vi.fn().mockResolvedValue([]),
        listAll: vi.fn().mockResolvedValue([]),
      },
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
      products: {},
      saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ id: 1, status: "CONFIRMED", is_deleted: false }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      readonly: {
        getBankAccounts: vi.fn().mockRejectedValue(setupError),
        getAccountDimensions: vi.fn().mockRejectedValue(setupError),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({}),
        getInvoiceInfo: vi.fn().mockResolvedValue({}),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Tool not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    const failedStep = payload.autopilot.executed_steps.find((s: any) => s.tool === "parse_camt053");
    expect(failedStep?.status).toBe("failed");

    const nextAction = payload.autopilot.next_recommended_action;
    expect(nextAction?.tool).not.toBe("parse_camt053");
  });

  it("run_accounting_inbox_dry_runs does not recommend classify_unmatched_transactions while materialization is still pending", async () => {
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false });
    workspacesToClean.push(workspace);
    await writeFile(
      join(workspace, "statement.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-pending</Id>
      <Acct><Id><IBAN>EE637700771011212909</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Ntry>
        <Amt Ccy="EUR">42.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-03-01</Dt></BookgDt>
        <AcctSvcrRef>REF-PENDING</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs><AcctSvcrRef>REF-PENDING</AcctSvcrRef></Refs>
            <AmtDtls><TxAmt><Amt Ccy="EUR">42.00</Amt></TxAmt></AmtDtls>
            <RltdPties><Cdtr><Nm>Pending Vendor OÜ</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Pending import</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`,
      "utf8",
    );

    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: { findByCode: vi.fn().mockResolvedValue(undefined), findByName: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]) },
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
      products: {},
      saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      transactions: { listAll: vi.fn().mockResolvedValue([]) },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([
          { accounts_dimensions_id: 101, account_name_est: "LHV", account_no: "EE637700771011212909", iban_code: "EE637700771011212909" },
        ]),
        getAccountDimensions: vi.fn().mockResolvedValue([
          { id: 101, accounts_id: 1020, title_est: "LHV", is_deleted: false },
          { id: 202, accounts_id: 1020, title_est: "Wise", is_deleted: false },
        ]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "run_accounting_inbox_dry_runs");
    if (!registration) throw new Error("Tool not registered");
    const autopilotHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await autopilotHandler({ workspace_path: workspace, bank_account_dimension_id: 101 });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.autopilot.skipped_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "classify_unmatched_transactions",
        summary: expect.stringContaining("pending changes"),
      }),
    ]));
    expect(payload.autopilot.next_recommended_action).toBeUndefined();
    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      summary: expect.stringContaining("Ran"),
      needs_decision: [],
      needs_review: [],
      recommended_next_action: {
        kind: "approve_tool_call",
        tool: "import_camt053",
        approval_required: true,
        args: expect.objectContaining({
          file_path: join(workspace, "statement.xml"),
          accounts_dimensions_id: 101,
          execute: true,
        }),
      },
      approval_previews: [
        expect.objectContaining({
          title: "Approve CAMT transaction import",
          execute_tool: "import_camt053",
          execute_args: expect.objectContaining({ execute: true }),
          accounting_impact: expect.arrayContaining([
            expect.stringContaining("1 bank transaction"),
          ]),
          source_documents: [join(workspace, "statement.xml")],
        }),
      ],
    });
    expect(payload.workflow.available_actions[0]).toEqual(
      expect.objectContaining({
        kind: "approve_tool_call",
        tool: "import_camt053",
      }),
    );
  });

  it("continue_accounting_workflow returns the next user-facing action from a previous inbox response", async () => {
    const server = { registerTool: vi.fn() } as any;
    registerAccountingInboxTools(server, {
      clients: { findByCode: vi.fn().mockResolvedValue(undefined), findByName: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]) },
      journals: { listAllWithPostings: vi.fn().mockResolvedValue([]) },
      products: {},
      saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]) },
      transactions: { listAll: vi.fn().mockResolvedValue([]) },
      readonly: {
        getBankAccounts: vi.fn().mockResolvedValue([]),
        getAccountDimensions: vi.fn().mockResolvedValue([]),
        getAccounts: vi.fn().mockResolvedValue([]),
        getPurchaseArticles: vi.fn().mockResolvedValue([]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
    } as any);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "continue_accounting_workflow");
    if (!registration) throw new Error("continue_accounting_workflow was not registered");
    const continueHandler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

    const result = await continueHandler({
      workflow_state_json: {
        autopilot: {
          user_summary: "Ran one dry run. One approval remains.",
          done_automatically: ["CAMT dry run would create 1 transaction."],
          needs_one_decision: [],
          needs_accountant_review: [],
          executed_steps: [{
            step: 2,
            tool: "import_camt053",
            status: "completed",
            purpose: "Preview CAMT import",
            summary: "CAMT dry run would create 1 transaction, skip 0, raise 0 possible duplicate review item(s), and report 0 error(s).",
            suggested_args: {
              file_path: "/tmp/statement.xml",
              accounts_dimensions_id: 101,
              execute: false,
            },
            preview: {
              created_count: 1,
              skipped_count: 0,
              possible_duplicate_count: 0,
              error_count: 0,
            },
          }],
        },
      },
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      recommended_next_action: {
        kind: "approve_tool_call",
        tool: "import_camt053",
        args: {
          file_path: "/tmp/statement.xml",
          accounts_dimensions_id: 101,
          execute: true,
        },
      },
    });
    expect(payload.message).toContain("Next action");
  });

  it("continue_accounting_workflow can resolve a review item through action mode", async () => {
    const { handler } = setupAccountingInboxTool({}, "continue_accounting_workflow");

    const result = await handler({
      action: "resolve_review",
      review_item_json: {
        review_type: "classification_group",
        group: {
          category: "owner_transfers",
          display_counterparty: "Seppo Sepp",
          review_guidance: {
            recommendation: "Soovitus: ära tee sellest ostuarvet.",
            compliance_basis: ["RPS § 6–7"],
            follow_up_questions: ["Kas see on laen või dividend?"],
          },
        },
      },
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      review_type: "classification_group",
      status: "needs_answers",
      recommendation: expect.stringContaining("ära tee sellest ostuarvet"),
      unresolved_questions: ["Kas see on laen või dividend?"],
      suggested_workflow: "classify-unmatched",
    });
    expect(payload.assistant_guidance).toContain(
      "Ask only unresolved_questions, and only if the payload itself does not already answer them.",
    );
  });

  it("continue_accounting_workflow can prepare a review action through action mode", async () => {
    const { handler } = setupAccountingInboxTool({}, "continue_accounting_workflow");

    const result = await handler({
      action: "prepare_action",
      review_item_json: {
        review_type: "camt_possible_duplicate",
        item: {
          new_transaction_api_id: 9001,
          existing_transactions: [
            {
              id: 77,
              status: "CONFIRMED",
              suggested_patch_missing_fields: {
                bank_ref_number: "CAMT-REF-1",
              },
            },
          ],
          review_guidance: {
            recommendation: "Keep the confirmed transaction and remove the new duplicate.",
            compliance_basis: ["RPS § 6–7"],
            follow_up_questions: [],
          },
        },
      },
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      status: "ready_for_approval",
      proposed_action: {
        type: "tool_call",
        tool: "cleanup_camt_possible_duplicate",
        args: {
          keep_transaction_id: 77,
          delete_transaction_id: 9001,
          patch_missing_fields: {
            bank_ref_number: "CAMT-REF-1",
          },
        },
        approval_required: true,
      },
    });
    expect(payload.assistant_guidance).toContain(
      "If proposed_action is present, ask for explicit approval before executing it.",
    );
  });

  it("cleanup_camt_possible_duplicate surfaces partial state when delete throws", async () => {
    const logAuditSpy = vi.mocked(auditLogModule.logAudit);
    logAuditSpy.mockClear();

    const { handler, api } = setupAccountingInboxTool({
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockImplementation(async (id: number) => {
          if (id === 77) {
            return { id: 77, status: "CONFIRMED", is_deleted: false, bank_ref_number: null };
          }
          return { id, status: "PROJECT", is_deleted: false };
        }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockRejectedValue(new Error("Network timeout deleting 9001")),
      },
    }, "cleanup_camt_possible_duplicate");

    const result = await handler({
      keep_transaction_id: 77,
      delete_transaction_id: 9001,
      patch_missing_fields: { bank_ref_number: "CAMT-REF-99" },
    });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    // patch was applied before delete was attempted
    expect(api.transactions.update).toHaveBeenCalledWith(77, { bank_ref_number: "CAMT-REF-99" });

    // response carries partial state
    expect(payload).toMatchObject({
      cleaned: false,
      updated_keep_transaction: true,
      deleted: false,
      partial: true,
      error: expect.stringContaining("Network timeout"),
    });

    // audit log has UPDATED entry and DELETE_FAILED entry
    const actions = logAuditSpy.mock.calls.map(([entry]) => entry.action);
    expect(actions).toContain("UPDATED");
    expect(actions).toContain("DELETE_FAILED");
  });
});
