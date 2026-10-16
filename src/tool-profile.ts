import type { ToolExposureConfig } from "./config.js";
import { TOOL_CATALOG, toolMeta, type GranularOf } from "./tool-catalog.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type ToolProfile = "guided" | "guided-sales" | "standard" | "full" | "custom";
export const GUIDED_TOOL_NAMES = Object.freeze(`recommend_workflow accounting_inbox continue_accounting_workflow receipt_batch process_accounting_document process_bank_input reconcile_bank_transactions classify_bank_transactions cleanup_camt_possible_duplicate save_auto_booking_rule run_accounting_report search_accounting_records inspect_accounting_record list_connections switch_connection get_setup_instructions get_execution_plan_page get_operation_result_page get_session_log`.split(" "));
export const SETUP_PROFILE_CHOICES = Object.freeze([
  Object.freeze({ label: "Daily bookkeeping", profile: "guided" as const, enableLightyear: false }),
  Object.freeze({ label: "Daily bookkeeping plus sales invoices", profile: "guided-sales" as const, enableLightyear: false }),
  Object.freeze({ label: "Bookkeeping plus investments", profile: "standard" as const, enableLightyear: true }),
  Object.freeze({ label: "Full advanced toolset", profile: "full" as const, enableLightyear: true }),
]);
const GUIDED = new Set(GUIDED_TOOL_NAMES);
const GUIDED_SALES = new Set([...GUIDED_TOOL_NAMES, "manage_sale_invoice"]);
// Workflow-infra tools that ship in the `full` surface only for this release.
// get_workflow_page pages non-plan workflow state. Task 14 folded
// reconcile_inter_account_transfers (→ reconcile_bank_transactions inter-account
// modes) and compute_trial_balance (→ run_accounting_report) out of the guided
// surface; cleanup_camt_possible_duplicate and save_auto_booking_rule were NOT
// folded and remain standalone guided tools (see GUIDED_TOOL_NAMES above).
// get_workflow_page adoption stays
// DEFERRED: no guided-reachable workflow action emits it as a next_action — the
// workflow_action_v2 page reference is designed to stay latent (available:false)
// when it is not visible, so guided never fails closed on it. Keeping it
// full-only preserves the minimal, plan-faithful delta and the 20-tool headroom.
const FULL_ONLY_TOOL_NAMES = new Set(["get_workflow_page"]);
// process_bank_input is the guided unified bank façade. It is visible in the
// guided/guided-sales surfaces (via GUIDED above) and in the exhaustive `full`
// surface, but hidden from standard/custom, which keep the granular
// process_camt053 / import_wise_transactions entry points instead. Registered
// unconditionally in server-bootstrap; this gate keeps standard/custom at their
// pinned counts.
const GUIDED_AND_FULL_ONLY_TOOL_NAMES = new Set([
  "process_bank_input", "process_accounting_document",
  // Task 14 typed-op façades: visible in guided (report/search/inspect) or
  // guided-sales (manage_sale_invoice) via the GUIDED/GUIDED_SALES sets checked
  // first, and in the exhaustive `full` surface, but hidden from standard/custom,
  // which keep the granular compute_*/list_*/get_*/sale-invoice CRUD entry points.
  "run_accounting_report", "search_accounting_records", "inspect_accounting_record", "manage_sale_invoice",
]);
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
function mergedToolArgs(mode: string, args: Record<string, unknown>, key: "mode" | "action" = "mode"): Record<string, unknown> {
  const { execute: _execute, execution_mode: _executionMode, ...rest } = args;
  return { [key]: mode, ...rest };
}
const GRANULAR_BY_NAME: ReadonlyMap<string, GranularOf> = new Map(
  TOOL_CATALOG.flatMap((entry) => entry.granular_of ? [[entry.name, entry.granular_of] as const] : []),
);
function granularSelectorValue(granular: GranularOf, args: Record<string, unknown>): string {
  if (granular.mode !== undefined) return granular.mode;
  const { flag, values, default: fallback } = granular.by_flag!;
  // Only a real boolean `execute: true` / a string execution_mode selects a
  // non-default branch; `execute: "true"` stays the dry run, as before.
  const raw = args[flag];
  const key = flag === "execute"
    ? (raw === true ? "true" : undefined)
    : (typeof raw === "string" ? raw : undefined);
  return (key !== undefined && Object.hasOwn(values, key) ? values[key] : undefined) ?? fallback;
}
/** Maps a hidden granular tool call onto its merged entry point (catalog `granular_of`). */
export function remapHiddenGranularTool(tool: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } | undefined {
  const granular = GRANULAR_BY_NAME.get(tool);
  if (!granular) return undefined;
  return { tool: granular.tool, args: mergedToolArgs(granularSelectorValue(granular, args), args, granular.selector) };
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
  // process_bank_input has no deprecated fee_account_relation_id alias. Fold it
  // in only when it agrees; a conflicting pair stays as is, so the strict input
  // check refuses the call instead of picking one (as the Wise import would).
  const legacyFeeDimension = rest.fee_account_relation_id;
  if (legacyFeeDimension !== undefined
    && (rest.fee_account_dimensions_id === undefined || rest.fee_account_dimensions_id === legacyFeeDimension)) {
    delete rest.fee_account_relation_id;
    rest.fee_account_dimensions_id = legacyFeeDimension;
  }
  return { tool: "process_bank_input", args: rest };
}

/** True when a remapped process_bank_input action still carries a fee alias that conflicts with fee_account_dimensions_id. */
function hasConflictingWiseFeeAlias(tool: string, args: Record<string, unknown>): boolean {
  return tool === "process_bank_input" && args.fee_account_relation_id !== undefined;
}

// Task 14 (guided-only): the standalone reconcile_inter_account_transfers left
// the guided surface; a guided workflow action that names it projects to the
// merged reconcile_bank_transactions inter-account modes (Step 5a) so it stays a
// visible, executable next action instead of failing closed. Applied ONLY in the
// guided projection below — standard/full keep the standalone tool untouched.
export function remapGuidedInterAccount(
  tool: string,
  args: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | undefined {
  if (tool !== "reconcile_inter_account_transfers") return undefined;
  return { tool: "reconcile_bank_transactions", args: mergedToolArgs(args.execute === true ? "execute_inter_account" : "inter_account_dry_run", args) };
}

/**
 * True for the blocker projectActionForProfile emits when a tool is not on the
 * profile's surface — the one blocker whose remedy is switching profile. Any
 * other blocker (e.g. wise_fee_dimension_conflict) needs the owner's answer.
 */
export function isProfileUnavailableBlocker(blocker: unknown): boolean {
  return typeof blocker === "object" && blocker !== null
    && (blocker as { code?: unknown }).code === "advanced_action_unavailable_in_profile";
}

/** The guided profiles (guided, guided-sales): the façade surface. */
export function isGuidedProfile(profile: ToolProfile): boolean {
  return profile === "guided" || profile === "guided-sales";
}

export function projectActionForProfile(action: Action, profile: ToolProfile): any {
  if (!isGuidedProfile(profile)) return action;
  const args = action.args ?? {};
  const remapped = remapHiddenGranularTool(action.tool, args);
  const granularProjected = remapped ? { ...action, tool: remapped.tool, args: remapped.args } : action;
  const bankRemap = remapGuidedBankFacade(granularProjected.tool, granularProjected.args ?? {});
  const bankProjected = bankRemap ? { ...granularProjected, tool: bankRemap.tool, args: bankRemap.args } : granularProjected;
  const interAccountRemap = remapGuidedInterAccount(bankProjected.tool, bankProjected.args ?? {});
  const projected = interAccountRemap ? { ...bankProjected, tool: interAccountRemap.tool, args: interAccountRemap.args } : bankProjected;
  if (hasConflictingWiseFeeAlias(projected.tool, projected.args ?? {})) {
    // Never pick one of two different fee dimensions; the Wise import refuses
    // the pair too. Surface the conflict instead of an action that cannot run.
    return {
      status: "needs_review",
      blocker: {
        code: "wise_fee_dimension_conflict",
        message: "This Wise import action names two different fee sub-accounts (fee_account_dimensions_id and the older fee_account_relation_id). Ask the owner which one is the Wise fee account, then prepare the import again with only fee_account_dimensions_id.",
      },
      proposal: { ...action, args },
      next_actions: [],
    };
  }
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
