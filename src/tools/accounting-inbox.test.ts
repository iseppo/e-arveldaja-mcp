import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import { registerAccountingInboxTools } from "./accounting-inbox.js";

function setupAccountingInboxTool(apiOverrides: Record<string, unknown> = {}) {
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
  const registration = server.registerTool.mock.calls.find(([name]) => name === "prepare_accounting_inbox");
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
});

describe("prepare_accounting_inbox", () => {
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
    expect(payload.autopilot.needs_one_decision).toEqual([]);
    expect(payload.autopilot.next_question).toBeUndefined();
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
    const workspace = await createWorkspace({ includeWise: false, includeReceipts: false });
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
      }),
    ]));
  });
});
