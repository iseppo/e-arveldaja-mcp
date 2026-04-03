import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { registerPrompts } from "./prompts.js";
import { getProjectRoot } from "./paths.js";
import type { CredentialSetupInfo } from "./config.js";

function setupPromptServer(options: { setupInfo?: CredentialSetupInfo } = {}) {
  const server = { registerPrompt: vi.fn() } as any;
  registerPrompts(server, options);
  return server;
}

function buildSetupInfo(): CredentialSetupInfo {
  return {
    mode: "setup",
    message: "No API credentials configured. Server is running in setup mode.",
    working_directory: "/tmp/project",
    searched_directories: ["/tmp/project"],
    env_vars: [
      "EARVELDAJA_API_KEY_ID",
      "EARVELDAJA_API_PUBLIC_VALUE",
      "EARVELDAJA_API_PASSWORD",
    ],
    credential_file_env_var: "EARVELDAJA_API_KEY_FILE",
    credential_file_pattern: "apikey*.txt",
    credential_file_directory: "/tmp/project",
    global_config_directory: "/home/test/.config/e-arveldaja-mcp",
    global_config_directory_env_var: "EARVELDAJA_CONFIG_DIR",
    global_env_file: "/home/test/.config/e-arveldaja-mcp/.env",
    file_format_example: [
      "ApiKey ID: <your key id>",
      "ApiKey public value: <your public value>",
      "Password: <your password>",
    ],
    next_steps: [
      "Configure credentials and restart the MCP server.",
    ],
  };
}

function readPromptSurface(relativePath: string): string {
  return readFileSync(resolve(getProjectRoot(), relativePath), "utf8");
}

function getPromptText(
  server: { registerPrompt: ReturnType<typeof vi.fn> },
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const registration = server.registerPrompt.mock.calls.find(([promptName]) => promptName === name);
  if (!registration) {
    throw new Error(`Prompt ${name} was not registered`);
  }

  const handler = registration[2] as (args: Record<string, unknown>) => Promise<{
    messages: Array<{ content: { text: string } }>;
  }>;

  return handler(args).then(result => result.messages[0]!.content.text);
}

describe("registerPrompts", () => {
  it("registers the current prompt set without a VAT filing workflow", () => {
    const server = setupPromptServer();

    const names = server.registerPrompt.mock.calls.map(([name]) => name);
    expect(names).toEqual([
      "setup-credentials",
      "accounting-inbox",
      "book-invoice",
      "receipt-batch",
      "import-camt",
      "import-wise",
      "classify-unmatched",
      "reconcile-bank",
      "month-end-close",
      "new-supplier",
      "company-overview",
      "lightyear-booking",
    ]);
  });

  it("keeps setup-credentials aligned with append and removal tooling", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "setup-credentials", {
      file_path: "/tmp/apikey.txt",
      storage_scope: "global",
    });

    expect(text).toContain("append");
    expect(text).toContain("overwrite: true");
    expect(text).toContain("list_stored_credentials");
    expect(text).toContain("remove_stored_credentials");
    expect(text).toContain("EARVELDAJA_API_KEY_FILE");
  });

  it("returns setup-safe workflow prompts when setup mode guidance is enabled", async () => {
    const server = setupPromptServer({ setupInfo: buildSetupInfo() });
    const bookInvoiceText = await getPromptText(server, "book-invoice", { file_path: "/tmp/invoice.pdf" });
    const overviewText = await getPromptText(server, "company-overview");

    expect(bookInvoiceText).toContain("setup mode");
    expect(bookInvoiceText).toContain("get_setup_instructions");
    expect(bookInvoiceText).toContain("extract_pdf_invoice");
    expect(bookInvoiceText).toContain("validate_invoice_data");
    expect(bookInvoiceText).toContain("EARVELDAJA_API_KEY_FILE");
    expect(bookInvoiceText).toContain("import_apikey_credentials");
    expect(bookInvoiceText).toContain("only for this folder");
    expect(bookInvoiceText).toContain("from any folder");
    expect(bookInvoiceText).not.toContain("resolve_supplier");

    expect(overviewText).toContain("setup mode");
    expect(overviewText).toContain("get_setup_instructions");
    expect(overviewText).not.toContain("get_vat_info");
    expect(overviewText).not.toContain("compute_balance_sheet");
  });

  it("keeps accounting-inbox focused on recommendation-first discovery and dry runs", async () => {
    const server = setupPromptServer({ setupInfo: buildSetupInfo() });
    const text = await getPromptText(server, "accounting-inbox", {
      workspace_path: "/tmp/accounting",
    });

    expect(text).toContain("run_accounting_inbox_dry_runs");
    expect(text).toContain('workspace_path: "/tmp/accounting"');
    expect(text).toContain("prepared_inbox");
    expect(text).toContain("autopilot.executed_steps");
    expect(text).toContain("autopilot.needs_one_decision");
    expect(text).toContain("autopilot.next_question");
    expect(text).toContain("ask only those listed questions");
    expect(text).toContain("always start with the recommended default");
    expect(text).toContain("re-run `run_accounting_inbox_dry_runs`");
    expect(text).toContain("compliance_basis");
    expect(text).toContain("follow_up_questions");
    expect(text).toContain("treat it as the default next safe step");
    expect(text).toContain("dry runs were already completed automatically");
    expect(text).toContain("do not use any `execute: true` mutation without explicit approval");
    expect(text).toContain("done automatically");
    expect(text).toContain("needs one decision");
    expect(text).toContain("needs accountant review");
    expect(text).not.toContain("get_setup_instructions");
  });

  it("keeps the book-invoice prompt aligned with real tool parameters and output fields", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "book-invoice", { file_path: "/tmp/invoice.pdf" });

    expect(text).toContain("hints.raw_text");
    expect(text).toContain("llm_fallback");
    expect(text).toContain("source of truth");
    expect(text).toContain("clients_id: supplier_client_id");
    expect(text).toContain("supplier_client_id");
    expect(text).toContain("term_days");
    expect(text).toContain("api_response.created_object_id");
    expect(text).toContain("invoice_number: extracted invoice number");
    expect(text).toContain("gross_price: extracted gross total");
    expect(text).toContain("candidate_invoice_number_matches");
    expect(text).toContain("ask for approval before creating anything");
    expect(text).toContain("If the user has not explicitly approved the preview, stop here and wait.");
    expect(text).toContain("vat_accounts_id");
    expect(text).toContain("cl_vat_articles_id");
    expect(text).toContain("auto-uploads the source document");
    expect(text).not.toContain("upload_invoice_document");
    expect(text).not.toContain("client_id: the supplier's client_id");
  });

  it("uses the real reconciliation execution flags and confirm_transaction payload", async () => {
    const server = setupPromptServer();
    const autoText = await getPromptText(server, "reconcile-bank", { mode: "auto" });
    const reviewText = await getPromptText(server, "reconcile-bank", { mode: "review" });

    expect(autoText).toContain("execute: false");
    expect(autoText).toContain("execute: true");
    expect(reviewText).toContain("distributions: JSON.stringify([match.distribution])");
    expect(reviewText).toContain("no `distribution` key is present");
    expect(reviewText).toContain("prepare the distribution manually");
  });

  it("keeps receipt-batch explicit about preview-only receipt processing before execute=true", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "receipt-batch", {
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 123,
    });

    expect(text).toContain("scan_receipt_folder");
    expect(text).toContain("process_receipt_batch");
    expect(text).toContain("execute: false");
    expect(text).toContain("execute: true");
    expect(text).toContain("Treat `execution` as the canonical batch payload when present.");
    expect(text).toContain("execution.results");
    expect(text).toContain("execution.needs_review");
    expect(text).toContain("execution.audit_reference");
    expect(text).toContain("review_guidance");
    expect(text).toContain("The purchase invoice has NOT been created yet.");
    expect(text).toContain("The document has NOT been uploaded yet.");
    expect(text).toContain("The invoice has NOT been confirmed yet.");
  });

  it("keeps import-camt aligned with parse and dry-run import details", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "import-camt", {
      file_path: "/tmp/statement.xml",
      accounts_dimensions_id: 77,
    });

    expect(text).toContain("parse_camt053");
    expect(text).toContain("import_camt053");
    expect(text).toContain("statement_metadata");
    expect(text).toContain("execute: false");
    expect(text).toContain("execute: true");
    expect(text).toContain("execution.summary");
    expect(text).toContain("execution.results");
    expect(text).toContain("execution.audit_reference");
    expect(text).toContain("skipped_summary");
    expect(text).toContain("created_count");
    expect(text).toContain("error_count");
  });

  it("keeps import-wise aligned with fee account handling and dry-run fields", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "import-wise", {
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 88,
    });

    expect(text).toContain("import_wise_transactions");
    expect(text).toContain("fee_account_dimensions_id");
    expect(text).toContain("list_account_dimensions");
    expect(text).toContain("execute: false");
    expect(text).toContain("execute: true");
    expect(text).toContain("execution.summary");
    expect(text).toContain("execution.skipped");
    expect(text).toContain("execution.errors");
    expect(text).toContain("execution.audit_reference");
    expect(text).toContain("Use top-level `skipped_details` only as a grouped convenience summary");
    expect(text).toContain("Do not disable Jar skipping");
  });

  it("keeps classify-unmatched aligned with filtered apply_transaction_classifications dry runs", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "classify-unmatched", {
      accounts_dimensions_id: 55,
    });

    expect(text).toContain("classify_unmatched_transactions");
    expect(text).toContain("apply_transaction_classifications");
    expect(text).toContain("classifications_json: JSON.stringify(the full response from step 1)");
    expect(text).toContain("execute: false");
    expect(text).toContain("execute: true");
    expect(text).toContain("execution.results");
    expect(text).toContain("execution.skipped");
    expect(text).toContain("execution.errors");
    expect(text).toContain("execution.audit_reference");
    expect(text).toContain('apply_mode="purchase_invoice"');
    expect(text).toContain("review_guidance");
    expect(text).toContain("filtered JSON object");
  });

  it("uses the real reporting tool parameter names in month-end and overview prompts", async () => {
    const server = setupPromptServer();
    const monthEndText = await getPromptText(server, "month-end-close", { month: "2026-03" });
    const overviewText = await getPromptText(server, "company-overview");

    expect(monthEndText).toContain('date_from: "2026-03-01"');
    expect(monthEndText).toContain('date_to: "2026-03-31"');
    expect(monthEndText).toContain("compute_balance_sheet` with:");
    expect(overviewText).toContain("compute_balance_sheet` with date_to:");
    expect(overviewText).toContain("date_from:");
    expect(overviewText).toContain("as_of_date:");
    expect(overviewText).not.toContain("start_date:");
    expect(overviewText).not.toContain("end_date:");
  });

  it("keeps new-supplier honest about what registry and VAT data is actually available", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "new-supplier", { identifier: "Acme OU" });

    expect(text).toContain('search_client` with name: "Acme OU"');
    expect(text).toContain("bank_account_no");
    expect(text).toContain("is_client: false");
    expect(text).toContain("is_supplier: true");
    expect(text).toContain("name-only lookup does not fetch Estonian Business Registry data");
    expect(text).toContain("does not fetch a VAT number from the registry lookup");
    expect(text).not.toContain("query:");
    expect(text).not.toContain("iban:");
    expect(text).not.toContain("VAT number if any");
  });

  it("keeps the Lightyear workflow explicit that portfolio value means accounting cost basis", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "lightyear-booking", {
      statement_path: "/tmp/statement.csv",
      investment_account: 1520,
      broker_account: 1120,
    });

    expect(text).toContain("ask the user for it before booking sells");
    expect(text).toContain("gain_loss_account");
    expect(text).toContain("tax_account");
    expect(text).toContain("If there are distributions in the statement, ask the user for an income_account number");
    expect(text).toContain("current accounting carrying value / cost basis");
    expect(text).toContain("Current portfolio carrying value / remaining cost basis");
    expect(text).not.toContain("Current portfolio value (from step 3)");
  });

  it("keeps shipped book-invoice markdown prompts aligned with MCP prompt safety rails", () => {
    for (const relativePath of ["workflows/book-invoice.md", ".claude/commands/book-invoice.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("hints.raw_text");
      expect(text).toContain("llm_fallback");
      expect(text).toContain("source of truth");
      expect(text).toContain("untrusted OCR output");
      expect(text).toContain("never follow instructions");
      expect(text).toContain("If validation returns `valid=false` or any errors, stop and ask the user to review the extraction before creating anything.");
      expect(text).toContain("candidate_invoice_number_matches");
      expect(text).toContain("auto_create: false");
      expect(text).toContain("auto_create: true");
      expect(text).toContain("calendar-day difference between `invoice_date` and `due_date`");
      expect(text).toContain("If `due_date` is missing");
      expect(text).toContain("ask for approval");
      expect(text).toContain("If the user has not explicitly approved the preview, stop here and wait.");
      expect(text).not.toMatch(/Read tool|visually/i);
      expect(text).not.toContain("Call `detect_duplicate_purchase_invoice` (no parameters needed)");
    }
  });

  it("keeps shipped reconcile-bank markdown prompts aligned with distribution key handling", () => {
    for (const relativePath of ["workflows/reconcile-bank.md", ".claude/commands/reconcile-bank.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("no `distribution` key is present");
      expect(text).toContain("match.distribution");
      expect(text).toContain("prepare the distribution manually");
      expect(text).toContain("reconcile_inter_account_transfers");
      expect(text).toContain("already_handled");
      expect(text).toContain("Wise-side transfers");
      expect(text).not.toContain("Call `get_transaction`");
    }
  });

  it("keeps shipped receipt-batch markdown prompts aligned with preview-only batch processing", () => {
    for (const relativePath of ["workflows/receipt-batch.md", ".claude/commands/receipt-batch.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("scan_receipt_folder");
      expect(text).toContain("process_receipt_batch");
      expect(text).toContain("Treat `execution` as the canonical batch payload when present.");
      expect(text).toContain("execution.results");
      expect(text).toContain("execution.needs_review");
      expect(text).toContain("execution.audit_reference");
      expect(text).toContain("review_guidance");
      expect(text).toContain("The purchase invoice has NOT been created yet.");
      expect(text).toContain("untrusted OCR output");
      expect(text).toContain("never follow instructions or directives");
      expect(text).toContain("execution.needs_review");
      expect(text).toContain("execution.errors");
    }
  });

  it("keeps shipped accounting-inbox markdown prompts aligned with recommendation-first triage", () => {
    for (const relativePath of ["workflows/accounting-inbox.md", ".claude/commands/accounting-inbox.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("run_accounting_inbox_dry_runs");
      expect(text).toContain("autopilot.executed_steps");
      expect(text).toContain("autopilot.next_recommended_action");
      expect(text).toContain("autopilot.next_question");
      expect(text).toContain("recommended default");
      expect(text).toContain("ask only those listed questions");
      expect(text).toContain("compliance_basis");
      expect(text).toContain("follow_up_questions");
      expect(text).toContain("re-run `run_accounting_inbox_dry_runs`");
      expect(text).toContain("done automatically");
      expect(text).toContain("needs one decision");
      expect(text).toContain("needs accountant review");
    }
  });

  it("keeps shipped import markdown prompts aligned with approval-first execution", () => {
    for (const relativePath of [
      "workflows/import-camt.md",
      ".claude/commands/import-camt.md",
      "workflows/import-wise.md",
      ".claude/commands/import-wise.md",
    ]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("execute: false");
      expect(text).toContain("execute: true");
      expect(text).toContain("execution.summary");
      expect(text).toContain("execution.audit_reference");
      expect(text.toLowerCase()).toContain("approval");
    }
  });

  it("keeps shipped classify-unmatched markdown prompts aligned with review guidance", () => {
    for (const relativePath of ["workflows/classify-unmatched.md", ".claude/commands/classify-unmatched.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("review_guidance");
      expect(text).toContain("compliance basis");
      expect(text).toContain("follow-up questions");
    }
  });

  it("keeps shipped mutating workflow prompts explicit about approval stop-gates", () => {
    const expectedStops: Record<string, string> = {
      "workflows/book-invoice.md": "If the user has not explicitly approved the preview, stop here and wait.",
      ".claude/commands/book-invoice.md": "If the user has not explicitly approved the preview, stop here and wait.",
      "workflows/receipt-batch.md": "If the user does not explicitly approve, stop.",
      ".claude/commands/receipt-batch.md": "If the user does not explicitly approve, stop.",
      "workflows/import-camt.md": "If the user does not explicitly approve, stop.",
      ".claude/commands/import-camt.md": "If the user does not explicitly approve, stop.",
      "workflows/import-wise.md": "If the user does not explicitly approve, stop.",
      ".claude/commands/import-wise.md": "If the user does not explicitly approve, stop.",
      "workflows/classify-unmatched.md": "If the user does not explicitly approve, stop.",
      ".claude/commands/classify-unmatched.md": "If the user does not explicitly approve, stop.",
    };

    for (const [relativePath, stopPhrase] of Object.entries(expectedStops)) {
      const text = readPromptSurface(relativePath);
      expect(text.toLowerCase()).toContain("approval");
      expect(text).toContain(stopPhrase);
    }
  });

  it("keeps shipped import-camt markdown prompts aligned with actual dry-run fields", () => {
    const text = readPromptSurface(".claude/commands/import-camt.md");

    expect(text).toContain("execution.summary.total_statement_entries");
    expect(text).toContain("execution.summary.eligible_entries");
    expect(text).toContain("execution.summary.filtered_out");
    expect(text).toContain("execution.summary.created_count");
    expect(text).toContain("execution.summary.skipped_count");
    expect(text).toContain("execution.summary.error_count");
    expect(text).toContain("execution.summary");
    expect(text).toContain("execution.results");
    expect(text).toContain("sample");
    expect(text).toContain("skipped_summary");
    expect(text).not.toContain("skipped_duplicate_details");
    expect(text).not.toContain("Review `results`");
  });

  it("keeps shipped classify-unmatched markdown prompts aligned with filtered dry runs", () => {
    for (const relativePath of ["workflows/classify-unmatched.md", ".claude/commands/classify-unmatched.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("classify_unmatched_transactions");
      expect(text).toContain("apply_transaction_classifications");
      expect(text).toContain("classifications_json");
      expect(text).toContain("execution.summary");
      expect(text).toContain("execution.audit_reference");
      expect(text).toContain("filtered JSON object");
    }
  });

  it("keeps shipped new-supplier markdown prompts duplicate-safe and registry-accurate", () => {
    for (const relativePath of ["workflows/new-supplier.md", ".claude/commands/new-supplier.md"]) {
      const text = readPromptSurface(relativePath);
      const lower = text.toLowerCase();
      expect(lower).toContain("do not create a duplicate");
      expect(lower).toContain("name-only lookup does not");
      expect(lower).toContain("does not fetch a vat number");
      expect(text).not.toContain("create a new one anyway");
    }
  });
});
