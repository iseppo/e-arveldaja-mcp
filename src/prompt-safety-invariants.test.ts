import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  checkWorkflowTrace,
  type ApprovalScope,
  type MutationEvent,
  type PlanPreview,
  type WorkflowInvariant,
  type WorkflowTraceEvent,
} from "./workflow-trace.js";
import { CAMT_PLAN_DOMAIN } from "./tools/camt-plan.js";
import { BANK_RECONCILIATION_PLAN_DOMAIN } from "./tools/bank-reconciliation-plan.js";
import {
  LIGHTYEAR_DISTRIBUTIONS_PLAN_DOMAIN,
  LIGHTYEAR_TRADES_PLAN_DOMAIN,
} from "./tools/lightyear-plan.js";
import { WISE_PLAN_DOMAIN } from "./tools/wise-import.js";
import { CREDENTIAL_IMPORT_DOMAIN, CREDENTIAL_REMOVE_DOMAIN } from "./credential-plans.js";
import { validateLegalEntityIdentity } from "./legal-entity-identity.js";
import {
  PROMPT_REGISTRY,
  enabledPromptDefinitions,
} from "./prompt-registry.js";
import type { ToolExposureConfig } from "./config.js";
import { buildWorkflowPromptSourceText } from "./workflow-prompt-source.js";
import {
  PROMPT_SURFACE_LIMIT,
  PROMPT_SURFACE_SHARED_WRAPPER,
} from "./prompt-surface.js";
import {
  generatedClaudeCommandText,
  MAXIMUM_VALID_PROMPT_ARGUMENTS,
} from "../scripts/prompt-surface-files.ts";

// ---------------------------------------------------------------------------
// A faithful, synthetic-but-real-shaped trace per MUTATING workflow. Each spec
// binds to the REAL plan-store domain / advertised MCP tool ids and models what
// the reviewed dry run previewed. No test performs a live mutation.
// ---------------------------------------------------------------------------

interface WorkflowSpec {
  readonly label: string;
  readonly workflow: string;
  readonly advertisedTools: readonly string[];
  /** A tool present in the wider server but NOT advertised in this surface. */
  readonly foreignTool: string;
  readonly mutatingTool: string;
  readonly category: string;
  readonly account: string;
  readonly sources: readonly string[];
  readonly manifest?: string;
}

// The identity gate source is bound to the REAL legal-entity-identity contract
// (17133416 is a checksum-valid Estonian registry code).
const estonianIdentity = validateLegalEntityIdentity({ reg_code: "17133416", country: "EST" });
const supplierIdentitySource = `identity:${estonianIdentity.ok ? estonianIdentity.kind : "invalid"}:17133416`;

const WORKFLOW_SPECS: readonly WorkflowSpec[] = [
  {
    label: "CAMT import",
    workflow: CAMT_PLAN_DOMAIN,
    advertisedTools: [
      "process_camt053", "parse_camt053", "import_camt053", "confirm_transaction",
      "cleanup_camt_possible_duplicate", "update_transaction", "delete_transaction",
      "get_execution_plan_page",
    ],
    foreignTool: "delete_client",
    mutatingTool: "import_camt053",
    category: "create_bank_transaction",
    account: "1120",
    sources: ["camt:entry:1", "camt:entry:2"],
  },
  {
    label: "bank reconciliation",
    workflow: BANK_RECONCILIATION_PLAN_DOMAIN,
    advertisedTools: [
      "reconcile_bank_transactions", "reconcile_inter_account_transfers",
      "confirm_transaction", "get_execution_plan_page",
    ],
    foreignTool: "delete_journal",
    mutatingTool: "reconcile_bank_transactions",
    category: "confirm_match",
    account: "1120",
    sources: ["tx:501", "tx:502"],
  },
  {
    label: "Lightyear trades",
    workflow: LIGHTYEAR_TRADES_PLAN_DOMAIN,
    advertisedTools: [
      "parse_lightyear_statement", "parse_lightyear_capital_gains",
      "book_lightyear_trades", "get_execution_plan_page",
    ],
    foreignTool: "delete_journal",
    mutatingTool: "book_lightyear_trades",
    category: "book_trade",
    account: "1550",
    sources: ["ly:trade:OR-1", "ly:trade:OR-2"],
  },
  {
    label: "Lightyear distributions",
    workflow: LIGHTYEAR_DISTRIBUTIONS_PLAN_DOMAIN,
    advertisedTools: [
      "parse_lightyear_statement", "book_lightyear_distributions", "get_execution_plan_page",
    ],
    foreignTool: "delete_journal",
    mutatingTool: "book_lightyear_distributions",
    category: "book_distribution",
    account: "8330",
    sources: ["ly:dist:DV-1"],
  },
  {
    label: "Wise ownership import",
    workflow: WISE_PLAN_DOMAIN,
    advertisedTools: [
      "import_wise_transactions", "list_account_dimensions", "confirm_transaction",
      "get_execution_plan_page",
    ],
    foreignTool: "delete_transaction",
    mutatingTool: "import_wise_transactions",
    category: "create_bank_transaction",
    account: "1120",
    // The ownership approvals must equal the previewed unverified transfer IDs
    // exactly; the digest is the command-integrity binding.
    sources: ["wise:transfer:T1", "wise:transfer:T2"],
    manifest: "wise-command-digest-abc",
  },
  {
    label: "credential import",
    workflow: CREDENTIAL_IMPORT_DOMAIN,
    advertisedTools: ["get_setup_instructions", "import_apikey_credentials", "list_stored_credentials"],
    foreignTool: "remove_stored_credentials",
    mutatingTool: "import_apikey_credentials",
    category: "store_credential",
    account: "credential",
    sources: ["cred:file:apikey.txt"],
  },
  {
    label: "credential removal",
    workflow: CREDENTIAL_REMOVE_DOMAIN,
    advertisedTools: ["list_stored_credentials", "remove_stored_credentials"],
    foreignTool: "import_apikey_credentials",
    mutatingTool: "remove_stored_credentials",
    category: "remove_credential",
    account: "credential",
    sources: ["cred:connection:2"],
  },
  {
    label: "supplier creation (identity gate)",
    workflow: "supplier_create",
    advertisedTools: ["search_client", "resolve_supplier", "create_client"],
    foreignTool: "delete_client",
    mutatingTool: "create_client",
    category: "create_supplier",
    account: "clients",
    sources: [supplierIdentitySource],
  },
  {
    label: "prepared review action",
    workflow: "accounting_review",
    advertisedTools: ["continue_accounting_workflow", "save_auto_booking_rule"],
    foreignTool: "delete_journal",
    mutatingTool: "continue_accounting_workflow",
    category: "prepare_action_execute",
    account: "review",
    sources: ["review:item:1"],
  },
];

function preview(spec: WorkflowSpec): PlanPreview {
  return {
    domain: spec.workflow,
    categories: [spec.category],
    accounts: [spec.account],
    sources: spec.sources,
    ...(spec.manifest !== undefined ? { manifest: spec.manifest } : {}),
  };
}

function approvalScope(spec: WorkflowSpec, planHandle: string): ApprovalScope {
  return { workflow: spec.workflow, planHandle, ...preview(spec) };
}

function mutation(spec: WorkflowSpec, planHandle: string): MutationEvent {
  return {
    type: "MUTATION",
    workflow: spec.workflow,
    tool: spec.mutatingTool,
    domain: spec.workflow,
    planHandle,
    category: spec.category,
    account: spec.account,
    // Mutating a strict subset of what was previewed is always in scope.
    sources: [spec.sources[0]!],
    ...(spec.manifest !== undefined ? { manifest: spec.manifest } : {}),
  };
}

/** A canonical, well-formed trace: dry run → preview → approval → execute. */
function wellFormed(spec: WorkflowSpec, planHandle = "handle-1"): WorkflowTraceEvent[] {
  return [
    { type: "PROMPT", workflow: spec.workflow, advertisedTools: spec.advertisedTools },
    { type: "TOOL_CALL", workflow: spec.workflow, tool: spec.advertisedTools[0]! },
    {
      type: "TOOL_RESULT",
      workflow: spec.workflow,
      tool: spec.advertisedTools[0]!,
      issuesPlanHandle: planHandle,
      planPreview: preview(spec),
    },
    { type: "USER_APPROVAL", workflow: spec.workflow, scope: approvalScope(spec, planHandle) },
    mutation(spec, planHandle),
  ];
}

function invariants(violations: readonly { invariant: WorkflowInvariant }[]): WorkflowInvariant[] {
  return violations.map(v => v.invariant);
}

function patchMutation(events: WorkflowTraceEvent[], patch: Partial<MutationEvent>): WorkflowTraceEvent[] {
  return events.map(event => (event.type === "MUTATION" ? { ...event, ...patch } : event));
}

describe("prompt safety invariants — every mutating workflow", () => {
  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: a well-formed approval-bound trace has no violations",
    (_label, spec) => {
      expect(checkWorkflowTrace(wellFormed(spec))).toEqual([]);
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 1 — a plan handle without a matching USER_APPROVAL is caught",
    (_label, spec) => {
      const events = wellFormed(spec).filter(event => event.type !== "USER_APPROVAL");
      expect(invariants(checkWorkflowTrace(events))).toContain("mutation_requires_prior_approval");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 2 — a mutation by an unadvertised tool is caught",
    (_label, spec) => {
      const events = patchMutation(wellFormed(spec), { tool: spec.foreignTool });
      expect(invariants(checkWorkflowTrace(events))).toContain("tool_must_be_advertised");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 2 — a TOOL_CALL to an unadvertised tool is caught",
    (_label, spec) => {
      const events = wellFormed(spec);
      events.splice(1, 0, { type: "TOOL_CALL", workflow: spec.workflow, tool: spec.foreignTool });
      expect(invariants(checkWorkflowTrace(events))).toContain("tool_must_be_advertised");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 3 — a mutation outside the approved domain is caught",
    (_label, spec) => {
      const events = patchMutation(wellFormed(spec), { domain: "unrelated_domain" });
      expect(invariants(checkWorkflowTrace(events))).toContain("mutation_within_approved_scope");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 4 — a category change requires a new preview",
    (_label, spec) => {
      const events = patchMutation(wellFormed(spec), { category: "not_the_approved_category" });
      expect(invariants(checkWorkflowTrace(events))).toContain("scope_change_requires_new_preview");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 4 — an account change requires a new preview",
    (_label, spec) => {
      const events = patchMutation(wellFormed(spec), { account: "0000" });
      expect(invariants(checkWorkflowTrace(events))).toContain("scope_change_requires_new_preview");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 4 — a subset exceeding the approved sources requires a new preview",
    (_label, spec) => {
      const events = patchMutation(wellFormed(spec), { sources: [...spec.sources, "surprise:extra:source"] });
      expect(invariants(checkWorkflowTrace(events))).toContain("scope_change_requires_new_preview");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 5 — early execute before the handle is issued is caught",
    (_label, spec) => {
      const events = patchMutation(wellFormed(spec), { planHandle: "never-issued" });
      expect(invariants(checkWorkflowTrace(events))).toContain("stale_or_replayed_handle");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 5 — a replayed handle (second execute) is caught",
    (_label, spec) => {
      const events = wellFormed(spec);
      const executed = events[events.length - 1] as MutationEvent;
      expect(invariants(checkWorkflowTrace([...events, { ...executed }]))).toContain("stale_or_replayed_handle");
    },
  );

  it.each(WORKFLOW_SPECS.map(spec => [spec.label, spec] as const))(
    "%s: invariant 5 — a mutation on an invalidated (expired/drifted) handle is caught",
    (_label, spec) => {
      const events = wellFormed(spec);
      const mutationIndex = events.findIndex(event => event.type === "MUTATION");
      events.splice(mutationIndex, 0, {
        type: "TOOL_RESULT",
        workflow: spec.workflow,
        tool: "get_execution_plan_page",
        invalidatesPlanHandle: "handle-1",
      });
      expect(invariants(checkWorkflowTrace(events))).toContain("stale_or_replayed_handle");
    },
  );
});

describe("prompt safety invariants — Wise ownership re-approval binding", () => {
  const wise = WORKFLOW_SPECS.find(spec => spec.workflow === WISE_PLAN_DOMAIN)!;

  it("passes when the executed transfers match the approved ownership subset exactly", () => {
    expect(checkWorkflowTrace(wellFormed(wise))).toEqual([]);
  });

  it("flags execution against a digest that differs from the approved command digest", () => {
    const events = patchMutation(wellFormed(wise), { manifest: "tampered-digest" });
    expect(invariants(checkWorkflowTrace(events))).toContain("mutation_within_approved_scope");
  });

  it("flags an extra unverified transfer that was never in the approved ownership set", () => {
    const events = patchMutation(wellFormed(wise), {
      sources: [...wise.sources, "wise:transfer:T3-unverified"],
    });
    expect(invariants(checkWorkflowTrace(events))).toContain("scope_change_requires_new_preview");
  });
});

describe("prompt safety invariants — receipt create/upload vs confirm/link are separate gates", () => {
  const RECEIPT_WORKFLOW = "receipt_batch";
  const RECEIPT_TOOLS = [
    "scan_receipt_folder", "process_receipt_batch", "receipt_batch",
    "create_purchase_invoice_from_pdf", "confirm_transaction", "get_execution_plan_page",
  ];

  // Phase 1: create + upload the invoice, bound to the approved manifest.
  const createPreview: PlanPreview = {
    domain: RECEIPT_WORKFLOW,
    categories: ["create_invoice", "upload_document"],
    accounts: ["purchase_invoices"],
    sources: ["receipt:sha:aaa"],
    manifest: "manifest-sha-aaa",
  };
  // Phase 2: confirm the invoice / link the bank transaction — a SEPARATE gate.
  const confirmPreview: PlanPreview = {
    domain: RECEIPT_WORKFLOW,
    categories: ["confirm_invoice", "link_transaction"],
    accounts: ["purchase_invoices", "1120"],
    sources: ["receipt:sha:aaa", "tx:900"],
    manifest: "manifest-sha-aaa",
  };

  function twoPhaseTrace(): WorkflowTraceEvent[] {
    return [
      { type: "PROMPT", workflow: RECEIPT_WORKFLOW, advertisedTools: RECEIPT_TOOLS },
      {
        type: "TOOL_RESULT", workflow: RECEIPT_WORKFLOW, tool: "receipt_batch",
        issuesPlanHandle: "receipt-create", planPreview: createPreview,
      },
      {
        type: "USER_APPROVAL", workflow: RECEIPT_WORKFLOW,
        scope: { workflow: RECEIPT_WORKFLOW, planHandle: "receipt-create", ...createPreview },
      },
      {
        type: "MUTATION", workflow: RECEIPT_WORKFLOW, tool: "receipt_batch",
        domain: RECEIPT_WORKFLOW, planHandle: "receipt-create", manifest: "manifest-sha-aaa",
        category: "create_invoice", account: "purchase_invoices", sources: ["receipt:sha:aaa"],
      },
      {
        type: "TOOL_RESULT", workflow: RECEIPT_WORKFLOW, tool: "receipt_batch",
        issuesPlanHandle: "receipt-confirm", planPreview: confirmPreview,
      },
      {
        type: "USER_APPROVAL", workflow: RECEIPT_WORKFLOW,
        scope: { workflow: RECEIPT_WORKFLOW, planHandle: "receipt-confirm", ...confirmPreview },
      },
      {
        type: "MUTATION", workflow: RECEIPT_WORKFLOW, tool: "receipt_batch",
        domain: RECEIPT_WORKFLOW, planHandle: "receipt-confirm", manifest: "manifest-sha-aaa",
        category: "confirm_invoice", account: "1120", sources: ["tx:900"],
      },
    ];
  }

  it("passes when create and confirm each have their own approval", () => {
    expect(checkWorkflowTrace(twoPhaseTrace())).toEqual([]);
  });

  it("flags a confirm/link mutation that rides on only the create approval", () => {
    // Drop the second (confirm) approval and re-point the confirm mutation at the
    // create handle: the create approval must NOT cover confirmation/linking.
    const events = twoPhaseTrace()
      .filter(event => !(event.type === "USER_APPROVAL" && event.scope.planHandle === "receipt-confirm"))
      .map(event =>
        event.type === "MUTATION" && event.category === "confirm_invoice"
          ? { ...event, planHandle: "receipt-create" }
          : event);
    const found = invariants(checkWorkflowTrace(events));
    // Confirmation categories/accounts/sources are outside the create approval.
    expect(found).toContain("scope_change_requires_new_preview");
  });

  it("flags creating the invoice without the approved manifest", () => {
    const events = twoPhaseTrace().map(event =>
      event.type === "MUTATION" && event.category === "create_invoice"
        ? { ...event, manifest: "forged-manifest" }
        : event);
    expect(invariants(checkWorkflowTrace(events))).toContain("mutation_within_approved_scope");
  });
});

// ---------------------------------------------------------------------------
// Exhaustive prompt-surface budget: re-run the max-valid-argument rendering for
// EVERY MCP prompt (feature sections rendered both enabled AND disabled) and
// EVERY generated command, asserting each surface stays within the shared
// 64 KiB budget and embeds the shared safety wrapper EXACTLY once.
// ---------------------------------------------------------------------------

const ALL_ENABLED: ToolExposureConfig = {
  enableLightyear: true,
  exposeGranularTools: true,
  exposeSetupTools: true,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
};

const ALL_DISABLED: ToolExposureConfig = {
  enableLightyear: false,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: false,
  enableReferenceAdmin: false,
  enableAnnualReport: false,
  enableSales: false,
  enableProducts: false,
};

function wrapperCount(text: string): number {
  return text.split(PROMPT_SURFACE_SHARED_WRAPPER).length - 1;
}

describe("exhaustive prompt-surface budget + shared safety wrapper", () => {
  it("keeps the maximum-argument fixtures exhaustive over the registry", () => {
    expect(Object.keys(MAXIMUM_VALID_PROMPT_ARGUMENTS).sort())
      .toEqual(PROMPT_REGISTRY.map(definition => definition.name).sort());
    // The registry is fully renderable under both extreme exposures.
    expect(enabledPromptDefinitions(ALL_ENABLED).length).toBeGreaterThan(0);
    expect(enabledPromptDefinitions(ALL_DISABLED).length).toBeGreaterThan(0);
  });

  it.each(PROMPT_REGISTRY.map(definition => [definition.name, definition] as const))(
    "%s: MCP prompt stays within budget with the wrapper exactly once (feature sections both ways)",
    (name, definition) => {
      const wireArguments = MAXIMUM_VALID_PROMPT_ARGUMENTS[definition.name];
      const parsedArguments = definition.argsSchema
        ? z.object(definition.argsSchema).parse(wireArguments)
        : {};

      for (const exposure of [ALL_ENABLED, ALL_DISABLED]) {
        const rendered = buildWorkflowPromptSourceText(
          definition.slug,
          parsedArguments,
          undefined,
          exposure,
        );
        expect(rendered.length, `${name} MCP prompt length`).toBeLessThanOrEqual(PROMPT_SURFACE_LIMIT);
        expect(wrapperCount(rendered), `${name} MCP prompt wrapper count`).toBe(1);
      }
    },
  );

  it.each(PROMPT_REGISTRY.map(definition => [definition.slug, definition] as const))(
    "%s: generated command stays within budget with the wrapper exactly once",
    (slug, definition) => {
      const workflowText = readFileSync(join(process.cwd(), "workflows", `${definition.slug}.md`), "utf8");

      // Freshly regenerated command (capability sections rendered for every variant).
      const regenerated = generatedClaudeCommandText(definition.slug, workflowText, definition.variants ?? []);
      expect(regenerated.length, `${slug} regenerated command length`).toBeLessThanOrEqual(PROMPT_SURFACE_LIMIT);
      expect(wrapperCount(regenerated), `${slug} regenerated command wrapper count`).toBe(1);

      // Shipped command file must equal the regenerated surface and carry the
      // wrapper exactly once as well.
      const shipped = readFileSync(join(process.cwd(), ".claude", "commands", `${definition.slug}.md`), "utf8");
      expect(shipped, `${slug} shipped command drift`).toBe(regenerated);
      expect(wrapperCount(shipped), `${slug} shipped command wrapper count`).toBe(1);
    },
  );
});
