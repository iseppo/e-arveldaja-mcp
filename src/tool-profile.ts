import type { ToolExposureConfig } from "./config.js";
import { toolMeta } from "./tool-catalog.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type ToolProfile = "guided" | "guided-sales" | "standard" | "full" | "custom";
export const GUIDED_TOOL_NAMES = Object.freeze(`recommend_workflow accounting_inbox continue_accounting_workflow receipt_batch process_camt053 import_wise_transactions reconcile_bank_transactions reconcile_inter_account_transfers classify_bank_transactions cleanup_camt_possible_duplicate save_auto_booking_rule compute_trial_balance list_connections switch_connection get_setup_instructions get_execution_plan_page get_operation_result_page get_session_log`.split(" "));
export const SETUP_PROFILE_CHOICES = Object.freeze([
  Object.freeze({ label: "Daily bookkeeping", profile: "guided" as const, enableLightyear: false }),
  Object.freeze({ label: "Daily bookkeeping plus sales invoices", profile: "guided-sales" as const, enableLightyear: false }),
  Object.freeze({ label: "Bookkeeping plus investments", profile: "standard" as const, enableLightyear: true }),
  Object.freeze({ label: "Full advanced toolset", profile: "full" as const, enableLightyear: true }),
]);
const GUIDED = new Set(GUIDED_TOOL_NAMES);
const GUIDED_SALES = new Set([...GUIDED_TOOL_NAMES, "list_sale_invoices", "get_sale_invoice"]);
export const LEGACY_TOOL_EXPOSURE_ENV_KEYS = ["EARVELDAJA_DISABLE_LIGHTYEAR", "EARVELDAJA_EXPOSE_GRANULAR_TOOLS", "EARVELDAJA_EXPOSE_SETUP_TOOLS", "EARVELDAJA_DISABLE_TAX_TOOLS", "EARVELDAJA_DISABLE_REFERENCE_ADMIN", "EARVELDAJA_DISABLE_ANNUAL_REPORT", "EARVELDAJA_DISABLE_SALES", "EARVELDAJA_DISABLE_PRODUCTS"] as const;
const VALID = new Set<ToolProfile>(["guided", "guided-sales", "standard", "full", "custom"]);
const PROFILE_STORAGE = new AsyncLocalStorage<ToolProfile>();

export function runWithToolProfile<T>(profile: ToolProfile, callback: () => T): T {
  return PROFILE_STORAGE.run(profile, callback);
}

export function currentToolProfile(): ToolProfile {
  return PROFILE_STORAGE.getStore() ?? "standard";
}

export function parseToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  if (LEGACY_TOOL_EXPOSURE_ENV_KEYS.some((key) => env[key] !== undefined)) return "custom";
  const raw = env.EARVELDAJA_PROFILE?.trim().toLowerCase();
  if (!raw) return "standard";
  if (!VALID.has(raw as ToolProfile) || raw === "custom") throw new Error(`Invalid EARVELDAJA_PROFILE="${raw}". Must be guided, guided-sales, standard, or full.`);
  return raw as ToolProfile;
}

export function exposureForProfile(profile: ToolProfile, legacy: ToolExposureConfig): ToolExposureConfig {
  if (profile === "full") return { enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true };
  return legacy;
}

export function isToolVisibleForProfile(name: string, profile: ToolProfile): boolean {
  toolMeta(name);
  if (profile === "guided") return GUIDED.has(name);
  if (profile === "guided-sales") return GUIDED_SALES.has(name);
  return true;
}

type Action = { tool: string; args?: Record<string, unknown>; approval_required?: boolean; [key: string]: unknown };
function mergedToolArgs(mode: string, args: Record<string, unknown>): Record<string, unknown> {
  const { execute: _execute, execution_mode: _executionMode, ...rest } = args;
  return { mode, ...rest };
}
export function remapHiddenGranularTool(tool: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } | undefined {
  switch (tool) {
    case "reconcile_transactions": return { tool: "reconcile_bank_transactions", args: mergedToolArgs("suggest", args) };
    case "auto_confirm_exact_matches": return { tool: "reconcile_bank_transactions", args: mergedToolArgs(args.execute === true ? "execute_auto_confirm" : "dry_run_auto_confirm", args) };
    case "parse_camt053": return { tool: "process_camt053", args: mergedToolArgs("parse", args) };
    case "import_camt053": return { tool: "process_camt053", args: mergedToolArgs(args.execute === true ? "execute" : "dry_run", args) };
    case "scan_receipt_folder": return { tool: "receipt_batch", args: mergedToolArgs("scan", args) };
    case "process_receipt_batch": return { tool: "receipt_batch", args: mergedToolArgs(args.execution_mode === "create" ? "create" : args.execution_mode === "create_and_confirm" ? "create_and_confirm" : "dry_run", args) };
    case "classify_unmatched_transactions": return { tool: "classify_bank_transactions", args: mergedToolArgs("classify", args) };
    case "apply_transaction_classifications": return { tool: "classify_bank_transactions", args: mergedToolArgs(args.execute === true ? "execute_apply" : "dry_run_apply", args) };
    case "resolve_accounting_review_item": return { tool: "continue_accounting_workflow", args: mergedToolArgs("resolve_review", args) };
    case "prepare_accounting_review_action": return { tool: "continue_accounting_workflow", args: mergedToolArgs("prepare_action", args) };
    default: return undefined;
  }
}
export function projectActionForProfile(action: Action, profile: ToolProfile): any {
  if (profile !== "guided" && profile !== "guided-sales") return action;
  const args = action.args ?? {};
  const remapped = remapHiddenGranularTool(action.tool, args);
  const projected = remapped ? { ...action, tool: remapped.tool, args: remapped.args } : action;
  let visible = false;
  try { visible = isToolVisibleForProfile(projected.tool, profile); } catch { visible = false; }
  if (visible) return projected;
  return {
    status: "needs_review",
    blocker: {
      code: "advanced_action_unavailable_in_profile",
      message: "This accounting action is unavailable in the selected guided profile. Switch to standard or full and run a fresh preview; a prior proposal or handle is not approval.",
    },
    // Preserve the complete already-sanitized caller-facing action as a
    // non-executable proposal. The only executable next action remains setup.
    proposal: { ...action, args },
    next_actions: [{ tool: "get_setup_instructions", args: {}, approval_required: false }],
  };
}

export function projectActionForCurrentProfile(action: Action): any {
  return projectActionForProfile(action, currentToolProfile());
}
