import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { TOOL_CATALOG, TOOL_CATALOG_FINGERPRINT } from "./tool-catalog.js";
import { GUIDED_TOOL_NAMES, isToolVisibleForProfile, parseToolProfile, projectActionForProfile, SETUP_PROFILE_CHOICES } from "./tool-profile.js";

describe("tool profiles", () => {
  it("defaults to standard, validates opt-in profiles, and lets legacy flags force custom", () => {
    expect(parseToolProfile({} as NodeJS.ProcessEnv)).toBe("standard");
    expect(parseToolProfile({ EARVELDAJA_PROFILE: "guided-sales" } as NodeJS.ProcessEnv)).toBe("guided-sales");
    expect(parseToolProfile({ EARVELDAJA_PROFILE: "full", EARVELDAJA_DISABLE_SALES: "0" } as NodeJS.ProcessEnv)).toBe("custom");
    expect(() => parseToolProfile({ EARVELDAJA_PROFILE: "guided-investments" } as NodeJS.ProcessEnv)).toThrow("Invalid EARVELDAJA_PROFILE");
  });

  it("pins the one-choice setup mapping without inventing guided-investments", () => {
    expect(SETUP_PROFILE_CHOICES).toEqual([
      { label: "Daily bookkeeping", profile: "guided", enableLightyear: false },
      { label: "Daily bookkeeping plus sales invoices", profile: "guided-sales", enableLightyear: false },
      { label: "Bookkeeping plus investments", profile: "standard", enableLightyear: true },
      { label: "Full advanced toolset", profile: "full", enableLightyear: true },
    ]);
  });
  it("pins the opt-in guided inventories", () => {
    expect([...GUIDED_TOOL_NAMES]).toEqual([
      "recommend_workflow", "accounting_inbox", "continue_accounting_workflow", "receipt_batch",
      "process_bank_input", "reconcile_bank_transactions",
      "reconcile_inter_account_transfers", "classify_bank_transactions", "cleanup_camt_possible_duplicate",
      "save_auto_booking_rule", "compute_trial_balance", "list_connections", "switch_connection",
      "get_setup_instructions", "get_execution_plan_page", "get_operation_result_page", "get_session_log",
    ]);
    const guided = TOOL_CATALOG.filter((entry) => isToolVisibleForProfile(entry.name, "guided"));
    const guidedSales = TOOL_CATALOG.filter((entry) => isToolVisibleForProfile(entry.name, "guided-sales"));
    expect(guided).toHaveLength(17);
    expect(guidedSales.map(({ name }) => name).filter((name) => !GUIDED_TOOL_NAMES.includes(name))).toEqual([
      "list_sale_invoices", "get_sale_invoice",
    ]);
  });

  it("has a unique, stable, reference-complete catalog", () => {
    expect(TOOL_CATALOG_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(TOOL_CATALOG.map(({ name }) => name)).size).toBe(TOOL_CATALOG.length);
    const names = new Set(TOOL_CATALOG.map(({ name }) => name));
    for (const entry of TOOL_CATALOG) {
      for (const target of entry.facade_for ?? []) expect(names.has(target)).toBe(true);
      if (entry.granular_of) expect(names.has(entry.granular_of.tool)).toBe(true);
    }
  });

  it("keeps full equal to the exhaustive catalog", () => {
    expect(TOOL_CATALOG.filter(entry => isToolVisibleForProfile(entry.name, "full"))).toEqual(TOOL_CATALOG);
  });

  it("equals the complete PR0 full surface and matches destructive annotations", async () => {
    const snapshot = JSON.parse(await readFile(new URL("../testdata/tool-surface/full.json", import.meta.url), "utf8"));
    const tools = snapshot.tools as Array<{ name: string; annotations?: { destructiveHint?: boolean } }>;
    expect(new Set(TOOL_CATALOG.map(({ name }) => name))).toEqual(new Set(tools.map(({ name }) => name)));
    for (const tool of tools) {
      const meta = TOOL_CATALOG.find(({ name }) => name === tool.name)!;
      expect(meta.risk === "destructive" || meta.risk === "send").toBe(tool.annotations?.destructiveHint === true);
    }
  });

  it("fails closed when a guided action is advanced or unknown", () => {
    for (const tool of ["create_owner_expense_reimbursement", "create_journal", "delete_transaction", "future_unknown_tool"]) {
      const projected = projectActionForProfile({ tool, args: { amount: 12 }, approval_required: true }, "guided");
      expect(projected.status).toBe("needs_review");
      expect(projected.blocker.code).toBe("advanced_action_unavailable_in_profile");
      expect(projected.next_actions).toEqual([{ tool: "get_setup_instructions", args: {}, approval_required: false }]);
      expect(projected.proposal).toEqual({ tool, args: { amount: 12 }, approval_required: true });
    }
  });

  it("preserves complete action metadata in a blocked proposal", () => {
    const action = {
      kind: "tool_call",
      label: "Create the reviewed journal",
      why: "The receipt needs a manual adjustment.",
      approval_required: true,
      tool: "create_journal",
      args: { amount: 12 },
      source: "accounting_inbox",
    };
    const projected = projectActionForProfile(action, "guided");
    expect(projected.proposal).toEqual(action);
    expect(projected.next_actions).toEqual([{ tool: "get_setup_instructions", args: {}, approval_required: false }]);
  });

  it("keeps standard/full actions and remaps safe guided granular aliases", () => {
    expect(projectActionForProfile({ tool: "create_journal", args: {} }, "standard")).toMatchObject({ tool: "create_journal" });
    expect(projectActionForProfile({ tool: "create_journal", args: {} }, "full")).toMatchObject({ tool: "create_journal" });
    expect(projectActionForProfile({ tool: "parse_camt053", args: { file_ref: "x" } }, "guided")).toMatchObject({
      tool: "process_bank_input", args: { file_ref: "x" },
    });
    expect(projectActionForProfile({ tool: "import_wise_transactions", args: { file_ref: "x", execute: false } }, "guided")).toMatchObject({
      tool: "process_bank_input", args: { file_ref: "x" },
    });
  });
});
