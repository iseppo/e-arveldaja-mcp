import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPrompt as registerMcpPrompt } from "./mcp-compat.js";
import type { CredentialSetupInfo, ToolExposureConfig } from "./config.js";
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
  options: { setupInfo?: CredentialSetupInfo; toolExposure?: ToolExposureConfig } = {},
): void {
  const setupInfo = options.setupInfo;

  if (options.toolExposure?.enableTaxTools !== false) {
    registerWorkflowPrompt(
      server,
      setupInfo,
      "vat-registration-threshold",
      "Check whether a non-VAT-registered company is approaching or exceeding the 40 000 EUR VAT registration threshold, with financial/insurance/real-estate turnover separated for review.",
      {
        year: z.number().int().min(2000).max(2100).optional().describe("Calendar year to check; defaults to current year"),
        financial_turnover: z.number().min(0).optional().describe("Optional financial-services turnover to include if not incidental"),
        insurance_turnover: z.number().min(0).optional().describe("Optional insurance-services turnover to include if not incidental"),
        real_estate_turnover: z.number().min(0).optional().describe("Optional real-estate turnover to include if not incidental"),
        exempt_social_turnover: z.number().min(0).optional().describe("Optional healthcare/education or similar exempt turnover to show as not counted"),
        incidental_excluded_turnover: z.number().min(0).optional().describe("Optional finance/insurance/real-estate turnover already judged incidental and excluded"),
        taxable_turnover_adjustment: z.number().optional().describe("Optional signed adjustment to sale-invoice taxable/0% turnover"),
        manual_bucket_source: z.enum(["outside_sale_invoices", "included_in_sale_invoices"]).optional().describe("Whether manual bucket amounts are outside sale invoices or already included there"),
      },
      {
        note: "VAT threshold checking needs live VAT status and sale invoices from e-arveldaja, so it cannot run before credentials are configured.",
      },
    );
  }

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
      bank_account_dimension_id: z.number().optional().describe("Optional default bank-account dimension ID reused for CAMT and receipt suggestions"),
      receipt_matching_dimension_id: z.number().optional().describe("Optional bank-account dimension ID used specifically for receipt matching"),
      wise_account_dimension_id: z.number().optional().describe("Optional bank-account dimension ID used specifically for Wise suggestions"),
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
    "SECOND PASS of the review flow: continue_accounting_workflow action='prepare_action' emits a concrete proposed_action for explicit approval.",
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
      accounts_dimensions_id: z.number().optional().describe("Optional bank account dimension ID used for bank transaction matching; if omitted, list account dimensions and ask the user to confirm the best match"),
      date_from: z.string().optional().describe("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
    },
    {
      offlineTools: ["receipt_batch"],
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
      accounts_dimensions_id: z.number().optional().describe("Optional bank account dimension ID in e-arveldaja; if omitted, list account dimensions and ask the user to confirm the bank account"),
      date_from: z.string().optional().describe("Optional statement-entry lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional statement-entry upper bound (YYYY-MM-DD)"),
    },
    {
      offlineTools: ["process_camt053"],
      note: "Parsing the CAMT file can be done locally (process_camt053 mode='parse'), but dry-run imports and transaction creation require configured e-arveldaja credentials.",
    },
  );

  registerWorkflowPrompt(
    server,
    setupInfo,
    "import-wise",
    "Preview Wise CSV import results (fees, skipped duplicates) before creating any bank transactions.",
    {
      file_path: z.string().describe("Absolute path to the regular Wise transaction-history.csv export"),
      accounts_dimensions_id: z.number().optional().describe("Optional bank account dimension ID for the Wise account; if omitted, list account dimensions and ask the user to confirm the Wise bank account"),
      fee_account_dimensions_id: z.number().optional().describe("Optional Wise fee expense account dimension ID"),
      inter_account_dimension_id: z.number().optional().describe("Optional other own bank account dimension for Wise inter-account transfers; required when there are 3+ bank accounts and auto-detection cannot pick one"),
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
      accounts_dimensions_id: z.number().optional().describe("Optional bank account dimension ID used for transaction classification; if omitted, list account dimensions and ask the user to confirm the bank account"),
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
      target_accounts_dimensions_id: z.number().optional().describe("Optional target own-bank account dimension for one-sided inter-account reconciliation; provide when there are 3+ bank accounts and the IBAN is missing"),
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

  // The Lightyear tool group can be dropped via EARVELDAJA_DISABLE_LIGHTYEAR;
  // skip the matching prompt too so prompts/list never advertises a workflow
  // whose tools are not registered. Wrapped in an `if` (not an early return) so
  // any prompt added after this block still registers regardless of the flag.
  if (options.toolExposure?.enableLightyear !== false) {
    registerWorkflowPrompt(
      server,
      setupInfo,
      "lightyear-booking",
      "Book Lightyear investment trades and distributions into e-arveldaja journals. Parses CSV exports, pairs FX conversions, matches capital gains, and creates journal entries.",
      {
        file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
        capital_gains_path: z.string().optional().describe("Absolute path to Lightyear CapitalGainsStatement CSV (required for sells)"),
        investment_account: z.number().describe("Investment asset account number (e.g. 1550)"),
        broker_account: z.number().describe("Broker cash account number (e.g. 1120)"),
        income_account: z.number().optional().describe("Distribution income account (dividends from shares → 8330; fund distributions → 8320; interest → 8400)"),
        gain_loss_account: z.number().optional().describe("Realized gain account for sell gains (default: auto-detect 'Tulu aktsiatelt ja osadelt', standard 8330)"),
        loss_account: z.number().optional().describe("Realized loss account for sell losses (default: auto-detect 'Kulu aktsiatelt ja osadelt', standard 8335)"),
        trade_fee_account: z.number().optional().describe("Expensed TRADE fee account for book_lightyear_trades (default: auto-detect 'Kulu aktsiatelt ja osadelt', standard 8335). Do not reuse this for distributions."),
        distribution_fee_account: z.number().optional().describe("Platform fee account for book_lightyear_distributions (default: auto-detect 'Muud finantskulud', standard 8610). Distinct from trade_fee_account."),
        tax_account: z.number().optional().describe("Withheld tax account for distributions"),
        investment_dimension_id: z.number().optional().describe("Optional dimension ID for the investment account"),
        broker_dimension_id: z.number().optional().describe("Optional dimension ID for the broker account"),
      },
      {
        note: "Lightyear booking needs live e-arveldaja journal creation and duplicate checks, so it cannot run before credentials are configured.",
      },
    );
  }
}
