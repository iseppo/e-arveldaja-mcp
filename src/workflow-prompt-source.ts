import { readFileSync } from "fs";
import { resolve } from "path";
import { getProjectRoot } from "./paths.js";

export const WORKFLOW_PROMPT_SOURCE_BY_PROMPT = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeUndefinedValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedValues);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, removeUndefinedValues(entryValue)]),
  );
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

function formatRunHints(args: unknown): string {
  if (!isRecord(args)) return "";

  const hints: string[] = [];
  if (typeof args.month === "string") {
    const dateTo = lastDayOfMonth(args.month);
    if (dateTo) {
      hints.push(`date_from: "${args.month}-01"`);
      hints.push(`date_to: "${dateTo}"`);
      hints.push(`fiscal_year_date_from: "${args.month.slice(0, 4)}-01-01"`);
    }
  }
  if (args.mode === "transaction" && typeof args.transaction_id === "number") {
    hints.push(`Requested transaction ID ${args.transaction_id}.`);
  } else if (args.mode === "transaction") {
    hints.push(`mode="transaction" requires transaction_id; stop and ask for it before running reconciliation.`);
  }
  if (typeof args.identifier === "string" && !/^\d{8}$/.test(args.identifier.trim())) {
    hints.push(`Use \`search_client\` with name: "${args.identifier}" before creating anything.`);
  }

  return hints.length > 0 ? `\nRun-specific derived values:\n${hints.map((hint) => `- ${hint}`).join("\n")}\n` : "";
}

function formatRunArguments(args: unknown): string {
  const cleaned = removeUndefinedValues(args);
  if (!isRecord(cleaned) || Object.keys(cleaned).length === 0) {
    return "None.";
  }

  return `\`\`\`json\n${JSON.stringify(cleaned, null, 2)}\n\`\`\``;
}

export function buildWorkflowPromptSourceText(slug: WorkflowPromptSlug, args: unknown): string {
  return `Use this workflow source as an internal runbook.
Follow the tool order, safety rails, and approval gates below, but keep the user-facing response focused on the accounting task. Do not dump raw tool fields or compatibility-tool details to the user unless they are needed for a concrete choice.

User-facing response contract:
- Done: work already completed automatically.
- Needs approval: show the exact accounting impact, source documents, duplicate risk, and next tool call before any mutation.
- Needs one decision: ask one recommendation-first question with the default first.
- Needs accountant review: present the recommendation, compliance basis, unresolved questions, and the suggested next workflow.
- Next recommended action: end with one concrete next step whenever the workflow is not finished.

Run-specific arguments:
${formatRunArguments(args)}
${formatRunHints(args)}

---

Canonical workflow source: ${workflowPromptSourcePath(slug)}

${readWorkflowPromptSource(slug)}
`;
}

export function replaceWithWorkflowPromptSourceText(text: string, slug: WorkflowPromptSlug, args: unknown): string {
  if (text.startsWith("The server is currently running in setup mode")) {
    return text;
  }

  return buildWorkflowPromptSourceText(slug, args);
}

export function replaceWithWorkflowPromptSourceResult<T extends {
  messages: Array<{ content: { text: string } }>;
}>(result: T, slug: WorkflowPromptSlug, args: unknown): T {
  return {
    ...result,
    messages: result.messages.map((message) => ({
      ...message,
      content: {
        ...message.content,
        text: replaceWithWorkflowPromptSourceText(message.content.text, slug, args),
      },
    })),
  };
}
