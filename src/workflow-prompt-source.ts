import { readFileSync } from "fs";
import { resolve } from "path";
import { getProjectRoot } from "./paths.js";
import { renderPromptSurface } from "./prompt-surface.js";

export const WORKFLOW_PROMPT_SOURCE_BY_PROMPT = {
  "vat-registration-threshold": "vat-registration-threshold",
  "setup-credentials": "setup-credentials",
  "setup-e-arveldaja": "setup-e-arveldaja",
  "accounting-inbox": "accounting-inbox",
  "resolve-accounting-review": "resolve-accounting-review",
  "prepare-accounting-review-action": "prepare-accounting-review-action",
  "book-invoice": "book-invoice",
  "receipt-batch": "receipt-batch",
  "import-camt": "import-camt",
  "import-wise": "import-wise",
  "classify-unmatched": "classify-unmatched",
  "reconcile-bank": "reconcile-bank",
  "month-end-close": "month-end",
  "new-supplier": "new-supplier",
  "company-overview": "company-overview",
  "lightyear-booking": "lightyear-booking",
} as const;

export type WorkflowPromptName = keyof typeof WORKFLOW_PROMPT_SOURCE_BY_PROMPT;
export type WorkflowPromptSlug = typeof WORKFLOW_PROMPT_SOURCE_BY_PROMPT[WorkflowPromptName];

export function workflowPromptSourcePath(slug: WorkflowPromptSlug): string {
  return `workflows/${slug}.md`;
}

export function readWorkflowPromptSource(slug: WorkflowPromptSlug): string {
  return readFileSync(resolve(getProjectRoot(), workflowPromptSourcePath(slug)), "utf8").trimEnd();
}

function requirePlainRecord(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("Prompt surface data must be canonical JSON");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Prompt surface data must be canonical JSON");
  }
}

function ownDataValue(args: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    throw new Error("Prompt surface data must be canonical JSON");
  }
}

function lastDayOfMonth(month: string): string | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return undefined;

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12) {
    return undefined;
  }

  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function deriveWorkflowRunData(args: Record<string, unknown>): Record<string, unknown> {
  const derived: Record<string, unknown> = {};
  const month = ownDataValue(args, "month");
  const mode = ownDataValue(args, "mode");
  const transactionId = ownDataValue(args, "transaction_id");
  const identifier = ownDataValue(args, "identifier");

  if (typeof month === "string") {
    const dateTo = lastDayOfMonth(month);
    if (dateTo) {
      derived.date_from = `${month}-01`;
      derived.date_to = dateTo;
      derived.fiscal_year_date_from = `${month.slice(0, 4)}-01-01`;
    }
  }
  if (mode === "transaction" && typeof transactionId === "number") {
    derived.requested_transaction_id = transactionId;
  } else if (mode === "transaction") {
    derived.required_input = {
      field: "transaction_id",
      reason: "required_when_mode_is_transaction",
    };
  }
  if (typeof identifier === "string" && !/^\d{8}$/.test(identifier.trim())) {
    derived.supplier_search = {
      name: identifier,
      tool: "search_client",
    };
  }
  return derived;
}

export function buildWorkflowRunData(args: unknown): {
  arguments: Record<string, unknown>;
  derived: Record<string, unknown>;
} {
  const runArguments = requirePlainRecord(args);
  return {
    arguments: runArguments,
    derived: deriveWorkflowRunData(runArguments),
  };
}

export function buildWorkflowPromptSourceText(slug: WorkflowPromptSlug, args: unknown): string {
  const trustedBody = `Canonical workflow source: ${workflowPromptSourcePath(slug)}

${readWorkflowPromptSource(slug)}
`;
  return renderPromptSurface(trustedBody, buildWorkflowRunData(args));
}
