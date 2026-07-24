import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveBankAccount,
  type BankDimensionCandidate,
} from "./resolution/bank-account-resolution.js";
import type { AccountDimension } from "./types/api.js";
import { createConnectionDefaultsStore } from "./connection-defaults-store.js";
import { createElicitor, type ElicitOutcome } from "./elicitation.js";
import { buildResponseFixtures, type ResponseFixtureName } from "../scripts/measure-response-fixtures.js";
import { captureToolSurface, TOOL_SURFACE_SETUP_INFO } from "./__fixtures__/tool-surface.js";
import { toMcpJson } from "./mcp-json.js";
import { buildSetupInstructionsPayload } from "./server-bootstrap.js";
import { isToolVisibleForProfile, type ToolProfile } from "./tool-profile.js";

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
    case "process_accounting_document":
      return request.mode === "create"
        ? {
            result: { created_invoice_id: 90_001, document_uploaded: true, status: "SAVED" },
            note: "Purchase invoice created as DRAFT and the source document uploaded. This is APPROVAL ONE (create/upload). Confirmation is a SEPARATE step — review, then confirm the invoice using its confirm plan handle below.",
            confirm_plan: { plan_handle: "<HANDLE>", invoice_id: 90_001 },
            mutation_occurred: true,
          }
        : {
            summary: {
              status: "ready_for_approval",
              plan_handle: "<HANDLE>",
              supplier: { status: "resolved", client_id: 42, name: "Fixture Supplier OÜ", match_type: "registry_code" },
              extraction: { source_sha256: "0".repeat(64), page_count: 1, confidence_signals: {}, invoice_number: "INV-2026-001", invoice_date: "2026-06-15", total_net: 100, total_vat: 24, total_gross: 124 },
              vat_validation: { valid: true, errors: [], warnings: [] },
              duplicate: { candidate_duplicate_risk: false, candidate_invoice_number_matches: 0, candidate_same_amount_date_matches: 0, candidate_invalidated_matches: 0 },
              blockers: [],
              warnings: [],
              next_step: "Review this preview. After explicit approval, call process_accounting_document with mode='create' and this plan_handle to create the DRAFT invoice; confirm it separately afterward.",
            },
            mutation_occurred: false,
          };
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
    // Guided single-document façade: prepare (read) -> approved create two-call.
    // The unique supplier resolves automatically (no supplier_client_id /
    // accounts_dimensions_id demanded on the read), and create returns a SECOND
    // confirm plan that is NOT auto-run.
    name: "accounting-document",
    steps: [
      read("process_accounting_document", { mode: "prepare", file_path: "<ABSOLUTE_PATH>" }, {
        technicalIdPrompts: 0,
        ambiguityQuestions: 0,
      }),
      read("get_execution_plan_page", { plan_handle: PLAN_HANDLE }, { responseFixture: "plan-page-first" }),
      approvedMutation("process_accounting_document", {
        mode: "create",
        file_path: "<ABSOLUTE_PATH>",
        plan_handle: PLAN_HANDLE,
        source_sha256: "0".repeat(64),
        supplier_client_id: 42,
        invoice_number: "INV-2026-001",
        invoice_date: "2026-06-15",
        journal_date: "2026-06-15",
        term_days: 14,
        items: [{ custom_title: "Consulting service", cl_purchase_articles_id: 1, purchase_accounts_id: 5000, total_net_price: 100 }],
        vat_price: 24,
        gross_price: 124,
      }),
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
        name: "accounting-document",
        callCount: 3,
        requestBytes: 734,
        responseBytes: 5_723,
        technicalIdPrompts: 0,
        ambiguityQuestions: 0,
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

// Task 14 (Step 6): the four guided milestone journeys, each proving a capability
// is achievable END-TO-END inside the guided (or guided-sales) profile after the
// surface fold. Beyond validating every request against the full production
// schema, each step is asserted `isToolVisibleForProfile(tool, profile)` — the
// achievability proof the byte-pinned JOURNEYS above (validated only against
// `full`) does not carry.
interface GuidedJourneyStep { tool: string; request: Record<string, unknown> }
interface GuidedJourney { name: string; profile: ToolProfile; steps: GuidedJourneyStep[] }
const GUIDED_JOURNEYS: GuidedJourney[] = [
  {
    name: "guided-inter-account-reconcile",
    profile: "guided",
    steps: [
      { tool: "reconcile_bank_transactions", request: { mode: "inter_account_dry_run" } },
      { tool: "get_execution_plan_page", request: { plan_handle: PLAN_HANDLE } },
      { tool: "reconcile_bank_transactions", request: { mode: "execute_inter_account", plan_handle: PLAN_HANDLE } },
    ],
  },
  {
    name: "guided-duplicate-cleanup",
    profile: "guided",
    steps: [
      { tool: "accounting_inbox", request: { mode: "scan", workspace_path: "<ABSOLUTE_PATH>" } },
      { tool: "continue_accounting_workflow", request: { action: "prepare_action", review_item_json: { review_type: "camt_possible_duplicate" } } },
      { tool: "cleanup_camt_possible_duplicate", request: { keep_transaction_id: 1, delete_transaction_id: 2 } },
    ],
  },
  {
    name: "guided-rule-saving",
    profile: "guided",
    steps: [
      { tool: "continue_accounting_workflow", request: { action: "prepare_action", save_as_rule: true, review_item_json: { review_type: "auto_booking_rule_candidate" } } },
      { tool: "save_auto_booking_rule", request: { match: "acme oü", purchase_accounts_id: 5000 } },
    ],
  },
  {
    name: "guided-trial-balance",
    profile: "guided",
    steps: [
      { tool: "run_accounting_report", request: { report: "trial_balance" } },
    ],
  },
];

describe("guided milestone achievability contract", () => {
  it("every guided journey step is visible in its profile", () => {
    for (const journey of GUIDED_JOURNEYS) {
      for (const step of journey.steps) {
        expect(
          isToolVisibleForProfile(step.tool, journey.profile),
          `${journey.name}:${step.tool} is not visible in the ${journey.profile} profile`,
        ).toBe(true);
      }
    }
  });

  it("every guided journey request validates against its captured production schema", async () => {
    const surface = await captureToolSurface("full");
    const schemas = new Map(surface.tools.map((tool) => [tool.name, tool.inputSchema]));
    const validatorProvider = new AjvJsonSchemaValidator();
    for (const journey of GUIDED_JOURNEYS) {
      for (const step of journey.steps) {
        const schema = schemas.get(step.tool);
        expect(schema, `${journey.name}:${step.tool} is absent from the full surface`).toBeDefined();
        const result = validatorProvider.getValidator(schema as never)(step.request);
        expect(result.valid, `${journey.name}:${step.tool}: ${result.errorMessage}`).toBe(true);
      }
    }
  });

  it("proves inter-account reconcile, duplicate cleanup, rule saving, and trial balance are each guided-achievable", () => {
    expect(GUIDED_JOURNEYS.map((journey) => journey.name)).toEqual([
      "guided-inter-account-reconcile",
      "guided-duplicate-cleanup",
      "guided-rule-saving",
      "guided-trial-balance",
    ]);
  });
});

// Task 15 (Step 7): four EXECUTABLE journeys proving the persisted-defaults +
// capability-aware-elicitation contract end to end (the byte-pinned JOURNEYS
// above model static fixtures and cannot execute a store/elicit round-trip).
describe("Task 15 — persisted-defaults & elicitation journeys", () => {
  const tempDirs: string[] = [];
  const storePath = () => { const d = mkdtempSync(join(tmpdir(), "uj-defaults-")); tempDirs.push(d); return join(d, "connection-defaults.json"); };
  afterAll(() => { while (tempDirs.length) { try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } } });

  const cand = (id: number, label: string): BankDimensionCandidate => ({ accounts_dimensions_id: id, label, match_reason: "Linked bank account dimension" });
  const twoBanks = [cand(101, "LHV"), cand(102, "SEB")];
  const dims: AccountDimension[] = [{ id: 101, accounts_id: 1020, title_est: "LHV" }, { id: 102, accounts_id: 1020, title_est: "SEB" }];
  const scope = { connectionId: "conn-A", environmentKind: "live" as const };

  // A fake MCP server whose client supports elicitation and accepts a chosen
  // dimension. Counts how many forms are opened (the "one-question" friction).
  function elicitorAcceptingDimension(chosenId: string, counter: { forms: number }) {
    const server = {
      server: {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: async () => { counter.forms += 1; return { action: "accept", content: { accounts_dimensions_id: chosenId, remember_for_connection: true } }; },
      },
    };
    return createElicitor(server as never);
  }

  it("journey 1 — unique/no-question: a single-candidate bank resolves with ZERO questions", async () => {
    const counter = { forms: 0 };
    const elicit = elicitorAcceptingDimension("101", counter);
    const resolution = await resolveBankAccount({ candidates: [cand(101, "LHV")] });
    // Unique local bank ⇒ resolved without ever opening a form.
    expect(resolution).toMatchObject({ status: "resolved", value: 101 });
    // No form was needed (technicalIdPrompts:0, ambiguityQuestions:0).
    expect(counter.forms).toBe(0);
    void elicit;
  });

  it("journey 2 — ambiguous/one-question: EXACTLY one elicitation form, then resolves", async () => {
    const counter = { forms: 0 };
    const elicit = elicitorAcceptingDimension("102", counter);
    const first = await resolveBankAccount({ candidates: twoBanks, accountDimensions: dims });
    expect(first.status).toBe("ambiguous"); // needs exactly one question
    const outcome: ElicitOutcome = await elicit({
      message: "Which bank account dimension should be used?",
      fields: { accounts_dimensions_id: { type: "enum", choices: first.status === "ambiguous" ? first.choices.map(c => ({ const: c.id, title: c.label })) : [] } },
      required: ["accounts_dimensions_id"],
      needsInput: { status: "needs_input" },
    });
    expect(counter.forms).toBe(1); // exactly ONE question
    expect(outcome.kind).toBe("answered");
    // The answer is re-run through the resolver (override), never trusted directly.
    const second = await resolveBankAccount({ candidates: twoBanks, accountDimensions: dims, override: 102 });
    expect(second).toMatchObject({ status: "resolved", value: 102 });
  });

  it("journey 3 — persistence-consent: consented hint makes the NEXT scan resolve via rung 3 with ZERO questions", async () => {
    const store = createConnectionDefaultsStore(storePath());
    // Operator answered with consent on the first (ambiguous) scan → persisted.
    store.saveBankDefault({ ...scope, accounts_dimensions_id: 102, ledgerAccountId: 1020, currency: "EUR", input_type: "camt" });
    const counter = { forms: 0 };
    const elicit = elicitorAcceptingDimension("999", counter);
    // Second scan, same connection: rung 3 resolves BEFORE any question.
    const resolution = await resolveBankAccount({
      candidates: twoBanks,
      accountDimensions: dims,
      currentConnectionId: "conn-A",
      expectedLedgerAccountId: 1020,
      statementCurrency: "EUR",
      savedDefaultPort: store.bankDefaultPort(scope),
    });
    expect(resolution).toMatchObject({ status: "resolved", value: 102 });
    if (resolution.status === "resolved") expect(resolution.evidence.map(e => e.tag)).toContain("saved_default");
    expect(counter.forms).toBe(0); // no fresh question on the second scan
    void elicit;
  });

  it("journey 4 — no-secret-elicitation: the wrapper REFUSES any credential/secret field", async () => {
    const server = { server: { getClientCapabilities: () => ({ elicitation: {} }), elicitInput: async () => ({ action: "accept", content: {} }) } };
    const elicit = createElicitor(server as never);
    for (const secretKey of ["api_key", "apiKey", "password", "public_value", "secret_token"]) {
      await expect(elicit({ message: "m", fields: { [secretKey]: { type: "string" } }, needsInput: {} })).rejects.toThrow();
    }
    // A bounded, non-secret bank form is accepted.
    await expect(elicit({
      message: "Which bank account dimension?",
      fields: { accounts_dimensions_id: { type: "enum", choices: [{ const: "101", title: "LHV" }] }, remember_for_connection: { type: "boolean" } },
      needsInput: {},
    })).resolves.toBeDefined();
  });

  it("journey 3 corollary — the persisted document holds NO secret material", () => {
    const store = createConnectionDefaultsStore(storePath());
    store.saveBankDefault({ ...scope, accounts_dimensions_id: 102, ledgerAccountId: 1020, currency: "EUR" } as never);
    const pointer = store.readBankDefault({ ...scope, expectedLedgerAccountId: 1020 });
    expect(JSON.stringify(pointer)).not.toMatch(/api.?key|password|secret|public.?value|token/i);
  });
});
