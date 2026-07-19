import { readFileSync } from "fs";
import { resolve } from "path";
import { getProjectRoot } from "./paths.js";
import { renderPromptSurface, renderRuntimeFeatureSections } from "./prompt-surface.js";
import {
  PROMPT_REGISTRY,
  type PromptVariant,
  type WorkflowPromptSlug,
} from "./prompt-registry.js";
import type { ToolExposureConfig } from "./config.js";
import { renderVatMetadataTokens } from "./estonian-tax-rules.js";

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

export function buildWorkflowPromptSourceText(
  slug: WorkflowPromptSlug,
  args: unknown,
  variants?: readonly PromptVariant[],
  toolExposure?: ToolExposureConfig,
): string {
  const promptVariants = variants
    ?? PROMPT_REGISTRY.find(definition => definition.slug === slug)?.variants
    ?? [];
  const workflowBody = renderRuntimeFeatureSections(
    renderVatMetadataTokens(readWorkflowPromptSource(slug)),
    promptVariants.map(variant => ({
      name: variant.name,
      advertisedTools: variant.advertisedTools,
      enabled: variant.featurePredicate(toolExposure),
    })),
  );
  const trustedBody = `Canonical workflow source: ${workflowPromptSourcePath(slug)}

${workflowBody}
`;
  return renderPromptSurface(trustedBody, buildWorkflowRunData(args));
}
