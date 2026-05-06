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
    id: "accounting-inbox",
    prompt: "accounting-inbox",
    title: "Accounting Inbox",
    summary: "Start here when the user has a mixed workspace and wants the server to detect likely accounting inputs.",
    when_to_use: ["mixed folder", "not sure what to do first", "month of documents", "workspace triage"],
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
    id: "book-invoice",
    prompt: "book-invoice",
    title: "Book Purchase Invoice",
    summary: "Extract, validate, duplicate-check, book, upload, and confirm a purchase invoice from a PDF/image.",
    when_to_use: ["purchase invoice PDF", "supplier invoice", "book one invoice", "attach source document"],
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
    keywords: ["invoice", "pdf", "supplier", "purchase", "book", "receipt", "arve"],
  },
  {
    id: "import-camt",
    prompt: "import-camt",
    title: "Import CAMT Bank Statement",
    summary: "Parse ISO 20022 CAMT.053 bank statements, detect duplicates, and import bank transactions.",
    when_to_use: ["LHV/Swedbank/SEB/Coop/Luminor CAMT XML", "bank statement import", "bank transactions"],
    primary_tools: ["parse_camt053", "import_camt053", "reconcile_inter_account_transfers"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["possible duplicate", "unknown bank dimension", "inter-account transfer ambiguity"],
    },
    next_actions: [{
      tool: "import_camt053",
      args: { file_path: "<absolute CAMT.053 XML path>", accounts_dimensions_id: "<bank dimension id>", execute: false },
      why: "Imports should preview duplicate decisions before creating transactions.",
    }],
    keywords: ["camt", "bank statement", "xml", "lhv", "swedbank", "seb", "coop", "luminor", "transaction import"],
  },
  {
    id: "import-wise",
    prompt: "import-wise",
    title: "Import Wise Transactions",
    summary: "Import regular Wise transaction-history CSV exports with fee splitting and transfer safeguards.",
    when_to_use: ["Wise CSV", "transaction-history.csv", "Wise fees", "Wise bank account"],
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
    id: "reconcile-bank",
    prompt: "reconcile-bank",
    title: "Reconcile Bank Transactions",
    summary: "Match unconfirmed bank transactions to invoices, transfers, or accounts.",
    when_to_use: ["unmatched bank transactions", "match payments", "confirm transactions", "reconcile"],
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
    id: "receipt-batch",
    prompt: "receipt-batch",
    title: "Process Receipt Batch",
    summary: "OCR a folder of receipts/invoices, auto-book high-confidence items, and keep ambiguous ones in review.",
    when_to_use: ["folder of receipts", "many PDFs/images", "expense receipts", "batch booking"],
    primary_tools: ["process_receipt_batch", "classify_bank_transactions", "classify_unmatched_transactions", "apply_transaction_classifications"],
    risk_policy: {
      default_mode: "dry_run",
      interrupt_when: ["new supplier", "OCR uncertainty", "missing VAT/account treatment", "owner expense ambiguity"],
    },
    next_actions: [{
      tool: "process_receipt_batch",
      args: {
        folder_path: "<absolute receipt folder path>",
        accounts_dimensions_id: "<bank account dimension id used when matching bank transactions>",
        execution_mode: "dry_run",
      },
      why: "Batch receipt processing should separate high-confidence candidates from review items first.",
    }],
    keywords: ["receipt", "batch", "ocr", "expenses", "folder", "images"],
  },
  {
    id: "company-overview",
    prompt: "company-overview",
    title: "Company Overview",
    summary: "Build a financial dashboard using balance sheet, P&L, receivables, and payables.",
    when_to_use: ["financial overview", "dashboard", "company status", "P&L", "balance sheet"],
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
];

function normalizeGoal(goal: string | undefined): string {
  return (goal ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
}

function scoreWorkflow(workflow: WorkflowGuide, goal: string): number {
  if (!goal) return 0;
  return workflow.keywords.reduce((score, keyword) => {
    return goal.includes(keyword) ? score + Math.max(1, keyword.split(/\s+/).length) : score;
  }, 0);
}

function compactWorkflow(workflow: WorkflowGuide): Record<string, unknown> {
  return {
    id: workflow.id,
    prompt: workflow.prompt,
    title: workflow.title,
    summary: workflow.summary,
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
