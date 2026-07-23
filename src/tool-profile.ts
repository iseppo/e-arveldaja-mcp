import type { ToolExposureConfig } from "./config.js";
import { toolMeta } from "./tool-catalog.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type ToolProfile = "guided" | "guided-sales" | "standard" | "full" | "custom";
export const GUIDED_TOOL_NAMES = Object.freeze(`recommend_workflow accounting_inbox continue_accounting_workflow receipt_batch process_accounting_document process_bank_input reconcile_bank_transactions reconcile_inter_account_transfers classify_bank_transactions cleanup_camt_possible_duplicate save_auto_booking_rule compute_trial_balance list_connections switch_connection get_setup_instructions get_execution_plan_page get_operation_result_page get_session_log`.split(" "));
export const SETUP_PROFILE_CHOICES = Object.freeze([
  Object.freeze({ label: "Daily bookkeeping", profile: "guided" as const, enableLightyear: false }),
  Object.freeze({ label: "Daily bookkeeping plus sales invoices", profile: "guided-sales" as const, enableLightyear: false }),
  Object.freeze({ label: "Bookkeeping plus investments", profile: "standard" as const, enableLightyear: true }),
  Object.freeze({ label: "Full advanced toolset", profile: "full" as const, enableLightyear: true }),
]);
const GUIDED = new Set(GUIDED_TOOL_NAMES);
const GUIDED_SALES = new Set([...GUIDED_TOOL_NAMES, "list_sale_invoices", "get_sale_invoice"]);
// Workflow-infra tools that ship in the `full` surface only for this release.
// get_workflow_page pages non-plan workflow state; guided/guided-sales adopt it
// in a later task when the interim granular tools drop and free room under the
// 20-tool cap. Registered unconditionally in server-bootstrap, but gated here so
// standard/custom/guided/guided-sales surfaces stay unchanged until then.
const FULL_ONLY_TOOL_NAMES = new Set(["get_workflow_page"]);
// process_bank_input is the guided unified bank façade. It is visible in the
// guided/guided-sales surfaces (via GUIDED above) and in the exhaustive `full`
// surface, but hidden from standard/custom, which keep the granular
// process_camt053 / import_wise_transactions entry points instead. Registered
// unconditionally in server-bootstrap; this gate keeps standard/custom at their
// pinned counts.
const GUIDED_AND_FULL_ONLY_TOOL_NAMES = new Set(["process_bank_input", "process_accounting_document"]);
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
  if (FULL_ONLY_TOOL_NAMES.has(name)) return profile === "full";
  if (GUIDED_AND_FULL_ONLY_TOOL_NAMES.has(name)) return profile === "full";
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
// Guided profiles present ONE unified bank façade. The merged process_camt053 /
// import_wise_transactions and their granular constituents all collapse to
// process_bank_input (mode defaults to prepare). The execute flag and legacy
// mode hint are dropped; file_ref/file_path/dimension/fee/date args carry over —
// all valid process_bank_input inputs. Standard/full are untouched.
const BANK_FACADE_SOURCE_TOOLS = new Set([
  "process_camt053", "parse_camt053", "import_camt053", "import_wise_transactions",
]);
export function remapGuidedBankFacade(
  tool: string,
  args: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | undefined {
  if (!BANK_FACADE_SOURCE_TOOLS.has(tool)) return undefined;
  const { execute: _execute, mode: _mode, ...rest } = args;
  return { tool: "process_bank_input", args: rest };
}

export function projectActionForProfile(action: Action, profile: ToolProfile): any {
  if (profile !== "guided" && profile !== "guided-sales") return action;
  const args = action.args ?? {};
  const remapped = remapHiddenGranularTool(action.tool, args);
  const granularProjected = remapped ? { ...action, tool: remapped.tool, args: remapped.args } : action;
  const bankRemap = remapGuidedBankFacade(granularProjected.tool, granularProjected.args ?? {});
  const projected = bankRemap ? { ...granularProjected, tool: bankRemap.tool, args: bankRemap.args } : granularProjected;
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
