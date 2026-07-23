import { Buffer } from "node:buffer";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { buildResponseFixtures, type ResponseFixtureName } from "../scripts/measure-response-fixtures.js";
import { captureToolSurface, TOOL_SURFACE_SETUP_INFO } from "./__fixtures__/tool-surface.js";
import { toMcpJson } from "./mcp-json.js";
import { buildSetupInstructionsPayload } from "./server-bootstrap.js";

type Approval = "obtained" | "not-required";
const PLAN_HANDLE = "h".repeat(43);

interface JourneyStep {
  tool: string;
  request: Record<string, unknown>;
  responseFixture?: ResponseFixtureName;
  response?: Record<string, unknown>;
  technicalIdPrompts?: number;
  ambiguityQuestions?: number;
  mutation?: boolean;
  approval: Approval;
}

interface JourneyDefinition {
  name: string;
  steps: JourneyStep[];
}

function representativeResponse(tool: string, request: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "get_setup_instructions":
      return buildSetupInstructionsPayload(TOOL_SURFACE_SETUP_INFO, true);
    case "import_apikey_credentials":
      return request.execute === true
        ? {
            message: "Verified credentials for Fixture Company OÜ. Stored them as the default connection in /normalized/workspace/.env. The configuration will be available only when you start the MCP server from this folder. Restart the MCP server to use them.",
            action: "created",
            company_name: "Fixture Company OÜ",
            env_file: "/normalized/workspace/.env",
            storage_scope: request.storage_scope,
            source_file: request.file_path,
            target: "primary",
            verified_at: "<TIMESTAMP>",
            restart_required: true,
          }
        : {
            mode: "PREVIEW",
            execute: false,
            plan_handle: "<HANDLE>",
            action: "created",
            company_name: "Fixture Company OÜ",
            env_file: "/normalized/workspace/.env",
            storage_scope: request.storage_scope,
            source_file: request.file_path,
            target: "primary",
            masked_api_key_id: "fixt...-id",
            verified_at: "<TIMESTAMP>",
            overwrite: false,
            restart_required: false,
            message: "Verified credentials for Fixture Company OÜ. Would store them as the default connection in /normalized/workspace/.env. The configuration will be available only when you start the MCP server from this folder. Nothing has been written yet.",
            next_step: "Review this projection, then call import_apikey_credentials again with execute=true and this plan_handle to persist.",
            suggested_execute_args: {
              file_path: request.file_path,
              storage_scope: request.storage_scope,
              overwrite: false,
              execute: true,
              plan_handle: "<HANDLE>",
            },
          };
    case "get_vat_info":
      return { standard_rate: 24, reduced_rates: [13, 9], effective_date: "2025-07-01", source: "configured company rules" };
    case "extract_pdf_invoice":
      return { supplier: { name: "Fixture Supplier OÜ", reg_code: "12345678" }, invoice_number: "INV-2026-001", invoice_date: "2026-06-15", total_net: 100, total_vat: 24, total_gross: 124, source_sha256: "0".repeat(64), warnings: [] };
    case "validate_invoice_data":
      return { valid: true, checks: { totals_match: true, date_valid: true, vat_rate_consistent: true }, warnings: [] };
    case "resolve_supplier":
      return { matched: true, client_id: 42, name: "Fixture Supplier OÜ", reg_code: "12345678", match_basis: "registry_code" };
    case "detect_duplicate_purchase_invoice":
      return { duplicate: false, checked_fields: ["invoice_number", "gross_price", "clients_id"], candidate_ids: [] };
    case "suggest_booking":
      return { suggestions: [{ account_id: 5000, title: "Purchased services", confidence: 0.92 }], needs_confirmation: true };
    case "list_account_dimensions":
      return { dimensions: [{ id: 101, account_code: "5000", account_name: "Purchased services", active: true }], total: 1 };
    case "create_purchase_invoice_from_pdf":
      return { created: true, purchase_invoice_id: 90_001, confirmed: false, source_sha256: request.source_sha256 };
    case "confirm_purchase_invoice":
      return { confirmed: true, purchase_invoice_id: request.id, journal_entry_id: 70_001 };
    case "reconcile_bank_transactions":
      return { mode: request.mode, transaction_count: 30, exact_matches: 18, suggested_matches: 9, unmatched: 3, suggestions: [{ transaction_id: 1, document_id: 101, confidence: 0.97 }] };
    case "month_end_close_checklist":
      return { month: request.month, status: "open", checks: [{ name: "bank_reconciliation", status: "needs-review" }, { name: "unconfirmed_documents", status: "clear" }] };
    case "compute_payables_aging":
      return { as_of_date: request.as_of_date, currency: "EUR", buckets: { current: 1200, days_1_30: 300, days_31_60: 0, days_61_plus: 50 }, total: 1550 };
    case "compute_receivables_aging":
      return { as_of_date: request.as_of_date, currency: "EUR", buckets: { current: 2200, days_1_30: 450, days_31_60: 100, days_61_plus: 0 }, total: 2750 };
    case "compute_profit_and_loss":
      return { date_from: request.date_from, date_to: request.date_to, currency: "EUR", revenue: 10_000, expenses: 6_500, operating_profit: 3_500 };
    case "compute_balance_sheet":
      return { date_to: request.date_to, currency: "EUR", assets: 25_000, liabilities: 8_000, equity: 17_000, balanced: true };
    case "get_session_log":
      return { date_from: request.date_from, date_to: request.date_to, entries: [{ timestamp: "2026-06-30T12:00:00Z", operation: "month_end_close_checklist", outcome: "success" }], total: 1 };
    default:
      throw new Error(`No representative response defined for ${tool}`);
  }
}

const approvedMutation = (tool: string, request: Record<string, unknown>, responseFixture?: ResponseFixtureName): JourneyStep => ({
  tool,
  request,
  responseFixture,
  response: responseFixture ? undefined : representativeResponse(tool, request),
  mutation: true,
  approval: "obtained",
});

const read = (tool: string, request: Record<string, unknown>, options: Partial<JourneyStep> = {}): JourneyStep => ({
  tool,
  request,
  response: options.responseFixture ? undefined : representativeResponse(tool, request),
  mutation: false,
  approval: "not-required",
  ...options,
});

const JOURNEYS: JourneyDefinition[] = [
  {
    name: "setup",
    steps: [
      read("get_setup_instructions", {}),
      read("import_apikey_credentials", { file_path: "<ABSOLUTE_PATH>", storage_scope: "local", execute: false }),
      approvedMutation("import_apikey_credentials", { file_path: "<ABSOLUTE_PATH>", storage_scope: "local", execute: true, plan_handle: PLAN_HANDLE }),
    ],
  },
  {
    name: "purchase-invoice",
    steps: [
      read("get_vat_info", {}),
      read("extract_pdf_invoice", { file_path: "<ABSOLUTE_PATH>" }),
      read("validate_invoice_data", {
        total_net: 100,
        total_vat: 24,
        total_gross: 124,
        invoice_date: "2026-06-15",
        items: [{ total_net_price: 100, vat_rate_dropdown: 24 }],
      }),
      read("resolve_supplier", { name: "Fixture Supplier OÜ", reg_code: "12345678", auto_create: false }),
      read("detect_duplicate_purchase_invoice", { invoice_number: "INV-2026-001", gross_price: 124, clients_id: 42 }),
      read("suggest_booking", { clients_id: 42, description: "Consulting service" }, { ambiguityQuestions: 1 }),
      read("list_account_dimensions", {}, { technicalIdPrompts: 1 }),
      approvedMutation("create_purchase_invoice_from_pdf", {
        supplier_client_id: 42,
        invoice_number: "INV-2026-001",
        invoice_date: "2026-06-15",
        journal_date: "2026-06-15",
        term_days: 14,
        items: [{ custom_title: "Consulting service", cl_purchase_articles_id: 1, purchase_accounts_id: 5000, total_net_price: 100 }],
        vat_price: 24,
        gross_price: 124,
        source_sha256: "0".repeat(64),
        file_path: "<ABSOLUTE_PATH>",
      }),
      approvedMutation("confirm_purchase_invoice", { id: 90_001 }),
    ],
  },
  {
    name: "camt",
    steps: [
      read("process_camt053", { mode: "dry_run", file_path: "<ABSOLUTE_PATH>", accounts_dimensions_id: 101 }, {
        responseFixture: "camt-100",
        technicalIdPrompts: 1,
        ambiguityQuestions: 1,
      }),
      read("get_execution_plan_page", { plan_handle: PLAN_HANDLE }, { responseFixture: "plan-page-first" }),
      approvedMutation("process_camt053", { mode: "execute", file_path: "<ABSOLUTE_PATH>", accounts_dimensions_id: 101, plan_handle: PLAN_HANDLE }, "generic-batch-100"),
    ],
  },
  {
    name: "wise",
    steps: [
      read("import_wise_transactions", { file_path: "<ABSOLUTE_PATH>", accounts_dimensions_id: 202, fee_account_dimensions_id: 303 }, {
        responseFixture: "generic-batch-100",
        technicalIdPrompts: 2,
        ambiguityQuestions: 1,
      }),
      read("get_execution_plan_page", { plan_handle: PLAN_HANDLE }, { responseFixture: "plan-page-first" }),
      approvedMutation("import_wise_transactions", {
        file_path: "<ABSOLUTE_PATH>",
        accounts_dimensions_id: 202,
        fee_account_dimensions_id: 303,
        execute: true,
        plan_handle: PLAN_HANDLE,
        approved_command_digest: "0".repeat(64),
      }, "generic-batch-100"),
    ],
  },
  {
    // Guided unified bank façade: prepare -> execute two-call over the same
    // immutable snapshot, with the bank dimension resolved automatically (no
    // technical id demanded on the unique path).
    name: "bank-input",
    steps: [
      read("process_bank_input", { mode: "prepare", file_path: "<ABSOLUTE_PATH>" }, {
        responseFixture: "camt-100",
        technicalIdPrompts: 0,
        ambiguityQuestions: 0,
      }),
      read("get_execution_plan_page", { plan_handle: PLAN_HANDLE }, { responseFixture: "plan-page-first" }),
      approvedMutation("process_bank_input", { mode: "execute", file_path: "<ABSOLUTE_PATH>", plan_handle: PLAN_HANDLE }, "generic-batch-100"),
    ],
  },
  {
    name: "receipt-batch",
    steps: [
      read("receipt_batch", { mode: "scan", folder_path: "<ABSOLUTE_PATH>" }, { responseFixture: "receipts-100" }),
      read("receipt_batch", { mode: "dry_run", folder_path: "<ABSOLUTE_PATH>", accounts_dimensions_id: 101 }, {
        responseFixture: "generic-batch-100",
        technicalIdPrompts: 1,
        ambiguityQuestions: 1,
      }),
      approvedMutation("receipt_batch", {
        mode: "create_and_confirm",
        folder_path: "<ABSOLUTE_PATH>",
        accounts_dimensions_id: 101,
        approved_manifest: [{ relative_path: "receipt-0001.pdf", sha256: "0".repeat(64) }],
      }, "generic-batch-100"),
    ],
  },
  {
    name: "reconciliation",
    steps: [
      read("reconcile_bank_transactions", { mode: "suggest" }, { ambiguityQuestions: 1 }),
      read("reconcile_bank_transactions", { mode: "dry_run_auto_confirm", min_confidence: 100 }, { responseFixture: "generic-batch-30" }),
      read("get_execution_plan_page", { plan_handle: PLAN_HANDLE }, { responseFixture: "plan-page-first" }),
      approvedMutation("reconcile_bank_transactions", { mode: "execute_auto_confirm", plan_handle: PLAN_HANDLE }, "generic-batch-30"),
    ],
  },
  {
    name: "month-end",
    steps: [
      read("month_end_close_checklist", { month: "2026-06" }),
      read("accounting_inbox", { mode: "scan", workspace_path: "<ABSOLUTE_PATH>" }, { responseFixture: "accounting-inbox-20", ambiguityQuestions: 1 }),
      read("compute_payables_aging", { as_of_date: "2026-06-30" }),
      read("compute_receivables_aging", { as_of_date: "2026-06-30" }),
      read("compute_profit_and_loss", { date_from: "2026-06-01", date_to: "2026-06-30" }),
      read("compute_balance_sheet", { date_to: "2026-06-30" }),
      read("get_session_log", { date_from: "2026-06-01", date_to: "2026-06-30" }),
    ],
  },
];

async function measureJourneys() {
  const fixtures = new Map((await buildResponseFixtures()).map((fixture) => [fixture.name, fixture]));
  return JOURNEYS.map((journey) => {
    const mutationSteps = journey.steps.filter((step) => step.mutation);
    return {
      name: journey.name,
      callCount: journey.steps.length,
      requestBytes: journey.steps.reduce((total, step) => total + Buffer.byteLength(JSON.stringify({
        name: step.tool,
        arguments: step.request,
      }), "utf8"), 0),
      responseBytes: journey.steps.reduce((total, step) => {
        const response = step.responseFixture
          ? fixtures.get(step.responseFixture)!.encoded
          : toMcpJson(step.response!);
        return total + Buffer.byteLength(response, "utf8");
      }, 0),
      technicalIdPrompts: journey.steps.reduce((total, step) => total + (step.technicalIdPrompts ?? 0), 0),
      ambiguityQuestions: journey.steps.reduce((total, step) => total + (step.ambiguityQuestions ?? 0), 0),
      mutationCalls: mutationSteps.length,
      approvalBeforeMutation: mutationSteps.length === 0
        ? "not-applicable"
        : mutationSteps.every((step) => step.approval === "obtained"),
    };
  });
}

describe("user-journey accounting contract", () => {
  it("pins present call and byte costs plus user-friction counters", async () => {
    expect(await measureJourneys()).toEqual([
      {
        name: "setup",
        callCount: 3,
        requestBytes: 347,
        responseBytes: 2_452,
        technicalIdPrompts: 0,
        ambiguityQuestions: 0,
        mutationCalls: 1,
        approvalBeforeMutation: true,
      },
      {
        name: "purchase-invoice",
        callCount: 9,
        requestBytes: 1_185,
        responseBytes: 1_051,
        technicalIdPrompts: 1,
        ambiguityQuestions: 1,
        mutationCalls: 2,
        approvalBeforeMutation: true,
      },
      {
        name: "camt",
        callCount: 3,
        requestBytes: 400,
        responseBytes: 23_596,
        technicalIdPrompts: 1,
        ambiguityQuestions: 1,
        mutationCalls: 1,
        approvalBeforeMutation: true,
      },
      {
        name: "wise",
        callCount: 3,
        requestBytes: 556,
        responseBytes: 17_524,
        technicalIdPrompts: 2,
        ambiguityQuestions: 1,
        mutationCalls: 1,
        approvalBeforeMutation: true,
      },
      {
        name: "bank-input",
        callCount: 3,
        requestBytes: 348,
        responseBytes: 23_596,
        technicalIdPrompts: 0,
        ambiguityQuestions: 0,
        mutationCalls: 1,
        approvalBeforeMutation: true,
      },
      {
        name: "receipt-batch",
        callCount: 3,
        requestBytes: 462,
        responseBytes: 20_817,
        technicalIdPrompts: 1,
        ambiguityQuestions: 1,
        mutationCalls: 1,
        approvalBeforeMutation: true,
      },
      {
        name: "reconciliation",
        callCount: 4,
        requestBytes: 422,
        responseBytes: 8_759,
        technicalIdPrompts: 0,
        ambiguityQuestions: 1,
        mutationCalls: 1,
        approvalBeforeMutation: true,
      },
      {
        name: "month-end",
        callCount: 7,
        requestBytes: 560,
        responseBytes: 7_113,
        technicalIdPrompts: 0,
        ambiguityQuestions: 1,
        mutationCalls: 0,
        approvalBeforeMutation: "not-applicable",
      },
    ]);
  });

  it("never records a mutation without approval first", () => {
    for (const journey of JOURNEYS) {
      for (const step of journey.steps.filter((candidate) => candidate.mutation)) {
        expect(step.approval, `${journey.name}:${step.tool}`).toBe("obtained");
      }
    }
  });

  it("models setup as preview, approval, then plan-bound persistence", () => {
    const setup = JOURNEYS.find((journey) => journey.name === "setup")!;
    expect(setup.steps).toHaveLength(3);
    expect(setup.steps[1]).toMatchObject({
      tool: "import_apikey_credentials",
      request: { execute: false },
      mutation: false,
    });
    expect(setup.steps[2]).toMatchObject({
      tool: "import_apikey_credentials",
      request: { execute: true, plan_handle: PLAN_HANDLE },
      mutation: true,
      approval: "obtained",
    });
  });

  it("assigns an explicit representative response to every call", () => {
    for (const journey of JOURNEYS) {
      for (const step of journey.steps) {
        expect(
          step.responseFixture !== undefined || step.response !== undefined,
          `${journey.name}:${step.tool}`,
        ).toBe(true);
      }
    }
  });

  it("validates every journey request against its captured production input schema", async () => {
    const surface = await captureToolSurface("full");
    const schemas = new Map(surface.tools.map((tool) => [tool.name, tool.inputSchema]));
    const validatorProvider = new AjvJsonSchemaValidator();

    for (const journey of JOURNEYS) {
      for (const step of journey.steps) {
        const schema = schemas.get(step.tool);
        expect(schema, `${journey.name}:${step.tool} is absent from the full production surface`).toBeDefined();
        const result = validatorProvider.getValidator(schema as never)(step.request);
        expect(result.valid, `${journey.name}:${step.tool}: ${result.errorMessage}`).toBe(true);
      }
    }
  });
});
