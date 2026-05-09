import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPrompt as registerMcpPrompt } from "./mcp-compat.js";
import type { CredentialSetupInfo } from "./config.js";
import {
  buildWorkflowPromptSourceText,
  WORKFLOW_PROMPT_SOURCE_BY_PROMPT,
  type WorkflowPromptName,
} from "./workflow-prompt-source.js";

interface SetupPromptOptions {
  offlineTools?: string[];
  note?: string;
}

interface PromptResult {
  messages: Array<{
    role: "user";
    content: {
      type: "text";
      text: string;
    };
  }>;
}

function promptText(text: string): PromptResult {
  return {
    messages: [{
      role: "user",
      content: { type: "text", text },
    }],
  };
}

function buildSetupModePromptText(
  workflowName: string,
  setupInfo: CredentialSetupInfo,
  options: SetupPromptOptions = {},
): string {
  const availableTools = [
    "get_setup_instructions",
    "list_connections",
    "import_apikey_credentials",
    ...(options.offlineTools ?? []),
  ];

  return `The server is currently running in setup mode, so the \`${workflowName}\` workflow cannot complete yet.

First call \`get_setup_instructions\` and configure credentials.
- Working directory: ${setupInfo.working_directory}
- Searched directories: ${setupInfo.searched_directories.join(", ")}
- Shared config directory used when the configuration should work from any folder: ${setupInfo.global_config_directory}
- Shared env file: ${setupInfo.global_env_file}
- Import tool: \`import_apikey_credentials\`
- Required environment variables: ${setupInfo.env_vars.join(", ")}
- Optional direct credential file env var: ${setupInfo.credential_file_env_var}
- Credential file pattern: ${setupInfo.credential_file_pattern} (working directory import source)
- If exactly one secure \`${setupInfo.credential_file_pattern}\` is present and the client supports prompts, the server may offer to verify it and save the resulting \`.env\` either only for this folder or so it works when you start the MCP server from any folder.

Tools you can use right now:
${availableTools.map(tool => `- \`${tool}\``).join("\n")}
${options.note ? `\nSpecific guidance:\n- ${options.note}` : ""}

After credentials are configured and the MCP server is restarted, run \`${workflowName}\` again.`;
}

function workflowPromptText(name: WorkflowPromptName, args: unknown): string {
  return buildWorkflowPromptSourceText(WORKFLOW_PROMPT_SOURCE_BY_PROMPT[name], args);
}

function registerWorkflowPrompt<Args extends z.ZodRawShape>(
  server: McpServer,
  setupInfo: CredentialSetupInfo | undefined,
  name: WorkflowPromptName,
  description: string,
  argsSchema: Args,
  options: SetupPromptOptions | undefined = undefined,
): void {
  registerMcpPrompt(server, name, description, argsSchema, async (args) => {
    if (setupInfo && options) {
      return promptText(buildSetupModePromptText(name, setupInfo, options));
    }
    return promptText(workflowPromptText(name, args));
  });
}

function registerWorkflowPromptWithoutArgs(
  server: McpServer,
  setupInfo: CredentialSetupInfo | undefined,
  name: WorkflowPromptName,
  description: string,
  options: SetupPromptOptions | undefined = undefined,
): void {
  registerMcpPrompt(server, name, description, async () => {
    if (setupInfo && options) {
      return promptText(buildSetupModePromptText(name, setupInfo, options));
    }
    return promptText(workflowPromptText(name, {}));
  });
}

export function registerPrompts(
  server: McpServer,
  options: { setupInfo?: CredentialSetupInfo } = {},
): void {
  const setupInfo = options.setupInfo;

  registerWorkflowPrompt(
    server,
    undefined,
    "setup-credentials",
    "Inspect the current e-arveldaja credential setup, import credentials from an apikey file, and explain the required restart and next steps.",
    {
      file_path: z.string().optional().describe("Optional absolute path to an apikey*.txt file to import"),
      storage_scope: z.enum(["local", "global"]).optional().describe("Optional target scope: local for this folder only, global for any folder"),
    },
  );

  registerWorkflowPromptWithoutArgs(
    server,
    undefined,
    "setup-e-arveldaja",
    "Explain how to configure e-arveldaja API credentials, including supported environment variables, apikey import, storage scope, restart, and first verification.",
  );

  registerWorkflowPrompt(
    server,
    undefined,
    "accounting-inbox",
    "Scan a workspace for likely accounting inputs, propose the next safe dry-run steps, and ask only the smallest necessary follow-up questions.",
    {
      workspace_path: z.string().optional().describe("Optional folder to scan for CAMT statements, Wise CSV files, and receipt folders"),
    },
  );

  registerWorkflowPrompt(
    server,
    undefined,
    "resolve-accounting-review",
    "FIRST PASS of a two-step review flow. Calls `continue_accounting_workflow` with action='resolve_review' to surface the recommendation, compliance basis, unresolved questions, and suggested workflow.",
    {
      review_item_json: z.string().describe("JSON object from autopilot.needs_accountant_review[*].resolver_input or a direct review item payload"),
    },
  );

  registerWorkflowPrompt(
    server,
    undefined,
    "prepare-accounting-review-action",
    "SECOND PASS of the review flow. Calls `continue_accounting_workflow` with action='prepare_action' to emit a concrete `proposed_action` for explicit approval.",
    {
      review_item_json: z.string().describe("JSON object from autopilot.needs_accountant_review[*].resolver_input or a direct review item payload"),
      save_as_rule: z.boolean().optional().describe("Optional hint to prepare a save_auto_booking_rule action when the treatment is stable"),
      rule_override_json: z.string().optional().describe("Optional JSON object with explicit rule fields such as purchase_article_id, purchase_account_id, liability_account_id, vat_rate_dropdown, reversed_vat_id, reason, match, or category"),
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "book-invoice",
    "Book a purchase invoice from a source document. Extracts invoice data, validates it, resolves the supplier, suggests booking accounts, previews the booking, and creates + confirms the invoice after approval.",
    { file_path: z.string().describe("Absolute path to the invoice document file (PDF/JPG/PNG)") },
    {
      offlineTools: ["extract_pdf_invoice", "validate_invoice_data"],
      note: "Supplier resolution, duplicate detection, booking suggestions, invoice creation, and confirmation all require configured e-arveldaja credentials.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "receipt-batch",
    "Scan a receipt folder, preview auto-bookable results, and only create purchase invoices after explicit approval.",
    {
      folder_path: z.string().describe("Absolute path to the receipt folder"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID used for bank transaction matching"),
      date_from: z.string().optional().describe("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
    },
    {
      offlineTools: ["receipt_batch", "scan_receipt_folder"],
      note: "Full receipt processing, supplier resolution, duplicate checks, bank matching, and invoice creation all require configured credentials.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "import-camt",
    "Parse a CAMT.053 statement, preview imported bank transactions, and only create them after approval.",
    {
      file_path: z.string().describe("Absolute path to the CAMT.053 XML file"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID in e-arveldaja"),
      date_from: z.string().optional().describe("Optional statement-entry lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional statement-entry upper bound (YYYY-MM-DD)"),
    },
    {
      offlineTools: ["process_camt053", "parse_camt053"],
      note: "Parsing the CAMT file can be done locally, but dry-run imports and transaction creation require configured e-arveldaja credentials.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "import-wise",
    "Preview Wise transaction import results, including fees and skipped duplicates, before creating any bank transactions.",
    {
      file_path: z.string().describe("Absolute path to the regular Wise transaction-history.csv export"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID for the Wise account"),
      fee_account_dimensions_id: z.number().optional().describe("Optional Wise fee expense account dimension ID"),
      date_from: z.string().optional().describe("Optional transaction-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional transaction-date upper bound (YYYY-MM-DD)"),
      skip_jar_transfers: z.boolean().optional().describe("Skip Jar transfers (default true)"),
    },
    {
      note: "Wise import preview and execution both depend on live e-arveldaja account and transaction data, so this workflow stays blocked until credentials are configured.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "classify-unmatched",
    "Classify unmatched bank transactions, preview generated purchase-invoice bookings, and only apply them after approval.",
    {
      accounts_dimensions_id: z.number().describe("Bank account dimension ID used for transaction classification"),
      date_from: z.string().optional().describe("Optional transaction-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional transaction-date upper bound (YYYY-MM-DD)"),
    },
    {
      note: "This workflow depends on live unmatched bank transactions and e-arveldaja booking data, so it cannot run before credentials are configured.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "reconcile-bank",
    "Match bank transactions to invoices and optionally auto-confirm exact matches.",
    {
      mode: z.enum(["auto", "review", "transaction"]).optional().describe('Reconciliation mode: "auto" (default), "review", or "transaction"'),
      transaction_id: z.number().int().positive().optional().describe('Specific bank transaction ID when mode is "transaction"'),
    },
    {
      note: "Bank reconciliation requires live transactions, invoices, and journals from e-arveldaja, so it cannot run in setup mode.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "month-end-close",
    "Run the month-end close checklist: check for blockers, find missing documents, detect duplicates, and generate financial statements.",
    { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM").describe('Month in YYYY-MM format, e.g. "2026-03"') },
    {
      note: "Month-end checks rely on live e-arveldaja invoices, transactions, journals, and reports, so this workflow stays blocked until credentials are configured.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "new-supplier",
    "Create a new supplier by looking up registry data and creating a client record.",
    { identifier: z.string().describe("Supplier name or 8-digit Estonian registry code") },
    {
      note: "Existing-client lookup, supplier resolution, and client creation are API-backed steps, so this workflow cannot complete before credentials are configured.",
    },
  );

  registerWorkflowPromptWithoutArgs(
    server,
    setupInfo,
    "company-overview",
    "Get a comprehensive dashboard overview of the company's current financial state.",
    {
      note: "This dashboard depends on live company settings and financial reports from e-arveldaja, so it cannot run before credentials are configured.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "lightyear-booking",
    "Book Lightyear investment trades and distributions into e-arveldaja journals. Parses CSV exports, pairs FX conversions, matches capital gains, and creates journal entries.",
    {
      statement_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
      capital_gains_path: z.string().optional().describe("Absolute path to Lightyear CapitalGainsStatement CSV (required for sells)"),
      investment_account: z.number().describe("Investment asset account number (e.g. 1550)"),
      broker_account: z.number().describe("Broker cash account number (e.g. 1120)"),
      income_account: z.number().optional().describe("Distribution income account (e.g. 8320 or 8400)"),
      gain_loss_account: z.number().optional().describe("Realized gain/loss account for sell trades"),
      loss_account: z.number().optional().describe("Optional separate realized loss account"),
      fee_account: z.number().optional().describe("Optional fee expense account"),
      tax_account: z.number().optional().describe("Withheld tax account for distributions"),
      investment_dimension_id: z.number().optional().describe("Optional dimension ID for the investment account"),
      broker_dimension_id: z.number().optional().describe("Optional dimension ID for the broker account"),
    },
    {
      note: "Lightyear booking needs live e-arveldaja journal creation and duplicate checks, so it cannot run before credentials are configured.",
    },
  );
}
