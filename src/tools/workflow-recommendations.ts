import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readOnly } from "../annotations.js";
import { registerTool } from "../mcp-compat.js";
import { toolResponse } from "../tool-response.js";
import { buildWorkflowEnvelope } from "../workflow-response.js";

type RiskMode = "automatic" | "confirm_once" | "dry_run" | "accountant_review";

interface WorkflowGuide {
  id: string;
  prompt: string;
  title: string;
  summary: string;
  when_to_use: string[];
  required_inputs: string[];
  primary_tools: string[];
  risk_policy: {
    default_mode: RiskMode;
    interrupt_when: string[];
  };
  next_actions: Array<{
    tool: string;
    args: Record<string, unknown>;
    why: string;
  }>;
  keywords: string[];
}

const WORKFLOWS: WorkflowGuide[] = [
  {
    id: "setup-credentials",
    prompt: "setup-credentials",
    title: "Setup Credentials",
    summary: "Inspect credential setup, verify an apikey file, and save credentials to local or global .env storage.",
    when_to_use: ["first-time setup", "apikey import", "credentials not configured", "change stored credentials"],
    required_inputs: ["optional apikey file path", "optional local/global storage scope"],
    primary_tools: ["get_setup_instructions", "import_apikey_credentials", "list_stored_credentials", "remove_stored_credentials", "list_connections"],
    risk_policy: {
      default_mode: "confirm_once",
      interrupt_when: ["multiple candidate apikey files", "storage scope not chosen", "replacing or removing stored credentials"],
    },
    next_actions: [{
      tool: "get_setup_instructions",
      args: {},
      why: "Start by inspecting the active setup mode, credential search paths, and supported import options.",
    }],
    keywords: ["setup credentials", "set up credentials", "apikey", "api key", "credential", "credentials", "env", "import key", "configure api", "storage scope"],
  },
  {
    id: "setup-e-arveldaja",
    prompt: "setup-e-arveldaja",
    title: "Setup E-Arveldaja",
    summary: "Explain the supported e-arveldaja credential paths and restart requirement.",
    when_to_use: ["setup explanation", "how to configure API access", "server is in setup mode"],
    required_inputs: [],
    primary_tools: ["get_setup_instructions", "import_apikey_credentials"],
    risk_policy: {
      default_mode: "automatic",
      interrupt_when: ["credentials need importing", "multiple candidate files"],
    },
    next_actions: [{
      tool: "get_setup_instructions",
      args: {},
      why: "Read the current setup state and explain the exact credential paths for this machine.",
    }],
    keywords: ["setup e-arveldaja", "configure e-arveldaja", "setup mode", "how configure", "setup help", "restart mcp"],
  },
  {
    id: "accounting-inbox",
    prompt: "accounting-inbox",
    title: "Accounting Inbox",
    summary: "Start here when the user has a mixed workspace and wants the server to detect likely accounting inputs.",
    when_to_use: ["mixed folder", "not sure what to do first", "month of documents", "workspace triage"],
    required_inputs: ["optional workspace path"],
    primary_tools: ["accounting_inbox", "continue_accounting_workflow", "run_accounting_inbox_dry_runs", "resolve_accounting_review_item", "prepare_accounting_review_action"],
    risk_policy: {
      default_mode: "automatic",
      interrupt_when: ["missing bank dimension", "new accounting treatment", "duplicate cleanup", "accountant judgment"],
    },
    next_actions: [{
      tool: "accounting_inbox",
      args: { mode: "dry_run" },
      why: "Scans the workspace and automatically runs only safe discovery steps through the merged workflow entry point.",
    }],
    keywords: ["inbox", "workspace", "folder", "triage", "scan", "autopilot", "what can be done"],
  },
  {
    id: "resolve-accounting-review",
    prompt: "resolve-accounting-review",
    title: "Resolve Accounting Review",
    summary: "Turn one accounting review item into a recommendation, compliance basis, unresolved questions, and next workflow.",
    when_to_use: ["review item", "accountant review", "needs review", "compliance basis", "classification group"],
    required_inputs: ["review_item_json"],
    primary_tools: ["continue_accounting_workflow", "resolve_accounting_review_item"],
    risk_policy: {
      default_mode: "accountant_review",
      interrupt_when: ["unresolved accounting judgment", "missing source evidence"],
    },
    next_actions: [{
      tool: "continue_accounting_workflow",
      args: { action: "resolve_review", review_item_json: "<review item JSON>" },
      why: "Resolve the review item through the merged continuation tool before preparing any mutation.",
    }],
    keywords: ["resolve review", "review item", "accountant review", "needs accountant review", "compliance", "basis", "resolver input", "resolve accountant"],
  },
  {
    id: "prepare-accounting-review-action",
    prompt: "prepare-accounting-review-action",
    title: "Prepare Accounting Review Action",
    summary: "Prepare the concrete action for an already-resolved review item, such as duplicate cleanup or saving a booking rule.",
    when_to_use: ["prepare approved action", "cleanup duplicate", "save rule", "proposed action", "after review resolution"],
    required_inputs: ["review_item_json", "optional save_as_rule", "optional rule_override_json"],
    primary_tools: ["continue_accounting_workflow", "prepare_accounting_review_action"],
    risk_policy: {
      default_mode: "confirm_once",
      interrupt_when: ["approval missing", "rule fields incomplete", "destructive duplicate cleanup"],
    },
    next_actions: [{
      tool: "continue_accounting_workflow",
      args: { action: "prepare_action", review_item_json: "<review item JSON>" },
      why: "Prepare one explicit proposed action so the user can approve the exact tool call.",
    }],
    keywords: ["prepare review action", "prepare action", "approved review", "proposed action", "save rule", "cleanup duplicate", "duplicate cleanup"],
  },
  {
    id: "book-invoice",
    prompt: "book-invoice",
    title: "Book Purchase Invoice",
    summary: "Extract, validate, duplicate-check, book, upload, and confirm a purchase invoice from a PDF/image.",
    when_to_use: ["purchase invoice PDF", "supplier invoice", "book one invoice", "attach source document"],
    required_inputs: ["absolute invoice PDF/image path"],
    primary_tools: [
      "extract_pdf_invoice",
      "validate_invoice_data",
      "resolve_supplier",
      "detect_duplicate_purchase_invoice",
      "suggest_booking",
      "create_purchase_invoice_from_pdf",
      "confirm_purchase_invoice",
    ],
    risk_policy: {
      default_mode: "confirm_once",
      interrupt_when: ["OCR missing required fields", "new supplier", "duplicate risk", "new VAT/account treatment"],
    },
    next_actions: [{
      tool: "extract_pdf_invoice",
      args: { file_path: "<absolute invoice PDF/image path>" },
      why: "Start with extraction so the user can review source-derived fields before booking.",
    }],
    keywords: ["invoice", "pdf", "supplier invoice", "purchase invoice", "book invoice", "book one invoice", "arve", "attach document"],
  },
  {
    id: "receipt-batch",
    prompt: "receipt-batch",
    title: "Process Receipt Batch",
    summary: "OCR a folder of receipts/invoices, preview auto-bookable items, and leave confirmation behind explicit approval.",
    when_to_use: ["folder of receipts", "many PDFs/images", "expense receipts", "batch booking"],
    required_inputs: ["absolute receipt folder path", "bank account dimension id"],
    primary_tools: ["receipt_batch", "process_receipt_batch", "scan_receipt_folder", "classify_bank_transactions", "classify_unmatched_transactions", "apply_transaction_classifications"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["new supplier", "OCR uncertainty", "missing VAT/account treatment", "owner expense ambiguity"],
    },
    next_actions: [{
      tool: "receipt_batch",
      args: {
        mode: "dry_run",
        folder_path: "<absolute receipt folder path>",
        accounts_dimensions_id: "<bank account dimension id used when matching bank transactions>",
      },
      why: "Batch receipt processing should separate high-confidence candidates from review items through the merged receipt entry point first.",
    }],
    keywords: ["receipt batch", "folder of receipts", "receipts", "receipt", "batch", "ocr", "expenses", "folder", "images", "many invoices"],
  },
  {
    id: "import-camt",
    prompt: "import-camt",
    title: "Import CAMT Bank Statement",
    summary: "Parse ISO 20022 CAMT.053 bank statements, detect duplicates, and import bank transactions.",
    when_to_use: ["LHV/Swedbank/SEB/Coop/Luminor CAMT XML", "bank statement import", "bank transactions"],
    required_inputs: ["absolute CAMT.053 XML path", "bank account dimension id"],
    primary_tools: ["process_camt053", "parse_camt053", "import_camt053", "reconcile_inter_account_transfers"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["possible duplicate", "unknown bank dimension", "inter-account transfer ambiguity"],
    },
    next_actions: [{
      tool: "process_camt053",
      args: { mode: "dry_run", file_path: "<absolute CAMT.053 XML path>", accounts_dimensions_id: "<bank dimension id>" },
      why: "Imports should preview duplicate decisions through the merged CAMT entry point before creating transactions.",
    }],
    keywords: ["camt", "bank statement", "xml", "lhv", "swedbank", "seb", "coop", "luminor", "transaction import"],
  },
  {
    id: "import-wise",
    prompt: "import-wise",
    title: "Import Wise Transactions",
    summary: "Import regular Wise transaction-history CSV exports with fee splitting and transfer safeguards.",
    when_to_use: ["Wise CSV", "transaction-history.csv", "Wise fees", "Wise bank account"],
    required_inputs: ["absolute Wise transaction-history.csv path", "Wise bank account dimension id", "optional fee expense dimension id"],
    primary_tools: ["import_wise_transactions", "reconcile_inter_account_transfers"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["missing fee dimension", "ambiguous transfer target", "unsupported CSV export"],
    },
    next_actions: [{
      tool: "import_wise_transactions",
      args: { file_path: "<absolute Wise transaction-history.csv path>", accounts_dimensions_id: "<Wise bank dimension id>", execute: false },
      why: "Wise imports should show skipped rows, fees, and transfer handling before execution.",
    }],
    keywords: ["wise", "csv", "transaction-history", "fee", "jar", "transfer"],
  },
  {
    id: "classify-unmatched",
    prompt: "classify-unmatched",
    title: "Classify Unmatched Transactions",
    summary: "Group unmatched bank transactions, preview purchase-invoice bookings, and apply approved groups only.",
    when_to_use: ["unmatched expenses", "classify bank transactions", "auto-book bank rows", "expense groups"],
    required_inputs: ["bank account dimension id", "optional date range"],
    primary_tools: ["classify_bank_transactions", "classify_unmatched_transactions", "apply_transaction_classifications", "continue_accounting_workflow"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["review-only category", "missing currency rate", "new booking treatment", "failed group"],
    },
    next_actions: [{
      tool: "classify_bank_transactions",
      args: { mode: "classify", accounts_dimensions_id: "<bank dimension id>" },
      why: "Classify unmatched bank rows before previewing any invoice creation or transaction confirmation.",
    }],
    keywords: ["classify", "unmatched", "unmatched transactions", "bank rows", "auto book", "expense groups", "classification"],
  },
  {
    id: "reconcile-bank",
    prompt: "reconcile-bank",
    title: "Reconcile Bank Transactions",
    summary: "Match unconfirmed bank transactions to invoices, transfers, or accounts.",
    when_to_use: ["unmatched bank transactions", "match payments", "confirm transactions", "reconcile"],
    required_inputs: ["optional mode", "optional transaction id"],
    primary_tools: ["reconcile_bank_transactions", "reconcile_transactions", "auto_confirm_exact_matches", "reconcile_inter_account_transfers"],
    risk_policy: {
      default_mode: "confirm_once",
      interrupt_when: ["partial payment", "cross-currency match", "multiple candidates", "inter-account transfer"],
    },
    next_actions: [{
      tool: "reconcile_bank_transactions",
      args: { mode: "suggest", min_confidence: 30 },
      why: "Show plausible matches through the merged bank reconciliation entry point first, then confirm only high-confidence or approved matches.",
    }],
    keywords: ["reconcile", "match", "unconfirmed", "payment", "bank transaction", "partial", "confirm"],
  },
  {
    id: "month-end-close",
    prompt: "month-end-close",
    title: "Month-End Close",
    summary: "Run the month-end checklist, find blockers, missing documents, duplicates, and financial statements.",
    when_to_use: ["month-end close", "close a month", "period checklist", "missing documents", "trial balance"],
    required_inputs: ["month in YYYY-MM format"],
    primary_tools: ["month_end_close_checklist", "find_missing_documents", "detect_duplicate_purchase_invoice", "compute_trial_balance", "compute_profit_and_loss", "compute_balance_sheet"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["ledger blockers", "imbalanced statements", "duplicates", "missing source documents"],
    },
    next_actions: [{
      tool: "month_end_close_checklist",
      args: { month: "<YYYY-MM>" },
      why: "Start with the checklist to identify blockers before computing reports.",
    }],
    keywords: ["month end", "month-end", "close month", "close March", "closing", "checklist", "trial balance", "missing documents", "duplicates", "period close"],
  },
  {
    id: "new-supplier",
    prompt: "new-supplier",
    title: "Create New Supplier",
    summary: "Check for existing clients, resolve Estonian registry details when possible, and create a supplier after review.",
    when_to_use: ["new supplier", "registry code", "create supplier", "add vendor", "new vendor"],
    required_inputs: ["supplier name or 8-digit Estonian registry code"],
    primary_tools: ["find_client_by_code", "search_client", "resolve_supplier", "create_client"],
    risk_policy: {
      default_mode: "confirm_once",
      interrupt_when: ["possible existing supplier", "name-only lookup", "missing VAT or bank details"],
    },
    next_actions: [{
      tool: "search_client",
      args: { name: "<supplier name>" },
      why: "Check for existing supplier candidates before creating a duplicate.",
    }],
    keywords: ["new supplier", "create supplier", "add supplier", "vendor", "new vendor", "registry code", "äriregister", "business registry", "client record"],
  },
  {
    id: "company-overview",
    prompt: "company-overview",
    title: "Company Overview",
    summary: "Build a financial dashboard using balance sheet, P&L, receivables, and payables.",
    when_to_use: ["financial overview", "dashboard", "company status", "P&L", "balance sheet"],
    required_inputs: ["optional reporting date and period start"],
    primary_tools: ["compute_balance_sheet", "compute_profit_and_loss", "compute_receivables_aging", "compute_payables_aging"],
    risk_policy: {
      default_mode: "automatic",
      interrupt_when: ["unconfirmed transactions materially affect the period", "reporting period unclear"],
    },
    next_actions: [{
      tool: "compute_balance_sheet",
      args: { as_of_date: "<YYYY-MM-DD>" },
      why: "Start with the balance sheet for the requested reporting date.",
    }],
    keywords: ["overview", "dashboard", "report", "balance", "profit", "loss", "aging", "financial"],
  },
  {
    id: "lightyear-booking",
    prompt: "lightyear-booking",
    title: "Lightyear Booking",
    summary: "Book Lightyear trades and distributions from CSV exports after dry-run review.",
    when_to_use: ["Lightyear account statement", "investment trades", "dividends", "capital gains", "broker CSV"],
    required_inputs: ["Lightyear AccountStatement CSV", "investment account", "broker cash account", "optional capital gains CSV", "booking accounts"],
    primary_tools: ["parse_lightyear_statement", "parse_lightyear_capital_gains", "lightyear_portfolio_summary", "book_lightyear_trades", "book_lightyear_distributions"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["missing gain/loss account", "missing income account", "withheld tax without tax account", "FX pairing warning"],
    },
    next_actions: [{
      tool: "parse_lightyear_statement",
      args: { statement_path: "<absolute Lightyear AccountStatement CSV path>" },
      why: "Parse the statement first so trades, distributions, FX warnings, and skipped entries are visible before booking.",
    }],
    keywords: ["lightyear", "investment", "investments", "trades", "dividend", "dividends", "distribution", "capital gains", "broker", "portfolio", "csv"],
  },
];

function normalizeGoal(goal: string | undefined): string {
  return (goal ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
}

function scoreWorkflow(workflow: WorkflowGuide, goal: string): number {
  if (!goal) return 0;
  const searchable = [
    workflow.id,
    workflow.prompt,
    workflow.title,
    workflow.summary,
    ...workflow.when_to_use,
    ...workflow.required_inputs,
    ...workflow.primary_tools,
    ...workflow.keywords,
  ].join(" ").toLowerCase().replace(/[_-]+/g, " ");

  let score = 0;
  for (const keyword of workflow.keywords) {
    const normalizedKeyword = normalizeGoal(keyword);
    if (goal.includes(normalizedKeyword)) {
      score += Math.max(2, normalizedKeyword.split(/\s+/).length * 3);
    }
  }
  for (const token of goal.split(/\s+/).filter(token => token.length > 2)) {
    if (searchable.includes(token)) {
      score += 1;
    }
  }
  if (goal.includes(normalizeGoal(workflow.id)) || goal.includes(normalizeGoal(workflow.prompt))) {
    score += 10;
  }
  return score;
}

function compactWorkflow(workflow: WorkflowGuide): Record<string, unknown> {
  return {
    id: workflow.id,
    prompt: workflow.prompt,
    title: workflow.title,
    summary: workflow.summary,
    when_to_use: workflow.when_to_use,
    required_inputs: workflow.required_inputs,
    primary_tools: workflow.primary_tools,
    default_mode: workflow.risk_policy.default_mode,
  };
}

export function registerWorkflowRecommendationTools(server: McpServer): void {
  registerTool(server, "recommend_workflow",
    "Recommend the safest e-arveldaja workflow for a user goal. Use this when the user asks what to do next or when choosing among many tools.",
    {
      goal: z.string().optional().describe("Natural-language goal, such as 'book this invoice PDF' or 'import bank statement'. Omit to list common workflows."),
      risk_tolerance: z.enum(["fast", "balanced", "careful"]).optional().describe("How much friction to prefer. balanced keeps boring safe steps low-friction and interrupts on risk."),
    },
    { ...readOnly, title: "Recommend Workflow" },
    async ({ goal, risk_tolerance }) => {
      const normalizedGoal = normalizeGoal(goal);
      const ranked = WORKFLOWS
        .map(workflow => ({ workflow, score: scoreWorkflow(workflow, normalizedGoal) }))
        .sort((a, b) => b.score - a.score || a.workflow.id.localeCompare(b.workflow.id));

      if (!normalizedGoal || ranked[0]?.score === 0) {
        return toolResponse({
          action: "listed",
          entity: "workflow",
          message: "Listed common e-arveldaja workflows. Pass goal to get a single recommendation.",
          raw: null,
          extra: {
            risk_tolerance: risk_tolerance ?? "balanced",
            available_workflows: WORKFLOWS.map(compactWorkflow),
            workflow: buildWorkflowEnvelope({
              summary: "Listed common e-arveldaja workflows. Pass goal to get a single recommendation.",
              fallback_actions: [{
                kind: "answer_question",
                label: "Describe the accounting goal",
                question: "What accounting task should be handled next?",
                why: "A concrete goal lets the server choose one workflow and its first safe action.",
                approval_required: false,
              }],
            }),
          },
        });
      }

      const best = ranked[0]!.workflow;
      return toolResponse({
        action: "recommended",
        entity: "workflow",
        id: best.id,
        message: `Recommended ${best.title}: ${best.summary}`,
        raw: best,
        next_actions: best.next_actions,
        extra: {
          risk_tolerance: risk_tolerance ?? "balanced",
          recommended_workflow: compactWorkflow(best),
          risk_policy: best.risk_policy,
          alternatives: ranked.slice(1, 4).map(entry => compactWorkflow(entry.workflow)),
          workflow: buildWorkflowEnvelope({
            summary: `Recommended ${best.title}: ${best.summary}`,
            recommended_step: best.next_actions[0],
          }),
        },
      });
    }
  );
}
